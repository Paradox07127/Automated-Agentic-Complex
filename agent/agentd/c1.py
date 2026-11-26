"""C1 message checks: behavior, behavior_cancel, clause_intent, text_line,
motion, session_reaction and the execution receipt, and the player fixtures (`check_player_fixture`).
`python3 -I c1.py <fixture dir>` checks every shared fixture file there."""
import json
import math
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I leaves the script's folder off the path
from brain.markers import INTENTS  # noqa: E402

TYPES = ("idle", "observe", "short_walk", "sit", "hold_window_edge", "climb_window_top", "attend_session",
         "accompany", "listen", "think", "face", "perform")
CHANNELS = ("voice", "mouth", "eyes", "head", "left_hand", "right_hand", "full_body", "contact")
EXITS = ("focus_change", "session_state", "speech_start", "speech_end", "user_typing", "target_gone", "user_drag")
TRIGGERS = ("tick", "session", "user", "speech", "receipt", "agent", "decision")
CANCEL_REASONS = ("replaced", "switch_off", "fullscreen", "turn_cancelled", "expired", "exit", "character_switch")
# exit condition agentd judges (behavior_cancel / exit) -> the renderer's receipt after it
EXIT_RECEIPTS = {"speech_start": "cancelled", "speech_end": "completed", "session_state": "completed",
                 "focus_change": "completed", "user_typing": "cancelled"}
PHASES = ("prepared", "rejected", "running", "completed", "blocked", "cancelled", "expired")
ENDED = ("rejected", "completed", "blocked", "cancelled", "expired")  # phases after which a behavior no longer runs
PHASE_REASONS = {"rejected": ("stale", "busy", "unsupported", "switch_off", "target_gone"),
                 "blocked": ("target_gone", "no_room", "path_blocked")}
SWITCHES = ("stay_in_place", "sit_window_top", "hold_window_edge", "fullscreen_give_way")  # PUT /behavior/switches
OPTIONAL_SWITCHES = ("bust_framing", "hold_free_walks")  # PUT /behavior/switches may add these; absent is false
BUST_HELD = ("sit", "hold_window_edge", "face")  # never sent in the bust framing, beside MOVING
TYPING_MAX = 0.3  # intensity cap while the user types
# type -> target kinds it accepts; None in the tuple means no target
TARGETS = {"idle": (None,), "observe": ("window", "point", None), "short_walk": ("window", "point", "edge", None),
           "sit": ("window", "object", None), "hold_window_edge": ("window",), "climb_window_top": ("window",),
           "attend_session": ("session",), "accompany": (None,), "listen": ("user", None), "think": (None,), "face": (None,),
           "perform": (None,)}
MOVING = ("short_walk", "climb_window_top")  # never sent while the user types
VARIANTS = ("still", "read", "tea", "ground", "rest")  # sit only; null or absent is the plain sit
TEXT_HOLD_MAX = 3000  # ms: the longest hold_ms of an ended text_line
MOTION_ID = re.compile(r"gm-[0-9a-f]{16}")
SHA256 = re.compile(r"[0-9a-f]{64}")
MOTION_LENGTH = (0.2, 10)  # s: length_s of a perform's motion or action
ACTION_ID_MAX = 64  # bytes: the id of a perform's game action
REQUEST_ID = re.compile(r"mr-[0-9a-f]{16}")
MOTION_REASONS = ("timeout", "no_service", "busy", "failed", "game_backend")  # a failed motion event
BEHAVIOR_ID_MAX = 64  # bytes: the behavior_id of a motion request
EDGE_SIDES = ("nearest", "left", "right")  # a short_walk's edge target
PAYLOADS = ("motion", "action", "clip")  # a perform carries exactly one
PLAY_FIELDS = ("layer", "start", "blend_s", "loop", "ttl_s", "within")  # how a perform plays; only on perform
LAYER_CHANNELS = {"base": ["full_body"], "overlay": ["head", "left_hand", "right_hand"]}
# behaviors that drive the whole body themselves; a clip perform (`perform` with `clip`) shares channels with every
# other behavior, which only aims her (v2.7)
EXECUTORS = ("short_walk", "sit", "hold_window_edge", "climb_window_top", "perform")


def contends(a, b):
    """Whether two behaviors compete for their channels: a clip perform only with another perform or an EXECUTORS one,
    and never with the behavior it plays within."""
    if "within" in a and a["within"] == b.get("behavior_id") or "within" in b and b["within"] == a.get("behavior_id"):
        return False
    clip = lambda m: m.get("type") == "perform" and "clip" in m
    if clip(a) == clip(b):
        return True
    return (b if clip(a) else a).get("type") in EXECUTORS
