"""Offline native-request and terminal-event regressions; no model calls."""
import asyncio
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_agent.harness.codex_runner import AppServer, CodexRunner
from character_agent.services.interactions import InteractionService
from character_agent.services.store import RunStore


class ProtocolFake(AppServer):
    def __init__(self, handler):
        super().__init__([], {}, '.', handler)
        self.writes = []
        self.requests = []

    async def write(self, message):
        self.writes.append(message)

    async def request(self, method, params=None, timeout=15):
        self.requests.append((method, params))
        return {'turn': {'id': 'turn'}} if method == 'turn/start' else {}


class NativeRequestTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.runner = CodexRunner()
        self.runner.thread_id, self.runner.turn_id = 'thread', 'turn'
        self.runner.active = {'id': 'run', 'cancelled': False}
        self.runner.allowed_names = {'ask_user'}
        self.events = []
        self.runner.emit = self.events.append
        self.client = self.runner.client = ProtocolFake(self.runner.server_request)
        self.params = {'threadId': 'thread', 'turnId': 'turn', 'itemId': 'question', 'isBlocking': True,
                       'questions': [{'id': 'q', 'header': 'Choice', 'question': 'Which?',
                                      'options': [{'label': 'A', 'description': 'First'}]}]}

    async def test_k10_resume_installs_structured_original_call_and_output(self):
        self.runner.model = 'model'
        await self.client.events.put({'method': 'turn/completed', 'params': {'turn': {'id': 'turn', 'status': 'completed'}}})
        await self.runner.run({'prompt': 'original-goal', 'ask_user_result': {
            'name': 'ask_user', 'tool_call_id': 'original-call',
            'args': {'questions': [{'id': 'q', 'question': 'private-question'}]},
            'result': {'answers': {'q': ['real-answer']}}}})
        method, params = self.client.requests[0]
        self.assertEqual(method, 'thread/inject_items')
        history = params['items']
        self.assertEqual(history[-2]['call_id'], 'original-call')
        self.assertEqual(history[-1], {'type': 'function_call_output', 'call_id': 'original-call',
            'output': '{"answers": {"q": ["real-answer"]}}'})
        self.assertNotIn('private-question', json.dumps([item for item in history if item.get('role') == 'user']))

    async def test_k10_timeout_explicitly_declines_request(self):
        self.runner.config['tool_timeout'] = .001
        await self.client.answer({'id': 19, 'method': 'item/tool/requestUserInput', 'params': self.params})
        self.assertEqual(self.client.writes, [{'id': 19, 'error': {
            'code': -32601, 'message': 'Agentic Complex denied this request'}}])
        self.assertEqual([method for method, _ in self.client.requests], ['turn/interrupt'])

    async def test_native_request_reaches_ask_user(self):
        task = asyncio.create_task(self.client.answer({'id': 10, 'method': 'item/tool/requestUserInput', 'params': self.params}))
        await asyncio.sleep(0)
        self.assertEqual([e['name'] for e in self.events], ['ask_user'], self.client.writes)
        call = self.events[0]['tool_call_id']
        self.runner.pending[call][1].set_result({'result': {'answers': {'q': ['A']}}})
        await task
        self.assertEqual(self.client.writes, [{'id': 10, 'result': {'answers': {'q': {'answers': ['A']}}}}])

    async def dynamic_tool_reply(self, ident):
        self.runner.allowed_names.add('look')
        task = asyncio.create_task(self.client.answer({'id': ident, 'method': 'item/tool/call', 'params': {
            'threadId': 'thread', 'turnId': 'turn', 'callId': 'call-' + str(ident), 'itemId': 'item',
            'tool': 'look', 'arguments': {}}}))
        await asyncio.sleep(0)
        self.runner.pending['call-' + str(ident)][1].set_result(
            {'result': {'content': [{'type': 'text', 'text': 'a red door'}]}})
        await task
        return self.client.writes.pop()

    async def test_tool_reminder_closes_each_dynamic_tool_result(self):
        self.runner.config['tool_reminder'] = 'Stay in character.'
        self.assertEqual(await self.dynamic_tool_reply(30), {'id': 30, 'result': {'success': True, 'contentItems': [
            {'type': 'inputText', 'text': 'a red door'}, {'type': 'inputText', 'text': '\n\nStay in character.'}]}})

    async def test_no_tool_reminder_leaves_the_dynamic_tool_result_alone(self):
        self.runner.config['tool_reminder'] = None
        self.assertEqual(await self.dynamic_tool_reply(31), {'id': 31, 'result': {'success': True, 'contentItems': [
            {'type': 'inputText', 'text': 'a red door'}]}})

    async def approval(self, ident, method, params, option_id):
        task = asyncio.create_task(self.client.answer({'id': ident, 'method': method, 'params': {
            'threadId': 'thread', 'turnId': 'turn', 'itemId': 'item', 'startedAtMs': 0, **params}}))
        await asyncio.sleep(0)
        [frame] = [event for event in self.events if event['type'] == 'permission_request']
        self.assertEqual(frame['run_id'], 'run')
        self.assertEqual([option['option_id'] for option in frame['options']], ['allow_once', 'reject_once'])
        self.runner._accept({'type': 'permission_result', 'run_id': 'run', 'request_id': frame['request_id'],
                             'option_id': option_id})
        await task
        self.events.clear()
        return frame, self.client.writes.pop()

    async def test_native_approvals_reach_the_user_card(self):
        self.runner.config['native_tools'] = True
        frame, reply = await self.approval(20, 'item/commandExecution/requestApproval',
                                           {'command': 'touch x.txt', 'cwd': '/work'}, 'allow_once')
        self.assertEqual((frame['title'], frame['kind'], frame['locations']), ('touch x.txt', 'execute', ['/work']))
        self.assertEqual(reply, {'id': 20, 'result': {'decision': 'accept'}})
        _, reply = await self.approval(21, 'item/fileChange/requestApproval', {'reason': 'edit'}, 'reject_once')
        self.assertEqual(reply, {'id': 21, 'result': {'decision': 'decline'}})
        grant = {'network': {'enabled': True}}
        _, reply = await self.approval(22, 'item/permissions/requestApproval',
                                       {'cwd': '/work', 'permissions': grant}, 'allow_once')
        self.assertEqual(reply, {'id': 22, 'result': {'permissions': grant, 'scope': 'turn'}})
        _, reply = await self.approval(23, 'item/permissions/requestApproval',
                                       {'cwd': '/work', 'permissions': grant}, None)
        self.assertEqual(reply, {'id': 23, 'result': {'permissions': {}, 'scope': 'turn'}})

    async def test_a_large_approval_reaches_the_card_cut_with_its_command_whole(self):
        self.runner.config['native_tools'] = True
        frame, reply = await self.approval(26, 'item/commandExecution/requestApproval',
                                           {'reason': '中' * 50000, 'command': 'touch x.txt', 'cwd': '/work'}, 'allow_once')
        preview = frame['raw_input']
        self.assertLessEqual(len(json.dumps(preview, ensure_ascii=False)), 30000)
        self.assertEqual((preview['truncated'], preview['command'], preview['cwd']), (True, 'touch x.txt', '/work'))
        self.assertTrue(preview['reason'].startswith('中'))
        self.assertEqual(reply, {'id': 26, 'result': {'decision': 'accept'}})

    async def test_unanswered_native_approval_declines(self):
        self.runner.config.update(native_tools=True, permission_timeout=.01)
        await self.client.answer({'id': 24, 'method': 'item/commandExecution/requestApproval', 'params': {
            'threadId': 'thread', 'turnId': 'turn', 'itemId': 'item', 'startedAtMs': 0, 'command': 'ls'}})
        self.assertEqual([event['type'] for event in self.events], ['permission_request'])
        self.assertEqual(self.client.writes, [{'id': 24, 'result': {'decision': 'decline'}}])

    async def test_semantic_tasks_decline_approvals_without_asking(self):
        await self.client.answer({'id': 25, 'method': 'item/commandExecution/requestApproval', 'params': {
            'threadId': 'thread', 'turnId': 'turn', 'itemId': 'item', 'startedAtMs': 0, 'command': 'ls'}})
        self.assertFalse(self.events)
        self.assertEqual(self.client.writes, [{'id': 25, 'result': {'decision': 'decline'}}])

    async def pending_question(self, cancel=False, blocking=True):
        with tempfile.TemporaryDirectory() as tmp:
            store = RunStore(Path(tmp) / 'runs.sqlite')
            service = InteractionService(store, wait_seconds=.03)
            self.runner.config['tool_timeout'] = .02 if not cancel else 1
            self.params['isBlocking'] = blocking
            task = asyncio.create_task(self.client.answer({'id': 11, 'method': 'item/tool/requestUserInput', 'params': self.params}))
            await asyncio.sleep(0)
            self.assertEqual(self.events[0]['name'], 'ask_user')
            run = self.runner.active
            def ask():
                try:
                    service.ask('run', self.events[0]['args']['questions'],
                                valid=lambda: not run['cancelled'], character_id='one')
                except ValueError:
                    pass
            worker = asyncio.create_task(asyncio.to_thread(ask))
            for _ in range(100):
                if service.list(): break
                await asyncio.sleep(.001)
            self.assertEqual(len(service.list()), 1)
            if cancel:
                await self.runner.interrupt('run')
            await task
            await worker
            try:
                self.assertEqual([m for m, _ in self.client.requests], ['turn/interrupt'] if blocking else [])
                self.assertEqual(self.client.writes, [{'id': 11, 'error': {
                    'code': -32601, 'message': 'Agentic Complex denied this request'}}])
                [card] = service.list()
                answered = service.respond(card['request_id'], card['revision'], {'q': ['A']})
                self.assertTrue(answered['resume_required'])
                self.assertEqual(service.claim(card['request_id'], answered['revision'])['answer'], {'answers': {'q': ['A']}})
            finally:
                service.close(); store.close()

    async def test_cancel_interrupts_without_answer_and_card_can_resume(self):
        await self.pending_question(cancel=True)

    async def test_timeout_interrupts_without_answer_and_card_can_resume(self):
        await self.pending_question()

    async def test_nonblocking_timeout_does_not_interrupt(self):
        await self.pending_question(blocking=False)

    async def test_scope_guards_reject_native_questions(self):
        for ident, case in enumerate(('thread', 'turn', 'tool', 'inactive', 'cancelled'), 12):
            with self.subTest(case=case):
                self.runner.allowed_names = set() if case == 'tool' else {'ask_user'}
                self.runner.active = None if case == 'inactive' else {'id': 'run', 'cancelled': case == 'cancelled'}
                params = {**self.params, **({'threadId': 'other'} if case == 'thread' else
                                           {'turnId': 'other'} if case == 'turn' else {})}
                self.client.writes.clear()
                await self.client.answer({'id': ident, 'method': 'item/tool/requestUserInput', 'params': params})
                self.assertFalse(self.events)
                self.assertEqual(self.client.writes, [{'id': ident, 'error': {
                    'code': -32601, 'message': 'Agentic Complex denied this request'}}])

    async def turn(self, items=(), error=None):
        for phase, text in items:
            await self.client.events.put({'method': 'item/agentMessage/delta', 'params': {'delta': text}})
            await self.client.events.put({'method': 'item/completed', 'params': {'item': {'type': 'agentMessage', 'phase': phase, 'text': text}}})
        await self.client.events.put({'method': 'turn/completed', 'params': {'turn': {'id': 'turn', 'status': 'failed' if error else 'completed', 'error': error}}})
        await self.runner.run({'prompt': 'Synthetic'})
        return self.events[-1]

    async def test_last_noncommentary_message_is_answer(self):
        result = await self.turn([('commentary', 'Working'), ('final_answer', 'Earlier'),
                                  ('partial_answer', 'Answer'), ('commentary', 'Progress')])
        self.assertEqual(result['final_text'], 'Answer')

    async def test_codex_error_classes(self):
        cases = [({'codexErrorInfo': 'unauthorized'}, 'auth_expired', False),
                 ({'codexErrorInfo': 'usageLimitExceeded'}, 'quota_exhausted', False),
                 ({'codexErrorInfo': 'rateLimitExceeded'}, 'rate_limited', True),
                 ({'codexErrorInfo': {'responseStreamDisconnected': {'httpStatusCode': None}}}, 'network', True),
                 ({'codexErrorInfo': 'other', 'message': 'Request timed out'}, 'timeout', True),
                 ({'codexErrorInfo': 'cyberPolicy'}, 'refusal', False),
                 ({'codexErrorInfo': 'sandboxError'}, 'tool_failed', False),
                 ({'codexErrorInfo': 'other', 'message': 'private opaque detail'}, 'unknown', False),
                 ({'codexErrorInfo': {'httpConnectionFailed': {'httpStatusCode': 401}}}, 'auth_expired', False),
                 ({'codexErrorInfo': {'httpConnectionFailed': {'httpStatusCode': 429}}}, 'rate_limited', True)]
        for error, code, retryable in cases:
            with self.subTest(code=code, error=error):
                self.runner.active = {'id': 'run', 'cancelled': False}
                result = await self.turn(error=error)
                self.assert_failure(result, code, retryable)
                self.assertEqual(result['error'], 'failed')

    def assert_failure(self, result, code, retryable):
        failure = result.get('failure', {})
        self.assertEqual(failure.get('code'), code)
        self.assertIs(failure['retryable'], retryable)
        self.assertTrue(any('\u4e00' <= c <= '\u9fff' for c in failure['public_message']))
        self.assertNotIn('private', json.dumps(failure))


if __name__ == '__main__': unittest.main()
