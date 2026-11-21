"""Playback receipts in the server: POST /speech/playback, and an interrupted line keeps only what was heard."""
from pathlib import Path
import sys
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from observation.attention import AttentionStore  # noqa: E402
from observation.blacklist import Blacklist  # noqa: E402
from support import deny_blacklist  # noqa: E402
from personal.memory import Memory  # noqa: E402
from infra.store import open_store  # noqa: E402
from test_history_server import REPLY, SHOWN, HistoryServerCase  # noqa: E402
from test_server import EVENTS, KernelLines, ScriptedMouth  # noqa: E402
import test_speech  # noqa: E402
from test_turn import relay_for, wait_for  # noqa: E402

HALF = 44800  # FakeTTS sends two segments of 44800 samples


class PlaybackCase(HistoryServerCase):
    collect = test_speech.SpeechRelayTest.collect

    def setUp(self):
        super().setUp()
        self.tts, self.relay = relay_for(self, segments=2)
        self.relay.on_event = self.server.on_speech_event
        self.server.speech = self.relay
        self.server.speech_readers = 1  # a renderer reads the speech stream and sends the receipts below

    def receipt(self, speech_id, state, sample=0, token=None, **extra):
        body = {"speech_id": speech_id, "clause_id": None, "state": state, "sample": sample, "rate": 48000, **extra}
        return self.request("POST", "/speech/playback", body, **({"token": token} if token else {}))

    def spoken_line(self, text="你好"):
        """A line said, sent to TTS and fully synthesized; its speech_id."""
        self.line(text)
        self.assertTrue(wait_for(lambda: not self.server._live_lines))
        self.collect(self.relay, 1)
        return self.server._speaking


class EndpointTest(PlaybackCase):
    def test_valid_receipt_applies(self):
        speech_id = self.relay.speak("announce-1", "播报")
        self.collect(self.relay, 1)
        self.assertEqual(self.receipt(speech_id, "started", utterance_id="u1", spoken_text_revision=3),
                         (200, {"applied": True, "why": None}))
        self.assertEqual(self.receipt("nope", "started"), (200, {"applied": False, "why": "unknown_speech"}))

    def test_bad_bodies_are_400(self):
        speech_id = self.relay.speak("announce-1", "播报")
        for state, sample, extra in (("failed", 0, {}), ("started", -1, {}), ("started", 0, {"rate": 0}),
                                     ("paused", 0, {}), ("degraded", 0, {"reason": ""})):
            with self.subTest(state=state, sample=sample, extra=extra):
                self.assertEqual(self.receipt(speech_id, state, sample, **extra),
                                 (400, {"error": "invalid_payload"}))
        self.assertEqual(self.receipt("", "started")[0], 400)
        self.assertEqual(self.receipt("x" * 65, "started")[0], 400)

    def test_events_token_is_refused_and_no_tts_is_503(self):
        self.assertEqual(self.receipt("s", "started", token=EVENTS)[0], 401)
        self.server.speech = None
        self.assertEqual(self.receipt("s", "started"), (503, {"error": "no_speech"}))


