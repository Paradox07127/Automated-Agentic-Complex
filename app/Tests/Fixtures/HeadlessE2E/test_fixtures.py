"""The headless e2e fixtures: mock host, agentd fault launcher and fake TTS, each run as a real process."""
import http.client
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
MOCK_HOST = HERE / "mock_host.py"
LAUNCHER = HERE / "agentd_e2e_launcher.py"
FAKE_TTS = HERE / "fake_tts.py"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


C3 = load("c3_validate", ROOT / "protocol/C3-host-ipc/validate.py")
C2 = load("c2_validate", ROOT / "protocol/C2-speech-stream/validate.py")

STUB_SERVER = """
import argparse, json, os, socket, sys
from pathlib import Path


class AgentdServer:
    def recover_tasks(self):
        pass


def main(secret_store):
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int)
    p.add_argument("--state-dir")
    a, _ = p.parse_known_args()
    s = socket.socket()
    s.bind(("127.0.0.1", a.port))
    s.listen()
    AgentdServer().recover_tasks()
    Path(a.state_dir, "stub-ready.json").write_text(json.dumps({"argv": sys.argv[1:]}))
    while True:
        s.accept()[0].close()
"""


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def listening(port):
    try:
        socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
        return True
    except OSError:
        return False


def wait_for(predicate, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return predicate()


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


class Processes(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="e2e"))
        self.procs = []

    def tearDown(self):
        for p in self.procs:
            if p.poll() is None:
                p.kill()
                p.wait()
            if p.stdout:
                p.stdout.close()

    def spawn(self, argv, **kw):
        p = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, **kw)
        self.procs.append(p)
        return p


