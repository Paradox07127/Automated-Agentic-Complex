"""The character's own state (energy, engagement, mood) and the card's constant activity weights, per character.

Only rules change the values, each change by an event keeps its cause, and time is the real elapsed time, caught up
after a restart. Inputs are her own behaviors and lines, session and dispatch results, and whether the user spoke or
gave feedback; never what the user said or looks at, so it takes no attention store."""
import json
import math
import threading
import time

DEFAULT_PROFILE = {"mood_baseline": 0.2, "energy_offset": 0.0, "activity_weights": {}}
ENERGY_HALF_LIFE = 45 * 60.0
VALENCE_HALF_LIFE = 20 * 60.0
WRITE_EVERY = 60.0  # least seconds between two writes of a changed state
CAUSES_KEPT = 8
# a finished behavior of hers -> energy it costs
EXERTION = {"short_walk": -0.05, "climb_window_top": -0.08}
# a running behavior or behavior-tick activity -> energy it gives back per second
RESTING = {"sit": 0.01 / 60, "idle": 0.01 / 60, "sleep": 0.1 / 600}
LINE_COST, LINES_PER_HOUR = -0.005, 10  # at most 0.05 an hour
VALENCE = {"session_done": 0.1, "dispatch_done": 0.15, "dispatch_failed": -0.1, "session_error": -0.1,
           "task_verified": 0.1, "task_failed": -0.1, "user_spoke": 0.05, "feedback_useful": 0.1}
VALENCE_STEP, VALENCE_SPAN = 0.15, 0.6  # most one change and the whole offset from the baseline may move it
SPOKE_ONCE_PER = 600.0
BLOCKED_IN_A_ROW, BLOCKED = 2, -0.05
NORMAL_END = ("done", "expired")  # any other end of a counted behavior is an interruption
ONE_SHOT = ("fidget", "react", "yawn")  # behavior-tick activities that are not sustained
ENGAGED = 0.6
ENGAGEMENT_PER_SECOND = 0.1 / 60
INTENSITY = (0.4, 0.7)
TIRED, SLEEPY, LIVELY = 0.35, 0.3, 0.7
MOOD_OFF = 0.2  # offset from the baseline that reads good / happy above it and low below it
# The label codes (snapshot "labels") a prompt words differently; the others read as they are.
LABEL_WORDS = {"sleepy": "a bit sleepy", "very_sleepy": "very sleepy", "low": "a bit low"}
DOING = {"sit": "sitting", "observe": "watching the window", "idle": "staying put", "short_walk": "walking around",
         "hold_window_edge": "holding the window edge", "climb_window_top": "sitting on the window top",
         "relax": "relaxing", "think": "thinking", "wait": "waiting", "sleep": "sleeping",
         "fly": "casting arts in midair", "guard": "standing guard"}
BECAUSE = {"session_done": "a session just finished", "dispatch_done": "a dispatched task just finished",
           "dispatch_failed": "a dispatched task did not succeed", "task_verified": "your own task just passed its check",
           "task_failed": "your own task did not pass its check", "session_error": "a session hit an error",
           "user_spoke": "{user_title} just talked to you", "feedback_useful": "{user_title} said it was useful",
           "blocked": "you could not get through twice in a row"}
DISCLAIMER = "This is your state, not {user_title}'s; do not ask anything of {user_title} because of it."


def energy_target(hour):
    """Energy the clock pulls toward at a local hour, before the card's energy_offset."""
    if 9 <= hour <= 18:
        return 0.8
    if 19 <= hour <= 22:
        return 0.6
    if 6 <= hour <= 8:
        return 0.5
    return 0.3


def _clamp(value, low, high):
    return max(low, min(high, value))


def _next_hour(t):
    lt = time.localtime(t)
    return time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, lt.tm_hour + 1, 0, 0, 0, 0, -1))


