"""Durable product run records, distinct from SDK transcripts and UI speech history."""
import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from infra.store import IdleConnection

TERMINAL = frozenset(("completed", "failed", "cancelled", "interrupted"))
EVENT_METADATA = frozenset(("backend", "model", "tool", "tool_call_id", "task_id", "ok", "error", "outcome",
                            "revision", "source_run_id", "attempt", "tool_inventory_verified", "tool_count",
                            "queue_ms", "session_reused", "context_setup_ms", "adapter_ready_ms", "model_wait_ms",
                            "elapsed_ms", "duration_ms", "cli_version", "sdk_version", "work_kind",
                            "knowledge_ms", "memory_open_ms", "tools_offer_ms",
                            "context_build_ms", "lock_wait_ms", "look_wait_ms", "effort", "reasoning_tokens"))


class RunStore:
    def __init__(self, path, retention=lambda: None):
        """retention() -> seconds a run item is kept after its last update, None to keep every item."""
        self.retention = retention
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.touch(mode=0o600, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False, factory=IdleConnection)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA journal_size_limit=4194304")
        self.db.execute("PRAGMA secure_delete=ON")
        self.lock = threading.RLock()
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS character_runs (
              run_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL,
              generation INTEGER NOT NULL, state TEXT NOT NULL, scope_id TEXT, task_id TEXT,
              sdk_session_id TEXT, dependencies TEXT NOT NULL DEFAULT '[]', result TEXT,
              started_at REAL NOT NULL, ended_at REAL, delivery_eligible INTEGER NOT NULL DEFAULT 0,
              delivery_revoked INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS character_run_events (
              run_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, metadata TEXT NOT NULL,
              at REAL NOT NULL, PRIMARY KEY(run_id,seq));
            CREATE TABLE IF NOT EXISTS character_run_items (
              run_id TEXT NOT NULL, item_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
              phase TEXT, status TEXT NOT NULL, name TEXT, summary TEXT, text TEXT NOT NULL,
              parent_item_id TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL, steps TEXT,
              PRIMARY KEY(run_id,item_id));
            CREATE TABLE IF NOT EXISTS character_effects (
              effect_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, tool TEXT NOT NULL,
              input_hash TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT, at REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS character_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS character_checkpoints (
              run_id TEXT PRIMARY KEY, task_id TEXT, data TEXT NOT NULL, at REAL NOT NULL);
        """)
        self.db.execute("INSERT OR IGNORE INTO character_metadata VALUES('conversation_id',?)", (str(uuid.uuid4()),))
        self.db.execute("UPDATE character_runs SET state='interrupted',ended_at=? "
                        "WHERE state IN ('queued','running','awaiting_approval')", (time.time(),))
        self.db.execute("UPDATE character_effects SET state='unknown' WHERE state='prepared'")
        self.db.commit()
        self._closed = False
        self._redacted_runs = {row[0] for row in self.db.execute('SELECT run_id FROM character_runs WHERE delivery_revoked=1')}
        self._expire_items()

    def _expire_items(self):
        with self.lock:
            if self._closed:
                return
            keep = self.retention()
            if keep is not None:
                self.db.execute("DELETE FROM character_run_items WHERE updated_at<?", (time.time() - keep,))
                self.db.commit()
            self._item_expiry = threading.Timer(3600, self._expire_items)
            self._item_expiry.daemon = True
            self._item_expiry.start()

    def item(self, value):
        with self.lock:
            if not self.db.execute("SELECT 1 FROM character_runs WHERE run_id=?", (value['run_id'],)).fetchone():
                return
            text = (value.get('text') or '') if value['kind'] in ('assistant_text', 'reasoning_summary') else ''
            text = text.encode('utf-8')[:65536].decode('utf-8', errors='ignore')
            summary = value.get('summary')
            if value['run_id'] in self._redacted_runs:
                text, summary = '', None
            steps = json.dumps(value['steps']) if value.get('steps') is not None else None
            if value['run_id'] in self._redacted_runs:
                steps = None
            now = time.time()
            self.db.execute("INSERT INTO character_run_items(run_id,item_id,seq,kind,phase,status,name,summary,text,"
                "parent_item_id,created_at,updated_at,steps) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(run_id,item_id) DO UPDATE SET phase=COALESCE(excluded.phase,phase),"
                "status=excluded.status,name=COALESCE(excluded.name,name),summary=COALESCE(excluded.summary,summary),"
                "text=excluded.text,parent_item_id=COALESCE(excluded.parent_item_id,parent_item_id),updated_at=excluded.updated_at,"
                "steps=COALESCE(excluded.steps,steps)",
                (value['run_id'], value['item_id'], value['seq'], value['kind'], value.get('phase'), value['status'],
                 value.get('name'), summary[:200] if summary is not None else None,
                 text, value.get('parent_item_id'), now, now, steps))
            self.db.commit()

    def redact_items(self, run_ids):
        with self.lock:
            for run_id in run_ids:
                self._redacted_runs.add(run_id)
                self.db.execute("UPDATE character_runs SET delivery_eligible=0,delivery_revoked=1 WHERE run_id=?", (run_id,))
                self.db.execute("UPDATE character_run_items SET text='',summary=NULL,steps=NULL WHERE run_id=?", (run_id,))
                self.db.execute('DELETE FROM character_checkpoints WHERE run_id=?', (run_id,))
            self.db.commit()

    def items(self, run_id):
        with self.lock:
            rows = [dict(row) for row in self.db.execute(
                "SELECT * FROM character_run_items WHERE run_id=? ORDER BY seq", (run_id,))]
            for row in rows:
                row['steps'] = json.loads(row['steps']) if row['steps'] is not None else None
            return rows

    @property
    def conversation_id(self):
        with self.lock:
            return self.db.execute("SELECT value FROM character_metadata WHERE key='conversation_id'").fetchone()[0]

    def checkpoint(self, run_id, task_id, data):
        if task_id is not None and (not isinstance(task_id, str) or not task_id) or not isinstance(data, dict) or data.get("task_id") != task_id:
            raise ValueError("invalid_checkpoint")
        with self.lock:
            if run_id in self._redacted_runs: return False
            run = self.db.execute("SELECT task_id FROM character_runs WHERE run_id=?", (run_id,)).fetchone()
            if run is None:
                return False
            old = self.db.execute("SELECT task_id FROM character_checkpoints WHERE run_id=?", (run_id,)).fetchone()
            if run[0] not in (None, task_id) or old and old[0] not in (None, task_id):
                raise ValueError("checkpoint_task_conflict")
            encoded = json.dumps(data, ensure_ascii=False)
            self.db.execute("UPDATE character_runs SET task_id=? WHERE run_id=?", (task_id, run_id))
            self.db.execute("INSERT OR REPLACE INTO character_checkpoints VALUES(?,?,?,?)",
                            (run_id, task_id, encoded, time.time()))
            self.db.commit()
            return True

    def load_checkpoint(self, run_id=None, task_id=None):
        with self.lock:
            row = self.db.execute("SELECT run_id,data FROM character_checkpoints WHERE " +
                ("run_id=?" if run_id else "task_id=?") + " ORDER BY at DESC LIMIT 1",
                (run_id or task_id,)).fetchone()
        return {"run_id": row[0], **json.loads(row[1])} if row else None

    def begin(self, run_id, conversation_id, character_id, generation, scope_id=None, *, delivery_eligible=False):
        with self.lock:
            self.db.execute("INSERT INTO character_runs(run_id,conversation_id,character_id,generation,"
                            "state,scope_id,started_at,delivery_eligible) VALUES(?,?,?,?,?,?,?,?)",
                            (run_id, conversation_id, character_id, generation, "running", scope_id, time.time(), int(delivery_eligible is True)))
            self.db.commit()

    def event(self, run_id, kind, metadata):
        """Metadata only: callers must never pass model text, credentials, or tool bodies."""
        if not isinstance(metadata, dict) or set(metadata) - EVENT_METADATA or any(
                not (v is None or isinstance(v, (str, int, float, bool))) or
                isinstance(v, str) and len(v) > 256 for v in metadata.values()):
            raise ValueError("invalid_event_metadata")
        with self.lock:
            if not self.db.execute("SELECT 1 FROM character_runs WHERE run_id=?", (run_id,)).fetchone():
                return None
            seq = self.db.execute("SELECT COALESCE(MAX(seq),0)+1 FROM character_run_events WHERE run_id=?",
                                  (run_id,)).fetchone()[0]
            self.db.execute("INSERT INTO character_run_events VALUES(?,?,?,?,?)",
                            (run_id, seq, kind, json.dumps(metadata, ensure_ascii=False), time.time()))
            self.db.commit()
            return seq

    def finish(self, run_id, state, *, task_id=None, sdk_session_id=None, dependencies=(), result=None):
        if state not in TERMINAL | {"waiting_user"}:
            raise ValueError("invalid_run_state")
        with self.lock:
            old = self.db.execute("SELECT state FROM character_runs WHERE run_id=?", (run_id,)).fetchone()
            if old is None or old[0] in TERMINAL:
                return False
            self.db.execute("UPDATE character_runs SET state=?,task_id=?,sdk_session_id=?,dependencies=?,"
                            "result=?,ended_at=? WHERE run_id=?",
                            (state, task_id, sdk_session_id, json.dumps(list(dependencies)),
                             json.dumps(result, ensure_ascii=False), time.time(), run_id))
            self.db.commit()
            return True

    def get(self, run_id):
        with self.lock:
            row = self.db.execute("SELECT * FROM character_runs WHERE run_id=?", (run_id,)).fetchone()
        if row is None:
            return None
        value = dict(row)
        for key in ("dependencies", "result"):
            value[key] = json.loads(value[key]) if value[key] else None
        # finish() stamps ended_at on every state it sets, waiting_user included.
        value["state_since"] = value["ended_at"] if value["ended_at"] is not None else value["started_at"]
        return value

    def list(self, limit=50):
        with self.lock:
            ids = [row[0] for row in self.db.execute("SELECT run_id FROM character_runs ORDER BY started_at DESC LIMIT ?",
                                                    (max(1, min(int(limit), 100)),))]
        return [self.get(key) for key in ids]

    def tasks_since(self, character_id, since):
        """The latest run of each task this character started at or after since (epoch seconds), newest first."""
        with self.lock:
            rows = self.db.execute("SELECT task_id,conversation_id,MAX(started_at) AS started_at FROM character_runs "
                                   "WHERE character_id=? AND task_id IS NOT NULL AND started_at>=? "
                                   "GROUP BY task_id ORDER BY started_at DESC", (character_id, since)).fetchall()
        return [dict(row) for row in rows]

    def forget_runs(self, run_ids, *, conversation_id=None):
        with self.lock:
            if conversation_id is not None:
                run_ids = set(run_ids) | {r[0] for r in self.db.execute('SELECT run_id FROM character_runs WHERE conversation_id=?', (conversation_id,))}
                if 'conversation_id' in {r[1] for r in self.db.execute('PRAGMA table_info(character_interactions)')}:
                    self.db.execute('DELETE FROM character_interactions WHERE conversation_id=?', (conversation_id,))
            for ident in run_ids:
                for table in ('character_run_items', 'character_run_events', 'character_effects', 'character_checkpoints', 'character_runs'):
                    self.db.execute(f'DELETE FROM {table} WHERE run_id=?', (ident,))
                if self.db.execute("SELECT 1 FROM sqlite_master WHERE name='character_interactions'").fetchone():
                    self.db.execute('DELETE FROM character_interactions WHERE run_id=?', (ident,))
            self.db.commit()

    def forget(self):
        with self.lock:
            self.db.execute("DELETE FROM character_run_items")
            self.db.execute("DELETE FROM character_run_events")
            self.db.execute("DELETE FROM character_runs")
            self.db.execute("DELETE FROM character_effects")
            self.db.execute("DELETE FROM character_checkpoints")
            if self.db.execute("SELECT 1 FROM sqlite_master WHERE name='character_interactions'").fetchone():
                self.db.execute("DELETE FROM character_interactions")
            self.db.commit()
            self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    def close(self):
        with self.lock:
            if self._closed:
                return
            self._closed = True
            self._item_expiry.cancel()
            self.db.close()
