"""Product HTTP, role delivery and harness switching, using isolated domain state."""
import json
from pathlib import Path
import sys
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import ANY, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from brain.egress import EgressPolicy
from brain.provider import Mouth
from models.model_backends import DEFAULTS as MODEL_DEFAULTS
from character_agent.harness import acp_agents
from character_agent.integration import CharacterAgentController
from character_agent.services.settings import RuntimeSettings
from personal.history import History
from personal.memory import Memory
from infra.store import open_store
from sessions.tasks import TaskLedger
import test_server
from test_character_agent_runtime import FakeSession, chat


class IntegrationFixture(test_server.FeedServerCase):
    request = test_server.SayTest.request
    lines_until_final = test_server.SayTest.lines_until_final

    def setUp(self):
        super().setUp()
        self.root = Path(self.tmp.name) / 'personal'; self.root.mkdir()
        self.db = open_store(self.root / 'domain.sqlite')
        s = self.server
        domain_lock = threading.RLock()
        s.history, s.memory, s.tasks = History(self.db, lock=domain_lock, character_id=s.character), Memory(self.db, lock=domain_lock), TaskLedger(self.db, lock=domain_lock)
        s.egress = EgressPolicy()
        s.mouth = Mouth(egress=s.egress)
        self.script = chat; self.sessions = []; self.definitions = []
        self.controller = s.character_agent = CharacterAgentController(s, self.root, session_factory=self.factory)
        self.controller.discovery = SimpleNamespace(scan=lambda refresh=False: {'runtimes': [], 'scanned_at': 0})
        self.controller.configure({'backend': 'pi', 'runtime_source': 'bundled'})
        self.inputs = self.root / 'inputs'; self.inputs.mkdir(); (self.inputs / 'info.md').write_text('A quiet place.', encoding='utf-8')

    def test_startup_discards_the_codex_log_database_an_unclean_exit_left(self):
        logs = self.root / 'character-agent' / 'runner' / 'codex' / 'logs'; logs.mkdir(parents=True)
        (logs / 'logs_2.sqlite').write_text('tool result', encoding='utf-8')
        other = CharacterAgentController(self.server, self.root, session_factory=self.factory)
        other.close(); other.store.close(); other.workspace.close()
        self.assertEqual(list(logs.iterdir()), [])

    def tearDown(self):
        super().tearDown()
        self.controller.store.close(); self.controller.workspace.close(); self.db.close()

    def factory(self, definitions):
        self.definitions.append(definitions)
        # A kept session runs the script current at each run: a tap or a report turn reuses the typing turn's session.
        result = FakeSession(lambda session, prompt, options: self.script(session, prompt, options))
        self.sessions.append(result); return result

    def line(self, text='你好，请帮我整理资料', **kwargs):
        conn, response = self.open_feed()
        status, body = self.request('POST', '/say', {'text': text, **kwargs})
        self.assertEqual(status, 202, body)
        events = self.lines_until_final(response); conn.close()
        self.assertFalse(events[-1].get('error'), events)
        return body, events

    def scope_id(self):
        return self.controller.workspace.create_scope([str(self.inputs)], str(self.root / 'outputs'))['scope_id']

    def calling(self, *names):
        """Runs from now on call names first; returns their results by name."""
        script, results = self.script, {}
        def calls(session, prompt, options):
            for name in names: results[name] = options['tool_handler'](name, {})
            yield from script(session, prompt, options)
        self.script = calls
        return results


