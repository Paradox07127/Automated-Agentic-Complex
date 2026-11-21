import contextlib
import http.server
import io
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

AGENTD = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AGENTD / "tools"))

import install_hooks  # noqa: E402
from support import serve_in_thread  # noqa: E402

URL = "http://127.0.0.1:48810"
EXAMPLES = AGENTD / "config-examples"
CLAUDE_EVENTS = list(json.loads((EXAMPLES / "claude-settings.agentd.json").read_text(encoding="utf-8"))["hooks"])
CODEX_EVENTS = list(json.loads((EXAMPLES / "codex-hooks.agentd.json").read_text(encoding="utf-8"))["hooks"])
NOTIFICATION_MATCHER = "permission_prompt|idle_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input"
SECRET = "sk-test-not-a-real-secret"
# The user's own hooks on the events this tool also uses; none of them is ours.
USER_COMMANDS = {
    "guard": "/Users/me/bin/guard.sh --strict",
    "example": "python3 /opt/agentd/codex_hook_forward.py --endpoint /hook/claude --url " + URL
               + " --token-file /opt/state/hook.token --timeout 3",
    "other_agentd": "python3 /opt/agentd/codex_hook_forward.py --endpoint /hook/claude --observe --timeout 0.8"
                    " --url http://127.0.0.1:48899 --token-file /opt/state/hook.token",
    "pair": "python3 /opt/agentd/codex_hook_forward.py --observe --url " + URL + " --token-file /opt/t",
    "say": "say done",
}
USER_SETTINGS = {
    "model": "opus",
    "env": {"MY_KEY": SECRET},
    "hooks": {
        "PreToolUse": [
            {"matcher": "Bash", "hooks": [{"type": "command", "command": USER_COMMANDS["guard"], "timeout": 10}]},
            {"hooks": [{"type": "http", "url": "http://127.0.0.1:9999/mine", "timeout": 3,
                        "headers": {"Authorization": "Bearer " + SECRET}}]}],
        "SessionStart": [{"hooks": [{"type": "command", "command": USER_COMMANDS["example"], "timeout": 5}]}],
        "Notification": [{"matcher": "", "hooks": [{"type": "command", "command": USER_COMMANDS["other_agentd"]}]}],
        "Stop": [{"hooks": [{"type": "command", "command": USER_COMMANDS["say"]},
                            {"type": "command", "command": USER_COMMANDS["pair"]}]}],
        "MyOwnEvent": [],
    },
    "permissions": {"allow": ["Bash(ls)"], "deny": []},
    "statusLine": {"type": "command", "command": "~/bin/status.sh"},
}
USER_CODEX_HOOKS = {
    "hooks": {
        "PreToolUse": [{"matcher": "shell", "hooks": [{"type": "command", "command": USER_COMMANDS["guard"],
                                                       "timeout": 30}]}],
        "Stop": [{"hooks": [{"type": "command", "command": USER_COMMANDS["say"]}]}],
    },
}


def windows_quote(s, endpoint):
    """Claude Code runs our hook in PowerShell (single quotes, a quote doubled), Codex in cmd (double quotes)."""
    return "'" + re.sub("(['‘’‚‛])", r"\1\1", s) + "'" if endpoint == "/hook/claude" else f'"{s}"'


