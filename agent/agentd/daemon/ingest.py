"""Heartbeats, agent events and Idempotency-Key receipts."""
import itertools
import json
import threading

from character.thoughts import transition
from infra import plugins
from daemon.constants import RECEIPTS_KEPT, RAW_TEXT, RAW_PAST

PROMPT_MAX = 500  # characters of a hook prompt kept in events_raw
AGENT_TEXT_MAX = 200  # characters of a tool summary or an agent's last message kept in an "agent" row
FOCUS_ENDS = {"done": "session_done", "error": "session_error"}  # focus session state -> her state's event


class IngestMixin:
    def ingest(self, event, retire=None):
        """registry.ingest of a hook event; the focus session turning done or error is an event of her state and her react;
        a session turning done or error without becoming the focus intent is a session_reaction on /events;
        any session the registry records done fires the reminders waiting for it; a session starting a turn, ending one
        or waiting on the user is a trigger of her thoughts."""
        registry = self.registry
        with registry.cv:  # the intents after seq are this event's: the focus it moved to, if it moved
            if registry.superseded(event):
                return
            if retire is not None:
                for request_id in retire(event):
                    registry.approval_resolved(event.key, request_id, "retired")
            seq = registry.intent_seq
            last = registry.outcomes[-1] if registry.outcomes else None
            before = registry.sessions.get(event.key)
            was = before and before.state
            registry.ingest(event)
            after = registry.sessions.get(event.key)
            turned = after and transition(was, after.state)
            row = after.to_dict() if after else None
            done = [o for o in itertools.takewhile(lambda o: o is not last, reversed(registry.outcomes))
                    if o["kind"] == "done"]
            if event.kind in ("stop", "stop_failure") and not event.agent_id:
                self.focus.count("sessions")
            ended = [FOCUS_ENDS[i["state"]] for i in registry.intents_since(seq)
                     if "event" not in i and i["state"] in FOCUS_ENDS]
            if after and after.state in FOCUS_ENDS and after.state != was and not any(
                    "event" not in i and (i["display_session"], i["state"]) == (after.display_id, after.state)
                    for i in registry.intents_since(seq)):
                occurrence = registry.occurrence_of(after)
                # withheld first: a stage that blocks it consumes it even when quiet already keeps it unsent
                if not registry.withheld(occurrence) and not registry.quiet:
                    registry.publish_event("session_reaction", {
                        "display_session": after.display_id, "state": after.state,
                        "turn_generation": registry.turn_generation, "occurrence_id": occurrence})
        if self.commitments is not None:
            for outcome in done:
                self.commitments.fire("session_done", {"agent": outcome["source"], "session_id": outcome["session_id"]})
        if self.state is not None:
            for kind in ended:
                self.state.on_event(kind)
        if self.behavior is not None:
            for kind in ended:
                self.behavior.event(kind)
        signals = getattr(self, "signals", None)
        # The coding-session consent, pause and blacklist hold both a signal and a thought naming the session.
        allowed = self._signals_allowed(event.to_dict())
        handled = signals is not None and allowed and signals.on_transition(was, row, event)
        if turned and allowed and not handled and self.thoughts is not None:
            self.thoughts.notice(turned, {"session_id": after.display_id, "state": after.state})

    def _signals_allowed(self, row):
        """row: an event or registry session dict; a "title" in it is judged as the window title."""
        if self.observation_paused() or self.resetting or not self.consent.snapshot()[0]["agent_sessions"]:
            return False
        attention = self.attention
        if attention is None:
            return False
        with attention.lock:
            return not attention._secure and not attention._raw_hidden(_session_window(row))

    def record_agent_event(self, event, body):
        """A hook event into events_raw under its session's title:a prompt the user sent as "prompt", its text
        only with typed_text; a prompt something else sent, a finished tool, a stop and a wait for the user as
        "agent". Without coding-session sharing nothing is read or stored; other kinds, and anything while paused,
        store nothing."""
        attention = self.attention
        generation = attention and attention.typed_generation  # before consent, so a revocation in between drops the text
        agent_generation = attention and attention.agent_generation  # and drops the row
        with self.consent.lock:
            permissions = self.consent.snapshot()[0]
        if not (plugins.on("coding_sessions") and permissions["agent_sessions"]):
            return
        meta = {"title": None} if self.agent_meta is None else \
            self.agent_meta.session(event.source, event.session_id, body.get("transcript_path"), body.get("session_title"))
        session = {**event.to_dict(), "title": meta["title"]}
        signals = getattr(self, "signals", None)
        if signals is not None and self._signals_allowed(session):
            signals.on_hook(event, body)
        if attention is None or self.observation_paused() \
                or event.kind not in ("prompt_submit", "tool_end", "stop", "subagent_stop", "awaiting_input"):
            return
        prompt = body.get("prompt")
        if event.kind == "prompt_submit" and not (isinstance(prompt, str) and prompt):
            return
        row = {"ts": event.ts, **_session_window(session)}
        agent = lambda role, subrole=None, value=None: {**row, "kind": "agent", "role": role,  # noqa: E731
                                                        "subrole": subrole and subrole[:RAW_TEXT["subrole"]],
                                                        "value": value}
        observations=getattr(self.character_agent,'observations',None)
        if event.kind == "prompt_submit":
            # Markup is what Claude Code injects (task notifications, command output).
            origin = "subagent" if event.source == "codex" and isinstance(body.get("agent_id"), str) and body["agent_id"] \
                else "system" if prompt.lstrip().startswith("<") else "unknown"
            attention.ingest_events(
                [{**row, "kind": "prompt", "role": origin, "value": prompt[:PROMPT_MAX] if permissions["typed_text"] else None,
                  "value_len": len(prompt)} if origin == "unknown" else agent("notification", origin)],
                typed_generation=generation, agent_generation=agent_generation)
            if observations: observations.ingest_hook(event,body,origin=origin,typed_generation=generation)
            return
        message = body.get("last_assistant_message")
        message = message[:AGENT_TEXT_MAX] if isinstance(message, str) and message else None
        if event.kind == "tool_end":
            rows = [agent("tool", event.tool_name, (event.tool_summary or "")[:AGENT_TEXT_MAX] or None)]
        elif event.kind == "awaiting_input":
            rows = [agent("waiting")]
        else:
            rows = [agent("stop" if event.kind == "stop" else "subagent", value=message)]
        attention.ingest_events(rows, typed_generation=generation, agent_generation=agent_generation)
        if observations: observations.ingest_hook(event,body,typed_generation=generation)

    def _spans(self, spans, until):
        """spans with the open one ended now, [now, until] added unless until is None, and those older than RAW_PAST gone."""
        now = self.clock()
        if spans and spans[-1][1] > now:
            spans[-1][1] = now
        return [span for span in spans if span[1] >= now - RAW_PAST] + ([] if until is None else [[now, until]])

    def load_receipts(self, db, lock=None):
        """At start: the newest finished receipts kept in db answer repeats of their keys; new ones are kept there.
        A request still running when agentd stopped has none, so its repeat runs again."""
        if lock is not None:
            self._receipts_lock = lock
        with self._receipts_lock:
            with db:
                # Rows written before requests were kept as digests hold the request text.
                db.execute("DELETE FROM idempotency_receipts WHERE NOT (length(request) = 64 AND request NOT GLOB '*[^0-9a-f]*')"
                           " AND NOT (key GLOB 'character-reminder:*' AND length(request) = 71 AND request GLOB 'sha256:*'"
                           " AND substr(request, 8) NOT GLOB '*[^0-9a-f]*')")
            rows = db.execute("SELECT key, request, answer FROM (SELECT rowid AS n, * FROM idempotency_receipts"
                              " WHERE length(request) = 64 ORDER BY n DESC LIMIT ?) ORDER BY n", (RECEIPTS_KEPT,)).fetchall()
            self.receipts_db = db
            for key, request, answer in rows:
                done = threading.Event()
                done.set()
                self._receipts[key] = {"request": request, "done": done, "answer": tuple(json.loads(answer))}


def _session_window(row):
    """An event or registry session dict as the events_raw window the blacklist judges."""
    title = row.get("title")
    return {"app": row["source"], "bundle_id": (row.get("origin") or {}).get("bundle_id"),
            "window": title and title[:RAW_TEXT["window"]], "doc": row.get("cwd") and row["cwd"][:RAW_TEXT["doc"]],
            "label": row["session_id"][:RAW_TEXT["label"]]}
