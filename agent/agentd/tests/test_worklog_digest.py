"""Work-memory L1 input: live hook frames cut into session segments and worker batches, pressed into a bounded input."""
import datetime
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_agent.services.worklog_digest import LIMIT, digest, segments

T0 = datetime.datetime(2026, 11, 4, 10, 0).timestamp()
MIN = 60


class Frames:
    def __init__(self):
        self.count = 0

    def __call__(self, at, role, content, *, session="s1", agent="claude", cwd="/Users/u/Endfield", tool=None):
        self.count += 1
        requires = ["agent_sessions"] + (["typed_text"] if role == "prompt_submit" else [])
        return {"id": f"obs-{self.count:032x}", "at": at, "requires": requires,
                "metadata": {"app": agent, "doc": cwd, "label": session, "kind": "live_hook", "role": role,
                             "subrole": tool},
                "text": json.dumps(content)}


def bash(command, output):
    return {"tool_input": {"command": command}, "tool_response": {"stdout": output, "stderr": ""}}


class WorkLogDigestTest(unittest.TestCase):
    def setUp(self):
        self.frame = Frames()

    def work(self, start, minutes, **where):
        """Two prompts, then a tool call a minute until minutes minutes, then a stop."""
        rows = [self.frame(start, "prompt_submit", {"prompt": "修重连"}, **where),
                self.frame(start + MIN, "prompt_submit", {"prompt": "顺便补测试"}, **where)]
        rows += [self.frame(start + i * MIN, "tool_end", bash(f"echo {i}", "ok"), tool="Bash", **where)
                 for i in range(2, minutes)]
        return rows + [self.frame(start + minutes * MIN, "stop", {"last_assistant_message": "改好了"}, **where)]

    def test_a_twenty_minute_gap_cuts_a_session_into_two_segments(self):
        frames = self.work(T0, 10) + self.work(T0 + 30 * MIN, 10)
        cut = segments(frames, [], T0 + 60 * MIN)
        self.assertEqual([(s["kind"], s["session_key"], s["start"]) for s in cut],
                         [("agent_session", "s1", T0), ("agent_session", "s1", T0 + 30 * MIN)])
        self.assertTrue(all(s["closed"] for s in cut))
        self.assertEqual([len(s["frames"]) for s in cut], [11, 11])
        self.assertEqual(cut[0]["project"], "Endfield")

    def test_a_segment_stays_open_until_fifteen_idle_minutes_or_session_end(self):
        frames = self.work(T0, 10)
        self.assertFalse(segments(frames, [], T0 + 20 * MIN)[0]["closed"])
        self.assertTrue(segments(frames, [], T0 + 25 * MIN)[0]["closed"])
        frames.append(self.frame(T0 + 11 * MIN, "session_end", {"result": "bye"}))
        self.assertTrue(segments(frames, [], T0 + 12 * MIN)[0]["closed"])

    def test_a_subagent_joins_its_parent_segment(self):
        frames = self.work(T0, 10)
        frames.insert(5, self.frame(T0 + 4 * MIN + 30, "subagent_stop", {"last_assistant_message": "子代理查完了"}))
        cut = segments(frames, [], T0 + 60 * MIN)
        self.assertEqual(len(cut), 1)
        made = digest(cut[0], None)
        self.assertEqual(made["subagents"], 1)
        self.assertIn("子代理查完了", [line["text"] for line in made["lines"] if line["tag"] == "agent"])

    def test_three_worktree_workers_in_an_hour_are_one_worker_batch(self):
        frames = []
        for i in range(3):
            where = {"session": f"w{i}", "agent": "codex", "cwd": f"/Users/u/Endfield-20261104-10{i}000-ab{i}"}
            frames += self.work(T0 + i * 12 * MIN, 8, **where)
            frames.append(self.frame(T0 + i * 12 * MIN + 9 * MIN, "session_end", {"result": "done"}, **where))
        cut = segments(frames, [], T0 + 120 * MIN)
        self.assertEqual([(s["kind"], s["session_key"], s["project"]) for s in cut],
                         [("worker_batch", "/Users/u/Endfield@2026-11-04T10", "Endfield")])
        self.assertTrue(cut[0]["closed"])
        self.assertEqual(digest(cut[0], None)["sessions"], 3)

    def test_a_worker_with_a_four_digit_suffix_is_in_its_repository_batch(self):
        where = {"session": "w1", "cwd": "/Users/u/.mm-wt/Endfield-20261104-013631-35b2"}
        frames = self.work(T0, 30, **where)
        cut = segments(frames, [], T0 + 120 * MIN)
        self.assertEqual([(s["kind"], s["session_key"], s["project"]) for s in cut],
                         [("worker_batch", "/Users/u/.mm-wt/Endfield@2026-11-04T10", "Endfield")])

    def test_a_worker_batch_prompt_is_the_orchestrators_not_the_users(self):
        where = {"session": "w1", "cwd": "/Users/u/Endfield-20261104-100000-ab0"}
        made = digest(segments(self.work(T0, 8, **where), [], T0 + 120 * MIN)[0], None)
        self.assertEqual([line["text"] for line in made["lines"] if line["tag"] == "orchestrator"],
                         ["修重连", "顺便补测试"])
        self.assertNotIn("user", [line["tag"] for line in made["lines"]])

    def test_a_desktop_worktree_prompt_is_the_users_and_an_agent_worktree_prompt_the_orchestrators(self):
        for cwd, tag in (("/r/repo/.claude/worktrees/funny-turing", "user"),
                         ("/r/repo/.claude/worktrees/agent-a0ad7643", "orchestrator")):
            with self.subTest(cwd=cwd):
                made = digest(segments(self.work(T0, 30, cwd=cwd), [], T0 + 120 * MIN)[0], None)
                self.assertEqual([line["text"] for line in made["lines"] if line["tag"] == tag],
                                 ["修重连", "顺便补测试"])

    def test_a_short_session_in_the_main_repository_keeps_the_users_prompt(self):
        frames = [self.frame(T0, "prompt_submit", {"prompt": "跑一下门禁"})]
        frames += [self.frame(T0 + i * MIN, "tool_end", bash("make", "ok"), tool="Bash") for i in range(1, 10)]
        made = digest(segments(frames, [], T0 + 60 * MIN)[0], None)
        self.assertEqual([line["text"] for line in made["lines"] if line["tag"] == "user"], ["跑一下门禁"])

    def test_a_short_finished_session_with_one_prompt_is_a_worker(self):
        frames = [self.frame(T0, "prompt_submit", {"prompt": "跑一下门禁"})]
        frames += [self.frame(T0 + i * MIN, "tool_end", bash("make", "ok"), tool="Bash") for i in range(1, 10)]
        self.assertEqual([(s["kind"], s["closed"]) for s in segments(frames, [], T0 + 20 * MIN)],
                         [("agent_session", False)])
        self.assertEqual([(s["kind"], s["closed"]) for s in segments(frames, [], T0 + 30 * MIN)],
                         [("worker_batch", False)])
        self.assertEqual([(s["kind"], s["closed"]) for s in segments(frames, [], T0 + 60 * MIN)],
                         [("worker_batch", True)])

    def test_a_two_megabyte_tool_response_keeps_the_input_within_the_limit(self):
        frames = self.work(T0, 10)
        huge = "x" * 2_000_000 + "\nRan 12 tests in 3.1s\nOK\n"
        frames.insert(3, self.frame(T0 + 2 * MIN + 30, "tool_end", bash("python3 -m unittest discover", huge),
                                    tool="Bash"))
        frames.insert(4, self.frame(T0 + 2 * MIN + 40, "tool_end",
                                    {"tool_input": {"file_path": "/Users/u/Endfield/a.py"}, "tool_response": huge},
                                    tool="Read"))
        made = digest(segments(frames, [], T0 + 60 * MIN)[0], {"title": "上一段", "status": "ongoing",
                                                                 "next_steps": []})
        self.assertLessEqual(len(json.dumps(made, ensure_ascii=False)), LIMIT)
        checks = [line["text"] for line in made["lines"] if line["tag"] == "check"]
        self.assertEqual(len(checks), 1)
        self.assertIn("Ran 12 tests", checks[0])
        self.assertEqual(made["previous"]["title"], "上一段")

    def test_long_prompts_and_many_lines_still_fit(self):
        frames = [self.frame(T0 + i * 20, "prompt_submit", {"prompt": "长" * 30000}) for i in range(10)]
        frames += [self.frame(T0 + 300 + i * 20, "stop", {"last_assistant_message": "答" * 30000}) for i in range(10)]
        made = digest(segments(frames, [], T0 + 60 * MIN)[0], None)
        self.assertLessEqual(len(json.dumps(made, ensure_ascii=False)), LIMIT)
        users = [line for line in made["lines"] if line["tag"] == "user"]
        self.assertEqual(users[0]["id"], frames[0]["id"])  # the first prompt is the last to go

    def test_ninety_minutes_and_midnight_close_a_segment(self):
        frames = [self.frame(T0 + i * 5 * MIN, "tool_end", bash("make", "ok"), tool="Bash") for i in range(25)]
        cut = segments(frames, [], T0 + 200 * MIN)
        self.assertEqual([s["cut"] for s in cut], ["length", "idle"])
        night = datetime.datetime(2026, 11, 4, 23, 50).timestamp()
        frames = [self.frame(night + i * 2 * MIN, "tool_end", bash("make", "ok"), tool="Bash") for i in range(12)]
        cut = segments(frames, [], night + 60 * MIN)
        self.assertEqual([datetime.date.fromtimestamp(s["start"]).isoformat() for s in cut],
                         ["2026-11-04", "2026-11-05"])
        self.assertEqual(cut[0]["cut"], "midnight")

    def test_a_small_segment_joins_the_next_one_of_its_session(self):
        frames = [self.frame(T0, "tool_end", bash("ls", "a"), tool="Bash")] + self.work(T0 + 20 * MIN, 10)
        cut = segments(frames, [], T0 + 60 * MIN)
        self.assertEqual([(s["start"], len(s["frames"])) for s in cut], [(T0, 12)])

    def test_away_is_most_of_the_segment_spent_afk(self):
        frames = self.work(T0, 10)
        afk = [(T0, T0 + 8 * MIN, "afk"), (T0 + 8 * MIN, T0 + 10 * MIN, "not-afk")]
        self.assertTrue(segments(frames, afk, T0 + 60 * MIN)[0]["away"])
        self.assertFalse(segments(frames, [], T0 + 60 * MIN)[0]["away"])


if __name__ == "__main__":
    unittest.main()
