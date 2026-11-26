"""Practical task receipts, authority boundaries and embodied-response isolation."""
from datetime import datetime, timezone
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from character_agent.services.reminders import ReminderTurn
from personal.commitments import Commitments, occurrence
from infra.store import open_store


class ReminderToolsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=sys.platform == "win32")
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'domain.sqlite'
        self.db = open_store(self.path)
        self.addCleanup(self.db.close)
        self.now = 1793448000.0
        self.store = Commitments(self.db, clock=lambda: self.now)
        self.approve = Mock(return_value={'request_id': 'card', 'input_sha256': 'x'})
        self.controller = SimpleNamespace(server=SimpleNamespace(commitments=self.store, feed=Mock()),
            interactions=SimpleNamespace(approve=self.approve), semantic=SimpleNamespace(reply=lambda: 'zh-Hans'))

    def iso(self, delta=600):
        return datetime.fromtimestamp(self.now + delta, timezone.utc).isoformat()

    def turn(self, text, run='run-1'):
        turn = ReminderTurn(self.controller, text, run)
        turn.open(lambda: True)
        return turn

    def create_args(self, quote='十分钟后提醒我喝水'):
        return {'text': '喝水', 'due_at': self.iso(), 'instruction_quote': quote}

    def test_saved_receipt_survives_restart_and_semantic_retry(self):
        args = self.create_args()
        first = self.turn(args['instruction_quote']).call('reminder_create', args, 'call-one')
        self.assertTrue(first['saved'])
        self.assertEqual(first['reminder']['state'], 'armed')
        other = open_store(self.path)
        try:
            self.controller.server.commitments = Commitments(other, clock=lambda: self.now)
            retry = self.turn(args['instruction_quote']).call('reminder_create', args, 'new-call-id')
            self.assertEqual(first, retry)
            self.assertEqual(len(self.controller.server.commitments.list()), 1)
        finally:
            other.close()

    def test_one_instruction_can_request_the_same_reminder_at_two_distinct_times(self):
        quote = '十分钟和二十分钟后分别提醒我喝水'
        turn = self.turn(quote)
        first = turn.call('reminder_create', self.create_args(quote))
        later = {**self.create_args(quote), 'due_at': self.iso(1200)}
        second = turn.call('reminder_create', later)
        self.assertNotEqual(first['reminder']['id'], second['reminder']['id'])
        self.assertEqual(turn.call('reminder_create', later)['reminder']['id'], second['reminder']['id'])
        self.assertEqual(len(self.store.list()), 2)

    def test_a_reminder_can_wait_for_a_trigger_instead_of_a_time(self):
        quote = '等 codex 跑完提醒我看结果'
        turn = self.turn(quote)
        args = {'text': '看结果', 'trigger': {'kind': 'session_done', 'agent': 'codex'}, 'instruction_quote': quote}
        result = turn.call('reminder_create', args)
        self.assertEqual((result['reminder']['due_at'], result['reminder']['due_at_iso'], result['reminder']['trigger']),
                         (None, None, {'kind': 'session_done', 'agent': 'codex'}))
        for bad in ({**args, 'due_at': self.iso()}, {'text': '看结果', 'instruction_quote': quote},
                    {**args, 'trigger': {'kind': 'approval_waiting'}}, {**args, 'repeat': 'daily'}):
            self.assertIn('error', turn.call('reminder_create', bad), bad)
        self.assertEqual(len(self.store.list()), 1)

    def test_the_japanese_offer_replies_create_their_reminders(self):
        from character.reminder_offer import TEXTS
        (_, once), (_, daily) = TEXTS['ja']
        for quote, text, repeat in ((once.format(title='修渲染', step='检查材质'), '「修渲染」の続き', None),
                                    (daily.format(title='修渲染'), '修渲染', 'daily')):
            args = {'text': text, 'due_at': self.iso(), 'instruction_quote': quote, **({'repeat': repeat} if repeat else {})}
            result = self.turn(quote).call('reminder_create', args)
            self.assertTrue(result.get('saved'), (quote, result))
        self.assertEqual([i['repeat'] for i in self.store.list()], [None, 'daily'])

    def test_build_add_and_set_wordings_create_a_reminder(self):
        for quote in ('帮我建一个提醒：十分钟后喝水', '再帮我加一个提醒，十分钟后喝水', '设个提醒，十分钟后喝水',
                      '定个闹钟，十分钟后喝水', '新建一条提醒：十分钟后喝水', '十分钟后提醒一下喝水',
                      '安排一个十分钟后喝水的提醒'):
            result = self.turn(quote).call('reminder_create', self.create_args(quote))
            self.assertTrue(result.get('saved'), (quote, result))
        self.assertEqual(len(self.store.list()), 7)

    def test_a_quote_with_the_full_stop_creates_the_reminder(self):
        quote = '10分钟后提醒我起来喝水。'
        result = self.turn(quote).call('reminder_create', {'text': '喝水', 'due_at': self.iso(), 'instruction_quote': quote})
        self.assertTrue(result.get('saved'), result)
        self.assertEqual([i['text'] for i in self.store.list()], ['喝水'])

    def test_delete_removes_receipt_text_and_prevents_late_retry_resurrection(self):
        args = self.create_args()
        turn = self.turn(args['instruction_quote'])
        first = turn.call('reminder_create', args)
        self.store.delete(first['reminder']['id'])
        raw = str(self.db.execute("SELECT request,answer FROM idempotency_receipts WHERE key LIKE 'character-reminder:%'").fetchall())
        self.assertNotIn('喝水', raw)
        result = turn.call('reminder_create', args)
        self.assertEqual(result['error']['code'], 'reminder_deleted')
        self.assertEqual(self.store.list(), [])

    def test_replayed_write_receipt_returns_current_reminder_state(self):
        args = self.create_args()
        turn = self.turn(args['instruction_quote'])
        first = turn.call('reminder_create', args)
        self.store.cancel(first['reminder']['id'])
        retry = turn.call('reminder_create', args)
        self.assertEqual(retry['write_receipt_revision'], 1)
        self.assertEqual(retry['reminder']['state'], 'cancelled')
        self.assertEqual(retry['reminder']['revision'], 2)

    def test_concurrent_duplicate_create_is_atomic_across_connections(self):
        barrier = threading.Barrier(2)
        results = []
        def create():
            db = open_store(self.path)
            try:
                store = Commitments(db, clock=lambda: self.now)
                barrier.wait(5)
                results.append(store.add('喝水', self.now + 600, 'run', request_key='same-request'))
            finally:
                db.close()
        threads = [threading.Thread(target=create) for _ in range(2)]
        for thread in threads: thread.start()
        for thread in threads: thread.join(10)
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0]['id'], results[1]['id'])
        self.assertEqual(len(self.store.list()), 1)

    def test_time_and_current_run_are_required(self):
        args = self.create_args()
        turn = self.turn(args['instruction_quote'])
        for due in ('2026-11-03T09:00:00.000', self.iso(-1), self.iso(367 * 86400)):
            result = turn.call('reminder_create', {**args, 'due_at': due})
            self.assertIn(result['error']['code'], ('reminder_timezone_required', 'reminder_time_out_of_range'))
        turn.open(lambda: False)
        self.assertEqual(turn.call('reminder_create', args)['error']['code'], 'run_cancelled')
        self.assertEqual(self.store.list(), [])

    def test_main_role_saves_a_reminder_without_a_file_scope_or_file_task(self):
        from test_character_agent_integration import IntegrationTests
        from test_character_agent_runtime import chat
        case = IntegrationTests()
        case.setUp()
        try:
            case.server.commitments = Commitments(case.db, lock=case.server.memory.lock, clock=lambda: self.now)
            quote = '十分钟后提醒我喝水'
            def script(session, prompt, options):
                yield from session.use(options, 'reminder_create', self.create_args(quote))
                yield from chat(session, prompt, options)
            case.script = script
            body, _ = case.line(quote)
            self.assertTrue(case.sessions[-1].responses[-1][2]['saved'])
            item = case.server.commitments.list()[0]
            self.assertEqual(item['created_line'], body['run_id'])
            self.assertEqual(item['due_at'], self.now + 600)
            self.assertIsNone(case.controller.store.get(body['run_id'])['task_id'])
        finally:
            case.tearDown()
            case.doCleanups()

    def answered(self, text):
        turn = ReminderTurn(self.controller, text, 'run-1')
        turn.open(lambda: True)
        return turn

    def answer_args(self, **args):
        return {'text': '续费', 'due_at': self.iso(28 * 86400), 'instruction_quote': '提醒我月底前续费',
                'time_quote': '11月28日上午十点', **args}

    def test_time_can_come_from_the_users_answer_to_her_question(self):
        turn = self.answered('提醒我月底前续费')
        result = turn.call('reminder_create', self.answer_args())
        self.assertTrue(result.get('saved'), result)
        self.assertEqual(result['reminder']['due_at'], self.now + 28 * 86400)
        self.assertEqual(turn.call('reminder_create', self.answer_args())['reminder']['id'], result['reminder']['id'])
        self.assertEqual(len(self.store.list()), 1)

    def test_time_quote_is_part_of_the_request_identity(self):
        turn = self.answered('提醒我月底前续费')
        first = turn.call('reminder_create', self.answer_args())
        second = turn.call('reminder_create', self.answer_args(time_quote='28号十点'))
        self.assertNotEqual(first['reminder']['id'], second['reminder']['id'])

    def test_blank_instruction_text_is_refused(self):
        saved = self.answered('提醒我月底前续费').call('reminder_create', self.answer_args(text='月底前续费会员'))
        self.assertTrue(saved.get('saved'), saved)
        blank = self.answered('提醒我月底前续费').call('reminder_create', self.answer_args(text='   '))
        self.assertEqual(blank.get('error', {}).get('code'), 'reminder_instruction_required', blank)
        self.assertEqual(len(self.store.list()), 1)

    def test_reschedule_and_cancel_check_revision_and_receipt(self):
        item = self.store.add('喝水', self.now + 600)
        args = {'reminder_id': item['id'], 'expected_revision': 1, 'action': 'reschedule',
                'due_at': self.iso(1200), 'instruction_quote': '把喝水提醒改到二十分钟后'}
        first = self.turn(args['instruction_quote']).call('reminder_update', args)
        self.assertEqual(first['reminder']['revision'], 2)
        self.assertEqual(first['reminder']['due_at'], self.now + 1200)
        self.assertEqual(self.turn(args['instruction_quote']).call('reminder_update', args), first)
        cancelled = {'reminder_id': item['id'], 'expected_revision': 1, 'action': 'cancel',
                     'instruction_quote': '取消喝水提醒'}
        result = self.turn(cancelled['instruction_quote'], 'next-run').call('reminder_update', cancelled)
        self.assertEqual(result['error']['code'], 'commitment_changed')
        cancelled['expected_revision'] = 2
        result = self.turn(cancelled['instruction_quote'], 'next-run').call('reminder_update', cancelled)
        self.assertEqual(result['reminder']['state'], 'cancelled')

    def added(self, *texts):
        items = []
        for text in texts:
            items.append(self.store.add(text, self.now + 3600))
            self.now += 60
        return items

    def update(self, quote, item, action='cancel', **args):
        return self.turn(quote).call('reminder_update', {'reminder_id': item['id'], 'expected_revision': 1,
                                                         'action': action, 'instruction_quote': quote, **args})

    def test_that_reminder_is_the_only_active_one(self):
        item, = self.added('喝水')
        result = self.update('取消那个提醒', item)
        self.assertEqual(result.get('reminder', {}).get('state'), 'cancelled', result)

    def test_that_reminder_can_be_rescheduled(self):
        item, = self.added('喝水')
        result = self.update('把那个提醒改到下午四点', item, 'reschedule', due_at=self.iso(1200))
        self.assertEqual(result.get('reminder', {}).get('due_at'), self.now + 1200, result)
        result = self.update('把它改到四点', item, 'reschedule', due_at=self.iso(1800), expected_revision=2)
        self.assertEqual(result.get('reminder', {}).get('due_at'), self.now + 1800, result)

    def test_done_wording_completes_the_named_reminder_and_the_list_shows_it(self):
        item, = self.added('交周报')
        result = self.update('那个交周报的提醒我做完了', item, 'complete')
        self.assertTrue(result.get('saved'), result)
        listed = self.turn('提醒的状态？').call('reminders_list', {'active_only': False})['items']
        self.assertEqual([(i['id'], i['state']) for i in listed], [(item['id'], 'fulfilled')])
        self.assertEqual(listed[0]['state'], self.store._get(item['id'])['state'])

    def test_complete_checks_the_revision(self):
        item, = self.added('交周报')
        result = self.update('交周报的提醒搞定了', item, 'complete', expected_revision=2)
        self.assertEqual(result.get('error', {}).get('code'), 'commitment_changed', result)
        self.assertEqual(self.store._get(item['id'])['state'], 'armed')

    def test_a_retried_complete_replays_its_receipt(self):
        item, = self.added('交周报')
        first = self.update('交周报的提醒搞定了', item, 'complete')
        self.assertTrue(first.get('saved'), first)
        self.assertEqual(self.update('交周报的提醒搞定了', item, 'complete'), first)
        result = self.turn('交周报的提醒搞定了', 'next-run').call('reminder_update', {
            'reminder_id': item['id'], 'expected_revision': 1, 'action': 'complete',
            'instruction_quote': '交周报的提醒搞定了'})
        self.assertEqual(result.get('error', {}).get('code'), 'commitment_changed', result)

    def test_that_reminder_just_delivered_can_be_snoozed(self):
        played, = self.added('喝水')
        self.store.fulfill(played['id'], None)
        quote = '那个提醒十分钟后再提醒我'
        result = self.update(quote, played, 'snooze', due_at=self.iso(600), expected_revision=2)
        self.assertEqual((result.get('reminder', {}).get('state'), result.get('reminder', {}).get('due_at')),
                         ('armed', self.now + 600), result)

    def test_snooze_updates_due_at(self):
        item, = self.added('喝水')
        result = self.update('十分钟后再提醒我', item, 'snooze', due_at=self.iso(600))
        self.assertEqual(result.get('reminder', {}).get('due_at'), self.now + 600, result)

    def test_cancel_waits_for_the_users_single_use_card(self):
        first, second = self.added('喝水', '交周报')
        for refusal in ('approval_denied', 'approval_expired'):
            self.approve.side_effect = ValueError(refusal)
            self.assertEqual(self.update('取消喝水提醒', first), {'error': {'code': 'user_declined'}})
        self.assertEqual(self.store._get(first['id'])['state'], 'armed')
        self.approve.side_effect = None
        turn = self.turn('取消喝水和周报的提醒')
        result = turn.call('reminder_update', {'reminder_id': first['id'], 'expected_revision': 1, 'action': 'cancel'})
        self.assertEqual((result['reminder']['state'], result['authority']), ('cancelled', 'user_approved'))
        args, kwargs = self.approve.call_args
        self.assertEqual((args[0], args[1]['source'], args[1]['kind']), ('run-1', 'agentd', 'other'))
        self.assertIn('喝水', args[1]['title'])
        self.assertTrue(kwargs['single_only'])
        self.approve.side_effect = ValueError('approval_denied')
        result = turn.call('reminder_update', {'reminder_id': second['id'], 'expected_revision': 1, 'action': 'cancel'})
        self.assertEqual(result, {'error': {'code': 'user_declined'}})
        self.assertEqual(self.store._get(second['id'])['state'], 'armed')
        self.assertEqual(self.approve.call_count, 4)

    def test_writes_without_a_card_say_the_model_proposed_them(self):
        result = self.turn('十分钟后提醒我喝水').call('reminder_create', self.create_args())
        self.assertEqual(result['authority'], 'model_proposed')
        result = self.update('十分钟后再提醒我', result['reminder'], 'snooze', due_at=self.iso(1200))
        self.assertEqual(result['authority'], 'model_proposed')
        self.approve.assert_not_called()

    def test_snoozing_a_repeating_reminder_moves_only_this_occurrence(self):
        item = self.store.add('喝水', self.now + 600, repeat='daily')
        result = self.update('半小时后再提醒我', item, 'snooze', due_at=self.iso(1800))
        self.assertEqual(result.get('reminder', {}).get('due_at'), self.now + 1800, result)
        self.now += 1800
        self.store.due()
        self.assertEqual(self.store.fulfill(item['id'], None)['due_at'], occurrence(item['due_at'], 'daily', self.now))

    def test_rescheduling_a_repeating_reminder_moves_the_series(self):
        item = self.store.add('喝水', self.now + 600, repeat='daily')
        result = self.update('以后都晚半小时提醒我', item, 'reschedule', due_at=self.iso(1800))
        self.assertEqual(result.get('reminder', {}).get('due_at'), self.now + 1800, result)
        self.now += 1800
        self.store.due()
        self.assertEqual(self.store.fulfill(item['id'], None)['due_at'], occurrence(self.now, 'daily', self.now))

    def test_two_different_snoozes_in_one_run_both_apply(self):
        item, = self.added('喝水')
        turn = self.turn('先推迟十分钟，算了，推迟二十分钟')
        first = turn.call('reminder_update', {'reminder_id': item['id'], 'expected_revision': 1, 'action': 'snooze',
                                              'due_at': self.iso(600)})
        self.assertEqual(first.get('reminder', {}).get('due_at'), self.now + 600, first)
        second = turn.call('reminder_update', {'reminder_id': item['id'], 'expected_revision': 2, 'action': 'snooze',
                                               'due_at': self.iso(1200)})
        self.assertEqual(second.get('reminder', {}).get('due_at'), self.now + 1200, second)

    def test_terminal_reminder_does_not_claim_user_heard_or_completed_work(self):
        item = self.store.add('提交报告', self.now + 600)
        self.store.fulfill(item['id'], None)
        result = self.turn('提醒的状态？').call('reminders_list', {'active_only': False})
        self.assertEqual(result['items'][0]['delivery_evidence'], 'not_confirmed')
        self.assertIsNone(result['items'][0]['underlying_task_completed'])

    def test_a_shown_card_is_the_delivery_evidence(self):
        shown, unseen = self.store.add('提交报告', self.now), self.store.add('喝水', self.now)
        self.store.due()
        self.store.seen(shown['id'])
        result = self.turn('提醒的状态？').call('reminders_list', {})
        self.assertEqual({i['id']: i['delivery_evidence'] for i in result['items']},
                         {shown['id']: 'card_shown', unseen['id']: 'not_confirmed'})


