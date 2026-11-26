"""Interaction presets bound background work; hard gates and explicit/local responses retain their rules."""
import contextlib
import datetime
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from character.behavior import Behavior  # noqa: E402
from character.gate import Gate  # noqa: E402
from character.interactions import PRESETS, preset  # noqa: E402
from sessions.registry import Registry  # noqa: E402
from daemon.agentd_server import AgentdServer  # noqa: E402
from daemon.main import parse_args  # noqa: E402
from observation.spatial import Spatial  # noqa: E402
from character_agent.services.interactions import InteractionService, approved
from character_agent.services.store import RunStore


class OwnershipTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = RunStore(Path(self.tmp.name) / 'runs.sqlite')

    def tearDown(self):
        self.store.close(); self.tmp.cleanup()

    def test_k10_question_returns_immediately_and_is_answerable_after_two_days(self):
        now = [100.]
        service = InteractionService(self.store, clock=lambda: now[0], wait_seconds=30)
        self.addCleanup(service.close)
        finished = threading.Event(); errors = []
        def ask():
            try:
                service.ask('run', [{'id': 'q', 'question': '用途？'}], valid=lambda: True, character_id='aster')
            except ValueError as error:
                errors.append(str(error))
            finally: finished.set()
        thread = threading.Thread(target=ask)
        thread.start()
        try:
            self.assertTrue(finished.wait(.2), 'question kept its execution thread')
            self.assertEqual(errors, ['interaction_pending'])
            now[0] += 2 * 86400
            card = service.list()[0]
            self.assertEqual(service.respond(card['request_id'], card['revision'], {'q': ['核查']})['state'], 'answered')
        finally:
            service.close(); thread.join(1)

    def test_questions_and_approvals_inherit_the_run_conversation(self):
        self.store.begin('run-x', 'conversation-x', 'aster', 0)
        events = []
        service = InteractionService(self.store, emit=events.append, wait_seconds=0)
        for kind, error in (('question', 'interaction_pending'), ('approval', 'approval_expired')):
            with self.assertRaisesRegex(ValueError, error):
                service.ask('run-x', [{'id': 'q', 'question': '用途？'}], kind=kind,
                    valid=lambda: True, character_id='aster')
            row = service.get(events[-1]['request_id'])
            self.assertEqual(row['conversation_id'], 'conversation-x')
            self.assertEqual(row['run_id'], 'run-x')
            self.assertEqual(row['generation'], 0)

    def test_failed_dispatch_rearms_interaction_with_higher_generation(self):
        service = InteractionService(self.store, wait_seconds=0)
        with self.assertRaisesRegex(ValueError, 'interaction_pending'):
            service.ask('run', [{'id': 'q', 'question': '用途？'}], valid=lambda: True, character_id='aster')
        row = service.list()[0]
        answered = service.respond(row['request_id'], row['revision'], {'q': ['核查']})
        service.claim(row['request_id'], answered['revision'])
        before = service.get(row['request_id'])
        service.settle(row['request_id'], False)
        rearmed = service.get(row['request_id'])
        self.assertEqual(rearmed['state'], 'answered')
        self.assertGreater(rearmed['generation'], before['generation'])

    def test_answer_receipt_is_stable_when_consumer_delivers_before_response(self):
        def emit(event):
            if event['state'] == 'answered':
                with self.store.lock:
                    self.store.db.execute("UPDATE character_interactions SET state='delivered',answer=NULL,data=NULL WHERE request_id=?",
                                          (event['request_id'],))
                    self.store.db.commit()
        service = InteractionService(self.store, emit=emit, wait_seconds=0)
        with self.assertRaisesRegex(ValueError, 'interaction_pending'):
            service.ask('run', [{'id': 'q', 'question': '用途？'}], valid=lambda: True, character_id='aster')
        row = service.list()[0]
        receipt = service.respond(row['request_id'], row['revision'], {'q': ['核查']})
        self.assertEqual(receipt['answer'], {'answers': {'q': ['核查']}})
        self.assertEqual(receipt['state'], 'answered')
        self.assertEqual(service.get(row['request_id'])['state'], 'delivered')

    def test_answer_is_acknowledged_when_another_turn_delays_continuation(self):
        def busy(ident, revision):
            service.claim(ident,revision)
            service.settle(ident,False)
            raise ValueError('character_busy')
        service=InteractionService(self.store,resume=busy)
        with self.assertRaisesRegex(ValueError,'interaction_pending'):
            service.ask('run',[{'id':'q','question':'用途？'}],valid=lambda:True,character_id='aster')
        row=service.list()[0]
        receipt=service.respond(row['request_id'],row['revision'],{'q':['核查']})
        self.assertEqual(receipt['state'],'answered')
        self.assertTrue(receipt['resume_required'])
        self.assertEqual(receipt['answer'],{'answers':{'q':['核查']}})
        self.assertEqual(service.get(row['request_id'])['answer'],receipt['answer'])

    def test_restart_recovers_resuming_answer(self):
        service = InteractionService(self.store, wait_seconds=0)
        with self.assertRaisesRegex(ValueError, 'interaction_pending'):
            service.ask('run', [{'id': 'q', 'question': '用途？'}], valid=lambda: True, character_id='aster')
        row = service.list()[0]
        answered = service.respond(row['request_id'], row['revision'], {'q': ['核查']})
        service.claim(row['request_id'], answered['revision'])
        before = service.get(row['request_id'])
        self.store.close()
        self.store = RunStore(Path(self.tmp.name) / 'runs.sqlite')
        restarted = InteractionService(self.store)
        recovered = restarted.get(row['request_id'])
        self.assertEqual(recovered['state'], 'answered')
        self.assertEqual(recovered['answer'], {'answers': {'q': ['核查']}})
        self.assertGreater(recovered['generation'], before['generation'])
        self.assertGreater(recovered['revision'], before['revision'])
        self.assertEqual(restarted.claim(row['request_id'], recovered['revision'])['answer'], recovered['answer'])

    def test_w004_invalidate_only_selected_run_questions_and_approvals(self):
        service = InteractionService(self.store, wait_seconds=0)
        for run in ('affected', 'other'):
            for kind, error in (('question', 'interaction_pending'), ('approval', 'approval_expired')):
                with self.assertRaisesRegex(ValueError, error):
                    service.ask(run, [{'id': 'q', 'question': '用途？'}], kind=kind,
                        valid=lambda: True, character_id='aster')
        rows = self.store.db.execute('SELECT request_id,run_id FROM character_interactions').fetchall()
        service.invalidate(run_ids={'affected'})
        for ident, run in rows:
            self.assertEqual(service.get(ident) is None, run == 'affected')
        card = service.list()[0]
        self.assertEqual(service.respond(card['request_id'], card['revision'], {'q': ['核查']})['state'], 'answered')

    def unlocked_recorder(self):
        events = []
        def emit(event):
            free = []
            def probe():
                free.append(self.store.lock.acquire(blocking=False))
                if free[0]: self.store.lock.release()
            thread = threading.Thread(target=probe)
            thread.start(); thread.join()
            events.append((event, free[0]))
        return events, emit

    def test_dismiss_emits_dismissed_outside_the_lock(self):
        events, emit = self.unlocked_recorder()
        service = InteractionService(self.store, emit=emit, wait_seconds=0)
        with self.assertRaisesRegex(ValueError, 'interaction_pending'):
            service.ask('run', [{'id': 'q', 'question': '用途？'}], valid=lambda: True, character_id='aster')
        card = service.list()[0]
        with self.assertRaisesRegex(ValueError, 'interaction_version_changed'):
            service.dismiss(card['request_id'], card['revision'] + 1)
        self.assertEqual(len(events), 1)
        service.dismiss(card['request_id'], card['revision'])
        self.assertEqual(events[1:], [({'request_id': card['request_id'], 'kind': 'question', 'state': 'dismissed'}, True)])

    def test_invalidate_emits_invalidated_for_each_deleted_id(self):
        events, emit = self.unlocked_recorder()
        service = InteractionService(self.store, emit=emit, wait_seconds=0)
        for run in ('affected', 'other'):
            for kind, error in (('question', 'interaction_pending'), ('approval', 'approval_expired')):
                with self.assertRaisesRegex(ValueError, error):
                    service.ask(run, [{'id': 'q', 'question': '用途？'}], kind=kind,
                        valid=lambda: True, character_id='aster')
        rows = self.store.db.execute('SELECT request_id,run_id,kind FROM character_interactions').fetchall()
        del events[:]
        service.invalidate(run_ids={'affected'})
        expected = [({'request_id': ident, 'kind': kind, 'state': 'invalidated'}, True)
                    for ident, run, kind in rows if run == 'affected']
        self.assertEqual(sorted(events, key=lambda e: e[0]['request_id']), sorted(expected, key=lambda e: e[0]['request_id']))
        del events[:]
        service.invalidate()
        expected = [({'request_id': ident, 'kind': kind, 'state': 'invalidated'}, True)
                    for ident, run, kind in rows if run == 'other']
        self.assertEqual(sorted(events, key=lambda e: e[0]['request_id']), sorted(expected, key=lambda e: e[0]['request_id']))

    def test_list_emits_expired_for_each_lapsed_role_approval(self):
        events, emit = self.unlocked_recorder()
        service = InteractionService(self.store, emit=emit, clock=lambda: 500)
        for ident, kind, state, expires in (('late', 'approval', 'pending', 400), ('late-answered', 'approval', 'answered', 450),
                                            ('fresh', 'approval', 'pending', 600), ('question', 'question', 'pending', 0)):
            self.store.db.execute("INSERT INTO character_interactions(request_id,run_id,kind,state,revision,data,created_at,expires_at) "
                "VALUES(?,'run',?,?,1,'{}',300,?)", (ident, kind, state, expires))
        self.store.db.commit()
        self.assertEqual(sorted(row['request_id'] for row in service.list()), ['fresh', 'question'])
        self.assertEqual(sorted(events, key=lambda e: e[0]['request_id']), [
            ({'request_id': 'late', 'kind': 'approval', 'state': 'expired'}, True),
            ({'request_id': 'late-answered', 'kind': 'approval', 'state': 'expired'}, True)])
        del events[:]
        service.list()
        self.assertEqual(events, [])

    def test_an_approval_that_lapses_while_waiting_emits_expired(self):
        events, emit = self.unlocked_recorder()
        service = InteractionService(self.store, emit=emit, wait_seconds=0)
        with self.assertRaisesRegex(ValueError, 'approval_expired'):
            service.ask('run', [{'id': 'decision', 'question': '允许？'}], valid=lambda: True, character_id='aster',
                        kind='approval')
        [(pending, _), *rest] = events
        self.assertEqual(rest, [({'request_id': pending['request_id'], 'kind': 'approval', 'state': 'expired'}, True)])
        self.assertEqual(service.get(pending['request_id'])['state'], 'expired')
        service.list()
        self.assertEqual(len(events), 2)

    def test_approved_tells_a_refused_card_from_a_lapsed_or_dismissed_one(self):
        def answered(outcome):
            def emit(event):
                if event['state'] != 'pending':
                    return
                row = service.get(event['request_id'])
                if outcome == 'dismiss':
                    service.dismiss(row['request_id'], row['revision'])
                elif outcome != 'expire':
                    service.respond(row['request_id'], row['revision'], {'decision': [outcome]})
            service = InteractionService(self.store, emit=emit, wait_seconds=0 if outcome == 'expire' else 5)
            self.addCleanup(service.close)
            return approved(service, 'run', '取消提醒：喝水', {}, valid=lambda: True, character_id='aster')
        self.assertEqual({outcome: answered(outcome) for outcome in ('允许', '拒绝', 'expire', 'dismiss')},
                         {'允许': 'allowed', '拒绝': 'denied', 'expire': 'expired', 'dismiss': 'dismissed'})

    def test_approval_wait_returns_on_wake_without_sleep_loop(self):
        service = InteractionService(self.store, wait_seconds=30)
        wake = mock.Mock(); waits = []
        def wait(timeout):
            waits.append(timeout)
            row = service.list()[0]
            service.respond(row['request_id'], row['revision'], {'decision': ['允许']})
            return True
        wake.wait.side_effect = wait
        with mock.patch('character_agent.services.interactions.threading.Event', return_value=wake), \
                mock.patch('character_agent.services.interactions.time.sleep') as sleep:
            result = service.ask('run', [{'id': 'decision', 'question': '允许？'}], valid=lambda: True, character_id='aster', kind='approval')
        self.assertEqual(result['answers'], {'decision': ['允许']})
        self.assertEqual(len(waits), 1)
        self.assertEqual(waits[0], .5)
        wake.clear.assert_not_called()
        sleep.assert_not_called()

    def test_invalid_run_stops_approval_wait_within_one_second(self):
        waiting, cancelled, finished = threading.Event(), threading.Event(), threading.Event()
        errors = []
        def emit(event):
            if event['state'] != 'pending':
                return
            wake = service.live[event['request_id']][0]
            wait = wake.wait
            def observed_wait(timeout):
                waiting.set()
                return wait(timeout)
            wake.wait = observed_wait
        service = InteractionService(self.store, emit=emit, wait_seconds=30)
        def ask():
            try:
                service.ask('run', [{'id': 'decision', 'question': '允许？'}],
                    valid=lambda: not cancelled.is_set(), character_id='aster', kind='approval')
            except ValueError as error: errors.append(str(error))
            finally: finished.set()
        worker = threading.Thread(target=ask)
        worker.start()
        try:
            self.assertTrue(waiting.wait(1))
            cancelled.set()
            self.assertTrue(finished.wait(1), 'invalid run left answer wait blocked')
            self.assertEqual(errors, ['interaction_cancelled'])
            self.assertEqual(service.live, {})
        finally:
            service.close(); worker.join(1)


class HarnessPermissionDangerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = RunStore(Path(self.tmp.name) / 'runs.sqlite')
        self.addCleanup(self.tmp.cleanup); self.addCleanup(self.store.close)

    def card(self, run_id, request):
        """The approval row the harness permission request opened, as it read while pending."""
        from types import MethodType, SimpleNamespace
        from character_agent.integration import CharacterAgentController
        rows = []
        service = InteractionService(self.store, emit=lambda e: rows.append(service.get(e['request_id'])), wait_seconds=0)
        self.addCleanup(service.close)
        controller = SimpleNamespace(store=self.store, interactions=service, semantic=SimpleNamespace(reply=lambda: None))
        self.store.begin(run_id, 'c' * 32, 'aster', 1)
        MethodType(CharacterAgentController._harness_permission, controller)(
            {'run_id': run_id, 'options': [{'option_id': 'allow-once', 'kind': 'allow_once'}], **request}, 'claude', 'Claude Code')
        [row] = [r for r in rows if r and r['state'] == 'pending']
        return row['data']

    def test_a_dangerous_command_is_marked_with_its_rule_and_a_file_read_is_not(self):
        for name, request, expected in (
                ('claude rm', {'title': 'Bash: rm -rf build', 'kind': None, 'locations': None,
                               'raw_input': {'command': 'rm -rf build'}}, (True, 'rm_recursive')),
                ('acp execute', {'title': '`rm -rf ~/x`', 'kind': 'execute', 'locations': None,
                                 'raw_input': {'command': 'rm -rf ~/x'}}, (True, 'rm_recursive')),
                ('claude read', {'title': 'Read', 'kind': None, 'locations': ['/Users/me/notes.md'],
                                 'raw_input': {'file_path': '/Users/me/notes.md'}}, (False, None)),
                ('acp read', {'title': 'Read notes.md', 'kind': 'read', 'locations': ['/Users/me/notes.md'],
                              'raw_input': {'path': '/Users/me/notes.md'}}, (False, None))):
            with self.subTest(name):
                data = self.card(name, request)
                self.assertEqual((data['dangerous'], data['danger_rule']), expected)

    def test_the_stored_preview_masks_a_secret_in_the_command(self):
        command = 'curl -H "Authorization: Bearer sk-test-1234567890abcdefghij" https://example.test'
        data = self.card('secret', {'title': 'Bash: ' + command, 'kind': None, 'locations': None,
                                    'raw_input': {'command': command}})
        stored = ' '.join(str(row[0]) for row in self.store.db.execute('SELECT data FROM character_interactions'))
        self.assertNotIn('sk-test-1234567890', stored)
        self.assertIn('[已遮蔽:密钥]', data['preview']['raw_input']['command'])


