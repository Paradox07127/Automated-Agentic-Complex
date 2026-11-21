"""Session registry: per-session state machines, TTL cleanup and focus arbitration."""
from collections import OrderedDict, deque
import threading
import time

STATES = ("awaiting_approval", "awaiting_input", "error", "running_tool", "thinking",
          "compacting", "subagent", "done", "background", "stale", "idle")
PRIORITY = {state: index for index, state in enumerate(STATES)}

# Seconds a state may stand without a newer event; None never expires.
DEFAULT_TTL = {"error": 30.0, "awaiting_approval": 120.0, "awaiting_input": 600.0,
               "running_tool": 180.0, "thinking": 600.0, "compacting": 600.0,
               "subagent": 1800.0, "done": 4.0, "background": 1800.0, "stale": None, "idle": None}
# Work states whose expiry means agentd lost sight of the session: they become stale, the rest idle.
LOST_WHEN_EXPIRED = {"awaiting_approval", "running_tool", "thinking", "compacting"}

# Values come from the old bridge's behavior.intent enum.
INTENTS = {"error": "apologize", "awaiting_approval": "offer", "awaiting_input": "listen",
           "running_tool": "explain", "thinking": "think", "compacting": "think",
           "subagent": "acknowledge", "done": "celebrate", "background": "think", "stale": "idle", "idle": "idle"}
EMOTIONS = {"error": (-0.5, 0.6, -0.2), "awaiting_approval": (0.0, 0.6, -0.1),
            "awaiting_input": (0.1, 0.4, 0.0), "running_tool": (0.2, 0.5, 0.1),
            "thinking": (0.1, 0.4, 0.0), "compacting": (0.0, 0.3, 0.0),
            "subagent": (0.2, 0.3, 0.1), "done": (0.6, 0.5, 0.2), "background": (0.1, 0.4, 0.0),
            "stale": (0.1, 0.1, 0.0), "idle": (0.1, 0.1, 0.0)}

TOOL_KINDS = {"tool_start", "tool_end", "tool_failure"}
# Sub-agent events that need the user's attention are raised on the parent session.
BUBBLE_KINDS = {"permission_request", "awaiting_input", "stop_failure"}
TURN_END_KINDS = {"stop", "stop_failure", "interrupt"}
# Size of the ended-turn and replay-digest memories.
HISTORY = 1024
DESKTOP_DONE_SECONDS = 30 * 60
APPS = {"claude": "Claude Code", "codex": "Codex"}  # the app an external session asks its own questions in


def own_app_wait(row):
    """The state word of a Session.to_dict row waiting on a permission answer in its own app, else None: no
    Agentic Complex card holds its hook (observe-only hooks, Codex), so it has no pending approval."""
    if row["effective_state"] != "awaiting_approval" or row["pending_approvals"]:
        return None
    return f"waiting for confirmation in {APPS.get(row['source'], row['source'])}"


