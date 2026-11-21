"""GET /diag/state and its blocks."""
import datetime
import json
import os
import stat
import time

from character.behavior import category
from observation.attention import PAGE_FRESH, SELECTION_FRESH
from observation.capture import WINDOW_TEXT_FRESH
from daemon.constants import VIEW_FRESH
from character.proactive import DWELL
from tools import install_hooks
from api.views import _ms, _iso, _shown, _stable, _settled_at, _why

# trace event kind -> the turn phase it starts; other kinds keep the phase
PHASES = {"input.received": "received", "observation.requested": "waiting_observation",
          "observation.settled": "assembling", "context.assembled": "calling_model", "model.started": "calling_model",
          "model.first_token": "streaming", "speech.requested": "synthesizing", "speech.first_audio": "playing",
          "playback.started": "playing", "playback.ended": "ended", "playback.interrupted": "ended",
          "cancel.acked": "ended"}
# context item type -> seconds it stays current, from the module that drops it
FRESH = {"view": VIEW_FRESH, "page": PAGE_FRESH, "selection": SELECTION_FRESH, "window_text": WINDOW_TEXT_FRESH}
REJECTED = ("declined", "unavailable", "expired", "failed")  # observation states that gave nothing


class DiagnosticsMixin:
    def diag_state(self, with_text=False):
        """GET /diag/state:the control panel's blocks, each with when its data last changed.
        Text values are {len, head}; with_text adds the whole text."""
        blocks = {"hooks": self._diag_hooks(), "turn": self._diag_turn(), "mouth_voice": self._diag_voice(), "gate": self._diag_gate(),
                  "proactive": self._diag_proactive(), "observation": self._diag_observation(),
                  "body": {"activity": self.registry.activity, "mood": self.registry.mood},
                  "sessions": {"sessions": [{"display_session": s["display_session"],
                                             "effective_state": s["effective_state"],
                                             "observed_at": _iso(s["observed_at"]),
                                             "stale": s["effective_state"] == "stale"}
                                            for s in self.registry.snapshot()["sessions"]]},
                  "budget": self._diag_budget(), "connections": self._diag_connections(),
                  "context": self._diag_context(False), "behavior": self._diag_behavior(),
                  "character_state": self.character_state(), "interaction": self.interaction.describe(),
                  "rituals": self._diag_rituals()}
        shown = {**blocks, "context": self._diag_context(True)} if with_text else dict(blocks)
        now = _iso(time.time())
        with self._diag_lock:
            for name, block in blocks.items():
                data = json.dumps(_stable(block), sort_keys=True, ensure_ascii=False)
                seen = self._diag_seen.get(name)
                if seen is None or seen[0] != data:
                    seen = self._diag_seen[name] = (data, now)
                shown[name] = {**shown[name], "updated_at": seen[1]}
        return shown

    def _diag_check(self):
        """A state item on /diag/stream when some block's data changed since the last one."""
        try:
            state = self.diag_state()
        except Exception:  # a failed snapshot must not stop the registry ticks
            return
        changed = tuple(block["updated_at"] for block in state.values())
        if changed != self._diag_sent:
            self._diag_sent = changed
            self.diag.publish("state", state)

    def _diag_turn(self):
        trace = self._turn_trace
        language = {"lines": self.language_lines, "mismatched": self.language_mismatched}
        if trace is None:
            return {"turn_id": None, "trace_id": None, "source": None, "generation": None, "phase": None,
                    "phases_ms": {}, "language": language}
        marks, phases, phase, since = list(trace["marks"]), {}, None, None
        for kind, at in marks:
            new = PHASES.get(kind, phase)
            if new != phase:
                if phase is not None:
                    phases[phase] = phases.get(phase, 0) + _ms(since, at)
                phase, since = new, at
        ended = phase == "ended" or trace["done"] and not (self.speech is not None and self.speech.busy())
        if phase not in (None, "ended"):
            phases[phase] = phases.get(phase, 0) + _ms(since, marks[-1][1] if ended else time.monotonic())
        return {"turn_id": trace["turn_id"], "trace_id": trace["trace_id"], "source": trace["source"],
                "generation": trace["generation"], "phase": "ended" if ended else phase, "phases_ms": phases,
                "language": language}

    def _diag_voice(self):
        relay, voice = self.speech, None
        if relay is not None:
            busy, played = relay.busy(), relay.played()
            if relay.interrupted() is not None:
                voice = "interrupted"
            elif played == "unknown":
                voice = "unknown"
            elif not busy:
                voice = "idle"
            elif played is not None:  # the renderer's receipts say it really plays
                voice = "buffering" if played == "buffering" else "playing"
            elif self._speaking not in self._audible:
                voice = "synthesizing"
            else:
                voice = "playing_estimated"
        return {"mouth": "busy" if self._mouth_lock.locked() else "idle", "voice": voice, "muted": self.muted,
                "avatar_visible": self.avatar["visible"], "speech_failed": self._speech_failed}

    def _diag_gate(self):
        gate, now = self.gate, datetime.datetime.now()
        left = lambda last, cooldown: round(cooldown - (now - last).total_seconds(), 1)  # noqa: E731

        def cooldown(kind):  # as Gate._reason scales it
            scale = gate.scale.get(kind, 1)
            if kind == "comment" and gate.state_scale is not None:
                scale *= max(1, gate.state_scale())
            return gate.same_cooldown * scale
        return {"enabled": gate.enabled, "companion_mode": bool(gate.companion),
                "quiet_hours": list(gate.quiet), "meeting": gate.meeting,
                "fullscreen": gate.fullscreen, "user_speaking": gate.user_speaking,
                "cooldown_s": {kind: left(last, cooldown(kind)) for kind, last in list(gate._last.items())
                               if left(last, cooldown(kind)) > 0},
                "cross_cooldown_s": max(0.0, left(gate._last_any, gate.cross_cooldown)) if gate._last_any else 0.0,
                "today": gate._count if gate._day == now.date() else 0, "daily_limit": gate.daily_limit,
                "blocked_today": gate._blocked if gate._day == now.date() else 0}

    def _diag_hooks(self):
        """Observe-only hooks:whether each agent's hook file holds ours for this agentd (None: no file to
        check, or one this tool cannot read), and when the last hook came in."""
        url = f"http://127.0.0.1:{self.server_port}"

        def installed(path):
            if path is None:
                return None
            try:
                stat = os.stat(path)
                key = (stat.st_mtime_ns, stat.st_size)
            except FileNotFoundError:
                key = None
            except OSError:
                return None
            cached = self._hook_installed.get(path)
            if cached is not None and cached[0] == key:
                return cached[1]
            try:
                value = bool(install_hooks.owned(install_hooks.load(path), url))
            except (install_hooks.Refused, OSError):
                value = None
            self._hook_installed[path] = (key, value)
            return value
        return {target: {"installed": installed(self.hook_files.get(target)),
                         "last_at": None if self.hook_seen.get(target) is None else _iso(self.hook_seen[target])}
                for target in ("claude", "codex")}

    def _diag_proactive(self):
        run = self.attention.dwell() if self.attention is not None else None
        proactive = self.proactive
        held = "companion_off" if self.gate.check("comment") == "companion_off" else None
        asks = run is not None and proactive is not None and proactive.judge is not None and proactive._asked != run[0]
        return {"focus": run and {"category": category(run[2]), "dwell_s": round(run[1], 1)},
                "next_judge_at": _iso(run[0] + DWELL) if asks and held is None else None,
                "held": held, "last_judge": self._last_judge,
                "misses": proactive and proactive.misses, "factor": proactive and proactive.factor}

    def _diag_rituals(self):
        """The kinds a tap may say now, and the rituals said to the end today."""
        if self.rituals is None:
            return {"pending": [], "today": []}
        return {"pending": self.rituals.pending(),
                "today": [{**entry, "at": _iso(entry["at"])} for entry in self.rituals.today()]}

    def _diag_observation(self):
        capture = self.capture
        if capture is None:
            return {"pending": [], "recent": [], "policy_epoch": None, **self.observation_state()}
        with capture._lock:  # the request threads change both dicts
            now, opened = capture.clock(), dict(capture.open)
            records = [r for r in map(capture.observation, list(capture.observations)) if r is not None]
            policy_epoch = capture.policy_epoch
        ended = sorted((r for r in records if r["status"] != "pending"), key=_settled_at, reverse=True)[:5]
        return {"policy_epoch": policy_epoch, "pending": [{"request_id": r["request_id"], "window_id": r["window_id"], "mode": r["mode"],
                             "reason": opened.get(r["request_id"], (None, None))[1],
                             "waited_ms": round((now - r["requested_at"]) * 1000)}
                            for r in records if r["status"] == "pending"],
                "recent": [{"request_id": r["request_id"], "mode": r["mode"], "state": r["status"],
                            "reason": r["reason"], "at": _iso(_settled_at(r))} for r in ended],
                **self.observation_state()}

    def _diag_budget(self):
        # capture.budget.today() and usage.today(); a meter without today() shows null.
        screenshots = getattr(getattr(self.capture, "budget", None), "today", None)
        model = getattr(getattr(self, "usage", None), "today", None)
        return {"screenshots": screenshots() if screenshots else None, "model": model() if model else None,
                "redactions": dict(self.egress.redactions) if self.egress is not None else None}

    def _diag_connections(self):
        return {"agentd": {"started_at": _iso(self._started_at), "epoch": self.registry.epoch},
                "tts": {"configured": self.speech is not None, **(self._tts_last or {"result": None, "at": None}),
                        **self.voice.state().wire(self.voice.clock())},
                "browser": {"last_message_at": _iso(self._browser_at) if self._browser_at else None},
                "avatar": {"speech_readers": self.speech_readers, "heartbeat_at": None}}

    def _diag_behavior(self):
        state = self.spatial.diag()
        running, last = state["running"], state["last_receipt"]
        return {"running": [{**r, "since": _iso(r["since"])} for r in running], "switches": state["switches"],
                "last_receipt": last and {**last, "at": _iso(last["at"])},
                "capability_character": state["capability_character"], "capabilities": state["capabilities"],
                "unsupported": state["unsupported"]}

    def _diag_context(self, with_text):
        """What the mouth was given last and until when, what she can see now, the latest refusal and why."""
        attention, capture, now = self.attention, self.capture, time.time()
        assembled_at, items = self._assembled or (None, [])
        shown = []
        for item in items:
            seen = capture.observation(item["observation_id"]) \
                if capture is not None and item["type"] == "view" and item["observation_id"] else None
            expires = ((seen or {}).get("observed_at") or assembled_at) + FRESH[item["type"]] \
                if item["type"] in FRESH else None
            shown.append({**item, "expires_at": expires and _iso(expires), "expired": bool(expires) and now > expires})
        text = lambda value: _shown(value, with_text)  # noqa: E731
        window = attention.focus() if attention is not None else None
        page = attention.current_page() if attention is not None else None
        selection = attention.latest_selection() if attention is not None else None
        scene = self.activity()
        until = (self.correction or {}).get("until") if scene and scene["corrected"] else None
        connected = lambda ok: "connected" if ok else "not_connected"  # noqa: E731
        return {"items": shown,
                "window": window and {"app": window.get("app"), "title": text(window.get("title"))},
                "page": page and {"url_host": page["url_host"], "title": text(page["title"]),
                                  "text": text(page["text"]), "at": _iso(page["ts"]),
                                  "expires_at": _iso(page["ts"] + PAGE_FRESH)},
                "selection": selection and {"url_host": selection["url_host"], "title": text(selection["title"]),
                                            "text": text(selection["text"]), "at": _iso(selection["ts"]),
                                            "expires_at": _iso(selection["ts"] + SELECTION_FRESH)},
                "activity": scene and {"activity": scene["activity"], "confidence": scene["confidence"],
                                       "corrected": scene["corrected"], "until": until and _iso(until),
                                       "mode": scene["mode"], "state": scene["state"], "evidence": scene["evidence"]},
                "rejected": self._rejected(),
                "sources": {"screenshots": connected(capture is not None and capture.vision is not None),
                            "window_text": connected(capture is not None and capture.share_text),
                            "page_text": connected(self.page_text_allowed() and self._browser_at is not None)}}

    def _rejected(self):
        """The latest observation that gave nothing; reason says why."""
        found = [self._refused] if self._refused else []
        capture = self.capture
        if capture is not None:
            with capture._lock:  # the request threads change the dict
                records = [r for r in map(capture.observation, list(capture.observations)) if r is not None]
            for record in records:
                if record["status"] in REJECTED:
                    found.append({"request_id": record["request_id"], "state": record["status"],
                                  "detail": record["reason"], "at": _settled_at(record)})
            view = capture.view()
            if view is not None and time.time() - view["ts"] > VIEW_FRESH:
                found.append({"request_id": view["request_id"], "state": "expired", "detail": "view_stale",
                              "at": view["ts"] + VIEW_FRESH})
        if not found:
            return None
        last = max(found, key=lambda r: r["at"])
        return {**last, "at": _iso(last["at"]), "reason": _why(last["state"], last["detail"])}