class IntegrationTests(IntegrationFixture):
    def test_a_look_on_the_role_runtime_is_accepted(self):
        self.server.capture = SimpleNamespace(share_text=False, vision=None, clear=lambda: None,
                                              look=lambda **_: (409, {"error": "vision_off", "status": "unavailable"}))
        status, body = self.request("POST", "/say", {"text": "这是什么", "look": True})
        self.assertEqual((status, body.get("command"), body.get("runtime")), (202, "look", "pi"))

    def test_role_main_session_delivers_history_without_legacy_model(self):
        body, events = self.line()
        self.assertEqual(body['runtime'], 'pi')
        self.assertEqual(''.join(e['text_delta'] for e in events), 'Hello')
        self.assertEqual(len(self.server.history.export()), 1)
        self.assertEqual(len(self.server.mouth.history), 1)
        self.assertIn('示例甲', self.sessions[0].calls[0]['system_prompt'])
        self.assertEqual(self.controller.store.get(body['run_id'])['state'], 'completed')

    def test_role_main_session_uses_the_current_characters_binding(self):
        from brain.persona import MOTION_RULE
        from character.binding import Bindings
        self.server.bindings = Bindings(self.root, self.server.characters, lambda: 'game')
        self.server.bindings.update(self.server.character, {'revision': 0, 'motion': {'driver': 'generated'},
            'persona': {'overrides': {'identity': '她是一位刚到岗的测试员。', 'post_history_instructions': '回答控制在两句以内。'}}})
        self.line()
        system = self.sessions[0].calls[0]['system_prompt']
        self.assertIn('<identity>\n她是一位刚到岗的测试员。\n</identity>', system)
        self.assertNotIn('回答控制在两句以内。', system)
        self.assertIn('<reply_style>\n回答控制在两句以内。\n</reply_style>', self.sessions[0].calls[0]['prompt'])
        self.assertIn(MOTION_RULE, system)

    def test_delivery_decisions_allow_the_next_role_conversation(self):
        for action in ('accept','reject'):
            ident='delivery-next-'+action
            self.server.tasks.create(ident,'character',str(self.root),'Synthetic report','workspace_write')
            for state in ('approved','running','returned','verifying','needs_review'):
                self.server.tasks.transition(ident,state)
            self.controller.store.begin(ident,self.server.history.conversations.active,'aster',1,delivery_eligible=True)
            self.controller.store.finish(ident,'completed',task_id=ident,dependencies=[],result={})
            self.controller._recover_deliveries()
            self.controller._recover_deliveries()
            deliveries=self.controller.deliveries.list()['deliveries']
            delivery=next(d for d in deliveries if d['run_id']==ident)
            self.assertEqual(sum(d['run_id']==ident for d in deliveries),1)
            code,decision=self.request('POST','/agent/tasks/task:'+ident+'/'+action,
                {'delivery_id':delivery['delivery_id'],'expected_revision':delivery['revision'],'generation':delivery['generation']})
            self.assertEqual(code,200,decision)
            self.assertEqual(self.request('POST','/tasks/'+ident+'/accept')[0],409)
            body,_=self.line('Continue chatting after '+action)
            self.assertEqual(self.controller.store.get(body['run_id'])['state'],'completed')

    def test_both_harnesses_can_choose_the_roles_body_facing_without_desktop_control(self):
        self.server.spatial.capabilities={'face':None}
        def face(session,prompt,options):
            yield from session.use(options,'avatar_face',{'yaw_degrees':-52,'reason':'和用户一起看资料'})
            yield from session.use(options,'avatar_facing_status',{})
            yield from chat(session,prompt,options)
        self.script=face
        for backend in ('pi','codex'):
            with self.subTest(backend=backend):
                self.controller.configure({'backend':backend,'runtime_source':'local'})
                self.line('执行侧身动作和我一起看')
                self.assertIn('avatar_face',{t['name'] for t in self.definitions[-1]})
                result=self.sessions[-1].responses[-2][2]
                self.assertTrue(result['accepted'],result)
                self.assertEqual(result['phase'],'requested')
                self.assertEqual(result['facing_yaw'],-52)
                status=self.sessions[-1].responses[-1][2]
                self.assertEqual(status['phase'],'requested')
                self.assertEqual(status['requested_yaw'],-52)

    def desktop_bridge(self):
        """Route desktop tools to a fake native client; returns (session_id, method, client) per call."""
        self.server.computer_control = object()
        self.server.sessions = Mock(sessions={}, store=None)
        calls = []
        def make(config, session_id, **kwargs):
            client = SimpleNamespace(config=config, session_id=session_id)
            client.call = lambda name, args: calls.append((session_id, name, client)) or {'ready': True}
            return client
        patcher = patch('tool_gateway.desktop.ComputerControlClient', side_effect=make)
        patcher.start(); self.addCleanup(patcher.stop)
        # desktop_task's readiness probe uses its own session, not a run's lease.
        patcher = patch('tool_gateway.computer_toolset.available', return_value=False)
        patcher.start(); self.addCleanup(patcher.stop)
        return calls

    def desktop_script(self, session, prompt, options):
        yield from session.use(options, 'desktop_status', {})
        yield from chat(session, prompt, options)

    def test_runs_in_one_conversation_share_its_desktop_grant(self):
        calls = self.desktop_bridge()
        self.addCleanup(self.controller.tools.close_all, 'shutdown')
        self.script = self.desktop_script
        self.line('查一下这个窗口')
        self.line('再查一下窗口')
        conversation = self.server.history.conversations.active
        status = [c for c in calls if c[1] == 'desktop_status']
        self.assertEqual([c[0] for c in status], ['character:' + conversation] * 2)
        self.assertIs(status[0][2], status[1][2])
        self.assertEqual([c[:2] for c in calls if c[1] != 'desktop_status'], [])
        self.assertEqual(self.controller.tools.desktop.held(), {conversation: 'character:' + conversation})

    def test_run_that_raises_still_releases_its_desktop_grant(self):
        patcher = patch('tool_gateway.desktop.IDLE_RELEASE', .05)
        patcher.start(); self.addCleanup(patcher.stop)
        calls = self.desktop_bridge()
        self.script = self.desktop_script
        runtime = self.controller._ensure_runtime()
        original = runtime.run
        def run(**kwargs):
            original(**kwargs)
            raise RuntimeError('synthetic_run_failure')
        conn, response = self.open_feed(); self.addCleanup(conn.close)
        with patch.object(runtime, 'run', run):
            status, body = self.request('POST', '/say', {'text': '查一下这个窗口'})
            self.assertEqual(status, 202, body)
            events = self.lines_until_final(response)
        self.assertTrue(events[-1].get('error'), events)
        session = 'character:' + self.server.history.conversations.active
        self.assertIn((session, 'desktop_status'), [c[:2] for c in calls])
        self.until(lambda: (session, 'desktop_release') in [c[:2] for c in calls])
        self.assertEqual(self.controller.tools.desktop.held(), {})

    def test_run_without_desktop_tools_sends_no_desktop_cancel(self):
        calls = self.desktop_bridge()
        self.line('只聊天')
        self.assertEqual(calls, [])
        self.assertEqual(self.controller.tools.desktop.held(), {})

    def test_control_panel_switch_preserves_role_and_goals_but_isolates_native_context(self):
        first = self.server.history.conversations.list()[0]
        goal = self.request('POST', '/agent/goals', {'title': '持续目标', 'objective': '核对资料'})[1]
        one, _ = self.line('first native conversation')
        self.assertEqual(self.controller.store.get(one['run_id'])['conversation_id'], first['id'])
        code, second = self.request('POST', '/conversations', {})
        self.assertEqual(code, 201)
        two, _ = self.line('second native conversation')
        self.assertEqual(self.controller.store.get(two['run_id'])['conversation_id'], second['id'])
        self.assertEqual(self.sessions[-1].calls[-1]['history'], [])
        self.assertIn('示例甲', self.sessions[-1].calls[-1]['system_prompt'])
        self.assertEqual(self.request('GET', '/agent/goals')[1]['goals'][0]['goal_id'], goal['goal_id'])
        first = self.server.history.conversations.get(first['id'])
        code, _ = self.request('POST', '/conversations/' + first['id'] + '/activate', {'expected_version': first['revision']})
        self.assertEqual(code, 200)
        self.line('continue first')
        history = self.sessions[-1].calls[-1]['history']
        self.assertEqual(history[0][0]['content'], 'first native conversation')
        self.assertFalse(any('second native conversation' in str(row) for row in history))

    def test_role_remember_command_uses_harness_and_exposes_actual_generation(self):
        def remember(session, prompt, options):
            yield from session.use(options, 'memory_propose', {'operation': 'add', 'text': '周报先列证据再给结论',
                'kind': 'preference', 'evidence_quote': '周报先列证据再给结论'})
            yield {'type': 'result', 'success': True, 'final_text': '记下了', 'usage': {}}
        self.script = remember
        body, _ = self.line('请记住：周报先列证据再给结论')
        self.assertEqual(self.server.memory.active()[0]['text'], '周报先列证据再给结论')
        status, page = self.request('GET', '/memory/runs')
        self.assertEqual(status, 200)
        self.assertEqual(page['runs'][0]['run_id'], body['run_id'])
        status, detail = self.request('GET', '/memory/runs/' + body['run_id'])
        self.assertEqual(detail['detail']['proposals'][0]['receipt']['outcome'], 'stored')
        self.assertIsNone(self.controller.store.get(body['run_id'])['task_id'])
        self.script = chat
        self.line('还记得我的周报要求吗')
        self.assertIn('周报先列证据再给结论', self.sessions[-1].calls[-1]['prompt'])

    def test_turn_context_carries_the_confirmed_facts_the_message_mentions(self):
        self.server.memory.add('我家的猫叫团子', 'asserted_by_user')
        inferred = self.server.memory.add('团子可能怕生', 'inferred_hypothesis')
        self.server.memory.add('团子喜欢纸箱', 'inferred_hypothesis', state='candidate')
        with patch.object(self.server, 'page_text_allowed', return_value=True), \
                patch.object(self.server, 'observation_paused', return_value=False):
            searched = self.controller.knowledge().call('knowledge_search', {'query': '团子', 'sources': ['memory']})
            self.assertIn(inferred, [item['id'] for item in searched['items']])
            self.line('团子最近不太吃饭')
        prompt = self.sessions[-1].calls[-1]['prompt']
        self.assertIn('share words with this message', prompt)
        self.assertIn('我家的猫叫团子', prompt)
        self.assertNotIn('团子可能怕生', prompt)
        self.assertNotIn('团子喜欢纸箱', prompt)
        self.assertGreater(prompt.index('share words with this message'), prompt.index("The user's stated preferences and agreements"))

    def test_turn_context_does_not_repeat_a_profile_item_as_a_related_fact(self):
        self.server.memory.add('团子的照片用表格整理', 'asserted_by_user', kind='preference')
        self.line('帮我看看团子的照片')
        prompt = self.sessions[-1].calls[-1]['prompt']
        self.assertEqual(prompt.count('团子的照片用表格整理'), 1)
        self.assertNotIn('share words with this message', prompt)

    def test_turn_context_keeps_one_copy_of_the_front_window_text(self):
        from observation.attention import AttentionStore
        from observation.blacklist import Blacklist
        from observation.capture import CaptureManager
        from support import deny_blacklist
        s, text, root = self.server, 'WINDOW-TEXT ' * 10, Path(self.tmp.name)
        front = {'window_id': 42, 'pid': 1234, 'app': 'Code', 'title': 'a.py'}
        (root / 'config.json').write_text(json.dumps({'share_window_text': True}), encoding='utf-8')
        black = Blacklist(deny_blacklist(root / 'blacklist.json'))
        s.attention = AttentionStore(root / 'attention.sqlite', black)
        self.addCleanup(s.attention.close)
        s.attention.ingest({'ts': time.time(), 'idle_s': 0, 'front': front})
        s.privacy_config = str(root / 'config.json')
        s.capture = CaptureManager(s.feed, black, lambda: front, root / 'capture.log', share_text=True)
        s.sync_privacy()
        s.capture.text({**front, 'text': text, 'source': 'ax', 'secure_input': False})
        sources = [{'preview': text[:50], 'total_chars': 50}]  # another, shorter source
        with patch.object(self.controller.observations, 'context', lambda: {'available': True, 'current_sources': sources}):
            self.line('你好')
            prompt = self.sessions[-1].calls[-1]['prompt']
            self.assertIn("Text in the user's front window", prompt)  # control
            sources[:] = [{'preview': text, 'total_chars': len(text)}]
            self.line('你好')
            prompt = self.sessions[-1].calls[-1]['prompt']
        self.assertNotIn("Text in the user's front window", prompt)
        self.assertEqual(prompt.count('WINDOW-TEXT'), 10)

    def test_turn_context_without_related_facts_adds_no_section(self):
        self.server.memory.add('周末去爬山', 'asserted_by_user')
        self.line('你好')
        prompt = self.sessions[-1].calls[-1]['prompt']
        self.assertNotIn('share words with this message', prompt)
        self.assertNotIn('周末去爬山', prompt)

    def test_generation_endpoints_are_private_and_temporary_turn_keeps_no_content(self):
        for path in ('/memory/runs', '/memory/runs/one', '/character/capabilities'):
            self.assertEqual(self.request('GET', path, token='hook-token')[0], 401)
        results = self.calling('memory_propose')
        self.line('查一下资料，这轮不保存生成内容', no_memory=True)
        self.assertEqual(self.request('GET', '/memory/runs')[1]['runs'], [])
        self.assertEqual(results['memory_propose']['error']['code'], 'tool_not_allowed_in_mode')
        self.assertEqual(self.request('GET', '/memory/runs?limit=0')[0], 400)
        self.assertEqual(self.request('GET', '/memory/runs/missing')[0], 404)

    def test_history_clear_removes_generation_inputs_and_reset_classifies_tables(self):
        self.line('查一下资料，生成记录只在授权范围内保留')
        self.assertEqual(len(self.request('GET', '/memory/runs')[1]['runs']), 1)
        self.assertEqual(self.request('DELETE', '/history')[0], 200)
        self.assertEqual(self.request('GET', '/memory/runs')[1]['runs'], [])

    def test_chat_backend_switch_and_targeted_cancel_do_not_abort_other_background_work(self):
        started = {'后台甲': threading.Event(), '后台乙': threading.Event()}
        release = threading.Event()
        def work(session, prompt, options):
            marker = next((m for m in started if m in prompt), None)
            if marker:
                started[marker].set()
                while not release.wait(.01) and not options['cancelled'](): pass
                yield {'type': 'result', 'success': not options['cancelled'](), 'final_text': '后台资料核查结束', 'usage': {}}
            else: yield from chat(session, prompt, options)
        self.script = work
        one = self.controller.submit_job('甲', '后台甲', '核查甲', self.scope_id())
        two = self.controller.submit_job('乙', '后台乙', '核查乙', self.scope_id())
        try:
            self.assertTrue(started['后台甲'].wait(3)); self.assertTrue(started['后台乙'].wait(3))
            self.controller.configure({'backend': 'codex', 'runtime_source': 'local'})
            self.line('继续聊一下今天的安排')
            self.assertEqual([self.controller.jobs.store.get(j['job_id'])['state'] for j in (one, two)], ['running', 'running'])
            self.assertTrue(self.controller.jobs.cancel(one['job_id']))
            self.assertEqual(self.controller.jobs.store.get(two['job_id'])['state'], 'running')
            release.set()
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline and self.controller.jobs.store.get(two['job_id'])['state'] == 'running': time.sleep(.01)
            self.assertEqual(self.controller.jobs.store.get(two['job_id'])['state'], 'needs_review')
            self.assertEqual(self.controller.jobs.store.get(one['job_id'])['state'], 'cancelled')
        finally:
            release.set(); self.controller.jobs.close()

    def background_question(self):
        def script(session, prompt, options):
            if 'background_assignment' in prompt:
                yield from session.use(options, 'ask_user', {'questions': [{'id': 'use', 'question': 'private-background-question'}]})
            else:
                yield from session.use(options, 'background_start', {'title': '核查', 'instruction': '先询问用途'})
            yield from chat(session, prompt, options)
        self.script = script
        submitted, _ = self.line('在后台查一下资料，先询问用途')
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            rows = self.request('GET', '/agent/interactions')[1]['requests']
            if rows: return submitted, self.request('GET', '/agent/jobs')[1]['jobs'][0], rows[0]
            time.sleep(.01)
        self.fail('background question not reached')

    def test_background_job_run_and_interaction_keep_foreground_turn_ownership(self):
        conversation = self.server.history.conversations.active
        submitted, job, interaction = self.background_question()
        self.assertEqual(self.request('POST', '/conversations', {})[0], 201)
        self.assertEqual(job['conversation_id'], conversation)
        self.assertEqual(job['source_turn_id'], submitted['run_id'])
        self.assertEqual(self.controller.store.get(job['run_id'])['conversation_id'], conversation)
        self.assertEqual(interaction['conversation_id'], conversation)
        self.assertEqual(interaction['run_id'], job['run_id'])
        self.assertEqual((job['generation'], interaction['generation']), (0, 0))

    def test_delete_conversation_removes_owned_background_text_and_preserves_other_jobs(self):
        conversation = self.server.history.conversations.get(self.server.history.conversations.active)
        submitted, job, interaction = self.background_question()
        self.assertEqual(self.request('POST', '/conversations', {})[0], 201)
        other = self.controller.jobs.store.submit('保留', {'user_request': 'other-private-text'})
        conversation = self.server.history.conversations.get(conversation['id'])
        code, body = self.request('DELETE', '/conversations/' + conversation['id'], {'expected_version': conversation['revision']})
        self.assertEqual(code, 200, body)
        self.assertIsNone(self.controller.jobs.store.get(job['job_id'], private=True))
        self.assertIsNone(self.controller.interactions.get(interaction['request_id']))
        self.assertIsNone(self.controller.store.get(job['run_id']))
        self.assertIsNone(self.controller.store.get(submitted['run_id']))
        self.assertIsNotNone(self.controller.jobs.store.get(other['job_id']))
        for table in ('personal_job_events', 'personal_job_leases'):
            self.assertEqual(self.db.execute('SELECT COUNT(*) FROM ' + table + ' WHERE job_id=?', (job['job_id'],)).fetchone()[0], 0)

    def test_goal_and_background_endpoints_are_authenticated_and_metadata_is_not_success(self):
        for path in ('/agent/goals', '/agent/jobs'):
            self.assertEqual(self.request('GET', path, token='hook-token')[0], 401)
        status, goal = self.request('POST', '/agent/goals', {'title': '核查费用', 'objective': '持续整理费用证据'})
        self.assertEqual(status, 201)
        self.assertEqual(self.request('POST', '/agent/goals/' + goal['goal_id'], {'expected_version': 1, 'state': 'completed'})[0], 400)
        self.line('普通聊天无需建立长期目标')
        self.assertEqual(len(self.request('GET', '/agent/goals')[1]['goals']), 1)

    def test_expired_worker_lease_is_reconciled_before_explicit_continuation(self):
        payload = {'user_request': '核查资料', 'instruction': '只核查已授权内容', 'scope_id': None,
            'config': self.controller.settings.snapshot(), 'character_id': self.server.character, 'consent_epoch': 0}
        job = self.controller.jobs.store.submit('未完成任务', payload)
        self.controller.jobs.store.claim('crashed-owner')
        self.controller._recover_jobs()
        self.assertEqual(self.controller.jobs.store.get(job['job_id'])['state'], 'running')
        with self.server.memory.lock:
            self.db.execute('UPDATE personal_job_leases SET expires_at=0'); self.db.commit()
        self.controller._recover_jobs()
        self.assertEqual(self.controller.jobs.store.get(job['job_id'])['state'], 'interrupted')
        resumed = self.controller.resume_job(job['job_id'])
        self.assertEqual(resumed['job_id'], job['job_id'])
        self.assertNotEqual(resumed['run_id'], job['run_id'])
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and self.controller.jobs.store.get(job['job_id'])['state'] in ('running', 'queued'): time.sleep(.01)
        self.assertEqual(self.controller.jobs.store.get(job['job_id'])['state'], 'needs_review')
        self.controller.jobs.close()

    def test_memory_change_revokes_retained_generation_details(self):
        self.line('查一下生成记录中已授权的来源')
        ident = self.controller.memory_journal.list()[0]['run_id']
        self.controller.cancel('context_changed')
        self.assertIsNone(self.controller.memory_journal.get(ident)['detail'])

    def test_context_change_redacts_a_run_that_read_observations_without_deliveries(self):
        self.controller.deliveries = None
        store = self.controller.store
        store.begin('observed-run', 'c' * 32, self.server.character, 0)
        store.item({'run_id': 'observed-run', 'item_id': 'said', 'seq': 1, 'kind': 'assistant_text', 'status': 'completed',
                    'summary': 'the editor shows a failing build', 'text': 'the editor shows a failing build'})
        store.finish('observed-run', 'completed', dependencies=[{'source': 'observations', 'id': 'frame-1', 'version': 1, 'hash': ''}])
        self.controller.cancel('context_changed')
        [item] = store.items('observed-run')
        self.assertEqual((item['text'], item['summary']), ('', None))

    def parent_background(self):
        release, started = threading.Event(), threading.Event()
        def work(session, prompt, options):
            if 'background_assignment' in prompt:
                started.set()
                while not release.wait(.01) and not options['cancelled'](): pass
                yield {'type': 'result', 'success': not options['cancelled'](), 'final_text': '资料检查已返回', 'usage': {}}
            else:
                yield from session.use(options, 'task_plan', {'title': '后台资料整理', 'outputs': ['report.md']})
                yield from session.use(options, 'background_start', {'title': '核查资料', 'instruction': '只读核查已授权资料'})
                yield {'type': 'result', 'success': True, 'final_text': '已启动后台任务，可以继续聊天。', 'usage': {}}
        self.script = work
        body, events = self.line('在后台整理资料，先告诉我已经启动', scope_id=self.scope_id())
        self.assertTrue(started.wait(3))
        self.assertIn('已启动后台任务', ''.join(e['text_delta'] for e in events))
        run = self.controller.store.get(body['run_id'])
        self.assertEqual(self.server.tasks.get(run['task_id'])['state'], 'running')
        return run, release

    def test_parent_plan_does_not_fail_before_background_files_exist(self):
        run, release = self.parent_background()
        try:
            release.set(); deadline = time.monotonic() + 3
            while time.monotonic() < deadline and self.server.tasks.get(run['task_id'])['state'] in ('running', 'returned', 'verifying'): time.sleep(.01)
            task = self.server.tasks.get(run['task_id'])
            self.assertEqual(task['state'], 'needs_review')
            self.assertEqual(task['result']['validation_scope'], 'child_tasks_only')
        finally:
            release.set(); self.controller.jobs.close()

    def test_cancelling_parent_task_targets_its_background_children(self):
        run, release = self.parent_background()
        try:
            self.assertTrue(self.controller.cancel_task(run['task_id']))
            self.assertEqual(self.server.tasks.get(run['task_id'])['state'], 'cancelled')
            self.assertEqual(self.controller.jobs.store.list()[0]['state'], 'cancelled')
        finally:
            release.set(); self.controller.jobs.close()

    def test_b3_turn_with_a_scope_names_its_material(self):
        sheet = self.root / 'expenses.csv'
        sheet.write_text('类别,金额\n差旅,480\n', encoding='utf-8')
        picked = self.controller.workspace.create_scope(files=[str(sheet)])['scope_id']
        self.line('汇总一下', scope_id=picked)
        prompt = self.sessions[-1].calls[-1]['prompt']
        self.assertIn('Selected material (read it with your own file tools', prompt)
        self.assertIn(str(sheet), prompt)
        self.assertNotIn('workspace_list', prompt)
        self.line('汇总一下', scope_id=self.scope_id())
        self.assertIn(str(self.inputs) + '/', self.sessions[-1].calls[-1]['prompt'])
        self.line('你好')
        self.assertNotIn('Selected material', self.sessions[-1].calls[-1]['prompt'])

    def test_b3_task_continue_resumes_a_foreground_task_in_the_background(self):
        seen, release = {}, threading.Event()
        def work(session, prompt, options):
            if 'background_assignment' in prompt:
                seen['background'] = prompt
                while not release.wait(.01) and not options['cancelled'](): pass
            elif '整理' in prompt:
                yield from session.use(options, 'task_plan', {'title': '报销汇总', 'outputs': []})
            elif '接着' in prompt:
                for key in ('first', 'again'):
                    seen[key] = yield from session.use(options, 'task_continue',
                        {'task_id': seen['task_id'], 'instruction_quote': '接着刚才那个继续'})
            yield {'type': 'result', 'success': True, 'final_text': '好', 'usage': {}}
        self.script = work
        scope = self.scope_id()
        try:
            body, _ = self.line('整理报销汇总', scope_id=scope)
            first_run = body['run_id']
            seen['task_id'] = self.controller.store.get(first_run)['task_id']
            self.line('接着刚才那个继续', scope_id=scope)
            self.assertNotIn('error', seen['first'], seen['first'])
            job_id = seen['first']['job_id']
            release.set(); deadline = time.monotonic() + 3
            while time.monotonic() < deadline and self.controller.jobs.store.get(job_id)['state'] in ('queued', 'running'): time.sleep(.01)
            job = self.controller.jobs.store.get(job_id, private=True)
            resumed = self.controller.store.get(job['run_id'])
        finally:
            release.set(); self.controller.jobs.close()
        self.assertEqual(job['payload']['resume_run_id'], first_run)
        self.assertEqual(job['payload']['scope_id'], scope)
        self.assertEqual(job['title'], '报销汇总')
        self.assertIn('background', seen)
        self.assertEqual(resumed['task_id'], seen['task_id'])
        # The second call in the same turn finds the queued job by the run it resumes; it opens no second job.
        self.assertEqual(seen['again'].get('error', {}).get('code'), 'job_not_resumable')
        self.assertEqual(len(self.controller.jobs.store.list(limit=None)), 1)

    def test_b3_index_lists_foreground_tasks_but_not_background_ones(self):
        def work(session, prompt, options):
            if 'background_assignment' in prompt or '整理' in prompt:
                yield from session.use(options, 'task_plan',
                    {'title': '后台报表' if 'background_assignment' in prompt else '报销汇总', 'outputs': []})
            yield {'type': 'result', 'success': True, 'final_text': '好', 'usage': {}}
        self.script = work
        scope = self.scope_id()
        try:
            job = self.controller.submit_job('后台报表', '后台做报表', '后台做报表', scope)
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline and self.controller.jobs.store.get(job['job_id'])['state'] in ('queued', 'running'): time.sleep(.01)
            background = self.controller.store.get(self.controller.jobs.store.get(job['job_id'])['run_id'])['task_id']
            body, _ = self.line('整理报销汇总', scope_id=scope)
            task_id = self.controller.store.get(body['run_id'])['task_id']
            self.line('接着刚才那个继续', scope_id=scope)
            prompt, system = self.sessions[-1].calls[-1]['prompt'], self.sessions[-1].calls[-1]['system_prompt']
            self.line('临时问一句', no_memory=True)
            temporary = self.sessions[-1].calls[-1]['prompt']
        finally: self.controller.jobs.close()
        self.assertIsNotNone(background)
        index = json.JSONDecoder().raw_decode(prompt, prompt.index('{', prompt.index('Goals and background work')))[0]
        tasks = {task['task_id']: task for task in index['tasks']}
        self.assertEqual(set(tasks[task_id]), {'task_id', 'title', 'state', 'updated_at', 'same_conversation'})
        self.assertEqual(tasks[task_id]['title'], '报销汇总')
        self.assertTrue(tasks[task_id]['same_conversation'])
        self.assertNotIn(background, tasks)
        self.assertNotIn(task_id, temporary)
        self.assertIn('task_continue, not a new task_plan', system)

    def test_failed_job_carries_readable_reason(self):
        codes = iter(['auth_expired', 'unknown'])
        def failing(session, prompt, options):
            yield {'type': 'result', 'success': False, 'error': 'api_error', 'failure': {'code': next(codes), 'private': 'secret'}}
        self.script = failing
        try:
            for reason in ('auth_expired', None):
                job = self.controller.submit_job('核对', '核对资料', '核对资料')
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline and self.controller.jobs.store.get(job['job_id'])['state'] in ('queued', 'running'): time.sleep(.01)
                row = self.controller.jobs.store.get(job['job_id'])
                self.assertEqual(row['state'], 'failed')
                self.assertEqual((row['result']['error'], row['result']['reason']), ('api_error', reason))
        finally: self.controller.jobs.close()

    def settled(self, job):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and self.controller.jobs.store.get(job['job_id'])['state'] in ('queued', 'running'):
            time.sleep(.01)
        return self.controller.jobs.store.get(job['job_id'])

    def test_a_job_whose_run_never_began_settles_failed_with_its_error(self):
        from character_agent.runtime import AgentReply
        with patch('character_agent.integration.PersonalAgentRuntime.run', return_value=AgentReply(error='checkpoint_inputs_changed')):
            row = self.settled(self.controller.submit_job('核对', '核对资料', '核对资料'))
        self.assertEqual((row['state'], row['result']['error']), ('failed', 'checkpoint_inputs_changed'))

    def test_a_goal_whose_accepted_job_delivered_text_can_be_completed(self):
        goal = self.controller.jobs.store.create_goal('成本', '比较成本')
        job = self.controller.submit_job('核对成本', '仅回复文字', '比较成本并给出建议', goal_id=goal['goal_id'])
        self.assertEqual(self.settled(job)['state'], 'needs_review')
        store = self.controller.jobs.store
        with store.lock:
            store.db.execute("UPDATE personal_jobs SET state='accepted' WHERE job_id=?", (job['job_id'],)); store.db.commit()
        revision = store.goal(goal['goal_id'])['revision']
        self.assertEqual(self.controller.update_goal(goal['goal_id'], revision, 'completed')['state'], 'completed')

    def test_job_endpoint_rejects_malformed_goal_ids_and_action_gets(self):
        for value in ([],{},True,42,'','x'*129):
            status,body=self.request('POST','/agent/jobs',{'title':'资料核对','text':'核对资料','goal_id':value})
            self.assertEqual((status,body['error']),(400,'invalid_job_goal'))
        job=self.controller.jobs.store.submit('仅供接口检查',{'user_request':'synthetic'})
        for action in ('cancel','resume'):
            status,body=self.request('GET','/agent/jobs/'+job['job_id']+'/'+action)
            self.assertEqual((status,body['error']),(404,'not_found'))
        self.assertEqual(self.controller.jobs.store.get(job['job_id'])['state'],'queued')

    def test_job_endpoint_takes_a_null_scope_and_falls_back_only_when_the_key_is_absent(self):
        snapshot = self.controller.settings.snapshot
        with patch.object(self.controller.settings, 'snapshot', lambda: {**snapshot(), 'scope_id': 'default-scope'}), \
                patch.object(self.controller, 'submit_job', return_value={'job_id': 'j'}) as submit:
            for body, scope in (({'scope_id': None}, None), ({}, 'default-scope'), ({'scope_id': 'picked'}, 'picked')):
                status, _ = self.request('POST', '/agent/jobs', {'title': '资料核对', 'text': '核对资料', **body})
                self.assertEqual((status, submit.call_args.args[3]), (202, scope))

    def test_goal_tool_updates_state_with_version_check(self):
        from character_agent.services.orchestration import OrchestrationTurn
        goal=self.controller.jobs.store.create_goal('事项维护','整理证据')
        turn=OrchestrationTurn(self.controller,'处理目标',self.controller.settings.snapshot(),'aster',None,'tool-test')
        turn.open(lambda:True)
        self.assertEqual(turn.call('goal_update',{'goal_id':goal['goal_id'],'expected_version':2,'state':'paused'})['error']['code'],'goal_version_changed')
        self.assertEqual(turn.call('goal_update',{'goal_id':goal['goal_id'],'expected_version':1,'state':'paused'})['state'],'paused')
        self.assertEqual(turn.call('goal_update',{'goal_id':goal['goal_id'],'expected_version':2,'state':'cancelled'})['state'],'cancelled')

    def test_background_assignment_is_material_not_a_system_instruction(self):
        seen=[]
        def script(session,prompt,options):
            seen.append((prompt,options['system_prompt']))
            yield {'type':'result','success':True,'final_text':'依最新用户补充执行'}
        self.script=script
        job=self.controller.submit_job('核对','按最新要求只核对资料','OLD-PLANNER-INSTRUCTION',self.scope_id())
        deadline=time.monotonic()+3
        while time.monotonic()<deadline and self.controller.jobs.store.get(job['job_id'])['state'] in ('running','queued'):time.sleep(.01)
        self.assertTrue(seen)
        self.assertIn('OLD-PLANNER-INSTRUCTION',seen[0][0]);self.assertNotIn('OLD-PLANNER-INSTRUCTION',seen[0][1])
        self.assertIn('按最新要求只核对资料',seen[0][0])
        self.assertIn('Use task_plan only when the job must produce files', seen[0][1])

    def test_bridged_background_job_gets_the_authorized_paths(self):
        seen = []
        def script(session, prompt, options):
            seen.append(options['system_prompt'])
            yield {'type': 'result', 'success': True, 'final_text': '已核对'}
        self.script = script
        self.controller.configure({'backend': 'codex', 'runtime_source': 'local'})
        job = self.controller.submit_job('核对', '核对资料', '核对资料', self.scope_id())
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and self.controller.jobs.store.get(job['job_id'])['state'] in ('running', 'queued'):
            time.sleep(.01)
        self.assertTrue(seen)
        self.assertIn(str(self.inputs), seen[0])

    def test_background_assignment_and_bridged_paths_pass_egress(self):
        seen = []
        def script(session, prompt, options):
            seen.append(prompt + options['system_prompt'])
            yield {'type': 'result', 'success': True, 'final_text': '已核对'}
        self.script = script
        self.controller.configure({'backend': 'codex', 'runtime_source': 'local'})
        folder = self.root / 'token=folder-secret-1234'; folder.mkdir()
        scope = self.controller.workspace.create_scope([str(folder)], str(self.root / 'outputs'))['scope_id']
        job = self.controller.submit_job('核对', '核对资料', '计划：用 sk-abcdefghijklmnopqrstuvwx 登录', scope)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and self.controller.jobs.store.get(job['job_id'])['state'] in ('running', 'queued'):
            time.sleep(.01)
        self.assertTrue(seen)
        self.assertIn('计划：用 [已遮蔽:密钥] 登录', seen[0])
        self.assertNotIn('sk-abcdefghijklmnopqrstuvwx', seen[0]); self.assertNotIn('folder-secret-1234', seen[0])

    def test_background_without_a_folder_delivers_text_without_file_planning(self):
        seen = []
        def script(session, prompt, options):
            seen.append(options['system_prompt'])
            yield {'type': 'result', 'success': True, 'final_text': '选择成本较低的方案。'}
        self.script = script
        job = self.controller.submit_job('核对成本', '仅回复文字', '比较成本并给出建议')
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and self.controller.jobs.store.get(job['job_id'])['state'] in ('running', 'queued'):
            time.sleep(.01)
        self.assertIn('without task_plan or file tools', seen[0])
        self.assertEqual(self.controller.jobs.store.get(job['job_id'])['state'], 'needs_review')

    def test_background_job_reads_its_conversations_last_six_turns_through_egress(self):
        seen = []
        def script(session, prompt, options):
            seen.append((prompt, options['system_prompt']))
            yield {'type': 'result', 'success': True, 'final_text': '已核对'}
        self.script = script
        for n in range(8):
            self.server.history.record(turn_id=f'turn-{n}', source='text', character_id='aster', persona_revision='v1',
                user_text=f'第{n}问 mail-{n}@example.com sk-abcdefghijklmnopqrstu{n}', reply=f'第{n}答 reply-{n}@example.com',
                state='completed', started_at=time.time())
        job = self.controller.submit_job('核对', '核对资料，回电 13812345678', '核对资料', self.scope_id())
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and self.controller.jobs.store.get(job['job_id'])['state'] in ('running', 'queued'): time.sleep(.01)
        prompt, system = seen[0]
        self.assertIn('recent_conversation', prompt)
        self.assertNotIn('第1问', prompt)
        for n in range(2, 8):
            self.assertIn(f'第{n}问 mail-{n}@example.com [已遮蔽:密钥]', prompt); self.assertIn(f'第{n}答 [已遮蔽:邮箱]', prompt)
        self.assertIn('核对资料，回电 13812345678', prompt)
        self.assertNotIn('reply-7@example.com', prompt); self.assertNotIn('sk-abcdefghijklmnopqrstu', prompt)
        self.assertNotIn('第7问', system)

    def test_the_users_own_words_keep_contacts_but_not_keys(self):
        from datetime import datetime, timedelta, timezone
        from personal.commitments import Commitments
        self.server.commitments = Commitments(self.db, lock=self.server.memory.lock)
        due = (datetime.now(timezone.utc) + timedelta(days=1)).replace(microsecond=0)
        words = '明天上午十点提醒我给 13812345678 打电话，再发邮件给 alice@example.com'
        def script(session, prompt, options):
            yield from session.use(options, 'reminder_create', {'text': '给 13812345678 打电话', 'due_at': due.isoformat(),
                                                                 'instruction_quote': words})
            yield from chat(session, prompt, options)
        self.script = script
        self.line(words + '，令牌 sk-abcdefghijklmnopqrstuvwx')
        prompt = self.sessions[-1].calls[0]['prompt']
        self.assertIn(words + '，令牌 [已遮蔽:密钥]', prompt)
        self.assertNotIn('sk-abcdefghijklmnopqrstuvwx', prompt)
        self.assertEqual([i['text'] for i in self.server.commitments.list()], ['给 13812345678 打电话'], self.sessions[-1].responses)

    def test_foreground_system_prompt_hands_heavy_work_to_the_background(self):
        self.line()
        system = self.sessions[0].calls[0]['system_prompt']
        for rule in ('Writing files, several tool steps or over 20 seconds: say you are starting, then background_start first, without '
                     'reading or planning here', 'Answerable from context, memory or one read: answer here.',
                     'never state or guess a background result before it ends'):
            self.assertIn(rule, system)

    def test_generation_api_only_exposes_current_harness_journal_and_redacts(self):
        journal = self.controller.memory_journal
        turn = journal.turn('semantic-test', '', 'codex', 'native', 'aster', {'sources':['evidence']}, purpose='memory_extract')
        turn.open(lambda:True); turn.record('validation', {'outcome':'no_new_knowledge'}); turn.finish('completed', '{}')
        self.assertEqual(self.request('GET','/memory/runs')[1]['runs'][0]['run_id'], 'semantic-test')
        # An extraction shows its request only after its domain transaction commits.
        self.assertEqual(self.request('GET','/memory/runs/semantic-test')[1]['detail']['request'], '')
        with journal.memory.lock:
            journal.memory.db.execute('BEGIN')
            turn.commit_extraction({'no_new_knowledge':True,'accepted':[],'rejected':[]}, [])
            journal.memory.db.commit()
        self.assertIn('evidence', self.request('GET','/memory/runs/semantic-test')[1]['detail']['request'])
        self.controller.cancel('memory_changed')
        self.assertIsNone(self.request('GET','/memory/runs/semantic-test')[1]['detail'])

    def test_automatic_episode_is_readable_without_browser_grant_and_cites_real_sources(self):
        from personal.episodes import Episodes
        self.server.episodes=Episodes(self.db,lock=self.server.memory.lock)
        self.server.history.record(turn_id='planning-turn',source='text',character_id='aster',persona_revision='v1',
            user_text='预算300，场地必须无障碍。',reply='尚未预订。',state='completed',started_at=time.time())
        value={'no_new_knowledge':False,'title':'会务预算','summary':'预算300，需无障碍，尚未预订。',
            'projects':[{'subject':'会务','goal':'制定无障碍方案','evidence':['history:planning-turn'],
                'constraints':['预算300'],'decisions':[],'outcome':'尚未预订','unresolved':['日期待定'],'next_steps':['确认日期']}],
            'memories':[]}
        def script(session,prompt,options):
            yield {'type':'result','success':True,'final_text':json.dumps(value,ensure_ascii=False)}
        self.script=script
        result=self.controller.memory_pipeline.run_once();self.assertEqual(result['state'],'committed')
        import datetime
        day=datetime.date.today().isoformat()
        status,body=self.request('GET','/episodes?date='+day)
        self.assertEqual(status,200);self.assertTrue(body['enabled'])
        episode=body['episodes'][0];self.assertEqual(episode['version'],3)
        self.assertEqual(episode['threads'][0]['evidence'],[1])
        status,evidence=self.request('GET',f"/episodes/{episode['id']}/evidence")
        self.assertEqual(status,200);self.assertEqual(evidence['lines'][0]['n'],1)
        self.assertIn('预算300',evidence['lines'][0]['text'])
        self.assertEqual(evidence['run']['outcome'],'committed')
        status,edited=self.request('PATCH',f"/episodes/{episode['id']}",{'title':'人工核对后的方案','description':'保留完整事项依据。'*30})
        self.assertEqual(status,200);self.assertTrue(edited['episode']['edited'])

    def test_backend_switch_keeps_product_history_and_closes_old_session(self):
        self.line('第一轮')
        status, _ = self.request('PUT', '/character/runtime', {'backend': 'codex', 'runtime_source': 'local'})
        self.assertEqual(status, 200)
        self.line('记得上一轮吗')
        self.assertTrue(self.sessions[0].closed)
        self.assertEqual(self.sessions[1].calls[0]['history'][0][0]['content'], '第一轮')
        self.assertEqual(len(self.server.history.export()), 2)

    def test_next_idle_turn_reuses_session_and_forget_closes_it(self):
        self.line('第一轮')
        self.line('第二轮')
        self.assertEqual(len(self.sessions), 1)
        self.assertEqual(len(self.sessions[0].calls), 2)
        self.controller.forget()
        self.assertEqual(self.sessions[0].closed, 1)

    def test_new_endpoints_require_ui_token_not_hook_token(self):
        for method, path, body in [('GET', '/character/runtime', None), ('GET', '/agent/scopes', None),
                                  ('POST', '/agent/scopes', {}), ('GET', '/agent/runs', None)]:
            self.assertEqual(self.request(method, path, body, token=test_server.HOOK)[0], 401)

    def test_runtime_get_rescans_only_on_refresh(self):
        scans = []
        self.controller.discovery = SimpleNamespace(scan=lambda refresh=False: scans.append(refresh) or
                                                    {'runtimes': [], 'scanned_at': 0})
        self.assertEqual(self.request('GET', '/character/runtime')[0], 200)
        self.assertNotIn(True, scans)
        self.assertEqual(self.request('GET', '/character/runtime?refresh=1')[0], 200)
        self.assertIn(True, scans)

    def test_runtime_put_answers_from_cached_discovery(self):
        scans = []
        row = {'backend': 'codex', 'runtime_source': 'local_cli', 'path': '/synthetic/codex', 'version': 'test',
               'entry_supported': True, 'boundary_verified': True, 'authenticated': True}
        self.controller.discovery = SimpleNamespace(scan=lambda refresh=False: scans.append(refresh) or
                                                    {'runtimes': [row], 'scanned_at': 0})
        interactive = self.controller.settings.snapshot()['interactive_tools']
        for body in ({'interactive_tools': interactive}, {'interactive_tools': not interactive},
                     {'backend': 'codex', 'runtime_source': 'local'}):
            with self.subTest(body=body):
                status, value = self.request('PUT', '/character/runtime', body)
                self.assertEqual(status, 200, value)
                self.assertNotIn(True, scans)
                self.assertEqual([r['path'] for r in value['installed_runtimes']], ['/synthetic/codex'])

    def test_scope_create_list_revoke_and_invalid_say_contract(self):
        status, scope = self.request('POST', '/agent/scopes', {'roots': [str(self.inputs)], 'output_root': str(self.root/'out')})
        self.assertEqual(status, 201, scope)
        self.assertEqual(len(self.request('GET', '/agent/scopes')[1]['scopes']), 1)
        status, body = self.request('POST', '/say', {'text': '整理', 'expected_outputs': {'artifacts': [{'path': '../escape.md'}]}})
        self.assertEqual(status, 400, body)
        self.assertEqual(self.request('POST', '/agent/scopes/'+scope['scope_id']+'/revoke', {})[0], 200)
        self.assertEqual(self.request('POST', '/say', {'text': '整理', 'scope_id': scope['scope_id']})[0], 409)

    def test_artifact_revert_route_restores_the_previous_version(self):
        workspace = self.controller.workspace; scope = self.scope_id()
        first = workspace.write_artifact(scope, 'run-1', 'report.md', 'first')
        workspace.write_artifact(scope, 'run-1', 'report.md', 'second', expected_version=1)
        status, body = self.request('POST', '/agent/artifacts/revert', {'run_id': 'run-1', 'path': 'report.md', 'expected_version': '2'})
        self.assertEqual((status, body), (400, {'error': 'invalid_payload'}))
        status, body = self.request('POST', '/agent/artifacts/revert', {'run_id': 'run-1', 'path': 'report.md', 'expected_version': 2})
        self.assertEqual(status, 200, body)
        self.assertEqual(body, workspace.run_artifacts('run-1')[0])
        self.assertEqual(body['version'], 3)
        self.assertEqual(Path(first['absolute_path']).read_text(encoding='utf-8'), 'first')

    def test_native_login_does_not_require_product_api_key(self):
        self.controller.configure({'backend':'codex', 'runtime_source':'local'})
        row = {'backend':'codex', 'runtime_source':'local_cli', 'path':'/synthetic/codex',
               'entry_supported':True, 'boundary_verified':True, 'authenticated':True, 'version':'test'}
        with patch.object(self.controller, 'installed_runtimes', return_value=[row]), \
             patch.object(self.controller, '_credential', side_effect=AssertionError('must not read API key')):
            self.controller.session_factory_override = None
            self.assertTrue(self.controller.public()['ready'])

    def test_switching_backend_drops_the_old_kernels_executable(self):
        self.controller.configure({'backend': 'codex', 'runtime_source': 'local', 'executable': '/opt/homebrew/bin/codex'})
        self.controller.configure({'model': 'm2'})
        self.assertEqual(self.controller.settings.snapshot()['executable'], '/opt/homebrew/bin/codex')
        self.controller.configure({'backend': 'claude', 'runtime_source': 'local', 'auth_source': 'existing_login', 'provider': ''})
        self.assertIsNone(self.controller.settings.snapshot()['executable'])
        self.controller.configure({'backend': 'codex', 'executable': '/opt/homebrew/bin/codex'})
        self.assertEqual(self.controller.settings.snapshot()['executable'], '/opt/homebrew/bin/codex')

    def test_product_login_is_ready_only_when_the_apps_own_profile_is_signed_in(self):
        self.controller.settings.save({'backend':'codex','runtime_source':'local','auth_source':'product_login'})
        # The user's own login does not count for the app's profile.
        row = {'backend':'codex', 'runtime_source':'local_cli', 'path':'/synthetic/codex',
               'entry_supported':True, 'boundary_verified':True, 'authenticated':True, 'version':'test'}
        self.controller.session_factory_override = None
        for signed_in, error in ((False, 'product_login_required'), (None, 'product_login_checking'), (True, None)):
            with self.subTest(signed_in=signed_in), patch.object(self.controller, 'installed_runtimes', return_value=[row]), \
                    patch.object(self.controller.logins, 'signed_in', return_value=signed_in) as probe:
                self.assertEqual(self.controller.public()['error'], error)
                self.assertEqual(probe.call_args.args[:2], ('codex', '/synthetic/codex'))
        self.assertEqual(self.controller.public()['product_login'], {'pending': None, 'error': None, 'detail': None, 'accounts': {}})

    def test_login_route_signs_in_the_saved_kernel(self):
        from character_agent.routes import http
        calls = []
        def post(path, body):
            handler = SimpleNamespace(path=path, server=self.server, auth=lambda token: True, body=lambda: body,
                                      json=lambda status, data: calls.append((status, data)))
            self.assertTrue(http.route(handler, 'POST', path))
            return calls[-1]
        self.controller.settings.save({'backend': 'codex', 'runtime_source': 'local', 'auth_source': 'existing_login'})
        self.assertEqual(post('/character/login/start', {}), (400, {'error': 'product_login_not_selected'}))
        self.controller.settings.save({'backend': 'codex', 'runtime_source': 'local', 'auth_source': 'product_login'})
        row = {'backend': 'codex', 'path': '/synthetic/codex', 'entry_supported': True, 'authenticated': False}
        with patch.object(self.controller, '_selected_runtime', return_value=row), \
                patch.object(self.controller.logins, 'start', return_value={'pending': 'codex'}) as start:
            self.assertEqual(post('/character/login/start', {}), (200, {'pending': 'codex'}))
            start.assert_called_once_with('codex', '/synthetic/codex')
        self.assertEqual(post('/character/login/logout', {'method_id': 'x'}), (400, {'error': 'invalid_payload'}))
        agent = {'id': 'claude-acp', 'name': 'Claude Agent', 'command': ['/synthetic/claude-agent-acp'], 'source': 'local'}
        # A method that takes an API key or a gateway needs input the page does not collect: no default.
        methods = [{'id': 'api-key', '_meta': {'api-key': {'provider': 'openai'}}},
                   {'id': 'claude-ai-login', 'type': 'terminal', 'args': ['--cli']}, {'id': 'console-login', 'type': 'terminal', 'args': []}]
        self.controller.settings.save({'backend': 'acp', 'runtime_source': 'local', 'acp_agent': 'claude-acp', 'acp_launcher': 'local',
                                       'auth_source': 'existing_login', 'provider': ''})
        with patch('character_agent.integration.acp_agent', return_value=agent), \
                patch('character_agent.harness.acp_agents.probe', return_value={'auth_methods': methods}), \
                patch.object(self.controller.logins, 'start', return_value={}) as start:
            for body, method in (({}, methods[1]), ({'method_id': 'console-login'}, methods[2])):
                post('/character/login/start', body)
                self.assertEqual(start.call_args, (('acp',), {'agent': agent, 'method': method}))
            self.assertEqual(post('/character/login/start', {'method_id': 'nope'}), (400, {'error': 'unknown_auth_method'}))
        # DeepSeek Harness has no ACP sign-in: its account signs in through the DeepSeek desktop client.
        dsh = {'id': 'deepseek-harness', 'name': 'DeepSeek Harness', 'command': ['/synthetic/dsh', '--profile', 'acp'], 'source': 'local'}
        account = ['/synthetic/dsh', '--profile', 'acp', '--patch', str(acp_agents.DSH_ACCOUNT_PATCH)]
        self.controller.settings.save({'backend': 'acp', 'runtime_source': 'local', 'acp_agent': 'deepseek-harness',
                                       'acp_launcher': 'local', 'auth_source': 'existing_login', 'provider': ''})
        with patch('character_agent.integration.acp_agent', return_value=dsh), \
                patch.object(self.controller.logins, 'start', return_value={}) as start:
            post('/character/login/start', {})
            self.assertEqual(start.call_args, (('deepseek', account), {}))
            self.assertEqual(post('/character/login/logout', {}), (400, {'error': 'logout_unsupported'}))
            self.controller.settings.save({'backend': 'acp', 'runtime_source': 'local', 'acp_agent': 'deepseek-harness',
                                           'acp_launcher': 'local', 'auth_source': 'api_key', 'provider': ''})
            self.assertEqual(post('/character/login/start', {}), (400, {'error': 'product_login_not_selected'}))

    def test_deepseek_harness_is_ready_on_the_apps_key_or_a_signed_in_desktop_account(self):
        dsh = {'id': 'deepseek-harness', 'name': 'DeepSeek Harness', 'command': ['/synthetic/dsh', '--profile', 'acp'], 'source': 'local'}
        self.controller.session_factory_override = None
        self.controller.settings.save({'backend': 'acp', 'runtime_source': 'local', 'acp_agent': 'deepseek-harness',
                                       'acp_launcher': 'local', 'auth_source': 'existing_login', 'provider': ''})
        with patch('character_agent.integration.acp_agent', return_value=dsh):
            for signed_in, error in ((False, 'product_login_required'), (None, 'product_login_checking'), (True, None)):
                with self.subTest(signed_in=signed_in), patch.object(self.controller.logins, 'signed_in', return_value=signed_in) as probe:
                    self.assertEqual(self.controller.public()['error'], error)
                    self.assertEqual(probe.call_args.args[:2], ('deepseek', [*dsh['command'], '--patch', str(acp_agents.DSH_ACCOUNT_PATCH)]))
            self.controller.settings.save({'backend': 'acp', 'runtime_source': 'local', 'acp_agent': 'deepseek-harness',
                                           'acp_launcher': 'local', 'auth_source': 'api_key', 'provider': ''})
            for key, error in ((None, 'missing_provider_api_key'), ('sk-synthetic', None)):
                with self.subTest(key=key), patch.object(self.controller, 'deepseek_key', return_value=key):
                    self.assertEqual(self.controller.public()['error'], error)

    def test_product_login_runs_the_kernel_in_the_apps_own_profile(self):
        from character_agent.harness.registry import _cli_common
        row = {'backend':'claude', 'path':'/synthetic/claude', 'entry_supported':True, 'authenticated':True}
        config = {'backend': 'claude', 'auth_source': 'product_login'}
        for auth, home in (('product_login', str(self.root / 'kernel-login' / 'claude')), ('existing_login', None)):
            common = {}
            with self.subTest(auth=auth), patch.object(self.controller, '_selected_runtime', return_value=row):
                _cli_common(self.controller, {**config, 'auth_source': auth}, common)
                self.assertEqual(common['native_home'], home)

    def test_proactive_role_uses_harness_but_has_no_action_tools(self):
        results = self.calling('artifact_write', 'desktop_act', 'task_plan')
        conn, response = self.open_feed()
        self.server.start_line('proactive-test', '轻声问候', source='proactive')
        events = self.lines_until_final(response); conn.close()
        self.assertFalse(events[-1].get('error'), events)
        names = {d['name'] for d in self.definitions[-1]}
        self.assertIn('knowledge_search', names)
        self.assertEqual({name: result['error']['code'] for name, result in results.items()},
                         {name: 'tool_not_allowed_in_mode' if name in names else 'tool_not_available' for name in results})

    def test_temporary_conversation_uses_selected_harness_without_persistent_words_or_actions(self):
        results = self.calling('task_plan')
        body, _ = self.line('search private-synthetic-turn', no_memory=True)
        self.assertEqual(body['runtime'], 'pi')
        self.assertEqual(body['runtime_reason'], 'temporary_read_only')
        self.assertEqual(self.server.history.export(), [])
        self.assertEqual(results['task_plan']['error'], {'code': 'tool_not_allowed_in_mode', 'mode': 'read_only',
                                                          'message': "task_plan is not available in this run's read_only mode."})
        self.assertNotIn('private-synthetic-turn', json.dumps(self.controller.store.list()))

    def test_a_temporary_turn_stays_out_of_the_next_prompt_and_the_side_brief(self):
        # Tool words take the chat route, whose prompt carries the mouth's history.
        self.line('search private-temporary-words', no_memory=True)
        self.assertEqual(self.controller._foreground_request, '')
        self.line('search a remembered turn')
        history = json.dumps(self.sessions[-1].calls[-1]['history'], ensure_ascii=False)
        self.assertNotIn('private-temporary-words', history)
        self.assertEqual(self.controller._foreground_request, 'search a remembered turn')
        self.controller.forget()
        self.assertEqual(self.controller._foreground_request, '')

    def test_pi_anonymous_endpoint_only_allows_explicit_loopback(self):
        snapshot = lambda: {'backends': {'compatible': dict(MODEL_DEFAULTS['compatible'])}}
        self.server.models = SimpleNamespace(snapshot=snapshot, llm_url='http://127.0.0.1:11434/v1')
        config = {'backend':'pi', 'provider':'compatible', 'auth_source':'local_no_auth'}
        self.assertEqual(self.controller._pi_connection(config)['auth_source'], 'none')
        self.server.models = SimpleNamespace(snapshot=snapshot, llm_url='https://example.org/v1')
        with self.assertRaisesRegex(ValueError, 'requires_loopback'):
            self.controller._pi_connection(config)

    def test_a_compatible_turn_without_the_llm_url_is_llm_service_off(self):
        self.server.models = SimpleNamespace(snapshot=lambda: {'backends': {'compatible': dict(MODEL_DEFAULTS['compatible'])}},
                                             llm_url=None)
        config = {'backend':'pi', 'provider':'compatible', 'auth_source':'local_no_auth'}
        with self.assertRaisesRegex(ValueError, 'llm_service_off'):
            self.controller._pi_connection(config)

    def test_forget_clears_private_runs_and_scopes_but_preserves_user_files(self):
        self.line()
        self.controller.workspace.create_scope([str(self.inputs)], str(self.root/'out'))
        self.controller.forget()
        self.assertEqual(self.controller.store.list(), [])
        self.assertEqual(self.controller.workspace.list_scopes(), [])
        self.assertTrue((self.inputs/'info.md').is_file())

    def test_product_reset_verifies_private_databases_too(self):
        self.line()
        self.controller.workspace.create_scope([str(self.inputs)], str(self.root/'out'))
        code, body = self.server.reset()
        self.assertEqual(code, 200, body)
        self.assertEqual(body['deleted']['character_runs'], 1)
        self.assertEqual(body['deleted']['character_workspace_scopes'], 1)
        self.assertTrue(all(value == 0 for key, value in body['rows'].items() if key.startswith('character_')))
        self.assertTrue(self.sessions[0].closed)

    def test_product_question_is_answered_through_authenticated_http(self):
        def script(session, prompt, options):
            if not options.get('ask_user_result'):
                yield from session.use(options, 'ask_user', {'questions':[{'id':'use','question':'报告用途？','options':[{'label':'差旅报销'}]}]})
            response = options['ask_user_result']['result']
            yield {'type':'result','success':True,'final_text':'用途：'+response['answers']['use'][0]}
        self.script = script
        status, submitted = self.request('POST','/say',{'text':'整理费用，先询问用途'})
        self.assertEqual(status,202)
        deadline=time.monotonic()+3
        while time.monotonic()<deadline:
            rows=self.request('GET','/agent/interactions')[1]['requests']
            if rows and not self.controller.busy():break
            time.sleep(.01)
        item=rows[0];self.assertEqual(item['run_id'],submitted['run_id'])
        self.assertEqual(self.controller.store.get(submitted['run_id'])['state'],'waiting_user')
        self.assertEqual(self.request('POST','/agent/interactions/'+item['request_id']+'/answer',{'expected_version':1,'answers':{'use':['差旅报销']}})[0],200)
        while time.monotonic()<deadline:
            rows=self.controller.store.list()
            if any(row['run_id'] != submitted['run_id'] and row['state']=='completed' for row in rows):break
            time.sleep(.01)
        self.assertTrue(any(row['run_id'] != submitted['run_id'] and row['state']=='completed' for row in rows))
        self.assertEqual(self.request('GET','/agent/interactions')[1]['requests'],[])
        for turn in self.server.history.export():
            self.assertNotIn('报告用途？', turn['user_text'])

    def test_c3_answered_question_supplies_the_reminder_time(self):
        from datetime import datetime, timedelta, timezone
        from personal.commitments import Commitments
        self.server.commitments = Commitments(self.db, lock=self.server.memory.lock)
        due = (datetime.now(timezone.utc) + timedelta(days=20)).replace(microsecond=0)
        def script(session, prompt, options):
            if not options.get('ask_user_result'):
                yield from session.use(options, 'ask_user', {'questions': [{'id': 'when', 'question': '月底前哪天、几点提醒你续费？'}]})
                return
            yield from session.use(options, 'reminder_create', {'text': '续费', 'due_at': due.isoformat(),
                'instruction_quote': '提醒我月底前续费', 'time_quote': '11月28日上午十点'})
            yield from chat(session, prompt, options)
        self.script = script
        status, submitted = self.request('POST', '/say', {'text': '提醒我月底前续费'})
        self.assertEqual(status, 202, submitted)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            rows = self.request('GET', '/agent/interactions')[1]['requests']
            if rows and not self.controller.busy(): break
            time.sleep(.01)
        self.assertEqual(self.request('POST', '/agent/interactions/' + rows[0]['request_id'] + '/answer',
            {'expected_version': 1, 'answers': {'when': ['11月28日上午十点']}})[0], 200)
        while time.monotonic() < deadline and not self.server.commitments.list():
            time.sleep(.01)
        items = self.server.commitments.list()
        self.assertEqual([(i['text'], i['due_at']) for i in items], [('续费', due.timestamp())],
                         self.sessions[-1].responses)

    def test_d2_the_resumed_line_does_not_show_the_users_words_again(self):
        from personal.commitments import Commitments
        self.server.commitments = Commitments(self.db, lock=self.server.memory.lock)
        def script(session, prompt, options):
            if not options.get('ask_user_result'):
                yield from session.use(options, 'ask_user', {'questions': [{'id': 'when', 'question': '哪天提醒你？'}]})
                return
            yield {'type': 'result', 'success': True, 'final_text': '好的，28号提醒你'}
        self.script = script
        status, submitted = self.request('POST', '/say', {'text': '提醒我月底前续费'})
        self.assertEqual(status, 202, submitted)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            rows = self.request('GET', '/agent/interactions')[1]['requests']
            if rows and not self.controller.busy(): break
            time.sleep(.01)
        self.assertEqual(self.request('POST', '/agent/interactions/' + rows[0]['request_id'] + '/answer',
            {'expected_version': 1, 'answers': {'when': ['28号']}})[0], 200)
        conversation = self.server.history.conversations.active
        while time.monotonic() < deadline and len(self.server.history.conversations.turns(conversation)['turns']) < 2:
            time.sleep(.01)
        first, resumed = self.server.history.conversations.turns(conversation)['turns']
        self.assertEqual(first['user_text'], '提醒我月底前续费')
        self.assertEqual((resumed['user_text'], resumed['reply']), ('', '好的，28号提醒你'))
        self.assertNotEqual(first['turn_id'], resumed['turn_id'])

    def test_temporary_turn_does_not_open_question_tools(self):
        self.line('临时问候',no_memory=True)
        offered={d['name'] for d in self.definitions[-1]}
        self.assertNotIn('ask_user', offered)

    def test_no_kernel_gets_the_replacement_tools(self):
        replacements = {'workspace_list', 'workspace_read', 'workspace_image', 'workspace_search'}
        kept = {'artifact_write', 'artifact_read', 'artifact_verify', 'ask_user', 'task_plan'}
        for backend, extra in (('pi', {'runtime_source': 'bundled'}), ('codex', {}), ('claude', {}), ('acp', {'acp_agent': 'claude-acp'})):
            with self.subTest(backend=backend):
                self.controller.configure({'backend': backend, 'runtime_source': 'local', **extra})
                self.line('整理资料', scope_id=self.scope_id())
                offered = {d['name'] for d in self.definitions[-1]}
                self.assertLessEqual(kept, offered)
                self.assertFalse(offered & replacements)
                self.assertNotIn('workspace_list', self.sessions[-1].calls[-1]['prompt'])
                self.assertIn(str(self.inputs), self.sessions[-1].calls[-1]['prompt'])

    def test_no_kernel_is_told_about_native_publish_and_skills(self):
        for backend, extra in (('pi', {'runtime_source': 'bundled'}), ('codex', {}), ('claude', {}), ('acp', {'acp_agent': 'claude-acp'})):
            with self.subTest(backend=backend):
                self.controller.configure({'backend': backend, 'runtime_source': 'local', **extra})
                self.line('你好')
                system = self.sessions[-1].calls[-1]['system_prompt']
                self.assertIn('- Verify by receipt (artifact_verify, ', system)
                self.assertIn('- In a window, check each step before the next.\n- ', system)
                for text in ('native_publish', 'Skills'):
                    self.assertNotIn(text, system)

    def busy_foreground(self):
        """A foreground run held at its gate; an input ending in SIDE waits at the other gate."""
        self.gates, self.started = {'TASK': threading.Event(), 'SIDE': threading.Event()}, []
        def script(session, prompt, options):
            mark = next((m for m in self.gates if prompt.endswith(m)), None)
            if mark:
                self.started.append(options['run_id'])
                while not self.gates[mark].wait(.01) and not options['cancelled'](): pass
            yield from chat(session, prompt, options)
        self.script = script
        self.addCleanup(lambda: [gate.set() for gate in self.gates.values()])
        status, body = self.request('POST', '/say', {'text': '整理资料 TASK'})
        self.assertEqual(status, 202, body)
        self.until(lambda: body['run_id'] in self.started and self.controller.busy())
        return body

    def until(self, predicate):
        deadline = time.monotonic() + 3
        while not predicate():
            if time.monotonic() > deadline: self.fail('condition not reached')
            time.sleep(.01)

    def reply_of(self, response, line_id):
        text = ''
        while True:
            event = self.next_event(response)
            data = json.loads(event['data']) if event['event'] == 'line' else {}
            if data.get('line_id') != line_id: continue
            text += data['text_delta']
            if data['final']: return text, data

    def state(self, run_id):
        return self.controller.store.get(run_id)['state']

    def test_p0_4_input_while_foreground_works_is_answered_by_a_side_session(self):
        conn, response = self.open_feed(); self.addCleanup(conn.close)
        task = self.busy_foreground()
        results = self.calling('task_plan')
        status, side = self.request('POST', '/say', {'text': '顺便问一下今天几号'})
        self.assertEqual(status, 202, side)
        text, final = self.reply_of(response, side['line_id'])
        self.assertEqual((text, final['error'], final['cancelled']), ('Hello', None, False))
        self.assertEqual(self.sessions[0].interrupted, 0)
        self.assertEqual(self.state(task['run_id']), 'running')
        call = self.sessions[1].calls[0]
        self.assertIn('整理资料 TASK', call['prompt'])
        self.assertNotIn('<main_session>', call['system_prompt'])
        self.assertEqual(results['task_plan']['error']['code'], 'tool_not_allowed_in_mode')
        self.gates['TASK'].set()
        self.until(lambda: self.state(task['run_id']) == 'completed' and not self.server._live_lines)
        self.assertEqual(len(self.server.history.export()), 2)
        self.assertEqual(len(self.server.mouth.history), 2)

    def test_p0_4_input_while_foreground_works_is_also_steered_into_the_foreground(self):
        from character_agent.integration import STEER_NOTE
        conn, response = self.open_feed(); self.addCleanup(conn.close)
        task = self.busy_foreground()
        with patch.object(self.server, '_step', wraps=self.server._step) as step:
            status, side = self.request('POST', '/say', {'text': '换成表格吧'})
            self.assertEqual(status, 202, side)
            text, final = self.reply_of(response, side['line_id'])
            self.assertEqual((text, final['error'], final['cancelled']), ('Hello', None, False))
            self.until(lambda: any(c.args[1] == 'steer.settled' for c in step.call_args_list))
        [(steered, run_id)] = self.sessions[0].steers
        self.assertTrue(steered.startswith(STEER_NOTE), steered)
        self.assertTrue(steered.endswith('换成表格吧'), steered)
        self.assertEqual(run_id, task['run_id'])
        [call] = [c for c in step.call_args_list if c.args[1] == 'steer.settled']
        self.assertEqual(call.kwargs['attrs'], {'accepted': True, 'code': None})
        self.assertEqual(self.state(task['run_id']), 'running')
        self.gates['TASK'].set()
        self.until(lambda: self.state(task['run_id']) == 'completed' and not self.server._live_lines)

    def test_p0_4_a_temporary_or_her_own_side_line_is_not_steered(self):
        conn, response = self.open_feed(); self.addCleanup(conn.close)
        task = self.busy_foreground()
        status, side = self.request('POST', '/say', {'text': '临时问一句', 'no_memory': True})
        self.assertEqual(status, 202, side)
        self.assertEqual(self.reply_of(response, side['line_id'])[1]['error'], None)
        status, side = self.server.say('点了一下', 'tap')
        self.assertEqual(status, 202, side)
        self.assertEqual(self.reply_of(response, side['line_id'])[1]['error'], None)
        self.assertEqual(len(self.sessions), 3)
        self.assertEqual(self.sessions[0].steers, [])
        self.gates['TASK'].set()
        self.until(lambda: self.state(task['run_id']) == 'completed' and not self.server._live_lines)

    def test_retention_only_change_keeps_the_running_foreground_and_its_runtime(self):
        conn, response = self.open_feed(); self.addCleanup(conn.close)
        task = self.busy_foreground()
        runtime = self.controller.runtime
        status, body = self.request('PUT', '/character/runtime',
            {**self.controller.settings.snapshot(), 'history_retention': '7d'})
        self.assertEqual(status, 200, body)
        self.assertIs(self.controller.runtime, runtime)
        self.assertEqual((self.sessions[0].interrupted, self.sessions[0].closed), (0, 0))
        self.assertEqual(self.state(task['run_id']), 'running')
        self.assertEqual(self.request('GET', '/character/runtime')[1]['history_retention'], '7d')
        self.assertEqual(self.controller.retention(), 7 * 86400)
        self.gates['TASK'].set()
        text, final = self.reply_of(response, task['line_id'])
        self.assertEqual((text, final['error'], final['cancelled']), ('Hello', None, False))
        self.until(lambda: self.state(task['run_id']) == 'completed' and not self.server._live_lines)
        self.line('下一轮也整理资料')
        self.assertIs(self.controller.runtime, runtime)
        self.assertEqual(len(self.sessions), 1)

    def test_identical_settings_put_keeps_the_running_foreground_and_its_runtime(self):
        conn, response = self.open_feed(); self.addCleanup(conn.close)
        task = self.busy_foreground()
        runtime = self.controller.runtime
        settings = {**self.controller.settings.snapshot(), 'history_retention': '7d'}
        for _ in range(2):
            status, body = self.request('PUT', '/character/runtime', settings)
            self.assertEqual(status, 200, body)
            # The reply's routes add readiness to the saved ones.
            self.assertEqual({k: body[k] for k in settings if k != 'routes'}, {k: v for k, v in settings.items() if k != 'routes'})
            self.assertTrue(body['busy'])
        self.assertIs(self.controller.runtime, runtime)
        self.assertEqual((self.sessions[0].interrupted, self.sessions[0].closed), (0, 0))
        self.assertEqual(self.state(task['run_id']), 'running')
        self.assertEqual(self.controller._runtime_config['history_retention'], '7d')
        self.gates['TASK'].set()
        text, final = self.reply_of(response, task['line_id'])
        self.assertEqual((text, final['error'], final['cancelled']), ('Hello', None, False))
        self.until(lambda: self.state(task['run_id']) == 'completed' and not self.server._live_lines)

    def lock_probe(self, thread_name):
        """Swap the controller lock for one that signals when thread_name has to wait for it."""
        controller, lock, waiting = self.controller, self.controller._lock, threading.Event()
        class Probe:
            def acquire(self, blocking=True, timeout=-1):
                if lock.acquire(blocking=False): return True
                if threading.current_thread().name == thread_name: waiting.set()
                return lock.acquire(blocking, timeout)
            def release(self): lock.release()
            __enter__ = acquire
            def __exit__(self, *exc): lock.release()
        controller._lock = Probe()
        self.addCleanup(setattr, controller, '_lock', lock)
        return waiting

    def test_retention_put_racing_a_turn_start_does_not_rebuild_the_runtime(self):
        self.line('edit the first draft')
        controller = self.controller
        runtime = controller.runtime
        settings = {**controller.settings.snapshot(), 'history_retention': '7d'}
        snapshot, raced = controller.settings.snapshot, []
        self.addCleanup(setattr, controller.settings, 'snapshot', snapshot)
        waiting = self.lock_probe('put')
        put = threading.Thread(target=controller.configure, args=(settings,), name='put')
        def racing_snapshot():
            value = snapshot()
            if threading.current_thread().name == 'turn-start' and not raced:
                # The PUT arrives while the turn holds the lock between reading settings and keeping its runtime.
                put.start()
                raced.append(waiting.wait(3))
            return value
        controller.settings.snapshot = racing_snapshot
        turn = threading.Thread(target=controller._ensure_runtime, name='turn-start'); turn.start(); turn.join(3)
        self.assertFalse(turn.is_alive())
        put.join(3)
        self.assertFalse(put.is_alive())
        self.assertEqual(raced, [True])
        controller.settings.snapshot = snapshot
        self.assertIs(controller.runtime, runtime)
        self.assertEqual(controller._runtime_config['history_retention'], '7d')
        self.assertEqual(self.sessions[0].closed, 0)
        self.line('edit the next draft')
        self.assertIs(controller.runtime, runtime)
        self.assertEqual(len(self.sessions), 1)

    def test_unchanged_put_read_before_a_model_change_does_not_write_back_stale_settings(self):
        self.line('edit the first draft')
        controller = self.controller
        before = controller.settings.snapshot()
        snapshot, read, resume = controller.settings.snapshot, threading.Event(), threading.Event()
        self.addCleanup(setattr, controller.settings, 'snapshot', snapshot)
        def paused_snapshot():
            value = snapshot()
            if threading.current_thread().name == 'stale' and not read.is_set():
                read.set(); resume.wait(5)
            return value
        controller.settings.snapshot = paused_snapshot
        stale = threading.Thread(target=controller.configure, args=(dict(before),), name='stale'); stale.start()
        self.assertTrue(read.wait(3))
        waiting, changed = self.lock_probe('change'), threading.Event()
        def change():
            controller.configure({**before, 'model': 'm2'}); controller._ensure_runtime(); changed.set()
        threading.Thread(target=change, name='change').start()
        # The model change either finishes or has to wait for the paused PUT's lock; then that PUT resumes.
        self.until(lambda: changed.is_set() or waiting.is_set())
        resume.set()
        stale.join(3)
        self.assertFalse(stale.is_alive())
        self.assertTrue(changed.wait(3))
        self.assertEqual(snapshot()['model'], 'm2')
        self.assertEqual(controller._runtime_config['model'], 'm2')

    def test_forget_read_before_a_model_change_does_not_write_back_stale_settings(self):
        self.line('edit the first draft')
        controller = self.controller
        controller.settings.save({**controller.settings.snapshot(), 'scope_id': self.scope_id()})
        before = controller.settings.snapshot()
        snapshot, read, resume, armed = controller.settings.snapshot, threading.Event(), threading.Event(), threading.Event()
        workspace_forget = controller.workspace.forget
        self.addCleanup(setattr, controller.settings, 'snapshot', snapshot)
        self.addCleanup(setattr, controller.workspace, 'forget', workspace_forget)
        def arming_forget():
            workspace_forget(); armed.set()
        def paused_snapshot():
            value = snapshot()
            if threading.current_thread().name == 'forget' and armed.is_set() and not read.is_set():
                read.set(); resume.wait(5)
            return value
        controller.workspace.forget = arming_forget
        controller.settings.snapshot = paused_snapshot
        forget = threading.Thread(target=controller.forget, name='forget'); forget.start()
        self.assertTrue(read.wait(3))
        waiting, changed = self.lock_probe('change'), threading.Event()
        def change():
            controller.configure({**before, 'model': 'm2', 'scope_id': None}); controller._ensure_runtime(); changed.set()
        threading.Thread(target=change, name='change').start()
        # The model change either finishes or has to wait for the paused forget's lock; then that forget resumes.
        self.until(lambda: changed.is_set() or waiting.is_set())
        resume.set()
        forget.join(3)
        self.assertFalse(forget.is_alive())
        self.assertTrue(changed.wait(3))
        self.assertEqual((snapshot()['model'], snapshot()['scope_id']), ('m2', None))
        self.assertEqual(controller._runtime_config['model'], 'm2')

    def test_model_change_still_cancels_the_running_foreground_and_rebuilds_its_runtime(self):
        task = self.busy_foreground()
        runtime = self.controller.runtime
        status, body = self.request('PUT', '/character/runtime',
            {**self.controller.settings.snapshot(), 'model': 'synthetic-model', 'history_retention': '30d'})
        self.assertEqual(status, 200, body)
        self.assertIsNot(self.controller.runtime, runtime)
        self.assertTrue(self.sessions[0].closed)
        self.until(lambda: self.state(task['run_id']) == 'cancelled')
        self.assertEqual(self.request('GET', '/character/runtime')[1]['model'], 'synthetic-model')

    def test_p0_4a_foreground_harness_run_lines_are_agent_lane_with_their_run_id(self):
        body, events = self.line()
        active = self.server.history.conversations.active
        self.assertEqual({(e['lane'], e['run_id'], e['conversation_id']) for e in events},
                         {('agent', body['run_id'], active)})

    def test_p0_4a_side_session_lines_are_side_lane_without_run_id(self):
        conn, response = self.open_feed(); self.addCleanup(conn.close)
        self.busy_foreground()
        side = self.request('POST', '/say', {'text': '顺便问一下今天几号'})[1]
        _, final = self.reply_of(response, side['line_id'])
        self.assertEqual((final['lane'], final['run_id'], final['conversation_id']),
                         ('side', None, self.server.history.conversations.active))
        self.gates['TASK'].set()
        self.until(lambda: not self.server._live_lines)

    def test_p0_4_voice_stops_keep_the_foreground_and_end_the_side(self):
        task = self.busy_foreground()
        generation = self.server.turn_generation
        for stop in ('barge_in', '停下'):
            with self.subTest(stop=stop):
                side = self.request('POST', '/say', {'text': '问一句 SIDE'})[1]
                self.until(lambda: side['line_id'] in self.started)
                if stop == 'barge_in':
                    self.assertEqual(self.request('POST', '/turn/cancel', {'reason': 'barge_in'})[0], 202)
                else:
                    self.assertEqual(self.request('POST', '/say', {'text': stop})[0], 200)
                self.until(lambda: self.state(side['line_id']) == 'cancelled')
                self.assertEqual(self.state(task['run_id']), 'running')
                self.assertEqual(self.sessions[0].interrupted, 0)
                self.assertEqual(self.server.turn_generation, generation)
        self.gates['TASK'].set()
        self.until(lambda: self.state(task['run_id']) == 'completed')

    def test_p0_4_stop_task_ends_foreground_and_side(self):
        task = self.busy_foreground()
        side = self.request('POST', '/say', {'text': '停止任务'})
        self.assertEqual(side[0], 202)
        self.until(lambda: (self.controller.store.get(side[1]['line_id']) or {}).get('state') == 'completed')
        self.assertEqual(self.state(task['run_id']), 'running')
        run = self.controller.store.get(task['run_id'])
        self.assertEqual(self.request('POST', f"/agent/runs/{task['run_id']}/cancel", {'generation': run['generation']})[0], 202)
        self.until(lambda: self.state(task['run_id']) == 'cancelled')

    def test_p0_4_second_side_replaces_only_the_first(self):
        task = self.busy_foreground()
        one = self.request('POST', '/say', {'text': '第一问 SIDE'})[1]
        self.until(lambda: one['line_id'] in self.started)
        two = self.request('POST', '/say', {'text': '第二问 SIDE'})[1]
        self.until(lambda: two['line_id'] in self.started and self.state(one['line_id']) == 'cancelled')
        self.assertEqual(self.state(two['line_id']), 'running')
        self.assertEqual(self.state(task['run_id']), 'running')
        self.assertEqual(self.sessions[0].interrupted, 0)

    def test_p0_4_main_window_stop_names_the_side_run_only(self):
        task = self.busy_foreground()
        job = self.controller.submit_job('后台', '后台核查 SIDE', '核查')
        try:
            side = self.request('POST', '/say', {'text': '问一句 SIDE'})[1]
            self.until(lambda: side['line_id'] in self.started and job['run_id'] in self.started)
            conversation = self.server.history.conversations.active
            code, body = self.request('POST', '/conversations/' + conversation + '/cancel',
                                      {'run_id': side['line_id'], 'generation': side['generation']})
            self.assertEqual(code, 202, body)
            self.until(lambda: self.state(side['line_id']) == 'cancelled')
            self.assertEqual(self.state(task['run_id']), 'running')
            self.assertEqual(self.sessions[0].interrupted, 0)
            self.assertEqual(self.controller.jobs.store.get(job['job_id'])['state'], 'running')
        finally:
            self.gates['SIDE'].set(); self.controller.jobs.close()

    def test_p0_4_context_clear_after_side_delivery_still_finds_the_foreground(self):
        conn, response = self.open_feed(); self.addCleanup(conn.close)
        task = self.busy_foreground()
        self.server._line_context[self.server._line_cancel] = (task['run_id'], {'page'})
        side = self.request('POST', '/say', {'text': '顺便问一下'})[1]
        self.reply_of(response, side['line_id'])
        self.until(lambda: not any(v[0] == side['line_id'] for v in tuple(self.server._line_context.values())))
        self.server._context_changed('page')
        self.until(lambda: self.state(task['run_id']) == 'interrupted')