class InstallerCase(unittest.TestCase):
    windows = sys.platform == "win32"  # the platform install_hooks writes for

    def setUp(self):
        patch = mock.patch.object(install_hooks, "WINDOWS", self.windows)
        patch.start()
        self.addCleanup(patch.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "claude").mkdir()
        self.settings = self.root / "claude" / "settings.json"
        self.codex = self.root / "codex"
        self.codex.mkdir()
        self.hooks_json = self.codex / "hooks.json"
        self.token = self.root / "App Support" / "hook.token"
        self.forwarder = self.root / "agent bridge" / "codex_hook_forward.py"
        self.python = "/usr/bin/python3"

    def run_tool(self, *extra, url=URL, forwarder=None):
        """(exit code, stdout, stderr); every path points into the temp dir."""
        argv = ["--claude-settings", str(self.settings), "--codex-home", str(self.codex), "--url", url,
                "--token-file", str(self.token), "--python", self.python,
                "--forwarder", str(forwarder or self.forwarder), *extra]
        for path in (self.settings, self.codex, self.token):
            self.assertTrue(str(path).startswith(self.tmp.name))
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                code = install_hooks.main(argv)
            except SystemExit as e:
                code = e.code
        return code, out.getvalue(), err.getvalue()

    def write_json(self, path, data, mode=0o644):
        path.write_text(json.dumps(data, indent=4) + "\n", encoding="utf-8")
        path.chmod(mode)
        return path.read_bytes()

    def copies(self, path):
        """Files beside path other than path itself and Codex's config.toml; the tool leaves none."""
        return sorted(p for p in path.parent.iterdir() if p.name not in (path.name, "config.toml"))

    def words(self, program, endpoint, url=URL):
        quote = (lambda s: windows_quote(s, endpoint)) if self.windows else shlex.quote
        words = [*map(quote, program), "--endpoint", endpoint, "--observe", "--timeout", "0.8", "--url", quote(url),
                 "--token-file", quote(str(self.token))]
        return " ".join(["&", *words] if self.windows and endpoint == "/hook/claude" else words)

    def command(self, endpoint, url=URL, forwarder=None, program=None):
        return self.words(program or [self.python, str(forwarder or self.forwarder)], endpoint, url)

    def hook(self, command, endpoint):
        """The hook the tool installs: in the background; for Claude Code the action goes on when it fails."""
        shell = {"shell": "powershell"} if self.windows and endpoint == "/hook/claude" else {}
        extra = {"onFailure": "continue"} if endpoint == "/hook/claude" else {}
        return {"type": "command", "command": command, **shell, "async": True, **extra, "timeout": 2}

    def group(self, endpoint, event="Stop", **kw):
        group = {"hooks": [self.hook(self.command(endpoint, **kw), endpoint)]}
        return {"matcher": NOTIFICATION_MATCHER, **group} if event == "Notification" else group

    def legacy_group(self, endpoint, **kw):
        """A group of ours as earlier installs wrote it: synchronous."""
        return {"hooks": [{"type": "command", "command": self.command(endpoint, **kw), "timeout": 2}]}


class TargetedDisconnectTest(InstallerCase):
    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_selected_uninstall_and_preview_leave_other_tool_untouched(self):
        self.run_tool()
        original = self.settings.read_bytes()
        installed = self.hooks_json.read_bytes()
        self.assertEqual(self.run_tool("--uninstall", "--target", "codex", "--dry-run")[0], 0)
        self.assertEqual(self.hooks_json.read_bytes(), installed)
        self.assertEqual(self.run_tool("--uninstall", "--target", "codex")[0], 0)
        self.assertFalse(self.hooks_json.exists())
        self.assertEqual(self.settings.read_bytes(), original)

    def test_selected_install_does_not_create_other_tool_config(self):
        self.assertEqual(self.run_tool("--target", "claude")[0], 0)
        self.assertTrue(self.settings.exists())
        self.assertFalse(self.hooks_json.exists())

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_disconnect_preserves_symlink_and_is_idempotent(self):
        real = self.root / "dotfiles-settings.json"
        self.write_json(real, USER_SETTINGS)
        self.settings.symlink_to(real)
        self.run_tool()
        result = install_hooks.disconnect(self.settings, URL)
        self.assertGreater(result["removed"], 0)
        self.assertTrue(self.settings.is_symlink())
        self.assertEqual(json.loads(real.read_text(encoding="utf-8")), USER_SETTINGS)
        self.assertEqual(sorted(self.root.iterdir()), sorted([real, self.settings.parent, self.codex]))
        self.assertEqual(install_hooks.disconnect(self.settings, URL), {"removed": 0})


