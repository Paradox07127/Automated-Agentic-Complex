"""One owned turn's lease, including the interval before its CLI finishes starting.

SessionManager's lock protects phase/backend. Cancellation stays latched even after the
session is forgotten, so a late constructor or queued sender cannot revive the turn.
"""
import threading


class SessionRun:
    def __init__(self):
        self.phase = "starting"
        self.cancelled = threading.Event()
        self.started = threading.Event()  # constructor/send path has settled
        self.backend = None

    def cancel(self):
        self.phase = "stopping"
        self.cancelled.set()


class SessionCancelled(Exception):
    pass