class RoleWorklogTests(IntegrationFixture):
    """A run of her own task that ends leaves one work-memory card per task."""
    def setUp(self):
        super().setUp()
        from personal.worklog import WorkLog
        self.work = self.server.worklog = WorkLog(self.db, lambda: self.server.character)
        self.fail_run = False
        self.script = self.work_script

    def work_script(self, session, prompt, options):
        if 'background_assignment' in prompt or '整理' in prompt:
            yield from session.use(options, 'task_plan', {'title': '报销汇总', 'outputs': []})
        if self.fail_run:
            yield {'type': 'result', 'success': False, 'error': 'quota_exhausted', 'usage': {}}
            return
        yield {'type': 'text_delta', 'item_id': 'answer', 'kind': 'assistant_text', 'status': 'delta', 'text': '  [intent:acknowledge]报销已汇总好了  '}
        yield {'type': 'item', 'item_id': 'answer', 'kind': 'assistant_text', 'status': 'completed'}
        yield {'type': 'result', 'success': True, 'final_text': '报销已汇总好了', 'usage': {}}

    def say(self, text, **kwargs):
        conn, response = self.open_feed()
        status, body = self.request('POST', '/say', {'text': text, **kwargs})
        self.assertEqual(status, 202, body)
        self.lines_until_final(response); conn.close()
        return body['run_id']

    def task_of(self, run_id):
        return self.controller.store.get(run_id)['task_id']

    def again(self, task_id):
        job = self.controller.adopt_task(task_id, '接着做', '接着做')
        try:
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline and self.controller.jobs.store.get(job['job_id'])['state'] in ('queued', 'running'): time.sleep(.01)
        finally: self.controller.jobs.close()
        return self.controller.jobs.store.get(job['job_id'])['run_id']

    def test_finished_task_leaves_a_done_card(self):
        run_id = self.say('整理报销汇总', scope_id=self.scope_id())
        task_id = self.task_of(run_id)
        cards = self.work.tasks()
        self.assertEqual([card['id'] for card in cards], ['task-role-' + task_id])
        self.assertEqual(cards[0]['run_id'], run_id)
        self.assertEqual(cards[0]['status'], 'done')
        self.assertEqual(cards[0]['status_authority'], 'agent_claimed')
        self.assertEqual(cards[0]['title'], '报销汇总')
        self.assertEqual(cards[0]['progress'], '报销已汇总好了')
        self.assertEqual(cards[0]['blockers'], [])
        self.assertEqual(cards[0]['project'], '')

    def test_running_the_task_again_updates_the_same_card(self):
        task_id = self.task_of(self.say('整理报销汇总', scope_id=self.scope_id()))
        first = self.work.task('task-role-' + task_id)
        run_id = self.again(task_id)
        self.assertEqual(self.task_of(run_id), task_id)
        cards = self.work.tasks()
        self.assertEqual(len(cards), 1)
        self.assertEqual(cards[0]['revision'], first['revision'] + 1)
        self.assertEqual(cards[0]['first_at'], first['first_at'])
        self.assertEqual(cards[0]['run_id'], run_id)

    def test_failed_run_leaves_an_active_card_with_its_blocker(self):
        self.fail_run = True
        task_id = self.task_of(self.say('整理报销汇总', scope_id=self.scope_id()))
        card = self.work.task('task-role-' + task_id)
        self.assertEqual(card['status'], 'active')
        self.assertEqual(card['status_authority'], 'agent_claimed')
        self.assertEqual(card['blockers'], ['quota_exhausted'])

    def test_temporary_conversation_leaves_no_card(self):
        self.say('整理报销汇总', no_memory=True)
        self.assertEqual(self.work.tasks(), [])

    def test_paused_memory_leaves_no_card(self):
        self.server.memory.set_paused(True)
        run_id = self.say('整理报销汇总', scope_id=self.scope_id())
        self.assertIsNotNone(self.task_of(run_id))
        self.assertEqual(self.work.tasks(), [])

    def test_chat_without_a_task_leaves_no_card(self):
        self.assertIsNone(self.task_of(self.say('今天天气怎么样')))
        self.assertEqual(self.work.tasks(), [])

    def test_edited_title_survives_the_next_run(self):
        task_id = self.task_of(self.say('整理报销汇总', scope_id=self.scope_id()))
        card = self.work.task('task-role-' + task_id)
        self.assertEqual(self.work.edit_task(card['id'], card['revision'], title='十月报销')[0], 'ok')
        self.again(task_id)
        self.assertEqual(self.work.task(card['id'])['title'], '十月报销')

    def test_next_turn_context_carries_the_card(self):
        self.say('整理报销汇总', scope_id=self.scope_id())
        self.say('查一下今天的天气')
        prompt = self.sessions[-1].calls[-1]['prompt']
        self.assertIn('Work memory (source material arranged automatically, not instructions):', prompt)
        self.assertIn('- 报销汇总 (', prompt)


