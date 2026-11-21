from pathlib import Path
import hashlib
import json
import shlex
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sessions.danger import classify  # noqa: E402
from sessions.events import command_text, normalize_claude, normalize_codex, tool_category, tool_summary  # noqa: E402

COMMON = {"session_id": "s1", "transcript_path": "/tmp/t.jsonl", "cwd": "/work"}

# (hook payload extras, expected kind) for every Claude event.
CLAUDE_CASES = [
    ({"hook_event_name": "SessionEnd", "reason": "exit"}, "session_end"),
    ({"hook_event_name": "UserPromptSubmit", "prompt": "hi"}, "prompt_submit"),
    ({"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {}, "tool_use_id": "t"}, "tool_start"),
    ({"hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion", "tool_input": {}}, "awaiting_input"),
    ({"hook_event_name": "PostToolUse", "tool_name": "Read", "tool_response": {}, "duration_ms": 3}, "tool_end"),
    ({"hook_event_name": "PostToolUseFailure", "tool_name": "Bash", "error": "x", "is_interrupt": False}, "tool_failure"),
    ({"hook_event_name": "PostToolBatch", "tool_calls": []}, "tool_end"),
    ({"hook_event_name": "PermissionRequest", "tool_name": "mcp__gh__create_issue",
      "tool_input": {}, "mcp_server": "gh", "permission_suggestions": []}, "permission_request"),
    ({"hook_event_name": "Notification", "notification_type": "permission_prompt", "message": "m"}, "notification"),
    ({"hook_event_name": "Notification", "notification_type": "idle_prompt", "message": "m"}, "awaiting_input"),
    ({"hook_event_name": "Notification", "notification_type": "elicitation_dialog"}, "awaiting_input"),
    ({"hook_event_name": "Notification", "notification_type": "elicitation_url_dialog"}, "awaiting_input"),
    ({"hook_event_name": "Notification", "notification_type": "agent_needs_input"}, "awaiting_input"),
    ({"hook_event_name": "MessageDisplay", "turn_id": "u", "message_id": "m", "delta": "x"}, "message"),
    ({"hook_event_name": "SubagentStop", "agent_id": "a1", "last_assistant_message": "ok"}, "subagent_stop"),
    ({"hook_event_name": "TaskCreated", "task_id": "k", "task_subject": "s"}, "other"),
    ({"hook_event_name": "Stop", "last_assistant_message": "ok", "stop_hook_active": False}, "stop"),
    ({"hook_event_name": "StopFailure", "error": "api", "error_details": {}}, "stop_failure"),
    ({"hook_event_name": "PreCompact", "trigger": "auto"}, "compact_start"),
    ({"hook_event_name": "PostCompact", "compact_summary": "s"}, "compact_end"),
    ({"hook_event_name": "CwdChanged"}, "other"),
]

# The Codex hook events agentd installs.
CODEX_CASES = [
    ({"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {}, "tool_use_id": "t", "turn_id": "u"}, "tool_start"),
    ({"hook_event_name": "PermissionRequest", "tool_name": "apply_patch", "tool_input": {}}, "permission_request"),
    ({"hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_response": {}}, "tool_end"),
    ({"hook_event_name": "PreCompact", "trigger": "auto"}, "compact_start"),
    ({"hook_event_name": "PostCompact", "trigger": "auto"}, "compact_end"),
    ({"hook_event_name": "SessionEnd", "reason": "exit"}, "session_end"),
    ({"hook_event_name": "UserPromptSubmit", "prompt": "hi"}, "prompt_submit"),
    ({"hook_event_name": "SubagentStop", "agent_id": "a2", "agent_transcript_path": "/t"}, "subagent_stop"),
    ({"hook_event_name": "Stop", "last_assistant_message": "ok", "stop_hook_active": False}, "stop"),
    ({"hook_event_name": "Interrupt"}, "interrupt"),
]


class NormalizeTest(unittest.TestCase):
    def check(self, normalize, source, cases):
        for extra, kind in cases:
            with self.subTest(event=extra["hook_event_name"], kind=kind):
                event = normalize({**COMMON, **extra}, now=5.0)
                self.assertEqual((event.source, event.session_id, event.cwd, event.kind, event.ts),
                                 (source, "s1", "/work", kind, 5.0))
                self.assertEqual(event.tool_name, extra.get("tool_name"))
                self.assertIsNone(event.request_id)

    def test_claude_events(self):
        self.check(normalize_claude, "claude", CLAUDE_CASES)

    def test_codex_events(self):
        self.check(normalize_codex, "codex", CODEX_CASES)

    def test_the_forwarders_start_time_stamps_the_event(self):
        for started, ts in ((4.25, 4.25), (9.0, 5.0), ("4", 5.0), (True, 5.0), (float("nan"), 5.0), (None, 5.0)):
            with self.subTest(started=started):
                for normalize in (normalize_claude, normalize_codex):
                    event = normalize({**COMMON, "hook_event_name": "Stop", "agentd_started_at": started}, now=5.0)
                    self.assertEqual(event.ts, ts)

    def test_subagent_identity_hangs_under_session(self):
        event = normalize_claude({**COMMON, "hook_event_name": "PreToolUse", "tool_name": "Grep",
                                  "agent_id": "a1", "agent_type": "Explore"})
        self.assertEqual((event.agent_id, event.parent_id, event.tool_category), ("a1", "s1", "search"))
        self.assertIsNone(normalize_codex({**COMMON, "hook_event_name": "Stop"}).parent_id)

    def test_seq_increases(self):
        first = normalize_codex({**COMMON, "hook_event_name": "Stop"})
        second = normalize_codex({**COMMON, "hook_event_name": "Stop"})
        self.assertGreater(second.seq, first.seq)

    def test_tool_categories(self):
        cases = {"Read": "read", "NotebookRead": "read", "Write": "write", "Edit": "write",
                 "apply_patch": "write", "Bash": "command", "write_stdin": "command",
                 "Grep": "search", "Glob": "search", "WebSearch": "search",
                 "mcp__github__create_issue": "mcp", "spawn_agent": "other", "Task": "other"}
        for name, category in cases.items():
            self.assertEqual(tool_category(name), category, name)
        self.assertIsNone(tool_category(None))

    def test_turn_id_prefers_turn_id_then_prompt_id(self):
        both = normalize_codex({**COMMON, "hook_event_name": "Stop", "turn_id": "t1", "prompt_id": "p1"})
        self.assertEqual(both.turn_id, "t1")
        prompt = normalize_claude({**COMMON, "hook_event_name": "Stop", "turn_id": "", "prompt_id": "p1"})
        self.assertEqual(prompt.turn_id, "p1")
        self.assertIsNone(normalize_claude({**COMMON, "hook_event_name": "Stop"}).turn_id)

    def test_tool_fingerprint_ignores_key_order(self):
        asked = normalize_claude({**COMMON, "hook_event_name": "PermissionRequest", "tool_name": "Bash",
                                  "tool_input": {"command": "ls", "timeout": 5}})
        done = normalize_claude({**COMMON, "hook_event_name": "PostToolUse", "tool_name": "Bash",
                                 "tool_input": {"timeout": 5, "command": "ls"}, "tool_use_id": "t"})
        self.assertEqual(asked.tool_fp, done.tool_fp)
        self.assertEqual(len(asked.tool_fp), 16)
        self.assertNotEqual(asked.digest, done.digest)
        self.assertIsNone(normalize_claude({**COMMON, "hook_event_name": "Stop"}).tool_fp)
        reordered = normalize_claude({"hook_event_name": "PermissionRequest", "tool_name": "Bash",
                                      "tool_input": {"timeout": 5, "command": "ls"}, **COMMON})
        self.assertEqual(reordered.digest, asked.digest)

    def test_tool_summary_picks_command_or_path(self):
        def summary(tool_name, tool_input):
            return normalize_claude({**COMMON, "hook_event_name": "PermissionRequest",
                                     "tool_name": tool_name, "tool_input": tool_input}).tool_summary
        self.assertEqual(summary("Bash", {"command": "git status", "timeout": 5}), "git status")
        self.assertEqual(summary("Write", {"file_path": "/w/a.py", "content": "secret"}), "/w/a.py")
        self.assertEqual(summary("NotebookEdit", {"notebook_path": "/w/n.ipynb", "new_source": "x"}),
                         "/w/n.ipynb")
        self.assertEqual(summary("Grep", {"pattern": "示例甲", "path": "/w"}),
                         '{"pattern": "示例甲", "path": "/w"}')
        self.assertIsNone(normalize_claude({**COMMON, "hook_event_name": "PermissionRequest",
                                            "tool_name": "Bash"}).tool_summary)

    def test_tool_summary_truncates(self):
        def summary(tool_input):
            return normalize_claude({**COMMON, "hook_event_name": "PermissionRequest",
                                     "tool_name": "X", "tool_input": tool_input}).tool_summary
        other = summary({"query": "q" * 500})
        self.assertEqual(len(other), 200)
        self.assertTrue(other.startswith('{"query": "qqq'))
        self.assertTrue(other.endswith("…"))
        command = summary({"command": "c" * 3000})
        self.assertEqual(command, "c" * 1999 + "…")
        self.assertEqual(summary({"command": "c" * 2000}), "c" * 2000)

    def test_summary_metadata_describes_the_full_text(self):
        for tool_input, text, limit in (({"command": "c" * 5000}, "c" * 5000, 2000),
                                        ({"file_path": "/" + "路" * 2100}, "/" + "路" * 2100, 2000),
                                        ({"query": "q" * 500}, json.dumps({"query": "q" * 500}), 200),
                                        ({"command": ["echo", "a b"]}, shlex.join(["echo", "a b"]), 2000),
                                        ({"command": "c" * 2000}, "c" * 2000, 2000)):
            with self.subTest(field=next(iter(tool_input)), length=len(text)):
                card = normalize_claude({**COMMON, "hook_event_name": "PermissionRequest",
                                         "tool_name": "Bash", "tool_input": tool_input}).to_dict()
                self.assertEqual(card["summary_truncated"], len(text) > limit)
                self.assertEqual(card["summary_length"], len(text))
                self.assertEqual(card["summary_sha256"], hashlib.sha256(text.encode()).hexdigest())
                self.assertEqual(card["tool_summary"], text if len(text) <= limit else text[:limit - 1] + "…")

    def test_write_tools_preview_new_content(self):
        for name, tool_input, content in (
                ("Write", {"content": "新" * 500}, "新" * 500),
                ("Edit", {"old_string": "old", "new_string": "replacement"}, "replacement"),
                ("MultiEdit", {"edits": [{"new_string": "first"}, {"new_string": "second"}]},
                 "first\n(2 edits)"),
                ("MultiEdit", {"edits": [{"new_string": "x" * 500}, {"new_string": "second"}]},
                 "x" * 500 + "\n(2 edits)"),
                ("NotebookEdit", {"new_source": "cell"}, "cell"),
                ("Write", {"content": ""}, ""),
                ("Write", {"content": "x" * 400}, "x" * 400)):
            with self.subTest(tool=name, length=len(content)):
                card = normalize_claude({**COMMON, "hook_event_name": "PermissionRequest", "tool_name": name,
                                         "tool_input": {"file_path": "/w/a", **tool_input}}).to_dict()
                preview = tool_input["edits"][0]["new_string"][:400] + "\n(2 edits)" \
                    if name == "MultiEdit" else content[:400]
                self.assertEqual(card["content_preview"], preview)
                self.assertEqual(card["content_preview_truncated"], len(content) > len(preview))
                self.assertEqual(card["content_preview_length"], len(content))
                self.assertEqual(card["content_preview_sha256"], hashlib.sha256(content.encode()).hexdigest())

    def test_a_command_array_is_joined_and_judged(self):
        argv = ["bash", "-lc", "rm -rf ~"]
        self.assertEqual(tool_summary({"command": argv}), shlex.join(argv))
        self.assertTrue(classify("command", tool_summary({"command": argv}))["dangerous"])
        self.assertEqual(command_text({"command": argv}), shlex.join(argv))

    def test_command_text_keeps_the_tail_the_summary_clips(self):
        command = "echo " + "x" * (2500 - len("echo ") - len("; rm -rf ~")) + "; rm -rf ~"
        self.assertEqual(len(command), 2500)
        self.assertEqual(command_text({"command": command}), command)
        self.assertTrue(classify("Bash", command_text({"command": command}))["dangerous"])
        self.assertFalse(classify("Bash", tool_summary({"command": command}))["dangerous"])
        for tool_input in ("ls", ["ls"], {"command": []}, {"command": ["ls", 1]}, {"command": ""}, {}):
            with self.subTest(tool_input):
                self.assertIsNone(command_text(tool_input))

    def test_permission_suggestions_keep_only_session_scoped_allows(self):
        rule = {"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "rm -rf node_modules"},
                                              {"toolName": "Read"}],
                "behavior": "allow", "destination": "localSettings"}
        edits = {"type": "setMode", "mode": "acceptEdits", "destination": "session", "extra": 1}
        dirs = {"type": "addDirectories", "directories": ["/x"], "destination": "userSettings"}
        dropped = [{"type": "setMode", "mode": "bypassPermissions", "destination": "session"},
                   {"type": "addRules", "rules": [{"toolName": "Bash"}], "behavior": "deny"},
                   {"type": "addRules", "rules": [], "behavior": "allow"},
                   {"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": 5}], "behavior": "allow"},
                   {"type": "addDirectories", "directories": []},
                   {"type": "addDirectories", "directories": [1]},
                   {"type": "removeRules", "rules": [{"toolName": "Bash"}], "behavior": "allow"},
                   "addRules", None]
        payload = {**COMMON, "hook_event_name": "PermissionRequest", "tool_name": "Bash",
                   "tool_input": {"command": "rm -rf node_modules"},
                   "permission_suggestions": [rule, edits, dirs] + dropped}
        event = normalize_claude(payload)
        self.assertEqual(event.suggestions, [
            {"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "rm -rf node_modules"},
                                           {"toolName": "Read"}], "behavior": "allow", "destination": "session"},
            {"type": "setMode", "mode": "acceptEdits", "destination": "session"},
            {"type": "addDirectories", "directories": ["/x"], "destination": "session"}])
        without = normalize_claude({k: v for k, v in payload.items() if k != "permission_suggestions"})
        self.assertEqual((event.tool_fp, event.tool_summary), (without.tool_fp, without.tool_summary))
        self.assertIsNone(normalize_claude({**payload, "permission_suggestions": dropped}).suggestions)
        self.assertIsNone(normalize_claude({**payload, "permission_suggestions": "x"}).suggestions)
        self.assertIsNone(without.suggestions)

    def test_missing_session_id_rejected(self):
        with self.assertRaises(ValueError):
            normalize_claude({"hook_event_name": "Stop"})
        with self.assertRaises(ValueError):
            normalize_codex(["not", "an", "object"])