class ClaudeInstallTest(InstallerCase):
    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_install_appends_ours_and_keeps_everything_else(self):
        original = self.write_json(self.settings, USER_SETTINGS)
        self.assertEqual(self.run_tool()[0], 0)
        after = json.loads(self.settings.read_text(encoding="utf-8"))
        self.assertEqual({k: v for k, v in after.items() if k != "hooks"},
                         {k: v for k, v in USER_SETTINGS.items() if k != "hooks"})
        self.assertEqual(list(after), list(USER_SETTINGS))
        self.assertEqual(list(after["hooks"])[:len(USER_SETTINGS["hooks"])], list(USER_SETTINGS["hooks"]))
        for event, groups in after["hooks"].items():
            mine = USER_SETTINGS["hooks"].get(event, [])
            self.assertEqual(groups, mine + [self.group("/hook/claude", event)] if event in CLAUDE_EVENTS else mine,
                             event)
        self.assertEqual(set(after["hooks"]), set(CLAUDE_EVENTS) | set(USER_SETTINGS["hooks"]))
        self.assertTrue(self.settings.read_text(encoding="utf-8").endswith("}\n"))
        self.assertEqual(self.settings.stat().st_mode & 0o777, 0o644)
        self.assertNotEqual(self.settings.read_bytes(), original)
        self.assertEqual(self.copies(self.settings), [])

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_second_install_changes_nothing(self):
        self.write_json(self.settings, USER_SETTINGS)
        self.run_tool()
        installed, mtime = self.settings.read_bytes(), self.settings.stat().st_mtime_ns
        time.sleep(0.01)
        self.assertEqual(self.run_tool()[0], 0)
        self.assertEqual(self.settings.read_bytes(), installed)
        self.assertEqual(self.settings.stat().st_mtime_ns, mtime)

    def test_an_older_group_of_ours_is_replaced_in_place(self):
        user = {"hooks": [{"type": "command", "command": USER_COMMANDS["guard"]}]}
        for old in (self.legacy_group("/hook/claude", forwarder="/old/checkout/codex_hook_forward.py"), self.group("/hook/claude", forwarder="/old/checkout/codex_hook_forward.py")):
            with self.subTest(old=old):
                self.write_json(self.settings, {"hooks": {"PreToolUse": [user, old, user]}})
                self.run_tool()
                self.assertEqual(json.loads(self.settings.read_text(encoding="utf-8"))["hooks"]["PreToolUse"],
                                 [user, self.group("/hook/claude"), user])

    def test_ours_on_events_no_longer_installed_are_removed(self):
        user = {"hooks": [{"type": "command", "command": USER_COMMANDS["guard"]}]}
        dropped = ("SessionStart", "SubagentStart", "PermissionDenied", "Elicitation", "ElicitationResult")
        self.write_json(self.settings, {"hooks": {"SessionStart": [user, self.legacy_group("/hook/claude")],
                                                  **{e: [self.legacy_group("/hook/claude")] for e in dropped[1:]}}})
        self.run_tool()
        hooks = json.loads(self.settings.read_text(encoding="utf-8"))["hooks"]
        self.assertEqual(hooks["SessionStart"], [user])
        self.assertEqual(set(hooks), {"SessionStart", *CLAUDE_EVENTS})
        self.assertEqual(self.run_tool("--uninstall")[0], 0)
        self.assertEqual(json.loads(self.settings.read_text(encoding="utf-8")), {"hooks": {"SessionStart": [user]}})

    def test_installed_event_sets(self):
        self.assertEqual(CLAUDE_EVENTS, ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
                                         "PermissionRequest", "Notification", "SubagentStop", "Stop", "StopFailure",
                                         "PreCompact", "PostCompact", "SessionEnd"])
        self.assertEqual(CODEX_EVENTS, ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest",
                                        "SubagentStop", "Stop", "Interrupt", "SessionEnd", "PreCompact", "PostCompact"])

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_uninstall_restores_the_original(self):
        self.write_json(self.settings, USER_SETTINGS)
        self.run_tool()
        self.assertEqual(self.run_tool("--uninstall")[0], 0)
        self.assertEqual(self.settings.read_text(encoding="utf-8"), json.dumps(USER_SETTINGS, indent=2) + "\n")
        restored, mtime = self.settings.read_bytes(), self.settings.stat().st_mtime_ns
        self.assertEqual(self.run_tool("--uninstall")[0], 0)
        self.assertEqual((self.settings.read_bytes(), self.settings.stat().st_mtime_ns), (restored, mtime))
        self.assertEqual(self.copies(self.settings), [])

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_uninstall_drops_lists_and_hooks_that_become_empty(self):
        self.write_json(self.settings, {"model": "opus"})
        self.run_tool()
        self.run_tool("--uninstall")
        self.assertEqual(self.settings.read_text(encoding="utf-8"), json.dumps({"model": "opus"}, indent=2) + "\n")

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_missing_settings_file_is_created_private_with_only_hooks(self):
        self.assertEqual(self.run_tool()[0], 0)
        data = json.loads(self.settings.read_text(encoding="utf-8"))
        self.assertEqual(list(data), ["hooks"])
        self.assertEqual(list(data["hooks"]), CLAUDE_EVENTS)
        self.assertEqual(self.settings.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.copies(self.settings), [])

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_dry_run_writes_nothing_and_shows_only_ours(self):
        original = self.write_json(self.settings, USER_SETTINGS)
        mtime = self.settings.stat().st_mtime_ns
        code, out, _ = self.run_tool("--dry-run")
        self.assertEqual(code, 0)
        self.assertEqual((self.settings.read_bytes(), self.settings.stat().st_mtime_ns), (original, mtime))
        self.assertEqual(self.copies(self.settings), [])
        self.assertFalse(self.hooks_json.exists())
        for text in (*USER_COMMANDS.values(), SECRET, "127.0.0.1:9999", "status.sh", "opus", "Bash(ls)"):
            self.assertNotIn(text, out)
        lines = out.splitlines()
        for event in CLAUDE_EVENTS:
            self.assertIn(f"+ {event}", lines)
        for event in CODEX_EVENTS:
            self.assertIn(f"+ {event}", lines)
        self.assertIn(str(self.forwarder), out)
        self.assertIn(json.dumps(self.command("/hook/codex")), out)
        self.assertTrue(any(line.startswith("+++ ") and line.endswith(str(self.settings)) for line in lines))

    def test_dry_run_of_an_installed_file_lists_no_event(self):
        self.write_json(self.settings, USER_SETTINGS)
        self.run_tool()
        out = self.run_tool("--dry-run")[1]
        self.assertFalse([line for line in out.splitlines() if line.startswith(("+ ", "- "))])

    def test_unparsable_file_stops_everything(self):
        self.settings.write_text('{"hooks": {,}\n', encoding="utf-8")
        mtime = self.settings.stat().st_mtime_ns
        code, out, err = self.run_tool()
        self.assertEqual(code, 2)
        self.assertEqual(self.settings.read_text(encoding="utf-8"), '{"hooks": {,}\n')
        self.assertEqual(self.settings.stat().st_mtime_ns, mtime)
        self.assertFalse(self.hooks_json.exists())
        self.assertIn(str(self.settings), err)

    def test_unusable_shapes_stop_everything(self):
        for data in ([], {"hooks": []}, {"hooks": {"Stop": {"hooks": []}}}):
            with self.subTest(data=data):
                original = self.write_json(self.settings, data)
                self.assertEqual(self.run_tool()[0], 2)
                self.assertEqual(self.settings.read_bytes(), original)

    def test_a_symlinked_settings_file_stays_a_link(self):
        real = self.root / "dotfiles" / "claude-settings.json"
        real.parent.mkdir()
        self.write_json(real, USER_SETTINGS)
        self.settings.symlink_to(real)
        self.run_tool()
        self.assertTrue(self.settings.is_symlink())
        self.assertIn("SessionEnd", json.loads(real.read_text(encoding="utf-8"))["hooks"])

    def test_forwarder_must_be_the_forwarder(self):
        self.assertEqual(self.run_tool(forwarder=self.root / "other.py")[0], 2)
        self.assertFalse(self.settings.exists())

    @unittest.skipIf(sys.platform == "win32", "runs the commands with /bin/sh")
    def test_hook_commands_run_with_spaces_and_non_ascii_in_their_paths(self):
        """Both command lines, run by sh, post to agentd with the token, the observe header and the start time."""
        seen = []

        class Recorder(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                seen.append((self.path, self.headers["Authorization"], self.headers.get("X-Agentd-Observe"),
                             body["session_id"], type(body["agentd_started_at"])))
                self.send_response(200)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Recorder)
        serve_in_thread(server)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        url = f"http://127.0.0.1:{server.server_port}"
        self.forwarder = self.root / "Agentic Complex 角色" / "codex_hook_forward.py"
        self.forwarder.parent.mkdir()
        shutil.copy(AGENTD / "codex_hook_forward.py", self.forwarder)
        self.token.parent.mkdir()
        self.token.write_text("tok-123\n", encoding="utf-8")
        self.python = sys.executable
        self.assertEqual(self.run_tool(url=url)[0], 0)
        [claude] = json.loads(self.settings.read_text(encoding="utf-8"))["hooks"]["Stop"][0]["hooks"]
        [codex] = json.loads(self.hooks_json.read_text(encoding="utf-8"))["hooks"]["Stop"][0]["hooks"]
        for command in (claude["command"], codex["command"]):
            words = shlex.split(command)
            self.assertEqual(words[:2], [sys.executable, str(self.forwarder)])
            self.assertEqual(words[words.index("--token-file") + 1], str(self.token))
            done = subprocess.run(["/bin/sh", "-c", command], input=b'{"session_id": "S"}', capture_output=True, timeout=10)
            self.assertEqual((done.returncode, done.stdout, done.stderr), (0, b"", b""))
        self.assertEqual(seen, [("/hook/claude", "Bearer tok-123", "1", "S", float),
                                ("/hook/codex", "Bearer tok-123", "1", "S", float)])


