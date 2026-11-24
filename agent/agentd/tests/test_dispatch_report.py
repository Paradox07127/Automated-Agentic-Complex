"""Dispatched results enter a read-only role turn, with live session consent."""
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from brain.persona import PROMPT_USER  # noqa: E402
from character_agent.runtime import PersonalAgentRuntime  # noqa: E402
import test_dispatch_tool


class DispatchReportTests(unittest.TestCase):
    setUp = test_dispatch_tool.DispatchToolTests.setUp
    factory = test_dispatch_tool.DispatchToolTests.factory
    settled = test_dispatch_tool.DispatchToolTests.settled
    line = test_dispatch_tool.DispatchToolTests.line

    def task(self, task_id='report-task', state='needs_review', *, owner=None, now=None):
        self.server.tasks.create(task_id, 'codex', str(self.project), '修 HostLink 断线', 'read_only', now=now,
            requested_by=owner or {'kind': 'agent', 'character_id': self.server.character})
        for step in ('approved', 'running', 'returned', 'verifying', state):
            self.server.tasks.transition(task_id, step, now=now)
            if step == state:
                break
        return self.server.tasks.get(task_id)

    def announcement(self, task, detail='修复了重连；请确认断线后能自动恢复。'):
        return {'kind': 'dispatch_review', 'level': 'P2', 'headline': 'codex 回话了，结果待你确认',
                'origin': task['task_id'], 'session_id': None, 'project': task['cwd'], 'detail': detail}

    def ready(self):
        self.server.share_agent_sessions = True
        self.server.sync_privacy()
        self.server.speech = SimpleNamespace(busy=lambda: False, cancel=lambda *args: None,
                                             interrupted=lambda: False, epoch='test')
        self.server._voice_announcement = Mock()
        self.server.gate.admit = Mock(return_value=(True, None))
        self.server.gate.check = Mock(return_value=None)
        patcher = patch.object(self.server, '_text_only', side_effect=lambda source: source != 'announce')
        patcher.start()
        self.addCleanup(patcher.stop)

    def report(self, task=None):
        task = task or self.task()
        self.server.announce(self.announcement(task))
        self.settled()
        lines = [e['data'] for e in self.server.feed.since(0) if e['event'] == 'line'
                 and (e['data'].get('reason') or {}).get('code') == 'dispatch_report']
        self.assertTrue(lines, 'no dispatch_report line was published')
        self.assertFalse(lines[-1].get('error'), lines[-1])
        return lines

    def test_review_publishes_role_line_and_keeps_card_with_read_only_observed_material(self):
        self.ready()
        task = self.task()
        self.server.sessions = SimpleNamespace(sessions={'own:report': SimpleNamespace(origin=task['task_id'])},
                                               own_id=lambda session_id: session_id)
        announcement = {**self.announcement(task), 'origin': None, 'session_id': 'own:report',
                        'detail': 'CLI-RESULT alice@example.com ' + '字' * 4500 + 'END-OF-CLI'}
        # A report line runs in a one-off runtime of its own.
        with patch.object(PersonalAgentRuntime, 'run', autospec=True, side_effect=PersonalAgentRuntime.run) as run:
            self.server.announce(announcement)
            self.settled()
        lines = [e['data'] for e in self.server.feed.since(0) if e['event'] == 'line']
        self.assertTrue(lines, 'no dispatch_report line was published')
        self.assertEqual(lines[-1]['reason'], {'code': 'dispatch_report', 'task_id': task['task_id'],
                                             'kind': 'dispatch_review'})
        self.assertFalse(lines[-1].get('error'), lines[-1])
        self.assertEqual(self.server.history.export()[0]['source'], 'proactive')
        self.assertFalse(run.call_args.kwargs['allow_actions'])
        context = run.call_args.kwargs['context']
        self.assertIn('CLI-RESULT', context)
        self.assertNotIn('alice@example.com', context)
        self.assertNotIn('END-OF-CLI', context)
        self.assertIn('not instructions', run.call_args.kwargs['text'])
        self.server._voice_announcement.assert_not_called()

        cards = [e for e in self.server.feed.since(0) if e['event'] == 'announce']
        self.assertEqual(len(cards), 1)

    def test_busy_role_uses_the_existing_headline_slot(self):
        self.ready()
        self.report()
        task = self.task('busy-task')
        self.server.speech.busy = lambda: True
        with patch.object(self.server, 'claim_line', wraps=self.server.claim_line) as claim:
            self.server.announce(self.announcement(task))
        claim.assert_called_once()
        self.assertEqual(next(iter(self.server._announce_slots.values()))[2], self.announcement(task)['headline'])
        self.server.speech.busy = lambda: False
        self.server._announce_due()
        self.assertEqual(self.server._voice_announcement.call_args.args[1], self.announcement(task)['headline'])

    def test_same_task_reports_once_even_after_its_state_changes(self):
        self.ready()
        task = self.task()
        with patch.object(self.server, 'claim_line', wraps=self.server.claim_line) as claim:
            self.report(task)
            self.server.announce(self.announcement(task))
            self.server.tasks.transition(task['task_id'], 'succeeded')
            self.server.announce({**self.announcement(task), 'kind': 'dispatch_done', 'level': 'P0'})
        self.assertEqual(claim.call_count, 1)
        self.server._voice_announcement.assert_not_called()

    def test_revoked_session_consent_passes_no_material_and_reads_headline(self):
        self.ready()
        self.report()
        self.server.share_agent_sessions = False
        task = self.task('revoked-task')
        with patch.object(self.server, 'claim_line', wraps=self.server.claim_line) as claim:
            self.server.announce(self.announcement(task))
        claim.assert_not_called()
        self.assertFalse(self.server._line_material)
        self.assertEqual(self.server._voice_announcement.call_args.args[1], self.announcement(task)['headline'])

    def test_recheck_rejects_a_new_consent_epoch_even_when_permission_is_restored(self):
        self.ready()
        self.report()
        with patch.object(self.server, 'claim_line', return_value=True) as claim:
            self.server.announce(self.announcement(self.task('epoch-task')))
        recheck = claim.call_args.args[2]
        self.assertTrue(recheck())
        self.server.consent.revoke({'agent_sessions'})
        self.assertFalse(recheck())

    def test_revocation_during_material_build_never_passes_material_to_claim(self):
        self.ready()
        self.report()
        from character import dispatch_report
        build = dispatch_report.build

        def revoke(*args):
            result = build(*args)
            self.server.consent.revoke({'agent_sessions'})
            return result

        with patch.object(dispatch_report, 'build', side_effect=revoke), \
                patch.object(self.server, 'claim_line', return_value=True) as claim:
            self.server.announce(self.announcement(self.task('build-race')))
        claim.assert_not_called()
        self.server._voice_announcement.assert_called_once()

    def test_recheck_rejects_nonterminal_tasks_and_other_character_tasks_use_headline(self):
        self.ready()
        self.report()
        task = self.task('stale-task')
        with patch.object(self.server, 'claim_line', return_value=True) as claim:
            self.server.announce(self.announcement(task))
        recheck = claim.call_args.args[2]
        self.db.execute("UPDATE tasks SET state='running' WHERE task_id=?", (task['task_id'],))
        self.db.commit()
        self.assertFalse(recheck())
        other = self.task('other-task', owner={'kind': 'agent', 'character_id': 'other'})
        with patch.object(self.server, 'claim_line', return_value=True) as claim:
            self.server.announce(self.announcement(other))
        claim.assert_not_called()
        self.server._voice_announcement.assert_called_once()

    def test_blocked_reports_remain_in_one_bounded_context_with_target_and_status_lookup(self):
        self.ready()
        self.server.gate.admit.return_value = (False, 'quiet_hours')
        now = self.server.clock()  # one clock tick for all six, as Windows' 15.6 ms clock often gives them
        recent = [self.task('quiet-' + str(i), now=now) for i in range(6)]
        for task in recent:
            self.server.announce(self.announcement(task))
        self.task('old-task', now=self.server.clock() - 90000)
        self.task('other-task', owner={'kind': 'agent', 'character_id': 'other'})
        self.server.tasks.create('pending', 'codex', str(self.project), '待确认', 'read_only',
            requested_by={'kind': 'agent', 'character_id': self.server.character})
        self.line('这些任务有什么结果')
        prompt = self.sessions[-1].calls[-1]['prompt']
        self.assertEqual(prompt.count('Tasks you dispatched recently'), 1)
        block = prompt.split('Tasks you dispatched recently', 1)[1].split('\n', 1)[0]
        rows = json.loads(block.split('): ', 1)[1])
        self.assertEqual(len(rows), 5)
        self.assertEqual({row['task_id'] for row in rows}, {task['task_id'] for task in recent[-5:]})
        self.assertTrue(all(row['target'] == 'codex' and row['state'] == 'needs_review' for row in rows))
        self.assertIn('dispatch_status', block)
        self.assertNotIn('old-task', block)
        self.assertNotIn('other-task', block)
        self.server._voice_announcement.assert_not_called()


class JobReportTests(unittest.TestCase):
    def test_a_job_report_names_the_file_without_its_path_or_a_markdown_link(self):
        from character import dispatch_report
        job = {'job_id': 'j1', 'state': 'needs_review', 'payload': {'user_request': '写成 summary.md'},
               'result': {'reply': '已写入 [summary.md](/tmp/out/run-1/summary.md)'}}
        instruction, material, _ = dispatch_report.build_job(job, None, {'artifacts': [{'path': '/tmp/out/run-1/summary.md'}]}, PROMPT_USER)
        self.assertIn('Outputs: summary.md', material)
        self.assertIn('name outputs by file name only', instruction)
        self.assertIn('with no paths or links', instruction)
