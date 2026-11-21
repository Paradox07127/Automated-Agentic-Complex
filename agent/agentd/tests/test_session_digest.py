"""Events from Claude Code transcripts built after record skeletons, in a temporary file."""
import datetime
import hmac
import itertools
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sessions.session_digest import new_state, read, subagent_invocation  # noqa: E402

SID = "0b6f3c1e-5d2a-4f7e-9c11-2a7d4e8b9f00"
AGENT = "a1b2c3d4e5f607182"
KEY = b"k" * 32
FIELDS = {"event_id", "session_id", "agent_id", "invocation_id", "path", "offset", "seq", "ts", "kind", "tool", "text",
          "text_len", "text_hash", "cut", "cwd", "branch", "files", "untagged", "check", "commit", "wait", "permission",
          "status"}
_uuids = itertools.count()


def env(type_, uuid=None, ts="2026-10-25T18:07:00.000Z", parent="u-parent", cwd="/Users/u/w", branch="main",
        **fields):
    record = {"parentUuid": parent, "isSidechain": False, "userType": "external", "entrypoint": "claude-desktop",
              "cwd": cwd, "sessionId": SID, "version": "2.1.308", "gitBranch": branch, "slug": "s", "type": type_,
              "uuid": uuid or f"u-{next(_uuids)}", "timestamp": ts}
    record.update(fields)
    return record


def human(content, **kw):
    return env("user", promptId="p1", message={"role": "user", "content": content}, permissionMode="bypassPermissions",
               origin={"kind": "human"}, promptSource="sdk", turnOrigin="human",
               turnPosition={"promptIndex": 0, "turnIndex": 0}, **kw)


def queued(prompt, kind="human"):
    return env("attachment", attachment={"type": "queued_command", "prompt": prompt, "source_uuid": "s",
                                         "delivery_id": "d", "commandMode": "prompt", "origin": {"kind": kind},
                                         "timestamp": "2026-10-25T18:07:00.000Z", "humanTurn": kind == "human"},
               rendered=[{"content": prompt}], renderedRole="user")


def assistant(*blocks):
    return env("assistant", message={"role": "assistant", "content": list(blocks), "stop_reason": "tool_use"},
               requestId="r1")


def text(value):
    return {"type": "text", "text": value}


def call(use_id, name, **inp):
    return {"type": "tool_use", "id": use_id, "name": name, "input": inp, "caller": {"type": "direct"}}


def bash_ok(**extra):
    return {"stdout": "", "stderr": "", "interrupted": False, "isImage": False, "noOutputExpected": False, **extra}


def result(use_id, content, is_error=False, tur="ok", source="config"):
    record = env("user", promptId="p1", message={"content": [{"tool_use_id": use_id, "type": "tool_result",
                                                              "content": content, "is_error": is_error}]},
                 sourceToolAssistantUUID="u-a", permissionDecision={"decision": "accept", "source": source,
                                                                    "reasonType": "rule"})
    if tur is not None:
        record["toolUseResult"] = bash_ok() if tur == "ok" else tur
    return record


def bash(use_id, command, content, **kw):
    return [assistant(call(use_id, "Bash", command=command, description="d")), result(use_id, content, **kw)]


def notice(task_id, use_id, status, summary, result_text=None):
    lines = ["<task-notification>", f"<task-id>{task_id}</task-id>"]
    if use_id is not None:
        lines.append(f"<tool-use-id>{use_id}</tool-use-id>")
    lines += ["<output-file>/private/tmp/t/out.output</output-file>", f"<status>{status}</status>",
              f"<summary>{summary}</summary>"]
    if result_text is not None:
        lines.append(f"<result>{result_text}</result>")
    return "\n".join(lines + ["<usage>total_tokens: 10</usage>", "</task-notification>"])


def notified(body, queued_form=False):
    if queued_form:
        return env("attachment", attachment={"type": "queued_command", "prompt": body,
                                             "origin": {"kind": "task-notification", "producer": "session-task"},
                                             "runId": "r", "usage": {"durationMs": 1, "toolUses": 1, "totalTokens": 1}})
    return env("user", message={"content": body},
               origin={"kind": "task-notification", "producer": "session-task", "runId": "r"}, promptSource="system",
               turnOrigin="task_notification", turnPosition={"promptIndex": 0, "turnIndex": 1}, queueSkipAttachments=True)


