"""Approval Broker: one-shot decisions bound to request_id + generation, with a deadline."""
from collections import OrderedDict
import hashlib
import itertools
import secrets
import threading
import time

from sessions.own import MODES
from tool_gateway.policy import POLICY
from traces.trace_store import TURN_TRACE

DECISIONS = ("allow", "allow_session", "deny")


class ApprovalRequest:
    def __init__(self, request_id, generation, source, session_id, agent_id, tool_name,
                 created, deadline, tool_fp=None, tool_summary=None, kind="tool", dispatch=None, display=None,
                 session_scope=None, targets=None, cwd=None, summary_truncated=False, summary_length=None,
                 summary_sha256=None, content_preview=None, content_preview_truncated=False,
                 content_preview_length=0, content_preview_sha256=None):
        self.request_id = request_id
        self.generation = generation
        self.source = source
        self.session_id = session_id
        self.agent_id = agent_id
        self.tool_name = tool_name
        self.tool_fp = tool_fp
        self.tool_summary = tool_summary
        self.summary_truncated = summary_truncated
        self.summary_length = summary_length if summary_length is not None else len(tool_summary or "")
        self.summary_sha256 = summary_sha256 if summary_sha256 is not None else \
            hashlib.sha256(tool_summary.encode("utf-8", "surrogatepass")).hexdigest() if tool_summary is not None else None
        self.content_preview = content_preview
        self.content_preview_truncated = content_preview_truncated
        self.content_preview_length = content_preview_length
        self.content_preview_sha256 = content_preview_sha256
        self.kind = kind  # "tool" (Claude PermissionRequest) or "dispatch" (agentd's own task)
        self.dispatch = dispatch
        self.cwd = cwd  # where the tool runs; None on dispatch cards, whose dispatch["cwd"] says it
        self.display = display or f"{source}:{session_id}"  # own sessions show their "own:<hex>" id
        self.trace_id = TURN_TRACE.get()  # the turn the card was opened in; None outside a turn
        # {"kind", "detail", "updates"} when the agent itself offers allowing this for the rest of the session.
        self.session_scope = session_scope if not (summary_truncated or content_preview_truncated) else None
        # targets: the paths or commands to judge one by one when the summary joins several; None judges the summary.
        self.verdict = POLICY.card(kind, tool_name, (tool_summary,) if targets is None else targets,
                                   window=deadline - created)
        self.danger = {"dangerous": self.verdict.dangerous, "rule": self.verdict.rule}
        self.created = created
        self.created_at = time.time()  # epoch seconds; created is on the broker clock
        self.deadline = deadline
        self.status = "pending"  # pending | decided | consumed | expired | cancelled | abandoned
        self.decision = None
        self.ended = None  # broker clock time it left pending; None while pending
        self.ended_by = None  # retire reason (expired, tool_event, ...) or who decided (card, native)
        self.mode = None  # the mode a dispatch card was allowed with; None means not chosen
        self.message = None  # the user's reason given with a deny; None when they gave none

    def to_dict(self, now):
        scope = self.session_scope
        return {"request_id": self.request_id, "generation": self.generation,
                "display_session": self.display,
                "source": self.source, "session_id": self.session_id,
                "agent_id": self.agent_id, "tool_name": self.tool_name,
                "tool_summary": self.tool_summary, "kind": self.kind, "dispatch": self.dispatch,
                "summary_truncated": self.summary_truncated, "summary_length": self.summary_length,
                "summary_sha256": self.summary_sha256, "content_preview": self.content_preview,
                "content_preview_truncated": self.content_preview_truncated,
                "content_preview_length": self.content_preview_length,
                "content_preview_sha256": self.content_preview_sha256,
                "cwd": self.cwd,
                "dangerous": self.danger["dangerous"], "danger_rule": self.danger["rule"],
                "trace_id": self.trace_id, "options": ["allow", "allow_session", "deny"] if scope else ["allow", "deny"],
                "session_scope": {"kind": scope["kind"], "detail": scope["detail"]} if scope else None,
                "status": self.status, "created_at": self.created_at,
                "window_s": round(self.deadline - self.created, 3),
                "seconds_left": max(0.0, round(self.deadline - now, 3))}


