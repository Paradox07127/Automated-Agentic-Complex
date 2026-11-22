"""Personal episode storage, retrieval and display; generation belongs to the role harness."""
import datetime
import json
import threading
import time
from personal.history import terms
from sessions import threads

COLUMNS = ("id", "start", "end", "title", "description", "threads", "open_questions", "apps", "hosts", "created_at",
           "presence", "user_actions", "agent_actions", "version", "run_id", "edited", "owner")


LISTS = ("threads", "open_questions", "apps", "hosts", "user_actions", "agent_actions")  # stored as JSON arrays


FIELDS = f"{', '.join('e.' + c for c in COLUMNS)}, (SELECT r.state FROM memory_agent_runs r WHERE r.run_id = e.run_id)"


SELECT = f"SELECT {FIELDS} FROM episodes e"


SELECT_DAY = f"SELECT {FIELDS}, e.titles, e.typed FROM episodes e"  # day()'s and get()'s rows


CORRECTION_COLUMNS = ("episode_id", "at", "old_title", "old_description", "new_title", "new_description")


RECALL_MAX = 6  # episodes a time word recalls, spread over its range


RECALL_SEARCH_K = 2  # episodes a question without a time word recalls by search


STOP = set(terms("你在干嘛什么怎么样了刚才昨天今天之前一下我们这个那个"))  # words of the question, not its subject


JUST_NOW = ("刚才", "刚刚", "方才")


DAYS = (("前天", -2, None), ("昨天", -1, None), ("昨晚", -1, "晚上"), ("今天", 0, None), ("今早", 0, "早上"),
        ("今晚", 0, "晚上"))  # word, days from today, the part of the day it implies


PARTS = {"凌晨": (0, 6), "早上": (6, 10), "上午": (6, 12), "中午": (11, 14), "下午": (12, 18), "晚上": (18, 24)}


DAY_NAMES = {-2: "前天", -1: "昨天", 0: "今天"}


def _row(row):
    """An episode of a SELECT row, with outcome: the state of its run in memory_agent_runs, None without one."""
    episode = dict(zip(COLUMNS + ("outcome",), row))
    for column in LISTS:
        episode[column] = json.loads(episode[column])
    episode["edited"] = bool(episode["edited"])
    return episode


def _day_row(row):
    """An episode of a SELECT_DAY row."""
    return {**_row(row[:-2]), "titles": json.loads(row[-2]), "typed": bool(row[-1])}


def _body(title, description, threads, actions):
    """The episodes_fts body of an episode: the terms of its title, description, threads and actions."""
    return " ".join(terms(" ".join([title, description, *(json.dumps({k:t.get(k) for k in ("subject","goal","constraints","decisions","outcome","unresolved","next_steps")},ensure_ascii=False) for t in threads),
                                    *(a["text"] for a in actions)])))


def time_range(text, now):
    """(start, end, label) of the local time text asks about, end at most now; None without a time word or for a
    time that has not started."""
    if any(word in text for word in JUST_NOW):
        return now - 1800, now, "刚才半小时"
    day, offset, part = next(((word, offset, part) for word, offset, part in DAYS if word in text), (None, 0, None))
    part = next((name for name in PARTS if name in text), part)
    if day is None and part is None:
        return None
    midnight = datetime.datetime.combine(datetime.date.fromtimestamp(now) + datetime.timedelta(days=offset),
                                         datetime.time())
    first, last = PARTS[part] if part is not None else (0, 24)
    start = (midnight + datetime.timedelta(hours=first)).timestamp()
    end = (midnight + datetime.timedelta(hours=last)).timestamp()
    if start >= now:
        return None
    return start, min(end, now), DAY_NAMES[offset] + (part or "")