STARTS = ("now", "sync", "cycle_end", "after_exit")
BLEND_S = (0, 2)
TTL_S = (0.5, 120)
CLIP_ID_MAX = 64  # bytes: a clip id of the character's motion metadata
CANCEL_MODES = ("abort", "fade_out")
FADE_S = (0.05, 2)
REACTION_TRIGGERS = ("click", "pat", "pinch", "drag_lift", "drop", "attention_left", "attention_right", "point_at",
                     "present", "hover", "click_head", "click_cheek", "click_hand", "click_repeat", "pinch_annoyed")
HOLD_TRIGGERS = ("pat", "present", "drag_lift", "attention_left", "attention_right")  # triggers with an end to hold for
STROKE_TRIGGERS = ("present",)
ENDED_TRIGGERS = ("pat", "present")  # triggers a player fixture's local step may end
CHAIN_MAX = 8  # clips a reaction entry's chain plays after its clip
WITHIN = ("sit", "climb_window_top")  # behaviors a base clip perform may play within
STAGE_LEVELS = ("offstage", "quiet", "normal", "engaged")
CONSUMED_MAX = 64
OCCURRENCE_ID_MAX = 64  # bytes
MOTION_STATE_PHASES = ("started", "cycle_end", "ended", "expired", "rejected")
ORIGINS = ("agent", "local", "user")
USER_PHASES = ("started", "ended", "expired", "rejected")  # a user play or pose scene sends no cycle_end
MOTION_STATE_KEYS = {"behavior_id", "origin", "phase", "resting", "busy"}  # C3 motion_state without its clip
PLAYER_KEYS = {"name", "character", "steps", "expect"}  # and the optional poses


def _int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _str_or_none(value):
    return value is None or isinstance(value, str) and value != ""


def _short_str(value, limit):
    return isinstance(value, str) and value != "" and len(value.encode()) <= limit


def _number_in(value, bounds):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and bounds[0] <= value <= bounds[1]


def _target(message):
    target, kind = message["target"], None
    problems = []
    if target is not None:
        if not isinstance(target, dict):
            return ["target is not an object"]
        kind = target.get("kind")
        if kind == "window":
            if not _int(target.get("window_id")) or target.get("side") not in ("left", "right", None):
                problems.append("window target needs window_id and side left/right/null")
            if message["type"] == "hold_window_edge" and target.get("side") is None:
                problems.append("hold_window_edge needs a side")
        elif kind == "session":
            window_id = target.get("window_id", "missing")
            if not isinstance(target.get("display_session"), str) or not (window_id is None or _int(window_id)):
                problems.append("session target needs display_session and window_id (int or null)")
        elif kind == "point":
            if not all(isinstance(target.get(k), (int, float)) for k in ("x", "y")) or not _int(target.get("display_id")):
                problems.append("point target needs x, y and display_id")
        elif kind == "object":
            if not _str_or_none(target.get("object_id", 0)):
                problems.append("object target needs object_id (string, or null: the host picks)")
        elif kind == "edge":
            if target.get("side") not in EDGE_SIDES:
                problems.append(f"edge target needs side, one of {EDGE_SIDES}")
        elif kind != "user":
            problems.append(f"unknown target kind {kind!r}")
    if kind not in TARGETS.get(message["type"], ()):
        problems.append(f"{message['type']} does not take target {kind!r}")
    return problems


def _motion(motion):
    """Problems with a perform's motion object."""
    if not isinstance(motion, dict):
        return ["perform needs a motion object"]
    problems = []
    if not isinstance(motion.get("id"), str) or not MOTION_ID.fullmatch(motion["id"]):
        problems.append("motion.id is gm- and 16 lowercase hex characters")
    for key in ("meta_sha256", "keys_sha256", "rig_sha256"):
        if not isinstance(motion.get(key), str) or not SHA256.fullmatch(motion[key]):
            problems.append(f"motion.{key} is 64 lowercase hex characters")
    length = motion.get("length_s")
    if isinstance(length, bool) or not isinstance(length, (int, float)) \
            or not MOTION_LENGTH[0] <= length <= MOTION_LENGTH[1]:
        problems.append(f"motion.length_s is a number in {MOTION_LENGTH[0]}-{MOTION_LENGTH[1]}")
    return problems


