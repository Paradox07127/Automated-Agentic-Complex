"""Shared overlap checks and redaction for text sent to models."""
import base64
import binascii
import json
import re
import threading


_SECRET_NAME = r"(?i:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|passwd|password|secret|authorization)"
_KEY = re.compile(
    # A named value: `password=…`, `api_key: …`, `"token": "…"`; an Authorization scheme is left to the branch below.
    # A capture may end inside a quoted value or its final escape: the value then runs to the end of the text.
    rf"(?P<named>(?<![A-Za-z0-9])[\"']?{_SECRET_NAME}[\"']?[ \t]*[:=][ \t]*)"
    r"(?:(?P<quote>[\"'])(?P<quoted>(?:\\[\s\S]|(?!(?P=quote))[^\\])*)(?:(?P<close>(?P=quote))|\\?\Z)|"
    r"(?!(?i:bearer|basic)[ \t])(?!\[已遮蔽:密钥\])[^\s,;\"'<>}]+)|"
    # Outside an Authorization header a scheme word counts only before a credential-shaped value, so prose keeps it.
    r"(?P<bearer>(?P<auth>(?<![A-Za-z0-9])[\"']?(?i:authorization)[\"']?[ \t]*[:=][ \t]*)?"
    r"(?:(?P<basic>(?i:Basic))|(?i:Bearer))[ \t]+)"
    r"(?(auth)[^\s,;\"'<>]+|(?(basic)(?P<b64>[A-Za-z0-9+/]{4,}={0,2})|"
    r"(?=[A-Za-z0-9._~+/-]*?(?:[0-9]|[._~+/-][A-Za-z0-9]))[A-Za-z0-9._~+/-]+=*)(?![^\s,;\"'<>]))|"
    r"(?<![A-Za-z0-9_])(?:sk-ant-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{20,}|"
    r"(?:gh[pos]_|github_pat_)[A-Za-z0-9_]+|"
    r"AKIA[A-Z0-9]{16}(?![A-Za-z0-9])|xox[abprs]-[A-Za-z0-9-]+|"
    r"eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"
)
_EMAIL = re.compile(r"(?<![A-Za-z0-9.!#$%&'*+/=?^_`{|}~-])[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?"
                    r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+")
_PHONE = re.compile(r"(?P<uuid>[0-9A-Fa-f]{8}-(?:[0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12})|"
                    r"(?<![0-9+])(?:\+[0-9](?:[ -]*[0-9]){7,}|"
                    r"(?:86[ -]*)?1[3-9](?:[ -]*[0-9]){9})(?![0-9])")


def _basic_credential(value):
    # Basic credentials are base64 of `user:password`; a word like `concepts` only looks like base64.
    try:
        return ':' in base64.b64decode(value, validate=True).decode('utf-8')
    except (binascii.Error, UnicodeDecodeError):
        return False


def _redact_text(text, contacts=True):
    counts = {"key": 0, "email": 0, "phone": 0}

    def key(match):
        if match.group('named') is not None:
            quote = match.group('quote') or ''
            if quote and match.group('quoted') == '[已遮蔽:密钥]':
                return match.group()
            counts["key"] += 1
            return match.group('named') + quote + "[已遮蔽:密钥]" + (match.group('close') or '')
        prefix = match.group('bearer') or ''
        if prefix and match.group()[len(prefix):] == '[已遮蔽:密钥]':
            return match.group()
        if match.group('b64') is not None and not _basic_credential(match.group('b64')):
            return prefix + _KEY.sub(key, match.group('b64'))
        counts["key"] += 1
        return prefix + "[已遮蔽:密钥]"

    def email(match):
        counts["email"] += 1
        return "[已遮蔽:邮箱]"

    def phone(match):
        value = match.group()
        if match.group('uuid'):
            return value
        if value.startswith("+") and not 8 <= sum(c.isdigit() for c in value) <= 15:
            return value
        counts["phone"] += 1
        return "[已遮蔽:电话]"

    text = _KEY.sub(key, text)
    if not contacts:
        return text, counts
    # A local-part run can only start at its boundary. Trying every suffix of
    # a long code/base64 token was quadratic and held the interpreter/GIL.
    if '@' in text: text = _EMAIL.sub(email, text)
    return _PHONE.sub(phone, text), counts


# The plain-text rule's name boundary: `csrf_token` and `x-api-key` count, `token_count` and `mytoken` do not.
_SECRET_MEMBER = re.compile(rf"(?<![A-Za-z0-9]){_SECRET_NAME}\Z")


class _ObjectPairs(list):
    """Keep every JSON member, including duplicate/redaction-colliding keys."""


def redact(text, contacts=True):
    # Redacting encoded JSON can consume the n/t of an escape or the slash
    # before a quote. Work on decoded leaves, then encode them again.
    if text.lstrip()[:1] not in ('{', '['):
        return _redact_text(text, contacts)
    try:
        value = json.loads(text, object_pairs_hook=_ObjectPairs)
    except (ValueError, RecursionError):
        return _redact_text(text, contacts)
    counts = {'key': 0, 'email': 0, 'phone': 0}

    def string(value):
        # Tool responses can themselves contain serialized JSON.
        masked, found = redact(value, contacts)
        for key, count in found.items(): counts[key] += count
        return json.dumps(masked, ensure_ascii=False)

    def member(name, value):
        if _SECRET_MEMBER.search(name) and value != '[已遮蔽:密钥]':
            counts['key'] += 1
            return json.dumps('[已遮蔽:密钥]', ensure_ascii=False)
        return encode(value)

    def encode(value):
        if isinstance(value, _ObjectPairs):
            return '{' + ','.join(string(k) + ':' + member(k, v) for k, v in value) + '}'
        if isinstance(value, list):
            return '[' + ','.join(encode(v) for v in value) + ']'
        if isinstance(value, str): return string(value)
        raw = json.dumps(value, allow_nan=False)
        masked, found = _redact_text(raw, contacts)
        for key, count in found.items(): counts[key] += count
        return json.dumps(masked, ensure_ascii=False) if masked != raw else raw

    try:
        masked = encode(value)
    except (ValueError, RecursionError):
        return _redact_text(text, contacts)
    # Keep whitespace, number spelling and source identity when unchanged.
    return (masked if any(counts.values()) else text), counts


class EgressPolicy:
    def __init__(self, guard=None, redact=True):
        self.guard = guard
        self._redact = redact
        self.redactions = {"key": 0, "email": 0, "phone": 0}
        self._lock = threading.Lock()

    def set_redact(self, on):
        self._redact = on

    def authored(self, part, text):
        if self.guard is not None:
            self.guard.check(part, text)
        return text

    def observed(self, text):
        return self._masked(text, True)

    def user_text(self, text):
        # The user's own phone numbers and emails are what the turn is about; only keys stay hidden.
        return self._masked(text, False)

    def _masked(self, text, contacts):
        if not self._redact:
            return text
        text, counts = redact(text, contacts)
        with self._lock:
            for key, count in counts.items():
                self.redactions[key] += count
        return text

    def replayed(self, part, text):
        return self.observed(self.authored(part, text))
