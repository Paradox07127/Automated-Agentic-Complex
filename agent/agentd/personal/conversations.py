"""Persisted role conversations."""
import json
import re
import uuid

# history_turns' columns in table order; history reads them from here
COLUMNS = ("id", "event_id", "turn_id", "source", "character_id", "persona_revision", "user_text", "reply",
           "state", "started_at", "ended_at", "raw_reply")
# COLUMNS of history_turns h as the UI reads them: a resumed row's user_text was shown on the row it resumes
SHOWN = ", ".join("CASE WHEN h.resume_run_id IS NULL THEN h.user_text ELSE '' END" if c == "user_text" else "h." + c
                  for c in COLUMNS)


class Conversations:
    def __init__(self, history, character_id, default_character):
        self.history = history
        self.db, self.lock = history.db, history.lock
        self.character_id = character_id
        self.run_store = None
        with self.lock, self.db:
            self.db.execute("CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1, created_at REAL NOT NULL, character_id TEXT NOT NULL)")
            self.db.execute("CREATE TABLE IF NOT EXISTS conversation_turns (event_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL)")
            self.db.execute("CREATE INDEX IF NOT EXISTS conversation_turns_conversation ON conversation_turns(conversation_id)")
            self.db.execute("CREATE TABLE IF NOT EXISTS conversation_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            if 'character_id' not in {r[1] for r in self.db.execute('PRAGMA table_info(conversations)')}:
                self.db.execute("ALTER TABLE conversations ADD COLUMN character_id TEXT")
                self.db.execute("UPDATE conversations SET character_id=COALESCE(("
                                "SELECT h.character_id FROM conversation_turns t JOIN history_turns h USING(event_id)"
                                " WHERE t.conversation_id=conversations.id GROUP BY h.character_id"
                                " ORDER BY COUNT(*) DESC,h.character_id LIMIT 1),?) WHERE character_id IS NULL",
                                (default_character,))
            self.db.execute("INSERT OR REPLACE INTO conversation_settings SELECT 'active:' || c.character_id,c.id"
                            " FROM conversations c JOIN conversation_settings s ON s.value=c.id WHERE s.key='active'")
            self.db.execute("DELETE FROM conversation_settings WHERE key='active'")
            if character_id is not None:
                self._active(character_id)

    def _active(self, character_id):
        row = self.db.execute("SELECT value FROM conversation_settings WHERE key=?", ('active:' + character_id,)).fetchone()
        return row[0] if row else self._create('新对话', character_id)

    @property
    def active(self):
        with self.lock, self.db:
            return self._active(self.character_id) if self.character_id is not None else None

    def use(self, character_id):
        with self.lock, self.db:
            self._active(character_id)
            self.character_id = character_id

    def _create(self, title, character_id):
        ident = uuid.uuid4().hex
        self.db.execute("INSERT INTO conversations(id,title,created_at,character_id) VALUES(?,?,?,?)",
                        (ident, title, self.history.clock(), character_id))
        self.db.execute("INSERT OR REPLACE INTO conversation_settings VALUES(?,?)", ('active:' + character_id, ident))
        return ident

    @staticmethod
    def title(value):
        if not isinstance(value, str) or not 0 < len(value.strip()) <= 80: raise ValueError('invalid_title')
        return value.strip()

    def create(self, title='新对话', character_id=None):
        title = self.title(title)
        with self.lock, self.db:
            ident = self._create(title, character_id or self.character_id)
        return self.get(ident)

    def _rows(self, where, value):
        with self.lock:
            cursor = self.db.execute(
                "SELECT c.*, COALESCE(MAX(h.ended_at),c.created_at) AS updated_at, COUNT(h.id) AS turn_count,"
                " s.value IS c.id AS active, (SELECT COALESCE(NULLIF(last.reply,''),last.user_text)"
                " FROM conversation_turns t JOIN history_turns last USING(event_id) WHERE t.conversation_id=c.id"
                " ORDER BY last.id DESC LIMIT 1) AS preview FROM conversations c"
                " LEFT JOIN conversation_settings s ON s.key='active:' || c.character_id"
                " LEFT JOIN conversation_turns t ON t.conversation_id=c.id LEFT JOIN history_turns h ON h.event_id=t.event_id"
                f" WHERE {where} GROUP BY c.id ORDER BY c.pinned DESC,updated_at DESC,c.id", (value,))
            keys = [c[0] for c in cursor.description]
            rows = [dict(zip(keys, row)) for row in cursor]
        for row in rows:
            shown = re.sub(r'\[[a-z_]+:[^\[\]\n]*\]', '', row['preview'] or '')
            row['preview'] = ' '.join(shown.split())[:60]
            for flag in ('active', 'pinned', 'archived'):
                row[flag] = bool(row[flag])
        return rows

    def list(self, character_id=None):
        character_id = character_id or self.character_id
        if character_id is not None and character_id == self.character_id:
            with self.lock, self.db:
                self._active(character_id)
        return self._rows('c.character_id=?', character_id)

    def get(self, ident):
        return next(iter(self._rows('c.id=?', ident)), None)

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

    def has_live_job(self, ident):
        """Caller holds the history lock, including the delete transaction when this protects a topic."""
        return self.db.execute("SELECT 1 FROM personal_jobs WHERE conversation_id=? AND state IN ('queued','running') LIMIT 1",
                               (ident,)).fetchone() is not None

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
        with self.lock, self.db:
            row = self.db.execute('SELECT revision,archived,character_id FROM conversations WHERE id=?', (ident,)).fetchone()
            if row is None: raise ValueError('unknown_conversation')
            revision, archived, character_id = row
            if revision != body['expected_version']: raise ValueError('version_conflict')
            active_key = 'active:' + character_id
            if activate:
                if archived: raise ValueError('archived')
                self.db.execute("INSERT OR REPLACE INTO conversation_settings VALUES(?,?)", (active_key, ident))
            elif delete:
                # A queued/running worker may have passed its current()
                # check before creating its TaskLedger row. Let it stop
                # before deleting ownership, as foreground deletion does.
                if self.has_live_job(ident):
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
            if (delete or body.get('archived')) and self.db.execute(
                    "SELECT 1 FROM conversation_settings WHERE key=? AND value=?", (active_key, ident)).fetchone():
                self._create('新对话', character_id)
        if delete and self.run_store is not None:
            self.run_store.forget_runs((), conversation_id=ident)
        return {'deleted': True} if delete else self.get(ident)

    def clear(self):
        # Caller holds history.lock.
        self.db.execute('DELETE FROM conversation_turns')
        self.db.execute('DELETE FROM conversations')
        self.db.execute('DELETE FROM conversation_settings')
        if self.character_id is not None:
            self._create('新对话', self.character_id)