def _action(action):
    """Problems with a perform's game action object."""
    if not isinstance(action, dict):
        return ["action is an object"]
    problems = []
    if not isinstance(action.get("id"), str) or not action["id"] or len(action["id"].encode()) > ACTION_ID_MAX:
        problems.append(f"action.id is a string of 1-{ACTION_ID_MAX} bytes")
    length = action.get("length_s")
    if isinstance(length, bool) or not isinstance(length, (int, float)) \
            or not MOTION_LENGTH[0] <= length <= MOTION_LENGTH[1]:
        problems.append(f"action.length_s is a number in {MOTION_LENGTH[0]}-{MOTION_LENGTH[1]}")
    return problems


def _clip(clip):
    """Problems with a perform's clip object: one clip of the character's motion metadata."""
    if not isinstance(clip, dict) or not _short_str(clip.get("id"), CLIP_ID_MAX):
        return [f"clip is {{id}}, a string of 1-{CLIP_ID_MAX} bytes"]
    return []


def _play(m):
    """Problems with how a perform plays: its layer and that layer's channels, start, blend, loop and ttl."""
    layer = m.get("layer", "base")
    if layer not in LAYER_CHANNELS:
        return [f"layer is one of {tuple(LAYER_CHANNELS)}"]
    problems = []
    if m.get("channels") != LAYER_CHANNELS[layer]:
        problems.append(f"a perform on layer {layer} uses channels {LAYER_CHANNELS[layer]}")
    if m.get("start", "now") not in STARTS:
        problems.append(f"start is one of {STARTS}")
    if "blend_s" in m and not _number_in(m["blend_s"], BLEND_S):
        problems.append(f"blend_s is a number in {BLEND_S[0]}-{BLEND_S[1]}")
    if "loop" in m and (not isinstance(m["loop"], bool) or layer != "base"):
        problems.append("loop is true or false, and only on a base perform")
    if "ttl_s" in m and not _number_in(m["ttl_s"], TTL_S):
        problems.append(f"ttl_s is a number in {TTL_S[0]}-{TTL_S[1]}")
    if "within" in m and (not _short_str(m["within"], BEHAVIOR_ID_MAX) or layer != "base" or "clip" not in m):
        problems.append(f"within is a behavior_id of 1-{BEHAVIOR_ID_MAX} bytes, and only on a base clip perform")
    return problems


def _motion_event(m):
    """Problems with an `event: motion`, the answer to a host's motion request."""
    problems = []
    if not isinstance(m.get("request_id"), str) or not REQUEST_ID.fullmatch(m["request_id"]):
        problems.append("request_id is mr- and 16 lowercase hex characters")
    behavior_id = m.get("behavior_id")
    if not isinstance(behavior_id, str) or not behavior_id or len(behavior_id.encode()) > BEHAVIOR_ID_MAX:
        problems.append(f"behavior_id is a string of 1-{BEHAVIOR_ID_MAX} bytes")
    if m.get("ok") is True:
        problems += _motion(m.get("motion"))
        if isinstance(m.get("motion"), dict) and (not isinstance(m["motion"].get("tracks_sha256"), str)
                                                  or not SHA256.fullmatch(m["motion"]["tracks_sha256"])):
            problems.append("motion.tracks_sha256 is 64 lowercase hex characters")
        if "reason" in m:
            problems.append("reason comes with ok false only")
    elif m.get("ok") is False:
        if m.get("reason") not in MOTION_REASONS:
            problems.append(f"a failed motion's reason is one of {MOTION_REASONS}")
        if "motion" in m:
            problems.append("a failed motion has no motion object")
    else:
        problems.append("ok is true or false")
    return problems


