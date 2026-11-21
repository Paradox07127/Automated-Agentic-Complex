"""Host-requested generated motion: the Kimodo request per kind, POST /motions/generate, its slot and event: motion."""
import hashlib
import io
import json
import math
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import c1  # noqa: E402
from motion import requests  # noqa: E402
import test_motion_performer as base  # noqa: E402

S = 0.9247  # birch's SomaToRig scale


def to_kimodo(value):
    """The contract's mapping with C = I: p_K = (−x, y, z)/s, yaw_K = −yaw (degrees)."""
    if isinstance(value, (int, float)):
        return -value
    x, y, z = value
    return [-x / S, y / S, z / S]


def request(kind="walk", geometry=None, behavior_id="b-walk-1", request_id="mr-0123456789abcdef", seconds=3.0):
    return {"request_id": request_id, "behavior_id": behavior_id, "kind": kind, "seconds": seconds,
            "geometry": {"to": [-1.2, 0.0], "end_yaw": 0} if geometry is None else geometry}


from motion.performer import request_trace  # noqa: E402
from traces.trace_format import UUID  # noqa: E402

class GeometryClient(base.FakeClient):
    def generate(self, url, token, prompt, seconds, constraints=None, timeout=None):
        self.constraints = constraints
        return super().generate(url, token, prompt, seconds, timeout=timeout)


class CountingClient(GeometryClient):
    """Each generate answers a different npz: its call number."""

    def generate(self, *args, **kwargs):
        return super().generate(*args, **kwargs) + b" #%d" % len(self.calls)


class GeometryRetarget(base.FakeRetarget):
    to_kimodo = staticmethod(to_kimodo)
    headings = ([0.0] * 121,)  # heading() answers these in turn, the last one again and again

    def __init__(self, package_root, cache_dir):
        super().__init__(package_root, cache_dir)
        self.headed = []

    def heading(self, npz_bytes):
        self.headed.append(npz_bytes)
        return self.headings[min(len(self.headed), len(self.headings)) - 1]


def by_time(keys):
    return sorted(keys, key=lambda k: k["t"])


def heading(seconds, *points, fps=30):
    """A per-frame heading in degrees through (t, degrees) points, straight between them."""
    out = []
    for i in range(round(seconds * fps) + 1):
        t = i / fps
        (t0, d0), (t1, d1) = next((a, b) for a, b in zip(points, points[1:]) if t <= b[0] + 1e-9)
        out.append(d0 + (d1 - d0) * (t - t0) / (t1 - t0))
    return out


WALK_3M = ("walk", {"to": [3.0, 0.0], "end_yaw": 0}, 4.0)  # to her right: mid yaw -90°
LONG_WAY = heading(4.0, (0, 0), (2.0, -92), (2.8, -170), (4.0, -317))  # turns back the long way round


