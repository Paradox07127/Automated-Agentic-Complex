"""The motion chooser on a small synthetic pack: idle tiers, events, clicks, the budget, no-repeat draws and the six
random streams."""
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
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

    def test_each_agentd_process_draws_its_own_opening_idle_clips(self):
        """The chooser agentd builds for a character does not start at SEEDS: an agentd restart does not play the
        opening idle clips again in the order the last process played them."""
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root)
        shutil.copytree(PACK, root / "runtime" / "characters" / "demo")
        script = "\n".join([
            "import json, sys, types",
            "from pathlib import Path",
            "sys.path[:0] = sys.argv[1:3]",
            "from test_motion_chooser import replay",
            "from daemon.character_switch import CharacterSwitchMixin",
            "package = types.SimpleNamespace(root=Path(sys.argv[3]))",
            "server = types.SimpleNamespace(characters=types.SimpleNamespace(package=lambda cid: package))",
            "print(json.dumps(replay(CharacterSwitchMixin.motion_chooser(server, 'demo'), 120)))"])
        here = Path(__file__).resolve().parent
        runs = [json.loads(subprocess.run([sys.executable, "-I", "-c", script, str(here.parent), str(here), str(root)],
                                          capture_output=True, text=True, check=True).stdout.splitlines()[-1])
                for _ in range(2)]
        self.assertGreaterEqual(len([c for c in runs[0] if c["why"] == "idle.t1"]), 3)
        self.assertNotEqual(runs[0], runs[1])


ROWS = {"animation": [{"id": "idle_nod", "section": "idle", "clips": ["nod"]},
                      {"id": "idle_shrug", "section": "idle", "clips": ["shrug"]},
                      {"id": "idle_stretch", "section": "idle", "clips": ["stretch"], "required_reason": "rest"},
                      {"id": "idle_ghost", "section": "idle", "clips": ["ghost"]},
                      {"id": "react_wave", "section": "react", "clips": ["wave"]},
                      {"id": "react_cheer", "section": "react", "clips": ["cheer"]}],
        "interaction": [{"id": "touch_tap", "section": "touch", "clips": ["tap"]},
                        {"id": "touch_pat", "section": "touch", "clips": ["pat_react"]}]}
CHAINS = ("nod", "shrug", "stretch", "wave", "think_loop", "to_relax", "sit_enter")


def prefs_pack(root, rows=ROWS):
    """The demo pack in root with action rows, a motion graph, `crouch` (it starts on the floor) in the idle tier and a
    `user.hover` pool of `glance`."""
    pack = Path(root) / "prefs"
    shutil.copytree(PACK, pack)

    def edit(name, change):
        path = pack / name
        doc = json.loads(path.read_text(encoding="utf-8"))
        change(doc)
        path.write_text(json.dumps(doc), encoding="utf-8")

    def motion_map(m):
        m["clips"].update(crouch={"interruptible": True}, glance={"interruptible": True})
        m["idle_tiers"][0]["pool"].append({"clip": "crouch"})
        m["events"]["user.hover"] = {"pool": [{"clip": "glance"}], "interrupt": "user"}
    added = [{"name": "crouch", "length": 1.0, "loop": False}, {"name": "glance", "length": 1.0, "loop": False}]
    edit("actor/manifest.json", lambda d: d["clips"].extend(added))
    edit("c7/animation/palette-contract.json",
         lambda d: d["clips"].extend({"name": c["name"], "loop": False} for c in added))
    edit("c7/animation/intent-motion-map.json", motion_map)
    edit("c7/interaction/motion-metadata.json", lambda d: d["clips"].update(
        crouch={"stance_start": "floor", "stance_end": "stand"}, glance={"stance_start": "stand", "stance_end": "stand"}))
    for section, section_rows in rows.items():
        edit(f"c7/{section}/actions.json", lambda d, r=section_rows: d.update(actions=r))
    edit("c7/pack.json", lambda d: d["animation"]["data"].append({"file": "motion-graph.json"}))
    (pack / "c7" / "animation" / "motion-graph.json").write_text(json.dumps(
        {"schema": "endfield-motion-graph/v1", "chains": {c: {} for c in CHAINS}}), encoding="utf-8")
    return pack


