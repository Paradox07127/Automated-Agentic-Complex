"""Product runtime settings. Credentials remain in the existing model settings."""
import json
import math
import os
from pathlib import Path
import threading

from brain import language
from fsutil import atomic_write_json
from models.model_auth import read_json, ModelError
from infra.paths import character_runtime
from infra.tokens import ensure_state_dir


DEFAULTS = {"backend": "pi", "runtime_source": "bundled", "executable": None,
            "auth_source": "existing_login", "provider": "",
            "model": "", "max_budget_usd": 1.0,
            "scope_id": None, "interactive_tools": True, "history_retention": "keep", "web_access": "off",
            "routes": {}, "acp_agent": None, "acp_launcher": "local", "workspace_dir": None,
            "reply_language": "auto", "pi_tool_approval": True}
# Purposes `routes` may give their own kernel; a purpose without an entry runs on the main config.
ROUTES = ("chat", "background", "judge", "understand", "memory", "computer")
EFFORTS = (None, "inherit", "low", "medium", "high")


def _acp_registry_ids():
    from character_agent.harness.acp_agents import registry
    return {agent["id"] for agent in registry()["agents"]}


# history_retention -> seconds that trace events, run items and the character state log are kept; None keeps all
RETENTION = {"keep": None, "7d": 7 * 86400, "30d": 30 * 86400}


