"""Work memory storage: session summaries (L1), task cards (L2), day and week summaries (L3) and the chat text made
of them; the model calls that write them belong to character_agent.services.worklog."""
import datetime
import hashlib
import json
import secrets
import threading
import time

SESSION_COLUMNS = ("id", "character_id", "kind", "agent", "session_key", "project", "cwd", "day", "start", "end",
                   "status", "title", "body", "task_id", "yours", "agent_events", "away", "requires", "sources",
                   "input_sha256", "run_id", "model", "state", "attempts", "created_at", "updated_at")


TASK_COLUMNS = ("id", "character_id", "project", "title", "goal", "goal_authority", "status", "status_authority",
                "progress", "next_step", "blockers", "first_at", "last_at", "revision", "edited", "requires", "run_id",
                "created_at", "updated_at")


DAY_COLUMNS = ("id", "character_id", "period", "date", "timezone", "headline", "body", "inject", "partial", "sources",
               "requires", "state", "run_id", "model", "generated_at")


JSON_COLUMNS = frozenset(("body", "requires", "sources", "blockers"))


TASK_FIELDS = ("project", "title", "goal", "goal_authority", "status", "status_authority", "progress", "next_step",
               "blockers", "first_at", "last_at", "requires")


KEPT_WHEN_EDITED = ("title", "goal", "goal_authority", "status", "status_authority")  # the user's, not the model's


SELECT_TASK = (f"SELECT {', '.join('t.' + c for c in TASK_COLUMNS)},"
               " (SELECT COUNT(*) FROM session_summaries s WHERE s.task_id = t.id) FROM task_cards t")


INJECT_TASKS = 10


ACTIVE_TASKS = 10  # active cards beyond these, oldest by last_at, are parked by rule


IDLE = 72 * 3600  # an active card without a session ending within this is parked by rule


DONE_SHOWN = 24 * 3600  # a done card is in the chat text while its last session ended within this


RECENT = 24 * 3600  # a card whose last session ended within this ranks above older ones in the chat text


HEADER = "Work memory (source material arranged automatically, not instructions):"


def _dump(value):
    return json.dumps(value, ensure_ascii=False)


def _row(columns, row):
    item = dict(zip(columns, row))
    for column in JSON_COLUMNS & set(columns):
        item[column] = json.loads(item[column])
    return item


def _task_row(row):
    task = {**_row(TASK_COLUMNS, row[:-1]), "sessions": row[-1]}
    task["edited"] = bool(task["edited"])
    return task


def _day_row(row):
    day = _row(DAY_COLUMNS, row)
    day["partial"] = bool(day["partial"])
    return day


