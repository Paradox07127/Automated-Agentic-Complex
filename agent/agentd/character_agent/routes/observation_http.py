"""UI-token inspection of actual continuous observations and their analysis."""
import re
import threading
from urllib.parse import parse_qs,urlparse

# A timeline summary (tl-<segment>) has a text only: no changes, no image.
SOURCE=re.compile(r'^/observation/sources/(?:((?:obs-|work-)[a-f0-9]{32})(?:/(changes|image))?|(tl-[0-9]{1,18}))$')


def route(h, method, path):
    source=SOURCE.fullmatch(path)
    if path not in ('/observation/state','/observation/sources','/observation/analyze','/observation/refresh') and not source: return False
    s=h.server
    def reply(code,body): h.json(code,body);return True
    if not h.auth(s.ui_token): return reply(401,{'error':'unauthorized'})
    if s.resetting or s.closing: return reply(503,{'error':'unavailable'})
    s.sync_privacy()
    service=getattr(s.character_agent,'observations',None)
    if service is None: return reply(503,{'error':'observation_unavailable'})
    try:
        if method=='GET':
            query=parse_qs(urlparse(h.path).query)
            if path=='/observation/state': return reply(200,service.context())
            if path=='/observation/sources': return reply(200,service.search(query.get('query',[''])[0],limit=int(query.get('limit',['12'])[0]),cursor=query.get('cursor',[None])[0],kind=query.get('kind',['all'])[0],since=float(query['since'][0]) if 'since' in query else None))
            if source:
                ident=source[1] or source[3]
                if source[2]=='image': return reply(200,service.image(ident))
                args={'offset':int(query.get('offset',['0'])[0]),'max_chars':int(query.get('max_chars',['16000'])[0])}
                return reply(200,service.changes(ident,**args) if source[2]=='changes' else service.read(
                    ident,**args,query=query.get('query',[None])[0],part=query.get('part',['text'])[0]))
        if method=='POST' and path in ('/observation/analyze','/observation/refresh'):
            body=h.body()
            if not isinstance(body,dict): raise ValueError('invalid_payload')
            if path=='/observation/refresh':
                if set(body)-{'mode','observation_id'} or not isinstance(body.get('observation_id'),(str,type(None))): raise ValueError('invalid_payload')
                return reply(202,service.refresh(body.get('mode','text'),body.get('observation_id')))
            if body: raise ValueError('invalid_payload')
            def analyze():
                try: service.run_once()
                except Exception: pass
            threading.Thread(target=analyze,name='requested-observation-analysis',daemon=True).start()
            return reply(202,{'state':'scheduled'})
        return reply(405,{'error':'method_not_allowed'})
    except (ValueError,TypeError): return reply(400,{'error':'invalid_observation_request'})
