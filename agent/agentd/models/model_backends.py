"""pi's provider credentials and default connection; every model call runs as a character kernel session."""
import copy
from pathlib import Path
import threading
import time
from urllib.parse import urlparse

import httpx

from fsutil import atomic_write_json
from models.model_auth import ChatGPTAuth, ModelError, RESOURCE, read_json
import re

from character_agent.harness.pi_config import THINKING_LEVELS
from character_agent.services.providers import DEEPSEEK_BASE_URL, XAI_BASE_URL
from infra import service_ensure
from infra.secrets import setting_secret
from infra.paths import model_settings
from infra.tokens import ensure_state_dir

_BUDGET = {"max_output_tokens": 4096, "reasoning_effort": ""}
DEFAULTS = {
    "anthropic": {"model": "claude-haiku-5-5", "base_url": "https://api.anthropic.com", **_BUDGET},
    "deepseek": {"model": "deepseek-flash", "base_url": DEEPSEEK_BASE_URL, **_BUDGET},
    "xai": {"model": "", "base_url": XAI_BASE_URL, **_BUDGET},
    "openai": {"model": "", "base_url": RESOURCE, **_BUDGET},
    # Its address is agentd's --llm-url. supports_images, context_window, reasoning: Pi's defaults for a model
    # without a catalog entry.
    "compatible": {"model": "", **_BUDGET,
                   "supports_images": False, "context_window": 128000, "reasoning": False},
    # Another provider of Pi's catalog, named by `pi_provider`.
    "pi_catalog": {"model": "", "base_url": "", "pi_provider": "", **_BUDGET},
    "chatgpt": {"model": "", "base_url": RESOURCE, **_BUDGET},
}
# Services that list their own /models; Pi's offline catalog lists the others.
LISTS_OWN_MODELS = ("compatible", "chatgpt")
LIMITS = {"subscription_sharing_usage_limit_exceeded", "subscription_sharing_usage_unavailable"}


def check_response(response):
    if response.is_success:
        return
    code = None
    try:
        code = response.json().get("error", {}).get("code")
    except (ValueError, AttributeError):
        pass
    if code in LIMITS:
        raise ModelError(code)
    raise ModelError({401: "credentials_rejected", 403: "model_access_denied", 429: "usage_limit"}.get(
        response.status_code, "provider_http_" + str(response.status_code)))


