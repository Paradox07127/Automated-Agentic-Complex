"""Durable product jobs, not another model/tool loop. Each job uses its own harness.

The shared-store state and outbox commit together. RunStore/TaskLedger remain
authoritative for execution and verification; startup reconciles their outcome.
No SDK call is made while a database or scheduler lock is held.
"""
import json
import threading
import time
import uuid

from infra.store_schemas import ensure_delivery_schema


def encode(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


IDLE_WAIT = 5  # seconds an idle worker waits for a change before it looks again (retries, leases, goal changes)
JOB_COLUMNS = ('job_id', 'goal_id', 'title', 'state', 'run_id', 'previous_run_id',
               'payload', 'result', 'created_at', 'updated_at', 'conversation_id', 'source_turn_id', 'generation')


def job_record(row, private=False):
    if row is None:
        return None
    result = dict(zip(JOB_COLUMNS, row))
    result['result'] = json.loads(result['result']) if result['result'] else None
    if private:
        result['payload'] = json.loads(result['payload']) if result['payload'] else None
    else:
        result.pop('payload')
    return result


class JobStore:
    def __init__(self, memory, clock=time.time):
        self.db, self.lock, self.clock = memory.db, memory.lock, clock
        self.changed = threading.Condition()  # notified with each revision: a job event, or a goal's new state
        self.revision = 0
        with self.lock:
            ensure_delivery_schema(self.db)
            self.db.commit()

    def _remember_run(self, job_id, run_id, generation, conversation_id, payload, at):
        first_event_seq = self.db.execute('SELECT COALESCE(MAX(seq),0)+1 FROM personal_job_events WHERE job_id=?', (job_id,)).fetchone()[0]
        self.db.execute('INSERT OR IGNORE INTO personal_job_runs VALUES(?,?,?,?,?,?,?,?)',
            (job_id, run_id, generation, conversation_id, payload.get('character_id'), payload.get('source_run_id'), at, first_event_seq))

    def create_goal(self, title, objective):
        if not isinstance(title, str) or not 1 <= len(title.strip()) <= 200 or not isinstance(objective, str) or not 1 <= len(objective.strip()) <= 8000:
            raise ValueError('invalid_goal')
        ident, now = uuid.uuid4().hex, self.clock()
        with self.lock:
            self.db.execute("INSERT INTO personal_goals VALUES(?,?,?,'active',1,?,?)", (ident, title, objective, now, now))
            self.db.commit()
        return self.goal(ident)

    def goal(self, ident):
        with self.lock:
            row = self.db.execute('SELECT * FROM personal_goals WHERE goal_id=?', (ident,)).fetchone()
        return dict(zip(('goal_id', 'title', 'objective', 'state', 'revision', 'created_at', 'updated_at'), row)) if row else None

    def goals(self):
        with self.lock:
            ids = [r[0] for r in self.db.execute('SELECT goal_id FROM personal_goals ORDER BY updated_at DESC LIMIT 100')]
        return [self.goal(i) for i in ids]

    def update_goal(self, ident, revision, state):
        if type(revision) is not int or state not in ('active', 'paused', 'completed', 'cancelled'):
            raise ValueError('invalid_goal_update')
        with self.lock:
            row = self.db.execute('SELECT revision FROM personal_goals WHERE goal_id=?', (ident,)).fetchone()
            if not row: raise ValueError('unknown_goal')
            if row[0] != revision: raise ValueError('goal_version_changed')
            if state == 'completed':
                states = [r[0] for r in self.db.execute('SELECT state FROM personal_jobs WHERE goal_id=?', (ident,))]
                if not states or any(s not in ('succeeded', 'accepted') for s in states): raise ValueError('goal_results_not_verified')
            self.db.execute('UPDATE personal_goals SET state=?,revision=revision+1,updated_at=? WHERE goal_id=?',
                            (state, self.clock(), ident))
            self.db.commit()
        self.notify()
        return self.goal(ident)

    def notify(self):
        with self.changed:
            self.revision += 1
            self.changed.notify_all()

    def _event(self, ident, state):
        seq = self.db.execute('SELECT COALESCE(MAX(seq),0)+1 FROM personal_job_events WHERE job_id=?', (ident,)).fetchone()[0]
        self.db.execute('INSERT INTO personal_job_events(event_id,job_id,seq,state,at) VALUES(?,?,?,?,?)',
                        (uuid.uuid4().hex, ident, seq, state, self.clock()))
        self.notify()  # a waiting worker reads after this transaction, since it needs self.lock

    def submit(self, title, payload, goal_id=None, *, conversation_id=None, source_turn_id=None, require_conversation=False):
        if not isinstance(title, str) or not 1 <= len(title.strip()) <= 200 or not isinstance(payload, dict):
            raise ValueError('invalid_job')
        if goal_id is not None and (not isinstance(goal_id,str) or not 1 <= len(goal_id) <= 128):
            raise ValueError('invalid_job_goal')
        ident, run, now = uuid.uuid4().hex, 'bg-' + uuid.uuid4().hex, self.clock()
        with self.lock:
            if require_conversation and self.db.execute(
                    'SELECT 1 FROM conversations WHERE id=?', (conversation_id,)).fetchone() is None:
                raise ValueError('schedule_conversation_unavailable')
            if goal_id is not None:
                row = self.db.execute('SELECT state FROM personal_goals WHERE goal_id=?', (goal_id,)).fetchone()
                if row is None or row[0] != 'active': raise ValueError('goal_not_active')
            pending = self.db.execute("SELECT COUNT(*) FROM personal_jobs WHERE state IN ('queued','running')").fetchone()[0]
            if pending >= 20: raise ValueError('background_queue_full')
            self.db.execute("INSERT INTO personal_jobs(job_id,goal_id,title,state,run_id,payload,created_at,updated_at,conversation_id,source_turn_id) "
                            "VALUES(?,?,?,'queued',?,?,?,?,?,?)",
                            (ident, goal_id, title, run, encode(payload), now, now, conversation_id, source_turn_id))
            self._remember_run(ident, run, 0, conversation_id, payload, now)
            self._event(ident, 'queued')
            self.db.commit()
        return self.get(ident)

    def get(self, ident, private=False):
        with self.lock:
            row = self.db.execute('SELECT * FROM personal_jobs WHERE job_id=?', (ident,)).fetchone()
        return job_record(row, private)

    def list(self, *, goal_id=None, states=None, limit=100, private=False):
        """Bound public views; control operations explicitly request all matching work."""
        clauses, args = [], []
        if goal_id is not None:
            clauses.append('goal_id=?'); args.append(goal_id)
        if states is not None:
            if not states: return []
            clauses.append('state IN (' + ','.join('?' for _ in states) + ')'); args.extend(states)
        sql = 'SELECT * FROM personal_jobs'
        if clauses: sql += ' WHERE ' + ' AND '.join(clauses)
        sql += ' ORDER BY created_at DESC,rowid DESC'
        if limit is not None:
            if type(limit) is not int or limit < 1: raise ValueError('invalid_limit')
            sql += ' LIMIT ?'; args.append(limit)
        with self.lock:
            rows = self.db.execute(sql, args).fetchall()
        return [job_record(row, private) for row in rows]

    def results_since(self, cutoff, limit=100):
        """Recent completions include long-running jobs created before the public page."""
        with self.lock:
            rows = self.db.execute("SELECT * FROM personal_jobs WHERE updated_at>=? "
                "AND state IN ('succeeded','needs_review','failed','accepted','rejected') ORDER BY updated_at DESC,rowid DESC LIMIT ?",
                (cutoff,limit)).fetchall()
        return [job_record(row, private=True) for row in rows]

    def source_parents(self):
        with self.lock:
            rows = self.db.execute("SELECT DISTINCT json_extract(payload,'$.source_run_id') FROM personal_jobs "
                "WHERE json_extract(payload,'$.source_run_id') IS NOT NULL").fetchall()
        return [row[0] for row in rows]

    def leased(self, ident):
        with self.lock:
            row = self.db.execute('SELECT expires_at FROM personal_job_leases WHERE job_id=?', (ident,)).fetchone()
        return bool(row and row[0] > self.clock())

    def heartbeat(self, owner, run_ids=None):
        with self.lock:
            sql = 'UPDATE personal_job_leases SET expires_at=? WHERE owner=?'
            args = [self.clock() + 30, owner]
            if run_ids is not None:
                sql += ' AND job_id IN (SELECT job_id FROM personal_jobs WHERE run_id IN (' + ','.join('?' for _ in run_ids) + '))'
                args.extend(run_ids)
            self.db.execute(sql, args)
            self.db.commit()

    def claim(self, owner='local'):
        with self.lock:
            self.db.execute('BEGIN IMMEDIATE')
            row = self.db.execute("SELECT j.job_id FROM personal_jobs j LEFT JOIN personal_goals g ON g.goal_id=j.goal_id "
                "WHERE j.state='queued' AND (j.goal_id IS NULL OR g.state='active') ORDER BY j.created_at,j.rowid LIMIT 1").fetchone()
            if row is None:
                self.db.commit(); return None
            self.db.execute("UPDATE personal_jobs SET state='running',updated_at=? WHERE job_id=?", (self.clock(), row[0]))
            self.db.execute('INSERT OR REPLACE INTO personal_job_leases VALUES(?,?,?)', (row[0], owner, self.clock() + 30))
            self._event(row[0], 'running')
            claimed = self.db.execute('SELECT * FROM personal_jobs WHERE job_id=?', (row[0],)).fetchone()
            self.db.commit()
        return job_record(claimed, private=True)

    def settle(self, ident, state, result=None, *, from_states=('running',), expected_run_id=None, expected_generation=None):
        if state not in ('succeeded', 'needs_review', 'failed', 'cancelled', 'interrupted', 'waiting_user'):
            raise ValueError('invalid_job_state')
        with self.lock:
            sql = 'UPDATE personal_jobs SET state=?,result=?,updated_at=? WHERE job_id=? AND state IN (' + ','.join('?' for _ in from_states) + ')'
            args = [state, encode(result) if result is not None else None, self.clock(), ident, *from_states]
            if expected_run_id is not None:
                sql += ' AND run_id=?'; args.append(expected_run_id)
            if expected_generation is not None:
                sql += ' AND generation=?'; args.append(expected_generation)
            changed = self.db.execute(sql, args).rowcount
            if changed:
                self.db.execute('DELETE FROM personal_job_leases WHERE job_id=?', (ident,))
                self._event(ident, state)
            self.db.commit()
        return bool(changed)

    def resume(self, ident, *, text='', config=None, consent_epoch=None, start_fresh=False):
        if not isinstance(text, str) or len(text) > 8000: raise ValueError('invalid_job_revision')
        with self.lock:
            row = self.db.execute('SELECT state,run_id,payload,goal_id FROM personal_jobs WHERE job_id=?', (ident,)).fetchone()
            if row is None: raise ValueError('unknown_job')
            if row[0] not in ('interrupted', 'needs_review', 'failed', 'waiting_user', 'rejected') or row[2] is None: raise ValueError('job_not_resumable')
            if row[3] is not None:
                goal = self.db.execute('SELECT state FROM personal_goals WHERE goal_id=?', (row[3],)).fetchone()
                if not goal or goal[0] != 'active': raise ValueError('goal_not_active')
            payload = json.loads(row[2])
            if text.strip():
                payload['user_request'] = payload['user_request'] + '\nThe user adds this time: ' + text
                payload['instruction'] = payload['instruction'] + '\nThe user adds this time: ' + text
                if len(payload['user_request']) > 16000: raise ValueError('job_revision_too_large')
            if config is not None: payload['config'] = config
            if consent_epoch is not None: payload['consent_epoch'] = consent_epoch
            payload['start_fresh'] = start_fresh
            self.db.execute("UPDATE personal_jobs SET state='queued',previous_run_id=run_id,run_id=?,generation=generation+1,result=NULL,updated_at=? WHERE job_id=?",
                            ('bg-' + uuid.uuid4().hex, self.clock(), ident))
            self.db.execute('UPDATE personal_jobs SET payload=? WHERE job_id=?', (encode(payload), ident))
            current = self.db.execute('SELECT run_id,generation,conversation_id FROM personal_jobs WHERE job_id=?', (ident,)).fetchone()
            self._remember_run(ident, current[0], current[1], current[2], payload, self.clock())
            self._event(ident, 'queued'); self.db.commit()
        return self.get(ident)

    def pending_events(self):
        with self.lock:
            rows = self.db.execute('SELECT event_id,job_id,seq,state,at FROM personal_job_events WHERE delivered=0 ORDER BY at,rowid LIMIT 100').fetchall()
        return [dict(zip(('event_id', 'job_id', 'seq', 'state', 'at'), row)) for row in rows]

    def acknowledged(self, event_id):
        with self.lock:
            self.db.execute('UPDATE personal_job_events SET delivered=1 WHERE event_id=?', (event_id,)); self.db.commit()

    def clear(self):
        with self.lock:
            for table in ('personal_job_leases', 'personal_job_events', 'personal_job_runs', 'personal_jobs', 'personal_goals'): self.db.execute('DELETE FROM ' + table)
            self.db.commit()

    def _review_result(self, ident, run_id, generation, state, decision, now):
        """Under the delivery's shared-store transaction; never creates a second execution result."""
        if not self.db.in_transaction or state not in ('accepted', 'rejected'):
            raise ValueError('job_review_transaction_required')
        row = self.db.execute('SELECT run_id,generation,state,result FROM personal_jobs WHERE job_id=?', (ident,)).fetchone()
        if row is None or (row[0], row[1]) != (run_id, generation): raise ValueError('job_version_changed')
        if row[2] not in ('needs_review', 'succeeded'): raise ValueError('job_not_reviewable')
        result = json.loads(row[3]) if row[3] else {}
        result['user_acceptance'] = {**decision, 'state': state}
        self.db.execute('UPDATE personal_jobs SET state=?,result=?,updated_at=? WHERE job_id=?', (state, encode(result), now, ident))
        self._event(ident, state)


class JobCoordinator:
    def __init__(self, store, execute, cancel_runner, emit=lambda e: None, concurrency=2):
        self.store, self.execute, self.cancel_runner, self.emit = store, execute, cancel_runner, emit
        self.concurrency = concurrency
        self.lock = threading.RLock(); self.stopped = threading.Event()
        self.workers, self.cancels = [], {}
        self.owner = uuid.uuid4().hex
        self.heartbeat_thread = None

    def start(self):
        with self.lock:
            if self.stopped.is_set(): raise ValueError('scheduler_closed')
            if not self.workers:
                self.workers = [threading.Thread(target=self._work, name='personal-job-' + str(i), daemon=True) for i in range(self.concurrency)]
                self.heartbeat_thread = threading.Thread(target=self._heartbeat, name='personal-job-leases', daemon=True)
                self.heartbeat_thread.start()
                for worker in self.workers: worker.start()
            self.store.notify()

    def publish(self):
        with self.lock:
            for event in self.store.pending_events():
                try: self.emit(event)
                except Exception: return  # durable event remains pending for retry
                self.store.acknowledged(event['event_id'])

    def _work(self):
        while not self.stopped.is_set():
            try:
                seen = self.store.revision
                self.publish()
                with self.lock:
                    job = self.store.claim(self.owner) if not self.stopped.is_set() else None
                    if job:
                        cancel = threading.Event(); self.cancels[job['run_id']] = (job['job_id'], cancel)
                if job is None:
                    with self.store.changed:
                        if self.store.revision == seen and not self.stopped.is_set():
                            self.store.changed.wait(IDLE_WAIT)
                    continue
                try:
                    try:
                        value = self.execute(job, cancel)
                        state = value.pop('job_state', 'needs_review')
                    except Exception as exc:
                        # Exception messages can contain user material or credentials.
                        state, value = 'failed', {'error': type(exc).__name__, 'reason': None}
                        with self.store.lock: self.store.db.rollback()
                        self.stopped.wait(.25)
                    with self.lock:
                        self.store.settle(job['job_id'], state, value, expected_run_id=job['run_id'])
                finally:
                    with self.lock: self.cancels.pop(job['run_id'], None)
                self.publish()
            except Exception:
                with self.store.lock: self.store.db.rollback()
                self.stopped.wait(.25)

    def _heartbeat(self):
        while not self.stopped.wait(5):
            try:
                with self.lock:
                    if self.stopped.is_set(): return
                    self.store.heartbeat(self.owner, run_ids=list(self.cancels))
                    for job in self.store.list(states=('running',), limit=None):
                        if self.is_active(job['job_id'], job['run_id']) or self.store.leased(job['job_id']): continue
                        self.store.settle(job['job_id'], 'interrupted', {'reason': 'process_restarted'}, expected_run_id=job['run_id'])
                    self.publish()
            except Exception:
                with self.store.lock: self.store.db.rollback()
                self.stopped.wait(.25)

    def is_active(self, ident, run_id):
        with self.lock:
            entry = self.cancels.get(run_id)
            return entry is not None and entry[0] == ident

    def cancel(self, ident, reason='user_cancelled', *, interrupted=False, run_id=None, generation=None):
        with self.lock:
            changed = self.store.settle(ident, 'interrupted' if interrupted else 'cancelled', {'reason': reason},
                from_states=('queued', 'running', 'waiting_user') if run_id is not None else ('running',) if reason == 'shutdown' else ('queued', 'running', 'interrupted', 'waiting_user'),
                expected_run_id=run_id, expected_generation=generation)
            for active_run, (job_id, cancel) in self.cancels.items():
                if job_id == ident and (run_id is None or changed and active_run == run_id):
                    # A worker can finish before cancel_runner acquires its lock.
                    # Publish the reason and outcome before the cancellation bit.
                    cancel.reason, cancel.interrupted = reason, interrupted
                    cancel.set()
        if changed: self.cancel_runner(ident)
        self.publish(); self.store.notify()
        return changed

    def cancel_all(self, reason):
        for job in self.store.list(states=('queued', 'running', 'interrupted', 'waiting_user'), limit=None):
            if reason == 'shutdown' and job['state'] in ('queued', 'waiting_user'): continue
            if job['state'] in ('queued', 'running', 'interrupted', 'waiting_user'):
                self.cancel(job['job_id'], reason, interrupted=reason == 'shutdown')

    def close(self):
        with self.lock:
            self.stopped.set(); self.store.notify()
        self.cancel_all('shutdown')
        for worker in self.workers: worker.join(timeout=3)
        if self.heartbeat_thread: self.heartbeat_thread.join(timeout=1)
