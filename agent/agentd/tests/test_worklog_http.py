"""Work-memory routes through Handler, without binding a socket."""
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from api.handler import Handler
from daemon.agentd_server import AgentdServer
from support import enable_plugins
from infra.store import open_store
from personal.worklog import WorkLog

FIXTURES = Path(__file__).resolve().parents[3] / 'protocol/C6-agentd-api/fixtures'
DAY = '2026-11-04'


def fixture(name):
    return json.loads((FIXTURES / f'memory-{name}.json').read_text(encoding='utf-8'))


def stored(session):
    """A C6 session row as the summarizer stores it: next steps carry an owner."""
    return {**session, 'next_steps': [{'text': text, 'owner': ''} for text in session['next_steps']]}


def seed_worklog(server, db):
    work = server.worklog = WorkLog(db, lambda: server.character, clock=lambda: 1793808000)
    card = fixture('tasks')['tasks'][0]
    work.upsert_task({**card, 'status_authority': 'inferred', 'requires': []})
    session = fixture('sessions')['sessions'][0]
    ident = work.add_segment(session['kind'], 'session-1', session['start'], session['end'],
                             input_sha256='fixture', requires=[], sources=['source-1'],
                             agent=session['agent'], project=session['project'])
    work.complete_segment(ident, stored(session))
    work.assign(ident, card['id'])
    day = fixture('days')['days'][0]
    work.put_day('day', DAY, {**day, 'timezone': 'America/New_York', 'body': day, 'inject': day['headline'],
                              'sources': ['source-1'], 'requires': []})
    return ident