class InterruptedLineTest(PlaybackCase):
    def test_user_interrupt_keeps_the_heard_half(self):
        speech_id = self.spoken_line()
        self.receipt(speech_id, "started")
        self.assertEqual(self.receipt(speech_id, "interrupted", HALF, reason="barge_in"),
                         (200, {"applied": True, "why": None}))
        [row] = self.rows()
        self.assertEqual((row["state"], row["reply"], row["raw_reply"]), ("interrupted", SHOWN[:4], SHOWN[:4]))
        self.line("下一句")
        self.assertEqual(self.past(), ["你好", SHOWN[:4], "下一句"])

    def test_push_to_talk_cancel_first_still_keeps_the_heard_half(self):
        # The host cancels the turn before the renderer reports the cut, so the receipt arrives one generation late.
        speech_id = self.spoken_line()
        self.receipt(speech_id, "started")
        self.assertEqual(self.request("POST", "/turn/cancel", {"reason": "barge_in"})[0], 202)
        self.assertEqual(self.receipt(speech_id, "interrupted", HALF, reason="barge_in"),
                         (200, {"applied": True, "why": None}))
        [row] = self.rows()
        self.assertEqual((row["state"], row["reply"]), ("interrupted", SHOWN[:4]))

    def test_ended_line_stays_completed_and_whole(self):
        speech_id = self.spoken_line()
        self.receipt(speech_id, "started")
        self.assertEqual(self.receipt(speech_id, "ended", 2 * HALF)[1]["applied"], True)
        [row] = self.rows()
        self.assertEqual((row["state"], row["reply"]), ("completed", SHOWN))
        self.line("下一句")
        self.assertEqual(self.past(), ["你好", "".join(REPLY), "下一句"])

    def test_connection_lost_leaves_the_history(self):
        speech_id = self.spoken_line()
        self.receipt(speech_id, "started")
        self.assertEqual(self.receipt(speech_id, "interrupted", HALF, reason="connection_lost")[1]["applied"], True)
        [row] = self.rows()
        self.assertEqual((row["state"], row["reply"]), ("completed", SHOWN))

    def test_interrupted_announcement_leaves_the_history(self):
        self.server.history.record(turn_id="announce-7", source="announce", character_id="aster",
                                   persona_revision="r", user_text="", reply="播报全文", state="completed",
                                   started_at=time.time())
        speech_id = self.relay.speak("announce-7", "播报全文")
        self.collect(self.relay, 1)
        self.receipt(speech_id, "started")
        self.assertEqual(self.receipt(speech_id, "interrupted", HALF, reason="barge_in")[1]["applied"], True)
        [row] = self.rows()
        self.assertEqual((row["state"], row["reply"]), ("completed", "播报全文"))

    def test_interrupt_on_the_second_clause_keeps_the_first_and_the_heard_part(self):
        self.fake.chunks = ["[intent:greet]你来了，管理员。", "今天测试都过了。"]
        self.line("你好")
        self.assertTrue(wait_for(lambda: not self.server._live_lines))
        self.collect(self.relay, 2)
        self.assertEqual([b["text"] for _, b in self.tts.bodies], ["你来了，管理员。", "今天测试都过了。"])
        first, second = (b["speech_id"] for _, b in self.tts.bodies)
        self.receipt(first, "started")
        self.receipt(first, "ended", 2 * HALF)
        self.receipt(second, "started")
        self.assertEqual(self.receipt(second, "interrupted", HALF, reason="barge_in"),
                         (200, {"applied": True, "why": None}))
        [row] = self.rows()
        self.assertEqual((row["state"], row["reply"]), ("interrupted", "你来了，管理员。今天测试"))

    def two_clauses(self):
        """A two-clause line said and fully synthesized; the clauses' speech_ids."""
        self.fake.chunks = ["第一句话说完了，", "第二句话也说完了。"]
        self.line("你好")
        self.assertTrue(wait_for(lambda: not self.server._live_lines))
        self.collect(self.relay, 2)
        self.assertEqual([b["text"] for _, b in self.tts.bodies], ["第一句话说完了，", "第二句话也说完了。"])
        return [b["speech_id"] for _, b in self.tts.bodies]

    def test_interrupt_between_clauses_keeps_only_the_first(self):
        first, _ = self.two_clauses()
        self.receipt(first, "started")
        self.receipt(first, "ended", 2 * HALF)
        self.assertEqual(self.request("POST", "/turn/cancel", {"reason": "barge_in"})[0], 202)
        [row] = self.rows()
        self.assertEqual((row["state"], row["reply"]), ("interrupted", "第一句话说完了，"))
        self.assertEqual(self.server.mouth.history[-1][1]["content"], "第一句话说完了，")

    def test_interrupt_before_the_first_clause_plays_keeps_nothing(self):
        self.two_clauses()
        self.assertEqual(self.request("POST", "/turn/cancel", {"reason": "barge_in"})[0], 202)
        [row] = self.rows()
        self.assertEqual((row["state"], row["reply"]), ("cancelled", "第一句话说完了，第二句话也说完了。"))
        self.line("下一句")
        self.assertEqual(self.past(), ["下一句"])  # the API refuses an empty assistant turn before the last one

    def test_without_a_unity_reading_speech_a_cut_line_keeps_its_words(self):
        self.server.speech_readers = 0
        self.two_clauses()
        self.assertEqual(self.request("POST", "/turn/cancel", {"reason": "barge_in"})[0], 202)
        [row] = self.rows()
        self.assertEqual((row["state"], row["reply"]), ("completed", "第一句话说完了，第二句话也说完了。"))

    def test_a_proactive_line_cut_by_new_input_keeps_the_clause_that_played_to_its_end(self):
        self.fake.chunks = ["第一句话说完了，", "第二句话也说完了。"]
        self.server.character_agent = KernelLines(self.server)  # a proactive line runs on the character agent
        self.server.start_line("p1", "（主动搭话）")
        self.assertTrue(wait_for(lambda: not self.server._live_lines))
        self.collect(self.relay, 2)
        first, _ = (b["speech_id"] for _, b in self.tts.bodies)
        self.receipt(first, "started")
        self.line("你好")  # clause_end: the first clause plays on, the second is dropped
        self.receipt(first, "ended", 2 * HALF)
        [row] = [r for r in self.rows() if r["turn_id"] == "p1"]
        self.assertEqual((row["state"], row["reply"]), ("interrupted", "第一句话说完了，"))

    def test_interrupt_of_an_earlier_line_reaches_the_mouth_window_after_a_later_request(self):
        speech_id = self.spoken_line()
        self.receipt(speech_id, "started")
        self.line("下一句")  # the mouth builds its window again for this request
        self.assertEqual(self.receipt(speech_id, "interrupted", HALF, reason="barge_in")[1]["applied"], True)
        self.assertEqual([turn[1]["content"] for turn in self.server.mouth.history], [SHOWN[:4], "".join(REPLY)])

    def test_a_heard_part_reported_after_the_line_settled_empty_is_kept(self):
        speech_id = self.spoken_line()  # no receipt yet, though the renderer has started it
        self.assertEqual(self.request("POST", "/turn/cancel", {"reason": "barge_in"})[0], 202)
        [row] = self.rows()
        self.assertEqual((row["state"], self.server.mouth.history), ("cancelled", []))
        self.assertEqual(self.receipt(speech_id, "interrupted", HALF, reason="barge_in")[1]["applied"], True)
        [row] = self.rows()
        self.assertEqual((row["state"], row["reply"]), ("interrupted", SHOWN[:4]))
        self.assertEqual([[m["content"] for m in turn] for turn in self.server.mouth.history], [["你好", SHOWN[:4]]])

    def test_a_longer_heard_part_settled_again_replaces_the_shorter_one(self):
        speech_id = self.spoken_line()
        self.receipt(speech_id, "started")
        self.receipt(speech_id, "interrupted", HALF, reason="barge_in")
        [row] = self.rows()
        self.assertEqual((row["state"], row["reply"]), ("interrupted", SHOWN[:4]))
        self.server._settle(row["turn_id"], SHOWN[:6])
        [row] = self.rows()
        self.assertEqual((row["state"], row["reply"], self.server.mouth.history[-1][1]["content"]),
                         ("interrupted", SHOWN[:6], SHOWN[:6]))


