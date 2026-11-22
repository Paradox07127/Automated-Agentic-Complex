import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from observation.attention import AFK_AFTER, RAW_RETENTION, RETENTION, WEB_PULSE, AttentionStore  # noqa: E402
from observation.blacklist import Blacklist  # noqa: E402
from support import deny_blacklist  # noqa: E402

T0 = 1792300000.0
SAFARI = {"app": "Safari", "bundle_id": "com.apple.Safari", "pid": 10, "window_id": 1, "title": "新闻"}
CODE = {"app": "Code", "bundle_id": "com.microsoft.VSCode", "pid": 11, "window_id": 2, "title": "server.py"}


def beat(ts, front, idle=0.0, mouse=None, **extra):
    return {"ts": ts, "front": front, "mouse": mouse, "idle_s": idle, "locked": False, "asleep": False,
            "focus_role": None, "secure_input": False, **extra}


class AttentionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.addCleanup(self.tmp.cleanup)
        self.now = T0
        self.store = AttentionStore(Path(self.tmp.name) / "attention.sqlite",
                                    Blacklist(deny_blacklist(Path(self.tmp.name) / "blacklist.json")), clock=lambda: self.now)
        self.addCleanup(self.store.close)

    def feed(self, start, seconds, front, step=1.0, **kw):
        t = start
        while t <= start + seconds:
            self.now = t
            self.store.ingest(beat(t, front, **kw))
            t += step

    def items(self, by="app", since=T0 - 1, until=None):
        return {i["key"]: i["seconds"] for i in self.store.summary(since, until or self.now + 1, by)["items"]}

    def test_same_window_heartbeats_merge_into_one_event(self):
        self.feed(T0, 10, SAFARI)
        [event] = self.store.events("window")
        self.assertEqual((event["start"], event["duration"]), (T0, 10.0))

    def test_gap_longer_than_pulsetime_starts_a_new_event(self):
        self.feed(T0, 3, SAFARI)
        self.feed(T0 + 10, 3, SAFARI)
        self.assertEqual([(e["start"], e["duration"]) for e in self.store.events("window")],
                         [(T0, 3.0), (T0 + 10, 3.0)])

    def test_window_change_starts_a_new_event(self):
        self.feed(T0, 5, SAFARI)
        self.feed(T0 + 6, 4, CODE)
        # The old window runs up to the switch, as ActivityWatch's macOS watcher does.
        self.assertEqual(self.items(), {"Safari": 6.0, "Code": 4.0})

    def test_out_of_order_heartbeat_is_ignored(self):
        self.feed(T0, 5, SAFARI)
        self.store.ingest(beat(T0 + 2, CODE))
        self.assertEqual([e["data"]["app"] for e in self.store.events("window")], ["Safari"])

    def test_afk_time_is_not_active_and_is_backdated_to_last_input(self):
        self.feed(T0, 20, SAFARI)
        # No input after T0 + 20: idle grows until it crosses the AFK threshold.
        t = T0 + 21
        while t <= T0 + 20 + AFK_AFTER + 30:
            self.now = t
            self.store.ingest(beat(t, SAFARI, idle=t - (T0 + 20)))
            t += 1
        summary = self.store.summary(T0 - 1, self.now + 1, "app")
        self.assertAlmostEqual(summary["active_s"], 20.0, delta=1.0)
        self.assertGreater(summary["afk_s"], AFK_AFTER)
        # Once AFK is seen, the time since the last input counts as AFK too.
        self.assertLessEqual(self.items()["Safari"], 21.0)

    def test_locked_screen_is_afk(self):
        self.feed(T0, 10, SAFARI)
        self.feed(T0 + 11, 10, SAFARI, locked=True)
        self.assertAlmostEqual(self.items()["Safari"], 10.0, delta=1.0)

    def test_summary_by_title_sorts_and_limits(self):
        for i in range(25):
            self.feed(T0 + i * 10, i % 5 + 1, {**SAFARI, "window_id": i, "title": f"页 {i}"})
        items = self.store.summary(T0 - 1, self.now + 1, "title")["items"]
        self.assertEqual(len(items), 20)
        self.assertEqual([i["seconds"] for i in items], sorted((i["seconds"] for i in items), reverse=True))

    def test_domain_summary_is_empty_without_browser_data(self):
        self.feed(T0, 5, SAFARI)
        self.assertEqual(self.store.summary(T0 - 1, self.now + 1, "domain")["items"], [])

    def test_gaze_needs_five_seconds_on_one_window(self):
        self.feed(T0, 3, SAFARI)
        self.assertIsNone(self.store.focus())
        self.feed(T0 + 4, 2, SAFARI)
        self.assertEqual(self.store.focus()["app"], "Safari")

    def test_focus_snapshot_uses_observed_time_and_expires(self):
        self.feed(T0, 6, SAFARI)
        snapshot = self.store.focus_snapshot()
        self.assertEqual(snapshot["focus"]["app"], "Safari")
        self.assertLessEqual(snapshot["observed_at"], self.now)
        self.now += 120
        self.assertIsNone(self.store.focus_snapshot())

    def test_idle_keyboard_with_mouse_over_another_window_moves_the_gaze(self):
        self.feed(T0, 6, SAFARI, idle=10.0, mouse=CODE)
        self.assertEqual(self.store.focus()["app"], "Code")
        self.feed(T0 + 7, 6, SAFARI, idle=0.0, mouse=CODE)
        self.assertEqual(self.store.focus()["app"], "Safari")

    def test_secure_input_drops_the_title(self):
        self.feed(T0, 3, SAFARI, secure_input=True)
        [event] = self.store.events("window")
        self.assertNotIn("title", event["data"])
        self.assertEqual(event["data"]["app"], "Safari")

    def test_blacklisted_window_is_hidden_on_receive(self):
        keychain = {"app": "Keychain Access", "bundle_id": "com.apple.keychainaccess", "title": "login"}
        self.feed(T0, 3, keychain)
        [event] = self.store.events("window")
        self.assertEqual(event["data"], {"app": "<hidden>"})

    def test_domain_summary_uses_url_host_and_hides_blacklisted_hosts(self):
        self.feed(T0, 5, {**SAFARI, "url_host": "github.com"})
        self.feed(T0 + 6, 4, {**SAFARI, "window_id": 3, "title": "网银", "url_host": "mybank.icbc.com.cn"})
        self.feed(T0 + 11, 3, CODE)
        self.assertEqual(self.items("domain"), {"github.com": 6.0})
        self.assertEqual(self.store.events("window")[1]["data"], {"app": "<hidden>"})

    def test_url_host_never_keeps_a_path(self):
        self.feed(T0, 3, {**SAFARI, "url_host": "github.com/me/secret"})
        self.assertIsNone(self.store.events("window")[0]["data"]["url_host"])

    def test_null_title_and_role_are_fine_and_long_titles_are_cut(self):
        self.feed(T0, 3, {**SAFARI, "title": None})
        self.feed(T0 + 4, 3, {**SAFARI, "window_id": 9, "title": "长" * 300})
        events = self.store.events("window")
        self.assertIsNone(events[0]["data"]["title"])
        self.assertEqual(len(events[1]["data"]["title"]), 256)

    def test_gap_over_five_seconds_is_unknown_not_active_or_afk(self):
        self.feed(T0, 10, SAFARI)
        self.feed(T0 + 70, 10, SAFARI)
        summary = self.store.summary(T0, T0 + 80, "app")
        self.assertEqual((summary["active_s"], summary["afk_s"], summary["unknown_s"]), (20.0, 0, 60.0))
        self.assertEqual(self.items(since=T0)["Safari"], 20.0)

    def test_gap_is_not_filled_by_backdated_afk(self):
        self.feed(T0, 10, SAFARI)
        # After a 60 s gap the collector reports 200 s idle: the gap stays unknown.
        self.now = T0 + 70
        self.store.ingest(beat(T0 + 70, SAFARI, idle=200.0))
        summary = self.store.summary(T0, T0 + 70, "app")
        self.assertEqual((summary["active_s"], summary["unknown_s"]), (10.0, 60.0))

    def test_backdated_afk_does_not_reach_back_across_an_earlier_gap(self):
        self.feed(T0, 10, SAFARI)
        # Beats resume after a 60 s gap with no input since T0 + 10; AFK may not start inside the gap.
        t = T0 + 70
        while t <= T0 + 10 + AFK_AFTER + 10:
            self.now = t
            self.store.ingest(beat(t, SAFARI, idle=t - (T0 + 10)))
            t += 1.0
        afk = [e for e in self.store.events("afk") if e["data"]["status"] == "afk"]
        self.assertGreaterEqual(afk[0]["start"], T0 + 70)
        self.assertEqual(self.store.summary(T0, self.now, "app")["unknown_s"], 60.0)

    def test_presence_from_the_latest_beats(self):
        self.assertIsNone(self.store.presence())
        self.feed(T0, 10, SAFARI)
        self.assertEqual(self.store.presence(), ("active", 10.0))
        t = T0 + 11
        while t <= T0 + 10 + AFK_AFTER + 20:
            self.now = t
            self.store.ingest(beat(t, SAFARI, idle=t - (T0 + 10)))
            t += 1.0
        status, seconds = self.store.presence()
        self.assertEqual(status, "afk")
        self.assertGreaterEqual(seconds, AFK_AFTER)
        self.now += 60  # beats stopped: unknown, not the last state
        self.assertIsNone(self.store.presence())

    def test_short_gaps_still_merge(self):
        self.feed(T0, 3, SAFARI)
        self.feed(T0 + 7, 3, SAFARI)
        self.assertEqual([(e["start"], e["duration"]) for e in self.store.events("window")], [(T0, 10.0)])

    def test_blacklisted_mouse_window_is_hidden(self):
        keychain = {"app": "Keychain Access", "bundle_id": "com.apple.keychainaccess", "window_id": 5, "title": "login"}
        self.feed(T0, 6, SAFARI, idle=10.0, mouse=keychain)
        self.assertEqual(self.store.focus(), {"app": "<hidden>"})
        self.assertNotIn("login", str(self.store.events("focus")))

    def browse(self, ts, kind="heartbeat", **fields):
        self.now = ts
        self.store.ingest_browser({"type": kind, "ts": ts, "url_host": "github.com", "title": "PR",
                                   "audible": False, "visible": True, "tab_id": 1, "window_focused": True, **fields})

    def test_browser_heartbeats_merge_within_eighty_seconds(self):
        self.browse(T0)
        self.browse(T0 + 60)
        self.browse(T0 + 200)
        self.assertEqual([(e["start"], e["duration"]) for e in self.store.events("browser")],
                         [(T0, 60.0), (T0 + 200, 0.0)])

    def test_chrome_window_without_url_host_takes_the_domain_from_the_extension(self):
        chrome = {"app": "Google Chrome", "bundle_id": "com.google.Chrome", "pid": 3, "window_id": 4,
                  "title": "PR", "url_host": None}
        self.browse(T0)
        self.feed(T0, 30, chrome)
        self.browse(T0 + 30)
        self.assertEqual(self.items("domain"), {"github.com": 30.0})

    def test_safari_window_never_borrows_chrome_extension_data(self):
        self.browse(T0)
        self.feed(T0, 10, {**SAFARI, "url_host": None})
        self.browse(T0 + 10)
        self.assertEqual(self.items("domain"), {})

    def test_afk_runs_are_cut_to_the_range_and_sorted(self):
        rows = [(T0 + 300, 400, "afk"), (T0 - 100, 200, "not-afk"), (T0 + 100, 200, "afk"), (T0 + 800, 50, "afk")]
        self.store.db.executemany("INSERT INTO events (bucket, start, duration, data) VALUES ('afk', ?, ?, ?)",
                                  [(s, d, json.dumps({"status": status})) for s, d, status in rows])
        self.assertEqual(self.store.afk_runs(T0, T0 + 600),
                         [(T0, T0 + 100, "not-afk"), (T0 + 100, T0 + 300, "afk"), (T0 + 300, T0 + 600, "afk")])

    def test_audible_tab_counts_as_active_while_afk(self):
        chrome = {"app": "Google Chrome", "bundle_id": "com.google.Chrome", "pid": 3, "window_id": 4, "title": "MV"}
        t = T0
        while t <= T0 + 300:
            self.now = t
            self.store.ingest(beat(t, chrome, idle=t - T0))
            if (t - T0) % 60 == 0:
                self.store.ingest_browser({"type": "heartbeat", "ts": t, "url_host": "youtube.com", "title": "MV",
                                           "audible": True, "visible": True, "tab_id": 1, "window_focused": True})
            t += 1
        self.assertGreater(self.store.summary(T0, T0 + 300, "app")["afk_s"], 0)
        self.assertAlmostEqual(self.items(since=T0)["Google Chrome"], 300.0, delta=1.0)

    def test_blacklisted_host_is_hidden_and_its_text_dropped(self):
        self.browse(T0, url_host="mybank.icbc.com.cn", title="账户")
        self.browse(T0 + 1, "page", url_host="mybank.icbc.com.cn", text="余额 100")
        self.browse(T0 + 2, "selection", url_host="mybank.icbc.com.cn", text="100")
        self.assertEqual(self.store.events("browser")[0]["data"], {"url_host": "<hidden>", "audible": False})
        self.assertEqual(self.store.context(), [])

    def test_title_pattern_hides_a_page_and_its_text(self):
        path = Path(self.tmp.name) / "blacklist.json"
        path.write_text(json.dumps({**json.loads(path.read_text(encoding="utf-8")), "title_patterns": ["病历"]}), encoding="utf-8")
        self.browse(T0, title="我的病历")
        self.browse(T0 + 1, "page", title="我的病历", text="诊断")
        self.browse(T0 + 2, "selection", title="我的病历", text="诊断")
        self.assertEqual(self.store.events("browser")[0]["data"], {"url_host": "<hidden>", "audible": False})
        self.assertEqual(self.store.context(), [])

    def test_page_text_is_dropped_while_secure_input_is_on(self):
        self.feed(T0, 1, SAFARI, secure_input=True)
        self.browse(T0 + 2, "page", text="密码框旁边的正文")
        self.browse(T0 + 3, "selection", text="选中")
        self.assertEqual(self.store.context(), [])
        # Control: the next heartbeat clears secure_input and text is kept again.
        self.feed(T0 + 4, 1, SAFARI)
        self.browse(T0 + 6, "selection", text="选中")
        self.assertEqual([c["text"] for c in self.store.context()], ["选中"])

    def test_page_and_selection_text_is_kept_locally_and_cleared(self):
        self.browse(T0, "page", text="正文" * 2000)
        self.browse(T0 + 1, "selection", text="选中的一句")
        self.browse(T0 + 2)
        kinds = [(c["kind"], len(c["text"])) for c in self.store.context()]
        self.assertEqual(kinds, [("page", 2000), ("selection", 5)])
        self.assertEqual(self.store.latest_selection()["text"], "选中的一句")
        self.store.clear()
        self.assertEqual(self.store.context(), [])
        self.assertIsNone(self.store.latest_selection())

    def test_selection_counts_only_while_recent_and_on_the_current_page(self):
        self.browse(T0, "selection", text="昨天的")
        self.browse(T0 + 86400)
        self.assertIsNone(self.store.latest_selection())
        self.browse(T0 + 86401, "selection", text="别的页面的", url_host="example.com", title="另一页")
        self.browse(T0 + 86402)
        self.assertIsNone(self.store.latest_selection())
        self.browse(T0 + 86403, "selection", text="这一页的")
        self.browse(T0 + 86403 + 540)
        self.assertEqual(self.store.latest_selection()["text"], "这一页的")
        self.now += WEB_PULSE + 1  # the browser stopped beating: no current page
        self.assertIsNone(self.store.latest_selection())

    def add_domain(self, host):
        path = Path(self.tmp.name) / "blacklist.json"
        policy = json.loads(path.read_text(encoding="utf-8"))
        path.write_text(json.dumps({**policy, "domains": policy["domains"] + [host]}), encoding="utf-8")

    def test_probe_selection_is_dropped_under_secure_input_or_a_new_blacklist(self):
        self.browse(T0, "selection", url_host="example.test", title="Synthetic", text="SYNTHETIC_SELECTION")
        self.browse(T0 + 1, url_host="example.test", title="Synthetic")
        self.assertEqual(self.store.latest_selection()["text"], "SYNTHETIC_SELECTION")  # control
        self.store.ingest(beat(T0 + 2, SAFARI, secure_input=True))
        self.assertIsNone(self.store.latest_selection())
        self.store.ingest(beat(T0 + 3, SAFARI))
        self.assertIsNone(self.store.latest_selection())  # resume needs a fresh sample
        self.browse(T0 + 3, url_host="example.test", title="Synthetic")
        self.browse(T0 + 3, "selection", url_host="example.test", title="Synthetic", text="SYNTHETIC_SELECTION")
        self.assertEqual(self.store.latest_selection()["text"], "SYNTHETIC_SELECTION")  # control
        self.add_domain("example.test")
        self.assertIsNone(self.store.latest_selection())

    def test_current_page_follows_the_selection_rules(self):
        self.browse(T0, "page", text="正文")
        self.browse(T0 + 1)
        self.assertEqual(self.store.current_page(), {"ts": T0, "url_host": "github.com", "title": "PR", "text": "正文"})
        self.store.ingest(beat(T0 + 2, SAFARI, secure_input=True))
        self.assertIsNone(self.store.current_page())
        self.store.ingest(beat(T0 + 3, SAFARI))
        self.assertIsNone(self.store.current_page())
        self.browse(T0 + 3)
        self.browse(T0 + 3, "page", text="正文")
        self.assertIsNotNone(self.store.current_page())
        self.browse(T0 + 4, title="另一页")
        self.assertIsNone(self.store.current_page())  # the browser shows another page
        self.browse(T0 + 5, "page", text="新正文")
        self.browse(T0 + 600)
        self.assertEqual(self.store.current_page()["text"], "新正文")
        self.browse(T0 + 606)
        self.assertIsNone(self.store.current_page())  # older than 600 s

    def test_recent_page_is_the_last_other_page(self):
        self.browse(T0, "page", url_host="docs.python.org", title="旧页", text="旧正文")
        self.browse(T0, url_host="docs.python.org", title="旧页")
        self.browse(T0 + 100, "page", text="正文")
        self.browse(T0 + 101)
        self.assertEqual(self.store.recent_page(),
                         {"ts": T0, "url_host": "docs.python.org", "title": "旧页", "text": "旧正文"})
        self.store.ingest(beat(T0 + 102, SAFARI, secure_input=True))
        self.assertIsNone(self.store.recent_page())
        self.store.ingest(beat(T0 + 103, SAFARI))
        self.assertIsNotNone(self.store.recent_page())
        self.browse(T0 + 7201)  # still on the same page two hours later
        self.assertIsNone(self.store.recent_page())
        self.assertIsNotNone(self.store.recent_page(within=7300))
        self.add_domain("docs.python.org")
        self.assertIsNone(self.store.recent_page(within=7300))

    def test_selection_belongs_to_its_tab(self):
        self.browse(T0, "selection", text="A 的选中", browser_session="S1", tab_id=1, document_id="D1")
        self.browse(T0 + 1, browser_session="S1", tab_id=1, document_id="D1")
        self.assertEqual(self.store.latest_selection()["text"], "A 的选中")  # control: still on tab A
        # Same host and title; tab B's document is not known yet.
        self.browse(T0 + 2, browser_session="S1", tab_id=2, document_id=None)
        self.assertIsNone(self.store.latest_selection())

    def test_cleared_selection_hides_it_only_on_its_document(self):
        ids = {"browser_session": "S1", "tab_id": 1, "document_id": "D1"}
        self.browse(T0, "selection", text="选中", **ids)
        self.browse(T0 + 1, "selection_cleared", **{**ids, "document_id": "D9"})
        self.browse(T0 + 2, **ids)
        self.assertEqual(self.store.latest_selection()["text"], "选中")  # control: another document
        self.browse(T0 + 3, "selection_cleared", **ids)
        self.browse(T0 + 4, **ids)
        self.assertIsNone(self.store.latest_selection())

    def test_page_text_belongs_to_its_revision(self):
        ids = {"browser_session": "S1", "tab_id": 1, "document_id": "D1"}
        self.browse(T0, "page", text="第一版", revision=1, **ids)
        self.browse(T0 + 1, revision=1, **ids)
        self.assertEqual(self.store.current_page()["text"], "第一版")  # control
        self.browse(T0 + 2, revision=2, **ids)  # same URL and title, content changed
        self.assertIsNone(self.store.current_page())
        self.browse(T0 + 3, "page", text="第二版", revision=2, **ids)
        self.assertEqual(self.store.current_page()["text"], "第二版")

    def test_returning_to_a_tab_finds_its_page_text_again(self):
        a = {"url_host": "docs.example-a.dev", "title": "A", "browser_session": "S1", "tab_id": 1,
             "document_id": "DA", "revision": 1}
        b = {"url_host": "docs.example-b.dev", "title": "B", "browser_session": "S1", "tab_id": 2,
             "document_id": "DB", "revision": 1}
        self.browse(T0, "page", text="A 的正文", **a)
        self.browse(T0, **a)
        self.browse(T0 + 10, "page", text="B 的正文", **b)
        self.browse(T0 + 10, **b)
        self.assertEqual(self.store.current_page()["text"], "B 的正文")  # control
        self.browse(T0 + 20, **a)  # back on A; the extension sends A's text only once per revision
        self.assertEqual(self.store.current_page()["text"], "A 的正文")

    def test_a_browser_restart_drops_the_old_selection(self):
        self.browse(T0, "selection", text="选中", browser_session="S1", tab_id=1, document_id=None)
        self.browse(T0 + 1, browser_session="S1", tab_id=1, document_id=None)
        self.assertEqual(self.store.latest_selection()["text"], "选中")  # control
        self.browse(T0 + 2, browser_session="S2", tab_id=1, document_id=None)  # tab id reused
        self.assertIsNone(self.store.latest_selection())

    def test_context_older_than_retention_is_pruned(self):
        self.browse(T0, "selection", text="旧的")
        self.now = T0 + RETENTION + 3600
        self.store.ingest(beat(self.now, SAFARI))
        self.assertEqual(self.store.context(), [])

    def test_events_older_than_retention_are_pruned(self):
        self.feed(T0, 3, SAFARI)
        self.feed(T0 + RETENTION + 3600, 3, CODE)
        self.assertEqual([e["data"]["app"] for e in self.store.events("window")], ["Code"])

    def test_clear_deletes_everything(self):
        self.feed(T0, 3, SAFARI)
        self.assertGreater(self.store.clear(), 0)
        self.assertEqual(self.store.events("window"), [])
        self.assertEqual(self.store.summary(T0 - 1, self.now + 1, "app")["items"], [])

    def test_data_survives_reopen(self):
        self.feed(T0, 3, SAFARI)
        self.store.close()
        self.store = AttentionStore(Path(self.tmp.name) / "attention.sqlite",
                                    Blacklist(deny_blacklist(Path(self.tmp.name) / "blacklist.json")), clock=lambda: self.now)
        self.feed(T0 + 4, 3, SAFARI)
        [event] = self.store.events("window")
        self.assertEqual((event["start"], event["duration"]), (T0, 7.0))

    def test_unfocused_browser_stops_domain_time_and_withholds_context(self):
        chrome = {"app": "Google Chrome", "bundle_id": "com.google.Chrome", "title": "PR"}
        self.browse(T0)
        self.browse(T0 + 1, "page", text="old page")
        self.browse(T0 + 1, "selection", text="old selection")
        self.feed(T0, 30, chrome)
        self.browse(T0 + 10, window_focused=False, visible=False, audible=True)
        self.browse(T0 + 30, window_focused=False, visible=False, audible=True)
        self.assertIsNone(self.store.current_page())
        self.assertIsNone(self.store.latest_selection())
        self.assertEqual(self.items("domain"), {"github.com": 10.0})

    def test_empty_dynamic_revision_invalidates_old_page(self):
        self.browse(T0, revision=1)
        self.browse(T0 + 1, "page", text="old", revision=1)
        self.browse(T0 + 2, revision=2)
        self.browse(T0 + 3, "page", text="", revision=2)
        self.assertIsNone(self.store.current_page())
        self.browse(T0 + 4, "page", text="new", revision=2)
        self.assertEqual(self.store.current_page()["text"], "new")

    def test_sleep_blocks_inflight_text_and_requires_a_fresh_browser_heartbeat_after_wake(self):
        self.browse(T0)
        self.browse(T0 + 1, "page", text="before sleep")
        self.browse(T0 + 1, "selection", text="before sleep selection")
        self.feed(T0 + 2, 0, SAFARI, asleep=True)
        self.assertIsNone(self.store.current_page())
        self.assertIsNone(self.store.latest_selection())
        self.assertFalse(self.store.browser_summary(T0, self.now)["focused"])
        before = len(self.store.context())
        self.browse(T0 + 3, "page", text="inflight while asleep")
        self.browse(T0 + 3, "selection", text="inflight while asleep selection")
        self.assertEqual(len(self.store.context()), before)
        self.feed(T0 + 20, 0, SAFARI)
        self.browse(T0 + 4)  # pre-wake queued heartbeat must not reopen capture
        self.browse(T0 + 4, "page", text="queued before wake")
        self.assertIsNone(self.store.current_page())
        self.assertEqual(len(self.store.context()), before)
        self.browse(T0 + 21)
        self.browse(T0 + 21, "page", text="fresh after wake")
        self.assertEqual(self.store.current_page()["text"], "fresh after wake")

    def test_short_sleep_does_not_extend_audible_website_time(self):
        chrome = {"app": "Google Chrome", "bundle_id": "com.google.Chrome"}
        self.browse(T0, audible=True)
        self.feed(T0, 5, chrome)
        self.browse(T0 + 5, audible=True)
        self.feed(T0 + 6, 23, chrome, asleep=True)
        self.feed(T0 + 30, 0, chrome)
        self.browse(T0 + 30, audible=True)
        self.feed(T0 + 31, 5, chrome)
        self.browse(T0 + 36, audible=True)
        self.assertLessEqual(self.items("domain").get("github.com", 0), 12)

    def metrics(self, ts, **extra):
        identity = {"browser_session": "S", "tab_id": 1, "document_id": "D", "revision": 1}
        payload = {"scroll_percent": 25, "max_scroll_percent": 60, "media": {
            "kind": "video", "state": "paused", "position_s": 42, "duration_s": 180,
            "playback_rate": 1.5, "muted": False}, "tab_count": 4, "audible_tab_count": 1}
        self.browse(ts, **identity)
        self.browse(ts + 0.1, "metrics", **{**identity, "metrics": payload, **extra})
        return payload

    def test_metrics_are_ui_only_ephemeral_and_do_not_store_urls_or_titles_in_public_data(self):
        payload = self.metrics(T0)
        summary = self.store.browser_summary(T0, self.now)
        self.assertEqual(summary["current"]["media"], payload["media"])
        self.assertEqual(summary["samples_received"], 1)
        self.assertNotIn("title", summary["current"])
        self.assertNotIn("document_id", summary["current"])
        self.assertEqual(self.store.context(), [])
        self.assertNotIn("scroll_percent", str(self.store.events("browser")))
        self.assertIsNone(self.store.browser_summary(T0, T0 + 16)["current"])

    def test_metrics_reject_wrong_document_revision_and_unexpected_text_fields(self):
        self.metrics(T0, document_id="old")
        self.assertIsNone(self.store.browser_summary(T0, self.now)["current"])
        self.metrics(T0 + 1, revision=2)
        self.assertIsNone(self.store.browser_summary(T0, self.now)["current"])
        self.metrics(T0 + 2, metrics={"scroll_percent": 1, "text": "secret"})
        self.assertIsNone(self.store.browser_summary(T0, self.now)["current"])

    def test_metrics_hidden_on_blur_secure_input_blacklist_and_clear(self):
        self.metrics(T0)
        self.browse(T0 + 1, window_focused=False)
        self.assertIsNone(self.store.browser_summary(T0, self.now)["current"])
        self.metrics(T0 + 2)
        self.feed(T0 + 3, 1, SAFARI, secure_input=True)
        self.assertIsNone(self.store.browser_summary(T0, self.now)["current"])
        self.feed(T0 + 5, 1, SAFARI)
        self.metrics(T0 + 7)
        self.store.blacklist.add("domains", "github.com")
        self.assertIsNone(self.store.browser_summary(T0, self.now)["current"])
        self.store.clear()
        self.assertEqual(self.store.browser_summary(T0, self.now)["samples_received"], 0)

    def test_domain_summary_rechecks_new_blacklist_without_deleting_history(self):
        self.feed(T0, 10, {**SAFARI, "url_host": "docs.example.com"})
        self.assertEqual(self.items("domain"), {"docs.example.com": 10.0})
        self.store.blacklist.add("domains", "example.com")
        self.assertEqual(self.items("domain"), {})
        self.assertTrue(self.store.events("window"), "history was not deleted")

    def test_revision_changes_are_not_counted_as_page_switches(self):
        for i in range(3):
            self.browse(T0 + i, browser_session="S", document_id="D", revision=i + 1)
        self.browse(T0 + 3, browser_session="S", document_id="D2", revision=1, tab_id=2)
        self.browse(T0 + 4, browser_session="S", document_id="D2", revision=1, tab_id=2)
        self.assertEqual(self.store.browser_summary(T0, self.now)["page_switches"], 1)