class Episodes:
    def __init__(self, db, lock=None, clock=time.time):
        self.db, self.clock = db, clock
        self.lock = threading.Lock() if lock is None else lock
        with self.lock:  # a deleted row's words leave the index pages too, not only the row
            self.db.execute("INSERT INTO episodes_fts(episodes_fts, rank) VALUES('secure-delete', 1)")
            self.db.commit()

    def between(self, start, end, *, character_id=None):
        """Episodes that overlap [start, end), oldest first."""
        with self.lock:
            rows = self.db.execute(f"{SELECT} WHERE e.start < ? AND e.end > ? AND (e.owner IS NULL OR e.owner IS ?) ORDER BY e.start, e.id",
                                   (end, start, character_id)).fetchall()
        return [_row(row) for row in rows]

    def day(self, date):
        """Episodes that start on the local date (a datetime.date), oldest first, with their titles and typed."""
        start = datetime.datetime.combine(date, datetime.time()).timestamp()
        end = datetime.datetime.combine(date + datetime.timedelta(days=1), datetime.time()).timestamp()
        with self.lock:
            rows = self.db.execute(f"{SELECT_DAY} WHERE e.start >= ? AND e.start < ? ORDER BY e.start, e.id",
                                   (start, end)).fetchall()
        return [_day_row(row) for row in rows]

    def get(self, episode_id):
        """The episode of episode_id as day() gives it, or None."""
        with self.lock:
            row = self.db.execute(f"{SELECT_DAY} WHERE e.id = ?", (episode_id,)).fetchone()
        return None if row is None else _day_row(row)

    def edit(self, episode_id, title, description):
        """The user's title and description for an episode, its index body rebuilt and the change recorded in
        summary_corrections; the episode as get() gives it, or None when it does not exist."""
        with self.lock:
            row = self.db.execute("SELECT title, description, threads, user_actions, agent_actions FROM episodes"
                                  " WHERE id = ?", (episode_id,)).fetchone()
            if row is None:
                return None
            old_title, old_description, threads, user_actions, agent_actions = row
            self.db.execute("UPDATE episodes SET title = ?, description = ?, edited = 1 WHERE id = ?",
                            (title, description, episode_id))
            self.db.execute("DELETE FROM episodes_fts WHERE rowid = ?", (episode_id,))
            self.db.execute("INSERT INTO episodes_fts (rowid, body) VALUES (?, ?)", (episode_id, _body(
                title, description, json.loads(threads), json.loads(user_actions) + json.loads(agent_actions))))
            self.db.execute(f"INSERT INTO summary_corrections ({', '.join(CORRECTION_COLUMNS)})"
                            f" VALUES ({', '.join('?' * len(CORRECTION_COLUMNS))})",
                            (episode_id, self.clock(), old_title, old_description, title, description))
            self.db.commit()
        return self.get(episode_id)

    def corrections(self, limit=8):
        """The user's latest edits, newest first."""
        with self.lock:
            rows = self.db.execute(f"SELECT {', '.join(CORRECTION_COLUMNS)} FROM summary_corrections"
                                   " ORDER BY at DESC, id DESC LIMIT ?", (limit,)).fetchall()
        return [dict(zip(CORRECTION_COLUMNS, row)) for row in rows]

    def search(self, query, k=3, *, character_id=None):
        """The k episodes that best match query (bm25)."""
        words = terms(query)
        if not words:
            return []
        match = " OR ".join(f'"{word}"' for word in words)
        with self.lock:
            rows = self.db.execute(f"{SELECT} JOIN episodes_fts ON e.id = episodes_fts.rowid"
                                   " WHERE episodes_fts MATCH ? AND (e.owner IS NULL OR e.owner IS ?) ORDER BY bm25(episodes_fts) LIMIT ?",
                                   (match, character_id, k)).fetchall()
        return [_row(row) for row in rows]

    def recall(self, text, now, *, character_id=None):
        """(label, episodes, overview) for a question: those of the time it names, at most RECALL_MAX spread over it,
        oldest first, and threads.day_arc() of the whole time; without a time word, label and overview None and the
        searched ones that share two words of text past STOP."""
        found = time_range(text, now)
        if found is not None:
            start, end, label = found
            rows = self.between(start, end, character_id=character_id)
            overview = threads.day_arc(rows)
            if len(rows) > RECALL_MAX:
                rows = [rows[round(i * (len(rows) - 1) / (RECALL_MAX - 1))] for i in range(RECALL_MAX)]
            return label, rows, overview
        words = set(terms(text)) - STOP
        return None, [e for e in self.search(text, k=RECALL_SEARCH_K, character_id=character_id)
                      if len(words & set(terms(" ".join([e["title"], e["description"], *(
                          f"{t['topic']} {t['progress']}" for t in e["threads"])])))) >= 2], None

    def delete_since(self, cutoff):
        """Episodes that end after cutoff go. Returns their ids."""
        with self.lock:
            return self._delete([row[0] for row in self.db.execute("SELECT id FROM episodes WHERE end > ?",
                                                                    (cutoff,))])

    def delete(self, ids):
        """The episodes of ids that exist go. Returns their ids."""
        with self.lock:
            found = [row[0] for row in self.db.execute(
                f"SELECT id FROM episodes WHERE id IN ({', '.join('?' * len(ids))})", list(ids))]
            return self._delete(found)

    def delete_matching(self, hides):
        """Episodes with an app, bundle id, host or window title that hides() matches go, and those whose title,
        description or thread topics a title pattern matches: the model may have copied a window title into them.
        Returns their ids."""
        with self.lock:
            rows = self.db.execute("SELECT id, apps, hosts, titles, title, description, threads FROM episodes"
                                   ).fetchall()
            return self._delete([row_id for row_id, apps, hosts, titles, title, description, threads in rows
                                 if any(hides({"app": x, "bundle_id": x, "url_host": None, "title": None})
                                        for x in json.loads(apps))
                                 or any(hides({"app": None, "bundle_id": None, "url_host": h, "title": None})
                                        for h in json.loads(hosts))
                                 or any(hides({"app": None, "bundle_id": None, "url_host": None, "title": t})
                                        for t in json.loads(titles))
                                 or any(hides({"app": None, "bundle_id": None, "url_host": None, "title": t})
                                        for t in [title, description, *(t["topic"] for t in json.loads(threads))])])

    def delete_permissions(self, revoked, dry=False):
        """Remove summaries whose actual source permissions were revoked; dry: their ids, deleting nothing."""
        with self.lock:
            ids=[]
            for ident,threads in self.db.execute('SELECT id,threads FROM episodes'):
                if {r for t in json.loads(threads) for r in t['requires']}.intersection(revoked): ids.append(ident)
            return ids if dry else self._delete(ids)

    def clear(self):
        with self.lock:
            deleted = self.db.execute("DELETE FROM episodes").rowcount
            self.db.execute("DELETE FROM episodes_fts")
            self.db.execute("DELETE FROM summary_corrections")
            self.db.commit()
        return deleted

    def _delete(self, ids):
        """Under the lock: the rows of ids, their index rows and corrections go; returns ids."""
        self.db.executemany("DELETE FROM episodes_fts WHERE rowid = ?", [(row_id,) for row_id in ids])
        self.db.executemany("DELETE FROM summary_corrections WHERE episode_id = ?", [(row_id,) for row_id in ids])
        self.db.executemany("DELETE FROM episodes WHERE id = ?", [(row_id,) for row_id in ids])
        self.db.commit()
        return ids
