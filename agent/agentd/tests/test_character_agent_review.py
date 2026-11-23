"""Independent lifecycle regressions; all effects and models are synthetic."""
import unittest
import threading
import subprocess
import sys
import textwrap
from unittest.mock import patch

import test_character_agent_runtime as fixtures
import test_character_agent_integration as integration_fixtures


class ReviewLockOrderTests(unittest.TestCase):
    def test_parallel_checkpoint_and_workspace_revocation_do_not_deadlock_or_deliver_late_results(self):
        # A subprocess bounds the regression itself: the former lock inversion must
        # fail this test instead of wedging fixture teardown or the whole test suite.
        script = textwrap.dedent(r'''
            import contextvars, json, os, sys, threading
            sys.path[:0] = json.loads(sys.argv[1])
            from test_character_agent_integration import IntegrationTests
            from character_agent.harness.codex_transport import CodexConfig, ManagedCodexSession
            f = IntegrationTests(); f.setUp()
            s = f.server; workspace = f.controller.workspace
            # The ticker's sync_privacy would cancel the run as context_changed before snapshot() notices.
            s._stopped.set(); s._ticker.join(2)
            policy = f.root/'privacy.json'
            policy.write_text(json.dumps({'share_page_text':True}))
            s.share_page_text = True; s.privacy_config = str(policy)
            scope = workspace.create_scope([str(f.inputs)], str(f.root/'out'))['scope_id']
            s.memory.add('private-knowledge-payload', 'asserted_by_user', kind='preference')
            held_workspace, held_runtime, done = (threading.Event() for _ in range(3))
            original_current, original_artifacts = workspace._current, workspace.run_artifacts
            results = {}; direct_results = {}; phase = False

            def gated_current(run_id, is_current):
                if phase and threading.current_thread().name == 'character-tool' and not held_workspace.is_set():
                    held_workspace.set()
                    assert held_runtime.wait(2), 'checkpoint did not reach runtime lock'
                    # No sync_privacy/revoke call: current must notice a saved permission
                    # change through snapshot(), without running cancellation under this lock.
                    policy.write_text(json.dumps({'share_page_text':False}))
                return original_current(run_id, is_current)

            def gated_artifacts(run_id):
                if phase and threading.current_thread().name == 'character-tool':
                    assert f.controller.runtime._lock._is_owned()
                    held_runtime.set()
                return original_artifacts(run_id)

            workspace._current, workspace.run_artifacts = gated_current, gated_artifacts

            def script(session, prompt, options):
                global phase
                yield from session.use(options, 'task_plan', {'title':'Synthetic task','outputs':['blocked.md']})
                # Use the actual adapter's concurrent dispatch and final cancellation
                # filter without launching its subprocess or requesting a model.
                bridge = ManagedCodexSession(CodexConfig(f.root/'fixture-runner', 'test', api_key='synthetic',
                    workspace_dir=str(f.root), native_tools=True), f.definitions[-1])
                def domain_call(name, args):
                    value = options['tool_handler'](name, args)
                    direct_results[name] = value
                    return value
                bridge._active = {'id':options['run_id'], 'handler':domain_call,
                                  'cancel_signal':options['cancelled'], 'cancelled':False,
                                  'context':contextvars.copy_context()}
                def received(proc, call_id, run_id, result, failed):
                    results[call_id] = result
                    if len(results) == 2: done.set()
                bridge._tool_result = received
                phase = True
                bridge._dispatch_tool(None, bridge._generation, {'run_id':options['run_id'], 'tool_call_id':'write',
                    'name':'artifact_write', 'args':{'path':'blocked.md','content':'must-not-be-written','source_refs':[]}})
                assert held_workspace.wait(2), 'workspace lock not reached'
                bridge._dispatch_tool(None, bridge._generation, {'run_id':options['run_id'], 'tool_call_id':'knowledge',
                    'name':'personal_profile','args':{}})
                if not done.wait(2):
                    print('deadlock: concurrent domain tools did not finish', flush=True)
                    f.tmp.cleanup(); os._exit(2)
                assert all(value.get('error') == 'run_cancelled' for value in results.values()), results
                assert 'private-knowledge-payload' not in json.dumps(results)
                if direct_results.get('personal_profile', {}).get('error', {}).get('code') != 'run_cancelled':
                    print('domain result escaped after checkpoint waited across revocation', flush=True)
                    f.tmp.cleanup(); os._exit(3)
                assert workspace.run_artifacts(options['run_id']) == []
                assert not list((f.root/'out').rglob('blocked.md'))
                yield {'type':'result', 'success':True, 'final_text':'late response'}

            f.script = script
            cancel = threading.Event(); s._line_cancel = cancel; s._live_lines.add(cancel)
            s._line_consent[cancel] = s.sync_privacy()[1]
            trace = s._open_trace('lock-fixture', s.turn_generation, 'text', 'synthetic')
            answer = f.controller.prepare('lock-fixture', 'synthetic', cancel, s.turn_generation, 'text', trace, scope_id=scope)
            assert answer.error == 'cancelled', answer.error
            assert done.is_set() and len(results) == 2
            print('bounded parallel revocation passed', flush=True)
            f.tmp.cleanup(); os._exit(0)
        ''')
        import json
        result = subprocess.run([sys.executable, '-c', script, json.dumps(sys.path)], capture_output=True,
                                text=True, timeout=10, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('bounded parallel revocation passed', result.stdout)


class ReviewRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.RuntimeTests()
        self.fixture.setUp()

    def tearDown(self):
        self.fixture.tearDown()

    def test_unrelated_verification_cannot_resolve_an_unknown_native_effect(self):
        f = self.fixture
        f.runtime.native_tools = [dict(name=name, description='fixture', input_schema={'type': 'object'})
                                 for name in ('desktop_act', 'desktop_verify')]
        f.runtime.native_handler = lambda name, args, **kw: {
            'effect': 'unknown' if name == 'desktop_act' else 'confirmed'}

        def script(session, prompt, options):
            yield from session.use(options, 'desktop_act', {
                'snapshot_id': 'app-A', 'action': 'press', 'element_id': 'send-A'})
            yield from session.use(options, 'desktop_verify', {
                'snapshot_id': 'app-B', 'element_id': 'unrelated-B', 'expected_title': 'Already existed'})
            yield {'type': 'result', 'success': True, 'final_text': 'complete'}

        f.script = script
        result = f.run_agent(scope_id=None)
        self.assertIsNone(result.error)
        self.assertFalse(result.result['ok'])
        self.assertEqual(f.runtime.tools.ledger.effects('run-1')[0]['state'], 'unknown')
        self.assertEqual(f.tasks.get(result.task_id)['state'], 'failed')
        resumed = f.run_agent(run='run-2', scope_id=None, resume_run_id='run-1')
        self.assertEqual(resumed.error, 'effect_unknown')
        self.assertEqual(sum(len(session.calls) for session in f.sessions), 1)

    def _race_forget_with_admitted_write(self, owner, method):
        """A reset may wait for a short admitted write; it must win over every late write."""
        f = self.fixture
        entered, release, reset_started, reset_done = (threading.Event() for _ in range(4))
        original = getattr(owner, method)
        replies, failures = [], []

        def held_write(*args, **kwargs):
            entered.set()
            if not release.wait(3):
                raise AssertionError('review write barrier timed out')
            return original(*args, **kwargs)

        def reset():
            try:
                reset_started.set()
                f.runtime.forget()
                f.workspace.forget()
                with f.tasks.lock:
                    f.tasks.db.execute('DELETE FROM task_events')
                    f.tasks.db.execute('DELETE FROM tasks')
                    f.tasks.db.commit()
            except Exception as error:
                failures.append(error)
            finally:
                reset_done.set()

        def script(session, prompt, options):
            yield from session.use(options, 'task_plan', {'title': 'synthetic private user goal', 'outputs': []})
            yield {'type': 'result', 'success': True, 'final_text': 'complete'}

        f.script = script
        with patch.object(owner, method, held_write):
            worker = threading.Thread(target=lambda: replies.append(f.run_agent(scope_id=None)), daemon=True)
            worker.start()
            self.assertTrue(entered.wait(2))
            resetter = threading.Thread(target=reset, daemon=True)
            resetter.start()
            self.assertTrue(reset_started.wait(1))
            # Before the fix reset completes here and a late write survives. With a write fence,
            # reset waits; releasing the short write lets it clear the admitted row afterwards.
            reset_done.wait(0.15)
            release.set()
            worker.join(3); resetter.join(3)
        self.assertFalse(worker.is_alive())
        self.assertFalse(resetter.is_alive())
        self.assertEqual(failures, [])
        self.assertEqual(f.runtime.store.list(), [])
        self.assertEqual(f.tasks.list(), [])
        self.assertEqual(f.runtime.tools.ledger.effects('run-1'), [])

    def test_reset_during_task_creation_cannot_recreate_private_goal(self):
        self._race_forget_with_admitted_write(self.fixture.tasks, 'create')

    def test_reset_during_run_creation_cannot_recreate_private_run(self):
        self._race_forget_with_admitted_write(self.fixture.runtime.store, 'begin')

    def test_read_only_runtime_refuses_persistent_expectations_and_resume(self):
        f = self.fixture
        for index, options in enumerate(({'expected_outputs': f.expected()}, {'resume_run_id': 'old-run'})):
            with self.subTest(options=options):
                result = f.run_agent(run='readonly-' + str(index), allow_actions=False, **options)
                self.assertEqual(result.error, 'read_only_run')
        self.assertEqual(f.sessions, [])
        self.assertEqual(f.runtime.store.list(), [])
        self.assertEqual(f.tasks.list(), [])
        self.assertEqual(f.workspace.db.execute('SELECT COUNT(*) FROM expectations').fetchone()[0], 0)


class ReviewIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.fixture = integration_fixtures.IntegrationTests()
        self.fixture.setUp()

    def tearDown(self):
        self.fixture.tearDown()
        self.fixture.doCleanups()

    def test_cancel_stale_task_does_not_cancel_another_runtime(self):
        f = self.fixture
        f.server.tasks.create('old-task', 'character', '/synthetic', 'Old task', 'workspace_write')
        f.server.tasks.transition('old-task', 'approved')
        f.server.tasks.transition('old-task', 'running')
        with patch.object(f.controller, 'cancel') as cancel:
            code, _ = f.request('POST', '/tasks/old-task/cancel', {})
        self.assertEqual(code, 409)
        cancel.assert_not_called()

    def test_continuation_text_is_not_a_new_top_level_memory_command(self):
        f = self.fixture
        task_id = 'task-1'
        f.server.tasks.create(task_id, 'character', '/synthetic', 'Goal', 'workspace_write')
        for state in ('approved', 'running', 'returned', 'verifying', 'needs_review'):
            f.server.tasks.transition(task_id, state)
        store = f.controller.store
        store.begin('old-run', store.conversation_id, f.server.character, 1)
        store.finish('old-run', 'completed', task_id=task_id)
        store.checkpoint('old-run', task_id, {'task_id': task_id, 'scope_id': None, 'goal': 'Goal', 'dependencies': []})
        conn, response = f.open_feed()
        try:
            code, body = f.request('POST', '/tasks/task-1/continue', {'text': '记住我喜欢安静'})
            self.assertEqual(code, 202, body)
            f.lines_until_final(response)
        finally:
            conn.close()
        self.assertEqual(f.server.memory.active(), [])
        self.assertEqual(sum(len(session.calls) for session in f.sessions), 1)

    def _expired_default_scope(self):
        f = self.fixture
        scope = f.controller.workspace.create_scope([str(f.inputs)], str(f.root / 'out'), ttl=10)
        f.controller.settings.save({**f.controller.settings.snapshot(), 'scope_id': scope['scope_id']})
        f.controller.workspace.clock = lambda: scope['expires_at'] + 1
        return scope

    def test_expired_default_scope_does_not_block_conversation_or_extend_permission(self):
        f = self.fixture
        scope = self._expired_default_scope()
        body, _ = f.line('你好，今天想聊一会儿')
        self.assertEqual(body['scope_warning'], 'scope_expired')
        self.assertIsNone(f.controller.store.get(body['run_id'])['scope_id'])
        self.assertEqual(f.controller.workspace.get_scope(scope['scope_id'])['expires_at'], scope['expires_at'])
        with self.assertRaisesRegex(ValueError, 'scope_expired'):
            f.controller.workspace.validate_scope(scope['scope_id'])

    def test_expired_default_scope_warns_once_and_is_no_longer_the_default(self):
        f = self.fixture
        self._expired_default_scope()
        body, _ = f.line('你好，今天想聊一会儿')
        self.assertEqual(body['scope_warning'], 'scope_expired')
        self.assertIsNone(f.controller.settings.snapshot()['scope_id'])
        body, _ = f.line('再聊一句')
        self.assertNotIn('scope_warning', body)

    def test_unavailable_default_scope_stays_the_default(self):
        f = self.fixture
        scope = f.controller.workspace.create_scope([str(f.inputs)], str(f.root / 'out'))
        f.controller.settings.save({**f.controller.settings.snapshot(), 'scope_id': scope['scope_id']})
        f.inputs.rename(f.root / 'moved')
        body, _ = f.line('你好，今天想聊一会儿')
        self.assertEqual(body['scope_warning'], 'scope_changed')
        self.assertEqual(f.controller.settings.snapshot()['scope_id'], scope['scope_id'], "a folder can come back")

    def test_explicit_expired_scope_is_refused_before_model_request(self):
        f = self.fixture
        scope = self._expired_default_scope()
        code, body = f.request('POST', '/say', {'text': '请整理这些资料', 'scope_id': scope['scope_id']})
        self.assertEqual(code, 409, body)
        self.assertEqual(body['error'], 'scope_expired')
        self.assertEqual(f.sessions, [])
        self.assertEqual(f.controller.store.list(), [])

    def test_temporary_harness_only_reads_explicit_memory_and_keeps_no_persistent_words(self):
        f = self.fixture
        explicit = f.server.memory.add('I prefer quiet venues.', 'asserted_by_user', kind='preference')
        confirmed = f.server.memory.add('I prefer short answers.', 'confirmed_by_user', kind='preference')
        inferred = f.server.memory.add('Synthetic inferred preference.', 'inferred_hypothesis', kind='preference')

        def script(session, prompt, options):
            profile = yield from session.use(options, 'personal_profile', {})
            self.assertEqual({row['id'] for row in profile['items']}, {explicit, confirmed})
            hidden = yield from session.use(options, 'knowledge_read', {'source': 'memory', 'id': inferred})
            self.assertEqual(hidden['error']['code'], 'source_unavailable')
            for source in ('history', 'episodes', 'commitments'):
                denied = yield from session.use(options, 'knowledge_read', {'source': source, 'id': 'synthetic'})
                self.assertEqual(denied['error']['code'], 'source_not_permitted')
            behavior = yield from session.use(options, 'behavior_context', {})
            self.assertFalse(behavior['available'])
            for name in ('artifact_write', 'desktop_act', 'task_plan'):
                refused[name] = (yield from session.use(options, name, {}))['error']['code']
            yield {'type': 'result', 'success': True, 'final_text': 'Temporary answer.'}

        refused = {}

        f.script = script
        body, _ = f.line('search temporary-synthetic-private-text', no_memory=True)
        self.assertEqual(body['runtime'], 'pi')
        self.assertEqual(f.server.history.export(), [])
        self.assertEqual(f.server.tasks.list(), [])
        self.assertEqual(len(f.server.memory.active()), 3)
        names = {tool['name'] for tool in f.definitions[-1]}
        self.assertEqual(refused, {name: 'tool_not_allowed_in_mode' if name in names else 'tool_not_available' for name in refused})
        self.assertEqual(set(refused), {'artifact_write', 'desktop_act', 'task_plan'})
        self.assertNotIn('temporary-synthetic-private-text', str(f.controller.store.list()))

    def test_temporary_request_rejects_persistent_task_parameters_before_admission(self):
        f = self.fixture
        for options in ({'expected_outputs': {'artifacts': [{'path': 'private-goal-title.md'}]}},
                        {'resume_run_id': 'old-run'}):
            with self.subTest(options=options):
                code, body = f.request('POST', '/say', {'text': '临时阅读', 'no_memory': True, **options})
                self.assertEqual(code, 400, body)
                self.assertEqual(body['error'], 'temporary_action_not_allowed')
        self.assertEqual(f.sessions, [])
        self.assertEqual(f.controller.store.list(), [])
        self.assertEqual(f.server.tasks.list(), [])
        self.assertEqual(f.controller.workspace.db.execute('SELECT COUNT(*) FROM expectations').fetchone()[0], 0)
