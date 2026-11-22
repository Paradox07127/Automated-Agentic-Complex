"""ActivityContext:what the user is doing now, from attention, capture and session snapshots.

assemble() reads only a plain inputs dict (see snapshot()), so fixtures replay it unchanged. Three deterministic
associations tie the focus window to sessions: window or page identity, project path, same-task events. Titles,
page and window text are low-trust material: rules only match them, and facts describe the scene, never
the user's tastes. The judge is asked only when no rule names an activity and readable text exists."""
import hashlib
import json
import math
import re

from observation.attention import WEB_PULSE
from character.behavior import category
from observation.blacklist import HIDDEN
from observation.user_now import typing
from infra.paths import COMPANION_BUNDLE

ACTIVITIES = ("editing_code", "build_failed", "comparing_sources", "watching_video", "waiting_approval", "typing",
              "away", "unreadable", "reading", "meeting", "gaming", "switching", "unknown")
# Fixed confidence per kind of evidence that decided the activity.
CONFIDENCE = {
    "policy": 0.95,  # secure input or blacklist: the collector itself withholds the window
    "presence": 0.9,  # AFK comes straight from HID idle time
    "user": 0.9,  # user_now's meeting or sharing, and its typing
    "state": 0.9,  # a session's own awaiting_approval state
    "event": 0.85,  # a failed command of a session the focus window is tied to
    "player": 0.8,  # the focus app is a video player
    "assertion": 0.8,  # the front app holds a video playback power assertion
    "path": 0.8,  # the focus window names a session's project
    "game": 0.8,  # the focus app declares itself a game (LSApplicationCategoryType)
    "page": 0.75,  # browser heartbeats: an audible video host, back-and-forth page switches
    "gpu": 0.7,  # a fullscreen front window keeps the GPU busy
    "keyword": 0.6,  # a failure keyword in readable window text
    "interpreted": 0.6,  # the continuous interpreter's task for this window, grounded in quotes of its content
    "category": 0.5,  # only the focus app's category
    "switches": 0.5,  # front app switches the Companion counted
    "none": 0.0,
}
JUDGE_MAX = 0.6  # a judge's inference never outranks a deterministic association
JUDGE_ACTIVITIES = {"editing_code", "build_failed", "comparing_sources", "watching_video", "typing", "reading"}

# Bundles behavior.CATEGORIES lacks; checked first.
EXTRA_CATEGORIES = {"com.mitchellh.ghostty": "terminal"}
# Focus app category -> the activity it suggests on its own.
CATEGORY_ACTIVITY = {"coding": "editing_code", "browsing": "reading", "reading": "reading"}
READ_DWELL = 20.0  # seconds on a reading window before it counts as reading
# Categories where a failed build is looked at: the editor or a terminal.
FAILURE_FOCUS = {"coding", "terminal"}
# Event kind -> the tool category it must carry to count as a failed build (None: any).
FAILURE_EVENTS = {"tool_failure": "command", "stop_failure": None, "error": None}
EVENT_FRESH = 600.0  # seconds a failed command still explains what the user looks at
OBSERVATION_FRESH = 300.0  # seconds an observation stays the current scene; matches server.VIEW_FRESH
# Substrings of compiler, test-runner and shell output that mean a failure.
FAILURE_KEYWORDS = ("error:", "error[", "BUILD FAILED", "FAILED", "Traceback (most recent call last)", "npm ERR!",
                    "fatal:", "编译失败", "构建失败", "ビルドに失敗", "コンパイルエラー")
