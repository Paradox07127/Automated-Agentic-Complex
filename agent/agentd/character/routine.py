"""Her own day: which sustained activity she takes up next and for how long.

Each activity is played with requests agentd already sends: one of Spatial's random-tick behaviors (sit and its
variant, short_walk, observe, hold_window_edge, climb_window_top, idle) and, for some, an activity Behavior shows
(relax, guard). Spatial asks for the next one when the last has run its time; the draw weighs need × hour × how well it
fits what the user does, less a penalty for what she did lately, and nothing she did within NO_REPEAT comes again."""
from collections import deque, namedtuple
import math
import random
import threading
import time

from character.character_state import energy_target

# kind: Spatial's random-tick type; variant: the sit variant; activity: the activity Behavior shows meanwhile,
# None for its own; duration: (least, most) seconds; cooldown: seconds after it ended before it may come again.
Act = namedtuple("Act", "kind variant activity duration cooldown sitting")
NO_REPEAT = 1200.0
RECENT = 6  # activities she remembers for the repeat penalty
REPEAT_PENALTY = 0.15  # score taken off for each time an activity is among the recent ones
ACTS = {"tea": Act("sit", "tea", None, (180.0, 480.0), NO_REPEAT, True),
        "read": Act("sit", "read", None, (180.0, 420.0), NO_REPEAT, True),
        "quiet_sit": Act("sit", "still", None, (90.0, 240.0), NO_REPEAT, True),
        "window_top": Act("climb_window_top", None, None, (90.0, 240.0), NO_REPEAT, True),
        "stretch": Act("idle", None, "relax", (90.0, 240.0), NO_REPEAT, False),
        "music": Act("idle", None, "relax", (180.0, 420.0), NO_REPEAT, False),
        "walk": Act("short_walk", None, None, (30.0, 120.0), NO_REPEAT, False),
        "observe": Act("observe", None, None, (90.0, 240.0), NO_REPEAT, False),
        "window_edge": Act("hold_window_edge", None, None, (90.0, 240.0), NO_REPEAT, False),
        "guard": Act("idle", None, "guard", (30.0, 90.0), 2700.0, False)}
FILLER = "idle"  # she just stands about: always on offer at FILLER_SCORE, no cooldown, never remembered
FILLER_ACT = Act("idle", None, None, (60.0, 150.0), 0.0, False)
FILLER_SCORE = 0.2
SIT_TARGET = 0.45  # share of her time she sits
SHARE_TAU = 1800.0  # seconds over which the sitting share is averaged
SHARE_GAIN = 6.0  # how hard a share off SIT_TARGET pushes the sitting activities' scores
BASE = 0.3
# need -> change per minute: boredom always grows, comfort grows seated and falls standing, social grows with the user there
BOREDOM_RATE, COMFORT_SEATED, COMFORT_STANDING, SOCIAL_RATE = 0.02, 0.05, -0.03, 0.015
# activity -> {need: weight}; unrest is 1 - comfort, tired is 1 - energy
DRIVES = {"tea": {"unrest": 0.6, "tired": 0.4, "boredom": 0.2}, "read": {"boredom": 0.6, "unrest": 0.3},
          "quiet_sit": {"unrest": 0.6, "tired": 0.6}, "window_top": {"boredom": 0.7, "energy": 0.3},
          "stretch": {"comfort": 0.8, "energy": 0.2}, "music": {"boredom": 0.4, "energy": 0.3},
          "walk": {"comfort": 0.6, "boredom": 0.4, "energy": 0.3}, "observe": {"social": 1.0},
          "window_edge": {"social": 0.5, "boredom": 0.4}, "guard": {"energy": 0.2}}
NOVELTY = {"tea": 0.15, "read": 0.3, "quiet_sit": 0.1, "window_top": 0.35, "stretch": 0.15, "music": 0.25,
           "walk": 0.3, "observe": 0.15, "window_edge": 0.2, "guard": 0.3}  # boredom taken away as it starts
