"""The authored-gesture catalog a [motion:] text is matched against, and the phrase table's precision on the route test set."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from motion import catalog  # noqa: E402

PACKAGES = Path(__file__).resolve().parent / "fixtures" / "motion-catalog"  # <id>/runtime/characters/<id>/c7/animation
CHARACTERS = ("birch", "aster")


def package(root, actions, clips):
    animation = Path(root) / "runtime" / "characters" / "x" / "c7" / "animation"
    animation.mkdir(parents=True)
    (animation / "actions.json").write_text(json.dumps({"schema": "endfield-character-actions-v1", "actions": actions}), encoding="utf-8")
    (animation / "clip-catalog.json").write_text(json.dumps({"schema": "endfield-clip-catalog-v1", "clips": clips}), encoding="utf-8")


class LoadTest(unittest.TestCase):
    def test_only_released_gestures_of_at_most_8_s_are_in(self):
        with tempfile.TemporaryDirectory() as root:
            package(root, [
                {"id": "wave", "section": "talk", "clips": ["a", "b"]},
                {"id": "gift", "section": "touch", "clips": ["a"], "duration": 5.5},
                {"id": "walk", "section": "move", "clips": ["a"]},
                {"id": "seat", "section": "idle", "clips": None, "command": "seat", "duration": 12},
                {"id": "turn", "section": "react", "clips": ["a"], "unavailable_reason": "not yet"},
                {"id": "long", "section": "idle", "clips": ["long"]},
                {"id": "lost", "section": "idle", "clips": ["a", "missing"]},
                {"id": "none", "section": "idle", "clips": []},
            ], [{"name": "a", "length": 1.25}, {"name": "b", "length": 2.0}, {"name": "long", "length": 8.5}])
            self.assertEqual(catalog.load(root), {"wave": {"length_s": 3.25, "clips": ["a", "b"], "gestures": []},
                                                  "gift": {"length_s": 5.5, "clips": ["a"], "gestures": []}})

    def test_a_package_without_animation_files_has_no_gestures(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertEqual(catalog.load(root), {})
            self.assertEqual(catalog.load(Path(root) / "missing"), {})

    def test_a_package_with_gestures_lists_them_on_every_row(self):
        with tempfile.TemporaryDirectory() as root:
            package(root, [
                {"id": "hello", "section": "talk", "clips": ["a"], "gestures": ["wave", "bow"]},
                {"id": "plain", "section": "idle", "clips": ["a"]},
            ], [{"name": "a", "length": 1.25}])
            self.assertEqual(catalog.load(root), {"hello": {"length_s": 1.25, "clips": ["a"], "gestures": ["wave", "bow"]},
                                                  "plain": {"length_s": 1.25, "clips": ["a"], "gestures": []}})

    def test_the_released_characters_keep_moves_commands_and_long_clips_out(self):
        for cid in CHARACTERS:
            with self.subTest(cid=cid):
                found = catalog.load(PACKAGES / cid)
                actions = json.loads(next((PACKAGES / cid).glob("runtime/characters/*/c7/animation/actions.json"))
                                     .read_text(encoding="utf-8"))["actions"]
                kept = [a for a in actions if a["id"] in found]
                self.assertTrue(kept)
                self.assertFalse([a["id"] for a in kept if a["section"] == "move" or a.get("command")
                                  or a.get("unavailable_reason")])
                self.assertLessEqual(max(row["length_s"] for row in found.values()), catalog.MAX_LENGTH)
                self.assertNotIn("dialog_state_censure_start", found)  # 13.3 s


class MatchTest(unittest.TestCase):
    def setUp(self):
        self.catalogs = {cid: catalog.load(PACKAGES / cid) for cid in CHARACTERS}

    def test_every_group_has_a_member_in_some_character(self):
        self.assertEqual([g["group"] for g in catalog.GROUPS
                          if not any(catalog.members(g, found) for found in self.catalogs.values())], [])

    def test_each_listed_phrase_matches_its_own_group(self):
        for cid, found in self.catalogs.items():
            for group in catalog.GROUPS:
                if group["en"] in catalog.phrases(found):
                    with self.subTest(cid=cid, group=group["group"]):
                        self.assertEqual(catalog.match(group["en"], 3, found)[1], group["group"])

    def test_the_phrase_list_is_the_characters_own(self):
        self.assertIn("bows slightly", catalog.phrases(self.catalogs["aster"]))
        self.assertNotIn("bows slightly", catalog.phrases(self.catalogs["birch"]))
        self.assertEqual(catalog.phrases({}), [])

    def test_near_misses_do_not_match(self):
        for cid, found in self.catalogs.items():
            with self.subTest(cid=cid):
                self.assertIsNone(catalog.match("points her toes and does a ballet spin", 4, found))
                hit = catalog.match("touches her earpiece and listens", 2, found)
                self.assertEqual(hit[:2], ("dialog_virtual_state_earphone_start", "listen_earphone"))

    def test_the_route_test_set_matches_with_precision_of_at_least_0_95(self):
        tp = fp = fn = 0
        cases = [json.loads(line) for line in (PACKAGES / "testset.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(cases) * len(CHARACTERS), 228)
        for case in cases:
            for cid in CHARACTERS:
                hit = catalog.match(case["prompt"], case["seconds"], self.catalogs[cid])
                expected = case["expected"][cid]
                if hit is None:
                    fn += expected != "generate"
                elif expected != "generate" and hit[0] in expected:
                    tp += 1
                else:
                    fp += 1
        self.assertGreaterEqual(tp / (tp + fp), 0.95, (tp, fp, fn))
        self.assertGreaterEqual(tp / (tp + fn), 0.95, (tp, fp, fn))


class GesturesTest(unittest.TestCase):
    def load(self, actions):
        with tempfile.TemporaryDirectory() as root:
            package(root, actions, [{"name": "a", "length": 1.0}, {"name": "b", "length": 3.0}])
            return catalog.load(root)

    def test_rows_outside_the_phrase_table_match_by_their_gestures(self):
        found = self.load([
            {"id": "greet_short", "section": "talk", "clips": ["a"], "gestures": ["wave"]},
            {"id": "greet_long", "section": "talk", "clips": ["b"], "gestures": ["wave", "bow"]},
            {"id": "dialog_single_wave", "section": "talk", "clips": ["a"]},
        ])
        self.assertEqual(catalog.match("she waves at you", 3, found), ("greet_long", "wave", 3.0))
        self.assertEqual(catalog.match("she waves at you", 1, found), ("greet_short", "wave", 1.0))
        self.assertEqual(catalog.named("Bows slightly.", 1, found), ("greet_long", "bow", 3.0))
        self.assertIsNone(catalog.match("nods her head", 1, found))
        self.assertEqual(catalog.phrases(found), ["waves her hand", "bows slightly"])

    def test_a_package_with_gestures_ignores_the_phrase_table_ids(self):
        found = self.load([
            {"id": "dialog_single_wave", "section": "talk", "clips": ["a"]},
            {"id": "greet", "section": "talk", "clips": ["b"], "gestures": ["bow"]},
        ])
        self.assertIsNone(catalog.match("she waves at you", 1, found))
        self.assertEqual(catalog.phrases(found), ["bows slightly"])

    def test_a_package_without_gestures_matches_nothing(self):
        found = self.load([
            {"id": "dialog_single_wave", "section": "talk", "clips": ["a"]},
            {"id": "greet", "section": "talk", "clips": ["b"]},
        ])
        self.assertIsNone(catalog.match("she waves at you", 3, found))
        self.assertIsNone(catalog.named("waves her hand", 3, found))
        self.assertEqual(catalog.phrases(found), [])

    def test_an_equal_length_tie_plays_the_first_row(self):
        found = self.load([
            {"id": "row_one", "section": "talk", "clips": ["a"], "gestures": ["wave"]},
            {"id": "row_two", "section": "talk", "clips": ["a"], "gestures": ["wave"]},
        ])
        self.assertEqual(catalog.match("she waves at you", 1, found), ("row_one", "wave", 1.0))


if __name__ == "__main__":
    unittest.main()