class ApprovalBroker:
    def __init__(self, hook_timeout=60.0, margin=5.0, clock=time.monotonic, history=1024):
        if margin <= 0 or margin >= hook_timeout:
            raise ValueError("deadline must be shorter than hook timeout")
        self.window = hook_timeout - margin
        self.clock = clock
        self.cv = threading.Condition()
        self._generation = itertools.count(1)
        self._requests = OrderedDict()
        self._history = history
        self._forgotten_at = None
        self.on_decision = None  # callable(kind, attrs, key); whatever it raises is dropped

    def open(self, source, session_id, tool_name=None, agent_id=None, tool_fp=None,
             tool_summary=None, kind="tool", dispatch=None, display=None, session_scope=None, targets=None,
             window=None, cwd=None, summary_truncated=False, summary_length=None, summary_sha256=None,
             content_preview=None, content_preview_truncated=False, content_preview_length=0,
             content_preview_sha256=None):
        with self.cv:
            now = self.clock()
            request = ApprovalRequest(secrets.token_hex(8), next(self._generation), source,
                                      session_id, agent_id, tool_name, now, now + (window or self.window),
                                      tool_fp, tool_summary, kind, dispatch, display, session_scope, targets,
                                      cwd, summary_truncated, summary_length, summary_sha256, content_preview,
                                      content_preview_truncated, content_preview_length, content_preview_sha256)
            self._requests[request.request_id] = request
            if len(self._requests) > self._history:
                for ident, old in list(self._requests.items()):
                    if old.status not in ("pending", "decided"):
                        del self._requests[ident]
                        if len(self._requests) <= self._history:
                            break
            self._report("approval.opened", request)
            return request

    def wait(self, request_id, abandoned=None):
        """Block until decided or past deadline; return one of DECISIONS or None (no decision).

        abandoned() is polled while waiting; True means nobody will read the answer."""
        with self.cv:
            request = self._requests[request_id]
            while request.status == "pending":
                left = request.deadline - self.clock()
                if left <= 0:
                    request.status = "expired"
                    self._report("approval.retired", request, reason="expired")
                    break
                if abandoned is None:
                    self.cv.wait(left)
                    continue
                self.cv.wait(min(left, 0.25))
                if request.status == "pending" and abandoned():
                    request.status = "abandoned"
                    # Claude drops the hook once its native dialog is answered, as on a native deny.
                    self._report("approval.decided", request, decision="deny", by="native")
            if request.status != "decided":
                return None
            request.status = "consumed"
            return request.decision

    def decide(self, request_id, generation, decision, mode=None, message=None):
        """Return (True, None) if accepted, else (False, reason). mode: a MODES name, for dispatch cards only;
        message: the user's reason, kept only with a deny."""
        if decision not in DECISIONS:
            return False, "invalid_decision"
        with self.cv:
            request = self._requests.get(request_id)
            if request is None:
                return False, "unknown_request"
            if not isinstance(generation, int) or isinstance(generation, bool) \
                    or generation != request.generation:
                return False, "generation_mismatch"
            if request.status == "pending" and self.clock() >= request.deadline:
                request.status = "expired"
                self._report("approval.retired", request, reason="expired")
            if request.status != "pending":
                return False, "already_decided" if request.status in ("decided", "consumed") \
                    else request.status
            if mode is not None and request.kind == "tool":
                return False, "invalid_mode"
            if mode is not None and (not isinstance(mode, str) or mode not in MODES):
                return False, "unsupported_mode"
            if decision == "allow_session" and request.session_scope is None:
                return False, "scope_unavailable"
            request.status = "decided"
            request.decision = decision
            request.mode = mode
            request.message = message if decision == "deny" else None
            self._report("approval.decided", request, decision=decision, by="card")
            self.cv.notify_all()
            return True, None

    def retire(self, source, session_id, agent_id, tool_name, tool_fp):
        """Cancel the one pending request this tool event answers; ambiguous matches wait out."""
        if tool_fp is None:
            return []
        key = (source, session_id, agent_id, tool_name, tool_fp)
        with self.cv:
            matches = [r for r in self._requests.values() if r.status == "pending"
                       and (r.source, r.session_id, r.agent_id, r.tool_name, r.tool_fp) == key]
            if len(matches) != 1:
                return []
            matches[0].status = "cancelled"
            self._report("approval.retired", matches[0], reason="tool_event")
            self.cv.notify_all()
            return [matches[0].request_id]

    def cancel_agent(self, source, session_id, agent_id):
        return self._cancel(lambda r: (r.source, r.session_id, r.agent_id) == (source, session_id, agent_id),
                            "agent_stopped")

    def cancel_session(self, source, session_id):
        return self._cancel(lambda r: (r.source, r.session_id) == (source, session_id), "session_ended")

    def cancel_all(self, reason="shutdown"):
        return self._cancel(lambda r: True, reason)

    def _cancel(self, match, reason):
        with self.cv:
            cancelled = []
            for request in self._requests.values():
                if request.status == "pending" and match(request):
                    request.status = "cancelled"
                    self._report("approval.retired", request, reason=reason)
                    cancelled.append(request.request_id)
            self.cv.notify_all()
            return cancelled

    def forget(self):
        """recent() leaves out every card that ended until now (reset); the requests stay for their waiters."""
        with self.cv:
            self._forgotten_at = self.clock()

    def recent(self, seconds):
        """Cards that left pending within the last seconds and after forget(), oldest first: to_dict plus ago_s
        and ended_by."""
        with self.cv:
            now = self.clock()
            return [{**r.to_dict(now), "decision": r.decision, "ago_s": now - r.ended, "ended_by": r.ended_by}
                    for r in self._requests.values() if r.ended is not None and now - r.ended <= seconds
                    and (self._forgotten_at is None or r.ended > self._forgotten_at)]

    def _report(self, kind, request, **attrs):
        if kind != "approval.opened" and request.ended is None:  # every way out of pending reports here
            request.ended, request.ended_by = self.clock(), attrs.get("reason") or attrs.get("by")
        self.report(kind, {"request_id": request.request_id, "tool": request.tool_name, **attrs}, request.request_id,
                    request.trace_id)

    def report(self, kind, attrs, key, trace_id=None):
        """Hand one decision record to on_decision; trace_id: the turn trace it belongs to, None for its own."""
        if self.on_decision is None:
            return
        try:
            if trace_id is None:
                self.on_decision(kind, attrs, key)
            else:
                self.on_decision(kind, attrs, key, trace_id=trace_id)
        except Exception:  # a decision record never changes the decision
            pass

    def pending(self):
        with self.cv:
            now = self.clock()
            return [r.to_dict(now) for r in self._requests.values()
                    if r.status == "pending" and now < r.deadline]
