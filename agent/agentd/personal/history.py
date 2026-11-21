"""Chat history:every mouth turn in the shared store; the mouth's window is read back from it."""
import re
import threading
import time
import uuid

from personal.conversations import COLUMNS, SHOWN, Conversations

SOURCES = ("text", "voice", "proactive", "announce", "ritual", "gift", "tap")
STATES = ("completed", "cancelled", "interrupted", "failed")
SELECT = f"SELECT {', '.join(COLUMNS)} FROM history_turns"
PAGE_MAX = 200
HEARD = "state IN ('completed', 'interrupted')"
# The user's own turns, of one character, or of every one when the character_id given (twice) is None.
SAID = "source IN ('text', 'voice') AND (? IS NULL OR character_id = ?)"
# Arguments: the match, character_id twice, character_id twice, skip_recent, k.
SEARCH = ("SELECT h.id, h.turn_id, h.character_id, h.source, h.user_text, h.reply, h.started_at"
          " FROM history_fts JOIN history_turns h ON h.id = history_fts.rowid"
          f" WHERE history_fts MATCH ? AND h.id IN (SELECT id FROM history_turns WHERE {HEARD} AND {SAID})"
          f" AND h.id NOT IN (SELECT id FROM history_turns WHERE {HEARD} AND {SAID} ORDER BY id DESC LIMIT ?)"
          " ORDER BY bm25(history_fts) LIMIT ?")
TOKEN = re.compile("[\u3400-\u9fff\uf900-\ufaff]+|[0-9a-z]+")


def terms(text):
    """Lowercased words; a run of CJK characters becomes its adjacent pairs (a lone character stays itself)."""
    out = []
    for run in TOKEN.findall(text.lower()):
        if run[0].isascii() or len(run) == 1:
            out.append(run)
        else:
            out.extend(run[i:i + 2] for i in range(len(run) - 1))
    return out


def _body(user_text, reply):
    return " ".join(terms(f"{user_text} {reply}"))


