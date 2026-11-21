"""Chat history in the server: every mouth line lands in history_turns; the mouth's window survives a restart."""
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from brain import characters  # noqa: E402
from personal.episodes import Episodes  # noqa: E402
from personal.history import History  # noqa: E402
from personal.memory import Memory  # noqa: E402
from daemon.agentd_server import AgentdServer  # noqa: E402
from infra.store import open_store  # noqa: E402
import test_server  # noqa: E402
from test_server import ScriptedMouth  # noqa: E402
from test_server import EVENTS, HOOK, UI  # noqa: E402
import test_speech  # noqa: E402
from test_turn import relay_for, wait_for  # noqa: E402
from traces.trace_store import TraceStore  # noqa: E402
from support import add_episode, serve_in_thread  # noqa: E402

REPLY = ["[intent:greet]你来了", "，管理员。"]
SHOWN = "你来了，管理员。"
NAMES = {cid: characters.load_card(cid)["name"] for cid in characters.ids()}


class HistoryServerCase(test_server.FeedServerCase):
    request, lines_until_final = test_server.SayTest.request, test_server.SayTest.lines_until_final

    def setUp(self):
        super().setUp()
        self.data = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.addCleanup(self.data.cleanup)
        self.db = Path(self.data.name) / "agentd.sqlite"
        self.server.history = History(open_store(self.db))
        self.server.events_token = EVENTS
        self.fake = test_server.Script(REPLY)
        self.server.mouth = ScriptedMouth(self.fake, character="aster")

    def line(self, text, source="text"):
        conn, response = self.open_feed()
        status, body = self.request("POST", "/say", {"text": text, "source": source})
        self.assertEqual(status, 202)
        events = self.lines_until_final(response)
        conn.close()
        return body, events

    def past(self, index=-1):
        """The window the index-th stream was sent, then its text."""
        return self.fake.past(index)

    def rows(self):
        return History(open_store(self.db)).export()


class RestartTest(HistoryServerCase):
    def test_window_survives_a_restart(self):
        self.line("第一句")
        self.line("第二句")
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)
        # As main() does: a fresh History on the same file loads the new mouth's window.
        self.server = AgentdServer(("127.0.0.1", 0), HOOK, UI)
        self.server.character = "aster"  # main() restarts with the --character Companion passes
        self.server.character_agent = test_server.KernelLines(self.server)
        self.thread = serve_in_thread(self.server)
        self.server.history = History(open_store(self.db))
        mouth = ScriptedMouth(self.fake, character="aster")
        mouth.history = self.server.history.window("aster", mouth.max_turns, NAMES)
        self.server.mouth = mouth
        self.line("第三句")
        # The reloaded window is what the live one was: replies with their markers.
        self.assertEqual(self.past(), ["第一句", "".join(REPLY), "第二句", "".join(REPLY), "第三句"])


class CharacterSwitchTest(HistoryServerCase):
    def test_switch_keeps_the_window_and_labels_the_old_speaker_on_reload(self):
        self.server.mouth_factory = lambda cid: ScriptedMouth(self.fake, character=cid)
        self.line("第一句")
        self.assertEqual(self.request("POST", "/character", {"id": "birch"})[0], 200)
        self.line("第二句")
        self.assertEqual(self.past()[:2], ["第一句", "".join(REPLY)])  # the live window keeps the raw reply
        rows = self.rows()
        self.assertEqual([(r["character_id"], r["persona_revision"]) for r in rows],
                         [("aster", characters.revision("aster")), ("birch", characters.revision("birch"))])
        window = History(open_store(self.db)).window("birch", 8, NAMES)
        self.assertEqual(window[0][1]["content"], f"(said by 示例甲) {''.join(REPLY)}")
        self.assertEqual(window[1][1]["content"], "".join(REPLY))
        self.assertEqual(rows[0]["reply"], SHOWN)


