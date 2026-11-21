"""User fact memory in the server: facts are remembered, paused, edited and cleared over HTTP; a turn built on a changed fact
is cut or taken back."""
import contextlib
import datetime
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from observation.attention import AttentionStore  # noqa: E402
from observation.blacklist import Blacklist  # noqa: E402
from support import add_episode, deny_blacklist  # noqa: E402
from observation.capture import CaptureManager  # noqa: E402
from personal.episodes import Episodes  # noqa: E402
from personal.history import History  # noqa: E402
from personal.memory import SOURCES, Memory  # noqa: E402
from infra.store import open_store  # noqa: E402
import test_capture  # noqa: E402
import test_server  # noqa: E402
from test_server import EVENTS, FakeRelay, Script, ScriptedMouth  # noqa: E402
import test_turn  # noqa: E402
from test_turn import wait_for  # noqa: E402
from traces.trace_store import TraceStore  # noqa: E402

REPLY = ["[intent:greet]你来了", "，管理员。"]
CAT = "我养了一只猫，记得吗"  # selects the fact 我养了一只猫


class ChangeScopeTest(unittest.TestCase):
    def test_w004_memory_caller_passes_fact_ids(self):
        from unittest.mock import Mock
        server = SimpleNamespace(character_agent=Mock(), _turn_facts=None, memory=None)
        test_server.AgentdServer._memories_changed(server, ['fact-one', 'fact-two'])
        server.character_agent.cancel.assert_called_once_with('memory_changed', fact_ids={'fact-one', 'fact-two'})

    def test_w004_context_caller_passes_kind(self):
        from unittest.mock import Mock
        line = threading.Event()
        server = SimpleNamespace(character_agent=Mock(), _line_cancel=line, _live_lines=set(),
            _line_context={}, speech=None)
        self.assertFalse(test_server.AgentdServer._context_changed(server, 'page'))
        server.character_agent.cancel.assert_called_once_with('context_changed', context_kind='page')


