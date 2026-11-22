"""The one performance on the user's return from an absence: by how long the user was away and whether agent work
ended meanwhile, which row of RETURN_ROWS Spatial plays. The spoken summary is Proactive.back's."""
from collections import OrderedDict
import datetime
import threading
import time

from observation.spatial import RETURN_ROWS

SHORT = 120.0  # seconds away under which a return plays nothing
LONG = 600.0  # seconds away from which she welcomes fully
ENDED_KEPT = 1024  # terminal occurrences remembered
BLOCKING = ("offstage", "quiet")  # stages a return plays nothing on


class Return:
    def __init__(self, spatial, greet, clock=time.time):
        """spatial: the Spatial that plays the row, whose stage() is user_now's; greet() -> the saved
        greet_on_resume switch."""
        self.spatial, self.greet, self.clock = spatial, greet, clock
        self._ended = OrderedDict()  # occurrence id -> clock time it was first seen
        self._welcomes = []  # (local date, Spatial's record) of the latest day's returns with a welcome row
        self._lock = threading.Lock()  # nothing else is locked under it

    def ended(self, occurrence_id):
        """A done or error terminal of any session or role run, from Consumed; a resend of one is the same one."""
        with self._lock:
            if occurrence_id not in self._ended:
                self._ended[occurrence_id] = self.clock()
                while len(self._ended) > ENDED_KEPT:
                    self._ended.popitem(last=False)

    def returned(self, event):
        """user_now's user.return: the row by its away_s and the terminals since the absence began, played unless the
        return was short, greet_on_resume is off or the stage is offstage or quiet. Returns Spatial's record, which
        its later parts update."""
        ts, away = event["ts"], event["data"]["away_s"]
        with self._lock:
            ended = sum(1 for at in self._ended.values() if ts - away <= at <= ts)
        if away < SHORT:
            row = None
        elif away < LONG:
            row = "look_report" if ended else "look_welcome"
        else:
            row = "welcome_report" if ended else "welcome"
        why = "short" if row is None else "greet_off" if not self.greet() \
            else "stage" if self.spatial.stage() in BLOCKING else None
        record = self.spatial.perform_return({"row": row, "away_s": away, "ended": ended, "why": why})
        if why is None and RETURN_ROWS[row][1] is not None:
            day = datetime.date.fromtimestamp(ts)
            with self._lock:
                self._welcomes = [w for w in self._welcomes if w[0] == day] + [(day, record)]
        return record

    def welcomed_on(self, day):
        """Whether a return's welcome played on local date day; a welcome the chooser starts after a base clip
        counts once it is sent."""
        with self._lock:
            return any(at == day and "welcome" in record["played"] for at, record in self._welcomes)
