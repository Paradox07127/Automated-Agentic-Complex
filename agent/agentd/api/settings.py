"""POST /model/*, PUT /behavior/capabilities, /behavior/switches and /settings/live, /proactive/*, and POST /reset."""
from datetime import date
import re
from urllib.parse import parse_qs, urlparse

import c1
from character.interactions import PRESETS
from character.proactive import MUTABLE
from personal.brief_day import brief_day

RESET_CONFIRM = "delete all local data"  # POST /reset's body must be {"confirm": RESET_CONFIRM}
# PUT /settings/live: the check of each member; the body has exactly these members
LIVE_SETTINGS = {
    **dict.fromkeys(("mute", "proactive_speech", "redact_sensitive", "share_page_text", "share_window_text",
                     "share_typed_text", "share_agent_sessions", "share_screenshots"), lambda v: type(v) is bool),
    "interaction_preset": lambda v: isinstance(v, str) and v in PRESETS,
}


def _backends_read(agent, saved):
    """The 「AI 账号」 backends the character agent's kernels read: the saved provider, the main config's provider and
    the provider of each routed kernel; an ACP kernel may run dsh on the DeepSeek key."""
    from character_agent.harness.registry import harness
    config = agent.settings.snapshot()
    kernels = [config["backend"], *(entry["backend"] for entry in config["routes"].values() if entry)]
    return {saved["provider"], config["provider"]} | {
        "deepseek" if h.provider == "acp" else h.provider for h in filter(None, map(harness, kernels))}