class ClaudeConfigDirTest(unittest.TestCase):
    def test_default_claude_settings_follow_claude_config_dir(self):
        with tempfile.TemporaryDirectory() as directory:
            run = subprocess.run([sys.executable, "-I", str(AGENTD / "tools/install_hooks.py"), "--target", "claude",
                                  "--dry-run"], env={**os.environ, "CLAUDE_CONFIG_DIR": directory},
                                 capture_output=True, text=True, encoding="utf-8", timeout=30)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertIn(str(Path(os.path.realpath(directory)) / "settings.json"), run.stdout)


class HookScriptTest(InstallerCase):
    def setUp(self):
        super().setUp()
        self.script = self.root / "App Support" / "bin" / ("agentic-complex-hook.cmd" if self.windows
                                                            else "agentic-complex-hook")

    def script_command(self, endpoint):
        return self.words([str(self.script)], endpoint)

    def test_hook_script_replaces_python_and_forwarder(self):
        self.assertEqual(self.run_tool("--hook-script", str(self.script))[0], 0)
        hooks = json.loads(self.settings.read_text(encoding="utf-8"))["hooks"]
        self.assertEqual(hooks["Stop"], [self.group("/hook/claude", program=[str(self.script)])])
        self.assertEqual(json.loads(self.hooks_json.read_text(encoding="utf-8"))["hooks"]["Stop"],
                         [self.group("/hook/codex", program=[str(self.script)])])

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_both_commands_are_ours(self):
        script = [str(self.script)]
        for group in (self.legacy_group("/hook/claude"), self.legacy_group("/hook/claude", program=script),
                      self.group("/hook/claude"), self.group("/hook/claude", program=script)):
            with self.subTest(group=group):
                self.assertTrue(install_hooks.is_ours(group, URL))
        for program in ([str(self.script).replace("agentic-complex-hook", "my-hook")], ["/usr/bin/python3", "x.py"]):
            for group in (self.legacy_group("/hook/claude", program=program),
                          self.group("/hook/claude", program=program)):
                self.assertFalse(install_hooks.is_ours(group, URL))
        self.assertFalse(install_hooks.is_ours(self.group("/hook/claude", url="http://127.0.0.1:1"), URL))

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_install_with_hook_script_replaces_the_forwarder_command(self):
        self.write_json(self.settings, USER_SETTINGS)
        self.run_tool()
        self.run_tool("--hook-script", str(self.script))
        after = json.loads(self.settings.read_text(encoding="utf-8"))
        for event, groups in after["hooks"].items():
            mine = USER_SETTINGS["hooks"].get(event, [])
            ours = self.group("/hook/claude", event, program=[str(self.script)])
            self.assertEqual(groups, mine + [ours] if event in CLAUDE_EVENTS else mine, event)

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_uninstall_removes_both_commands(self):
        self.write_json(self.settings, USER_SETTINGS)
        self.run_tool()
        self.run_tool("--hook-script", str(self.script), "--target", "codex")
        hooks = json.loads(self.settings.read_text(encoding="utf-8"))["hooks"]
        hooks["Stop"].append({"hooks": [{"type": "command", "command": self.script_command("/hook/claude")}]})
        self.write_json(self.settings, {**json.loads(self.settings.read_text(encoding="utf-8")), "hooks": hooks})
        self.assertEqual(self.run_tool("--uninstall")[0], 0)
        self.assertEqual(json.loads(self.settings.read_text(encoding="utf-8")), USER_SETTINGS)
        self.assertFalse(self.hooks_json.exists())

    def test_hook_script_must_be_named_endfield_hook(self):
        code, _, err = self.run_tool("--hook-script", str(self.root / "bin" / "hook"))
        self.assertEqual(code, 2)
        self.assertIn("--hook-script must be", err)
        self.assertFalse(self.settings.exists())
        self.assertFalse(self.hooks_json.exists())