class Model:
    def __init__(self):
        self.calls = 0

    def choose(self, _):
        self.calls += 1
        return {"activity": "relax", "mood": "normal", "walk": "normal"}


class PresetTest(unittest.TestCase):
    def test_closed_cli_choices_default_and_immutable_parameters(self):
        self.assertEqual(parse_args([]).interaction_preset, "balanced")
        for name in PRESETS:
            self.assertEqual(parse_args(["--interaction-preset", name]).interaction_preset, name)
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            parse_args(["--interaction-preset", "unlimited"])
        with self.assertRaises(ValueError):
            preset("unlimited")
        with self.assertRaises(TypeError):
            PRESETS["new"] = preset()
        self.assertEqual((preset().model_every, preset().model_refresh), (180, 900))

    def test_one_hour_stable_scene_model_calls_are_bounded_per_preset(self):
        for name, calls in (("quiet", 2), ("balanced", 4), ("active", 6)):
            with self.subTest(preset=name):
                now, model = [0.0], Model()
                situation = {"hour": 14, "focus_state": "idle", "pending": 0, "presence": "active",
                             "presence_s": 30, "category": "coding"}
                behavior = Behavior(lambda: dict(situation), lambda *_: None, backend=model,
                                    clock=lambda: now[0], interaction_preset=name)
                for t in range(0, 3600, 5):
                    now[0] = float(t)
                    behavior.tick()
                self.assertEqual(model.calls, calls)

    def test_changed_scene_still_respects_minimum_model_gap(self):
        for name in PRESETS:
            with self.subTest(preset=name):
                now, model = [100.0], Model()
                situation = {"hour": 14, "focus_state": "idle", "pending": 0, "presence": "active",
                             "presence_s": 30, "category": "coding"}
                behavior = Behavior(lambda: dict(situation), lambda *_: None, backend=model,
                                    clock=lambda: now[0], interaction_preset=name)
                behavior.tick()
                situation["category"] = "reading"
                now[0] += preset(name).model_every - .1
                behavior.tick()
                self.assertEqual(model.calls, 1)
                now[0] += .2
                behavior.tick()
                self.assertEqual(model.calls, 2)

    def test_quiet_blocks_background_speech_but_not_p0_and_active_keeps_hard_gates(self):
        noon = datetime.datetime(2026, 10, 21, 14)
        quiet = Gate(enabled=True, interaction_preset="quiet")
        self.assertEqual(quiet.admit("comment", "P2", noon), (False, "disabled"))
        self.assertEqual(quiet.admit("approval", "P0", noon), (True, None))
        active = Gate(enabled=True, interaction_preset="active")
        active.set_companion(True)
        self.assertEqual(active.same_cooldown, 300)
        for flag, reason in (("meeting", "meeting"), ("user_speaking", "user_speaking"), ("fullscreen", "fullscreen")):
            setattr(active, flag, True)
            self.assertEqual(active.check("comment", noon), reason)
            setattr(active, flag, False)
        self.assertEqual(active.admit("comment", "P2", noon), (True, None))
        self.assertEqual(active.check("comment", noon + datetime.timedelta(seconds=299)), "same_cooldown")
        self.assertIsNone(active.check("comment", noon + datetime.timedelta(seconds=300)))

    def test_presets_scale_autonomous_ticks_without_changing_local_listen_or_stop(self):
        for name in PRESETS:
            with self.subTest(preset=name):
                now = [100.0]
                situation = {"fullscreen": False, "user_speaking": True, "speaking": False, "voicing": False,
                             "line_id": None, "typing": False, "session": None, "state": "idle", "related": [],
                             "window_id": 1}
                registry = Registry(epoch=7)
                spatial = Spatial(lambda: dict(situation), registry.publish_event, lambda: 1, 7,
                                  clock=lambda: now[0], interaction_preset=name)
                spatial.begin()
                left = spatial._next_tick - now[0]
                self.assertGreaterEqual(left, 60 * preset(name).random_tick_scale)
                self.assertLessEqual(left, 120 * preset(name).random_tick_scale)
                spatial.poll()
                self.assertEqual([b["type"] for b in spatial.running()], ["listen"])
                spatial.cancel_all("character_switch")
                self.assertEqual(spatial.running(), [])

    def test_server_echoes_effective_preset_and_wires_spatial(self):
        server = AgentdServer(("127.0.0.1", 0), "hook", "ui", interaction_preset="active")
        try:
            self.assertEqual(server.spatial.interaction.name, "active")
            self.assertEqual(server.gate.same_cooldown, 300)
            block = server.diag_state()["interaction"]
            self.assertEqual(block["name"], "active")
            self.assertEqual(block["model_refresh"], 600)
            self.assertNotIn("max_tokens", block, "interaction frequency never raises model output allowance")
        finally:
            server.server_close()