class EmbodiedResponseTests(unittest.TestCase):
    def test_read_only_role_can_turn_without_file_memory_or_desktop_authority(self):
        from test_character_agent_runtime import RuntimeTests, chat
        case = RuntimeTests()
        case.setUp()
        try:
            calls = []
            case.runtime.native_tools = [{'name': n, 'input_schema': {'type': 'object'}}
                                        for n in ('avatar_face', 'avatar_facing_status', 'desktop_act')]
            case.runtime.native_handler = lambda name, args, **kw: calls.append(name) or {'accepted': True, 'completed': False}
            # Offered to every mode but refused here, or never offered to this turn.
            refused = {'desktop_act': 'tool_not_allowed_in_mode', 'artifact_write': 'tool_not_allowed_in_mode',
                       'memory_propose': 'tool_not_available', 'background_start': 'tool_not_available'}
            def respond(session, prompt, options):
                for name in ('avatar_face', *refused):
                    value = options['tool_handler'](name, {})
                    if name == 'avatar_face':
                        self.assertFalse(value['completed'])
                    else:
                        self.assertEqual(value['error']['code'], refused[name])
                yield from chat(session, prompt, options)
            case.script = respond
            reply = case.run_agent(allow_actions=False, mode='embodied_only')
            self.assertIsNone(reply.error)
            self.assertIsNone(reply.task_id)
            self.assertEqual(calls, ['avatar_face'])
            self.assertFalse(case.runtime.store.get('run-1')['delivery_eligible'])
        finally:
            case.tearDown()
            case.doCleanups()

    def test_actor_receipt_is_visible_to_the_next_role_turn(self):
        from test_character_agent_integration import IntegrationTests
        case = IntegrationTests()
        case.setUp()
        try:
            case.server.spatial.facing_status = lambda *_: {'available': True, 'behavior_id': 'face-one',
                'requested_yaw': 45, 'phase': 'failed', 'outcome': {'code': 'body_busy'}}
            case.line('刚才转身完成了吗？')
            prompt = case.sessions[-1].calls[-1]['prompt']
            self.assertIn('face-one', prompt)
            self.assertIn('body_busy', prompt)
            self.assertIn('not the measured pose', prompt)
        finally:
            case.tearDown()
            case.doCleanups()

    def test_turn_time_context_does_not_recreate_a_compatible_native_session(self):
        from datetime import timedelta
        from unittest.mock import patch
        from test_character_agent_integration import IntegrationTests
        case = IntegrationTests()
        case.setUp()
        try:
            now = datetime.now().astimezone()
            with patch('character_agent.integration.datetime') as clock:
                clock.now.side_effect = [now, now + timedelta(seconds=10)]
                case.line('你好')
                case.line('请继续聊天')
            self.assertEqual(len(case.sessions), 1)
            self.assertEqual(len(case.sessions[0].calls), 2)
        finally:
            case.tearDown()
            case.doCleanups()


