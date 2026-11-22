import http.client
import json
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from character_agent.services.interactions import InteractionService
from character_agent.services.jobs import JobStore
from character_agent.services.store import RunStore
from personal.commitments import Commitments
from character_agent.services.deliveries import DeliveryService
from personal.history import History
from daemon.agentd_server import AgentdServer
from infra.store import open_store
from sessions.tasks import TaskLedger
import test_server
from support import enable_plugins, serve_in_thread

HOOK, UI = "hook-token", "ui-token"
PARTS = {"conversations": "/conversations", "interactions": "/agent/interactions",
         "jobs": "/agent/jobs", "tasks": "/tasks", "personal_tasks":"/agent/tasks",
         "deliveries":"/agent/deliveries", "task_understanding":"/task-understanding",
         "commitments": "/commitments?state=armed&state=triggered", "approvals": "/approvals"}


class AgentSnapshotTest(unittest.TestCase):
    request = test_server.ServerTest.request

    def setUp(self):
        enable_plugins(self)
        self.tmp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[3])
        self.addCleanup(self.tmp.cleanup)
        self.server = AgentdServer(("127.0.0.1", 0), HOOK, UI, tick_interval=3600)
        self.addCleanup(self.server.server_close)
        self.port = self.server.server_port
        self.thread = serve_in_thread(self.server)
        self.addCleanup(self.thread.join, 2)
        self.addCleanup(self.server.shutdown)
        self.db = open_store(Path(self.tmp.name) / "agentd.sqlite")
        self.addCleanup(self.db.close)
        lock = threading.RLock()
        self.server.history = History(self.db, lock=lock, clock=lambda: 100)
        self.server.tasks = TaskLedger(self.db, lock=lock, clock=lambda: 100)
        self.server.tasks.create("a" * 32, "claude", self.tmp.name, "task", "read_only")
        self.server.commitments = Commitments(self.db, lock=lock, clock=lambda: 100)
        self.server.commitments.add("armed", 1000)
        self.server.commitments.add("triggered", 90)
        self.server.commitments.due()
        done = self.server.commitments.add("fulfilled", 80)
        self.server.commitments.fulfill(done["id"], None)
        self.runs = RunStore(Path(self.tmp.name) / "runs.sqlite")
        self.addCleanup(self.runs.close)
        interactions = InteractionService(self.runs, clock=lambda: 100)
        for ident, state in (("b" * 32, "pending"), ("c" * 32, "delivered")):
            self.runs.db.execute("INSERT INTO character_interactions "
                                 "(request_id,run_id,kind,state,revision,data,created_at,expires_at) "
                                 "VALUES(?,?,'question',?,1,?,100,1000)",
                                 (ident, "run", state, json.dumps({"questions": []})))
        self.runs.db.commit()
        jobs = JobStore(SimpleNamespace(db=self.db, lock=lock), clock=lambda: 100)
        jobs.submit("job", {"user_request": "private input"})
        self.server.character_agent = SimpleNamespace(interactions=interactions,
            jobs=SimpleNamespace(store=jobs), _recover_jobs=Mock(), busy=lambda: False, close=Mock(),
            deliveries=DeliveryService(SimpleNamespace(db=self.db,lock=lock), self.runs, self.server.tasks, jobs),
            observations=SimpleNamespace(task_understanding_context=lambda:{"available":False,"hypotheses":[],"segments":[]}))
        self.server.broker.clock = lambda: 100
        self.server.broker.open("claude", "session", tool_name="Read", tool_summary="file")

    def snapshot(self):
        status, body = self.request("GET", "/agent/snapshot")
        self.assertEqual(status, 200, body)
        return body

    def feed(self, snapshot):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        self.addCleanup(conn.close)
        watermark = f"{snapshot['stream_epoch']}-{snapshot['seq']}"
        conn.request("GET", "/feed?after=" + watermark, headers={"Authorization": f"Bearer {UI}"})
        response = conn.getresponse()
        self.addCleanup(response.close)
        self.assertEqual(response.status, 200)
        items, item = [], {}
        while True:
            line = response.fp.readline().decode()
            if line == ": heartbeat\n":
                break
            if line.startswith(("id: ", "event: ", "data: ")):
                key, _, value = line.rstrip("\n").partition(": ")
                item[key] = json.loads(value) if key == "data" else value
            elif line == "\n" and item:
                items.append(item)
                item = {}
        response.close()
        conn.close()
        return items

    def test_snapshot_has_exact_keys_and_default_route_bodies(self):
        snapshot = self.snapshot()
        self.assertEqual(set(snapshot), {"stream_epoch", "seq", *PARTS})
        self.assertEqual((snapshot["stream_epoch"], snapshot["seq"]),
                         (self.server.feed.stream_epoch, self.server.feed.seq))
        for part, path in PARTS.items():
            with self.subTest(part=part):
                status, body = self.request("GET", path)
                self.assertEqual(status, 200)
                self.assertEqual(snapshot[part], body)
        self.assertEqual(len(snapshot["interactions"]["requests"]), 1)
        self.assertEqual({c["state"] for c in snapshot["commitments"]["commitments"]}, {"armed", "triggered"})
        self.assertNotIn("payload", snapshot["jobs"]["jobs"][0])
        self.server.character_agent._recover_jobs.assert_called()

    def test_watermark_replays_only_the_two_later_events(self):
        feed = self.server.feed
        for i in range(3):
            feed.publish("test", {"value": i})
        snapshot = self.snapshot()
        later = [feed.publish("test", {"value": i}) for i in range(3, 5)]
        items = self.feed(snapshot)
        self.assertEqual([item["event"] for item in items], ["stream", "test", "test"])
        self.assertEqual([item["data"] for item in items[1:]], [item["data"] for item in later])
        self.assertEqual([item["id"] for item in items[1:]],
                         [f"{snapshot['stream_epoch']}-{item['seq']}" for item in later])

    def test_change_during_snapshot_arrives_after_its_watermark(self):
        feed = self.server.feed
        before = feed.publish("test", {"value": "before"})
        conversations = self.server.history.conversations
        read = conversations.list
        def change(character):
            task = self.server.tasks.create("d" * 32, "claude", self.tmp.name, "during snapshot", "read_only")
            feed.publish("task", {"task": task})
            return read(character)
        with patch.object(conversations, "list", side_effect=change):
            snapshot = self.snapshot()
        self.assertEqual(snapshot["seq"], before["seq"])
        task = next(t for t in snapshot["tasks"]["tasks"] if t["task_id"] == "d" * 32)
        items = self.feed(snapshot)
        self.assertEqual([item["event"] for item in items], ["stream", "task"])
        self.assertEqual(items[1]["data"], {"seq": before["seq"] + 1, "task": task})

    def test_expired_watermark_gets_gap_and_new_snapshot_resumes(self):
        snapshot = self.snapshot()
        for i in range(300):
            self.server.feed.publish("test", {"value": i})
        items = self.feed(snapshot)
        self.assertEqual([item["event"] for item in items[:2]], ["stream", "gap"])
        self.assertEqual(items[1]["data"]["reason"], "cursor_expired")
        self.assertEqual(len(items[2:]), 256)
        fresh = self.snapshot()
        self.assertEqual(fresh["seq"], self.server.feed.seq)
        self.assertEqual([item["event"] for item in self.feed(fresh)], ["stream"])
        later = self.server.feed.publish("test", {"value": "later"})
        resumed = self.feed(fresh)
        self.assertEqual([item["event"] for item in resumed], ["stream", "test"])
        self.assertEqual(resumed[1]["data"], later["data"])

    def test_reset_rejects_old_watermark_and_snapshot_carries_new_epoch(self):
        self.server.feed.publish("test", {"value": "before"})
        snapshot = self.snapshot()
        self.server.feed.reset()
        items = self.feed(snapshot)
        self.assertEqual([item["event"] for item in items], ["stream", "reset"])
        self.assertEqual(items[1]["data"]["reason"], "other_process")
        fresh = self.snapshot()
        self.assertNotEqual(fresh["stream_epoch"], snapshot["stream_epoch"])
        self.assertEqual(fresh["stream_epoch"], self.server.feed.stream_epoch)
        self.assertEqual([item["event"] for item in self.feed(fresh)], ["stream"])

    def test_unavailable_parts_are_null_with_200(self):
        for owner, attr, parts in ((self.server, "history", ("conversations",)),
                                   (self.server, "tasks", ("tasks",)),
                                   (self.server, "commitments", ("commitments",)),
                                   (self.server, "character_agent", ("interactions", "jobs", "personal_tasks", "deliveries", "task_understanding")),
                                   (self.server.character_agent, "jobs", ("jobs",))):
            with self.subTest(service=attr), patch.object(owner, attr, None):
                for part in parts:
                    self.assertEqual(self.request("GET", PARTS[part])[0], 503)
                snapshot = self.snapshot()
                self.assertEqual({part for part in PARTS if snapshot[part] is None}, set(parts))
        for attr in ("resetting", "closing"):
            with self.subTest(state=attr), patch.object(self.server, attr, True):
                snapshot = self.snapshot()
                self.assertEqual({part for part in PARTS if snapshot[part] is None},
                                 {"conversations", "interactions", "jobs", "personal_tasks", "deliveries", "task_understanding"})
        with patch.object(self.server.character_agent.interactions, "list", side_effect=OSError):
            self.assertEqual(self.request("GET", "/agent/interactions")[0], 503)
            self.assertIsNone(self.snapshot()["interactions"])


if __name__ == "__main__":
    unittest.main()
