from pathlib import Path
import sys
from types import SimpleNamespace
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import c1  # noqa: E402
from brain.language import ReplyLanguage  # noqa: E402
from personal.commitments import Commitments  # noqa: E402
from daemon.agentd_server import AgentdServer  # noqa: E402
from infra.store import open_store  # noqa: E402
from sessions.events import normalize_claude  # noqa: E402
from traces.trace_store import TraceStore  # noqa: E402
import test_server  # noqa: E402
from support import enable_plugins, serve_in_thread  # noqa: E402

HOOK, UI = "hook-token", "ui-token"


def local(day, hour, minute=0):
    """Unix seconds of 2026-10-<day> hour:minute in the local time zone."""
    return time.mktime((2026, 10, day, hour, minute, 0, 0, 0, -1))


class CommitmentServerTest(unittest.TestCase):
    """MC: 「提醒我…」 is kept, confirmed, said when due and once when a restart missed it."""
    request = test_server.SayTest.request
    wait_for = test_server.AvatarVisibilityTest.wait_for

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.now = local(23, 10)
        self.server = self.start()

    def start(self, tick_interval=3600):
        """A server with its commitments on a db of its own; the long tick leaves _commitments_due to the test."""
        server = AgentdServer(("127.0.0.1", 0), HOOK, UI, tick_interval=tick_interval)
        server.character_agent = test_server.KernelLines(server)
        server.mouth = test_server.FakeMouth([])
        server.clock = lambda: self.now
        server.speech = test_server.FakeRelay()
        db = open_store(Path(self.tmp.name) / "agentd.sqlite")
        self.addCleanup(db.close)
        server.commitments = Commitments(db, clock=lambda: self.now)
        thread = serve_in_thread(server)

        def stop():
            server.shutdown()
            server.server_close()
            thread.join(2)
        self.addCleanup(stop)
        return server

    def feed(self, event, server=None):
        return [i["data"] for i in (server or self.server).feed.since(0) if i["event"] == event]

    def changes(self):
        """The commitment items of the feed, without their feed seq."""
        return [{k: v for k, v in data.items() if k != "seq"} for data in self.feed("commitment")]

    def test_reminder_sentences_go_to_the_character_llm(self):
        for text in ("提醒我十分钟后喝水", "示例甲，提醒我明天8点开会", "提醒我喝水", "提醒我月底前续费"):
            with self.subTest(text=text):
                status, body = self.request("POST", "/say", {"text": text})
                self.assertEqual(status, 202, body)
                self.assertIn("run_id", body)
                self.assertTrue(self.wait_for(lambda: not self.server._live_lines))
        self.assertEqual(self.server.commitments.list(), [])

    def test_without_commitments_a_due_tick_is_a_noop(self):
        self.server.commitments = None
        self.server._commitments_due()

    def test_a_due_reminder_is_said_and_fulfilled(self):
        item = self.server.commitments.add("喝水", self.now + 600)
        self.server._commitments_due()
        self.assertEqual(self.feed("announce"), [])
        self.now += 600
        self.server._commitments_due()
        [due] = self.feed("announce")
        self.assertEqual((due["kind"], due["level"], due["headline"], due["speak"]),
                         ("reminder_due", "P0", "日程提醒：喝水", True))
        [done] = self.server.commitments.list()
        self.assertEqual((done["id"], done["state"]), (item["id"], "fulfilled"))
        self.assertEqual(self.changes(), [{"action": "fulfilled", "commitment": done}])

    def test_reminders_due_together_are_one_announcement(self):
        self.server.commitments.add("喝水", self.now + 60)
        self.server.commitments.add("开会", self.now + 120)
        self.now += 120
        self.server._commitments_due()
        water, meeting = self.server.commitments.list()
        self.assertEqual([(a["kind"], a["headline"], a["origin"], a["commitment_ids"]) for a in self.feed("announce")],
                         [("reminder_due", "日程提醒：喝水；开会", water["id"], [water["id"], meeting["id"]])])
        self.assertEqual([c["state"] for c in self.server.commitments.list()], ["fulfilled", "fulfilled"])
        self.assertEqual(len(self.feed("commitment")), 2)

    def test_a_shown_only_due_reminder_stays_triggered(self):
        for mode in ("muted", "voice_off", "hidden", "no_speech", "closing"):
            with self.subTest(mode=mode):
                self.server.muted = mode == "muted"
                self.server.character_voice_enabled = mode != "voice_off"
                self.server.avatar["visible"] = mode != "hidden"
                self.server.speech = None if mode == "no_speech" else test_server.FakeRelay()
                self.server.closing = mode == "closing"
                item = self.server.commitments.add("喝水", self.now)
                self.server._commitments_due()
                self.server._commitments_due()
                [due] = [a for a in self.feed("announce") if a["origin"] == item["id"]]
                self.assertEqual((due["kind"], due["headline"]), ("reminder_due", "日程提醒：喝水"))
                [kept] = [c for c in self.server.commitments.list() if c["id"] == item["id"]]
                self.assertEqual(kept["state"], "triggered")
                self.assertEqual(self.changes(), [])

    def events_after(self, seq):
        return [i for i in self.server.registry.intents_since(seq) if "event" in i]

    def test_a_due_reminder_without_voice_greets_as_a_text_line(self):
        self.server.speech = None
        self.server.commitments.add("喝水", self.now)
        before = self.server.registry.intent_seq
        self.server._commitments_due()
        [due] = self.feed("announce")
        started, intent, ended = self.events_after(before)
        generation, trace, line_id = self.server.turn_generation, started["trace_id"], f"announce-{due['seq']}"
        self.assertEqual({k: v for k, v in started.items() if k != "seq"},
                         {"event": "text_line", "line_id": line_id, "turn_generation": generation,
                          "trace_id": trace, "state": "started"})
        self.assertEqual({k: v for k, v in intent.items() if k != "seq"},
                         {"event": "clause_intent", "line_id": line_id, "utterance_id": None, "clause_id": None,
                          "spoken_text_revision": None, "intent": "greet", "turn_generation": generation,
                          "trace_id": trace})
        self.assertEqual({k: v for k, v in ended.items() if k != "seq"},
                         {"event": "text_line", "line_id": line_id, "turn_generation": generation,
                          "trace_id": trace, "state": "ended", "hold_ms": 60 * len("日程提醒：喝水")})
        self.assertIsInstance(trace, str)
        for event in (started, intent, ended):
            self.assertEqual(c1.check_message(event), [])

    def test_a_silent_or_hidden_due_reminder_sends_no_text_line(self):
        for mode in ("quiet", "hidden"):
            with self.subTest(mode=mode):
                self.server.speech = None
                self.server.quiet_until = self.now + 3600 if mode == "quiet" else None
                self.server.avatar["visible"] = mode != "hidden"
                item = self.server.commitments.add("喝水", self.now)
                before = self.server.registry.intent_seq
                self.server._commitments_due()
                self.assertTrue([a for a in self.feed("announce") if a["origin"] == item["id"]])
                self.assertEqual(self.events_after(before), [])

    def test_a_due_reminder_without_voice_leaves_a_working_focus_alone(self):
        self.server.speech = None
        self.server.ingest(normalize_claude({"hook_event_name": "UserPromptSubmit", "session_id": "A", "cwd": "/w"},
                                            now=time.time()))
        self.server.commitments.add("喝水", self.now)
        before = self.server.registry.intent_seq
        self.server._commitments_due()
        self.assertTrue(self.feed("announce"))
        self.assertEqual([e for e in self.events_after(before) if e["event"] in ("text_line", "clause_intent")], [])

    def test_a_voiced_due_reminder_sends_no_text_line(self):
        self.server.commitments.add("喝水", self.now)
        before = self.server.registry.intent_seq
        self.server._commitments_due()
        self.assertEqual([c[2] for c in self.server.speech.calls if c[0] == "speak"], ["日程提醒：喝水"])
        self.assertEqual([e for e in self.events_after(before) if e["event"] == "text_line"], [])

    def test_a_slotted_due_reminder_is_fulfilled(self):
        self.server.switch = {"id": "switch"}
        item = self.server.commitments.add("喝水", self.now)
        self.server._commitments_due()
        self.assertEqual(self.server.speech.calls, [])
        self.assertIn("reminder_due", self.server._announce_slots)
        [done] = self.server.commitments.list()
        self.assertEqual((done["id"], done["state"]), (item["id"], "fulfilled"))
        self.assertEqual(self.changes(), [{"action": "fulfilled", "commitment": done}])

    def test_snooze_from_triggered_announces_again_only_at_the_new_time(self):
        item = self.server.commitments.add("喝水", self.now)
        self.server.muted = True
        self.server._commitments_due()
        status, body = self.request("POST", f"/commitments/{item['id']}/snooze", {"minutes": 10})
        self.assertEqual(status, 200)
        snoozed = body["commitment"]
        self.assertEqual((snoozed["state"], snoozed["due_at"]), ("armed", self.now + 600))
        self.assertEqual(self.changes(), [{"action": "snoozed", "commitment": snoozed}])
        self.server.muted = False
        self.now += 599
        self.server._commitments_due()
        self.assertEqual(len(self.feed("announce")), 1)
        self.now += 1
        self.server._commitments_due()
        self.assertEqual([a["headline"] for a in self.feed("announce")], ["日程提醒：喝水", "日程提醒：喝水"])
        self.assertEqual(self.server.commitments.list()[0]["state"], "fulfilled")

    def test_snooze_across_midnight(self):
        self.now = local(23, 23, 55)
        item = self.server.commitments.add("喝水", self.now)
        self.server.commitments.due()
        status, body = self.request("POST", f"/commitments/{item['id']}/snooze", {"minutes": 10})
        self.assertEqual(status, 200)
        self.assertEqual(body["commitment"]["due_at"], local(24, 0, 5))
        self.now = local(24, 0, 4)
        self.server._commitments_due()
        self.assertEqual(self.feed("announce"), [])
        self.now = local(24, 0, 5)
        self.server._commitments_due()
        self.assertEqual([a["headline"] for a in self.feed("announce")], ["日程提醒：喝水"])

    def test_snooze_from_armed_for_sixty_minutes(self):
        item = self.server.commitments.add("喝水", self.now + 600)
        status, body = self.request("POST", f"/commitments/{item['id']}/snooze", {"minutes": 60})
        self.assertEqual(status, 200)
        self.assertEqual((body["commitment"]["state"], body["commitment"]["due_at"]),
                         ("armed", self.now + 3600))
        self.assertEqual(self.changes(), [{"action": "snoozed", "commitment": body["commitment"]}])

    def test_snooze_minutes_15(self):
        item = self.server.commitments.add("喝水", self.now)
        self.server.commitments.due()
        for minutes in (15, 5):
            status, body = self.request("POST", f"/commitments/{item['id']}/snooze", {"minutes": minutes})
            self.assertEqual((status, body["commitment"]["state"], body["commitment"]["due_at"]),
                             (200, "armed", self.now + minutes * 60))

    def test_snooze_a_reminder_delivered_within_a_day(self):
        item = self.server.commitments.add("喝水", self.now)
        self.server._commitments_due()
        self.assertEqual(self.server.commitments.list()[0]["state"], "fulfilled")
        self.now += 60
        status, body = self.request("POST", f"/commitments/{item['id']}/snooze", {"minutes": 5})
        self.assertEqual((status, body["commitment"]["state"], body["commitment"]["due_at"]),
                         (200, "armed", self.now + 300))

    def test_snooze_rejects_invalid_minutes(self):
        item = self.server.commitments.add("喝水", self.now + 600)
        for payload in ({"minutes": 30}, {"minutes": "10"}, {}, None, [], {"minutes": True},
                        {"minutes": 10.0}, {"minutes": 10, "extra": 1}):
            with self.subTest(payload=payload):
                self.assertEqual(self.request("POST", f"/commitments/{item['id']}/snooze", payload),
                                 (400, {"error": "invalid_payload", "field": "minutes"}))
        self.assertEqual(self.server.commitments.list(), [item])
        self.assertEqual(self.changes(), [])

    def test_complete_from_armed_and_triggered(self):
        for state in ("armed", "triggered"):
            with self.subTest(state=state):
                item = self.server.commitments.add("喝水", self.now if state == "triggered" else self.now + 600)
                self.server.commitments.due()
                status, body = self.request("POST", f"/commitments/{item['id']}/complete")
                self.assertEqual(status, 200)
                done = body["commitment"]
                self.assertEqual((done["id"], done["state"]), (item["id"], "fulfilled"))
                self.assertEqual(self.changes()[-1], {"action": "completed", "commitment": done})
        self.now += 600
        self.server._commitments_due()
        self.assertEqual(self.feed("announce"), [])

    def test_complete_and_snooze_reject_terminal_unknown_and_unavailable_items(self):
        for action, payload in (("complete", None), ("snooze", {"minutes": 10})):
            with self.subTest(action=action):
                for state in ("fulfilled", "cancelled", "missed"):
                    item = self.server.commitments.add("喝水", self.now)
                    if state == "fulfilled":
                        self.server.commitments.due()
                        self.server.commitments.fulfill(item["id"], None)
                        self.server.commitments.db.execute("UPDATE commitments SET updated_at = ? WHERE id = ?",
                                                           (self.now - 86401, item["id"]))
                    elif state == "cancelled":
                        self.server.commitments.cancel(item["id"])
                    else:
                        self.server.commitments.due()
                        self.server.commitments.recover()
                    self.assertEqual(self.request("POST", f"/commitments/{item['id']}/{action}", payload),
                                     (409, {"error": "illegal_transition"}))
                self.assertEqual(self.request("POST", f"/commitments/nope/{action}", payload),
                                 (404, {"error": "unknown_commitment"}))
                commitments, self.server.commitments = self.server.commitments, None
                self.assertEqual(self.request("POST", f"/commitments/nope/{action}", payload),
                                 (503, {"error": "no_commitments"}))
                self.server.commitments = commitments
        self.assertEqual(self.changes(), [])

    def test_a_due_reminder_and_a_decision_trace_on_one_store_lock_both_finish(self):
        """The reminder tick and a decision trace share the store's lock; neither may wait on the other's."""
        db = self.server.commitments.db
        store_lock = db._idle_lock
        self.server.commitments = Commitments(db, lock=store_lock, clock=lambda: self.now)
        self.server.trace = TraceStore(db, self.server.registry.epoch, lock=store_lock)
        self.server.commitments.add("喝水", self.now)
        announcing, tracing, blocked = threading.Event(), threading.Event(), []
        emit = self.server.trace.emit

        def admit(kind, level):
            announcing.set()
            tracing.wait(5)
            return True, None

        def traced(*args, **kwargs):
            tracing.set()
            # Holding _decision_lock: a store lock the tick keeps across its announcement never frees.
            if not store_lock.acquire(timeout=2):
                blocked.append("store lock held by the reminder tick")
                return None
            store_lock.release()
            return emit(*args, **kwargs)

        self.server.gate.admit, self.server.trace.emit = admit, traced
        tick = threading.Thread(target=self.server._commitments_due, daemon=True)
        decision = threading.Thread(target=lambda: (announcing.wait(5),
                                                    self.server._decision("gate.decided", {}, "k")), daemon=True)
        tick.start()
        decision.start()
        tick.join(10)
        decision.join(10)
        self.assertFalse(tick.is_alive() or decision.is_alive())
        self.assertEqual(blocked, [])
        self.assertEqual([c["state"] for c in self.server.commitments.list()], ["fulfilled"])

    def test_a_reminder_the_user_changes_while_it_is_announced_keeps_the_change(self):
        item = self.server.commitments.add("喝水", self.now)
        admit = self.server.gate.admit

        def cancel_meanwhile(kind, level):
            self.server.commitments.cancel(item["id"])
            return admit(kind, level)

        self.server.gate.admit = cancel_meanwhile
        self.server._commitments_due()
        [kept] = self.server.commitments.list()
        self.assertEqual(kept["state"], "cancelled")
        self.assertEqual(self.changes(), [])

    def test_cancel_from_triggered(self):
        item = self.server.commitments.add("喝水", self.now)
        self.server.commitments.due()
        status, body = self.request("POST", f"/commitments/{item['id']}/cancel")
        self.assertEqual(status, 200)
        self.assertEqual(body["commitment"]["state"], "cancelled")
        self.assertEqual(self.changes(), [{"action": "cancelled", "commitment": body["commitment"]}])

    def test_a_shown_card_is_recorded_once(self):
        item = self.server.commitments.add("喝水", self.now)
        self.server._commitments_due()
        [due] = self.feed("announce")
        self.assertEqual(due["commitment_ids"], [item["id"]])
        self.now += 5
        status, body = self.request("POST", f"/commitments/{item['id']}/seen", {})
        self.assertEqual(status, 200)
        seen = body["commitment"]
        self.assertEqual((seen["id"], seen["state"], seen["seen_at"]), (item["id"], "fulfilled", self.now))
        self.assertEqual(self.server.commitments.list(), [seen])
        self.assertEqual(self.changes()[-1], {"action": "seen", "commitment": seen})
        changes = len(self.changes())
        self.now += 5
        self.assertEqual(self.request("POST", f"/commitments/{item['id']}/seen", {}), (200, {"commitment": seen}))
        self.assertEqual(len(self.changes()), changes)
        self.assertEqual(self.request("POST", "/commitments/nope/seen", {}), (404, {"error": "unknown_commitment"}))
        for payload in ({"at": 1}, [], "x"):
            with self.subTest(payload=payload):
                self.assertEqual(self.request("POST", f"/commitments/{item['id']}/seen", payload),
                                 (400, {"error": "invalid_payload"}))
        for token in (None, HOOK):
            with self.subTest(token=token):
                self.assertEqual(self.request("POST", f"/commitments/{item['id']}/seen", {}, token=token)[0], 401)
        self.assertEqual(len(self.changes()), changes)
        self.server.commitments = None
        self.assertEqual(self.request("POST", f"/commitments/{item['id']}/seen", {}), (503, {"error": "no_commitments"}))

    def test_quiet_mode_delivers_due_reminder_as_silent_card(self):
        item = self.server.commitments.add("喝水", self.now + 600)
        self.assertEqual(self.request("PUT", "/observation/quiet", {"until": self.now + 1800})[0], 200)
        self.now += 600
        self.server._commitments_due()
        self.server._commitments_due()
        [due] = self.feed("announce")
        self.assertEqual((due["kind"], due["level"], due["headline"], due["origin"], due["speak"], due["silent"]),
                         ("reminder_due", "P0", "日程提醒：喝水", item["id"], False, True))
        self.assertEqual(self.server.speech.calls, [])
        [done] = self.server.commitments.list()
        self.assertEqual((done["state"], done["delivered_line"]), ("fulfilled", "silent_card"))
        self.assertEqual(self.changes(), [{"action": "fulfilled", "commitment": done}])
        self.assertEqual(self.request("PUT", "/observation/quiet", {"until": None}), (200, {"quiet_until": None}))
        self.server._commitments_due()
        self.assertEqual(len(self.feed("announce")), 1)

    def test_waiting_for_claude_is_said_when_a_claude_session_is_done(self):
        enable_plugins(self, "coding_sessions")  # the session ends through /hook
        item = self.server.commitments.add("看测试结果", None, trigger={"kind": "session_done", "agent": "claude"})
        self.server.feed.publish("commitment", {"action": "added", "commitment": item})
        self.request("POST", "/hook/codex", {"hook_event_name": "Stop", "session_id": "B"}, token=test_server.HOOK)
        self.request("POST", "/hook/claude", {"hook_event_name": "PreToolUse", "session_id": "A", "tool_name": "Read"},
                     token=test_server.HOOK)
        self.server._commitments_due()
        self.assertEqual(self.feed("announce"), [])
        self.request("POST", "/hook/claude", {"hook_event_name": "Stop", "session_id": "A"}, token=test_server.HOOK)
        self.server._commitments_due()
        self.assertEqual([(a["kind"], a["headline"]) for a in self.feed("announce")],
                         [("reminder_due", "日程提醒：看测试结果")])
        self.assertEqual(self.server.commitments.list()[0]["state"], "fulfilled")

    def test_an_approval_waiting_five_minutes_fires_its_reminder(self):
        self.server.commitments.add("去批准", None, trigger={"kind": "approval_waiting", "minutes": 5})
        self.server.broker.pending = lambda: [{"window_s": 600.0, "seconds_left": 301.0}]
        self.server._commitments_due()
        self.assertEqual(self.feed("announce"), [])
        self.server.broker.pending = lambda: [{"window_s": 55.0, "seconds_left": 50.0},
                                              {"window_s": 600.0, "seconds_left": 300.0}]
        self.server._commitments_due()
        self.assertEqual([(a["kind"], a["headline"]) for a in self.feed("announce")], [("reminder_due", "日程提醒：去批准")])

    def test_a_trigger_that_never_fires_is_missed_after_a_day(self):
        item = self.server.commitments.add("看结果", None, trigger={"kind": "session_done", "agent": "codex"})
        self.now += 86400
        self.server._commitments_due()
        [missed] = self.feed("announce")
        self.assertEqual((missed["kind"], missed["level"], missed["headline"], missed["origin"]),
                         ("reminder_missed", "P1", "未触发的提醒：看结果（等待 codex 做完 超过 24 小时）", item["id"]))
        self.assertEqual(self.changes(), [{"action": "missed", "commitment": self.server.commitments.list()[0]}])

    def test_daily_reminder_rearms_next_day(self):
        item = self.server.commitments.add("吃药", local(24, 8), repeat="daily")
        self.assertEqual((item["due_at"], item["repeat"]), (local(24, 8), "daily"))
        self.now = local(24, 8)
        self.server._commitments_due()
        self.assertEqual([a["kind"] for a in self.feed("announce")], ["reminder_due"])
        [again] = self.server.commitments.list()
        self.assertEqual((again["id"], again["state"], again["due_at"], again["revision"]),
                         (item["id"], "armed", local(25, 8), item["revision"] + 2))
        self.assertEqual(self.changes()[-1], {"action": "rescheduled", "commitment": again})

    def test_a_daily_reminder_shown_only_still_comes_again(self):
        for mode in ("muted", "no_speech"):
            with self.subTest(mode=mode):
                self.server.muted = mode == "muted"
                self.server.speech = None if mode == "no_speech" else test_server.FakeRelay()
                self.now = local(23, 10)
                item = self.server.commitments.add("吃药", local(24, 8), repeat="daily")
                self.now = local(24, 8)
                self.server._commitments_due()
                [again] = [c for c in self.server.commitments.list() if c["id"] == item["id"]]
                self.assertEqual((again["state"], again["due_at"]), ("armed", local(25, 8)))
                self.now = local(25, 8)
                self.server._commitments_due()
                self.assertEqual(len([a for a in self.feed("announce") if a["origin"] == item["id"]]), 2)

    def test_complete_and_snooze_on_a_delivered_daily_reminder_keep_its_time(self):
        item = self.server.commitments.add("吃药", local(24, 9), repeat="daily")
        self.now = local(24, 9)
        self.server._commitments_due()
        self.now = local(24, 9, 1)
        status, body = self.request("POST", f"/commitments/{item['id']}/complete")
        self.assertEqual((status, body["commitment"]["state"], body["commitment"]["due_at"]), (200, "armed", local(25, 9)))
        self.assertEqual(self.server.commitments.list()[0]["due_at"], local(25, 9))
        self.now = local(25, 9)
        self.server._commitments_due()
        status, body = self.request("POST", f"/commitments/{item['id']}/snooze", {"minutes": 10})
        self.assertEqual((status, body["commitment"]["due_at"]), (200, local(25, 9, 10)))
        self.now = local(25, 9, 10)
        self.server._commitments_due()
        [again] = self.server.commitments.list()
        self.assertEqual((again["state"], again["due_at"]), ("armed", local(26, 9)))
        self.assertEqual(len([a for a in self.feed("announce") if a["kind"] == "reminder_due"]), 3)

    def test_completing_a_daily_reminder_before_its_first_time_moves_it_to_the_next(self):
        self.now = local(23, 10)
        item = self.server.commitments.add("吃药", local(24, 9), repeat="daily")
        status, body = self.request("POST", f"/commitments/{item['id']}/complete")
        self.assertEqual((status, body["commitment"]["state"], body["commitment"]["due_at"]), (200, "armed", local(25, 9)))
        self.now = local(24, 9)
        self.server._commitments_due()
        self.assertEqual([a for a in self.feed("announce") if a["kind"] == "reminder_due"], [])

    def test_the_tick_says_a_due_reminder(self):
        server = self.start(tick_interval=0.01)
        server.commitments.add("喝水", self.now - 1)
        for _ in range(200):
            if self.feed("announce", server):
                break
            time.sleep(0.01)
        self.assertEqual([a["kind"] for a in self.feed("announce", server)], ["reminder_due"])

    def test_a_reminder_a_restart_missed_is_said_once(self):
        due_at = self.now - 700
        late = self.server.commitments.add("喝水", due_at)
        soon = self.server.commitments.add("开会", self.now + 600)
        self.server.recover_commitments()
        [missed] = self.feed("announce")
        self.assertEqual((missed["kind"], missed["level"], missed["headline"], missed["origin"]),
                         ("reminder_missed", "P1", f"未触发的提醒：喝水（原定时间：{time.strftime('%H:%M', time.localtime(due_at))}）",
                          late["id"]))
        self.assertEqual({c["id"]: c["state"] for c in self.server.commitments.list()},
                         {late["id"]: "missed", soon["id"]: "armed"})
        self.server.recover_commitments()
        self.assertEqual(len(self.feed("announce")), 1)

    def test_reminders_are_listed_by_due_time_and_state(self):
        self.server.commitments.add("站起来", self.now + 1800)
        self.server.commitments.add("喝水", self.now + 600)
        status, body = self.request("GET", "/commitments")
        self.assertEqual(status, 200)
        self.assertEqual([(c["text"], c["due_at"], c["state"]) for c in body["commitments"]],
                         [("喝水", self.now + 600, "armed"), ("站起来", self.now + 1800, "armed")])
        self.now += 600
        self.server._commitments_due()
        [water, stand] = self.request("GET", "/commitments")[1]["commitments"]
        self.assertEqual((water["state"], stand["state"]), ("fulfilled", "armed"))
        self.assertEqual(self.request("GET", "/commitments?state=armed"), (200, {"commitments": [stand]}))
        self.assertEqual(self.request("GET", "/commitments?state=armed&state=fulfilled"),
                         (200, {"commitments": [water, stand]}))
        self.assertEqual(self.request("GET", "/commitments?state=bogus"), (400, {"error": "invalid_state"}))
        self.assertEqual(self.request("GET", "/commitments?state=armed&state=bogus"),
                         (400, {"error": "invalid_state"}))
        self.assertEqual(self.request("GET", "/commitments", token=None)[0], 401)
        self.server.commitments = None
        self.assertEqual(self.request("GET", "/commitments"), (503, {"error": "no_commitments"}))

    def test_an_armed_reminder_is_cancelled(self):
        item = self.server.commitments.add("喝水", self.now + 600)
        status, body = self.request("POST", f"/commitments/{item['id']}/cancel")
        self.assertEqual((status, body["commitment"]["id"], body["commitment"]["state"]), (200, item["id"], "cancelled"))
        self.assertEqual(self.server.commitments.list(), [body["commitment"]])
        self.assertEqual(self.changes(), [{"action": "cancelled", "commitment": body["commitment"]}])
        self.assertEqual(self.request("POST", f"/commitments/{item['id']}/cancel"),
                         (409, {"error": "illegal_transition"}))
        self.assertEqual(self.request("POST", "/commitments/nope/cancel"), (404, {"error": "unknown_commitment"}))
        self.assertEqual(self.request("POST", "/commitments/nope/cancel", token=None)[0], 401)
        self.assertEqual(len(self.changes()), 1)
        self.server.commitments = None
        self.assertEqual(self.request("POST", f"/commitments/{item['id']}/cancel"), (503, {"error": "no_commitments"}))

    def test_a_cancelled_reminder_is_not_said_when_due(self):
        item = self.server.commitments.add("喝水", self.now + 600)
        self.assertEqual(self.request("POST", f"/commitments/{item['id']}/cancel")[0], 200)
        self.now += 601
        self.server._commitments_due()
        self.assertEqual([a["kind"] for a in self.feed("announce")], [])
        self.assertEqual([c["state"] for c in self.server.commitments.list()], ["cancelled"])


