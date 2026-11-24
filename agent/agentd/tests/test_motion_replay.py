"""tools/motion_replay.py: a recorded stretch of the motion lane, fed again to a fresh Spatial and chooser on a fake
clock with a fake renderer, gives the decisions that were recorded."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

import support  # noqa: F401

import c1  # noqa: E402
from infra.store import open_store  # noqa: E402
from motion.chooser import MotionChooser  # noqa: E402
from observation.spatial import Spatial  # noqa: E402
from observation.user_now import UserNow  # noqa: E402
from sessions.registry import Registry  # noqa: E402
from traces.motion_lane import MotionLane  # noqa: E402
from traces.trace_format import validate_stream  # noqa: E402
from traces.trace_store import TraceStore  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "motion-chooser"  # one runtime character directory per pack
TOOL = Path(__file__).resolve().parents[1] / "tools" / "motion_replay.py"
T0 = 1760900000.0
SEEDS = {"activity": 11, "event": 12, "tier": 13, "fidget": 14, "gesture": 15, "click": 16}  # not the chooser's own
DECISIONS = ("motion.chosen", "behavior.dispatched", "behavior.refused")


def role(state):
    """A role focus row in `state`, as the character agent sets it."""
    done = state == "done"
    return {"display_session": "role:r1", "state": state, "priority": 7 if done else 4, "tool_name": None,
            "tool_category": None, "expires_at": time.time() + 600, "run_id": "r1", "conversation_id": "c",
            "run_generation": 1, "phase": "completed" if done else "running",
            **({"outcome": "succeeded"} if done else {})}


class Recording:
    """agentd's motion lane on a fake clock in whole milliseconds: UserNow, the registry and Spatial with the demo pack
    write into a trace store, Spatial polls each second and its motion clock wakes about every 0.1 s, and a fake
    renderer answers each behavior with prepared and running, each cancel and each replacement, as the Companion
    forwards them."""

    def __init__(self, root):
        self.ms = 0
        self.store = TraceStore(open_store(root / "trace.sqlite3"), producer_epoch=7, clock=self.clock,
                                mono=self.clock)
        lane = MotionLane(lambda kind, trace_id, **fields: self.store.emit(kind, trace_id, **fields))
        self.s = {"fullscreen": False, "user_speaking": False, "speaking": False, "voicing": False, "line_id": None,
                  "typing": False, "absence": None, "session": None, "state": "idle", "related": [], "window_id": 101,
                  "activity": None, "idle_s": None}
        self.registry = Registry(epoch=7)
        self.user_now = UserNow(clock=self.clock, lane=lane)
        self.spatial = Spatial(lambda: dict(self.s), self.registry.publish_event, lambda: 3, 7, clock=self.clock,
                               stage=lambda: self.user_now.snapshot()["stage"], lane=lane)
        self.registry.consumed = self.spatial.consumed
        self.registry.on_intent = self.spatial.motion_intent
        self.user_now.subscribe(lambda e: e["name"].startswith("stage.") and self.spatial.stage_event(e["name"]))
        self.spatial.use_motion(MotionChooser(FIXTURES / "demo", SEEDS))
        self.spatial.begin()
        self.seen, self.running, self.mic = 0, {}, False
        # the motion clock's wakes: late by a few ms each, as a thread's are
        self.wakes = {8 + 100 * k + (3 + 5 * k % 7 if k else 0) for k in range(1000)}

    def clock(self):
        return T0 + self.ms / 1000

    def run(self, until_s, inputs):
        """Each millisecond up to until_s: what runs out expires, the poll, the motion clock and the inputs at their
        ms, {ms: callable}."""
        while self.ms < until_s * 1000:
            self.ms += 1
            for behavior_id, message in list(self.running.items()):
                if message["expires_at_ms"] <= self.clock() * 1000:
                    self.receipt(behavior_id, "expired")
            if self.ms % 1000 == 41:  # a coarse beat each second
                self.user_now.coarse({"ts": self.clock(), "idle_s": 3, "mic_active": self.mic})
            if self.ms in inputs:
                inputs[self.ms]()
                self.flush()
            if self.ms % 1000 == 503:
                self.spatial.poll()
                self.flush()
            if self.ms in self.wakes:
                self.spatial.motion_step()
                self.flush()

    def flush(self):
        while True:
            items = self.registry.intents_since(self.seen)
            if not items:
                return
            message = items[0]
            self.seen = message["seq"]
            if message.get("event") == "behavior":
                old = self.running.get(message["replaces"])
                if old is not None and old["priority"] > message["priority"]:
                    self.receipt(message["behavior_id"], "rejected", "busy")
                    continue
                if old is not None:
                    self.receipt(message["replaces"], "cancelled")
                self.running[message["behavior_id"]] = message
                self.receipt(message["behavior_id"], "prepared")
                self.receipt(message["behavior_id"], "running")
            elif message.get("event") == "behavior_cancel" and message["behavior_id"] in self.running:
                self.receipt(message["behavior_id"], "cancelled")

    def receipt(self, behavior_id, phase, reason=None):
        """One receipt to Spatial, and into the trace once applied, as POST /behavior/receipts does."""
        message = self.running.get(behavior_id)
        generation = 3 if message is None else message["turn_generation"]
        if phase in c1.ENDED:
            self.running.pop(behavior_id, None)
        applied, _ = self.spatial.receipt({"behavior_id": behavior_id, "phase": phase, "reason": reason,
                                           "at_ms": int(self.clock() * 1000), "turn_generation": generation})
        linkage = self.spatial.receipt_trace(behavior_id) if applied else None
        if linkage is not None:
            trace_id, turn_id, behavior_type, _ = linkage
            self.store.emit("behavior.receipt", trace_id, turn_id=turn_id,
                            turn_generation=None if turn_id is None else generation,
                            attrs={"behavior_id": behavior_id, "behavior_type": behavior_type, "phase": phase,
                                   "reason": reason})
        self.flush()

    def base(self):
        return next(b for b, m in self.running.items() if m["type"] == "perform" and m["layer"] == "base")

    def state(self, origin, phase, clip, behavior_id=None):
        self.spatial.motion_state({"behavior_id": behavior_id, "origin": origin, "phase": phase, "resting": False,
                                   "busy": True, "clip": clip})

    def voice(self, on):
        self.s["voicing"] = on
        self.spatial.motion({"kind": "voice", "on": on})

    def set(self, **over):
        return lambda: self.s.update(over)

    def mic_on(self, on):
        return lambda: setattr(self, "mic", on)

    def play(self):
        """The user plays a clip of hers: the renderer cuts her base loop for it."""
        self.receipt(self.base(), "cancelled", "user_play")
        self.state("user", "started", "wave")

    def disconnect(self):
        """The renderer goes away: each behavior it ran ends lost."""
        for behavior_id in list(self.running):
            self.receipt(behavior_id, "cancelled", "connection_lost")

    def export(self, path):
        events = self.store.export()
        path.write_text("".join(json.dumps(e) + "\n" for e in events), encoding="utf-8")
        return events


class MotionReplayTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)
        self.recording = r = Recording(self.root)
        self.addCleanup(r.store.db.close)
        r.run(150, {
            4041: r.set(typing=True), 6041: r.set(typing=False),  # the user types: she accompanies it
            7041: lambda: r.registry.set_role_focus(role("thinking"), generation=3),  # an intent
            9041: lambda: r.voice(True),
            9341: lambda: r.spatial.motion_clause(("u1", "c1"), "explain"),  # a speech clause and its gesture
            10541: lambda: r.spatial.motion_clause_end(("u1", "c1")),
            11041: lambda: r.voice(False),
            12041: lambda: r.registry.set_role_focus(role("done"), generation=3),
            16041: r.play,  # the user's play refuses her base clips
            18041: lambda: r.registry.set_role_focus(role("thinking"), generation=3),
            20041: lambda: r.spatial.set_interaction("active"),  # PUT /settings/live
            24041: lambda: r.state("user", "ended", "wave"),
            24541: lambda: r.registry.set_role_focus(role("done"), generation=3),
            25500: r.mic_on(True),  # a meeting: the quiet stage walks her to the edge
            29041: lambda: r.receipt(next(b for b, m in r.running.items() if m["type"] == "short_walk"), "completed"),
            32500: r.mic_on(False),
            34041: r.disconnect,
            36041: lambda: r.state("local", "started", "pat_react"),
            37041: lambda: r.state("local", "ended", "pat_react"),
        })
        self.path = self.root / "recorded.ndjson"
        self.events = r.export(self.path)

    def replay(self, path, *args):
        out = self.root / "out"
        done = subprocess.run([sys.executable, "-I", str(TOOL), str(path), "--packs", str(FIXTURES), "--out", str(out),
                               *args], capture_output=True, encoding="utf-8", timeout=120)
        diff = json.loads((out / "diff.json").read_text(encoding="utf-8"))
        replayed = [json.loads(line) for line in (out / "replayed.ndjson").read_text(encoding="utf-8").splitlines()]
        return done, diff, replayed

    def kinds(self, events, *kinds):
        return [e for e in events if e["kind"] in kinds]

    def test_a_recording_of_the_current_code_replays_to_the_same_decisions(self):
        self.assertEqual(validate_stream(self.events), [])
        kinds = {e["kind"] for e in self.events}
        self.assertLessEqual({"spatial.began", "motion.chooser", "situation.observed", "motion.intent", "motion.input",
                              "stage.changed", "motion.state", "behavior.receipt", "interaction.preset", *DECISIONS},
                             kinds)
        [began] = self.kinds(self.events, "spatial.began")
        self.assertIsInstance(began["attrs"]["seed"], int)
        self.assertEqual(self.kinds(self.events, "motion.chooser")[-1]["attrs"]["seeds"], SEEDS)
        refused = {e["attrs"]["reason"] for e in self.kinds(self.events, "behavior.refused")}
        self.assertIn("user_play", refused)
        self.assertIn("connection_lost", {e["attrs"]["reason"] for e in self.kinds(self.events, "behavior.receipt")})
        self.assertGreater(len(self.kinds(self.events, *DECISIONS)), 20)
        done, diff, replayed = self.replay(self.path)
        self.assertEqual((done.returncode, diff["differences"]), (0, []), done.stderr)
        self.assertEqual(diff["recorded"], len(self.kinds(self.events, *DECISIONS)))
        self.assertEqual(diff["replayed"], diff["recorded"])
        self.assertIn("0 differences", done.stdout)
        self.assertEqual(validate_stream(replayed), [])
        self.assertEqual([e["attrs"] for e in self.kinds(replayed, "interaction.preset")], [{"preset": "active"}])
        self.assertEqual([(e["kind"], e["attrs"].get("clip"), e["attrs"].get("why"), e["attrs"].get("reason"))
                          for e in self.kinds(replayed, *DECISIONS)],
                         [(e["kind"], e["attrs"].get("clip"), e["attrs"].get("why"), e["attrs"].get("reason"))
                          for e in self.kinds(self.events, *DECISIONS)])

    def test_a_changed_input_shows_in_the_diff(self):
        changed = []
        for e in self.events:
            if e["kind"] == "motion.input" and e["attrs"]["item"]["kind"] == "clause":
                e = {**e, "attrs": {"item": {**e["attrs"]["item"], "intent": "agree"}}}  # no gesture for it
            changed.append(e)
        path = self.root / "changed.ndjson"
        path.write_text("".join(json.dumps(e) + "\n" for e in changed), encoding="utf-8")
        done, diff, _ = self.replay(path)
        self.assertEqual(done.returncode, 1, done.stderr)
        missing = [d["recorded"] for d in diff["differences"] if d["op"] == "missing"]
        self.assertIn(("motion.chosen", "point"), [(d["kind"], d["clip"]) for d in missing])

    def test_from_and_to_narrow_the_decisions_compared(self):
        decisions = self.kinds(self.events, *DECISIONS)
        start, end = decisions[len(decisions) // 3]["t_wall"], decisions[2 * len(decisions) // 3]["t_wall"]
        inside = [e for e in decisions if start <= e["t_wall"] <= end]
        done, diff, _ = self.replay(self.path, "--from", start, "--to", end)
        self.assertEqual((done.returncode, diff["differences"], diff["recorded"]), (0, [], len(inside)), done.stderr)


if __name__ == "__main__":
    unittest.main()
