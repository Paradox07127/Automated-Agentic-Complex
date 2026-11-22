#!/usr/bin/env python3
"""Validate C3 host IPC NDJSON (renderer <-> Companion).

No arguments: every examples/*.ndjson and examples/pending/*.ndjson must pass as a session, and every line file in
examples/invalid/ and examples/pending/invalid/ must be rejected. With --direction a2c|c2a FILE...: validate recorded sessions.
"""
import argparse
import json
import re
from pathlib import Path
import sys

MAX_LINE = 65536
TIERS = {"interactive": 60, "working": 30, "idle": 15, "sleep": 5, "paused": 0}
MAX_CAPSULES = 64
SPEECH_CANCEL_REASONS = {"client_cancel", "playback_failed"}
CHARACTER_CHANGE_FAILED_REASONS = {"switching", "unknown_character", "pack_rejected", "load_failed"}
APPEARANCE_CHANGE_FAILED_REASONS = {"superseded", "switching", "unknown_appearance", "load_failed"}
ACK_ERRORS = {"invalid", "busy", "unsupported", "failed"}
PLACEMENT_REASONS = {"start", "drag", "behavior", "set_placement"}
PLAYBACK_STATES = {"started", "buffering", "resumed", "ended", "interrupted", "failed", "degraded"}
BEHAVIOR_PHASES = {"prepared", "rejected", "running", "completed", "blocked", "cancelled", "expired"}
MOTION_STATE_PHASES = {"started", "cycle_end", "ended", "expired", "rejected"}
MOTION_STATE_ORIGINS = {"agent", "local", "user"}
USER_MOTION_PHASES = MOTION_STATE_PHASES - {"cycle_end"}
MAX_TRACE_EVENTS = 50
MAX_ACTIONS = 128
ACTION_SECTIONS = {"talk", "react", "idle", "move", "touch", "battle"}
ACTIONS_ERRORS = {"not_ready", "too_large"}
SWITCHES_ERRORS = {"wrong_character", "switching", "not_ready"}
ADJUSTED_REASONS = {"required", "missing", "last_in_section"}
PLAY_PHASES = {"started", "completed", "interrupted", "rejected"}
PLAY_REJECTED = {"missing", "unknown_action", "not_playable", "wrong_character", "releasing", "switching", "busy"}
PLAY_INTERRUPTED = {"character_switch", "superseded", "behavior", "drag", "connection_lost", "stopped"}
PLAY_SPEEDS = (0.5, 1, 2)
MAX_COORD = 100000
MAX_STRING = 256
MAX_ID = 64
ID_FIELDS = ("id", "speech_id", "nudge_id", "behavior_id", "play_id", "track_id", "token")
MAX_SURFACE_WINDOWS = 32
SURFACE_SIDES = ("top", "left", "right")
SURFACE_GONE = {"closed", "generation", "not_listed", "too_many"}
MAX_ABOVE = 8
MAX_PASS_THROUGH = 8
MAX_KEEP_CLEAR = 8
KEEP_CLEAR_KINDS = {"text_input", "caret", "control", "dialog", "banner", "ime", "near_clicks", "video", "game"}
PIPELINE_FIELDS = ("renderer", "bundle_sha256", "character", "appearance", "appearance_fallback", "render", "fps",
                   "suspended", "gpu", "frames", "clip", "error")
PIPELINE_OUTLINES = {"original", "subtle", "contrast"}
PIPELINE_SUSPENDED = {"system_sleep", "screen_sleep", "session_inactive", "switching"}
MAX_DROP_ITEMS = 16
MAX_DROP_TEXT = 16384
DROP_FIELDS = {"file": "path", "url": "url", "text": "text"}
ATTENTION_SOURCES = {"panel", "focus"}
SIDES = ("left", "right")
MAX_MOTION_REQUEST_LINE = 4096
MOTION_REQUEST_ID = re.compile(r"mr-[0-9a-f]{16}")
MOTION_GEOMETRY = {"turn": ("yaw",), "walk": ("to", "end_yaw"), "window_loop": ("hips",), "sit_enter": ("seat",),
                   "sit_loop": ("seat",), "sit_exit": ("seat",), "lean": ("hand", "grip")}
CAMERA_MODES = ("show", "overview", "document")
FACING_MODES = ("auto", "front", "side", "back")
GROUNDING_MODES = ("off", "contact")
AMBIENT_MODES = ("off", "wallpaper", "screen")
AMBIENT_SOURCES = ("screen", "wallpaper", "appearance")
AMBIENT_REGIONS = ("mean", "top", "bottom", "left", "right")
TOUCH_REGIONS = {"head_top", "head", "face", "cheek_l", "cheek_r", "hair", "accessory", "chest", "waist", "arm",
                 "hand_l", "hand_r", "leg", "skirt", "body"}
TOUCH_REGION = re.compile(r"[a-z_]{1,32}")
TOUCH_SETTINGS_FIELDS = ("regions", "pat", "pinch", "greet")
MEDIA_FIELDS = {"bgm", "face", "camera"}
LAYER_ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
MAX_LAYERS = 16
LAYERS_CHANGE_FAILED_REASONS = {"superseded", "switching", "unknown_layer", "load_failed"}
APPEARANCE_KINDS = {"original", "imported"}
MAX_APPEARANCE_DESC = 200
MAX_LAYER_NAME = 64
POSE_SLOTS = {"stand", "akimbo", "sit", "floor", "lie"}
CAMERA_TRACKS = ("off", "stage")
CLOSEUP_STATES = ("off", "active", "deferred")
CAMERA_FREE_FIELDS = ("zoom", "sway", "closeup", "live")
CAMERA_FRAMINGS = ("full", "bust")  # rule 49 (i), camera_bust
CAMERA_GESTURE_PHASES = ("began", "changed", "ended")
PHOTO_FILTERS = ("none", *(f"sp_filter_{i}" for i in range(1, 8)), *(f"filter_{i}" for i in range(1, 9)))
CAPTURE_BACKGROUNDS = ("transparent",)
DOF_MODES = ("off", "closeup")
MAX_OVERRIDE_CHAINS = 512
MAX_OVERRIDE_POOLS = 64
MAX_POOL_ITEMS = 64
MAX_OVERRIDE_BLEND_IN = 512
MAX_MOTION_KEY = 128
MAX_BLEND_IN_S = 2
OVERRIDE_LIMITS = {"chains": MAX_OVERRIDE_CHAINS, "pools": MAX_OVERRIDE_POOLS, "blend_in": MAX_OVERRIDE_BLEND_IN}
OVERRIDE_REASONS = {"chain": {"unknown_chain", "required"},
                    "pool": {"unknown_pool", "unknown_clip", "excluded_family", "no_return", "stance_mismatch"},
                    "blend_in": {"unknown_clip"}}
MAX_CAPABILITIES = 64
MOD_ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
MAX_MOD_VALUE = 255
MAX_MOD_SETTINGS = 64
MOD_ADJUSTED_REASONS = {"defaulted", "unsupported"}
REACTION_TRIGGERS = ("pat", "pinch", "greet")


def is_num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def is_int(x):
    return isinstance(x, int) and not isinstance(x, bool)


def point(p):
    return isinstance(p, list) and len(p) == 2 and all(is_num(c) for c in p)


def is_str(x):
    return isinstance(x, str) and bool(x)


def is_coord(x):
    return is_num(x) and abs(x) <= MAX_COORD


def is_pos_int(x):
    return is_int(x) and x > 0


def check_limits(m):
    """Rule 21: string lengths anywhere in the message, id fields at most 64 bytes; rule 38 bounds drop items itself."""
    errors = []

    def walk(v, path):
        if isinstance(v, str) and len(v.encode("utf-8")) > MAX_STRING:
            errors.append(f"{path}: string longer than {MAX_STRING} bytes")
        elif isinstance(v, dict):
            for k, x in v.items():
                walk(x, f"{path}.{k}")
        elif isinstance(v, list):
            for i, x in enumerate(v):
                walk(x, f"{path}[{i}]")
    for k, x in m.items():
        if not (m.get("type") == "drop" and k == "items"):
            walk(x, f"{m.get('type', 'message')}.{k}")
    for k in ID_FIELDS:
        if isinstance(m.get(k), str) and len(m[k].encode("utf-8")) > MAX_ID:
            errors.append(f"{m.get('type')}.{k} longer than {MAX_ID} bytes")
    return errors


def check_req(m, required=False):
    if "req" not in m:
        return [f"{m.get('type')}.req is required"] if required else []
    return [] if is_pos_int(m["req"]) else [f"{m.get('type')}.req must be a positive integer"]


def check_v9_hello(m):
    errors = []
    caps = m.get("capabilities")
    if not (isinstance(caps, list) and len(caps) <= MAX_CAPABILITIES and all(is_str(c) for c in caps) and len(set(caps)) == len(caps)):
        errors.append(f"hello.capabilities must be a list of at most {MAX_CAPABILITIES} distinct non-empty strings")
    if "build" in m:
        b = m["build"]
        if not (isinstance(b, dict) and is_str(b.get("git"))):
            errors.append("hello.build must be an object with a non-empty git")
        elif any(k in b and not is_str(b[k]) for k in ("version", "plugin")):
            errors.append("hello.build.version and plugin must be non-empty strings")
    return errors


