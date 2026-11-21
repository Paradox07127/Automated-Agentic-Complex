import contextlib
import io
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tools import tts_token  # noqa: E402


class FakeRun:
    def __init__(self, code=0):
        self.code, self.calls = code, []

    def __call__(self, argv, input=None, **kwargs):
        self.calls.append((argv, input))
        return type("Done", (), {"returncode": self.code})()


class TtsTokenTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "sub" / "tts-token"

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_ensure_creates_a_private_token_once(self):
        tts_token.ensure(self.path)
        first = self.path.read_text(encoding="utf-8")
        self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), 0o600)
        self.assertGreaterEqual(len(first.strip()), 40)
        tts_token.ensure(self.path)
        self.assertEqual(self.path.read_text(encoding="utf-8"), first)

    def test_push_sends_the_token_on_stdin_never_in_argv(self):
        tts_token.ensure(self.path)
        run = FakeRun()
        tts_token.push(self.path, "ws", "/srv/tts/state/tts-token", run=run)
        [(argv, given)] = run.calls
        token = self.path.read_text(encoding="utf-8").strip()
        self.assertEqual(argv[:2], ["ssh", "ws"])
        self.assertNotIn(token, " ".join(argv))
        self.assertEqual(given, token + "\n")
        self.assertIn("umask 077", argv[2])
        self.assertIn("/srv/tts/state/tts-token", argv[2])

    def test_failed_rotation_keeps_the_old_token(self):
        tts_token.ensure(self.path)
        old = self.path.read_text(encoding="utf-8")
        with self.assertRaises(SystemExit):
            tts_token.rotate(self.path, "ws", "/remote/tts-token", run=FakeRun(code=255))
        self.assertEqual(self.path.read_text(encoding="utf-8"), old)
        self.assertFalse(self.path.with_name("tts-token.new").exists())

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_rotation_replaces_both_sides_with_one_new_token(self):
        tts_token.ensure(self.path)
        old = self.path.read_text(encoding="utf-8")
        run = FakeRun()
        tts_token.rotate(self.path, "ws", "/remote/tts-token", run=run)
        new = self.path.read_text(encoding="utf-8")
        self.assertNotEqual(new, old)
        self.assertEqual(run.calls[0][1], new.strip() + "\n")
        self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), 0o600)

    def main(self, *argv, env=None):
        """tts_token.main() with argv and only env set; returns (exit code, stderr) when it exits."""
        environ = {k: v for k, v in os.environ.items() if k not in ("AAC_TTS_SSH_HOST", "AAC_TTS_TOKEN_REMOTE")}
        environ.update(env or {})
        err = io.StringIO()
        with mock.patch.dict(os.environ, environ, clear=True), mock.patch.object(sys, "argv", ["tts_token.py", *argv]), \
                mock.patch.object(tts_token, "push") as push, contextlib.redirect_stderr(err), \
                contextlib.redirect_stdout(io.StringIO()):
            try:
                tts_token.main()
            except SystemExit as e:
                return e.code, err.getvalue(), push
        return None, err.getvalue(), push

    def test_push_and_rotate_without_host_or_remote_exit_naming_what_to_set(self):
        for action in ("push", "rotate"):
            code, err, push = self.main(action, "--file", str(self.path), env={"AAC_TTS_TOKEN_REMOTE": "/r/tts-token"})
            self.assertNotEqual(code, None, action)
            self.assertIn("AAC_TTS_SSH_HOST", err)
            self.assertIn("--ssh", err)
            code, err, push = self.main(action, "--file", str(self.path), env={"AAC_TTS_SSH_HOST": "voice-box"})
            self.assertNotEqual(code, None, action)
            self.assertIn("AAC_TTS_TOKEN_REMOTE", err)
            self.assertIn("--remote", err)
            push.assert_not_called()

    def test_push_reads_host_and_remote_from_the_environment(self):
        code, _, push = self.main("push", "--file", str(self.path),
                                  env={"AAC_TTS_SSH_HOST": "voice-box", "AAC_TTS_TOKEN_REMOTE": "/r/tts-token"})
        self.assertIsNone(code)
        push.assert_called_once_with(self.path, "voice-box", "/r/tts-token")

    def test_ensure_needs_neither_host_nor_remote(self):
        code, _, _ = self.main("ensure", "--file", str(self.path))
        self.assertIsNone(code)
        self.assertTrue(self.path.exists())


if __name__ == "__main__":
    unittest.main()
