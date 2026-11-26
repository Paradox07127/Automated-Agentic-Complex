"""Shown proactive messages and their user responses; times are epoch seconds."""
import threading
import time


class ProactiveLog:
    def __init__(self, db, lock=None):
        self.db = db
        self._lock = threading.RLock() if lock is None else lock

    def shown(self, id, channel, trigger, subject, text, offer, reply, at):
        """A new thought replaces the one shown before it: earlier unanswered thoughts are ignored."""
        self.prune(at)
        with self._lock, self.db:
            if channel == "thought":
                self.db.execute("UPDATE proactive_log SET outcome = 'ignored', outcome_at = ?"
                                " WHERE channel = 'thought' AND outcome IS NULL AND id != ?", (at, id))
            # Streaming completes the text without moving its response window or losing an outcome.
            self.db.execute("INSERT INTO proactive_log (id, channel, trigger, subject, text, offer, reply, shown_at)"
                            " VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET text = excluded.text",
                            (id, channel, trigger, subject, text, offer, reply, at))

    def said(self, text, reply_to=None, now=None):
        """reply_to {kind, id}: the line or thought the user answers; only that one is marked."""
        if reply_to is None:
            return
        now = time.time() if now is None else now
        with self._lock, self.db:
            self.db.execute("UPDATE proactive_log SET outcome = CASE WHEN channel = 'thought' AND reply = ?"
                            " THEN 'accepted' ELSE 'replied' END, outcome_at = ?"
                            " WHERE outcome IS NULL AND channel = ? AND id = ?",
                            (text, now, reply_to["kind"], reply_to["id"]))

    def text(self, kind, id):
        """The shown text of the line or thought `id`, or None."""
        with self._lock:
            row = self.db.execute("SELECT text FROM proactive_log WHERE channel = ? AND id = ?", (kind, id)).fetchone()
        return row and row[0]

    def entry(self, id):
        """(channel, outcome) of the line or thought `id`, or None."""
        with self._lock:
            return self.db.execute("SELECT channel, outcome FROM proactive_log WHERE id = ?", (id,)).fetchone()

    def ignore(self, id, now):
        with self._lock, self.db:
            self.db.execute("UPDATE proactive_log SET outcome = 'ignored', outcome_at = ? WHERE id = ? AND outcome IS NULL",
                            (now, id))

    def ignore_before(self, channel, before, now):
        """Unanswered entries of channel shown before `before` are ignored."""
        with self._lock, self.db:
            self.db.execute("UPDATE proactive_log SET outcome = 'ignored', outcome_at = ?"
                            " WHERE channel = ? AND outcome IS NULL AND shown_at < ?", (now, channel, before))

    def outcomes(self, trigger, count):
        """The outcomes of the `count` newest thoughts of trigger, newest first."""
        with self._lock:
            rows = self.db.execute("SELECT outcome FROM proactive_log WHERE channel = 'thought' AND trigger = ?"
                                   " ORDER BY shown_at DESC LIMIT ?", (trigger, count)).fetchall()
        return [outcome for (outcome,) in rows]

    def less(self):
        """The 少说点 factor on line and thought gaps; 1 until set."""
        with self._lock:
            row = self.db.execute("SELECT value FROM proactive_settings WHERE key = 'less'").fetchone()
        return 1 if row is None else float(row[0])

    def set_less(self, factor):
        with self._lock, self.db:
            self.db.execute("INSERT OR REPLACE INTO proactive_settings (key, value) VALUES ('less', ?)", (repr(factor),))

    def feedback(self, id, value, now=None):
        now = time.time() if now is None else now
        with self._lock, self.db:
            self.db.execute("UPDATE proactive_log SET outcome = ?, outcome_at = ? WHERE id = ?", (value, now, id))

    def stats(self, days, now=None):
        now = time.time() if now is None else now
        with self._lock:
            rows = self.db.execute("SELECT trigger, COUNT(*), SUM(CASE WHEN outcome = 'replied' THEN 1 ELSE 0 END),"
                                   " SUM(CASE WHEN outcome = 'accepted' THEN 1 ELSE 0 END),"
                                   " SUM(CASE WHEN outcome IS NOT NULL AND outcome NOT IN ('replied', 'accepted')"
                                   " THEN 1 ELSE 0 END) FROM proactive_log WHERE shown_at >= ? AND shown_at <= ?"
                                   " GROUP BY trigger", (now - days * 86400, now)).fetchall()
        return {trigger: dict(zip(("shown", "replied", "accepted", "feedback"), counts))
                for trigger, *counts in rows}

    def prune(self, now=None):
        now = time.time() if now is None else now
        with self._lock, self.db:
            self.db.execute("DELETE FROM proactive_log WHERE shown_at < ?", (now - 30 * 86400,))
