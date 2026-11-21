"""The language the character replies in: code picks it from the setting and the user's own words, the model is told by tag."""
import re

SUPPORTED = {"zh-Hans": "Simplified Chinese", "en": "English", "ja": "Japanese"}
# runtime setting `reply_language`; "harness" sends no language and leaves it to the harness's own configuration.
SETTINGS = ("auto", "zh-Hans", "en", "ja", "harness")
SYSTEM_RULE = ("Write everything the user will read or hear in the language named by the latest <reply_language> tag; "
               "keep code, identifiers, file names, product names and quoted material as they are.")

_FENCE = re.compile(r"```.*?(?:```|\Z)", re.S)
_INLINE = re.compile(r"`[^`\n]*`")
_URL = re.compile(r"\b[A-Za-z][A-Za-z0-9+.-]*://\S+|\bwww\.\S+")
_KANA = re.compile(r"[぀-ヿ]")
_HAN = re.compile(r"[㐀-䶿一-鿿豈-﫿]")
_WORD = re.compile(r"[A-Za-zÀ-ɏ]+")


def detect(text):
    """'ja', 'zh-Hans' or 'en' when the text clearly is that language, else None; code and URLs do not count."""
    text = _URL.sub(" ", _INLINE.sub(" ", _FENCE.sub(" ", text or "")))
    kana, han = len(_KANA.findall(text)), len(_HAN.findall(text))
    if kana and kana + han >= 2:
        return "ja"
    if han >= 2 and not kana:
        return "zh-Hans"
    if len(_WORD.findall(text)) >= 3:
        return "en"
    return None


def mismatch(code, text):
    """True when the text clearly is a supported language other than code."""
    found = detect(text)
    return found is not None and found != code


class ReplyLanguage:
    """The language "auto" has pinned from the user's messages; it starts in the app's own language, Chinese."""

    def __init__(self):
        self.pinned = "zh-Hans"

    def observe(self, setting, user_text):
        if setting == "auto":
            found = detect(user_text)
            if found:
                self.pinned = found

    def current(self, setting):
        if setting == "harness":
            return None
        return self.pinned if setting == "auto" else setting

    def tag(self, setting):
        language = self.current(setting)
        return f"<reply_language>{SUPPORTED[language]}</reply_language>" if language else ""
