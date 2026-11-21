"""tools/voice_timing.py: the per-segment latency of voice turns, from the release of the talk key to playback."""
import datetime
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from infra.store import open_store  # noqa: E402
from test_trace_server import TraceServerCase  # noqa: E402
from test_turn import relay_for, wait_for  # noqa: E402
from tools import voice_timing  # noqa: E402
from traces.trace_store import TraceStore, new_span_id, new_trace_id  # noqa: E402

TOOL = Path(__file__).resolve().parents[1] / "tools" / "voice_timing.py"
ORDER = ["input.received", "model.started", "model.first_token", "speech.requested", "speech.first_audio",
         "playback.started"]


def row(table, segment):
    """The cells of the table line of segment (its number as a string)."""
    return next(line.split() for line in table.splitlines() if line.split()[:1] == [segment])


def playback_started(trace_id, turn_id, generation, speech_id, seq=1, wall=None):
    """playback.started as the renderer forwards it through POST /trace/events."""
    wall = wall or datetime.datetime.now().astimezone().isoformat(timespec="milliseconds")
    return {"v": 1, "event_id": str(uuid.uuid4()), "trace_id": trace_id, "turn_id": turn_id,
            "turn_generation": generation, "span_id": new_span_id(), "parent_span_id": None, "causation_id": None,
            "producer": "avatar", "producer_epoch": 2, "seq": seq, "kind": "playback.started", "t_wall": wall,
            "t_mono_ms": 5, "status": "ok", "attrs": {"speech_id": speech_id, "clause_id": None}}


class VoiceTurnTraceTest(TraceServerCase):
    def test_a_voiced_turn_traces_each_segment_end_in_order(self):
        tts, relay = relay_for(self)
        relay.on_event = self.server.on_speech_event
        self.server.speech = relay
        prepare = self.server.character_agent.prepare

        def traced(line_id, text, cancel, generation, source, trace, **options):
            """The model span the character agent's prepare traces."""
            span = new_span_id()
            self.server._step(trace, "model.started", span, attrs={"model": "m", "call": "character_agent"})
            self.server._step(trace, "model.first_token", span)
            self.server._step(trace, "model.finished", span, status="ok", duration_ms=0, attrs={
                "model": "m", "input_tokens": 0, "output_tokens": 0, "stop_reason": "end_turn"})
            return prepare(line_id, text, cancel, generation, source, trace, **options)
        self.server.character_agent.prepare = traced
        released = int(time.time() * 1000) - 500
        timing = {"pressed_ms": released - 1000, "released_ms": released, "final_ms": released + 200}
        conn, response = self.open_feed()
        status, said = self.request("POST", "/say", {"text": "你好", "source": "voice", "voice_timing": timing})
        self.assertEqual(status, 202)
        self.lines_until_final(response)
        conn.close()
        self.assertTrue(wait_for(lambda: self.of(self.events(said["trace_id"]), "speech.first_audio")))
        [requested] = self.of(self.events(said["trace_id"]), "speech.requested")
        posted = playback_started(said["trace_id"], said["line_id"], said["generation"],
                                  requested["attrs"]["speech_id"])
        self.assertEqual(self.request("POST", "/trace/events", {"events": [posted]})[1]["accepted"], 1)
        events = self.events(said["trace_id"])
        self.assertEqual([e["kind"] for e in events if e["kind"] in ORDER], ORDER)
        self.assertEqual(self.server.trace_errors, 0)
        table = voice_timing.report(self.data.name)
        for segment in "123456":
            self.assertEqual(row(table, segment)[3], "1", table)


class Clock:
    """Whole milliseconds, a little past each so that neither clock of TraceStore truncates to the one before."""
    def __init__(self, ms):
        self.ms = ms

    def __call__(self):
        return self.ms / 1000 + 0.0004


class VoiceTimingTableTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.addCleanup(self.dir.cleanup)
        self.clock = Clock(1_760_000_000_000)
        self.db = open_store(Path(self.dir.name) / "agentd.sqlite")
        self.addCleanup(self.db.close)
        self.store = TraceStore(self.db, producer_epoch=1, clock=self.clock, mono=self.clock)
        self.played = 0

    def turn(self, gaps, source="voice", timing=True):
        """One turn whose six segments last gaps[n] ms; None leaves the event that ends a segment out."""
        trace, root, model, speech = new_trace_id(), new_span_id(), new_span_id(), "s" + new_span_id()
        released = self.clock.ms
        ids = {"turn_id": "t" + root, "turn_generation": 1}
        attrs = {"source": source}
        if timing:
            attrs["voice_timing"] = {"pressed_ms": released - 900, "released_ms": released, "final_ms": released + 1}

        def at(n, kind, span, **fields):
            if gaps[n] is not None:
                self.clock.ms += gaps[n]
                self.store.emit(kind, trace, span_id=span, parent_span_id=None if span == root else root, **ids,
                                **fields)

        at(0, "input.received", root, attrs={**attrs, "text": None})
        at(1, "model.started", model, attrs={"model": "m", "call": "character_agent"})
        at(2, "model.first_token", model)
        at(3, "speech.requested", speech[1:], attrs={"speech_id": speech, "clause_id": None, "line_id": "l",
                                                     "text": {"len": 0, "head": ""}})
        at(4, "speech.first_audio", speech[1:], producer="tts", attrs={"speech_id": speech, "clause_id": None})
        if gaps[5] is not None:
            self.clock.ms += gaps[5]
            self.played += 1
            wall = datetime.datetime.fromtimestamp(self.clock(), datetime.timezone.utc).astimezone()
            event = playback_started(trace, ids["turn_id"], 1, speech, self.played,
                                     wall.isoformat(timespec="milliseconds"))
            self.assertEqual(self.store.ingest([event])["accepted"], 1)
        self.clock.ms += 60_000

    def test_each_segment_has_the_median_p90_and_max_of_the_voice_turns(self):
        self.turn([800, 30, 1200, 400, 600, 50])
        self.turn([9999, 9999, 9999, 9999, 9999, 9999], source="text")
        self.turn([1000, 40, 1500, 500, 900, 70])
        self.turn([1200, 20, 2000, 300, 700, 60])
        table = voice_timing.report(self.dir.name)
        expected = {"1": (3, 1000, 1200), "2": (3, 30, 40), "3": (3, 1500, 2000), "4": (3, 400, 500),
                    "5": (3, 700, 900), "6": (3, 60, 70)}
        for segment, (count, median, most) in expected.items():
            cells = row(table, segment)
            self.assertEqual(cells[3:], [str(count), str(median), str(most), str(most)], table)
        newest = voice_timing.report(self.dir.name, last=2)
        self.assertEqual(row(newest, "2")[3:], ["2", "30", "40", "40"], newest)

    def test_a_segment_no_turn_traced_both_ends_of_has_no_data(self):
        self.turn([800, 30, 1200, 400, 600, None], timing=False)
        self.turn([900, 40, 1300, 500, 700, None], timing=False)
        self.db.commit()
        done = subprocess.run([sys.executable, "-I", str(TOOL), "--state-dir", self.dir.name, "--last", "5"],
                              capture_output=True, encoding="utf-8", timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr)
        for segment in "16":
            self.assertEqual(row(done.stdout, segment)[3:], ["没有数据"], done.stdout)
        self.assertEqual(row(done.stdout, "5")[3:], ["2", "650", "700", "700"], done.stdout)


if __name__ == "__main__":
    unittest.main()