def _behavior(m):
    problems = []
    if m.get("type") not in TYPES:
        return [f"unknown type {m.get('type')!r}"]
    if m['type'] == 'face':
        yaw = m.get('facing_yaw')
        if isinstance(yaw,bool) or not isinstance(yaw,(int,float)) or not math.isfinite(yaw) or not -180 <= yaw <= 180:
            problems.append('face needs finite facing_yaw in -180...180')
        if m.get('channels') != ['full_body']:
            problems.append('face uses full_body only')
    elif m.get('facing_yaw') is not None:
        problems.append('facing_yaw is only valid on face')
    if m["type"] == "perform":
        payloads = [k for k in PAYLOADS if k in m]
        if len(payloads) > 1:
            problems.append(f"perform carries exactly one of {PAYLOADS}")
        elif payloads == ["action"]:
            problems += _action(m["action"])
        elif payloads == ["clip"]:
            problems += _clip(m["clip"])
        else:
            problems += _motion(m.get("motion"))
        problems += _play(m)
    elif any(k in m for k in PAYLOADS + PLAY_FIELDS):
        problems.append(f"{PAYLOADS + PLAY_FIELDS} are only valid on perform")
    if not isinstance(m.get("behavior_id"), str) or not m["behavior_id"]:
        problems.append("behavior_id")
    problems += _target(m)
    if m.get("variant") is not None and (m["type"] != "sit" or m["variant"] not in VARIANTS):
        problems.append(f"variant is one of {VARIANTS} or null, and only on sit")
    trigger = m.get("trigger")
    if not isinstance(trigger, dict) or trigger.get("source") not in TRIGGERS or not _str_or_none(trigger.get("event")):
        problems.append("trigger needs a known source and an event string or null")
    if not _str_or_none(m.get("display_session")) or not _str_or_none(m.get("turn_id")):
        problems.append("display_session and turn_id are strings or null")
    if m["type"] == "attend_session" and m.get("display_session") != (m.get("target") or {}).get("display_session"):
        problems.append("attend_session names its session in display_session and target")
    if not _int(m.get("priority")) or not 0 <= m["priority"] <= 3:
        problems.append("priority is 0-3")
    if not _int(m.get("expires_at_ms")):
        problems.append("expires_at_ms")
    intensity = m.get("intensity")
    if not isinstance(intensity, (int, float)) or isinstance(intensity, bool) or not 0.0 <= intensity <= 1.0:
        problems.append("intensity is 0.0-1.0")
    channels = m.get("channels")
    if not isinstance(channels, list) or not channels or any(c not in CHANNELS for c in channels) \
            or len(set(channels)) != len(channels):
        problems.append("channels: a non-empty list of known channels, each once")
    exits = m.get("exit")
    if not isinstance(exits, list) or any(e not in EXITS for e in exits):
        problems.append("exit: a list of known exit conditions")
    if not _str_or_none(m.get("replaces")) or not isinstance(m.get("trace_id"), str):
        problems.append("replaces is a behavior_id or null; trace_id is a string")
    if (m.get("trigger") or {}).get("event") == "typing" and isinstance(intensity, (int, float)) \
            and (intensity > TYPING_MAX or m["type"] in MOVING):
        problems.append("while the user types: intensity <= 0.3 and no walking or climbing")
    return problems


def _cancel(m):
    if not isinstance(m.get("behavior_id"), str) or m.get("reason") not in CANCEL_REASONS:
        return ["behavior_cancel needs behavior_id and a known reason"]
    if m["reason"] == "exit" and m.get("condition") not in EXIT_RECEIPTS:
        return [f"an exit cancel names a condition agentd judges: one of {tuple(EXIT_RECEIPTS)}"]
    if m["reason"] != "exit" and "condition" in m:
        return ["condition comes with reason exit only"]
    if m.get("mode", "abort") not in CANCEL_MODES:
        return [f"mode is one of {CANCEL_MODES}"]
    if "fade_s" in m and (m.get("mode") != "fade_out" or not _number_in(m["fade_s"], FADE_S)):
        return [f"fade_s is a number in {FADE_S[0]}-{FADE_S[1]} and comes with mode fade_out only"]
    return []


def _clause_intent(m):
    problems = []
    if m.get("intent") not in INTENTS:
        problems.append(f"unknown intent {m.get('intent')!r}")
    if not isinstance(m.get("line_id"), str) or not isinstance(m.get("trace_id"), str):
        problems.append("line_id and trace_id")
    utterance, clause, revision = m.get("utterance_id"), m.get("clause_id"), m.get("spoken_text_revision", "missing")
    voiced = (utterance is not None, clause is not None, revision is not None)
    if not (_str_or_none(utterance) and _str_or_none(clause)) or len(set(voiced)) != 1 \
            or revision is not None and not (_int(revision) and revision >= 1):
        problems.append("utterance_id, clause_id and spoken_text_revision (int >= 1) are all set (voiced) "
                        "or all null (text only)")
    return problems


def _text_line(m):
    problems = []
    if not isinstance(m.get("line_id"), str) or not m["line_id"] or not isinstance(m.get("trace_id"), str):
        problems.append("line_id and trace_id")
    state, hold = m.get("state"), m.get("hold_ms", "missing")
    if state not in ("started", "ended"):
        problems.append("state is started or ended")
    elif state == "started" and hold != "missing":
        problems.append("hold_ms comes with ended only")
    elif state == "ended" and not (_int(hold) and 0 <= hold <= TEXT_HOLD_MAX):
        problems.append(f"an ended text_line holds 0-{TEXT_HOLD_MAX} ms")
    return problems