class StateTest(HistoryServerCase):
    def test_cancelled_line_is_recorded_and_stays_out_of_the_window(self):
        self.fake.chunks, self.fake.delay = ["[intent:explain]一"] + ["二"] * 50, 0.05
        conn, response = self.open_feed()
        line_id = self.request("POST", "/say", {"text": "长句"})[1]["line_id"]
        self.assertEqual(self.next_event(response)["event"], "turn_accepted")
        self.next_event(response)
        self.assertEqual(self.request("POST", "/turn/cancel", {"reason": "client_cancel"})[0], 202)
        events = self.lines_until_final(response)
        conn.close()
        self.assertTrue(events[-1]["cancelled"])
        [row] = self.rows()
        self.assertEqual((row["turn_id"], row["state"], row["user_text"]), (line_id, "cancelled", "长句"))
        self.assertTrue(row["reply"].startswith("一"))
        self.fake.chunks, self.fake.delay = REPLY, 0.0
        self.line("下一句")
        self.assertEqual(self.past(), ["下一句"])

    def test_failed_line_is_recorded_failed(self):
        self.fake.stop_reason = "max_tokens"
        _, events = self.line("出错")
        self.assertEqual(events[-1]["error"], "RuntimeError")
        [row] = self.rows()
        self.assertEqual((row["state"], row["reply"]), ("failed", SHOWN))

    def test_line_cancelled_before_the_model_is_recorded_empty(self):
        cancel = threading.Event()
        cancel.set()
        self.server._run_line("l1", "看一下", cancel, self.server.turn_generation)
        [row] = self.rows()
        self.assertEqual((row["turn_id"], row["state"], row["reply"]), ("l1", "cancelled", ""))
        self.assertEqual(self.fake.calls, [])

    def test_completed_line_row(self):
        body, _ = self.line("你好")
        [row] = self.rows()
        self.assertEqual({k: row[k] for k in ("turn_id", "source", "character_id", "user_text", "reply", "state")},
                         {"turn_id": body["line_id"], "source": "text", "character_id": "aster",
                          "user_text": "你好", "reply": SHOWN, "state": "completed"})
        self.assertLessEqual(row["started_at"], row["ended_at"])

    def test_line_events_say_whether_history_keeps_the_row(self):
        _, events = self.line("你好")
        self.assertEqual({e.get("remembered") for e in events}, {True})
        conn, response = self.open_feed()
        self.assertEqual(self.request("POST", "/say", {"text": "这句别记", "no_memory": True})[0], 202)
        events = self.lines_until_final(response)
        conn.close()
        self.assertEqual({e.get("remembered") for e in events}, {False})
        self.assertEqual(len(self.rows()), 1)

    def test_interrupt_while_the_model_still_generates_keeps_the_heard_part(self):
        tts, relay = relay_for(self, segments=2)
        self.server.speech = relay
        self.fake.chunks, self.fake.delay = ["[intent:greet]你来了，管理员。", "今天测试都过了。"], 1.0
        conn, response = self.open_feed()
        self.assertEqual(self.request("POST", "/say", {"text": "你好"})[0], 202)
        test_speech.SpeechRelayTest.collect(self, relay, 1)
        speech_id = tts.bodies[0][1]["speech_id"]
        body = {"speech_id": speech_id, "clause_id": None, "state": "started", "sample": 0, "rate": 48000}
        self.assertEqual(self.request("POST", "/speech/playback", body)[0], 200)
        self.assertEqual(self.request("POST", "/speech/playback", {**body, "state": "interrupted", "sample": 44800,
                                                                   "reason": "barge_in"}),
                         (200, {"applied": True, "why": None}))
        self.assertTrue(self.server._live_lines)  # the receipt came before the row was written
        self.lines_until_final(response)
        conn.close()
        self.assertTrue(wait_for(lambda: not self.server._live_lines))
        [row] = self.rows()
        self.assertEqual((row["state"], row["reply"]), ("interrupted", "你来了，"))
        self.fake.chunks, self.fake.delay = REPLY, 0.0
        self.line("下一句")
        self.assertEqual(self.past(), ["你好", "你来了，", "下一句"])

    def test_store_error_does_not_end_the_line(self):
        self.server.history.db.close()
        _, events = self.line("你好")
        self.assertEqual((events[-1]["final"], events[-1]["error"]), (True, None))