class Session:
    def __init__(self, source, session_id, now):
        self.source = source
        self.session_id = session_id
        self.cwd = None
        self.state = "idle"
        self.since = now
        self.started_at = None  # when its current turn began
        self.completed_at = None
        self.failed_at = None
        self.expires_at = None
        self.tool_name = None
        self.tool_category = None
        self.tool_target = None
        # The most recent tool and its target; unlike tool_name they stay between tools.
        self.last_tool_name = None
        self.last_tool_target = None
        self.last_event = now
        self.subagents = {}
        self.outcomes = deque(maxlen=32)
        self.failures = 0
        self.approvals = set()
        self.pending_tool = None
        self.tool_window_until = 0.0
        self.coalesced = 0
        self.compact_return = None
        self.origin = None  # last origin a command hook sent
        self.title = None  # from its first prompt kept with typed_text; not in to_dict, so /state has no prompt text

    @property
    def display_id(self):
        return f"{self.source}:{self.session_id}"

    @property
    def effective_state(self):
        if self.state in ("idle", "done", "stale") and self.subagents:
            return "subagent"
        return self.state

    def to_dict(self):
        return {"display_session": self.display_id, "source": self.source,
                "session_id": self.session_id, "cwd": self.cwd, "state": self.state,
                "effective_state": self.effective_state, "started_at": self.started_at,
                "completed_at": self.completed_at,
                "failed_at": self.failed_at,
                "priority": PRIORITY[self.effective_state], "since": self.since,
                "expires_at": self.expires_at, "tool_name": self.tool_name,
                "tool_category": self.tool_category, "tool_target": self.tool_target,
                "last_tool_name": self.last_tool_name, "last_tool_target": self.last_tool_target,
                "subagents": [{"agent_id": aid, **child} for aid, child in self.subagents.items()],
                "pending_approvals": sorted(self.approvals), "coalesced": self.coalesced,
                "outcomes": list(self.outcomes), "origin": self.origin, "observed_at": self.last_event,
                "capabilities": self.capabilities}

    @property
    def capabilities(self):
        """An external session is only watched; navigate needs a terminal origin the host can jump to."""
        known = self.origin is not None and self.origin.get("kind") not in (None, "unknown")
        return ["observe", "navigate"] if known else ["observe"]


