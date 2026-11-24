"""Live consent shared by collection, cached context and model dispatch.

The saved native configuration can narrow startup capabilities, never silently grant new ones.
Unreadable or concurrently replaced files fail closed. Revocations remain queued until applied.
"""
import json
import os
from pathlib import Path
import threading

_PARSED = {}  # path -> ((st_ino, st_mtime_ns, st_size), body) of its last good read; callers only read the body


def _saved(path):
    path = Path(path)
    current = path.stat()
    key = (current.st_ino, current.st_mtime_ns, current.st_size)
    cached = _PARSED.get(str(path))
    if cached is not None and cached[0] == key:
        return cached[1]
    with path.open(encoding="utf-8") as source:
        body = json.load(source)
        read = os.fstat(source.fileno())
    current = path.stat()
    if (read.st_ino, read.st_mtime_ns) != (current.st_ino, current.st_mtime_ns) or not isinstance(body, dict):
        raise ValueError("changing policy")
    _PARSED[str(path)] = ((read.st_ino, read.st_mtime_ns, read.st_size), body)
    return body


def saved_switch(path, key, *, default=False):
    """Whether the saved key is true; unreadable files always fail closed."""
    try:
        return _saved(path).get(key, default) is True
    except (OSError, ValueError, TypeError):
        return False


def saved_consent(path, capabilities):
    if path is None:
        return dict(capabilities), "focused"
    try:
        body = _saved(path)
        return {"window_text": bool(capabilities["window_text"] and body.get("share_window_text") is True
                                    and body.get("screen_context_level", "focused") in ("focused", "window")),
                "page_text": bool(capabilities["page_text"] and body.get("share_page_text") is True),
                "screenshots": bool(capabilities["screenshots"] and body.get("share_screenshots") is True),
                "typed_text": bool(capabilities["typed_text"] and body.get("share_typed_text") is True),
                "agent_sessions": bool(capabilities.get("agent_sessions", False) and body.get("share_agent_sessions", True) is True)}, body.get("screen_context_level", "focused")
    except (OSError, ValueError, TypeError):
        return dict.fromkeys(capabilities, False), "status"


class ConsentPolicy:
    def __init__(self, path, capabilities):
        self.path, self.capabilities = path, capabilities
        self.lock = threading.RLock()
        self.permissions = None
        self.level = None
        self.epoch = 0
        self.revoked = set()

    def snapshot(self):
        # Read under the lock: a slower old read cannot overwrite a newer revocation.
        with self.lock:
            capabilities = self.capabilities()
            permissions, level = saved_consent(self.path(), capabilities)
            before = capabilities if self.permissions is None else self.permissions
            if permissions != self.permissions or level != self.level:
                self.epoch += 1
                self.revoked.update(k for k in before if before[k] and not permissions[k])
                if self.level == "window" and level != "window":
                    self.revoked.add("window_text")
                self.permissions = permissions
                self.level = level
            return dict(permissions), self.epoch

    def pending(self):
        """The queued revocations and the epoch they were read at; they stay queued until applied, so a second
        sync_privacy while one applies them applies them too instead of returning early."""
        with self.lock:
            return set(self.revoked), self.epoch

    def applied(self, kinds, epoch):
        """kinds leave the queue unless consent changed since pending read them: a kind revoked again applies again."""
        with self.lock:
            if self.epoch == epoch:
                self.revoked -= kinds

    def revoke(self, kinds):
        """A native save tombstone survives a quick off/on that a file poll could otherwise miss."""
        with self.lock:
            if kinds:
                self.epoch += 1
                self.revoked.update(kinds)
