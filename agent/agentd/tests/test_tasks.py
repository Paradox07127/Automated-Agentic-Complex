from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from infra.store import open_store  # noqa: E402
from sessions.tasks import TaskLedger, check_verify, delivery_id  # noqa: E402


class TaskLedgerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = open_store(Path(self.tmp.name) / "agentd.sqlite")
        self.ledger = TaskLedger(self.db)

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def returned(self, task_id="d-1", verify_cmd=None):
        self.ledger.create(task_id, "claude", self.tmp.name, "改一下 README", "workspace_write", verify_cmd, now=1.0)
        self.ledger.transition(task_id, "approved", now=2.0)
        self.ledger.transition(task_id, "running", now=3.0, session_id="s-1")
        return self.ledger.transition(task_id, "returned", now=4.0)

    def events(self, task_id):
        return self.db.execute("SELECT seq, kind FROM task_events WHERE task_id = ? ORDER BY seq",
                               (task_id,)).fetchall()

    def test_a_task_without_verify_cmd_needs_review(self):
        row = self.returned()
        self.assertEqual((row["state"], row["session_id"], row["updated_at"]), ("returned", "s-1", 4.0))
        row = self.ledger.verify("d-1", now=5.0)
        self.assertEqual(row["state"], "needs_review")
        self.assertEqual(row["result"]["reason"], "no_verify_cmd")
        self.assertEqual([kind for _, kind in self.events("d-1")],
                         ["proposed", "approved", "running", "returned", "verifying", "needs_review"])
        self.assertEqual([seq for seq, _ in self.events("d-1")], [1, 2, 3, 4, 5, 6])

    def test_a_failing_verify_cmd_fails_the_task_with_the_output_tail(self):
        self.returned(verify_cmd="python3 -m pytest")
        calls = []

        def runner(argv, cwd, timeout):
            calls.append((argv, cwd, timeout))
            return 1, b"x" * 5000 + b"END"

        row = self.ledger.verify("d-1", runner=runner)
        self.assertEqual(calls, [(["python3", "-m", "pytest"], self.tmp.name, 120)])
        self.assertEqual(row["state"], "failed")
        self.assertEqual(row["result"]["exit_code"], 1)
        self.assertEqual(len(row["result"]["output_tail"]), 4096)
        self.assertTrue(row["result"]["output_tail"].endswith("END"))

    def test_a_passing_verify_cmd_succeeds(self):
        self.returned(verify_cmd="git status --short")
        row = self.ledger.verify("d-1", runner=lambda argv, cwd, timeout: (0, b"ok"))
        self.assertEqual((row["state"], row["result"]),
                         ("succeeded", {"exit_code": 0, "output_tail": "ok", "reason": None,
                                        "delivery_id": delivery_id("d-1")}))

    def test_every_verify_result_carries_the_tasks_stable_delivery_id(self):
        self.assertRegex(delivery_id("d-1"), r"^delivery-[a-f0-9]{32}$")
        self.assertNotEqual(delivery_id("d-1"), delivery_id("d-2"))
        self.returned("d-1")
        self.assertEqual(self.ledger.verify("d-1")["result"]["delivery_id"], delivery_id("d-1"))
        self.returned("d-2", verify_cmd="python3 -m pytest")

        def runner(argv, cwd, timeout):
            raise subprocess.TimeoutExpired(argv, timeout)
        self.ledger.verify("d-2", runner=runner)
        self.assertEqual(self.ledger.get("d-2")["result"]["delivery_id"], delivery_id("d-2"))

    def test_a_verify_cmd_that_times_out_fails_the_task(self):
        self.returned(verify_cmd="python3 -m pytest")

        def runner(argv, cwd, timeout):
            raise subprocess.TimeoutExpired(argv, timeout)

        row = self.ledger.verify("d-1", runner=runner)
        self.assertEqual(row["state"], "failed")
        self.assertEqual((row["result"]["exit_code"], row["result"]["reason"]), (None, "timeout"))

    def test_a_verify_cmd_that_cannot_start_fails_the_task(self):
        self.returned(verify_cmd="python3 -m pytest")

        def runner(argv, cwd, timeout):
            raise FileNotFoundError(argv[0])

        row = self.ledger.verify("d-1", runner=runner)
        self.assertEqual(row["state"], "failed")
        self.assertEqual((row["result"]["exit_code"], row["result"]["reason"]), (None, "not_started"))

    def test_restart_interrupts_running_tasks_once(self):
        self.ledger.create("d-1", "codex", self.tmp.name, "跑测试", "workspace_write")
        self.ledger.transition("d-1", "approved")
        self.ledger.transition("d-1", "running")
        self.assertEqual(self.ledger.recover(now=9.0), [("d-1", "interrupted")])
        self.assertEqual(self.ledger.get("d-1")["state"], "interrupted")
        self.assertEqual(self.ledger.recover(), [])

    def test_restart_interrupts_a_returned_task_before_its_verify(self):
        self.returned()
        self.assertEqual(self.ledger.recover(), [("d-1", "interrupted")])
        self.assertEqual(self.ledger.get("d-1")["state"], "interrupted")

    def test_restart_expires_tasks_not_yet_started(self):
        self.ledger.create("d-1", "codex", self.tmp.name, "a", "read_only")
        self.ledger.create("d-2", "codex", self.tmp.name, "b", "read_only")
        self.ledger.transition("d-2", "approved")
        self.assertEqual(sorted(self.ledger.recover()), [("d-1", "expired"), ("d-2", "expired")])

    def test_creating_the_same_task_twice_keeps_one_row(self):
        first = self.ledger.create("d-1", "claude", self.tmp.name, "一", "read_only", now=1.0)
        again = self.ledger.create("d-1", "claude", self.tmp.name, "二", "read_only", now=2.0)
        self.assertEqual(again, first)
        self.assertEqual(len(self.ledger.list()), 1)
        self.assertEqual(self.events("d-1"), [(1, "proposed")])

    def test_illegal_transitions_are_refused(self):
        self.ledger.create("d-1", "claude", self.tmp.name, "a", "read_only")
        with self.assertRaisesRegex(ValueError, "illegal_transition"):
            self.ledger.transition("d-1", "returned")
        self.returned("d-2", verify_cmd="git diff --stat")
        self.ledger.verify("d-2", runner=lambda argv, cwd, timeout: (0, b""))
        with self.assertRaisesRegex(ValueError, "illegal_transition"):
            self.ledger.transition("d-2", "running")
        self.assertEqual(self.ledger.get("d-2")["state"], "succeeded")

    def test_a_task_that_needs_review_is_settled_by_the_user(self):
        for task_id, verdict in (("d-1", "succeeded"), ("d-2", "failed")):
            with self.subTest(verdict=verdict):
                self.returned(task_id)
                self.ledger.verify(task_id)
                row = self.ledger.transition(task_id, verdict)
                self.assertEqual((row["state"], row["result"]["reason"]), (verdict, "no_verify_cmd"))
                with self.assertRaisesRegex(ValueError, "illegal_transition"):
                    self.ledger.transition(task_id, "succeeded")

    def test_list_is_newest_first(self):
        self.ledger.create("d-1", "claude", self.tmp.name, "a", "read_only", now=1.0)
        self.ledger.create("d-2", "claude", self.tmp.name, "b", "read_only", now=2.0)
        self.ledger.transition("d-1", "approved", now=3.0)
        self.assertEqual([t["task_id"] for t in self.ledger.list()], ["d-1", "d-2"])
        self.assertEqual([t["task_id"] for t in self.ledger.list(limit=1)], ["d-1"])

    def test_check_verify(self):
        self.assertIsNone(check_verify("read_only", None))
        self.assertIsNone(check_verify("workspace_write", ""))
        self.assertEqual(check_verify("read_only", "git diff --stat"), "git diff --stat")
        with self.assertRaisesRegex(ValueError, "invalid_verify_cmd"):
            check_verify("read_only", "pytest")
        with self.assertRaisesRegex(ValueError, "invalid_verify_cmd"):
            check_verify("workspace_write", "rm -rf ~")
        self.assertEqual(check_verify("workspace_write", "python3 -m pytest"), "python3 -m pytest")


if __name__ == "__main__":
    unittest.main()