class MockHostTests(Processes):
    def setUp(self):
        super().setUp()
        self.support = self.tmp / "support"
        (self.support / "run").mkdir(parents=True)
        self.sock_path = str(self.support / "run/avatar.sock")
        self.server = socket.socket(socket.AF_UNIX)
        self.server.bind(self.sock_path)
        self.server.listen()
        self.server.settimeout(3)

    def tearDown(self):
        self.server.close()
        super().tearDown()

    def host(self, startup, parent=None, socket_path=True):
        argv = [sys.executable, "-I", str(MOCK_HOST), "--agentic-complex-window-level", "status",
                "--agentic-complex-parent-pid", str(parent or os.getpid()),
                "--agentic-complex-agentd", str(self.tmp / "events-runtime.json"), "--agentic-complex-character", "aster",
                "--agentic-complex-startup-status", str(startup), "--agentic-complex-viewport", "window",
                "--agentic-complex-ssaa", "1", "--agentic-complex-camera-mode", "orbit"]
        if socket_path:
            argv += ["--agentic-complex-host-socket", self.sock_path]
        return argv

    def connect(self):
        conn, _ = self.server.accept()
        conn.settimeout(3)
        return conn, conn.makefile("rb")

    @staticmethod
    def send(conn, message):
        conn.sendall((json.dumps({"v": 1, **message}) + "\n").encode())

    @staticmethod
    def next_not_heartbeat(reader, raw):
        while True:
            line = reader.readline()
            raw.append(line)
            m = json.loads(line)
            if m["type"] != "heartbeat":
                return m

    def test_handshake_switch_quit_and_valid_lines(self):
        startup = self.support / "run/startup-1.json"
        began = time.monotonic()
        proc = self.spawn(self.host(startup))
        conn, reader = self.connect()
        raw = [reader.readline()]
        hello = json.loads(raw[0])
        self.assertLess(time.monotonic() - began, 2)
        self.assertEqual((hello["type"], hello["pid"], hello["character"]), ("hello", proc.pid, "aster"))
        self.assertIn("heartbeat", hello["capabilities"])
        status = json.loads(startup.read_text())
        self.assertEqual(status, {"schema": "endfield-startup/v1", "pid": proc.pid, "character": "aster", "stage": "ready"})
        self.send(conn, {"type": "hello", "role": "companion", "pid": os.getpid(), "protocol": 1, "capabilities": []})
        self.send(conn, {"type": "set_character", "id": "birch"})
        changed = self.next_not_heartbeat(reader, raw)
        self.assertEqual((changed["type"], changed["id"]), ("character_changed", "birch"))
        raw += [reader.readline() for _ in range(3)]
        beats = [json.loads(line) for line in raw[-3:]]
        self.assertEqual([b["type"] for b in beats], ["heartbeat"] * 3)
        self.assertEqual([b["seq"] for b in beats], list(range(beats[0]["seq"], beats[0]["seq"] + 3)))
        self.send(conn, {"type": "quit", "reason": "companion_exit"})
        quit_at = time.monotonic()
        self.assertEqual(proc.wait(1), 0)
        self.assertLess(time.monotonic() - quit_at, 1)
        raw += reader.readlines()
        reader.close()
        conn.close()
        self.assertEqual(C3.check_lines(b"".join(raw), "a2c", session=True), [])
        transcript = [json.loads(l) for l in (self.support / f"run/e2e-host-{proc.pid}.jsonl").read_text().splitlines()]
        sets = [t for t in transcript if t["dir"] == "c2a" and t["msg"]["type"] == "set_character"]
        self.assertEqual([s["msg"]["id"] for s in sets], ["birch"])

    def test_faults_are_keyed_by_launch_number(self):
        (self.support / "run/e2e-host-faults.json").write_text(json.dumps({
            "1": {"exit_after_s": 0.2, "exit_status": 78},
            "2": {"fail_switch": True, "silent_after_s": 0.5}}))
        first = self.spawn(self.host(self.support / "run/startup-1.json", socket_path=False))
        self.assertEqual(first.wait(3), 78)
        second = self.spawn(self.host(self.support / "run/startup-2.json"))
        conn, reader = self.connect()
        raw = [reader.readline()]
        self.send(conn, {"type": "hello", "role": "companion", "pid": os.getpid(), "protocol": 1, "capabilities": []})
        self.send(conn, {"type": "set_character", "id": "birch"})
        failed = self.next_not_heartbeat(reader, raw)
        self.assertEqual((failed["type"], failed["id"], failed["reason"]), ("character_change_failed", "birch", "load_failed"))
        time.sleep(0.8)
        conn.setblocking(False)
        try:
            while conn.recv(65536):
                pass
        except BlockingIOError:
            pass
        conn.setblocking(True)
        conn.settimeout(0.5)
        with self.assertRaises(TimeoutError):
            conn.recv(1)
        self.assertIsNone(second.poll())
        reader.close()
        conn.close()
        self.assertEqual(second.wait(4), 0)

    def test_exits_when_the_parent_dies(self):
        startup = self.support / "run/startup-1.json"
        middle = self.spawn([sys.executable, "-I", "-c",
                             "import os, subprocess, sys, time\n"
                             f"argv = {self.host(startup, socket_path=False)!r}\n"
                             "argv[argv.index('--agentic-complex-parent-pid') + 1] = str(os.getpid())\n"
                             "print(subprocess.Popen(argv).pid, flush=True)\n"
                             "time.sleep(60)\n"])
        pid = int(middle.stdout.readline())
        try:
            self.assertTrue(wait_for(lambda: startup.exists() and json.loads(startup.read_text())["stage"] == "ready", 3))
            self.assertTrue(alive(pid))
            middle.kill()
            middle.wait()
            self.assertTrue(wait_for(lambda: not alive(pid), 2))
        finally:
            if alive(pid):
                os.kill(pid, signal.SIGKILL)


