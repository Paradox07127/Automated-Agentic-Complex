"""User state:the user's mode, state and what is on their mind, by rules over events_raw and the activity scene.

derive() is pure: the events of recent_events(now - 600), activity.snapshot's inputs and activity.assemble's scene
in, {"mode", "state", "thread", "on_mind", "blocker", "evidence"} out. UserState holds a change back until it has
lasted HOLD seconds and keeps what was in effect before the user left. No model is asked here; apply_judgment()
lays the on-device model's judgment, which the server asks for, over what the rules could not tell."""
import itertools
import os
import re
import threading

from observation.activity import FAILURE_EVENTS, FAILURE_KEYWORDS, SWITCHES, _category, _host_in
from observation.blacklist import HIDDEN

MODES = ("away", "meeting", "relaxing", "coding", "reading", "writing", "other")
STATES = ("stuck", "flowing", "searching", "idle", "unknown")
MODE_NAMES = {"coding": "writing code", "reading": "reading", "writing": "writing or messaging", "relaxing": "relaxing",
              "meeting": "in a meeting", "away": "away", "other": "doing something else"}

RELAX_HOSTS = ("weibo.com", "xiaohongshu.com", "reddit.com", "x.com", "twitter.com", "douyin.com", "tiktok.com",
               "instagram.com")
MUSIC_BUNDLES = {"com.spotify.client", "com.apple.Music", "com.netease.163music", "com.tencent.QQMusicMac"}
RELAX_ACTIVITIES = {"watching_video", "gaming"}
CODING_ACTIVITIES = {"editing_code", "build_failed"}
READING_ACTIVITIES = {"reading", "comparing_sources"}
CODE_KINDS = {"coding", "terminal"}  # front categories that are code work
ACTIVE_STATES = {"thinking", "running_tool", "awaiting_approval"}  # an own session's states that count as active
SESSION_RECENT = 120.0  # seconds since a related session's last event that still make it active
TYPED_WINDOW = 300.0  # seconds of value events for music, writing, flowing and backspace
WRITING_CHARS = 50  # net growth of typed characters that makes writing
ERROR_WINDOW = 600.0  # seconds of value events, failures and prompts for repeat_error, fail_loop and ask_again
ERROR_TAIL = 20  # last lines of a value searched for failure keywords
REPEAT_MIN = 2  # value events holding one error line for repeat_error
REPEAT_ALONE = 3  # value events holding one error line for stuck on that clue alone
STUCK_CLUES = 2
FAIL_LOOP = 2  # failures without a success between them
BACKSPACE_EVENTS = 3
BACKSPACE_SHARE = 0.4  # shrink over the positive growth
SEARCH_WINDOW = 300.0
SEARCH_SWITCHES = 4  # switches between code and the browser
SEARCH_WORDS = 2  # words of one error line in a browser title or selection
ASK_JACCARD = 0.5  # character bigram Jaccard of two prompts
FLOW_EVENTS = 3
FLOW_SWITCHES = 2  # switches_60s at most
SEARCHING_SWITCHES = SWITCHES
IDLE_STILL = 120.0  # seconds on one front window
ON_MIND_WINDOW = 120.0
ON_MIND_MAX = 60
BLOCKER_MAX = 80
THREAD_DEPTH = 8  # directories looked at for .git, the doc's own first
HOLD = 30.0  # seconds a new mode or state must last before it takes effect
IMMEDIATE = {"away", "meeting"}  # modes entered and left at once
SUCCESS = "done"  # the registry outcome of a turn that ended well
JUDGE_EVERY = 60.0  # seconds between questions to the on-device model
JUDGE_FRESH = 120.0  # seconds a judgment stays usable after it was asked
JUDGE_CONFIDENCE = 0.6
JUDGE_MODES = {"coding", "reading", "writing", "relaxing"}  # modes a judgment may name in place of other
JUDGE_INSTRUCTIONS = (
    "From the activity records of the user's computer, judge the user's mode and state right now.\n"
    "mode: coding = writing code, debugging or working in a terminal; reading = reading docs, web pages or material; "
    "writing = writing articles, notes, messages or mail; relaxing = watching videos, listening to music, browsing "
    "social sites or gaming; meeting = in a meeting or call; away = not at the computer; other = none of these.\n"
    "state: stuck = hitting the same error again and again, or retrying without progress; flowing = typing and moving "
    "forward steadily; searching = looking back and forth across several windows or pages; idle = resting on one "
    "place with almost no input; unknown = cannot tell.\n"
    "on_mind is one sentence on what the user is thinking about or doing now, at most 30 characters in Chinese or "
    "Japanese or 12 words in English. confidence is a number from 0 to 1 for how sure you are.\n"
    "Judge only from the records given; do not guess what they do not hold. When unsure, use unknown for state and "
    "a low confidence.")
