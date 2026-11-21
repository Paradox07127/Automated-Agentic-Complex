"""Native socket/MCP loop and own-session wiring; no model API or real desktop input in these tests."""
import base64
import concurrent.futures
import contextlib
import io
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import tomllib
import types
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sessions.approvals import ApprovalBroker
from tool_gateway.computer_use import ComputerControlConfig, ComputerControlClient, ComputerUseError, SERVER_NAME, TOOLS, mcp_result
from daemon.main import parse_args
from sessions.lifecycle import SessionRun
from sessions.own import CodexProcess, OwnSession, SessionManager, real_argv
from infra.tokens import write_secret

PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6JXcAAAAASUVORK5CYII="
TARGET = {"bundle_id": "com.example.Editor", "pid": 1234, "window_id": 7, "generation": 2}
OBSERVE = {"target": {"bundle_id": TARGET["bundle_id"], "window_id": 7}}
SCRIPT = Path(__file__).resolve().parents[1] / "tools" / "computer_use_mcp.py"


class AcceptanceScriptTest(unittest.TestCase):
    def test_acceptance_script_imports_agentd_from_any_working_directory(self):
        script = Path(__file__).resolve().parents[2] / "computer-control" / "acceptance.py"
        with tempfile.TemporaryDirectory() as folder:
            result = subprocess.run([sys.executable, "-I", str(script), "--help"],
                                    cwd=folder, capture_output=True, text=True, timeout=10, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--exercise-fixture", result.stdout)


class Native:
    def __init__(self, folder):
        self.path = str(Path(folder) / "desktop.sock")
        self.token = Path(folder) / "desktop.token"
        write_secret(self.token, "native-secret\n")
        self.config = ComputerControlConfig(self.path, str(self.token))
        self.requests, self.reply, self.observations = [], None, 0
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket.bind(self.path)
        self.socket.listen()
        self.socket.settimeout(.1)
        self.stopped = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def run(self):
        while not self.stopped.is_set():
            try:
                connection, _ = self.socket.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            with connection:
                request = json.loads(connection.makefile("rb").readline())
                self.requests.append(request)
                if self.reply is not None:
                    reply = self.reply(request)
                elif request["method"] == "desktop_observe":
                    self.observations += 1
                    result = {"snapshot_id": f"snap-{self.observations}", "target": TARGET, "elements": [{"element_id": "e1", "role": "AXTextField"}]}
                    if request["params"].get("include_image"):
                        result["image"] = PNG
                    reply = {"id": request["id"], "result": result}
                elif request["method"] == "desktop_act":
                    reply = {"id": request["id"], "result": {"action_id": "a1", "effect": "unverifiable"}}
                elif request["method"] == "desktop_verify":
                    reply = {"id": request["id"], "result": {"effect": "confirmed", "snapshot_id": "snap-2"}}
                else:
                    reply = {"id": request["id"], "result": {"enabled": True}}
                if reply is None:
                    time.sleep(.15)
                else:
                    try:
                        connection.sendall(json.dumps(reply).encode() + b"\n")
                    except (BrokenPipeError, ConnectionResetError):
                        pass

    def close(self):
        self.stopped.set()
        self.socket.close()
        self.thread.join(1)


class ComputerControlGrantTest(unittest.TestCase):
    def setUp(self):
        self.client = ComputerControlClient(ComputerControlConfig("/fake/control.sock", "/fake/control.token"),
                                            "own:test", allow_control=True)
        self.connection = Mock()
        self.connection.__enter__ = Mock(return_value=self.connection)
        self.connection.__exit__ = Mock(return_value=False)
        self.connection.getpeereid.return_value = (os.getuid(), os.getgid())
        self.requests = []
        self.code = None
        def send(payload):
            request = json.loads(payload)
            self.requests.append(request)
            if self.code:
                reply = {"id": request["id"], "error": {"code": self.code, "message": "Grant this action in Companion"}}
            else:
                reply = {"id": request["id"], "result": {"snapshot_id": "s", "target": TARGET}}
            self.connection.recv.return_value = json.dumps(reply).encode() + b"\n"
        self.connection.sendall.side_effect = send
        for replacement in (patch("tool_gateway.computer_use.read_token", return_value="fake-secret"),
                            patch("tool_gateway.computer_use.os.lstat", return_value=types.SimpleNamespace(st_mode=stat.S_IFSOCK, st_uid=os.getuid())),
                            patch("tool_gateway.computer_use.socket.socket", return_value=self.connection)):
            replacement.start()
            self.addCleanup(replacement.stop)

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_cross_bundle_action_requires_approval(self):
        self.client.call("desktop_observe", OBSERVE)
        self.code = "target_changed"
        with self.assertRaises(ComputerUseError) as error:
            self.client.call("desktop_act", {"snapshot_id": "s", "action": "scroll", "x": 1, "y": 2, "delta_y": 1})
        self.assertEqual(error.exception.code, "approval_required")
        self.assertEqual(self.client.snapshots, {})
        self.assertEqual(len(self.requests), 2)

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_over_count_action_requires_approval(self):
        self.client.call("desktop_observe", OBSERVE)
        self.client.call("desktop_act", {"snapshot_id": "s", "action": "click", "x": 1, "y": 2})
        self.client.call("desktop_observe", OBSERVE)
        self.code = "permission_required"
        with self.assertRaises(ComputerUseError) as error:
            self.client.call("desktop_act", {"snapshot_id": "s", "action": "click", "x": 1, "y": 2})
        self.assertEqual(error.exception.code, "approval_required")
        self.assertEqual(len(self.requests), 4)

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_expired_action_grant_requires_approval(self):
        self.client.call("desktop_observe", OBSERVE)
        self.code = "grant_expired"
        with self.assertRaises(ComputerUseError) as error:
            self.client.call("desktop_act", {"snapshot_id": "s", "action": "press", "element_id": "e1"})
        self.assertEqual(error.exception.code, "approval_required")
        self.assertEqual(len(self.requests), 2)

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_client_does_not_call_unavailable_getpeereid(self):
        self.connection.getpeereid.side_effect = AssertionError("getpeereid is unavailable on Python sockets")
        self.client.call("desktop_observe", OBSERVE)
        self.connection.getpeereid.assert_not_called()


class ComputerUseTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="cc-", dir="/tmp")
        self.native = Native(self.tmp.name)
        self.client = ComputerControlClient(self.native.config, "own:test", allow_control=True)

    def tearDown(self):
        self.native.close()
        self.tmp.cleanup()

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_release_reaches_native_and_clears_snapshots(self):
        self.client.call("desktop_observe", OBSERVE)
        self.client.call("desktop_release", {})
        self.assertEqual(self.native.requests[-1]["method"], "desktop_release")
        self.assertEqual(self.client.snapshots, {})
        self.assertNotIn("desktop_release", [t["name"] for t in TOOLS], "agentd's own release is not offered to the model")
        with self.assertRaises(ComputerUseError):
            self.client.call("desktop_release", {"x": 1})

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_observe_act_verify_loop_pins_session_and_snapshot(self):
        observed = self.client.call("desktop_observe", OBSERVE)
        self.assertEqual(observed["target"], TARGET)
        action = self.client.call("desktop_act", {"snapshot_id": "snap-1", "action": "set_value", "element_id": "e1", "text": "draft"})
        self.assertEqual(action["effect"], "unverifiable", "accepted action is not proof of effect")
        self.assertEqual(self.client.snapshots, {}, "actions consume prior observations")
        self.client.call("desktop_observe", OBSERVE)
        verified = self.client.call("desktop_verify", {"snapshot_id": "snap-2", "element_id": "e1", "expected_value": "draft"})
        self.assertEqual(verified["effect"], "confirmed")
        self.assertTrue(all(r["session_id"] == "own:test" and r["token"] == "native-secret" for r in self.native.requests))
        self.client.call("desktop_cancel", {})
        self.assertEqual(self.client.snapshots, {})

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_status_discovery_is_scoped_to_one_explicit_app(self):
        self.client.call("desktop_status", {"target": {"bundle_id": "com.example.Editor"}})
        self.assertEqual(self.native.requests[0]["params"], {"target": {"bundle_id": "com.example.Editor"}})
        with self.assertRaises(ComputerUseError):
            self.client.call("desktop_status", {"target": {}})
        self.assertEqual(len(self.native.requests), 1)

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_permission_wait_is_explicit_and_only_for_observation(self):
        client = ComputerControlClient(self.native.config, "own:waiting", allow_control=True, wait_for_permission=True)
        client.call("desktop_observe", OBSERVE)
        self.assertTrue(self.native.requests[-1]["wait_for_permission"])
        client.call("desktop_status", {})
        self.assertNotIn("wait_for_permission", self.native.requests[-1])
        client.call("desktop_act", {"snapshot_id": "snap-1", "action": "press", "element_id": "e1"})
        self.assertNotIn("wait_for_permission", self.native.requests[-1])
        self.assertTrue(self.native.requests[-1]["wait_for_resume"])

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_waiting_observation_continues_after_one_user_decision(self):
        decision = threading.Event()
        def reply(request):
            self.assertTrue(decision.wait(2))
            return {"id": request["id"], "result": {"snapshot_id": "after-grant", "target": TARGET, "elements": []}}
        self.native.reply = reply
        client = ComputerControlClient(self.native.config, "own:waiting", timeout=3, wait_for_permission=True)
        with concurrent.futures.ThreadPoolExecutor() as pool:
            future = pool.submit(client.call, "desktop_observe", OBSERVE)
            deadline = time.monotonic() + 1
            while not self.native.requests and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertEqual(len(self.native.requests), 1)
            self.assertFalse(future.done())
            decision.set()
            self.assertEqual(future.result(timeout=2)["snapshot_id"], "after-grant")
        self.assertEqual(len(self.native.requests), 1, "the same observation waits; it is not polled or replayed")

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_observation_of_another_window_cannot_seed_an_action(self):
        self.native.reply = lambda r: {"id": r["id"], "result": {"snapshot_id": "wrong", "target": {**TARGET, "window_id": 8}}}
        with self.assertRaises(ComputerUseError) as error:
            self.client.call("desktop_observe", OBSERVE)
        self.assertEqual(error.exception.code, "target_changed")
        self.assertEqual(self.client.snapshots, {})

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_denial_is_structured_and_never_retried(self):
        self.native.reply = lambda r: {"id": r["id"], "error": {"code": "permission_required", "message": "Grant this task in Companion"}}
        with self.assertRaises(ComputerUseError) as error:
            self.client.call("desktop_observe", OBSERVE)
        self.assertEqual(error.exception.code, "permission_required")
        self.assertEqual(len(self.native.requests), 1)
        self.assertEqual(self.client.snapshots, {})

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_read_only_or_unobserved_actions_never_reach_native(self):
        readonly = ComputerControlClient(self.native.config, "own:read")
        for client, code in ((readonly, "task_read_only"), (self.client, "unknown_snapshot")):
            with self.assertRaises(ComputerUseError) as error:
                client.call("desktop_act", {"snapshot_id": "guessed", "action": "press", "element_id": "e1"})
            self.assertEqual(error.exception.code, code)
        self.assertEqual(self.native.requests, [])

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_only_closed_actions_and_bounded_inputs_are_accepted(self):
        cases = [("desktop_observe", {"target": {"pid": True}}),
                 ("desktop_observe", {"target": {"pid": 2147483648}}),
                 ("desktop_observe", {"target": {"pid": 2, "window_id": 4294967296}}),
                 ("desktop_act", {"snapshot_id": "s", "action": "scroll", "x": 1, "y": 2, "delta_y": 1.5}),
                 ("desktop_act", {"snapshot_id": "s", "action": "scroll", "x": 1, "y": 2, "delta_y": True}),
                 ("desktop_act", {"snapshot_id": "s", "action": "shell", "text": "rm -rf /"}),
                 ("desktop_act", {"snapshot_id": "s", "action": "type", "text": "a" * 4001}),
                 ("desktop_act", {"snapshot_id": "s", "action": "click", "x": float("nan"), "y": 0}),
                 ("desktop_status", {"session_id": "other"}), ("desktop_observe", {"target": {"bundle_id": "app"}, "shell": "x"})]
        for method, params in cases:
            with self.subTest(method=method), self.assertRaises(ComputerUseError):
                self.client.call(method, params)
        self.assertEqual(self.native.requests, [])

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_timeout_wrong_response_identity_and_bad_secrets_fail_closed(self):
        self.native.reply = lambda r: {"id": "other", "result": {}}
        with self.assertRaises(ComputerUseError) as error:
            self.client.call("desktop_status", {})
        self.assertEqual(error.exception.code, "bridge_protocol")
        self.native.reply = lambda r: None
        self.client.timeout = .03
        with self.assertRaises(ComputerUseError) as error:
            self.client.call("desktop_status", {})
        self.assertEqual(error.exception.code, "bridge_timeout")
        os.chmod(self.native.token, 0o644)
        with self.assertRaises(ComputerUseError):
            self.client.call("desktop_status", {})

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_images_are_mcp_image_blocks_and_absent_from_text(self):
        result = mcp_result({"target": TARGET, "image": {"data": PNG, "mime_type": "image/png"}})
        self.assertEqual(result["content"][1], {"type": "image", "data": PNG, "mimeType": "image/png"})
        self.assertNotIn(PNG, result["content"][0]["text"])
        self.assertNotIn("image", result["structuredContent"])
        with self.assertRaises(ComputerUseError):
            mcp_result({"image": base64.b64encode(b"not png").decode()})

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_real_mcp_stdio_process_routes_tools_and_emits_images(self):
        server = self.native.config.server("own:stdio", "workspace_write")
        requests = [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}},
                    {"jsonrpc": "2.0", "method": "notifications/initialized"},
                    {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                    {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "desktop_observe", "arguments": {**OBSERVE, "include_image": True}}},
                    {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "desktop_act", "arguments": {"snapshot_id": "snap-1", "action": "press", "element_id": "e1"}}},
                    {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "desktop_observe", "arguments": OBSERVE}},
                    {"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "desktop_verify", "arguments": {"snapshot_id": "snap-2", "element_id": "e1", "expected_value": "draft"}}}]
        process = subprocess.run([server["command"], *server["args"]], input="".join(json.dumps(r) + "\n" for r in requests),
                                 capture_output=True, text=True, timeout=5, encoding="utf-8")
        self.assertEqual(process.returncode, 0, process.stderr)
        replies = [json.loads(line) for line in process.stdout.splitlines()]
        self.assertEqual([r["id"] for r in replies], [1, 2, 3, 4, 5, 6])
        self.assertEqual({t["name"] for t in replies[1]["result"]["tools"]}, {t["name"] for t in TOOLS})
        self.assertEqual(replies[2]["result"]["content"][1]["type"], "image")
        self.assertEqual(replies[-1]["result"]["structuredContent"]["effect"], "confirmed")
        self.assertNotIn("native-secret", process.stdout + process.stderr)


class OwnComputerWiringTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="cw-", dir="/tmp")
        self.config = ComputerControlConfig("/tmp/desktop.sock", "/tmp/desktop.token")
        self.manager = SessionManager(ApprovalBroker(), lambda *_: None, Path(self.tmp.name), "http://localhost", "hook", 30,
                                      computer_control=self.config)

    def tearDown(self):
        self.manager.close()
        self.tmp.cleanup()

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_optional_scoped_mcp_config_preserves_modes_and_contains_no_approval_bypass(self):
        for target in ("codex", "claude"):
            session = OwnSession(target, self.tmp.name, "task", "workspace_write")
            original = real_argv(target, str(self.manager.settings_path), mode=session.mode)
            args = self.manager.process_argv(session, original)
            if target == "codex":
                config = tomllib.loads(args[args.index("-c") + 1])["mcp_servers"][SERVER_NAME]
                self.assertEqual(config["default_tools_approval_mode"], "writes")
                self.assertGreater(config["tool_timeout_sec"], 195)
            else:
                path = Path(args[args.index("--mcp-config") + 1])
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                config = json.loads(path.read_text(encoding="utf-8"))["mcpServers"][SERVER_NAME]
                self.assertEqual(args[args.index("--permission-mode") + 1], "acceptEdits")
            self.assertIn(session.session_id, config["args"])
            self.assertIn("workspace_write", config["args"])
            self.assertFalse(any("bypass" in arg or "allowedTools" in arg for arg in args))
        self.manager.computer_control = None
        self.assertEqual(self.manager.process_argv(session, original), original)

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_cli_requires_both_flags_and_defaults_off(self):
        self.assertIsNone(parse_args([]).computer_control_socket)
        self.assertEqual(parse_args(["--computer-control-socket", "/tmp/s", "--computer-control-token-file", "/tmp/t"]).computer_control_token_file, "/tmp/t")
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            parse_args(["--computer-control-socket", "/tmp/s"])

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_only_scoped_codex_approval_form_reaches_existing_user_broker(self):
        session = OwnSession("codex", self.tmp.name, "desktop task")
        session.native_id = "thread-1"
        manager = types.SimpleNamespace(computer_control=self.config, progress=Mock(), ask=Mock(return_value="allow"), verdict=Mock())
        process = object.__new__(CodexProcess)
        process.manager, process.session, process.write = manager, session, Mock()
        params = {"threadId": "thread-1", "serverName": SERVER_NAME, "mode": "form", "message": "Allow desktop_act?",
                  "requestedSchema": {"type": "object", "properties": {}},
                  "_meta": {"codex_approval_kind": "mcp_tool_call", "tool_params": {"action": "press", "snapshot_id": "s"}}}
        process._approval({"id": 1, "method": "mcpServer/elicitation/request", "params": params})
        self.assertEqual(process.write.call_args.args[0], {"id": 1, "result": {"action": "accept", "content": {}}})
        manager.ask.assert_called_once()
        manager.ask.return_value = "deny"
        process._approval({"id": 2, "method": "mcpServer/elicitation/request", "params": params})
        self.assertEqual(process.write.call_args.args[0]["result"]["action"], "decline")
        for replacement in ({"threadId": "other"}, {"mode": "url"},
                            {"_meta": {}}, {"requestedSchema": {"type": "object", "properties": {"secret": {"type": "string"}}}}):
            process._approval({"id": 3, "method": "mcpServer/elicitation/request", "params": {**params, **replacement}})
            self.assertEqual(process.write.call_args.args[0]["error"]["code"], -32601)
        self.assertEqual(manager.ask.call_count, 2)

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_native_window_grant_avoids_only_the_duplicate_desktop_action_card(self):
        session = OwnSession("codex", self.tmp.name, "desktop task", "workspace_write")
        session.native_id = "thread-1"
        manager = types.SimpleNamespace(computer_control=self.config, progress=Mock(), ask=Mock(return_value="deny"), verdict=Mock())
        process = object.__new__(CodexProcess)
        process.manager, process.session, process.write = manager, session, Mock()
        params = {"threadId": "thread-1", "serverName": SERVER_NAME, "mode": "form",
                  "requestedSchema": {"type": "object", "properties": {}},
                  "_meta": {"codex_approval_kind": "mcp_tool_call",
                            "tool_params": {"action": "press", "snapshot_id": "s", "element_id": "e"}}}
        status = {"session_granted": True, "paused": False, "permissions": ["observation", "control"]}
        with patch("tool_gateway.desktop.ComputerControlClient") as client:
            client.return_value.call.return_value = status
            process._approval({"id": 1, "method": "mcpServer/elicitation/request", "params": params})
            self.assertEqual(process.write.call_args.args[0]["result"]["action"], "accept")
            manager.ask.assert_not_called()
            client.return_value.call.return_value = {**status, "permissions": ["observation"]}
            process._approval({"id": 5, "method": "mcpServer/elicitation/request", "params": params})
            self.assertEqual(process.write.call_args.args[0]["result"]["action"], "accept", "native control grant is still required before any effect")
            client.return_value.call.return_value = {**status, "paused": True}
            process._approval({"id": 2, "method": "mcpServer/elicitation/request", "params": params})
            self.assertEqual(process.write.call_args.args[0]["result"]["action"], "accept")
            manager.ask.assert_not_called()
            client.return_value.call.return_value = {**status, "session_granted": False}
            process._approval({"id": 4, "method": "mcpServer/elicitation/request", "params": params})
            self.assertEqual(process.write.call_args.args[0]["result"]["action"], "decline")
            manager.ask.assert_called_once()
            malformed = {**params, "_meta": {**params["_meta"], "tool_params": {"action": "press"}}}
            process._approval({"id": 3, "method": "mcpServer/elicitation/request", "params": malformed})
            self.assertEqual(manager.ask.call_count, 2)

    def busy_session(self):
        session = OwnSession("codex", self.tmp.name, "desktop task", "workspace_write")
        session.busy, session.run, session.backend = True, SessionRun(), Mock()
        self.manager.sessions[session.session_id] = session
        return session

    def native_calls(self):
        calls = []
        def make(config, session_id, **kwargs):
            return types.SimpleNamespace(call=lambda name, args: calls.append((session_id, name)) or {})
        patcher = patch("tool_gateway.desktop.ComputerControlClient", side_effect=make)
        patcher.start(); self.addCleanup(patcher.stop)
        return calls

    def until(self, predicate):
        deadline = time.monotonic() + 3
        while not predicate():
            if time.monotonic() > deadline: self.fail("condition not reached")
            time.sleep(.01)

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_every_turn_end_releases_the_sessions_grant(self):
        calls = self.native_calls()
        for status in ("completed", "interrupted", "failed"):
            calls.clear()
            session = self.busy_session()
            self.manager.turn_ended(session, status, "text", backend=session.backend)
            self.until(lambda: calls)
            time.sleep(.05)
            self.assertEqual(calls, [(session.session_id, "desktop_release")], status)

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_late_report_from_a_replaced_backend_or_run_releases_nothing(self):
        calls = self.native_calls()
        session = self.busy_session()
        self.manager.turn_ended(session, "completed", "old", backend=Mock())
        self.manager.turn_ended(session, "interrupted", None, run=SessionRun())
        self.assertTrue(session.busy)
        self.manager.turn_ended(session, "completed", "current", backend=session.backend)
        self.until(lambda: calls)
        time.sleep(.05)
        self.assertEqual(calls, [(session.session_id, "desktop_release")])

    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_turn_end_without_computer_control_sends_nothing(self):
        calls = self.native_calls()
        self.manager.computer_control = None
        session = self.busy_session()
        with patch("tool_gateway.desktop.release_session") as release:
            self.manager.turn_ended(session, "completed", "text", backend=session.backend)
        release.assert_not_called()
        self.assertFalse(session.busy)
        self.assertEqual(calls, [])

