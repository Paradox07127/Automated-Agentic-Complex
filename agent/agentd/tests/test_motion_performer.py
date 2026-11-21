"""The generated motion backend: settings, the performer with a fake service and retarget, its routes and turns."""
import hashlib
import http.client
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import c1  # noqa: E402
from brain import persona  # noqa: E402
from daemon.agentd_server import AgentdServer  # noqa: E402
from motion import catalog as motion_catalog  # noqa: E402
from motion.client import ServiceError  # noqa: E402
from motion.performer import Performer  # noqa: E402
from motion.settings import MotionSettings  # noqa: E402
import support  # noqa: E402
import test_server  # noqa: E402


def bound_prompt(server):
    """The persona prompt a turn renders for the current character under its effective binding."""
    from brain.provider import chat_system
    from character.binding import effective
    mouth = server.mouth
    return chat_system(mouth.card, effective(server), mouth.egress, mouth.motion_phrases)[0]


UI, EVENTS = support.UI, "events-token"
SERVICE = {"backend": "generated", "service_url": "http://127.0.0.1:48830", "token": "service-secret"}
PACKAGES = Path(__file__).resolve().parent / "fixtures" / "motion-catalog"  # <id>/runtime/characters/<id>/c7/animation


def wait_for(predicate, seconds=5.0):
    deadline = time.monotonic() + seconds
    while not predicate() and time.monotonic() < deadline:
        time.sleep(0.01)
    return predicate()


class Clock:
    def __init__(self):
        self.t = 100.0

    def __call__(self):
        return self.t


class FakeClient:
    """The motion service: generate takes `delay` seconds of the fake clock, or raises `error`."""

    def __init__(self, clock, delay=0.4, error=None, gate=None):
        self.clock, self.delay, self.error, self.gate, self.calls = clock, delay, error, gate, []

    def generate(self, url, token, prompt, seconds, timeout=None):
        self.calls.append((url, token, prompt, seconds))
        self.timeout = timeout
        if self.gate is not None:
            self.gate.wait(5)
        if self.error is not None:
            raise self.error
        self.clock.t += self.delay
        return b"NPZ " + prompt.encode()

    def skeleton(self, url, token):
        return {"joints": ["Hips", "Spine"]}


class FakeRetarget:
    rig_sha256 = "c" * 64
    quality = {"removed_travel_m": 0.02, "toe_min_cm": 1.3, "hips_excursion_m": 0.05}

    def __init__(self, package_root, cache_dir):
        self.package_root, self.cache_dir, self.doc = package_root, cache_dir, None

    def skeleton(self, doc):
        self.doc = doc

    def clip(self, npz_bytes, motion_id, kind="perform", geometry=None):
        self.geometry = geometry
        keys = b"EFKEY001" + npz_bytes
        tracks = None if kind == "perform" else {"schema": "endfield-generated-tracks/v1", "id": motion_id,
                                                 "kind": kind, "rate_hz": 30, "loop": False}
        return ({"schema": "metal-actor-clip-v1", "name": motion_id, "length": 3.0, "frame_rate": 30, "loop": False,
                 "curves": [], "curve_provenance": {"quality": dict(self.quality)},
                 "keys": {"file": f"{motion_id}.keys", "sha256": hashlib.sha256(keys).hexdigest(),
                          "byte_count": len(keys)}}, keys, tracks)


