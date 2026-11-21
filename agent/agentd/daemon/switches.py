"""Privacy, pause, quiet and meeting switches, and the observation state."""
import math

from infra import plugins
from infra.store import checkpoint
from api.views import _iso


class SwitchesMixin:
    def page_text_allowed(self):
        return self.consent.snapshot()[0]["page_text"]

    def external_session_activity_allowed(self):
        return plugins.on("coding_sessions") and not self.observation_paused() and self.consent.snapshot()[0]["agent_sessions"]

    def sync_privacy(self, revoked=()):
        """Apply saved revocations before reading context, dispatching, or accepting a late result."""
        self.consent.revoke(revoked)
        permissions, epoch = self.consent.snapshot()
        if self.capture is not None:
            self.capture.consent = self.consent.snapshot
        revoked = self.consent.take_revocations()
        if revoked:
            if self.character_agent is not None:
                self.character_agent.cancel("context_changed")
                if getattr(self.character_agent, "task_understanding", None): self.character_agent.task_understanding.clear()
            if self.capture is not None:
                self.capture.clear()
            if "page_text" in revoked and self.attention is not None:
                self.attention.clear_browser_text()
            if "typed_text" in revoked and self.attention is not None:
                self.attention.clear_typed_text()
            if "typed_text" in revoked and self.timeline is not None:
                self.timeline.clear_typed_text()
            if "window_text" in revoked and self.timeline is not None:
                self.timeline.clear_trees()
            if revoked:
                self.forget_user_state()
            if self.worklog is not None:
                self.worklog.delete_permissions(set(revoked))
            if set(revoked).intersection(('page_text','typed_text','window_text','screenshots','agent_sessions')) and self.episodes is not None:
                self._forget_derived(self.episodes.delete_permissions(set(revoked)), wait=False)
                checkpoint(self.episodes)
            self._assembled = None
            for line in tuple(self._live_lines):
                self._context_cut.add(line)
                line.set()
            if self._live_lines:
                self.cancel_turn("context_cleared")
        return permissions, epoch

    def privacy_preview(self, revoked=()):
        """POST /context/privacy/sync with dry_run: what sync_privacy(revoked) would delete now, by category;
        deletes nothing. In-memory caches are not counted."""
        self.consent.snapshot()
        with self.consent.lock:
            revoked = set(revoked) | self.consent.revoked
        counts = dict.fromkeys(("task_understanding", "browser_text", "typed_values", "episodes", "facts"), 0)
        if not revoked:
            return counts
        understanding = getattr(self.character_agent, "task_understanding", None)
        if understanding:
            counts["task_understanding"] = sum(understanding.clear(dry=True).values())
        if "page_text" in revoked and self.attention is not None:
            counts["browser_text"] = self.attention.clear_browser_text(dry=True)
        if "typed_text" in revoked and self.attention is not None:
            counts["typed_values"] = self.attention.clear_typed_text(dry=True)
        if "typed_text" in revoked and self.timeline is not None:
            counts["typed_values"] += self.timeline.clear_typed_text(dry=True)
        if revoked.intersection(("page_text", "typed_text", "window_text", "screenshots", "agent_sessions")) and self.episodes is not None:
            gone = self.episodes.delete_permissions(revoked, dry=True)
            facts, more = self.memory.derived_preview(gone, gone) if self.memory is not None else ((), ())
            counts["episodes"], counts["facts"] = len({str(ident) for ident in gone} | set(more)), len(facts)
        return counts

    def observation_paused(self):
        """True until paused_until; the pause ends by itself. Also paused during a manual meeting."""
        self._quiet_due()
        if self.gate.meeting_manual:
            return True
        until = self.paused_until
        return until is not None and self.clock() < until

    def paused_at(self, ts):
        """Whether ts falls in a pause of the last RAW_PAST seconds."""
        return any(start <= ts <= end for start, end in self._pauses + self._meetings)

    def set_meeting(self, on):
        """PUT /observation/meeting: pauses observation like PUT /observation/paused until it is turned off."""
        until = self.quiet_until if self.quiet_until is not None and not self._quiet_meeting else math.inf
        self._meetings = self._spans(self._meetings, until if on else None)
        self.gate.meeting_manual = on

    def set_paused_until(self, until):
        """PUT /observation/paused: the end is saved too, so a restart keeps the pause (see load_pause)."""
        self._pauses = self._spans(self._pauses, until)
        self.paused_until = until
        if self.memory is not None:
            self.memory.set_setting("observation_paused_until", None if until is None else repr(until))

    def set_quiet_until(self, until):
        self._quiet_due()
        if until is not None:
            if self.quiet_until is None:
                self._quiet_meeting = self.gate.meeting_manual
            self.quiet_until = until
            self.set_meeting(True)
            self.set_paused_until(until)
        elif self.quiet_until is not None:
            self.quiet_until = None
            self.set_meeting(self._quiet_meeting)
            self.set_paused_until(None)

    def _quiet_due(self):
        if self.quiet_until is not None and self.clock() >= self.quiet_until:
            self.quiet_until = None
            self.set_meeting(self._quiet_meeting)
            self.set_paused_until(None)

    def load_pause(self):
        """At start: a saved pause that has not ended yet holds again."""
        saved = self.memory.setting("observation_paused_until") if self.memory is not None else None
        if saved is not None and self.clock() < float(saved):
            self.paused_until = float(saved)
            self._pauses.append([self.clock(), self.paused_until])

    def observation_state(self):
        """GET /state and /diag/state: {"paused_until", "quiet_until": ISO or None, "meeting": the manual switch,
        "off": screen awareness disabled}."""
        self._quiet_due()
        until = self.paused_until
        return {"paused_until": _iso(until) if until is not None and self.clock() < until else None,
                "quiet_until": _iso(self.quiet_until) if self.quiet_until is not None else None,
                "meeting": self.gate.meeting_manual, "off": not plugins.on("screen_awareness")}
