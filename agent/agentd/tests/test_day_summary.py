import datetime
import json
import subprocess
from pathlib import Path
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sessions.day_summary import project_root, segments, summarize  # noqa: E402

DAY = "2026-10-22"
COMMAND = "rm -rf /Users/me/secret-dir"


def record(name, session, timestamp="2026-10-22T05:00:00Z", **attributes):
    return {"timestamp": timestamp, "event_name": name, "severity_text": "INFO",
            "attributes": {"session.id": session, **attributes}}


def stamp(hour, minute=0):
    """Local wall time on DAY -> (ISO timestamp with offset, epoch seconds)."""
    at = datetime.datetime(2026, 10, 22, hour, minute).astimezone()
    return at.isoformat(), at.timestamp()


class DaySummaryTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.write("-Users-me-repo", DAY, "S1.jsonl", [
            record("session.start", "S1"),
            record("agent.end", "S1", **{"agent.type": "worker", "state": "done"}),
            record("agent.end", "S1", **{"agent.type": "worker", "state": "done"}),
            record("agent.end", "S1", **{"agent.type": "researcher", "state": "aborted"}),
            record("gate.result", "S1", command=COMMAND, outcome="fail", fail=2, **{"pass": 1}),
            record("gate.result", "S1", command=COMMAND, outcome="pass", fail=0, **{"pass": 3}),
            record("guard.block", "S1", tool="Bash", target=COMMAND, decision="deny", **{"rule.id": "secret-file"}),
        ])
        self.write("-Users-me-repo", DAY, "S2.jsonl", [
            record("session.start", "S2"),
            record("gate.result", "S2", command=COMMAND, outcome="pass"),
            record("gate.result", "S2", command=COMMAND, outcome="fail", fail=1),
            record("guard.block", "S2", tool="Bash", target=COMMAND, decision="deny"),
        ])
        self.write("-Users-me-other", DAY, "S3.agent.jsonl", ["not json", record("session.start", "S3")])
        self.write("-Users-me-repo", "2026-10-21", "S0.jsonl", [record("session.start", "S0"),
                                                                 record("guard.block", "S0", target=COMMAND)])
        self.registry = {"sessions": [
            {"display_session": "claude:A", "cwd": "/w/repo-x", "effective_state": "awaiting_approval",
             "source": "claude", "pending_approvals": []},
            {"display_session": "codex:B", "cwd": None, "effective_state": "awaiting_input"},
            {"display_session": "claude:C", "cwd": "/w/busy", "effective_state": "running_tool"}], "outcomes": []}
        noon = time.mktime(datetime.datetime(2026, 10, 22, 12).timetuple())
        self.own = [{"session_id": "own:1", "cwd": "/w/own-y", "title": f"run {COMMAND}", "state": "awaiting_input",
                     "started_at": noon, "updated_at": noon},
                    {"session_id": "own:2", "cwd": "/w/own-z", "title": "old", "state": "done",
                     "started_at": noon - 86400, "updated_at": noon - 86400}]

    def write(self, project, day, name, records):
        folder = self.root / project / day
        folder.mkdir(parents=True, exist_ok=True)
        with open(folder / name, "w", encoding="utf-8") as stream:
            for r in records:
                stream.write((r if isinstance(r, str) else json.dumps(r)) + "\n")

    def test_counts_names_and_nothing_else(self):
        summary = summarize(self.root, DAY, self.registry, self.own)
        self.assertEqual(summary, {
            "sessions": 3, "agents_done": 2, "agents_failed": 1, "gates_green": 1, "gates_red": 1,
            "guard_blocks": 2, "own_sessions": 1,
            "waiting": [{"name": "repo-x", "state": "awaiting_approval", "word": "waiting for confirmation in Claude Code"},
                        {"name": "codex:B", "state": "awaiting_input"},
                        {"name": "own-y", "state": "awaiting_input"}]})
        shown = json.dumps(summary, ensure_ascii=False)
        for secret in ("rm -rf", "secret", "run ", "Bash", "worker"):
            self.assertNotIn(secret, shown)

    def test_a_session_id_that_is_no_string_counts_as_a_line_without_one(self):
        self.write("-Users-me-repo", DAY, "S9.jsonl", [record("session.start", ["S9"]),
                                                       record("gate.result", {"id": "S9"}, outcome="pass")])
        summary = summarize(self.root, DAY, self.registry, self.own)
        self.assertEqual((summary["sessions"], summary["gates_green"]), (4, 2))

    def test_a_missing_ledger_is_an_empty_day(self):
        summary = summarize(self.root / "nowhere", DAY, {"sessions": [], "outcomes": []}, [])
        self.assertEqual(summary, {"sessions": 0, "agents_done": 0, "agents_failed": 0, "gates_green": 0,
                                   "gates_red": 0, "guard_blocks": 0, "own_sessions": 0, "waiting": []})


class SegmentsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.t = {h: stamp(h) for h in (8, 9, 10, 11, 12, 13)}

    def write(self, project, day, name, records):
        DaySummaryTest.write(self, project, day, name, records)

    def at(self, hour):
        return self.t[hour][0]

    def test_groups_projects_with_their_own_sessions_by_earliest_start(self):
        self.write("-w-alpha", DAY, "A1.jsonl", [
            record("session.start", "A1", self.at(10)),
            record("agent.end", "A1", self.at(11), state="done"),
            record("agent.end", "A1", self.at(11), state="done"),
            record("agent.end", "A1", self.at(11), state="aborted"),
            record("gate.result", "A1", self.at(11), outcome="fail"),
            record("gate.result", "A1", self.at(12), outcome="pass"),
            record("guard.block", "A1", self.at(12), target=COMMAND),
        ])
        self.write("-w-beta", DAY, "B1.jsonl", [record("session.start", "B1", self.at(9)),
                                                record("agent.end", "B1", self.at(13), state="done")])
        own = [{"session_id": "own:1", "cwd": "/w/alpha", "title": "fix it", "state": "awaiting_input",
                "last_line": "x" * 300, "started_at": self.t[8][1], "updated_at": self.t[13][1]}]
        result = segments(self.root, DAY, own)
        self.assertEqual(result, [
            {"project": "-w-alpha", "name": "alpha",
             "sessions": [{"session_id": "A1", "started_at": self.t[10][1], "ended_at": self.t[12][1],
                           "agents_done": 2, "agents_failed": 1,
                           "last_gate": {"at": self.t[12][1], "passed": True}, "guard_blocks": 1}],
             "own": [{"session_id": "own:1", "title": "fix it", "state": "awaiting_input",
                      "last_line": "x" * 200, "started_at": self.t[8][1], "updated_at": self.t[13][1],
                      "task_id": None}]},
            {"project": "-w-beta", "name": "beta",
             "sessions": [{"session_id": "B1", "started_at": self.t[9][1], "ended_at": self.t[13][1],
                           "agents_done": 1, "agents_failed": 0, "last_gate": None, "guard_blocks": 0}],
             "own": []}])

    def test_last_gate_is_the_latest_then_the_later_line(self):
        self.write("-w-alpha", DAY, "A1.jsonl", [
            record("session.start", "A1", self.at(10)),
            record("gate.result", "A1", self.at(12), outcome="pass"),
            record("gate.result", "A1", self.at(12), outcome="fail"),
        ])
        self.write("-w-alpha", DAY, "A1.agent.jsonl", [record("gate.result", "A1", self.at(11), outcome="pass")])
        [group] = segments(self.root, DAY, [])
        self.assertEqual(group["sessions"][0]["last_gate"], {"at": self.t[12][1], "passed": False})

    def test_waiting_own_session_today_shows_and_yesterdays_does_not(self):
        noon = self.t[12][1]
        own = [{"session_id": "own:1", "cwd": "/w/gamma", "title": "t", "state": "awaiting_input",
                "last_line": None, "started_at": noon, "updated_at": noon, "task_id": "T-7"},
               {"session_id": "own:2", "cwd": "/w/gamma", "title": "old", "state": "awaiting_input",
                "last_line": "old", "started_at": noon - 86400, "updated_at": noon}]
        self.assertEqual(segments(self.root / "nowhere", DAY, own), [
            {"project": "-w-gamma", "name": "gamma", "sessions": [],
             "own": [{"session_id": "own:1", "title": "t", "state": "awaiting_input", "last_line": None,
                      "started_at": noon, "updated_at": noon, "task_id": "T-7"}]}])

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_an_own_session_in_a_worktree_joins_the_project_of_its_main_tree(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        repo, git = Path(tmp.name).resolve() / "repo", ["git", "-c", "user.name=t", "-c", "user.email=t@t"]
        worktree = repo / ".claude" / "worktrees" / "w1"
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        subprocess.run([*git, "-C", str(repo), "commit", "-q", "--allow-empty", "-m", "x"], check=True)
        subprocess.run(["git", "-C", str(repo), "worktree", "add", "-q", str(worktree)], check=True)
        project = str(repo).replace("/", "-")  # the harness keys a worktree's ledger by its main tree
        self.write(project, DAY, "A1.jsonl", [record("session.start", "A1", self.at(10))])
        own = [{"session_id": "own:1", "cwd": str(worktree), "title": "t", "state": "done", "last_line": None,
                "started_at": self.t[11][1], "updated_at": self.t[11][1]}]
        for removed in (False, True):  # a worktree is often removed once its branch merged
            with self.subTest(removed=removed):
                if removed:
                    subprocess.run(["git", "-C", str(repo), "worktree", "remove", str(worktree)], check=True)
                    project_root.cache_clear()
                [group] = segments(self.root, DAY, own)
                self.assertEqual((group["project"], group["name"], [r["session_id"] for r in group["sessions"]],
                                  [o["session_id"] for o in group["own"]]), (project, "repo", ["A1"], ["own:1"]))

    def test_bad_lines_and_unreadable_files_are_skipped(self):
        self.write("-w-alpha", DAY, "A1.jsonl", [
            "not json", "[1, 2]", json.dumps({"event_name": 3}),
            json.dumps({"event_name": "agent.end", "timestamp": "yesterday", "attributes": {"session.id": "A1"}}),
            record("session.start", "A1", self.at(10)),
        ])
        (self.root / "-w-alpha" / DAY / "broken.jsonl").mkdir()
        [group] = segments(self.root, DAY, [])
        self.assertEqual(group["sessions"], [
            {"session_id": "A1", "started_at": self.t[10][1], "ended_at": self.t[10][1], "agents_done": 0,
             "agents_failed": 1, "last_gate": None, "guard_blocks": 0}])


if __name__ == "__main__":
    unittest.main()
