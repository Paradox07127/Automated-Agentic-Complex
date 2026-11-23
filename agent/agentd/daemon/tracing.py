"""Turn traces, decision traces and their steps."""
import re
import sqlite3
import sys
import time

from character.proactive import WANT_COMMENT
from daemon.error_record import failure
from traces.trace_format import ENDS, HEAD_MAX
from traces.trace_store import DECISION_KINDS, DECISION_PREFIXES, new_span_id, new_trace_id
from api.views import _ms_since, _iso

DECISION_TRACES = 256  # decision keys whose events can still find their trace (see _decision)
TRACE_CODE = re.compile(r"[a-zA-Z0-9_-]{1,100}")


def trace_error(code):
    return code if isinstance(code, str) and TRACE_CODE.fullmatch(code) else None


class TracingMixin:
    def _trace(self, kind, trace_id, **fields):
        """TraceStore.emit; the event_id, or None without a store or when the store refuses the event.
        A stored event also goes to /diag/stream, its texts as {len, head} only."""
        turn, now = self._turn_trace, time.monotonic()
        if turn is not None and turn["trace_id"] == trace_id:
            if kind == "context.assembled":
                self.stage_times.assembled(turn["marks"], now)
            turn["marks"].append((kind, now))
        self.stage_times.event(kind, fields.get("status", "ok"), fields.get("turn_id"), fields.get("duration_ms"),
                               fields.get("attrs") or {})
        if self.trace is None:
            return None
        try:
            event_id = self.trace.emit(kind, trace_id, **fields)
        except (sqlite3.Error, ValueError) as e:
            self.trace_errors += 1
            # the store's reasons quote the refused values, which may be the user's text: names only
            reason = re.sub(r"(bad [\w.]+): [^;]*", r"\1", str(e)).replace("\n", " ")[:300]
            print(f"agentd: trace {kind} refused: {reason}", file=sys.stderr)
            return None
        if event_id is None:
            return None
        attrs = {**(fields.get("attrs") or {}), **{key: {"len": len(full), "head": full[:HEAD_MAX]}
                                                    for key, full in (fields.get("texts") or {}).items()}}
        decision = kind in DECISION_KINDS or kind.split(".")[0] in DECISION_PREFIXES
        self.diag.publish("decision" if decision else "trace",
                          {"event_id": event_id, "trace_id": trace_id, "turn_id": fields.get("turn_id"), "kind": kind,
                           "producer": fields.get("producer", "agentd"), "status": fields.get("status", "ok"),
                           "span_id": fields.get("span_id"), "parent_span_id": fields.get("parent_span_id"),
                           "duration_ms": fields.get("duration_ms"), "at": _iso(time.time()), "attrs": attrs})
        return event_id

    def _decision(self, kind, attrs, key, status="ok", trace_id=None):
        """on_decision of the gate, the judges, the behavior tick, the broker and the dispatcher:
        the events of one key share a trace, each caused by the one before. trace_id: the turn trace a key's first
        event opens in (an approval card opened in a turn); None opens a new trace."""
        with self._decision_lock:
            found = self._decision_traces.pop(key, None) \
                or {"trace_id": trace_id or new_trace_id(), "last": None, "at": time.monotonic()}
            self._decision_traces[key] = found
            while len(self._decision_traces) > DECISION_TRACES:
                self._decision_traces.popitem(last=False)
            event_id = self._trace(kind, found["trace_id"], causation_id=found["last"], attrs=attrs, status=status,
                                   duration_ms=_ms_since(found["at"]) if kind in ENDS else None)
            found["last"] = event_id or found["last"]
        if kind == "approval.decided":
            self.focus.count("approvals")
        if kind == "judge.decided" and WANT_COMMENT["id"] in {a["id"] for a in attrs["answers"]}:
            self._last_judge = {"backend": attrs["backend"], "answers": attrs["answers"], "at": _iso(time.time())}

    def _open_trace(self, line_id, generation, source, text, trace_id=None, causation=None, remember=True,
                    voice_timing=None, gift=None, detached=False):
        """A new line's trace with its root input.received; it becomes the turn a cancel lands in.
        trace_id, causation: an existing trace to continue, and its last event.
        remember False (「这一轮不记」): the turn's words stay out of its trace and its history row.
        voice_timing: see say; None leaves it out of input.received."""
        trace = {"trace_id": trace_id or new_trace_id(), "turn_id": line_id, "generation": generation,
                 "span": new_span_id(), "observation": new_span_id(), "last": causation, "cancel": None,
                 "done": False, "source": source, "marks": [], "reset": self.reset_generation,
                 "character_id": self.character, "history": self.history_generation, "trace_generation": self.trace_generation, "remember": remember}
        if not detached:
            self._turn_trace = trace
        attrs = {"source": source} if voice_timing is None else {"source": source, "voice_timing": voice_timing}
        if gift is not None:
            trace["gift"] = {"gift_id": gift["gift_id"], "count": gift["count"]}
            attrs.update(trace["gift"], action_ids=gift["action_ids"])
        self._step(trace, "input.received", trace["span"], attrs=attrs, texts={"text": text})
        return trace

    def _current(self, trace):
        """True while no reset and no chat clear has come since the trace opened."""
        if trace["reset"] != self.reset_generation or trace["history"] != self.history_generation:
            return False
        topic = trace.get("conversation_id")
        if topic and self.history is not None:
            with self.history.lock:
                return self.history.db.execute("SELECT 1 FROM conversations WHERE id=?", (topic,)).fetchone() is not None
        return True

    def _traced(self, trace):
        """_current, and no DELETE /attention has come since the trace opened."""
        return self._current(trace) and trace["trace_generation"] == self.trace_generation

    def _trace_epoch(self):
        return self.reset_generation, self.history_generation, self.trace_generation

    def _step(self, trace, kind, span, **fields):
        """One agentd event of this turn, caused by the turn's previous one; spans hang under the root."""
        if not trace["remember"] and fields.get("texts"):
            # Only the lengths: TraceStore would keep the text and its head.
            fields["attrs"] = {**(fields.get("attrs") or {}),
                               **{key: {"len": len(full), "head": ""} for key, full in fields.pop("texts").items()}}
        with self._write_lock:
            if not self._traced(trace):
                return None
            event_id = self._trace(kind, trace["trace_id"], turn_id=trace["turn_id"],
                                   turn_generation=trace["generation"], span_id=span,
                                   parent_span_id=None if span == trace["span"] else trace["span"],
                                   causation_id=trace["last"], **fields)
            trace["last"] = event_id or trace["last"]
            return event_id

    def _trace_tool(self, trace, phase, name, ident, outcome=None, error=None):
        if not isinstance(name, str) or not isinstance(ident, str) or not name or not ident:
            return
        attrs = {"tool": name[:128], "call_id": ident[:128]}
        spans = trace.setdefault("tools", {})
        if phase == "started":
            if ident not in spans:
                spans[ident] = (new_span_id(), time.monotonic(), attrs["tool"])
                self._step(trace, "tool.started", spans[ident][0], attrs=attrs)
        else:
            span, started, _ = spans.pop(ident, (new_span_id(), time.monotonic(), attrs["tool"]))
            self._step(trace, "tool.settled", span, duration_ms=_ms_since(started),
                       attrs={**attrs, "outcome": outcome, "error_code": trace_error(error)})

    def _turn_settled(self, trace, state, started, error=None, outcome=None, message=None):
        """error: the exception or code the turn failed with (see error_record.failure); message: what it was, when
        error is already a code."""
        status = "failed" if state == "failed" else "cancelled" if state in ("cancelled", "interrupted") else "ok"
        code, text = failure(error) if error is not None else (None, None)
        message = message or text
        for ident, (span, called, name) in trace.pop("tools", {}).items():
            self._step(trace, "tool.settled", span, duration_ms=_ms_since(called),
                       attrs={"tool": name, "call_id": ident[:128], "outcome": "waiting_user" if state == "waiting_user" else "failed",
                              "error_code": trace_error(code) or (None if state == "waiting_user" else "tool_unfinished")})
        self._step(trace, "turn.settled", new_span_id(), status=status, duration_ms=_ms_since(started),
                   attrs={"state": state, "error_code": trace_error(code), "outcome": trace_error(outcome),
                          **({"error_message": message} if status == "failed" and message else {}),
                          **({"route": trace["route"]} if "route" in trace else {})})
        if status == "failed":
            self.errors.record(code or "unknown", f"{trace['source']} turn failed: {message or 'unknown'}",
                               turn_id=trace["turn_id"], trace_id=trace["trace_id"])