class SettingsMixin:
    def _models_post(self, path, body):
        from models.model_auth import ModelError
        import httpx
        models = self.server.models
        if models is None:
            return self._json(503, {"error": "models_unavailable"})
        if not isinstance(body, dict):
            return self._json(400, {"error": "invalid_payload"})
        try:
            if path == "/model/settings":
                before = models.snapshot()
                result = models.save(body)
                agent = self.server.character_agent
                if agent is not None:
                    after = models.snapshot()
                    read = _backends_read(agent, before) | {after["provider"]}
                    if before["provider"] != after["provider"] or any(
                            before["backends"][name] != after["backends"][name] for name in read & after["backends"].keys()):
                        agent.cancel("credentials_changed")
            elif path == "/model/catalog":
                from character_agent.harness import registry
                agent = self.server.character_agent
                result = models.catalog(lambda provider: registry.pi_catalog(agent, provider))
            elif path == "/model/test":
                result = self._model_test()
            elif path == "/model/chatgpt/start":
                result = models.auth.start(body.get("profile_id"))
            elif path == "/model/chatgpt/cancel":
                models.auth.cancel()
                result = models.auth.state()
            elif path == "/model/chatgpt/select":
                models.auth.select(body.get("profile_id"))
                result = models.auth.state()
            else:
                result = models.auth.logout(body.get("profile_id"))
            return self._json(200, result)
        except (ModelError, ValueError) as error:
            return self._json(400, {"error": str(error)})
        except httpx.HTTPError:
            return self._json(502, {"error": "provider_unreachable"})
        except Exception:
            # Provider exceptions may embed credentials or request bodies. Keep them out of HTTP and logs.
            return self._json(502, {"error": "provider_request_failed"})

    def _model_test(self):
        """Pi: one call on its main connection, the one the settings page shows. Other kernels: a review task."""
        import time
        from types import SimpleNamespace
        from character_agent.harness.transport import HarnessError
        from character_agent.services.semantic import failure_code
        agent = self.server.character_agent
        prompt = '<ping>\nThis is a connection test. Reply with only {"ok":true}.\n</ping>'
        started = time.monotonic()
        config = agent.settings.snapshot()
        if config["backend"] != "pi":
            ping = agent.semantic.run("review", prompt, {})
            return {"ok": True, "kernel": ping["backend"], "provider": None, "model": ping["model"],
                    "elapsed_ms": round((time.monotonic() - started) * 1000), "tokens": None, "cost_usd": None}
        error = agent.route_error(config)
        if error:
            raise ValueError(error)
        provider = agent._pi_connection(config)["provider"]
        session = agent._session_factory([], config, native_tools=False)
        result = {}
        try:
            for event in session.stream(prompt, system_prompt="只返回一个 JSON 对象。", timeout=120):
                if event.get("type") == "result":
                    result = event
                elif event.get("type") == "error":
                    raise ValueError(failure_code(event, event.get("code", "pi_runner_error")))
        except HarnessError as failure:
            raise ValueError(failure.code) from None
        finally:
            session.close()
        model = result.get("model") or agent._model(config)
        meter = self.server.usage or agent.semantic.usage
        if meter and result:
            meter.record(model, "review", SimpleNamespace(**(result.get("usage") or {})),
                         status="completed" if result.get("success") else "failed", provider=provider,
                         channel="pi_" + config["auth_source"], cost_usd=result.get("cost_usd"),
                         cost_source="sdk_estimate" if result.get("cost_usd") is not None else None)
        if not result.get("success"):
            raise ValueError(failure_code(result, result.get("error") or "semantic_incomplete"))
        return {"ok": True, "kernel": "pi", "provider": provider, "model": model,
                "elapsed_ms": round((time.monotonic() - started) * 1000),
                "tokens": result.get("usage"), "cost_usd": result.get("cost_usd")}

    def _capabilities_put(self):
        try:
            body = self._body()
        except ValueError:
            return self._json(400, {"error": "invalid_capabilities"})
        known = set(c1.TYPES) | {"sit@window", "attend_session@user", "auto_facing", "fullscreen_give_way"} \
            | {f"sit/{v}" for v in c1.VARIANTS}
        caps = body.get("capabilities") if isinstance(body, dict) else None
        character = body.get("character_id") if isinstance(body, dict) else None
        if not isinstance(character, str) or not character or not isinstance(caps, dict) or not set(caps) <= known \
                or any(v is not None and (not isinstance(v, str) or not v or len(v.encode()) > 512) for v in caps.values()):
            return self._json(400, {"error": "invalid_capabilities"})
        if character != self.server.character:
            return self._json(409, {"error": "character_changed"})
        self.server.spatial.set_capabilities(character, caps)
        return self._json(200, {"character_id": character, "capabilities": caps})

    def _switches_put(self):
        """PUT /behavior/switches:the whole switch object each time; kept in memory only."""
        try:
            body = self._body()
        except ValueError:
            return self._json(400, {"error": "invalid_switches"})
        if c1.check_switches(body):
            return self._json(400, {"error": "invalid_switches"})
        self._json(200, self.server.spatial.set_switches(body))

    def _live_settings_put(self):
        """PUT /settings/live: the whole object each time; 200 once every value is in effect."""
        try:
            body = self._body()
        except ValueError:
            body = None
        if not isinstance(body, dict) or set(body) != set(LIVE_SETTINGS) \
                or not all(check(body[key]) for key, check in LIVE_SETTINGS.items()):
            return self._json(400, {"error": "invalid_settings"})
        self.server.apply_live_settings(body)
        self._json(200, {"ok": True})

    def _proactive_mutes_get(self):
        self._json(200, {"muted": sorted(self.server.gate.muted)})

    def _proactive_settings_get(self):
        on, ranges = self.server.gate.quiet_settings
        self._json(200, {"companion_mode": self.server.gate.companion, "quiet_enabled": on, "quiet_ranges": ranges})

    def _proactive_settings_put(self):
        """Any non-empty part of {companion_mode, quiet_enabled, quiet_ranges}; quiet_ranges is 0 to 8 [start, end]
        pairs of whole local hours 0-23, start != end."""
        try:
            body = self._body()
        except ValueError:
            body = None
        hour = lambda v: type(v) is int and 0 <= v <= 23  # noqa: E731
        if not isinstance(body, dict) or not body or not set(body) <= {"companion_mode", "quiet_enabled", "quiet_ranges"} \
                or not all(isinstance(body[k], bool) for k in ("companion_mode", "quiet_enabled") if k in body) \
                or "quiet_ranges" in body and not (
                    isinstance(body["quiet_ranges"], list) and len(body["quiet_ranges"]) <= 8
                    and all(isinstance(r, list) and len(r) == 2 and hour(r[0]) and hour(r[1]) and r[0] != r[1]
                            for r in body["quiet_ranges"])):
            return self._json(400, {"error": "invalid_payload"})
        gate = self.server.gate
        if "companion_mode" in body:
            gate.set_companion(body["companion_mode"])
        if "quiet_enabled" in body or "quiet_ranges" in body:
            on, ranges = gate.quiet_settings
            gate.set_quiet(body.get("quiet_enabled", on), body.get("quiet_ranges", ranges))
        self._proactive_settings_get()

    def _proactive_stats_get(self):
        query = parse_qs(urlparse(self.path).query, keep_blank_values=True)
        try:
            days = int(query.get("days", ["7"])[0])
        except ValueError:
            return self._json(400, {"error": "invalid_days"})
        if days < 1:
            return self._json(400, {"error": "invalid_days"})
        log = self.server.proactive_log
        self._json(200, log.stats(min(days, 30), self.server.clock()) if log is not None else {})

    def _brief_day_get(self):
        query = parse_qs(urlparse(self.path).query, keep_blank_values=True)
        raw = query.get("date", [""])[0]
        if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", raw):
            return self._json(400, {"error": "invalid_date"})
        try:
            day = date.fromisoformat(raw)
        except ValueError:
            return self._json(400, {"error": "invalid_date"})
        now = self.server.clock()
        if not 0 <= (date.fromtimestamp(now) - day).days <= 6:
            return self._json(400, {"error": "date_out_of_range"})
        return self._json(200, brief_day(self.server, day, now))

    def _proactive_mutes_put(self):
        """PUT /proactive/mutes: the whole list of muted proactive kinds each time."""
        try:
            body = self._body()
        except ValueError:
            body = None
        muted = body.get("muted") if isinstance(body, dict) else None
        if not isinstance(muted, list) or not all(kind in MUTABLE for kind in muted):
            return self._json(400, {"error": "invalid_payload"})
        self.server.gate.set_muted(muted)
        self._json(200, {"muted": sorted(self.server.gate.muted)})

    def _reset(self):
        """POST /reset: only the exact confirmation the user typed starts it."""
        try:
            body = self._body()
        except ValueError:
            body = None
        if body != {"confirm": RESET_CONFIRM}:
            return self._json(400, {"error": "confirmation_required"})
        self._json(*self.server.reset())
