"""Spatial behavior on the agentd side: behavior events, behavior switches and execution receipts (C1 v2 §1–3)."""
import hashlib
import http.client
import json
from pathlib import Path
import random
import shutil
import tempfile
import threading
import time
import types
import unittest
import unittest.mock

import support

import c1  # noqa: E402
from character.character_state import CharacterState  # noqa: E402
from sessions.registry import Registry  # noqa: E402
from daemon.agentd_server import AgentdServer  # noqa: E402
from motion.chooser import MotionChooser  # noqa: E402
from observation import spatial  # noqa: E402
from observation.spatial import Spatial  # noqa: E402
from infra.store import open_store  # noqa: E402
from observation.user_now import UserNow  # noqa: E402
from traces.motion_lane import MotionLane  # noqa: E402
from test_server import EVENTS, HOOK, UI  # noqa: E402
from test_motion_chooser import prefs_pack  # noqa: E402

T0 = 1760900000.0
COMPLETED_BY = ("speech_end", "session_state", "focus_change")  # C1 §1: these exits complete; the rest cancel
SWITCHES = {"stay_in_place": False, "sit_window_top": True, "hold_window_edge": True, "fullscreen_give_way": True}


def situation(**over):
    return {"fullscreen": False, "user_speaking": False, "speaking": False, "voicing": False, "line_id": None,
            "typing": False, "session": None, "state": "idle", "related": [], "window_id": 101, **over}


class Prefer:
    """A scripted RNG: choice() takes the first of `order` among the options (a "window" entry matches any
    window target), else the first option; uniform() returns the point `fraction` of the way from a to b and
    random() returns `fraction`."""

    def __init__(self, *order, fraction=0.5):
        self.order, self.fraction = list(order), fraction

    def choice(self, options):
        for wanted in self.order:
            for option in options:
                if option == wanted or wanted == "window" and isinstance(option, dict) \
                        and option.get("kind") == "window":
                    return option
        return options[0]

    def uniform(self, a, b):
        return a + (b - a) * self.fraction

    def random(self):
        return self.fraction


class SpatialCase(unittest.TestCase):
    """Drives a Spatial with an injected clock and RNG; a fake renderer answers each behavior with prepared and
    running, cancels what a newer one replaces or a behavior_cancel names, and expires what runs out."""

    def setUp(self):
        self.now, self.s, self.generation = T0, situation(), 3
        self.registry = Registry(epoch=7)
        self.rng = random.Random(1)
        self.spatial = Spatial(lambda: dict(self.s), self.registry.publish_event, lambda: self.generation, 7,
                               clock=lambda: self.now, rng=self.rng, session_settle=0, session_min_hold=0, recovery_delay=0)
        self.log, self.seen, self.unity, self.sent = [], 0, {}, []
        self.unsupported = set()  # types (or "type@target kind") the fake renderer answers with rejected / unsupported

    def use(self, rng):
        self.spatial.rng = self.rng = rng

    def flush(self):
        while True:
            items = self.registry.intents_since(self.seen)
            if not items:
                return
            message = items[0]
            self.seen = message["seq"]
            if "event" not in message:  # an intent: the fake renderer runs behaviors only
                continue
            self.log.append(message)
            if message["event"] == "behavior":
                self.sent.append(message)
                old = self.unity.get(message["replaces"])
                if old is not None and old["priority"] > message["priority"]:  # C1 §2 priority
                    self.receipt(message["behavior_id"], "rejected", "busy")
                    continue
                on = message["target"] and f"{message['type']}@{message['target']['kind']}"
                if message["type"] in self.unsupported or on in self.unsupported:
                    self.receipt(message["behavior_id"], "rejected", "unsupported")
                    continue
                renewal = old is not None and (old["type"], old["target"]) == (message["type"], message["target"])
                if old is not None:
                    self.receipt(message["replaces"], "cancelled")
                self.unity[message["behavior_id"]] = message
                if not renewal:  # a renewal has no entry motion (C1 §1.3)
                    self.receipt(message["behavior_id"], "prepared")
                if (message["target"] or {}).get("kind") == "session" and message["target"]["window_id"] is None:
                    self.receipt(message["behavior_id"], "blocked", "target_gone")  # nowhere to look (C1 §1.2)
                else:
                    self.receipt(message["behavior_id"], "running")
            elif message["event"] == "behavior_cancel" and message["behavior_id"] in self.unity:
                done = message["reason"] == "exit" and message["condition"] in COMPLETED_BY
                self.receipt(message["behavior_id"], "completed" if done else "cancelled")

    def receipt(self, behavior_id, phase, reason=None, generation=None):
        own = next((m["turn_generation"] for m in self.sent if m["behavior_id"] == behavior_id), self.generation)
        body = {"behavior_id": behavior_id, "phase": phase, "reason": reason, "at_ms": int(self.now * 1000),
                "turn_generation": own if generation is None else generation}
        self.log.append({"event": "receipt", **body})
        if phase in c1.ENDED:
            self.unity.pop(behavior_id, None)
        answer = self.spatial.receipt(body)
        self.flush()  # a blocked receipt retargets at once
        return answer

    def step(self, seconds=1.0, **over):
        self.now += seconds
        self.s.update(over)
        for behavior_id, message in list(self.unity.items()):
            if message["expires_at_ms"] <= self.now * 1000:
                self.receipt(behavior_id, "expired")
        self.spatial.poll()
        self.flush()

    def shape(self, messages=None):
        return [(m["type"], m["target"], (m["trigger"]["source"], m["trigger"]["event"]), m["replaces"])
                for m in (self.sent if messages is None else messages)]

    def ids(self):
        return [m["behavior_id"] for m in self.sent]

    def cancels(self):
        return [(m["behavior_id"], m["reason"], m.get("condition")) for m in self.log
                if m["event"] == "behavior_cancel"]

    def receipts(self, behavior_id):
        return [(m["phase"], m["reason"]) for m in self.log if m["event"] == "receipt"
                and m["behavior_id"] == behavior_id]

    def assertValid(self):
        self.flush()
        self.assertEqual(c1.check_file({"description": self.id(), "messages": self.log}), [])


def window(window_id, side=None):
    return {"kind": "window", "window_id": window_id, "side": side}


class StableInteractionTest(SpatialCase):
    """Production timing, fake clock: rapid hooks cannot restart poses; direct input stays immediate."""

    def setUp(self):
        super().setUp()
        self.spatial = Spatial(lambda: dict(self.s), self.registry.publish_event, lambda: self.generation, 7,
                               clock=lambda: self.now, rng=self.rng)
        self.spatial._next_tick = T0 + 10_000

    def test_rapid_session_flapping_emits_only_the_final_stable_pose(self):
        self.step(.1, session="codex:A", state="thinking")
        self.step(.3, state="error", related=["codex:A"])
        self.step(.3, state="running_tool")
        self.step(.3, state="awaiting_approval")
        self.assertEqual(self.sent, [])
        self.step(spatial.SESSION_SETTLE)
        self.assertEqual([b["type"] for b in self.sent], ["attend_session"])
        self.step(.1)
        self.assertEqual(len(self.sent), 1)
        self.assertValid()

    def test_tool_hook_chatter_keeps_the_same_accompany_pose(self):
        self.step(.1, session="codex:A", state="thinking")
        self.step(spatial.SESSION_SETTLE)
        first = self.ids()[0]
        for state in ("running_tool", "compacting", "subagent", "thinking"):
            self.step(.2, state=state)
        self.assertEqual(self.ids(), [first])
        self.assertEqual(self.cancels(), [])
        self.assertEqual(self.spatial.running()[0]["behavior_id"], first)

    def test_inferred_pose_has_minimum_hold_but_idle_stops_immediately(self):
        self.step(.1, session="codex:A", state="thinking")
        self.step(spatial.SESSION_SETTLE)
        first = self.ids()[0]
        self.step(.1, state="error", related=["codex:A"])
        self.step(spatial.SESSION_SETTLE)
        self.assertEqual(self.ids(), [first], "settled but the previous pose still has its minimum hold")
        self.step(spatial.SESSION_MIN_HOLD)
        self.assertEqual([b["type"] for b in self.sent], ["accompany", "attend_session"])
        self.step(0, state="idle")
        self.assertEqual(self.spatial.running(), [], "a task stop never waits for minimum hold")

    def test_new_focus_session_drops_old_pose_and_does_not_reuse_pending_time(self):
        self.step(.1, session="codex:A", state="thinking")
        self.step(spatial.SESSION_SETTLE)
        self.step(.1, session="codex:B", state="thinking")
        self.assertEqual(self.spatial.running(), [])
        self.step(spatial.SESSION_SETTLE - .1)
        self.assertEqual(len(self.sent), 1)
        self.step(.2)
        self.assertEqual(self.sent[-1]["display_session"], "codex:B")

    def test_user_listen_typing_and_fullscreen_are_not_debounced(self):
        self.step(.1, session="codex:A", state="thinking", user_speaking=True)
        self.assertEqual(self.sent[-1]["type"], "listen")
        self.step(.1, user_speaking=False, typing=True)
        self.assertEqual(self.sent[-1]["trigger"]["event"], "typing")
        self.step(.1, fullscreen=True)
        self.assertEqual(self.sent[-1]["trigger"]["event"], "fullscreen")
        self.spatial.cancel_all("character_switch")
        self.assertEqual(self.spatial.running(), [])
        self.assertIsNone(self.spatial._pending_session)

    def test_terminal_body_receipt_cools_random_body_recovery_not_listen(self):
        self.use(Prefer("idle"))
        self.spatial._next_tick = None
        self.step(.1)
        first = self.ids()[0]
        self.receipt(first, "blocked", "no_room")
        self.assertEqual([b["type"] for b in self.sent], ["idle", "observe"],
                         "a blocked body may look, but must not chain another body action")
        before = len(self.sent)
        self.assertEqual(self.spatial.receipt({"behavior_id": first, "phase": "blocked", "reason": "no_room",
                                               "at_ms": int(self.now * 1000), "turn_generation": self.generation}),
                         (False, "after_terminal"))
        self.assertEqual(len(self.sent), before)
        self.spatial._next_tick = None
        self.step(spatial.RECOVERY_DELAY - .1)
        self.assertEqual(len(self.sent), before)
        self.spatial._next_tick = None
        self.step(.2)
        self.assertIn("full_body", self.sent[-1]["channels"], "recovery permits a new body action after the delay")
        self.step(0, user_speaking=True)
        self.assertEqual(self.sent[-1]["type"], "listen", "safety/direct input bypass recovery")
        self.assertValid()


class ScenarioTest(SpatialCase):
    def test_01_idle_tick_then_observe_then_short_walk(self):
        self.use(Prefer("idle"))
        self.step()
        self.use(Prefer("observe"))
        self.step(spatial.TICK[1])  # idle ran out; the next tick
        self.receipt(self.ids()[-1], "completed")
        self.use(Prefer("short_walk"))
        self.step(spatial.TICK[1])
        self.assertEqual(self.shape(), [("idle", None, ("tick", None), None),
                                        ("observe", window(101), ("tick", None), None),
                                        ("short_walk", None, ("tick", None), None)])
        self.assertEqual(self.ids(), ["b-7-1", "b-7-2", "b-7-3"])
        self.assertTrue(all(0 <= m["priority"] == 0 and 0.4 <= m["intensity"] <= 0.7 for m in self.sent))
        self.assertTrue(all(m["turn_generation"] == 3 for m in self.sent))
        self.assertEqual(len({m["trace_id"] for m in self.sent}), 3)
        self.assertValid()

    def test_the_first_random_tick_waits_60_to_120_s(self):
        self.spatial.begin()
        for _ in range(59):
            self.step()
        self.assertEqual(self.sent, [])
        for _ in range(61):
            self.step()
        self.assertEqual([m["trigger"]["source"] for m in self.sent], ["tick"])
        self.assertValid()

    def test_walk_gaps_are_random_between_3_and_10_minutes(self):
        rng = Prefer("short_walk")
        rng.uniform = random.Random(2).uniform
        self.use(rng)
        starts = []
        while len(starts) < 6:
            self.spatial._next_tick = None  # a tick at every poll: a walk goes as soon as it may
            self.step()
            if self.sent[-1]["type"] == "short_walk" and self.sent[-1]["behavior_id"] in self.unity:
                starts.append(self.now)
                self.receipt(self.ids()[-1], "completed")
        gaps = [b - a for a, b in zip(starts, starts[1:])]
        self.assertTrue(all(180.0 <= gap <= 600.0 for gap in gaps), gaps)
        self.assertGreater(len(set(gaps)), 1)
        self.assertValid()

    def test_02_user_speaks_listen(self):
        self.use(Prefer("idle"))
        self.step()
        self.step(user_speaking=True)
        self.step()  # still speaking: not sent again
        # listen takes eyes and head only, so it does not replace the idle's full body (C1 §1, fixture 06);
        # the idle ends on its own exit, speech_start
        self.assertEqual(self.shape(), [("idle", None, ("tick", None), None),
                                        ("listen", {"kind": "user"}, ("user", "speech_start"), None)])
        idle, listen = self.sent
        self.assertEqual(self.cancels(), [(idle["behavior_id"], "exit", "speech_start")])
        self.assertEqual([b["behavior_id"] for b in self.spatial.running()], [listen["behavior_id"]])
        self.assertEqual((listen["priority"], listen["channels"], listen["exit"], listen["intensity"]),
                         (2, ["eyes", "head"], ["speech_end"], 0.4))
        self.assertEqual(listen["expires_at_ms"], int((self.now - 1 + 120) * 1000))
        self.assertValid()

    def test_03_session_thinking_accompany_renewed_before_it_expires(self):
        self.use(Prefer("idle", fraction=1.0))
        self.s.update(window_id=None, session="claude:A", state="thinking")
        self.spatial._next_tick = T0 + 10_000  # no random tick in this scenario
        self.spatial.set_capabilities("aster", {"sit": "no seat"})  # no long-work sit beside the accompany
        self.step()
        first = self.sent[0]
        self.step()
        self.step(state="thinking")  # the same session event again: merged
        self.assertEqual(len(self.sent), 1)
        self.step(first["expires_at_ms"] / 1000 - self.now - spatial.RENEW - 1)
        self.assertEqual(len(self.sent), 1)
        self.step(2)
        self.assertEqual(self.shape(), [("accompany", None, ("session", "session_state:thinking"), None),
                                        ("accompany", None, ("session", "session_state:thinking"), first["behavior_id"])])
        renewed = self.sent[1]
        self.assertEqual((renewed["display_session"], renewed["priority"], renewed["intensity"], renewed["exit"]),
                         ("claude:A", 1, 0.2, ["session_state"]))
        self.assertEqual(renewed["expires_at_ms"], int((self.now + 600) * 1000))
        self.step(spatial.RENEW + 5)  # the old one's expiry passes: nothing more
        self.assertEqual(len(self.sent), 2)
        self.assertValid()

    def test_her_own_background_run_gets_the_thinking_accompany(self):
        thinking = self.spatial._event(situation(session="role:run-1", state="thinking"))
        background = self.spatial._event(situation(session="role:run-1", state="background"))
        self.assertIsNotNone(background)
        self.assertEqual((background["type"], background["channels"], background["priority"], background["exit"]),
                         (thinking["type"], thinking["channels"], thinking["priority"], thinking["exit"]))
        self.assertEqual((background["trigger"]["event"], background["display_session"]),
                         ("session_state:background", "role:run-1"))

    def test_04_session_states_attend_the_right_session(self):
        self.spatial._next_tick = T0 + 10_000
        self.step(session="codex:B", state="awaiting_approval", related=["codex:B"], window_id=3101)
        self.step(session="claude:A", state="error", related=["claude:A"], window_id=3202)
        self.step(state="error")
        self.step(state="done")
        b1, b2 = self.ids()
        self.assertEqual(self.shape(), [
            ("attend_session", {"kind": "session", "display_session": "codex:B", "window_id": 3101},
             ("session", "session_state:awaiting_approval"), None),
            ("attend_session", {"kind": "session", "display_session": "claude:A", "window_id": 3202},
             ("session", "session_state:error"), b1)])
        self.assertEqual(self.ids(), [b1, b2], "error and done keep the same attend pose")
        self.assertEqual([(m["display_session"], m["priority"], m["intensity"]) for m in self.sent],
                         [("codex:B", 1, 0.5), ("claude:A", 1, 0.5)])
        self.assertValid()

    def test_04_a_session_without_a_window_is_blocked_and_left(self):
        self.spatial._next_tick = T0 + 10_000
        self.step(session="codex:C", state="done", related=[], window_id=None)
        attend = self.sent[0]
        self.assertEqual(attend["target"], {"kind": "session", "display_session": "codex:C", "window_id": None})
        retarget = self.sent[1]  # C1 §3: blocked, so agentd switches type at once
        self.assertEqual((retarget["trigger"], retarget["replaces"]),
                         ({"source": "receipt", "event": "blocked:target_gone"}, None))
        self.assertNotEqual(retarget["type"], "attend_session")
        self.assertValid()

    def test_05_blocked_target_is_not_chosen_again_for_60_s(self):
        self.use(Prefer("hold_window_edge", "left", "idle", fraction=0.0))  # a tick every 60 s
        self.step()
        hold = self.sent[0]
        self.step(7)
        self.assertEqual(self.receipt(hold["behavior_id"], "blocked", "target_gone"), (True, None))
        # at once, from the receipt, and not window 101 although it is still the focus
        self.assertEqual(self.shape()[1], ("idle", None, ("receipt", "blocked:target_gone"), None))
        self.use(Prefer("hold_window_edge", "right", "idle", fraction=0.0))
        self.step(53, window_id=202)  # T0 + 61: the next tick
        self.assertEqual(self.shape()[2][:3], ("hold_window_edge", window(202, "right"), ("tick", None)))
        self.step(1, window_id=101)
        self.receipt(self.ids()[-1], "blocked", "target_gone")  # T0 + 62: 101 is still blocked
        self.assertEqual(self.shape()[3][:3], ("idle", None, ("receipt", "blocked:target_gone")))
        self.step(59)  # T0 + 121: the next tick, after the block on 101 is over
        self.assertEqual(self.shape()[4][:3], ("hold_window_edge", window(101, "right"), ("tick", None)))
        self.assertEqual(hold["channels"], ["full_body", "left_hand", "contact"])
        self.assertEqual(self.sent[2]["channels"], ["full_body", "right_hand", "contact"])
        self.assertValid()

    def test_07_typing_lowers_and_replaces_the_walk(self):
        self.use(Prefer("short_walk"))
        self.step()
        walk = self.sent[0]
        self.step(typing=True)
        self.assertEqual(self.shape(), [("short_walk", None, ("tick", None), None),
                                        ("accompany", None, ("user", "typing"), walk["behavior_id"])])
        accompany = self.sent[1]
        self.assertEqual((accompany["priority"], accompany["intensity"], accompany["channels"]),
                         (2, 0.2, ["eyes", "head"]))
        self.assertIn("user_typing", walk["exit"])
        self.assertValid()

    def test_a_behavior_that_ends_two_running_ones_ends_both(self):
        self.use(Prefer("observe"))
        self.step()
        self.use(Prefer("short_walk"))
        self.spatial._next_tick = self.now + 1  # the next tick while the observe still runs
        self.step()
        observe, walk = self.sent
        self.assertEqual([b["behavior_id"] for b in self.spatial.running()],
                         [observe["behavior_id"], walk["behavior_id"]])
        # the typing accompany takes the observe's eyes and head, and the walk gives way on user_typing
        self.step(typing=True)
        accompany = self.sent[-1]
        self.assertEqual(accompany["type"], "accompany")
        ended = {accompany["replaces"]} | {b for b, reason, _ in self.cancels() if reason == "replaced"}
        self.assertEqual(ended, {observe["behavior_id"], walk["behavior_id"]})
        self.assertEqual([b["behavior_id"] for b in self.spatial.running()], [accompany["behavior_id"]])
        self.assertEqual(list(self.unity), [accompany["behavior_id"]])
        self.assertValid()

    def test_a_lower_priority_row_ends_the_higher_one_it_follows(self):
        self.spatial._next_tick = T0 + 10_000
        self.s.update(session="claude:A", state="thinking")
        self.step(typing=True)
        typing = self.sent[-1]
        self.step(typing=False)  # typing stops; the session still thinks
        session = self.sent[-1]
        self.assertEqual((typing["priority"], session["priority"]), (2, 1))
        # The renderer would answer a priority-1 behavior that names the priority-2 one rejected / busy
        self.assertIsNone(session["replaces"])
        self.assertIn((typing["behavior_id"], "replaced", None), self.cancels())
        self.assertEqual(self.spatial.diag()["refused"], {})  # a row that no longer holds owns nothing
        self.assertEqual(self.receipts(session["behavior_id"]), [("prepared", None), ("running", None)])
        self.assertEqual(list(self.unity), [session["behavior_id"]])
        self.assertValid()

    def test_08_switch_off_cancels_and_fullscreen_gives_way(self):
        self.use(Prefer("sit", "window"))
        self.step()
        sit = self.sent[0]
        self.assertEqual(sit["target"], window(101))
        self.assertEqual(sit["expires_at_ms"], int((self.now + 600) * 1000))
        self.spatial.set_switches({**SWITCHES, "sit_window_top": False})
        self.flush()
        cancel = [m for m in self.log if m["event"] == "behavior_cancel"]
        self.assertEqual([(m["behavior_id"], m["reason"], m["turn_generation"]) for m in cancel],
                         [(sit["behavior_id"], "switch_off", 3)])
        self.step(fullscreen=True)
        self.step(spatial.TICK[1])  # no random tick while giving way
        self.assertEqual(self.shape()[1:], [("idle", None, ("session", "fullscreen"), None)])
        idle = self.sent[1]
        self.assertEqual((idle["priority"], idle["channels"], idle["exit"]), (3, ["full_body"], ["focus_change"]))
        self.assertValid()

    def test_fullscreen_without_give_way_keeps_ticking(self):
        self.spatial.set_switches({**SWITCHES, "fullscreen_give_way": False})
        self.use(Prefer("idle"))
        self.step(fullscreen=True)
        self.assertEqual(self.shape(), [("idle", None, ("tick", None), None)])


