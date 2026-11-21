"""observation.now and Timeline.now(): the "now" state the timeline's records set."""
from pathlib import Path
import sys
import tempfile
import unittest

import json
import time

import support
from support import deny_blacklist
from daemon.agentd_server import AgentdServer  # noqa: E402
from observation import now as now_rules  # noqa: E402
from observation.attention import AttentionStore  # noqa: E402
from observation.blacklist import Blacklist  # noqa: E402
from observation import timeline as timeline_module  # noqa: E402
from observation.timeline import Timeline  # noqa: E402

T0 = 1_800_000_000.0


def rec(ts, kind="click", app="Code", window_id=3, title="server.py — Endfield — Code", **extra):
    target = {"role": "AXButton", "subrole": None, "title": "Run", "description": None, "identifier": None, "value": None}
    return {"ts": ts, "kind": kind, "app": app, "bundle_id": f"x.{app}", "pid": 7, "window_id": window_id,
            "window_title": title, "url_host": None, "target": target, "keys": None, "text": None, "tree": None, **extra}


def field(value):
    return {"role": "AXTextField", "subrole": None, "title": "Message", "description": None, "identifier": None,
            "value": value}


class NowTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.root = Path(self.tmp.name)
        self.clock = T0
        self.blacklist = Blacklist(deny_blacklist(self.root / "blacklist.json"))
        self.timeline = self.open()

    def tearDown(self):
        self.tmp.cleanup()

    def open(self):
        timeline = Timeline(self.root / "timeline.sqlite", self.blacklist, clock=lambda: self.clock)
        self.addCleanup(timeline.close)
        return timeline

    def test_a_click_is_in_now_within_a_second(self):
        self.timeline.ingest([rec(T0, "window", target=None)])
        self.clock = T0 + 5.3
        self.timeline.ingest([rec(T0 + 5)])
        now = self.timeline.now()
        self.assertLess(now["updated_at"] - now["actions"][-1]["ts"], 1)
        self.assertEqual((now["app"], now["window"], now["artifact"], now["since"]),
                         ("Code", "server.py — Endfield — Code", "server.py — Endfield", T0))
        self.assertEqual([(a["kind"], a["target"]) for a in now["actions"]], [("click", 'button "Run"')])
        self.assertEqual(len(now["basis"]), 2)

    def test_a_new_window_sets_since_and_the_actions_carry_on(self):
        self.timeline.ingest([rec(T0), rec(T0 + 10, app="Safari", window_id=9, title="Docs", url_host="example.com")])
        now = self.timeline.now()
        self.assertEqual((now["app"], now["since"], now["artifact"]), ("Safari", T0 + 10, "example.com · Docs"))
        self.assertEqual([a["app"] for a in now["actions"]], ["Code", "Safari"])

    def test_a_run_of_inputs_into_one_field_is_one_action_with_its_record_text(self):
        self.timeline.ingest([rec(T0, "text_input", target=field("he"), text="he"),
                              rec(T0 + 1, "text_input", target=field("hello"), text="hello"),
                              rec(T0 + 2, "submit", keys="return", target=field(None))])
        now = self.timeline.now()
        self.assertEqual([(a["kind"], a["text"]) for a in now["actions"]], [("text_input", "hello"), ("submit", None)])
        self.timeline.clear_typed_text()
        self.assertEqual([a["text"] for a in self.timeline.now()["actions"]], [None, None])

    def test_the_latest_ten_actions_are_kept(self):
        self.timeline.ingest([rec(T0 + i) for i in range(15)])
        self.assertEqual([a["ts"] for a in self.timeline.now()["actions"]], [T0 + i for i in range(5, 15)])

    def test_it_is_kept_across_a_restart(self):
        self.timeline.ingest([rec(T0)])
        self.assertEqual(self.open().now()["actions"], self.timeline.now()["actions"])

    def test_a_hidden_or_cleared_record_leaves_it(self):
        self.timeline.ingest([rec(T0, app="Notes", window_id=1, title="todo"), rec(T0 + 1, "window", target=None)])
        self.blacklist.add("app_names", "Notes")
        now = self.timeline.now()
        self.assertEqual([a["app"] for a in now["actions"]], [])
        self.assertEqual(now["app"], "Code")
        self.timeline.clear()
        self.assertEqual(self.timeline.now(), {**now_rules.EMPTY, "basis": []})

    def test_clearing_window_text_takes_a_clicked_text_label_from_rows_and_state(self):
        text = {"role": "AXStaticText", "subrole": None, "title": "SECRET-COUNT", "description": None,
                "identifier": None, "value": None}
        self.timeline.ingest([rec(T0, target=text)])
        self.assertEqual(self.timeline.now()["actions"][0]["target"], 'static text "SECRET-COUNT"')  # control
        self.timeline.clear_trees()
        self.assertEqual(self.timeline.now()["actions"][0]["target"], "static text")
        self.assertNotIn("SECRET-COUNT", self.timeline.db.execute("SELECT state FROM now").fetchone()[0])
        self.assertIsNone(self.timeline.records(int(T0 // 600) * 600)[0]["target"]["title"])

    def test_deleted_or_expired_records_leave_the_stored_state(self):
        self.timeline.ingest([rec(T0, "text_input", app="Notes", window_id=1, target=field(None) | {"title": "SECRET-NOTE"}),
                              rec(T0 + 1, title="SECRET-CODE")])
        stored = lambda: self.timeline.db.execute("SELECT state FROM now").fetchone()[0]
        self.assertIn("SECRET-NOTE", stored())  # control
        self.timeline.delete_hidden(lambda w: w["app"] == "Notes")
        self.assertNotIn("SECRET-NOTE", stored())
        self.assertEqual(self.timeline.now()["window"], "SECRET-CODE")
        self.timeline.expire(T0 + 2 + timeline_module.KEEP_S)
        self.assertNotIn("SECRET-CODE", stored())


class NowContextTest(unittest.TestCase):
    """The now state as the server's activity() and the mouth's context read it."""
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.config = root / "config.json"
        self.save(share_page_text=True)
        black = Blacklist(deny_blacklist(root / "blacklist.json"))
        attention = AttentionStore(root / "attention.sqlite", black)
        self.addCleanup(attention.close)
        self.server = AgentdServer(("127.0.0.1", 0), "hook", "ui", attention=attention, share_page_text=True,
                                   tick_interval=1000)
        self.addCleanup(self.server.server_close)
        self.server.privacy_config = str(self.config)
        self.server.timeline = Timeline(root / "timeline.sqlite", black)
        self.addCleanup(self.server.timeline.close)
        t = time.time()
        self.server.timeline.ingest([rec(t - 5, "window", target=None), rec(t - 2),
                                     rec(t - 1, "text_input", target=field("hello"), text="hello")])

    def save(self, **settings):
        self.config.write_text(json.dumps(settings), encoding="utf-8")

    def now_line(self):
        return next((line for line in self.server._attention_context().split("\n") if line.startswith("Now: ")), None)

    def test_with_page_text_it_names_the_window_and_the_targets(self):
        line = self.now_line()
        self.assertTrue(line.startswith('Now: Code "server.py — Endfield" since '), line)
        self.assertIn(' click on button "Run"; ', line)
        self.assertIn(' text_input on text field "Message": "hello"', line)

    def test_without_page_text_it_keeps_the_app_and_the_kinds_only(self):
        self.save(share_page_text=False)
        self.server.sync_privacy()
        line = self.now_line()
        self.assertTrue(line.startswith("Now: Code since "), line)
        self.assertIn(" click; ", line)
        for title in ("server.py", "Run", "Message"):
            self.assertNotIn(title, json.dumps(self.server.activity()["now"], ensure_ascii=False))

    def test_paused_observation_leaves_it_out(self):
        self.assertIsNotNone(self.now_line())  # control
        self.server.paused_until = self.server.clock() + 60
        self.assertIsNone(self.server.activity()["now"])
        self.assertIsNone(self.now_line())


if __name__ == "__main__":
    unittest.main()