class ClearTest(HistoryServerCase):
    def test_delete_clears_store_and_window(self):
        self.line("第一句")
        self.line("第二句")
        self.assertEqual(self.request("DELETE", "/history"), (200, {"deleted": 2}))
        self.assertEqual(self.rows(), [])
        self.assertEqual(self.server.mouth.history, [])
        self.line("再来")
        self.assertEqual(self.past(), ["再来"])

    def clear_mid_line(self, path, keys):
        """path is deleted while a line streams; that line must leave no row, window turn or trace behind."""
        self.server.memory = Memory(open_store(self.db))
        self.server.trace = TraceStore(open_store(self.db), producer_epoch=self.server.registry.epoch)
        self.line("第一句")
        self.fake.chunks, self.fake.delay = ["[intent:explain]一"] + ["二"] * 10, 0.05
        conn, response = self.open_feed()
        self.assertEqual(self.request("POST", "/say", {"text": "长句"})[0], 202)
        self.assertEqual(self.next_event(response)["event"], "turn_accepted")
        self.next_event(response)
        status, body = self.request("DELETE", path)
        self.assertEqual((status, set(body)), (200, keys))  # the cancelled row may land before the clear or not at all
        self.lines_until_final(response)
        conn.close()
        self.assertTrue(wait_for(lambda: not self.server._live_lines))
        self.assertEqual(self.rows(), [])
        self.assertEqual(self.server.mouth.history, [])
        self.assertEqual(dict(self.server._line_entries), {})
        self.assertEqual(open_store(self.db).execute("SELECT COUNT(*) FROM trace_events").fetchone()[0], 0)

    def test_delete_mid_line_keeps_that_line_out(self):
        self.clear_mid_line("/history", {"deleted"})

    def test_clearing_history_from_memory_mid_line_keeps_that_line_out(self):
        self.clear_mid_line("/memory?scope=history", {"facts_deleted", "history_deleted"})

    def test_a_line_that_outlives_the_cancel_still_stores_nothing(self):
        self.server.cancel_turn = lambda reason: None  # the line finishes after the clear
        self.clear_mid_line("/memory?scope=all", {"facts_deleted", "history_deleted"})

    def test_delete_without_a_mouth(self):
        self.server.mouth = None
        self.assertEqual(self.request("DELETE", "/history"), (200, {"deleted": 0}))

    def test_delete_needs_the_ui_token(self):
        self.assertEqual(self.request("DELETE", "/history", token=EVENTS)[0], 401)
        self.assertEqual(self.request("DELETE", "/nothing")[0], 404)


class PageTest(HistoryServerCase):
    def setUp(self):
        super().setUp()
        for i in range(3):
            self.server.history.record(turn_id=f"l{i}", source="text", character_id="aster",
                                       persona_revision="r", user_text=f"问{i}", reply=f"答{i}",
                                       state="completed", started_at=time.time())

    def test_pages_newest_first(self):
        status, body = self.request("GET", "/history?limit=2")
        self.assertEqual(status, 200)
        self.assertEqual([t["user_text"] for t in body["turns"]], ["问2", "问1"])
        self.assertEqual(set(body["turns"][0]), {"id", "event_id", "turn_id", "source", "character_id",
                                                 "persona_revision", "user_text", "reply", "state",
                                                 "started_at", "ended_at", "raw_reply",
                                                 "conversation_id"})
        status, body = self.request("GET", f"/history?before={body['next']}&limit=2")
        self.assertEqual((status, [t["user_text"] for t in body["turns"]], body["next"]), (200, ["问0"], None))
        status, body = self.request("GET", "/history?before=")
        self.assertEqual((status, len(body["turns"]), body["next"]), (200, 3, None))

    def test_bad_cursor_is_400(self):
        for query in ("limit=0", "limit=201", "limit=x", "before=x"):
            self.assertEqual(self.request("GET", f"/history?{query}"), (400, {"error": "invalid_cursor"}))

    def test_export_is_oldest_first(self):
        status, body = self.request("GET", "/history/export")
        self.assertEqual((status, [t["user_text"] for t in body["turns"]]), (200, ["问0", "问1", "问2"]))

    def test_events_token_is_refused(self):
        for path in ("/history", "/history/export"):
            self.assertEqual(self.request("GET", path, token=EVENTS)[0], 401)

    def test_no_history_is_503(self):
        self.server.history = None
        for method, path in (("GET", "/history"), ("GET", "/history/export"), ("DELETE", "/history")):
            self.assertEqual(self.request(method, path), (503, {"error": "no_history", "detail": "聊天记录没有开启"}))


