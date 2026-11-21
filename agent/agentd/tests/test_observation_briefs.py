"""Product stores + selected adapter + evidence, lifecycle and budget boundaries."""
import datetime as dt
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from zoneinfo import ZoneInfo

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from character_agent.services.observation_briefs import INSTRUCTIONS, QUOTA_RETRY_WINDOW, ObservationBriefs, dump, window
from infra.data_lifecycle import DataLifecycle
import test_character_agent_semantic as semantic_fixture
from support import add_episode

# Every bridged harness config names the directory its own tools work in.
WORK = {"workspace_dir": tempfile.gettempdir(), "native_tools": True}


class BriefTests(unittest.TestCase):
    setUp = semantic_fixture.SemanticTests.setUp
    tearDown = semantic_fixture.SemanticTests.tearDown
    factory = semantic_fixture.SemanticTests.factory

    def test_prompt_summarizes_tasks_and_projects(self):
        self.assertIn('summarize by task and project', INSTRUCTIONS)
        self.assertNotIn('development details', INSTRUCTIONS)
        self.assertIn('maxLength',INSTRUCTIONS)
        self.assertIn('additionalProperties',INSTRUCTIONS)

    def test_invalid_shape_repairs_once_with_shared_limits_and_accounts_for_both_outputs(self):
        self.ready(); self.segment()
        from test_character_agent_runtime import FakeSession
        configs = []
        def factory(tools, config, **kwargs):
            configs.append({**config, **kwargs})
            value = {'observed_details':[]} if len(configs)==1 else self.findings()
            return FakeSession(lambda *args: iter([{'type':'result','success':True,'final_text':dump(value),
                'model':'fixture-model','usage':{'input_tokens':100,'output_tokens':20},'cost_usd':.01}]))
        with patch.object(self.c,'_session_factory',side_effect=factory): report = self.service.run_once('daily','2026-10-30')
        self.assertEqual(report['state'],'completed')
        self.assertEqual(len(configs),2)
        self.assertEqual([c['native_tools'] for c in configs],[False,False])
        self.assertEqual(self.db.execute('SELECT outcome FROM semantic_attempts').fetchall(),[('succeeded',)])
        self.assertAlmostEqual(self.c.semantic.usage.today()['cost_usd'],.02)
        self.assertIn('output_validation',json.dumps(self.c.memory_journal.get(report['run_id'])['detail']))

    def test_failure_path_is_persisted_and_manual_retry_does_not_change_automatic_or_usage_limits(self):
        self.ready(); self.segment(); self.reply=self.findings()
        self.reply['observed_details'][0]['detail']='x'*601
        with self.assertRaisesRegex(ValueError,'invalid_brief_shape'): self.service.run_once('daily','2026-10-30')
        [attempt] = self.service.attempts()
        self.assertEqual(attempt['validation_path'],'observed_details[0].detail')
        self.assertEqual(attempt['error_code'],'invalid_brief_shape')
        self.assertTrue(attempt['automatic_retry']); self.assertEqual(attempt['retry_at'],self.now+3600)
        self.assertEqual(self.service.list(),[])
        self.reply=self.findings()
        self.assertEqual(self.service._run_once('daily','2026-10-30',manual_retry=True)['state'],'completed')
        self.assertIsNone(self.service.attempts()[0]['error_code'])
        self.service.clear()
        self.assertFalse(self.db.execute('SELECT * FROM observation_brief_failures').fetchall())

    @unittest.skipIf(sys.platform == "win32", "the test keeps an SQLite file open while deleting or replacing it, which Windows refuses (WinError 32)")
    def test_failed_semantic_attempt_never_exposes_a_brief_without_its_error_code(self):
        from test_character_agent_runtime import FakeSession
        self.ready(); self.segment()
        def factory(definitions):
            return FakeSession(lambda *_: iter([{'type':'error','code':'network'}]))
        self.c.session_factory_override = factory
        observer = sqlite3.connect(self.root / 'domain.sqlite')
        self.addCleanup(observer.close)
        visible = []
        def snapshot():
            return observer.execute("SELECT f.code FROM observation_briefs b LEFT JOIN observation_brief_failures f "
                "ON f.brief_id=b.id WHERE b.state='failed'").fetchall()
        self.db.set_trace_callback(lambda sql: visible.extend(snapshot()) if sql == 'COMMIT' else None)
        try:
            with self.assertRaisesRegex(ValueError,'network'): self.service.run_once('daily','2026-10-30')
        finally:
            self.db.set_trace_callback(None)
        self.assertEqual(self.db.execute('SELECT purpose,outcome FROM semantic_attempts').fetchall(),
                         [('observation_brief','failed')])
        self.assertEqual(self.db.execute('SELECT code FROM observation_brief_failures').fetchall(), [('network',)])
        visible.extend(snapshot())
        self.assertTrue(visible)
        self.assertTrue(all(code == 'network' for (code,) in visible), visible)

    def ready(self):
        self.server.share_page_text = True
        self.server.share_typed_text = True
        self.service = self.c.observation_briefs
        # The fixtures' dates are New York's, and the brief's default timezone is the system's.
        system = patch.dict(os.environ, {'TZ': 'America/New_York'}); system.start(); self.addCleanup(system.stop)
        self.now = dt.datetime(2026,10,31,14,tzinfo=ZoneInfo('America/New_York')).timestamp()
        self.service.clock = lambda:self.now
        return self.service

    def segment(self, ident='seg-one', offset=0, subject='渲染测试失败，需要核验实际帧率', *, date='2026-10-30'):
        start = window('daily',date,'America/New_York')[1]+3600+offset
        body = {'subject':subject,'start':start,'end':start+120,'edits':3,'errors':1,'questions':0,
                'source_refs':['attention:'+ident], 'consent_epoch':self.server.consent.snapshot()[1]}
        self.db.execute('INSERT INTO task_segments VALUES(?,?,?,?,?)',(ident,self.server.character,start,start+120,dump(body)))
        self.db.commit()
        return 'segment:'+ident

    def findings(self, source='segment:seg-one'):
        ref = {'source_id':source,'quote':'渲染测试失败'}
        return {'observed_details':[{'detail':'出现一次渲染测试失败线索，结果待核验','evidence':[ref]}],
                'recurring_problems':[], 'next_steps':[{'action':'核对渲染测试与实际帧率','reason':'样本中记录了测试失败','evidence':[ref]}],
                'unknowns':['仅覆盖已保留的有限片段']}

    def generate(self):
        self.reply = self.findings()
        return self.service.run_once('daily','2026-10-30')

    def test_selected_harness_journal_usage_and_read_only_knowledge(self):
        self.ready(); self.segment()
        configs = []
        original = self.c._session_factory
        def factory(tools, config, **kwargs):
            configs.append({**config, **kwargs})
            return original(tools,config,**kwargs)
        with patch.object(self.c,'_session_factory',side_effect=factory): report = self.generate()
        self.assertEqual(report['backend'],'codex')
        self.assertEqual(report['authority'],'observed_analysis')
        self.assertIs(configs[0]['native_tools'],False)
        self.assertEqual(configs[0]['_semantic_effort'],'medium')
        self.assertEqual(self.db.execute('SELECT purpose,outcome FROM semantic_attempts').fetchall(),[('observation_brief','succeeded')])
        self.assertIn('observation_brief',self.c.memory_journal.get(report['run_id'])['detail']['request'])
        self.assertFalse(self.server.memory.active())
        self.assertFalse({'memory_propose','background_start','workspace_write'}.intersection(t['name'] for t in self.definitions[0]))
        knowledge = self.c.knowledge()
        result = knowledge.call('knowledge_search',{'sources':['briefs'],'query':'渲染'})
        self.assertEqual(result['items'][0]['id'],report['id'])
        self.assertTrue(knowledge.valid())
        self.db.execute("DELETE FROM task_segments WHERE id='seg-one'"); self.db.commit()
        self.assertFalse(knowledge.valid())
        self.assertIsNone(self.service.get(report['id']))
        self.assertIsNone(self.db.execute('SELECT body FROM observation_briefs').fetchone()[0])

    def test_same_period_is_cached_and_survives_service_restart(self):
        self.ready(); self.segment(); first = self.generate()
        self.c.observation_briefs = self.service = ObservationBriefs(self.c,clock=lambda:self.now)
        self.assertEqual(self.generate(),first)
        self.assertEqual(len(self.sessions),1)
        self.service.dismiss(first['id'])
        self.assertEqual(self.generate()['state'],'dismissed')
        self.assertEqual(len(self.sessions),1)

    def test_empty_day_costs_no_model_call(self):
        self.ready()
        self.assertEqual(self.generate()['state'],'empty')
        self.assertFalse(self.sessions)

    def test_bad_quote_or_single_instance_recurrence_is_rejected(self):
        self.ready(); self.segment(); self.reply = self.findings()
        self.reply['observed_details'][0]['evidence'][0]['quote']='不存在的证据'
        with self.assertRaisesRegex(ValueError,'invalid_brief_evidence'): self.service.run_once('daily','2026-10-30')
        self.assertEqual(self.service.list(),[])
        self.assertEqual(self.db.execute('SELECT state,body FROM observation_briefs').fetchone(),('failed',None))
        sources,_ = self.service.sources(*window('daily','2026-10-30','America/New_York')[1:],'America/New_York')
        value=self.findings(); value['recurring_problems']=[{'problem':'反复失败','optimization':'核对测试','evidence':value['observed_details'][0]['evidence']*2}]
        with self.assertRaisesRegex(ValueError,'unsupported_brief_recurrence'): self.service.validate(value,sources)

    def test_recurrence_requires_nonoverlapping_independent_sources(self):
        self.ready(); self.segment(); self.segment('seg-two',600)
        sources,_ = self.service.sources(*window('daily','2026-10-30','America/New_York')[1:],'America/New_York')
        value=self.findings(); value['recurring_problems']=[{'problem':'两个片段均有失败线索','optimization':'集中核对复现条件','evidence':[
            {'source_id':s['source_id'],'quote':'渲染测试失败'} for s in sources]}]
        self.service.validate(value,sources)
        sources[1]['units']=sources[0]['units']
        with self.assertRaisesRegex(ValueError,'unsupported_brief_recurrence'): self.service.validate(value,sources)

    def test_consent_change_or_configuration_change_in_flight_discards_result(self):
        for change in ('consent','configuration'):
            with self.subTest(change=change):
                self.ready(); self.segment('seg-'+change)
                self.reply=self.findings('segment:seg-'+change)
                self.during=(lambda:setattr(self.server,'share_page_text',False)) if change=='consent' else lambda:self.service.configure({'enabled':False})
                with self.assertRaises(ValueError): self.service.run_once('daily','2026-10-30')
                self.assertEqual(self.service.list(),[])
                self.during=lambda:None
                self.server.share_page_text=True; self.service.configure({'enabled':True}); self.service.clear()

    def test_source_edit_after_semantic_validation_cannot_commit(self):
        self.ready(); self.segment(); self.reply=self.findings()
        def mutate():
            self.db.execute("UPDATE task_segments SET body=replace(body,'渲染测试失败','修改过的材料')")
            self.db.commit()
        self.during=mutate
        with self.assertRaisesRegex(ValueError,'brief_sources_changed'): self.service.run_once('daily','2026-10-30')
        self.assertEqual(self.service.list(),[])

    def test_role_boundary_and_temporary_knowledge(self):
        self.ready(); self.segment(); report=self.generate()
        self.server.character='birch'
        self.assertIsNone(self.service.get(report['id']))
        self.assertEqual(self.service.list(),[])
        self.assertEqual(self.c.knowledge(temporary=True).call('knowledge_search',{'sources':['briefs']})['items'],[])
        self.server.character='aster'
        self.assertIsNotNone(self.service.get(report['id']))

    def test_caps_pause_no_recursive_analysis_and_bounded_sources(self):
        self.ready(); self.segment()
        for i in range(20): self.segment('seg-'+str(i),1000+i*200,subject='渲染测试失败'+'x'*4000)
        sources,coverage=self.service.sources(*window('daily','2026-10-30','America/New_York')[1:],'America/New_York')
        self.assertLessEqual(len(sources),4);self.assertLessEqual(len(dump(sources)),12000)
        self.server.memory.set_paused(True)
        self.assertEqual(self.generate()['state'],'disabled')
        self.assertFalse(self.sessions)
        self.server.memory.set_paused(False)
        meter=self.c.semantic.usage
        for _ in range(3): meter.attempt('observation_brief','admitted')
        with self.assertRaisesRegex(ValueError,'usage_cap'): self.service.run_once('daily','2026-10-30')
        self.assertFalse(self.sessions)

    def test_retry_is_persisted_and_not_driven_by_heartbeats(self):
        self.ready(); self.segment(); self.reply={}
        for _ in range(2):
            with self.assertRaises(ValueError): self.service.run_once('daily','2026-10-30')
            self.now+=3601
        self.assertEqual(self.service.run_once('daily','2026-10-30')['reason'],'brief_retry_limited')
        self.assertEqual(len(self.sessions),4)  # one bounded format repair per admitted run

    def test_quota_refusals_do_not_spend_retries_and_backlog_yields_to_current_period(self):
        self.ready(); self.segment(); self.segment('latest', date='2026-10-31')
        self.service.configure({'weekly': False})
        meter = self.c.semantic.usage
        meter.clock = lambda: self.now
        for _ in range(3):
            meter.attempt('observation_brief', 'admitted')
        for _ in range(2):
            with self.assertRaisesRegex(ValueError, 'usage_cap'):
                self.service.run_once('daily', '2026-10-30')
            self.now += 3601
        [old] = self.service.attempts()
        self.assertEqual((old['state'], old['attempts'], old['error_code']), ('failed', 0, 'usage_cap'))
        self.assertEqual(self.db.execute("SELECT counted FROM semantic_attempts WHERE outcome='usage_cap'").fetchall(), [(0,), (0,)])
        self.assertFalse(self.sessions)

        self.now += 86400
        self.service = ObservationBriefs(self.c, clock=lambda: self.now)
        self.assertTrue(self.service.status(old['id'])['automatic_retry'])
        for _ in range(2):
            meter.attempt('observation_brief', 'admitted')
        self.reply = self.findings('segment:latest')
        with patch('character_agent.services.observation_briefs.threading.Thread') as thread:
            self.service.tick()
            thread.call_args.kwargs['target']()
            self.now += 61
            thread.reset_mock()
            self.service.tick()
            thread.assert_not_called()
        self.assertEqual(self.service.list()[0]['date'], '2026-10-31')
        self.assertEqual(self.service.status(old['id'])['attempts'], 0)

        self.now += 86400
        self.reply = self.findings()
        with patch('character_agent.services.observation_briefs.threading.Thread') as thread:
            self.service.tick()
            thread.call_args.kwargs['target']()
        self.assertEqual(self.service.get(old['id'])['state'], 'completed')
        self.assertEqual(len(self.sessions), 2)

    def test_expired_quota_backlog_is_manual_only(self):
        self.ready(); self.segment(); self.service.configure({'weekly': False})
        with patch.object(self.c.semantic.usage, 'admit', return_value=False):
            with self.assertRaisesRegex(ValueError, 'usage_cap'):
                self.service.run_once('daily', '2026-10-30')
        [old] = self.service.attempts()
        self.now = old['end'] + QUOTA_RETRY_WINDOW + 12 * 3600
        status = self.service.status(old['id'])
        self.assertTrue(status['can_retry'])
        self.assertFalse(status['automatic_retry'])
        self.assertIsNone(status['retry_at'])
        with patch('character_agent.services.observation_briefs.threading.Thread') as thread:
            self.service.tick()
            thread.call_args.kwargs['target']()
        self.assertEqual(self.service.status(old['id'])['error_code'], 'usage_cap')
        self.assertFalse(self.sessions)
        self.reply = self.findings()
        self.assertEqual(self.service._run_once('daily', '2026-10-30', manual_retry=True)['state'], 'completed')

    def test_weekly_sampling_and_timezone_dst(self):
        self.ready()
        _,lo,hi=window('daily','2026-11-01','America/New_York')
        self.assertEqual(hi-lo,25*3600)
        _,lo,hi=window('daily','2026-03-08','America/New_York')
        self.assertEqual(hi-lo,23*3600)
        self.assertEqual(window('weekly','2026-10-30','America/New_York')[0],'2026-10-26')
        with self.assertRaisesRegex(ValueError,'brief_period_incomplete'): self.service.run_once('daily','2026-10-31')
        with self.assertRaises(ValueError): self.service.configure({'timezone':'bad/timezone'})

    @unittest.skipIf(sys.platform == "win32", "the test needs time.tzset")
    def test_default_timezone_is_the_system_local_one(self):
        old = os.environ.get('TZ')
        def restore():
            if old is None: os.environ.pop('TZ', None)
            else: os.environ['TZ'] = old
            time.tzset()
        self.addCleanup(restore)
        self.ready(); self.segment()
        os.environ['TZ'] = 'Asia/Shanghai'; time.tzset()
        # 08:30 on 2026-10-31 in Shanghai is 20:30 on 2026-10-30 in New York.
        self.now = dt.datetime(2026,10,31,8,30,tzinfo=ZoneInfo('Asia/Shanghai')).timestamp()
        with patch('character_agent.services.observation_briefs.threading.Thread') as thread:
            self.service.tick(); thread.assert_not_called()
        self.now += 3600; self.reply = self.findings()
        with patch('character_agent.services.observation_briefs.threading.Thread') as thread:
            self.service.tick()
            thread.call_args.kwargs['target']()
        [report] = self.service.list()
        self.assertEqual((report['date'], report['timezone']), ('2026-10-30', 'Asia/Shanghai'))
        self.assertEqual(self.service.configure({'hour': 9})['timezone'], 'Asia/Shanghai')
        self.assertIsNone(json.loads(self.service.memory.setting('observation_brief_settings'))['timezone'])

    def test_reported_token_admission_and_visible_output_limits(self):
        self.ready(); self.segment()
        meter=self.c.semantic.usage
        meter.record('fixture','observation_brief',SimpleNamespace(input_tokens=160000,output_tokens=0,
            cache_creation_input_tokens=0,cache_read_input_tokens=0))
        self.assertFalse(meter.admit('observation_brief'))
        # A separate purpose exercises the shared short-response ceiling.
        self.reply={'payload':'x'*17000}
        with self.assertRaisesRegex(ValueError,'semantic_output_limit'):
            self.c.semantic.run('task_hypothesis','返回JSON',{})

    def test_semantic_failure_retains_safe_provider_category(self):
        from test_character_agent_runtime import FakeSession
        def factory(definitions):
            def script(*_):
                yield {'type':'result','success':False,'error':'api_error','failure':{'code':'rate_limited','private':'secret'}}
            return FakeSession(script)
        self.c.session_factory_override=factory
        with self.assertRaisesRegex(ValueError,'rate_limited'): self.c.semantic.run('review','返回JSON',{})
        row=self.c.store.list()[0]
        self.assertEqual(row['result']['error'],'rate_limited')
        self.assertNotIn('secret',dump(row))

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_reasoning_policy_reaches_the_codex_wire(self):
        from character_agent.harness.codex_transport import CodexConfig
        from character_agent.harness.codex_runner import policy_settings
        self.assertEqual(CodexConfig(self.root,'fixture',cli_path='/synthetic/codex',effort='medium', **WORK).wire()['effort'],'medium')
        with self.assertRaisesRegex(ValueError,'invalid_reasoning_effort'):
            CodexConfig(self.root,'fixture',effort='invented', **WORK).validate(require_key=False)
        config={'model':'default','effort':'medium'}
        self.assertEqual(policy_settings(self.root,self.root/'catalog',config)['model_reasoning_effort'],'medium')
        self.assertNotIn('model_reasoning_effort',policy_settings(self.root,self.root/'catalog',{'model':'default'}))

    def test_last_source_check_is_atomic_with_report_commit(self):
        self.ready(); self.segment(); self.reply=self.findings()
        original=self.service._dependencies_valid
        def change_after_validation(deps):
            result=original(deps)
            self.db.execute("DELETE FROM task_segments WHERE id='seg-one'");self.db.commit()
            return result
        with patch.object(self.service,'_dependencies_valid',side_effect=change_after_validation):
            with self.assertRaisesRegex(ValueError,'brief_sources_changed'): self.service.run_once('daily','2026-10-30')
        self.assertEqual(self.service.list(),[])

    def test_weekly_report_reuses_authorized_episode_with_role_attribution(self):
        self.ready()
        run='fixture-episode-run'
        self.db.execute("INSERT INTO memory_agent_runs(run_id,backend,model,character_id,started_at,state,prompt_version,input_sha256) VALUES(?,?,?,?,?,'completed','fixture','fixture')",
            (run,'codex','fixture',self.server.character,self.now))
        start=window('daily','2026-10-23','America/New_York')[1]+3600
        ident=add_episode(self.server.episodes,start,start+120,'渲染测试失败','需要核验源座椅测试的实际帧率',run_id=run)
        self.reply=self.findings('episode:'+str(ident))
        report=self.service.run_once('weekly','2026-10-23')
        self.assertEqual(report['period'],'weekly');self.assertEqual(report['date'],'2026-10-19')
        self.server.episodes.edit(ident,'已更正','原失败结论已更正')
        self.assertIsNone(self.service.get(report['id']))

    def test_tick_only_schedules_finished_periods_and_skips_foreground(self):
        self.ready()
        with patch.object(self.c,'busy',return_value=True), patch('character_agent.services.observation_briefs.threading.Thread') as thread:
            self.service.tick(); thread.assert_not_called()

        self.now+=61
        with patch('character_agent.services.observation_briefs.threading.Thread') as thread:
            self.service.tick()
            work=thread.call_args.kwargs['target']
            self.assertTrue(self.service.worker_lock.locked())
            work()
            self.assertFalse(self.service.worker_lock.locked())
        self.now+=61
        with patch('character_agent.services.observation_briefs.threading.Thread') as thread:
            self.service.tick(); thread.assert_not_called()

    def test_accepted_request_has_a_durable_status_before_worker_starts(self):
        self.ready()
        with patch('character_agent.services.observation_briefs.threading.Thread') as thread:
            queued=self.service.request('daily','2026-10-30')
            self.assertEqual(self.service.status(queued['id'])['state'],'queued')
            work=thread.call_args.kwargs['target']
            self.service.configure({'enabled':False})
            work()
        self.assertEqual(self.service.status(queued['id'])['state'],'cancelled')

    def test_reset_retention_and_privacy_clear_report_data(self):
        self.ready(); self.segment(); report=self.generate()
        self.c.cancel('context_changed')
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM observation_briefs').fetchone()[0],0)
        self.generate(); self.now+=31*86400; self.service.prune()
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM observation_briefs').fetchone()[0],0)
        lifecycle=DataLifecycle([self.db])
        self.assertIn('observation_briefs',lifecycle.counts())

    def test_generation_works_with_nonrecursive_memory_lock(self):
        self.ready(); self.segment()
        self.server.memory.lock=self.service.lock=threading.Lock()
        self.assertEqual(self.generate()['state'],'completed')


if __name__=='__main__': unittest.main()
