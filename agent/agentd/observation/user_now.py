"""The one place that judges the user's presence, activity and input, and the character's stage; memory only."""
from collections import deque
from copy import deepcopy
import threading
import time
from types import MappingProxyType

PRESENCE = ("asleep", "locked", "away", "present", "unknown")  # the first that holds wins
DOING = ("sharing", "meeting", "gaming", "watching", "reading", "browsing", "idle")
CONTENT_KINDS = ("game", "video", "reading", "browsing")
ABSENT = ("asleep", "locked", "away")
# (enter, leave) seconds. A move to a value earlier in PRESENCE or DOING waits that value's enter time, a move to a
# later one the current value's leave time; out of unknown nothing waits.
HOLD = {"default": (3, 5), "sharing": (0, 0), "meeting": (0, 0), "locked": (0, 0), "asleep": (0, 0),
        "focused": (600, 60)}
AWAY_AFTER = 180.0  # HID idle seconds
GAP = 5.0  # beats further apart than this leave presence unknown, unless a lock or sleep edge came first
GPU_BUSY, GPU_MIN, GPU_BEATS = 0.5, 3, 5  # gaming: fullscreen and front_gpu >= GPU_BUSY in GPU_MIN of GPU_BEATS beats
# Typing with key counts: TYPING_KEYS keys in 10 s with the keyboard idle at most TYPING_IDLE start it; the keyboard
# idle TYPING_REST seconds ends it. input_active is HID idle at most TYPING_IDLE.
TYPING_KEYS, TYPING_IDLE, TYPING_REST = 8, 2.0, 5.0
SUSTAINED = 60.0  # without key counts, input_active after this long present stands in for typing
FOCUS_SWITCHES = 1  # focused: fewer app switches than this in switches_60s
ENGAGED = 60.0  # seconds a return, a talk or a tap keeps her engaged
LATE_NIGHT = (23, 6)  # local hours [from, to): the night band of character.character_state.energy_target
EVENTS_KEPT = 20
TICK = 1.0
KEEP = object()


def typing(snapshot):
    """Whether the user types: typing, or input_active while there are no key counts (typing null)."""
    return snapshot["input_active"] if snapshot["typing"] is None else snapshot["typing"]


def _freeze(state):
    return MappingProxyType({k: MappingProxyType(dict(v)) if isinstance(v, dict) else v for k, v in state.items()})


