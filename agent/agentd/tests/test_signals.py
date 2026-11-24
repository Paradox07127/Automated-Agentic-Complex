import datetime
from pathlib import Path
import sys
import threading
import unittest
from types import SimpleNamespace as NS

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from character.gate import Gate  # noqa: E402
from character.signals import REPEAT_RECHECK, Signals  # noqa: E402
from daemon.ingest import IngestMixin  # noqa: E402
from sessions.events import normalize_claude  # noqa: E402
from sessions.registry import Registry  # noqa: E402
from support import enable_plugins  # noqa: E402
from test_check_result import SWIFT  # noqa: E402

T0 = datetime.datetime(2026, 11, 2, 12).timestamp()


class SignalsTest(unittest.TestCase):
    def setUp(self):
        self.now, self.posts = T0, []
        self.gate = Gate(enabled=True)
        self.registry = Registry(clock=lambda: self.now, coalesce=0)
        self.presence, self.allowed, self.pending = 'present', True, []
        self.own = NS(own_id=lambda sid: 'own:A' if sid == 'owned' else sid)
        self.away = False
        self.signals = Signals(self.gate, NS(post=lambda data: self.posts.append(data), log=None), self.registry,
                               sessions=self.own, presence=lambda: self.presence,
                               allowed=lambda row: self.allowed, pending=lambda: self.pending,
                               clock=lambda: self.now, absent=lambda: self.away)

    def leave(self):
        self.away, self.presence = True, 'away'

    def back(self):
        """user_now's return."""
        self.away, self.presence = False, 'present'
        self.signals.returned()

    def logged(self, reason, *outcomes):
        """A ProactiveLog under the signals whose `signal.<reason>` thoughts had outcomes, oldest first."""
        import tempfile
        from character.proactive_log import ProactiveLog
        from infra.store import open_store
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db = open_store(Path(tmp.name) / 'agentd.sqlite')
        self.addCleanup(db.close)
        log = ProactiveLog(db)
        for i, outcome in enumerate(outcomes):
            log.shown(f'old{i}', 'thought', f'signal.{reason}', None, '旧信号', None, None, self.now - 3000 + i)
            log.feedback(f'old{i}', outcome, self.now - 2990 + i)
        self.signals.thoughts.log = log
        return log

    def errors(self, *waits):
        """A session error after each wait in seconds: how many posted."""
        before = len(self.posts)
        for wait in waits:
            self.now += wait
            self.hook('UserPromptSubmit')
            self.hook('StopFailure', error='rate_limit')
        return len(self.posts) - before

    def hook(self, name, sid='A', **body):
        event = normalize_claude({'hook_event_name': name, 'session_id': sid, 'cwd': '/work/Endfield', **body},
                                 now=self.now)
        event.request_id = body.get('request_id')
        before = self.registry.sessions.get(event.key)
        was = before.state if before else None
        self.signals.on_hook(event, body)
        self.registry.ingest(event)
        after = self.registry.sessions.get(event.key)
        return self.signals.on_transition(was, after.to_dict() if after else None, event)

    def failed(self, sid='A'):
        self.hook('UserPromptSubmit', sid)
        self.hook('PostToolUseFailure', sid, tool_name='Bash', tool_input={'command': 'swift test'}, **SWIFT)
        return self.hook('Stop', sid)

    def test_failed_check_posts_once_with_template(self):
        self.assertTrue(self.failed())
        self.hook('Stop')
        self.assertEqual(len(self.posts), 1)
        self.assertEqual(self.posts[0]['text'], 'Claude Code 的 swift test 红了 3 条，都是 HostSeatTests')
        self.assertEqual(self.posts[0]['reason'], 'signal.check_failed')
        self.assertIn('Endfield', self.posts[0]['reply'])

    def test_session_lines_are_in_the_reply_language(self):
        for language, text, offer, reply in (
                ('zh-Hans', 'Claude Code 的 swift test 红了 3 条，都是 HostSeatTests', '开个会话看看？',
                 '帮我开一个会话看看 Endfield 的 swift test 为什么红了 3 条'),
                (None, 'Claude Code 的 swift test 红了 3 条，都是 HostSeatTests', '开个会话看看？',
                 '帮我开一个会话看看 Endfield 的 swift test 为什么红了 3 条'),
                ('en', "Claude Code's swift test has 3 failing, all in HostSeatTests", 'Open a session to look?',
                 "Open a session to look at why Endfield's swift test has 3 failing"),
                ('ja', 'Claude Code の swift test で 3 件失敗、すべて HostSeatTests', 'セッションを開いて見てみる？',
                 'セッションを開いて、Endfield の swift test がなぜ 3 件失敗したか見て')):
            with self.subTest(language=language):
                self.setUp()
                self.signals.semantic = NS(reply=lambda: language)
                self.failed()
                self.assertEqual([(p['text'], p['offer'], p['reply']) for p in self.posts], [(text, offer, reply)])
        for language, detail in (('zh-Hans', '请求被限流了'), ('en', 'requests were rate limited'),
                                 ('ja', 'リクエストが制限された')):
            with self.subTest(error=language):
                self.setUp()
                self.signals.semantic = NS(reply=lambda: language)
                self.errors(0)
                self.assertTrue(self.posts[0]['text'].endswith(detail), self.posts[0]['text'])

    def test_same_failure_set_and_session_cooldown(self):
        self.failed()
        self.now += 601
        self.failed()
        self.assertEqual(len(self.posts), 1)
        self.hook('UserPromptSubmit')
        self.hook('PostToolUseFailure', tool_name='Bash', tool_input={'command': 'pytest'}, error='Exit code 2')
        self.hook('Stop')
        self.assertEqual(len(self.posts), 2)
        self.failed()
        self.assertEqual(len(self.posts), 2)

    def test_category_and_thought_mutes_and_context_gates(self):
        for mute in ('session', 'thought'):
            with self.subTest(mute=mute):
                self.setUp()
                self.gate.set_muted({mute})
                self.failed()
                self.assertEqual(self.posts, [])
        for flag in ('focus', 'meeting', 'fullscreen'):
            with self.subTest(flag=flag):
                self.setUp()
                setattr(self.gate, flag, True)
                self.failed()
                self.assertEqual(self.posts, [])

    def test_approval_90_seconds_once_and_not_after_stale(self):
        self.hook('UserPromptSubmit')
        self.hook('PermissionRequest', tool_name='Bash', tool_input={'command': 'swift test'})
        self.now += 85
        self.signals.tick(self.now)
        self.assertEqual(self.posts, [])
        self.now += 5
        self.signals.tick(self.now)
        self.now += 5
        self.signals.tick(self.now)
        self.assertEqual(len(self.posts), 1)
        self.assertEqual(self.posts[0]['reason'], 'signal.approval_wait')
        self.assertTrue(self.posts[0]['text'].startswith('Claude Code 在等你批准'), self.posts[0]['text'])
        self.assertIsNone(self.posts[0].get('offer'))
        self.hook('PermissionRequest', 'B', tool_name='Bash', tool_input={'command': 'ls'})
        self.now += 120
        self.signals.tick(self.now)
        self.assertEqual(len(self.posts), 1)

    def test_approval_wait_silent_while_quiet_and_posts_after(self):
        self.gate.meeting_manual = True
        self.hook('UserPromptSubmit')
        self.hook('PermissionRequest', tool_name='Bash', tool_input={'command': 'swift test'})
        self.now += 95
        self.signals.tick(self.now)
        self.assertEqual(self.posts, [])
        self.gate.meeting_manual = False
        self.now += 5
        self.signals.tick(self.now)
        self.assertEqual([post['reason'] for post in self.posts], ['signal.approval_wait'])

    def test_live_approval_card_holds_until_expired(self):
        self.hook('UserPromptSubmit')
        self.hook('PermissionRequest', request_id='card', tool_name='Bash', tool_input={'command': 'ls'})
        self.pending = [{'request_id': 'card'}]
        self.now += 90
        self.signals.tick(self.now)
        self.assertEqual(self.posts, [])
        self.pending = []
        self.now += 5
        self.signals.tick(self.now)
        self.assertEqual(len(self.posts), 1)

    def test_away_approval_is_dropped_if_stale_on_return(self):
        self.leave()
        self.hook('UserPromptSubmit')
        self.hook('PermissionRequest', tool_name='Bash', tool_input={'command': 'ls'})
        self.now += 90
        self.signals.tick(self.now)
        self.now += 30
        self.back()
        self.signals.tick(self.now)
        self.assertEqual(self.posts, [])

    def test_away_keeps_newer_event_over_repeated_quiet_checks(self):
        self.leave()
        self.hook('UserPromptSubmit')
        self.now += 900
        self.signals.tick(self.now)
        self.now += 1
        self.failed('B')
        self.now += 5
        self.signals.tick(self.now)
        self.now += 5
        self.back()
        self.signals.tick(self.now)
        self.assertEqual([p['session_id'] for p in self.posts], ['claude:B'])

    def test_signal_while_typing_waits_for_the_pause(self):
        self.gate.typing = True
        self.assertTrue(self.failed())
        self.assertEqual(self.posts, [])
        self.now += 5
        self.signals.tick(self.now)
        self.assertEqual(self.posts, [])
        self.now += 5
        self.gate.typing = False
        self.signals.tick(self.now)
        self.assertEqual([p['reason'] for p in self.posts], ['signal.check_failed'])

    def test_a_signal_in_the_quiet_stage_typing_brings_waits_for_the_pause(self):
        for stage, after, posted in (('quiet', {}, ['signal.check_failed']), ('offstage', {}, []),
                                     ('quiet', {'meeting': True}, [])):
            with self.subTest(stage=stage, after=after):
                self.setUp()
                self.gate.typing, self.gate.stage = True, stage
                self.failed()
                self.assertEqual(self.posts, [])
                self.now += 5
                self.gate.typing, self.gate.stage = False, 'normal'
                for flag, value in after.items():
                    setattr(self.gate, flag, value)
                self.signals.tick(self.now)
                self.assertEqual([p['reason'] for p in self.posts], posted)

    def test_a_signal_in_the_offstage_stage_an_absence_brings_waits_for_the_return(self):
        self.leave()
        self.gate.stage = 'offstage'
        self.failed()
        self.assertEqual(self.posts, [])
        self.gate.stage = 'normal'
        self.back()
        self.assertEqual([p['reason'] for p in self.posts], ['signal.check_failed'])

    def test_reset_drops_the_held_signal_and_what_the_cooldowns_remember(self):
        self.gate.typing = True
        self.failed()
        self.signals.reset()
        self.gate.typing = False
        self.now += 5
        self.signals.tick(self.now)
        self.assertEqual(self.posts, [])
        self.failed()
        self.signals.reset()
        self.failed()
        self.assertEqual(len(self.posts), 2)

    def test_signal_typed_through_for_120_seconds_is_dropped(self):
        self.gate.typing = True
        self.failed()
        for _ in range(25):
            self.now += 5
            self.signals.tick(self.now)
        self.now += 10
        self.gate.typing = False
        self.signals.tick(self.now)
        self.assertEqual(self.posts, [])

    def test_signal_while_not_typing_is_immediate(self):
        self.assertFalse(self.gate.typing)
        self.failed()
        self.assertEqual(len(self.posts), 1)

    def test_own_sessions_and_disallowed_content_are_skipped(self):
        self.failed('owned')
        self.allowed = False
        self.failed()
        self.assertEqual(self.posts, [])

    def test_away_holds_only_newest_and_rechecks_consent(self):
        self.leave()
        self.failed('A')
        self.now += 5
        self.failed('B')
        self.assertEqual(self.posts, [])
        self.back()
        self.signals.tick(self.now)
        self.assertEqual([p['session_id'] for p in self.posts], ['claude:B'])
        self.now += 5
        self.signals.tick(self.now)
        self.assertEqual(len(self.posts), 1)
        self.leave()
        self.failed('C')
        self.allowed = False
        self.now += 5
        self.back()
        self.signals.tick(self.now)
        self.assertEqual(len(self.posts), 1)

    def test_successful_retest_and_new_turn_clear_failure(self):
        self.hook('UserPromptSubmit')
        self.hook('PostToolUseFailure', tool_name='Bash', tool_input={'command': 'swift test'}, **SWIFT)
        self.hook('PostToolUse', tool_name='Bash', tool_input={'command': 'swift test'},
                  tool_response='Executed 12 tests, with 0 failures', exit_code=0)
        self.hook('Stop')
        self.hook('UserPromptSubmit')
        self.hook('Stop')
        self.assertEqual(self.posts, [])

    def test_session_errors_stop_failure_and_three_tool_failures(self):
        self.hook('UserPromptSubmit')
        self.hook('StopFailure', error='rate_limit')
        self.assertEqual(self.posts[0]['reason'], 'signal.session_error')
        self.assertIn('限流', self.posts[0]['text'])
        self.hook('UserPromptSubmit', 'B')
        for _ in range(3):
            self.hook('PreToolUse', 'B', tool_name='Read', tool_input={'file_path': '/tmp/a.py'})
            self.hook('PostToolUseFailure', 'B', tool_name='Read', error='missing')
        self.assertIn('连着 3 次 a.py 失败', self.posts[-1]['text'])
        self.now += 601
        for _ in range(3):
            self.hook('PreToolUse', 'B', tool_name='Read', tool_input={'file_path': '/tmp/a.py'})
            self.hook('PostToolUseFailure', 'B', tool_name='Read', error='missing')
        self.assertEqual(len(self.posts), 3)


    def test_quiet_only_stale_work_and_once_per_turn(self):
        self.hook('UserPromptSubmit')
        self.hook('PreToolUse', tool_name='Bash', tool_input={'command': 'swift test'})
        self.now += 895
        self.signals.tick(self.now)
        self.assertEqual(self.posts, [])
        self.now += 5
        self.signals.tick(self.now)
        self.assertEqual(self.posts[0]['reason'], 'signal.run_quiet')
        self.now += 5
        self.signals.tick(self.now)
        self.assertEqual(len(self.posts), 1)
        self.hook('Stop', last_assistant_message='完成了。')
        self.now += 901
        self.signals.tick(self.now)
        self.assertEqual(len(self.posts), 2)  # long turn's done, never another quiet signal

    def test_long_turn_done_uses_first_sentence_and_cooldown(self):
        self.hook('UserPromptSubmit')
        self.now += 600
        self.hook('Stop', last_assistant_message='修好了。详细说明在下面。')
        self.assertEqual(self.posts[0]['text'], 'Claude Code 在 Endfield 做完了：修好了。')
        self.hook('UserPromptSubmit')
        self.now += 600
        self.hook('Stop', last_assistant_message='又修好了。')
        self.assertEqual(len(self.posts), 1)

    def test_failed_long_turn_has_no_done_message_and_daily_cap_is_separate(self):
        self.gate._count = self.gate.daily_limit
        self.gate._day = datetime.date.fromtimestamp(self.now)
        for i in range(13):
            self.failed(str(i))
        self.assertEqual(len(self.posts), 12)
        self.hook('UserPromptSubmit', 'long')
        self.now += 600
        self.hook('PostToolUseFailure', 'long', tool_name='Bash', tool_input={'command': 'swift test'}, **SWIFT)
        self.hook('Stop', 'long', last_assistant_message='结束了。')
        self.assertFalse(any(p['reason'] == 'signal.turn_done' for p in self.posts))

    def test_mostly_dismissed_signal_doubles_its_cooldown(self):
        self.logged('session_error', 'dismissed', 'ignored', 'dismissed')
        self.assertEqual(self.errors(0), 1)
        self.assertEqual(self.errors(601), 0)
        self.assertEqual(self.errors(600), 1)

    def test_accepted_signals_bring_the_cooldown_back(self):
        self.logged('session_error', 'dismissed', 'dismissed', 'dismissed', 'accepted', 'replied', 'accepted')
        self.assertEqual(self.errors(0, 601), 2)

    def test_less_stretches_the_cooldown(self):
        self.logged('session_error').set_less(1.5)
        self.assertEqual(self.errors(0), 1)
        self.assertEqual(self.errors(601), 0)
        self.assertEqual(self.errors(300), 1)

    def test_mostly_dismissed_cooldown_free_signal_rests_for_the_day(self):
        self.now = datetime.datetime(2026, 11, 2, 23, 35).timestamp()
        self.logged('run_quiet', 'dismissed', 'dismissed', 'ignored')
        for sid in ('A', 'B'):
            self.hook('UserPromptSubmit', sid)
            self.hook('PreToolUse', sid, tool_name='Bash', tool_input={'command': 'swift test'})
        self.now += 900
        self.signals.tick(self.now)
        self.assertEqual([p['session_id'] for p in self.posts], ['claude:A'])
        self.now += 300
        self.signals.tick(self.now)
        self.assertEqual(len(self.posts), 1)
        self.now += 305  # the next day
        self.signals.tick(self.now)
        self.assertEqual([p['session_id'] for p in self.posts], ['claude:A', 'claude:B'])

    def test_approval_wait_ignores_feedback(self):
        self.logged('approval_wait', *['dismissed'] * 5).set_less(4)
        for sid in ('A', 'B'):
            self.hook('UserPromptSubmit', sid)
            self.hook('PermissionRequest', sid, tool_name='Bash', tool_input={'command': 'ls'})
        self.now += 90
        self.signals.tick(self.now)
        self.assertEqual([p['reason'] for p in self.posts], ['signal.approval_wait'] * 2)