SEARCH_ROLES = {"AXSearchField", "AXComboBox"}
SEARCH_LABELS = ("搜索", "search", "查找", "検索")
SENTENCE = re.compile(r"[。！？.!?\n]")
HEX = re.compile(r"\b0x[0-9a-fA-F]+\b|\b[0-9a-fA-F]{7,}\b")
PATH = re.compile(r"[~.\w-]*/[^\s:'\"()]+")
DIGITS = re.compile(r"\d+")
WORDS = re.compile(r"[A-Za-z_][A-Za-z0-9_]{2,}|[一-鿿]{2,}|[゠-ヿ]{2,}")

_roots = {}  # doc -> its git root's directory name or None


def derive(events, inputs, scene, now):
    focus = inputs.get("focus")
    hidden = focus is None or focus.get("app") == HIDDEN["app"]
    kind = None if hidden else _category(focus)
    counts = [e["input"] for e in (inputs.get("presence") or {}).get("inputs") or [] if "input" in e]
    last = counts[-1] if counts else {}
    typed = [(e, gain) for e, gain in _typed(events) if now - e["ts"] <= TYPED_WINDOW]
    net = sum(gain for _, gain in typed)
    marks = _outcomes(inputs, scene, now)
    mode, code = _mode(scene, inputs, focus, hidden, kind, typed, net, now)
    evidence = [code] if code else []
    repeats = {line: seen for line, seen in _errors(events, now).items() if len(seen) >= REPEAT_MIN}
    state, blocker = "unknown", None
    clues = _clues(events, inputs, focus, kind, typed, marks, repeats, now) if mode == "coding" else []
    if len(clues) >= STUCK_CLUES or "repeat_error" in clues and max(map(len, repeats.values())) >= REPEAT_ALONE:
        state = "stuck"
        evidence += clues
        blocker = max((seen[-1] for seen in repeats.values()), default=(None, None))[1]
        blocker = blocker and blocker[:BLOCKER_MAX]
    elif mode in ("coding", "writing") and len(typed) >= FLOW_EVENTS and net > 0 \
            and last.get("switches_60s", 0) <= FLOW_SWITCHES and _settled(marks, now - TYPED_WINDOW):
        state = "flowing"
        evidence.append("steady_typing")
    elif (scene["activity"] == "switching" or last.get("switches_60s", 0) >= SEARCHING_SWITCHES) \
            and not _errors(events, now) and not any(failed for _, failed in marks):
        state = "searching"
        evidence.append("switching")
    elif mode != "away" and (inputs.get("dwell_s") or 0.0) >= IDLE_STILL and last.get("keys_60s") == 0 \
            and last.get("scrolls_30s") == 0:
        state = "idle"
        evidence.append("still")
    task = scene.get("interpreted")
    if blocker is None and task is not None and task["state"] == "blocked":
        blocker = task["title"][:BLOCKER_MAX]
    return {"mode": mode, "state": state, "thread": _thread(events, focus, hidden) or scene.get("subject"),
            "on_mind": _on_mind(events, focus, kind, now), "blocker": blocker, "evidence": evidence}


def _mode(scene, inputs, focus, hidden, kind, typed, net, now):
    """(mode, the code of the rule that named it or None)."""
    activity = scene["activity"]
    host = None if hidden else focus.get("url_host") or (
        (inputs.get("page") or {}).get("url_host") if kind == "browsing" else None)
    if activity in ("away", "meeting"):
        return activity, f"scene_{activity}"
    if activity in RELAX_ACTIVITIES:
        return "relaxing", "scene_relax"
    if _host_in(host, RELAX_HOSTS):
        return "relaxing", "relax_host"
    if not hidden and focus.get("bundle_id") in MUSIC_BUNDLES and not typed:
        return "relaxing", "music"
    if activity in CODING_ACTIVITIES:
        return "coding", "scene_coding"
    if kind in CODE_KINDS:
        return "coding", "front_coding"
    if _session_active(inputs, scene, now):
        return "coding", "session_active"
    if activity in READING_ACTIVITIES:
        return "reading", "scene_reading"
    if net >= WRITING_CHARS:
        return "writing", "typed_text"
    return "other", None


def _session_active(inputs, scene, now):
    related = set(scene.get("related_session_ids") or ())
    return any(s.get("state") in ACTIVE_STATES for s in inputs.get("own_sessions") or []) \
        or any(s.get("display_session") in related and now - (s.get("observed_at") or 0.0) <= SESSION_RECENT
               for s in inputs.get("sessions") or [])


