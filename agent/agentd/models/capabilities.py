"""Capability snapshot: what agentd's existing state says each feature can do, without probing anything."""
import datetime
import time

from infra import plugins

MISSING = object()


def _item(state, reason=None):
    return {"state": state, "reason": reason}


def _chatgpt(auth):
    profile = next((p for p in auth["profiles"] if p["id"] == auth["active"]), None)
    if profile is None or not profile["connected"]:
        return "sign_in_required"
    return None if profile["sharing"] else "plan_usage_not_enabled"


def generation(models):
    public = models.public()
    if public["error"]:
        return _item("degraded", public["error"])
    provider = public["provider"]
    if provider == "chatgpt":
        missing = _chatgpt(public["chatgpt"])
        return _item("unavailable", missing) if missing else _item("configured")
    if provider == "compatible" and models.llm_url is None:
        return _item("unavailable", "llm_service_off")
    if provider != "compatible" and not public["backends"][provider]["has_key"]:
        return _item("unavailable", "missing_api_key")
    return _item("configured")


def voice(server):
    if server.speech is None:
        return _item("unavailable", "no_tts")
    if server.muted:
        return _item("configured", "muted")
    failed, last = server._speech_failed, server._tts_last
    # _speech_failed stays set; only a failure that is still the latest speech outcome counts.
    if failed and failed["reason"] and last and last["at"] == failed["at"]:
        return _item("degraded", failed["reason"])
    return _item("ready")


def collect(server):
    """GET /capabilities body: {"items": {name: {"state", "reason"}}, "at"}; reads only server's existing state."""
    unknown = _item("unknown", "not_running")
    models = getattr(server, "models", None)
    mouth = getattr(server, "mouth", MISSING)
    items = {
        "generation": unknown if models is None else generation(models),
        "mouth": unknown if mouth is MISSING else _item("unavailable", "no_llm") if mouth is None else _item("ready"),
        "voice": voice(server) if all(hasattr(server, name) for name in ("speech", "muted", "_speech_failed", "_tts_last"))
        else unknown,
    }
    personal = getattr(server, "character_agent", None)
    if personal is not None:
        items["personal_agent"] = personal.capability()
        items["generation"] = dict(items["personal_agent"])
    consent = getattr(server, "consent", None)
    if consent is not None:
        for kind, on in consent.snapshot()[0].items():
            items["share_" + kind] = _item("configured") if on else _item("unavailable", "off")
    at = datetime.datetime.fromtimestamp(time.time()).astimezone().isoformat(timespec="milliseconds")
    return {"items": items, "plugins": plugins.resolved.copy(), "at": at}
