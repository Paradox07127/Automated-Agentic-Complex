"""Module helpers the api and daemon modules share: JSON views, times and request checks."""
import datetime
import os
import re
import time

from observation.blacklist import bare_host
from daemon.constants import RAW_KINDS, RAW_TEXT, RAW_PAST, RAW_AHEAD
from sessions import threads
from traces.trace_format import HEAD_MAX

MAX_FACT = 500
# Fields that change with the clock alone: they do not move a block's updated_at.
DIAG_VOLATILE = {"phases_ms", "cooldown_s", "cross_cooldown_s", "dwell_s", "waited_ms"}
NO_PERMISSION = {"secure_input", "blacklisted", "incognito", "permission_denied"}
RAW_COUNTS = ("value_len", "shrink", "edits")
# POST /context/timeline: the record kinds, and the cap of each string field
TIMELINE_KINDS = ("window", "click", "context_menu", "shortcut", "submit", "text_input", "selection")
TIMELINE_TEXT = {"app": None, "bundle_id": None, "window_title": 500, "keys": 64, "text": 2000}
TARGET_TEXT = {"role": 200, "subrole": 200, "title": 200, "description": 200, "identifier": 200, "value": 2000}
TREE_MAX = 32000


def _fact_text(body):
    text = body.get("text") if isinstance(body, dict) else None
    return text if isinstance(text, str) and text.strip() and len(text) <= MAX_FACT else None


def _url_host(value):
    return value is None or isinstance(value, str) and bool(bare_host(value))


