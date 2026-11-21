import datetime
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from observation.attention import AttentionStore  # noqa: E402
from observation.blacklist import Blacklist  # noqa: E402
from support import deny_blacklist  # noqa: E402
from sessions.events import normalize_claude  # noqa: E402
from brain.persona import PROMPT_USER  # noqa: E402
from character.gate import Gate  # noqa: E402
from character.judge import Judge  # noqa: E402
from character.proactive import ALERT_EVERY, DWELL, RESPONSE_WINDOW, Proactive  # noqa: E402
from sessions.registry import Registry  # noqa: E402
from observation.user_state import MODE_NAMES  # noqa: E402
import test_server  # noqa: E402
import test_turn  # noqa: E402

T0 = 1792300000.0
CODE = {"app": "Code", "bundle_id": "com.microsoft.VSCode", "pid": 11, "window_id": 2, "title": "SECRET-TITLE"}
SAFARI = {"app": "Safari", "bundle_id": "com.apple.Safari", "pid": 10, "window_id": 1, "title": "新闻"}
WECHAT = {"app": "WeChat", "bundle_id": "com.tencent.xinWeChat", "pid": 12, "window_id": 3, "title": "聊天"}
DIALOG = {"role": "AXWindow", "subrole": "AXDialog"}


def beat(ts, front, **extra):
    return {"ts": ts, "front": front, "mouse": None, "idle_s": 0.0, "locked": False, "asleep": False,
            "focus_role": None, "secure_input": False, **extra}


def claude(name, ts, session="A", cwd="/a", **extra):
    return normalize_claude({"hook_event_name": name, "session_id": session, "cwd": cwd, **extra}, now=ts)


class WantBackend:
    name = "fake"

    def __init__(self, want=True):
        self.want, self.states, self.asked = want, [], []
        self.values = {}  # question id -> its answer instead of want
        self.on_ask = None  # runs while the judge thinks

    def answer(self, state, questions):
        self.states.append(state)
        self.asked.append([q["id"] for q in questions])
        if self.on_ask is not None:
            self.on_ask()
        return [{"id": q["id"], "value": self.values.get(q["id"], self.want), "prob": 0.9} for q in questions]


