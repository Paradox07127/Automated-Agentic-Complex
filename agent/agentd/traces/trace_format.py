#!/usr/bin/env python3
"""T1 trace event format v1 (`protocol/C6-agentd-api/T1-TRACE.md`): validate one event or an NDJSON file.

Usage: traces/trace_format.py <file.ndjson>   exit 0 when every line and the stream as a whole are valid."""
import json
import math
import re
import sys
from datetime import datetime


TRACE_FAILURE_REASONS = frozenset((
    "ws_text_not_allowed", "ws_decision_not_allowed", "cloud_text_not_allowed", "cloud_decision_not_allowed",
    "decision_rate_limited", "usage_limit", "decision_queue_full", "decision_input_budget", "decision_stale",
    "decision_cancelled", "decision_closed", "decision_uncertain", "decision_service_unavailable",
    "cloud_decision_unavailable", "decision_transport_failed", "invalid_decision_response", "invalid_answers",
    "missing_api_key", "credential_permissions", "credentials_rejected", "model_access_denied", "sign_in_required",
    "auth_unavailable", "plan_usage_not_enabled", "select_model", "inference_not_completed",
))

VERSION = 1
PRODUCERS = ("agentd", "companion", "avatar", "tts")
STATUSES = ("ok", "blocked", "failed", "cancelled", "expired", "unknown")
TEXT_MAX = 4000
HEAD_MAX = 8
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
SPAN = re.compile(r"^[0-9a-f]{16}$")
WALL = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(Z|[+-]\d{2}:\d{2})$")
OBSERVATION_STATES = ("ready", "declined", "unavailable", "expired", "cancelled", "failed")
SIGNAL_SOURCES = ("coarse", "content", "pointer", "attention", "present", "touch", "override", "pause")
SIGNAL_WORD = re.compile(r"[a-z][a-z0-9_]{0,31}")
STAGES = ("offstage", "quiet", "normal", "engaged")


def valid_wall(value):
    if not isinstance(value, str) or not WALL.fullmatch(value):
        return False
    try:
        return datetime.fromisoformat(value).utcoffset() is not None
    except ValueError:
        return False


def _enum(*values):
    return lambda v: v in values


def _str(v):
    return isinstance(v, str) and bool(v)


def _opt_str(v):
    return v is None or _str(v)


def _int(v):
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0


def _bool(v):
    return isinstance(v, bool)


