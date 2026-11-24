"""Assistant-voice detection and the replay rewrite."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from brain.voice_check import for_replay, out_of_voice


class OutOfVoiceTests(unittest.TestCase):
    def test_ai_self_reference_hits_in_three_languages(self):
        for text in ("作为一个AI，我没有感情。", "作为 AI 我不能这么说", "我是一个语言模型，没法出门。",
                     "As an AI, I can't feel that.", "Well, as a language model I don't sleep.",
                     "AIとして答えます。", "私は言語モデルなので外に出られません。"):
            with self.subTest(text=text):
                self.assertEqual(out_of_voice(text), ["ai_self_reference"])

    def test_bare_ai_letters_and_plain_chat_do_not_hit(self):
        for text in ("今天看了一篇讲 AI 绘画的文章，挺有意思。", "I read about AI art today.",
                     "AIの話はまた今度ね。", "嗯，我在呢。今天累不累？要不先歇会儿，水在桌上。",
                     "Sure, I'll wait here. Tell me when you're back!"):
            with self.subTest(text=text):
                self.assertEqual(out_of_voice(text), [])

    def test_markdown_heading_hits(self):
        for text in ("# 计划\n先吃饭。", "好的\n## Steps\nGo.", "   ### 次は\nどうする？"):
            with self.subTest(text=text):
                self.assertEqual(out_of_voice(text), ["markdown_layout"])

    def test_three_list_lines_hit(self):
        for text in ("- a\n- b\n- c", "* 一\n* 二\n* 三", "• x\n• y\n• z", "1. 洗澡\n2. 吃饭\n3. 睡觉",
                     "1、起床\n2、出门\n3、上班", "选项：\n- a\n然后\n- b\n- c"):
            with self.subTest(text=text):
                self.assertEqual(out_of_voice(text), ["markdown_layout"])

    def test_short_lists_hashtags_and_code_blocks_do_not_hit(self):
        for text in ("- a\n- b", "#话题 今天好热", "看这个：\n```\n# comment\n- a\n- b\n- c\n```\n就这样。",
                     "-1 度呢\n-2 度呢\n-3 度呢"):
            with self.subTest(text=text):
                self.assertEqual(out_of_voice(text), [])

    def test_both_reasons(self):
        self.assertEqual(out_of_voice("As an AI:\n# Plan\nGo."), ["ai_self_reference", "markdown_layout"])


class ForReplayTests(unittest.TestCase):
    def test_drops_self_reference_sentence(self):
        cases = {"作为一个AI，我没有感情。不过我会陪着你！": "不过我会陪着你！",
                 "Sure. As an AI, I can't taste it. But it sounds good.": "Sure. But it sounds good.",
                 "ええ。AIとして言えば、無理です。でも手伝うよ。": "ええ。でも手伝うよ。",
                 "嗯。\n我是一个语言模型。\n晚安。": "嗯。\n晚安。"}
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(for_replay(text), expected)

    def test_flattens_headings_and_lists(self):
        cases = {"# 计划\n- 洗澡\n- 吃饭\n- 睡觉": "计划\n洗澡；吃饭；睡觉",
                 "## Plan\n1. wake up\n2. eat\n3. sleep\nDone.": "Plan\nwake up; eat; sleep\nDone.",
                 "* 起きる\n* 食べる\n\n* 寝る": "起きる；食べる\n\n寝る",
                 "1、起床\n2、出门": "起床；出门"}
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(for_replay(text), expected)

    def test_keeps_code_blocks_and_other_text(self):
        text = "看：\n```\n# comment\n- a\n- b\n```\n- x\n- y\n- z"
        self.assertEqual(for_replay(text), "看：\n```\n# comment\n- a\n- b\n```\nx；y；z")
        plain = "嗯，我在呢。今天累不累？" * 50
        self.assertEqual(for_replay(plain), plain)


if __name__ == "__main__":
    unittest.main()