def agent_launch():
    return [assistant(text("派一个 worker"), call("toolu_A", "Agent", description="读格式", subagent_type="worker",
                                                   prompt="任务全文", run_in_background="true")),
            result("toolu_A", [text("Async agent launched successfully.")],
                   tur={"isAsync": True, "status": "async_launched", "agentId": AGENT, "description": "读格式",
                        "outputFile": "/private/tmp/t/a.output", "canReadOutputFile": True})]


def background_launch():
    return [assistant(call("toolu_B", "Bash", command="python3 -I -m unittest discover -s tests",
                           run_in_background=True)),
            result("toolu_B", "Command running in background with ID: b7k2m9q1.",
                   tur=bash_ok(backgroundTaskId="b7k2m9q1"))]


def line_bytes(record):
    return len(json.dumps(record, ensure_ascii=False).encode()) + 1


def mixed():
    """One of every kind, with Chinese text, for whole-file properties."""
    return [human("看一下汉字和 API"), queued("插一句"), *agent_launch(),
            notified(notice(AGENT, "toolu_A", "completed", "s", "结果")),
            *bash("t1", "python3 -I -m unittest", "Ran 98 tests in 1.2s\n\nOK"),
            *bash("c1", "git commit -q -m x && git log --oneline -1", "abc1234 提交说明"),
            *background_launch(), human("等它跑完"),
            notified(notice("b7k2m9q1", "toolu_B", "completed", "测试 completed (exit code 0)"), queued_form=True),
            assistant(text("问一下"), call("q1", "AskUserQuestion", questions=[{"question": "用哪个?"}])),
            result("q1", "答了", tur={"questions": [], "answers": {}}, source="user_temporary"),
            assistant(call("w1", "mcp__ccd_turn__wrap_up", recap="做完了一半", ask="要合并吗")),
            assistant(call("r1", "Read", file_path="/w/a.py"), call("m1", "mcp__x__y", z=["一", 2])),
            env("user", message={"role": "user", "content": "没有 origin 的字"})]


class SessionDigestTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / f"{SID}.jsonl"

    def write(self, *records, path=None, mode="w"):
        with open(path or self.path, mode, encoding="utf-8") as f:
            for record in records:
                f.write((record if isinstance(record, str) else json.dumps(record, ensure_ascii=False)) + "\n")

    def events(self, *records, human_text=True, key=KEY):
        self.write(*records)
        events, _ = read(new_state(str(self.path), SID), key, human_text)
        return events

    @unittest.skipIf(sys.platform == "win32", "the test compares bytes or sizes that include a newline written in text mode (CRLF on Windows)")
    def test_human_from_a_string_a_list_and_a_queued_command(self):
        first = human("看一下 API")
        events = self.events(first, human([text("第一段"), {"type": "image", "source": {}}, text("第二段")]),
                             queued("插一句"))
        self.assertEqual([(e["kind"], e["text"], e["untagged"]) for e in events],
                         [("human", "看一下 API", False), ("human", "第一段\n第二段", False), ("human", "插一句", False)])
        self.assertEqual(set(events[0]), FIELDS)
        e = events[0]
        self.assertEqual((e["event_id"], e["session_id"], e["agent_id"], e["invocation_id"], e["path"], e["offset"],
                          e["seq"], e["cwd"], e["branch"], e["files"], e["cut"], e["check"], e["status"]),
                         (f"{SID}/{first['uuid']}/0", SID, None, None, str(self.path), 0, 0, "/Users/u/w", "main", [],
                          False, None, None))
        self.assertEqual(e["ts"], datetime.datetime(2026, 10, 25, 18, 7, tzinfo=datetime.timezone.utc).timestamp())
        self.assertEqual((events[1]["offset"], events[1]["seq"], events[2]["seq"]), (line_bytes(first), 1, 2))

    def test_without_human_text_the_length_and_keyed_hash_remain(self):
        events = self.events(human("同一句话"), human("同一句话"), human_text=False)
        expected = hmac.new(KEY, "同一句话".encode(), "sha256").hexdigest()
        self.assertEqual([(e["text"], e["text_len"], e["text_hash"]) for e in events], [(None, 4, expected)] * 2)
        self.assertNotEqual(self.events(human("同一句话"), human_text=False, key=b"other")[0]["text_hash"], expected)

    def test_untagged_text_is_human_and_meta_summary_tags_and_plugin_are_skipped(self):
        events = self.events(env("user", message={"role": "user", "content": "普通字但是 meta"}, isMeta=True),
                             env("user", message={"content": "This session is being continued"}, isCompactSummary=True),
                             env("user", message={"content": "<local-command-stdout>x</local-command-stdout>"}),
                             env("user", message={"content": [text(" [Request interrupted by user]")]}),
                             env("user", message={"content": "插件说的话"}, origin={"kind": "plugin"}),
                             env("user", message={"role": "user", "content": "  继续"}))
        self.assertEqual([(e["kind"], e["text"], e["untagged"]) for e in events], [("human", "  继续", True)])

    def test_a_reappended_uuid_keeps_only_its_first_copy(self):
        first = human("原来那条", uuid="u-dup", cwd="/a")
        again = human("原来那条", uuid="u-dup", ts="2026-10-25T17:00:00.000Z", cwd="/b")
        events = self.events(first, human("下一条"), again)
        self.assertEqual([(e["text"], e["cwd"], e["seq"]) for e in events],
                         [("原来那条", "/a", 0), ("下一条", "/Users/u/w", 1)])

    def test_an_agent_launch_and_its_notifications_share_the_invocation(self):
        launch = agent_launch()
        events = self.events(*launch, notified(notice(AGENT, "toolu_A", "completed", "s", "结果\n第二行")),
                             notified(notice(AGENT, "toolu_A", "completed", "s", "再一次"), queued_form=True))
        self.assertEqual([(e["kind"], e["tool"], e["invocation_id"], e["text"], e["status"]) for e in events],
                         [("reply", None, None, "派一个 worker", None),
                          ("tool_call", "Agent", "toolu_A", "读格式", None),
                          ("tool_result", "Agent", "toolu_A", "Async agent launched successfully.", None),
                          ("tool_result", "Agent", "toolu_A", "结果\n第二行", "completed"),
                          ("tool_result", "Agent", "toolu_A", "再一次", "completed")])
        self.assertEqual([e["event_id"] for e in events[:2]], [f"{SID}/{launch[0]['uuid']}/0", f"{SID}/{launch[0]['uuid']}/1"])

    def test_a_result_after_the_next_human_message_keeps_the_launch(self):
        self.write(*agent_launch(), human("下一件事"))
        events, state = read(new_state(str(self.path), SID), KEY, True)
        self.assertEqual(events[-1]["kind"], "human")
        self.write(notified(notice(AGENT, None, "completed", "s", "晚到的结果")), mode="a")
        events, _ = read(json.loads(json.dumps(state)), KEY, True)
        self.assertEqual([(e["kind"], e["tool"], e["invocation_id"], e["text"]) for e in events],
                         [("tool_result", "Agent", "toolu_A", "晚到的结果")])

    def test_a_subagent_file_is_delegated_and_carries_the_parent_call(self):
        folder = Path(self.tmp.name) / SID / "subagents"
        folder.mkdir(parents=True)
        meta = folder / f"agent-{AGENT}.meta.json"
        meta.write_text(json.dumps({"agentType": "worker", "description": "读格式", "toolUseId": "toolu_A",
                                    "spawnDepth": 1, "requestShape": "x", "finished": True}), encoding="utf-8")
        path = folder / f"agent-{AGENT}.jsonl"

        def sub(record):
            return {**record, "agentId": AGENT, "isSidechain": True}

        self.write(sub(env("user", parent=None, promptId="p", message={"role": "user", "content": "任务全文"})),
                   sub(assistant(call("toolu_S1", "Read", file_path="/w/a.py"))),
                   sub(result("toolu_S1", "1\tprint()", tur=None)),
                   sub(env("user", message={"role": "user", "content": "再查一下"}, origin={"kind": "coordinator"})),
                   sub(queued("还有一件", kind="coordinator")), path=path)
        events, _ = read(new_state(str(path), SID, AGENT, subagent_invocation(str(meta))), KEY, True)
        self.assertEqual([(e["kind"], e["tool"], e["text"], e["files"]) for e in events],
                         [("delegated", None, "任务全文", []), ("tool_call", "Read", "/w/a.py", ["/w/a.py"]),
                          ("tool_result", "Read", "1\tprint()", []), ("delegated", None, "再查一下", []),
                          ("delegated", None, "还有一件", [])])
        self.assertEqual({(e["session_id"], e["agent_id"], e["invocation_id"], e["event_id"].split("/")[0])
                          for e in events}, {(SID, AGENT, "toolu_A", AGENT)})

    def test_bash_checks_take_their_exit_status_and_count_lines(self):
        events = self.events(
            *bash("t1", "python3 -I -m unittest discover -s .", "....\n------\nRan 98 tests in 1.234s\n\nOK"),
            *bash("t2", "python3 -I -m unittest", "Exit code 1\nFAIL: test_x\nFAILED (failures=1)", is_error=True,
                  tur="Error: Exit code 1\nFAIL: test_x"),
            *bash("t3", "swift test --filter X", "error: build stopped", is_error=True, tur="Error: build stopped"),
            *bash("t4", "pytest -q || true", "3 passed", tur=bash_ok(returnCodeInterpretation="No matches found")),
            *bash("t5", "swift test", "[Request interrupted by user for tool use]\nExecuted 3 tests, with 0 failures"))
        self.assertEqual([e["kind"] for e in events], ["tool_call", "check"] * 5)
        self.assertEqual([e["check"] for e in events[1::2]], [
            {"command": "python3 -I -m unittest discover -s .", "result": "pass", "exit": 0,
             "counts": ["Ran 98 tests in 1.234s", "OK"], "background": False},
            {"command": "python3 -I -m unittest", "result": "fail", "exit": 1, "counts": ["FAILED (failures=1)"],
             "background": False},
            {"command": "swift test --filter X", "result": "unknown", "exit": None, "counts": [], "background": False},
            {"command": "pytest -q || true", "result": "unknown", "exit": None, "counts": ["3 passed"],
             "background": False},
            {"command": "swift test", "result": "unknown", "exit": 0, "counts": ["Executed 3 tests, with 0 failures"],
             "background": False}])
        self.assertEqual((events[1]["tool"], events[1]["text"]), ("Bash", "....\n------\nRan 98 tests in 1.234s\n\nOK"))

    def test_a_background_bash_check_is_judged_from_its_notification(self):
        events = self.events(*background_launch(), human("等它跑完"),
                             notified(notice("b7k2m9q1", "toolu_B", "completed",
                                             'Background command "跑测试" completed (exit code 0)'), queued_form=True))
        self.assertEqual([(e["kind"], e["tool"], e["invocation_id"], e["status"]) for e in events],
                         [("tool_call", "Bash", None, None), ("tool_result", "Bash", "toolu_B", None),
                          ("human", None, None, None), ("check", "Bash", "toolu_B", "completed")])
        self.assertEqual(events[3]["check"], {"command": "python3 -I -m unittest discover -s tests", "result": "pass",
                                              "exit": 0, "counts": [], "background": True})

    def test_a_commit_needs_a_successful_commit_command_and_a_hash_line(self):
        events = self.events(
            *bash("c1", "git commit -q -m x && git log --oneline -1", "abc1234 Subject line"),
            *bash("c2", "git -c user.name=x commit -m x", "[master abc1234] Subject two\n 1 file changed"),
            *bash("c3", "git commit --dry-run -m x", "abc1234 Subject line"),
            *bash("c4", "git commit -q -m x && git log --oneline -1", "Exit code 1\nabc1234 Subject line",
                  is_error=True, tur="Error: Exit code 1"),
            *bash("c5", "git commit -q -m x && git log --oneline | head -n 1", "abc1234 Subject five"),
            *bash("c6", "git commit -n -q -m x", "abc1234 Subject six"))
        self.assertEqual([(e["kind"], e["commit"]) for e in events[1::2]],
                         [("commit", {"hash": "abc1234", "subject": "Subject line"}),
                          ("commit", {"hash": "abc1234", "subject": "Subject two"}),
                          ("tool_result", None), ("tool_result", None),
                          ("commit", {"hash": "abc1234", "subject": "Subject five"}),
                          ("commit", {"hash": "abc1234", "subject": "Subject six"})])  # -n is --no-verify

    def test_words_the_user_typed_into_a_tool_result_need_consent(self):
        records = [
            assistant(call("q1", "AskUserQuestion", questions=[
                {"question": "用哪个?", "header": "h", "multiSelect": False, "options": [{"label": "a"}]}])),
            result("q1", 'User has answered your questions: "用哪个?"="我自己的理由"',
                   tur={"questions": [], "answers": {}}, source="config"),  # private by its tool alone
            *bash("b1", "rm -r x", "The user doesn't want to proceed. The user said: 别删这个", is_error=True,
                  tur="Error: rejected", source="user_temporary"),
            *bash("b2", "ls", "a.txt")]
        private = [e for e in self.events(*records, human_text=False) if e["kind"] == "tool_result"]
        self.assertEqual([(e["tool"], e["text"]) for e in private],
                         [("AskUserQuestion", None), ("Bash", None), ("Bash", "a.txt")])
        self.assertTrue(all(e["text_len"] and e["text_hash"] for e in private))
        kept = [e for e in self.events(*records) if e["kind"] == "tool_result"]
        self.assertIn("我自己的理由", kept[0]["text"])
        self.assertIn("别删这个", kept[1]["text"])

    def test_count_lines_and_a_commit_subject_of_an_asked_result_need_consent(self):
        records = [*bash("b1", "rm -r x", "The user doesn't want to proceed. The user said: 2 failed 在我的私人项目",
                         is_error=True, tur="Error: rejected", source="user_temporary"),
                   *bash("c1", "git commit -q -m x && git log --oneline -1", "abc1234 我的私人主题",
                         source="user_temporary"),
                   *bash("t1", "python3 -I -m unittest", "Ran 5 tests\n\nOK", source="user_temporary")]
        private = self.events(*records, human_text=False)
        self.assertEqual([(e["kind"], e["check"], e["commit"]) for e in private[1::2]],
                         [("tool_result", None, None), ("commit", None, {"hash": "abc1234", "subject": None}),
                          ("check", {"command": "python3 -I -m unittest", "result": "pass", "exit": 0, "counts": [],
                                     "background": False}, None)])
        kept = self.events(*records)
        self.assertIn("在我的私人项目", kept[1]["check"]["counts"][0])
        self.assertEqual(kept[3]["commit"]["subject"], "我的私人主题")
        self.assertEqual(kept[5]["check"]["counts"], ["Ran 5 tests", "OK"])

    def test_a_result_without_its_call_needs_consent(self):
        events = self.events(result("x1", "我在对话框里打的字", tur=None), human_text=False)
        self.assertEqual([(e["tool"], e["text"]) for e in events], [("unknown", None)])

    def test_a_notebook_edit_names_its_notebook(self):
        events = self.events(assistant(call("n1", "NotebookEdit", notebook_path="/w/a.ipynb", new_source="x")))
        self.assertEqual((events[0]["text"], events[0]["files"]), ("/w/a.ipynb", ["/w/a.ipynb"]))

    def test_waits_and_a_user_permission_decision(self):
        events = self.events(
            assistant(call("q1", "AskUserQuestion", questions=[
                {"question": "用哪个?", "header": "h", "multiSelect": False, "options": [{"label": "a"}]},
                {"question": "何时?", "header": "h", "multiSelect": False, "options": []}])),
            result("q1", "User has answered", tur={"questions": [], "answers": {}}, source="user_temporary"),
            assistant(call("w1", "mcp__ccd_turn__wrap_up", recap="做完了一半", ask="要合并吗",
                           actions=[{"label": "合并", "message": "合并"}])),
            assistant(call("w2", "mcp__ccd_turn__wrap_up", recap="卡住了", blocked=True)),
            assistant(call("w3", "mcp__ccd_turn__wrap_up", recap="全做完了")),
            result("w3", "ok", tur={}))
        self.assertEqual([(e["kind"], e["wait"], e["text"], e["permission"]) for e in events],
                         [("wait", "question", "用哪个?\n何时?", None),
                          ("tool_result", None, "User has answered", "user_temporary"),
                          ("wait", "ask", "要合并吗", None), ("wait", "blocked", "卡住了", None),
                          ("tool_call", None, "全做完了", None), ("tool_result", None, "ok", None)])

    def test_reading_in_pieces_through_saved_states_gives_the_same_events(self):
        data = b"".join(json.dumps(r, ensure_ascii=False).encode() + b"\n" for r in mixed())
        self.path.write_bytes(data)
        whole, _ = read(new_state(str(self.path), SID), KEY, True)
        newline = data.index(b"\n") + 1
        cuts = [newline, newline + 7, data.index("汉字".encode()) + 1, len(data) // 2, len(data) - 3]
        self.assertEqual(len(set(cuts)), 5)
        self.path.write_bytes(b"")
        state, pieces, done = new_state(str(self.path), SID), [], 0
        for cut in sorted(cuts) + [len(data)]:
            with open(self.path, "ab") as f:
                f.write(data[done:cut])
            done = cut
            events, state = read(state, KEY, True)
            pieces += events
            state = json.loads(json.dumps(state))
        self.assertGreater(len(whole), 20)
        self.assertEqual(json.dumps(pieces, sort_keys=True), json.dumps(whole, sort_keys=True))

    def test_the_read_state_keeps_only_calls_still_waiting_for_their_result(self):
        launches = [*bash("t1", "ls", "a.txt"), *agent_launch(), *background_launch()]
        notices = [notified(notice(AGENT, "toolu_A", "completed", "s", "结果")),
                   notified(notice("b7k2m9q1", "toolu_B", "completed", "测试 completed (exit code 0)"), queued_form=True)]
        self.write(*launches)
        _, half = read(new_state(str(self.path), SID), KEY, True)
        self.assertEqual((set(half["tools"]), half["launches"]),
                         ({"toolu_A", "toolu_B"}, {AGENT: "toolu_A", "b7k2m9q1": "toolu_B"}))
        self.write(*notices, mode="a")
        events, done = read(half, KEY, True)
        self.assertEqual([(e["kind"], e["tool"], e["invocation_id"]) for e in events],
                         [("tool_result", "Agent", "toolu_A"), ("check", "Bash", "toolu_B")])
        self.assertEqual(events[1]["check"]["command"], "python3 -I -m unittest discover -s tests")
        self.assertEqual((done["tools"], done["launches"]), ({}, {}))

    def test_a_launch_read_apart_from_its_notification_gives_the_same_events(self):
        records = [*bash("t1", "ls", "a.txt"), *agent_launch(), *background_launch(), human("等它们跑完"),
                   notified(notice(AGENT, None, "completed", "s", "结果")),
                   notified(notice("b7k2m9q1", None, "completed", "测试 completed (exit code 1)"), queued_form=True)]
        whole = self.events(*records)
        self.write(*records[:-2])
        first, state = read(new_state(str(self.path), SID), KEY, True)
        self.write(*records[-2:], mode="a")
        second, _ = read(json.loads(json.dumps(state)), KEY, True)
        self.assertEqual([(e["kind"], e["tool"], e["invocation_id"]) for e in second],
                         [("tool_result", "Agent", "toolu_A"), ("check", "Bash", "toolu_B")])
        self.assertEqual(json.dumps(first + second, sort_keys=True), json.dumps(whole, sort_keys=True))

    @unittest.skipIf(sys.platform == "win32", "the test compares bytes or sizes that include a newline written in text mode (CRLF on Windows)")
    def test_a_line_without_its_newline_waits(self):
        first = human("一")
        self.write(first)
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(json.dumps(human("二"), ensure_ascii=False))
        events, state = read(new_state(str(self.path), SID), KEY, True)
        self.assertEqual(([e["text"] for e in events], state["offset"], state["line"]), (["一"], line_bytes(first), 1))
        with open(self.path, "a", encoding="utf-8") as f:
            f.write("\n")
        events, state = read(state, KEY, True)
        self.assertEqual([(e["text"], e["offset"], e["seq"]) for e in events], [("二", line_bytes(first), 1)])
        self.assertEqual(state["offset"], self.path.stat().st_size)

    def test_bad_lines_are_skipped_and_still_counted(self):
        events = self.events("{bad", "[1]", '"x"', "null", human("好的一行"),
                             {"type": "user", "uuid": "u-x", "message": 3, "origin": "human"}, human("后面一行"))
        self.assertEqual([(e["text"], e["seq"]) for e in events], [("好的一行", 4), ("后面一行", 6)])

    def test_event_ids_are_unique_in_a_file(self):
        ids = [e["event_id"] for e in self.events(*mixed())]
        self.assertGreater(len(ids), 20)
        self.assertEqual(len(set(ids)), len(ids))

    def test_long_text_is_cut_with_its_full_length_and_hash(self):
        e = self.events(human("字" * 9000))[0]
        self.assertEqual((len(e["text"]), e["cut"], e["text_len"]), (8000, True, 9000))
        self.assertEqual(e["text_hash"], hmac.new(KEY, ("字" * 9000).encode(), "sha256").hexdigest())

    def test_subagent_invocation_reads_tool_use_id_or_nothing(self):
        folder = Path(self.tmp.name)
        cases = {"ok.json": json.dumps({"agentType": "worker", "toolUseId": "toolu_A"}), "bad.json": "{",
                 "type.json": json.dumps({"toolUseId": 5})}
        for name, body in cases.items():
            (folder / name).write_text(body, encoding="utf-8")
        self.assertEqual([subagent_invocation(str(folder / n)) for n in ("ok.json", "missing.json", "bad.json",
                                                                          "type.json")],
                         ["toolu_A", None, None, None])


if __name__ == "__main__":
    unittest.main()