class MotionCase(unittest.TestCase):
    def setUp(self):
        support.enable_plugins(self, "motion_generation")
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.state = Path(tmp.name)
        self.server = AgentdServer(("127.0.0.1", 0), test_server.HOOK, UI, events_token=EVENTS)
        self.server.character_agent = test_server.KernelLines(self.server)
        self.thread = support.serve_in_thread(self.server)
        self.addCleanup(self.thread.join, 2)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.clock, self.traced, self.texts = Clock(), [], []
        self.settings = MotionSettings(self.state)

    request = support.request

    def performer(self, package_root=None, **client):
        self.client = FakeClient(self.clock, **client)
        self.server.motion = Performer(self.settings, self.server.registry.publish_event,
                                       package_root or (lambda: self.state / "pkg"), self.state / "cache",
                                       trace=self.trace, client=self.client, retarget=FakeRetarget, clock=self.clock)
        return self.server.motion

    def trace(self, kind, trace_id, **fields):
        self.traced.append((kind, trace_id, fields["attrs"]))
        self.texts.append(fields.get("texts"))

    def behaviors(self):
        return [e for e in self.server.registry.intents if e.get("event") == "behavior"]

    def fetch(self, path, token=EVENTS):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        conn.request("GET", path, headers={"Authorization": f"Bearer {token}"})
        response = conn.getresponse()
        data = response.read()
        conn.close()
        return response.status, response.getheader("Content-Type"), data