def check_appearances(m, prefix):
    """Optional appearance + appearances: both or neither."""
    if "appearance" not in m and "appearances" not in m:
        return []
    if "appearance" not in m or "appearances" not in m:
        return [f"{prefix}.appearance and {prefix}.appearances must appear together"]
    lst = m["appearances"]
    if not (isinstance(lst, list) and lst):
        return [f"{prefix}.appearances must be a non-empty list"]
    if not all(isinstance(a, dict) and is_str(a.get("id")) and is_str(a.get("name")) for a in lst):
        return [f"{prefix}.appearances items need non-empty string id and name"]
    if any("kind" in a and a["kind"] not in APPEARANCE_KINDS for a in lst):
        return [f"{prefix}.appearances kind must be one of {sorted(APPEARANCE_KINDS)}"]
    if any("desc" in a and not (isinstance(a["desc"], str) and len(a["desc"].encode("utf-8")) <= MAX_APPEARANCE_DESC) for a in lst):
        return [f"{prefix}.appearances desc must be a string of at most {MAX_APPEARANCE_DESC} bytes"]
    if not is_str(m["appearance"]):
        return [f"{prefix}.appearance must be a non-empty string"]
    if m["appearance"] not in [a["id"] for a in lst]:
        return [f"{prefix}.appearance must be one of the appearances ids"]
    return []


def check_hidden_list(value, label):
    if not (isinstance(value, list) and len(value) <= MAX_LAYERS):
        return [f"{label} must be a list of at most {MAX_LAYERS} layer ids"]
    if not all(isinstance(x, str) and LAYER_ID_RE.fullmatch(x) for x in value):
        return [f"{label} items must match {LAYER_ID_RE.pattern}"]
    if len(set(value)) != len(value):
        return [f"{label} must not repeat an id"]
    return []


def check_layer_fields(m):
    """Optional layers + hidden_layers: both or neither; hidden_layers is a subset of the layer ids."""
    t = m.get("type")
    if "layers" not in m and "hidden_layers" not in m:
        return []
    if "layers" not in m or "hidden_layers" not in m:
        return [f"{t}.layers and {t}.hidden_layers must appear together"]
    lst = m["layers"]
    if not (isinstance(lst, list) and len(lst) <= MAX_LAYERS):
        return [f"{t}.layers must be a list of at most {MAX_LAYERS}"]
    for i, layer in enumerate(lst):
        if not (isinstance(layer, dict) and isinstance(layer.get("id"), str) and LAYER_ID_RE.fullmatch(layer["id"])):
            return [f"{t}.layers[{i}].id must match {LAYER_ID_RE.pattern}"]
        if not (is_str(layer.get("name")) and len(layer["name"].encode("utf-8")) <= MAX_LAYER_NAME):
            return [f"{t}.layers[{i}].name must be a string of 1-{MAX_LAYER_NAME} bytes"]
        if "appearances" in layer and not (isinstance(layer["appearances"], list) and layer["appearances"]
                                           and all(is_str(a) for a in layer["appearances"])):
            return [f"{t}.layers[{i}].appearances must be a non-empty list of non-empty strings"]
    ids = [layer["id"] for layer in lst]
    if len(set(ids)) != len(ids):
        return [f"{t}.layers ids must be unique"]
    errors = check_hidden_list(m["hidden_layers"], f"{t}.hidden_layers")
    if not errors and not set(m["hidden_layers"]) <= set(ids):
        errors.append(f"{t}.hidden_layers must be ids from {t}.layers")
    return errors


def check_hello(m, direction):
    role = "avatar" if direction == "a2c" else "companion"
    errors = [] if m.get("role") == role else [f"hello.role must be {role!r}"]
    if not (is_int(m.get("pid")) and m["pid"] > 0):
        errors.append("hello.pid must be a positive integer")
    if m.get("protocol") != 1:
        errors.append("hello.protocol must be 1")
    if direction == "a2c" and "character" in m and not (isinstance(m["character"], str) and m["character"]):
        errors.append("hello.character must be a non-empty string")
    if direction == "a2c":
        errors += check_appearances(m, "hello") + check_layer_fields(m)
    if direction == "c2a":
        caps = m.get("capabilities") if isinstance(m.get("capabilities"), list) else []
        if "trace_epoch" in m and not is_pos_int(m["trace_epoch"]):
            errors.append("hello.trace_epoch must be a positive integer")
        elif "trace" in caps and "trace_epoch" not in m:
            errors.append("hello.trace_epoch is required when the companion lists trace")
    return errors + check_v9_hello(m)


def check_window_frame(m, _):
    errors = []
    f = m.get("frame")
    if not (isinstance(f, dict) and all(is_num(f.get(k)) for k in ("x", "y", "w", "h"))):
        return ["window_frame.frame needs numeric x, y, w, h"]
    if f["w"] <= 0 or f["h"] <= 0:
        errors.append("window_frame.frame w and h must be > 0")
    if not (is_num(m.get("scale")) and m["scale"] > 0):
        errors.append("window_frame.scale must be > 0")
    if not (is_int(m.get("window_number")) and m["window_number"] > 0):
        errors.append("window_frame.window_number must be a positive integer")
    if "viewport" in m and m["viewport"] not in ("window", "fullscreen"):
        errors.append("window_frame.viewport must be 'window' or 'fullscreen'")
    if "display_id" in m and not is_pos_int(m["display_id"]):
        errors.append("window_frame.display_id must be a positive integer")
    return errors


def check_hit_capsules(m, _):
    errors = []
    if not (is_int(m.get("frame")) and m["frame"] >= 0):
        errors.append("hit_capsules.frame must be an integer >= 0")
    caps = m.get("capsules")
    if not isinstance(caps, list) or len(caps) > MAX_CAPSULES:
        return errors + [f"hit_capsules.capsules must be a list of at most {MAX_CAPSULES}"]
    for i, c in enumerate(caps):
        if not (isinstance(c, dict) and point(c.get("a")) and point(c.get("b"))):
            errors.append(f"capsule {i}: a and b must be [x, y]")
        elif not (is_num(c.get("r")) and 0 < c["r"] <= 10000):
            errors.append(f"capsule {i}: r must be > 0 and <= 10000")
        elif not all(is_coord(v) for v in c["a"] + c["b"]):
            errors.append(f"capsule {i}: coordinates must be within {MAX_COORD}")
    if "space" in m and m["space"] not in ("window", "global"):
        errors.append("hit_capsules.space must be 'window' or 'global'")
    for k in ("pose_revision", "submitted_frame"):
        if k in m and not (is_int(m[k]) and m[k] >= 0):
            errors.append(f"hit_capsules.{k} must be an integer >= 0")
    if "visual" in m:
        r = m["visual"]
        if m.get("space") != "global":
            errors.append("hit_capsules.visual needs space 'global'")
        elif not (isinstance(r, list) and len(r) == 4 and all(is_coord(v) for v in r) and r[2] > 0 and r[3] > 0):
            errors.append(f"hit_capsules.visual must be [x, y, w, h] within {MAX_COORD}, w and h > 0")
    return errors


def check_speech_cancelled(m, _):
    errors = [] if isinstance(m.get("speech_id"), str) and m["speech_id"] else ["speech_cancelled.speech_id must be a non-empty string"]
    if m.get("reason") not in SPEECH_CANCEL_REASONS:
        errors.append(f"speech_cancelled.reason must be one of {sorted(SPEECH_CANCEL_REASONS)}")
    return errors


def check_drag(m, _):
    if m.get("phase") not in ("begin", "move", "end"):
        return ["drag.phase must be 'begin', 'move' or 'end'"]
    motion = [k for k in ("x", "y", "grab", "vx", "vy") if k in m]
    if not motion:
        return ["drag.move needs x, y, grab, vx, vy"] if m["phase"] == "move" else []
    errors = []
    if not (is_coord(m.get("x")) and is_coord(m.get("y"))):
        errors.append("drag.x and drag.y must be numbers within the coordinate limit")
    g = m.get("grab")
    if not (isinstance(g, dict) and is_coord(g.get("x")) and is_coord(g.get("y"))):
        errors.append("drag.grab needs numeric x and y")
    if not (is_coord(m.get("vx")) and is_coord(m.get("vy"))):
        errors.append("drag.vx and drag.vy must be numbers within the coordinate limit")
    return errors


def check_heartbeat(m, _):
    errors = [] if is_int(m.get("seq")) and m["seq"] >= 0 else ["heartbeat.seq must be an integer >= 0"]
    if not isinstance(m.get("click_through"), bool):
        errors.append("heartbeat.click_through must be a boolean")
    return errors


def check_ack(m, _):
    errors = check_req(m, required=True)
    if not isinstance(m.get("ok"), bool):
        return errors + ["ack.ok must be a boolean"]
    if not m["ok"] and m.get("error") not in ACK_ERRORS:
        errors.append(f"ack.error must be one of {sorted(ACK_ERRORS)} when ok is false")
    if m["ok"] and "error" in m:
        errors.append("ack.error must be absent when ok is true")
    return errors


def check_scale(m):
    return [] if is_num(m.get("scale")) and 0.5 <= m["scale"] <= 2.0 else [f"{m.get('type')}.scale must be within 0.5-2.0"]


def check_placement(m, _):
    errors = [] if is_coord(m.get("x")) and is_coord(m.get("y")) else ["placement needs x and y within the coordinate limit"]
    errors += check_scale(m)
    if not is_pos_int(m.get("display_id")):
        errors.append("placement.display_id must be a positive integer")
    if m.get("reason") not in PLACEMENT_REASONS:
        errors.append(f"placement.reason must be one of {sorted(PLACEMENT_REASONS)}")
    return errors


def check_set_placement(m, _):
    has_x, has_y = "x" in m, "y" in m
    errors = []
    if has_x != has_y:
        errors.append("set_placement.x and y must appear together")
    elif has_x and not (is_coord(m["x"]) and is_coord(m["y"])):
        errors.append("set_placement.x and y must be numbers within the coordinate limit")
    if "scale" in m:
        errors += check_scale(m)
    if not has_x and not has_y and "scale" not in m:
        errors.append("set_placement needs x and y, scale, or both")
    return errors + check_req(m)


