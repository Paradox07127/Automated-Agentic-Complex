"""pi's provider credentials and default connection; every model call runs as a character kernel session."""
import copy
from pathlib import Path
import threading
from urllib.parse import urlparse

import httpx

from fsutil import atomic_write_json
from models.model_auth import ChatGPTAuth, ModelError, RESOURCE, read_json
import re

from character_agent.harness.pi_config import THINKING_LEVELS
from character_agent.services.providers import DEEPSEEK_BASE_URL, XAI_BASE_URL
from infra.paths import model_settings
from infra.tokens import ensure_state_dir

_BUDGET = {"max_output_tokens": 4096, "reasoning_effort": ""}
DEFAULTS = {
    "anthropic": {"model": "claude-haiku-5-5", "base_url": "https://api.anthropic.com", **_BUDGET},
    "deepseek": {"model": "deepseek-flash", "base_url": DEEPSEEK_BASE_URL, **_BUDGET},
    "xai": {"model": "", "base_url": XAI_BASE_URL, **_BUDGET},
    "openai": {"model": "", "base_url": RESOURCE, **_BUDGET},
    # supports_images, context_window, reasoning: Pi's defaults for a model without a catalog entry.
    "compatible": {"model": "", "base_url": "http://127.0.0.1:11434/v1", **_BUDGET,
                   "supports_images": False, "context_window": 128000, "reasoning": False},
    # Another provider of Pi's catalog, named by `pi_provider`; `keys` holds one key per provider.
    "pi_catalog": {"model": "", "base_url": "", "pi_provider": "", "keys": {}, **_BUDGET},
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
    def __init__(self, directory):
        self.directory = Path(directory)
        self.path = model_settings(self.directory)
        self.lock = threading.RLock()
        self.data, self.error = self._load()
        self.auth = ChatGPTAuth(directory)

    def _load(self):
        error, stored = None, None
        try:
            stored = read_json(self.path, None)
        except (ModelError, ValueError) as failure:
            # Run on defaults with model calls disabled until the file reads again or save() rewrites it.
            error = str(failure) if isinstance(failure, ModelError) else "settings_unreadable"
        data = stored if stored is not None else {"provider": "chatgpt", "backends": copy.deepcopy(DEFAULTS)}
        return data, error

    def _recover(self):
        with self.lock:
            if self.error:
                data, error = self._load()
                if error is None:
                    self.data, self.error = data, None

    def snapshot(self):
        with self.lock:
            return copy.deepcopy(self.data)

    def public(self):
        self._recover()
        data = self.snapshot()
        for provider, config in data["backends"].items():
            config["has_key"] = self._keyed(provider, config)
            config.pop("api_key", None)
            config.pop("keys", None)
        return {**data, "chatgpt": self.auth.state(), "error": self.error}

    def _keyed(self, provider, config):
        if provider == "pi_catalog":
            return bool(config["keys"].get(config["pi_provider"]))
        return bool(config.get("api_key"))

    def save(self, body):
        if not isinstance(body, dict) or body.get("provider") not in DEFAULTS:
            raise ModelError("invalid_provider")
        provider = body["provider"]
        with self.lock:
            updated = self.snapshot()
            config = updated["backends"][provider]
            host = urlparse(config.get("base_url", "")).hostname
            if provider == "pi_catalog" and "pi_provider" in body:
                name = body["pi_provider"]
                if not isinstance(name, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}", name):
                    raise ModelError("invalid_pi_provider")
                if name != config["pi_provider"]:
                    # Model ids belong to one provider.
                    config.update(pi_provider=name, model="")
            for key in ("model", "base_url", "api_key"):
                if key in body:
                    if not isinstance(body[key], str) or len(body[key]) > (8192 if key == "api_key" else 1024):
                        raise ModelError("invalid_" + key)
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
                config.pop("api_key", None)
            if provider == "chatgpt":
                config["base_url"] = RESOURCE  # OAuth tokens only ever go to the public OpenAI endpoint
                config.pop("api_key", None)
            if provider == "deepseek":
                config["base_url"] = DEEPSEEK_BASE_URL
            if provider == "pi_catalog":
                # Pi's catalog has each provider's address; a key goes to the chosen provider's own slot.
                key = config.pop("api_key", None)
                if (key is not None or body.get("clear_key") is True) and not config["pi_provider"]:
                    raise ModelError("invalid_pi_provider")
                if key is not None:
                    config["keys"][config["pi_provider"]] = key
                elif body.get("clear_key") is True:
                    config["keys"].pop(config["pi_provider"], None)
                config["base_url"] = ""
            else:
                parsed = urlparse(config["base_url"])
                if parsed.username or parsed.password or parsed.query or parsed.fragment or not parsed.hostname or (
                        parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1", "::1"))):
                    raise ModelError("invalid_base_url")
                if parsed.hostname != host and "api_key" not in body:
                    config.pop("api_key", None)  # a stored key never follows the URL to another host
                config["base_url"] = config["base_url"].rstrip("/")
            updated["provider"] = provider
            ensure_state_dir(self.path.parent)
            atomic_write_json(self.path, updated, ensure_ascii=False)
            self.data = updated
            self.error = None
        return self.public()

    def connection(self):
        """(provider, config, key) of the saved provider."""
        self._recover()
        if self.error:
            raise ModelError(self.error)
        data = self.snapshot()
        provider = data["provider"]
        config = data["backends"][provider]
        key = config.get("api_key", "")
        if provider == "pi_catalog":
            key = config["keys"].get(config["pi_provider"], "")
        elif provider == "chatgpt":
            key = self.auth.access_token()
        if not key and provider != "compatible":
            raise ModelError("missing_api_key")
        return provider, config, key

    def catalog(self, pi_models):
        """{providers, models} of the saved service. Pi's providers: `pi_models(Pi provider id or None)`, the SDK's
        offline catalog. A compatible API or ChatGPT: its own /models, without Pi's providers or model capabilities."""
        self._recover()
        if self.error:
            raise ModelError(self.error)
        data = self.snapshot()
        if data["provider"] not in LISTS_OWN_MODELS:
            pi = data["backends"]["pi_catalog"]["pi_provider"] or None if data["provider"] == "pi_catalog" else data["provider"]
            return pi_models(pi)
        provider, config, key = self.connection()
        headers = {"Authorization": "Bearer " + key} if key else {}
        response = httpx.get(config["base_url"] + "/models", headers=headers, timeout=20)
        check_response(response)
        body = response.json()
        rows = body.get("models", []) if provider == "chatgpt" else body.get("data", [])
        unknown = dict.fromkeys(("context_window", "max_tokens", "input", "reasoning", "thinking_levels", "priced"))
        return {"providers": [], "models": [{"id": m["slug"] if provider == "chatgpt" else m["id"],
                                             "name": m.get("display_name", m.get("id", m.get("slug", ""))), **unknown}
                                            for m in rows if provider != "chatgpt" or m.get("visibility") == "list"]}
