"""Exercise real main startup, bundled context, and installed hooks before the first session event."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request

AGENTD = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AGENTD / "tools"))
import install_hooks  # noqa: E402


class HookStartupTest(unittest.TestCase):
    @unittest.skipIf(sys.platform == "win32", "harness discovery and install look only in POSIX locations")
    def test_main_detects_installed_claude_without_any_hook_event(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            claude, codex = home / ".claude/settings.json", home / ".codex"
            claude.parent.mkdir(); codex.mkdir()
            state = home / "state"
            process = subprocess.Popen(
                [sys.executable, str(AGENTD / "server.py"), "--port", "0", "--state-dir", str(state),
                 "--no-proactive", "--mute", "--observation-off", "--ledger-root", str(home / "no-ledger")],
                env={**os.environ, "HOME": str(home)}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            try:
                runtime = state / "ui-runtime.json"
                deadline = time.monotonic() + 10
                while not runtime.exists() and process.poll() is None and time.monotonic() < deadline:
                    time.sleep(.02)
                self.assertTrue(runtime.exists(), "agentd main did not start")
                info = json.loads(runtime.read_text(encoding="utf-8"))
                request = urllib.request.Request(info["base_url"] + "/model/settings",
                                                 headers={"Authorization": "Bearer " + info["ui_token"]})
                with urllib.request.urlopen(request, timeout=3) as reply:
                    self.assertTrue(json.load(reply)["mouth_ready"], "fresh state must have a guarded Mouth")
                self.assertFalse((state / "canon-windows.json").exists(), "bundled hashes must stay read-only")
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(install_hooks.main([
                        "--claude-settings", str(claude), "--codex-home", str(codex),
                        "--url", info["base_url"], "--token-file", str(state / "hook.token")]), 0)

                def hooks():
                    request = urllib.request.Request(info["base_url"] + "/diag/state",
                                                     headers={"Authorization": "Bearer " + info["ui_token"]})
                    with urllib.request.urlopen(request, timeout=3) as reply:
                        return json.load(reply)["hooks"]

                status = hooks()
                for agent in ("claude", "codex"):
                    self.assertTrue(status[agent]["installed"], agent)
                    self.assertIsNone(status[agent]["last_at"], "no synthetic hook event may mask installation")
                claude.unlink()
                self.assertFalse(hooks()["claude"]["installed"])
                self.assertTrue(hooks()["codex"]["installed"])
            finally:
                if process.poll() is None:
                    process.terminate()
                try:
                    process.communicate(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill(); process.communicate()

    def test_main_rejects_corrupt_user_index_instead_of_using_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            state = home / "state"
            state.mkdir()
            index = state / "canon-windows.json"
            invalid = b'{"n":7,"hashes":[]}'
            index.write_bytes(invalid)
            process = subprocess.run(
                [sys.executable, str(AGENTD / "server.py"), "--port", "0", "--state-dir", str(state),
                 "--no-proactive", "--mute", "--observation-off", "--ledger-root", str(home / "no-ledger")],
                env={**os.environ, "HOME": str(home)}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                timeout=10)
            self.assertNotEqual(process.returncode, 0, process.stdout.decode(errors="replace"))
            self.assertIn(b"ValueError", process.stdout)
            self.assertFalse((state / "ui-runtime.json").exists(), "unguarded server must not accept requests")
            self.assertEqual(index.read_bytes(), invalid)


if __name__ == "__main__":
    unittest.main()