class PerformerTest(MotionCase):
    def setUp(self):
        super().setUp()
        self.settings.update(SERVICE)

    def test_success_publishes_one_perform_and_serves_its_files(self):
        self.performer().start("waves her right hand happily", 3.0, 4, "trace-1")
        self.assertTrue(wait_for(lambda: self.traced))
        kind, trace_id, attrs = self.traced[0]
        self.assertEqual((kind, trace_id), ("motion.published", "trace-1"))
        self.assertEqual(attrs["generate_ms"], 400)
        self.assertLessEqual({"generate_ms", "retarget_ms", "total_ms"}, set(attrs))
        self.assertEqual(self.client.calls, [(SERVICE["service_url"], "service-secret", "waves her right hand happily", 3.0)])
        [behavior] = self.behaviors()
        self.assertEqual(c1.check_message(behavior), [])
        self.assertEqual((behavior["type"], behavior["trigger"]["source"], behavior["turn_generation"],
                          behavior["trace_id"]), ("perform", "agent", 4, "trace-1"))
        motion = behavior["motion"]
        self.assertEqual((motion["rig_sha256"], motion["length_s"]), ("c" * 64, 3.0))
        status, kind, meta = self.fetch(f"/motions/{motion['id']}/meta")
        self.assertEqual((status, kind), (200, "application/json"))
        self.assertEqual(hashlib.sha256(meta).hexdigest(), motion["meta_sha256"])
        self.assertEqual(json.loads(meta)["name"], motion["id"])
        status, kind, keys = self.fetch(f"/motions/{motion['id']}/keys", token=UI)
        self.assertEqual((status, kind), (200, "application/octet-stream"))
        self.assertEqual(hashlib.sha256(keys).hexdigest(), motion["keys_sha256"])
        self.assertEqual(json.loads(meta)["keys"]["sha256"], motion["keys_sha256"])
        self.assertEqual(self.fetch("/motions/gm-0000000000000000/keys")[::2], (404, b'{"error": "unknown_motion"}'))
        self.assertEqual(self.fetch(f"/motions/{motion['id']}/meta", token="hook-token")[0], 401)
        self.assertEqual(self.texts[0], {"prompt": "waves her right hand happily"})

    def test_a_failure_and_a_replaced_motion_carry_their_prompt(self):
        gate = threading.Event()
        performer = self.performer(gate=gate, error=ServiceError("http_500"))
        performer.start("motion number 0", 2.0, 4, "trace-0")
        performer.start("motion number 1", 2.0, 4, "trace-1")
        performer.start("motion number 2", 2.0, 4, "trace-2")
        gate.set()
        self.assertTrue(wait_for(lambda: len(self.traced) == 3))
        self.assertEqual(sorted((t[1], text["prompt"]) for t, text in zip(self.traced, self.texts)),
                         [("trace-0", "motion number 0"), ("trace-1", "motion number 1"), ("trace-2", "motion number 2")])

    def test_a_failure_and_a_replaced_motion_not_remembered_carry_no_prompt(self):
        gate = threading.Event()
        performer = self.performer(gate=gate, error=ServiceError("http_500"))
        for i in range(3):
            performer.start(f"motion number {i}", 2.0, 4, f"trace-{i}", False)
        gate.set()
        self.assertTrue(wait_for(lambda: len(self.traced) == 3))
        self.assertEqual(self.texts, [{}, {}, {}])

    def test_a_service_slower_than_the_old_2_5_s_still_publishes_and_gets_the_budget_left_as_its_timeout(self):
        self.performer(delay=3.0).start("waves her right hand happily", 3.0, 4, "trace-1")
        self.assertTrue(wait_for(lambda: self.traced))
        self.assertEqual(self.traced[0][:2], ("motion.published", "trace-1"))
        self.assertAlmostEqual(self.client.timeout, 4.0 - 0.3)

    def test_a_slow_service_publishes_nothing_and_logs_a_timeout(self):
        self.performer(delay=4.5).start("waves her right hand happily", 3.0, 4, "trace-1")
        self.assertTrue(wait_for(lambda: self.traced))
        self.assertEqual(self.traced[0][:2], ("motion.fallback", "trace-1"))
        self.assertEqual(self.traced[0][2]["reason"], "timeout")
        self.assertEqual(self.behaviors(), [])

    def test_a_service_error_publishes_nothing(self):
        self.performer(error=ServiceError("http_500")).start("waves her right hand happily", 3.0, 4, "trace-1")
        self.assertTrue(wait_for(lambda: self.traced))
        self.assertEqual(self.traced, [("motion.fallback", "trace-1", {"reason": "http_500", "total_ms": 0})])
        self.assertEqual(self.behaviors(), [])

    def test_a_newer_motion_replaces_the_waiting_one(self):
        gate = threading.Event()
        performer = self.performer(gate=gate)
        for n in range(3):
            performer.start(f"motion number {n}", 2.0, 4, f"trace-{n}")
        gate.set()
        self.assertTrue(wait_for(lambda: len(self.traced) == 3))
        self.assertEqual([prompt for _, _, prompt, _ in self.client.calls], ["motion number 0", "motion number 2"])
        self.assertIn(("motion.fallback", "trace-1", {"reason": "replaced"}), self.traced)
        self.assertEqual(len(self.behaviors()), 2)

    def quality_case(self, **quality):
        performer = self.performer()
        performer._retarget = type("Retarget", (FakeRetarget,), {"quality": {**FakeRetarget.quality, **quality}})
        performer.start("waves her right hand happily", 3.0, 4, "trace-1")
        self.assertTrue(wait_for(lambda: self.traced))
        return self.traced

    def test_a_motion_that_travels_publishes_nothing_and_logs_quality(self):
        self.assertEqual(self.quality_case(removed_travel_m=0.8),
                         [("motion.fallback", "trace-1", {"reason": "quality", "checks": ["travel"],
                                                          "removed_travel_m": 0.8, "toe_min_cm": 1.3, "total_ms": 400})])
        self.assertEqual(self.behaviors(), [])
        self.assertEqual(len(self.server.motion.store._motions), 0)

    def test_a_motion_whose_toes_sink_below_the_ground_publishes_nothing(self):
        self.assertEqual(self.quality_case(toe_min_cm=-7.0),
                         [("motion.fallback", "trace-1", {"reason": "quality", "checks": ["floor"],
                                                          "removed_travel_m": 0.02, "toe_min_cm": -7.0, "total_ms": 400})])
        self.assertEqual(self.behaviors(), [])

    def test_both_checks_are_listed_and_a_clean_motion_publishes(self):
        self.assertEqual(self.quality_case(removed_travel_m=0.8, toe_min_cm=-7.0)[0][2]["checks"], ["travel", "floor"])
        self.traced.clear()
        self.assertEqual(self.quality_case(removed_travel_m=0.02, toe_min_cm=1.3)[0][:2], ("motion.published", "trace-1"))
        self.assertEqual(len(self.behaviors()), 1)