class TypingTest(SpatialCase):
    def test_five_minutes_of_typing_never_walks_or_climbs(self):
        for seed in range(5):
            with self.subTest(seed=seed):
                self.setUp()
                self.use(random.Random(seed))
                self.s["typing"] = True
                for _ in range(300):
                    self.step(1.0)
                types = [m["type"] for m in self.sent]
                self.assertGreater(len(types), 3)  # control: ticks did happen
                self.assertFalse(set(types) & set(c1.MOVING))
                self.assertTrue(all(m["intensity"] <= c1.TYPING_MAX for m in self.sent))
                self.assertValid()


class ExitTest(SpatialCase):
    """agentd judges five exit conditions on every poll and ends the behavior with behavior_cancel / exit."""

    def setUp(self):
        super().setUp()
        self.spatial._next_tick = T0 + 10_000  # no random tick unless a test asks for one

    def test_listen_ends_one_poll_after_the_user_stops_speaking(self):
        self.step(user_speaking=True)
        [listen] = self.ids()
        self.step()
        self.assertEqual(self.cancels(), [])
        self.step(spatial.POLL, user_speaking=False)  # the condition holds at this poll: the cancel goes now
        [cancel] = [m for m in self.log if m["event"] == "behavior_cancel"]
        self.assertEqual({k: v for k, v in cancel.items() if k != "event"},
                         {"seq": cancel["seq"], "behavior_id": listen, "reason": "exit", "condition": "speech_end",
                          "turn_generation": 3})
        self.assertEqual(self.receipts(listen)[-1], ("completed", None))
        self.assertEqual(self.spatial.running(), [])
        self.assertEqual((self.spatial.records[listen]["ended"], self.spatial.records[listen]["outcome"]),
                         ("exit", "done"))
        self.step()
        self.step(30)
        self.assertEqual(len(self.cancels()), 1)  # a behavior ends once
        self.assertEqual(self.ids(), [listen])  # and nothing replaces it
        self.assertValid()

    def test_the_characters_voice_starts_speech_too(self):
        self.use(Prefer("idle"))
        self.spatial._next_tick = None
        self.step()
        [idle] = self.ids()
        self.step(speaking=True, voicing=True, line_id="l-1")  # think takes eyes and head beside the idle
        think = self.ids()[-1]
        self.assertEqual(self.sent[-1]["replaces"], None)
        self.assertEqual(self.cancels(), [(idle, "exit", "speech_start")])
        self.step(speaking=False, voicing=False)
        self.assertEqual(self.cancels(), [(idle, "exit", "speech_start"), (think, "exit", "session_state")])
        self.assertEqual(self.spatial.running(), [])
        self.assertValid()

    def test_accompany_ends_when_the_focus_session_goes_idle(self):
        self.step(window_id=None, session="claude:A", state="thinking")
        [accompany] = self.ids()
        self.step()
        self.step(state="idle")
        self.assertEqual(self.cancels(), [(accompany, "exit", "session_state")])
        self.assertEqual(self.receipts(accompany)[-1], ("completed", None))
        self.assertEqual(self.spatial.running(), [])
        self.assertValid()

    def test_accompany_ends_when_the_focus_moves_to_a_session_without_a_row(self):
        self.step(window_id=None, session="claude:A", state="thinking")
        [accompany] = self.ids()
        self.step(session="codex:B", state="idle")
        self.assertEqual(self.cancels(), [(accompany, "exit", "session_state")])
        self.assertValid()

    def test_a_walk_ends_when_the_user_types(self):
        self.use(Prefer("short_walk"))
        self.step(typing=True)
        self.step(typing=False)  # the typing accompany keeps running: it ends on focus_change only
        self.spatial._next_tick = self.now + 1
        self.step()
        accompany, walk = self.ids()
        self.assertEqual(self.shape(), [("accompany", None, ("user", "typing"), None),
                                        ("short_walk", None, ("tick", None), None)])
        self.step(typing=True)  # the typing row's behavior already runs: nothing new replaces the walk
        self.assertEqual(self.ids(), [accompany, walk])
        self.assertEqual(self.cancels(), [(walk, "exit", "user_typing")])
        self.assertEqual(self.receipts(walk)[-1], ("cancelled", None))
        self.assertEqual([b["behavior_id"] for b in self.spatial.running()], [accompany])
        self.assertValid()

    def test_observe_ends_when_the_focus_window_changes(self):
        self.use(Prefer("observe"))
        self.spatial._next_tick = None
        self.step()
        [observe] = self.ids()
        self.assertEqual(self.sent[0]["target"], window(101))
        self.step()
        self.assertEqual(self.cancels(), [])
        self.step(window_id=202)
        self.assertEqual(self.cancels(), [(observe, "exit", "focus_change")])
        self.assertEqual(self.receipts(observe)[-1], ("completed", None))
        self.assertValid()

    def test_the_fullscreen_idle_ends_when_fullscreen_is_off(self):
        self.step(fullscreen=True)
        [idle] = self.ids()
        self.step()
        self.step(fullscreen=False)
        self.assertEqual(self.cancels(), [(idle, "exit", "focus_change")])
        self.assertValid()

    def test_think_ends_when_the_voice_starts(self):
        self.step(speaking=True, line_id="l-1")
        [think] = self.ids()
        self.assertEqual(self.sent[0]["exit"], ["speech_start", "session_state"])
        self.step()
        self.step(voicing=True)
        self.assertEqual(self.cancels(), [(think, "exit", "speech_start")])
        self.assertEqual(self.receipts(think)[-1], ("cancelled", None))
        self.step()  # the think row still holds: not sent again, not cancelled again
        self.assertEqual((self.ids(), len(self.cancels())), ([think], 1))
        self.assertValid()

    def test_text_turn_finishes_its_motion_and_a_new_turn_has_its_own_trace(self):
        first_trace, second_trace = (self.spatial.trace_id() for _ in range(2))
        self.step(speaking=True, line_id="line-first", turn_trace=(first_trace, "line-first", (0, 1, 2)))
        [first] = self.ids()
        self.assertEqual(self.spatial.receipt_trace(first), (first_trace, "line-first", "think", (0, 1, 2)))
        self.step()
        self.assertEqual(self.ids(), [first])
        self.step(line_id="line-second", turn_trace=(second_trace, "line-second", (0, 1, 2)))
        _, second = self.ids()
        self.assertEqual(self.sent[1]["replaces"], first)
        self.assertEqual(self.spatial.receipt_trace(second), (second_trace, "line-second", "think", (0, 1, 2)))
        self.step(speaking=False, turn_trace=None)
        self.assertEqual(self.spatial.running(), [])
        self.assertEqual(self.cancels(), [(second, "exit", "session_state")])
        self.assertEqual(self.receipts(second)[-1], ("completed", None))
        self.assertValid()

    def test_a_replaced_behavior_gets_no_exit_cancel(self):
        self.step(window_id=None, session="claude:A", state="thinking")
        [accompany] = self.ids()
        self.step(state="awaiting_approval", related=["claude:A"], window_id=3101)  # session_state holds too
        self.assertEqual(self.sent[-1]["replaces"], accompany)
        self.assertEqual(self.cancels(), [])
        self.assertValid()

    def test_a_behavior_unity_ended_gets_no_exit_cancel(self):
        self.use(Prefer("observe"))
        self.spatial._next_tick = None
        self.step()
        [observe] = self.ids()
        self.receipt(observe, "cancelled", "user_drag")
        self.step(window_id=202)
        self.assertEqual(self.cancels(), [])
        self.assertValid()

    def test_the_first_listed_condition_is_named(self):
        for exits, named in ((("focus_change", "speech_start"), "focus_change"),
                             (("user_drag", "speech_start", "focus_change"), "speech_start")):
            with self.subTest(exits=exits):
                self.setUp()
                spec = spatial._spec("idle", None, "tick", None, 0, ("full_body",), exits, 0.5, 120.0)
                self.spatial._send(spec, situation(), self.now)
                self.flush()
                [idle] = self.ids()
                self.step(window_id=202, user_speaking=True)
                self.assertEqual(self.cancels(), [(idle, "exit", named)])
                self.assertValid()


class SwitchTest(SpatialCase):
    def ticks(self, switches, count=200, seed=0):
        self.setUp()
        self.use(random.Random(seed))
        self.spatial.set_switches(switches)
        for _ in range(count):
            self.step(spatial.TICK[1])
        self.assertValid()
        return self.sent

    def test_every_tick_type_shows_up_with_the_defaults(self):
        sent = self.ticks(SWITCHES)
        self.assertEqual({m["type"] for m in sent}, set(spatial.TICK_TYPES))
        self.assertTrue(any(m["type"] == "sit" and m["target"] for m in sent))

    def test_stay_in_place_never_walks_or_climbs(self):
        sent = self.ticks({**SWITCHES, "stay_in_place": True})
        self.assertGreater(len(sent), 100)
        self.assertFalse({m["type"] for m in sent} & set(c1.MOVING))

    def test_bust_framing_never_walks_climbs_sits_or_holds(self):
        sent = self.ticks({**SWITCHES, "bust_framing": True})
        self.assertGreater(len(sent), 100)
        self.assertFalse({m["type"] for m in sent} & set(c1.MOVING + c1.BUST_HELD))
        self.assertTrue(self.spatial._forbidden("face", None, False))

    def test_turning_bust_framing_on_cancels_a_running_hold(self):
        self.use(Prefer("hold_window_edge", "left"))
        self.step()
        self.spatial.set_switches({**SWITCHES, "bust_framing": True})
        self.flush()
        self.assertEqual([m["reason"] for m in self.log if m["event"] == "behavior_cancel"], ["switch_off"])
        self.assertEqual(self.spatial.running(), [])
        self.assertValid()

    def test_each_switch_off_rules_out_its_type(self):
        sent = self.ticks({**SWITCHES, "sit_window_top": False})
        self.assertFalse([m for m in sent if m["type"] == "climb_window_top" or m["type"] == "sit" and m["target"]])
        self.assertTrue(any(m["type"] == "sit" for m in sent))  # a sit on the ground stays
        sent = self.ticks({**SWITCHES, "hold_window_edge": False})
        self.assertNotIn("hold_window_edge", {m["type"] for m in sent})

    def test_turning_stay_in_place_on_cancels_a_running_walk(self):
        self.use(Prefer("short_walk"))
        self.step()
        self.spatial.set_switches({**SWITCHES, "stay_in_place": True})
        self.flush()
        self.assertEqual([(m["event"], m["reason"]) for m in self.log if m["event"] == "behavior_cancel"],
                         [("behavior_cancel", "switch_off")])
        self.assertEqual(self.spatial.running(), [])
        self.assertValid()

    def test_hold_free_walks_starts_no_walk_climb_hold_or_window_sit(self):
        sent = self.ticks({**SWITCHES, "hold_free_walks": True})
        self.assertGreater(len(sent), 100)
        self.assertFalse([m for m in sent if m["type"] in c1.MOVING + ("hold_window_edge",)
                          or m["type"] == "sit" and m["target"]])
        self.assertTrue(any(m["type"] == "sit" for m in sent))  # a sit on the ground stays

    def test_hold_free_walks_lets_a_running_walk_finish_and_off_walks_again(self):
        self.use(Prefer("short_walk"))
        self.step()
        [walk] = self.sent
        self.spatial.set_switches({**SWITCHES, "hold_free_walks": True})
        self.flush()
        self.assertEqual(self.cancels(), [])
        self.assertEqual([b["behavior_id"] for b in self.spatial.running()], [walk["behavior_id"]])
        self.receipt(walk["behavior_id"], "completed")
        for _ in range(20):
            self.spatial._next_tick, self.spatial._wander_at = None, None
            self.step()
        self.assertEqual([m for m in self.sent if m["type"] == "short_walk"], [walk])
        self.spatial.set_switches(SWITCHES)
        self.spatial._next_tick, self.spatial._wander_at = None, None
        self.step()
        self.assertEqual(self.sent[-1]["type"], "short_walk")
        self.assertValid()

    def test_a_character_switch_cancels_every_running_behavior(self):
        self.use(Prefer("hold_window_edge", "left"))
        self.step()
        self.step(user_speaking=True)  # listen runs beside the hold: no shared channel
        running = [b["behavior_id"] for b in self.spatial.running()]
        self.assertEqual(len(running), 2)
        self.generation = 4
        self.spatial.cancel_all("character_switch")
        self.flush()
        self.assertEqual([(m["behavior_id"], m["reason"], m["turn_generation"]) for m in self.log
                          if m["event"] == "behavior_cancel"], [(b, "character_switch", 4) for b in running])
        self.assertEqual(self.spatial.running(), [])
        self.step()  # the user still speaks: listen is sent again for the new character
        self.assertEqual(self.sent[-1]["type"], "listen")
        self.assertValid()

    def test_a_blocked_receipt_after_a_character_switch_picks_nothing_new(self):
        # control, a blocked receipt of a behavior still running: test_05 (it retargets at once)
        self.use(Prefer("hold_window_edge", "left", "idle", fraction=0.0))
        self.step()
        [hold] = self.sent
        self.spatial.cancel_all("character_switch")
        self.assertEqual(self.receipt(hold["behavior_id"], "blocked", "target_gone"), (True, None))
        self.assertEqual(self.sent, [hold])
        self.assertEqual(self.spatial.running(), [])
        self.assertEqual(self.spatial.records[hold["behavior_id"]]["phase"], "blocked")


