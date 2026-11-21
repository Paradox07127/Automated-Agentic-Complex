from pathlib import Path
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from brain.parser import parse_command  # noqa: E402
from personal.commitments import Commitments, awaited, parse_reminder, parse_wait  # noqa: E402
from infra.store import open_store  # noqa: E402


def local(day, hour, minute=0):
    """Unix seconds of 2026-10-<day> hour:minute in the local time zone."""
    return time.mktime((2026, 10, day, hour, minute, 0, 0, 0, -1))


class ParseReminderTest(unittest.TestCase):
    def setUp(self):
        self.now = local(23, 10)

    def test_minutes_from_now(self):
        self.assertEqual(parse_reminder("提醒我 10 分钟后喝水", self.now), (self.now + 600, "喝水", None))

    def test_half_an_hour_from_now(self):
        self.assertEqual(parse_reminder("提醒我半小时后站起来", self.now), (self.now + 1800, "站起来", None))

    def test_tomorrow_morning(self):
        self.assertEqual(parse_reminder("提醒我明天上午9点开会", self.now), (local(24, 9), "开会", None))

    def test_afternoon_half_past_in_chinese_numbers(self):
        self.assertEqual(parse_reminder("提醒我下午三点半交周报", self.now), (local(23, 15, 30), "交周报", None))

    def test_clock_time(self):
        self.assertEqual(parse_reminder("提醒我 15:30 打电话", self.now), (local(23, 15, 30), "打电话", None))

    def test_an_hour_already_past_today_is_tomorrow(self):
        self.assertEqual(parse_reminder("提醒我八点吃药", self.now), (local(24, 8), "吃药", None))

    def test_common_variants_of_hours_colon_and_midnight(self):
        self.assertEqual(parse_reminder("提醒我两个小时后关火", self.now), (self.now + 7200, "关火", None))
        self.assertEqual(parse_reminder("提醒我 15：30 打电话", self.now), (local(23, 15, 30), "打电话", None))
        self.assertEqual(parse_reminder("提醒我晚上12点关灯", self.now), (local(24, 0), "关灯", None))

    def test_parse_meitian(self):
        self.assertEqual(parse_reminder("提醒我每天8点吃药", self.now), (local(24, 8), "吃药", "daily"))
        self.assertEqual(parse_reminder("工作日下午6点提醒我下班", self.now), (local(23, 18), "下班", "weekdays"))
        self.assertEqual(parse_reminder("提醒我每个工作日9点打卡", self.now), (local(26, 9), "打卡", "weekdays"))

    def test_no_reminder_or_nothing_to_remind(self):
        self.assertIsNone(parse_reminder("我等会儿喝水", self.now))
        self.assertIsNone(parse_reminder("提醒我", self.now))

    def test_parse_wait_for_claude(self):
        self.assertEqual(parse_wait("等 Claude 做完提醒我看测试结果"),
                         ({"kind": "session_done", "agent": "claude"}, "看测试结果"))
        self.assertEqual(parse_wait("codex 跑完提醒我提交"), ({"kind": "session_done", "agent": "codex"}, "提交"))
        self.assertEqual(parse_command("等 claude 做完提醒我看结果"), {"action": "remind", "text": "等 claude 做完提醒我看结果"})
        self.assertIsNone(parse_wait("提醒我十分钟后喝水"))
        self.assertIsNone(parse_wait("等 claude 做完提醒我"))

    def test_what_a_trigger_awaits_is_worded_in_the_reply_language(self):
        claude, any_session = {"kind": "session_done", "agent": "claude"}, {"kind": "session_done"}
        approval = {"kind": "approval_waiting", "minutes": 5}
        for language, words in (("zh-Hans", ("claude 做完", "会话做完", "审批等满 5 分钟")),
                                (None, ("claude 做完", "会话做完", "审批等满 5 分钟")),
                                ("en", ("claude finishes", "a session finishes", "an approval has waited 5 min")),
                                ("ja", ("claude の完了", "セッションの完了", "承認待ち 5 分"))):
            with self.subTest(language=language):
                self.assertEqual(tuple(awaited(t, language) for t in (claude, any_session, approval)), words)


