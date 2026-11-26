"""Work-memory L1: closed segments get one model call each, whose reply is checked item by item before it is stored."""
import datetime
import json
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace as NS
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_agent.services.worklog import WorkLogService
from infra.store import open_store
from models.usage import UsageMeter

T0 = datetime.datetime(2026, 11, 4, 10, 0).timestamp()
MIN = 60


class Observations:
    """The part of ObservationService the work log reads: hook frames of the store that pass consent."""
    def __init__(self, db, lock):
        self.db, self.lock, self.character = db, lock, "aster"
        self.hidden = set()
        self.count = 0

    def add(self, at, role, content, session="s1", tool=None, cwd="/Users/u/Endfield"):
        self.count += 1
        ident = f"obs-{self.count:032x}"
        metadata = {"app": "claude", "doc": cwd, "label": session, "kind": "live_hook", "role": role,
                    "subrole": tool}
        requires = ["agent_sessions"] + (["typed_text"] if role == "prompt_submit" else [])
        self.db.execute("INSERT OR IGNORE INTO observation_content VALUES(?,?,NULL,?)",
                        (ident, json.dumps(content, ensure_ascii=False), at))
        self.db.execute("INSERT INTO observation_frames VALUES(?,?,?,?,?,?,?,?,?,?,NULL)",
                        (ident, "aster", at, "input_event", session, "r1", 0, json.dumps(requires),
                         json.dumps(metadata), ident))
        self.db.commit()
        return ident

    def allowed(self, requires=()):
        return True

    def _allowed_row(self, row):
        return row["id"] not in self.hidden

    def get(self, ident):
        row = self.db.execute("SELECT f.id,f.at,f.requires,f.metadata,c.text FROM observation_frames f"
                              " JOIN observation_content c ON c.hash=f.content_hash WHERE f.id=?", (ident,)).fetchone()
        if row is None or ident in self.hidden:
            return None
        return {"id": row[0], "at": row[1], "requires": json.loads(row[2]), "metadata": json.loads(row[3]),
                "text": row[4]}


class Client:
    """SemanticService.run as the work log sees it: each run's purpose, instructions and material; replies in order."""

    def __init__(self, replies):
        self.replies, self.calls = list(replies), []

    def run(self, purpose, instructions, evidence, **_):
        material = json.dumps(evidence["material"], ensure_ascii=False)
        self.calls.append({"purpose": purpose, "system": instructions,
                           "messages": [{"content": "<material>\n" + material + "\n</material>"}]})
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        try:
            value = json.loads(reply) if isinstance(reply, str) else reply
        except ValueError:
            raise ValueError("invalid_semantic_json") from None
        return {"run_id": "semantic-1", "value": value, "backend": "codex", "model": 'claude-haiku-5-5'}


def unavailable(*_args, **_kwargs):
    """A run whose test queue is not set: the kernel is busy, so the work log asks nothing more this tick."""
    raise ValueError("semantic_busy")


def summary(**fields):
    return {"title": "修 HostLink 断线重连", "goal": "断线后自动恢复会话", "goal_authority": "user_said", "did": [],
            "outcome": "swift test 通过", "status": "done", "blockers": [], "next_steps": [],
            "task_hint": "HostLink 断线", "project": "Endfield", "user_facts": [], **fields}


