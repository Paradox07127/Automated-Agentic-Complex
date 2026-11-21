"""User-enabled local schedules and durable, at-most-once occurrence claims."""
from datetime import date, timedelta
import hashlib
import json
import math
import re
import threading
import time
import uuid

COLUMNS = ('schedule_id', 'title', 'instruction', 'trigger_kind', 'trigger_json', 'enabled', 'created_from',
           'conversation_id', 'next_run_at', 'last_run_at', 'last_job_id', 'created_at', 'updated_at', 'scope_id')
SELECT = 'SELECT ' + ','.join(COLUMNS) + ',(SELECT error FROM schedule_runs AS r WHERE ' \
    'r.schedule_id=schedules.schedule_id ORDER BY r.rowid DESC LIMIT 1) FROM schedules'
GRACE = 6 * 3600


def validate_trigger(trigger):
    if not isinstance(trigger, dict):
        raise ValueError('invalid_schedule_trigger')
    kind = trigger.get('kind')
    fields = {'daily': {'kind', 'at', 'weekdays'}, 'weekly': {'kind', 'at', 'weekday'},
              'session_done': {'kind', 'target', 'project'}}
    if not isinstance(kind, str) or kind not in fields or set(trigger) - fields[kind]:
        raise ValueError('invalid_schedule_trigger')
    if kind == 'session_done':
        target, project = trigger.get('target'), trigger.get('project')
        if target not in (None, 'claude', 'codex') or project is not None and (
                not isinstance(project, str) or not 1 <= len(project.strip()) <= 4096):
            raise ValueError('invalid_schedule_trigger')
        return {'kind': kind, 'target': target, 'project': project}
    at = trigger.get('at')
    if not isinstance(at, str) or re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', at) is None:
        raise ValueError('invalid_schedule_trigger')
    days = trigger.get('weekdays') if kind == 'daily' else [trigger.get('weekday')]
    if not isinstance(days, list) or not 1 <= len(days) <= 7 or any(type(d) is not int or not 1 <= d <= 7 for d in days):
        raise ValueError('invalid_schedule_trigger')
    return {'kind': kind, 'at': at, **({'weekdays': sorted(set(days))} if kind == 'daily' else {'weekday': days[0]})}


def next_run(trigger, after):
    """First occurrence strictly after after, in system local time (ISO weekdays: Monday=1)."""
    trigger = validate_trigger(trigger)
    if trigger['kind'] == 'session_done':
        return None
    today = time.localtime(after)
    day = date(*today[:3])
    hour, minute = map(int, trigger['at'].split(':'))
    days = trigger['weekdays'] if trigger['kind'] == 'daily' else [trigger['weekday']]
    for offset in range(8):
        candidate = day + timedelta(days=offset)
        if candidate.isoweekday() in days:
            at = time.mktime((*candidate.timetuple()[:3], hour, minute, 0, 0, 0, -1))
            if at > after:
                return at
    raise ValueError('invalid_schedule_trigger')


def _row(row):
    if row is None:
        return None
    item = dict(zip((*COLUMNS, 'last_error'), row))
    item['trigger'] = {'kind': item.pop('trigger_kind'), **json.loads(item.pop('trigger_json'))}
    item['enabled'] = bool(item['enabled'])
    return item


def _text(value, limit):
    return isinstance(value, str) and 1 <= len(value.strip()) <= limit


def _binding(value):
    return value is None or _text(value, 128)