def check_click(m, _):
    errors = []
    if m.get("button") not in ("left", "right"):
        errors.append("click.button must be 'left' or 'right'")
    if m.get("count") not in (1, 2) or not is_int(m.get("count")):
        errors.append("click.count must be 1 or 2")
    elif m.get("button") == "right" and m["count"] != 1:
        errors.append("click.count must be 1 for the right button")
    if not (is_num(m.get("x")) and is_num(m.get("y"))):
        errors.append("click needs numeric x and y")
    if "region" in m:
        r = m["region"]
        if not (isinstance(r, str) and TOUCH_REGION.fullmatch(r) and r in TOUCH_REGIONS):
            errors.append(f"click.region must be one of {sorted(TOUCH_REGIONS)}")
        if m.get("button") != "left" or m.get("count") != 1:
            errors.append("click.region is only for button left, count 1")
    return errors


def check_touch_settings(m, _):
    """Rule 45 (v27): all four switches present and boolean."""
    return [f"touch_settings.{k} must be a boolean" for k in TOUCH_SETTINGS_FIELDS if not isinstance(m.get(k), bool)]


def check_stats(m, _):
    errors = []
    if not (is_num(m.get("fps")) and m["fps"] >= 0):
        errors.append("stats.fps must be a number >= 0")
    for k in ("frame_ms_p95", "gpu_ms"):
        if k not in m:
            errors.append(f"stats.{k} is required (number or null)")
        elif m[k] is not None and not (is_num(m[k]) and m[k] > 0):
            errors.append(f"stats.{k} must be a number > 0 or null")
    if m.get("fps") == 0 and m.get("frame_ms_p95") is not None:
        errors.append("stats.frame_ms_p95 must be null when fps is 0")
    return errors


def check_cursor(m, _):
    errors = [] if is_num(m.get("x")) and is_num(m.get("y")) else ["cursor.x and cursor.y must be numbers"]
    for k in ("inside", "hit"):
        if not isinstance(m.get(k), bool):
            errors.append(f"cursor.{k} must be a boolean")
    return errors


def check_fps_tier(m, _):
    tier = m.get("tier")
    if tier not in TIERS:
        return [f"fps_tier.tier must be one of {sorted(TIERS)}"]
    errors = [] if m.get("fps") == TIERS[tier] and is_int(m.get("fps")) else [f"fps_tier.fps for {tier!r} must be {TIERS[tier]}"]
    return errors + check_req(m)


def check_quit(m, _):
    return [] if isinstance(m.get("reason"), str) and m["reason"] else ["quit.reason must be a non-empty string"]


def check_stop_speech(m, _):
    errors = [] if m.get("reason") == "barge_in" else ["stop_speech.reason must be 'barge_in'"]
    if "turn_generation" in m and not (is_int(m["turn_generation"]) and m["turn_generation"] >= 0):
        errors.append("stop_speech.turn_generation must be an integer >= 0")
    return errors


def check_trace(m, _):
    """Rule 22: 1-50 T1 events from the avatar; the full T1 check is agentd's traces/trace_format.py."""
    events = m.get("events")
    if not (isinstance(events, list) and 1 <= len(events) <= MAX_TRACE_EVENTS):
        return [f"trace.events must be a list of 1-{MAX_TRACE_EVENTS} events"]
    errors = []
    for i, e in enumerate(events):
        if not isinstance(e, dict):
            errors.append(f"trace.events[{i}] must be an object")
        elif not (e.get("v") == 1 and e.get("producer") == "avatar" and is_pos_int(e.get("producer_epoch"))
                  and is_pos_int(e.get("seq")) and is_str(e.get("kind"))):
            errors.append(f"trace.events[{i}] needs v 1, producer 'avatar', positive producer_epoch and seq, and a kind")
    return errors


def check_playback(m, _):
    """Rule 23."""
    errors = [] if is_str(m.get("speech_id")) else ["playback.speech_id must be a non-empty string"]
    if not (m.get("clause_id") is None and "clause_id" in m or isinstance(m.get("clause_id"), str)):
        errors.append("playback.clause_id must be a string or null")
    if m.get("state") not in PLAYBACK_STATES:
        errors.append(f"playback.state must be one of {sorted(PLAYBACK_STATES)}")
    if not (is_int(m.get("sample")) and m["sample"] >= 0):
        errors.append("playback.sample must be an integer >= 0")
    if not is_pos_int(m.get("rate")):
        errors.append("playback.rate must be a positive integer")
    if m.get("state") in ("interrupted", "failed", "degraded") and not is_str(m.get("reason")):
        errors.append("playback.reason must be a non-empty string for interrupted, failed and degraded")
    if "utterance_id" in m and not is_str(m["utterance_id"]):
        errors.append("playback.utterance_id must be a non-empty string")
    if "spoken_text_revision" in m and not (is_int(m["spoken_text_revision"]) and m["spoken_text_revision"] >= 0):
        errors.append("playback.spoken_text_revision must be an integer >= 0")
    return errors


def check_behavior_receipt(m, _):
    """Rule 25 (v11)."""
    errors = [] if is_str(m.get("behavior_id")) else ["behavior_receipt.behavior_id must be a non-empty string"]
    if m.get("phase") not in BEHAVIOR_PHASES:
        errors.append(f"behavior_receipt.phase must be one of {sorted(BEHAVIOR_PHASES)}")
    if not ("reason" in m and (m["reason"] is None or isinstance(m["reason"], str))):
        errors.append("behavior_receipt.reason must be a string or null")
    if m.get("phase") in ("rejected", "blocked") and not is_str(m.get("reason")):
        errors.append("behavior_receipt.reason must be a non-empty string for rejected and blocked")
    for key in ("at_ms", "turn_generation"):
        if not (is_int(m.get(key)) and m[key] >= 0):
            errors.append(f"behavior_receipt.{key} must be an integer >= 0")
    return errors


def check_motion_state(m, _):
    """Rule 54."""
    errors = []
    if m.get("origin") not in MOTION_STATE_ORIGINS:
        errors.append(f"motion_state.origin must be one of {sorted(MOTION_STATE_ORIGINS)}")
    if "behavior_id" not in m or not (is_str(m["behavior_id"]) and m.get("origin") != "user"
                                      or m["behavior_id"] is None and m.get("origin") in ("local", "user")):
        errors.append("motion_state.behavior_id must be a non-empty string, or null with origin local; "
                      "null with origin user")
    if m.get("phase") not in (USER_MOTION_PHASES if m.get("origin") == "user" else MOTION_STATE_PHASES):
        errors.append(f"motion_state.phase must be one of {sorted(MOTION_STATE_PHASES)}, "
                      f"with origin user one of {sorted(USER_MOTION_PHASES)}")
    if not (isinstance(m.get("resting"), bool) and isinstance(m.get("busy"), bool)):
        errors.append("motion_state.resting and busy must be booleans")
    if not (is_str(m.get("clip")) and len(m["clip"].encode("utf-8")) <= MAX_ID):
        errors.append(f"motion_state.clip must be a non-empty string of at most {MAX_ID} bytes")
    return errors


def check_switch_table(m, prefix):
    """Rules 28 and 30: id -> bool, at most 128 entries, ids at most 64 bytes."""
    t = m.get("switches")
    if not (isinstance(t, dict) and len(t) <= MAX_ACTIONS):
        return [f"{prefix}.switches must be an object of at most {MAX_ACTIONS} entries"]
    if not all(k and len(k.encode("utf-8")) <= MAX_ID and isinstance(v, bool) for k, v in t.items()):
        return [f"{prefix}.switches must map non-empty ids of at most {MAX_ID} bytes to booleans"]
    return []


def check_action_item(a, i):
    """Rule 30 and the actions[] table."""
    p = f"actions.actions[{i}]"
    if not isinstance(a, dict):
        return [f"{p} must be an object"]
    errors = []
    if not (is_str(a.get("id")) and len(a["id"].encode("utf-8")) <= MAX_ID):
        errors.append(f"{p}.id must be a non-empty string of at most {MAX_ID} bytes")
    for k in ("name", "trigger"):
        if not is_str(a.get(k)):
            errors.append(f"{p}.{k} must be a non-empty string")
    if a.get("section") not in ACTION_SECTIONS:
        errors.append(f"{p}.section must be one of {sorted(ACTION_SECTIONS)}")
    if not ("duration" in a and (a["duration"] is None or is_num(a["duration"]) and a["duration"] > 0)):
        errors.append(f"{p}.duration must be a number > 0 or null")
    for k in ("required_reason", "missing"):
        if not (k in a and (a[k] is None or is_str(a[k]))):
            errors.append(f"{p}.{k} must be a non-empty string or null")
    if "media" in a:
        md = a["media"]
        if not (isinstance(md, dict) and set(md) == MEDIA_FIELDS and all(isinstance(x, bool) for x in md.values())):
            errors.append(f"{p}.media must be an object of exactly {sorted(MEDIA_FIELDS)}, each a boolean")
    if "pose" in a and a["pose"] not in POSE_SLOTS:
        errors.append(f"{p}.pose must be one of {sorted(POSE_SLOTS)}")
    if "default_enabled" in a and a["default_enabled"] is not False:
        errors.append(f"{p}.default_enabled must be false when present")
    return errors


