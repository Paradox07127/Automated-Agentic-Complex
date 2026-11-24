"""Spot assistant-voice replies (AI self-reference, Markdown layout) and rewrite them for history replay."""
import re

_AI = re.compile("|".join((
    r"作为\s*(?:一个|一名)?\s*(?:ai|人工智能|(?:大)?语言模型)",
    r"我是\s*(?:一个|一名)?\s*(?:ai|人工智能|(?:大)?语言模型)",
    r"\bas an ai\b", r"\bas a (?:large )?language model\b",
    r"\bi am an ai\b", r"\bi'm an ai\b", r"\bi am a (?:large )?language model\b",
    r"ai\s*として", r"人工知能として", r"言語モデル",
)), re.IGNORECASE)
_HEADING = re.compile(r" {0,3}#{1,6}[ \t]+(?=\S)")
_LIST = re.compile(r"[ \t]*(?:[-*•][ \t]+|\d+\.[ \t]+|\d+、[ \t]*)(?=\S)")
_SENTENCE = re.compile(r".*?(?:[。！？!?…]+[」』）)\"']*|\.+(?=\s|$)|$)[ \t]*")
_CJK = re.compile(r"[぀-ヿ㐀-鿿]")


def _prose(text):
    """Yield (line, inside_code) for each line; fence lines count as code."""
    fenced = False
    for line in text.split("\n"):
        fence = line.lstrip().startswith("```")
        yield line, fenced or fence
        if fence:
            fenced = not fenced


def out_of_voice(text):
    reasons = []
    lines = [line for line, code in _prose(text) if not code]
    if any(_AI.search(line) for line in lines):
        reasons.append("ai_self_reference")
    if any(_HEADING.match(line) for line in lines) or sum(bool(_LIST.match(line)) for line in lines) >= 3:
        reasons.append("markdown_layout")
    return reasons


def for_replay(text):
    joiner = "；" if _CJK.search(text) else "; "
    out, in_list = [], False
    for line, code in _prose(text):
        if code:
            out.append(line); in_list = False
            continue
        marker = _LIST.match(line)
        prefix = marker or _HEADING.match(line)
        content = line[prefix.end():] if prefix else line
        sentences = [m.group(0) for m in _SENTENCE.finditer(content) if m.group(0)]
        kept = [s for s in sentences if not _AI.search(s)]
        if len(kept) < len(sentences):
            content = "".join(kept).rstrip()
        if line.strip() and not content.strip():
            continue
        if marker and in_list:
            out[-1] += joiner + content
        else:
            out.append(content)
        in_list = bool(marker)
    return "\n".join(out)
