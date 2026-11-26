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

    def test_the_goal_create_example_typed_verbatim_creates_the_goal(self):
        description = next(t['description'] for t in OrchestrationTurn.tool_definitions() if t['name'] == 'goal_create')
        example = description.split('e.g. "', 1)[1].split('"', 1)[0]
        reply = self.orchestration(example).call('goal_create', {'title': 'Running', 'objective_quote': example})
        self.assertNotIn('error', reply)
        self.assertEqual([g['objective'] for g in self.jobs.goals()], [example])

    def test_natural_goal_phrasing_succeeds(self):
        ok = self.orchestration('帮我一直盯着发布进度').call(
            'goal_create', {'title': '盯发布进度', 'objective_quote': '帮我一直盯着发布进度'})
        self.assertNotIn('error', ok)
        self.assertEqual([g['title'] for g in self.jobs.goals()], ['盯发布进度'])

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

    def test_task_continue_needs_a_task_or_job(self):
        result = self.orchestration('接着做').call('task_continue', {'instruction_quote':'接着做'})
        self.assertEqual(result.get('error', {}).get('code'), 'continue_target_required')

    def test_task_continue_returns_the_resume_refusal(self):
        job = self.settled_job('succeeded')
        result = self.orchestration('接着做昨天那个报表').call('task_continue',
            {'job_id':job['job_id'], 'instruction_quote':'接着做昨天那个报表'})
        self.assertEqual(result.get('error', {}).get('code'), 'job_not_resumable')

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
