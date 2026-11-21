"""Spatial behaviors (C1 v2 §1–3): which sustained activity the character may do now, as `event: behavior`,
from session, user and speech events and a random tick, under the behavior switches; the avatar host's receipts end them."""
from collections import OrderedDict
import json
import math
import random
import threading
import time

import c1
from character.character_state import ENGAGED
from traces.trace_store import new_trace_id
from character.interactions import preset

POLL = 1.0  # seconds between checks for an event
TICK = (60.0, 120.0)  # seconds between random ticks, uniform
FIRST_TICK = (60.0, 120.0)  # seconds from begin() to the first random tick, uniform
RENEW = 30.0  # accompany and sit are renewed this many seconds before they expire
RENEWED = ("accompany", "sit", "listen", "attend_session")
BLOCKED_FOR = 60.0  # seconds a target that got `blocked` is not chosen again
UNSUPPORTED_FOR = 1800.0  # seconds a type that got `rejected` / `unsupported` is not sent again
WANDER = (180.0, 600.0)  # seconds from a short walk sent to the earliest next random one, uniform
WALK_BIAS = {"more": 0.5, "normal": 1.0, "less": 2.0, "stay": 1.0}  # walk_bias hint -> factor on the WANDER gap
SESSION_SETTLE = 1.5  # inferred session poses wait for a stable state; direct user signals do not
SESSION_MIN_HOLD = 3.0  # seconds before another inferred pose may replace one on the same session
RECOVERY_DELAY = 3.0  # seconds after a body behavior ends before another random body attempt
FOCUS_SETTLE = 10.0  # seconds the focus stays on another window before a walk toward it may be drawn
FOCUS_WALK_P = 0.5  # chance of that walk, drawn once per focus run
FOCUS_WALK_GAP = 60.0  # seconds from the last short walk sent to a focus walk
STILL = ("typing", "meeting", "gaming", "switching")  # ActivityContext activities with no focus walk
KEPT = 64  # behaviors whose state a receipt can still find
DEFAULT_SWITCHES = {"stay_in_place": False, "sit_window_top": True, "hold_window_edge": True,
                    "fullscreen_give_way": True}
ATTEND = ("awaiting_approval", "awaiting_input", "error", "done")
ACCOMPANY = ("thinking", "running_tool", "compacting", "subagent", "background")
TICK_TYPES = ("idle", "observe", "short_walk", "sit", "hold_window_edge", "climb_window_top")
EYES = ("eyes", "head")
# random tick type -> (channels, exit); hold_window_edge also takes the hand of its side
TICKED = {"idle": (("full_body",), ("speech_start",)),
          "observe": (EYES, ("focus_change", "target_gone")),
          "short_walk": (("full_body",), ("user_typing", "user_drag")),
          "sit": (("full_body", "contact"), ("target_gone", "user_drag")),
          "hold_window_edge": (("full_body", "contact"), ("target_gone", "user_drag")),
          "climb_window_top": (("full_body", "contact"), ("user_typing", "target_gone", "user_drag"))}
# receipt phase -> what agentd records once a behavior ends with it
OUTCOMES = {"completed": "done", "cancelled": "interrupted", "rejected": "rejected", "blocked": "blocked",
            "expired": "expired"}
# ActivityContext activity -> the sit variant it weighs up; under any activity a sit may take any of SIT_WEIGHTS
SIT_VARIANTS = {"reading": "read", "watching_video": "tea", "editing_code": "still", "comparing_sources": "still",
                "build_failed": "still", "waiting_approval": "still"}
SIT_WEIGHTS = {"tea": 1.0, "read": 1.0, "still": 1.0, None: 1.0}  # None: the plain sit
SIT_MATCH = 4.0  # factor on the weight of the variant the activity weighs up
SEATED = ("sit", "climb_window_top")  # types she sits in
ROUTINE_RETRY = 15.0  # seconds before her routine tries again when nothing could start
LONG_WORK = 180.0  # seconds one session stays in ACCOMPANY before it counts as long work and she sits down with it
SIT_MIN_HOLD = 30.0  # seconds a long-work sit stays after she sat down unless the new state needs the user
NEEDS_USER = ("awaiting_approval", "awaiting_input", "error")
AWAY_REST = 600.0  # seconds the user is away before she rests: a short absence is a coffee, not the end of the day
NIGHT = (23, 7)  # local hours [from, to) in which a quiet desk is enough for her to rest
QUIET = 300.0  # seconds without key or mouse input that count as a quiet desk; any input inside it ends a rest
POSTURE = ("full_body", "contact")
REST_EXITS = ("speech_start", "session_state", "user_typing", "user_drag")
USER_SETTLE = 5.0  # seconds an ActivityContext activity holds before her body answers it
# ActivityContext activity -> (type, sit variant) answers, best first; the first the character can run is sent
USER_REACTIONS = {"reading": (("sit", "read"), ("observe", None)), "watching_video": (("sit", "tea"), ("observe", None)),
                  "editing_code": (("observe", None),), "meeting": (("idle", None),)}
# answer type -> (channels, exit, intensity, lifetime)
REACTION = {"sit": (POSTURE, ("target_gone", "user_drag"), 0.2, 300.0),
            "observe": (EYES, ("focus_change", "target_gone"), 0.3, 20.0),
            "idle": (("full_body",), ("focus_change",), 0.1, 600.0)}