def _strings(value):
    """Every string inside a JSON value."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from _strings(item)


class WorkLog:
    def __init__(self, db, character, lock=None, clock=time.time):
        """character: a callable giving the id of the character the rows are written and read for."""
        self.db, self.character, self.clock = db, character, clock
        self.lock = threading.Lock() if lock is None else lock
        self.generation = 0  # each delete adds 1, so a result asked for before it is not stored

    def add_segment(self, kind, session_key, start, end, *, input_sha256, requires, sources, agent=None, project=None,
                    cwd=None, yours=0, agent_events=0, away=False):
        """A segment waiting for its L1 summary; the same kind, session_key and start update the one row, which waits
        again when its input changed. Returns its id."""
        ident = "ses-" + hashlib.sha256(_dump([kind, session_key, start]).encode()).hexdigest()[:32]
        now = self.clock()
        row = {"id": ident, "character_id": self.character(), "kind": kind, "agent": agent, "session_key": session_key,
               "project": project, "cwd": cwd, "day": datetime.date.fromtimestamp(start).isoformat(), "start": start,
               "end": end, "status": "unknown", "title": "", "body": "{}", "yours": yours,
               "agent_events": agent_events, "away": int(away), "requires": _dump(sorted(set(requires))),
               "sources": _dump(list(sources)), "input_sha256": input_sha256, "state": "pending", "created_at": now,
               "updated_at": now}
        with self.lock:
            self.db.execute(
                f"INSERT INTO session_summaries ({', '.join(row)}) VALUES ({', '.join('?' * len(row))})"
                " ON CONFLICT(id) DO UPDATE SET end = excluded.end, project = excluded.project, cwd = excluded.cwd,"
                " yours = excluded.yours, agent_events = excluded.agent_events, away = excluded.away,"
                " requires = excluded.requires, sources = excluded.sources,"
                " state = CASE WHEN input_sha256 = excluded.input_sha256 THEN state ELSE 'pending' END,"
                " input_sha256 = excluded.input_sha256, updated_at = excluded.updated_at", tuple(row.values()))
            self.db.commit()
        return ident

    def complete_segment(self, session_id, result, state="completed", run_id=None, model=None, generation=None):
        """The L1 result of a segment, or None with state failed or skipped; False when the segment
        does not exist or a delete has passed generation."""
        now = self.clock()
        with self.lock:
            if generation is not None and generation != self.generation:
                return False
            if result is None:
                cursor = self.db.execute("UPDATE session_summaries SET state = ?, attempts = attempts + 1, run_id = ?,"
                                         " model = ?, updated_at = ? WHERE id = ?",
                                         (state, run_id, model, now, session_id))
            else:
                cursor = self.db.execute(
                    "UPDATE session_summaries SET title = ?, status = ?, body = ?, state = ?, attempts = attempts + 1,"
                    " run_id = ?, model = ?, updated_at = ? WHERE id = ?",
                    (result["title"], result.get("status") or "unknown", _dump(result), state, run_id, model, now,
                     session_id))
            self.db.commit()
        return cursor.rowcount == 1

    def pending_sessions(self, limit=None):
        """Completed summaries no task card holds yet, oldest first."""
        with self.lock:
            rows = self.db.execute(f"SELECT {', '.join(SESSION_COLUMNS)} FROM session_summaries"
                                   " WHERE character_id = ? AND state = 'completed' AND task_id IS NULL"
                                   " ORDER BY start, id LIMIT ?",
                                   (self.character(), -1 if limit is None else limit)).fetchall()
        return [_row(SESSION_COLUMNS, row) for row in rows]

    def assign(self, session_id, task_id, generation=None):
        """The session goes to the task card, whose last_at and requires take in the session's; False when either
        does not exist, None when a delete has passed generation."""
        with self.lock:
            if generation is not None and generation != self.generation:
                return None
            session = self.db.execute("SELECT end, requires FROM session_summaries WHERE id = ? AND character_id = ?",
                                      (session_id, self.character())).fetchone()
            task = self.db.execute("SELECT last_at, requires FROM task_cards WHERE id = ? AND character_id = ?",
                                   (task_id, self.character())).fetchone()
            if session is None or task is None:
                return False
            now = self.clock()
            self.db.execute("UPDATE session_summaries SET task_id = ?, updated_at = ? WHERE id = ?",
                            (task_id, now, session_id))
            self.db.execute("UPDATE task_cards SET last_at = ?, requires = ?, updated_at = ? WHERE id = ?",
                            (max(task[0], session[0]), _dump(sorted(set(json.loads(task[1]) + json.loads(session[1])))),
                             now, task_id))
            self.db.commit()
        return True

    def upsert_task(self, task, run_id=None, generation=None):
        """A new card of task (TASK_FIELDS, blockers and requires lists), or the update of the card task["id"] names:
        its revision goes up, first_at and requires keep the card's, and an edited card keeps the user's title, goal
        and status. Returns its id; None when a delete has passed generation."""
        now = self.clock()
        row = {field: task[field] for field in TASK_FIELDS}
        with self.lock:
            if generation is not None and generation != self.generation:
                return None
            old = self._task(task["id"]) if "id" in task else None
            if old is None:
                ident = task.get("id") or "task-" + secrets.token_hex(8)
                row = {**row, "blockers": _dump(row["blockers"]), "requires": _dump(sorted(set(row["requires"])))}
                row.update(id=ident, character_id=self.character(), run_id=run_id, created_at=now, updated_at=now)
                self.db.execute(f"INSERT INTO task_cards ({', '.join(row)}) VALUES ({', '.join('?' * len(row))})",
                                tuple(row.values()))
            else:
                ident = old["id"]
                if old["edited"]:
                    row.update({field: old[field] for field in KEPT_WHEN_EDITED})
                row.update(first_at=min(old["first_at"], row["first_at"]), last_at=max(old["last_at"], row["last_at"]),
                           blockers=_dump(row["blockers"]), requires=_dump(sorted(set(old["requires"] + row["requires"]))),
                           run_id=run_id, updated_at=now)
                self.db.execute(f"UPDATE task_cards SET {', '.join(f'{c} = ?' for c in row)}, revision = revision + 1"
                                " WHERE id = ?", (*row.values(), ident))
            self.db.commit()
        return ident

    def merge_tasks(self, source, into, generation=None):
        """The sessions of card source go to card into, which takes in its first_at, last_at and requires; source
        goes. False when either does not exist or they are the same card, None when a delete has passed
        generation."""
        with self.lock:
            if generation is not None and generation != self.generation:
                return None
            a, b = self._task(source), self._task(into)
            if a is None or b is None or source == into:
                return False
            self.db.execute("UPDATE session_summaries SET task_id = ? WHERE task_id = ?", (into, source))
            self.db.execute("UPDATE task_cards SET first_at = ?, last_at = ?, requires = ?, revision = revision + 1,"
                            " updated_at = ? WHERE id = ?",
                            (min(a["first_at"], b["first_at"]), max(a["last_at"], b["last_at"]),
                             _dump(sorted(set(a["requires"] + b["requires"]))), self.clock(), into))
            self.db.execute("DELETE FROM task_cards WHERE id = ?", (source,))
            self.db.commit()
        return True

    def park_stale(self, now, most=ACTIVE_TASKS, idle=IDLE):
        """Active cards without a session ending within idle of now, and the oldest by last_at beyond most active
        cards, are parked by rule. Returns their ids."""
        with self.lock:
            rows = self.db.execute("SELECT id, last_at FROM task_cards WHERE character_id = ? AND status = 'active'"
                                   " ORDER BY last_at DESC, id", (self.character(),)).fetchall()
            parked = [ident for n, (ident, last_at) in enumerate(rows) if last_at < now - idle or n >= most]
            self.db.executemany("UPDATE task_cards SET status = 'parked', status_authority = 'rule',"
                                " revision = revision + 1, updated_at = ? WHERE id = ?",
                                [(self.clock(), ident) for ident in parked])
            self.db.commit()
        return parked

    def finish_landed(self, landed):
        """Active cards the user has not edited are done by rule, verified by git, when the latest of their sessions
        with a git snapshot was in a clean linked worktree whose HEAD was committed during that session and
        landed(root, head) finds it in the main tree. Returns their ids."""
        with self.lock:
            rows = self.db.execute("SELECT t.id, s.body, s.start FROM task_cards t JOIN session_summaries s ON s.task_id = t.id"
                                   " WHERE t.character_id = ? AND t.status = 'active' AND t.edited = 0"
                                   " AND json_extract(s.body, '$.git') IS NOT NULL ORDER BY s.start, s.id",
                                   (self.character(),)).fetchall()
        latest = {ident: (json.loads(body)["git"], start) for ident, body, start in rows}
        # git runs outside the lock; the update checks the card again.
        # A main checkout's HEAD, or a worker's base before its first commit, is in the main tree already.
        done = [ident for ident, (git, start) in latest.items() if git["dirty"] == 0 and git.get("linked")
                and git.get("committed_at", 0) >= start and landed(git["root"], git["head"])]
        with self.lock:
            self.db.executemany("UPDATE task_cards SET status = 'done', status_authority = 'tool_verified',"
                                " revision = revision + 1, updated_at = ? WHERE id = ? AND status = 'active'"
                                " AND edited = 0", [(self.clock(), ident) for ident in done])
            self.db.commit()
        return done

    def edit_task(self, task_id, expected_revision, title=None, goal=None, status=None):
        """The user's title, goal or status for a card. ("ok", card), ("conflict", card) unchanged when its
        revision is not expected_revision, or ("missing", None)."""
        changes = {"title": title} if title is not None else {}
        if goal is not None:
            changes.update(goal=goal, goal_authority="user_corrected")
        if status is not None:
            changes.update(status=status, status_authority="user_corrected")
        with self.lock:
            task = self._task(task_id)
            if task is None:
                return "missing", None
            if task["revision"] != expected_revision:
                return "conflict", task
            self.db.execute(f"UPDATE task_cards SET {''.join(f'{c} = ?, ' for c in changes)}edited = 1,"
                            " revision = revision + 1, updated_at = ? WHERE id = ?",
                            (*changes.values(), self.clock(), task_id))
            self.db.commit()
            return "ok", self._task(task_id)

    def tasks(self, statuses=None):
        """The character's cards, latest last_at first; statuses: only cards with one of them."""
        where, values = "t.character_id = ?", [self.character()]
        if statuses is not None:
            where += f" AND t.status IN ({', '.join('?' * len(statuses))})"
            values += list(statuses)
        with self.lock:
            rows = self.db.execute(f"{SELECT_TASK} WHERE {where} ORDER BY t.last_at DESC, t.id", values).fetchall()
        return [_task_row(row) for row in rows]

    def task(self, task_id):
        """The character's card of task_id, or None."""
        with self.lock:
            return self._task(task_id)

    def sessions_for_task(self, task_id):
        """The character's sessions assigned to task_id, oldest first."""
        with self.lock:
            rows = self.db.execute(f"SELECT {', '.join(SESSION_COLUMNS)} FROM session_summaries"
                                   " WHERE character_id = ? AND task_id = ? ORDER BY start, id",
                                   (self.character(), task_id)).fetchall()
        return [_row(SESSION_COLUMNS, row) for row in rows]

    def sessions_on(self, day):
        """The character's session summaries of the local date day (ISO), by start."""
        with self.lock:
            rows = self.db.execute(f"SELECT {', '.join(SESSION_COLUMNS)} FROM session_summaries"
                                   " WHERE character_id = ? AND day = ? ORDER BY start, id",
                                   (self.character(), day)).fetchall()
        return [_row(SESSION_COLUMNS, row) for row in rows]

    def put_day(self, period, date, summary, state="completed", run_id=None, model=None, generation=None):
        """The summary of period ('day' or 'week', date its Monday) replacing the one before; summary: timezone,
        headline, body, inject, partial, sources, requires. Returns its id; None when a delete has passed
        generation."""
        ident = f"{period}-{date}"
        row = {"id": ident, "character_id": self.character(), "period": period, "date": date,
               "timezone": summary["timezone"], "headline": summary["headline"], "body": _dump(summary["body"]),
               "inject": summary["inject"], "partial": int(summary["partial"]), "sources": _dump(summary["sources"]),
               "requires": _dump(sorted(set(summary["requires"]))), "state": state, "run_id": run_id, "model": model,
               "generated_at": self.clock()}
        with self.lock:
            if generation is not None and generation != self.generation:
                return None
            self.db.execute(f"INSERT OR REPLACE INTO day_summaries ({', '.join(row)})"
                            f" VALUES ({', '.join('?' * len(row))})", tuple(row.values()))
            self.db.commit()
        return ident

    def day(self, date, period="day"):
        """The character's summary of period at date, or None."""
        with self.lock:
            row = self.db.execute(f"SELECT {', '.join(DAY_COLUMNS)} FROM day_summaries"
                                  " WHERE character_id = ? AND period = ? AND date = ?",
                                  (self.character(), period, date)).fetchone()
        return None if row is None else _day_row(row)

    def inject(self, now, limit=2000, projects=()):
        """The chat's work-memory text, at most limit characters of whole lines, a line that does not fit left out:
        today's day summary inject, yesterday's headline, then up to INJECT_TASKS active cards and done cards within
        DONE_SHOWN that have a progress or next step, those of projects first, then those with last_at within
        RECENT, then those with a next step; "" with neither today's summary nor a card."""
        date = datetime.date.fromtimestamp(now)
        today = self.day(date.isoformat())
        yesterday = self.day((date - datetime.timedelta(days=1)).isoformat())
        cards = [c for c in self.tasks(("active", "done")) if (c["progress"] or c["next_step"])
                 and (c["status"] == "active" or c["last_at"] >= now - DONE_SHOWN)]
        cards = sorted(cards, key=lambda c: (c["project"] not in projects, c["last_at"] < now - RECENT,
                                             not c["next_step"]))[:INJECT_TASKS]
        if today is None and not cards:
            return ""
        lines = [f"Today {date:%m-%d}: {today['inject'] if today is not None else 'not summarized yet'}"]
        if yesterday is not None:
            lines.append(f"Yesterday: {yesterday['headline']}")
        lines += [f"- {c['title']} ({c['project'] + ', ' if c['project'] else ''}{c['status']})"
                  + (f": {c['progress']}" if c["progress"] else "")
                  + (f"; next step: {c['next_step']}" if c["next_step"] else "") for c in cards]
        text = HEADER
        for line in lines:
            if len(text) + 1 + len(line) <= limit:
                text += "\n" + line
        return text

    def delete_permissions(self, revoked):
        """Rows whose requires holds a revoked consent go. Returns their ids."""
        with self.lock:
            return self._delete(*([ident for ident, requires in self.db.execute(f"SELECT id, requires FROM {table}")
                                   if set(json.loads(requires)) & set(revoked)]
                                  for table in ("session_summaries", "task_cards", "day_summaries")))

    def delete_matching(self, hides):
        """Rows a window title pattern matches some text of go, and foreground segments of an app hides() matches.
        Returns their ids."""
        title = lambda text: hides({"app": None, "bundle_id": None, "url_host": None, "title": text})  # noqa: E731
        app = lambda name: hides({"app": name, "bundle_id": name, "url_host": None, "title": None})  # noqa: E731
        with self.lock:
            sessions = [ident for ident, kind, key, *texts, body in self.db.execute(
                "SELECT id, kind, session_key, title, project, cwd, body FROM session_summaries")
                if kind == "foreground" and app(key.split("|")[0])
                or any(title(t) for t in [key, *texts, *_strings(json.loads(body))] if t)]
            tasks = [ident for ident, *texts, blockers in self.db.execute(
                "SELECT id, title, goal, progress, next_step, project, blockers FROM task_cards")
                if any(title(t) for t in [*texts, *json.loads(blockers)] if t)]
            days = [ident for ident, headline, inject, body in self.db.execute(
                "SELECT id, headline, inject, body FROM day_summaries")
                if any(title(t) for t in [headline, inject, *_strings(json.loads(body))])]
            return self._delete(sessions, tasks, days)

    def clear(self):
        """Every row goes; the rows each table had."""
        with self.lock:
            deleted = {table: self.db.execute(f"DELETE FROM {table}").rowcount
                       for table in ("session_summaries", "task_cards", "day_summaries")}
            self.db.commit()
            self.generation += 1
        return deleted

    def _task(self, task_id):
        """Under the lock: the character's card of task_id, or None."""
        row = self.db.execute(f"{SELECT_TASK} WHERE t.id = ? AND t.character_id = ?",
                              (task_id, self.character())).fetchone()
        return None if row is None else _task_row(row)

    def _delete(self, sessions, tasks, days):
        """Under the lock: the rows of the ids go, the sessions of a deleted card wait for a card again; returns
        the ids."""
        self.db.executemany("DELETE FROM session_summaries WHERE id = ?", [(i,) for i in sessions])
        self.db.executemany("UPDATE session_summaries SET task_id = NULL WHERE task_id = ?", [(i,) for i in tasks])
        self.db.executemany("DELETE FROM task_cards WHERE id = ?", [(i,) for i in tasks])
        self.db.executemany("DELETE FROM day_summaries WHERE id = ?", [(i,) for i in days])
        self.db.commit()
        self.generation += 1
        return sessions + tasks + days
