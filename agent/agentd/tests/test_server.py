import contextlib
import datetime
import http.client
import io
import json
import sqlite3
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
import unittest.mock

import support
import test_route_registry

from sessions.agent_meta import AgentMeta  # noqa: E402
from sessions.approvals import ApprovalBroker  # noqa: E402
from api.hooks import DENY_MESSAGE  # noqa: E402
from observation.attention import AttentionStore  # noqa: E402
from observation.capture import CaptureManager  # noqa: E402
from character.character_state import CharacterState  # noqa: E402
from character.feed import Feed  # noqa: E402
from character.focus import Focus  # noqa: E402
from character.behavior import Behavior  # noqa: E402
from character.gate import Gate  # noqa: E402
from observation.blacklist import Blacklist  # noqa: E402
from brain import characters  # noqa: E402
from brain.provider import Mouth  # noqa: E402
from brain.language import ReplyLanguage  # noqa: E402
import c1  # noqa: E402
from character import character_state  # noqa: E402
import codex_hook_forward  # noqa: E402
from personal.episodes import Episodes  # noqa: E402
from daemon.constants import RECEIPTS_KEPT  # noqa: E402
from observation.user_now import UserNow  # noqa: E402
from daemon.agentd_server import AgentdServer  # noqa: E402
from daemon.main import parse_args  # noqa: E402
from infra.tokens import read_token, write_secret  # noqa: E402
from observation import spatial  # noqa: E402
from infra.store import open_store  # noqa: E402
from observation import user_state  # noqa: E402

HOOK, UI, EVENTS = "hook-token", "ui-token", "events-token"
WINDOW = 0.3


class UserRoutesTest(unittest.TestCase):
    request = test_route_registry.ProactiveRoutesTest.request

    def setUp(self):
        with unittest.mock.patch.object(AgentdServer, "server_bind"), \
                unittest.mock.patch.object(AgentdServer, "server_activate"):
            self.server = AgentdServer(("127.0.0.1", 48810), HOOK, UI, events_token=EVENTS)
        self.server.server_port = 48810
        self.addCleanup(self.server.server_close)

    def test_coarse_routes_require_the_host_token(self):
        for token in (HOOK, EVENTS, None):
            self.assertEqual(self.request("POST", "/user/coarse", {"ts": time.time(), "idle_s": 0}, token=token)[0], 401)
            self.assertEqual(self.request("GET", "/user/now", token=token)[0], 401)

    def now(self):
        status, body = self.request("GET", "/user/now")
        self.assertEqual(status, 200)
        return body

    def test_coarse_with_screen_awareness_off_changes_the_snapshot(self):
        with unittest.mock.patch.dict("infra.plugins.resolved", screen_awareness=False):
            self.assertEqual(self.request("POST", "/user/coarse", {"ts": time.time(), "idle_s": 0, "mic_active": True}),
                             (200, {"presence": "present", "stage": "quiet", "doing": "meeting", "absence": None, "revision": 1,
                                    "typing": True}))
            body = self.now()
        self.assertEqual((body["snapshot"]["revision"], body["snapshot"]["presence"], body["snapshot"]["doing"]),
                         (1, "present", "meeting"))
        self.assertIn("user.enter.meeting", [e["name"] for e in body["events"]])
        self.assertIsNone(self.server.attention)

    def test_coarse_rejects_content_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            policy = Path(directory) / "privacy.json"
            policy.write_text('{"sense_input_counts": true}', encoding="utf-8")
            self.server.privacy_config = policy
            beat = {"ts": time.time(), "idle_s": 0}
            for field, value in (("front", {"app": "Code"}), ("title", "notes.txt"), ("app", "Code"),
                                 ("url_host", "example.com"), ("text", "hi")):
                with self.subTest(field=field):
                    self.assertEqual(self.request("POST", "/user/coarse", {**beat, field: value}),
                                     (400, {"error": "invalid_coarse"}))
            self.assertEqual(self.request("POST", "/user/coarse", {**beat, "input": {"keys_10s": 3, "app": "Code"}}),
                             (400, {"error": "invalid_coarse"}))
            self.assertEqual(self.now()["snapshot"]["revision"], 0)

    def test_coarse_schema(self):
        with tempfile.TemporaryDirectory() as directory:
            policy = Path(directory) / "privacy.json"
            self.server.privacy_config = policy
            policy.write_text('{"sense_input_counts": true}', encoding="utf-8")
            base = {"ts": time.time(), "idle_s": 0}
            for fields in ({"ts": True}, {"idle_s": -1}, {"locked": None}, {"edge": "open"}, {"asleep": 1},
                           {"front_gpu": 1.1}, {"front_audio_out": 0}, {"input": {"keys_60s": -1}},
                           {"input": {"keys_10s": True}}, {"input": {"clicks_10s": 1}}, {"input": []}):
                with self.subTest(fields=fields):
                    self.assertEqual(self.request("POST", "/user/coarse", {**base, **fields}),
                                     (400, {"error": "invalid_coarse"}))
            self.assertEqual(self.request("POST", "/user/coarse", {**base, "input": {"keys_10s": 12, "key_idle_s": 0}})[0],
                             200)
            self.assertTrue(self.now()["snapshot"]["typing"])
            policy.write_text('{"sense_input_counts": false}', encoding="utf-8")
            self.assertEqual(self.request("POST", "/user/coarse", {**base, "input": {}}),
                             (400, {"error": "invalid_coarse"}))
            policy.write_text('{}', encoding="utf-8")  # never saved: on, as the shell's Settings default is
            self.assertEqual(self.request("POST", "/user/coarse", {**base, "input": {}})[0], 200)

    def test_only_the_observation_pause_freezes_it(self):
        support.enable_plugins(self, "screen_awareness")
        beat = lambda **fields: self.request("POST", "/user/coarse", {"ts": time.time(), "idle_s": 0, **fields})  # noqa: E731
        beat()
        self.assertEqual(self.request("PUT", "/observation/meeting", {"on": True}), (200, {"meeting": True}))
        snapshot = self.now()["snapshot"]
        self.assertEqual((snapshot["paused"], snapshot["doing"], snapshot["stage"],
                          snapshot["overrides"]["meeting_manual"]), (False, "meeting", "quiet", True))
        self.request("PUT", "/observation/meeting", {"on": False})
        until = time.time() + 600
        self.assertEqual(self.request("PUT", "/observation/quiet", {"until": until})[0], 200)
        beat(edge="lock")
        snapshot = self.now()["snapshot"]
        self.assertEqual((snapshot["paused"], snapshot["presence"], snapshot["overrides"]),
                         (False, "locked", {"meeting_manual": False, "dnd_until": until, "focus_timer": False}))
        self.request("PUT", "/observation/quiet", {"until": None})
        self.assertIsNone(self.now()["snapshot"]["overrides"]["dnd_until"])
        self.assertEqual(self.request("PUT", "/observation/paused", {"minutes": 5})[0], 200)
        frozen = self.now()["snapshot"]
        self.assertTrue(frozen["paused"])
        self.assertEqual(beat(edge="unlock"), (200, {**{k: frozen[k] for k in ("presence", "stage", "doing", "absence", "revision")},
                                                     "typing": False}))
        self.assertEqual(self.now()["snapshot"], frozen)
        self.request("PUT", "/observation/paused", {"minutes": 0})
        self.assertFalse(self.now()["snapshot"]["paused"])