class MatchTest(MotionCase):
    """A [motion:] text that names one of the character's game gestures plays that clip instead of a generated one."""

    def setUp(self):
        super().setUp()
        self.settings.update(SERVICE)
        self.root = PACKAGES / "aster"
        self.performer(package_root=lambda: self.root)

    def test_a_named_game_gesture_is_published_as_an_action_without_the_service(self):
        before = time.time()
        self.server.motion.start("waves her right hand happily", 3.0, 4, "trace-1")
        self.assertTrue(wait_for(lambda: self.traced))
        self.assertEqual(self.client.calls, [])
        [behavior] = self.behaviors()
        self.assertEqual(c1.check_message(behavior), [])
        self.assertNotIn("motion", behavior)
        self.assertRegex(behavior["behavior_id"], r"^b-ga-[0-9a-f]{16}$")
        action = behavior["action"]
        self.assertIn(action["id"], ("dialog_single_wave1", "dialog_single_wave2"))
        self.assertEqual((behavior["type"], behavior["target"], behavior["channels"], behavior["trigger"],
                          behavior["turn_generation"], behavior["priority"], behavior["trace_id"]),
                         ("perform", None, ["full_body"], {"source": "agent", "event": None}, 4, 1, "trace-1"))
        expires = (behavior["expires_at_ms"] / 1000) - action["length_s"] - 6.0
        self.assertTrue(before - 0.01 <= expires <= time.time() + 0.01)
        self.assertEqual(self.traced, [("motion.matched", "trace-1", {"action_id": action["id"], "group": "wave",
                                                                      "length_s": action["length_s"], "seconds": 3.0})])
        self.assertEqual(self.texts, [{"prompt": "waves her right hand happily"}])

    def test_a_turn_not_remembered_leaves_the_prompt_out_of_its_traces(self):
        self.server.motion.start("waves her right hand happily", 3.0, 4, "trace-1", False)
        self.assertTrue(wait_for(lambda: self.traced))
        self.assertEqual(self.texts, [{}])

    def test_the_member_closest_to_the_marker_seconds_plays(self):
        self.server.motion.start("thinks it over", 6.0, 4, "trace-1")
        self.assertTrue(wait_for(lambda: self.traced))
        found = motion_catalog.load(self.root); lengths = {aid: row["length_s"] for aid, row in found.items()}
        think = [aid for aid, row in found.items() if "think" in row["gestures"]]
        self.assertEqual(self.behaviors()[0]["action"]["id"], min(think, key=lambda aid: abs(lengths[aid] - 6.0)))

    def test_an_unnamed_motion_is_generated_as_before(self):
        self.server.motion.start("does a cartwheel", 3.0, 4, "trace-1")
        self.assertTrue(wait_for(lambda: self.traced))
        self.assertEqual(self.traced[0][:2], ("motion.published", "trace-1"))
        self.assertEqual([prompt for _, _, prompt, _ in self.client.calls], ["does a cartwheel"])
        self.assertIn("motion", self.behaviors()[0])

    def test_near_misses_never_play_the_wrong_gesture(self):
        for prompt, wrong in (("points her toes and does a ballet spin", "dialog_state_point_start"),
                              ("touches her earpiece and listens", "dialog_state_earring_start")):
            for root in (PACKAGES / "aster", PACKAGES / "birch"):
                with self.subTest(prompt=prompt, root=root.name):
                    self.root = root
                    self.server.registry.intents.clear()
                    self.traced.clear()
                    self.server.motion.start(prompt, 3.0, 4, "trace-1")
                    self.assertTrue(wait_for(lambda: self.traced))
                    self.assertNotEqual((self.behaviors()[0].get("action") or {}).get("id"), wrong)

    def test_the_catalog_follows_the_current_character(self):
        self.server.motion.start("bows deeply", 2.0, 4, "trace-1")
        self.assertTrue(wait_for(lambda: self.traced))
        self.assertEqual(self.traced[0][2]["action_id"], "dialog_single_bow")
        self.root = PACKAGES / "birch"  # she has no bow
        self.server.motion.start("bows deeply", 2.0, 4, "trace-2")
        self.assertTrue(wait_for(lambda: len(self.traced) == 2))
        self.assertEqual(self.traced[1][:2], ("motion.published", "trace-2"))

    def test_the_catalog_is_read_once_per_package(self):
        reads = []
        real = motion_catalog.load
        self.addCleanup(setattr, motion_catalog, "load", real)
        motion_catalog.load = lambda root: reads.append(root) or real(root)
        for n in range(3):
            self.server.motion.start("nods slowly", 2.0, 4, f"trace-{n}")
        self.root = PACKAGES / "birch"
        self.server.motion.start("nods slowly", 2.0, 4, "trace-3")
        self.assertEqual(reads, [PACKAGES / "aster", PACKAGES / "birch"])


