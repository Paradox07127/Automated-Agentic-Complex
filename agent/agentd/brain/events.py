"""Event cues: something that happened, sent in the user's turn but not the user's words (persona.EVENT_RULE)."""


def cue(kind, facts, aim, **attrs):
    """kind and attrs: short internal labels (no quotes) on the tag; facts: what happened, in plain sentences; aim: what
    this line is for. History keeps only the <event> element (recorded)."""
    labels = "".join(f' {key}="{value}"' for key, value in attrs.items() if value is not None)
    return f'<event kind="{kind}"{labels}>\n{facts}\n</event>\n{aim}'


def recorded(text):
    """What history keeps of a turn's text: a cue's <event> element without its aim, else text unchanged."""
    end = text.find("\n</event>") if text.startswith("<event ") else -1
    return text[:end + len("\n</event>")] if end >= 0 else text
