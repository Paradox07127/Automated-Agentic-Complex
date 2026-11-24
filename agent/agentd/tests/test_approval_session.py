"""Conversation tool grants never bypass danger or catalog identity."""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_agent.services.interactions import InteractionService
from character_agent.services.store import RunStore
from tool_gateway.policy import POLICY


class ApprovalSessionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = RunStore(self.root / 'runs.sqlite')
        self.store.begin('run', 'conversation', 'role', 0)
        self.cards, self.events = [], []
        self.answer = 'allow_session'
        self.service = InteractionService(self.store, emit=self.emit)

    def tearDown(self):
        self.service.close(); self.store.close(); self.temp.cleanup()

    def emit(self, event):
        self.events.append(event)
        if event['state'] != 'pending': return
        card = self.service.get(event['request_id'])
        self.cards.append(card)
        if self.answer == 'allow_session':
            self.assertIn('allow_session', card['data'].get('approval_answers', []))
        self.service.respond(card['request_id'], card['revision'], {'decision': [self.answer]})

    def approve(self, run='run', **changes):
        preview = {'server': 'remote', 'tool': 'run', 'catalog_sha256': 'catalog-a', 'arguments': {'command': 'ls'}}
        preview.update(changes)
        dangerous, rule = POLICY.danger('Bash', [preview['arguments'].get('command')])
        return self.service.approve(run, preview, valid=lambda: True, character_id='role',
                                    dangerous=dangerous, danger_rule=rule)

    def test_same_tool_skips_card_across_turns_but_other_conversation_asks(self):
        first = self.approve()
        self.store.begin('next', 'conversation', 'role', 0)
        receipt = self.approve('next', arguments={'command': 'pwd'})
        self.assertEqual(len(self.cards), 1)
        self.assertTrue(receipt['session_allowed'])
        self.assertEqual(receipt['request_id'], first['request_id'])
        self.assertNotEqual(receipt['input_sha256'], first['input_sha256'])
        self.assertTrue(any(e.get('session_allowed') and e['conversation_id'] == 'conversation' for e in self.events))
        self.store.begin('other', 'another-conversation', 'role', 0)
        self.approve('other')
        self.assertEqual(len(self.cards), 2)

    def test_the_offered_session_label_saves_the_grant_like_allow_session(self):
        self.answer = '本对话都允许'
        first = self.approve()
        self.assertIn({'label': '本对话都允许'}, self.cards[0]['data']['questions'][0]['options'])
        receipt = self.approve(arguments={'command': 'pwd'})
        self.assertEqual(len(self.cards), 1)
        self.assertEqual(receipt['request_id'], first['request_id'])
        with self.assertRaisesRegex(ValueError, 'invalid_approval'):
            self.approve(arguments={'command': 'rm -rf out'})

    def test_card_question_follows_the_reply_language(self):
        self.answer = 'allow'
        for run, language, question in (('en-run', 'en', 'Allow this operation this time?'), ('zh-run', 'zh-Hans', '是否允许这一次操作？')):
            with self.subTest(language=language):
                self.store.begin(run, 'conversation-' + run, 'role', 0)
                self.service.approve(run, {'tool': 'send', 'arguments': {}}, valid=lambda: True, character_id='role',
                                     single_only=True, language=language)
                self.assertEqual(self.cards[-1]['data']['questions'][0]['question'], question)

    def test_danger_still_asks_and_rejects_forged_session_answer(self):
        self.approve()
        self.answer = 'allow'
        respond = self.service.respond
        def single_only(ident, revision, answers):
            card = self.service.get(ident)
            self.assertNotIn('allow_session', card['data']['approval_answers'])
            with self.assertRaisesRegex(ValueError, 'invalid_approval'):
                respond(ident, revision, {'decision': ['allow_session']})
            return respond(ident, revision, answers)
        with patch.object(self.service, 'respond', side_effect=single_only):
            self.approve(arguments={'command': 'rm -rf out'})
        self.assertEqual(len(self.cards), 2)
        self.assertTrue(self.cards[-1]['data']['dangerous'])
        with patch.object(self.service, 'respond', side_effect=single_only):
            self.service.approve('run', {'server':'remote','tool':'run','catalog_sha256':'catalog-a'},
                                 valid=lambda: True, character_id='role', single_only=True)
        self.assertEqual(len(self.cards), 3)
        self.assertTrue(self.approve()['session_allowed'])
        self.assertEqual(len(self.cards), 3)

    def test_catalog_change_revokes_even_if_old_catalog_returns(self):
        self.approve()
        self.answer = 'allow'
        self.approve(catalog_sha256='catalog-b')
        self.approve(catalog_sha256='catalog-a')
        self.assertEqual(len(self.cards), 3)
        self.answer = 'allow_session'
        self.approve()
        self.service.catalog_changed('remote', 'catalog-b')
        self.service.catalog_changed('remote', 'catalog-a')
        self.approve()
        self.assertEqual(len(self.cards), 5)

    def test_server_and_tool_identity_are_separate(self):
        self.approve()
        self.approve(server='other')
        self.approve(tool='other')
        self.assertEqual(len(self.cards), 3)

    def test_restart_clears_grant_and_allow_once_does_not_save_one(self):
        self.approve()
        self.service.close()
        self.service = InteractionService(self.store, emit=self.emit)
        self.answer = 'allow'
        self.approve(); self.approve()
        self.assertEqual(len(self.cards), 3)

    def test_builtin_tool_without_catalog_uses_conversation_owner(self):
        self.approve(server=None, catalog_sha256=None)
        self.approve(server=None, catalog_sha256=None, arguments={})
        self.assertEqual(len(self.cards), 1)