class RecallTest(HistoryServerCase):
    def recalled(self, body):
        """What the mouth's pick_history got for one /say, with one matching turn older than a full window."""
        picked = []

        class RecallMouth(test_server.FakeMouth):
            def pick_history(self, entries):
                picked.append(entries)

        self.server.mouth = RecallMouth(REPLY)
        for turn_id, user_text in (("old", "帮我部署一下服务"), *((f"f{i}", f"闲聊{i}") for i in range(8))):
            self.server.history.record(turn_id=turn_id, source="text", character_id="aster", persona_revision="abc",
                                       user_text=user_text, reply="好", state="completed", started_at=100.0)
        conn, response = self.open_feed()
        self.assertEqual(self.request("POST", "/say", body)[0], 202)
        self.lines_until_final(response)
        conn.close()
        return picked

    def test_the_matching_old_turn_reaches_the_mouth(self):
        [entries] = self.recalled({"text": "再部署一次"})
        self.assertEqual([(e["turn_id"], e["user_text"]) for e in entries], [("old", "帮我部署一下服务")])

    def test_a_no_memory_turn_recalls_nothing(self):
        self.assertEqual(self.recalled({"text": "再部署一次", "no_memory": True}), [])


class EpisodeRecallTest(HistoryServerCase):
    def setUp(self):
        super().setUp()
        picked = self.picked = []

        class RecallMouth(test_server.FakeMouth):
            def pick_episodes(self, label, episodes, overview=None):
                picked.append((label, episodes, overview))

        self.server.mouth = RecallMouth(REPLY)
        self.server.episodes = Episodes(open_store(self.db))
        self.server.share_page_text = True
        self.now = time.time()
        self.server.clock = lambda: self.now
        add_episode(self.server.episodes, self.now - 900, self.now - 300, "修登录bug", "你在排查登录接口。")

    def say(self, body):
        conn, response = self.open_feed()
        self.assertEqual(self.request("POST", "/say", body)[0], 202)
        self.lines_until_final(response)
        conn.close()

    def test_the_episodes_of_the_time_asked_about_reach_the_mouth(self):
        self.say({"text": "刚才在干嘛"})
        [(label, episodes, overview)] = self.picked
        self.assertEqual((label, [e["title"] for e in episodes]), ("刚才半小时", ["修登录bug"]))
        self.assertTrue(overview.endswith(" 修登录bug"), overview)

    def test_without_page_text_or_with_no_memory_nothing_is_recalled(self):
        self.say({"text": "刚才在干嘛", "no_memory": True})
        self.server.share_page_text = False
        self.say({"text": "刚才在干嘛"})
        self.assertEqual(self.picked, [])

    def test_a_proactive_or_ritual_line_recalls_nothing(self):
        trace = {"remember": True, "reset": self.server.reset_generation, "turn_id": "p1"}
        for source in ("proactive", "ritual"):
            self.server._use_facts(trace, threading.Event(), self.server.mouth, "刚才", source=source)
        self.assertEqual(self.picked, [])
        self.server._use_facts(trace, threading.Event(), self.server.mouth, "刚才", source="text")
        self.assertEqual([label for label, *_ in self.picked], ["刚才半小时"])


class SourceTest(HistoryServerCase):
    def test_voice_say_is_recorded_voice(self):
        self.line("你好", source="voice")
        self.assertEqual([r["source"] for r in self.rows()], ["voice"])

    def test_proactive_line_is_recorded_proactive(self):
        self.server.mouth = test_server.FakeMouth(REPLY)
        conn, response = self.open_feed()
        self.server.start_line("p1", "主动")
        self.lines_until_final(response)
        conn.close()
        self.assertEqual([(r["turn_id"], r["source"]) for r in self.rows()], [("p1", "proactive")])


if __name__ == "__main__":
    unittest.main()