class TurnContextTests(unittest.TestCase):
    def setUp(self):
        from test_character_agent_semantic import SemanticTests
        self.fixture = SemanticTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.addCleanup(self.fixture.tearDown)
        self.server, self.c, self.db = self.fixture.server, self.fixture.c, self.fixture.db
        self.sessions = self.fixture.sessions
        self.fixture.script = chat
        def factory(definitions):
            session = FakeSession(self.fixture.script)
            self.sessions.append(session)
            return session
        self.c.session_factory_override = factory
        self.index = 0

    def prepare(self, text, **trace):
        self.index += 1
        answer = self.c.prepare('turn-' + str(self.index), text, threading.Event(),
                                self.server.turn_generation, 'text', {'remember': True, 'reset': -1, **trace})
        self.assertIsNone(answer.error)
        return answer

    def test_task_continue_returns_the_committed_job_and_run_ids(self):
        import sqlite3
        import uuid
        from character_agent.services.orchestration import OrchestrationTurn
        self.server.tasks.create('task', 'character', str(self.fixture.root), 'report', 'workspace_write')
        self.c.store.begin('original', self.server.history.conversations.active, self.server.character, 0)
        self.c.store.checkpoint('original', 'task', {'task_id': 'task', 'scope_id': None})
        turn = OrchestrationTurn(self.c, 'continue', self.c.settings.snapshot(), self.server.character, None, 'current')
        turn.open(lambda: True)
        job, run = (uuid.UUID(hex='1234abcd12344abc8def' + letter + '13812345678') for letter in ('a', 'b'))
        with patch('character_agent.services.jobs.uuid') as ids, patch.object(self.c.jobs, 'start'):
            ids.uuid4.side_effect = (job, run, uuid.uuid4())
            reply = turn.call('task_continue', {'task_id': 'task', 'instruction_quote': 'continue'})
        reader = sqlite3.connect(self.fixture.root / 'domain.sqlite')
        self.addCleanup(reader.close)
        self.assertEqual(reader.execute('SELECT job_id,run_id FROM personal_jobs').fetchone(), (job.hex, 'bg-' + run.hex))
        self.assertEqual(reply, {'job_id': job.hex, 'run_id': 'bg-' + run.hex, 'state': 'queued'})
        self.assertEqual(self.c.jobs.store.get(reply['job_id'])['run_id'], reply['run_id'])

    def test_k17_turn_context_refreshes_local_date_at_midnight(self):
        from datetime import datetime, timedelta, timezone
        clock = SimpleNamespace(now=lambda: SimpleNamespace(astimezone=lambda: moments.pop(0)))
        moments = [datetime(2026, 10, 27, 23, 59, 59, tzinfo=timezone(timedelta(hours=8))),
                   datetime(2026, 10, 28, 0, 0, 1, tzinfo=timezone(timedelta(hours=8)))]
        with patch('character_agent.integration.datetime', clock, create=True):
            self.prepare('午夜前')
            self.prepare('午夜后')
        self.assertIn('Local time: 2026-10-27 23:59 Tuesday (UTC+08:00)', self.sessions[0].calls[0]['prompt'])
        self.assertIn('Local time: 2026-10-28 00:00 Wednesday (UTC+08:00)', self.sessions[0].calls[1]['prompt'])
        self.assertEqual(self.sessions[0].calls[1]['prompt'].count('Local time'), 1)

    def test_k03_foreground_records_explicit_harness_identity_and_cost(self):
        from models.usage import UsageMeter
        self.server.usage = UsageMeter(self.db, lock=self.server.memory.lock)
        def script(session, prompt, options):
            yield {'type': 'result', 'success': True, 'final_text': 'Hello', 'model': 'sdk-model',
                   'usage': {'input_tokens': 100, 'output_tokens': 10, 'cache_creation_input_tokens': 0,
                             'cache_read_input_tokens': 20}, 'cost_usd': .15,
                   'model_usage': {'sdk-model': {'costUSD': .15}}}
        self.fixture.script = script
        for backend, provider, recorded in (('pi', 'deepseek', 'deepseek'), ('codex', '', 'openai')):
            self.c.configure({'backend': backend, 'runtime_source': 'local', 'provider': provider})
            config = self.c.settings.snapshot()
            with patch.object(self.server.usage, 'record', wraps=self.server.usage.record) as record:
                self.prepare('记录本轮用量')
            kwargs = record.call_args.kwargs
            self.assertEqual(kwargs.get('provider'), recorded)
            self.assertEqual(kwargs.get('channel'), backend + '_' + config['auth_source'])
            self.assertEqual(kwargs.get('cost_usd'), .15)
            self.assertEqual(kwargs.get('cost_source'), 'sdk_estimate')
        self.assertNotIn('unknown', self.server.usage.today()['by_channel'])
        self.assertEqual(self.server.usage.today()['usage_missing'], 0)

    def ask_then_chat(self, session, prompt, options):
        if len(session.calls) == 1:
            yield from session.use(options, 'ask_user', {'questions': [
                {'id': 'use', 'question': '报告用途？'}, {'id': 'when', 'question': '截止哪天？'}]})
            return
        yield from chat(session, prompt, options)

    def test_w6_pending_question_is_named_in_the_next_turn_context(self):
        self.fixture.script = self.ask_then_chat
        self.prepare('整理费用，先询问用途')
        self.assertEqual([row['state'] for row in self.c.interactions.list()], ['pending'])
        self.prepare('今天天气怎么样')
        self.assertIn('Your open questions to the user: "报告用途？"; "截止哪天？". This message does not answer them',
                      self.sessions[-1].calls[-1]['prompt'])

    def test_w6_no_pending_question_leaves_context_unchanged(self):
        self.prepare('今天天气怎么样')
        self.assertNotIn('Your open questions', self.sessions[-1].calls[-1]['prompt'])

    def test_w6_dismissed_question_is_not_named_again(self):
        self.fixture.script = self.ask_then_chat
        self.prepare('整理费用，先询问用途')
        card = self.c.interactions.list()[0]
        self.c.interactions.dismiss(card['request_id'], card['revision'])
        self.prepare('今天天气怎么样')
        self.assertNotIn('Your open questions', self.sessions[-1].calls[-1]['prompt'])

    def test_w12_surface_names_where_the_line_came_from(self):
        for surface, name in (('quick_input', 'desktop quick input'), ('bubble_reply', 'a reply to your bubble'),
                              ('thought_offer', 'accepting your suggestion'), ('chat', 'the chat page')):
            self.prepare('好', surface=surface)
            self.assertIn('\nSent from: ' + name + '\n', self.sessions[-1].calls[-1]['prompt'])
        self.prepare('好')
        self.assertNotIn('Sent from', self.sessions[-1].calls[-1]['prompt'])

    def test_w12_quote_is_data_in_this_turn_only_and_passes_egress(self):
        self.prepare('这段什么意思', quote={'text': '周报发给 alice@example.com，电话 13812345678', 'app': '备忘录'})
        prompt = self.sessions[-1].calls[-1]['prompt']
        self.assertIn('\nQuoted selection (from 备忘录): "周报发给 [已遮蔽:邮箱]，电话 [已遮蔽:电话]"', prompt)
        self.assertNotIn('alice@example.com', prompt); self.assertNotIn('13812345678', prompt)
        self.prepare('再说说', quote={'text': '第二段', 'app': None})
        self.assertIn('(from an unknown app): "第二段"', self.sessions[-1].calls[-1]['prompt'])
        self.prepare('今天天气怎么样')
        self.assertNotIn('Quoted selection', self.sessions[-1].calls[-1]['prompt'])

    def test_w14_reply_to_quotes_her_line_or_thought_through_egress(self):
        from character.proactive_log import ProactiveLog
        self.server.proactive_log = ProactiveLog(self.db)
        self.server.proactive_log.shown('l1', 'line', 'comment', None, '要我把周报发给 alice@example.com 吗', None, None, 1.0)
        self.server.proactive_log.shown('t1', 'thought', 'finished', None, '那个测试好像一直红着', '帮我看看', '好，帮我看看', 1.0)
        self.prepare('好啊', reply_to={'kind': 'line', 'id': 'l1'})
        prompt = self.sessions[-1].calls[-1]['prompt']
        self.assertIn('\nReplying to your line: "要我把周报发给 [已遮蔽:邮箱] 吗"', prompt)
        self.assertNotIn('alice@example.com', prompt)
        self.prepare('好，帮我看看', reply_to={'kind': 'thought', 'id': 't1'})
        self.assertIn('\nReplying to your line: "那个测试好像一直红着"', self.sessions[-1].calls[-1]['prompt'])
        self.prepare('嗯', reply_to={'kind': 'thought', 'id': 'l1'})
        self.assertIn('\nReplying to an earlier line of yours whose text is gone', self.sessions[-1].calls[-1]['prompt'])
        self.server.proactive_log = None
        self.prepare('嗯', reply_to={'kind': 'line', 'id': 'l1'})
        self.assertIn('\nReplying to an earlier line of yours whose text is gone', self.sessions[-1].calls[-1]['prompt'])
        self.prepare('今天天气怎么样')
        self.assertNotIn('Replying to', self.sessions[-1].calls[-1]['prompt'])

    def job(self, title, conversation, state, age):
        store = self.c.jobs.store
        with store.lock:
            job = store.submit(title, {}, conversation_id=conversation)
            store.db.execute('UPDATE personal_jobs SET state=?,updated_at=? WHERE job_id=?',
                             (state, time.time() - age, job['job_id']))
            store.db.commit()
        return job['job_id']

    def job_index(self):
        prompt = self.sessions[-1].calls[-1]['prompt']
        start = prompt.index('{', prompt.index('Goals and background work'))
        return json.JSONDecoder().raw_decode(prompt, start)[0]

    def test_b3_job_index_spans_conversations_and_includes_recent_failures(self):
        a = self.server.history.conversations.active
        failed = self.job('整理上周报表', a, 'failed', 2 * 86400)
        old = self.job('很久以前的任务', a, 'failed', 8 * 86400)
        self.server.history.conversations.create()
        self.prepare('报表怎么样了')
        self.assertIn('failed and interrupted are past states, see updated_at',
                      self.sessions[-1].calls[-1]['prompt'])
        jobs = {job['job_id']: job for job in self.job_index()['jobs']}
        self.assertEqual(jobs[failed]['state'], 'failed')
        self.assertIs(jobs[failed]['same_conversation'], False)
        self.assertEqual(set(jobs[failed]), {'job_id', 'title', 'state', 'updated_at', 'same_conversation'})
        self.assertNotIn(old, jobs)

    def test_b3_job_index_is_bounded_and_current_conversation_first(self):
        a = self.server.history.conversations.active
        long = '很长的标题' * 20
        for i in range(14):
            self.job(long + str(i), 'elsewhere', ('failed', 'interrupted', 'waiting_user')[i % 3], i * 60)
        mine = self.job('本对话的任务', a, 'running', 3600)
        self.prepare('最近的任务')
        index = self.job_index()
        jobs = index['jobs']
        self.assertLessEqual(len(jobs), 10)
        self.assertLessEqual(len(json.dumps(jobs, ensure_ascii=False)), 2000)
        self.assertEqual(index.get('jobs_truncated', 0), 10 - len(jobs))
        self.assertEqual(jobs[0]['job_id'], mine)
        self.assertTrue(jobs[0]['same_conversation'])
        self.assertEqual(jobs[1]['title'], long[:60])
        self.assertTrue(all(len(job['title']) <= 60 for job in jobs))
        updated = [job['updated_at'] for job in jobs[1:]]
        self.assertEqual(updated, sorted(updated, reverse=True))

    def test_b3_dispatch_window_is_seven_days(self):
        with patch.object(self.server.tasks, 'agent_dispatches', wraps=self.server.tasks.agent_dispatches) as dispatches:
            self.prepare('派出去的任务呢')
        self.assertAlmostEqual(dispatches.call_args.kwargs['since'], time.time() - 7 * 86400, delta=60)

    def test_d_reading_files_to_answer_is_not_a_task(self):
        self.prepare('这份文件说了什么')
        self.assertIn('Writing files, several tool steps or over 20 seconds', self.sessions[-1].calls[-1]['system_prompt'])
        self.assertIn('Chat, questions and answers from material need no task',self.sessions[-1].calls[-1]['system_prompt'])

    def test_b3_continuing_an_earlier_task_uses_task_continue(self):
        self.prepare('接着昨天那个报销汇总继续')
        self.assertIn('Earlier work to continue: task_continue, not a new task_plan', self.sessions[-1].calls[-1]['system_prompt'])

    def test_p0_1_history_turns_redact_pii_without_dropping_turns(self):
        self.server.mouth.history = [
            [{'role': 'user', 'content': '联系我 private@example.com'}, {'role': 'assistant', 'content': '记下了，联系 private@example.com'}],
            [{'role': 'user', 'content': '今天天气不错'}, {'role': 'assistant', 'content': '是啊。'}]]
        stored = json.loads(json.dumps(self.server.mouth.history))
        self.prepare('第一轮')
        sent = self.sessions[-1].calls[-1]['history']
        self.assertIn('private@example.com', sent[0][0]['content'])
        self.assertNotIn('private@example.com', sent[0][1]['content'])
        self.assertIn('今天天气不错', json.dumps(sent, ensure_ascii=False))
        self.assertEqual(len(sent), 2)
        self.assertEqual(self.server.mouth.history, stored)

    def use_reply_language(self, setting):
        self.c.settings.save({**self.c.settings.snapshot(), 'reply_language': setting})

    def test_the_reply_language_rule_is_in_the_system_and_its_tag_ends_the_wrapper(self):
        from brain.language import SYSTEM_RULE
        for setting, text, language in (('auto', 'Can you check why the build failed?', 'English'),
                                         ('ja', '今天天气怎么样', 'Japanese'), ('zh-Hans', 'How are you doing today', 'Simplified Chinese')):
            with self.subTest(setting=setting):
                self.use_reply_language(setting)
                self.prepare(text)
                call = self.sessions[-1].calls[-1]
                self.assertIn(SYSTEM_RULE, call['system_prompt'])
                self.assertTrue(call['prompt'].endswith(f'\n<reply_language>{language}</reply_language>\n{text}'), call['prompt'][-200:])
                self.assertEqual(call['prompt'].count('<reply_language>'), 1)

    def test_the_turn_hands_the_reply_language_to_the_runtime_for_its_fixed_notes(self):
        from character_agent.runtime import PersonalAgentRuntime
        run = PersonalAgentRuntime.run
        for setting, language in (('en', 'en'), ('ja', 'ja'), ('harness', None)):
            with self.subTest(setting=setting), patch.object(PersonalAgentRuntime, 'run', autospec=True, side_effect=run) as spy:
                self.use_reply_language(setting)
                self.prepare('Can you check why the build failed?')
                self.assertEqual(spy.call_args.kwargs['language'], language)

    def test_harness_reply_language_sends_neither_the_rule_nor_the_tag(self):
        from brain.language import SYSTEM_RULE
        self.use_reply_language('harness')
        self.prepare('Can you check why the build failed?')
        call = self.sessions[-1].calls[-1]
        self.assertNotIn(SYSTEM_RULE, call['system_prompt'])
        self.assertNotIn('reply_language', call['prompt'])
        self.assertTrue(call['prompt'].endswith('\nCan you check why the build failed?'))

    def test_only_the_users_own_turn_moves_the_auto_language(self):
        self.use_reply_language('auto')
        self.c.reply_language.pinned = 'zh-Hans'  # as on a Chinese system
        answer = self.c.prepare('turn-tap', 'Can you check why the build failed?', threading.Event(),
                                self.server.turn_generation, 'tap', {'remember': True, 'reset': -1})
        self.assertIsNone(answer.error)
        self.assertTrue(self.sessions[-1].calls[-1]['prompt'].endswith('<reply_language>Simplified Chinese</reply_language>\n'
                                                                      'Can you check why the build failed?'))
        self.prepare('Can you check why the build failed?')
        self.assertIn('<reply_language>English</reply_language>', self.sessions[-1].calls[-1]['prompt'])

    def test_side_and_unremembered_runs_start_the_harness_without_its_own_tools(self):
        with patch.object(self.c, '_session_factory', wraps=self.c._session_factory) as factory:
            self.prepare('普通对话')
            self.prepare('临时对话', remember=False)
            self.c.prepare('side-turn', '旁路对话', threading.Event(), self.server.turn_generation, 'text',
                           {'remember': True, 'reset': -1}, side=True)
            self.c.prepare('tap-turn', '', threading.Event(), self.server.turn_generation, 'tap',
                           {'remember': True, 'reset': -1})
            self.prepare('又一次普通对话')
        self.assertEqual([call.kwargs.get('native_tools', True) for call in factory.call_args_list],
                         [True, False, False, False, True])

    def test_a_tap_after_a_text_turn_opens_a_session_without_the_harness_tools(self):
        with patch.object(self.c, '_session_factory', wraps=self.c._session_factory) as factory:
            self.prepare('普通对话')
            self.c.prepare('tap-turn', '', threading.Event(), self.server.turn_generation, 'tap',
                           {'remember': True, 'reset': -1})
        self.assertEqual([call.kwargs.get('native_tools', True) for call in factory.call_args_list], [True, False])
        self.assertEqual(len(self.sessions), 2)

    def test_the_cards_reply_style_comes_last_before_the_tag_and_leaves_the_system(self):
        style = self.server.characters.load_card(self.server.character)['post_history_instructions']
        self.prepare('今天天气怎么样')
        call = self.sessions[-1].calls[-1]
        self.assertNotIn(style, call['system_prompt'])
        self.assertIn(f'<reply_style>\n{style}\n</reply_style>\n<reply_language>', call['prompt'])

    def test_history_keeps_the_users_own_phone_and_masks_her_retelling(self):
        self.server.mouth.history = [
            [{'role': 'user', 'content': '我的电话是 13812345678'},
             {'role': 'assistant', 'content': '屏幕上那个号码是 13987654321'}]]
        self.prepare('记住了吗')
        [[user, assistant]] = self.sessions[-1].calls[-1]['history']
        self.assertEqual(user['content'], '我的电话是 13812345678')
        self.assertEqual(assistant['content'], '屏幕上那个号码是 [已遮蔽:电话]')


