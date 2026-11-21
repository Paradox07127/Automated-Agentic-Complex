"""The last generated motions in memory, for GET /motions/<id>/meta, /keys and /tracks."""
from collections import OrderedDict
import threading
import time

KEPT = 16


class MotionStore:
    def __init__(self, kept=KEPT):
        self.kept = kept
        self._motions = OrderedDict()  # id -> (meta_bytes, keys_bytes, tracks_bytes, created), oldest first
        self._lock = threading.Lock()

    def put(self, motion_id, meta_bytes, keys_bytes, tracks_bytes=None):
        """tracks_bytes: None for a perform."""
        with self._lock:
            self._motions[motion_id] = (meta_bytes, keys_bytes, tracks_bytes, time.time())
            while len(self._motions) > self.kept:
                self._motions.popitem(last=False)

    def get(self, motion_id):
        """(meta_bytes, keys_bytes, tracks_bytes, created), or None for an unknown or dropped id."""
        with self._lock:
            return self._motions.get(motion_id)