class SignalOfferServerTest(unittest.TestCase):
    """Exercise say and storage directly, without a listening HTTP transport."""
    feed = CommitmentServerTest.feed
    wait_for = CommitmentServerTest.wait_for

    def setUp(self):
        from unittest.mock import patch
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.now = local(23, 10)
        with patch.object(AgentdServer, 'server_bind'), patch.object(AgentdServer, 'server_activate'):
            self.server = AgentdServer(('127.0.0.1', 0), HOOK, UI, tick_interval=3600)
        self.server.character_agent = test_server.KernelLines(self.server)
        self.server.mouth = test_server.FakeMouth([])
        self.addCleanup(self.server.server_close)
        self.server.clock = lambda: self.now
        self.server.speech = test_server.FakeRelay()
        db = open_store(Path(self.tmp.name) / 'agentd.sqlite')
        self.addCleanup(db.close)
        self.server.commitments = Commitments(db, clock=lambda: self.now)

    def test_task_offer_creates_reminder_only_after_click_and_logs_acceptance(self):
        from character.gate import Gate
        from character.signals import Signals
        from character.thoughts import Thoughts
        from character.proactive_log import ProactiveLog
        from personal.worklog import WorkLog
        from personal.commitments import parse_reminder
        worklog = WorkLog(self.server.commitments.db, lambda: self.server.character, clock=lambda: self.now)
        worklog.upsert_task(dict(title='修渲染', goal='修好画面', goal_authority='user_said', status='active',
                                 status_authority='inferred', progress='找到问题', next_step='检查材质',
                                 blockers=[], requires=[], project='Endfield', first_at=self.now - 90000,
                                 last_at=self.now - 90000))
        self.server.proactive_log = ProactiveLog(worklog.db)
        gate = Gate(enabled=True)
        thoughts = Thoughts(gate, self.server._proactive_publish, None, clock=lambda: self.now)
        signals = Signals(gate, thoughts, self.server.registry, worklog=worklog,
                          presence=lambda: 'present', clock=lambda: self.now)
        signals.tick(self.now)
        self.now += 300
        signals.tick(self.now)
        [thought] = self.feed('thought')
        self.assertFalse(hasattr(signals, 'commitments'))
        self.assertEqual(self.server.commitments.list(), [])
        self.assertEqual(self.feed('announce'), [])
        status, body = self.server.say(thought['reply'], reply_to={'kind': 'thought', 'id': thought['id']})
        self.assertEqual(status, 202)
        self.wait_for(lambda: not self.server._live_lines)
        [log] = worklog.db.execute('SELECT outcome FROM proactive_log WHERE id = ?', (thought['id'],)).fetchall()
        self.assertEqual(log[0], 'accepted')

if __name__ == "__main__":
    unittest.main()
