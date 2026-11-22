"""Role execution, product interactions and C1 use the same bounded state view."""
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
import threading
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_agent.services.embodiment import project
from character_agent.services.interactions import InteractionService
from character_agent.services.store import RunStore
from sessions.events import normalize_claude
from sessions.registry import Registry
import test_agent_item_stream as stream_fixture
from test_character_agent_runtime import FakeSession, chat


class EmbodimentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = RunStore(Path(self.tmp.name) / 'runs.sqlite')
        self.interactions = InteractionService(self.store)
        self.now = time.time()
        self.registry = Registry(clock=lambda: self.now)

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def begin(self, ident='work', character='aster'):
        self.store.begin(ident, 'conversation', character, 7)
        self.store.event(ident, 'running', {'backend': 'codex'})

    def publish(self):
        focus = project(self.store, 'aster', self.now)
        self.registry.set_role_focus(focus, generation=12)
        return self.registry.intents[-1]

    def pending(self, ident='question', kind='question', expires=None, run='work', state='pending'):
        # No user text is needed for state projection, even though real cards hold private content.
        with self.store.lock:
            self.store.db.execute('INSERT INTO character_interactions(request_id,run_id,kind,state,revision,data,'
                'created_at,expires_at,conversation_id) VALUES(?,?,?,?,1,?,?,?,?)',
                (ident, run, kind, state, json.dumps({'question': 'PRIVATE QUESTION'}),
                 self.now, self.now + 60 if expires is None else expires, 'conversation'))
            self.store.db.commit()

    def test_metadata_only_progress_reaches_c1_and_never_creates_external_session(self):
        self.begin()
        self.assertEqual(self.publish()['state'], 'thinking')
        self.store.event('work', 'tool_started', {'tool': 'artifact_verify', 'tool_call_id': 'private-call'})
        intent = self.publish()
        self.assertEqual((intent['state'], intent['intent']), ('running_tool', 'explain'))
        self.assertEqual((intent['run_id'], intent['run_generation'], intent['turn_generation']), ('work', 7, 12))
        self.assertEqual(self.registry.snapshot()['sessions'], [])
        self.assertNotIn('private-call', json.dumps(intent))
        self.store.event('work', 'tool_finished', {'tool': 'artifact_verify', 'tool_call_id': 'private-call'})
        self.assertEqual(self.publish()['state'], 'thinking')

    def test_parallel_tools_remain_running_until_the_last_receipt(self):
        self.begin()
        for name in ('a', 'b'):
            self.store.event('work', 'tool_started', {'tool': 'knowledge_search', 'tool_call_id': name})
        self.store.event('work', 'tool_finished', {'tool_call_id': 'a'})
        self.assertEqual(self.publish()['state'], 'running_tool')
        self.store.event('work', 'tool_finished', {'tool_call_id': 'b'})
        self.assertEqual(self.publish()['state'], 'thinking')

    def test_completion_is_not_automatically_success(self):
        for outcome, state, intent in [('answered', 'done', 'acknowledge'),
                ('succeeded', 'done', 'celebrate'), ('failed', 'error', 'apologize'),
                ('needs_review', 'awaiting_input', 'uncertain')]:
            with self.subTest(outcome=outcome):
                self.store.forget()
                self.begin()
                self.store.finish('work', 'completed')
                self.store.event('work', 'completed', {'outcome': outcome})
                value = self.publish()
                self.assertEqual((value['state'], value['intent']), (state, intent))
        self.now += 9
        self.assertEqual(self.publish()['state'], 'idle')

    def test_cancel_old_character_semantic_and_unverified_legacy_completion_do_not_celebrate(self):
        self.store.begin('maintenance', 'conversation', 'aster', 0)
        self.begin('other', 'cedar')
        self.assertIsNone(project(self.store, 'aster'))

        self.begin()
        self.store.finish('work', 'cancelled')
        self.assertEqual(self.publish()['state'], 'idle')
        self.store.finish('maintenance', 'completed')
        self.begin('old')
        self.store.finish('old', 'completed')
        self.store.event('old', 'completed', {})
        self.assertIsNone(project(self.store, 'aster'))

    def test_new_work_takes_focus_from_a_recent_failure(self):
        self.begin('old')
        self.store.finish('old', 'failed')
        self.store.event('old', 'failed', {'error': 'missing_artifact'})
        self.assertEqual(self.publish()['outcome'], 'failed')
        self.begin('new')
        self.assertEqual(self.publish()['run_id'], 'new')

    def test_question_outweighs_work_and_clears_after_answer(self):
        self.begin()
        self.pending()
        self.begin('background')
        value = self.publish()
        self.assertEqual((value['run_id'], value['state']), ('work', 'awaiting_input'))
        self.assertNotIn('PRIVATE QUESTION', json.dumps(value))
        with self.store.lock:
            self.store.db.execute("UPDATE character_interactions SET state='delivered'")
            self.store.db.commit()
        self.assertEqual(self.publish()['state'], 'thinking')

    def test_background_run_has_its_own_state_and_count(self):
        self.store.begin('bg', 'conversation', 'aster', 7)
        self.store.event('bg', 'running', {'backend': 'codex', 'work_kind': 'background'})
        value = project(self.store, 'aster', self.now)
        self.assertEqual((value['state'], value['background_runs']), ('background', 1))
        self.assertEqual(self.publish()['intent'], 'think')
        self.store.event('bg', 'tool_started', {'tool': 'knowledge_search', 'tool_call_id': 't'})
        self.assertEqual(project(self.store, 'aster', self.now)['state'], 'background')
        self.now += 1
        self.begin()
        value = project(self.store, 'aster', self.now)
        self.assertEqual((value['run_id'], value['state'], value['background_runs']), ('work', 'thinking', 1))

    def test_a_running_row_without_work_kind_is_foreground(self):
        self.begin()
        value = project(self.store, 'aster', self.now)
        self.assertEqual((value['state'], value['background_runs']), ('thinking', 0))

    def test_approval_answer_releases_attention_and_expired_question_is_not_live(self):
        self.begin()
        self.pending(kind='approval')
        self.assertEqual(self.publish()['state'], 'awaiting_approval')
        with self.store.lock:
            self.store.db.execute("UPDATE character_interactions SET state='answered'")
            self.store.db.commit()
        self.assertEqual(self.publish()['state'], 'thinking')
        self.pending('expired', expires=self.now - 1)
        self.assertEqual(self.publish()['state'], 'thinking')

    def test_durable_zero_expiry_survives_reconnect_but_cancel_does_not(self):
        self.begin()
        self.pending(expires=0)
        with self.store.lock:
            self.store.db.execute("UPDATE character_runs SET state='waiting_user' WHERE run_id='work'")
            self.store.db.commit()
        self.assertEqual(self.publish()['state'], 'awaiting_input')
        fresh = Registry(clock=lambda: self.now)
        fresh.set_role_focus(project(self.store, 'aster'), generation=12)
        self.assertEqual(fresh.intents[-1]['intent'], 'listen')
        self.store.finish('work', 'cancelled')
        self.assertEqual(self.publish()['state'], 'idle')

    def test_role_work_beats_external_work_but_external_approval_still_matters(self):
        self.registry.ingest(normalize_claude({'hook_event_name': 'PreToolUse', 'session_id': 'external',
                                             'tool_name': 'Bash'}, now=self.now))
        self.begin()
        self.assertEqual(self.publish()['display_session'], 'role:work')
        self.registry.ingest(normalize_claude({'hook_event_name': 'PermissionRequest',
                                             'session_id': 'external'}, now=self.now))
        self.assertEqual(self.publish()['display_session'], 'claude:external')
        self.pending()
        self.assertEqual(self.publish()['display_session'], 'role:work')

    def test_quiet_and_new_generation_emit_without_changing_task_truth(self):
        self.begin()
        focus = project(self.store, 'aster')
        self.registry.set_role_focus(focus, generation=12)
        seq = self.registry.intent_seq
        self.registry.set_quiet(True)
        self.assertEqual(self.registry.intent_seq, seq + 1)
        self.assertTrue(self.registry.intents[-1]['quiet'])
        self.registry.set_role_focus(focus, generation=13)
        self.assertEqual(self.registry.intents[-1]['turn_generation'], 13)
        self.assertTrue(self.registry.intents[-1]['quiet'])  # a role refresh keeps the quiet it did not set
        self.assertEqual(self.registry.intents[-1]['state'], 'thinking')