class CutWhileStreamingTest(PlaybackCase):
    """A line the user cuts while the model still writes it keeps what was heard, as one cut after it does."""
    FIRST = "第一句话说完了。"

    def streaming(self):
        """(line_id, speech_id of its first clause): that clause is synthesized while the model still writes."""
        self.fake.chunks, self.fake.delay = [self.FIRST] + ["二"] * 20, 0.1
        status, body = self.request("POST", "/say", {"text": "你好"})
        self.assertEqual(status, 202)
        self.collect(self.relay, 1)
        return body["line_id"], self.tts.bodies[0][1]["speech_id"]

    def cut(self, reason="barge_in"):
        self.assertTrue(self.server._live_lines)  # still streaming
        if reason == "memory_changed":
            self.server.cancel_turn(reason)
        else:
            self.assertEqual(self.request("POST", "/turn/cancel", {"reason": reason})[0], 202)
        self.assertTrue(wait_for(lambda: not self.server._live_lines))
        self.fake.chunks, self.fake.delay = REPLY, 0.0

    def assert_kept(self):
        [row] = self.rows()
        self.assertEqual((row["state"], row["reply"], row["raw_reply"]), ("interrupted", self.FIRST, self.FIRST))
        self.line("下一句")
        self.assertEqual(self.past(), ["你好", self.FIRST, "下一句"])

    def assert_left_out(self):
        [row] = self.rows()
        self.assertEqual(row["state"], "cancelled")
        self.line("下一句")
        self.assertEqual(self.past(), ["下一句"])

    def test_a_cut_after_the_first_clause_ended_keeps_it(self):
        _, first = self.streaming()
        self.receipt(first, "started")
        self.receipt(first, "ended", 2 * HALF)
        self.cut()
        self.assert_kept()

    def test_an_end_receipt_after_the_line_settled_keeps_the_clause(self):
        _, first = self.streaming()
        self.receipt(first, "started")
        self.cut()
        self.assertEqual(self.receipt(first, "ended", 2 * HALF)[1]["applied"], True)
        self.assert_kept()

    def test_a_cut_before_anything_played_keeps_nothing(self):
        self.streaming()
        self.cut()
        self.assert_left_out()

    def test_a_line_cut_by_a_changed_fact_stays_out_after_its_receipt(self):
        _, first = self.streaming()
        self.receipt(first, "started")
        self.cut("memory_changed")
        self.assertEqual(self.receipt(first, "ended", 2 * HALF)[1]["applied"], True)
        self.assert_left_out()

    def test_a_cut_line_taken_back_before_its_receipt_stays_out(self):
        line_id, first = self.streaming()
        self.receipt(first, "started")
        self.cut()
        self.server._memories_changed({"f1"}, said=[line_id])
        self.assertEqual(self.receipt(first, "ended", 2 * HALF)[1]["applied"], True)
        self.assert_left_out()

    def test_a_late_kept_turn_goes_before_the_turn_after_it(self):
        _, first = self.streaming()
        self.receipt(first, "started")
        self.cut()
        self.line("下一句")
        self.assertEqual(self.receipt(first, "ended", 2 * HALF)[1]["applied"], True)
        self.assertEqual([[m["content"] for m in turn] for turn in self.server.mouth.history],
                         [["你好", self.FIRST], ["下一句", "".join(REPLY)]])

    def test_a_cut_line_keeps_the_turn_before_it(self):
        speech_id = self.spoken_line("第一轮")
        self.receipt(speech_id, "started")
        self.receipt(speech_id, "ended", 2 * HALF)  # played out, so the next line cuts nothing of it
        self.fake.chunks, self.fake.delay = [self.FIRST] + ["二"] * 20, 0.1
        self.assertEqual(self.request("POST", "/say", {"text": "你好"})[0], 202)
        self.collect(self.relay, 2)
        self.cut()
        self.assertEqual([turn[0]["content"] for turn in self.server.mouth.history], ["第一轮"])

    def test_an_end_receipt_before_the_cut_line_waits_for_its_receipts_keeps_the_clause(self):
        line_id, first = self.streaming()
        self.receipt(first, "started")
        record = self.server._record

        def record_then_end(trace, *args, **kwargs):
            record(trace, *args, **kwargs)
            if trace["turn_id"] == line_id:  # what was heard is reckoned by now, and the line not yet held for it
                self.assertEqual(self.receipt(first, "ended", 2 * HALF)[1]["applied"], True)

        self.server._record = record_then_end
        self.cut()
        self.assert_kept()

    def test_a_receipt_as_the_next_line_lets_go_of_the_mouth_keeps_the_cut_line(self):
        _, first = self.streaming()
        self.receipt(first, "started")
        self.cut()
        apply, sent = self.server._apply_window_ops, []

        def apply_then_receipt():
            apply()
            # The next line's last apply: its turn is in, and it still holds the mouth.
            if not sent and any(turn[0]["content"] == "下一句" for turn in self.server.mouth.history):
                sent.append(self.receipt(first, "ended", 2 * HALF))

        self.server._apply_window_ops = apply_then_receipt
        self.line("下一句")
        self.assertTrue(wait_for(lambda: not self.server._live_lines))
        self.assertEqual(sent[0][1]["applied"], True)
        self.assertEqual([[m["content"] for m in turn] for turn in self.server.mouth.history],
                         [["你好", self.FIRST], ["下一句", "".join(REPLY)]])


