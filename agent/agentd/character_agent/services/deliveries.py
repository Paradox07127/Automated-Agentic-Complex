"""Durable delivery receipts over the existing task, job and run ledgers.

Execution truth remains in TaskLedger/JobStore. This ledger records what reached
the UI and what the user accepted; merely viewing a result grants no authority.
"""
import base64
import hashlib
import json
import re
import time

from infra.store_schemas import DELIVERY_SCHEMA as SCHEMA, ensure_delivery_schema as ensure_schema


TERMINAL_RESULTS = frozenset(('succeeded', 'needs_review', 'failed', 'accepted', 'rejected'))
ARTIFACT_FIELDS = ('artifact_id', 'path', 'absolute_path', 'version', 'self_checked', 'sha256', 'validation')
SAFE_CODE = re.compile(r'^[A-Za-z0-9_.:-]{1,160}$')
# Step summaries on the task card, by reply language code; None takes the Chinese ones.
STEP_SUMMARIES = {'zh-Hans': {'job': '任务状态更新', 'event': '状态更新', 'tool_call': '调用工具', 'tool_result': '工具已返回',
                              'assistant_text': '回复已生成', 'reasoning_summary': '整理思路', 'plan': '计划已更新', 'other': '步骤更新'},
                  'en': {'job': 'Task state changed', 'event': 'State changed', 'tool_call': 'Calling a tool', 'tool_result': 'Tool returned',
                         'assistant_text': 'Reply written', 'reasoning_summary': 'Thinking it through', 'plan': 'Plan updated', 'other': 'Step updated'},
                  'ja': {'job': 'タスクの状態が変わった', 'event': '状態が変わった', 'tool_call': 'ツールを呼び出し中', 'tool_result': 'ツールが返った',
                         'assistant_text': '返信を書いた', 'reasoning_summary': '考えを整理中', 'plan': '計画を更新した', 'other': 'ステップを更新した'}}


class DeliveryError(ValueError):
    def __init__(self, code, status=409):
        super().__init__(code)
        self.code, self.status = code, status


def _json(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':'))


def _code(value):
    return value if isinstance(value, str) and SAFE_CODE.fullmatch(value) else None


def _page(rows, cursor, limit, scope, key):
    if type(limit) is not int or not 1 <= limit <= 100:
        raise DeliveryError('invalid_limit', 400)
    after = None
    if cursor:
        try:
            if not isinstance(cursor, str) or len(cursor) > 2048: raise ValueError()
            value = json.loads(base64.urlsafe_b64decode(cursor.encode()))
            if value.get('v') != 1 or value.get('scope') != scope or not isinstance(value.get('after'), list): raise ValueError()
            after = tuple(value['after'])
        except (ValueError, TypeError, UnicodeError):
            raise DeliveryError('invalid_cursor', 400) from None
    rows = sorted(rows, key=key)
    try:
        if after is not None: rows = [row for row in rows if key(row) > after]
    except TypeError:
        raise DeliveryError('invalid_cursor', 400) from None
    selected = rows[:limit]
    next_cursor = base64.urlsafe_b64encode(_json({'v': 1, 'scope': scope, 'after': key(selected[-1])}).encode()).decode() \
        if len(rows) > limit else None
    return selected, next_cursor