class CodexInstallTest(InstallerCase):
    def setUp(self):
        super().setUp()
        self.config = self.codex / "config.toml"
        self.config.write_text('model = "gpt-5"\n[hooks]\n', encoding="utf-8")
        self.config_state = (self.config.read_bytes(), self.config.stat().st_mtime_ns)

    def tearDown(self):
        self.assertEqual((self.config.read_bytes(), self.config.stat().st_mtime_ns), self.config_state)

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_missing_hooks_json_is_created_and_removed_again(self):
        code, out, _ = self.run_tool()
        self.assertEqual(code, 0)
        data = json.loads(self.hooks_json.read_text(encoding="utf-8"))
        self.assertEqual(data, {"hooks": {event: [self.group("/hook/codex")] for event in CODEX_EVENTS}})
        self.assertEqual(self.hooks_json.stat().st_mode & 0o777, 0o600)
        self.assertIn("/hooks", out)
        self.assertIn("Review hooks", out)
        self.assertEqual(self.run_tool("--uninstall")[0], 0)
        self.assertFalse(self.hooks_json.exists())
        self.assertEqual(self.copies(self.hooks_json), [])

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_existing_hooks_json_is_merged_and_restored(self):
        self.write_json(self.hooks_json, USER_CODEX_HOOKS, mode=0o600)
        self.run_tool()
        after = json.loads(self.hooks_json.read_text(encoding="utf-8"))
        for event in CODEX_EVENTS:
            self.assertEqual(after["hooks"][event],
                             USER_CODEX_HOOKS["hooks"].get(event, []) + [self.group("/hook/codex")])
        installed = self.hooks_json.read_bytes()
        self.run_tool()
        self.assertEqual(self.hooks_json.read_bytes(), installed)
        self.assertEqual(self.copies(self.hooks_json), [])
        self.run_tool("--uninstall")
        self.assertEqual(self.hooks_json.read_text(encoding="utf-8"), json.dumps(USER_CODEX_HOOKS, indent=2) + "\n")

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_dry_run_prints_our_codex_groups_only(self):
        self.write_json(self.hooks_json, USER_CODEX_HOOKS)
        before = self.hooks_json.read_bytes()
        code, out, _ = self.run_tool("--dry-run")
        self.assertEqual(code, 0)
        self.assertEqual(self.hooks_json.read_bytes(), before)
        self.assertIn(json.dumps(self.command("/hook/codex")), out)
        self.assertNotIn(USER_COMMANDS["guard"], out)
        self.assertNotIn(USER_COMMANDS["say"], out)
        self.assertNotIn("Review hooks", out)

    def test_unparsable_hooks_json_leaves_claude_alone(self):
        self.hooks_json.write_text("{", encoding="utf-8")
        self.assertEqual(self.run_tool()[0], 2)
        self.assertFalse(self.settings.exists())
        self.assertEqual(self.hooks_json.read_text(encoding="utf-8"), "{")

    def test_missing_codex_home_is_skipped(self):
        self.codex = self.root / "no-codex"
        code, out, _ = self.run_tool()
        self.assertEqual(code, 0)
        self.assertFalse(self.codex.exists())
        self.assertIn("SessionEnd", json.loads(self.settings.read_text(encoding="utf-8"))["hooks"])
        self.assertNotIn("Review hooks", out)


