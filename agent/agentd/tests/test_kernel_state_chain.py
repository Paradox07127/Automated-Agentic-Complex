"""Real pi, ACP and Claude Code sessions driven by PersonalAgentRuntime: the run events and items the character's state
is built from."""
from dataclasses import replace
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from brain.egress import EgressPolicy
from character_agent.harness.pi_config import PiConfig
from character_agent.harness.pi_transport import ManagedPiSession
from character_agent.harness.registry import HARNESSES
from character_agent.runtime import PersonalAgentRuntime
from character_agent.services.knowledge import KnowledgeService
from character_agent.services.settings import DEFAULTS
from character_agent.services.workspace import WorkspaceService
from infra.store import open_store
from personal.history import History
from personal.memory import Memory
from sessions.tasks import TaskLedger
from test_acp_backend import ACP, AcpHarnessCase
from test_claude_runner import fake_cli
from test_character_agent_pi import HAS_SDK, NODE, RUNTIME, FixtureModel


class Chain:
    """A PersonalAgentRuntime whose sessions come from `self.make_session(definitions)`."""

    def start_runtime(self):
        self.db = open_store(self.root / 'domain.sqlite')
        self.addCleanup(self.db.close)
        memory, history = Memory(self.db), History(self.db)
        self.workspace = WorkspaceService(self.root / 'workspace', egress=EgressPolicy())
        self.addCleanup(self.workspace.close)
        self.events = []
        knowledge = lambda: KnowledgeService(memory=memory, history=history, egress=EgressPolicy(),
                                             permitted=lambda source, row: False)
        self.runtime = PersonalAgentRuntime(self.root / 'runtime', self.make_session, knowledge, self.workspace,
                                            tasks=TaskLedger(self.db), backend=self.backend, model='fixture',
                                            event_sink=self.events.append)
        self.addCleanup(self.runtime.store.close)
        self.addCleanup(self.runtime.close)

    def run_turn(self):
        return self.runtime.run(run_id='run-1', text='Read my notes', system_prompt='Synthetic assistant.', history=[],
                                character_id='one', generation=1)

    def phases(self, kind):
        return [e for e in self.events if e.get('phase') == kind and 'item_id' not in e]

    def items(self):
        return [e for e in self.events if 'item_id' in e and 'item_seq' in e]


class AcpChainTest(Chain, AcpHarnessCase):
    backend = 'acp'

    def make_session(self, definitions):
        store = self.runtime.store
        controller = SimpleNamespace(python=sys.executable, store=store, interactions=None, _acp_logins={},
                                     _harness_permission=lambda request, source, name: None)
        config = {**DEFAULTS, **ACP, "_turn_effort": None}
        common = dict(state_dir=self.root / "runner" / "acp", api_key="", model="", runtime_source="local",
                      workspace_dir=str(self.root), native_tools=True)
        session = HARNESSES["acp"].session(controller, config, common, definitions)
        self.addCleanup(session.close)
        return session

    @unittest.skipIf(sys.platform == "win32", "harness discovery and install look only in POSIX locations")
    def test_text_tools_and_answer_reach_the_run(self):
        self.agent("normal")
        self.start_runtime()
        reply = self.run_turn()
        self.assertIsNone(reply.error)
        self.assertEqual(reply.text, "Hello world")
        self.assertEqual(self.runtime.store.get('run-1')['state'], 'completed')
        # The agent's own command is work the character shows; the bridge's tool is reported once, by the transport.
        native = [e for e in self.phases('tool_started') if e.get('tool') == 'execute']
        self.assertEqual(len(native), 1)
        self.assertEqual([e.get('tool_call_id') for e in self.phases('tool_finished') if e.get('tool') == 'execute'],
                         [native[0]['tool_call_id']])
        self.assertNotIn('call_1', {e['item_id'] for e in self.items()})
        text = [e for e in self.items() if e['kind'] == 'assistant_text']
        self.assertEqual({e['phase'] for e in text}, {'final'})
        self.assertEqual(''.join(e.get('text_delta', '') for e in text), 'Hello world')
        self.assertIn('completed', {e['status'] for e in text})


