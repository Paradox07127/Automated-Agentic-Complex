"""EffectLedger: the character_effects journal in runs.sqlite and the only API that prepares, settles and reads it."""
import json
import sqlite3
import threading
import time
from pathlib import Path
from types import SimpleNamespace


def ledger_path(state_dir):
    return Path(state_dir) / "character-agent" / "runs.sqlite"


class Effect:
    """One prepared effect. replay is the answer for an id prepared before (None for a new one)."""
    def __init__(self, ledger, effect_id, old):
        self.ledger, self.effect_id, self.settled = ledger, effect_id, old is not None
        self.replay = None if old is None else \
            old["receipt"] if old["state"] == "committed" else {"error": {"code": "effect_unknown"}}

    def settle(self, state, receipt):
        self.ledger.settle(self.effect_id, state, receipt)
        self.settled = True

    def __enter__(self):
        return self

    def __exit__(self, kind, error, trace):
        # Only an Exception settles: a process exit leaves the row prepared for the restart sweep.
        if kind is not None and issubclass(kind, Exception) and not self.settled:
            self.settle("unknown", {"effect": "unknown"})
        return False


class EffectLedger:
    def __init__(self, run_store):
        """Shares the RunStore connection and lock; RunStore owns the table and its restart sweep."""
        self.db, self.lock = run_store.db, run_store.lock

    @classmethod
    def open(cls, path):
        """A separate connection to an existing runs.sqlite (another process, or outside RunStore); raises sqlite3.Error."""
        db = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=rw", uri=True, timeout=5, check_same_thread=False)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA journal_mode=WAL")
        return cls(SimpleNamespace(db=db, lock=threading.RLock()))

    def prepare(self, effect_id, run_id, tool, input_hash):
        """The earlier row for effect_id, or None after inserting it as prepared."""
        with self.lock:
            old = self.db.execute("SELECT * FROM character_effects WHERE effect_id=?", (effect_id,)).fetchone()
            if old:
                value = dict(old)
                if value["input_hash"] != input_hash or value["run_id"] != run_id:
                    raise ValueError("effect_conflict")
                value["receipt"] = json.loads(value["receipt"]) if value["receipt"] else None
                return value
            self.db.execute("INSERT INTO character_effects VALUES(?,?,?,?,?,?,?)",
                            (effect_id, run_id, tool, input_hash, "prepared", None, time.time()))
            self.db.commit()
            return None

    def settle(self, effect_id, state, receipt):
        with self.lock:
            self.db.execute("UPDATE character_effects SET state=?,receipt=? WHERE effect_id=?",
                            (state, json.dumps(receipt, ensure_ascii=False), effect_id))
            self.db.commit()

    def effect(self, effect_id, run_id, tool, input_hash):
        """Prepares now; use the result as a context manager around the handler."""
        return Effect(self, effect_id, self.prepare(effect_id, run_id, tool, input_hash))

    def effects(self, run_id):
        with self.lock:
            rows = self.db.execute("SELECT * FROM character_effects WHERE run_id=? ORDER BY at", (run_id,)).fetchall()
        return [{**dict(row), "receipt": json.loads(row["receipt"]) if row["receipt"] else None} for row in rows]

    def forget_run(self, run_id):
        with self.lock:
            self.db.execute("DELETE FROM character_effects WHERE run_id=?", (run_id,))
            self.db.commit()

    def unsettled(self, run_id):
        return [e for e in self.effects(run_id) if e["state"] != "committed"]

    def reconcile(self, run_id, workspace):
        """The run's artifact effects after the workspace confirms or keeps unknown each prepared write."""
        return workspace.reconcile(run_id)