class CutLineFactTest(PlaybackCase):
    """A cut line kept as heard leaves with a fact its heard part said, once a newer line used other facts."""
    CAT, FIRST = "我养了一只猫，记得吗", "你养了一只猫啊。"
    cut = CutWhileStreamingTest.cut

    def setUp(self):
        super().setUp()
        self.server.memory = Memory(open_store(self.db))
        self.server.mouth = ScriptedMouth(self.fake, memory=self.server.memory)
        self.fact_id = self.server.memory.add("我养了一只猫", "asserted_by_user")

    def streaming(self):
        """(line_id, speech_id of its first clause), that clause saying the fact."""
        self.fake.chunks, self.fake.delay = [self.FIRST] + ["二"] * 20, 0.1
        status, body = self.request("POST", "/say", {"text": self.CAT})
        self.assertEqual(status, 202)
        self.collect(self.relay, 1)
        return body["line_id"], self.tts.bodies[0][1]["speech_id"]

    def assert_taken_back(self, line_id):
        [row] = [r for r in self.rows() if r["turn_id"] == line_id]
        self.assertEqual((row["state"], row["reply"]), ("interrupted", self.FIRST))
        self.line("再说一句")
        self.assertTrue(wait_for(lambda: not self.server._live_lines))
        self.assertEqual(self.request("DELETE", f"/memory/facts/{self.fact_id}?expected_version=1"), (200, {"deleted": True}))
        [row] = [r for r in self.rows() if r["turn_id"] == line_id]
        self.assertEqual(row["state"], "cancelled")
        self.assertEqual([turn[0]["content"] for turn in self.server.mouth.history], ["再说一句"])

    def test_a_line_cut_after_its_first_clause_ended_leaves_with_the_fact(self):
        line_id, first = self.streaming()
        self.receipt(first, "started")
        self.receipt(first, "ended", 2 * HALF)
        self.cut()
        self.assert_taken_back(line_id)

    def test_a_line_kept_by_a_late_end_receipt_leaves_with_the_fact(self):
        line_id, first = self.streaming()
        self.receipt(first, "started")
        self.cut()
        self.assertEqual(self.receipt(first, "ended", 2 * HALF)[1]["applied"], True)
        self.assert_taken_back(line_id)

    def played(self, text, chunks):
        """A line said with chunks, each of its clauses played to its end, so a later line cuts nothing of it; its
        line_id."""
        self.fake.chunks, self.fake.delay = chunks, 0.0
        line_id = self.line(text)[0]["line_id"]
        self.assertTrue(wait_for(lambda: not self.server._live_lines and self.server._voiced is not None
                                 and self.server._voiced[0] == line_id))
        utterance = self.server._voiced[1]
        self.assertTrue(wait_for(lambda: all(c["state"] is not None for c in self.relay.utterance(utterance))))
        for clause in self.relay.utterance(utterance):
            self.receipt(clause["speech_id"], "started")
            self.receipt(clause["speech_id"], "ended", 2 * HALF)
        return line_id

    def users(self):
        return [turn[0]["content"] for turn in self.server.mouth.history]

    def test_a_kept_line_goes_after_the_turn_before_it_that_stays(self):
        self.played("第一轮", REPLY)
        self.played(self.CAT, [self.FIRST])  # says the fact
        self.fake.chunks, self.fake.delay = [CutWhileStreamingTest.FIRST] + ["二"] * 20, 0.1
        self.assertEqual(self.request("POST", "/say", {"text": "你好"})[0], 202)
        self.collect(self.relay, 3)
        first = self.tts.bodies[2][1]["speech_id"]
        self.receipt(first, "started")
        self.cut()
        self.played("下一句", REPLY)
        self.assertEqual(self.request("DELETE", f"/memory/facts/{self.fact_id}?expected_version=1"), (200, {"deleted": True}))
        self.assertEqual(self.users(), ["第一轮", "下一句"])
        self.assertEqual(self.receipt(first, "ended", 2 * HALF)[1]["applied"], True)
        self.assertEqual(self.users(), ["第一轮", "你好", "下一句"])

    def test_an_empty_receipt_during_the_takeback_does_not_bring_the_line_back(self):
        line_id = self.played(self.CAT, [self.FIRST])
        retract, settled = self.server.history.retract, []

        def settle_then_retract(turn_id, blank=False):
            if turn_id == line_id and not settled:
                settled.append(turn_id)
                self.server._settle(line_id, "")
            return retract(turn_id, blank)

        self.server.history.retract = settle_then_retract
        self.assertEqual(self.request("DELETE", f"/memory/facts/{self.fact_id}?expected_version=1"), (200, {"deleted": True}))
        self.server._settle(line_id, self.FIRST[:3])
        [row] = [r for r in self.rows() if r["turn_id"] == line_id]
        self.assertEqual((row["state"], self.users(), line_id in self.server._cut_lines), ("cancelled", [], False))

    def test_a_receipt_during_the_takeback_does_not_bring_the_cut_line_back(self):
        line_id, first = self.streaming()
        self.receipt(first, "started")
        self.cut()
        changed, apply, inside, sent = self.server._memories_changed, self.server._apply_window_ops, [], []

        def taking_back(*args, **kwargs):
            inside.append(True)
            changed(*args, **kwargs)

        def apply_then_receipt():
            apply()
            if inside and not sent:  # the takeback's first apply
                sent.append(self.receipt(first, "ended", 2 * HALF))

        self.server._memories_changed, self.server._apply_window_ops = taking_back, apply_then_receipt
        self.assertEqual(self.request("DELETE", f"/memory/facts/{self.fact_id}?expected_version=1"), (200, {"deleted": True}))
        self.assertEqual(sent[0][1]["applied"], True)
        self.line("再说一句")
        self.assertTrue(wait_for(lambda: not self.server._live_lines))
        [row] = [r for r in self.rows() if r["turn_id"] == line_id]
        self.assertEqual((row["state"], self.users()), ("cancelled", ["再说一句"]))