class ProactiveTest(unittest.TestCase):
    def test_companion_off_dwell_calls_no_judge_and_sends_no_nudge(self):
        self.gate = self.p.gate = Gate(enabled=True, quiet=(0, 0))
        self.gate.set_companion(False)
        self.run_for(DWELL + 65, CODE)
        self.assertEqual(self.backend.states, [])
        self.assertEqual(self.nudges("comment"), [])
        self.assertEqual(self.lines, [])
        self.assertIsNone(self.p._asked)

    def test_proactive_speech_alone_turns_comments_on(self):
        self.gate = self.p.gate = Gate(enabled=True, quiet=(0, 0))
        self.run_for(DWELL + 1, CODE)
        self.assertEqual(len(self.backend.states), 1)
        self.assertEqual(len(self.lines), 1)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.addCleanup(self.tmp.cleanup)
        self.now = T0
        self.store = AttentionStore(Path(self.tmp.name) / "attention.sqlite",
                                    Blacklist(deny_blacklist(Path(self.tmp.name) / "blacklist.json")), clock=lambda: self.now)
        self.addCleanup(self.store.close)
        self.gate = Gate(enabled=True, quiet=(0, 0))
        self.gate.set_companion(True)
        self.backend, self.published, self.lines, self.busy = WantBackend(), [], [], False
        self.materials = []
        self.p = Proactive(self.store, self.gate, lambda event, data: self.published.append((event, data)),
                           self.start, lambda: self.busy,
                           judge=Judge(self.backend), clock=lambda: self.now, spawn=lambda f: f())

    def start(self, line_id, text, reason=None, material=None):
        """start_line, voiced at once; its material goes to self.materials."""
        self.lines.append((line_id, text))
        self.materials.append(material)
        self.voice(line_id)

    def voice(self, line_id):
        """What the server does when a proactive line's first clause is voiced."""
        self.gate.commit("comment", datetime.datetime.fromtimestamp(self.now))
        self.p.voiced(line_id)

    def run_for(self, seconds, front, **extra):
        end = self.now + seconds
        while self.now < end:
            self.now += 1.0
            body = beat(self.now, front, **extra)
            self.store.ingest(body)
            self.p.beat(body)

    def nudges(self, kind):
        return [data for event, data in self.published if event == "nudge" and data["kind"] == kind]

    def test_dialog_windows_raise_one_alert_per_window_per_ten_minutes(self):
        cases = [({"role": "AXSheet", "subrole": None}, True), (DIALOG, True),
                 ({"role": "AXWindow", "subrole": "AXSystemDialog"}, True),
                 ({"role": "AXWindow", "subrole": "AXStandardWindow"}, False), (None, False)]
        for window, expected in cases:
            with self.subTest(window=window):
                self.published, self.p = [], Proactive(self.store, self.gate, lambda e, d: self.published.append((e, d)),
                                                       None, lambda: False, clock=lambda: self.now)
                self.run_for(1, CODE, focus_window=window)
                self.assertEqual(len(self.nudges("alert")), int(expected))
        self.published = []
        self.run_for(ALERT_EVERY - 2, CODE, focus_window=DIALOG)  # still the same dialog: no second alert
        self.run_for(1, SAFARI, focus_window=DIALOG)  # another window: its own alert
        self.run_for(2, CODE, focus_window=DIALOG)  # ten minutes after the first: again
        self.assertEqual([n["target"] for n in self.nudges("alert")], [2, 1, 2])
        for n in self.nudges("alert"):
            self.assertEqual({k: n[k] for k in ("level", "line_id", "speak", "gate")},
                             {"level": "P2", "line_id": None, "speak": False, "gate": None})
            self.assertRegex(n["nudge_id"], r"^[0-9a-f]{12}$")
        self.assertEqual(self.gate._count, 0)  # alerts never use the gate's daily count

    def test_no_alert_for_a_blacklisted_window(self):
        self.run_for(1, WECHAT, focus_window=DIALOG)
        self.run_for(1, {"app": "<hidden>"}, focus_window=DIALOG)
        self.assertEqual(self.nudges("alert"), [])

    def test_one_judge_question_per_dwell_of_three_minutes(self):
        self.backend.want = False
        self.run_for(DWELL - 2, CODE)
        self.assertEqual(self.backend.states, [])
        self.run_for(3, CODE)
        self.assertEqual(len(self.backend.states), 1)
        self.run_for(300, CODE)  # the same dwell: not asked again
        self.assertEqual(len(self.backend.states), 1)
        self.run_for(DWELL + 1, SAFARI)
        self.assertEqual(len(self.backend.states), 2)
        self.assertEqual(self.published, [])  # the judge said no: no nudge at all
        self.assertEqual(set(self.backend.states[0]), {"category", "dwell_min", "hour", "activity", "actions", "idle_s"})
        self.assertNotIn("SECRET-TITLE", json.dumps(self.backend.states, ensure_ascii=False))

    def test_the_judge_gets_the_kinds_of_the_actions_in_the_window_and_no_target(self):
        start, asked = self.now, []
        self.with_scene(now={"app": "Code", "since": start, "actions": [
            {"app": "Safari", "ts": start - 5, "kind": "click", "target": 'link "SECRET-LINK"'},
            {"app": "Code", "ts": start - 3, "kind": "shortcut", "target": None},  # another Code window
            {"app": "Code", "ts": start + 2, "kind": "click", "target": 'button "SECRET-RUN"'},
            {"app": "Code", "ts": start + 4, "kind": "text_input", "target": 'text field "SECRET-FIELD"'}]})
        self.backend.on_ask = lambda: asked.append(self.now)
        self.run_for(DWELL + 1, CODE)
        [state] = self.backend.states
        self.assertEqual((state["actions"], state["idle_s"]), (["click", "text_input"], round(asked[0] - start - 4)))
        self.assertNotIn("SECRET", json.dumps(state))

    def test_no_judge_for_a_blacklisted_window(self):
        self.run_for(DWELL + 5, WECHAT)
        self.assertEqual(self.backend.states, [])

    def test_admitted_comment_starts_a_line(self):
        self.run_for(DWELL + 1, CODE)
        [nudge] = self.nudges("comment")
        self.assertEqual({k: nudge[k] for k in ("level", "target", "speak", "gate")},
                         {"level": "P2", "target": 2, "speak": True, "gate": None})
        [(line_id, text)] = self.lines
        self.assertEqual(nudge["line_id"], line_id)
        self.assertNotIn("SECRET-TITLE", text)

    def test_declared_category_reaches_comment_judge_and_prompt(self):
        front = {**CODE, "bundle_id": "x.editor", "category": "public.app-category.developer-tools"}
        self.run_for(DWELL + 1, front)
        self.assertEqual(self.backend.states[0]["category"], "coding")
        self.assertIn("activity: coding", self.lines[0][1])
        self.gate._last, self.gate._last_any = {}, None  # category routing, outside speech cooldown
        self.run_for(DWELL + 1, front, mouse={**SAFARI, "bundle_id": "x.other"}, idle_s=5.0)
        self.assertEqual(self.backend.states[-1]["category"], "other")

    def test_gate_or_busy_mouth_keeps_the_comment_silent(self):
        for setup, reason in ((lambda: setattr(self.gate, "enabled", False), "disabled"),
                              (lambda: setattr(self, "busy", True), "busy")):
            with self.subTest(reason=reason):
                self.gate, self.busy, self.published = Gate(enabled=True, quiet=(0, 0)), False, []
                self.gate.set_companion(True)
                self.p.gate = self.gate
                setup()
                self.run_for(DWELL + 1, CODE if reason == "disabled" else SAFARI)
                [nudge] = self.nudges("comment")
                self.assertEqual({k: nudge[k] for k in ("speak", "line_id", "gate")},
                                 {"speak": False, "line_id": None, "gate": reason})
                self.assertEqual(self.gate._count, 0)
        self.assertEqual(self.lines, [])

    def test_local_holds_spend_no_judge_calls_and_resume_on_the_same_focus(self):
        cases = ("disabled", "meeting", "fullscreen", "quiet_hours", "daily_limit", "same_cooldown",
                 "cross_cooldown", "busy", "cannot_interrupt", "same_subject")
        for reason in cases:
            with self.subTest(reason=reason):
                self.setUp()
                now = datetime.datetime.fromtimestamp(self.now)
                self.p.activity = lambda: {"activity": "reading", "can_interrupt": True,
                    "subject": "page", "focus_id": "focus", "evidence": [], "related_session_ids": [], "now": None}
                if reason == "disabled": self.gate.enabled = False
                elif reason == "meeting": self.gate.meeting = True
                elif reason == "fullscreen": self.gate.fullscreen = True
                elif reason == "quiet_hours": self.gate.quiet = (0, 24)
                elif reason == "daily_limit": self.gate.daily_limit = 0
                elif reason == "same_cooldown": self.gate.commit("comment", now)
                elif reason == "cross_cooldown":
                    self.gate.cross_cooldown = 600
                    self.gate.commit("other", now)
                elif reason == "busy": self.busy = True
                elif reason == "cannot_interrupt":
                    previous = self.p.activity
                    self.p.activity = lambda previous=previous: {**previous(), "can_interrupt": False}
                elif reason == "same_subject": self.p._subjects.append("page")
                self.run_for(DWELL + 5, CODE)
                self.assertEqual(self.backend.states, [])
                self.assertEqual(len(self.nudges("comment")), 1, "do not emit a skipped nudge every heartbeat")
                self.gate.enabled = True
                self.gate.meeting = self.gate.fullscreen = self.busy = False
                self.gate.quiet, self.gate.daily_limit = (0, 0), 20
                self.gate._last, self.gate._last_any = {}, None
                self.p._subjects.clear()
                self.p.activity = lambda: {"activity": "reading", "can_interrupt": True,
                    "subject": "page", "focus_id": "focus", "evidence": [], "related_session_ids": [], "now": None}
                self.run_for(2, CODE)
                self.assertEqual(len(self.backend.states), 1, "opening the gate retries without changing focus")
                self.assertEqual(len(self.lines), 1)

    def test_explicit_comment_feedback_links_to_its_judge_without_training_on_silence(self):
        from unittest.mock import Mock
        self.p.judge.feedback = Mock()
        self.run_for(DWELL + 1, CODE)
        line_id = self.lines[0][0]
        self.p.feedback(line_id, "useful")
        self.p.judge.feedback.assert_called_once()
        args = self.p.judge.feedback.call_args
        self.assertEqual(args.args[1], "useful")
        self.assertEqual(args.kwargs, {"source": "user"})
        self.assertRegex(args.args[0], r"^[0-9a-f]{16}$")
        self.p.feedback(line_id, "useful")
        self.p.feedback(line_id, "dont_disturb")
        self.p.feedback("not-a-comment", "dont_disturb")
        self.assertEqual(self.p.judge.feedback.call_count, 1)
        self.now += RESPONSE_WINDOW + 1
        self.p.beat(beat(self.now, CODE))
        self.assertEqual(self.p.judge.feedback.call_count, 1, "no answer is not an explicit label")

    def test_reset_drops_comment_feedback_links(self):
        from unittest.mock import Mock
        self.p.judge.feedback = Mock()
        self.run_for(DWELL + 1, CODE)
        line_id = self.lines[0][0]
        self.p.reset_feedback()
        self.p.feedback(line_id, "useful")
        self.p.judge.feedback.assert_not_called()

    def test_queued_comment_rechecks_hold_and_retries_without_changing_focus(self):
        queued = []
        self.p.spawn = queued.append
        self.run_for(DWELL + 1, CODE)
        self.assertEqual(len(queued), 1)
        self.gate.meeting = True
        queued.pop()()
        self.assertEqual(self.backend.states, [])
        self.gate.meeting = False
        self.run_for(1, CODE)
        queued.pop()()
        self.assertEqual(len(self.backend.states), 1)
        self.assertEqual(len(self.lines), 1)

    def test_hourly_judge_calls_and_lines(self):
        # An hour that switches window as soon as each dwell is judged, with a judge that always says yes.
        for i in range(int(3600 / (DWELL + 1))):
            self.run_for(DWELL + 1, {**CODE, "window_id": 100 + i})
        calls = len(self.backend.states)
        self.assertLessEqual(calls, 3600 / DWELL)
        self.assertLessEqual(len(self.lines), 3600 / self.gate.same_cooldown + 1)  # the gate bounds the lines

    def with_scene(self, **scene):
        """Rebuild the proactive with an activity source that answers self.scene."""
        self.scene = {"activity": "editing_code", "subject": "orbit-ledger", "focus_id": "focus:1",
                      "can_interrupt": True, "now": None, **scene}
        self.p = Proactive(self.store, self.gate, lambda event, data: self.published.append((event, data)),
                           self.start, lambda: self.busy,
                           judge=Judge(self.backend), clock=lambda: self.now, spawn=lambda f: f(),
                           activity=lambda: dict(self.scene))

    def silent(self, nudge):
        return {k: nudge[k] for k in ("speak", "line_id", "gate")}

    def test_a_focus_change_while_the_judge_thinks_drops_the_comment(self):
        self.with_scene()
        self.backend.on_ask = lambda: self.store.ingest(beat(self.now + 0.5, SAFARI))
        self.run_for(DWELL + 1, CODE)
        [nudge] = self.nudges("comment")
        self.assertEqual(self.silent(nudge), {"speak": False, "line_id": None, "gate": "focus_changed"})
        self.assertEqual(self.lines, [])
        # Control: the run is still the one asked about when the judge answers.
        self.backend.on_ask, self.published = None, []
        self.run_for(DWELL + 1, CODE)
        [nudge] = self.nudges("comment")
        self.assertEqual(self.silent(nudge)["gate"], None)
        self.assertEqual([line_id for line_id, _ in self.lines], [nudge["line_id"]])
        self.assertEqual(self.backend.states[-1]["activity"], "editing_code")

    def test_the_user_starting_to_speak_while_the_judge_thinks_drops_the_comment(self):
        self.with_scene()
        decided = []
        self.gate.on_decision = lambda *args: decided.append(args)
        self.backend.on_ask = lambda: setattr(self.gate, "user_speaking", True)
        self.run_for(DWELL + 1, CODE)
        [nudge] = self.nudges("comment")
        self.assertEqual(self.silent(nudge), {"speak": False, "line_id": None, "gate": "user_speaking"})
        self.assertEqual((self.lines, decided), ([], []))  # decided before the gate is asked

    def test_an_activity_that_may_not_be_interrupted_keeps_the_comment_silent(self):
        self.with_scene(activity="typing", subject="Notes", can_interrupt=False)
        self.run_for(DWELL + 1, CODE)
        [nudge] = self.nudges("comment")
        self.assertEqual(self.silent(nudge), {"speak": False, "line_id": None, "gate": "cannot_interrupt"})
        self.assertEqual((self.lines, self.gate._count), ([], 0))

    def test_an_unrecognised_app_waits_twice_the_dwell_then_asks_the_judge(self):
        self.with_scene(activity="unknown", subject=None, can_interrupt=False, holds=[])
        self.run_for(2 * DWELL - 1, CODE)
        self.assertEqual((self.backend.states, self.published), ([], []))
        self.run_for(2, CODE)
        self.assertEqual(self.backend.states[0]["activity"], "unknown")
        [nudge] = self.nudges("comment")
        self.assertEqual(self.silent(nudge)["gate"], None)
        self.assertEqual(len(self.lines), 1)

    def test_an_unrecognised_app_stays_silent_when_the_judge_says_no(self):
        self.with_scene(activity="unknown", subject=None, can_interrupt=False, holds=[])
        self.backend.want = False
        self.run_for(2 * DWELL + 1, CODE)
        self.assertEqual((len(self.backend.states), self.lines), (1, []))

    def test_an_unrecognised_app_is_held_without_recent_input_or_under_a_hold(self):
        for extra, scene in (({"idle_s": 120.0}, {}), ({}, {"holds": ["fullscreen"]})):
            with self.subTest(extra=extra, scene=scene):
                self.setUp()
                self.with_scene(**{"activity": "unknown", "subject": None, "can_interrupt": False, "holds": [],
                                   **scene})
                self.run_for(2 * DWELL + 1, CODE, **extra)
                self.assertEqual(self.backend.states, [])
                [nudge] = self.nudges("comment")
                self.assertEqual(self.silent(nudge)["gate"], "cannot_interrupt")

    def test_an_activity_change_while_the_judge_thinks_drops_the_comment(self):
        self.with_scene()
        self.backend.on_ask = lambda: self.scene.update(activity="build_failed")
        self.run_for(DWELL + 1, CODE)
        [nudge] = self.nudges("comment")
        self.assertEqual(self.silent(nudge), {"speak": False, "line_id": None, "gate": "activity_changed"})
        self.assertEqual(self.lines, [])

    def test_claim_starts_the_line_and_its_recheck_follows_the_scene(self):
        self.with_scene()
        claims, free = [], [False]
        self.p.claim = lambda line_id, text, recheck, reason: claims.append((line_id, recheck)) or free[0]
        self.run_for(DWELL + 1, CODE)
        self.assertEqual(self.silent(self.nudges("comment")[0])["gate"], "busy")
        self.gate = self.p.gate = Gate(enabled=True, quiet=(0, 0))
        self.gate.set_companion(True)
        free[0] = True
        self.run_for(1, SAFARI)
        self.run_for(DWELL + 1, CODE)  # the busy claim kept the subject free
        nudge = self.nudges("comment")[1]
        self.assertEqual((nudge["speak"], nudge["line_id"]), (True, claims[-1][0]))
        self.assertEqual(self.lines, [])  # claim started it, not start_line
        recheck = claims[-1][1]
        self.assertTrue(recheck())
        self.gate.fullscreen = True
        self.assertFalse(recheck())
        self.gate.fullscreen = False
        self.scene["activity"] = "reading"
        self.assertFalse(recheck())
        self.scene["activity"] = "editing_code"
        self.assertTrue(recheck())
        self.run_for(1, SAFARI)
        self.assertFalse(recheck())

    def test_the_recheck_fails_once_the_scene_may_not_be_interrupted(self):
        self.with_scene()
        claims = []
        self.p.claim = lambda line_id, text, recheck, reason: claims.append(recheck) or True
        self.run_for(DWELL + 1, CODE)
        [recheck] = claims
        self.assertTrue(recheck())
        self.scene["can_interrupt"] = False  # the user resumes typing; activity, subject and focus stay
        self.assertFalse(recheck())

    def test_a_claimed_comment_takes_its_subject_only_once_voiced(self):
        self.with_scene()
        claims = []
        self.p.claim = lambda line_id, text, recheck, reason: claims.append(line_id) or True
        self.run_for(DWELL + 1, CODE)  # claimed, then cancelled before its first clause
        self.run_for(1, SAFARI)
        self.run_for(DWELL + 1, CODE)
        self.assertEqual([n["gate"] for n in self.nudges("comment")], [None, None])
        self.voice(claims[-1])
        self.gate.same_cooldown = self.gate.cross_cooldown = 0
        self.run_for(1, SAFARI)
        self.run_for(DWELL + 1, CODE)
        self.assertEqual([n["gate"] for n in self.nudges("comment")], [None, None, "same_subject"])

    def test_one_subject_is_commented_once(self):
        self.with_scene()
        self.gate.same_cooldown = self.gate.cross_cooldown = 0
        self.run_for(DWELL + 1, CODE)
        self.scene["focus_id"] = "focus:2"  # another window on the same subject
        self.run_for(DWELL + 1, SAFARI)
        self.scene.update(subject=None, focus_id="focus:3")  # no subject: the focus run names it
        self.run_for(DWELL + 1, CODE)
        self.run_for(DWELL + 1, SAFARI)
        self.assertEqual([n["gate"] for n in self.nudges("comment")], [None, "same_subject", None, "same_subject"])
        self.assertEqual(len(self.lines), 2)

    def test_a_comment_that_is_not_clearly_useful_stays_silent(self):
        self.with_scene()
        claims = []
        self.p.claim = lambda line_id, text, recheck, reason: claims.append(line_id) or True
        self.backend.values = {"useful": False}
        self.run_for(DWELL + 1, CODE)
        [nudge] = self.nudges("comment")
        self.assertEqual(self.silent(nudge), {"speak": False, "line_id": None, "gate": "not_useful"})
        self.assertEqual((claims, self.lines, self.gate._count), ([], [], 0))
        self.assertEqual(self.backend.asked, [["want_comment", "useful"]])
        # Control: useful as well, the line is claimed.
        self.backend.values, self.published = {}, []
        self.run_for(1, SAFARI)
        self.run_for(DWELL + 1, CODE)
        [nudge] = self.nudges("comment")
        self.assertEqual((nudge["gate"], claims), (None, [nudge["line_id"]]))

    def after_last(self, cooldowns):
        """gate.check for a comment `cooldowns` same_cooldowns after the last voiced one."""
        at = self.gate._last["comment"] + datetime.timedelta(seconds=cooldowns * self.gate.same_cooldown)
        return self.gate.check("comment", at)

    def test_unanswered_comments_stretch_the_comment_cooldown(self):
        self.backend.want = False  # the dwell below starts no comment of its own

        def unanswered(lines):
            for _ in range(lines):
                self.voice(f"p{self.now}")
                self.run_for(RESPONSE_WINDOW + 2, CODE)

        unanswered(2)
        self.assertEqual((self.p.misses, self.after_last(1.5)), (2, None))
        unanswered(1)
        self.assertEqual((self.p.misses, self.p.factor), (3, 2))
        self.assertEqual((self.after_last(1.5), self.after_last(2.5)), ("same_cooldown", None))
        unanswered(3)
        self.assertEqual((self.after_last(3.5), self.after_last(4.5)), ("same_cooldown", None))
        unanswered(3)
        self.assertEqual((self.p.misses, self.p.factor, self.after_last(4.5)), (9, 4, None))
        # The next line voiced before the window closes ends the last one as a miss too.
        self.voice("p-a")
        self.run_for(5, CODE)
        self.voice("p-b")
        self.assertEqual(self.p.misses, 10)
        # A /say within the window after the line answers it: back to x1.
        self.busy = True  # still speaking: the window has not started
        self.run_for(RESPONSE_WINDOW + 2, CODE)
        self.busy = False
        self.run_for(RESPONSE_WINDOW - 2, CODE)
        self.p.said({"kind": "line", "id": "p-b"})
        self.assertEqual((self.p.misses, self.p.factor, self.after_last(1.5)), (0, 1, None))
        # No open line: a /say answers nothing.
        unanswered(3)
        self.p.said()
        self.assertEqual(self.p.misses, 3)
        # Feedback: 「别打扰」 is no answer, 「有用」 is.
        self.voice("p-c")
        self.p.feedback("p-c", "dont_disturb")
        self.p.said()
        self.assertEqual(self.p.misses, 4)
        self.voice("p-d")
        self.p.feedback("p-d", "useful")
        self.assertEqual((self.p.misses, self.gate.scale["comment"]), (0, 1))

    def test_an_answer_still_resets_misses_with_a_state_scale(self):
        self.gate = Gate(enabled=True, quiet=(0, 0), state_scale=lambda: 1.5)
        self.gate.set_companion(True)
        self.p = Proactive(self.store, self.gate, lambda event, data: self.published.append((event, data)),
                           self.start, lambda: self.busy, judge=Judge(self.backend), clock=lambda: self.now,
                           spawn=lambda f: f())
        self.backend.want = False
        for _ in range(3):
            self.voice(f"p{self.now}")
            self.run_for(RESPONSE_WINDOW + 2, CODE)
        self.assertEqual((self.p.misses, self.after_last(2.9), self.after_last(3)), (3, "same_cooldown", None))
        self.voice("p-a")
        self.run_for(RESPONSE_WINDOW - 2, CODE)
        self.p.said({"kind": "line", "id": "p-a"})
        self.assertEqual((self.p.misses, self.p.factor, self.gate.scale["comment"]), (0, 1, 1))
        self.assertEqual((self.after_last(1.4), self.after_last(1.5)), ("same_cooldown", None))

    def logged(self):
        """self.p over a ProactiveLog in a fresh store: the log."""
        from character.proactive_log import ProactiveLog
        from infra.store import open_store
        db = open_store(Path(self.tmp.name) / "agentd.sqlite")
        self.addCleanup(db.close)
        log = ProactiveLog(db)
        self.p = Proactive(self.store, self.gate, lambda event, data: self.published.append((event, data)),
                           self.start, lambda: self.busy, judge=Judge(self.backend), clock=lambda: self.now,
                           spawn=lambda f: f(), log=log)
        return log

    def test_a_line_left_unanswered_is_logged_ignored(self):
        log = self.logged()
        self.backend.want = False
        log.shown("p-a", "line", "comment", None, "text", None, None, self.now)
        self.voice("p-a")
        self.run_for(RESPONSE_WINDOW + 2, CODE)
        self.assertEqual(self.p.misses, 1)
        self.assertEqual(log.entry("p-a"), ("line", "ignored"))

    def test_a_say_without_reply_to_answers_no_line(self):
        log = self.logged()
        self.backend.want = False
        for _ in range(2):
            self.voice(f"p{self.now}")
            self.run_for(RESPONSE_WINDOW + 2, CODE)
        log.shown("p-a", "line", "comment", None, "text", None, None, self.now)
        self.voice("p-a")
        self.run_for(5, CODE)
        self.p.said()
        self.assertEqual(self.p.misses, 2)
        self.run_for(RESPONSE_WINDOW, CODE)
        self.assertEqual((self.p.misses, log.entry("p-a")), (3, ("line", "ignored")))

    def test_dismissed_settles_the_open_line_as_a_miss(self):
        self.backend.want = False
        self.voice("p-a")
        self.p.feedback("p-a", "dismissed")
        self.p.said()
        self.assertEqual(self.p.misses, 1)

    def test_less_and_useful_scale_the_comment_cooldown_and_persist(self):
        log = self.logged()
        self.backend.want = False
        self.voice("p-a")
        self.p.feedback("p-a", "less")
        self.p.said()
        self.assertEqual((self.p.misses, log.less(), self.gate.scale["comment"]), (0, 1.5, 1.5))
        self.p.feedback("t1", "less", channel="thought")
        self.p.feedback("t2", "less", channel="thought")
        self.p.feedback("t3", "less", channel="thought")
        self.assertEqual((log.less(), self.gate.scale["comment"]), (4, 4))
        for _ in range(3):
            self.voice(f"p{self.now}")
            self.run_for(RESPONSE_WINDOW + 2, CODE)
        self.assertEqual((self.p.factor, self.gate.scale["comment"]), (2, 8), "misses multiply on top")
        self.gate = Gate(enabled=True, quiet=(0, 0))
        Proactive(self.store, self.gate, lambda event, data: None, self.start, lambda: False, log=log)
        self.assertEqual(self.gate.scale["comment"], 4, "a restart keeps the factor")
        self.p.feedback("t4", "useful", channel="thought")
        self.assertEqual((self.p.misses, log.less()), (3, 4 / 1.5), "a useful thought answers no line")
        for value in ("useful", "useful", "useful", "useful"):
            self.p.feedback("t4", value, channel="thought")
        self.assertEqual(log.less(), 1)

    def backed(self):
        """Proactive over a registry on the test clock: (registry, proactive)."""
        registry = Registry(epoch=1, clock=lambda: self.now)
        p = Proactive(self.store, self.gate, lambda event, data: self.published.append((event, data)), self.start,
                      lambda: self.busy, clock=lambda: self.now, sessions=registry.snapshot)
        return registry, p

    def test_back_speaks_only_when_sessions_changed_while_away(self):
        registry, self.p = self.backed()
        registry.ingest(claude("UserPromptSubmit", self.now - 100, prompt="SECRET-PROMPT"))
        registry.ingest(claude("Stop", self.now - 50))  # done before she left
        self.now += 1200
        self.p.back(1200.0)
        self.assertEqual((self.lines, self.nudges("back")), ([], []))
        start = self.now
        registry.ingest(claude("UserPromptSubmit", start + 10, prompt="SECRET-PROMPT"))
        registry.ingest(claude("Stop", start + 100))
        approval = claude("PermissionRequest", start + 1150, session="B", cwd="/w/agentd", tool_name="Bash")
        approval.request_id = "r1"
        registry.ingest(approval)
        self.now += 1200
        self.p.back(1200.0)
        [nudge] = self.nudges("back")
        [(line_id, text)] = self.lines
        self.assertEqual({k: nudge[k] for k in ("level", "line_id", "speak", "gate")},
                         {"level": "P2", "line_id": line_id, "speak": True, "gate": None})
        self.assertIn("a finished", text)
        self.assertIn("agentd waiting for approval", text)
        self.assertNotIn("SECRET-PROMPT", text)
        self.assertEqual(self.materials, [None])  # nothing came before
        self.assertIn("back", self.gate._last)  # its own cooldown starts once voiced

    def test_back_says_an_observed_session_waits_in_its_own_app(self):
        registry, self.p = self.backed()
        start = self.now
        registry.ingest(claude("PermissionRequest", start + 1150, session="B", cwd="/w/agentd", tool_name="Bash"))
        self.now += 1200
        self.p.back(1200.0)
        [(_, text)] = self.lines
        self.assertIn("agentd waiting for confirmation in Claude Code", text)
        self.assertNotIn("approval", text)

    def test_back_respects_gate_meeting(self):
        registry, self.p = self.backed()
        self.gate.meeting = True
        registry.ingest(claude("Stop", self.now + 100))
        self.now += 1200
        self.p.back(1200.0)
        [nudge] = self.nudges("back")
        self.assertEqual({k: nudge[k] for k in ("line_id", "speak", "gate")},
                         {"line_id": None, "speak": False, "gate": "meeting"})
        self.assertEqual(self.lines, [])

    def returning(self, before_ago):
        """A backed proactive whose scene had coding in effect before_ago seconds before a 1200 s absence (None:
        no before_away); its claims go to self.claims as (text, reason, material)."""
        registry, self.p = self.backed()
        self.claims = []
        self.p.claim = lambda line_id, text, recheck, reason, material=None: \
            self.claims.append((text, reason, material)) or True
        left = self.now
        before = None if before_ago is None else {
            "mode": "coding", "state": "stuck", "evidence": ["repeat_error"], "thread": "Endfield", "on_mind": None,
            "blocker": "error: x", "ts": left - before_ago}
        self.p.activity = lambda: {"activity": "editing_code", "subject": None, "focus_id": None,
                                   "can_interrupt": True, "before_away": before}
        self.now += 1200
        return registry, left

    def test_back_names_what_came_before_without_session_news(self):
        self.returning(60)
        self.p.back(1200.0)
        [(text, reason, material)] = self.claims
        self.assertIn(f"Before leaving, {PROMPT_USER} was {MODE_NAMES['coding']}.", text)
        self.assertIn("What exactly they were doing before leaving is in the live material", text)
        self.assertNotIn("Endfield", text)
        self.assertNotIn("error: x", text)
        self.assertEqual(material, 'Doing before leaving: Endfield; stuck on "error: x"')
        self.assertIn("you were just", text)
        self.assertEqual(reason, {"code": "back", "kind": "back", "text": "你离开了 20 分钟，刚回来", "away_min": 20,
                                  "before": True})
        [nudge] = self.nudges("back")
        self.assertTrue(nudge["speak"])

    def test_back_without_a_thread_or_blocker_has_no_material(self):
        self.returning(60)
        self.p.activity()["before_away"].update(thread=None, blocker=None)
        self.p.back(1200.0)
        [(text, reason, material)] = self.claims
        self.assertIsNone(material)
        self.assertIn(f"Before leaving, {PROMPT_USER} was {MODE_NAMES['coding']}.", text)
        self.assertNotIn("live material", text)

    def test_back_stays_silent_without_news_or_a_recent_before_away(self):
        for before_ago in (None, 700):
            with self.subTest(before_ago=before_ago):
                self.returning(before_ago)
                self.p.back(1200.0)
                self.assertEqual((self.claims, self.nudges("back")), ([], []))

    def test_back_is_not_held_by_an_unrecognised_app(self):
        self.returning(60)
        scene = self.p.activity
        self.p.activity = lambda: {**scene(), "activity": "unknown", "can_interrupt": False, "holds": []}
        self.p.back(1200.0)
        self.assertEqual(len(self.claims), 1)
        self.returning(60)
        scene = self.p.activity
        self.p.activity = lambda: {**scene(), "activity": "typing", "can_interrupt": False,
                                   "holds": ["continuous_input"]}
        self.p.back(1200.0)
        self.assertEqual(self.claims, [])
        self.assertEqual(self.nudges("back")[-1]["gate"], "cannot_interrupt")

    def test_every_back_decision_is_recorded(self):
        decided = []
        self.gate.on_decision = lambda kind, attrs, key: decided.append((kind, attrs["kind"], attrs["speak"],
                                                                          attrs["reason"]))
        self.returning(None)
        self.p.back(1200.0)
        self.returning(60)
        self.p.back(500.0)
        self.returning(60)
        scene = self.p.activity
        self.p.activity = lambda: {**scene(), "activity": "typing", "can_interrupt": False,
                                   "holds": ["continuous_input"]}
        self.p.back(1200.0)
        self.returning(60)
        self.p.back(1200.0)
        self.assertEqual(decided, [("gate.decided", "back", False, "no_before_away"),
                                   ("gate.decided", "back", False, "short_away"),
                                   ("gate.decided", "back", False, "cannot_interrupt"),
                                   ("gate.decided", "back", True, None)])
        self.assertEqual(self.gate._blocked, 0)  # local holds are not gate refusals

    def test_back_stays_silent_after_a_short_absence_without_news(self):
        self.returning(60)
        self.p.back(500.0)
        self.assertEqual((self.claims, self.nudges("back")), ([], []))

    def test_back_names_the_news_then_what_came_before(self):
        registry, left = self.returning(60)
        registry.ingest(claude("UserPromptSubmit", left + 10))
        registry.ingest(claude("Stop", left + 100))
        self.p.back(1200.0)
        [(text, reason, material)] = self.claims
        self.assertIn(f"While away: a finished. Before leaving, {PROMPT_USER} was {MODE_NAMES['coding']}.", text)
        self.assertNotIn("Endfield", text)
        self.assertNotIn("error: x", text)
        self.assertEqual(material, 'Doing before leaving: Endfield; stuck on "error: x"')
        self.assertIn("first the names and states of these sessions, then a few words on what they were doing before "
                      "leaving", text)
        self.assertEqual(reason["before"], True)
        registry, left = self.returning(None)
        registry.ingest(claude("Stop", left + 100))
        self.p.back(1200.0)
        [(text, reason, material)] = self.claims
        self.assertIsNone(material)
        self.assertNotIn(f"Before leaving, {PROMPT_USER} was", text)
        self.assertIn("giving only the names and states of these sessions", text)
        self.assertEqual(reason["before"], False)

    def breaking(self, **kwargs):
        """A proactive without a judge whose claims are kept in self.claims as (line_id, text, reason)."""
        self.claims = []
        self.p = Proactive(self.store, self.gate, lambda event, data: self.published.append((event, data)), self.start,
                           lambda: self.busy, clock=lambda: self.now,
                           claim=lambda line_id, text, recheck, reason: self.claims.append((line_id, text, reason)) or True,
                           **kwargs)

    def desk(self, minutes, idle_s=4.0, keys=30, clicks=0):
        """A heartbeat every 30 s for `minutes` minutes."""
        for _ in range(round(minutes * 2)):
            self.now += 30.0
            self.p.beat(beat(self.now, CODE, idle_s=idle_s, input={"keys_60s": keys, "clicks_10s": clicks}))

    def test_break_reminder_off_by_default(self):
        self.breaking()
        self.desk(240)
        self.assertEqual((self.nudges("break"), self.claims), ([], []))

    def test_water_waits_for_a_pause_and_respects_meeting(self):
        self.breaking(water_minutes=1)
        self.desk(1.5, idle_s=0)
        self.assertEqual((self.nudges("water"), self.claims), ([], []))
        self.gate.meeting = True
        self.desk(0.5, idle_s=4)
        self.assertEqual(self.nudges("water")[-1]["gate"], "meeting")
        self.assertEqual(self.claims, [])
        self.gate.meeting = False
        self.desk(0.5, idle_s=4)
        [(line_id, text, reason)] = self.claims
        self.assertIn("drink water", text)
        self.assertEqual(reason["code"], "water")
        self.assertTrue(self.p.voiced(line_id))
        self.assertIn("water", self.gate._last)
        self.desk(0.5, idle_s=4)
        self.assertEqual(len(self.claims), 1)

    def test_care_lines_are_not_held_by_an_unrecognised_app(self):
        unknown = {"activity": "unknown", "subject": None, "focus_id": None, "can_interrupt": False, "holds": []}
        self.breaking(water_minutes=1, activity=lambda: unknown)
        self.desk(1.5, idle_s=0)
        self.desk(0.5, idle_s=4)
        self.assertEqual([reason["code"] for _, _, reason in self.claims], ["water"])
        self.breaking(break_minutes=45, activity=lambda: unknown)
        self.desk(45.5)
        self.assertEqual([reason["code"] for _, _, reason in self.claims], ["break"])
        self.breaking(water_minutes=1, activity=lambda: {**unknown, "holds": ["fullscreen"]})
        self.desk(1.5, idle_s=0)
        self.desk(0.5, idle_s=4)
        self.assertEqual((self.claims, self.nudges("water")[-1]["gate"]), ([], "cannot_interrupt"))

    def test_break_after_n_active_minutes_once(self):
        self.breaking(break_minutes=45)
        self.desk(45)  # the clock starts at the first beat: 44 min 30 s so far
        self.assertEqual(self.nudges("break"), [])
        self.desk(0.5)
        [nudge] = self.nudges("break")
        [(line_id, text, reason)] = self.claims
        self.assertEqual({k: nudge[k] for k in ("level", "line_id", "speak", "gate")},
                         {"level": "P2", "line_id": line_id, "speak": True, "gate": None})
        self.assertEqual(reason, {"code": "break", "kind": "break", "text": "你已经连续用电脑 45 分钟", "minutes": 45})
        self.assertIn("45 minutes", text)
        self.assertNotIn("SECRET-TITLE", text)
        self.desk(1)  # the clock started again
        self.assertEqual(len(self.claims), 1)
        # The gate keeps its own cooldown of 45 minutes once the line is voiced.
        self.assertTrue(self.p.voiced(line_id))
        last = self.gate._last["break"]
        self.assertEqual((self.gate.check("break", last + datetime.timedelta(minutes=44)),
                          self.gate.check("break", last + datetime.timedelta(minutes=45))), ("same_cooldown", None))

    def test_the_reason_text_is_in_the_reply_language(self):
        for language, text in (("zh-Hans", "你已经连续用电脑 45 分钟"), (None, "你已经连续用电脑 45 分钟"),
                               ("en", "You have been at the computer for 45 min straight"),
                               ("ja", "もう 45 分続けてパソコンを使っている")):
            with self.subTest(language=language):
                self.breaking(break_minutes=45, language=lambda: language)
                self.desk(45.5)
                [(_, prompt, reason)] = self.claims
                self.assertEqual(reason["text"], text)
                self.assertIn("45 minutes straight", prompt)  # the instruction stays English
                self.now += 3 * 3600
                self.gate._last, self.gate._last_any = {}, None

    def test_afk_5min_resets_break_clock(self):
        self.breaking(break_minutes=45)
        self.desk(30)
        self.desk(0.5, idle_s=300.0)
        self.desk(45)
        self.assertEqual(self.nudges("break"), [])
        # Control: idle just under five minutes keeps the clock running.
        self.breaking(break_minutes=45)
        self.desk(30)
        self.desk(0.5, idle_s=299.0)
        self.desk(15)
        self.assertEqual(len(self.claims), 1)

    def test_lock_and_sleep_restart_break_clock(self):
        for flag in ("locked", "asleep"):
            with self.subTest(flag=flag):
                self.published = []
                self.breaking(break_minutes=45)
                self.desk(44.5)
                for _ in range(4):
                    self.now += 30
                    self.p.beat(beat(self.now, CODE, **{flag: True}, input={"keys_60s": 30}))
                self.desk(45)
                self.assertEqual(self.nudges("break"), [])
                self.desk(0.5)
                self.assertEqual([reason["minutes"] for _, _, reason in self.claims], [45])

    def test_heartbeat_gap_over_afk_limit_restarts_break_clock(self):
        self.breaking(break_minutes=45)
        self.desk(44.5)
        self.now += 301
        self.desk(45)
        self.assertEqual(self.nudges("break"), [])
        self.desk(0.5)
        self.assertEqual([reason["minutes"] for _, _, reason in self.claims], [45])

    def test_break_needs_input_activity(self):
        self.breaking(break_minutes=45)
        self.desk(60, keys=10, clicks=1)  # 10 + 6 x 1 = 16 a minute
        self.desk(0.5, keys=0, clicks=0)
        self.assertEqual(self.nudges("break"), [])
        self.desk(0.5, keys=14, clicks=1)  # 20
        self.assertEqual([n["speak"] for n in self.nudges("break")], [True])

    def test_break_names_the_minutes_she_has_been_present(self):
        self.breaking(break_minutes=45)
        self.desk(60, keys=10)  # 60 min present, too little input to speak
        self.desk(0.5)
        self.desk(45)  # due again 45 min after the last line
        self.assertEqual([reason["minutes"] for _, _, reason in self.claims], [60, 105])
        self.assertIn("105 minutes", self.claims[1][1])

    def test_voiced_break_commits_break_not_comment(self):
        self.breaking(break_minutes=45)
        self.desk(45.5)
        [(line_id, _, _)] = self.claims
        self.assertTrue(self.p.voiced(line_id))
        self.assertEqual(set(self.gate._last), {"break"})
        self.assertFalse(self.p.voiced("another-line"))


