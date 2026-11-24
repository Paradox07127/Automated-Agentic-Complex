"""observation.timeline.Timeline and POST /context/timeline."""
import json
from pathlib import Path
import sys
import tempfile
import time
import types
import unittest

import support
from support import UI, deny_blacklist
from observation.attention import AttentionStore  # noqa: E402
from observation.blacklist import DEFAULTS, Blacklist  # noqa: E402
from observation.timeline import KEEP_S, SEGMENT_S, Timeline  # noqa: E402
from daemon.agentd_server import AgentdServer  # noqa: E402

T0 = 1_800_000_000.0  # a segment start
FIXTURE = Path(__file__).resolve().parents[3] / "protocol" / "C6-agentd-api" / "fixtures" / "context-timeline.json"


def row(ts, **extra):
    """One checked record as _timeline_record returns it."""
    return {"ts": ts, "kind": "click", "app": "Code", "bundle_id": "x.Code", "pid": 7, "window_id": 3,
            "window_title": "server.py", "url_host": None,
            "target": {"role": "AXButton", "subrole": None, "title": "Run", "description": None,
                       "identifier": "run", "value": "写一半"},
            "keys": None, "text": None, "tree": {"mode": "diff", "text": "+ AXButton Run"}, **extra}


class TimelineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.root = Path(self.tmp.name)
        self.now = T0 + 3000
        self.timeline = self.open(Blacklist(deny_blacklist(self.root / "blacklist.json")))

    def tearDown(self):
        self.tmp.cleanup()

    def open(self, blacklist):
        timeline = Timeline(self.root / "timeline.sqlite", blacklist, clock=lambda: self.now)
        self.addCleanup(timeline.close)
        return timeline

    def test_segments_are_ten_minutes(self):
        self.assertEqual(SEGMENT_S, 600)
        self.assertEqual(self.timeline.ingest([row(T0 + 1199.5), row(T0 + 600), row(T0 + 1200), row(T0 + 5)]), 4)
        self.assertEqual(self.timeline.segments(), [
            {"segment": int(T0), "records": 1, "first_ts": T0 + 5, "last_ts": T0 + 5},
            {"segment": int(T0) + 600, "records": 2, "first_ts": T0 + 600, "last_ts": T0 + 1199.5},
            {"segment": int(T0) + 1200, "records": 1, "first_ts": T0 + 1200, "last_ts": T0 + 1200}])
        self.assertEqual([s["segment"] for s in self.timeline.segments(since=T0 + 700)], [T0 + 600, T0 + 1200])

    def test_records_come_back_in_order_with_target_and_tree(self):
        self.timeline.ingest([row(T0 + 20, kind="window", target=None, tree=None), row(T0 + 10), row(T0 + 20)])
        records = self.timeline.records(int(T0))
        self.assertEqual([(r["ts"], r["kind"]) for r in records], [(T0 + 10, "click"), (T0 + 20, "window"),
                                                                    (T0 + 20, "click")])
        self.assertLess(records[1]["id"], records[2]["id"])
        self.assertEqual({k: v for k, v in records[0].items() if k != "id"}, row(T0 + 10))
        self.assertIsNone(records[1]["target"])
        self.assertIsNone(records[1]["tree"])
        self.assertEqual(self.timeline.records(int(T0) + 600), [])

    def test_expire_deletes_old_rows_and_ingest_runs_it(self):
        self.assertEqual(KEEP_S, 24 * 3600)
        self.timeline.ingest([row(T0 - KEEP_S + 10), row(T0 + 10)])
        self.timeline.expire(T0 + 20)
        self.assertEqual([r["ts"] for s in self.timeline.segments() for r in self.timeline.records(s["segment"])],
                         [T0 + 10])
        self.now = T0 + KEEP_S + 20
        self.timeline.ingest([row(self.now)])
        self.assertEqual([s["segment"] for s in self.timeline.segments()], [int(self.now // 600) * 600])

    def test_opening_expires_old_rows(self):
        self.timeline.ingest([row(self.now - 10)])
        self.now += KEEP_S
        self.assertEqual(self.open(self.timeline.blacklist).segments(), [])

    def test_clear_all_or_since(self):
        self.timeline.ingest([row(T0 + 10), row(T0 + 700), row(T0 + 1300)])
        self.assertEqual(self.timeline.clear(since=T0 + 700), 2)
        self.assertEqual([s["segment"] for s in self.timeline.segments()], [int(T0)])
        self.assertEqual(self.timeline.clear(), 1)
        self.assertEqual(self.timeline.segments(), [])

    def test_a_cleared_span_takes_no_late_record(self):
        self.timeline.clear(since=T0)
        self.assertEqual(self.timeline.ingest([row(self.now - 1), row(self.now + 1)]), 1)

    def test_deny_mode_drops_blacklisted_apps(self):
        stored = self.timeline.ingest([row(T0 + 1, bundle_id="com.1password.1password"),
                                       row(T0 + 2, app="Discord", bundle_id=None, url_host="discord.com"),
                                       row(T0 + 3)])
        self.assertEqual(stored, 1)
        self.assertEqual([r["bundle_id"] for r in self.timeline.records(int(T0))], ["x.Code"])

    def test_allow_mode_keeps_only_allowed_apps(self):
        path = self.root / "allow.json"
        path.write_text(json.dumps({**DEFAULTS, "allow": {"bundle_ids": ["x.Code"], "app_names": [], "domains": []}}),
                        encoding="utf-8")
        timeline = Timeline(self.root / "allow.sqlite", Blacklist(path), clock=lambda: self.now)
        self.addCleanup(timeline.close)
        self.assertEqual(timeline.ingest([row(T0 + 1), row(T0 + 2, app="Notes", bundle_id="com.apple.Notes")]), 1)
        self.assertEqual([r["app"] for r in timeline.records(int(T0))], ["Code"])

    def test_clear_typed_text_and_a_stale_generation_drop_the_text(self):
        generation = self.timeline.typed_generation
        self.timeline.ingest([row(T0 + 1, text="你好")])
        self.assertEqual(self.timeline.clear_typed_text(dry=True), 1)
        self.timeline.clear_typed_text()
        self.timeline.ingest([row(T0 + 2, text="再见")], typed_generation=generation)
        records = self.timeline.records(int(T0))
        self.assertEqual([(r["text"], r["target"]["value"]) for r in records], [(None, None), (None, None)])
        self.assertEqual(records[0]["target"]["title"], "Run")
        self.assertEqual(records[0]["tree"], {"mode": "diff", "text": "+ AXButton Run"})

    def test_delete_hidden(self):
        self.timeline.ingest([row(T0 + 1), row(T0 + 2, app="Notes", bundle_id="com.apple.Notes")])
        self.assertEqual(self.timeline.delete_hidden(lambda window: window["app"] == "Notes"), 1)
        self.assertEqual([r["app"] for r in self.timeline.records(int(T0))], ["Code"])

    def test_clear_trees(self):
        self.timeline.ingest([row(T0 + 1), row(T0 + 2, tree=None)])
        self.timeline.clear_trees()
        self.assertEqual([r["tree"] for r in self.timeline.records(int(T0))], [None, None])

    def test_a_clear_while_a_batch_is_filtered_keeps_nothing_from_before_it(self):
        timeline = self.timeline

        class Clearing:
            fired = False

            def hides(self, window):
                if not self.fired:  # DELETE /observation lands while ingest checks the batch
                    self.fired = True
                    timeline.clear()
                return False

        timeline.blacklist = Clearing()
        timeline.ingest([row(self.now - 5)])
        self.assertEqual([r["ts"] for s in timeline.segments() for r in timeline.records(s["segment"])], [])

    def test_a_failed_batch_leaves_no_row(self):
        with self.assertRaises(OverflowError):
            self.timeline.ingest([row(T0 + 1), row(T0 + 2, pid=2 ** 63)])
        self.assertEqual(self.timeline.segments(), [])
        self.timeline.ingest([row(T0 + 3)])
        self.assertEqual([r["ts"] for r in self.timeline.records(int(T0))], [T0 + 3])


class TimelineServerTest(unittest.TestCase):
    request = support.request

    def setUp(self):
        support.enable_plugins(self, "screen_awareness")
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        state = Path(self.tmp.name)
        self.now = time.time()
        clock = lambda: self.now  # noqa: E731
        self.server = AgentdServer(("127.0.0.1", 0), "hook-token", UI)
        self.server.clock = clock
        blacklist = Blacklist(deny_blacklist(state / "blacklist.json"))
        self.server.attention = AttentionStore(state / "attention.sqlite", blacklist, clock=clock)
        self.addCleanup(self.server.attention.close)
        self.server.timeline = Timeline(state / "timeline.sqlite", blacklist, clock=clock)
        self.addCleanup(self.server.timeline.close)
        self.thread = support.serve_in_thread(self.server)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)
        self.tmp.cleanup()

    def record(self, ago=0.0, **extra):
        return {"ts": self.now - ago, "kind": "text_input", "app": "Code", "bundle_id": "x.Code", "pid": 1,
                "window_id": 9, "window_title": "server.py", "url_host": None,
                "target": {"role": "AXTextArea", "subrole": None, "title": "编辑器", "description": None,
                           "identifier": "editor", "value": "写一半"},
                "keys": None, "text": "写一半", "tree": {"mode": "full", "text": "AXWindow server.py"}, **extra}

    def post(self, *records):
        return self.request("POST", "/context/timeline", {"records": list(records)})

    def save(self, **settings):
        path = Path(self.tmp.name) / "config.json"
        path.write_text(json.dumps(settings), encoding="utf-8")
        self.server.privacy_config = str(path)

    def share_window_text(self, level="window"):
        self.server.capture = types.SimpleNamespace(share_text=True, vision=None, tick=lambda: None)
        self.save(share_window_text=True, screen_context_level=level, share_typed_text=True, share_actions=True)

    def stored(self):
        timeline = self.server.timeline
        return [r for s in timeline.segments() for r in timeline.records(s["segment"])]

    def test_a_batch_is_stored(self):
        self.server.share_typed_text = True
        self.assertEqual(self.post(self.record(2), self.record(1, kind="shortcut", keys="cmd+s", text=None)),
                         (200, {"stored": 2, "dropped": 0}))
        [first, second] = self.stored()
        self.assertEqual((first["kind"], first["text"], first["target"]["value"]), ("text_input", "写一半", "写一半"))
        self.assertEqual((second["kind"], second["keys"]), ("shortcut", "cmd+s"))

    def test_the_c6_sample_is_accepted(self):
        sample = json.loads(FIXTURE.read_text(encoding="utf-8"))
        for i, item in enumerate(sample["records"]):
            item["ts"] = self.now - len(sample["records"]) + i
        self.assertEqual(self.request("POST", "/context/timeline", sample),
                         (200, {"stored": len(sample["records"]), "dropped": 0}))

    def test_bad_records_are_dropped_one_by_one(self):
        target = self.record()["target"]
        bad = [self.record(kind="scroll"), self.record(601), self.record(-6), self.record(ts=True),
               self.record(pid="1"), self.record(window_id=True), self.record(app=3), self.record(keys=1),
               self.record(target={**target, "value": 3}), self.record(target="x"),
               self.record(tree={"mode": "patch", "text": ""}), self.record(tree={"mode": "full", "text": None}),
               self.record(bundle_id="com.1password.1password"), "x"]
        self.assertEqual(self.post(*bad, self.record(app=None, bundle_id="x.Code")),
                         (200, {"stored": 1, "dropped": len(bad)}))
        self.assertEqual([r["app"] for r in self.stored()], [None])

    def test_batch_shape_and_size(self):
        self.assertEqual(self.post(*[self.record()] * 201), (400, {"error": "too_many_records"}))
        for body in ([], {"records": {}}, {"records": []}):
            with self.subTest(body=body):
                self.assertEqual(self.request("POST", "/context/timeline", body), (400, {"error": "invalid_records"}))
        self.assertEqual(self.post(*[self.record()] * 200), (200, {"stored": 200, "dropped": 0}))

    def test_no_timeline_is_503(self):
        self.server.timeline = None
        self.assertEqual(self.post(self.record()), (503, {"error": "no_timeline"}))

    def test_a_pause_stores_nothing(self):
        self.server.paused_until = self.now + 60
        self.assertEqual(self.post(self.record()), (200, {"paused": True}))
        self.assertEqual(self.stored(), [])

    def test_records_from_an_ended_pause_are_dropped(self):
        self.assertEqual(self.request("PUT", "/observation/paused", {"minutes": 1})[0], 200)
        self.now += 10
        self.assertEqual(self.request("PUT", "/observation/paused", {"minutes": 0})[0], 200)
        self.now += 10
        self.assertEqual(self.post(self.record(15), self.record()), (200, {"stored": 1, "dropped": 1}))

    def test_without_window_text_the_tree_goes(self):
        self.server.share_typed_text = True
        self.assertEqual(self.post(self.record()), (200, {"stored": 1, "dropped": 0}))
        [stored] = self.stored()
        self.assertEqual((stored["tree"], stored["text"]), (None, "写一半"))

    def test_without_window_text_a_static_text_title_goes_with_the_tree(self):
        target = {**self.record()["target"], "role": "AXStaticText", "title": "secret"}
        for secure in (False, True):
            with self.subTest(secure=secure):
                self.server.timeline.clear()
                self.now += 1
                if secure:
                    self.share_window_text()
                self.server.attention._secure = secure
                self.assertEqual(self.post(self.record(kind="click", target=target)), (200, {"stored": 1, "dropped": 0}))
                [stored] = self.stored()
                self.assertEqual((stored["tree"], stored["target"]["title"]), (None, None))

    def test_the_focused_level_keeps_no_tree(self):
        self.share_window_text("focused")
        self.assertEqual(self.post(self.record()), (200, {"stored": 1, "dropped": 0}))
        [stored] = self.stored()
        self.assertEqual((stored["tree"], stored["target"]["title"]), (None, "编辑器"))

    def test_without_share_actions_nothing_is_stored(self):
        for settings in ({"share_actions": False}, {}):
            with self.subTest(settings=settings):
                self.save(share_window_text=True, screen_context_level="window", **settings)
                self.assertEqual(self.post(self.record()), (200, {"paused": True}))
                self.assertEqual(self.stored(), [])

    def test_the_tick_expires_old_records_without_new_ones(self):
        server = AgentdServer(("127.0.0.1", 0), "hook-token", UI, tick_interval=0.01)
        self.addCleanup(server.server_close)
        server.clock = lambda: self.now
        self.server.timeline.ingest([{**self.record(), "tree": None}])
        self.now += KEEP_S + 10
        server.timeline = self.server.timeline
        deadline = time.monotonic() + 5
        while self.stored() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(self.stored(), [])

    def test_secure_input_keeps_no_text_value_or_tree(self):
        self.server.share_typed_text = True
        self.share_window_text()
        self.server.attention._secure = True
        self.assertEqual(self.post(self.record()), (200, {"stored": 1, "dropped": 0}))
        [stored] = self.stored()
        self.assertEqual((stored["tree"], stored["text"], stored["target"]["value"]), (None, None, None))

    def test_records_hidden_by_a_later_rule_are_not_read(self):
        self.assertEqual(self.post(self.record()), (200, {"stored": 1, "dropped": 0}))
        self.server.timeline.blacklist.add("bundle_ids", "x.Code")
        self.assertEqual(self.stored(), [])

    def test_without_typed_text_text_and_value_go_and_the_tree_stays(self):
        self.share_window_text()
        self.assertEqual(self.post(self.record()), (200, {"stored": 1, "dropped": 0}))
        [stored] = self.stored()
        self.assertEqual((stored["text"], stored["target"]["value"], stored["target"]["title"]), (None, None, "编辑器"))
        self.assertEqual(stored["tree"], {"mode": "full", "text": "AXWindow server.py"})

    def test_long_fields_are_cut(self):
        self.server.share_typed_text = True
        self.share_window_text()
        target = {"role": "r" * 300, "subrole": "s" * 300, "title": "t" * 300, "description": "d" * 300,
                  "identifier": "i" * 300, "value": "v" * 3000}
        self.assertEqual(self.post(self.record(target=target, text="字" * 3000, keys="k" * 100, window_title="w" * 600,
                                               tree={"mode": "diff", "text": "x" * 40000})),
                         (200, {"stored": 1, "dropped": 0}))
        [stored] = self.stored()
        self.assertEqual({k: len(v) for k, v in stored["target"].items()},
                         {"role": 200, "subrole": 200, "title": 200, "description": 200, "identifier": 200,
                          "value": 2000})
        self.assertEqual((len(stored["text"]), len(stored["keys"]), len(stored["window_title"]),
                          len(stored["tree"]["text"]), stored["tree"]["mode"]), (2000, 64, 500, 32000, "diff"))

    def test_delete_observation_and_attention_empty_the_timeline(self):
        self.server.timeline.ingest([{**self.record(1000), "target": None, "tree": None}])
        self.assertEqual(self.post(self.record()), (200, {"stored": 1, "dropped": 0}))
        self.assertEqual(self.request("DELETE", "/observation?range=15m")[0], 200)
        self.assertEqual(len(self.stored()), 1)
        self.assertEqual(self.request("DELETE", "/attention")[0], 200)
        self.assertEqual(self.stored(), [])

    def test_reset_empties_the_timeline(self):
        self.assertEqual(self.post(self.record()), (200, {"stored": 1, "dropped": 0}))
        status, body = self.server.reset()
        self.assertEqual(status, 200, body)
        self.assertEqual((body["deleted"]["timeline"], body["rows"]["timeline"]), (1, 0))
        self.assertEqual(self.stored(), [])

    def test_revoking_typed_text_drops_the_kept_text(self):
        self.server.share_typed_text = True
        self.assertEqual(self.post(self.record()), (200, {"stored": 1, "dropped": 0}))
        self.server.share_typed_text = False
        self.server.sync_privacy()
        [stored] = self.stored()
        self.assertEqual((stored["text"], stored["target"]["value"]), (None, None))

    def test_revoking_window_text_drops_the_kept_trees(self):
        self.share_window_text()
        self.assertEqual(self.post(self.record()), (200, {"stored": 1, "dropped": 0}))
        self.server.capture = None
        self.server.sync_privacy()
        [stored] = self.stored()
        self.assertIsNone(stored["tree"])

    def test_startup_without_window_text_drops_the_kept_trees(self):
        from daemon.main import startup_privacy
        self.server.timeline.ingest([{**self.record(), "text": None}])
        startup_privacy(self.server)
        [stored] = self.stored()
        self.assertIsNone(stored["tree"])

    def test_startup_below_the_window_level_drops_the_kept_trees(self):
        from daemon.main import startup_privacy
        self.server.timeline.ingest([{**self.record(), "text": None}])
        self.share_window_text("window")
        startup_privacy(self.server)
        self.assertEqual(self.stored()[0]["tree"], {"mode": "full", "text": "AXWindow server.py"})
        self.share_window_text("focused")
        startup_privacy(self.server)
        [stored] = self.stored()
        self.assertIsNone(stored["tree"])

    def test_ids_outside_int64_are_dropped(self):
        big = [self.record(pid=2 ** 63), self.record(window_id=2 ** 63), self.record(pid=-2 ** 63 - 1)]
        self.assertEqual(self.post(*big), (200, {"stored": 0, "dropped": 3}))
        self.assertEqual(self.post(self.record(1), *big), (200, {"stored": 1, "dropped": 3}))
        self.assertEqual(len(self.stored()), 1)

    def test_a_blacklist_entry_with_delete_existing_takes_its_records(self):
        self.assertEqual(self.post(self.record(1), self.record(app="Notes", bundle_id="com.apple.Notes")),
                         (200, {"stored": 2, "dropped": 0}))
        self.assertEqual(self.request("POST", "/blacklist", {"field": "app_names", "value": "Notes",
                                                             "delete_existing": True})[0], 200)
        self.assertEqual([r["app"] for r in self.stored()], ["Code"])

    def test_summaries_routes_list_search_and_delete(self):
        seg1 = int(self.now // SEGMENT_S) * SEGMENT_S
        seg2 = seg1 - SEGMENT_S
        self.assertTrue(self.server.timeline.add_summary(seg2, "# Older\nFixed shader compile", self.server.timeline.revision))
        self.assertTrue(self.server.timeline.add_summary(seg1, "# Latest\nDeployed timeline", self.server.timeline.revision))
        code, body = self.request("GET", "/context/timeline/summaries")
        self.assertEqual(code, 200)
        self.assertEqual([s["segment"] for s in body["summaries"]], [seg1, seg2])
        code, found = self.request("GET", "/context/timeline/summaries?q=shader")
        self.assertEqual(code, 200)
        self.assertEqual([s["segment"] for s in found["summaries"]], [seg2])
        code, gone = self.request("DELETE", f"/context/timeline/summaries/{seg2}")
        self.assertEqual((code, gone), (200, {"deleted": True, "segment": seg2}))
        code, after = self.request("GET", "/context/timeline/summaries?q=shader")
        self.assertEqual((code, after["summaries"]), (200, []))
        self.assertEqual(self.request("GET", "/context/timeline/summaries?limit=0")[0], 400)


if __name__ == "__main__":
    unittest.main()