class UnsupportedTest(SpatialCase):
    def tick(self, **over):
        self.spatial._next_tick = None  # a tick at this poll
        self.step(**over)

    def types(self):
        return [m["type"] for m in self.sent]

    def test_an_unsupported_tick_type_is_not_chosen_until_its_time_is_over(self):
        self.unsupported = {"short_walk"}
        self.use(Prefer("short_walk", "idle"))
        self.tick()
        self.assertEqual(self.receipts(self.ids()[0]), [("rejected", "unsupported")])
        for _ in range(50):
            self.tick()
        self.assertEqual(len(self.sent), 51)
        self.assertNotIn("short_walk", self.types()[1:])
        self.assertEqual(self.spatial.diag()["unsupported"], {"short_walk": spatial.UNSUPPORTED_FOR - 50})
        self.now += spatial.UNSUPPORTED_FOR
        self.tick()
        self.assertEqual(self.types()[-1], "short_walk")
        self.assertValid()

    def test_a_lost_connection_ends_the_unsupported_period(self):
        self.unsupported = {"short_walk"}
        self.use(Prefer("short_walk", "idle"))
        self.tick()
        self.tick()
        self.assertEqual(self.types(), ["short_walk", "idle"])
        self.unsupported = set()  # another Avatar
        self.receipt(self.ids()[-1], "cancelled", "connection_lost")
        self.now += spatial.WANDER[1]  # past the rejected walk's cooldown, well within UNSUPPORTED_FOR
        self.tick()
        self.assertEqual(self.types()[-1], "short_walk")
        self.assertEqual(self.spatial.diag()["unsupported"], {})
        self.assertValid()

    def test_a_character_switch_ends_the_unsupported_period(self):
        self.unsupported = {"short_walk"}
        self.use(Prefer("short_walk", "idle"))
        self.tick()
        self.tick()
        self.assertEqual(self.types(), ["short_walk", "idle"])
        self.unsupported = set()
        self.spatial.cancel_all("character_switch")
        self.now += spatial.WANDER[1]  # past the rejected walk's cooldown, well within UNSUPPORTED_FOR
        self.tick()
        self.assertEqual(self.types()[-1], "short_walk")
        self.assertValid()

    def test_a_rejected_window_sit_keeps_floor_sits(self):
        self.unsupported = {"sit@window"}
        self.use(Prefer("sit", "window"))
        self.tick()
        self.assertEqual(self.shape(), [("sit", window(101), ("tick", None), None)])
        self.assertEqual(self.receipts(self.ids()[0]), [("rejected", "unsupported")])
        for _ in range(50):
            self.tick()
        sits = [m["target"] for m in self.sent[1:] if m["type"] == "sit"]
        self.assertIn(None, sits)
        self.assertEqual(set(map(json.dumps, sits)), {"null"})
        self.assertEqual(self.spatial.diag()["unsupported"], {"sit@window": spatial.UNSUPPORTED_FOR - 50})
        self.now += spatial.UNSUPPORTED_FOR
        self.tick()
        self.tick()
        self.assertIn(("sit", window(101)), [(m["type"], m["target"]) for m in self.sent[-2:]])
        self.assertValid()

    def test_an_unsupported_variant_leaves_other_variants(self):
        publish, variants = self.spatial.publish, ["read", "still"]

        def with_variant(event, data):  # agentd picks no variant yet; here the sits take these in turn
            if event == "behavior" and data["type"] == "sit" and variants:
                data["variant"] = variants.pop(0)
            return publish(event, data)
        self.spatial.publish = with_variant
        self.unsupported = {"sit"}  # the fake renderer has no reading sit
        self.use(Prefer("sit", None))
        self.tick()
        self.assertEqual(self.receipts(self.ids()[0]), [("rejected", "unsupported")])
        self.unsupported = set()
        self.tick()
        self.assertEqual([(m["type"], m["target"], m.get("variant")) for m in self.sent],
                         [("sit", None, "read"), ("sit", None, "still")])
        self.assertEqual(self.receipts(self.ids()[1]), [("prepared", None), ("running", None)])
        self.assertEqual(self.spatial.diag()["unsupported"], {"sit/read": spatial.UNSUPPORTED_FOR - 1})
        self.assertValid()

    def test_an_unsupported_event_type_is_not_sent_for_the_next_events(self):
        self.unsupported = {"attend_session"}
        self.spatial._next_tick = T0 + 10_000
        self.step(session="codex:B", state="awaiting_approval", related=["codex:B"], window_id=3101)
        self.step(state="error")
        self.step(session="claude:A", state="done", related=["claude:A"], window_id=3202)
        self.assertEqual(self.types(), ["attend_session"])
        self.step(typing=True)  # another event type is still sent
        self.assertEqual(self.types(), ["attend_session", "accompany"])
        self.assertValid()

    def test_busy_and_stale_rejections_leave_the_type_choosable(self):
        self.use(Prefer("short_walk"))
        self.tick()
        self.receipt(self.ids()[-1], "rejected", "busy")
        self.now += spatial.WANDER[1]  # past each rejected walk's cooldown
        self.tick()
        self.receipt(self.ids()[-1], "rejected", "stale")
        self.now += spatial.WANDER[1]
        self.tick()
        self.assertEqual(self.types(), ["short_walk"] * 3)


class FocusWalkTest(SpatialCase):
    """C1 v2.1: a focus that moves to another window and stays FOCUS_SETTLE draws one walk toward it."""

    def setUp(self):
        super().setUp()
        self.spatial._next_tick = T0 + 10_000  # no random tick
        self.use(Prefer("idle", fraction=0.0))  # every draw wins
        self.stay(15, window_id=101)  # the first window agentd sees is no change

    def stay(self, seconds, **over):
        self.step(**over)
        for _ in range(seconds - 1):
            self.step()

    def walks(self):
        return [m for m in self.sent if m["type"] == "short_walk"]

    def test_a_settled_focus_change_sends_a_walk_toward_that_window(self):
        self.assertEqual(self.sent, [])
        self.stay(10, window_id=202)
        self.assertEqual(self.sent, [])  # 9 s on 202
        self.step()
        self.assertEqual(self.shape(), [("short_walk", window(202), ("user", "focus_change"), None)])
        walk = self.sent[0]
        self.assertEqual((walk["priority"], walk["channels"], walk["exit"]),
                         (0, ["full_body"], ["user_typing", "user_drag", "speech_start"]))
        self.assertValid()

    def test_a_lost_draw_sends_none(self):
        self.use(Prefer("idle", fraction=spatial.FOCUS_WALK_P))
        self.stay(30, window_id=202)
        self.assertEqual(self.sent, [])

    def test_a_focus_that_flips_back_within_10_s_sends_none(self):
        self.stay(5, window_id=202)
        self.stay(30, window_id=101)
        self.assertEqual(self.sent, [])

    def test_one_focus_walk_per_focus_run(self):
        self.stay(11, window_id=202)
        [walk] = self.walks()
        self.receipt(walk["behavior_id"], "completed")
        self.stay(120)
        self.assertEqual(self.walks(), [walk])
        self.use(Prefer("idle", fraction=0.9))  # the next run's draw is lost ...
        self.stay(11, window_id=303)
        self.use(Prefer("idle", fraction=0.0))  # ... and not drawn again
        self.stay(120)
        self.assertEqual(self.walks(), [walk])
        self.stay(11, window_id=202)
        self.assertEqual([m["target"] for m in self.walks()], [window(202), window(202)])
        self.assertValid()

    def test_hold_free_walks_defers_the_focus_walk_until_it_is_off(self):
        self.spatial.set_switches({**SWITCHES, "hold_free_walks": True})
        self.stay(30, window_id=202)
        self.assertEqual(self.walks(), [])
        self.spatial.set_switches(SWITCHES)
        self.step()
        self.assertEqual([m["target"] for m in self.walks()], [window(202)])
        self.assertValid()

    def test_a_focus_walk_waits_60_s_after_the_last_walk(self):
        self.stay(11, window_id=202)
        walked = self.now
        self.stay(15, window_id=303)
        self.stay(int(walked + spatial.FOCUS_WALK_GAP - self.now) - 1)
        self.assertEqual(len(self.walks()), 1)
        self.step()
        self.assertEqual([m["target"] for m in self.walks()], [window(202), window(303)])
        self.assertValid()

    def test_no_focus_walk_while_hidden_fullscreen_typing_or_busy(self):
        for over in ({"window_id": None}, {"window_id": 202, "fullscreen": True}, {"window_id": 202, "typing": True},
                     *({"window_id": 202, "activity": a} for a in ("meeting", "gaming", "switching"))):
            with self.subTest(over=over):
                self.setUp()
                self.stay(30, **over)
                self.assertEqual(self.walks(), [])


class WalkBiasTest(SpatialCase):
    """The read model's walk_bias hint keeps random walks off or scales the gap after one."""

    def bias(self, hint):
        def walk_bias():
            if isinstance(hint, Exception):
                raise hint
            return hint
        self.spatial.walk_bias = walk_bias

    def gap(self):
        """Seconds from one untargeted walk to the next one sent with a tick at every poll."""
        self.use(Prefer("short_walk"))  # WANDER draws its midpoint
        starts = []
        while len(starts) < 2 and self.now < T0 + 3600:
            self.spatial._next_tick = None
            self.step()
            if self.sent and self.sent[-1]["type"] == "short_walk" and self.sent[-1]["behavior_id"] in self.unity:
                starts.append(self.now)
                self.receipt(self.ids()[-1], "completed")
        self.assertEqual(len(starts), 2)
        return starts[1] - starts[0]

    def test_a_stay_hint_keeps_random_walks_off(self):
        self.bias("stay")
        self.use(Prefer("short_walk"))
        for _ in range(600):
            self.spatial._next_tick = None
            self.step()
        self.assertTrue(self.sent)
        self.assertEqual([m for m in self.sent if m["type"] == "short_walk"], [])
        self.setUp()  # nor a walk toward a settled focus
        self.bias("stay")
        self.spatial._next_tick = T0 + 10_000
        self.use(Prefer("idle", fraction=0.0))
        for window_id in (101, 202):
            self.step(window_id=window_id)
            for _ in range(29):
                self.step()
        self.assertEqual(self.sent, [])

    def test_more_and_less_scale_the_walk_gap(self):
        middle = sum(spatial.WANDER) / 2
        for hint, gap in (("more", middle * 0.5), ("less", middle * 2), ("normal", middle), (None, middle)):
            with self.subTest(hint=hint):
                self.setUp()
                self.bias(hint)
                self.assertEqual(self.gap(), gap)

    def test_an_unknown_hint_is_normal(self):
        middle = sum(spatial.WANDER) / 2
        for hint in ("sprint", 2, RuntimeError("read model gone")):
            with self.subTest(hint=hint):
                self.setUp()
                self.bias(hint)
                self.assertEqual(self.gap(), middle)


def local(hour):
    return time.mktime((2026, 10, 19, hour, 0, 0, 0, 0, -1))


