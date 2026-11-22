import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from traces.trace_format import validate_event, validate_stream  # noqa: E402

SAMPLE = Path(__file__).with_name("trace-sample.ndjson")
SCRIPT = Path(__file__).resolve().parents[1] / "traces" / "trace_format.py"


def sample():
    return [json.loads(line) for line in SAMPLE.read_text(encoding="utf-8").splitlines() if line.strip()]


class TraceFormatTest(unittest.TestCase):
    def test_sample_is_valid_and_covers_one_typed_turn_to_playback_end(self):
        events = sample()
        self.assertEqual(validate_stream(events), [])
        kinds = [e["kind"] for e in events]
        for kind in ("input.received", "model.finished", "speech.first_audio", "playback.ended", "gate.decided"):
            self.assertIn(kind, kinds)
        self.assertEqual({e["producer"] for e in events}, {"agentd", "tts", "avatar"})

    def test_script_exit_codes(self):
        ok = subprocess.run([sys.executable, "-I", str(SCRIPT), str(SAMPLE)], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual((ok.returncode, ok.stdout.strip().splitlines()[-1]), (0, "27 events, 0 errors"))
        events = sample()
        del events[0]["trace_id"]
        with tempfile.NamedTemporaryFile("w", suffix=".ndjson", delete=False, encoding="utf-8") as f:
            f.write("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in events))
        self.addCleanup(Path(f.name).unlink)
        bad = subprocess.run([sys.executable, "-I", str(SCRIPT), f.name], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(bad.returncode, 1)
        self.assertIn("missing trace_id", bad.stdout)

    def broken(self, index, change):
        event = copy.deepcopy(sample()[index])
        change(event)
        return validate_event(event)

    def test_each_event_rule_rejects(self):
        cases = {
            "missing producer": (0, lambda e: e.pop("producer")),
            "bad producer": (0, lambda e: e.update(producer="unity")),
            "unknown field color": (0, lambda e: e.update(color=1)),
            "bad kind": (0, lambda e: e.update(kind="input.typed")),
            "bad t_wall": (0, lambda e: e.update(t_wall="2026-10-19 09:12:03")),
            "bad seq": (0, lambda e: e.update(seq=0)),
            "turn_id and turn_generation": (0, lambda e: e.update(turn_generation=None)),
            "ends a span and needs duration_ms": (5, lambda e: e.pop("duration_ms")),
            "does not end a span": (0, lambda e: e.update(duration_ms=3)),
            "needs attrs.source": (0, lambda e: e["attrs"].pop("source")),
            "bad attrs.text": (0, lambda e: e["attrs"]["text"].update(head="一二三四五六七八九")),
            "bad text.text": (0, lambda e: e["text"].update(text="别的话")),
            "bad status": (0, lambda e: e.update(status="done")),
        }
        for expected, (index, change) in cases.items():
            with self.subTest(expected):
                self.assertTrue(any(expected in error for error in self.broken(index, change)),
                                self.broken(index, change))

    def test_judge_failure_reason_is_optional_and_sanitized(self):
        event = copy.deepcopy(sample()[0])
        event.pop("text", None)
        event.update(kind="judge.decided", attrs={"backend": "character_agent", "answers": []})
        self.assertEqual(validate_event(event), [])
        event.update(status="failed")
        event["attrs"].update(failure_reason="decision_rate_limited")
        self.assertEqual(validate_event(event), [])
        event["attrs"]["failure_reason"] = "sensitive private exception"
        self.assertTrue(any("bad attrs.failure_reason" in e for e in validate_event(event)))

    def test_local_motion_has_no_behavior_id(self):
        # Click reactions, idle fidgets and talk gestures start in the renderer without an agentd behavior.
        for index in (10, 13):
            event = copy.deepcopy(sample()[index])
            event["attrs"]["behavior_id"] = None
            self.assertEqual(validate_event(event), [])

    def test_desktop_lease_events(self):
        event = copy.deepcopy(sample()[13])
        event.pop("duration_ms", None)
        event.update(kind="desktop.lease_opened", attrs={"run_id": "r1", "session_id": "own:r1"})
        self.assertEqual(validate_event(event), [])
        event.update(kind="desktop.lease_released", attrs={"run_id": "r1", "session_id": "own:r1", "reason": "run_end"})
        self.assertEqual(validate_event(event), [])

    def test_tool_verdict_event(self):
        event = copy.deepcopy(sample()[13])
        event.pop("duration_ms", None)
        event.update(kind="tool.verdict", attrs={"tool": "desktop_act", "method": "native_panel", "dangerous": False,
                                                 "rule": None, "reason": "window_granted"})
        self.assertEqual(validate_event(event), [])

    def test_interrupted_playback_carries_planned_ms(self):
        event = copy.deepcopy(sample()[13])
        event.update(kind="playback.interrupted",
                     attrs={"speech_id": "s1", "clause_id": None, "reason": "barge_in", "planned_ms": 2400})
        self.assertEqual(validate_event(event), [])
        event["attrs"]["planned_ms"] = None
        self.assertEqual(validate_event(event), [])
        del event["attrs"]["planned_ms"]
        self.assertTrue(any("needs attrs.planned_ms" in e for e in validate_event(event)))
        event["attrs"]["planned_ms"] = -1
        self.assertTrue(any("bad attrs.planned_ms" in e for e in validate_event(event)))

    def test_playback_buffering_resumed_and_degraded(self):
        # C3 v10 rule 23: the renderer's buffering, resumed and degraded receipts go into the trace as their own kinds.
        base = copy.deepcopy(sample()[13])
        base.pop("duration_ms")
        for kind, extra in (("playback.buffering", {}), ("playback.resumed", {}),
                            ("playback.degraded", {"reason": "pcm_length_mismatch"})):
            with self.subTest(kind):
                event = {**base, "kind": kind, "attrs": {"speech_id": "s1", "clause_id": None, **extra}}
                self.assertEqual(validate_event(event), [])
        event = {**base, "kind": "playback.degraded", "attrs": {"speech_id": "s1", "clause_id": None}}
        self.assertTrue(any("needs attrs.reason" in e for e in validate_event(event)))

    def test_proactive_feedback(self):
        event = copy.deepcopy(sample()[15])
        event.update(kind="proactive.feedback", attrs={"line_id": "a1b2c3d4e5f6", "value": "dont_disturb"})
        self.assertEqual(validate_event(event), [])
        event["attrs"]["value"] = "meh"
        self.assertTrue(any("bad attrs.value" in e for e in validate_event(event)))
        del event["attrs"]["value"]
        self.assertTrue(any("needs attrs.value" in e for e in validate_event(event)))

    def test_judge_decided_accepts_each_decision_source(self):
        event = copy.deepcopy(sample()[15])
        for backend in ("rules", "haiku", "character_agent"):
            event.update(kind="judge.decided", attrs={"backend": backend, "answers": []})
            self.assertEqual(validate_event(event), [], backend)
        event["attrs"]["backend"] = "gpt"
        self.assertTrue(any("bad attrs.backend" in e for e in validate_event(event)))

    def test_summary_requested_and_finished(self):
        base = copy.deepcopy(sample()[15])
        base.pop("duration_ms", None)
        requested = {**base, "kind": "summary.requested", "attrs": {"run_id": "ab12", "kind": "episode"}}
        self.assertEqual(validate_event(requested), [])
        finished = {**base, "kind": "summary.finished", "duration_ms": 900, "status": "failed",
                    "attrs": {"run_id": "ab12", "kind": "facts", "outcome": "model_error"}}
        self.assertEqual(validate_event(finished), [])
        for outcome in ("ok", "invalid", "skipped"):
            self.assertEqual(validate_event({**finished, "attrs": {**finished["attrs"], "outcome": outcome}}), [])
        self.assertTrue(any("needs attrs.run_id" in e for e in validate_event({**requested, "attrs": {"kind": "state"}})))
        self.assertTrue(any("bad attrs.kind" in e
                            for e in validate_event({**requested, "attrs": {"run_id": "ab12", "kind": "chat"}})))
        self.assertTrue(any("bad attrs.outcome" in e
                            for e in validate_event({**finished, "attrs": {**finished["attrs"], "outcome": "x"}})))
        self.assertTrue(any("needs duration_ms" in e
                            for e in validate_event({k: v for k, v in finished.items() if k != "duration_ms"})))

    def test_companion_ui_marks(self):
        base = copy.deepcopy(sample()[15])
        base.pop("duration_ms", None)
        for kind in ("ui.submitted", "ui.ack", "ui.first_text"):
            with self.subTest(kind):
                self.assertEqual(validate_event({**base, "kind": kind, "producer": "companion", "attrs": {}}), [])

    def test_the_motion_lane_kinds(self):
        lane = sample()[16:]
        self.assertEqual([e["kind"] for e in lane],
                         ["signal.changed", "stage.changed", "motion.chosen", "behavior.dispatched", "motion.state",
                          "behavior.receipt", "motion.chosen", "behavior.refused", "motion.state", "motion.chosen",
                          "behavior.refused"])
        self.assertEqual([e["causation_id"] for e in lane[1:4]], [e["event_id"] for e in lane[:3]])
        signal, stage, chosen, state, refused = lane[0], lane[1], lane[2], lane[4], lane[7]
        for value in (True, 0.5, "unknown"):
            self.assertEqual(validate_event({**signal, "attrs": {**signal["attrs"], "value": value}}), [], value)
        cases = [
            (signal, "source", "mouse"), (signal, "value", "Visual Studio Code"), (signal, "value", None),
            (signal, "value", float("nan")), (signal, "revision", -1), (stage, "to", "away"),
            (chosen, "layer", "face"), (chosen, "t_s", -1), (chosen, "behavior_id", ""), (state, "origin", "remote"),
            (state, "phase", "running"), (refused, "channels", "full_body"), (refused, "priority", None),
        ]
        for event, key, value in cases:
            with self.subTest(key=key, value=value):
                self.assertIn(f"bad attrs.{key}: {value!r}",
                              validate_event({**event, "attrs": {**event["attrs"], key: value}}))
        self.assertEqual(validate_event({**signal, "attrs": {**signal["attrs"], "revision": None}}), [])
        self.assertEqual(validate_event({**chosen, "attrs": {**chosen["attrs"], "layer": None, "behavior_id": None}}),
                         [])
        self.assertIn("motion.state needs attrs.behavior_id",
                      validate_event({**state, "attrs": {k: v for k, v in state["attrs"].items() if k != "behavior_id"}}))

    def test_the_motion_lane_s_replay_inputs(self):
        base = {k: v for k, v in sample()[16].items() if k != "text"}
        good = {
            "spatial.began": {"seed": 7, "epoch": 3, "preset": "balanced", "stage": "normal", "session_settle": 1.5,
                              "session_min_hold": 3.0, "recovery_delay": 3.0},
            "situation.observed": {"by": "poll", "fullscreen": False, "user_speaking": False, "speaking": True,
                                   "voicing": False, "typing": False, "line_id": "l1", "absence_since": None,
                                   "session": "claude:s1", "state": "thinking", "related": ["claude:s1"],
                                   "window_id": 101, "activity": None, "idle": "active", "turn_traced": True},
            "motion.chooser": {"pack": "demo", "seeds": {"tier": 13}, "kept": {"clip": "base_loop", "until_ms": 5}},
            "motion.intent": {"intent": "think", "state": "thinking", "activity": None, "mood": None,
                              "display_session": "role:r1"},
            "motion.input": {"item": {"kind": "clause", "intent": "explain"}},
            "motion.clock": {"frames": 1440},
            "motion.prefs": {"action_switches": {"touch_tap": False},
                             "motion_overrides": {"chains": {}, "pools": {}, "blend_in": {}}},
            "motion.return": {"row": "welcome", "away_s": 900.5, "ended": 0, "why": None},
            "behavior.switches": {"switches": {"stay_in_place": False}},
            "behavior.capabilities": {"character": "aster", "capabilities": {"sit": None, "face": "no head"}},
            "behavior.cancel_all": {"reason": "character_switch"},
        }
        for kind, attrs in good.items():
            with self.subTest(kind):
                self.assertEqual(validate_event({**base, "kind": kind, "attrs": attrs}), [])
        self.assertEqual(validate_event({**base, "kind": "spatial.began", "attrs": {**good["spatial.began"],
                                                                                     "seed": None}}), [])
        self.assertEqual(validate_event({**base, "kind": "motion.chooser",
                                         "attrs": {"pack": None, "seeds": None, "kept": None}}), [])
        cases = [
            ("spatial.began", "stage", "away"), ("spatial.began", "seed", -1), ("situation.observed", "by", "tick"),
            ("situation.observed", "idle", 12.5), ("situation.observed", "related", "claude:s1"),
            ("situation.observed", "window_id", "w1"), ("motion.chooser", "seeds", {"tier": "x"}),
            ("motion.chooser", "kept", {"clip": "base_loop"}), ("motion.input", "item", {"on": True}),
            ("motion.clock", "frames", 1.5), ("motion.return", "away_s", None),
            ("behavior.switches", "switches", {"stay_in_place": 1}),
            ("behavior.capabilities", "capabilities", {"sit": False}), ("behavior.cancel_all", "reason", ""),
        ]
        for kind, key, value in cases:
            with self.subTest(kind=kind, key=key, value=value):
                self.assertIn(f"bad attrs.{key}: {value!r}",
                              validate_event({**base, "kind": kind, "attrs": {**good[kind], key: value}}))
        self.assertIn("situation.observed needs attrs.typing", validate_event(
            {**base, "kind": "situation.observed",
             "attrs": {k: v for k, v in good["situation.observed"].items() if k != "typing"}}))

    def test_stream_rules_reject(self):
        events = sample()
        events[2]["event_id"] = events[1]["event_id"]
        self.assertTrue(any("duplicate event_id" in e for e in validate_stream(events)))
        events = sample()
        events[3]["seq"] = events[2]["seq"]
        self.assertTrue(any("is not above" in e for e in validate_stream(events)))
        events = sample()
        events[1]["causation_id"] = "00000000-0000-4000-8000-000000000000"
        self.assertTrue(any("is not an earlier event" in e for e in validate_stream(events)))
        events = sample()
        events[1]["parent_span_id"] = "0123456789abcdef"
        self.assertTrue(any("is no span in the stream" in e for e in validate_stream(events)))

    def test_companion_ui_event_shape(self):
        # Field for field what companion TraceForwarder.event(...) sends for a ui.* mark.
        event = {"v": 1, "event_id": "8f14e45f-ceea-467a-9b36-7a5c1d3e2b10",
                 "trace_id": "c9f0f895-fb98-4b91-a1c2-3d4e5f6a7b8c", "turn_id": "l1", "turn_generation": 7,
                 "span_id": "0123456789abcdef", "parent_span_id": None, "causation_id": None,
                 "producer": "companion", "producer_epoch": 3, "seq": 1, "kind": "ui.submitted",
                 "t_wall": "2026-11-09T10:00:00.250+08:00", "t_mono_ms": 5, "status": "ok", "attrs": {}}
        self.assertEqual(validate_event(event), [])
        event["turn_generation"] = None
        self.assertIn("turn_id and turn_generation must both be null or both be set", validate_event(event))


if __name__ == "__main__":
    unittest.main()
