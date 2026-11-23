from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from character.proactive_log import ProactiveLog  # noqa: E402
from infra.store import open_store  # noqa: E402
from daemon.agentd_server import AgentdServer  # noqa: E402
from character.gate import Gate  # noqa: E402
from character.thoughts import Thoughts  # noqa: E402
from test_server import FakeMouth, KernelLines  # noqa: E402
from test_thoughts import FakeSemantic  # noqa: E402

NOW = 1792300000.0


class ProactiveLogTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.db = open_store(Path(tmp.name) / "agentd.sqlite")
        self.addCleanup(self.db.close)
        self.log = ProactiveLog(self.db)

    def shown(self, id="line", channel="line", at=NOW, reply=None, trigger="comment"):
        self.log.shown(id, channel, trigger, "subject", "text", "offer" if reply else None, reply, at)

    def outcome(self, id="line"):
        return self.db.execute("SELECT outcome, outcome_at FROM proactive_log WHERE id = ?", (id,)).fetchone()

    def test_said_marks_only_the_line_it_replies_to(self):
        self.shown()
        self.shown("other")
        self.shown("thought", "thought", reply="好，帮我看看")
        self.log.said("hello", {"kind": "line", "id": "line"}, now=NOW + 60)
        self.assertEqual(self.outcome(), ("replied", NOW + 60))
        self.assertEqual(self.outcome("other"), (None, None))
        self.assertEqual(self.outcome("thought"), (None, None))
        self.log.said("again", {"kind": "line", "id": "line"}, now=NOW + 61)
        self.assertEqual(self.outcome(), ("replied", NOW + 60))

    def test_said_without_reply_to_or_of_another_kind_marks_nothing(self):
        self.shown()
        self.shown("thought", "thought", reply="好，帮我看看")
        self.log.said("hello", now=NOW + 1)
        self.log.said("好，帮我看看", now=NOW + 2)
        self.log.said("hello", {"kind": "thought", "id": "line"}, now=NOW + 3)
        self.assertEqual(self.outcome(), (None, None))
        self.assertEqual(self.outcome("thought"), (None, None))

    def test_exact_reply_to_a_thought_accepts_it(self):
        self.shown("thought", "thought", reply="好，帮我看看")
        self.log.said("好，帮我看看", {"kind": "thought", "id": "thought"}, now=NOW + 120)
        self.assertEqual(self.outcome("thought"), ("accepted", NOW + 120))
        self.log.said("hello", {"kind": "thought", "id": "thought"}, now=NOW + 121)
        self.assertEqual(self.outcome("thought"), ("accepted", NOW + 120))

    def test_other_reply_to_a_thought_marks_it_replied(self):
        self.shown("thought", "thought", reply="好，帮我看看")
        self.log.said("别的回答", {"kind": "thought", "id": "thought"}, now=NOW + 1)
        self.assertEqual(self.outcome("thought"), ("replied", NOW + 1))

    def test_text_finds_a_shown_entry_by_kind_and_id(self):
        self.shown()
        self.shown("thought", "thought", reply="好")
        self.assertEqual(self.log.text("line", "line"), "text")
        self.assertEqual(self.log.text("thought", "thought"), "text")
        self.assertIsNone(self.log.text("thought", "line"))
        self.assertIsNone(self.log.text("line", "missing"))

    def test_feedback_and_stats_count_by_trigger(self):
        self.shown()
        self.log.said("hi", {"kind": "line", "id": "line"}, now=NOW + 1)
        self.shown("thought", "thought", reply="好", trigger="finished")
        self.log.said("好", {"kind": "thought", "id": "thought"}, now=NOW + 2)
        self.shown("vote", trigger="comment")
        self.log.feedback("vote", "dont_disturb", NOW + 3)
        self.shown("outside", at=NOW - 8 * 86400)
        self.shown("future", at=NOW + 10)
        self.assertEqual(self.log.stats(7, NOW + 3), {
            "comment": {"shown": 2, "replied": 1, "accepted": 0, "feedback": 1},
            "finished": {"shown": 1, "replied": 0, "accepted": 1, "feedback": 0}})
        self.assertEqual(self.outcome("vote"), ("dont_disturb", NOW + 3))
        self.log.feedback("unknown", "useful", NOW + 4)
        self.log.said("hello", {"kind": "line", "id": "vote"}, now=NOW + 4)
        self.assertEqual(self.outcome("vote"), ("dont_disturb", NOW + 3))

    def test_a_new_thought_marks_earlier_unanswered_thoughts_ignored(self):
        self.shown("t1", "thought", reply="好")
        self.shown("t2", "thought", reply="好")
        self.log.said("好", {"kind": "thought", "id": "t2"}, now=NOW + 1)
        self.shown()
        self.shown("t3", "thought", at=NOW + 10)
        self.assertEqual(self.outcome("t1"), ("ignored", NOW))
        self.assertEqual(self.outcome("t2"), ("accepted", NOW + 1))
        self.assertEqual(self.outcome("line"), (None, None))
        self.assertEqual(self.outcome("t3"), (None, None))
        self.shown("t3", "thought", at=NOW + 10)  # the same thought shown again is not ignored by itself
        self.assertEqual(self.outcome("t3"), (None, None))

    def test_ignore_marks_only_unanswered_entries(self):
        self.shown()
        self.shown("vote")
        self.log.feedback("vote", "less", NOW + 1)
        self.log.ignore("line", NOW + 61)
        self.log.ignore("vote", NOW + 61)
        self.assertEqual(self.outcome(), ("ignored", NOW + 61))
        self.assertEqual(self.outcome("vote"), ("less", NOW + 1))

    def test_ignore_before_marks_old_unanswered_entries_of_a_channel(self):
        self.shown("old", "thought", at=NOW - 700)
        self.shown()  # a line keeps its own response window
        self.shown("new", "thought", at=NOW - 100)  # the new one marks "old" itself; reset it to test ignore_before
        self.db.execute("UPDATE proactive_log SET outcome = NULL, outcome_at = NULL")
        self.log.ignore_before("thought", NOW - 600, NOW)
        self.assertEqual(self.outcome("old"), ("ignored", NOW))
        self.assertEqual(self.outcome("new"), (None, None))
        self.assertEqual(self.outcome(), (None, None))

    def test_outcomes_lists_the_newest_thoughts_of_a_trigger(self):
        for i in range(7):
            self.shown(f"t{i}", "thought", at=NOW + i, trigger="finished")
        self.shown("other", "thought", at=NOW + 8, trigger="error")
        self.shown("line", at=NOW + 9, trigger="finished")
        self.log.feedback("t6", "dismissed", NOW + 10)
        self.assertEqual(self.log.outcomes("finished", 5), ["dismissed", "ignored", "ignored", "ignored", "ignored"])
        self.assertEqual(self.log.outcomes("error", 5), [None])

    def test_entry_names_the_channel_and_outcome_of_an_id(self):
        self.shown()
        self.shown("thought", "thought")
        self.log.feedback("thought", "useful", NOW + 1)
        self.assertEqual(self.log.entry("line"), ("line", None))
        self.assertEqual(self.log.entry("thought"), ("thought", "useful"))
        self.assertIsNone(self.log.entry("missing"))

    def test_the_less_factor_starts_at_one_and_persists(self):
        self.assertEqual(self.log.less(), 1)
        self.log.set_less(2.25)
        self.assertEqual(ProactiveLog(self.db).less(), 2.25)

    def test_prune_keeps_thirty_day_boundary(self):
        self.shown("old", at=NOW - 30 * 86400 - 1)
        self.shown("boundary", at=NOW - 30 * 86400)
        self.log.prune(NOW)
        self.assertEqual(self.db.execute("SELECT id FROM proactive_log").fetchall(), [("boundary",)])


class ProactiveLoggingTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        with patch.object(AgentdServer, "server_bind"), patch.object(AgentdServer, "server_activate"):
            self.server = AgentdServer(("127.0.0.1", 48810), "hook", "ui")
        self.addCleanup(self.server.server_close)
        self.server.mouth = FakeMouth(["好久", "没动了。"])
        self.server.character_agent = KernelLines(self.server)
        db = open_store(Path(tmp.name) / "agentd.sqlite")
        self.addCleanup(db.close)
        self.server.proactive_log = ProactiveLog(db)

    def test_shown_line_feedback_and_say_are_logged(self):
        self.server._proactive_lines.append("logged")
        self.server._run_line("logged", "prompt", threading.Event(), self.server.turn_generation,
                              source="proactive", reason={"kind": "stuck", "code": "stuck"}, prepared=self.server.mouth)
        db = self.server.proactive_log.db
        row = db.execute("SELECT channel, trigger, text, outcome FROM proactive_log WHERE id = 'logged'").fetchone()
        self.assertEqual(row, ("line", "stuck", "好久没动了。", None))
        self.server.feedback("logged", "useful")
        self.assertEqual(db.execute("SELECT outcome FROM proactive_log WHERE id = 'logged'").fetchone(), ("useful",))
        thoughts = Thoughts(Gate(enabled=True), self.server._proactive_publish, FakeSemantic(),
                            spawn=lambda f: f())
        thoughts.notice("finished")
        thought = thoughts.latest()
        row = db.execute("SELECT channel, trigger, text, offer, reply FROM proactive_log WHERE id = ?",
                         (thought["id"],)).fetchone()
        self.assertEqual(row, ("thought", "finished", thought["text"], thought["offer"], thought["reply"]))
        self.server.say(thought["reply"])
        self.assertEqual(db.execute("SELECT outcome FROM proactive_log WHERE id = ?", (thought["id"],)).fetchone(),
                         (None,))
        self.server.say(thought["reply"], reply_to={"kind": "thought", "id": thought["id"]})
        self.assertEqual(db.execute("SELECT outcome FROM proactive_log WHERE id = ?", (thought["id"],)).fetchone(),
                         ("accepted",))

    def test_feedback_takes_a_thought_id_and_the_first_vote_wins(self):
        from unittest.mock import Mock
        self.server.proactive = Mock()
        db = self.server.proactive_log.db
        self.server.proactive_log.shown("t1", "thought", "finished", None, "想法", None, None, 1.0)
        self.assertTrue(self.server.feedback("t1", "less"))
        self.assertTrue(self.server.feedback("t1", "dismissed"))
        self.server.proactive.feedback.assert_called_once_with("t1", "less", False, "thought")
        self.assertEqual(db.execute("SELECT outcome FROM proactive_log WHERE id = 't1'").fetchone(), ("less",))
        self.server.proactive_log.shown("t2", "thought", "finished", None, "又一个", None, None, 2.0)
        self.assertEqual(db.execute("SELECT outcome FROM proactive_log WHERE id = 't1'").fetchone(), ("less",))
        self.server.proactive_log.shown("t3", "thought", "finished", None, "再一个", None, None, 3.0)
        self.assertTrue(self.server.feedback("t2", "useful"), "an ignored thought still takes an explicit vote")
        self.assertEqual(db.execute("SELECT outcome FROM proactive_log WHERE id = 't2'").fetchone(), ("useful",))
        self.assertFalse(self.server.feedback("unknown", "useful"))
        self.assertFalse(self.server.feedback("t3", "ignored"))


if __name__ == "__main__":
    unittest.main()
