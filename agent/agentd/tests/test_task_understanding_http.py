"""Real localhost HTTP, persisted hypotheses and live product privacy/role fences."""
import json
from pathlib import Path
import sys
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from observation.attention import AttentionStore
from observation.blacklist import Blacklist
from support import deny_blacklist
from brain.egress import EgressPolicy
from character_agent.integration import CharacterAgentController
from personal.history import History
from personal.memory import Memory
from infra.store import open_store
import test_server
from test_character_agent_runtime import FakeSession


class TaskHTTPTests(test_server.FeedServerCase):
    request=test_server.SayTest.request

    def setUp(self):
        super().setUp()
        self.root=Path(self.tmp.name)/'tasks';self.root.mkdir()
        self.db=open_store(self.root/'domain.sqlite');lock=threading.RLock()
        self.server.memory=Memory(self.db,lock=lock);self.server.history=History(self.db,lock=lock)
        self.server.egress=EgressPolicy();self.server.share_page_text=True;self.server.share_typed_text=True
        self.server.attention=AttentionStore(self.root/'attention.sqlite',Blacklist(deny_blacklist(self.root/'blacklist.json')))
        def factory(definitions):
            def script(session,prompt,options):
                obs=json.loads(prompt)['evidence']['observations'][0]
                obs_id=obs.get('observation_id') or obs['id']
                yield {'type':'result','success':True,'final_text':json.dumps({
                    'observed_facts':[],'work_events':[],
                    'task_updates':[{'task_key':'budget-report','title':'可能在编辑预算报告','objective':'核对数据',
                        'current_step':'核对来源','state':'working','confidence':.6,'unresolved':[],'next_steps':['核对来源'],
                        'evidence':[{'observation_id':obs_id,'quote':'预算报告'}]}],
                    'uncertainties':[],'evidence_requests':[]}),'model':'fixture'}
            return FakeSession(script)
        self.controller=self.server.character_agent=CharacterAgentController(self.server,self.root,session_factory=factory)
        self.controller.settings.save({'backend':'codex','runtime_source':'local'})
        self.service=self.controller.observations
        self.seed()

    def tearDown(self):
        super().tearDown()
        self.server.attention.close();self.controller.store.close();self.controller.workspace.close();self.db.close()

    def seed(self):
        meta={'bundle_id':'example.editor','app':'Fixture','title':'预算报告.md','url_host':'docs.example'}
        self.assertTrue(self.service.ingest('browser','预算报告：需要核对数据来源',metadata=meta,source_key='browser:1:page'))
        self.assertEqual(self.service.run_once()['state'],'completed')

    def test_api_corrects_with_revision_and_never_confirms_a_fact(self):
        code,body=self.request('GET','/task-understanding')
        self.assertEqual(code,200);self.assertEqual(body['character_id'],'aster')
        row=body['hypotheses'][0];path='/task-understanding/'+row['id']+'/correct'
        code,changed=self.request('POST',path,{'revision':1,'action':'correct','text':'其实是在准备会议材料'})
        self.assertEqual(code,200);self.assertEqual(changed['revision'],2)
        self.assertEqual(self.request('GET','/task-understanding')[1]['hypotheses'][0]['authority'],'user_correction_of_hypothesis')
        self.assertEqual(self.request('POST',path,{'revision':1,'action':'reject'})[0],409)
        self.assertEqual(self.request('POST',path,{'revision':2,'action':'reject'})[0],200)
        self.assertEqual(self.request('GET','/task-understanding')[1]['hypotheses'],[])
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM facts').fetchone()[0],0)

    def test_epoch_revocation_and_role_switch_reject_stale_correction(self):
        # Else the tick thread can take the revocation and still be clearing when the GET returns.
        self.server._stopped.set();self.server._ticker.join(2)
        row=self.service.task_understanding_context()['hypotheses'][0];path='/task-understanding/'+row['id']+'/correct'
        self.server.character='birch'
        self.assertEqual(self.request('POST',path,{'revision':1,'action':'reject'})[0],409)
        self.server.character='aster';self.server.share_page_text=False;self.server.share_typed_text=False
        code,body=self.request('GET','/task-understanding')
        self.assertEqual(code,200);self.assertFalse(body['available'])
        self.assertEqual(self.request('POST',path,{'revision':1,'action':'reject'})[0],409)

    def test_blacklist_and_clear_remove_derived_context_and_emit_reload(self):
        code,body=self.request('POST','/blacklist',{'field':'app_names','value':'Fixture','delete_existing':True})
        self.assertEqual(code,200,body)
        self.assertEqual(self.request('GET','/task-understanding')[1]['hypotheses'],[])
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM observation_frames').fetchone()[0],0)
        self.assertTrue(any(event['event']=='task_understanding' and event['data'].get('action')=='deleted'
                            for event in self.server.feed.since(0)))

    def test_allow_list_removal_and_mode_switch_remove_derived_context(self):
        observations=self.controller.observations
        count=lambda db,table:db.execute('SELECT COUNT(*) FROM '+table).fetchone()[0]  # noqa: E731
        def fill():
            with observations.lock:
                observations.db.execute('INSERT INTO observation_frames VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                                        (uuid.uuid4().hex,'aster',time.time(),'fixture','k','1',0,'[]','{}','h',None))
                observations.db.commit()
            self.assertTrue(count(observations.db,'observation_frames'))
        allow={'list':'allow','field':'bundle_ids','value':'example.editor'}
        self.assertEqual(self.request('POST','/blacklist',allow)[0],200)
        fill()
        self.assertEqual(self.request('DELETE','/blacklist',allow),(200,{'removed':True}))
        self.assertEqual(count(observations.db,'observation_frames'),0)
        fill()
        self.assertEqual(self.request('POST','/blacklist/mode',{'mode':'allow'}),(200,{'mode':'allow'}))
        self.assertEqual(count(observations.db,'observation_frames'),0)


if __name__=='__main__':unittest.main()