class WindowsFormTest(InstallerCase):
    """What install_hooks writes and recognises on Windows, on any platform."""
    windows = True

    def setUp(self):
        super().setUp()
        self.script = self.root / "Agentic Complex" / "bin" / "agentic-complex-hook.cmd"

    def written(self):
        return (json.loads(self.settings.read_text(encoding="utf-8"))["hooks"],
                json.loads(self.hooks_json.read_text(encoding="utf-8"))["hooks"])

    def test_claude_runs_the_cmd_in_powershell_and_codex_in_cmd(self):
        self.assertEqual(self.run_tool("--hook-script", str(self.script))[0], 0)
        s, t = str(self.script), str(self.token)
        claude, codex = self.written()
        for event in CLAUDE_EVENTS:
            matcher = {"matcher": NOTIFICATION_MATCHER} if event == "Notification" else {}
            self.assertEqual(claude[event], [{**matcher, "hooks": [{
                "type": "command", "shell": "powershell", "async": True, "onFailure": "continue", "timeout": 2,
                "command": f"& '{s}' --endpoint /hook/claude --observe --timeout 0.8 --url '{URL}' --token-file '{t}'"}]}])
        for event in CODEX_EVENTS:
            self.assertEqual(codex[event], [{"hooks": [{
                "type": "command", "async": True, "timeout": 2,
                "command": f'"{s}" --endpoint /hook/codex --observe --timeout 0.8 --url "{URL}" --token-file "{t}"'}]}])

    def test_the_hook_script_is_the_cmd_in_any_case(self):
        code, _, err = self.run_tool("--hook-script", str(self.root / "bin" / "agentic-complex-hook"))
        self.assertEqual(code, 2)
        self.assertIn("--hook-script must be an agentic-complex-hook.cmd", err)
        self.assertFalse(self.settings.exists())
        self.assertEqual(self.run_tool("--hook-script", str(self.root / "BIN" / "Agentic-Complex-Hook.CMD"))[0], 0)

    def test_ours_is_recognised_with_either_separator_and_in_any_case(self):
        ours = [r'"C:\Users\X\AppData\Roaming\Agentic Complex\bin\agentic-complex-hook.cmd" --endpoint /hook/codex'
                rf' --observe --timeout 0.8 --url "{URL}" --token-file "C:\L\Agentic Complex\agentd\hook.token"',
                "& 'C:/Users/X/AppData/Roaming/Agentic Complex/BIN/Agentic-Complex-Hook.CMD' --endpoint /hook/claude"
                rf" --observe --timeout 0.8 --url '{URL}' --token-file 'C:\t\hook.token'",
                rf'"C:\Python 3\python.exe" "D:\Agent D\Codex_Hook_Forward.py" --endpoint /hook/codex --observe --url {URL}']
        others = [ours[0].replace("agentic-complex-hook.cmd", "my-hook.cmd"), ours[1].replace(" --observe", ""),
                  ours[2].replace(URL, "http://127.0.0.1:48899"), r'cmd /c "C:\bin\agentic-complex-hook.cmd" --observe --url ' + URL]
        for command, expected in [*((c, True) for c in ours), *((c, False) for c in others)]:
            with self.subTest(command=command):
                self.assertEqual(install_hooks.is_ours({"hooks": [{"type": "command", "command": command}]}, URL), expected)
        install_hooks.WINDOWS = False
        for command in ours[:2]:
            self.assertFalse(install_hooks.is_ours({"hooks": [{"type": "command", "command": command}]}, URL), command)

    def test_a_quote_in_the_path_is_doubled_for_powershell_and_the_entry_stays_ours(self):
        self.script = self.root / "O'Brien\u2019s Agentic Complex" / "bin" / "agentic-complex-hook.cmd"
        self.write_json(self.settings, USER_SETTINGS)
        self.run_tool("--hook-script", str(self.script))
        claude, _ = self.written()
        self.assertIn("O''Brien\u2019\u2019s Agentic Complex", claude["Stop"][-1]["hooks"][0]["command"])
        installed = self.settings.read_bytes(), self.hooks_json.read_bytes()
        self.assertEqual(self.run_tool("--hook-script", str(self.script))[0], 0)
        self.assertEqual((self.settings.read_bytes(), self.hooks_json.read_bytes()), installed)
        self.assertEqual(self.run_tool("--uninstall")[0], 0)
        self.assertEqual(json.loads(self.settings.read_text(encoding="utf-8")), USER_SETTINGS)
        self.assertFalse(self.hooks_json.exists())

    def test_the_token_file_defaults_to_the_shells_agentd_state_dir(self):
        local = self.root / "Local"
        argv = ["--claude-settings", str(self.settings), "--codex-home", str(self.codex), "--url", URL,
                "--hook-script", str(self.script), "--target", "codex"]
        with mock.patch.dict(os.environ, {"LOCALAPPDATA": str(local)}), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(install_hooks.main(argv), 0)
        token = os.path.join(str(local), "Agentic Complex", "agentd", "hook.token")
        command = json.loads(self.hooks_json.read_text(encoding="utf-8"))["hooks"]["Stop"][0]["hooks"][0]["command"]
        self.assertTrue(command.endswith(f' --token-file "{token}"'), command)