def check_actions(m, _):
    """Rule 27 (v13)."""
    errors = [] if is_str(m.get("character")) else ["actions.character must be a non-empty string"]
    if "behavior_capabilities" in m:
        table = m["behavior_capabilities"]
        if not (isinstance(table, dict) and len(table) <= 16 and all(
                is_str(k) and len(k.encode()) <= 64 and (v is None or is_str(v) and len(v.encode()) <= 512)
                for k, v in table.items())):
            errors.append("actions.behavior_capabilities must map behavior ids to null or an unavailable reason (at most 512 UTF-8 bytes)")
    items = m.get("actions")
    if not (isinstance(items, list) and len(items) <= MAX_ACTIONS):
        return errors + [f"actions.actions must be a list of at most {MAX_ACTIONS} items"]
    errors += check_switch_table(m, "actions")
    for i, a in enumerate(items):
        errors += check_action_item(a, i)
    if errors:
        return errors
    if "error" in m:
        if m["error"] not in ACTIONS_ERRORS:
            return [f"actions.error must be one of {sorted(ACTIONS_ERRORS)}"]
        return [] if items == [] and m["switches"] == {} else ["actions with error must have empty actions and switches"]
    ids = [a["id"] for a in items]
    if len(set(ids)) != len(ids):
        return ["actions.actions ids must be unique"]
    return [] if set(m["switches"]) == set(ids) else ["actions.switches must have exactly the ids of actions"]


def check_action_switches(m, _):
    """Rule 28 (v13)."""
    errors = [] if is_str(m.get("character")) else ["action_switches.character must be a non-empty string"]
    errors += check_switch_table(m, "action_switches")
    adjusted = m.get("adjusted")
    if not (isinstance(adjusted, list) and all(isinstance(x, dict) and is_str(x.get("id")) and x.get("reason") in ADJUSTED_REASONS
                                                for x in adjusted)):
        return errors + [f"action_switches.adjusted must be a list of {{id, reason}} with reason in {sorted(ADJUSTED_REASONS)}"]
    if isinstance(m.get("switches"), dict) and len(adjusted) > len(m["switches"]):
        errors.append("action_switches.adjusted must not be longer than switches")
    if "error" in m:
        if m["error"] not in SWITCHES_ERRORS:
            errors.append(f"action_switches.error must be one of {sorted(SWITCHES_ERRORS)}")
        elif adjusted:
            errors.append("action_switches with error must have an empty adjusted")
    return errors


def check_action_played(m, _):
    """Rule 29 (v13)."""
    errors = [] if is_str(m.get("play_id")) else ["action_played.play_id must be a non-empty string"]
    if not is_str(m.get("id")):
        errors.append("action_played.id must be a non-empty string")
    phase = m.get("phase")
    if phase not in PLAY_PHASES:
        return errors + [f"action_played.phase must be one of {sorted(PLAY_PHASES)}"]
    if not ("reason" in m and (m["reason"] is None or isinstance(m["reason"], str))):
        return errors + ["action_played.reason must be a string or null"]
    allowed = {"rejected": PLAY_REJECTED, "interrupted": PLAY_INTERRUPTED}.get(phase)
    if allowed is not None and m["reason"] not in allowed:
        errors.append(f"action_played.reason for {phase} must be one of {sorted(allowed)}")
    if "chain" in m and not (is_motion_key(m["chain"]) and m["chain"] == m.get("id")):
        errors.append("action_played.chain must be the play_chain start and equal id")
    return errors


def check_get_actions(m, _):
    return []


def check_set_action_switches(m, _):
    errors = [] if is_str(m.get("character")) else ["set_action_switches.character must be a non-empty string"]
    return errors + check_switch_table(m, "set_action_switches")


def check_play_action(m, _):
    errors = [f"play_action.{k} must be a non-empty string" for k in ("play_id", "character", "id") if not is_str(m.get(k))]
    if not (is_num(m.get("speed")) and m["speed"] in PLAY_SPEEDS):
        errors.append("play_action.speed must be 0.5, 1 or 2")
    if "loop" in m and not isinstance(m["loop"], bool):
        errors.append("play_action.loop must be a boolean")
    return errors


def is_motion_key(x):
    """Rules 51 and 52: a chain key, pool key or clip name of the pack's motion-graph.json."""
    return isinstance(x, str) and 1 <= len(x.encode("utf-8")) <= MAX_MOTION_KEY


def check_set_motion_overrides(m, _):
    """Rule 51 (v27): the character's whole override set; any violation makes the whole message invalid."""
    errors = check_req(m, required=True)
    if not is_str(m.get("character")):
        errors.append("set_motion_overrides.character must be a non-empty string")
    for k, limit in OVERRIDE_LIMITS.items():
        t = m.get(k)
        if not (isinstance(t, dict) and len(t) <= limit and all(is_motion_key(x) for x in t)):
            errors.append(f"set_motion_overrides.{k} must be an object of at most {limit} keys of 1-{MAX_MOTION_KEY} bytes")
    if errors:
        return errors
    if not all(isinstance(v, bool) for v in m["chains"].values()):
        errors.append("set_motion_overrides.chains values must be booleans")
    for key, pool in m["pools"].items():
        if not (isinstance(pool, list) and 1 <= len(pool) <= MAX_POOL_ITEMS
                and all(isinstance(p, dict) and set(p) == {"clip", "weight"} and is_motion_key(p["clip"])
                        and isinstance(p["weight"], int) and not isinstance(p["weight"], bool) and 1 <= p["weight"] <= 100000 for p in pool)):
            errors.append(f"set_motion_overrides.pools[{key!r}] must be 1-{MAX_POOL_ITEMS} {{clip, weight}} with integer weight 1-100000")
        elif len({p["clip"] for p in pool}) != len(pool):
            errors.append(f"set_motion_overrides.pools[{key!r}] must not repeat a clip")
    if not all(within(0, MAX_BLEND_IN_S)(v) for v in m["blend_in"].values()):
        errors.append(f"set_motion_overrides.blend_in values must be seconds within 0-{MAX_BLEND_IN_S}")
    return errors


def check_motion_overrides(m, _):
    """Rule 51 (v27): what Avatar applied, and every request entry it did not take."""
    errors = check_req(m, required=True)
    if not is_str(m.get("character")):
        errors.append("motion_overrides.character must be a non-empty string")
    applied = m.get("applied")
    if not (isinstance(applied, dict) and set(applied) == set(OVERRIDE_LIMITS)
            and all(is_int(applied[k]) and 0 <= applied[k] <= limit for k, limit in OVERRIDE_LIMITS.items())):
        errors.append(f"motion_overrides.applied must have exactly {list(OVERRIDE_LIMITS)}, each an integer within its request limit")
    adjusted = m.get("adjusted")
    if not (isinstance(adjusted, list) and len(adjusted) <= sum(OVERRIDE_LIMITS.values())
            and all(isinstance(x, dict) and x.get("kind") in OVERRIDE_REASONS and is_motion_key(x.get("key"))
                    and x.get("reason") in OVERRIDE_REASONS[x["kind"]] for x in adjusted)):
        errors.append("motion_overrides.adjusted must be a list of {kind, key, reason} with a reason of that kind (rule 51)")
    if "truncated" in m and m["truncated"] is not True:
        errors.append("motion_overrides.truncated is only present, as true, when adjusted was cut to fit one line (rule 51 (g))")
    return errors


def check_play_chain(m, _):
    """Rule 52 (v27)."""
    errors = check_req(m, required=True)
    if not (is_str(m.get("play_id")) and len(m["play_id"].encode("utf-8")) <= MAX_ID):
        errors.append(f"play_chain.play_id must be a non-empty string of at most {MAX_ID} bytes")
    if not is_str(m.get("character")):
        errors.append("play_chain.character must be a non-empty string")
    if not is_motion_key(m.get("start")):
        errors.append(f"play_chain.start must be a chain key of 1-{MAX_MOTION_KEY} bytes")
    if "speed" in m and not (is_num(m["speed"]) and m["speed"] in PLAY_SPEEDS):
        errors.append("play_chain.speed must be 0.5, 1 or 2")
    return errors


def is_mod_appearance(x):
    return isinstance(x, str) and 1 <= len(x.encode("utf-8")) <= MAX_ID


def is_mod_values(v):
    """Rule 53 (h): switch id -> integer value 0-255, at most 64 switches."""
    return (isinstance(v, dict) and len(v) <= MAX_MOD_SETTINGS
            and all(MOD_ID_RE.fullmatch(k) and is_int(x) and 0 <= x <= MAX_MOD_VALUE for k, x in v.items()))


def check_mod_settings_table(v, label):
    """Rule 53: set_character.mod_settings and --agentic-complex-mod-settings, appearance id -> values."""
    if not (isinstance(v, dict) and all(is_mod_appearance(a) and is_mod_values(x) for a, x in v.items())):
        return [f"{label} must map appearance ids of 1-{MAX_ID} bytes to values of at most {MAX_MOD_SETTINGS} "
                f"switch ids matching {MOD_ID_RE.pattern} -> integers 0-{MAX_MOD_VALUE}"]
    return []


def check_mod_settings_fields(m, req_nullable):
    t = m.get("type")
    errors = [] if req_nullable and m.get("req", 0) is None else check_req(m, required=True)
    if not is_str(m.get("character")):
        errors.append(f"{t}.character must be a non-empty string")
    if not is_mod_appearance(m.get("appearance")):
        errors.append(f"{t}.appearance must be a string of 1-{MAX_ID} bytes")
    if not is_mod_values(m.get("values")):
        errors.append(f"{t}.values must be an object of at most {MAX_MOD_SETTINGS} switch ids matching {MOD_ID_RE.pattern} -> integers 0-{MAX_MOD_VALUE}")
    return errors


def check_set_mod_settings(m, _):
    """Rule 53 (v27)."""
    return check_mod_settings_fields(m, req_nullable=False)


def check_mod_settings(m, _):
    """Rule 53 (v27): the values in effect; req null when Avatar reports on its own."""
    errors = check_mod_settings_fields(m, req_nullable=True)
    if "adjusted" in m and not (isinstance(m["adjusted"], list) and len(m["adjusted"]) <= MAX_MOD_SETTINGS
                                and all(isinstance(x, dict) and set(x) == {"id", "reason"} and isinstance(x["id"], str)
                                        and MOD_ID_RE.fullmatch(x["id"]) and x["reason"] in MOD_ADJUSTED_REASONS
                                        for x in m["adjusted"])):
        errors.append(f"mod_settings.adjusted must be a list of {{id, reason}} with reason one of {sorted(MOD_ADJUSTED_REASONS)}")
    return errors


