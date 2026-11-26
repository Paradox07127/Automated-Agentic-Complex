from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from voice.clauses import ClauseSplitter, _sounded  # noqa: E402


def whole(text, language="zh"):
    splitter = ClauseSplitter(language)
    return splitter.feed(text) + splitter.close()


def char_by_char(text, language="zh"):
    splitter = ClauseSplitter(language)
    out = []
    for char in text:
        out += splitter.feed(char)
    return out + splitter.close()


def in_pieces(text, language="zh", size=7):
    splitter = ClauseSplitter(language)
    out = []
    for start in range(0, len(text), size):
        out += splitter.feed(text[start:start + size])
    return out + splitter.close()


class ClauseSplitterTest(unittest.TestCase):
    def test_short_clauses_join_the_next(self):
        # 嗯， and 好的。 are each under 5 characters: neither goes alone.
        splitter = ClauseSplitter("zh")
        self.assertEqual(splitter.feed("嗯，好的。我们先看看报错吧。"), ["嗯，好的。我们先看看报错吧。"])
        self.assertEqual(splitter.close(), [])
        self.assertEqual(whole("嗯，我们先看看报错吧。然后再说。"), ["嗯，我们先看看报错吧。", "然后再说。"])

    def test_sentence_and_comma_boundaries(self):
        splitter = ClauseSplitter("zh")
        self.assertEqual(splitter.feed("我们先看看报错，然后再修代码。好"), ["我们先看看报错，", "然后再修代码。"])
        self.assertEqual(splitter.feed("吗？"), [])
        self.assertEqual(splitter.close(), ["好吗？"])
        self.assertEqual(whole("真的吗？！好的……那就这样吧。"), ["真的吗？！好的……", "那就这样吧。"])

    def test_japanese_needs_four_kana(self):
        text = "うん、そうですね、すぐに確認します。"
        self.assertEqual(whole(text, "ja"), ["うん、そうですね、", "すぐに確認します。"])
        self.assertEqual(whole("そうだね、すぐに確認します。", "ja"), ["そうだね、", "すぐに確認します。"])

    def test_a_grouped_number_or_a_time_stays_in_one_clause(self):
        for split in (whole, char_by_char):
            with self.subTest(split.__name__):
                self.assertEqual(split("目前一共有1,024个测试通过。"), ["目前一共有1,024个测试通过。"])
                self.assertEqual(split("我们约在下午3:30见面吧。"), ["我们约在下午3:30见面吧。"])
                self.assertEqual(split("一共有三个测试, 然后再说。"), ["一共有三个测试, ", "然后再说。"])

    def test_english_sentences_end_at_a_full_stop(self):
        splitter = ClauseSplitter("en")
        self.assertEqual(splitter.feed("The build passed. I ran all the tests. Then I wrote the report. "),
                         ["The build passed. ", "I ran all the tests. ", "Then I wrote the report. "])
        self.assertEqual(splitter.close(), [])
        self.assertEqual(char_by_char("Pi is 3.14 today. Version 1.2. Then more.", "en"),
                         ["Pi is 3.14 today. ", "Version 1.2. Then more."])

    def test_full_reply_streams_without_a_word_count_cutoff(self):
        clause = "甲" * 19 + "，"
        self.assertEqual(whole(clause * 3 + "乙。"), [clause, clause, clause, "乙。"])
        long_text = ("我先看了一下报错信息，问题出在配置文件里。端口号被写成了字符串，所以服务启动失败了。"
                     "我已经把它改回数字，然后重新跑了一遍测试，现在全部通过了。")
        self.assertEqual("".join(in_pieces(long_text)), long_text)

    def test_an_english_word_counts_as_one(self):
        text = ("我看了一下README和package.json里的dependencies字段，发现lodash和express的版本号写错了，"
                "需要改成package-lock.json里锁定的版本再重新安装。")
        self.assertGreater(len(text), 90)
        self.assertEqual("".join(in_pieces(text)), text)

    def test_close_gives_out_the_rest(self):
        splitter = ClauseSplitter("zh")
        self.assertEqual(splitter.feed("我们先看看报错吧。然后"), ["我们先看看报错吧。"])
        self.assertEqual(splitter.close(), ["然后"])
        self.assertEqual(splitter.close(), [])

    def test_sentence_end_cuts_without_waiting_for_the_next_character(self):
        splitter = ClauseSplitter("zh")
        self.assertEqual(splitter.feed("我们先看看报错吧。"), ["我们先看看报错吧。"])
        self.assertEqual(ClauseSplitter("zh").feed("真的是这样吗？"), ["真的是这样吗？"])
        self.assertEqual(ClauseSplitter("ja").feed("すぐ確認します!"), ["すぐ確認します!"])

    def test_punctuation_after_a_cut_sentence_end_starts_the_next_clause(self):
        splitter = ClauseSplitter("zh")
        self.assertEqual(splitter.feed("我们先看看报错吧！"), ["我们先看看报错吧！"])
        self.assertEqual(splitter.feed("」"), [])
        self.assertEqual(splitter.feed("好的。"), [])
        self.assertEqual(splitter.close(), ["」好的。"])
        self.assertEqual(whole("真的是这样吗？！好的。"), ["真的是这样吗？", "！好的。"])

    def test_closers_fed_with_a_sentence_end_go_with_it(self):
        splitter = ClauseSplitter("zh")
        self.assertEqual(splitter.feed("「我们先看看报错吧。」然后说"), ["「我们先看看报错吧。」"])
        self.assertEqual(splitter.close(), ["然后说"])
        self.assertEqual(whole("「我们先看看报错，」他说。"), ["「我们先看看报错，」", "他说。"])

    def test_closers_are_not_sounded(self):
        self.assertEqual(_sounded("」”）"), 0)

    def test_comma_still_waits_for_the_next_character(self):
        splitter = ClauseSplitter("zh")
        self.assertEqual(splitter.feed("我们先看看报错，"), [])
        self.assertEqual(splitter.feed("然"), ["我们先看看报错，"])
        self.assertEqual(ClauseSplitter("zh").feed("我们先看看报错……"), [])

    def test_fed_a_character_at_a_time_cuts_the_same(self):
        texts = [("嗯，好的。我们先看看报错吧。", "zh"), ("嗯，我们先看看报错吧。然后再说。", "zh"),
                 ("真的吗？！好的……那就这样吧。", "zh"), ("そうですね、すぐに確認します。少し待ってね。", "ja"),
                 ("甲" * 19 + "，" + "乙" * 19 + "，" + "丙" * 19 + "。", "zh"),
                 ("甲" * 30 + "，" + "乙" * 30 + "。后面。", "zh"), ("好的，" + "乙" * 60 + "。", "zh"),
                 ("丙" * 70, "zh"),
                 ("先说结论：可以！ 理由如下, 第一; 第二.", "zh"),
                 ("真的是这样吗？！」好的，我们先看看报错吧。", "zh")]
        for text, language in texts:
            with self.subTest(text=text):
                self.assertEqual(char_by_char(text, language), whole(text, language))