class Registry:
    def __init__(self, ttl=None, coalesce=0.3, failure_limit=3, session_ttl=1800.0,
                 subagent_ttl=1800.0, epoch=None, clock=time.time):
        self.ttl = {**DEFAULT_TTL, **(ttl or {})}
        self.coalesce = coalesce
        self.failure_limit = failure_limit
        self.session_ttl = session_ttl
        self.subagent_ttl = subagent_ttl
        self.epoch = int(time.time()) if epoch is None else epoch
        self.clock = clock
        self.cv = threading.Condition(threading.RLock())
        self.sessions = {}
        self.desktop_retired = {}  # finished or failed hook rows whose CLI has exited, until the receipt expires
        self.desktop_seen = {}  # display id -> completion or failure timestamp acknowledged by the user
        self.outcomes = deque(maxlen=256)
        self.intents = deque(maxlen=256)
        self.current_intent = None
        self.intent_seq = 0
        self.activity = self.mood = None  # behavior tick; None until it first picks
        self.role_focus = None  # Product-owned work; never masquerades as a coding session.
        self.quiet = False
        self.turn_generation = 0
        self._focus_key = None
        self._signature = None
        # Kept across session removal: replays and late events can outlive the session.
        self._ended_turns = OrderedDict()
        self._digests = OrderedDict()
        self._removed_sessions = OrderedDict()

    # Public API; every call runs TTL expiry and focus arbitration first.

    def superseded(self, event):
        """Under cv: a later hook has already updated this session."""
        session = self.sessions.get(event.key)
        return session is not None and event.ts < session.last_event

    def ingest(self, event):
        with self.cv:
            if self.superseded(event):
                return
            if event.key in self._removed_sessions:
                if event.kind != "prompt_submit":
                    return  # a retiring owned process cannot reappear as an external session
                self._removed_sessions.pop(event.key)
            self._tick(event.ts)
            self._apply(event)
            self._refocus(event.ts)

    def forget_session(self, source, session_id):
        """Remove a deleted owned session's hook alias until a new explicit session/turn begins."""
        with self.cv:
            key = (source, session_id)
            self.sessions.pop(key, None)
            self.desktop_retired.pop(key, None)
            self._remember(self._removed_sessions, key)
            self._refocus(self.clock())

    def tick(self, now=None):
        now = self.clock() if now is None else now
        with self.cv:
            self._tick(now)
            self._refocus(now)

    def set_title(self, key, title):
        """The session's title, unless it already has one."""
        with self.cv:
            session = self.sessions.get(key)
            if session is not None and session.title is None:
                session.title = title

    def titles(self):
        """display_session -> title of the sessions that have one."""
        with self.cv:
            return {s.display_id: s.title for s in self.sessions.values() if s.title is not None}

    def approval_resolved(self, key, request_id, decision, now=None):
        now = self.clock() if now is None else now
        with self.cv:
            self._tick(now)
            session = self.sessions.get(key)
            if session is not None:
                session.approvals.discard(request_id)
                if not session.approvals and session.state == "awaiting_approval":
                    # Without a decision the native dialog takes over; keep the state.
                    if decision == "allow":
                        self._set(session, "running_tool", now, session.tool_name, session.tool_category,
                                  session.tool_target)
                    elif decision in ("deny", "retired"):
                        self._set(session, "thinking", now)
                    elif decision == "abandoned":
                        # Claude drops the hook on a native deny and then waits for the user.
                        self._set(session, "awaiting_input", now)
            self._refocus(now)

    def is_replay(self, event):
        """True for a Stop seen before, or a PermissionRequest seen before in an ended turn."""
        if event.kind not in ("stop", "permission_request"):
            return False
        with self.cv:
            if event.digest in self._digests and (event.kind == "stop" or self._turn_ended(event)):
                self.outcomes.append({"display_session": f"{event.source}:{event.session_id}",
                                      "source": event.source, "session_id": event.session_id,
                                      "kind": "replay_dropped", "ts": event.ts})
                return True
            self._remember(self._digests, event.digest)
            return False

    def focus(self, now=None):
        self.tick(now)
        with self.cv:
            return self._focus_dict()

    def snapshot(self, now=None):
        self.tick(now)
        with self.cv:
            return {"epoch": self.epoch, "focus": self._focus_dict(),
                    "sessions": [s.to_dict() for s in self.sessions.values()],
                    "outcomes": list(self.outcomes)}

    def set_activity(self, activity, mood):
        """A new intent event with the current focus when the activity or mood changes."""
        with self.cv:
            if (activity, mood) != (self.activity, self.mood):
                self.activity, self.mood = activity, mood
                self._emit(self._focus_dict())

    def set_role_focus(self, focus, *, generation, quiet=False):
        """Replace the derived role view atomically; no prompt or tool body is accepted here."""
        with self.cv:
            self.role_focus = dict(focus) if focus else None
            self.turn_generation = generation
            self.quiet = bool(quiet)
            self._refocus(self.clock())

    def intents_since(self, seq):
        with self.cv:
            return [intent for intent in self.intents if intent["seq"] > seq]

    def publish_event(self, event, data):
        """A C1 /events item other than an intent (speech_cancelled, behavior); it takes the next intent seq,
        which it returns."""
        with self.cv:
            self.intent_seq += 1
            self.intents.append({"seq": self.intent_seq, "event": event, **data})
            self.cv.notify_all()
            return self.intent_seq

    def wait_for_intent(self, seq, timeout):
        with self.cv:
            if self.intent_seq <= seq:
                self.cv.wait(timeout)

    # State machine.

    def _apply(self, event):
        key, now = event.key, event.ts
        session = self.sessions.get(key)
        if event.kind == "session_end":
            if session is not None:
                if session.completed_at is not None:
                    self.desktop_retired[key] = {**session.to_dict(), 'effective_state': 'done', 'since': session.completed_at}
                elif session.failed_at is not None:
                    self.desktop_retired[key] = {**session.to_dict(), 'effective_state': 'error', 'since': session.failed_at}
                self._record(session, "ended", now)
                del self.sessions[key]
            return
        if session is None:
            self.desktop_retired.pop(key, None)
            session = self.sessions[key] = Session(event.source, event.session_id, now)
        session.last_event = now
        session.cwd = event.cwd or session.cwd
        session.origin = event.origin or session.origin
        if event.agent_id and event.kind not in BUBBLE_KINDS:
            return self._apply_subagent(session, event)
        if event.kind in ("tool_end", "tool_failure") and self._turn_ended(event):
            # A tool result after its turn ended, e.g. a background Bash.
            return
        if event.kind in TOOL_KINDS:
            return self._apply_tool_event(session, event)
        if event.kind == "notification" and session.state == "awaiting_approval":
            # Claude Code repeats it while its own permission dialog is open: still waiting, not lost.
            session.expires_at = now + self.ttl["awaiting_approval"]
        if event.kind in ("message", "notification", "other", "subagent_stop"):
            return
        session.pending_tool = None
        kind = event.kind
        if kind in TURN_END_KINDS and not event.agent_id and event.turn_id:
            self._remember(self._ended_turns, (event.source, event.session_id, event.turn_id))
        if kind == "prompt_submit":
            session.failures = 0
            session.started_at = now
            self._set(session, "thinking", now)
        elif kind == "permission_request":
            if event.request_id:
                session.approvals.add(event.request_id)
            self._set(session, "awaiting_approval", now, event.tool_name, event.tool_category, event.tool_target)
        elif kind == "awaiting_input":
            self._set(session, "awaiting_input", now, event.tool_name, event.tool_category, event.tool_target)
        elif kind == "stop":
            session.failures = 0
            self._set(session, "done", now)
            self._record(session, "done", now)
        elif kind == "stop_failure":
            self._set(session, "error", now)
            self._record(session, "error", now)
        elif kind == "interrupt":
            self._set(session, "idle", now)
            self._record(session, "interrupted", now)
        elif kind == "compact_start":
            if session.state != "compacting":
                session.compact_return = session.state
            self._set(session, "compacting", now)
        elif kind == "compact_end":
            back = session.compact_return
            self._set(session, "idle" if back in (None, "done", "compacting") else back, now)

    def _turn_ended(self, event):
        return bool(event.turn_id) and (event.source, event.session_id, event.turn_id) in self._ended_turns

    @staticmethod
    def _remember(memory, key):
        memory[key] = True
        memory.move_to_end(key)
        while len(memory) > HISTORY:
            memory.popitem(last=False)

    def _apply_subagent(self, session, event):
        now = event.ts
        if event.kind == "subagent_stop":
            if session.subagents.pop(event.agent_id, None) is not None:
                self._record(session, "subagent_done", now, event.agent_id)
            return
        child = session.subagents.setdefault(
            event.agent_id, {"state": "thinking", "tool_name": None, "since": now})
        child["last_event"] = now
        if event.kind == "tool_start":
            child.update(state="running_tool", tool_name=event.tool_name, since=now)
        elif event.kind in ("tool_end", "tool_failure"):
            child.update(state="thinking", tool_name=None, since=now)

    def _apply_tool_event(self, session, event):
        if event.kind == "tool_failure":
            self._record(session, "tool_failure", event.ts, tool_name=event.tool_name,
                         tool_category=event.tool_category)
            session.failures += 1
            if session.failures >= self.failure_limit:
                session.pending_tool = None
                self._set(session, "error", event.ts)
                self._record(session, "error", event.ts)
                return
        elif event.kind == "tool_end":
            session.failures = 0
        if event.ts < session.tool_window_until:
            session.pending_tool = event
            session.coalesced += 1
            return
        self._apply_tool(session, event, event.ts)

    def _apply_tool(self, session, event, now):
        session.pending_tool = None
        session.tool_window_until = now + self.coalesce
        if session.approvals or session.state == "error":
            return
        if event.kind == "tool_start":
            self._set(session, "running_tool", now, event.tool_name, event.tool_category, event.tool_target)
        else:
            self._set(session, "thinking", now)

    def _set(self, session, state, now, tool_name=None, tool_category=None, tool_target=None):
        if state == 'done':
            session.completed_at = now
        elif state != 'idle' or session.state != 'done':
            session.completed_at = None
        if state == 'error':
            session.failed_at = now
        elif state != 'idle' or session.state != 'error':
            session.failed_at = None
        session.state = state
        session.since = now
        ttl = self.ttl[state]
        session.expires_at = None if ttl is None else now + ttl
        session.tool_name = tool_name
        session.tool_category = tool_category
        session.tool_target = tool_target
        if tool_name:
            session.last_tool_name, session.last_tool_target = tool_name, tool_target

    def _record(self, session, kind, now, agent_id=None, tool_name=None, tool_category=None):
        entry = {"display_session": session.display_id, "source": session.source,
                 "session_id": session.session_id, "kind": kind, "ts": now}
        if agent_id:
            entry["agent_id"] = agent_id
        if tool_name:
            entry["tool_name"] = tool_name
        if tool_category:
            entry["tool_category"] = tool_category
        session.outcomes.append(entry)
        self.outcomes.append(entry)

    def _tick(self, now):
        for key, row in list(self.desktop_retired.items()):
            if now - row['since'] >= DESKTOP_DONE_SECONDS:
                del self.desktop_retired[key]
        for key, session in list(self.sessions.items()):
            if session.pending_tool is not None and now >= session.tool_window_until:
                self._apply_tool(session, session.pending_tool, now)
            if session.expires_at is not None and now >= session.expires_at:
                session.approvals.clear()
                self._set(session, "stale" if session.state in LOST_WHEN_EXPIRED else "idle", now)
            for agent_id, child in list(session.subagents.items()):
                if now - child["last_event"] >= self.subagent_ttl:
                    del session.subagents[agent_id]
            if (session.state in ("idle", "stale") and not session.subagents
                    and now - session.last_event >= self.session_ttl):
                self._record(session, "expired", now)
                del self.sessions[key]

    # Focus arbitration: the character shows one session; others keep their own state.

    def _refocus(self, now):
        if self.sessions:
            best = min(PRIORITY[s.effective_state] for s in self.sessions.values())
            tied = [k for k, s in self.sessions.items() if PRIORITY[s.effective_state] == best]
            if self._focus_key not in tied:
                self._focus_key = max(tied, key=lambda k: self.sessions[k].since)
        else:
            self._focus_key = None
        focus = self._focus_dict()
        signature = (focus["display_session"], focus["state"], focus["tool_category"],
                     focus["tool_name"], focus.get('run_generation'), focus.get('phase'),
                     focus.get('outcome'), self.turn_generation, self.quiet)
        if signature != self._signature:
            self._signature = signature
            self._emit(focus)

    def _focus_dict(self):
        external = self._external_focus_dict()
        role = self.role_focus
        if role and (role['expires_at'] is None or role['expires_at'] > self.clock()):
            waiting = ('awaiting_approval', 'awaiting_input')
            work = ('thinking', 'running_tool', 'compacting', 'subagent')
            if role['state'] in waiting or external['state'] in ('idle', 'stale') or \
                    role['state'] in work and external['state'] in work or \
                    PRIORITY[role['state']] <= PRIORITY[external['state']]:
                return dict(role)
        return external

    def _external_focus_dict(self):
        session = self.sessions.get(self._focus_key)
        if session is None:
            return {"display_session": None, "state": "idle", "priority": PRIORITY["idle"],
                    "tool_name": None, "tool_category": None, "expires_at": None}
        state = session.effective_state
        return {"display_session": session.display_id, "state": state,
                "priority": PRIORITY[state], "tool_name": session.tool_name,
                "tool_category": session.tool_category,
                "expires_at": session.expires_at if state == session.state else None}

    def _emit(self, focus):
        self.intent_seq += 1
        v, a, d = EMOTIONS[focus["state"]]
        expires = focus["expires_at"]
        self.intents.append({
            "epoch": self.epoch, "seq": self.intent_seq,
            "display_session": focus["display_session"], "state": focus["state"],
            "tool_category": focus["tool_category"], "intent": focus.get('intent_override') or INTENTS[focus["state"]],
            "emotion": {"v": v, "a": a, "d": d}, "line_id": None,
            "priority": focus["priority"],
            "expires_at_ms": None if expires is None else int(expires * 1000),
            "activity": self.activity, "mood": self.mood, "quiet": self.quiet,
            "turn_generation": self.turn_generation,
            **{key: focus[key] for key in ('run_id', 'conversation_id', 'run_generation', 'phase', 'outcome')
               if key in focus}})
        self.current_intent = self.intents[-1]
        self.cv.notify_all()