class FakeTTSTests(Processes):
    def test_replays_the_c2_example_with_the_speech_id(self):
        port_file, log = self.tmp / "tts.port", self.tmp / "tts.jsonl"
        self.spawn([sys.executable, "-I", str(FAKE_TTS), "--port-file", str(port_file), "--log", str(log)])
        self.assertTrue(wait_for(port_file.exists, 5))
        conn = http.client.HTTPConnection("127.0.0.1", int(port_file.read_text()), timeout=3)
        body = json.dumps({"session_epoch": "E9", "turn_id": "T9", "speech_id": "sp-42", "text": "你好"})
        conn.request("POST", "/speech_stream", body, {"Content-Type": "application/json", "Authorization": "Bearer t"})
        response = conn.getresponse()
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader("Content-Type"), "application/x-ndjson")
        lines = response.read().decode().splitlines()
        conn.close()
        events = [json.loads(l) for l in lines]
        self.assertEqual([e["event"] for e in events], ["speech.begin", "segment", "audio", "cues", "complete"])
        self.assertEqual([e["seq"] for e in events], sorted({e["seq"] for e in events}))
        self.assertEqual({e["speech_id"] for e in events}, {"sp-42"})
        self.assertIsNone(C2.check(lines))
        logged = [json.loads(l) for l in log.read_text().splitlines()]
        self.assertEqual([(r["path"], r["body"]["speech_id"]) for r in logged], [("/speech_stream", "sp-42")])


class LauncherTests(Processes):
    def setUp(self):
        super().setUp()
        self.agentd = self.tmp / "agentd"
        self.agentd.mkdir()
        (self.agentd / "server.py").write_text(STUB_SERVER)
        # With --parent-pid the launcher watches the parent through agentd's infra.platform.
        shutil.copytree(ROOT / "agent/agentd/infra", self.agentd / "infra", ignore=shutil.ignore_patterns("__pycache__"))
        # The launcher seeds the TTS reference through agentd's voice.credential.
        shutil.copytree(ROOT / "agent/agentd/voice", self.agentd / "voice", ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copy(ROOT / "agent/agentd/fsutil.py", self.agentd / "fsutil.py")
        self.state = self.tmp / "state"
        self.faults = self.tmp / "agentd-faults.json"
        self.port = free_port()

    def launch(self, faults):
        self.faults.write_text(json.dumps(faults))
        return self.spawn([sys.executable, "-I", str(LAUNCHER), "--agentd-dir", str(self.agentd),
                           "--parent-pid", str(os.getpid()), "--", "--port", str(self.port),
                           "--state-dir", str(self.state), "--tts-token-file", str(self.tmp / "tts-token"),
                           "--character", "aster"],
                          env={**os.environ, "E2E_AGENTD_FAULTS": str(self.faults)})

    def test_exit_status_fault_exits_without_binding(self):
        proc = self.launch({"*": {"exit_status": 1, "after_s": 0.3}})
        self.assertEqual(proc.wait(5), 1)
        self.assertFalse(listening(self.port))
        self.assertFalse((self.state / "stub-ready.json").exists())

    def test_recovery_waits_for_the_release_file_and_ledger_root_is_private(self):
        release = self.tmp / "release"
        self.launch({"1": {"recovery_wait_file": str(release)}, "2": {"exit_status": 3}})
        self.assertTrue(wait_for(lambda: listening(self.port), 5))
        time.sleep(0.5)
        self.assertFalse((self.state / "stub-ready.json").exists())
        release.touch()
        ready = self.state / "stub-ready.json"
        self.assertTrue(wait_for(ready.exists, 3))
        argv = json.loads(ready.read_text())["argv"]
        self.assertEqual(argv[argv.index("--ledger-root") + 1], str(self.state / "ledger"))
        self.assertTrue((self.state / "ledger").is_dir())
        self.procs[0].kill()
        self.procs[0].wait()
        self.assertEqual(self.launch({"1": {}, "2": {"exit_status": 3, "after_s": 0}}).wait(5), 3)


if __name__ == "__main__":
    unittest.main()
