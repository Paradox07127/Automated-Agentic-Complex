"""Threads: the session summary rows of a time merged per session."""
import datetime
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sessions import threads  # noqa: E402

T0 = datetime.datetime(2026, 10, 24, 10, 0).timestamp()  # a local ten-minute boundary
SPAN = 600


def row(episode_id, session, yours, agent, away=0, status=None, progress=None, last=None, key=None):
    """The merge() row of the episode_id-th ten-minute span from T0; key: the session's, else its name."""
    return {"episode_id": episode_id, "session": session, "key": key or session, "start": T0 + (episode_id - 1) * SPAN,
            "end": T0 + episode_id * SPAN, "yours": yours, "agent": agent, "away": away, "status": status,
            "progress": progress, "last": last}


class MergeTest(unittest.TestCase):
    def test_one_session_adds_up_and_takes_the_latest_status_and_away_work_counts_apart(self):
        merged = threads.merge([
            row(2, "修端口", 1, 4, status="done", progress="修好了"),
            row(1, "修端口", 2, 3, status="ongoing", progress="跑测试", last="在跑。"),
            row(3, "写文档", 0, 5, away=1, status="done", progress="写完了", last="写完了。"),
            row(4, "写文档", 0, 2, status="ongoing", progress="改格式")])
        self.assertEqual([t["session"] for t in merged], ["修端口", "写文档"])
        port, docs = merged
        self.assertEqual((port["yours"], port["agent"]), (3, 7))
        self.assertEqual((port["yours_time"], port["agent_time"], port["away_time"]), (2 * SPAN, 2 * SPAN, 0))
        self.assertEqual((port["status"], port["progress"], port["last"]), ("done", "修好了", "在跑。"))
        self.assertEqual((port["first"], port["end"]), (T0, T0 + 2 * SPAN))
        self.assertEqual((docs["yours"], docs["agent"]), (0, 7))
        self.assertEqual((docs["yours_time"], docs["agent_time"], docs["away_time"]), (0, 2 * SPAN, SPAN))
        self.assertEqual((docs["status"], docs["progress"], docs["last"]), ("ongoing", "改格式", "写完了。"))

    def test_a_session_is_its_key_named_by_its_latest_row_and_one_name_of_two_keys_gets_their_heads(self):
        merged = threads.merge([row(1, "Endfield", 1, 0, key="aaaaaaaa-1"), row(2, "Endfield", 2, 0, key="bbbbbbbb-2")])
        self.assertEqual([(t["session"], t["yours"]) for t in merged],
                         [("Endfield (bbbbbbbb)", 2), ("Endfield (aaaaaaaa)", 1)])
        merged = threads.merge([row(1, "Endfield", 1, 0, key="aaaaaaaa-1"), row(3, "修端口", 0, 3, key="aaaaaaaa-1")])
        self.assertEqual([(t["session"], t["yours"], t["agent"]) for t in merged], [("修端口", 1, 3)])

    def test_more_of_yours_first_then_more_agent_work(self):
        merged = threads.merge([row(1, "甲", 1, 9), row(1, "乙", 2, 0), row(1, "丙", 1, 10)])
        self.assertEqual([t["session"] for t in merged], ["乙", "丙", "甲"])

    def test_ids_are_every_episode_of_the_session_oldest_first(self):
        merged = threads.merge([row(3, "甲", 0, 2, key="k1"), row(1, "甲", 1, 0, key="k1"), row(2, "乙", 1, 0),
                                row(4, "改名", 0, 1, away=1, key="k1")])
        self.assertEqual([(t["session"], t["ids"]) for t in merged], [("改名", [1, 3, 4]), ("乙", [2])])


if __name__ == "__main__":
    unittest.main()
