import base64
import http.client
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from observation.blacklist import Blacklist  # noqa: E402
from support import deny_blacklist  # noqa: E402
from observation.capture import (AX_MIN, IMAGE_TTL, MIN_INTERVAL, WINDOW_TEXT_FRESH, WINDOW_TEXT_MAX, Budget,  # noqa: E402
                     CaptureManager)
from character.feed import Feed  # noqa: E402
from infra.store import open_store  # noqa: E402
from observation.attention import AttentionStore  # noqa: E402
from daemon.agentd_server import AgentdServer  # noqa: E402
from daemon.main import build_capture  # noqa: E402
from support import serve_in_thread  # noqa: E402
from test_server import KernelLines, Script, ScriptedMouth  # noqa: E402

T0 = 1792300000.0
CODE = {"window_id": 2, "app": "Code", "bundle_id": "com.microsoft.VSCode", "title": "server.py"}
KEYCHAIN = {"window_id": 9, "app": "Keychain Access", "bundle_id": "com.apple.keychainaccess", "title": "login"}
LONG = "def main():\n" * 40


def text(window, body, source="ax", **extra):
    return {**window, "text": body, "source": source, "secure_input": False, "request_id": None, **extra}


class CountingRules:
    name = "rules"

    def __init__(self, need_image=False, next_check="2min"):
        self.calls, self.need_image, self.next_check = [], need_image, next_check

    def answer(self, state, questions):
        self.calls.append(state)
        return [{"id": "need_image", "value": self.need_image, "prob": 0.9},
                {"id": "next_check", "value": self.next_check, "prob": 0.9}]


class FakeVision:
    def __init__(self):
        self.images, self.users = [], []

    def describe(self, png, user):
        self.images.append(png)
        self.users.append(user)
        return "用户在看代码"


class GatedVision:
    """Each png's description waits until the test opens its gate; a description of None raises."""

    def __init__(self, texts):
        self.texts, self.gates = texts, {png: threading.Event() for png in texts}

    def describe(self, png, user):
        self.gates[png].wait(5)
        if self.texts[png] is None:
            raise RuntimeError("vision down")
        return self.texts[png]


def settle(predicate, seconds=1.0):
    deadline = time.monotonic() + seconds
    while not predicate() and time.monotonic() < deadline:
        time.sleep(0.01)


class BudgetTest(unittest.TestCase):
    def setUp(self):
        self.now = T0
        self.budget = Budget(clock=lambda: self.now)

    def spend(self, n, step):
        for _ in range(n):
            self.assertIsNone(self.budget.check())
            self.budget.spend()
            self.now += step

    def test_min_interval(self):
        self.spend(1, 29)
        self.assertEqual(self.budget.check(), "min_interval")
        self.now += 1
        self.assertIsNone(self.budget.check())

    def test_hourly_cap(self):
        self.spend(20, 30)
        self.assertEqual(self.budget.check(), "hourly_cap")
        self.now = T0 + 3600
        self.assertIsNone(self.budget.check())

    def test_daily_cap_holds_even_for_look(self):
        for hour in range(10):
            self.now = T0 + hour * 3600
            self.spend(20, 30)
        self.now = T0 + 10 * 3600
        self.assertEqual(self.budget.check(), "daily_cap")
        self.assertEqual(self.budget.check(look=True), "daily_cap")
        self.now = T0 + 86400 + 1
        self.assertIsNone(self.budget.check())

    def test_look_skips_interval_and_hourly_cap(self):
        self.spend(20, 30)
        self.now -= 25
        self.assertEqual(self.budget.check(), "min_interval")
        self.assertIsNone(self.budget.check(look=True))