class Schedules:
    def __init__(self, db, lock=None, clock=time.time):
        self.db, self.lock, self.clock = db, lock if lock is not None else threading.RLock(), clock
        self.revision = 0  # counts this store's writes
        self._next = None  # next_due()'s answer until a write; None: not known

    def _changed(self):
        self.revision += 1
        self._next = None

    def next_due(self):
        """The earliest next_run_at of an enabled schedule; inf when none has one."""
        with self.lock:
            if self._next is None:
                due = self.db.execute('SELECT MIN(next_run_at) FROM schedules WHERE enabled=1').fetchone()[0]
                self._next = math.inf if due is None else due
            return self._next

    def _get(self, ident):
        return _row(self.db.execute(SELECT + ' WHERE schedule_id=?', (ident,)).fetchone())

    def get(self, ident):
        with self.lock:
            return self._get(ident)

    def list(self):
        with self.lock:
            return [_row(r) for r in self.db.execute(SELECT + ' ORDER BY created_at,rowid').fetchall()]

    def add(self, title, instruction, trigger, *, enabled=False, created_from='user', conversation_id=None, scope_id=None):
        if not _text(title, 200) or not _text(instruction, 8000) or type(enabled) is not bool \
                or created_from not in ('user', 'agent_proposal') or created_from == 'agent_proposal' and enabled \
                or not _binding(conversation_id) or not _binding(scope_id):
            raise ValueError('invalid_schedule')
        trigger = validate_trigger(trigger)
        ident, now = uuid.uuid4().hex, self.clock()
        with self.lock, self.db:
            self._changed()
            self.db.execute('INSERT INTO schedules (' + ','.join(COLUMNS) + ') VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,?)',
                (ident, title, instruction, trigger['kind'], json.dumps({k: v for k, v in trigger.items() if k != 'kind'}),
                 int(enabled), created_from, conversation_id, next_run(trigger, now) if enabled else None, now, now, scope_id))
        return self.get(ident)

    def update(self, ident, changes):
        if not isinstance(changes, dict) or not changes or set(changes) - {'title', 'instruction', 'trigger', 'enabled',
                                                                          'conversation_id', 'scope_id'}:
            raise ValueError('invalid_schedule')
        with self.lock, self.db:
            item = self._get(ident)
            if item is None:
                raise ValueError('unknown_schedule')
            item.update(changes)
            if not _text(item['title'], 200) or not _text(item['instruction'], 8000) or type(item['enabled']) is not bool \
                    or not _binding(item['conversation_id']) or not _binding(item['scope_id']):
                raise ValueError('invalid_schedule')
            trigger = validate_trigger(item['trigger'])
            now = self.clock()
            self._changed()
            due = next_run(trigger, now) if item['enabled'] else None
            if 'trigger' not in changes and 'enabled' not in changes:
                due = item['next_run_at']
            self.db.execute('UPDATE schedules SET title=?,instruction=?,trigger_kind=?,trigger_json=?,enabled=?,next_run_at=?,'
                            'updated_at=?,conversation_id=?,scope_id=? WHERE schedule_id=?',
                (item['title'], item['instruction'], trigger['kind'], json.dumps({k: v for k, v in trigger.items() if k != 'kind'}),
                 int(item['enabled']), due, now, item['conversation_id'], item['scope_id'], ident))
        return self.get(ident)

    def delete(self, ident):
        with self.lock, self.db:
            self._changed()
            self.db.execute('DELETE FROM schedule_runs WHERE schedule_id=?', (ident,))
            return self.db.execute('DELETE FROM schedules WHERE schedule_id=?', (ident,)).rowcount > 0

    def _claim(self, item, due_at, now, *, run_id=None, missed=False, advance=True):
        run_id = run_id or uuid.uuid4().hex
        state = 'missed' if missed else 'started'
        changed = self.db.execute('INSERT OR IGNORE INTO schedule_runs VALUES(?,?,?,?,NULL,?,NULL)',
            (run_id, item['schedule_id'], due_at, None if missed else now, state)).rowcount
        if not changed:
            return None
        self._changed()
        if advance:
            self.db.execute('UPDATE schedules SET next_run_at=?,updated_at=? WHERE schedule_id=?',
                (next_run(item['trigger'], now) if item['enabled'] else None, now, item['schedule_id']))
        return {'run_id': run_id, 'schedule_id': item['schedule_id'], 'due_at': due_at, 'schedule': item}

    def due(self, now=None):
        now = self.clock() if now is None else now
        with self.lock, self.db:
            self.db.execute('BEGIN IMMEDIATE')
            items = [_row(r) for r in self.db.execute(SELECT + ' WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at', (now,)).fetchall()]
            runs = [self._claim(item, item['next_run_at'], now, missed=now - item['next_run_at'] > GRACE) for item in items]
            self._next = None
            return [run for run in runs if run and now - run['due_at'] <= GRACE]

    def fire(self, target, project, event_key):
        now = self.clock()
        with self.lock, self.db:
            self.db.execute('BEGIN IMMEDIATE')
            runs = []
            for item in [_row(r) for r in self.db.execute(SELECT + ' ORDER BY created_at,rowid').fetchall()]:
                trigger = item['trigger']
                if item['enabled'] and trigger['kind'] == 'session_done' and trigger['target'] in (None, target) \
                        and trigger['project'] in (None, project):
                    ident = hashlib.sha256(json.dumps([item['schedule_id'], event_key], sort_keys=True).encode()).hexdigest()
                    run = self._claim(item, now, now, run_id=ident)
                    if run:
                        runs.append(run)
            return runs

    def run_now(self, ident):
        with self.lock, self.db:
            item = self._get(ident)
            if item is None:
                raise ValueError('unknown_schedule')
            now = self.clock()
            return self._claim(item, now, now, advance=False)

    def submitted(self, run, job_id=None, error=None, halt=False):
        now = self.clock()
        with self.lock, self.db:
            self._changed()
            self.db.execute('UPDATE schedule_runs SET job_id=?,state=?,error=? WHERE run_id=?',
                (job_id, 'failed' if error else 'started', error, run['run_id']))
            if job_id:
                self.db.execute('UPDATE schedules SET last_run_at=?,last_job_id=?,updated_at=? WHERE schedule_id=?',
                    (now, job_id, now, run['schedule_id']))
            elif halt:
                item = self._get(run['schedule_id'])
                if item and all(item[key] == run['schedule'][key] for key in ('scope_id', 'conversation_id')):
                    self.db.execute('UPDATE schedules SET enabled=0,next_run_at=NULL,updated_at=? WHERE schedule_id=?',
                                    (now, run['schedule_id']))

    def jobs(self):
        with self.lock:
            return [dict(zip(('run_id', 'schedule_id', 'job_id'), row)) for row in self.db.execute(
                "SELECT run_id,schedule_id,job_id FROM schedule_runs WHERE state='started' AND job_id IS NOT NULL").fetchall()]