class ProviderProfilesTests(unittest.TestCase):
    def test_profiles_use_their_own_backend_and_api_key_mode(self):
        from character_agent.services.providers import PROFILES, catalog, connection
        self.assertEqual({(p['id'], p['credential_backend']) for p in catalog()}, {('xai', 'xai'), ('deepseek', 'deepseek')})
        for name, profile in PROFILES.items():
            settings = {'backends': {name: {'base_url': profile['base_url'] + '/'},
                                     'compatible': {'supports_images': True}}}
            self.assertEqual(connection(name, settings, 'api_key'),
                             {'provider': name, 'auth_source': 'api_key', 'base_url': profile['base_url']})
            with self.assertRaisesRegex(ValueError, 'requires_api_key'):
                connection(name, settings, 'existing_login')

    def test_pi_uses_product_semantic_tools_and_its_own_provider_credentials(self):
        from character_agent.services.capabilities import describe
        from test_character_agent_semantic import SemanticTests
        case = SemanticTests()
        case.setUp()
        try:
            config = case.c.settings.save({'backend': 'pi', 'provider': 'deepseek', 'model': 'user-selected-model', 'auth_source': 'api_key'})
            case.server.models = SimpleNamespace(snapshot=lambda: {'backends': {
                'deepseek': {'base_url': 'https://api.deepseek.com', 'api_key': 'profile-private-key'},
                'compatible': {'api_key': 'never-forward-the-compatible-key'},
                'openai': {'api_key': 'never-forward-native-or-other-provider-key'}}})
            self.assertEqual(case.c._credential(config), 'profile-private-key')
            case.reply = {'understanding': 'unknown without evidence'}
            run = case.c.semantic.run('review', 'Return evidence-bound JSON', {'source': 'fixture'})
            self.assertEqual(run['value'], case.reply)
            self.assertTrue(describe(config)['features']['goal_and_job_interaction']['implemented'])
            self.assertTrue(describe(config)['features']['automatic_memory_observation_proactive']['implemented'])
            case.server.models = SimpleNamespace(snapshot=lambda: {'backends': {
                'compatible': {'api_key': 'profile-private-key'}}})
            with self.assertRaisesRegex(ValueError, 'missing_provider_api_key'):
                case.c._credential(config)
        finally:
            case.tearDown()
            case.doCleanups()


if __name__ == '__main__':
    unittest.main()