SOCIAL = {"observe": 0.5, "window_edge": 0.3, "walk": 0.2, "guard": 0.1}  # social need it meets as it starts
NIGHT = {"quiet_sit": 2.0, "tea": 1.3, "read": 1.3, "walk": 0.3, "window_top": 0.3, "window_edge": 0.5,
         "stretch": 0.6, "guard": 0.0}
MORNING = {"tea": 0.5, "walk": 1.3, "stretch": 1.4, "observe": 1.2}  # 7-12
NOON = {"quiet_sit": 1.3, "tea": 1.2}  # 12-14
AFTERNOON = {"tea": 3.0, "read": 1.2}  # 14-17
EVENING = {"read": 1.5, "music": 1.3, "tea": 1.2, "guard": 0.6}  # 19-23
# the user's ActivityContext activity -> how well each activity fits it
MATCH = {"reading": {"read": 2.0, "quiet_sit": 1.3, "observe": 1.2},
         "watching_video": {"tea": 2.0, "music": 1.5, "walk": 0.7},
         "editing_code": {"quiet_sit": 1.5, "observe": 1.3, "read": 1.2},
         "comparing_sources": {"read": 1.5, "observe": 1.3}, "build_failed": {"observe": 1.8, "guard": 1.5},
         "waiting_approval": {"observe": 1.5}, "gaming": {"guard": 3.0, "observe": 1.3},
         "typing": {"observe": 1.3, "quiet_sit": 1.2},
         "away": {"walk": 1.5, "window_top": 1.5, "read": 1.3, "tea": 1.3, "observe": 0.2}}
WORKING = {"quiet_sit": 1.4, "read": 1.2, "observe": 1.2, "guard": 1.3}  # one of her sessions is at work
GUARD_WEIGHT = 0.5  # guard is a now-and-then thing: about once an hour with its cooldown
TREAT_FOR = 900.0  # seconds a celebration's tea break stays on offer


def _clamp(value):
    return max(0.0, min(1.0, value))


def _hour_factor(name, hour):
    if hour >= 23 or hour < 7:
        return NIGHT.get(name, 1.0)
    table = MORNING if hour < 12 else NOON if hour < 14 else AFTERNOON if hour < 17 else EVENING if hour >= 19 else {}
    return table.get(name, 1.0)