def _window_id(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _is_dir(value):
    return isinstance(value, str) and os.path.isdir(value)


def _focus_window(value):
    return value is None or isinstance(value, dict) \
        and all(isinstance(value.get(k), (str, type(None))) for k in ("role", "subrole"))


def _raw_event(event, now):
    """One POST /context/events entry as an events_raw row (long strings cut, pid left out), or None when it is
    malformed, a kind the Companion may not send, or outside the ts window."""
    integer = lambda v: isinstance(v, int) and not isinstance(v, bool)  # noqa: E731
    if not isinstance(event, dict) or event.get("kind") not in RAW_KINDS or not isinstance(event.get("app"), str):
        return None
    ts = event.get("ts")
    if not (isinstance(ts, (int, float)) and not isinstance(ts, bool) and now - RAW_PAST <= ts <= now + RAW_AHEAD):
        return None
    if event.get("pid") is not None and not integer(event["pid"]) \
            or not isinstance(event.get("url_host"), (str, type(None))):
        return None
    row = {"ts": float(ts), "kind": event["kind"]}
    for field, limit in RAW_TEXT.items():
        value = event.get(field)
        if not isinstance(value, (str, type(None))):
            return None
        row[field] = value if value is None or field == "value" else value[:limit]
        if field == "value" and value is not None and len(value)>limit: return None
    for field in RAW_COUNTS:
        value = event.get(field)
        if value is not None and not (integer(value) and value >= 0):
            return None
        row[field] = value
    host = event.get("url_host")
    row["url_host"] = host if host is not None and bare_host(host) else None  # a host only, never a URL
    return row


def _timeline_record(record, now):
    """One POST /context/timeline record with long strings cut, or None when a field has the wrong type, the kind is
    unknown or ts is outside the /context/events window."""
    optional_int = lambda v: v is None or (isinstance(v, int) and not isinstance(v, bool)  # noqa: E731
                                           and -2 ** 63 <= v < 2 ** 63)  # what a SQLite INTEGER holds
    optional_str = lambda v: v is None or isinstance(v, str)  # noqa: E731
    cut = lambda v, limit: v if v is None or limit is None else v[:limit]  # noqa: E731
    if not isinstance(record, dict) or record.get("kind") not in TIMELINE_KINDS:
        return None
    ts = record.get("ts")
    if not (isinstance(ts, (int, float)) and not isinstance(ts, bool) and now - RAW_PAST <= ts <= now + RAW_AHEAD):
        return None
    target, tree = record.get("target"), record.get("tree")
    if not (all(optional_int(record.get(k)) for k in ("pid", "window_id"))
            and all(optional_str(record.get(k)) for k in (*TIMELINE_TEXT, "url_host"))
            and (target is None or isinstance(target, dict) and all(optional_str(target.get(k)) for k in TARGET_TEXT))
            and (tree is None or isinstance(tree, dict) and tree.get("mode") in ("full", "diff")
                 and isinstance(tree.get("text"), str))):
        return None
    row = {"ts": float(ts), "kind": record["kind"], "pid": record.get("pid"), "window_id": record.get("window_id")}
    row.update({k: cut(record.get(k), limit) for k, limit in TIMELINE_TEXT.items()})
    host = record.get("url_host")
    row["url_host"] = host if host is not None and bare_host(host) else None  # a host only, never a URL
    row["target"] = None if target is None else {k: cut(target.get(k), limit) for k, limit in TARGET_TEXT.items()}
    row["tree"] = None if tree is None else {"mode": tree["mode"], "text": tree["text"][:TREE_MAX]}
    return row


def _midnight(t=None):
    """Local midnight of the day of t (default now)."""
    day = datetime.datetime.now() if t is None else datetime.datetime.fromtimestamp(t)
    return day.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()


def _marked(markers, chunk):
    """markers.feed(chunk), and [(offset in its text, intent)] for each intent it found."""
    text, intents, points, at = "", [], [], []
    for part in re.split(r"(?<=\])", chunk):  # a part closes at most one marker, at its end
        found = markers.feed(part)
        text += found[0]
        intents += found[1]
        points += found[2]
        at += [(len(text), intent) for intent in found[1]]
    return (text, intents, points), at


def _ms_since(start):
    return max(0, round((time.monotonic() - start) * 1000))


def _ms(start, end):
    return max(0, round((end - start) * 1000))


def _iso(t):
    return datetime.datetime.fromtimestamp(t).astimezone().isoformat(timespec="milliseconds")


def _episode_json(episode):
    """An episode of Episodes.day() or get() as GET /episodes lists it."""
    number = {}
    for thread in episode['threads']:
        for ref in thread.get('evidence', []):
            number.setdefault(ref, len(number) + 1)
    episode = {**episode, 'threads':[{**t,'source_ids':t.get('evidence',[]),
        'evidence':[number[v] for v in t.get('evidence',[])]} for t in episode['threads']]}
    defaults = {"session": None, "status": None, "progress": None, "topic": None, "blocked": None,
                "subject": None, "goal": None, "outcome": None,
                "evidence": [], "source_ids": [], "constraints": [], "decisions": [], "unresolved": [],
                "next_steps": [], "requires": [], "scope_ids": []}
    episode = {**episode, "threads": [{**defaults, **thread} for thread in episode["threads"]]}
    return {**episode, "start": _iso(episode["start"]), "end": _iso(episode["end"]),
            "created_at": _iso(episode["created_at"])}


def _thread_json(thread):
    """A thread of threads.merge() as GET /episodes?date= lists it: status only when threads.STATES names it, progress
    only while it is not done."""
    status = thread["status"] if thread["status"] in threads.STATES else None
    return {"session": thread["session"], "yours_minutes": round(thread["yours_time"] / 60),
            "agent_minutes": round(thread["agent_time"] / 60), "status": status,
            "progress": thread["progress"] if status not in (None, "done") else None}


def _shown(value, with_text):
    """A text value in /diag/state: {len, head}, plus the whole text only with with_text=1."""
    if value is None:
        return None
    shown = {"len": len(value), "head": value[:HEAD_MAX]}
    return {**shown, "text": value} if with_text else shown


def _stable(value):
    """value without DIAG_VOLATILE fields, to tell a real change from the clock moving."""
    if isinstance(value, dict):
        return {k: _stable(v) for k, v in value.items() if k not in DIAG_VOLATILE}
    if isinstance(value, list):
        return [_stable(v) for v in value]
    return value


def _settled_at(record):
    """When a capture observation ended; a cancelled one keeps no time, so its request time stands in."""
    return record["observed_at"] or (record["expires_at"] if record["status"] == "expired" else record["requested_at"])


def _why(state, detail):
    """no_permission,capture_failed, not_connected, expired or unavailable."""
    if state == "declined" or detail in NO_PERMISSION:
        return "no_permission"
    if state == "failed":
        return "capture_failed"
    if detail == "vision_off":
        return "not_connected"
    return "expired" if state == "expired" else "unavailable"
