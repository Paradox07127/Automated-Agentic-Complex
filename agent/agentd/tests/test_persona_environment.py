"""The persona's environment: event cues, the body on the desktop and voice input."""
import threading
import unittest
from unittest.mock import patch

import support  # noqa: F401

from brain import characters  # noqa: E402
from brain.persona import EVENT_RULE, render_persona  # noqa: E402
import test_character_agent_integration  # noqa: E402

DESKTOP = "standing on"
VOICE = "\nSent by voice: the text is speech recognition"


class RenderTest(unittest.TestCase):
    def test_the_event_rule_is_in_the_persona_with_the_cards_title(self):
        text = render_persona({**characters.load_card("aster"), "user_title": "Warden"})
        self.assertIn(EVENT_RULE.format(user="Warden"), text)
        self.assertIn("A message that starts with <event> is something that happened around you, not words from Warden", text)

    def test_an_embodied_character_stands_on_the_desktop(self):
        card = {**characters.load_card("aster"), "user_title": "Warden"}
        embodied = render_persona(card, embodied=True)
        self.assertTrue(embodied.startswith(f"You are {card['name']}, a character standing on Warden's desktop on "))
        self.assertIn("Warden can see you, click you and drag you", embodied)
        self.assertNotIn(DESKTOP, render_persona(card))
        self.assertNotIn("click you", render_persona(card))


class LiveTurnTest(unittest.TestCase):
    setUp = test_character_agent_integration.TurnContextTests.setUp

    def turn(self, source):
        self.index += 1
        answer = self.c.prepare('turn-' + str(self.index), '好', threading.Event(), self.server.turn_generation, source,
                                {'remember': True, 'reset': -1})
        self.assertIsNone(answer.error)
        return self.sessions[-1].calls[-1]

    def test_a_voice_turn_says_its_text_is_speech_recognition(self):
        self.assertIn(VOICE, self.turn('voice')['prompt'])
        self.assertNotIn(VOICE, self.turn('text')['prompt'])

    def test_the_system_prompt_follows_the_packages_body(self):
        self.assertNotIn(DESKTOP, self.turn('text')['system_prompt'])  # the fixture packages are text-only
        with patch.object(self.server.characters.package(self.server.character), 'render_enabled', True):
            self.assertIn(DESKTOP, self.turn('text')['system_prompt'])


if __name__ == "__main__":
    unittest.main()
