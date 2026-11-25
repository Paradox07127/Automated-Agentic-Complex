"""settings_read and settings_update: a few of the user's settings, each change behind a one-time approval card."""
from pathlib import Path
import sys
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from observation.privacy import PAUSE_MAX
from brain.language import ReplyLanguage
from character.proactive import MUTABLE
from character_agent.services.orchestration import OrchestrationTurn
from daemon.agentd_server import AgentdServer
from infra.store import open_store
from personal.memory import Memory
from support import enable_plugins
import test_character_agent_integration as integration

READ = {'companion_mode', 'quiet_enabled', 'quiet_ranges', 'muted', 'mutable_kinds', 'paused_until', 'quiet_until',
        'reply_language', 'reply_languages'}


class SettingsToolTests(unittest.TestCase):
    def setUp(self):
        enable_plugins(self, 'personal_agent')
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = open_store(Path(self.tmp.name) / 'agentd.sqlite')
        self.addCleanup(self.db.close)
        self.now = time.mktime((2026, 11, 4, 12, 0, 0, 0, 0, -1))
        with patch.object(AgentdServer, 'server_bind'), patch.object(AgentdServer, 'server_activate'):
            self.server = AgentdServer(('127.0.0.1', 48811), 'hook', 'ui', events_token='events')
        self.addCleanup(self.server.server_close)
        self.server._stopped.set()
        self.server._ticker.join(2)
        self.server.clock = lambda: self.now
        self.server.memory = Memory(self.db)
        self.server.gate.set_companion(True)
        self.server.gate.set_quiet(False, [[22, 8]])
        self.server.gate.set_muted(['water'])
        self.runtime = {'reply_language': 'auto'}
        self.controller = self.server.character_agent = SimpleNamespace(
            jobs=SimpleNamespace(), server=self.server, close=lambda: None,
            settings=SimpleNamespace(snapshot=lambda: dict(self.runtime)), reply_language=ReplyLanguage(),
            configure=Mock(side_effect=lambda data: self.runtime.update(data)),
            knowledge=lambda: SimpleNamespace(sanitize=lambda value, **kw: value),
            semantic=SimpleNamespace(reply=lambda: 'zh-Hans'))

    def turn(self, decision='allow'):
        """An orchestration turn whose approval card the user answers with decision (allow, deny or expire)."""
        errors = {'deny': 'approval_denied', 'expire': 'approval_expired'}
        self.controller.interactions = SimpleNamespace(approve=Mock(
            side_effect=ValueError(errors[decision]) if decision in errors else None,
            return_value={'request_id': 'card-1', 'input_sha256': 'x'}))
        turn = OrchestrationTurn(self.controller, '把设置改一下', {}, self.server.character, None, 'run-1')
        turn.open(lambda: True)
        return turn

    def card(self):
        args, kwargs = self.controller.interactions.approve.call_args
        self.assertEqual(args[0], 'run-1')
        self.assertTrue(kwargs['single_only'])
        self.assertEqual((args[1]['source'], args[1]['kind']), ('agentd', 'other'))
        return args[1]

    def state(self):
        gate = self.server.gate
        return (gate.companion, gate.quiet_settings, sorted(gate.muted), self.server.paused_until, self.runtime['reply_language'])

    def test_read_returns_only_the_whitelisted_settings(self):
        result = self.turn().call('settings_read', {})
        self.assertEqual(set(result), READ)
        self.assertEqual((result['companion_mode'], result['quiet_enabled'], result['quiet_ranges']), (True, False, [[22, 8]]))
        self.assertEqual(result['muted'], ['water'])
        self.assertEqual(result['mutable_kinds'], list(MUTABLE))
        self.assertEqual((result['paused_until'], result['quiet_until']), (None, None))
        self.assertEqual(result['reply_language'], 'auto')
        self.assertIn('ja', result['reply_languages'])
        self.controller.interactions.approve.assert_not_called()

    def test_update_changes_nothing_when_the_card_is_refused_or_unanswered(self):
        before = self.state()
        change = {'companion_mode': False, 'quiet_enabled': True, 'quiet_ranges': [[23, 7]], 'muted': ['comment'],
                  'observation_pause_minutes': 30, 'reply_language': 'en'}
        for decision in ('deny', 'expire'):
            with self.subTest(decision=decision):
                self.assertEqual(self.turn(decision).call('settings_update', change), {'error': {'code': 'user_declined'}})
                self.assertEqual(self.state(), before)
        self.controller.configure.assert_not_called()

    def test_update_applies_each_change_after_the_card_is_allowed(self):
        change = {'companion_mode': False, 'quiet_enabled': True, 'quiet_ranges': [[23, 7], [12, 13]],
                  'muted': ['comment', 'break'], 'observation_pause_minutes': 30, 'reply_language': 'en'}
        result = self.turn().call('settings_update', change)
        preview = self.card()
        self.assertEqual(preview['raw_input'], change)
        self.assertIn('修改设置', preview['title'])
        self.assertIn('→', preview['title'])
        for text in ('auto', 'en', '30', 'water', 'comment', '23', '22'):
            self.assertIn(text, preview['title'])
        self.assertEqual(self.state(), (False, (True, [[23, 7], [12, 13]]), ['break', 'comment'], self.now + 1800, 'en'))
        self.controller.configure.assert_called_once_with({'reply_language': 'en'})
        self.assertEqual(result, self.turn().call('settings_read', {}))
        self.assertIsNotNone(result['paused_until'])

    def test_update_keeps_what_it_does_not_name(self):
        self.turn().call('settings_update', {'quiet_enabled': True})
        self.assertEqual(self.state(), (True, (True, [[22, 8]]), ['water'], None, 'auto'))
        self.turn().call('settings_update', {'quiet_ranges': []})
        self.assertEqual(self.server.gate.quiet_settings, (True, []))
        self.controller.configure.assert_not_called()

    def test_zero_minutes_resumes_observation(self):
        self.turn().call('settings_update', {'observation_pause_minutes': 60})
        self.assertEqual(self.server.paused_until, self.now + 3600)
        result = self.turn().call('settings_update', {'observation_pause_minutes': 0})
        self.assertIsNone(self.server.paused_until)
        self.assertIsNone(result['paused_until'])

    def test_settings_outside_the_list_are_refused_before_any_card(self):
        before = self.state()
        for args in ({}, {'backend': 'codex'}, {'scope_id': 'scope-1'}, {'blacklist': []}, {'credential': 'x'},
                     {'quiet_enabled': True, 'history_retention': '7d'}):
            with self.subTest(args=args):
                self.assertIn('error', self.turn().call('settings_update', args))
                self.controller.interactions.approve.assert_not_called()
        self.assertEqual(self.state(), before)
        self.controller.configure.assert_not_called()

    def test_invalid_values_are_refused_before_any_card(self):
        before = self.state()
        for args in ({'quiet_ranges': [[24, 8]]}, {'quiet_ranges': [[8, 8]]}, {'quiet_ranges': [[8]]},
                     {'quiet_ranges': [[-1, 8]]}, {'quiet_ranges': [[1, 2]] * 9}, {'quiet_ranges': [[1.0, 2]]},
                     {'muted': ['everything']}, {'muted': 'water'}, {'observation_pause_minutes': PAUSE_MAX + 1},
                     {'observation_pause_minutes': -1}, {'observation_pause_minutes': True}, {'companion_mode': 1},
                     {'quiet_enabled': 'yes'}, {'reply_language': 'fr'}):
            with self.subTest(args=args):
                self.assertIn('error', self.turn().call('settings_update', args))
                self.controller.interactions.approve.assert_not_called()
        self.assertEqual(self.state(), before)

    def test_card_title_follows_the_reply_language(self):
        for code, word in (('en', 'Change settings'), ('ja', '設定を変更')):
            with self.subTest(code=code):
                self.controller.semantic = SimpleNamespace(reply=lambda code=code: code)
                self.turn().call('settings_update', {'companion_mode': False})
                self.assertIn(word, self.card()['title'])


