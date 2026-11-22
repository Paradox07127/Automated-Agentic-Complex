"""C9: `--describe` prints protocol/C9-agentd-process/examples/describe.json, and a real agentd writes discovery files
with the examples' keys and JSON types."""
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest

AGENTD = Path(__file__).resolve().parents[1]
ROOT = AGENTD.parents[1]
EXAMPLES = ROOT / "protocol/C9-agentd-process/examples"
LAUNCHER = ROOT / "app/Resources/agentd_launcher.py"


def shape(value):
    return {key: type(item) for key, item in value.items()}


class DescribeTest(unittest.TestCase):
    def test_describe_prints_the_example_and_touches_no_state_dir(self):
        expected = (EXAMPLES / "describe.json").read_text(encoding="utf-8")
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "state"
            for argv in ([sys.executable, str(AGENTD / "server.py"), "--describe", "--state-dir", str(state)],
                         [sys.executable, "-I", str(LAUNCHER), "--agentd-dir", str(AGENTD), "--", "--describe",
                          "--state-dir", str(state)]):
                with self.subTest(argv[1]):
                    done = subprocess.run(argv, capture_output=True, text=True, timeout=60, encoding="utf-8")
                    self.assertEqual((done.returncode, done.stdout), (0, expected), done.stderr)
                    self.assertFalse(state.exists())


class DiscoveryFilesTest(unittest.TestCase):
    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_written_files_match_the_examples(self):
        with tempfile.TemporaryDirectory(prefix="efc9-") as tmp:
            state, ledger = Path(tmp) / "state", Path(tmp) / "ledger"
            ledger.mkdir()
            proc = subprocess.Popen([sys.executable, str(AGENTD / "server.py"), "--port", "0", "--state-dir", str(state),
                                     "--ledger-root", str(ledger), "--character", "aster", "--no-proactive"],
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=str(AGENTD))
            try:
                files = [state / "ui-runtime.json", state / "events-runtime.json"]
                deadline = time.monotonic() + 15
                while not all(f.exists() for f in files) and time.monotonic() < deadline and proc.poll() is None:
                    time.sleep(0.05)
                if not all(f.exists() for f in files):
                    proc.kill()
                    self.fail(f"agentd did not start: {proc.stdout.read().decode(errors='replace')}")
                for written in files:
                    with self.subTest(written.name):
                        value = json.loads(written.read_text(encoding="utf-8"))
                        self.assertEqual(shape(value), shape(json.loads((EXAMPLES / written.name).read_text(encoding="utf-8"))))
                        self.assertEqual(value["schema"], 1)
                        self.assertEqual(value["base_url"].rsplit(":", 1)[0], "http://127.0.0.1")
                        self.assertEqual(stat.S_IMODE(os.stat(written).st_mode), 0o600)
            finally:
                proc.terminate()
                proc.wait(10)
                proc.stdout.close()


CLEAN_EXIT = "agentd: shut down cleanly"
# Run as the Companion's stand-in: starts the launcher with itself as --parent-pid, its own stdin and stdout, and exits
# once agentd is ready.
PARENT = """
import pathlib, subprocess, sys, os, time
launcher, agentd, state = sys.argv[1:4]
proc = subprocess.Popen([sys.executable, "-I", launcher, "--agentd-dir", agentd, "--parent-pid", str(os.getpid()), "--",
                         *sys.argv[4:]], stdin=0, stdout=1, stderr=subprocess.STDOUT)
deadline = time.monotonic() + 120
while not (pathlib.Path(state) / "ui-runtime.json").exists() and proc.poll() is None and time.monotonic() < deadline:
    time.sleep(0.1)
"""


class LauncherStopTest(unittest.TestCase):
    def agentd_args(self, tmp):
        state, ledger = Path(tmp) / "state", Path(tmp) / "ledger"
        ledger.mkdir()
        return state, ["--port", "0", "--state-dir", str(state), "--ledger-root", str(ledger), "--character", "aster",
                       "--no-proactive", "--mute", "--plugin-off", "screen_awareness"]

    def test_stop_request_runs_shutdown_cleanly_and_exits_0(self):
        """The Companion asks for a stop with SIGTERM, or on Windows, which has none, by closing agentd's stdin."""
        with tempfile.TemporaryDirectory(prefix="efc9-") as tmp:
            state, args = self.agentd_args(tmp)
            log = Path(tmp) / "agentd.log"
            with open(log, "wb") as out:
                proc = subprocess.Popen([sys.executable, "-I", str(LAUNCHER), "--agentd-dir", str(AGENTD),
                                         "--parent-pid", str(os.getpid()), "--", *args],
                                        stdin=subprocess.PIPE, stdout=out, stderr=subprocess.STDOUT)
            try:
                deadline = time.monotonic() + 120
                while not (state / "ui-runtime.json").exists() and proc.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.1)
                self.assertTrue((state / "ui-runtime.json").exists(), log.read_text(encoding="utf-8", errors="replace"))
                if sys.platform == "win32":
                    proc.stdin.close()
                else:
                    proc.terminate()
                code = proc.wait(30)
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(10)
                if not proc.stdin.closed:
                    proc.stdin.close()
            text = log.read_text(encoding="utf-8", errors="replace")
            self.assertEqual(code, 0, text)
            self.assertIn(CLEAN_EXIT, text)

    def test_parent_exit_ends_agentd(self):
        tmp = tempfile.mkdtemp(prefix="efc9-")
        try:
            state, args = self.agentd_args(tmp)
            # This test keeps agentd's stdin open, so only the parent's exit can end it.
            read, write = os.pipe()
            try:
                parent = subprocess.Popen([sys.executable, "-I", "-c", PARENT, str(LAUNCHER), str(AGENTD), str(state),
                                           *args], stdin=read, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                os.close(read)
                # agentd holds the stdout pipe until it exits.
                output = parent.communicate(timeout=180)[0].decode("utf-8", "replace")
            finally:
                os.close(write)
            self.assertIn("agentd listening on", output)
            if sys.platform == "win32":  # POSIX ends agentd at once, without cleanup (C9)
                self.assertIn(CLEAN_EXIT, output)
        finally:
            # On Windows agentd's open files keep the directory until its process is gone, a moment after its stdout.
            deadline = time.monotonic() + 30
            while True:
                try:
                    shutil.rmtree(tmp)
                    break
                except PermissionError:
                    if time.monotonic() > deadline:
                        raise
                    time.sleep(0.2)


if __name__ == "__main__":
    unittest.main()