def _typed(events):
    """[(value event, gain)]: gain is its length minus the previous length of the same field, 0 for a field's
    first event here."""
    lengths, out = {}, []
    for e in events:
        if e["kind"] != "value":
            continue
        n = e.get("value_len")
        if n is None and e.get("value") is not None:
            n = len(e["value"])
        key = (e.get("bundle_id") or e.get("app"), e.get("doc") or e.get("window"), e.get("role"), e.get("label"))
        out.append((e, 0 if n is None or key not in lengths else n - lengths[key]))
        if n is not None:
            lengths[key] = n
    return out


def _error_lines(value):
    return [line.strip() for line in value.splitlines()[-ERROR_TAIL:] if any(k in line for k in FAILURE_KEYWORDS)]


def _normal(line):
    return " ".join(DIGITS.sub("#", PATH.sub("/", HEX.sub("#", line))).split())


def _errors(events, now):
    """Normalized error line -> [(ts, line as written)] of the value events in ERROR_WINDOW that hold it."""
    seen = {}
    for e in events:
        if e["kind"] == "value" and e.get("value") and now - e["ts"] <= ERROR_WINDOW:
            for normal, line in {_normal(line): line for line in _error_lines(e["value"])}.items():
                seen.setdefault(normal, []).append((e["ts"], line))
    return seen


def _outcomes(inputs, scene, now):
    """[(ts, failed)] of the session failures and successes in ERROR_WINDOW, oldest first; a build_failed scene that
    no session failure explains is one failure now."""
    marks = sorted((e["ts"], e["kind"] in FAILURE_EVENTS) for e in inputs.get("events") or []
                   if (e["kind"] in FAILURE_EVENTS or e["kind"] == SUCCESS) and now - e["ts"] <= ERROR_WINDOW)
    if scene["activity"] == "build_failed" and not any(failed for _, failed in marks):
        marks.append((now, True))
    return marks


def _settled(marks, since):
    """No failure from since, or a success after the last one."""
    recent = [failed for ts, failed in marks if ts >= since]
    return not any(recent) or not recent[-1]


def _clues(events, inputs, focus, kind, typed, marks, repeats, now):
    clues = []
    if repeats:
        clues.append("repeat_error")
    run = 0
    for _, failed in marks:
        run = run + 1 if failed else 0
        if run >= FAIL_LOOP:
            clues.append("fail_loop")
            break
    shrink = sum(e.get("shrink") or 0 for e, _ in typed)
    if len(typed) >= BACKSPACE_EVENTS and shrink > 0 \
            and shrink >= BACKSPACE_SHARE * sum(max(gain, 0) for _, gain in typed):
        clues.append("backspace")
    if _search_error(events, inputs, focus, kind, now):
        clues.append("search_error")
    prompts = ["".join(e["value"].split()).casefold() for e in events
               if e["kind"] == "prompt" and e.get("value") and now - e["ts"] <= ERROR_WINDOW]
    if any(_jaccard(a, b) >= ASK_JACCARD for a, b in itertools.combinations(prompts, 2)):
        clues.append("ask_again")
    return clues


def _side(event, focus, kind):
    category = _kind(event, focus, kind)
    return "code" if category in CODE_KINDS else "browser" if category == "browsing" else None


def _search_error(events, inputs, focus, kind, now):
    recent = [e for e in events if now - e["ts"] <= SEARCH_WINDOW]
    sides = [side for side in (_side(e, focus, kind) for e in recent if e["kind"] == "app") if side]
    if sum(a != b for a, b in zip(sides, sides[1:])) < SEARCH_SWITCHES:
        return False
    texts = [e["window"] for e in recent if e.get("window") and _side(e, focus, kind) == "browser"]
    texts += [e["value"] for e in recent if e["kind"] == "selection" and e.get("value")
              and _side(e, focus, kind) == "browser"]
    texts += [p["title"] for p in inputs.get("recent_pages") or [] if p.get("title")]
    texts += [inputs["selection"]["text"]] if (inputs.get("selection") or {}).get("text") else []
    texts = [t.casefold() for t in texts]
    for line in {line for seen in _errors(events, now).values() for _, line in seen}:
        words = {w.casefold() for w in WORDS.findall(line)}
        if any(sum(w in text for w in words) >= SEARCH_WORDS for text in texts):
            return True
    return False


def _jaccard(a, b):
    a, b = {a[i:i + 2] for i in range(len(a) - 1)}, {b[i:i + 2] for i in range(len(b) - 1)}
    return len(a & b) / len(a | b) if a | b else 0.0