class UserNowReadersTest(unittest.TestCase):
    """Each reader of presence, return, meeting, typing, fullscreen and stage takes user_now's judgment; screen awareness
    is off unless a test turns it on."""
    request = test_route_registry.ProactiveRoutesTest.request

    def setUp(self):
        with unittest.mock.patch.object(AgentdServer, "server_bind"), \
                unittest.mock.patch.object(AgentdServer, "server_activate"):
            self.server = AgentdServer(("127.0.0.1", 48810), HOOK, UI, events_token=EVENTS, gate=Gate(enabled=True))
        self.server.server_port = 48810
        self.addCleanup(self.server.server_close)
        patcher = unittest.mock.patch.dict("infra.plugins.resolved", screen_awareness=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.ts = time.time()
        self.server.clock = lambda: self.ts

    def beat(self, step=1, idle_s=0, **fields):
        self.ts += step
        return self.request("POST", "/user/coarse", {"ts": self.ts, "idle_s": idle_s, **fields})

    def counts(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        policy = Path(tmp.name) / "privacy.json"
        policy.write_text('{"sense_input_counts": true}', encoding="utf-8")
        self.server.privacy_config = policy

    def test_the_answer_is_the_snapshots_presence_stage_absence_revision_and_typing(self):
        self.assertEqual(self.beat(), (200, {"presence": "present", "stage": "normal", "doing": "idle", "absence": None, "revision": 1,
                                             "typing": True}))
        status, body = self.beat(edge="lock")
        self.assertEqual((status, body["presence"], body["stage"], body["revision"], body["typing"]),
                         (200, "locked", "offstage", 2, False))
        self.assertEqual(set(body["absence"]), {"id", "since"})

    def test_the_gate_takes_meeting_fullscreen_speaking_and_typing_from_user_now(self):
        self.counts()
        gate, noon = self.server.gate, datetime.datetime(2026, 10, 18, 12, 0)
        for fields, flag, reason in (({"mic_active": True}, "meeting", "meeting"),
                                     ({"camera_active": True}, "meeting", "meeting"),
                                     ({"screen_captured": True}, "meeting", "meeting"),
                                     ({"fullscreen": True}, "fullscreen", "fullscreen"),
                                     ({"user_speaking": True}, "user_speaking", "user_speaking"),
                                     ({"input": {"keys_10s": 12, "key_idle_s": 0}}, "typing", "quiet")):
            with self.subTest(fields=fields):
                self.setUp()
                self.counts()
                gate, noon = self.server.gate, datetime.datetime(2026, 10, 18, 12, 0)
                self.assertEqual(self.beat(**fields)[0], 200)
                self.assertTrue(getattr(gate, flag))
                self.assertEqual(gate._reason("announce", noon), reason)
        self.beat(idle_s=3)
        self.beat(idle_s=4)
        self.assertEqual((gate.typing, gate.stage, gate._reason("announce", noon)), (False, "normal", None))

    def test_typing_without_key_counts_is_input_active(self):
        self.beat(idle_s=1)
        self.assertTrue(self.server.gate.typing)
        self.beat(idle_s=3)
        self.assertFalse(self.server.gate.typing)

    def test_one_return_reaches_the_spoken_report_and_the_held_signals_once(self):
        backs, returns = [], []
        self.server.proactive = SimpleNamespace(back=backs.append)
        self.server.signals = SimpleNamespace(returned=lambda: returns.append(True))
        start = self.ts
        self.beat(0)
        self.beat(idle_s=1, edge="lock")  # the absence began at the last input, the beat before
        self.beat(300, edge="sleep")
        self.beat(1, edge="wake")
        self.assertEqual(backs, [])
        self.beat(1, edge="unlock")
        self.beat(1)
        self.assertEqual((backs, returns), ([self.ts - 1 - start], [True]))
        self.assertEqual(self.server.gate.stage, "engaged")

    def test_the_attention_beat_edge_no_longer_welcomes(self):
        backs = []
        self.server.proactive = SimpleNamespace(back=backs.append, beat=lambda body: None)
        self.server.behavior = SimpleNamespace(edge=lambda kind, away_s: True)
        self.server.attention = SimpleNamespace(presence=lambda: ("active", 0.0), events=lambda kind: [],
                                                ingest=lambda body: None,
                                                blacklist=SimpleNamespace(scrub=lambda front: front))
        support.enable_plugins(self, "screen_awareness")
        body = {"ts": self.ts, "front": {"app": "Code"}, "mouse": None, "idle_s": 0.0, "edge": "unlock"}
        self.assertEqual(self.request("POST", "/context/attention", body), (200, {}))
        self.assertEqual(backs, [])

    def test_registry_quiet_is_the_stage_or_dnd(self):
        registry = self.server.registry
        self.beat()
        self.assertFalse(registry.quiet)
        self.beat(mic_active=True)
        self.assertTrue(registry.quiet)
        self.beat()
        self.assertFalse(registry.quiet)
        self.beat(edge="lock")
        self.assertTrue(registry.quiet)
        self.beat(edge="unlock")
        self.assertFalse(registry.quiet)
        self.assertEqual(self.request("PUT", "/observation/quiet", {"until": self.ts + 600})[0], 200)
        self.assertTrue(registry.quiet)
        self.request("PUT", "/observation/quiet", {"until": None})
        self.assertFalse(registry.quiet)

    def test_spatial_and_behavior_read_typing_meeting_and_the_absence(self):
        self.beat(idle_s=1)
        situation = self.server.spatial_situation()
        self.assertEqual((situation["typing"], situation["absence"]), (True, None))
        self.server.focus = SimpleNamespace(running=lambda: False)
        self.assertEqual({k: self.server.situation()[k] for k in ("meeting", "typing")}, {"meeting": False, "typing": True})
        self.beat(idle_s=3, camera_active=True)
        self.assertEqual({k: self.server.situation()[k] for k in ("meeting", "typing")}, {"meeting": True, "typing": False})
        self.beat(edge="lock")
        self.assertEqual(self.server.spatial_situation()["absence"], self.server.user_now.snapshot()["absence"])

    def test_behaviors_presence_is_user_nows(self):
        self.server.focus = SimpleNamespace(running=lambda: False)
        presence = lambda: tuple(self.server.situation()[k] for k in ("presence", "presence_s"))  # noqa: E731
        self.assertEqual(presence(), ("unknown", 0.0))
        self.beat(idle_s=1)
        self.assertEqual(presence(), ("active", 0.0))
        self.beat(5, idle_s=1)
        self.assertEqual(presence(), ("active", 5.0))
        self.beat(idle_s=1, edge="lock")  # the absence began at the last input
        self.assertEqual(presence(), ("afk", 1.0))
        self.beat(100)
        self.assertEqual(presence(), ("afk", 101.0))

    def test_the_focus_clock_counts_the_beats_user_now_finds_present(self):
        support.enable_plugins(self, "screen_awareness")
        self.server.attention = SimpleNamespace(ingest=lambda body: None, blacklist=SimpleNamespace(scrub=lambda front: front))
        self.server.focus.start(25)
        front = {"app": "Code", "category": "public.app-category.developer-tools"}

        def beats(n, idle_s, **fields):
            for _ in range(n):
                self.beat(idle_s=idle_s, **fields)
                body = {"ts": self.ts, "front": front, "mouse": None, "idle_s": idle_s, "locked": False, "asleep": False}
                self.assertEqual(self.request("POST", "/context/attention", body), (200, {}))

        counted = lambda: sum(self.server.focus.session["categories"].values())  # noqa: E731
        beats(4, 200, front_video=True)  # a video holds the user present without input
        self.assertEqual(counted(), 3.0)
        beats(1, 0, edge="lock")  # the second before it still goes to the last present beat
        beats(3, 0)
        self.assertEqual(counted(), 4.0)


class ServerTest(unittest.TestCase):
    def setUp(self):
        support.enable_plugins(self)
        broker = ApprovalBroker(hook_timeout=WINDOW + 0.5, margin=0.5)
        self.server = AgentdServer(("127.0.0.1", 0), HOOK, UI, broker=broker, events_token=EVENTS)
        self.port = self.server.server_port
        self.thread = support.serve_in_thread(self.server)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    request = support.request

    def hook(self, source, name, session="A", **extra):
        payload = {"hook_event_name": name, "session_id": session, "cwd": "/w", **extra}
        return self.request("POST", f"/hook/{source}", payload, token=HOOK)

    def wait_for_approval(self):
        for _ in range(100):
            _, data = self.request("GET", "/approvals")
            if data["approvals"]:
                return data["approvals"][0]
            time.sleep(0.01)
        self.fail("approval never appeared")

    def test_wrong_token_is_401(self):
        self.assertEqual(self.request("POST", "/hook/claude", {"hook_event_name": "Stop", "session_id": "A"},
                                      token="bad")[0], 401)
        self.assertEqual(self.request("POST", "/hook/codex", {"session_id": "A"}, token=None)[0], 401)
        self.assertEqual(self.request("GET", "/state", token=HOOK)[0], 401)
        self.assertEqual(self.request("GET", "/approvals", token="bad")[0], 401)
        self.assertEqual(self.request("POST", "/approvals/ab/decision",
                                      {"decision": "allow", "generation": 1}, token=HOOK)[0], 401)

    def test_a_refused_request_body_is_read_before_the_connection_closes(self):
        # A close with the body unread resets the connection; Windows then drops the reply the client has not read.
        body = json.dumps({"session_id": "A"}).encode()
        with socket.create_connection(("127.0.0.1", self.port), timeout=5) as client:
            client.sendall(b"POST /hook/codex HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer bad\r\n"
                           b"Content-Type: application/json\r\nContent-Length: %d\r\n\r\n" % len(body))
            reply = b""
            while not reply.endswith(b'{"error": "unauthorized"}'):
                reply += client.recv(4096)
            self.assertTrue(reply.startswith(b"HTTP/1.1 401 "))
            client.settimeout(0.2)
            with self.assertRaises(TimeoutError):  # no close yet: the server waits for the body it was told of
                client.recv(1)
            client.settimeout(5)
            client.sendall(body)
            self.assertEqual(client.recv(4096), b"")

    def test_events_token_reads_events_and_state_only(self):
        self.assertEqual(self.request("GET", "/state", token=EVENTS)[0], 200)
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("GET", "/events", headers={"Authorization": f"Bearer {EVENTS}"})
        response = conn.getresponse()
        self.assertEqual(response.status, 200)
        conn.close()
        for method, path, body in (("GET", "/approvals", None), ("GET", "/feed", None),
                                   ("POST", "/approvals/ab/decision", {"decision": "allow", "generation": 1}),
                                   ("POST", "/say", {"text": "停下"}),
                                   ("POST", "/hook/claude", {"hook_event_name": "Stop", "session_id": "A"})):
            self.assertEqual(self.request(method, path, body, token=EVENTS)[0], 401, path)

    def test_state_carries_the_observation_controls(self):
        status, state = self.request("GET", "/state", token=EVENTS)
        self.assertEqual((status, state["observation"]),
                         (200, {"paused_until": None, "quiet_until": None, "meeting": False, "off": False}))

    def test_get_character_state_has_labels_and_causes_and_no_token_is_401(self):
        self.assertEqual(self.request("GET", "/character/state"), (503, {"error": "no_state"}))
        state = self.server.state = SayTest.her_state(self, 12)
        state.on_event("dispatch_done")
        for token in (None, "bad", HOOK):
            self.assertEqual(self.request("GET", "/character/state", token=token)[0], 401, token)
        for token in (UI, EVENTS):
            status, body = self.request("GET", "/character/state", token=token)
            self.assertEqual(status, 200)
            self.assertEqual(set(body), {"character_id", "energy", "valence", "engagement", "activity", "labels",
                                         "causes", "affects_behavior"})
            self.assertEqual((body["character_id"], body["energy"], body["valence"], body["affects_behavior"]),
                             ("aster", 0.8, 0.35, True))
            self.assertEqual(body["labels"], {"energy": "lively", "mood": "steady", "engagement": "idle"})
            [cause] = body["causes"]
            self.assertEqual((cause["attr"], cause["cause"], cause["delta"]), ("valence", "dispatch_done", 0.15))
            datetime.datetime.fromisoformat(cause["at"])

    def test_get_character_state_history_reads_her_log_oldest_first(self):
        self.assertEqual(self.request("GET", "/character/state/history"), (503, {"error": "no_state"}))
        state = self.server.state = SayTest.her_state(self, 12)
        state.on_event("dispatch_done")
        at = state.snapshot()["causes"][-1]["at"]
        for token in (None, "bad", HOOK, EVENTS):
            self.assertEqual(self.request("GET", "/character/state/history", token=token)[0], 401, token)
        status, body = self.request("GET", "/character/state/history")
        self.assertEqual(status, 200)
        [item] = body["items"]
        self.assertEqual((item["at"], item["cause"], round(item["valence"], 2)), (at, "dispatch_done", 0.35))
        self.assertEqual(self.request("GET", f"/character/state/history?since={at + 1}&limit=5"), (200, {"items": []}))
        for query in ("since=x", "limit=0", "limit=x", "limit=5001"):
            self.assertEqual(self.request("GET", f"/character/state/history?{query}")[0], 400, query)

    def test_delete_character_state_starts_her_afresh(self):
        state = self.server.state = SayTest.her_state(self, 12)
        state.on_event("dispatch_done")
        state.flush()
        rows = lambda: state.db.execute("SELECT COUNT(*) FROM character_state").fetchone()[0]  # noqa: E731
        self.assertEqual(rows(), 1)
        self.assertEqual(self.request("DELETE", "/character/state", token=EVENTS)[0], 401)
        status, body = self.request("DELETE", "/character/state", {"character_id": "aster"})
        self.assertEqual((status, body["character_id"], body["valence"], body["causes"]), (200, "aster", 0.2, []))
        self.assertEqual(rows(), 0)
        self.server.state.flush()  # what is written from here has nothing from before
        self.assertEqual(state.db.execute("SELECT valence, causes FROM character_state").fetchall(), [(0.2, "[]")])

    def test_character_reset_requires_identity_and_refuses_a_stale_card(self):
        self.server.character = "aster"
        state = self.server.state = SayTest.her_state(self, 12)
        state.on_event("dispatch_done")
        for body in (None, {}, {"character_id": ""}, {"character_id": 3}):
            self.assertEqual(self.request("DELETE", "/character/state", body)[0], 400)
        # The UI read aster, then a different character committed before its DELETE arrived.
        self.assertEqual(self.request("GET", "/character/state")[1]["character_id"], "aster")
        self.server.set_character("birch")
        state.on_event("dispatch_done")
        before = state.snapshot()
        status, reply = self.request("DELETE", "/character/state", {"character_id": "aster"})
        self.assertEqual((status, reply), (409, {"error": "character_changed", "character_id": "birch"}))
        self.assertEqual(state.snapshot(), before)
        self.server.set_character("aster")
        self.assertEqual(state.snapshot()["causes"][-1]["cause"], "dispatch_done")

    def test_switch_off_keeps_recording_but_neutralises_weights(self):
        state = self.server.state = SayTest.her_state(self, 1, walks=2)  # 01:00, energy 0.2: tired
        state.on_event("dispatch_done")
        state.on_event("dispatch_done")  # valence 0.5: well above the baseline
        view, kinds = self.server.state_view, list(spatial.TICK_TYPES)
        neutral = ([1.0] * len(kinds), 1.0, 1.0, (0.4, 0.7), 1.0, "normal")
        read = lambda: (view.weights(kinds), view.tick_scale(), view.walk_scale(), view.intensity_range(),  # noqa: E731
                        view.comment_scale(), view.mood_label("normal"))
        self.assertTrue(all(a != b for a, b in zip(read(), neutral)), read())
        self.assertIn("You yourself", self.server.context())
        for body in ({}, {"affects_behavior": 1}, {"affects_behavior": False, "x": 1}):
            self.assertEqual(self.request("PUT", "/character/state/switch", body), (400, {"error": "invalid_payload"}))
        off = {"affects_behavior": False}
        self.assertEqual(self.request("PUT", "/character/state/switch", off, token=EVENTS)[0], 401)
        self.assertEqual(self.request("PUT", "/character/state/switch", off), (200, off))
        self.assertEqual(read(), neutral)
        self.assertEqual((view.summary(self.server.user_title()), view.labels()), ("", None))
        self.assertGreaterEqual(view.snapshot()["energy"], character_state.TIRED)  # Behavior's yawn and sleep
        self.assertNotIn("You yourself", self.server.context())
        view.on_event("behavior_sent", behavior_id="w9", type="short_walk", priority=1)  # still recorded
        view.on_event("behavior_ended", behavior_id="w9", type="short_walk", outcome="done")
        _, body = self.request("GET", "/character/state")
        self.assertEqual((body["affects_behavior"], body["energy"], body["causes"][-1]["cause"]),
                         (False, 0.15, "short_walk"))
        self.assertEqual(self.request("PUT", "/character/state/switch", {"affects_behavior": True})[0], 200)
        self.assertTrue(all(a != b for a, b in zip(read(), neutral)), read())

    def test_the_focus_session_finishing_is_a_session_done_for_her(self):
        state = self.server.state = SayTest.her_state(self, 12)
        causes = lambda: [c["cause"] for c in state.snapshot()["causes"]]  # noqa: E731
        self.assertEqual(self.hook("claude", "UserPromptSubmit", prompt="hi"), (200, {}))
        self.assertEqual(causes(), [])
        self.assertEqual(self.hook("claude", "Stop"), (200, {}))
        self.assertEqual(causes(), ["session_done"])
        self.assertEqual(self.hook("codex", "UserPromptSubmit", session="B", prompt="hi"), (200, {}))
        self.assertEqual(causes(), ["session_done"])  # a session that starts thinking is no result

    def test_the_focus_session_failing_is_a_session_error_for_her(self):
        state = self.server.state = SayTest.her_state(self, 12)
        causes = lambda: [c["cause"] for c in state.snapshot()["causes"]]  # noqa: E731
        self.assertEqual(self.hook("claude", "UserPromptSubmit", prompt="hi"), (200, {}))
        self.assertEqual(self.hook("claude", "StopFailure"), (200, {}))
        self.assertEqual(causes(), ["session_error"])

    def test_the_focus_session_ending_reaches_her_react(self):
        events = []
        self.server.behavior = type("B", (), {"event": lambda _, kind: events.append(kind)})()
        self.assertEqual(self.hook("claude", "UserPromptSubmit", prompt="hi"), (200, {}))
        self.assertEqual(self.hook("claude", "StopFailure"), (200, {}))
        self.assertEqual(events, ["session_error"])

    def test_observation_events_return_immediately_and_update_state(self):
        start = time.monotonic()
        self.assertEqual(self.hook("claude", "UserPromptSubmit", prompt="hi"), (200, {}))
        self.assertEqual(self.hook("codex", "PreToolUse", session="B", tool_name="Bash"), (200, {}))
        self.assertLess(time.monotonic() - start, WINDOW)
        status, state = self.request("GET", "/state")
        self.assertEqual(status, 200)
        states = {s["display_session"]: s["state"] for s in state["sessions"]}
        self.assertEqual(states, {"claude:A": "thinking", "codex:B": "running_tool"})
        self.assertEqual(state["focus"]["display_session"], "codex:B")
        self.assertEqual(self.request("POST", "/hook/claude", {"hook_event_name": "Stop"}, token=HOOK)[0], 400)

    def test_permission_request_without_decision_returns_no_decision(self):
        start = time.monotonic()
        status, body = self.hook("claude", "PermissionRequest", tool_name="Bash", tool_input={})
        self.assertGreaterEqual(time.monotonic() - start, WINDOW - 0.01)
        self.assertEqual((status, body), (200, {}))

    def test_permission_request_with_decision_returns_allow(self):
        self.server.broker.window = 5.0
        result = {}
        hook = threading.Thread(target=lambda: result.update(
            zip(("status", "body"), self.hook("claude", "PermissionRequest", tool_name="Write",
                                              tool_input={"file_path": "/w/a.txt", "content": "x"}))))
        hook.start()
        card = self.wait_for_approval()
        self.assertEqual(card["display_session"], "claude:A")
        self.assertEqual(card["tool_summary"], "/w/a.txt")
        _, state = self.request("GET", "/state")
        self.assertEqual(state["focus"]["state"], "awaiting_approval")
        decision = {"decision": "allow", "generation": card["generation"]}
        self.assertEqual(self.request("POST", f"/approvals/{card['request_id']}/decision", decision),
                         (200, {"ok": True}))
        hook.join(5)
        self.assertEqual(result["status"], 200)
        self.assertEqual(result["body"], {"hookSpecificOutput": {
            "hookEventName": "PermissionRequest", "decision": {"behavior": "allow"}}})
        status, body = self.request("POST", f"/approvals/{card['request_id']}/decision", decision)
        self.assertEqual((status, body["error"]), (409, "already_decided"))
        status, body = self.request("POST", "/approvals/abcd/decision", decision)
        self.assertEqual(status, 404)

    def test_shutdown_refuses_new_work_retires_cards_and_keeps_reads(self):
        self.server.broker.window = 5.0
        closing, release, closed = threading.Event(), threading.Event(), []

        class Sessions:  # holds shutdown_cleanly in its sessions step
            sessions = {}

            def native_ids(self):
                return {}

            def reap(self):
                pass

            def close(self, timeout):
                closed.append(timeout)
                closing.set()
                release.wait(5)

        self.server.sessions = Sessions()
        result = {}
        hook = threading.Thread(target=lambda: result.update(
            zip(("status", "body"), self.hook("claude", "PermissionRequest", tool_name="Bash", tool_input={}))))
        hook.start()
        card = self.wait_for_approval()
        stopper = threading.Thread(target=self.server.shutdown_cleanly, args=(3.0,))
        stopper.start()
        self.assertTrue(closing.wait(2))
        hook.join(2)
        self.assertEqual((result["status"], result["body"]), (200, {}))
        self.assertEqual(self.server.broker._requests[card["request_id"]].status, "cancelled")
        refused = (503, {"error": "shutting_down"})
        self.assertEqual(self.request("POST", "/sessions", {"target": "claude", "cwd": "/", "prompt": "x"}), refused)
        self.assertEqual(self.request("POST", "/sessions/own:ab/messages", {"text": "x"}), refused)
        self.assertEqual(self.request("POST", "/sessions/own:ab/interrupt"), refused)
        self.assertEqual(self.request("POST", "/say", {"text": "你好"}), refused)
        self.assertEqual(self.hook("claude", "PermissionRequest", tool_name="Bash", tool_input={}), refused)
        self.assertEqual(self.request("GET", "/state")[0], 200)
        self.assertEqual(self.request("GET", "/approvals"), (200, {"approvals": []}))
        release.set()
        stopper.join(5)
        self.assertFalse(stopper.is_alive())
        self.server.shutdown_cleanly()
        self.assertEqual(closed, [3.0])

    def test_shutdown_writes_her_state(self):
        tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "agentd.sqlite"
        db = open_store(path)
        self.addCleanup(db.close)
        state = self.server.state = CharacterState(db, lambda cid: None, clock=lambda: 1_800_000_000.0)
        state.use("aster")
        state.on_event("dispatch_done")  # the first change is written at once
        state.on_event("session_done")  # within 60 s of it: not yet
        reader = open_store(path)
        self.addCleanup(reader.close)
        valence = lambda: reader.execute(  # noqa: E731
            "SELECT valence FROM character_state WHERE character_id = 'aster'").fetchone()[0]
        self.assertAlmostEqual(valence(), 0.35)
        self.server.shutdown_cleanly()
        self.assertAlmostEqual(valence(), 0.45)

    def test_approval_card_listed_during_quiet(self):
        self.hook("claude", "PermissionRequest", tool_name="Bash")
        self.server.set_quiet_until(time.time() + 600)
        self.assertTrue(self.server.gate.meeting_manual)
        self.server.broker.window = 5.0
        result = {}
        hook = threading.Thread(target=lambda: result.update(
            zip(("status", "body"), self.hook("claude", "PermissionRequest", tool_name="Bash"))))
        hook.start()
        card = self.wait_for_approval()
        listed = self.request("GET", "/approvals")[1]["approvals"]
        self.assertEqual([item["request_id"] for item in listed], [card["request_id"]])
        deny = {"decision": "deny", "generation": card["generation"]}
        self.assertEqual(self.request("POST", f"/approvals/{card['request_id']}/decision", deny)[0], 200)
        hook.join(5)

    def test_stale_card_cannot_approve_next_request(self):
        self.hook("claude", "PermissionRequest", tool_name="Bash")
        _, data = self.request("GET", "/approvals")
        self.assertEqual(data["approvals"], [])
        self.server.broker.window = 5.0
        result = {}
        hook = threading.Thread(target=lambda: result.update(
            zip(("status", "body"), self.hook("claude", "PermissionRequest", tool_name="Bash"))))
        hook.start()
        card = self.wait_for_approval()
        stale = {"decision": "allow", "generation": card["generation"] - 1}
        status, body = self.request("POST", f"/approvals/{card['request_id']}/decision", stale)
        self.assertEqual((status, body["error"]), (409, "generation_mismatch"))
        deny = {"decision": "deny", "generation": card["generation"]}
        self.assertEqual(self.request("POST", f"/approvals/{card['request_id']}/decision", deny)[0], 200)
        hook.join(5)
        self.assertEqual(result["body"]["hookSpecificOutput"]["decision"]["behavior"], "deny")

    def test_deny_with_a_message_tells_the_tool_why(self):
        hook, result, card = self.ask_in_background("rm -rf build/", None)
        deny = {"decision": "deny", "generation": card["generation"], "message": "  " + "x" * 600 + " "}
        self.assertEqual(self.request("POST", f"/approvals/{card['request_id']}/decision", deny), (200, {"ok": True}))
        hook.join(5)
        self.assertEqual(result["body"]["hookSpecificOutput"]["decision"], {
            "behavior": "deny", "message": DENY_MESSAGE + " Reason from the user: " + "x" * 500})

    def test_deny_with_a_blank_message_says_the_plain_denial(self):
        hook, result, card = self.ask_in_background("rm -rf build/", None)
        deny = {"decision": "deny", "generation": card["generation"], "message": "  "}
        self.assertEqual(self.request("POST", f"/approvals/{card['request_id']}/decision", deny), (200, {"ok": True}))
        hook.join(5)
        self.assertEqual(result["body"]["hookSpecificOutput"]["decision"], {"behavior": "deny", "message": DENY_MESSAGE})

    def test_an_unknown_key_is_refused_and_the_card_stays_pending(self):
        hook, result, card = self.ask_in_background("rm -rf build/", None)
        deny = {"decision": "deny", "generation": card["generation"], "reason": "build/ is mine"}
        self.assertEqual(self.request("POST", f"/approvals/{card['request_id']}/decision", deny),
                         (400, {"error": "invalid_payload", "field": "reason"}))
        self.assertEqual(self.server.broker._requests[card["request_id"]].status, "pending")
        self.assertEqual(self.decide(card, "deny")[0], 200)
        hook.join(5)

    def test_a_message_that_is_not_text_is_refused(self):
        hook, result, card = self.ask_in_background("rm -rf build/", None)
        deny = {"decision": "deny", "generation": card["generation"], "message": 3}
        self.assertEqual(self.request("POST", f"/approvals/{card['request_id']}/decision", deny),
                         (400, {"error": "invalid_payload"}))
        self.assertEqual(self.server.broker._requests[card["request_id"]].status, "pending")
        self.assertEqual(self.decide(card, "deny")[0], 200)
        hook.join(5)

    def test_hook_card_carries_the_hook_cwd(self):
        self.server.broker.window = 5.0
        hook = threading.Thread(target=lambda: self.request("POST", "/hook/claude", {
            "hook_event_name": "PermissionRequest", "session_id": "A", "cwd": "/tmp/proj",
            "tool_name": "Bash", "tool_input": {"command": "rm -rf build/"}}, token=HOOK))
        hook.start()
        card = self.wait_for_approval()
        self.assertEqual(self.decide(card, "deny")[0], 200)
        hook.join(5)
        self.assertEqual(card["cwd"], "/tmp/proj")

    def ask_in_background(self, command, suggestions):
        self.server.broker.window = 5.0
        result = {}
        hook = threading.Thread(target=lambda: result.update(zip(("status", "body"), self.hook(
            "claude", "PermissionRequest", tool_name="Bash", tool_input={"command": command},
            permission_suggestions=suggestions))))
        hook.start()
        return hook, result, self.wait_for_approval()

    def decide(self, card, decision):
        return self.request("POST", f"/approvals/{card['request_id']}/decision",
                            {"decision": decision, "generation": card["generation"]})

    def test_allow_for_the_session_returns_session_rules(self):
        rule = {"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "npm test"}], "behavior": "allow",
                "destination": "localSettings"}
        hook, result, card = self.ask_in_background("npm test", [rule])
        self.assertEqual(card["options"], ["allow", "allow_session", "deny"])
        self.assertEqual(card["session_scope"], {"kind": "rule", "detail": "Bash(npm test)"})
        self.assertEqual(self.decide(card, "allow_session"), (200, {"ok": True}))
        hook.join(5)
        self.assertEqual(result["body"], {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {
            "behavior": "allow", "updatedPermissions": [{**rule, "destination": "session"}]}}})

    def test_accept_edits_suggestion_offers_all_edits(self):
        edits = {"type": "setMode", "mode": "acceptEdits", "destination": "session"}
        hook, result, card = self.ask_in_background("mkdir out", [edits])
        self.assertEqual(card["session_scope"], {"kind": "all_edits", "detail": None})
        self.assertEqual(self.decide(card, "deny")[0], 200)
        hook.join(5)

    def test_accept_edits_card_lists_the_rules_and_directories_granted_with_it(self):
        edits = {"type": "setMode", "mode": "acceptEdits", "destination": "session"}
        rule = {"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "rm:*"}], "behavior": "allow",
                "destination": "localSettings"}
        other = {"type": "addDirectories", "directories": ["/Users/me/other"], "destination": "session"}
        hook, result, card = self.ask_in_background("mkdir out", [edits, rule, other])
        self.assertEqual(card["session_scope"], {"kind": "all_edits", "detail": "Bash(rm:*); /Users/me/other"})
        self.assertEqual(self.decide(card, "allow_session"), (200, {"ok": True}))
        hook.join(5)
        self.assertEqual(result["body"]["hookSpecificOutput"]["decision"]["updatedPermissions"],
                         [edits, {**rule, "destination": "session"}, other])

    def test_bypass_suggestion_offers_no_session_choice(self):
        bypass = {"type": "setMode", "mode": "bypassPermissions", "destination": "session"}
        hook, result, card = self.ask_in_background("npm test", [bypass])
        self.assertEqual((card["options"], card["session_scope"]), (["allow", "deny"], None))
        self.assertEqual(self.decide(card, "allow_session"), (400, {"ok": False, "error": "scope_unavailable"}))
        self.assertEqual(self.decide(card, "deny")[0], 200)
        hook.join(5)

    def test_dangerous_command_is_marked_and_may_allow_for_the_session(self):
        rule = {"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "git push --force"}],
                "behavior": "allow", "destination": "localSettings"}
        hook, result, card = self.ask_in_background("git push --force", [rule])
        self.assertEqual((card["dangerous"], card["options"]), (True, ["allow", "allow_session", "deny"]))
        self.assertEqual(self.decide(card, "yes"), (400, {"ok": False, "error": "invalid_decision"}))
        status, body = self.request("POST", f"/approvals/{card['request_id']}/decision",
                                    {"decision": "allow", "generation": card["generation"], "mode": "read_only"})
        self.assertEqual((status, body["error"]), (400, "invalid_mode"))
        self.assertEqual(self.decide(card, "allow"), (200, {"ok": True}))
        hook.join(5)
        self.assertEqual(result["body"]["hookSpecificOutput"]["decision"], {"behavior": "allow"})

    def test_danger_past_the_clipped_summary_is_still_judged(self):
        tail = "; rm -rf ~"
        command = "echo " + "a" * (2500 - len("echo ") - len(tail)) + tail
        hook, result, card = self.ask_in_background(command, [])
        self.assertNotIn(tail, card["tool_summary"])
        self.assertEqual((card["dangerous"], card["options"]), (True, ["allow", "deny"]))
        self.assertEqual(self.decide(card, "deny")[0], 200)
        hook.join(5)

    def test_post_tool_use_retires_card_answered_natively(self):
        self.server.broker.window = 4.0
        command = {"command": "echo hi"}
        result = {}
        start = time.monotonic()
        hook = threading.Thread(target=lambda: result.update(zip(("status", "body"), self.hook(
            "claude", "PermissionRequest", tool_name="Bash", tool_input=command, prompt_id="P"))))
        hook.start()
        self.wait_for_approval()
        self.assertEqual(self.hook("claude", "PostToolUse", tool_name="Bash", tool_input=command,
                                   tool_use_id="t1", prompt_id="P", tool_response={}), (200, {}))
        hook.join(5)
        self.assertLess(time.monotonic() - start, 2.0)
        self.assertEqual(result, {"status": 200, "body": {}})
        self.assertEqual(self.request("GET", "/approvals")[1], {"approvals": []})
        _, state = self.request("GET", "/state")
        self.assertNotEqual(state["sessions"][0]["state"], "awaiting_approval")

    def test_closed_hook_connection_abandons_card(self):
        self.server.broker.window = 4.0
        body = json.dumps({"hook_event_name": "PermissionRequest", "session_id": "A", "cwd": "/w",
                           "tool_name": "Bash", "tool_input": {}}).encode()
        head = (f"POST /hook/claude HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {HOOK}\r\n"
                f"Content-Type: application/json\r\nContent-Length: {len(body)}\r\n\r\n").encode()
        sock = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        sock.sendall(head + body)
        self.wait_for_approval()
        sock.close()
        start = time.monotonic()
        while self.request("GET", "/approvals")[1]["approvals"] and time.monotonic() - start < 1.0:
            time.sleep(0.02)
        self.assertEqual(self.request("GET", "/approvals")[1], {"approvals": []})
        # Claude closes the hook when the user denies natively, then waits for input.
        self.assertEqual(self.request("GET", "/state")[1]["sessions"][0]["state"], "awaiting_input")

    def test_codex_permission_request_is_observed_not_held(self):
        self.server.broker.window = 5.0
        ask = dict(session="B", tool_name="Bash", tool_input={"command": "ls"}, turn_id="T")
        start = time.monotonic()
        status, body = self.hook("codex", "PermissionRequest", **ask)
        self.assertLess(time.monotonic() - start, 0.5)
        self.assertEqual((status, body), (200, {}))
        self.assertEqual(self.request("GET", "/approvals")[1], {"approvals": []})
        session = self.request("GET", "/state")[1]["sessions"][0]
        self.assertEqual((session["state"], session["pending_approvals"]), ("awaiting_approval", []))
        self.hook("codex", "PostToolUse", **ask)
        time.sleep(0.3)
        self.assertEqual(self.request("GET", "/state")[1]["sessions"][0]["state"], "thinking")

    def test_observed_claude_permission_request_is_not_held(self):
        self.server.broker.window = 5.0
        body = json.dumps({"hook_event_name": "PermissionRequest", "session_id": "A", "cwd": "/w",
                           "tool_name": "Bash", "tool_input": {"command": "ls"}}).encode()
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        start = time.monotonic()
        conn.request("POST", "/hook/claude", body, {"Authorization": f"Bearer {HOOK}", "X-Agentd-Observe": "1",
                                                    "Content-Type": "application/json"})
        response = conn.getresponse()
        self.assertEqual((response.status, json.loads(response.read())), (200, {}))
        conn.close()
        self.assertLess(time.monotonic() - start, 0.5)
        self.assertEqual(self.server.broker._requests, {})
        session = self.request("GET", "/state")[1]["sessions"][0]
        self.assertEqual((session["display_session"], session["state"], session["pending_approvals"]),
                         ("claude:A", "awaiting_approval", []))

    @unittest.skipIf(sys.platform == "win32", "timing: flaky on Windows under the gate's parallel load (passes alone)")
    def test_forwarder_observe_flag_reaches_agentd(self):
        self.server.broker.window = 5.0
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32") as tmp:
            token_file = os.path.join(tmp, "hook.token")
            write_secret(token_file, HOOK + "\n")
            argv = ["--url", f"http://127.0.0.1:{self.port}", "--token-file", token_file, "--endpoint",
                    "/hook/claude", "--observe"]
            payload = {"hook_event_name": "PermissionRequest", "session_id": "A", "tool_name": "Bash"}
            start = time.monotonic()
            self.assertEqual(codex_hook_forward.main(argv, io.BytesIO(json.dumps(payload).encode())), 0)
            self.assertLess(time.monotonic() - start, 0.5)
        self.assertEqual(self.request("GET", "/approvals")[1], {"approvals": []})
        self.assertEqual(self.request("GET", "/state")[1]["sessions"][0]["state"], "awaiting_approval")

    @unittest.skipIf(sys.platform == "win32", "timing: flaky on Windows under the gate's parallel load (passes alone)")
    def test_codex_forwarder_round_trip(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32") as tmp:
            token_file = os.path.join(tmp, "hook.token")
            write_secret(token_file, HOOK + "\n")
            self.assertEqual(read_token(token_file), HOOK)
            argv = ["--url", f"http://127.0.0.1:{self.port}", "--token-file", token_file]

            def run(payload):
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    code = codex_hook_forward.main(argv, io.BytesIO(json.dumps(payload).encode()))
                return code, out.getvalue()

            self.assertEqual(run({"hook_event_name": "UserPromptSubmit", "session_id": "B"}), (0, ""))
            self.server.broker.window = 5.0
            self.assertEqual(run({"hook_event_name": "PermissionRequest", "session_id": "B",
                                  "tool_name": "apply_patch"}), (0, ""))
            session = self.request("GET", "/state")[1]["sessions"][0]
            self.assertEqual((session["display_session"], session["state"]),
                             ("codex:B", "awaiting_approval"))
            # Wrong token or dead server: print nothing so Codex asks natively.
            write_secret(token_file, "bad\n")
            self.assertEqual(run({"hook_event_name": "PermissionRequest", "session_id": "B"}), (0, ""))

    def test_events_stream_performance_intents(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("GET", "/events", headers={"Authorization": f"Bearer {UI}"})
        response = conn.getresponse()
        self.assertEqual(response.status, 200)
        self.hook("claude", "UserPromptSubmit")
        intents, event = [], None
        while not intents:
            line = response.fp.readline().decode()
            if line.startswith("event: "):
                event = line[7:].strip()
            elif line.startswith("data: ") and event == "intent":  # after the idle snapshot taken at connect
                intents.append(json.loads(line[6:]))
        conn.close()
        self.assertEqual([(i["display_session"], i["state"], i["intent"]) for i in intents],
                         [("claude:A", "thinking", "think")])
        self.assertEqual(set(intents[0]), {"epoch", "seq", "display_session", "state", "tool_category",
            "intent", "emotion", "line_id", "priority", "expires_at_ms", "activity", "mood", "quiet", "turn_generation"})
        self.assertEqual((intents[0]["activity"], intents[0]["mood"]), (None, None))
        self.assertEqual(self.request("GET", "/events", token="bad")[0], 401)

    def test_events_snapshot_is_the_current_intent_with_the_turn_generation(self):
        self.hook("claude", "UserPromptSubmit")
        self.server.turn_generation = 4
        self.server.registry.publish_event("speech_cancelled", {"speech_id": None})
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("GET", "/events", headers={"Authorization": f"Bearer {UI}"})
        response = conn.getresponse()
        line = response.fp.readline().decode()
        data = response.fp.readline().decode()
        conn.close()
        self.assertEqual(line, "event: snapshot\n")
        snapshot = json.loads(data[len("data: "):])
        self.assertEqual((snapshot["display_session"], snapshot["state"], snapshot["turn_generation"]),
                         ("claude:A", "thinking", 4))

    def test_events_resume_with_numeric_ids_and_no_stream_frame(self):
        self.hook("claude", "UserPromptSubmit")
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("GET", "/events?after=0", headers={"Authorization": f"Bearer {UI}"})
        response = conn.getresponse()
        first = response.fp.readline().decode()
        conn.close()
        self.assertEqual(first, "id: 1\n")


class ArgsTest(unittest.TestCase):
    def test_proactive_speech_is_on_by_default(self):
        args = parse_args([])
        self.assertTrue(args.proactive)  # the user turned the master switch on
        self.assertFalse(parse_args(["--no-proactive"]).proactive)
        # Control: the API share flags stay off by default.
        self.assertEqual((args.share_page_text, args.share_window_text, args.share_screenshots, args.share_typed_text),
                         (False, False, False, False))
        self.assertTrue(parse_args(["--share-typed-text"]).share_typed_text)

    def test_retired_cloud_summary_flag_is_rejected(self):
        self.assertFalse(hasattr(parse_args([]),'cloud_summary'))
        with self.assertRaises(SystemExit): parse_args(['--cloud-summary'])

    def test_outbound_masking_is_on_by_default(self):
        # Keys, emails and phones are masked unless the user turns it off in the control panel.
        self.assertTrue(parse_args([]).redact)
        self.assertFalse(parse_args(["--no-redact"]).redact)

    def test_mute_is_off_by_default(self):
        # Settings 只出字、不出声 reaches agentd as --mute at start.
        self.assertFalse(parse_args([]).mute)
        self.assertTrue(parse_args(["--mute"]).mute)
        self.assertFalse(parse_args(["--no-mute"]).mute)

    def test_break_reminder_minutes_reach_proactive(self):
        import daemon.main as agentd_main

        class Built(Exception):
            pass

        def proactive(*args, **kwargs):
            owner = args[3].__self__  # start_line: the server main built
            owner._stopped.set()
            owner.server_close()
            raise Built(kwargs.get("break_minutes"))

        for extra, minutes in (([], 50), (["--break-reminder-minutes", "60"], 60), (["--break-reminder-minutes", "-5"], 0)):
            with self.subTest(extra=extra), tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32") as tmp:
                argv = ["agentd", "--port", "48810", "--state-dir", tmp, "--ledger-root", tmp, "--no-exit-with-parent", "--plugin-on", "screen_awareness", *extra]
                with unittest.mock.patch.dict("infra.plugins.resolved"), unittest.mock.patch.object(sys, "argv", argv), \
                        unittest.mock.patch.object(agentd_main, "Proactive", proactive), \
                        self.assertRaises(Built) as built:
                    agentd_main.main()
                self.assertEqual(built.exception.args, (minutes,))

    def test_activity_reminders_are_proactive_by_default(self):
        import daemon.main as agentd_main

        class Built(Exception):
            pass

        def proactive(*args, **kwargs):
            owner = args[3].__self__
            owner._stopped.set()
            owner.server_close()
            raise Built(owner, kwargs)

        args = parse_args([])
        self.assertEqual((args.break_reminder_minutes, args.water_reminder_minutes, args.ritual_report_time),
                         (50, 90, "17:30"))
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32") as tmp:
            argv = ["agentd", "--port", "48810", "--state-dir", tmp, "--ledger-root", tmp, "--no-exit-with-parent", "--plugin-on", "screen_awareness",
                    "--water-reminder-minutes", "80", "--ritual-report-time", "18:05"]
            with unittest.mock.patch.dict("infra.plugins.resolved"), unittest.mock.patch.object(sys, "argv", argv), \
                    unittest.mock.patch.object(agentd_main, "Proactive", proactive), \
                    self.assertRaises(Built) as built:
                agentd_main.main()
            owner, kwargs = built.exception.args
            self.assertEqual((kwargs["deliver"], kwargs["water_minutes"]), ("speak", 80))
            self.assertNotIn("on_pending", kwargs)
            self.assertEqual(owner.rituals.report_time, (18, 5))
            owner.rituals.db.close()

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_tts_token_file_comes_from_the_flag_else_the_environment(self):
        from daemon.main import tts_token
        from infra.tokens import write_secret
        from tools.tts_token import DEFAULT_FILE
        self.assertIsNone(parse_args([]).tts_token_file)
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32") as tmp:
            path = Path(tmp) / "tts-token"
            with unittest.mock.patch.dict(os.environ, {"AAC_TTS_TOKEN_FILE": str(path)}):
                self.assertIsNone(tts_token(None))  # missing: requests go out bare and the TTS answers 401
                write_secret(path, "tok-1\n")
                self.assertEqual(tts_token(None), "tok-1")
                path.chmod(0o644)
                with self.assertRaises(SystemExit):
                    tts_token(None)
            with unittest.mock.patch.dict(os.environ, {"AAC_TTS_TOKEN_FILE": str(Path(tmp) / "absent")}):
                path.chmod(0o600)
                self.assertEqual(tts_token(str(path)), "tok-1")
            with unittest.mock.patch.dict(os.environ, {}, clear=True):
                stderr = io.StringIO()
                with contextlib.redirect_stderr(stderr):
                    self.assertIsNone(tts_token(None))  # no default path: the Companion passes --tts-token-file
                self.assertIn("--tts-token-file", stderr.getvalue())
        self.assertEqual(DEFAULT_FILE.name, "tts-token")

    def test_capture_judge_uses_local_rules_and_only_vision_uses_semantic_service(self):
        from daemon.main import build_capture
        from observation.capture import QUESTIONS
        from character.judge import RulesBackend
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32") as tmp:
            attention=AttentionStore(Path(tmp)/'a.sqlite',Blacklist(support.deny_blacklist(Path(tmp)/'blacklist.json')))
            db=open_store(Path(tmp)/'domain.sqlite');semantic=unittest.mock.Mock()
            capture=build_capture(Feed(),attention,semantic,tmp,True,True,budget_db=db)
            self.assertIsInstance(capture.judge.backend,RulesBackend)
            self.assertFalse(hasattr(capture.judge.backend,'service'))
            decision=capture.judge.ask({'text_chars':2000},QUESTIONS)
            self.assertEqual(decision['backend'],'rules')
            self.assertFalse(decision['answers'][0]['value'])
            semantic.run.assert_not_called()
            self.assertIs(capture.vision.service,semantic)
            self.assertIs(capture.budget.db,db)
            db.close();attention.close()


class FeedServerCase(unittest.TestCase):
    def setUp(self):
        support.enable_plugins(self)
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.day = Path(self.tmp.name) / "-Users-me-repo" / "2026-10-18"
        self.day.mkdir(parents=True)
        self.server = AgentdServer(("127.0.0.1", 0), HOOK, UI)
        self.server.character = "aster"  # these fixtures start as aster and switch to birch
        self.server.character_agent = KernelLines(self.server)
        self.thread = support.serve_in_thread(self.server)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)
        self.tmp.cleanup()

    def open_feed(self, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        conn.request("GET", "/feed", headers={"Authorization": f"Bearer {UI}", **(headers or {})})
        return conn, conn.getresponse()

    def next_event(self, response):
        """The next item past the `stream` frame each connect starts with."""
        while True:
            event = self.next_item(response)
            if event["event"] != "stream":
                return event

    def next_item(self, response):
        event = {}
        while True:
            line = response.fp.readline().decode()
            if line.startswith(("id: ", "event: ", "data: ")):
                key, _, value = line.rstrip("\n").partition(": ")
                event[key] = value
            elif line == "\n" and "data" in event:
                return event

    def append(self, name="gate.result", severity="WARN", **attributes):
        record = {"timestamp": "2026-10-18T05:00:00Z", "event_name": name,
                  "severity_text": severity, "attributes": {"session.id": "S1", **attributes}}
        with open(self.day / "S1.jsonl", "a", encoding="utf-8") as stream:
            stream.write(json.dumps(record) + "\n")


class SlowCursorFeed(Feed):
    """Reads of seq from server threads lag, widening the gap between response headers and the cursor."""

    @property
    def seq(self):
        if threading.current_thread() is not threading.main_thread():
            time.sleep(0.3)
        return self._seq

    @seq.setter
    def seq(self, value):
        self._seq = value


class FeedTest(FeedServerCase):
    def test_event_published_right_after_connect_is_delivered(self):
        self.server.feed = SlowCursorFeed()
        conn, response = self.open_feed()
        self.server.announce({"ts": 1.0, "level": "P0", "kind": "dispatch_done", "headline": "h",
                              "project": "/repo", "session_id": None, "detail": "d"})
        response.fp.raw._sock.settimeout(2)
        event = self.next_event(response)
        conn.close()
        self.assertEqual(json.loads(event["data"])["kind"], "dispatch_done")

    def announce_dispatch(self, kind):
        self.server.announce({"ts": 1.0, "level": "P1", "kind": kind, "headline": "h",
                              "project": "-Users-me-repo", "session_id": "S1", "detail": None})

    def test_harness_ledger_events_never_reach_the_feed_or_the_speech_budget(self):
        self.server.gate.enabled = True
        self.server.gate.quiet = (0, 0)
        for name, attributes in (("gate.result", {"outcome": "fail", "fail": 2}), ("gate.result", {"outcome": "pass"}),
                                 ("ci.result", {"outcome": "fail"}), ("ci.result", {"outcome": "pass"}),
                                 ("agent.end", {"state": "aborted", "agent.type": "worker"}),
                                 ("agent.denied", {"agent.type": "worker", "tool": "Bash rm"}),
                                 ("guard.block", {"rule.id": "secret-file"}),
                                 ("mmrun.end", {"status": "codex:FAILED"})):
            self.append(name, **attributes)
        self.append("mmrun.end", "INFO", status="codex:DONE")
        time.sleep(0.3)
        self.assertEqual([item for item in self.server.feed.since(0) if item["event"] == "announce"], [])
        self.assertEqual(self.server.gate._count, 0)

    def test_announcement_reaches_feed_with_its_gate_fields(self):
        conn, response = self.open_feed()
        self.assertEqual(response.status, 200)
        self.announce_dispatch("dispatch_failed")
        event = self.next_event(response)
        conn.close()
        self.assertEqual(event["event"], "announce")
        data = json.loads(event["data"])
        self.assertEqual(event["id"], f"{self.server.feed.stream_epoch}-{data['seq']}")
        self.assertEqual((data["kind"], data["level"], data["project"]),
                         ("dispatch_failed", "P1", "-Users-me-repo"))
        self.assertEqual(set(data), {"seq", "ts", "level", "kind", "headline", "project", "session_id",
                                     "detail", "origin", "speak", "gate", "state", "trace_id"})
        # With the gate's master switch off (Gate() default) the card still arrives, silently.
        self.assertEqual((data["speak"], data["gate"]), (False, "disabled"))

    def test_enabled_gate_lets_announce_speak_once_per_cooldown(self):
        self.server.gate.enabled = True
        self.server.gate.quiet = (0, 0)
        conn, response = self.open_feed()
        self.announce_dispatch("dispatch_failed")
        first = json.loads(self.next_event(response)["data"])
        self.announce_dispatch("dispatch_done")
        second = json.loads(self.next_event(response)["data"])
        conn.close()
        self.assertEqual((first["speak"], first["gate"]), (True, None))
        self.assertEqual((second["kind"], second["speak"], second["gate"]),
                         ("dispatch_done", False, "cross_cooldown"))

    def test_feed_resumes_after_last_event_id(self):
        conn, response = self.open_feed()
        self.announce_dispatch("dispatch_failed")
        first = self.next_event(response)
        conn.close()
        self.announce_dispatch("dispatch_done")
        conn, response = self.open_feed({"Last-Event-ID": first["id"]})
        second = self.next_event(response)
        conn.close()
        self.assertEqual(json.loads(second["data"])["kind"], "dispatch_done")
        epoch, _, seq = first["id"].rpartition("-")
        self.assertEqual(second["id"], f"{epoch}-{int(seq) + 1}")

    def test_feed_starts_with_the_stream_frame_and_ids_carry_its_epoch(self):
        feed = self.server.feed
        feed.publish("announce", {"kind": "old"})
        base = feed.seq
        conn, response = self.open_feed()
        feed.publish("announce", {"kind": "new"})
        stream = self.next_item(response)
        self.assertEqual(stream["event"], "stream")
        item = self.next_item(response)
        conn.close()
        self.assertNotIn("id", stream)
        self.assertEqual(json.loads(stream["data"]),
                         {"stream_epoch": feed.stream_epoch, "oldest_seq": 1, "latest_seq": base})
        self.assertEqual((item["event"], item["id"]), ("announce", f"{feed.stream_epoch}-{base + 1}"))

    def test_reconnect_past_the_buffer_gets_a_gap_then_every_held_item(self):
        feed = self.server.feed
        conn, response = self.open_feed()
        for i in range(3):
            feed.publish("announce", {"kind": f"early{i}"})
        first = self.next_event(response)
        conn.close()
        for i in range(300):
            feed.publish("announce", {"kind": f"late{i}"})
        conn, response = self.open_feed({"Last-Event-ID": first["id"]})
        gap = self.next_event(response)
        self.assertEqual(gap["event"], "gap")
        held = [self.next_event(response) for _ in range(256)]
        conn.close()
        cursor, latest = int(first["id"].rpartition("-")[2]), feed.seq
        self.assertEqual(json.loads(gap["data"]),
                         {"reason": "cursor_expired", "from": cursor + 1, "to": latest - 256,
                          "stream_epoch": feed.stream_epoch, "oldest_seq": latest - 255, "latest_seq": latest})
        self.assertEqual([i["id"] for i in held], [f"{feed.stream_epoch}-{s}" for s in range(latest - 255, latest + 1)])

    def test_cursor_of_another_process_resets_without_replay(self):
        feed = self.server.feed
        for i in range(3):
            feed.publish("announce", {"kind": f"early{i}"})
        base = feed.seq
        conn, response = self.open_feed({"Last-Event-ID": "0badc0de-1"})
        self.assertEqual(response.status, 200)
        feed.publish("announce", {"kind": "live"})
        reset, live = self.next_event(response), self.next_event(response)
        conn.close()
        self.assertEqual((reset["event"], json.loads(reset["data"])),
                         ("reset", {"reason": "other_process", "stream_epoch": feed.stream_epoch,
                                    "oldest_seq": 1, "latest_seq": base}))
        self.assertEqual(json.loads(live["data"])["kind"], "live")
        # A bare seq (an older client) is this process's.
        conn, response = self.open_feed({"Last-Event-ID": str(base - 1)})
        resumed = self.next_event(response)
        conn.close()
        self.assertEqual((resumed["id"], json.loads(resumed["data"])["kind"]),
                         (f"{feed.stream_epoch}-{base}", "early2"))
        # A cursor past the newest item (an older client's id from before a restart) cannot resume here.
        conn, response = self.open_feed({"Last-Event-ID": str(feed.seq + 500)})
        ahead = self.next_event(response)
        conn.close()
        self.assertEqual((ahead["event"], json.loads(ahead["data"])["reason"]), ("reset", "other_process"))
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        conn.request("GET", "/feed?after=nope", headers={"Authorization": f"Bearer {UI}"})
        response = conn.getresponse()
        body = json.loads(response.read())
        conn.close()
        self.assertEqual((response.status, body), (400, {"error": "invalid_cursor"}))

    def test_feed_needs_ui_token(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        conn.request("GET", "/feed", headers={"Authorization": f"Bearer {HOOK}"})
        response = conn.getresponse()
        response.read()
        self.assertEqual(response.status, 401)
        conn.close()


class FakeMouth:
    def __init__(self, chunks, delay=0.0, error=None):
        self.chunks, self.delay, self.error, self.calls = chunks, delay, error, []
        self.refreshed, self.binding = 0, None
        self.history = []

    def refresh_system(self, binding=None):
        self.refreshed, self.binding = self.refreshed + 1, binding

    def stream(self, text, context):
        self.calls.append((text, context))
        for chunk in self.chunks:
            time.sleep(self.delay)
            yield chunk
        if self.error:
            raise self.error


class MouthReply:
    """The server's mouth double as a character agent's reply: the line streams the mouth, and what the line sets
    on its reply (dispatch_allowed) reaches the mouth. Its stream gets material, the controller's own context for a
    line started with material, else the context the line assembled."""
    final_item_id = None

    def __init__(self, mouth, material):
        self.__dict__.update(_mouth=mouth, _material=material)

    def __getattr__(self, name):
        return getattr(self._mouth, name)

    def __setattr__(self, name, value):
        setattr(self._mouth, name, value)

    def stream(self, text, context):
        return self._mouth.stream(text, self._material or context)


class KernelLines:
    """A ready character agent whose turns stream the server's mouth double (MouthReply)."""
    jobs = None

    def __init__(self, server):
        self.server = server
        self._lock, self.runtime, self._runtime_config = threading.RLock(), None, None  # a conversation switch closes these
        self.settings = SimpleNamespace(snapshot=lambda: {"reply_language": "zh-Hans"})
        self.reply_language = ReplyLanguage()
        self.memory_pipeline = SimpleNamespace(tick=lambda now: None, clock=time.time)  # each attention beat ticks it

    def public(self, discover=False, *, wait=True):
        ready = {"ready": True, "error": None, "backend": "pi"}
        return {**ready, "routes": {"chat": ready, "background": ready}}

    def quick_status(self):
        return self.public()["routes"]["chat"]

    def busy(self):
        return False

    def prepare(self, line_id, text, cancel, generation, source, trace, wait=None, refused=None, **options):
        """A look's outcome reaches the reply's context as the controller's own context(...) gives it."""
        material = self.server._line_material.pop(cancel, None) or (
            self.server.context(text, wait, refused, []) if wait is not None or refused is not None else "")
        return MouthReply(self.server.mouth, material)

    def delivered(self, history):
        pass

    def cancel(self, *args, **kwargs):
        pass

    def forget(self):
        pass

    def data_counts(self):
        return {}

    def close(self):
        pass


class Script:
    """What a ScriptedMouth streams: chunks, delay seconds before each, then stop_reason and usage. calls: per
    stream, (text, context, the window it was sent). hold: an Event the chunks after the first wait for while the
    line is not cut, or None."""
    usage = SimpleNamespace(input_tokens=50, output_tokens=20)
    hold = None

    def __init__(self, chunks=(), delay=0.0, stop_reason="end_turn"):
        self.chunks, self.delay, self.stop_reason, self.calls = list(chunks), delay, stop_reason, []

    def past(self, index=-1):
        """The window the index-th stream was sent, then its text."""
        text, _, window = self.calls[index]
        return [m["content"] for turn in window for m in turn] + [text]


class ScriptedMouth(Mouth):
    """A Mouth (persona, lore, window) whose stream plays a Script; a finished stream adds its turn to the window.
    memory: a memory.Memory whose facts the line picks, as the character agent's reply carries them."""
    model = "scripted-model"

    def __init__(self, script, memory=None, **options):
        super().__init__(**options)
        self.script, self.dispatch_allowed, self.usage = script, lambda: True, None
        if memory is not None:
            self.pick_facts = memory.select

    def stream(self, text, context):
        self.script.calls.append((text, context, json.loads(json.dumps(self.history))))
        reply = []
        for chunk in list(self.script.chunks):
            time.sleep(self.script.delay)
            while reply and self.script.hold is not None and not self.script.hold.wait(0.01) \
                    and self.dispatch_allowed():
                pass
            if not self.dispatch_allowed():
                return
            reply.append(chunk)
            yield chunk
        if self.script.stop_reason != "end_turn":
            raise RuntimeError(f"stop_reason={self.script.stop_reason}")
        self.usage = self.script.usage
        self.history.append([{"role": "user", "content": text}, {"role": "assistant", "content": "".join(reply)}])
        del self.history[:-self.max_turns]


class FakeRelay:
    """Records what the server asks: ("speak", turn_id, text) per clause sent to TTS, ("cancel", reason, immediate)."""
    language, epoch = "zh", "1"

    def __init__(self):
        self.calls = []
        self.turns = {}  # utterance_id -> turn_id
        self.traces = {}  # utterance_id -> trace_id
        self.clauses = {}  # speech_id -> (utterance_id, clause index)

    def begin_utterance(self, turn_id, generation=None, trace_id=None, interrupt_policy="immediate"):
        utterance_id = f"u{len(self.turns) + 1}"
        self.turns[utterance_id] = turn_id
        self.traces[utterance_id] = trace_id
        return utterance_id

    def add_clause(self, utterance_id, text):
        self.calls.append(("speak", self.turns[utterance_id], text))
        speech_id = f"s{len(self.calls)}"
        self.clauses[speech_id] = (utterance_id, sum(u == utterance_id for u, _ in self.clauses.values()))
        return speech_id

    def clause_ref(self, speech_id):
        utterance_id, index = self.clauses[speech_id]
        return {"utterance_id": utterance_id, "clause_id": f"{utterance_id}.c{index}", "spoken_text_revision": 1}

    def end_utterance(self, utterance_id):
        pass

    def cancel_utterance(self, utterance_id, reason="client_cancel", immediate=False):
        self.calls.append(("cancel", reason, immediate))

    def cancel(self, reason="client_cancel", immediate=False):
        self.calls.append(("cancel", reason, immediate))

    def utterance(self, utterance_id):
        return ()

    def was_cut(self, utterance_id):
        return False

    def utterance_of(self, speech_id):
        return self.clauses.get(speech_id, (None,))[0]

    def clause_of(self, speech_id):
        return None

    def interrupted(self):
        return self.interrupted_turn

    def busy(self):
        return self.playing

    interrupted_turn = None
    playing = False


class SayTest(FeedServerCase):
    def setUp(self):
        super().setUp()
        self.server.mouth = FakeMouth(["[intent:gr", "eet]你来了", "，管理员。"])
        self.server.speech = FakeRelay()

    def test_finished_line_is_spoken_without_markers(self):
        conn, response = self.open_feed()
        line_id = self.say("你好")[1]["line_id"]
        self.lines_until_final(response)
        conn.close()
        for _ in range(100):
            if any(c[0] == "speak" for c in self.server.speech.calls):
                break
            time.sleep(0.01)
        self.assertEqual(self.server.speech.calls,
                         [("cancel", "superseded", False), ("speak", line_id, "你来了，管理员。")])

    def test_long_line_speaks_only_its_first_sentence(self):
        self.server.mouth = FakeMouth(["[intent:explain]先说结论：能合。", "理由" * 30 + "。"])
        line_id = self.say("详细解释一下")[1]["line_id"]
        for _ in range(100):
            if any(c[0] == "speak" for c in self.server.speech.calls):
                break
            time.sleep(0.01)
        self.assertEqual(self.server.speech.calls[-1], ("speak", line_id, "先说结论：能合。"))

    def test_each_line_she_voices_or_shows_is_one_line_for_her(self):
        state = self.server.state = self.her_state(12)
        said = lambda: [c["cause"] for c in state.snapshot()["causes"]].count("line")  # noqa: E731
        conn, response = self.open_feed()
        self.say("你好")
        self.lines_until_final(response)
        for _ in range(100):
            if said() and not self.server._live_lines:
                break
            time.sleep(0.01)
        self.assertEqual((said(), [c[0] for c in self.server.speech.calls].count("speak")), (1, 1))
        self.say("静音")  # from here shown as text only
        self.say("你好")
        self.lines_until_final(response)
        for _ in range(100):
            if said() == 2 and not self.server._live_lines:
                break
            time.sleep(0.01)
        conn.close()
        self.assertEqual((said(), [c[0] for c in self.server.speech.calls].count("speak")), (2, 1))

    def test_stop_and_mute_cancel_speech(self):
        self.say("停下")
        self.say("静音")
        self.assertEqual(self.server.speech.calls,
                         [("cancel", "client_cancel", True), ("cancel", "client_cancel", True)])
        conn, response = self.open_feed()
        self.say("你好")
        self.lines_until_final(response)
        conn.close()
        time.sleep(0.1)
        self.assertNotIn("speak", [c[0] for c in self.server.speech.calls])

    def test_a_line_names_the_utterance_that_voices_it(self):
        conn, response = self.open_feed()
        voiced_id = self.say("你好")[1]["line_id"]
        self.lines_until_final(response)
        conn.close()
        self.say("静音")  # from here shown as text only
        muted_id = self.say("你好")[1]["line_id"]
        lines = lambda: [i["data"] for i in self.server.feed.since(0) if i["event"] == "line"]  # noqa: E731
        for _ in range(200):
            if any(line["line_id"] == muted_id and line["final"] for line in lines()):
                break
            time.sleep(0.01)
        voiced = [line for line in lines() if line["line_id"] == voiced_id]
        # Its first delta goes out before a clause of it is cut and voiced; its final one always after.
        self.assertEqual((voiced[0]["utterance_id"], voiced[-1]["utterance_id"]), (None, "u1"))
        self.assertEqual({(line["speak"], line["utterance_id"]) for line in lines() if line["line_id"] == muted_id},
                         {(False, None)})

    def test_a_line_is_text_only_without_a_speech_relay(self):
        self.server.speech = None
        conn, response = self.open_feed()
        self.say("你好")
        events = self.lines_until_final(response)
        conn.close()
        self.assertEqual({(e["speak"], e["utterance_id"]) for e in events}, {(False, None)})

    def say(self, text, token=UI):
        return self.request("POST", "/say", {"text": text, "source": "text"}, token)

    def request(self, method, path, body=None, token=UI):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        conn.request(method, path, body=None if body is None else json.dumps(body).encode(),
                     headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
        response = conn.getresponse()
        data = json.loads(response.read() or b"null")
        conn.close()
        return response.status, data

    def lines_until_final(self, response):
        events = []
        while not events or not events[-1]["final"]:
            event = self.next_event(response)
            if event["event"] == "line":
                events.append(json.loads(event["data"]))
        return events

    def test_say_streams_a_line_with_its_intent(self):
        conn, response = self.open_feed()
        status, body = self.say("你好")
        self.assertEqual(status, 202)
        events = self.lines_until_final(response)
        conn.close()
        self.assertEqual({e["line_id"] for e in events}, {body["line_id"]})
        self.assertEqual("".join(e["text_delta"] for e in events), "你来了，管理员。")
        self.assertEqual([i for e in events for i in e["intents"]], ["greet"])
        self.assertEqual(set(events[0]), {"seq", "line_id", "text_delta", "intents", "points", "final",
                                          "speak", "cancelled", "error", "generation", "reason", "remembered",
                                          "run_id", "lane", "conversation_id", "utterance_id"})
        self.assertEqual({e["reason"] for e in events}, {None})  # only proactive lines carry a reason
        self.assertEqual((events[-1]["cancelled"], events[-1]["error"]), (False, None))
        text, context = self.server.mouth.calls[0]
        self.assertEqual(text, "你好")
        self.assertIn("Sessions: ", context)

    def test_an_accepted_line_is_announced_on_the_feed_before_anything_else_of_it(self):
        from traces.trace_store import TraceStore
        db = open_store(Path(self.tmp.name) / "trace.sqlite")
        self.addCleanup(db.close)
        self.server.trace = TraceStore(db, 1)
        conn, response = self.open_feed()
        with unittest.mock.patch.object(self.server.spatial, "wake") as wake:
            status, body = self.say("你好")
        self.assertEqual(status, 202)
        events = []
        while not events or not (events[-1]["event"] == "line" and events[-1]["data"]["final"]):
            event = self.next_event(response)
            events.append({"event": event["event"], "data": json.loads(event["data"])})
        conn.close()
        own = [e for e in events if e["data"].get("line_id") == body["line_id"]]
        self.assertEqual(own[0]["event"], "turn_accepted")
        accepted = own[0]["data"]
        self.assertEqual(set(accepted), {"seq", "line_id", "conversation_id", "source", "trace_id", "side"})
        self.assertEqual((accepted["source"], accepted["side"]), ("text", False))
        self.assertEqual(accepted["conversation_id"], own[-1]["data"]["conversation_id"])
        [row] = [r for r in self.server.trace.turns() if r["turn_id"] == body["line_id"]]
        self.assertEqual((body["trace_id"], accepted["trace_id"]), (row["trace_id"], row["trace_id"]))
        wake.assert_called_once_with()

    def test_context_names_the_pending_card_and_says_when_there_is_none(self):
        """What the card asks for is in the context; without a card nothing is there to make up."""
        self.assertIn("Pending approvals: none", self.server.context())
        request = self.server.broker.open("claude", "A", tool_name="Bash", tool_summary="npm test -- --ci")
        context = self.server.context()
        self.assertIn("claude:A wants Bash: npm test -- --ci", context)
        self.assertRegex(context, r"\d+ s left")
        self.assertNotIn("Pending approvals: none", context)

    def test_context_says_how_a_card_ended_and_whether_its_tool_then_failed(self):
        from test_registry import claude  # noqa: E402
        request = self.server.broker.open("claude", "A", tool_name="Bash", tool_summary="make all")
        self.server.broker.decide(request.request_id, request.generation, "allow")
        context = self.server.context()
        self.assertIn("Pending approvals: none", context)
        self.assertIn("make all", context)
        self.assertIn(": approved", context)
        self.assertNotIn("failed to run", context)
        self.server.registry.ingest(claude("PostToolUseFailure", time.time() + 1, tool_name="Bash"))
        self.assertIn("then failed to run", self.server.context())
        denied = self.server.broker.open("claude", "A", tool_name="Write", tool_summary="/tmp/x.txt")
        self.server.broker.decide(denied.request_id, denied.generation, "deny")
        self.assertIn(": denied", self.server.context())

    def test_context_says_the_last_line_was_interrupted(self):
        self.server.speech.interrupted_turn = "line-1"
        conn, response = self.open_feed()
        self.say("嗯？")
        self.lines_until_final(response)
        conn.close()
        self.assertIn("The user cut off your last line", self.server.mouth.calls[0][1])
        # Control: nothing interrupted, no such sentence.
        self.server.speech.interrupted_turn = None
        self.assertNotIn("cut off", self.server.context())

    def her_state(self, hour, walks=0):
        """A CharacterState at a local hour today, after `walks` finished short walks."""
        tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.addCleanup(tmp.cleanup)
        db = open_store(Path(tmp.name) / "agentd.sqlite")
        self.addCleanup(db.close)
        now = time.mktime(datetime.datetime.now().replace(hour=hour, minute=0, second=0, microsecond=0).timetuple())
        state = CharacterState(db, lambda cid: None, clock=lambda: now)
        state.use("aster")
        for i in range(walks):
            state.on_event("behavior_sent", behavior_id=f"w{i}", type="short_walk", priority=1)
            state.on_event("behavior_ended", behavior_id=f"w{i}", type="short_walk", outcome="done")
        return state

    def test_context_names_her_own_state_only_when_it_is_off_baseline(self):
        self.assertNotIn("You yourself", self.server.context())  # no state: as before
        self.server.state = self.her_state(12)
        self.assertNotIn("You yourself", self.server.context())  # a steady noon
        self.server.state = self.her_state(1, walks=2)
        self.assertAlmostEqual(self.server.state.snapshot()["energy"], 0.2)
        context = self.server.context()
        self.assertIn("You yourself", context)
        self.assertIn("sleepy", context)
        self.assertNotRegex(context, r"管理员[^.;]*(sleepy|tired|mood|happy|sad|low|good|angry|annoyed)")

    def test_the_summary_goes_through_the_outbound_guard(self):
        from brain.egress import EgressPolicy
        from brain.outbound import OutboundGuard
        import hashlib
        self.server.state = self.her_state(1, walks=2)
        summary = self.server.state.summary(self.server.user_title())
        windows, log = Path(self.tmp.name) / "windows.json", Path(self.tmp.name) / "guard.jsonl"
        for hashes, shown in (([hashlib.sha256("不匹配的合成语料".encode()).hexdigest()[:16]], True),
                              ([hashlib.sha256("youyour".encode()).hexdigest()[:16]], False)):
            with self.subTest(blocked=not shown):
                windows.write_text(json.dumps({"n": 7, "hashes": hashes}), encoding="utf-8")
                log.write_text("", encoding="utf-8")
                self.server.egress = EgressPolicy(guard=OutboundGuard(windows, log))
                context = self.server.context()
                (self.assertIn if shown else self.assertNotIn)(summary, context)
                self.assertIn("Sessions: ", context)  # a blocked summary leaves the rest of the context
                self.assertEqual([json.loads(row)["part"] for row in log.read_text(encoding="utf-8").splitlines()],
                                 [] if shown else ["state"])

    def test_stop_cancels_the_running_line(self):
        self.server.mouth = FakeMouth(["[intent:explain]一"] + ["二"] * 50, delay=0.05)
        conn, response = self.open_feed()
        self.say("说个长的")
        self.next_event(response)
        self.assertEqual(self.say("停下"), (200, {"command": "stop"}))
        events = self.lines_until_final(response)
        conn.close()
        self.assertTrue(events[-1]["cancelled"])
        self.assertLess(len(events), 40)

    def test_barge_in_cuts_the_line_being_generated(self):
        self.server.mouth = FakeMouth(["[intent:explain]一"] + ["二"] * 50, delay=0.05)
        conn, response = self.open_feed()
        self.say("说个长的")
        self.next_event(response)
        self.assertEqual(self.request("POST", "/speech/cancel", {"reason": "barge_in"}), (202, {"ok": True}))
        events = self.lines_until_final(response)
        conn.close()
        self.assertTrue(events[-1]["cancelled"])
        self.assertLess(len(events), 40)
        time.sleep(0.1)
        self.assertNotIn("speak", [c[0] for c in self.server.speech.calls])
        # Control: with the line over and no speech playing, nothing is cut.
        self.assertEqual(self.request("POST", "/speech/cancel", {"reason": "barge_in"}), (404, {"error": "no_speech"}))

    def test_mute_marks_lines_silent(self):
        self.assertEqual(self.say("静音"), (200, {"command": "mute"}))
        conn, response = self.open_feed()
        self.say("你好")
        events = self.lines_until_final(response)
        conn.close()
        self.assertEqual({e["speak"] for e in events}, {False})

    def test_open_and_jump_go_to_the_companion(self):
        conn, response = self.open_feed()
        self.assertEqual(self.say("打开 Safari")[0], 200)
        event = self.next_event(response)
        conn.close()
        self.assertEqual(event["event"], "command")
        data = json.loads(event["data"])
        self.assertEqual((data["action"], data["target"]), ("open", "Safari"))
        self.assertEqual(self.server.mouth.calls, [])

    def test_voice_deny_rejects_the_single_pending_card(self):
        self.server.broker.window = 5.0
        self.assertEqual(self.say("拒绝"), (409, {"error": "no_pending_approval"}))
        result = {}
        payload = {"hook_event_name": "PermissionRequest", "session_id": "A", "cwd": "/w",
                   "tool_name": "Bash", "tool_input": {"command": "rm -rf build"}}
        hook = threading.Thread(target=lambda: result.update(
            body=self.request("POST", "/hook/claude", payload, token=HOOK)[1]))
        hook.start()
        for _ in range(100):
            if self.request("GET", "/approvals")[1]["approvals"]:
                break
            time.sleep(0.01)
        status, body = self.say("不批准")
        hook.join(5)
        self.assertEqual((status, body["command"]), (200, "deny"))
        self.assertEqual(result["body"]["hookSpecificOutput"]["decision"]["behavior"], "deny")

    def test_dispatch_opens_a_card_in_the_focused_session_cwd(self):
        agent = self.server.character_agent
        chat = agent.public()["routes"]["chat"]  # without a background route the role cannot take the dispatch
        agent.public = lambda discover=False, *, wait=True: {**chat, "routes": {"chat": chat, "background": {**chat, "ready": False}}}
        self.assertEqual(self.say("让 Codex 查一下测试怎么跑"), (409, {"error": "no_cwd"}))
        self.request("POST", "/hook/claude", {"hook_event_name": "UserPromptSubmit", "session_id": "A",
                                              "cwd": "/repo", "prompt": "hi"}, token=HOOK)
        status, body = self.say("让 Codex 查一下测试怎么跑")
        self.assertEqual((status, body["command"]), (202, "dispatch"))
        [card] = self.request("GET", "/approvals")[1]["approvals"]
        self.assertEqual((card["request_id"], card["kind"]), (body["request_id"], "dispatch"))
        self.assertEqual(card["dispatch"], {"target": "codex", "cwd": "/repo", "prompt": "查一下测试怎么跑",
                                            "source": "text", "utterance": None,
                                            "modes": ["read_only", "workspace_write"], "mode": "read_only",
                                            "verify_cmd": None,
                                            "cwd_from": {"source": "focus", "display_session": "claude:A",
                                                         "state": "thinking"}})
        deny = {"decision": "deny", "generation": card["generation"]}
        self.assertEqual(self.request("POST", f"/approvals/{card['request_id']}/decision", deny)[0], 200)

    def test_voice_dispatch_card_shows_what_was_heard(self):
        self.request("POST", "/hook/claude", {"hook_event_name": "UserPromptSubmit", "session_id": "A",
                                              "cwd": "/repo", "prompt": "hi"}, token=HOOK)
        heard = "示例甲，让 Codex 查一下测试怎么跑。"
        status, body = self.request("POST", "/say", {"text": heard, "source": "voice"})
        self.assertEqual((status, body["command"]), (202, "dispatch"))
        [card] = self.request("GET", "/approvals")[1]["approvals"]
        self.assertEqual(card["dispatch"], {"target": "codex", "cwd": "/repo", "prompt": "查一下测试怎么跑",
                                            "source": "voice", "utterance": heard,
                                            "modes": ["read_only", "workspace_write"], "mode": "read_only",
                                            "verify_cmd": None,
                                            "cwd_from": {"source": "focus", "display_session": "claude:A",
                                                         "state": "thinking"}})

    def hook(self, name, session, cwd, **extra):
        return self.request("POST", "/hook/claude", {"hook_event_name": name, "session_id": session, "cwd": cwd,
                                                     **extra}, token=HOOK)

    def keyed(self, body, key):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        conn.request("POST", "/say", body=json.dumps(body).encode(),
                     headers={"Authorization": f"Bearer {UI}", "Content-Type": "application/json",
                              "Idempotency-Key": key})
        response = conn.getresponse()
        data = json.loads(response.read() or b"null")
        conn.close()
        return response.status, data

    def test_dispatch_card_says_which_focus_its_cwd_came_from(self):
        self.hook("UserPromptSubmit", "B", "/repoB", prompt="hi")
        self.hook("StopFailure", "B", "/repoB", error="api")
        self.hook("UserPromptSubmit", "A", "/repoA", prompt="hi")
        self.assertEqual(self.say("让codex修A项目的测试")[0], 202)
        [card] = self.server.broker.pending()
        self.assertEqual((card["dispatch"]["cwd"], card["dispatch"]["cwd_from"]),
                         ("/repoB", {"source": "focus", "display_session": "claude:B", "state": "error"}))

    def test_dispatch_uses_an_explicit_cwd(self):
        self.hook("UserPromptSubmit", "A", "/repoA", prompt="hi")
        status, body = self.request("POST", "/say", {"text": "让codex修A项目的测试", "cwd": self.tmp.name})
        self.assertEqual((status, body["command"]), (202, "dispatch"))
        [card] = self.server.broker.pending()
        self.assertEqual((card["dispatch"]["cwd"], card["dispatch"]["cwd_from"]),
                         (self.tmp.name, {"source": "explicit"}))

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_dispatch_rejects_a_cwd_that_is_no_absolute_directory(self):
        self.hook("UserPromptSubmit", "A", "/repoA", prompt="hi")
        relative = os.path.relpath(self.tmp.name)
        for cwd in ("/no/such/dir", relative, 5, ""):
            with self.subTest(cwd=cwd):
                self.assertEqual(self.request("POST", "/say", {"text": "让codex修A项目的测试", "cwd": cwd}),
                                 (400, {"error": "invalid_payload", "field": "cwd"}))
        self.assertEqual(self.server.broker.pending(), [])

    def test_same_idempotency_key_opens_one_dispatch_card(self):
        self.hook("UserPromptSubmit", "A", "/repoA", prompt="hi")
        body = {"text": "让codex修A项目的测试", "source": "text"}
        first = self.keyed(body, "k-say")
        self.assertEqual(first[0], 202)
        self.assertEqual(self.keyed(body, "k-say"), first)
        [card] = self.server.broker.pending()
        self.assertEqual(card["request_id"], first[1]["request_id"])
        self.assertEqual(self.keyed({**body, "text": "让codex修B项目的测试"}, "k-say"),
                         (409, {"error": "idempotency_conflict"}))
        self.assertEqual(len(self.server.broker.pending()), 1)
        self.assertEqual(self.say("让codex修A项目的测试")[0], 202)  # without a key every request runs
        self.assertEqual(len(self.server.broker.pending()), 2)

    def test_no_memory_turn_opens_no_dispatch_card(self):
        self.hook("UserPromptSubmit", "A", "/repoA", prompt="hi")
        self.assertEqual(self.request("POST", "/say", {"text": "让codex修A项目的测试", "no_memory": True}),
                         (409, {"error": "no_memory_dispatch"}))
        self.assertEqual(self.server.broker.pending(), [])

    def test_session_whose_cli_cannot_start_answers_502(self):
        from sessions.own import SessionManager
        manager = self.server.sessions = SessionManager(
            self.server.broker, self.server.announce, Path(self.tmp.name), "http://127.0.0.1:1", HOOK, 10,
            argv=lambda *_, **__: ["/nonexistent/agentd-test-cli"])
        self.addCleanup(manager.close, 0)
        self.assertEqual(self.request("POST", "/sessions", {"target": "claude", "cwd": self.tmp.name, "prompt": "x"}),
                         (502, {"error": "start_failed"}))
        [session] = manager.sessions.values()
        self.assertEqual(session.state, "error")

    def test_dispatch_returned_is_terminal_and_leaves_her_be(self):
        kinds, events = [], []
        self.server.behavior = type("B", (), {"event": lambda _self, kind: kinds.append(kind)})()
        self.server.state = type("S", (), {"on_event": lambda _self, kind, **_: events.append(kind)})()
        self.server.announce({"ts": 1.0, "level": "P2", "kind": "dispatch_returned",
                              "headline": "codex 回话了，结果待确认", "project": "/r", "session_id": None,
                              "detail": None})
        announced = [i["data"] for i in self.server.feed.since(0) if i["event"] == "announce"][-1]
        self.assertEqual((announced["kind"], announced["state"]), ("dispatch_returned", "terminal"))
        self.assertEqual((kinds, events), ([], []))

    def record_decisions(self):
        """Every decision event as (kind, attrs, key); each still reaches the server's own record."""
        recorded, real = [], self.server._decision

        def record(kind, attrs, key):
            recorded.append((kind, attrs, key))
            real(kind, attrs, key)
        self.server._decision = self.server.broker.on_decision = self.server.dispatcher.on_decision = record
        return recorded

    def finished(self, recorded):
        for _ in range(200):
            found = [(attrs, key) for kind, attrs, key in recorded if kind == "dispatch.finished"]
            if found:
                return found
            time.sleep(0.01)
        return []

    def test_an_expired_dispatch_card_finishes_its_trace(self):
        recorded = self.record_decisions()
        dispatcher = self.server.dispatcher
        dispatcher.sessions = type("S", (), {"announce": staticmethod(self.server.announce),
                                             "reply_language": staticmethod(lambda: None)})()
        dispatcher.window = 0.1
        request = dispatcher.propose("codex", "/repo", "x")
        self.assertEqual(self.finished(recorded),
                         [({"request_id": request.request_id, "result": "dispatch_closed"}, request.request_id)])

    def test_a_dispatch_that_cannot_start_finishes_its_trace(self):
        recorded = self.record_decisions()

        def create(*_, **__):
            raise OSError("disk full")
        dispatcher = self.server.dispatcher
        dispatcher.sessions = type("S", (), {"announce": staticmethod(self.server.announce),
                                             "create": staticmethod(create), "reply_language": staticmethod(lambda: None)})()
        request = dispatcher.propose("codex", "/repo", "x")
        self.server.broker.decide(request.request_id, request.generation, "allow")
        self.assertEqual(self.finished(recorded),
                         [({"request_id": request.request_id, "result": "dispatch_failed"}, request.request_id)])

    def test_say_rejects_an_unknown_source(self):
        self.assertEqual(self.request("POST", "/say", {"text": "你好", "source": "radio"}),
                         (400, {"error": "invalid_source"}))

    def test_say_rejects_an_unknown_surface(self):
        for surface in ("radio", 3, "", ["chat"]):
            self.assertEqual(self.request("POST", "/say", {"text": "你好", "surface": surface}),
                             (400, {"error": "invalid_payload", "field": "surface"}), surface)

    def test_say_rejects_a_quote_out_of_shape(self):
        bad = ["选区", {}, {"app": "备忘录"}, {"text": 3, "app": None}, {"text": "", "app": None},
               {"text": "字" * 2001, "app": None}, {"text": "选区", "app": 3}, {"text": "选区", "app": None, "url": "x"}]
        for quote in bad:
            self.assertEqual(self.request("POST", "/say", {"text": "你好", "quote": quote}),
                             (400, {"error": "invalid_payload", "field": "quote"}), quote)

    def test_say_rejects_a_look_window_out_of_shape(self):
        bad = [77, "77", [77], {}, {"pid": 501}, {"window_id": 0}, {"window_id": -1}, {"window_id": "77"},
               {"window_id": True}, {"window_id": 7.5}, {"window_id": 77, "pid": 0}, {"window_id": 77, "pid": "501"},
               {"window_id": 77, "app": "Notes"}]
        for look_window in bad:
            self.assertEqual(self.request("POST", "/say", {"text": "你好", "look_window": look_window}),
                             (400, {"error": "invalid_payload", "field": "look_window"}), look_window)

    def test_say_rejects_look_window_with_look(self):
        self.assertEqual(self.request("POST", "/say", {"text": "你好", "look": True,
                                                       "look_window": {"window_id": 77, "pid": 501}}),
                         (400, {"error": "invalid_payload", "field": "look_window"}))

    def test_say_puts_its_surface_and_quote_on_the_trace(self):
        quote = {"text": "字" * 2000, "app": None}
        status, _ = self.request("POST", "/say", {"text": "你好", "surface": "quick_input", "quote": quote})
        self.assertEqual(status, 202)
        self.assertEqual((self.server._turn_trace["surface"], self.server._turn_trace["quote"]), ("quick_input", quote))
        status, _ = self.request("POST", "/say", {"text": "你好"})
        self.assertEqual(status, 202)
        self.assertNotIn("surface", self.server._turn_trace)
        self.assertNotIn("quote", self.server._turn_trace)

    def test_say_rejects_a_reply_to_out_of_shape(self):
        bad = ["l1", {}, {"kind": "line"}, {"id": "l1"}, {"kind": "chat", "id": "l1"}, {"kind": "line", "id": ""},
               {"kind": "thought", "id": 3}, {"kind": "line", "id": "l1", "text": "x"}]
        for reply_to in bad:
            self.assertEqual(self.request("POST", "/say", {"text": "你好", "reply_to": reply_to}),
                             (400, {"error": "invalid_payload", "field": "reply_to"}), reply_to)

    def test_say_puts_its_reply_to_on_the_trace(self):
        for reply_to in ({"kind": "line", "id": "l1"}, {"kind": "thought", "id": "t1"}):
            status, _ = self.request("POST", "/say", {"text": "好啊", "reply_to": reply_to})
            self.assertEqual(status, 202)
            self.assertEqual(self.server._turn_trace["reply_to"], reply_to)
        status, _ = self.request("POST", "/say", {"text": "你好"})
        self.assertEqual(status, 202)
        self.assertNotIn("reply_to", self.server._turn_trace)

    def test_say_rejects_voice_timing_off_voice_or_out_of_shape(self):
        timing = {"pressed_ms": 1000, "released_ms": 2000, "final_ms": 3000}
        bad = [("text", timing), ("voice", {**timing, "released_ms": 999}),
               ("voice", {"pressed_ms": 1000, "released_ms": 2000}), ("voice", {**timing, "final_ms": True}),
               ("voice", {**timing, "pressed_ms": "1000"})]
        for source, voice_timing in bad:
            self.assertEqual(self.request("POST", "/say", {"text": "你好", "source": source,
                                                           "voice_timing": voice_timing}),
                             (400, {"error": "invalid_payload", "field": "voice_timing"}), (source, voice_timing))

    def test_dispatch_result_is_announced_and_spoken(self):
        conn, response = self.open_feed()
        self.server.announce({"ts": 1.0, "level": "P0", "kind": "dispatch_done", "headline": "codex 的任务完成了",
                              "project": "/repo", "session_id": None, "detail": "用 make test。"})
        data = json.loads(self.next_event(response)["data"])
        conn.close()
        self.assertEqual((data["kind"], data["detail"], data["speak"]), ("dispatch_done", "用 make test。", True))

    def announce(self, level="P0", headline="codex 的任务完成了"):
        self.server.announce({"ts": 1.0, "level": level, "kind": "dispatch_done", "headline": headline,
                              "project": "/repo", "session_id": None, "detail": None})
        return [i["data"] for i in self.server.feed.since(0) if i["event"] == "announce"][-1]

    def test_spoken_announce_goes_to_tts(self):
        data = self.announce()
        self.assertEqual(self.server.speech.calls, [("speak", f"announce-{data['seq']}", "codex 的任务完成了")])
        # Not admitted by the gate (switch off): card only, no voice.
        self.assertEqual(self.announce("P1")["speak"], False)
        self.server.muted = True
        self.announce()
        self.assertEqual(len(self.server.speech.calls), 1)

    def test_announce_is_card_only_while_shutting_down(self):
        self.server.closing = True  # a session killed by shutdown reports dispatch_failed
        self.assertTrue(self.announce()["speak"])
        self.assertEqual(self.server.speech.calls, [])

    def test_announce_while_speaking_only_p0_supersedes(self):
        self.server.gate.enabled, self.server.gate.quiet = True, (0, 0)
        self.server.speech.playing = True
        self.assertTrue(self.announce("P1")["speak"])
        self.assertEqual(self.server.speech.calls, [])  # admitted, but the running speech is not cut
        data = self.announce("P0")
        self.assertEqual(self.server.speech.calls, [("speak", f"announce-{data['seq']}", "codex 的任务完成了")])

    def test_errors_and_auth(self):
        self.assertEqual(self.say("你好", token=HOOK)[0], 401)
        self.assertEqual(self.request("POST", "/say", {"text": ""})[0], 400)
        self.assertEqual(self.request("POST", "/say", {"text": "x" * 2001})[0], 400)
        self.server.mouth = None
        self.assertEqual(self.say("你好"), (503, {"error": "no_llm"}))

    def test_mouth_error_ends_the_line(self):
        self.server.mouth = FakeMouth(["[intent:think]嗯"], error=RuntimeError("stop_reason=refusal"))
        conn, response = self.open_feed()
        self.say("x")
        events = self.lines_until_final(response)
        conn.close()
        self.assertEqual(events[-1]["error"], "RuntimeError")


class ReceiptStoreTest(unittest.TestCase):
    """A finished receipt answers a repeat of its Idempotency-Key after agentd restarts."""

    def setUp(self):
        support.enable_plugins(self)
        tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.addCleanup(tmp.cleanup)
        self.db = Path(tmp.name) / "agentd.sqlite"

    def start(self):
        """A server on the shared store, as agentd after a restart."""
        server = AgentdServer(("127.0.0.1", 0), HOOK, UI)
        server.mouth = FakeMouth(["你来了，管理员。"])
        server.character_agent = KernelLines(server)
        server.load_receipts(open_store(self.db))
        thread = support.serve_in_thread(server)

        def stop():
            server.shutdown()
            server.server_close()
            thread.join(2)
            server.receipts_db.close()
        self.addCleanup(stop)
        return server

    def keyed(self, server, body, key):
        conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        conn.request("POST", "/say", body=json.dumps(body).encode(),
                     headers={"Authorization": f"Bearer {UI}", "Content-Type": "application/json",
                              "Idempotency-Key": key})
        response = conn.getresponse()
        data = json.loads(response.read() or b"null")
        conn.close()
        return response.status, data

    def rows(self):
        with contextlib.closing(sqlite3.connect(self.db)) as db:
            return [row[0] for row in db.execute("SELECT key FROM idempotency_receipts ORDER BY rowid")]

    def test_a_finished_receipt_outlives_a_restart(self):
        first_server = self.start()
        body = {"text": "你好", "source": "text"}
        first = self.keyed(first_server, body, "k-say")
        self.assertEqual(first[0], 202)
        for _ in range(200):
            if not first_server._live_lines:
                break
            time.sleep(0.01)
        self.assertEqual(len(first_server.mouth.calls), 1)
        again = self.start()
        self.assertEqual(self.keyed(again, body, "k-say"), first)
        self.assertEqual((again._live_lines, again.mouth.calls), (set(), []))
        self.assertEqual(self.keyed(again, {**body, "text": "别的"}, "k-say"), (409, {"error": "idempotency_conflict"}))

    def test_the_store_keeps_the_newest_receipts_in_order(self):
        server = self.start()
        keys = [f"k-{n}" for n in range(RECEIPTS_KEPT + 3)]
        for key in keys:
            self.assertEqual(self.keyed(server, {"text": ""}, key), (400, {"error": "invalid_text"}))
        self.assertEqual(self.rows(), keys[3:])
        self.assertEqual(list(self.start()._receipts), keys[3:])

    def dump(self):
        with contextlib.closing(sqlite3.connect(self.db)) as db:
            return json.dumps(db.execute("SELECT * FROM idempotency_receipts").fetchall(), ensure_ascii=False)

    def test_the_store_keeps_no_request_text(self):
        server = self.start()
        body = {"text": "我的银行卡密码是多少来着", "source": "text"}
        self.assertEqual(self.keyed(server, body, "k-secret")[0], 202)
        self.assertEqual(self.rows(), ["k-secret"])
        self.assertNotIn("银行卡", self.dump())
        self.assertEqual(self.keyed(self.start(), {**body, "text": "别的"}, "k-secret"), (409, {"error": "idempotency_conflict"}))

    def test_a_no_memory_request_keeps_its_receipt_in_memory_only(self):
        server = self.start()
        body = {"text": "这句别记", "source": "text", "no_memory": True}
        first = self.keyed(server, body, "k-private")
        self.assertEqual(first[0], 202)
        self.assertEqual(self.keyed(server, body, "k-private"), first)
        self.assertEqual(self.rows(), [])

    def test_request_text_stored_before_digests_is_dropped_at_start(self):
        with contextlib.closing(open_store(self.db)) as db, db:
            db.execute("INSERT INTO idempotency_receipts (key, request, answer, at) VALUES (?, ?, ?, ?)",
                       ("k-old", json.dumps(["/say", {"text": "旧的原文"}], ensure_ascii=False), "[202, {}]", 0.0))
        self.start()
        self.assertEqual(self.rows(), [])
        self.assertNotIn("旧的原文", self.dump())


class FakeProcess:
    """An own-session backend that only records; its turn ends when the test calls turn_ended."""

    def __init__(self, manager, session):
        self.sent, self.interrupted = [], 0

    def alive(self):
        return True

    def send(self, text):
        self.sent.append(text)

    def interrupt(self):
        self.interrupted += 1

    def stop(self, timeout=0):
        pass


class TaskCommandTest(FeedServerCase):
    """The mouth hears how the latest tasks stand; 「停止任务」 stops the one busy session."""
    request = SayTest.request

    def setUp(self):
        super().setUp()
        from sessions.own import SessionManager
        from sessions.tasks import TaskLedger
        self.db = open_store(Path(self.tmp.name) / "agentd.sqlite")
        self.addCleanup(self.db.close)
        process = unittest.mock.patch("sessions.own.ClaudeProcess", FakeProcess)
        process.start()
        self.addCleanup(process.stop)
        manager = SessionManager(self.server.broker, self.server.announce, Path(self.tmp.name), "http://127.0.0.1:1",
                                 HOOK, 10)
        self.addCleanup(manager.close, 0)
        self.server.tasks = self.server.dispatcher.tasks = manager.tasks = TaskLedger(self.db)
        self.server.sessions = self.server.dispatcher.sessions = manager

    def propose(self, prompt):
        status, body = self.request("POST", "/say", {"text": f"让 claude {prompt}", "cwd": self.tmp.name})
        self.assertEqual(status, 202)
        return body["request_id"]

    def task(self, task_id, state):
        for _ in range(200):
            task = self.server.tasks.get(task_id)
            if task["state"] == state:
                return task
            time.sleep(0.01)
        self.fail(f"{task_id} stayed {task['state']}")

    def dispatched(self, prompt="改一下 README"):
        """An allowed dispatch whose session stays busy: FakeProcess never ends its turn."""
        request_id = self.propose(prompt)
        [card] = [c for c in self.server.broker.pending() if c["request_id"] == request_id]
        self.server.broker.decide(request_id, card["generation"], "allow")
        return self.task(request_id, "running")

    def test_stop_task_interrupts_the_one_busy_session_and_cancels_its_task(self):
        self.assertEqual(self.request("POST", "/say", {"text": "停止任务"}), (409, {"error": "no_task"}))
        task = self.dispatched()
        session = self.server.sessions.sessions[task["session_id"]]
        self.assertEqual(self.request("POST", "/say", {"text": "别做了"}), (200, {"command": "stop_task"}))
        self.assertEqual((session.backend.interrupted, session.cancel_requested), (1, True))
        self.assertEqual(self.server.tasks.get(task["task_id"])["state"], "cancelled")

    def test_stop_task_with_two_busy_sessions_is_ambiguous(self):
        first, second = self.dispatched("a"), self.dispatched("b")
        self.assertEqual(self.request("POST", "/say", {"text": "取消任务"}), (409, {"error": "ambiguous_task"}))
        self.assertEqual([self.server.tasks.get(t["task_id"])["state"] for t in (first, second)],
                         ["running", "running"])
        self.assertEqual([s.backend.interrupted for s in self.server.sessions.sessions.values()], [0, 0])

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_context_names_the_latest_tasks(self):
        self.assertNotIn("Recent tasks", self.server.context())
        request_id = self.propose("改一下 README")
        self.assertIn("Recent tasks: \"改一下 README\" awaiting approval", self.server.context())
        [card] = self.server.broker.pending()
        self.server.broker.decide(request_id, card["generation"], "allow")
        self.task(request_id, "running")
        for prompt in ("a", "b", "c"):
            self.propose(prompt)
        context = self.server.context()
        self.assertIn("Recent tasks: \"c\" awaiting approval; \"b\" awaiting approval; \"a\" awaiting approval", context)
        self.assertNotIn("改一下 README", context.split("Recent tasks")[1])


class AnnounceSlotTest(unittest.TestCase):
    """An admitted non-P0 announcement that comes while speech plays waits in its key's slot for a tick."""
    request = SayTest.request

    def setUp(self):
        support.enable_plugins(self)
        gate = Gate(enabled=True, quiet=(0, 0), same_cooldown=0, cross_cooldown=0)
        # The ticker never runs by itself: each test runs the ticks it means.
        self.server = AgentdServer(("127.0.0.1", 0), HOOK, UI, gate=gate, tick_interval=3600)
        self.thread = support.serve_in_thread(self.server)
        self.server.speech = FakeRelay()
        self.server.speech.playing = True
        self.now = [1000.0]
        self.server.clock = lambda: self.now[0]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def announce(self, kind, session_id, headline, level="P1"):
        self.server.announce({"ts": 1.0, "level": level, "kind": kind, "headline": headline, "project": "/repo",
                              "session_id": session_id, "detail": None})
        return [i["data"] for i in self.server.feed.since(0) if i["event"] == "announce"][-1]

    def spoken(self):
        return [(turn_id, text) for what, turn_id, text in self.server.speech.calls if what == "speak"]

    def test_a_slotted_announcement_expires_after_its_ttl(self):
        self.announce("gate_fail", "A", "A 门禁失败")
        self.now[0] += 2
        b = self.announce("ci_fail", "B", "B CI失败")
        self.now[0] += 14  # A has waited 16 s, B 14 s
        self.server.speech.playing = False
        self.server._announce_due()
        self.server._announce_due()
        self.assertEqual(self.spoken(), [(f"announce-{b['seq']}", "B CI失败")])

    def test_new_input_clears_every_slot(self):
        inputs = (lambda: self.request("POST", "/say", {"text": "打开 Safari", "source": "text"}),
                  lambda: self.request("POST", "/say", {"text": "打开 Safari", "source": "voice"}),
                  lambda: self.server.cancel_turn("barge_in"))
        for clear in inputs:
            self.announce("gate_fail", "A", "A 门禁失败")
            self.announce("ci_fail", "B", "B CI失败")
            clear()
        late = self.announce("gate_fail", "C", "C 门禁失败")
        self.server.speech.playing = False
        for _ in range(3):
            self.server._announce_due()
        self.assertEqual(self.spoken(), [(f"announce-{late['seq']}", "C 门禁失败")])

    def test_slots_are_voiced_one_per_tick_oldest_first(self):
        self.announce("gate_fail", "A", "A 门禁失败")
        b = self.announce("ci_fail", "B", "B CI失败")
        self.now[0] += 1
        a = self.announce("gate_green", "A", "A 门禁转绿", level="done")  # replaces A's older progress
        self.server._announce_due()
        self.assertEqual(self.spoken(), [])
        self.server.speech.playing = False
        self.server._announce_due()
        self.assertEqual(self.spoken(), [(f"announce-{b['seq']}", "B CI失败")])
        for _ in range(3):
            self.server._announce_due()
        self.assertEqual(self.spoken(), [(f"announce-{b['seq']}", "B CI失败"), (f"announce-{a['seq']}", "A 门禁转绿")])

    def test_a_progress_long_after_its_keys_terminal_is_voiced(self):
        self.server.speech.playing = False
        self.announce("mmrun_done", "A", "A 外审完成")
        self.now[0] += 5
        self.announce("gate_fail", "A", "A 迟到的门禁失败")  # late: within the TTL of A's terminal
        self.now[0] += 11
        late = self.announce("gate_fail", "A", "A 门禁失败")
        self.assertEqual([text for _, text in self.spoken()], ["A 外审完成", "A 门禁失败"])
        self.assertEqual(self.spoken()[-1][0], f"announce-{late['seq']}")

    def test_reset_clears_the_slots(self):
        self.server.speech.reset = lambda: None
        self.announce("gate_fail", "A", "A 门禁失败")
        self.assertEqual(self.server.reset()[0], 200)
        self.server.speech.playing = False
        for _ in range(3):
            self.server._announce_due()
        self.assertEqual(self.spoken(), [])

    def test_feed_announce_carries_its_state(self):
        self.server.speech.playing = False
        for kind, state in (("dispatch_done", "terminal"), ("dispatch_failed", "terminal"),
                            ("agent_failed", "terminal"), ("mmrun_done", "terminal"), ("gate_fail", "progress"),
                            ("ci_green", "progress"), ("agent_denied", "progress"), ("guard_block", "progress")):
            with self.subTest(kind=kind):
                self.assertEqual(self.announce(kind, kind, "h")["state"], state)

    def visibility(self, visible):
        return self.request("PUT", "/avatar/visibility", {"visible": visible, "reason": "user"})[0]

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_announcements_are_cards_only_while_hidden(self):
        self.server.speech.playing = False
        self.assertEqual(self.visibility(False), 200)
        cards = [self.announce("agent_failed", "A", "A 失败了", level="P0"), self.announce("gate_fail", "B", "B 门禁失败")]
        self.assertEqual([(card["speak"], card["gate"]) for card in cards], [(True, None), (True, None)])
        self.assertEqual((self.spoken(), self.server._announce_slots), ([], {}))
        self.assertEqual(self.visibility(True), 200)
        for _ in range(3):
            self.server._announce_due()
        self.assertEqual(self.spoken(), [])

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_a_slot_waits_while_hidden_and_is_voiced_once_shown_within_its_ttl(self):
        a = self.announce("gate_fail", "A", "A 门禁失败")  # speech busy: slotted
        self.assertEqual(self.visibility(False), 200)
        self.server.speech.playing = False
        self.server._announce_due()
        self.assertEqual(self.spoken(), [])
        self.now[0] += 10
        self.assertEqual(self.visibility(True), 200)
        self.server._announce_due()
        self.assertEqual(self.spoken(), [(f"announce-{a['seq']}", "A 门禁失败")])

    def test_a_slot_is_dropped_when_the_gate_closes_before_it_is_voiced(self):
        self.server.gate.same_cooldown = 600  # each slot's own admission starts its kind's cooldown
        a = self.announce("gate_fail", "A", "A 门禁失败")
        self.announce("ci_fail", "B", "B CI失败")
        self.server.speech.playing = False
        self.server._announce_due()
        self.assertEqual(self.spoken(), [(f"announce-{a['seq']}", "A 门禁失败")])
        self.assertEqual(self.request("PUT", "/observation/meeting", {"on": True})[0], 200)
        for _ in range(3):
            self.server._announce_due()
        self.assertEqual(self.spoken(), [(f"announce-{a['seq']}", "A 门禁失败")])
        self.assertEqual(self.server._announce_slots, {})


class AvatarVisibilityTest(FeedServerCase):
    """While the character is hidden only lines the user started are voiced; the rest are text only."""
    say, request, lines_until_final = SayTest.say, SayTest.request, SayTest.lines_until_final

    def setUp(self):
        super().setUp()
        self.server.mouth = FakeMouth(["[intent:gr", "eet]你来了", "，管理员。"])
        self.server.speech = FakeRelay()
        self.server.events_token = EVENTS
        self.server.character_agent = KernelLines(self.server)

    def wait_for(self, predicate, timeout=2.0):
        deadline = time.monotonic() + timeout
        while not predicate() and time.monotonic() < deadline:
            time.sleep(0.01)
        return predicate()

    def visibility(self, visible, reason="user", token=UI):
        return self.request("PUT", "/avatar/visibility", {"visible": visible, "reason": reason}, token)

    def test_visibility_is_stored_and_shown_in_state(self):
        self.server.speech = None  # FakeRelay has no played() for /diag/state
        avatar = self.request("GET", "/state", token=EVENTS)[1]["avatar"]
        self.assertEqual((avatar["visible"], avatar["reason"]), (True, None))
        datetime.datetime.fromisoformat(avatar["since"])
        self.assertTrue(self.request("GET", "/diag/state")[1]["mouth_voice"]["avatar_visible"])
        status, hidden = self.visibility(False, "fullscreen")
        self.assertEqual((status, hidden["visible"], hidden["reason"]), (200, False, "fullscreen"))
        self.assertGreaterEqual(hidden["since"], avatar["since"])
        time.sleep(0.01)
        self.assertEqual(self.visibility(False, None), (200, {**hidden, "reason": None}))  # same visible: same since
        self.assertEqual(self.request("GET", "/state", token=EVENTS)[1]["avatar"], {**hidden, "reason": None})
        self.assertFalse(self.request("GET", "/diag/state")[1]["mouth_voice"]["avatar_visible"])
        time.sleep(0.01)
        status, shown = self.visibility(True)
        self.assertEqual((status, shown["visible"], shown["reason"]), (200, True, "user"))
        self.assertGreater(shown["since"], hidden["since"])
        for body in ({}, {"visible": "no"}, {"visible": 0}, {"visible": None}, {"visible": False, "reason": 3},
                     {"visible": False, "reason": "x" * 65}, {"visible": False, "reason": "隐" * 22}, [False]):
            with self.subTest(body=body):
                self.assertEqual(self.request("PUT", "/avatar/visibility", body), (400, {"error": "invalid_payload"}))
        self.assertEqual(self.visibility(False, token=None)[0], 401)
        self.assertEqual(self.visibility(False, token=EVENTS)[0], 401)
        self.server.resetting = True
        self.assertEqual(self.visibility(False), (503, {"error": "resetting"}))
        self.server.resetting = False
        self.assertEqual(self.request("GET", "/state")[1]["avatar"], shown)

    def test_a_line_the_user_started_is_voiced_while_hidden(self):
        self.assertEqual(self.visibility(False)[0], 200)
        for source in ("text", "voice"):
            with self.subTest(source=source):
                conn, response = self.open_feed()
                status, body = self.request("POST", "/say", {"text": "你好", "source": source})
                self.assertEqual(status, 202)
                events = self.lines_until_final(response)
                conn.close()
                self.assertEqual({e["speak"] for e in events}, {True})
                self.assertTrue(self.wait_for(
                    lambda: ("speak", body["line_id"], "你来了，管理员。") in self.server.speech.calls))

    def test_a_proactive_line_is_text_only_while_hidden(self):
        rows = []
        self.server.history = SimpleNamespace(record=lambda **row: rows.append(row), conversations=SimpleNamespace(active=None))
        self.server.mouth = FakeMouth(["[intent:greet]好久", "没动了。"])
        self.assertEqual(self.visibility(False)[0], 200)
        self.assertTrue(self.server.claim_line("p-1", "（主动搭话）"))
        self.assertTrue(self.wait_for(lambda: not self.server._live_lines))
        time.sleep(0.1)  # a clause sent to TTS would have arrived by now
        self.assertEqual(self.server.speech.calls, [])
        lines = [i["data"] for i in self.server.feed.since(0) if i["event"] == "line"]
        self.assertEqual({line["speak"] for line in lines}, {False})
        self.assertEqual((lines[-1]["final"], lines[-1]["cancelled"], lines[-1]["error"]), (True, False, None))
        self.assertEqual([(row["turn_id"], row["state"]) for row in rows], [("p-1", "completed")])
        [intent] = [i for i in self.server.registry.intents_since(0) if i.get("event") == "clause_intent"]
        self.assertEqual((intent["line_id"], intent["utterance_id"], intent["intent"]), ("p-1", None, "greet"))
        self.assertEqual(self.server.gate._count, 1)

    def test_a_proactive_line_nobody_hears_counts_once_it_is_all_shown(self):
        events = []
        self.server.state = SimpleNamespace(on_event=lambda kind, **_: events.append(kind), summary=lambda user: "")
        self.server.mouth = FakeMouth(["好久没动了。"])
        self.server.muted = True  # shown, not voiced
        self.assertTrue(self.server.claim_line("p-1", "（主动搭话）"))
        self.assertTrue(self.wait_for(lambda: not self.server._live_lines))
        self.assertEqual(self.server.speech.calls, [])
        self.assertEqual((self.server.gate._count, events.count("line")), (1, 1))
        self.server.mouth = FakeMouth([])  # an empty reply says nothing
        self.assertTrue(self.server.claim_line("p-2", "（主动搭话）"))
        self.assertTrue(self.wait_for(lambda: not self.server._live_lines))
        self.assertEqual((self.server.gate._count, events.count("line")), (1, 1))

    def test_hiding_stops_the_speech_of_a_proactive_line_only(self):
        relay = self.server.speech
        relay.cancel = lambda reason="client_cancel", immediate=False: relay.calls.append(
            ("cancel", reason, immediate)) or "s-cut"
        cuts = lambda: [i for i in self.server.registry.intents_since(0)  # noqa: E731
                        if i.get("event") == "speech_cancelled"]

        def hiding_mouth(text, context):
            yield "好久没动了。下"
            self.assertEqual(self.visibility(False)[0], 200)  # while the line is still generated
            yield "次再说。"
        self.server.mouth = SimpleNamespace(stream=hiding_mouth, history=[])
        self.assertTrue(self.server.claim_line("p-1", "（主动搭话）"))
        self.assertTrue(self.wait_for(lambda: not self.server._live_lines))
        self.assertEqual(relay.calls, [("speak", "p-1", "好久没动了。"), ("cancel", "client_cancel", True)])
        [cut] = cuts()
        self.assertEqual((cut["speech_id"], cut["reason"]), ("s-cut", "client_cancel"))
        lines = [i["data"] for i in self.server.feed.since(0) if i["event"] == "line"]
        self.assertEqual([(line["text_delta"], line["speak"]) for line in lines],
                         [("好久没动了。下", True), ("次再说。", False), ("", False)])
        self.assertFalse(lines[-1]["cancelled"])
        # A user's line: hiding while it is generated or after it was voiced cuts nothing.
        self.assertEqual(self.visibility(True)[0], 200)
        del relay.calls[:]
        conn, response = self.open_feed()
        line_id = self.say("你好")[1]["line_id"]
        events = self.lines_until_final(response)
        conn.close()
        self.assertEqual({e["speak"] for e in events}, {True})
        self.assertEqual((self.visibility(True)[0], self.visibility(False)[0]), (200, 200))
        self.assertEqual(relay.calls, [("cancel", "superseded", False), ("speak", line_id, "好久没动了。"),
                                       ("speak", line_id, "下次再说。")])
        self.assertEqual(len(cuts()), 1)

    def test_a_proactive_lines_material_goes_to_its_context_only(self):
        rows = []
        self.server.history = SimpleNamespace(record=lambda **row: rows.append(row), conversations=SimpleNamespace(active=None))
        self.server.mouth = FakeMouth(["好久没动了。"])
        self.assertTrue(self.server.claim_line("p-1", "（主动搭话）", material="离开前在做：SECRET-THREAD"))
        self.assertTrue(self.wait_for(lambda: not self.server._live_lines and rows))
        [(text, context)] = self.server.mouth.calls
        self.assertIn("离开前在做：SECRET-THREAD", context)
        self.assertNotIn("SECRET-THREAD", text)  # the text a mouth keeps in its history
        self.assertEqual([row["user_text"] for row in rows], ["（主动搭话）"])


class RitualTapTest(FeedServerCase):
    """A tap on the character says the highest pending ritual, outside the proactive gate."""
    request = SayTest.request

    def setUp(self):
        super().setUp()
        from personal.rituals import Rituals
        self.server.mouth = FakeMouth(["[intent:greet]早", "上好，管理员。"])
        self.server.speech = FakeRelay()
        self.server.gate = Gate(enabled=True, quiet=(0, 0))
        self.server.character_agent = KernelLines(self.server)
        self.rows = []
        self.server.history = SimpleNamespace(record=lambda **row: self.rows.append(row), conversations=SimpleNamespace(active=None))
        self.db = open_store(Path(self.tmp.name) / "agentd.sqlite")
        self.addCleanup(self.db.close)
        self.now = time.mktime(datetime.datetime.now().replace(hour=8, minute=0, second=0, microsecond=0).timetuple())
        self.server.rituals = Rituals(self.db, clock=lambda: self.now, summary=lambda day: None,
                                      on_change=self.server.ritual_check)

    def wait_for(self, predicate, timeout=2.0):
        deadline = time.monotonic() + timeout
        while not predicate() and time.monotonic() < deadline:
            time.sleep(0.01)
        return predicate()

    def tap(self, token=UI, **extra):
        return self.request("POST", "/interaction/tap", {"at": "2026-10-22T08:00:00+08:00", **extra}, token)

    def test_a_tap_says_the_morning_once(self):
        egress = []
        self.server.egress = SimpleNamespace(authored=lambda part, text: egress.append((part, text)) or text,
                                             redactions={})
        status, body = self.tap()
        self.assertEqual((status, body["kind"]), (202, "morning"))
        self.assertTrue(self.wait_for(lambda: not self.server._live_lines and self.rows))
        lines = [i["data"] for i in self.server.feed.since(0) if i["event"] == "line"]
        self.assertEqual({line["line_id"] for line in lines}, {body["line_id"]})
        self.assertEqual({json.dumps(line["reason"]) for line in lines},
                         {json.dumps({"code": "ritual", "kind": "morning"})})
        self.assertEqual((lines[-1]["final"], lines[-1]["cancelled"]), (True, False))
        self.assertEqual({line["speak"] for line in lines}, {True})
        self.assertIn(("speak", body["line_id"], "早上好，管理员。"), self.server.speech.calls)
        from personal.rituals import TEMPLATES
        self.assertEqual(egress, [("ritual", TEMPLATES["morning"])])
        [(text, _)] = self.server.mouth.calls
        self.assertTrue(text.startswith("(Situation, not words from 管理员:"))
        self.assertEqual([(row["turn_id"], row["source"], row["state"]) for row in self.rows],
                         [(body["line_id"], "ritual", "completed")])
        # Not a proactive line: the gate counted nothing and /feedback does not know it.
        self.assertEqual((self.server.gate._count, self.server.gate._last), (0, {}))
        self.assertNotIn(body["line_id"], self.server._proactive_lines)
        self.assertEqual(self.tap()[1]["kind"], "tap")  # said: a later tap gets a tap line
        self.assertTrue(self.wait_for(lambda: not self.server._live_lines and len(self.rows) == 2))
        self.server.speech = None  # FakeRelay has no played() for /diag/state
        today = self.request("GET", "/diag/state")[1]["rituals"]
        self.assertEqual(today["pending"], [])
        self.assertEqual([(e["kind"], e["line_id"]) for e in today["today"]], [("morning", body["line_id"])])

    def test_a_failing_ritual_log_does_not_leave_the_line_live(self):
        def broken(line_id, state):
            raise sqlite3.OperationalError("database is locked")
        self.server.rituals.settled = broken
        self.server.egress = SimpleNamespace(authored=lambda part, text: text, redactions={})
        status, _ = self.tap()
        self.assertEqual(status, 202)
        self.assertTrue(self.wait_for(lambda: not self.server._live_lines and self.rows))

    def test_pending_changes_reach_the_feed(self):
        self.server.speech = None  # FakeRelay has no played() for /diag/state
        self.server.ritual_check()
        self.server.rituals.set_pending("break", {"minutes": 50})
        self.assertEqual(self.request("GET", "/diag/state")[1]["rituals"]["pending"], ["break", "morning"])
        status, body = self.tap()
        self.assertEqual((status, body["kind"]), (202, "break"))
        self.assertTrue(self.wait_for(lambda: not self.server._live_lines and self.rows))
        pending = [i["data"] for i in self.server.feed.since(0) if i["event"] == "pending"]
        self.assertEqual([p["kinds"] for p in pending], [["morning"], ["break", "morning"], ["morning"]])
        datetime.datetime.fromisoformat(pending[0]["since"])
        [(text, _)] = self.server.mouth.calls
        self.assertIn("50 minutes", text)

    def test_the_reports_arc_goes_to_its_context_only(self):
        from personal.rituals import Rituals
        self.now = time.mktime(datetime.datetime.now().replace(hour=18, minute=0, second=0, microsecond=0).timetuple())
        self.server.rituals = Rituals(self.db, clock=lambda: self.now, summary=lambda day: None,
                                      arc=lambda day: "10:00–10:40 调试 SECRET-ARC")
        status, body = self.tap()
        self.assertEqual((status, body["kind"]), (202, "report"))
        self.assertTrue(self.wait_for(lambda: not self.server._live_lines and self.rows))
        [(text, context)] = self.server.mouth.calls
        self.assertIn("Today so far: 10:00–10:40 调试 SECRET-ARC", context)
        self.assertNotIn("SECRET-ARC", text)
        self.assertNotIn("SECRET-ARC", self.rows[0]["user_text"])

    def test_a_cancelled_ritual_stays_pending(self):
        self.server.mouth = FakeMouth(["早", "上好。"], delay=0.2)
        status, body = self.tap()
        self.assertEqual(status, 202)
        self.server.cancel_turn("barge_in")
        self.assertTrue(self.wait_for(lambda: not self.server._live_lines and self.rows))
        self.assertEqual(self.rows[-1]["state"], "cancelled")
        self.assertEqual(self.server.rituals.pending(), ["morning"])
        self.assertEqual(self.tap()[1]["kind"], "tap")  # waiting out RETRY_AFTER
        self.assertTrue(self.wait_for(lambda: not self.server._live_lines and len(self.rows) == 2))
        self.now += 60
        self.assertEqual(self.tap()[1]["kind"], "morning")
        self.assertTrue(self.wait_for(lambda: not self.server._live_lines))

    def test_muted_or_meeting_ritual_is_text_only(self):
        for owner, name in ((self.server, "muted"), (self.server.gate, "meeting")):
            with self.subTest(name=name):
                setattr(owner, name, True)
                self.server.rituals.set_pending("break", {"minutes": 50})
                self.assertEqual(self.tap()[0], 202)
                self.assertTrue(self.wait_for(lambda: not self.server._live_lines and self.rows))
                self.assertEqual([c for c in self.server.speech.calls if c[0] == "speak"], [])
                self.server.muted = self.server.gate.meeting = False
                del self.rows[:]
        self.assertEqual(self.server.rituals.pending(), ["morning"])

    def test_a_line_waiting_on_her_work_is_working_not_speaking(self):
        self.server._live_lines.add(threading.Event())
        self.server.character_agent = SimpleNamespace(busy=lambda: True, close=lambda: None,
            public=lambda discover=False, *, wait=True: {"ready": True, "routes": {"chat": {"ready": True}}})
        self.assertFalse(self.server._mouth_lock.locked() or self.server.speech.busy())
        self.assertEqual(self.tap(), (409, {"error": "busy", "while": "working"}))
        self.server._live_lines.clear()
        self.server.character_agent = None

    def test_busy_switching_no_llm_and_auth(self):
        self.server.character_agent = SimpleNamespace(busy=lambda: True, close=lambda: None,
            public=lambda discover=False, *, wait=True: {"ready": True, "routes": {"chat": {"ready": True}}})
        self.assertEqual(self.tap(), (409, {"error": "busy", "while": "working"}))
        self.server.character_agent = None
        self.server.switch = {"switch_id": "k2-x", "to": "birch", "expires_at": time.time() + 30}
        self.assertEqual(self.tap(), (409, {"error": "switching"}))
        self.server.switch = None
        mouth, self.server.mouth = self.server.mouth, None
        self.assertEqual(self.tap(), (503, {"error": "no_llm"}))
        self.server.mouth = mouth
        self.assertEqual(self.tap(token=EVENTS)[0], 401)
        self.assertEqual(self.tap(token=HOOK)[0], 401)
        self.assertEqual(self.server.rituals.pending(), ["morning"])
        self.assertEqual(self.rows, [])

    def test_nothing_pending_says_a_tap_line(self):
        from personal.rituals import TAP
        egress = []
        self.server.egress = SimpleNamespace(authored=lambda part, text: egress.append((part, text)) or text,
                                             redactions={})
        self.now = time.mktime(datetime.datetime.now().replace(hour=4, minute=0, second=0, microsecond=0).timetuple())
        status, body = self.tap()
        self.assertEqual((status, body["kind"]), (202, "tap"))
        self.assertTrue(self.wait_for(lambda: not self.server._live_lines and self.rows))
        lines = [i["data"] for i in self.server.feed.since(0) if i["event"] == "line"]
        self.assertEqual({json.dumps(line["reason"]) for line in lines}, {json.dumps({"code": "tap"})})
        self.assertIn(("speak", body["line_id"], "早上好，管理员。"), self.server.speech.calls)
        self.assertEqual(egress, [("tap", TAP)])
        self.assertEqual([text for text, _ in self.server.mouth.calls], [TAP.format(count=1, user_title=self.server.user_title())])
        self.assertEqual([(row["turn_id"], row["source"]) for row in self.rows], [(body["line_id"], "tap")])
        self.assertEqual((self.server.gate._count, self.server.gate._last), (0, {}))
        self.assertNotIn(body["line_id"], self.server._proactive_lines)
        self.server.rituals = self.server.speech = None
        self.assertEqual(self.tap()[1]["kind"], "tap")
        self.assertTrue(self.wait_for(lambda: not self.server._live_lines and len(self.rows) == 2))
        self.assertEqual(self.request("GET", "/diag/state")[1]["rituals"]["pending"], [])

    def test_a_tap_says_how_many_clicks(self):
        from personal.rituals import TAPS
        egress = []
        self.server.egress = SimpleNamespace(authored=lambda part, text: egress.append((part, text)) or text,
                                             redactions={})
        self.now = time.mktime(datetime.datetime.now().replace(hour=4, minute=0, second=0, microsecond=0).timetuple())
        for count in (0, 21, "3", 2.0, True, None):
            with self.subTest(count=count):
                self.assertEqual(self.tap(count=count), (400, {"error": "invalid_payload", "field": "count"}))
        self.assertEqual(self.tap(count=3)[1]["kind"], "tap")
        self.assertTrue(self.wait_for(lambda: not self.server._live_lines and self.rows))
        self.assertEqual(egress, [("tap", TAPS)])
        self.assertEqual([text for text, _ in self.server.mouth.calls], [TAPS.format(count=3, user_title=self.server.user_title())])

    def tap_region_line(self, **extra):
        self.now = time.mktime(datetime.datetime.now().replace(hour=4, minute=0, second=0, microsecond=0).timetuple())
        with unittest.mock.patch.object(self.server, "start_line", wraps=self.server.start_line) as start_line:
            status, body = self.tap(**extra)
        self.assertEqual((status, body["kind"]), (202, "tap"))
        self.assertTrue(self.wait_for(lambda: not self.server._live_lines and self.rows))
        [call] = start_line.call_args_list
        self.assertEqual(call.kwargs["reason"], {"code": "tap"})
        return body, call.kwargs.get("material")

    def test_a_tap_region_tells_the_mouth_where(self):
        _, material = self.tap_region_line(region="head_top")
        self.assertIn("the top of your head", material)

    def test_an_unknown_tap_region_is_ignored(self):
        _, material = self.tap_region_line(region="bad")
        self.assertIsNone(material)

    def test_a_tap_region_keeps_the_reply_shape(self):
        with_region, _ = self.tap_region_line(region="hand_l")
        del self.rows[:]
        without, _ = self.tap_region_line()
        self.assertEqual(set(with_region), set(without))

    def test_a_meeting_tap_line_is_text_only(self):
        self.now = time.mktime(datetime.datetime.now().replace(hour=4, minute=0, second=0, microsecond=0).timetuple())
        self.server.gate.meeting = True
        self.assertEqual(self.tap()[1]["kind"], "tap")
        self.assertTrue(self.wait_for(lambda: not self.server._live_lines and self.rows))
        self.assertEqual([c for c in self.server.speech.calls if c[0] == "speak"], [])

    def test_a_pending_ritual_wins_over_the_tap_line(self):
        self.server.rituals.set_pending("water", {"minutes": 90})
        self.assertEqual(self.tap()[1]["kind"], "water")
        self.assertTrue(self.wait_for(lambda: not self.server._live_lines and self.rows))
        [(text, _)] = self.server.mouth.calls
        self.assertIn("drink some water", text)

    def test_a_blocked_tap_instruction_says_nothing(self):
        from brain.outbound import OutboundBlocked

        def authored(part, text):
            raise OutboundBlocked(part, 1)
        self.server.egress = SimpleNamespace(authored=authored, redactions={})
        self.now = time.mktime(datetime.datetime.now().replace(hour=4, minute=0, second=0, microsecond=0).timetuple())
        self.assertEqual(self.tap(), (200, {"kind": None}))
        self.assertEqual(self.server.mouth.calls, [])

    def test_the_tts_warms_while_the_model_writes(self):
        """A character-agent line ensures the TTS before its model turn, not after it returns."""
        requests, seen = [], []
        self.server.tts_ensurer = SimpleNamespace(request=lambda: requests.append(1))

        def prepare(line_id, text, *args, **kwargs):
            seen.append(len(requests))
            return SimpleNamespace(final_item_id=None, stream=self.server.mouth.stream)
        self.server.mouth.history = []
        self.server.character_agent = SimpleNamespace(busy=lambda: False, prepare=prepare,
            delivered=lambda history: None, cancel=lambda *args, **kwargs: None, close=lambda: None,
            public=lambda discover=False, *, wait=True: {"ready": True, "routes": {"chat": {"ready": True}}},
            settings=SimpleNamespace(snapshot=lambda: {"reply_language": "zh-Hans"}), reply_language=ReplyLanguage())
        for hour, kind in ((8, "morning"), (4, "tap")):
            with self.subTest(kind=kind):
                self.now = time.mktime(datetime.datetime.now().replace(hour=hour, minute=0, second=0,
                                                                       microsecond=0).timetuple())
                del requests[:], seen[:], self.rows[:]
                self.assertEqual(self.tap()[1]["kind"], kind)
                self.assertTrue(self.wait_for(lambda: not self.server._live_lines and self.rows))
                self.assertEqual(seen, [1])
        self.server.character_agent = None


class ClauseIntentTest(FeedServerCase):
    """C1 v2 §4: each [intent:x] goes to /events as clause_intent on the clause it stood in, one per clause."""
    say, request, lines_until_final = SayTest.say, SayTest.request, SayTest.lines_until_final

    def setUp(self):
        super().setUp()
        self.server.speech = FakeRelay()

    def line(self, chunks, delay=0.0):
        """Say something to a mouth answering `chunks`; the line_id and the clause_intents once the line is over."""
        self.server.mouth = FakeMouth(chunks, delay)
        conn, response = self.open_feed()
        line_id = self.say("你好")[1]["line_id"]
        self.lines_until_final(response)
        conn.close()
        return line_id, self.clause_intents()

    def clause_intents(self):
        return [i for i in self.server.registry.intents_since(0) if i.get("event") == "clause_intent"]

    def expected(self, line_id, *clauses):
        relay, generation = self.server.speech, self.server.turn_generation
        return [{"seq": seq, "event": "clause_intent", "line_id": line_id, "utterance_id": "u1",
                 "clause_id": f"u1.c{index}", "spoken_text_revision": 1, "intent": intent,
                 "turn_generation": generation, "trace_id": relay.traces["u1"]} for seq, index, intent in clauses]

    def test_each_marker_goes_out_on_its_own_clause(self):
        line_id, events = self.line(["[intent:gr", "eet]你好，管", "理员。[inte", "nt:explain]今天先", "看构建。"])
        self.assertEqual([c[2] for c in self.server.speech.calls if c[0] == "speak"], ["你好，管理员。", "今天先看构建。"])
        self.assertEqual(events, self.expected(line_id, (events[0]["seq"], 0, "greet"), (events[-1]["seq"], 1, "explain")))
        for event in events:
            self.assertEqual(c1.check_message(event), [])
        self.assertEqual(c1.check_file({"description": "clause intents", "messages": events}), [])

    def test_a_clause_with_two_markers_sends_the_first(self):
        line_id, events = self.line(["[intent:greet]你好，[intent:explain]管理员。今天先看构建。"])
        self.assertEqual(events, self.expected(line_id, (events[0]["seq"], 0, "greet")))

    def test_a_marker_at_the_end_goes_to_the_last_clause(self):
        line_id, events = self.line(["你好，管理员。今天先看构建。[intent:celebrate]"])
        self.assertEqual(events, self.expected(line_id, (events[0]["seq"], 1, "celebrate")))

    def test_code_is_shown_not_voiced_and_each_marker_keeps_its_clause(self):
        chunks = ["[intent:greet]好的，管理员。``", "`code`", "``\n[intent:explain]这样就行。"]
        self.server.mouth = FakeMouth(chunks)
        conn, response = self.open_feed()
        line_id = self.say("你好")[1]["line_id"]
        lines = self.lines_until_final(response)
        conn.close()
        self.assertEqual("".join(line["text_delta"] for line in lines), "好的，管理员。```code```\n这样就行。")
        self.assertEqual([c[2] for c in self.server.speech.calls if c[0] == "speak"], ["好的，管理员。", "\n这样就行。"])
        events = self.clause_intents()
        self.assertEqual(events, self.expected(line_id, (events[0]["seq"], 0, "greet"), (events[-1]["seq"], 1, "explain")))

    def test_a_marker_after_code_at_the_end_goes_to_the_last_clause(self):
        line_id, events = self.line(["好的，管理员。```code```\n这样就行。[intent:celebrate]"])
        self.assertEqual([c[2] for c in self.server.speech.calls if c[0] == "speak"], ["好的，管理员。", "\n这样就行。"])
        self.assertEqual(events, self.expected(line_id, (events[0]["seq"], 1, "celebrate")))

    def test_a_reply_of_code_only_is_shown_and_not_voiced(self):
        seen = []
        self.server.state = SimpleNamespace(on_event=lambda kind, **_: seen.append(kind), summary=lambda user: "")
        line_id, events = self.line(["[intent:explain]```python\n", "print(1)\n```"])
        self.assertNotIn("speak", [c[0] for c in self.server.speech.calls])
        self.assertEqual([(e["line_id"], e["utterance_id"], e["intent"]) for e in events], [(line_id, None, "explain")])
        self.assertEqual(seen.count("line"), 1)

    def test_a_line_shown_only_as_text_sends_its_first_marker_with_null_ids(self):
        for case in ("muted", "no_relay"):
            with self.subTest(case=case):
                before = len(self.clause_intents())
                if case == "muted":
                    self.assertEqual(self.say("静音"), (200, {"command": "mute"}))
                else:
                    self.server.muted, self.server.speech = False, None
                line_id, events = self.line(["[intent:greet]你好，管理员。[intent:explain]今天先看构建。"])
                [event] = events[before:]
                self.assertEqual({k: event[k] for k in ("line_id", "utterance_id", "clause_id", "spoken_text_revision",
                                                         "intent", "turn_generation")},
                                 {"line_id": line_id, "utterance_id": None, "clause_id": None,
                                  "spoken_text_revision": None, "intent": "greet",
                                  "turn_generation": self.server.turn_generation})
                self.assertIsInstance(event["trace_id"], str)
                self.assertEqual(c1.check_message(event), [])

    def test_a_cancelled_line_sends_nothing_after_the_cut(self):
        self.server.mouth = FakeMouth(["[intent:greet]你好，管理员。", "[intent:explain]今天"] + ["二"] * 40, delay=0.05)
        conn, response = self.open_feed()
        self.say("你好")
        relay = self.server.speech
        for _ in range(200):
            if any(c[0] == "speak" for c in relay.calls):
                break
            time.sleep(0.01)
        self.assertEqual(self.request("POST", "/turn/cancel", {"reason": "client_cancel"})[0], 202)
        events = self.lines_until_final(response)
        conn.close()
        self.assertTrue(events[-1]["cancelled"])
        time.sleep(0.1)
        self.assertEqual([(e["clause_id"], e["intent"]) for e in self.clause_intents()], [("u1.c0", "greet")])

    def test_each_clause_intent_follows_its_clause_request(self):
        relay, registry = self.server.speech, self.server.registry
        publish = registry.publish_event

        def logged(event, data):
            if event == "clause_intent":
                relay.calls.append(("event", data["intent"]))
            return publish(event, data)
        registry.publish_event = logged
        self.line(["[intent:greet]你好，管", "理员。[intent:explain]今天先", "看构建。"])
        self.assertEqual([c[::2] if c[0] == "speak" else c for c in relay.calls if c[0] in ("speak", "event")],
                         [("speak", "你好，管理员。"), ("event", "greet"), ("speak", "今天先看构建。"), ("event", "explain")])

    def logged(self):
        """[(event, data)] of every /events item and /feed line from here on, in publish order."""
        order, registry, feed = [], self.server.registry, self.server.feed
        publish_event, publish = registry.publish_event, feed.publish

        def event(name, data):
            order.append((name, data))
            return publish_event(name, data)

        def line(kind, data, *args, **kwargs):
            if kind == "line":
                order.append(("line", data))
            return publish(kind, data, *args, **kwargs)
        registry.publish_event, feed.publish = event, line
        return order

    def text_lines(self):
        return [i for i in self.server.registry.intents_since(0) if i.get("event") == "text_line"]

    def test_a_muted_line_speaks_while_its_text_shows(self):
        self.assertEqual(self.say("静音"), (200, {"command": "mute"}))
        order = self.logged()
        line_id, _ = self.line(["[intent:greet]你好，", "管理员。[intent:explain]今天先看构建。"])
        self.assertTrue(self.wait_for(lambda: len(self.text_lines()) == 2))
        started, ended = self.text_lines()
        generation, trace = self.server.turn_generation, started["trace_id"]
        self.assertEqual(started, {"seq": started["seq"], "event": "text_line", "line_id": line_id,
                                   "turn_generation": generation, "trace_id": trace, "state": "started"})
        self.assertEqual(ended, {**started, "seq": ended["seq"], "state": "ended", "hold_ms": 60 * len("你好，管理员。今天先看构建。")})
        names = [(name, data.get("state") or data.get("intent") or data.get("final")) for name, data in order]
        final = names.index(("line", True))
        self.assertLess(names.index(("text_line", "started")), names.index(("clause_intent", "greet")))
        self.assertLess(names.index(("clause_intent", "greet")), final)
        self.assertGreater(names.index(("text_line", "ended")), final)
        self.assertEqual([n for n in names if n[0] == "clause_intent"], [("clause_intent", "greet")])
        events = [e for e in self.server.registry.intents_since(0) if e.get("event") in ("text_line", "clause_intent")]
        self.assertEqual(c1.check_file({"description": "t1", "messages": events}), [])

    def test_a_voiced_line_sends_no_text_line(self):
        self.line(["[intent:greet]你好，管理员。"])
        self.assertTrue(self.clause_intents())
        time.sleep(0.1)
        self.assertEqual(self.text_lines(), [])

    def test_a_cancelled_text_line_ends_with_no_hold(self):
        self.assertEqual(self.say("静音"), (200, {"command": "mute"}))
        self.server.mouth = FakeMouth(["你好，管理员。"] + ["二"] * 40 + ["[intent:explain]"], delay=0.05)
        conn, response = self.open_feed()
        self.say("你好")
        self.assertTrue(self.wait_for(lambda: self.text_lines()))
        self.assertEqual(self.request("POST", "/turn/cancel", {"reason": "client_cancel"})[0], 202)
        self.assertTrue(self.lines_until_final(response)[-1]["cancelled"])
        conn.close()
        self.assertTrue(self.wait_for(lambda: len(self.text_lines()) == 2))
        self.assertEqual([(e["state"], e.get("hold_ms")) for e in self.text_lines()], [("started", None), ("ended", 0)])
        time.sleep(0.1)
        self.assertEqual(self.clause_intents(), [])

    def wait_for(self, predicate, timeout=2.0):
        deadline = time.monotonic() + timeout
        while not predicate() and time.monotonic() < deadline:
            time.sleep(0.01)
        return predicate()


class CharacterStateServerTest(unittest.TestCase):
    def setUp(self):
        with unittest.mock.patch("daemon.agentd_server.ThreadingHTTPServer.__init__"):
            self.server = AgentdServer(("127.0.0.1", 0), HOOK, UI)
        self.server.character = "aster"  # these fixtures start as aster and switch to birch
        self.addCleanup(self.server._ticker.join, 2)
        self.addCleanup(self.server._stopped.set)

    def test_feedback_retry_is_idempotent_for_character_state_and_judge(self):
        self.server.state = SayTest.her_state(self, 12)
        self.server.proactive = unittest.mock.Mock()
        self.server._proactive_lines.append("line")
        self.assertTrue(self.server.feedback("line", "useful"))
        before = self.server.state.snapshot()
        self.assertTrue(self.server.feedback("line", "useful"))
        self.assertTrue(self.server.feedback("line", "dont_disturb"))
        self.server.proactive.feedback.assert_called_once_with("line", "useful", False, "line")
        self.assertEqual(self.server.state.snapshot(), before)

    def test_mute_after_a_vote_still_turns_the_category_off(self):
        from character.proactive import Proactive
        self.server.proactive = Proactive(None, self.server.gate, lambda e, d: None, None, lambda: False)
        self.server.proactive._line_kinds["line"] = "comment"
        self.server._proactive_lines.append("line")
        self.assertTrue(self.server.feedback("line", "useful"))
        self.assertTrue(self.server.feedback("line", "dont_disturb", mute=True))
        self.assertIn("comment", self.server.gate.muted)

    def test_set_character_moves_state_and_events_to_its_own_row(self):
        state = self.server.state = SayTest.her_state(self, 12)
        state.on_event("dispatch_done")
        aster = state.snapshot()
        self.assertTrue(self.server.set_character("birch"))
        current = self.server.character_state()
        self.assertEqual((current["character_id"], current["valence"], current["causes"]), ("birch", 0.2, []))
        self.server.state_view.on_event("session_done")
        self.assertEqual(self.server.character_state()["causes"][-1]["cause"], "session_done")
        state.flush()
        rows = dict(state.db.execute("SELECT character_id, valence FROM character_state").fetchall())
        self.assertEqual(sorted(rows), sorted(["birch", "aster"]))
        self.assertAlmostEqual(rows["birch"], 0.3)
        self.assertEqual(rows["aster"], aster["valence"])
        self.assertTrue(self.server.set_character("aster"))
        self.assertEqual(state.snapshot(), aster)

    def test_reset_holds_the_switch_lock_through_the_reply(self):
        state = self.server.state = SayTest.her_state(self, 12)
        entered, release, switched = threading.Event(), threading.Event(), threading.Event()
        replies, errors = [], []
        clear = state.clear

        def held_clear(*args):
            entered.set()
            if not release.wait(3):
                raise AssertionError("reset was not released")
            return clear(*args)

        def reset():
            try:
                replies.append(self.server.reset_character_state("aster"))
            except Exception as error:
                errors.append(error)

        def switch():
            try:
                self.server.set_character("birch")
            except Exception as error:
                errors.append(error)
            finally:
                switched.set()

        with unittest.mock.patch.object(state, "clear", held_clear):
            resetter = threading.Thread(target=reset)
            resetter.start()
            self.assertTrue(entered.wait(2))
            switcher = threading.Thread(target=switch)
            switcher.start()
            try:
                self.assertFalse(switched.wait(0.1))
            finally:
                release.set()
                resetter.join(3)
                switcher.join(3)
        self.assertFalse(resetter.is_alive() or switcher.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual((replies[0][0], replies[0][1]["character_id"]), (200, "aster"))
        self.assertEqual(self.server.character_state()["character_id"], "birch")

    def test_reset_refuses_an_open_switch(self):
        self.server.state = SayTest.her_state(self, 12)
        self.server.switch = {"switch_id": "pending"}
        self.assertEqual(self.server.reset_character_state("aster"), (409, {"error": "switching"}))

    def test_reset_waits_for_an_event_writer_and_keeps_its_reference_fresh(self):
        state = self.server.state = SayTest.her_state(self, 12)
        state.use("birch")
        state.on_event("session_done")
        state.flush()
        other = state.db.execute("SELECT * FROM character_state WHERE character_id = 'birch'").fetchone()
        state.use("aster")
        writing, release, reset_done = threading.Event(), threading.Event(), threading.Event()
        errors = []
        write = state._write

        def held_write():
            writing.set()
            if not release.wait(5):
                raise AssertionError("writer was not released")
            write()

        def event():
            try:
                state.on_event("dispatch_done")
            except Exception as error:
                errors.append(error)

        def reset():
            try:
                self.server.clear_state()
            except Exception as error:
                errors.append(error)
            finally:
                reset_done.set()

        with unittest.mock.patch.object(state, "_write", held_write):
            writer = threading.Thread(target=event)
            writer.start()
            try:
                self.assertTrue(writing.wait(2))
                resetter = threading.Thread(target=reset)
                resetter.start()
                reset_done.wait(0.2)
            finally:
                release.set()
                writer.join(2)
            resetter.join(2)
        self.assertFalse(writer.is_alive())
        self.assertFalse(resetter.is_alive())
        self.assertEqual(errors, [])
        state.advance(state.clock() + 60)
        state.flush()
        self.assertEqual(state.db.execute("SELECT valence, causes FROM character_state"
                                          " WHERE character_id = 'aster'").fetchall(), [(0.2, "[]")])
        self.assertEqual(state.db.execute("SELECT * FROM character_state WHERE character_id = 'birch'").fetchone(), other)
        self.assertEqual(self.server.character_state()["causes"], [])


class CharacterTest(FeedServerCase):
    """POST /character swaps card, lore and voice; sessions, attention and history stay."""
    say, request, lines_until_final = SayTest.say, SayTest.request, SayTest.lines_until_final

    def setUp(self):
        super().setUp()
        self.server.mouth = FakeMouth(["[intent:greet]嗯。"])
        self.server.mouth.history = [["u", "live", "a"]]
        self.server.speech = FakeRelay()
        self.server.speech.character, self.server.speech.language = "voice_a", "zh"
        self.server.events_token = EVENTS
        self.built = []

        def factory(cid):
            self.built.append(cid)
            return FakeMouth(["[intent:greet]哼。"])
        self.server.mouth_factory = factory

    def test_switch_changes_card_voice_and_state(self):
        old = self.server.mouth
        self.assertEqual(self.request("GET", "/state", token=EVENTS)[1]["character"], "aster")
        self.assertEqual(self.request("POST", "/character", {"id": "birch"}), (200, {"id": "birch", "changed": True}))
        self.assertEqual(self.built, ["birch"])
        self.assertIsNot(self.server.mouth, old)
        self.assertEqual(self.server.mouth.history, [])
        self.assertEqual((self.server.speech.character, self.server.speech.language), ("si", "zh"))
        state = self.request("GET", "/state", token=EVENTS)[1]
        self.assertEqual((state["character"], state["character_generation"]), ("birch", 0))  # no bump
        conn, response = self.open_feed()
        self.say("你好")
        events = self.lines_until_final(response)
        conn.close()
        self.assertEqual("".join(e["text_delta"] for e in events), "哼。")

    def test_switch_ends_the_running_line_and_speech(self):
        self.server.mouth = FakeMouth(["[intent:explain]一"] + ["二"] * 50, delay=0.05)
        self.server.mouth.history = []
        conn, response = self.open_feed()
        self.say("说点什么")
        time.sleep(0.1)
        self.assertEqual(self.request("POST", "/character", {"id": "birch"})[0], 200)
        events = self.lines_until_final(response)
        conn.close()
        self.assertTrue(events[-1]["cancelled"])
        self.assertEqual(self.server.speech.calls, [("cancel", "superseded", False), ("cancel", "superseded", True)])

    def test_unknown_id_changes_nothing(self):
        old = self.server.mouth
        for body in ({"id": "nobody"}, {"id": "../aster"}, {"id": 3}, {}):
            self.assertEqual(self.request("POST", "/character", body), (400, {"error": "unknown_character"}))
        self.assertIs(self.server.mouth, old)
        self.assertEqual((self.built, self.server.speech.calls), ([], []))

    def test_same_id_is_a_no_op(self):
        self.assertEqual(self.request("POST", "/character", {"id": "aster"}), (200, {"id": "aster", "changed": False}))
        self.assertEqual((self.built, self.server.speech.calls), ([], []))

    def test_events_token_cannot_switch(self):
        self.assertEqual(self.request("POST", "/character", {"id": "birch"}, token=EVENTS)[0], 401)
        self.assertEqual(self.built, [])

    def test_sessions_attention_and_mute_stay(self):
        registry, broker, attention = self.server.registry, self.server.broker, self.server.attention
        self.say("静音")
        self.assertEqual(self.request("POST", "/character", {"id": "birch"})[0], 200)
        self.assertIs(self.server.registry, registry)
        self.assertIs(self.server.broker, broker)
        self.assertIs(self.server.attention, attention)
        self.assertTrue(self.server.muted)

    def test_blocked_card_keeps_the_old_character(self):
        from brain.outbound import OutboundBlocked

        def blocked(cid):
            raise OutboundBlocked("system", 2)
        self.server.mouth_factory = blocked
        old = self.server.mouth
        self.assertEqual(self.request("POST", "/character", {"id": "birch"}), (409, {"error": "outbound_blocked"}))
        self.assertIs(self.server.mouth, old)
        self.assertEqual(self.request("GET", "/state")[1]["character"], "aster")
        self.assertEqual(self.server.speech.calls, [])


class CharacterSwitchTest(FeedServerCase):
    """Prepare cuts the turn and holds new input, commit swaps persona and voice, abort or the lease leave O."""
    say, request, lines_until_final = SayTest.say, SayTest.request, SayTest.lines_until_final
    QUIET = {"fullscreen": False, "user_speaking": False, "speaking": False, "voicing": False, "line_id": None, "typing": False,
             "session": None, "state": "idle", "related": [], "window_id": None}

    def setUp(self):
        super().setUp()
        self.server.mouth = FakeMouth(["[intent:greet]嗯。"])
        self.server.mouth.history = [["u", "live", "a"]]
        self.server.speech = FakeRelay()
        self.server.speech.character, self.server.speech.language = "voice_a", "zh"
        self.built = []

        def factory(cid):
            self.built.append(cid)
            return FakeMouth(["[intent:greet]哼。"])
        self.server.mouth_factory = factory
        self.now = [1760900000.0]
        self.server.clock = lambda: self.now[0]

    def prepare(self, body=None):
        return self.request("POST", "/character/prepare", {"id": "birch"} if body is None else body)

    def commit(self, switch_id):
        return self.request("POST", "/character/commit", {"switch_id": switch_id})

    def abort(self, switch_id):
        return self.request("POST", "/character/abort", {"switch_id": switch_id})

    def state(self):
        return self.request("GET", "/state")[1]

    def events(self, kind):
        return [i for i in self.server.registry.intents_since(0) if i.get("event") == kind]

    def spoken(self):
        return [(turn_id, text) for what, turn_id, text in self.server.speech.calls if what == "speak"]

    def wait_for(self, predicate, timeout=2.0):
        deadline = time.monotonic() + timeout
        while not predicate() and time.monotonic() < deadline:
            time.sleep(0.01)
        return predicate()

    def test_prepare_cuts_the_turn_and_holds_new_input(self):
        self.server.spatial.observe = lambda: dict(self.QUIET)
        self.server.spatial.poll()  # a random tick: one behavior runs
        [running] = self.server.spatial.running()
        self.server.mouth = FakeMouth(["[intent:explain]一"] + ["二"] * 50, delay=0.05)
        self.server.mouth.history = []
        conn, response = self.open_feed()
        self.assertEqual(self.say("说点什么")[0], 202)
        time.sleep(0.1)
        before = self.server.turn_generation
        status, body = self.prepare()
        self.assertEqual(status, 200, body)
        self.assertRegex(body["switch_id"], r"^k2-[0-9a-f]{12}$")
        self.assertEqual(body["turn_generation"], before + 1)
        events = self.lines_until_final(response)
        conn.close()
        self.assertTrue(events[-1]["cancelled"])
        self.assertEqual(self.server.speech.calls[-1], ("cancel", "superseded", True))
        cut = self.events("speech_cancelled")[-1]
        self.assertEqual((cut["reason"], cut["turn_generation"]), ("superseded", body["turn_generation"]))
        [cancel] = self.events("behavior_cancel")
        self.assertEqual((cancel["behavior_id"], cancel["reason"], cancel["turn_generation"]),
                         (running["behavior_id"], "character_switch", body["turn_generation"]))
        self.assertEqual(c1.check_message(cancel), [])
        self.assertEqual(self.server.spatial.running(), [])
        state = self.state()
        self.assertEqual({k: state["switching"][k] for k in ("switch_id", "to")},
                         {"switch_id": body["switch_id"], "to": "birch"})
        expires = datetime.datetime.fromisoformat(state["switching"]["expires_at"]).timestamp()
        self.assertAlmostEqual(expires, self.now[0] + 25, places=2)
        self.assertEqual((state["character"], state["character_generation"]), ("aster", 0))
        self.assertEqual(self.built, ["birch"])  # built now, used by commit
        self.assertEqual(self.server.speech.character, "voice_a")
        switching = (409, {"error": "switching"})
        self.assertEqual(self.say("打开 Safari"), switching)
        self.assertEqual(self.request("POST", "/say", {"text": "你好", "source": "voice"}), switching)
        self.assertEqual(self.request("POST", "/character", {"id": "birch"}), switching)
        self.assertEqual(self.request("POST", "/turn/cancel", {"reason": "client_cancel"})[0], 202)
        self.assertEqual(self.state()["switching"]["switch_id"], body["switch_id"])

    def test_commit_swaps_persona_and_voice_once(self):
        old = self.server.mouth
        switch_id = self.prepare()[1]["switch_id"]
        done = (200, {"id": "birch", "character_generation": 1})
        self.assertEqual(self.commit(switch_id), done)
        state = self.state()
        self.assertEqual((state["character"], state["character_generation"], state["switching"]),
                         ("birch", 1, None))
        self.assertEqual((self.server.speech.character, self.server.speech.language), ("si", "zh"))
        self.assertIsNot(self.server.mouth, old)
        self.assertEqual(self.server.mouth.history, [])
        self.assertEqual(self.say("打开 Safari"), (200, {"command": "open"}))
        conn, response = self.open_feed()
        self.say("你好")
        events = self.lines_until_final(response)
        conn.close()
        self.assertEqual("".join(e["text_delta"] for e in events), "哼。")
        self.assertEqual(self.commit(switch_id), done)  # a repeat changes nothing
        self.assertEqual(self.state()["character_generation"], 1)
        self.assertEqual(self.built, ["birch"])
        self.assertEqual(self.abort(switch_id), (409, {"error": "committed", "id": "birch"}))
        self.now[0] += 61
        self.assertEqual(self.commit(switch_id), (404, {"error": "unknown_switch"}))
        self.assertEqual(self.abort(switch_id), (404, {"error": "unknown_switch"}))

    def test_abort_leaves_the_old_character(self):
        old = self.server.mouth
        switch_id = self.prepare()[1]["switch_id"]
        self.assertEqual(self.abort(switch_id), (200, {}))
        state = self.state()
        self.assertEqual((state["character"], state["character_generation"], state["switching"]),
                         ("aster", 0, None))
        self.assertIs(self.server.mouth, old)
        self.assertEqual((self.server.speech.character, self.server.speech.language), ("voice_a", "zh"))
        self.assertEqual(self.say("打开 Safari"), (200, {"command": "open"}))
        self.assertEqual(self.commit(switch_id), (404, {"error": "unknown_switch"}))
        self.assertEqual(self.abort(switch_id), (404, {"error": "unknown_switch"}))
        self.assertEqual(self.prepare()[0], 200)  # the next switch can open

    def test_prepare_errors_change_nothing(self):
        def unchanged():
            state = self.state()
            self.assertEqual((state["turn_generation"], state["character"], state["character_generation"],
                              state["switching"]), (0, "aster", 0, None))
            self.assertEqual(self.server.speech.calls, [])

        for body in ({"id": "nobody"}, {"id": "../aster"}, {"id": 3}, {}, ["birch"]):
            with self.subTest(body=body):
                self.assertEqual(self.prepare(body), (400, {"error": "unknown_character"}))
        self.assertEqual(self.prepare({"id": "aster"}), (409, {"error": "same_character"}))
        unchanged()
        from brain.outbound import OutboundBlocked
        factory = self.server.mouth_factory

        def blocked(cid):
            raise OutboundBlocked("system", 2)
        self.server.mouth_factory = blocked
        self.assertEqual(self.prepare(), (409, {"error": "outbound_blocked"}))
        unchanged()
        self.server.mouth_factory = factory
        status, body = self.prepare()
        self.assertEqual(status, 200)
        self.assertEqual(self.prepare(), (409, {"error": "switching"}))
        self.assertEqual(self.prepare({"id": "aster"}), (409, {"error": "switching"}))
        self.assertEqual(self.prepare({"id": "nobody"}), (400, {"error": "unknown_character"}))
        state = self.state()
        self.assertEqual((state["turn_generation"], state["character"], state["switching"]["switch_id"]),
                         (body["turn_generation"], "aster", body["switch_id"]))

    def test_the_lease_ends_a_forgotten_switch(self):
        switch_id = self.prepare()[1]["switch_id"]
        self.now[0] += 24.9
        time.sleep(0.3)  # ticks run; the lease still holds
        self.assertEqual(self.state()["switching"]["switch_id"], switch_id)
        self.now[0] += 0.2
        self.assertTrue(self.wait_for(lambda: self.state()["switching"] is None))
        self.assertEqual(self.say("打开 Safari"), (200, {"command": "open"}))
        self.assertEqual(self.commit(switch_id), (404, {"error": "unknown_switch"}))
        self.assertEqual((self.state()["character"], self.state()["character_generation"]), ("aster", 0))

    def test_a_say_that_races_prepare_starts_no_line(self):
        entered, release, said = threading.Event(), threading.Event(), []
        real = sys.modules["daemon.turns"].parse_command

        def slow(text, **options):  # holds /say after its first switch check, while prepare runs
            entered.set()
            release.wait(2)
            return real(text, **options)
        with unittest.mock.patch.object(sys.modules["daemon.turns"], "parse_command", slow):
            racer = threading.Thread(target=lambda: said.append(self.server.say("你好")))
            racer.start()
            self.assertTrue(entered.wait(2))
            self.assertEqual(self.prepare()[0], 200)
            release.set()
            racer.join(2)
        time.sleep(0.2)  # a line that slipped through would have called the mouth by now
        self.assertEqual(said, [(409, {"error": "switching"})])
        self.assertEqual(self.server.mouth.calls, [])

    def test_input_refused_while_switching_is_not_announced_as_accepted(self):
        self.assertEqual(self.prepare()[0], 200)
        self.assertEqual(self.say("你好"), (409, {"error": "switching"}))
        self.assertNotIn("turn_accepted", [i["event"] for i in self.server.feed.since(0)])

    def test_nothing_new_starts_while_switching(self):
        gate = self.server.gate
        gate.enabled, gate.quiet, gate.same_cooldown, gate.cross_cooldown = True, (0, 0), 0, 0
        self.server.spatial.observe = lambda: dict(self.QUIET)
        switch_id = self.prepare()[1]["switch_id"]
        self.assertFalse(self.server.claim_line("p-1", "嗯"))
        for level, session in (("P1", "A"), ("P0", "B")):
            self.server.announce({"ts": 1.0, "level": level, "kind": "gate_fail", "headline": f"{session} 门禁失败",
                                  "project": "/repo", "session_id": session, "detail": None})
        stop = threading.Event()
        self.addCleanup(stop.set)
        self.server.spatial._next_tick = 0  # the first random tick is due now, not 60-120 s after run()
        with unittest.mock.patch.object(spatial, "POLL", 0.01):
            loop = threading.Thread(target=self.server.spatial.run, args=(stop, self.server.polls_paused),
                                    daemon=True)
            loop.start()
            time.sleep(0.3)  # ticks and spatial polls run
            self.assertEqual(self.spoken(), [])
            self.assertEqual(self.events("behavior"), [])
            self.assertEqual(self.say("打开 Safari"), (409, {"error": "switching"}))  # the slots stay
            self.assertEqual(self.abort(switch_id), (200, {}))
            self.assertTrue(self.wait_for(lambda: len(self.spoken()) == 2))
            self.assertTrue(self.wait_for(lambda: self.events("behavior")))
            stop.set()
            loop.join(2)
        self.assertEqual([text for _, text in self.spoken()], ["A 门禁失败", "B 门禁失败"])
        self.server.character_agent = KernelLines(self.server)
        self.assertTrue(self.server.claim_line("p-2", "嗯"))

    def test_a_failed_commit_keeps_the_old_character_and_the_switch(self):
        old = self.server.mouth
        switch_id = self.prepare()[1]["switch_id"]
        with unittest.mock.patch.object(characters.Repository, "voice", side_effect=RuntimeError("voice")):
            self.assertEqual(self.commit(switch_id), (500, {"error": "commit_failed"}))
        state = self.state()
        self.assertEqual((state["character"], state["character_generation"], state["switching"]["switch_id"]),
                         ("aster", 0, switch_id))
        self.assertIs(self.server.mouth, old)
        self.assertEqual(self.server.speech.character, "voice_a")
        self.assertEqual(self.abort(switch_id), (200, {}))
        self.assertEqual(self.say("打开 Safari"), (200, {"command": "open"}))

    def hold_the_mouth(self):
        """A line whose model sends nothing until the returned Event is set; it holds _mouth_lock till then."""
        release = threading.Event()

        class Slow(FakeMouth):
            def stream(self, text, context):
                release.wait(3)
                yield from super().stream(text, context)
        self.server.mouth = Slow(["[intent:greet]嗯。"])
        self.server.mouth.history = [["u", "live", "a"]]
        self.addCleanup(release.set)
        self.assertEqual(self.say("你好")[0], 202)
        self.assertTrue(self.wait_for(self.server._mouth_lock.locked))
        return release

    def commit_in_background(self, switch_id):
        committed = []
        committer = threading.Thread(target=lambda: committed.append(self.commit(switch_id)))
        committer.start()
        time.sleep(0.2)  # commit now waits for the mouth
        self.assertEqual(committed, [])
        return committer, committed

    def test_abort_answers_while_a_commit_waits_for_the_mouth(self):
        release = self.hold_the_mouth()
        switch_id = self.prepare()[1]["switch_id"]
        committer, committed = self.commit_in_background(switch_id)
        started = time.monotonic()
        self.assertEqual(self.abort(switch_id), (200, {}))
        self.assertLess(time.monotonic() - started, 1.0)
        release.set()
        committer.join(3)
        self.assertEqual(committed, [(404, {"error": "unknown_switch"})])
        state = self.state()
        self.assertEqual((state["character"], state["character_generation"], state["switching"]),
                         ("aster", 0, None))

    def test_a_commit_that_waited_for_the_mouth_swaps_once_it_is_free(self):
        release = self.hold_the_mouth()
        switch_id = self.prepare()[1]["switch_id"]
        committer, committed = self.commit_in_background(switch_id)
        release.set()
        committer.join(3)
        self.assertEqual(committed, [(200, {"id": "birch", "character_generation": 1})])
        state = self.state()
        self.assertEqual((state["character"], state["character_generation"], state["switching"]),
                         ("birch", 1, None))
        self.assertEqual(self.server.speech.character, "si")

    def test_prepare_answers_while_set_character_waits_for_the_mouth(self):
        release = self.hold_the_mouth()
        results = []
        setter = threading.Thread(target=lambda: results.append(self.server.set_character("birch")))
        setter.start()
        time.sleep(0.2)  # set_character now waits for the mouth
        started = time.monotonic()
        self.assertEqual(self.prepare()[0], 200)
        self.assertLess(time.monotonic() - started, 1.0)
        release.set()
        setter.join(3)
        self.assertEqual(results, [None])  # the switch opened meanwhile: nothing changes
        self.assertEqual(self.state()["character"], "aster")

    def test_a_character_switch_moves_to_the_new_characters_state(self):
        tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.addCleanup(tmp.cleanup)
        db = open_store(Path(tmp.name) / "agentd.sqlite")
        self.addCleanup(db.close)
        state = CharacterState(db, lambda cid: None, clock=lambda: self.now[0])
        state.use("aster")
        self.server.state = state
        spoke = lambda: [c["cause"] for c in state.snapshot()["causes"]]  # noqa: E731
        self.assertEqual(self.say("打开 Safari"), (200, {"command": "open"}))
        self.assertEqual(spoke(), ["user_spoke"])
        self.assertEqual(self.abort(self.prepare()[1]["switch_id"]), (200, {}))
        self.assertEqual(state.snapshot()["character_id"], "aster")  # an abort stays
        self.assertEqual(self.commit(self.prepare()[1]["switch_id"])[0], 200)
        self.assertEqual((state.snapshot()["character_id"], spoke()), ("birch", []))
        [(causes,)] = db.execute("SELECT causes FROM character_state WHERE character_id = 'aster'").fetchall()
        self.assertEqual([c["cause"] for c in json.loads(causes)], ["user_spoke"])  # the one she left is kept


class SpeechStreamTest(FeedServerCase):
    def test_speech_stream_forwards_relay_lines_as_ndjson(self):
        from voice.speech import SpeechRelay
        self.server.speech = SpeechRelay("http://127.0.0.1:9", epoch=1, character="voice_a", language="zh")
        self.server.events_token = "events"
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        conn.request("GET", "/speech", headers={"Authorization": "Bearer events"})
        response = conn.getresponse()
        self.assertEqual((response.status, response.getheader("Content-Type")), (200, "application/x-ndjson"))
        self.server.speech._publish({"event": "speech.begin", "seq": 0})
        response.fp.readline()  # stream.hello
        line = response.fp.readline()
        conn.close()
        self.assertEqual(json.loads(line), {"event": "speech.begin", "seq": 0, "stream_seq": 1})

    def test_speech_line_published_right_after_connect_is_delivered(self):
        from voice.speech import SpeechRelay

        class SlowCursorRelay(SpeechRelay):
            @property
            def seq(self):
                if threading.current_thread() is not threading.main_thread():
                    time.sleep(0.3)
                return self._seq

            @seq.setter
            def seq(self, value):
                self._seq = value

        self.server.speech = SlowCursorRelay("http://127.0.0.1:9", epoch=1, character="voice_a", language="zh")
        self.server.events_token = "events"
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)
        conn.request("GET", "/speech", headers={"Authorization": "Bearer events"})
        response = conn.getresponse()
        self.server.speech._publish({"event": "speech.begin", "seq": 0})
        response.fp.readline()  # stream.hello
        line = response.fp.readline()
        conn.close()
        self.assertEqual(json.loads(line), {"event": "speech.begin", "seq": 0, "stream_seq": 1})

    def open_speech(self, query=""):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        conn.request("GET", "/speech" + query, headers={"Authorization": f"Bearer {UI}"})
        return conn, conn.getresponse()

    def test_speech_stream_says_hello_then_numbers_each_line(self):
        from voice.speech import SpeechRelay
        relay = self.server.speech = SpeechRelay("http://127.0.0.1:9", epoch=1, character="voice_a", language="zh")
        relay._publish({"event": "speech.begin", "seq": 0})
        conn, response = self.open_speech()
        relay._publish({"event": "speech.end", "seq": 1})
        hello = json.loads(response.fp.readline())
        self.assertEqual(hello["event"], "stream.hello")
        line = json.loads(response.fp.readline())
        conn.close()
        self.assertEqual(hello, {"event": "stream.hello", "stream_epoch": relay.stream_epoch,
                                 "oldest_seq": 1, "latest_seq": 1})
        self.assertEqual(line, {"event": "speech.end", "seq": 1, "stream_seq": 2})

    def test_speech_cursor_gap_reset_and_malformed(self):
        from voice.speech import SpeechRelay
        relay = self.server.speech = SpeechRelay("http://127.0.0.1:9", epoch=1, character="voice_a",
                                                 language="zh", buffer=256)
        conn, response = self.open_speech()
        for i in range(3):
            relay._publish({"event": "speech.cue", "seq": i})
        first = json.loads(response.fp.readline())
        while first["event"].startswith("stream."):
            first = json.loads(response.fp.readline())
        conn.close()
        self.assertIn("stream_seq", first)
        for i in range(300):
            relay._publish({"event": "speech.cue", "seq": 3 + i})
        latest = relay.seq
        state = {"stream_epoch": relay.stream_epoch, "oldest_seq": latest - 255, "latest_seq": latest}
        conn, response = self.open_speech(f"?after={relay.stream_epoch}-{first['stream_seq']}")
        lines = [json.loads(response.fp.readline()) for _ in range(258)]
        conn.close()
        self.assertEqual(lines[:2], [{"event": "stream.hello", **state},
                                     {"event": "stream.gap", "reason": "cursor_expired",
                                      "from": first["stream_seq"] + 1, "to": latest - 256, **state}])
        self.assertEqual([line["stream_seq"] for line in lines[2:]], list(range(latest - 255, latest + 1)))
        # Another process's cursor: no replay, live lines only.
        conn, response = self.open_speech("?after=0badc0de-5")
        relay._publish({"event": "speech.end", "seq": 303})
        lines = [json.loads(response.fp.readline()) for _ in range(3)]
        conn.close()
        self.assertEqual(lines, [{"event": "stream.hello", **state},
                                 {"event": "stream.reset", "reason": "other_process", **state},
                                 {"event": "speech.end", "seq": 303, "stream_seq": latest + 1}])
        conn, response = self.open_speech("?after=0badc0de-x")
        body = json.loads(response.read())
        conn.close()
        self.assertEqual((response.status, body), (400, {"error": "invalid_cursor"}))

    def test_speech_cancel_endpoint(self):
        class Relay:
            seq, epoch = 0, "1"
            calls = []

            def cancel_speech(self, speech_id, reason="client_cancel"):
                self.calls.append((speech_id, reason))
                return {"live": "cancelled", "old": "ended"}.get(speech_id, "unknown")

            def cancel(self, reason="client_cancel", immediate=False):
                self.calls.append((None, reason, immediate))
                return self.playing

            def utterance_of(self, speech_id):
                return None
        self.server.speech = Relay()
        self.server.events_token = "events"

        def post(body, token=UI):
            conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
            conn.request("POST", "/speech/cancel", body=json.dumps(body).encode(),
                         headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
            response = conn.getresponse()
            data = json.loads(response.read() or b"null")
            conn.close()
            return response.status, data
        self.assertEqual(post({"speech_id": "live", "reason": "client_cancel"}), (202, {"ok": True}))
        self.assertEqual(post({"speech_id": "old"})[0], 409)
        self.assertEqual(post({"speech_id": "zzz"})[0], 404)
        self.assertEqual(post({"speech_id": "live"}, token="events")[0], 401)
        self.assertEqual(post({"speech_id": 5})[0], 400)
        self.assertEqual(post({"speech_id": "live", "reason": "boom"})[0], 400)
        self.assertEqual(Relay.calls, [("live", "client_cancel"), ("old", "client_cancel"), ("zzz", "client_cancel")])
        Relay.calls.clear()
        Relay.playing = True
        self.assertEqual(post({"reason": "barge_in"}), (202, {"ok": True}))
        Relay.playing = False
        self.assertEqual(post({"reason": "barge_in"}), (404, {"error": "no_speech"}))
        self.assertEqual(post({"speech_id": None, "reason": "barge_in"})[0], 400)
        self.assertEqual(post({"reason": "barge_in"}, token="events")[0], 401)
        self.assertEqual(Relay.calls, [(None, "client_cancel", True), (None, "client_cancel", True)])
        # A cut by id, and each barge-in (it ends the turn), tell /events.
        self.assertEqual([(i["speech_id"], i["reason"]) for i in self.server.registry.intents_since(0)
                          if i.get("event") == "speech_cancelled"],
                         [("live", "client_cancel"), (None, "client_cancel"), (None, "client_cancel")])
        self.server.speech = None
        self.assertEqual(post({"speech_id": "live"})[0], 503)

    def test_speech_stream_off_without_tts(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        conn.request("GET", "/speech", headers={"Authorization": f"Bearer {UI}"})
        response = conn.getresponse()
        response.read()
        conn.close()
        self.assertEqual(response.status, 503)


# C6 local-only heartbeat fields with values that appear nowhere else, and those values as they would be written out.
RAW_SENSING = {"input": {"key_idle_s": 7193.5, "pointer_idle_s": 6271.25, "scroll_idle_s": 5839.75,
                         "click_idle_s": 4651.5, "keys_10s": 3917, "keys_60s": 9137, "clicks_10s": 2843,
                         "scrolls_30s": 1759, "moves_10s": 8461, "switches_60s": 6529, "near_clicks_10s": 5381},
               "mouse": {"app": "Finder", "bundle_id": "x.Finder", "pid": 2, "window_id": 5, "x": 4723, "y": 3187}}
RAW_SENSING_VALUES = [str(int(v)) for v in RAW_SENSING["input"].values()] + ["4723", "3187", "SECRETMIC"]


class SituationCategoryTest(unittest.TestCase):
    def test_behavior_category_matches_the_focus_bundle(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32") as tmp:
            server = AgentdServer.__new__(AgentdServer)
            server.attention = AttentionStore(Path(tmp) / "attention.sqlite", Blacklist(support.deny_blacklist(Path(tmp) / "blacklist.json")))
            self.addCleanup(server.attention.close)
            server.registry = SimpleNamespace(snapshot=lambda: {"focus": {"state": "idle"}})
            server.broker = SimpleNamespace(pending=lambda: [])
            server.focus = Focus()
            server.user_now = UserNow()
            server.clock = time.time
            now = time.time()
            front = {"app": "Arena", "bundle_id": "x.Arena", "window_id": 4,
                     "category": "public.app-category.action-games"}
            mouse = {"app": "Other", "bundle_id": "x.Other", "window_id": 5}
            for i in range(7):
                server.attention.ingest({"ts": now - 6 + i, "front": front, "mouse": mouse, "idle_s": 5.0})
            self.assertEqual(server.situation()["category"], "other")


class AttentionServerTest(FeedServerCase):
    request = SayTest.request
    say = SayTest.say

    def setUp(self):
        super().setUp()
        state = Path(self.tmp.name)
        self.server.attention = AttentionStore(state / "attention.sqlite", Blacklist(support.deny_blacklist(state / "blacklist.json")))
        self.addCleanup(self.server.attention.close)

    def beat(self, ts, app, title, **extra):
        body = {"ts": ts, "front": {"app": app, "bundle_id": f"x.{app}", "pid": 1, "window_id": hash(app) % 1000,
                                    "title": title},
                "mouse": None, "idle_s": 0.0, "locked": False, "asleep": False, "focus_role": None,
                "secure_input": False, **extra}
        return self.request("POST", "/context/attention", body)

    def test_heartbeat_flags_leave_the_gate_alone(self):
        self.server.gate = Gate(enabled=True)
        noon = datetime.datetime(2026, 10, 18, 12, 0)
        now = time.time()
        for extra in ({"fullscreen": True}, {"camera_active": True}, {"mic_active": True}, {"screen_captured": True},
                      {"user_speaking": True}):
            with self.subTest(extra=extra):
                self.assertEqual(self.beat(now, "Code", "x", **extra), (200, {}))
                self.assertIsNone(self.server.gate._reason("announce", noon))
        self.assertEqual(self.beat(now, "Code", "x", fullscreen="yes"), (400, {"error": "invalid_attention"}))

    def coarse(self, ts, **fields):
        return self.request("POST", "/user/coarse", {"ts": ts, "idle_s": 3, **fields})

    def test_user_nows_meeting_is_the_scenes(self):
        now = time.time()
        for i in range(3):
            self.assertEqual(self.beat(now - 2 + i, "Code", "x", camera_active=True,
                                       input={"keys_10s": 0}), (200, {}))
        self.assertNotEqual(self.server.activity()["activity"], "meeting")
        self.assertEqual(self.coarse(now, camera_active=True)[0], 200)
        scene = self.server.activity()
        self.assertEqual((scene["activity"], scene["confidence"], scene["can_interrupt"]), ("meeting", 0.9, False))

    def test_heartbeat_games_category_is_gaming(self):
        now = time.time()
        front = {"app": "Arena", "bundle_id": "x.Arena", "pid": 1, "window_id": 4, "title": "Arena",
                 "category": "public.app-category.action-games"}
        for i in range(3):
            self.assertEqual(self.request("POST", "/context/attention",
                                          {"ts": now - 2 + i, "front": front, "mouse": None, "idle_s": 0.0,
                                           "locked": False, "asleep": False, "input": {"keys_10s": 0}}), (200, {}))
        self.assertEqual(self.server.activity()["activity"], "gaming")

    def test_spatial_sees_a_meeting(self):
        now = time.time()
        for i in range(3):
            self.beat(now - 2 + i, "Code", "x", input={"keys_10s": 0})
        self.coarse(now, mic_active=True)
        self.assertEqual(self.server.spatial_situation()["activity"], "meeting")

    def test_the_behavior_tick_gets_the_declared_games_category(self):
        now = time.time()
        front = {"app": "Arena", "bundle_id": "x.Arena", "pid": 1, "window_id": 4, "title": "Arena",
                 "category": "public.app-category.action-games"}
        for i in range(7):  # a focus counts after GAZE_MIN
            self.request("POST", "/context/attention", {"ts": now - 6 + i, "front": front, "mouse": None,
                                                        "idle_s": 0.0, "locked": False, "asleep": False})
        self.assertEqual(self.server.situation()["category"], "game")

    def test_the_behavior_walk_hint_reaches_spatial(self):
        self.assertIsNone(self.server.spatial.walk_bias())  # no behavior tick yet
        self.server.behavior = type("B", (), {"walk_bias": lambda _self: "stay"})()
        self.assertEqual(self.server.spatial.walk_bias(), "stay")

    def test_situation_for_the_behavior_tick(self):
        now = time.time()
        for i in range(3):
            self.beat(now - 2 + i, "Code", "SECRET-TITLE")
            self.coarse(now - 2 + i)
        situation = self.server.situation()
        self.assertEqual({k: situation[k] for k in ("focus_state", "pending", "presence", "category")},
                         {"focus_state": "idle", "pending": 0, "presence": "active", "category": "other"})
        self.assertNotIn("SECRET-TITLE", json.dumps(situation, ensure_ascii=False))

    def test_situation_carries_spatials_scene_and_when_the_focus_went_busy(self):
        from test_registry import claude  # noqa: E402
        now = time.time()
        front = {"app": "Arena", "bundle_id": "x.Arena", "pid": 1, "window_id": 4, "title": "Arena",
                 "category": "public.app-category.action-games"}
        for i in range(3):
            self.request("POST", "/context/attention", {"ts": now - 2 + i, "front": front, "mouse": None,
                                                        "idle_s": 0.0, "locked": False, "asleep": False})
        self.assertIsNone(self.server.situation()["scene"])  # spatial has read no scene yet
        self.server.spatial_situation()
        situation = self.server.situation()
        self.assertEqual({k: situation[k] for k in ("scene", "meeting", "fullscreen", "typing", "busy_since")},
                         {"scene": "gaming", "meeting": False, "fullscreen": False, "typing": False,
                          "busy_since": None})
        self.server.registry.ingest(claude("UserPromptSubmit", now))
        since = self.server.situation()["busy_since"]
        self.assertIsNotNone(since)
        self.server.registry.ingest(claude("PreToolUse", now + 1, tool_name="Bash"))
        self.assertEqual(self.server.situation()["busy_since"], since)  # thinking to running_tool is no break
        self.server.registry.ingest(claude("Stop", now + 2))
        self.assertIsNone(self.server.situation()["busy_since"])

    def test_dispatch_results_reach_the_behavior_tick(self):
        kinds = []
        self.server.behavior = type("B", (), {"event": lambda _self, kind: kinds.append(kind)})()
        for kind in ("dispatch_done", "gate_fail", "dispatch_failed"):
            self.server.announce({"ts": 1.0, "level": "P1", "kind": kind, "headline": "h", "project": "/r",
                                  "session_id": None, "detail": None})
        self.assertEqual(kinds, ["dispatch_done", "dispatch_failed"])

    def test_a_voiced_back_line_counts_once_and_starts_no_comment_cooldown(self):
        gate = self.server.gate

        class P:
            def voiced(self, line_id):
                gate.commit("back")
                return True
        self.server.proactive = P()
        self.server._proactive_voiced("p-back")
        self.assertEqual((gate._count, "comment" in gate._last, "back" in gate._last), (1, False, True))

    def test_heartbeats_feed_the_summary(self):
        now = time.time()
        for i in range(11):
            self.assertEqual(self.beat(now - 30 + i, "Safari", "新闻"), (200, {}))
        for i in range(6):
            self.beat(now - 19 + i, "Code", "server.py")
        status, summary = self.request("GET", f"/attention/summary?since={now - 60}&by=app")
        self.assertEqual(status, 200)
        self.assertEqual([(i["key"], i["seconds"]) for i in summary["items"]], [("Safari", 11.0), ("Code", 5.0)])
        status, summary = self.request("GET", f"/attention/summary?since={now - 60}&by=title")
        self.assertEqual(summary["items"][0]["key"], "新闻")

    def test_summary_defaults_to_today_by_app(self):
        now = time.time()
        for i in range(3):
            self.beat(now - 5 + i, "Safari", "新闻")
        status, summary = self.request("GET", "/attention/summary")
        self.assertEqual((status, summary["items"][0]["key"]), (200, "Safari"))
        midnight = __import__("datetime").datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        self.assertEqual(summary["since"], midnight.timestamp())

    def test_bad_requests(self):
        self.assertEqual(self.request("POST", "/context/attention", {"ts": 1.0, "idle_s": 0}),
                         (400, {"error": "invalid_attention"}))
        self.assertEqual(self.request("POST", "/context/attention", {"ts": "x", "front": {"app": "a"}, "idle_s": 0}),
                         (400, {"error": "invalid_attention"}))
        self.assertEqual(self.request("GET", "/attention/summary?by=color"), (400, {"error": "invalid_by"}))
        self.assertEqual(self.request("GET", "/attention/summary", token=HOOK)[0], 401)
        self.assertEqual(self.request("POST", "/context/attention", {}, token=HOOK)[0], 401)

    def test_attention_rejects_unknown_input_key(self):
        now = time.time()
        for extra in ({"input": {"keys_10s": 3, "keycode": 4}}, {"input": {"last_key": "a"}},
                      {"input": {"near_click_at": [100, 50]}}):
            with self.subTest(extra=extra):
                self.assertEqual(self.beat(now, "Code", "x", **extra), (400, {"error": "invalid_attention"}))
        self.assertEqual(self.server.attention.events("window"), [])

    def test_attention_validates_the_rc_fields(self):
        now = time.time()
        good = {"input": {"key_idle_s": 0.5, "pointer_idle_s": 0, "scroll_idle_s": 3.2, "click_idle_s": 9,
                          "keys_10s": 12, "keys_60s": 40, "clicks_10s": 1, "scrolls_30s": 0, "moves_10s": 30,
                          "switches_60s": 2, "near_clicks_10s": 0},
                "front_audio_out": False, "edge": "unlock"}
        self.assertEqual(self.beat(now, "Code", "x", **good), (200, {}))
        self.assertEqual(self.beat(now + 1, "Code", "x", edge=None, front_audio_out=None, input={}), (200, {}))
        for extra in ({"input": {"keys_10s": -1}}, {"input": {"keys_10s": True}}, {"input": {"keys_10s": "3"}},
                      {"input": [1]}, {"input": None},
                      {"front_audio_out": 1}, {"edge": "logout"},
                      {"edge": 1}):
            with self.subTest(extra=extra):
                self.assertEqual(self.beat(now + 2, "Code", "x", **extra), (400, {"error": "invalid_attention"}))
        front = {"app": "Code", "bundle_id": "x.Code", "pid": 1, "window_id": 3, "title": "x"}
        for category, status in (("public.app-category.developer-tools", 200), (None, 200), (5, 400)):
            with self.subTest(category=category):
                body = {"ts": now + 3, "front": {**front, "category": category}, "mouse": None, "idle_s": 0.0}
                self.assertEqual(self.request("POST", "/context/attention", body)[0], status)
        self.assertEqual([e["ts"] for e in self.server.attention.inputs()], [now, now + 1, now + 3])
        self.assertEqual(self.server.attention.inputs()[-1]["category"], "public.app-category.developer-tools")

    def test_attention_validates_the_scene_fields(self):
        now = time.time()
        for i, good in enumerate(({"front_video": True, "front_gpu": 0.5, "screen_captured": False},
                                  {"front_video": None, "front_gpu": None, "screen_captured": None},
                                  {"front_gpu": 0}, {"front_gpu": 1})):
            with self.subTest(good=good):
                self.assertEqual(self.beat(now + i, "Code", "x", **good), (200, {}))
        for extra in ({"front_video": "yes"}, {"front_video": 1}, {"front_video": [True]},
                      {"front_gpu": "0.5"}, {"front_gpu": 1.5}, {"front_gpu": -0.1}, {"front_gpu": [0.5]},
                      {"front_gpu": True}, {"front_gpu": float("nan")},
                      {"screen_captured": "true"}, {"screen_captured": 0}, {"screen_captured": [False]}):
            with self.subTest(extra=extra):
                self.assertEqual(self.beat(now + 5, "Code", "x", **extra), (400, {"error": "invalid_attention"}))
        self.assertEqual([e["ts"] for e in self.server.attention.inputs()], [now, now + 1, now + 2, now + 3])

    def test_attention_accepts_beat_without_new_fields(self):
        now = time.time()
        for i in range(3):
            self.assertEqual(self.beat(now - 2 + i, "Code", "x"), (200, {}))
        self.assertEqual(self.server.attention.inputs(), [])
        self.assertEqual(len(self.server.attention.events("window")), 1)

    def test_delete_clears_everything(self):
        now = time.time()
        for i in range(3):
            self.beat(now - 5 + i, "Safari", "新闻")
        self.assertEqual(self.request("DELETE", "/attention", token=HOOK)[0], 401)
        status, body = self.request("DELETE", "/attention")
        self.assertEqual(status, 200)
        self.assertGreater(body["deleted"], 0)
        self.assertEqual(self.request("GET", "/attention/summary")[1]["items"], [])

    def test_mouth_context_names_apps_and_durations_but_no_titles(self):
        self.server.mouth = FakeMouth(["好。"])
        now = time.time()
        for i in range(121):
            self.beat(now - 130 + i, "Safari", "某个私密标题")
        conn, response = self.open_feed()
        self.say("今天在哪花了多少时间")
        self.lines_until_final(response)
        conn.close()
        context = self.server.mouth.calls[0][1]
        self.assertIn("Safari 2 min", context)
        self.assertNotIn("某个私密标题", context)

    def test_mouth_context_names_the_activity_and_its_titles_only_with_the_switch(self):
        now = time.time()
        front = {"app": "Code", "bundle_id": "com.microsoft.VSCode", "pid": 1, "window_id": 7, "title": "某个私密标题"}
        for i in range(30):
            self.request("POST", "/context/attention", {"ts": now - 29 + i, "front": front, "mouse": None,
                                                        "idle_s": 5.0, "locked": False, "asleep": False})
        for share in (False, True):
            with self.subTest(share=share):
                self.server.share_page_text = share
                used = []
                context = self.server._attention_context(used=used)
                self.assertTrue(context.startswith("Scene: editing_code (confidence 0.5)"), context)
                self.assertIn(("activity", None), used)
                (self.assertIn if share else self.assertNotIn)("某个私密标题", context)

    def test_attention_context_has_no_raw_input(self):
        self.server.mouth = FakeMouth(["好。"])
        self.server.share_page_text = True
        now = time.time()
        for i in range(30):
            self.assertEqual(self.beat(now - 29 + i, "Code", "x", **RAW_SENSING), (200, {}))
        conn, response = self.open_feed()
        self.say("我刚才在干嘛")
        self.lines_until_final(response)
        conn.close()
        [(text, context)] = self.server.mouth.calls
        self.assertIn("Scene: ", context)
        for raw in RAW_SENSING_VALUES:
            self.assertNotIn(raw, text + context)

    lines_until_final = SayTest.lines_until_final

    def browser(self, body, token=HOOK):
        return self.request("POST", "/context/browser", body, token)

    def test_browser_policy_and_numeric_ui_endpoint_permissions(self):
        self.assertEqual(self.request("GET", "/context/browser/policy", token=UI)[0], 401)
        status, policy = self.request("GET", "/context/browser/policy", token=HOOK)
        self.assertEqual((status, policy), (200, {"enabled": True, "text_enabled": False}))
        self.server.share_page_text = True
        self.assertTrue(self.request("GET", "/context/browser/policy", token=HOOK)[1]["text_enabled"])
        self.server.paused_until = self.server.clock() + 60
        self.assertFalse(self.request("GET", "/context/browser/policy", token=HOOK)[1]["enabled"])
        self.assertEqual(self.request("GET", "/attention/browser", token=HOOK)[0], 401)
        status, stats = self.request("GET", "/attention/browser", token=UI)
        self.assertEqual(status, 200)
        self.assertIsNone(stats["current"])

    def test_saved_web_permission_revokes_without_restart(self):
        config = Path(self.tmp.name) / "privacy.json"
        self.server.privacy_config = config
        self.server.share_page_text = True
        config.write_text('{"share_page_text": true}', encoding="utf-8")
        self.assertTrue(self.server.page_text_allowed())
        message = {"type": "page", "ts": time.time(), "url_host": "example.com", "text": "permitted"}
        self.browser(message)
        self.assertEqual(len(self.server.attention.context()), 1)
        config.write_text('{"share_page_text": false}', encoding="utf-8")
        self.assertFalse(self.request("GET", "/context/browser/policy", token=HOOK)[1]["text_enabled"])
        self.browser({**message, "text": "must not store"})
        self.assertEqual(len(self.server.attention.context()), 0, "revocation drops the earlier cache too")
        config.write_text('invalid JSON', encoding="utf-8")
        self.assertFalse(self.server.page_text_allowed())
        config.write_text('{"share_page_text": true}', encoding="utf-8")
        self.server.share_page_text = False
        self.assertFalse(self.server.page_text_allowed(), "enabling a wider scope still requires restart")

    def test_disabled_text_switch_rejects_old_extension_text_too(self):
        for kind in ("page", "selection"):
            self.assertEqual(self.browser({"type": kind, "ts": time.time(), "url_host": "example.com", "text": "secret"}), (200, {}))
        self.assertEqual(self.server.attention.context(), [])

    def test_browser_metrics_reject_payload_text_and_nonfinite_numbers(self):
        now = time.time()
        identity = {"browser_session": "S", "tab_id": 1, "document_id": "D", "revision": 1}
        heartbeat = {"type": "heartbeat", "ts": now, "url_host": "github.com", **identity}
        self.assertEqual(self.browser(heartbeat)[0], 200)
        metrics = {"scroll_percent": 30, "max_scroll_percent": 40, "tab_count": 3, "audible_tab_count": 0, "media": None}
        message = {**heartbeat, "type": "metrics", "metrics": metrics}
        self.assertEqual(self.browser(message)[0], 200)
        self.assertEqual(self.request("GET", "/attention/browser", token=UI)[1]["current"]["scroll_percent"], 30)
        for invalid in ({**metrics, "scroll_percent": float("nan")}, {**metrics, "text": "secret"},
                        {**metrics, "tab_count": True}, {**metrics, "scroll_percent": 101}):
            self.assertEqual(self.browser({**message, "metrics": invalid})[0], 400)
        self.assertEqual(self.browser({**heartbeat, "window_focused": "false"})[0], 400)
        self.assertEqual(self.browser({**heartbeat, "ts": float("inf")})[0], 400)
        self.assertNotIn("scroll_percent", self.server._attention_context())

    def test_browser_messages_need_the_hook_token_and_a_valid_body(self):
        heartbeat = {"type": "heartbeat", "ts": time.time(), "url_host": "github.com", "title": "PR",
                     "audible": False, "visible": True, "tab_id": 1, "window_focused": True}
        self.assertEqual(self.browser(heartbeat), (200, {}))
        self.assertEqual(self.browser(heartbeat, token=UI)[0], 401)
        self.assertEqual(self.browser({**heartbeat, "type": "cookie"}), (400, {"error": "invalid_browser"}))
        self.assertEqual(self.browser({**heartbeat, "ts": "now"}), (400, {"error": "invalid_browser"}))
        self.assertEqual(self.browser({"type": "page", "ts": time.time(), "url_host": "github.com", "title": "PR"}),
                         (400, {"error": "invalid_browser"}))
        self.assertEqual(len(self.server.attention.events("browser")), 1)

    def test_browser_identity_fields_are_typed_and_selection_cleared_needs_no_text(self):
        heartbeat = {"type": "heartbeat", "ts": time.time(), "url_host": "github.com", "title": "PR",
                     "browser_session": "S1", "tab_id": 1, "document_id": "D1", "revision": 1}
        self.assertEqual(self.browser(heartbeat), (200, {}))
        for bad in ({"browser_session": 1}, {"browser_session": "s" * 65}, {"tab_id": "1"}, {"tab_id": True},
                    {"document_id": 5}, {"document_id": "d" * 65}, {"revision": 0}, {"revision": 1.5},
                    {"revision": True}):
            self.assertEqual(self.browser({**heartbeat, **bad}), (400, {"error": "invalid_browser"}), bad)
        nulls = {"browser_session": None, "tab_id": None, "document_id": None, "revision": None}
        self.assertEqual(self.browser({**heartbeat, **nulls}), (200, {}))
        cleared = {"type": "selection_cleared", "ts": time.time(), "url_host": "github.com", "title": "PR",
                   "browser_session": "S1", "tab_id": 1, "document_id": "D1", "revision": 1}
        self.assertEqual(self.browser(cleared), (200, {}))

    def test_selection_reaches_the_mouth_only_with_the_switch(self):
        # Else the tick thread can take the switch's revocation and cut the next line while still applying it.
        self.server._stopped.set(); self.server._ticker.join(2)
        self.server.share_page_text = True
        self.server.mouth = FakeMouth(["好。"])
        self.browser({"type": "selection", "ts": time.time(), "url_host": "github.com", "title": "PR",
                      "text": "一段私密的选中文字"})
        self.browser({"type": "heartbeat", "ts": time.time(), "url_host": "github.com", "title": "PR"})
        for share in (False, True):
            self.server.share_page_text = share
            if share:
                # Widening cannot resurrect the selection discarded by the earlier revocation.
                self.browser({"type": "selection", "ts": time.time(), "url_host": "github.com", "title": "PR",
                              "text": "一段私密的选中文字"})
            conn, response = self.open_feed()
            self.say("这段什么意思")
            self.lines_until_final(response)
            conn.close()
        without, with_switch = self.server.mouth.calls[0][1], self.server.mouth.calls[1][1]
        self.assertNotIn("一段私密的选中文字", without)
        self.assertIn("一段私密的选中文字", with_switch)


class RawEventsServerTest(FeedServerCase):
    """POST /context/events and hook prompts into events_raw, on one injected clock."""
    request = SayTest.request
    hook = ServerTest.hook

    def setUp(self):
        super().setUp()
        state = Path(self.tmp.name)
        self.now = time.time()
        clock = lambda: self.now  # noqa: E731
        self.server.clock = clock
        self.server.attention = AttentionStore(state / "attention.sqlite", Blacklist(support.deny_blacklist(state / "blacklist.json")),
                                               clock=clock)
        self.addCleanup(self.server.attention.close)

    def event(self, ago=0.0, **extra):
        return {"ts": self.now - ago, "kind": "value", "app": "Code", "bundle_id": "x.Code", "pid": 1,
                "window": "server.py", "url_host": None, "doc": "/w/server.py", "role": "AXTextArea", "subrole": None,
                "label": "编辑器", "value": "写一半", "value_len": 3, "shrink": 0, "edits": 1, **extra}

    def post(self, *events, token=UI):
        return self.request("POST", "/context/events", {"events": list(events)}, token)

    def rows(self):
        return self.server.attention.db.execute(
            "SELECT kind, app, doc, url_host, value, value_len FROM events_raw ORDER BY ts, id").fetchall()

    def test_the_hook_token_is_refused(self):
        self.assertEqual(self.post(self.event(), token=HOOK)[0], 401)
        self.assertEqual(self.rows(), [])

    def test_a_pause_stores_nothing(self):
        self.server.paused_until = self.now + 60
        self.assertEqual(self.post(self.event()), (200, {"paused": True}))
        self.assertEqual(self.rows(), [])

    def test_observation_off_stores_nothing(self):
        self.enterContext(unittest.mock.patch.dict("infra.plugins.resolved", screen_awareness=False))
        self.assertEqual(self.post(self.event()), (409, {"error": "plugin_off", "plugin": "screen_awareness"}))
        self.assertEqual(self.rows(), [])

    def test_a_meeting_drops_events_sent_after_it_ends(self):
        meeting = lambda on: self.request("PUT", "/observation/meeting", {"on": on})  # noqa: E731
        self.assertEqual(meeting(True), (200, {"meeting": True}))
        self.now += 10
        self.assertEqual(self.post(self.event()), (200, {"paused": True}))
        self.assertEqual(self.request("PUT", "/observation/paused", {"minutes": 1})[0], 200)
        self.now += 10
        self.assertEqual(self.request("PUT", "/observation/paused", {"minutes": 0})[0], 200)
        self.now += 10
        self.assertEqual(self.post(self.event()), (200, {"paused": True}))  # the pause ended, the meeting did not
        self.assertEqual(meeting(False), (200, {"meeting": False}))
        self.now += 1
        self.assertEqual(self.post(self.event(25), self.event(6), self.event()), (200, {"stored": 1, "dropped": 2}))
        self.assertEqual(len(self.rows()), 1)

    def test_value_is_kept_only_with_typed_text(self):
        self.assertEqual(self.post(self.event(1)), (200, {"stored": 1, "dropped": 0}))
        self.server.share_typed_text = True
        self.assertEqual(self.post(self.event()), (200, {"stored": 1, "dropped": 0}))
        self.assertEqual([r[4] for r in self.rows()], [None, "写一半"])

    def test_bad_events_are_dropped_one_by_one(self):
        self.server.share_typed_text = True
        bad = [self.event(bundle_id="com.1password.1password"), self.event(kind="prompt"), self.event(kind="key"),
               self.event(601), self.event(-6), self.event(app=None), self.event(pid="1"), self.event(edits=-1),
               self.event(label=3), "x"]
        self.assertEqual(self.post(*bad, self.event(value="字" * 600, url_host="a.com/path", app="C" * 200)),
                         (200, {"stored": 1, "dropped": len(bad)}))
        [(kind, app, _, host, value, _)] = self.rows()
        self.assertEqual((kind, len(app), host, len(value)), ("value", 128, None, 600))

    def test_batch_shape_and_size(self):
        self.assertEqual(self.post(*[self.event()] * 201), (400, {"error": "too_many_events"}))
        for body in ([], {"events": {}}, {"events": []}):
            with self.subTest(body=body):
                self.assertEqual(self.request("POST", "/context/events", body), (400, {"error": "invalid_events"}))
        self.assertEqual(self.post(*[self.event()] * 200), (200, {"stored": 200, "dropped": 0}))

    def test_delete_observation_and_attention_take_the_rows(self):
        self.server.attention.ingest_events([self.event(1000), self.event(10)])
        self.assertEqual(self.request("DELETE", "/observation?range=15m")[0], 200)
        self.assertEqual(len(self.rows()), 1)
        self.assertEqual(self.request("DELETE", "/attention")[0], 200)
        self.assertEqual(self.rows(), [])

    def test_a_shared_session_prompt_is_kept_only_with_typed_text(self):
        self.server.share_agent_sessions = True
        self.assertEqual(self.hook("claude", "UserPromptSubmit", prompt="帮我看看"), (200, {}))
        self.assertEqual(self.rows(), [("prompt", "claude", "/w", None, None, 4)])
        self.server.share_typed_text = True
        self.assertEqual(self.hook("codex", "UserPromptSubmit", session="B", prompt="长" * 600), (200, {}))
        self.assertEqual(self.hook("claude", "UserPromptSubmit", session="C", prompt=""), (200, {}))
        self.assertEqual(self.rows(), [("prompt", "claude", "/w", None, None, 4),
                                       ("prompt", "codex", "/w", None, "长" * 500, 600)])

    def test_a_pause_keeps_no_prompt(self):
        self.server.share_typed_text = True
        self.server.paused_until = self.now + 60
        self.assertEqual(self.hook("claude", "UserPromptSubmit", prompt="帮我看看"), (200, {}))
        self.assertEqual(self.rows(), [])

    def agent_rows(self, n=1):
        """(kind, role, subrole, window, label, value, value_len) of each row, once there are n."""
        for _ in range(200):
            rows = self.server.attention.db.execute(
                "SELECT kind, role, subrole, window, label, value, value_len FROM events_raw ORDER BY ts, id").fetchall()
            if len(rows) >= n:
                return rows
            time.sleep(0.01)
        return rows

    def test_a_prompt_in_angle_brackets_is_not_the_users_without_a_transcript(self):
        self.server.share_typed_text = True
        self.assertEqual(self.hook("claude", "UserPromptSubmit", prompt=" <task-notification>完成</task-notification>"),
                         (200, {}))
        self.assertEqual(self.agent_rows(), [("agent", "notification", "system", None, "A", None, None)])

    def test_a_finished_tool_is_an_agent_row_with_its_summary(self):
        self.assertEqual(self.hook("claude", "PostToolUse", tool_name="Bash", tool_input={"command": "x" * 300}),
                         (200, {}))
        self.assertEqual(self.agent_rows(), [("agent", "tool", "Bash", None, "A", "x" * 200, None)])

    def test_no_metadata_leaves_the_window_empty(self):
        missing = str(Path(self.tmp.name) / "none")
        self.server.agent_meta = AgentMeta()
        self.assertEqual(self.hook("claude", "Notification", notification_type="idle_prompt",
                                   transcript_path=missing + ".jsonl"), (200, {}))
        self.assertEqual(self.agent_rows(), [("agent", "waiting", None, None, "A", None, None)])

    def test_agent_rows_stay_out_of_the_user_state(self):
        self.server.attention.ingest_events([self.event(5)])
        agent = {"ts": self.now - 1, "kind": "agent", "app": "claude", "role": "tool", "value": "ls"}
        self.server.attention.ingest_events([agent] * 500)
        with unittest.mock.patch.object(user_state, "derive", wraps=user_state.derive) as derive:
            self.server.activity()
        events = derive.call_args.args[0]
        self.assertEqual([e["kind"] for e in events], ["value"])

    def test_attention_context_names_the_users_state_within_consent(self):
        repo = Path(self.tmp.name) / "Endfield"
        (repo / ".git").mkdir(parents=True)
        front = {"app": "Code", "bundle_id": "com.microsoft.VSCode", "pid": 1, "window_id": 2, "title": "a.py"}
        for i in range(10):
            self.server.attention.ingest({"ts": self.now - 9 + i, "front": front, "mouse": None, "idle_s": 1.0,
                                          "locked": False, "asleep": False})
        error = "error: cannot find module 'foo' at /w/src/{}.py:{}"
        terminal = {"app": "Terminal", "bundle_id": "com.apple.Terminal", "doc": None}
        self.server.attention.ingest_events(
            [self.event(300 - 100 * i, **terminal, value=error.format(i, i)) for i in range(3)]
            + [self.event(20, kind="window", bundle_id="com.microsoft.VSCode", doc=str(repo / "a.py"), value=None),
               self.event(10, role="AXSearchField", value="foo 模块找不到")])
        context = self.server._attention_context()
        self.assertIn("\nInferred state: coding, stuck\n", context)
        for hidden in ("working on", "recently typed", "stuck on"):
            self.assertNotIn(hidden, context)
        self.server.share_page_text = True
        context = self.server._attention_context()
        self.assertIn("\nInferred state: coding, stuck, working on: Endfield\n", context)
        for hidden in ("recently typed", "stuck on"):
            self.assertNotIn(hidden, context)
        self.server.share_typed_text = True
        used = []
        context = self.server._attention_context(used=used)
        self.assertIn("\nInferred state: coding, stuck, working on: Endfield; recently typed: \"foo 模块找不到\" (a search box, 10 s ago)"
                      "; stuck on: \"error: cannot find module 'foo' at /w/src/2.py:2\"\n", context)
        self.assertEqual(used.count(("activity", None)), 1)
        scene = self.server.activity()
        self.assertEqual((scene["mode"], scene["state"], scene["thread"], scene["on_mind"]["source"]),
                         ("coding", "stuck", "Endfield", "search"))
        shown = self.request("GET", "/diag/state")[1]["context"]["activity"]
        self.assertEqual((shown["mode"], shown["state"]), ("coding", "stuck"))
        self.assertIn("repeat_error", shown["evidence"])

    def test_attention_context_keeps_work_out_while_the_user_relaxes(self):
        live = self.server.activity
        for mode, said in (("relaxing", True), ("coding", False)):
            with self.subTest(mode=mode):
                self.server.activity = lambda: {**live(), "mode": mode}
                context = self.server._attention_context()
                self.assertIn("\nInferred state: " + mode, context)
                self.assertEqual("The user is relaxing: keep to light topics and don't bring up work, code or to-dos" in context, said)


class FakeSemanticJudge:
    def __init__(self, result):
        self.result, self.calls = result, []

    def run(self, task, instructions, evidence, **kwargs):
        self.calls.append((task,instructions,evidence['observation']))
        return {'value':self.result}


class HarnessJudgmentTest(FeedServerCase):
    """activity() derives user state locally without asking the selected role harness."""
    request = SayTest.request

    def setUp(self):
        super().setUp()
        state = Path(self.tmp.name)
        self.now = time.time()
        clock = lambda: self.now  # noqa: E731
        self.server.clock = clock
        self.server.attention = AttentionStore(state / "attention.sqlite", Blacklist(support.deny_blacklist(state / "blacklist.json")),
                                               clock=clock)
        self.addCleanup(self.server.attention.close)

        def select(fake):
            self.server.character_agent=SimpleNamespace(semantic=fake,cancel=lambda *args,**kwargs:None,close=lambda:None)
            return fake
        self.select=select
        front = {"app": "Notes", "bundle_id": "com.example.notes", "pid": 1, "window_id": 5, "title": "笔记"}
        for i in range(10):
            self.server.attention.ingest({"ts": self.now - 9 + i, "front": front, "mouse": None, "idle_s": 1.0,
                                          "locked": False, "asleep": False})

    def test_an_unknown_state_stays_unknown_without_model_calls(self):
        fake = self.select(FakeSemanticJudge({"mode": "reading", "state": "flowing", "on_mind": "",
                                                    "confidence": 0.9}))
        for seconds in (0, 30, 31, 60):
            self.now += seconds
            scene = self.server.activity()
            self.assertEqual((scene["mode"], scene["state"]), ("other", "unknown"))
            self.assertEqual(fake.calls, [])
            self.assertIsNone(self.server._judgment)

    def test_deleting_observations_clears_the_rule_derived_state(self):
        self.server.share_typed_text = True
        fake = self.select(FakeSemanticJudge({"mode": "reading", "state": "flowing", "confidence": 0.9}))
        self.server.attention.ingest_events([
            {"ts": self.now - 3 + i, "kind": "value", "app": "Notes", "bundle_id": "com.example.notes",
             "window": "笔记", "role": "AXTextArea", "label": "body", "value": "a" * length,
             "shrink": 0, "edits": 1}
            for i, length in enumerate((10, 40, 70))])
        scene = self.server.activity()
        self.assertEqual((scene["mode"], scene["state"]), ("writing", "flowing"))
        self.assertIsNotNone(scene["on_mind"])
        self.assertEqual(self.request("DELETE", "/observation?range=15m")[0], 200)
        scene = self.server.activity()
        self.assertEqual((scene["mode"], scene["state"]), ("other", "unknown"))
        self.assertIsNone(scene["on_mind"])
        self.assertIsNone(scene["before_away"])
        self.assertEqual(fake.calls, [])
        self.assertIsNone(self.server._judgment)

    def test_a_cached_judgment_does_not_override_rules_in_later_activity(self):
        fake = self.select(FakeSemanticJudge({"mode": "reading", "state": "flowing", "on_mind": "x",
                                                    "confidence": 0.9}))
        self.server._judgment = {**fake.result, "ts": self.now}
        for seconds in (0, 1, user_state.HOLD):
            self.now += seconds
            scene = self.server.activity()
            self.assertEqual((scene["mode"], scene["state"]), ("other", "unknown"))
            self.assertNotIn("character_agent", scene["evidence"])
            self.assertEqual(fake.calls, [])

    def test_without_a_model_nothing_is_asked(self):
        self.server.character_agent = None
        self.assertEqual(self.server.activity()["state"], "unknown")
        self.assertIsNone(self.server._judgment)


class UserStateForgetTest(FeedServerCase):
    """Deleting observations or revoking consent also drops the user state held in memory."""
    request = SayTest.request

    def setUp(self):
        super().setUp()
        state = Path(self.tmp.name)
        self.now = time.time()
        clock = lambda: self.now  # noqa: E731
        self.server.clock = clock
        self.server.attention = AttentionStore(state / "attention.sqlite", Blacklist(support.deny_blacklist(state / "blacklist.json")),
                                               clock=clock)
        self.addCleanup(self.server.attention.close)

    def held(self):
        state = {"mode": "coding", "state": "stuck", "evidence": [], "thread": "repo", "on_mind": None,
                 "blocker": "error: x"}
        self.server.user_state.update(state, self.now - 2)
        return self.server.user_state.update({**state, "mode": "away", "blocker": None}, self.now - 1,
                                             absence={"id": "1-1", "since": self.now - 1})["before_away"]

    def test_each_way_of_forgetting_drops_the_held_state(self):
        forget = {"observation": lambda: self.request("DELETE", "/observation?range=15m"),
                  "attention": lambda: self.request("DELETE", "/attention"),
                  "typed_text": lambda: self.server.sync_privacy(["typed_text"]),
                  "blacklist": lambda: self.request("POST", "/blacklist",
                                                    {"field": "bundle_ids", "value": "x.Code", "delete_existing": True})}
        for name, call in forget.items():
            with self.subTest(name):
                self.assertIsNotNone(self.held())
                call()
                self.assertIsNone(self.server.user_state.update(
                    {"mode": "reading", "state": "unknown", "evidence": [], "thread": None, "on_mind": None,
                     "blocker": None}, self.now)["before_away"])


class EpisodeServerTest(FeedServerCase):
    """Deleting observations takes the episodes written from them; beats drive the episode writer."""
    request = SayTest.request
    beat = AttentionServerTest.beat

    def setUp(self):
        super().setUp()
        state = Path(self.tmp.name)
        self.now = time.time()
        clock = lambda: self.now  # noqa: E731
        self.server.clock = clock
        self.server.attention = AttentionStore(state / "attention.sqlite", Blacklist(support.deny_blacklist(state / "blacklist.json")),
                                               clock=clock)
        self.addCleanup(self.server.attention.close)
        self.db = open_store(state / "agentd.sqlite")
        self.addCleanup(self.db.close)
        self.server.episodes = Episodes(self.db)
        code = {"title": "写代码", "description": "你在写代码。", "projects": [{"subject": "写代码"}],
                "requires": ["page_text"]}
        support.add_episode(self.server.episodes, self.now - 7200, self.now - 6600, **code, apps=["x.Code", "Code"])
        support.add_episode(self.server.episodes, self.now - 1800, self.now - 1200, **code, apps=["x.Safari", "Safari"],
                            hosts=["a.com"])

    def kept(self):
        return [r["apps"][0] for r in self.server.episodes.between(0, self.now)]

    def test_deleting_an_hour_takes_its_episodes_and_counts_them(self):
        status, body = self.request("DELETE", "/observation?range=1h")
        self.assertEqual((status, body["episodes"]), (200, 1))
        self.assertEqual(self.kept(), ["x.Code"])

    def test_deleting_the_attention_records_clears_the_episodes(self):
        self.assertEqual(self.request("DELETE", "/attention")[0], 200)
        self.assertEqual(self.kept(), [])

    def test_a_blacklist_entry_that_deletes_existing_records_takes_its_episodes(self):
        body = {"field": "bundle_ids", "value": "x.Code", "delete_existing": True}
        self.assertEqual(self.request("POST", "/blacklist", body)[0], 200)
        self.assertEqual(self.kept(), ["x.Safari"])
        body = {"field": "domains", "value": "a.com", "delete_existing": False}
        self.assertEqual(self.request("POST", "/blacklist", body)[0], 200)
        self.assertEqual(self.kept(), ["x.Safari"])

    def test_a_title_pattern_takes_the_episodes_whose_text_matches_it(self):
        support.add_episode(self.server.episodes, self.now - 900, self.now - 300, "看账单", "你在看「招商银行 - 账单」。",
                            [{"subject": "信用卡", "outcome": "看完"}], apps=["x.Chrome"])
        body = {"field": "title_patterns", "value": "银行", "delete_existing": True}
        self.assertEqual(self.request("POST", "/blacklist", body)[0], 200)
        self.assertEqual(self.kept(), ["x.Code", "x.Safari"])

    def test_day_arc_needs_page_text_and_episodes(self):
        day = datetime.date.fromtimestamp(self.now - 1800).isoformat()
        self.assertIsNone(self.server.day_arc(day))
        self.server.share_page_text = True
        self.assertIn("写代码", self.server.day_arc(day))
        self.server.episodes = None
        self.assertIsNone(self.server.day_arc(day))

    def test_revoking_typed_text_takes_the_episodes_with_typed_text(self):
        support.add_episode(self.server.episodes, self.now - 900, self.now - 300, "写消息", "你在写消息。",
                            [{"subject": "写消息"}], requires=["page_text", "typed_text"], apps=["x.Notes"])
        self.server.sync_privacy(["typed_text"])
        self.assertEqual(self.kept(), ["x.Code", "x.Safari"])
        self.server.sync_privacy(["page_text"])
        self.assertEqual(self.kept(), [])

    def test_beats_wake_native_memory_using_local_time_and_pause_suppresses_wakes(self):
        calls=[]
        self.server.character_agent=SimpleNamespace(memory_pipeline=SimpleNamespace(clock=lambda:123,tick=lambda ts:calls.append(ts)))
        self.assertEqual(self.beat(self.now,'Code','x'),(200,{}))
        self.assertEqual(self.beat(self.now+1,'Code','x',edge='lock'),(200,{}))
        self.assertEqual(calls,[123,123])
        self.server.paused_until=self.now+60
        self.assertEqual(self.beat(self.now+2,'Code','x'),(200,{'paused':True}))
        self.assertEqual(calls,[123,123]);self.server.character_agent=None


class ObservationControlTest(FeedServerCase):
    """Observation pause and blacklist over HTTP, on one injected clock."""
    request = SayTest.request
    beat = AttentionServerTest.beat
    browser = AttentionServerTest.browser

    def setUp(self):
        super().setUp()
        state = Path(self.tmp.name)
        self.server.share_page_text = True  # These fixtures exercise permitted text capture.
        self.now = time.time()
        clock = lambda: self.now  # noqa: E731
        self.server.clock = clock
        self.server.share_page_text = True
        self.server.attention = AttentionStore(state / "attention.sqlite",
                                               Blacklist(support.deny_blacklist(state / "blacklist.json")), clock=clock)
        self.addCleanup(self.server.attention.close)
        self.server.capture = CaptureManager(self.server.feed, self.server.attention.blacklist,
                                             lambda: {"window_id": 2, "app": "Code", "bundle_id": "x.Code"}, None,
                                             clock=clock, vision=SimpleNamespace(describe=lambda png, user: "代码"))

    def test_quiet_ends_meeting_and_pause_on_the_clock_without_a_request(self):
        until = self.now + 1800
        status, body = self.request("PUT", "/observation/quiet", {"until": until})
        self.assertEqual(status, 200)
        self.assertAlmostEqual(datetime.datetime.fromisoformat(body["quiet_until"]).timestamp(), until, places=2)
        self.assertEqual(self.server.observation_state(),
                         {"paused_until": body["quiet_until"], "quiet_until": body["quiet_until"],
                          "meeting": True, "off": False})
        self.assertTrue(self.server.gate.meeting_manual)
        self.assertTrue(self.server.observation_paused())
        self.assertTrue(self.server.polls_paused())
        self.now = until
        self.assertFalse(self.server.observation_paused())
        self.assertFalse(self.server.gate.meeting_manual)
        self.assertFalse(self.server.polls_paused())
        self.assertEqual(self.server.observation_state(),
                         {"paused_until": None, "quiet_until": None, "meeting": False, "off": False})
        self.assertFalse(self.server.paused_at(until + 1))

    def test_ending_quiet_early_restores_the_previous_meeting_switch(self):
        for meeting in (False, True):
            with self.subTest(meeting=meeting):
                self.server.set_meeting(meeting)
                self.assertEqual(self.request("PUT", "/observation/quiet", {"until": self.now + 1800})[0], 200)
                self.assertEqual(self.request("PUT", "/observation/quiet", {"until": self.now + 3600})[0], 200)
                self.now += 60
                self.assertEqual(self.request("PUT", "/observation/quiet", {"until": None}),
                                 (200, {"quiet_until": None}))
                self.assertEqual(self.server.gate.meeting_manual, meeting)
                self.assertEqual(self.server.observation_paused(), meeting)
                self.assertIsNone(self.server.observation_state()["paused_until"])
                self.assertFalse(self.server.polls_paused())

    def test_quiet_expiry_keeps_a_preexisting_meeting(self):
        self.server.set_meeting(True)
        self.assertEqual(self.request("PUT", "/observation/quiet", {"until": self.now + 1800})[0], 200)
        self.now += 1800
        self.assertIsNone(self.server.observation_state()["quiet_until"])
        self.assertTrue(self.server.gate.meeting_manual)
        self.assertTrue(self.server.observation_paused())

    def test_quiet_rejects_invalid_end_times(self):
        for bad in ({"until": self.now - 1}, {"until": self.now}, {"until": self.now + 86401},
                    {"until": "later"}, {"until": True}, {"until": []}, {"until": float("nan")},
                    {"until": float("inf")}, {}, []):
            with self.subTest(bad=bad):
                self.assertEqual(self.request("PUT", "/observation/quiet", bad),
                                 (400, {"error": "invalid_payload"}))
        self.assertEqual(self.request("PUT", "/observation/quiet", {"until": self.now + 86400})[0], 200)

    def test_pause_stores_nothing_refuses_looks_and_ends_by_itself(self):
        beats = []
        self.server.proactive = SimpleNamespace(beat=beats.append)
        self.server.gate = Gate(enabled=True)
        self.assertEqual(self.beat(self.now, "Code", "x", camera_active=True), (200, {}))
        self.assertEqual(self.request("POST", "/user/coarse", {"ts": self.now, "idle_s": 0, "camera_active": True})[0], 200)
        status, body = self.request("PUT", "/observation/paused", {"minutes": 60})
        self.assertEqual(status, 200)
        self.assertAlmostEqual(datetime.datetime.fromisoformat(body["paused_until"]).timestamp(), self.now + 3600,
                               places=2)
        self.assertEqual(self.request("GET", "/state")[1]["observation"],
                         {"paused_until": body["paused_until"], "quiet_until": None, "meeting": False, "off": False})
        stored = len(self.server.attention.events("window"))
        self.now += 1
        page = {"type": "page", "ts": self.now, "url_host": "github.com", "title": "PR", "text": "正文"}
        self.assertEqual(self.beat(self.now, "Safari", "新闻"), (200, {"paused": True}))
        self.assertEqual(self.browser(page), (200, {"paused": True}))
        self.assertEqual(self.request("POST", "/context/text", {"window_id": 2, "app": "Code", "text": "x",
                                                                "source": "ax"}), (200, {"paused": True}))
        self.assertEqual(self.request("POST", "/context/image", {"request_id": "r", "window_id": 2,
                                                                 "error": "capture_failed"}), (200, {"paused": True}))
        self.assertEqual(len(self.server.attention.events("window")), stored)
        self.assertEqual(self.server.attention.context(), [])
        self.assertEqual(len(beats), 1)  # proactive saw only the beat before the pause
        self.assertEqual(self.request("POST", "/user/coarse", {"ts": self.now, "idle_s": 0})[0], 200)
        self.assertTrue(self.server.gate.meeting)  # the paused coarse beat's flags were not applied
        self.assertEqual(self.request("POST", "/look", {}),
                         (409, {"error": "paused", "reason": "paused", "status": "unavailable"}))
        self.assertEqual(self.server.capture.observations, {})
        self.now += 3600
        self.assertEqual(self.beat(self.now, "Safari", "新闻"), (200, {}))
        self.assertEqual(self.request("POST", "/user/coarse", {"ts": self.now, "idle_s": 0})[0], 200)
        self.assertEqual(self.browser({**page, "ts": self.now}), (200, {}))
        self.assertEqual(len(self.server.attention.events("window")), stored + 1)
        self.assertEqual(len(self.server.attention.context()), 1)
        self.assertEqual((len(beats), self.server.gate.meeting), (2, False))
        self.assertEqual(self.request("POST", "/look", {})[0], 202)
        self.assertEqual(self.request("GET", "/state")[1]["observation"],
                         {"paused_until": None, "quiet_until": None, "meeting": False, "off": False})

    def test_meeting_mode_pauses_observation_until_it_is_turned_off(self):
        self.assertEqual(self.request("PUT", "/observation/meeting", {"on": True}), (200, {"meeting": True}))
        self.assertTrue(self.server.observation_paused())  # EpisodeWriter's paused(): no activity summaries
        page = {"type": "page", "ts": self.now, "url_host": "github.com", "title": "PR", "text": "正文"}
        self.assertEqual(self.beat(self.now, "Code", "x"), (200, {"paused": True}))
        self.assertEqual(self.browser(page), (200, {"paused": True}))
        self.assertEqual(self.server.attention.events("window"), [])
        self.assertEqual(self.server.attention.context(), [])
        self.assertEqual(self.request("POST", "/look", {}),
                         (409, {"error": "paused", "reason": "paused", "status": "unavailable"}))
        self.assertEqual(self.request("GET", "/state")[1]["observation"],
                         {"paused_until": None, "quiet_until": None, "meeting": True, "off": False})
        self.now += 86400
        self.assertTrue(self.server.observation_paused())
        self.assertEqual(self.request("PUT", "/observation/meeting", {"on": False}), (200, {"meeting": False}))
        self.now += 1
        self.assertFalse(self.server.observation_paused())
        self.assertEqual(self.beat(self.now, "Code", "x"), (200, {}))
        self.assertEqual(len(self.server.attention.events("window")), 1)

    def test_observation_off_stores_nothing_and_shows_off_in_state(self):
        self.assertIs(self.request("GET", "/state")[1]["observation"]["off"], False)
        self.enterContext(unittest.mock.patch.dict("infra.plugins.resolved", screen_awareness=False))
        page = {"type": "page", "ts": self.now, "url_host": "github.com", "title": "PR", "text": "正文"}
        self.assertEqual(self.beat(self.now, "Code", "x"), (409, {"error": "plugin_off", "plugin": "screen_awareness"}))
        self.assertEqual(self.browser(page), (409, {"error": "plugin_off", "plugin": "screen_awareness"}))
        self.assertEqual(self.server.attention.events("window"), [])
        self.assertEqual(self.server.attention.context(), [])
        self.assertEqual(self.request("GET", "/state")[1]["observation"],
                         {"paused_until": None, "quiet_until": None, "meeting": False, "off": True})

    def test_pause_zero_resumes_and_bad_bodies_are_400(self):
        self.assertEqual(self.request("PUT", "/observation/paused", {"minutes": 30})[0], 200)
        self.assertEqual(self.request("PUT", "/observation/paused", {"minutes": 0}), (200, {"paused_until": None}))
        self.assertEqual(self.beat(self.now, "Code", "x"), (200, {}))
        for bad in ({"minutes": -1}, {"minutes": 1441}, {"minutes": True}, {"minutes": "5"}, {"minutes": 1.5}, {}):
            with self.subTest(bad=bad):
                self.assertEqual(self.request("PUT", "/observation/paused", bad), (400, {"error": "invalid_payload"}))
        self.assertEqual(self.request("PUT", "/observation/meeting", {"on": "yes"}), (400, {"error": "invalid_payload"}))
        self.assertEqual(self.request("PUT", "/observation/paused", {"minutes": 5}, token=HOOK)[0], 401)
        self.assertEqual(self.request("PUT", "/observation/meeting", {"on": True}, token=HOOK)[0], 401)

    def test_a_pause_outlives_a_restart_until_it_ends(self):
        from personal.memory import Memory
        db = Path(self.tmp.name) / "agentd.sqlite"
        self.server.memory = Memory(open_store(db))

        def restarted():
            server = AgentdServer(("127.0.0.1", 0), HOOK, UI)
            self.addCleanup(server.server_close)
            server.clock, server.memory = self.server.clock, Memory(open_store(db))
            server.load_pause()  # as main() does once the memory is open
            return server.observation_state()["paused_until"]

        status, body = self.request("PUT", "/observation/paused", {"minutes": 60})
        self.assertEqual(status, 200)
        self.assertEqual(restarted(), body["paused_until"])
        self.now += 3600
        self.assertIsNone(restarted())
        self.now -= 3600
        self.assertEqual(self.request("PUT", "/observation/paused", {"minutes": 0}), (200, {"paused_until": None}))
        self.assertIsNone(restarted())

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_blacklist_add_can_delete_what_it_now_hides(self):
        for app, at in (("Safari", 30), ("Code", 20), ("Notes", 10)):
            for i in range(3):
                self.assertEqual(self.beat(self.now - at + i, app, "标题"), (200, {}))
        self.browser({"type": "page", "ts": self.now - 5, "url_host": "github.com", "title": "PR", "text": "正文"})
        self.browser({"type": "heartbeat", "ts": self.now - 5, "url_host": "github.com", "title": "PR"})
        self.request("POST", "/context/text", {"window_id": 5, "app": "Safari", "bundle_id": "x.Safari",
                                                "title": "新闻", "text": "短", "source": "ax"})
        seen = [r for r in self.server.capture.observations_snapshot() if r["window_id"] == 5]
        self.assertTrue(seen)
        apps = lambda: [e["data"].get("app") for b in ("window", "focus")  # noqa: E731
                        for e in self.server.attention.events(b)]
        self.assertEqual(apps().count("Safari"), 2)

        added = lambda field, value, delete: self.request(  # noqa: E731
            "POST", "/blacklist", {"field": field, "value": value, "delete_existing": delete})
        self.assertEqual(added("bundle_ids", "x.Safari", True),
                         (200, {"added": True, "deleted": {"events": 2, "context": 0, "observations": len(seen)}}))
        self.assertEqual(apps().count("Safari"), 0)
        self.assertEqual((apps().count("Code"), apps().count("Notes")), (2, 2))
        self.assertEqual([r for r in self.server.capture.observations_snapshot() if r["window_id"] == 5], [])

        self.assertEqual(added("bundle_ids", "x.Notes", False),
                         (200, {"added": True, "deleted": {"events": 0, "context": 0, "observations": 0}}))
        self.assertEqual(apps().count("Notes"), 2)
        self.beat(self.now + 10, "Notes", "标题")
        self.assertEqual(self.server.attention.events("window")[-1]["data"], {"app": "<hidden>"})
        self.assertEqual(added("bundle_ids", "x.Safari", True),
                         (200, {"added": False, "deleted": {"events": 0, "context": 0, "observations": 0}}))

        self.assertEqual(added("domains", "github.com", True),
                         (200, {"added": True, "deleted": {"events": 1, "context": 1, "observations": 0}}))
        self.assertEqual((self.server.attention.events("browser"), self.server.attention.context()), ([], []))
        self.assertEqual(apps().count("Notes"), 2)  # only what the new entry hides goes

        self.assertEqual(added("title_patterns", "(", False), (400, {"error": "invalid_pattern"}))
        self.assertEqual(added("title_patterns", "工资", False)[0], 200)
        for bad in ({"field": "colors", "value": "x", "delete_existing": False},
                    {"field": "domains", "value": "", "delete_existing": False},
                    {"field": "domains", "value": "x" * 201, "delete_existing": False},
                    {"field": "domains", "value": 5, "delete_existing": False},
                    {"field": "domains", "value": "x.com", "delete_existing": "yes"}):
            with self.subTest(bad=bad):
                self.assertEqual(self.request("POST", "/blacklist", bad), (400, {"error": "invalid_payload"}))
        self.assertEqual(added("domains", "x.com", False)[0], 200)
        status, data = self.request("GET", "/blacklist")
        self.assertEqual(status, 200)
        self.assertEqual((data["bundle_ids"][-2:], data["domains"][-2:], data["title_patterns"]),
                         (["x.Safari", "x.Notes"], ["github.com", "x.com"], ["工资"]))
        self.assertEqual(os.stat(Path(self.tmp.name) / "blacklist.json").st_mode & 0o777, 0o600)
        self.assertEqual(self.request("GET", "/blacklist", token=HOOK)[0], 401)
        self.assertEqual(self.request("POST", "/blacklist", {"field": "domains", "value": "y.com",
                                                             "delete_existing": False}, token=HOOK)[0], 401)

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_blacklist_remove_drops_one_entry(self):
        self.request("POST", "/blacklist", {"field": "bundle_ids", "value": "x.Notes", "delete_existing": False})
        file = Path(self.tmp.name) / "blacklist.json"
        file.chmod(0o644)
        removed = lambda field, value, **kw: self.request(  # noqa: E731
            "DELETE", "/blacklist", {"field": field, "value": value}, **kw)
        self.assertEqual(removed("bundle_ids", "x.Notes"), (200, {"removed": True}))
        self.assertNotIn("x.Notes", self.request("GET", "/blacklist")[1]["bundle_ids"])
        self.beat(self.now + 10, "Notes", "标题")
        self.assertEqual(self.server.attention.events("window")[-1]["data"]["app"], "Notes")
        self.assertEqual(os.stat(file).st_mode & 0o777, 0o600)
        self.assertEqual(removed("bundle_ids", "x.Notes"), (200, {"removed": False}))
        for bad in ({"field": "colors", "value": "x"}, {"field": "domains", "value": ""}, {"field": "domains"},
                    {"field": "domains", "value": 5}, []):
            with self.subTest(bad=bad):
                self.assertEqual(self.request("DELETE", "/blacklist", bad), (400, {"error": "invalid_payload"}))
        self.assertEqual(removed("domains", "x.com", token=HOOK)[0], 401)

    def test_blacklist_defaults_puts_back_the_removed_defaults_and_keeps_the_users(self):
        for field, value in (("bundle_ids", "com.tencent.qq"), ("domains", "paypal.com")):
            self.assertEqual(self.request("DELETE", "/blacklist", {"field": field, "value": value}),
                             (200, {"removed": True}))
        self.request("POST", "/blacklist", {"field": "bundle_ids", "value": "x.Notes", "delete_existing": False})
        self.assertEqual(self.request("POST", "/blacklist/defaults", {}), (200, {"added": 2}))
        self.assertEqual(self.request("POST", "/blacklist/defaults", {}), (200, {"added": 0}))
        data = self.request("GET", "/blacklist")[1]
        self.assertTrue({"com.tencent.qq", "x.Notes"} <= set(data["bundle_ids"]))
        self.assertIn("paypal.com", data["domains"])
        self.assertEqual(self.request("POST", "/blacklist/defaults", {}, token=HOOK)[0], 401)

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_allow_list_entries_and_the_mode_over_http(self):
        file = Path(self.tmp.name) / "blacklist.json"
        allow = lambda method, field, value, **extra: self.request(  # noqa: E731
            method, "/blacklist", {"list": "allow", "field": field, "value": value, **extra})
        last = lambda: self.server.attention.events("window")[-1]["data"]["app"]  # noqa: E731
        self.beat(self.now, "Notes", "标题")
        self.assertEqual(last(), "Notes")
        file.chmod(0o644)
        self.assertEqual(self.request("POST", "/blacklist/mode", {"mode": "allow"}), (200, {"mode": "allow"}))
        self.assertEqual(json.loads(file.read_text(encoding="utf-8"))["mode"], "allow")
        self.assertEqual(os.stat(file).st_mode & 0o777, 0o600)
        self.beat(self.now + 10, "Code", "标题")
        self.assertEqual(last(), "<hidden>")

        zero = {"events": 0, "context": 0, "observations": 0}
        self.assertEqual(allow("POST", "bundle_ids", "x.Code", delete_existing=True), (200, {"added": True, "deleted": zero}))
        self.assertEqual(allow("POST", "bundle_ids", "x.Code"), (200, {"added": False, "deleted": zero}))
        self.beat(self.now + 20, "Code", "标题")
        self.assertEqual(last(), "Code")
        data = self.request("GET", "/blacklist")[1]
        self.assertEqual((data["allow"]["bundle_ids"], "x.Code" in data["bundle_ids"]), (["x.Code"], False))
        for method, bad in (("POST", {"list": "allow", "field": "title_patterns", "value": "x"}),
                            ("POST", {"list": "other", "field": "domains", "value": "x.com", "delete_existing": False}),
                            ("POST", {"list": "allow", "field": "domains", "value": ""}),
                            ("DELETE", {"list": "allow", "field": "title_patterns", "value": "x"}),
                            ("DELETE", {"list": 1, "field": "domains", "value": "x.com"})):
            with self.subTest(bad=bad):
                self.assertEqual(self.request(method, "/blacklist", bad), (400, {"error": "invalid_payload"}))
        for bad in ({"mode": "block"}, {}, {"mode": None}, []):
            with self.subTest(bad=bad):
                self.assertEqual(self.request("POST", "/blacklist/mode", bad), (400, {"error": "invalid_payload"}))

        file.chmod(0o644)
        self.assertEqual(allow("DELETE", "bundle_ids", "x.Code"), (200, {"removed": True}))
        self.assertEqual(allow("DELETE", "bundle_ids", "x.Code"), (200, {"removed": False}))
        self.assertEqual(os.stat(file).st_mode & 0o777, 0o600)
        self.beat(self.now + 30, "Code", "标题")
        self.assertEqual(last(), "<hidden>")
        self.assertEqual(self.request("POST", "/blacklist/mode", {"mode": "deny"}), (200, {"mode": "deny"}))
        self.assertIn("Notes", [e["data"].get("app") for e in self.server.attention.events("window")])
        self.assertEqual(self.request("POST", "/blacklist/mode", {"mode": "deny"}, token=HOOK)[0], 401)
        attention, self.server.attention = self.server.attention, None
        try:
            self.assertEqual(self.request("POST", "/blacklist/mode", {"mode": "allow"}), (503, {"error": "no_attention"}))
        finally:
            self.server.attention = attention

    def test_get_blacklist_fills_in_the_mode_and_allow_lists_an_older_file_lacks(self):
        file = Path(self.tmp.name) / "blacklist.json"
        old = {k: v for k, v in json.loads(file.read_text(encoding="utf-8")).items() if k not in ("mode", "allow")}
        file.write_text(json.dumps(old), encoding="utf-8")
        status, data = self.request("GET", "/blacklist")
        self.assertEqual((status, data["mode"], data["allow"]),
                         (200, "allow", {"bundle_ids": [], "app_names": [], "domains": []}))


class ContextEditTest(FeedServerCase):
    """Context writes: clear one context item, correct the activity, and the line that used either ends."""
    request = SayTest.request
    say = SayTest.say
    lines_until_final = SayTest.lines_until_final
    browser = AttentionServerTest.browser
    EDITOR = {"app": "Code", "bundle_id": "com.microsoft.VSCode", "pid": 1, "window_id": 2, "title": "server.py"}

    def setUp(self):
        super().setUp()
        state = Path(self.tmp.name)
        self.now = time.time()
        clock = lambda: self.now  # noqa: E731
        self.server.clock = clock
        self.server.share_page_text = True
        self.server.attention = AttentionStore(state / "attention.sqlite", Blacklist(support.deny_blacklist(state / "blacklist.json")),
                                               clock=clock)
        self.addCleanup(self.server.attention.close)
        self.server.share_page_text = True

    def focus(self, front, seconds=10):
        for i in range(seconds):
            self.server.attention.ingest({"ts": self.now - seconds + 1 + i, "front": front, "mouse": None,
                                          "idle_s": 5.0, "locked": False, "asleep": False})

    def clear(self, kind, token=UI):
        return self.request("DELETE", f"/context/items/{kind}", token=token)

    def test_clear_page_and_selection_takes_every_row_of_the_page_shown_now(self):
        for kind, older, newer in (("page", "旧的页面正文", "新的页面正文"), ("selection", "旧的选中文字", "新的选中文字")):
            with self.subTest(kind=kind):
                self.browser({"type": kind, "ts": self.now - 20, "url_host": "github.com", "title": "PR", "text": older})
                self.browser({"type": kind, "ts": self.now - 10, "url_host": "github.com", "title": "PR", "text": newer})
                self.browser({"type": "heartbeat", "ts": self.now, "url_host": "github.com", "title": "PR"})
                shown = self.server.attention.current_page if kind == "page" else \
                    self.server.attention.latest_selection
                self.assertEqual(shown()["text"], newer)
                self.assertIn(newer, self.server.context())
                self.assertEqual(self.clear(kind), (200, {"type": kind, "cleared": True, "cancelled_line": False}))
                self.assertIsNone(shown())
                context = self.server.context()
                self.assertNotIn(newer, context)
                self.assertNotIn(older, context)
                self.assertIsNone(self.request("GET", "/diag/state")[1]["context"][kind])
                self.assertEqual(self.clear(kind), (200, {"type": kind, "cleared": False, "cancelled_line": False}))

    def test_clear_view_and_window_text(self):
        from test_capture import CountingRules
        self.server.capture = CaptureManager(self.server.feed, self.server.attention.blacklist,
                                             lambda: {"window_id": 2, "app": "Code", "bundle_id": "x.Code"}, None,
                                             clock=lambda: self.now, backend=CountingRules(),
                                             vision=SimpleNamespace(describe=lambda png, user: "一段看图描述"))
        self.assertEqual(self.request("POST", "/context/text", {"window_id": 2, "app": "Code", "text": "窗口里的私密文字",
                                                                "source": "ax"})[0], 202)
        status, looked = self.request("POST", "/look", {})
        self.assertEqual(status, 202)
        self.server.capture.image(looked["request_id"], 2, b"png")
        for _ in range(200):
            if self.server.capture.view() is not None:
                break
            time.sleep(0.01)
        for kind, text in (("view", "一段看图描述"), ("window_text", "窗口里的私密文字")):
            with self.subTest(kind=kind):
                self.assertIn(text, self.server.context())
                self.assertEqual(self.clear(kind), (200, {"type": kind, "cleared": True, "cancelled_line": False}))
                self.assertNotIn(text, self.server.context())
                diag = self.request("GET", "/diag/state?with_text=1")[1]["context"]
                self.assertNotIn(text, json.dumps(diag, ensure_ascii=False))
                self.assertEqual(self.clear(kind), (200, {"type": kind, "cleared": False, "cancelled_line": False}))
        self.assertIsNone(self.server.capture.view())
        self.assertIsNone(self.server.capture.window_text())

    def test_clearing_what_the_live_line_used_cancels_it(self):
        self.server.speech = FakeRelay()
        self.browser({"type": "page", "ts": self.now, "url_host": "github.com", "title": "PR", "text": "页面正文"})
        self.browser({"type": "heartbeat", "ts": self.now, "url_host": "github.com", "title": "PR"})
        self.server.mouth = FakeMouth(["[intent:explain]一"] + ["二"] * 50, delay=0.05)
        conn, response = self.open_feed()
        self.say("说个长的")
        self.assertEqual(self.next_event(response)["event"], "turn_accepted")
        self.next_event(response)
        self.assertEqual(self.clear("page"), (200, {"type": "page", "cleared": True, "cancelled_line": True}))
        events = self.lines_until_final(response)
        conn.close()
        self.assertEqual((events[-1]["cancelled"], events[-1]["error"]), (True, "context_cleared"))
        self.assertLess(len(events), 40)
        self.assertIn(("cancel", "client_cancel", True), self.server.speech.calls)
        # Control: the line used no selection, so clearing one cuts nothing.
        self.server.mouth = FakeMouth(["[intent:explain]一"] + ["二"] * 10, delay=0.05)
        conn, response = self.open_feed()
        self.say("再说一个")
        self.assertEqual(self.next_event(response)["event"], "turn_accepted")
        self.next_event(response)
        self.assertEqual(self.clear("selection"),
                         (200, {"type": "selection", "cleared": False, "cancelled_line": False}))
        events = self.lines_until_final(response)
        conn.close()
        self.assertEqual((events[-1]["cancelled"], events[-1]["error"]), (False, None))
        self.assertEqual("".join(e["text_delta"] for e in events), "二" * 10)  # past the first, read above

    def test_deleting_what_she_saw_cancels_the_live_line_that_used_it(self):
        self.server.speech = FakeRelay()
        for path in ("/attention", "/observation?range=15m"):
            with self.subTest(path=path):
                self.browser({"type": "page", "ts": self.now, "url_host": "github.com", "title": "PR", "text": "页面正文"})
                self.browser({"type": "heartbeat", "ts": self.now, "url_host": "github.com", "title": "PR"})
                self.server.mouth = FakeMouth(["[intent:explain]一"] + ["二"] * 50, delay=0.05)
                conn, response = self.open_feed()
                self.say("说个长的")
                self.assertEqual(self.next_event(response)["event"], "turn_accepted")
                self.next_event(response)
                self.assertEqual(self.request("DELETE", path)[0], 200)
                events = self.lines_until_final(response)
                conn.close()
                self.assertEqual((events[-1]["cancelled"], events[-1]["error"]), (True, "context_cleared"))
                self.assertLess(len(events), 40)
                deadline = time.monotonic() + 5
                while self.server._live_lines and time.monotonic() < deadline:
                    time.sleep(0.01)

    def test_correct_the_activity_until_the_focus_changes_or_it_expires(self):
        self.focus(self.EDITOR)
        inferred = self.server.activity()
        self.assertEqual((inferred["activity"], inferred["corrected"]), ("editing_code", False))
        status, body = self.request("PUT", "/context/activity", {"activity": "reading", "minutes": 10})
        self.assertEqual(status, 200)
        self.assertEqual((body["activity"], body["focus_id"], body["cancelled_line"]),
                         ("reading", inferred["focus_id"], False))
        self.assertAlmostEqual(datetime.datetime.fromisoformat(body["until"]).timestamp(), self.now + 600, places=2)
        scene = self.server.activity()
        self.assertEqual((scene["activity"], scene["confidence"], scene["corrected"]), ("reading", 1.0, True))
        shown = self.request("GET", "/diag/state")[1]["context"]["activity"]
        self.assertEqual({k: shown[k] for k in ("activity", "confidence", "corrected", "until")},
                         {"activity": "reading", "confidence": 1.0, "corrected": True, "until": body["until"]})
        self.assertIn("Scene: reading", self.server.context())
        # Another window has the focus: the inference is back and the correction is gone.
        self.now += 1
        self.focus({**self.EDITOR, "window_id": 3, "title": "client.py"}, seconds=1)
        scene = self.server.activity()
        self.assertEqual((scene["activity"], scene["corrected"]), ("editing_code", False))
        self.assertIsNone(self.server.correction)
        self.assertIsNone(self.request("GET", "/diag/state")[1]["context"]["activity"]["until"])
        # Same focus, but the clock passes `until`.
        self.assertEqual(self.request("PUT", "/context/activity", {"activity": "reading", "minutes": 1})[0], 200)
        self.assertTrue(self.server.activity()["corrected"])
        for _ in range(16):
            self.now += 4
            self.server.attention.ingest({"ts": self.now, "front": {**self.EDITOR, "window_id": 3,
                                                                    "title": "client.py"},
                                          "mouse": None, "idle_s": 5.0, "locked": False, "asleep": False})
        scene = self.server.activity()
        self.assertEqual((scene["activity"], scene["corrected"]), ("editing_code", False))
        # null removes it.
        self.assertEqual(self.request("PUT", "/context/activity", {"activity": "away", "minutes": 5})[0], 200)
        self.assertTrue(self.server.activity()["corrected"])
        self.assertEqual(self.request("PUT", "/context/activity", {"activity": None}),
                         (200, {"activity": None, "until": None, "focus_id": None, "cancelled_line": False}))
        self.assertFalse(self.server.activity()["corrected"])
        for bad in ({"activity": "unknown", "minutes": 5}, {"activity": "dancing", "minutes": 5}, {"activity": "reading"},
                    {"activity": "reading", "minutes": 0}, {"activity": "reading", "minutes": 241},
                    {"activity": "reading", "minutes": True}, {"activity": "reading", "minutes": "5"},
                    {"activity": "reading", "minutes": 1.5}, {}, ["reading"]):
            with self.subTest(bad=bad):
                self.assertEqual(self.request("PUT", "/context/activity", bad), (400, {"error": "invalid_payload"}))
        self.assertEqual(self.request("PUT", "/context/activity", {"activity": None}, token=HOOK)[0], 401)

    def test_a_correction_cancels_the_live_line_that_used_the_activity(self):
        self.focus(self.EDITOR)
        self.server.mouth = FakeMouth(["[intent:explain]一"] + ["二"] * 50, delay=0.05)
        conn, response = self.open_feed()
        self.say("说个长的")
        self.assertEqual(self.next_event(response)["event"], "turn_accepted")
        self.next_event(response)
        status, body = self.request("PUT", "/context/activity", {"activity": "reading", "minutes": 10})
        self.assertEqual((status, body["cancelled_line"]), (200, True))
        events = self.lines_until_final(response)
        conn.close()
        self.assertEqual((events[-1]["cancelled"], events[-1]["error"]), (True, "context_cleared"))

    def test_unknown_types_and_missing_token(self):
        for kind in ("activity", "sessions", "colors"):
            with self.subTest(kind=kind):
                self.assertEqual(self.clear(kind), (400, {"error": "invalid_type"}))
        self.assertEqual(self.clear("page", token=HOOK)[0], 401)
        self.assertEqual(self.request("DELETE", "/context/items/page", token="")[0], 401)


class TokenFileTest(unittest.TestCase):
    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_token_file_must_be_private(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32") as tmp:
            path = os.path.join(tmp, "hook.token")
            write_secret(path, "t\n")
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            os.chmod(path, 0o644)
            with self.assertRaises(SystemExit):
                read_token(path)


if __name__ == "__main__":
    unittest.main()
