"""Parses harness event ledger lines (read by /day/segments and the day summary).

Ledger layout: <root>/<project key>/<local date>/<session>[.<writer>].jsonl."""
import datetime
import json

from infra.paths import LEDGER_ROOT as DEFAULT_ROOT


def parse(raw):
    """One ledger line -> {ts, event_name, severity, attributes}; None if unreadable."""
    try:
        record = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(record, dict) or not isinstance(record.get("event_name"), str):
        return None
    attributes = record.get("attributes")
    try:
        stamp = str(record.get("timestamp", "")).replace("Z", "+00:00")
        ts = datetime.datetime.fromisoformat(stamp).timestamp()
    except ValueError:
        ts = None
    return {"ts": ts, "event_name": record["event_name"],
            "severity": record.get("severity_text") or "INFO",
            "attributes": attributes if isinstance(attributes, dict) else {}}


# Announcement kinds that end what they report on; every other kind is progress.
TERMINAL = frozenset({"dispatch_done", "dispatch_returned", "dispatch_review", "dispatch_failed", "dispatch_closed",
                      "session_failed", "agent_failed", "mmrun_done", "task_expired", "task_interrupted",
                      "reminder_set", "reminder_due", "reminder_missed"})
