import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from observation import activity as activity_module  # noqa: E402
from observation.activity import ACTIVITIES, CONFIDENCE, assemble, snapshot  # noqa: E402
from observation.attention import AttentionStore  # noqa: E402
from observation.blacklist import Blacklist  # noqa: E402
from support import deny_blacklist  # noqa: E402
from observation.capture import CaptureManager  # noqa: E402
from observation.user_now import UserNow  # noqa: E402
from sessions.events import normalize_claude  # noqa: E402
from character.feed import Feed  # noqa: E402
from sessions.registry import Registry  # noqa: E402
from sessions.own import OwnSession  # noqa: E402

FIXTURES = sorted((HERE / "fixtures" / "activity").glob("*.json"))
T0 = 1792300000.0
PREFERENCE_WORDS = ("喜欢", "偏好", "爱好", "习惯", "讨厌", "prefer", "likes")


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def input_ids(inputs):
    """Every id an input record carries; facts may cite only these."""
    ids = {inputs[k]["id"] for k in ("focus", "presence", "user", "page", "selection", "window_text") if inputs.get(k)}
    ids |= {p["id"] for p in inputs["recent_pages"]}
    ids |= {o["request_id"] for o in inputs["observations"]}
    ids |= {s["display_session"] for s in inputs["sessions"]}
    ids |= {s["session_id"] for s in inputs["own_sessions"]}
    ids |= {e["id"] for e in inputs["events"]}
    return ids


def has_text(inputs):
    return bool((inputs.get("window_text") or {}).get("text") or (inputs.get("page") or {}).get("text")
                or (inputs.get("selection") or {}).get("text")
                or any(o["status"] == "ready" and o.get("text") for o in inputs["observations"]))


class CountingJudge:
    def __init__(self):
        self.calls = []

    def __call__(self, inputs, candidate):
        self.calls.append(candidate)
        return {"inference": "看上去在读一段日志", "confidence": 0.4}


class Tracked(dict):
    """An inputs dict that records which keys assemble looked up."""

    def __init__(self, *args):
        super().__init__(*args)
        self.read = set()

    def __getitem__(self, key):
        self.read.add(key)
        return super().__getitem__(key)

    def get(self, key, default=None):
        self.read.add(key)
        return super().get(key, default)


class AssembleTest(unittest.TestCase):
    def test_result_fields_and_closed_sets(self):
        for path in FIXTURES:
            with self.subTest(path.name):
                result = assemble(load(path)["inputs"])
                self.assertIn(result["activity"], ACTIVITIES)
                self.assertIn(result["status"], ("ok", "unknown", "degraded"))
                self.assertTrue(0.0 <= result["confidence"] <= 1.0)
                self.assertIsNone(result["inference"])
                self.assertIsInstance(result["can_interrupt"], bool)
                self.assertTrue(result["expires_with"])
                self.assertEqual(bool(result.get("degraded_reasons")), result["status"] == "degraded")

    def test_approval_card_in_our_window_lets_her_interrupt_on_both_platforms(self):
        # 09 is the macOS bundle, 20 the Windows helper's app_id of the packaged exe; 08 is another app's window.
        for name, expected in (("08_waiting_approval_elsewhere.json", False), ("09_waiting_approval_on_card.json", True),
                               ("20_waiting_approval_on_card_windows.json", True)):
            with self.subTest(name):
                self.assertEqual(assemble(load(HERE / "fixtures" / "activity" / name)["inputs"])["can_interrupt"], expected)

    def test_every_fact_cites_evidence_from_the_inputs(self):
        for path in FIXTURES:
            inputs = load(path)["inputs"]
            ids = input_ids(inputs)
            for fact in assemble(inputs)["facts"]:
                with self.subTest(path.name, fact=fact["text"]):
                    self.assertTrue(fact["evidence_ids"])
                    self.assertLessEqual(set(fact["evidence_ids"]), ids)

    def test_facts_describe_the_scene_never_preferences(self):
        # Tool and task events stay out of user-fact memory.
        for path in FIXTURES:
            for fact in assemble(load(path)["inputs"])["facts"]:
                with self.subTest(path.name, fact=fact["text"]):
                    self.assertFalse(any(word in fact["text"] for word in PREFERENCE_WORDS))

    def test_judge_only_when_rules_give_no_activity_and_text_is_readable(self):
        judge = CountingJudge()
        judged = []
        for path in FIXTURES:
            fixture = load(path)
            before = len(judge.calls)
            result = assemble(fixture["inputs"], judge=judge)
            if len(judge.calls) > before:
                judged.append(path.name)
                self.assertEqual(result["inference"], "看上去在读一段日志")
            else:
                self.assertIsNone(result["inference"])
        wanted = [p.name for p in FIXTURES
                  if load(p)["expect"]["activity"] == "unknown" and has_text(load(p)["inputs"])]
        self.assertTrue(wanted)
        self.assertEqual(judged, wanted)

    def test_secure_input_neither_judges_nor_reads_window_text(self):
        secure = [p for p in FIXTURES if (load(p)["inputs"].get("focus") or {}).get("secure_input")]
        self.assertTrue(secure)
        for path in secure:
            inputs = Tracked(load(path)["inputs"])
            self.assertTrue(inputs["window_text"])
            inputs.read.clear()
            judge = CountingJudge()
            result = assemble(inputs, judge=judge)
            self.assertEqual(judge.calls, [])
            self.assertNotIn("window_text", inputs.read)
            self.assertEqual((result["activity"], result["status"]), ("unreadable", "degraded"))
            self.assertIn("secure_input", result["degraded_reasons"])


