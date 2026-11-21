"""observation.summary and the summaries Timeline keeps: stored, searched, and gone with their records."""
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import support
from support import deny_blacklist
from observation import summary  # noqa: E402
from observation.blacklist import Blacklist  # noqa: E402
from observation.timeline import SEGMENT_S, Timeline  # noqa: E402
from infra.store import open_store  # noqa: E402
from models.usage import OWN_HOUR_CAPS, UsageMeter  # noqa: E402

T0 = 1_800_000_000.0  # a segment start


def rec(ts, app="Code", kind="click", title="build.py"):
    return {"ts": ts, "kind": kind, "app": app, "bundle_id": f"x.{app}", "pid": 7, "window_id": 3, "window_title": title,
            "url_host": None, "target": None, "keys": None, "text": None, "tree": {"mode": "full", "text": "0 build ok"}}


def answer(title):
    return {"title": title, "description": "You ran the build.", "apps": ["Code"], "summary": "The build passed.",
            "prior": "", "threads": [{"name": "Build", "points": ["ran build.py"]}], "not_seen": []}


class SummaryTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "timeline.sqlite"
        self.blacklist = Blacklist(deny_blacklist(Path(tmp.name) / "blacklist.json"))
        self.timeline = Timeline(self.path, self.blacklist, clock=lambda: T0 + 3 * SEGMENT_S)
        self.addCleanup(self.timeline.close)
        self.asked = []

    def run_model(self, title):
        def run(instructions, evidence):
            self.asked.append(evidence)
            return answer(title)
        return run

    def summarize(self, segment, title, app="Code", **fields):
        self.timeline.ingest([{**rec(segment + i, app), **fields} for i in range(summary.MIN_RECORDS)])
        return summary.summarize(self.timeline, segment, self.run_model(title))

    def test_a_summary_is_stored_found_and_gone_when_deleted(self):
        text = self.summarize(T0, "SECRETWORD build")
        self.assertIn("# SECRETWORD build", text)
        self.assertEqual(self.timeline.search_summaries("secretword"), [{"segment": T0, "text": text}])
        self.assertIn("build ok", self.asked[0]["record"])
        self.assertTrue(self.timeline.delete_summary(T0))
        self.assertEqual(self.timeline.search_summaries("secretword"), [])
        on_disk = b"".join(p.read_bytes() for p in self.path.parent.glob("timeline.sqlite*")).lower()
        self.assertNotIn(b"secretword", on_disk)  # the index keeps its words lowercased

    def test_a_segment_of_few_records_is_not_summarized(self):
        self.timeline.ingest([rec(T0)])
        self.assertIsNone(summary.summarize(self.timeline, T0, self.run_model("x")))
        self.assertEqual(self.asked, [])

    def test_the_model_reads_the_two_latest_summaries_of_the_hour_before(self):
        for i, title in enumerate(("first", "second", "third")):
            self.summarize(T0 + i * SEGMENT_S, title)
        self.summarize(T0 + 3 * SEGMENT_S, "fourth")
        self.assertEqual([p.split("\n")[0] for p in self.asked[-1]["previous"]], ["# second", "# third"])

    def test_summaries_go_with_the_records_they_were_made_from(self):
        self.summarize(T0, "notes", app="Notes")
        self.summarize(T0 + SEGMENT_S, "code")
        self.timeline.delete_hidden(lambda w: w["app"] == "Notes")
        self.assertEqual([s["segment"] for s in self.timeline.search_summaries("build")], [T0 + SEGMENT_S])
        self.timeline.clear(since=T0 + SEGMENT_S + 5)
        self.assertEqual(self.timeline.search_summaries("build"), [])

    def test_a_revoke_drops_the_summaries_made_from_what_it_covers(self):
        label, typed, plain = T0 - 21 * SEGMENT_S, T0 - 14 * SEGMENT_S, T0 - 7 * SEGMENT_S  # none reads another
        self.summarize(label, "label", tree=None, target={"role": "AXStaticText", "title": "Deploy"})
        self.summarize(typed, "typed", kind="text_input", text="hello", tree=None)
        self.summarize(plain, "plain", tree=None)
        self.summarize(T0, "screen")
        self.summarize(T0 + SEGMENT_S, "after", tree=None)  # reads the screen summary before it
        self.timeline.clear_typed_text()
        self.assertEqual(self.timeline.summarized(), {label, plain, T0, T0 + SEGMENT_S})
        self.timeline.clear_trees()
        self.assertEqual(self.timeline.summarized(), {plain})