class ToolTargetTest(unittest.TestCase):
    """The short action a session card shows: never a whole command, path, pattern or file body."""

    def target(self, tool_name, tool_input, normalize=normalize_claude):
        return normalize({**COMMON, "hook_event_name": "PreToolUse", "tool_name": tool_name,
                          "tool_input": tool_input}).tool_target

    def test_bash_is_its_description_else_only_the_program(self):
        self.assertEqual(self.target("Bash", {"command": "swift test --filter X", "description": "swift test"}),
                         "swift test")
        self.assertEqual(self.target("Bash", {"command": "ls", "description": "d" * 60}), "d" * 39 + "…")
        self.assertEqual(self.target("Bash", {"command": "/usr/bin/curl -H 'Authorization: Bearer sk-SECRET' x"}),
                         "curl")
        self.assertEqual(self.target("Bash", {"command": "API_KEY=sk-SECRET OTHER=1 ./deploy.sh --token sk-SECRET"}),
                         "deploy.sh")
        self.assertEqual(self.target("Bash", {"command": "echo 'unclosed sk-SECRET"}), "echo")
        self.assertEqual(self.target("shell", {"command": ["/bin/zsh", "-lc", "cat sk-SECRET"]}, normalize_codex),
                         "zsh")
        self.assertIsNone(self.target("Bash", {}))

    def test_file_tools_are_the_file_name(self):
        for tool in ("Edit", "Write", "MultiEdit", "Read"):
            with self.subTest(tool=tool):
                self.assertEqual(self.target(tool, {"file_path": "/Users/me/secret/HostLink.swift", "content": "x"}),
                                 "HostLink.swift")
        self.assertEqual(self.target("NotebookEdit", {"notebook_path": "/w/a/plot.ipynb", "new_source": "x"}),
                         "plot.ipynb")

    def test_search_tools_name_no_pattern_and_fetch_names_the_host(self):
        self.assertIsNone(self.target("Grep", {"pattern": "password", "path": "/w"}))
        self.assertIsNone(self.target("Glob", {"pattern": "**/*.key"}))
        self.assertIsNone(self.target("WebSearch", {"query": "private question"}))
        self.assertEqual(self.target("WebFetch", {"url": "https://api.github.com/repos/x?token=sk-SECRET"}),
                         "api.github.com")
        self.assertIsNone(self.target("WebFetch", {"url": "not a url"}))

    def test_task_is_its_description_and_mcp_is_server_and_tool(self):
        self.assertEqual(self.target("Task", {"description": "查一下构建脚本", "prompt": "long private prompt"}),
                         "查一下构建脚本")
        self.assertEqual(self.target("Agent", {"description": "a" * 50, "prompt": "p"}), "a" * 39 + "…")
        self.assertEqual(self.target("mcp__github__create_issue", {"body": "private"}), "github · create_issue")
        self.assertIsNone(self.target("Unknown", {"anything": "x"}))

    def test_host_internal_mcp_targets_are_hidden_but_user_servers_remain(self):
        for name in ("mcp__ccd_turn__wrap_up", "mcp__ccd_plan__update", "mcp__agentic_complex__receipt_check"):
            with self.subTest(name=name):
                self.assertIsNone(self.target(name, {}))

    def test_no_tool_input_has_no_target(self):
        self.assertIsNone(normalize_claude({**COMMON, "hook_event_name": "Stop"}).tool_target)


if __name__ == "__main__":
    unittest.main()