class CalendarReminderTest(unittest.TestCase):
    def setUp(self):
        self.now = self.at(9, 15)

    def at(self, day, hour=9, minute=0):
        return time.mktime((2026, 11, day, hour, minute, 0, 0, 0, -1))

    def test_midnight_after_an_evening_and_a_time_of_today_that_has_passed(self):
        for text, expected in (("提醒我今晚十二点睡觉", (self.at(10, 0), "睡觉", None)),
                               ("提醒我明晚十二点关灯", (self.at(11, 0), "关灯", None)),
                               ("提醒我凌晨十二点收衣服", (self.at(10, 0), "收衣服", None)),
                               ("提醒我今天下午两点开会", None),
                               ("提醒我下午两点开会", (self.at(10, 14), "开会", None))):
            with self.subTest(text=text):
                self.assertEqual(parse_reminder(text, self.now), expected)

    def test_reminder_time_table(self):
        samples = (
            ("提醒我周五下午三点给王工回邮件", (self.at(13, 15), "给王工回邮件", None)),
            ("提醒我后天早上八点半出门", (self.at(11, 8, 30), "出门", None)),
            ("提醒我下周一交报告", (self.at(16), "交报告", None)),
            ("提醒我 3pm 开会", (self.at(10, 15), "开会", None)),
            ("提醒我大后天上午十点复查", (self.at(12, 10), "复查", None)),
            ("提醒我周三上午十点开会", (self.at(11, 10), "开会", None)),
            ("提醒我明天上午十点开会", (self.at(10, 10), "开会", None)),
            ("提醒我 10 分钟后喝水", (self.at(9, 15, 10), "喝水", None)),
            ("提醒我下午三点半开会", (self.at(9, 15, 30), "开会", None)),
            ("提醒我两小时后交周报", (self.at(9, 17), "交周报", None)),
            ("提醒我每天九点站会", (self.at(10, 9), "站会", "daily")),
            ("提醒我今晚九点打电话", (self.at(9, 21), "打电话", None)),
            ("提醒我一个半小时后开会", (self.at(9, 16, 30), "开会", None)),
            ("提醒我两个半小时后开会", (self.at(9, 17, 30), "开会", None)),
            ("提醒我明早八点出门", (self.at(10, 8), "出门", None)),
            ("提醒我明晚八点看电影", (self.at(10, 20), "看电影", None)),
            ("提醒我这周五下午三点开会", (self.at(13, 15), "开会", None)),
            ("提醒我本周五开会", (self.at(13), "开会", None)),
            ("提醒我中午十二点吃饭", (self.at(10, 12), "吃饭", None)),
            ("提醒我凌晨两点收衣服", (self.at(10, 2), "收衣服", None)),
            ("提醒我月底前续费", None),
            ("提醒我晚点看一下这个", None),
            ("提醒我一会儿吃药", None),
            ("提醒我喝水", None),
            ("提醒我11月20日交材料", None),
            ("提醒我20号交材料", None),
            ("提醒我周末打扫", None),
            ("提醒我下个月续保", None),
            ("提醒我下周跟进报价", None),
        )
        for text, expected in samples:
            with self.subTest(text=text):
                self.assertEqual(parse_reminder(text, self.now), expected)

    def test_weekday_words(self):
        for prefix in ("周", "星期", "礼拜"):
            for weekday, day in (("一", 16), ("二", 10), ("三", 11), ("四", 12),
                                 ("五", 13), ("六", 14), ("日", 15), ("天", 15)):
                with self.subTest(prefix=prefix, weekday=weekday):
                    self.assertEqual(parse_reminder(f"提醒我{prefix}{weekday}上午十点开会", self.now),
                                     (self.at(day, 10), "开会", None))

    def test_today_weekday_uses_today_only_before_the_clock_time(self):
        for hour, day in ((16, 9), (15, 16), (14, 16)):
            with self.subTest(hour=hour):
                self.assertEqual(parse_reminder(f"提醒我周一{hour}:00开会", self.now),
                                 (self.at(day, hour), "开会", None))

    def test_next_week_uses_the_next_calendar_week(self):
        self.assertEqual(parse_reminder("提醒我下周五下午三点开会", self.now),
                         (self.at(20, 15), "开会", None))

    def test_date_without_clock_uses_nine(self):
        for word, day in (("明天", 10), ("后天", 11), ("大后天", 12), ("周三", 11)):
            with self.subTest(word=word):
                self.assertEqual(parse_reminder(f"提醒我{word}交报告", self.now),
                                 (self.at(day), "交报告", None))

    def test_am_pm_clock_times(self):
        for clock, day, hour, minute in (("8am", 10, 8, 0), ("3:30pm", 9, 15, 30),
                                         ("12am", 10, 0, 0), ("12pm", 10, 12, 0)):
            with self.subTest(clock=clock):
                self.assertEqual(parse_reminder(f"提醒我 {clock} 开会", self.now),
                                 (self.at(day, hour, minute), "开会", None))
        for clock in ("0am", "13pm", "3:60pm"):
            with self.subTest(clock=clock):
                self.assertIsNone(parse_reminder(f"提醒我 {clock} 开会", self.now))

    def test_time_words_away_from_the_time_stay_in_the_text(self):
        for text, what in (("提醒我下午三点准备明天的会", "准备明天的会"), ("提醒我明天9点修3点的故障", "修3点的故障"),
                           ("提醒我十分钟后把晚上的票订了", "把晚上的票订了")):
            with self.subTest(text=text):
                self.assertEqual(parse_reminder(text, self.now)[1], what)

    def test_time_word_before_the_ask_is_rejected(self):
        self.assertIsNone(parse_reminder("周五提醒我下午三点开会", self.now))

    def test_today_without_clock_is_rejected(self):
        self.assertIsNone(parse_reminder("提醒我今天交报告", self.now))

    def test_unused_time_words_are_rejected(self):
        for text in ("提醒我月底前下午三点续费", "提醒我晚点下午三点看一下这个",
                     "提醒我一会儿十分钟后吃药", "提醒我下周一早上交报告",
                     "提醒我周五明天下午三点开会", "提醒我明天十分钟后喝水",
                     "提醒我下午三点晚上吃药", "提醒我3pm4pm开会",
                     "提醒我月底下午三点续费", "提醒我月初上午十点续保", "提醒我下个月十点续保", "提醒我下月十点续保",
                     "提醒我20号下午三点交材料", "提醒我11月20日下午三点交材料", "提醒我周末上午十点打扫",
                     "提醒我下周下午三点跟进报价", "提醒我傍晚六点散步"):
            with self.subTest(text=text):
                self.assertIsNone(parse_reminder(text, self.now))


class CommitmentsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "agentd.sqlite"
        self.db = open_store(self.path)
        self.now = 1000.0
        self.commitments = Commitments(self.db, clock=lambda: self.now)

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def test_armed_then_triggered_once_then_fulfilled(self):
        item = self.commitments.add("喝水", 1600.0, created_line="line-1")
        self.assertEqual((item["state"], item["text"], item["created_line"]), ("armed", "喝水", "line-1"))
        self.assertEqual(self.commitments.due(), [])
        self.now = 1600.0
        due = self.commitments.due()
        self.assertEqual([(c["id"], c["state"]) for c in due], [(item["id"], "triggered")])
        self.assertEqual(self.commitments.due(), [])
        done = self.commitments.fulfill(item["id"], "line-2")
        self.assertEqual((done["state"], done["delivered_line"]), ("fulfilled", "line-2"))
        with self.assertRaisesRegex(ValueError, "illegal_transition"):
            self.commitments.fulfill(item["id"], "line-3")
        with self.assertRaisesRegex(ValueError, "unknown_commitment"):
            self.commitments.fulfill("nope", "line-3")

    def test_an_armed_item_can_be_completed(self):
        item = self.commitments.add("喝水", 1600.0)
        done = self.commitments.fulfill(item["id"], None)
        self.assertEqual((done["state"], done["delivered_line"]), ("fulfilled", None))

    def test_snooze_rearms_armed_and_triggered_items(self):
        for due_at in (1600.0, 1000.0):
            with self.subTest(due_at=due_at):
                item = self.commitments.add("喝水", due_at)
                self.commitments.due()
                self.now += 10
                snoozed = self.commitments.snooze(item["id"], self.now + 600)
                self.assertEqual((snoozed["state"], snoozed["due_at"], snoozed["updated_at"]),
                                 ("armed", self.now + 600, self.now))
                self.assertEqual(self.commitments.due(), [])
                self.now += 600
                self.assertIn(item["id"], [c["id"] for c in self.commitments.due()])

    def test_snooze_rejects_terminal_and_unknown_items(self):
        for state in ("fulfilled", "cancelled", "missed"):
            with self.subTest(state=state):
                item = self.commitments.add("喝水", 1000.0)
                self.db.execute("UPDATE commitments SET state = ?, updated_at = ? WHERE id = ?",
                                (state, self.now - 86401, item["id"]))
                with self.assertRaisesRegex(ValueError, "illegal_transition"):
                    self.commitments.snooze(item["id"], self.now + 600)
        with self.assertRaisesRegex(ValueError, "unknown_commitment"):
            self.commitments.snooze("nope", self.now + 600)

    def test_snooze_rearms_a_reminder_delivered_within_a_day(self):
        recent, old = self.commitments.add("喝水", 1000.0), self.commitments.add("开会", 1000.0)
        self.commitments.due()
        self.commitments.fulfill(old["id"], None)
        self.now += 1
        self.commitments.fulfill(recent["id"], None)
        self.now += 86400
        snoozed = self.commitments.snooze(recent["id"], self.now + 300)
        self.assertEqual((snoozed["state"], snoozed["due_at"]), ("armed", self.now + 300))
        with self.assertRaisesRegex(ValueError, "illegal_transition"):
            self.commitments.snooze(old["id"], self.now + 300)

    def test_weekday_reminder_skips_weekend(self):
        friday = time.mktime((2026, 10, 23, 9, 0, 0, 0, 0, -1))
        item = self.commitments.add("打卡", friday, repeat="weekdays")
        self.assertEqual(item["repeat"], "weekdays")
        self.now = friday
        [triggered] = self.commitments.due()
        done = self.commitments.fulfill(item["id"], None)
        self.assertEqual((done["state"], done["due_at"], done["revision"]),
                         ("armed", time.mktime((2026, 10, 26, 9, 0, 0, 0, 0, -1)), triggered["revision"] + 1))

    def test_a_shown_card_is_recorded_once_and_leaves_the_reminder_alone(self):
        item = self.commitments.add("喝水", 1000.0)
        [due] = self.commitments.due()
        self.assertIsNone(due["seen_at"])
        self.now = 1005.0
        seen = self.commitments.seen(item["id"])
        self.assertEqual(seen, {**due, "seen_at": 1005.0})
        self.now = 1010.0
        self.assertEqual(self.commitments.seen(item["id"]), seen)
        self.assertIsNone(self.commitments.seen("nope"))

    def test_each_time_a_repeating_reminder_comes_due_it_is_unseen_again(self):
        item = self.commitments.add("吃药", 1000.0, repeat="daily")
        self.commitments.due()
        self.assertEqual(self.commitments.seen(item["id"])["seen_at"], 1000.0)
        again = self.commitments.fulfill(item["id"], None)
        self.now = again["due_at"]
        [due] = self.commitments.due()
        self.assertEqual((due["id"], due["state"], due["seen_at"]), (item["id"], "triggered", None))

    def test_session_done_trigger_fires_once(self):
        item = self.commitments.add("看结果", None, trigger={"kind": "session_done", "agent": "claude"})
        self.assertEqual((item["state"], item["due_at"], item["trigger"]),
                         ("armed", None, {"kind": "session_done", "agent": "claude"}))
        self.now = 1200.0
        self.assertEqual((self.commitments.due(), self.commitments.recover()), ([], []))
        [fired] = self.commitments.fire("session_done", {"agent": "claude", "session_id": "A"})
        self.assertEqual((fired["id"], fired["state"], fired["due_at"]), (item["id"], "armed", 1200.0))
        self.assertEqual(self.commitments.fire("session_done", {"agent": "claude", "session_id": "B"}), [])
        [due] = self.commitments.due()
        self.commitments.fulfill(due["id"], None)
        self.now = 1300.0
        self.assertEqual(self.commitments.fire("session_done", {"agent": "claude", "session_id": "A"}), [])
        self.assertEqual(self.commitments.due(), [])

    def test_trigger_for_codex_ignores_claude_done(self):
        codex = self.commitments.add("提交", None, trigger={"kind": "session_done", "agent": "codex"})
        anyone = self.commitments.add("看看", None, trigger={"kind": "session_done", "agent": None})
        one = self.commitments.add("合并", None, trigger={"kind": "session_done", "agent": "claude", "session_id": "B"})
        self.assertEqual([c["id"] for c in self.commitments.fire("session_done", {"agent": "claude", "session_id": "A"})],
                         [anyone["id"]])
        self.assertEqual([c["id"] for c in self.commitments.fire("session_done", {"agent": "codex", "session_id": "B"})],
                         [codex["id"]])
        self.assertEqual([c["id"] for c in self.commitments.fire("session_done", {"agent": "claude", "session_id": "B"})],
                         [one["id"]])

    def test_approval_waiting_trigger_fires_at_its_minutes(self):
        item = self.commitments.add("去批准", None, trigger={"kind": "approval_waiting", "minutes": 5})
        self.assertEqual(self.commitments.fire("session_done", {"agent": "claude", "session_id": "A"}), [])
        self.assertEqual(self.commitments.fire("approval_waiting", {"minutes": 4.9}), [])
        self.assertEqual([c["id"] for c in self.commitments.fire("approval_waiting", {"minutes": 5.0})], [item["id"]])

    def test_trigger_expires_after_24h_as_missed(self):
        item = self.commitments.add("看结果", None, trigger={"kind": "session_done", "agent": "claude"})
        timed = self.commitments.add("喝水", 1000.0 + 86400 * 2)
        self.now += 86399
        self.assertEqual(self.commitments.expire(), [])
        self.now += 1
        [missed] = self.commitments.expire()
        self.assertEqual((missed["id"], missed["state"]), (item["id"], "missed"))
        self.assertEqual(self.commitments.fire("session_done", {"agent": "claude", "session_id": "A"}), [])
        self.assertEqual({c["id"]: c["state"] for c in self.commitments.list()},
                         {item["id"]: "missed", timed["id"]: "armed"})

    def test_restart_keeps_armed_items_and_misses_late_and_undelivered_ones(self):
        soon = self.commitments.add("开会", 1200.0)
        late = self.commitments.add("吃药", 1100.0)
        cut = self.commitments.add("喝水", 900.0)
        self.assertEqual([c["id"] for c in self.commitments.due()], [cut["id"]])
        self.db.close()
        self.db = open_store(self.path)
        self.now = 1800.0
        restarted = Commitments(self.db, clock=lambda: self.now)
        self.assertEqual({c["id"]: c["state"] for c in restarted.list()},
                         {soon["id"]: "armed", late["id"]: "armed", cut["id"]: "triggered"})
        missed = restarted.recover()
        self.assertEqual(sorted(c["id"] for c in missed), sorted((late["id"], cut["id"])))
        self.assertEqual({c["id"]: c["state"] for c in restarted.list()},
                         {soon["id"]: "armed", late["id"]: "missed", cut["id"]: "missed"})
        self.assertEqual([c["id"] for c in restarted.list(states=("armed",))], [soon["id"]])
        self.assertEqual(restarted.recover(), [])

    def test_recover_rearms_a_repeating_reminder_and_reports_the_missed_time(self):
        item = self.commitments.add("吃药", local(24, 8), repeat="daily")
        self.now = local(24, 20)
        [missed] = Commitments(self.db, clock=lambda: self.now).recover()
        self.assertEqual((missed["id"], missed["due_at"]), (item["id"], local(24, 8)))
        [again] = self.commitments.list()
        self.assertEqual((again["state"], again["due_at"]), ("armed", local(25, 8)))

    def test_a_deleted_item_is_never_due(self):
        item = self.commitments.add("喝水", 1600.0)
        self.assertTrue(self.commitments.delete(item["id"]))
        self.assertFalse(self.commitments.delete(item["id"]))
        self.now = 2000.0
        self.assertEqual(self.commitments.due(), [])
        self.assertEqual(self.commitments.list(), [])

    def test_an_armed_item_can_be_cancelled_once(self):
        item = self.commitments.add("喝水", 1600.0)
        self.now = 1100.0
        cancelled = self.commitments.cancel(item["id"])
        self.assertEqual((cancelled["id"], cancelled["state"], cancelled["updated_at"]), (item["id"], "cancelled", 1100.0))
        self.assertEqual(self.commitments.list(), [cancelled])
        with self.assertRaisesRegex(ValueError, "illegal_transition"):
            self.commitments.cancel(item["id"])
        with self.assertRaisesRegex(ValueError, "unknown_commitment"):
            self.commitments.cancel("nope")

    def test_a_triggered_item_can_be_cancelled(self):
        item = self.commitments.add("喝水", 1000.0)
        self.commitments.due()
        self.assertEqual(self.commitments.cancel(item["id"])["state"], "cancelled")

    def test_terminal_items_cannot_be_cancelled(self):
        triggered = self.commitments.add("喝水", 1000.0)
        fulfilled = self.commitments.add("开会", 1000.0)
        missed = self.commitments.add("吃药", 100.0)
        self.commitments.due()
        self.commitments.fulfill(fulfilled["id"], None)
        self.db.execute("UPDATE commitments SET state = 'missed' WHERE id = ?", (missed["id"],))
        self.commitments.cancel(triggered["id"])
        for item in (triggered, fulfilled, missed):
            with self.assertRaisesRegex(ValueError, "illegal_transition"):
                self.commitments.cancel(item["id"])

    def test_a_cancelled_item_is_never_due_nor_missed(self):
        item = self.commitments.add("喝水", 1600.0)
        self.commitments.cancel(item["id"])
        self.now = 5000.0
        self.assertEqual(self.commitments.due(), [])
        self.assertEqual(self.commitments.recover(), [])
        self.assertEqual([c["state"] for c in self.commitments.list()], ["cancelled"])

    def test_list_is_by_due_time(self):
        later = self.commitments.add("b", 3000.0)
        sooner = self.commitments.add("a", 2000.0)
        self.assertEqual([c["id"] for c in self.commitments.list()], [sooner["id"], later["id"]])


if __name__ == "__main__":
    unittest.main()
