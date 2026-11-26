"""Task delivery over real shared/run databases, including HTTP authority boundaries."""
import json
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_agent.services.deliveries import DeliveryError, DeliveryService
from character_agent.routes.http import route
from character_agent.services.jobs import JobStore
from character_agent.services.store import RunStore
from personal.memory import Memory
from infra.store import open_store
from sessions.tasks import TaskLedger


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
        self.db = open_store(self.root / 'domain.sqlite')
        self.task_db = open_store(self.root / 'domain.sqlite')  # Production uses separate connections.
        self.memory = Memory(self.db)  # A non-reentrant lock must also work.
        self.tasks = TaskLedger(self.task_db)
        self.jobs = JobStore(self.memory)
        self.runs = RunStore(self.root / 'runs.sqlite')
        self.now = 100.; self.events = []
        self.service = DeliveryService(self.memory, self.runs, self.tasks, self.jobs,
            clock=lambda: self.now, emit=self.events.append)
        self.server = SimpleNamespace(ui_token='ui', resetting=False, closing=False,
                                      character_agent=SimpleNamespace(deliveries=self.service))

    def tearDown(self):
        self.runs.close(); self.task_db.close(); self.db.close(); self.tmp.cleanup()

    def request(self, method, path, body=None, token='ui'):
        responses = []
        handler = SimpleNamespace(server=self.server, path=path, auth=lambda expected: token == expected,
            body=lambda: body, json=lambda status, value: responses.append((status, value)))
        self.assertTrue(route(handler, method, path.split('?')[0]))
        return responses[0]

    def produce_job(self, *, goal=None, state='needs_review', conversation='conversation', existing=None):
        self.now += 1
        job = self.jobs.submit('Report', {'character_id': 'aster', 'source_run_id': 'parent-run',
            'user_request': 'PRIVATE USER INPUT', 'scope_id': 'scope'}, goal,
            conversation_id=conversation, source_turn_id='parent-run') if existing is None else self.jobs.resume(existing['job_id'])
        self.jobs.claim()
        task_id = 'character-' + (existing['run_id'] if existing else job['run_id'])
        if existing:
            task_id = existing['task_id']
            self.tasks.resume_character(task_id)
        else:
            self.tasks.create(task_id, 'character', str(self.root), 'Report', 'workspace_write')
            self.tasks.transition(task_id, 'approved'); self.tasks.transition(task_id, 'running')
        self.runs.begin(job['run_id'], conversation, 'aster', job['generation'], 'scope', delivery_eligible=True)
        self.runs.event(job['run_id'], 'running', {'backend': 'codex'})
        self.runs.event(job['run_id'], 'tool_started', {'tool': 'artifact_write', 'tool_call_id': 'private-opaque-id'})
        self.runs.item({'run_id': job['run_id'], 'item_id': 'tool-item', 'seq': 1, 'kind': 'tool_result',
            'status': 'completed', 'summary': 'PRIVATE TOOL OUTPUT', 'text': 'PRIVATE TOOL BODY'})
        self.runs.event(job['run_id'], 'tool_finished', {'tool': 'artifact_write', 'tool_call_id': 'private-opaque-id'})
        checks = {'ok': state != 'failed', 'self_checked': state == 'succeeded', 'checks': [{'name': 'structure', 'ok': True}],
                  'artifacts': [{'artifact_id': 'artifact', 'path': 'report.md', 'absolute_path': str(self.root / 'report.md'),
                                 'version': 1, 'sha256': 'digest', 'self_checked': state == 'succeeded'}]}
        self.tasks.transition(task_id, 'returned'); self.tasks.transition(task_id, 'verifying')
        self.tasks.transition(task_id, state, result=checks)
        self.runs.finish(job['run_id'], 'completed', task_id=task_id, result=checks)
        self.jobs.settle(job['job_id'], state, {'task_id': task_id, 'reply': 'The report is ready.', 'validation': checks},
                         expected_run_id=job['run_id'])
        result = self.service.produce(job['run_id'])
        return {**job, 'task_id': task_id}, result

    @staticmethod
    def version(delivery):
        return {'expected_revision': delivery['revision'], 'generation': delivery['generation']}

    def test_canonical_task_deduplicates_job_and_task_and_retains_real_parent(self):
        job, delivery = self.produce_job()
        [task] = self.service.tasks_page()['tasks']
        self.assertEqual(task['canonical_task_id'], 'job:' + job['job_id'])
        self.assertEqual((task['task_id'], task['run_id']), (job['task_id'], job['run_id']))
        self.assertEqual((delivery['parent_run_id'], delivery['source_run_id']), ('parent-run', 'parent-run'))
        self.assertEqual(delivery['kind'], 'task_notice')
        self.assertFalse(delivery['material_is_instruction'])
        self.assertNotIn('PRIVATE', json.dumps(task))
        self.assertEqual(len(self.events), 1)
        self.assertNotIn('summary', self.events[0])

    def test_delivery_versions_count_production_not_generation_or_receipts(self):
        job, first = self.produce_job(state='failed')
        self.assertEqual(first['delivery_version'],1)
        seen = self.service.receipt(first['delivery_id'],'viewed',**self.version(first))
        self.assertEqual(seen['delivery_version'],1)
        _, second = self.produce_job(existing={**job,'task_id':job['task_id']})
        self.assertEqual(second['delivery_version'],2)
        _, unrelated = self.produce_job()
        self.assertEqual(unrelated['delivery_version'],1)

    def test_presented_and_viewed_are_distinct_idempotent_and_never_accept(self):
        job, delivery = self.produce_job()
        self.assertEqual(delivery['state'], 'produced')
        presented = self.service.receipt(delivery['delivery_id'], 'presented', **self.version(delivery))
        self.assertIsNotNone(presented['presented_at']); self.assertIsNone(presented['viewed_at'])
        again = self.service.receipt(delivery['delivery_id'], 'presented', **self.version(presented))
        self.assertEqual(again['revision'], presented['revision'])
        viewed = self.service.receipt(delivery['delivery_id'], 'viewed', **self.version(presented))
        self.assertEqual(viewed['state'], 'viewed'); self.assertIsNotNone(viewed['viewed_at'])
        self.assertIsNone(viewed['decision_source'])
        self.assertEqual(self.jobs.get(job['job_id'])['state'], 'needs_review')
        self.assertEqual(self.tasks.get(job['task_id'])['state'], 'needs_review')

    def test_viewed_establishes_presentation(self):
        job, delivery = self.produce_job()
        viewed = self.service.receipt(delivery['delivery_id'],'viewed',**self.version(delivery))
        self.assertEqual(viewed['presented_at'],viewed['viewed_at'])
        self.assertEqual(viewed['state'],'viewed')
        self.assertEqual(self.jobs.get(job['job_id'])['state'],'needs_review')
        self.assertIsNone(viewed['decided_at'])

    def test_accept_is_one_transaction_and_preserves_verification_evidence(self):
        goal = self.jobs.create_goal('Goal', 'Finish the report')
        job, delivery = self.produce_job(goal=goal['goal_id'])
        result = self.service.decide(delivery['canonical_task_id'], delivery['delivery_id'], 'accept', **self.version(delivery))
        self.assertEqual(result['delivery']['state'], 'accepted')
        self.assertEqual(result['delivery']['decision_source'], 'user')
        self.assertEqual(result['delivery']['verification_source'], 'unverified')
        task = self.tasks.get(job['task_id']); stored_job = self.jobs.get(job['job_id'])
        self.assertEqual((task['state'], stored_job['state']), ('accepted', 'accepted'))
        self.assertEqual(task['result']['checks'], [{'name': 'structure', 'ok': True}])
        self.assertFalse(task['result']['self_checked'])
        self.assertEqual(stored_job['result']['validation']['checks'], task['result']['checks'])
        current_goal = self.jobs.goal(goal['goal_id'])
        self.assertEqual(current_goal['state'], 'active')
        self.assertEqual(self.jobs.update_goal(goal['goal_id'], current_goal['revision'], 'completed')['state'], 'completed')

    def test_decision_failure_rolls_back_task_job_delivery_and_goal(self):
        goal = self.jobs.create_goal('Goal', 'Finish the report')
        job, delivery = self.produce_job(goal=goal['goal_id'])
        task_events = self.task_db.execute('SELECT COUNT(*) FROM task_events').fetchone()[0]
        with patch.object(self.jobs, '_review_result', side_effect=ValueError('injected_failure')):
            with self.assertRaisesRegex(ValueError, 'injected_failure'):
                self.service.decide(delivery['canonical_task_id'], delivery['delivery_id'], 'accept', **self.version(delivery))
        self.assertEqual(self.tasks.get(job['task_id'])['state'], 'needs_review')
        self.assertEqual(self.jobs.get(job['job_id'])['state'], 'needs_review')
        self.assertEqual(self.service.get(delivery['delivery_id'])['state'], 'produced')
        self.assertEqual(self.jobs.goal(goal['goal_id'])['revision'], goal['revision'])
        self.assertEqual(self.task_db.execute('SELECT COUNT(*) FROM task_events').fetchone()[0], task_events)

    def test_rejection_does_not_erase_successful_checks_and_can_resume(self):
        job, delivery = self.produce_job(state='succeeded')
        result = self.service.decide(delivery['canonical_task_id'], delivery['delivery_id'], 'reject', **self.version(delivery))
        self.assertEqual(result['task']['state'], 'rejected')
        self.assertEqual(result['delivery']['verification_source'], 'automatic_checks')
        self.assertTrue(self.tasks.get(job['task_id'])['result']['self_checked'])
        resumed = self.jobs.resume(job['job_id'])
        self.assertEqual(resumed['generation'], job['generation'] + 1)
        with self.assertRaisesRegex(DeliveryError, 'delivery_superseded'):
            self.service.decide(delivery['canonical_task_id'], delivery['delivery_id'], 'accept',
                                **self.version(result['delivery']))

    def test_receipts_survive_restart_and_duplicate_production(self):
        job, delivery = self.produce_job()
        viewed = self.service.receipt(delivery['delivery_id'], 'viewed', **self.version(delivery))
        recreated = DeliveryService(self.memory, self.runs, self.tasks, self.jobs)
        self.assertEqual(recreated.produce(job['run_id'], summary='SHOULD NOT REPLACE'), viewed)
        self.assertEqual(recreated.get(delivery['delivery_id']), viewed)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM personal_deliveries').fetchone()[0], 1)

    def test_steps_span_two_resumes_paginate_without_tools_or_prompt_bodies(self):
        one, first = self.produce_job()
        two, _ = self.produce_job(existing=one)
        three, _ = self.produce_job(existing=two)
        cursor, steps = None, []
        while True:
            page = self.service.steps(first['canonical_task_id'], cursor=cursor, limit=2)
            steps.extend(page['steps']); cursor = page['next_cursor']
            if cursor is None: break
        self.assertEqual(len({step['step_id'] for step in steps}), len(steps))
        self.assertEqual({step['run_id'] for step in steps}, {one['run_id'], two['run_id'], three['run_id']})
        self.assertEqual([step['at'] for step in steps], sorted(step['at'] for step in steps))
        self.assertNotIn('PRIVATE', json.dumps(steps)); self.assertNotIn('private-opaque-id', json.dumps(steps))
        self.assertEqual(len(self.service.tasks_page()['tasks']), 1)

    def test_step_summaries_follow_the_reply_language(self):
        _, delivery = self.produce_job()
        for language, summary in (('en', 'Tool returned'), ('zh-Hans', '工具已返回')):
            with self.subTest(language=language):
                steps = self.service.steps(delivery['canonical_task_id'], language=language)['steps']
                self.assertEqual([step['summary'] for step in steps if step['kind'] == 'tool_result'], [summary])

    def test_task_files_merge_every_run_and_keep_the_latest_run_per_path(self):
        one, first = self.produce_job()
        two, _ = self.produce_job(existing=one)
        per_run = {one['run_id']: [{'path': '/in/a.md', 'op': 'read', 'added': None, 'removed': None},
                                   {'path': '/out/b.md', 'op': 'write', 'added': 3, 'removed': 0}],
                   two['run_id']: [{'path': '/out/b.md', 'op': 'modify', 'added': None, 'removed': None}]}
        self.server.character_agent.workspace = SimpleNamespace(run_files=lambda run_id: per_run.get(run_id, []))
        code, body = self.request('GET', '/agent/tasks/' + first['canonical_task_id'] + '/files')
        self.assertEqual(code, 200)
        self.assertEqual(body, {'files': [
            {'path': '/in/a.md', 'op': 'read', 'added': None, 'removed': None, 'run_id': one['run_id']},
            {'path': '/out/b.md', 'op': 'modify', 'added': None, 'removed': None, 'run_id': two['run_id']}]})
        self.assertEqual(self.request('GET', '/agent/tasks/job:' + 'f' * 32 + '/files'), (404, {'error': 'not_found'}))
        self.assertEqual(self.request('GET', '/agent/tasks/' + first['canonical_task_id'] + '/files', token='events')[0], 401)

    def test_legacy_and_standalone_tasks_remain_readable(self):
        self.tasks.create('legacy-task', 'codex', str(self.root), 'Old task', 'read_only')
        [task] = self.service.tasks_page()['tasks']
        self.assertEqual(task['canonical_task_id'], 'task:legacy-task')
        self.assertIsNone(task['delivery']); self.assertEqual(task['generation'], 0)
        self.assertIsNone(self.service.produce('missing'))

    def test_task_list_reads_job_runs_once_and_checkpoints_only_for_the_page(self):
        for _ in range(3): self.produce_job()
        for i in range(3):
            task_id, run_id = 'standalone-%d' % i, 'standalone-run-%d' % i
            self.tasks.create(task_id, 'codex', str(self.root), 'Standalone', 'read_only', now=10**10 + i)
            self.runs.begin(run_id, 'conversation', 'aster', 0)
            self.runs.checkpoint(run_id, task_id, {'task_id': task_id, 'source_run_id': 'source-%d' % i})
        statements = []
        self.db.set_trace_callback(statements.append)
        with patch.object(self.runs, 'load_checkpoint', wraps=self.runs.load_checkpoint) as load:
            page = self.service.tasks_page(limit=2)
            self.db.set_trace_callback(None)
            self.assertEqual(len([s for s in statements if 'personal_job_runs' in s]), 1)
            self.assertEqual(load.call_count, 2)
            self.assertEqual([(t['canonical_task_id'], t['source_run_id']) for t in page['tasks']],
                             [('task:standalone-2', 'source-2'), ('task:standalone-1', 'source-1')])
            load.reset_mock()
            self.assertEqual(self.service.task('task:standalone-0')['source_run_id'], 'source-0')
            self.assertEqual(load.call_count, 1)

    def test_temporary_turn_never_produces_delivery(self):
        job, delivery = self.produce_job()
        self.service.forget([job['run_id']])
        self.assertIsNone(self.service.produce(job['run_id'], remember=False, summary='TEMP PRIVATE'))
        self.assertEqual(self.service.list()['deliveries'], [])

    def test_restart_cannot_resurrect_revoked_or_ineligible_delivery(self):
        job,_=self.produce_job()
        self.service.forget([job['run_id']])
        self.runs.redact_items([job['run_id']])
        self.runs.close()
        self.runs=RunStore(self.root/'runs.sqlite')
        self.service=DeliveryService(self.memory,self.runs,self.tasks,self.jobs)
        self.assertTrue(self.runs.get(job['run_id'])['delivery_revoked'])
        self.assertIsNone(self.service.produce(job['run_id']))
        self.runs.begin('legacy-private','conversation','aster',1)
        self.runs.finish('legacy-private','completed',task_id=job['task_id'],result={})
        self.assertFalse(self.runs.get('legacy-private')['delivery_eligible'])
        self.assertIsNone(self.service.produce('legacy-private'))
        self.assertEqual(self.service.list()['deliveries'],[])

    def test_scope_revoked_before_late_production_cannot_create_a_delivery(self):
        job, delivery = self.produce_job()
        self.service.forget([job['run_id']])
        self.service.validate_scope = lambda scope: (_ for _ in ()).throw(ValueError('scope_revoked'))
        self.assertIsNone(self.service.produce(job['run_id'], summary='PRIVATE LATE RESULT'))
        self.assertEqual(self.service.list()['deliveries'], [])

    def test_revoke_erases_payload_and_blocks_late_receipts_or_reproduction(self):
        job, delivery = self.produce_job()
        self.service.revoke([job['run_id']])
        revoked = self.service.get(delivery['delivery_id'])
        self.assertTrue(revoked['redacted'])
        self.assertEqual((revoked['summary'], revoked['title'], revoked['artifacts']), ('', '', []))
        self.assertEqual(self.service.produce(job['run_id'], summary='LEAK'), revoked)
        with self.assertRaisesRegex(DeliveryError, 'delivery_revoked'):
            self.service.decide(delivery['canonical_task_id'], delivery['delivery_id'], 'accept', **self.version(revoked))

    def test_conversation_forget_preserves_other_delivery_and_removes_owned_steps_mapping(self):
        one, first = self.produce_job(conversation='one')
        _, second = self.produce_job(conversation='two')
        self.service.forget(conversation_id='one')
        self.assertIsNone(self.service.get(first['delivery_id']))
        self.assertIsNotNone(self.service.get(second['delivery_id']))
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM personal_job_runs WHERE conversation_id=?', ('one',)).fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM personal_delivery_events WHERE delivery_id=?', (first['delivery_id'],)).fetchone()[0], 0)

    def test_http_requires_ui_auth_revision_generation_and_does_not_view_on_list(self):
        job, delivery = self.produce_job()
        for token in ('events', 'hook', None):
            self.assertEqual(self.request('GET', '/agent/tasks', token=token)[0], 401)
        code, body = self.request('GET', '/agent/tasks?limit=1')
        self.assertEqual(code, 200); self.assertEqual(body['tasks'][0]['delivery']['state'], 'produced')
        path = '/agent/deliveries/' + delivery['delivery_id'] + '/viewed'
        self.assertEqual(self.request('POST', path, {'expected_revision': True, 'generation': 0})[0], 400)
        self.assertEqual(self.request('POST', path, {'expected_revision': 1, 'generation': 99})[0], 409)
        code, body = self.request('POST', path, self.version(delivery))
        self.assertEqual(code, 200); self.assertEqual(body['delivery']['state'], 'viewed')
        self.assertEqual(self.request('POST', path, self.version(delivery))[0], 409)
        accept = '/agent/tasks/job%3A' + job['job_id'] + '/accept'
        code, body = self.request('POST', accept, {'delivery_id': delivery['delivery_id'], **self.version(body['delivery'])})
        self.assertEqual(code, 200); self.assertEqual(body['task']['state'], 'accepted')
        self.assertEqual(self.request('GET', accept)[0], 405)
        self.assertEqual(self.request('GET', '/agent/tasks?limit=0')[0], 400)
        self.assertEqual(self.request('GET', '/agent/tasks?cursor=bogus')[0], 400)

    def test_opening_an_artifact_is_kept_on_the_delivery_without_raising_its_revision(self):
        job, delivery = self.produce_job()
        self.assertEqual([a['opened_at'] for a in delivery['artifacts']], [None])
        path = '/agent/deliveries/' + delivery['delivery_id'] + '/opened'
        self.now = 140.
        code, body = self.request('POST', path, {'artifact_id': 'artifact'})
        self.assertEqual(code, 200)
        self.assertEqual([a['opened_at'] for a in body['delivery']['artifacts']], [140.])
        self.assertEqual((body['delivery']['revision'], body['delivery']['state']), (delivery['revision'], 'produced'))
        self.now = 150.
        self.assertEqual(self.request('POST', path, {'artifact_id': 'artifact'})[1]['delivery']['artifacts'][0]['opened_at'], 140.)
        self.assertEqual(self.service.get(delivery['delivery_id'])['artifacts'][0]['opened_at'], 140.)
        self.assertEqual(self.request('POST', path, {'artifact_id': 'other'}), (404, {'error': 'unknown_artifact'}))
        for bad in ({}, {'artifact_id': 1}, {'artifact_id': 'artifact', 'expected_revision': 1}):
            self.assertEqual(self.request('POST', path, bad), (400, {'error': 'invalid_delivery_payload'}))
        self.assertEqual(self.request('POST', path, {'artifact_id': 'artifact'}, token='hook')[0], 401)
        self.assertEqual(self.request('GET', path)[0], 405)
        self.service.revoke([job['run_id']])
        self.assertEqual(self.request('POST', path, {'artifact_id': 'artifact'}), (409, {'error': 'delivery_revoked'}))

    def test_competing_accept_reject_has_one_winner(self):
        _, delivery = self.produce_job()
        results = []
        def decide(action):
            try:
                result = self.service.decide(delivery['canonical_task_id'], delivery['delivery_id'], action, **self.version(delivery))
                results.append(result['delivery']['state'])
            except DeliveryError as error: results.append(error.code)
        workers = [threading.Thread(target=decide, args=(action,)) for action in ('accept', 'reject')]
        for worker in workers: worker.start()
        for worker in workers: worker.join(2)
        self.assertTrue(all(not worker.is_alive() for worker in workers))
        self.assertIn('delivery_version_changed', results)
        self.assertEqual(len(set(results) & {'accepted', 'rejected'}), 1)