VIDEO_HOSTS = ("youtube.com", "bilibili.com", "vimeo.com", "twitch.tv", "netflix.com", "iqiyi.com", "youku.com")
VIDEO_BUNDLES = {"com.colliderli.iina", "org.videolan.vlc", "com.apple.QuickTimePlayerX", "com.apple.TV"}
COMPARE_WINDOW = 300.0  # seconds of page history that may show a comparison
COMPARE_SWITCHES = 2  # A -> B -> A at least
# Gaming without a declared category: front_gpu at least GPU_BUSY in GPU_MIN of the last GPU_BEATS beats, fullscreen.
GPU_BUSY = 0.2  # a saturating Metal loop reads about 0.4
GPU_MIN = 3
GPU_BEATS = 5
# Switching: at least SWITCHES front switches over SWITCH_APPS apps in SWITCH_WINDOW s, with under SWITCH_KEYS keys.
SWITCHES = 6
SWITCH_APPS = 3
SWITCH_KEYS = 20
SWITCH_WINDOW = 60.0
# $TERM_PROGRAM from the hook forwarder -> the terminal's bundle id, when the origin carries no bundle_id.
TERM_PROGRAMS = {"Apple_Terminal": "com.apple.Terminal", "iTerm.app": "com.googlecode.iterm2",
                 "WezTerm": "com.github.wez.wezterm", "ghostty": "com.mitchellh.ghostty",
                 "WarpTerminal": "dev.warp.Warp-Stable", "vscode": "com.microsoft.VSCode"}
# Session source -> hosts of the service it runs on; a page there belongs to the session.
SERVICE_HOSTS = {"claude": ("claude.ai", "console.anthropic.com"), "codex": ("chatgpt.com", "platform.openai.com")}
APPROVAL_SURFACES = {COMPANION_BUNDLE}  # where agentd's approval cards are shown
# cwd basenames too common to name a project in a window title.
GENERIC_DIRS = {"src", "app", "code", "work", "projects", "repos", "tmp", "home", "Desktop", "Documents",
                "Downloads"}
TITLE_TOKENS = re.compile(r"[\s/\\|·:\[\]()「」—–]+")
OBSERVATION_DEGRADED = {"declined", "unavailable", "failed"}
INTERPRETED_FRESH = 180.0  # seconds after its newest evidence an interpreter task still describes its window
# Interpreter task state -> the activity it names where no rule names one; other states leave unknown.
INTERPRETED_ACTIVITY = {"reading": "reading", "comparing": "reading", "investigating": "reading"}

# Activity -> may the character speak up unprompted.
CAN_INTERRUPT = {
    "editing_code": True, "build_failed": True, "comparing_sources": True, "watching_video": True,
    "waiting_approval": True, "reading": True,
    "typing": False,  # mid-sentence
    "away": False,  # nobody to hear it
    "unreadable": False,  # a password field or a hidden window
    "unknown": False,  # nothing known that would make it welcome
    "meeting": False,  # others are listening
    "gaming": False,  # hands and eyes are on the game
    "switching": False,  # she keeps still and says nothing about it
}
# Scene conditions that hold any activity's interruption; so does user_now's stage offstage or quiet.
INTERRUPT_HOLDS = ("fullscreen", "approval_elsewhere")
# Activity -> what ends this conclusion.
EXPIRES = {
    "editing_code": ["focus_change", "ttl:300"], "build_failed": ["focus_change", "session_state", "ttl:300"],
    "comparing_sources": ["page_revision", "ttl:120"], "watching_video": ["focus_change", "page_revision", "ttl:600"],
    "waiting_approval": ["session_state", "focus_change"], "typing": ["focus_change", "ttl:30"],
    "away": ["presence_change"], "unreadable": ["focus_change", "policy_epoch"],
    "reading": ["focus_change", "page_revision", "ttl:300"], "unknown": ["focus_change", "ttl:60"],
    "meeting": ["presence_change", "ttl:30"], "gaming": ["focus_change", "ttl:300"], "switching": ["ttl:30"],
}
# Evidence source -> what ends a conclusion that cites it.
SOURCE_EXPIRES = {"focus": "focus_change", "presence": "presence_change", "user": "presence_change", "page": "page_revision",
                  "selection": "page_revision", "session": "session_state", "event": "session_state",
                  "observation": "policy_epoch", "window_text": "policy_epoch",
                  "interpreted": f"ttl:{round(INTERPRETED_FRESH)}"}


