"""Companion feed: numbered announce / line / request events for the shell."""
from collections import deque
import secrets
import threading


class Feed:
    def __init__(self, size=256):
        self.cv = threading.Condition()
        self.items = deque(maxlen=size)
        self.seq = 0
        self.stream_epoch = secrets.token_hex(4)  # names this buffer in `<stream_epoch>-<seq>` cursors

    def publish(self, event, data):
        with self.cv:
            self.seq += 1
            item = {"seq": self.seq, "event": event, "data": {"seq": self.seq, **data}}
            self.items.append(item)
            self.cv.notify_all()
            return item

    def reset(self):
        """Every item dropped under a new stream_epoch; seq keeps counting for the streams still open."""
        with self.cv:
            self.items.clear()
            self.stream_epoch = secrets.token_hex(4)

    def stream_state(self):
        """{stream_epoch, oldest_seq, latest_seq}; oldest_seq is latest_seq + 1 when nothing is held."""
        with self.cv:
            return {"stream_epoch": self.stream_epoch,
                    "oldest_seq": self.items[0]["seq"] if self.items else self.seq + 1, "latest_seq": self.seq}

    def since(self, seq):
        with self.cv:
            return [item for item in self.items if item["seq"] > seq]

    def wait(self, seq, timeout):
        with self.cv:
            if self.seq <= seq:
                self.cv.wait(timeout)
