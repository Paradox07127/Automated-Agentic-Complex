"""Privacy, pause, quiet and meeting switches, the observation state, and the settings PUT /settings/live applies."""
import contextlib
import math

from character.interactions import preset
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
            if self.proactive is not None:
                self.proactive.reset()
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

    def apply_live_settings(self, settings):
        """PUT /settings/live (body checked by the route): each setting as its launch argument sets it at startup, in
        effect from now on. A sharing switch whose plug-in is off stays off, as at startup."""
        interaction = preset(settings["interaction_preset"])
        with self._live_lock:
            self.gate.set_interaction(settings["proactive_speech"], interaction.name)
            self.interaction = interaction
            self.spatial.set_interaction(interaction.name)
            if self.behavior is not None:
                self.behavior.set_interaction(interaction.name)
            if self.facing_decisions is not None:
                self.facing_decisions.set_min_interval(interaction.model_every)
            self.muted = settings["mute"]
            if self.egress is not None:
                self.egress.set_redact(settings["redact_sensitive"])
            awareness, capture = plugins.on("screen_awareness"), self.capture
            # The capture lock before the consent lock, the order CaptureManager._allowed takes them in: a consent
            # snapshot sees every capability old or every one new.
            with (capture._lock if capture is not None else contextlib.nullcontext()), self.consent.lock:
                self.share_page_text = awareness and settings["share_page_text"]
                self.share_typed_text = awareness and settings["share_typed_text"]
                self.share_agent_sessions = plugins.on("coding_sessions") and settings["share_agent_sessions"]
                if capture is not None:
                    capture.share_text = settings["share_window_text"]
                    if not settings["share_screenshots"]:
                        capture.vision = None
                    elif capture.vision is None:
                        from character_agent.services.semantic import SemanticVision
                        capture.vision = SemanticVision(self.character_agent.semantic)
        self.sync_privacy()

    def privacy_preview(self, revoked=()):
        """POST /context/privacy/sync with dry_run: what sync_privacy(revoked) would delete now, by category;
        deletes nothing. In-memory caches are not counted."""
        self.consent.snapshot()
        with self.consent.lock:
            revoked = set(revoked) | self.consent.revoked
        counts = dict.fromkeys(("task_understanding", "browser_text", "typed_values", "episodes", "facts"), 0)
        if not revoked:
            return counts
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
        return self.observation_paused_now()

    def observation_paused_now(self):
        """observation_paused() without settling an ended quiet, which writes a setting: safe under memory.lock."""
        now, quiet = self.clock(), self.quiet_until
        if quiet is not None and now >= quiet:
            return self._quiet_meeting
        if self.gate.meeting_manual:
            return True
        until = self.paused_until
        return until is not None and now < until

    def paused_at(self, ts):
        """Whether ts falls in a pause of the last RAW_PAST seconds."""
        return any(start <= ts <= end for start, end in self._pauses + self._meetings)

    def set_meeting(self, on):
        """PUT /observation/meeting: pauses observation like PUT /observation/paused until it is turned off."""
        until = self.quiet_until if self.quiet_until is not None and not self._quiet_meeting else math.inf
        self._meetings = self._spans(self._meetings, until if on else None)
        self.gate.meeting_manual = on
        # Quiet turns meeting mode on for the gate; user_now keeps the user's own switch and shows quiet as dnd_until.
        self.user_now.set_overrides(meeting_manual=self._quiet_meeting if self.quiet_until is not None else on,
                                    dnd_until=self.quiet_until)

    def set_paused_until(self, until):
        """PUT /observation/paused: the end is saved too, so a restart keeps the pause (see load_pause)."""
        self._pauses = self._spans(self._pauses, until)
        self.paused_until = until
        # Quiet pauses observation through here too; only the user's own pause freezes user_now.
        self.user_now.pause(None if until is not None and until == self.quiet_until else until)
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
            self.refresh_quiet()
        elif self.quiet_until is not None:
            self.quiet_until = None
            self.set_meeting(self._quiet_meeting)
            self.set_paused_until(None)
            self.refresh_quiet()

    def _quiet_due(self):
        if self.quiet_until is not None and self.clock() >= self.quiet_until:
            self.quiet_until = None
            self.set_meeting(self._quiet_meeting)
            self.set_paused_until(None)
            self.refresh_quiet()

    def refresh_quiet(self):
        """Registry.quiet's only writer: the stage is offstage or quiet, or quiet (DND) holds."""
        self.registry.set_quiet(self.user_now.snapshot()["stage"] in ("offstage", "quiet") or self.quiet_until is not None)

    def user_event(self, event):
        """Each user_now event: the gate follows the stage, each stage change sets Registry.quiet, and a return goes to
        the return performance and the spoken report and releases the signals held for the absence."""
        self.gate.stage = self.user_now.snapshot()["stage"]
        if event["name"].startswith("stage."):
            self.refresh_quiet()
            self.spatial.stage_event(event["name"])
        elif event["name"] == "user.return":
            self.returning.returned(event)
            if self.proactive is not None:
                self.proactive.back(event["data"]["away_s"])
            if self.signals is not None:
                self.signals.returned()

    def load_pause(self):
        """At start: a saved pause that has not ended yet holds again."""
        saved = self.memory.setting("observation_paused_until") if self.memory is not None else None
        if saved is not None and self.clock() < float(saved):
            self.paused_until = float(saved)
            self._pauses.append([self.clock(), self.paused_until])
            self.user_now.pause(self.paused_until)

    def observation_state(self):
        """GET /state and /diag/state: {"paused_until", "quiet_until": ISO or None, "meeting": the manual switch,
        "off": screen awareness disabled}."""
        self._quiet_due()
        until = self.paused_until
        return {"paused_until": _iso(until) if until is not None and self.clock() < until else None,
                "quiet_until": _iso(self.quiet_until) if self.quiet_until is not None else None,
                "meeting": self.gate.meeting_manual, "off": not plugins.on("screen_awareness")}
