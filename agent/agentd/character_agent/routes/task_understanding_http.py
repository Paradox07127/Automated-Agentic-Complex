"""Authenticated inspection/correction of provisional task context."""
import re

PATH = re.compile(r'^/task-understanding/(seg-|hyp-)?[A-Za-z0-9_-]{1,128}/correct$')


def route(handler, method, path):
    if path != '/task-understanding' and not PATH.fullmatch(path): return False
    server = handler.server
    def reply(code, body):
        handler.json(code, body)
        return True
    if not handler.auth(server.ui_token): return reply(401, {'error':'unauthorized'})
    if server.resetting or server.closing: return reply(503, {'error':'unavailable'})
    server.sync_privacy()
    service = getattr(server.character_agent, 'task_understanding', None)
    if service is None: return reply(503, {'error':'task_understanding_unavailable'})
    if method == 'GET' and path == '/task-understanding': return reply(200, service.context())
    if method != 'POST' or path == '/task-understanding': return reply(405, {'error':'method_not_allowed'})
    try:
        body = handler.body()
        if not isinstance(body, dict) or set(body)-{'revision','action','text'} or type(body.get('revision')) is not int:
            raise ValueError('invalid_payload')
        return reply(200, service.correct(path.split('/')[2], body['revision'], action=body.get('action'), text=body.get('text')))
    except ValueError as error:
        return reply(409 if str(error)=='task_hypothesis_changed' else 400, {'error':str(error)})