def check_mod_settings_arg(text):
    """Rule 53: the JSON value of --agentic-complex-mod-settings."""
    if len(text.encode("utf-8")) > MAX_LINE:
        return [f"--agentic-complex-mod-settings longer than {MAX_LINE} bytes"]
    try:
        value = json.loads(text, parse_constant=reject_constant)
    except ValueError as e:
        return [f"--agentic-complex-mod-settings is not JSON ({e.__class__.__name__})"]
    return check_mod_settings_table(value, "--agentic-complex-mod-settings")


def check_stop_action(m, _):
    """Rules 29 and 30 (v27): only the play_id of the play to stop."""
    errors = [f"stop_action.{k} is not a field of stop_action" for k in m if k not in ("v", "type", "play_id")]
    if not (is_str(m.get("play_id")) and len(m["play_id"].encode("utf-8")) <= MAX_ID):
        errors.append(f"stop_action.play_id must be a non-empty string of at most {MAX_ID} bytes")
    return errors


def is_pose_id(x, min_bytes):
    return x is None or isinstance(x, str) and min_bytes <= len(x.encode("utf-8")) <= MAX_ID


def check_set_pose(m, _):
    """Rule 47 (v27)."""
    errors = check_req(m, required=True)
    if not is_str(m.get("character")):
        errors.append("set_pose.character must be a non-empty string")
    if not ("id" in m and is_pose_id(m["id"], 1)):
        errors.append(f"set_pose.id must be null or a string of 1-{MAX_ID} bytes")
    if not isinstance(m.get("lock"), bool):
        errors.append("set_pose.lock must be a boolean")
    return errors


def check_pose_state(m, _):
    """Rule 47 (v27)."""
    errors = [] if isinstance(m.get("character"), str) else ["pose_state.character must be a string"]
    if not ("id" in m and is_pose_id(m["id"], 0)):
        errors.append(f"pose_state.id must be null or a string of at most {MAX_ID} bytes")
    if not isinstance(m.get("locked"), bool):
        errors.append("pose_state.locked must be a boolean")
    return errors


def check_camera_gesture(m, _):
    """Rule 49 (h) (v27): this event's pointer movement in screen points and zoom factor."""
    errors = [] if m.get("phase") in CAMERA_GESTURE_PHASES else [f"camera_gesture.phase must be one of {list(CAMERA_GESTURE_PHASES)}"]
    errors += [f"camera_gesture.{k} must be a number within the coordinate limit" for k in ("dx", "dy") if not is_coord(m.get(k))]
    if not (is_num(m.get("zoom")) and m["zoom"] > 0):
        errors.append("camera_gesture.zoom must be a number > 0")
    return errors


def check_surface_window(w, path):
    """v14: one window item."""
    if not isinstance(w, dict):
        return [f"{path} must be an object"]
    errors = [f"{path}.{k} must be a positive integer" for k in ("window_id", "generation", "display_id") if not is_pos_int(w.get(k))]
    f = w.get("frame")
    if not (isinstance(f, dict) and all(is_coord(f.get(k)) for k in ("x", "y", "w", "h")) and f["w"] > 0 and f["h"] > 0):
        errors.append(f"{path}.frame must be {{x, y, w, h}} with w, h > 0")
    if not (is_int(w.get("order")) and w["order"] >= 0):
        errors.append(f"{path}.order must be an integer >= 0")
    edges = w.get("edges")
    if not (isinstance(edges, list) and len(edges) <= 3):
        return errors + [f"{path}.edges must be a list of at most 3"]
    for i, e in enumerate(edges):
        if not (isinstance(e, dict) and e.get("side") in SURFACE_SIDES):
            errors.append(f"{path}.edges[{i}].side must be top, left or right")
            continue
        segs = e.get("segments")
        if not (isinstance(segs, list) and 1 <= len(segs) <= 8
                and all(isinstance(g, list) and len(g) == 2 and all(is_coord(c) for c in g) and g[0] < g[1] for g in segs)):
            errors.append(f"{path}.edges[{i}].segments must be 1-8 [a, b] with a < b")
        elif any(a[1] > b[0] for a, b in zip(segs, segs[1:])):
            errors.append(f"{path}.edges[{i}].segments must be ascending and apart")
    return errors


def check_surfaces(m, _):
    errors = [] if is_int(m.get("seq")) and m["seq"] >= 0 else ["surfaces.seq must be an integer >= 0"]
    windows = m.get("windows")
    if not (isinstance(windows, list) and len(windows) <= MAX_SURFACE_WINDOWS):
        return errors + [f"surfaces.windows must be a list of at most {MAX_SURFACE_WINDOWS}"]
    for i, w in enumerate(windows):
        errors += check_surface_window(w, f"surfaces.windows[{i}]")
    if len({w.get("window_id") for w in windows if isinstance(w, dict)}) != len(windows):
        errors.append("surfaces.windows must not repeat a window_id")
    return errors


def is_rect(r):
    return isinstance(r, dict) and all(is_coord(r.get(k)) for k in ("x", "y", "w", "h")) and r["w"] > 0 and r["h"] > 0


def check_surface(m, _):
    errors = [] if is_str(m.get("track_id")) else ["surface.track_id must be a non-empty string"]
    state = m.get("state")
    if state == "tracking":
        errors += check_surface_window(m.get("window"), "surface.window")
        w = m.get("window")
        if isinstance(w, dict) and "above" in w and not (
                isinstance(w["above"], list) and len(w["above"]) <= MAX_ABOVE and all(is_rect(r) for r in w["above"])):
            errors.append(f"surface.window.above must be at most {MAX_ABOVE} {{x, y, w, h}} with w, h > 0")
        return errors
    if state == "gone":
        return errors + ([] if m.get("reason") in SURFACE_GONE else ["surface.reason must be closed, generation, not_listed or too_many"])
    return errors + ["surface.state must be tracking or gone"]


def check_track_surface(m, _):
    errors = [] if is_str(m.get("track_id")) else ["track_surface.track_id must be a non-empty string"]
    if not is_pos_int(m.get("window_id")):
        errors.append("track_surface.window_id must be a positive integer")
    if "generation" in m and not is_pos_int(m["generation"]):
        errors.append("track_surface.generation must be a positive integer")
    return errors


def check_untrack_surface(m, _):
    return [] if is_str(m.get("track_id")) else ["untrack_surface.track_id must be a non-empty string"]


def check_attach(m, _):
    """Rule 34 (v15)."""
    if "track_id" in m and (m["track_id"] is None or is_str(m["track_id"])):
        return []
    return ["attach.track_id must be a non-empty string or null"]


def check_set_opacity(m, _):
    """Rule 35 (v15)."""
    errors = [] if is_num(m.get("opacity")) and 0.2 <= m["opacity"] <= 1 else ["set_opacity.opacity must be within 0.2-1"]
    if not (is_int(m.get("duration_ms")) and 0 <= m["duration_ms"] <= 2000):
        errors.append("set_opacity.duration_ms must be an integer within 0-2000")
    return errors


def check_covered(m, _):
    """Rule 35 (v15): window_id, generation, frame while covered; only window_id null when it ends."""
    if "window_id" not in m:
        return ["covered.window_id is required (positive integer or null)"]
    if m["window_id"] is None:
        return [] if "generation" not in m and "frame" not in m else ["covered with window_id null must not carry generation or frame"]
    errors = [f"covered.{k} must be a positive integer" for k in ("window_id", "generation") if not is_pos_int(m.get(k))]
    if not is_rect(m.get("frame")):
        errors.append("covered.frame must be {x, y, w, h} with w, h > 0")
    return errors


def check_pass_through(m, _):
    """Rule 41 (v24): the controls under her in global points; [] clears."""
    r = m.get("rects")
    if isinstance(r, list) and len(r) <= MAX_PASS_THROUGH and all(is_rect(x) for x in r):
        return []
    return [f"pass_through.rects must be at most {MAX_PASS_THROUGH} {{x, y, w, h}} with w, h > 0"]


def check_keep_clear(m, _):
    """Rule 42 (v26): id, kind and 1-8 rects she walks clear of; only id null to drop the request."""
    if "id" not in m:
        return ["keep_clear.id is required (non-empty string or null)"]
    if m["id"] is None:
        return [] if "kind" not in m and "rects" not in m else ["keep_clear with id null must not carry kind or rects"]
    errors = [] if is_str(m["id"]) else ["keep_clear.id must be a non-empty string or null"]
    if m.get("kind") not in KEEP_CLEAR_KINDS:
        errors.append(f"keep_clear.kind must be one of {sorted(KEEP_CLEAR_KINDS)}")
    r = m.get("rects")
    if not (isinstance(r, list) and 1 <= len(r) <= MAX_KEEP_CLEAR and all(is_rect(x) for x in r)):
        errors.append(f"keep_clear.rects must be 1-{MAX_KEEP_CLEAR} {{x, y, w, h}} with w, h > 0")
    return errors


def check_pointer(m, _):
    """Rule 36 (v16)."""
    errors = [] if is_num(m.get("speed")) and m["speed"] >= 0 else ["pointer.speed must be a number >= 0"]
    if not (is_int(m.get("hover_ms")) and m["hover_ms"] >= 0):
        errors.append("pointer.hover_ms must be an integer >= 0")
    return errors + [f"pointer.{k} must be a boolean" for k in ("near", "shake") if not isinstance(m.get(k), bool)]


def one_of(values):
    return lambda x: isinstance(x, str) and x in values


