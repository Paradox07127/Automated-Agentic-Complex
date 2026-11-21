"""Live item display and final-only speech/history through the product delivery path."""
import asyncio
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from brain.egress import EgressPolicy
from brain.provider import Mouth
from character_agent.harness.codex_runner import CodexRunner
from character_agent.routes.http import route
from character_agent.integration import CharacterAgentController
from personal.history import History
from personal.memory import Memory
from daemon.agentd_server import AgentdServer
from api.handler import Handler
from infra.store import open_store
from sessions.tasks import TaskLedger
from support import enable_plugins
from test_character_agent_runtime import FakeSession
from test_run_items import item
import test_server


def text_item(ident, text, phase='final', kind='assistant_text'):
    fields = {'item_id': ident, 'kind': kind, 'phase': phase}
    yield {'type': 'item', **fields, 'status': 'started'}
    for part in text:
        yield {'type': 'text_delta' if kind == 'assistant_text' else 'item',
               **fields, 'status': 'delta', 'text': part}
    yield {'type': 'item', **fields, 'status': 'completed'}


class AgentItemStreamTests(unittest.TestCase):
    def setUp(self):
        enable_plugins(self, "personal_agent", "harness_bridge")
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        with patch('daemon.agentd_server.ThreadingHTTPServer.__init__', return_value=None):
            self.server = AgentdServer(('127.0.0.1', 0), 'fixture-hook', 'fixture-ui')
        self.addCleanup(self.stop_server)
        self.db = open_store(root / 'domain.sqlite')
        self.addCleanup(self.db.close)
        s = self.server
        lock = threading.RLock()
        s.history, s.memory, s.tasks = History(self.db, lock=lock), Memory(self.db, lock=lock), TaskLedger(self.db, lock=lock)
        s.egress = EgressPolicy()
        s.mouth = Mouth(egress=s.egress)
        s.speech = test_server.FakeRelay()
        self.frames = []
        self.controller = s.character_agent = CharacterAgentController(s, root, session_factory=self.factory)
        self.addCleanup(self.controller.workspace.close)
        self.addCleanup(self.controller.store.close)
        self.addCleanup(self.controller.close)
        self.controller.discovery = SimpleNamespace(scan=lambda refresh=False: {'runtimes': [], 'scanned_at': 0})
        self.controller.configure({'backend': 'pi', 'runtime_source': 'bundled'})

    def stop_server(self):
        self.server._stopped.set()
        self.server._ticker.join(2)

    def factory(self, definitions):
        return FakeSession(lambda *args: iter(self.frames))

    def deliver(self, remember=True):
        s = self.server
        cancel = threading.Event()
        trace = s._open_trace('run', s.turn_generation, 'text', 'Question', remember=remember)
        s._run_character_line('run', 'Question', cancel, s.turn_generation, trace=trace, remember=remember)

    def events(self, kind):
        return [e['data'] for e in self.server.feed.since(0) if e['event'] == kind]

    def assert_item_text(self):
        frames = self.events('agent_item')
        self.assertTrue(frames, 'normalized items never reached the feed')
        rows = self.controller.store.items('run')
        for row in rows:
            published = [e for e in frames if e['item_id'] == row['item_id']]
            self.assertEqual(''.join(e.get('text_delta', '') for e in published), row['text'])
            self.assertTrue(all(e['item_seq'] == row['seq'] for e in published))
            self.assertTrue(all(e['run_id'] == 'run' and e['conversation_id'] ==
                                self.controller.store.get('run')['conversation_id'] for e in published))
            self.assertTrue(all({'kind', 'phase', 'status', 'name', 'summary', 'parent_item_id'} <= e.keys()
                                for e in published))
            self.assertTrue(all('text_delta' not in e for e in published if e['status'] != 'delta' or
                                e['kind'] not in ('assistant_text', 'reasoning_summary')))
            self.assertEqual(published[-1]['status'], row['status'])
        return rows

    def assert_final_delivery(self, final_id):
        rows = self.assert_item_text()
        final = next(r for r in rows if r['item_id'] == final_id)
        self.assertEqual(final['text'], 'Done')
        said = 'Checking\n\nDone'  # the commentary before the final answer is said first, once
        lines = self.events('line')
        self.assertEqual(''.join(e['text_delta'] for e in lines), said)
        self.assertEqual(lines[-1]['final_item_id'], final_id)
        self.assertEqual([turn[1]['content'] for turn in self.server.mouth.history], [said])
        history = self.server.history.export()
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]['reply'], said)
        self.assertEqual(''.join(c[2] for c in self.server.speech.calls if c[0] == 'speak').count('Done'), 1)

    def test_first_delta_is_visible_before_run_ends_even_without_remembering(self):
        blocked, release = threading.Event(), threading.Event()
        def frames():
            yield {'type': 'text_delta', 'item_id': 'answer', 'kind': 'assistant_text',
                   'status': 'delta', 'text': 'Live'}
            blocked.set()
            release.wait(3)
            yield {'type': 'item', 'item_id': 'answer', 'kind': 'assistant_text', 'status': 'completed'}
            yield {'type': 'result', 'success': True, 'final_text': 'Live'}
        self.frames = frames()
        worker = threading.Thread(target=lambda: self.deliver(remember=False), daemon=True)
        worker.start()
        try:
            self.assertTrue(blocked.wait(2))
            self.assertEqual([e['text_delta'] for e in self.events('agent_item') if e['status'] == 'delta'], ['Live'])
            self.assertEqual(self.events('line'), [])
        finally:
            release.set()
            worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(self.server.history.export(), [])
        self.assertEqual(self.controller.store.items('run'), [])

    def held_answer(self, first, rest, final_text):
        """Delivers a run whose final answer sends first, then waits for the returned release before rest."""
        blocked, release = threading.Event(), threading.Event()
        fields = {'item_id': 'answer', 'kind': 'assistant_text', 'phase': 'final'}
        def frames():
            yield {'type': 'item', **fields, 'status': 'started'}
            yield {'type': 'text_delta', **fields, 'status': 'delta', 'text': first}
            blocked.set()
            release.wait(5)
            for part in rest:
                yield {'type': 'text_delta', **fields, 'status': 'delta', 'text': part}
            yield {'type': 'item', **fields, 'status': 'completed'}
            yield {'type': 'result', 'success': True, 'final_text': final_text}
        self.frames = frames()
        worker = threading.Thread(target=self.deliver, daemon=True)
        worker.start()
        self.addCleanup(worker.join, 5)
        self.addCleanup(release.set)
        self.assertTrue(blocked.wait(2))
        return release, worker

    def wait_lines(self, predicate, seconds=1.0):
        deadline = time.monotonic() + seconds
        while not predicate(self.events('line')) and time.monotonic() < deadline:
            time.sleep(0.01)
        return self.events('line')

    def test_first_answer_delta_reaches_line_and_speech_before_the_run_ends(self):
        release, worker = self.held_answer('我先说第一句。', ['然后再说第二句。'], '我先说第一句。然后再说第二句。')
        lines = self.wait_lines(lambda lines: lines)
        self.assertEqual([e['text_delta'] for e in lines], ['我先说第一句。'])
        self.assertTrue(lines[0]['speak'])
        self.assertFalse(lines[0]['final'])
        spoken = lambda: [c for c in self.server.speech.calls if c[0] == 'speak']
        deadline = time.monotonic() + 1
        while not spoken() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(spoken(), [('speak', 'run', '我先说第一句。')])
        release.set()
        worker.join(5)
        self.assertFalse(worker.is_alive())
        lines = self.events('line')
        self.assertEqual(''.join(e['text_delta'] for e in lines), '我先说第一句。然后再说第二句。')
        self.assertEqual(lines[-1]['final_item_id'], 'answer')
        self.assertIsNone(lines[-1]['error'])
        self.assertEqual([c for c in self.server.speech.calls if c[0] == 'speak'],
                         [('speak', 'run', '我先说第一句。'), ('speak', 'run', '然后再说第二句。')])
        self.assertEqual([turn[1]['content'] for turn in self.server.mouth.history], ['我先说第一句。然后再说第二句。'])
        self.assertEqual(self.server.history.export()[0]['reply'], '我先说第一句。然后再说第二句。')

    def test_commentary_before_a_tool_reaches_the_line_before_the_final_answer(self):
        self.assertEqual(self.commentary_then_answer('做完告诉你。'), '好，我交给后台去做。\n\n做完告诉你。')

    def test_an_answer_that_starts_with_a_newline_is_one_blank_line_after_the_commentary(self):
        self.assertEqual(self.commentary_then_answer('\n做完告诉你。'), '好，我交给后台去做。\n\n做完告诉你。')

    def commentary_then_answer(self, text):
        """The line's text when a commentary item, then a final answer item of `text`, stream."""
        blocked, release = threading.Event(), threading.Event()
        comment = {'item_id': 'comment', 'kind': 'assistant_text', 'phase': 'commentary'}
        answer = {'item_id': 'answer', 'kind': 'assistant_text', 'phase': 'final'}
        def frames():
            yield {'type': 'item', **comment, 'status': 'started'}
            yield {'type': 'text_delta', **comment, 'status': 'delta', 'text': '好，我交给后台去做。'}
            yield {'type': 'item', **comment, 'status': 'completed'}
            blocked.set()
            release.wait(5)
            yield {'type': 'item', **answer, 'status': 'started'}
            yield {'type': 'text_delta', **answer, 'status': 'delta', 'text': text}
            yield {'type': 'item', **answer, 'status': 'completed'}
            yield {'type': 'result', 'success': True, 'final_text': text}
        self.frames = frames()
        worker = threading.Thread(target=self.deliver, daemon=True)
        worker.start()
        self.addCleanup(worker.join, 5)
        self.addCleanup(release.set)
        self.assertTrue(blocked.wait(2))
        self.assertEqual([e['text_delta'] for e in self.wait_lines(lambda lines: lines)], ['好，我交给后台去做。'])
        release.set()
        worker.join(5)
        said = ''.join(e['text_delta'] for e in self.events('line'))
        self.assertEqual(self.server.history.export()[0]['reply'], said)
        return said

    def test_final_text_with_a_prefix_adds_only_the_prefix_to_the_streamed_line(self):
        note = '（产物检查没通过，这项任务不算完成，检查结果在任务卡里。）'
        release, worker = self.held_answer('报告', ['写好了。'], note + '\n\n报告写好了。')
        self.assertEqual([e['text_delta'] for e in self.wait_lines(lambda lines: lines)], ['报告'])
        release.set()
        worker.join(5)
        said = ''.join(e['text_delta'] for e in self.events('line'))
        self.assertEqual(said, '报告写好了。\n\n' + note)
        self.assertEqual(said.count('报告写好了。'), 1)
        spoken = ''.join(c[2] for c in self.server.speech.calls if c[0] == 'speak')
        self.assertEqual(spoken.count('报告写好了。'), 1)
        self.assertIn(note, spoken)
        self.assertEqual(self.server.mouth.history[-1][1]['content'], said)
        self.assertEqual(self.server.history.export()[0]['reply'], said)

    def test_each_streamed_delta_has_its_markers_taken_out_before_it_is_shown(self):
        release, worker = self.held_answer('[intent:greet]你好。', ['[intent:explain]我看看。'],
                                           '[intent:greet]你好。[intent:explain]我看看。')
        lines = self.wait_lines(lambda lines: lines)
        self.assertEqual([(e['text_delta'], e['intents']) for e in lines], [('你好。', ['greet'])])
        release.set()
        worker.join(5)
        lines = [e for e in self.events('line') if e['text_delta'] or e['intents']]
        self.assertEqual([(e['text_delta'], e['intents']) for e in lines], [('你好。', ['greet']), ('我看看。', ['explain'])])
        self.assertNotIn('[', ''.join(c[2] for c in self.server.speech.calls if c[0] == 'speak'))
        self.assertEqual(self.server.history.export()[0]['reply'], '你好。我看看。')

    def test_temporary_interrupted_run_publishes_items_without_persisting_edges_or_flush(self):
        blocked, release = threading.Event(), threading.Event()
        def frames():
            yield {'type': 'item', 'item_id': 'answer', 'kind': 'assistant_text', 'status': 'started'}
            yield {'type': 'text_delta', 'item_id': 'answer', 'kind': 'assistant_text',
                   'status': 'delta', 'text': 'Private'}
            blocked.set()
            release.wait(3)
            yield {'type': 'result', 'success': True, 'final_text': 'Private'}
        self.frames = frames()
        worker = threading.Thread(target=lambda: self.deliver(remember=False), daemon=True)
        with patch.object(self.controller.store, 'item', wraps=self.controller.store.item) as persist:
            worker.start()
            try:
                self.assertTrue(blocked.wait(2))
                self.controller.runtime.cancel('client_cancel', interrupted=True)
            finally:
                release.set()
                worker.join(3)
            self.assertFalse(worker.is_alive())
            self.assertEqual(self.controller.store.get('run')['state'], 'interrupted')
            self.assertEqual(''.join(e.get('text_delta', '') for e in self.events('agent_item')), 'Private')
            self.assertEqual(self.controller.store.items('run'), [])
            persist.assert_not_called()

    def test_fact_deletion_redacts_completed_run_items_and_items_route(self):
        fact = self.server.memory.add('Private preference', 'asserted_by_user', kind='preference')
        self.frames = [*text_item('answer', ['Private answer']),
                       {'type': 'result', 'success': True, 'final_text': 'Private answer'}]
        self.deliver()
        store = self.controller.store
        self.assertIn(fact, [d['id'] for d in store.get('run')['dependencies']])
        store.item(item('tool', 5, kind='tool_call', status='completed', summary='Private summary'))
        store.begin('older', 'conversation', 'character', 1)
        store.finish('older', 'completed', dependencies=store.get('run')['dependencies'])
        store.item(item(run_id='older', summary='Private summary'))
        store.begin('other', 'conversation', 'character', 1)
        store.item(item(run_id='other', summary='Unrelated summary'))
        before = {run: store.items(run) for run in ('run', 'older', 'other')}
        replies = []
        handler = Handler.__new__(Handler)
        handler.server = self.server
        handler._json = lambda status, data: replies.append((status, data))
        handler.path = '/memory/facts/' + fact + '?expected_version=1'
        handler._memory_delete(SimpleNamespace(group=lambda _: fact))
        self.assertEqual(replies[-1], (200, {'deleted': True}))
        for run in ('run', 'older'):
            self.assertEqual(store.items(run), [{**row, 'text': '', 'summary': None} for row in before[run]])
        self.assertEqual(store.items('other'), before['other'])
        handler._auth = lambda _: True
        self.assertTrue(route(handler, 'GET', '/agent/runs/run/items'))
        self.assertEqual(replies[-1][0], 200)
        self.assertNotIn('Private', json.dumps(replies[-1][1]))

    def test_fact_deletion_during_run_prevents_final_flush_restoring_item_content(self):
        fact = self.server.memory.add('Private preference', 'asserted_by_user', kind='preference')
        blocked, release = threading.Event(), threading.Event()
        def frames():
            yield {'type': 'item', 'item_id': 'answer', 'kind': 'assistant_text',
                   'status': 'started', 'summary': 'Private summary'}
            yield {'type': 'text_delta', 'item_id': 'answer', 'kind': 'assistant_text',
                   'status': 'delta', 'text': 'Private answer'}
            blocked.set()
            release.wait(3)
            yield {'type': 'result', 'success': True, 'final_text': 'Private answer'}
        self.frames = frames()
        worker = threading.Thread(target=self.deliver, daemon=True)
        worker.start()
        try:
            self.assertTrue(blocked.wait(2))
            self.assertEqual(self.controller.store.get('run')['dependencies'], [])
            replies = []
            handler = Handler.__new__(Handler)
            handler.server = self.server
            handler._json = lambda status, data: replies.append((status, data))
            handler.path = '/memory/facts/' + fact + '?expected_version=1'
            handler._memory_delete(SimpleNamespace(group=lambda _: fact))
            self.assertEqual(replies[-1], (200, {'deleted': True}))
        finally:
            release.set()
            worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(self.controller.store.get('run')['state'], 'interrupted')
        [row] = self.controller.store.items('run')
        self.assertEqual((row['kind'], row['status'], row['seq']), ('assistant_text', 'delta', 1))
        self.assertEqual((row['text'], row['summary']), ('', None))

    def test_context_kind_redacts_only_affected_run_items_and_late_writes(self):
        store = self.controller.store
        for run in ('page-run', 'other-run'):
            store.begin(run, 'conversation', 'character', 1)
            store.item(item(run_id=run, summary='Private summary'))
        self.server._line_context[threading.Event()] = ('page-run', {'page'})
        self.controller.cancel('context_changed', context_kind='page')
        [row] = store.items('page-run')
        self.assertEqual((row['text'], row['summary']), ('', None))
        store.item(item(run_id='page-run', status='completed', summary='Private summary'))
        store.item(item('late', 2, run_id='page-run', summary='Private summary'))
        self.assertTrue(all(r['text'] == '' and r['summary'] is None for r in store.items('page-run')))
        self.assertEqual(store.items('page-run')[0]['status'], 'completed')
        self.assertEqual(store.items('other-run')[0]['text'], 'Hello')

    def test_codex_items_match_storage_and_only_final_is_delivered_once(self):
        async def collect():
            runner = CodexRunner()
            runner.active = {'id': 'run', 'cancelled': False}
            runner.thread_id = 'thread'
            frames, queue = [], asyncio.Queue()
            async def request(*args, **kwargs): return {'turn': {'id': 'turn'}}
            runner.client = SimpleNamespace(request=request, events=queue)
            runner.emit = frames.append
            for ident, kind, phase, text in (('comment', 'agentMessage', 'commentary', 'Checking'),
                                             ('reason', 'reasoning', None, 'Summary'),
                                             ('answer', 'agentMessage', 'final_answer', 'Done')):
                value = {'id': ident, 'type': kind, 'phase': phase}
                queue.put_nowait({'method': 'item/started', 'params': {'item': value}})
                method = 'item/reasoning/summaryTextDelta' if kind == 'reasoning' else 'item/agentMessage/delta'
                for part in (text[:2], text[2:]):
                    queue.put_nowait({'method': method, 'params': {'itemId': ident, 'delta': part}})
                queue.put_nowait({'method': 'item/completed', 'params': {'item': {**value, 'text': text}}})
            queue.put_nowait({'method': 'turn/completed', 'params': {'turn': {'id': 'turn', 'status': 'completed'}}})
            await runner.run({'prompt': 'Question'})
            return frames
        self.frames = asyncio.run(collect())
        self.deliver()
        self.assert_final_delivery('answer')

    def codex_plan_frames(self, plans):
        async def collect():
            runner = CodexRunner()
            runner.active = {'id': 'run', 'cancelled': False}
            runner.thread_id = 'thread'
            frames, queue = [], asyncio.Queue()
            async def request(*args, **kwargs): return {'turn': {'id': 'turn'}}
            runner.client = SimpleNamespace(request=request, events=queue)
            runner.emit = frames.append
            for params in plans:
                queue.put_nowait({'method': 'turn/plan/updated', 'params': {'threadId': 'thread', **params}})
            queue.put_nowait({'method': 'turn/completed', 'params': {'turn': {'id': 'turn', 'status': 'completed'}}})
            await runner.run({'prompt': 'Question'})
            return frames
        return asyncio.run(collect())

    def test_codex_plan_revisions_map_statuses_and_ignore_other_turns(self):
        self.frames = self.codex_plan_frames([
            {'turnId': 'turn', 'explanation': 'Make a report', 'plan': [
                {'step': 'Read', 'status': 'inProgress'}, {'step': 'Write', 'status': 'pending'}]},
            {'turnId': 'turn', 'explanation': None, 'plan': [
                {'step': 'Read', 'status': 'completed'}, {'step': 'Write', 'status': 'inProgress'}]},
            {'turnId': 'other', 'explanation': 'Unrelated', 'plan': []}])
        self.deliver()
        plans = self.events('plan')
        self.assertEqual(len(plans), 2)
        conversation = self.controller.store.get('run')['conversation_id']
        for revision, (title, statuses) in enumerate((('Make a report', ['in_progress', 'pending']),
                                                     (None, ['completed', 'in_progress'])), 1):
            self.assertEqual({k: v for k, v in plans[revision - 1].items() if k not in ('seq', 'at')}, {
                'run_id': 'run', 'conversation_id': conversation, 'revision': revision, 'title': title,
                'steps': [{'text': text, 'status': status} for text, status in zip(('Read', 'Write'), statuses)],
                'status': 'in_progress', 'source': 'codex', 'work_kind': 'foreground', 'generation': 0})
        self.assertEqual(self.events('agent_item'), [])
        self.assertTrue(self.events('agent_run'))

    def test_codex_completed_and_empty_plans_have_distinct_statuses(self):
        self.frames = self.codex_plan_frames([
            {'turnId': 'turn', 'explanation': None, 'plan': [{'step': 'Read', 'status': 'completed'}]},
            {'turnId': 'turn', 'explanation': None, 'plan': []}])
        self.deliver()
        self.assertEqual([p['status'] for p in self.events('plan')], ['completed', 'in_progress'])
        self.assertEqual(self.events('plan')[-1]['steps'], [])

    def test_codex_plan_without_explanation_has_no_title(self):
        # TurnPlanUpdatedNotification requires only threadId, turnId and plan.
        self.frames = self.codex_plan_frames([{'turnId': 'turn', 'plan': [{'step': 'Read', 'status': 'pending'}]}])
        self.deliver()
        self.assertEqual([(p['title'], p['steps']) for p in self.events('plan')],
                         [(None, [{'text': 'Read', 'status': 'pending'}])])

    def test_plan_revisions_update_one_summary_only_item(self):
        self.frames = [
            {'type': 'plan', 'title': 'First', 'steps': [{'text': 'Read', 'status': 'pending'}], 'source': 'codex'},
            {'type': 'plan', 'title': 'Second', 'steps': [{'text': 'Read', 'status': 'completed'},
                {'text': 'Write', 'status': 'in_progress'}], 'source': 'codex'},
            {'type': 'result', 'success': True, 'final_text': 'Done'}]
        self.deliver()
        rows = self.controller.store.items('run')
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]['kind'], rows[0]['summary'], rows[0]['text']), ('plan', 'Read\nWrite', ''))
        self.assertEqual(rows[0]['status'], 'in_progress')
        self.assertEqual([p['revision'] for p in self.events('plan')], [1, 2])
        self.assertEqual(self.events('agent_item'), [])

    def test_temporary_plan_revisions_publish_without_item_writes(self):
        self.frames = [{'type': 'plan', 'title': None, 'steps': [], 'source': 'codex'}] * 2
        self.frames += [{'type': 'result', 'success': True, 'final_text': 'Done'}]
        with patch.object(self.controller.store, 'item', wraps=self.controller.store.item) as persist:
            self.deliver(remember=False)
        self.assertEqual([p['revision'] for p in self.events('plan')], [1, 2])
        self.assertEqual(self.controller.store.items('run'), [])
        persist.assert_not_called()

    def test_plan_steps_and_item_summary_are_bounded(self):
        self.frames = self.codex_plan_frames([{'turnId': 'turn', 'explanation': 'Large',
            'plan': [{'step': '界' * 300, 'status': 'inProgress'} for _ in range(40)]}])
        self.deliver()
        plans = self.events('plan')
        self.assertEqual(len(plans), 1)
        self.assertEqual(plans[0]['steps'], [{'text': '界' * 200, 'status': 'in_progress'}] * 32)
        [row] = self.controller.store.items('run')
        self.assertEqual((row['summary'], row['text']), ('界' * 200, ''))

    def test_task_plan_outputs_publish_only_for_accepted_calls(self):
        def script(session, prompt, options):
            yield from session.use(options, 'task_plan', {'title': 'Report', 'outputs': ['a.md', 'b.md']})
            yield from session.use(options, 'task_plan', {'title': 'Invalid', 'outputs': 'a.md'})
            yield from session.use(options, 'task_plan', {'title': 'Changed', 'outputs': ['c.md']})
            yield {'type': 'result', 'success': True, 'final_text': 'Done'}
        session = FakeSession(script)
        self.controller.session_factory_override = lambda _: session
        root = Path(self.tmp.name)
        scope = self.controller.workspace.create_scope([str(root)], str(root / 'output'))['scope_id']
        runtime = self.controller._ensure_runtime()
        runtime.run(run_id='run', text='Report', system_prompt='Fixture', history=[], character_id='one',
                    generation=1, scope_id=scope)
        plans = self.events('plan')
        self.assertEqual(len(plans), 1)
        self.assertEqual({k: v for k, v in plans[0].items() if k not in ('seq', 'at')}, {
            'run_id': 'run', 'conversation_id': runtime.conversation_id, 'revision': 1, 'title': 'Report',
            'steps': [{'text': 'a.md', 'status': 'pending'}, {'text': 'b.md', 'status': 'pending'}],
            'status': 'in_progress', 'source': 'task_plan', 'work_kind': 'foreground', 'generation': 1})
        self.assertEqual([r[2] for r in session.responses], [
            {'task_id': 'character-run', 'outputs': ['a.md', 'b.md'], 'status': 'running'},
            {'error': {'code': 'invalid_task_plan'}}, {'error': {'code': 'goal_revision_required'}}])
        checkpoint = self.controller.store.load_checkpoint(run_id='run')
        self.assertEqual(checkpoint['planned_outputs'], ['a.md', 'b.md'])
        self.assertEqual(self.controller.store.items('run')[0]['summary'], 'a.md\nb.md')

    def test_task_plan_without_outputs_publishes_and_revisions_restart_each_run(self):
        def script(session, prompt, options):
            yield from session.use(options, 'task_plan', {'title': 'No scope', 'outputs': ['a.md']})
            yield from session.use(options, 'task_plan', {'title': 'Think', 'outputs': []})
            yield from session.use(options, 'task_plan', {'title': 'Review', 'outputs': []})
            yield {'type': 'result', 'success': True, 'final_text': 'Done'}
        self.controller.session_factory_override = lambda _: FakeSession(script)
        runtime = self.controller._ensure_runtime()
        for run in ('run', 'next'):
            runtime.run(run_id=run, text='Think', system_prompt='Fixture', history=[], character_id='one', generation=1)
        plans = self.events('plan')
        self.assertEqual([(p['run_id'], p['revision']) for p in plans], [('run', 1), ('run', 2), ('next', 1), ('next', 2)])
        self.assertEqual([p['title'] for p in plans], ['Think', 'Review'] * 2)
        self.assertTrue(all(p['steps'] == [] and p['status'] == 'in_progress' and p['source'] == 'task_plan' for p in plans))
        self.assertEqual(runtime._session.responses[0][2], {'error': {'code': 'scope_required'}})

    def test_redacted_plan_summary_stays_empty_after_later_revision(self):
        def frames():
            yield {'type': 'plan', 'title': None, 'steps': [{'text': 'Private', 'status': 'pending'}], 'source': 'codex'}
            self.controller.store.redact_items(['run'])
            yield {'type': 'plan', 'title': None, 'steps': [{'text': 'Private', 'status': 'completed'}], 'source': 'codex'}
            yield {'type': 'result', 'success': True, 'final_text': 'Done'}
        self.frames = frames()
        self.deliver()
        rows = self.controller.store.items('run')
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]['summary'], rows[0]['text'], rows[0]['status']), (None, '', 'completed'))
        self.assertEqual([p['revision'] for p in self.events('plan')], [1, 2])

    def test_fifty_deltas_in_one_window_are_coalesced_and_flushed_before_completed(self):
        self.frames = [*text_item('answer', ['x'] * 50), {'type': 'result', 'success': True, 'final_text': 'x' * 50}]
        with patch('character_agent.runtime.time.monotonic', return_value=10):
            self.deliver()
        self.assert_item_text()
        frames = [e for e in self.events('agent_item') if e['item_id'] == 'answer']
        deltas = [e for e in frames if e['status'] == 'delta']
        self.assertLessEqual(len(deltas), 2)
        self.assertEqual(''.join(e['text_delta'] for e in deltas), 'x' * 50)
        self.assertEqual([e['status'] for e in frames], ['started', 'delta', 'delta', 'completed'])

    def test_final_line_links_the_answer_item(self):
        self.frames = [*text_item('answer', ['Done']), {'type': 'result', 'success': True, 'final_text': 'Done'}]
        self.deliver()
        self.assertEqual(self.events('line')[-1].get('final_item_id'), 'answer')
        self.assertTrue(all('final_item_id' not in e for e in self.events('line')[:-1]))

    def test_final_line_has_null_identity_without_matching_item(self):
        self.frames = [{'type': 'text_delta', 'text': 'Done'}, {'type': 'result', 'success': True, 'final_text': 'Done'}]
        self.deliver()
        self.assertIn('final_item_id', self.events('line')[-1])
        self.assertIsNone(self.events('line')[-1]['final_item_id'])

    def test_result_without_final_text_says_commentary_once_then_the_answer(self):
        self.frames = [*text_item('comment', ['Checking'], phase='commentary'),
                       *text_item('answer', ['Done']), {'type': 'result', 'success': True}]
        self.deliver()
        self.assert_final_delivery('answer')

    def test_interrupted_item_flushes_all_received_text(self):
        def frames():
            yield {'type': 'text_delta', 'item_id': 'answer', 'kind': 'assistant_text', 'status': 'delta', 'text': 'One'}
            yield {'type': 'text_delta', 'item_id': 'answer', 'kind': 'assistant_text', 'status': 'delta', 'text': 'Two'}
            yield {'type': 'error', 'code': 'fixture_failed'}
        self.frames = frames()
        self.deliver()
        self.assert_item_text()
        self.assertEqual(self.controller.store.items('run')[0]['text'], 'OneTwo')
        self.assertEqual(self.server.mouth.history, [])

    def test_item_text_limit_preserves_utf8_and_matches_feed(self):
        self.frames = [*text_item('answer', ['界' * 21845, '界', 'ignored']),
                       {'type': 'result', 'success': True, 'final_text': 'Done'}]
        self.deliver()
        self.assert_item_text()
        self.assertEqual(self.controller.store.items('run')[0]['text'], '界' * 21845)


if __name__ == '__main__': unittest.main()