def every_cut(test, text, expected):
    """The clauses of `text` are `expected` however the stream cuts it."""
    test.assertEqual(whole(text), expected)
    test.assertEqual(char_by_char(text), expected)
    for size in range(2, 9):
        with test.subTest(size=size):
            test.assertEqual(in_pieces(text, size=size), expected)


class MarkdownIsNotSpokenTest(unittest.TestCase):
    def test_a_code_fence_is_not_spoken_and_does_not_count_to_the_limit(self):
        code = "```python\n" + "total = add(1, 2);\n" * 30 + "```"
        every_cut(self, "我们先看这段代码：" + code + "\n这样就行了。",
                  ["我们先看这段代码：\n", "这样就行了。"])
        every_cut(self, "好的，管理员。" + code + "这样就行了，" + code + "你试试吧。",
                  ["好的，管理员。", "这样就行了，", "你试试吧。"])

    def test_an_unclosed_code_fence_leaves_the_rest_unspoken(self):
        every_cut(self, "我们先看这段代码吧。```python\nprint(1)。\n后面的话。", ["我们先看这段代码吧。"])

    def test_inline_code_is_spoken_without_its_backticks(self):
        every_cut(self, "先运行`npm test`就行，然后看结果。", ["先运行npm test就行，", "然后看结果。"])

    def test_a_link_says_its_text_and_a_bare_address_is_not_spoken(self):
        every_cut(self, "详见[说明 文档](https://example.com/a b)，然后再试。", ["详见说明 文档，", "然后再试。"])
        every_cut(self, "地址是https://example.com/a?b=1，打开看看吧。", ["地址是，打开看看吧。"])
        every_cut(self, "打开 http://example.com/x 就能看到结果。", ["打开  就能看到结果。"])

    def test_a_table_is_not_spoken(self):
        every_cut(self, "结果如下：\n| 名称 | 数量 |\n|---|---|\n| 苹果 | 3 |\n一共三个。", ["结果如下：\n一共三个。"])

    def test_heading_list_and_emphasis_marks_are_not_spoken(self):
        every_cut(self, "## 步骤\n1. 先**安装**依赖；\n- 再运行_测试_。\n* 最后*看看*结果。",
                  ["步骤\n先安装依赖；\n", "再运行测试。", "\n最后看看结果。"])
        every_cut(self, "把max_size改成2 * 3就行了。", ["把max_size改成2 * 3就行了。"])

    def test_a_reply_of_code_only_has_no_clause(self):
        every_cut(self, "```python\nprint(1)\n```\n", [])


if __name__ == "__main__":
    unittest.main()