class ModelSettings:
    def __init__(self, directory, secrets, llm_url=None, llm_ensurer=None):
        """llm_url: --llm-url, the compatible API's address, None when it is off; llm_ensurer: the ServiceEnsurer that
        starts that API before each use, or None."""
        self.secrets = secrets
        self.llm_url, self.llm_ensurer = llm_url, llm_ensurer
        self.directory = Path(directory)
        self.path = model_settings(self.directory)
        self.lock = threading.RLock()
        self.data, self.error = self._load()
        self.auth = ChatGPTAuth(directory, secrets)

    def _load(self):
        error, stored = None, None
        try:
            stored = read_json(self.path, None)
        except (ModelError, ValueError) as failure:
            # Run on defaults with model calls disabled until the file reads again or save() rewrites it.
            error = str(failure) if isinstance(failure, ModelError) else "settings_unreadable"
        data = {"provider": "chatgpt", "backends": copy.deepcopy(DEFAULTS)}
        if stored is not None:
            data["provider"] = stored["provider"]
            for provider, config in data["backends"].items():
                fields = (*config, "key_refs")
                saved = stored["backends"].get(provider, {})
                config.update({field: saved[field] for field in fields if field in saved})
        return data, error

    def _recover(self):
        with self.lock:
            if self.error:
                data, error = self._load()
                if error is None:
                    self.data, self.error = data, None

    def _key(self, provider, config):
        ref = config.get("key_refs", {}).get(config.get("pi_provider", provider))
        value = self.secrets.get(ref) if ref else None
        return value.decode() if value else ""

    def snapshot(self):
        with self.lock:
            data = copy.deepcopy(self.data)
            for provider, config in data["backends"].items():
                key = self._key(provider, config)
                config.pop("key_refs", None)
                if key:
                    config["api_key"] = key
            return data

    def public(self):
        self._recover()
        data = self.snapshot()
        for config in data["backends"].values():
            config["has_key"] = bool(config.pop("api_key", None))
        return {**data, "chatgpt": self.auth.state(), "error": self.error}

    def save(self, body):
        """A body with `api_key` or `clear_key` and none of the connection's fields (`pi_provider` picks Pi's catalog slot; unknown
        keys are ignored) writes that one key slot,
        leaving the active provider and Pi's catalog choice as they are; any other body also makes its provider the active one."""
        if not isinstance(body, dict) or body.get("provider") not in DEFAULTS:
            raise ModelError("invalid_provider")
        provider = body["provider"]
        key_only = ("api_key" in body or body.get("clear_key") is True) and not any(key in body for key in (
            "model", "base_url", "max_output_tokens", "reasoning_effort", "supports_images", "context_window", "reasoning"))
        with self.lock:
            updated = copy.deepcopy(self.data)
            config = updated["backends"][provider]
            host = urlparse(config.get("base_url", "")).hostname
            slot = config.get("pi_provider", provider)
            if provider == "pi_catalog" and "pi_provider" in body:
                name = body["pi_provider"]
                if not isinstance(name, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}", name):
                    raise ModelError("invalid_pi_provider")
                slot = name
                if name != config["pi_provider"] and not key_only:
                    # Model ids belong to one provider.
                    config.update(pi_provider=name, model="")
            key_value = None
            if provider == "compatible" and "base_url" in body:
                raise ModelError("invalid_base_url")
            for key in ("model", "base_url", "api_key"):
                if key in body:
                    if not isinstance(body[key], str) or len(body[key]) > (8192 if key == "api_key" else 1024):
                        raise ModelError("invalid_" + key)
                    if key == "api_key":
                        key_value = body[key].strip()
                    else:
                        config[key] = body[key].strip()
            if "max_output_tokens" in body:
                budget = body["max_output_tokens"]
                if type(budget) is not int or not 128 <= budget <= 32768:
                    raise ModelError("invalid_output_budget")
                config["max_output_tokens"] = budget
            if "reasoning_effort" in body:
                if body["reasoning_effort"] not in ("", *THINKING_LEVELS):
                    raise ModelError("invalid_reasoning_effort")
                config["reasoning_effort"] = body["reasoning_effort"]
            if provider == "compatible" and "supports_images" in body:
                if type(body["supports_images"]) is not bool:
                    raise ModelError("invalid_supports_images")
                config["supports_images"] = body["supports_images"]
            if provider == "compatible" and "context_window" in body:
                if type(body["context_window"]) is not int or not 1024 <= body["context_window"] <= 10_000_000:
                    raise ModelError("invalid_context_window")
                config["context_window"] = body["context_window"]
            if provider == "compatible" and "reasoning" in body:
                if type(body["reasoning"]) is not bool:
                    raise ModelError("invalid_reasoning")
                config["reasoning"] = body["reasoning"]
            if body.get("clear_key") is True:
                key_value = ""
            if provider == "chatgpt":
                config["base_url"] = RESOURCE  # OAuth tokens only ever go to the public OpenAI endpoint
                key_value = None
            if provider == "deepseek":
                config["base_url"] = DEEPSEEK_BASE_URL
            if provider == "pi_catalog":
                # Pi's catalog has each provider's address; a key goes to the chosen provider's own slot.
                if key_value is not None and not slot:
                    raise ModelError("invalid_pi_provider")
                config["base_url"] = ""
            elif provider != "compatible":
                parsed = urlparse(config["base_url"])
                if parsed.username or parsed.password or parsed.query or parsed.fragment or not parsed.hostname or (
                        parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1", "::1"))):
                    raise ModelError("invalid_base_url")
                if parsed.hostname != host and "api_key" not in body:
                    key_value = ""  # a stored key never follows the URL to another host
                config["base_url"] = config["base_url"].rstrip("/")
            if not key_only:
                updated["provider"] = provider
            ensure_state_dir(self.path.parent)
            old_ref = config.get("key_refs", {}).get(slot)
            with setting_secret(self.secrets, old_ref, "provider-", None if key_value is None else key_value.encode()) as ref:
                if ref:
                    config.setdefault("key_refs", {})[slot] = ref
                elif old_ref:
                    config["key_refs"].pop(slot)
                atomic_write_json(self.path, updated, ensure_ascii=False)
            self.data = updated
            self.error = None
        return self.public()

    def clear_key(self, slot):
        """Remove the key saved in slot, a provider id of DEFAULTS."""
        with self.lock:
            updated = copy.deepcopy(self.data)
            refs = updated["backends"][slot].get("key_refs", {})
            if slot not in refs:
                return
            with setting_secret(self.secrets, refs.pop(slot), "provider-", b""):
                atomic_write_json(self.path, updated, ensure_ascii=False)
            self.data = updated

    def connection(self):
        """(provider, config, key) of the saved provider."""
        self._recover()
        if self.error:
            raise ModelError(self.error)
        with self.lock:
            provider = self.data["provider"]
            config = self.data["backends"][provider].copy()
            key = self._key(provider, config)
            config.pop("key_refs", None)
        if provider == "chatgpt":
            key = self.auth.access_token()
        if not key and provider != "compatible":
            raise ModelError("missing_api_key")
        return provider, config, key

    def llm_ready(self, cancelled=lambda: False, timeout=None):
        """Whether the compatible API can take a request: True without an ensurer, else once its ensure answered
        ready within timeout seconds (None: the ensure's own limit). False soon after cancelled() turns true."""
        if self.llm_ensurer is None:
            return True
        self.llm_ensurer.request()
        deadline = time.monotonic() + (service_ensure.TIMEOUT if timeout is None else min(timeout, service_ensure.TIMEOUT))
        while not cancelled():
            step = min(0.1, max(0.0, deadline - time.monotonic()))
            waited = time.monotonic()
            if self.llm_ensurer.wait_ready(step):
                return True
            # wait_ready answers False before its timeout only once the ensure ended without ready; half a step
            # leaves room for timer slack.
            if time.monotonic() >= deadline or time.monotonic() - waited < step / 2:
                return False
        return False

    def catalog(self, pi_models):
        """{providers, models} of the saved service. Pi's providers: `pi_models(Pi provider id or None)`, the SDK's
        offline catalog. A compatible API or ChatGPT: its own /models, without Pi's providers or model capabilities."""
        self._recover()
        if self.error:
            raise ModelError(self.error)
        with self.lock:
            data = self.data
        if data["provider"] not in LISTS_OWN_MODELS:
            pi = data["backends"]["pi_catalog"]["pi_provider"] or None if data["provider"] == "pi_catalog" else data["provider"]
            return pi_models(pi)
        provider, config, key = self.connection()
        if provider == "compatible":
            if self.llm_url is None:
                raise ModelError("llm_service_off")
            if not self.llm_ready():
                raise ModelError("llm_ensure_failed")
        url = self.llm_url if provider == "compatible" else config["base_url"]
        headers = {"Authorization": "Bearer " + key} if key else {}
        response = httpx.get(url + "/models", headers=headers, timeout=20)
        check_response(response)
        body = response.json()
        rows = body.get("models", []) if provider == "chatgpt" else body.get("data", [])
        unknown = dict.fromkeys(("context_window", "max_tokens", "input", "reasoning", "thinking_levels", "priced"))
        return {"providers": [], "models": [{"id": m["slug"] if provider == "chatgpt" else m["id"],
                                             "name": m.get("display_name", m.get("id", m.get("slug", ""))), **unknown}
                                            for m in rows if provider != "chatgpt" or m.get("visibility") == "list"]}