def within(lo, hi):
    return lambda x: is_num(x) and lo <= x <= hi


def is_bool(x):
    return isinstance(x, bool)


# Rule 43 (v27): a group is a scalar check or an object of optional field checks; ranges follow the launch table.
# Rule 49: yaw below -90 and the camera_free / camera_track fields are gated in check_capability; so are filter (filters),
# dof and photo (photo).
SET_RENDER_GROUPS = {
    "camera": {"mode": one_of(CAMERA_MODES), "yaw": within(-180, 180), "pitch": within(-20, 20),
               "zoom": within(1, 4), "sway": is_bool, "closeup": is_bool, "live": is_bool, "track": one_of(CAMERA_TRACKS),
               "framing": one_of(CAMERA_FRAMINGS)},
    "light": {"yaw": within(-15, 15), "pitch": within(-10, 10), "strength": within(0.5, 1.5)},
    "outline": one_of(PIPELINE_OUTLINES),
    "facing": one_of(FACING_MODES),
    "grounding": {"mode": one_of(GROUNDING_MODES)},
    "ambient": {"mode": one_of(AMBIENT_MODES), "light_wrap": lambda x: isinstance(x, bool)},
    "filter": one_of(PHOTO_FILTERS),
    "dof": {"mode": one_of(DOF_MODES)},
    "photo": {"active": is_bool, "aperture": within(1.4, 32), "focus": lambda x: x == "auto" or within(0.1, 10)(x)},
}
# pipeline.render reports the values in effect, so only their types are checked.
PIPELINE_RENDER_GROUPS = {
    "camera": {"mode": one_of(CAMERA_MODES), "yaw": is_num, "pitch": is_num, "zoom": is_num, "sway": is_bool,
               "closeup": one_of(CLOSEUP_STATES), "closeup_zoom": within(1, 4), "track": one_of(CAMERA_TRACKS),
               "stage": is_bool, "framing": one_of(CAMERA_FRAMINGS)},
    "light": {"yaw": is_num, "pitch": is_num, "strength": is_num},
    "facing": one_of(FACING_MODES),
    "grounding": {"mode": one_of(GROUNDING_MODES)},
    "ambient": {"mode": one_of(AMBIENT_MODES), "light_wrap": lambda x: isinstance(x, bool)},
    "filter": one_of(PHOTO_FILTERS),
    "dof": {"mode": one_of(DOF_MODES)},
    "photo": {"active": is_bool},
}


def check_render_groups(d, prefix, groups):
    errors = []
    for name, check in groups.items():
        if name not in d:
            continue
        g = d[name]
        if callable(check):
            if not check(g):
                errors.append(f"{prefix}.{name} has a bad value")
        elif not isinstance(g, dict):
            errors.append(f"{prefix}.{name} must be an object")
        else:
            errors += [f"{prefix}.{name}.{k} is not a field of {name}" for k in g if k not in check]
            errors += [f"{prefix}.{name}.{k} has a bad value" for k, ok in check.items() if k in g and not ok(g[k])]
    return errors


def check_set_render(m, _):
    """Rule 43 (v27): at least one group, every field inside a group optional."""
    errors = [f"set_render.{k} is not a render group" for k in m if k not in ("v", "type", "req") and k not in SET_RENDER_GROUPS]
    if not any(k in m for k in SET_RENDER_GROUPS):
        errors.append(f"set_render needs at least one of {list(SET_RENDER_GROUPS)}")
    return errors + check_render_groups(m, "set_render", SET_RENDER_GROUPS) + check_req(m)


def check_ambient_sample(m, _):
    """Rule 44 (v27): no req; five linear sRGB colours, each three numbers in 0-1."""
    errors = [] if one_of(AMBIENT_SOURCES)(m.get("source")) else [f"ambient_sample.source must be one of {list(AMBIENT_SOURCES)}"]
    if "req" in m:
        errors.append("ambient_sample takes no req")
    c = m.get("colors")
    if not (isinstance(c, dict) and set(c) == set(AMBIENT_REGIONS)
            and all(isinstance(v, list) and len(v) == 3 and all(within(0, 1)(x) for x in v) for v in c.values())):
        errors.append(f"ambient_sample.colors must have exactly {list(AMBIENT_REGIONS)}, each [r, g, b] within 0-1")
    return errors


def check_capture(m, _):
    """Rule 50 (v27): req is required; v27 defines only the transparent background."""
    errors = [] if m.get("background") in CAPTURE_BACKGROUNDS else [f"capture.background must be one of {list(CAPTURE_BACKGROUNDS)}"]
    return errors + check_req(m, required=True)


def check_captured(m, _):
    """Rule 50 (v27): the file name Avatar wrote into --agentic-complex-capture-dir, without the directory."""
    errors = [] if is_str(m.get("file")) and "/" not in m["file"] else ["captured.file must be a non-empty file name without '/'"]
    errors += [f"captured.{k} must be a positive integer" for k in ("width", "height") if not is_pos_int(m.get(k))]
    return errors + check_req(m, required=True)


def check_pipeline(m, _):
    """Metal host pipeline state; every field is present, null where the format allows it."""
    missing = [k for k in PIPELINE_FIELDS if k not in m]
    if missing:
        return [f"pipeline.{k} is required" for k in missing]
    errors = [f"pipeline.{k} must be a non-empty string" for k in ("renderer", "character", "appearance") if not is_str(m[k])]
    sha = m["bundle_sha256"]
    if sha is not None and not (isinstance(sha, str) and len(sha) == 64 and all(c in "0123456789abcdef" for c in sha)):
        errors.append("pipeline.bundle_sha256 must be 64 lowercase hex digits or null")
    f = m["appearance_fallback"]
    if f is not None and not (isinstance(f, dict) and is_str(f.get("requested")) and is_str(f.get("reason"))):
        errors.append("pipeline.appearance_fallback must be {requested, reason} non-empty strings or null")
    r = m["render"]
    if not (isinstance(r, dict) and r.get("ssaa") in (1, 2) and is_int(r.get("ssaa"))
            and is_int(r.get("shadow_resolution")) and r["shadow_resolution"] >= 0
            and r.get("outline") in PIPELINE_OUTLINES and isinstance(r.get("display_resolution"), bool)
            and isinstance(r.get("unsupported"), list) and all(is_str(x) for x in r["unsupported"])):
        errors.append("pipeline.render needs ssaa 1 or 2, shadow_resolution >= 0, outline, display_resolution and unsupported")
    elif isinstance(r, dict):
        errors += check_render_groups(r, "pipeline.render", PIPELINE_RENDER_GROUPS)
    fps = m["fps"]
    if not (isinstance(fps, dict) and all(is_int(fps.get(k)) and fps[k] >= 0 for k in ("requested", "target"))):
        errors.append("pipeline.fps needs integer requested and target >= 0")
    if m["suspended"] is not None and m["suspended"] not in PIPELINE_SUSPENDED:
        errors.append(f"pipeline.suspended must be null or one of {sorted(PIPELINE_SUSPENDED)}")
    g = m["gpu"]
    if not (isinstance(g, dict) and is_num(g.get("allocated_mb")) and g["allocated_mb"] >= 0):
        errors.append("pipeline.gpu.allocated_mb must be a number >= 0")
    fr = m["frames"]
    if not (isinstance(fr, dict) and all(is_int(fr.get(k)) and fr[k] >= 0 for k in ("submitted", "completed"))):
        errors.append("pipeline.frames needs integer submitted and completed >= 0")
    errors += [f"pipeline.{k} must be a non-empty string or null" for k in ("clip", "error") if not (m[k] is None or is_str(m[k]))]
    return errors


def check_drop(m, _):
    """Rule 38 (v21)."""
    errors = [] if is_coord(m.get("x")) and is_coord(m.get("y")) else ["drop needs x and y within the coordinate limit"]
    if "truncated" in m and not isinstance(m["truncated"], bool):
        errors.append("drop.truncated must be a boolean")
    items = m.get("items")
    if not (isinstance(items, list) and 1 <= len(items) <= MAX_DROP_ITEMS):
        return errors + [f"drop.items must be a list of 1-{MAX_DROP_ITEMS} items"]
    for i, item in enumerate(items):
        field = DROP_FIELDS.get(item.get("kind")) if isinstance(item, dict) else None
        if field is None or set(item) != {"kind", field} or not is_str(item[field]):
            errors.append(f"drop.items[{i}] must be {{kind: file, path}}, {{kind: url, url}} or {{kind: text, text}} with a non-empty string")
        elif field == "path" and not item["path"].startswith("/"):
            errors.append(f"drop.items[{i}].path must be absolute")
        elif field == "text" and len(item["text"].encode("utf-8")) > MAX_DROP_TEXT:
            errors.append(f"drop.items[{i}].text longer than {MAX_DROP_TEXT} bytes")
    return errors


def check_reaction(m, _):
    """Rule 55 (v27). The Companion's hello lists `reactions`; an a2c session holds only the renderer's hello, so the
    capability is not checked here."""
    if set(m) != {"v", "type", "trigger"}:
        return ["reaction has exactly v, type and trigger"]
    return [] if m["trigger"] in REACTION_TRIGGERS else [f"reaction.trigger must be one of {list(REACTION_TRIGGERS)}"]


def check_attention_side(m, _):
    """Rule 39 (v22.1)."""
    errors = [] if m.get("source") in ATTENTION_SOURCES else [f"attention_side.source must be one of {sorted(ATTENTION_SOURCES)}"]
    if not is_str(m.get("kind")):
        errors.append("attention_side.kind must be a non-empty string")
    if m.get("side") not in SIDES:
        errors.append("attention_side.side must be 'left' or 'right'")
    if not (is_int(m.get("generation")) and m["generation"] >= 0):
        errors.append("attention_side.generation must be an integer >= 0")
    return errors


