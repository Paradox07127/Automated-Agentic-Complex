"""Regression scenarios found in the 2026-10-31 personal-agent audit."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from character_agent.services.jobs import JobStore
from character_agent.services.memory_service import MemoryJournal
from character_agent.services.orchestration import OrchestrationTurn
from character_agent.services.workspace import WorkspaceError, _validate_arguments
from personal.memory import Memory
from api.handler import Handler
from infra.store import open_store
from traces.trace_format import validate_event
from traces.trace_store import TraceStore, new_trace_id


class AuditDomainTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.addCleanup(self.tmp.cleanup)
        self.db = open_store(Path(self.tmp.name) / 'domain.sqlite')
        self.addCleanup(self.db.close)
        self.memory = Memory(self.db)
        self.jobs = JobStore(self.memory)
        self.cancel = Mock(return_value=True)
        self.controller = SimpleNamespace(jobs=SimpleNamespace(store=self.jobs, cancel=self.cancel),
            knowledge=lambda: SimpleNamespace(sanitize=lambda value, **_: value),
            update_goal=self.jobs.update_goal)

    def orchestration(self, text):
        turn = OrchestrationTurn(self.controller, text, {}, 'aster', None, 'current-run')
        turn.open(lambda: True)
        return turn

    def test_negated_and_quoted_goal_creation_changes_nothing(self):
        for text in ('请不要创建目标：早睡计划', '例如“创建目标：早睡计划”，先解释这个功能',
                     '如果创建目标：早睡计划，会怎样？', '不要创建目标：早睡计划；创建目标：阅读计划'):
            with self.subTest(text=text):
                reply = self.orchestration(text).call('goal_create', {'title':'早睡计划', 'objective_quote':'早睡计划'})
                self.assertEqual(reply.get('error', {}).get('code'), 'explicit_goal_instruction_required')
                self.assertEqual(self.jobs.goals(), [])

    def test_the_goal_create_example_typed_verbatim_creates_the_goal(self):
        description = next(t['description'] for t in OrchestrationTurn.tool_definitions() if t['name'] == 'goal_create')
        example = description.split('e.g. "', 1)[1].split('"', 1)[0]
        reply = self.orchestration(example).call('goal_create', {'title': 'Running', 'objective_quote': example})
        self.assertNotIn('error', reply)
        self.assertEqual([g['objective'] for g in self.jobs.goals()], [example])

    def test_goal_state_action_is_bound_to_its_own_clause(self):
        goal = self.jobs.create_goal('资料核查', '核查资料')
        for text in ('不要取消资料核查，只取消日报生成', '资料核查先暂停；日报生成取消',
                     '资料核查尚未完成', '资料核查 incomplete', '如果取消资料核查，会怎样？'):
            with self.subTest(text=text):
                state = 'completed' if '完成' in text or 'incomplete' in text else 'cancelled'
                result = self.orchestration(text).call('goal_update',
                    {'goal_id':goal['goal_id'], 'expected_version':1, 'state':state})
                self.assertEqual(result.get('error', {}).get('code'), 'goal_target_not_authorized')
                self.assertEqual(self.jobs.goal(goal['goal_id'])['state'], 'active')
        result = self.orchestration('请暂停资料核查').call('goal_update',
            {'goal_id':goal['goal_id'], 'expected_version':1, 'state':'paused'})
        self.assertEqual(result['state'], 'paused')

    def test_background_cancel_does_not_borrow_another_jobs_authorization(self):
        one = self.jobs.submit('资料核查', {'user_request':'核查资料'})
        self.jobs.submit('日报生成', {'user_request':'生成日报'})
        result = self.orchestration('不要取消资料核查，只取消日报生成').call('background_cancel', {'job_id':one['job_id']})
        self.assertEqual(result.get('error', {}).get('code'), 'job_target_not_authorized')
        self.cancel.assert_not_called()

    def test_status_questions_and_explanations_do_not_mutate_goals(self):
        goal = self.jobs.create_goal('资料核查', '核查资料')
        for text, state in (('资料核查完成了吗？', 'completed'), ('Did you complete 资料核查?', 'completed'),
                            ('资料核查有没有取消？', 'cancelled'), ('请解释取消资料核查', 'cancelled')):
            with self.subTest(text=text):
                result = self.orchestration(text).call('goal_update',
                    {'goal_id':goal['goal_id'], 'expected_version':1, 'state':state})
                self.assertEqual(result.get('error', {}).get('code'), 'goal_target_not_authorized')
                self.assertEqual(self.jobs.goal(goal['goal_id'])['state'], 'active')

    def test_sole_job_cancel_still_requires_a_generic_or_matching_target(self):
        one = self.jobs.submit('资料核查', {'user_request':'核查资料'})
        turn = self.orchestration('取消日报生成')
        result = turn.call('background_cancel', {'job_id':one['job_id']})
        self.assertEqual(result.get('error', {}).get('code'), 'job_target_not_authorized')
        self.cancel.assert_not_called()
        for text in ('取消任务', '停止它', 'cancel it', '请取消资料核查'):
            with self.subTest(text=text):
                result = self.orchestration(text).call('background_cancel', {'job_id':one['job_id']})
                self.assertTrue(result['cancelled'])

    def test_cancel_finds_an_active_job_behind_the_public_status_page(self):
        from test_character_agent_integration import IntegrationTests
        case = IntegrationTests()
        case.setUp()
        try:
            job = case.controller.jobs.store.submit('老任务', {'user_request':'仅用于隔离回归'})
            for i in range(101):
                other = case.controller.jobs.store.submit(str(i), {'user_request':'其他工作'})
                case.controller.jobs.store.settle(other['job_id'], 'cancelled', from_states=('queued',))
            self.assertNotIn(job['job_id'], {j['job_id'] for j in case.controller.jobs.store.list()})
            self.assertEqual(case.server.say('取消任务')[0], 202)
        finally:
            case.tearDown()
            case.doCleanups()

    def settled_job(self, state):
        job = self.jobs.submit('报表', {'user_request':'做报表', 'instruction':'做报表'})
        self.jobs.claim(); self.jobs.settle(job['job_id'], state)
        self.controller.resume_job = lambda ident, text='': self.jobs.resume(ident, text=text)
        return job

    def test_task_continue_resumes_the_named_job_in_the_background(self):
        job = self.settled_job('needs_review')
        turn = self.orchestration('接着做昨天那个报表')
        result = turn.call('task_continue', {'job_id':job['job_id'], 'instruction_quote':'接着做昨天那个报表'})
        self.assertEqual(result['job_id'], job['job_id'])
        self.assertNotEqual(result['run_id'], job['run_id'])
        self.assertEqual(result['state'], 'queued')
        self.assertEqual(turn.spawned, [job['job_id']])

    def continue_with_whole_message(self, text):
        job = self.settled_job('needs_review')
        result = self.orchestration(text).call('task_continue', {'job_id':job['job_id'], 'instruction_quote':text})
        self.assertEqual(result.get('job_id'), job['job_id'], result)

    def test_task_continue_takes_the_whole_message_as_the_quote(self):
        self.continue_with_whole_message('接着刚才那个报表继续，再加一列笔均金额，保留两位小数。')

    def test_task_continue_takes_a_two_sentence_message_as_the_quote(self):
        self.continue_with_whole_message('接着做报表。再加一列。')

    def test_task_continue_whole_message_quote_keeps_refusals(self):
        job = self.settled_job('needs_review')
        for text in ('别继续那个报表。', '不要接着做报表了。先放着。'):
            with self.subTest(text=text):
                result = self.orchestration(text).call('task_continue', {'job_id':job['job_id'], 'instruction_quote':text})
                self.assertEqual(result.get('error', {}).get('code'), 'continue_not_authorized')
                self.assertEqual(self.jobs.get(job['job_id'])['state'], 'needs_review')

    def test_task_continue_requires_a_continue_instruction_quoted_from_the_user(self):
        job = self.settled_job('needs_review')
        for text, quote in (('报表怎么样了', '报表怎么样了'), ('接着做昨天那个报表', '继续做报表')):
            with self.subTest(text=text, quote=quote):
                result = self.orchestration(text).call('task_continue', {'job_id':job['job_id'], 'instruction_quote':quote})
                self.assertEqual(result.get('error', {}).get('code'), 'continue_not_authorized')
                self.assertEqual(self.jobs.get(job['job_id'])['state'], 'needs_review')

    def test_task_continue_needs_a_task_or_job(self):
        result = self.orchestration('接着做').call('task_continue', {'instruction_quote':'接着做'})
        self.assertEqual(result.get('error', {}).get('code'), 'continue_target_required')

    def test_task_continue_returns_the_resume_refusal(self):
        job = self.settled_job('succeeded')
        result = self.orchestration('接着做昨天那个报表').call('task_continue',
            {'job_id':job['job_id'], 'instruction_quote':'接着做昨天那个报表'})
        self.assertEqual(result.get('error', {}).get('code'), 'job_not_resumable')

    def test_negated_memory_forget_preserves_the_fact(self):
        ident = self.memory.add('我喜欢黑咖啡', 'asserted_by_user', kind='preference')
        with patch.object(MemoryJournal, '_schedule_purge'):
            journal = MemoryJournal(self.memory)
        for index, text in enumerate(('不要忘记我喜欢黑咖啡', "Don't forget 我喜欢黑咖啡", '如果删除我喜欢黑咖啡，会怎样？')):
            turn = journal.turn(str(index), text, 'codex', 'test', 'aster', {})
            turn.open(lambda: True)
            reply = turn.call('memory_propose', {'operation':'forget', 'evidence_quote':'我喜欢黑咖啡',
                'fact_id':ident, 'expected_version':1, 'target_quote':'我喜欢黑咖啡'})
            self.assertEqual(reply.get('error', {}).get('code'), 'explicit_memory_instruction_required')
            self.assertEqual(self.memory.active()[0]['text'], '我喜欢黑咖啡')

    def test_memory_correction_cannot_use_another_facts_instruction(self):
        ident = self.memory.add('我喜欢黑咖啡', 'asserted_by_user', kind='preference')
        with patch.object(MemoryJournal, '_schedule_purge'):
            journal = MemoryJournal(self.memory)
        text = '不要更正我喜欢黑咖啡；把另一条更正为我喜欢红茶'
        turn = journal.turn('correct', text, 'codex', 'test', 'aster', {})
        turn.open(lambda: True)
        reply = turn.call('memory_propose', {'operation':'correct', 'text':'我喜欢红茶',
            'evidence_quote':'我喜欢红茶', 'fact_id':ident, 'expected_version':1, 'target_quote':'我喜欢黑咖啡'})
        self.assertEqual(reply.get('error', {}).get('code'), 'memory_target_not_authorized')
        self.assertEqual(self.memory.active()[0]['text'], '我喜欢黑咖啡')

    def test_reopened_journal_settles_incomplete_runs_and_redacts_content(self):
        with patch.object(MemoryJournal, '_schedule_purge'):
            journal = MemoryJournal(self.memory)
            turn = journal.turn('interrupted', 'private-input', 'codex', 'test', 'aster', {'prompt':'private-prompt'})
            turn.open(lambda: True)
            turn.record('assistant_text', {'text':'private-partial-output'})
            done = journal.turn('complete', '', 'codex', 'test', 'aster', {})
            done.open(lambda: True)
            done.finish('completed', 'delivered-output')
            recovered = MemoryJournal(self.memory)
        row = recovered.get('interrupted')
        self.assertEqual(row['state'], 'interrupted')
        self.assertIsNotNone(row['finished_at'])
        self.assertNotIn('private-', json.dumps(row['detail']))
        self.assertEqual(recovered.get('complete')['state'], 'completed')

    def test_generation_journal_matches_the_actual_compiled_adapter_request(self):
        from test_character_agent_runtime import RuntimeTests
        case = RuntimeTests()
        case.setUp()
        try:
            with patch.object(MemoryJournal, '_schedule_purge'):
                journal = MemoryJournal(case.memory)
            turn = journal.turn('run-1', 'User question', 'codex', 'test', 'one', {'context':'preparation only'})
            answer = case.run_agent(memory_session=turn, context='Observed source material')
            self.assertIsNone(answer.error)
            call = case.sessions[0].calls[0]
            row = journal.get('run-1')
            actual = json.loads(row['detail']['request'])
            self.assertEqual(actual['prompt'], call['prompt'])
            self.assertEqual(actual['system_prompt'], call['system_prompt'])
            self.assertEqual(actual['history'], call['history'])
            self.assertEqual(actual['tools'], case.definitions[0])
            self.assertEqual(actual['continuation'], {})
            self.assertEqual(row['input_sha256'], hashlib.sha256(row['detail']['request'].encode()).hexdigest())
        finally:
            case.tearDown()
            case.doCleanups()


class AuditProtocolTests(unittest.TestCase):
    def test_internal_tool_schemas_reject_invalid_enum_and_empty_identifier(self):
        for value, schema in (('', {'type':'string','minLength':1}),
                              ('bogus', {'type':'string','enum':['active','paused']}),
                              ('false', {'type':'boolean'})):
            with self.subTest(value=value):
                with self.assertRaises(WorkspaceError):
                    _validate_arguments(value, schema)
        _validate_arguments(False, {'type':'boolean'})

    def test_trace_pages_keep_first_input_ownership_and_compare_real_time(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32") as tmp:
            db = open_store(Path(tmp) / 'trace.sqlite')
            self.addCleanup(db.close)
            trace = TraceStore(db, 1)
            first, second = new_trace_id(), new_trace_id()
            base = json.loads(Path(__file__).with_name('trace-sample.ndjson').read_text(encoding='utf-8').splitlines()[0])
            events = []
            for seq, (ident, wall, source) in enumerate((
                (first, '2026-10-19T09:00:00.000-04:00', 'text'),
                (second, '2026-10-19T13:30:00.000+00:00', 'voice'),
                (first, '2026-10-19T14:00:00.000+00:00', 'voice')), 1):
                event = copy.deepcopy(base)
                event.update(producer='companion', event_id=str(uuid.uuid4()), trace_id=ident, seq=seq, t_wall=wall)
                event['attrs']['source'] = source
                events.append(event)
            self.assertEqual(trace.ingest(events)['accepted'], 3)
            self.assertEqual([r['trace_id'] for r in trace.turns()], [second, first])
            self.assertEqual([r['trace_id'] for r in trace.turns(source='voice')], [second])
            self.assertEqual([r['trace_id'] for r in trace.turns(since='2026-10-19T13:15:00+00:00')], [second])

    def test_empty_trace_queries_still_validate_since_and_page_limits(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32") as tmp:
            db = open_store(Path(tmp) / 'trace.sqlite')
            self.addCleanup(db.close)
            trace = TraceStore(db, 1)
            for query in (trace.turns, trace.decisions):
                with self.assertRaises(ValueError): query(since='not-a-date')
                with self.assertRaises(ValueError): query(since='2026-10-19T13:15:00')
                for limit in (0, -1, True, 201):
                    with self.assertRaises(ValueError): query(limit=limit)

    def test_trace_dates_must_exist_and_have_a_real_offset(self):
        base = json.loads(Path(__file__).with_name('trace-sample.ndjson').read_text(encoding='utf-8').splitlines()[0])
        for wall in ('2026-02-31T09:12:03.000-04:00', '2026-13-01T09:12:03.000-04:00',
                     '2026-10-19T25:12:03.000-04:00', '2026-10-19T09:12:03.000+25:00',
                     '2026-10-19T09:12:03.000-04:00\n'):
            for field in ('t_wall', 't_recv_wall'):
                event = copy.deepcopy(base); event[field] = wall
                with self.subTest(field=field, wall=wall):
                    self.assertTrue(validate_event(event))

    def test_trace_identifiers_cannot_hide_trailing_line_breaks(self):
        base = json.loads(Path(__file__).with_name('trace-sample.ndjson').read_text(encoding='utf-8').splitlines()[0])
        for field in ('event_id', 'trace_id', 'span_id'):
            event = copy.deepcopy(base); event[field] += '\n'
            with self.subTest(field=field): self.assertTrue(validate_event(event))
        base['v'] = True
        self.assertTrue(validate_event(base))

    def test_bad_remote_event_cannot_poison_trace_queries(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32") as tmp:
            db = open_store(Path(tmp) / 'trace.sqlite')
            self.addCleanup(db.close)
            trace = TraceStore(db, 1)
            trace.emit('input.received', new_trace_id(), attrs={'source':'text','text':None})
            event = json.loads(Path(__file__).with_name('trace-sample.ndjson').read_text(encoding='utf-8').splitlines()[0])
            event.update(producer='companion', t_wall='2026-02-31T09:12:03.000-04:00')
            result = trace.ingest([event])
            self.assertEqual(result['accepted'], 0)
            self.assertEqual(len(trace.turns()), 1)

    def test_disconnect_while_writing_json_headers_or_body_is_quiet(self):
        for at in ('headers', 'body'):
            handler = object.__new__(Handler)
            handler.close_connection = False
            handler.send_response = Mock()
            handler.send_header = Mock()
            handler.end_headers = Mock(side_effect=BrokenPipeError() if at == 'headers' else None)
            handler.wfile = Mock()
            if at == 'body': handler.wfile.write.side_effect = ConnectionResetError()
            with self.subTest(at=at):
                handler._json(200, {'ok':True})
                self.assertTrue(handler.close_connection)

    def test_json_response_still_exposes_real_storage_errors(self):
        handler = object.__new__(Handler)
        handler.close_connection = False
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()
        handler.wfile = Mock()
        handler.wfile.write.side_effect = OSError('unexpected IO failure')
        with self.assertRaises(OSError): handler._json(200, {'ok':True})
