"""Spatial behaviors (C1 v2 §1–3): which sustained activity the character may do now, as `event: behavior`,
from session, user and speech events and a random tick, under the behavior switches; the avatar host's receipts end them."""
from collections import OrderedDict, deque
import json
import logging
import math
import random
import sys
import threading
import time

import c1
from character.character_state import ENGAGED
from fsutil import atomic_write_json, read_json
from traces.trace_store import new_trace_id
from character.interactions import preset
from motion.chooser import REGION_KEYS

LOG = logging.getLogger(__name__)
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
          "short_walk": (("full_body",), ("user_typing", "user_drag", "speech_start")),
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
QUIET_SLOW = 2.0  # factor on the random tick and wander gaps on the quiet stage
BODY = ("full_body", "contact")  # what the quiet stage and a held posture keep from task and speech behaviors
TASK = ("session", "agent", "decision")  # trigger sources of task behaviors
SPOKEN = ("speech", "agent")  # trigger sources of behaviors her speech drives
HELD = SEATED + ("hold_window_edge", "short_walk")  # postures her speech does not break
EDGE = {"kind": "edge", "side": "nearest"}  # where entering the quiet stage walks her
EDGE_PAUSE = 1.5  # seconds typing stays off before the edge walk starts
PARKED = c1.MOVING + ("hold_window_edge",)  # what her own schedule does not start from quiet entry until it ends
BLOCKING = ("offstage", "quiet")  # stages that consume a terminal arriving on them
FRAME = 1 / 60  # seconds per frame of the motion chooser
MOTION_WAKE = 0.1  # seconds between the motion clock's wakes; the frames since the last wake run as one batch
CATCH_UP = 2.0  # seconds of frames a late wake still runs; the chooser skips the rest of a longer stall
LOOP_TTL = 30.0  # ttl_s of a chosen base loop
LOOP_RENEW = 10.0  # seconds before its ttl_s a chosen base loop that still holds is renewed
HOLD_RETRY = 1.0  # seconds before the chooser's loop that does not run is proposed again
ONE_SHOT_WAIT = 6.0  # seconds past a one-shot clip's length agentd still counts its perform as running
GESTURES = ("speech.gesture", "speech_gestures")  # whys of the chooser's speech gestures
CHAINED = ("next of ", "exit of ", "source return of ")  # why prefixes of a clip its chain plays after another
# C1 snapshot `reactions` trigger -> the pack event whose pool the renderer draws from
REACTION_EVENTS = {"click": "click.single", "pat": "pat.head", "pinch": "pinch.cheek", "drag_lift": "drag.lift",
                   "attention_left": "look.left", "attention_right": "look.right", "present": "present.snap",
                   "hover": "user.hover", "click_repeat": "click.repeat", "pinch_annoyed": "pinch.annoyed",
                   "drop": "drag.land"}
REGION_TRIGGERS = {"click_head": "head_top", "click_cheek": "cheek_l", "click_hand": "hand_l"}  # -> chooser region
BASE_REACTIONS = ("drag_lift", "drop")  # reactions on the base layer; the rest play on the overlay
SEAT_MOVES = ("enter ", "loop ")  # why prefixes of the chooser's own seat clips, which the sit plays itself
WITHIN_FADE = 0.25  # fade_s of a loop within a sit that the chooser leaves for the sit's own loop
RETURN_PRIORITY = 1  # the return performance's clips: above the chooser's own, so an idle tier does not cut them
RETURN_FACE = 10.0  # seconds she faces the user on a return
# return row -> (she faces the user, the welcome: "small", "full" or None, the report gesture)
RETURN_ROWS = {"look_welcome": (True, "small", False), "look_report": (True, None, True),
               "welcome": (False, "full", False), "welcome_report": (False, "full", True)}


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
            spec["trigger"]["event"], spec["display_session"], spec["turn_id"], spec.get('facing_yaw'),
            spec.get("layer"), json.dumps(spec.get("clip")))


def _speech(s):
    """The user speaks or the character's voice is in flight (exit speech_start / speech_end)."""
    return s["user_speaking"] or s["voicing"]


def _autonomous(spec):
    """Her own schedule: a random tick, a routine activity, a blocked one's retarget or a focus walk."""
    return spec["trigger"]["source"] in ("tick", "receipt") or spec["trigger"]["event"] == "focus_change"


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


def _reactions(chooser):
    """C1 snapshot `reactions`: each trigger the chooser's pack has a pool for -> its clips, weights and layer; a clip
    that starts a pack chain plays it, a loop in it for its pack hold_seconds, and on a trigger with an end its first
    loop is held instead. A region trigger draws from the first of its region's pools the pack has; with the pack's
    lift roles the pick-up is their chain and the drop plays nothing more."""
    pack, pools = chooser.pack, {}
    for trigger, event in REACTION_EVENTS.items():
        pools[trigger] = chooser.pool(event)
    for trigger, region in REGION_TRIGGERS.items():
        pools[trigger] = next((pool for pool in map(chooser.pool, REGION_KEYS[region]) if pool), [])
    ends = {}
    if pack.lift is not None:
        pools["drag_lift"] = [(pack.lift[0], 1)] if chooser._open(pack.lift[0]) else []
        pools["drop"], ends["drag_lift"] = [], pack.lift[1]
    table = {}
    for trigger, pool in pools.items():
        layer = "base" if trigger in BASE_REACTIONS else "overlay"
        for clip, weight in pool:
            entry = {"clip": clip, "weight": weight, "layer": layer}
            chain, hold, timed = pack.reaction_chain(clip, trigger in c1.HOLD_TRIGGERS, ends.get(trigger))
            if chain:
                entry["chain"] = chain
            if hold is not None:
                entry["hold"] = hold
            if timed:
                entry["hold_s"] = {c: round(t, 3) for c, t in timed.items()}  # the pack's float32 seconds, to the ms
            if trigger in c1.STROKE_TRIGGERS:
                strokes = {c: pack.entries[c].stroke_s for c in [clip] + entry.get("chain", [])
                           if c in pack.entries and pack.entries[c].stroke_s is not None}
                if strokes:
                    entry["stroke_s"] = strokes
            table.setdefault(trigger, []).append(entry)
    return table


