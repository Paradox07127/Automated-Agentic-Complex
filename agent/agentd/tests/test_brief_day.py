from datetime import date, datetime, timedelta
import json
from pathlib import Path
import re
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import support
from api.handler import Handler
from daemon.character_switch import CharacterSwitchMixin
from character.desk_log import DeskLog
from character.proactive_log import ProactiveLog
from infra import plugins
from infra.store import open_store
from observation.attention import AttentionStore
from observation.blacklist import Blacklist
from personal.history import History
from personal.memory import Memory
from sessions.registry import Registry
from traces.trace_store import TraceStore, new_trace_id
from voice.speech import SAMPLE_RATE


class BriefDayTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1])
        self.addCleanup(tmp.cleanup)
        root = self.tmp_root = Path(tmp.name)
        self.day = date(2026, 11, 20)
        self.start = datetime.combine(self.day, datetime.min.time()).timestamp()
        self.now = self.start + 12 * 3600
        self.db = open_store(root / 'agentd.sqlite')
        self.addCleanup(self.db.close)
        self.permissions = dict.fromkeys(('window_text', 'page_text', 'screenshots', 'agent_sessions'), False)
        self.server = SimpleNamespace(
            clock=lambda: self.now, character='aster', memory=Memory(self.db),
            consent=SimpleNamespace(snapshot=lambda: (self.permissions, 0)), muted=False,
            observation_paused=lambda: False, character_voice_enabled=True, speech=None, character_agent=None, registry=Registry(),
            attention=None, spatial=SimpleNamespace(running=lambda: []), _pauses=[], _meetings=[],
            characters=SimpleNamespace(package=lambda cid: SimpleNamespace(root=root / 'no-package')))
        self.switches = patch.dict(plugins.resolved, dict.fromkeys(plugins.DEFAULTS, False))
        self.switches.start()
        self.addCleanup(self.switches.stop)
        self.at = self.now
        self.history = History(self.db, clock=lambda: self.at)
        self.log = ProactiveLog(self.db)
        self.trace = TraceStore(self.db, 1, clock=lambda: self.at, retention=lambda: None)
        self.desk = self.server.desk = DeskLog(self.db, clock=lambda: self.at)
        self.attention = AttentionStore(root / 'attention.sqlite', Blacklist(support.deny_blacklist(root / 'blacklist.json')))
        self.addCleanup(self.attention.close)
        self.server.attention = self.attention
        self.handler = Handler.__new__(Handler)
        self.handler.server = self.server
        self.handler._json = lambda code, body: (code, body)
        self.sent = []
        self.handler.send_response = self.sent.append
        self.handler.send_header = lambda *_: None
        self.handler.end_headers = lambda: None

    def request(self, query):
        self.handler.path = '/brief/day?' + query
        return self.handler._brief_day_get()

    def brief(self):
        from personal.brief_day import brief_day
        return brief_day(self.server, self.day, self.now)

    def record(self, at, kind):
        self.at = at
        return self.handler._record({'kind': kind})

    def clock(self, hours, day=0):
        return self.start + day * 86400 + hours * 3600

    def turn(self, at, source='text', reply='Hello'):
        self.at = at
        self.history.record(turn_id=str(at), source=source, character_id='aster', persona_revision=None,
                            user_text='Hi', reply=reply, state='completed', started_at=at)

    def failed_turn(self, turn_id, at, source='text', code='timeout'):
        self.at = at
        trace_id = new_trace_id()
        self.trace.emit('input.received', trace_id, turn_id=turn_id, turn_generation=1, attrs={'source': source, 'text': None})
        self.trace.emit('turn.settled', trace_id, turn_id=turn_id, turn_generation=1, status='failed', duration_ms=5,
                        attrs={'state': 'failed', 'error_code': code, 'outcome': None})
        return trace_id

    def test_errors_list_exactly_what_err_counts_with_the_ids_to_open_each(self):
        from character_agent.services.interactions import InteractionService
        from character_agent.services.store import RunStore
        from sessions.events import normalize_claude
        plugins.resolved.update(personal_agent=True, coding_sessions=True)
        self.permissions['agent_sessions'] = True
        store = RunStore(Path(self.tmp_root) / 'runs.sqlite')
        self.addCleanup(store.close)
        InteractionService(store)
        self.server.character_agent = SimpleNamespace(store=store, workspace=None)
        at = self.clock(1)
        self.db.execute("INSERT INTO tasks(task_id,target,cwd,title,mode,state,created_at,updated_at,result_json)"
                        " VALUES('t1','character','/w','整理报告','work','failed',?,?,?)",
                        (at, at, json.dumps({'reason': 'verify_failed', 'run_id': 'job-run'})))
        self.db.execute("INSERT INTO task_events VALUES('t1',1,'failed',?,NULL)", (at,))
        for run_id, task_id, ended in (('job-run', 't1', at + 60), ('turn-run', None, at + 120)):
            store.db.execute("INSERT INTO character_runs(run_id,conversation_id,character_id,generation,state,task_id,"
                             "result,started_at,ended_at) VALUES(?,'c','aster',1,'failed',?,?,?,?)",
                             (run_id, task_id, json.dumps({'error': 'timeout'}), ended - 30, ended))
        job_trace = self.failed_turn('job-run', at + 61, 'background')
        turn_trace = self.failed_turn('turn-run', at + 121)
        quick_trace = self.failed_turn('quick-turn', self.clock(2), 'voice', 'select_model')
        self.failed_turn('old-turn', self.clock(2, -1))
        self.server.registry.ingest(normalize_claude({'session_id': 's1', 'hook_event_name': 'StopFailure'}, now=self.now))
        body = self.brief()
        self.assertTrue(body['items']['err']['enabled'])
        self.assertEqual(body['items']['err']['today'], len(body['errors']))
        self.assertEqual(body['items']['err']['yesterday'], 1)
        self.assertEqual(body['errors'], [
            {'kind': 'task', 'id': 't1', 'at': at, 'title': '整理报告', 'reason': 'verify_failed', 'task_id': 't1',
             'run_id': 'job-run', 'turn_id': None, 'trace_id': None, 'session_id': None},
            {'kind': 'run', 'id': 'job-run', 'at': at + 60, 'title': '整理报告', 'reason': 'timeout', 'task_id': 't1',
             'run_id': 'job-run', 'turn_id': None, 'trace_id': job_trace, 'session_id': None},
            {'kind': 'turn', 'id': 'turn-run', 'at': at + 121, 'title': None, 'reason': 'timeout', 'task_id': None,
             'run_id': 'turn-run', 'turn_id': 'turn-run', 'trace_id': turn_trace, 'session_id': None},
            {'kind': 'turn', 'id': 'quick-turn', 'at': self.clock(2), 'title': None, 'reason': 'select_model',
             'task_id': None, 'run_id': None, 'turn_id': 'quick-turn', 'trace_id': quick_trace, 'session_id': None},
            {'kind': 'session', 'id': 'claude:s1', 'at': self.now, 'title': None, 'reason': 'error', 'task_id': None,
             'run_id': None, 'turn_id': None, 'trace_id': None, 'session_id': 'claude:s1'}])

    def test_a_failed_turn_counts_with_every_plugin_off(self):
        trace_id = self.failed_turn('t', self.clock(3))
        body = self.brief()
        self.assertEqual((body['items']['err']['today'], [e['trace_id'] for e in body['errors']]), (1, [trace_id]))

    def test_invalid_date(self):
        for query in ('', 'date=', 'date=20261120', 'date=2026-02-30', 'date=2026-1-20'):
            with self.subTest(query=query):
                self.assertEqual(self.request(query), (400, {'error': 'invalid_date'}))

    def test_local_date_range(self):
        for delta in (-7, 1):
            self.assertEqual(self.request('date=' + str(self.day + timedelta(days=delta))),
                             (400, {'error': 'date_out_of_range'}))
        code, result = self.request('date=' + str(self.day - timedelta(days=6)))
        self.assertEqual(code, 200)
        self.assertFalse(result['partial'])

    def test_today(self):
        self.turn(self.now, reply='latest reply')
        self.turn(self.now + 3600)
        self.turn(self.start, 'tap')
        self.turn(self.start, 'proactive')
        for n, channel in enumerate(('line', 'line', 'line', 'thought')):
            self.log.shown(str(n), channel, 'break', None, str(n), None, None, self.start + n)
        self.log.said('thanks', {'kind': 'line', 'id': '1'}, self.start + 4)
        self.at = self.start + 2 * 3600
        self.trace.emit('motion.started', new_trace_id(), attrs={'clip': 'wave', 'behavior_id': None})
        code, body = self.request('date=' + str(self.day))
        self.assertEqual(code, 200)
        self.assertTrue(body['partial'])
        self.assertEqual(body['items']['turn']['today'], 1)
        self.assertEqual(body['items']['say']['today'], 3)
        self.assertEqual(body['items']['motion']['hours'], [0, 0, 1] + [0] * 21)
        self.assertEqual(body['her']['said'], {'total': 5, 'self': 3, 'replied': 1})
        self.assertEqual([(line['kind'], line['text']) for line in body['her']['lines']],
                         [('self', '1'), ('reply', 'latest reply'), ('miss', '2')])
        self.assertEqual(body['her']['motions'][0]['key'], 'wave')

    def test_motion_and_reason_labels(self):
        animation = self.tmp_root / 'pack/runtime/characters/aster/c7/animation'
        animation.mkdir(parents=True)
        (animation / 'actions.json').write_text(json.dumps({'actions': [
            {'id': 'wave_a', 'name': '挥手', 'clips': ['A_clip_aster_wave']},
            {'id': 'nod_a', 'clips': ['A_clip_aster_nod']}]}), encoding='utf-8')
        self.server.characters = SimpleNamespace(package=lambda cid: SimpleNamespace(root=self.tmp_root / 'pack'))
        self.at = self.start + 3600
        for clip in ('A_clip_aster_wave', 'A_clip_aster_wave', 'wave_a', 'A_clip_aster_nod', 'A_clip_other'):
            self.trace.emit('motion.started', new_trace_id(), attrs={'clip': clip, 'behavior_id': None})
        for n, trigger in enumerate(('break', 'break', 'dispatch_review', 'later_kind')):
            self.log.shown(str(n), 'line', trigger, None, str(n), None, None, self.start + n)
        her = self.brief()['her']
        self.assertEqual([(m['key'], m['label']) for m in her['motions']], [
            ('A_clip_aster_wave', '挥手'), ('wave_a', '挥手'), ('A_clip_aster_nod', 'A_clip_aster_nod'),
            ('A_clip_other', 'A_clip_other')])
        self.assertEqual([(w['key'], w['label']) for w in her['why']], [
            ('break', '休息提醒'), ('dispatch_review', '委派任务待复核'), ('later_kind', 'later_kind')])
        self.server.characters = SimpleNamespace(package=lambda cid: (_ for _ in ()).throw(ValueError(cid)))
        self.assertEqual(self.brief()['her']['motions'][0]['label'], 'A_clip_aster_wave')

    def test_previous_seven_days(self):
        for days, count in ((0, 8), (1, 2), (7, 5), (8, 9)):
            at = datetime.combine(self.day - timedelta(days=days), datetime.min.time()).timestamp()
            for _ in range(count):
                self.turn(at)
        items = self.brief()['items']
        self.assertEqual(items['turn']['avg7'], 1)
        self.assertEqual(items['turn']['yesterday'], 2)
        self.assertIsNone(items['say']['avg7'])
        self.assertIsNone(items['say']['yesterday'])

    def test_switches_block_source_reads(self):
        self.server.attention = self.server.character_agent = self.server.registry = object()
        reads = []
        self.db.set_trace_callback(reads.append)
        body = self.brief()
        self.assertFalse(body['items']['fg']['enabled'])
        self.assertFalse(body['items']['done']['enabled'])
        self.assertEqual(body['focus']['apps'], [])
        queries = ' '.join(reads)
        for table in ('task_events', 'capture_budget', 'own_sessions'):
            self.assertNotIn(table, queries)
        self.assertNotIn('speech.finished', queries)
        self.assertNotIn('egress.checked', queries)

    def test_contract_keys(self):
        body = self.brief()
        contract = (Path(__file__).resolve().parents[3] / 'web/src/pages/overview/briefDay.ts').read_text(encoding='utf-8')
        keys = re.search(r'export const ITEM_ORDER: BriefItemId\[\] = \[(.*?)\]', contract)[1]
        self.assertEqual(list(body['items']), re.findall(r"'(\w+)'", keys))
        self.assertEqual(set(body), {'date', 'partial', 'switches', 'items', 'focus', 'her', 'errors'})
        self.assertEqual(set(body['focus']), {'enabled', 'away_min', 'longest', 'pauses', 'apps', 'sites'})
        self.assertEqual(set(body['her']), {'said', 'lines', 'touch', 'why', 'motions', 'desk', 'tools', 'mood', 'on_desk_min'})
        self.assertEqual(set(body['switches']), {'scr', 'read', 'shot', 'code', 'agent', 'voice'})
        for key, item in body['items'].items():
            self.assertEqual(set(item), {'today', 'hours', 'avg7', 'yesterday', 'enabled'})
            if key in ('mask', 'cost'):
                self.assertIsNone(item['hours'])
            else:
                self.assertEqual(item['hours'], [0] * 24)

    def test_focus_and_consent(self):
        plugins.resolved.update(screen_awareness=True, screen_reading=True)
        self.permissions['window_text'] = True
        t = self.start + 3590
        for bucket, offset, duration, data in (
                ('afk', 0, 70, {'status': 'not-afk'}), ('afk', 70, 60, {'status': 'afk'}),
                ('window', 0, 130, {'app': 'Chrome', 'bundle_id': 'com.google.Chrome'}),
                ('browser', 0, 130, {'url_host': 'example.org', 'visible': True, 'window_focused': True}),
                ('browser', 0, 130, {'url_host': 'private.org', 'incognito': True})):
            self.attention.db.execute('INSERT INTO events(bucket,start,duration,data) VALUES(?,?,?,?)',
                                      (bucket, t + offset, duration, json.dumps(data)))
        self.server._pauses = [[self.start - 10, self.start + 10]]
        body = self.brief()
        self.assertEqual(body['focus']['away_min'], 1)
        self.assertEqual(body['focus']['longest'], {'start': t, 'minutes': 70 / 60})
        self.assertEqual(body['focus']['apps'], [{'name': 'Chrome', 'minutes': 70 / 60}])
        self.assertEqual(body['focus']['pauses'], [[self.start, self.start + 10]])
        self.assertEqual(body['items']['fg']['hours'][:2], [10 / 60, 1])
        self.assertEqual(body['focus']['sites'], [])
        self.permissions['page_text'] = True
        self.assertEqual(self.brief()['focus']['sites'], [{'host': 'example.org', 'minutes': 70 / 60}])

    def test_an_app_blacklisted_since_is_not_in_the_focus(self):
        plugins.resolved.update(screen_awareness=True, screen_reading=True)
        t = self.start + 3600
        for bucket, offset, duration, data in (
                ('afk', 0, 120, {'status': 'not-afk'}),
                ('window', 0, 60, {'app': 'Notes', 'bundle_id': 'com.apple.Notes'}),
                ('window', 60, 60, {'app': 'Diary', 'bundle_id': 'x.diary'})):
            self.attention.db.execute('INSERT INTO events(bucket,start,duration,data) VALUES(?,?,?,?)',
                                      (bucket, t + offset, duration, json.dumps(data)))
        self.assertEqual([app['name'] for app in self.brief()['focus']['apps']], ['Notes', 'Diary'])  # control
        self.attention.blacklist.add('bundle_ids', 'x.diary')
        self.assertEqual(self.brief()['focus']['apps'], [{'name': 'Notes', 'minutes': 1}])

    def test_speech_cost_and_captures(self):
        self.at = self.now
        self.server.speech = object()
        self.permissions['screenshots'] = True
        self.trace.emit('speech.finished', new_trace_id(), producer='tts', duration_ms=2000,
                        attrs={'speech_id': 's', 'clause_id': None, 'total_samples': 2 * SAMPLE_RATE})
        self.trace.emit('egress.checked', new_trace_id(), attrs={'result': 'pass', 'category': None, 'redactions': 3})
        for state in ('released', 'sent', 'reserved'):
            self.db.execute('INSERT INTO capture_budget(request_id,state,look,reserved_at,settled_at) VALUES(?,?,0,?,?)',
                            (state, state, self.now, self.now))
        for model in ('a', 'b'):
            self.db.execute('INSERT INTO model_usage(day,model,call,calls,input_tokens,cache_creation_input_tokens,'
                            'cache_read_input_tokens,output_tokens,cost_usd) VALUES(?,?,?,1,1,0,0,1,0.25)',
                            (str(self.day), model, 'review'))
        for version in (1, 2):
            self.db.execute("INSERT INTO facts(fact_id,version,kind,source,evidence,recorded_at,state)"
                            " VALUES('f',?,'fact','confirmed_by_user','[]',?,'active')", (version, self.now))
        for state, at in (('cancelled', self.start), ('fulfilled', self.now), ('armed', self.now + 3600)):
            self.db.execute("INSERT INTO commitments(id,text,due_at,state,created_at,updated_at) VALUES(?, 'call',?,?,?,?)",
                            (state, at, state, self.start, self.now))
        items = self.brief()['items']
        self.assertEqual([items[k]['today'] for k in ('mem', 'rem')], [1, 1])
        self.assertEqual([items[k]['today'] for k in ('voice', 'mask', 'shot', 'cost')], [2, 3, 1, 0.5])

    def test_agent_and_coding_sources_are_independent(self):
        from character_agent.services.interactions import InteractionService
        from character_agent.services.store import RunStore
        from character_agent.services.workspace import WorkspaceService
        from sessions.events import normalize_claude
        self.permissions['agent_sessions'] = True
        plugins.resolved['coding_sessions'] = True
        self.server.registry.ingest(normalize_claude({'session_id': 's1', 'hook_event_name': 'StopFailure'}, now=self.now))
        self.db.execute("INSERT INTO task_events VALUES('t',1,'succeeded',?,NULL)", (self.now,))
        items = self.brief()['items']
        self.assertEqual([items[k]['today'] for k in ('code', 'err', 'done')], [1, 1, 0])
        plugins.resolved.update(coding_sessions=False, personal_agent=True)
        store = RunStore(Path(self.tmp_root) / 'runs.sqlite')
        self.addCleanup(store.close)
        InteractionService(store)
        workspace = WorkspaceService(self.tmp_root / 'workspace', clock=lambda: self.now)
        self.addCleanup(workspace.close)
        self.server.character_agent = SimpleNamespace(store=store, workspace=workspace)
        scope = workspace.create_scope([self.tmp_root])
        workspace.write_artifact(scope['scope_id'], 'r', 'report.txt', 'saved', effect_id='r:c2')
        store.db.execute("INSERT INTO character_run_events VALUES('r',2,'tool_finished',?,?)",
                         (json.dumps({'tool': 'artifact_write', 'tool_call_id': 'c2'}), self.now))
        store.db.execute("INSERT INTO character_interactions(request_id,run_id,kind,state,revision,created_at,expires_at)"
                         " VALUES('q','r','approval','approved',1,?,?)", (self.now, self.now + 60))
        store.db.execute("INSERT INTO character_runs(run_id,conversation_id,character_id,generation,state,started_at,ended_at)"
                         " VALUES('r','c','aster',1,'completed',?,?)", (self.now - 120, self.now))
        store.db.execute("INSERT INTO character_run_events VALUES('r',1,'tool_started',?,?)",
                         (json.dumps({'tool': 'artifact_read', 'tool_call_id': 'c1'}), self.now))
        result = self.brief()
        self.assertEqual([result['items'][k]['today'] for k in ('done', 'err', 'code')], [2, 0, 0])
        self.assertEqual(result['her']['tools']['run_minutes'], 2)
        self.assertEqual(result['her']['tools']['files_changed'], 1)
        self.assertEqual(result['her']['tools']['asked'], 1)
        self.assertEqual(result['her']['tools']['by_name'], [
            {'key': 'artifact_read', 'label': 'artifact_read', 'count': 1}])

    def test_desk_receipts_and_mood(self):
        for phase, delta, reason in (('running', -60, None), ('cancelled', 120, 'give_way')):
            self.at = self.start + delta
            self.trace.emit('behavior.receipt', new_trace_id(),
                            attrs={'behavior_id': 'seat', 'behavior_type': 'climb_window_top',
                                   'phase': phase, 'reason': reason})
        for offset, character in ((6, 'aster'), (4, 'aster'), (8, 'birch')):
            self.db.execute('INSERT INTO character_state_log(character_id,at,energy,valence) VALUES(?,?,.8,.5)',
                            (character, self.start + offset))
        her = self.brief()['her']
        desk = {row['key']: row for row in her['desk']}
        self.assertEqual(desk['window_top']['minutes'], 2)
        self.assertEqual(desk['give_way']['count'], 1)
        code, previous = self.request('date=' + str(self.day - timedelta(days=1)))
        self.assertEqual(code, 200)
        self.assertEqual(previous['her']['desk'], [
            {'key': 'window_top', 'label': '停靠窗口顶部', 'count': 1, 'minutes': 1}])
        self.assertEqual(her['mood'], [[self.start + i, 0.8, 0.5] for i in (4, 6)])

    def test_forwarded_touches_and_greetings_count_on_their_day_and_hour(self):
        for kind in ('pat', 'pat', 'pinch', 'drag', 'wheel', 'greet'):
            self.assertIsNone(self.record(self.clock(9.5), kind))
        for kind in ('pat', 'greet'):
            self.record(self.clock(20, day=-1), kind)
        self.record(self.clock(1, day=1), 'wheel')
        self.assertEqual(self.sent, [204] * 9)
        body = self.brief()
        self.assertEqual(body['her']['touch'], {'pat': 2, 'pinch': 1, 'drag': 1, 'wheel': 1})
        touch = body['items']['touch']
        self.assertEqual((touch['today'], touch['hours'][9], sum(touch['hours'])), (5, 5, 5))
        self.assertEqual((touch['yesterday'], touch['avg7']), (1, 1 / 7))
        self.assertEqual(body['her']['desk'], [{'key': 'greet', 'label': '欢迎交互', 'count': 1, 'minutes': None}])
        _, previous = self.request('date=' + str(self.day - timedelta(days=1)))
        self.assertEqual(previous['her']['touch'], {'pat': 1, 'pinch': 0, 'drag': 0, 'wheel': 0})
        self.assertEqual(previous['items']['touch']['hours'][20], 1)
        self.assertEqual(previous['her']['desk'], [{'key': 'greet', 'label': '欢迎交互', 'count': 1, 'minutes': None}])

    def test_a_bad_record_body_is_400_and_records_nothing(self):
        for body in (None, [], {}, {'kind': 'poke'}, {'kind': 'pat', 'at': 1}, {'kind': ['pat']}):
            with self.subTest(body=body):
                self.assertEqual(self.handler._record(body), (400, {'error': 'invalid_payload'}))
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM desk_log').fetchone()[0], 0)
        self.server.desk = None
        self.assertEqual(self.handler._record({'kind': 'pat'}), (503, {'error': 'no_desk_log'}))

    def test_on_desk_minutes_are_the_visible_minutes_of_the_day(self):
        self.assertIsNone(self.brief()['her']['on_desk_min'])
        shell = SimpleNamespace(avatar={'visible': True, 'reason': None, 'since': ''}, clock=lambda: self.at, _voiced=None,
                                desk=self.desk)
        for hours, visible in ((-2, True), (-1, False), (9, True), (10, True), (11.5, False), (11.75, False)):
            self.at = self.clock(hours)
            CharacterSwitchMixin.set_avatar(shell, visible, 'user')
        self.at = self.now
        self.assertEqual(self.brief()['her']['on_desk_min'], 150)
        _, previous = self.request('date=' + str(self.day - timedelta(days=1)))
        self.assertEqual(previous['her']['on_desk_min'], 60)

    def test_a_running_span_counts_to_now(self):
        self.at = self.clock(11)
        self.desk.span('visible', True)
        self.at = self.now
        self.assertEqual(self.brief()['her']['on_desk_min'], 60)

    def test_an_edge_parking_is_an_edge_row(self):
        for hours, on in ((10, True), (10 + 1 / 3, False)):
            self.at = self.clock(hours)
            self.desk.span('edge', on)
        self.at = self.now
        self.assertEqual(self.brief()['her']['desk'], [{'key': 'edge', 'label': '停靠屏幕边缘', 'count': 1, 'minutes': 20}])

    def test_a_drag_that_cancels_a_behavior_counts_once(self):
        self.record(self.clock(9), 'drag')
        self.trace.emit('behavior.receipt', new_trace_id(), attrs={'behavior_id': 'walk', 'behavior_type': 'short_walk',
                                                                   'phase': 'cancelled', 'reason': 'user_drag'})
        self.trace.emit('input.received', new_trace_id(), attrs={'source': 'tap'}, texts={'text': 'hi'})
        body = self.brief()
        self.assertEqual(body['her']['touch']['drag'], 1)
        self.assertEqual(body['items']['touch']['today'], 1)