class History:
    def __init__(self, db, lock=None, clock=time.time):
        self.db, self.clock = db, clock
        self.lock = threading.Lock() if lock is None else lock
        self.conversations = Conversations(self)
        with self.lock:  # rows written before the index existed
            rows = self.db.execute(f"SELECT id, user_text, reply FROM history_turns WHERE {HEARD}"
                                   " AND id NOT IN (SELECT rowid FROM history_fts)").fetchall()
            self.db.executemany("INSERT INTO history_fts (rowid, body) VALUES (?, ?)",
                                [(row_id, _body(user_text, reply)) for row_id, user_text, reply in rows])
            self.db.commit()

    def record(self, *, turn_id, source, character_id, persona_revision, user_text, reply, state, started_at,
               raw_reply=None, conversation_id=None, resume_run_id=None):
        """reply: the text shown; raw_reply: the model's text with its markers, which the window re-sends.
        resume_run_id: the character-agent run this line resumes; page and turns then show no user_text."""
        if source not in SOURCES:
            raise ValueError(f"unknown source {source!r}")
        if state not in STATES:
            raise ValueError(f"unknown state {state!r}")
        event_id = str(uuid.uuid4())
        with self.lock:
            row_id = self.db.execute(
                f"INSERT INTO history_turns ({', '.join(COLUMNS[1:])}, resume_run_id) VALUES ({', '.join('?' * 12)})",
                (event_id, turn_id, source, character_id, persona_revision, user_text, reply, state,
                 started_at, self.clock(), raw_reply, resume_run_id)).lastrowid
            if state in ("completed", "interrupted"):
                self.db.execute("INSERT INTO history_fts (rowid, body) VALUES (?, ?)",
                                (row_id, _body(user_text, reply)))
            self.db.execute("INSERT INTO conversation_turns VALUES(?,?)", (event_id, conversation_id or self.conversations._active()))
            if user_text.strip():
                self.db.execute("UPDATE conversations SET title=?,revision=revision+1 WHERE id=? AND title='新对话'",
                                (user_text.strip().splitlines()[0][:80], conversation_id or self.conversations._active()))
            self.db.commit()
        return event_id

    def window(self, character_id, max_turns, names, with_ids=False):
        """The last max_turns completed or interrupted turns (those as heard), oldest first, as Mouth.history;
        other speakers are labelled. with_ids: (turn_id, turn) pairs instead."""
        with self.lock:
            # The API refuses an empty assistant turn before the last message.
            rows = self.db.execute("SELECT turn_id, character_id, user_text, COALESCE(raw_reply, reply)"
                                   " FROM history_turns"
                                   " WHERE state IN ('completed', 'interrupted')"
                                   " AND TRIM(COALESCE(raw_reply, reply), char(32, 9, 10, 13, 12288)) != ''"
                                   " AND event_id IN (SELECT event_id FROM conversation_turns WHERE conversation_id=?)"
                                   " ORDER BY id DESC LIMIT ?", (self.conversations._active(), max_turns)).fetchall()
        turns = []
        for turn_id, cid, user_text, reply in reversed(rows):
            if cid != character_id:
                reply = f"(said by {names.get(cid, cid)}) {reply}"
            turn = [{"role": "user", "content": user_text}, {"role": "assistant", "content": reply}]
            turns.append((turn_id, turn) if with_ids else turn)
        return turns

    def page(self, before=None, limit=50, stored=False):
        """(rows newest first with id < before, next before); next before is None when nothing older is left.
        Each row has its conversation_id, None for a turn linked to no conversation.
        stored: a resumed row keeps its user_text; otherwise it is '', as the UI shows it."""
        if not 1 <= limit <= PAGE_MAX:
            raise ValueError(f"limit must be 1-{PAGE_MAX}")
        where, args = ("", ()) if before is None else (" WHERE h.id < ?", (before,))
        with self.lock:
            columns = ", ".join("h." + c for c in COLUMNS) if stored else SHOWN
            rows = self.db.execute(f"SELECT {columns}, t.conversation_id FROM history_turns h"
                                   f" LEFT JOIN conversation_turns t ON t.event_id = h.event_id{where}"
                                   " ORDER BY h.id DESC LIMIT ?", (*args, limit + 1)).fetchall()
        rows = [dict(zip((*COLUMNS, "conversation_id"), row)) for row in rows]
        return rows[:limit], (rows[limit - 1]["id"] if len(rows) > limit else None)

    def retract(self, turn_id, blank=False):
        """Mark the turn's rows cancelled so the window leaves them out; blank: their words go too.
        Returns how many changed."""
        words = ", user_text = '', reply = '', raw_reply = NULL" if blank else ""
        with self.lock:
            if blank:  # a title record() took from these words goes with them
                said = self.db.execute("SELECT t.conversation_id, h.user_text FROM history_turns h JOIN conversation_turns t"
                                       " USING (event_id) WHERE h.turn_id = ?", (turn_id,)).fetchall()
                self.db.executemany("UPDATE conversations SET title='新对话',revision=revision+1 WHERE id=? AND title=?",
                                    [(ident, text.strip().splitlines()[0][:80]) for ident, text in said if text.strip()])
            changed = self.db.execute(f"UPDATE history_turns SET state = 'cancelled'{words} WHERE turn_id = ?",
                                      (turn_id,)).rowcount
            self.db.execute("DELETE FROM history_fts WHERE rowid IN (SELECT id FROM history_turns WHERE turn_id = ?)",
                            (turn_id,))
            self.db.commit()
        return changed

    def interrupt(self, turn_id, heard, cut=False):
        """The user cut the turn's speech; its completed or interrupted rows keep only what was heard.
        cut: the user cut its line while the line still streamed, so its cancelled rows do too."""
        states = ("completed", "interrupted", "cancelled") if cut else ("completed", "interrupted")
        among = f"state IN ({', '.join('?' * len(states))})"
        with self.lock:
            rows = self.db.execute(f"SELECT id, user_text, state FROM history_turns WHERE turn_id = ? AND {among}",
                                   (turn_id, *states)).fetchall()
            changed = self.db.execute("UPDATE history_turns SET state = 'interrupted', reply = ?, raw_reply = ?"
                                      f" WHERE turn_id = ? AND {among}", (heard, heard, turn_id, *states)).rowcount
            self.db.executemany("UPDATE history_fts SET body = ? WHERE rowid = ?",
                                [(_body(user_text, heard), row_id) for row_id, user_text, state in rows
                                 if state != "cancelled"])
            self.db.executemany("INSERT INTO history_fts (rowid, body) VALUES (?, ?)",  # a cancelled row has none
                                [(row_id, _body(user_text, heard)) for row_id, user_text, state in rows
                                 if state == "cancelled"])
            self.db.commit()
        return changed

    def clear(self):
        with self.lock:
            deleted = self.db.execute("DELETE FROM history_turns").rowcount
            self.db.execute("DELETE FROM history_fts")
            self.db.execute("DELETE FROM memory_agent_events WHERE run_id IN"
                            " (SELECT run_id FROM memory_agent_runs WHERE prompt_version='conversation-v2')")
            self.db.execute("DELETE FROM memory_agent_runs WHERE prompt_version='conversation-v2'")
            self.conversations.clear()
            self.db.commit()
        return deleted

    def search(self, query, k=2, skip_recent=8, character_id=None):
        """The k completed or interrupted text or voice turns that best match query (bm25), leaving out the newest
        skip_recent of them, which the window already holds. character_id None: every character's turns."""
        words = terms(query)
        if not words:
            return []
        match = " OR ".join(f'"{word}"' for word in words)
        with self.lock:
            rows = self.db.execute(SEARCH, (match, *(character_id,) * 4, skip_recent, k)).fetchall()
        return [dict(zip(("id", "turn_id", "character_id", "source", "user_text", "reply", "started_at"), row))
                for row in rows]

    def export(self):
        with self.lock:
            rows = self.db.execute(f"{SELECT} ORDER BY id").fetchall()
        return [dict(zip(COLUMNS, row)) for row in rows]
