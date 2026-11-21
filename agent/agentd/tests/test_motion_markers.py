"""[motion:<text>|<seconds>] markers, the generated-motion prompt rule and the C1 perform behavior."""
import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import c1  # noqa: E402
from brain import characters, persona  # noqa: E402
from brain.markers import MarkerStream  # noqa: E402

FIXTURES = Path(__file__).resolve().parents[3] / "protocol" / "C1-agent-events" / "fixtures"
WAVE = {"prompt": "waves her right hand happily", "seconds": 3.0}
PERFORM = {"event": "behavior", "seq": 4, "behavior_id": "b-gm-0123456789abcdef", "type": "perform", "target": None,
           "trigger": {"source": "agent", "event": None}, "display_session": None, "turn_id": None,
           "turn_generation": 2, "priority": 1, "expires_at_ms": 1760900010000, "intensity": 1.0,
           "channels": ["full_body"], "exit": [], "replaces": None, "trace_id": "t-1",
           "motion": {"id": "gm-0123456789abcdef", "meta_sha256": "a" * 64, "keys_sha256": "b" * 64,
                      "rig_sha256": "c" * 64, "length_s": 3.0}}


def run(chunks):
    """(text, intents, motions) of a whole reply fed chunk by chunk."""
    stream = MarkerStream()
    out = [stream.feed(chunk) for chunk in chunks] + [stream.close()]
    return "".join(text for text, _, _ in out), [i for _, found, _ in out for i in found], stream.motions


class MotionMarkerTest(unittest.TestCase):
    def test_a_valid_motion_marker_is_parsed_and_stripped(self):
        self.assertEqual(run(["[intent:greet][motion:waves her right hand happily|3]你好。"]),
                         ("你好。", ["greet"], [WAVE]))
        self.assertEqual(run(["你好[motion:waves her", " right hand happily|", "3]。"]), ("你好。", [], [WAVE]))
        long = "a slow bow " * 15  # 165 characters: longer than any other marker may be
        self.assertEqual(run([f"[motion:{long.strip()[:160]}|2.5]好"]),
                         ("好", [], [{"prompt": long.strip()[:160], "seconds": 2.5}]))

    def test_a_bad_motion_marker_is_dropped_and_still_stripped(self):
        for marker in ("[motion:" + "a" * 161 + "|3]",  # too long a text
                       "[motion:ab|3]",  # too short a text
                       "[motion:waves her right hand|0]", "[motion:waves her right hand|7]",
                       "[motion:waves her right hand|x]", "[motion:waves her right hand]",
                       "[motion:挥手|3]", "[motion:waves her right hand " + "很开心" * 20 + "|3]"):  # non-ASCII
            with self.subTest(marker=marker):
                self.assertEqual(run([f"[intent:acknowledge]{marker}好的。"]), ("好的。", ["acknowledge"], []))

    def test_a_bracket_run_past_200_characters_stays_text(self):
        text = "[motion:" + "a" * 200 + "|3]"
        self.assertEqual(run([text]), (text, [], []))

    def test_other_markers_keep_their_limit(self):
        text = "[point:" + "w" * 60 + "]"
        self.assertEqual(run([text]), (text, [], []))


