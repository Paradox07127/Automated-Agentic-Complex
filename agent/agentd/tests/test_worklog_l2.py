"""Work-memory L2: unassigned session summaries go to task cards in one model round, which code checks and bounds."""
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
import test_git_state
import test_worklog_l1 as l1

T0 = datetime.datetime(2026, 11, 4, 10, 0).timestamp()
MIN = 60
HOUR = 3600


class Observations:
    """An observation service without frames, so ticks only run the task rounds."""
    def __init__(self, db, lock):
        self.db, self.lock, self.character = db, lock, "aster"

    def allowed(self, requires=()):
        return True

    def _allowed_row(self, row):
        return True


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
        return {"run_id": "semantic-1", "value": value, "backend": "codex", "model": 'claude-sonnet-5-5'}


def unavailable(*_args, **_kwargs):
    """A run whose test queue is not set: the kernel is busy, so the work log asks nothing more this tick."""
    raise ValueError("semantic_busy")


def summary(title, status="ongoing"):
    return {"title": title, "goal": "", "goal_authority": "", "did": [], "outcome": "", "status": status,
            "blockers": [], "next_steps": [], "task_hint": title, "project": "Endfield", "user_facts": []}


def card(title, **fields):
    return {"title": title, "goal": "目标", "goal_authority": "inferred", "status": "active",
            "status_authority": "inferred", "progress": "旧进展", "next_step": "旧下一步", "blockers": ["旧阻碍"],
            "project": "Endfield", "first_at": T0 - HOUR, "last_at": T0 - HOUR, "requires": [], **fields}


def reply(assign=(), new_tasks=(), updates=(), merge=()):
    return {"assign": [{"session_id": s, "task": t} for s, t in assign],
            "new_tasks": [{"ref": r, "title": title, "goal": "目标", "goal_authority": "inferred", "project": "Endfield"}
                          for r, title in new_tasks],
            "updates": list(updates), "merge": [{"from": a, "into": b} for a, b in merge]}


