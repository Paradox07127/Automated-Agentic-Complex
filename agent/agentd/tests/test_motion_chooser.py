"""The motion chooser on a small synthetic pack: idle tiers, events, clicks, the budget, no-repeat draws and the six
random streams."""
import math
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from motion.chooser import MotionChooser, SEEDS, lcg  # noqa: E402

PACK = Path(__file__).resolve().parent / "fixtures" / "motion-chooser" / "demo"  # a runtime character directory
FRAME = 1 / 60


def replay(chooser, seconds, inputs=()):
    """Inputs at the frame their t_s (from now) rounds up to, then the frame's tick; the choices made."""
    inputs, start = sorted(inputs, key=lambda i: i["t_s"]), len(chooser.choices)
    for n in range(round(seconds * 60)):
        while inputs and math.ceil(inputs[0]["t_s"] * 60 - 1e-6) <= n:
            chooser.send(inputs.pop(0))
        chooser.tick(FRAME)
    return chooser.choices[start:]


class LcgTest(unittest.TestCase):
    def test_each_stream_starts_at_its_seed_and_steps_by_the_formula(self):
        self.assertEqual(SEEDS, {"activity": 1018, "event": 2110, "tier": 1021, "fidget": 20261018, "gesture": 2026,
                                 "click": 1810})
        # x = 1664525 x + 1013904223 mod 2^32, three steps from each seed.
        first = {"activity": [2708390673, 2641404220, 3661695851], "event": [231084677, 2849759776, 2379362047],
                 "tier": [2713384248, 3810113335, 3894160170], "fidget": [1901682481, 3853471452, 1933417611],
                 "gesture": [91264577, 190675628, 165328411], "click": [4026694473, 1942965268, 607766627]}
        for stream, seed in SEEDS.items():
            x, values = seed, []
            for _ in range(3):
                x = lcg(x)
                values.append(x)
            self.assertEqual(values, first[stream], stream)


class ChooserTest(unittest.TestCase):
    def test_idle_tier_starts_after_its_enter_time_and_returns_to_the_base(self):
        choices = replay(MotionChooser(PACK), 20)
        self.assertEqual(choices[0]["why"], "idle.t1")
        self.assertIn(choices[0]["clip"], {"nod", "shrug", "stretch"})
        self.assertTrue(5 <= choices[0]["t_s"] <= 10 + FRAME, choices[0])
        self.assertEqual((choices[1]["clip"], choices[1]["why"]), ("base_loop", "return to base"))

    def test_tier_draws_repeat_no_family_of_the_last_two_and_keep_the_budget(self):
        tier = [c for c in replay(MotionChooser(PACK), 240) if c["why"] == "idle.t1"]
        self.assertGreaterEqual(len(tier), 6)
        for a, b, c in zip(tier, tier[1:], tier[2:]):
            self.assertEqual(len({a["clip"], b["clip"], c["clip"]}), 3, (a, b, c))
        # Two starts a minute: a third waits until the first is a minute old (the clock is a 32-bit sum of frames).
        for c in tier:
            self.assertLessEqual(sum(1 for d in tier if 0 <= c["t_s"] - d["t_s"] < 60 - FRAME), 2, c)

    def test_a_clip_the_manifest_lacks_is_never_drawn_and_is_counted_once(self):
        with self.assertLogs("motion.chooser", "INFO") as logs:
            chooser = MotionChooser(PACK)
        self.assertEqual(logs.output, ["INFO:motion.chooser:motion: demo: 1 clips the c7 tables name are not in "
                                       "actor/manifest.json"])
        self.assertNotIn("ghost", {c["clip"] for c in replay(chooser, 240)})

    def test_an_event_plays_its_pool_and_waits_out_its_cooldown(self):
        greet = {"kind": "event", "key": "user.greet"}
        choices = replay(MotionChooser(PACK), 4.5, [dict(greet, t_s=2), dict(greet, t_s=3)])
        self.assertEqual(choices, [{"t_s": 2.0, "clip": "wave", "why": "user.greet"},
                                   {"t_s": 3.767, "clip": "base_loop", "why": "return to base"}])

    def test_clicks_wait_one_and_a_half_seconds_and_do_not_repeat_the_last_clip(self):
        click = {"kind": "click"}
        choices = replay(MotionChooser(PACK), 5, [dict(click, t_s=1), dict(click, t_s=2), dict(click, t_s=3)])
        clicks = [c for c in choices if c["why"] == "click.single region none"]
        self.assertEqual([c["t_s"] for c in clicks], [1.0, 3.0])
        self.assertEqual({c["clip"] for c in clicks}, {"tap", "nod"})

    def test_a_restart_draws_the_same_clips_again(self):
        chooser = MotionChooser(PACK)
        first = replay(chooser, 60)
        again = replay(chooser, 60, [{"t_s": 0, "kind": "restart"}])
        self.assertTrue(first)
        self.assertEqual([(c["clip"], c["why"]) for c in again], [(c["clip"], c["why"]) for c in first])
        self.assertEqual([round(c["t_s"] - 60, 3) for c in again], [c["t_s"] for c in first])


if __name__ == "__main__":
    unittest.main()
