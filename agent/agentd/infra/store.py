"""agentd's shared SQLite file (0600, WAL): one table per feature; the caller names the file."""
import json
import os
from pathlib import Path
import sqlite3
import threading
import time
import traceback

from fsutil import atomic_write_text
from infra.store_schemas import (CONTINUOUS_OBSERVATION_SCHEMA, DELIVERY_SCHEMA, OBSERVATION_BRIEF_SCHEMA,
                           TASK_UNDERSTANDING_SCHEMA, WORKLOG_SCHEMA, SCHEDULE_SCHEMA)

MEMORY_AGENT_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS agent_memory_processed (source_id TEXT PRIMARY KEY, version TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS memory_tombstones (digest TEXT PRIMARY KEY, at REAL NOT NULL)",
    "CREATE TABLE IF NOT EXISTS fact_sightings (fact_id TEXT NOT NULL, source_id TEXT NOT NULL,"
    " day TEXT NOT NULL, confidence REAL NOT NULL, PRIMARY KEY(fact_id,source_id))",
    "CREATE TABLE IF NOT EXISTS personal_job_leases (job_id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at REAL NOT NULL)",
    "CREATE TABLE IF NOT EXISTS personal_goals (goal_id TEXT PRIMARY KEY, title TEXT NOT NULL, objective TEXT NOT NULL,"
    " state TEXT NOT NULL, revision INTEGER NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL)",
    "CREATE TABLE IF NOT EXISTS personal_jobs (job_id TEXT PRIMARY KEY, goal_id TEXT, title TEXT NOT NULL,"
    " state TEXT NOT NULL, run_id TEXT NOT NULL, previous_run_id TEXT, payload TEXT, result TEXT,"
    " created_at REAL NOT NULL, updated_at REAL NOT NULL, conversation_id TEXT, source_turn_id TEXT,"
    " generation INTEGER NOT NULL DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS personal_job_events (event_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, seq INTEGER NOT NULL,"
    " state TEXT NOT NULL, at REAL NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, UNIQUE(job_id,seq))",
    "CREATE TABLE IF NOT EXISTS memory_agent_runs (run_id TEXT PRIMARY KEY, backend TEXT NOT NULL, model TEXT NOT NULL,"
    " character_id TEXT NOT NULL, started_at REAL NOT NULL, finished_at REAL, state TEXT NOT NULL,"
    " prompt_version TEXT NOT NULL, input_sha256 TEXT NOT NULL, detail TEXT, redacted_reason TEXT)",
    "CREATE TABLE IF NOT EXISTS memory_agent_events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, at REAL NOT NULL,"
    " event TEXT NOT NULL, metadata TEXT NOT NULL, PRIMARY KEY(run_id, seq))",
)