class UserNow:
    def __init__(self, clock=time.time):
        self.clock = clock
        self._lock = threading.Lock()
        self._subscribers = []
        self._events = deque(maxlen=EVENTS_KEPT)
        self._boot = int(clock() * 1000)  # absence ids stay unique across restarts
        self._absences = 0
        self._beat = None  # the last accepted coarse beat
        self._locked = self._asleep = False
        self._lock_edge = self._sleep_edge = False  # that edge came and still stands
        self._gpu = deque(maxlen=GPU_BEATS)
        self._content = None  # (ts, kind) of the last content hint
        self._pending = {}  # name -> (the value it moves to, since)
        self._present_since = None
        self._typing = False
        self._sustained = False
        self._focus_doing = None
        self._returned_at = self._engaged_at = None
        self._paused_until = self._dnd_until = None
        self._meeting_manual = self._focus_timer = False
        self._state = {"revision": 0, "presence": "unknown", "doing": "idle", "input_active": False, "typing": None,
                       "flags": {"fullscreen": False, "music": False, "late_night": False, "user_speaking": False,
                                 "focused": None},
                       "overrides": {"meeting_manual": False, "dnd_until": None, "focus_timer": False},
                       "stage": "normal", "absence": None, "paused": False}
        self._snapshot = _freeze(self._state)

    def snapshot(self):
        """The state as of the last change; reading never judges."""
        return self._snapshot

    def events(self, n=20):
        """The last n events, oldest first: {revision, ts, name, data}."""
        with self._lock:
            return deepcopy(list(self._events)[-n:]) if n > 0 else []

    def subscribe(self, fn):
        """fn(event) for each event, called outside the lock."""
        with self._lock:
            self._subscribers.append(fn)

    def coarse(self, beat):
        """One validated C6 coarse beat; ignored while observation is paused."""
        with self._lock:
            if self._paused(self.clock()):
                return
            state = deepcopy(self._state)
            ts = beat["ts"]
            if self._beat is not None and ts - self._beat["ts"] > GAP:
                self._forget(state)
            self._beat = beat
            locked, asleep = beat.get("locked", self._lock_edge), beat.get("asleep", self._sleep_edge)
            edge = beat.get("edge")
            if edge in ("lock", "unlock"):  # the edge wins over the field
                locked = self._lock_edge = edge == "lock"
            elif edge in ("sleep", "wake"):
                asleep = self._sleep_edge = edge == "sleep"
            self._locked, self._asleep = locked, asleep
            self._lock_edge &= locked
            self._sleep_edge &= asleep
            self._gpu.append((beat.get("front_gpu") or 0) >= GPU_BUSY)
            events = self._judge(state, ts)
        self._notify(events)

    def content(self, ts, kind):
        """The front window's category (a CONTENT_KINDS value or None) from the content path. Manual meeting pauses
        that path as it pauses observation; coarse beats go on."""
        with self._lock:
            if self._paused(self.clock()) or self._meeting_manual:
                return
            self._content = (ts, kind)
            events = self._judge(deepcopy(self._state), ts)
        self._notify(events)

    def tick(self, now):
        """Applies what time alone changes: the beat gap, holds coming due and expiries."""
        with self._lock:
            state = deepcopy(self._state)
            if not self._paused(self.clock()) and self._beat is not None and now - self._beat["ts"] > GAP:
                self._forget(state)
            events = self._judge(state, now)
        self._notify(events)

    def run(self, stopped):
        """tick() once a second until stopped is set."""
        while not stopped.wait(TICK):
            self.tick(self.clock())

    def engage(self, kind, ts):
        """The user talked to her ("talk") or tapped her ("tap"); either engages her for ENGAGED seconds."""
        with self._lock:
            self._engaged_at = ts
            events = self._judge(deepcopy(self._state), ts)
        self._notify(events)

    def set_overrides(self, *, meeting_manual=KEEP, dnd_until=KEEP, focus_timer=KEEP):
        """The manual meeting switch, the quiet end (clock time or None) and the focus timer."""
        with self._lock:
            if meeting_manual is not KEEP:
                self._meeting_manual = meeting_manual
            if dnd_until is not KEEP:
                self._dnd_until = dnd_until
            if focus_timer is not KEEP:
                self._focus_timer = focus_timer
            events = self._judge(deepcopy(self._state), self.clock())
        self._notify(events)

    def pause(self, until):
        """The observation pause (clock time or None): beats are ignored and the observed state holds until then."""
        with self._lock:
            self._paused_until = until
            events = self._judge(deepcopy(self._state), self.clock())
        self._notify(events)

    def _paused(self, now):
        return self._paused_until is not None and now < self._paused_until

    def _notify(self, events):
        subscribers = tuple(self._subscribers)
        for event in events:
            for fn in subscribers:
                fn(deepcopy(event))

    def _forget(self, state):
        """No beat for GAP seconds: what the beats said is gone; a lock or sleep edge before the gap still holds."""
        self._beat = None
        self._gpu.clear()
        self._pending.clear()
        self._present_since, self._typing, self._sustained, self._focus_doing = None, False, False, None
        if not (state["presence"] in ("locked", "asleep") and (self._lock_edge or self._sleep_edge)):
            state["presence"] = "unknown"
        state.update(doing="idle", input_active=False, typing=None)
        state["flags"].update(fullscreen=False, music=False, user_speaking=False, focused=None)

    def _hold(self, name, current, target, ts, delay):
        """current until target has differed from it for delay seconds."""
        if target == current:
            self._pending.pop(name, None)
            return current
        if self._pending.get(name, (None,))[0] != target:
            self._pending[name] = (target, ts)
        if ts - self._pending[name][1] < delay:
            return current
        del self._pending[name]
        return target

    def _move(self, name, order, current, target, ts):
        if current == "unknown":
            delay = 0
        elif order.index(target) < order.index(current):
            delay = HOLD.get(target, HOLD["default"])[0]
        else:
            delay = HOLD.get(current, HOLD["default"])[1]
        return self._hold(name, current, target, ts, delay)

    def _judge(self, state, ts):
        if not self._paused(self.clock()):
            self._observe(state, ts)
        dnd = self._dnd_until if self._dnd_until is not None and ts < self._dnd_until else None
        state["overrides"] = {"meeting_manual": self._meeting_manual, "dnd_until": dnd, "focus_timer": self._focus_timer}
        hour = time.localtime(ts).tm_hour
        state["flags"]["late_night"] = hour >= LATE_NIGHT[0] or hour < LATE_NIGHT[1]
        state["paused"] = self._paused(self.clock())
        state["stage"] = self._stage(state, ts)
        return self._commit(state, ts)

    def _observe(self, state, ts):
        beat = self._beat
        flag = lambda key: beat is not None and beat.get(key) is True  # noqa: E731
        if beat is not None:
            idle = beat["idle_s"]
            # Watching, a call or a fullscreen game needs no keyboard or mouse; HID idle alone is not away then.
            occupied = flag("front_video") or flag("camera_active") or flag("mic_active") or \
                flag("fullscreen") and sum(self._gpu) >= GPU_MIN
            raw = "asleep" if self._asleep else "locked" if self._locked else \
                "away" if idle >= AWAY_AFTER and not occupied else "present"
            presence = state["presence"] = self._move("presence", PRESENCE, state["presence"], raw, ts)
            if presence in ABSENT and state["absence"] is None:
                self._absences += 1
                # The absence began at the last input, idle_s before the beat that showed it.
                state["absence"] = {"id": f"{self._boot}-{self._absences}", "since": beat["ts"] - idle}
            elif presence == "present" and state["absence"] is not None:
                state["absence"], self._returned_at = None, ts
            if presence != "present":
                self._present_since = None
            elif self._present_since is None:
                self._present_since = ts
            state["input_active"] = presence == "present" and idle <= TYPING_IDLE
            self._sustained = state["input_active"] and ts - self._present_since >= SUSTAINED
            counts = beat.get("input")
            if counts is None:
                self._typing, state["typing"] = False, None
            else:
                key_idle = counts.get("key_idle_s", idle)
                self._typing = state["typing"] = presence == "present" and key_idle < TYPING_REST and (
                    self._typing or counts.get("keys_10s", 0) >= TYPING_KEYS and key_idle <= TYPING_IDLE)
            state["flags"].update(fullscreen=flag("fullscreen"), user_speaking=flag("user_speaking"),
                                  music=flag("front_audio_out") and not flag("front_video"))
        kind = self._content[1] if self._content is not None and ts - self._content[0] <= GAP else None
        signals = {"sharing": flag("screen_captured"),
                   "meeting": self._meeting_manual or flag("camera_active") or flag("mic_active"),
                   "gaming": kind == "game" or flag("fullscreen") and sum(self._gpu) >= GPU_MIN,
                   "watching": flag("front_video"), "reading": kind == "reading", "browsing": kind == "browsing"}
        target = next((name for name in DOING if signals.get(name)), "idle")
        doing = state["doing"] = self._move("doing", DOING, state["doing"], target, ts)
        switches = (beat.get("input") or {}).get("switches_60s") if beat is not None else None
        if switches is None:
            self._pending.pop("focused", None)
            self._focus_doing, state["flags"]["focused"] = None, None
            return
        held = state["flags"]["focused"] is True
        if not held and doing != self._focus_doing:  # the same activity for the whole enter time
            self._focus_doing = doing
            self._pending.pop("focused", None)
        signal = state["presence"] == "present" and switches < FOCUS_SWITCHES and doing == self._focus_doing
        state["flags"]["focused"] = self._hold("focused", held, signal, ts, HOLD["focused"][0 if signal else 1])

    def _stage(self, state, ts):
        """Design table: the first row that holds wins."""
        flags, doing, overrides = state["flags"], state["doing"], state["overrides"]
        if doing == "sharing" or state["presence"] in ABSENT:
            return "offstage"
        if flags["fullscreen"] and doing in ("gaming", "watching"):
            return "offstage"
        if doing == "meeting" or overrides["meeting_manual"] or overrides["dnd_until"] is not None:
            return "quiet"
        typing = self._sustained if state["typing"] is None else state["typing"]
        if flags["focused"] or typing or doing == "watching":
            return "quiet"
        if any(at is not None and ts - at <= ENGAGED for at in (self._returned_at, self._engaged_at)):
            return "engaged"
        return "normal"  # unknown presence, and everything else

    def _commit(self, state, ts):
        before = self._state
        if state == before:
            return []
        revision = state["revision"] = before["revision"] + 1
        changes = []
        for key in ("presence", "doing"):
            if state[key] != before[key]:
                changes += [(f"user.leave.{before[key]}", {}), (f"user.enter.{state[key]}", {})]
        if before["absence"] is not None and state["absence"] is None:
            absence = before["absence"]
            changes.append(("user.return", {"absence_id": absence["id"], "away_s": ts - absence["since"]}))
        if state["stage"] != before["stage"]:
            changes.append((f"stage.{state['stage']}", {}))
        events = [{"revision": revision, "ts": ts, "name": name, "data": data} for name, data in changes]
        self._events.extend(events)
        self._state, self._snapshot = state, _freeze(state)
        return events