class DeliveryService:
    def __init__(self, memory, run_store, tasks, jobs=None, *, clock=time.time, emit=lambda event: None, validate_scope=None):
        self.db, self.lock = memory.db, memory.lock
        self.runs, self.tasks, self.jobs = run_store, tasks, jobs
        self.clock, self.emit = clock, emit
        self.validate_scope = validate_scope
        from infra.store import path_of
        if tasks is not None and path_of(tasks.db) != path_of(self.db) or jobs is not None and jobs.db is not self.db:
            raise ValueError('delivery_shared_store_required')
        with self.lock:
            ensure_schema(self.db)
            self.db.commit()

    def _row(self, delivery_id):
        row = self.db.execute('SELECT * FROM personal_deliveries WHERE delivery_id=?', (delivery_id,)).fetchone()
        if row is None: return None
        columns = [column[1] for column in self.db.execute('PRAGMA table_info(personal_deliveries)')]
        value = dict(zip(columns, row))
        value.update(json.loads(value.pop('payload')))
        value.setdefault('summary', '')
        value.setdefault('artifacts', [])
        value['redacted'] = bool(value['redacted'])
        value['kind'] = 'task_notice'
        value['material_is_instruction'] = False
        return value

    def _emit(self, value):
        # Durable state commits before this best-effort notification. Snapshot is authoritative.
        event = {key: value.get(key) for key in ('delivery_id', 'canonical_task_id', 'run_id', 'conversation_id',
            'character_id', 'generation', 'revision', 'state', 'redacted')}
        try: self.emit(event)
        except Exception: pass

    def get(self, delivery_id):
        with self.lock:
            return self._row(delivery_id)

    def list(self, *, cursor=None, limit=50, conversation_id=None, character_id=None):
        with self.lock:
            where, args = [], []
            for key, value in (('conversation_id', conversation_id), ('character_id', character_id)):
                if value is not None: where.append(key + '=?'); args.append(value)
            ids = self.db.execute('SELECT delivery_id FROM personal_deliveries' +
                (' WHERE ' + ' AND '.join(where) if where else ''), args).fetchall()
            rows = [self._row(row[0]) for row in ids]
        values, next_cursor = _page(rows, cursor, limit, ['deliveries', conversation_id, character_id],
                                    lambda row: (-row['produced_at'], row['delivery_id']))
        return {'deliveries': values, 'next_cursor': next_cursor}

    def _job_rows(self):
        from character_agent.services.jobs import job_record
        return [job_record(row, private=True) for row in self.db.execute('SELECT * FROM personal_jobs')] if self.jobs else []

    def _ownership(self):
        """Called with RunStore then shared-store lock, matching produce/decision ordering."""
        runs = {row['run_id']: dict(row) for row in self.runs.db.execute(
            'SELECT run_id,task_id,conversation_id,character_id,generation,state,scope_id,started_at,ended_at FROM character_runs')}
        jobs = self._job_rows()
        job_runs, task_jobs = {}, {}
        for job in jobs:
            ids = {row[0] for row in self.db.execute('SELECT run_id FROM personal_job_runs WHERE job_id=?', (job['job_id'],))}
            for ident in ids:
                job_runs[ident] = job['job_id']
                if runs.get(ident, {}).get('task_id'): task_jobs[runs[ident]['task_id']] = job['job_id']
            if (job.get('result') or {}).get('task_id'): task_jobs[job['result']['task_id']] = job['job_id']
        return runs, jobs, job_runs, task_jobs

    def _canonical(self):
        runs, jobs, job_runs, task_jobs = self._ownership()
        from sessions.tasks import SELECT, _row
        task_rows = [_row(row) for row in self.db.execute(SELECT)] if self.tasks else []
        deliveries = [self._row(row[0]) for row in self.db.execute('SELECT delivery_id FROM personal_deliveries')]
        values = []
        for job in jobs:
            run = runs.get(job['run_id'])
            task_id = run['task_id'] if run else (job.get('result') or {}).get('task_id')
            value = {'canonical_task_id': 'job:' + job['job_id'], 'task_id': task_id, 'job_id': job['job_id'],
                'goal_id': job['goal_id'], 'run_id': job['run_id'], 'source_run_id': job['source_turn_id'],
                'parent_run_id': (job['payload'] or {}).get('source_run_id'), 'conversation_id': job['conversation_id'],
                'character_id': run['character_id'] if run else (job['payload'] or {}).get('character_id'),
                'generation': job['generation'], 'title': job['title'], 'state': job['state'],
                'created_at': job['created_at'], 'updated_at': job['updated_at']}
            values.append(value)
        for task in task_rows:
            if task['task_id'] in task_jobs: continue
            owned = [run for run in runs.values() if run['task_id'] == task['task_id']]
            run = max(owned, key=lambda r: (r['started_at'], r['run_id'])) if owned else None
            values.append({'canonical_task_id': 'task:' + task['task_id'], 'task_id': task['task_id'], 'job_id': None,
                'goal_id': None, 'run_id': run['run_id'] if run else None, 'source_run_id': None, 'parent_run_id': None,
                'conversation_id': run['conversation_id'] if run else None, 'character_id': run['character_id'] if run else None,
                'generation': run['generation'] if run else 0, 'title': task['title'], 'state': task['state'],
                'created_at': task['created_at'], 'updated_at': task['updated_at']})
            if run:
                checkpoint = self.runs.load_checkpoint(run_id=run['run_id'])
                values[-1]['source_run_id'] = (checkpoint or {}).get('source_run_id')
        for value in values:
            value['run_count'] = sum(1 for run in runs.values() if
                (job_runs.get(run['run_id']) == value['job_id'] if value['job_id'] else run['task_id'] == value['task_id']))
            delivery = next((row for row in deliveries if row['canonical_task_id'] == value['canonical_task_id'] and
                             row['run_id'] == value['run_id'] and row['generation'] == value['generation']), None)
            value['delivery'] = delivery
            value['revision'] = delivery['revision'] if delivery else 0
            value['verification_source'] = delivery['verification_source'] if delivery else None
            value['redacted'] = bool(delivery and delivery['redacted'])
            if value['redacted']: value['title'] = ''
        return values, runs, job_runs

    def tasks_page(self, *, cursor=None, limit=50, conversation_id=None, character_id=None):
        with self.runs.lock, self.lock:
            rows, _, _ = self._canonical()
        rows = [row for row in rows if (conversation_id is None or row['conversation_id'] == conversation_id) and
                (character_id is None or row['character_id'] == character_id)]
        values, next_cursor = _page(rows, cursor, limit, ['tasks', conversation_id, character_id],
                                    lambda row: (-row['created_at'], row['canonical_task_id']))
        return {'tasks': values, 'next_cursor': next_cursor}

    def task(self, canonical_task_id):
        with self.runs.lock, self.lock:
            return next((row for row in self._canonical()[0] if row['canonical_task_id'] == canonical_task_id), None)

    def produce(self, run_id, *, remember=True, summary=''):
        if remember is not True: return None
        with self.runs.lock, self.lock:
            if run_id in self.runs._redacted_runs: return None
            run = self.runs.get(run_id)
            if run is None or run['state'] not in ('completed', 'failed') or not run.get('delivery_eligible') or run.get('delivery_revoked'): return None
            if run['scope_id'] and self.validate_scope:
                try: self.validate_scope(run['scope_id'])
                except ValueError: return None
            old = self.db.execute('SELECT delivery_id FROM personal_deliveries WHERE run_id=?', (run_id,)).fetchone()
            if old: return self._row(old[0])
            values, _, _ = self._canonical()
            task = next((row for row in values if row['run_id'] == run_id), None)
            if task is None or task['state'] not in TERMINAL_RESULTS: return None
            if task['character_id'] != run['character_id'] or task['generation'] != run['generation']:
                raise DeliveryError('delivery_owner_changed')
            result = run.get('result') or {}
            job = next((row for row in self._job_rows() if row['job_id'] == task['job_id']), None)
            if not summary and job: summary = (job.get('result') or {}).get('reply') or ''
            if not isinstance(summary, str): raise DeliveryError('invalid_delivery_summary', 400)
            artifacts = [{key: item[key] for key in ARTIFACT_FIELDS if key in item}
                         for item in result.get('artifacts', [])[:12] if isinstance(item, dict)]
            payload = {'summary': summary[:4000], 'artifacts': artifacts}
            ident = 'delivery-' + hashlib.sha256(run_id.encode()).hexdigest()[:32]
            verified = task['state'] == 'succeeded'
            at = self.clock()
            version = self.db.execute('SELECT COALESCE(MAX(delivery_version),0)+1 FROM personal_deliveries WHERE canonical_task_id=?',
                                      (task['canonical_task_id'],)).fetchone()[0]
            self.db.execute('INSERT INTO personal_deliveries(delivery_id,canonical_task_id,run_id,task_id,job_id,goal_id,'
                'conversation_id,character_id,source_run_id,parent_run_id,scope_id,generation,state,outcome,verification_source,'
                'title,payload,produced_at,delivery_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                (ident, task['canonical_task_id'], run_id, task['task_id'], task['job_id'], task['goal_id'],
                 task['conversation_id'], task['character_id'], task['source_run_id'], task['parent_run_id'], run['scope_id'],
                 task['generation'], 'produced', task['state'], 'automatic_checks' if verified else 'unverified',
                 task['title'], _json(payload), at, version))
            self.db.execute('INSERT INTO personal_delivery_events VALUES(?,1,?,?,?)', (ident, 'produced', at, 'product'))
            self.db.commit()
            value = self._row(ident)
        self._emit(value)
        return value

    @staticmethod
    def _version(value, revision, generation):
        if type(revision) is not int or revision < 1 or type(generation) is not int or generation < 0:
            raise DeliveryError('invalid_delivery_revision', 400)
        if value['revision'] != revision or value['generation'] != generation:
            raise DeliveryError('delivery_version_changed')
        if value['redacted']: raise DeliveryError('delivery_revoked')

    def receipt(self, ident, action, *, expected_revision, generation):
        if action not in ('presented', 'viewed'): raise DeliveryError('invalid_delivery_receipt', 400)
        with self.lock:
            value = self._row(ident)
            if value is None: raise DeliveryError('unknown_delivery', 404)
            self._version(value, expected_revision, generation)
            field = action + '_at'
            if value[field] is not None: return value
            now = self.clock()
            # A detail view establishes presentation as well.
            presented = value['presented_at'] if value['presented_at'] is not None else now
            viewed = now if action=='viewed' else value['viewed_at']
            state = value['state'] if value['state'] in ('accepted', 'rejected') else action
            self.db.execute('UPDATE personal_deliveries SET presented_at=?,viewed_at=?,state=?,revision=revision+1 WHERE delivery_id=?',
                            (presented, viewed, state, ident))
            self.db.execute('INSERT INTO personal_delivery_events VALUES(?,?,?,?,?)',
                            (ident, value['revision'] + 1, state, now, 'user_view' if action == 'viewed' else 'ui_presented'))
            self.db.commit()
            value = self._row(ident)
        self._emit(value)
        return value

    def told(self, ident):
        """She said this delivery's result in its conversation. Revision 0 is outside the row's own revisions,
        so the row, its state and the UI's expected revision stay as they were."""
        with self.lock:
            self.db.execute('INSERT OR IGNORE INTO personal_delivery_events VALUES(?,0,?,?,?)',
                            (ident, 'told', self.clock(), 'role'))
            self.db.commit()

    def was_told(self, ident):
        with self.lock:
            return self.db.execute("SELECT 1 FROM personal_delivery_events WHERE delivery_id=? AND state='told'",
                                   (ident,)).fetchone() is not None

    def decide(self, canonical_task_id, ident, action, *, expected_revision, generation):
        if action not in ('accept', 'reject'): raise DeliveryError('invalid_delivery_decision', 400)
        with self.runs.lock, self.lock:
            value = self._row(ident)
            if value is None: raise DeliveryError('unknown_delivery', 404)
            self._version(value, expected_revision, generation)
            if value['scope_id'] and self.validate_scope:
                try: self.validate_scope(value['scope_id'])
                except ValueError: raise DeliveryError('delivery_scope_revoked') from None
            tasks, _, _ = self._canonical()
            task = next((row for row in tasks if row['canonical_task_id'] == canonical_task_id), None)
            if task is None: raise DeliveryError('unknown_task', 404)
            if value['canonical_task_id'] != canonical_task_id or value['run_id'] != task['run_id'] or \
                    value['generation'] != task['generation']:
                raise DeliveryError('delivery_superseded')
            if value['state'] in ('accepted', 'rejected'): raise DeliveryError('delivery_already_decided')
            if task['state'] not in ('needs_review', 'succeeded'): raise DeliveryError('task_not_reviewable')
            now, state = self.clock(), 'accepted' if action == 'accept' else 'rejected'
            decision = {'source': 'user', 'delivery_id': ident, 'run_id': value['run_id'], 'at': now}
            self.db.execute('BEGIN IMMEDIATE')
            try:
                if value['task_id'] and self.tasks:
                    self.tasks.review_in_transaction(self.db, value['task_id'], state, decision, now)
                if value['job_id'] and self.jobs:
                    self.jobs._review_result(value['job_id'], value['run_id'], generation, state, decision, now)
                if value['goal_id']:
                    self.db.execute('UPDATE personal_goals SET revision=revision+1,updated_at=? WHERE goal_id=?', (now, value['goal_id']))
                self.db.execute('UPDATE personal_deliveries SET state=?,revision=revision+1,decided_at=?,decision_source=? WHERE delivery_id=?',
                                (state, now, 'user', ident))
                self.db.execute('INSERT INTO personal_delivery_events VALUES(?,?,?,?,?)',
                                (ident, value['revision'] + 1, state, now, 'user'))
                self.db.commit()
            except Exception:
                self.db.rollback()
                raise
            result = {'task': next(row for row in self._canonical()[0] if row['canonical_task_id'] == canonical_task_id),
                      'delivery': self._row(ident)}
        self._emit(result['delivery'])
        return result

    def steps(self, canonical_task_id, *, cursor=None, limit=50, language=None):
        """language: the reply language code for the step summaries."""
        summaries = STEP_SUMMARIES.get(language, STEP_SUMMARIES['zh-Hans'])
        with self.runs.lock, self.lock:
            tasks, runs, job_runs = self._canonical()
            task = next((row for row in tasks if row['canonical_task_id'] == canonical_task_id), None)
            if task is None: raise DeliveryError('unknown_task', 404)
            ids = {run_id for run_id, job_id in job_runs.items() if job_id == task['job_id']} if task['job_id'] else \
                {run_id for run_id, run in runs.items() if run['task_id'] == task['task_id']}
            values = []
            if task['job_id']:
                attempts = [dict(zip(('run_id', 'generation', 'first_event_seq'), row)) for row in self.db.execute(
                    'SELECT run_id,generation,first_event_seq FROM personal_job_runs WHERE job_id=? ORDER BY generation', (task['job_id'],))]
                for event_id, seq, state, at in self.db.execute('SELECT event_id,seq,state,at FROM personal_job_events WHERE job_id=?', (task['job_id'],)):
                    candidates = [attempt for attempt in attempts if 0 < attempt['first_event_seq'] <= seq]
                    owner = candidates[-1] if candidates else {'run_id': None, 'generation': 0}
                    values.append({'step_id': 'job:' + event_id, 'run_id': owner['run_id'], 'generation': owner['generation'],
                        'kind': 'lifecycle', 'status': _code(state), 'phase': _code(state), 'name': None,
                        'summary': _code(state) or summaries['job'], 'at': at})
            for run_id in ids:
                run = runs.get(run_id)
                if run is None: continue
                for seq, kind, metadata, at in self.runs.db.execute(
                        'SELECT seq,kind,metadata,at FROM character_run_events WHERE run_id=?', (run_id,)):
                    meta = json.loads(metadata)
                    values.append({'step_id': run_id + ':event:' + str(seq), 'run_id': run_id, 'generation': run['generation'],
                        'kind': 'lifecycle', 'status': _code(kind), 'phase': _code(kind), 'name': _code(meta.get('tool')),
                        'summary': _code(kind) or summaries['event'], 'at': at})
                for row in self.runs.items(run_id):
                    kind = row['kind'] if row['kind'] in ('tool_call', 'tool_result', 'assistant_text', 'reasoning_summary', 'plan') else 'other'
                    values.append({'step_id': run_id + ':item:' + row['item_id'], 'run_id': run_id, 'generation': run['generation'],
                        'kind': kind, 'status': _code(row['status']), 'phase': _code(row['phase']), 'name': _code(row['name']),
                        'summary': summaries[kind],
                        'at': row['created_at']})
        page, next_cursor = _page(values, cursor, limit, ['steps', canonical_task_id], lambda row: (row['at'], row['step_id']))
        return {'steps': page, 'next_cursor': next_cursor}

    def task_runs(self, canonical_task_id):
        """The task's run ids, oldest first; None for an unknown task."""
        with self.runs.lock, self.lock:
            tasks, runs, job_runs = self._canonical()
            task = next((row for row in tasks if row['canonical_task_id'] == canonical_task_id), None)
            if task is None: return None
            ids = {run_id for run_id, job_id in job_runs.items() if job_id == task['job_id']} if task['job_id'] else \
                {run_id for run_id, run in runs.items() if run['task_id'] == task['task_id']}
        return sorted(ids & runs.keys(), key=lambda run_id: (runs[run_id]['started_at'], run_id))

    def revoke(self, run_ids=(), *, scope_id=None):
        with self.lock:
            ids = {row[0] for row in self.db.execute('SELECT delivery_id FROM personal_deliveries WHERE scope_id=?', (scope_id,))} if scope_id else set()
            for run_id in run_ids:
                ids.update(row[0] for row in self.db.execute('SELECT delivery_id FROM personal_deliveries WHERE run_id=?', (run_id,)))
            values = []
            for ident in ids:
                row = self._row(ident)
                if row['redacted']: continue
                self.db.execute("UPDATE personal_deliveries SET title='',payload='{}',redacted=1,revision=revision+1 WHERE delivery_id=?", (ident,))
                self.db.execute('INSERT INTO personal_delivery_events VALUES(?,?,?,?,?)',
                                (ident, row['revision'] + 1, 'revoked', self.clock(), 'privacy'))
                values.append(self._row(ident))
            self.db.commit()
        for value in values: self._emit(value)
        return len(values)

    def forget(self, run_ids=None, *, conversation_id=None):
        with self.lock:
            if run_ids is None and conversation_id is None:
                self.db.execute('DELETE FROM personal_delivery_events')
                self.db.execute('DELETE FROM personal_deliveries')
                self.db.execute('DELETE FROM personal_job_runs')
            else:
                ids = set()
                if conversation_id is not None:
                    ids.update(row[0] for row in self.db.execute('SELECT delivery_id FROM personal_deliveries WHERE conversation_id=?', (conversation_id,)))
                    self.db.execute('DELETE FROM personal_job_runs WHERE conversation_id=?', (conversation_id,))
                for run_id in run_ids or ():
                    ids.update(row[0] for row in self.db.execute('SELECT delivery_id FROM personal_deliveries WHERE run_id=?', (run_id,)))
                    self.db.execute('DELETE FROM personal_job_runs WHERE run_id=?', (run_id,))
                for ident in ids:
                    self.db.execute('DELETE FROM personal_delivery_events WHERE delivery_id=?', (ident,))
                    self.db.execute('DELETE FROM personal_deliveries WHERE delivery_id=?', (ident,))
            self.db.commit()
