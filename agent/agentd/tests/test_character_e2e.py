"""Companion -> agentd character switch, end to end against a real agentd process on a free port and a fake
Avatar. The Companion side here follows the shell's CharacterSwitch reconcile: it calls POST /character
after a character_changed, or once agentd reports a character that differs from the avatar's."""
import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fake_avatar import FakeAvatar  # noqa: E402

AGENTD = Path(__file__).resolve().parents[1] / "server.py"


class CompanionSide:
    """The C3 server end plus the agentd calls the shell makes on character events."""

    def __init__(self, path, launched, post):
        self.launched, self.post = launched, post
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(path)
        self.server.listen(1)
        self.conn = None
        self.current = None  # the avatar's character as C3 last reported it
        self.request = None  # id of the open set_character
        self.agentd_replies = []
        self.changed = threading.Condition()
        threading.Thread(target=self._accept, daemon=True).start()

    def close(self):
        if self.conn is not None:
            self.conn.close()
        self.server.close()

    def set_character(self, cid):
        with self.changed:
            self.request = cid
        self.conn.sendall((json.dumps({"v": 1, "type": "set_character", "id": cid}) + "\n").encode())

    def wait(self, predicate, timeout=5):
        with self.changed:
            return self.changed.wait_for(lambda: predicate(self), timeout)

    def _accept(self):
        self.conn, _ = self.server.accept()
        pending = b""
        while True:
            try:
                chunk = self.conn.recv(65536)
            except OSError:
                return
            if not chunk:
                return
            pending += chunk
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                self._handle(json.loads(line))

    def _handle(self, m):
        kind, agentd = m.get("type"), None
        with self.changed:
            if kind == "hello" and m.get("role") == "avatar":
                self.current = m.get("character") or "aster"
                agentd = None if self.current == self.launched else self.current
            elif kind in ("character_changed", "character_change_failed"):
                if self.request != m["id"]:
                    return  # a reply to an earlier request: the shell only logs it
                self.request = None
                if kind == "character_changed":
                    self.current = agentd = m["id"]
        reply = self.post("POST", "/character", {"id": agentd}) if agentd is not None else None
        with self.changed:
            if reply is not None:
                self.agentd_replies.append(reply)
            self.changed.notify_all()


class CharacterSwitchEndToEndTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="efa1-")
        state, ledger = Path(cls.tmp.name) / "state", Path(cls.tmp.name) / "ledger"
        ledger.mkdir()
        cls.proc = subprocess.Popen([sys.executable, str(AGENTD), "--port", "0", "--state-dir", str(state),
                                     "--ledger-root", str(ledger), "--character", "aster", "--no-proactive"],
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=str(AGENTD.parent))
        deadline = time.monotonic() + 15
        runtime = state / "ui-runtime.json"
        while not runtime.exists() and time.monotonic() < deadline and cls.proc.poll() is None:
            time.sleep(0.05)
        if not runtime.exists():
            cls.proc.kill()
            raise AssertionError(f"agentd did not start: {cls.proc.stdout.read().decode(errors='replace')}")
        runtime = json.loads(runtime.read_text(encoding="utf-8"))
        cls.token, cls.port = runtime["ui_token"], int(runtime["base_url"].rsplit(":", 1)[1])

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(10)
        cls.proc.stdout.close()
        cls.tmp.cleanup()

    def request(self, method, path, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request(method, path, json.dumps(body).encode() if body is not None else None,
                     {"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"})
        response = conn.getresponse()
        data = json.loads(response.read() or b"null")
        conn.close()
        return response.status, data

    def agentd_character(self):
        return self.request("GET", "/state")[1]["character"]

    def link(self, avatar_character, **avatar):
        # agentd keeps its character between tests: start each one from the launch id.
        self.assertEqual(self.request("POST", "/character", {"id": "aster"})[0], 200)
        path = os.path.join(self.tmp.name, f"c3-{self._testMethodName[-12:]}.sock")
        companion = CompanionSide(path, "aster", self.request)
        self.addCleanup(companion.close)
        avatar = FakeAvatar(path, avatar_character, **avatar)
        self.addCleanup(avatar.close)
        self.assertTrue(companion.wait(lambda c: c.current is not None))
        return companion, avatar

    @unittest.skipIf(sys.platform == "win32", "the test plays the macOS app's C3 end on a unix socket; C3 on Windows belongs to the Electron shell")
    def test_switch_then_state_matches_the_avatar(self):
        companion, avatar = self.link("aster")
        companion.set_character("birch")
        self.assertTrue(companion.wait(lambda c: c.request is None and c.agentd_replies))
        self.assertEqual(companion.agentd_replies, [(200, {"id": "birch", "changed": True})])
        self.assertEqual((avatar.character, self.agentd_character()), ("birch", "birch"))
        companion.set_character("aster")
        self.assertTrue(companion.wait(lambda c: c.request is None and len(c.agentd_replies) == 2))
        self.assertEqual((avatar.character, self.agentd_character()), ("aster", "aster"))

    @unittest.skipIf(sys.platform == "win32", "the test plays the macOS app's C3 end on a unix socket; C3 on Windows belongs to the Electron shell")
    def test_hello_with_another_character_moves_agentd(self):
        # The avatar fell back or kept a character agentd was not launched with; the hello's character wins.
        companion, avatar = self.link("birch")
        self.assertTrue(companion.wait(lambda c: c.agentd_replies))
        self.assertEqual(self.agentd_character(), avatar.character)

    @unittest.skipIf(sys.platform == "win32", "the test plays the macOS app's C3 end on a unix socket; C3 on Windows belongs to the Electron shell")
    def test_failed_switch_leaves_both_on_the_old_character(self):
        companion, avatar = self.link("aster", fail=("birch",))
        companion.set_character("birch")
        self.assertTrue(companion.wait(lambda c: c.request is None))
        time.sleep(0.2)
        self.assertEqual(companion.agentd_replies, [])
        self.assertEqual((avatar.character, self.agentd_character()), ("aster", "aster"))

    @unittest.skipIf(sys.platform == "win32", "the test plays the macOS app's C3 end on a unix socket; C3 on Windows belongs to the Electron shell")
    def test_same_character_is_a_no_op_for_agentd(self):
        companion, avatar = self.link("aster")
        companion.set_character("aster")
        self.assertTrue(companion.wait(lambda c: c.request is None and c.agentd_replies))
        self.assertEqual(companion.agentd_replies, [(200, {"id": "aster", "changed": False})])
        self.assertEqual(self.agentd_character(), "aster")

    @unittest.skipIf(sys.platform == "win32", "the test plays the macOS app's C3 end on a unix socket; C3 on Windows belongs to the Electron shell")
    def test_character_agentd_lacks_leaves_them_apart(self):
        # Known gap: the avatar has a pack agentd has no card for; agentd refuses and keeps its
        # character, and nothing rolls the avatar back. This pins today's behavior so a fix changes it on purpose.
        companion, avatar = self.link("aster", known=("aster", "birch", "ch_x"))
        companion.set_character("ch_x")
        self.assertTrue(companion.wait(lambda c: c.request is None and c.agentd_replies))
        self.assertEqual(companion.agentd_replies, [(400, {"error": "unknown_character"})])
        self.assertEqual((avatar.character, self.agentd_character()), ("ch_x", "aster"))


if __name__ == "__main__":
    unittest.main()
