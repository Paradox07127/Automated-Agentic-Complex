"""Deterministic commands checked before the LLM; anything else returns None."""
import functools
import re

from brain import characters

# English keys are matched lower-cased.
_EXACT = {"停下": "stop", "停": "stop", "停一下": "stop", "别说了": "stop", "闭嘴": "stop",
          "拒绝": "deny", "不批准": "deny", "驳回": "deny",
          "静音": "mute", "取消静音": "unmute", "解除静音": "unmute",
          **dict.fromkeys(("stop", "stop talking", "be quiet", "quiet", "shut up", "hush",
                           "止まって", "やめて", "黙って", "ストップ", "静かに", "静かにして"), "stop"),
          **dict.fromkeys(("deny", "deny it", "reject", "reject it", "decline", "don't approve",
                           "拒否", "拒否して", "却下", "却下して", "承認しない"), "deny"),
          **dict.fromkeys(("mute", "ミュート", "ミュートして"), "mute"),
          **dict.fromkeys(("unmute", "ミュート解除", "ミュートを解除して"), "unmute")}


@functools.cache
def prefix_names():
    return tuple(characters.names())  # any character's name may open a command, whoever is on screen


@functools.cache
def _prefix(names):
    names = sorted(names, key=len, reverse=True)  # a longer name wins over a name it starts with
    return re.compile(rf"^(?:(?:{'|'.join(map(re.escape, names))})[，,\s]*)?(?:请|\bplease\b)?[，,\s]*", re.IGNORECASE)


_TAIL = re.compile(r"[\s。！!？?，,~～.]*(?:吧|\bplease|ください)?[\s。！!？?，,~～.]*$", re.IGNORECASE)


def parse_command(text, names=None):
    core = _prefix(prefix_names() if names is None else tuple(names)).sub("", text.strip(), count=1)
    core = _TAIL.sub("", core, count=1)
    if core.lower() in _EXACT:
        return {"action": _EXACT[core.lower()]}
    return None
