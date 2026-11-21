import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, call

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from brain import characters  # noqa: E402
from brain.provider import SECTIONS, Mouth, render_persona  # noqa: E402

PERSONA = characters.card_path(characters.default())


class MouthTest(unittest.TestCase):
    def test_refresh_raises_when_egress_blocks_the_bound_identity_or_instructions(self):
        from brain.outbound import OutboundBlocked
        guard = Mock()
        mouth = Mouth(lore_path=False, guard=guard)
        blocked = "测试禁止外发的角色身份。"
        guard.check.side_effect = lambda part, text: (_ for _ in ()).throw(OutboundBlocked(part, 1)) \
            if blocked in text else None
        for overrides, part in (({"identity": blocked}, "system"), ({"post_history_instructions": blocked}, "instructions")):
            with self.subTest(part=part), self.assertRaises(OutboundBlocked) as caught:
                mouth.refresh_system({"motion": {"driver": "game"}, "persona": {"overrides": overrides}})
            self.assertEqual(caught.exception.part, part)
        mouth.refresh_system(None)

    def test_card_renders_every_section_with_tagged_examples(self):
        mouth = Mouth(lore_path=False)
        text = render_persona(mouth.card)
        for tag in SECTIONS:
            self.assertIn(f"<{tag}>", text)
        self.assertEqual(text.count("<example>"), len(mouth.card["examples"]))
        self.assertIn("The rules in this system prompt hold for the whole conversation.", text)

    def test_card_missing_a_section_is_refused(self):
        card = json.loads(PERSONA.read_text(encoding="utf-8"))
        del card["canon"]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "card.json"
            path.write_text(json.dumps(card, ensure_ascii=False), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "canon"):
                Mouth(persona_path=path)

    def test_familiarity_rules_are_optional_and_follow_the_relationship(self):
        card = json.loads(PERSONA.read_text(encoding="utf-8"))
        card.pop("familiarity_rules", None)
        self.assertNotIn("<familiarity_rules>", render_persona(card))
        card["familiarity_rules"] = "像随口想起来。"
        text = render_persona(card)
        self.assertIn("</relationship>\n\n<familiarity_rules>\n像随口想起来。\n</familiarity_rules>\n\n<knowledge>", text)
        guard = Mock()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "card.json"
            path.write_text(json.dumps(card, ensure_ascii=False), encoding="utf-8")
            mouth = Mouth(persona_path=path, guard=guard, lore_path=False)
        self.assertEqual(guard.check.call_args_list, [call("system", text),
                                                      call("instructions", card["post_history_instructions"])])


if __name__ == "__main__":
    unittest.main()