class MacFormTest(InstallerCase):
    """The macOS forms, on any platform."""
    windows = False

    def test_the_cmd_is_not_the_mac_hook_script(self):
        code, _, err = self.run_tool("--hook-script", str(self.root / "bin" / "agentic-complex-hook.cmd"))
        self.assertEqual(code, 2)
        self.assertIn("--hook-script must be an agentic-complex-hook;", err)


class DefaultLocationTest(unittest.TestCase):
    def test_settings_default_to_the_user_files_each_cli_reads(self):
        """~/.claude/settings.json and ~/.codex/hooks.json, where ~ is %USERPROFILE% on Windows."""
        with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, {"HOME": home, "USERPROFILE": home}):
            self.assertEqual(os.path.expanduser("~"), home)
            for name in (".claude", ".codex"):
                os.mkdir(os.path.join(home, name))
            script = os.path.join(home, "bin", "agentic-complex-hook.cmd" if sys.platform == "win32" else "agentic-complex-hook")
            with contextlib.redirect_stdout(io.StringIO()):
                code = install_hooks.main(["--url", URL, "--token-file", os.path.join(home, "hook.token"),
                                           "--hook-script", script])
            self.assertEqual(code, 0)
            for path in (Path(home, ".claude", "settings.json"), Path(home, ".codex", "hooks.json")):
                self.assertIn("Stop", json.loads(path.read_text(encoding="utf-8"))["hooks"], path)


