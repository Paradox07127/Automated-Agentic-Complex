"""The motion backend switch: `game` plays the pack's authored gestures, `generated` asks the motion service for a clip.
The service's address is agentd's --motion-url."""
import json
from pathlib import Path
import threading

from fsutil import atomic_write_json
from infra.secrets import setting_secret

BACKENDS = ("game", "generated")
DEFAULT = {"backend": "game"}
MAX_TOKEN = 4096


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
        self.backend = saved["backend"]

    def token(self):
        """The service token, or None when none is saved."""
        value = self.secrets.get(self.token_ref) if self.token_ref else None
        return value.decode() if value else None

    def public(self):
        """GET /motion/settings: the settings without the token."""
        return {"backend": self.backend, "token_set": self.token() is not None}

    def update(self, body):
        """PUT /motion/settings {backend, token?}: (status, reply). A token "" removes the saved one."""
        if not isinstance(body, dict) or "backend" not in body or set(body) - {"backend", "token"}:
            return 400, {"error": "invalid_payload"}
        if body["backend"] not in BACKENDS:
            return 400, {"error": "invalid_backend"}
        token = body.get("token")
        if "token" in body and (not isinstance(token, str) or len(token) > MAX_TOKEN):
            return 400, {"error": "invalid_token"}
        with self._lock:
            saved = {"backend": body["backend"]}
            value = token.strip().encode() if token is not None else None
            with setting_secret(self.secrets, self.token_ref, "motion-", value) as ref:
                if ref:
                    saved["token_ref"] = ref
                atomic_write_json(self.path, saved)
            self.backend, self.token_ref = saved["backend"], ref
        return 200, self.public()
