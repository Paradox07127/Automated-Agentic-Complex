"""Runtime choice and credential-source tests; never inspect real account state."""
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_agent.services.semantic import PURPOSES, ROUTE as SEMANTIC_ROUTES
from character_agent.services.settings import DEFAULTS, RETENTION, ROUTES, RuntimeSettings
from fsutil import atomic_write_json


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
        self.settings = RuntimeSettings(self.root)

    def tearDown(self): self.tmp.cleanup()

    def models(self, **values):
        config = {'base_url': 'https://api.anthropic.com', **values}
        return SimpleNamespace(snapshot=lambda: {'provider': 'compatible', 'vision': {'provider': 'openai'},
                                                'backends': {'anthropic': config}})

    def test_new_install_defaults_to_bundled_pi_without_writing_configuration(self):
        self.assertEqual(self.settings.snapshot(), DEFAULTS)
        self.assertEqual((self.settings.snapshot()['backend'], self.settings.snapshot()['runtime_source']), ('pi', 'bundled'))
        self.assertFalse(self.settings.path.exists())

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_supported_backend_choice_persists_without_persona_or_memory(self):
        for values in ({'backend': 'pi'}, {'backend': 'codex', 'runtime_source': 'local'}):
            saved = self.settings.save({**values, 'model': 'some-model'})
            self.assertEqual(RuntimeSettings(self.root).snapshot(), saved)
        self.assertEqual(self.settings.path.stat().st_mode & 0o777, 0o600)
        self.assertFalse(any(key in self.settings.snapshot() for key in ('persona', 'memory', 'api_key')))

    def test_saving_a_retired_kernel_is_rejected(self):
        for values, code in (({'backend': 'claude_agent_sdk'}, 'invalid_runtime_backend'),
                             ({'backend': 'codex', 'runtime_source': 'bundled'}, 'invalid_runtime_source'),
                             ({'backend': 'codex'}, 'invalid_runtime_source')):
            with self.subTest(values=values), self.assertRaisesRegex(ValueError, code):
                self.settings.save(values)
        self.assertFalse(self.settings.path.exists())

    def test_claude_code_is_a_local_kernel_on_its_own_login(self):
        saved = self.settings.save({'backend': 'claude', 'runtime_source': 'local', 'executable': '/usr/local/bin/claude'})
        self.assertEqual(RuntimeSettings(self.root).snapshot(), saved)
        self.assertEqual(self.settings.save({**saved, 'provider': 'anthropic'})['provider'], 'anthropic')
        for values, code in (({'backend': 'claude'}, 'invalid_runtime_source'),
                             ({'backend': 'claude', 'runtime_source': 'local', 'auth_source': 'api_key'}, 'unsupported_auth_source'),
                             ({'backend': 'claude', 'runtime_source': 'local', 'provider': 'openai'},
                              'provider_not_supported_by_harness')):
            with self.subTest(values=values), self.assertRaisesRegex(ValueError, code):
                self.settings.save(values)

    def test_invalid_models_budgets_types_paths_and_unknown_fields_rejected(self):
        invalid = [{'backend': 'made-up'}, {'backend': 'codex', 'runtime_source': 'local', 'provider': 'anthropic'},
                   {'runtime_source': 'remote'}, {'executable': 'relative-cli'},
                   {'model': 'model\n--extra'}, {'model': 42}, {'scope_id': ''}, {'scope_id': []},
                   {'max_budget_usd': True}, {'max_budget_usd': float('nan')}, {'max_budget_usd': float('inf')},
                   {'max_budget_usd': 21}, {'api_key': 'must-not-be-stored-here'},
                   {'workspace_dir': 'relative/dir'}, {'workspace_dir': ''}, {'workspace_dir': 42}]
        before = self.settings.snapshot()
        for values in invalid:
            with self.subTest(values=values), self.assertRaises(ValueError): self.settings.save(values)
        self.assertEqual(self.settings.snapshot(), before)

    def test_history_retention_defaults_to_keep_and_takes_only_7d_or_30d(self):
        self.assertEqual(self.settings.snapshot()['history_retention'], 'keep')
        self.assertEqual(RETENTION, {'keep': None, '7d': 7 * 86400, '30d': 30 * 86400})
        for value in ('7d', '30d', 'keep'):
            saved = self.settings.save({'history_retention': value})
            self.assertEqual(RuntimeSettings(self.root).snapshot()['history_retention'], value)
            self.assertEqual(saved['history_retention'], value)
        for value in ('1d', 7, None, ''):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'invalid_history_retention'):
                RuntimeSettings.validate({'history_retention': value})

    def test_retired_scene_keys_are_refused(self):
        for key in ('front_model', 'chat_effort', 'back_model', 'back_effort'):
            self.assertNotIn(key, DEFAULTS)
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'invalid_runtime_settings'):
                self.settings.save({key: None})

    def test_limit_and_acp_permission_keys_are_refused(self):
        for key, value in {'max_turns': 24, 'timeout_seconds': 300, 'acp_permission': 'ask'}.items():
            self.assertNotIn(key, DEFAULTS)
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'invalid_runtime_settings'):
                self.settings.save({key: value})

    def test_workspace_defaults_to_agentic_complex_in_home_and_is_created(self):
        home = self.root / 'home'; home.mkdir()
        with patch.object(Path, 'home', return_value=home):
            self.assertIsNone(self.settings.snapshot()['workspace_dir'])
            self.assertEqual(self.settings.workspace(), home / 'AgenticComplex')
            self.assertTrue((home / 'AgenticComplex').is_dir())
            chosen = self.root / 'chosen' / 'work'
            self.settings.save({'workspace_dir': str(chosen)})
            self.assertEqual(RuntimeSettings(self.root).workspace(), chosen)
            self.assertTrue(chosen.is_dir())

    def test_reply_language_defaults_to_auto_and_takes_only_the_known_settings(self):
        self.assertEqual(self.settings.snapshot()['reply_language'], 'auto')
        for value in ('zh-Hans', 'en', 'ja', 'harness', 'auto'):
            saved = self.settings.save({'reply_language': value})
            self.assertEqual(saved['reply_language'], value)
            self.assertEqual(RuntimeSettings(self.root).snapshot()['reply_language'], value)
        for value in ('fr', 'zh', '', None, 1):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'invalid_reply_language'):
                self.settings.save({'reply_language': value})

    def test_routes_take_known_purposes_kernels_models_and_efforts(self):
        route = {'backend': 'claude', 'acp_agent': None, 'model': 'sonnet', 'effort': 'medium'}
        saved = self.settings.save({'routes': {'chat': route, 'judge': {**route, 'backend': 'acp', 'acp_agent': 'claude-acp'},
                                               'computer': {**route, 'backend': 'codex', 'model': None, 'effort': None}}})
        self.assertEqual(RuntimeSettings(self.root).snapshot(), saved)
        self.assertEqual(json.loads(self.settings.path.read_text(encoding='utf-8'))['routes']['chat'], route)
        for routes, code in (([], 'invalid_routes'), ({'vision': route}, 'invalid_routes'), ({'chat': None}, 'invalid_routes'),
                             ({'chat': {'backend': 'pi'}}, 'invalid_routes'), ({'chat': {**route, 'extra': 1}}, 'invalid_routes'),
                             ({'chat': {**route, 'backend': 'claude_agent_sdk'}}, 'invalid_route_backend'),
                             ({'chat': {**route, 'backend': 'acp'}}, 'invalid_acp_agent'),
                             ({'chat': {**route, 'acp_agent': 'no-such-agent'}}, 'invalid_acp_agent'),
                             ({'chat': {**route, 'model': ''}}, 'invalid_route_model'),
                             ({'chat': {**route, 'model': 'a b'}}, 'invalid_route_model'),
                             ({'chat': {**route, 'model': 42}}, 'invalid_route_model'),
                             ({'chat': {**route, 'effort': 'ultra'}}, 'invalid_route_effort')):
            with self.subTest(routes=routes), self.assertRaisesRegex(ValueError, code):
                self.settings.save({'routes': routes})

    def test_route_applies_its_kernel_model_and_effort_to_the_main_config(self):
        main = RuntimeSettings.validate({'backend': 'pi', 'runtime_source': 'local', 'executable': '/usr/local/bin/node',
                                         'auth_source': 'api_key', 'provider': 'deepseek', 'model': 'deepseek-chat'})
        for purpose in ROUTES:
            with self.subTest(follows=purpose):
                account = {'auth_source': 'existing_login', 'provider': ''} if purpose == 'quick' else {}
                self.assertEqual(RuntimeSettings.route(main, purpose), {**main, **account, '_turn_effort': None})
        codex = RuntimeSettings.validate({'backend': 'codex', 'runtime_source': 'local', 'model': 'gpt-5'})
        self.assertEqual(RuntimeSettings.route(codex, 'chat')['_turn_effort'], 'low')
        self.assertIsNone(RuntimeSettings.route(codex, 'background')['_turn_effort'])
        routes = {'chat': {'backend': 'claude', 'acp_agent': None, 'model': 'sonnet', 'effort': 'high'},
                  'background': {'backend': 'pi', 'acp_agent': None, 'model': None, 'effort': 'inherit'},
                  'judge': {'backend': 'acp', 'acp_agent': 'claude-acp', 'model': None, 'effort': 'low'},
                  'memory': {'backend': 'codex', 'acp_agent': None, 'model': None, 'effort': None}}
        config = {**main, 'routes': routes}
        local = {'runtime_source': 'local', 'executable': None, 'auth_source': 'existing_login', 'provider': ''}
        self.assertEqual(RuntimeSettings.route(config, 'chat'),
                         {**config, **local, 'backend': 'claude', 'model': 'sonnet', '_turn_effort': 'high'})
        self.assertEqual(RuntimeSettings.route(config, 'background'), {**config, '_turn_effort': None})
        self.assertEqual(RuntimeSettings.route(config, 'judge'),
                         {**config, **local, 'backend': 'acp', 'acp_agent': 'claude-acp', 'model': '', '_turn_effort': 'low'})
        self.assertEqual(RuntimeSettings.route(config, 'memory'),
                         {**config, **local, 'backend': 'codex', 'model': '', '_turn_effort': None})
        self.assertEqual(RuntimeSettings.route(config, 'understand'), {**config, '_turn_effort': None})
        on_codex = {**codex, 'routes': {'chat': {'backend': 'pi', 'acp_agent': None, 'model': 'gpt-5.5', 'effort': None}}}
        self.assertEqual(RuntimeSettings.route(on_codex, 'chat'),
                         {**on_codex, 'backend': 'pi', 'runtime_source': 'bundled', 'model': 'gpt-5.5', '_turn_effort': None})
        on_acp = RuntimeSettings.validate({'backend': 'acp', 'runtime_source': 'local', 'acp_agent': 'claude-acp',
                                           'acp_launcher': 'npx', 'routes': {
            'chat': {'backend': 'acp', 'acp_agent': 'claude-acp', 'model': 'opus', 'effort': None},
            'judge': {'backend': 'acp', 'acp_agent': 'opencode', 'model': None, 'effort': None}}})
        self.assertEqual(RuntimeSettings.route(on_acp, 'chat'), {**on_acp, 'model': 'opus', '_turn_effort': None})
        self.assertEqual(RuntimeSettings.route(on_acp, 'judge'),
                         {**on_acp, 'acp_agent': 'opencode', 'acp_launcher': 'local', '_turn_effort': None})
        for purpose in ROUTES:
            RuntimeSettings.validate({k: v for k, v in RuntimeSettings.route(config, purpose).items() if k != '_turn_effort'})

    def test_every_semantic_purpose_runs_on_one_route(self):
        self.assertEqual(set(SEMANTIC_ROUTES), PURPOSES)
        self.assertEqual({route: sorted(p for p, r in SEMANTIC_ROUTES.items() if r == route) for route in set(SEMANTIC_ROUTES.values())}, {
            'judge': ['facing_decide', 'proactive_decide', 'repeat', 'review', 'thought'],
            'understand': ['observation_brief', 'observation_interpret', 'observation_summary', 'observation_vision',
                           'user_vision'],
            'memory': ['memory_extract', 'worklog_deep', 'worklog_fast']})
        self.assertEqual(ROUTES, ('chat', 'quick', 'background', 'judge', 'understand', 'memory', 'computer'))

    def test_corrupt_config_is_diagnosed_without_overwriting_it(self):
        self.settings.path.write_text('{corrupt', encoding='utf-8')
        loaded = RuntimeSettings(self.root)
        self.assertEqual(loaded.error, 'runtime_settings_unreadable')
        self.assertEqual(loaded.snapshot(), DEFAULTS)
        self.assertEqual(self.settings.path.read_text(encoding='utf-8'), '{corrupt')

    def test_runtime_config_symlink_is_not_followed(self):
        other = self.root / 'other.json'; atomic_write_json(other, {'backend': 'codex', 'runtime_source': 'local'})
        self.settings.path.symlink_to(other)
        loaded = RuntimeSettings(self.root)
        self.assertIsNotNone(loaded.error)
        self.assertEqual(loaded.snapshot(), DEFAULTS)

    def test_config_save_clears_previous_parse_error(self):
        self.settings.path.write_text('{broken', encoding='utf-8')
        loaded = RuntimeSettings(self.root)
        loaded.save({'backend': 'pi', 'model': 'test-model'})
        self.assertIsNone(loaded.error)
        self.assertEqual(RuntimeSettings(self.root).snapshot()['model'], 'test-model')

    def test_explicit_api_credential_is_read_without_changing_other_provider_settings(self):
        source = self.models(api_key='synthetic-api-secret')
        before = source.snapshot()
        self.assertEqual(self.settings.credential(source), 'synthetic-api-secret')
        self.assertEqual(source.snapshot(), before)
        self.assertNotIn('synthetic-api-secret', json.dumps(self.settings.snapshot()))

    def test_only_official_endpoint_is_accepted(self):
        for endpoint in ('https://api.anthropic.com.evil.invalid', 'http://api.anthropic.com', 'http://localhost:9999'):
            with self.subTest(endpoint=endpoint), self.assertRaisesRegex(ValueError, 'unsupported_anthropic_endpoint'):
                self.settings.credential(self.models(base_url=endpoint, api_key='synthetic'))

    def test_default_choice_applies_only_in_memory_until_user_saves(self):
        self.assertFalse(self.settings.saved)
        self.settings.apply_default({'backend': 'codex', 'runtime_source': 'local'})
        self.assertEqual(self.settings.snapshot(), {**DEFAULTS, 'backend': 'codex', 'runtime_source': 'local'})
        self.assertFalse(self.settings.path.exists())
        self.settings.apply_default({})
        self.assertEqual(self.settings.snapshot(), DEFAULTS)
        saved = self.settings.save({'backend': 'codex', 'runtime_source': 'local', 'auth_source': 'api_key'})
        self.assertTrue(self.settings.saved)
        self.settings.apply_default({'backend': 'codex', 'runtime_source': 'local', 'auth_source': 'existing_login'})
        self.assertEqual(self.settings.snapshot(), saved)
        self.assertTrue(RuntimeSettings(self.root).saved)

    def test_absent_api_credential_does_not_import_cli_oauth(self):
        fake_cli = self.root / '.claude'; fake_cli.mkdir(); (fake_cli / 'credentials.json').write_text('{"oauth":"synthetic"}', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'missing_anthropic_api_key'): self.settings.credential(self.models())


if __name__ == '__main__': unittest.main()
