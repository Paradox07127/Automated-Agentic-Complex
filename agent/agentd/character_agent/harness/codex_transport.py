"""Local Codex backend behind the shared product-facing stream contract."""
from dataclasses import dataclass, field
import math
from pathlib import Path
import sys
from urllib.parse import urlsplit

from .transport import ManagedClaudeSession

@dataclass(frozen=True)
class CodexConfig:
    state_dir: str | Path
    model: str
    api_key: str = field(default="", repr=False)
    python: str = sys.executable
    cli_path: str | None = None
    startup_timeout: float = 30.0
    tool_timeout: float = 210.0
    persist_session: bool = False
    base_url: str = "https://api.openai.com/v1"
    auth_mode: str = "api_key"
    # product_login: Agentic Complex's own profile directory of the CLI; None with the other auth modes.
    native_home: str | None = None
    runtime_source: str = "local"
    effort: str | None = None
    backend: str = field(default="codex", init=False)
    # The directory the harness's own tools work in; native_tools False: the harness offers none of them.
    workspace_dir: str = field(kw_only=True)
    native_tools: bool = field(kw_only=True)

    def validate(self, require_key=True):
        if self.effort not in (None, 'low', 'medium', 'high'): raise ValueError('invalid_reasoning_effort')
        if self.auth_mode not in ("api_key", "existing_login", "product_login"):
            raise ValueError("unsupported_auth_source")
        if self.runtime_source != "local":
            raise ValueError("invalid_runtime_source")
        if require_key and self.auth_mode == "api_key" and (not isinstance(self.api_key, str) or not self.api_key.strip()):
            raise ValueError("credentials_missing")
        if not isinstance(self.model, str) or not self.model.strip() or len(self.model) > 256:
            raise ValueError("invalid_model")
        if not isinstance(self.workspace_dir, str) or not Path(self.workspace_dir).is_absolute():
            raise ValueError("workspace_dir_must_be_absolute")
        if type(self.native_tools) is not bool:
            raise ValueError("invalid_native_tools")
        for value in (self.startup_timeout, self.tool_timeout):
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
                raise ValueError("invalid_budget")
        url = urlsplit(self.base_url)
        if url.username or url.password or url.query or url.fragment or not url.hostname or (
                url.scheme != "https" and not (url.scheme == "http" and url.hostname in ("127.0.0.1", "localhost", "::1"))):
            raise ValueError("invalid_api_url")
        if not Path(self.python).is_absolute():
            raise ValueError("python_path_must_be_absolute")
        if not self.cli_path:
            raise ValueError("local_cli_path_required")
        if not Path(self.cli_path).is_absolute():
            raise ValueError("cli_path_must_be_absolute")
        if self.auth_mode != "api_key" and self.base_url != "https://api.openai.com/v1":
            raise ValueError("native_login_requires_native_provider")
        if self.persist_session:
            raise ValueError("codex_native_session_persistence_not_supported")
        return self

    def wire(self):
        self.validate(require_key=False)
        return {"state_dir": str(Path(self.state_dir).resolve()), "model": self.model,
                "api_key": self.api_key, "cli_path": self.cli_path,
                "tool_timeout": self.tool_timeout, "persist_session": False,
                "base_url": self.base_url, "auth_mode": self.auth_mode, "runtime_source": self.runtime_source,
                "effort": self.effort, "workspace_dir": self.workspace_dir, "native_tools": self.native_tools}

    def public(self):
        return {"backend": self.backend, "runtime_source": self.runtime_source, "auth_mode": self.auth_mode,
                "model": self.model, "has_key": bool(self.api_key), "persist_session": False,
                "protocol": "app-server-stdio", "experimental": True, "cost_limit_supported": False}


class ManagedCodexSession(ManagedClaudeSession):
    def __init__(self, config: CodexConfig, tool_definitions=None, tool_handler=None, permission_handler=None, *,
                 runner_path=None):
        super().__init__(config, tool_definitions, tool_handler, permission_handler,
                         runner_path=runner_path or Path(__file__).with_name("codex_runner.py"))