class CutAfterStreamingTest(PlaybackCase):
    """A cut after the line streamed, while its speech plays, settles the line by the renderer's receipts."""
    two_clauses = InterruptedLineTest.two_clauses

    def speech_cancelled(self):
        return [i for i in self.server.registry.intents_since(0) if i.get("event") == "speech_cancelled"]

    def attended_line(self):
        """two_clauses with an attention store, so the line's context used the activity."""
        self.server.attention = AttentionStore(Path(self.data.name) / "attention.sqlite",
                                               Blacklist(deny_blacklist(Path(self.data.name) / "blacklist.json")))
        self.addCleanup(self.server.attention.close)
        return self.two_clauses()

    def test_clearing_attention_cuts_the_speech_of_a_line_whose_context_used_it(self):
        first, second = self.attended_line()
        generation = self.server.turn_generation
        self.receipt(first, "started")
        self.receipt(first, "ended", 2 * HALF)
        self.receipt(second, "started")
        self.assertEqual(self.request("DELETE", "/attention")[0], 200)
        self.assertFalse(self.relay.busy())
        self.assertEqual([(e["turn_generation"], e["speech_id"]) for e in self.speech_cancelled()],
                         [(generation + 1, second)])
        self.assertEqual(self.receipt(second, "interrupted", HALF, reason="client_cancel")[1]["applied"], True)
        [row] = self.rows()
        self.assertEqual((row["state"], row["reply"]), ("interrupted", "第一句话说完了，第二句话"))

    def test_clearing_attention_once_the_speech_played_cuts_nothing(self):
        clauses = self.attended_line()
        generation = self.server.turn_generation
        for speech_id in clauses:
            self.receipt(speech_id, "started")
            self.receipt(speech_id, "ended", 2 * HALF)
        self.assertEqual(self.request("DELETE", "/attention")[0], 200)
        self.assertEqual((self.speech_cancelled(), self.server.turn_generation), ([], generation))
        [row] = self.rows()
        self.assertEqual((row["state"], row["reply"]), ("completed", "第一句话说完了，第二句话也说完了。"))

    def tap_stop(self, by_id):
        """POST /speech/cancel after the first clause ended and while the second plays."""
        first, second = self.two_clauses()
        self.receipt(first, "started")
        self.receipt(first, "ended", 2 * HALF)
        body = {"speech_id": second} if by_id else {}
        self.assertEqual(self.request("POST", "/speech/cancel", {"reason": "client_cancel", **body}),
                         (202, {"ok": True}))
        [row] = self.rows()
        self.assertEqual((row["state"], row["reply"]), ("interrupted", "第一句话说完了，"))
        self.assertEqual(self.server.mouth.history[-1][1]["content"], "第一句话说完了，")

    def test_a_tap_stop_keeps_the_clause_that_ended(self):
        self.tap_stop(by_id=False)

    def test_a_tap_stop_by_speech_id_keeps_the_clause_that_ended(self):
        self.tap_stop(by_id=True)

    def test_a_tap_stop_by_speech_id_settles_the_line_of_that_clause(self):
        first, _ = self.two_clauses()
        # A later utterance that did not cut this line's: no public call voices one without superseding it.
        self.server._voiced = ("announce-99", "later", "clause_end")
        self.assertEqual(self.request("POST", "/speech/cancel", {"reason": "client_cancel", "speech_id": first}),
                         (202, {"ok": True}))
        [row] = self.rows()
        self.assertEqual(row["state"], "cancelled")
        self.line("下一句")
        self.assertEqual(self.past(), ["下一句"])

    def announced_after(self, clauses):
        """Each of clauses played to its end, then a P0 announcement that the renderer started playing."""
        for speech_id in clauses:
            self.receipt(speech_id, "started")
            self.receipt(speech_id, "ended", 2 * HALF)
        self.server.announce({"ts": 1.0, "level": "P0", "kind": "dispatch_done", "headline": "codex 的任务完成了",
                              "project": "/repo", "session_id": None, "detail": None})
        self.collect(self.relay, len(clauses) + 1)
        self.assertTrue(self.tts.bodies[-1][1]["turn_id"].startswith("announce-"))
        self.receipt(self.tts.bodies[-1][1]["speech_id"], "started")
        self.assertTrue(self.relay.busy())

    def test_clearing_attention_spares_an_announcement_after_the_line(self):
        self.announced_after(self.attended_line())
        generation = self.server.turn_generation
        self.assertEqual(self.request("DELETE", "/attention")[0], 200)
        self.assertEqual((self.speech_cancelled(), self.server.turn_generation, self.relay.busy()),
                         ([], generation, True))

    def test_correcting_a_fact_spares_an_announcement_after_the_line(self):
        self.server.memory = Memory(open_store(self.db))
        self.server.mouth = ScriptedMouth(self.fake, memory=self.server.memory)
        # A resident fact goes into every turn, so the line's request uses it.
        fact_id = self.server.memory.add("阿砚", "confirmed_by_user", kind="name")
        self.announced_after(self.two_clauses())
        generation = self.server.turn_generation
        self.assertEqual(self.request("PATCH", f"/memory/facts/{fact_id}", {"expected_version": 1, "text": "阿岩"})[0], 200)
        self.assertEqual((self.speech_cancelled(), self.server.turn_generation, self.relay.busy()),
                         ([], generation, True))
        [row] = self.rows()
        self.assertEqual(row["state"], "cancelled")


class DiagVoiceTest(PlaybackCase):
    def voice(self):
        return self.request("GET", "/diag/state")[1]["mouth_voice"]["voice"]

    def test_voice_follows_the_receipts(self):
        speech_id = self.spoken_line()
        self.assertEqual(self.voice(), "playing_estimated")
        self.receipt(speech_id, "started")
        self.assertEqual(self.voice(), "playing")
        self.receipt(speech_id, "buffering", HALF)
        self.assertEqual(self.voice(), "buffering")


if __name__ == "__main__":
    unittest.main()