class StuckTest(unittest.TestCase):
    def test_companion_off_stuck_sends_no_nudge_or_retry(self):
        self.gate = self.p.gate = Gate(enabled=True, quiet=(0, 0))
        self.gate.set_companion(False)
        self.beats(200, key_idle=30.0)
        self.assertEqual(self.claims, [])
        self.assertEqual(self.nudges(), [])
        self.assertIsNone(self.p._stuck_retry_at)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.addCleanup(self.tmp.cleanup)
        self.now = T0
        self.store = AttentionStore(Path(self.tmp.name) / "attention.sqlite",
                                    Blacklist(deny_blacklist(Path(self.tmp.name) / "blacklist.json")), clock=lambda: self.now)
        self.addCleanup(self.store.close)
        self.gate = Gate(enabled=True, quiet=(0, 0))
        self.gate.set_companion(True)
        self.published, self.claims = [], []
        self.scene = {"activity": "editing_code", "subject": None, "focus_id": None, "can_interrupt": True,
                      "mode": "coding", "state": "stuck", "thread": "Endfield", "blocker": "error: line 42 failed"}
        self.p = Proactive(self.store, self.gate, lambda event, data: self.published.append((event, data)), None,
                           lambda: False, clock=lambda: self.now,
                           activity=lambda: None if self.scene is None else dict(self.scene),
                           claim=lambda line_id, text, recheck, reason, material=None:
                           self.claims.append((line_id, text, reason)) or self.materials.append(material) or True)
        self.materials = []

    def beats(self, seconds, key_idle):
        """A heartbeat every 10 s for `seconds` seconds, keys last pressed key_idle seconds before each."""
        for _ in range(round(seconds / 10)):
            self.now += 10.0
            self.p.beat(beat(self.now, CODE, input={"key_idle_s": key_idle}))

    def nudges(self):
        return [data for event, data in self.published if event == "nudge" and data["kind"] == "stuck"]

    def test_asks_once_stuck_for_two_minutes_at_a_pause(self):
        self.beats(110, key_idle=30.0)  # the clock starts at the first beat: 100 s so far
        self.assertEqual((self.claims, self.nudges()), ([], []))
        self.beats(30, key_idle=9.0)  # long enough, still typing
        self.assertEqual((self.claims, self.nudges()), ([], []))
        self.beats(10, key_idle=10.0)
        [(line_id, text, reason)] = self.claims
        [nudge] = self.nudges()
        self.assertEqual({k: nudge[k] for k in ("level", "line_id", "speak", "gate")},
                         {"level": "P2", "line_id": line_id, "speak": True, "gate": None})
        self.assertNotIn("Endfield", text)
        self.assertNotIn("error: line 42 failed", text)
        self.assertIn(f"{PROMPT_USER} seems to have been stuck on a problem for a while; where is in the live material.",
                      text)
        self.assertIn("ask whether they want you to help take a look", text)
        self.assertEqual(reason, {"code": "stuck", "kind": "stuck", "text": "你像是卡在一个问题上 2 分钟了", "minutes": 2})

    def test_no_input_pauses_by_idle_s(self):
        for _ in range(14):
            self.now += 10.0
            self.p.beat(beat(self.now, CODE, idle_s=10.0))
        self.assertEqual(len(self.claims), 1)

    def test_one_blocker_is_asked_once_and_another_again(self):
        self.beats(130, key_idle=30.0)
        self.beats(300, key_idle=0.0)
        self.scene["blocker"] = "error: line 57 failed"  # the same line, other numbers
        self.beats(30, key_idle=30.0)
        self.assertEqual(len(self.claims), 1)
        self.scene["blocker"] = "TypeError: x is undefined"  # a new blocker restarts the clock
        self.beats(120, key_idle=30.0)
        self.assertEqual(len(self.claims), 1)
        self.beats(10, key_idle=30.0)
        self.assertEqual(len(self.claims), 2)
        self.assertNotIn("TypeError", self.claims[1][1])

    def test_a_scene_that_is_not_stuck_restarts_the_clock(self):
        for other in ({**self.scene, "state": "flowing"}, None):
            with self.subTest(other=other):
                stuck, self.claims = self.scene, []
                self.beats(100, key_idle=0.0)
                self.scene = other
                self.beats(10, key_idle=30.0)
                self.scene = stuck
                self.beats(110, key_idle=30.0)
                self.assertEqual(self.claims, [])
                self.beats(20, key_idle=30.0)
                self.assertEqual(len(self.claims), 1)
                self.scene["blocker"] = f"blocker of {other}"

    def test_without_a_blocker_names_the_same_problem(self):
        self.scene.update(blocker=None, thread=None)
        self.beats(130, key_idle=30.0)
        [(_, text, _)] = self.claims
        self.assertIn(f"{PROMPT_USER} seems to have been stuck on a problem for a while", text)
        self.assertNotIn("None", text)

    def test_cannot_interrupt_keeps_silent_and_the_blocker_unasked(self):
        self.scene["can_interrupt"] = False
        self.beats(140, key_idle=30.0)
        self.assertEqual(self.claims, [])
        [nudge] = self.nudges()  # a refused try waits STUCK_RETRY before the next
        self.assertEqual({k: nudge[k] for k in ("line_id", "speak", "gate")},
                         {"line_id": None, "speak": False, "gate": "cannot_interrupt"})
        self.scene["can_interrupt"] = True
        self.beats(40, key_idle=30.0)
        self.assertEqual(self.claims, [])
        self.beats(10, key_idle=30.0)
        self.assertEqual(len(self.claims), 1)

    def test_a_gate_refusal_keeps_silent_and_the_blocker_unasked(self):
        self.gate.quiet = (0, 24)
        self.beats(180, key_idle=30.0)
        self.assertEqual(self.claims, [])
        self.assertEqual([n["gate"] for n in self.nudges()], ["quiet_hours"])
        self.assertNotIn("stuck", self.gate._last)
        self.gate.quiet = (0, 0)
        self.beats(10, key_idle=30.0)
        self.assertEqual(len(self.claims), 1)

    def test_voiced_stuck_commits_stuck(self):
        self.beats(130, key_idle=30.0)
        [(line_id, _, _)] = self.claims
        self.assertNotIn("stuck", self.gate._last)
        self.assertTrue(self.p.voiced(line_id))
        self.assertEqual(set(self.gate._last), {"stuck"})
        self.assertFalse(self.p.voiced("another-line"))


