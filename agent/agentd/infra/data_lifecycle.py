"""Shared-store data ownership. New tables must declare a reset policy before deletion succeeds."""
import sqlite3
from contextlib import closing

from infra.store import path_of

USER_DATA = frozenset(("history_turns", "own_sessions", "trace_events", "facts", "fact_uses", "fact_sightings",
                       "character_state", "character_state_log", "ritual_log", "ritual_pending", "own_session_lines", "tasks",
                       "task_events", "commitments", "schedules", "schedule_runs", "idempotency_receipts",
                       "episodes", "summary_corrections", "memory_agent_runs", "memory_agent_events",
                       "personal_goals", "personal_jobs", "personal_job_events", "personal_job_leases",
                       "agent_memory_processed", "memory_tombstones", "conversations", "conversation_turns",
                       "conversation_settings", "session_management", "personal_job_runs", "personal_deliveries",
                       "personal_delivery_events", "task_segments", "task_hypotheses", "observation_briefs", "observation_brief_failures",
                       "observation_content", "observation_frames", "observation_analyses", "observation_work_events", "observation_processed",
                       "observation_input_identity", "observation_aliases", "session_summaries", "task_cards",
                       "day_summaries", "proactive_log"))
# FTS5 indexes of user data: cleared through the virtual table, never counted (their rows repeat history_turns).
FTS = frozenset(("history_fts", "episodes_fts"))
# Settings and spent budgets survive reset: deletion must not reset a user's opt-out or evade a cap.
RETAINED = frozenset(("memory_settings", "capture_budget", "model_usage", "gate_day", "gate_mute", "semantic_attempts",
                      "proactive_settings"))


class DataLifecycle:
    def __init__(self, connections):
        self.paths = {path_of(db) for db in connections if db is not None}
        self.paths.discard("")
        self.tables = {}
        for path in self.paths:
            with closing(sqlite3.connect(path)) as db:
                tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")
                          if not r[0].startswith("sqlite_")
                          and not any(r[0].startswith(f"{fts}_") for fts in FTS)}  # FTS5 shadow tables
            if tables - USER_DATA - FTS - RETAINED:
                raise ValueError("unclassified user-data table")
            self.tables[path] = tables & (USER_DATA | FTS)

    def counts(self):
        counts = {}
        for path, tables in self.tables.items():
            with closing(sqlite3.connect(path)) as db:
                for table in tables - FTS:
                    counts[table] = counts.get(table, 0) + db.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        return counts

    def clear(self):
        for path, tables in self.tables.items():
            with closing(sqlite3.connect(path)) as db, db:
                for table in tables:
                    db.execute(f'DELETE FROM "{table}"')
