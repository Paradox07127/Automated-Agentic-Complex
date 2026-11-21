"""Fast judge:state text + questions -> answers with probabilities; every call logged."""
import json
import secrets
import threading
import time

from traces.trace_format import TRACE_FAILURE_REASONS
from infra.store import rewrite_jsonl

TYPES = ("yes_no", "choice", "score")


def trace_failure_reason(error):
    """Never copy arbitrary exception text to trace; it may contain user data or credentials."""
    code = str(error)
    return code if code in TRACE_FAILURE_REASONS else "decision_failed"


def validate_questions(questions):
    if not isinstance(questions, list) or not questions:
        raise ValueError("questions_empty")
    ids = set()
    for q in questions:
        if not isinstance(q, dict) or q.get("type") not in TYPES or not isinstance(q.get("id"), str):
            raise ValueError("invalid_question")
        if q["id"] in ids:
            raise ValueError("duplicate_question_id")
        ids.add(q["id"])
        if q["type"] == "choice" and not (isinstance(q.get("options"), list) and q["options"]):
            raise ValueError("choice_needs_options")
        if q["type"] == "score":
            scale = q.get("scale")
            if not (isinstance(scale, list) and len(scale) == 2 and scale[0] < scale[1]):
                raise ValueError("score_needs_scale")


def _valid(q, answer):
    value, prob = answer.get("value"), answer.get("prob")
    if answer.get("id") != q["id"] or isinstance(prob, bool) \
            or not isinstance(prob, (int, float)) or not 0 <= prob <= 1:
        return False
    if q["type"] == "yes_no":
        return isinstance(value, bool)
    if q["type"] == "choice":
        return value in q["options"]
    lo, hi = q["scale"]
    return isinstance(value, (int, float)) and not isinstance(value, bool) and lo <= value <= hi


def validate_answers(questions, answers):
    if not (isinstance(answers, list) and len(answers) == len(questions)
            and all(isinstance(answer,dict) and _valid(question,answer) for question,answer in zip(questions,answers))):
        raise ValueError('invalid_answers')
    return answers


class RulesBackend:
    """rules: question id -> fn(state, question) -> (value, prob). Unknown ids get a neutral default."""
    name = "rules"

    def __init__(self, rules=None):
        self.rules = rules or {}

    def answer(self, state, questions):
        answers = []
        for q in questions:
            rule = self.rules.get(q["id"])
            if rule:
                value, prob = rule(state, q)
            elif q["type"] == "yes_no":
                value, prob = False, 0.5
            elif q["type"] == "choice":
                value, prob = q["options"][0], round(1 / len(q["options"]), 3)
            else:
                value, prob = sum(q["scale"]) / 2, 0.5
            answers.append({"id": q["id"], "value": value, "prob": prob})
        return answers


class Judge:
    def __init__(self, backend, log_path=None, clock=time.time):
        self.backend = backend
        self.log_path = log_path
        self.clock = clock
        self._lock = threading.Lock()
        self._log_epoch = 0
        self._pruned_at = self.clock()
        rewrite_jsonl(self.log_path, lambda row: row.get("ts", 0) >= self._pruned_at - 7 * 86400)
        self.on_decision = None  # callable(kind, attrs, key, status="ok"); whatever it raises is dropped

    def ask(self, state, questions, private=None, key=None, valid=lambda: True):
        """private: extra state for the backend that is never written to the log.
        key: groups the judge.decided event with what it is for; None uses the judge_id.
        None when the backend fails or answers out of form: the caller skips its decision; the log keeps the error
        and the trace a failed judge.decided."""
        validate_questions(questions)
        with self._lock:
            log_epoch = self._log_epoch
        start = time.monotonic()
        backend, error, failure_reason = self.backend, None, None
        try:
            if hasattr(backend, "answer_private"):
                answers = backend.answer_private(state, questions, private, valid=valid)
            else:
                answers = backend.answer(state if private is None else {**state, **private}, questions)
            validate_answers(questions, answers)
        except Exception as e:  # any backend failure skips the decision
            error, failure_reason, answers = f"{type(e).__name__}: {e}", trace_failure_reason(e), []
        result = {"judge_id": secrets.token_hex(8),
                  "answers": [{"id": a["id"], "value": a["value"], "prob": a["prob"]} for a in answers],
                  "backend": backend.name,
                  "latency_ms": round((time.monotonic() - start) * 1000, 1)}
        self._write({"ts": self.clock(), "judge_id": result["judge_id"], "backend": backend.name,
                     "latency_ms": result["latency_ms"], "state": state, "questions": questions,
                     "answers": result["answers"], "error": error}, log_epoch)
        if self.on_decision is not None:
            try:  # answers only: the question text stays in the judge log
                attrs = {"backend": backend.name, "answers": result["answers"],
                         "judge_id": result["judge_id"], "latency_ms": result["latency_ms"]}
                if failure_reason is None:
                    self.on_decision("judge.decided", attrs, key or result["judge_id"])
                else:
                    self.on_decision("judge.decided", {**attrs, "failure_reason": failure_reason},
                                     key or result["judge_id"], status="failed")
            except Exception:  # a decision record never changes the answers
                pass
        return None if failure_reason is not None else result

    def feedback(self, judge_id, label, source="user"):
        """Labels come only from user behaviour or a human."""
        self._write({"ts": self.clock(), "judge_id": judge_id, "feedback": label, "source": source})

    def truncate_log(self):
        """The log file emptied; False without one."""
        if self.log_path is None:
            return False
        with self._lock, open(self.log_path, "w", encoding="utf-8"):
            self._log_epoch += 1
            return True

    def forget_since(self, cutoff):
        with self._lock:
            self._log_epoch += 1
            rewrite_jsonl(self.log_path, lambda row: row.get("ts", 0) < cutoff)

    def forget_hidden(self, hides, field=None):
        def windows(value):
            if isinstance(value, dict):
                if any(k in value for k in ("app", "bundle_id", "title", "url_host")):
                    yield value
                for item in value.values():
                    yield from windows(item)
            elif isinstance(value, list):
                for item in value:
                    yield from windows(item)
        removed = set()
        def keep(row):
            if "feedback" in row:
                return row.get("judge_id") not in removed
            metadata = list(windows(row))
            key = {"bundle_ids": "bundle_id", "app_names": "app", "domains": "url_host",
                   "title_patterns": "title"}.get(field)
            keep = bool(metadata) and not any(hides(window) or key is not None and key not in window
                                              for window in metadata)
            if not keep:
                removed.add(row.get("judge_id"))
            return keep
        with self._lock:
            self._log_epoch += 1
            rewrite_jsonl(self.log_path, keep)

    def _write(self, record, log_epoch=None):
        if self.log_path is None:
            return
        with self._lock:
            if log_epoch is not None and log_epoch != self._log_epoch:
                return
            now = self.clock()
            if now - self._pruned_at >= 3600:
                rewrite_jsonl(self.log_path, lambda row: row.get("ts", 0) >= now - 7 * 86400)
                self._pruned_at = now
            with open(self.log_path, "a", encoding="utf-8") as stream:
                stream.write(json.dumps(record, ensure_ascii=False) + "\n")
