"""A real agentd on a free port leaves no own-session process behind when it is stopped or its parent dies."""
import http.client
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

AGENTD = Path(__file__).resolve().parents[1] / "server.py"
# Stands in for `claude` on PATH: starts a grandchild, records both pids in $G12_PIDS, then waits on stdin.
FAKE_CLAUDE = f"""#!{sys.executable}
import os, subprocess, sys
if "-p" not in sys.argv:  # agentd's runtime probes (auth status, --version) also find this claude
    sys.exit(0)
pids = [os.getpid(), subprocess.Popen(["sleep", "60"]).pid]
path = os.environ["G12_PIDS"]
with open(path + ".tmp", "w") as f:
    f.write(" ".join(map(str, pids)))
os.replace(path + ".tmp", path)
sys.stdin.read()
"""
# Starts agentd (argv[1:]) with its output on stderr, prints its pid and waits for it.
PARENT = "import subprocess, sys; p = subprocess.Popen(sys.argv[1:], stdout=sys.stderr); print(p.pid, flush=True); p.wait()"


def exists(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


class ShutdownEndToEndTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32", prefix="efg12-")
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        (self.root / "bin").mkdir()
        (self.root / "ledger").mkdir()
        claude = self.root / "bin" / "claude"
        claude.write_text(FAKE_CLAUDE, encoding="utf-8")
        claude.chmod(0o755)
        self.pids_file = self.root / "pids"
        self.env = {**os.environ, "PATH": f"{self.root / 'bin'}:{os.environ.get('PATH', '')}",
                    "G12_PIDS": str(self.pids_file)}
        self.argv = [sys.executable, str(AGENTD), "--port", "0", "--state-dir", str(self.root / "state"),
                     "--ledger-root", str(self.root / "ledger"), "--no-proactive"]
        self.log = open(self.root / "agentd.log", "wb")
        self.addCleanup(self.log.close)
        self.started = []  # every pid this test may leave behind; killed in cleanup

    def tearDown(self):
        for pid in self.started:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + 5
        while any(map(exists, self.started)) and time.monotonic() < deadline:
            time.sleep(0.02)

    def output(self):
        self.log.flush()
        return (self.root / "agentd.log").read_text(errors="replace", encoding="utf-8")

    def wait(self, predicate, timeout, what):
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() > deadline:
                self.fail(f"{what}\n{self.output()}")
            time.sleep(0.05)

    def open_session(self):
        """Start one own Claude session over HTTP; the pids its fake claude recorded."""
        runtime = self.root / "state" / "ui-runtime.json"
        self.wait(runtime.exists, 15, "agentd did not start")
        runtime = json.loads(runtime.read_text(encoding="utf-8"))
        token, port = runtime["ui_token"], int(runtime["base_url"].rsplit(":", 1)[1])
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        conn.request("POST", "/sessions", json.dumps({"target": "claude", "cwd": str(self.root), "prompt": "等着"}),
                     {"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
        response = conn.getresponse()
        self.assertEqual(response.status, 201, response.read())
        conn.close()
        self.wait(self.pids_file.exists, 10, "the fake claude did not start")
        pids = [int(pid) for pid in self.pids_file.read_text(encoding="utf-8").split()]
        self.started += pids
        self.assertTrue(all(map(exists, pids)))
        return pids

    def assertGone(self, pids, within=1.0):
        # An orphaned process is reaped by launchd, not at once.
        deadline = time.monotonic() + within
        while (alive := [pid for pid in pids if exists(pid)]) and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertEqual(alive, [], self.output())

    @unittest.skipIf(sys.platform == "win32", "the test needs POSIX signals, pty or time.tzset")
    def test_sigterm_leaves_no_child_behind(self):
        agentd = subprocess.Popen(self.argv, stdout=self.log, stderr=subprocess.STDOUT, env=self.env,
                                  cwd=str(AGENTD.parent))
        self.started.append(agentd.pid)
        self.addCleanup(agentd.wait, 5)
        pids = self.open_session()
        start = time.monotonic()
        agentd.send_signal(signal.SIGTERM)
        agentd.wait(8)
        self.assertLess(time.monotonic() - start, 8)
        self.assertGone(pids)

    @unittest.skipIf(sys.platform == "win32", "the test needs POSIX signals, pty or time.tzset")
    def test_parent_exit_leaves_no_child_behind(self):
        parent = subprocess.Popen([sys.executable, "-c", PARENT, *self.argv], stdout=subprocess.PIPE,
                                  stderr=self.log, env=self.env, cwd=str(AGENTD.parent))
        self.started.append(parent.pid)
        self.addCleanup(parent.stdout.close)
        agentd = int(parent.stdout.readline())
        self.started.append(agentd)
        pids = self.open_session()
        parent.kill()
        parent.wait(5)
        self.wait(lambda: not exists(agentd), 8, "agentd outlived its parent")
        self.assertGone(pids)


if __name__ == "__main__":
    unittest.main()