def work_event(key, state, title="检查编译结果", summary="编译失败：缺少 RenderTarget 声明"):
    return {"title": title, "summary": summary, "task_key": key, "state": state, "evidence": []}


def analysis(now, events=(), tasks=(), newest_age=20.0):
    """A committed interpreter analysis at now: tasks are (key, state), observed newest_age seconds before."""
    return {"work_events": list(events),
            "task_updates": [{"task_key": k, "title": "修复渲染编译", "objective": "恢复构建", "current_step": "检查声明",
                              "state": s, "unresolved": [], "next_steps": [], "confidence": 0.9, "evidence": [],
                              "last_observed_at": now - newest_age} for k, s in tasks],
            "batch": {"newest_observed_at": now - newest_age}}


class WorkStuckTest(unittest.TestCase):
    """A blocked work event the interpreter keeps finding asks the stuck question with the event as material."""
    setUp, beats, nudges = StuckTest.setUp, StuckTest.beats, StuckTest.nudges

    def report(self, events=(), tasks=(("render", "blocked"),), newest_age=20.0):
        self.p.interpreted(analysis(self.now, events, tasks, newest_age))

    def unstuck(self):
        """Rules see no stuck state: only the interpreter knows."""
        self.scene.update(state="unknown", blocker=None, thread=None)

    def test_blocked_across_two_runs_asks_with_the_event_as_material(self):
        self.unstuck()
        self.report([work_event("render", "blocked")])
        self.beats(60, key_idle=30.0)
        self.assertEqual(self.claims, [])
        self.report()  # the next run still finds the task blocked
        self.beats(10, key_idle=30.0)
        [(_, text, reason)] = self.claims
        self.assertIn("ask whether they want you to help take a look", text)
        self.assertNotIn("RenderTarget", text)
        self.assertEqual((reason["code"], reason["kind"]), ("stuck", "stuck"))
        [material] = self.materials
        self.assertIn("检查编译结果", material)
        self.assertIn("缺少 RenderTarget 声明", material)
        self.beats(300, key_idle=30.0)  # asked once per task
        self.report()
        self.beats(10, key_idle=30.0)
        self.assertEqual(len(self.claims), 1)

    def test_blocked_for_three_minutes_without_another_run_asks(self):
        self.unstuck()
        self.report([work_event("render", "blocked")])
        self.beats(170, key_idle=30.0)
        self.assertEqual(self.claims, [])
        self.beats(10, key_idle=30.0)
        self.assertEqual(len(self.claims), 1)

    def test_a_task_no_longer_blocked_or_a_backlog_batch_asks_nothing(self):
        self.unstuck()
        self.report([work_event("render", "blocked")])
        self.report([work_event("render", "working")], tasks=(("render", "working"),))
        self.beats(200, key_idle=30.0)
        self.report([work_event("late", "blocked")], tasks=(("late", "blocked"),), newest_age=600.0)
        self.report(tasks=(("late", "blocked"),), newest_age=600.0)
        self.beats(200, key_idle=30.0)
        self.assertEqual((self.claims, self.nudges()), ([], []))

    def test_still_typing_or_cannot_interrupt_keeps_silent(self):
        self.unstuck()
        self.report([work_event("render", "blocked")])
        self.report()
        self.beats(30, key_idle=0.0)
        self.assertEqual(self.claims, [])
        self.scene["can_interrupt"] = False
        self.beats(10, key_idle=30.0)
        self.assertEqual(self.claims, [])
        self.assertEqual([n["gate"] for n in self.nudges()], ["cannot_interrupt"])

    def test_companion_off_asks_nothing(self):
        self.unstuck()
        self.gate.set_companion(False)
        self.report([work_event("render", "blocked")])
        self.report()
        self.beats(200, key_idle=30.0)
        self.assertEqual((self.claims, self.nudges()), ([], []))


