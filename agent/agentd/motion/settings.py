"""The motion backend switch: `game` plays the pack's authored gestures, `generated` asks the motion service for a clip."""
import json
from pathlib import Path
import threading
from urllib.parse import urlsplit

from fsutil import atomic_write_json
from infra.secrets import setting_secret

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
    def __init__(self, state_dir, secrets):
        self.secrets = secrets
        self.path = Path(state_dir) / "motion-settings.json"
        self._lock = threading.Lock()
        try:
            saved = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            saved = DEFAULT
        self.token_ref = saved.get("token_ref")
        self.backend, self.service_url = saved["backend"], saved["service_url"]

    def token(self):
        """The service token, or None when none is saved."""
        value = self.secrets.get(self.token_ref) if self.token_ref else None
        return value.decode() if value else None

    def endpoint(self):
        with self._lock:
            return self.service_url, self.token()

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
            saved = {"backend": body["backend"], "service_url": body["service_url"]}
            value = token.strip().encode() if token is not None else None
            if value is None and body["service_url"] != self.service_url:
                value = b""
            with setting_secret(self.secrets, self.token_ref, "motion-", value) as ref:
                if ref:
                    saved["token_ref"] = ref
                atomic_write_json(self.path, saved)
            self.backend, self.service_url, self.token_ref = saved["backend"], saved["service_url"], ref
        return 200, self.public()