class RequestsTest(unittest.TestCase):
    def build(self, kind, geometry, seconds=3.0):
        return requests.build(kind, seconds, geometry, to_kimodo)

    def test_a_short_walk_to_her_screen_right_is_a_sidestep_ending_at_x_over_s(self):
        prompt, constraints = self.build("walk", {"to": [-1.2, 0.0], "end_yaw": 0})
        self.assertIn("side-steps to the left", prompt)
        start, end = by_time(constraints["root"])
        self.assertEqual((start["t"], start["x"], start["z"], start["yaw"]), (0, 0, 0, 0))
        self.assertEqual(end["t"], 3.0)
        self.assertAlmostEqual(end["x"], 1.2 / S, places=6)
        self.assertAlmostEqual(end["x"], 1.2977, places=3)
        self.assertEqual((end["z"], end["yaw"]), (0, 0))
        self.assertNotIn("effectors", constraints)

    def test_a_short_walk_to_her_right_hand_mirrors(self):
        prompt, constraints = self.build("walk", {"to": [1.0, 0.0], "end_yaw": 0})
        self.assertIn("side-steps to the right", prompt)
        self.assertAlmostEqual(by_time(constraints["root"])[-1]["x"], -1.0 / S, places=6)

    def test_a_long_walk_turns_walks_and_turns_back_through_three_mid_frames(self):
        prompt, constraints = self.build("walk", {"to": [-2.4, 0.0], "end_yaw": 0}, seconds=5.0)
        self.assertIn("turns to the left", prompt)
        start, _, mid, _, end = by_time(constraints["root"])
        self.assertEqual(start, {"t": 0, "x": 0, "z": 0, "yaw": 0})
        self.assertEqual(mid["t"], 2.5)
        self.assertAlmostEqual(mid["x"], 1.2 / S, places=6)
        self.assertAlmostEqual(mid["yaw"], math.pi / 2)
        self.assertAlmostEqual(end["x"], 2.4 / S, places=6)
        self.assertEqual(end["yaw"], 0)
        prompt, constraints = self.build("walk", {"to": [2.4, 0.0], "end_yaw": 30}, seconds=5.0)
        self.assertIn("turns to the right", prompt)
        _, _, mid, _, end = by_time(constraints["root"])
        self.assertAlmostEqual(mid["yaw"], -math.pi / 2)
        self.assertAlmostEqual(end["yaw"], math.radians(-30))

    def test_a_long_walk_faces_its_mid_yaw_on_the_line_at_a_quarter_and_three_quarters(self):
        """u(f) = clamp((f - 0.1) / 0.8): the keys sit on the line to the end, at u(0.25) and u(0.75) of it."""
        for to, mid_yaw in (([-2.4, 1.0], math.pi / 2), ([2.4, -1.0], -math.pi / 2)):
            _, constraints = self.build("walk", {"to": to, "end_yaw": 30}, seconds=5.0)
            keys = by_time(constraints["root"])
            self.assertEqual([k["t"] for k in keys], [0, 1.25, 2.5, 3.75, 5.0])
            end = keys[-1]
            for key, u in ((keys[1], 0.1875), (keys[3], 0.8125)):
                self.assertAlmostEqual(key["x"], end["x"] * u)
                self.assertAlmostEqual(key["z"], end["z"] * u)
                self.assertAlmostEqual(key["yaw"], mid_yaw)

    def test_a_turn_holds_its_end_yaw_from_eight_tenths(self):
        prompt, constraints = self.build("turn", {"yaw": 30}, seconds=2.0)
        self.assertIn("turns slightly to their right", prompt)
        start, hold, end = by_time(constraints["root"])
        self.assertEqual(start, {"t": 0, "x": 0, "z": 0, "yaw": 0})
        self.assertAlmostEqual(hold["t"], 1.6)
        for key in (hold, end):
            self.assertEqual((key["x"], key["z"]), (0, 0))
            self.assertAlmostEqual(key["yaw"], math.radians(-30))
        self.assertEqual(end["t"], 2.0)
        prompt, constraints = self.build("turn", {"yaw": -180}, seconds=2.5)
        self.assertIn("turns around to their left", prompt)
        self.assertAlmostEqual(by_time(constraints["root"])[-1]["yaw"], math.pi)

    def test_a_turn_has_no_yaw_key_before_eight_tenths(self):
        for yaw, seconds in ((30, 1.5), (-120, 2.5)):
            _, constraints = self.build("turn", {"yaw": yaw}, seconds=seconds)
            turned = [k["t"] for k in by_time(constraints["root"]) if k["yaw"] != 0]
            self.assertEqual(len(turned), 2)
            self.assertAlmostEqual(turned[0], 0.8 * seconds)
            self.assertEqual(turned[1], seconds)

    def test_heading_problems_pass_a_walk_or_turn_facing_its_plan_and_catch_one_that_turns_the_long_way(self):
        sidestep = ("walk", {"to": [-1.2, 0.0], "end_yaw": 0}, 3.0)
        turn_30 = ("turn", {"yaw": 30}, 2.0)  # her right: -30°
        cases = (("3 m walk", WALK_3M, heading(4.0, (0, 0), (1.0, -60), (2.0, -92), (2.8, -170), (4.0, -10)), True),
                 ("3 m walk ending at -317°", WALK_3M, LONG_WAY, False),
                 ("3 m walk ending at -137°", WALK_3M, heading(4.0, (0, 0), (2.0, -92), (2.8, -170), (4.0, -137)), False),
                 ("3 m walk facing front at T/2", WALK_3M, heading(4.0, (0, 0), (2.0, -20), (4.0, 0)), False),
                 ("3 m walk off at the quarter keys", WALK_3M,
                  heading(4.0, (0, 0), (1.0, -5), (2.0, -92), (3.0, -175), (4.0, 0)), True),
                 ("3 m walk peaking at -210°", WALK_3M, heading(4.0, (0, 0), (2.0, -92), (2.8, -210), (4.0, -10)), False),
                 ("1.2 m side-step peaking at 37°", sidestep, heading(3.0, (0, 0), (1.5, 37), (3.0, 3)), True),
                 ("turn 30", turn_30, heading(2.0, (0, 0), (1.6, -29.5), (2.0, -29)), True),
                 ("turn 30 ending 20° short", turn_30, heading(2.0, (0, 0), (2.0, -10)), False),
                 ("turn 30 swinging to -80°", turn_30, heading(2.0, (0, 0), (1.0, -80), (2.0, -30)), False),
                 ("sit_loop", ("sit_loop", {"seat": [0.0, 0.5, -0.2]}, 3.0), heading(3.0, (0, 0), (3.0, -300)), True))
        for name, (kind, geometry, seconds), turned, passes in cases:
            with self.subTest(name):
                _, constraints = self.build(kind, geometry, seconds)
                problems = requests.heading_problems(kind, seconds, constraints, turned)
                self.assertEqual(problems == [], passes, problems)
                self.assertTrue(all(isinstance(p, str) for p in problems))

    def test_window_loop_pins_the_hips_at_1_10_four_times(self):
        prompt, constraints = self.build("window_loop", {"hips": [0.0, 0.9, 0.0]}, seconds=6.0)
        self.assertIn("edge of a high table", prompt)
        hips = constraints["effectors"]
        self.assertEqual([e["t"] for e in hips], [0, 2.0, 4.0, 6.0])
        for effector in hips:
            self.assertEqual(effector["joint"], "Hips")
            self.assertAlmostEqual(effector["pos"][1], 1.10)
            self.assertEqual(effector["pos"][0], 0)

    def test_sit_enter_puts_the_hips_on_the_seat_at_2_5_s(self):
        prompt, constraints = self.build("sit_enter", {"seat": [0.0, 0.5, -0.2]})
        self.assertIn("sits down", prompt)
        self.assertEqual(constraints["root"], [{"t": 0, "x": 0, "z": 0, "yaw": 0}])
        [hips] = constraints["effectors"]
        self.assertEqual((hips["joint"], hips["t"]), ("Hips", 2.5))
        for got, want in zip(hips["pos"], (0.0, 0.5 / S, -0.2 / S)):
            self.assertAlmostEqual(got, want)

    def test_sit_loop_and_exit_pin_the_hips_at_the_seat_height_over_the_origin(self):
        _, loop = self.build("sit_loop", {"seat": [0.0, 0.5, -0.2]}, seconds=6.0)
        self.assertEqual([(e["joint"], e["t"], e["pos"]) for e in loop["effectors"]],
                         [("Hips", t, [0, 0.5 / S, 0]) for t in (0, 2.0, 4.0, 6.0)])
        _, exit_ = self.build("sit_exit", {"seat": [0.0, 0.5, -0.2]})
        self.assertEqual([(e["joint"], e["t"], e["pos"]) for e in exit_["effectors"]], [("Hips", 0, [0, 0.5 / S, 0])])
        self.assertEqual(exit_["root"][-1]["t"], 3.0)

    def test_sit_loop_and_exit_are_asked_with_the_seat_as_origin_and_exit_ends_at_the_actor_root(self):
        """Kimodo moves frame 0's root to x=z=0, so a t=0 Hips xz off the origin is ignored."""
        seat = [-0.043, 0.637, -0.465]
        seat_k = to_kimodo(seat)
        for kind in ("sit_loop", "sit_exit"):
            _, constraints = self.build(kind, {"seat": seat})
            [first] = [e for e in constraints["effectors"] if e["t"] == 0]
            self.assertEqual((first["pos"][0], first["pos"][2]), (0, 0), kind)
            self.assertAlmostEqual(first["pos"][1], seat_k[1], msg=kind)
        _, exit_ = self.build("sit_exit", {"seat": seat})
        [end] = exit_["root"]
        self.assertEqual((end["t"], end["yaw"]), (3.0, 0))
        self.assertAlmostEqual(end["x"], -seat_k[0])
        self.assertAlmostEqual(end["z"], -seat_k[2])

    def test_lean_puts_the_hand_on_the_grip_from_one_second_to_the_end(self):
        prompt, constraints = self.build("lean", {"hand": "right", "grip": [0.45, 1.25, 0.15]})
        self.assertIn("with their right hand", prompt)
        self.assertEqual(constraints["root"], [{"t": 0, "x": 0, "z": 0, "yaw": 0}])
        hands = constraints["effectors"]
        self.assertEqual([(e["joint"], e["t"]) for e in hands], [("RightHand", 1.0), ("RightHand", 2.0),
                                                                  ("RightHand", 3.0)])
        for got, want in zip(hands[0]["pos"], (-0.45 / S, 1.25 / S, 0.15 / S)):
            self.assertAlmostEqual(got, want)
        _, constraints = self.build("lean", {"hand": "left", "grip": [-0.45, 1.25, 0.15]})
        self.assertEqual({e["joint"] for e in constraints["effectors"]}, {"LeftHand"})

    def test_every_prompt_is_in_the_services_warm_prompts(self):
        """run-mac.sh encodes these at start; a prompt missing from the file is encoded on its first request."""
        warm = json.loads((Path(__file__).resolve().parents[3] / "motion/geometry-prompts.json").read_text(encoding="utf-8"))
        cases = {"turn": [{"yaw": y} for y in (30, -30, 120, -120)],
                 "walk": [{"to": [x, z], "end_yaw": 0} for x in (1.0, -1.0, 3.0, -3.0) for z in (0.0, 1.0)],
                 "window_loop": [{"hips": [x, 0.9, 0.3]} for x in (0.4, -0.4)],
                 "lean": [{"hand": h, "grip": [x, 1.25, 0.15]} for h in ("left", "right") for x in (0.45, -0.45)],
                 **{k: [{"seat": [x, 0.5, -0.2]} for x in (0.3, -0.3)] for k in ("sit_enter", "sit_loop", "sit_exit")}}
        self.assertEqual(set(cases), set(requests.GEOMETRY))
        prompts = {self.build(kind, geometry)[0] for kind, many in cases.items() for geometry in many}
        self.assertEqual(sorted(prompts - set(warm)), [])
        self.assertEqual(len(prompts), 14)

    def test_check_rejects_bad_bodies(self):
        self.assertEqual(requests.check(request()), [])
        for kind, geometry in (("turn", {"yaw": 30}), ("window_loop", {"hips": [0, 1, 0]}),
                               ("sit_exit", {"seat": [0, 0.5, 0]}), ("lean", {"hand": "left", "grip": [0, 1, 0]})):
            self.assertEqual(requests.check(request(kind, geometry)), [], kind)
        for bad in ({**request(), "request_id": "mr-0123"}, {**request(), "kind": "fly"},
                    {**request(), "seconds": 11}, {**request(), "seconds": True}, request("walk", {"end_yaw": 0}),
                    request("turn", {"yaw": 181}), request("turn", {"yaw": float("nan")}),
                    request("lean", {"hand": "both", "grip": [0, 1, 0]}), request("sit_enter", {"seat": [0, 1]}),
                    {**request(), "behavior_id": "b" * 65}, {**request(), "behavior_id": ""},
                    {**request(), "v": 1}, [request()]):
            self.assertNotEqual(requests.check(bad), [], bad)


