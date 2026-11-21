"""Persisted role conversations."""
import json
import uuid

# history_turns' columns in table order; history reads them from here
COLUMNS = ("id", "event_id", "turn_id", "source", "character_id", "persona_revision", "user_text", "reply",
           "state", "started_at", "ended_at", "raw_reply")
# COLUMNS of history_turns h as the UI reads them: a resumed row's user_text was shown on the row it resumes
SHOWN = ", ".join("CASE WHEN h.resume_run_id IS NULL THEN h.user_text ELSE '' END" if c == "user_text" else "h." + c
                  for c in COLUMNS)


class Conversations:
    def __init__(self, history):
        self.history = history
        self.db, self.lock = history.db, history.lock
        self.run_store = None
        with self.lock:
            self.db.execute("CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1, created_at REAL NOT NULL)")
            self.db.execute("CREATE TABLE IF NOT EXISTS conversation_turns (event_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL)")
            self.db.execute("CREATE INDEX IF NOT EXISTS conversation_turns_conversation ON conversation_turns(conversation_id)")
            self.db.execute("CREATE TABLE IF NOT EXISTS conversation_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            if not self.db.execute("SELECT 1 FROM conversation_settings WHERE key='active'").fetchone():
                self._create('新对话')
            self.db.commit()

    def _active(self):
        row = self.db.execute("SELECT value FROM conversation_settings WHERE key='active' AND value IN (SELECT id FROM conversations)").fetchone()
        if row: return row[0]
        ident = self._create('新对话')
        self.db.commit()
        return ident

    @property
    def active(self):
        with self.lock: return self._active()

    def _create(self, title):
        ident = uuid.uuid4().hex
        self.db.execute("INSERT INTO conversations(id,title,created_at) VALUES(?,?,?)", (ident, title, self.history.clock()))
        self.db.execute("INSERT OR REPLACE INTO conversation_settings VALUES('active',?)", (ident,))
        return ident

    @staticmethod
    def title(value):
        if not isinstance(value, str) or not 0 < len(value.strip()) <= 80: raise ValueError('invalid_title')
        return value.strip()

    def create(self, title='新对话'):
        title = self.title(title)
        with self.lock:
            ident = self._create(title)
            self.db.commit()
        return self.get(ident)

    def list(self):
        with self.lock:
            active = self._active()
            cursor = self.db.execute("SELECT c.*, COALESCE(MAX(h.ended_at),c.created_at) AS updated_at, COUNT(h.id) AS turn_count FROM conversations c LEFT JOIN conversation_turns t ON t.conversation_id=c.id LEFT JOIN history_turns h ON h.event_id=t.event_id GROUP BY c.id ORDER BY c.pinned DESC,updated_at DESC,c.id")
            keys = [c[0] for c in cursor.description]
            rows = [dict(zip(keys, row)) for row in cursor.fetchall()]
        return [{**row, 'pinned': bool(row['pinned']), 'archived': bool(row['archived']), 'active': row['id'] == active} for row in rows]

    def get(self, ident):
        return next((r for r in self.list() if r['id'] == ident), None)

    def owners_of_turns(self, turn_ids):
        """turn_id -> id of the newest stored conversation owning it; unowned turns are absent."""
        turn_ids = list(turn_ids)
        if not turn_ids: return {}
        with self.lock:
            rows = self.db.execute("SELECT h.turn_id, c.id FROM history_turns h JOIN conversation_turns t ON t.event_id=h.event_id "
                "JOIN conversations c ON c.id=t.conversation_id WHERE h.turn_id IN (" + ",".join("?" * len(turn_ids)) + ") "
                "ORDER BY h.id", turn_ids).fetchall()
        return dict(rows)

    def turns(self, ident, before=None, limit=100):
        if not self.get(ident): raise ValueError('unknown_conversation')
        if not 1 <= limit <= 200 or before is not None and before < 1: raise ValueError('invalid_cursor')
        with self.lock:
            cursor = self.db.execute("SELECT " + SHOWN + " FROM history_turns h JOIN conversation_turns t ON t.event_id=h.event_id WHERE t.conversation_id=? AND (? IS NULL OR h.id<?) ORDER BY h.id DESC LIMIT ?", (ident, before, before, limit + 1))
            rows = [dict(zip(COLUMNS, row)) for row in cursor.fetchall()]
        return {'turns': list(reversed(rows[:limit])), 'before': rows[limit - 1]['id'] if len(rows) > limit else None}

    def update(self, ident, body, *, activate=False, delete=False):
        allowed = {'expected_version'} if activate or delete else {'expected_version', 'title', 'pinned', 'archived'}
        if not isinstance(body, dict) or set(body) - allowed or type(body.get('expected_version')) is not int:
            raise ValueError('invalid_conversation_update')
        if not activate and not delete and len(body) < 2: raise ValueError('invalid_conversation_update')
        if 'title' in body: self.title(body['title'])
        if any(type(body[k]) is not bool for k in ('pinned', 'archived') if k in body): raise ValueError('invalid_conversation_update')
        task_ids, other_tasks = set(), set()
        if delete and self.run_store is not None:
            # Read the separate run DB before acquiring the domain-store lock.
            # Preserve any task also owned by a different retained conversation.
            with self.run_store.lock:
                for task_id, owner in self.run_store.db.execute(
                        'SELECT task_id,conversation_id FROM character_runs WHERE task_id IS NOT NULL'):
                    (task_ids if owner == ident else other_tasks).add(task_id)
        with self.lock:
            row = self.db.execute('SELECT revision,archived FROM conversations WHERE id=?', (ident,)).fetchone()
            if row is None: raise ValueError('unknown_conversation')
            if row[0] != body['expected_version']: raise ValueError('version_conflict')
            if activate:
                if row[1]: raise ValueError('archived')
                self.db.execute("UPDATE conversation_settings SET value=? WHERE key='active'", (ident,))
            elif delete:
                # A queued/running worker may have passed its current()
                # check before creating its TaskLedger row. Let it stop
                # before deleting ownership, as foreground deletion does.
                if self.db.execute("SELECT 1 FROM personal_jobs WHERE conversation_id=? AND state IN ('queued','running') LIMIT 1", (ident,)).fetchone():
                    raise ValueError('busy')
                for owner, raw in self.db.execute('SELECT conversation_id,result FROM personal_jobs WHERE result IS NOT NULL'):
                    result = json.loads(raw)
                    task_id = result.get('task_id') if isinstance(result, dict) else None
                    if isinstance(task_id, str):
                        (task_ids if owner == ident else other_tasks).add(task_id)
                for table in ('personal_job_events', 'personal_job_leases'):
                    self.db.execute('DELETE FROM ' + table + ' WHERE job_id IN (SELECT job_id FROM personal_jobs WHERE conversation_id=?)', (ident,))
                self.db.execute('DELETE FROM personal_jobs WHERE conversation_id=?', (ident,))
                for task_id in task_ids - other_tasks:
                    self.db.execute("DELETE FROM task_events WHERE task_id IN (SELECT task_id FROM tasks WHERE task_id=? AND target='character')", (task_id,))
                    self.db.execute("DELETE FROM tasks WHERE task_id=? AND target='character'", (task_id,))
                self.db.execute('DELETE FROM history_fts WHERE rowid IN (SELECT h.id FROM history_turns h JOIN conversation_turns t ON h.event_id=t.event_id WHERE t.conversation_id=?)', (ident,))
                self.db.execute('DELETE FROM history_turns WHERE event_id IN (SELECT event_id FROM conversation_turns WHERE conversation_id=?)', (ident,))
                self.db.execute('DELETE FROM conversation_turns WHERE conversation_id=?', (ident,))
                self.db.execute('DELETE FROM conversations WHERE id=?', (ident,))
            else:
                for key in ('title', 'pinned', 'archived'):
                    if key in body: self.db.execute(f'UPDATE conversations SET {key}=? WHERE id=?', (body[key].strip() if key == 'title' else body[key], ident))
            if not delete: self.db.execute('UPDATE conversations SET revision=revision+1 WHERE id=?', (ident,))
            if self._active() == ident and (delete or body.get('archived')): self._create('新对话')
            self.db.commit()
        if delete and self.run_store is not None:
            self.run_store.forget_runs((), conversation_id=ident)
        return {'deleted': True} if delete else self.get(ident)

    def clear(self):
        # Caller holds history.lock.
        self.db.execute('DELETE FROM conversation_turns')
        self.db.execute('DELETE FROM conversations')
        self._create('新对话')