class LocalLogsTest(unittest.TestCase):
    def setUp(self):
        from character.judge import Judge, RulesBackend
        from api.handler import Handler
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.now = 1792300000.0
        self.db = open_store(self.root / "agentd.sqlite")
        self.addCleanup(self.db.close)
        self.attention = AttentionStore(self.root / "attention.sqlite", Blacklist(deny_blacklist(self.root / "blacklist.json")))
        self.addCleanup(self.attention.close)
        self.capture = CaptureManager(test_capture.Feed(), self.attention.blacklist, lambda: test_capture.CODE,
                                      self.root / "capture.jsonl", judge_log=self.root / "capture-judge.jsonl",
                                      clock=lambda: self.now)
        self.proactive = Judge(RulesBackend(), self.root / "proactive-judge.jsonl", clock=lambda: self.now)
        self.server = SimpleNamespace(attention=self.attention, capture=self.capture,
            proactive=SimpleNamespace(judge=self.proactive), episodes=None,
            memory=None, trace=None,
            clock=lambda: self.now, forget_user_state=Mock(), _forget_derived=lambda ids: [],
            _memories_changed=Mock(), _context_changed=lambda kind: False)
        self.handler = Handler.__new__(Handler)
        self.handler.server = self.server
        self.handler._json = Mock()

    def seed_logs(self):
        rows = [{"ts": self.now - 3601, "state": {"window": {"app": "Notes", "bundle_id": "com.apple.Notes"}}},
                {"ts": self.now - 100, "state": {"window": test_capture.CODE},
                 "questions": [{"text": "Code window material"}]}]
        for name in ("capture-judge.jsonl", "proactive-judge.jsonl"):
            (self.root / name).write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
        (self.root / "capture.jsonl").write_text("".join(json.dumps({"ts": row["ts"], "window_id": i}) + "\n"
                                                        for i, row in enumerate(rows)), encoding="utf-8")
        return rows

    def test_blacklist_always_filters_logs(self):
        for delete_existing in (False, True):
            with self.subTest(delete_existing=delete_existing):
                self.seed_logs()
                self.handler._blacklist_add({"field": "bundle_ids", "value": test_capture.CODE["bundle_id"],
                                              "delete_existing": delete_existing})
                self.assertEqual(self.handler._json.call_args.args[0], 200)
                for name in ("capture-judge.jsonl", "proactive-judge.jsonl"):
                    self.assertNotIn("Code", (self.root / name).read_text(encoding="utf-8"))
                    self.assertIn("Notes", (self.root / name).read_text(encoding="utf-8"))

    def test_observation_hour_filters_both_judge_logs(self):
        rows = self.seed_logs()
        self.handler.path = "/observation?range=1h"
        self.handler._observation_delete()
        self.assertEqual(self.handler._json.call_args.args[0], 200)
        for name in ("capture-judge.jsonl", "proactive-judge.jsonl"):
            self.assertEqual([json.loads(line) for line in (self.root / name).read_text(encoding="utf-8").splitlines()], rows[:1])
        self.assertEqual([json.loads(line)["window_id"] for line in
                          (self.root / "capture.jsonl").read_text(encoding="utf-8").splitlines()], [0])

    def test_all_wal_connections_limit_journal_size(self):
        from character_agent.services.store import RunStore
        from character_agent.services.workspace import WorkspaceService
        runs = RunStore(self.root / "runs.sqlite")
        workspace = WorkspaceService(self.root / "workspace")
        self.addCleanup(runs.close)
        self.addCleanup(workspace.close)
        for db in (self.db, runs.db, workspace.db):
            with self.subTest(db=db):
                self.assertEqual(db.execute("PRAGMA journal_size_limit").fetchone()[0], 4194304)

    def test_idle_checkpoint_waits_for_quiet_and_is_rate_limited(self):
        from character_agent.services.store import RunStore
        from character_agent.services.workspace import WorkspaceService
        now = [1000.0]
        with patch("time.monotonic", side_effect=lambda: now[0]), patch("infra.store.checkpoints"):
            runs = RunStore(self.root / "runs.sqlite")
            workspace = WorkspaceService(self.root / "workspace")
            databases = (open_store(self.root / "idle.sqlite"), runs.db, workspace.db)
            try:
                for db in databases:
                    statements = []
                    db.set_trace_callback(statements.append)
                    db.execute("CREATE TABLE idle_test (value)")
                    db.execute("INSERT INTO idle_test VALUES (1)")
                    db.commit()
                    self.assertTrue(db._idle_scheduled)
                    callback = db._idle_checkpoint
                    start = now[0]
                    now[0] += 29
                    callback()
                    self.assertNotIn("PRAGMA wal_checkpoint(PASSIVE)", statements)
                    with db:
                        db.execute("INSERT INTO idle_test VALUES (2)")
                    now[0] += 29
                    callback()
                    self.assertNotIn("PRAGMA wal_checkpoint(PASSIVE)", statements)
                    now[0] += 1
                    callback()
                    self.assertEqual(statements.count("PRAGMA wal_checkpoint(PASSIVE)"), 1)
                    db.execute("INSERT INTO idle_test VALUES (3)")
                    db.commit()
                    now[0] += 30
                    callback()
                    self.assertEqual(statements.count("PRAGMA wal_checkpoint(PASSIVE)"), 1)
                    now[0] = start + 350
                    db.execute("INSERT INTO idle_test VALUES (4)")
                    now[0] = start + 359
                    callback()
                    self.assertEqual(statements.count("PRAGMA wal_checkpoint(PASSIVE)"), 1)
                    db.rollback()
                    now[0] = start + 379
                    callback()
                    self.assertEqual(statements.count("PRAGMA wal_checkpoint(PASSIVE)"), 1)
                    now[0] += 1
                    callback()
                    self.assertEqual(statements.count("PRAGMA wal_checkpoint(PASSIVE)"), 2)
                    db.close()
                    callback()
            finally:
                for db in databases:
                    db.close()

    def test_every_connection_shares_one_checkpoint_thread(self):
        before = set(threading.enumerate())
        databases = [open_store(self.root / f"shared-{i}.sqlite") for i in range(4)]
        try:
            for db in databases:
                db.execute("CREATE TABLE idle_test (value)")
                db.execute("INSERT INTO idle_test VALUES (1)")
                db.commit()
            started = [thread for thread in threading.enumerate() if thread not in before]
            self.assertLessEqual(len(started), 1, started)
            self.assertEqual([thread.name for thread in threading.enumerate()].count("sqlite-checkpoint"), 1)
        finally:
            for db in databases:
                db.close()

    def test_main_wraps_each_stderr_line_with_timestamp_and_pid(self):
        import daemon.main as agentd_main
        stream = io.StringIO()
        with contextlib.redirect_stderr(stream), patch.object(agentd_main, "parse_args", side_effect=RuntimeError("stop")):
            with self.assertRaisesRegex(RuntimeError, "stop"):
                agentd_main.main()
            sys.stderr.write("agentd: one")
            sys.stderr.write(" part\nagentd: two\n")
            print("agentd: three", file=sys.stderr)
            sys.stderr.flush()
        lines = stream.getvalue().splitlines()
        self.assertEqual(len(lines), 3)
        for line, text in zip(lines, ("agentd: one part", "agentd: two", "agentd: three")):
            self.assertRegex(line, r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d pid=\d+ " + text + "$")


class MemoryServerCase(test_server.FeedServerCase):
    request, lines_until_final = test_server.SayTest.request, test_server.SayTest.lines_until_final

    def setUp(self):
        super().setUp()
        self.data = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.addCleanup(self.data.cleanup)
        self.db = Path(self.data.name) / "agentd.sqlite"
        self.server.history = History(open_store(self.db))
        self.server.memory = self.memory = Memory(open_store(self.db))
        self.server.events_token = EVENTS
        self.server.speech = self.relay = FakeRelay()
        self.use_mouth(REPLY)

    def use_mouth(self, chunks, delay=0.0):
        self.fake = Script(chunks, delay)
        self.server.mouth = ScriptedMouth(self.fake, memory=self.memory)

    def line(self, text):
        conn, response = self.open_feed()
        status, body = self.request("POST", "/say", {"text": text})
        self.assertEqual(status, 202)
        events = self.lines_until_final(response)
        conn.close()
        self.assertTrue(wait_for(lambda: not self.server._live_lines))
        return body, events

    def facts(self):
        status, body = self.request("GET", "/memory")
        self.assertEqual(status, 200)
        return body["facts"]

    def row(self, line_id):
        [row] = [r for r in History(open_store(self.db)).export() if r["turn_id"] == line_id]
        return row

    def spoken(self):
        return [call for call in self.relay.calls if call[0] == "speak"]

    def in_window(self, text):
        return any(user["content"] == text for user, _ in self.server.mouth.history)

    def use_trace(self):
        self.server.trace = TraceStore(open_store(self.db), producer_epoch=self.server.registry.epoch)

    def traced(self, line_id):
        """(kind, event, text) of each stored trace event of line_id's turn."""
        return open_store(self.db).execute("SELECT kind, event, text FROM trace_events WHERE turn_id = ? ORDER BY id",
                                           (line_id,)).fetchall()

    def assertForgotten(self, line_id, count):
        rows = self.traced(line_id)
        self.assertEqual(len(rows), count)
        self.assertEqual([text for *_, text in rows], [None] * count)
        self.assertFalse([event for _, event, _ in rows if "猫" in event])


class RememberTest(MemoryServerCase):
    def test_a_no_memory_line_leaves_no_row_and_no_words_in_the_trace(self):
        self.server.trace = TraceStore(open_store(self.db), producer_epoch=self.server.registry.epoch)
        said = "nomem-marker-7c1f今天好累"
        conn, response = self.open_feed()
        status, body = self.request("POST", "/say", {"text": said, "no_memory": True})
        self.assertEqual(status, 202)
        self.lines_until_final(response)
        conn.close()
        self.assertTrue(wait_for(lambda: not self.server._live_lines))
        self.assertEqual(self.request("GET", "/history")[1]["turns"], [])
        rows = open_store(self.db).execute("SELECT kind, event, text FROM trace_events").fetchall()
        self.assertIn("input.received", [kind for kind, *_ in rows])
        self.assertIn("line.parsed", [kind for kind, *_ in rows])
        stored = json.dumps([[json.loads(event), text] for _, event, text in rows], ensure_ascii=False)
        for words in ("nomem", "今天好累", "管理员"):
            self.assertNotIn(words, stored)
        self.assertTrue(self.in_window(said))  # the live window keeps it; nothing on disk does
        status, body = self.request("POST", "/say", {"text": "再说一句"})
        self.assertTrue(wait_for(lambda: not self.server._live_lines and self.request("GET", "/history")[1]["turns"]))
        self.assertEqual([t["user_text"] for t in self.request("GET", "/history")[1]["turns"]], ["再说一句"])

    def test_a_manual_fact_again_reinforces_it(self):
        first = self.request("POST", "/memory/facts", {"text": "我养了一只猫"})[1]["fact_id"]
        self.assertEqual(self.request("POST", "/memory/facts", {"text": "我养了一只猫"}),
                         (200, {"fact_id": first, "reinforced": True}))
        self.assertEqual([(f["fact_id"], f["source"]) for f in self.facts()], [(first, "asserted_by_user")])


class ManualFactTest(MemoryServerCase):
    def test_a_manual_name_is_confirmed_and_survives_clearing_facts(self):
        self.request("PUT", "/memory/paused", {"paused": True})
        status, name = self.request("POST", "/memory/facts", {"text": "阿砚", "kind": "name"})
        self.assertEqual(status, 201)
        status, place = self.request("POST", "/memory/facts", {"text": "我在上海"})
        self.assertEqual(status, 201)
        self.assertEqual({f["fact_id"]: (f["kind"], f["source"]) for f in self.facts()},
                         {name["fact_id"]: ("name", "confirmed_by_user"),
                          place["fact_id"]: ("fact", "asserted_by_user")})
        self.line("你好")
        self.assertEqual(self.request("DELETE", "/memory?scope=facts"),
                         (200, {"facts_deleted": 1, "history_deleted": 0}))
        self.assertEqual([f["fact_id"] for f in self.facts()], [name["fact_id"]])
        self.assertEqual(len(self.request("GET", "/history")[1]["turns"]), 1)
        self.assertEqual(self.request("DELETE", "/memory?scope=all"),
                         (200, {"facts_deleted": 1, "history_deleted": 1}))
        self.assertEqual(self.facts(), [])
        self.assertEqual((self.request("GET", "/history")[1]["turns"], self.server.mouth.history), ([], []))

    def test_stale_fact_mutations_and_profile_creation_are_rejected(self):
        _, created = self.request('POST', '/memory/facts', {'text':'original'})
        path = '/memory/facts/' + created['fact_id']
        self.assertEqual(self.request('PATCH', path, {'text':'latest','expected_version':1})[0], 200)
        for method, target, body in [('PATCH',path,{'text':'stale','expected_version':1}),
                ('POST',path+'/confirm',{'expected_version':1}), ('DELETE',path+'?expected_version=1',None)]:
            self.assertEqual(self.request(method,target,body), (409, {'error':'version_conflict','current_version':2}))
        self.assertEqual(self.request('PATCH',path,{'text':'unversioned'})[0], 400)
        self.assertEqual(self.request('DELETE',path)[0], 400)
        profile = {'text':'A','kind':'name','expected_absent':True}
        self.assertEqual(self.request('POST','/memory/facts',profile)[0], 201)
        self.assertEqual(self.request('POST','/memory/facts',{**profile,'text':'B'})[0], 409)

    def test_edit_confirm_and_export(self):
        fact_id = self.memory.add("可能喜欢猫", "inferred_hypothesis")
        self.assertEqual(self.request("PATCH", f"/memory/facts/{fact_id}", {"expected_version": 1, "text": "喜欢狗"}), (200, {"version": 2}))
        self.assertEqual(self.request("POST", f"/memory/facts/{fact_id}/confirm", {"expected_version": 2}), (200, {"version": 3}))
        status, body = self.request("GET", "/memory/export")
        self.assertEqual(status, 200)
        self.assertEqual([(f["text"], f["source"], f["version"]) for f in body["facts"]],
                         [("喜欢狗", "confirmed_by_user", 3)])
        self.assertEqual(self.request("DELETE", "/memory?scope=history"),
                         (200, {"facts_deleted": 0, "history_deleted": 0}))
        self.assertEqual(len(self.facts()), 1)


class ChangedSourceTest(MemoryServerCase):
    def test_deleting_a_used_fact_mid_line_cancels_the_turn(self):
        fact_id = self.memory.add("我养了一只猫", "asserted_by_user")
        self.use_mouth(["第一段", "第二段", "第三段", "第四段。"], delay=0.3)
        conn, response = self.open_feed()
        status, body = self.request("POST", "/say", {"text": CAT})
        self.assertEqual(status, 202)
        first = self.next_event(response)
        while first["event"] != "line":
            first = self.next_event(response)
        self.assertEqual(json.loads(first["data"])["text_delta"], "第一段")
        self.assertEqual(self.request("DELETE", f"/memory/facts/{fact_id}?expected_version=1"), (200, {"deleted": True}))
        events = [json.loads(first["data"])] + self.lines_until_final(response)
        conn.close()
        self.assertTrue(wait_for(lambda: not self.server._live_lines))
        self.assertTrue(events[-1]["cancelled"])
        self.assertNotIn("第四段", "".join(e["text_delta"] for e in events))
        self.assertEqual(self.spoken(), [])
        self.assertEqual(self.row(body["line_id"])["state"], "cancelled")
        self.assertFalse(self.in_window(CAT))

    def test_deleting_a_used_fact_after_the_line_takes_the_turn_back(self):
        fact_id = self.memory.add("我养了一只猫", "asserted_by_user")
        said, _ = self.line(CAT)
        self.assertEqual(len(self.spoken()), 1)
        self.assertTrue(self.in_window(CAT))
        self.assertEqual(self.request("DELETE", f"/memory/facts/{fact_id}?expected_version=1"), (200, {"deleted": True}))
        self.assertEqual(self.row(said["line_id"])["state"], "cancelled")
        self.assertFalse(self.in_window(CAT))
        self.line("再说一句")
        self.assertNotIn(CAT, self.fake.past())

    def test_deleting_a_fact_takes_back_every_turn_that_said_it_and_empties_them(self):
        fact_id = self.memory.add("我养了一只猫", "asserted_by_user")
        self.use_mouth(["[intent:greet]你养了一只猫", "啊。"])
        older, _ = self.line(CAT)
        latest, _ = self.line("我养了一只猫，再说一句")
        self.request("DELETE", f"/memory/facts/{fact_id}?expected_version=1")
        for said in (older, latest):
            row = self.row(said["line_id"])
            self.assertEqual((row["state"], row["user_text"], row["reply"], row["raw_reply"]),
                             ("cancelled", "", "", None))
        self.assertEqual((self.in_window(CAT), self.in_window("我养了一只猫，再说一句")), (False, False))

    def test_deleting_a_fact_blanks_the_trace_words_of_every_turn_that_said_it(self):
        self.use_trace()
        fact_id = self.memory.add("我养了一只猫", "asserted_by_user")
        self.use_mouth(["[intent:greet]你养了一只猫", "啊。"])
        older, _ = self.line(CAT)
        latest, _ = self.line("我养了一只猫，再说一句")
        self.use_mouth(REPLY)
        other, _ = self.line("你好")
        counts = [len(self.traced(s["line_id"])) for s in (older, latest)]
        self.assertEqual(self.request("DELETE", f"/memory/facts/{fact_id}?expected_version=1"), (200, {"deleted": True}))
        for said, count in zip((older, latest), counts):
            self.assertForgotten(said["line_id"], count)
        self.assertIn(("input.received", '{"text": "你好"}'),
                      [(kind, text) for kind, _, text in self.traced(other["line_id"])])

    def test_a_turn_loaded_at_startup_leaves_the_window_with_the_fact_it_said(self):
        fact_id = self.memory.add("我养了一只猫", "asserted_by_user")
        self.use_mouth(["[intent:greet]你养了一只猫", "啊。"])
        self.line(CAT)
        self.use_mouth(REPLY)  # as after a restart: a new mouth, its window read back from the history
        self.server._line_entries.clear()
        self.server.load_window()
        self.assertTrue(self.in_window(CAT))
        self.request("DELETE", f"/memory/facts/{fact_id}?expected_version=1")
        self.assertFalse(self.in_window(CAT))

    def test_correcting_a_fact_takes_back_every_turn_that_said_it(self):
        self.use_trace()
        fact_id = self.memory.add("我养了一只猫", "asserted_by_user")
        self.use_mouth(["[intent:greet]你养了一只猫", "啊。"])
        older, _ = self.line(CAT)
        latest, _ = self.line("我养了一只猫，再说一句")
        self.assertEqual(self.request("PATCH", f"/memory/facts/{fact_id}", {"expected_version": 1, "text": "我养了一只狗"}),
                         (200, {"version": 2}))
        self.assertEqual([(self.row(s["line_id"])["state"], self.row(s["line_id"])["user_text"])
                          for s in (older, latest)], [("cancelled", CAT), ("cancelled", "我养了一只猫，再说一句")])
        self.assertEqual((self.in_window(CAT), self.in_window("我养了一只猫，再说一句")), (False, False))
        # As the history rows: a correction keeps the words of the turns in their trace.
        self.assertEqual([[json.loads(text) for kind, _, text in self.traced(s["line_id"]) if kind == "input.received"]
                          for s in (older, latest)], [[{"text": CAT}], [{"text": "我养了一只猫，再说一句"}]])

    def test_deleting_the_resident_name_takes_back_only_the_latest_turn(self):
        # A resident fact is injected into every turn; only a turn that said it again goes with it.
        status, name = self.request("POST", "/memory/facts", {"text": "阿砚", "kind": "name"})
        self.assertEqual(status, 201)
        older, _ = self.line("你好")
        latest, _ = self.line("再说一句")
        self.request("DELETE", f"/memory/facts/{name['fact_id']}?expected_version=1")
        self.assertEqual((self.row(older["line_id"])["state"], self.row(latest["line_id"])["state"]),
                         ("completed", "cancelled"))
        self.assertEqual((self.in_window("你好"), self.in_window("再说一句")), (True, False))

    def test_an_unused_fact_leaves_the_turn_alone(self):
        said, _ = self.line(CAT)
        fact_id = self.memory.add("我养了一只猫", "asserted_by_user")
        self.request("DELETE", f"/memory/facts/{fact_id}?expected_version=1")
        self.assertEqual(self.row(said["line_id"])["state"], "completed")
        self.assertTrue(self.in_window(CAT))

    def test_a_fact_confirmed_before_speech_still_speaks(self):
        # Confirming bumps the version but keeps the words the reply was made from.
        self.memory.add("我养了一只猫", "asserted_by_user")
        self.memory.version = lambda used: 99
        said, events = self.line(CAT)
        self.assertIsNone(events[-1]["error"])
        self.assertEqual(len(self.spoken()), 1)
        self.assertEqual(self.row(said["line_id"])["state"], "completed")

    def test_a_fact_corrected_before_speech_stops_the_tts(self):
        fact_id = self.memory.add("我养了一只猫", "asserted_by_user")
        text, calls = self.memory.text, []
        # The first read is the text the line used; every later one sees the correction.
        self.memory.text = lambda used: calls.append(used) or ("我养了一只狗" if len(calls) > 1 else text(used))
        said, events = self.line(CAT)
        self.assertEqual(events[-1]["error"], "memory_changed")
        self.assertEqual(self.spoken(), [])
        self.assertEqual(self.row(said["line_id"])["state"], "cancelled")
        self.assertFalse(self.in_window(CAT))

    def test_a_fact_corrected_before_the_first_token_cancels_the_turn(self):
        fact_id = self.memory.add("我养了一只猫", "asserted_by_user")
        stream, patched = self.server.mouth.stream, []

        def corrected_first(text, context):
            # The request has gone out with the old fact; the correction lands before its first token is used.
            for n, delta in enumerate(stream(text, context)):
                if n == 0:
                    threading.Thread(target=lambda: patched.append(self.request(
                        "PATCH", f"/memory/facts/{fact_id}", {"expected_version": 1, "text": "我养了一只狗"}))).start()
                    wait_for(lambda: self.memory.text(fact_id) == "我养了一只狗")
                yield delta

        self.server.mouth.stream = corrected_first
        said, events = self.line(CAT)
        self.assertTrue(wait_for(lambda: patched))
        self.assertEqual(patched, [(200, {"version": 2})])
        self.assertTrue(events[-1]["cancelled"] or events[-1]["error"] == "memory_changed", events[-1])
        self.assertEqual(self.spoken(), [])
        self.assertEqual(self.row(said["line_id"])["state"], "cancelled")
        self.assertFalse(self.in_window(CAT))

    def test_a_fact_the_line_finds_corrected_cancels_the_turn(self):
        _, self.server.speech = test_turn.relay_for(self)
        self.memory.add("我养了一只猫", "asserted_by_user")
        text, calls = self.memory.text, []
        # The first read is the text the line used; every later one sees the correction.
        self.memory.text = lambda used: calls.append(used) or ("我养了一只狗" if len(calls) > 1 else text(used))
        run, done = self.server._run_line, threading.Event()

        def tracked(*args, **kwargs):
            try:
                run(*args, **kwargs)
            finally:
                done.set()

        self.server._run_line = tracked
        status, said = self.request("POST", "/say", {"text": CAT})
        self.assertEqual(status, 202)
        self.assertTrue(done.wait(5))  # the cut runs on the line's own thread, which holds the mouth
        self.assertEqual(self.server.turn_generation, said["generation"] + 1)
        self.assertEqual([e["turn_generation"] for e in self.speech_cancelled()], [said["generation"] + 1])
        self.assertEqual(self.row(said["line_id"])["state"], "cancelled")
        self.assertFalse(self.in_window(CAT))

    def speech_cancelled(self):
        return [i for i in self.server.registry.intents_since(0) if i.get("event") == "speech_cancelled"]


class BulkDeleteTest(MemoryServerCase):
    """DELETE /observation?range= and DELETE /memory?scope= cut and take back turns as DELETE /memory/facts/<id>."""

    speech_cancelled = ChangedSourceTest.speech_cancelled

    def cut_mid_line(self, text, method, path):
        self.use_mouth(["第一段", "第二段", "第三段", "第四段。"], delay=0.3)
        self.fake.hold = threading.Event()  # a slow delete still finds the line streaming
        conn, response = self.open_feed()
        status, body = self.request("POST", "/say", {"text": text})
        self.assertEqual(status, 202)
        first = self.next_event(response)
        while first["event"] != "line":
            first = self.next_event(response)
        # Only now: a line whose context drew on attention is cut as context_cleared, not by its facts.
        self.server.attention = AttentionStore(Path(self.data.name) / "attention.sqlite",
                                               Blacklist(deny_blacklist(Path(self.data.name) / "blacklist.json")))
        self.addCleanup(self.server.attention.close)
        self.assertEqual(self.request(method, path)[0], 200)
        self.fake.hold.set()
        events = [json.loads(first["data"])] + self.lines_until_final(response)
        conn.close()
        self.assertTrue(wait_for(lambda: not self.server._live_lines))
        self.assertTrue(events[-1]["cancelled"])
        self.assertNotIn("第四段", "".join(e["text_delta"] for e in events))
        self.assertEqual([e["turn_generation"] for e in self.speech_cancelled()], [body["generation"] + 1])
        self.assertEqual(self.row(body["line_id"])["state"], "cancelled")
        self.assertFalse(self.in_window(text))

    def test_deleting_recent_observations_cancels_the_turn_using_an_inferred_fact(self):
        self.server.share_page_text = True  # a turn carries an observed fact only with page_text
        self.memory.add("可能喜欢狗", "inferred_hypothesis")
        self.cut_mid_line("可能喜欢狗吗", "DELETE", "/observation?range=15m")

    def test_clearing_facts_cancels_the_turn_using_one(self):
        self.memory.add("我养了一只猫", "asserted_by_user")
        self.cut_mid_line(CAT, "DELETE", "/memory?scope=facts")

    def test_clearing_facts_takes_back_every_turn_that_said_one_and_empties_them(self):
        self.use_trace()
        self.memory.add("我养了一只猫", "asserted_by_user")
        self.use_mouth(["[intent:greet]你养了一只猫", "啊。"])
        older, _ = self.line(CAT)
        latest, _ = self.line("我养了一只猫，再说一句")
        counts = [len(self.traced(s["line_id"])) for s in (older, latest)]
        self.assertEqual(self.request("DELETE", "/memory?scope=facts"),
                         (200, {"facts_deleted": 1, "history_deleted": 0}))
        for said, count in zip((older, latest), counts):
            row = self.row(said["line_id"])
            self.assertEqual((row["state"], row["user_text"], row["reply"], row["raw_reply"]),
                             ("cancelled", "", "", None))
            self.assertForgotten(said["line_id"], count)
        self.assertEqual((self.in_window(CAT), self.in_window("我养了一只猫，再说一句")), (False, False))


class InjectionTest(MemoryServerCase):
    def uses(self):
        return open_store(self.db).execute("SELECT fact_id, version, line_id, mode FROM fact_uses"
                                           " ORDER BY rowid").fetchall()

    def test_trusted_facts_and_guesses_are_both_injected(self):
        self.server.share_page_text = True  # a turn carries an observed fact only with page_text
        cat = self.memory.add("我养了一只猫", "asserted_by_user")
        dog = self.memory.add("可能喜欢狗", "inferred_hypothesis")
        said, _ = self.line("我养了一只猫，可能喜欢狗吗")
        self.assertEqual(sorted(self.uses()), sorted([(cat, 1, said["line_id"], "injected"),
                                                      (dog, 1, said["line_id"], "injected")]))
        self.assertTrue(all(f["last_used_at"] is not None for f in self.memory.active()))

    def test_only_selected_facts_are_injected_touched_and_recorded(self):
        cat = self.memory.add("我养了一只猫", "asserted_by_user")
        self.memory.add("我在上海工作", "asserted_by_user")
        self.memory.add("可能喜欢狗", "inferred_hypothesis")
        said, _ = self.line(CAT)
        self.assertEqual({f["fact_id"] for f in self.memory.active() if f["last_used_at"] is not None}, {cat})
        self.assertEqual(self.uses(), [(cat, 1, said["line_id"], "injected")])

    def test_a_reply_that_mentions_a_fact_is_recorded_as_mentioned(self):
        cat = self.memory.add("我养了一只猫", "asserted_by_user")
        self.line(CAT)  # REPLY does not mention it
        self.assertEqual([mode for *_, mode in self.uses()], ["injected"])
        self.use_mouth(["[intent:greet]你养了一只猫", "啊。"])
        said, _ = self.line("我养了一只猫，你说呢")
        self.assertEqual(self.uses()[1:], [(cat, 1, said["line_id"], "injected"),
                                           (cat, 1, said["line_id"], "mentioned")])

    def test_deleting_an_unselected_fact_mid_line_keeps_the_turn(self):
        self.memory.add("我养了一只猫", "asserted_by_user")
        place = self.memory.add("我在上海工作", "asserted_by_user")
        self.use_mouth(["第一段", "第二段", "第三段", "第四段。"], delay=0.3)
        conn, response = self.open_feed()
        status, body = self.request("POST", "/say", {"text": CAT})
        self.assertEqual(status, 202)
        first = self.next_event(response)
        while first["event"] != "line":
            first = self.next_event(response)
        self.assertEqual(self.request("DELETE", f"/memory/facts/{place}?expected_version=1"), (200, {"deleted": True}))
        events = [json.loads(first["data"])] + self.lines_until_final(response)
        conn.close()
        self.assertTrue(wait_for(lambda: not self.server._live_lines))
        self.assertFalse(events[-1]["cancelled"])
        self.assertIn("第四段", "".join(e["text_delta"] for e in events))
        self.assertEqual(self.row(body["line_id"])["state"], "completed")
        self.assertTrue(self.in_window(CAT))

    def test_memory_lists_each_fact_s_uses(self):
        cat = self.memory.add("我养了一只猫", "asserted_by_user")
        place = self.memory.add("我在上海工作", "asserted_by_user")
        self.use_mouth(["[intent:greet]你养了一只猫", "啊。"])
        said, _ = self.line(CAT)
        facts = {f["fact_id"]: f for f in self.facts()}
        self.assertEqual(facts[place]["text"], "我在上海工作")
        self.assertEqual({k: facts[place][k] for k in ("uses_today", "last_injected_at", "last_mentioned_at",
                                                        "recent_uses")}, {"uses_today": 0, "last_injected_at": None,
                                                                          "last_mentioned_at": None, "recent_uses": []})
        used = facts[cat]
        self.assertEqual(used["uses_today"], 1)
        self.assertIsInstance(used["last_injected_at"], float)
        self.assertIsInstance(used["last_mentioned_at"], float)
        self.assertEqual([(u["line_id"], u["mode"]) for u in used["recent_uses"]],
                         [(said["line_id"], "mentioned"), (said["line_id"], "injected")])
        self.assertEqual(set(used["recent_uses"][0]), {"line_id", "at", "mode"})

    def test_a_ritual_line_picks_facts_by_its_kind_not_its_prompt(self):
        cake = self.memory.add("生日想吃蛋糕", "asserted_by_user")
        self.memory.add("我在上海工作", "asserted_by_user")
        self.server.character_agent = test_server.KernelLines(self.server)  # a ritual line runs on the character agent
        self.server.start_line("ritual-1", "（说说上海工作）", reason={"code": "ritual", "kind": "birthday"},
                               source="ritual")
        self.assertTrue(wait_for(lambda: self.uses() and not self.server._live_lines))
        self.assertEqual(self.uses(), [(cake, 1, "ritual-1", "injected")])


class DeleteRecentTest(MemoryServerCase):
    """DELETE /observation drops what was seen since the cutoff and the facts inferred from it."""

    def setUp(self):
        super().setUp()
        self.now = float(round(time.time()))  # whole seconds: the event spans below compare exactly
        clock = lambda: self.now  # noqa: E731
        self.server.clock = clock
        self.server.speech = None  # /diag/state asks a relay what FakeRelay does not answer
        self.server.memory = self.memory = Memory(open_store(self.db), clock=clock)
        self.server.attention = AttentionStore(Path(self.data.name) / "attention.sqlite",
                                               Blacklist(deny_blacklist(Path(self.data.name) / "blacklist.json")), clock=clock)
        self.addCleanup(self.server.attention.close)
        self.server.capture = CaptureManager(self.server.feed, self.server.attention.blacklist,
                                             lambda: test_capture.CODE, None, clock=clock,
                                             vision=SimpleNamespace(describe=lambda png, user: "用户在看代码"))

    def beats(self, start, count, app):
        for i in range(count):
            self.server.attention.ingest({"ts": start + i, "front": {"app": app, "window_id": 1}, "idle_s": 0.0})

    def test_delete_recent_drops_what_was_seen_after_the_cutoff_and_its_facts(self):
        base = self.now
        cutoff = base - 900
        attention, capture = self.server.attention, self.server.capture
        self.beats(base - 1200, 10, "Old")
        self.beats(cutoff - 5, 11, "Crossing")
        self.beats(base - 600, 10, "Late")
        for ts, host in ((base - 1000, "old.example"), (cutoff, "edge.example"), (base - 300, "new.example")):
            attention.ingest_browser({"type": "page", "ts": ts, "url_host": host, "title": host, "text": "正文"})
        self.now = base - 1000
        old_fact = self.memory.add("以前看到的", "observed_context")
        old_look = self.request("POST", "/look", {})[1]["request_id"]
        self.now = base - 60
        new_fact = self.memory.add("刚才看到的", "observed_context")
        guess = self.memory.add("刚才猜的", "inferred_hypothesis")
        told = self.memory.add("刚才说的", "asserted_by_user")
        new_look = self.request("POST", "/look", {})[1]["request_id"]
        capture.image(new_look, 2, test_capture.png())
        self.assertTrue(wait_for(lambda: capture.view() is not None))
        self.assertIn(new_look, json.dumps(self.request("GET", "/diag/state")[1]["observation"]))
        self.now = base

        self.assertEqual(self.request("DELETE", "/observation?range=15m"),
                         (200, {"events": 3, "context": 2, "observations": 1, "facts": 2}))
        self.assertEqual([(e["data"]["app"], e["start"], e["duration"]) for e in attention.events("window")],
                         [("Old", base - 1200, 9.0), ("Crossing", cutoff - 5, 5.0)])
        self.assertEqual([c["url_host"] for c in attention.context()], ["old.example"])
        self.assertEqual((capture.observation(new_look), capture.view()), (None, None))
        self.assertIsNotNone(capture.observation(old_look))
        self.assertNotIn(new_look, json.dumps(self.request("GET", "/diag/state")[1]["observation"]))
        self.assertEqual({f["fact_id"] for f in self.facts()}, {old_fact, told})
        self.assertEqual(sorted((i["data"]["action"], i["data"]["fact_id"]) for i in self.server.feed.since(0)
                                if i["event"] == "memory"), sorted([("deleted", new_fact), ("deleted", guess)]))

    def test_delete_recent_blanks_the_trace_words_of_a_turn_that_said_a_deleted_fact(self):
        self.server.share_page_text = True  # a turn carries an observed fact only with page_text
        self.use_trace()
        self.now -= 60
        self.memory.add("我养了一只猫", "observed_context")
        self.now += 60
        self.use_mouth(["[intent:greet]你养了一只猫", "啊。"])
        said, _ = self.line(CAT)
        count = len(self.traced(said["line_id"]))
        self.assertEqual(self.request("DELETE", "/observation?range=15m")[1]["facts"], 1)
        self.assertForgotten(said["line_id"], count)

    def test_bad_range_and_token(self):
        for query in ("?range=2h", "?range=", ""):
            with self.subTest(query=query):
                self.assertEqual(self.request("DELETE", f"/observation{query}"), (400, {"error": "invalid_range"}))
        self.assertEqual(self.request("DELETE", "/observation?range=1h", token=EVENTS)[0], 401)
        self.assertEqual(self.request("DELETE", "/observation?range=today"),
                         (200, {"events": 0, "context": 0, "observations": 0, "facts": 0}))


class DerivedFactsTest(MemoryServerCase):
    """A fact consolidated from episodes goes with any one of them, on every path that deletes episodes."""

    def setUp(self):
        super().setUp()
        self.now = float(round(time.time()))
        clock = lambda: self.now  # noqa: E731
        self.server.clock = clock
        self.server.speech = None
        self.server.memory = self.memory = Memory(open_store(self.db), clock=clock)
        self.server.attention = AttentionStore(Path(self.data.name) / "attention.sqlite",
                                               Blacklist(deny_blacklist(Path(self.data.name) / "blacklist.json")), clock=clock)
        self.addCleanup(self.server.attention.close)
        self.server.episodes = self.episodes = Episodes(open_store(self.db), clock=clock)
        self.server.share_page_text = True  # a turn carries an observed fact only with page_text
        self.use_trace()

    def episode(self, start, app="Code"):
        """A new episode's evidence string."""
        row_id = add_episode(self.episodes, start, start + 600, "写代码", "你在写代码。", [{"subject": "写代码"}],
                             requires=["page_text"], apps=[app])
        return f"episode:{row_id}@{datetime.date.fromtimestamp(start).isoformat()}"

    def derive(self, evidence, kept):
        """Two days ago: an inferred fact and a candidate from evidence, and a fact from kept; then a line says the
        inferred one again. ({inferred, candidate}, kept fact, line_id, its trace event count)."""
        self.now -= 2 * 86400
        facts = {self.memory.add("我养了一只猫", "inferred_hypothesis", evidence=evidence),
                 self.memory.add("可能常在晚上写代码", "inferred_hypothesis", evidence=evidence, state="candidate")}
        other = self.memory.add("在写 agentd", "observed_context", evidence=kept)
        self.now += 2 * 86400
        self.use_mouth(["[intent:greet]你养了一只猫", "啊。"])
        said, _ = self.line(CAT)
        return facts, other, said["line_id"], len(self.traced(said["line_id"]))

    def deleted(self):
        return {i["data"]["fact_id"] for i in self.server.feed.since(0)
                if i["event"] == "memory" and i["data"]["action"] == "deleted"}

    def assertDerivedGone(self, facts, other, line_id, count):
        self.assertEqual([f["fact_id"] for f in self.memory.active()], [other])
        self.assertFalse(facts & {f["fact_id"] for f in self.memory.consolidated()})
        rows = open_store(self.db).execute("SELECT text, state FROM facts WHERE fact_id IN (?, ?)",
                                           tuple(facts)).fetchall()
        self.assertEqual(rows, [(None, "deleted")] * 2)
        self.assertEqual(self.deleted(), facts)
        row = self.row(line_id)
        self.assertEqual((row["state"], row["user_text"], row["reply"]), ("cancelled", "", ""))
        self.assertFalse(self.in_window(CAT))
        self.assertForgotten(line_id, count)

    def test_delete_observation_takes_the_facts_of_a_deleted_episode(self):
        old = self.episode(self.now - 3 * 86400)
        facts, other, line_id, count = self.derive([old, self.episode(self.now - 1200)], ["obs-1"])
        status, body = self.request("DELETE", "/observation?range=1h")
        self.assertEqual((status, body["episodes"], body["facts"]), (200, 1, 2))
        self.assertDerivedGone(facts, other, line_id, count)

    def test_delete_observation_keeps_the_facts_of_other_episodes(self):
        old = self.episode(self.now - 3 * 86400)
        self.episode(self.now - 1200)
        facts, other, _, _ = self.derive([old], [old])
        status, body = self.request("DELETE", "/observation?range=1h")
        self.assertEqual((status, body["episodes"], body["facts"]), (200, 1, 0))
        self.assertEqual({f["fact_id"] for f in self.memory.consolidated()}, facts | {other})
        self.assertEqual(self.deleted(), set())

    def test_blacklisting_an_app_takes_the_facts_of_its_episodes(self):
        kept = self.episode(self.now - 1800)
        facts, other, line_id, count = self.derive([self.episode(self.now - 1200, app="x.Marker")], [kept])
        body = {"field": "bundle_ids", "value": "x.Marker", "delete_existing": True}
        self.assertEqual(self.request("POST", "/blacklist", body)[0], 200)
        self.assertEqual(len(self.episodes.between(0, self.now)), 1)
        self.assertDerivedGone(facts, other, line_id, count)

    def test_revoking_page_text_takes_every_episode_fact(self):
        config = Path(self.data.name) / "config.json"
        config.write_text(json.dumps({"share_page_text": True}), encoding="utf-8")
        self.server.share_page_text, self.server.privacy_config = True, str(config)
        self.server.sync_privacy()
        facts, other, line_id, count = self.derive([self.episode(self.now - 1200)], ["obs-1"])
        config.write_text(json.dumps({"share_page_text": False}), encoding="utf-8")
        self.server.sync_privacy()
        self.assertEqual(self.episodes.between(0, self.now), [])
        self.assertDerivedGone(facts, other, line_id, count)

    def test_a_revocation_a_line_notices_under_the_mouth_lock_does_not_hang(self):
        config = Path(self.data.name) / "config.json"
        config.write_text(json.dumps({"share_page_text": True}), encoding="utf-8")
        self.server.share_page_text, self.server.privacy_config = True, str(config)
        self.server.sync_privacy()
        facts, other, line_id, count = self.derive([self.episode(self.now - 1200)], ["obs-1"])
        config.write_text(json.dumps({"share_page_text": False}), encoding="utf-8")
        with self.server._mouth_lock:  # a line holds it while it reads its context (_run_line)
            noticed = threading.Thread(target=self.server.sync_privacy, daemon=True)
            noticed.start()
            noticed.join(2)
            self.assertFalse(noticed.is_alive())
            self.assertEqual(self.deleted(), facts)  # the facts go at once; the turns that said them once it is free
        deadline = time.monotonic() + 2
        while self.row(line_id)["state"] != "cancelled" and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertDerivedGone(facts, other, line_id, count)

    def test_delete_attention_takes_every_episode_fact(self):
        facts, other, line_id, _ = self.derive([self.episode(self.now - 1200)], ["obs-1"])
        self.assertEqual(self.request("DELETE", "/attention")[0], 200)
        self.assertEqual(self.episodes.between(0, self.now), [])
        self.assertDerivedGone(facts, other, line_id, 0)  # DELETE /attention clears every trace event


class MemoryErrorTest(MemoryServerCase):
    def test_bad_requests(self):
        for method, path, body in (("PATCH", "/memory/facts/missing", {"expected_version": 1, "text": "x"}),
                                   ("POST", "/memory/facts/missing/confirm", {"expected_version": 1}),
                                   ("DELETE", "/memory/facts/missing?expected_version=1", None)):
            self.assertEqual(self.request(method, path, body), (404, {"error": "unknown_fact"}), path)
        for text in ("", "  ", "字" * 501, None):
            self.assertEqual(self.request("POST", "/memory/facts", {"text": text}), (400, {"error": "invalid_text"}))
        self.assertEqual(self.request("POST", "/memory/facts", {"text": "a", "kind": "mood"}),
                         (400, {"error": "invalid_kind"}))
        fact_id = self.memory.add("我在上海", "asserted_by_user")
        self.assertEqual(self.request("PATCH", f"/memory/facts/{fact_id}", {"expected_version": 1, "text": " "}),
                         (400, {"error": "invalid_text"}))
        for path in ("/memory?scope=everything", "/memory"):
            self.assertEqual(self.request("DELETE", path), (400, {"error": "invalid_scope"}), path)
        self.assertEqual(self.request("PUT", "/memory/paused", {"paused": "yes"})[0], 400)
        self.assertFalse(self.memory.paused())
        for method, path, body in (("GET", "/memory", None), ("GET", "/memory/export", None),
                                   ("POST", "/memory/facts", {"text": "x"}), ("PUT", "/memory/paused", {"paused": True}),
                                   ("DELETE", f"/memory/facts/{fact_id}?expected_version=1", None), ("DELETE", "/memory", None)):
            self.assertEqual(self.request(method, path, body, token=EVENTS)[0], 401, path)
        self.assertEqual([f["fact_id"] for f in self.memory.active()], [fact_id])

    def test_no_store_answers_503(self):
        self.server.memory = None
        for method, path, body in (("GET", "/memory", None), ("GET", "/memory/export", None),
                                   ("POST", "/memory/facts", {"text": "x"}),
                                   ("PATCH", "/memory/facts/a", {"expected_version": 1, "text": "x"}),
                                   ("POST", "/memory/facts/a/confirm", {"expected_version": 1}),
                                   ("PUT", "/memory/paused", {"paused": True}),
                                   ("DELETE", "/memory/facts/a?expected_version=1", None), ("DELETE", "/memory?scope=all", None)):
            self.assertEqual(self.request(method, path, body), (503, {"error": "no_memory", "detail": "记忆没有开启"}),
                             path)


if __name__ == "__main__":
    unittest.main()