class CorrectionTest(unittest.TestCase):
    def inputs(self, fullscreen=False, app="Code", bundle_id="com.microsoft.VSCode", window_text=None):
        return {"now": T0, "focus": {"id": "focus:a", "app": app, "bundle_id": bundle_id, "window_id": 2,
                                     "title": "ledger.py", "since": T0 - 100, "secure_input": False,
                                     "fullscreen": fullscreen},
                "dwell_s": 100.0, "presence": None, "page": None, "recent_pages": [], "selection": None,
                "window_text": window_text, "observations": [], "sessions": [], "own_sessions": [], "events": []}

    def test_a_holding_correction_replaces_rules_and_judge(self):
        correction = {"activity": "reading", "until": T0 + 120, "focus_id": "focus:a"}
        inferred = assemble(self.inputs())
        self.assertEqual((inferred["activity"], inferred["corrected"]), ("editing_code", False))
        result = assemble(self.inputs(), correction=correction)
        self.assertEqual({k: result[k] for k in ("activity", "confidence", "inference", "corrected", "can_interrupt",
                                                 "expires_with", "facts", "focus_id", "status")},
                         {"activity": "reading", "confidence": 1.0, "inference": None, "corrected": True,
                          "can_interrupt": True, "expires_with": ["focus_change", "page_revision", "ttl:300", "ttl:120"],
                          "facts": inferred["facts"], "focus_id": "focus:a", "status": "ok"})
        # A hold flag still blocks interrupting.
        self.assertFalse(assemble(self.inputs(fullscreen=True), correction=correction)["can_interrupt"])
        # A focus id of null holds on any focus.
        self.assertTrue(assemble(self.inputs(), correction={**correction, "focus_id": None})["corrected"])
        # Neither the rules nor the judge run.
        judge = CountingJudge()
        unknown = self.inputs(app="Other", bundle_id="x.other", window_text={"id": "window_text:1", "text": "日志"})
        self.assertEqual(assemble(unknown, judge=judge)["activity"], "unknown")
        self.assertEqual(len(judge.calls), 1)
        self.assertEqual(assemble(unknown, judge=judge, correction=correction)["activity"], "reading")
        self.assertEqual(len(judge.calls), 1)

    def test_a_correction_that_no_longer_holds_changes_nothing(self):
        inferred = assemble(self.inputs())
        for correction in ({"activity": "reading", "until": T0 + 120, "focus_id": "focus:b"},
                           {"activity": "reading", "until": T0, "focus_id": "focus:a"}):
            with self.subTest(correction=correction):
                self.assertEqual(assemble(self.inputs(), correction=correction), inferred)


