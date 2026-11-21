"""Native payloads and authorized observation tools through the actual HTTP server."""
import base64
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import test_server
import test_observation_briefs_http as fixture
from observation.capture import CaptureManager
from observation.blacklist import Blacklist
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

if __name__=='__main__':unittest.main()
