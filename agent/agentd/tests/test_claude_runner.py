"""claude_runner.py driven over C8 frames against the scripted fake Claude Code CLI."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import unittest

AGENTD = Path(__file__).resolve().parents[1]
RUNNER = AGENTD / "character_agent/harness/claude_runner.py"
BRIDGE = AGENTD / "character_agent/harness/tool_bridge.py"
FAKE = Path(__file__).resolve().parent / "fixtures/fake_claude_cli.py"

_spec = importlib.util.spec_from_file_location(
    "c8_validate", Path(__file__).resolve().parents[3] / "protocol/C8-harness-runner/validate.py")
c8 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(c8)

TOOLS = [{"name": "fixture_read", "description": "Read a fixture",
          "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}}}]
SYSTEM_PROMPT = "-Synthetic personal assistant."
REMINDER = "Stay in character when you speak to the user between tool calls."


def fake_cli(directory, script="normal", **env):
    """An executable `claude` in `directory` that runs the fake with its script; the runner passes no test env on."""
    log = os.path.join(directory, "cli.jsonl")
    exports = "".join(f"export {k}='{v}'\n" for k, v in
                      {"FAKE_CLAUDE_SCRIPT": script, "FAKE_CLAUDE_LOG": log, **env}.items())
    path = Path(directory) / "claude"
    path.write_text(f"#!/bin/sh\n{exports}exec {sys.executable} -I -B {FAKE} \"$@\"\n", encoding="utf-8")
    path.chmod(0o755)
    return str(path), log


def cli_log(log, event):
    with open(log, encoding="utf-8") as f:
        return [r for r in map(json.loads, f) if r["event"] == event]


class RunnerProcess:
    """One claude_runner process; every frame in both directions is kept in order in `lines`."""

    def __init__(self, test, script="normal", model="", extra_tools="", **config):
        self.dir = tempfile.TemporaryDirectory()
        test.addCleanup(self.dir.cleanup)
        cli, self.log = fake_cli(self.dir.name, script, FAKE_CLAUDE_EXTRA_TOOLS=extra_tools)
        self.lines, self.frames = [], queue.Queue()
        self.proc = subprocess.Popen([sys.executable, "-I", "-B", str(RUNNER)], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
        test.addCleanup(self.stop)
        threading.Thread(target=self.read, daemon=True).start()
        self.config = {"cli_path": cli, "state_dir": os.path.join(self.dir.name, "state"), "model": model,
                       "tool_timeout": 10, "max_turns": 8, **config}
        self.send({"type": "init", "config": self.config, "system_prompt": SYSTEM_PROMPT, "tools": TOOLS})

    def read(self):
        for raw in self.proc.stdout:
            line = raw.decode()
            self.lines.append(line)
            self.frames.put(json.loads(line))
        self.frames.put(None)

    def send(self, frame):
        line = json.dumps({"v": 1, **frame}) + "\n"
        self.lines.append(line)
        self.proc.stdin.write(line.encode())
        self.proc.stdin.flush()

    def next(self, kind, timeout=20):
        seen = []
        while True:
            frame = self.frames.get(timeout=timeout)
            if frame is None:
                raise AssertionError(f"runner exited before {kind}; saw {seen}")
            seen.append(frame)
            if frame["type"] == kind:
                return frame, seen

    def query(self, run_id, prompt="Read my notes"):
        self.send({"type": "query", "run_id": run_id, "prompt": prompt, "history": None})

    def close(self):
        self.send({"type": "close"})
        return self.proc.wait(10)

    def stop(self):
        if self.proc.poll() is None:
            try:
                self.close()
            except (OSError, subprocess.TimeoutExpired):
                self.proc.kill()
                self.proc.wait()
        for stream in (self.proc.stdin, self.proc.stdout):
            try:
                stream.close()
            except OSError:
                pass


class ClaudeRunnerTest(unittest.TestCase):
    def test_cli_argv_starts_the_cli_itself_without_a_turn_limit(self):
        sys.path.insert(0, str(AGENTD))
        from character_agent.harness.claude_runner import cli_argv
        argv = cli_argv("/fixture/claude", {"max_turns": 8}, SYSTEM_PROMPT, {"mcpServers": {}}, {"fixture_read"})
        self.assertEqual(argv[0], "/fixture/claude")
        self.assertNotIn("sandbox-exec", " ".join(argv))
        self.assertNotIn("--max-turns", argv)

    def test_cli_argv_for_background_tasks_keeps_only_endfield_tools(self):
        sys.path.insert(0, str(AGENTD))
        from character_agent.harness.claude_runner import cli_argv
        argv = cli_argv("/fixture/claude", {"native_tools": False}, SYSTEM_PROMPT, {"mcpServers": {}}, {"fixture_read"})
        self.assertEqual(argv, ["/fixture/claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json",
            "--verbose", "--include-partial-messages", "--tools", "", "--mcp-config", '{"mcpServers": {}}',
            "--strict-mcp-config", "--permission-mode", "dontAsk", "--permission-prompts", "none", "--setting-sources", "",
            "--no-session-persistence", "--no-chrome", "--disable-slash-commands",
            "--allowedTools", "mcp__agentic_complex__fixture_read", "--system-prompt=" + SYSTEM_PROMPT])

    def test_cli_argv_with_native_tools_loads_the_users_config_and_asks_endfield(self):
        sys.path.insert(0, str(AGENTD))
        from character_agent.harness.claude_runner import PERMISSION_TOOL, cli_argv
        argv = cli_argv("/fixture/claude", {"native_tools": True}, SYSTEM_PROMPT, {"mcpServers": {}}, {"fixture_read"})
        for flag in ("--tools", "--strict-mcp-config", "--setting-sources", "--allowedTools", "--disable-slash-commands",
                     "--permission-mode", "--permission-prompts", "--system-prompt=" + SYSTEM_PROMPT):
            self.assertNotIn(flag, argv)
        self.assertEqual(argv[argv.index("--permission-prompt-tool") + 1], "mcp__agentic_complex__" + PERMISSION_TOOL)
        self.assertEqual(argv[argv.index("--mcp-config") + 1], '{"mcpServers": {}}')
        self.assertIn("--append-system-prompt=" + SYSTEM_PROMPT, argv)

    @unittest.skipIf(sys.platform == "win32", "the fake Claude CLI is a /bin/sh script")
    def test_turn_streams_text_calls_an_endfield_tool_and_validates_as_c8(self):
        runner = RunnerProcess(self)
        ready, _ = runner.next("ready")
        self.assertEqual(ready["capabilities"], {"cancel": "native", "tool_injection": "mcp_stdio",
            "builtin_tools": "unverified", "system_prompt": "native", "usage": "usd", "event_scope": "session",
            "native_questions": False})
        self.assertEqual((ready["tool_names"], ready["tool_inventory_verified"]), (["fixture_read"], True))
        self.assertEqual((ready["protocol"], ready["cli_version"]), ("claude-stream-json", "2.1.327-fake"))
        argv = cli_log(runner.log, "argv")[0]["argv"]
        mcp = json.loads(argv[argv.index("--mcp-config") + 1])["mcpServers"]["agentic_complex"]
        self.assertEqual((mcp["command"], mcp["args"][:5]), (sys.executable, ["-I", "-B", "-X", "utf8", str(BRIDGE)]))
        for flag, value in (("--tools", ""), ("--setting-sources", ""), ("--allowedTools", "mcp__agentic_complex__fixture_read"),
                            ("--permission-mode", "dontAsk"), ("--permission-prompts", "none"),
                            ("--input-format", "stream-json"), ("--output-format", "stream-json")):
            self.assertEqual(argv[argv.index(flag) + 1], value, flag)
        for flag in ("-p", "--strict-mcp-config", "--include-partial-messages", "--verbose", "--no-session-persistence",
                     "--system-prompt=" + SYSTEM_PROMPT):
            self.assertIn(flag, argv)
        self.assertFalse([a for a in argv if a.startswith(("--model", "--effort"))])

        runner.query("run-1")
        request, before = runner.next("tool_request")
        self.assertEqual((request["run_id"], request["name"], request["args"]), ("run-1", "fixture_read", {"path": "notes.txt"}))
        # The tool_use id names the call, so the transport's tool events line up with the model's own block.
        self.assertEqual((request["tool_call_id"], request["item_id"], request["kind"]), ("toolu_1", "toolu_1", "tool_call"))
        self.assertEqual([(f["text"], f["item_id"], f["phase"]) for f in before if f["type"] == "text_delta"],
                         [("Hello ", "msg_1", "final")])
        runner.send({"type": "tool_result", "tool_call_id": "toolu_1", "run_id": "run-1",
                     "result": {"text": "fixture"}, "is_error": False})
        result, after = runner.next("result")
        frames = before + after
        self.assertEqual([(f["item_id"], f["status"]) for f in frames if f["type"] == "item"],
                         [("msg_1", "started"), ("msg_1", "completed"), ("msg_2", "started"), ("msg_2", "completed")])
        self.assertEqual({f["kind"] for f in frames if f["type"] in ("item", "text_delta")}, {"assistant_text"})
        self.assertEqual(json.loads(cli_log(runner.log, "tool_result")[0]["reply"]["result"]["content"][0]["text"]),
                         {"text": "fixture"})
        self.assertEqual((result["success"], result["subtype"], result["final_text"], result["model"]),
                         (True, "success", "Hello world", "claude-fake-1"))
        self.assertEqual(result["usage"], {"input_tokens": 12, "output_tokens": 8, "cache_read_input_tokens": 7,
                                           "cache_creation_input_tokens": 3})
        self.assertAlmostEqual(result["cost_usd"], 0.002)
        self.assertEqual(result["session_id"], "11111111-2222-3333-4444-555555555555")
        prompt = [r["message"] for r in cli_log(runner.log, "stdin") if r["message"]["type"] == "user"]
        self.assertEqual(prompt[0]["message"], {"role": "user", "content": "Read my notes"})

        # total_cost_usd counts the whole CLI session; each result carries its own turn's share.
        runner.query("run-2")
        request, _ = runner.next("tool_request")
        runner.send({"type": "tool_result", "tool_call_id": request["tool_call_id"], "run_id": "run-2",
                     "result": {"text": "fixture"}, "is_error": False})
        second, _ = runner.next("result")
        self.assertAlmostEqual(second["cost_usd"], 0.002)
        self.assertEqual(runner.close(), 0)
        self.assertIsNone(c8.check(runner.lines))

    @unittest.skipIf(sys.platform == "win32", "the fake Claude CLI is a /bin/sh script")
    def test_ready_carries_the_model_from_init(self):
        runner = RunnerProcess(self)
        ready, _ = runner.next("ready")
        self.assertEqual(ready["model"], "claude-fake-1")
        self.assertNotIn("effort_applied", ready)

    @unittest.skipIf(sys.platform == "win32", "the fake Claude CLI is a /bin/sh script")
    def test_configured_model_and_effort_reach_the_cli(self):
        runner = RunnerProcess(self, model="sonnet", effort="low")
        ready, _ = runner.next("ready")
        argv = cli_log(runner.log, "argv")[0]["argv"]
        self.assertIn("--model=sonnet", argv)
        self.assertEqual(argv[argv.index("--effort") + 1], "low")
        self.assertEqual((ready["effort"], ready["effort_applied"]), ("low", True))

    @unittest.skipIf(sys.platform == "win32", "the fake Claude CLI is a /bin/sh script")
    def test_auth_and_rate_limit_failures_are_classified(self):
        for script, code, retryable in (("auth", "auth_expired", False), ("rate", "rate_limited", True)):
            with self.subTest(script=script):
                runner = RunnerProcess(self, script)
                runner.next("ready")
                runner.query("run-1")
                result, before = runner.next("result")
                self.assertEqual((result["success"], result["subtype"]), (False, "failed"))
                self.assertEqual((result["failure"]["code"], result["failure"]["retryable"]), (code, retryable))
                # The CLI's error notice is not the character's answer.
                self.assertFalse([f for f in before if f["type"] in ("text_delta", "item")])
                self.assertEqual(result["final_text"], "")
                runner.close()
                self.assertIsNone(c8.check(runner.lines))

    @unittest.skipIf(sys.platform == "win32", "the fake Claude CLI is a /bin/sh script")
    def test_a_builtin_tool_in_init_fails_closed(self):
        runner = RunnerProcess(self, extra_tools="Bash")
        error, seen = runner.next("error")
        self.assertEqual(error["code"], "claude_unexpected_tools")
        self.assertEqual([f["type"] for f in seen], ["error"])
        self.assertEqual(runner.proc.wait(10), 0)

    @unittest.skipIf(sys.platform == "win32", "the fake Claude CLI is a /bin/sh script")
    def test_native_tools_run_in_the_workspace_with_builtin_tools(self):
        workspace = tempfile.TemporaryDirectory()
        self.addCleanup(workspace.cleanup)
        runner = RunnerProcess(self, extra_tools="Bash,Read", native_tools=True, workspace_dir=workspace.name)
        ready, seen = runner.next("ready")
        self.assertEqual([f["type"] for f in seen], ["ready"])
        self.assertEqual((ready["tool_names"], ready["tool_inventory_verified"], ready["native_tools"]),
                         (["fixture_read"], False, True))
        self.assertEqual(ready["capabilities"]["builtin_tools"], "unverified")
        self.assertEqual(cli_log(runner.log, "argv")[0]["cwd"], os.path.realpath(workspace.name))
        self.assertEqual(runner.close(), 0)
        self.assertTrue(os.path.isdir(workspace.name))
        self.assertFalse(os.path.exists(os.path.join(runner.config["state_dir"], "workspace")))
        self.assertIsNone(c8.check(runner.lines))

    @unittest.skipIf(sys.platform == "win32", "the fake Claude CLI is a /bin/sh script")
    def test_a_native_permission_prompt_goes_to_the_approval_card(self):
        for option_id, behavior in (("allow_once", "allow"), ("reject_once", "deny")):
            with self.subTest(option_id=option_id):
                workspace = tempfile.TemporaryDirectory()
                self.addCleanup(workspace.cleanup)
                runner = RunnerProcess(self, "permission", native_tools=True, workspace_dir=workspace.name)
                runner.next("ready")
                runner.query("run-1")
                request, _ = runner.next("permission_request")
                self.assertEqual((request["run_id"], request["title"], request["raw_input"]),
                                 ("run-1", "Bash: ls", {"command": "ls"}))
                self.assertEqual([(o["option_id"], o["kind"]) for o in request["options"]],
                                 [("allow_once", "allow_once"), ("reject_once", "reject_once")])
                runner.send({"type": "permission_result", "run_id": "run-1", "request_id": request["request_id"],
                             "option_id": option_id})
                result, _ = runner.next("result")
                self.assertEqual(result["final_text"], behavior)
                reply = cli_log(runner.log, "permission_reply")[0]["reply"]["result"]
                self.assertNotIn("structuredContent", reply)
                self.assertEqual(json.loads(reply["content"][0]["text"])["behavior"], behavior)
                self.assertEqual(runner.close(), 0)
                self.assertIsNone(c8.check(runner.lines))

    @unittest.skipIf(sys.platform == "win32", "the fake Claude CLI is a /bin/sh script")
    def test_a_tool_reminder_answers_every_post_tool_use_hook(self):
        for native in (False, True):
            with self.subTest(native_tools=native):
                workspace = tempfile.TemporaryDirectory()
                self.addCleanup(workspace.cleanup)
                runner = RunnerProcess(self, "hook", tool_reminder=REMINDER, native_tools=native,
                                       workspace_dir=workspace.name)
                runner.next("ready")
                [init] = [r["message"]["request"] for r in cli_log(runner.log, "stdin")
                          if r["message"]["type"] == "control_request"]
                self.assertEqual(init["subtype"], "initialize")
                [matcher] = init["hooks"]["PostToolUse"]
                self.assertEqual(set(init["hooks"]), {"PostToolUse"})
                self.assertIsNone(matcher["matcher"])
                self.assertEqual(len(matcher["hookCallbackIds"]), 1)
                runner.query("run-1")
                result, _ = runner.next("result")
                self.assertEqual(result["final_text"], REMINDER)
                [reply] = [r["reply"] for r in cli_log(runner.log, "hook_reply")]
                self.assertEqual(reply, {"subtype": "success", "request_id": "cli_1", "response": {"hookSpecificOutput": {
                    "hookEventName": "PostToolUse", "additionalContext": REMINDER}}})
                self.assertEqual(runner.close(), 0)
                self.assertIsNone(c8.check(runner.lines))

    @unittest.skipIf(sys.platform == "win32", "the fake Claude CLI is a /bin/sh script")
    def test_without_a_tool_reminder_no_hook_is_registered_or_answered(self):
        runner = RunnerProcess(self, "hook")
        runner.next("ready")
        [init] = [r["message"]["request"] for r in cli_log(runner.log, "stdin") if r["message"]["type"] == "control_request"]
        self.assertEqual(init, {"subtype": "initialize"})
        runner.query("run-1")
        result, _ = runner.next("result")
        self.assertEqual(result["final_text"], "refused")
        self.assertEqual(cli_log(runner.log, "hook_reply")[0]["reply"]["subtype"], "error")
        self.assertEqual(runner.close(), 0)

    def test_the_tool_reminder_is_validated_and_wired(self):
        sys.path.insert(0, str(AGENTD))
        from character_agent.harness.claude_transport import ClaudeConfig
        root = Path(tempfile.gettempdir()) / "fixture"
        fields = {"state_dir": str(root / "state"), "model": "", "cli_path": str(root / "claude"),
                  "workspace_dir": str(root / "w"), "native_tools": False}
        for value in ("", "x" * 1001, 5, b"remind"):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "^invalid_tool_reminder$"):
                    ClaudeConfig(**fields, tool_reminder=value).validate()
        self.assertEqual(ClaudeConfig(**fields, tool_reminder="x" * 1000).wire()["tool_reminder"], "x" * 1000)
        self.assertIsNone(ClaudeConfig(**fields).wire()["tool_reminder"])


class PermissionPreviewTest(unittest.IsolatedAsyncioTestCase):
    async def test_a_large_tool_input_reaches_the_card_cut_with_its_path_whole(self):
        sys.path.insert(0, str(AGENTD))
        from character_agent.harness.claude_runner import ClaudeRunner
        runner = ClaudeRunner()
        runner.active = {"id": "run-1", "cancelled": False, "done": None}
        frames = []
        runner.emit = frames.append
        raw = {"content": "中" * 50000, "file_path": "/work/a.txt"}
        task = asyncio.create_task(runner.permission({"tool_name": "Write", "input": raw}))
        await asyncio.sleep(0)
        [frame] = frames
        preview = frame["raw_input"]
        self.assertLessEqual(len(json.dumps(preview, ensure_ascii=False)), 30000)
        self.assertEqual((preview["truncated"], preview["file_path"]), (True, "/work/a.txt"))
        self.assertTrue(preview["content"].startswith("中"))
        runner._accept({"type": "permission_result", "run_id": "run-1", "request_id": frame["request_id"],
                        "option_id": "allow_once"})
        self.assertTrue(await task)
        self.assertEqual(len(raw["content"]), 50000)

    async def test_a_long_command_keeps_the_card_title_short(self):
        sys.path.insert(0, str(AGENTD))
        from character_agent.harness.claude_runner import ClaudeRunner
        runner = ClaudeRunner()
        runner.active = {"id": "run-1", "cancelled": False, "done": None}
        frames = []
        runner.emit = frames.append
        task = asyncio.create_task(runner.permission({"tool_name": "Bash", "input": {"command": "echo " + "x" * 50000}}))
        await asyncio.sleep(0)
        [frame] = frames
        self.assertEqual(len(frame["title"]), 500)
        self.assertTrue(frame["title"].startswith("Bash: echo x"))
        runner._accept({"type": "permission_result", "run_id": "run-1", "request_id": frame["request_id"],
                        "option_id": "allow_once"})
        self.assertTrue(await task)


if __name__ == "__main__":
    unittest.main()


class ContextTokensTest(unittest.IsolatedAsyncioTestCase):
    async def test_result_reports_the_last_message_starts_input_tokens(self):
        sys.path.insert(0, str(AGENTD))
        from character_agent.harness.claude_runner import ClaudeRunner
        from types import SimpleNamespace

        async def write(_):
            pass
        runner = ClaudeRunner()
        runner.client = SimpleNamespace(write=write)
        runner.active = {"id": "run-1", "cancelled": False}
        frames = []
        runner.emit = frames.append
        task = asyncio.create_task(runner.run({"prompt": "Hi"}))
        await asyncio.sleep(0)
        run = runner.active
        for usage in ({"input_tokens": 5, "cache_creation_input_tokens": 100, "cache_read_input_tokens": 1000},
                      {"input_tokens": 7, "cache_creation_input_tokens": 20, "cache_read_input_tokens": "x"}):
            runner.stream_event(run, {"type": "message_start", "message": {"id": "m", "usage": usage}})
        run["done"].set_result({"type": "result", "subtype": "success", "is_error": False})
        await task
        result = [f for f in frames if f["type"] == "result"][-1]
        self.assertEqual(result["context_tokens"], 27)