class StateTest(SpatialCase):
    """Her own state scales the random tick's gap, weights, intensity and walk gap, inside the rules."""

    def with_state(self, hour, profile=None):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db = open_store(Path(tmp.name) / "agentd.sqlite")
        self.addCleanup(db.close)
        self.now = local(hour)
        state = CharacterState(db, {"aster": profile}.get, clock=lambda: self.now)
        state.use("aster")
        self.spatial = Spatial(lambda: dict(self.s), self.registry.publish_event, lambda: self.generation, 7,
                               clock=lambda: self.now, rng=self.rng, state=state)
        return state

    def test_without_state_the_picks_are_unchanged(self):
        self.spatial = Spatial(lambda: dict(self.s), self.registry.publish_event, lambda: self.generation, 7,
                               clock=lambda: self.now, state=None, recovery_delay=0)
        self.use(random.Random(5))
        for i in range(1500):
            self.step(7.0, window_id=(101, 202, None)[i // 200 % 3], typing=600 <= i < 700)
        keys = ("type", "target", "trigger", "priority", "intensity", "expires_at_ms", "replaces", "channels", "exit")
        rows = [[m.get(k) for k in keys] for m in self.sent] + self.cancels()
        # the same run before Spatial took a state, except no tick starts a sit while she types and each
        # sit draws its variant from the same RNG, and a walk also ends on speech_start
        self.assertEqual(hashlib.sha256(json.dumps(rows).encode()).hexdigest()[:16], "e501c9c6054ab6ca")
        self.assertValid()

    def walks(self, hour, seed):
        """(random walks, polls she was tired) in an hour; the card's energy_offset -0.3 keeps a night tired while
        sit and idle give energy back."""
        self.setUp()
        state = self.with_state(hour, {"energy_offset": -0.3})
        self.use(random.Random(seed))
        tired = 0
        for _ in range(360):
            self.step(10.0)
            tired += state.labels()["energy"] in ("sleepy", "very_sleepy")
        self.assertValid()
        return sum(m["type"] == "short_walk" and m["trigger"]["source"] == "tick" for m in self.sent), tired

    def test_a_tired_night_walks_at_most_half_as_often(self):
        night = [self.walks(2, seed) for seed in range(6)]
        day = [self.walks(14, seed) for seed in range(6)]
        self.assertGreater(sum(t for _, t in night), 0.8 * 6 * 360)  # control: the night is a tired one
        self.assertEqual(sum(t for _, t in day), 0)
        self.assertGreater(sum(w for w, _ in day), 0)
        self.assertLessEqual(sum(w for w, _ in night), sum(w for w, _ in day) / 2)

    def test_an_engaged_tick_behavior_is_not_switched(self):
        # lively at noon: idle 1, observe 1.3, short_walk 1.3, sit 1, hold_window_edge 1, climb_window_top 1
        self.with_state(12)
        self.use(Prefer(fraction=0.6))  # 3.96 of 6.6: sit, on the floor; the next tick 96 s away
        self.step()
        [sit] = self.sent
        self.assertEqual((sit["type"], sit["target"]), ("sit", None))
        self.use(Prefer(fraction=0.25))  # 1.65 of 6.6: observe
        self.step(96.0)  # the next tick; 96 s of sitting took engagement from 0.5 past 0.6
        self.assertEqual(self.sent, [sit])
        self.receipt(sit["behavior_id"], "cancelled")  # interrupted: engagement drops to 0.2
        self.spatial._next_tick = None
        self.step()
        self.assertEqual([m["type"] for m in self.sent], ["sit", "observe"])
        self.assertValid()

    def test_sit_renewals_preserve_engagement_until_the_current_sit_ends(self):
        state = self.with_state(12)
        self.use(Prefer(fraction=0.6))
        self.step()
        self.use(Prefer(fraction=0.25))
        for _ in range(2):
            sit = self.sent[-1]
            self.spatial._next_tick = self.now + 10_000
            self.step(sit["expires_at_ms"] / 1000 - self.now - spatial.RENEW + 1)
            self.assertGreaterEqual(state.snapshot()["engagement"], spatial.ENGAGED)
            self.assertEqual(self.sent[-1]["replaces"], sit["behavior_id"])
            self.spatial._next_tick = None
            self.step()
            self.assertTrue(all(m["type"] == "sit" for m in self.sent))
        self.assertEqual(len(self.sent), 3)
        self.receipt(self.sent[-1]["behavior_id"], "cancelled")
        self.assertEqual(state.snapshot()["engagement"], 0.2)
        self.assertIsNone(state.snapshot()["activity"])
        self.spatial._next_tick = None
        self.step()
        self.assertEqual(self.sent[-1]["type"], "observe")
        self.assertValid()

    def test_the_typing_cap_wins_over_a_lively_state(self):
        for seed in range(5):
            with self.subTest(seed=seed):
                self.setUp()
                state = self.with_state(12)
                self.assertEqual(state.labels()["energy"], "lively")
                self.use(random.Random(seed))
                self.s["typing"] = True
                for _ in range(300):
                    self.step(1.0)
                types = [m["type"] for m in self.sent]
                self.assertTrue(any(m["trigger"]["source"] == "tick" for m in self.sent))  # control: ticks did happen
                self.assertFalse(set(types) & set(c1.MOVING))
                self.assertTrue(all(m["intensity"] <= c1.TYPING_MAX for m in self.sent))
                self.assertValid()


class ActivityTest(SpatialCase):
    """The random tick follows the ActivityContext activity."""

    with_state = StateTest.with_state

    def test_switching_suppresses_tick(self):
        self.s["activity"] = "switching"
        self.step()
        self.assertEqual(self.sent, [])
        self.step(spatial.TICK[1], activity=None)  # the next round ticks as usual
        self.assertEqual([m["trigger"]["source"] for m in self.sent], ["tick"])
        self.assertValid()

    def test_meeting_suppresses_tick(self):
        self.s["activity"] = "meeting"
        self.step()
        self.assertEqual(self.sent, [])
        self.step(spatial.TICK[1], activity=None)
        self.assertEqual([m["trigger"]["source"] for m in self.sent], ["tick"])
        self.assertValid()

    def test_reading_prefers_observe_window(self):
        self.use(Prefer("idle"))
        self.step(activity="reading")
        self.assertEqual(self.shape(), [("observe", window(101), ("tick", None), None)])
        self.assertValid()
        self.setUp()
        self.with_state(12)
        self.use(Prefer(fraction=0.0))  # the state's weights would draw idle
        self.step(activity="reading")
        self.assertEqual(self.shape(), [("observe", window(101), ("tick", None), None)])
        self.assertValid()

    def test_reading_without_a_focus_window_picks_as_before(self):
        runs = []
        for activity in (None, "reading"):
            self.setUp()
            self.use(random.Random(3))
            for _ in range(100):
                self.step(spatial.TICK[1], window_id=None, activity=activity)
            self.assertValid()
            runs.append(self.shape())
        self.assertGreater(len(runs[0]), 50)
        self.assertEqual(runs[1], runs[0])


class UserActivityTest(SpatialCase):
    """Her body answers what the user does once it held USER_SETTLE: once per run, with what the character has."""

    CAPS = {"sit": None, "observe": None}

    def setUp(self):
        super().setUp()
        self.spatial._next_tick = T0 + 10_000  # no random tick unless a test asks for one
        self.spatial.set_capabilities("birch", dict(self.CAPS))

    def reactions(self):
        return [(m["type"], m["target"], m.get("variant"), m["priority"]) for m in self.sent
                if (m["trigger"]["event"] or "").startswith("activity:")]

    def hold(self, activity, seconds, **over):
        self.step(0, activity=activity, **over)
        for _ in range(int(seconds)):
            self.step(1)

    def test_each_activity_gets_its_body_once_after_5_s(self):
        for activity, body in (("reading", ("sit", None, "read", 1)), ("watching_video", ("sit", None, "tea", 1)),
                               ("editing_code", ("observe", window(101), None, 1)), ("meeting", ("idle", None, None, 1))):
            with self.subTest(activity=activity):
                self.setUp()
                self.hold(activity, spatial.USER_SETTLE - 1)
                self.assertEqual(self.reactions(), [], "not before USER_SETTLE")
                self.step(1)
                self.assertEqual(self.reactions(), [body])
                self.assertEqual(self.sent[-1]["trigger"], {"source": "user", "event": "activity:" + activity})
                self.hold(activity, 120)
                self.assertEqual(self.reactions(), [body], "one body change per activity run")
                self.assertValid()

    def test_a_flicker_under_5_s_moves_nothing(self):
        for activity in ("reading", "editing_code", "reading", "watching_video") * 3:
            self.hold(activity, spatial.USER_SETTLE - 2)
        self.assertEqual(self.reactions(), [])

    def test_unmapped_activities_and_a_legacy_host_get_nothing_new(self):
        for activity in (None, "unknown", "switching", "typing", "gaming", "comparing_sources"):
            self.hold(activity, 30)
        self.assertEqual(self.reactions(), [])
        self.setUp()
        self.spatial.capabilities = None  # a host that reports none: legacy behavior
        self.hold("reading", 30)
        self.assertEqual(self.reactions(), [])

    def test_a_pack_without_the_variant_or_seat_observes_the_window_instead(self):
        self.unsupported = {"sit"}  # the fake renderer rejects the reading sit as unsupported
        self.hold("reading", spatial.USER_SETTLE + 2)
        self.assertEqual(self.reactions(), [("sit", None, "read", 1), ("observe", window(101), None, 1)])
        self.assertValid()
        self.setUp()
        self.spatial.set_capabilities("aster", {"sit": "no seat", "observe": None})
        self.hold("watching_video", spatial.USER_SETTLE + 2)
        self.assertEqual(self.reactions(), [("observe", window(101), None, 1)])
        self.assertValid()

    def test_a_variant_the_host_reports_missing_is_skipped_up_front(self):
        self.spatial.set_capabilities("aster", {"sit": None, "sit/read": "no read variant", "observe": None})
        self.hold("reading", spatial.USER_SETTLE + 2)
        self.assertEqual(self.reactions(), [("observe", window(101), None, 1)])
        self.assertValid()
        self.setUp()
        self.spatial.set_capabilities("aster", {"sit": None, "sit/tea": None, "observe": None})
        self.hold("watching_video", spatial.USER_SETTLE + 2)
        self.assertEqual(self.reactions(), [("sit", None, "tea", 1)])
        self.assertValid()

    def test_a_new_activity_replaces_the_last_answer(self):
        self.hold("reading", spatial.USER_SETTLE)
        [read] = self.sent
        self.hold("watching_video", spatial.USER_SETTLE)
        self.assertEqual([(m["variant"], m["replaces"]) for m in self.sent], [("read", None), ("tea", read["behavior_id"])])
        self.hold("meeting", spatial.USER_SETTLE)
        self.assertEqual((self.sent[-1]["type"], self.sent[-1]["replaces"]), ("idle", self.sent[1]["behavior_id"]))
        self.assertValid()

    def test_speech_and_a_session_that_needs_the_user_keep_priority(self):
        for over in ({"speaking": True, "line_id": "l-1"}, {"user_speaking": True},
                     {"session": "codex:A", "state": "awaiting_approval", "related": ["codex:A"]}):
            with self.subTest(over=over):
                self.setUp()
                self.hold("reading", 20, **over)
                self.assertEqual(self.reactions(), [])
                self.step(1, speaking=False, user_speaking=False, session=None, state="idle")
                self.assertEqual(self.reactions(), [("sit", None, "read", 1)], "the same run answers once free")
                self.assertValid()

    def test_she_sits_to_read_beside_a_working_session_and_long_work_takes_over(self):
        self.hold("reading", spatial.USER_SETTLE, session="codex:A", state="thinking", related=["codex:A"])
        self.assertEqual(self.reactions(), [("sit", None, "read", 1)])
        read = self.sent[-1]
        self.hold("reading", spatial.LONG_WORK)
        posture = [m for m in self.sent if m["trigger"]["source"] == "session" and m["type"] == "sit"]
        self.assertEqual([m["replaces"] for m in posture], [read["behavior_id"]])
        self.assertValid()

    def test_no_reading_sit_while_the_user_types(self):
        self.hold("editing_code", 1)
        self.hold("reading", 20, typing=True)
        self.assertEqual(self.reactions(), [])
        self.assertValid()


class VariantTest(SpatialCase):
    """A random tick's sit takes its variant from the activity; typing starts no sit."""

    def tick(self, **over):
        self.spatial._next_tick = None  # a tick at this poll
        self.step(**over)

    def test_reading_user_gets_a_reading_sit(self):
        self.use(Prefer("sit", None))
        self.tick(activity="reading", window_id=None)  # no window: observe is not there to prefer
        self.assertEqual([(m["type"], m["target"], m.get("variant")) for m in self.sent], [("sit", None, "read")])
        self.assertValid()

    def test_unsupported_read_falls_back_to_plain_sit(self):
        self.unsupported = {"sit"}  # the fake renderer has no reading sit
        self.use(Prefer("sit", None))
        self.tick(activity="reading", window_id=None)
        self.assertEqual(self.receipts(self.ids()[0]), [("rejected", "unsupported")])
        self.unsupported = set()
        self.tick()
        self.assertEqual([(m["type"], m.get("variant", "absent")) for m in self.sent],
                         [("sit", "read"), ("sit", "absent")])
        self.assertValid()

    def test_typing_starts_no_sit(self):
        self.use(Prefer("sit", None))
        for _ in range(20):
            self.tick(typing=True, activity="reading", window_id=None)
        self.assertTrue(any(m["trigger"]["source"] == "tick" for m in self.sent))  # control: ticks did happen
        self.assertNotIn("sit", [m["type"] for m in self.sent])
        self.assertValid()

    def test_renewal_keeps_the_variant(self):
        self.use(Prefer("sit", None))
        self.tick(activity="reading", window_id=None)
        [sit] = self.sent
        self.spatial._next_tick = T0 + 10_000  # no other tick while she sits
        self.step(sit["expires_at_ms"] / 1000 - self.now - spatial.RENEW + 1, activity="editing_code")
        self.assertEqual([(m["type"], m.get("variant"), m["replaces"]) for m in self.sent],
                         [("sit", "read", None), ("sit", "read", sit["behavior_id"])])
        self.assertValid()


class PostureTest(SpatialCase):
    """Long work sits her down, a session that needs the user ends it, a quiet desk lets her rest."""

    def setUp(self):
        super().setUp()
        self.spatial._next_tick = T0 + 10_000  # no random tick unless a test asks for one

    def sits(self):
        return [m for m in self.sent if m["type"] == "sit"]

    def work(self):
        """A session that has thought for LONG_WORK seconds; returns her long-work sit."""
        self.step(0, session="codex:A", state="thinking", related=["codex:A"])
        self.step(spatial.LONG_WORK - 1, state="running_tool")
        self.assertEqual(self.sits(), [], "not before LONG_WORK")
        self.step(1, activity="reading")
        [sit] = self.sits()
        return sit

    def test_long_work_sits_after_180_s_and_not_before(self):
        sit = self.work()
        self.assertEqual((sit["target"], sit["trigger"], sit["display_session"], sit["priority"], sit["channels"],
                          sit["exit"], sit.get("variant")),
                         (None, {"source": "session", "event": "session_state:thinking"}, "codex:A", 1,
                          ["full_body", "contact"], ["session_state", "user_drag"], "read"))
        self.step(sit["expires_at_ms"] / 1000 - self.now - spatial.RENEW + 1)
        self.assertEqual([(m["replaces"], m.get("variant")) for m in self.sits()],
                         [(None, "read"), (sit["behavior_id"], "read")], "renewed like other sits")
        self.assertValid()

    def test_long_work_sit_ends_when_the_session_needs_the_user(self):
        sit = self.work()
        self.step(1, state="awaiting_approval")
        self.assertIn((sit["behavior_id"], "exit", "session_state"), self.cancels())
        self.assertEqual(self.sent[-1]["type"], "attend_session")
        self.step(spatial.LONG_WORK)
        self.assertEqual(self.sits(), [sit])
        self.assertNotIn("sit", [b["type"] for b in self.spatial.running()])
        self.assertValid()

    def test_long_work_sit_holds_through_a_state_flip_until_seated_sit_min_hold(self):
        sit = self.work()
        self.step(5, state="done")
        self.assertNotIn(sit["behavior_id"], [c[0] for c in self.cancels()], "not right after she sat down")
        self.step(spatial.SIT_MIN_HOLD - 6, session=None, state="idle")
        self.assertNotIn(sit["behavior_id"], [c[0] for c in self.cancels()])
        self.step(1)
        self.assertIn((sit["behavior_id"], "exit", "session_state"), self.cancels())
        self.assertValid()

    def test_no_long_work_sit_while_typing(self):
        self.step(0, session="codex:A", state="thinking", typing=True)
        for _ in range(30):
            self.step(10)
        self.assertEqual(self.sits(), [])
        self.step(1, typing=False)
        self.assertEqual([m["trigger"]["source"] for m in self.sits()], ["session"])
        self.assertValid()

    def test_ticks_do_not_walk_during_long_work_sit(self):
        sit = self.work()
        self.use(Prefer("short_walk", "climb_window_top", "window"))
        for _ in range(40):
            self.spatial._next_tick = None  # a tick at every poll
            self.step(5)
        self.assertFalse({m["type"] for m in self.sent} & {"short_walk", "climb_window_top"})
        self.assertIn(sit["behavior_id"], [b["behavior_id"] for b in self.spatial.running()])
        self.assertValid()

    def away(self):
        """user_now's absence, begun now."""
        return {"absence": {"id": "1-1", "since": self.now}}

    def test_rest_after_away_10_min(self):
        self.step(0, activity="away")
        self.step(spatial.AWAY_REST)
        self.assertEqual(self.sits(), [])  # the scene's away is not user_now's absence
        self.step(0, **self.away())
        self.step(spatial.AWAY_REST - 1)
        self.assertEqual(self.sits(), [])
        self.step(1)
        [rest] = self.sits()
        self.assertEqual((rest["target"], rest["trigger"], rest["priority"], rest["channels"], "variant" in rest),
                         (None, {"source": "user", "event": "rest"}, 1, ["full_body", "contact"], False))
        self.assertValid()

    def test_rest_at_2330_after_5_min_quiet(self):
        for hour, rests in ((23, True), (14, False)):
            with self.subTest(hour=hour):
                self.setUp()
                self.now = local(hour) + 1800
                self.spatial._next_tick = self.now + 10_000
                self.step(0, idle_s=0.0)
                self.step(spatial.QUIET - 1, idle_s=spatial.QUIET - 1)
                self.assertEqual(self.sits(), [])
                self.step(1, idle_s=spatial.QUIET)
                self.assertEqual([m["trigger"]["event"] for m in self.sits()], ["rest"] if rests else [])
                if rests:  # the checker wants at least one message
                    self.assertValid()

    def test_rest_ends_on_input_speech_or_session(self):
        # condition None: the typing accompany replaces it (it ends on user_typing)
        for wake, condition in (({"idle_s": 0.4}, "user_typing"), ({"absence": None}, "user_typing"),
                                ({"typing": True}, None), ({"user_speaking": True}, "speech_start"),
                                ({"session": "codex:A", "state": "thinking"}, "session_state")):
            with self.subTest(wake=wake):
                self.setUp()
                self.now = local(14)
                self.spatial._next_tick = self.now + 10_000
                self.step(0, idle_s=0.0, **self.away())
                self.step(spatial.AWAY_REST, idle_s=spatial.AWAY_REST)
                [rest] = self.sits()
                self.step(1, **wake)
                if condition is None:
                    self.assertEqual(self.sent[-1]["replaces"], rest["behavior_id"])
                else:
                    self.assertIn((rest["behavior_id"], "exit", condition), self.cancels())
                self.step(1)
                self.assertEqual(self.sits(), [rest])
                self.assertNotIn(rest["behavior_id"], [b["behavior_id"] for b in self.spatial.running()])
                self.assertValid()

    def test_rest_variant_only_when_the_host_says_so(self):
        for caps, variant in ((None, None), ({"sit": None, "sit/rest": "no rest pool"}, None),
                              ({"sit": None, "sit/rest": None}, "rest")):
            with self.subTest(caps=caps):
                self.setUp()
                if caps is not None:
                    self.spatial.set_capabilities("aster", caps)
                self.step(0, **self.away())
                self.step(spatial.AWAY_REST)
                self.assertEqual([m.get("variant") for m in self.sits()], [variant])


class RunTest(SpatialCase):
    """run() polls every POLL, and at once after wake()."""

    def start(self, poll):
        polled, stop = threading.Event(), threading.Event()
        self.spatial.poll = polled.set
        patcher = unittest.mock.patch.object(spatial, "POLL", poll)
        patcher.start()
        self.addCleanup(patcher.stop)
        loop = threading.Thread(target=self.spatial.run, args=(stop,), daemon=True)
        loop.start()
        self.addCleanup(loop.join, 1)
        self.addCleanup(self.spatial.wake)
        self.addCleanup(stop.set)
        return polled

    def test_wake_polls_long_before_poll_and_only_once(self):
        polled = self.start(30.0)
        time.sleep(0.05)  # the loop waits
        self.spatial.wake()
        self.assertTrue(polled.wait(0.2))
        polled.clear()
        self.assertFalse(polled.wait(0.2))

    def test_without_wake_it_polls_every_poll(self):
        polled = self.start(0.05)
        for _ in range(3):
            self.assertTrue(polled.wait(1))
            polled.clear()


class ReceiptTest(SpatialCase):
    def test_unknown_after_terminal_and_stale(self):
        self.use(Prefer("idle"))
        self.step()
        behavior_id = self.ids()[0]
        self.assertEqual(self.spatial.receipt({"behavior_id": "b-7-99", "phase": "running", "reason": None,
                                               "at_ms": 1, "turn_generation": 3}), (False, "unknown_behavior"))
        self.assertEqual(self.receipt(behavior_id, "completed"), (True, None))
        self.assertEqual(self.spatial.records[behavior_id]["outcome"], "done")
        self.assertEqual(self.spatial.running(), [])
        self.assertEqual(self.spatial.receipt({"behavior_id": behavior_id, "phase": "running", "reason": None,
                                               "at_ms": 2, "turn_generation": 3}), (False, "after_terminal"))
        self.step(spatial.TICK[1])
        later = self.ids()[-1]
        self.assertEqual(self.spatial.records[later]["behavior"]["turn_generation"], 3)
        self.generation = 4  # a new turn: the behavior lives on and its receipts carry its own generation (C1 §3)
        self.assertEqual(self.spatial.receipt({"behavior_id": later, "phase": "running", "reason": None,
                                               "at_ms": 3, "turn_generation": 2}), (False, "stale"))
        self.assertNotEqual(self.spatial.running(), [])
        self.assertEqual(self.spatial.receipt({"behavior_id": later, "phase": "completed", "reason": None,
                                               "at_ms": 4, "turn_generation": 3}), (True, None))
        self.assertEqual(self.spatial.records[later]["outcome"], "done")

    def test_connection_lost_is_lost_neither_done_nor_interrupted(self):
        self.use(Prefer("hold_window_edge", "left"))
        self.step()
        lost = self.ids()[0]
        self.assertEqual(self.receipt(lost, "cancelled", "connection_lost"), (True, None))
        self.assertEqual(self.spatial.records[lost]["outcome"], "lost")
        self.assertEqual(self.spatial.running(), [])  # a reconnect's snapshot does not resume it (fixture 10)
        self.step(spatial.TICK[1])
        cut = self.ids()[-1]
        self.receipt(cut, "cancelled")
        self.assertEqual(self.spatial.records[cut]["outcome"], "interrupted")
        self.assertEqual(self.spatial.last_receipt["phase"], "cancelled")
        self.assertValid()

    def test_only_the_last_64_behaviors_are_kept(self):
        self.use(Prefer("idle"))
        for _ in range(70):
            self.step(spatial.TICK[1])
        self.assertEqual(len(self.spatial.records), spatial.KEPT)
        self.assertEqual(self.spatial.receipt({"behavior_id": "b-7-1", "phase": "running", "reason": None,
                                               "at_ms": 1, "turn_generation": 3}), (False, "unknown_behavior"))


def perform(generation):
    """A Performer's game action as it hands it to Spatial.offer."""
    return {"behavior_id": "b-ga-0123456789abcdef", "type": "perform", "target": None,
            "trigger": {"source": "agent", "event": None}, "display_session": None, "turn_id": None,
            "turn_generation": generation, "priority": 1, "expires_at_ms": int((T0 + 60) * 1000), "intensity": 1.0,
            "channels": ["full_body"], "exit": [], "trace_id": "trace-1",
            "action": {"id": "dialog_single_wave1", "length_s": 2.0}}


class ObserveRoutine:
    """A routine that picks an observe whenever one may start."""

    def advance(self, now, sitting):
        pass

    def doing(self, now):
        return None

    def end(self, now, name):
        pass

    def choose(self, now, kinds, context):
        return ("look", types.SimpleNamespace(kind="observe", variant=None), 60.0) if "observe" in kinds else None


class AdmitTest(SpatialCase):
    """Every proposal passes Spatial.admit before _send touches a channel; a refused one cancels nothing."""

    def setUp(self):
        super().setUp()
        self.stage = "normal"
        self.spatial.stage = lambda: self.stage
        self.spatial._next_tick = T0 + 10_000  # no random tick unless a test asks for one

    def propose(self, spec):
        with self.spatial._lock:
            self.spatial._send(spec, dict(self.s), self.now)
        self.flush()

    def test_a_lower_priority_tick_never_cancels_a_running_listen(self):
        self.step(user_speaking=True)
        [listen] = self.sent
        self.assertEqual((listen["type"], listen["priority"]), ("listen", 2))
        tick = spatial._spec("observe", window(101), "tick", None, 0, spatial.EYES, ("focus_change",), 0.5, 30.0)
        self.propose(tick)
        self.assertEqual(self.cancels(), [])
        self.assertEqual(self.sent, [listen])
        self.assertEqual([b["behavior_id"] for b in self.spatial.running()], [listen["behavior_id"]])
        self.assertEqual(self.spatial.diag()["refused"], {"busy": 1})
        self.assertEqual(self.spatial.admit(tick, dict(self.s), self.now), (False, "busy"))
        self.assertValid()

    def test_offstage_refuses_ticks_routine_focus_walks_and_performer_actions(self):
        self.stage = "offstage"
        self.use(Prefer("observe", fraction=0.0))  # every focus-walk draw wins
        self.spatial._next_tick = None
        self.step()
        self.assertEqual(self.sent, [])
        self.assertEqual(self.spatial.diag()["refused"], {"stage": 1})
        self.spatial._next_tick = T0 + 10_000
        for window_id in (101, 202):  # the first window settles, the second is a move that draws a walk
            for _ in range(int(spatial.FOCUS_SETTLE) + 1):
                self.step(window_id=window_id)
        self.assertEqual(self.spatial.diag()["refused"], {"stage": 2})
        self.spatial.routine, self.spatial._next_tick = ObserveRoutine(), None
        self.step()
        self.assertEqual(self.spatial.diag()["refused"], {"stage": 3})
        self.assertEqual(self.spatial.offer(perform(3)), (False, "stage"))
        self.flush()
        self.assertEqual((self.sent, self.cancels()), ([], []))
        self.assertEqual(self.spatial.diag()["refused"], {"stage": 4})

    def test_offstage_renews_a_running_sit(self):
        self.use(Prefer("sit"))
        self.spatial._next_tick = None
        self.step()
        [sit] = self.sent
        self.assertEqual((sit["type"], sit["target"]), ("sit", None))
        self.stage = "offstage"
        self.step(600 - spatial.RENEW + 1)
        self.assertEqual(self.shape()[1:], [("sit", None, ("tick", None), sit["behavior_id"])])
        self.assertEqual(self.cancels(), [])
        self.assertValid()

    def test_quiet_doubles_the_tick_gap(self):
        self.use(Prefer("idle"))
        self.spatial._next_tick = None
        self.step()
        normal = self.spatial._next_tick - self.now
        self.stage = "quiet"
        self.spatial._next_tick = None
        self.step()
        self.assertEqual(self.spatial._next_tick - self.now, 2 * normal)

    def test_quiet_admits_task_behaviors_on_the_head_only(self):
        self.stage = "quiet"
        self.step(session="claude:A", state="thinking")
        [accompany] = self.sent
        self.assertEqual((accompany["type"], accompany["channels"]), ("accompany", ["eyes", "head"]))
        self.step(spatial.LONG_WORK)  # long work: the sit would take the full body
        self.assertEqual(self.sent, [accompany])
        self.assertEqual(self.spatial.diag()["refused"], {"stage": 1})
        self.assertValid()

    def test_while_she_speaks_seated_only_head_channels_are_admitted(self):
        self.use(Prefer("sit"))
        self.spatial._next_tick = None
        self.step()
        [sit] = self.sent
        self.step(speaking=True, line_id="l-1")
        think = self.sent[-1]
        self.assertEqual((think["type"], think["channels"]), ("think", ["eyes", "head"]))
        body = {**spatial._spec("perform", None, "agent", None, 1, ("full_body",), (), 1.0, 5.0),
                "action": {"id": "dialog_single_wave1", "length_s": 2.0}}
        self.propose(body)
        self.assertEqual(self.sent, [sit, think])
        self.assertEqual(self.cancels(), [])
        self.assertEqual(self.spatial.diag()["refused"], {"posture": 1})

    def test_a_walk_ends_when_speech_starts_and_no_tick_starts_while_she_speaks(self):
        self.use(Prefer("short_walk"))
        self.spatial._next_tick = None
        self.step()
        [walk] = self.sent
        self.step(voicing=True)
        self.assertIn((walk["behavior_id"], "exit", "speech_start"), self.cancels())
        self.spatial._next_tick = self.now + 1
        self.step()
        self.assertEqual(self.sent, [walk])
        self.assertEqual(self.spatial.diag()["refused"], {"speech": 1})
        self.assertValid()


EDGE = {"kind": "edge", "side": "nearest"}


class QuietEdgeTest(SpatialCase):
    """Entering the quiet stage walks her once to the nearest free edge, where she stays until quiet ends."""

    def setUp(self):
        super().setUp()
        self.stage = "normal"
        self.spatial.stage = lambda: self.stage
        self.spatial._next_tick = T0 + 10_000  # no random tick unless a test asks for one

    def enter(self, stage="quiet"):
        self.stage = stage
        self.spatial.stage_event(f"stage.{stage}")

    def edge_walks(self):
        return [m for m in self.sent if m["type"] == "short_walk" and m["target"] == EDGE]

    def test_entering_quiet_sends_one_walk_to_the_nearest_edge(self):
        self.enter()
        self.assertTrue(self.spatial.diag()["edge_pending"])
        self.step()
        [walk] = self.sent
        self.assertEqual((walk["type"], walk["target"], walk["trigger"]["source"], walk["priority"],
                          walk["channels"], walk["exit"]),
                         ("short_walk", EDGE, "decision", 0, ["full_body"], ["user_drag"]))
        for _ in range(5):
            self.step()
        self.assertEqual(self.sent, [walk])
        self.assertEqual(self.spatial.diag()["edge_pending"], False)
        self.assertValid()

    def test_after_the_walk_she_is_parked_until_quiet_ends(self):
        self.use(Prefer("short_walk", "climb_window_top", "hold_window_edge", fraction=0.0))
        self.enter()
        self.step()
        [walk] = self.sent
        self.receipt(walk["behavior_id"], "completed")
        self.assertTrue(self.spatial.diag()["parked"])
        for _ in range(3):
            self.spatial._next_tick = None
            self.step(spatial.TICK[1] * spatial.QUIET_SLOW)
        self.assertFalse([m for m in self.sent[1:] if m["type"] in ("short_walk", "climb_window_top",
                                                                    "hold_window_edge")])
        self.enter("normal")
        self.assertFalse(self.spatial.diag()["parked"])
        self.spatial._next_tick, self.spatial._wander_at, self.spatial._recovery_at = None, None, 0.0
        self.step()
        self.assertEqual(self.sent[-1]["type"], "short_walk")
        self.assertNotEqual(self.sent[-1]["target"], EDGE)  # leaving quiet does not walk her back
        self.assertValid()

    def test_a_drag_during_the_walk_parks_her_too(self):
        self.enter()
        self.step()
        [walk] = self.sent
        self.receipt(walk["behavior_id"], "cancelled", "user_drag")
        self.assertTrue(self.spatial.diag()["parked"])
        self.step()
        self.assertEqual(self.sent, [walk])

    def test_a_second_quiet_entry_walks_again(self):
        self.enter()
        self.step()
        self.receipt(self.sent[0]["behavior_id"], "completed")
        self.enter("normal")
        self.step()
        self.enter()
        self.step()
        self.assertEqual(len(self.edge_walks()), 2)
        self.assertValid()

    def test_while_the_user_types_the_walk_waits_until_typing_has_been_off_for_a_while(self):
        self.s["typing"] = True
        self.step()
        self.enter()
        for _ in range(3):
            self.step()
        self.assertEqual(self.edge_walks(), [])
        self.assertTrue(self.spatial.diag()["edge_pending"])
        self.step(typing=False)
        self.step(1.0)  # typing off 1 s
        self.assertEqual(self.edge_walks(), [])
        self.step(1.0)  # 2 s: past the give-way pause
        self.assertEqual(len(self.edge_walks()), 1)
        self.assertNotIn("typing", self.spatial.diag()["refused"])
        self.assertValid()

    def test_seated_she_does_not_walk_and_is_parked(self):
        self.use(Prefer("sit"))
        self.spatial._next_tick = None
        self.step()
        [sit] = self.sent
        self.assertEqual(sit["type"], "sit")
        self.enter()
        self.step()
        self.assertEqual(self.sent, [sit])
        self.assertEqual((self.spatial.diag()["parked"], self.spatial.diag()["edge_pending"]), (True, False))

    def test_stay_in_place_sends_nothing_and_parks(self):
        self.spatial.set_switches({**SWITCHES, "stay_in_place": True})
        self.enter()
        self.step()
        self.assertEqual(self.sent, [])
        self.assertTrue(self.spatial.diag()["parked"])

    def test_hold_free_walks_keeps_the_edge_walk_pending_until_it_is_off(self):
        self.spatial.set_switches({**SWITCHES, "hold_free_walks": True})
        self.enter()
        for _ in range(3):
            self.step()
        self.assertEqual(self.sent, [])
        self.assertEqual((self.spatial.diag()["parked"], self.spatial.diag()["edge_pending"]), (False, True))
        self.spatial.set_switches(SWITCHES)
        self.step()
        self.assertEqual(len(self.edge_walks()), 1)
        self.assertValid()

    def test_an_unsupported_edge_parks_her_and_the_next_entry_sends_nothing(self):
        self.unsupported.add("short_walk@edge")
        self.enter()
        self.step()
        self.assertEqual(self.receipts(self.sent[0]["behavior_id"]), [("rejected", "unsupported")])
        self.assertTrue(self.spatial.diag()["parked"])
        self.enter("normal")
        self.enter()
        self.step()
        self.assertEqual(len(self.edge_walks()), 1)
        self.assertTrue(self.spatial.diag()["parked"])

    def test_diag_counts_the_consumed(self):
        self.stage = "quiet"
        self.spatial.consumed.take("done-1")
        self.assertEqual(self.spatial.diag()["consumed"], 1)


class ServerCase(unittest.TestCase):
    def setUp(self):
        self.server = AgentdServer(("127.0.0.1", 0), HOOK, UI, events_token=EVENTS)
        self.port = self.server.server_port
        self.thread = support.serve_in_thread(self.server)
        self.server.spatial.observe = lambda: situation()
        self.server.spatial.rng = Prefer("idle")

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    request = support.request

    def snapshot(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("GET", "/events", headers={"Authorization": f"Bearer {EVENTS}"})
        response = conn.getresponse()
        self.assertEqual(response.fp.readline().decode(), "event: snapshot\n")
        data = json.loads(response.fp.readline().decode()[len("data: "):])
        conn.close()
        return data


class SituationServerTest(ServerCase):
    def test_voicing_is_the_relay_with_audio_in_flight(self):
        class Relay:
            playing = False

            def busy(self):
                return self.playing
        self.assertFalse(self.server.spatial_situation()["voicing"])  # no --tts-url
        self.server.speech = relay = Relay()
        self.assertFalse(self.server.spatial_situation()["voicing"])
        relay.playing = True
        self.assertTrue(self.server.spatial_situation()["voicing"])


class SwitchServerTest(ServerCase):
    def test_put_switches_stores_and_echoes(self):
        changed = {**SWITCHES, "stay_in_place": True}
        self.assertEqual(self.request("PUT", "/behavior/switches", changed), (200, changed))
        self.assertEqual(self.server.spatial.switches, changed)
        self.assertEqual(self.request("GET", "/diag/state")[1]["behavior"]["switches"], changed)

    def test_bad_bodies_are_400_and_no_token_401(self):
        bad = [{k: v for k, v in SWITCHES.items() if k != "stay_in_place"}, {**SWITCHES, "extra": True},
               {**SWITCHES, "stay_in_place": 1}, [True], None]
        for body in bad:
            with self.subTest(body=body):
                self.assertEqual(self.request("PUT", "/behavior/switches", body), (400, {"error": "invalid_switches"}))
        self.assertEqual(self.request("PUT", "/behavior/switches", SWITCHES, token=None)[0], 401)
        self.assertEqual(self.request("PUT", "/behavior/switches", SWITCHES, token=EVENTS)[0], 401)
        self.assertEqual(self.server.spatial.switches, SWITCHES)  # the defaults stand


class ReceiptServerTest(ServerCase):
    def test_receipts_answer_and_the_snapshot_carries_the_running_behavior(self):
        self.server.registry.tick()  # the first intent, which the snapshot is made of
        self.server.turn_generation = 3
        self.server.spatial.poll()
        snapshot = self.snapshot()
        [behavior] = snapshot["behaviors"]
        self.assertEqual((behavior["type"], behavior["turn_generation"]), ("idle", 3))
        self.assertEqual(c1.check_message({**snapshot, "event": "snapshot"}), [])
        body = {"behavior_id": behavior["behavior_id"], "phase": "running", "reason": None, "at_ms": 1,
                "turn_generation": 3}
        self.assertEqual(self.request("POST", "/behavior/receipts", body), (200, {"applied": True, "why": None}))
        state = self.request("GET", "/diag/state")[1]["behavior"]
        [running] = state["running"]  # every running behavior, as the snapshot's behaviors
        self.assertEqual((running["behavior_id"], running["type"]), (behavior["behavior_id"], "idle"))
        self.assertEqual(self.request("POST", "/behavior/receipts", {**body, "phase": "completed"}),
                         (200, {"applied": True, "why": None}))
        self.assertEqual(self.snapshot()["behaviors"], [])
        state = self.request("GET", "/diag/state")[1]["behavior"]
        self.assertEqual(state["running"], [])
        self.assertEqual((state["last_receipt"]["behavior_id"], state["last_receipt"]["phase"]),
                         (behavior["behavior_id"], "completed"))
        self.assertEqual(self.request("POST", "/behavior/receipts", body),
                         (200, {"applied": False, "why": "after_terminal"}))
        self.assertEqual(self.request("POST", "/behavior/receipts", {**body, "behavior_id": "b-0-0"}),
                         (200, {"applied": False, "why": "unknown_behavior"}))
        published = [i for i in self.server.registry.intents_since(0) if i.get("event") == "behavior"]
        self.assertEqual([i["behavior_id"] for i in published], [behavior["behavior_id"]])

    def test_a_receipt_of_a_behavior_without_a_turn_is_traced(self):
        from traces.trace_store import TraceStore
        db = Path(tempfile.mkdtemp()) / "trace.sqlite3"
        self.addCleanup(shutil.rmtree, db.parent)
        self.server.trace = TraceStore(open_store(db), producer_epoch=self.server.registry.epoch)
        self.server.registry.tick()
        self.server.turn_generation = 3
        self.server.spatial.poll()
        [behavior] = self.snapshot()["behaviors"]
        body = {"behavior_id": behavior["behavior_id"], "phase": "running", "reason": None, "at_ms": 1,
                "turn_generation": 3}
        self.assertEqual(self.request("POST", "/behavior/receipts", body), (200, {"applied": True, "why": None}))
        rows = self.server.trace.db.execute("SELECT turn_id FROM trace_events WHERE kind = 'behavior.receipt'").fetchall()
        self.assertEqual((rows, self.server.trace_errors), ([(None,)], 0))

    def test_a_receipt_is_caused_by_its_behavior_s_dispatch(self):
        from traces.trace_store import TraceStore
        db = Path(tempfile.mkdtemp()) / "trace.sqlite3"
        self.addCleanup(shutil.rmtree, db.parent)
        self.server.trace = TraceStore(open_store(db), producer_epoch=self.server.registry.epoch)
        self.server.registry.tick()
        self.server.turn_generation = 3
        self.server.spatial.poll()
        [behavior] = self.snapshot()["behaviors"]
        body = {"behavior_id": behavior["behavior_id"], "phase": "running", "reason": None, "at_ms": 1,
                "turn_generation": 3}
        self.assertEqual(self.request("POST", "/behavior/receipts", body), (200, {"applied": True, "why": None}))
        events = [json.loads(raw) for (raw,) in self.server.trace.db.execute(
            "SELECT event FROM trace_events WHERE kind IN ('behavior.dispatched', 'behavior.receipt') ORDER BY id")]
        [dispatched] = [e for e in events if e["kind"] == "behavior.dispatched"
                        and e["attrs"]["behavior_id"] == behavior["behavior_id"]]
        [receipt] = [e for e in events if e["kind"] == "behavior.receipt"]
        self.assertEqual((receipt["trace_id"], receipt["causation_id"]), (dispatched["trace_id"], dispatched["event_id"]))

    def test_the_snapshot_carries_the_stage_and_a_stage_change_sends_it(self):
        self.assertEqual(self.snapshot()["stage"], {"level": "normal", "revision": 0})
        self.server.spatial.stage = lambda: "quiet"
        seq = self.server.registry.intent_seq
        self.server.spatial.stage_event("stage.quiet")
        [sent] = [i for i in self.server.registry.intents_since(seq) if i["event"] == "snapshot"]
        self.assertEqual(sent["stage"], {"level": "quiet", "revision": 1})
        self.assertEqual(c1.check_message(sent), [])
        self.assertEqual(self.snapshot()["stage"], {"level": "quiet", "revision": 1})

    def test_bad_receipts_are_400_and_no_token_401(self):
        good = {"behavior_id": "b-1-1", "phase": "running", "reason": None, "at_ms": 1, "turn_generation": 0}
        for body in ({**good, "phase": "walking"}, {**good, "phase": "blocked", "reason": None},
                     {**good, "phase": "running", "reason": "connection_lost"}, {**good, "at_ms": "1"}, [good]):
            with self.subTest(body=body):
                self.assertEqual(self.request("POST", "/behavior/receipts", body), (400, {"error": "invalid_receipt"}))
        self.assertEqual(self.request("POST", "/behavior/receipts", good, token=None)[0], 401)

    def test_diag_behavior_block_before_anything_runs(self):
        state = self.request("GET", "/diag/state")[1]["behavior"]
        self.assertEqual({k: state[k] for k in ("running", "switches", "last_receipt")},
                         {"running": [], "switches": SWITCHES, "last_receipt": None})


class MotionLaneServerTest(ServerCase):
    """The motion lane in the T1 trace: what made her do what, each event pointing at its cause."""

    def setUp(self):
        super().setUp()
        from traces.trace_store import TraceStore
        db = Path(tempfile.mkdtemp()) / "trace.sqlite3"
        self.addCleanup(shutil.rmtree, db.parent)
        self.server.trace = TraceStore(open_store(db), producer_epoch=self.server.registry.epoch)

    def events(self, *kinds):
        rows = self.server.trace.db.execute("SELECT event FROM trace_events ORDER BY id").fetchall()
        return [e for e in map(lambda row: json.loads(row[0]), rows) if not kinds or e["kind"] in kinds]

    def test_a_refused_proposal_writes_behavior_refused(self):
        self.server.spatial.stage = lambda: "offstage"
        walk = spatial._spec("short_walk", None, "tick", None, 0, ("full_body",), ("user_drag",), 0.5, 60.0)
        self.assertEqual(self.server.spatial.offer(walk), (False, "stage"))
        [refused] = self.events("behavior.refused")
        self.assertEqual(refused["attrs"], {"behavior_type": "short_walk", "trigger_source": "tick",
                                            "trigger_event": None, "priority": 0, "channels": ["full_body"],
                                            "reason": "stage"})
        self.assertEqual((refused["causation_id"], self.server.trace_errors), (None, 0))

    def test_the_lane_s_events_are_stored_valid_from_the_user_s_signal_to_the_renderer_s_answer(self):
        from traces.trace_format import validate_stream
        self.server.user_now.coarse({"ts": time.time(), "idle_s": 0, "mic_active": True})
        self.server.spatial.use_motion(MotionChooser(PACK))
        self.server.spatial.motion_step()
        [loop] = [r["behavior"] for r in self.server.spatial.active.values()]
        self.server.spatial.motion({"kind": "clause", "intent": "explain"})
        self.server.spatial.motion_state({"behavior_id": loop["behavior_id"], "origin": "agent", "phase": "started",
                                          "resting": True, "busy": False, "clip": "base_loop"})
        self.server.spatial.motion_state({"behavior_id": None, "origin": "local", "phase": "started",
                                          "resting": False, "busy": True, "clip": "wave"})
        events = self.events()
        self.assertEqual(self.server.trace_errors, 0)
        self.assertEqual(validate_stream(events), [])
        self.assertEqual({e["kind"] for e in events},
                         {"signal.changed", "stage.changed", "motion.chosen", "behavior.dispatched", "motion.state"})
        stage = next(e for e in events if e["kind"] == "stage.changed")
        self.assertEqual(stage["attrs"], {"from": "normal", "to": "quiet", "revision": 1})

    def test_a_started_clip_is_traced_and_the_daily_brief_counts_it(self):
        from personal.brief_day import _traces
        self.server.spatial.use_motion(MotionChooser(PACK))
        self.server.spatial.motion_step()
        [loop] = [r["behavior"] for r in self.server.spatial.active.values()]
        started = {"behavior_id": loop["behavior_id"], "origin": "agent", "phase": "started", "resting": True,
                   "busy": False, "clip": "base_loop"}
        local = {"behavior_id": None, "origin": "local", "phase": "started", "resting": False, "busy": True,
                 "clip": "wave"}
        for body in (started, {**started, "phase": "cycle_end"}, local):
            self.assertEqual(self.request("POST", "/behavior/motion_state", body), (204, None))
        motions = self.events("motion.started")
        self.assertEqual([e["attrs"] for e in motions], [{"behavior_id": loop["behavior_id"], "clip": "base_loop"},
                                                         {"behavior_id": None, "clip": "wave"}])
        [dispatched] = [e for e in self.events("behavior.dispatched")
                        if e["attrs"]["behavior_id"] == loop["behavior_id"]]
        self.assertEqual((motions[0]["trace_id"], motions[0]["causation_id"]),
                         (dispatched["trace_id"], dispatched["event_id"]))
        self.assertEqual(self.server.trace_errors, 0)
        now = time.time()
        counted, _ = _traces(lambda query, params: self.server.trace.db.execute(query, params).fetchall(),
                             {"voice": False, "scr": False, "shot": False}, self.server.spatial,
                             now - 60, now - 60, now + 60, now + 60, lambda *_: None)
        self.assertEqual(dict(counted), {"base_loop": 1, "wave": 1})


class MotionStateServerTest(ServerCase):
    GOOD ={"behavior_id": "b-1-1", "origin": "agent", "phase": "cycle_end", "resting": True, "busy": False,
            "clip": "base_loop"}

    def test_a_motion_state_reaches_spatial_with_its_fields(self):
        local = {**self.GOOD, "behavior_id": None, "origin": "local", "phase": "ended"}
        user = {**local, "origin": "user", "phase": "started"}
        with unittest.mock.patch.object(self.server.spatial, "motion_state") as motion_state:
            self.assertEqual(self.request("POST", "/behavior/motion_state", self.GOOD), (204, None))
            self.assertEqual(self.request("POST", "/behavior/motion_state", local), (204, None))
            self.assertEqual(self.request("POST", "/behavior/motion_state", user), (204, None))
        self.assertEqual(motion_state.call_args_list,
                         [unittest.mock.call(self.GOOD), unittest.mock.call(local), unittest.mock.call(user)])

    def test_bad_bodies_are_400_and_other_tokens_401_and_reach_nothing(self):
        good = self.GOOD
        user = {**good, "behavior_id": None, "origin": "user", "phase": "started"}
        bad = [{**good, "phase": "running"}, {**good, "origin": "user"}, {**good, "behavior_id": None},
               {**user, "phase": "cycle_end"}, {**user, "behavior_id": "b-1-1"}, {**good, "origin": "remote"},
               {**good, "behavior_id": ""}, {**good, "behavior_id": "b" * 65}, {**good, "resting": 1},
               {**good, "busy": None}, {**good, "clip": ""}, {k: v for k, v in good.items() if k != "clip"},
               {**good, "extra": 1}, [good], "b-1-1"]
        with unittest.mock.patch.object(self.server.spatial, "motion_state") as motion_state:
            for body in bad:
                with self.subTest(body=body):
                    self.assertEqual(self.request("POST", "/behavior/motion_state", body),
                                     (400, {"error": "invalid_motion_state"}))
            for token in (None, HOOK, EVENTS):
                self.assertEqual(self.request("POST", "/behavior/motion_state", good, token=token)[0], 401)
        motion_state.assert_not_called()


if __name__ == "__main__":
    unittest.main()

class ConsumedServerTest(ServerCase):
    def test_a_terminal_on_the_quiet_stage_is_listed_in_every_snapshot_and_never_shown(self):
        stage = ["quiet"]
        self.server.spatial.stage = lambda: stage[0]
        registry = self.server.registry
        registry.set_quiet(True)
        now = time.time()
        registry.set_role_focus({"display_session": "role:r1", "state": "done", "priority": 7, "tool_name": None,
                                 "tool_category": None, "expires_at": now + 8, "run_id": "r1",
                                 "conversation_id": "c", "run_generation": 1, "phase": "completed",
                                 "outcome": "succeeded", "intent_override": "celebrate"}, generation=0)
        snapshot = self.snapshot()
        occurrence = snapshot["occurrence_id"]
        self.assertEqual(snapshot["consumed"], [occurrence])
        self.assertNotIn("outcome", snapshot)
        self.assertEqual(c1.check_message({**snapshot, "event": "snapshot"}), [])
        stage[0] = "normal"
        registry.set_quiet(False)
        self.assertNotIn("outcome", registry.intents[-1])
        again = self.snapshot()  # a renderer reconnect
        self.assertEqual((again["consumed"], again["occurrence_id"]), ([occurrence], occurrence))
        self.assertNotIn("outcome", again)
        self.assertEqual(c1.check_message({**again, "event": "snapshot"}), [])

    def test_a_quiet_stage_event_walks_her_to_the_edge(self):
        self.server.spatial._next_tick = time.time() + 10_000
        self.server.spatial.stage = lambda: "quiet"
        self.server.user_event({"revision": 1, "ts": time.time(), "name": "stage.quiet", "data": {}})
        self.server.spatial.poll()
        [walk] = self.snapshot()["behaviors"]
        self.assertEqual((walk["type"], walk["target"]), ("short_walk", EDGE))


class HostCapabilityTest(SpatialCase):
    def test_unavailable_behaviors_are_filtered_without_rejection_cooldown(self):
        self.spatial.set_capabilities('aster', {'sit@window': 'no window_top', 'climb_window_top': 'no climb',
                                                'short_walk': None})
        self.assertFalse(self.spatial._free(self.s, self.now, 'sit', window(101)))
        self.assertTrue(self.spatial._free(self.s, self.now, 'sit', None))
        self.assertTrue(self.spatial._free(self.s, self.now, 'short_walk', None))
        self.assertFalse(self.spatial._free(self.s, self.now, 'climb_window_top', window(101)))
        self.assertEqual(self.spatial.diag()['capability_character'], 'aster')

    def test_character_switch_and_positive_report_clear_stale_unsupported(self):
        self.spatial._unsupported['short_walk'] = self.now + 1800
        self.spatial.set_capabilities('aster', {'short_walk': None})
        self.assertEqual(self.spatial.diag()['unsupported'], {})
        self.spatial._unsupported['sit/read'] = self.now + 1800
        self.spatial.set_capabilities('aster', {'short_walk': None})
        self.assertIn('sit/read', self.spatial.diag()['unsupported'])
        self.spatial.set_capabilities('birch', {'short_walk': 'no gait'})
        self.assertFalse(self.spatial._free(self.s, self.now, 'short_walk', None))
        self.spatial.cancel_all('character_switch')
        self.assertIsNone(self.spatial.diag()['capabilities'])
        self.spatial.set_capabilities('aster', {'short_walk': None})
        self.assertTrue(self.spatial._free(self.s, self.now, 'short_walk', None))

    def test_session_event_path_obeys_capability_report(self):
        self.spatial.set_capabilities('birch', {'attend_session': 'no turn roots'})
        self.spatial._next_tick = self.now + 10000
        self.step(session='codex:B', state='awaiting_approval', related=['codex:B'], window_id=3101)
        self.assertNotIn('attend_session', [m['type'] for m in self.sent])
        self.spatial.set_capabilities('aster', {'attend_session': None})
        self.step()
        self.assertIn('attend_session', [m['type'] for m in self.sent])

class CapabilityServerTest(ServerCase):
    def test_loaded_character_report_auth_validation_and_scope(self):
        path = '/behavior/capabilities'
        body = {'character_id': self.server.character, 'capabilities': {'short_walk': None, 'sit@window': 'no window_top'}}
        self.assertEqual(self.request('PUT', path, body, token=HOOK)[0], 401)
        self.assertEqual(self.request('PUT', path, body)[0], 200)
        self.assertEqual(self.server.spatial.diag()['capabilities'], body['capabilities'])
        status, state = self.request('GET', '/diag/state')
        self.assertEqual(status, 200)
        self.assertEqual(state['behavior']['capabilities'], body['capabilities'])
        self.assertEqual(state['behavior']['capability_character'], self.server.character)
        self.assertEqual(self.request('PUT', path, {**body, 'character_id': 'old-character'})[0], 409)
        for caps in ({'short_walk': False}, {'unknown': None}, {'short_walk': ''}, {'short_walk': 'a' * 513}):
            self.assertEqual(self.request('PUT', path, {**body, 'capabilities': caps})[0], 400)

    def test_the_hosts_gaze_and_rest_keys_are_accepted(self):
        # ActorControls reports attend_session@user and sit/rest.
        body = {'character_id': self.server.character,
                'capabilities': {'attend_session@user': None, 'sit/rest': None, 'sit': None}}
        self.assertEqual(self.request('PUT', '/behavior/capabilities', body)[0], 200)
        self.assertEqual(self.server.spatial.diag()['capabilities'], body['capabilities'])


PACK = Path(__file__).resolve().parent / "fixtures" / "motion-chooser" / "demo"  # a runtime character directory


def role(state):
    """A role focus row in `state`, as the character agent sets it."""
    done = state == "done"
    return {"display_session": "role:r1", "state": state, "priority": 7 if done else 4, "tool_name": None,
            "tool_category": None, "expires_at": time.time() + 600, "run_id": "r1", "conversation_id": "c",
            "run_generation": 1, "phase": "completed" if done else "running",
            **({"outcome": "succeeded"} if done else {})}


class ChooserTest(SpatialCase):
    """Spatial owns the demo pack's chooser: each choice reaches the fake renderer as a perform through admit."""

    def setUp(self):
        super().setUp()
        self.spatial._next_tick = self.now + 10 ** 6  # no random tick
        self.stage = "normal"
        self.spatial.stage = lambda: self.stage
        self.registry.consumed = self.spatial.consumed
        self.registry.on_intent = self.spatial.motion_intent
        self.at = {}  # behavior_id -> clock time the fake renderer got it
        self.spatial.use_motion(MotionChooser(PACK))

    def flush(self):
        super().flush()
        for message in self.sent:
            self.at.setdefault(message["behavior_id"], self.now)

    def run_clock(self, seconds):
        """The motion clock's wakes over `seconds`."""
        for _ in range(round(seconds / spatial.MOTION_WAKE)):
            self.now += spatial.MOTION_WAKE
            self.spatial.motion_step()
            self.flush()

    def performs(self):
        return [m for m in self.sent if m["type"] == "perform"]

    def renewal(self, message):
        old = next((m for m in self.sent if m["behavior_id"] == message["replaces"]), None)
        return old is not None and old.get("loop") is True and old["clip"] == message["clip"]

    def chosen(self):
        """The performs but the renewals."""
        return [m for m in self.performs() if not self.renewal(m)]

    def test_a_character_starts_on_its_idle_loop_and_renews_it_before_its_ttl(self):
        self.run_clock(spatial.MOTION_WAKE)
        [loop] = self.performs()
        self.assertEqual({k: loop[k] for k in ("clip", "layer", "loop", "ttl_s", "channels", "priority")},
                         {"clip": {"id": "base_loop"}, "layer": "base", "loop": True, "ttl_s": spatial.LOOP_TTL,
                          "channels": ["full_body"], "priority": 0})
        self.run_clock(120)
        base = [m for m in self.performs() if m["layer"] == "base"]
        for a, b in zip(base, base[1:]):  # the base layer never lapses
            if a.get("loop"):
                self.assertLess(self.at[b["behavior_id"]] - self.at[a["behavior_id"]], a["ttl_s"], (a, b))
        self.assertLess(self.now - self.at[base[-1]["behavior_id"]], spatial.LOOP_TTL)
        renewals = [m for m in base if self.renewal(m)]
        self.assertTrue(renewals)
        for m in renewals:
            self.assertEqual(m["clip"], {"id": "base_loop"})
            self.assertLessEqual(self.at[m["behavior_id"]] - self.at[m["replaces"]],
                                 spatial.LOOP_TTL - spatial.LOOP_RENEW + spatial.MOTION_WAKE + 1e-6)
        self.assertValid()

    def test_a_new_chooser_s_first_loop_takes_up_the_phase_the_renderer_plays(self):
        self.run_clock(120)
        first, *rest = self.performs()
        self.assertEqual((first["clip"], first.get("start")), ({"id": "base_loop"}, "sync"))
        self.assertTrue(any(self.renewal(m) for m in rest))
        self.assertEqual([m for m in rest if "start" in m], [])
        self.spatial.use_motion(MotionChooser(PACK))
        self.sent.clear()
        self.run_clock(spatial.MOTION_WAKE)
        self.assertEqual(self.performs()[0].get("start"), "sync")
        self.assertValid()

    def test_chosen_clips_play_under_her_idle_and_gaze_and_give_way_to_walks(self):
        self.run_clock(spatial.MOTION_WAKE)
        [loop] = self.performs()
        with self.spatial._lock:  # her routine idle and a look at the user: neither owns the clip layer
            for kind, channels in (("idle", ("full_body",)), ("observe", spatial.EYES)):
                self.assertTrue(self.spatial._send(spatial._spec(kind, None, "tick", None, 0, channels, (), 0.5, 600.0),
                                                   self.s, self.now)[0], kind)
        self.flush()
        self.assertEqual(self.cancels(), [])
        self.assertIn(loop["behavior_id"], self.spatial.active)
        self.run_clock(120)
        self.assertNotIn("busy", self.spatial.diag()["refused"])
        with self.spatial._lock:  # a walk drives the whole body: the chosen loop ends, and none starts under it
            self.assertTrue(self.spatial._send(spatial._spec("short_walk", None, "tick", None, 0, ("full_body",), (),
                                                             0.5, 60.0), self.s, self.now)[0])
        self.flush()
        base = [r for r in self.spatial.active.values() if r["spec"].get("chosen") and r["spec"]["layer"] == "base"]
        self.assertEqual(base, [])
        self.run_clock(30)
        self.assertGreater(self.spatial.diag()["refused"].get("busy", 0), 0)
        self.assertValid()

    def test_idle_tier_picks_reach_the_renderer_at_the_choosers_times(self):
        reference, expected = MotionChooser(PACK), []
        for _ in range(round(59.9 * 60)):
            expected += reference.tick(1 / 60)
        self.assertGreaterEqual(len([c for c in expected if c["why"] == "idle.t1"]), 2)
        origin = self.now + spatial.MOTION_WAKE  # the first wake starts the chooser's frames
        self.run_clock(60)
        chosen = self.chosen()[1:]  # after the idle loop it starts on
        self.assertEqual([(m["clip"]["id"], m["trigger"]["event"]) for m in chosen],
                         [(c["clip"], c["why"]) for c in expected])
        for m, c in zip(chosen, expected):
            late = self.at[m["behavior_id"]] - (origin + c["t_s"])
            self.assertTrue(-1e-3 <= late <= spatial.MOTION_WAKE + 1e-3, (m, c, late))
            self.assertEqual((m["layer"], m["trigger"]["source"]), ("base", "tick"))
            self.assertEqual(m.get("loop", False), c["clip"] == "base_loop")
        self.assertValid()

    def test_a_focus_thinking_intent_is_the_session_clip_and_a_consumed_done_none(self):
        self.run_clock(1)
        self.registry.set_role_focus(role("thinking"), generation=self.generation)
        self.run_clock(spatial.MOTION_WAKE)
        think = self.performs()[-1]
        self.assertEqual((think["clip"], think["layer"], think["loop"], think["trigger"]),
                         ({"id": "think_loop"}, "base", True, {"source": "session", "event": "session.thinking"}))
        self.stage = "quiet"
        self.registry.set_role_focus(role("done"), generation=self.generation)
        self.assertNotIn("outcome", self.registry.intents[-1])  # consumed
        self.run_clock(3)
        self.assertNotIn({"id": "cheer"}, [m["clip"] for m in self.performs()])
        self.assertEqual(self.performs()[-1]["clip"], {"id": "base_loop"})
        self.assertValid()

    def test_a_shown_done_plays_its_terminal_clip(self):
        self.run_clock(1)
        self.registry.set_role_focus(role("thinking"), generation=self.generation)
        self.run_clock(1)
        self.registry.set_role_focus(role("done"), generation=self.generation)
        self.run_clock(1)
        done = self.performs()[-1]
        self.assertEqual((done["clip"], done["layer"], done.get("loop"), done["trigger"]["source"]),
                         ({"id": "cheer"}, "base", None, "session"))

    def test_a_clause_during_speech_is_an_overlay_chosen_in_the_same_call(self):
        self.run_clock(1)
        self.spatial.motion({"kind": "voice", "on": True})
        self.flush()
        self.spatial.motion({"kind": "clause", "intent": "explain"})
        [gesture] = [m for m in self.registry.intents_since(self.seen) if m["event"] == "behavior"]  # no clock between
        self.assertEqual({k: gesture.get(k) for k in ("clip", "layer", "loop", "channels")},
                         {"clip": {"id": "point"}, "layer": "overlay", "loop": None,
                          "channels": ["head", "left_hand", "right_hand"]})
        self.assertEqual(gesture["trigger"]["source"], "speech")
        self.assertValid()

    def test_offstage_keeps_only_the_rest_loop_and_the_playhead_on_the_playing_clip(self):
        self.stage = "offstage"
        chooser, reported = self.spatial.chooser, []
        report = chooser.report_playhead
        chooser.report_playhead = lambda clip, time_s: (reported.append((clip, time_s)), report(clip, time_s))
        self.run_clock(30)
        self.assertEqual({m["clip"]["id"] for m in self.performs()}, {"base_loop"})
        self.assertTrue(any(self.renewal(m) for m in self.performs()))
        refused = [c for c in chooser.choices if c["why"] == "idle.t1"]
        self.assertTrue(refused)
        self.assertGreaterEqual(self.spatial.diag()["refused"]["stage"], len(refused))
        self.assertEqual(len(reported), len(refused))
        for (clip, time_s), choice in zip(reported, refused):
            self.assertEqual(clip, "base_loop")
            self.assertAlmostEqual(time_s, choice["t_s"], delta=spatial.MOTION_WAKE + 0.02)
        self.assertEqual(chooser.playhead()[0], "base_loop")
        self.assertValid()

    def test_a_cycle_end_of_a_chosen_perform_reaches_report_playhead(self):
        self.run_clock(4)
        [loop] = self.performs()
        state = {"behavior_id": loop["behavior_id"], "origin": "agent", "phase": "cycle_end", "resting": True,
                 "busy": False, "clip": "base_loop"}
        with unittest.mock.patch.object(self.spatial.chooser, "report_playhead") as report:
            self.spatial.motion_state({**state, "behavior_id": "b-7-999"})  # not a chosen perform
            report.assert_not_called()
            self.spatial.motion_state(state)
        report.assert_called_once_with("base_loop", 4.0)

    USER = {"behavior_id": None, "origin": "user", "resting": False, "busy": True, "clip": "wave"}

    def user_play(self, phase):
        self.spatial.motion_state({**self.USER, "phase": phase})

    def base_performs(self):
        return [m for m in self.performs() if m["layer"] == "base"]

    def test_a_user_play_holds_her_base_clips_and_she_goes_on_from_her_rest_loop_after_it(self):
        self.run_clock(1)
        [loop] = self.performs()
        for end in ("ended", "expired", "rejected"):
            with self.subTest(end):
                self.receipt(self.base_performs()[-1]["behavior_id"], "cancelled", "user_play")
                self.user_play("started")
                self.sent.clear()
                self.run_clock(60)
                self.assertEqual(self.base_performs(), [])  # neither her loop again nor an idle tier
                self.spatial.motion({"kind": "voice", "on": True})
                self.spatial.motion({"kind": "clause", "intent": "explain"})
                self.spatial.motion({"kind": "voice", "on": False})
                self.flush()
                self.assertTrue(self.performs())
                self.assertEqual({m["layer"] for m in self.performs()}, {"overlay"})
                for m in self.performs():
                    self.receipt(m["behavior_id"], "completed")
                self.sent.clear()
                self.user_play(end)
                self.run_clock(spatial.MOTION_WAKE)
                self.assertEqual([m["clip"] for m in self.base_performs()], [{"id": "base_loop"}])
        self.assertValid()

    def test_a_base_clip_the_user_play_ended_is_not_tried_again_before_her_play_starts(self):
        self.run_clock(1)
        [loop] = self.performs()
        self.receipt(loop["behavior_id"], "cancelled", "user_play")
        self.run_clock(10)
        self.assertEqual(self.performs(), [loop])
        self.assertNotIn(loop["behavior_id"], self.spatial.active)
        self.user_play("started")
        self.run_clock(10)
        self.user_play("ended")
        self.run_clock(spatial.MOTION_WAKE)
        self.assertEqual([m["clip"] for m in self.performs()], [{"id": "base_loop"}] * 2)
        self.assertValid()

    def test_a_lost_renderer_ends_the_hold(self):
        self.run_clock(1)
        [loop] = self.performs()
        self.receipt(loop["behavior_id"], "cancelled", "user_play")
        self.user_play("started")
        with self.spatial._lock:
            self.assertTrue(self.spatial._send(spatial._spec("observe", None, "tick", None, 0, spatial.EYES, (), 0.5,
                                                             600.0), self.s, self.now)[0])
        self.flush()
        observe = self.sent[-1]["behavior_id"]
        self.run_clock(10)
        self.assertEqual(self.performs(), [loop])
        self.receipt(observe, "cancelled", "connection_lost")
        self.run_clock(spatial.MOTION_WAKE)
        self.assertEqual([m["clip"] for m in self.performs()], [{"id": "base_loop"}] * 2)
        self.assertValid()

    def test_a_character_switch_ends_the_hold(self):
        self.run_clock(1)
        [loop] = self.performs()
        self.receipt(loop["behavior_id"], "cancelled", "user_play")
        self.user_play("started")
        self.spatial.use_motion(MotionChooser(PACK))
        self.run_clock(1)
        self.assertEqual(len(self.performs()), 2)  # the new character's base loop goes out

    def test_her_sit_owns_the_body_and_the_chooser_stands_again_after_it(self):
        self.run_clock(1)
        [loop] = self.performs()
        sit = spatial._spec("sit", None, "tick", "routine:test", 0, ("full_body", "contact"), ("user_drag",), 0.3, 600.0)
        self.assertEqual(self.spatial.offer(sit), (True, None))
        self.flush()
        self.assertEqual(self.cancels(), [])  # the sit replaces the idle loop
        self.assertEqual(self.sent[-1]["replaces"], loop["behavior_id"])
        self.run_clock(20)
        self.assertEqual(self.performs(), [loop])  # the chooser plays its seat, the sit its own clips
        self.assertEqual(self.spatial.chooser.playhead()[0], "sit_loop")
        self.receipt(self.sent[-1]["behavior_id"], "completed")
        self.run_clock(1)
        self.assertEqual(self.performs()[-1]["clip"], {"id": "base_loop"})
        self.assertEqual(self.spatial.chooser.playhead()[0], "base_loop")
        self.run_clock(20)
        self.assertIn("idle.t1", [m["trigger"]["event"] for m in self.performs()])  # standing tiers again
        self.assertValid()

    def test_a_rejected_sit_leaves_the_loop_the_base_layer_plays(self):
        self.spatial.chooser.report_playhead("relax_loop", 0.0)  # a loop of hers other than the pack's overview
        self.run_clock(1)
        [loop] = self.performs()
        self.assertEqual(loop["clip"], {"id": "relax_loop"})
        self.unsupported = {"sit"}
        sit = spatial._spec("sit", None, "tick", "routine:tea", 0, spatial.POSTURE, ("user_drag",), 0.3, 600.0,
                            variant="tea")
        for stepped in (False, True):  # the rejection comes before the next motion step, or after it
            with self.subTest(stepped=stepped):
                self.assertEqual(self.spatial.offer(sit), (True, None))
                self.assertEqual(self.registry.intents[-1]["replaces"], loop["behavior_id"])
                if stepped:
                    self.spatial.motion_step()
                self.flush()
                self.assertEqual(self.receipts(self.sent[-1]["behavior_id"]), [("rejected", "unsupported")])
                self.run_clock(1)
                self.assertEqual(self.performs(), [loop])  # no restart of the loop the renderer still plays
                self.assertIn(loop["behavior_id"], self.spatial.active)
                self.assertEqual(self.spatial.chooser.playhead()[0], "relax_loop")
        self.assertValid()


class MotionLaneTest(SpatialCase):
    """The chooser's choices, what became of them and the renderer's motion_state on the motion lane."""
    run_clock, performs = ChooserTest.run_clock, ChooserTest.performs

    def flush(self):
        super().flush()
        for message in self.sent:
            self.at.setdefault(message["behavior_id"], self.now)

    def setUp(self):
        super().setUp()
        self.written = []
        self.lane = self.spatial.lane = MotionLane(self.emit)
        self.spatial._next_tick = self.now + 10 ** 6  # no random tick
        self.spatial.stage = lambda: "normal"
        self.registry.on_intent = self.spatial.motion_intent
        self.at = {}
        self.spatial.use_motion(MotionChooser(PACK))

    def emit(self, kind, trace_id, causation_id=None, attrs=None):
        self.written.append({"event_id": f"e-{len(self.written) + 1}", "kind": kind, "trace_id": trace_id,
                             "causation_id": causation_id, "attrs": attrs})
        return self.written[-1]["event_id"]

    def kinds(self, *kinds):
        return [e for e in self.written if e["kind"] in kinds]

    def state(self, behavior_id, origin, phase, clip):
        self.spatial.motion_state({"behavior_id": behavior_id, "origin": origin, "phase": phase, "resting": False,
                                   "busy": True, "clip": clip})

    def test_a_run_of_the_same_refusal_is_traced_once(self):
        refused = {"behavior_type": "perform", "trigger_source": "tick", "trigger_event": "idle", "priority": 0,
                   "channels": ["full_body"], "reason": "busy"}
        for _ in range(3):
            self.lane.write("behavior.refused", "t-1", None, refused)
        self.lane.write("signal.changed", "t-2", None, {"source": "coarse", "key": "typing", "value": True,
                                                         "revision": 1}, input=True)
        self.lane.write("behavior.refused", "t-1", None, refused)
        self.lane.write("behavior.refused", "t-1", None, {**refused, "reason": "stage"})
        self.assertEqual([e["attrs"].get("reason") for e in self.written],
                         ["busy", None, "busy", "stage"])

    def test_an_input_s_choice_its_perform_and_the_renderer_s_answer_are_one_chain(self):
        self.run_clock(1)
        UserNow(clock=lambda: self.now, lane=self.lane).coarse({"ts": self.now, "idle_s": 0})
        signal = self.kinds("signal.changed")[-1]
        self.spatial.motion({"kind": "voice", "on": True})
        self.spatial.motion({"kind": "clause", "intent": "explain"})
        self.flush()
        gesture = self.performs()[-1]
        [chosen] = [e for e in self.kinds("motion.chosen") if e["attrs"]["clip"] == "point"]
        self.assertEqual({k: chosen["attrs"][k] for k in ("why", "layer", "behavior_id")},
                         {"why": gesture["trigger"]["event"], "layer": "overlay",
                          "behavior_id": gesture["behavior_id"]})
        self.assertEqual((chosen["trace_id"], chosen["causation_id"]), (signal["trace_id"], signal["event_id"]))
        dispatched = self.kinds("behavior.dispatched")[-1]
        self.assertEqual((dispatched["attrs"], dispatched["trace_id"], dispatched["causation_id"]),
                         ({"behavior_id": gesture["behavior_id"], "behavior_type": "perform"}, signal["trace_id"],
                          chosen["event_id"]))
        self.assertEqual(gesture["trace_id"], signal["trace_id"])  # its receipts land in this trace
        self.state(gesture["behavior_id"], "agent", "started", "point")
        state = self.written[-1]
        self.assertEqual((state["kind"], state["trace_id"], state["causation_id"]),
                         ("motion.state", signal["trace_id"], dispatched["event_id"]))
        self.assertEqual(state["attrs"], {"origin": "agent", "phase": "started", "clip": "point",
                                          "behavior_id": gesture["behavior_id"]})
        self.assertEqual(self.lane.newest, (signal["trace_id"], signal["event_id"]))  # her own perform is no input

    def test_each_tick_of_her_own_starts_its_own_trace(self):
        self.run_clock(60)
        ticked = [e for e in self.kinds("motion.chosen") if e["attrs"]["why"] == "idle.t1"]
        self.assertGreaterEqual(len(ticked), 2)
        self.assertEqual({e["causation_id"] for e in ticked}, {None})
        self.assertEqual(len({e["trace_id"] for e in ticked}), len(ticked))

    def test_a_base_choice_during_the_user_s_play_is_refused_for_it(self):
        self.run_clock(1)
        [loop] = self.performs()
        self.receipt(loop["behavior_id"], "cancelled", "user_play")
        self.state(None, "user", "started", "wave")
        play = self.written[-1]
        self.assertEqual((play["kind"], play["causation_id"]), ("motion.state", None))
        self.assertEqual(self.lane.newest, (play["trace_id"], play["event_id"]))
        self.registry.set_role_focus(role("thinking"), generation=self.generation)
        self.run_clock(spatial.MOTION_WAKE)
        self.assertEqual(self.performs(), [loop])
        chosen, refused = self.written[-2:]
        self.assertEqual((chosen["kind"], chosen["attrs"]["clip"], chosen["attrs"]["layer"],
                          chosen["attrs"]["behavior_id"], chosen["causation_id"]),
                         ("motion.chosen", "think_loop", "base", None, play["event_id"]))
        self.assertEqual((refused["kind"], refused["attrs"]["reason"], refused["trace_id"], refused["causation_id"]),
                         ("behavior.refused", "user_play", play["trace_id"], chosen["event_id"]))


class RestartTest(SpatialCase):
    """agentd restarts while the renderer plays on; the next agentd keeps the state-dir file of the last."""
    run_clock, performs = ChooserTest.run_clock, ChooserTest.performs

    def flush(self):
        super().flush()
        for message in self.sent:
            self.at.setdefault(message["behavior_id"], self.now)

    def setUp(self):
        super().setUp()
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp)
        self.path = Path(tmp) / "spatial.json"
        self.stage, self.at = "normal", {}
        self.start(7)

    def start(self, epoch):
        """An agentd's Spatial on the demo pack and the file."""
        self.registry, self.seen, self.sent, self.log = Registry(epoch=epoch), 0, [], []
        self.spatial = Spatial(lambda: dict(self.s), self.registry.publish_event, lambda: self.generation, epoch,
                               clock=lambda: self.now, rng=self.rng, session_settle=0, session_min_hold=0,
                               recovery_delay=0)
        self.spatial._next_tick = self.now + 10 ** 6  # no random tick
        self.spatial.stage = lambda: self.stage
        self.spatial.use_motion(MotionChooser(PACK))
        self.spatial.keep(self.path)

    def restart(self, after):
        """A new agentd `after` seconds later; the fake renderer plays on."""
        self.now += after
        self.start(8)

    def test_a_restart_takes_up_the_loop_the_renderer_still_plays(self):
        self.spatial.chooser.report_playhead("relax_loop", 0.0)  # a loop of hers other than the pack's overview
        self.run_clock(4)
        self.assertEqual([m["clip"] for m in self.performs()], [{"id": "relax_loop"}])
        self.restart(3)
        self.run_clock(spatial.MOTION_WAKE)
        [first] = self.performs()
        self.assertEqual((first["clip"], first.get("start")), ({"id": "relax_loop"}, "sync"))
        self.assertValid()

    def test_a_restart_after_the_loop_s_ttl_starts_on_the_default_loop(self):
        self.spatial.chooser.report_playhead("relax_loop", 0.0)
        self.run_clock(4)
        self.restart(spatial.LOOP_TTL)  # the renderer has dropped the loop it got no renewal for
        self.run_clock(spatial.MOTION_WAKE)
        self.assertEqual(self.performs()[0]["clip"], {"id": "base_loop"})

    def test_the_stage_revision_keeps_growing_over_restarts(self):
        self.stage = "engaged"
        self.spatial.stage_event("stage.engaged")
        self.assertEqual(self.spatial.stage_level(), {"level": "engaged", "revision": 1})
        self.stage = "normal"  # the new agentd derives the stage again: a change
        self.restart(3)
        self.assertEqual(self.spatial.stage_level(), {"level": "normal", "revision": 2})
        self.restart(3)  # the same level: no change
        self.assertEqual(self.spatial.stage_level(), {"level": "normal", "revision": 2})
        self.stage = "quiet"
        self.spatial.stage_event("stage.quiet")
        self.assertEqual(self.spatial.stage_level(), {"level": "quiet", "revision": 3})


class ChooserServerTest(ServerCase):
    def test_a_character_with_a_motion_pack_starts(self):
        # the chooser's first snapshot reads the turn generation while the server is still being built
        with unittest.mock.patch.object(AgentdServer, "motion_chooser", lambda server, cid: MotionChooser(PACK)):
            server = AgentdServer(("127.0.0.1", 0), HOOK, UI)
        self.addCleanup(server.server_close)
        self.assertIsNotNone(server.spatial.chooser)

    def test_the_snapshot_carries_the_reaction_table_and_a_switch_sends_the_new_one(self):
        self.server.spatial.use_motion(MotionChooser(PACK))
        snapshot = self.snapshot()
        overlay = lambda *clips: [{"clip": c, "weight": 1, "layer": "overlay"} for c in clips]  # noqa: E731
        self.assertEqual(snapshot["reactions"], {"click": overlay("tap", "nod"), "pat": overlay("pat_react"),
                                                 "attention_left": overlay("look_left")})
        self.assertEqual(c1.check_message({**snapshot, "event": "snapshot"}), [])
        other = Path(tempfile.mkdtemp()) / "other"
        self.addCleanup(shutil.rmtree, other.parent)
        shutil.copytree(PACK, other)
        table = other / "c7" / "animation" / "intent-motion-map.json"
        table.write_text(table.read_text(encoding="utf-8").replace('[{"clip": "tap"}, {"clip": "nod"}]',
                                                                   '[{"clip": "wave"}]'), encoding="utf-8")
        self.server.motion_chooser = lambda cid: MotionChooser(other)
        seq = self.server.registry.intent_seq
        status, body = self.request("POST", "/character/prepare", {"id": "aster"})
        self.assertEqual(status, 200)
        self.assertEqual(self.request("POST", "/character/commit", {"switch_id": body["switch_id"]})[0], 200)
        [sent] = [i for i in self.server.registry.intents_since(seq) if i["event"] == "snapshot"]
        self.assertEqual(sent["reactions"]["click"], overlay("wave"))
        self.assertEqual(c1.check_message(sent), [])
        self.assertEqual(self.snapshot()["reactions"], sent["reactions"])


def overlay(*clips):
    return [{"clip": c, "weight": 1, "layer": "overlay"} for c in clips]


NO_OVERRIDES = {"chains": {}, "pools": {}, "blend_in": {}}


class MotionPrefsTest(SpatialCase):
    """The user's motion settings reach the chooser Spatial owns, and its reaction table follows them."""

    def setUp(self):
        super().setUp()
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root)
        self.spatial._next_tick = self.now + 10 ** 6  # no random tick
        self.spatial.stage = lambda: "normal"
        self.pack = prefs_pack(root)
        self.spatial.use_motion(MotionChooser(self.pack))
        self.flush()

    def snapshots(self, seq):
        return [i for i in self.registry.intents_since(seq) if i.get("event") == "snapshot"]

    def test_a_setting_that_turns_a_clip_off_publishes_the_table_without_it(self):
        before = self.spatial.reactions()
        self.assertEqual((before["click"], before["hover"]), (overlay("tap", "nod"), overlay("glance")))
        seq = self.registry.intent_seq
        reply = self.spatial.set_motion_prefs({"touch_tap": False}, {**NO_OVERRIDES, "blend_in": {"ghost": 1.0}})
        chooser = self.spatial.chooser
        self.assertEqual(reply, {"action_switches": {"switches": chooser.switches, "adjusted": []},
                                 "motion_overrides": {"applied": {"chains": 0, "pools": 0, "blend_in": 0},
                                                      "adjusted": [{"kind": "blend_in", "key": "ghost",
                                                                    "reason": "unknown_clip"}]}})
        self.assertFalse(chooser.switches["touch_tap"])
        [snapshot] = self.snapshots(seq)
        self.assertEqual(snapshot["reactions"], {**before, "click": overlay("nod")})
        self.assertEqual(self.spatial.reactions(), snapshot["reactions"])
        self.assertEqual(c1.check_message(snapshot), [])
        # The same table again publishes nothing.
        seq = self.registry.intent_seq
        self.spatial.set_motion_prefs({"touch_tap": False}, NO_OVERRIDES)
        self.assertEqual(self.snapshots(seq), [])

    def test_a_blend_in_override_is_the_perform_s_blend_s(self):
        self.spatial.set_motion_prefs({}, {**NO_OVERRIDES, "blend_in": {"wave": 1.5}})
        for _ in range(10):
            self.now += spatial.MOTION_WAKE
            self.spatial.motion_step()
            self.flush()
        self.spatial.motion({"kind": "event", "key": "user.greet"})
        self.flush()
        [wave] = [m for m in self.sent if m["type"] == "perform" and m["clip"] == {"id": "wave"}]
        self.assertEqual(wave["blend_s"], 1.5)
        self.assertValid()

    def test_without_a_chooser_nothing_is_stored(self):
        self.spatial.use_motion(None)
        self.assertIsNone(self.spatial.set_motion_prefs({}, NO_OVERRIDES))

    def test_the_bust_framing_switch_frames_this_chooser_and_the_next(self):
        self.spatial.set_switches({**SWITCHES, "bust_framing": True})
        self.assertEqual(self.spatial.chooser.framing, "bust")
        self.spatial.use_motion(MotionChooser(self.pack))
        self.assertEqual(self.spatial.chooser.framing, "bust")
        self.spatial.set_switches(SWITCHES)
        self.assertEqual(self.spatial.chooser.framing, "full")


class MotionPrefsServerTest(ServerCase):
    PATH = "/behavior/motion_prefs"
    EXAMPLE = Path(__file__).resolve().parents[3] / "protocol" / "C6-agentd-api" / "fixtures" / "behavior-motion-prefs.json"

    def setUp(self):
        super().setUp()
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root)
        self.pack = prefs_pack(root)
        self.server.spatial.use_motion(MotionChooser(self.pack))
        self.body = {**json.loads(self.EXAMPLE.read_text(encoding="utf-8")), "character_id": self.server.character}

    def test_the_route_stores_the_settings_for_the_committed_character_and_a_switch_clears_them(self):
        status, reply = self.request("PUT", self.PATH, self.body)
        self.assertEqual(status, 200, reply)
        chooser = self.server.spatial.chooser
        self.assertEqual(reply, {"character_id": self.server.character,
                                 "action_switches": {"switches": chooser.switches,
                                                     "adjusted": [{"id": "react_wave", "reason": "last_in_section"}]},
                                 "motion_overrides": {"applied": {"chains": 1, "pools": 1, "blend_in": 1},
                                                      "adjusted": []}})
        self.assertEqual((chooser.switches["touch_tap"], chooser.disabled_chains), (False, {"shrug"}))
        reactions = self.snapshot()["reactions"]
        self.assertEqual((reactions["click"], reactions["hover"]), (overlay("nod"), overlay("glance")))
        self.assertEqual(self.request("PUT", self.PATH, {**self.body, "character_id": "aster"}),
                         (409, {"error": "character_changed"}))
        self.server.motion_chooser = lambda cid: MotionChooser(self.pack)
        status, body = self.request("POST", "/character/prepare", {"id": "aster"})
        self.assertEqual(status, 200)
        self.assertEqual(self.request("POST", "/character/commit", {"switch_id": body["switch_id"]})[0], 200)
        chooser = self.server.spatial.chooser
        self.assertEqual((chooser.switches["touch_tap"], chooser.disabled_chains), (True, set()))
        self.assertEqual(self.snapshot()["reactions"]["click"], overlay("tap", "nod"))
        self.assertEqual(self.request("PUT", self.PATH, {**self.body, "character_id": "aster"})[0], 200)

    def test_bad_bodies_are_400_and_a_wrong_token_401(self):
        pools = lambda rows: {**NO_OVERRIDES, "pools": {"idle.t1": rows}}  # noqa: E731
        overrides = lambda **o: {**self.body, "motion_overrides": {**NO_OVERRIDES, **o}}  # noqa: E731
        bad = [None, [], {**self.body, "extra": 1}, {k: v for k, v in self.body.items() if k != "action_switches"},
               {**self.body, "character_id": ""}, {**self.body, "framing": "bust"},
               {**self.body, "action_switches": {"touch_tap": 0}},
               {**self.body, "action_switches": {f"row{n}": True for n in range(129)}},
               {**self.body, "motion_overrides": {"chains": {}, "pools": {}}},
               {**self.body, "motion_overrides": {**NO_OVERRIDES, "notes": {}}},
               overrides(chains={"a" * 129: False}), overrides(chains={"nod": 1}),
               overrides(blend_in={"wave": 2.5}), overrides(blend_in={"wave": True}),
               overrides(blend_in={"wave": float("nan")}),
               {**self.body, "motion_overrides": pools([])},
               {**self.body, "motion_overrides": pools([{"clip": "nod", "weight": 0}])},
               {**self.body, "motion_overrides": pools([{"clip": "nod", "weight": 1.5}])},
               {**self.body, "motion_overrides": pools([{"clip": "nod", "weight": True}])},
               {**self.body, "motion_overrides": pools([{"clip": "nod", "weight": 1}, {"clip": "nod", "weight": 2}])},
               {**self.body, "motion_overrides": pools([{"clip": "nod", "weight": 1, "x": 1}])}]
        for body in bad:
            with self.subTest(body=body):
                self.assertEqual(self.request("PUT", self.PATH, body), (400, {"error": "invalid_motion_prefs"}))
        self.assertEqual(self.request("PUT", self.PATH, self.body, token=EVENTS)[0], 401)
        self.assertEqual(self.server.spatial.chooser.switches["touch_tap"], True)

    def test_a_character_without_a_motion_pack_has_no_chooser_to_set(self):
        self.server.spatial.use_motion(None)
        self.assertEqual(self.request("PUT", self.PATH, self.body), (409, {"error": "no_motion"}))


