"""ACP agent discovery against fake executables, and probe against the scripted fake ACP agent."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_agent.harness import acp_agents
from character_agent.harness.acp_runner import CLIENT_CAPABILITIES, RunnerFailure

FAKE = Path(__file__).resolve().parent / "fixtures/fake_acp_agent.py"


class AcpAgentsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.bin = Path(self.tmp.name) / "bin"
        self.bin.mkdir()

    def executable(self, name, mode=0o755):
        path = self.bin / name
        path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        path.chmod(mode)
        return str(path)

    def test_registry_snapshot_parses_and_covers_local_commands(self):
        snapshot = acp_agents.registry()
        self.assertEqual(snapshot["source"], {"repository": "https://github.com/agentclientprotocol/registry",
                                              "snapshot_date": "2026-11-17"})
        agents = {agent["id"]: agent for agent in snapshot["agents"]}
        self.assertEqual(len(agents), len(snapshot["agents"]))
        for agent in agents.values():
            self.assertTrue({"id", "name", "version", "distribution"} <= set(agent))
        self.assertLessEqual(set(acp_agents.LOCAL_COMMANDS), set(agents))
        self.assertNotIn("opencode-v2", acp_agents.LOCAL_COMMANDS)
        for agent_id, (command, args) in acp_agents.LOCAL_COMMANDS.items():
            binary = agents[agent_id]["distribution"].get("binary", {}).get("darwin-aarch64")
            # agy is the Antigravity CLI, which serves ACP itself, not the registry's agy_acp_server archive.
            if binary and agent_id != "antigravity-acp":
                with self.subTest(agent_id):
                    self.assertEqual((command, args), (os.path.basename(binary["cmd"]), binary.get("args") or []))

    @unittest.skipIf(sys.platform == "win32", "harness discovery and install look only in POSIX locations")
    def test_find_local_lists_executables_with_acp_arguments(self):
        claude = self.executable("claude-agent-acp")
        qwen = self.executable("qwen")
        self.executable("goose", mode=0o644)
        found = acp_agents.find_local([str(self.bin)])
        self.assertEqual(sorted(found, key=lambda a: a["id"]), [
            {"id": "claude-acp", "name": "Claude Agent", "command": [claude], "source": "local"},
            {"id": "qwen-code", "name": "Qwen Code", "command": [qwen, "--acp"], "source": "local"}])

    @unittest.skipIf(sys.platform == "win32", "harness discovery and install look only in POSIX locations")
    def test_deepseek_harness_runs_the_acp_profile_with_the_locked_repo_patch(self):
        self.executable("npx")
        self.executable("uvx")
        self.assertNotIn("deepseek-harness", {e["id"] for e in acp_agents.launchable([str(self.bin)])})
        dsh = self.executable("dsh")
        found = [a for a in acp_agents.find_local([str(self.bin)]) if a["id"] == "deepseek-harness"]
        patch = Path(acp_agents.__file__).resolve().with_name("dsh-acp.patch.json")
        self.assertEqual(found, [{"id": "deepseek-harness", "name": "DeepSeek Harness", "source": "local",
                                  "command": [dsh, "--profile", "acp", "--patch", str(patch)]}])
        self.assertEqual(json.loads(patch.read_text(encoding="utf-8")), [{"id": "session-log-deepseek", "disabled": True}])

    def test_semantic_launch_locks_the_agent_to_endfields_tools(self):
        dsh = {"id": "deepseek-harness", "command": ["/bin/dsh", "--patch", str(acp_agents.DSH_PATCH)]}
        self.assertEqual(acp_agents.launch(dsh, True), (dsh["command"], {}, None, None))
        command, _, _, _ = acp_agents.launch(dsh, False)
        self.assertEqual(command, ["/bin/dsh", "--patch", str(acp_agents.DSH_LOCKED_PATCH)])
        disabled = {entry["id"] for entry in json.loads(acp_agents.DSH_LOCKED_PATCH.read_text(encoding="utf-8"))
                    if entry.get("disabled") is True}
        self.assertLessEqual({"session-log-deepseek", "tool-bash", "tool-fs", "tool-web", "mcp-resources"}, disabled)
        opencode = {"id": "opencode", "command": ["/bin/opencode", "acp"], "env": {"A": "1"}}
        self.assertEqual(acp_agents.launch(opencode, True), (opencode["command"], {"A": "1"}, None, None))
        _, env, _, _ = acp_agents.launch(opencode, False)
        self.assertEqual(json.loads(env.pop("OPENCODE_CONFIG_CONTENT")),
                         {"permission": {"*": "deny", "agentic_complex_*": "allow"}})
        self.assertEqual(env, {"A": "1"})
        claude = {"id": "claude-acp", "command": ["/bin/claude-agent-acp"]}
        _, env, meta, mode = acp_agents.launch(claude, True)
        self.assertEqual((meta, mode), (None, None))
        self.assertTrue(set(env) <= {"CLAUDE_CODE_EXECUTABLE"})
        # No built-in tool: Claude Code runs its read-only ones without asking, so a refused permission cannot stop them.
        self.assertEqual(acp_agents.launch(claude, False)[2:], ({"claudeCode": {"options": {"settingSources": [], "tools": []}}}, "default"))

    def test_semantic_launch_refuses_an_agent_without_a_lock(self):
        for agent in ({"id": "goose", "command": ["/bin/goose", "acp"]}, {"id": "kimi", "command": ["/bin/kimi", "acp"]}):
            with self.subTest(agent["id"]):
                self.assertEqual(acp_agents.launch(agent, True)[0], agent["command"])
                with self.assertRaisesRegex(ValueError, "acp_agent_unrestricted"):
                    acp_agents.launch(agent, False)

    @unittest.skipIf(sys.platform == "win32", "harness discovery and install look only in POSIX locations")
    def test_a_local_install_keeps_its_registry_env(self):
        muse = self.executable("muse")
        [found] = [a for a in acp_agents.find_local([str(self.bin)]) if a["id"] == "muse-code"]
        self.assertEqual(found, {"id": "muse-code", "name": found["name"], "command": [muse, "acp"], "source": "local",
                                 "env": {"MUSE_EXPERIMENTAL_ACP": "on"}})
        self.assertEqual(acp_agents.launch(found, True)[1], {"MUSE_EXPERIMENTAL_ACP": "on"})

    @unittest.skipIf(sys.platform == "win32", "harness discovery and install look only in POSIX locations")
    def test_launchable_lists_registry_packages_also_found_locally(self):
        self.executable("claude-agent-acp")
        npx, uvx = self.executable("npx"), self.executable("uvx")
        entries = {entry["id"]: entry for entry in acp_agents.launchable([str(self.bin)])}
        # A saved npx launcher still resolves after the same agent is installed globally.
        self.assertEqual((entries["claude-acp"]["source"], entries["claude-acp"]["command"][0]), ("npx", npx))
        self.assertNotIn("goose", entries)
        self.assertEqual(entries["codex-acp"], {"id": "codex-acp", "name": "Codex", "source": "npx",
                                                "command": [npx, "-y", "@agentclientprotocol/codex-acp@2.7.0"], "env": {}})
        self.assertEqual(entries["auggie"]["env"], {"AUGMENT_DISABLE_AUTO_UPDATE": "1"})
        self.assertEqual(entries["qwen-code"]["command"], [npx, "-y", "@qwen-code/qwen-code@0.28.0", "--acp", "--experimental-skills"])
        self.assertEqual(entries["fast-agent"], {"id": "fast-agent", "name": entries["fast-agent"]["name"],
                                                 "source": "uvx", "command": [uvx, "fast-agent-acp==0.10.1", "-x"],
                                                 "env": {"FAST_AGENT_MODEL": "codexplan"}})

    def test_launchable_is_empty_without_npx_or_uvx(self):
        self.assertEqual(acp_agents.launchable([str(self.bin)]), [])

    def test_probe_sends_initialize_only(self):
        log = os.path.join(self.tmp.name, "agent.jsonl")
        result = acp_agents.probe([sys.executable, "-I", "-B", str(FAKE)], env={"FAKE_ACP_LOG": log})
        self.assertTrue(result["ok"])
        self.assertIsNone(result["error"])
        self.assertEqual(result["agent_info"], {"name": "fake-acp", "title": "Fake ACP", "version": "0.1.0"})
        self.assertEqual(result["auth_methods"], [{"id": "fake-login", "name": "Fake login"}])
        self.assertEqual(result["capabilities"]["sessionCapabilities"], {"systemPrompt": {}})
        with open(log, encoding="utf-8") as f:
            events = [json.loads(line) for line in f]
        self.assertEqual([e["event"] for e in events], ["initialize"])
        self.assertEqual(events[0]["params"]["clientCapabilities"], CLIENT_CAPABILITIES)

    @unittest.skipIf(sys.platform == "win32", "harness discovery and install look only in POSIX locations")
    def test_probe_reports_missing_and_exiting_agents(self):
        self.assertEqual(acp_agents.probe([str(self.bin / "absent")])["error"], "acp_agent_unavailable")
        result = acp_agents.probe([self.executable("quits")], timeout=5)
        self.assertEqual((result["ok"], result["error"]), (False, "acp_agent_exited"))

    def test_probe_sign_in_and_account_children_get_a_scrubbed_env_on_the_search_path(self):
        seen = []

        class Agent:
            def __init__(self, argv, env, *_):
                seen.append(env)

            async def start(self):
                raise RunnerFailure("acp_agent_unavailable")

            async def disconnect(self):
                pass

        with mock.patch.dict(os.environ, {"AGENTD_HOOK_TOKEN": "t", "AAC_TTS_TOKEN": "t", "PATH": "/usr/bin"}, clear=True), \
                mock.patch.object(acp_agents, "AcpAgent", Agent):
            acp_agents.probe(["/bin/agent"], env={"A": "1"})
            acp_agents.authenticate(["/bin/agent"], None, "login", 5, None)
            acp_agents.deepseek_signed_in(["/bin/dsh"])
        self.assertEqual(len(seen), 3)
        for env in seen:
            self.assertFalse({"AGENTD_HOOK_TOKEN", "AAC_TTS_TOKEN"} & set(env))
            self.assertIn("/opt/homebrew/bin", env["PATH"].split(os.pathsep))
        self.assertEqual(seen[0]["A"], "1")

    def test_native_backends_mark_the_bridges_of_harnesses_with_their_own_kernel(self):
        self.assertEqual(acp_agents.NATIVE_BACKENDS, {"claude-acp": "claude", "codex-acp": "codex"})


class AcpInstallTest(unittest.TestCase):
    """npm and uv are fake executables that record their argv and may drop the agent's binary on the path."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.bin = Path(self.tmp.name) / "bin"
        self.bin.mkdir()
        self.log = Path(self.tmp.name) / "argv.log"

    def fake(self, name, drops=None, exit_code=0):
        drop = f"printf '#!/bin/sh\\n' > {self.bin / drops}\n/bin/chmod 755 {self.bin / drops}\n" if drops else ""
        path = self.bin / name
        path.write_text(f"#!/bin/sh\nprintf '%s\\n' \"{name} $*\" >> {self.log}\necho installing\n{drop}exit {exit_code}\n", encoding="utf-8")
        path.chmod(0o755)
        return str(path)

    @unittest.skipIf(sys.platform == "win32", "harness discovery and install look only in POSIX locations")
    def test_npx_agent_installs_its_package_globally_and_is_found_locally_afterwards(self):
        npm = self.fake("npm", drops="qodercli")
        self.assertNotIn("qoder", {a["id"] for a in acp_agents.find_local([str(self.bin)])})
        result = acp_agents.install("qoder", [str(self.bin)])
        self.assertEqual(result, {"ok": True, "agent_id": "qoder", "command": [npm, "install", "-g", "@qoder-ai/qodercli@1.1.91"],
                                  "exit": 0, "output_tail": "installing\n"})
        self.assertEqual(self.log.read_text(encoding="utf-8"), "npm install -g @qoder-ai/qodercli@1.1.91\n")
        found = {a["id"]: a for a in acp_agents.find_local([str(self.bin)])}
        self.assertEqual(found["qoder"]["command"], [str(self.bin / "qodercli"), "--acp"])

    @unittest.skipIf(sys.platform == "win32", "harness discovery and install look only in POSIX locations")
    def test_uvx_agent_installs_the_registry_spec_as_a_uv_tool(self):
        uv = self.fake("uv", drops="fast-agent-acp")
        result = acp_agents.install("fast-agent", [str(self.bin)])
        self.assertEqual(result["command"], [uv, "tool", "install", "fast-agent-acp==0.10.1"])
        self.assertEqual(self.log.read_text(encoding="utf-8"), "uv tool install fast-agent-acp==0.10.1\n")
        self.assertIn("fast-agent", {a["id"] for a in acp_agents.find_local([str(self.bin)])})

    @unittest.skipIf(sys.platform == "win32", "harness discovery and install look only in POSIX locations")
    def test_install_runs_without_agentds_own_variables(self):
        self.fake("npm")
        with mock.patch.dict(os.environ, {"AGENTD_HOOK_TOKEN": "t", "PATH": "/usr/bin"}, clear=True), \
                mock.patch.object(acp_agents.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=b"")) as run:
            acp_agents.install("qoder", [str(self.bin)])
        env = run.call_args.kwargs["env"]
        self.assertNotIn("AGENTD_HOOK_TOKEN", env)
        self.assertEqual(env["PATH"], str(self.bin))

    @unittest.skipIf(sys.platform == "win32", "harness discovery and install look only in POSIX locations")
    def test_a_failed_install_reports_its_exit_and_output(self):
        self.fake("npm", exit_code=3)
        result = acp_agents.install("qwen-code", [str(self.bin)])
        self.assertEqual((result["ok"], result["exit"], result["output_tail"]), (False, 3, "installing\n"))

    def test_refuses_binary_only_local_only_and_unknown_agents_and_a_missing_installer(self):
        self.fake("npm")
        self.fake("uv")
        for agent_id, code in (("goose", "acp_install_unsupported"), ("deepseek-harness", "acp_install_unsupported"),
                               ("no-such-agent", "invalid_acp_agent")):
            with self.subTest(agent_id), self.assertRaisesRegex(ValueError, code):
                acp_agents.install(agent_id, [str(self.bin)])
        (self.bin / "npm").unlink()
        with self.assertRaisesRegex(ValueError, "acp_installer_missing"):
            acp_agents.install("qoder", [str(self.bin)])
        self.assertFalse(self.log.exists())

    def test_every_npx_or_uvx_agent_has_a_local_command_after_install(self):
        for agent in acp_agents.registry()["agents"]:
            if {"npx", "uvx"} & set(agent["distribution"]):
                with self.subTest(agent["id"]):
                    self.assertIn(agent["id"], acp_agents.LOCAL_COMMANDS)

    @unittest.skipIf(sys.platform == "win32", "harness discovery and install look only in POSIX locations")
    def test_repo_script_prints_the_install_command_without_running_it(self):
        self.fake("npm")
        script = Path(__file__).resolve().parents[3] / "tools" / "acp" / "install_agent.py"
        env = {**os.environ, "PATH": str(self.bin)}
        printed = subprocess.run([sys.executable, "-I", str(script), "qoder", "--print"], env=env,
                                 capture_output=True, text=True, timeout=60, encoding="utf-8")
        self.assertEqual((printed.returncode, printed.stdout), (0, f"{self.bin / 'npm'} install -g @qoder-ai/qodercli@1.1.91\n"))
        self.assertFalse(self.log.exists())
        refused = subprocess.run([sys.executable, "-I", str(script), "goose", "--print"], env=env,
                                 capture_output=True, text=True, timeout=60, encoding="utf-8")
        self.assertEqual((refused.returncode, refused.stderr.strip()), (1, "acp_install_unsupported"))


if __name__ == "__main__":
    unittest.main()