SCHEMA = (
    # resume_run_id: the character-agent run this row resumes; NULL for a row that resumes none
    "CREATE TABLE IF NOT EXISTS history_turns (id INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE,"
    " turn_id TEXT, source TEXT NOT NULL, character_id TEXT NOT NULL, persona_revision TEXT,"
    " user_text TEXT NOT NULL, reply TEXT NOT NULL, state TEXT NOT NULL, started_at REAL NOT NULL,"
    " ended_at REAL NOT NULL, raw_reply TEXT, resume_run_id TEXT)",
    "CREATE INDEX IF NOT EXISTS history_turns_turn ON history_turns(turn_id)",
    # rowid = history_turns.id; body is history.terms() joined by spaces
    "CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(body, tokenize='unicode61')",
    "CREATE TABLE IF NOT EXISTS own_sessions (session_id TEXT PRIMARY KEY, origin TEXT, target TEXT NOT NULL,"
    " cwd TEXT NOT NULL, title TEXT NOT NULL, native_id TEXT, state TEXT NOT NULL, last_line TEXT,"
    " started_at REAL NOT NULL, updated_at REAL NOT NULL, mode TEXT NOT NULL DEFAULT 'read_only',"
    " seq INTEGER NOT NULL DEFAULT 0)",
    "CREATE TABLE IF NOT EXISTS trace_events (id INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE,"
    " trace_id TEXT NOT NULL, turn_id TEXT, producer TEXT NOT NULL, producer_epoch INTEGER NOT NULL,"
    " seq INTEGER NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, t_wall TEXT NOT NULL, t_recv_wall TEXT,"
    " day TEXT NOT NULL, stored_at REAL NOT NULL, event TEXT NOT NULL, text TEXT)",
    "CREATE INDEX IF NOT EXISTS trace_events_trace ON trace_events (trace_id)",
    "CREATE INDEX IF NOT EXISTS trace_events_kind ON trace_events (kind, stored_at)",
    "CREATE INDEX IF NOT EXISTS trace_events_stored ON trace_events (stored_at)",
    "CREATE INDEX IF NOT EXISTS trace_events_day ON trace_events (day)",
    "CREATE INDEX IF NOT EXISTS trace_events_inputs ON trace_events (kind, julianday(t_wall) DESC, id) WHERE kind='input.received'",
    "CREATE INDEX IF NOT EXISTS trace_events_input_turn ON trace_events (turn_id, id) WHERE kind='input.received'",
    "CREATE TABLE IF NOT EXISTS facts (id INTEGER PRIMARY KEY, fact_id TEXT NOT NULL, version INTEGER NOT NULL,"
    " kind TEXT NOT NULL, text TEXT, source TEXT NOT NULL, evidence TEXT NOT NULL, occurred_at REAL,"
    " recorded_at REAL NOT NULL, state TEXT NOT NULL, last_used_at REAL, reinforcement REAL NOT NULL DEFAULT 0,"
    " reinforced_at REAL, UNIQUE(fact_id, version))",
    "CREATE TABLE IF NOT EXISTS memory_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS fact_uses (fact_id TEXT NOT NULL, version INTEGER NOT NULL, line_id TEXT NOT NULL,"
    " used_at REAL NOT NULL, mode TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS fact_uses_fact ON fact_uses (fact_id, used_at)",
    "CREATE TABLE IF NOT EXISTS capture_budget (id INTEGER PRIMARY KEY, request_id TEXT UNIQUE NOT NULL,"
    " state TEXT NOT NULL, look INTEGER NOT NULL, reserved_at REAL NOT NULL, settled_at REAL)",
    "CREATE TABLE IF NOT EXISTS model_usage (id INTEGER PRIMARY KEY, day TEXT NOT NULL, model TEXT NOT NULL,"
    " call TEXT NOT NULL, calls INTEGER NOT NULL, input_tokens INTEGER NOT NULL,"
    " cache_creation_input_tokens INTEGER NOT NULL, cache_read_input_tokens INTEGER NOT NULL,"
    " output_tokens INTEGER NOT NULL, cost_usd REAL NOT NULL, incomplete INTEGER NOT NULL DEFAULT 0,"
    " failed INTEGER NOT NULL DEFAULT 0, cancelled INTEGER NOT NULL DEFAULT 0, local INTEGER NOT NULL DEFAULT 0,"
    " channel_json TEXT NOT NULL DEFAULT '{}', UNIQUE(day, model, call))",
    "CREATE TABLE IF NOT EXISTS character_state (character_id TEXT PRIMARY KEY, energy REAL, valence REAL,"
    " causes TEXT, updated_at REAL)",
    # one row per write of a changed character_state: at epoch seconds; cause: the last change's, NULL for drift alone
    "CREATE TABLE IF NOT EXISTS character_state_log (id INTEGER PRIMARY KEY, character_id TEXT NOT NULL,"
    " at REAL NOT NULL, energy REAL NOT NULL, valence REAL NOT NULL, cause TEXT)",
    "CREATE INDEX IF NOT EXISTS character_state_log_at ON character_state_log (character_id, at)",
    "CREATE TABLE IF NOT EXISTS ritual_log (day TEXT NOT NULL, kind TEXT NOT NULL, line_id TEXT NOT NULL,"
    " state TEXT NOT NULL, at REAL NOT NULL)",
    # data: the reminder's template fields as JSON; at: the clock time it fell due
    "CREATE TABLE IF NOT EXISTS ritual_pending (kind TEXT PRIMARY KEY, data TEXT NOT NULL, at REAL NOT NULL)",
    "CREATE TABLE IF NOT EXISTS own_session_lines (session_id TEXT NOT NULL, seq INTEGER NOT NULL,"
    " role TEXT NOT NULL, text TEXT NOT NULL, ts REAL NOT NULL, PRIMARY KEY (session_id, seq))",
    "CREATE TABLE IF NOT EXISTS tasks (task_id TEXT PRIMARY KEY, target TEXT NOT NULL, cwd TEXT NOT NULL,"
    " title TEXT NOT NULL, mode TEXT NOT NULL, state TEXT NOT NULL, verify_cmd TEXT, session_id TEXT,"
    " created_at REAL NOT NULL, updated_at REAL NOT NULL, result_json TEXT, requested_by TEXT)",
    "CREATE TABLE IF NOT EXISTS task_events (task_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,"
    " at REAL NOT NULL, attrs_json TEXT, PRIMARY KEY (task_id, seq))",
    # due_at NULL: a reminder waiting for its trigger
    "CREATE TABLE IF NOT EXISTS commitments (id TEXT PRIMARY KEY, text TEXT NOT NULL, due_at REAL,"
    " state TEXT NOT NULL, created_at REAL NOT NULL, created_line TEXT, delivered_line TEXT,"
    " updated_at REAL NOT NULL, revision INTEGER NOT NULL DEFAULT 1, repeat TEXT, trigger TEXT, seen_at REAL)",
    "CREATE INDEX IF NOT EXISTS commitments_due ON commitments (due_at)",
    # request: the JSON of [path, body] it answered; answer: the JSON of its (code, body)
    "CREATE TABLE IF NOT EXISTS idempotency_receipts (key TEXT PRIMARY KEY, request TEXT NOT NULL,"
    " answer TEXT NOT NULL, at REAL NOT NULL)",
    # day: a local date, ISO; count: proactive lines said that day; blocked: non-P0 lines refused that day
    "CREATE TABLE IF NOT EXISTS gate_day (day TEXT PRIMARY KEY, count INTEGER NOT NULL, blocked INTEGER NOT NULL)",
    # kind: a gate category the user muted (PUT /proactive/mutes, POST /feedback with mute)
    "CREATE TABLE IF NOT EXISTS gate_mute (kind TEXT PRIMARY KEY)",
    "CREATE TABLE IF NOT EXISTS proactive_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS proactive_log (id TEXT PRIMARY KEY, channel TEXT NOT NULL, trigger TEXT NOT NULL,"
    " subject TEXT, text TEXT NOT NULL, offer TEXT, reply TEXT, shown_at REAL NOT NULL, outcome TEXT, outcome_at REAL)",
    # threads, open_questions, apps, hosts, titles: JSON arrays; titles: the window titles of the span's events;
    # typed: 1 when an event of the span had typed text (a value, selection or prompt); presence, user_actions and
    # agent_actions: JSON arrays; version: 3; run_id: the memory_agent_runs row that wrote it; edited: 1 once the user
    # edited its title or description
    # AUTOINCREMENT: a deleted id is never given again, so a fact's "episode:<id>@<day>" evidence names one episode
    "CREATE TABLE IF NOT EXISTS episodes (id INTEGER PRIMARY KEY AUTOINCREMENT, start REAL NOT NULL, end REAL NOT NULL,"
    " title TEXT NOT NULL, description TEXT NOT NULL, threads TEXT NOT NULL, open_questions TEXT NOT NULL,"
    " apps TEXT NOT NULL, hosts TEXT NOT NULL, created_at REAL NOT NULL, titles TEXT NOT NULL, typed INTEGER NOT NULL,"
    " presence TEXT, user_actions TEXT NOT NULL, agent_actions TEXT NOT NULL,"
    " version INTEGER NOT NULL, run_id TEXT, edited INTEGER NOT NULL DEFAULT 0)",
    # rowid = episodes.id; body is history.terms() of the title, description and threads joined by spaces
    "CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(body, tokenize='unicode61')",
    # one row per user edit of an episode's title and description (PATCH /episodes/<id>); at: epoch seconds
    "CREATE TABLE IF NOT EXISTS summary_corrections (id INTEGER PRIMARY KEY AUTOINCREMENT,"
    " episode_id INTEGER NOT NULL, at REAL NOT NULL, old_title TEXT NOT NULL, old_description TEXT NOT NULL,"
    " new_title TEXT NOT NULL, new_description TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS summary_corrections_episode ON summary_corrections (episode_id)",
) + MEMORY_AGENT_SCHEMA + DELIVERY_SCHEMA + TASK_UNDERSTANDING_SCHEMA + OBSERVATION_BRIEF_SCHEMA + CONTINUOUS_OBSERVATION_SCHEMA + WORKLOG_SCHEMA + SCHEDULE_SCHEMA