class WorkResultTest(unittest.TestCase):
    """A result ending a task the user waited on may start one comment, through the comment judge and gate."""
    setUp, start, voice, nudges = ProactiveTest.setUp, ProactiveTest.start, ProactiveTest.voice, ProactiveTest.nudges

    def test_a_result_of_a_waited_task_asks_the_judge_and_comments(self):
        self.p.interpreted(analysis(self.now, tasks=[("render", "waiting")]))
        self.assertEqual(self.backend.states, [])
        self.now += 60
        self.p.interpreted(analysis(self.now, [work_event("render", "result_observed", "构建通过", "Build succeeded")],
                                    [("render", "result_observed")]))
        [state] = self.backend.states
        self.assertNotIn("构建通过", json.dumps(state, ensure_ascii=False))
        self.assertEqual(state["trigger"], "result_observed")
        [(line_id, text)] = self.lines
        self.assertNotIn("Build succeeded", text)
        [material] = self.materials
        self.assertIn("Build succeeded", material)
        [nudge] = self.nudges("comment")
        self.assertEqual((nudge["line_id"], nudge["speak"]), (line_id, True))

    def test_other_results_or_a_judge_no_say_nothing(self):
        self.p.interpreted(analysis(self.now, tasks=[("render", "working")]))
        self.p.interpreted(analysis(self.now, [work_event("render", "result_observed")], [("render", "result_observed")]))
        self.assertEqual(self.backend.states, [])
        self.backend.want = False
        self.p.interpreted(analysis(self.now, tasks=[("b", "blocked")]))
        self.p.interpreted(analysis(self.now, [work_event("b", "result_observed")], [("b", "result_observed")]))
        self.assertEqual(len(self.backend.states), 1)
        self.assertEqual(self.lines, [])

    def test_companion_off_asks_no_judge(self):
        self.gate.set_companion(False)
        self.p.interpreted(analysis(self.now, tasks=[("render", "waiting")]))
        self.p.interpreted(analysis(self.now, [work_event("render", "result_observed")], [("render", "result_observed")]))
        self.assertEqual((self.backend.states, self.lines, self.nudges("comment")), ([], [], []))


