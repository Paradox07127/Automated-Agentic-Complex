import asyncio,json,os,tempfile,unittest
from unittest import mock
from auth import TokenAuth,client_headers,load_token
TOKEN='s3cret-token'
HEALTH={'status':'warming','registry':{'voice_a:zh':{}},'loaded':'voice_a','resident_models':['voice_a'],'gpt_sovits_commit':'12345678'}
class Inner:
    def __init__(self):self.called=False;self.scope=None
    async def __call__(self,scope,receive,send):
        self.called=True;self.scope=scope
        if scope['type']=='http':
            body=json.dumps(HEALTH).encode() if scope['path']=='/health' else b'ok'
            await send({'type':'http.response.start','status':200,'headers':[(b'content-type',b'application/json'),(b'content-length',str(len(body)).encode())]})
            await send({'type':'http.response.body','body':body[:5],'more_body':True})
            await send({'type':'http.response.body','body':body[5:]})
        elif scope['type']=='websocket':await send({'type':'websocket.accept'})
def drive(scope,**options):
    inner=Inner();sent=[]
    async def receive():return {'type':'http.request','body':b''}
    async def send(message):sent.append(message)
    asyncio.run(TokenAuth(inner,token=TOKEN,**options)(scope,receive,send))
    status=next((m['status'] for m in sent if m['type']=='http.response.start'),None)
    return inner,sent,status
def http(method,path,authorization=None,host='127.0.0.1:9888'):
    headers=[] if host is None else [(b'host',host.encode())]
    if authorization is not None:headers.append((b'authorization',authorization.encode()))
    return {'type':'http','method':method,'path':path,'headers':headers}
class TokenAuthTest(unittest.TestCase):
    def assert_rejected(self,scope):
        inner,sent,status=drive(scope)
        self.assertEqual(status,401);self.assertFalse(inner.called)
        headers=dict(sent[0]['headers'])
        self.assertEqual(headers[b'content-type'],b'application/json')
        self.assertEqual(headers[b'www-authenticate'],b'Bearer')
        self.assertEqual(sent[1]['body'],b'{"detail":"Unauthorized"}')
    def test_missing_token(self):self.assert_rejected(http('POST','/speech_stream'))
    def test_wrong_token(self):self.assert_rejected(http('POST','/speech_stream','Bearer wrong'))
    def test_wrong_scheme(self):self.assert_rejected(http('POST','/speech_stream',f'Basic {TOKEN}'))
    def test_right_token(self):
        inner,_,status=drive(http('POST','/speech_stream',f'Bearer {TOKEN}'))
        self.assertEqual(status,200);self.assertTrue(inner.called)
    def test_artifacts_need_token(self):self.assert_rejected(http('GET','/artifacts/x/audio'))
    def test_health_without_valid_token_only_returns_status(self):
        for authorization in (None,'Bearer wrong',f'Basic {TOKEN}'):
            with self.subTest(authorization=authorization):
                inner,sent,status=drive(http('GET','/health',authorization))
                self.assertEqual(status,200);self.assertTrue(inner.called)
                body=b''.join(m['body'] for m in sent if m['type']=='http.response.body')
                self.assertEqual(json.loads(body),{'status':HEALTH['status']})
                self.assertEqual(dict(sent[0]['headers'])[b'content-length'],str(len(body)).encode())
    def test_health_with_token_returns_full_body(self):
        inner,sent,status=drive(http('GET','/health',f'Bearer {TOKEN}'))
        self.assertEqual(status,200);self.assertTrue(inner.called)
        self.assertEqual(json.loads(b''.join(m['body'] for m in sent if m['type']=='http.response.body')),HEALTH)
    def test_websocket_needs_token_before_accept(self):
        for authorization in (None,'Bearer wrong',f'Basic {TOKEN}',f'Bearer {TOKEN}'):
            with self.subTest(authorization=authorization):
                scope=http('GET','/speech_stream',authorization);scope['type']='websocket'
                inner,sent,_=drive(scope)
                valid=authorization==f'Bearer {TOKEN}'
                self.assertEqual(sent,[{'type':'websocket.accept'}] if valid else [{'type':'websocket.close','code':1008}])
                self.assertEqual(inner.called,valid)
    def test_invalid_host_rejected_before_token_and_health(self):
        for host in ('evil.example:9888',None,'127.0.0.1.evil.example','[::1].evil.example:9888','localhost:bad'):
            for method,path,authorization in (('GET','/health',None),('POST','/speech_stream',f'Bearer {TOKEN}'),('POST','/speech_stream',None)):
                with self.subTest(host=host,method=method,authorization=authorization):
                    inner,sent,status=drive(http(method,path,authorization,host))
                    self.assertEqual(status,400);self.assertFalse(inner.called)
                    self.assertEqual(sent[1]['body'],b'{"detail":"Invalid host header"}')
    def test_websocket_invalid_host_rejected_before_accept(self):
        for host in ('evil.example:9888',None):
            with self.subTest(host=host):
                scope=http('GET','/speech_stream',f'Bearer {TOKEN}',host);scope['type']='websocket'
                inner,sent,_=drive(scope)
                self.assertEqual(sent,[{'type':'websocket.close','code':1008}]);self.assertFalse(inner.called)
    def test_loopback_hosts_pass(self):
        for host in ('127.0.0.1','127.0.0.1:9888','localhost','localhost:9888','[::1]','[::1]:9888'):
            with self.subTest(host=host):
                inner,_,status=drive(http('POST','/speech_stream',f'Bearer {TOKEN}',host))
                self.assertEqual(status,200);self.assertTrue(inner.called)
                scope=http('GET','/speech_stream',f'Bearer {TOKEN}',host);scope['type']='websocket'
                inner,sent,_=drive(scope)
                self.assertTrue(inner.called);self.assertEqual(sent,[{'type':'websocket.accept'}])
    def test_remote_hosts_skip_host_check_but_keep_token(self):
        host='192.0.2.10:9888'
        inner,_,status=drive(http('POST','/speech_stream',f'Bearer {TOKEN}',host),remote_hosts=True)
        self.assertEqual(status,200);self.assertTrue(inner.called)
        inner,sent,status=drive(http('POST','/speech_stream','Bearer wrong',host),remote_hosts=True)
        self.assertEqual(status,401);self.assertFalse(inner.called)
        self.assertEqual(sent[1]['body'],b'{"detail":"Unauthorized"}')
        inner,sent,status=drive(http('GET','/health',None,host),remote_hosts=True)
        self.assertEqual(status,200)
        self.assertEqual(json.loads(b''.join(m['body'] for m in sent if m['type']=='http.response.body')),{'status':HEALTH['status']})
    def test_lifespan_passes_through(self):
        scope={'type':'lifespan'}
        inner,sent,_=drive(scope)
        self.assertIs(inner.scope,scope);self.assertEqual(sent,[])
