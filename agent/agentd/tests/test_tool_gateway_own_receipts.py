"""Own-session desktop_act receipts land in the character runs ledger, written by the MCP facade process."""
import contextlib
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import tomllib
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from sessions.approvals import ApprovalBroker  # noqa: E402
from character_agent.services.store import RunStore  # noqa: E402
from tool_gateway.computer_use import ComputerControlConfig, ComputerUseError, SERVER_NAME  # noqa: E402
import computer_use_mcp  # noqa: E402
from sessions.own import OwnSession, SessionManager, real_argv  # noqa: E402
from tool_gateway.ledger import EffectLedger, ledger_path  # noqa: E402

ACT = {"snapshot_id": "snap-1", "action": "press", "element_id": "e1"}


class FakeClient:
    def __init__(self, reply):
        self.session_id, self.reply, self.calls = "own:abc", reply, []

    def call(self, name, args):
        self.calls.append((name, args))
        if isinstance(self.reply, Exception):
            raise self.reply
        return self.reply


def frames(*calls):
    return io.BytesIO(b"".join(json.dumps({"jsonrpc": "2.0", "id": i, "method": "tools/call",
                                           "params": {"name": name, "arguments": args}}).encode() + b"\n"
                               for i, (name, args) in enumerate(calls, 1)))


class FacadeReceiptTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="tgr-", dir="/tmp")
        self.path = ledger_path(self.tmp.name)
        self.store = RunStore(self.path)

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def serve(self, client, ledger, *calls):
        output = io.StringIO()
        computer_use_mcp.serve(client, frames(*calls), output, ledger=ledger)
        return [json.loads(line) for line in output.getvalue().splitlines()]

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_facade_act_writes_committed_receipt(self):
        client = FakeClient({"action_id": "a1", "effect": "confirmed"})
        replies = self.serve(client, EffectLedger.open(self.path), ("desktop_act", ACT), ("desktop_status", {}))
        self.assertEqual(replies[0]["result"]["structuredContent"]["effect"], "confirmed")
        [row] = EffectLedger(self.store).effects("own:own:abc")
        self.assertTrue(row["effect_id"].startswith("own:own:abc:"))
        self.assertEqual((row["tool"], row["state"]), ("desktop_act", "committed"))
        self.assertEqual(row["receipt"], {"effect": "confirmed", "tool": "desktop_act"})

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_bridge_error_leaves_unknown(self):
        ledger = EffectLedger.open(self.path)
        replies = self.serve(FakeClient(ComputerUseError("bridge_timeout", "timed out")), ledger, ("desktop_act", ACT))
        self.assertTrue(replies[0]["result"]["isError"])
        self.serve(FakeClient({"action_id": "a1", "effect": "unverifiable"}), ledger, ("desktop_act", ACT))
        rows = EffectLedger(self.store).effects("own:own:abc")
        self.assertEqual([row["state"] for row in rows], ["unknown", "unknown"])
        self.assertEqual(rows[1]["receipt"], {"effect": "unverifiable", "tool": "desktop_act"})

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_ledger_unavailable_does_not_block_act(self):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            self.assertIsNone(computer_use_mcp.open_ledger(Path(self.tmp.name) / "missing" / "runs.sqlite"))
        self.assertIn("desktop_act", stderr.getvalue())
        for ledger in (None, Mock(prepare=Mock(side_effect=sqlite3.OperationalError("readonly database")))):
            client = FakeClient({"action_id": "a1", "effect": "confirmed"})
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                replies = self.serve(client, ledger, ("desktop_act", ACT))
            self.assertEqual(client.calls, [("desktop_act", ACT)])
            self.assertFalse(replies[0]["result"]["isError"])
            self.assertEqual(bool(stderr.getvalue()), ledger is not None)


class OwnLedgerWiringTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="tgr-", dir="/tmp")
        self.manager = SessionManager(ApprovalBroker(), lambda *_: None, Path(self.tmp.name), "http://localhost", "hook", 30,
                                      computer_control=ComputerControlConfig("/tmp/desktop.sock", "/tmp/desktop.token"))

    def tearDown(self):
        self.manager.close()
        self.tmp.cleanup()

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_process_argv_passes_ledger_for_claude_and_codex(self):
        expected = str(ledger_path(Path(self.tmp.name).resolve()))
        for target in ("codex", "claude"):
            session = OwnSession(target, self.tmp.name, "task", "workspace_write")
            args = self.manager.process_argv(session, real_argv(target, str(self.manager.settings_paths[session.mode]), mode=session.mode))
            if target == "codex":
                config = tomllib.loads(args[args.index("-c") + 1])["mcp_servers"][SERVER_NAME]
            else:
                config = json.loads(Path(args[args.index("--mcp-config") + 1]).read_text(encoding="utf-8"))["mcpServers"][SERVER_NAME]
            self.assertEqual(config["args"][config["args"].index("--ledger") + 1], expected)
        self.assertNotIn("--ledger", ComputerControlConfig("/tmp/s", "/tmp/t").server("own:x", "read_only")["args"])

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_delete_forgets_own_receipts(self):
        self.manager.computer_control = None
        store = RunStore(ledger_path(Path(self.tmp.name)))
        ledger = EffectLedger(store)
        session = OwnSession("claude", self.tmp.name, "task", "workspace_write")
        self.manager.sessions[session.session_id] = session
        ledger.effect("own:" + session.session_id + ":1", "own:" + session.session_id, "desktop_act", "h")
        ledger.effect("run-1:1", "run-1", "desktop_act", "h")
        self.assertEqual(self.manager.manage(session.session_id, {"expected_version": session.revision}, delete=True),
                         (200, {"deleted": True}))
        self.assertEqual(ledger.effects("own:" + session.session_id), [])
        self.assertEqual(len(ledger.effects("run-1")), 1)
        store.close()


if __name__ == "__main__":
    unittest.main()
