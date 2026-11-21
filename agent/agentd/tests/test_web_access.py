"""Web access setting: kept and validated, but no remaining kernel implements it."""
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_agent.services.capabilities import describe
from character_agent.services.settings import RuntimeSettings
from support import enable_plugins


class WebSettingsTests(unittest.TestCase):
    def test_default_validation_and_persistence(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = RuntimeSettings(directory)
            self.assertEqual(settings.snapshot()['web_access'], 'off')
            for mode in ('off', 'search', 'search_and_fetch'):
                settings.save({'web_access': mode})
                self.assertEqual(RuntimeSettings(directory).snapshot()['web_access'], mode)
            for mode in (None, True, 1, [], {}, 'on', 'fetch'):
                with self.subTest(mode=mode), self.assertRaisesRegex(ValueError, 'invalid_web_access'):
                    settings.save({'web_access': mode})

    def test_codex_and_pi_report_unsupported_without_enabling_web(self):
        for values in ({'backend': 'codex', 'runtime_source': 'local'}, {'backend': 'pi'}):
            for mode in ('off', 'search', 'search_and_fetch'):
                with self.subTest(values=values, mode=mode):
                    config = RuntimeSettings.validate({**values, 'web_access': mode})
                    feature = describe(config)['features']['web_access']
                    self.assertFalse(feature['implemented'])
                    self.assertFalse(feature['enabled'])
                    self.assertEqual(feature['mode'], mode)
                    self.assertEqual(feature['reason'], 'unsupported_by_runtime')

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_controller_passes_web_setting_to_no_kernel(self):
        from character_agent.integration import CharacterAgentController
        enable_plugins(self, 'harness_bridge')  # the codex backend
        with tempfile.TemporaryDirectory() as directory:
            controller = SimpleNamespace(server=SimpleNamespace(models=None), session_factory_override=None, state_dir=Path(directory), python=sys.executable, harness_sites={},
                settings=SimpleNamespace(workspace=lambda: Path(directory)), _harness_permission=None,
                _model=lambda config: 'fixture', _selected_runtime=lambda config: {'entry_supported': True, 'path': '/fixture'},
                _pi_connection=lambda config: {'provider': 'fixture', 'auth_source': 'none', 'base_url': 'http://127.0.0.1:1/v1'},
                _pi_ready=lambda event: None)
            for values in ({'backend': 'codex', 'runtime_source': 'local'}, {'backend': 'pi'}):
                config = RuntimeSettings.validate({**values, 'web_access': 'search_and_fetch'})
                session = CharacterAgentController._session_factory(controller, [], config)
                self.assertIsNone(getattr(session.config, 'web_access', None))
                self.assertNotIn('web_access', session.config.wire())


if __name__ == '__main__': unittest.main()