def stable_id(kind, record):
    """`<kind>:` and the first 12 hex digits of SHA-256 over the record as sorted-key JSON."""
    raw = json.dumps(record, sort_keys=True, ensure_ascii=False, default=str)
    return f"{kind}:{hashlib.sha256(raw.encode()).hexdigest()[:12]}"


def snapshot(attention, registry, capture, own, user=None, fullscreen=False):
    """Plain inputs for assemble() from the live stores; ids that the stores lack come from stable_id().
    user: user_now's snapshot, whose meeting, typing and stage the scene takes; fullscreen: the flag the gate keeps."""
    now = attention.clock()
    focus, dwell_s = None, None
    run = attention.dwell()
    if run is not None:
        start, dwell_s, data = run
        focus = {**data, "id": stable_id("focus", {"start": start, "data": data}), "since": start,
                 "secure_input": attention.secure_input(), "fullscreen": fullscreen}
        declared = attention.app_category(data)
        if declared is not None:
            focus["category"] = declared
    presence = None
    status = attention.presence()
    if status is not None:
        last = attention.events("afk")[-1]
        sensed = attention.inputs()
        counts = [e["input"] for e in sensed if "input" in e]
        apps = None
        if counts and counts[-1].get("switches_60s", 0) >= SWITCHES:  # the window history only when it can decide
            apps = len({e["data"].get("bundle_id") or e["data"].get("app") for e in attention.events("window")
                        if e["start"] + e["duration"] >= now - SWITCH_WINDOW})
        presence = {"id": stable_id("presence", last), "status": status[0], "seconds": status[1],
                    "idle_s": attention.idle_s(), "inputs": sensed, "apps_60s": apps}
    spans = [{"id": stable_id("page", {"start": e["start"], "data": e["data"]}), "url_host": e["data"].get("url_host"),
              "title": e["data"].get("title"), "audible": bool(e["data"].get("audible")), "start": e["start"],
              "duration": e["duration"]}
             for e in attention.events("browser") if e["start"] + e["duration"] >= now - COMPARE_WINDOW
             and e["data"].get("window_focused", True) and e["data"].get("visible", True)]
    page = None
    latest_browser = attention.events("browser")[-1:]
    foreground = latest_browser and latest_browser[0]["data"].get("window_focused", True) and latest_browser[0]["data"].get("visible", True)
    if spans and foreground and now - (spans[-1]["start"] + spans[-1]["duration"]) <= WEB_PULSE:
        current = attention.current_page()
        page = {k: spans[-1][k] for k in ("id", "url_host", "title", "audible")}
        page["text"] = current["text"] if current else None
    selection = attention.latest_selection()
    if selection is not None:
        selection = {"id": stable_id("selection", {k: selection[k] for k in ("ts", "url_host", "title")}),
                     **selection}
    window_text, observations = None, []
    if capture is not None:
        window_text = capture.window_text()
        if window_text is not None:
            window_text = {"id": stable_id("window_text", window_text), **window_text}
        observations = capture.observations_snapshot()
    state = registry.snapshot(now)
    events = [{"id": stable_id("event", o), "session": o["display_session"], "kind": o["kind"],
               "tool": o.get("tool_name"), "tool_category": o.get("tool_category"), "ts": o["ts"]} for o in state["outcomes"]]
    own_sessions = [] if own is None else [
        {k: d[k] for k in ("session_id", "target", "cwd", "state", "title")}
        for d in (s.to_dict() for s in list(own.sessions.values()))]
    if user is not None:
        user = {"id": f"user:{user['revision']}",
                **{k: user[k] for k in ("doing", "typing", "input_active", "stage")}}
    return {"now": now, "focus": focus, "dwell_s": dwell_s, "presence": presence, "user": user, "page": page,
            "recent_pages": spans, "selection": selection, "window_text": window_text,
            "observations": [o for o in observations if o is not None], "sessions": state["sessions"],
            "own_sessions": own_sessions, "events": events}