LOCAL_CLIPS = {  # name -> (length, loop, stance start, stance end, its intent-motion-map row)
    "pat_start": (1.0, False, "stand", "stand", {"next": "pat_loop", "exit": "pat_end", "interruptible": True}),
    "pat_loop": (2.0, True, "stand", "stand", {"next": "pat_end", "exit": "pat_end", "interruptible": True}),
    "pat_end": (1.0, False, "stand", "stand", {}),
    "look_start": (0.5, False, "stand", "stand", {"next": "look_loop"}),
    "look_loop": (1.0, True, "stand", "stand", {"next": "look_end", "exit": "look_end", "hold_seconds": 3}),
    "look_end": (0.5, False, "stand", "stand", {}),
    "snap_start": (3.0, False, "stand", "stand", {"next": "snap_loop", "stroke_s": 2.45}),
    "snap_loop": (1.0, True, "stand", "stand", {"hold_policy": "while_requested", "exit": "snap_end"}),
    "snap_end": (1.5, False, "stand", "stand", {"stroke_s": 1.18}),
    "lift_start": (0.5, False, "stand", "stand", {"next": "lift_loop"}),
    "lift_loop": (1.0, True, "stand", "stand", {"exit": "lift_end"}),
    "lift_end": (0.5, False, "stand", "stand", {}),
    "land": (1.0, False, "stand", "stand", {}),
    "angry_start": (1.0, False, "stand", "stand", {"next": "angry_loop"}),
    "angry_loop": (1.0, True, "stand", "stand", {"next": "angry_end", "hold_seconds": 4}),
    "angry_end": (1.0, False, "stand", "stand", {}),
    "sit_nod": (1.0, False, "sit", "sit", {}),
    "sit_think": (2.0, True, "sit", "sit", {}),
    "sit_doze": (3.0, True, "sit", "sit", {}),
    "fly_start": (1.0, False, "stand", "air", {"next": "fly_loop"}),
    "fly_loop": (2.0, True, "air", "air", {"hold_policy": "while_requested"}),
}
LOCAL_EVENTS = {"pat.head": ["pat_start"], "look.left": ["look_start"], "present.snap": ["snap_start"],
                "click.head": ["nod"], "click.face": ["tap"], "click.repeat": ["shrug"], "pinch.annoyed": ["angry_start"],
                "drag.lift": ["lift_start"], "drag.land": ["land"], "character.enter": ["wave"],
                "session.thinking@sit": ["sit_think"], "rest.sleep@sit": ["sit_doze"]}


