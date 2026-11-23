from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from traces.stage_times import KEEP, WINDOW, StageTimes  # noqa: E402


class StageTimesTest(unittest.TestCase):
    def setUp(self):
        self.now = 10_000.0
        self.stages = StageTimes(clock=lambda: self.now)

    def nodes(self):
        block = self.stages.diag()
        self.assertEqual(block["window_s"], WINDOW)
        return block["nodes"]

    def test_finished_turn_spans_give_their_node_the_median(self):
        for ms in (900, 3100, 1200):
            self.stages.event("model.finished", "ok", "line-1", ms, {})
        self.stages.event("speech.finished", "ok", "line-1", 640, {})
        self.stages.event("playback.ended", "ok", "line-1", 2400, {})
        self.stages.event("motion.ended", "ok", "line-1", 1200, {})
        self.assertEqual(self.nodes(), {"model": {"p50_ms": 1200, "n": 3}, "tts": {"p50_ms": 640, "n": 1},
                                        "play": {"p50_ms": 2400, "n": 1}, "motion": {"p50_ms": 1200, "n": 1}})

    def test_failed_cut_and_turnless_spans_do_not_count(self):
        self.stages.event("model.finished", "failed", "line-1", 50, {})
        self.stages.event("speech.finished", "cancelled", "line-1", 10, {})
        self.stages.event("playback.interrupted", "ok", "line-1", 300, {})
        self.stages.event("model.finished", "ok", None, 700, {})  # a vision or judge call outside any turn
        self.stages.event("model.started", "ok", "line-1", None, {})
        self.assertEqual(self.nodes(), {})

    def test_the_judge_reports_its_own_latency(self):
        self.stages.event("judge.decided", "ok", None, None, {"latency_ms": 410.4})
        self.stages.event("judge.decided", "failed", None, None, {"latency_ms": 9000.0, "failure_reason": "x"})
        self.assertEqual(self.nodes(), {"judge": {"p50_ms": 410, "n": 1}})

    def test_context_counts_from_the_input_or_the_settled_observation(self):
        self.stages.assembled([("input.received", 100.0)], 100.038)
        self.stages.assembled([("input.received", 100.0), ("observation.requested", 100.01),
                               ("observation.settled", 101.0)], 101.05)
        self.stages.assembled([("model.started", 100.0)], 101.0)  # no start to count from
        self.assertEqual(self.nodes(), {"ctx": {"p50_ms": 44, "n": 2}})

    def test_samples_older_than_the_window_drop_out(self):
        self.stages.event("model.finished", "ok", "line-1", 5000, {})
        self.now += WINDOW + 1
        self.stages.event("model.finished", "ok", "line-2", 1000, {})
        self.assertEqual(self.nodes(), {"model": {"p50_ms": 1000, "n": 1}})
        self.now += WINDOW + 1
        self.assertEqual(self.nodes(), {})

    def test_each_node_keeps_at_most_keep_samples(self):
        for i in range(KEEP + 10):
            self.stages.event("model.finished", "ok", "line-1", i, {})
        self.assertEqual(self.nodes()["model"]["n"], KEEP)


if __name__ == "__main__":
    unittest.main()
