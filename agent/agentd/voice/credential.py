"""The shell revokes the TTS reference on an origin change, even while agentd is offline."""
from contextlib import contextmanager
from pathlib import Path
import uuid

from infra.secrets import ModelError
from infra.tokens import read_token, write_secret


@contextmanager
def _private_files():
    try:
        yield
    except (OSError, SystemExit) as error:
        raise ModelError("secret_store_unavailable") from error


def _read_reference(path):
    try:
        return read_token(path)
    except FileNotFoundError:
        return None


class TtsCredential:
    def __init__(self, path, secrets):
        self.ref = Path(str(path) + ".ref")
        self.revoked = Path(str(path) + ".revoked")
        self.secrets = secrets

    def _retire(self):
        with _private_files():
            ref = _read_reference(self.revoked)
            if ref:
                self.secrets.delete("tts-" + ref)
                self.revoked.unlink(missing_ok=True)

    def get(self):
        self._retire()
        with _private_files():
            ref = _read_reference(self.ref)
        value = self.secrets.get("tts-" + ref) if ref else None
        return value.decode() if value is not None else None

    @contextmanager
    def stage(self, token):
        """Prepare the protected token and reference before changing the remote service."""
        self._retire()
        ref = uuid.uuid4().hex
        staged = self.ref.with_name(self.ref.name + "." + ref)
        self.secrets.put("tts-" + ref, token.encode())
        try:
            with _private_files():
                self.ref.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                write_secret(staged, ref)
            yield
            with _private_files():
                if self.ref.exists():
                    self.ref.replace(self.revoked)
                staged.replace(self.ref)
        except BaseException:
            self.secrets.delete("tts-" + ref)
            raise
        finally:
            staged.unlink(missing_ok=True)
        self._retire()

    def put(self, token):
        with self.stage(token):
            pass