class _Checkpoints:
    """The one thread that runs each connection's idle checkpoint once it falls due."""
    def __init__(self):
        self._wake = threading.Condition()
        self._due = {}  # connection -> time.monotonic() its checkpoint falls due
        self._thread = None

    def schedule(self, db, delay):
        with self._wake:
            self._due[db] = time.monotonic() + delay
            if self._thread is None:
                self._thread = threading.Thread(target=self._run, name="sqlite-checkpoint", daemon=True)
                self._thread.start()
            self._wake.notify()

    def cancel(self, db):
        with self._wake:
            self._due.pop(db, None)

    def _run(self):
        while True:
            with self._wake:
                now = time.monotonic()
                ready = [db for db, at in self._due.items() if at <= now]
                for db in ready:
                    del self._due[db]
                if not ready:
                    self._wake.wait(min(self._due.values()) - now if self._due else None)
                    continue
            for db in ready:
                try:
                    db._idle_checkpoint()
                except Exception:  # one connection's failure must not end every other connection's checkpoints
                    traceback.print_exc()


checkpoints = _Checkpoints()


class IdleConnection(sqlite3.Connection):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._idle_lock = threading.RLock()
        self._idle_scheduled = False
        self._written_at = None
        self._checkpoint_at = None
        self._changes = self.total_changes
        self._closed = False

    def execute(self, *args, **kwargs):
        with self._idle_lock:
            result = super().execute(*args, **kwargs)
            self._after_write()
            return result

    def executemany(self, *args, **kwargs):
        with self._idle_lock:
            result = super().executemany(*args, **kwargs)
            self._after_write()
            return result

    def executescript(self, *args, **kwargs):
        with self._idle_lock:
            result = super().executescript(*args, **kwargs)
            self._after_write()
            return result

    def commit(self):
        with self._idle_lock:
            super().commit()
            self._after_write()

    def rollback(self):
        with self._idle_lock:
            super().rollback()

    def __exit__(self, *args):
        with self._idle_lock:
            result = super().__exit__(*args)
            self._after_write()
            return result

    def _after_write(self):
        if self.total_changes != self._changes:
            self._changes = self.total_changes
            self._written_at = time.monotonic()
            if not self._idle_scheduled:
                self._schedule_checkpoint(30)

    def _schedule_checkpoint(self, delay):
        self._idle_scheduled = True
        checkpoints.schedule(self, delay)

    def _idle_checkpoint(self):
        with self._idle_lock:
            if self._closed:
                return
            self._idle_scheduled = False
            now = time.monotonic()
            delay = max(0, self._written_at + 30 - now,
                        0 if self._checkpoint_at is None else self._checkpoint_at + 300 - now)
            if self.in_transaction:
                delay = max(delay, 30)
            if delay:
                self._schedule_checkpoint(delay)
                return
            self._checkpoint_at = now
            try:
                super().execute("PRAGMA wal_checkpoint(PASSIVE)")
            except sqlite3.OperationalError as error:
                if error.sqlite_errorcode not in (sqlite3.SQLITE_LOCKED, sqlite3.SQLITE_BUSY):
                    raise
                self._schedule_checkpoint(300)

    def close(self):
        with self._idle_lock:
            self._closed = True
            if self._idle_scheduled:
                checkpoints.cancel(self)
                self._idle_scheduled = False
            super().close()


