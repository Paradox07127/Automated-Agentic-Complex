import datetime
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from character.reminder_offer import offer  # noqa: E402
from personal.commitments import parse_reminder  # noqa: E402

NOW = datetime.datetime(2026, 11, 2, 12).timestamp()


class ReminderOfferTest(unittest.TestCase):
    def test_task_round_trip(self):
        label, reply = offer('修渲染', '检查材质', NOW)
        self.assertEqual((label, reply), ('明天 9 点提醒我', '提醒我明天9点接着做修渲染：检查材质'))
        self.assertEqual(parse_reminder(reply, NOW),
                         (datetime.datetime(2026, 11, 3, 9).timestamp(), '接着做修渲染：检查材质', None))

    def test_time_or_repeat_in_task_text_cannot_change_reminder(self):
        for title, step in (('每天同步', '检查结果'), ('10分钟后发版', '检查结果'),
                            ('修渲染', '每天检查结果'), ('修渲染', '10分钟后检查结果'),
                            ('工作日报告', '检查结果')):
            with self.subTest(title=title, step=step):
                self.assertIsNone(offer(title, step, NOW))

    def test_clock_inside_title_is_preserved(self):
        label, reply = offer('修3点的故障', '检查结果', NOW)
        self.assertEqual(parse_reminder(reply, NOW)[1:], ('接着做修3点的故障：检查结果', None))

    def test_daily_round_trip_before_and_after_nine(self):
        for hour, due_day in ((8, 2), (9, 3), (18, 3)):
            with self.subTest(hour=hour):
                now = datetime.datetime(2026, 11, 2, hour).timestamp()
                label, reply = offer('整理日报', '', now, repeat='daily')
                self.assertEqual((label, reply), ('每天 9 点提醒我', '提醒我每天9点整理日报'))
                self.assertEqual(parse_reminder(reply, now),
                                 (datetime.datetime(2026, 11, due_day, 9).timestamp(), '整理日报', 'daily'))

    def test_daily_relative_time_is_rejected(self):
        self.assertIsNone(offer('10分钟后整理日报', '', NOW, repeat='daily'))

    def test_texts_are_in_the_reply_language_and_the_same_titles_are_rejected(self):
        for language, once, daily in (
                ('zh-Hans', ('明天 9 点提醒我', '提醒我明天9点接着做修渲染：检查材质'), ('每天 9 点提醒我', '提醒我每天9点修渲染')),
                (None, ('明天 9 点提醒我', '提醒我明天9点接着做修渲染：检查材质'), ('每天 9 点提醒我', '提醒我每天9点修渲染')),
                ('en', ('Remind me tomorrow at 9', 'Remind me tomorrow at 9:00 to continue "修渲染": 检查材质'),
                 ('Remind me daily at 9', 'Remind me every day at 9:00: 修渲染')),
                ('ja', ('明日 9 時にリマインド', '明日 9 時に「修渲染」の続きをリマインドして：检查材质'),
                 ('毎日 9 時にリマインド', '毎日 9 時にリマインドして：修渲染'))):
            with self.subTest(language=language):
                self.assertEqual(offer('修渲染', '检查材质', NOW, language=language), once)
                self.assertEqual(offer('修渲染', '', NOW, repeat='daily', language=language), daily)
                self.assertIsNone(offer('10分钟后发版', '检查结果', NOW, language=language))
