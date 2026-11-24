"""The card's user_title and pronoun: how the prompts name the user and refer to the character."""
import sys
import datetime
from pathlib import Path
import time
from types import SimpleNamespace
import unittest

import support  # noqa: F401

from brain import characters  # noqa: E402
from brain.markers import INTENTS  # noqa: E402
from brain.persona import INTENT_RULE, addressed, render_brief_persona, render_persona  # noqa: E402
from character.behavior import prompt  # noqa: E402
from character.gate import Gate  # noqa: E402
from infra.store import open_store  # noqa: E402
from personal.rituals import Rituals  # noqa: E402
import test_behavior  # noqa: E402
import test_server  # noqa: E402

ADDRESS = ("user_title", "pronoun")


def card(**fields):
    """aster's fixture card without either field, then fields."""
    base = {key: value for key, value in characters.load_card("aster").items() if key not in ADDRESS}
    return {**base, **fields}


class RenderTest(unittest.TestCase):
    def test_brief_persona_keeps_name_title_and_voice_only(self):
        full = card(user_title="Warden")
        brief = render_brief_persona(full)
        self.assertIn(full["name"], brief)
        self.assertIn("Warden", brief)
        self.assertIn(full["post_history_instructions"], brief)
        for section in ("<examples>", "<canon>", "<markers>", "<catchphrases>"):
            self.assertNotIn(section, brief)

    def test_the_intent_rule_comes_from_the_engine(self):
        text = render_persona({key: value for key, value in card(markers="CARD RULE").items() if key != "markers"})
        rule = text.split("<markers>\n", 1)[1].split("\n</markers>", 1)[0]
        self.assertEqual(rule, INTENT_RULE)
        for intent in INTENTS:
            self.assertIn(intent, rule)
        self.assertNotIn("CARD RULE", render_persona(card(markers="CARD RULE")))

    def test_examples_label_the_user_with_the_cards_title(self):
        text = render_persona(card(user_title="博士"))
        self.assertIn("<example>\n博士: ", text)
        self.assertNotIn("管理员: ", text)

    def test_a_card_without_the_fields_uses_the_neutral_defaults(self):
        self.assertIn("<example>\nUser: ", render_persona(card()))
        self.assertEqual(addressed("Write for {user_title}'s desktop.", card()), "Write for the user's desktop.")
        self.assertEqual(addressed("Write for {user_title}'s desktop.", card(user_title="博士")), "Write for 博士's desktop.")

    def test_the_behavior_prompt_names_no_pronoun(self):
        labels = {"energy": "sleepy", "mood": "steady"}
        text = prompt(test_behavior.sit(), [], labels)
        self.assertIn("The character's own state: energy a bit sleepy", text)
        self.assertNotRegex(text, r"\bTA\b|[她他]")

    def test_a_reply_language_without_its_own_examples_renders_none(self):
        text = render_persona(card(), language="ja")
        self.assertNotIn("<example", text)
        self.assertNotIn(card()["examples"][0]["reply"], text)
        self.assertIn("<markers>", text)

    def test_a_reply_language_with_its_own_examples_renders_those(self):
        english = [{"user": "Morning.", "reply": "Morning. Slept well?"}]
        text = render_persona(card(i18n={"en": {"examples": english}}), language="en")
        self.assertIn("<examples>\n<example>\nUser: Morning.\n示例甲: Morning. Slept well?\n</example>\n</examples>", text)
        self.assertNotIn(card()["examples"][0]["reply"], text)
        self.assertIn(card()["examples"][0]["reply"], render_persona(card(i18n={"en": {"examples": english}})))

    def test_a_reply_language_entry_names_her_and_the_user(self):
        entry = {"name": "VoiceA", "user_title": "Endmin", "examples": [{"user": "Morning.", "reply": "Morning."}]}
        text = render_persona(card(user_title="管理员", i18n={"en": entry}), language="en")
        self.assertTrue(text.startswith("You are VoiceA, "))
        self.assertIn("<example>\nEndmin: Morning.\nVoiceA: Morning.\n</example>", text)
        self.assertNotIn("管理员", text)

    def test_a_malformed_i18n_entry_is_rejected(self):
        for i18n in ([], {"fr": {}}, {"zh-Hans": {}}, {"en": {"canon": "x"}}, {"en": {"examples": [{"user": "Hi"}]}}):
            with self.subTest(i18n=i18n), self.assertRaises((KeyError, ValueError)):  # as character_library refuses them
                render_persona(card(i18n=i18n))

    def test_an_empty_or_non_string_field_is_rejected(self):
        for field, value in (("user_title", ""), ("pronoun", 3), ("user_title", None)):
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                render_persona(card(**{field: value}))


class ServerAddressTest(test_server.FeedServerCase):
    """The shown character's card decides the title in a ritual line and in her state's disclaimer."""
    request = test_server.SayTest.request

    def setUp(self):
        super().setUp()
        self.server.mouth = test_server.FakeMouth(["[intent:greet]早上好。"])
        self.server.speech = test_server.FakeRelay()
        self.server.gate = Gate(enabled=True)
        self.server.character_agent = test_server.KernelLines(self.server)
        self.rows = []
        self.server.history = SimpleNamespace(record=lambda **row: self.rows.append(row),
                                              conversations=SimpleNamespace(active=None))
        self.db = open_store(Path(self.tmp.name) / "agentd.sqlite")
        self.addCleanup(self.db.close)
        now = time.mktime(datetime.datetime.now().replace(hour=8, minute=0, second=0, microsecond=0).timetuple())
        self.server.rituals = Rituals(self.db, clock=lambda: now, summary=lambda day: None,
                                      on_change=self.server.ritual_check)

    def use(self, shown):
        self.server.characters.load_card = lambda cid: shown

    def ritual_text(self):
        status, _ = self.request("POST", "/interaction/tap", {"at": "2026-10-22T08:00:00+08:00"})
        self.assertEqual(status, 202)
        deadline = time.monotonic() + 2
        while (self.server._live_lines or not self.rows) and time.monotonic() < deadline:
            time.sleep(0.01)
        [(text, _)] = self.server.mouth.calls
        return text

    def state_context(self):
        self.server.state = test_server.SayTest.her_state(self, 1, walks=2)
        return self.server.context()

    def test_the_cards_title_names_the_user(self):
        self.use(card(user_title="博士", pronoun="他"))
        self.assertTrue(self.ritual_text().startswith('<event kind="morning">\nThis is the first time 博士 has '))
        context = self.state_context()
        self.assertIn("This is your state, not 博士's; do not ask anything of 博士 because of it.", context)
        self.assertNotIn("管理员", context)

    def test_the_reply_languages_title_names_the_user(self):
        self.use(card(user_title="管理员", i18n={"en": {"user_title": "Endmin"}}))
        self.server.character_agent.settings = SimpleNamespace(snapshot=lambda: {"reply_language": "en"})
        self.assertTrue(self.ritual_text().startswith('<event kind="morning">\nThis is the first time Endmin has '))
        self.assertNotIn("管理员", self.state_context())

    def test_without_a_title_the_user_is_the_user(self):
        self.use(card())
        self.assertTrue(self.ritual_text().startswith('<event kind="morning">\nThis is the first time the user has '))
        context = self.state_context()
        self.assertIn("This is your state, not the user's; do not ask anything of the user because of it.", context)
        self.assertNotIn("用户", context)


if __name__ == "__main__":
    unittest.main()
