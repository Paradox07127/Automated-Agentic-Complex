"""The current character's game gestures a [motion:...] text can name: matched ones play the original clip, the rest
are generated. phrases.json maps each group to its English phrase and its regex; a group's members are the package's
actions.json rows whose gestures name it."""
import json
from pathlib import Path
import re

SECTIONS = ("talk", "react", "touch", "idle")
MAX_LENGTH = 8.0  # s: longer clips are never matched
GROUPS = [dict(g, pattern=re.compile(g["regex"], re.I))
          for g in json.loads((Path(__file__).with_name("phrases.json")).read_text(encoding="utf-8"))]


def load(package_root):
    """{action_id: {length_s, clips, gestures}} of the package's gestures, in actions.json row order; {} when the package
    has no animation files."""
    found = {}
    for animation in sorted(Path(package_root).glob("runtime/characters/*/c7/animation")):
        try:
            actions = json.loads((animation / "actions.json").read_text(encoding="utf-8"))["actions"]
            clips = json.loads((animation / "clip-catalog.json").read_text(encoding="utf-8"))["clips"]
        except FileNotFoundError:
            continue
        lengths = {clip["name"]: clip["length"] for clip in clips}
        for action in actions:
            names = action.get("clips") or []
            if action.get("section") not in SECTIONS or action.get("command") or action.get("unavailable_reason") \
                    or not names or any(name not in lengths for name in names):
                continue
            length = action.get("duration") or sum(lengths[name] for name in names)
            if 0 < length <= MAX_LENGTH:
                found[action["id"]] = {"length_s": round(length, 3), "clips": names, "gestures": action.get("gestures") or []}
    return found


def members(group, catalog):
    """The catalog's action ids whose gestures name group, in catalog order."""
    return [aid for aid, row in catalog.items() if group["group"] in row["gestures"]]


def match(prompt, seconds, catalog):
    """(action_id, group, length_s) of the group whose regex hits the longest span, its member closest to seconds;
    None when no group with a member in catalog hits."""
    best = None
    for group in GROUPS:
        ids = members(group, catalog)
        if not ids:
            continue
        for hit in group["pattern"].finditer(prompt):
            if best is None or hit.end() - hit.start() > best[0]:
                best = (hit.end() - hit.start(), group["group"], ids)
    if best is None:
        return None
    action_id = min(best[2], key=lambda aid: abs(catalog[aid]["length_s"] - seconds))
    return action_id, best[1], catalog[action_id]["length_s"]


def named(prompt, seconds, catalog):
    """match() for a prompt that is one of phrases(catalog) itself, case, spacing and end punctuation aside; else None."""
    key = " ".join(prompt.casefold().split()).strip(" .!")
    for group in GROUPS:
        ids = members(group, catalog)
        if ids and group["en"].casefold() == key:
            action_id = min(ids, key=lambda aid: abs(catalog[aid]["length_s"] - seconds))
            return action_id, group["group"], catalog[action_id]["length_s"]
    return None


def phrases(catalog):
    """The English phrases of the groups with a member in catalog, in table order."""
    return [group["en"] for group in GROUPS if members(group, catalog)]