class BudgetStoreTest(unittest.TestCase):
    """In the shared store a reservation ends sent or released once, and a restart keeps the day."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.now = T0

    def budget(self, **limits):
        db = open_store(Path(self.tmp.name) / "agentd.sqlite")
        self.addCleanup(db.close)
        return Budget(clock=lambda: self.now, db=db, **limits)

    def test_sent_and_released_are_settled_once(self):
        budget = self.budget()
        budget.reserve("a", False)
        budget.reserve("b", False)
        self.assertEqual(budget.today(), {"used": 0, "reserved": 2, "released": 0, "limit": 200})
        budget.sent("a")
        budget.release("b")
        settled = {"used": 1, "reserved": 0, "released": 1, "limit": 200}
        self.assertEqual(budget.today(), settled)
        for again in (budget.sent, budget.release):
            again("a")
            again("b")
        self.assertEqual(budget.today(), settled)

    def test_released_reservation_gives_its_place_back(self):
        budget = self.budget(per_day=2)
        budget.reserve("a", True)
        budget.reserve("b", True)
        self.assertEqual(budget.check(look=True), "daily_cap")
        budget.release("b")
        self.assertIsNone(budget.check(look=True))
        budget.sent("b")  # already released: not charged after all
        budget.release("b")
        self.assertIsNone(budget.check(look=True))

    def test_restart_keeps_the_day(self):
        budget = self.budget(per_day=3)
        for request_id in ("a", "b", "c", "d"):
            budget.reserve(request_id, True)
            self.now += 1
        budget.sent("a")
        budget.sent("b")
        budget.release("c")
        budget.sent("d")
        self.assertEqual((budget.check(), budget.check(look=True)), ("daily_cap", "daily_cap"))
        before = budget.today()
        restarted = self.budget(per_day=3)
        self.assertEqual((restarted.check(), restarted.check(look=True)), ("daily_cap", "daily_cap"))
        self.assertEqual(restarted.today(), before)
        self.assertEqual(before, {"used": 3, "reserved": 0, "released": 1, "limit": 3})

    def test_restart_keeps_the_interval(self):
        budget = self.budget()
        budget.reserve("a", False)
        budget.sent("a")
        self.now += 10
        self.assertEqual(self.budget().check(), "min_interval")
        self.assertIsNone(Budget(clock=lambda: self.now).check())  # control: a fresh budget without the store

    def test_reservation_left_in_flight_by_an_exited_process_is_released_on_load(self):
        budget = self.budget(per_day=2)
        budget.reserve("old", True)
        self.now += IMAGE_TTL / 2
        budget.reserve("young", True)
        self.now += IMAGE_TTL / 2 + 1
        self.assertEqual(budget.check(look=True), "daily_cap")
        restarted = self.budget(per_day=2)
        # Request ids live only in the process that made them, so even the young one can never settle now.
        self.assertEqual(restarted.today(), {"used": 0, "reserved": 0, "released": 2, "limit": 2})
        self.assertIsNone(restarted.check(look=True))

    def test_look_still_skips_interval_and_hourly_cap(self):
        budget = self.budget(per_hour=1)
        budget.reserve("a", False)
        budget.sent("a")
        self.now += 1
        self.assertEqual(budget.check(), "min_interval")
        self.assertIsNone(budget.check(look=True))
        self.now += MIN_INTERVAL
        self.assertEqual(budget.check(), "hourly_cap")
        self.assertIsNone(budget.check(look=True))


class CaptureTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.now = T0
        self.feed = Feed()
        self.focus = dict(CODE)
        self.rules = CountingRules()
        self.log = Path(self.tmp.name) / "capture.jsonl"

    def manager(self, vision=None, share_text=None):
        return CaptureManager(self.feed, Blacklist(deny_blacklist(Path(self.tmp.name) / "blacklist.json")), lambda: self.focus,
                              self.log, clock=lambda: self.now, rules=self.rules, vision=vision, share_text=share_text)

    def requests(self):
        return [i["data"] for i in self.feed.since(0) if i["event"] == "request"]

    def log_lines(self):
        return [json.loads(l) for l in self.log.read_text(encoding="utf-8").splitlines()] if self.log.exists() else []

    def test_capture_log_retention_on_start_and_hourly(self):
        rows = [{"ts": self.now - 7 * 86400 - 1}, {"ts": self.now - 7 * 86400}, {"ts": self.now}]
        self.log.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
        m = self.manager()
        self.assertEqual(self.log_lines(), rows[1:])
        self.now += 3599
        m._log("test", 2, "test")
        self.assertEqual(self.log_lines()[0], rows[1])
        self.now += 1
        m._log("test", 2, "test")
        self.assertEqual(self.log_lines()[0], rows[2])

    def test_c1_only_delivered_images_count_for_the_period(self):
        for outcome in ("capture_failed", "permission_denied", "window_gone", "cancelled", "expired", "delivered"):
            with self.subTest(outcome=outcome):
                self.feed = Feed()
                self.rules.need_image = True
                m = self.manager(FakeVision())
                m.text(text(CODE, LONG))
                [request] = self.requests()
                self.assertFalse(m.windows[2]["image_taken"])
                self.now += MIN_INTERVAL + 1
                m.text(text(CODE, LONG + "pending"))
                self.assertEqual(len(self.requests()), 1)
                if outcome in ("capture_failed", "permission_denied", "window_gone"):
                    m.failure(request["request_id"], 2, outcome)
                elif outcome == "cancelled":
                    m.cancel(request["request_id"], "stopped")
                elif outcome == "expired":
                    self.now += IMAGE_TTL + 1
                    m.tick()
                else:
                    m.image(request["request_id"], 2, b"png")
                    settle(lambda: m.result(request["request_id"]) == "ready")
                self.assertEqual(m.windows[2]["image_taken"], outcome == "delivered")
                m.text(text(CODE, LONG + "retry"))
                self.assertEqual(len([r for r in self.requests() if r["mode"] == "image"]),
                                 1 if outcome == "delivered" else 2)

    def test_c2_visual_and_first_empty_samples_skip_ocr(self):
        for window, content in (({**CODE, "bundle_id": "com.figma.Desktop"}, "short"), (CODE, "")):
            with self.subTest(content=content):
                self.feed = Feed()
                self.focus = window
                m = CaptureManager(self.feed, Blacklist(deny_blacklist(Path(self.tmp.name) / "blacklist.json")), lambda: self.focus,
                                   self.log, clock=lambda: self.now, vision=FakeVision())
                m.text(text(window, content))
                self.assertEqual([r["mode"] for r in self.requests()], ["image"])

    def test_c3_unchanged_ax_preserves_its_ocr_text(self):
        m = self.manager()
        m.share_text = True
        m.text(text(CODE, "short"))
        [ocr] = self.requests()
        m.text(text(CODE, LONG, source="ocr", request_id=ocr["request_id"]))
        m.text(text(CODE, "short"))
        self.assertEqual(m.window_text()["text"], LONG)
        self.assertEqual([r["mode"] for r in self.requests()], ["ocr"])

    def test_c4_returning_to_an_old_sparse_ax_state_requests_ocr(self):
        m = self.manager(FakeVision())
        m.text(text(CODE, "short"))
        [ocr] = self.requests()
        m.text(text(CODE, LONG, source="ocr", request_id=ocr["request_id"]))
        m.text(text(CODE, LONG))
        m.text(text(CODE, "short"))
        self.assertEqual([r["mode"] for r in self.requests()], ["ocr", "ocr"])
        self.assertNotEqual(self.requests()[-1]["request_id"], ocr["request_id"])

    def test_c5_next_check_answers_keep_the_chain_running(self):
        for source, changed_title in (("ax", False), ("ocr", False), ("ocr", True)):
            with self.subTest(source=source, changed_title=changed_title):
                self.feed = Feed()
                self.focus = dict(CODE)
                m = self.manager()
                m.text(text(CODE, LONG))
                for round in range(2):
                    self.now += 120
                    m.tick()
                    self.assertEqual(len(self.requests()), round + 1)
                    request = self.requests()[-1]
                    if changed_title:
                        self.focus = {**CODE, "title": f"page-{round}"}
                    result = m.text(text(self.focus, LONG, source=source, request_id=request["request_id"]))
                    self.assertEqual(result, {"accepted": True})
                    self.assertEqual(m.due, (2, self.now + 120))

    def test_c6_sample_waits_for_focus_without_another_text_sample(self):
        for invalidation in (None, "old_focus", "front", "blocked", "epoch"):
            with self.subTest(invalidation=invalidation):
                self.feed = Feed()
                self.rules.calls.clear()
                self.rules.need_image = True
                self.focus = {**CODE, "window_id": 3} if invalidation == "old_focus" else None
                m = self.manager(FakeVision())
                m.text(text(CODE, LONG))
                m.tick()
                self.assertEqual(self.rules.calls, [])
                if invalidation == "blocked":
                    m.text(text(CODE, LONG, incognito=True))
                elif invalidation == "epoch":
                    m.clear()
                self.focus = {**CODE, "window_id": 3} if invalidation == "front" else dict(CODE)
                self.now += 5
                m.tick()
                m.tick()
                self.assertEqual(len(self.rules.calls), 1 if invalidation in (None, "old_focus") else 0)
                self.assertEqual(len(self.requests()), 1 if invalidation in (None, "old_focus") else 0)

    def test_c7_production_capture_uses_the_declared_app_category(self):
        for declared in ("action-games", "video", "graphics-design"):
            with self.subTest(declared=declared):
                self.feed = Feed()
                store = AttentionStore(Path(self.tmp.name) / f"{declared}.sqlite",
                                       Blacklist(deny_blacklist(Path(self.tmp.name) / "blacklist.json")), clock=lambda: self.now)
                self.addCleanup(store.close)
                window = {**CODE, "bundle_id": "test.unknown", "category": f"public.app-category.{declared}"}
                for second in range(7):
                    self.now += 1
                    store.ingest({"ts": self.now, "front": window, "mouse": None, "idle_s": 0.0})
                self.assertIsNotNone(store.focus())
                self.assertNotIn("category", store.focus())
                m = build_capture(self.feed, store, None, self.tmp.name, True, True)
                m.clock = lambda: self.now
                m.budget.clock = m.clock
                m.spawn = None
                m.text(text(window, LONG))
                self.assertEqual([r["mode"] for r in self.requests()], ["image"])

    def test_category_belongs_to_the_posted_window(self):
        store = AttentionStore(Path(self.tmp.name) / "early.sqlite", Blacklist(deny_blacklist(Path(self.tmp.name) / "blacklist.json")),
                               clock=lambda: self.now)
        self.addCleanup(store.close)
        video = {**CODE, "bundle_id": "test.unknown", "category": "public.app-category.video"}
        self.now += 1
        store.ingest({"ts": self.now, "front": video, "mouse": None, "idle_s": 0.0})
        self.assertIsNone(store.focus())
        m = build_capture(self.feed, store, None, self.tmp.name, True, True)
        m.clock = lambda: self.now
        m.spawn = None
        m.text(text(video, "short"))
        self.assertNotIn("ocr", [r["mode"] for r in self.requests()], "a video window before its gaze dwell")
        self.feed = Feed()
        self.focus = {**video, "window_id": 3}
        m = CaptureManager(self.feed, Blacklist(deny_blacklist(Path(self.tmp.name) / "blacklist.json")), lambda: self.focus,
                           self.log, clock=lambda: self.now, vision=FakeVision())
        m.text(text(CODE, "short"))
        self.assertEqual([r["mode"] for r in self.requests()], ["ocr"], "a code window while another window has the gaze")

    def test_stale_ocr_for_an_unseen_window_leaves_look_working(self):
        m = self.manager(vision=FakeVision())
        self.assertEqual(m.text(text(CODE, 'x'*300, source='ocr', request_id='unknown')),
                         {"accepted": False, "reason": "stale_ocr"})
        self.assertEqual(m.look()[0], 202)

    def test_local_rules_readable_text_and_one_image_per_unreadable_document(self):
        m = CaptureManager(self.feed, Blacklist(deny_blacklist(Path(self.tmp.name) / 'blacklist.json')), lambda:self.focus,
                           self.log, clock=lambda:self.now, vision=FakeVision())
        m.text(text(CODE, 'x'*2000))
        self.assertEqual(self.requests(), [])
        m.text(text(CODE, 'x'*100))
        ocr = self.requests()[-1]
        self.assertEqual(ocr['mode'], 'ocr')
        m.text(text(CODE, '', source='ocr', request_id=ocr['request_id']))
        self.assertEqual(len([r for r in self.requests() if r['mode']=='image']), 1)
        self.now += 31
        m.text(text(CODE, 'y'*100))
        ocr = self.requests()[-1]
        m.text(text(CODE, '', source='ocr', request_id=ocr['request_id']))
        self.assertEqual(len([r for r in self.requests() if r['mode']=='image']), 1)
        self.assertEqual(m.look()[0], 202)
        self.assertEqual(m.look()[0], 202)
        self.now += 31
        self.focus = {**CODE, 'title':'another.py'}
        m.text(text(self.focus, 'z'*100))
        ocr = self.requests()[-1]
        m.text(text(self.focus, '', source='ocr', request_id=ocr['request_id']))
        self.assertEqual(len([r for r in self.requests() if r['mode']=='image' and r['reason']=='judge']), 2)

    def test_ocr_after_three_seconds_is_dropped_before_storage_or_judgment(self):
        m = CaptureManager(self.feed, Blacklist(deny_blacklist(Path(self.tmp.name) / 'blacklist.json')), lambda:self.focus,
                           self.log, clock=lambda:self.now, share_text=True, vision=FakeVision())
        m.text(text(CODE, 'x'*100))
        ocr = self.requests()[-1]
        self.now += 3.01
        result = m.text(text(CODE, 'late OCR text', source='ocr', request_id=ocr['request_id']))
        self.assertFalse(result['accepted'])
        self.assertEqual(m.window_text()['text'], 'x'*100)
        self.assertEqual(m.result(ocr['request_id']), 'expired')
        self.assertFalse(any(r['mode']=='image' for r in self.requests()))

    def test_visual_app_categories_request_images_even_with_readable_text(self):
        for extra in ({'bundle_id':'com.apple.ScreenSharing'}, {'bundle_id':'com.figma.Desktop'},
                      {'bundle_id':'com.colliderli.iina'}, {'category':'public.app-category.video'},
                      {'category':'public.app-category.action-games'}):
            with self.subTest(extra=extra):
                self.feed = Feed()
                self.focus = {**CODE, 'bundle_id':'test.unknown', **extra}
                m = CaptureManager(self.feed, Blacklist(deny_blacklist(Path(self.tmp.name) / 'blacklist.json')), lambda:self.focus,
                                   self.log, clock=lambda:self.now, vision=FakeVision())
                m.text(text(self.focus, 'x'*2000))
                self.assertTrue(any(r['mode']=='image' for r in self.requests()))

    def test_both_short_text_sources_need_image_but_readable_ocr_does_not(self):
        for count, expected in ((100, True), (200, False)):
            with self.subTest(count=count):
                self.feed = Feed()
                m = CaptureManager(self.feed, Blacklist(deny_blacklist(Path(self.tmp.name) / 'blacklist.json')), lambda:self.focus,
                                   self.log, clock=lambda:self.now, vision=FakeVision())
                m.text(text(CODE, 'a'*100))
                ocr = self.requests()[-1]
                m.text(text(CODE, 'b'*count, source='ocr', request_id=ocr['request_id']))
                self.assertEqual(any(r['mode']=='image' for r in self.requests()), expected)

    def test_missing_ocr_uses_local_rules_after_three_seconds_once(self):
        m = CaptureManager(self.feed, Blacklist(deny_blacklist(Path(self.tmp.name) / 'blacklist.json')), lambda:self.focus,
                           self.log, clock=lambda:self.now, vision=FakeVision())
        m.text(text(CODE, 'a'*100))
        self.now += 3.01
        m.tick()
        self.assertEqual(len([r for r in self.requests() if r['mode']=='image']), 1)
        self.now += 31
        m.tick()
        self.assertEqual(len([r for r in self.requests() if r['mode']=='image']), 1)

    def test_deleted_ocr_request_does_not_trigger_timeout_screenshot(self):
        m = CaptureManager(self.feed, Blacklist(deny_blacklist(Path(self.tmp.name) / 'blacklist.json')), lambda:self.focus,
                           self.log, clock=lambda:self.now, vision=FakeVision())
        m.text(text(CODE, 'a'*100))
        self.assertEqual(m.forget_since(T0), 1)
        self.now += 3.01
        m.tick()
        self.assertFalse(any(r['mode']=='image' for r in self.requests()))

    def test_ocr_matches_request_window_document_and_ax_revision(self):
        for changed in ('window','document','revision'):
            with self.subTest(changed=changed):
                self.feed = Feed()
                m = CaptureManager(self.feed, Blacklist(deny_blacklist(Path(self.tmp.name) / 'blacklist.json')), lambda:self.focus,
                                   self.log, clock=lambda:self.now, share_text=True)
                m.text(text(CODE, 'a'*100))
                ocr = self.requests()[-1]
                current = {**CODE, 'title':'new.py'} if changed=='document' else CODE
                if changed != 'window': m.text(text(current, 'b'*100))
                body = text(current, 'wrong OCR', source='ocr', request_id=ocr['request_id'])
                if changed=='window': body['window_id']=9
                self.assertFalse(m.text(body)['accepted'])
                self.assertNotEqual(m.window_text()['text'], 'wrong OCR')

    def test_diagnostic_observation_is_bounded_and_distinguishes_current_from_history(self):
        class LongVision:
            def describe(self, png, user): return "测试内容" * 2000
        m = self.manager(LongVision())
        status, request = m.look()
        self.assertEqual(status, 202)
        request_id = request["request_id"]
        self.assertEqual(m.image(request_id, 2, b"png")[0], 202)
        settle(lambda: m.result(request_id) == "ready")
        detail = m.diagnostic_observation(request_id)
        self.assertTrue(detail["current"])
        self.assertTrue(detail["content_available"])
        self.assertTrue(detail["description_truncated"])
        self.assertEqual(len(detail["description"]), 4000)
        self.assertNotIn("_meta", m.observation(request_id))
        self.focus = {"window_id": 44, "app": "Endfield", "bundle_id": "local.agenticcomplex.companion"}
        self.assertFalse(m.diagnostic_observation(request_id)["current"])
        self.assertTrue(m.diagnostic_observation(request_id)["content_available"], "historical result stays labelled as history")
        m.blacklist.add("bundle_ids", CODE["bundle_id"])
        redacted = m.diagnostic_observation(request_id)
        self.assertIsNone(redacted["description"])
        self.assertFalse(redacted["content_available"])
        self.assertNotIn("_meta", m.observations[request_id], "policy changes also purge original window metadata")
        self.assertIsNone(m.diagnostic_observation("missing"))

    def test_control_panel_cannot_be_captured(self):
        m = self.manager(FakeVision())
        panel = {"window_id": 7, "app": "Endfield", "bundle_id": "local.agenticcomplex.companion", "title": "状态监控"}
        self.focus = panel
        self.assertEqual(m.text(text(panel, LONG)), {"accepted": False, "reason": "blacklisted"})
        self.assertEqual(m.look(), (409, {"error": "blocked", "reason": "blacklisted", "status": "declined"}))
        self.assertFalse(self.requests())

    def test_little_ax_text_asks_for_ocr_once_per_content(self):
        m = self.manager()
        self.assertEqual(m.text(text(CODE, "x" * (AX_MIN - 1))), {"accepted": True})
        m.text(text(CODE, "x" * (AX_MIN - 1)))
        self.assertEqual([(r["window_id"], r["mode"], r["reason"]) for r in self.requests()],
                         [(2, "ocr", "low_ax_text")])
        m.text(text(CODE, "y" * 10))
        m.text(text(CODE, LONG))
        self.assertEqual([r["mode"] for r in self.requests()], ["ocr", "ocr"])

    def test_unchanged_text_is_not_judged_again(self):
        m = self.manager()
        m.text(text(CODE, LONG))
        m.text(text(CODE, LONG))
        self.assertEqual(len(self.rules.calls), 1)
        m.text(text(CODE, LONG + "x"))
        self.assertEqual(len(self.rules.calls), 2)

    def test_async_capture_burst_keeps_one_worker_and_latest_text(self):
        m=self.manager(FakeVision());queued=[];m.spawn=queued.append
        for i in range(30):m.text(text(CODE,LONG+str(i)))
        self.assertEqual(len(queued),1)
        self.assertEqual(self.rules.calls,[])
        queued.pop()()
        self.assertEqual(len(self.rules.calls),1)
        self.assertEqual(self.rules.calls[0]["text_chars"],len((LONG+"29").strip()))
        self.assertFalse(m._text_deciding)

    def test_async_capture_focus_change_discards_old_image_escalation(self):
        m=self.manager(FakeVision());queued=[];m.spawn=queued.append
        self.rules.need_image=True
        m.text(text(CODE,LONG))
        self.focus=dict(KEYCHAIN)
        queued.pop()()
        self.assertEqual(self.rules.calls,[])
        self.assertEqual(self.requests(),[])
        self.assertIsNone(m.due)

    def test_blacklisted_or_secure_text_is_dropped(self):
        m = self.manager(FakeVision())
        self.rules.need_image = True
        self.assertEqual(m.text(text(KEYCHAIN, "")), {"accepted": False, "reason": "blacklisted"})
        self.assertEqual(m.text(text(CODE, "", secure_input=True)), {"accepted": False, "reason": "secure_input"})
        self.assertEqual((self.rules.calls, self.requests()), ([], []))
        self.assertEqual(m.look(), (409, {"error": "blocked", "reason": "secure_input", "status": "declined"}))
        self.focus = {"app": "<hidden>"}
        self.assertEqual(m.look(), (409, {"error": "blocked", "reason": "blacklisted", "status": "declined"}))

    def test_blacklisted_url_host_drops_text_and_image(self):
        m = self.manager(FakeVision())
        chrome = {"window_id": 4, "app": "Google Chrome", "bundle_id": "com.google.Chrome", "title": "账户"}
        self.assertEqual(m.text(text(chrome, LONG, url_host="mybank.icbc.com.cn")),
                         {"accepted": False, "reason": "blacklisted"})
        self.assertEqual(self.rules.calls, [])
        self.focus = dict(CODE)
        _, body = m.look()
        self.assertEqual(m.image(body["request_id"], 2, b"png", url_host="mybank.icbc.com.cn"),
                         (409, {"error": "blocked", "reason": "blacklisted", "status": "declined"}))
        self.assertEqual(m.observation(body["request_id"])["reason"], "blacklisted")
        # Control: an ordinary host goes through.
        self.assertEqual(m.text(text(chrome, LONG, url_host="github.com")), {"accepted": True})
        _, body = m.look()
        self.assertEqual(m.image(body["request_id"], 2, b"png", url_host="github.com"),
                         (202, {"accepted": True, "request_id": body["request_id"], "status": "pending"}))

    def test_incognito_window_is_dropped_and_never_requested(self):
        m = self.manager(FakeVision())
        self.rules.need_image = True
        self.assertEqual(m.text(text(CODE, "x", incognito=True)), {"accepted": False, "reason": "incognito"})
        self.assertEqual((self.rules.calls, self.requests()), ([], []))
        self.assertEqual(m.look(), (409, {"error": "blocked", "reason": "incognito", "status": "declined"}))
        m.text(text(CODE, LONG))
        self.now += 3600
        _, body = m.look()
        m.text(text(CODE, "x", incognito=True))
        self.assertEqual(m.image(body["request_id"], 2, b"png"),
                         (409, {"error": "blocked", "reason": "incognito", "status": "declined"}))
        before = len(self.requests())
        self.now += 3600
        m.tick()
        self.assertEqual(len(self.requests()), before)

    def test_secure_input_heartbeat_blocks_everything_until_cleared(self):
        m = self.manager(FakeVision())
        self.rules.need_image = True
        m.text(text(CODE, LONG))
        [pending] = self.requests()
        m.secure_input(True)
        self.assertEqual(m.text(text(CODE, "x")), {"accepted": False, "reason": "secure_input"})
        self.assertEqual(m.look(), (409, {"error": "blocked", "reason": "secure_input", "status": "declined"}))
        # Secure input turning on cancelled the open request.
        self.assertEqual(m.image(pending["request_id"], 2, b"png"), (404, {"error": "unknown_request"}))
        self.now += 3600
        m.tick()
        self.assertEqual(len(self.requests()), 1)
        m.secure_input(False)
        self.assertEqual(m.text(text(CODE, "x")), {"accepted": True})
        self.assertEqual(m.look()[0], 202)

    def test_window_turning_blacklisted_blocks_a_pending_image(self):
        m = self.manager(FakeVision())
        _, body = m.look()
        m.text(text({**CODE, "bundle_id": "com.apple.keychainaccess"}, "x"))
        self.assertEqual(m.image(body["request_id"], 2, b"png"),
                         (409, {"error": "blocked", "reason": "blacklisted", "status": "declined"}))

    def test_next_check_asks_for_text_again(self):
        m = self.manager()
        m.text(text(CODE, LONG))
        self.now += 119
        m.tick()
        self.assertEqual(self.requests(), [])
        self.now += 1
        m.tick()
        m.tick()
        self.assertEqual([(r["window_id"], r["mode"], r["reason"]) for r in self.requests()],
                         [(2, "text", "next_check")])
        self.rules.next_check = "never"
        m.text(text(CODE, LONG + "x"))
        self.now += 3600
        m.tick()
        self.assertEqual(len(self.requests()), 1)

    def test_without_vision_no_image_is_ever_requested(self):
        m = self.manager()
        self.rules.need_image = True
        m.text(text(CODE, LONG))
        self.assertEqual(self.requests(), [])
        self.assertEqual(m.look(), (409, {"error": "vision_off", "status": "unavailable"}))
        self.assertEqual(m.image("nope", 2, b"png"), (404, {"error": "unknown_request"}))

    def test_judged_image_within_budget_reaches_vision(self):
        vision = FakeVision()
        m = self.manager(vision)
        self.rules.need_image = True
        m.text(text(CODE, LONG))
        [request] = self.requests()
        self.assertEqual((request["mode"], request["reason"]), ("image", "judge"))
        m.text(text(CODE, LONG + "x"))
        self.assertEqual(len(self.requests()), 1)
        self.assertEqual(m.image(request["request_id"], 3, b"png"), (404, {"error": "unknown_request"}))
        self.assertEqual(m.image(request["request_id"], 2, b"png"),
                         (202, {"accepted": True, "request_id": request["request_id"], "status": "pending"}))
        self.assertEqual(m.image(request["request_id"], 2, b"png"), (404, {"error": "unknown_request"}))
        deadline = time.monotonic() + 5
        while m.view() is None and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual((vision.images, vision.users, m.view()["text"]), ([b"png"], [False], "用户在看代码"))
        reasons = [(l["event"], l.get("reason")) for l in self.log_lines()]
        self.assertEqual(reasons, [("request", "judge"), ("upload", "judge")])
        self.assertNotIn(LONG.strip(), self.log.read_text(encoding="utf-8"))

    def test_look_and_expiry(self):
        m = self.manager(FakeVision())
        status, body = m.look()
        self.assertEqual(status, 202)
        self.assertEqual(self.requests()[-1]["reason"], "look")
        self.now += IMAGE_TTL + 1
        self.assertEqual(m.image(body["request_id"], 2, b"png"), (404, {"error": "unknown_request"}))
        self.focus = None
        self.assertEqual(m.look(), (409, {"error": "no_focus", "status": "unavailable"}))

    def test_a_look_reaches_vision_as_the_users_and_a_refresh_does_not(self):
        vision = FakeVision()
        m = self.manager(vision, share_text=True)
        for ask in (lambda: (202, m.refresh(mode="image")), m.look, lambda: m.look(window_id=2, mode="image")):
            status, body = ask()
            self.assertEqual(status, 202)
            self.assertEqual(m.image(body["request_id"], 2, b"png")[0], 202)
            settle(lambda: m.result(body["request_id"]) == "ready")
        self.assertEqual(vision.users, [False, True, True])

    NOTES = {"window_id": 77, "app": "Notes", "bundle_id": "com.apple.Notes", "title": "清单"}

    def test_look_window_asks_that_window_for_its_text(self):
        m = self.manager(share_text=True)
        status, body = m.look(window_id=77)
        self.assertEqual((status, body), (202, {"request_id": body["request_id"], "status": "pending"}))
        [request] = self.requests()
        self.assertEqual((request["request_id"], request["window_id"], request["mode"], request["reason"]),
                         (body["request_id"], 77, "text", "look_window"))
        self.assertEqual(m.text(text(self.NOTES, LONG, request_id=body["request_id"])), {"accepted": True})
        seen = m.observation(body["request_id"])
        self.assertEqual((seen["status"], seen["text"]), ("ready", LONG))
        self.assertNotIn("_look_window", seen)

    def test_look_window_answered_by_a_blacklisted_window_keeps_no_text(self):
        m = self.manager(share_text=True)
        _, body = m.look(window_id=77)
        panel = {**self.NOTES, "app": "Endfield", "bundle_id": "local.agenticcomplex.companion"}
        self.assertEqual(m.text(text(panel, LONG, request_id=body["request_id"])),
                         {"accepted": False, "reason": "blacklisted"})
        seen = m.observation(body["request_id"])
        self.assertEqual((seen["status"], seen["reason"], seen["text"]), ("declined", "blacklisted", None))

    def test_look_window_answered_with_another_windows_text_keeps_no_text(self):
        m = self.manager(share_text=True)
        _, body = m.look(window_id=77)
        m.text(text({**self.NOTES, "window_id": 78}, LONG, request_id=body["request_id"]))
        self.assertIsNone(m.observation(body["request_id"])["text"])

    def test_look_window_text_failure_settles_at_once(self):
        m = self.manager(share_text=True)
        _, body = m.look(window_id=77)
        self.assertEqual(m.failure(body["request_id"], 2, "ax_empty"), (404, {"error": "unknown_request"}))
        self.assertEqual(m.failure(body["request_id"], 77, "ax_empty"),
                         (200, {"request_id": body["request_id"], "status": "unavailable"}))
        seen = m.observation(body["request_id"])
        self.assertEqual((seen["status"], seen["reason"]), ("unavailable", "ax_empty"))

    def test_look_window_without_window_text_asks_for_nothing(self):
        m = self.manager(FakeVision())
        self.assertEqual(m.look(window_id=77), (409, {"error": "permission_unavailable", "status": "unavailable"}))
        self.assertEqual(self.requests(), [])

    def test_look_window_image_asks_that_window_for_an_image(self):
        m = self.manager(FakeVision(), share_text=True)
        status, body = m.look(window_id=77, mode="image")
        self.assertEqual(status, 202)
        [request] = self.requests()
        self.assertEqual((request["window_id"], request["mode"], request["reason"]), (77, "image", "look_window"))
        self.assertEqual(self.manager(share_text=True).look(window_id=77, mode="image"),
                         (409, {"error": "vision_off", "status": "unavailable"}))

    def test_recent_focus_window_text_only_when_shared(self):
        plain = self.manager()  # no model backend: --share-window-text is off
        plain.text(text(CODE, LONG))
        self.assertIsNone(plain.window_text())
        m = CaptureManager(self.feed, Blacklist(deny_blacklist(Path(self.tmp.name) / "blacklist.json")), lambda: self.focus,
                           self.log, clock=lambda: self.now, rules=self.rules, backend=CountingRules())
        m.text(text(CODE, "x" * 5000))
        self.assertEqual(m.window_text(), {"app": "Code", "title": "server.py", "text": "x" * 5000})
        self.focus = dict(KEYCHAIN)
        self.assertIsNone(m.window_text())  # another window has the focus
        self.focus = dict(CODE)
        m.secure_input(True)
        self.assertIsNone(m.window_text())
        m.secure_input(False)
        self.now += WINDOW_TEXT_FRESH + 1
        self.assertIsNone(m.window_text())
        m.text(text(CODE, "x" * 5000))  # unchanged text seen again is fresh again
        self.assertIsNotNone(m.window_text())

    def test_forget_since_drops_later_requests_view_and_window_text(self):
        notes = {"window_id": 4, "app": "Notes", "bundle_id": "com.apple.Notes", "title": "n"}
        m = CaptureManager(self.feed, Blacklist(deny_blacklist(Path(self.tmp.name) / "blacklist.json")), lambda: self.focus,
                           self.log, clock=lambda: self.now, rules=self.rules, backend=CountingRules(),
                           vision=FakeVision())
        m.text(text(notes, LONG))
        m.text(text(CODE, "x" * 10))
        [early] = list(m.observations)
        self.now += 1000
        m.text(text(CODE, LONG))
        _, late = m.look()
        m.image(late["request_id"], 2, b"png")
        settle(lambda: m.view() is not None)
        self.assertIsNotNone(m.view())
        self.assertEqual(m.forget_since(T0 + 500), 1)
        self.assertEqual((m.observation(late["request_id"]), m.view(), m.window_text()), (None, None, None))
        self.assertIsNotNone(m.observation(early))
        self.assertEqual(("text" in m.windows[4], "text" in m.windows[2]), (True, False))
        self.assertNotIn(late["request_id"], m.latest.values())

    def test_window_turning_secure_blocks_a_pending_image(self):
        m = self.manager(FakeVision())
        _, body = m.look()
        m.text(text(CODE, "", secure_input=True))
        self.assertEqual(m.image(body["request_id"], 2, b"png"),
                         (409, {"error": "blocked", "reason": "secure_input", "status": "declined"}))

    def test_late_view_of_an_older_window_does_not_replace_the_focus_view(self):
        vision = GatedVision({b"one": "窗口一", b"two": "窗口二"})
        m = self.manager(vision)
        self.focus = {"window_id": 1, "app": "Safari", "bundle_id": "com.apple.Safari", "title": "新闻"}
        _, first = m.look()
        self.focus = dict(CODE)
        _, second = m.look()
        m.image(first["request_id"], 1, b"one")
        m.image(second["request_id"], 2, b"two")
        vision.gates[b"two"].set()
        settle(lambda: m.view() is not None)
        self.assertEqual(m.view()["text"], "窗口二")
        vision.gates[b"one"].set()
        settle(lambda: (m.view() or {}).get("text") == "窗口一")
        self.assertEqual(m.view()["text"], "窗口二")

    def test_failed_vision_drops_the_old_view(self):
        vision = GatedVision({b"ok": "用户在看代码", b"bad": None})
        m = self.manager(vision)
        vision.gates[b"ok"].set()
        _, body = m.look()
        m.image(body["request_id"], 2, b"ok")
        settle(lambda: m.view() is not None)
        self.assertEqual(m.view()["text"], "用户在看代码")
        _, body = m.look()
        m.image(body["request_id"], 2, b"bad")
        vision.gates[b"bad"].set()
        settle(lambda: m.view() is None)
        self.assertIsNone(m.view())

    def test_result_follows_each_request(self):
        vision = GatedVision({b"ok": "用户在看代码", b"bad": None})
        m = self.manager(vision)
        _, ok = m.look()
        _, bad = m.look()
        _, late = m.look()
        self.assertEqual([m.result(r["request_id"]) for r in (ok, bad, late)], ["pending"] * 3)
        m.image(ok["request_id"], 2, b"ok")
        m.image(bad["request_id"], 2, b"bad")
        self.assertEqual(m.result(ok["request_id"]), "pending")  # image in, description not back yet
        vision.gates[b"ok"].set()
        vision.gates[b"bad"].set()
        settle(lambda: m.result(bad["request_id"]) != "pending")
        settle(lambda: m.result(ok["request_id"]) != "pending")
        self.assertEqual((m.result(ok["request_id"]), m.result(bad["request_id"])), ("ready", "failed"))
        self.now += IMAGE_TTL + 1
        self.assertEqual(m.result(late["request_id"]), "expired")
        m.tick()
        self.assertEqual((m.result(late["request_id"]), m.result("nope")), ("expired", "unknown"))

    def test_view_is_dropped_when_secure_input_turns_on_or_the_focus_moves(self):
        m = self.manager(FakeVision())
        _, body = m.look()
        m.image(body["request_id"], 2, b"png")
        settle(lambda: m.view() is not None)
        self.assertEqual(m.view()["window_id"], 2)
        m.secure_input(True)
        self.assertIsNone(m.view())
        m.secure_input(False)
        self.assertIsNone(m.view())  # dropped, not hidden: it does not come back
        _, body = m.look()
        m.image(body["request_id"], 2, b"png")
        settle(lambda: m.view() is not None)
        self.assertIsNotNone(m.view())  # control: a new look is shown
        self.focus = dict(KEYCHAIN)
        self.assertIsNone(m.view())
        self.focus = dict(CODE)
        m.text(text({**CODE, "bundle_id": "com.apple.keychainaccess"}, "x"))
        self.assertIsNone(m.view())

    def test_look_replies_carry_a_status(self):
        m = self.manager(FakeVision())
        status, body = m.look()
        self.assertEqual((status, body), (202, {"request_id": body["request_id"], "status": "pending"}))
        m.budget.times.extend([self.now] * 200)
        self.assertEqual(m.look(), (409, {"error": "daily_cap", "status": "unavailable"}))

    def test_each_request_is_an_observation_with_its_identity(self):
        m = self.manager(FakeVision())
        m.text(text(CODE, LONG))
        _, body = m.look()
        request_id = body["request_id"]
        self.assertEqual(m.observation(request_id),
                         {"request_id": request_id, "mode": "image", "purpose": "current", "window_id": 2,
                          "app": "Code", "requested_at": T0, "observed_at": None, "expires_at": T0 + IMAGE_TTL,
                          "policy_epoch": 0, "status": "pending", "reason": None, "text": None})
        self.now += 1
        m.image(request_id, 2, b"png")
        settle(lambda: m.result(request_id) != "pending")
        record = m.observation(request_id)
        self.assertEqual((record["status"], record["observed_at"], record["text"]), ("ready", T0 + 1, "用户在看代码"))
        self.assertIsNone(m.observation("nope"))

    def test_text_requests_are_settled_by_their_answer_or_expire(self):
        m = self.manager()
        m.text(text(CODE, "x" * (AX_MIN - 1)))
        [ocr] = self.requests()
        self.assertEqual(m.observation(ocr["request_id"])["mode"], "ocr")
        self.assertEqual(m.result(ocr["request_id"]), "pending")
        m.text(text(CODE, LONG, source="ocr", request_id=ocr["request_id"]))
        self.assertEqual(m.result(ocr["request_id"]), "ready")
        self.now += 120
        m.tick()
        [_, check] = self.requests()
        m.text(text(CODE, "x", incognito=True, request_id=check["request_id"]))
        record = m.observation(check["request_id"])
        self.assertEqual((record["mode"], record["status"], record["reason"]), ("text", "declined", "incognito"))
        m.text(text(CODE, "x" * (AX_MIN - 2)))  # a new OCR request nobody answers
        [*_, late] = self.requests()
        self.now += IMAGE_TTL + 1
        m.tick()
        self.assertEqual(m.result(late["request_id"]), "expired")

    def test_companion_failure_reports_settle_the_request(self):
        m = self.manager(FakeVision())
        for error, status in (("capture_failed", "failed"), ("permission_denied", "declined"),
                              ("window_gone", "unavailable")):
            _, body = m.look()
            self.assertEqual(m.failure(body["request_id"], 2, error),
                             (200, {"request_id": body["request_id"], "status": status}))
            self.assertEqual(m.observation(body["request_id"])["reason"], error)
            self.assertEqual(m.image(body["request_id"], 2, b"png"), (404, {"error": "unknown_request"}))
        self.assertEqual(m.failure("nope", 2, "capture_failed"), (404, {"error": "unknown_request"}))

    def test_a_ready_observation_stays_ready(self):
        m = self.manager(FakeVision())
        _, body = m.look()
        m.image(body["request_id"], 2, b"png")
        settle(lambda: m.result(body["request_id"]) != "pending")
        self.assertEqual(m.failure(body["request_id"], 2, "capture_failed"), (404, {"error": "unknown_request"}))
        self.now += IMAGE_TTL + 1
        m.tick()
        self.assertEqual(m.observation(body["request_id"])["status"], "ready")

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_policy_change_cancels_requests_in_flight(self):
        m = self.manager(FakeVision())
        _, body = m.look()
        m.secure_input(True)
        m.secure_input(False)
        self.assertEqual(m.image(body["request_id"], 2, b"png"), (404, {"error": "unknown_request"}))
        record = m.observation(body["request_id"])
        self.assertEqual((record["status"], record["reason"]), ("cancelled", "policy_changed"))
        _, body = m.look()
        self.assertEqual(m.observation(body["request_id"])["policy_epoch"], 1)
        path = Path(self.tmp.name) / "blacklist.json"
        path.write_text(json.dumps({**json.loads(path.read_text(encoding="utf-8")), "title_patterns": ["病历"]}), encoding="utf-8")
        self.assertIsNone(m.view())
        self.assertEqual(m.result(body["request_id"]), "cancelled")  # a reloaded blacklist is a policy change

    def test_only_an_uploaded_image_is_charged_in_the_store(self):
        db = open_store(Path(self.tmp.name) / "agentd.sqlite")
        self.addCleanup(db.close)
        m = CaptureManager(self.feed, Blacklist(deny_blacklist(Path(self.tmp.name) / "blacklist.json")), lambda: self.focus,
                           self.log, clock=lambda: self.now, rules=self.rules, vision=FakeVision(), budget_db=db)
        _, sent = m.look()
        self.assertEqual(m.budget.today(), {"used": 0, "reserved": 1, "released": 0, "limit": 200})
        m.image(sent["request_id"], 2, b"png")
        settle(lambda: m.result(sent["request_id"]) != "pending")
        _, failed = m.look()
        m.failure(failed["request_id"], 2, "capture_failed")
        _, cancelled = m.look()
        m.cancel(cancelled["request_id"], "stopped")
        _, withdrawn = m.look()
        m.secure_input(True)
        m.secure_input(False)
        _, expired = m.look()
        self.now += IMAGE_TTL + 1
        m.tick()
        self.assertEqual(m.failure(sent["request_id"], 2, "capture_failed"), (404, {"error": "unknown_request"}))
        self.assertEqual(m.budget.today(), {"used": 1, "reserved": 0, "released": 4, "limit": 200})

    def test_description_finished_after_a_policy_change_is_dropped(self):
        vision = GatedVision({b"png": "用户在看代码"})
        m = self.manager(vision)
        _, body = m.look()
        m.image(body["request_id"], 2, b"png")
        m.secure_input(True)
        vision.gates[b"png"].set()
        m.secure_input(False)
        settle(lambda: m.view() is not None, 0.3)
        self.assertIsNone(m.view())
        self.assertEqual(m.observation(body["request_id"])["status"], "cancelled")

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_a_window_blacklisted_while_vision_runs_is_not_read(self):
        vision = GatedVision({b"png": "用户在看代码"})
        m = self.manager(vision)
        _, body = m.look()
        m.image(body["request_id"], 2, b"png")
        # POST /blacklist without delete_existing: another instance writes the file, the manager is not told
        Blacklist(deny_blacklist(Path(self.tmp.name) / "blacklist.json")).add("bundle_id", CODE["bundle_id"])
        vision.gates[b"png"].set()
        settle(lambda: m.result(body["request_id"]) != "pending")
        self.assertIsNone(m.observation(body["request_id"])["text"])

    def test_a_deleted_view_leaves_no_text_behind(self):
        m = self.manager(FakeVision())
        _, body = m.look()
        m.image(body["request_id"], 2, b"png")
        settle(lambda: m.view() is not None)
        self.assertTrue(m.forget_view())
        self.assertIsNone(m.observation(body["request_id"])["text"])
        self.assertEqual([r["text"] for r in m.observations_snapshot()], [None])

    def mouth_context(self, m):
        store = AttentionStore(Path(self.tmp.name) / "attention.sqlite",
                               Blacklist(deny_blacklist(Path(self.tmp.name) / "blacklist.json")))
        self.addCleanup(store.close)
        scene = {"activity": "unknown", "confidence": 0.0, "subject": None, "facts": [], "mode": "other",
                 "state": "unknown", "thread": None, "on_mind": None, "blocker": None, "now": None}
        return AgentdServer._attention_context(SimpleNamespace(attention=store, sync_privacy=lambda: None, page_text_allowed=lambda: True, capture=m,
                                                               activity=lambda: scene))

    def test_probe_view_does_not_survive_secure_input_or_a_hidden_focus(self):
        self.now = time.time()  # the mouth's 300 s freshness uses the wall clock
        m = self.manager(FakeVision())
        for leave in ("secure_input", "hidden"):
            _, body = m.look()
            m.image(body["request_id"], 2, b"png")
            settle(lambda: m.view() is not None)
            self.assertIn("The user's window, just looked at: 用户在看代码", self.mouth_context(m))  # control
            if leave == "secure_input":
                m.secure_input(True)
                self.assertNotIn("用户在看代码", self.mouth_context(m))
                m.secure_input(False)
            else:
                self.focus = {"app": "<hidden>"}
            self.assertNotIn("用户在看代码", self.mouth_context(m))
            self.focus = dict(CODE)


HOOK, UI = "hook-token", "ui-token"


class RecordedMouth(ScriptedMouth):
    """Plays fake's chunks and records each stream in fake's bodies, after the capture requests before it."""

    def __init__(self, fake):
        super().__init__(Script(fake.chunks))
        self.fake = fake

    def stream(self, text, context):
        self.fake.bodies.append(("mouth", {}, {"stream": True, "context": context, "text": text}))
        yield from super().stream(text, context)
SECRET_TEXT, SECRET_TITLE = "SECRET-WINDOW-TEXT", "SECRET-TITLE"


def png(width=100, height=80, tail=b"SECRET-PIXELS"):
    return (b"\x89PNG\r\n\x1a\n" + (13).to_bytes(4, "big") + b"IHDR" + width.to_bytes(4, "big")
            + height.to_bytes(4, "big") + b"\x08\x02\x00\x00\x00" + tail)


def jpeg(width=100, height=80, marker=0xC0, tail=b"SECRET-PIXELS"):
    app0 = b"\xff\xe0" + (16).to_bytes(2, "big") + b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    frame = (bytes([0xFF, marker]) + (17).to_bytes(2, "big") + b"\x08" + height.to_bytes(2, "big")
             + width.to_bytes(2, "big") + b"\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01")
    return b"\xff\xd8" + app0 + frame + tail


class CaptureServerTest(unittest.TestCase):
    """With both share flags off no model request carries window text, titles or image bytes;
    the same steps with the flags on are the control that shows the probe can see them."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        answer = {"need_image": {"value": True, "prob": 0.9}, "next_check": {"value": "2min", "prob": 0.9}}
        # Model requests in the order they were made: (path, headers, body).
        self.fake = SimpleNamespace(text=json.dumps(answer), chunks=["[intent:explain]好。"], bodies=[])

    def start(self, share):
        attention = AttentionStore(Path(self.tmp.name) / "attention.sqlite",
                                   Blacklist(deny_blacklist(Path(self.tmp.name) / "blacklist.json")))
        self.addCleanup(attention.close)
        self.server = AgentdServer(("127.0.0.1", 0), HOOK, UI, mouth=RecordedMouth(self.fake), attention=attention)
        self.server.character_agent = KernelLines(self.server)
        fake = self.fake
        def reply(**options):
            fake.bodies.append(("/v1/messages", {}, options))
            return fake.text
        class FixtureSemantics:
            # Records each request in fake.bodies, so they show what capture let out.
            def run(self, purpose, instructions, evidence, *, valid=lambda:True, image=None, validate_output=None):
                if image is not None:
                    return {'value':{'description':reply(max_tokens=200, messages=[{"role": "user", "content": [
                        {"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                                     "data": base64.b64encode(image).decode()}},
                        {"type": "text", "text": "describe the window"}]}]).strip()[:300]}}
                state = {**evidence['state'], **(evidence.get('private') or {})}
                data = json.loads(reply(max_tokens=1024, messages=[{"role": "user", "content": json.dumps(
                    {"state": state, "questions": evidence['questions']}, ensure_ascii=False)}]))
                return {'value':{'answers':[{"id": q["id"], **data[q["id"]]} for q in evidence['questions']]}}
        self.server.capture = build_capture(self.server.feed, attention, FixtureSemantics(), self.tmp.name, share, share)
        serve_in_thread(self.server)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def post(self, path, body):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=10)
        conn.request("POST", path, json.dumps(body).encode(),
                     {"Authorization": f"Bearer {UI}", "Content-Type": "application/json"})
        response = conn.getresponse()
        data = json.loads(response.read() or b"null")
        conn.close()
        return response.status, data

    def wait_for(self, predicate):
        deadline = time.monotonic() + 10
        while not predicate() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(predicate())

    def test_observation_detail_ui_only_and_policy_revocation(self):
        self.start(share=True)
        self.focus_code()
        self.server.capture.vision = FakeVision()
        status, request = self.post("/look", {})
        self.assertEqual(status, 202)
        request_id = request["request_id"]
        self.assertEqual(self.post("/context/image", {"request_id": request_id, "window_id": 2,
            "png_base64": base64.b64encode(png()).decode()})[0], 202)
        self.wait_for(lambda: self.server.capture.result(request_id) == "ready")
        self.server._assembled = (time.time(), [{"type": "view", "observation_id": request_id}])

        def get(token):
            conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
            conn.request("GET", "/diag/observations/" + request_id, headers={"Authorization": "Bearer " + token})
            response = conn.getresponse(); body = json.load(response); code = response.status; conn.close()
            return code, body
        self.assertEqual(get(HOOK)[0], 401)
        code, detail = get(UI)
        self.assertEqual(code, 200)
        self.assertEqual(detail["description"], "用户在看代码")
        self.assertTrue(detail["current"])
        self.assertTrue(detail["used_in_last_turn"])
        self.assertNotIn("SECRET-PIXELS", json.dumps(detail))
        self.server.capture.vision = None  # revoked capability removes the description on the next request
        self.assertIsNone(get(UI)[1]["description"])

    def run_steps(self, share):
        self.start(share)
        window = {**CODE, "title": SECRET_TITLE}
        now = time.time()
        for i in range(9):
            self.assertEqual(self.post("/context/attention", {"ts": now - 8 + i, "front": window, "mouse": None,
                                                              "idle_s": 0.0})[0], 200)
        self.assertEqual(self.post("/context/text", text(window, SECRET_TEXT)), (202, {"accepted": True}))
        [ocr] = [i["data"] for i in self.server.feed.since(0)
                 if i["event"] == "request" and i["data"]["mode"] == "ocr"]
        self.assertEqual(self.post("/context/text", text(window, SECRET_TEXT, source="ocr",
                                                       request_id=ocr["request_id"])),
                         (202, {"accepted": True}))
        judge_log = Path(self.tmp.name) / "capture-judge.jsonl"
        self.wait_for(lambda: judge_log.exists() and '"need_image"' in judge_log.read_text(encoding="utf-8"))
        self.assertTrue(all(json.loads(line)["backend"] == "rules" for line in judge_log.read_text(encoding="utf-8").splitlines()))
        status, look = self.post("/look", {})
        image = base64.b64encode(png()).decode()
        if share:
            self.assertEqual(status, 202)
            self.assertEqual(look, {"request_id": look["request_id"], "status": "pending"})
            self.assertEqual(self.post("/context/image", {"request_id": look["request_id"], "window_id": 2,
                                                          "png_base64": image}),
                             (202, {"accepted": True, "request_id": look["request_id"], "status": "pending"}))
            self.wait_for(lambda: self.server.capture.view() is not None)
        else:
            self.assertEqual((status, look), (409, {"error": "vision_off", "status": "unavailable"}))
        self.assertEqual(self.post("/say", {"text": "你好"})[0], 202)
        self.wait_for(lambda: any(body.get("stream") for _, _, body in self.fake.bodies))
        sent = json.dumps([body for _, _, body in self.fake.bodies], ensure_ascii=False)
        # Judge and capture logs are on disk: window text and titles never go there, flags on or off.
        logs = "".join((Path(self.tmp.name) / name).read_text(encoding="utf-8") for name in ("capture-judge.jsonl", "capture.jsonl")
                       if (Path(self.tmp.name) / name).exists())
        self.assertIn('"need_image"', logs)
        for secret in (SECRET_TEXT, SECRET_TITLE, image):
            self.assertNotIn(secret, logs)
        modes = [i["data"]["mode"] for i in self.server.feed.since(0) if i["event"] == "request"]
        return sent, image, modes

    def test_flags_off_send_no_window_text_or_image(self):
        sent, image, modes = self.run_steps(share=False)
        for secret in (SECRET_TEXT, SECRET_TITLE, image, '"type": "image"'):
            self.assertNotIn(secret, sent)
        self.assertNotIn("image", modes)

    def test_flags_on_control_sends_them(self):
        sent, image, modes = self.run_steps(share=True)
        for secret in (SECRET_TEXT, SECRET_TITLE, image, '"type": "image"', "The user's window, just looked at"):
            self.assertIn(secret, sent)
        self.assertIn("image", modes)
        mouth = json.dumps([body for _, _, body in self.fake.bodies if body.get("stream")], ensure_ascii=False)
        self.assertIn(SECRET_TEXT, mouth)  # the recent window text reaches the mouth, not only the judge

    def focus_code(self):
        now = time.time()
        for i in range(9):
            self.post("/context/attention", {"ts": now - 8 + i, "front": CODE, "mouse": None, "idle_s": 0.0})

    def stream_bodies(self):
        return [i for i, (_, _, body) in enumerate(self.fake.bodies) if body.get("stream")]

    def test_voice_look_waits_for_the_view_then_answers(self):
        self.start(share=True)
        self.focus_code()
        status, body = self.post("/say", {"text": "你看看这个", "source": "voice"})
        self.assertEqual((status, body.get("command")), (202, "look"))
        self.wait_for(lambda: any(i["event"] == "request" for i in self.server.feed.since(0)))
        [request] = [i["data"] for i in self.server.feed.since(0) if i["event"] == "request"]
        time.sleep(0.3)
        self.assertEqual(self.stream_bodies(), [])  # no answer before the image is in
        self.assertEqual(self.post("/context/image", {"request_id": request["request_id"], "window_id": 2,
                                                      "png_base64": base64.b64encode(png()).decode()})[0], 202)
        self.wait_for(self.stream_bodies)
        [index] = self.stream_bodies()
        self.assertIn("The user's window, just looked at", json.dumps(self.fake.bodies[index][2], ensure_ascii=False))
        self.assertEqual(self.fake.bodies[index - 1][2]["messages"][0]["content"][0]["type"], "image")

    def test_voice_look_stopped_before_the_view_calls_no_model(self):
        self.start(share=True)
        self.focus_code()
        self.assertEqual(self.post("/say", {"text": "看一下", "source": "voice"})[0], 202)
        self.wait_for(lambda: any(i["event"] == "request" for i in self.server.feed.since(0)))
        self.assertEqual(self.post("/say", {"text": "停下", "source": "voice"}), (200, {"command": "stop"}))
        self.wait_for(lambda: any(i["event"] == "line" and i["data"]["final"] for i in self.server.feed.since(0)))
        [line] = [i["data"] for i in self.server.feed.since(0) if i["event"] == "line"]
        self.assertTrue(line["cancelled"])
        time.sleep(0.3)
        self.assertEqual(self.stream_bodies(), [])
        # Control: the lock is free, so the next line streams.
        self.assertEqual(self.post("/say", {"text": "你好"})[0], 202)
        self.wait_for(self.stream_bodies)

    def look_once(self):
        _, look = self.post("/look", {})
        self.assertEqual(self.post("/context/image", {"request_id": look["request_id"], "window_id": 2,
                                                      "png_base64": base64.b64encode(png()).decode()})[0], 202)
        self.wait_for(lambda: self.server.capture.view() is not None)

    def requests(self):
        return [i["data"] for i in self.server.feed.since(0) if i["event"] == "request"]

    def test_refused_look_answers_without_the_old_view(self):
        self.start(share=True)
        self.focus_code()
        self.look_once()
        self.server.capture.budget.times.extend([time.time()] * 200)  # the daily cap is reached
        self.assertEqual(self.post("/say", {"text": "看一下", "source": "voice"})[0], 202)
        self.wait_for(self.stream_bodies)
        [index] = self.stream_bodies()
        sent = json.dumps(self.fake.bodies[index][2], ensure_ascii=False)
        self.assertNotIn("The user's window, just looked at", sent)
        self.assertIn("Could not see the user's window this time (reason: daily_cap)", sent)

    def test_each_look_waits_for_its_own_request(self):
        self.start(share=True)
        self.focus_code()
        self.assertEqual(self.post("/say", {"text": "看一下", "source": "voice"})[0], 202)
        self.wait_for(lambda: len(self.requests()) == 1)
        self.assertEqual(self.post("/say", {"text": "看一下", "source": "voice"})[0], 202)
        self.wait_for(lambda: len(self.requests()) == 2)
        first, second = self.requests()
        image = base64.b64encode(png()).decode()
        self.assertEqual(self.post("/context/image", {"request_id": first["request_id"], "window_id": 2,
                                                      "png_base64": image})[0], 202)
        self.wait_for(lambda: '"type": "image"' in json.dumps([body for _, _, body in self.fake.bodies]))
        time.sleep(0.3)
        self.assertEqual(self.stream_bodies(), [])  # the older look's description does not answer the newer line
        self.assertEqual(self.post("/context/image", {"request_id": second["request_id"], "window_id": 2,
                                                      "png_base64": image})[0], 202)
        self.wait_for(self.stream_bodies)
        [index] = self.stream_bodies()
        self.assertIn("The user's window, just looked at", json.dumps(self.fake.bodies[index][2], ensure_ascii=False))

    def test_delete_attention_drops_the_view(self):
        self.start(share=True)
        self.focus_code()
        self.look_once()
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=10)
        conn.request("DELETE", "/attention", headers={"Authorization": f"Bearer {UI}"})
        self.assertEqual(conn.getresponse().status, 200)
        conn.close()
        self.assertIsNone(self.server.capture.view())

    def test_delete_attention_cancels_requests_in_flight(self):
        self.start(share=True)
        self.focus_code()
        self.look_once()
        _, look = self.post("/look", {})
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=10)
        conn.request("DELETE", "/attention", headers={"Authorization": f"Bearer {UI}"})
        self.assertEqual(conn.getresponse().status, 200)
        conn.close()
        self.assertIsNone(self.server.capture.view())
        self.assertEqual(self.server.capture.result(look["request_id"]), "cancelled")
        self.assertEqual(self.post("/context/image", {"request_id": look["request_id"], "window_id": 2,
                                                      "png_base64": base64.b64encode(png()).decode()}),
                         (404, {"error": "unknown_request"}))

    def test_failure_report_answers_at_once_without_the_old_view(self):
        self.start(share=True)
        self.focus_code()
        self.look_once()
        self.assertEqual(self.post("/say", {"text": "看一下", "source": "voice"})[0], 202)
        self.wait_for(lambda: len(self.requests()) == 2)
        request_id = self.requests()[-1]["request_id"]
        reported = time.monotonic()
        failure = {"request_id": request_id, "window_id": 2, "error": "capture_failed"}
        self.assertEqual(self.post("/context/image", {**failure, "error": "nope"}), (400, {"error": "invalid_payload"}))
        self.assertEqual(self.post("/context/image", failure), (200, {"request_id": request_id, "status": "failed"}))
        self.wait_for(self.stream_bodies)
        self.assertLess(time.monotonic() - reported, 5)
        [index] = self.stream_bodies()
        sent = json.dumps(self.fake.bodies[index][2], ensure_ascii=False)
        self.assertIn("Could not see the user's window this time (reason: capture_failed)", sent)
        self.assertNotIn("The user's window, just looked at", sent)

    def focus_on(self, window, start):
        for i in range(9):
            self.post("/context/attention", {"ts": start + i, "front": window, "mouse": None, "idle_s": 0.0})

    def test_newer_window_look_gets_only_its_own_description(self):
        self.start(share=True)
        first, second = png(tail=b"A"), png(tail=b"B")
        vision = self.server.capture.vision = GatedVision({first: "DESCRIBED-WINDOW-A", second: "DESCRIBED-WINDOW-B"})
        safari = {"window_id": 1, "app": "Safari", "bundle_id": "com.apple.Safari", "title": "新闻"}
        now = time.time()
        self.focus_on(safari, now - 8)
        self.assertEqual(self.post("/say", {"text": "看一下", "source": "voice"})[0], 202)
        self.wait_for(lambda: len(self.requests()) == 1)
        self.focus_on(CODE, now + 1)
        self.assertEqual(self.post("/say", {"text": "看一下", "source": "voice"})[0], 202)
        self.wait_for(lambda: len(self.requests()) == 2)
        a, b = self.requests()
        self.assertEqual((a["window_id"], b["window_id"]), (1, 2))
        for request, window_id, image in ((b, 2, second), (a, 1, first)):
            self.assertEqual(self.post("/context/image", {"request_id": request["request_id"], "window_id": window_id,
                                                          "png_base64": base64.b64encode(image).decode()})[0], 202)
        vision.gates[second].set()
        vision.gates[first].set()
        self.wait_for(self.stream_bodies)
        [index] = self.stream_bodies()
        sent = json.dumps(self.fake.bodies[index][2], ensure_ascii=False)
        self.assertIn("The user's window, just looked at: DESCRIBED-WINDOW-B", sent)
        self.assertNotIn("DESCRIBED-WINDOW-A", sent)

    def say_and_wait(self, words):
        count = len(self.stream_bodies())
        self.assertEqual(self.post("/say", {"text": words})[0], 202)
        self.wait_for(lambda: len(self.stream_bodies()) == count + 1)
        return json.dumps(self.fake.bodies[self.stream_bodies()[-1]][2], ensure_ascii=False)

    def test_page_text_reaches_the_mouth_only_with_the_switch(self):
        self.start(share=False)
        store, now = self.server.attention, time.time()
        page = lambda ts, kind, host, title, **text: store.ingest_browser(
            {"type": kind, "ts": ts, "url_host": host, "title": title, "audible": False, **text})
        page(now - 3000, "page", "docs.python.org", "旧页", text="OLD-PAGE-TEXT")
        page(now - 3000, "heartbeat", "docs.python.org", "旧页")
        page(now - 10, "page", "github.com", "PR", text="CURRENT-PAGE-TEXT")
        page(now - 5, "heartbeat", "github.com", "PR")
        said = {}
        for share in (False, True):
            self.server.share_page_text = share
            said[share] = (self.say_and_wait("你好"), self.say_and_wait("刚才那页讲了什么"))
        for sent in said[False]:
            self.assertNotIn("CURRENT-PAGE-TEXT", sent)
            self.assertNotIn("OLD-PAGE-TEXT", sent)
        plain, recall = said[True]
        self.assertIn("Web page the user is reading (github.com ", plain)
        self.assertIn("): CURRENT-PAGE-TEXT", plain)
        self.assertNotIn("OLD-PAGE-TEXT", plain)
        old = time.strftime("%H:%M", time.localtime(now - 3000))
        self.assertIn(f"Web page the user read at {old} (docs.python.org ", recall)
        self.assertIn("): OLD-PAGE-TEXT", recall)
        self.assertIn("CURRENT-PAGE-TEXT", recall)

    def test_look_withdrawn_after_it_was_ready_says_why(self):
        self.start(share=True)
        self.focus_code()
        _, look = self.post("/look", {})
        self.post("/context/image", {"request_id": look["request_id"], "window_id": 2,
                                     "png_base64": base64.b64encode(png()).decode()})
        self.wait_for(lambda: self.server.capture.result(look["request_id"]) == "ready")
        self.server.capture.secure_input(True)
        self.server.capture.secure_input(False)
        context = self.server.context("看一下", look["request_id"])
        self.assertIn("Could not see the user's window this time (reason: policy_changed)", context)
        self.assertNotIn("用户在看代码", context)

    def test_voice_look_without_vision_answers_at_once(self):
        self.start(share=False)
        self.focus_code()
        status, body = self.post("/say", {"text": "看一下", "source": "voice"})
        self.assertEqual((status, body.get("command")), (202, "look"))
        self.wait_for(self.stream_bodies)
        self.assertEqual([i for i in self.server.feed.since(0) if i["event"] == "request"], [])

    def test_say_with_look_waits_for_the_view_then_answers(self):
        self.start(share=True)
        self.focus_code()
        status, body = self.post("/say", {"text": "这个报错是什么意思", "look": True})
        self.assertEqual((status, body.get("command")), (202, "look"))
        self.wait_for(lambda: len(self.requests()) == 1)
        [request] = self.requests()
        time.sleep(0.3)
        self.assertEqual(self.stream_bodies(), [])  # no answer before the image is in
        self.assertEqual(self.post("/context/image", {"request_id": request["request_id"], "window_id": 2,
                                                      "png_base64": base64.b64encode(png()).decode()})[0], 202)
        self.wait_for(self.stream_bodies)
        [index] = self.stream_bodies()
        self.assertIn("The user's window, just looked at", json.dumps(self.fake.bodies[index][2], ensure_ascii=False))

    def test_say_with_look_window_answers_with_that_windows_text(self):
        self.start(share=True)
        self.focus_code()
        steps, step = [], self.server._step
        self.server._step = lambda trace, kind, span, **fields: (steps.append((kind, fields.get("attrs"))),
                                                                 step(trace, kind, span, **fields))[1]
        status, body = self.post("/say", {"text": "这里写了什么", "look_window": {"window_id": 77, "pid": 501}})
        self.assertEqual((status, body.get("command")), (202, "look"))
        self.wait_for(lambda: len(self.requests()) == 1)
        [request] = self.requests()
        self.assertEqual((request["window_id"], request["mode"], request["reason"]), (77, "text", "look_window"))
        self.assertEqual([attrs["mode"] for kind, attrs in steps if kind == "observation.requested"], ["text"])
        time.sleep(0.3)
        self.assertEqual(self.stream_bodies(), [])  # no answer before the text is in
        notes = {"window_id": 77, "app": "Notes", "bundle_id": "com.apple.Notes", "title": "清单"}
        self.assertEqual(self.post("/context/text", text(notes, "NOTES-WINDOW-TEXT " + LONG,
                                                         request_id=request["request_id"]))[0], 202)
        self.wait_for(self.stream_bodies)
        [index] = self.stream_bodies()
        self.assertIn("The user's window, just looked at: NOTES-WINDOW-TEXT", json.dumps(self.fake.bodies[index][2], ensure_ascii=False))

    def look_window_fails(self):
        self.focus_code()
        self.assertEqual(self.post("/say", {"text": "这里写了什么", "look_window": {"window_id": 77}})[0], 202)
        self.wait_for(lambda: len(self.requests()) == 1)
        request_id = self.requests()[0]["request_id"]
        self.assertEqual(self.post("/context/image", {"request_id": request_id, "window_id": 77, "error": "ax_empty"}),
                         (200, {"request_id": request_id, "status": "unavailable"}))

    def test_look_window_without_text_asks_for_an_image_within_the_look_wait(self):
        from unittest import mock
        from daemon import turns
        patcher = mock.patch.object(turns, "LOOK_WAIT", 2.0)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.start(share=True)
        said = time.monotonic()
        self.look_window_fails()
        self.wait_for(lambda: len(self.requests()) == 2)
        image = self.requests()[1]
        self.assertEqual((image["window_id"], image["mode"], image["reason"]), (77, "image", "look_window"))
        self.wait_for(self.stream_bodies)
        self.assertLess(time.monotonic() - said, turns.LOOK_WAIT + 1.5)
        [index] = self.stream_bodies()
        # The line waited for the image request, which never came back.
        self.assertIn("Could not see the user's window this time (reason: timeout)", json.dumps(self.fake.bodies[index][2], ensure_ascii=False))

    def test_look_window_without_text_or_screenshots_answers_at_once(self):
        self.start(share=True)
        self.server.capture.vision = None
        self.look_window_fails()
        reported = time.monotonic()
        self.wait_for(self.stream_bodies)
        self.assertLess(time.monotonic() - reported, 5)
        self.assertEqual(len(self.requests()), 1)
        [index] = self.stream_bodies()
        self.assertIn("Could not see the user's window this time (reason: ax_empty)", json.dumps(self.fake.bodies[index][2], ensure_ascii=False))

    def test_say_without_look_asks_for_no_image(self):
        self.start(share=True)
        self.focus_code()
        status, body = self.post("/say", {"text": "这个报错是什么意思"})
        self.assertEqual(status, 202)
        self.assertNotIn("command", body)
        self.wait_for(self.stream_bodies)
        self.assertEqual(self.requests(), [])

    def test_say_with_look_keeps_deterministic_commands(self):
        self.start(share=True)
        self.focus_code()
        self.assertEqual(self.post("/say", {"text": "停下", "look": True}), (200, {"command": "stop"}))
        self.assertEqual(self.requests(), [])

    def test_say_rejects_a_non_boolean_look(self):
        self.start(share=True)
        for look in ("true", 1, None):
            self.assertEqual(self.post("/say", {"text": "你好", "look": look}), (400, {"error": "invalid_look"}))

    def test_image_and_text_validation(self):
        self.start(share=True)
        self.assertEqual(self.post("/context/text", {**text(CODE, "x"), "source": "screen"})[0], 400)
        self.assertEqual(self.post("/context/text", {**text(CODE, "x"), "window_id": True})[0], 400)
        self.assertEqual(self.post("/context/text", {**text(CODE, "x"), "incognito": "yes"})[0], 400)
        for host in (5, "https://github.com/x"):
            self.assertEqual(self.post("/context/text", text(CODE, "x", url_host=host))[0], 400)
            self.assertEqual(self.post("/context/image", {"request_id": "r", "window_id": 2, "url_host": host,
                                                          "png_base64": base64.b64encode(png()).decode()})[0], 400)
        self.assertEqual(self.post("/context/text", text(CODE, "x", url_host="icbc.com.cn")),
                         (202, {"accepted": False, "reason": "blacklisted"}))
        self.assertEqual(self.post("/context/text", text(CODE, "x", incognito=True)),
                         (202, {"accepted": False, "reason": "incognito"}))
        self.assertEqual(self.post("/context/text", text(CODE, "字" * 20000))[0], 202)
        self.assertEqual(self.post("/context/text", text(CODE, "x" * (WINDOW_TEXT_MAX+1)))[0], 400)
        image = lambda data: {"request_id": "r", "window_id": 2, "png_base64": base64.b64encode(data).decode()}
        self.assertEqual(self.post("/context/image", image(b"GIF89a" + b"0" * 30)), (400, {"error": "invalid_payload"}))
        self.assertEqual(self.post("/context/image", {**image(png()), "png_base64": "%%%"})[0], 400)
        self.assertEqual(self.post("/context/image", image(png(width=16385))), (413, {"error": "too_large"}))
        self.assertEqual(self.post("/context/image", image(png(width=1280))), (404, {"error": "unknown_request"}))
        beat = {"ts": time.time(), "front": CODE, "mouse": None, "idle_s": 0.0}
        self.assertEqual(self.post("/context/attention", {**beat, "secure_input": True})[0], 200)
        self.assertEqual(self.post("/context/text", text(CODE, "x")), (202, {"accepted": False, "reason": "secure_input"}))
        self.assertEqual(self.post("/context/attention", {**beat, "secure_input": False})[0], 200)
        self.assertEqual(self.post("/context/text", text(CODE, "x")), (202, {"accepted": True}))
        self.server.capture = None
        self.assertEqual(self.post("/look", {}), (503, {"error": "no_attention"}))

    def test_a_jpeg_answers_an_image_request_and_is_checked_like_a_png(self):
        self.start(share=True)
        self.focus_code()
        self.server.capture.vision = vision = FakeVision()
        status, request = self.post("/look", {})
        self.assertEqual(status, 202)
        encode = lambda data: base64.b64encode(data).decode()
        image = lambda **fields: {"request_id": request["request_id"], "window_id": 2, **fields}
        invalid = (400, {"error": "invalid_payload"})
        self.assertEqual(self.post("/context/image", image(jpeg_base64=encode(jpeg()), png_base64=encode(png()))), invalid)
        self.assertEqual(self.post("/context/image", image(jpeg_base64=encode(png()))), invalid)
        self.assertEqual(self.post("/context/image", image(png_base64=encode(jpeg()))), invalid)
        self.assertEqual(self.post("/context/image", image(jpeg_base64=encode(b"\xff\xd8\xff\xda" + b"0" * 30))), invalid)
        self.assertEqual(self.post("/context/image", image(jpeg_base64=encode(jpeg()[:-30]))), invalid)
        self.assertEqual(self.post("/context/image", image(jpeg_base64=5)), invalid)
        self.assertEqual(self.post("/context/image", image(jpeg_base64=encode(jpeg(width=16385)))), (413, {"error": "too_large"}))
        self.assertEqual(self.post("/context/image", image(jpeg_base64=encode(jpeg(9000, 8000, marker=0xC2)))),
                         (413, {"error": "too_large"}))
        self.assertEqual(self.post("/context/image", image(jpeg_base64=encode(jpeg(1280, 720, marker=0xC2)))),
                         (202, {"accepted": True, "request_id": request["request_id"], "status": "pending"}))
        self.wait_for(lambda: self.server.capture.result(request["request_id"]) == "ready")
        self.assertEqual(vision.images, [jpeg(1280, 720, marker=0xC2)])


if __name__ == "__main__":
    unittest.main()