class ScopedCancelTests(unittest.TestCase):
    def setUp(self):
        from test_character_agent_semantic import SemanticTests
        self.fixture = SemanticTests(); self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.addCleanup(self.fixture.tearDown)
        self.server, self.c = self.fixture.server, self.fixture.c
        self.c.discovery = SimpleNamespace(scan=lambda refresh=False: {'runtimes': [], 'scanned_at': 0})
        self.a = self.server.history.conversations.active
        self.b = self.server.history.conversations.create()['id']
        self.release = threading.Event(); self.sessions = {}
        self.addCleanup(self.release.set)
        self.c.session_factory_override = self.factory

    def factory(self, definitions):
        def work(session, prompt, options):
            ident = options['run_id']; self.sessions[ident] = session
            while not self.release.wait(.01) and not options['cancelled'](): pass
            yield from chat(session, prompt, options)
        return FakeSession(work)

    def wait(self, predicate):
        until = time.monotonic() + 3
        while time.monotonic() < until:
            if predicate(): return
            time.sleep(.01)
        self.fail('condition not reached')

    def request(self, path, body, token='ui', method='POST'):
        from control_panel import route as control_route
        from character_agent.routes.http import route
        h = SimpleNamespace(server=self.server, path=path, auth=lambda expected: token == expected,
                            body=lambda: body, json=lambda status, value: result.append((status, value)))
        result = []
        if not control_route(h, method, path) and not route(h, method, path): return 404, {'error': 'not_found'}
        return result[0]

    def job(self, conversation, running=True):
        topics = self.server.history.conversations
        topics.update(conversation, {'expected_version': topics.get(conversation)['revision']}, activate=True)
        job = self.c.submit_job('work', 'synthetic work', 'synthetic work')
        if running:
            self.wait(lambda: job['run_id'] in self.sessions)
        return job

    def foreground(self, ident='foreground', generation=7):
        runtime = self.c._ensure_runtime()
        worker = threading.Thread(target=lambda: runtime.run(run_id=ident, text='synthetic foreground',
            system_prompt='role', history=[], character_id='aster', generation=generation, conversation_id=self.a))
        worker.start(); self.addCleanup(lambda: (self.release.set(), worker.join(3)))
        self.wait(lambda: ident in self.sessions)
        return runtime

    def waiting_question(self, *, job=None, conversation=None):
        ident = job['run_id'] if job else 'waiting-foreground'
        self.c.store.begin(ident, conversation or self.a, self.server.character, 0)
        self.c.store.checkpoint(ident, None, {'task_id': None, 'goal': 'original-goal', 'scope_id': None,
            'dependencies': [], 'pending_tool': {'name': 'ask_user', 'tool_call_id': 'original-call',
                'args': {'questions': [{'id': 'q', 'question': '用途？'}]}}})
        with self.assertRaisesRegex(ValueError, 'interaction_pending'):
            self.c.interactions.ask(ident, [{'id': 'q', 'question': '用途？'}],
                valid=lambda: True, character_id=self.server.character, job_id=job['job_id'] if job else None)
        return self.c.interactions.list()[0]

    def test_waiting_foreground_run_can_be_cancelled_without_an_active_worker(self):
        card = self.waiting_question()
        code, body = self.c.cancel_run(card['run_id'], 0)
        self.assertEqual(code, 202, body)
        self.assertEqual(self.c.store.get(card['run_id'])['state'], 'cancelled')
        self.assertEqual(self.c.interactions.list(), [])

    def test_answer_claimed_before_cancel_cannot_dispatch_after_cancel_is_accepted(self):
        card = self.waiting_question(conversation=self.server.history.conversations.active)
        checkpoint = self.c.store.checkpoint
        def cancel_after_save(*args, **kwargs):
            saved = checkpoint(*args, **kwargs)
            self.assertEqual(self.c.cancel_run(card['run_id'], 0)[0], 202)
            return saved
        with patch.object(self.c.store, 'checkpoint', side_effect=cancel_after_save), \
                patch.object(self.server, 'say', return_value=(202, {'run_id': 'unwanted-resume', 'generation': 1})) as say:
            with self.assertRaisesRegex(ValueError, 'interaction_cancelled'):
                self.c.interactions.respond(card['request_id'], card['revision'], {'q': ['answer']})
        say.assert_not_called()
        self.assertEqual(self.c.store.get(card['run_id'])['state'], 'cancelled')
        self.assertIsNone(self.c.interactions.get(card['request_id']))

    def test_privacy_invalidation_after_question_claim_prevents_dispatch(self):
        card = self.waiting_question(conversation=self.server.history.conversations.active)
        checkpoint = self.c.store.checkpoint
        def revoke_after_save(*args, **kwargs):
            saved = checkpoint(*args, **kwargs)
            self.c.cancel('context_changed')
            return saved
        with patch.object(self.c.store, 'checkpoint', side_effect=revoke_after_save), \
                patch.object(self.server, 'say', return_value=(202, {'run_id': 'unwanted-resume', 'generation': 1})) as say:
            with self.assertRaisesRegex(ValueError, 'interaction_cancelled'):
                self.c.interactions.respond(card['request_id'], card['revision'], {'q': ['answer']})
        say.assert_not_called()
        self.assertIsNone(self.c.interactions.get(card['request_id']))

    def test_cancel_old_question_after_resume_stops_exact_new_foreground_run(self):
        card = self.waiting_question(conversation=self.server.history.conversations.active)
        self.c.interactions.respond(card['request_id'], card['revision'], {'q': ['answer']})
        continuation = self.c.store.get(card['run_id'])['result']['continuation']
        self.wait(lambda: continuation['run_id'] in self.sessions)
        self.assertEqual(self.c.cancel_run(card['run_id'], 0)[0], 202)
        self.wait(lambda: self.c.store.get(continuation['run_id'])['state'] == 'cancelled')
        self.assertGreater(self.sessions[continuation['run_id']].interrupted, 0)

    def test_task_stop_after_question_resume_stops_the_continued_worker(self):
        card = self.waiting_question(conversation=self.server.history.conversations.active)
        task_id = 'question-task'
        self.server.tasks.create(task_id, 'character', str(self.fixture.root), 'report', 'workspace_write')
        for state in ('approved', 'running', 'waiting_user'):
            self.server.tasks.transition(task_id, state)
        checkpoint = self.c.store.load_checkpoint(run_id=card['run_id'])
        self.c.store.checkpoint(card['run_id'], task_id, {**checkpoint, 'task_id': task_id})
        self.c.interactions.respond(card['request_id'], card['revision'], {'q': ['answer']})
        target = self.c.store.get(card['run_id'])['result']['continuation']['run_id']
        self.wait(lambda: target in self.sessions)
        self.assertTrue(self.c.cancel_task(task_id))
        self.wait(lambda: self.c.store.get(target)['state'] == 'cancelled')
        self.assertEqual(self.server.tasks.get(task_id)['state'], 'cancelled')

    def test_cancel_old_question_covers_dispatch_before_new_worker_begins(self):
        self.assert_pending_continuation_stopped()

    def test_privacy_revocation_covers_dispatch_before_new_worker_begins(self):
        self.assert_pending_continuation_stopped(privacy=True)

    def assert_pending_continuation_stopped(self, privacy=False):
        card = self.waiting_question(conversation=self.server.history.conversations.active)
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        run = self.server._run_character_line
        def delayed(*args, **kwargs):
            entered.set(); release.wait(3)
            return run(*args, **kwargs)
        with patch.object(self.server, '_run_character_line', side_effect=delayed):
            self.c.interactions.respond(card['request_id'], card['revision'], {'q': ['answer']})
            self.assertTrue(entered.wait(2))
            continuation = self.c.store.get(card['run_id'])['result']['continuation']
            self.assertIsNone(self.c.store.get(continuation['run_id']))
            if privacy:
                self.c.cancel('context_changed')
            else:
                self.assertEqual(self.c.cancel_run(card['run_id'], 0)[0], 202)
            self.assertTrue(self.server._line_cancel.is_set())
            release.set()
            self.wait(lambda: not self.server._live_lines)
        self.assertNotIn(continuation['run_id'], self.sessions)

    def test_cancel_old_question_after_background_resume_stops_same_job(self):
        def factory(definitions):
            def work(session, prompt, options):
                self.sessions[options['run_id']] = session
                if not options.get('ask_user_result'):
                    yield from session.use(options, 'ask_user', {'questions': [{'id': 'q', 'question': '用途？'}]})
                else:
                    while not self.release.wait(.01) and not options['cancelled'](): pass
                yield from chat(session, prompt, options)
            return FakeSession(work)
        self.c.session_factory_override = factory
        job = self.job(self.server.history.conversations.active)
        self.wait(lambda: self.c.jobs.store.get(job['job_id'])['state'] == 'waiting_user')
        card = self.c.interactions.list()[0]
        self.c.interactions.respond(card['request_id'], card['revision'], {'q': ['answer']})
        resumed = self.c.jobs.store.get(job['job_id'])
        self.wait(lambda: resumed['run_id'] in self.sessions)
        self.assertNotEqual(resumed['run_id'], job['run_id'])
        self.assertEqual(self.c.cancel_run(job['run_id'], job['generation'])[0], 202)
        self.wait(lambda: self.c.store.get(resumed['run_id'])['state'] == 'cancelled')
        self.assertEqual(self.c.jobs.store.get(job['job_id'])['state'], 'cancelled')

    def test_continuation_stop_rejects_wrong_identity_and_cycles(self):
        card = self.waiting_question(conversation=self.server.history.conversations.active)
        run = self.c.store.get(card['run_id'])
        for replacement in ({'conversation_id': 'other'}, {'character_id': 'other'}, {'generation': True}, {}):
            continuation = {'run_id': card['run_id'], 'generation': 0, 'conversation_id': run['conversation_id'],
                            'character_id': run['character_id'], 'job_id': None, **replacement}
            with self.c.store.lock:
                self.c.store.db.execute('UPDATE character_runs SET result=? WHERE run_id=?',
                    (json.dumps({'continuation': continuation}), card['run_id']))
                self.c.store.db.commit()
            with patch.object(self.server, 'cancel_turn') as cancel:
                self.assertEqual(self.c.cancel_run(card['run_id'], 0), (409, {'error': 'continuation_changed'}))
                cancel.assert_not_called()

    def test_old_question_stop_does_not_cancel_later_manual_job_retry(self):
        def factory(definitions):
            def work(session, prompt, options):
                if not options.get('ask_user_result'):
                    yield from session.use(options, 'ask_user', {'questions': [{'id': 'q', 'question': '用途？'}]})
                yield from chat(session, prompt, options)
            return FakeSession(work)
        self.c.session_factory_override = factory
        job = self.c.submit_job('report', 'prepare report', 'prepare report')
        self.wait(lambda: self.c.jobs.store.get(job['job_id'])['state'] == 'waiting_user')
        card = self.c.interactions.list()[0]
        self.c.interactions.respond(card['request_id'], card['revision'], {'q': ['answer']})
        self.wait(lambda: self.c.jobs.store.get(job['job_id'])['state'] == 'needs_review')
        retry = self.c.resume_job(job['job_id'])
        self.wait(lambda: self.c.jobs.store.get(job['job_id'])['state'] == 'waiting_user')
        self.assertEqual(self.c.cancel_run(job['run_id'], job['generation'])[0], 409)
        self.assertEqual(self.c.jobs.store.get(job['job_id'])['state'], 'waiting_user')
        self.assertTrue(any(row['run_id'] == retry['run_id'] for row in self.c.interactions.list()))

    def test_pending_continuation_from_another_process_cannot_stop_a_new_turn(self):
        card = self.waiting_question(conversation=self.server.history.conversations.active)
        run = self.c.store.get(card['run_id'])
        link = {'run_id': 'missing-old-worker', 'generation': self.server.turn_generation,
                'conversation_id': run['conversation_id'], 'character_id': run['character_id'],
                'job_id': None, 'dispatch_epoch': 'another-process'}
        with self.c.store.lock:
            self.c.store.db.execute('UPDATE character_runs SET result=? WHERE run_id=?',
                (json.dumps({'continuation': link}), card['run_id']))
            self.c.store.db.commit()
        with patch.object(self.server, 'cancel_turn') as cancel:
            self.assertEqual(self.c.cancel_run(card['run_id'], 0), (409, {'error': 'run_finished'}))
            self.c.cancel('context_changed')
            cancel.assert_not_called()

    def test_answer_does_not_resume_another_conversations_question(self):
        active = self.server.history.conversations.active
        card = self.waiting_question(conversation=self.a if active == self.b else self.b)
        self.server.say = Mock(return_value=(202, {'run_id': 'wrong-conversation'}))
        with self.assertRaisesRegex(ValueError, 'conversation_not_active'):
            self.c.interactions.respond(card['request_id'], card['revision'], {'q': ['answer']})
        self.server.say.assert_not_called()
        self.assertEqual(self.c.interactions.get(card['request_id'])['state'], 'answered')

    def test_dismissing_waiting_job_cancels_the_work(self):
        job = self.c.jobs.store.submit('question', {'user_request': 'original'}, conversation_id=self.a)
        self.c.jobs.store.claim()
        card = self.waiting_question(job=job)
        code, body = self.request('/agent/interactions/' + card['request_id'] + '/dismiss',
            {'expected_version': card['revision']})
        self.assertEqual(code, 200, body)
        self.assertEqual(self.c.jobs.store.get(job['job_id'])['state'], 'cancelled')
        self.assertEqual(self.c.store.get(job['run_id'])['state'], 'cancelled')

    def test_k10_new_controller_answers_retained_foreground_card(self):
        from character_agent.services.interactions import QuestionTurn
        topics = self.server.history.conversations
        topics.update(self.a, {'expected_version': topics.get(self.a)['revision']}, activate=True)
        runtime = self.c._ensure_runtime()
        self.c.interactions.wait_seconds = 0
        def factory(definitions):
            def work(session, prompt, options):
                yield from session.use(options, 'ask_user', {'questions': [{'id': 'q', 'question': 'private-question'}]})
            return FakeSession(work)
        runtime.session_factory = factory
        runtime.run(run_id='asked', text='original-goal', system_prompt='role', history=[], character_id=self.server.character,
            generation=0, conversation_id=self.a, question_session=QuestionTurn(self.c.interactions, True,
                'asked', self.server.character, 'original-goal', None))
        self.assertEqual(self.c.store.get('asked')['state'], 'waiting_user')
        self.c.close(); self.c.store.close(); self.c.workspace.close()
        self.c = self.fixture.c = self.server.character_agent = CharacterAgentController(self.server, self.fixture.root,
            session_factory=self.factory)
        self.server.say = Mock(return_value=(202, {'run_id': 'resumed'}))
        card = self.c.interactions.list()[0]
        self.c.interactions.respond(card['request_id'], card['revision'], {'q': ['answer']})
        self.server.say.assert_called_once_with('original-goal', scope_id=None, resume_run_id='asked', ready_chat=ANY)
        checkpoint = self.c.store.load_checkpoint(run_id='asked')
        self.assertEqual(checkpoint['pending_tool']['result'], {'answers': {'q': ['answer']}})
        self.assertEqual(self.c.interactions.get(card['request_id'])['state'], 'resumed')

    def test_k10_background_wait_releases_worker_and_answer_resumes_same_job(self):
        self.c.jobs.concurrency = 1
        now = [100.]
        self.c.jobs.store.clock = lambda: now[0]
        def factory(definitions):
            def work(session, prompt, options):
                self.sessions[options['run_id']] = session
                if 'ask-first' in prompt and not options.get('ask_user_result'):
                    yield from session.use(options, 'ask_user', {'questions': [{'id': 'q', 'question': 'private-question'}]})
                yield from chat(session, prompt, options)
            return FakeSession(work)
        self.c.session_factory_override = factory
        first = self.c.submit_job('first', 'ask-first', 'ask-first')
        self.wait(lambda: bool(self.c.interactions.list()))
        self.wait(lambda: self.c.jobs.store.get(first['job_id'])['state'] != 'running')
        self.assertEqual(self.c.jobs.store.get(first['job_id'])['state'], 'waiting_user')
        second = self.c.submit_job('second', 'other', 'other')
        self.wait(lambda: self.c.jobs.store.get(second['job_id'])['state'] == 'needs_review')
        self.assertFalse(self.c.jobs.store.leased(first['job_id']))
        now[0] += 2 * 3600
        self.c.interactions.clock = lambda: time.time() + 86400
        card = self.c.interactions.list()[0]
        self.assertEqual(self.request('/agent/interactions/' + card['request_id'] + '/answer',
            {'expected_version': card['revision'], 'answers': {'q': ['real-answer']}})[0], 200)
        self.wait(lambda: self.c.jobs.store.get(first['job_id'])['state'] == 'needs_review')
        resumed = self.c.jobs.store.get(first['job_id'])
        self.assertEqual(resumed['previous_run_id'], first['run_id'])
        options = self.sessions[resumed['run_id']].calls[0]
        self.assertEqual(options['ask_user_result']['result'], {'answers': {'q': ['real-answer']}})
        self.assertNotIn('private-question', options['prompt'])

    def test_a_resumed_ask_user_answer_reaches_the_harness_masked(self):
        def factory(definitions):
            def work(session, prompt, options):
                self.sessions[options['run_id']] = session
                if 'ask-first' in prompt and not options.get('ask_user_result'):
                    yield from session.use(options, 'ask_user', {'questions': [{'id': 'q', 'question': 'which key?'}]})
                yield from chat(session, prompt, options)
            return FakeSession(work)
        self.c.session_factory_override = factory
        first = self.c.submit_job('first', 'ask-first', 'ask-first')
        self.wait(lambda: bool(self.c.interactions.list()))
        self.wait(lambda: self.c.jobs.store.get(first['job_id'])['state'] == 'waiting_user')
        card = self.c.interactions.list()[0]
        self.assertEqual(self.request('/agent/interactions/' + card['request_id'] + '/answer',
            {'expected_version': card['revision'], 'answers': {'q': ['use sk-abcdefghijklmnopqrstuvwx']}})[0], 200)
        self.wait(lambda: self.c.jobs.store.get(first['job_id'])['state'] == 'needs_review')
        resumed = self.c.jobs.store.get(first['job_id'])
        options = self.sessions[resumed['run_id']].calls[0]
        self.assertEqual(options['ask_user_result']['result'], {'answers': {'q': ['use [已遮蔽:密钥]']}})

    def test_k06_conversation_cancel_stops_the_foreground_and_leaves_its_jobs_running(self):
        one = self.job(self.a); queued = self.job(self.a, running=False)
        runtime = self.foreground()
        code, body = self.request('/conversations/' + self.a + '/cancel', {'run_id': 'foreground', 'generation': 7})
        self.assertEqual(code, 202, body)
        self.wait(lambda: not runtime.busy())
        self.assertEqual(self.c.store.get('foreground')['state'], 'cancelled')
        self.assertEqual(self.c.jobs.store.get(one['job_id'])['state'], 'running')
        self.assertIn(self.c.jobs.store.get(queued['job_id'])['state'], ('queued', 'running'))
        self.assertEqual(self.sessions[one['run_id']].interrupted, 0)

    def test_k06_conversation_cancel_leaves_a_waiting_job_run_to_its_own_cancel(self):
        job = self.c.jobs.store.submit('question', {'user_request': 'original'}, conversation_id=self.a)
        self.c.jobs.store.claim()
        card = self.waiting_question(job=job)
        code, body = self.request('/conversations/' + self.a + '/cancel', {'run_id': job['run_id'], 'generation': 0})
        self.assertEqual(code, 202, body)
        self.assertEqual(self.c.store.get(job['run_id'])['state'], 'waiting_user')
        self.assertEqual([c['request_id'] for c in self.c.interactions.list()], [card['request_id']])

    def test_k06_conversation_cancel_foreground_preserves_other_job_speech_and_turn(self):
        other = self.job(self.b); runtime = self.foreground()
        from unittest.mock import Mock
        self.server.speech = SimpleNamespace(cancel=Mock(return_value=False))
        self.server._voiced = (other['run_id'], 'utterance', 'immediate')
        generation = self.server.turn_generation
        code, body = self.request('/conversations/' + self.a + '/cancel', {'run_id': 'foreground', 'generation': 7})
        self.assertEqual(code, 202, body)
        self.wait(lambda: not runtime.busy())
        self.assertEqual(self.c.store.get('foreground')['state'], 'cancelled')
        self.assertEqual(self.c.jobs.store.get(other['job_id'])['state'], 'running')
        self.server.speech.cancel.assert_not_called()
        self.assertEqual(self.server.turn_generation, generation)
        self.server.speech = None

    def test_k06_stale_conversation_identity_and_generation_stop_nothing(self):
        runtime = self.foreground()
        for run, generation in (('old', 7), ('foreground', 6)):
            code, body = self.request('/conversations/' + self.a + '/cancel', {'run_id': run, 'generation': generation})
            self.assertEqual((code, body), (409, {'error': 'run_changed', 'run_id': 'foreground', 'generation': 7}))
        self.assertTrue(runtime.busy()); self.assertEqual(self.sessions['foreground'].interrupted, 0)
        self.release.set()

    def test_k06_late_run_cancel_does_not_interrupt_next_foreground(self):
        runtime = self.foreground('old'); self.release.set()
        self.wait(lambda: not runtime.busy()); self.release.clear()
        self.foreground('next', 8)
        code, body = self.request('/agent/runs/old/cancel', {'generation': 7})
        self.assertEqual((code, body), (409, {'error': 'run_finished'}))
        self.assertEqual(self.sessions['next'].interrupted, 0)
        self.release.set(); self.wait(lambda: not runtime.busy())
        self.assertEqual(self.c.store.get('next')['state'], 'completed')

    def test_k06_run_cancel_matches_background_generation_and_leaves_foreground(self):
        job = self.job(self.b); runtime = self.foreground()
        path = '/agent/runs/' + job['run_id'] + '/cancel'
        code, body = self.request(path, {'generation': job['generation'] + 1})
        self.assertEqual((code, body), (409, {'error': 'run_changed', 'run_id': job['run_id'], 'generation': job['generation']}))
        self.assertEqual(self.c.jobs.store.get(job['job_id'])['state'], 'running')
        self.assertEqual(self.request(path, {'generation': job['generation']})[0], 202)
        self.assertTrue(runtime.busy()); self.assertEqual(self.sessions['foreground'].interrupted, 0)
        self.assertEqual(self.c.jobs.store.get(job['job_id'])['state'], 'cancelled')
        self.release.set()

    def test_k06_run_cancel_stops_only_matching_foreground(self):
        other = self.job(self.b); runtime = self.foreground()
        code, body = self.request('/agent/runs/foreground/cancel', {'generation': 7})
        self.assertEqual(code, 202, body)
        self.wait(lambda: not runtime.busy())
        self.assertEqual(self.c.store.get('foreground')['state'], 'cancelled')
        self.assertEqual(self.c.jobs.store.get(other['job_id'])['state'], 'running')

    def test_k06_turn_cancel_keeps_working_foreground_and_background_jobs(self):
        from api.handler import Handler
        one = self.job(self.a); two = self.job(self.b); queued = self.job(self.a, running=False)
        runtime = self.foreground()
        line = self.server._line_cancel = runtime._active['cancel']
        self.server._live_lines.add(line)
        self.addCleanup(self.server._live_lines.discard, line)
        for reason in ('client_cancel', 'barge_in'):
            with self.subTest(reason=reason):
                result = []
                h = SimpleNamespace(server=self.server, _json=lambda code, body: result.append((code, body)))
                Handler._turn_cancel(h, {'reason': reason})
                self.assertEqual(result[0][0], 202)
                self.assertFalse(result[0][1]['cancelled']['line'])
                self.assertFalse(line.is_set())
                self.assertTrue(runtime.busy())
                self.assertEqual(self.sessions['foreground'].interrupted, 0)
                self.assertEqual(self.c.jobs.store.get(one['job_id'])['state'], 'running')
                self.assertEqual(self.c.jobs.store.get(two['job_id'])['state'], 'running')
                self.assertEqual(self.c.jobs.store.get(queued['job_id'])['state'], 'queued')

    def test_k06_cancel_routes_auth_reset_and_payload_validation(self):
        paths = [('/conversations/' + self.a + '/cancel', {'run_id': 'run', 'generation': 1}),
                 ('/agent/runs/run/cancel', {'generation': 1})]
        for path, valid in paths:
            self.assertEqual(self.request(path, valid, token='hook')[0], 401)
            self.server.resetting = True
            self.assertEqual(self.request(path, valid)[0], 503)
            self.server.resetting = False
            for body in ([], {}, {**valid, 'extra': True}, {**valid, 'generation': True}, {**valid, 'generation': '1'}):
                self.assertEqual(self.request(path, body), (400, {'error': 'invalid_payload'}))
        self.assertEqual(self.request('/conversations/' + 'f'*32 + '/cancel', paths[0][1]), (404, {'error': 'unknown_conversation'}))

    def test_k06_scoped_cancel_stops_only_owned_desktop_client(self):
        self.addCleanup(self.c.tools.desktop._held.clear)
        for path, ident in (('/agent/runs/native-run/cancel', 'native-run'),
                            ('/conversations/' + self.a + '/cancel', 'native-conversation')):
            self.foreground(ident)
            self.c.tools.desktop._held[ident] = SimpleNamespace(config=object(), session_id=ident)
            self.c.tools.desktop._held['other'] = SimpleNamespace(config=object(), session_id='other')
            stopped = threading.Event()
            with patch('tool_gateway.desktop.ComputerControlClient') as client:
                client.return_value.call.side_effect = lambda *_: stopped.set()
                body = {'generation': 7}
                if path.startswith('/conversations/'): body['run_id'] = ident
                self.assertEqual(self.request(path, body)[0], 202)
                self.assertTrue(stopped.wait(1), 'owned desktop client was not cancelled')
                self.assertEqual(client.call_args.args[1], ident)
                client.return_value.call.assert_called_once_with('desktop_cancel', {})
            self.assertNotIn(ident, self.c.tools.desktop.held())
            self.assertEqual(self.c.tools.desktop.held()['other'], 'other')
            self.c.tools.desktop._held.clear()
            self.wait(lambda: not self.c.runtime.busy())

    def test_w004_unrelated_memory_keeps_running_job_and_question_answerable(self):
        fact = self.server.memory.add('旧资料', 'asserted_by_user')
        def factory(definitions):
            def work(session, prompt, options):
                self.sessions[options['run_id']] = session
                yield from session.use(options, 'ask_user', {'questions': [{'id': 'q', 'question': '用途？'}]})
                yield from chat(session, prompt, options)
            return FakeSession(work)
        self.c.session_factory_override = factory
        job = self.job(self.a)
        self.wait(lambda: bool(self.c.interactions.list()))
        card = self.c.interactions.list()[0]
        self.server.memory.correct(fact, '更正资料')
        self.server._memories_changed([fact])
        self.assertEqual(self.c.jobs.store.get(job['job_id'])['state'], 'waiting_user')
        self.c.session_factory_override = lambda definitions: FakeSession(chat)
        answered = self.c.interactions.respond(card['request_id'], card['revision'], {'q': ['核查']})
        self.assertEqual(answered['answer'], {'answers': {'q': ['核查']}})
        self.wait(lambda: self.c.jobs.store.get(job['job_id'])['state'] == 'needs_review')

    def test_w004_correct_memory_and_start_task_in_one_turn(self):
        fact = self.server.memory.add('报告使用旧格式', 'asserted_by_user')
        started = threading.Event()
        def factory(definitions):
            def work(session, prompt, options):
                if 'background_assignment' in prompt:
                    self.sessions[options['run_id']] = session
                    started.set()
                    while not self.release.wait(.01) and not options['cancelled'](): pass
                else:
                    yield from session.use(options, 'knowledge_read', {'source': 'memory', 'id': fact})
                    receipt = yield from session.use(options, 'memory_propose', {'operation': 'correct',
                        'fact_id': fact, 'expected_version': 1, 'target_quote': '报告使用旧格式',
                        'text': '报告使用新格式', 'evidence_quote': '报告使用新格式'})
                    self.assertEqual(receipt['outcome'], 'corrected')
                    yield from session.use(options, 'background_start', {'title': '核查', 'instruction': '整理资料'})
                    self.assertTrue(started.wait(2))
                yield from chat(session, prompt, options)
            return FakeSession(work)
        self.c.session_factory_override = factory
        answer = self.c.prepare('correction-turn', '更正报告使用旧格式，报告使用新格式，然后后台整理资料',
            threading.Event(), self.server.turn_generation, 'text', {'remember': True, 'reset': -1})
        self.assertIsNone(answer.error)
        job = self.c.jobs.store.list()[0]
        self.assertEqual(job['source_turn_id'], 'correction-turn')
        self.assertEqual(job['state'], 'running')
        self.assertEqual(self.sessions[job['run_id']].interrupted, 0)

    def test_cancelling_a_goal_cancels_its_waiting_job_and_card(self):
        def factory(definitions):
            def work(session, prompt, options):
                yield from session.use(options, 'ask_user', {'questions': [{'id': 'q', 'question': '用途？'}]})
                yield from chat(session, prompt, options)
            return FakeSession(work)
        self.c.session_factory_override = factory
        goal = self.c.jobs.store.create_goal('事项', '整理')
        job = self.c.submit_job('work', 'synthetic work', 'synthetic work', goal_id=goal['goal_id'])
        self.wait(lambda: self.c.jobs.store.get(job['job_id'])['state'] == 'waiting_user')
        self.c.update_goal(goal['goal_id'], self.c.jobs.store.goal(goal['goal_id'])['revision'], 'cancelled')
        self.wait(lambda: self.c.jobs.store.get(job['job_id'])['state'] == 'cancelled')
        self.assertEqual(self.c.interactions.list(), [])

    def test_a_turn_that_corrects_a_fact_keeps_its_own_items_and_the_observations(self):
        fact = self.server.memory.add('报告使用旧格式', 'asserted_by_user')
        def factory(definitions):
            def work(session, prompt, options):
                yield from session.use(options, 'knowledge_read', {'source': 'memory', 'id': fact})
                receipt = yield from session.use(options, 'memory_propose', {'operation': 'correct',
                    'fact_id': fact, 'expected_version': 1, 'target_quote': '报告使用旧格式',
                    'text': '报告使用新格式', 'evidence_quote': '报告使用新格式'})
                self.assertEqual(receipt['outcome'], 'corrected')
                yield {'type': 'item', 'item_id': 'said', 'kind': 'assistant_text', 'status': 'completed', 'summary': '记下了'}
                yield from chat(session, prompt, options)
            return FakeSession(work)
        self.c.session_factory_override = factory
        with patch.object(self.c.observations, 'clear') as observations, patch.object(self.c.observation_briefs, 'clear') as briefs:
            answer = self.c.prepare('correction-turn', '更正报告使用旧格式，报告使用新格式',
                threading.Event(), self.server.turn_generation, 'text', {'remember': True, 'reset': -1})
        self.assertIsNone(answer.error)
        observations.assert_not_called(); briefs.assert_not_called()
        said = next(i for i in self.c.store.items('correction-turn') if i['item_id'] == 'said')
        self.assertEqual(said['summary'], '记下了')

    def test_w004_used_memory_interrupts_only_dependent_job_and_cards(self):
        fact = self.server.memory.add('旧资料', 'asserted_by_user')
        def factory(definitions):
            def work(session, prompt, options):
                if 'uses-memory' in prompt:
                    yield from session.use(options, 'knowledge_read', {'source': 'memory', 'id': fact})
                    yield from session.use(options, 'task_plan', {'title': '核查', 'outputs': []})
                self.sessions[options['run_id']] = session
                yield from session.use(options, 'ask_user', {'questions': [{'id': 'q', 'question': '用途？'}]})
                yield from chat(session, prompt, options)
            return FakeSession(work)
        self.c.session_factory_override = factory
        dependent = self.c.submit_job('依赖资料', 'uses-memory', '核查')
        other = self.job(self.b)
        self.wait(lambda: len(self.c.interactions.list()) == 2)
        self.server.memory.correct(fact, '更正资料')
        self.server._memories_changed([fact])
        row = self.c.jobs.store.get(dependent['job_id'])
        self.assertEqual(row['state'], 'interrupted')
        self.assertEqual(row['result']['reason'], 'memory_changed')
        self.wait(lambda: self.c.store.get(dependent['run_id'])['state'] != 'running')
        run = self.c.store.get(dependent['run_id'])
        self.assertEqual(run['result']['error'], 'memory_changed')
        self.assertEqual(self.server.tasks.get(run['task_id'])['state'], 'interrupted')
        self.assertEqual(self.c.jobs.store.get(other['job_id'])['state'], 'waiting_user')
        self.assertEqual([r['run_id'] for r in self.c.interactions.list()], [other['run_id']])

    def test_w004_cancellation_reason_before_runner_callback(self):
        fact=self.server.memory.add('旧资料','asserted_by_user')
        paused=threading.Event();resume=threading.Event();self.addCleanup(resume.set)
        def factory(definitions):
            def work(session,prompt,options):
                yield from session.use(options,'knowledge_read',{'source':'memory','id':fact})
                yield from session.use(options,'task_plan',{'title':'核查','outputs':[]})
                try:
                    yield from session.use(options,'ask_user',{'questions':[{'id':'q','question':'用途？'}]})
                except Exception:
                    paused.set();resume.wait(3);raise
            return FakeSession(work)
        self.c.session_factory_override=factory
        job=self.c.submit_job('依赖资料','uses-memory','核查')
        self.assertTrue(paused.wait(2))
        original=self.c.jobs.cancel_runner
        def delayed(ident):
            resume.set()
            self.wait(lambda:self.c.store.get(job['run_id'])['state'] not in ('running','waiting_user'))
            original(ident)
        self.c.jobs.cancel_runner=delayed
        self.server.memory.correct(fact,'更正资料');self.server._memories_changed([fact])
        run=self.c.store.get(job['run_id'])
        self.assertEqual(run['state'],'interrupted')
        self.assertEqual(run['result']['error'],'memory_changed')
        self.assertEqual(self.c.jobs.store.get(job['job_id'])['result']['reason'],'memory_changed')

    def test_w004_context_change_stops_only_run_using_that_kind(self):
        other = self.job(self.b)
        runtime = self.foreground()
        self.server._line_context[runtime._active['cancel']] = ('foreground', {'page'})
        self.server._context_changed('selection')
        self.assertTrue(runtime.busy())
        self.assertEqual(self.sessions['foreground'].interrupted, 0)
        self.server._context_changed('page')
        self.wait(lambda: not runtime.busy())
        self.assertEqual(self.c.store.get('foreground')['result']['error'], 'context_changed')
        self.assertEqual(self.c.jobs.store.get(other['job_id'])['state'], 'running')

    def test_w004_resumed_job_keeps_previous_attempt_dependencies(self):
        fact = self.server.memory.add('旧资料', 'asserted_by_user')
        knowledge = self.c.knowledge()
        knowledge.call('knowledge_read', {'source': 'memory', 'id': fact})
        jobs = []
        for state in ('running', 'queued'):
            job = self.c.jobs.store.submit('依赖资料', {'user_request': '核查'})
            self.c.jobs.store.claim()
            self.c.store.begin(job['run_id'], self.a, 'aster', 0)
            self.c.store.finish(job['run_id'], 'interrupted', dependencies=knowledge.dependencies())
            self.c.jobs.store.settle(job['job_id'], 'interrupted')
            resumed = self.c.jobs.store.resume(job['job_id'])
            if state == 'running': self.c.jobs.store.claim()
            jobs.append(resumed)
        self.server.memory.correct(fact, '更正资料')
        self.server._memories_changed([fact])
        for job in jobs:
            with self.subTest(run_id=job['run_id']):
                self.assertEqual(self.c.jobs.store.get(job['job_id'])['state'], 'interrupted')

    def test_w004_pending_question_retains_dependencies_after_run_returns(self):
        fact = self.server.memory.add('旧资料', 'asserted_by_user')
        self.c.interactions.wait_seconds = 0
        def factory(definitions):
            def work(session, prompt, options):
                yield from session.use(options, 'knowledge_read', {'source': 'memory', 'id': fact})
                yield from session.use(options, 'ask_user', {'questions': [{'id': 'q', 'question': '用途？'}]})
                yield from chat(session, prompt, options)
            return FakeSession(work)
        self.c.session_factory_override = factory
        job = self.c.submit_job('依赖资料', '核查', '核查')
        self.wait(lambda: self.c.jobs.store.get(job['job_id'])['state'] == 'waiting_user')
        self.assertEqual([d['id'] for d in self.c.store.get(job['run_id'])['dependencies']], [fact])
        card = self.c.interactions.list()[0]
        self.server.memory.correct(fact, '更正资料')
        self.server._memories_changed([fact])
        self.assertIsNone(self.c.interactions.get(card['request_id']))

    def test_w004_consent_revocation_still_stops_everything_and_deletes_cards(self):
        one = self.job(self.a); two = self.job(self.b)
        queued = self.job(self.a, running=False)
        runtime = self.foreground()
        self.c.interactions.wait_seconds = 0
        for run in (one['run_id'], two['run_id'], 'foreground'):
            with self.assertRaisesRegex(ValueError, 'interaction_pending'):
                self.c.interactions.ask(run, [{'id': 'q', 'question': '用途？'}], valid=lambda: True, character_id='aster')
        self.server.sync_privacy(revoked=('page_text',))
        self.wait(lambda: not runtime.busy())
        for job in (one, two, queued):
            self.assertEqual(self.c.jobs.store.get(job['job_id'])['state'], 'cancelled')
        self.assertEqual(self.c.interactions.list(), [])

    def test_w004_scope_revocation_deletes_cards_created_during_cancellation(self):
        ask_now = threading.Event()
        self.addCleanup(ask_now.set)
        def factory(definitions):
            def work(session, prompt, options):
                self.sessions[options['run_id']] = session
                ask_now.wait(2)
                yield from session.use(options, 'ask_user', {'questions': [{'id': 'q', 'question': '用途？'}]})
                yield from chat(session, prompt, options)
            return FakeSession(work)
        self.c.session_factory_override = factory
        job = self.job(self.a)
        cancel_all = self.c.jobs.cancel_all
        def cancel(reason):
            ask_now.set()
            self.wait(lambda: bool(self.c.interactions.list()))
            cancel_all(reason)
        with patch.object(self.c.jobs, 'cancel_all', side_effect=cancel):
            self.c.cancel('scope_revoked')
        self.assertEqual(self.c.jobs.store.get(job['job_id'])['state'], 'cancelled')
        self.assertEqual(self.c.interactions.list(), [])