def _spec(kind, target, source, event, priority, channels, exits, intensity, lifetime, display_session=None,
          turn_id=None, variant=None):
    spec = {"type": kind, "target": target, "trigger": {"source": source, "event": event},
            "display_session": display_session, "turn_id": turn_id, "priority": priority, "channels": list(channels),
            "exit": list(exits), "intensity": intensity, "lifetime": lifetime}
    if kind == "sit" and variant is not None:
        spec["variant"] = variant
    return spec


def sit_variant(activity, rng, matched=None):
    """A sit's variant drawn by SIT_WEIGHTS, the one the activity names (else matched) weighed up; drawn with uniform."""
    matched = SIT_VARIANTS.get(activity, matched)
    order = sorted(SIT_WEIGHTS, key=lambda v: v != matched)
    weights = [SIT_WEIGHTS[v] * (SIT_MATCH if v == matched else 1.0) for v in order]
    point = rng.uniform(0, sum(weights))
    for variant, weight in zip(order, weights):
        point -= weight
        if point < 0:
            return variant
    return order[-1]


def _key(spec):
    """Behaviors with the same key are one: a repeat is not sent again (C1 §1.3)."""
    return (spec["type"], json.dumps(spec["target"], sort_keys=True), spec["trigger"]["source"],
            spec["trigger"]["event"], spec["display_session"], spec["turn_id"], spec.get('facing_yaw'))


def _speech(s):
    """The user speaks or the character's voice is in flight (exit speech_start / speech_end)."""
    return s["user_speaking"] or s["voicing"]


def _unsupported_key(kind, target, variant=None):
    """`sit` without a target, `sit@window` on a window, `sit/read` as a reading sit: the avatar host may run one and reject
    the other."""
    key = kind if target is None else f"{kind}@{target['kind']}"
    return key if variant is None else f"{key}/{variant}"


def _target_key(kind, target):
    if target is None:
        return kind
    if target["kind"] == "window":
        return "window", target["window_id"]
    return json.dumps(target, sort_keys=True)