class ClientTest(unittest.TestCase):
    def test_changed_service_drops_saved_token(self):
        from motion.settings import MotionSettings
        with tempfile.TemporaryDirectory() as directory:
            settings = MotionSettings(directory)
            settings.update({'backend': 'generated', 'service_url': 'https://first.example', 'token': 'sentinel'})
            status, result = settings.update({'backend': 'generated', 'service_url': 'https://next.example'})
            self.assertEqual((status, result['token_set'], MotionSettings(directory).token()), (200, False, None))

    def test_cross_origin_redirect_has_no_token(self):
        from urllib.response import addinfourl
        from motion.client import MotionClient
        sent = []
        urls = ['http://first.example/v1/skeleton', 'http://first.example/next', 'http://other.example/']
        def transport(handler, request):
            sent.append((request.full_url, request.get_header('Authorization')))
            index = len(sent)
            status = 302 if index < len(urls) else 200
            headers = {'location': urls[index]} if status == 302 else {}
            response = addinfourl(io.BytesIO(b'{}'), headers, request.full_url, status)
            response.msg = 'redirect' if status == 302 else 'OK'
            return response
        with mock.patch('urllib.request.HTTPHandler.http_open', transport):
            MotionClient().skeleton('http://first.example', 'sentinel')
        self.assertEqual(sent, list(zip(urls, ['Bearer sentinel', 'Bearer sentinel', None])))

    def test_generate_sends_the_constraints_only_when_given(self):
        from motion.client import MotionClient
        sent = []
        with mock.patch.object(MotionClient, "_call", lambda *args: sent.append(json.loads(args[-1])) or b"NPZ"):
            MotionClient().generate("http://127.0.0.1:48830", "t", "a person waves", 3.0)
            MotionClient().generate("http://127.0.0.1:48830", "t", "a person waves", 3.0,
                                    constraints={"root": [{"t": 0, "x": 0, "z": 0, "yaw": 0}]})
        self.assertEqual(sent, [{"prompt": "a person waves", "seconds": 3.0},
                                {"prompt": "a person waves", "seconds": 3.0,
                                 "constraints": {"root": [{"t": 0, "x": 0, "z": 0, "yaw": 0}]}}])


    def test_no_token_sends_no_authorization_header(self):
        from motion.client import MotionClient
        sent = []
        with mock.patch("urllib.request.OpenerDirector.open", lambda opener, request, timeout: sent.append(dict(request.header_items())) or io.BytesIO(b"{}")):
            MotionClient().skeleton("http://127.0.0.1:48830", None)
            MotionClient().skeleton("http://127.0.0.1:48831", "t")
        self.assertNotIn("Authorization", sent[0])
        self.assertEqual(sent[1]["Authorization"], "Bearer t")


