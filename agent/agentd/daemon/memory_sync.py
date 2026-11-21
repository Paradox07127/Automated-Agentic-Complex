"""Facts a line uses and what follows a memory change."""
import sqlite3
import threading

from infra.store import checkpoint

# Words a proactive line's reason code or a ritual's kind picks facts by; a code not here picks by activity alone.
FACT_QUERIES = {"back": "回来", "break": "休息", "water": "喝水", "birthday": "生日", "morning": "早上 早安",
                "report": "今天 工作 汇报"}


class MemorySyncMixin:
    def _fact_query(self, text, source, reason):
        """What the line's facts are picked by: the user's words, or for a proactive, ritual or tap line its kind's
        words and the current activity."""
        if source not in ("proactive", "ritual", "tap"):
            return text
        kind = reason and (reason.get("kind") or reason.get("code"))
        scene = self.activity()
        return " ".join(filter(None, (FACT_QUERIES.get(kind), scene and scene["activity"])))

    def _use_facts(self, trace, cancel, mouth, query, source):
        """Before mouth.stream builds its request: the facts it injects for query, picked once for both. A proactive,
        ritual or tap line's query is its kind's words, so it recalls no episodes."""
        pick = getattr(mouth, "pick_facts", None)  # test doubles of Mouth have none
        derived = trace["remember"] and self.page_text_allowed() and source not in ("proactive", "ritual", "tap")
        facts = pick(query, derived=derived) if pick is not None else {"trusted": [], "low_trust": []}
        recall = getattr(mouth, "pick_history", None)
        if recall is not None and self.history is not None and trace["remember"]:
            try:
                recall(self.history.search(query, character_id=self.character))
            except sqlite3.Error:
                pass  # a failed search must not end the line
        recall = getattr(mouth, "pick_episodes", None)
        if recall is not None and self.episodes is not None and trace["remember"] and self.page_text_allowed() \
                and source not in ("proactive", "ritual", "tap"):
            try:
                recall(*self.episodes.recall(query, self.clock()))
            except sqlite3.Error:
                pass
        used = [(f["fact_id"], f["version"]) for f in facts["trusted"] + facts["low_trust"]]
        with self._write_lock:
            if trace["reset"] != self.reset_generation:
                return
            self._turn_facts = {"line_id": trace["turn_id"], "cancel": cancel, "facts": set(used), "entry": None,
                                "texts": {}}
            if self.memory is not None and used:
                # Text, not version: confirming bumps the version but keeps the words the reply was made from.
                self._turn_facts["texts"] = {fact_id: self.memory.text(fact_id) for fact_id, _ in used}
                self.memory.touch(fact_id for fact_id, _ in used)
                self.memory.record_uses(used, trace["turn_id"], "injected")

    def _facts_changed(self, line_id):
        """True when a fact injected into this line no longer reads as the words its reply was made from."""
        turn = self._turn_facts if self._turn_facts and self._turn_facts["line_id"] == line_id else None
        return turn is not None and self.memory is not None \
            and any(self.memory.text(fact_id) != text for fact_id, text in turn["texts"].items())

    def _memory_changed(self, fact_id, deleted=False):
        """A fact was deleted or corrected: the latest turn that used it ends, or leaves the history if it had ended,
        and so does every turn whose reply said it again. deleted: the words of those rows go too."""
        self._memories_changed([fact_id], deleted)

    def _forget_derived(self, episode_ids, wait=True):
        """The facts consolidated from any of episode_ids (None: from any episode) go, and the turns that said them;
        returns their fact_ids. wait False: the turns go on a thread of their own, for a caller that may hold
        _mouth_lock (sync_privacy runs inside a line), which taking them back needs."""
        if self.memory is None:
            return []
        briefs = getattr(self.character_agent, 'observation_briefs', None)
        if briefs is not None and (episode_ids is None or episode_ids): briefs.clear()
        facts = self.memory.delete_derived(episode_ids)
        for fact_id in facts:
            self.feed.publish("memory", {"action": "deleted", "fact_id": fact_id})
        if facts:
            checkpoint(self.memory)
            if wait:
                self._memories_changed(facts, deleted=True)
            else:
                threading.Thread(target=self._memories_changed, args=(facts, True), daemon=True).start()
        return facts

    def _memories_changed(self, fact_ids, deleted=False, said=None):
        """_memory_changed for several facts at once. said: the line_ids whose reply said one of them, None to read
        them from memory (which loses them once it clears the facts)."""
        fact_ids = set(fact_ids)
        revoked = self.memory.revoked_with(fact_ids) if self.memory is not None else set()
        extra = revoked - fact_ids
        if extra:
            for fact_id in extra:
                self.feed.publish('memory', {'action': 'deleted', 'fact_id': fact_id})
            if deleted:
                fact_ids |= extra
                if said is not None:
                    said = list(said) + [line for fact_id in extra for line in self.memory.lines(fact_id)]
            else:
                # A corrected fact remains valid user evidence; revoked siblings lose their text entirely.
                self._memories_changed(extra, deleted=True)
        if self.character_agent is not None:
            self.character_agent.cancel("memory_changed", fact_ids=fact_ids)
        turn = self._turn_facts
        if turn is not None and not fact_ids & {used for used, _ in turn["facts"]}:
            turn = None
        # Residents are injected into every turn, so an older turn goes only if it said the fact.
        if said is None:
            said = [line_id for fact_id in fact_ids for line_id in self.memory.lines(fact_id)] \
                if self.memory is not None else []
        if turn is None and not said:
            return
        if turn is not None:
            line = turn["cancel"]
            if line in self._live_lines and not line.is_set() or self.speech is not None \
                    and self._voiced is not None and self._voiced[0] == turn["line_id"] and self.speech.busy():
                self.cancel_turn("memory_changed")
        with self._mouth_lock:  # free again only once that line has recorded its row
            self._apply_window_ops()  # first: a turn a receipt just kept is in the window to take back
            entries = []
            line_ids = list(dict.fromkeys(said + ([turn["line_id"]] if turn is not None else [])))
            for line_id in line_ids:
                with self._write_lock:  # before the retract: a receipt after it keeps nothing of the line
                    self._cut_lines.pop(line_id, None)
                    entries.append(self._line_entries.pop(line_id, None))
                if self.history is not None:
                    try:
                        self.history.retract(line_id, blank=deleted)
                    except sqlite3.Error:
                        pass
            if deleted and self.trace is not None:
                try:
                    self.trace.forget(line_ids)
                except sqlite3.Error:
                    pass
            if turn is not None:
                entries.append(turn["entry"])
            entries = [entry for entry in entries if entry is not None]
            self._apply_window_ops()  # a turn a receipt kept since the first apply goes with the rest
            if entries and self.mouth is not None:
                # Each request rebuilds the window's turn lists but keeps their messages.
                self.mouth.history[:] = [t for t in self.mouth.history if not any(t[0] is e[0] for e in entries)]

    def _context_changed(self, kind):
        """A cleared or corrected context item of `kind` ends the current turn whose context used it, while its
        line is live or a speech still plays, as POST /turn/cancel would. True when a line was cut."""
        if self.character_agent is not None:
            self.character_agent.cancel("context_changed", context_kind=kind)
        line = self._line_cancel
        live = line in self._live_lines and not line.is_set()
        line_id, kinds = self._line_context.get(line, (None, ()))
        if kind not in kinds or not (live or self.speech is not None and self._voiced is not None
                                     and self._voiced[0] == line_id and self.speech.busy()):
            return False
        if live:
            self._context_cut.add(line)
        return self.cancel_turn("context_cleared")[2]["line"]
