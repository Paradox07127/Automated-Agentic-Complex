"""Review findings: a hook title obeys the blacklist and secure input, revoking agent_sessions forgets its
summaries, and POST /reset forgets her thoughts."""
import io
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
import unittest.mock
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import test_character_agent_semantic as semantic  # noqa: E402
import test_reset  # noqa: E402
from api.handler import Handler  # noqa: E402
from character.gate import Gate  # noqa: E402
from character.thoughts import Thoughts  # noqa: E402
from daemon.agentd_server import AgentdServer  # noqa: E402
from observation.attention import AttentionStore  # noqa: E402
from observation.blacklist import Blacklist  # noqa: E402
from support import deny_blacklist, enable_plugins  # noqa: E402
from test_thoughts import FakeSemantic, session  # noqa: E402


class HookTitleTest(unittest.TestCase):
    def setUp(self):
        enable_plugins(self, 'coding_sessions')
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        with patch.object(AgentdServer, 'server_bind'), patch.object(AgentdServer, 'server_activate'):
            self.server = AgentdServer(('127.0.0.1', 48810), 'hook-token', 'ui-token')
        self.server.server_port = 48810
        self.addCleanup(self.server.server_close)
        self.server.share_typed_text = self.server.share_agent_sessions = True
        self.attention = self.server.attention = AttentionStore(root / 'attention.sqlite', Blacklist(deny_blacklist(root / 'blacklist.json')))
        self.addCleanup(self.attention.close)

    def hook(self, prompt, session_id='A'):
        payload = json.dumps({'hook_event_name': 'UserPromptSubmit', 'session_id': session_id, 'cwd': '/w',
                              'prompt': prompt}).encode()
        raw = (f'POST /hook/claude HTTP/1.1\r\nHost: 127.0.0.1:48810\r\nAuthorization: Bearer hook-token\r\n'
               f'Content-Type: application/json\r\nContent-Length: {len(payload)}\r\n\r\n').encode() + payload
        handler = Handler.__new__(Handler)
        handler.server = self.server
        handler.rfile, handler.wfile = io.BytesIO(raw), io.BytesIO()
        handler.handle_one_request()
        self.assertIn(b' 200 ', handler.wfile.getvalue().split(b'\r\n', 1)[0] + b' ')

    def prompts(self):
        return self.attention.db.execute("SELECT value FROM events_raw WHERE kind = 'prompt'").fetchall()

    def test_a_blacklisted_agent_app_keeps_no_prompt_title(self):
        self.attention.blacklist.add('app_names', 'claude')
        self.hook('Rename the payroll export')
        self.assertEqual(self.prompts(), [])
        self.assertEqual(self.server.registry.titles(), {})

    def test_a_prompt_under_secure_input_keeps_no_title(self):
        self.attention.ingest({'ts': time.time(), 'idle_s': 0, 'front': {'app': 'Terminal', 'window_id': 7},
                               'secure_input': True})
        self.hook('my password is hunter2')
        self.assertEqual(self.prompts(), [(None,)])
        self.assertEqual(self.server.registry.titles(), {})

    def test_an_allowed_prompt_is_still_the_title(self):
        self.hook('Please fix the failing build')
        self.assertEqual(self.prompts(), [('Please fix the failing build',)])
        self.assertEqual(self.server.registry.titles(), {'claude:A': 'Please fix the failing build'})


class AgentSessionsRevocationTest(unittest.TestCase):
    setUp = semantic.SemanticTests.setUp
    tearDown = semantic.SemanticTests.tearDown
    factory = semantic.SemanticTests.factory
    source = semantic.SemanticTests.source
    findings = semantic.SemanticTests.findings

    def test_revoking_agent_sessions_deletes_the_summaries_built_from_them_and_their_facts(self):
        self.server.share_agent_sessions = True
        self.server.sync_privacy()
        self.source(); self.reply = self.findings('建议改用更短的报告。'); result = self.pipeline.run_once()
        episode = result['episode_id']
        threads = self.server.episodes.get(episode)['threads']
        for thread in threads: thread['requires'] = ['agent_sessions']
        self.db.execute('UPDATE episodes SET threads=? WHERE id=?', (json.dumps(threads), episode)); self.db.commit()
        self.assertTrue(self.c._permitted('episodes', self.server.episodes.get(episode)))
        self.assertTrue(self.server.memory.candidates())
        self.server.share_agent_sessions = False
        self.server.sync_privacy()
        self.assertIsNone(self.server.episodes.get(episode))
        self.assertEqual(self.server.memory.candidates(), [])

    def session_episode(self):
        self.server.share_agent_sessions = True
        self.server.sync_privacy()
        self.source(); self.reply = self.findings('建议改用更短的报告。'); episode = self.pipeline.run_once()['episode_id']
        threads = self.server.episodes.get(episode)['threads']
        for thread in threads: thread['requires'] = ['agent_sessions']
        self.db.execute('UPDATE episodes SET threads=? WHERE id=?', (json.dumps(threads), episode)); self.db.commit()
        return episode

    def test_the_privacy_preview_counts_what_revoking_agent_sessions_deletes(self):
        episode = self.session_episode()
        self.assertEqual(self.server.privacy_preview({'agent_sessions'})['episodes'], 1)
        self.assertIsNotNone(self.server.episodes.get(episode))

    def test_startup_forgets_session_summaries_when_agent_sessions_was_turned_off_while_stopped(self):
        from daemon.main import startup_privacy
        episode = self.session_episode()
        self.server.share_agent_sessions = False
        with patch.object(self.server, 'attention', unittest.mock.MagicMock(), create=True) as attention:
            startup_privacy(self.server)
        self.assertIsNone(self.server.episodes.get(episode))
        attention.clear_agent_sessions.assert_called_once_with()


class ResetThoughtsTest(unittest.TestCase):
    setUp = test_reset.ResetTest.setUp
    tearDown = test_reset.ResetTest.tearDown

    def thoughts(self, semantic):
        self.published = []
        self.server.thoughts = Thoughts(Gate(enabled=True),
                                        lambda event, data: self.published.append((event, data)), semantic,
                                        scene=lambda: {"activity": "editing_code", "confidence": 0.8},
                                        sessions=lambda: {"sessions": [session("claude:A", "thinking")]},
                                        spawn=lambda f: f())
        return self.server.thoughts

    def test_reset_forgets_the_latest_thought(self):
        thoughts = self.thoughts(FakeSemantic())
        thoughts.notice("started", {"session_id": "claude:A"})
        self.assertIsNotNone(thoughts.latest())
        self.assertEqual(self.server.reset()[0], 200)
        self.assertIsNone(thoughts.latest())

    def test_a_thought_asked_for_before_the_reset_is_not_kept_or_published(self):
        semantic = FakeSemantic()
        run = semantic.run
        statuses = []

        def reset_during_the_call(*args, **options):
            statuses.append(self.server.reset()[0])
            return run(*args, **options)
        semantic.run = reset_during_the_call
        thoughts = self.thoughts(semantic)
        thoughts.notice("started", {"session_id": "claude:A"})
        self.assertEqual(statuses, [200])
        self.assertIsNone(thoughts.latest())
        self.assertEqual(self.published, [])


if __name__ == "__main__":
    unittest.main()
