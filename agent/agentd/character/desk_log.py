"""Her touches, greetings and desk spans for the daily brief (personal.brief_day); times are epoch seconds."""
import threading
import time

COUNTED = ("pat", "pinch", "greet", "drag", "wheel")
SPANS = ("visible", "edge")
TICK = 60  # seconds between writes of a running span's until: what a crash can take off its end
PURGE_EVERY = 3600


class DeskLog:
    def __init__(self, db, lock=None, clock=time.time, retention=lambda: None):
        """retention() -> seconds a row is kept, None to keep every row."""
        self.db, self.clock, self.retention = db, clock, retention
        self.lock = threading.Lock() if lock is None else lock
        self._running = {}  # span kind -> id of its row; a span of an earlier process ends at its last until
        self._ticked = self._purged = None

    def count(self, kind):
        """One of COUNTED, now."""
        with self.lock:
            now = self.clock()
            self._purge(now)
            self.db.execute("INSERT INTO desk_log (kind, at) VALUES (?, ?)", (kind, now))
            self.db.commit()

    def span(self, kind, on):
        """Starts the span of kind (one of SPANS) when on and none runs; ends the running one when not on."""
        with self.lock:
            now, running = self.clock(), kind in self._running
            if on and not running:
                self._purge(now)
                self._running[kind] = self._start(kind, now)
            elif not on and running:
                self.db.execute("UPDATE desk_log SET until = ? WHERE id = ?", (now, self._running.pop(kind)))
            else:
                return
            self.db.commit()

    def tick(self):
        """Moves each running span's until to now, at most every TICK seconds; one whose row a reset deleted starts
        again now."""
        with self.lock:
            now = self.clock()
            if not self._running or self._ticked is not None and now - self._ticked < TICK:
                return
            self._ticked = now
            for kind, row in list(self._running.items()):
                if not self.db.execute("UPDATE desk_log SET until = ? WHERE id = ?", (now, row)).rowcount:
                    self._running[kind] = self._start(kind, now)
            self.db.commit()

    def reset(self, clear):
        """POST /reset: clear() deletes the rows under the lock; each running span keeps running without a row (a later
        insert could take a deleted row's id), and the next tick starts it again."""
        with self.lock:
            clear()
            self._running = dict.fromkeys(self._running)
            self._ticked = None

    def running(self):
        """The row ids of the spans that run now."""
        with self.lock:
            return {row for row in self._running.values() if row is not None}

    def _start(self, kind, now):
        return self.db.execute("INSERT INTO desk_log (kind, at, until) VALUES (?, ?, ?)", (kind, now, now)).lastrowid

    def _purge(self, now):
        if self._purged is not None and now - self._purged < PURGE_EVERY:
            return
        self._purged = now
        keep = self.retention()
        if keep is not None:
            self.db.execute("DELETE FROM desk_log WHERE COALESCE(until, at) < ?", (now - keep,))