class ReplyLanguageChangeTests(integration.IntegrationFixture):
    test_startup_discards_the_codex_log_database_an_unclean_exit_left = None  # runs in its own module
    busy_foreground, until, reply_of, state = (integration.IntegrationTests.busy_foreground, integration.IntegrationTests.until,
                                               integration.IntegrationTests.reply_of, integration.IntegrationTests.state)

    def test_reply_language_change_keeps_the_running_foreground_and_its_runtime(self):
        conn, response = self.open_feed(); self.addCleanup(conn.close)
        task = self.busy_foreground()
        runtime = self.controller.runtime
        self.controller.configure({'reply_language': 'en'})
        self.assertEqual(self.controller.settings.snapshot()['reply_language'], 'en')
        self.assertIs(self.controller.runtime, runtime)
        self.assertEqual((self.sessions[0].interrupted, self.sessions[0].closed), (0, 0))
        self.assertEqual(self.state(task['run_id']), 'running')
        self.gates['TASK'].set()
        _, final = self.reply_of(response, task['line_id'])
        self.assertEqual((final['error'], final['cancelled']), (None, False))
        self.until(lambda: self.state(task['run_id']) == 'completed' and not self.server._live_lines)
        self.line('next turn')
        self.assertIs(self.controller.runtime, runtime)


if __name__ == '__main__':
    unittest.main()