def interpreted(understanding, get, now):
    """The inputs' "interpreted": the tasks of ObservationService.understanding() observed at most
    INTERPRETED_FRESH seconds ago, each with the windows its evidence came from; get(observation_id) -> its row or
    None (revoked or expired evidence names no window)."""
    tasks = []
    for task in understanding.get("tasks") or []:
        at = task.get("last_observed_at")
        if at is None or now - at > INTERPRETED_FRESH:
            continue
        rows = [row for e in task.get("evidence") or [] if (row := get(e.get("observation_id"))) is not None]
        tasks.append({"task_key": task["task_key"], "title": task["title"], "summary": task["current_step"],
                      "state": task["state"], "observed_at": at,
                      "windows": [{k: row["metadata"].get(k) for k in ("window_id", "bundle_id")} for row in rows]})
    return tasks


def _category(window):
    return EXTRA_CATEGORIES.get(window.get("bundle_id")) or category(window)


def _host_in(host, hosts):
    return bool(host) and any(host == h or host.endswith("." + h) for h in hosts)


def _project(cwd):
    base = (cwd or "").rstrip("/").rsplit("/", 1)[-1]
    return None if not base or base in GENERIC_DIRS else base


def _label(host, title):
    return f"{host}「{title}」" if title else host


class _Scene:
    """One assemble() pass: the inputs read once, facts with their evidence, and the hold flags."""

    def __init__(self, inputs):
        self.inputs = inputs
        self.now = inputs["now"]
        self.focus = inputs.get("focus")
        self.hidden = self.focus is not None and self.focus.get("app") == HIDDEN["app"]
        self.secure = self.focus is not None and bool(self.focus.get("secure_input"))
        self.kind = None if self.focus is None or self.hidden else _category(self.focus)
        self.dwell = inputs.get("dwell_s") or 0.0
        self.presence = inputs.get("presence")
        self.user = inputs.get("user")  # user_now's, or None
        self.sensed = (self.presence or {}).get("inputs") or []  # ring entries, oldest first
        self.counts = [e["input"] for e in self.sensed if "input" in e]
        self.page = inputs.get("page")
        self.pages = inputs.get("recent_pages") or []
        self.events = inputs.get("events") or []
        self.sessions = [{"id": s["display_session"], "source": s["source"], "cwd": s.get("cwd"),
                          "state": s.get("effective_state") or s.get("state"), "tool": s.get("tool_name"),
                          "origin": s.get("origin") or {}} for s in inputs.get("sessions") or []]
        self.sessions += [{"id": s["session_id"], "source": s.get("target"), "cwd": s.get("cwd"),
                           "state": s.get("state"), "tool": None, "origin": {}} for s in inputs.get("own_sessions") or []]
        window_id = None if self.focus is None else self.focus.get("window_id")
        mine = [o for o in inputs.get("observations") or [] if window_id is not None and o.get("window_id") == window_id
                and self.now - (o.get("observed_at") or o.get("requested_at") or 0.0) <= OBSERVATION_FRESH]
        self.observation = max(mine, key=lambda o: o.get("requested_at") or 0.0, default=None)
        self.facts, self.used, self.related, self.identity = [], {}, {}, set()
        self.flags = dict.fromkeys(INTERRUPT_HOLDS, False)
        self._texts = None

    def fact(self, text, *evidence):
        """evidence: (source, id) pairs; the source decides what expires the conclusion."""
        for source, _ in evidence:
            self.used[source] = True
        if all(f["text"] != text for f in self.facts):
            self.facts.append({"text": text, "evidence_ids": [i for _, i in evidence]})

    def readable(self):
        """[(source, id, text)] of content the rules may match; nothing while the window is withheld."""
        if self._texts is None:
            self._texts = []
            if self.focus is not None and not self.secure and not self.hidden:
                window = self.inputs.get("window_text")
                if window and window.get("text"):
                    self._texts.append(("window_text", window["id"], window["text"]))
                if self.observation and self.observation["status"] == "ready" and self.observation.get("text"):
                    self._texts.append(("observation", self.observation["request_id"], self.observation["text"]))
                if self.kind == "browsing":
                    for source, record in (("page", self.page), ("selection", self.inputs.get("selection"))):
                        if record and record.get("text") and record.get("url_host") != HIDDEN["app"]:
                            self._texts.append((source, record["id"], record["text"]))
        return self._texts

    def relate(self, session, text, *evidence):
        self.related.setdefault(session["id"], True)
        self.fact(text, *evidence, ("session", session["id"]))

    def degraded_reasons(self):
        reasons = []
        if self.secure:
            reasons.append("secure_input")
        if self.hidden or self.kind == "browsing" and self.page and self.page.get("url_host") == HIDDEN["app"]:
            reasons.append("blacklisted")
        if self.observation and self.observation["status"] in OBSERVATION_DEGRADED:
            reasons.append(f"observation_{self.observation['status']}")
        return reasons