@unittest.skipUnless(sys.platform == "win32", "runs cmd.exe and PowerShell the way Codex and Claude Code run a hook")
class WindowsHookRunTest(InstallerCase):
    def test_both_commands_post_to_agentd_from_a_support_dir_with_a_space_and_non_ascii(self):
        seen = []

        class Recorder(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                seen.append((self.path, self.headers["Authorization"], self.headers.get("X-Agentd-Observe"),
                             body["session_id"]))
                self.send_response(200)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Recorder)
        serve_in_thread(server)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        support = self.root / "Agentic Complex 测试"
        forwarder = support / "agentd" / "codex_hook_forward.py"
        forwarder.parent.mkdir(parents=True)
        shutil.copy(AGENTD / "codex_hook_forward.py", forwarder)
        script = support / "bin" / "agentic-complex-hook.cmd"
        script.parent.mkdir()
        # The .cmd app/electron/src/common/onboarding.ts hookScript writes for a path that is not ASCII.
        line = f'"{sys.executable.replace("%", "%%")}" -I -B "{str(forwarder).replace("%", "%%")}" %*'
        script.write_bytes(f"@echo off\r\nchcp 65001 >nul\r\n{line}\r\n".encode("utf-8"))
        self.token = support / "agentd-state" / "hook.token"
        self.token.parent.mkdir()
        self.token.write_text("tok-123\n", encoding="utf-8")
        self.assertEqual(self.run_tool("--hook-script", str(script), url=f"http://127.0.0.1:{server.server_port}")[0], 0)
        [claude] = json.loads(self.settings.read_text(encoding="utf-8"))["hooks"]["Stop"][0]["hooks"]
        [codex] = json.loads(self.hooks_json.read_text(encoding="utf-8"))["hooks"]["Stop"][0]["hooks"]
        self.assertEqual(claude["shell"], "powershell")
        # Codex: %COMSPEC% /C "<command>" (codex-rs/hooks/src/engine/command_runner.rs build_command).
        runs = [("cmd", "/hook/codex", f'{os.environ.get("COMSPEC", "cmd.exe")} /C "{codex["command"]}"')]
        # Claude Code with "shell": "powershell": pwsh.exe when present, else powershell.exe.
        for name in ("pwsh", "powershell"):
            if shutil.which(name):
                runs.append((name, "/hook/claude", [shutil.which(name), "-NoProfile", "-NonInteractive", "-Command",
                                                    claude["command"]]))
        self.assertIn("powershell", [name for name, *_ in runs])
        for name, endpoint, argv in runs:
            with self.subTest(shell=name):
                seen.clear()
                started = time.monotonic()
                done = subprocess.run(argv, input=b'{"session_id": "S"}', capture_output=True, timeout=30, cwd=support,
                                      creationflags=subprocess.CREATE_NO_WINDOW)
                print(f"hook run {name}: exit={done.returncode} {time.monotonic() - started:.2f}s posts={len(seen)}",
                      file=sys.stderr)
                self.assertEqual((done.returncode, done.stdout, done.stderr), (0, b"", b""))
                self.assertEqual(seen, [(endpoint, "Bearer tok-123", "1", "S")])


if __name__ == "__main__":
    unittest.main()