class LoadTokenTest(unittest.TestCase):
    def setUp(self):
        self.dir=tempfile.TemporaryDirectory();self.path=os.path.join(self.dir.name,'tts-token')
    def tearDown(self):self.dir.cleanup()
    def write(self,text,mode):
        with open(self.path,'w') as f:f.write(text)
        os.chmod(self.path,mode)
    def test_0600_returns_stripped(self):
        self.write(f'  {TOKEN}\n',0o600);self.assertEqual(load_token(self.path),TOKEN)
    def test_0644_refused(self):
        self.write(TOKEN,0o644)
        with self.assertRaises(SystemExit):load_token(self.path)
    def test_symlink_refused(self):
        self.write(TOKEN,0o600)
        link=os.path.join(self.dir.name,'link');os.symlink(self.path,link)
        with self.assertRaises(SystemExit):load_token(link)
    def test_other_owner_refused(self):
        self.write(TOKEN,0o600)
        with mock.patch('auth.os.getuid',return_value=os.getuid()+1),self.assertRaises(SystemExit):load_token(self.path)
    def test_missing_refused(self):
        with self.assertRaises(SystemExit) as cm:load_token(self.path)
        self.assertIn(self.path,str(cm.exception))
    def test_empty_refused(self):
        self.write('\n',0o600)
        with self.assertRaises(SystemExit):load_token(self.path)
    def test_client_headers_read_the_env_token_file(self):
        self.write(TOKEN,0o600)
        with mock.patch.dict(os.environ,{'AAC_TTS_TOKEN_FILE':self.path}):self.assertEqual(client_headers(),{'Authorization':f'Bearer {TOKEN}'})
    def test_client_headers_need_the_env_var(self):
        with mock.patch.dict(os.environ,{},clear=True),self.assertRaises(SystemExit):client_headers()
if __name__=='__main__':unittest.main()