def _positive(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0


def _list(v):
    return isinstance(v, list)


def _text(v):
    return isinstance(v, dict) and set(v) == {"len", "head"} and _int(v["len"]) and isinstance(v["head"], str) \
        and len(v["head"]) <= min(HEAD_MAX, v["len"])


def _opt_text(v):
    return v is None or _text(v)


def _items(v):
    return _list(v) and all(isinstance(i, dict) and {"type", "observation_id", "at"} <= set(i) for i in v)


def _answers(v):
    return _list(v) and all(isinstance(a, dict) and {"id", "value", "prob"} <= set(a) for a in v)


def _number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _signal_value(v):
    # an enum word, never free text
    return _bool(v) or _number(v) or isinstance(v, str) and bool(SIGNAL_WORD.fullmatch(v))


def _opt_number(v):
    return v is None or _number(v)


def _table(ok):
    return lambda v: isinstance(v, dict) and all(isinstance(k, str) and ok(x) for k, x in v.items())


def _item(v):
    return isinstance(v, dict) and _str(v.get("kind"))


OBSERVED_BY = ("poll", "step", "receipt", "offer", "facing")


SPEECH = {"speech_id": _str, "clause_id": _opt_str}
# kind -> required attrs; the value checks each one.
KINDS = {
    "input.received": {"source": _enum("text", "voice", "proactive", "announce", "ritual", "gift", "tap", "background"), "text": _opt_text},
    "context.assembled": {"items": _items},
    "observation.requested": {"request_id": _str, "mode": _enum("text", "ocr", "image"),
                              "purpose": _enum("current", "recall"), "window_id": _int},
    "observation.settled": {"request_id": _str, "state": _enum(*OBSERVATION_STATES)},
    "egress.checked": {"result": _enum("pass", "blocked"), "category": _opt_str, "redactions": _int},
    "model.started": {"model": _str, "call": _enum("judge", "behavior", "vision", "capture_judge", "eval", "character_agent")},
    "model.first_token": {},
    "model.finished": {"model": _str, "input_tokens": _int, "output_tokens": _int, "stop_reason": _str},
    "tool.started": {"tool": _str, "call_id": _str},
    "tool.settled": {"tool": _str, "call_id": _str, "outcome": _enum("completed", "failed", "waiting_user"),
                     "error_code": _opt_str},
    "turn.settled": {"state": _enum("completed", "failed", "cancelled", "interrupted", "waiting_user"),
                     "error_code": _opt_str, "outcome": _opt_str},
    "line.parsed": {"line_id": _str, "intents": _list, "target": lambda v: v is None or isinstance(v, (str, dict)),
                    "first_sentence_only": _bool, "text": _text},
    "speech.requested": {**SPEECH, "line_id": _str, "text": _text},
    "speech.first_audio": SPEECH,
    "speech.finished": {**SPEECH, "total_samples": _int},
    "playback.started": SPEECH,
    "playback.ended": SPEECH,
    "playback.interrupted": {**SPEECH, "reason": _str, "planned_ms": lambda v: v is None or _int(v)},
    "playback.buffering": SPEECH,
    "playback.resumed": SPEECH,
    "playback.degraded": {**SPEECH, "reason": _str},
    "motion.started": {"behavior_id": _opt_str, "clip": _str},
    "motion.ended": {"behavior_id": _opt_str, "clip": _str},
    "cancel.requested": {"by": _enum("ptt", "text", "stop_command", "supersede", "character_switch", "system"),
                         "target": _enum("turn", "speech", "observation", "dispatch")},
    "cancel.acked": {"target": _enum("turn", "speech", "observation", "dispatch")},
    "gate.decided": {"kind": _str, "level": _str, "speak": _bool, "reason": _opt_str},
    "judge.decided": {"backend": _enum("rules", "haiku", "character_agent"),
                      "answers": _answers},
    "behavior.ticked": {"options": _list, "chosen": _opt_str, "reason": _opt_str},
    "behavior.dispatched": {"behavior_id": _str, "behavior_type": _str},
    "behavior.receipt": {"behavior_id": _str, "behavior_type": _str, "phase": _str, "reason": _opt_str},
    "behavior.refused": {"behavior_type": _str, "trigger_source": _str, "trigger_event": _opt_str,
                         "priority": _int, "channels": lambda v: _list(v) and all(map(_str, v)), "reason": _str},
    "signal.changed": {"source": _enum(*SIGNAL_SOURCES), "key": _str, "value": _signal_value,
                       "revision": lambda v: v is None or _int(v)},
    "stage.changed": {"from": _enum(*STAGES), "to": _enum(*STAGES), "revision": _int},
    "motion.chosen": {"clip": _str, "why": _str, "layer": lambda v: v is None or v in ("base", "overlay"),
                      "behavior_id": _opt_str, "t_s": lambda v: _number(v) and v >= 0},
    "motion.state": {"origin": _enum("agent", "local", "user"),
                     "phase": _enum("started", "cycle_end", "ended", "expired", "rejected"), "clip": _str,
                     "behavior_id": _opt_str},
    "spatial.began": {"seed": lambda v: v is None or _int(v), "epoch": _int, "preset": _str, "stage": _enum(*STAGES),
                      "session_settle": _opt_number, "session_min_hold": _opt_number, "recovery_delay": _opt_number},
    "situation.observed": {"by": _enum(*OBSERVED_BY), "fullscreen": _bool, "user_speaking": _bool, "speaking": _bool,
                           "voicing": _bool, "typing": _bool, "line_id": _opt_str, "absence_since": _opt_number,
                           "session": _opt_str, "state": _str, "related": lambda v: _list(v) and all(map(_str, v)),
                           "window_id": lambda v: v is None or _int(v), "activity": _opt_str,
                           "idle": lambda v: v in (None, "active", "quiet"), "turn_traced": _bool},
    "motion.chooser": {"pack": _opt_str, "seeds": lambda v: v is None or _table(_int)(v),
                       "kept": lambda v: v is None or isinstance(v, dict) and _str(v.get("clip"))
                       and _int(v.get("until_ms"))},
    "motion.intent": {"intent": _str, "state": _opt_str, "activity": _opt_str, "mood": _opt_str,
                      "display_session": _opt_str},
    "motion.input": {"item": _item},
    "motion.clock": {"frames": _int},
    "motion.prefs": {"action_switches": _table(_bool), "motion_overrides": _table(lambda x: isinstance(x, dict))},
    "motion.return": {"row": _opt_str, "away_s": _number, "ended": _int, "why": _opt_str},
    "behavior.switches": {"switches": _table(_bool)},
    "behavior.capabilities": {"character": _opt_str, "capabilities": _table(_opt_str)},
    "behavior.cancel_all": {"reason": _str},
    "proactive.feedback": {"line_id": _str, "value": _enum("useful", "dont_disturb")},
    "dispatch.proposed": {"request_id": _str},
    "dispatch.decided": {"request_id": _str, "decision": _str},
    "dispatch.failed": {"request_id": _str, "error": _str},
    "dispatch.finished": {"request_id": _str},
    "approval.opened": {"request_id": _str, "tool": _opt_str},
    "approval.decided": {"request_id": _str, "tool": _opt_str, "decision": _str, "by": _enum("card", "native")},
    "approval.retired": {"request_id": _str, "tool": _opt_str, "reason": _str},
    "trace.dropped": {"count": _int, "since": valid_wall},
    "desktop.lease_opened": {"run_id": _str, "session_id": _str},
    "tool.verdict": {"tool": _str, "method": _str, "dangerous": _bool, "rule": _opt_str, "reason": _opt_str},
    "desktop.lease_released": {"run_id": _str, "session_id": _str, "reason": _str},
    "summary.requested": {"run_id": _str, "kind": _enum("episode", "state", "facts")},
    "summary.finished": {"run_id": _str, "kind": _enum("episode", "state", "facts"),
                         "outcome": _enum("ok", "invalid", "model_error", "skipped", "away_template",
                                          "fallback_template")},
    "motion.published": {"motion_id": _str, "behavior_id": _str, "total_ms": _int},
    "motion.fallback": {"reason": _str},
    "motion.matched": {"action_id": _str, "group": _str, "length_s": _positive, "seconds": _positive, "prompt": _text},
    "ui.submitted": {},
    "ui.ack": {},
    "ui.first_text": {},
}
ENDS = {"observation.settled", "model.finished", "speech.finished", "playback.ended", "playback.interrupted",
        "motion.ended", "cancel.acked", "dispatch.finished", "approval.decided", "approval.retired",
        "summary.finished", "tool.settled", "turn.settled"}
FIELDS = {"v", "event_id", "trace_id", "turn_id", "turn_generation", "span_id", "parent_span_id", "causation_id",
          "producer", "producer_epoch", "seq", "kind", "t_wall", "t_mono_ms", "t_recv_wall", "duration_ms", "status",
          "attrs", "text"}


def validate_event(e):
    """The list of what is wrong with one event; empty when it is valid."""
    if not isinstance(e, dict):
        return ["not an object"]
    errors = [f"unknown field {k}" for k in sorted(set(e) - FIELDS)]
    checks = {
        "v": lambda v: type(v) is int and v == VERSION,
        "event_id": lambda v: isinstance(v, str) and bool(UUID.fullmatch(v)),
        "trace_id": lambda v: isinstance(v, str) and bool(UUID.fullmatch(v)),
        "turn_id": _opt_str,
        "turn_generation": lambda v: v is None or _int(v),
        "span_id": lambda v: isinstance(v, str) and bool(SPAN.fullmatch(v)),
        "parent_span_id": lambda v: v is None or isinstance(v, str) and bool(SPAN.fullmatch(v)),
        "causation_id": lambda v: v is None or isinstance(v, str) and bool(UUID.fullmatch(v)),
        "producer": _enum(*PRODUCERS),
        "producer_epoch": lambda v: _int(v) and v >= 1,
        "seq": lambda v: _int(v) and v >= 1,
        "kind": _enum(*KINDS),
        "t_wall": valid_wall,
        "t_mono_ms": _int,
        "status": _enum(*STATUSES),
        "attrs": lambda v: isinstance(v, dict),
    }
    for field, ok in checks.items():
        if field not in e:
            errors.append(f"missing {field}")
        elif not ok(e[field]):
            errors.append(f"bad {field}: {e[field]!r}")
    if errors:
        return errors
    if (e["turn_id"] is None) != (e["turn_generation"] is None):
        errors.append("turn_id and turn_generation must both be null or both be set")
    if "t_recv_wall" in e and not valid_wall(e['t_recv_wall']):
        errors.append(f"bad t_recv_wall: {e['t_recv_wall']!r}")
    if e["kind"] in ENDS and not _int(e.get("duration_ms")):
        errors.append(f"{e['kind']} ends a span and needs duration_ms")
    if e["kind"] not in ENDS and "duration_ms" in e:
        errors.append(f"{e['kind']} does not end a span: no duration_ms")
    for key, ok in KINDS[e["kind"]].items():
        if key not in e["attrs"]:
            errors.append(f"{e['kind']} needs attrs.{key}")
        elif not ok(e["attrs"][key]):
            errors.append(f"bad attrs.{key}: {e['attrs'][key]!r}")
    if e["kind"] == "judge.decided" and "failure_reason" in e["attrs"] \
            and e["attrs"]["failure_reason"] not in (*TRACE_FAILURE_REASONS, "decision_failed"):
        errors.append(f"bad attrs.failure_reason: {e['attrs']['failure_reason']!r}")
    if e["kind"] == "model.finished":
        # Optional: only when the harness reported the count.
        for key in ("cached_tokens", "reasoning_tokens"):
            if key in e["attrs"] and not _int(e["attrs"][key]):
                errors.append(f"bad attrs.{key}: {e['attrs'][key]!r}")
        if "cost_usd" in e["attrs"] and not (_number(e["attrs"]["cost_usd"]) and e["attrs"]["cost_usd"] >= 0):
            errors.append(f"bad attrs.cost_usd: {e['attrs']['cost_usd']!r}")
    if "text" in e:
        if not isinstance(e["text"], dict):
            errors.append("text must be an object")
        else:
            for key, full in e["text"].items():
                value = e["attrs"].get(key)
                if not _text(value):
                    errors.append(f"text.{key} has no {{len, head}} in attrs")
                elif not isinstance(full, str) or len(full) > TEXT_MAX or not full.startswith(value["head"]):
                    errors.append(f"bad text.{key}")
    return errors


def validate_stream(events):
    """Per-event errors plus the cross-event rules: unique event_id, seq rising per producer epoch,
    causation_id and parent_span_id pointing inside the stream."""
    errors, ids, spans, last_seq = [], set(), set(), {}
    good = []
    for i, e in enumerate(events):
        found = validate_event(e)
        errors += [f"line {i + 1}: {msg}" for msg in found]
        if not found:
            good.append((i, e))
            spans.add(e["span_id"])
    for i, e in good:
        if e["event_id"] in ids:
            errors.append(f"line {i + 1}: duplicate event_id {e['event_id']}")
        ids.add(e["event_id"])
        key = (e["producer"], e["producer_epoch"])
        if key in last_seq and e["seq"] <= last_seq[key]:
            errors.append(f"line {i + 1}: seq {e['seq']} of {key[0]}/{key[1]} is not above {last_seq[key]}")
        last_seq[key] = e["seq"]
        if e["causation_id"] is not None and e["causation_id"] not in ids:
            errors.append(f"line {i + 1}: causation_id {e['causation_id']} is not an earlier event")
        if e["parent_span_id"] is not None and e["parent_span_id"] not in spans:
            errors.append(f"line {i + 1}: parent_span_id {e['parent_span_id']} is no span in the stream")
    return errors


def main(argv):
    if len(argv) != 2:
        sys.exit(__doc__)
    with open(argv[1], encoding="utf-8") as stream:
        lines = [line for line in stream if line.strip()]
    try:
        events = [json.loads(line) for line in lines]
    except ValueError as e:
        sys.exit(f"not NDJSON: {e}")
    errors = validate_stream(events)
    for error in errors:
        print(error)
    print(f"{len(events)} events, {len(errors)} errors")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