def _base_facts(scene):
    focus, presence = scene.focus, scene.presence
    if focus is not None:
        evidence = ("focus", focus["id"])
        if scene.hidden:
            scene.fact("The foreground window is blacklisted; what it shows cannot be seen", evidence)
        elif scene.secure:
            scene.fact(f"The foreground window {focus.get('app')} is in secure input (a password field, for example)",
                       evidence)
        else:
            title = f" \"{focus['title']}\"" if focus.get("title") else ""
            scene.fact(f"The foreground window is {focus.get('app')}{title}, in front for {round(scene.dwell)} s", evidence)
    if presence is not None:
        evidence = ("presence", presence["id"])
        if presence["status"] == "afk":
            scene.fact(f"Keyboard and mouse idle for {round(presence['seconds'] / 60)} min; the user has left", evidence)
        else:
            idle = "" if presence.get("idle_s") is None else \
                f", {round(presence['idle_s'], 1)} s since the last keyboard or mouse input"
            scene.fact(f"The user is at the computer{idle}", evidence)
    if focus is not None and not scene.hidden:
        scene.flags["fullscreen"] = bool(focus.get("fullscreen"))
    if scene.observation and scene.observation["status"] in OBSERVATION_DEGRADED:
        o = scene.observation
        scene.fact(f"The request to see this window ended {o['status']} ({o.get('reason') or 'no reason'})",
                   ("observation", o["request_id"]))


def _relate(scene):
    """The three deterministic associations between the focus window and sessions."""
    focus = scene.focus
    if focus is None or scene.hidden:
        return
    evidence = ("focus", focus["id"])
    title = focus.get("title") or ""
    tokens = {t.casefold() for t in TITLE_TOKENS.split(title) if t}
    # 1. Window or page identity.
    terminals = [s for s in scene.sessions
                 if (s["origin"].get("bundle_id") or TERM_PROGRAMS.get(s["origin"].get("term_program")))
                 == focus.get("bundle_id")]
    if len(terminals) > 1:  # several sessions in this terminal app: only the one the title names
        terminals = [s for s in terminals if (_project(s["cwd"]) or "").casefold() in tokens]
    for s in terminals:
        scene.identity.add(s["id"])
        scene.relate(s, f"The foreground window is the terminal session {s['id']} runs in", evidence)
    page = scene.page
    if scene.kind == "browsing" and page is not None:
        for s in scene.sessions:
            if _host_in(page.get("url_host"), SERVICE_HOSTS.get(s["source"], ())):
                scene.identity.add(s["id"])
                scene.relate(s, f"The browser page {page['url_host']} is the service session {s['id']} uses",
                             ("page", page["id"]))
    # 2. Project path: the title names the cwd's last part or holds the whole path; window text only the path.
    for s in scene.sessions:
        project = _project(s["cwd"])
        if project and project.casefold() in tokens or s["cwd"] and s["cwd"] in title:
            scene.relate(s, f"\"{project or s['cwd']}\" in the window title matches the working directory of session "
                         f"{s['id']}", evidence)
            continue
        for source, text_id, text in scene.readable():
            if s["cwd"] and s["cwd"] in text:
                scene.relate(s, f"The window text shows the working directory of session {s['id']}", (source, text_id))
                break
    # 3. Same task: a session's command failed, then the focus moved to an editor or a terminal.
    if scene.kind in FAILURE_FOCUS:
        by_id = {s["id"]: s for s in scene.sessions}
        for e in _failures(scene):
            if e["session"] in by_id and e["ts"] <= focus.get("since", scene.now):
                scene.relate(by_id[e["session"]], f"After {e.get('tool') or e['kind']} of session {e['session']} "
                             f"failed, the focus moved to this window", ("event", e["id"]))