class Server:
    """What Summarizer reads of AgentdServer; run is the semantic run, answering for each segment."""

    def __init__(self, timeline, config, now, store):
        self.timeline, self.privacy_config, self.now = timeline, config, now
        self.resetting = self.closing = self.paused = False
        self.usage = UsageMeter(store, clock=self.clock)
        self.character_agent = SimpleNamespace(semantic=SimpleNamespace(run=self.run, usage=None))
        self.asked, self.during = [], None

    def clock(self):
        return self.now

    def observation_paused(self):
        return self.paused

    def run(self, purpose, instructions, evidence, *, validate_output):
        self.asked.append(purpose)
        self.usage.attempt(purpose, "admitted")  # as semantic.run counts it
        if self.during:
            self.during()
        value = answer(f"call {len(self.asked)} build")
        validate_output(value)
        return {"value": value}


class SummarizerTest(unittest.TestCase):
    def setUp(self):
        patch = mock.patch.object(summary, "CHECK_EVERY", 0)
        patch.start()
        self.addCleanup(patch.stop)
        tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.addCleanup(tmp.cleanup)
        self.config = Path(tmp.name) / "config.json"
        self.config.write_text(json.dumps({"observe_activity": True}), encoding="utf-8")
        now = T0 + 15 * SEGMENT_S + summary.SETTLE_S  # segment 14 ended SETTLE_S ago; segment 15 is open
        self.timeline = Timeline(Path(tmp.name) / "timeline.sqlite", Blacklist(deny_blacklist(Path(tmp.name) / "b.json")),
                                 clock=lambda: now)
        self.addCleanup(self.timeline.close)
        store = open_store(Path(tmp.name) / "agentd.sqlite")
        self.addCleanup(store.close)
        self.server = Server(self.timeline, self.config, now, store)
        self.summarizer = summary.Summarizer(self.server)

    def segments(self, *starts, records=summary.MIN_RECORDS):
        self.timeline.ingest([rec(start + i) for start in starts for i in range(records)])

    def drain(self):
        while True:
            self.summarizer.tick()
            if self.summarizer.thread is None or not self.summarizer.thread.is_alive():
                return
            self.summarizer.thread.join()

    def drained(self):
        for _ in range(40):  # each tick starts at most one call
            self.drain()
        return len(self.server.asked)

    def test_each_closed_segment_is_summarized_once_and_the_usage_meter_caps_the_hour(self):
        hour = OWN_HOUR_CAPS["observation_summary"]
        self.segments(*(T0 + i * SEGMENT_S for i in range(16)))
        self.segments(T0 - SEGMENT_S, records=summary.MIN_RECORDS - 1)
        self.assertEqual(self.drained(), hour)
        self.assertEqual(sorted(self.timeline.summarized()), [T0 + i * SEGMENT_S for i in range(hour)])
        self.assertEqual(self.summarizer.failures, {})  # a capped segment waits; it has not failed
        self.server.now += 3600  # segment 15 has closed meanwhile
        self.assertEqual(self.drained(), 16)
        self.assertEqual(self.drained(), 16)
        self.assertEqual(set(self.server.asked), {"observation_summary"})
        self.assertNotIn(T0 - SEGMENT_S, self.timeline.summarized())  # too few records

    def test_nothing_is_asked_while_activity_is_not_observed_or_observation_is_paused(self):
        self.segments(T0, T0 + 15 * SEGMENT_S)
        self.config.write_text(json.dumps({"observe_activity": False}), encoding="utf-8")
        self.assertEqual(self.drained(), 0)
        self.config.write_text(json.dumps({"observe_activity": True, "x": 1}), encoding="utf-8")
        self.server.paused = True
        self.assertEqual(self.drained(), 0)
        self.server.paused = False
        self.assertEqual(self.drained(), 1)  # control; segment 15 is still open
        self.assertEqual(self.timeline.summarized(), {T0})

    def test_a_summary_made_from_records_revoked_during_the_call_is_not_stored(self):
        self.segments(T0)
        self.server.during = self.timeline.clear_trees
        self.assertEqual(self.drained(), 1)
        self.assertEqual(self.timeline.summarized(), set())

    def test_a_failing_segment_is_left_alone_after_two_calls(self):
        self.segments(T0)

        def refuse():
            raise ValueError("semantic_incomplete")
        self.server.during = refuse
        self.assertEqual(self.drained(), summary.FAILURES)
        self.assertEqual(self.timeline.summarized(), set())

    def test_a_malformed_answer_is_refused(self):
        with self.assertRaises(ValueError):
            summary.check({**answer("x"), "threads": [{"name": "Build", "points": "ran build.py"}]})
        summary.check(answer("x"))  # control


if __name__ == "__main__":
    unittest.main()