class InputRingTest(unittest.TestCase):
    """Input counts, mic apps and front audio stay in a 300 s memory ring, never in SQLite."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.addCleanup(self.tmp.cleanup)
        self.now = T0
        self.path = Path(self.tmp.name) / "attention.sqlite"
        self.store = AttentionStore(self.path, Blacklist(deny_blacklist(Path(self.tmp.name) / "blacklist.json")),
                                    clock=lambda: self.now)
        self.addCleanup(self.store.close)

    def sensed(self, ts):
        self.now = ts
        self.store.ingest(beat(ts, {**CODE, "category": "public.app-category.developer-tools"},
                               input={"keys_10s": 31, "key_idle_s": 0.4, "moves_10s": 7},
                               front_audio_out=True))

    def test_input_never_reaches_sqlite(self):
        for i in range(3):
            self.sensed(T0 + i)
        self.assertEqual(self.store.inputs(300)[-1],
                         {"ts": T0 + 2, "input": {"keys_10s": 31, "key_idle_s": 0.4, "moves_10s": 7},
                          "front_audio_out": True,
                          "category": "public.app-category.developer-tools"})
        self.store.close()
        db = sqlite3.connect(str(self.path))
        self.addCleanup(db.close)
        stored = json.dumps([db.execute(f"SELECT * FROM {t}").fetchall() for t in ("events", "context")])
        for word in ("keys_10s", "key_idle_s", "moves_10s", "input", "front_audio_out", "category", "developer-tools"):
            self.assertNotIn(word, stored)
        self.assertIn("server.py", stored)
        self.store = AttentionStore(self.path, Blacklist(deny_blacklist(Path(self.tmp.name) / "blacklist.json")))
        self.addCleanup(self.store.close)
        self.assertEqual(self.store.inputs(300), [])

    def test_scene_fields_stay_in_the_ring(self):
        self.store.ingest(beat(T0, CODE, front_video=True, front_gpu=0.6173, screen_captured=False))
        self.store.ingest(beat(T0 + 1, CODE, front_video=None, front_gpu=None, screen_captured=None))
        self.assertEqual(self.store.inputs(300),
                         [{"ts": T0, "front_video": True, "front_gpu": 0.6173, "screen_captured": False},
                          {"ts": T0 + 1, "front_video": None, "front_gpu": None, "screen_captured": None}])
        self.store.close()
        db = sqlite3.connect(str(self.path))
        self.addCleanup(db.close)
        stored = json.dumps([db.execute(f"SELECT * FROM {t}").fetchall() for t in ("events", "context")])
        for word in ("front_video", "front_gpu", "0.6173", "screen_captured"):
            self.assertNotIn(word, stored)
        self.assertIn("server.py", stored)

    def test_hidden_front_keeps_its_category_out_of_the_ring(self):
        keychain = {"app": "Keychain Access", "bundle_id": "com.apple.keychainaccess",
                    "category": "public.app-category.utilities"}
        self.store.ingest(beat(T0, keychain, input={"keys_10s": 3}))
        self.assertEqual(self.store.inputs(300), [{"ts": T0, "input": {"keys_10s": 3}}])

    def test_ring_drops_after_300s(self):
        self.sensed(T0)
        self.sensed(T0 + 200)
        self.store.ingest(beat(T0 + 201, CODE))  # a beat without the new fields adds nothing
        self.now = T0 + 299
        self.assertEqual([e["ts"] for e in self.store.inputs(300)], [T0, T0 + 200])
        self.assertEqual([e["ts"] for e in self.store.inputs(10)], [])
        self.now = T0 + 301
        self.assertEqual([e["ts"] for e in self.store.inputs(300)], [T0 + 200])
        self.assertEqual([e["ts"] for e in self.store.inputs(600)], [T0 + 200])
        self.sensed(T0 + 600)
        self.assertEqual([e["ts"] for e in self.store.inputs()], [T0 + 600])

    def test_deleting_attention_empties_the_ring(self):
        self.sensed(T0)
        self.sensed(T0 + 10)
        self.store.delete_since(T0 + 5)
        self.assertEqual([e["ts"] for e in self.store.inputs()], [T0])
        self.store.clear()
        self.assertEqual(self.store.inputs(), [])
        self.sensed(T0 + 20)
        self.store.clear_tables()
        self.assertEqual(self.store.inputs(), [])


def raw(ts, kind="value", **extra):
    return {"ts": ts, "kind": kind, "app": "Code", "bundle_id": "com.microsoft.VSCode", "window": "server.py",
            "url_host": None, "doc": "/w/server.py", "role": "AXTextArea", "subrole": None, "label": "编辑器",
            "value": "写一半的句子", "value_len": 6, "shrink": 0, "edits": 1, **extra}


class RawEventsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.addCleanup(self.tmp.cleanup)
        self.now = T0
        self.blacklist = Blacklist(deny_blacklist(Path(self.tmp.name) / "blacklist.json"))
        self.store = AttentionStore(Path(self.tmp.name) / "attention.sqlite", self.blacklist, clock=lambda: self.now)
        self.addCleanup(self.store.close)

    def rows(self):
        return self.store.db.execute("SELECT ts, kind, value FROM events_raw ORDER BY ts, id").fetchall()

    def test_events_are_stored_and_read_back_in_time_order(self):
        self.assertEqual(self.store.ingest_events([raw(T0 + 2), raw(T0 + 1, "focus", value=None)]), (2, 0))
        events = self.store.recent_events(T0)
        self.assertEqual([(e["ts"], e["kind"]) for e in events], [(T0 + 1, "focus"), (T0 + 2, "value")])
        self.assertEqual({k: v for k, v in events[1].items() if k != "id"}, {**raw(T0 + 2), "input_near": None})
        self.assertEqual([e["ts"] for e in self.store.recent_events(T0 + 2)], [T0 + 2])
        self.assertEqual([e["kind"] for e in self.store.recent_events(T0, kinds=("focus",))], ["focus"])
        self.assertEqual([e["ts"] for e in self.store.recent_events(T0, limit=1)], [T0 + 2])

    def test_blacklisted_events_are_dropped_on_ingest(self):
        events = [raw(T0, bundle_id="com.1password.1password"), raw(T0, app="<hidden>"),
                  raw(T0, url_host="pay.paypal.com"), raw(T0 + 1)]
        self.assertEqual(self.store.ingest_events(events), (1, 3))
        self.assertEqual(self.rows(), [(T0 + 1, "value", "写一半的句子")])

    def test_rows_go_after_48_hours(self):
        self.store.ingest_events([raw(T0), raw(T0 + 7200)])
        self.now = T0 + RAW_RETENTION + 1
        self.store.ingest_events([raw(self.now)])
        self.assertEqual([r[0] for r in self.rows()], [T0 + 7200, self.now])

    def test_delete_since_takes_rows_from_the_cutoff(self):
        self.store.ingest_events([raw(T0), raw(T0 + 5), raw(T0 + 10)])
        self.store.delete_since(T0 + 5)
        self.assertEqual([r[0] for r in self.rows()], [T0])

    def test_delete_hidden_takes_the_rows_it_now_hides(self):
        self.store.ingest_events([raw(T0), raw(T0 + 1, app="Safari", bundle_id="com.apple.Safari",
                                                url_host="news.example.com")])
        self.blacklist.add("domains", "example.com")
        self.store.delete_hidden(self.blacklist.hides)
        self.assertEqual([r[0] for r in self.rows()], [T0])

    def test_clear_tables_empties_events_raw(self):
        self.store.ingest_events([raw(T0), raw(T0 + 1)])
        self.assertEqual(self.store.clear_tables()["events_raw"], 2)
        self.assertEqual(self.rows(), [])

    def test_clear_typed_text_drops_values_only(self):
        self.store.ingest_events([raw(T0), raw(T0 + 1, "prompt", app="claude", value="帮我看看")])
        self.store.clear_typed_text()
        row, prompt = self.store.recent_events(T0)
        self.assertEqual((row["kind"], row["value"], row["value_len"], row["label"]), ("value", None, 6, "编辑器"))
        self.assertEqual((prompt["kind"], prompt["value"]), ("prompt", None))

    def test_a_batch_checked_before_clear_typed_text_keeps_no_text(self):
        generation = self.store.typed_generation
        self.store.clear_typed_text()
        events = [raw(T0), raw(T0 + 1, "prompt", app="claude", value="帮我看看")]
        self.assertEqual(self.store.ingest_events(events, typed_generation=generation), (2, 0))
        self.assertEqual(self.rows(), [(T0, "value", None), (T0 + 1, "prompt", None)])
        generation = self.store.typed_generation
        self.assertEqual(self.store.ingest_events(events, typed_generation=generation), (2, 0))
        self.assertEqual(self.rows(), [(T0, "value", None), (T0, "value", "写一半的句子"),
                                       (T0 + 1, "prompt", None), (T0 + 1, "prompt", "帮我看看")])

    def test_events_from_before_a_delete_are_not_stored_after_it(self):
        for delete in (lambda: self.store.delete_since(T0), self.store.clear):
            with self.subTest(delete=delete):
                self.now = T0 + 10
                delete()
                self.assertEqual(self.store.ingest_events([raw(T0 + 5), raw(T0 + 10), raw(T0 + 11)]), (1, 2))
                self.assertEqual([r[0] for r in self.rows()], [T0 + 11])
                self.store.clear_tables()

    def test_recent_events_rechecks_the_blacklist(self):
        self.store.ingest_events([raw(T0)])
        self.blacklist.add("bundle_ids", "com.microsoft.VSCode")
        self.assertEqual(self.store.recent_events(T0), [])
        self.assertEqual(len(self.rows()), 1)

    def test_value_is_not_kept_while_secure_input_is_on(self):
        self.store.ingest(beat(T0, CODE, secure_input=True))
        self.store.ingest_events([raw(T0)])
        self.store.ingest(beat(T0 + 1, CODE))
        self.store.ingest_events([raw(T0 + 1)])
        self.assertEqual(self.rows(), [(T0, "value", None), (T0 + 1, "value", "写一半的句子")])


IDLE = {"key_idle_s": 30.0, "click_idle_s": 30.0, "scroll_idle_s": 30.0}
TYPING = {**IDLE, "key_idle_s": 0.3}


class InputNearTest(unittest.TestCase):
    """events_raw.input_near: 1 with a key, click or scroll within 2 s of the event, 0 once a beat 2 s after it shows
    none, NULL before that beat."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.addCleanup(self.tmp.cleanup)
        self.now = T0
        self.path = Path(self.tmp.name) / "attention.sqlite"
        self.store = AttentionStore(self.path, Blacklist(deny_blacklist(Path(self.tmp.name) / "blacklist.json")),
                                    clock=lambda: self.now)
        self.addCleanup(lambda: self.store.close())

    def beats(self, start, stop, **kw):
        t = start
        while t <= stop:
            self.now = t
            self.store.ingest(beat(t, CODE, **kw))
            t += 1.0

    def near(self):
        return [row[0] for row in self.store.db.execute("SELECT input_near FROM events_raw ORDER BY ts, id")]

    def test_a_test_program_raising_a_window_is_no_input(self):
        self.beats(T0, T0 + 5, input=IDLE)
        self.store.ingest_events([raw(T0 + 5, "app", value=None)])
        self.beats(T0 + 6, T0 + 8, input=IDLE)
        self.assertEqual(self.near(), [0])

    def test_focus_falling_back_by_itself_is_no_input(self):
        self.beats(T0, T0 + 5, input=IDLE)
        self.store.ingest_events([raw(T0 + 5, "focus", value=None)])
        self.beats(T0 + 6, T0 + 8, input=IDLE)
        self.assertEqual(self.near(), [0])

    def test_an_event_from_before_the_kept_beats_is_unknown_when_later_input_hides_it(self):
        self.beats(T0 + 10, T0 + 12, input=TYPING)
        self.store.ingest_events([raw(T0 + 1, "app", value=None)])
        self.assertEqual(self.near(), [None])

    def test_an_event_from_before_the_kept_beats_is_no_input_when_idle_spans_it(self):
        self.beats(T0 + 10, T0 + 12, input=IDLE)
        self.store.ingest_events([raw(T0 + 1, "app", value=None)])
        self.assertEqual(self.near(), [0])

    def test_typing_around_the_event_is_input(self):
        self.beats(T0, T0 + 5, input=TYPING)
        self.store.ingest_events([raw(T0 + 5)])
        self.beats(T0 + 6, T0 + 8, input=TYPING)
        self.assertEqual(self.near(), [1])

    def test_an_event_waits_for_the_beat_that_decides_it(self):
        self.beats(T0, T0 + 5, input=IDLE)
        self.store.ingest_events([raw(T0 + 5, "focus", value=None)])
        self.assertEqual(self.near(), [None])
        self.beats(T0 + 6, T0 + 6, input=IDLE)
        self.assertEqual(self.near(), [None])
        self.beats(T0 + 7, T0 + 7, input=IDLE)
        self.assertEqual(self.near(), [0])
        self.store.ingest_events([raw(T0 + 10)])
        self.beats(T0 + 8, T0 + 10, input=IDLE)
        self.assertEqual(self.near(), [0, None])
        self.beats(T0 + 11, T0 + 11, input={**IDLE, "click_idle_s": 0.5})
        self.assertEqual(self.near(), [0, 1])

    def test_beats_without_input_use_idle_s(self):
        self.beats(T0, T0 + 5, idle=0.2)
        self.store.ingest_events([raw(T0 + 5)])
        self.beats(T0 + 6, T0 + 8, idle=0.2)
        self.beats(T0 + 20, T0 + 25, idle=30.0)
        self.store.ingest_events([raw(T0 + 25)])
        self.beats(T0 + 26, T0 + 28, idle=30.0)
        self.assertEqual(self.near(), [1, 0])

    def test_the_client_cannot_set_input_near(self):
        self.store.ingest_events([raw(T0, input_near=1)])
        self.assertEqual(self.near(), [None])
        self.beats(T0, T0 + 3, input=IDLE)
        self.assertEqual(self.near(), [0])

    def test_only_input_near_is_added_and_no_counts_are_stored(self):
        columns = [row[1] for row in self.store.db.execute("PRAGMA table_info(events_raw)")]
        self.assertEqual(columns, ["id", "ts", "kind", "app", "bundle_id", "window", "url_host", "doc", "role",
                                   "subrole", "label", "value", "value_len", "shrink", "edits", "input_near"])
        self.beats(T0, T0 + 3, input={**TYPING, "keys_10s": 31, "clicks_10s": 4})
        self.store.ingest_events([raw(T0 + 1)])
        tables = [row[0] for row in self.store.db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")]
        for table in tables:
            names = [row[1] for row in self.store.db.execute(f"PRAGMA table_info({table})")]
            stored = json.dumps([*names, *self.store.db.execute(f"SELECT * FROM {table}").fetchall()])
            for word in ("keys", "clicks", "key_idle_s", "click_idle_s", "count"):
                self.assertNotIn(word, stored, table)

    def test_deleted_beats_no_longer_mark_input(self):
        self.beats(T0, T0 + 10, input=TYPING)
        self.store.delete_since(T0 + 5)
        self.store.ingest_events([raw(T0 + 11)])
        self.beats(T0 + 11, T0 + 13, input=IDLE)
        self.assertEqual(self.near(), [0])
        self.beats(T0 + 14, T0 + 20, input=TYPING)
        self.store.clear_tables()
        self.store.ingest_events([raw(T0 + 21)])
        self.assertEqual(self.near(), [None])


class StateLogTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.addCleanup(self.tmp.cleanup)
        self.now = T0
        self.store = AttentionStore(Path(self.tmp.name) / "attention.sqlite",
                                    Blacklist(deny_blacklist(Path(self.tmp.name) / "blacklist.json")), clock=lambda: self.now)
        self.addCleanup(self.store.close)

    def times(self):
        return [row["ts"] for row in self.store.state_log_since(0)]

    def test_rows_are_written_and_read_back(self):
        self.store.log_state(T0, "coding", "stuck", ["repeat_error", "fail_loop"])
        self.store.log_state(T0 + 30, "reading", "unknown", [])
        self.assertEqual(self.store.state_log_since(T0),
                         [{"ts": T0, "mode": "coding", "state": "stuck", "evidence": ["repeat_error", "fail_loop"]},
                          {"ts": T0 + 30, "mode": "reading", "state": "unknown", "evidence": []}])
        self.assertEqual([row["mode"] for row in self.store.state_log_since(T0 + 1)], ["reading"])
        stored = self.store.db.execute("SELECT evidence FROM state_log ORDER BY ts").fetchall()
        self.assertEqual(stored, [("repeat_error,fail_loop",), ("",)])

    def test_rows_go_after_seven_days(self):
        self.store.log_state(T0, "coding", "flowing", [])
        self.store.log_state(T0 + 7200, "coding", "idle", [])
        self.now = T0 + RETENTION + 3600
        self.store.log_state(self.now, "away", "unknown", [])
        self.assertEqual(self.times(), [T0 + 7200, self.now])

    def test_delete_since_and_clear_tables(self):
        for at in (0, 5, 10):
            self.store.log_state(T0 + at, "coding", "unknown", [])
        self.store.delete_since(T0 + 5)
        self.assertEqual(self.times(), [T0])
        self.store.clear_tables()
        self.assertEqual(self.times(), [])


class SecureDeleteTest(unittest.TestCase):
    MARKER = "mc7-marker-" + "7c41d2" * 8

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "attention.sqlite"
        self.blacklist = Blacklist(deny_blacklist(Path(self.tmp.name) / "blacklist.json"))
        self.store = AttentionStore(self.path, self.blacklist, clock=lambda: T0)
        self.addCleanup(lambda: self.store.close())

    def fill(self, n=20):
        self.store.ingest_events([raw(T0 + i, value=self.MARKER) for i in range(n)])

    def on_disk(self):
        files = [self.path, Path(f"{self.path}-wal"), Path(f"{self.path}-journal")]
        return b"".join(f.read_bytes() for f in files if f.exists())

    def test_the_marker_is_on_disk_when_nothing_is_deleted(self):
        self.fill()
        self.assertIn(self.MARKER.encode(), self.on_disk())

    def test_delete_since_leaves_no_bytes_of_the_rows(self):
        self.fill()
        self.store.delete_since(T0)
        self.assertNotIn(self.MARKER.encode(), self.on_disk())

    def test_delete_hidden_leaves_no_bytes_of_the_rows(self):
        self.fill()
        self.blacklist.add("bundle_ids", "com.microsoft.VSCode")
        self.store.delete_hidden(self.blacklist.hides)
        self.assertNotIn(self.MARKER.encode(), self.on_disk())

    def test_clear_tables_leaves_no_bytes_of_the_rows(self):
        self.fill()
        self.store.clear_tables()
        self.assertNotIn(self.MARKER.encode(), self.on_disk())



if __name__ == "__main__":
    unittest.main()
