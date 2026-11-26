"""Bearer token: an owner-only token file and an ASGI guard; it takes loopback hosts only unless remote_hosts."""
import hmac,json,os,re
def load_token(path):
    try:fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    except FileNotFoundError:raise SystemExit(f"{path} not found")
    except OSError as error:raise SystemExit(f"{path}: {error.strerror}")
    with os.fdopen(fd) as f:
        info=os.fstat(f.fileno())
        if info.st_uid!=os.getuid():raise SystemExit(f"{path} must be owned by the current user")
        if info.st_mode&0o077:raise SystemExit(f"{path} must be mode 0600")
        token=f.read().strip()
    if not token:raise SystemExit(f"{path} is empty")
    return token
MAX_BODY=65536
MAX_REQUESTS=2

class TokenAuth:
    def __init__(self,app,token,remote_hosts=False):
        self.app=app;self.expected=f'Bearer {token}'.encode();self.remote_hosts=remote_hosts
        self.active=0
    async def __call__(self,scope,receive,send):
        if scope['type'] not in ('http','websocket'):
            return await self.app(scope,receive,send)
        headers=dict(scope['headers'])
        if not self.remote_hosts and not re.fullmatch(rb'(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?',headers.get(b'host',b'').lower()):
            if scope['type']=='websocket':return await send({'type':'websocket.close','code':1008})
            await send({'type':'http.response.start','status':400,'headers':[(b'content-type',b'application/json')]})
            return await send({'type':'http.response.body','body':b'{"detail":"Invalid host header"}'})
        given=headers.get(b'authorization',b'')
        if hmac.compare_digest(given,self.expected):
            if scope['type']!='http' or scope['method']!='POST':
                return await self.app(scope,receive,send)
            async def reject(status,body):
                await send({'type':'http.response.start','status':status,'headers':[]})
                await send({'type':'http.response.body','body':body})
            if self.active>=MAX_REQUESTS:
                return await reject(503,b'Busy')
            if int(headers.get(b'content-length',b'0'))>MAX_BODY:
                return await reject(413,b'Request body too large')
            self.active+=1
            try:
                body=bytearray()
                while True:
                    message=await receive()
                    if message['type']=='http.disconnect':return
                    chunk=message.get('body',b'')
                    if len(body)+len(chunk)>MAX_BODY:
                        return await reject(413,b'Request body too large')
                    body.extend(chunk)
                    if not message.get('more_body'):break
                pending=True
                async def replay():
                    nonlocal pending
                    if pending:
                        pending=False
                        return {'type':'http.request','body':bytes(body)}
                    return await receive()
                return await self.app(scope,replay,send)
            finally:self.active-=1
        if scope['type']=='websocket':return await send({'type':'websocket.close','code':1008})
        if scope['method']=='GET' and scope['path']=='/health':
            response=None;body=bytearray()
            async def health_send(message):
                nonlocal response
                if message['type']=='http.response.start':response=message
                elif message['type']=='http.response.body':
                    body.extend(message.get('body',b''))
                    if not message.get('more_body',False):
                        public=json.dumps({'status':json.loads(body)['status']}).encode()
                        headers=[(k,v) for k,v in response['headers'] if k!=b'content-length']
                        await send({**response,'status':200,'headers':headers+[(b'content-length',str(len(public)).encode())]})
                        await send({'type':'http.response.body','body':public})
            return await self.app(scope,receive,health_send)
        await send({'type':'http.response.start','status':401,'headers':[(b'content-type',b'application/json'),(b'www-authenticate',b'Bearer')]})
        await send({'type':'http.response.body','body':b'{"detail":"Unauthorized"}'})
def client_headers():
    """Authorization header for probe and test clients; the token file is named by AAC_TTS_TOKEN_FILE."""
    path=os.environ.get('AAC_TTS_TOKEN_FILE')
    if not path:raise SystemExit('Set AAC_TTS_TOKEN_FILE to the TTS token file')
    return {'Authorization':f'Bearer {load_token(path)}'}
