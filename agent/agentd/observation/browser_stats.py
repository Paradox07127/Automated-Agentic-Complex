"""Strict numeric browser telemetry. UI-only; no page strings or media URLs are accepted."""
import math


def number(value, maximum, nullable=True):
    return (nullable and value is None) or (type(value) in (int, float) and math.isfinite(value) and 0 <= value <= maximum)


def valid_metrics(value):
    if not isinstance(value, dict) or set(value) != {"scroll_percent", "max_scroll_percent", "media", "tab_count", "audible_tab_count"}:
        return False
    if not all(number(value[k], 100) for k in ("scroll_percent", "max_scroll_percent")):
        return False
    if not all(type(value[k]) is int and 0 <= value[k] <= 100000 for k in ("tab_count", "audible_tab_count")):
        return False
    m = value["media"]
    return m is None or (isinstance(m, dict) and set(m) == {"kind", "state", "position_s", "duration_s", "playback_rate", "muted"}
        and m["kind"] in ("video", "audio") and m["state"] in ("playing", "paused", "ended", "buffering")
        and number(m["position_s"], 31536000) and number(m["duration_s"], 31536000)
        and number(m["playback_rate"], 16, nullable=False) and type(m["muted"]) is bool)


def page_text_allowed(path, startup_allowed=False):
    """Revocation takes effect without restarting; expanding beyond startup consent still needs restart."""
    if not startup_allowed:
        return False
    if path is None:
        return True
    import json
    import os
    from pathlib import Path
    try:
        path = Path(path)
        with path.open(encoding="utf-8") as source:
            body = json.load(source)
            read = os.fstat(source.fileno())
        current = path.stat()
        return ((read.st_ino, read.st_mtime_ns) == (current.st_ino, current.st_mtime_ns)
                and isinstance(body, dict) and body.get("share_page_text") is True)
    except (OSError, ValueError, TypeError):
        return False