class WorklogHTTPTest(unittest.TestCase):
    def setUp(self):
        enable_plugins(self, "daily_brief")
        self.tmp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1])
        self.addCleanup(self.tmp.cleanup)
        self.db = open_store(Path(self.tmp.name) / 'agentd.sqlite')
        self.addCleanup(self.db.close)
        with patch.object(AgentdServer, 'server_bind'), patch.object(AgentdServer, 'server_activate'):
            self.server = AgentdServer(('127.0.0.1', 48810), 'hook-token', 'ui-token', events_token='events-token')
        self.server.server_port = 48810
        self.addCleanup(self.server.server_close)
        self.session_id = seed_worklog(self.server, self.db)
        self.work = self.server.worklog
        self.task_id = fixture('tasks')['tasks'][0]['id']

    def request(self, method, path, body=None, token='ui-token'):
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

    def test_tasks_list_and_status_counts(self):
        status, body = self.request('GET', '/memory/tasks')
        self.assertEqual(status, 200)
        self.assertEqual(body, fixture('tasks'))
        status, body = self.request('GET', '/memory/tasks?status=done,uncertain')
        self.assertEqual(status, 200)
        self.assertEqual(body, {'tasks': [], 'counts': fixture('tasks')['counts']})

    def test_session_and_task_fixtures(self):
        status, body = self.request('GET', f'/memory/sessions?day={DAY}')
        self.assertEqual(status, 200)
        self.assertEqual(body, fixture('sessions'))
        status, body = self.request('GET', f'/memory/tasks/{self.task_id}')
        self.assertEqual(status, 200)
        self.assertEqual(body, fixture('task'))

    def test_summarizer_next_steps_are_listed_as_text(self):
        session = fixture('sessions')['sessions'][0]
        ident = self.work.add_segment(session['kind'], 'session-2', session['start'], session['end'],
                                      input_sha256='summarized', requires=[], sources=['source-1'],
                                      agent=session['agent'], project=session['project'])
        self.work.complete_segment(ident, {**session, 'next_steps': [{'text': '验证主窗口展示', 'owner': 'agent'}]})
        status, body = self.request('GET', f'/memory/sessions?day={DAY}')
        self.assertEqual(status, 200)
        row = next(r for r in body['sessions'] if r['id'] == ident)
        self.assertEqual(row['next_steps'], ['验证主窗口展示'])

    def test_day_fixtures_and_week(self):
        status, body = self.request('GET', f'/memory/days?from={DAY}&to={DAY}')
        self.assertEqual(status, 200)
        self.assertEqual(body, fixture('days'))
        self.assertEqual(self.request('GET', f'/memory/days/{DAY}'), (200, fixture('days')['days'][0]))
        day = self.work.day(DAY)
        self.work.put_day('week', '2026-11-02', day)
        status, body = self.request('GET', '/memory/days/2026-11-02?period=week')
        self.assertEqual(status, 200)
        self.assertEqual((body['period'], body['date']), ('week', '2026-11-02'))

    def test_ui_token_required_for_every_route(self):
        for method, path in [('GET', '/memory/tasks'), ('GET', f'/memory/sessions?day={DAY}'),
                             ('GET', f'/memory/tasks/{self.task_id}'), ('PATCH', f'/memory/tasks/{self.task_id}'),
                             ('GET', f'/memory/days?from={DAY}&to={DAY}'), ('GET', f'/memory/days/{DAY}')]:
            for token in (None, 'hook-token', 'events-token'):
                with self.subTest(method=method, path=path, token=token):
                    self.assertEqual(self.request(method, path, token=token)[0], 401)

    def test_consent_filters_all_rows_and_counts(self):
        for table in ('session_summaries', 'task_cards', 'day_summaries'):
            self.db.execute(f'UPDATE {table} SET requires=?', ('["page_text"]',))
        self.db.commit()
        status, body = self.request('GET', '/memory/tasks')
        self.assertEqual(status, 200)
        self.assertEqual(body, {'tasks': [], 'counts': dict.fromkeys(('active', 'done', 'parked', 'uncertain'), 0)})
        self.assertEqual(self.request('GET', f'/memory/sessions?day={DAY}'), (200, {'day': DAY, 'sessions': []}))
        self.assertEqual(self.request('GET', f'/memory/days?from={DAY}&to={DAY}'), (200, {'days': []}))
        for method in ('GET', 'PATCH'):
            self.assertEqual(self.request(method, f'/memory/tasks/{self.task_id}', {'expected_revision': 1})[0], 404)
        self.assertEqual(self.request('GET', f'/memory/days/{DAY}')[0], 404)
        self.server.share_page_text = True
        self.assertEqual(len(self.request('GET', '/memory/tasks')[1]['tasks']), 1)
        self.assertEqual(len(self.request('GET', f'/memory/sessions?day={DAY}')[1]['sessions']), 1)
        self.assertEqual(len(self.request('GET', f'/memory/days?from={DAY}&to={DAY}')[1]['days']), 1)

    def test_pause_hides_even_rows_without_requires(self):
        self.server.set_paused_until(self.server.clock() + 60)
        self.assertEqual(self.request('GET', f'/memory/sessions?day={DAY}'), (200, {'day': DAY, 'sessions': []}))
        self.assertEqual(self.request('GET', '/memory/tasks')[1]['tasks'], [])
        self.assertEqual(self.request('GET', f'/memory/days?from={DAY}&to={DAY}'), (200, {'days': []}))
        self.assertEqual(self.request('GET', f'/memory/tasks/{self.task_id}')[0], 404)
        self.assertEqual(self.request('GET', f'/memory/days/{DAY}')[0], 404)
        self.assertEqual(self.request('PATCH', f'/memory/tasks/{self.task_id}', {'expected_revision': 1, 'title': '改名'})[0], 404)

    def test_patch_revision_and_user_authority(self):
        path = f'/memory/tasks/{self.task_id}'
        status, card = self.request('PATCH', path, {'expected_revision': 1, 'goal': '保留会话', 'status': 'done', 'title': '已恢复'})
        self.assertEqual(status, 200)
        self.assertEqual((card['goal_authority'], card['edited'], card['revision']), ('user_corrected', True, 2))
        self.assertEqual((card['title'], card['goal'], card['status']), ('已恢复', '保留会话', 'done'))
        self.assertEqual(self.work.tasks()[0]['status_authority'], 'user_corrected')
        self.assertEqual(self.request('PATCH', path, {'expected_revision': 1, 'title': '覆盖'}),
                         (409, {'error': 'revision_conflict', 'task': card}))
        self.assertEqual(self.request('PATCH', '/memory/tasks/missing', {'expected_revision': 1, 'title': '未知'})[0], 404)

    def test_stale_revision_returns_current_card(self):
        self.assertEqual(self.request('PATCH', f'/memory/tasks/{self.task_id}',
                                      {'expected_revision': 0, 'title': '覆盖'}),
                         (409, {'error': 'revision_conflict', 'task': fixture('tasks')['tasks'][0]}))

    def test_invalid_query_and_patch(self):
        for path in ('/memory/sessions?day=2026-02-30', '/memory/sessions?day=',
                     '/memory/tasks?status=invalid', '/memory/tasks?status=',
                     '/memory/days?from=2026-01-01&to=2026-02-01', '/memory/days?from=2026-11-05&to=2026-11-04',
                     '/memory/days?from=bad&to=bad', f'/memory/days/{DAY}?period=month'):
            with self.subTest(path=path):
                self.assertEqual(self.request('GET', path)[0], 400)
        for body in ([], {}, {'expected_revision': True, 'title': 'a'}, {'expected_revision': 1, 'status': 'bad'},
                     {'expected_revision': 1, 'title': ''}, {'expected_revision': 1, 'goal': None},
                     {'expected_revision': 1, 'other': 'a'}, {'expected_revision': 1}):
            with self.subTest(body=body):
                self.assertEqual(self.request('PATCH', f'/memory/tasks/{self.task_id}', body)[0], 400)
        self.assertEqual(self.request('GET', '/memory/days?from=2026-10-05&to=2026-11-04')[0], 200)

    def test_task_sessions_across_days_and_characters(self):
        status, body = self.request('GET', f'/memory/tasks/{self.task_id}')
        self.assertEqual(status, 200)
        session = fixture('sessions')['sessions'][0]
        other = self.work.add_segment('foreground', 'other', session['start'] - 86400, session['end'] - 86400,
                                      input_sha256='other', requires=['typed_text'], sources=[])
        self.work.complete_segment(other, stored(session))
        self.work.assign(other, self.task_id)
        self.db.execute("UPDATE task_cards SET requires='[]'")
        self.db.commit()
        self.assertEqual(len(self.request('GET', f'/memory/tasks/{self.task_id}')[1]['sessions']), 1)
        self.server.share_typed_text = True
        self.assertEqual(len(self.request('GET', f'/memory/tasks/{self.task_id}')[1]['sessions']), 2)
        self.server.character = 'another-character'
        self.assertEqual(self.request('GET', '/memory/tasks')[1]['tasks'], [])
        self.assertEqual(self.request('GET', f'/memory/sessions?day={DAY}')[1]['sessions'], [])
        self.assertEqual(self.request('GET', f'/memory/tasks/{self.task_id}')[0], 404)
        self.assertEqual(self.request('GET', f'/memory/days/{DAY}')[0], 404)

    def test_incomplete_summaries_are_hidden(self):
        self.db.execute("UPDATE session_summaries SET state='pending'")
        self.db.execute("UPDATE day_summaries SET state='failed'")
        self.db.commit()
        self.assertEqual(self.request('GET', f'/memory/sessions?day={DAY}'), (200, {'day': DAY, 'sessions': []}))
        self.assertEqual(self.request('GET', f'/memory/tasks/{self.task_id}')[1]['sessions'], [])
        self.assertEqual(self.request('GET', f'/memory/days?from={DAY}&to={DAY}'), (200, {'days': []}))
        self.assertEqual(self.request('GET', f'/memory/days/{DAY}')[0], 404)
