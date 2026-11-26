"""Outbound guard:text we author for the API (card, examples, lorebook, per-turn notes) must not share
WINDOW content characters in a row with any original line. Lines stay on ws; this side only holds their hashes."""
import hashlib
import json
import re
from pathlib import Path
import threading
import time
import unicodedata
from infra.store import rewrite_jsonl


class OutboundBlocked(RuntimeError):
    def __init__(self, part, hits):
        super().__init__(f"{part}: {hits} runs match original lines")
        self.part, self.hits = part, hits


def normalize(text):
    """Content characters only, lower case; must match the local tool `tone_stats.py` (not in the public repo)."""
    return "".join(c for c in text.lower() if not c.isspace() and unicodedata.category(c)[0] not in "PS")


def load_windows(path):
    """Validate a hash-only boundary index; never substitute an empty guard."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ValueError('canon_windows_unavailable') from error
    if not isinstance(data, dict) or type(data.get('n')) is not int or data['n'] != 7 or \
            not isinstance(data.get('hashes'), list) or not data['hashes'] or any(
                not isinstance(value, str) or re.fullmatch(r'[a-f0-9]{16}', value) is None for value in data['hashes']):
        raise ValueError('invalid_canon_windows')
    return data


class OutboundGuard:
    def __init__(self, windows_path, log_path=None, clock=time.time):
        """windows_path: output of tone_stats.py --windows; log_path: JSONL of part names and counts, never text."""
        data = load_windows(windows_path)
        self.n, self.hashes = data["n"], set(data["hashes"])
        self.log_path, self.clock = log_path, clock
        self._lock = threading.Lock()
        self._pruned_at = self._summary_at = self.clock()
        self._checks = self._hits = 0
        rewrite_jsonl(self.log_path, lambda row: row.get("ts", 0) >= self._pruned_at - 7 * 86400)

    def hits(self, text):
        text = normalize(text)
        return sum(hashlib.sha256(text[i:i + self.n].encode()).hexdigest()[:16] in self.hashes
                   for i in range(len(text) - self.n + 1))

    def check(self, part, text):
        hits = self.hits(text)
        if self.log_path is not None:
            with self._lock:
                now = self.clock()
                if now - self._pruned_at >= 3600:
                    rewrite_jsonl(self.log_path, lambda row: row.get("ts", 0) >= now - 7 * 86400)
                    self._pruned_at = now
                if now - self._summary_at >= 3600:
                    with open(self.log_path, "a", encoding="utf-8") as log:
                        log.write(json.dumps({"ts": now, "checks": self._checks, "hits": self._hits}) + "\n")
                    self._summary_at, self._checks, self._hits = now, 0, 0
                self._checks += 1
                self._hits += hits
                if hits:
                    with open(self.log_path, "a", encoding="utf-8") as log:
                        log.write(json.dumps({"ts": now, "part": part, "chars": len(text), "hits": hits}) + "\n")
        if hits:
            raise OutboundBlocked(part, hits)

    def truncate_log(self):
        """The log file emptied; False without one."""
        if self.log_path is None:
            return False
        with self._lock, open(self.log_path, "w", encoding="utf-8"):
            self._summary_at, self._checks, self._hits = self.clock(), 0, 0
            return True