class WorkSignalsTest(unittest.TestCase):
    def setUp(self):
        from test_repeat_finder import FakeSemantic
        self.now, self.posts, self.presence, self.allowed = T0, [], 'present', True
        self.cards = [dict(id='task-A', title='修渲染', status='active', next_step='检查材质', last_at=T0 - 25 * 3600)]
        self.linked, self.summaries, self.rows, self.jobs = [], [], [], []
        self.worklog = NS(tasks=lambda statuses: [c for c in self.cards if c['status'] in statuses],
                          sessions_for_task=lambda ident: self.linked,
                          sessions_on=lambda day: [s for s in self.summaries if s['day'] == day],
                          generation=0, character=lambda: 'test')
        self.gate = Gate(enabled=True)
        self.client = FakeSemantic()
        self.away = False
        self.signals = Signals(self.gate, NS(post=self.posts.append, log=None), NS(snapshot=lambda now: {'sessions': self.rows}),
                               worklog=self.worklog, semantic=self.client, presence=lambda: self.presence,
                               allowed=lambda row: self.allowed, clock=lambda: self.now, spawn=lambda fn: fn(),
                               absent=lambda: self.away)

    leave, back = SignalsTest.leave, SignalsTest.back

    def tick(self, seconds=0):
        self.now += seconds
        self.signals.tick(self.now)

    def repeat_data(self):
        self.cards = []
        self.summaries = [dict(id=ident, day=day, title='整理日报', body={}, state='completed',
                               agent='claude', session_key=ident)
                          for ident, day in (('a', '2026-10-31'), ('b', '2026-11-01'), ('c', '2026-11-02'))]

    def test_stalled_after_presence_and_72_hour_cooldown(self):
        self.tick()
        self.tick(299)
        self.assertEqual(self.posts, [])
        self.tick(61)
        self.assertEqual([p['reason'] for p in self.posts], ['signal.task_stalled'])
        self.assertEqual(self.posts[0]['reply'], '提醒我明天9点接着做修渲染：检查材质')
        self.tick(71 * 3600)
        self.assertEqual(len(self.posts), 1)
        self.tick(3600)
        self.assertEqual(len(self.posts), 2)
        self.assertFalse(hasattr(self.signals, 'commitments'))

    def test_task_status_progress_running_and_own_sessions(self):
        self.tick()
        for changes, linked, live in (
                ({'status': 'done'}, [], []), ({'status': 'parked'}, [], []),
                ({'status': 'uncertain'}, [], []), ({'last_at': T0}, [], []),
                ({}, [dict(agent='claude', session_key='a')],
                 [dict(source='claude', session_id='a', effective_state='thinking')]),
                ({}, [dict(agent='claude', session_key='own:a')], [])):
            with self.subTest(changes=changes, linked=linked):
                self.cards[0].update(status='active', last_at=T0 - 25 * 3600)
                self.cards[0].update(changes)
                self.linked, self.rows = linked, live
                self.tick(300)
                self.assertEqual(self.posts, [])
        self.linked, self.rows = [], []
        self.tick(60)
        self.assertEqual(len(self.posts), 1)

    def test_one_task_signal_a_day(self):
        self.cards.append(dict(self.cards[0], id='task-B', title='修材质'))
        self.tick()
        self.tick(300)
        self.assertEqual([p['text'] for p in self.posts], ['「修渲染」一天没动了，上次停在：检查材质'])
        self.tick(3600)
        self.assertEqual(len(self.posts), 1)

    def test_a_stalled_task_without_a_next_step_names_none(self):
        for language, text, reply in (
                ('zh-Hans', '「修渲染」一天没动了', '提醒我明天9点接着做修渲染'),
                ('en', '"修渲染" has not moved for a day', 'Remind me tomorrow at 9:00 to continue "修渲染"'),
                ('ja', '「修渲染」が一日止まっている', '明日 9 時に「修渲染」の続きをリマインドして')):
            for step in (None, ''):
                with self.subTest(language=language, step=step):
                    self.setUp()
                    self.client.language = language
                    self.cards[0]['next_step'] = step
                    self.tick()
                    self.tick(300)
                    self.assertEqual([(p['text'], p['reply']) for p in self.posts], [(text, reply)])

    def test_task_and_thought_mutes_and_global_cap(self):
        self.tick()
        for mute in ('task', 'thought'):
            self.gate.set_muted({mute})
            self.tick(300)
            self.assertEqual(self.posts, [])
        self.gate.set_muted(set())
        self.signals._day, self.signals._count = datetime.date.fromtimestamp(self.now), 12
        self.tick(60)
        self.assertEqual(self.posts, [])

    def test_user_nows_presence_resets_presence_and_invalid_reminder_has_no_button(self):
        self.tick()
        self.presence = 'away'
        self.tick(600)
        self.assertEqual(self.posts, [])
        self.presence = 'unknown'  # no beats: not present
        self.tick(300)
        self.assertEqual(self.posts, [])
        self.presence = 'present'
        self.tick(60)
        self.tick(240)
        self.assertEqual(self.posts, [])
        self.cards[0]['title'] = '10分钟后发版'
        self.tick(60)
        self.assertEqual(len(self.posts), 1)
        self.assertIsNone(self.posts[0]['offer'])
        self.assertIsNone(self.posts[0]['reply'])

    def test_a_stalled_task_held_for_typing_is_dropped_once_done(self):
        for status, posted in (('active', 1), ('done', 0)):
            with self.subTest(status=status):
                self.setUp()
                self.tick()
                self.gate.typing = True
                self.tick(300)
                self.assertEqual(self.posts, [])
                self.cards[0]['status'] = status
                self.gate.typing = False
                self.tick(5)
                self.assertEqual(len(self.posts), posted)

    def test_repeat_report_time_daily_attempt_and_fourteen_day_cooldown(self):
        from personal.commitments import parse_reminder
        self.repeat_data()
        self.tick()
        self.tick(5 * 3600 + 29 * 60)
        self.assertEqual(self.client.calls, [])
        self.tick(60)
        self.assertEqual(len(self.client.calls), 1)
        self.assertEqual(self.posts[0]['text'], '这周你有 3 天都在整理日报')
        self.assertEqual(self.posts[0]['offer'], '每天 9 点提醒我')
        self.assertEqual(parse_reminder(self.posts[0]['reply'], self.now)[1:], ('整理日报', 'daily'))
        self.tick(60)
        self.assertEqual(len(self.client.calls), 1)
        for days in (1, 13, 14):
            self.now = T0 + days * 86400 + 6 * 3600
            today = datetime.date.fromtimestamp(self.now)
            for index, summary in enumerate(self.summaries):
                summary['day'] = (today - datetime.timedelta(days=index)).isoformat()
            self.tick()
            self.assertEqual(len(self.posts), 2 if days == 14 else 1)

    def test_a_third_day_done_after_the_report_time_is_analyzed_that_day(self):
        self.repeat_data()
        third = self.summaries.pop()
        self.tick(6 * 3600)
        self.assertEqual(self.client.calls, [])
        self.summaries.append(third)
        self.tick(REPEAT_RECHECK)
        self.assertEqual(len(self.client.calls), 1)
        self.assertEqual([p['reason'] for p in self.posts], ['signal.repeat'])
        self.tick(60)
        self.assertEqual(len(self.client.calls), 1)

    def test_too_little_evidence_is_rechecked_only_every_few_minutes(self):
        self.repeat_data()
        self.summaries.pop()
        days = []
        sessions_on = self.worklog.sessions_on
        self.worklog.sessions_on = lambda day: days.append(day) or sessions_on(day)
        self.tick(6 * 3600)
        for _ in range(10):
            self.tick(5)
        self.assertEqual(len(days), 7)

    def test_only_a_daily_repeat_gets_a_reminder_chip(self):
        for cadence, offer in (('daily', '每天 9 点提醒我'), ('weekdays', None), (None, None)):
            with self.subTest(cadence=cadence):
                self.setUp()
                self.repeat_data()
                self.client.answer['cadence'] = cadence
                self.tick(6 * 3600)
                self.assertEqual([(p['reason'], p['offer'], p['reply'] is None) for p in self.posts],
                                 [('signal.repeat', offer, offer is None)])

    def test_a_repeat_found_across_a_reset_is_dropped(self):
        self.repeat_data()
        self.signals.spawn = self.jobs.append
        self.tick(6 * 3600)
        self.signals.reset()
        self.jobs.pop()()
        self.assertEqual(self.posts, [])

    def test_repeat_line_is_written_in_the_reply_language(self):
        long = 'checking the vendor sheet and the nightly build report of HostLink'
        for language, what, text in (
                ('zh-Hans', '整理日报', '这周你有 3 天都在整理日报'),
                (None, '整理日报', '这周你有 3 天都在整理日报'),
                ('en', long, f'This week, on 3 days, you were {long}'),
                ('ja', '日報の整理', '今週は 3 日、「日報の整理」をしていたね')):
            with self.subTest(language=language):
                self.setUp()
                self.repeat_data()
                self.client.language = language
                self.client.answer['what'] = what
                self.tick()
                self.tick(5 * 3600 + 30 * 60)
                self.assertEqual(self.posts[0]['text'], text)
                self.assertIn(f'over {75 if language == "en" else 30} characters', self.client.calls[0]['instructions'])

    def test_a_repeat_in_another_language_than_the_reply_language_is_generated_once_more(self):
        self.repeat_data()
        self.client.language = 'en'
        answers, run = iter(('整理日报', 'writing the daily report')), self.client.run

        def run_next(*args, **kwargs):
            self.client.answer['what'] = next(answers)
            return run(*args, **kwargs)
        self.client.run = run_next
        self.tick()
        self.tick(5 * 3600 + 30 * 60)
        self.assertEqual(len(self.client.calls), 2)
        self.assertEqual([p['text'] for p in self.posts], ['This week, on 3 days, you were writing the daily report'])

    def test_a_repeat_still_in_another_language_is_not_shown(self):
        self.repeat_data()
        self.client.language = 'en'  # the answer stays 整理日报
        self.tick()
        self.tick(5 * 3600 + 30 * 60)
        self.assertEqual(len(self.client.calls), 2)
        self.assertEqual(self.posts, [])

    def test_failed_repeat_is_not_retried_today(self):
        self.repeat_data()
        self.client.error = ValueError('network')
        self.tick(6 * 3600)
        self.tick(60)
        self.assertEqual(len(self.client.calls), 1)
        self.assertEqual(self.posts, [])

    def test_repeat_excludes_own_and_incomplete_summaries(self):
        self.repeat_data()
        self.summaries[0]['session_key'] = 'own:a'
        self.summaries[1]['state'] = 'pending'
        self.tick(6 * 3600)
        self.assertEqual(self.client.calls, [])
        self.assertEqual(self.posts, [])

    def test_repeat_away_buffer_rechecks_permission_and_generation(self):
        self.repeat_data()
        self.leave()
        self.tick(6 * 3600)
        self.assertEqual(self.posts, [])
        self.allowed = False
        self.back()
        self.tick(5)
        self.assertEqual(self.posts, [])
        self.setUp()
        stalled = self.cards[0]
        self.repeat_data()
        self.cards = [stalled]
        self.leave()
        self.tick(6 * 3600)
        self.back()
        self.tick(60)
        self.assertEqual([p['reason'] for p in self.posts], ['signal.repeat'])

    def test_repeat_late_result_after_delete_or_character_switch_is_dropped(self):
        for change in ('delete', 'switch'):
            with self.subTest(change=change):
                self.setUp()
                self.repeat_data()
                self.signals.spawn = self.jobs.append
                self.tick(6 * 3600)
                self.assertEqual(len(self.jobs), 1)
                if change == 'delete':
                    self.worklog.generation += 1
                else:
                    self.worklog.character = lambda: 'other'
                self.jobs.pop()()
                self.assertEqual(self.posts, [])


