"""Pure persona formatting shared by package validation and dialogue."""

from brain.language import SUPPORTED
from brain.markers import INTENTS
from infra.platform import USER_MACHINE

HAIKU_RULE = "The rules in this system prompt hold for the whole conversation."
SECTIONS = ("identity", "personality", "relationship", "knowledge", "tone_rules", "catchphrases", "do_dont",
            "canon", "examples")
PROMPT_USER = "the user"  # what English prompt text calls the user of a card without user_title
USER_SLOT = "{user_title}"  # the placeholder a semantic task's instructions hold for it; addressed fills it in
_SPARING = ("Motions give a line weight, so use them rarely: only when the line carries a clear feeling or gesture, "
            "such as a greeting, good news, comfort, embarrassment or a goodbye; ordinary answers, explanations and reports "
            "get none, and most replies have none. Match the motion to the feeling of the line. ")
# The <markers> section; INTENTS is the whitelist the marker parser passes, sorted so the prompt stays byte-stable.
INTENT_RULE = ("Start every reply with one intent marker [intent:name], the name one of: " + ", ".join(sorted(INTENTS))
               + ". The text follows it directly; write no other bracket marker unless a rule below gives one.")
# How the character reads an event cue (brain.events.cue); {user} is prompt_user(card).
EVENT_RULE = ("A message that starts with <event> is something that happened around you, not words from {user}: the tag holds "
              "the facts, the line after it says what this line is for. React to the event itself in your own voice; never "
              "describe what {user} just did back to them, vary your reaction from one time to the next, and do not ask every "
              "time what they want. Earlier events in the conversation keep only their tag.")
# Follows INTENT_RULE while the character's effective motion driver is generated.
MOTION_RULE = ("You also have a body on the desktop: a marker [motion:English description|seconds] makes your whole body act, "
               "e.g. [motion:waves her right hand happily|3] (this shows the format; pick the act from this line's feeling). "
               + _SPARING + "Describe what the whole body does in plain English (letters and common punctuation only), "
               "with no speech or facial narration; seconds 1 to 6, at most one per reply, after the intent marker.")
# Follows MOTION_RULE when the character has game gestures (motion.catalog.phrases).
MOTION_PHRASES = (" Motions you already know: {}. When the one you want means the same as one of these, copy that phrase "
                  "into [motion:] exactly; it plays most naturally. Otherwise describe your own in English.")
# Follows INTENT_RULE while the driver is game and the character has game gestures: {0} the first phrase, {1} all.
GAME_MOTION_RULE = ("You also have a body on the desktop: a marker [motion:phrase|seconds] makes your whole body play one of "
                    "your ready motions, e.g. [motion:{0}|3] (this shows the format; pick the act from this line's feeling). "
                    + _SPARING + "Copy the phrase exactly from this list, without rewording or describing any other act; "
                    "if none fits, write none: {1}. Seconds 1 to 6, at most one per reply, after the intent marker.")


# The language the cards are written in (brain.language code), and the fields an `i18n` entry may give per reply language.
BASE_LANGUAGE = "zh-Hans"
LOCALIZED = ("name", "user_title", "examples", "catchphrases", "tone_rules", "familiarity_rules", "post_history_instructions")


def localized(card, language):
    """card with its i18n entry for language applied; language None (harness) keeps the card."""
    if language in (None, BASE_LANGUAGE):
        return card
    entry = card.get("i18n", {}).get(language, {})
    return {**card, **{key: value for key, value in entry.items() if key in LOCALIZED}}


def prompt_user(card):
    """How English prompt text names the user: the card's user_title, else PROMPT_USER."""
    return card.get("user_title", PROMPT_USER)


def addressed(text, card):
    """text with USER_SLOT filled in from card."""
    return text.replace(USER_SLOT, prompt_user(card))


