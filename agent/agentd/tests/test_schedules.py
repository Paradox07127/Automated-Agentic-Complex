"""Local schedules: calendar recurrence, durable claims, user-only activation and background reports."""
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from api.handler import Handler
from brain.language import ReplyLanguage
from character_agent.services.orchestration import OrchestrationTurn
from daemon.agentd_server import AgentdServer
from infra.store import open_store
from personal.memory import Memory
from personal.history import History
from support import enable_plugins

DAILY = {'kind': 'daily', 'at': '18:30', 'weekdays': [1, 2, 3, 4, 5]}


def local(year, month, day, hour=0, minute=0):
    return time.mktime((year, month, day, hour, minute, 0, 0, 0, -1))


class ScheduleTests(unittest.TestCase):
    def setUp(self):
        enable_plugins(self, 'personal_agent')
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = open_store(Path(self.tmp.name) / 'agentd.sqlite')
        self.addCleanup(self.db.close)
        self.now = local(2026, 11, 4, 12)
        self.memory = Memory(self.db)
        with patch.object(AgentdServer, 'server_bind'), patch.object(AgentdServer, 'server_activate'):
            self.server = AgentdServer(('127.0.0.1', 48810), 'hook', 'ui', events_token='events')
        self.addCleanup(self.server.server_close)
        self.server._stopped.set()
        self.server._ticker.join(2)
        self.server.server_port = 48810
        self.server.clock = lambda: self.now
        self.server.memory = self.memory
        self.server.claim_line = Mock(return_value=True)
        self.server.gate.enabled = True
        self.controller =self.server.character_agent = SimpleNamespace(
            jobs=SimpleNamespace(store=SimpleNamespace(get=Mock(return_value=None), results_since=Mock(return_value=[]))),
            submit_job=Mock(return_value={'job_id': 'job-1'}), close=lambda: None,
            settings=SimpleNamespace(snapshot=lambda: {'reply_language': 'zh-Hans'}), reply_language=ReplyLanguage())

    def store(self):
        from personal.schedules import Schedules
        return Schedules(self.db, lock=self.memory.lock, clock=lambda: self.now)

    def request(self, method, path, body=None, token='ui'):
        payload = b'' if body is None else json.dumps(body).encode()
        auth = '' if token is None else f'Authorization: Bearer {token}\r\n'
        raw = (f'{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:48810\r\n{auth}'
               f'Content-Type: application/json\r\nContent-Length: {len(payload)}\r\n\r\n').encode() + payload
        handler = Handler.__new__(Handler)
        handler.server = self.server
        handler.rfile, handler.wfile = io.BytesIO(raw), io.BytesIO()
        handler.handle_one_request()
        headers, response = handler.wfile.getvalue().split(b'\r\n\r\n', 1)
        return int(headers.split()[1]), json.loads(response)

    @unittest.skipIf(sys.platform == "win32", "the test needs POSIX signals, pty or time.tzset")
    def test_daily_weekly_local_time_and_dst(self):
        from personal.schedules import next_run
        old = os.environ.get('TZ')
        try:
            os.environ['TZ'] = 'America/New_York'; time.tzset()
            daily = {**DAILY, 'weekdays': list(range(1, 8))}
            for date, expected in (((2026, 3, 7, 18, 30), (2026, 3, 8, 18, 30)),
                                   ((2026, 10, 31, 18, 30), (2026, 11, 1, 18, 30))):
                with self.subTest(date=date):
                    start, end = local(*date), local(*expected)
                    self.assertEqual(next_run(daily, start), end)
                    self.assertIn(end - start, (23 * 3600, 25 * 3600))
            self.assertEqual(next_run(DAILY, local(2026, 11, 6, 18, 30)), local(2026, 11, 9, 18, 30))
            weekly = {'kind': 'weekly', 'weekday': 5, 'at': '17:00'}
            self.assertEqual(next_run(weekly, local(2026, 10, 30, 17)), local(2026, 11, 6, 17))
            self.assertIsNone(next_run({'kind': 'session_done', 'target': None, 'project': None}, self.now))
        finally:
            if old is None: os.environ.pop('TZ', None)
            else: os.environ['TZ'] = old
            time.tzset()

    def test_tick_claims_due_once_and_records_job(self):
        item = self.store().add('日报', '总结仓库变化', DAILY, enabled=True)
        self.now = item['next_run_at']
        self.server._schedules_due(); self.server._schedules_due()
        self.controller.submit_job.assert_called_once()
        args, kwargs = self.controller.submit_job.call_args
        self.assertEqual(args[:3], ('日报', '总结仓库变化', '总结仓库变化'))
        self.assertIsNone(kwargs.get('scope_id'))
        self.assertEqual(self.store().get(item['schedule_id'])['last_job_id'], 'job-1')
        self.assertEqual(self.db.execute('SELECT state,job_id FROM schedule_runs').fetchall(), [('started', 'job-1')])

    def test_a_tick_with_nothing_due_opens_no_transaction(self):
        from personal.commitments import Commitments
        self.controller.jobs.store.revision = 0
        self.controller.public = lambda *args, **kwargs: {'ready': False, 'routes': {'chat': {'ready': False}}}
        commitments = self.server.commitments = Commitments(self.db, clock=lambda: self.now)
        reminder = commitments.add('喝水', self.now + 600)
        item = self.server.schedules_store().add('日报', '总结仓库变化', DAILY, enabled=True)
        statements = []
        self.db.set_trace_callback(statements.append)

        def ticks(count):
            with patch.object(self.server._stopped, 'wait', side_effect=[False] * count + [True]):
                self.server._tick_loop(0)
        ticks(5)
        self.assertEqual([s for s in statements if s.startswith(('BEGIN', 'COMMIT'))], [])
        self.assertLessEqual(len([s for s in statements if 'FROM commitments' in s]), 1)
        self.assertLessEqual(len([s for s in statements if 'FROM schedules' in s]), 1)
        self.assertLessEqual(len([s for s in statements if 'FROM schedule_runs' in s]), 1)
        self.now = reminder['due_at']
        ticks(1)
        self.assertEqual(commitments.list()[0]['state'], 'triggered')
        self.now = item['next_run_at']
        ticks(1)
        self.controller.submit_job.assert_called_once()
        self.db.set_trace_callback(None)

    def test_restart_catchup_boundary_and_missed(self):
        store = self.store()
        item = store.add('日报', '总结', DAILY, enabled=True)
        self.now = item['next_run_at'] + 6 * 3600
        self.assertEqual(len(self.store().due()), 1)
        self.assertEqual(self.store().due(), [])
        self.now = self.store().get(item['schedule_id'])['next_run_at'] + 6 * 3600 + 1
        self.assertEqual(self.store().due(), [])
        self.assertEqual([r[0] for r in self.db.execute('SELECT state FROM schedule_runs ORDER BY rowid')], ['started', 'missed'])
        self.assertGreater(self.store().get(item['schedule_id'])['next_run_at'], self.now)

    def test_disabled_and_failed_submissions_do_not_retry_every_tick(self):
        store = self.store()
        store.add('未启用', '总结', DAILY)
        item = store.add('启用', '总结', DAILY, enabled=True)
        self.controller.submit_job.side_effect = ValueError('unavailable')
        self.now = item['next_run_at']
        self.server._schedules_due(); self.server._schedules_due()
        self.controller.submit_job.assert_called_once()
        self.assertEqual(self.db.execute('SELECT state FROM schedule_runs').fetchall(), [('failed',)])

    def test_proposal_is_disabled_and_cannot_enable_through_tool(self):
        self.controller.server = self.server
        self.controller.knowledge = lambda: SimpleNamespace(sanitize=lambda value, **kw: value)
        turn = OrchestrationTurn(self.controller, '每晚总结', {}, self.server.character, None, 'run-1')
        turn.open(lambda: True)
        result = turn.call('schedule_propose', {'title': '日报', 'instruction': '总结', 'trigger': DAILY})
        self.assertNotIn('error', result)
        self.assertIn('after the user enables it on the schedules page', result['message'])
        [item] = self.store().list()
        self.assertFalse(item['enabled']); self.assertEqual(item['created_from'], 'agent_proposal')
        self.assertIsNone(item['next_run_at'])
        result = turn.call('schedule_propose', {'title': '日报', 'instruction': '总结', 'trigger': DAILY, 'enabled': True})
        self.assertIn('error', result)
        self.assertEqual(turn.call('schedules_list', {})['schedules'], [item])

    def test_enabling_a_proposal_marks_it_accepted_and_pausing_keeps_the_mark(self):
        store = self.store()
        item = store.add('日报', '总结', DAILY, created_from='agent_proposal')
        self.assertIsNone(item['accepted_at'])
        ident = item['schedule_id']
        accepted = self.now
        code, body = self.request('PUT', f'/schedules/{ident}', {'enabled': True})
        self.assertEqual(code, 200); self.assertEqual(body['schedule']['accepted_at'], accepted)
        self.now += 60
        code, body = self.request('PUT', f'/schedules/{ident}', {'enabled': False})
        self.assertEqual(code, 200); self.assertFalse(body['schedule']['enabled'])
        self.assertEqual(body['schedule']['accepted_at'], accepted)
        self.assertEqual(body['schedule']['created_from'], 'agent_proposal')
        self.assertEqual(self.request('PUT', f'/schedules/{ident}', {'enabled': True})[1]['schedule']['accepted_at'], accepted)
        self.assertEqual(store.add('日报', '总结', DAILY, enabled=True)['accepted_at'], self.now)

    def test_an_existing_database_gains_the_acceptance_column(self):
        import sqlite3
        path = Path(self.tmp.name) / 'old.sqlite'
        old = sqlite3.connect(str(path))
        old.execute('CREATE TABLE schedules (schedule_id TEXT PRIMARY KEY, title TEXT NOT NULL, instruction TEXT NOT NULL,'
                    ' trigger_kind TEXT NOT NULL, trigger_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,'
                    ' created_from TEXT NOT NULL, conversation_id TEXT, next_run_at REAL, last_run_at REAL, last_job_id TEXT,'
                    ' created_at REAL NOT NULL, updated_at REAL NOT NULL, scope_id TEXT)')
        old.close()
        db = open_store(path)
        self.addCleanup(db.close)
        self.assertIn('accepted_at', [r[1] for r in db.execute('PRAGMA table_info(schedules)')])

    def test_all_routes_reject_non_ui_tokens(self):
        for method, path in [('GET', '/schedules'), ('POST', '/schedules'), ('PUT', '/schedules/a'),
                             ('DELETE', '/schedules/a'), ('POST', '/schedules/a/run')]:
            for token in (None, 'hook', 'events', 'bad'):
                with self.subTest(method=method, token=token):
                    self.assertEqual(self.request(method, path, {}, token)[0], 401)

    def test_user_crud_and_manual_run_disabled_schedule(self):
        code, body = self.request('POST', '/schedules', {'title': '日报', 'instruction': '总结', 'trigger': DAILY})
        self.assertEqual(code, 201)
        item = body['schedule']; ident = item['schedule_id']
        self.assertFalse(item['enabled'])
        self.assertEqual(self.request('GET', '/schedules'), (200, {'schedules': [item]}))
        self.assertEqual(self.request('POST', f'/schedules/{ident}/run')[0], 202)
        code, body = self.request('PUT', f'/schedules/{ident}', {'enabled': True, 'instruction': '核对提交'})
        self.assertEqual(code, 200); self.assertTrue(body['schedule']['enabled'])
        self.assertEqual(body['schedule']['instruction'], '核对提交')
        self.assertIsNotNone(body['schedule']['next_run_at'])
        self.assertEqual(self.request('DELETE', f'/schedules/{ident}')[0], 200)
        self.assertEqual(self.request('GET', '/schedules'), (200, {'schedules': []}))
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM schedule_runs').fetchone()[0], 0)
        self.assertEqual(self.request('PUT', f'/schedules/{ident}', {'enabled': True})[0], 404)

    def test_manual_run_preserves_the_planned_occurrence(self):
        item = self.store().add('日报', '总结', DAILY, enabled=True)
        self.now = item['next_run_at'] + 60
        self.assertEqual(self.request('POST', f"/schedules/{item['schedule_id']}/run", {})[0], 202)
        self.assertEqual(self.store().get(item['schedule_id'])['next_run_at'], item['next_run_at'])

    def test_run_uses_saved_scope_and_origin_after_defaults_change(self):
        self.server.history = History(self.db, lock=self.memory.lock)
        a = self.server.history.conversations.active
        defaults = {'scope_id': 'scope-a'}
        self.controller.settings = SimpleNamespace(snapshot=lambda: defaults)
        self.controller.workspace = SimpleNamespace(validate_scope=Mock())
        code, body = self.request('POST', '/schedules', {
            'title': '日报', 'instruction': '只读约定的资料', 'trigger': DAILY, 'enabled': True,
        })
        self.assertEqual(code, 201)
        item = body['schedule']
        self.assertEqual((item['scope_id'], item['conversation_id']), ('scope-a', a))
        self.server.history.conversations.create('另一会话')
        defaults['scope_id'] = 'scope-b'
        self.now = item['next_run_at']
        self.server._schedules_due()
        _, kwargs = self.controller.submit_job.call_args
        self.assertEqual((kwargs['scope_id'], kwargs['conversation_id']), ('scope-a', a))
        self.controller.workspace.validate_scope.assert_called_with('scope-a')

    def test_revoked_scope_never_uses_default_and_error_is_visible(self):
        self.controller.workspace = SimpleNamespace(validate_scope=Mock(side_effect=ValueError('scope_revoked')))
        item = self.store().add('日报', '核对资料', DAILY, enabled=True, scope_id='old')
        self.controller.settings = SimpleNamespace(snapshot=lambda: {'scope_id': 'another'})
        self.now = item['next_run_at']
        self.server._schedules_due()
        self.controller.submit_job.assert_not_called()
        code, body = self.request('GET', '/schedules')
        self.assertEqual(code, 200)
        self.assertEqual(body['schedules'][0]['last_error'], 'scope_revoked')
        self.assertFalse(body['schedules'][0]['enabled'])
        self.assertEqual(self.request('POST', f"/schedules/{item['schedule_id']}/run"),
                         (409, {'error': 'scope_revoked'}))
        self.assertEqual(self.request('PUT', f"/schedules/{item['schedule_id']}", {'scope_id': None})[0], 200)
        self.assertEqual(self.request('POST', f"/schedules/{item['schedule_id']}/run")[0], 202)
        self.assertIsNone(self.store().get(item['schedule_id'])['last_error'])

    def test_schedule_report_does_not_enter_a_different_active_conversation(self):
        self.server.history = History(self.db, lock=self.memory.lock)
        conversations = self.server.history.conversations
        origin = conversations.get(conversations.active)
        conversations.create('unrelated')
        item = self.store().add('日报', '总结', DAILY, enabled=True, conversation_id=origin['id'])
        self.now = item['next_run_at']
        self.server._schedules_due()
        self.controller.deliveries = self.deliveries()
        self.controller.jobs.store.get.return_value = {
            'job_id': 'job-1', 'run_id': 'bg-1', 'state': 'needs_review',
            'conversation_id': origin['id'], 'result': {'task_id': 'task-1', 'reply': '报告'},
            'payload': {'character_id': self.server.character},
        }
        self.server._text_only = Mock(return_value=False)
        self.server._schedules_due()
        self.server.claim_line.assert_not_called()
        conversations.update(origin['id'], {'expected_version': origin['revision']}, activate=True)
        self.server._schedules_due()
        self.assertEqual(self.server.claim_line.call_args.kwargs['conversation_id'], origin['id'])
        self.assertEqual(self.server.claim_line.call_args.kwargs['resume_run_id'], 'bg-1')

    def test_invalid_trigger_and_payload_leave_no_rows(self):
        for trigger in ({**DAILY, 'at': '24:00'}, {**DAILY, 'weekdays': []}, {**DAILY, 'weekdays': [True]},
                        {'kind': 'weekly', 'at': '17:00', 'weekday': 0},
                        {'kind': 'session_done', 'target': 'other'}, {'kind': 'other'}, {'kind': []}):
            with self.subTest(trigger=trigger):
                self.assertEqual(self.request('POST', '/schedules', {'title': 'x', 'instruction': 'y', 'trigger': trigger})[0], 400)
        for extra in ({'created_from': 'agent_proposal'}, {'enabled': 1}, {'conversation_id': 42}):
            self.assertEqual(self.request('POST', '/schedules', {'title': 'x', 'instruction': 'y', 'trigger': DAILY, **extra})[0], 400)
        self.assertEqual(self.store().list(), [])

    def test_session_done_matches_target_project_and_deduplicates(self):
        store = self.store()
        item = store.add('会话结束', '核对结果', {'kind': 'session_done', 'target': 'codex', 'project': '/repo'}, enabled=True)
        store.add('其他', '忽略', {'kind': 'session_done', 'target': 'claude', 'project': None}, enabled=True)
        store.add('禁用', '忽略', {'kind': 'session_done', 'target': None, 'project': None})
        self.server.sessions = SimpleNamespace(sessions={'s': SimpleNamespace(target='codex', origin=None)}, own_id=lambda s: s)
        event = {'kind': 'dispatch_review', 'level': 'P2', 'headline': '完成', 'session_id': 's', 'project': '/other', 'ts': self.now, 'silent': True}
        self.server.announce(event)
        self.controller.submit_job.assert_not_called()
        event['project'] = '/repo'
        self.server.announce(event); self.server.announce(event)
        self.controller.submit_job.assert_called_once()
        self.assertEqual(store.get(item['schedule_id'])['last_job_id'], 'job-1')

    def test_result_uses_dispatch_report_after_delivery_and_retries_busy_claim(self):
        store = self.store()
        self.server._text_only = Mock(return_value=False)
        item = store.add('日报', '总结', DAILY, enabled=True)
        self.now = item['next_run_at']; self.server._schedules_due()
        self.controller.jobs.store.get.return_value = {'job_id': 'job-1', 'run_id': 'bg-1', 'state': 'needs_review',
            'result': {'task_id': 'task-1', 'reply': '总结结果'}, 'payload': {'character_id': self.server.character}}
        self.controller.deliveries = self.deliveries()
        delivery = self.controller.deliveries.produce.return_value
        self.controller.deliveries.produce.return_value = None
        self.server._schedules_due(); self.server.claim_line.assert_not_called()
        self.controller.deliveries.produce.return_value = delivery
        self.server.claim_line.side_effect = [False, True]
        self.server._schedules_due(); self.server._schedules_due(); self.server._schedules_due()
        self.assertEqual(self.server.claim_line.call_count, 2)
        args, kwargs = self.server.claim_line.call_args
        self.assertEqual(kwargs['reason']['code'], 'dispatch_report')
        self.assertIn('总结结果', kwargs['material'])
        self.assertTrue(args[2]())
        self.server.resetting = True
        self.assertFalse(args[2]())

    def scheduled_result(self):
        """A due schedule run whose job ended with a produced delivery (its card)."""
        self.server._text_only = Mock(return_value=False)
        item = self.store().add('日报', '总结', DAILY, enabled=True)
        self.now = item['next_run_at']; self.server._schedules_due()
        self.controller.jobs.store.get.return_value = {'job_id': 'job-1', 'run_id': 'bg-1', 'state': 'succeeded',
            'result': {'task_id': 'task-1', 'reply': '总结结果'}, 'payload': {'character_id': self.server.character}}
        self.controller.deliveries = self.deliveries()

    def deliveries(self, **delivery):
        """A deliveries service whose produce answers one unredacted delivery of the job's reply."""
        told = set()  # the told events, kept across a restart like the database's
        return SimpleNamespace(produce=Mock(return_value={'delivery_id': 'delivery-1', 'redacted': False,
                                                          'summary': '总结结果', **delivery}),
                               was_told=Mock(side_effect=told.__contains__), told=Mock(side_effect=told.add))

    def test_a_claimed_report_is_told_only_once_its_line_says_it(self):
        self.scheduled_result()
        self.server._schedules_due()
        self.server.claim_line.assert_called_once()
        self.controller.deliveries.told.assert_not_called()  # the line may still be cancelled before it says anything
        self.server.claim_line.call_args.kwargs['on_voiced']()
        self.controller.deliveries.told.assert_called_once_with('delivery-1')

    def test_a_report_whose_line_ends_unvoiced_is_told_on_the_next_tick(self):
        self.scheduled_result()
        self.controller.jobs.store.revision = 0
        marker = self.server._schedules_waiting(); self.server._schedules_due(marker)
        self.server.claim_line.assert_called_once()
        self.assertIsNone(self.server._schedules_waiting())
        args, kwargs = self.server.claim_line.call_args
        self.server._unvoiced({}, args[0], kwargs['on_voiced'])  # the line ended before its first clause
        marker = self.server._schedules_waiting()
        self.assertIsNotNone(marker)
        self.server._schedules_due(marker)
        self.assertEqual(self.server.claim_line.call_count, 2)

    def test_a_told_report_is_not_told_again_after_a_restart(self):
        self.scheduled_result()
        self.server.claim_line.side_effect = lambda *args, on_voiced, **kwargs: on_voiced() or True
        self.server._schedules_due()
        self.server.claim_line.assert_called_once()
        self.controller.deliveries.told.assert_called_once_with('delivery-1')
        self.server._reported_tasks.clear(); self.server._schedules = None; self.server._reports_marker = None
        self.server._schedules_due()
        self.server.claim_line.assert_called_once()

    def test_a_redacted_or_told_delivery_is_not_said(self):
        for delivery in ({'redacted': True, 'summary': ''}, {}):
            with self.subTest(delivery=delivery):
                self.scheduled_result()
                self.controller.deliveries = self.deliveries(**delivery)
                if not delivery:
                    self.controller.deliveries.told('delivery-1')
                self.assertFalse(self.server._schedule_reports(self.store()))
                self.server.claim_line.assert_not_called()

    def test_an_unbound_schedule_reports_in_the_active_conversation(self):
        self.server.history = History(self.db, lock=self.memory.lock)
        self.scheduled_result()
        self.controller.jobs.store.get.return_value['conversation_id'] = None
        self.server._schedules_due()
        self.server.claim_line.assert_called_once()
        self.assertIsNone(self.server.claim_line.call_args.kwargs['conversation_id'])

    def test_an_interrupted_or_cancelled_job_leaves_nothing_untold(self):
        for state in ('interrupted', 'cancelled'):
            with self.subTest(state=state):
                self.scheduled_result()
                self.controller.jobs.store.get.return_value['state'] = state
                self.controller.deliveries.produce.return_value = None
                self.assertFalse(self.server._schedule_reports(self.store()))
        self.server.claim_line.assert_not_called()

    def test_editing_only_the_title_keeps_a_due_unclaimed_occurrence(self):
        store = self.store()
        item = store.add('日报', '总结', DAILY, enabled=True)
        self.now = item['next_run_at'] + 5
        store.update(item['schedule_id'], {'title': '晚报', 'trigger': DAILY, 'enabled': True})
        self.assertEqual(store.get(item['schedule_id'])['next_run_at'], item['next_run_at'])
        self.assertEqual(len(store.due(self.now + 1)), 1)
        changed = store.add('周报', '总结', DAILY, enabled=True)
        store.update(changed['schedule_id'], {'trigger': {**DAILY, 'at': '19:00'}})
        self.assertGreater(store.get(changed['schedule_id'])['next_run_at'], self.now)

    def assert_shown_not_said(self, name, value):
        self.scheduled_result()
        setattr(self.server.gate, name, value)
        self.server._schedules_due()
        self.controller.deliveries.produce.assert_called_with('bg-1')
        self.server.claim_line.assert_not_called()

    def test_result_is_shown_not_said_with_proactive_speech_off(self):
        self.assert_shown_not_said('enabled', False)

    def test_result_is_shown_not_said_in_quiet_hours(self):
        self.scheduled_result()
        self.server.gate.set_quiet(True, [[0, 12], [12, 0]])
        self.server._schedules_due()
        self.controller.deliveries.produce.assert_called_with('bg-1')
        self.server.claim_line.assert_not_called()

    def test_result_is_shown_not_said_in_a_meeting(self):
        self.assert_shown_not_said('meeting', True)

    def test_result_is_said_past_the_proactive_budget(self):
        self.scheduled_result()
        for _ in range(self.server.gate.daily_limit):
            self.server.gate.commit('comment')
        self.assertEqual(self.server.gate.check('comment'), 'daily_limit')
        self.server._schedules_due()
        self.server.claim_line.assert_called_once()
        self.assertTrue(self.server.claim_line.call_args.args[2]())

    def test_startup_waits_for_the_background_controller_before_claiming(self):
        item = self.store().add('日报', '总结', DAILY, enabled=True)
        self.now = item['next_run_at']
        self.server.character_agent = None
        self.server._schedules_due()
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM schedule_runs').fetchone()[0], 0)
        self.server.character_agent = self.controller
        self.server._schedules_due()
        self.controller.submit_job.assert_called_once()

    def test_runner_waits_during_reset_and_shutdown(self):
        item = self.store().add('日报', '总结', DAILY, enabled=True)
        self.now = item['next_run_at']
        for flag in ('resetting', 'closing'):
            setattr(self.server, flag, True); self.server._schedules_due(); setattr(self.server, flag, False)
        self.controller.submit_job.assert_not_called()
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM schedule_runs').fetchone()[0], 0)
