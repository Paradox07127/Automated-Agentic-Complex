"""Deterministic commands checked before the LLM; anything else returns None."""
import functools
import re

from brain import characters
from personal.commitments import WAIT

# English keys are matched lower-cased.
_EXACT = {"停下": "stop", "停": "stop", "停一下": "stop", "别说了": "stop", "闭嘴": "stop",
          "拒绝": "deny", "不批准": "deny", "驳回": "deny",
          "静音": "mute", "取消静音": "unmute", "解除静音": "unmute",
          "停止任务": "stop_task", "取消任务": "stop_task", "别做了": "stop_task",
          **dict.fromkeys(("看一下", "看看", "看一眼", "你看看", "你看一下", "你看一眼", "看看这个", "你看看这个",
                           "帮我看看", "帮我看一下", "帮我看一眼"), "look"),
          **dict.fromkeys(("stop", "stop talking", "be quiet", "quiet", "shut up", "hush",
                           "止まって", "やめて", "黙って", "ストップ", "静かに", "静かにして"), "stop"),
          **dict.fromkeys(("deny", "deny it", "reject", "reject it", "decline", "don't approve",
                           "拒否", "拒否して", "却下", "却下して", "承認しない"), "deny"),
          **dict.fromkeys(("mute", "ミュート", "ミュートして"), "mute"),
          **dict.fromkeys(("unmute", "ミュート解除", "ミュートを解除して"), "unmute"),
          **dict.fromkeys(("stop the task", "cancel the task", "stop working",
                           "タスクを止めて", "タスクをキャンセル", "タスクをキャンセルして", "作業をやめて"), "stop_task"),
          **dict.fromkeys(("look", "take a look", "have a look", "look at this", "take a look at this",
                           "have a look at this", "見て", "見てみて", "ちょっと見て", "これ見て", "これを見て"), "look")}
_DISPATCH = (re.compile(r"^让\s*(claude|codex)\s*[，,]?\s*(.+)$", re.IGNORECASE | re.DOTALL),
             re.compile(r"^(?:ask|have|get)\s+(claude|codex)\s+(?:to\s+)?(.+)$", re.IGNORECASE | re.DOTALL),
             re.compile(r"^(claude|codex)\s*に[、,]?\s*(.+(?:させて|してもらって|頼んで))$", re.IGNORECASE | re.DOTALL))
_NAME = r"([^\s，,。；;：:？?！!、]{1,24}(?:\s[^\s，,。；;：:？?！!、]{1,24}){0,2})"
_TARGETED = [(re.compile(rf"^打开\s*{_NAME}$"), "open"),
             (re.compile(rf"^(?:跳到|切到|切换到)\s*{_NAME}$"), "jump"),
             (re.compile(rf"^open\s+(?:the\s+)?{_NAME}$", re.IGNORECASE), "open"),
             (re.compile(rf"^(?:switch|go|jump)\s+to\s+(?:the\s+)?{_NAME}$", re.IGNORECASE), "jump"),
             (re.compile(rf"^{_NAME}\s*を\s*開いて$"), "open"),
             (re.compile(rf"^{_NAME}\s*に\s*(?:切り替えて|移動して)$"), "jump")]
# the target must look like an app or session name; questions, requests and file names go to the character
_NOT_TARGET = re.compile(r"什么|多少|几[个点次天]|怎么|为什么|吗|呢|看看|一下|告诉|帮我|然后|\.[A-Za-z0-9]{1,5}$|/|"
                         r"\b(?:what|which|how|why|where|when|it|this|that|me|and|then)\b|"
                         r"これ|それ|あれ|この|その|あの|何|どこ|どう|なぜ", re.IGNORECASE)


@functools.cache
def prefix_names():
    return tuple(characters.names())  # any character's name may open a command, whoever is on screen


@functools.cache
def _strip(names):
    return re.compile(rf"^((?:{'|'.join(map(re.escape, names))})[，,\s]*)?(请|please)?[，,\s]*|"
                      r"[\s。！!？?，,~～.]*(吧|please|ください)?[\s。！!？?，,~～.]*$", re.IGNORECASE)


def parse_command(text, names=None):
    strip = _strip(prefix_names() if names is None else tuple(names))
    core = strip.sub("", text.strip())
    for pattern in _DISPATCH:
        dispatch = pattern.match(core)
        if dispatch:
            return {"action": "dispatch", "target": dispatch.group(1).lower(), "prompt": dispatch.group(2).strip()}
    if core.startswith("提醒我") or WAIT.match(core):
        return {"action": "remind", "text": core}
    if core.lower() in _EXACT:
        return {"action": _EXACT[core.lower()]}
    for pattern, action in _TARGETED:
        match = pattern.match(core)
        if match and not _NOT_TARGET.search(match.group(1)):
            return {"action": action, "target": match.group(1).strip()}
    return None