def _failures(scene):
    return [e for e in scene.events if e["kind"] in FAILURE_EVENTS and scene.now - e["ts"] <= EVENT_FRESH
            and FAILURE_EVENTS[e["kind"]] in (None, e.get("tool_category"))]


def _project_of(scene, ids):
    by_id = {s["id"]: s for s in scene.sessions}
    return next((_project(by_id[i]["cwd"]) for i in ids if i in by_id and _project(by_id[i]["cwd"])), None)


def _interpreted(scene):
    """The freshest interpreted task whose evidence came from the focus window (by window id, else by bundle), or
    None; nothing while the window is withheld."""
    focus = scene.focus
    if focus is None or scene.hidden or scene.secure:
        return None

    def here(window):
        if window.get("window_id") is not None:
            return window["window_id"] == focus.get("window_id")
        return window.get("bundle_id") is not None and window["bundle_id"] == focus.get("bundle_id")

    mine = [t for t in scene.inputs.get("interpreted") or []
            if scene.now - t["observed_at"] <= INTERPRETED_FRESH and any(here(w) for w in t["windows"])]
    return max(mine, key=lambda t: t["observed_at"], default=None)


# Detectors: each returns None or {"confidence": a CONFIDENCE key, "subject": str | None}.

def _unreadable(scene):
    if scene.secure or scene.hidden:
        return {"confidence": "policy", "subject": None}
    return None


def _meeting(scene):
    user = scene.user
    if user is None or user["doing"] not in ("meeting", "sharing"):
        return None
    scene.fact("The screen is being shared or recorded" if user["doing"] == "sharing" else
               "The user is in a meeting or a call", ("user", user["id"]))
    return {"confidence": "user", "subject": None}


def _gaming(scene):
    if scene.kind == "game":
        scene.fact(f"{scene.focus.get('app')} is a game", ("focus", scene.focus["id"]))
        return {"confidence": "game", "subject": scene.focus.get("app")}
    if scene.focus is None:
        return None
    run = [e for e in scene.sensed[-GPU_BEATS:] if e["ts"] >= scene.focus["since"]]
    busy = [e for e in run if (e.get("front_gpu") or 0) >= GPU_BUSY]
    if not scene.flags["fullscreen"] or len(busy) < GPU_MIN:
        return None
    scene.fact("The foreground window is fullscreen and the GPU stays busy", ("focus", scene.focus["id"]),
               ("presence", scene.presence["id"]))
    return {"confidence": "gpu", "subject": scene.focus.get("app")}


def _watching_video(scene):
    focus, page = scene.focus, scene.page
    if focus is not None and focus.get("bundle_id") in VIDEO_BUNDLES:
        scene.fact(f"{focus.get('app')} is a video player", ("focus", focus["id"]))
        return {"confidence": "player", "subject": focus.get("title") or focus.get("app")}
    if scene.sensed and scene.sensed[-1].get("front_video") is True:
        scene.fact("The foreground app is playing video", ("presence", scene.presence["id"]))
        return {"confidence": "assertion", "subject": None if focus is None else focus.get("title") or focus.get("app")}
    if page and page.get("audible") and _host_in(page.get("url_host"), VIDEO_HOSTS) \
            and (focus is None or scene.kind == "browsing"):
        scene.fact(f"The browser page {_label(page['url_host'], page.get('title'))} is playing sound", ("page", page["id"]))
        return {"confidence": "page", "subject": _label(page["url_host"], page.get("title"))}
    return None


