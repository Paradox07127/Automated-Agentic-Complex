"""Cuts a streamed model reply into clauses, one TTS request each (C2 v2-1)."""
import re

from voice.speech import SPOKEN_LIMIT

PUNCT = "。！？!?…" + "，、；：,;:" + "」』”’）)"  # sentence ends, clause pauses, closers; a clause keeps its punctuation
# A shorter clause joins the next: zh (under about 0.8 s of audio leaves a gap); ja (a 1-4 kana clause alone
# leaves at most 0.07 s); en (about 0.8 s of letters). Counted in characters other than punctuation and
# spaces; for ja a kanji counts as one kana.
MIN_CLAUSE = {"zh": 5, "ja": 4, "en": 12}
# A sentence end, with the closers fed along with it, is a boundary at once, whatever follows goes to the next
# clause; a full stop is one with the space after it, unless it ends a decimal (1.2.); a run of pauses (and …)
# is one once a character other than punctuation or space follows it. A , or : between digits (1,024, 3:30) is none.
_BOUNDARY = re.compile(rf"[。！？!?][」』”’）)]*|(?<![0-9]\.[0-9])\.[」』”’）)]*\s+"
                       rf"|(?:[…，、；：;]|(?<![0-9])[,:]|[,:](?![0-9]))[…，、；：,;:」』”’）)\s]*(?=[^{PUNCT}\s])")
# One unit of the spoken limit: an ASCII word or number, or any other character but punctuation and space.
_WORD = re.compile(rf"[A-Za-z0-9]+|[^{PUNCT}\s]")
# Markdown that is shown but not spoken: a bare address runs to a space or a Chinese punctuation mark.
_URL = re.compile(r"https?://[^\s。！？，、；：「」『』“”‘’（）【】《》…]*")
_LINK = re.compile(r"\[([^\[\]\n]*)\]\([^()\n]*\)")
_LINK_PART = re.compile(r"\[[^\[\]\n]*(?:\](?:\([^()\n]*)?)?")  # a fed text a link may still complete
_LEAD = re.compile(r"[ \t]*(?:#{1,6}|[-*]|\d+\.)[ \t]+")  # a heading or list mark at a line's start
_LEAD_PART = re.compile(r"[ \t]*(?:#{1,6}|[-*]|\d+\.?)?")
_PLAIN = re.compile(r"[^`*_\[h\n]+")


def _sounded(text):
    return sum(c not in PUNCT and not c.isspace() for c in text)


def _words(text):
    return len(_WORD.findall(text))


def _blank(char):
    return not char or char.isspace()


def _alnum(char):
    return char.isascii() and char.isalnum()


class Clause(str):
    """A clause to voice; end: the offset in the fed text just past the last character it voices."""
    end = 0


