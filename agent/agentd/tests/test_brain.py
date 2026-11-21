from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from brain.markers import INTENTS, MarkerStream  # noqa: E402
from brain.parser import parse_command  # noqa: E402


def run(chunks):
    stream = MarkerStream()
    out = [stream.feed(chunk) for chunk in chunks] + [stream.close()]
    return "".join(text for text, _, _ in out), [i for _, i, _ in out for i in i], \
        [p for _, _, p in out for p in p]


class MarkerStreamTest(unittest.TestCase):
    def test_whitelisted_intent_is_lifted_out_of_the_text(self):
        self.assertEqual(run(["[intent:offer]要我看看吗？"]), ("要我看看吗？", ["offer"], []))

    def test_marker_split_across_chunks(self):
        self.assertEqual(run(["好的", "[int", "ent:acknow", "ledge]", "，马上。"]),
                         ("好的，马上。", ["acknowledge"], []))

    def test_unknown_intent_and_unknown_marker_are_dropped(self):
        self.assertEqual(run(["[intent:run_shell]嗯[mood:happy]。"]), ("嗯。", [], []))

    def test_points_by_coordinate_or_window(self):
        self.assertEqual(run(["看这里[point:120,-40]和[point:w42]"]),
                         ("看这里和", [], [{"x": 120, "y": -40}, {"window": "w42"}]))
        self.assertEqual(run(["[point:1,2,3]"]), ("", [], []))

    def test_plain_brackets_stay_text(self):
        self.assertEqual(run(["数组 [1, 2] 和 [注] 保留"]), ("数组 [1, 2] 和 [注] 保留", [], []))

    def test_markdown_link_is_its_label(self):
        link = "喏，[summary.md](../outputs/run-1/summary.md) 已生成。"
        self.assertEqual(run([link]), ("喏，summary.md 已生成。", [], []))
        self.assertEqual(run([link[i:i + 6] for i in range(0, len(link), 6)]), ("喏，summary.md 已生成。", [], []))
        self.assertEqual(run(["见 [summary.md]", "(a/b.md) 和 [注] (2)"]), ("见 summary.md 和 [注] (2)", [], []))
        self.assertEqual(run(["[a](b c)"]), ("[a](b c)", [], []))

    def test_unclosed_bracket_is_flushed_as_text(self):
        self.assertEqual(run(["结尾[intent:of"]), ("结尾[intent:of", [], []))
        self.assertEqual(run(["[" + "很长" * 40]), ("[" + "很长" * 40, [], []))

    def test_whitelist_is_the_c1_enum(self):
        self.assertEqual(INTENTS, {"none", "idle", "listen", "think", "greet", "acknowledge", "explain",
                                   "offer", "uncertain", "reassure", "celebrate", "apologize"})


