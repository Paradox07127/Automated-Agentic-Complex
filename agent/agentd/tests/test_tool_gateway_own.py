"""Own-session approvals: the policy decides, every verdict reaches the broker's decision record."""
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from sessions.approvals import ApprovalBroker  # noqa: E402
from tool_gateway.computer_use import SERVER_NAME  # noqa: E402
from sessions.lifecycle import SessionRun  # noqa: E402
from sessions.own import CodexProcess, OwnSession, SessionManager, real_argv  # noqa: E402
from test_computer_use import Native  # noqa: E402

GRANTED = {"session_granted": True, "paused": False, "permissions": ["observation", "control"]}


class OwnApprovalPolicyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="tgo-", dir="/tmp")
        self.native = Native(self.tmp.name)
        self.status = GRANTED
        self.native.reply = lambda request: {"id": request["id"], "result": self.status}
        self.broker = ApprovalBroker()
        self.decisions = []
        self.broker.on_decision = lambda kind, attrs, key: self.decisions.append((kind, attrs, key))
        self.manager = SessionManager(self.broker, lambda *_: None, Path(self.tmp.name), "http://localhost", "hook", 30,
                                      computer_control=self.native.config)
        self.session = OwnSession("codex", self.tmp.name, "desktop task", "workspace_write")
        self.session.native_id = "thread-1"
        # In a turn: approvals answer only the turn they were asked in.
        self.manager.sessions[self.session.session_id] = self.session
        self.session.busy, self.session.run = True, SessionRun()
        self.session.run.phase = "running"
        self.session.run.started.set()  # close() waits for a start that no message() makes here
        self.process = object.__new__(CodexProcess)
        self.process.manager, self.process.session, self.process.write = self.manager, self.session, Mock()
        self.process.changes = {}

    def tearDown(self):
        self.manager.close()
        self.native.close()
        self.tmp.cleanup()

    def elicitation(self, request_id):
        return {"id": request_id, "method": "mcpServer/elicitation/request", "params": {
            "threadId": "thread-1", "serverName": SERVER_NAME, "mode": "form",
            "requestedSchema": {"type": "object", "properties": {}},
            "_meta": {"codex_approval_kind": "mcp_tool_call",
                      "tool_params": {"action": "press", "snapshot_id": "s", "element_id": "e"}}}}

    def verdicts(self):
        return [(attrs, key) for kind, attrs, key in self.decisions if kind == "tool.verdict"]

    def answer(self, message, decision):
        """Run _approval and decide the card it opens."""
        thread = threading.Thread(target=self.process._approval, args=(message, self.session.run), daemon=True)
        thread.start()
        deadline = time.monotonic() + 5
        while not self.broker.pending() and time.monotonic() < deadline:
            time.sleep(.01)
        card = self.broker.pending()[0]
        self.assertTrue(self.broker.decide(card["request_id"], card["generation"], decision, None)[0])
        thread.join(5)
        return card

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_desktop_auto_accept_reports_native_panel_verdict(self):
        self.process._approval(self.elicitation(1), self.session.run)
        self.assertEqual(self.process.write.call_args.args[0], {"id": 1, "result": {"action": "accept", "content": {}}})
        self.assertEqual(self.broker.pending(), [])
        self.assertEqual(self.verdicts(), [({"tool": "desktop_act", "method": "native_panel", "dangerous": False,
                                             "rule": None, "reason": "window_granted"}, self.session.session_id)])

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_desktop_without_grant_opens_card(self):
        self.status = {**GRANTED, "session_granted": False}
        card = self.answer(self.elicitation(2), "allow")
        self.assertEqual(card["tool_name"], "desktop_control")
        self.assertEqual(self.process.write.call_args.args[0], {"id": 2, "result": {"action": "accept", "content": {}}})
        self.assertEqual(self.verdicts(), [
            ({"tool": "desktop_act", "method": "card", "dangerous": False, "rule": None, "reason": "no_window_grant"},
             self.session.session_id),
            ({"tool": "desktop_control", "method": "card", "dangerous": False, "rule": None, "reason": "ordinary"},
             self.session.session_id)])

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_command_card_reports_its_danger_verdict(self):
        self.answer({"id": 3, "method": "item/commandExecution/requestApproval",
                     "params": {"command": "rm -rf build"}}, "deny")
        self.assertEqual(self.process.write.call_args.args[0], {"id": 3, "result": {"decision": "decline"}})
        self.assertEqual(self.verdicts(), [({"tool": "command", "method": "card", "dangerous": True,
                                             "rule": "rm_recursive", "reason": "dangerous"}, self.session.session_id)])

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_other_server_elicitation_opens_card(self):
        for request_id, decision, result in ((4, "allow", {"action": "accept", "content": {}}),
                                             (5, "deny", {"action": "decline", "content": None})):
            other = self.elicitation(request_id)
            other["params"].update(serverName="other", message="Allow other/write?")
            card = self.answer(other, decision)
            self.assertEqual((card["tool_name"], card["options"]), ("elicitation", ["allow", "deny"]))
            self.assertIn("Allow other/write?", card["tool_summary"])
            self.assertEqual(self.process.write.call_args.args[0], {"id": request_id, "result": result})
        self.assertEqual(self.native.requests, [])

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_permissions_request_opens_card(self):
        permissions = {"network": {"enabled": True}}
        params = {"threadId": "thread-1", "turnId": "turn-1", "itemId": "item-1", "cwd": self.tmp.name,
                  "startedAtMs": 1, "reason": "needs the network", "permissions": permissions}
        for request_id, decision, granted in ((6, "allow", permissions), (7, "deny", {})):
            card = self.answer({"id": request_id, "method": "item/permissions/requestApproval", "params": params},
                               decision)
            self.assertEqual((card["tool_name"], card["options"]), ("permissions", ["allow", "deny"]))
            self.assertIn("needs the network", card["tool_summary"])
            self.assertEqual(self.process.write.call_args.args[0],
                             {"id": request_id, "result": {"permissions": granted, "scope": "turn"}})

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_unknown_server_request_fails_closed(self):
        self.process._approval({"id": 8, "method": "item/unknown/requestApproval", "params": {}}, self.session.run)
        self.assertEqual(self.process.write.call_args.args[0],
                         {"id": 8, "error": {"code": -32601, "message": "unsupported"}})
        self.assertEqual(self.broker.pending(), [])
        self.assertEqual(self.native.requests, [])


class OwnClaudeArgvTest(unittest.TestCase):
    def test_claude_loads_the_user_settings(self):
        argv = real_argv("claude", "/state/own-claude-settings.json")
        self.assertNotIn("--setting-sources", argv)
        self.assertEqual(argv[argv.index("--settings") + 1], "/state/own-claude-settings.json")


if __name__ == "__main__":
    unittest.main()
