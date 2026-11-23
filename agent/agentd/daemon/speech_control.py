"""Playback receipts, the mouth window, cuts of a turn or its speech, and relay events."""
import sqlite3
import time

from daemon.constants import SPEECH_TRACES, LINE_ENTRIES
from personal.memory import mentions
from voice.speech import PLAYING
from traces.trace_store import new_span_id
from api.views import _ms_since, _iso

# Each cut of a turn or its speech, as _cut runs it. by: cancel.requested by, None for no trace; line: the current
# line ends, and its model stream; look: its pending look is cancelled (a superseded look still takes its image, as
# a later line can use the view); new_turn: turn_generation moves; speech: "immediate", or
# "policy" (the old utterance's own interrupt_policy); relay_reason: the relay's and speech_cancelled's reason, None
# for the caller's; notify: speech_cancelled "always" (speech_id null with nothing to stop), on a "cut", or on an
# "immediate_cut" (the old utterance was immediate); slots: the announcement slots empty; warm: a cold TTS starts.
# A P0 announcement cuts outside this table: by the old utterance's policy, with no event and no new generation.
_ENDS_TURN = {"line": True, "look": True, "new_turn": True, "speech": "immediate", "relay_reason": "client_cancel",
              "notify": "always", "slots": False, "warm": False}
_SPEECH_ONLY = {"by": None, "line": False, "look": False, "new_turn": False, "speech": "immediate",
                "relay_reason": "client_cancel", "notify": "cut", "slots": False, "warm": False}
CUTS = {"barge_in": {**_ENDS_TURN, "by": "ptt", "slots": True, "warm": True},
        "client_cancel": {**_ENDS_TURN, "by": "text", "slots": True},
        "stop": {**_ENDS_TURN, "by": "stop_command", "slots": True},
        "supersede": {**_ENDS_TURN, "by": "supersede", "look": False, "speech": "policy",
                      "relay_reason": "superseded", "notify": "immediate_cut"},
        "switch": {**_ENDS_TURN, "by": "character_switch", "relay_reason": "superseded"},
        "memory_changed": {**_ENDS_TURN, "by": "system"},
        "context_cleared": {**_ENDS_TURN, "by": "system"},
        "mute": _SPEECH_ONLY,
        "hide": _SPEECH_ONLY,
        "tap": {**_SPEECH_ONLY, "relay_reason": None},
        "barge_in_keep": {**_ENDS_TURN, "by": "ptt", "line": False, "new_turn": False, "slots": True, "warm": True},
        "stop_keep": {**_ENDS_TURN, "by": "stop_command", "line": False, "new_turn": False, "slots": True}}
# A user's stop while the role's foreground run works: only her speech and the side line end (see _keeping).
KEEPS = {"barge_in": "barge_in_keep", "client_cancel": "stop_keep", "stop": "stop_keep"}


