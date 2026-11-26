"""The user's own play from the character page comes first: her body behaviors give way to it, nothing takes her body
while it plays, and what held before comes back once it is over (POST /behavior/user_play)."""
import unittest
import unittest.mock

import support  # noqa: F401

from observation import spatial  # noqa: E402
from test_server import EVENTS, HOOK  # noqa: E402
from test_spatial import T0, Prefer, ServerCase, SpatialCase  # noqa: E402

USER_ENDED = {"behavior_id": None, "origin": "user", "phase": "ended", "resting": True, "busy": False, "clip": "wave"}


class UserPlayTest(SpatialCase):
    def setUp(self):
        super().setUp()
        self.spatial._next_tick = T0 + 10_000  # no random tick unless a test asks for one

    def sits(self):
        return [m for m in self.sent if m["type"] == "sit"]

    @staticmethod
    def holding(behaviors):
        return [b["behavior_id"] for b in behaviors if spatial._holds_body(b)]

    def sit(self):
        """Her long-work sit, running."""
        self.step(0, session="codex:A", state="thinking", related=["codex:A"])
        self.step(spatial.LONG_WORK, state="running_tool")
        [sit] = self.sits()
        self.assertEqual(self.receipts(sit["behavior_id"])[-1], ("running", None))
        return sit

    def test_her_sit_gives_way_to_the_user_play_and_nothing_takes_her_body_until_it_is_over(self):
        sit = self.sit()
        self.spatial.user_play(True)
        self.flush()
        self.assertIn((sit["behavior_id"], "replaced", None), self.cancels())
        self.assertEqual(self.receipts(sit["behavior_id"])[-1], ("cancelled", None))
        for _ in range(5):
            self.step(5)
        self.assertEqual(self.holding(self.sent), [sit["behavior_id"]], "no sit, walk or hold while the user's action plays")
        self.assertEqual(self.holding(self.spatial.running()), [])
        s = self.spatial.observe()
        for spec in (self.spatial._posture(s, self.now), spatial._spec("short_walk", None, "tick", None, 0, ("full_body",),
                                                                        ("user_drag",), 0.3, 20.0)):
            self.assertEqual(self.spatial.admit(spec, s, self.now), (False, "user_play"))
        self.assertValid()

    def test_once_the_user_play_is_over_her_sit_comes_back_and_nothing_stays_held(self):
        sit = self.sit()
        self.spatial.user_play(True)
        self.step(5)
        self.spatial.user_play(False)
        self.step(1)
        [_, again] = self.sits()
        self.assertEqual((again["trigger"], again["replaces"]), (sit["trigger"], None))
        self.assertEqual(self.holding(self.spatial.running()), [again["behavior_id"]])
        self.assertFalse(self.spatial._user_play)
        self.assertValid()

    def test_the_renderer_ending_the_user_play_also_gives_her_body_back(self):
        self.sit()
        self.spatial.user_play(True)
        self.step(5)
        self.spatial.motion_state(USER_ENDED)
        self.step(1)
        self.assertEqual(len(self.sits()), 2)
        self.assertFalse(self.spatial._user_play)
        self.assertValid()

    def test_in_place_behaviors_keep_running(self):
        self.use(Prefer("idle"))
        self.spatial._next_tick = self.now + 1
        self.step(1)
        [idle] = [m for m in self.sent if m["type"] == "idle"]
        self.spatial.user_play(True)
        self.flush()
        self.assertEqual(self.cancels(), [])
        self.assertEqual([b["behavior_id"] for b in self.spatial.running()], [idle["behavior_id"]])
        self.assertValid()


class UserPlayServerTest(ServerCase):
    def test_post_user_play_reaches_spatial(self):
        with unittest.mock.patch.object(self.server.spatial, "user_play") as user_play:
            self.assertEqual(self.request("POST", "/behavior/user_play", {"playing": True}), (204, None))
            self.assertEqual(self.request("POST", "/behavior/user_play", {"playing": False}), (204, None))
        self.assertEqual(user_play.call_args_list, [unittest.mock.call(True), unittest.mock.call(False)])

    def test_bad_bodies_are_400_and_other_tokens_401_and_reach_nothing(self):
        with unittest.mock.patch.object(self.server.spatial, "user_play") as user_play:
            for body in [{}, {"playing": 1}, {"playing": None}, {"playing": True, "extra": 1}, [True], True]:
                with self.subTest(body=body):
                    self.assertEqual(self.request("POST", "/behavior/user_play", body), (400, {"error": "invalid_payload"}))
            for token in (None, HOOK, EVENTS):
                self.assertEqual(self.request("POST", "/behavior/user_play", {"playing": True}, token=token)[0], 401)
        user_play.assert_not_called()


if __name__ == "__main__":
    unittest.main()