def _session_reaction(m):
    if not isinstance(m.get("display_session"), str) or m.get("state") not in ("done", "error"):
        return ["session_reaction needs display_session and state done or error"]
    if "occurrence_id" in m and not _short_str(m["occurrence_id"], OCCURRENCE_ID_MAX):
        return [f"occurrence_id is a string of 1-{OCCURRENCE_ID_MAX} bytes"]
    return []


def _receipt(m):
    problems = []
    phase = m.get("phase")
    if not isinstance(m.get("behavior_id"), str) or phase not in PHASES:
        return ["receipt needs behavior_id and a known phase"]
    if phase in PHASE_REASONS and m.get("reason") not in PHASE_REASONS[phase]:
        problems.append(f"{phase} reason must be one of {PHASE_REASONS[phase]}")
    if phase not in PHASE_REASONS and not _str_or_none(m.get("reason")):
        problems.append("reason is a string or null")
    for reason in ("connection_lost", "user_play"):
        if m.get("reason") == reason and phase != "cancelled":
            problems.append(f"{reason} is a reason of cancelled only")
    if not _int(m.get("at_ms")) or not _int(m.get("turn_generation")):
        problems.append("at_ms and turn_generation")
    return problems


def _reactions(reactions):
    """Problems with a snapshot's reaction table: trigger -> the clips the renderer picks from by weight."""
    if not isinstance(reactions, dict) or not set(reactions) <= set(REACTION_TRIGGERS):
        return [f"reactions maps triggers among {REACTION_TRIGGERS} to their clips"]
    problems = []
    for trigger, choices in reactions.items():
        if not isinstance(choices, list) or not choices \
                or not all(isinstance(c, dict) and _short_str(c.get("clip"), CLIP_ID_MAX) and c.get("layer") in LAYER_CHANNELS
                           and _number_in(c.get("weight"), (0, math.inf)) and c["weight"] > 0 for c in choices):
            problems.append(f"reactions.{trigger}: a non-empty list of {{clip, weight > 0, layer}}")
        else:
            problems += [p for c in choices for p in _entry(trigger, c)]
    return problems


def _entry(trigger, c):
    """Problems with a reaction entry's chain, held loop, timed loops and stroke times (v2.8). Whether a clip loops is
    in the character's pack, which the checker does not read."""
    problems, chain = [], c.get("chain", [])
    if not isinstance(chain, list) or "chain" in c and not 1 <= len(chain) <= CHAIN_MAX \
            or not all(_short_str(x, CLIP_ID_MAX) for x in chain):
        problems.append(f"reactions.{trigger}: chain is a list of 1-{CHAIN_MAX} clip ids")
        chain = []
    clips = [c["clip"]] + chain
    if "hold" in c and (trigger not in HOLD_TRIGGERS or c["hold"] not in clips):
        problems.append(f"reactions.{trigger}: hold is its clip or one of its chain, and only on {HOLD_TRIGGERS}")
    timed = c.get("hold_s", {})
    if "hold_s" in c and (not isinstance(timed, dict) or not all(
            k in clips and k != c.get("hold") and _number_in(v, (0, math.inf)) and v > 0 for k, v in timed.items())):
        problems.append(f"reactions.{trigger}: hold_s maps its clip and chain but the hold to seconds > 0")
    stroke = c.get("stroke_s", {})
    if "stroke_s" in c and (trigger not in STROKE_TRIGGERS or not isinstance(stroke, dict)
                            or not all(k in clips and _number_in(v, (0, math.inf)) for k, v in stroke.items())):
        problems.append(f"reactions.{trigger}: stroke_s maps its clip and chain to seconds >= 0, only on "
                        f"{STROKE_TRIGGERS}")
    return problems


