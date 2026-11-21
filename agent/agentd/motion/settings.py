"""The motion backend switch: `game` plays the pack's authored gestures, `generated` asks the motion service for a clip.

motion-settings.json in the state dir holds {backend, service_url}; the service token is apart, in motion-service.token
(0600), and is never returned."""
import json
import os
from pathlib import Path
import threading
from urllib.parse import urlsplit

from fsutil import atomic_write_json
from infra.tokens import read_token, write_secret

BACKENDS = ("game", "generated")
DEFAULT = {"backend": "game", "service_url": None}
MAX_URL = 2048
MAX_TOKEN = 4096


def _url_ok(url):
    if url is None:
        return True
    if not isinstance(url, str) or len(url) > MAX_URL:
        return False
    parts = urlsplit(url)
    return parts.scheme in ("http", "https") and bool(parts.hostname)


class MotionSettings:
    def __init__(self, state_dir):
        self.path = Path(state_dir) / "motion-settings.json"
        self.token_path = Path(state_dir) / "motion-service.token"
        self._lock = threading.Lock()
        try:
            saved = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            saved = DEFAULT
        self.backend, self.service_url = saved["backend"], saved["service_url"]

    def token(self):
        """The service token, or None when none is saved."""
        try:
            return read_token(self.token_path) or None
        except FileNotFoundError:
            return None

    def public(self):
        """GET /motion/settings: the settings without the token."""
        return {"backend": self.backend, "service_url": self.service_url, "token_set": self.token() is not None}

    def update(self, body):
        """PUT /motion/settings {backend, service_url, token?}: (status, reply). A token "" removes the saved one."""
        if not isinstance(body, dict) or not {"backend", "service_url"} <= set(body) \
                or set(body) - {"backend", "service_url", "token"}:
            return 400, {"error": "invalid_payload"}
        if body["backend"] not in BACKENDS:
            return 400, {"error": "invalid_backend"}
        if not _url_ok(body["service_url"]):
            return 400, {"error": "invalid_service_url"}
        token = body.get("token")
        if "token" in body and (not isinstance(token, str) or len(token) > MAX_TOKEN):
            return 400, {"error": "invalid_token"}
        with self._lock:
            if token:
                write_secret(self.token_path, token)
            elif token == "":
                try:
                    os.unlink(self.token_path)
                except FileNotFoundError:
                    pass
            atomic_write_json(self.path, {"backend": body["backend"], "service_url": body["service_url"]})
            self.backend, self.service_url = body["backend"], body["service_url"]
        return 200, self.public()