def _away(scene):
    if scene.presence is not None and scene.presence["status"] == "afk":
        return {"confidence": "presence", "subject": None}
    return None


def _waiting_approval(scene):
    waiting = [s for s in scene.sessions if s["state"] == "awaiting_approval"]
    for s in waiting:
        asked = [("event", e["id"]) for e in scene.events
                 if e["session"] == s["id"] and e["kind"] == "permission_request"]
        scene.relate(s, f"Session {s['id']} is waiting for approval ({s['tool'] or 'a tool'})", *asked)
    if not waiting:
        return None
    on_card = scene.focus is not None and (scene.focus.get("bundle_id") in APPROVAL_SURFACES
                                           or any(s["id"] in scene.identity for s in waiting))
    scene.flags["approval_elsewhere"] = not on_card
    return {"confidence": "state", "subject": f"{waiting[0]['id']} awaiting approval"}


def _build_failed(scene):
    for e in _failures(scene):
        if e["session"] in scene.related:
            scene.fact(f"{e.get('tool') or e['kind']} of session {e['session']} failed {round(scene.now - e['ts'])} s ago",
                       ("event", e["id"]), ("session", e["session"]))
            return {"confidence": "event", "subject": _project_of(scene, [e["session"]])}
    if scene.kind in FAILURE_FOCUS:
        for source, text_id, text in scene.readable():
            keyword = next((k for k in FAILURE_KEYWORDS if k in text), None)
            if keyword:
                scene.fact(f"The window text shows a failure sign \"{keyword}\"", (source, text_id))
                return {"confidence": "keyword", "subject": scene.focus.get("title") or scene.focus.get("app")}
    return None


def _comparing_sources(scene):
    if scene.kind != "browsing":
        return None
    recent = [p for p in scene.pages if p["start"] + p["duration"] >= scene.now - COMPARE_WINDOW
              and p.get("url_host") != HIDDEN["app"]]
    runs = []
    for p in recent:
        key = (p.get("url_host"), p.get("title"))
        if not runs or runs[-1][0] != key:
            runs.append((key, p["id"]))
    labels = list(dict.fromkeys(_label(*key) for key, _ in runs))
    if len(labels) < 2 or len(runs) - 1 < COMPARE_SWITCHES:
        return None
    scene.fact(f"In the last {round(COMPARE_WINDOW)} s the user switched {len(runs) - 1} times between "
               f"{' and '.join(labels[:3])}",
               *(("page", p["id"]) for p in recent))
    return {"confidence": "page", "subject": " ↔ ".join(labels[:2])}


def _editing_code(scene):
    if CATEGORY_ACTIVITY.get(scene.kind) != "editing_code":
        return None
    project = _project_of(scene, sorted(scene.related))
    return {"confidence": "path" if project else "category",
            "subject": project or scene.focus.get("title") or scene.focus.get("app")}


def _typing(scene):
    user = scene.user
    if user is None or not typing(user):
        return None
    scene.fact(f"{'Keyboard and mouse' if user['typing'] is None else 'Keyboard'} input keeps going", ("user", user["id"]))
    return {"confidence": "user", "subject": None if scene.focus is None else scene.focus.get("app")}


def _switching(scene):
    last = scene.counts[-1] if scene.counts else {}
    if last.get("switches_60s", 0) < SWITCHES or last.get("keys_60s", 0) >= SWITCH_KEYS \
            or (scene.presence.get("apps_60s") or 0) < SWITCH_APPS:
        return None
    scene.fact("In the last minute the foreground switched back and forth between several apps",
               ("presence", scene.presence["id"]))
    return {"confidence": "switches", "subject": None}


