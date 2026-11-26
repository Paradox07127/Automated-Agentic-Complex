"""The mouth: the current character's persona, lorebook and chat history; the character kernel writes its lines."""
import json
from pathlib import Path

from brain import characters
from brain.persona import HAIKU_RULE, SECTIONS, render_persona
from character.binding import bound
from brain.lorebook import Lorebook


def chat_system(card, binding, motion_phrases=None):
    """(the persona's system text, the card it was rendered from) for card under binding
    (character.binding.effective; None: the card alone). motion_phrases: the pack's gestures listed for [motion:]."""
    card, motion = bound(card, binding)
    text = render_persona(card, motion, motion_phrases)
    return text, card


class Mouth:
    """No tools: the mouth can only talk. History keeps the last max_turns finished turns."""

    def __init__(self, character=None, persona_path=None, lore_path=None, max_turns=8, motion_phrases=None):
        """motion_phrases: the character's game gestures render_persona lists for [motion:] (motion.catalog.phrases).
        persona_path / lore_path None: the character's own; lore_path False: no lorebook.
        character None: the development default."""
        if character is None:
            character = characters.default()
        self.card = json.loads(Path(persona_path or characters.card_path(character)).read_text(encoding="utf-8"))
        self.motion_phrases = motion_phrases
        self.refresh_system()
        if lore_path is None:
            lore_path = characters.lore_path(character)
        self.lore = Lorebook(lore_path) if lore_path else None
        self.max_turns = max_turns
        self.history = []  # finished turns: [user, assistant]; live context never enters it

    def refresh_system(self, binding=None):
        """Renders the card's system text so a card or binding that cannot render fails here, not in a turn.
        binding: the character's effective binding (character.binding.effective); None: the card alone."""
        chat_system(self.card, binding, self.motion_phrases)

    def pick_lore(self, text):
        """This turn's lorebook entries with their hit reasons; selecting twice would advance the sticky and
        cooldown counters twice."""
        return self.lore.select(text) if self.lore is not None else []
