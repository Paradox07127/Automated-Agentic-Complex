"""Her state, the character switch (prepare, commit, abort) and avatar visibility."""
import uuid

from brain import persona
from character.behavior import system_prompt
from character.binding import effective
from brain.outbound import OutboundBlocked
from motion.chooser import MotionChooser
from api.views import _iso

SWITCH_LEASE = 25.0  # seconds an open character switch waits for commit or abort before it is aborted
SWITCH_KEPT = 60.0  # seconds a committed switch_id still gets its commit answer


class CharacterSwitchMixin:
    def character_state(self):
        """GET /character/state and the /diag/state block: her real values, whatever affects_behavior says."""
        state = self.state.snapshot() if self.state is not None else \
            {"character_id": None, "energy": None, "valence": None, "engagement": None, "activity": None,
             "labels": None, "causes": []}
        rounded = {key: None if state[key] is None else round(state[key], 2)
                   for key in ("energy", "valence", "engagement")}
        return {**state, **rounded, "causes": [{**c, "at": _iso(c["at"])} for c in state["causes"]],
                "affects_behavior": self.state_affects}

    def user_title(self):
        """How the prompts name the user: the shown character's card's user_title in the reply language, else "the user"."""
        return persona.prompt_user(persona.localized(self.characters.load_card(self.character), self.reply_language_code()))

    def history_retention(self):
        """Seconds trace events and her state log are kept (history_retention); None keeps them all."""
        return None if self.character_agent is None else self.character_agent.retention()

    def clear_state(self, everyone=False):
        """DELETE /character/state (her row) and POST /reset (every row). -> rows deleted."""
        return self.state.clear(everyone)

    def reset_character_state(self, expected):
        """Identity check, clear and reply share the same lock as both character switch paths."""
        with self._switch_lock:
            if self.state is None:
                return 503, {"error": "no_state"}
            if self.switch is not None:
                return 409, {"error": "switching"}
            current = self.state.snapshot()["character_id"]
            if expected != current:
                return 409, {"error": "character_changed", "character_id": current}
            self.clear_state()
            return 200, self.character_state()

    def set_character(self, cid):
        """Swap the card, voice and active conversation.
        Raises ValueError for an unknown id and OutboundBlocked before anything is cancelled.
        None while a character switch is open: nothing changes."""
        card = self.characters.load_card(cid)
        with self._switch_lock:
            if self.switch is not None:
                return None
            if cid == self.character:
                return False
            mouth = self._new_mouth(cid)
            self._switch_cut()
        with self._mouth_lock:  # the lock order of commit_switch
            with self._switch_lock:
                if self.switch is not None:  # a character switch opened while the cut line let go of the mouth
                    return None
                self._swap_held(cid, card, mouth)
        return True

    def _new_mouth(self, cid):
        """mouth_factory's mouth for cid, its prompt rendered with cid's binding; None while the mouth is off."""
        if self.mouth_factory is None:
            return None
        mouth = self.mouth_factory(cid)
        mouth.refresh_system(effective(self, cid))
        return mouth

    def _switch_cut(self):
        """A character switch ends the turn: its line, and its speech as `speech_cancelled` / superseded.
        Returns the new turn_generation."""
        return self._cut("switch")[1]

    def motion_chooser(self, cid):
        """The MotionChooser of cid's runtime character directory; None for no character or a package without one."""
        if cid is None:
            return None
        root = self.characters.package(cid).root / "runtime" / "characters" / cid
        return MotionChooser(root) if (root / "c7" / "pack.json").is_file() else None

    def _swap_held(self, cid, card, mouth):
        """Swap the mouth, character, active topic, voice, behavior prompt and motion chooser. The caller holds _mouth_lock."""
        chooser = self.motion_chooser(cid)
        bindings = getattr(self, "bindings", None)
        voice = self.characters.voice(cid) if bindings is None else bindings.voice(cid)
        self.character_voice_enabled = voice is not None
        backend = self.behavior.backend if self.behavior is not None else None
        system = system_prompt(card["name"]) if backend is not None else None
        with self._write_lock:
            if self.history is not None:
                self.history.conversations.use(cid)
            self.fence_conversation()
            if mouth is not None:
                self.mouth = mouth
            if self.history is None and self.mouth is not None:
                self.mouth.history = []
            self.character = cid
        self.reload_conversation()
        self.feed.publish("task_understanding", {"action":"updated", "character_id":cid})
        if voice is not None and self.speech is not None:
            self.speech.character, self.speech.language = voice
        if backend is not None:
            backend.system = system
        if self.state is not None:
            self.state.use(cid)
        self.spatial.use_motion(chooser)

    def prepare_switch(self, cid):
        """POST /character/prepare:(status, body). Every check passes before anything changes; then the
        switch opens and the turn, speech and behaviors in flight end. The new mouth is built now, for commit."""
        try:
            card = self.characters.load_card(cid)
        except ValueError:
            return 400, {"error": "unknown_character"}
        with self._switch_lock:
            if self.switch is not None:
                return 409, {"error": "switching"}
            if cid == self.character:
                return 409, {"error": "same_character"}
            try:
                mouth = self._new_mouth(cid)
            except OutboundBlocked:
                return 409, {"error": "outbound_blocked"}
            switch_id = f"k2-{uuid.uuid4().hex[:12]}"
            self.switch = {"switch_id": switch_id, "to": cid, "expires_at": self.clock() + SWITCH_LEASE,
                           "card": card, "mouth": mouth}
            generation = self._switch_cut()
            self.spatial.cancel_all("character_switch")
        return 200, {"switch_id": switch_id, "turn_generation": generation}

    def commit_switch(self, switch_id):
        """POST /character/commit:(status, body). A swap that raises changes nothing; the switch stays open."""
        with self._switch_lock:
            switch = self.switch
            if switch is None or switch["switch_id"] != switch_id:
                done = self._commit_of(switch_id)
                return (404, {"error": "unknown_switch"}) if done is None else (200, dict(done))
        # Lock order: _mouth_lock, then _switch_lock; abort, the lease and reset are not held up by a running line.
        with self._mouth_lock:
            with self._switch_lock:
                if self.switch is not switch:  # aborted, past its lease or reset meanwhile
                    done = self._commit_of(switch_id)
                    return (404, {"error": "unknown_switch"}) if done is None else (200, dict(done))
                try:
                    self._swap_held(switch["to"], switch["card"], switch["mouth"])
                except Exception:
                    return 500, {"error": "commit_failed"}
                self.character_generation += 1
                done, now = {"id": switch["to"], "character_generation": self.character_generation}, self.clock()
                self._committed = {key: kept for key, kept in self._committed.items()
                                   if now - kept[0] < SWITCH_KEPT}
                self._committed[switch_id] = (now, done)
                self.switch = None
        return 200, dict(done)

    def abort_switch(self, switch_id):
        """POST /character/abort:(status, body); persona, voice and character_generation stay."""
        with self._switch_lock:
            if self.switch is not None and self.switch["switch_id"] == switch_id:
                self.switch = None
                return 200, {}
            done = self._commit_of(switch_id)
        return (404, {"error": "unknown_switch"}) if done is None else (409, {"error": "committed", "id": done["id"]})

    def _commit_of(self, switch_id):
        """The 200 body of switch_id's commit within SWITCH_KEPT, else None."""
        done = self._committed.get(switch_id)
        return done[1] if done is not None and self.clock() - done[0] < SWITCH_KEPT else None

    def _switch_due(self):
        """One tick: a switch past its lease is aborted."""
        with self._switch_lock:
            if self.switch is not None and self.clock() >= self.switch["expires_at"]:
                self.switch = None

    def switch_state(self):
        """GET /state `switching`: {switch_id, to, expires_at (ISO 8601)}, or None."""
        switch = self.switch
        return switch and {"switch_id": switch["switch_id"], "to": switch["to"],
                           "expires_at": _iso(switch["expires_at"])}

    def set_avatar(self, visible, reason):
        """PUT /avatar/visibility:the new {visible, reason, since}. Hiding stops at once the speech of a
        proactive line or an announcement; a user's line plays on."""
        since = self.avatar["since"] if visible == self.avatar["visible"] else _iso(self.clock())
        hiding = self.avatar["visible"] and not visible
        self.avatar = {"visible": visible, "reason": reason, "since": since}
        if self.desk is not None:
            self.desk.span("visible", visible)
        voiced = self._voiced
        if hiding and voiced is not None and not self._user_started(voiced[0]):
            self._cut("hide")
        return dict(self.avatar)
