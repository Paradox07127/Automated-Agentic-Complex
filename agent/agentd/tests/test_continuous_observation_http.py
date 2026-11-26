"""Native payloads and authorized observation tools through the actual HTTP server."""
import base64
import json
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import test_server
import test_observation_briefs_http as fixture
from observation.attention import AttentionStore
from observation.capture import CaptureManager
from observation.blacklist import Blacklist
from observation.timeline import SEGMENT_S, Timeline
from support import deny_blacklist  # noqa: E402
from test_character_agent_runtime import FakeSession

class ObservationHTTPTests(fixture.BriefHTTPFixture):
    def request(self,method,path,body=None,token=test_server.UI,timeout=20):
        return test_server.ServerTest.request(self,method,path,body,token,timeout)

    def ready(self):
        window={'app':'Fixture','bundle_id':'fixture.editor','window_id':7,'title':'Long log'}
        self.server.capture=CaptureManager(self.server.feed,Blacklist(deny_blacklist(self.root/'blacklist.json')),lambda:window,None,share_text=True,vision=object())
        self.server.capture.on_image=self.c.observations.ingest_image
        self.server.sync_privacy();return window

    def test_ui_token_only_complete_text_paging_and_payload_validation(self):
        window=self.ready();text='START '+ 'x'*100000+' LATE_ERROR: missing declaration'
        for token in (test_server.HOOK,test_server.EVENTS,None):
            self.assertEqual(self.request('GET','/observation/state',token=token)[0],401)
        for index,part in enumerate((text[:64000],text[64000:])):
            body={**window,'source':'ax','text':part,'snapshot_pages':2,'snapshot_page':index,'snapshot_id':'full-body'}
            self.assertEqual(self.request('POST','/context/text',body)[0],202)
            if index==0:self.assertEqual(self.request('GET','/observation/sources')[1]['items'],[])
        row=self.request('GET','/observation/sources?query=LATE_ERROR')[1]['items'][0]
        path='/observation/sources/'+row['id']
        self.assertEqual(self.request('GET',path+'?offset=64000')[1]['text'],text[64000:80000])
        self.assertEqual(self.request('GET',path+'?offset=-1')[0],400)
        self.assertEqual(self.request('POST','/context/text',{**body,'snapshot_page':2})[0],400)
        self.assertEqual(self.request('POST','/observation/refresh',{'mode':'text','observation_id':row['id']})[0],202)
        self.assertEqual(self.request('POST','/observation/refresh',{'mode':'click'})[0],400)

    def test_original_image_before_any_ax_text_and_readback(self):
        self.ready();status,look=self.server.capture.look();self.assertEqual(status,202)
        png=b'\x89PNG\r\n\x1a\n'+b'\x00\x00\x00\rIHDR'+(2560).to_bytes(4,'big')+(1440).to_bytes(4,'big')+b'pixels'
        code,value=self.request('POST','/context/image',{'request_id':look['request_id'],'window_id':7,'png_base64':base64.b64encode(png).decode()})
        self.assertEqual(code,202,value)
        row=self.request('GET','/observation/sources')[1]['items'][0]
        read=self.request('GET','/observation/sources/'+row['id']+'/image')[1]
        self.assertEqual(base64.b64decode(read['content'][0]['data']),png)
        self.assertEqual(self.c.observations.get(row['id'])['metadata']['pixel_width'],2560)
        self.server.share_page_text=False;self.server.share_typed_text=False;self.server.capture.share_text=False;self.server.capture.vision=None;self.server.sync_privacy()
        self.assertFalse(self.request('GET','/observation/state')[1]['available'])
        self.assertEqual(self.request('GET','/observation/sources')[1]['items'],[])

    def test_timeline_summary_ids_read_and_bad_refresh_ids_are_rejected(self):
        self.ready()
        with patch.object(self.c.observations,'read',return_value={'observation_id':'tl-123'}) as read:
            self.assertEqual(self.request('GET','/observation/sources/tl-123'),(200,{'observation_id':'tl-123'}))
        self.assertEqual(read.call_args.args[0],'tl-123')
        for path in ('/observation/sources/tl-123/changes','/observation/sources/tl-123/image'):
            self.assertEqual(self.request('GET',path)[0],404)
        for ident in (['x'],{'a':1},7):
            self.assertEqual(self.request('POST','/observation/refresh',{'observation_id':ident}),(400,{'error':'invalid_observation_request'}))

    def test_excluding_an_app_keeps_records_or_deletes_only_that_apps(self):
        self.ready();o=self.c.observations;now=time.time()
        self.server.attention=AttentionStore(self.root/'attention.sqlite',self.server.capture.blacklist)
        self.addCleanup(self.server.attention.close)
        frames={app:o.ingest('native_ax','notes of '+app,metadata={'app':app,'bundle_id':'x.'+app,'title':app},source_key='k-'+app,at=now-10)
                for app in ('Xapp','Yapp')}
        with self.db:
            self.db.executemany('INSERT INTO observation_work_events VALUES(?,?,?,?,?,?,?)',
                [('work-'+app,self.server.character,now-5,app,json.dumps({'title':app}),json.dumps([o.dependency(o.get(ident))]),'analysis')
                 for app,ident in frames.items()])
        rows=lambda:(sorted(r[0] for r in self.db.execute('SELECT id FROM observation_frames')),  # noqa: E731
                     sorted(r[0] for r in self.db.execute('SELECT id FROM observation_work_events')))
        kept=rows();self.assertEqual(len(kept[0]),2)
        exclude=lambda delete:self.request('POST','/blacklist',{'field':'app_names','value':'Xapp','delete_existing':delete})[0]  # noqa: E731
        self.assertEqual(exclude(False),200)
        self.assertEqual(rows(),kept)
        self.assertEqual(exclude(True),200)
        self.assertEqual(rows(),([frames['Yapp']],['work-Yapp']))

    def test_excluding_an_app_with_delete_takes_what_cites_its_timeline_summary(self):
        self.ready();o=self.c.observations;now=time.time()
        self.server.attention=AttentionStore(self.root/'attention.sqlite',self.server.capture.blacklist)
        self.addCleanup(self.server.attention.close)
        timeline=self.server.timeline=Timeline(self.root/'timeline.sqlite',self.server.capture.blacklist)
        self.addCleanup(setattr,self.server,'timeline',None);self.addCleanup(timeline.close)
        segment=int(now//SEGMENT_S)*SEGMENT_S-SEGMENT_S
        with timeline.lock,timeline.db:
            timeline.db.execute('INSERT INTO summaries (rowid,text,screen,typed,windows) VALUES (?,?,0,0,?)',
                                (segment,'Xapp payroll summary',json.dumps([['Xapp','x.Xapp',None]])))
        cited=o.dependency(o.get(f'tl-{segment}'))
        with self.db:
            self.db.execute('INSERT INTO observation_analyses VALUES(?,?,?,?,?,?)',
                            ('analysis-tl',self.server.character,now-5,'run-tl','{}',json.dumps([cited])))
            self.db.execute('INSERT INTO observation_work_events VALUES(?,?,?,?,?,?,?)',
                            ('work-tl',self.server.character,now-5,'payroll',json.dumps({'title':'payroll'}),json.dumps([cited]),'analysis-tl'))
        self.assertEqual(self.request('POST','/blacklist',{'field':'app_names','value':'Xapp','delete_existing':True})[0],200)
        self.assertEqual(timeline.summarized(),set())
        for table in ('observation_analyses','observation_work_events'):
            self.assertEqual(self.db.execute('SELECT count(*) FROM '+table).fetchone()[0],0,table)

if __name__=='__main__':unittest.main()