class GenerateRouteTest(base.MotionCase):
    def setUp(self):
        super().setUp()
        self.settings.update(base.SERVICE)

    def performer(self, **client):
        self.client = GeometryClient(self.clock, **client)
        self.server.motion = base.Performer(self.settings, self.server.registry.publish_event,
                                            lambda: self.state / "pkg", self.state / "cache", trace=self.trace,
                                            client=self.client, retarget=GeometryRetarget, clock=self.clock)
        return self.server.motion

    def motions(self):
        return [e for e in self.server.registry.intents if e.get("event") == "motion"]

    def test_a_request_publishes_one_motion_whose_files_match(self):
        self.performer()
        self.assertEqual(self.request("POST", "/motions/generate", request()),
                         (202, {"request_id": "mr-0123456789abcdef"}))
        self.assertTrue(base.wait_for(lambda: self.traced))
        self.assertEqual(self.traced[0][:2], ("motion.published", request_trace("mr-0123456789abcdef")))
        self.assertTrue(UUID.fullmatch(self.traced[0][1]), "trace events need a UUID trace_id")
        [event] = self.motions()
        self.assertEqual(c1.check_message(event), [])
        self.assertEqual((event["request_id"], event["behavior_id"], event["ok"]),
                         ("mr-0123456789abcdef", "b-walk-1", True))
        motion = event["motion"]
        self.assertAlmostEqual(by_time(self.client.constraints["root"])[-1]["x"], 1.2 / S, places=6)
        for name, key in (("meta", "meta_sha256"), ("keys", "keys_sha256"), ("tracks", "tracks_sha256")):
            status, _, data = self.fetch(f"/motions/{motion['id']}/{name}")
            self.assertEqual(status, 200, name)
            self.assertEqual(hashlib.sha256(data).hexdigest(), motion[key], name)
        status, kind, tracks = self.fetch(f"/motions/{motion['id']}/tracks")
        self.assertEqual(kind, "application/json")
        self.assertEqual(json.loads(tracks)["kind"], "walk")
        self.assertEqual((motion["rig_sha256"], motion["length_s"]), ("c" * 64, 3.0))
        self.assertEqual(self.behaviors(), [])

    def test_a_request_gives_the_service_the_hosts_2_5_s_less_the_retarget_reserve(self):
        self.performer()
        self.assertEqual(self.request("POST", "/motions/generate", request())[0], 202)
        self.assertTrue(base.wait_for(lambda: self.motions()))
        self.assertAlmostEqual(self.client.timeout, 2.5 - 0.3)

    def test_the_retarget_gets_the_hosts_geometry(self):
        self.performer()
        body = request("sit_exit", {"seat": [-0.043, 0.637, -0.465]}, behavior_id="b-sit-1")
        self.assertEqual(self.request("POST", "/motions/generate", body)[0], 202)
        self.assertTrue(base.wait_for(lambda: self.motions()))
        self.assertTrue(self.motions()[0]["ok"])
        [retarget] = self.server.motion._retargets.values()
        self.assertEqual(retarget.geometry, body["geometry"])

    def test_a_sit_is_published_without_a_heading_check(self):
        self.performer()
        body = request("sit_exit", {"seat": [-0.043, 0.637, -0.465]}, behavior_id="b-sit-1")
        self.assertEqual(self.request("POST", "/motions/generate", body)[0], 202)
        self.assertTrue(base.wait_for(lambda: self.motions() and self.traced))
        [retarget] = self.server.motion._retargets.values()
        self.assertEqual(retarget.headed, [])
        self.assertEqual(self.traced[0][0], "motion.published")
        self.assertNotIn("retried", self.traced[0][2])

    def heading_case(self, headings, delay=0.4):
        """A 3 m walk request whose generated npz heads as headings say, one per generate."""
        performer = self.performer()
        performer.client = self.client = CountingClient(self.clock, delay=delay)
        performer._retarget = type("Retarget", (GeometryRetarget,), {"headings": headings})
        kind, geometry, seconds = WALK_3M
        self.assertEqual(self.request("POST", "/motions/generate", request(kind, geometry, seconds=seconds))[0], 202)
        self.assertTrue(base.wait_for(lambda: self.motions() and self.traced))
        [event] = self.motions()
        self.assertEqual(c1.check_message(event), [])
        return event, self.traced[0]

    @unittest.skipIf(sys.platform == "win32", "timing: flaky on Windows under the gate's parallel load (passes alone)")
    def test_a_walk_that_turns_the_long_way_round_twice_is_failed(self):
        event, (kind, _, attrs) = self.heading_case((LONG_WAY,))
        self.assertEqual((event["ok"], event.get("reason")), (False, "failed"))
        self.assertEqual(len(self.client.calls), 2)
        self.assertEqual((kind, attrs["reason"], attrs["retried"]), ("motion.fallback", "off_heading", True))
        self.assertNotEqual(attrs["problems"], [])
        self.assertEqual(len(self.server.motion.store._motions), 0)

    def test_a_walk_off_heading_once_is_generated_again_without_a_seed_and_the_second_is_published(self):
        good = heading(4.0, (0, 0), (2.0, -92), (2.8, -170), (4.0, -10))
        event, (kind, _, attrs) = self.heading_case((LONG_WAY, good))
        self.assertTrue(event["ok"])
        self.assertEqual(len(self.client.calls), 2)
        self.assertEqual(self.client.calls[0], self.client.calls[1])
        [retarget] = self.server.motion._retargets.values()
        self.assertEqual(retarget.headed[1][-3:], b" #2")
        status, _, keys = self.fetch(f"/motions/{event['motion']['id']}/keys")
        self.assertEqual((status, keys), (200, b"EFKEY001" + retarget.headed[1]))
        self.assertEqual((kind, attrs["retried"]), ("motion.published", True))
        self.assertNotEqual(attrs["problems"], [])

    def test_no_time_for_a_second_generate_fails_an_off_heading_walk_at_once(self):
        """1.1 s left after a 1.1 s generate is under 1.2 x 1.1 s."""
        good = heading(4.0, (0, 0), (2.0, -92), (4.0, 0))
        event, (kind, _, attrs) = self.heading_case((LONG_WAY, good), delay=1.1)
        self.assertEqual((event["ok"], event.get("reason")), (False, "failed"))
        self.assertEqual(len(self.client.calls), 1)
        self.assertEqual((kind, attrs["reason"], attrs["retried"]), ("motion.fallback", "off_heading", False))

    def test_a_slow_service_publishes_a_timeout(self):
        self.performer(delay=3.0)
        self.assertEqual(self.request("POST", "/motions/generate", request())[0], 202)
        self.assertTrue(base.wait_for(lambda: self.motions()))
        [event] = self.motions()
        self.assertEqual(c1.check_message(event), [])
        self.assertEqual({k: v for k, v in event.items() if k not in ("seq", "event")},
                         {"request_id": "mr-0123456789abcdef", "behavior_id": "b-walk-1", "ok": False,
                          "reason": "timeout"})
        self.assertTrue(base.wait_for(lambda: self.traced))
        self.assertEqual(self.traced[0][:2], ("motion.fallback", request_trace("mr-0123456789abcdef")))
        self.assertEqual(self.traced[0][2]["reason"], "timeout")

    def test_a_perform_does_not_replace_a_waiting_geometry_job(self):
        gate = threading.Event()
        performer = self.performer(gate=gate)
        performer.start("waves her right hand happily", 2.0, 4, "trace-0")
        self.assertEqual(self.request("POST", "/motions/generate", request())[0], 202)
        performer.start("bows deeply", 2.0, 4, "trace-1")
        performer.start("claps her hands", 2.0, 4, "trace-2")
        gate.set()
        self.assertTrue(base.wait_for(lambda: len(self.traced) == 4))
        [event] = self.motions()
        self.assertTrue(event["ok"])
        self.assertIn(("motion.fallback", "trace-1", {"reason": "replaced"}), self.traced)
        self.assertEqual(len(self.behaviors()), 2)

    def test_a_newer_request_for_the_same_behavior_replaces_the_waiting_one(self):
        gate = threading.Event()
        self.performer(gate=gate)
        for n, behavior in enumerate(("b-other", "b-walk-1", "b-walk-1")):
            body = request(behavior_id=behavior, request_id=f"mr-{n:016x}")
            self.assertEqual(self.request("POST", "/motions/generate", body)[0], 202)
        gate.set()
        self.assertTrue(base.wait_for(lambda: len(self.motions()) == 3))
        outcome = {e["request_id"]: (e["ok"], e.get("reason")) for e in self.motions()}
        self.assertEqual(outcome, {"mr-0000000000000000": (True, None), "mr-0000000000000001": (False, "busy"),
                                   "mr-0000000000000002": (True, None)})
        self.assertIn(("motion.fallback", request_trace("mr-0000000000000001"), {"reason": "replaced"}), self.traced)

    def test_the_game_backend_or_no_service_refuses_with_a_failed_motion_at_once(self):
        """The host falls back on the event instead of waiting out its 2.5 s."""
        self.performer()
        self.settings.update({"backend": "game", "service_url": None})
        self.assertEqual(self.request("POST", "/motions/generate", request()), (409, {"error": "motion_backend_game"}))
        self.settings.update({"backend": "generated", "service_url": None})
        self.assertEqual(self.request("POST", "/motions/generate", request(request_id="mr-00000000000000ff")),
                         (409, {"error": "no_service"}))
        self.assertEqual(self.client.calls, [])
        self.assertEqual([{k: e[k] for k in ("request_id", "behavior_id", "ok", "reason")} for e in self.motions()],
                         [{"request_id": "mr-0123456789abcdef", "behavior_id": "b-walk-1", "ok": False, "reason": "game_backend"},
                          {"request_id": "mr-00000000000000ff", "behavior_id": "b-walk-1", "ok": False, "reason": "no_service"}])
        self.assertTrue(all("motion" not in e for e in self.motions()))

    def test_the_current_characters_binding_decides_the_backend(self):
        from character.binding import Bindings
        self.performer()
        self.server.character = "aster"
        self.server.bindings = Bindings(self.state, self.server.characters, lambda: self.settings.backend)
        self.server.bindings.update("aster", {"revision": 0, "motion": {"driver": "game"}})
        self.assertEqual(self.request("POST", "/motions/generate", request()), (409, {"error": "motion_backend_game"}))
        self.server.character = "birch"
        self.assertEqual(self.request("POST", "/motions/generate", request(request_id="mr-00000000000000ff"))[0], 202)
        self.assertTrue(base.wait_for(lambda: len(self.motions()) == 2))
        self.assertEqual(len(self.client.calls), 1)

    def test_tokens_and_bad_bodies(self):
        self.performer()
        self.assertEqual(self.request("POST", "/motions/generate", request(), token=base.EVENTS)[0], 401)
        self.assertEqual(self.request("POST", "/motions/generate", {**request(), "kind": "fly"}),
                         (400, {"error": "invalid_motion_request"}))
        self.assertEqual(self.client.calls, [])
        self.assertEqual(self.motions(), [])

    def test_tracks_are_unknown_for_a_perform_or_an_unknown_id(self):
        self.performer().start("waves her right hand happily", 3.0, 4, "trace-1")
        self.assertTrue(base.wait_for(lambda: self.behaviors()))
        motion_id = self.behaviors()[0]["motion"]["id"]
        self.assertEqual(self.fetch(f"/motions/{motion_id}/meta")[0], 200)
        for path in (f"/motions/{motion_id}/tracks", "/motions/gm-0000000000000000/tracks"):
            self.assertEqual(self.fetch(path)[::2], (404, b'{"error": "unknown_tracks"}'))
        self.assertEqual(self.fetch(f"/motions/{motion_id}/tracks", token="hook-token")[0], 401)


