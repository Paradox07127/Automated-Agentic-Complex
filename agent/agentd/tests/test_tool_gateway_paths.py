"""Character tool paths through the policy: every desktop call reports its verdict."""
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_agent.integration import CharacterAgentController  # noqa: E402
from character_agent.services.store import RunStore  # noqa: E402
from tool_gateway.gateway import ToolGateway  # noqa: E402


class CharacterPathsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.store = RunStore(self.root / 'runs.sqlite')
        self.decisions = []
        self.tools = ToolGateway(self.store, report=lambda kind, attrs, key: self.decisions.append((kind, attrs, key)))

    def tearDown(self):
        self.store.close(); self.temp.cleanup()

    def verdicts(self):
        return [(attrs, key) for kind, attrs, key in self.decisions if kind == 'tool.verdict']

    def test_desktop_reports_native_panel(self):
        controller = object.__new__(CharacterAgentController)
        controller.tools = self.tools
        controller._native('desktop_observe', {}, run_id='r1', is_current=lambda: True)
        self.assertEqual(self.verdicts(), [({'tool': 'desktop_observe', 'method': 'native_panel', 'dangerous': False,
                                             'rule': None, 'reason': 'companion_grant'}, 'r1')])


if __name__ == '__main__':
    unittest.main()