def _snapshot(m):
    behaviors = m.get("behaviors")
    if "behavior" in m or not isinstance(behaviors, list) or not all(isinstance(b, dict) for b in behaviors):
        return ["snapshot needs behaviors: every running behavior, [] when none"]
    problems = [f"behaviors[{n}]: {p}" for n, b in enumerate(behaviors)
                for p in check_message({**b, "event": "behavior"})]
    if "reactions" in m:
        problems += _reactions(m["reactions"])
    stage = m.get("stage", {"level": "normal", "revision": 0})
    if not isinstance(stage, dict) or stage.get("level") not in STAGE_LEVELS or not _int(stage.get("revision")) \
            or stage["revision"] < 0:
        problems.append(f"stage is {{level, revision}}: level one of {STAGE_LEVELS}, revision an int >= 0")
    consumed = m.get("consumed", [])
    if not isinstance(consumed, list) or len(consumed) > CONSUMED_MAX \
            or not all(_short_str(o, OCCURRENCE_ID_MAX) for o in consumed):
        problems.append(f"consumed is a list of at most {CONSUMED_MAX} occurrence ids, "
                        f"each a string of 1-{OCCURRENCE_ID_MAX} bytes")
    return problems


def check_switches(body):
    """Problems with a PUT /behavior/switches body: every switch and any optional one, each a boolean, nothing else."""
    if not isinstance(body, dict) or not set(SWITCHES) <= set(body) <= set(SWITCHES + OPTIONAL_SWITCHES) \
            or any(not isinstance(v, bool) for v in body.values()):
        return [f"switches are exactly {SWITCHES}, optionally {OPTIONAL_SWITCHES}, each true or false"]
    return []


CHECKS = {"snapshot": _snapshot, "behavior": _behavior, "behavior_cancel": _cancel, "clause_intent": _clause_intent,
          "text_line": _text_line, "motion": _motion_event, "session_reaction": _session_reaction, "receipt": _receipt}


def check_message(message):
    """Problems with one message, [] when it is a valid C1 message."""
    check = CHECKS.get(message.get("event")) if isinstance(message, dict) else None
    if check is None:
        return [f"unknown event {message.get('event') if isinstance(message, dict) else message!r}"]
    problems = check(message)
    if message["event"] != "receipt":
        if not _int(message.get("seq")):
            problems.append("seq")
        if message["event"] != "motion" and not _int(message.get("turn_generation")):
            problems.append("turn_generation")
    return problems


def _receipt_fits(receipt, behavior, renewal, last_phase):
    """Problems with a receipt against the behavior it answers."""
    if behavior is None:
        return []
    problems, phase, at, end = [], receipt.get("phase"), receipt.get("at_ms"), behavior.get("expires_at_ms")
    if _int(at) and _int(end):
        if phase == "expired" and at < end and "ttl_s" not in behavior:
            problems.append("expired before expires_at_ms")
        if phase != "expired" and at > end:
            problems.append(f"{phase} after expires_at_ms; the behavior expired first")
    if renewal and last_phase is None and phase != "running":
        problems.append("a renewal has no entry motion: its first receipt is running")
    target = behavior.get("target") or {}
    gaze = bool(behavior.get("channels")) and set(behavior["channels"]) <= {"eyes", "head"}  # attend_session@user
    if target.get("kind") == "session" and target.get("window_id") is None and not gaze \
            and (phase in ("running", "completed") or phase == "blocked" and receipt.get("reason") != "target_gone"):
        problems.append("a session target without window_id ends blocked / target_gone")
    if receipt.get("turn_generation") != behavior.get("turn_generation"):
        problems.append("a receipt carries its behavior's turn_generation")
    return problems


def _activity(behavior):
    """What a behavior does, for the renewal rule: its type and target, and a perform's layer and payload too."""
    key = [behavior.get("type"), behavior.get("target")]
    if behavior.get("type") == "perform":
        key += [behavior.get("layer", "base")] + [behavior.get(k) for k in PAYLOADS]
    return json.dumps(key, sort_keys=True)


