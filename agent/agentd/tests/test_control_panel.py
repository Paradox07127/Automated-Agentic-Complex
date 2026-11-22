"""Product HTTP + persistence regressions for the native agent control panel."""
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from personal.history import History
from sessions.own import OwnSession, SessionManager
from infra.store import open_store
from character_agent.services.store import RunStore
import test_server


class QuestionReplyTest(unittest.TestCase):
    def test_ordinary_chat_does_not_answer_pending_questions(self):
        from control_panel import route
        conversation = 'a' * 32
        card = {'request_id':'card', 'revision':1, 'kind':'question', 'state':'pending',
            'conversation_id':conversation, 'data':{'character_id':'aster', 'questions':[{'id':'a'}, {'id':'b'}]}}
        interactions = SimpleNamespace(get=Mock(return_value=card), respond=Mock(return_value={'state':'resumed'}))
        server = SimpleNamespace(ui_token='ui', resetting=False, closing=False, character='aster', _switch_lock=threading.RLock(),
            history=SimpleNamespace(conversations=SimpleNamespace(active=conversation, get=lambda ident:{'archived':False, 'character_id':'aster', 'active':True})),
            character_agent=SimpleNamespace(busy=lambda:False, interactions=interactions), say=Mock(return_value=(202, {'line_id':'ordinary'})))
        result = []
        handler = SimpleNamespace(server=server, auth=lambda token:True, body=lambda:{'text':'hello'},
            json=lambda code, body:result.append((code,body)))
        path = '/conversations/' + conversation + '/messages'
        route(handler, 'POST', path)
        server.say.assert_called_once_with('hello')
        interactions.respond.assert_not_called()
        handler.body = lambda:{'reply_to':{'request_id':'card', 'revision':1}, 'answers':{'a':['one'], 'b':['two']}}
        route(handler, 'POST', path)
        interactions.respond.assert_called_once_with('card', 1, {'a':['one'], 'b':['two']})
        card['conversation_id'] = 'b' * 32
        route(handler, 'POST', path)
        self.assertEqual(result[-1][0], 400)