class MotionSettingsTest(unittest.TestCase):
    """The user's action switches, motion overrides and framing, as the mac controller applies them."""

    def setUp(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root)
        self.root = Path(root)
        self.pack = prefs_pack(self.root)

    def clips(self, chooser, seconds=240):
        return {c["clip"] for c in replay(chooser, seconds)}

    def test_a_switched_off_action_s_clips_are_never_chosen(self):
        self.assertIn("nod", self.clips(MotionChooser(self.pack)))
        chooser = MotionChooser(self.pack)
        self.assertEqual(chooser.set_action_switches({"idle_nod": False, "no_such_row": False}), [])
        self.assertFalse(chooser.switches["idle_nod"])
        clips = self.clips(chooser)
        self.assertNotIn("nod", clips)
        self.assertTrue({"shrug", "stretch"} <= clips, clips)

    def test_the_last_row_on_in_a_section_stays_on(self):
        chooser = MotionChooser(self.pack)
        self.assertEqual(chooser.set_action_switches({"react_wave": False, "react_cheer": False}),
                         [{"id": "react_wave", "reason": "last_in_section"}])
        self.assertEqual((chooser.switches["react_wave"], chooser.switches["react_cheer"]), (True, False))
        self.assertEqual(chooser.send({"kind": "event", "key": "user.greet"})[0]["clip"], "wave")
        # The row kept is the first one that was on before.
        self.assertEqual(chooser.set_action_switches({"react_wave": False, "react_cheer": True}), [])
        self.assertEqual(chooser.set_action_switches({"react_wave": False, "react_cheer": False}),
                         [{"id": "react_cheer", "reason": "last_in_section"}])

    def test_a_required_row_stays_on_and_a_missing_one_off(self):
        chooser = MotionChooser(self.pack)
        self.assertEqual(chooser.set_action_switches({"idle_stretch": False, "idle_ghost": True}),
                         [{"id": "idle_stretch", "reason": "required"}, {"id": "idle_ghost", "reason": "missing"}])
        self.assertEqual((chooser.switches["idle_stretch"], chooser.switches["idle_ghost"]), (True, False))
        self.assertIn("stretch", self.clips(chooser))

    def test_an_off_chain_s_start_clip_is_never_chosen(self):
        self.assertIn("shrug", self.clips(MotionChooser(self.pack)))
        chooser = MotionChooser(self.pack)
        self.assertEqual(chooser.set_motion_overrides({"shrug": False, "to_relax": False, "nope": False}, {}, {}),
                         [{"kind": "chain", "key": "nope", "reason": "unknown_chain"},
                          {"kind": "chain", "key": "to_relax", "reason": "required"}])
        clips = self.clips(chooser)
        self.assertNotIn("shrug", clips)
        self.assertIn("nod", clips)

    def test_a_pool_override_s_rows_are_the_only_ones_drawn(self):
        chooser = MotionChooser(self.pack)
        pool = [{"clip": "stretch", "weight": 1}, {"clip": "wave", "weight": 3}]
        self.assertEqual(chooser.set_motion_overrides({}, {"idle.t1": pool}, {}), [])
        tier = {c["clip"] for c in replay(chooser, 240) if c["why"] == "idle.t1"}
        self.assertEqual(tier, {"stretch", "wave"})
        self.assertEqual(chooser.pool("user.greet"), [("wave", 1)])

    def test_an_invalid_pool_keeps_the_pack_s_and_says_why(self):
        chooser = MotionChooser(self.pack)
        pools = {"idle.t1": [{"clip": "nod", "weight": 1}, {"clip": "sit_loop", "weight": 1}],
                 "user.greet": [{"clip": "sit_enter", "weight": 1}], "user.nope": [{"clip": "nod", "weight": 1}],
                 "click.single": [{"clip": "ghost", "weight": 1}], "activity.think": [{"clip": "nod", "weight": 1}]}
        self.assertEqual(chooser.set_motion_overrides({}, pools, {}),
                         [{"kind": "pool", "key": "activity.think", "reason": "unknown_pool"},
                          {"kind": "pool", "key": "click.single", "reason": "unknown_clip"},
                          {"kind": "pool", "key": "idle.t1", "reason": "stance_mismatch"},
                          {"kind": "pool", "key": "user.greet", "reason": "no_return"},
                          {"kind": "pool", "key": "user.nope", "reason": "unknown_pool"}])
        self.assertEqual(chooser.pool("click.single"), [("tap", 1), ("nod", 1)])
        self.assertTrue({"nod", "shrug", "crouch"} <= self.clips(chooser))

    def test_blend_in_is_the_clip_s_crossfade_in(self):
        chooser = MotionChooser(self.pack)
        self.assertEqual(chooser.set_motion_overrides({}, {}, {"wave": 1.5, "ghost": 1.0}),
                         [{"kind": "blend_in", "key": "ghost", "reason": "unknown_clip"}])
        self.assertEqual(chooser.send({"kind": "event", "key": "user.greet"})[0]["clip"], "wave")
        self.assertEqual(chooser.playhead(), ("wave", 0.0, 1.5))
        # A later set without it restores the pack's.
        chooser = MotionChooser(self.pack)
        chooser.set_motion_overrides({}, {}, {"wave": 1.5})
        chooser.set_motion_overrides({}, {}, {})
        self.assertEqual(chooser.send({"kind": "event", "key": "user.greet"})[0]["clip"], "wave")
        self.assertAlmostEqual(chooser.playhead()[2], 0.2, places=6)

    def test_bust_framing_chooses_only_standing_clips(self):
        self.assertIn("crouch", self.clips(MotionChooser(self.pack)))
        chooser = MotionChooser(self.pack)
        chooser.set_framing("bust")
        clips = self.clips(chooser)
        self.assertNotIn("crouch", clips)
        self.assertTrue({"nod", "shrug"} <= clips, clips)
        chooser.set_framing("full")
        self.assertIn("crouch", self.clips(chooser))

    def test_bust_framing_still_plays_a_required_row_s_clips(self):
        rows = {**ROWS, "animation": ROWS["animation"] + [
            {"id": "idle_crouch", "section": "idle", "clips": ["crouch"], "required_reason": "rest"}]}
        chooser = MotionChooser(prefs_pack(self.root / "required", rows))
        chooser.set_framing("bust")
        self.assertIn("crouch", self.clips(chooser))

    def test_a_held_loop_turned_off_gives_way_to_the_next_pick(self):
        chooser = MotionChooser(self.pack)
        replay(chooser, 1)
        chooser.send({"kind": "intent", "intent": "think", "state": "thinking"})
        replay(chooser, 1)
        self.assertEqual(chooser.playhead()[0], "think_loop")
        chooser.set_motion_overrides({"think_loop": False}, {}, {})
        after = replay(chooser, 30)
        self.assertTrue(after, "the loop is left")
        self.assertNotIn("think_loop", {c["clip"] for c in after})
        self.assertNotEqual(chooser.playhead()[0], "think_loop")


if __name__ == "__main__":
    unittest.main()