class WorkLogL2Test(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = open_store(Path(self.tmp.name) / "agentd.sqlite")
        self.addCleanup(self.db.close)
        self.lock = threading.RLock()
        self.now = T0 + 3 * HOUR
        memory = NS(db=self.db, lock=self.lock, paused=lambda: False)
        self.server = NS(memory=memory, character="aster", usage=UsageMeter(self.db, clock=lambda: self.now),
                         models=None, attention=None)
        self.language = "zh-Hans"
        controller = NS(semantic=NS(run=lambda purpose, *args, **kwargs: getattr(getattr(self.service, "client" if purpose == "worklog_fast" else "deep", None), "run", unavailable)(purpose, *args, **kwargs), reply=lambda: self.language), server=self.server, observations=Observations(self.db, self.lock),
                        knowledge=lambda: NS(sanitize=lambda value, part="knowledge", observed=None: value))
        self.service = WorkLogService(controller, clock=lambda: self.now)
        self.service.client = Client([])
        self.log = self.service.log

    def l1(self, key, start, title, status="ongoing", goal_authority="", **body):
        ident = self.log.add_segment("agent_session", key, start, start + 10 * MIN, input_sha256="h",
                                     requires=["agent_sessions"], sources=["obs-1"], agent="claude",
                                     project="Endfield", cwd="/w")
        self.log.complete_segment(ident, {**summary(title, status), "goal_authority": goal_authority, **body})
        return ident

    def round(self, *replies):
        self.service.deep = Client(replies)
        self.service.tick(self.now)
        return self.service.deep

    def test_six_summaries_of_two_things_make_two_cards(self):
        link = [self.l1(f"s{i}", T0 + i * 15 * MIN, "修 HostLink 断线") for i in range(3)]
        port = [self.l1(f"p{i}", T0 + i * 15 * MIN + 5 * MIN, "换 agentd 端口") for i in range(3)]
        deep = self.round(reply(assign=[(s, "new:1") for s in link] + [(s, "new:2") for s in port],
                                new_tasks=[("new:1", "修 HostLink 断线"), ("new:2", "换 agentd 端口")],
                                updates=[{"task_id": "new:1", "status": "active", "progress": "加了重连",
                                          "next_step": "真机复测", "blockers": []}]))
        self.assertEqual(len(deep.calls), 1)
        material = deep.calls[0]["messages"][0]["content"]
        self.assertTrue(all(s in material for s in link + port))
        self.assertIn("JSON Schema", deep.calls[0]["system"])
        cards = {c["title"]: c for c in self.log.tasks()}
        self.assertEqual(sorted(cards), ["修 HostLink 断线", "换 agentd 端口"])
        self.assertEqual([cards[t]["sessions"] for t in sorted(cards)], [3, 3])
        self.assertEqual((cards["修 HostLink 断线"]["progress"], cards["修 HostLink 断线"]["next_step"]),
                         ("加了重连", "真机复测"))
        self.assertEqual(cards["修 HostLink 断线"]["requires"], ["agent_sessions"])
        self.assertEqual(self.log.pending_sessions(), [])
        self.assertTrue(all(s["task_id"] for s in self.log.sessions_on("2026-11-04")))

    def test_a_new_card_is_user_said_only_with_a_user_said_session(self):
        link = [self.l1("s0", T0, "修 HostLink 断线", goal_authority="user_said"),
                self.l1("s1", T0 + 15 * MIN, "修 HostLink 断线", goal_authority="inferred")]
        port = [self.l1("p0", T0 + 5 * MIN, "换 agentd 端口", goal_authority="inferred")]
        said = reply(assign=[(s, "new:1") for s in link] + [(s, "new:2") for s in port],
                     new_tasks=[("new:1", "修 HostLink 断线"), ("new:2", "换 agentd 端口")])
        for item in said["new_tasks"]:
            item["goal_authority"] = "user_said"
        deep = self.round(said)
        material = json.loads(deep.calls[0]["messages"][0]["content"].split("<material>")[1].split("</material>")[0])
        self.assertEqual({s["id"]: s["goal_authority"] for s in material["sessions"]},
                         {link[0]: "user_said", link[1]: "inferred", port[0]: "inferred"})
        self.assertEqual({c["title"]: c["goal_authority"] for c in self.log.tasks()},
                         {"修 HostLink 断线": "user_said", "换 agentd 端口": "inferred"})
        self.assertEqual([c["purpose"] for c in deep.calls], ["worklog_deep"])

    def test_a_card_last_at_is_its_newest_session_end(self):
        old = self.log.upsert_task(card("修 HostLink 断线", last_at=T0 - 24 * HOUR, first_at=T0 - 24 * HOUR))
        late = self.l1("s2", T0 + 60 * MIN, "修 HostLink 断线")
        early = self.l1("s1", T0, "修 HostLink 断线")
        later = self.l1("p1", T0 + 90 * MIN, "换端口")
        first = self.l1("p0", T0 + 30 * MIN, "换端口")
        self.round(reply(assign=[(late, old), (early, old), (later, "new:1"), (first, "new:1")],
                         new_tasks=[("new:1", "换 agentd 端口")]))
        cards = {c["title"]: c for c in self.log.tasks()}
        self.assertEqual(cards["修 HostLink 断线"]["last_at"], T0 + 70 * MIN)
        self.assertEqual((cards["换 agentd 端口"]["first_at"], cards["换 agentd 端口"]["last_at"]),
                         (T0 + 30 * MIN, T0 + 100 * MIN))

    def test_an_unknown_task_id_or_a_missing_session_rejects_the_round(self):
        a, b = self.l1("s1", T0, "修 HostLink 断线"), self.l1("s2", T0 + 20 * MIN, "换端口")
        deep = self.round(reply(assign=[(a, "new:1"), (b, "task-missing")], new_tasks=[("new:1", "修 HostLink 断线")]))
        self.assertEqual(len(deep.calls), 1)
        self.assertEqual(self.log.tasks(), [])
        self.assertEqual([s["id"] for s in self.log.pending_sessions()], [a, b])
        self.now += 31 * MIN
        deep = self.round(reply(assign=[(a, "new:1")], new_tasks=[("new:1", "修 HostLink 断线")]))
        self.assertEqual(len(deep.calls), 1)
        self.assertEqual(self.log.tasks(), [])
        self.assertEqual([s["id"] for s in self.log.pending_sessions()], [a, b])

    def test_an_edited_card_keeps_the_users_status(self):
        ident = self.log.upsert_task(card("修 HostLink 断线"))
        other = self.log.upsert_task(card("HostLink 重连"))
        self.log.edit_task(ident, 1, title="HostLink 断线重连", status="parked")
        session = self.l1("s1", T0, "修 HostLink 断线")
        self.round(reply(assign=[(session, ident)], merge=[(ident, other)],
                         updates=[{"task_id": ident, "status": "active", "progress": "加了重连", "next_step": "",
                                   "blockers": []}]))
        task = self.log.task(ident)
        self.assertEqual((task["title"], task["status"], task["status_authority"], task["edited"]),
                         ("HostLink 断线重连", "parked", "user_corrected", True))
        self.assertEqual((task["progress"], task["next_step"], task["sessions"]), ("加了重连", None, 1))
        self.assertIsNotNone(self.log.task(other))

    def test_the_eleventh_active_card_parks_the_oldest_by_rule(self):
        for i in range(10):
            self.log.upsert_task(card(f"任务{i}", last_at=T0 - (i + 1) * HOUR))
        session = self.l1("s1", T0, "新任务")
        self.round(reply(assign=[(session, "new:1")], new_tasks=[("new:1", "新的任务")]))
        active = self.log.tasks(("active",))
        self.assertEqual(len(active), 10)
        self.assertIn("新的任务", [c["title"] for c in active])
        [parked] = self.log.tasks(("parked",))
        self.assertEqual((parked["title"], parked["status_authority"]), ("任务9", "rule"))

    def test_a_card_without_a_session_for_72_hours_is_parked_by_rule(self):
        self.log.upsert_task(card("旧任务", last_at=self.now - 73 * HOUR))
        self.log.upsert_task(card("新任务", last_at=self.now - HOUR))
        self.log.upsert_task(card("不确定的", status="uncertain", last_at=self.now - 100 * HOUR))
        deep = self.round()
        self.assertEqual(deep.calls, [])
        status = {c["title"]: (c["status"], c["status_authority"]) for c in self.log.tasks()}
        self.assertEqual(status, {"旧任务": ("parked", "rule"), "新任务": ("active", "inferred"),
                                  "不确定的": ("uncertain", "inferred")})

    def test_a_done_card_leaves_the_chat_after_24_hours(self):
        self.log.upsert_task(card("刚完成的", status="done", last_at=self.now - 2 * HOUR))
        self.log.upsert_task(card("昨天完成的", status="done", last_at=self.now - 25 * HOUR))
        text = self.log.inject(self.now)
        self.assertIn("刚完成的", text)
        self.assertNotIn("昨天完成的", text)

    def test_hedged_progress_next_step_and_blockers_are_dropped(self):
        ident = self.log.upsert_task(card("修 HostLink 断线"))
        session = self.l1("s1", T0, "修 HostLink 断线")
        self.round(reply(assign=[(session, ident)],
                         updates=[{"task_id": ident, "status": "uncertain", "progress": "仅为推断，可能在修重连",
                                   "next_step": "未经验证的下一步", "blockers": ["证据不足", "缺真机"]}]))
        task = self.log.task(ident)
        self.assertEqual((task["status"], task["progress"], task["next_step"], task["blockers"], task["sessions"]),
                         ("uncertain", "旧进展", "旧下一步", ["旧阻碍"], 1))

    def test_rounds_start_on_a_trigger_and_a_rejected_round_waits(self):
        first = self.l1("s1", T0, "修 HostLink 断线")
        deep = self.round(reply(assign=[(first, "new:1")], new_tasks=[("new:1", "修 HostLink 断线")]))
        self.assertEqual(len(deep.calls), 1)
        [task] = self.log.tasks()
        self.now += 5 * MIN
        ongoing = self.l1("s2", T0 + 20 * MIN, "修 HostLink 断线")
        self.assertEqual(self.round().calls, [])
        self.now += MIN
        done = self.l1("s3", T0 + 40 * MIN, "修 HostLink 断线", status="done")
        deep = self.round(reply(assign=[(ongoing, task["id"]), (done, "task-missing")]))
        self.assertEqual(len(deep.calls), 1)
        self.now += MIN
        self.assertEqual(self.round().calls, [])
        self.now += 30 * MIN
        deep = self.round(reply(assign=[(ongoing, task["id"]), (done, task["id"])]))
        self.assertEqual(len(deep.calls), 1)
        self.assertEqual(self.log.task(task["id"])["sessions"], 3)

    def test_a_card_whose_latest_checkout_landed_clean_is_done_by_rule(self):
        asked = []
        self.service.landed = lambda root, sha: asked.append((root, sha)) or sha == "b" * 40
        old = self.now - 100 * HOUR

        def held(card_id, key, start, head=None, dirty=0, linked=True, committed=0):
            git = {} if head is None else {"git": {"root": "/r", "branch": "w1", "head": head, "dirty": dirty,
                                                   "linked": linked, "committed_at": start + committed}}
            self.log.assign(self.l1(key, start, "修 HostLink 断线", **git), card_id)
        cards = {title: self.log.upsert_task(card(title, last_at=old, first_at=old, **fields))
                 for title, fields in (("合入了", {}), ("还脏着", {}), ("又往前走了", {}), ("没有 git", {}),
                                       ("用户改过", {}), ("不确定的", {"status": "uncertain"}), ("主 checkout", {}),
                                       ("还没提交", {}))}
        held(cards["合入了"], "m1", old, "a" * 40)
        held(cards["合入了"], "m2", old + HOUR, "b" * 40)
        held(cards["合入了"], "m3", old + 2 * HOUR)
        held(cards["还脏着"], "d1", old, "b" * 40, dirty=2)
        held(cards["又往前走了"], "f1", old, "b" * 40)
        held(cards["又往前走了"], "f2", old + HOUR, "c" * 40)
        held(cards["没有 git"], "n1", old)
        held(cards["用户改过"], "e1", old, "b" * 40)
        held(cards["不确定的"], "u1", old, "b" * 40)
        held(cards["主 checkout"], "k1", old, "b" * 40, linked=False)
        held(cards["还没提交"], "p1", old, "b" * 40, committed=-60)
        self.assertEqual(self.log.edit_task(cards["用户改过"], 1, title="用户改过的")[0], "ok")
        self.assertEqual(self.round().calls, [])
        status = {c["title"]: (c["status"], c["status_authority"]) for c in self.log.tasks()}
        self.assertEqual(status, {"合入了": ("done", "tool_verified"), "还脏着": ("parked", "rule"),
                                  "又往前走了": ("parked", "rule"), "没有 git": ("parked", "rule"),
                                  "用户改过的": ("parked", "rule"), "不确定的": ("uncertain", "inferred"),
                                  "主 checkout": ("parked", "rule"), "还没提交": ("parked", "rule")})
        self.assertEqual(sorted(asked), [("/r", "b" * 40), ("/r", "c" * 40)])

    def test_a_round_cannot_reopen_a_card_done_by_git(self):
        self.service.landed = lambda root, sha: True
        git = {"root": "/r", "branch": "w1", "head": "b" * 40, "dirty": 0, "linked": True, "committed_at": T0 + MIN}
        held = self.l1("g1", T0, "修 HostLink 断线", git=git)
        self.round(reply(assign=[(held, "new:1")], new_tasks=[("new:1", "修 HostLink 断线")]))
        task = self.log.tasks()[0]
        self.assertEqual((task["status"], task["status_authority"]), ("done", "tool_verified"))
        again = self.l1("g2", T0 + 30 * MIN, "修 HostLink 断线")
        self.round(reply(assign=[(again, task["id"])], updates=[{"task_id": task["id"], "status": "active", "progress": "又开工了", "next_step": "",
                                                         "blockers": []}]))
        task = self.log.task(task["id"])
        self.assertEqual((task["status"], task["status_authority"]), ("done", "tool_verified"))

    def test_the_round_sees_how_many_did_items_a_tool_verified(self):
        self.service.landed = lambda root, sha: False
        did = [{"text": "测试通过", "authority": "tool_verified", "evidence": []},
               {"text": "改了重连", "authority": "agent_claimed", "evidence": []},
               {"text": "构建通过", "authority": "tool_verified", "evidence": []}]
        git = {"root": "/r", "branch": "w-secret-branch", "head": "f" * 40, "dirty": 0}
        verified = self.l1("s1", T0, "修 HostLink 断线", did=did, git=git)
        plain = self.l1("s2", T0 + 20 * MIN, "换端口")
        deep = self.round(reply(assign=[(verified, "new:1"), (plain, "new:2")],
                                new_tasks=[("new:1", "修 HostLink 断线"), ("new:2", "换 agentd 端口")]))
        content = deep.calls[0]["messages"][0]["content"]
        material = json.loads(content.split("<material>")[1].split("</material>")[0])
        self.assertEqual({s["id"]: s["verified"] for s in material["sessions"]}, {verified: 2, plain: 0})
        self.assertNotIn("f" * 40, json.dumps(deep.calls, ensure_ascii=False, default=str))
        self.assertNotIn("w-secret-branch", json.dumps(deep.calls, ensure_ascii=False, default=str))



class WorkerBatchGitTest(unittest.TestCase):
    setUp, rows = l1.WorkLogL1Test.setUp, l1.WorkLogL1Test.rows

    def test_a_batch_of_two_workers_stores_no_git_state(self):
        repo = test_git_state.Repo(self)
        for i, session in enumerate(("w1", "w2")):
            start = l1.T0 + i * 10 * l1.MIN
            self.obs.add(start, "prompt_submit", {"prompt": "修 HostLink 断线"}, session, cwd=str(repo.root))
            self.obs.add(start + 5 * l1.MIN, "stop", {"last_assistant_message": "修好了"}, session,
                         cwd=str(repo.root))
            self.obs.add(start + 6 * l1.MIN, "session_end", {"result": "done"}, session, cwd=str(repo.root))
        self.service.client = l1.Client([l1.summary()])
        self.now = l1.T0 + 70 * l1.MIN
        self.service.tick(self.now)
        [row] = self.rows()
        self.assertEqual(row["kind"], "worker_batch")
        self.assertNotIn("git", row["body"])


if __name__ == "__main__":
    unittest.main()
