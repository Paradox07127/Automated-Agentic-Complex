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
                evidence=json.loads(prompt)['evidence']['segments']
                yield {'type':'result','success':True,'final_text':json.dumps({'hypotheses':[{
                    'task':'可能在编辑预算报告','goal':'核对数据','status':'working','next_step':'核对来源','confidence':.6,
                    'evidence':[evidence[0]['id']],'expires_in_seconds':1800}]}),'model':'fixture'}
            return FakeSession(script)
        self.controller=self.server.character_agent=CharacterAgentController(self.server,self.root,session_factory=factory)
        self.controller.settings.save({'backend':'codex','runtime_source':'local'})
        self.service=self.controller.task_understanding
        self.seed()

    def tearDown(self):
        super().tearDown()
        self.server.attention.close();self.controller.store.close();self.controller.workspace.close();self.db.close()

    def seed(self):
        now=time.time();epoch=self.server.consent.snapshot()[1]
        events=[{'id':i+1,'ts':now-400+i*15,'kind':'value','bundle_id':'example.editor','app':'Fixture',
                 'doc':'预算报告.md','edits':1,'input_near':1} for i in range(15)]
        self.assertEqual(self.service.ingest(events,authorized=True,consent_epoch=epoch)['accepted'],15)
        self.service.run_once()

    def test_api_corrects_with_revision_and_never_confirms_a_fact(self):
        code,body=self.request('GET','/task-understanding')
        self.assertEqual(code,200);self.assertEqual(body['character_id'],'aster')
        row=body['hypotheses'][0];path='/task-understanding/'+row['id']+'/correct'
        code,changed=self.request('POST',path,{'revision':1,'action':'correct','text':'其实是在准备会议材料'})
        self.assertEqual(code,200);self.assertEqual(changed['revision'],2)
        self.assertEqual(changed['authority'],'user_correction_of_hypothesis')
        self.assertEqual(self.request('POST',path,{'revision':1,'action':'reject'})[0],409)
        self.assertEqual(self.request('POST',path,{'revision':2,'action':'reject'})[0],200)
        self.assertEqual(self.request('GET','/task-understanding')[1]['hypotheses'],[])
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM facts').fetchone()[0],0)

    def test_epoch_revocation_and_role_switch_reject_stale_correction(self):
        # Else the tick thread can take the revocation and still be clearing when the GET returns.
        self.server._stopped.set();self.server._ticker.join(2)
        row=self.service.context()['hypotheses'][0];path='/task-understanding/'+row['id']+'/correct'
        self.server.character='birch'
        self.assertEqual(self.request('POST',path,{'revision':1,'action':'reject'})[0],409)
        self.server.character='aster';self.server.share_page_text=False
        code,body=self.request('GET','/task-understanding')
        self.assertEqual(code,200);self.assertFalse(body['available'])
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM task_hypotheses').fetchone()[0],0)
        self.assertEqual(self.request('POST',path,{'revision':1,'action':'reject'})[0],409)

    def test_a_segment_id_holding_a_phone_like_digit_run_reaches_the_model_intact(self):
        self.service.clear()
        opaque=SimpleNamespace(uuid4=lambda:uuid.UUID(hex='a13812345678b'+'c'*19))
        with patch('character_agent.services.task_understanding.uuid',opaque):self.seed()
        [row]=self.request('GET','/task-understanding')[1]['hypotheses']
        self.assertEqual(row['evidence'],['seg-a13812345678b'+'c'*19])

    def test_blacklist_and_clear_remove_derived_context_and_emit_reload(self):
        code,body=self.request('POST','/blacklist',{'field':'app_names','value':'Fixture','delete_existing':True})
        self.assertEqual(code,200,body)
        self.assertEqual(self.request('GET','/task-understanding')[1]['hypotheses'],[])
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM task_segments').fetchone()[0],0)
        self.assertTrue(any(event['event']=='task_understanding' and event['data'].get('action')=='deleted'
                            for event in self.server.feed.since(0)))

    def test_allow_list_removal_and_mode_switch_remove_derived_context(self):
        observations=self.controller.observations
        count=lambda db,table:db.execute('SELECT COUNT(*) FROM '+table).fetchone()[0]  # noqa: E731
        derived=lambda:(count(self.db,'task_hypotheses'),count(observations.db,'observation_frames'))  # noqa: E731
        def fill():
            if not count(self.db,'task_hypotheses'):self.seed()
            with observations.lock:
                observations.db.execute('INSERT INTO observation_frames VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                                        (uuid.uuid4().hex,'aster',time.time(),'fixture','k','1',0,'[]','{}','h',None))
                observations.db.commit()
            self.assertTrue(all(derived()))
        allow={'list':'allow','field':'bundle_ids','value':'example.editor'}
        self.assertEqual(self.request('POST','/blacklist',allow)[0],200)
        fill()
        self.assertEqual(self.request('DELETE','/blacklist',allow),(200,{'removed':True}))
        self.assertEqual(derived(),(0,0))
        fill()
        self.assertEqual(self.request('POST','/blacklist/mode',{'mode':'allow'}),(200,{'mode':'allow'}))
        self.assertEqual(derived(),(0,0))


if __name__=='__main__':unittest.main()