class TraceKindTest(unittest.TestCase):
    def test_the_performer_steps_are_known_trace_kinds(self):
        from traces import trace_format
        prompt = {"len": 28, "head": "waves he"}
        for kind, attrs in (("motion.published", {"motion_id": "gm-0123456789abcdef", "behavior_id": "b-gm-0123456789abcdef",
                                                  "generate_ms": 600, "retarget_ms": 700, "total_ms": 1400}),
                            ("motion.fallback", {"reason": "timeout", "total_ms": 2600}),
                            ("motion.fallback", {"reason": "replaced"}),
                            ("motion.fallback", {"reason": "off_heading", "retried": True,
                                                 "problems": ["the last heading -317° is over 90° from 0°"],
                                                 "total_ms": 1100}),
                            ("motion.fallback", {"reason": "quality", "checks": ["travel", "floor"],
                                                 "removed_travel_m": 0.8, "toe_min_cm": -7.0, "total_ms": 400}),
                            ("motion.matched", {"action_id": "dialog_single_wave1", "group": "wave", "length_s": 2.4,
                                                "seconds": 3.0, "prompt": prompt})):
            with self.subTest(kind=kind, attrs=attrs):
                self.assertIn(kind, trace_format.KINDS)
                self.assertEqual([k for k, ok in trace_format.KINDS[kind].items() if not ok(attrs.get(k))], [])


class PrewarmTest(MotionCase):
    def test_prewarm_builds_the_retarget_once_in_generated_mode_only(self):
        performer = self.performer()
        performer.prewarm("generated")  # no service URL yet
        self.settings.update(SERVICE)
        performer.prewarm("game")
        time.sleep(0.2)
        self.assertEqual(performer._retargets, {})
        performer.prewarm("generated")
        self.assertTrue(wait_for(lambda: performer._retargets))
        performer.start("waves her right hand happily", 3.0, 4, "trace-1")
        self.assertTrue(wait_for(lambda: self.traced))
        self.assertEqual(len(performer._retargets), 1)