class ParseCommandTest(unittest.TestCase):
    def test_commands(self):
        cases = {"停下": {"action": "stop"}, "别说了。": {"action": "stop"},
                 "拒绝": {"action": "deny"}, "示例甲，不批准": {"action": "deny"},
                 "静音": {"action": "mute"}, "取消静音！": {"action": "unmute"},
                 "打开 Safari": {"action": "open", "target": "Safari"},
                 "请跳到 codex 会话": {"action": "jump", "target": "codex 会话"},
                 "切到终端吧": {"action": "jump", "target": "终端"},
                 "打开备忘录": {"action": "open", "target": "备忘录"},
                 "打开 Visual Studio Code": {"action": "open", "target": "Visual Studio Code"},
                 "示例甲，打开微信吧": {"action": "open", "target": "微信"},
                 "看一下": {"action": "look"}, "示例甲，你看看这个": {"action": "look"},
                 "帮我看一眼。": {"action": "look"},
                 "停止任务": {"action": "stop_task"}, "示例甲，取消任务。": {"action": "stop_task"},
                 "别做了吧": {"action": "stop_task"}}
        for text, expected in cases.items():
            self.assertEqual(parse_command(text), expected, text)

    def test_english_and_japanese_commands(self):
        cases = {"Stop.": {"action": "stop"}, "stop talking": {"action": "stop"}, "Be quiet!": {"action": "stop"},
                 "止まって": {"action": "stop"}, "やめて。": {"action": "stop"}, "静かにしてください": {"action": "stop"},
                 "Deny": {"action": "deny"}, "reject it": {"action": "deny"}, "拒否": {"action": "deny"},
                 "却下して": {"action": "deny"},
                 "Mute, please": {"action": "mute"}, "unmute": {"action": "unmute"}, "ミュートして": {"action": "mute"},
                 "ミュート解除": {"action": "unmute"},
                 "Stop the task.": {"action": "stop_task"}, "cancel the task": {"action": "stop_task"},
                 "タスクを止めて": {"action": "stop_task"}, "作業をやめて": {"action": "stop_task"},
                 "Take a look": {"action": "look"}, "please look at this": {"action": "look"},
                 "ちょっと見て": {"action": "look"}, "これを見てください": {"action": "look"},
                 "Open Safari": {"action": "open", "target": "Safari"},
                 "open Visual Studio Code.": {"action": "open", "target": "Visual Studio Code"},
                 "Switch to the terminal": {"action": "jump", "target": "terminal"},
                 "go to codex session": {"action": "jump", "target": "codex session"},
                 "Safariを開いて": {"action": "open", "target": "Safari"},
                 "ターミナルに切り替えて": {"action": "jump", "target": "ターミナル"},
                 "ask Codex to run the tests": {"action": "dispatch", "target": "codex", "prompt": "run the tests"},
                 "Have claude summarize the README.": {"action": "dispatch", "target": "claude",
                                                       "prompt": "summarize the README"},
                 "codexにテストを直させて": {"action": "dispatch", "target": "codex", "prompt": "テストを直させて"}}
        for text, expected in cases.items():
            self.assertEqual(parse_command(text), expected, text)

    def test_ordinary_english_and_japanese_sentences_go_to_the_llm(self):
        for text in ("I don't want to stop", "take a look at this error, what does it mean?", "open", "open it",
                     "open the file and tell me line 3", "open warehouse.txt", "switch to what?", "ask claude",
                     "ask me later", "how do I mute Slack?", "止まらないで", "これは何を開いていますか",
                     "このファイルを開いて", "claudeに聞いたら分かった", "見てないよ"):
            self.assertIsNone(parse_command(text), text)

    def test_ordinary_sentences_go_to_the_llm(self):
        for text in ("我不想停下来", "批准一下吧", "打开", "今天天气怎么样", "你能拒绝我吗", "",
                     "看一下这个报错是什么意思", "打开 warehouse.txt 看看，C区和D区一共多少箱？",
                     "打开备忘录，帮我记一下明天开会", "打开 Safari 能看到什么？", "打开这个文件告诉我第三行写了什么",
                     "切到终端然后帮我跑一下测试", "跳到第三章讲了什么", "打开 warehouse.txt"):
            self.assertIsNone(parse_command(text), text)

    def test_remind_only_when_the_line_opens_with_it(self):
        cases = {"提醒我十分钟后喝水": "提醒我十分钟后喝水", "示例甲，提醒我明天8点开会": "提醒我明天8点开会"}
        for text, core in cases.items():
            self.assertEqual(parse_command(text), {"action": "remind", "text": core}, text)
        self.assertIsNone(parse_command("你上次提醒我的事"))

    def test_dispatch_keeps_every_line_of_its_prompt(self):
        cases = {"让 claude 修一下": ("claude", "修一下"), "让codex，查一下测试": ("codex", "查一下测试"),
                 "让 claude 修一下\n第二行": ("claude", "修一下\n第二行")}
        for text, (target, prompt) in cases.items():
            self.assertEqual(parse_command(text), {"action": "dispatch", "target": target, "prompt": prompt}, text)


if __name__ == "__main__":
    unittest.main()