class JobReportTests(IntegrationFixture):
    """A job she handed off in a conversation ends: she tells its result once, as her message in that conversation."""

    def setUp(self):
        super().setUp()
        self.server._stopped.set(); self.server._ticker.join(2)  # each test ticks by hand
        self.server.gate.enabled = True

    def tearDown(self):
        self.controller.jobs.close()
        super().tearDown()

    def settled(self):
        deadline = time.monotonic() + 5
        while self.server._live_lines and time.monotonic() < deadline: time.sleep(.005)
        self.assertFalse(self.server._live_lines)

    def handed_off(self):
        def work(session, prompt, options):
            if 'background_assignment' in prompt:
                yield {'type': 'result', 'success': True, 'final_text': '资料整理好了，写在 notes.md。', 'usage': {}}
            elif '<event kind="job_report">' in prompt:
                yield from chat(session, prompt, options)
            else:
                yield from session.use(options, 'background_start', {'title': '整理资料', 'instruction': '只读整理已授权资料'})
                yield {'type': 'result', 'success': True, 'final_text': '好，我交给后台整理了。', 'usage': {}}
        self.script = work
        conversation = self.server.history.conversations.active
        body, _ = self.line('帮我在后台整理一下资料')
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            jobs = self.controller.jobs.store.list(private=True)
            if jobs and jobs[0]['state'] not in ('queued', 'running'): break
            time.sleep(.01)
        [job] = self.controller.jobs.store.list(private=True)
        self.assertIn(job['state'], ('succeeded', 'needs_review'))
        self.assertEqual((job['conversation_id'], job['payload']['source_run_id']), (conversation, body['run_id']))
        return conversation, job

    def told(self, job):
        delivery = self.controller.deliveries.produce(job['run_id'])
        return self.controller.deliveries.was_told(delivery['delivery_id'])

    def test_a_finished_job_is_told_once_as_her_message_in_its_own_conversation(self):
        conversation, job = self.handed_off()
        before = self.server.history.conversations.turns(conversation)['turns']
        other = self.server.history.conversations.create()['id']  # the user went on in another conversation
        with patch.object(self.server, 'claim_line', wraps=self.server.claim_line) as claim:
            self.server._schedules_due()
            self.settled()
            self.server._schedules_due()
        claim.assert_called_once()
        args, kwargs = claim.call_args
        self.assertTrue(args[1].startswith('<event kind="job_report">\nThe work you handed to the background earlier '
                                           f'for {self.server.user_title()} is done'))
        self.assertIn('帮我在后台整理一下资料', kwargs['material'])
        self.assertIn('好，我交给后台整理了。', kwargs['material'])
        self.assertIn('资料整理好了', kwargs['material'])
        turns = self.server.history.conversations.turns(conversation)['turns']
        self.assertEqual(len(turns), len(before) + 1)
        self.assertEqual((turns[-1]['source'], turns[-1]['user_text'], turns[-1]['reply']), ('proactive', '', 'Hello'))
        self.assertEqual(self.server.history.conversations.turns(other)['turns'], [])
        self.assertTrue(self.told(job))

    def test_her_job_ends_reach_her_body(self):
        behavior = self.server.behavior = Mock()
        _, job = self.handed_off()
        deadline = time.monotonic() + 3
        while not behavior.event.called and time.monotonic() < deadline: time.sleep(.005)
        behavior.event.assert_called_once_with('job_done')
        for state, kinds in (('failed', ['job_failed']), ('cancelled', []), ('needs_review', ['job_done'])):
            with self.subTest(state=state):
                behavior.reset_mock()
                self.controller._job_event({'event_id': 'e-' + state, 'job_id': job['job_id'], 'seq': 9,
                                            'state': state, 'at': time.time()})
                self.assertEqual([call.args[0] for call in behavior.event.call_args_list], kinds)

    def test_her_queued_or_running_job_is_in_the_situation(self):
        store = self.controller.jobs.store
        self.assertFalse(self.server.situation()['own_job'])
        job = store.submit('整理资料', {'instruction': '只读整理'})
        self.assertTrue(self.server.situation()['own_job'])
        self.assertEqual(store.claim()['job_id'], job['job_id'])
        self.assertTrue(self.server.situation()['own_job'])
        store.settle(job['job_id'], 'succeeded', {})
        self.assertFalse(self.server.situation()['own_job'])

    def test_a_told_job_is_not_told_again_after_a_restart(self):
        _, job = self.handed_off()
        self.server._schedules_due()
        self.settled()
        self.server._reported_tasks.clear()  # a new process: the same store, nothing in memory
        with patch.object(self.server, 'claim_line', return_value=True) as claim:
            self.server._schedules_due()
        claim.assert_not_called()

    def test_a_busy_claim_writes_no_receipt_and_the_next_tick_tells_it(self):
        _, job = self.handed_off()
        with patch.object(self.server, 'claim_line', return_value=False) as claim:
            self.server._schedules_due()
        claim.assert_called_once()
        self.assertFalse(self.told(job))
        with patch.object(self.server, 'claim_line', side_effect=lambda *a, on_voiced, **kw: on_voiced() or True) as claim:
            self.server._schedules_due(); self.server._schedules_due()
        claim.assert_called_once()
        self.assertTrue(self.told(job))

    def test_a_line_cancelled_before_it_says_anything_writes_no_receipt_and_the_next_tick_tells_it(self):
        _, job = self.handed_off()
        claim_line = self.server.claim_line
        # Its recheck fails inside the line, after the tick's own check passed.
        with patch.object(self.server, 'claim_line', side_effect=lambda key, text, recheck, **kw: claim_line(
                key, text, lambda: False, **kw)) as claim:
            self.server._schedules_due()
            self.settled()
        claim.assert_called_once()
        self.assertFalse(self.told(job))
        with patch.object(self.server, 'claim_line', wraps=claim_line) as claim:
            self.server._schedules_due()
            self.settled()
        claim.assert_called_once()
        self.assertTrue(self.told(job))

    def test_a_cancelled_job_is_not_told(self):
        _, job = self.handed_off()
        for state in ('cancelled', 'interrupted'):
            with self.server.memory.lock:
                self.db.execute('UPDATE personal_jobs SET state=? WHERE job_id=?', (state, job['job_id'])); self.db.commit()
            with patch.object(self.server, 'claim_line', return_value=True) as claim:
                self.server._schedules_due()
            claim.assert_not_called()

    def test_a_job_she_did_not_hand_off_is_not_told(self):
        _, job = self.handed_off()
        with self.server.memory.lock:
            self.db.execute("UPDATE personal_jobs SET payload=json_remove(payload,'$.source_run_id') WHERE job_id=?",
                            (job['job_id'],)); self.db.commit()
        with patch.object(self.server, 'claim_line', return_value=True) as claim:
            self.server._schedules_due()
        claim.assert_not_called()

    def test_a_scheduled_job_keeps_its_schedule_report_only(self):
        _, job = self.handed_off()
        item = self.server.schedules_store().add('日报', '总结', {'kind': 'daily', 'at': '18:30', 'weekdays': list(range(1, 8))},
                                                 enabled=True)
        with patch.object(self.server, 'clock', return_value=item['next_run_at']):
            store = self.server.schedules_store()
            [run] = store.due()
            store.submitted(run, job['job_id'])
        with patch.object(self.server, 'claim_line', return_value=True) as claim:
            self.server._schedules_due(); self.server._schedules_due()
        self.assertEqual([call.args[0] for call in claim.call_args_list], ['schedule-report-' + run['run_id']])

    def test_a_scheduled_run_tells_the_model_the_local_date_and_weekday(self):
        from datetime import datetime, timedelta, timezone
        prompts = []
        def work(session, prompt, options):
            prompts.append(prompt)
            yield {'type': 'result', 'success': True, 'final_text': '今天星期六。', 'usage': {}}
        self.script = work
        item = self.server.schedules_store().add('星期', '今天是星期几', {'kind': 'daily', 'at': '18:30', 'weekdays': list(range(1, 8))})
        moment = datetime(2026, 11, 21, 10, 5, tzinfo=timezone(timedelta(hours=8)))
        clock = SimpleNamespace(now=lambda: SimpleNamespace(astimezone=lambda: moment))
        with patch('character_agent.integration.datetime', clock, create=True):
            self.assertEqual(self.request('POST', f"/schedules/{item['schedule_id']}/run")[0], 202)
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                jobs = self.controller.jobs.store.list(private=True)
                if jobs and jobs[0]['state'] not in ('queued', 'running'): break
                time.sleep(.01)
        [prompt] = [p for p in prompts if 'background_assignment' in p]
        self.assertIn('"local_time": "2026-11-21 10:05 Saturday (UTC+08:00)"', prompt)

    def test_a_report_that_links_its_file_is_voiced_with_the_file_name(self):
        _, job = self.handed_off()
        reply = '[intent:acknowledge]喏，[summary.md](../outputs/run-2a1aeea60f65bc61515ba440/summary.md) 已生成：217箱，共2604公斤。内容还待你确认。'

        def report(session, prompt, options):
            fields = {'item_id': 'answer', 'kind': 'assistant_text', 'phase': 'final'}
            yield {'type': 'item', **fields, 'status': 'started'}
            for i in range(0, len(reply), 6):
                yield {'type': 'text_delta', **fields, 'status': 'delta', 'text': reply[i:i + 6]}
            yield {'type': 'item', **fields, 'status': 'completed'}
            yield {'type': 'result', 'success': True, 'final_text': reply, 'usage': {}}
        self.script = report
        self.server.speech = test_server.FakeRelay()
        self.server._schedules_due()
        self.settled()
        spoken = [text for kind, line, text in self.server.speech.calls if kind == 'speak' and line == 'job-report-' + job['job_id']]
        self.assertEqual(''.join(spoken), '喏，summary.md 已生成：217箱，共2604公斤。内容还待你确认。')

    def report_while(self, close):
        """A finished job's tick with the gate closed by close(): (its job, the TTS calls of its line, the /feed
        kinds and data published from the handoff on)."""
        published = []
        publish = self.server.feed.publish
        self.server.feed.publish = lambda kind, data: published.append((kind, data)) or publish(kind, data)
        _, job = self.handed_off()
        self.server.speech = test_server.FakeRelay()
        close()
        self.server._schedules_due()
        self.settled()
        spoken = [call for call in self.server.speech.calls if call[0] == 'speak' and call[1] == 'job-report-' + job['job_id']]
        return job, spoken, published

    def assert_shown_not_said(self, close):
        job, spoken, published = self.report_while(close)
        self.assertEqual(spoken, [])
        self.assertFalse([data for kind, data in published if kind == 'line' and data['line_id'] == 'job-report-' + job['job_id']])
        self.assertTrue([data for kind, data in published if kind == 'delivery' and data['run_id'] == job['run_id']])
        self.assertFalse(self.told(job))

    def test_a_finished_job_is_shown_not_said_with_proactive_speech_off(self):
        self.assert_shown_not_said(lambda: setattr(self.server.gate, 'enabled', False))

    def test_a_finished_job_is_shown_not_said_in_quiet_hours(self):
        self.assert_shown_not_said(lambda: self.server.gate.set_quiet(True, [[0, 12], [12, 0]]))

    def test_a_finished_job_is_said_past_the_proactive_budget(self):
        def spent():
            for _ in range(self.server.gate.daily_limit):
                self.server.gate.commit('comment')
            self.assertEqual(self.server.gate.check('comment'), 'daily_limit')
        job, spoken, _ = self.report_while(spent)
        self.assertTrue(spoken)
        self.assertTrue(self.told(job))