class WorkLogL1Test(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = open_store(Path(self.tmp.name) / "agentd.sqlite")
        self.addCleanup(self.db.close)
        self.lock = threading.RLock()
        self.now = T0
        self.obs = Observations(self.db, self.lock)
        self.paused = False
        memory = NS(db=self.db, lock=self.lock, paused=lambda: self.paused)
        self.server = NS(memory=memory, character="aster", usage=UsageMeter(self.db, clock=lambda: self.now),
                         models=None, attention=None)
        self.sanitized = []

        def sanitize(value, part="knowledge"):
            self.sanitized.append(part)
            return value
        self.language = "zh-Hans"
        controller = NS(semantic=NS(run=lambda purpose, *args, **kwargs: getattr(getattr(self.service, "client" if purpose == "worklog_fast" else "deep", None), "run", unavailable)(purpose, *args, **kwargs), reply=lambda: self.language), server=self.server, observations=self.obs, knowledge=lambda: NS(sanitize=sanitize))
        self.service = WorkLogService(controller, clock=lambda: self.now)

    def session(self, start=T0, session="s1"):
        prompt = self.obs.add(start, "prompt_submit", {"prompt": "请修好 HostLink 断线重连，我喜欢先写测试"}, session)
        test = self.obs.add(start + 2 * MIN, "tool_end", {"tool_input": {"command": "swift test"},
                                                          "tool_response": {"stdout": "Executed 12 tests, with 0 failures"}},
                            session, tool="Bash")
        self.obs.add(start + 3 * MIN, "prompt_submit", {"prompt": "再跑一遍"}, session)
        stop = self.obs.add(start + 5 * MIN, "stop", {"last_assistant_message": "加了指数退避重连，测试通过"}, session)
        return prompt, test, stop

    def rows(self, day="2026-11-04"):
        return self.service.log.sessions_on(day)

    def test_a_hedged_item_is_dropped_and_the_rest_is_written(self):
        prompt, test, stop = self.session()
        reply = summary(did=[{"text": "给 HostLink 加了指数退避重连", "authority": "tool_verified", "evidence": [test]},
                             {"text": "这不是用户的偏好，仅为推断", "authority": "inferred", "evidence": [stop]}],
                        next_steps=[{"text": "在真 app 上复测", "owner": "user"}])
        self.service.client = Client([reply])
        self.now = T0 + 30 * MIN
        self.service.tick(self.now)
        rows = self.rows()
        self.assertEqual([(r["state"], r["status"], r["title"]) for r in rows], [("completed", "done", reply["title"])])
        body = rows[0]["body"]
        self.assertEqual([d["text"] for d in body["did"]], ["给 HostLink 加了指数退避重连"])
        self.assertEqual(body["next_steps"], reply["next_steps"])
        self.assertEqual(body["goal"], "断线后自动恢复会话")
        self.assertEqual(rows[0]["sources"][:2] + rows[0]["sources"][3:], [prompt, test, stop])
        self.assertEqual(rows[0]["requires"], ["agent_sessions", "typed_text"])
        self.assertEqual(rows[0]["model"], "claude-haiku-5-5")
        self.assertIn("worklog_source", self.sanitized)
        call = self.service.client.calls[0]
        self.assertEqual(call["purpose"], "worklog_fast")
        self.assertIn('JSON Schema: {"type": "object"', call["system"])
        self.assertIn('"additionalProperties": false', call["system"])
        material = call["messages"][0]["content"]
        self.assertIn(prompt, material)
        self.service.tick(self.now + 5 * MIN)
        self.assertEqual(len(self.service.client.calls), 1)  # a completed segment is not asked again

    def test_bad_evidence_quotes_unknowns_and_statuses_are_cleaned_per_item(self):
        prompt, test, stop = self.session()
        reply = summary(goal="未知", outcome="unknown", status="maybe",
                        did=[{"text": "改了重连", "authority": "tool_verified", "evidence": ["obs-missing"]},
                             {"text": "跑了测试", "authority": "made_up", "evidence": [test]},
                             {"text": "测试通过", "authority": "tool_verified", "evidence": [test]}],
                        blockers=[{"text": "", "evidence": []}],
                        user_facts=[{"kind": "preference", "text": "喜欢先写测试", "quote": "我喜欢先写测试",
                                     "source_id": prompt},
                                    {"kind": "preference", "text": "喜欢 Swift", "quote": "我喜欢 Swift",
                                     "source_id": prompt},
                                    {"kind": "preference", "text": "测试通过", "quote": "测试通过",
                                     "source_id": stop}])
        self.service.client = Client([reply])
        self.now = T0 + 30 * MIN
        self.service.tick(self.now)
        row = self.rows()[0]
        body = row["body"]
        self.assertEqual((body["goal"], body["outcome"], body["status"], row["status"]), ("", "", "", "unknown"))
        self.assertEqual([d["text"] for d in body["did"]], ["测试通过"])
        self.assertEqual(body["blockers"], [])
        self.assertEqual([f["quote"] for f in body["user_facts"]], ["我喜欢先写测试"])

    def test_a_user_quote_with_hedge_words_is_kept_and_a_hedged_fact_text_is_not(self):
        prompt = self.obs.add(T0, "prompt_submit", {"prompt": "I think tabs read better, maybe use them here"}, "s1")
        self.obs.add(T0 + 2 * MIN, "tool_end", {"tool_input": {"command": "swift test"},
                                                "tool_response": {"stdout": "Executed 12 tests, with 0 failures"}},
                     "s1", tool="Bash")
        self.obs.add(T0 + 3 * MIN, "prompt_submit", {"prompt": "run it again"}, "s1")
        self.obs.add(T0 + 5 * MIN, "stop", {"last_assistant_message": "switched the file to tabs"}, "s1")
        reply = summary(user_facts=[{"kind": "preference", "text": "prefers tabs", "quote": "I think tabs read better",
                                     "source_id": prompt},
                                    {"kind": "preference", "text": "maybe prefers tabs", "quote": "maybe use them here",
                                     "source_id": prompt}])
        self.service.client = Client([reply])
        self.now = T0 + 30 * MIN
        self.service.tick(self.now)
        facts = self.rows()[0]["body"]["user_facts"]
        self.assertEqual([(f["text"], f["quote"]) for f in facts], [("prefers tabs", "I think tabs read better")])

    def test_a_worker_batch_goal_from_the_orchestrator_is_not_user_said(self):
        cwd = "/Users/u/.mm-wt/Endfield-20261104-100000-35b2"
        prompt = self.obs.add(T0, "prompt_submit", {"prompt": "请修好 HostLink 断线重连，我喜欢先写测试"}, cwd=cwd)
        stop = self.obs.add(T0 + 5 * MIN, "stop", {"last_assistant_message": "加了指数退避重连"}, cwd=cwd)
        self.obs.add(T0 + 6 * MIN, "session_end", {"result": "done"}, cwd=cwd)
        reply = summary(did=[{"text": "要修断线重连", "authority": "user_said", "evidence": [prompt]},
                             {"text": "加了指数退避重连", "authority": "agent_claimed", "evidence": [stop]}],
                        user_facts=[{"kind": "preference", "text": "喜欢先写测试", "quote": "我喜欢先写测试",
                                     "source_id": prompt}])
        self.service.client = Client([reply])
        self.now = T0 + 70 * MIN
        self.service.tick(self.now)
        row = self.rows()[0]
        self.assertEqual(row["kind"], "worker_batch")
        self.assertEqual(row["body"]["goal_authority"], "inferred")
        self.assertEqual([d["authority"] for d in row["body"]["did"]], ["inferred", "agent_claimed"])
        self.assertEqual(row["body"]["user_facts"], [])
        self.assertIn("orchestrator", self.service.client.calls[0]["system"])

    def test_a_reply_without_a_title_fails_the_segment(self):
        self.session()
        self.service.client = Client([summary(title="x"), "not json"])
        self.now = T0 + 30 * MIN
        self.service.tick(self.now)
        self.assertEqual([(r["state"], r["attempts"]) for r in self.rows()], [("failed", 1)])

    def test_an_english_title_gets_two_and_a_half_times_the_characters(self):
        for language, length, state in (("zh-Hans", 40, "completed"), ("zh-Hans", 41, "failed"), (None, 41, "failed"),
                                        ("en", 100, "completed"), ("en", 101, "failed")):
            with self.subTest(language=language, length=length):
                self.setUp()
                self.language = language
                self.session()
                self.service.client = Client([summary(title="x" * length), "not json"])
                self.now = T0 + 30 * MIN
                self.service.tick(self.now)
                self.assertEqual(self.rows()[0]["state"], state)
                most = 100 if language == "en" else 40
                self.assertIn(f"title is 2-{most} characters", self.service.client.calls[0]["system"])

    def test_the_usage_cap_and_a_busy_kernel_leave_the_segment_waiting(self):
        self.session()
        self.now = T0 + 30 * MIN
        for code in ("usage_cap", "semantic_busy"):
            with self.subTest(code=code):
                self.service.client = Client([ValueError(code)])
                self.service.tick(self.now)
                self.assertEqual(len(self.service.client.calls), 1)
                self.assertEqual([(r["state"], r["attempts"]) for r in self.rows()], [("pending", 0)])

    def test_the_next_segment_of_a_session_continues_from_the_previous_summary(self):
        self.session(T0)
        self.session(T0 + 30 * MIN)
        self.service.client = Client([summary(status="ongoing", next_steps=[{"text": "补文档", "owner": "agent"}]),
                                      summary(title="补 HostLink 文档")])
        self.now = T0 + 60 * MIN
        self.service.tick(self.now)
        self.assertEqual([r["title"] for r in self.rows()], ["修 HostLink 断线重连", "补 HostLink 文档"])
        first, second = (json.loads(c["messages"][0]["content"].split("\n", 1)[1].rsplit("\n", 1)[0])
                         for c in self.service.client.calls)
        self.assertIsNone(first["previous"])
        self.assertEqual(second["previous"], {"title": "修 HostLink 断线重连", "status": "ongoing",
                                              "next_steps": ["补文档"]})

    def test_open_segments_wait_and_paused_memory_does_nothing(self):
        self.session()
        self.service.client = Client([])
        self.now = T0 + 10 * MIN
        self.service.tick(self.now)
        self.assertEqual(self.rows(), [])
        self.paused = True
        self.now = T0 + 30 * MIN
        self.service.tick(self.now)
        self.assertEqual(self.rows(), [])



if __name__ == "__main__":
    unittest.main()
