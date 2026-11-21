"""HEDGE: a claim that something is not the user's, whatever the card calls the user, is a hedge."""
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_agent.services.memory_pipeline import HEDGE


class HedgeTest(unittest.TestCase):
    def test_any_title_for_the_user_is_a_hedge(self):
        for title in ("用户", "管理员", "博士", "主人"):
            self.assertTrue(HEDGE.search(f"这不是{title}的偏好"), title)

    def test_a_plain_preference_is_no_hedge(self):
        self.assertIsNone(HEDGE.search("博士喜欢早上开会，不是下午"))

    def test_common_english_hedges_are_hedges(self):
        for text in ("Maybe prefers tea in the morning", "probably fixed the build", "the user might like dark mode",
                     "I think the tests pass", "It seems the port moved", "not sure the deploy finished"):
            self.assertTrue(HEDGE.search(text), text)

    def test_plain_english_and_words_holding_a_hedge_are_no_hedge(self):
        for text in ("prefers tea in the morning", "the mighty build server", "fixed the seemsless typo",
                     "I thinker", "notsure.txt was renamed"):
            self.assertIsNone(HEDGE.search(text), text)


if __name__ == "__main__":
    unittest.main()