class RuntimeAutoSelectTests(test_server.FeedServerCase):
    def setUp(self):
        super().setUp()
        self.root = Path(self.tmp.name) / 'personal'; self.root.mkdir()
        self.db = open_store(self.root / 'domain.sqlite')
        s = self.server
        domain_lock = threading.RLock()
        s.history, s.memory, s.tasks = History(self.db, lock=domain_lock, character_id=s.character), Memory(self.db, lock=domain_lock), TaskLedger(self.db, lock=domain_lock)
        s.egress = EgressPolicy()
        s.mouth = Mouth(egress=s.egress)
        self.rows = []
        self.controller = s.character_agent = CharacterAgentController(s, self.root)
        self.controller.discovery = SimpleNamespace(scan=lambda refresh=False: {'runtimes': self.rows, 'scanned_at': 0})
        # Bundled pi is absent unless a test installs it: the checkout's own .local runtime must not decide.
        self.pi_node, self.pi_runtime = self.root / 'node', self.root / 'pi-runtime'
        pi = patch('character_agent.harness.pi_config.resolve_pi_runtime', return_value=(str(self.pi_node), str(self.pi_runtime)))
        pi.start(); self.addCleanup(pi.stop)

    def tearDown(self):
        super().tearDown()
        self.controller.store.close(); self.controller.workspace.close(); self.db.close()

    def install_pi(self):
        package = self.pi_runtime / 'node_modules/@earendil-works/pi-coding-agent/package.json'
        package.parent.mkdir(parents=True); package.write_text('{}', encoding='utf-8'); self.pi_node.write_text('', encoding='utf-8')

    @staticmethod
    def found(backend, source, authenticated):
        return {'backend': backend, 'runtime_source': source, 'path': '/synthetic/' + source + '/' + backend,
                'version': 'test', 'entry_supported': True, 'boundary_verified': True,
                'authenticated': authenticated}

    def test_unsaved_settings_choose_logged_in_local_codex_without_writing_configuration(self):
        self.rows = [self.found('codex', 'local_cli', True)]
        status = self.controller.public()
        self.assertTrue(status['ready'], status['error'])
        self.assertEqual((status['backend'], status['runtime_source'], status['executable'], status['auth_source']),
                         ('codex', 'local', None, 'existing_login'))
        self.assertIs(status['auto_selected'], True)
        self.controller.forget()
        self.assertFalse((self.root / 'character-runtime.json').exists())

    def test_only_local_codex_is_chosen_for_runtime_and_jobs(self):
        self.rows = [self.found('codex', 'local_cli', True)]
        self.assertEqual(self.controller._ensure_runtime().backend, 'codex')
        self.controller.settings.apply_default({}); self.controller._auto_chosen = False
        with patch.object(self.controller.jobs, 'start'):
            job = self.controller.submit_job('t', '整理', '整理资料')
        self.assertEqual(self.controller.jobs.store.get(job['job_id'], private=True)['payload']['config']['backend'],
                         'codex')
        self.controller.settings.apply_default({}); self.controller._auto_chosen = False
        status = self.controller.public()
        self.assertTrue(status['ready'], status['error'])
        self.assertEqual((status['backend'], status['runtime_source']), ('codex', 'local'))

    def test_turn_paths_skip_discovery_after_the_first_choice(self):
        self.rows = [self.found('codex', 'local_cli', True)]
        self.controller._ensure_runtime()
        scans = []
        self.controller.discovery = SimpleNamespace(scan=lambda refresh=False: scans.append(refresh) or
                                                    {'runtimes': self.rows, 'scanned_at': 0})
        self.controller._auto_select()
        self.assertEqual(scans, [])
        self.controller.public()
        self.assertTrue(scans)

    def test_verified_local_cli_without_login_reports_its_own_login(self):
        self.controller.settings.save({'backend': 'codex', 'runtime_source': 'local'})
        self.rows = [self.found('codex', 'local_cli', False)]
        status = self.controller.public()
        self.assertEqual((status['backend'], status['runtime_source'], status['error']),
                         ('codex', 'local', 'native_login_required'))

    def test_post_job_without_login_is_503_native_login_required(self):
        self.controller.settings.save({'backend': 'codex', 'runtime_source': 'local'})
        self.rows = [self.found('codex', 'local_cli', False)]
        with patch.object(self.controller.jobs, 'start'):
            status, body = test_server.SayTest.request(self, 'POST', '/agent/jobs', {'title': '整理', 'text': '整理资料'})
        self.assertEqual((status, body), (503, {'error': 'native_login_required', 'runtime': 'codex'}))
        self.assertEqual(self.controller.jobs.store.list(), [])

    def test_claude_code_readiness_follows_its_discovered_cli_and_login(self):
        self.controller.settings.save({'backend': 'claude', 'runtime_source': 'local'})
        for rows, error in (([], 'runtime_missing'), ([self.found('codex', 'local_cli', True)], 'runtime_missing'),
                            ([self.found('claude', 'local_cli', False)], 'native_login_required'),
                            ([self.found('claude', 'local_cli', True)], None)):
            with self.subTest(rows=rows):
                self.rows = rows
                status = self.controller.public()
                self.assertEqual((status['backend'], status['error'], status['ready']), ('claude', error, error is None))
        self.rows = [{**self.found('claude', 'local_cli', False), 'path': '/opt/x y/claude'}]
        self.assertEqual([r['login_command'] for r in self.controller.installed_runtimes()], ["'/opt/x y/claude' auth login"])
        with patch.object(self.controller, '_selected_runtime', return_value=None):
            self.assertEqual(self.controller.public()['error'], 'local_runtime_missing')

    def test_installed_runtime_rows_name_their_login_command(self):
        codex = {**self.found('codex', 'local_cli', False), 'path': '/opt/x y/codex'}
        self.rows = [codex, {**self.found('codex', 'local_cli', True), 'path': None}]
        rows = self.controller.installed_runtimes()
        self.assertEqual([r['login_command'] for r in rows], ["'/opt/x y/codex' login", None])

    def test_auto_select_keeps_bundled_pi_over_logged_in_codex(self):
        self.install_pi()
        self.rows = [self.found('codex', 'local_cli', True)]
        # 「pi 账号与凭据」 gives pi a connection.
        self.controller._pi_route = lambda config: ({'provider': 'fixture', 'auth_source': 'api_key'}, 'fixture-key', 'fixture')
        status = self.controller.public()
        self.assertEqual((status['backend'], status['runtime_source'], status['auto_selected']), ('pi', 'bundled', True))

    def test_auto_select_takes_logged_in_codex_when_pi_has_no_connection(self):
        self.install_pi()
        self.rows = [self.found('codex', 'local_cli', True)]
        status = self.controller.public()
        self.assertEqual((status['backend'], status['runtime_source'], status['auto_selected']), ('codex', 'local', True))

    def test_without_usable_runtime_defaults_and_error_stay_unchanged(self):
        self.rows = [self.found('codex', 'local_cli', False)]
        status = self.controller.public()
        self.assertEqual((status['backend'], status['runtime_source'], status['error']),
                         ('pi', 'bundled', 'runtime_missing'))

    def test_saved_or_unreadable_configuration_is_never_replaced(self):
        self.rows = [self.found('codex', 'local_cli', True)]
        saved = self.controller.settings.save({'backend': 'codex', 'runtime_source': 'local', 'auth_source': 'api_key'})
        status = self.controller.public()
        # The reply's routes add readiness to the saved ones.
        self.assertEqual({k: status[k] for k in saved if k != 'routes'}, {k: v for k, v in saved.items() if k != 'routes'})
        self.assertIs(status['auto_selected'], False)
        (self.root / 'character-runtime.json').write_text('{broken', encoding='utf-8')
        self.controller.settings = RuntimeSettings(self.root)
        status = self.controller.public()
        self.assertEqual((status['backend'], status['runtime_source'], status['auto_selected']),
                         ('pi', 'bundled', False))