def _reading(scene):
    if CATEGORY_ACTIVITY.get(scene.kind) != "reading" or scene.dwell < READ_DWELL:
        return None
    page = scene.page
    if scene.kind == "browsing" and page and page.get("url_host") and page["url_host"] != HIDDEN["app"]:
        scene.fact(f"The browser's current page is {_label(page['url_host'], page.get('title'))}", ("page", page["id"]))
        return {"confidence": "category", "subject": _label(page["url_host"], page.get("title"))}
    return {"confidence": "category", "subject": scene.focus.get("title") or scene.focus.get("app")}


# First match wins: withheld windows before anything is read, a meeting or a game before what the screen shows,
# sound before AFK (a video plays without input), a session's request before the user's own work, typing and
# switching before the editor they happen in.
RULES = (("unreadable", _unreadable), ("meeting", _meeting), ("gaming", _gaming),
         ("watching_video", _watching_video), ("away", _away), ("waiting_approval", _waiting_approval),
         ("build_failed", _build_failed), ("comparing_sources", _comparing_sources), ("typing", _typing),
         ("switching", _switching), ("editing_code", _editing_code), ("reading", _reading))


def assemble(inputs, judge=None, correction=None):
    """judge: optional callable(inputs, candidate) -> {"inference", "confidence"[, "activity"]}.
    correction: the user's {"activity", "until", "focus_id"}; while it holds (same focus or a null focus_id, and
    before until) it is the activity and neither the rules nor the judge run."""
    scene = _Scene(inputs)
    _base_facts(scene)
    _relate(scene)
    focus_id = None if scene.focus is None else scene.focus["id"]
    corrected = correction is not None and correction["focus_id"] in (None, focus_id) \
        and scene.now < correction["until"]
    activity, found = correction["activity"] if corrected else "unknown", None
    for name, detect in () if corrected else RULES:
        found = detect(scene)
        if found is not None:
            activity = name
            break
    task = None if corrected or found is not None else _interpreted(scene)
    if task is not None:
        scene.fact(f"Continuous observation sees this in the window: {task['title']} ({task['summary']})",
                   ("interpreted", task["task_key"]))
        if task["state"] in INTERPRETED_ACTIVITY:
            activity = INTERPRETED_ACTIVITY[task["state"]]
            found = {"confidence": "interpreted", "subject": task["title"]}
    confidence = 1.0 if corrected else CONFIDENCE[found["confidence"] if found else "none"]
    subject = found["subject"] if found else None
    reasons = scene.degraded_reasons()
    result = {"activity": activity, "subject": subject, "facts": scene.facts, "inference": None,
              "confidence": confidence, "related_session_ids": sorted(scene.related), "focus_id": focus_id,
              "corrected": corrected, "interpreted": task and {k: task[k] for k in
                                                              ("task_key", "title", "summary", "state", "observed_at")}}
    if not corrected and found is None and judge is not None and scene.readable():
        for source, _, _ in scene.readable():
            scene.used[source] = True
        answer = judge(inputs, dict(result))
        result["inference"] = answer.get("inference")
        result["confidence"] = min(max(float(answer.get("confidence") or 0.0), 0.0), JUDGE_MAX)
        if answer.get("activity") in JUDGE_ACTIVITIES:
            result["activity"] = activity = answer["activity"]
    result["can_interrupt"] = CAN_INTERRUPT[activity] and not any(scene.flags[h] for h in INTERRUPT_HOLDS) \
        and (scene.user is None or scene.user["stage"] not in ("offstage", "quiet"))
    result["holds"] = [h for h in INTERRUPT_HOLDS if scene.flags[h]]
    ends = ["focus_change", f"ttl:{math.ceil(correction['until'] - scene.now)}"] if corrected \
        else [SOURCE_EXPIRES[s] for s in scene.used]
    result["expires_with"] = list(dict.fromkeys(EXPIRES[activity] + ends))
    result["status"] = "degraded" if reasons else "unknown" if activity == "unknown" else "ok"
    if reasons:
        result["degraded_reasons"] = reasons
    return result