class ProactiveServerTest(test_server.FeedServerCase):
    request = test_server.SayTest.request
    lines_until_final = test_server.SayTest.lines_until_final

    def setUp(self):
        super().setUp()
        state = Path(self.tmp.name)
        self.server.attention = AttentionStore(state / "attention.sqlite", Blacklist(deny_blacklist(state / "blacklist.json")))
        self.addCleanup(self.server.attention.close)
        self.server.mouth = test_server.FakeMouth(["好久", "没动了。"])
        self.server.character_agent = test_server.KernelLines(self.server)
        self.server.gate = Gate(enabled=True, quiet=(0, 0))
        self.server.gate.set_companion(True)
        self.server.proactive = Proactive(self.server.attention, self.server.gate, self.server.feed.publish,
                                          self.server.start_line, self.server.busy, judge=Judge(WantBackend()))

    def test_judge_state_keys_unchanged(self):
        backend = WantBackend(want=False)
        self.server.proactive = Proactive(self.server.attention, self.server.gate, self.server.feed.publish,
                                          self.server.start_line, self.server.busy, judge=Judge(backend),
                                          spawn=lambda f: f(), activity=lambda: {**self.server.activity(), "can_interrupt": True})
        now = time.time()
        for i in range(DWELL + 2):
            self.assertEqual(self.request("POST", "/context/attention",
                                          beat(now - DWELL - 1 + i, CODE, **test_server.RAW_SENSING))[0], 200)
        [state] = backend.states
        self.assertEqual(set(state), {"category", "dwell_min", "hour", "activity", "actions", "idle_s"})
        sent = json.dumps(state, ensure_ascii=False)
        for raw in test_server.RAW_SENSING_VALUES:
            self.assertNotIn(raw, sent)

    def test_focus_window_must_be_an_object_of_strings_or_null(self):
        now = time.time()
        for window, status in ((DIALOG, 200), (None, 200), ({"role": None, "subrole": None}, 200),
                               ("AXDialog", 400), ({"role": 1, "subrole": None}, 400)):
            with self.subTest(window=window):
                self.assertEqual(self.request("POST", "/context/attention", beat(now, SAFARI, focus_window=window))[0],
                                 status)
        self.assertEqual(self.request("POST", "/context/attention", beat(now, SAFARI))[0], 200)

    def test_dialog_and_dwell_reach_the_feed(self):
        conn, response = self.open_feed()
        self.addCleanup(conn.close)
        now = time.time()
        self.request("POST", "/context/attention", beat(now - DWELL - 2, SAFARI, focus_window=DIALOG))
        event = self.next_event(response)
        self.assertEqual((event["event"], json.loads(event["data"])["kind"]), ("nudge", "alert"))
        for i in range(DWELL + 2):
            self.request("POST", "/context/attention", beat(now - DWELL - 1 + i, CODE))
        event = self.next_event(response)
        nudge = json.loads(event["data"])
        self.assertEqual((event["event"], nudge["kind"], nudge["speak"]), ("nudge", "comment", True))
        lines = self.lines_until_final(response)
        self.assertEqual({line["line_id"] for line in lines}, {nudge["line_id"]})
        self.assertEqual("".join(line["text_delta"] for line in lines), "好久没动了。")
        self.assertEqual([line["reason"]["code"] for line in lines], ["long_dwell"] * len(lines))

    def comment_line(self):
        """One comment line said through the server; its line_id and its /feed line events."""
        self.server.proactive = Proactive(self.server.attention, self.server.gate, self.server.feed.publish,
                                          self.server.start_line, self.server.busy, judge=Judge(WantBackend()),
                                          spawn=lambda f: f())
        now = time.time()
        for i in range(DWELL + 2):
            self.request("POST", "/context/attention", beat(now - DWELL - 1 + i, CODE))
        self.assertTrue(test_turn.wait_for(lambda: not self.server._live_lines))
        [line_id] = [i["data"]["line_id"] for i in self.server.feed.since(0)
                     if i["event"] == "nudge" and i["data"]["speak"]]
        return line_id, [i["data"] for i in self.server.feed.since(0) if i["event"] == "line"]

    def test_line_carries_reason(self):
        line_id, lines = self.comment_line()
        self.assertEqual({line["line_id"] for line in lines}, {line_id})
        self.assertEqual([line["reason"] for line in lines],
                         [{"code": "long_dwell", "kind": "comment", "text": "你在这个窗口停了 3 分钟",
                           "activity": None, "dwell_min": 3}] * len(lines))

    def test_dont_disturb_with_mute_silences_the_kind_until_restored(self):
        line_id, _ = self.comment_line()
        self.assertEqual(self.request("GET", "/proactive/mutes"), (200, {"muted": []}))
        self.assertEqual(self.request("POST", "/feedback", {"line_id": line_id, "value": "dont_disturb", "mute": 1}),
                         (400, {"error": "invalid_payload"}))
        self.assertEqual(self.request("POST", "/feedback", {"line_id": line_id, "value": "dont_disturb", "mute": True}),
                         (200, {}))
        self.assertEqual(self.request("GET", "/proactive/mutes"), (200, {"muted": ["comment"]}))
        self.assertEqual(self.server.gate.check("comment"), "muted")
        for body in ({"muted": ["session_failed"]}, {"muted": "comment"}, {}):
            with self.subTest(body=body):
                self.assertEqual(self.request("PUT", "/proactive/mutes", body), (400, {"error": "invalid_payload"}))
        self.assertEqual(self.request("PUT", "/proactive/mutes", {"muted": ["stuck", "back"]}),
                         (200, {"muted": ["back", "stuck"]}))
        self.assertNotEqual(self.server.gate.check("comment"), "muted")
        self.assertEqual(self.server.gate.check("back"), "muted")

    def test_feedback_takes_less_and_dismissed_but_not_ignored(self):
        line_id, _ = self.comment_line()
        self.assertEqual(self.request("POST", "/feedback", {"line_id": line_id, "value": "ignored"}),
                         (400, {"error": "invalid_payload"}))
        self.assertEqual(self.request("POST", "/feedback", {"line_id": line_id, "value": "dismissed"}), (200, {}))
        self.assertEqual(self.request("POST", "/feedback", {"line_id": "nope", "value": "less"}),
                         (404, {"error": "unknown_line"}))
        self.assertEqual(self.server.proactive.misses, 1)

    def test_the_gate_counts_a_comment_only_once_it_is_voiced(self):
        self.server.speech = test_server.FakeRelay()
        state = Path(self.tmp.name)
        for voiced in (False, True):
            with self.subTest(voiced=voiced):
                attention = AttentionStore(state / f"attention-{voiced}.sqlite", Blacklist(deny_blacklist(state / "blacklist.json")))
                self.addCleanup(attention.close)
                gate = self.server.gate = Gate(enabled=True, quiet=(0, 0))
                gate.set_companion(True)
                # Fullscreen comes on after the claim, before the first clause: its recheck fails.
                self.server.mouth = test_turn.FlipMouth(["好久", "没动了。"],
                                                        lambda: setattr(gate, "fullscreen", not voiced))
                proactive = Proactive(attention, gate, self.server.feed.publish, self.server.start_line,
                                      self.server.busy, judge=Judge(WantBackend()), spawn=lambda f: f(),
                                      claim=self.server.claim_line)
                now = time.time()
                for i in range(DWELL + 2):
                    body = beat(now - DWELL - 1 + i, CODE)
                    attention.ingest(body)
                    proactive.beat(body)
                self.assertTrue(test_turn.wait_for(lambda: not self.server._live_lines))
                [nudge] = [i["data"] for i in self.server.feed.since(0)
                           if i["event"] == "nudge" and i["data"]["line_id"] is not None][-1:]
                [final] = [i["data"] for i in self.server.feed.since(0) if i["event"] == "line"
                           and i["data"]["line_id"] == nudge["line_id"] and i["data"]["final"]]
                self.assertEqual(final["cancelled"], not voiced)
                self.assertEqual((gate._count, set(gate._last), gate._last_any is not None),
                                 (1, {"comment"}, True) if voiced else (0, set(), False))

    def test_meeting_mode_silences_comments_until_it_is_off(self):
        self.server.proactive = Proactive(self.server.attention, self.server.gate, self.server.feed.publish,
                                          self.server.start_line, self.server.busy, judge=Judge(WantBackend()),
                                          spawn=lambda f: f())
        comments = lambda: [(i["data"]["speak"], i["data"]["gate"]) for i in self.server.feed.since(0)  # noqa: E731
                            if i["event"] == "nudge" and i["data"]["kind"] == "comment"]
        self.assertEqual(self.request("PUT", "/observation/meeting", {"on": True}), (200, {"meeting": True}))
        self.assertTrue(self.request("GET", "/state")[1]["observation"]["meeting"])
        now = time.time()
        for i in range(DWELL + 2):  # a meeting pauses observation: proactive sees no beat
            self.assertEqual(self.request("POST", "/context/attention", beat(now - DWELL - 1 + i, CODE)),
                             (200, {"paused": True}))
        self.assertEqual(comments(), [])
        self.assertEqual([i for i in self.server.feed.since(0) if i["event"] == "line"], [])
        self.assertEqual(self.request("PUT", "/observation/meeting", {"on": False}), (200, {"meeting": False}))
        self.assertFalse(self.request("GET", "/state")[1]["observation"]["meeting"])
        for i in range(DWELL + 2):
            self.request("POST", "/context/attention", beat(now + 1 + i, SAFARI))
        self.assertEqual(comments(), [(True, None)])
        self.assertTrue(test_turn.wait_for(lambda: not self.server._live_lines))

    def test_two_claims_at_once_start_one_line(self):
        self.server.mouth = test_server.FakeMouth(["好久", "没动了。"], delay=0.05)
        busy = self.server.busy
        self.server.busy = lambda: (busy(), time.sleep(0.05))[0]  # both claims look before either starts
        barrier, claimed = threading.Barrier(2), []

        def claim(line_id):
            barrier.wait()
            claimed.append((line_id, self.server.claim_line(line_id, "（主动搭话）")))

        threads = [threading.Thread(target=claim, args=(f"p{i}",)) for i in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(5)
        self.assertEqual(sorted(ok for _, ok in claimed), [False, True])
        [winner] = [line_id for line_id, ok in claimed if ok]
        deadline = time.monotonic() + 5
        while self.server._live_lines and time.monotonic() < deadline:
            time.sleep(0.01)
        lines = [i["data"] for i in self.server.feed.since(0) if i["event"] == "line"]
        self.assertEqual({line["line_id"] for line in lines}, {winner})
        self.assertFalse(any(line["cancelled"] for line in lines))
        # Idle again: the next claim starts its line.
        self.assertTrue(self.server.claim_line("p2", "（主动搭话）"))


if __name__ == "__main__":
    unittest.main()
