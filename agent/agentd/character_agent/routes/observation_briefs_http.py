"""UI-authenticated backend contract for the future observation frontend."""
import re

ITEM = re.compile(r'^/observation/briefs/(brief-[a-f0-9]{32})$')


def route(handler, method, path):
    match = ITEM.fullmatch(path)
    if path not in ('/observation/briefs','/observation/briefs/settings') and not match: return False
    server = handler.server
    def reply(code, body):
        handler.json(code,body)
        return True
    if not handler.auth(server.ui_token): return reply(401,{'error':'unauthorized'})
    if server.resetting or server.closing: return reply(503,{'error':'unavailable'})
    server.sync_privacy()
    service = getattr(server.character_agent,'observation_briefs',None)
    if service is None: return reply(503,{'error':'observation_briefs_unavailable'})
    try:
        if method=='GET':
            if path=='/observation/briefs': return reply(200,{'settings':service.settings(),'reports':service.list(),'attempts':service.attempts()})
            if path.endswith('/settings'): return reply(200,service.settings())
            value = service.status(match[1])
            return reply(200,value) if value else reply(404,{'error':'brief_not_found'})
        if method=='DELETE' and match:
            service.dismiss(match[1])
            return reply(200,{'id':match[1],'state':'dismissed'})
        if method!='POST' or match: return reply(405,{'error':'method_not_allowed'})
        body = handler.body()
        if not isinstance(body,dict): raise ValueError('invalid_payload')
        if path.endswith('/settings'): return reply(200,service.configure(body))
        if set(body)-{'period','date','retry'} or not isinstance(body.get('period','daily'),str) or 'date' in body and not isinstance(body['date'],str) or type(body.get('retry',False)) is not bool: raise ValueError('invalid_payload')
        return reply(202,service.request(body.get('period','daily'),body.get('date'),retry=body.get('retry',False)))
    except ValueError as error:
        return reply(409 if str(error)=='brief_busy' else 400,{'error':str(error)})
