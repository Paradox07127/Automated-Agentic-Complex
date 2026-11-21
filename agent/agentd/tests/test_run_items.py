"""Private normalized run items across both kernels and their data lifecycle."""
import asyncio
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from brain.egress import EgressPolicy
from character_agent.harness.codex_runner import CodexRunner
from character_agent.routes.http import route
from character_agent.services.knowledge import KnowledgeService
from character_agent.runtime import PersonalAgentRuntime
from character_agent.services.store import RunStore
from character_agent.harness.codex_transport import ManagedCodexSession
from character_agent.services.workspace import WorkspaceService


def item(ident='text', seq=1, **fields):
    return {'run_id': 'run', 'item_id': ident, 'seq': seq, 'kind': 'assistant_text',
            'phase': None, 'status': 'delta', 'text': 'Hello', 'name': None,
            'summary': None, 'parent_item_id': None, **fields}


class RunItemTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store = RunStore(self.root / 'runs.sqlite')
        self.addCleanup(self.store.close)
        self.store.begin('run', 'conversation', 'character', 1)

    def test_redaction_removes_question_checkpoints_and_fences_late_saves(self):
        data = {'task_id': None, 'goal': 'work', 'pending_tool': {'args': {'question': 'forgotten-material'}}}
        self.store.checkpoint('run', None, data)
        self.store.begin('other', 'conversation', 'character', 1)
        self.store.checkpoint('other', None, data)
        self.store.redact_items(['run'])
        self.assertIsNone(self.store.load_checkpoint(run_id='run'))
        self.assertIsNotNone(self.store.load_checkpoint(run_id='other'))
        self.assertFalse(self.store.checkpoint('run', None, data))

    def persist_frames(self, frames, *, cancelled=None, error=None):
        workspace = WorkspaceService(self.root / 'workspace', egress=EgressPolicy())
        self.addCleanup(workspace.close)
        session = SimpleNamespace(stream=lambda *a, **kw: iter(frames), close=lambda: None, interrupt=lambda: None)
        public = []
        runtime = PersonalAgentRuntime(self.root, lambda _: session,
            lambda: KnowledgeService(egress=EgressPolicy()), workspace,
            run_store=self.store, event_sink=public.append)
        self.addCleanup(runtime.close)
        self.store.forget()
        normalized = []
        original = self.store.item
        def record(value):
            normalized.append(value)
            return original(value)
        with patch.object(self.store, 'item', side_effect=record):
            reply = runtime.run(run_id='run', text='Synthetic', system_prompt='Fixture', history=[],
                                character_id='character', generation=1, cancelled=cancelled)
        self.assertEqual(reply.error, error)
        self.assertFalse(any('text_delta' in e for e in public if 'item_id' not in e))
        return normalized, self.store.items('run')

    def test_thousand_deltas_write_only_item_edges(self):
        frames = [{'type': 'item', 'item_id': 'answer', 'kind': 'assistant_text', 'status': 'started'}]
        frames.extend({'type': 'text_delta', 'item_id': 'answer', 'kind': 'assistant_text',
                       'status': 'delta', 'text': 'piece'} for _ in range(1000))
        frames.extend([{'type': 'item', 'item_id': 'answer', 'kind': 'assistant_text', 'status': 'completed'},
                       {'type': 'result', 'success': True}])
        writes, rows = self.persist_frames(frames)
        self.assertLessEqual(len(writes), 2)
        self.assertFalse(any(write['status'] == 'delta' for write in writes))
        self.assertEqual([write['status'] for write in writes], ['started', 'completed'])
        self.assertEqual([write['seq'] for write in writes], [1, 1])
        [row] = rows
        self.assertEqual(row['text'], 'piece' * 1000)
        self.assertEqual(row['status'], 'completed')

    def test_cancelled_open_item_flushes_received_text_and_latest_metadata(self):
        cancel = threading.Event()
        def frames():
            yield {'type': 'item', 'item_id': 'answer', 'kind': 'assistant_text',
                   'status': 'started', 'phase': 'commentary', 'name': 'first'}
            yield {'type': 'text_delta', 'item_id': 'answer', 'kind': 'assistant_text',
                   'status': 'delta', 'text': 'Received '}
            yield {'type': 'text_delta', 'item_id': 'answer', 'kind': 'assistant_text',
                   'status': 'delta', 'text': 'so far', 'phase': 'partial', 'name': 'latest',
                   'summary': 'current summary', 'parent_item_id': 'parent'}
            cancel.set()
            yield {'type': 'text_delta', 'item_id': 'answer', 'kind': 'assistant_text',
                   'status': 'delta', 'text': 'not received'}
        writes, rows = self.persist_frames(frames(), cancelled=cancel, error='cancelled')
        self.assertEqual(len(writes), 2)
        self.assertEqual([write['status'] for write in writes], ['started', 'delta'])
        self.assertEqual([write['seq'] for write in writes], [1, 1])
        [row] = rows
        self.assertEqual(row['text'], 'Received so far')
        self.assertEqual((row['phase'], row['status'], row['name'], row['summary'], row['parent_item_id']),
                         ('partial', 'delta', 'latest', 'current summary', 'parent'))

    def test_codex_stream_preserves_phases_reasoning_and_tool_summary(self):
        async def collect():
            runner = CodexRunner()
            runner.active = {'id': 'run', 'cancelled': False}
            runner.thread_id = 'thread'
            frames = []
            runner.emit = frames.append
            events = asyncio.Queue()
            async def request(*args, **kw): return {'turn': {'id': 'turn'}}
            runner.client = SimpleNamespace(request=request, events=events)
            entries = [('comment', 'agentMessage', 'commentary', 'Checking'),
                       ('reason', 'reasoning', None, 'Short summary'),
                       ('command', 'commandExecution', None, None),
                       ('answer', 'agentMessage', 'final_answer', 'Done')]
            for ident, kind, phase, text in entries:
                value = {'id': ident, 'type': kind, 'phase': phase, 'parentItemId': 'parent'}
                if kind == 'commandExecution': value.update(command='ls', aggregatedOutput='raw-private-output')
                await events.put({'method': 'item/started', 'params': {'item': value}})
                if kind == 'commandExecution':
                    await events.put({'method': 'item/commandExecution/outputDelta', 'params': {'itemId': ident, 'delta': 'raw-private-output'}})
                if text:
                    method = 'item/reasoning/summaryTextDelta' if kind == 'reasoning' else 'item/agentMessage/delta'
                    for part in (text[:2], text[2:]):
                        await events.put({'method': method, 'params': {'itemId': ident, 'delta': part}})
                await events.put({'method': 'item/completed', 'params': {'item': {**value, 'text': text}}})
            await events.put({'method': 'turn/completed', 'params': {'turn': {'id': 'turn', 'status': 'completed'}}})
            await runner.run({'prompt': 'Synthetic'})
            return frames
        frames = asyncio.run(collect())
        self.assertTrue(any(f.get('kind') == 'reasoning_summary' for f in frames), frames)
        normalized, rows = self.persist_frames(frames)
        self.assertEqual([r['kind'] for r in rows], ['assistant_text', 'reasoning_summary', 'tool_call', 'assistant_text'])
        self.assertEqual([r['phase'] for r in rows], ['commentary', None, None, 'final'])
        self.assertEqual([r['text'] for r in rows], ['Checking', 'Short summary', '', 'Done'])
        self.assertTrue(all(r['status'] == 'completed' and r['parent_item_id'] == 'parent' for r in rows))
        self.assertEqual([e['status'] for e in normalized if e['item_id'] == 'answer'], ['started', 'completed'])
        self.assertEqual([r['seq'] for r in rows], [1, 5, 9, 12])
        self.assertNotIn('raw-private-output', json.dumps(normalized) + json.dumps(rows))

    def test_codex_native_tool_and_question_keep_item_identity(self):
        async def collect():
            runner = CodexRunner()
            runner.active = {'id': 'run', 'cancelled': False}
            runner.thread_id, runner.turn_id = 'thread', 'turn'
            runner.allowed_names = {'lookup', 'ask_user'}
            frames = []
            runner.emit = frames.append
            for method, fields in (('item/tool/call', {'tool': 'lookup', 'callId': 'rpc-call', 'arguments': {}}),
                                   ('item/tool/requestUserInput', {'questions': [{'id': 'q', 'header': 'Choice', 'question': 'Which?'}]})):
                task = asyncio.create_task(runner.server_request(method, {'threadId': 'thread', 'turnId': 'turn', 'itemId': 'native-item', **fields}))
                await asyncio.sleep(0)
                call = frames[-1]['tool_call_id']
                runner.pending[call][1].set_result({'result': {'answers': {'q': ['A']}}})
                await task
            return frames
        frames = asyncio.run(collect())
        self.assertEqual([f['item_id'] for f in frames], ['native-item', 'native-item'])
        self.assertEqual([f['kind'] for f in frames], ['tool_call', 'question'])

    def test_store_upserts_caps_utf8_and_does_not_resurrect_forgotten_runs(self):
        self.store.item(item(status='started', text='', phase='commentary'))
        self.store.item(item(seq=2, text='界' * 30000, name='lookup', summary='s' * 300))
        self.store.item(item(seq=3, status='completed', phase='final', text='界' * 30000))
        [row] = self.store.items('run')
        self.assertEqual((row['seq'], row['phase'], row['status']), (1, 'final', 'completed'))
        self.assertLessEqual(len(row['text'].encode()), 65536)
        self.assertEqual(row['text'], '界' * (65536 // 3))
        self.assertEqual(row['summary'], 's' * 200)
        self.assertLessEqual(row['created_at'], row['updated_at'])
        self.store.forget()
        self.store.item(item())
        self.assertEqual(self.store.items('run'), [])

    def test_store_forget_by_run_conversation_and_all(self):
        self.store.begin('other', 'other-conversation', 'character', 1)
        for ident in ('run', 'other'): self.store.item(item(run_id=ident))
        self.store.forget_runs((), conversation_id='conversation')
        self.assertEqual(self.store.items('run'), [])
        self.assertEqual(len(self.store.items('other')), 1)
        self.store.forget_runs(['other'])
        self.assertEqual(self.store.items('other'), [])
        self.store.begin('last', 'conversation', 'character', 1)
        self.store.item(item(run_id='last'))
        self.store.forget()
        self.assertEqual(self.store.db.execute('SELECT COUNT(*) FROM character_run_items').fetchone()[0], 0)

    def test_old_database_migrates_and_expires_items_at_start_and_hourly(self):
        self.store.close()
        with sqlite3.connect(self.root / 'runs.sqlite') as db:
            db.execute('DROP TABLE IF EXISTS character_run_items')
        self.store = RunStore(self.root / 'runs.sqlite')
        self.addCleanup(self.store.close)
        self.assertEqual(self.store.items('run'), [])
        self.store.item(item())
        self.store.db.execute('UPDATE character_run_items SET updated_at=?', (time.time() - 31 * 86400,))
        self.store.db.commit()
        self.store.close()
        with patch('character_agent.services.store.threading.Timer') as timer:
            self.store = RunStore(self.root / 'runs.sqlite', retention=lambda: 30 * 86400)
            self.addCleanup(self.store.close)
            self.assertEqual(self.store.items('run'), [])
            self.store.item(item())
            self.store.db.execute('UPDATE character_run_items SET updated_at=?', (time.time() - 31 * 86400,))
            self.store.db.commit()
            delay, callback = timer.call_args.args
            self.assertEqual(delay, 3600)
            callback()
            self.assertEqual(self.store.items('run'), [])

    def test_items_follow_history_retention_keep_by_default_or_7d(self):
        self.store.close()
        with patch('character_agent.services.store.threading.Timer') as timer:
            self.store = RunStore(self.root / 'runs.sqlite')
            self.store.item(item())
            self.store.db.execute('UPDATE character_run_items SET updated_at=?', (time.time() - 400 * 86400,))
            self.store.db.commit()
            timer.call_args.args[1]()
            self.assertEqual(len(self.store.items('run')), 1)
            self.store.close()
            self.store = RunStore(self.root / 'runs.sqlite', retention=lambda: 7 * 86400)
            self.addCleanup(self.store.close)
            self.store.item(item('recent', 2))
            self.store.item(item('older', 3))
            self.store.db.execute("UPDATE character_run_items SET updated_at=? WHERE item_id='older'",
                                  (time.time() - 8 * 86400,))
            self.store.db.commit()
            timer.call_args.args[1]()
            self.assertEqual([r['item_id'] for r in self.store.items('run')], ['recent'])

    def test_files_route_lists_run_file_effects_or_unknown_run(self):
        replies = []
        files = [{'path': '/in/a.md', 'op': 'read', 'added': None, 'removed': None}]
        workspace = SimpleNamespace(run_files=lambda run_id: files if run_id == 'run' else [])
        handler = SimpleNamespace(server=SimpleNamespace(ui_token='ui', resetting=False, closing=False,
            character_agent=SimpleNamespace(store=self.store, workspace=workspace)), auth=lambda token: token == 'ui',
            json=lambda status, data: replies.append((status, data)))
        self.assertTrue(route(handler, 'GET', '/agent/runs/run/files'))
        self.assertEqual(replies[-1], (200, {'files': files}))
        self.assertTrue(route(handler, 'GET', '/agent/runs/missing/files'))
        self.assertEqual(replies[-1], (404, {'error': 'unknown_run'}))
        handler.auth = lambda _: False
        route(handler, 'GET', '/agent/runs/run/files')
        self.assertEqual(replies[-1][0], 401)

    def test_items_route_requires_ui_auth_and_returns_order_or_unknown_run(self):
        self.store.item(item('second', 4))
        self.store.item(item('first', 1))
        replies = []
        handler = SimpleNamespace(server=SimpleNamespace(ui_token='ui', resetting=False, closing=False,
            character_agent=SimpleNamespace(store=self.store)), auth=lambda token: token == 'ui',
            json=lambda status, data: replies.append((status, data)))
        self.assertTrue(route(handler, 'GET', '/agent/runs/run/items'))
        self.assertEqual(replies[-1][0], 200)
        self.assertEqual([r['item_id'] for r in replies[-1][1]['items']], ['first', 'second'])
        self.assertTrue(route(handler, 'GET', '/agent/runs/missing/items'))
        self.assertEqual(replies[-1], (404, {'error': 'unknown_run'}))
        handler.auth = lambda _: False
        route(handler, 'GET', '/agent/runs/run/items')
        self.assertEqual(replies[-1][0], 401)

    def test_transport_preserves_request_metadata_and_links_result_without_output(self):
        session = ManagedCodexSession(SimpleNamespace(), [{'name': 'lookup'}])
        session._active = {'id': 'run', 'cancelled': False, 'cancel_signal': None,
                           'handler': lambda *args: {'content': [{'text': 'raw-private-output'}]}}
        done = threading.Event()
        session._tool_result = lambda *args: done.set()
        session._dispatch_tool(None, 0, {'type': 'tool_request', 'run_id': 'run', 'tool_call_id': 'call',
            'name': 'lookup', 'args': {'q': 'fixture'}, 'item_id': 'call', 'kind': 'tool_call',
            'phase': 'commentary', 'status': 'started', 'parent_item_id': 'parent'})
        self.assertTrue(done.wait(2))
        frames = [session._events.get_nowait(), session._events.get_nowait()]
        self.assertEqual([f.get('item_id') for f in frames], ['call', 'call:result'])
        self.assertEqual([f.get('kind') for f in frames], ['tool_call', 'tool_result'])
        self.assertEqual(frames[0]['parent_item_id'], 'parent')
        self.assertEqual(frames[1]['parent_item_id'], 'call')
        self.assertEqual([f['phase'] for f in frames], ['commentary', 'commentary'])
        frames.append({'type': 'result', 'success': True})
        normalized, rows = self.persist_frames(frames)
        self.assertTrue(all(len(r['summary']) <= 200 for r in rows))
        self.assertNotIn('raw-private-output', json.dumps(normalized) + json.dumps(rows))


if __name__ == '__main__': unittest.main()
