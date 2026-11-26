"""Reply-language detection and the per-turn tag."""
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from brain.language import SETTINGS, SUPPORTED, SYSTEM_RULE, ReplyLanguage, detect, mismatch


class DetectTests(unittest.TestCase):
    def test_plain_chinese_is_simplified_chinese(self):
        self.assertEqual(detect("今天下午帮我整理一下会议记录"), "zh-Hans")

    def test_chinese_mixed_with_english_terms_stays_chinese(self):
        self.assertEqual(detect("帮我看下这个 build error"), "zh-Hans")

    def test_kana_is_japanese(self):
        self.assertEqual(detect("このファイルを開いてください"), "ja")
        self.assertEqual(detect("今日はいい天気ですね"), "ja")

    def test_english_sentence_is_english(self):
        self.assertEqual(detect("Can you check why the build failed?"), "en")

    def test_short_or_empty_text_is_undecided(self):
        for text in ("ok", "", "   ", "好", "42", "ok thanks"):
            with self.subTest(text=text):
                self.assertIsNone(detect(text))

    def test_code_alone_is_undecided(self):
        self.assertIsNone(detect("```python\ndef build_error_report(path):\n    return open(path).read()\n```"))
        self.assertIsNone(detect("`git rebase --onto main feature branch`"))

    def test_a_url_does_not_count(self):
        self.assertIsNone(detect("https://zh.wikipedia.org/wiki/中文维基百科"))
        self.assertEqual(detect("look at this page https://zh.wikipedia.org/wiki/中文维基百科 please"), "en")


class MismatchTests(unittest.TestCase):
    def test_a_clear_other_language_is_a_mismatch(self):
        self.assertTrue(mismatch("zh-Hans", "Can you check why the build failed?"))
        self.assertTrue(mismatch("en", "今天下午帮我整理一下会议记录"))
        self.assertTrue(mismatch("zh-Hans", "このファイルを開いてください"))

    def test_the_same_language_or_undecided_text_is_not(self):
        self.assertFalse(mismatch("en", "Can you check why the build failed?"))
        self.assertFalse(mismatch("ja", "今日はいい天気ですね"))
        for text in ("ok", "", "```python\ndef f(): pass\n```"):
            with self.subTest(text=text):
                self.assertFalse(mismatch("zh-Hans", text))


class InitialPinTests(unittest.TestCase):
    def test_auto_starts_in_the_app_language_whatever_the_system_languages(self):
        for languages in (None, "en-US", "ja-JP,zh-Hans-CN", "fr-FR"):
            with self.subTest(languages=languages), patch.dict(os.environ, {} if languages is None else {"AAC_SYSTEM_LANGUAGES": languages}):
                self.assertEqual(ReplyLanguage().current("auto"), "zh-Hans")


class ReplyLanguageTests(unittest.TestCase):
    def test_constants(self):
        self.assertEqual(SUPPORTED, {"zh-Hans": "Simplified Chinese", "en": "English", "ja": "Japanese"})
        self.assertEqual(SETTINGS, ("auto", "zh-Hans", "en", "ja", "harness"))
        self.assertIn("<reply_language>", SYSTEM_RULE)

    def test_auto_starts_in_chinese_and_follows_clear_messages_only(self):
        lang = ReplyLanguage()
        self.assertEqual(lang.current("auto"), "zh-Hans")
        lang.observe("auto", "Can you check why the build failed?")
        self.assertEqual(lang.current("auto"), "en")
        self.assertEqual(lang.tag("auto"), "<reply_language>English</reply_language>")
        lang.observe("auto", "ok")
        self.assertEqual(lang.current("auto"), "en")
        lang.observe("auto", "このファイルを開いてください")
        self.assertEqual(lang.tag("auto"), "<reply_language>Japanese</reply_language>")
        lang.observe("auto", "帮我看下这个 build error")
        self.assertEqual(lang.tag("auto"), "<reply_language>Simplified Chinese</reply_language>")

    def test_a_fixed_setting_ignores_messages(self):
        lang = ReplyLanguage()
        lang.observe("ja", "Can you check why the build failed?")
        self.assertEqual(lang.current("ja"), "ja")
        self.assertEqual(lang.tag("en"), "<reply_language>English</reply_language>")
        self.assertEqual(lang.current("auto"), "zh-Hans")

    def test_harness_sends_no_language(self):
        lang = ReplyLanguage()
        lang.observe("harness", "Can you check why the build failed?")
        self.assertIsNone(lang.current("harness"))
        self.assertEqual(lang.tag("harness"), "")
        self.assertEqual(lang.current("auto"), "zh-Hans")


class LocalizedCardTests(unittest.TestCase):
    CARD = {"name": "N", "examples": [{"user": "你好", "reply": "嗯。"}], "tone_rules": ["短句"],
            "i18n": {"en": {"examples": [{"user": "Hi", "reply": "Hm."}], "tone_rules": ["Short lines"], "canon": "x"}}}

    def test_the_base_language_and_harness_keep_the_card(self):
        from brain.persona import localized
        self.assertIs(localized(self.CARD, "zh-Hans"), self.CARD)
        self.assertIs(localized(self.CARD, None), self.CARD)

    def test_an_entry_overrides_only_localized_fields(self):
        from brain.persona import localized
        card = localized(self.CARD, "en")
        self.assertEqual((card["examples"][0]["user"], card["tone_rules"]), ("Hi", ["Short lines"]))
        self.assertNotIn("canon", card)

    def test_examples_fall_back_to_base_card_when_omitted(self):
        from brain.persona import localized
        card = localized(self.CARD, "ja")
        self.assertEqual((card["examples"], card["tone_rules"]), (self.CARD["examples"], ["短句"]))


if __name__ == "__main__":
    unittest.main()
