"""agentd on a library without characters: it starts without --character, /health is ok, and every route that needs a
character answers 409 no_character."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

AGENTD = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AGENTD))
import character_tool
from api.handler import CHARACTER_ROUTES


class NoCharacterTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="efnc-"); self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        character_tool.compose([], None, root / "library")
        state, ledger = root / "state", root / "ledger"
        ledger.mkdir()
        self.proc = subprocess.Popen([sys.executable, str(AGENTD / "server.py"), "--port", "0", "--state-dir", str(state),
                                      "--ledger-root", str(ledger), "--character-catalog", str(root / "library/current.json"),
                                      "--no-proactive"],
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=str(AGENTD))
        self.addCleanup(self.stop)
        runtime = state / "ui-runtime.json"
        deadline = time.monotonic() + 30
        while not runtime.exists() and time.monotonic() < deadline and self.proc.poll() is None:
            time.sleep(0.05)
        if not runtime.exists():
            self.proc.kill()
            self.fail(f"agentd did not start: {self.proc.stdout.read().decode(errors='replace')}")
        value = json.loads(runtime.read_text(encoding="utf-8"))
        self.base, self.token = value["base_url"], value["ui_token"]
        deadline = time.monotonic() + 30
        while self.request("GET", "/health")[1].get("status") != "ok" and time.monotonic() < deadline:
            time.sleep(0.05)

    def stop(self):
        self.proc.terminate()
        self.proc.wait(10)
        self.proc.stdout.close()

    def request(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.base + path, data=data, method=method,
                                         headers={"Authorization": "Bearer " + self.token,
                                                  **({"Content-Type": "application/json"} if data else {})})
        try:
            with urllib.request.urlopen(request, timeout=10) as reply:
                return reply.status, json.loads(reply.read() or b"{}")
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read() or b"{}")

    def test_starts_without_a_character(self):
        self.assertEqual(self.request("GET", "/health"), (200, {"status": "ok", "degraded": [], "c6_contract": "v1"}))
        status, state = self.request("GET", "/state")
        self.assertEqual(status, 200)
        self.assertIsNone(state["character"])

    def test_character_routes_answer_no_character(self):
        for method, path in sorted(CHARACTER_ROUTES):
            with self.subTest(route=f"{method} {path}"):
                self.assertEqual(self.request(method, path, None if method in ("GET", "DELETE") else {}),
                                 (409, {"error": "no_character"}))

    def test_a_conversation_message_answers_no_character(self):
        status, conversation = self.request("POST", "/conversations", {})
        self.assertEqual(status, 201)
        self.assertEqual(self.request("POST", f"/conversations/{conversation['id']}/messages", {"text": "你好"}),
                         (409, {"error": "no_character"}))


if __name__ == "__main__":
    unittest.main()