class ObservationAgeTest(unittest.TestCase):
    def inputs(self, age):
        observation = {"request_id": "obs:1", "window_id": 3, "status": "ready", "mode": "image",
                       "text": "make: *** error: undefined symbol", "requested_at": T0 - age - 5,
                       "observed_at": T0 - age}
        return {"now": T0, "focus": {"id": "focus:t", "app": "Terminal", "bundle_id": "com.apple.Terminal",
                                     "window_id": 3, "title": "zsh", "since": T0 - 100, "secure_input": False,
                                     "fullscreen": False},
                "dwell_s": 100.0, "presence": None, "page": None, "recent_pages": [], "selection": None,
                "window_text": None, "observations": [observation], "sessions": [], "own_sessions": [], "events": []}

    def test_an_old_observation_is_not_the_current_scene(self):
        self.assertEqual(assemble(self.inputs(10))["activity"], "build_failed")
        self.assertNotEqual(assemble(self.inputs(7200))["activity"], "build_failed")


class SnapshotTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.now = T0
        root = Path(self.tmp.name)
        blacklist = Blacklist(deny_blacklist(root / "blacklist.json"))
        self.attention = AttentionStore(root / "attention.sqlite", blacklist, clock=lambda: self.now)
        self.addCleanup(self.attention.close)
        self.editor = {"app": "Code", "bundle_id": "com.microsoft.VSCode", "pid": 11, "window_id": 2,
                       "title": "ledger.py — orbit-ledger"}
        self.capture = CaptureManager(Feed(), blacklist, lambda: self.attention.focus(), root / "capture.jsonl",
                                      clock=lambda: self.now)
        self.registry = Registry(epoch=1, clock=lambda: self.now)

    def test_front_category_does_not_follow_focus_to_another_bundle(self):
        game = {"app": "Arena", "bundle_id": "x.arena", "window_id": 4,
                "category": "public.app-category.action-games"}
        mouse = {"app": "Other", "bundle_id": "x.other", "window_id": 5}
        self.attention.ingest({"ts": self.now, "front": game, "mouse": mouse, "idle_s": 5.0})
        inputs = snapshot(self.attention, self.registry, None, None)
        self.assertNotEqual(assemble(inputs)["activity"], "gaming")
        self.assertNotIn("category", inputs["focus"])
        self.now += 1
        self.attention.ingest({"ts": self.now, "front": game, "mouse": {**mouse, "bundle_id": "x.arena"},
                               "idle_s": 5.0})
        self.assertEqual(assemble(snapshot(self.attention, self.registry, None, None))["activity"], "gaming")
        self.now += 1
        self.attention.ingest({"ts": self.now, "front": mouse, "mouse": None, "idle_s": 0.0})
        self.assertNotEqual(assemble(snapshot(self.attention, self.registry, None, None))["activity"], "gaming")

    def test_snapshot_of_real_stores_assembles(self):
        for step in range(12):
            self.now = T0 + step
            self.attention.ingest({"ts": self.now, "front": self.editor, "mouse": None, "idle_s": 1.0,
                                   "locked": False, "asleep": False, "secure_input": False})
        self.attention.ingest_browser({"type": "heartbeat", "ts": self.now, "url_host": "docs.example-a.dev",
                                       "title": "Cache API", "audible": False})
        self.capture.text({"source": "ax", "text": "short", "window_id": 2, "request_id": None,
                           "app": "Code", "bundle_id": "com.microsoft.VSCode", "title": self.editor["title"]})
        for name, extra in (("SessionStart", {}), ("UserPromptSubmit", {}),
                            ("PostToolUseFailure", {"tool_name": "Bash", "tool_input": {"command": "make"}}),
                            ("StopFailure", {})):
            self.registry.ingest(normalize_claude({"hook_event_name": name, "session_id": "s1",
                                                   "cwd": "/Users/demo/work/orbit-ledger", **extra}, now=self.now))
        own = SimpleNamespace(sessions={})
        session = OwnSession("codex", "/Users/demo/lab/fern", "tidy the fixtures")
        own.sessions[session.session_id] = session

        inputs = snapshot(self.attention, self.registry, self.capture, own)
        json.dumps(inputs)
        for key in ("now", "focus", "dwell_s", "presence", "page", "recent_pages", "selection", "window_text",
                    "observations", "sessions", "own_sessions", "events"):
            self.assertIn(key, inputs)
        self.assertEqual(inputs["focus"]["bundle_id"], "com.microsoft.VSCode")
        self.assertEqual(inputs["presence"]["status"], "active")
        self.assertEqual(inputs["page"]["url_host"], "docs.example-a.dev")
        self.assertEqual([o["status"] for o in inputs["observations"]], ["pending"])
        self.assertEqual(inputs["sessions"][0]["display_session"], "claude:s1")
        self.assertEqual(inputs["own_sessions"][0]["session_id"], session.session_id)
        self.assertTrue(inputs["events"])
        self.assertEqual(snapshot(self.attention, self.registry, self.capture, own)["focus"]["id"],
                         inputs["focus"]["id"])

        result = assemble(inputs)
        self.assertIn(result["activity"], ACTIVITIES)
        self.assertIn("claude:s1", result["related_session_ids"])
        ids = input_ids(inputs)
        for fact in result["facts"]:
            self.assertLessEqual(set(fact["evidence_ids"]), ids)

    def test_user_nows_typing_in_an_editor_is_typing(self):
        user = UserNow(clock=lambda: self.now)
        for step in range(3):
            self.now = T0 + step
            self.attention.ingest({"ts": self.now, "front": self.editor, "mouse": None, "idle_s": 1.0,
                                   "locked": False, "asleep": False, "secure_input": False})
            user.coarse({"ts": self.now, "idle_s": 1.0})
        inputs = snapshot(self.attention, self.registry, self.capture, None, user.snapshot())
        json.dumps(inputs)
        self.assertEqual(assemble(inputs)["activity"], "typing")
        self.assertEqual(assemble(snapshot(self.attention, self.registry, self.capture, None))["activity"], "editing_code")

    def test_snapshot_reads_only_public_methods_and_fills_idle_and_fullscreen(self):
        for step in range(3):
            self.now = T0 + step
            self.attention.ingest({"ts": self.now, "front": self.editor, "mouse": None, "idle_s": 1.5,
                                   "locked": False, "asleep": False, "secure_input": step == 2})
        self.capture.text({"source": "ax", "text": "short", "window_id": 2, "request_id": None,
                           "app": "Code", "bundle_id": "com.microsoft.VSCode", "title": self.editor["title"]})
        inputs = snapshot(PublicOnly(self.attention), self.registry, PublicOnly(self.capture), None, fullscreen=True)
        self.assertEqual((inputs["presence"]["idle_s"], inputs["focus"]["fullscreen"], inputs["focus"]["secure_input"]),
                         (1.5, True, True))
        self.assertEqual([o["status"] for o in inputs["observations"]], ["pending"])
        self.assertFalse(snapshot(self.attention, self.registry, self.capture, None)["focus"]["fullscreen"])

    def test_one_failed_command_in_the_focused_terminal_is_a_failed_build(self):
        terminal = {"app": "Terminal", "bundle_id": "com.apple.Terminal", "pid": 12, "window_id": 3, "title": "zsh"}
        for step in range(3):
            self.now = T0 + step
            self.attention.ingest({"ts": self.now, "front": terminal, "mouse": None, "idle_s": 1.0,
                                   "locked": False, "asleep": False, "secure_input": False})
        origin = {"kind": "terminal", "term_program": "Apple_Terminal"}
        for name, extra in (("UserPromptSubmit", {}),
                            ("PostToolUseFailure", {"tool_name": "Bash", "tool_input": {"command": "make"}})):
            self.registry.ingest(normalize_claude({"hook_event_name": name, "session_id": "s1", "cwd": "/w/orbit",
                                                   "agentd_origin": origin, **extra}, now=self.now))
        inputs = snapshot(self.attention, self.registry, self.capture, None)
        self.assertIsNone(inputs["window_text"])
        self.assertEqual(assemble(inputs)["activity"], "build_failed")

    def browse(self, pages):
        chrome = {"app": "Google Chrome", "bundle_id": "com.google.Chrome", "pid": 13, "window_id": 6, "title": "tab"}
        for host, title in pages:
            self.now += 2
            self.attention.ingest({"ts": self.now, "front": chrome, "mouse": None, "idle_s": 1.0})
            self.attention.ingest_browser({"type": "heartbeat", "ts": self.now, "url_host": host, "title": title,
                                           "tab_id": 1, "audible": False})
        return snapshot(self.attention, self.registry, None, None)

    def test_pages_blacklisted_since_are_not_in_the_scene(self):
        pages = [("a.com", "A"), ("b.com", "B")] * 3
        self.assertEqual(assemble(self.browse(pages))["activity"], "comparing_sources")  # control
        self.attention.blacklist.add("domains", "b.com")
        inputs = snapshot(self.attention, self.registry, None, None)
        self.assertEqual({p["url_host"] for p in inputs["recent_pages"]}, {"a.com"})
        self.assertIsNone(inputs["page"])
        self.assertNotIn("b.com", json.dumps(assemble(inputs)["facts"], ensure_ascii=False))

    def test_an_unnamed_page_among_the_switches_is_no_label(self):
        inputs = self.browse([("a.com", "A"), (None, None), ("a.com", "A"), ("b.com", "B"), ("a.com", "A")])
        self.assertEqual(assemble(inputs)["activity"], "comparing_sources")

    def test_a_clear_between_the_presence_reads_leaves_no_presence_gap(self):
        self.attention.ingest({"ts": self.now, "front": self.editor, "mouse": None, "idle_s": 1.0})
        presence = self.attention.presence

        def cleared():
            answer = presence()
            self.attention.clear_tables()
            return answer

        self.attention.presence = cleared
        self.assertEqual(snapshot(self.attention, self.registry, None, None)["presence"]["status"], "active")