# A deterministic CLI stand-in exercises the SAME session/process/MCP loop; no second model is involved.
DESKTOP_CODEX = r'''
import json, subprocess, sys, tomllib
config = tomllib.loads(sys.argv[-1])["mcp_servers"]["agentic_complex_desktop"]
def emit(message):
    print(json.dumps(message), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    if method == "initialize":
        emit({"id": request["id"], "result": {}})
    elif method == "thread/start":
        assert "approvalPolicy" not in request["params"]
        assert request["params"]["sandbox"] == "workspace-write"
        emit({"id": request["id"], "result": {"thread": {"id": "desktop-thread"}}})
    elif method == "turn/start":
        emit({"id": request["id"], "result": {}})
        emit({"method": "turn/started", "params": {"threadId": "desktop-thread", "turn": {"id": "desktop-turn"}}})
        emit({"id": 100, "method": "mcpServer/elicitation/request", "params": {
            "serverName": "agentic_complex_desktop", "threadId": "desktop-thread", "mode": "form",
            "requestedSchema": {"type": "object", "properties": {}},
            "message": "Allow desktop control for this action?", "_meta": {"codex_approval_kind": "mcp_tool_call"}}})
        approval = json.loads(next(sys.stdin))
        assert approval["id"] == 100 and approval["result"]["action"] == "accept", approval
        calls = [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26"}}]
        for name, arguments in [("desktop_status", {}), ("desktop_observe", {"target": {"pid": 1234, "window_id": 7}}),
                                ("desktop_act", {"snapshot_id": "snap-1", "action": "set_value", "element_id": "e1", "text": "done"}),
                                ("desktop_observe", {"target": {"pid": 1234, "window_id": 7}}),
                                ("desktop_verify", {"snapshot_id": "snap-2", "element_id": "e1", "expected_value": "done"})]:
            calls.append({"jsonrpc": "2.0", "id": len(calls) + 1, "method": "tools/call", "params": {"name": name, "arguments": arguments}})
        tool = subprocess.run([config["command"], *config["args"]], input="".join(json.dumps(c) + "\n" for c in calls),
                              capture_output=True, text=True, timeout=5)
        assert tool.returncode == 0, tool.stderr
        replies = [json.loads(l) for l in tool.stdout.splitlines()]
        assert all(not r.get("result", {}).get("isError") for r in replies), replies
        assert replies[-1]["result"]["structuredContent"]["effect"] == "confirmed"
        emit({"method": "item/completed", "params": {"item": {"type": "agentMessage", "text": "desktop result verified"}}})
        emit({"method": "turn/completed", "params": {"threadId": "desktop-thread", "turn": {"id": "desktop-turn", "status": "completed"}}})
'''