class Spatial:
    def __init__(self, observe, publish, generation, epoch, clock=time.time, rng=None, trace_id=new_trace_id,
                 walk_bias=lambda: None, state=None, session_settle=SESSION_SETTLE,
                 session_min_hold=SESSION_MIN_HOLD, recovery_delay=RECOVERY_DELAY, interaction_preset="balanced",
                 trace_epoch=lambda: None, routine=None):
        """observe() -> {fullscreen, user_speaking, speaking, voicing, line_id, typing, session, state, related,
        window_id, activity, idle_s}: the gate flags, whether the mouth generates or speaks (and its line), whether the
        relay has audio in flight, ActivityContext typing, the focus session and its state, the ActivityContext
        related_session_ids, the focus window id (or None, also when blacklisted), the ActivityContext activity
        (may be absent) and the seconds since the last key or mouse input (absent or None when unknown).
        publish(event, data) -> seq; generation() -> the current turn_generation; epoch names the behavior ids.
        state: her CharacterState, told what she does and scaling the random tick; None leaves it out.
        routine: her Routine, which then picks the random tick's behavior and how long it lasts, and long work no
        longer sits her down; None keeps the plain random tick."""
        self.observe, self.publish, self.generation, self.epoch = observe, publish, generation, epoch
        self.routine = routine
        self._plan = None  # {name, ids}: the routine activity Spatial plays and the behaviors it sent for it
        self.clock, self.rng, self.trace_id = clock, rng or random.Random(), trace_id
        self.trace_epoch = trace_epoch
        self.walk_bias = walk_bias
        self.interaction = preset(interaction_preset)
        self.session_settle, self.session_min_hold, self.recovery_delay = session_settle, session_min_hold, recovery_delay
        self._stable_session = self._pending_session = None
        self._recovery_at = 0.0
        self.state = state
        self.switches = dict(DEFAULT_SWITCHES)
        self.active = OrderedDict()  # behavior_id -> record of a behavior that still runs, oldest first
        self.records = OrderedDict()  # behavior_id -> {behavior, spec, since, phase, outcome, ended}
        self.capabilities = None  # loaded host report; None before the first one: every behavior counts as capable
        self.capability_character = None
        self.last_receipt = None
        self._count = 0
        self._event_key = None  # key of the latest event row that held
        self._next_tick = None
        self._blocked = {}  # target key -> clock time it may be chosen again
        self._unsupported = {}  # _unsupported_key the renderer does not run -> clock time it may be sent again
        self._wander_at = None  # clock time a random short_walk may be sent again; a character switch keeps it
        self._walked_at = None  # clock time the last short_walk was sent
        self._focus = None  # {window_id, since, moved}: the focus run; moved None until it stays FOCUS_SETTLE
        self._settled = None  # window id of the last focus run that stayed FOCUS_SETTLE
        self._work = None  # {session, since}: the stabilized focus session's run in ACCOMPANY
        self._away_since = None  # clock time the activity became `away`; None while it is not
        self._posture_key = None  # key of the long-work sit or rest that holds now, once sent; None when none holds
        self._activity_run = None  # {activity, since, sent, tries}: the activity's run and the last answer sent to it
        self._lock = threading.RLock()
        self._wake = threading.Event()

    def run(self, stop, skip=lambda: False):
        """skip() -> True leaves this poll out (agentd's reset or an open character switch)."""
        self.begin()
        while True:
            self._wake.wait(POLL)
            self._wake.clear()
            if stop.is_set():
                return
            if skip():
                continue
            try:
                self.poll()
            except Exception:  # a failed poll leaves the running behavior
                pass

    def wake(self):
        """run() polls now instead of at the end of its POLL wait; safe to call under any lock."""
        self._wake.set()

    def begin(self):
        """Puts the first random tick FIRST_TICK away unless one is already set."""
        with self._lock:
            if self._next_tick is None:
                self._next_tick = self.clock() + self.rng.uniform(*FIRST_TICK) * self.interaction.random_tick_scale

    def poll(self):
        s = self.observe()
        with self._lock:
            now = self.clock()
            s = self._stabilize_session(s, now)
            self._track(s, now)
            for record in list(self.active.values()):
                if record["behavior"]["expires_at_ms"] <= now * 1000:
                    self._end(record, "expired")
            give_way = s["fullscreen"] and self.switches["fullscreen_give_way"]
            event, posture = self._event(s), self._posture(s, now)
            if not give_way:
                self._renew(s, now, (event, posture))
            key = event and _key(event)
            if key != self._event_key:
                self._event_key = key
                if event is not None and not self._running(key) \
                        and self._blocked.get(_target_key(event["type"], event["target"]), 0) <= now \
                        and self._unsupported.get(_unsupported_key(event["type"], event["target"]), 0) <= now:
                    self._send(event, s, now)
            self._take_posture(posture, s, now)
            self._react(s, now, event, posture)
            self._focus_walk(s, now)
            if self.routine is not None:
                self._follow_routine(s, now, give_way or posture is not None)
            elif not give_way and (self._next_tick is None or now >= self._next_tick):
                if self.state is not None:
                    self.state.advance(now)
                scale = 1.0 if self.state is None else self.state.tick_scale()
                self._next_tick = now + self.rng.uniform(*TICK) * scale * self.interaction.random_tick_scale
                spec = None if self._engaged() else self._pick(s, now, "tick", None)
                if spec is not None:
                    self._send(spec, s, now)
            self._exit(s)

    def running(self):
        """Every behavior that runs, oldest first (C1 §0 snapshot `behaviors`); [] when none does."""
        with self._lock:
            return [dict(record["behavior"]) for record in self.active.values()]

    def facing_available(self):
        with self._lock:
            return self.capabilities is not None and 'face' in self.capabilities and self.capabilities['face'] is None

    def facing_status(self,behavior_id=None):
        with self._lock:
            record=next((r for r in reversed(list(self.records.values())) if r['behavior']['type']=='face'
                and r.get('character')==self.capability_character
                and (behavior_id is None or r['behavior']['behavior_id']==behavior_id)),None)
            if record is None:return {'available':False,'reason':'no_facing_receipt'}
            return {'available':True,'behavior_id':record['behavior']['behavior_id'],
                'requested_yaw':record['behavior']['facing_yaw'],'phase':record['ended'] or record['phase'] or 'requested',
                'execution_phase':record['phase'],'outcome':record['outcome']}

    def request_facing(self, yaw, reason, hold_seconds=60, source='agent', valid=lambda:True, *,
                       trace_id=None, trace_turn_id=None, trace_epoch=None):
        """An explicit model/tool decision, never derived here from focus duration."""
        if isinstance(yaw,bool) or not isinstance(yaw,(int,float)) or not math.isfinite(yaw) or not -180<=yaw<=180 \
                or isinstance(hold_seconds,bool) or not isinstance(hold_seconds,(int,float)) or not math.isfinite(hold_seconds) \
                or not 1<=hold_seconds<=300 or not isinstance(reason,str) or not 1<=len(reason)<=200 \
                or source not in ('agent','decision'):
            raise ValueError('invalid_facing_decision')
        s = self.observe()
        with self._lock:
            if not valid():return {'accepted':False,'reason':'decision_stale'}
            if not self.facing_available() or self._forbidden('face', None, False):
                return {'accepted':False,'reason':'facing_unavailable'}
            if s['fullscreen'] and self.switches['fullscreen_give_way']:
                return {'accepted':False,'reason':'fullscreen'}
            if any(r['behavior']['type'] not in ('face','idle','think','listen','accompany') and set(r['behavior']['channels']) & {'full_body','contact'}
                   for r in self.active.values()): return {'accepted':False,'reason':'body_busy'}
            exits = ('user_drag','focus_change') if source=='decision' else ('user_drag',)
            spec = _spec('face',None,source,'facing_decision',0,('full_body',),exits,.2,hold_seconds)
            spec.update(facing_yaw=float(yaw),decision_reason=reason)
            if trace_id:
                spec.update(trace_id=trace_id, trace_turn_id=trace_turn_id, trace_epoch=trace_epoch)
            self._send(spec,s,self.clock())
            record = next(reversed(self.active.values()))
            return {'accepted':True,'behavior_id':record['behavior']['behavior_id'],
                    'facing_yaw':float(yaw),'phase':'requested'}

    def set_capabilities(self, character, capabilities):
        """The actual loaded character's supported behaviors; values are null or an unavailable reason."""
        with self._lock:
            if self.capability_character == character and self.capabilities == capabilities:
                return dict(self.capabilities)
            self.capability_character = character
            self.capabilities = dict(capabilities)
            self._unsupported.clear()
            self._event_key = self._posture_key = None
            for record in list(self.active.values()):
                b = record["behavior"]
                if not self._capable(b["type"], b["target"]):
                    self._end(record, "switch_off")
                    self.publish("behavior_cancel", {"behavior_id": b["behavior_id"], "reason": "switch_off",
                                                     "turn_generation": self.generation()})
            return dict(self.capabilities)

    def _capable(self, kind, target, variant=None):
        if self.capabilities is None:
            return True
        key = "sit@window" if kind == "sit" and target is not None and target.get("kind") == "window" else kind
        if kind == 'attend_session' and target is not None and target.get('window_id') is None:
            key = 'attend_session@user'
        # a variant key the host does not report (`still`) counts as capable
        return self.capabilities.get(key) is None and (variant is None or self.capabilities.get(f"{key}/{variant}") is None)

    def set_switches(self, switches):
        """PUT /behavior/switches (body checked by c1.check_switches): a running behavior they now forbid gets
        `behavior_cancel` / `switch_off`. Returns the stored values."""
        with self._lock:
            self.switches = dict(switches)
            for record in list(self.active.values()):
                behavior = record["behavior"]
                if self._forbidden(behavior["type"], behavior["target"], False):
                    self._end(record, "switch_off")
                    self.publish("behavior_cancel", {"behavior_id": behavior["behavior_id"], "reason": "switch_off",
                                                     "turn_generation": self.generation()})
            return dict(self.switches)

    def cancel_all(self, reason):
        """Every running behavior gets `behavior_cancel` / reason (character switch prepare: character_switch)."""
        with self._lock:
            for record in list(self.active.values()):
                self._end(record, reason)
                self.publish("behavior_cancel", {"behavior_id": record["behavior"]["behavior_id"], "reason": reason,
                                                 "turn_generation": self.generation()})
            self._event_key = self._posture_key = None  # a row that still holds is sent again at the next poll
            self._unsupported.clear()  # the next character may run other types
            if reason == "character_switch":
                self.capabilities = None
                self.capability_character = None
            self._stable_session = self._pending_session = None

    def receipt(self, body):
        """POST /behavior/receipts (body checked by c1): (applied, why); why is None, unknown_behavior,
        after_terminal or stale."""
        s = self.observe() if body["phase"] == "blocked" else None
        with self._lock:
            record = self.records.get(body["behavior_id"])
            if record is None:
                return False, "unknown_behavior"
            if record["phase"] in c1.ENDED:
                return False, "after_terminal"
            if body["turn_generation"] != record["behavior"]["turn_generation"]:  # C1 §3: its own generation
                return False, "stale"
            now, phase = self.clock(), body["phase"]
            record["phase"] = phase
            if phase == "running":
                record.setdefault("running_at", now)
            self.last_receipt = {"behavior_id": body["behavior_id"], "phase": phase, "reason": body.get("reason"),
                                 "at": now}
            if phase in c1.ENDED:
                # only `completed` makes an arrival or a release a fact; a lost Avatar is neither done nor cut.
                record["outcome"] = "lost" if body.get("reason") == "connection_lost" else OUTCOMES[phase]
                self.active.pop(body["behavior_id"], None)
                if record["behavior"]["priority"] == 0 and set(record["behavior"]["channels"]) & {"full_body", "contact"}:
                    self._recovery_at = max(self._recovery_at, now + self.recovery_delay)
                if self.state is not None and record["state_id"] is not None:
                    self.state.on_event("behavior_ended", behavior_id=record["state_id"],
                                        type=record["behavior"]["type"], outcome=record["outcome"])
            if phase == "rejected" and body.get("reason") == "unsupported":
                behavior = record["behavior"]
                self._unsupported[_unsupported_key(behavior["type"], behavior["target"], behavior.get("variant"))] = \
                    now + UNSUPPORTED_FOR
            if body.get("reason") == "connection_lost":
                self._unsupported.clear()  # the next Avatar may run other types
            if phase == "blocked":
                behavior = record["behavior"]
                self._blocked[_target_key(behavior["type"], behavior["target"])] = now + BLOCKED_FOR
                if record.get("ended") is None and not (s["fullscreen"] and self.switches["fullscreen_give_way"]):
                    spec = self._pick(s, now, "receipt", f"blocked:{body['reason']}", behavior["type"])
                    if spec is not None:
                        self._send(spec, s, now)
            return True, None

    def receipt_trace(self, behavior_id):
        with self._lock:
            record = self.records.get(behavior_id)
            if record is not None:
                return (record["behavior"]["trace_id"], record["spec"].get("trace_turn_id"),
                        record["behavior"]["type"], record["trace_epoch"])
        return None

    def diag(self):
        """/diag/state `behavior`; times are clock seconds."""
        with self._lock:
            running = [{"behavior_id": record["behavior"]["behavior_id"], "type": record["behavior"]["type"],
                        "target": record["behavior"]["target"], "since": record["since"]}
                       for record in self.active.values()]
            now = self.clock()
            unsupported = {kind: until - now for kind, until in self._unsupported.items() if until > now}
            return {"running": running, "switches": dict(self.switches),
                    "last_receipt": self.last_receipt and dict(self.last_receipt), "unsupported": unsupported,
                    "capability_character": self.capability_character, "capabilities": self.capabilities}

    def _stabilize_session(self, s, now):
        """Coalesce hook chatter into a held pose, without delaying user speech, typing, fullscreen or stops.

        A different/finished session drops the old pose immediately. Only entering another active pose waits;
        thinking/tool/compacting/subagent are one accompany pose, not four animations.
        """
        session, state = s["session"], s["state"]
        if session is not None and session.startswith('role:'):
            # Product state is authoritative, unlike noisy external hook observations.
            self._stable_session = self._pending_session = None
            return s
        family = "accompany" if state in ACCOMPANY else "attend_session" if state in ATTEND else None
        if session is None or family is None:
            self._stable_session = self._pending_session = None
            return s
        key = (session, family)
        stable = self._stable_session
        if stable is not None and stable["key"][0] != session:
            stable = self._stable_session = None
        if stable is not None and stable["key"] == key:
            self._pending_session = None
        else:
            if self._pending_session is None or self._pending_session["key"] != key:
                self._pending_session = {"key": key, "state": state, "since": now}
            pending = self._pending_session
            if now - pending["since"] >= self.session_settle and \
                    (stable is None or now - stable["since"] >= self.session_min_hold):
                stable = self._stable_session = {"key": key, "state": pending["state"], "since": now}
                self._pending_session = None
        return {**s, "state": stable["state"] if stable is not None else "idle"}

    def _track(self, s, now):
        """How long the stabilized focus session has been at work and the user away."""
        session = s["session"] if s["state"] in ACCOMPANY else None
        if session is None:
            self._work = None
        elif self._work is None or self._work["session"] != session:
            self._work = {"session": session, "since": now}
        if s.get("activity") != "away":
            self._away_since = None
        elif self._away_since is None:
            self._away_since = now
        if self._activity_run is None or self._activity_run["activity"] != s.get("activity"):
            self._activity_run = {"activity": s.get("activity"), "since": now, "sent": None, "tries": 0}

    def _posture(self, s, now):
        """The long-work sit or the rest that holds now, or None. Both take priority 1 and the full body,
        so no random tick walks or climbs while she sits."""
        if s["fullscreen"] and self.switches["fullscreen_give_way"] or self._forbidden("sit", None, s["typing"]):
            return None
        if self.routine is None and self._work is not None and now - self._work["since"] >= LONG_WORK:
            if "variant" not in self._work:  # drawn once per run of work
                self._work["variant"] = sit_variant(s.get("activity"), self.rng, "still")
            variant = self._work["variant"]
            if self._unsupported.get(_unsupported_key("sit", None, variant), 0) > now:
                variant = None
            return _spec("sit", None, "session", f"session_state:{s['state']}", 1, POSTURE,
                         ("session_state", "user_drag"), 0.2, 600.0, display_session=self._work["session"],
                         variant=variant)
        if self._resting(s, now):
            rest = self.capabilities is not None and self.capabilities.get("sit/rest") is None \
                and self._unsupported.get(_unsupported_key("sit", None, "rest"), 0) <= now
            return _spec("sit", None, "user", "rest", 1, POSTURE, REST_EXITS, 0.1, 600.0,
                         variant="rest" if rest else None)
        return None

    def _resting(self, s, now):
        """No session at work or waiting, no speech or typing, no input for QUIET, and the user away for AWAY_REST
        or a NIGHT hour."""
        idle = s.get("idle_s")
        if s["session"] is not None and s["state"] in ACCOMPANY + ATTEND or _speech(s) or s["typing"] \
                or idle is not None and idle < QUIET:
            return False
        if self._away_since is not None and now - self._away_since >= AWAY_REST:
            return True
        hour = time.localtime(now).tm_hour
        return idle is not None and (hour >= NIGHT[0] or hour < NIGHT[1])

    def _take_posture(self, posture, s, now):
        """Sends a posture once per run of it; a long-work sit does not start while the user types or speaks."""
        key = posture and _key(posture)
        if key is None:
            self._posture_key = None
        elif key != self._posture_key and not s["typing"] and not s["user_speaking"]:
            self._posture_key = key
            if not self._running(key) and self._blocked.get(_target_key("sit", None), 0) <= now \
                    and self._unsupported.get(_unsupported_key("sit", None), 0) <= now:
                self._send(posture, s, now)

    def _react(self, s, now, event, posture):
        """Her body answers the user's activity once it held USER_SETTLE: one answer per run, the first in
        USER_REACTIONS the loaded character can run; a rejected one gives way to the next. Speech, a session that
        needs the user and a posture keep priority; an unreported host gets none."""
        run = self._activity_run
        answers = USER_REACTIONS.get(run["activity"], ())
        if self.capabilities is None or not answers or now - run["since"] < USER_SETTLE \
                or run["tries"] >= len(answers) or posture is not None \
                or event is not None and (event["type"], event["trigger"]["source"]) != ("accompany", "session"):
            return
        if run["sent"] is not None and (self.records.get(run["sent"]) or {}).get("outcome") != "rejected":
            return
        for kind, variant in answers:
            target = {"kind": "window", "window_id": s["window_id"], "side": None} if kind == "observe" else None
            channels, exits, intensity, lifetime = REACTION[kind]
            if kind == "observe" and s["window_id"] is None or kind == "sit" and s["typing"] \
                    or not self._capable(kind, target, variant) or self._forbidden(kind, target, s["typing"]) \
                    or self._blocked.get(_target_key(kind, target), 0) > now \
                    or any(self._unsupported.get(key, 0) > now for key in
                           (_unsupported_key(kind, target), _unsupported_key(kind, target, variant))) \
                    or any(set(channels) & set(r["behavior"]["channels"]) and r["behavior"]["priority"] > 0
                           and not (r["behavior"]["trigger"]["event"] or "").startswith("activity:")
                           for r in self.active.values()):
                continue
            run["tries"] += 1
            self._send(_spec(kind, target, "user", "activity:" + run["activity"], 1, channels, exits, intensity,
                             lifetime, variant=variant), s, now)
            run["sent"] = next(reversed(self.records))
            return

    def _event(self, s):
        """The highest event row that holds now, or None."""
        if s["fullscreen"] and self.switches["fullscreen_give_way"]:
            return _spec("idle", None, "session", "fullscreen", 3, ("full_body",), ("focus_change",), 0.2, 600.0)
        if s["user_speaking"]:
            return _spec("listen", {"kind": "user"}, "user", "speech_start", 2, EYES, ("speech_end",), 0.4, 120.0)
        if s['session'] is not None and s['session'].startswith('role:') and \
                s['state'] in ('awaiting_input', 'awaiting_approval'):
            # Waiting for a real answer is not "thinking", even while the old worker is unwinding.
            return _spec('listen', {'kind': 'user'}, 'agent', 'session_state:' + s['state'], 1, EYES,
                         ('session_state',), .3, 300.0, display_session=s['session'])
        if s["speaking"]:
            spec = _spec("think", None, "speech", "turn_start", 2, EYES, ("speech_start", "session_state"),
                         0.4, 120.0, turn_id=s["line_id"])
            if trace := s.get("turn_trace"):
                spec.update(zip(("trace_id", "trace_turn_id", "trace_epoch"), trace))
            return spec
        if s["typing"]:
            return _spec("accompany", None, "user", "typing", 2, EYES, ("focus_change",), 0.2, 600.0)
        session, state = s["session"], s["state"]
        if session is not None and state in ATTEND:
            target = {"kind": "session", "display_session": session,
                      "window_id": s["window_id"] if session in s["related"] else None}
            return _spec("attend_session", target, "session", f"session_state:{state}", 1, EYES, ("session_state",),
                         0.5, 300.0, display_session=session)
        if session is not None and state in ACCOMPANY:
            return _spec("accompany", None, "session", f"session_state:{state}", 1, EYES, ("session_state",), 0.2,
                         600.0, display_session=session)
        return None

    def _exit(self, s):
        """C1 §1: a running behavior whose exit condition agentd judges holds now gets behavior_cancel / exit,
        naming the first of its conditions that holds."""
        speech = _speech(s)
        for record in list(self.active.values()):
            record["heard"] = record["heard"] or speech
            record["quiet"] = record["quiet"] or not speech
            behavior = record["behavior"]
            holds = {"speech_start": record["quiet"] and speech, "speech_end": record["heard"] and not speech,
                     "session_state": (s["session"], s["state"]) != record["session"],
                     "focus_change": s["window_id"] != record["window_id"]
                     or behavior["trigger"]["event"] == "fullscreen" and not s["fullscreen"],
                     "user_typing": s["typing"]}
            if behavior["trigger"]["event"] == "turn_start":
                holds["session_state"] = not s["speaking"] or s["line_id"] != behavior["turn_id"]
            if behavior["type"] == "sit" and behavior["trigger"]["event"] == "rest":
                # user_typing stands for any input here, or the quiet that let her rest being over
                holds.update(session_state=s["session"] is not None and s["state"] in ACCOMPANY + ATTEND,
                             user_typing=not self._resting(s, self.clock()))
            elif behavior["type"] == "sit" and behavior["trigger"]["source"] == "session" and s["state"] not in NEEDS_USER \
                    and self.clock() - record.get("running_at", record["since"]) < SIT_MIN_HOLD:
                holds["session_state"] = False
            condition = next((c for c in behavior["exit"] if holds.get(c)), None)
            if condition is not None:
                self._end(record, "exit")
                self.publish("behavior_cancel", {"behavior_id": behavior["behavior_id"], "reason": "exit",
                                                 "condition": condition, "turn_generation": self.generation()})

    def _renew(self, s, now, rows):
        """rows: the event row and the posture that hold now, each may be None."""
        keys = {_key(row) for row in rows if row is not None}
        for record in list(self.active.values()):
            behavior, spec = record["behavior"], record["spec"]
            if behavior["type"] not in RENEWED or behavior["expires_at_ms"] - now * 1000 > RENEW * 1000:
                continue
            if spec["trigger"]["source"] == "tick":
                # a routine activity lasts its own time, which the behavior's lifetime already covers
                holds = self.routine is None and not self._forbidden(behavior["type"], behavior["target"], s["typing"]) \
                    and self._blocked.get(_target_key(behavior["type"], behavior["target"]), 0) <= now
            else:
                holds = _key(spec) in keys
            if holds:
                self._send(spec, s, now)  # same channels: it replaces the old one

    def _forbidden(self, kind, target, typing):
        """C1 §1.3: a type the switches or the user's typing rule out."""
        switches, on_window = self.switches, target is not None and target["kind"] == "window"
        return kind in c1.MOVING and (switches["stay_in_place"] or typing) \
            or not switches["sit_window_top"] and (kind == "climb_window_top" or kind == "sit" and on_window) \
            or not switches["hold_window_edge"] and kind == "hold_window_edge" \
            or switches.get("bust_framing", False) and kind in c1.MOVING + c1.BUST_HELD

    def _walk_bias(self):
        """The read model's hint, "normal" when it fails or names none of WALK_BIAS."""
        try:
            bias = self.walk_bias()
        except Exception:
            return "normal"
        return bias if isinstance(bias, str) and bias in WALK_BIAS else "normal"

    def _engaged(self):
        """The priority-0 behavior her state is engaged in still runs: the random tick keeps it."""
        if self.state is None:
            return False
        snapshot = self.state.snapshot()
        return snapshot["engagement"] >= ENGAGED and any(
            record["behavior"]["priority"] == 0 and record["behavior"]["type"] == snapshot["activity"]
            for record in self.active.values())

    def _free(self, s, now, kind, target):
        if not self._capable(kind, target) or self._forbidden(kind, target, s["typing"]) \
                or now < self._recovery_at and set(TICKED[kind][0]) & {"full_body", "contact"} \
                or self._blocked.get(_target_key(kind, target), 0) > now \
                or self._unsupported.get(_unsupported_key(kind, target), 0) > now \
                or kind == "short_walk" and target is None and self._wander_at is not None and now < self._wander_at \
                or kind == "short_walk" and self._walk_bias() == "stay":
            return False
        channels = set(TICKED[kind][0])
        for record in self.active.values():
            behavior = record["behavior"]
            if behavior["type"] == kind and behavior["target"] == target:
                return False
            if (behavior["priority"] > 0 or behavior['type']=='face') and channels & set(behavior["channels"]):
                return False  # the renderer would answer rejected / busy
        return True

    def _pick(self, s, now, source, event, prefer=None):
        """A random tick's behavior among the types allowed now; prefer: a type to keep when it still can be.
        Switching or meeting: none this round; reading: observe the focus window when it can be."""
        if s.get("activity") in ("switching", "meeting"):
            return None
        choices = self._choices(s, now, source)
        kinds = [kind for kind in TICK_TYPES if choices[kind]]
        if not kinds:
            return None
        if prefer in kinds:
            kind = prefer
        elif s.get("activity") == "reading" and "observe" in kinds:
            kind = "observe"
        elif self.state is None:
            kind = self.rng.choice(kinds)
        else:
            kind = self._weighted(kinds)
        target = self.rng.choice(choices[kind])
        channels, exits = TICKED[kind]
        if kind == "hold_window_edge":
            channels = ("full_body", f"{target['side']}_hand", "contact")
        lifetime = 600.0 if kind == "sit" else self.rng.uniform(60.0, 180.0)
        intensity = (0.4, 0.7) if self.state is None else self.state.intensity_range()
        variant = sit_variant(s.get("activity"), self.rng) if kind == "sit" else None
        if variant is not None and self._unsupported.get(_unsupported_key(kind, target, variant), 0) > now:
            variant = None
        return _spec(kind, target, source, event, 0, channels, exits, round(self.rng.uniform(*intensity), 2), lifetime,
                     variant=variant)

    def _choices(self, s, now, source):
        """Random-tick type -> the targets it may take now."""
        window_id = s["window_id"]
        on = lambda side=None: {"kind": "window", "window_id": window_id, "side": side}  # noqa: E731
        sit = source != "tick" or not s["typing"]  # the user types: a random tick starts no sit
        targets = {"idle": [None], "observe": [], "short_walk": [None], "sit": [None] if sit else [],
                   "hold_window_edge": [], "climb_window_top": []}
        if window_id is not None:
            targets["observe"].append(on())
            if sit:
                targets["sit"].append(on())
            targets["hold_window_edge"].append(on(self.rng.choice(("left", "right"))))
            targets["climb_window_top"].append(on())
        return {kind: [t for t in found if self._free(s, now, kind, t)] for kind, found in targets.items()}

    def _follow_routine(self, s, now, paused):
        """Plays her routine: the next activity once the last ran its time or its behavior ended; paused (fullscreen
        give-way or a posture) starts none."""
        sitting = any(r["behavior"]["type"] in SEATED for r in self.active.values())
        self.routine.advance(now, sitting)
        plan = self._plan
        if plan is not None:
            live = [self.active[i] for i in plan["ids"] if i in self.active]
            if live and self.routine.doing(now) == plan["name"]:
                return
            for record in live:  # her time for it is up or it gave way, e.g. a guard to a user who needs her
                self._end(record, "expired")
                self.publish("behavior_cancel", {"behavior_id": record["behavior"]["behavior_id"],
                                                 "reason": "expired", "turn_generation": self.generation()})
            self.routine.end(now, plan["name"])
            self._plan = None
        if paused or self._next_tick is not None and now < self._next_tick or now < self._recovery_at \
                or s.get("activity") in ("switching", "meeting"):
            return
        if self.state is not None:
            self.state.advance(now)
        choices = self._choices(s, now, "tick")
        picked = self.routine.choose(now, [kind for kind in TICK_TYPES if choices[kind]],
                                     {"activity": s.get("activity"), "working": self._work is not None})
        if picked is None:
            self._next_tick = now + ROUTINE_RETRY
            return
        name, act, seconds = picked
        target = self.rng.choice(choices[act.kind])
        channels, exits = TICKED[act.kind]
        if act.kind == "hold_window_edge":
            channels = ("full_body", f"{target['side']}_hand", "contact")
        intensity = (0.4, 0.7) if self.state is None else self.state.intensity_range()
        variant = act.variant
        if variant is not None and self._unsupported.get(_unsupported_key(act.kind, target, variant), 0) > now:
            variant = None
        count = self._count
        self._send(_spec(act.kind, target, "tick", f"routine:{name}", 0, channels, exits,
                         round(self.rng.uniform(*intensity), 2), seconds, variant=variant), s, now)
        self._next_tick = None
        self._plan = {"name": name, "ids": [f"b-{self.epoch}-{self._count}"] if self._count > count else []}

    def _weighted(self, kinds):
        """One of kinds by the state's weights, drawn with uniform: the tests' scripted RNG has no choices()."""
        weights = self.state.weights(kinds)
        point = self.rng.uniform(0, sum(weights))
        for kind, weight in zip(kinds, weights):
            point -= weight
            if point < 0:
                return kind
        return kinds[-1]

    def _focus_walk(self, s, now):
        """C1 v2.1: a focus that moved to another window and stayed FOCUS_SETTLE draws one walk toward it, at the
        first poll where it may be sent."""
        window_id = s["window_id"]
        if self._focus is None or self._focus["window_id"] != window_id:
            self._focus = {"window_id": window_id, "since": now, "moved": None}
        run = self._focus
        if window_id is None or now - run["since"] < FOCUS_SETTLE:
            return
        if run["moved"] is None:  # the first window that stays is where she starts, not a move
            run["moved"] = self._settled is not None and window_id != self._settled
            self._settled = window_id
        target = {"kind": "window", "window_id": window_id, "side": None}
        if not run["moved"] or s["fullscreen"] or s.get("activity") in STILL \
                or self._walked_at is not None and now - self._walked_at < FOCUS_WALK_GAP \
                or not self._free(s, now, "short_walk", target):
            return
        run["moved"] = False
        if self.rng.random() < self.interaction.focus_walk_probability:
            channels, exits = TICKED["short_walk"]
            self._send(_spec("short_walk", target, "user", "focus_change", 0, channels, exits,
                             round(self.rng.uniform(0.4, 0.7), 2), self.rng.uniform(60.0, 180.0)), s, now)

    def _running(self, key):
        return any(_key(record["spec"]) == key for record in self.active.values())

    def _send(self, spec, s, now):
        if not self._capable(spec["type"], spec["target"]):
            return None
        trace_epoch = spec.get("trace_epoch") or self.trace_epoch()
        self._count += 1
        behavior_id = f"b-{self.epoch}-{self._count}"
        # a behavior that ends on user_typing gives way to the next one while the user types (fixture 07).
        gone = [r for r in self.active.values() if set(r["behavior"]["channels"]) & set(spec["channels"])
                or s["typing"] and "user_typing" in r["behavior"]["exit"]]
        # replaces names one: the renewed one when this is a renewal, else the latest; each other one is cancelled.
        # The renderer rejects a replacement of a higher priority as busy, so a higher one is always cancelled.
        named = [r for r in gone if r["behavior"]["priority"] <= spec["priority"]]
        named = next((r for r in named if _key(r["spec"]) == _key(spec)), named[-1] if named else None)
        renewal = spec["type"] == "sit" and named is not None and named["spec"] == spec
        state_id = named["state_id"] if renewal else behavior_id
        if renewal:
            named["state_id"] = None  # replacement receipts must not end the renewed sit's state
        intensity = min(spec["intensity"], c1.TYPING_MAX) if s["typing"] else spec["intensity"]
        behavior = {"behavior_id": behavior_id, "type": spec["type"], "target": spec["target"],
                    "trigger": dict(spec["trigger"]), "display_session": spec["display_session"],
                    "turn_id": spec["turn_id"], "turn_generation": self.generation(), "priority": spec["priority"],
                    "expires_at_ms": int((now + spec["lifetime"]) * 1000), "intensity": intensity,
                    "channels": list(spec["channels"]), "exit": list(spec["exit"]),
                    "replaces": named and named["behavior"]["behavior_id"], "trace_id": spec.get("trace_id") or self.trace_id()}
        if "variant" in spec:  # a renewal sends its spec again, so the variant stays
            behavior["variant"] = spec["variant"]
        if 'facing_yaw' in spec:
            behavior.update(facing_yaw=spec['facing_yaw'],decision_reason=spec['decision_reason'])
        for record in gone:
            if record is not named:
                self.publish("behavior_cancel", {"behavior_id": record["behavior"]["behavior_id"],
                                                 "reason": "replaced", "turn_generation": self.generation()})
            self._end(record, "replaced")
        seq = self.publish("behavior", behavior)
        if self.state is not None:
            if renewal:
                self.state.advance(now)
            else:
                self.state.on_event("behavior_sent", behavior_id=behavior_id, type=spec["type"], priority=spec["priority"])
        if spec["type"] == "short_walk":  # never renewed, so each one sent is a new walk
            scale = WALK_BIAS[self._walk_bias()] if spec["target"] is None else 1.0
            if self.state is not None:
                scale *= self.state.walk_scale()  # on the gap walk_bias set
            self._wander_at = now + self.rng.uniform(*WANDER) * scale * self.interaction.wander_scale
            self._walked_at = now
        # what _exit compares with: speech seen on or off since it started, its own session and state, the focus window
        record = {"behavior": {"seq": seq, **behavior}, "spec": spec, "since": now, "phase": None, "outcome": None,
                  "ended": None, "state_id": state_id, "heard": _speech(s), "quiet": not _speech(s),
                  "character": self.capability_character, "trace_epoch": trace_epoch,
                  "window_id": s["window_id"],
                  "session": (spec["display_session"], (spec["trigger"]["event"] or "").removeprefix("session_state:"))}
        if renewal and "running_at" in named:  # a renewed sit is still the same sit down
            record["running_at"] = named["running_at"]
        self.active[behavior_id] = self.records[behavior_id] = record
        while len(self.records) > KEPT:
            self.records.popitem(last=False)

    def _end(self, record, why):
        """agentd stops counting it as running: expired, replaced, switch_off, exit or character_switch."""
        record["ended"] = why
        self.active.pop(record["behavior"]["behavior_id"], None)