class SettingsRouteTest(MotionCase):
    def setUp(self):
        super().setUp()
        self.performer()

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_put_never_echoes_the_token_rejects_a_bad_url_and_persists(self):
        self.assertEqual(self.request("GET", "/motion/settings"),
                         (200, {"backend": "game", "service_url": None, "token_set": False}))
        status, saved = self.request("PUT", "/motion/settings", SERVICE)
        self.assertEqual(status, 200)
        self.assertNotIn("service-secret", json.dumps(saved))
        self.assertEqual(saved, {"backend": "generated", "service_url": SERVICE["service_url"], "token_set": True})
        self.assertNotIn("service-secret", json.dumps(self.request("GET", "/motion/settings")))
        for url in ("ftp://127.0.0.1/", "file:///etc/passwd", "127.0.0.1:48830", "http://", 5):
            with self.subTest(url=url):
                self.assertEqual(self.request("PUT", "/motion/settings", {**SERVICE, "service_url": url}),
                                 (400, {"error": "invalid_service_url"}))
        self.assertEqual(self.request("PUT", "/motion/settings", {**SERVICE, "backend": "kimodo"})[0], 400)
        self.assertEqual(self.request("PUT", "/motion/settings", {"backend": "game"})[0], 400)
        self.assertEqual(self.request("PUT", "/motion/settings", SERVICE, token=EVENTS)[0], 401)
        reloaded = MotionSettings(self.state)
        self.assertEqual((reloaded.backend, reloaded.service_url, reloaded.token()),
                         ("generated", SERVICE["service_url"], "service-secret"))
        self.assertEqual(os.stat(self.state / "motion-service.token").st_mode & 0o777, 0o600)
        self.assertNotIn("service-secret", (self.state / "motion-settings.json").read_text(encoding="utf-8"))
        status, saved = self.request("PUT", "/motion/settings", {"backend": "game", "service_url": None})
        self.assertEqual((status, saved["token_set"]), (200, False))
        self.assertEqual(MotionSettings(self.state).backend, "game")

    def test_a_backend_change_rerenders_the_mouth_prompt_once(self):
        self.server.mouth = test_server.FakeMouth([])
        self.request("PUT", "/motion/settings", SERVICE)
        self.request("PUT", "/motion/settings", SERVICE)
        self.assertEqual(self.server.mouth.refreshed, 1)
        self.request("PUT", "/motion/settings", {"backend": "game", "service_url": None})
        self.assertEqual(self.server.mouth.refreshed, 2)

    def mouth(self):
        from brain.provider import Mouth
        self.server.character = "aster"
        self.server.mouth = Mouth(character="aster")
        return lambda: bound_prompt(self.server)

    def test_the_mouth_lists_its_characters_game_gestures_under_either_driver(self):
        from brain.provider import Mouth
        phrases = motion_catalog.phrases(motion_catalog.load(PACKAGES / "aster"))
        self.server.character = "aster"
        self.server.mouth = Mouth(character="aster", motion_phrases=phrases)
        text = lambda: bound_prompt(self.server)  # noqa: E731
        self.request("PUT", "/motion/settings", SERVICE)
        self.assertIn(persona.MOTION_RULE + persona.MOTION_PHRASES.format("; ".join(phrases)), text())
        self.request("PUT", "/motion/settings", {"backend": "game", "service_url": None})
        self.assertIn(persona.GAME_MOTION_RULE.format(phrases[0], "; ".join(phrases)), text())
        self.assertNotIn(persona.MOTION_RULE, text())

    def test_the_real_mouth_prompt_follows_the_backend(self):
        text = self.mouth()
        self.assertNotIn("[motion:", text())
        self.request("PUT", "/motion/settings", SERVICE)
        self.assertIn("[motion:waves her right hand happily|3]", text())
        self.request("PUT", "/motion/settings", {"backend": "game", "service_url": None})
        self.assertNotIn("[motion:", text())

    def test_a_bound_driver_outranks_the_global_backend(self):
        from character.binding import Bindings
        text = self.mouth()
        self.server.bindings = Bindings(self.state, self.server.characters, lambda: self.settings.backend)
        self.server.bindings.update("aster", {"revision": 0, "motion": {"driver": "game"}})
        self.request("PUT", "/motion/settings", SERVICE)
        self.assertNotIn("[motion:", text())
        time.sleep(0.2)
        self.assertEqual(self.server.motion._retargets, {})  # no prewarm for a character bound to game
        self.server.bindings.update("aster", {"revision": 1, "motion": None})
        self.request("PUT", "/motion/settings", {"backend": "game", "service_url": None})
        self.request("PUT", "/motion/settings", SERVICE)
        self.assertIn(persona.MOTION_RULE, text())


