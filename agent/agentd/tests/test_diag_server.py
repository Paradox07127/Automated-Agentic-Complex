"""In the server, decision events land in traces, /diag/state shows the panel's blocks, /diag/stream resumes."""
import datetime
import http.client
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from observation.blacklist import Blacklist  # noqa: E402
from support import deny_blacklist  # noqa: E402
from observation.attention import AttentionStore  # noqa: E402
from observation.capture import CaptureManager  # noqa: E402
from character.character_state import CharacterState  # noqa: E402
from character.gate import Gate  # noqa: E402
from character.judge import Judge  # noqa: E402
from character.proactive import DWELL, Proactive  # noqa: E402
from daemon.agentd_server import AgentdServer  # noqa: E402
from tools import install_hooks  # noqa: E402
from daemon.constants import VIEW_FRESH  # noqa: E402
from infra.store import open_store  # noqa: E402
import test_capture  # noqa: E402
from test_server import EVENTS, HOOK, UI  # noqa: E402
import test_speech  # noqa: E402
from test_trace_server import TraceServerCase  # noqa: E402
from test_turn import relay_for, wait_for  # noqa: E402
from traces.trace_format import validate_stream  # noqa: E402
from traces.trace_store import TraceStore, new_trace_id  # noqa: E402

BLOCKS = {"hooks", "turn", "mouth_voice", "gate", "proactive", "observation", "body", "sessions", "budget", "connections",
          "context", "behavior", "character_state", "interaction", "rituals"}
SELECTION = "一段很长的私密选中文字"
TITLE = "某个私密的页面标题"


class HaikuWant:
    name = "haiku"

    def answer(self, state, questions):
        return [{"id": q["id"], "value": True, "prob": 0.9} for q in questions]


class CancellingTTS(test_speech.FakeTTS):
    """The TTS ends the stream itself with a `cancelled` line instead of `complete`."""

    def __init__(self, **fake):
        super().__init__(end=None, **fake)
        self.RequestHandlerClass = _CancellingHandler


