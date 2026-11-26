import ast
import inspect
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from brain.persona import PROMPT_USER  # noqa: E402
from character import character_state  # noqa: E402
from character.character_state import DEFAULT_PROFILE, CharacterState, energy_target  # noqa: E402
from infra.store import open_store  # noqa: E402


def local(hour, day=19, minute=0):
    return time.mktime((2026, 10, day, hour, minute, 0, 0, 0, -1))


NOON = local(12)
MIN = 60.0


class CharacterStateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "agentd.sqlite"
        self.now = NOON
        self.cards = {"aster": None, "birch": {"mood_baseline": 0.0, "energy_offset": -0.1,
                                                  "activity_weights": {"sit": 2.0}}}

    def make(self, character="aster"):
        db = open_store(self.path)
        self.addCleanup(db.close)
        state = CharacterState(db, self.cards.get, clock=lambda: self.now)
        state.use(character)
        return state

    def at(self, state, t):
        self.now = t
        state.advance(t)

    def row(self, character):
        db = open_store(self.path)
        try:
            return db.execute("SELECT energy, valence, causes, updated_at FROM character_state"
                              " WHERE character_id = ?", (character,)).fetchone()
        finally:
            db.close()

    def test_energy_follows_the_clock_and_a_walk_costs_energy(self):
        table = {**{h: 0.8 for h in range(9, 19)}, **{h: 0.6 for h in range(19, 23)},
                 **{h: 0.3 for h in (23, 0, 1, 2, 3, 4, 5)}, **{h: 0.5 for h in range(6, 9)}}
        self.assertEqual({h: energy_target(h) for h in range(24)}, table)
        state = self.make()
        self.assertAlmostEqual(state.snapshot()["energy"], 0.8)
        self.assertEqual(state.labels()["energy"], "lively")
        self.assertEqual(state.walk_scale(), 0.8)
        state.on_event("behavior_sent", behavior_id="b1", type="short_walk", priority=0)
        state.on_event("behavior_ended", behavior_id="b1", type="short_walk", outcome="done")
        self.assertAlmostEqual(state.snapshot()["energy"], 0.75)
        state.on_event("behavior_sent", behavior_id="b2", type="climb_window_top", priority=0)
        state.on_event("behavior_ended", behavior_id="b2", type="climb_window_top", outcome="interrupted")
        self.assertAlmostEqual(state.snapshot()["energy"], 0.75)  # only a finished climb costs energy
        state.on_event("behavior_sent", behavior_id="b3", type="climb_window_top", priority=0)
        state.on_event("behavior_ended", behavior_id="b3", type="climb_window_top", outcome="done")
        self.assertAlmostEqual(state.snapshot()["energy"], 0.67)
        # 45 min half-life back to the daytime target
        self.at(state, NOON + 45 * MIN)
        self.assertAlmostEqual(state.snapshot()["energy"], 0.8 - 0.13 / 2, places=6)
        # through the evening into the night: 23–05 aims at 0.3
        self.at(state, local(5, day=20))
        energy = state.snapshot()["energy"]
        self.assertAlmostEqual(energy, 0.3, delta=0.01)
        self.assertEqual(state.labels()["energy"], "sleepy")
        self.assertEqual((state.tick_scale(), state.walk_scale(), state.intensity_range()), (1.5, 2.0, (0.4, 0.5)))
        self.assertEqual(state.weights(["idle", "observe", "short_walk", "sit", "climb_window_top"]),
                         [2.0, 1.0, 0.1, 2.0, 0.1])
        # a sit that runs gives back 0.01 a minute on top of the pull to the target, never past the hour's target
        state.on_event("behavior_sent", behavior_id="b4", type="sit", priority=0)
        self.at(state, local(6, day=20))
        self.assertLessEqual(state.snapshot()["energy"], energy)  # a night of sitting stays sleepy
        self.at(state, local(6, day=20, minute=10))
        self.assertGreater(state.snapshot()["energy"] - energy, 0.09)
        self.at(state, local(7, day=20))
        self.assertAlmostEqual(state.snapshot()["energy"], 0.5)
        # the card's energy_offset moves every target
        self.now = NOON
        self.assertAlmostEqual(self.make("birch").snapshot()["energy"], 0.7)

    def test_every_change_names_its_cause(self):
        state = self.make()
        state.on_event("dispatch_done")
        state.on_event("user_spoke")
        state.on_event("user_spoke")  # within 10 min: no change, no cause
        state.on_event("line")
        valence = state.snapshot()["valence"]
        state.on_event("behavior_sent", behavior_id="b1", type="observe", priority=0)
        state.on_event("behavior_ended", behavior_id="b1", type="observe", outcome="blocked")
        state.on_event("behavior_sent", behavior_id="b2", type="observe", priority=0)
        state.on_event("behavior_ended", behavior_id="b2", type="observe", outcome="blocked")
        # a blocked path is the desktop's doing, not hers or the user's: no mood change, no cause
        self.assertAlmostEqual(state.snapshot()["valence"], valence)
        state.on_event("behavior_sent", behavior_id="b3", type="short_walk", priority=0)
        state.on_event("behavior_ended", behavior_id="b3", type="short_walk", outcome="done")
        causes = [(c["attr"], c["cause"], c["delta"]) for c in state.snapshot()["causes"]]
        self.assertEqual(causes, [("valence", "dispatch_done", 0.15), ("valence", "user_spoke", 0.05),
                                  ("energy", "line", -0.005), ("energy", "short_walk", -0.05)])
        # a line costs at most 0.05 an hour; past that it changes nothing and names nothing
        for _ in range(12):
            state.on_event("line")
        lines = [c for c in state.snapshot()["causes"] if c["cause"] == "line"]
        self.assertEqual(len(lines), 8)  # only the latest 8 causes are kept
        self.assertAlmostEqual(state.snapshot()["energy"], 0.8 - 0.05 - 0.05)
        for kind in ("session_done", "session_error", "dispatch_failed", "feedback_useful"):
            state.on_event(kind)
        self.assertEqual([c["cause"] for c in state.snapshot()["causes"][-4:]],
                         ["session_done", "session_error", "dispatch_failed", "feedback_useful"])
        self.assertEqual(len(state.snapshot()["causes"]), 8)
        state.flush()
        self.assertEqual(json.loads(self.row("aster")[2]), state.snapshot()["causes"])

    def test_the_state_line_names_no_cause(self):
        state = self.make()
        for kind in ("session_done", "dispatch_done", "dispatch_done", "session_error"):
            state.on_event(kind)
        self.assertAlmostEqual(state.snapshot()["valence"] - DEFAULT_PROFILE["mood_baseline"], 0.3)
        summary = state.summary(PROMPT_USER)
        self.assertIn("mood good", summary)
        self.assertNotIn("(because", summary)
        self.assertNotRegex(summary, "session|dispatch|task|error")

    def test_valence_returns_to_baseline_and_never_goes_sad_without_an_event(self):
        state = self.make()
        self.assertEqual(DEFAULT_PROFILE["mood_baseline"], 0.2)
        for hour in range(24):  # a day with no event: the baseline all along
            self.at(state, NOON + hour * 3600)
            self.assertAlmostEqual(state.snapshot()["valence"], 0.2)
            self.assertEqual(state.mood_label("normal"), "normal")
            self.assertIn("mood steady", state.summary(PROMPT_USER))  # every turn gets a line, a usual one too
        for kind in ("dispatch_done", "session_done", "feedback_useful"):
            state.on_event(kind)
        self.assertAlmostEqual(state.snapshot()["valence"], 0.55)
        self.assertEqual(state.mood_label("normal"), "happy")
        self.assertEqual(state.labels()["mood"], "good")
        summary = state.summary(PROMPT_USER)
        self.assertTrue(summary.startswith("<your_state>You yourself now: energy lively, mood good."), summary)
        self.assertIn("This line is your current state and replaces any earlier one.", summary)
        self.assertTrue(summary.endswith(f"This is your state, not {PROMPT_USER}'s; do not ask anything of {PROMPT_USER} "
                                         "because of it.</your_state>"), summary)
        # daytime energy above 0.7 adds its own ×1.3
        self.assertEqual([round(w, 6) for w in state.weights(["observe", "short_walk", "sit"])], [1.56, 1.56, 1.0])
        self.at(state, self.now + 20 * MIN)  # 20 min half-life
        self.assertAlmostEqual(state.snapshot()["valence"], 0.2 + 0.35 / 2, places=6)
        self.at(state, self.now + 4 * 3600)
        self.assertAlmostEqual(state.snapshot()["valence"], 0.2, places=3)
        for _ in range(8):  # failures drop it at most 0.6 below the baseline
            state.on_event("dispatch_failed")
        self.assertAlmostEqual(state.snapshot()["valence"], -0.4)
        self.assertEqual(state.mood_label("normal"), "normal")
        self.assertEqual(state.labels()["mood"], "low")
        self.assertEqual(state.weights(["sit", "idle", "hold_window_edge"]), [1.3, 1.3, 1.0])
        self.at(state, self.now + 6 * 3600)
        self.assertAlmostEqual(state.snapshot()["valence"], 0.2, places=3)

    def test_a_success_reads_as_good_for_a_few_minutes(self):
        state = self.make()
        state.on_event("dispatch_done")
        state.on_event("session_done")
        self.at(state, self.now + 5 * MIN)
        self.assertEqual(state.labels()["mood"], "good")
        self.assertEqual(state.mood_label("normal"), "happy")
        self.at(state, self.now + 25 * MIN)
        self.assertEqual(state.labels()["mood"], "steady")
        self.assertEqual(state.mood_label("normal"), "normal")

    def test_labels_are_codes(self):
        state = self.make()
        for energy, code in ((0.8, "lively"), (0.5, "okay"), (0.25, "sleepy"), (0.1, "very_sleepy")):
            state.energy = energy
            self.assertEqual(state.labels()["energy"], code)

    def test_engagement_grows_while_uninterrupted_and_drops_when_replaced(self):
        state = self.make()
        state.on_event("behavior_sent", behavior_id="b1", type="sit", priority=0)
        self.assertAlmostEqual(state.snapshot()["engagement"], 0.5)  # 0.3 + 0.4 × preference 0.5
        self.assertEqual(state.comment_scale(), 1.0)
        self.at(state, self.now + 2 * MIN)
        self.assertAlmostEqual(state.snapshot()["engagement"], 0.7)
        self.assertEqual(state.labels()["engagement"], "absorbed")
        self.assertEqual(state.comment_scale(), 1.25)
        self.assertIn("absorbed in sitting", state.summary(PROMPT_USER))
        self.at(state, self.now + 10 * MIN)
        self.assertAlmostEqual(state.snapshot()["engagement"], 1.0)
        # an event behavior takes the body
        state.on_event("behavior_sent", behavior_id="b2", type="listen", priority=2)
        state.on_event("behavior_ended", behavior_id="b1", type="sit", outcome="replaced")
        self.assertAlmostEqual(state.snapshot()["engagement"], 0.2)
        self.at(state, self.now + 5 * MIN)
        self.assertAlmostEqual(state.snapshot()["engagement"], 0.2)
        state.on_event("behavior_sent", behavior_id="b3", type="observe", priority=0)
        self.assertAlmostEqual(state.snapshot()["engagement"], 0.5)
        state.on_event("behavior_ended", behavior_id="b3", type="observe", outcome="done")
        self.assertEqual(state.snapshot()["engagement"], 0.0)
        # The behavior tick's sustained activity counts; a one-shot does not, the same activity again goes on growing
        state.on_event("activity", activity="relax")
        self.at(state, self.now + MIN)
        state.on_event("activity", activity="yawn")
        state.on_event("activity", activity="relax")
        self.assertAlmostEqual(state.snapshot()["engagement"], 0.6)
        self.assertEqual(state.snapshot()["activity"], "relax")
        # the card's preference sets the start: weight 2 is a full preference
        sitter = self.make("birch")
        sitter.on_event("behavior_sent", behavior_id="b9", type="sit", priority=0)
        self.assertAlmostEqual(sitter.snapshot()["engagement"], 0.7)

    def test_two_characters_keep_separate_rows_and_a_restart_catches_up(self):
        state = self.make()
        state.on_event("dispatch_done")
        written = self.row("aster")
        self.assertAlmostEqual(written[1], 0.35)
        self.now += 10
        state.on_event("user_spoke")
        self.assertEqual(self.row("aster"), written)  # at most one write per 60 s
        self.at(state, self.now + 60)
        self.assertGreater(self.row("aster")[1], 0.35)
        state.use("birch")  # a switch writes the one it leaves
        self.assertEqual(self.row("aster")[3], self.now)
        state.on_event("dispatch_failed")
        state.flush()
        self.assertAlmostEqual(self.row("birch")[1], -0.1)
        self.assertEqual(self.row("birch")[0], state.snapshot()["energy"])
        state.use("aster")
        valence = state.snapshot()["valence"]
        state.flush()
        # agentd restarts 40 min later: two half-lives of mood pass while it was gone
        self.now += 40 * MIN
        again = self.make()
        self.assertAlmostEqual(again.snapshot()["valence"], 0.2 + (valence - 0.2) / 4, places=6)
        self.assertEqual(again.snapshot()["causes"][-1]["cause"], "user_spoke")
        other = self.make("birch")
        self.assertAlmostEqual(other.snapshot()["valence"], -0.1 / 4, places=6)
        self.assertAlmostEqual(other.snapshot()["energy"], 0.7)

    def test_each_write_appends_a_history_row_read_back_oldest_first(self):
        state = self.make()
        state.on_event("dispatch_done")
        self.at(state, self.now + 30)  # within 60 s: no write, no row
        self.at(state, self.now + 60)
        state.on_event("behavior_sent", behavior_id="w1", type="short_walk", priority=1)
        state.on_event("behavior_ended", behavior_id="w1", type="short_walk", outcome="done")
        self.now += 60
        state.flush()
        items = state.history()
        self.assertEqual([(i["at"], i["cause"]) for i in items],
                         [(NOON, "dispatch_done"), (NOON + 90, None), (NOON + 150, "short_walk")])
        self.assertEqual(set(items[0]), {"at", "energy", "valence", "cause"})
        self.assertAlmostEqual(items[0]["valence"], 0.35)
        self.assertAlmostEqual(items[-1]["energy"], state.snapshot()["energy"])
        self.assertEqual([i["at"] for i in state.history(since=NOON + 90)], [NOON + 90, NOON + 150])
        self.assertEqual([i["at"] for i in state.history(limit=2)], [NOON + 90, NOON + 150])
        state.use("birch")
        self.assertEqual(state.history(), [])

    def test_history_follows_retention_and_goes_with_a_clear(self):
        state = self.make()
        state.on_event("dispatch_done")
        self.now += 8 * 24 * 3600
        state.flush()
        self.assertEqual(len(state.history()), 2)  # keep by default
        state.retention = lambda: 7 * 24 * 3600
        self.now += 60
        state.on_event("dispatch_failed")
        self.assertEqual([i["at"] for i in state.history()], [self.now - 60, self.now])
        state.clear()
        self.assertEqual(state.history(), [])

    def test_it_takes_no_attention_store(self):
        self.assertEqual(list(inspect.signature(CharacterState).parameters), ["db", "profiles", "clock"])
        tree = ast.parse(Path(character_state.__file__).read_text(encoding="utf-8"))
        imported = {alias.name.split(".")[0] for node in ast.walk(tree) if isinstance(node, ast.Import)
                    for alias in node.names}
        imported |= {node.module.split(".")[0] for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)}
        self.assertEqual(imported - {"json", "math", "threading", "time"}, set())


if __name__ == "__main__":
    unittest.main()
