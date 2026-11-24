"""<state-dir>/timeline.sqlite: one timeline of the Companion's desktop records in 10-minute segments, the only input
of the later local compaction, summaries and live understanding, and the one "now" state its records set."""
import json
import threading
import time

from infra.store import open_derived
from observation import now as now_rules
from observation.blacklist import HIDDEN

SCHEMA_VERSION = 1  # of the tables and of the stored now state (observation.now.EMPTY)
SEGMENT_S = 600
KEEP_S = 24 * 3600  # raw records
# A row that holds what clear_trees and clear_typed_text clear.
SCREEN = "tree_mode IS NOT NULL OR json_extract(target, '$.role') IS 'AXStaticText'"
TYPED = "text IS NOT NULL OR json_extract(target, '$.value') IS NOT NULL"
COLUMNS = ("ts", "segment", "kind", "app", "bundle_id", "pid", "window_id", "window_title", "url_host", "target",
           "keys", "text", "tree_mode", "tree_text")


class Timeline:
    def __init__(self, path, blacklist, clock=time.time):
        self.blacklist, self.clock = blacklist, clock
        self.lock = threading.Lock()
        self.db = open_derived(path, SCHEMA_VERSION)
        self.db.execute("PRAGMA secure_delete=ON")  # deleted rows are zeroed, so free pages keep no copy of them
        self.db.execute("CREATE TABLE IF NOT EXISTS timeline (id INTEGER PRIMARY KEY, ts REAL, segment INTEGER,"
                        " kind TEXT, app TEXT, bundle_id TEXT, pid INTEGER, window_id INTEGER, window_title TEXT,"
                        " url_host TEXT, target TEXT, keys TEXT, text TEXT, tree_mode TEXT, tree_text TEXT)")
        self.db.execute("CREATE INDEX IF NOT EXISTS timeline_segment_ts ON timeline (segment, ts)")
        self.db.execute("CREATE TABLE IF NOT EXISTS now (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)")
        # rowid: the segment's start; screen, typed: 1 when the summary's input held SCREEN or TYPED rows, its own or
        # those of the summaries before it; windows: the JSON [[app, bundle_id, url_host]] of those rows, likewise.
        # Summaries outlive the records; they go with the records they were made from, or with those windows.
        self.db.execute("CREATE VIRTUAL TABLE IF NOT EXISTS summaries USING fts5(text, screen UNINDEXED, typed UNINDEXED,"
                        " windows UNINDEXED, tokenize='unicode61')")
        row = self.db.execute("SELECT state FROM now").fetchone()
        self.state = json.loads(row[0]) if row else now_rules.EMPTY
        self.tree_generation = 0
        self.typed_generation = 0  # clear_typed_text() bumps it; a batch checked before that keeps no text
        self.floor = float("-inf")  # clock time of the last clear; nothing from before it is stored
        self.revision = 0  # every drop of summaries bumps it; a summary made from records read before that is not stored
        self.expire(clock())

    def close(self):
        with self.lock:
            self.db.close()

    def ingest(self, records, typed_generation=None, tree_generation=None):
        """Checked records (see api.views._timeline_record) in, less the blacklisted ones and those at or before the
        last clear; with a typed_generation other than the current one, text and target.value go. The stored ones
        advance the now state. Returns stored."""
        with self.lock:
            # Under the lock, so a clear() or a delete_hidden() meanwhile counts.
            kept = [r for r in records if r["ts"] > self.floor and not self._hidden(r)]
            stale = typed_generation is not None and typed_generation != self.typed_generation
            stale_tree = tree_generation is not None and tree_generation != self.tree_generation
            latest = self.db.execute("SELECT ts FROM timeline ORDER BY segment DESC, ts DESC LIMIT 1").fetchone()
            stored = []
            with self.db:  # all rows and the state or, when one fails, none
                for r in kept:
                    target = r["target"] if r["target"] is None or not stale else {**r["target"], "value": None}
                    if stale_tree and target and target["role"] == "AXStaticText":
                        target = {**target, "title": None}
                    tree = {} if stale_tree else r["tree"] or {}
                    row = (r["ts"], int(r["ts"] // SEGMENT_S) * SEGMENT_S, r["kind"], r["app"], r["bundle_id"],
                           r["pid"], r["window_id"], r["window_title"], r["url_host"],
                           None if target is None else json.dumps(target, ensure_ascii=False), r["keys"],
                           None if stale else r["text"], tree.get("mode"), tree.get("text"))
                    ident = self.db.execute(f"INSERT INTO timeline ({', '.join(COLUMNS)}) VALUES"
                                            f" ({', '.join('?' * len(COLUMNS))})", row).lastrowid
                    stored.append({**r, "id": ident, "target": target})
                if stored:
                    latest_ts = latest[0] if latest and self.state["start_id"] is not None else None
                    self._save(now_rules.advance(self.state, stored, self.clock(), latest_ts))
        self.expire(self.clock())
        return len(kept)

    def now(self):
        """The now state as its records allow: see observation.now.shown."""
        with self.lock:
            state = self.state
            ids = [i for i in (state["window_src"], *(a["id"] for a in state["actions"])) if i is not None]
            rows = self.db.execute(f"SELECT id, kind, app, bundle_id, url_host, window_title, target, text FROM timeline"
                                   f" WHERE id IN ({', '.join('?' * len(ids))})", ids).fetchall() if ids else []
        live = {}
        for row in rows:
            r = dict(zip(("id", "kind", "app", "bundle_id", "url_host", "window_title", "target", "text"), row))
            if not self._hidden(r):
                live[r["id"]] = {**r, "target": None if r["target"] is None else json.loads(r["target"])}
        return now_rules.shown(state, live)

    def _save(self, state):
        """Under the lock; the caller commits."""
        self.db.execute("INSERT OR REPLACE INTO now (id, state) VALUES (1, ?)", (json.dumps(state, ensure_ascii=False),))
        self.state = state

    def _prune(self, gone):
        """Under the lock: the stored state without what the deleted records gone(id, ts) put in it."""
        s = self.state
        state = {**s, "actions": [a for a in s["actions"] if not gone(a["id"], a["ts"])]}
        # since is no later than the window fields' record, so an expired record never stays.
        if s["window_src"] is not None and gone(s["window_src"], s["since"]):
            state.update(dict.fromkeys(now_rules.WINDOW), start_id=None, window_src=None)
        self._save(state)

    def segments(self, since=None):
        """[{segment, records, first_ts, last_ts}], oldest first; with since, the segments that end after it."""
        sql, args = "SELECT segment, COUNT(*), MIN(ts), MAX(ts) FROM timeline", ()
        if since is not None:
            sql, args = sql + " WHERE segment > ?", (since - SEGMENT_S,)
        with self.lock:
            rows = self.db.execute(sql + " GROUP BY segment ORDER BY segment", args).fetchall()
        return [{"segment": s, "records": n, "first_ts": first, "last_ts": last} for s, n, first, last in rows]

    def records(self, segment):
        """The records of one segment by ts, then arrival, each with its id."""
        with self.lock:
            rows = self.db.execute(f"SELECT id, {', '.join(COLUMNS)} FROM timeline WHERE segment = ?"
                                   " ORDER BY ts, id", (segment,)).fetchall()
        records = []
        for row in rows:
            r = dict(zip(("id", *COLUMNS), row))
            if self._hidden(r):  # the lists may have changed since it was stored
                continue
            del r["segment"]
            r["target"] = None if r["target"] is None else json.loads(r["target"])
            mode, text = r.pop("tree_mode"), r.pop("tree_text")
            r["tree"] = None if mode is None else {"mode": mode, "text": text}
            records.append(r)
        return records

    def expire(self, now):
        with self.lock:
            self.db.execute("DELETE FROM timeline WHERE ts < ?", (now - KEEP_S,))
            self._prune(lambda _, ts: ts < now - KEEP_S)
            self.db.commit()

    def clear(self, since=None):
        """Every row, or those from since; records sent later for the cleared span are not stored. Returns deleted."""
        with self.lock:
            self.floor = self.clock()
            if since is None:
                deleted = self.db.execute("DELETE FROM timeline").rowcount
                self._drop_summaries("1", ())
            else:
                deleted = self.db.execute("DELETE FROM timeline WHERE ts >= ?", (since,)).rowcount
                self._drop_summaries("rowid > ?", (since - SEGMENT_S,))  # the segments that end after since
            self._save(now_rules.EMPTY)
            self.db.commit()
        return deleted

    def delete_hidden(self, hides):
        """The rows whose window hides(window) matches go, and the summaries made from such a window. Returns deleted."""
        with self.lock:
            rows = self.db.execute("SELECT id, segment, app, bundle_id, url_host, window_title FROM timeline").fetchall()
            gone = [(rowid, segment) for rowid, segment, *window in rows
                    if hides(_window(dict(zip(("app", "bundle_id", "url_host", "window_title"), window))))]
            self.db.executemany("DELETE FROM timeline WHERE id = ?", [(rowid,) for rowid, _ in gone])
            ids = {rowid for rowid, _ in gone}
            self._prune(lambda rowid, _: rowid in ids)
            made = [segment for segment, windows in self.db.execute("SELECT rowid, windows FROM summaries")
                    if any(hides(_window(dict(zip(("app", "bundle_id", "url_host"), w)))) for w in json.loads(windows))]
            if gone or made:
                # Each later summary can carry earlier summaries forward through its context.
                self._drop_summaries("rowid >= ?", (min([segment for _, segment in gone] + made),))
            self.db.commit()
        return len(gone)

    def clear_typed_text(self, dry=False):
        """typed_text revoked or not allowed: every text and target.value goes; the rows stay.
        dry: the number of rows that hold either, changing nothing."""
        with self.lock:
            if dry:
                return self.db.execute(f"SELECT COUNT(*) FROM timeline WHERE {TYPED}").fetchone()[0]
            self.typed_generation += 1
            self.db.execute("UPDATE timeline SET text = NULL,"
                            " target = CASE WHEN target IS NULL THEN NULL ELSE json_set(target, '$.value', NULL) END")
            self._drop_summaries("typed = 1", ())
            self.db.commit()

    def clear_trees(self):
        """window_text revoked or not allowed: every tree and clicked text's label goes; the rows stay."""
        with self.lock:
            self.tree_generation += 1
            self.db.execute("UPDATE timeline SET tree_mode = NULL, tree_text = NULL, target = CASE"
                            " WHEN json_extract(target, '$.role') = 'AXStaticText' THEN json_set(target, '$.title', NULL)"
                            " ELSE target END")  # a clicked text is named by the text itself
            self._drop_summaries("screen = 1", ())
            self.db.commit()

    def add_summary(self, segment, text, revision):
        """The summary of the segment that starts at segment, in place of an older one, when no summaries were dropped
        since revision (self.revision when its records were read). True when it was stored."""
        with self.lock:
            if revision != self.revision:
                return False
            # Over every row of the segment and every summary of the hour before: no fewer than the model read.
            screen, typed = self.db.execute(f"SELECT MAX({SCREEN}), MAX({TYPED}) FROM timeline WHERE segment = ?",
                                            (segment,)).fetchone()
            before = self.db.execute("SELECT MAX(screen), MAX(typed) FROM summaries WHERE rowid < ? AND rowid >= ?",
                                     (segment, segment - 3600)).fetchone()
            windows = {tuple(w) for w in self.db.execute("SELECT DISTINCT app, bundle_id, url_host FROM timeline"
                                                         " WHERE segment = ?", (segment,))}
            for earlier, in self.db.execute("SELECT windows FROM summaries WHERE rowid < ? AND rowid >= ?",
                                            (segment, segment - 3600)):
                windows.update(tuple(w) for w in json.loads(earlier))
            with self.db:
                self.db.execute("DELETE FROM summaries WHERE rowid = ?", (segment,))
                self.db.execute("INSERT INTO summaries (rowid, text, screen, typed, windows) VALUES (?, ?, ?, ?, ?)",
                                (segment, text, int(bool(screen or before[0])), int(bool(typed or before[1])),
                                 json.dumps(sorted(windows, key=str), ensure_ascii=False)))
        return True

    def summarized(self):
        """The starts of the segments that have a summary."""
        with self.lock:
            return {segment for segment, in self.db.execute("SELECT rowid FROM summaries")}

    def summaries_before(self, segment, count):
        """The texts of the latest count summaries of the hour before segment, oldest first."""
        with self.lock:
            rows = self.db.execute("SELECT text FROM summaries WHERE rowid < ? AND rowid >= ? ORDER BY rowid DESC LIMIT ?",
                                   (segment, segment - 3600, count)).fetchall()
        return [text for text, in reversed(rows)]

    def summary(self, segment):
        """{segment, text} of one stored summary, or None."""
        with self.lock:
            row = self.db.execute("SELECT rowid, text FROM summaries WHERE rowid = ?", (segment,)).fetchone()
        return {"segment": row[0], "text": row[1]} if row is not None else None

    def summaries_in(self, start, end, limit=None):
        """[{segment, text}] of the summaries overlapping [start, end), newest first."""
        sql = "SELECT rowid, text FROM summaries WHERE rowid + ? > ? AND rowid < ? ORDER BY rowid DESC"
        args = (SEGMENT_S, start, end)
        if limit is not None:
            sql, args = sql + " LIMIT ?", (*args, limit)
        with self.lock:
            rows = self.db.execute(sql, args).fetchall()
        return [{"segment": segment, "text": text} for segment, text in rows]

    def summaries(self, since=None, before=None, limit=50):
        """[{segment, text}] of stored summaries, newest first."""
        clauses, args = [], []
        if since is not None:
            clauses.append("rowid >= ?")
            args.append(since)
        if before is not None:
            clauses.append("rowid < ?")
            args.append(before)
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        with self.lock:
            rows = self.db.execute(f"SELECT rowid, text FROM summaries{where} ORDER BY rowid DESC LIMIT ?",
                                   (*args, limit)).fetchall()
        return [{"segment": segment, "text": text} for segment, text in rows]

    def search_summaries(self, query, limit=10):
        """[{segment, text}] of the summaries holding every word of query, best match first."""
        words = " ".join('"' + w.replace('"', '""') + '"' for w in query.split())
        if not words:
            return []
        with self.lock:
            rows = self.db.execute("SELECT rowid, text FROM summaries WHERE summaries MATCH ? ORDER BY rank LIMIT ?",
                                   (words, limit)).fetchall()
        return [{"segment": segment, "text": text} for segment, text in rows]

    def delete_summary(self, segment):
        """True when there was one."""
        with self.lock:
            deleted = self._drop_summaries("rowid = ?", (segment,))
            self.db.commit()
        return deleted > 0

    def _drop_summaries(self, where, args):
        """Under the lock; the caller commits. optimize rewrites the index without the deleted text, whose old pages
        secure_delete zeroes; a plain delete leaves the words in the index's segments until a later merge."""
        self.revision += 1
        deleted = self.db.execute(f"DELETE FROM summaries WHERE {where}", args).rowcount
        if deleted:
            self.db.execute("INSERT INTO summaries (summaries) VALUES ('optimize')")
        return deleted

    def _hidden(self, record):
        return record["app"] == HIDDEN["app"] or self.blacklist.hides(_window(record))


def _window(record):
    """A record as the window the blacklist judges; its window title is matched as the title."""
    return {"app": record.get("app"), "bundle_id": record.get("bundle_id"), "url_host": record.get("url_host"),
            "title": record.get("window_title")}