def check_present(m, _):
    """Rule 39 (v22.1)."""
    errors = [] if is_str(m.get("token")) else ["present.token must be a non-empty string"]
    if m.get("side") not in SIDES:
        errors.append("present.side must be 'left' or 'right'")
    if m.get("phase") not in ("open", "close"):
        errors.append("present.phase must be 'open' or 'close'")
    return errors


def check_motion_stroke(m, _):
    """Rule 39 (v22.1)."""
    return [f"motion.stroke.{k} must be a non-empty string" for k in ("token", "clip") if not is_str(m.get(k))]


def check_motion_request(m, _):
    """Rule 40 (v23)."""
    errors = [] if isinstance(m.get("request_id"), str) and MOTION_REQUEST_ID.fullmatch(m["request_id"]) else [
        "motion_request.request_id must be 'mr-' and 16 lowercase hex digits"]
    if not is_str(m.get("behavior_id")):
        errors.append("motion_request.behavior_id must be a non-empty string")
    if not (is_num(m.get("seconds")) and 1 <= m["seconds"] <= 10):
        errors.append("motion_request.seconds must be a number within 1-10")
    kind = m.get("kind")
    if kind not in MOTION_GEOMETRY:
        return errors + [f"motion_request.kind must be one of {sorted(MOTION_GEOMETRY)}"]
    g = m.get("geometry")
    if not (isinstance(g, dict) and set(g) == set(MOTION_GEOMETRY[kind])):
        return errors + [f"motion_request.geometry for {kind} must have exactly {list(MOTION_GEOMETRY[kind])}"]
    def vec(v, n):
        return isinstance(v, list) and len(v) == n and all(is_coord(c) for c in v)
    ok = {"turn": lambda: is_num(g["yaw"]) and abs(g["yaw"]) <= 180,
          "walk": lambda: vec(g["to"], 2) and is_num(g["end_yaw"]),
          "window_loop": lambda: vec(g["hips"], 3),
          "lean": lambda: g["hand"] in SIDES and vec(g["grip"], 3)}.get(kind, lambda: vec(g["seat"], 3))()
    if not ok:
        errors.append(f"motion_request.geometry for {kind} has a bad value (points are [x, z] or [x, y, z] metres, yaw degrees)")
    return errors


CAPABILITY_OF = {("a2c", "attach"): "layering", ("a2c", "drop"): "drop", ("c2a", "set_opacity"): "opacity", ("c2a", "covered"): "opacity",
                 ("c2a", "pointer"): "pointer", ("a2c", "pipeline"): "pipeline",
                 ("a2c", "motion_request"): "motion_requests", ("c2a", "pass_through"): "pass_through", ("c2a", "keep_clear"): "keep_clear",
                 ("c2a", "get_presentation"): "presentation", ("c2a", "set_presentation"): "presentation", ("a2c", "presentation_state"): "presentation",
                 ("c2a", "set_render"): "render_live", ("c2a", "ambient_sample"): "ambient", ("c2a", "touch_settings"): "touch",
                 ("c2a", "stop_action"): "action_loop", ("c2a", "set_layers"): "layers", ("a2c", "layers_changed"): "layers",
                 ("a2c", "layers_change_failed"): "layers", ("c2a", "set_pose"): "poses", ("a2c", "pose_state"): "poses",
                 ("c2a", "capture"): "capture", ("a2c", "captured"): "capture", ("a2c", "camera_gesture"): "camera_gesture",
                 ("c2a", "set_motion_overrides"): "motion_overrides", ("a2c", "motion_overrides"): "motion_overrides",
                 ("c2a", "play_chain"): "play_chain", ("c2a", "set_mod_settings"): "mod_settings",
                 ("a2c", "mod_settings"): "mod_settings"}


def check_capability(m, direction, caps):
    """v15-v27: a sender only uses opacity, layering, pointer, pipeline, drop, motion_request, pass_through, keep_clear, set_render, ambient_sample, touch_settings, click.region, play_action.loop, stop_action, actions[].media, set_layers, layers_changed(_failed), set_pose, pose_state, actions[].pose, the rule 49 set_render.camera fields, camera_gesture, set_render.filter, set_render.dof, set_render.photo, capture, captured, set_motion_overrides, motion_overrides, play_chain, action_played.chain, set_mod_settings, mod_settings and set_character.mod_settings after listing them in its own hello."""
    if not isinstance(m, dict) or caps is None:
        return []
    t = m.get("type")
    need = CAPABILITY_OF.get((direction, t))
    if t == "surface" and isinstance(m.get("window"), dict) and "above" in m["window"]:
        need = "layering"
    if t == "click" and "region" in m:
        need = "touch"
    if t == "play_action" and "loop" in m:
        need = "action_loop"
    if t == "action_played" and "chain" in m:
        need = "play_chain"
    if t == "set_character" and "mod_settings" in m:
        need = "mod_settings"
    if t == "actions" and isinstance(m.get("actions"), list) and any(isinstance(a, dict) and "media" in a for a in m["actions"]):
        need = "motion_media"
    if t == "actions" and isinstance(m.get("actions"), list) and any(isinstance(a, dict) and "pose" in a for a in m["actions"]):
        need = "poses"
    needs = [need] if need else []
    if t == "set_render" and isinstance(m.get("camera"), dict):
        cam = m["camera"]
        if any(k in cam for k in CAMERA_FREE_FIELDS) or (is_num(cam.get("yaw")) and cam["yaw"] < -90):
            needs.append("camera_free")
        if "track" in cam:
            needs.append("camera_track")
        if "framing" in cam:
            needs.append("camera_bust")
    if t == "set_render" and "filter" in m:
        needs.append("filters")
    if t == "set_render" and ("dof" in m or "photo" in m):
        needs.append("photo")
    return [f"{t} needs {n!r} in this side's hello.capabilities" for n in needs if n not in caps]


def check_move_window(m, _):
    errors = [] if is_coord(m.get("x")) and is_coord(m.get("y")) else ["move_window needs numeric x and y within the coordinate limit"]
    return errors + check_req(m)


def check_set_visible(m, _):
    errors = [] if isinstance(m.get("visible"), bool) else ["set_visible.visible must be a boolean"]
    return errors + check_req(m)


def check_set_character(m, _):
    errors = [] if isinstance(m.get("id"), str) and m["id"] else ["set_character.id must be a non-empty string"]
    if "appearance" in m and not is_str(m["appearance"]):
        errors.append("set_character.appearance must be a non-empty string")
    if "hidden_layers" in m:
        errors += check_hidden_list(m["hidden_layers"], "set_character.hidden_layers")
    if "mod_settings" in m:
        errors += check_mod_settings_table(m["mod_settings"], "set_character.mod_settings")
    return errors


def check_character_changed(m, _):
    errors = [] if isinstance(m.get("id"), str) and m["id"] else ["character_changed.id must be a non-empty string"]
    if not (is_int(m.get("ms")) and m["ms"] >= 0):
        errors.append("character_changed.ms must be an integer >= 0")
    return errors + check_appearances(m, "character_changed") + check_layer_fields(m)


def check_character_change_failed(m, _):
    errors = [] if isinstance(m.get("id"), str) and m["id"] else ["character_change_failed.id must be a non-empty string"]
    if m.get("reason") not in CHARACTER_CHANGE_FAILED_REASONS:
        errors.append(f"character_change_failed.reason must be one of {sorted(CHARACTER_CHANGE_FAILED_REASONS)}")
    return errors


def check_set_appearance(m, _):
    return [] if is_str(m.get("id")) else ["set_appearance.id must be a non-empty string"]


def check_appearance_changed(m, _):
    return [] if is_str(m.get("id")) else ["appearance_changed.id must be a non-empty string"]


def check_appearance_change_failed(m, _):
    errors = [] if is_str(m.get("id")) else ["appearance_change_failed.id must be a non-empty string"]
    if m.get("reason") not in APPEARANCE_CHANGE_FAILED_REASONS:
        errors.append(f"appearance_change_failed.reason must be one of {sorted(APPEARANCE_CHANGE_FAILED_REASONS)}")
    return errors


def check_set_layers(m, _):
    return check_hidden_list(m.get("hidden"), "set_layers.hidden")


def check_layers_changed(m, _):
    return check_hidden_list(m.get("hidden"), "layers_changed.hidden")


def check_layers_change_failed(m, _):
    errors = check_hidden_list(m.get("hidden"), "layers_change_failed.hidden")
    if m.get("reason") not in LAYERS_CHANGE_FAILED_REASONS:
        errors.append(f"layers_change_failed.reason must be one of {sorted(LAYERS_CHANGE_FAILED_REASONS)}")
    return errors


def check_point_at(m, _):
    errors = []
    if not (isinstance(m.get("nudge_id"), str) and m["nudge_id"]):
        errors.append("point_at.nudge_id must be a non-empty string")
    if m.get("kind") != "alert":
        errors.append("point_at.kind must be 'alert'")
    if "rect" not in m:
        return errors + ["point_at.rect is required (object or null)"]
    r = m["rect"]
    if r is None:
        return errors
    if not (isinstance(r, dict) and all(is_num(r.get(k)) for k in ("x", "y", "w", "h"))):
        return errors + ["point_at.rect needs numeric x, y, w, h or null"]
    if r["w"] <= 0 or r["h"] <= 0:
        errors.append("point_at.rect w and h must be > 0")
    return errors