class TypingFromKeysTest(unittest.TestCase):
    """Typing and meeting from user_now, switching from the heartbeat's counts (C6 `input`)."""

    QUIET = {"key_idle_s": 40.0, "pointer_idle_s": 40.0, "scroll_idle_s": 40.0, "click_idle_s": 40.0, "keys_10s": 0,
             "keys_60s": 0, "clicks_10s": 0, "scrolls_30s": 0, "moves_10s": 0, "switches_60s": 0}

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.now = T0
        root = Path(self.tmp.name)
        self.blacklist = Blacklist(deny_blacklist(root / "blacklist.json"))
        self.attention = AttentionStore(root / "attention.sqlite", self.blacklist, clock=lambda: self.now)
        self.addCleanup(self.attention.close)
        self.registry = Registry(epoch=1, clock=lambda: self.now)
        self.editor = {"app": "Code", "bundle_id": "com.microsoft.VSCode", "pid": 11, "window_id": 2,
                       "title": "ledger.py — orbit-ledger"}
        self.user = UserNow(clock=lambda: self.now)

    COARSE = ("mic_active", "camera_active", "screen_captured", "front_video", "fullscreen", "front_gpu")

    def beats(self, count, front=None, idle_s=3.0, **sensed):
        """count beats one second apart, to attention and to user_now; `input` overrides QUIET, other keyword
        arguments ride as they are."""
        fronts = front if isinstance(front, list) else [front or self.editor]
        for step in range(count):
            self.now += 1
            beat = {"ts": self.now, "front": fronts[step % len(fronts)], "mouse": None, "idle_s": idle_s,
                    "locked": False, "asleep": False, "secure_input": False}
            coarse = {"ts": self.now, "idle_s": idle_s, **{k: v for k, v in sensed.items() if k in self.COARSE}}
            if "input" in sensed:
                beat["input"] = {**self.QUIET, **sensed["input"]}
                coarse["input"] = {k: v for k, v in beat["input"].items()
                                   if k in ("key_idle_s", "pointer_idle_s", "keys_10s", "keys_60s", "switches_60s")}
            beat.update({k: v for k, v in sensed.items() if k != "input"})
            self.attention.ingest(beat)
            self.user.coarse(coarse)

    def scene(self, **kwargs):
        return assemble(snapshot(PublicOnly(self.attention), self.registry, None, None, self.user.snapshot(), **kwargs))

    def test_mouse_only_input_is_not_typing(self):
        self.beats(62, input={"pointer_idle_s": 0.2, "scroll_idle_s": 1.0, "moves_10s": 30, "scrolls_30s": 12})
        self.assertEqual(self.scene()["activity"], "editing_code")

    def test_user_nows_typing_is_typing(self):
        self.beats(3, input={"keys_10s": 12, "keys_60s": 12, "key_idle_s": 0.3})
        result = self.scene()
        self.assertEqual((result["activity"], result["confidence"], result["can_interrupt"]), ("typing", 0.9, False))
        self.assertIn("Keyboard input keeps going", [f["text"] for f in result["facts"]])
        self.assertFalse(any("12" in f["text"] for f in result["facts"]))  # counts stay out of facts
        self.beats(1, input={"keys_10s": 3, "keys_60s": 15, "key_idle_s": 5.0})
        self.assertEqual(self.scene()["activity"], "editing_code")

    def test_without_key_counts_input_active_is_typing(self):
        self.beats(1, idle_s=1.0)
        result = self.scene()
        self.assertEqual(result["activity"], "typing")
        self.assertIn("Keyboard and mouse input keeps going", [f["text"] for f in result["facts"]])
        self.beats(1, idle_s=3.0)
        self.assertEqual(self.scene()["activity"], "editing_code")

    def test_user_nows_meeting_is_meeting(self):
        for fields in ({"mic_active": True}, {"camera_active": True}):
            with self.subTest(fields=fields):
                self.setUp()
                self.beats(3, input={}, **fields)
                result = self.scene()
                self.assertEqual((result["activity"], result["confidence"], result["can_interrupt"]),
                                 ("meeting", 0.9, False))
                self.assertIn("The user is in a meeting or a call", [f["text"] for f in result["facts"]])
                self.beats(1, input={})
                self.assertEqual(self.scene()["activity"], "editing_code")
        self.user.set_overrides(meeting_manual=True)
        self.assertEqual(self.scene()["activity"], "meeting")

    def test_a_quiet_stage_holds_the_interruption(self):
        self.beats(1, input={})
        self.assertTrue(self.scene()["can_interrupt"])
        self.user.set_overrides(dnd_until=self.now + 600)
        self.assertEqual((self.scene()["activity"], self.scene()["can_interrupt"]), ("editing_code", False))
        self.user.set_overrides(dnd_until=None)
        self.assertTrue(self.scene()["can_interrupt"])

    def test_games_category_is_gaming_and_cannot_interrupt(self):
        inputs = {"now": T0, "focus": {"id": "focus:g", "app": "Arena", "bundle_id": "com.example.arena",
                                       "category": "public.app-category.action-games", "window_id": 4, "title": "Arena",
                                       "since": T0 - 100, "secure_input": False, "fullscreen": False},
                  "dwell_s": 100.0, "presence": None, "page": None, "recent_pages": [], "selection": None,
                  "window_text": None, "observations": [], "sessions": [], "own_sessions": [], "events": []}
        result = assemble(inputs)
        self.assertEqual((result["activity"], result["confidence"], result["can_interrupt"]), ("gaming", 0.8, False))
        self.assertIn("gaming", ACTIVITIES)

    def test_front_video_assertion_is_watching_video(self):
        self.beats(3, front_video=True)
        result = self.scene()
        self.assertEqual((result["activity"], result["confidence"]), ("watching_video", 0.8))
        for value in (False, None):
            with self.subTest(front_video=value):
                self.beats(1, front_video=value)
                self.assertEqual(self.scene()["activity"], "editing_code")

    def test_fullscreen_busy_gpu_is_gaming(self):
        self.beats(3, front_gpu=0.8)
        self.beats(2, front_gpu=0.1)
        result = self.scene(fullscreen=True)
        self.assertEqual((result["activity"], result["confidence"], result["can_interrupt"]), ("gaming", 0.7, False))
        self.assertFalse(any("0.8" in f["text"] or "0.1" in f["text"] for f in result["facts"]))
        self.assertEqual(self.scene()["activity"], "editing_code")  # not fullscreen
        self.beats(1, front_gpu=0.1)  # 2 of the last 5
        self.assertEqual(self.scene(fullscreen=True)["activity"], "editing_code")
        self.beats(5, front_gpu=None)
        self.assertEqual(self.scene(fullscreen=True)["activity"], "editing_code")

    def test_busy_gpu_from_previous_front_app_is_not_gaming(self):
        other = {**self.editor, "app": "Blender", "bundle_id": "org.blenderfoundation.blender", "pid": 12, "window_id": 3,
                 "title": "scene.blend"}
        self.beats(3, front=other, front_gpu=0.8)
        self.beats(1, front_gpu=None)
        self.assertNotEqual(self.scene(fullscreen=True)["activity"], "gaming")

    def test_screen_capture_is_meeting_before_typing_and_video(self):
        keys = {"keys_10s": 12, "keys_60s": 12, "key_idle_s": 0.3}
        self.beats(3, input=keys, front_video=True, screen_captured=True)
        result = self.scene()
        self.assertEqual((result["activity"], result["confidence"], result["can_interrupt"]), ("meeting", 0.9, False))
        self.assertIn("The screen is being shared or recorded", [f["text"] for f in result["facts"]])
        for value in (False, None):
            with self.subTest(screen_captured=value):
                self.beats(1, input=keys, screen_captured=value)
                self.assertEqual(self.scene()["activity"], "typing")
        self.beats(1, input=keys, screen_captured=True, secure_input=True)
        self.assertEqual(self.scene()["activity"], "unreadable")

    def test_six_switches_in_a_minute_is_switching(self):
        notes = {"app": "Notes", "bundle_id": "com.apple.Notes", "pid": 12, "window_id": 3, "title": "todo"}
        mail = {"app": "Mail", "bundle_id": "com.apple.mail", "pid": 13, "window_id": 4, "title": "Inbox"}
        self.beats(12, front=[self.editor, self.editor, notes, notes, mail, mail],
                   input={"switches_60s": 6, "keys_60s": 5})
        self.beats(6, input={"switches_60s": 6, "keys_60s": 5})
        result = self.scene()
        self.assertEqual((result["activity"], result["confidence"], result["can_interrupt"]),
                         ("switching", 0.5, False))
        # Typing through it, or fewer switches, is not switching.
        self.beats(1, input={"switches_60s": 6, "keys_60s": 20})
        self.assertEqual(self.scene()["activity"], "editing_code")
        self.beats(1, input={"switches_60s": 5, "keys_60s": 5})
        self.assertEqual(self.scene()["activity"], "editing_code")

    def test_switches_between_two_apps_are_not_switching(self):
        notes = {"app": "Notes", "bundle_id": "com.apple.Notes", "pid": 12, "window_id": 3, "title": "todo"}
        self.beats(12, front=[self.editor, notes], input={"switches_60s": 8, "keys_60s": 5})
        self.beats(6, input={"switches_60s": 8, "keys_60s": 5})
        self.assertEqual(self.scene()["activity"], "editing_code")