class OwnComputerEndToEndTest(unittest.TestCase):
    @unittest.skipIf(sys.platform == "win32", "the computer-use desktop endpoint is a unix socket served by the macOS app; its Windows side is not built")
    def test_user_task_approval_mcp_native_action_fresh_observation_and_result(self):
        with tempfile.TemporaryDirectory(prefix="ce-", dir="/tmp") as folder:
            native = Native(folder)
            broker = ApprovalBroker(hook_timeout=10)
            manager = SessionManager(broker, lambda *_: None, Path(folder), "http://localhost", "hook", 10,
                                     argv=lambda *_a, **_k: [sys.executable, "-u", "-c", DESKTOP_CODEX],
                                     computer_control=native.config)
            manager.codex_checked = True
            try:
                session = manager.create("codex", folder, "Update the granted editor field and verify", mode="workspace_write")
                deadline = time.monotonic() + 5
                while not broker.pending() and time.monotonic() < deadline:
                    time.sleep(.01)
                pending = broker.pending()
                self.assertEqual(len(pending), 1)
                self.assertEqual(pending[0]["tool_name"], "desktop_control")
                self.assertEqual(pending[0]["options"], ["allow", "deny"])
                self.assertEqual(native.requests, [], "no desktop call precedes the user's approval")
                broker.decide(pending[0]["request_id"], pending[0]["generation"], "allow")
                while session.busy and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertEqual(session.state, "done", list(session.lines))
                self.assertEqual(session.last_line, "desktop result verified")
                while len(native.requests) < 6 and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertEqual([r["method"] for r in native.requests],
                                 ["desktop_status", "desktop_observe", "desktop_act", "desktop_observe", "desktop_verify",
                                  "desktop_release"])
                self.assertTrue(all(r["session_id"] == session.session_id for r in native.requests))
            finally:
                manager.close()
                time.sleep(.05)  # let this task's bounded cancel reach the fake native endpoint before closing it
                native.close()