def check_file(data):
    """Problems with one fixture file {description, messages}: each message, seq order, known behavior_ids."""
    if not isinstance(data, dict) or not isinstance(data.get("description"), str) \
            or not isinstance(data.get("messages"), list) or not data["messages"]:
        return ["a fixture is {description, messages: [...]}"]
    problems, seen, last = [], set(), None
    running = {}  # behavior_id -> (type, target) of behaviors no receipt or cancel has ended
    phases = {}  # behavior_id -> its last receipt phase
    clauses = set()  # (utterance_id, clause_id, spoken_text_revision) that already have a clause_intent
    sent = {}  # behavior_id -> its behavior message
    renewals = set()  # behavior_ids that renew a running behavior of the same type and target
    exited = {}  # behavior_id -> the condition of its behavior_cancel / exit
    for i, message in enumerate(data["messages"]):
        problems += [f"#{i}: {p}" for p in check_message(message)]
        if not isinstance(message, dict):
            continue
        if "seq" in message and message["event"] != "receipt":
            if last is not None and message["seq"] <= last:
                problems.append(f"#{i}: seq does not increase")
            last = message["seq"]
        resumed = message.get("behaviors") if message.get("event") == "snapshot" else None
        if isinstance(resumed, list):
            running.clear()  # a snapshot lists every running behavior
        for behavior in resumed if isinstance(resumed, list) else ():
            if isinstance(behavior, dict) and phases.get(behavior.get("behavior_id")) in ENDED:
                problems.append(f"#{i}: snapshot resumes an ended behavior; renew it under a new behavior_id")
            if isinstance(behavior, dict):  # a resumed behavior counts as sent
                sent[behavior.get("behavior_id")] = behavior
                seen.add(behavior.get("behavior_id"))
                running[behavior.get("behavior_id")] = _activity(behavior)
        if message.get("event") == "behavior":
            if "within" in message and not (message["within"] in running
                                            and sent.get(message["within"], {}).get("type") in WITHIN):
                problems.append(f"#{i}: within names no running behavior of {WITHIN}")
            key = _activity(message)
            same = [b for b, k in running.items() if k == key and b != message.get("replaces")]
            if same:
                problems.append(f"#{i}: {same[0]} with the same type and target still runs; renew it with replaces")
            if running.get(message.get("replaces")) == key and \
                    sent.get(message.get('replaces'),{}).get('facing_yaw') == message.get('facing_yaw'):
                renewals.add(message.get("behavior_id"))
            for b in [b for b in running if message.get("replaces") and sent.get(b, {}).get("within") == message["replaces"]]:
                del running[b]  # a clip within a sit or climb ends when it is replaced
            channels = set(message.get("channels") or ())
            displaced = [b for b in running if b != message.get("replaces") and contends(sent.get(b, {}), message)
                         and channels & set(sent.get(b, {}).get("channels") or ())]
            if displaced:
                problems.append(f"#{i}: overlaps {displaced[0]}; name it in replaces or cancel it (replaced) first")
            sent[message.get("behavior_id")] = message
            running.pop(message.get("replaces"), None)
            running[message.get("behavior_id")] = key
            seen.add(message.get("behavior_id"))
        elif message.get("event") in ("receipt", "behavior_cancel") and message.get("behavior_id") not in seen:
            problems.append(f"#{i}: behavior_id {message.get('behavior_id')!r} was not sent before")
        elif message.get("event") == "behavior_cancel" or message.get("phase") in ENDED:
            running.pop(message.get("behavior_id"), None)
            for b in [b for b in running if sent.get(b, {}).get("within") == message.get("behavior_id")]:
                del running[b]  # a clip within a sit or climb ends with it
        if message.get("event") == "behavior_cancel" and message.get("reason") == "exit":
            if message.get("condition") not in (sent.get(message.get("behavior_id")) or {}).get("exit", ()):
                problems.append(f"#{i}: condition {message.get('condition')!r} is not in the behavior's exit")
            exited[message.get("behavior_id")] = message.get("condition")
        if message.get("event") == "clause_intent" and message.get("clause_id") is not None:
            key = tuple(message.get(k) for k in ("utterance_id", "clause_id", "spoken_text_revision"))
            if key in clauses:
                problems.append(f"#{i}: a second clause_intent for {key}; agentd sends at most one")
            clauses.add(key)
        if message.get("event") == "receipt":
            problems += [f"#{i}: {p}" for p in _receipt_fits(message, sent.get(message.get("behavior_id")),
                                                             message.get("behavior_id") in renewals,
                                                             phases.get(message.get("behavior_id")))]
            last_phase = phases.get(message.get("behavior_id"))
            condition = exited.get(message.get("behavior_id"))
            if condition in EXIT_RECEIPTS and message.get("phase") != EXIT_RECEIPTS[condition]:
                problems.append(f"#{i}: after an exit on {condition} the receipt is {EXIT_RECEIPTS[condition]}")
            if last_phase is None and message.get("phase") not in ("prepared", "running", "rejected"):
                problems.append(f"#{i}: the first receipt of a behavior is prepared, running or rejected")
            if last_phase in ENDED:
                problems.append(f"#{i}: a receipt after the terminal phase {last_phase}")
            phases[message.get("behavior_id")] = message.get("phase")
    return problems