class SpeechControlMixin:
    def playback(self, speech_id, state, sample, rate, reason):
        """POST /speech/playback: (applied, why). A user's interrupt of a line's speech keeps only
        what was heard of it in the history and the mouth's window."""
        applied, why = self.speech.receipt(speech_id, state, sample, rate, reason)
        if applied:
            clause = self.speech.clause_ref(speech_id) if state == "ended" else None
            if clause is not None:
                self.spatial.motion_clause_end((clause["utterance_id"], clause["clause_id"]))
            self.spatial.motion({"kind": "voice", "on": self.speech.busy()})
        utterance_id = self.speech.utterance_of(speech_id)
        if applied and state == "ended" and utterance_id is not None \
                and (any(clause["state"] == "cancelled" for clause in self.speech.utterance(utterance_id))
                     or self.speech.turn_of(speech_id) in self._cut_lines):
            # A clause_end cut let this clause play to its end; the clauses it dropped send no receipt.
            self._dropped((self.speech.turn_of(speech_id), utterance_id, None))
        if not applied or state != "interrupted" or reason == "connection_lost":
            return applied, why
        self._settle(self.speech.turn_of(speech_id), self.speech.heard(speech_id)[0] if utterance_id is None
                     else self.speech.heard_utterance(utterance_id))
        return applied, why

    def _settle(self, line_id, heard):
        """A cut line keeps only what was heard of it in the history and the mouth's window."""
        if line_id.startswith("announce-"):
            return
        heard = heard if heard.strip() else ""
        self._heard[line_id] = heard  # before the row: a line still streaming applies it once written
        while len(self._heard) > LINE_ENTRIES:
            self._heard.popitem(last=False)
        with self._write_lock:  # a retract or a clear pops the line first, and nothing brings it back after that
            cut = self._cut_lines.pop(line_id, None) if heard else None
            if cut is not None:
                user, earlier, facts, topic = cut
                if self.history is not None:
                    try:
                        self.history.interrupt(line_id, heard, cut=True)
                    except sqlite3.Error:
                        pass
                if self.memory is not None:
                    self.memory.record_uses([(fact_id, version) for fact_id, version, text in facts
                                             if mentions(heard, text)], line_id, "mentioned")
                if self.history is None or topic == self.history.conversations.active:
                    self._keep_turn(line_id, user, earlier, heard)
        if cut is not None:
            self._window_changed()
            return
        if self.history is not None:
            try:
                if heard:
                    self.history.interrupt(line_id, heard)
                else:
                    self.history.retract(line_id)
            except sqlite3.Error:
                pass
        if not heard:  # the API refuses an empty assistant turn before the last message
            with self._write_lock:
                entry = self._line_entries.pop(line_id, None)
                if entry is None or self.mouth is None:
                    return
                past = self.mouth.history
                at = next((n for n, turn in enumerate(past) if turn[0] is entry[0]), 0)
                # Held as a line cut while it streamed: a later receipt can still say some of it was heard.
                self._cut_lines[line_id] = (entry[0], [turn[0] for turn in past[:at]], self._line_facts(line_id),
                                            self.history.conversations.active if self.history else None)
                while len(self._cut_lines) > LINE_ENTRIES:
                    self._cut_lines.popitem(last=False)
                self._window_ops.append(("drop", entry, None))
            self._window_changed()
            return
        with self._write_lock:
            entry = self._line_entries.get(line_id)
            if entry is None or self.mouth is None:
                return
            entry[1] = {"role": "assistant", "content": heard}  # a "keep" still queued inserts this same list
            self._window_ops.append(("heard", entry, None))
        self._window_changed()

    def retire_foreground(self):
        controller = self.character_agent
        if controller is not None:
            # Retire only the foreground runtime; background jobs retain their leases.
            with controller._lock:
                if controller.runtime is not None:
                    controller.runtime.close()
                    controller.runtime = None
                controller._runtime_config = None

    def reload_conversation(self):
        self.retire_foreground()
        if self.mouth is not None and self.history is not None:
            self.load_window()

    def fence_conversation(self):
        self._line_entries.clear()
        self._window_ops.clear()

    def _read_window(self, character, mouth):
        names = {cid: self.characters.load_card(cid)["name"] for cid in self.characters.ids()}
        return self.history.window(character, mouth.max_turns, names, with_ids=True)

    def load_window(self):
        """At startup: the mouth's window, read back from the history; a deleted fact or a receipt finds each of its
        turns by line_id, as it finds a turn spoken since."""
        turns = self._read_window(self.character, self.mouth)
        self.mouth.history = [turn for _, turn in turns]
        with self._write_lock:
            self._line_entries.update(turns)

    def _keep_turn(self, line_id, user, earlier, heard):
        """A line the user cut while it streamed enters the mouth's window as heard, right after the last turn still
        there of earlier (the user messages of the window's turns before it, oldest first), so ahead of any newer
        turn. The caller holds _write_lock; the window takes the turn in _apply_window_ops."""
        if self.mouth is None:
            return
        entry = [user, {"role": "assistant", "content": heard}]
        self._window_ops.append(("keep", entry, earlier))
        self._line_entries[line_id] = entry
        while len(self._line_entries) > LINE_ENTRIES:
            self._line_entries.popitem(last=False)

    def _window_changed(self):
        """_apply_window_ops now, unless a line holds _mouth_lock (the caller's own line too): it applies them."""
        if self._mouth_lock.acquire(blocking=False):
            try:
                self._apply_window_ops()
            finally:
                self._mouth_lock.release()

    def _apply_window_ops(self):
        """The queued window changes, in order. The caller holds _mouth_lock and not _write_lock."""
        with self._write_lock:
            ops, self._window_ops = self._window_ops, []
        if not ops or self.mouth is None:  # test doubles of Mouth have no history
            return
        past = self.mouth.history
        for op, entry, earlier in ops:
            if op == "drop":
                past[:] = [turn for turn in past if turn[0] is not entry[0]]
                continue
            if op == "heard":
                # The mouth rebuilds each turn's list for every request but keeps its message objects.
                for turn in past:
                    if turn[0] is entry[0]:
                        turn[1] = entry[1]
                continue
            # With none of earlier left in the window, only turns newer than this one are.
            at = next((n + 1 for n in range(len(past) - 1, -1, -1) if any(past[n][0] is user for user in earlier)), 0)
            past.insert(at, entry)

    def _line_facts(self, line_id):
        """(fact_id, version, text as used) of each fact injected into line_id; [] once a newer line used facts."""
        turn = self._turn_facts if self._turn_facts and self._turn_facts["line_id"] == line_id else None
        if turn is None:
            return []
        return [(fact_id, version, turn["texts"][fact_id]) for fact_id, version in turn["facts"]
                if turn["texts"].get(fact_id)]

    def _dropped(self, voiced):
        """After a cut: a line with a clause that got no `ended` receipt is settled now by its receipts, as the avatar host
        sends no end receipt for a clause it never started. voiced: a _voiced tuple or None."""
        if voiced is None:
            return
        turn_id, utterance_id, _ = voiced
        # Receipts are the record only while a renderer reads the speech stream, and only for a line that was cut:
        # one that ran its course keeps its words without them too (TTS failed, nothing played it).
        if not self.speech_readers or not self.speech.was_cut(utterance_id):
            return
        played = [clause["played"] for clause in self.speech.utterance(utterance_id)]
        # A clause the renderer started still sends its end receipt, and playback() settles the line then.
        if any(state in PLAYING for state in played):
            return
        # A line cut while it streamed said more than its clauses, so it is settled even when each one ended.
        if any(state != "ended" for state in played) or turn_id in self._cut_lines:
            self._settle(turn_id, self.speech.heard_utterance(utterance_id))

    def _begin_utterance(self, turn_id, generation, trace_id, policy):
        """A new utterance on the relay; the one before it ends by its own policy."""
        before = self._voiced
        utterance_id = self.speech.begin_utterance(turn_id, generation, trace_id, policy)
        self._voiced = (turn_id, utterance_id, policy)
        self._dropped(before)
        return utterance_id

    def _cancel_speech(self, reason, immediate=False):
        """The relay's cut: the speech_id cut, True when only clauses still to come were, else False."""
        return self.speech is not None and self.speech.cancel(reason, immediate)

    def _speech_cancelled(self, speech_id, reason):
        """C1 `speech_cancelled` on /events (C2 v2-3 rule 8). speech_id: anything but a str is sent as null,
        and so is utterance_id when it is no clause."""
        speech_id = speech_id if isinstance(speech_id, str) else None
        self.registry.publish_event("speech_cancelled", {
            "session_epoch": self.speech.epoch if self.speech is not None else None,
            "turn_generation": self.turn_generation, "speech_id": speech_id,
            "utterance_id": self.speech.utterance_of(speech_id) if speech_id is not None else None,
            "reason": reason})

    def _clause_intent(self, line_id, intent, generation, trace_id, clause):
        """C1 v2 §4 `clause_intent` on /events, and its gesture chosen now. clause: the relay's clause_ref, None for a
        line shown only as text."""
        clause = clause or dict.fromkeys(("utterance_id", "clause_id", "spoken_text_revision"))
        self.registry.publish_event("clause_intent", {"line_id": line_id, **clause, "intent": intent,
                                                      "turn_generation": generation, "trace_id": trace_id})
        self.spatial.motion_clause((clause["utterance_id"], clause["clause_id"]), intent)

    def _text_line(self, line_id, generation, trace_id, hold_ms=None):
        """C1 v2.3 `text_line` on /events: started while hold_ms is None, else ended, the host speaking hold_ms more."""
        ended = {} if hold_ms is None else {"hold_ms": hold_ms}
        self.registry.publish_event("text_line", {"line_id": line_id, "turn_generation": generation,
                                                  "trace_id": trace_id, "state": "ended" if ended else "started",
                                                  **ended})
        self.spatial.motion({"kind": "text_line", "on": not ended})

    def _abort_model(self):
        if self.character_agent is not None:
            self.character_agent.cancel("turn_cancelled")
        """Close the mouth's open model stream at once."""
        abort = getattr(self.mouth, "cancel_active", None)
        if abort is not None:
            abort()

    def _new_turn(self):
        with self._turn_lock:
            self.turn_generation += 1
            if self.speech is not None:
                self.speech.generation = self.turn_generation
            return self.turn_generation

    def cancel_turn(self, reason, generation=None, line_id=None):
        """End the whole turn (line, look, speech) as CUTS[reason]: see _cut.
        line_id: ("stale_line", None) unless it names a line still streaming or speaking."""
        with self._turn_lock:
            if line_id is not None:
                lines = [c for c in (self._line_cancel, *self._side_lines) if c in self._live_lines and not c.is_set()]
                current = {self._line_context.get(c, (None,))[0] for c in lines}
                if self.speech is not None and self._voiced is not None and self.speech.busy():
                    current.add(self._voiced[0])
                if line_id not in current:
                    return "stale_line", None
            return self._cut(reason, generation)

    def _keeping(self, kind):
        """kind, or its KEEPS row while the role's foreground run works: a user's stop then spares that run."""
        busy = self.character_agent is not None and self.character_agent.busy()
        return KEEPS[kind] if busy else kind

    def _end_sides(self, reason):
        """Each side line ends, with its harness run; True when one was still running."""
        sides = tuple(self._side_lines)
        cut = any(side in self._live_lines and not side.is_set() for side in sides)
        for side in sides:
            side.set()
        if sides and self.character_agent is not None:
            self.character_agent.cancel_sides(sides, reason)
        return cut

    def cancel_run_speech(self, run_id):
        with self._turn_lock:
            voiced = self._voiced
            if voiced is None or voiced[0] != run_id: return
            speech = self._cancel_speech('client_cancel', immediate=True)
            self._dropped(voiced)
            if speech: self._speech_cancelled(speech, 'client_cancel')

    def _cut(self, kind, generation=None, reason=None):
        """Run the CUTS row of kind: ("stale", current) when generation is not the current one, else ("cancelled",
        the generation after it, {"line", "speech", "observation"}: whether each was really cut).
        reason: the relay's reason of a row whose relay_reason is None."""
        row = CUTS[kind]
        reason = reason or row["relay_reason"]
        # Held throughout: a line that starts meanwhile is not the one this cut ends.
        with self._turn_lock:
            if generation is not None and generation != self.turn_generation:
                return "stale", self.turn_generation
            sides = row["line"] or kind in KEEPS.values()
            if row["by"] is not None:
                self._cancel_requested(row["by"], ([self._line_cancel] if row["line"] else []) +
                                       (list(self._side_lines) if sides else []))
            line, cut = self._line_cancel, False
            if row["line"]:
                cut = line in self._live_lines and not line.is_set()
                line.set()
                if line in self._live_lines:
                    self._abort_model()
            if sides:
                cut = self._end_sides(reason) or cut
            voiced = self._voiced
            # Before the generation moves: a clause_end stream must be kept before its relay sees the new one.
            speech = self._cancel_speech(reason, immediate=row["speech"] == "immediate")
            if row["line"] or speech:
                self._dropped(voiced)
            if row["new_turn"]:
                self._new_turn()
            if {"always": True, "cut": bool(speech),
                    "immediate_cut": bool(speech) and voiced is not None and voiced[2] == "immediate"}[row["notify"]]:
                self._speech_cancelled(speech, reason)
            if row["slots"]:
                with self._announce_lock:
                    self._announce_slots.clear()
            if row["warm"] and self.tts_ensurer is not None and not self.muted:
                self.tts_ensurer.request()  # the user is about to speak: a cold TTS starts now
            look = self._look if row["look"] else None
            observation = look is not None and self.capture is not None \
                and self.capture.cancel(look, "turn_cancelled")
            return "cancelled", self.turn_generation, {"line": cut, "speech": bool(speech),
                                                       "observation": observation}

    def _cancel_requested(self, by, lines):
        """cancel.requested for the current turn, once, while its line runs or a speech still plays.
        Called before the generation moves, so the line's cancel.acked comes after it. A cut by anything but
        "system" is the user's: each live line of lines (the cancel events it ends) keeps what was heard of it
        (see _run_line)."""
        if by != "system":
            self._user_cut.update(line for line in lines if line in self._live_lines)
        trace = self._turn_trace
        if trace is None or trace["cancel"] is not None \
                or trace["done"] and not (self.speech is not None and self.speech.busy()):
            return
        span, at = new_span_id(), time.monotonic()
        self._step(trace, "cancel.requested", span, attrs={"by": by, "target": "turn"})
        trace["cancel"] = (span, at)

    def _cancel_acked(self, trace):
        span, at = trace["cancel"] or (new_span_id(), None)
        self._step(trace, "cancel.acked", span, attrs={"target": "turn"},
                   duration_ms=0 if at is None else _ms_since(at))

    def _speech_requested(self, trace, speech_id, line_id, text):
        span = new_span_id()
        with self._speech_trace_lock:
            event_id = self._step(trace, "speech.requested", span, texts={"text": text},
                                  attrs={"speech_id": speech_id, "clause_id": self.speech.clause_of(speech_id),
                                         "line_id": line_id})
            self._speaking = speech_id
            speech = self._speech_traces[speech_id] = {"trace": trace, "span": span, "at": time.monotonic(),
                                                       "last": event_id}
            while len(self._speech_traces) > SPEECH_TRACES:
                self._speech_traces.popitem(last=False)
            for kind, attrs, at in self._early_speech.pop(speech_id, []):
                self._tts_event(speech, kind, speech_id, attrs, at)
        self.spatial.motion({"kind": "voice", "on": self.speech.busy()})

    def on_speech_event(self, kind, speech_id, attrs):
        """SpeechRelay.on_event: its first audio and end go into the voiced line's trace as producer tts."""
        at, now = time.monotonic(), _iso(time.time())
        self.voice.on_speech(kind, attrs)
        if kind == "speech.first_audio":
            self._audible.append(speech_id)
        if kind == "speech.failed":  # nothing reached /speech, so the feed carries this speech's end
            self.feed.publish("speech_failed", {"speech_id": speech_id, **attrs})
            self._speech_failed = {"speech_id": speech_id, "reason": attrs.get("reason"), "at": now}
            self._tts_last = {"result": attrs.get("reason"), "at": now}
            turn = self.speech and self.speech.turn_of(speech_id)  # None: a relay agentd does not speak through
            if turn is None or turn not in self._speech_failed_turns:  # each clause of a turn fails alike
                self._speech_failed_turns.append(turn)
                host = self.speech.host if self.speech is not None else "unknown"
                self.errors.record("speech_failed", f"{attrs.get('reason')} from {host}", turn_id=turn)
            kind, attrs = "speech.finished", {"total_samples": 0, "failed": True, **attrs}
        elif kind == "speech.finished":
            self._tts_last = {"result": "cancelled" if attrs.get("cancelled") else "complete", "at": now}
        with self._speech_trace_lock:
            speech = self._speech_traces.get(speech_id)
            if speech is None:  # speak() has not returned yet, or no line's speech (an announcement)
                self._early_speech.setdefault(speech_id, []).append((kind, attrs, at))
                while len(self._early_speech) > SPEECH_TRACES:
                    self._early_speech.popitem(last=False)
                return
            self._tts_event(speech, kind, speech_id, attrs, at)

    def _tts_event(self, speech, kind, speech_id, attrs, at):
        trace = speech["trace"]
        end = kind == "speech.finished"
        with self._write_lock:
            if not self._traced(trace):
                return
            event_id = self._trace(kind, trace["trace_id"], producer="tts", turn_id=trace["turn_id"],
                                   turn_generation=trace["generation"], span_id=speech["span"],
                                   parent_span_id=trace["span"], causation_id=speech["last"],
                                   status="failed" if attrs.get("failed") else "cancelled" if attrs.get("cancelled")
                                   else "ok",
                                   attrs={"speech_id": speech_id, "clause_id": self.speech.clause_of(speech_id),
                                          **attrs},
                                   duration_ms=max(0, round((at - speech["at"]) * 1000)) if end else None)
        speech["last"] = event_id or speech["last"]
