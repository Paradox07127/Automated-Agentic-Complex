"""Proactive speech gate:P0 always passes; everything else must clear every rule."""
import datetime
import json
import secrets
import threading

from character.interactions import preset


class Gate:
    """Times are local naive datetimes; context flags are set by whoever observes them."""

    COMPANION = ("comment", "stuck")

    def __init__(self, enabled=False, same_cooldown=None, cross_cooldown=30.0,
                 daily_limit=20, state_scale=None, interaction_preset="balanced", db=None):
        """state_scale: None, or a callable giving her state's factor on the comment cooldown; below 1 counts as 1.
        db: a store connection the day's count and refusals (gate_day) and the muted categories (gate_mute) are kept
        in; None keeps them in memory only."""
        self.interaction = preset(interaction_preset)
        self.enabled = enabled and self.interaction.proactive_speech
        # (on, [[start hour, end hour], ...]): local hours; a range may cross midnight
        self._quiet = (False, [[22, 8]])
        self.same_cooldown = self.interaction.same_cooldown if same_cooldown is None else same_cooldown
        self.cross_cooldown = cross_cooldown
        self.daily_limit = daily_limit
        # user_now's meeting (or sharing), fullscreen, user_speaking and typing as of the latest coarse beat
        self.user_speaking = self.fullscreen = self.meeting = self.typing = False
        self.meeting_manual = False  # PUT /observation/meeting; coarse beats set only meeting
        self.stage = "normal"  # user_now's stage; offstage and quiet hold every non-P0 line
        self.focus = False  # a focus session runs: only P0 and P1 pass
        self.muted = frozenset()  # categories the user turned off; their P0 and P1 lines still pass
        self._last = {}
        self._last_any = None
        self._day, self._count = None, 0
        self._blocked = 0  # non-P0 lines refused on self._day
        self.scale = {}  # category -> factor on same_cooldown
        self.cooldown = {}  # category -> its own cooldown in seconds, in place of same_cooldown
        self.state_scale = state_scale
        self.on_decision = None  # callable(kind, attrs, key); whatever it raises is dropped
        self.db = db
        self._companion = None  # None: on with proactive speech
        self._db_lock = threading.Lock()
        self._settings_lock = threading.Lock()  # one decision reads enabled and the cooldowns of one setting
        if db is not None:
            today = datetime.date.today()
            row = db.execute("SELECT count, blocked FROM gate_day WHERE day = ?", (today.isoformat(),)).fetchone()
            if row is not None:
                self._day, (self._count, self._blocked) = today, row
            self.muted = frozenset(kind for (kind,) in db.execute("SELECT kind FROM gate_mute"))

    @property
    def companion(self):
        """The stored choice; without one, on with proactive speech."""
        with self._db_lock:
            if self.db is None:
                stored = self._companion
            else:
                row = self.db.execute("SELECT value FROM proactive_settings WHERE key = 'companion_mode'").fetchone()
                stored = None if row is None else row[0] == "true"
        return self.enabled if stored is None else stored

    def set_companion(self, on):
        with self._db_lock:
            if self.db is not None:
                with self.db:
                    self.db.execute("INSERT OR REPLACE INTO proactive_settings (key, value) VALUES ('companion_mode', ?)",
                                    ("true" if on else "false",))
            self._companion = on

    @property
    def quiet_settings(self):
        """(quiet hours on, their ranges) as stored, else off with [[22, 8]]."""
        with self._db_lock:
            if self.db is None:
                return self._quiet
            rows = dict(self.db.execute("SELECT key, value FROM proactive_settings"
                                        " WHERE key IN ('quiet_enabled', 'quiet_ranges')").fetchall())
        if len(rows) < 2:
            return self._quiet
        return rows["quiet_enabled"] == "true", json.loads(rows["quiet_ranges"])

    @property
    def quiet(self):
        """The ranges that hold lines now: the stored ones while quiet hours are on, else []."""
        on, ranges = self.quiet_settings
        return ranges if on else []

    def set_quiet(self, on, ranges):
        with self._db_lock:
            if self.db is not None:
                with self.db:
                    self.db.executemany("INSERT OR REPLACE INTO proactive_settings (key, value) VALUES (?, ?)",
                                        [("quiet_enabled", "true" if on else "false"),
                                         ("quiet_ranges", json.dumps(ranges))])
            self._quiet = (on, ranges)

    def set_interaction(self, enabled, interaction_preset):
        """Proactive speech and the interaction preset, as the constructor takes them."""
        interaction = preset(interaction_preset)
        with self._settings_lock:
            self.interaction = interaction
            self.enabled = enabled and interaction.proactive_speech
            self.same_cooldown = interaction.same_cooldown

    def set_muted(self, categories):
        """The categories whose P2 and lower lines are refused from now on, replacing the ones before."""
        muted = frozenset(categories)
        with self._db_lock:
            if self.db is not None:
                with self.db:
                    self.db.execute("DELETE FROM gate_mute")
                    self.db.executemany("INSERT INTO gate_mute (kind) VALUES (?)", [(kind,) for kind in sorted(muted)])
            self.muted = muted

    def admit(self, category, level, now=None, key=None, commit=True):
        """Return (True, None) and count it, or (False, reason) and count only the refusal (non-P0).
        key: groups this decision with the events of what it is for; None gives it its own.
        commit False: an admitted line is counted later, by commit()."""
        now = now or datetime.datetime.now()
        reason = None if level == "P0" else self._reason(category, now, level)
        if commit and level != "P0" and reason is None:
            self.commit(category, now)
        if reason is not None:
            if self._day != now.date():
                self._day, self._count, self._blocked = now.date(), 0, 0
            self._blocked += 1
            self._save()
        self.report(category, level, reason, key)
        return reason is None, reason

    def report(self, category, level, reason, key=None):
        """Records a decision on a line of category, refused for reason or (None) admitted; counts nothing."""
        if self.on_decision is not None:
            try:
                self.on_decision("gate.decided", {"kind": category, "level": level, "speak": reason is None,
                                                  "reason": reason}, key or secrets.token_hex(8))
            except Exception:  # a decision record never changes the decision
                pass

    def commit(self, category, now=None):
        """Start the cooldowns of a non-P0 line and add it to the daily count."""
        now = now or datetime.datetime.now()
        if self._day != now.date():
            self._day, self._count, self._blocked = now.date(), 0, 0
        self._last[category] = self._last_any = now
        self._count += 1
        self._save()

    def _save(self):
        """Writes self._day's row and drops the rows of days before the 7 that end on it."""
        if self.db is None:
            return
        with self._db_lock, self.db:
            self.db.execute("INSERT OR REPLACE INTO gate_day (day, count, blocked) VALUES (?, ?, ?)",
                            (self._day.isoformat(), self._count, self._blocked))
            self.db.execute("DELETE FROM gate_day WHERE day < ?",
                            ((self._day - datetime.timedelta(days=6)).isoformat(),))

    def check(self, category, now=None, level=None):
        """The reason a non-P0 admit at level would give now, or None; counts and reports nothing."""
        return self._reason(category, now or datetime.datetime.now(), level)

    def _reason(self, category, now, level=None):
        with self._settings_lock:
            return self._settled_reason(category, now, level)

    def _settled_reason(self, category, now, level):
        if not self.enabled:
            return "disabled"
        if category in self.COMPANION and not self.companion:
            return "companion_off"
        if category in self.muted and level != "P1":
            return "muted"
        if self.meeting or self.meeting_manual:
            return "meeting"
        if self.stage in ("offstage", "quiet"):
            return self.stage
        if self.focus and level != "P1":
            return "focus"
        if self.user_speaking:
            return "user_speaking"
        if self.fullscreen:
            return "fullscreen"
        if any((start <= now.hour or now.hour < end) if start > end else start <= now.hour < end
               for start, end in self.quiet):
            return "quiet_hours"
        if self._day != now.date():
            self._day, self._count, self._blocked = now.date(), 0, 0
        if self._count >= self.daily_limit:
            return "daily_limit"
        last = self._last.get(category)
        scale = self.scale.get(category, 1)
        if category == "comment" and self.state_scale is not None:
            scale *= max(1, self.state_scale())
        if last and (now - last).total_seconds() < self.cooldown.get(category, self.same_cooldown) * scale:
            return "same_cooldown"
        if self._last_any and (now - self._last_any).total_seconds() < self.cross_cooldown:
            return "cross_cooldown"
        return None