class MotionPromptTest(unittest.TestCase):
    def setUp(self):
        self.card = characters.load_card("aster")

    def test_game_mode_has_no_motion_text(self):
        self.assertNotIn("motion", persona.render_persona(self.card))
        self.assertNotIn("motion", persona.render_persona(self.card, motion=False))

    def test_generated_mode_explains_the_marker_after_the_markers_text(self):
        text = persona.render_persona(self.card, motion=True)
        markers = text.split("<markers>\n", 1)[1].split("\n</markers>", 1)[0]
        self.assertTrue(markers.startswith(self.card["markers"]))
        self.assertIn("[motion:waves her right hand happily|3]", markers[len(self.card["markers"]):])

    def markers(self, phrases=None):
        text = persona.render_persona(self.card, motion=True, motion_phrases=phrases)
        return text.split("<markers>\n", 1)[1].split("\n</markers>", 1)[0]

    def test_without_phrases_the_prompt_is_unchanged(self):
        self.assertEqual(self.markers(), self.card["markers"] + "\n" + persona.MOTION_RULE)
        self.assertEqual(self.markers([]), self.markers())

    def test_the_characters_game_gestures_are_listed_to_copy(self):
        markers = self.markers(["waves her hand", "bows slightly"])
        self.assertTrue(markers.startswith(self.card["markers"] + "\n" + persona.MOTION_RULE))
        self.assertIn("waves her hand; bows slightly", markers)
        self.assertIn("copy that phrase", markers)

    def test_game_mode_lists_no_gestures(self):
        self.assertEqual(persona.render_persona(self.card, motion_phrases=["waves her hand"]),
                         persona.render_persona(self.card))

    def test_the_game_driver_offers_only_the_characters_gestures(self):
        text = persona.render_persona(self.card, motion="game", motion_phrases=["waves her hand", "bows slightly"])
        markers = text.split("<markers>\n", 1)[1].split("\n</markers>", 1)[0]
        rule = markers[len(self.card["markers"]):]
        self.assertTrue(markers.startswith(self.card["markers"] + "\n"))
        self.assertIn("[motion:waves her hand|3]", rule)
        self.assertIn("waves her hand; bows slightly", rule)
        self.assertNotIn(persona.MOTION_RULE, markers)
        self.assertNotIn("English description", rule)  # no free description under the game driver

    def test_the_game_driver_without_gestures_has_no_motion_text(self):
        for phrases in (None, []):
            with self.subTest(phrases=phrases):
                self.assertEqual(persona.render_persona(self.card, motion="game", motion_phrases=phrases),
                                 persona.render_persona(self.card))


class PerformBehaviorTest(unittest.TestCase):
    def broken(self, change):
        bad = copy.deepcopy(PERFORM)
        change(bad)
        return c1.check_message(bad)

    def test_a_perform_behavior_passes(self):
        self.assertEqual(c1.check_message(PERFORM), [])

    def test_the_motion_object_follows_the_contract(self):
        self.assertTrue(self.broken(lambda m: m.pop("motion")))
        self.assertTrue(self.broken(lambda m: m["motion"].update(id="gm-0123456789ABCDEF")))
        self.assertTrue(self.broken(lambda m: m["motion"].update(id="0123456789abcdef")))
        for key in ("meta_sha256", "keys_sha256", "rig_sha256"):
            self.assertTrue(self.broken(lambda m: m["motion"].update({key: "A" * 64})), key)
            self.assertTrue(self.broken(lambda m: m["motion"].pop(key)), key)
        for length in (0.1, 10.5, True, "3", None):
            self.assertTrue(self.broken(lambda m: m["motion"].update(length_s=length)), length)
        self.assertEqual(self.broken(lambda m: m["motion"].update(length_s=10)), [])
        self.assertTrue(self.broken(lambda m: m.update(target={"kind": "user"})))
        self.assertTrue(self.broken(lambda m: m.update(channels=["full_body", "eyes"])))

    def test_motion_on_any_other_type_is_a_problem(self):
        idle = {**PERFORM, "type": "idle"}
        self.assertTrue(c1.check_message(idle))
        idle.pop("motion")
        self.assertEqual(c1.check_message(idle), [])

    def test_the_shared_fixture_passes_and_the_invalid_sample_fails(self):
        self.assertEqual(c1.check_file(json.loads((FIXTURES / "14-perform.json").read_text(encoding="utf-8"))), [])
        self.assertTrue(c1.check_file(json.loads((FIXTURES / "invalid" / "14-perform-bad-motion.json").read_text(encoding="utf-8"))))


if __name__ == "__main__":
    unittest.main()