class ClaudeChainTest(Chain, unittest.TestCase):
    backend = 'claude'

    def setUp(self):
        import tempfile
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.cli, self.log = fake_cli(self.root)

    def make_session(self, definitions):
        self.first_tool = definitions[0]['name']
        controller = SimpleNamespace(python=sys.executable,
                                     _selected_runtime=lambda config: {'path': self.cli, 'entry_supported': True},
                                     _harness_permission=lambda request, source, name: None)
        config = {**DEFAULTS, 'backend': 'claude', 'runtime_source': 'local', '_turn_effort': None}
        common = dict(state_dir=self.root / 'runner' / 'claude', api_key='', model='', runtime_source='local',
                      workspace_dir=str(self.root), native_tools=True)
        session = HARNESSES['claude'].session(controller, config, common, definitions)
        self.addCleanup(session.close)
        return session

    @unittest.skipIf(sys.platform == "win32", "Claude runs under native profile isolation, which has no Windows implementation")
    def test_endfield_tool_and_streamed_answer_reach_the_run(self):
        self.start_runtime()
        reply = self.run_turn()
        self.assertIsNone(reply.error)
        self.assertEqual(reply.text, 'Hello world')
        self.assertEqual(reply.model, 'claude-fake-1')
        self.assertEqual(self.runtime.store.get('run-1')['state'], 'completed')
        # The bridge's call is reported once, by the transport, under the model's tool_use id.
        self.assertEqual([(e['tool'], e['tool_call_id']) for e in self.phases('tool_started')], [(self.first_tool, 'toolu_1')])
        self.assertEqual([(e['tool'], e['tool_call_id']) for e in self.phases('tool_finished')], [(self.first_tool, 'toolu_1')])
        self.assertEqual({e['kind'] for e in self.items() if e['item_id'].startswith('toolu_1')}, {'tool_call', 'tool_result'})
        text = [e for e in self.items() if e['kind'] == 'assistant_text']
        self.assertEqual({e['phase'] for e in text}, {'final'})
        self.assertEqual(''.join(e.get('text_delta', '') for e in text), 'Hello world')
        self.assertIn('completed', {e['status'] for e in text})


@unittest.skipUnless(HAS_SDK, 'Pinned Pi SDK unavailable; run python3 -I agent/agentd/character_agent/harness/pi_install_runtime.py --destination .local/pi-runtime --npm "$(which npm)" first')
class PiChainTest(Chain, unittest.TestCase):
    backend = 'pi'

    def setUp(self):
        import tempfile
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.model = FixtureModel(['finished'])
        self.addCleanup(self.model.close)

    def make_session(self, definitions):
        config = PiConfig(self.root / 'private', 'endfield-fixture', 'fixture', node=NODE, runtime_dir=RUNTIME,
                          auth_source='none', base_url=self.model.url)
        session = ManagedPiSession(replace(config), definitions)
        self.addCleanup(session.close)
        return session

    def test_answer_streams_as_a_final_assistant_item(self):
        self.start_runtime()
        reply = self.run_turn()
        self.assertIsNone(reply.error)
        self.assertEqual(reply.text, 'finished')
        text = [e for e in self.items() if e['kind'] == 'assistant_text']
        self.assertEqual({e['phase'] for e in text}, {'final'})
        self.assertEqual(''.join(e.get('text_delta', '') for e in text), 'finished')
        self.assertIn('completed', {e['status'] for e in text})



class AcpToolKindTest(unittest.TestCase):
    def test_acp_tool_kinds_read_as_the_work_they_do(self):
        from observation.desktop_presence import _role_doing
        cases = {'execute': '执行命令中', 'edit': '编辑文件中', 'delete': '编辑文件中', 'move': '编辑文件中',
                 'read': '读取文件中', 'search': '检索资料中', 'fetch': '检索资料中'}
        self.assertEqual({kind: _role_doing('running_tool', kind, 'zh-Hans') for kind in cases}, cases)


if __name__ == '__main__':
    unittest.main()