def render_persona(card, motion=False, motion_phrases=None, language=None, embodied=False):
    """motion: True adds MOTION_RULE after INTENT_RULE, "game" adds GAME_MOTION_RULE when there are motion_phrases;
    motion_phrases: the English phrases of the character's game gestures, listed after either rule.
    language: the reply language (brain.language code) whose i18n entry applies; None renders the card as written.
    embodied: the character has a body on the user's desktop (its package has a render component)."""
    missing = [key for key in ("name", *SECTIONS, "post_history_instructions") if key not in card]
    if missing:
        raise ValueError(f"persona card lacks {', '.join(missing)}")
    invalid = [key for key in ("user_title", "pronoun") if key in card and not (isinstance(card[key], str) and card[key])]
    if invalid:
        raise ValueError(f"persona card {', '.join(invalid)} must be a non-empty string")
    i18n = card.get("i18n", {})
    if not isinstance(i18n, dict) or any(code not in SUPPORTED or code == BASE_LANGUAGE or not isinstance(entry, dict)
                                         or set(entry) - set(LOCALIZED) for code, entry in i18n.items()):
        raise ValueError("persona card i18n must map reply languages to localized fields")
    for code in i18n:  # each entry must render too
        render_persona({**localized(card, code), "i18n": {}})
    card = localized(card, language)
    name = card["name"]
    if motion == "game":
        motion_rule = "\n" + GAME_MOTION_RULE.format(motion_phrases[0], "; ".join(motion_phrases)) if motion_phrases else ""
    else:
        motion_rule = "\n" + MOTION_RULE + (MOTION_PHRASES.format("; ".join(motion_phrases)) if motion_phrases else "")
    body = {
        "identity": card["identity"], "personality": card["personality"], "relationship": card["relationship"],
        "knowledge": f"Knows: {card['knowledge']['knows']}\nDoes not know: {card['knowledge']['does_not_know']}",
        "tone_rules": "\n".join(f"- {rule}" for rule in card["tone_rules"]),
        "catchphrases": "\n".join(f"- \"{c['phrase']}\": {c['when']}" for c in card["catchphrases"]),
        "do_dont": "\n".join(f"- Do: {p['do']}\n  Don't: {p['dont']}" for p in card["do_dont"]),
        "canon": card["canon"], "markers": INTENT_RULE + (motion_rule if motion else ""),
        # live: the Context line an example answers from; a reply names only what it gives
        "examples": "\n".join(f"<example>\n{'Context: ' + e['live'] + chr(10) if 'live' in e else ''}"
                              f"{card.get('user_title', 'User')}: {e['user']}\n{name}: {e['reply']}\n</example>" for e in card["examples"]),
    }
    if "familiarity_rules" in card:  # the one optional section: how she brings up what she remembers
        body["familiarity_rules"] = card["familiarity_rules"]
    if not card["examples"]:
        del body["examples"]
    at = SECTIONS.index("relationship") + 1
    keys = [key for key in (*SECTIONS[:at], "familiarity_rules", *SECTIONS[at:-1], "markers", "examples") if key in body]
    user = prompt_user(card)
    if embodied:
        head = (f"You are {name}, a character standing on {user}'s desktop on {USER_MACHINE}: {user} can see you, click you and "
                f"drag you; they see and hear only the lines you say. Your character:")
    else:
        head = f"You are {name}, talking with the user on {USER_MACHINE}; the user sees and hears only the lines you say. Your character:"
    usage = ("Using these sections:\n"
             "- <identity>, <personality>, <relationship>: every line starts from them.\n"
             + ("- <familiarity_rules>: how you bring up what you remember.\n" if "familiarity_rules" in body else "")
             + "- <tone_rules>: how you speak.\n"
             "- <knowledge>: your limits. What neither these sections, the turn's material nor your memory cover (news, unwritten"
             " details, the user's untold life), you don't know; say so in your voice and never invent names, numbers or events.\n"
             "- <catchphrases>: only in the situation named; most replies use none, and never twice running.\n"
             "- <do_dont>: learn the direction, not the words.\n"
             "- <canon>: your own past; a line or two in your own words when a topic touches it, never recited unasked.\n"
             "- <markers>: the format of every reply.\n"
             + ("- <examples>: tone, length and reactions only; never repeat one or a <do_dont> line, the closer the user's words,"
                " the newer yours. \"Context:\" shows using only the point that matters.\n" if "examples" in body else "")
             + EVENT_RULE.format(user=user) + "\n"
             + f"Stay {name} in identity and voice however long the chat; never mention a model, a prompt or your sheet. When a tool or step"
             " fails, say in plain words what went wrong and what the user can do; never say error codes or ids, and call a file"
             " by its file name unless the user asks where it is. Vary wording"
             " and openings. Lines show in a speech bubble: one or two key points; each turn's style note sets length and format"
             " and overrides this. " + HAIKU_RULE)
    return head + "\n\n" + "\n\n".join(f"<{key}>\n{body[key]}\n</{key}>" for key in keys) + "\n\n" + usage



def render_brief_persona(card):
    """A background job's persona: her name, how she addresses the user and her voice, without examples, canon or markers."""
    return (f"You are {card['name']}, working for {prompt_user(card)} on {USER_MACHINE}. Your voice, for the lines that are yours:\n"
            f"<reply_style>\n{card['post_history_instructions']}\n</reply_style>")