class Consumed:
    """The terminal occurrences a stage in BLOCKING kept from being shown (C1 snapshot `consumed`), the newest
    CONSUMED_MAX; a consumed one is never shown later.
    Lock order: Spatial lock, registry.cv, then this lock, under which nothing else is locked."""

    def __init__(self, stage):
        self.stage = stage
        self.seen = lambda occurrence_id: None  # told each occurrence that comes here, shown or not, resends too
        self._ids = deque(maxlen=c1.CONSUMED_MAX)
        self._lock = threading.Lock()

    def take(self, occurrence_id):
        """True when the occurrence is not to be shown: consumed before, or consumed now by the stage."""
        self.seen(occurrence_id)
        with self._lock:
            if occurrence_id in self._ids:
                return True
            if self.stage() not in BLOCKING:
                return False
            self._ids.append(occurrence_id)
            return True

    def ids(self):
        with self._lock:
            return list(self._ids)


class Spatial:
    def __init__(self, observe, publish, generation, epoch, clock=time.time, rng=None, trace_id=new_trace_id,
                 walk_bias=lambda: None, state=None, session_settle=SESSION_SETTLE,
                 session_min_hold=SESSION_MIN_HOLD, recovery_delay=RECOVERY_DELAY, interaction_preset="balanced",
                 trace_epoch=lambda: None, routine=None, stage=lambda: "normal"):
        """observe() -> {fullscreen, user_speaking, speaking, voicing, line_id, typing, absence, session, state, related,
        window_id, activity, idle_s}: the gate flags, whether the mouth generates or speaks (and its line), whether the
        relay has audio in flight, user_now's typing and absence ({id, since} or None; may be absent), the focus
        session and its state, the ActivityContext related_session_ids, the focus window id (or None, also when
        blacklisted), the ActivityContext activity (may be absent) and the seconds since the last key or mouse input
        (absent or None when unknown).
        publish(event, data) -> seq; generation() -> the current turn_generation; epoch names the behavior ids.
        state: her CharacterState, told what she does and scaling the random tick; None leaves it out.
        routine: her Routine, which then picks the random tick's behavior and how long it lasts, and long work no
        longer sits her down; None keeps the plain random tick.
        stage() -> user_now's stage: offstage, quiet, normal or engaged."""
        self.observe, self.publish, self.generation, self.epoch = observe, publish, generation, epoch
        self.routine, self.stage = routine, stage
        self._refused = {}  # admit reason -> how many proposals it refused
        self._stage_revision = 0  # C1 snapshot stage.revision: stage.* events seen, over restarts once kept
        self._kept = None  # the state-dir file keep() names; None keeps nothing over a restart
        self._kept_base = None  # {pack, clip, until_ms}: the base loop the renderer plays until until_ms, or None
        self._rows = set()  # behavior ids the event rows sent and that still run
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
        self._posture_key = None  # key of the long-work sit or rest that holds now, once sent; None when none holds
        self._activity_run = None  # {activity, since, sent, tries}: the activity's run and the last answer sent to it
        self.consumed = Consumed(lambda: self.stage())
        self._edge = None  # from quiet entry until it ends: {pending, walk: the edge walk's id or None, parked}
        self.parked = lambda on: None  # told True when she becomes parked at an edge, False when that ends
        self._typing_off = -math.inf  # clock time typing was last seen off after being on
        self.chooser = None  # the current character's MotionChooser; None chooses no clips
        self._motion_at = None  # clock time the chooser's frames have reached; None starts them at the next step
        self._intents = deque()  # (clock time, chooser input) of the registry's intents for the next motion step
        self._chosen = []  # (choice, source, input kind, blend_s) the chooser made and Spatial has not proposed
        self._base_id = None  # behavior id of the chosen perform on the base layer
        self._base_since = 0.0  # the chooser's t_s when that perform started
        self._overlay = None  # clip of the chosen overlay perform, while the chooser still plays it
        self._staged = None  # a clause's gesture the chooser staged behind its start family's base
        self._hold_at = 0.0  # clock time the chooser's loop that does not run may be proposed again
        self._held = False  # whether the current chooser has had a base loop sent
        self._user_play = False  # the user's own play or pose scene holds the base layer: no base clip goes out
        # whether the current chooser's entrance waits for a stage she shows on and for her to stand; a return
        # performance that plays meanwhile has greeted the user in its place
        self._enter = False
        self._within = None  # behavior id of the chosen perform she plays within her sit
        self._seated = self._voice = False  # what the chooser was told: she sits; her voice plays
        self._variant = None  # and the variant of the sit she sits in
        self._clauses = OrderedDict()  # clause key -> the intent of its clause_intent, until its clause_end
        self._reactions = None  # the chooser's snapshot reaction table
        self._seen = None  # the latest observe(), which chosen performs are admitted against
        self._return = None  # while the return performance plays: {steps, part, clip, intent, semantic}
        self._returned = []  # behavior ids of its clips; once it is over they lapse for the chooser's next clip
        self.last_return = None  # the last return decision with what of it played and why the rest did not
        self._lock = threading.RLock()
        self._wake = threading.Event()
        self._motion_wake = threading.Event()

    def run(self, stop, skip=lambda: False):
        """skip() -> True leaves this poll and the motion clock's steps out (agentd's reset or an open character
        switch)."""
        threading.Thread(target=self._motion_loop, args=(stop, skip), daemon=True).start()
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
        s = self._seen = self.observe()
        with self._lock:
            now = self.clock()
            if self.chooser is not None and s["voicing"] != self._voice:
                # the relay's estimate ends a voice without any receipt, so its end is also read here
                self.motion({"kind": "voice", "on": s["voicing"]})
            s = self._stabilize_session(s, now)
            self._track(s, now)
            if s["typing"]:
                self._typing_off = None
            elif self._typing_off is None:
                self._typing_off = now
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
                # a row that no longer holds owns nothing: the row that follows it ends it, whatever its priority
                lapsed = [r for r in self.active.values() if r["behavior"]["behavior_id"] in self._rows]
                if event is not None and not self._running(key) \
                        and self._blocked.get(_target_key(event["type"], event["target"]), 0) <= now \
                        and self._unsupported.get(_unsupported_key(event["type"], event["target"]), 0) <= now:
                    if self._send(event, s, now, lapsed)[0]:
                        self._rows.add(next(reversed(self.active)))
                    else:
                        self._event_key = None  # a refused row is proposed again at the next poll
            self._take_posture(posture, s, now)
            self._edge_walk(s, now)
            self._react(s, now, event, posture)
            self._focus_walk(s, now)
            if self.routine is not None:
                self._follow_routine(s, now, give_way or posture is not None)
            elif not give_way and (self._next_tick is None or now >= self._next_tick):
                if self.state is not None:
                    self.state.advance(now)
                scale = 1.0 if self.state is None else self.state.tick_scale()
                self._next_tick = now + self.rng.uniform(*TICK) * scale * self.interaction.random_tick_scale \
                    * self._slow()
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
            trace = dict(trace_id=trace_id, trace_turn_id=trace_turn_id, trace_epoch=trace_epoch) if trace_id else {}
            return self._face(s, float(yaw), reason, hold_seconds, source, 'facing_decision', trace)

    def _face(self, s, yaw, reason, hold_seconds, source, event, trace):
        """A face toward yaw (0 faces the user) through admit: request_facing's answer."""
        if not self.facing_available() or self._forbidden('face', None, False):
            return {'accepted':False,'reason':'facing_unavailable'}
        if s['fullscreen'] and self.switches['fullscreen_give_way']:
            return {'accepted':False,'reason':'fullscreen'}
        if any(r['behavior']['type'] not in ('face','idle','think','listen','accompany') and set(r['behavior']['channels']) & {'full_body','contact'}
               and 'clip' not in r['behavior'] for r in self.active.values()): return {'accepted':False,'reason':'body_busy'}
        exits = ('user_drag','focus_change') if source=='decision' else ('user_drag',)
        spec = _spec('face',None,source,event,0,('full_body',),exits,.2,hold_seconds)
        spec.update(facing_yaw=yaw,decision_reason=reason,**trace)
        admitted, refused = self._send(spec,s,self.clock())
        if not admitted:return {'accepted':False,'reason':refused}
        record = next(reversed(self.active.values()))
        return {'accepted':True,'behavior_id':record['behavior']['behavior_id'],
                'facing_yaw':yaw,'phase':'requested'}

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
        `behavior_cancel` / `switch_off`; `bust_framing` also limits the chooser to standing clips. Returns the stored
        values."""
        with self._lock:
            self.switches = dict(switches)
            if self.chooser is not None:
                self.chooser.set_framing("bust" if self.switches.get("bust_framing") else "full")
                self._publish_reactions()
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
                if record["behavior"]["priority"] == 0 and set(record["behavior"]["channels"]) & {"full_body", "contact"} \
                        and not record["spec"].get("chosen"):
                    self._recovery_at = max(self._recovery_at, now + self.recovery_delay)
                if self.state is not None and record["state_id"] is not None:
                    self.state.on_event("behavior_ended", behavior_id=record["state_id"],
                                        type=record["behavior"]["type"], outcome=record["outcome"])
                if self._edge is not None and self._edge["walk"] == body["behavior_id"]:
                    self._edge["parked"] = True
                    self.parked(True)
            if phase == "rejected" and record["ended"] is None:
                self._restore(record["behavior"]["replaces"], now)
            if phase == "rejected" and body.get("reason") == "unsupported":
                behavior = record["behavior"]
                self._unsupported[_unsupported_key(behavior["type"], behavior["target"], behavior.get("variant"))] = \
                    now + UNSUPPORTED_FOR
            if phase == "cancelled" and body.get("reason") == "user_play":
                self._user_play = True  # its started may come after this receipt
            if body.get("reason") == "connection_lost":
                self._unsupported.clear()  # the next Avatar may run other types
                self._user_play_over()
            if phase == "blocked":
                behavior = record["behavior"]
                self._blocked[_target_key(behavior["type"], behavior["target"])] = now + BLOCKED_FOR
                if record.get("ended") is None and not (s["fullscreen"] and self.switches["fullscreen_give_way"]):
                    spec = self._pick(s, now, "receipt", f"blocked:{body['reason']}", behavior["type"])
                    if spec is not None:
                        self._send(spec, s, now)
            return True, None

    def _restore(self, behavior_id, now):
        """A rejected behavior replaced nothing on the renderer: the one its `replaces` named runs on, unless the
        renderer has ended it or it has run out."""
        record = self.records.get(behavior_id)
        if record is None or record["ended"] != "replaced" or record["phase"] in c1.ENDED \
                or record["behavior"]["expires_at_ms"] <= now * 1000:
            return
        record["ended"] = None
        self.active[behavior_id] = record
        for key in sorted(self.active, key=lambda i: self.active[i]["behavior"]["seq"]):
            self.active.move_to_end(key)

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
                    "capability_character": self.capability_character, "capabilities": self.capabilities,
                    "refused": dict(self._refused), "consumed": len(self.consumed.ids()),
                    "parked": bool(self._edge and self._edge["parked"]),
                    "edge_pending": bool(self._edge and self._edge["pending"]),
                    "return": self.last_return and {**self.last_return, "played": list(self.last_return["played"])}}

    def admit(self, spec, s, now, lapsed=()):
        """Whether a proposal may run now: (True, None), or (False, the first check that fails): stale (its
        turn_generation is not the current one; a character switch moves it too), unsupported, switch_off, lifted (a sit
        while the chooser holds her in an air or boss posture), stage,
        typing, speech, posture, busy (a higher priority owns one of its channels; a lapsed record owns none; a
        chosen perform takes no channel another owner holds). Changes nothing."""
        with self._lock:
            kind, target, source = spec["type"], spec["target"], spec["trigger"]["source"]
            renewal = self._running(_key(spec))
            body = bool(set(spec["channels"]) & set(BODY))
            speaking = s["speaking"] or s["voicing"]
            if "turn_generation" in spec and spec["turn_generation"] != self.generation():
                return False, "stale"
            if not self._capable(kind, target):
                return False, "unsupported"
            if self._forbidden(kind, target, False):
                return False, "switch_off"
            if kind in SEATED and self.chooser is not None and self.chooser.holds_lifted:
                return False, "lifted"
            stage = self.stage()
            edge = target is not None and target["kind"] == "edge"
            # offstage keeps base rest only; quiet keeps task behaviors off the body but its own walk to the edge
            if not renewal and (stage == "offstage" and (kind != "idle" or _autonomous(spec)) and not spec.get("rest")
                                or stage == "quiet" and source in TASK and kind != "idle" and body and not edge):
                return False, "stage"
            if self._forbidden(kind, target, s["typing"]):
                return False, "typing"
            if speaking and not renewal and _autonomous(spec):
                return False, "speech"
            if speaking and source in SPOKEN and body \
                    and any(r["behavior"]["type"] in HELD for r in self.active.values()):
                return False, "posture"
            channels = set(spec["channels"])
            if any(c1.contends(r["behavior"], spec) and (r["behavior"]["priority"] > spec["priority"] or spec.get("chosen")
                                                          and not r["spec"].get("chosen"))
                   and channels & set(r["behavior"]["channels"]) for r in self.active.values() if r not in lapsed):
                return False, "busy"
            return True, None

    def offer(self, spec):
        """A proposal from outside the poll (the Performer's perform), admitted and sent as Spatial's own; spec's
        behavior_id, turn_generation, expires_at_ms and payload stay. Returns admit's answer.
        It takes the Spatial lock and then registry.cv to publish: never call it holding registry.cv."""
        s = self.observe()
        with self._lock:
            return self._send(spec, s, self.clock())

    def stage_event(self, name):
        """A user_now stage.* event: entering quiet asks for one walk to the nearest free edge; any other stage ends
        the parking and leaves an edge walk in flight to finish. The quiet stage also clears the chooser's intent
        presentation."""
        with self._lock:
            if self._edge is not None and self._edge["parked"]:
                self.parked(False)
            self._edge = {"pending": True, "walk": None, "parked": False} if name == "stage.quiet" else None
            if self._return is not None and name in ("stage.quiet", "stage.offstage"):
                self.last_return["why"] = "stage"
                self._return_over()
            if name == "stage.quiet":
                self.motion({"kind": "quiet"})
            self._stage_revision += 1
            self._save()
            self.publish("snapshot", {"behaviors": self.running(), "stage": self.stage_level(),
                                      "consumed": self.consumed.ids(), "turn_generation": self.generation()})
        self.wake()

    def use_motion(self, chooser):
        """The current character's MotionChooser, None for none. A new one starts on its own clock, and its reaction
        table goes out in a snapshot (C1 v2.7)."""
        with self._lock:
            replaced = chooser is not None or self.chooser is not None
            self.chooser, self._motion_at, self._chosen, self._base_id = chooser, None, [], None
            self._overlay = self._staged = self._return = None
            self._returned = []
            self._hold_at, self._seated, self._voice, self._held = 0.0, False, False, False
            self._enter, self._within, self._variant, self._user_play = chooser is not None, None, None, False
            self._intents.clear()
            self._clauses.clear()
            if chooser is not None:
                chooser.set_framing("bust" if self.switches.get("bust_framing") else "full")
            self._reactions = None if chooser is None else _reactions(chooser)
            if replaced:
                self.publish("snapshot", {"behaviors": self.running(), "reactions": self._reactions or {},
                                          "stage": self.stage_level(),
                                          "consumed": self.consumed.ids(), "turn_generation": self.generation()})

    def keep(self, path):
        """main gives it its state-dir file, which carries the stage revision and the base loop over an agentd
        restart: the revision goes on from the last one, one more when the stage derived anew differs, and a loop the
        renderer still plays (its ttl_s not over) becomes the chooser's playhead, which the first base perform takes
        up with start sync."""
        try:
            saved = read_json(path)
        except (OSError, ValueError):
            saved = None  # the first start
        with self._lock:
            self._kept = path
            if saved is not None:
                self._stage_revision = saved["revision"] + (saved["level"] != self.stage())
                base = saved["base"]
                if base is not None and self.chooser is not None and base["pack"] == self.chooser.pack.id \
                        and self.clock() * 1000 < base["until_ms"] and self.chooser.pack.loop(base["clip"]):
                    self.chooser.report_playhead(base["clip"], 0.0)
                    self._kept_base, self._enter = base, False
            self._save()

    def _save(self):
        """Under the lock: the stage revision and the base loop to the kept file, if any."""
        if self._kept is None:
            return
        try:
            atomic_write_json(self._kept, {"revision": self._stage_revision, "level": self.stage(),
                                           "base": self._kept_base})
        except OSError as e:
            print(f"agentd: spatial state not saved: {type(e).__name__}", file=sys.stderr)

    def set_motion_prefs(self, switches, overrides):
        """PUT /behavior/motion_prefs (body checked by the route): the current chooser takes the user's action switches
        and motion overrides, and a reaction table they change goes out in a snapshot. Returns what was
        adjusted in the shape of C3's `action_switches` and `motion_overrides` replies; None without a chooser."""
        with self._lock:
            chooser = self.chooser
            if chooser is None:
                return None
            switched = chooser.set_action_switches(switches)
            adjusted = chooser.set_motion_overrides(overrides["chains"], overrides["pools"], overrides["blend_in"])
            self._publish_reactions()
            applied = {key: len(overrides[key]) - sum(1 for a in adjusted if a["kind"] == kind)
                       for key, kind in (("chains", "chain"), ("pools", "pool"), ("blend_in", "blend_in"))}
            return {"action_switches": {"switches": dict(chooser.switches), "adjusted": switched},
                    "motion_overrides": {"applied": applied, "adjusted": adjusted}}

    def _publish_reactions(self):
        """Under the lock: a snapshot with the chooser's reaction table when it changed."""
        reactions = _reactions(self.chooser)
        if reactions != self._reactions:
            self._reactions = reactions
            self.publish("snapshot", {"behaviors": self.running(), "reactions": reactions, "stage": self.stage_level(),
                                      "consumed": self.consumed.ids(), "turn_generation": self.generation()})

    def stage_level(self):
        """C1 snapshot `stage`: user_now's stage and how many times it changed."""
        with self._lock:
            return {"level": self.stage(), "revision": self._stage_revision}

    def reactions(self):
        """The current chooser's snapshot reaction table, None without a chooser."""
        with self._lock:
            return self._reactions

    def motion_intent(self, intent, withheld):
        """registry.on_intent: the intent goes to the chooser at its time; a withheld terminal goes without its state,
        so no terminal clip is chosen. It runs under registry.cv, so it only queues and wakes the motion clock."""
        if self.chooser is None:
            return
        item = {"kind": "intent", "intent": intent["intent"], "state": intent["state"],
                "activity": intent["activity"], "mood": intent["mood"], "display_session": intent["display_session"]}
        if withheld:
            item.update(intent="idle", state=None)
        self._intents.append((self.clock(), item))
        self._motion_wake.set()

    def motion(self, item):
        """A speech input for the chooser (text_line, voice, clause, clause_end) or the quiet stage's, sent now and
        its choices proposed in this call. It takes the Spatial lock and then registry.cv: never call it holding
        registry.cv."""
        with self._lock:
            if self.chooser is None:
                return
            now = self.clock()
            self._advance(now)
            self._input(item, None if item["kind"] == "quiet" else "speech")
            if self._seen is not None:
                self._propose(self._seen, now)

    def motion_clause(self, key, intent):
        """A clause_intent as it goes out: the chooser's gesture for it is chosen in this call; key names the clause
        for motion_clause_end."""
        with self._lock:
            self._clauses[key] = intent
            while len(self._clauses) > KEPT:
                self._clauses.popitem(last=False)
            self.motion({"kind": "clause", "intent": intent})

    def motion_clause_end(self, key):
        """The clause key names has played out: the chooser takes back its gesture."""
        with self._lock:
            intent = self._clauses.pop(key, None)
            if intent is not None:
                self.motion({"kind": "clause_end", "intent": intent})

    def perform_return(self, decision):
        """Return's decision on a user.return, {row, away_s, ended, why}: with why None the row (RETURN_ROWS) plays, a
        face toward the user, then the welcome, then the report gesture, each a clip the chooser picks and admit lets
        run, the next once the chooser leaves the one before. Returns the record diag() shows, which the later parts
        update: the decision with played, the parts sent so far, and why the last part refused did not play."""
        with self._lock:
            record = self.last_return = {**decision, "played": []}
            s, now = self._seen, self.clock()  # the motion clock's first step observes
            if decision["why"] is not None or s is None:
                record["why"] = record["why"] or "no_motion"
                self._log_return()
                return record
            look, welcome, report = RETURN_ROWS[decision["row"]]
            if look:
                face = self._face(s, 0.0, "the user came back", RETURN_FACE, "user", "user_return", {})
                if face["accepted"]:
                    record["played"].append("face")
                    self._enter = False
                else:
                    record["why"] = face["reason"]
            if self.chooser is None:
                record["why"] = "no_motion"
            elif self._seated:
                record["why"] = "seated"
            elif not self.chooser.ready():
                record["why"] = "busy"  # a session loop or a pending change holds the body: no welcome over it
            else:
                self._advance(now)
                self._propose(s, now)
                steps = deque(self._return_steps(welcome, report))
                self._return = {"steps": steps, "part": None, "clip": None, "intent": None,
                                "semantic": self.chooser.semantic}
                if self._return_next():
                    self._propose(s, now)
                    return record
                record["why"] = "no_clip"
                self._return_over()
                return record
            self._log_return()
            return record

    def _return_steps(self, welcome, report):
        """(part, chooser input) of each clip the return plays, by what the pack maps: the small welcome is the
        acknowledge intent and the full one the greet intent, each standing in for the other in a pack with one; the
        report gesture is the explain intent."""
        pack = self.chooser.pack
        intent = lambda name: {"kind": "clause", "intent": name} \
            if pack.primary(name) or pack.contexts.get("intent." + name) else None  # noqa: E731
        greet, nod = intent("greet"), intent("acknowledge")
        steps = (("welcome", {"small": nod or greet, "full": greet or nod, None: None}[welcome]),
                 ("report", intent("explain") if report else None))
        return [(part, item) for part, item in steps if item is not None]

    def _return_next(self):
        """Sends the return's next step to the chooser; a step it chooses nothing for is skipped. False when none is
        left: the caller ends the return."""
        ret = self._return
        while ret["steps"]:
            ret["part"], item = ret["steps"].popleft()
            ret["clip"] = None
            choices = self.chooser.send(item)
            if item["kind"] == "clause":
                ret["intent"] = item["intent"]
            if choices:
                self._take(choices, "user", "return")
                return True
        return False

    def _return_over(self):
        """The return ends; the chooser's intent goes back to the one before it unless something has set another."""
        ret, self._return = self._return, None
        if ret["intent"] is not None and self.chooser.semantic == ret["intent"]:
            self.chooser.send({"kind": "semantic", "intent": ret["semantic"]})
        self._log_return()

    def _log_return(self):
        """One agentd log line for the return performance's outcome, once it is over or did not start."""
        r = self.last_return
        print(f"agentd: return performance row={r['row']} played={','.join(r['played']) or 'none'} why={r['why']}",
              file=sys.stderr)

    def _lapsed(self):
        """The return's clips that still run once it is over: the chooser's next clip replaces them."""
        self._returned = [i for i in self._returned if i in self.active]
        return [] if self._return is not None else [self.active[i] for i in self._returned]

    def motion_state(self, body):
        """A C3 motion_state (rule 54): at a cycle end or the end of a clip the chooser chose, the chooser's playhead
        goes where the renderer's is. The user's own play holds the chooser's base clips from its start to its end."""
        with self._lock:
            if body["origin"] == "user":
                if body["phase"] == "started":
                    self._user_play = True
                else:
                    self._user_play_over()
                return
            record = self.records.get(body["behavior_id"])
            if self.chooser is None or record is None or not record["spec"].get("chosen") \
                    or body["phase"] not in ("cycle_end", "ended"):
                return
            clip = record["spec"]["clip"]["id"]
            current, time_s, _ = self.chooser.playhead()
            if current != clip:  # the chooser has moved on from it
                return
            length = self.chooser.pack.lengths[clip]
            self.chooser.report_playhead(clip, max(1, round(time_s / length)) * length
                                         if body["phase"] == "cycle_end" else length)

    def _user_play_over(self):
        """The user's play gave the body back: the chooser goes on from what the base layer plays, her rest loop."""
        if self._user_play:
            self._user_play = False
            if self.chooser is not None:
                self.chooser.report_playhead(*self._played())

    def motion_step(self):
        """One wake of the motion clock: the chooser's frames up to now with the registry's intents at their times,
        each choice proposed, and the chooser's loop kept on the base layer and renewed."""
        if self._seen is None:
            self._seen = self.observe()
        with self._lock:
            if self.chooser is None:
                return
            now = self.clock()
            self._advance(now)
            if self.chooser.holds_lifted:  # an air or boss activity stands her up
                for record in [r for r in self.active.values() if r["behavior"]["type"] in SEATED]:
                    self._end(record, "expired")
                    self.publish("behavior_cancel", {"behavior_id": record["behavior"]["behavior_id"],
                                                     "reason": "expired", "turn_generation": self.generation()})
            sit = next((r["behavior"] for r in self.active.values() if r["behavior"]["type"] in SEATED), None)
            if (sit is not None) != self._seated:
                self._seated = sit is not None
                if sit is None:  # her sit hands back a standing body; a rejected one, the loop that played on
                    if self._within in self.active:  # it ended with the sit
                        self._end(self.active[self._within], "replaced")
                    self._within = None
                    self.chooser.report_playhead(*self._played())
                self._input({"kind": "sit", "variant": sit.get("variant")} if sit else {"kind": "stand"}, None)
            elif sit is not None and sit.get("variant") != self._variant:
                self._input({"kind": "sit_variant", "variant": sit.get("variant")}, None)
            self._variant = sit and sit.get("variant")
            if self._enter and not self._seated and self.stage() not in BLOCKING:
                self._enter = False
                self._input({"kind": "event", "key": "character.enter"}, None)
            self._propose(self._seen, now)
            self._hold(self._seen, now)

    def _motion_loop(self, stop, skip):
        # The chooser's clock is the wall clock: each wake runs the frames since the last one, so a slow wake only
        # delays the choices it makes, never their times.
        while True:
            self._motion_wake.wait(MOTION_WAKE)
            self._motion_wake.clear()
            if stop.is_set():
                return
            if skip():
                with self._lock:
                    self._motion_at = None  # no frames run while Spatial is skipped
                continue
            try:
                self.motion_step()
            except Exception:
                LOG.exception("motion step failed")

    def _advance(self, now):
        """The chooser's frames up to now; each registry intent goes in before the first frame past its time."""
        self._motion_at = now if self._motion_at is None else max(self._motion_at, now - CATCH_UP)
        for _ in range(int((now - self._motion_at) / FRAME + 1e-6)):
            self._motion_at += FRAME
            while self._intents and self._intents[0][0] <= self._motion_at:
                self._input(self._intents.popleft()[1], None)
            self._take(self.chooser.tick(FRAME), None, "tick")
        while self._intents and self._intents[0][0] <= now:
            self._input(self._intents.popleft()[1], None)

    def _input(self, item, source):
        if item["kind"] == "voice":
            if item["on"] == self._voice:
                return
            self._voice = item["on"]
        self._take(self.chooser.send(item), source, item["kind"])

    def _take(self, choices, source, kind):
        if choices:
            clip, _, blend = self.chooser.playhead()
            self._chosen += [(c, source, kind, blend if c["clip"] == clip else None) for c in choices]

    def _propose(self, s, now):
        chosen, self._chosen = self._chosen, []
        for choice, source, kind, blend in chosen:
            self._choose(choice, source, kind, blend, s, now)

    def _choose(self, choice, source, kind, blend, s, now):
        """One choice as a perform through admit. A clause's gesture and the speech gestures go on the overlay, and so
        does the chain after one; every other clip on the base layer. A refused one leaves the chooser's playhead on
        what the base layer plays."""
        clip, why = choice["clip"], choice["why"]
        if self._seated:
            self._choose_within(clip, why, source, blend, s, now)
            return
        ret = self._return
        if ret is not None and ret["clip"] is not None and clip not in self.chooser.pack.chain(ret["clip"]):
            if self._return_next():
                return  # the chooser left the step's clip: the next step's clips play instead of this one
            self._return_over()
            ret = None
        elif ret is not None and ret["clip"] is None and not why.startswith(("base before ", "toward ")):
            ret["clip"] = clip
        if kind == "clause" and why.startswith("base before "):
            self._staged = why.removeprefix("base before ")  # the overlay needs no base to start from
            return
        overlay = kind == "clause" or why in GESTURES or clip == self._staged \
            or self._overlay is not None and why in tuple(prefix + self._overlay for prefix in CHAINED)
        base = self.active.get(self._base_id)
        if not overlay:
            self._overlay = None
            if base is not None and base["spec"]["clip"]["id"] == clip:
                return  # back on what the base layer plays
        spec = self._chosen_spec(clip, "overlay" if overlay else "base",
                                 "user" if ret is not None else source or self._source(why), why, blend)
        if ret is not None:
            spec["priority"] = RETURN_PRIORITY
        left = self._return_left(base) if not overlay and why.startswith("exit of ") else 0.0
        if left > 0:  # the renderer plays the return's clip out first (C1 §1.4), and the chooser's clock waits with it
            spec.update(start="after_exit", lifetime=spec["lifetime"] + left)
        admitted, refused = (False, "user_play") if self._user_play and not overlay \
            else self._send(spec, s, now, self._lapsed())
        if ret is not None and admitted:
            self._returned.append(next(reversed(self.active)))
            if ret["part"] not in self.last_return["played"]:
                self.last_return["played"].append(ret["part"])
            self._enter = False
        elif ret is not None:
            self.last_return["why"] = refused
            self._return_over()
        if not admitted:
            self.chooser.report_playhead(*self._played())
        elif overlay:
            self._overlay, self._staged = clip, None
        else:
            self._new_base(now)
            self._base_since = self.chooser.t_s + left
            self._held = True
            if left > 0:
                self.chooser.report_playhead(clip, -left)

    def _choose_within(self, clip, why, source, blend, s, now):
        """A seated choice: her sit plays its own enter and loop, and a loop within it that the chooser leaves for that
        loop fades out; any other clip is a base perform within the sit. Before the chooser sits on the seat's loop its
        clips are the standing ones it plays out and the enter, and after the sit ended there is nothing to play within."""
        sit = next((r for r in self.active.values() if r["behavior"]["type"] in SEATED), None)
        if sit is None or not self.chooser.seated or self._user_play:
            return
        within = self.active.get(self._within)
        if why.startswith(SEAT_MOVES):
            if why.startswith("loop ") and within is not None and within["spec"].get("loop"):
                self._end(within, "expired")
                self.publish("behavior_cancel", {"behavior_id": self._within, "reason": "expired", "mode": "fade_out",
                                                 "fade_s": WITHIN_FADE, "turn_generation": self.generation()})
            return
        spec = self._chosen_spec(clip, "base", source or self._source(why), why, blend)
        spec["within"] = sit["behavior"]["behavior_id"]
        if self._send(spec, s, now)[0]:
            self._within = next(reversed(self.active))

    def _new_base(self, now):
        """The chosen perform just sent holds the base layer; a loop is kept for the next agentd until the renderer
        would drop it unrenewed."""
        self._base_id = next(reversed(self.active))
        record = self.active[self._base_id]
        spec = record["spec"]
        self._kept_base = {"pack": self.chooser.pack.id, "clip": spec["clip"]["id"],
                           "until_ms": min(record["behavior"]["expires_at_ms"], int((now + spec["ttl_s"]) * 1000))} \
            if spec.get("loop") else None
        self._save()

    def _return_left(self, base):
        """Seconds the return's one-shot clip on the base layer still plays on the chooser's clock; 0 for any other."""
        if base is None or base["behavior"]["behavior_id"] not in self._returned or base["spec"].get("loop"):
            return 0.0
        played = self.chooser.t_s - self._base_since
        return max(0.0, self.chooser.pack.lengths[base["spec"]["clip"]["id"]] - played)

    def _hold(self, s, now):
        """Renews the chosen base loop before its ttl_s runs out, and proposes the chooser's loop when the base layer
        does not play it (at the start, after another owner or the stage took the body)."""
        if self._user_play:
            return
        base = self.active.get(self._base_id)
        if base is not None and base["spec"].get("loop") and base["behavior"]["expires_at_ms"] <= (now + LOOP_RENEW) * 1000:
            # a return loop the chooser still plays after the return is renewed as her own
            spec = {k: v for k, v in base["spec"].items() if k != "start"}
            if self._return is None:
                spec["priority"] = 0
            if self._send(spec, s, now, self._lapsed())[0]:
                self._new_base(now)
            return
        clip = self.chooser.playhead()[0]
        if self._seated or now < self._hold_at or not self.chooser.pack.loop(clip) \
                or base is not None and base["spec"]["clip"]["id"] == clip:
            return
        self._hold_at = now + HOLD_RETRY
        spec = self._chosen_spec(clip, "base", self._source("hold"), "hold", None)
        if not self._held:
            spec["start"] = "sync"  # after an agentd restart the renderer still plays this loop: no restart from 0
        if self._send(spec, s, now, self._lapsed())[0]:
            self._new_base(now)
            self._base_since = self.chooser.t_s
            self._held = True

    def _source(self, why):
        return "session" if why.startswith("session.") else "speech" if self.chooser.speaking else "tick"

    def _chosen_spec(self, clip, layer, source, why, blend):
        """A perform of a chosen clip; a base loop is a rest loop when it is one of the pack's idle bases."""
        pack = self.chooser.pack
        loop = layer == "base" and pack.loop(clip)
        spec = _spec("perform", None, source, why, 0, c1.LAYER_CHANNELS[layer], (), 0.5,
                     LOOP_TTL if loop else pack.lengths[clip] + ONE_SHOT_WAIT)
        spec.update(clip={"id": clip}, layer=layer, chosen=True)
        if loop:
            spec.update(loop=True, ttl_s=LOOP_TTL, rest=clip in pack.idle_bases)
        if blend is not None:
            spec["blend_s"] = round(min(blend, c1.BLEND_S[1]), 3)
        return spec

    def _played(self):
        """The clip the base layer plays and its time on the chooser's clock; the pack's overview, the renderer's
        default rest loop, when no chosen perform holds it."""
        if self._base_id in self.active:
            return self.active[self._base_id]["spec"]["clip"]["id"], self.chooser.t_s - self._base_since
        return self.chooser.pack.overview, 0.0

    def _edge_walk(self, s, now):
        """The quiet stage's one walk to the edge once typing has been off EDGE_PAUSE. Seated, holding a window
        edge, kept in place or unsupported she does not walk and is parked at once; busy, it waits."""
        edge = self._edge
        if edge is None or not edge["pending"] or self.stage() != "quiet" \
                or self._typing_off is None or now - self._typing_off < EDGE_PAUSE:
            return
        if any(r["behavior"]["type"] in SEATED + ("hold_window_edge",) for r in self.active.values()) \
                or not self._capable("short_walk", EDGE) or self._forbidden("short_walk", EDGE, False) \
                or self._unsupported.get(_unsupported_key("short_walk", EDGE), 0) > now:
            edge.update(pending=False, parked=True)
            self.parked(True)
            return
        spec = _spec("short_walk", dict(EDGE), "decision", "stage_quiet", 0, ("full_body",), ("user_drag",), 0.5,
                     60.0)
        if self._send(spec, s, now)[0]:
            edge.update(pending=False, walk=next(reversed(self.active)))

    def _slow(self):
        return QUIET_SLOW if self.stage() == "quiet" else 1.0

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
        """How long the stabilized focus session has been at work."""
        session = s["session"] if s["state"] in ACCOMPANY else None
        if session is None:
            self._work = None
        elif self._work is None or self._work["session"] != session:
            self._work = {"session": session, "since": now}
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
        """No session at work or waiting, no speech or typing, no input for QUIET, and user_now's absence AWAY_REST
        old or a NIGHT hour."""
        idle, absence = s.get("idle_s"), s.get("absence")
        if s["session"] is not None and s["state"] in ACCOMPANY + ATTEND or _speech(s) or s["typing"] \
                or idle is not None and idle < QUIET:
            return False
        if absence is not None and now - absence["since"] >= AWAY_REST:
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
            if self._send(_spec(kind, target, "user", "activity:" + run["activity"], 1, channels, exits, intensity,
                                lifetime, variant=variant), s, now)[0]:
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
                or kind == "short_walk" and self._walk_bias() == "stay" \
                or kind in PARKED and self._edge is not None:
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
        admitted, _ = self._send(_spec(act.kind, target, "tick", f"routine:{name}", 0, channels, exits,
                                       round(self.rng.uniform(*intensity), 2), seconds, variant=variant), s, now)
        self._next_tick = None if admitted else now + ROUTINE_RETRY
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

    def _send(self, spec, s, now, lapsed=()):
        """Sends spec once admit lets it; a refused one is dropped, counted in diag() and logged, and cancels
        nothing. Returns admit's answer."""
        admitted, reason = self.admit(spec, s, now, lapsed)
        if not admitted:
            self._refused[reason] = self._refused.get(reason, 0) + 1
            LOG.debug("behavior %s from %s refused: %s", spec["type"], spec["trigger"]["source"], reason)
            return admitted, reason
        trace_epoch = spec.get("trace_epoch") or self.trace_epoch()
        self._count += 1
        behavior_id = spec.get("behavior_id") or f"b-{self.epoch}-{self._count}"
        # a behavior that ends on user_typing gives way to the next one while the user types (fixture 07).
        gone = [r for r in self.active.values() if c1.contends(r["behavior"], spec)
                and (r["behavior"]["priority"] <= spec["priority"] or r in lapsed)
                and (set(r["behavior"]["channels"]) & set(spec["channels"])
                     or s["typing"] and "user_typing" in r["behavior"]["exit"])]
        # replaces names one: the renewed one when this is a renewal, else the latest; each other one is cancelled.
        # The renderer rejects a replacement of a higher priority as busy, so a lapsed higher one is cancelled.
        lower = [r for r in gone if r["behavior"]["priority"] <= spec["priority"]]
        named = next((r for r in lower if _key(r["spec"]) == _key(spec)), lower[-1] if lower else None)
        renewal = spec["type"] == "sit" and named is not None and named["spec"] == spec
        # her state counts what Spatial does, not each clip the chooser plays
        state_id = None if spec.get("chosen") else named["state_id"] if renewal else behavior_id
        if renewal:
            named["state_id"] = None  # replacement receipts must not end the renewed sit's state
        intensity = min(spec["intensity"], c1.TYPING_MAX) if s["typing"] else spec["intensity"]
        behavior = {"behavior_id": behavior_id, "type": spec["type"], "target": spec["target"],
                    "trigger": dict(spec["trigger"]), "display_session": spec["display_session"],
                    "turn_id": spec["turn_id"], "turn_generation": self.generation(), "priority": spec["priority"],
                    "expires_at_ms": spec["expires_at_ms"] if "expires_at_ms" in spec
                    else int((now + spec["lifetime"]) * 1000), "intensity": intensity,
                    "channels": list(spec["channels"]), "exit": list(spec["exit"]),
                    "replaces": named and named["behavior"]["behavior_id"], "trace_id": spec.get("trace_id") or self.trace_id()}
        if "variant" in spec:  # a renewal sends its spec again, so the variant stays
            behavior["variant"] = spec["variant"]
        if 'facing_yaw' in spec:
            behavior.update(facing_yaw=spec['facing_yaw'],decision_reason=spec['decision_reason'])
        behavior.update({key: spec[key] for key in c1.PAYLOADS + c1.PLAY_FIELDS if key in spec})
        for record in gone:
            if record is not named:
                self.publish("behavior_cancel", {"behavior_id": record["behavior"]["behavior_id"],
                                                 "reason": "replaced", "turn_generation": self.generation()})
            self._end(record, "replaced")
        seq = self.publish("behavior", behavior)
        if self.state is not None and not spec.get("chosen"):
            if renewal:
                self.state.advance(now)
            else:
                self.state.on_event("behavior_sent", behavior_id=behavior_id, type=spec["type"], priority=spec["priority"])
        if spec["type"] == "short_walk":  # never renewed, so each one sent is a new walk
            scale = WALK_BIAS[self._walk_bias()] if spec["target"] is None else 1.0
            if self.state is not None:
                scale *= self.state.walk_scale()  # on the gap walk_bias set
            self._wander_at = now + self.rng.uniform(*WANDER) * scale * self.interaction.wander_scale * self._slow()
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
        return True, None

    def _end(self, record, why):
        """agentd stops counting it as running: expired, replaced, switch_off, exit or character_switch."""
        record["ended"] = why
        self.active.pop(record["behavior"]["behavior_id"], None)
        self._rows.discard(record["behavior"]["behavior_id"])