class RuntimeSettings:
    def __init__(self, state_dir):
        self.directory = Path(state_dir)
        self.path = character_runtime(self.directory)
        self.lock = threading.RLock()
        self.data = dict(DEFAULTS)
        self.error = None
        self.saved = self.path.exists()
        if self.saved:
            try:
                data = read_json(self.path, DEFAULTS)
                self.data = self.validate(data)
            except (OSError, ValueError, TypeError, ModelError):
                self.error = "runtime_settings_unreadable"

    @staticmethod
    def validate(data):
        if not isinstance(data, dict) or set(data) - set(DEFAULTS):
            raise ValueError("invalid_runtime_settings")
        result = {**DEFAULTS, **data}
        if result['web_access'] not in ('off', 'search', 'search_and_fetch'):
            raise ValueError('invalid_web_access')
        if result["backend"] not in ("codex", "pi", "acp", "claude"):
            raise ValueError("invalid_runtime_backend")
        if result["runtime_source"] not in ("bundled", "local"):
            raise ValueError("invalid_runtime_source")
        if result["backend"] in ("codex", "acp", "claude") and result["runtime_source"] != "local":
            raise ValueError("invalid_runtime_source")
        if result["auth_source"] not in ("existing_login", "api_key", "product_login", "local_no_auth"):
            raise ValueError("invalid_auth_source")
        if result["auth_source"] == "local_no_auth" and result["backend"] != "pi":
            raise ValueError("local_no_auth_requires_pi")
        if not isinstance(result["provider"], str) or len(result["provider"]) > 128 or \
                any(c.isspace() for c in result["provider"]):
            raise ValueError("invalid_provider")
        if result["backend"] == "codex" and result["provider"] not in ("", "openai"):
            raise ValueError("provider_not_supported_by_harness")
        if result["backend"] == "claude":
            # The CLI owns its login and its Anthropic connection.
            if result["provider"] not in ("", "anthropic"):
                raise ValueError("provider_not_supported_by_harness")
            if result["auth_source"] != "existing_login":
                raise ValueError("unsupported_auth_source")
        if result["acp_launcher"] not in ("local", "npx", "uvx"):
            raise ValueError("invalid_acp_launcher")
        if (result["acp_agent"] is not None or result["backend"] == "acp") and (
                not isinstance(result["acp_agent"], str) or result["acp_agent"] not in _acp_registry_ids()):
            raise ValueError("invalid_acp_agent")
        if result["backend"] == "acp":
            # The ACP agent owns its credentials and model connection.
            if result["provider"] != "":
                raise ValueError("provider_not_supported_by_harness")
            if result["auth_source"] != "existing_login":
                raise ValueError("unsupported_auth_source")
        routes = result["routes"]
        if not isinstance(routes, dict) or set(routes) - set(ROUTES):
            raise ValueError("invalid_routes")
        for entry in routes.values():
            if not isinstance(entry, dict) or set(entry) != {"backend", "acp_agent", "model", "effort"}:
                raise ValueError("invalid_routes")
            if entry["backend"] not in ("codex", "pi", "acp", "claude"):
                raise ValueError("invalid_route_backend")
            if (entry["acp_agent"] is not None or entry["backend"] == "acp") and (
                    not isinstance(entry["acp_agent"], str) or entry["acp_agent"] not in _acp_registry_ids()):
                raise ValueError("invalid_acp_agent")
            # None: the main model on the main kernel, else the kernel's own.
            model = entry["model"]
            if model is not None and (not isinstance(model, str) or not 1 <= len(model) <= 128 or any(c.isspace() for c in model)):
                raise ValueError("invalid_route_model")
            # None: the product default (low for chat on codex, the purpose's own for semantic work, else the
            # harness's own); 'inherit': always the harness's own.
            if entry["effort"] not in EFFORTS:
                raise ValueError("invalid_route_effort")
        executable = result["executable"]
        if executable is not None and (not isinstance(executable, str) or not os.path.isabs(executable)
                                       or len(executable) > 4096):
            raise ValueError("invalid_runtime_executable")
        workspace = result["workspace_dir"]
        if workspace is not None and (not isinstance(workspace, str) or not os.path.isabs(workspace)
                                      or len(workspace) > 4096):
            raise ValueError("invalid_workspace_dir")
        if not isinstance(result["model"], str) or \
                len(result["model"]) > 128 or any(c.isspace() for c in result["model"]):
            raise ValueError("invalid_runtime_model")
        if result["scope_id"] is not None and (not isinstance(result["scope_id"], str) or
                                               not 1 <= len(result["scope_id"]) <= 128):
            raise ValueError("invalid_scope_id")
        for flag in ("interactive_tools", "pi_tool_approval"):
            if type(result[flag]) is not bool: raise ValueError("invalid_" + flag)
        if not isinstance(result["history_retention"], str) or result["history_retention"] not in RETENTION:
            raise ValueError("invalid_history_retention")
        if not isinstance(result["reply_language"], str) or result["reply_language"] not in language.SETTINGS:
            raise ValueError("invalid_reply_language")
        budget = result["max_budget_usd"]
        if type(budget) not in (int, float) or not math.isfinite(budget) or not 0 < budget <= 20:
            raise ValueError("invalid_max_budget_usd")
        return result

    @staticmethod
    def route(config, purpose):
        """The kernel config `purpose` (one of ROUTES) runs on: the main config with its routes entry applied.
        `_turn_effort` is the session's reasoning effort; None leaves the harness's own."""
        entry = config["routes"].get(purpose)
        value, effort = dict(config), None
        if entry is not None:
            effort = entry["effort"]
            if entry["backend"] != config["backend"]:
                # Source, executable, credential and model of the main config belong to the main kernel.
                value.update(backend=entry["backend"], runtime_source="bundled" if entry["backend"] == "pi" else "local",
                             executable=None, auth_source="existing_login", provider="", model="")
            if entry["backend"] == "acp":
                if (config["backend"], config["acp_agent"]) != ("acp", entry["acp_agent"]):
                    # The routes table offers only local agents.
                    value["acp_launcher"] = "local"
                value["acp_agent"] = entry["acp_agent"]
            if entry["model"] is not None:
                value["model"] = entry["model"]
        value["_turn_effort"] = None if effort == "inherit" else effort or (
            "low" if purpose == "chat" and value["backend"] == "codex" else None)
        return value

    def snapshot(self):
        with self.lock:
            return dict(self.data)

    def workspace(self):
        """The directory bridged harnesses work in: the chosen one, else ~/AgenticComplex; created when missing."""
        chosen = self.snapshot()["workspace_dir"]
        path = Path(chosen) if chosen else Path.home() / "AgenticComplex"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def save(self, data):
        value = self.validate(data)
        with self.lock:
            if self.path.is_symlink():
                raise ValueError("runtime_settings_symlink")
            ensure_state_dir(self.path.parent)
            atomic_write_json(self.path, value, ensure_ascii=False)
            self.data, self.error, self.saved = value, None, True
        return self.snapshot()

    def apply_default(self, values):
        """Replace the unsaved in-memory choice; never writes the configuration file."""
        value = self.validate(values)
        with self.lock:
            if not self.saved:
                self.data = value

    def credential(self, models=None):
        """Read only the explicitly configured official Anthropic credential, not CLI OAuth."""
        if models is not None:
            config = models.snapshot().get("backends", {}).get("anthropic", {})
        else:
            config = {}
        if config.get("base_url", "https://api.anthropic.com").rstrip("/") != "https://api.anthropic.com":
            raise ValueError("unsupported_anthropic_endpoint")
        if config.get("api_key"):
            return config["api_key"]
        raise ValueError("missing_anthropic_api_key")