def local_pack(root, roles=None):
    """The demo pack in root with the pools the mac renderer used to draw from itself: held pat, look and present
    chains, region and repeated clicks, the annoyed pinch's chain with a timed loop, the lift and its landing, the
    entrance, a seated idle tier, a seated session pool, rest dozing and a `fly` activity that holds her in the air.
    roles: motion-bindings.json's lift_start / lift_end, None for none."""
    pack = Path(root) / "local"
    shutil.copytree(PACK, pack)

    def edit(name, change):
        path = pack / name
        doc = json.loads(path.read_text(encoding="utf-8"))
        change(doc)
        path.write_text(json.dumps(doc), encoding="utf-8")

    def motion_map(m):
        m["clips"].update({name: row[4] for name, row in LOCAL_CLIPS.items()})
        for key, clips in LOCAL_EVENTS.items():
            interrupt = "low" if key == "rest.sleep@sit" else "mid" if "@" in key or key == "character.enter" else "user"
            m["events"][key] = {"pool": [{"clip": c} for c in clips], "interrupt": interrupt}
        m["idle_tiers"].append({"after_s": [2, 3], "interval_s": [2, 3], "stance": "sit", "pool": [{"clip": "sit_nod"}]})
        m["activities"] = {"fly": {"*": ["fly_start"]}}
    edit("actor/manifest.json", lambda d: d["clips"].extend(
        {"name": n, "length": r[0], "loop": r[1]} for n, r in LOCAL_CLIPS.items()))
    edit("c7/animation/palette-contract.json", lambda d: d["clips"].extend(
        {"name": n, "loop": r[1]} for n, r in LOCAL_CLIPS.items()))
    edit("c7/animation/intent-motion-map.json", motion_map)
    edit("c7/interaction/motion-metadata.json", lambda d: d["clips"].update(
        {n: {"stance_start": r[2], "stance_end": r[3]} for n, r in LOCAL_CLIPS.items()}))
    if roles is not None:
        edit("c7/animation/motion-bindings.json", lambda d: d.update(roles=roles))
    return pack