class MotionTurnTest(MotionCase):
    REPLY = ["[intent:greet][motion:waves her right ", "hand happily|3]你好", "。"]

    def setUp(self):
        super().setUp()
        self.server.character = "aster"
        self.starts, self.gestures = [], []
        self.server.motion = type("Motion", (), {"settings": self.settings,
                                                 "start": lambda _, *args: self.starts.append(args),
                                                 "gesture": lambda _, *args: self.gestures.append(args)})()

    def say(self):
        self.server.mouth = test_server.FakeMouth(self.REPLY + ["[motion:bows deeply|2]"])
        status, said = self.request("POST", "/say", {"text": "你好", "source": "text"})
        self.assertEqual(status, 202)
        self.assertTrue(wait_for(lambda: not self.server._live_lines))
        lines = [e["data"] for e in self.server.feed.since(0) if e["event"] == "line"]
        return said["line_id"], "".join(line["text_delta"] for line in lines)

    def test_game_mode_strips_the_marker_and_starts_nothing(self):
        _, text = self.say()
        self.assertEqual(text, "你好。")
        self.assertEqual(self.starts, [])
        self.assertEqual([prompt for prompt, *_ in self.gestures], ["waves her right hand happily"])

    def test_a_generated_binding_starts_its_characters_motion_and_not_anothers(self):
        from character.binding import Bindings
        self.server.bindings = Bindings(self.state, self.server.characters, lambda: self.settings.backend)
        self.server.bindings.update("aster", {"revision": 0, "motion": {"driver": "generated"}})
        self.assertEqual(self.say()[1], "你好。")
        self.assertEqual([prompt for prompt, *_ in self.starts], ["waves her right hand happily"])
        self.assertTrue(self.server.set_character("birch"))
        self.say()
        self.assertEqual(len(self.starts), 1)

    def test_a_game_binding_outranks_a_generated_global(self):
        from character.binding import Bindings
        self.settings.update(SERVICE)
        self.server.bindings = Bindings(self.state, self.server.characters, lambda: self.settings.backend)
        self.server.bindings.update("aster", {"revision": 0, "motion": {"driver": "game"}})
        self.say()
        self.assertEqual(self.starts, [])

    def test_generated_mode_starts_the_first_motion_marker_once(self):
        self.settings.update(SERVICE)
        line_id, text = self.say()
        self.assertEqual(text, "你好。")
        self.assertEqual(self.gestures, [])
        [(prompt, seconds, generation, trace_id, remember)] = self.starts
        self.assertEqual((prompt, seconds, generation, remember), ("waves her right hand happily", 3.0, self.server.turn_generation, True))
        self.assertIsInstance(trace_id, str)

    def test_a_turn_not_remembered_tells_the_performer(self):
        self.settings.update(SERVICE)
        self.server.mouth = test_server.FakeMouth(self.REPLY)
        status, _ = self.server.say("你好", source="text", remember=False)
        self.assertEqual(status, 202)
        self.assertTrue(wait_for(lambda: not self.server._live_lines))
        [(*_, remember)] = self.starts
        self.assertFalse(remember)


class GameGestureTurnTest(MotionCase):
    """Under the game driver a reply's [motion:] marker that is one of her gesture phrases plays that game gesture."""

    def setUp(self):
        super().setUp()
        self.server.character = "aster"
        self.performer(package_root=lambda: PACKAGES / "aster")

    def say(self, reply):
        self.server.mouth = test_server.FakeMouth(reply)
        status, _ = self.request("POST", "/say", {"text": "你好", "source": "text"})
        self.assertEqual(status, 202)
        self.assertTrue(wait_for(lambda: not self.server._live_lines))
        return [e for e in self.server.registry.intents if e.get("event") == "clause_intent"]

    def test_a_listed_phrase_plays_its_gesture_once_beside_the_clause_intent(self):
        intents = self.say(["[intent:greet][motion:Bows ", "slightly.|2]你好", "。[motion:nods her head|1]"])
        [behavior] = self.behaviors()
        self.assertEqual(c1.check_message(behavior), [])
        self.assertEqual((behavior["type"], behavior["action"]["id"], behavior["turn_generation"]),
                         ("perform", "dialog_single_bow", self.server.turn_generation))
        self.assertEqual([intent["intent"] for intent in intents], ["greet"])
        self.assertEqual([kind for kind, *_ in self.traced], ["motion.matched"])
        self.assertEqual(self.client.calls, [])

    def test_an_unlisted_motion_is_dropped(self):
        intents = self.say(["[intent:greet][motion:waves her right hand happily|3]你好。"])
        self.assertEqual(self.behaviors(), [])
        self.assertEqual([intent["intent"] for intent in intents], ["greet"])
        self.assertEqual((self.traced, self.client.calls), ([], []))


if __name__ == "__main__":
    unittest.main()
