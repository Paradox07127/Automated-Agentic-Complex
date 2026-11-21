"""Model dispatch uses the existing confirmation card, never a direct session start."""
from pathlib import Path
import sys
import threading
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from character_agent.services.orchestration import OrchestrationTurn
from sessions.tasks import TaskLedger
from brain.egress import EgressPolicy
from brain.provider import Mouth
from character_agent.integration import CharacterAgentController
from daemon.agentd_server import AgentdServer
from infra.store import open_store
from personal.history import History
from support import enable_plugins
from personal.memory import Memory
from test_character_agent_runtime import FakeSession
from test_character_agent_runtime import chat
from test_dispatch import FakeSessions
from tool_gateway.registry import BUILTIN, REGISTRY


class DispatchToolTests(unittest.TestCase):
    def setUp(self):
        enable_plugins(self, "personal_agent")
        self.tmp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.db = open_store(self.root / 'domain.sqlite')
        self.addCleanup(self.db.close)
        with patch('socketserver.TCPServer.server_bind'), patch('socketserver.TCPServer.server_activate'):
            self.server = AgentdServer(('127.0.0.1', 48810), 'hook', 'ui')
        self.addCleanup(self.server.server_close)
        self.server.history, self.server.memory, self.server.tasks = History(self.db), Memory(self.db), TaskLedger(self.db)
        self.server.egress = EgressPolicy()
        self.server.mouth = Mouth(egress=self.server.egress)
        self.script = chat; self.sessions = []; self.definitions = []
        self.controller = self.server.character_agent = CharacterAgentController(self.server, self.root, session_factory=self.factory)
        self.addCleanup(self.controller.workspace.close)
        self.addCleanup(self.controller.store.close)
        self.addCleanup(self.controller.close)
        self.controller.discovery = SimpleNamespace(scan=lambda refresh=False: {'runtimes': [], 'scanned_at': 0})
        self.controller.configure({'backend': 'pi', 'runtime_source': 'bundled'})
        self.server.dispatcher.tasks = self.server.tasks
        self.workers = FakeSessions()
        self.server.dispatcher.sessions = self.workers
        self.addCleanup(self.server.broker.cancel_all)
        self.project = self.root / 'Endfield'
        self.project.mkdir()

    def factory(self, definitions):
        self.definitions.append(definitions)
        session = FakeSession(lambda *args: self.script(*args)); self.sessions.append(session)
        return session

    def settled(self):
        deadline = time.monotonic() + 5
        while self.server._live_lines and time.monotonic() < deadline:
            time.sleep(0.005)
        self.assertFalse(self.server._live_lines)

    def line(self, text='你好', no_memory=False):
        status, body = self.server.say(text, remember=not no_memory)
        self.assertEqual(status, 202, body)
        self.settled()
        final = [e['data'] for e in self.server.feed.since(0) if e['event'] == 'line' and e['data']['final']][-1]
        self.assertFalse(final.get('error'), final)
        return body, final

    def invoke(self, args, name='dispatch_session', text='修一下这个项目的断线问题'):
        def script(session, prompt, options):
            yield from session.use(options, name, args)
            yield from chat(session, prompt, options)
        self.script = script
        body, _ = self.line(text)
        return self.sessions[-1].responses[-1][2], body

    def dispatch(self, **args):
        return self.invoke({'backend': 'codex', 'prompt': '修复断线，运行测试并汇报结果', **args})[0]

    def known(self, paths, focus=None):
        snapshot = {'sessions': [{'cwd': str(p), 'display_session': 'codex:' + str(i), 'effective_state': 'idle'}
                                 for i, p in enumerate(paths)],
                    'focus': {'display_session': focus, 'state': 'idle'}, 'outcomes': []}
        patcher = patch.object(self.server.registry, 'snapshot', return_value=snapshot)
        patcher.start(); self.addCleanup(patcher.stop)

    def test_scripted_dispatch_only_proposes_and_persists_agent_provenance(self):
        utterance = '修一下断线问题。' * 100
        value, body = self.invoke({'backend': 'codex', 'cwd': str(self.project), 'prompt': '修复并运行测试',
                                   'title': '修 HostLink 断线'}, text=utterance)
        self.assertNotIn('error', value, value)
        self.assertEqual(value, {'task_id': value['request_id'], 'request_id': value['request_id'],
            'state': 'awaiting_confirmation', 'target': 'codex', 'cwd': str(self.project),
            'cwd_from': {'source': 'agent', 'project': None, 'matched': 'cwd'}, 'expires_in_s': 600})
        [card] = self.server.broker.pending()
        self.assertEqual(card['dispatch']['source'], 'agent')
        self.assertEqual(card['dispatch']['utterance'], utterance[:500])
        self.assertEqual(card['dispatch']['title'], '修 HostLink 断线')
        owner = {'run_id': body['run_id'], 'conversation_id': self.server.history.conversations.active}
        self.assertEqual(card['dispatch']['requested_by'], owner)
        [task] = self.server.tasks.list()
        self.assertEqual(task['requested_by'], {'kind': 'agent', **owner, 'character_id': self.server.character})
        self.assertEqual(task['title'], '修 HostLink 断线')
        self.assertEqual(self.workers.created, [])
        self.server.broker.decide(card['request_id'], card['generation'], 'allow')
        self.assertTrue(self.workers.done.wait(2))
        self.assertEqual(len(self.workers.created), 1)

    def test_invalid_cwds_and_secret_symlinks_are_rejected(self):
        secret = self.root / '.ssh'; secret.mkdir()
        link = self.root / 'safe-link'; link.symlink_to(secret, target_is_directory=True)
        regular = self.root / 'plain.txt'; regular.write_text('x', encoding='utf-8')
        for cwd in ('relative/path', '/', str(Path.home()), str(secret), str(link), str(regular), str(self.root / 'missing')):
            with self.subTest(cwd=cwd):
                self.assertEqual(self.dispatch(cwd=cwd).get('error', {}).get('code'), 'invalid_cwd')
        self.assertEqual(self.server.broker.pending(), [])

    def test_project_is_case_insensitive_and_deduplicates_known_directories(self):
        self.known([self.project, self.project])
        value = self.dispatch(project='endFIELD')
        self.assertNotIn('error', value, value)
        self.assertEqual(value['cwd'], str(self.project))
        self.assertEqual(value['cwd_from'], {'source': 'agent', 'project': 'endFIELD', 'matched': 'project'})

    def test_project_uses_persisted_own_sessions_and_tasks(self):
        own = self.root / 'OwnProject'; own.mkdir()
        self.db.execute("INSERT INTO own_sessions (session_id,target,cwd,title,state,started_at,updated_at) "
                        "VALUES ('own:known','codex',?,'known','awaiting_input',1,1)", (str(own),))
        self.server.tasks.create('known-task', 'codex', str(self.project), 'known', 'read_only')
        for project, path in (('ownproject', own), ('Endfield', self.project)):
            with self.subTest(project=project):
                value = self.dispatch(project=project)
                self.assertNotIn('error', value, value)
                self.assertEqual(value['cwd'], str(path))
                [card] = self.server.broker.pending()
                self.server.broker.decide(card['request_id'], card['generation'], 'deny')

    def test_ambiguous_project_returns_paths_without_using_focus(self):
        other = self.root / 'other' / 'Endfield'; other.mkdir(parents=True)
        self.known([self.project, other], 'codex:0')
        error = self.dispatch(project='Endfield').get('error', {})
        self.assertEqual(error.get('code'), 'ambiguous_project')
        self.assertEqual(set(error['candidates']), {str(self.project), str(other)})
        self.assertEqual(self.server.broker.pending(), [])

    def test_without_a_match_or_focus_the_session_goes_to_the_workspace(self):
        other = self.root / 'Project0'; other.mkdir()
        self.known([other])
        home = self.root / 'home'; home.mkdir()
        with patch.object(Path, 'home', return_value=home):
            for project in ('unknown', None):
                with self.subTest(project=project):
                    value = self.dispatch(**({'project': project} if project else {}))
                    self.assertNotIn('error', value, value)
                    self.assertEqual(value['cwd'], str((home / 'AgenticComplex').resolve()))
                    self.assertEqual(value['cwd_from'], {'source': 'agent', 'project': project, 'matched': 'workspace'})
                    [card] = self.server.broker.pending()
                    self.server.broker.decide(card['request_id'], card['generation'], 'deny')
        chosen = self.root / 'chosen'
        self.controller.configure({**self.controller.settings.snapshot(), 'workspace_dir': str(chosen)})
        self.assertEqual(self.dispatch()['cwd'], str(chosen.resolve()))

    def test_unknown_project_falls_back_to_focus(self):
        self.known([self.project], 'codex:0')
        value = self.dispatch(project='unknown')
        self.assertNotIn('error', value, value)
        self.assertEqual(value['cwd_from'], {'source': 'agent', 'project': 'unknown', 'matched': 'focus'})
        self.assertEqual(value['cwd'], str(self.project))

    def test_one_pending_agent_card_per_conversation(self):
        self.assertEqual(self.dispatch(cwd=str(self.project)).get('state'), 'awaiting_confirmation')
        self.assertEqual(self.dispatch(cwd=str(self.project)).get('error', {}).get('code'), 'too_many_pending')
        [card] = self.server.broker.pending()
        self.assertEqual(card['dispatch']['title'], '修复断线，运行测试并汇报结果')
        self.server.broker.decide(card['request_id'], card['generation'], 'deny')
        self.assertEqual(self.dispatch(cwd=str(self.project)).get('state'), 'awaiting_confirmation')

    def test_global_limit_counts_text_dispatch_but_not_tool_cards(self):
        self.server.broker.open('claude', 'external', 'Bash')
        for i in range(3):
            self.server.dispatcher.propose('codex', str(self.project), 'legacy ' + str(i))
        self.assertEqual(self.dispatch(cwd=str(self.project)).get('error', {}).get('code'), 'too_many_pending')

    def test_concurrent_calls_cannot_exceed_conversation_limit(self):
        turn = OrchestrationTurn(self.controller, '修复', {}, self.server.character, None, 'parallel')
        turn.open(lambda: True)
        barrier = threading.Barrier(3)
        replies = []
        def call():
            barrier.wait()
            replies.append(turn.call('dispatch_session', {'backend': 'codex', 'cwd': str(self.project), 'prompt': '修复'}))
        threads = [threading.Thread(target=call) for _ in range(2)]
        for thread in threads: thread.start()
        barrier.wait()
        for thread in threads: thread.join(2)
        self.assertEqual(sum(r.get('state') == 'awaiting_confirmation' for r in replies), 1, replies)
        self.assertEqual(sum(r.get('error', {}).get('code') == 'too_many_pending' for r in replies), 1, replies)

    def test_status_is_bounded_read_only_and_can_find_an_older_task(self):
        value = self.dispatch(cwd=str(self.project))
        self.assertIn('task_id', value, value)
        task_id = value['task_id']
        before = self.server.broker.pending()
        status, _ = self.invoke({'task_id': task_id}, 'dispatch_status')
        self.assertEqual(status['tasks'][0]['task_id'], task_id)
        self.assertEqual(status['tasks'][0]['state'], 'proposed')
        self.assertEqual([r['request_id'] for r in before], [r['request_id'] for r in self.server.broker.pending()])
        status, _ = self.invoke({'limit': 1}, 'dispatch_status')
        self.assertEqual(len(status['tasks']), 1)
        for args in ({'limit': 6}, {'task_id': 'x' * 65}):
            status, _ = self.invoke(args, 'dispatch_status')
            self.assertEqual(status['error']['code'], 'invalid_arguments')

    def test_registry_restricts_both_tools_to_foreground_actions(self):
        for name, effect, grant in (('dispatch_session', 'external_write', 'card'), ('dispatch_status', 'read', 'none')):
            with self.subTest(name=name):
                self.assertIn(name, BUILTIN)
                spec = BUILTIN[name]
                self.assertEqual((spec.family, spec.effect, spec.grant, spec.receipt), ('orchestration', effect, grant, False))
                self.assertEqual(spec.callers, frozenset(('character',)))
                self.assertEqual(spec.modes, frozenset(('actions',)))
                self.assertEqual(REGISTRY.offer('background', OrchestrationTurn.tool_definitions()).refusal(name)['error']['code'],
                                 'tool_not_allowed_in_mode')

    def test_side_and_temporary_turns_do_not_offer_dispatch_and_a_proactive_turn_cannot_dispatch(self):
        self.line()
        self.assertIn('dispatch_session', {d['name'] for d in self.definitions[-1]})
        with patch.object(self.controller, 'busy', return_value=True):
            self.line('顺便聊一句')
        self.assertFalse({'dispatch_session', 'dispatch_status'} & {d['name'] for d in self.definitions[-1]})
        self.line('临时聊一句', no_memory=True)
        self.assertFalse({'dispatch_session', 'dispatch_status'} & {d['name'] for d in self.definitions[-1]})
        # A proactive line offers the typing turn's tools, and its mode refuses the dispatch.
        def script(session, prompt, options):
            yield from session.use(options, 'dispatch_session', {'backend': 'codex', 'prompt': '修复断线'})
            yield from chat(session, prompt, options)
        self.script = script
        self.server.start_line('dispatch-proactive', '轻声问候', source='proactive')
        self.settled()
        self.assertEqual(self.sessions[-1].responses[-1][2]['error']['code'], 'tool_not_allowed_in_mode')
        self.assertEqual(self.server.broker.pending(), [])

    def test_regex_no_cwd_hands_original_sentence_and_target_to_ready_character(self):
        body, _ = self.line('让 codex 修 Endfield 的断线问题')
        self.assertIn('run_id', body)
        call = self.sessions[-1].calls[-1]
        self.assertIn('让 codex 修 Endfield 的断线问题', call['prompt'])
        self.assertIn('The user explicitly wants this sent to codex', call['prompt'])
        self.assertEqual(self.server.broker.pending(), [])
        with patch.object(self.controller, 'public', return_value={'ready': False, 'routes': {'background': {'ready': False}}}):
            self.assertEqual(self.server.say('让 codex 修断线'), (409, {'error': 'no_cwd'}))
        self.assertEqual(self.server.say('让 codex 修断线', verify_cmd='git status --short'),
                         (409, {'error': 'no_cwd'}))
        status, body = self.server.say('让 codex 修断线', cwd=str(self.project))
        self.assertEqual((status, body['command']), (202, 'dispatch'))

    def test_agent_task_context_is_recent_bounded_and_prompt_explains_confirmation(self):
        value = self.dispatch(cwd=str(self.project), title='修断线')
        self.assertIn('task_id', value, value)
        self.db.execute('UPDATE tasks SET created_at=? WHERE task_id=?', (time.time() - 8 * 86400, value['task_id']))
        self.db.commit()
        self.line()
        call = self.sessions[-1].calls[-1]
        self.assertNotIn(value['task_id'], call['prompt'])
        self.assertIn('an explicit ask for Claude Code or Codex: dispatch_session', call['system_prompt'])
        self.db.execute('UPDATE tasks SET created_at=? WHERE task_id=?', (time.time(), value['task_id']))
        self.db.commit()
        self.line()
        call = self.sessions[-1].calls[-1]
        self.assertIn('Tasks you dispatched recently', call['prompt'])
        self.assertIn(value['task_id'], call['prompt'])
        self.assertIn('修断线', call['prompt'])
