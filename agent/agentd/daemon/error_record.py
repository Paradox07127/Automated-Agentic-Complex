"""`<support>/logs/agentd-error.jsonl`: one JSON line per error agentd sees, in the shell's error.jsonl envelope
`{t, component, code, message, detail?, turn_id?, trace_id?, req?, count}` with component "agentd"; repeats of a
(component, code, message) within a minute fold into one line with their count. A file of its own: two processes
appending to one file is unsafe on Windows. No prompt text, tool input, file contents, query values or secrets.

Codes (every `code` a record carries):
- `http_4xx`, `http_5xx`: a route answered an error without a code of its own; else the reply's own `error` code.
  `message` `<route> <status>`, `req` the route.
- `internal_error`: an uncaught exception in a route; `message` `<route>: <exception class>: <first line>`.
- a failed turn's code, the same as its `turn.settled` `error_code`: an exception becomes `timeout`, `auth_expired`,
  `rate_limited`, `network`, `cli_exit_<n>` or `unknown`; a code agentd or the harness already names (a lowercase
  slug such as `select_model`) stays. `message` `<source> turn failed: <exception class or code>`.
- `speech_failed`: the TTS gave a turn's speech no audio, once per turn; `message` `<reason> from <host>`.
- `tts_token_missing`: agentd starts with a TTS URL but no saved token.
- `permission_denied`: the shell reports a missing system grant; `message` names the grant.
"""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import threading
import time

WINDOW_S = 60  # repeats within it fold into one count line
MESSAGE_MAX, DETAIL_MAX = 300, 500
FILE = "agentd-error.jsonl"
SLUG = re.compile(r"[a-z][a-z0-9_]{0,99}")


def failure(error):
    """(code, message) of a failed turn. error: the exception, or the code its reply carried (an exception class name
    or agentd's own slug), or None."""
    status = None
    if isinstance(error, BaseException):
        code = getattr(error, "code", None)
        if isinstance(code, str) and code:
            return failure(code)
        if isinstance(getattr(error, "returncode", None), int):
            return f"cli_exit_{error.returncode}", type(error).__name__
        status = next((v for v in (code, getattr(error, "status", None), getattr(error, "status_code", None))
                       if isinstance(v, int)), None)
        error = type(error).__name__
    if not error:
        return "unknown", "unknown"
    if SLUG.fullmatch(error):
        return error, error
    name = error.lower()
    if status in (401, 403) or any(w in name for w in ("auth", "unauthorized", "forbidden")):
        code = "auth_expired"
    elif status == 429 or any(w in name for w in ("ratelimit", "rate_limit", "toomanyrequests")):
        code = "rate_limited"
    elif "timeout" in name or "timedout" in name:
        code = "timeout"
    elif any(w in name for w in ("connect", "network", "socket", "urlerror", "disconnect", "brokenpipe", "gaierror",
                                 "ssl", "transport")):
        code = "network"
    else:
        code = "unknown"
    return code, error[:MESSAGE_MAX]


def appender(path):
    """A write for ErrorLog that appends to path (0600), creating its folder; a failed write is dropped."""
    path = Path(path)

    def write(line):
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            try:
                os.write(fd, line.encode("utf-8"))
            finally:
                os.close(fd)
        except OSError:
            pass
    return write


class ErrorLog:
    """The first record of a (component, code, message) is written at once; its repeats are one line with their count
    once its minute is over, and while they go on, one line a minute. flush() is called at least once a minute."""

    def __init__(self, write, clock=time.time):
        self.write, self.clock = write, clock
        self.lock = threading.Lock()
        self.open = {}  # (component, code, message) -> {start, repeats, last, last_at}

    def record(self, code, message, detail=None, turn_id=None, trace_id=None, req=None, component="agentd"):
        record = {"component": component, "code": code, "message": message[:MESSAGE_MAX]}
        if detail is not None:
            record["detail"] = detail[:DETAIL_MAX]
        record.update({k: v for k, v in (("turn_id", turn_id), ("trace_id", trace_id), ("req", req)) if v is not None})
        self.flush()
        at = self.clock()
        with self.lock:
            key = (component, code, record["message"])
            held = self.open.get(key)
            if held is not None:
                held.update(repeats=held["repeats"] + 1, last=record, last_at=at)
                return
            self.open[key] = {"start": at, "repeats": 0, "last": record, "last_at": at}
        self._line(record, at, 1)

    def flush(self, everything=False):
        """Writes the count of each minute that is over; every held count with everything, as at exit."""
        at, lines = self.clock(), []
        with self.lock:
            for key, held in list(self.open.items()):
                if not everything and at - held["start"] < WINDOW_S:
                    continue
                if held["repeats"] == 0 or everything:
                    del self.open[key]
                if held["repeats"]:
                    lines.append((held["last"], held["last_at"], held["repeats"]))
                    held.update(start=at, repeats=0)
        for record, when, count in lines:
            self._line(record, when, count)

    def _line(self, record, at, count):
        t = datetime.fromtimestamp(at, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        self.write(json.dumps({"t": t, **record, "count": count}, ensure_ascii=False) + "\n")