def open_store(path):
    os.close(os.open(path, os.O_CREAT, 0o600))  # created private before SQLite opens it
    db = sqlite3.connect(str(path), check_same_thread=False, factory=IdleConnection)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA journal_size_limit=4194304")
    db.execute("PRAGMA secure_delete=ON")  # deleted rows are zeroed, so a checkpoint leaves no copy of them
    # Reads go through the OS page cache instead of pread into SQLite's 2 MB heap cache; mapped pages are reclaimable.
    db.execute("PRAGMA mmap_size=268435456")
    for statement in SCHEMA:
        db.execute(statement)
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='observation_frame_cleanup'").fetchone():
        db.execute('''CREATE TRIGGER observation_frame_cleanup AFTER DELETE ON observation_frames BEGIN
            DELETE FROM observation_processed WHERE id=OLD.id;
            DELETE FROM observation_input_identity WHERE observation_id=OLD.id;
            DELETE FROM observation_aliases WHERE id=OLD.id OR canonical_id=OLD.id;
            DELETE FROM observation_content WHERE hash=OLD.content_hash
                AND NOT EXISTS (SELECT 1 FROM observation_frames WHERE content_hash=OLD.content_hash);
        END''')
        db.commit()
    return db


def path_of(db):
    """The file a connection has open."""
    return db.execute("PRAGMA database_list").fetchone()[2]


def compact(path):
    """VACUUM, then copy the WAL into the file and truncate it: deleted rows stay in neither free pages nor the WAL."""
    db = sqlite3.connect(path)
    try:
        db.execute("VACUUM")
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    finally:
        db.close()


def checkpoint(owner):
    """After a partial delete: the WAL goes into the file and is truncated, so no copy of the zeroed rows is left.
    owner: a store with db and lock."""
    with owner.lock:
        owner.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")


def count_rows(path, table):
    """COUNT(*) of table on a connection of its own."""
    db = sqlite3.connect(path)
    try:
        return db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    finally:
        db.close()


def rewrite_jsonl(path, keep):
    if path is None or not Path(path).exists():
        return
    path = Path(path)
    kept = []
    with path.open(encoding="utf-8") as source:
        for line in source:
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if keep(record):
                kept.append(line if line.endswith("\n") else line + "\n")
    atomic_write_text(path, "".join(kept))