class LocalMotionsTest(SpatialCase):
    """The motions the mac renderer used to choose itself, chosen by agentd: held reaction chains, the new triggers,
    the entrance, her seated clips within the sit, and an air activity that keeps her standing."""
    run_clock, performs = ChooserTest.run_clock, ChooserTest.performs

    def flush(self):
        super().flush()
        for message in self.sent:
            self.at.setdefault(message["behavior_id"], self.now)

    def setUp(self):
        super().setUp()
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root)
        self.spatial._next_tick = self.now + 10 ** 6  # no random tick
        self.stage, self.at = "normal", {}
        self.spatial.stage = lambda: self.stage
        self.pack = local_pack(self.root)

    def start(self, pack=None, enter=True):
        self.spatial.use_motion(MotionChooser(pack or self.pack))
        self.flush()
        if not enter:
            self.spatial._enter = False  # no entrance spends the budget's start
            self.run_clock(1)

    def within(self):
        return [m for m in self.performs() if "within" in m]

    def sit(self, variant=None):
        spec = spatial._spec("sit", None, "tick", "routine:test", 0, spatial.POSTURE, ("user_drag",), 0.3, 600.0,
                             variant=variant)
        answer = self.spatial.offer(spec)
        self.flush()
        return answer

    def test_the_table_holds_the_chains_of_pat_look_present_and_the_lift_times_the_others_and_names_the_new_triggers(
            self):
        self.start()
        entry = lambda clip, layer="overlay", **more: {"clip": clip, "weight": 1, "layer": layer, **more}  # noqa: E731
        self.assertEqual(self.spatial.reactions(), {
            "click": [entry("tap"), entry("nod")],
            "pat": [entry("pat_start", chain=["pat_loop", "pat_end"], hold="pat_loop")],
            "attention_left": [entry("look_start", chain=["look_loop", "look_end"], hold="look_loop")],
            "present": [entry("snap_start", chain=["snap_loop", "snap_end"], hold="snap_loop",
                              stroke_s={"snap_start": 2.45, "snap_end": 1.18})],
            "drag_lift": [entry("lift_start", "base", chain=["lift_loop", "lift_end"], hold="lift_loop")],
            "drop": [entry("land", "base")],
            "click_head": [entry("nod")], "click_cheek": [entry("tap")], "click_repeat": [entry("shrug")],
            "pinch_annoyed": [entry("angry_start", chain=["angry_loop", "angry_end"], hold_s={"angry_loop": 4})]})
        snapshot = next(m for m in reversed(self.log) if m["event"] == "snapshot")
        self.assertEqual(c1.check_message(snapshot), [])
        self.spatial.set_motion_prefs({}, {**NO_OVERRIDES, "pools": {"click.head": [{"clip": "tap", "weight": 2}]}})
        self.assertEqual(self.spatial.reactions()["click_head"], [{"clip": "tap", "weight": 2, "layer": "overlay"}])

    def test_with_lift_roles_the_lift_holds_their_chain_and_the_drop_plays_nothing_more(self):
        self.start(local_pack(Path(self.root) / "roles", {"lift_start": "pat_start", "lift_end": "land"}))
        table = self.spatial.reactions()
        self.assertEqual(table["drag_lift"], [{"clip": "pat_start", "weight": 1, "layer": "base",
                                               "chain": ["pat_loop", "land"], "hold": "pat_loop"}])
        self.assertNotIn("drop", table)

    def test_she_enters_on_launch_and_after_a_switch_but_not_after_a_quick_restart(self):
        self.start()
        self.run_clock(spatial.MOTION_WAKE)
        first = self.performs()[0]
        self.assertEqual((first["clip"], first["layer"], first["trigger"]["event"]),
                         ({"id": "wave"}, "base", "character.enter"))
        self.run_clock(10)
        self.assertEqual([m["clip"]["id"] for m in self.performs()].count("wave"), 1)
        self.start()  # a character switch commits
        self.run_clock(spatial.MOTION_WAKE)
        self.assertEqual(self.performs()[-1]["trigger"]["event"], "character.enter")
        self.stage = "quiet"
        self.start()
        count = len(self.performs())
        self.run_clock(1)
        self.assertNotIn("character.enter", [m["trigger"]["event"] for m in self.performs()[count:]])
        self.stage = "normal"
        path = Path(self.root) / "spatial.json"
        self.start()
        self.spatial.keep(path)
        self.run_clock(4)  # the loop after the entrance is kept for the next agentd
        self.start()
        self.spatial.keep(path)  # a quick restart: the renderer still plays that loop
        count = len(self.performs())
        self.run_clock(1)
        self.assertNotIn("character.enter", [m["trigger"]["event"] for m in self.performs()[count:]])
        self.assertValid()

    def entrances(self):
        return [m for m in self.performs() if m["trigger"]["event"] == "character.enter"]

    def test_her_entrance_waits_for_a_stage_she_shows_on(self):
        self.stage = "quiet"
        self.start()
        self.run_clock(2)
        self.assertEqual(self.entrances(), [])
        self.stage = "normal"
        self.run_clock(spatial.MOTION_WAKE)
        self.assertEqual([m["clip"]["id"] for m in self.entrances()], ["wave"])
        self.assertValid()

    def test_her_entrance_waits_for_her_to_stand(self):
        self.start()
        self.assertEqual(self.sit(), (True, None))
        sit = self.sent[-1]
        self.run_clock(2)
        self.assertEqual(self.entrances(), [])
        self.receipt(sit["behavior_id"], "completed")
        self.run_clock(spatial.MOTION_WAKE)
        self.assertEqual([m["clip"]["id"] for m in self.entrances()], ["wave"])
        self.assertValid()

    def test_a_switch_while_her_entrance_waits_leaves_one_entrance(self):
        self.stage = "quiet"
        self.start()
        self.run_clock(1)
        self.start()  # a character switch commits while the stage is still quiet
        self.run_clock(1)
        self.stage = "normal"
        self.run_clock(4)
        self.assertEqual(len(self.entrances()), 1)
        self.assertValid()

    def test_her_seated_tier_clip_plays_within_the_sit_under_the_seated_budget(self):
        self.start(enter=False)
        self.assertEqual(self.sit(), (True, None))
        sit = self.sent[-1]
        self.run_clock(59)
        self.assertEqual([(m["clip"]["id"], m["within"], m["layer"], m["trigger"]["event"]) for m in self.within()],
                         [("sit_nod", sit["behavior_id"], "base", "idle.t2 seat tierPick")])  # one a minute
        self.assertIn(sit["behavior_id"], self.spatial.active)
        self.assertNotIn(sit["behavior_id"], [c[0] for c in self.cancels()])
        self.assertValid()

    def test_a_session_plays_its_seated_pool_within_the_sit(self):
        self.start(enter=False)
        self.sit()
        sit = self.sent[-1]
        self.run_clock(2)
        self.spatial.motion_intent({"intent": "think", "state": "thinking", "activity": None, "mood": None,
                                    "display_session": "claude:A"}, False)
        self.run_clock(14)
        [think] = [m for m in self.within() if m["clip"] == {"id": "sit_think"}]
        self.assertEqual((think["within"], think["loop"], think["trigger"]), (
            sit["behavior_id"], True, {"source": "session", "event": "session.thinking@sit seat posturePick"}))
        self.assertIn((think["behavior_id"], "expired", None), self.cancels())  # back to the sit's own loop
        self.assertIn(sit["behavior_id"], self.spatial.active)
        self.assertValid()

    def test_a_rest_sit_dozes_within_itself(self):
        self.start(enter=False)
        self.sit("rest")
        sit = self.sent[-1]
        self.run_clock(8)
        self.assertEqual([(m["clip"]["id"], m["within"]) for m in self.within()][:1],
                         [("sit_doze", sit["behavior_id"])])

    def test_a_sit_that_ends_before_the_next_step_has_nothing_played_within_it(self):
        self.start(enter=False)
        self.sit("rest")
        sit = self.sent[-1]
        self.run_clock(1)
        self.receipt(sit["behavior_id"], "completed")
        for _ in range(10):  # the quiet stage reaches the chooser before the motion clock's next step
            self.now += 1
            self.spatial.motion({"kind": "quiet"})
            self.flush()
        self.assertEqual(self.within(), [])
        self.assertValid()

    def test_a_sit_plays_nothing_within_it_until_she_is_seated(self):
        def edit(name, change):
            path = self.pack / name
            doc = json.loads(path.read_text(encoding="utf-8"))
            change(doc)
            path.write_text(json.dumps(doc), encoding="utf-8")
        edit("actor/manifest.json", lambda d: d["clips"].append({"name": "think_end", "length": 1.0, "loop": False}))
        edit("c7/animation/palette-contract.json", lambda d: d["clips"].append({"name": "think_end", "loop": False}))
        edit("c7/animation/intent-motion-map.json", lambda d: d["clips"].update(
            think_loop={"hold_policy": "while_requested", "interruptible": False, "exit": "think_end"},
            think_end={"interruptible": True}))
        edit("c7/interaction/motion-metadata.json", lambda d: d["clips"].update(
            think_end={"stance_start": "stand", "stance_end": "stand"}))
        self.start(enter=False)
        self.spatial.motion_intent({"intent": "think", "state": "thinking", "activity": None, "mood": None,
                                    "display_session": "claude:A"}, False)
        self.run_clock(3)
        self.assertEqual(self.performs()[-1]["clip"], {"id": "think_loop"})
        self.sit()
        sit = self.sent[-1]
        self.run_clock(14)  # her think loop plays out its exit, then the sit's enter clip
        self.assertEqual(self.within(), [])
        self.spatial.motion_intent({"intent": "think", "state": "thinking", "activity": None, "mood": None,
                                    "display_session": "claude:A"}, False)
        self.run_clock(14)
        self.assertEqual([(m["clip"]["id"], m["within"]) for m in self.within()][:1],
                         [("sit_think", sit["behavior_id"])])
        self.assertValid()

    def test_a_rest_sit_that_replaces_her_sit_dozes_and_a_sit_that_replaces_it_does_not(self):
        self.start(enter=False)
        self.sit()
        self.run_clock(2)
        self.assertEqual(self.sit("rest"), (True, None))
        rest = self.sent[-1]
        self.run_clock(8)
        self.assertIn(("sit_doze", rest["behavior_id"]), [(m["clip"]["id"], m["within"]) for m in self.within()])
        self.assertEqual(self.sit(), (True, None))
        count = len(self.within())
        self.run_clock(8)
        self.assertNotIn("sit_doze", [m["clip"]["id"] for m in self.within()[count:]])
        self.assertValid()

    def test_an_air_activity_stands_her_up_and_keeps_her_from_sitting(self):
        self.start(enter=False)
        self.sit()
        sit = self.sent[-1]
        self.run_clock(2)
        self.spatial.motion({"kind": "intent", "intent": "idle", "state": None, "activity": "fly", "mood": None,
                             "display_session": None})
        self.run_clock(spatial.MOTION_WAKE)
        self.assertIn((sit["behavior_id"], "expired", None), self.cancels())
        self.run_clock(2)
        self.assertIn({"id": "fly_start"}, [m["clip"] for m in self.performs()])
        self.assertEqual(self.sit(), (False, "lifted"))
        self.assertValid()