class InterpretedTest(unittest.TestCase):
    """The continuous interpreter's fresh task for the focus window names an activity where no rule does."""

    def inputs(self, state="comparing", age=30.0, window_id=9, app="Claude", bundle_id="com.anthropic.claudefordesktop"):
        task = {"task_key": "wal-doc", "title": "对照 SQLite WAL 文档改写入代码", "summary": "读 checkpoint 一节",
                "state": state, "observed_at": T0 - age, "windows": [{"window_id": window_id, "bundle_id": bundle_id}]}
        return {"now": T0, "focus": {"id": "focus:c", "app": app, "bundle_id": bundle_id, "window_id": 9,
                                     "title": "Claude", "since": T0 - 100, "secure_input": False, "fullscreen": False},
                "dwell_s": 100.0, "presence": None, "page": None, "recent_pages": [], "selection": None,
                "window_text": None, "observations": [], "sessions": [], "own_sessions": [], "events": [],
                "interpreted": [task]}

    def test_reading_like_task_states_make_an_unknown_window_reading(self):
        for state in ("reading", "comparing", "investigating"):
            with self.subTest(state=state):
                result = assemble(self.inputs(state))
                self.assertEqual((result["activity"], result["confidence"], result["can_interrupt"]),
                                 ("reading", CONFIDENCE.get("interpreted"), True))
                self.assertEqual(result["subject"], "对照 SQLite WAL 文档改写入代码")
                self.assertEqual(result["interpreted"]["state"], state)
                self.assertIn("ttl:180", result["expires_with"])

    def test_blocked_and_working_keep_unknown_but_carry_the_task(self):
        for state in ("blocked", "working"):
            with self.subTest(state=state):
                result = assemble(self.inputs(state))
                self.assertEqual((result["activity"], result["can_interrupt"]), ("unknown", False))
                self.assertEqual(result["interpreted"]["title"], "对照 SQLite WAL 文档改写入代码")

    def test_rules_keep_priority(self):
        result = assemble(self.inputs(app="Code", bundle_id="com.microsoft.VSCode"))
        self.assertEqual((result["activity"], result["confidence"]), ("editing_code", CONFIDENCE["category"]))

    def test_a_stale_task_or_another_window_names_nothing(self):
        for inputs in (self.inputs(age=181.0), self.inputs(window_id=10)):
            with self.subTest(inputs=inputs["interpreted"]):
                result = assemble(inputs)
                self.assertEqual(result["activity"], "unknown")
                self.assertIsNone(result["interpreted"])

    def test_a_task_without_a_window_id_matches_by_bundle(self):
        inputs = self.inputs()
        inputs["interpreted"][0]["windows"] = [{"window_id": None, "bundle_id": "com.anthropic.claudefordesktop"}]
        self.assertEqual(assemble(inputs)["activity"], "reading")

    def test_adapter_keeps_fresh_tasks_with_their_windows(self):
        rows = {"obs-1": {"metadata": {"window_id": 9, "bundle_id": "b", "title": "x"}}}
        understanding = {"tasks": [
            {"task_key": "a", "title": "A", "current_step": "读", "state": "reading", "last_observed_at": T0 - 10,
             "evidence": [{"observation_id": "obs-1"}, {"observation_id": "gone"}]},
            {"task_key": "b", "title": "B", "current_step": "改", "state": "working", "last_observed_at": T0 - 500,
             "evidence": [{"observation_id": "obs-1"}]}]}
        self.assertEqual(activity_module.interpreted(understanding, rows.get, T0),
                         [{"task_key": "a", "title": "A", "summary": "读", "state": "reading", "observed_at": T0 - 10,
                           "windows": [{"window_id": 9, "bundle_id": "b"}]}])
        self.assertEqual(activity_module.interpreted({"available": False, "tasks": []}, rows.get, T0), [])


class PublicOnly:
    """A store seen only through its public attributes."""

    def __init__(self, target):
        self.target = target

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(f"private attribute {name} read")
        return getattr(self.target, name)


if __name__ == "__main__":
    unittest.main()