def _expected_state(state, sent):
    """Problems with an expected motion_state (C3 motion_state without clip) against the behaviors the steps sent."""
    if not isinstance(state, dict) or set(state) != MOTION_STATE_KEYS:
        return [f"motion_state is exactly {sorted(MOTION_STATE_KEYS)}; a fixture leaves out the clip"]
    problems = []
    if state["origin"] not in ORIGINS:
        problems.append(f"origin is one of {ORIGINS}")
    if state["behavior_id"] is None and state["origin"] == "agent":
        problems.append("a null behavior_id is a local reaction's or a user play's")
    elif state["behavior_id"] is not None and state["origin"] in ("local", "user"):
        problems.append("a local reaction's or a user play's behavior_id is null")
    elif state["behavior_id"] is not None and state["behavior_id"] not in sent:
        problems.append(f"behavior_id {state['behavior_id']!r} was not sent in a step")
    if state["phase"] not in (USER_PHASES if state["origin"] == "user" else MOTION_STATE_PHASES):
        problems.append(f"phase is one of {MOTION_STATE_PHASES}, a user play's one of {USER_PHASES}")
    if not isinstance(state["resting"], bool) or not isinstance(state["busy"], bool):
        problems.append("resting and busy are true or false")
    return problems


def check_player_fixture(data):
    """Problems with one player fixture {name, character, steps, expect, poses?}: timed C1 messages and local inputs
    go in, the renderer's motion_state sequence comes out."""
    if not isinstance(data, dict) or not PLAYER_KEYS <= set(data) <= PLAYER_KEYS | {"poses"} \
            or not isinstance(data["name"], str) or not data["name"] or not _str_or_none(data["character"]) \
            or not isinstance(data["steps"], list) or not data["steps"] \
            or not isinstance(data["expect"], list) or not data["expect"]:
        return ["a player fixture is {name, character, steps: [...], expect: [...]}, optionally poses"]
    problems = [] if data.get("poses", []) == [] else ["poses is [] until pose expectations are defined"]
    messages, at = [], 0
    for i, step in enumerate(data["steps"]):
        if not isinstance(step, dict) or set(step) not in ({"t_ms", "c1"}, {"t_ms", "local"}) \
                or not _int(step["t_ms"]) or step["t_ms"] < at:
            problems.append(f"step {i}: {{t_ms, c1}} or {{t_ms, local}}, t_ms an int >= 0 that does not decrease")
            continue
        at = step["t_ms"]
        if "local" in step:
            local = step["local"]
            if not isinstance(local, dict) or set(local) not in ({"input"}, {"input", "end"}) \
                    or local["input"] not in REACTION_TRIGGERS \
                    or "end" in local and (local["end"] is not True or local["input"] not in ENDED_TRIGGERS):
                problems.append(f"step {i}: local is {{input}}, one of {REACTION_TRIGGERS}, or {{input, end: true}} "
                                f"for one of {ENDED_TRIGGERS}")
        elif not isinstance(step["c1"], dict) or step["c1"].get("event") == "receipt":
            problems.append(f"step {i}: c1 is a message agentd sends")
        else:
            messages.append(step["c1"])
    if messages:
        problems += [f"c1 {p}" for p in check_file({"description": data["name"], "messages": messages})]
    sent = set()
    for message in messages:
        resumed = message.get("behaviors") if message.get("event") == "snapshot" else None
        for behavior in [message] if message.get("event") == "behavior" else resumed if isinstance(resumed, list) else ():
            if isinstance(behavior, dict):
                sent.add(behavior.get("behavior_id"))
    at = 0
    for i, expected in enumerate(data["expect"]):
        if not isinstance(expected, dict) or set(expected) != {"t_ms_max", "motion_state"} \
                or not _int(expected["t_ms_max"]) or expected["t_ms_max"] < at:
            problems.append(f"expect {i}: {{t_ms_max, motion_state}}, t_ms_max an int >= 0 that does not decrease")
            continue
        at = expected["t_ms_max"]
        problems += [f"expect {i}: {p}" for p in _expected_state(expected["motion_state"], sent)]
    return problems


def main(folder):
    paths = sorted(Path(folder).glob("*.json"))
    if not paths:
        print(f"{folder}: no *.json fixture to check")
        return 1
    failed = False
    for path in paths:
        try:
            problems = check_file(json.loads(path.read_text(encoding="utf-8")))
        except ValueError as error:
            problems = [f"invalid JSON: {error}"]
        print(f"{path.name}: {'OK' if not problems else '; '.join(problems)}")
        failed = failed or bool(problems)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
