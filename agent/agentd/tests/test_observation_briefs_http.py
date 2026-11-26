"""Real HTTP routing, UI-token boundary and asynchronous report generation."""
import datetime as dt
import json
import os
from pathlib import Path
import sys
import threading
from unittest.mock import patch
from zoneinfo import ZoneInfo

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from brain.egress import EgressPolicy
from character_agent.integration import CharacterAgentController
from character_agent.services.observation_briefs import dump, window
from personal.episodes import Episodes
from personal.history import History
from personal.memory import Memory
from infra.store import open_store
from support import add_episode
import test_server
from test_character_agent_runtime import FakeSession


class BriefHTTPFixture(test_server.FeedServerCase):
    request = test_server.ServerTest.request

    def setUp(self):
        super().setUp()
        self.port=self.server.server_port
        self.root=Path(self.tmp.name)/'briefs'; self.root.mkdir()
        self.db=open_store(self.root/'domain.sqlite'); lock=threading.RLock()
        self.server.memory=Memory(self.db,lock=lock); self.server.history=History(self.db,lock=lock)
        self.server.episodes=Episodes(self.db,lock=lock); self.server.egress=EgressPolicy()
        self.server.share_page_text=True; self.server.share_typed_text=True
        self.started=threading.Event(); self.release=threading.Event()
        def factory(definitions):
            def script(session,prompt,options):
                source=json.loads(prompt)['evidence']['sources'][0]
                self.started.set(); self.release.wait(3)
                value={'observed_details':[{'detail':'出现测试失败线索','evidence':[{'source_id':source['source_id'],'quote':'渲染测试失败'}]}],
                       'recurring_problems':[],'next_steps':[],'unknowns':['结果待核验']}
                yield {'type':'result','success':True,'final_text':dump(value),'model':'fixture'}
            return FakeSession(script)
        self.c=self.server.character_agent=CharacterAgentController(self.server,self.root,session_factory=factory)
        self.c.settings.save({'backend':'codex','runtime_source':'local'})
        self.service=self.c.observation_briefs
        # The fixture's dates are New York's, and the brief's default timezone is the system's.
        system=patch.dict(os.environ,{'TZ':'America/New_York'}); system.start(); self.addCleanup(system.stop)
        self.service.clock=lambda:dt.datetime(2026,10,31,2,tzinfo=ZoneInfo('America/New_York')).timestamp()
        start=window('daily','2026-10-30','America/New_York')[1]+3600
        run='fixture-episode-run'
        self.db.execute("INSERT INTO memory_agent_runs(run_id,backend,model,character_id,started_at,state,prompt_version,input_sha256) VALUES(?,?,?,?,?,'completed','fixture','fixture')",
            (run,'codex','fixture',self.server.character,start))
        self.db.commit()
        self.episode_id=add_episode(self.server.episodes,start,start+120,'渲染测试失败','渲染测试失败，需要核验',run_id=run)

    def tearDown(self):
        self.release.set()
        self.service.worker_lock.acquire(timeout=5); self.service.worker_lock.release()
        super().tearDown()
        self.c.store.close();self.c.workspace.close();self.db.close()