class Routine:
    def __init__(self, state=None, rng=None):
        """state: her CharacterState (or StateView) for energy and the card's weights; None reads energy off the clock.
        Every call takes the caller's clock time."""
        self.state, self.rng = state, rng or random.Random()
        self.needs = {"boredom": 0.3, "comfort": 0.6, "social": 0.3}
        self.share = SIT_TARGET  # her recent sitting share
        self.plan = None  # {name, act, since, until} of what she does now
        self._recent = deque(maxlen=RECENT)
        self._ended = {}  # activity -> clock time it last ended
        self._facts = {"presence": "active", "category": None}  # from Behavior's situation
        self._at = None
        self._seated = False  # the last activity she took up was a seated one
        self._treat = None  # clock time a celebration offered a tea break
        self._lock = threading.Lock()

    def see(self, **facts):
        """presence and category from Behavior's situation."""
        with self._lock:
            self._facts.update(facts)

    def advance(self, now, sitting):
        """Time passes; sitting: whether she sits now (any seated behavior runs)."""
        with self._lock:
            if self._at is not None and now > self._at:
                dt = min(now - self._at, 7200.0)
                minutes, keep = dt / 60, math.exp(-dt / SHARE_TAU)
                needs = self.needs
                needs["boredom"] = _clamp(needs["boredom"] + BOREDOM_RATE * minutes)
                needs["comfort"] = _clamp(needs["comfort"] + (COMFORT_SEATED if sitting else COMFORT_STANDING) * minutes)
                if self._facts["presence"] != "afk":
                    needs["social"] = _clamp(needs["social"] + SOCIAL_RATE * minutes)
                self.share = self.share * keep + (1.0 - keep) * float(sitting)
            self._at = now if self._at is None else max(self._at, now)

    def recent(self):
        with self._lock:
            return list(self._recent)

    def doing(self, now):
        """The name of the activity she does now, or None."""
        with self._lock:
            plan = self.plan
            return plan["name"] if plan is not None and now < plan["until"] else None

    def end(self, now, name=None):
        """The current activity is over (its time ran out or its behavior ended); name: only if it is that one."""
        with self._lock:
            if self.plan is not None and (name is None or self.plan["name"] == name):
                self._close(now)

    def yield_guard(self, now):
        """The user needs her: a guard ends at once."""
        self.end(now, "guard")

    def after_celebration(self, now):
        with self._lock:
            self._treat = now

    def choose(self, now, kinds, context):
        """Starts and returns (name, Act, seconds) of her next activity, or None when nothing can start.
        kinds: the Spatial types free now; context: {activity: the user's ActivityContext activity, working: one of her
        sessions is at work}."""
        with self._lock:
            if self.plan is not None:
                self._close(min(now, self.plan["until"]))
            scores = self._scores(now, kinds, context)
            treat = self._treat is not None and now - self._treat <= TREAT_FOR
            if FILLER_ACT.kind in kinds:
                scores[FILLER] = FILLER_SCORE
            if treat and "tea" in scores:
                name = "tea"
            elif scores:
                name = self._draw(scores)
            else:
                return None
            if name == "tea":
                self._treat = None
            act = ACTS.get(name, FILLER_ACT)
            seconds = self.rng.uniform(*act.duration)
            self._start(name, act, now, seconds)
            return name, act, seconds

    def _start(self, name, act, now, seconds):
        self.plan = {"name": name, "act": act, "since": now, "until": now + seconds}
        self._seated = act.sitting
        if name in ACTS:
            self._recent.append(name)
            self.needs["boredom"] = _clamp(self.needs["boredom"] - NOVELTY[name])
            self.needs["social"] = _clamp(self.needs["social"] - SOCIAL.get(name, 0.0))

    def _close(self, now):
        if self.plan["name"] in ACTS:
            self._ended[self.plan["name"]] = now
        self.plan = None

    def _energy(self, now):
        if self.state is not None:
            return self.state.snapshot()["energy"]
        return energy_target(time.localtime(now).tm_hour)

    def _may(self, name, act, now, context):
        ended = self._ended.get(name)
        if ended is not None and now - ended < max(NO_REPEAT, act.cooldown):
            return False
        if name == "music":
            return self._facts["category"] == "media" or context.get("activity") == "watching_video"
        if name == "guard":  # the user is there and she stands
            return self._facts["presence"] == "active" and context.get("activity") != "away" and not self._seated
        return True

    def _scores(self, now, kinds, context):
        hour = time.localtime(now).tm_hour
        energy = self._energy(now)
        values = {**self.needs, "unrest": 1.0 - self.needs["comfort"], "energy": energy, "tired": 1.0 - energy}
        match = MATCH.get(context.get("activity"), {})
        sit_factor = max(0.15, min(3.0, 1.0 + SHARE_GAIN * (SIT_TARGET - self.share)))
        scores = {}
        for name, act in ACTS.items():
            if act.kind not in kinds or not self._may(name, act, now, context):
                continue
            score = BASE + sum(weight * values[need] for need, weight in DRIVES[name].items())
            score *= _hour_factor(name, hour) * match.get(name, 1.0)
            if context.get("working"):
                score *= WORKING.get(name, 1.0)
            if act.sitting:
                score *= sit_factor
            if name == "guard":
                score *= GUARD_WEIGHT
            if self.state is not None:
                score *= self.state.weights([act.kind])[0]  # the card's constant for the type, and her state's
            score -= REPEAT_PENALTY * self._recent.count(name)
            if score > 0:
                scores[name] = score
        return scores

    def _draw(self, scores):
        """Drawn with uniform: the tests' scripted RNG has no choices()."""
        point = self.rng.uniform(0, sum(scores.values()))
        for name, score in scores.items():
            point -= score
            if point < 0:
                return name
        return name