def check_presentation_request(m, _):
    errors = [] if is_int(m.get("req")) and m["req"] >= 0 and is_str(m.get("character")) else ["presentation needs nonnegative req and character"]
    if m.get("type") == "get_presentation":
        return errors
    if not any(k in m for k in ("weather", "expression", "face_effect", "facial_animation")):
        errors.append("set_presentation needs at least one owned input")
    def unit(x):
        return is_num(x) and 0 <= x <= 1
    if "weather" in m:
        w = m["weather"]
        if not (isinstance(w, dict) and w.get("condition") in ("clear", "rain", "snow") and unit(w.get("intensity"))
                and all(w.get(k) is None or unit(w[k]) for k in ("wetness", "snow"))
                and (w["condition"] != "clear" or w["intensity"] == 0)):
            errors.append("invalid normalized presentation weather")
    if "expression" in m:
        e = m["expression"]
        if not (isinstance(e, dict) and "pose" in e and (e["pose"] is None or is_str(e["pose"])) and unit(e.get("weight", 1))):
            errors.append("invalid exact original expression")
    if "face_effect" in m:
        e = m["face_effect"]
        if not (isinstance(e, dict) and is_int(e.get("index")) and 0 <= e["index"] <= 3 and unit(e.get("blend"))):
            errors.append("invalid original 2x2 emotion atlas effect")
    if "facial_animation" in m:
        a=m["facial_animation"]
        if not (isinstance(a,dict) and "id" in a and (a['id'] is None or is_str(a['id']) and len(a['id'].encode())<=64)
                and is_num(a.get('rate',1)) and .5<=a.get('rate',1)<=2 and unit(a.get('weight',1))):
            errors.append("invalid original facial timeline")
    if "valid_for_seconds" in m and not (is_num(m["valid_for_seconds"]) and 1 <= m["valid_for_seconds"] <= 3600):
        errors.append("presentation validity must be within 1-3600 seconds")
    return errors


def check_presentation_state(m, _):
    errors = [] if is_int(m.get("req")) and m["req"] >= 0 and is_str(m.get("character")) else ["presentation receipt identity required"]
    if m.get("phase") not in ("state", "applied", "rejected"):
        errors.append("presentation receipt phase invalid")
    if m.get("phase") == "applied" and not (is_int(m.get("frame")) and m["frame"] >= 0):
        errors.append("applied presentation requires its submitted frame")
    if m.get("phase") == "rejected" and not is_str(m.get("reason")):
        errors.append("rejected presentation requires reason")
    expressions=m.get("expressions")
    if not (isinstance(expressions,list) and len(expressions)<=512 and all(is_str(v) for v in expressions)
            and len(set(expressions))==len(expressions) and (m.get("expression") is None or m["expression"] in expressions)):
        errors.append("presentation expressions must be the exact adaptable pose list")
    if any(not isinstance(m.get(k),bool) for k in ("weather_supported","face_effect_supported")):
        errors.append("presentation support fields must be booleans")
    coverage=m.get("coverage")
    if not (isinstance(coverage,dict) and all(is_num(coverage.get(k)) and 0<=coverage[k]<=1 for k in ("drops","wetness","snow"))):
        errors.append("presentation coverage must be finite normalized values")
    if 'facial_animations' in m:
        rows=m['facial_animations']
        if not (isinstance(rows,list) and len(rows)<=512 and all(isinstance(r,dict) and is_str(r.get('id')) and len(r['id'].encode())<=64 and is_str(r.get('name')) and is_num(r.get('duration')) and 0<r['duration']<=300 for r in rows)
                and len({r['id']for r in rows})==len(rows)):
            errors.append('invalid facial timeline library')
        else:
            p=m.get('facial_animation')
            if not (isinstance(p,dict) and 'id'in p and (p['id']is None or p['id']in {r['id']for r in rows}) and is_num(p.get('time')) and p['time']>=0 and isinstance(p.get('completed'),bool)):
                errors.append('invalid facial timeline playback')
    return errors


CHECKS = {
    "a2c": {"hello": check_hello, "window_frame": check_window_frame, "hit_capsules": check_hit_capsules, "drag": check_drag,
            "speech_cancelled": check_speech_cancelled, "click": check_click, "stats": check_stats,
            "character_changed": check_character_changed, "character_change_failed": check_character_change_failed,
            "appearance_changed": check_appearance_changed, "appearance_change_failed": check_appearance_change_failed,
            "heartbeat": check_heartbeat, "ack": check_ack, "placement": check_placement,
            "trace": check_trace, "playback": check_playback, "behavior_receipt": check_behavior_receipt,
            "motion_state": check_motion_state, "actions": check_actions, "action_switches": check_action_switches, "action_played": check_action_played,
            "track_surface": check_track_surface, "untrack_surface": check_untrack_surface, "attach": check_attach,
            "pipeline": check_pipeline, "presentation_state": check_presentation_state, "drop": check_drop,
            "motion.stroke": check_motion_stroke, "motion_request": check_motion_request,
            "layers_changed": check_layers_changed, "layers_change_failed": check_layers_change_failed,
            "pose_state": check_pose_state, "captured": check_captured, "camera_gesture": check_camera_gesture,
            "motion_overrides": check_motion_overrides, "mod_settings": check_mod_settings, "reaction": check_reaction},
    "c2a": {"hello": check_hello, "cursor": check_cursor, "fps_tier": check_fps_tier, "quit": check_quit,
            "stop_speech": check_stop_speech, "point_at": check_point_at,
            "move_window": check_move_window, "set_visible": check_set_visible,
            "set_character": check_set_character, "set_appearance": check_set_appearance,
            "set_placement": check_set_placement, "get_actions": check_get_actions,
            "set_action_switches": check_set_action_switches, "play_action": check_play_action,
            "surfaces": check_surfaces, "surface": check_surface,
            "set_opacity": check_set_opacity, "covered": check_covered, "pointer": check_pointer,
            "get_presentation": check_presentation_request, "set_presentation": check_presentation_request,
            "attention_side": check_attention_side, "present": check_present, "pass_through": check_pass_through,
            "keep_clear": check_keep_clear, "set_render": check_set_render, "ambient_sample": check_ambient_sample,
            "touch_settings": check_touch_settings, "stop_action": check_stop_action, "set_layers": check_set_layers,
            "set_pose": check_set_pose, "capture": check_capture, "set_motion_overrides": check_set_motion_overrides,
            "play_chain": check_play_chain, "set_mod_settings": check_set_mod_settings},
}


def check_message(m, direction):
    if not isinstance(m, dict):
        return ["message must be a JSON object"]
    if m.get("v") != 1 or not is_int(m.get("v")):
        return ["v must be 1"]
    check = CHECKS[direction].get(m.get("type"))
    if check is None:
        return [f"type {m.get('type')!r} is not defined for direction {direction}"]
    return check(m, direction) + check_limits(m)


def check_lines(raw, direction, session):
    """Return error strings; session=True also requires hello first."""
    errors = []
    caps = None
    if raw and not raw.endswith(b"\n"):
        errors.append("last line must end with \\n")
    for n, line in enumerate(raw.split(b"\n")[:-1] if raw.endswith(b"\n") else raw.split(b"\n"), 1):
        if len(line) + 1 > MAX_LINE:
            errors.append(f"line {n}: longer than {MAX_LINE} bytes")
            continue
        try:
            m = json.loads(line.decode("utf-8"), parse_constant=reject_constant)
        except (UnicodeDecodeError, ValueError) as e:
            errors.append(f"line {n}: not one JSON object per line ({e.__class__.__name__})")
            continue
        if isinstance(m, dict) and m.get("type") == "motion_request" and len(line) + 1 > MAX_MOTION_REQUEST_LINE:
            errors.append(f"line {n}: motion_request longer than {MAX_MOTION_REQUEST_LINE} bytes")
        if session and n == 1 and (not isinstance(m, dict) or m.get("type") != "hello"):
            errors.append("line 1: first message must be hello")
        errors += [f"line {n}: {e}" for e in check_message(m, direction) + check_capability(m, direction, caps)]
        if isinstance(m, dict) and m.get("type") == "hello":
            caps = m["capabilities"] if isinstance(m.get("capabilities"), list) else []
    return errors


def reject_constant(name):
    """Rule 21: NaN and Infinity are not JSON numbers."""
    raise ValueError(f"non-finite number {name}")


def direction_of(path):
    name = path.name
    if name.startswith(("a2c-", "avatar-to-companion")):
        return "a2c"
    if name.startswith(("c2a-", "companion-to-avatar")):
        return "c2a"
    raise SystemExit(f"{path}: cannot infer direction from file name")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--direction", choices=["a2c", "c2a"])
    p.add_argument("files", nargs="*", type=Path)
    a = p.parse_args()
    if a.files:
        if not a.direction:
            p.error("--direction is required with files")
        bad = 0
        for f in a.files:
            errors = check_lines(f.read_bytes(), a.direction, session=True)
            bad += bool(errors)
            print(f"{'FAIL' if errors else 'ok  '} {f}" + "".join(f"\n     {e}" for e in errors))
        return 1 if bad else 0
    examples = Path(__file__).resolve().parent / "examples"
    failures = passed = 0
    # pending/: examples of rules the bridge and Companion do not handle yet, kept out of the host-link and Swift example tests.
    for f in sorted(examples.glob("*.ndjson")) + sorted((examples / "pending").glob("*.ndjson")):
        errors = check_lines(f.read_bytes(), direction_of(f), session=True)
        if errors:
            failures += 1
            print(f"FAIL valid example rejected: {f.name}" + "".join(f"\n     {e}" for e in errors))
        else:
            passed += 1
    for f in sorted((examples / "invalid").glob("*.ndjson")) + sorted((examples / "pending" / "invalid").glob("*.ndjson")):
        errors = check_lines(f.read_bytes(), direction_of(f), session=False)
        if errors:
            passed += 1
            print(f"ok   {f.name}: {errors[0]}")
        else:
            failures += 1
            print(f"FAIL invalid example accepted: {f.name}")
    print(f"C3 examples: {passed} passed, {failures} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