class SignalWiringTest(unittest.TestCase):
    def test_hook_filter_runs_before_old_kind_filter_and_signal_suppresses_musing(self):
        enable_plugins(self, "coding_sessions")
        server = NS(attention=None, signals=NS(on_hook=lambda *args: hooks.append(args)),
                    observation_paused=lambda: False, agent_meta=None,
                    consent=NS(lock=threading.Lock(), snapshot=lambda: ({'agent_sessions': True}, 0)),
                    _signals_allowed=lambda row: allowed[0])
        hooks, allowed = [], [True]
        event = normalize_claude({'session_id': 'A', 'hook_event_name': 'PostToolUseFailure'}, now=T0)
        IngestMixin.record_agent_event(server, event, {'error': 'Exit code 1'})
        self.assertEqual(len(hooks), 1)
        allowed[0] = False
        IngestMixin.record_agent_event(server, event, {})
        self.assertEqual(len(hooks), 1)
        noticed = []
        server.registry = Registry(clock=lambda: T0)
        server.focus = NS(count=lambda *args: None)
        server.commitments = server.state = server.behavior = None
        server.thoughts = NS(notice=lambda *args: noticed.append(args))
        server.signals = NS(on_transition=lambda *args: True)
        allowed[0] = True
        IngestMixin.ingest(server, normalize_claude({'session_id': 'A', 'hook_event_name': 'Stop'}, now=T0))
        self.assertEqual(noticed, [])