class CharacterState:
    def __init__(self, db, profiles, clock=time.time):
        """db: a connection of its own on the shared store; profiles(character_id) -> the card's state_profile or
        None."""
        self.db, self.profiles, self.clock = db, profiles, clock
        self._lock = threading.RLock()
        self.character = None
        self.retention = lambda: None  # -> seconds a character_state_log row is kept, None to keep every row

    def use(self, character_id):
        """Write the character it leaves, then load this one's row and catch up the time it was away."""
        with self._lock:
            now = self.clock()
            if self.character is not None:
                self._advance(now)
                self._write()
            card = self.profiles(character_id) or {}
            self.profile = {**DEFAULT_PROFILE, **card}
            self.character = character_id
            row = self.db.execute("SELECT energy, valence, causes, updated_at FROM character_state"
                                  " WHERE character_id = ?", (character_id,)).fetchone()
            if row is None:
                self.energy, self.valence, self.causes, self._at = self._target(now), self._baseline(), [], now
            else:
                self.energy, self.valence, self.causes, self._at = row[0], row[1], json.loads(row[2]), row[3]
            self.engagement, self.activity, self._engaged = 0.0, None, None
            self._running, self._sustained = {}, None
            self._lines, self._spoke, self._blocked = [], None, 0
            self._written, self._dirty, self._cause = None, False, None
            self._advance(now)

    def clear(self, everyone=False):
        """Delete her row (or every row), then start afresh without replacing the writers' instance."""
        with self._lock:
            character = self.character
            where, args = ("", ()) if everyone else (" WHERE character_id = ?", (character,))
            deleted = self.db.execute("DELETE FROM character_state" + where, args).rowcount
            self.db.execute("DELETE FROM character_state_log" + where, args)
            self.db.commit()
            self.character = None  # use must not write the values being cleared
            self.use(character)
            return deleted

    def on_event(self, kind, **attrs):
        """kind: behavior_sent (behavior_id, type, priority), behavior_ended (behavior_id, type, outcome),
        activity (activity: the behavior tick's), line (she voiced one), or a key of VALENCE."""
        with self._lock:
            now = self.clock()
            self._advance(now)
            if kind == "behavior_sent":
                self._running[attrs["behavior_id"]] = attrs["type"]
                if attrs["priority"] == 0:  # only a random tick's behavior counts as her own activity
                    self._engage(attrs["behavior_id"], attrs["type"])
            elif kind == "behavior_ended":
                self._running.pop(attrs["behavior_id"], None)
                outcome = attrs["outcome"]
                if attrs["behavior_id"] == self._engaged:
                    self.engagement = 0.0 if outcome in NORMAL_END else 0.2
                    self.activity = self._engaged = None
                if outcome == "done" and attrs["type"] in EXERTION:
                    self._change("energy", attrs["type"], EXERTION[attrs["type"]], now)
                self._blocked = self._blocked + 1 if outcome == "blocked" else 0
                if self._blocked == BLOCKED_IN_A_ROW:
                    self._blocked = 0
                    self._change("valence", "blocked", BLOCKED, now)
            elif kind == "activity":
                activity = attrs["activity"]
                if activity not in ONE_SHOT and activity != self._sustained:
                    self._sustained = activity
                    self._engage(("activity", activity), activity)
            elif kind == "line":
                self._lines = [t for t in self._lines if now - t < 3600]
                if len(self._lines) < LINES_PER_HOUR:
                    self._lines.append(now)
                    self._change("energy", "line", LINE_COST, now)
            elif kind != "user_spoke" or self._spoke is None or now - self._spoke >= SPOKE_ONCE_PER:
                if kind == "user_spoke":
                    self._spoke = now
                self._change("valence", kind, VALENCE[kind], now)
            self._maybe_write(now)

    def advance(self, now):
        with self._lock:
            self._advance(now)
            self._maybe_write(now)

    def flush(self):
        """Write now, whatever the 60 s limit; on exit."""
        with self._lock:
            self._advance(self.clock())
            self._write()

    def snapshot(self):
        with self._lock:
            return {"character_id": self.character, "energy": self.energy, "valence": self.valence,
                    "engagement": self.engagement, "activity": self.activity, "labels": self._labels(),
                    "causes": [dict(c) for c in self.causes]}

    def labels(self):
        with self._lock:
            return self._labels()

    def history(self, since=None, limit=1000):
        """Her logged values, oldest first: the latest `limit` rows at or after `since` (epoch seconds)."""
        with self._lock:
            rows = self.db.execute("SELECT at, energy, valence, cause FROM character_state_log"
                                   " WHERE character_id = ? AND at >= ? ORDER BY at DESC, id DESC LIMIT ?",
                                   (self.character, -math.inf if since is None else since, limit)).fetchall()
            return [{"at": at, "energy": energy, "valence": valence, "cause": cause}
                    for at, energy, valence, cause in reversed(rows)]

    def summary(self, user):
        """One sentence for the mouth, from her side; "" while nothing stands out. user: the card's user_title."""
        with self._lock:
            parts = []
            if self.energy < SLEEPY:
                parts.append("a bit sleepy")
            if self.engagement >= ENGAGED and self.activity in DOING:
                parts.append(f"absorbed in {DOING[self.activity]}")
            offset = self.valence - self._baseline()
            if abs(offset) >= MOOD_OFF:
                why = next((c["cause"] for c in reversed(self.causes) if c["attr"] == "valence"), None)
                mood = "in a good mood" if offset > 0 else "in a bit of a low mood"
                parts.append(f"{mood} (because {BECAUSE[why].format(user_title=user)})" if why in BECAUSE else mood)
            return f"You yourself are now {', '.join(parts)}. {DISCLAIMER.format(user_title=user)}" if parts else ""

    def weights(self, kinds):
        """Random tick weight of each kind: the card's constant times what energy and mood make of it."""
        with self._lock:
            scale = dict.fromkeys(kinds, 1.0)
            if self.energy < TIRED:
                self._scale(scale, ("short_walk", "climb_window_top"), 0.1)
                self._scale(scale, ("idle", "sit"), 2.0)
            elif self.energy > LIVELY:
                self._scale(scale, ("short_walk", "observe"), 1.3)
            if self.valence >= 0.4:
                self._scale(scale, ("observe", "short_walk"), 1.2)
            elif self.valence <= -0.2:
                self._scale(scale, ("sit", "idle"), 1.3)
            constant = self.profile["activity_weights"]
            return [constant.get(kind, 1.0) * scale[kind] for kind in kinds]

    def tick_scale(self):
        with self._lock:
            return 1.5 if self.energy < TIRED else 1.0

    def intensity_range(self):
        with self._lock:
            return (INTENSITY[0], 0.5) if self.energy < TIRED else INTENSITY

    def walk_scale(self):
        with self._lock:
            return 2.0 if self.energy < TIRED else 0.8 if self.energy > LIVELY else 1.0

    def comment_scale(self):
        """Proactive comment cooldown factor, 1–1.5: her state only ever makes her talk less."""
        with self._lock:
            scale = (1.5 if self.energy < SLEEPY else 1.0) * (1.25 if self.engagement >= ENGAGED else 1.0)
            return min(1.5, scale)

    def mood_label(self, default):
        """The behavior tick's mood:happy well above the baseline, else default; a drift never makes her sad."""
        with self._lock:
            return "happy" if self.valence >= self._baseline() + MOOD_OFF else default

    def _labels(self):
        energy = "lively" if self.energy > LIVELY else "okay" if self.energy >= TIRED \
            else "sleepy" if self.energy >= 0.2 else "very_sleepy"
        offset = self.valence - self._baseline()
        mood = "good" if offset >= MOOD_OFF else "low" if offset <= -MOOD_OFF else "steady"
        engagement = "absorbed" if self.engagement >= ENGAGED else "some" if self.engagement > 0 else "idle"
        return {"energy": energy, "mood": mood, "engagement": engagement}

    def _baseline(self):
        return self.profile["mood_baseline"]

    def _target(self, t):
        return _clamp(energy_target(time.localtime(t).tm_hour) + self.profile["energy_offset"], 0.0, 1.0)

    @staticmethod
    def _scale(scale, kinds, factor):
        for kind in kinds:
            if kind in scale:
                scale[kind] *= factor

    def _engage(self, key, activity):
        preference = min(1.0, self.profile["activity_weights"].get(activity, 1.0) / 2)  # weight 2 or more: full
        self.engagement, self.activity, self._engaged = 0.3 + 0.4 * preference, activity, key

    def _advance(self, now):
        if now <= self._at:
            return
        before = (self.energy, self.valence)
        dt = now - self._at
        rest = max([RESTING.get(kind, 0.0) for kind in (*self._running.values(), self._sustained)])
        k = math.log(2) / ENERGY_HALF_LIFE
        t = self._at
        while t < now:  # the target changes on the hour
            end = min(now, _next_hour(t))
            target = self._target(t)
            # rest gives back what she spent, never more than the hour's target: a night of sitting stays sleepy
            below = self.energy < target
            settled = target + (rest / k if below else 0.0)
            energy = settled + (self.energy - settled) * math.exp(-k * (end - t))
            self.energy = _clamp(min(energy, target) if below else energy, 0.0, 1.0)
            t = end
        baseline = self._baseline()
        self.valence = baseline + (self.valence - baseline) * 0.5 ** (dt / VALENCE_HALF_LIFE)
        if self._engaged is not None:
            self.engagement = min(1.0, self.engagement + ENGAGEMENT_PER_SECOND * dt)
        self._at = now
        self._dirty = self._dirty or (self.energy, self.valence) != before

    def _change(self, attr, cause, delta, now):
        before = getattr(self, attr)
        if attr == "energy":
            after = _clamp(before + delta, 0.0, 1.0)
        else:
            baseline = self._baseline()
            after = _clamp(before + _clamp(delta, -VALENCE_STEP, VALENCE_STEP),
                           max(-1.0, baseline - VALENCE_SPAN), min(1.0, baseline + VALENCE_SPAN))
        if after == before:
            return
        setattr(self, attr, after)
        self.causes = (self.causes + [{"attr": attr, "cause": cause, "delta": round(after - before, 4),
                                       "at": now}])[-CAUSES_KEPT:]
        self._dirty, self._cause = True, cause

    def _maybe_write(self, now):
        if self._dirty and (self._written is None or now - self._written >= WRITE_EVERY):
            self._write()

    def _write(self):
        self.db.execute("INSERT INTO character_state (character_id, energy, valence, causes, updated_at)"
                        " VALUES (?, ?, ?, ?, ?) ON CONFLICT(character_id) DO UPDATE SET energy = excluded.energy,"
                        " valence = excluded.valence, causes = excluded.causes, updated_at = excluded.updated_at",
                        (self.character, self.energy, self.valence, json.dumps(self.causes), self._at))
        if self._dirty:
            self.db.execute("INSERT INTO character_state_log (character_id, at, energy, valence, cause)"
                            " VALUES (?, ?, ?, ?, ?)", (self.character, self._at, self.energy, self.valence, self._cause))
            keep = self.retention()
            if keep is not None:
                self.db.execute("DELETE FROM character_state_log WHERE at < ?", (self._at - keep,))
        self.db.commit()
        self._written, self._dirty, self._cause = self._at, False, None
