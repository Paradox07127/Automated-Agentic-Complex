"""tools/persona_eval.py: the rule checks of one reply and the first/last segment summary."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tools import persona_eval  # noqa: E402
from tools.persona_eval import read_jsonl, rule_check, summarize  # noqa: E402


class RuleCheckTest(unittest.TestCase):
    def test_a_clean_reply_breaks_no_rule(self):
        rules = rule_check("[intent:greet]嗯，早，今天也要好好吃饭。", previous="昨晚睡得不错。")
        self.assertEqual(rules["violations"], [])
        self.assertEqual((rules["chars"], rules["intent_marker"], rules["out_of_voice"]), (13, "ok", []))

    def test_ai_self_reference(self):
        self.assertIn("ai_self_reference", rule_check("[intent:explain]作为一个AI，我没有身体。")["violations"])
        self.assertNotIn("ai_self_reference", rule_check("[intent:explain]我没有在演，我就是我。")["violations"])

    def test_markdown_heading_or_three_list_lines(self):
        self.assertTrue(rule_check("[intent:explain]## 总结\n还好。")["markdown"])
        self.assertTrue(rule_check("[intent:explain]有这些：\n- 一\n- 二\n- 三")["markdown"])
        rules = rule_check("[intent:explain]有这些：\n- 一\n- 二")
        self.assertFalse(rules["markdown"])
        self.assertNotIn("markdown_layout", rules["violations"])

    def test_assistant_phrases(self):
        rules = rule_check("[intent:offer]好的。希望对你有帮助！如果你还有其他问题请告诉我。")
        self.assertEqual(rules["assistant_phrases"], ["希望对你有帮助", "如果你还有其他问题"])
        self.assertIn("assistant_phrase", rules["violations"])
        self.assertIn("assistant_phrase", rule_check("[intent:offer]Hope so. How can I help?")["violations"])
        self.assertEqual(rule_check("[intent:offer]你忙你的，我在旁边。")["assistant_phrases"], [])

    def test_same_opening_as_the_reply_before(self):
        rules = rule_check("[intent:acknowledge]哼，真拿你没办法，去吧。", previous="哼，真拿你没办法呢。")
        self.assertTrue(rules["same_opening"])
        self.assertIn("same_opening", rules["violations"])
        self.assertFalse(rule_check("[intent:acknowledge]哼，真拿你没办法。", previous="好吧，真拿你没办法。")["same_opening"])
        self.assertFalse(rule_check("[intent:acknowledge]哼。", previous=None)["same_opening"])

    def test_leading_intent_marker(self):
        self.assertEqual(rule_check("[intent:celebrate]太好了！")["intent_marker"], "ok")
        self.assertEqual(rule_check("[intent:dance]太好了！")["intent_marker"], "invalid")
        self.assertEqual(rule_check("太好了！[intent:celebrate]")["intent_marker"], "missing")
        self.assertIn("intent_marker", rule_check("太好了！")["violations"])

    def test_checks_run_on_the_shown_text(self):
        rules = rule_check("[intent:greet][motion:waves her right hand happily|3]早。")
        self.assertEqual((rules["chars"], rules["opening"], rules["violations"]), (2, "早。", []))


def row(scenario, turn, violations, voice=None, kernel=0.01, judge_cost=0.002, seconds=2.0):
    return {"scenario": scenario, "turn": turn, "user": "u", "reply": "r",
            "rules": {"violations": violations},
            "judge": None if voice is None else {"voice": voice, "canon": 5, "no_assistant": 4, "length": 3, "reason": ""},
            "kernel_cost_usd": kernel, "judge_cost_usd": judge_cost if voice is not None else None, "seconds": seconds,
            "error": None}


class SummaryTest(unittest.TestCase):
    def test_first_ten_and_last_ten_turns_of_each_scenario(self):
        rows = [row("chat", t, ["same_opening"] if t in (2, 5) else [], voice=4) for t in range(1, 21)]
        rows[17]["rules"]["violations"] = ["assistant_phrase", "markdown_layout"]  # turn 18
        rows[19]["judge"]["voice"] = 2  # turn 20
        rows += [row("task", t, ["intent_marker"], voice=None) for t in range(1, 5)]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "turns.jsonl"
            path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
            summary = summarize(read_jsonl(path))
        chat = summary["scenarios"]["chat"]
        self.assertEqual(chat["turns"], 20)
        self.assertEqual((chat["first"]["turns"], chat["first"]["violation_rate"]), ([1, 10], 0.2))
        self.assertEqual(chat["first"]["rule_rates"]["same_opening"], 0.2)
        self.assertEqual((chat["last"]["turns"], chat["last"]["violation_rate"]), ([11, 20], 0.1))
        self.assertEqual(chat["last"]["rule_rates"],
                         {"ai_self_reference": 0, "markdown_layout": 0.1, "assistant_phrase": 0.1, "same_opening": 0,
                          "intent_marker": 0})
        self.assertEqual(chat["first"]["judge_mean"], {"voice": 4, "canon": 5, "no_assistant": 4, "length": 3})
        self.assertEqual(chat["last"]["judge_mean"]["voice"], 3.8)
        task = summary["scenarios"]["task"]
        self.assertEqual((task["first"]["violation_rate"], task["last"]["turns"], task["first"]["judge_mean"]),
                         (1.0, [1, 4], None))
        self.assertEqual((summary["kernel_cost_usd"], summary["judge_cost_usd"], summary["mean_turn_seconds"]),
                         (0.24, 0.04, 2.0))

    def test_a_turn_without_a_reply_counts_only_as_an_error(self):
        rows = [row("chat", 1, []), {**row("chat", 2, []), "rules": None, "error": "say 503"}]
        chat = summarize(rows)["scenarios"]["chat"]
        self.assertEqual((chat["turns"], chat["errors"], chat["first"]["count"]), (1, 1, 1))


class ScenariosTest(unittest.TestCase):
    def test_five_scenarios_of_forty_lines(self):
        scenarios = json.loads(persona_eval.SCENARIOS.read_text(encoding="utf-8"))
        self.assertEqual({name: len(lines) for name, lines in scenarios.items()},
                         dict.fromkeys(("chat", "task", "venting", "break_character", "out_of_world"), 40))


if __name__ == "__main__":
    unittest.main()