class ProductEmbodimentTests(unittest.TestCase):
    setUp = stream_fixture.AgentItemStreamTests.setUp
    stop_server = stream_fixture.AgentItemStreamTests.stop_server
    events = stream_fixture.AgentItemStreamTests.events

    def deliver(self, run_id='run'):
        s = self.server
        trace = s._open_trace(run_id, s.turn_generation, 'text', 'Question', remember=True)
        s._run_character_line(run_id, 'Question', threading.Event(), s.turn_generation, trace=trace, remember=True)

    def factory(self, definitions):
        def script(session, prompt, options):
            yield from session.use(options, 'knowledge_search', {'query': 'work'})
            yield from chat(session, prompt, options)
        return FakeSession(script)

    def test_both_backends_drive_body_and_ui_from_real_product_events(self):
        from observation.desktop_presence import snapshot
        for backend in ('pi', 'codex'):
            with self.subTest(backend=backend):
                self.controller.store.forget()
                self.controller.configure({'backend': backend, 'runtime_source': 'local'})
                start = self.server.registry.intent_seq
                self.deliver(backend)
                intents = [e for e in self.server.registry.intents_since(start) if e.get('run_id') == backend]
                self.assertIn('running_tool', [e['state'] for e in intents])
                self.assertEqual(intents[-1]['intent'], 'acknowledge')
                self.assertEqual(intents[-1]['outcome'], 'answered')
                role = snapshot(self.server)['role']
                self.assertEqual((role['state'], role['outcome']), ('done', 'answered'))
                self.assertEqual(role['run_id'], intents[-1]['run_id'])
                self.assertNotIn('synthetic-event-secret', json.dumps(intents))

    def test_presentation_failure_cannot_fail_successful_work_or_stop_ticker(self):
        with patch('character_agent.services.embodiment.project', side_effect=RuntimeError('private detail')):
            with self.assertLogs('character_agent.integration', level='WARNING') as logs:
                self.deliver()
            self.assertNotIn('private detail', str(logs.output))
            self.assertTrue(self.server._ticker.is_alive())
        self.assertEqual(self.controller.store.get('run')['state'], 'completed')
        self.assertFalse(self.events('line')[-1].get('error'))
        self.controller.refresh_presentation()
        self.assertEqual(self.server.registry.focus()['state'], 'done')

    def test_background_worker_publishes_explicit_ownership(self):
        job = self.controller.submit_job('Report', 'Read my notes', 'Summarize the available notes')
        deadline = time.monotonic() + 3
        while self.controller.jobs.store.get(job['job_id'])['state'] in ('queued', 'running') and time.monotonic() < deadline:
            time.sleep(.005)
        events = [e for e in self.events('agent_run') if e.get('job_id') == job['job_id']]
        self.assertTrue(events)
        self.assertTrue(all(e['work_kind'] == 'background' for e in events))
        self.assertTrue(all(e['conversation_id'] == job['conversation_id'] for e in events))
        self.assertEqual(events[-1]['phase'], 'completed')

    def test_only_verified_own_work_changes_mood_once(self):
        from character.character_state import CharacterState
        state = self.server.state = CharacterState(self.db, lambda _: None, clock=lambda: 1000)
        state.use(self.server.character)
        store = self.controller.store
        store.begin('run', 'conversation', self.server.character, 0)
        before = state.valence
        for outcome in ('answered', 'needs_review', 'background_pending'):
            self.controller._event({'run_id': 'run', 'phase': 'completed', 'outcome': outcome})
        self.assertEqual(state.valence, before)
        event = {'run_id': 'run', 'phase': 'completed', 'outcome': 'succeeded'}
        self.controller._event(event)
        self.controller._event(event)
        self.assertAlmostEqual(state.valence, before + .1)
        self.assertEqual(state.causes[-1]['cause'], 'task_verified')
        store.begin('foreign', 'conversation', 'other-character', 0)
        self.controller._event({'run_id': 'foreign', 'phase': 'failed'})
        self.assertAlmostEqual(state.valence, before + .1)

    def test_actual_question_callback_and_answer_release_body_wait(self):
        def work(session, prompt, options):
            if not options.get('ask_user_result'):
                yield from session.use(options, 'ask_user', {'questions': [{'id': 'choice', 'question': 'Which output?'}]})
            yield from chat(session, prompt, options)
        self.controller.session_factory_override = lambda definitions: FakeSession(work)
        job = self.controller.submit_job('Report', 'Read my notes', 'Summarize the notes')
        deadline = time.monotonic() + 3
        while self.server.registry.focus()['state'] != 'awaiting_input' and time.monotonic() < deadline:
            time.sleep(.005)
        self.assertEqual(self.server.registry.focus()['state'], 'awaiting_input')
        card = self.controller.interactions.list()[0]
        self.assertEqual(card['expires_at'], 0)
        receipt = self.controller.interactions.respond(card['request_id'], card['revision'], {'choice': ['Report']})
        self.assertFalse(receipt['resume_required'])
        deadline = time.monotonic() + 3
        while self.controller.jobs.store.get(job['job_id'])['state'] != 'needs_review' and time.monotonic() < deadline:
            time.sleep(.005)
        self.controller.refresh_presentation()
        self.assertNotEqual(self.server.registry.focus()['state'], 'awaiting_input')
        self.assertEqual(self.controller.interactions.get(card['request_id'])['state'], 'resumed')

    def test_role_wait_is_immediate_and_not_masked_by_busy_or_typing(self):
        from observation.spatial import Spatial
        from test_spatial import situation
        now = [1000.0]
        state = situation(session='role:work', state='awaiting_input', speaking=True, typing=True, window_id=None)
        sent = []
        spatial = Spatial(lambda: dict(state), lambda kind, data: sent.append((kind, data)),
                          lambda: 1, 7, clock=lambda: now[0])
        spatial.poll()
        behavior = next(data for kind, data in sent if kind == 'behavior')
        self.assertEqual((behavior['type'], behavior['target']), ('listen', {'kind': 'user'}))
        self.assertEqual(behavior['channels'], ['eyes', 'head'])
        state.update(state='thinking', speaking=False, typing=False)
        now[0] += .5
        spatial.poll()
        self.assertNotIn(behavior['behavior_id'], spatial.active)
        self.assertTrue(any(kind == 'behavior' and data.get('replaces') == behavior['behavior_id'] or
                            kind == 'behavior_cancel' and data['behavior_id'] == behavior['behavior_id']
                            for kind, data in sent))


if __name__ == '__main__':
    unittest.main()
