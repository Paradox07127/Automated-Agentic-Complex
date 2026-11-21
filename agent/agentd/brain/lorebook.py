"""Keyword lorebook:setting entries in our own words, injected for the turns that mention them.

Each entry: id, kind (KINDS), keys, text, tier, source_ref, game_version and optional aliases,
priority (higher first), sticky (turns it stays) and cooldown (turns it cannot trigger after that).
Keys and aliases with ASCII letters or digits require ASCII word boundaries; others match substrings."""
import json
from pathlib import Path
import re

KINDS = ("world", "relations", "events")


class Lorebook:
    def __init__(self, path):
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        self.budget = data["budget_tokens"]
        for e in data["entries"]:
            if e.get("tier") not in ("official", "inferred", "fanon"):
                raise ValueError(f"lore entry {e['id']}: invalid or missing tier")
            if e.get("source_ref") not in ("voice", "story", "card", "product"):
                raise ValueError(f"lore entry {e['id']}: invalid or missing source_ref")
            if "game_version" not in e:
                raise ValueError(f"lore entry {e['id']}: missing game_version")
            for key in e["keys"] + e.get("aliases", []):
                if len(key) < 2:
                    raise ValueError(f"lore entry {e['id']}: key or alias shorter than 2 characters: {key!r}")
        # Stable sort keeps file order among equal priorities.
        self.entries = sorted(data["entries"], key=lambda e: -e.get("priority", 0))
        self.turn = -1
        self._active_until = {}  # id -> last turn a trigger keeps it in
        self._blocked_until = {}  # id -> first turn it may trigger again
        self.last_hits = []

    def select(self, text):
        """Entries with tiers and hit reasons, highest priority first, within the token budget."""
        self.turn += 1
        text, chosen, used = text.lower(), [], 0
        for e in self.entries:
            reason = None
            if self.turn >= self._blocked_until.get(e["id"], 0):
                for field, prefix in (("keys", "key"), ("aliases", "alias")):
                    for key in e.get(field, []):
                        pattern = re.escape(key.lower())
                        if re.search(r"[A-Za-z0-9]", key):
                            pattern = rf"(?<![a-z0-9]){pattern}(?![a-z0-9])"
                        if re.search(pattern, text):
                            reason = f"{prefix}:{key}"
                            break
                    if reason is not None:
                        break
            triggered = reason is not None
            if not triggered and self.turn > self._active_until.get(e["id"], -1):
                continue
            cost = len(e["text"])  # one token per character over-counts Chinese, so the budget holds
            if used + cost > self.budget:
                continue
            used += cost
            chosen.append({"id": e["id"], "tier": e["tier"], "text": e["text"], "reason": reason or "sticky"})
            if triggered:
                self._active_until[e["id"]] = self.turn + e.get("sticky", 0)
                self._blocked_until[e["id"]] = self._active_until[e["id"]] + 1 + e.get("cooldown", 0)
        self.last_hits = [{"id": e["id"], "reason": e["reason"]} for e in chosen]
        return chosen
