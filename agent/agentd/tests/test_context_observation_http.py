"""Context inputs and deletions reach the character agent's observation store only as consent allows."""
import json
from pathlib import Path
import sys
import threading
import time
import unittest
from unittest.mock import Mock

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from observation.attention import AttentionStore
from observation.blacklist import Blacklist
from support import deny_blacklist
from brain.egress import EgressPolicy
from character_agent.integration import CharacterAgentController
from daemon.constants import SEEN
from personal.history import History
from personal.memory import Memory
from infra.store import open_store
import test_server
from test_character_agent_runtime import FakeSession


class ContextObservationHTTPTests(test_server.FeedServerCase):
    request=test_server.SayTest.request

    def setUp(self):
        super().setUp()
        self.root=Path(self.tmp.name)/'context';self.root.mkdir()
        self.db=open_store(self.root/'domain.sqlite');lock=threading.RLock()
        self.server.memory=Memory(self.db,lock=lock);self.server.history=History(self.db,lock=lock)
        self.server.egress=EgressPolicy();self.server.share_page_text=True;self.server.share_typed_text=True
        self.server.attention=AttentionStore(self.root/'attention.sqlite',Blacklist(deny_blacklist(self.root/'blacklist.json')))
        self.controller=self.server.character_agent=CharacterAgentController(
            self.server,self.root,session_factory=lambda definitions:FakeSession(lambda *args:iter(())))
        self.controller.settings.save({'backend':'codex','runtime_source':'local'})

    def tearDown(self):
        super().tearDown()
        self.server.attention.close();self.controller.store.close();self.controller.workspace.close();self.db.close()

    def count(self,table):
        return self.db.execute('SELECT COUNT(*) FROM '+table).fetchone()[0]

    def page(self,text='pw'):
        body={'type':'page','ts':time.time(),'url_host':'example.com','title':'Login','text':text,
              'browser_session':'s','tab_id':1}
        return self.request('POST','/context/browser',body,token=test_server.HOOK)

    def test_browser_text_is_kept_only_while_the_attention_store_admits_it(self):
        for flag in ('_secure','_locked_asleep'):
            with self.subTest(flag=flag):
                setattr(self.server.attention,flag,True)
                self.assertEqual(self.page()[0],200)
                self.assertEqual(self.count('observation_frames'),0)
                setattr(self.server.attention,flag,False)
        self.assertEqual(self.page()[0],200)
        self.assertEqual(self.count('observation_frames'),1)

    def test_attention_input_counts_go_without_the_sense_input_counts_switch(self):
        policy=Path(self.tmp.name)/'privacy.json'
        policy.write_text(json.dumps({'sense_input_counts':False}),encoding='utf-8')
        self.server.privacy_config=policy
        beat={'ts':time.time(),'idle_s':0,'front':{'app':'Fixture'},'input':{'keys_10s':4}}
        self.assertEqual(self.request('POST','/context/attention',beat),(200,{}))
        self.assertEqual([e for e in self.server.attention.inputs() if 'input' in e],[])

    def test_attention_delete_takes_the_observed_page_text(self):
        self.assertEqual(self.page('PAGE_SECRET')[0],200)
        self.assertEqual(self.count('observation_frames'),1)
        self.assertEqual(self.request('DELETE','/attention')[0],200)
        self.assertEqual((self.count('observation_frames'),self.count('observation_content')),(0,0))

    def test_observation_delete_takes_the_content_of_the_deleted_frames(self):
        self.assertEqual(self.page('PAGE_SECRET')[0],200)
        self.assertEqual(self.count('observation_content'),1)
        self.assertEqual(self.request('DELETE','/observation?range=15m')[0],200)
        self.assertEqual((self.count('observation_frames'),self.count('observation_content')),(0,0))

    def test_deletes_tell_every_context_kind_even_after_one_cut_a_line(self):
        for path in ('/attention','/observation?range=15m'):
            with self.subTest(path=path):
                changed=self.server._context_changed=Mock(side_effect=lambda kind,**_:kind==SEEN[0])
                self.assertEqual(self.request('DELETE',path)[0],200)
                self.assertEqual([call.args[0] for call in changed.call_args_list],list(SEEN))


if __name__=='__main__':unittest.main()