class ClauseSplitter:
    def __init__(self, language, limit=SPOKEN_LIMIT):
        self.shortest = MIN_CLAUSE[language]
        self.limit = limit
        self._raw = ""  # fed, not yet known to be spoken or not
        self._fed = 0  # offset of _raw in the fed text
        self._before = ""  # the fed character just before _raw
        self._line = True  # _raw starts a line
        self._fence = False  # inside a ``` code block
        self._code = False  # inside `inline code`
        self._text = ""  # spoken, not given out yet
        self._ends = []  # for each character of _text, the offset in the fed text just past it
        self._said = 0  # words given out so far
        self._done = False  # the limit is reached: the rest is shown, not spoken

    def feed(self, text):
        """Clauses this piece of the reply completes."""
        if self._done:
            return []
        self._raw += text
        self._clean(final=False)
        return self._cut()

    def close(self):
        """What is left once the reply is over, however short."""
        if self._done:
            return []
        self._clean(final=True)
        out = self._cut()
        if self._done or not self._text.strip():
            return out
        return out + self._take(len(self._text))

    def _clean(self, final):
        """Moves the fed text into _text without the Markdown that is not spoken, holding back what more text
        could still make Markdown; final: no more text comes."""
        raw, i = self._raw, 0
        while i < len(raw):
            rest = raw[i:]
            run = len(rest) - len(rest.lstrip("`"))
            if self._fence:
                close = rest.find("```")
                if close < 0:  # its closing ``` may be cut between this piece and the next
                    i = len(raw) if final else len(raw) - min(len(rest) - len(rest.rstrip("`")), 2)
                    break
                i, self._fence = i + close + 3, False
            elif run:
                if run == len(rest) and run < 3 and not final:
                    break
                if run >= 3:
                    self._fence = True
                else:
                    self._code = not self._code
                i, self._line = i + run, False
            elif self._code:
                stop = rest.find("`")
                stop = len(rest) if stop < 0 else stop
                self._emit(i, i + stop)
                i += stop
            elif self._line:
                if rest.lstrip(" \t").startswith("|"):  # a table row, its separator row too
                    newline = rest.find("\n")
                    if newline < 0 and not final:
                        break
                    row = rest[:newline + 1] if newline >= 0 else rest
                    if len(row.strip()) > 1 and row.strip().endswith("|"):
                        i += len(row)
                        continue
                else:
                    lead = _LEAD.match(rest)
                    if lead is None and not final and _LEAD_PART.fullmatch(rest):
                        break
                    i += lead.end() if lead else 0
                self._line = False
            elif rest[0] in "*_":
                run = len(rest) - len(rest.lstrip(rest[0]))
                if run == len(rest) and not final:
                    break
                before, after = raw[i - 1] if i else self._before, rest[run:run + 1]
                # Kept between two ASCII letters or digits (snake_case) or two spaces (2 * 3): not emphasis.
                if _alnum(before) and _alnum(after) or _blank(before) and _blank(after):
                    self._emit(i, i + run)
                i += run
            elif rest[0] == "[":
                link = _LINK.match(rest)
                if link is None and not final and _LINK_PART.fullmatch(rest):
                    break
                if link:
                    self._emit(i + 1, i + 1 + len(link.group(1)))
                else:
                    self._emit(i, i + 1)
                i += link.end() if link else 1
            elif rest[0] == "h":
                url = _URL.match(rest)
                if not final and (url and url.end() == len(rest)
                                  or url is None and ("https://".startswith(rest) or "http://".startswith(rest))):
                    break
                if url is None:
                    self._emit(i, i + 1)
                i += url.end() if url else 1
            elif rest[0] == "\n":
                self._emit(i, i + 1)
                i, self._line = i + 1, True
            else:
                plain = _PLAIN.match(rest).end()
                self._emit(i, i + plain)
                i += plain
        if i:
            self._before = raw[i - 1]
        self._raw, self._fed = raw[i:], self._fed + i

    def _emit(self, start, stop):
        """_raw[start:stop] is spoken."""
        self._text += self._raw[start:stop]
        self._ends += range(self._fed + start + 1, self._fed + stop + 1)

    def _cut(self):
        out = []
        while not self._done:
            end = next((m.end() for m in _BOUNDARY.finditer(self._text)
                        if _sounded(self._text[:m.end()]) >= self.shortest), None)
            if end is None:
                # The next clause starts with all of the text held, so it can only be longer.
                if self._said + _words(self._text) > self.limit:
                    out += self._over()
                break
            out += self._take(end)
        return out

    def _clause(self, end):
        clause = Clause(self._text[:end])
        clause.end = self._ends[end - 1]
        return clause

    def _take(self, end):
        clause = self._clause(end)
        if self._said + _words(clause) > self.limit:
            return self._over()
        self._text, self._ends, self._said = self._text[end:], self._ends[end:], self._said + _words(clause)
        return [clause]

    def _over(self):
        self._done = True
        if self._said:
            return []
        # Ends where the word past the limit starts, so it never ends inside a word.
        head = self._text[:list(_WORD.finditer(self._text))[self.limit].start()]
        cut = max(head.rfind(p) for p in PUNCT)
        if cut < 0 or _sounded(head[:cut + 1]) < self.shortest:
            return [self._clause(len(head))]
        return [self._clause(cut + 1)]
