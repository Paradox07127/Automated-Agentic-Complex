"""The last hour's median time of each main-line node of a turn, for /diag/state `stages`; memory only."""
from collections import deque
import statistics
import threading
import time

WINDOW = 3600  # seconds of samples a median is over
KEEP = 256  # samples kept per node
# trace kind -> the diag flow node whose time its duration_ms is; only a turn's span that ended ok counts
SPANS = {"model.finished": "model", "speech.finished": "tts", "playback.ended": "play", "motion.ended": "motion"}
# the turn marks the context assembly starts from: the input, or the observation it waited for
CONTEXT_FROM = ("input.received", "observation.settled")


class StageTimes:
    def __init__(self, clock=time.monotonic):
        self.clock, self.lock, self.samples = clock, threading.Lock(), {}

    def _add(self, node, ms):
        with self.lock:
            self.samples.setdefault(node, deque(maxlen=KEEP)).append((self.clock(), ms))

    def event(self, kind, status, turn_id, duration_ms, attrs):
        """One trace event: a turn's finished span, or the judge with its own latency_ms."""
        if status != "ok":
            return
        if kind in SPANS and turn_id is not None and duration_ms is not None:
            self._add(SPANS[kind], duration_ms)
        elif kind == "judge.decided" and attrs.get("latency_ms") is not None:  # the trace format leaves it out
            self._add("judge", attrs["latency_ms"])

    def assembled(self, marks, at):
        """context.assembled at `at` (monotonic) in a turn whose earlier (kind, monotonic) marks are `marks`."""
        start = max((mark for kind, mark in marks if kind in CONTEXT_FROM), default=None)
        if start is not None:
            self._add("ctx", round((at - start) * 1000))

    def diag(self):
        since = self.clock() - WINDOW
        with self.lock:
            recent = {node: [ms for at, ms in kept if at >= since] for node, kept in self.samples.items()}
        return {"window_s": WINDOW, "nodes": {node: {"p50_ms": round(statistics.median(ms)), "n": len(ms)}
                                              for node, ms in recent.items() if ms}}