class BriefHTTPTests(BriefHTTPFixture):
    def test_generate_responds_before_inference_and_can_be_polled_and_dismissed(self):
        code,queued=self.request('POST','/observation/briefs',{'period':'daily','date':'2026-10-30'})
        self.assertEqual(code,202,queued); self.assertTrue(self.started.wait(2))
        path='/observation/briefs/'+queued['id']
        self.assertEqual(self.request('GET',path)[1]['state'],'running')
        self.assertEqual(self.request('POST','/observation/briefs',{'date':'2026-10-30'})[0],409)
        self.release.set(); self.assertTrue(self.service.worker_lock.acquire(timeout=3)); self.service.worker_lock.release()
        self.assertEqual(self.request('GET',path)[1]['state'],'completed')
        self.assertEqual(len(self.request('GET','/observation/briefs')[1]['reports']),1)
        self.assertEqual(self.request('DELETE',path)[0],200)
        self.assertEqual(self.request('GET',path)[1]['state'],'dismissed')

    def test_ui_token_only_and_payload_settings_validation(self):
        for token in (test_server.HOOK,test_server.EVENTS,None):
            self.assertEqual(self.request('GET','/observation/briefs',token=token)[0],401)
            self.assertEqual(self.request('POST','/observation/briefs',{},token=token)[0],401)
        for body in ([],{'period':[]},{'period':'other'},{'date':3},{'date':'2026-11-01'}):
            self.assertEqual(self.request('POST','/observation/briefs',body)[0],400)
        self.assertEqual(self.request('POST','/observation/briefs/settings',{'enabled':False})[1]['enabled'],False)
        self.assertEqual(self.request('POST','/observation/briefs',{})[0],400)
        self.assertEqual(self.request('POST','/observation/briefs/settings',{'hour':True})[0],400)
        self.assertEqual(self.request('PUT','/observation/briefs',{})[0],404)  # undeclared method rejected by HTTP guard

    def test_source_delete_clears_persisted_report_without_any_memory_fact(self):
        self.release.set();self.service.run_once('daily','2026-10-30')
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM facts').fetchone()[0],0)
        self.db.execute('DELETE FROM episodes WHERE id=?', (self.episode_id,)); self.db.commit()
        self.assertEqual(self.request('GET','/observation/briefs')[1]['reports'],[])
        self.assertIsNone(self.db.execute('SELECT body FROM observation_briefs').fetchone()[0])

    def test_episode_edits_and_deletes_invalidate_only_the_briefs_that_read_the_episode(self):
        self.release.set()
        def episode(date):
            start=window('daily',date,'America/New_York')[1]+3600;run='run-'+date
            self.db.execute("INSERT INTO memory_agent_runs(run_id,backend,model,character_id,started_at,state,prompt_version,input_sha256) VALUES(?,?,?,?,?,'completed','fixture','fixture')",
                (run,'codex','fixture',self.server.character,start))
            self.db.commit()
            return add_episode(self.server.episodes,start,start+120,'渲染测试失败','渲染测试失败，需要核验',run_id=run)
        other,unread=episode('2026-10-29'),episode('2026-10-24')
        first,second=(self.service.run_once('daily',date)['id'] for date in ('2026-10-30','2026-10-29'))
        states=lambda:dict(self.db.execute('SELECT id,state FROM observation_briefs').fetchall())  # noqa: E731
        def edit(ident):
            self.server.episodes.edit(ident,'改过的标题','渲染测试失败，改过的描述')
            self.c.observation_briefs.forget_episodes([ident])
        edit(unread)
        self.assertEqual(states(),{first:'completed',second:'completed'})
        edit(self.episode_id)
        self.assertEqual(states(),{first:'invalidated',second:'completed'})
        self.assertEqual(self.request('DELETE',f'/episodes/{other}')[0],200)
        self.assertEqual(states(),{first:'invalidated',second:'invalidated'})
        self.assertIsNone(self.db.execute('SELECT body FROM observation_briefs WHERE id=?',(first,)).fetchone()[0])
        self.assertTrue(next(a for a in self.service.attempts() if a['id']==first)['can_retry'])
        self.assertEqual(self.request('POST','/observation/briefs',{'period':'daily','date':'2026-10-30','retry':True})[0],202)
        self.assertTrue(self.service.worker_lock.acquire(timeout=3)); self.service.worker_lock.release()
        self.assertEqual(states()[first],'completed')

    def test_evidence_of_a_trimmed_run_detail_is_expired(self):
        for detail in ({'request':''},{'request':'{'},{}):
            with self.subTest(detail=detail), patch.object(self.c,'memory_run_details',return_value={'detail':{**detail,'response':'x'}}):
                self.assertEqual(self.request('GET',f'/episodes/{self.episode_id}/evidence'),(410,{'error':'evidence_expired'}))