class _CancellingHandler(test_speech._TTSHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        lines = test_speech.upstream_lines(body, self.server.segments, end=None)
        ids = {k: body[k] for k in ("session_epoch", "turn_id", "speech_id")}
        lines.append({"event": "cancelled", **ids, "seq": len(lines), "reason": "error",
                      "last_sample_sent": 44800 * self.server.segments})
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.end_headers()
        for line in lines:
            self.wfile.write((json.dumps(line) + "\n").encode())


class Usage:
    def today(self):
        return {"calls": 3, "input_tokens": 100, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
                "output_tokens": 20, "cost_usd": 0.001, "unpriced": 0, "by_call": {"mouth": 3}}


class DiagCase(TraceServerCase):
    def tearDown(self):
        self.assertEqual(validate_stream(self.request("GET", "/trace/export?with_text=1")[1]["events"]), [])
        self.assertEqual(self.server.trace_errors, 0)
        super().tearDown()

    def state(self, query=""):
        status, body = self.request("GET", f"/diag/state{query}")
        self.assertEqual(status, 200)
        return body

    def decisions(self, kind):
        return self.request("GET", f"/trace/decisions?kind={kind}")[1]["events"]

    def chained(self, events):
        """events oldest first: one trace, each caused by the one before."""
        self.assertEqual(len({e["trace_id"] for e in events}), 1)
        self.assertTrue(all(e["causation_id"] == prev["event_id"] for prev, e in zip(events, events[1:])))


class DecisionTraceTest(DiagCase):
    def test_a_failed_judgement_is_stored_failed_with_its_reason_and_returned_by_trace_api(self):
        from models.model_auth import ModelError
        class Refused:
            name = "character_agent"
            def answer(self, state, questions):
                raise ModelError("ws_text_not_allowed")
        judge = Judge(Refused())
        judge.on_decision = self.server._decision
        self.assertIsNone(judge.ask({}, [{"id": "want_comment", "type": "yes_no"}], key="comment-1"))
        [event] = self.decisions("judge.decided")
        self.assertEqual(event["status"], "failed")
        self.assertEqual((event["attrs"]["backend"], event["attrs"]["answers"]), ("character_agent", []))
        self.assertEqual(event["attrs"]["failure_reason"], "ws_text_not_allowed")

    def test_approval_open_and_answer_share_one_trace(self):
        request = self.server.broker.open("claude", "A", "Bash")
        self.server.broker.decide(request.request_id, request.generation, "allow")
        decided, opened = self.decisions("approval")
        self.assertEqual((opened["kind"], decided["kind"]), ("approval.opened", "approval.decided"))
        self.assertEqual((decided["attrs"]["decision"], decided["attrs"]["by"]), ("allow", "card"))
        self.chained([opened, decided])

    def test_dispatch_proposal_and_answer_share_one_trace(self):
        request = self.server.dispatcher.propose("codex", "/repo", "跑一下测试")
        self.server.broker.decide(request.request_id, request.generation, "deny")
        self.assertTrue(wait_for(lambda: len(self.decisions("dispatch")) == 2))
        decided, proposed = self.decisions("dispatch")
        self.assertEqual((proposed["kind"], decided["kind"], decided["attrs"]["decision"]),
                         ("dispatch.proposed", "dispatch.decided", "deny"))
        events = self.request("GET", f"/trace/turns/{proposed['trace_id']}")[1]["events"]
        self.assertEqual([e["kind"] for e in events],
                         ["approval.opened", "dispatch.proposed", "approval.decided", "dispatch.decided"])
        self.chained(events)

    def test_failed_dispatch_start_is_recorded_in_its_card_trace(self):
        request = self.server.dispatcher.propose("codex", "/repo", "跑一下测试")
        sessions = mock.Mock(create=mock.Mock(side_effect=OSError("disk full")), announce=self.server.announce)
        with mock.patch.object(self.server.dispatcher, "sessions", sessions):
            self.server.broker.decide(request.request_id, request.generation, "allow")
            self.assertTrue(wait_for(lambda: any(e["kind"] == "dispatch.finished" for e in self.decisions("dispatch"))))
        [proposed] = [e for e in self.decisions("dispatch") if e["kind"] == "dispatch.proposed"]
        events = self.request("GET", f"/trace/turns/{proposed['trace_id']}")[1]["events"]
        self.assertEqual([e["kind"] for e in events], ["approval.opened", "dispatch.proposed", "approval.decided",
                                                       "dispatch.decided", "dispatch.failed", "dispatch.finished"])
        self.assertEqual(events[4]["attrs"], {"request_id": request.request_id, "error": "OSError"})
        self.chained(events)

    def test_dispatch_announcement_names_its_card_trace(self):
        request = self.server.dispatcher.propose("codex", "/repo", "跑一下测试")
        self.assertTrue(wait_for(lambda: self.decisions("dispatch")))
        [proposed] = self.decisions("dispatch")
        for origin, expected in ((request.request_id, proposed["trace_id"]), (None, None)):
            self.server.announce({"ts": 1.0, "level": "P2", "kind": "dispatch_done", "headline": "codex 的任务完成了",
                                  "project": "/repo", "session_id": None, "detail": None, "origin": origin})
            announced = [i["data"] for i in self.server.feed.since(0) if i["event"] == "announce"][-1]
            self.assertEqual(announced["trace_id"], expected, origin)

    def test_proactive_gate_judge_and_line_share_one_trace(self):
        self.use_attention()
        self.server.gate = Gate(enabled=True, quiet=(0, 0))
        self.server.gate.set_companion(True)
        judge = Judge(HaikuWant())
        self.server.gate.on_decision = judge.on_decision = self.server._decision
        proactive = Proactive(self.server.attention, self.server.gate, self.server.feed.publish,
                              self.server.start_line, self.server.busy, judge=judge, spawn=lambda f: f())
        now = time.time()
        for i in range(DWELL + 2):
            body = focus_beat(now - DWELL - 1 + i)
            self.server.attention.ingest(body)
            proactive.beat(body)
        self.assertTrue(wait_for(lambda: self.request("GET", "/trace/turns")[1]["turns"]
                                 and not self.server._live_lines))
        turn = self.only_turn()
        self.assertEqual(turn["source"], "proactive")
        events = self.events(turn["trace_id"])
        self.assertEqual([e["kind"] for e in events][:3], ["judge.decided", "gate.decided", "input.received"])
        self.chained(events)
        self.assertEqual(events[0]["attrs"]["answers"][0]["id"], "want_comment")

    def test_feedback_on_a_proactive_line_is_a_decision(self):
        self.server.proactive = Proactive(None, self.server.gate, self.server.feed.publish, self.server.start_line,
                                          self.server.busy)
        self.server.start_line("p1", "（主动搭话）")
        self.assertTrue(wait_for(lambda: not self.server._live_lines))
        user_line = self.line("你好")["line_id"]  # a user line is no proactive line
        for body, expected in (({"line_id": "p1", "value": "meh"}, (400, {"error": "invalid_payload"})),
                               ({"line_id": "p1"}, (400, {"error": "invalid_payload"})),
                               ({"line_id": "", "value": "useful"}, (400, {"error": "invalid_payload"})),
                               ({"line_id": "p" * 65, "value": "useful"}, (400, {"error": "invalid_payload"})),
                               ({"line_id": "p2", "value": "useful"}, (404, {"error": "unknown_line"})),
                               ({"line_id": user_line, "value": "useful"}, (404, {"error": "unknown_line"}))):
            with self.subTest(body=body):
                self.assertEqual(self.request("POST", "/feedback", body), expected)
        self.assertEqual(self.request("POST", "/feedback", {"line_id": "p1", "value": "useful"}, token=EVENTS)[0],
                         401)
        self.assertEqual(self.decisions("proactive.feedback"), [])
        self.server.proactive.misses = 5
        self.assertEqual(self.request("POST", "/feedback", {"line_id": "p1", "value": "useful"}), (200, {}))
        [event] = self.decisions("proactive.feedback")
        self.assertEqual((event["attrs"], event["producer"]), ({"line_id": "p1", "value": "useful"}, "agentd"))
        proactive = self.state()["proactive"]
        self.assertEqual((proactive["misses"], proactive["factor"]), (0, 1))

    def test_tts_that_cancels_on_its_own_finishes_the_speech_once(self):
        tts, relay = relay_for(self, tts_class=CancellingTTS)
        relay.on_event = self.server.on_speech_event
        self.server.speech = relay
        self.line("你好")
        turn = self.only_turn()
        self.assertTrue(wait_for(lambda: self.of(self.events(turn["trace_id"]), "speech.finished")))
        time.sleep(0.1)
        [finished] = self.of(self.events(turn["trace_id"]), "speech.finished")
        self.assertEqual((finished["producer"], finished["status"], finished["attrs"]["total_samples"]),
                         ("tts", "cancelled", 89600))
        self.assertEqual([item["data"]["event"] for item in relay.since(0)].count("cancelled"), 1)

    def test_character_switch_cancels_the_running_line(self):
        self.use_mouth(["[intent:explain]一"] + ["二"] * 50, delay=0.05)
        conn, response = self.open_feed()
        self.request("POST", "/say", {"text": "说个长的", "source": "text"})
        self.next_event(response)
        self.assertEqual(self.request("POST", "/character", {"id": "birch"})[0], 200)
        self.lines_until_final(response)
        conn.close()
        self.assertTrue(wait_for(lambda: not self.server._live_lines))
        events = self.events(self.only_turn()["trace_id"])
        [requested] = self.of(events, "cancel.requested")
        self.assertEqual(requested["attrs"], {"by": "character_switch", "target": "turn"})
        self.assertEqual(len(self.of(events, "cancel.acked")), 1)


def focus_beat(ts):
    return {"ts": ts, "front": test_capture.CODE | {"pid": 11}, "mouse": None, "idle_s": 0.0, "locked": False,
            "asleep": False, "focus_role": None, "secure_input": False}


class DiagLocalStateTest(unittest.TestCase):
    def setUp(self):
        self.data = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.addCleanup(self.data.cleanup)
        self.db = Path(self.data.name) / "agentd.sqlite"
        with mock.patch.object(AgentdServer, "server_bind"), mock.patch.object(AgentdServer, "server_activate"), \
                mock.patch.object(AgentdServer, "_tick_loop"):
            self.server = AgentdServer(("127.0.0.1", 48810), HOOK, UI)
        self.server.server_port = 48810
        self.addCleanup(self.server.server_close)
        db = open_store(self.db)
        self.addCleanup(db.close)
        self.server.trace = TraceStore(db, producer_epoch=self.server.registry.epoch)

    def state(self):
        return self.server.diag_state()

    def use_attention(self):
        self.server.attention = AttentionStore(Path(self.data.name) / "attention.sqlite",
                                               Blacklist(deny_blacklist(Path(self.data.name) / "blacklist.json")))
        self.addCleanup(self.server.attention.close)

    def test_companion_off_explains_why_no_comment_judge_will_run(self):
        self.use_attention()
        self.server.gate = Gate(enabled=True, quiet=(0, 0))
        self.server.gate.set_companion(False)
        self.server.proactive = Proactive(self.server.attention, self.server.gate, self.server.feed.publish,
                                          self.server.start_line, self.server.busy, judge=object())
        now = time.time()
        for i in range(DWELL + 1):
            self.server.attention.ingest(focus_beat(now - DWELL + i))
        body = self.state()
        self.assertIsNotNone(body["proactive"]["focus"])
        self.assertEqual((body["gate"].get("companion_mode"), body["proactive"]["next_judge_at"],
                          body["proactive"].get("held")), (False, None, "companion_off"))
        self.assertEqual(body["gate"]["blocked_today"], 0)
        self.server.gate.set_companion(True)
        body = self.state()
        self.assertTrue(body["gate"]["companion_mode"])
        self.assertIsNone(body["proactive"]["held"])
        self.assertIsNotNone(body["proactive"]["next_judge_at"])

    def test_last_judge_is_restored_from_newest_stored_comment_judge_after_restart(self):
        store = self.server.trace
        comment = [{"id": "need_image", "value": False, "prob": 1.0},
                   {"id": "want_comment", "value": False, "prob": 0.9}]
        now = time.time()
        for offset, backend, answers in ((-60, "rules", comment), (-30, "character_agent", comment),
                                          (0, "rules", comment[:1])):
            store.clock = lambda offset=offset: now + offset
            store.emit("judge.decided", new_trace_id(), attrs={"backend": backend, "answers": answers})
        expected = store.decisions("judge.decided")[1]
        with mock.patch.object(AgentdServer, "server_bind"), mock.patch.object(AgentdServer, "server_activate"), \
                mock.patch.object(AgentdServer, "_tick_loop"):
            restarted = AgentdServer(("127.0.0.1", 48810), HOOK, UI)
        restarted.server_port = 48810
        self.addCleanup(restarted.server_close)
        db = open_store(self.db)
        self.addCleanup(db.close)
        queries = []
        db.set_trace_callback(queries.append)
        restarted.trace = TraceStore(db, producer_epoch=restarted.registry.epoch)
        last = restarted.diag_state()["proactive"]["last_judge"]
        self.assertEqual(last, {"backend": "character_agent", "answers": comment, "at": expected["t_wall"]})
        self.assertEqual(restarted.diag_state()["proactive"]["last_judge"], last)
        self.assertEqual(len([sql for sql in queries if "FROM trace_events" in sql]), 1)
        restarted._decision("judge.decided", {"backend": "rules", "answers": comment}, "live-comment")
        self.assertEqual(restarted.diag_state()["proactive"]["last_judge"]["backend"], "rules")


class DiagStateTest(DiagCase):
    def test_every_block_has_its_updated_at(self):
        self.line("你好")
        body = self.state()
        self.assertEqual(set(body), BLOCKS)
        for name, block in body.items():
            with self.subTest(block=name):
                datetime.datetime.fromisoformat(block["updated_at"])
        self.assertEqual((body["turn"]["source"], body["turn"]["phase"]), ("text", "ended"))
        self.assertIn("received", body["turn"]["phases_ms"])
        self.assertNotIn("avatar", body["body"])
        self.assertEqual(self.request("GET", "/diag/state", token=EVENTS)[0], 401)
        self.assertEqual(self.request("GET", "/diag/stream", token=EVENTS)[0], 401)

    def test_turn_counts_completed_lines_in_another_language_than_the_reply_language(self):
        self.assertEqual(self.state()["turn"]["language"], {"lines": 0, "mismatched": 0})
        self.line("你好")  # REPLY is Chinese; KernelLines replies in zh-Hans
        self.assertEqual(self.state()["turn"]["language"], {"lines": 1, "mismatched": 0})
        self.server.character_agent.settings = SimpleNamespace(snapshot=lambda: {"reply_language": "en"})
        self.line("hello there")
        self.assertEqual(self.state()["turn"]["language"], {"lines": 2, "mismatched": 1})
        self.server.character_agent.settings = SimpleNamespace(snapshot=lambda: {"reply_language": "harness"})
        self.line("hello again")
        self.assertEqual(self.state()["turn"]["language"], {"lines": 2, "mismatched": 1})  # harness: no language to check

    def test_updated_at_moves_only_when_the_block_changes(self):
        first = self.state()
        time.sleep(0.01)
        self.server.gate.enabled = not self.server.gate.enabled
        second = self.state()
        self.assertNotEqual(first["gate"]["updated_at"], second["gate"]["updated_at"])
        self.assertEqual(first["body"]["updated_at"], second["body"]["updated_at"])

    def test_texts_show_only_length_and_head_unless_asked(self):
        self.server.share_page_text = True  # Text diagnostics require permitted capture.
        self.use_attention()
        now = time.time()
        for message in ({"type": "selection", "ts": now, "url_host": "github.com", "title": TITLE, "text": SELECTION},
                        {"type": "heartbeat", "ts": now, "url_host": "github.com", "title": TITLE}):
            self.assertEqual(self.request("POST", "/context/browser", message, HOOK)[0], 200)
        plain = json.dumps(self.state(), ensure_ascii=False)
        self.assertNotIn(SELECTION, plain)
        self.assertNotIn(TITLE, plain)
        context = self.state()["context"]
        self.assertEqual(context["selection"]["text"], {"len": len(SELECTION), "head": SELECTION[:8]})
        full = self.state("?with_text=1")["context"]
        self.assertEqual(full["selection"]["text"]["text"], SELECTION)
        self.assertIn(TITLE, json.dumps(full, ensure_ascii=False))

    def test_gate_counts_the_lines_it_refused_today(self):
        self.assertEqual(self.state()["gate"]["blocked_today"], 0)
        self.server.gate.admit("comment", "P2")
        self.server.gate.admit("dispatch_done", "P1")
        self.server.gate.admit("approval", "P0")
        self.assertEqual(self.state()["gate"]["blocked_today"], 2)
        self.server.gate.admit("comment", "P2", now=datetime.datetime.now() + datetime.timedelta(days=1))
        self.assertEqual(self.state()["gate"]["blocked_today"], 0)  # that refusal counts for tomorrow

    def test_hooks_show_whether_they_are_installed_and_when_one_last_came(self):
        folder = Path(self.data.name)
        url = f"http://127.0.0.1:{self.server.server_port}"
        ours = {"type": "command", "command": f"/usr/bin/python3 /x/codex_hook_forward.py --endpoint /hook/claude"
                                              f" --observe --url {url}", "async": True, "onFailure": "continue"}
        (folder / "settings.json").write_text(json.dumps({"hooks": {"Stop": [{"hooks": [ours]}]}}), encoding="utf-8")
        (folder / "bad.json").write_text("{", encoding="utf-8")
        self.server.hook_files = {"claude": folder / "settings.json", "codex": folder / "hooks.json"}
        hooks = self.state()["hooks"]
        self.assertEqual({k: (v["installed"], v["last_at"]) for k, v in hooks.items() if k != "updated_at"},
                         {"claude": (True, None), "codex": (False, None)})
        self.assertEqual(self.request("POST", "/hook/claude", {"hook_event_name": "Stop", "session_id": "A"},
                                      token=HOOK)[0], 200)
        hooks = self.state()["hooks"]
        datetime.datetime.fromisoformat(hooks["claude"]["last_at"])
        self.assertIsNone(hooks["codex"]["last_at"])
        self.server.hook_files = {"claude": folder / "bad.json"}
        hooks = self.state()["hooks"]
        self.assertEqual((hooks["claude"]["installed"], hooks["codex"]["installed"]), (None, None))

    def test_an_unchanged_hook_file_is_not_read_again(self):
        path = Path(self.data.name) / "settings.json"
        url = f"http://127.0.0.1:{self.server.server_port}"
        ours = {"type": "command", "command": f"/usr/bin/python3 /x/codex_hook_forward.py --endpoint /hook/claude"
                                              f" --observe --url {url}"}
        path.write_text(json.dumps({"hooks": {}}), encoding="utf-8")
        self.server.hook_files = {"claude": path}
        load, reads = install_hooks.load, []
        with mock.patch.object(install_hooks, "load", lambda p: (reads.append(p), load(p))[1]):
            self.assertFalse(self.server.diag_state()["hooks"]["claude"]["installed"])
            self.assertFalse(self.server.diag_state()["hooks"]["claude"]["installed"])
            self.assertEqual(reads, [path])
            stat = path.stat()
            path.write_text(json.dumps({"hooks": {"Stop": [{"hooks": [ours]}]}}), encoding="utf-8")
            os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
            self.assertTrue(self.server.diag_state()["hooks"]["claude"]["installed"])
            self.assertEqual(reads, [path, path])

    def test_gate_cooldown_includes_her_state_scale_as_the_gate_does(self):
        self.server.gate = Gate(enabled=True, quiet=(0, 0), state_scale=lambda: 1.5)
        self.server.gate.set_companion(True)
        self.assertEqual(self.server.gate.admit("comment", "P2"), (True, None))
        self.assertGreater(self.state()["gate"]["cooldown_s"]["comment"], 600 + 1)  # 600 s × 1.5

    def test_diag_state_has_a_character_state_block(self):
        empty = self.state()["character_state"]
        self.assertEqual((empty["character_id"], empty["labels"], empty["causes"]), (None, None, []))
        db = open_store(Path(self.data.name) / "state.sqlite")
        self.addCleanup(db.close)
        state = CharacterState(db, lambda cid: None)
        state.use("aster")
        state.on_event("dispatch_done")
        self.server.state = state
        block = self.state()["character_state"]
        self.assertEqual(set(block), {"character_id", "energy", "valence", "engagement", "activity", "labels", "causes",
                                      "affects_behavior", "updated_at"})
        self.assertEqual((block["character_id"], block["affects_behavior"], block["causes"][-1]["cause"]),
                         ("aster", True, "dispatch_done"))
        self.assertEqual(set(block["labels"]), {"energy", "mood", "engagement"})
        datetime.datetime.fromisoformat(block["updated_at"])

    def test_budget_shows_what_the_meters_report(self):
        self.assertIsNone(self.state()["budget"]["model"])
        self.server.usage = Usage()
        self.assertEqual(self.state()["budget"]["model"], Usage().today())


class ContextReasonTest(DiagCase):
    def capture(self, vision=True, clock=time.time):
        self.server.capture = CaptureManager(self.server.feed, Blacklist(deny_blacklist(Path(self.data.name) / "blacklist.json")),
                                             lambda: test_capture.CODE, None, clock=clock,
                                             vision=test_capture.FakeVision() if vision else None)

    def rejected(self):
        return self.state()["context"]["rejected"]

    def test_secure_input_is_no_permission(self):
        self.capture()
        self.server.capture.secure_input(True)
        self.assertEqual(self.request("POST", "/look", {})[0], 409)
        self.assertEqual({k: self.rejected()[k] for k in ("state", "detail", "reason")},
                         {"state": "declined", "detail": "secure_input", "reason": "no_permission"})

    def test_failed_screenshot_is_capture_failed(self):
        self.capture()
        status, looked = self.request("POST", "/look", {})
        self.assertEqual(status, 202)
        self.assertEqual(self.request("POST", "/context/image", {"request_id": looked["request_id"], "window_id": 2,
                                                                  "error": "capture_failed"})[0], 200)
        self.assertEqual({k: self.rejected()[k] for k in ("request_id", "state", "reason")},
                         {"request_id": looked["request_id"], "state": "failed", "reason": "capture_failed"})

    def test_screenshots_off_is_not_connected(self):
        self.capture(vision=False)
        self.assertEqual(self.request("POST", "/look", {})[0], 409)
        context = self.state()["context"]
        self.assertEqual((context["rejected"]["reason"], context["sources"]["screenshots"]),
                         ("not_connected", "not_connected"))
        self.assertEqual(context["sources"]["page_text"], "not_connected")

    def test_old_view_is_expired(self):
        self.capture(clock=lambda: time.time() - VIEW_FRESH - 10)
        status, looked = self.request("POST", "/look", {})
        self.assertEqual(status, 202)
        self.server.capture.image(looked["request_id"], 2, test_capture.png())
        self.assertTrue(wait_for(lambda: self.server.capture.view() is not None))
        self.assertEqual({k: self.rejected()[k] for k in ("request_id", "state", "reason")},
                         {"request_id": looked["request_id"], "state": "expired", "reason": "expired"})

    def test_control_a_fresh_view_is_no_rejection(self):
        self.capture()
        status, looked = self.request("POST", "/look", {})
        self.server.capture.image(looked["request_id"], 2, test_capture.png())
        self.assertTrue(wait_for(lambda: self.server.capture.view() is not None))
        self.assertIsNone(self.rejected())


class DiagStreamTest(DiagCase):
    def open_stream(self, last=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        headers = {"Authorization": f"Bearer {UI}"}
        if last is not None:
            headers["Last-Event-ID"] = last
        conn.request("GET", "/diag/stream", headers=headers)
        response = conn.getresponse()
        self.assertEqual(response.status, 200)
        self.addCleanup(conn.close)
        return conn, response

    def until(self, response, name, seen=None):
        while True:
            event = self.next_event(response)
            if seen is not None:
                seen.append(event)
            if event["event"] == name:
                return event

    def test_state_first_then_decisions(self):
        _, response = self.open_stream()
        first = self.next_event(response)
        self.assertEqual(first["event"], "state")
        self.assertEqual(set(json.loads(first["data"])) - {"seq"}, BLOCKS)
        self.server.gate.admit("gate_fail", "P1")
        decision = json.loads(self.until(response, "decision")["data"])
        self.assertEqual((decision["kind"], decision["attrs"]["reason"]), ("gate.decided", "disabled"))

    def test_trace_events_carry_only_length_and_head(self):
        _, response = self.open_stream()
        self.line("你好呀这是一句挺长的话")
        event = json.loads(self.until(response, "trace")["data"])
        self.assertEqual((event["kind"], event["attrs"]["text"]), ("input.received", {"len": 11, "head": "你好呀这是一句挺"}))
        self.assertTrue({"span_id", "parent_span_id", "duration_ms"} <= set(event))

    def test_reconnect_resumes_after_the_last_event_without_repeats(self):
        conn, response = self.open_stream()
        self.next_event(response)
        self.server.gate.admit("first", "P1")
        seen = self.until(response, "decision")["id"]
        conn.close()
        self.server.gate.admit("second", "P1")
        _, response = self.open_stream(seen)
        replayed = []
        decision = json.loads(self.until(response, "decision", replayed)["data"])
        self.assertEqual(decision["attrs"]["kind"], "second")
        ids = [int(e["id"].rpartition("-")[2]) for e in replayed]
        self.assertTrue(all(i > int(seen.rpartition("-")[2]) for i in ids))
        self.assertEqual(ids, sorted(set(ids)))

    def test_lost_or_foreign_cursor_resets_to_a_full_state(self):
        _, response = self.open_stream()
        boot = self.next_event(response)["id"].rpartition("-")[0]
        for _ in range(600):
            self.server.diag.publish("trace", {})
        for last in (f"{boot}-1", "0123abcd-3"):
            with self.subTest(last=last):
                _, response = self.open_stream(last)
                reset = self.next_event(response)
                self.assertEqual(reset["event"], "reset")
                state = self.next_event(response)
                self.assertEqual((state["event"], state["id"].rpartition("-")[0]), ("state", boot))
                self.assertGreaterEqual(int(state["id"].rpartition("-")[2]), 600)
        _, response = self.open_stream(f"{boot}-{self.server.diag.seq}")  # control: a live cursor resumes
        self.server.gate.admit("third", "P1")
        self.assertEqual(self.until(response, "decision")["event"], "decision")


if __name__ == "__main__":
    unittest.main()
