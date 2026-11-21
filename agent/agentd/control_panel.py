"""Authenticated control-panel operations, shared with every native UI entry point."""
import re
from urllib.parse import parse_qs, urlparse

CONVERSATION = re.compile(r'^/conversations/([a-f0-9]{32})(?:/(activate|turns|messages|cancel))?$')
SESSION = re.compile(r'^/sessions/(own:[a-f0-9]{12})$')


def _reload(server):
    server.cancel_turn('client_cancel')
    controller = server.character_agent
    if controller is not None:
        # Retire only the foreground runtime; background jobs retain their leases.
        with controller._lock:
            if controller.runtime is not None:
                controller.runtime.close()
                controller.runtime = None
            controller._runtime_config = None
    if server.mouth is not None:
        server.load_window()


def _fence(server):
    server.history_generation += 1
    server._line_entries.clear()
    server._cut_lines.clear()
    server._window_ops.clear()


def route(h, method, path):
    conversation, session = CONVERSATION.fullmatch(path), SESSION.fullmatch(path)
    if path != '/conversations' and not conversation and not session: return False
    def reply(status, data):
        h.json(status, data)
        return True
    server = h.server
    if not h.auth(server.ui_token): return reply(401, {'error': 'unauthorized'})
    if server.resetting or server.closing: return reply(503, {'error': 'unavailable'})
    try:
        if session:
            if method not in ('PUT', 'DELETE'): return reply(405, {'error': 'method_not_allowed'})
            if server.sessions is None: return reply(503, {'error': 'no_sessions'})
            owned = server.sessions.sessions.get(session[1])
            status, value = server.sessions.manage(session[1], h.body(), delete=method == 'DELETE')
            if status == 200 and method == 'DELETE' and owned is not None and owned.native_id:
                server.registry.forget_session(owned.target, owned.native_id)
            return reply(status, value)
        if server.history is None: return reply(503, {'error': 'no_history'})
        store = server.history.conversations
        if method == 'GET':
            if path == '/conversations': return reply(200, {'conversations': store.list(), 'busy': _busy(server)})
            if conversation[2] == 'turns':
                query = parse_qs(urlparse(h.path).query)
                before = int(query['before'][0]) if 'before' in query else None
                return reply(200, store.turns(conversation[1], before, int(query.get('limit', ['100'])[0])))
            return reply(405, {'error': 'method_not_allowed'})
        body = h.body()
        if not isinstance(body, dict): raise ValueError('invalid_payload')
        with server._switch_lock:
            if path == '/conversations' and method == 'POST':
                if set(body) - {'title'}: raise ValueError('invalid_payload')
                if _busy(server): raise ValueError('busy')
                with server._write_lock:
                    value = store.create(body.get('title', '新对话'))
                    _fence(server)
                _reload(server)
                return reply(201, value)
            if not conversation: return reply(405, {'error': 'method_not_allowed'})
            ident, action = conversation.groups()
            if action == 'cancel' and method == 'POST':
                if set(body) != {'run_id', 'generation'} or not isinstance(body['run_id'], str) or type(body['generation']) is not int:
                    raise ValueError('invalid_payload')
                if store.get(ident) is None: raise ValueError('unknown_conversation')
                controller = server.character_agent
                if controller is None: return reply(503, {'error': 'character_runtime_unavailable'})
                return reply(*controller.cancel_conversation(ident, body['run_id'], body['generation']))
            if action == 'messages' and method == 'POST':
                if 'reply_to' not in body and ('text' not in body or set(body) - {'text', 'look', 'no_memory', 'scope_id'} or not isinstance(body.get('text'), str) or not 0 < len(body['text'].strip()) <= 8000):
                    raise ValueError('invalid_text')
                if 'reply_to' not in body:
                    for key in ('look', 'no_memory'):
                        if key in body and not isinstance(body[key], bool): raise ValueError('invalid_' + key)
                    if 'scope_id' in body:
                        if not isinstance(body['scope_id'], str) or not 1 <= len(body['scope_id']) <= 128: raise ValueError('invalid_scope_id')
                        if body.get('no_memory'): raise ValueError('temporary_scope_not_allowed')
                item = store.get(ident)
                if item is None: raise ValueError('unknown_conversation')
                if item['archived']: raise ValueError('archived')
                if store.active != ident: raise ValueError('conversation_not_active')
                controller = server.character_agent
                if 'reply_to' in body:
                    target = body['reply_to']
                    if set(body) != {'reply_to', 'answers'} or not isinstance(target, dict) or set(target) != {'request_id', 'revision'} or not isinstance(target['request_id'], str) or type(target['revision']) is not int:
                        raise ValueError('invalid_reply_target')
                    if controller is None: return reply(503, {'error': 'character_runtime_unavailable'})
                    card = controller.interactions.get(target['request_id'])
                    if not card or card['conversation_id'] != ident or card['kind'] != 'question':
                        raise ValueError('invalid_reply_target')
                    if card['state'] != 'pending': raise ValueError('interaction_version_changed')
                    if (card['data'] or {}).get('character_id') != server.character:
                        raise ValueError('invalid_reply_target')
                    return reply(200, controller.interactions.respond(card['request_id'], target['revision'], body['answers']))
                options = {'look': body['look']} if 'look' in body else {}
                if 'no_memory' in body: options['remember'] = not body['no_memory']
                if 'scope_id' in body: options['scope_id'] = body['scope_id']
                return reply(*server.say(body['text'], **options))
            activate, delete = action == 'activate', method == 'DELETE'
            if not ((activate and method == 'POST') or (action is None and method in ('PUT', 'DELETE'))):
                return reply(405, {'error': 'method_not_allowed'})
            turn_ids = []
            with server._write_lock:
                old = store.active
                if _busy(server) and (activate or delete or ident == old and body.get('archived')): raise ValueError('busy')
                if delete:
                    with store.lock:
                        turn_ids = [r[0] for r in store.db.execute('SELECT h.turn_id FROM history_turns h JOIN conversation_turns t ON h.event_id=t.event_id WHERE t.conversation_id=?', (ident,))]
                value = store.update(ident, body, activate=activate, delete=delete)
                changed = old != store.active
                if changed or delete: _fence(server)
            if changed or delete: _reload(server)
            if delete:
                if server.trace is not None: server.trace.forget(turn_ids)
                if server.character_agent is not None:
                    server.character_agent.store.forget_runs(turn_ids, conversation_id=ident)
                    if getattr(server.character_agent, "deliveries", None):
                        server.character_agent.deliveries.forget(conversation_id=ident)
            return reply(200, value)
    except (ValueError, TypeError) as error:
        code = str(error) if isinstance(error, ValueError) else 'invalid_payload'
        status = 404 if code == 'unknown_conversation' else 409 if code in ('version_conflict', 'archived', 'busy', 'conversation_not_active', 'interaction_version_changed', 'interaction_cancelled', 'interaction_character_changed', 'character_busy') else 400
        return reply(status, {'error': code})


def _busy(server):
    return bool(server.character_agent is not None and server.character_agent.busy() or
                any(not line.is_set() for line in tuple(server._live_lines)))
