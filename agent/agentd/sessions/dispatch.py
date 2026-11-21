"""Dispatch card:a confirmation card; allowing it starts an own session (sessions/own.py)."""
import secrets
import threading
import time

from sessions.own import MODES, TITLE_MAX
from sessions.tasks import check_verify
from tool_gateway.policy import POLICY

# Announcement headlines by reply language code; "harness" (None) takes the Chinese ones.
HEADLINES = {"zh-Hans": {"dispatch_closed": "派给 {target} 的活过期了，没有开始", "dispatch_failed": "{target} 的任务没能开始"},
             "en": {"dispatch_closed": "The job for {target} expired before it started",
                    "dispatch_failed": "{target}'s task could not start"},
             "ja": {"dispatch_closed": "{target} への依頼は始まる前に期限切れになりました",
                    "dispatch_failed": "{target} のタスクを開始できませんでした"}}


class Dispatcher:
    def __init__(self, broker, sessions=None):
        self.broker = broker
        self.sessions = sessions  # SessionManager; its turns announce the result
        self.tasks = None  # TaskLedger; None keeps no task rows
        self.window = POLICY.window("dispatch")
        self.on_decision = None  # callable(kind, attrs, key); whatever it raises is dropped

    def propose(self, target, cwd, prompt, source="text", utterance=None, cwd_from=None, verify_cmd=None,
                title=None, requested_by=None):
        """Open the card; the task runs only after an explicit allow on it.

        utterance: the recognized speech the command came from, shown on the card; None for typed text.
        cwd_from: where cwd came from, {"source": "explicit"} or {"source": "focus", "display_session", "state"}.
        verify_cmd: as tasks.check_verify passed it for the card's read_only mode, or None."""
        dispatch_id = secrets.token_hex(6)
        request = self.broker.open("agentd", dispatch_id, target, tool_summary=prompt, kind="dispatch",
                                   dispatch={"target": target, "cwd": cwd, "prompt": prompt,
                                             "source": source, "utterance": utterance,
                                             "modes": list(MODES), "mode": "read_only", "verify_cmd": verify_cmd,
                                             "cwd_from": cwd_from,
                                             **({"title": title} if title is not None else {}),
                                             **({"requested_by": {k: requested_by[k] for k in ("run_id", "conversation_id")}}
                                                if requested_by is not None else {})},
                                   window=self.window)
        if self.tasks is not None:
            self.tasks.create(request.request_id, target, cwd, title if title is not None else prompt.strip().splitlines()[0][:TITLE_MAX],
                              "read_only", verify_cmd, requested_by=requested_by)
        self._report("dispatch.proposed", request, target=target, source=source)
        threading.Thread(target=self._await, args=(request, target, cwd, prompt), daemon=True).start()
        return request

    def _await(self, request, target, cwd, prompt):
        decision = self.broker.wait(request.request_id)
        mode = request.mode or "read_only"
        self._report("dispatch.decided", request, decision=decision or request.status, mode=mode)
        if decision != "allow":
            if request.status == "expired":
                self._task(request, "expired")
                self._announce("dispatch_closed", "P2", target, cwd, request)
            elif decision == "deny":
                self._task(request, "denied")
            return
        approved = {"mode": mode, "verify_cmd": request.dispatch["verify_cmd"]}
        try:
            check_verify(mode, approved["verify_cmd"])  # the mode chosen on the card may allow less
        except ValueError:
            approved.update(verify_cmd=None, result={"reason": "verify_rejected"})
        self._task(request, "approved", **approved)
        try:
            self.sessions.create(target, cwd, prompt, origin=request.request_id, mode=mode)
        except Exception as error:
            self._task(request, "cancelled", result={"reason": "start_failed"})
            # Before the announcement, whose dispatch.finished closes the card's trace.
            self._report("dispatch.failed", request, error=type(error).__name__)
            self._announce("dispatch_failed", "P1", target, cwd, request)

    def _task(self, request, state, **attrs):
        if self.tasks is not None:
            self.tasks.transition(request.request_id, state, **attrs)

    def _announce(self, kind, level, target, cwd, request):
        # No session exists to name the card, so the announcement carries its request_id.
        headline = HEADLINES.get(self.sessions.reply_language(), HEADLINES["zh-Hans"])[kind].format(target=target)
        self.sessions.announce({"ts": time.time(), "level": level, "kind": kind, "headline": headline,
                                "project": cwd, "session_id": None, "detail": None,
                                "origin": request.request_id})

    def _report(self, kind, request, **attrs):
        if self.on_decision is None:
            return
        try:
            self.on_decision(kind, {"request_id": request.request_id, **attrs}, request.request_id)
        except Exception:  # a decision record never stops the dispatch
            pass
