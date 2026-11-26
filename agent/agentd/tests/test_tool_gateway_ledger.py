from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from character_agent.services.store import RunStore  # noqa: E402
from tool_gateway.ledger import EffectLedger, ledger_path  # noqa: E402
import test_character_agent_runtime as runtime_fixtures  # noqa: E402
from test_character_agent_workspace import WorkspaceCase  # noqa: E402


class LedgerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
        self.path = ledger_path(self.root)
        self.store = RunStore(self.path)
        self.ledger = EffectLedger(self.store)

    def tearDown(self):
        self.store.close(); self.tmp.cleanup()

    def test_ledger_path(self):
        self.assertEqual(self.path, self.root / 'character-agent' / 'runs.sqlite')

    def test_replay_returns_committed_receipt(self):
        receipt = {'effect': 'confirmed', 'tool': 'desktop_act'}
        effect = self.ledger.effect('run:1', 'run', 'desktop_act', 'hash')
        self.assertIsNone(effect.replay)
        with effect:
            effect.settle('committed', receipt)
        self.assertEqual(self.ledger.effect('run:1', 'run', 'desktop_act', 'hash').replay, receipt)
        failed = self.ledger.effect('run:2', 'run', 'desktop_act', 'hash')
        with self.assertRaises(RuntimeError), failed:
            raise RuntimeError('handler failed')
        self.assertEqual(self.ledger.effect('run:2', 'run', 'desktop_act', 'hash').replay,
                         {'error': {'code': 'effect_unknown'}})
        self.assertEqual([(e['effect_id'], e['receipt']) for e in self.ledger.unsettled('run')],
                         [('run:2', {'effect': 'unknown'})])

    def test_conflicting_input_raises(self):
        self.ledger.prepare('run:1', 'run', 'desktop_act', 'hash')
        with self.assertRaisesRegex(ValueError, 'effect_conflict'):
            self.ledger.prepare('run:1', 'run', 'desktop_act', 'other')
        with self.assertRaisesRegex(ValueError, 'effect_conflict'):
            self.ledger.prepare('run:1', 'other-run', 'desktop_act', 'hash')

    def test_prepared_becomes_unknown_after_reopen(self):
        self.assertIsNone(self.ledger.prepare('run:1', 'run', 'desktop_act', 'hash'))
        self.assertEqual(self.ledger.effects('run')[0]['state'], 'prepared')
        self.store.close(); self.store = RunStore(self.path)
        self.assertEqual([e['state'] for e in EffectLedger(self.store).unsettled('run')], ['unknown'])

    def test_runstore_has_no_effect_methods(self):
        for name in ('prepare_effect', 'settle_effect', 'effects'):
            with self.subTest(name):
                self.assertFalse(hasattr(RunStore, name))


class ReconcileTest(WorkspaceCase):
    def test_reconcile_reports_artifact_effects(self):
        store = RunStore(self.root / 'runs.sqlite')
        # Closed before tearDown removes self.root: Windows cannot delete an open database.
        try:
            with mock.patch('character_agent.services.workspace.os.link', side_effect=OSError('simulated crash')):
                with self.assertRaises(OSError):
                    self.call('artifact_write', {'path': 'report.md', 'content': '# Report\nDone.'})
            self.assertEqual([e['state'] for e in EffectLedger(store).reconcile('run', self.service)], ['unknown'])
        finally:
            store.close()


class PathsTest(unittest.TestCase):
    def test_desktop_act_goes_through_ledger(self):
        with mock.patch.object(EffectLedger, 'prepare', autospec=True, side_effect=EffectLedger.prepare) as spy:
            f = runtime_fixtures.RuntimeTests(); f.setUp()
            self.addCleanup(f.tearDown)
            f.runtime.native_tools = [{'name': 'desktop_act', 'description': 'fixture', 'input_schema': {'type': 'object'}}]
            f.runtime.native_handler = lambda name, args, **kw: {'effect': 'confirmed'}

            def script(session, prompt, options):
                yield from session.use(options, 'desktop_act', {'snapshot_id': 's', 'action': 'press', 'element_id': 'e'})
                yield {'type': 'result', 'success': True, 'final_text': 'done'}
            f.script = script
            f.run_agent(scope_id=None)
            self.assertEqual([c.args[2:4] for c in spy.call_args_list], [('run-1', 'desktop_act')])
            self.assertEqual(f.runtime.tools.ledger.effects('run-1')[0]['receipt'], {'effect': 'confirmed', 'tool': 'desktop_act'})


if __name__ == '__main__':
    unittest.main()