class MotionEventCheckTest(unittest.TestCase):
    OK = {"event": "motion", "seq": 12, "request_id": "mr-0123456789abcdef", "behavior_id": "b-walk-1", "ok": True,
          "motion": {"id": "gm-0123456789abcdef", "meta_sha256": "a" * 64, "keys_sha256": "b" * 64,
                     "rig_sha256": "c" * 64, "length_s": 3.0, "tracks_sha256": "d" * 64}}
    FAILED = {"event": "motion", "seq": 13, "request_id": "mr-0123456789abcdef", "behavior_id": "b-walk-1",
              "ok": False, "reason": "timeout"}

    def test_valid_messages(self):
        self.assertEqual(c1.check_message(self.OK), [])
        self.assertEqual(c1.check_message(self.FAILED), [])
        self.assertEqual(c1.check_file({"description": "motion", "messages": [self.OK, self.FAILED]}), [])

    def test_invalid_messages(self):
        motion = self.OK["motion"]
        for bad in ({**self.OK, "request_id": "mr-0123"}, {**self.OK, "ok": 1}, {**self.OK, "behavior_id": ""},
                    {**self.OK, "motion": {k: v for k, v in motion.items() if k != "tracks_sha256"}},
                    {**self.OK, "motion": {**motion, "length_s": 11}}, {**self.OK, "reason": "timeout"},
                    {k: v for k, v in self.OK.items() if k != "seq"},
                    {**self.FAILED, "reason": "replaced"}, {**self.FAILED, "motion": motion}):
            self.assertNotEqual(c1.check_message(bad), [], bad)


if __name__ == "__main__":
    unittest.main()