def _kind(event, focus, kind):
    """The category of the app an event came from; the front's own when it is the front app."""
    bundle = event.get("bundle_id")
    if focus is not None and bundle and bundle == focus.get("bundle_id"):
        return kind
    return _category({"bundle_id": bundle})


def _thread(events, focus, hidden):
    if hidden:
        return None
    doc = next((e["doc"] for e in reversed(events) if e["kind"] != "prompt" and e.get("doc")
                and e.get("bundle_id") == focus.get("bundle_id")), None)
    if doc is None or not os.path.isabs(doc):
        return None
    if doc not in _roots:
        path, _roots[doc] = os.path.dirname(doc), None
        for _ in range(THREAD_DEPTH):
            if os.path.exists(os.path.join(path, ".git")):
                _roots[doc] = os.path.basename(path) or None
                break
            if os.path.dirname(path) == path:
                break
            path = os.path.dirname(path)
    return _roots[doc]


def _on_mind(events, focus, kind, now):
    for e in reversed(events):
        if now - e["ts"] > ON_MIND_WINDOW:
            break
        source = _source(e, focus, kind)
        sentences = [s.strip() for s in SENTENCE.split(e.get("value") or "") if s.strip()]
        if source and sentences:
            return {"text": sentences[-1][:ON_MIND_MAX], "source": source, "ts": e["ts"]}
    return None


def _source(event, focus, kind):
    if event["kind"] == "prompt":
        return "prompt"
    if event["kind"] != "value":
        return None
    role, label = event.get("role"), (event.get("label") or "").casefold()
    if role in SEARCH_ROLES or any(word in label for word in SEARCH_LABELS):
        return "search"
    if role == "AXTextField" or role == "AXTextArea" and _kind(event, focus, kind) not in CODE_KINDS:
        return "field"
    return None


def needs_judgment(derived):
    """The rules told neither the state nor the mode, and the user is neither away nor in a meeting."""
    return derived["mode"] not in ("away", "meeting") and (derived["state"] == "unknown" or derived["mode"] == "other")


def apply_judgment(derived, judgment, now):
    """derived with the unknown state and the other mode the judgment names, when it is fresh and confident enough
    and derived needs one; evidence then ends with "character_agent". The judgment's on_mind is not used."""
    if judgment is None or not needs_judgment(derived) or now - judgment["ts"] > JUDGE_FRESH \
            or judgment["confidence"] < JUDGE_CONFIDENCE:
        return derived
    changed = {}
    if derived["state"] == "unknown" and judgment["state"] != "unknown":
        changed["state"] = judgment["state"]
    if derived["mode"] == "other" and judgment["mode"] in JUDGE_MODES:
        changed["mode"] = judgment["mode"]
    if not changed:
        return derived
    return {**derived, **changed, "evidence": derived["evidence"] + ["character_agent"]}


class UserState:
    """derive() results with hysteresis: a new mode or state takes effect once it has lasted HOLD seconds, entering
    or leaving away and meeting at once. log(ts, mode, state, evidence) gets each change that takes effect."""

    def __init__(self, log):
        self.log = log
        self._lock = threading.Lock()
        self._current = None  # the derivation in effect
        self._pending = None  # ((mode, state), since) of a different derivation not yet in effect
        self._present = None  # the last derivation in effect that was not away, with "ts" it was last seen
        self._before = None  # _present as it stood when away took effect

    def clear(self):
        """Forget every result: observations were deleted or consent revoked, and results may quote their text."""
        with self._lock:
            self._current = self._pending = self._present = self._before = None

    def update(self, derived, now, at_once=False):
        """The derivation in effect with derived's thread and on_mind, and "before_away". at_once: the user
        corrected the activity, so no hold."""
        key = (derived["mode"], derived["state"])
        with self._lock:
            current = self._current
            if current is not None and key == (current["mode"], current["state"]):
                self._pending, self._current = None, dict(derived)
            else:
                immediate = at_once or current is None or derived["mode"] in IMMEDIATE or current["mode"] in IMMEDIATE
                if not immediate and (self._pending is None or self._pending[0] != key):
                    self._pending = (key, now)
                if immediate or now - self._pending[1] >= HOLD:
                    if current is not None and current["mode"] != "away" and derived["mode"] == "away":
                        self._before = self._present
                    self._pending, self._current = None, dict(derived)
                    self.log(now, derived["mode"], derived["state"], derived["evidence"])
            if self._current["mode"] != "away":
                self._present = {**self._current, "ts": now}
            return {**self._current, "thread": derived["thread"], "on_mind": derived["on_mind"],
                    "before_away": self._before}
