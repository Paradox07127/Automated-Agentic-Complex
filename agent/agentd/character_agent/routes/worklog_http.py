"""UI-authenticated reads and user corrections of work memory."""
import datetime
import re
from urllib.parse import parse_qs, urlparse

TASK = re.compile(r'^/memory/tasks/([^/]{1,64})$')
DAY = re.compile(r'^/memory/days/(\d{4}-\d{2}-\d{2})$')
STATUSES = ('active', 'done', 'parked', 'uncertain')
SESSION_FIELDS = ('id', 'kind', 'agent', 'project', 'title', 'start', 'end', 'status', 'task_id')
TASK_FIELDS = ('id', 'project', 'title', 'goal', 'goal_authority', 'status', 'progress', 'next_step', 'blockers',
               'first_at', 'last_at', 'sessions', 'revision', 'edited')


def _date(value):
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise ValueError('invalid_date')
    try:
        return datetime.date.fromisoformat(value)
    except ValueError:
        raise ValueError('invalid_date') from None


def _session(row):
    return {**{key: row[key] for key in SESSION_FIELDS},
            **{key: row['body'].get(key, '' if key in ('goal', 'outcome') else [])
               for key in ('goal', 'outcome', 'did')},
            # The summarizer stores {text, owner}; the C6 shape lists the text.
            'next_steps': [step['text'] for step in row['body'].get('next_steps', [])]}


def _task(row):
    return {key: row[key] for key in TASK_FIELDS}


def _day(row):
    return {**{key: row[key] for key in ('date', 'period', 'headline', 'partial', 'generated_at')},
            **{key: row['body'].get(key, []) for key in ('projects', 'open_loops', 'tomorrow')}}


def route(handler, method, path):
    task_match, day_match = TASK.fullmatch(path), DAY.fullmatch(path)
    if path not in ('/memory/sessions', '/memory/tasks', '/memory/days') and not task_match and not day_match:
        return False
    server = handler.server

    def reply(code, body):
        handler.json(code, body)
        return True

    if not handler.auth(server.ui_token): return reply(401, {'error': 'unauthorized'})
    if server.resetting or server.closing: return reply(503, {'error': 'unavailable'})
    server.sync_privacy()
    work = getattr(server, 'worklog', None)
    if work is None: return reply(503, {'error': 'worklog_unavailable'})
    permissions = server.consent.snapshot()[0]
    paused = server.observation_paused()

    def allowed(row):
        return row is not None and not paused and all(permissions.get(item, False) for item in row['requires'])

    def sessions(rows):
        return [_session(row) for row in rows if row['state'] == 'completed' and allowed(row)]

    query = parse_qs(urlparse(handler.path).query, keep_blank_values=True)
    today = datetime.date.today().isoformat()
    try:
        if task_match:
            task = work.task(task_match[1])
            if not allowed(task): return reply(404, {'error': 'task_not_found'})
            if method == 'GET':
                return reply(200, {'task': _task(task), 'sessions': sessions(work.sessions_for_task(task['id']))})
            if method != 'PATCH': return reply(405, {'error': 'method_not_allowed'})
            body = handler.body()
            if not isinstance(body, dict) or set(body) - {'expected_revision', 'status', 'title', 'goal'} \
                    or type(body.get('expected_revision')) is not int or body['expected_revision'] < 0 \
                    or not set(body).intersection(('status', 'title', 'goal')):
                raise ValueError('invalid_payload')
            if 'status' in body and body['status'] not in STATUSES: raise ValueError('invalid_status')
            if any(not isinstance(body[key], str) or not body[key].strip() for key in ('title', 'goal') if key in body):
                raise ValueError('invalid_payload')
            result, card = work.edit_task(task['id'], **body)
            if result == 'missing' or not allowed(card): return reply(404, {'error': 'task_not_found'})
            if result == 'conflict': return reply(409, {'error': 'revision_conflict', 'task': _task(card)})
            return reply(200, _task(card))
        if method != 'GET': return reply(405, {'error': 'method_not_allowed'})
        if path == '/memory/sessions':
            day = _date(query.get('day', [today])[0]).isoformat()
            return reply(200, {'day': day, 'sessions': sessions(work.sessions_on(day))})
        if path == '/memory/tasks':
            statuses = query['status'][0].split(',') if 'status' in query else STATUSES
            if any(status not in STATUSES for status in statuses): raise ValueError('invalid_status')
            cards = [row for row in work.tasks() if allowed(row)]
            return reply(200, {'tasks': [_task(row) for row in cards if row['status'] in statuses],
                               'counts': {status: sum(row['status'] == status for row in cards) for status in STATUSES}})
        if day_match:
            date = _date(day_match[1]).isoformat()
            period = query.get('period', ['day'])[0]
            if period not in ('day', 'week'): raise ValueError('invalid_period')
            day = work.day(date, period)
            if not allowed(day) or day['state'] != 'completed': return reply(404, {'error': 'day_not_found'})
            return reply(200, _day(day))
        start = _date(query.get('from', [today])[0])
        end = _date(query.get('to', [today])[0])
        if not 0 <= (end - start).days < 31: raise ValueError('invalid_range')
        days = [work.day((start + datetime.timedelta(days=n)).isoformat()) for n in range((end - start).days + 1)]
        return reply(200, {'days': [_day(day) for day in days if allowed(day) and day['state'] == 'completed']})
    except ValueError as error:
        return reply(400, {'error': str(error)})
