"""The acp backend: settings, the session built from them against the fake ACP agent, approvals, semantic runs and
discovery."""
import base64
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from types import MethodType, SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_agent.harness import acp_agents
from character_agent.harness.registry import HARNESSES
from character_agent.integration import CharacterAgentController
from character_agent.routes import http
from character_agent.services.capabilities import describe
from character_agent.services.interactions import InteractionService
from character_agent.services.settings import DEFAULTS, RuntimeSettings
from character_agent.services.store import RunStore

FAKE = Path(__file__).resolve().parent / "fixtures/fake_acp_agent.py"
TOOLS = [{"name": "fixture_read", "description": "Read a fixture",
          "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}}}]
ACP = {"backend": "acp", "runtime_source": "local", "acp_agent": "claude-acp"}


class AcpSettingsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.settings = RuntimeSettings(self.tmp.name)

    def test_new_keys_default_and_are_written_with_the_rest(self):
        self.assertEqual({k: DEFAULTS[k] for k in ("acp_agent", "acp_launcher")},
                         {"acp_agent": None, "acp_launcher": "local"})
        self.settings.save({"model": "m"})
        self.assertEqual(json.loads(self.settings.path.read_text(encoding="utf-8")), {**DEFAULTS, "model": "m"})
        saved = self.settings.save({**ACP, "acp_launcher": "npx"})
        self.assertEqual(RuntimeSettings(self.tmp.name).snapshot(), saved)
        written = json.loads(self.settings.path.read_text(encoding="utf-8"))
        self.assertEqual({k: written[k] for k in ("backend", "acp_agent", "acp_launcher")},
                         {"backend": "acp", "acp_agent": "claude-acp", "acp_launcher": "npx"})

    def test_invalid_acp_values_are_rejected(self):
        for values, code in (({**ACP, "acp_agent": "no-such-agent"}, "invalid_acp_agent"),
                             ({**ACP, "acp_agent": None}, "invalid_acp_agent"),
                             ({**ACP, "acp_agent": ["claude-acp"]}, "invalid_acp_agent"),
                             ({"acp_agent": "no-such-agent"}, "invalid_acp_agent"),
                             ({**ACP, "acp_launcher": "brew"}, "invalid_acp_launcher"),
                             ({**ACP, "runtime_source": "bundled"}, "invalid_runtime_source"),
                             ({**ACP, "provider": "anthropic"}, "provider_not_supported_by_harness"),
                             ({**ACP, "auth_source": "api_key"}, "unsupported_auth_source")):
            with self.subTest(values=values), self.assertRaisesRegex(ValueError, code):
                self.settings.save(values)
        self.assertFalse(self.settings.path.exists())

    def test_capabilities_offer_the_agents_own_shell_behind_approval_cards(self):
        features = describe({**DEFAULTS, **ACP})["features"]
        self.assertEqual(features["native_shell"], {"implemented": True, "enabled": True, "reason": "approval_cards"})
        self.assertEqual(features["web_access"]["reason"], "unsupported_by_runtime")
        self.assertEqual(features["domain_tools"], {"implemented": True, "reason": None})
        self.assertFalse(features["builtin_tools"]["verified"])
        self.assertEqual(HARNESSES["acp"].provider, "acp")


class AcpHarnessCase(unittest.TestCase):
    """A temp bin whose claude-agent-acp is the fake ACP agent; nothing else is on the search path."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.log = self.root / "agent.jsonl"
        for patch in (mock.patch.object(acp_agents, "SEARCH_DIRS", ()),
                      mock.patch.dict(os.environ, {"PATH": str(self.bin)})):
            patch.start()
            self.addCleanup(patch.stop)

    def agent(self, script, **env):
        exports = "".join(f"export {k}={v}\n" for k, v in {"FAKE_ACP_SCRIPT": script, "FAKE_ACP_LOG": self.log, **env}.items())
        path = self.bin / "claude-agent-acp"
        path.write_text(f"#!/bin/sh\n{exports}exec {sys.executable} -I -B {FAKE} \"$@\"\n", encoding="utf-8")
        path.chmod(0o755)
        return str(path)

    def agent_log(self, event):
        with open(self.log, encoding="utf-8") as f:
            return [r for r in map(json.loads, f) if r["event"] == event]


class AcpSessionTest(AcpHarnessCase):
    def setUp(self):
        super().setUp()
        self.store = RunStore(self.root / "ledger.sqlite3")
        self.addCleanup(self.store.db.close)
        self.cards = []
        self.decision = None
        self.interactions = InteractionService(self.store, emit=self.card)
        self.controller = SimpleNamespace(python=sys.executable, store=self.store, interactions=self.interactions, semantic=SimpleNamespace(reply=lambda: None),
                                          _acp_logins={})
        self.handled = []
        approve = MethodType(CharacterAgentController._harness_permission, self.controller)
        self.controller._harness_permission = lambda request, source, name: \
            self.handled.append(approve(request, source, name)) or self.handled[-1]

    def card(self, event):
        """Answer each new approval card as the user would."""
        if event["state"] != "pending" or self.decision is None:
            return
        row = self.interactions.get(event["request_id"])
        self.cards.append(row)
        self.interactions.respond(event["request_id"], row["revision"], {"decision": [self.decision]})

    def session(self):
        config = {**DEFAULTS, **ACP, "_turn_effort": None}
        common = dict(state_dir=self.root / "runner" / "acp", api_key="", model="", runtime_source="local",
                      workspace_dir=str(self.root), native_tools=True)
        session = HARNESSES["acp"].session(self.controller, config, common, TOOLS)
        self.addCleanup(session.close)
        return session

    def run_turn(self, session, run_id="run-1", tool_handler=None):
        self.store.begin(run_id, "c" * 32, "aster", 1)
        return list(session.stream("Read my notes", system_prompt="Synthetic assistant.", run_id=run_id,
                                   tool_handler=tool_handler))

    @unittest.skipIf(sys.platform == "win32", "harness discovery and install look only in POSIX locations")
    def test_turn_reaches_the_tool_handler_over_mcp(self):
        command = self.agent("normal")
        self.decision = "allow"
        session = self.session()
        self.assertEqual(session.config.agent_command, [command])
        self.assertEqual((session.config.session_meta, session.config.mode), (None, None))
        calls = []
        events = self.run_turn(session, tool_handler=lambda name, args: calls.append((name, args)) or {"ok": True})
        ready = events[0]
        self.assertEqual((ready["type"], ready["tool_names"], ready["capabilities"]["tool_injection"]),
                         ("ready", ["fixture_read"], "mcp_stdio"))
        self.assertEqual(calls, [("fixture_read", {"path": "notes.txt"})])
        result = events[-1]
        self.assertEqual((result["type"], result["success"], result["text"]), ("result", True, "Hello world"))
        # The execute request goes to an approval card like any other.
        self.assertEqual(self.agent_log("permission")[0]["answer"]["result"]["outcome"]["optionId"], "allow-once")
        self.assertEqual((self.handled, [card["data"]["preview"]["kind"] for card in self.cards]), (["allow-once"], ["execute"]))
        self.assertEqual(self.controller._acp_logins, {"claude-acp": True})
        self.assertNotIn("_meta", self.agent_log("session_new")[0]["params"])

    @unittest.skipIf(sys.platform == "win32", "harness discovery and install look only in POSIX locations")
    def test_opencode_lock_reaches_only_semantic_agent_processes(self):
        opencode = self.bin / "opencode"
        opencode.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        opencode.chmod(0o755)
        config = {**DEFAULTS, **ACP, "acp_agent": "opencode", "_turn_effort": None}
        for native in (True, False):
            with self.subTest(native=native):
                common = dict(state_dir=self.root / "runner" / "acp", api_key="", model="", runtime_source="local",
                              workspace_dir=str(self.root), native_tools=native)
                session = HARNESSES["acp"].session(self.controller, config, common, TOOLS)
                self.addCleanup(session.close)
                wire = session.config.wire()
                self.assertEqual(wire["agent_command"], [str(opencode), "acp"])
                lock = wire["agent_env"].get("OPENCODE_CONFIG_CONTENT")
                self.assertEqual(lock and json.loads(lock),
                                 None if native else {"permission": {"*": "deny", "agentic_complex_*": "allow"}})

    @unittest.skipIf(sys.platform == "win32", "harness discovery and install look only in POSIX locations")
    def test_edit_goes_on_an_approval_card(self):
        self.agent("edit")
        for decision, option_id, agent_answer in (("allow", "allow-once", "allow-once"), ("deny", None, "reject-once")):
            with self.subTest(decision=decision):
                self.log.unlink(missing_ok=True)
                self.handled.clear()
                self.cards.clear()
                self.decision = decision
                session = self.session()
                events = self.run_turn(session, run_id="run-" + decision)
                self.assertTrue(events[-1]["success"])
                self.assertEqual(self.handled, [option_id])
                [card] = self.cards
                self.assertEqual((card["kind"], card["run_id"]), ("approval", "run-" + decision))
                self.assertEqual(card["data"]["preview"], {"source": "acp_agent", "agent": "Claude Agent",
                    "title": "Edit notes.txt", "kind": "edit", "locations": ["/work/notes.txt"],
                    "raw_input": {"path": "/work/notes.txt", "new_text": "hi"}})
                self.assertEqual(card["data"]["approval_answers"], ["allow", "deny"])
                self.assertIn("permission_requested", [e["type"] for e in events])
                self.assertEqual(self.agent_log("permission")[0]["answer"]["result"]["outcome"]["optionId"], agent_answer)
                session.close()

    def test_missing_agent(self):
        with self.assertRaisesRegex(ValueError, "acp_agent_missing"):
            self.session()


class AcpSemanticTest(AcpHarnessCase):
    """SemanticService.run with backend acp: one fake ACP agent session per task."""

    def setUp(self):
        super().setUp()
        from brain.egress import EgressPolicy
        from brain.provider import Mouth
        from daemon.agentd_server import AgentdServer
        from infra.store import open_store
        from personal.episodes import Episodes
        from personal.history import History
        from personal.memory import Memory
        from sessions.tasks import TaskLedger
        self.db = open_store(self.root / "domain.sqlite")
        self.addCleanup(self.db.close)
        lock = threading.RLock()
        with mock.patch("socketserver.TCPServer.server_bind"), mock.patch("socketserver.TCPServer.server_activate"), \
                mock.patch.object(AgentdServer, "_tick_loop"):
            server = self.server = AgentdServer(("127.0.0.1", 48810), "hook", "ui")
        self.addCleanup(server.server_close)
        server.character = "aster"
        server.memory, server.history = Memory(self.db, lock=lock), History(self.db, lock=lock)
        server.tasks, server.episodes = TaskLedger(self.db, lock=lock), Episodes(self.db, lock=lock)
        server.egress = EgressPolicy()
        server.mouth = Mouth(egress=server.egress)
        self.c = server.character_agent = CharacterAgentController(server, self.root / "state")
        self.addCleanup(lambda: (self.c.close(), self.c.store.close(), self.c.workspace.close()))
        self.c.python = sys.executable
        self.c.settings.save({**ACP, "workspace_dir": str(self.root / "workspace")})
        self.sessions = []
        factory = self.c._session_factory
        self.c._session_factory = lambda *args, **kwargs: self.sessions.append(factory(*args, **kwargs)) or self.sessions[-1]

    @unittest.skipIf(sys.platform == "win32", "harness discovery and install look only in POSIX locations")
    def test_semantic_run_parses_the_agents_json_and_records_its_agent(self):
        self.agent("json", FAKE_ACP_SESSION="levels")
        meter = self.c.semantic.usage
        with mock.patch.object(meter, "record", wraps=meter.record) as record:
            result = self.c.semantic.run("review", "返回JSON", {})
        self.assertEqual((result["backend"], result["value"]), ("acp", {"description": "a terminal window"}))
        self.assertEqual((record.call_args.kwargs["provider"], record.call_args.kwargs["channel"]),
                         ("claude-acp", "acp_existing_login"))
        [session] = self.sessions
        self.assertEqual((session.config.effort, session.config.native_tools), ("medium", False))
        self.assertEqual((session.config.session_meta, session.config.mode), (acp_agents.LOCKS["claude-acp"]["session_meta"], "default"))
        self.assertEqual(session.config.workspace_dir, str(self.root / "workspace"))
        self.assertIn(("effort", "medium"), [(r["params"]["configId"], r["params"]["value"])
                                            for r in self.agent_log("set_config_option")])

    @unittest.skipIf(sys.platform == "win32", "harness discovery and install look only in POSIX locations")
    def test_observation_image_reaches_the_agent_as_mcp_image_content(self):
        from character_agent.services.semantic import SemanticVision
        self.agent("json")
        png = b"\x89PNG\r\n\x1a\nfixture"
        self.assertEqual(SemanticVision(self.c.semantic).describe(png), "a terminal window")
        [reply] = [r["reply"]["result"] for r in self.agent_log("tool_result") if r["name"] == "observation_image"]
        self.assertEqual(reply["content"], [{"type": "image", "mimeType": "image/png",
                                             "data": base64.b64encode(png).decode()}])


class AcpAgentsRouteTest(AcpHarnessCase):
    def controller(self):
        controller = SimpleNamespace(_acp_probes={}, _lock=threading.RLock())
        controller.acp_agents = MethodType(CharacterAgentController.acp_agents, controller)
        controller.acp_install = MethodType(CharacterAgentController.acp_install, controller)
        return controller

    def post(self, controller, body):
        replies = []
        server = SimpleNamespace(ui_token="token", resetting=False, closing=False, character_agent=controller)
        handler = SimpleNamespace(path="/character/acp/install", server=server, auth=lambda token: token == "token",
                                  body=lambda: body, json=lambda status, data: replies.append((status, data)))
        self.assertTrue(http.route(handler, "POST", "/character/acp/install"))
        [reply] = replies
        return reply

    @unittest.skipIf(sys.platform == "win32", "harness discovery and install look only in POSIX locations")
    def test_install_runs_npm_for_the_picked_agent_and_lists_it_as_local_afterwards(self):
        log = self.root / "npm-argv"
        npm = self.bin / "npm"
        npm.write_text(f"#!/bin/sh\nprintf '%s\\n' \"$*\" >> {log}\nprintf '#!/bin/sh\\n' > {self.bin}/gemini\n"
                       f"/bin/chmod 755 {self.bin}/gemini\necho added 1 package\n", encoding="utf-8")
        npm.chmod(0o755)
        controller = self.controller()
        status, value = self.post(controller, {"agent_id": "gemini"})
        self.assertEqual((status, value), (200, {"ok": True, "agent_id": "gemini", "exit": 0, "output_tail": "added 1 package\n",
                                                 "command": [str(npm), "install", "-g", "@google/gemini-cli@0.68.0"]}))
        self.assertEqual(log.read_text(encoding="utf-8"), "install -g @google/gemini-cli@0.68.0\n")
        gemini = next(a for a in self.get(controller)["agents"] if a["id"] == "gemini")
        self.assertEqual((gemini["source"], gemini["command"]), ("local", [str(self.bin / "gemini"), "--acp"]))

    def test_install_refuses_agents_without_a_package_and_a_missing_installer(self):
        controller = self.controller()
        self.assertEqual(self.post(controller, {"agent_id": "goose"}), (400, {"error": "acp_install_unsupported"}))
        self.assertEqual(self.post(controller, {"agent_id": "gemini"}), (400, {"error": "acp_installer_missing"}))
        for body in ({}, {"agent_id": 3}, {"agent_id": "gemini", "force": True}):
            with self.subTest(body=body):
                self.assertEqual(self.post(controller, body), (400, {"error": "invalid_payload"}))

    def get(self, controller, query=""):
        replies = []
        server = SimpleNamespace(ui_token="token", resetting=False, closing=False, character_agent=controller)
        handler = SimpleNamespace(path="/character/acp/agents" + query, server=server, auth=lambda token: token == "token",
                                  json=lambda status, data: replies.append((status, data)))
        self.assertTrue(http.route(handler, "GET", "/character/acp/agents"))
        [(status, value)] = replies
        self.assertEqual(status, 200)
        return value

    @unittest.skipIf(sys.platform == "win32", "harness discovery and install look only in POSIX locations")
    def test_lists_local_and_npx_agents_and_probes_only_local_ones(self):
        command = self.agent("echo")
        marker = self.root / "npx-ran"
        npx = self.bin / "npx"
        npx.write_text(f"#!/bin/sh\ntouch {marker}\nexit 1\n", encoding="utf-8")
        npx.chmod(0o755)
        controller = self.controller()
        probed = []
        real_probe = acp_agents.probe
        with mock.patch.object(acp_agents, "probe", lambda argv, env=None, timeout=10:
                               probed.append((list(argv), timeout)) or real_probe(argv, env, timeout)):
            cold = self.get(controller)
            value = self.get(controller, "?refresh=1")
            cached = self.get(controller)
        self.assertEqual(probed, [([command], 10)])
        self.assertFalse(marker.exists())
        local = next(a for a in cold["agents"] if a["id"] == "claude-acp")
        self.assertEqual(local, {"id": "claude-acp", "name": "Claude Agent", "version": None, "source": "local",
                                 "command": [command], "probe": None, "native_backend": "claude"})
        self.assertEqual((value["npx"], value["uvx"]), (True, False))
        agents = {a["id"]: a for a in value["agents"]}
        self.assertEqual(agents["claude-acp"], {"id": "claude-acp", "name": "Claude Agent", "version": "0.1.0",
            "source": "local", "command": [command], "probe": {"ok": True,
                "agent_info": {"name": "fake-acp", "title": "Fake ACP", "version": "0.1.0"},
                "auth_methods": [{"id": "fake-login", "name": "Fake login"}], "error": None}, "native_backend": "claude"})
        self.assertEqual(agents["codex-acp"], {"id": "codex-acp", "name": "Codex", "version": "2.7.0", "source": "npx",
            "command": [str(npx), "-y", "@agentclientprotocol/codex-acp@2.7.0"], "probe": None, "native_backend": "codex"})
        self.assertIsNone(agents["gemini"]["native_backend"])
        self.assertTrue(all(set(a) == {"id", "name", "version", "source", "command", "probe", "native_backend"}
                            for a in value["agents"]))
        self.assertEqual({a["source"] for a in value["agents"]}, {"local", "npx"})
        self.assertEqual(cached, value)


if __name__ == "__main__":
    unittest.main()
