"""The mouth: the current character's persona, lorebook and chat history; the character kernel writes its lines."""
import json
from pathlib import Path

from brain import characters
from brain.persona import HAIKU_RULE, SECTIONS, render_persona
from character.binding import bound
from brain.egress import EgressPolicy
from brain.lorebook import Lorebook


def chat_system(card, binding, egress, motion_phrases=None):
    """(the persona's system text, the card it was rendered from) for card under binding
    (character.binding.effective; None: the card alone). Raises OutboundBlocked when egress blocks the
    system text or the card's post_history_instructions. motion_phrases: the pack's gestures listed for [motion:]."""
    card, motion = bound(card, binding)
    text = render_persona(card, motion, motion_phrases)
    egress.authored("system", text)
    egress.authored("instructions", card["post_history_instructions"])
    return text, card


class Mouth:
    """No tools: the mouth can only talk. History keeps the last max_turns finished turns."""

    def __init__(self, character=None, persona_path=None, lore_path=None, max_turns=8, guard=None, egress=None,
                 motion_phrases=None):
        """guard: brain.outbound.OutboundGuard; with one, authored text that matches original lines is not sent.
        motion_phrases: the character's game gestures render_persona lists for [motion:] (motion.catalog.phrases).
        persona_path / lore_path None: the character's own; lore_path False: no lorebook.
        character None: the development default."""
        if character is None:
            character = characters.default()
        self.card = json.loads(Path(persona_path or characters.card_path(character)).read_text(encoding="utf-8"))
        self.egress = EgressPolicy(guard=guard) if egress is None else egress
        self.motion_phrases = motion_phrases
        self.refresh_system()
        if lore_path is None:
            lore_path = characters.lore_path(character)
        self.lore = Lorebook(lore_path) if lore_path else None
        self.max_turns = max_turns
        self.history = []  # finished turns: [user, assistant]; live context never enters it

    def refresh_system(self, binding=None):
        """Checks the card's system text against egress again. binding: the character's effective binding
        (character.binding.effective), whose persona overrides and motion driver apply; None: the card alone."""
        chat_system(self.card, binding, self.egress, self.motion_phrases)

    def pick_lore(self, text):
        """This turn's lorebook entries with their hit reasons; selecting twice would advance the sticky and
        cooldown counters twice."""
        return self.lore.select(text) if self.lore is not None else []