class ControlPanelTest(test_server.FeedServerCase):
    request = test_server.ServerTest.request

    def setUp(self):
        super().setUp()
        self.server.character_agent = None  # these routes' paths without a character agent
        self.port = self.server.server_port
        self.addCleanup(self.tmp.cleanup)
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'test.sqlite'
        self.server.history = self.history = History(open_store(self.path), character_id=self.server.character)
        self.addCleanup(self.history.db.close)
        self.manager = SessionManager(self.server.broker, self.server.announce, Path(self.tmp.name), '', 'hook', 10, store=open_store(self.path))
        self.server.sessions = self.manager
        self.addCleanup(self.manager.store.close)
        self.addCleanup(self.manager.close)

    def record(self, text='original', reply='answer'):
        return self.history.record(turn_id='turn-' + text, source='text', character_id=self.server.character, persona_revision='1',
                                   user_text=text, reply=reply, state='completed', started_at=1)

    def conversations(self):
        code, body = self.request('GET', '/conversations')
        self.assertEqual(code, 200)
        return body['conversations']

    def test_migrate_old_rows_restart_and_independent_windows(self):
        self.record()
        first = self.conversations()[0]
        self.assertEqual(len(self.history.window(self.server.character, 10, {})), 1)
        code, second = self.request('POST', '/conversations', {})
        self.assertEqual(code, 201)
        self.assertEqual(self.history.window(self.server.character, 10, {}), [])
        self.record('second')
        rows = self.request('GET', '/conversations/' + second['id'] + '/turns')[1]['turns']
        self.assertEqual([r['user_text'] for r in rows], ['second'])
        self.assertEqual(self.request('POST', '/conversations/' + first['id'] + '/activate', {'expected_version': first['revision']})[0], 200)
        self.assertEqual(self.history.window(self.server.character, 10, {})[0][0]['content'], 'original')
        restarted = History(open_store(self.path), character_id=self.server.character)
        self.addCleanup(restarted.db.close)
        self.assertEqual(restarted.conversations.active, first['id'])
        self.assertEqual(len(restarted.conversations.list()), 2)

    def test_rename_pin_archive_restore_conflict_and_delete(self):
        self.record()
        first = self.conversations()[0]
        path = '/conversations/' + first['id']
        code, pinned = self.request('PUT', path, {'expected_version': first['revision'], 'title': '自定义标题', 'pinned': True})
        self.assertEqual(code, 200)
        self.assertTrue(pinned['pinned'])
        self.assertEqual(self.request('PUT', path, {'expected_version': first['revision'], 'title': 'stale'})[0], 409)
        code, archived = self.request('PUT', path, {'expected_version': pinned['revision'], 'archived': True})
        self.assertEqual(code, 200)
        self.assertFalse(archived['active'])
        self.assertEqual(self.request('POST', path + '/activate', {'expected_version': archived['revision']})[0], 409)
        self.assertEqual(self.request('POST', path + '/messages', {'text': 'bad'})[0], 409)
        code, restored = self.request('PUT', path, {'expected_version': archived['revision'], 'archived': False})
        self.assertEqual(code, 200)
        self.assertEqual(self.request('DELETE', path, {'expected_version': restored['revision']})[0], 200)
        self.assertEqual(self.history.export(), [])
        self.assertEqual(self.history.search('original', skip_recent=0), [])
        self.assertEqual(self.request('GET', path + '/turns')[0], 404)

    def test_auth_validation_and_busy_do_not_mutate_or_cancel(self):
        item = self.conversations()[0]
        path = '/conversations/' + item['id']
        for method, suffix, body in [('GET', '', None), ('POST', '', {}), ('PUT', '/' + item['id'], {'expected_version': 1, 'pinned': True}), ('DELETE', '/' + item['id'], {'expected_version': 1})]:
            self.assertEqual(self.request(method, '/conversations' + suffix, body, token='wrong')[0], 401)
        generation = self.server.history_generation
        for body in ({'expected_version': True, 'pinned': True}, {'expected_version': 1, 'pinned': 1}, {'expected_version': 1, 'title': ''}, {'expected_version': 1, 'extra': 3}):
            self.assertEqual(self.request('PUT', path, body)[0], 400)
        event = threading.Event()
        self.server._live_lines.add(event)
        self.assertTrue(self.request('GET', '/conversations')[1]['busy'])
        self.assertEqual(self.request('POST', '/conversations', {})[0], 409)
        self.assertEqual(self.request('DELETE', path, {'expected_version': 1})[0], 409)
        self.assertEqual(self.request('PUT', path, {'expected_version': 1, 'archived': True})[0], 409)
        self.server._live_lines.remove(event)
        self.assertEqual(self.server.history_generation, generation)

    def test_cursor_and_clear_remove_metadata_and_do_not_rehydrate_deleted_turns(self):
        item = self.conversations()[0]
        for i in range(6): self.record(str(i))
        path = '/conversations/' + item['id'] + '/turns'
        page = self.request('GET', path + '?limit=2')[1]
        self.assertEqual([r['user_text'] for r in page['turns']], ['4', '5'])
        older = self.request('GET', path + '?limit=2&before=' + str(page['before']))[1]
        self.assertEqual([r['user_text'] for r in older['turns']], ['2', '3'])
        self.assertEqual(self.request('GET', path + '?limit=201')[0], 400)
        self.assertEqual(self.request('GET', path + '?before=oops')[0], 400)
        self.history.clear()
        self.assertEqual(len(self.conversations()), 1)
        self.assertNotEqual(self.conversations()[0]['id'], item['id'])
        self.assertEqual(self.history.db.execute('SELECT COUNT(*) FROM conversation_turns').fetchone()[0], 0)

    def test_send_only_to_active_and_only_valid_inputs(self):
        item = self.conversations()[0]
        path = '/conversations/' + item['id'] + '/messages'
        self.server.say = Mock(return_value=(202, {'line_id': 'line-1'}))
        self.assertEqual(self.request('POST', path, {'text': 'hello'})[0], 202)
        self.server.say.assert_called_once_with('hello')
        self.request('POST', '/conversations', {})
        self.assertEqual(self.request('POST', path, {'text': 'hello'})[0], 409)
        self.assertEqual(self.request('POST', path, {'text': ' '})[0], 400)
        self.assertEqual(self.server.say.call_count, 1)

    def test_send_passes_look_and_no_memory_booleans_and_rejects_other_types(self):
        item = self.conversations()[0]
        path = '/conversations/' + item['id'] + '/messages'
        self.server.say = Mock(return_value=(202, {'line_id': 'line-1'}))
        self.assertEqual(self.request('POST', path, {'text': 'hello', 'look': True, 'no_memory': True})[0], 202)
        self.server.say.assert_called_once_with('hello', look=True, remember=False)
        self.assertEqual(self.request('POST', path, {'text': 'hello', 'look': False, 'no_memory': False})[0], 202)
        self.server.say.assert_called_with('hello', look=False, remember=True)
        for body, error in (({'text': 'hello', 'look': 1}, 'invalid_look'), ({'text': 'hello', 'look': None}, 'invalid_look'),
                            ({'text': 'hello', 'no_memory': 'yes'}, 'invalid_no_memory'),
                            ({'look': True}, 'invalid_text'), ({'text': 'hello', 'extra': True}, 'invalid_text')):
            self.assertEqual(self.request('POST', path, body), (400, {'error': error}))
        self.assertEqual(self.server.say.call_count, 2)

    def test_send_passes_scope_id_and_rejects_bad_or_temporary_scope(self):
        item = self.conversations()[0]
        path = '/conversations/' + item['id'] + '/messages'
        self.server.say = Mock(return_value=(202, {'line_id': 'line-1'}))
        self.assertEqual(self.request('POST', path, {'text': '汇总一下', 'scope_id': 'scope-1'})[0], 202)
        self.server.say.assert_called_once_with('汇总一下', scope_id='scope-1')
        for value in (5, 'x' * 129, ''):
            self.assertEqual(self.request('POST', path, {'text': 't', 'scope_id': value}), (400, {'error': 'invalid_scope_id'}))
        self.assertEqual(self.request('POST', path, {'text': 't', 'no_memory': True, 'scope_id': 'scope-1'}),
                         (400, {'error': 'temporary_scope_not_allowed'}))
        self.assertEqual(self.server.say.call_count, 1)

    def test_send_while_the_role_works_goes_to_say(self):
        item = self.conversations()[0]
        self.server.say = Mock(return_value=(202, {'line_id': 'side-line'}))
        self.server.character_agent = SimpleNamespace(busy=lambda: True)
        try:
            self.assertEqual(self.request('POST', '/conversations/' + item['id'] + '/messages', {'text': 'hello'})[0], 202)
        finally:
            self.server.character_agent = None
        self.server.say.assert_called_once_with('hello')

    def test_owned_session_management_persists_and_prevents_resurrection(self):
        session = OwnSession('claude', self.tmp.name, 'original')
        self.manager.sessions[session.session_id] = session
        self.manager.save(session)
        self.manager.add_line(session, 'user', 'secret')
        path = '/sessions/' + session.session_id
        code, item = self.request('PUT', path, {'expected_version': 1, 'pinned': True, 'title': 'renamed'})
        self.assertEqual(code, 200)
        self.assertTrue(item['pinned'])
        self.assertEqual(self.request('DELETE', path, {'expected_version': 1})[0], 409)
        session.busy = True
        self.assertEqual(self.request('PUT', path, {'expected_version': 2, 'archived': True})[0], 409)
        self.assertEqual(self.request('DELETE', path, {'expected_version': 2})[0], 409)
        session.busy = False
        self.assertEqual(self.request('PUT', path, {'expected_version': 2, 'archived': True})[0], 200)
        self.assertEqual(self.manager.message(session.session_id, 'no'), 'archived')
        second = SessionManager(self.server.broker, self.server.announce, Path(self.tmp.name), '', 'hook', 10, store=open_store(self.path))
        self.addCleanup(second.store.close); self.addCleanup(second.close)
        self.assertTrue(second.sessions[session.session_id].archived)
        self.assertTrue(second.sessions[session.session_id].pinned)
        self.assertEqual(self.request('DELETE', path, {'expected_version': 3})[0], 200)
        self.manager.add_line(session, 'agent', 'late')
        self.manager.save(session)
        self.assertEqual(self.manager.store.execute('SELECT COUNT(*) FROM own_sessions').fetchone()[0], 0)
        self.assertEqual(self.manager.store.execute('SELECT COUNT(*) FROM own_session_lines').fetchone()[0], 0)
        self.assertEqual(self.manager.store.execute('SELECT COUNT(*) FROM session_management').fetchone()[0], 0)

    def test_delete_retires_checkpoints_and_trace_text(self):
        self.record(); item = self.conversations()[0]
        runs = RunStore(Path(self.tmp.name) / 'runs.sqlite')
        self.addCleanup(runs.close)
        runs.begin('turn-original', item['id'], 'voice_a', 1)
        runs.checkpoint('turn-original', 'task1', {'task_id': 'task1', 'text': 'secret'})
        self.server.character_agent = SimpleNamespace(store=runs, busy=lambda: False, _lock=threading.RLock(), runtime=None, _runtime_config=None)
        self.server.trace = SimpleNamespace(forget=Mock())
        code, _ = self.request('DELETE', '/conversations/' + item['id'], {'expected_version': item['revision']})
        self.assertEqual(code, 200)
        self.assertIsNone(runs.get('turn-original'))
        self.assertIsNone(runs.load_checkpoint(run_id='turn-original'))
        self.server.trace.forget.assert_called_once_with(['turn-original'])
        self.server.trace = None; self.server.character_agent = None

    def test_conversation_delete_removes_private_run_items(self):
        from test_run_items import item as run_item
        conversation = self.conversations()[0]
        runs = RunStore(Path(self.tmp.name) / 'runs.sqlite')
        self.addCleanup(runs.close)
        runs.begin('run', conversation['id'], 'voice_a', 1)
        runs.item(run_item())
        self.server.character_agent = SimpleNamespace(store=runs, busy=lambda: False,
            _lock=threading.RLock(), runtime=None, _runtime_config=None)
        self.server.history.conversations.run_store = runs  # as CharacterAgentController wires it
        code, _ = self.request('DELETE', '/conversations/' + conversation['id'], {'expected_version': 1})
        self.assertEqual(code, 200)
        self.assertEqual(runs.db.execute('SELECT COUNT(*) FROM character_run_items').fetchone()[0], 0)
        self.server.history.conversations.run_store = None; self.server.character_agent = None

    def test_delete_erases_character_tasks_from_canonical_list_and_next_chat_context(self):
        from character_agent.services.deliveries import DeliveryService
        from character_agent.services.jobs import JobStore
        from personal.memory import Memory
        from sessions.tasks import TaskLedger
        first = self.conversations()[0]
        code, second = self.request('POST', '/conversations', {})
        self.assertEqual(code, 201)
        runs = RunStore(Path(self.tmp.name) / 'task-runs.sqlite')
        self.addCleanup(runs.close)
        memory = Memory(self.history.db, lock=self.history.lock)
        jobs = JobStore(memory)
        task_db = open_store(self.path)
        self.addCleanup(task_db.close)
        self.server.tasks = tasks = TaskLedger(task_db)
        deliveries = DeliveryService(memory, runs, tasks, jobs)
        self.history.conversations.run_store = runs
        self.server.character_agent = SimpleNamespace(store=runs, deliveries=deliveries, busy=lambda: False,
            _lock=threading.RLock(), runtime=None, _runtime_config=None, close=lambda: None)
        self.addCleanup(setattr, self.server, 'character_agent', None)

        def create_task(ident, title, owner, target='character'):
            tasks.create(ident, target, self.tmp.name, title, 'workspace_write')
            for state in ('approved', 'running', 'returned', 'verifying', 'needs_review'):
                tasks.transition(ident, state)
            runs.begin('run-' + ident, owner, 'aster', 1, delivery_eligible=True)
            runs.finish('run-' + ident, 'completed', task_id=ident, result={'artifacts': []})

        create_task('retained', 'OTHER-CONVERSATION', second['id'])
        retained_delivery = deliveries.produce('run-retained')
        create_task('coding', 'CODING-TASK', first['id'], target='codex')
        create_task('shared', 'SHARED-TASK', first['id'])
        runs.begin('retained-shared', second['id'], 'aster', 1)
        runs.finish('retained-shared', 'completed', task_id='shared')
        create_task('deleted', 'DELETED-PRIVATE-TITLE', first['id'])
        deleted_delivery = deliveries.produce('run-deleted')
        # A retained job result still identifies its task after its RunStore row
        # is gone (older attempts/recovery); deletion must cover this source too.
        create_task('legacy', 'DELETED-JOB-TITLE', first['id'])
        runs.forget_runs({'run-legacy'})
        job = jobs.submit('DELETED-JOB-TITLE', {'character_id': 'aster'}, conversation_id=first['id'])
        path = '/conversations/' + first['id']
        # Never drop ownership while a queued/running worker could still create
        # its first task after a successful current() check.
        self.assertEqual(self.request('DELETE', path, {'expected_version': first['revision']})[0], 409)
        self.assertEqual(jobs.claim()['job_id'], job['job_id'])
        self.assertEqual(self.request('DELETE', path, {'expected_version': first['revision']})[0], 409)
        self.assertIsNotNone(tasks.get('deleted'))
        jobs.settle(job['job_id'], 'needs_review', {'task_id': 'legacy'}, expected_run_id=job['run_id'])
        self.assertIn('DELETED-PRIVATE-TITLE', self.server._tasks_context())
        self.assertEqual(self.request('DELETE', path, {'expected_version': 99})[0], 409)
        self.assertIsNotNone(tasks.get('deleted'))
        foreign = jobs.submit('OTHER-BACKGROUND', {'character_id': 'aster'}, conversation_id=second['id'])
        self.assertEqual(self.request('DELETE', path, {'expected_version': first['revision']})[0], 200)
        code, body = self.request('GET', '/agent/tasks')
        self.assertEqual(code, 200)
        self.assertEqual({t['task_id'] for t in body['tasks'] if t['task_id']}, {'retained', 'coding', 'shared'})
        self.assertEqual(jobs.get(foreign['job_id'])['state'], 'queued')
        self.assertIn('job:' + foreign['job_id'], {t['canonical_task_id'] for t in body['tasks']})
        self.assertNotIn('DELETED-', self.server._tasks_context())
        self.assertIsNone(deliveries.get(deleted_delivery['delivery_id']))
        self.assertIsNotNone(deliveries.get(retained_delivery['delivery_id']))
        for ident in ('deleted', 'legacy'):
            self.assertIsNone(tasks.get(ident))
            self.assertEqual(task_db.execute('SELECT COUNT(*) FROM task_events WHERE task_id=?', (ident,)).fetchone()[0], 0)
        for ident in ('retained', 'coding', 'shared'):
            self.assertIsNotNone(tasks.get(ident))
            self.assertGreater(task_db.execute('SELECT COUNT(*) FROM task_events WHERE task_id=?', (ident,)).fetchone()[0], 0)
        runs.close()
        restarted = RunStore(Path(self.tmp.name) / 'task-runs.sqlite')
        self.addCleanup(restarted.close)
        recovered = DeliveryService(memory, restarted, tasks, jobs)
        self.assertEqual({t['task_id'] for t in recovered.tasks_page()['tasks'] if t['task_id']}, {'retained', 'coding', 'shared'})
        self.history.conversations.run_store = None
        self.server.character_agent = None

    def test_deleted_owned_session_does_not_reappear_through_late_hooks(self):
        session = OwnSession('claude', self.tmp.name, 'original')
        session.native_id = 'native-alias'
        self.manager.sessions[session.session_id] = session
        self.manager.save(session)
        def hook(name):
            return self.request('POST', '/hook/claude', {'hook_event_name': name, 'session_id': session.native_id, 'cwd': self.tmp.name}, token=test_server.HOOK)
        self.assertEqual(hook('SessionStart')[0], 200)
        self.assertEqual(len(self.request('GET', '/sessions')[1]['sessions']), 1)
        self.assertEqual(self.request('DELETE', '/sessions/' + session.session_id, {'expected_version': 1})[0], 200)
        self.assertEqual(hook('Stop')[0], 200)
        self.assertEqual(self.request('GET', '/sessions')[1]['sessions'], [])
        self.assertEqual(hook('UserPromptSubmit')[0], 200)
        rows = self.request('GET', '/sessions')[1]['sessions']
        self.assertEqual(len(rows), 1)
        self.assertFalse(rows[0]['own'])


from test_history_server import HistoryServerCase


class ConversationDeliveryTest(HistoryServerCase):
    def test_real_say_entrypoint_and_window_switch_do_not_deadlock_or_mix_context(self):
        first = self.server.history.conversations.list()[0]
        def send(ident, text):
            conn, response = self.open_feed()
            try:
                code, _ = self.request('POST', '/conversations/' + ident + '/messages', {'text': text})
                self.assertEqual(code, 202)
                self.lines_until_final(response)
            finally: conn.close()
        send(first['id'], 'first-thread')
        self.assertEqual(len(self.server.history.window(self.server.character, 10, {})), 1)
        code, second = self.request('POST', '/conversations', {})
        self.assertEqual(code, 201)
        send(second['id'], 'second-thread')
        self.assertEqual(self.past()[0], 'second-thread')
        self.assertNotIn('first-thread', self.past())
        first = self.server.history.conversations.get(first['id'])
        code, _ = self.request('POST', '/conversations/' + first['id'] + '/activate', {'expected_version': first['revision']})
        self.assertEqual(code, 200)
        self.assertEqual(self.server.mouth.history[0][0]['content'], 'first-thread')


if __name__ == '__main__': unittest.main()
