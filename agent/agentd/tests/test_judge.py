import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from character.judge import Judge, RulesBackend  # noqa: E402

QUESTIONS = [
    {"id": "speak", "type": "yes_no", "text": "要不要开口？"},
    {"id": "next", "type": "choice", "text": "下次多久再看？", "options": ["30s", "2min", "never"]},
    {"id": "salience", "type": "score", "text": "事件多显著？", "scale": [0, 10]},
]


class FakeBackend:
    name = "fake"

    def __init__(self, answers=None, error=None):
        self.answers, self.error, self.calls = answers, error, []

    def answer(self, state, questions):
        self.calls.append((state, questions))
        if self.error:
            raise self.error
        return self.answers


class JudgeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.log = Path(self.tmp.name) / "judge.jsonl"

    def tearDown(self):
        self.tmp.cleanup()

    def lines(self):
        return [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()]

    def test_log_retention_on_start_and_hourly(self):
        now = [1792300000.0]
        rows = [{"ts": now[0] - 7 * 86400 - 1}, {"ts": now[0] - 7 * 86400}, {"ts": now[0]}]
        self.log.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
        judge = Judge(RulesBackend(), self.log, clock=lambda: now[0])
        self.assertEqual(self.lines(), rows[1:])
        now[0] += 3599
        judge.feedback("one", "ok")
        self.assertEqual(self.lines()[0], rows[1])
        now[0] += 1
        judge.feedback("two", "ok")
        self.assertEqual(self.lines()[0], rows[2])

    def test_forget_filters_question_windows_and_feedback(self):
        from observation.blacklist import entry_hides
        judge = Judge(RulesBackend(), self.log)
        judge.ask({}, [{"id": "speak", "type": "yes_no", "window": {"app": "Code"}}])
        judge.feedback(self.lines()[0]["judge_id"], "dismissed")
        judge.ask({"app": "Notes"}, QUESTIONS)
        judge.forget_hidden(lambda window: entry_hides("app_names", "Code", window), "app_names")
        self.assertEqual(len(self.lines()), 1)
        self.assertEqual(self.lines()[0]["state"]["app"], "Notes")

    def test_forget_during_judgment_does_not_restore_deleted_material(self):
        rules = RulesBackend()
        judge = Judge(rules, self.log)
        answer = rules.answer
        def forget(state, questions):
            judge.forget_since(0)
            return answer(state, questions)
        with patch.object(rules, "answer", side_effect=forget):
            judge.ask({"app": "Code"}, QUESTIONS)
        self.assertFalse(self.log.exists() and self.log.read_text(encoding="utf-8"))

    def test_answers_and_log_fields(self):
        backend = FakeBackend([{"id": "speak", "value": True, "prob": 0.8},
                               {"id": "next", "value": "2min", "prob": 0.6},
                               {"id": "salience", "value": 7, "prob": 0.7}])
        result = Judge(backend, self.log).ask("gate failed twice", QUESTIONS)
        self.assertEqual(result["backend"], "fake")
        self.assertEqual([(a["id"], a["value"], a["prob"]) for a in result["answers"]],
                         [("speak", True, 0.8), ("next", "2min", 0.6), ("salience", 7, 0.7)])
        self.assertIsInstance(result["latency_ms"], float)
        [logged] = self.lines()
        self.assertEqual(set(logged), {"ts", "judge_id", "backend", "latency_ms", "state", "questions",
                                       "answers", "error"})
        self.assertEqual((logged["judge_id"], logged["state"], logged["error"]),
                         (result["judge_id"], "gate failed twice", None))

    def test_malformed_questions_rejected(self):
        judge = Judge(FakeBackend(), self.log)
        for bad in ([{"id": "a", "type": "maybe", "text": "?"}],
                    [{"id": "a", "type": "choice", "text": "?"}],
                    [{"id": "a", "type": "score", "text": "?", "scale": [5, 1]}],
                    [{"id": "a", "type": "yes_no", "text": "?"}, {"id": "a", "type": "yes_no", "text": "?"}],
                    []):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                judge.ask("s", bad)
        self.assertFalse(self.log.exists())

    def test_a_backend_error_answers_none_and_the_log_keeps_the_error(self):
        self.assertIsNone(Judge(FakeBackend(error=OSError("offline")), self.log).ask("s", QUESTIONS))
        [logged] = self.lines()
        self.assertEqual((logged["backend"], logged["answers"]), ("fake", []))
        self.assertIn("offline", logged["error"])

    def test_invalid_answers_answer_none(self):
        backend = FakeBackend([{"id": "speak", "value": "yes", "prob": 0.9},
                               {"id": "next", "value": "1h", "prob": 0.9},
                               {"id": "salience", "value": 11, "prob": 0.9}])
        self.assertIsNone(Judge(backend, self.log).ask("s", QUESTIONS))
        self.assertEqual(self.lines()[0]["error"], "ValueError: invalid_answers")

    def test_feedback_is_logged_against_the_judgement(self):
        judge = Judge(RulesBackend(), self.log)
        judge_id = judge.ask("s", QUESTIONS[:1])["judge_id"]
        judge.feedback(judge_id, "dismissed")
        self.assertEqual({k: v for k, v in self.lines()[1].items() if k != "ts"},
                         {"judge_id": judge_id, "feedback": "dismissed", "source": "user"})

    def test_each_judgement_is_reported_without_the_question_text(self):
        seen = []
        judge = Judge(RulesBackend(), self.log)
        judge.on_decision = lambda kind, attrs, key, **status: seen.append((kind, attrs, key, status))
        result = judge.ask("s", QUESTIONS, key="line-1")
        judge.ask("s", QUESTIONS[:1])
        [(kind, attrs, key, status), (_, _, own, _)] = seen
        self.assertEqual((kind, key, attrs["backend"], attrs["answers"], status),
                         ("judge.decided", "line-1", "rules", result["answers"], {}))
        self.assertNotIn("failure_reason", attrs)
        self.assertNotIn("要不要开口", json.dumps(seen, ensure_ascii=False))
        self.assertRegex(own, r"^[0-9a-f]{16}$")

    def test_a_failed_judgement_is_reported_failed_with_a_sanitized_reason(self):
        seen = []
        judge = Judge(FakeBackend(error=OSError("secret document")))
        judge.on_decision = lambda kind, attrs, key, **status: seen.append((attrs, status))
        judge.ask("state", QUESTIONS[:1], key="line-1")
        [(attrs, status)] = seen
        self.assertEqual((attrs["backend"], attrs["answers"], attrs["failure_reason"], status),
                         ("fake", [], "decision_failed", {"status": "failed"}))
        self.assertNotIn("secret document", json.dumps(seen))

    def test_a_failing_decision_callback_changes_nothing(self):
        judge = Judge(RulesBackend(), self.log)
        judge.on_decision = lambda *_, **__: 1 / 0
        self.assertEqual([a["value"] for a in judge.ask("s", QUESTIONS)["answers"]], [False, "30s", 5])


class RulesBackendTest(unittest.TestCase):
    def test_registered_rule_wins_over_default(self):
        rules = RulesBackend({"speak": lambda state, q: (state == "P0", 1.0)})
        answers = rules.answer("P0", QUESTIONS)
        self.assertEqual(answers[0], {"id": "speak", "value": True, "prob": 1.0})
        self.assertEqual(answers[1], {"id": "next", "value": "30s", "prob": round(1 / 3, 3)})
        self.assertEqual(answers[2], {"id": "salience", "value": 5, "prob": 0.5})


if __name__ == "__main__":
    unittest.main()
