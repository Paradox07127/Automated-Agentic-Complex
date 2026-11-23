"""The local Claude Code CLI behind the shared product-facing stream contract."""
from dataclasses import dataclass, field
import math
from pathlib import Path
import sys

from .transport import ManagedClaudeSession


@dataclass(frozen=True)
class ClaudeConfig:
    state_dir: str | Path
    # Empty: the CLI's own model.
    model: str
    api_key: str = field(default="", repr=False)
    python: str = sys.executable
    cli_path: str | None = None
    startup_timeout: float = 30.0
    tool_timeout: float = 210.0
    persist_session: bool = False
    # The CLI owns its login.
    auth_mode: str = "existing_login"
    # product_login: Agentic Complex's own profile directory of the CLI; None with the other auth modes.
    native_home: str | None = None
    runtime_source: str = "local"
    effort: str | None = None
    backend: str = field(default="claude", init=False)
    # The directory the harness's own tools work in; native_tools False: the harness offers none of them.
    workspace_dir: str = field(kw_only=True)
    native_tools: bool = field(kw_only=True)

    def validate(self, require_key=True):
        if self.effort not in (None, "low", "medium", "high"):
            raise ValueError("invalid_reasoning_effort")
        if self.auth_mode not in ("existing_login", "product_login"):
            raise ValueError("unsupported_auth_source")
        if self.runtime_source != "local":
            raise ValueError("invalid_runtime_source")
        if not isinstance(self.model, str) or len(self.model) > 256:
            raise ValueError("invalid_model")
        if not isinstance(self.workspace_dir, str) or not Path(self.workspace_dir).is_absolute():
            raise ValueError("workspace_dir_must_be_absolute")
        if type(self.native_tools) is not bool:
            raise ValueError("invalid_native_tools")
        for value in (self.startup_timeout, self.tool_timeout):
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
                raise ValueError("invalid_budget")
        if not Path(self.python).is_absolute():
            raise ValueError("python_path_must_be_absolute")
        if not self.cli_path:
            raise ValueError("local_cli_path_required")
        if not Path(self.cli_path).is_absolute():
            raise ValueError("cli_path_must_be_absolute")
        if self.persist_session:
            raise ValueError("claude_native_session_persistence_not_supported")
        return self

    def wire(self):
        self.validate(require_key=False)
        return {"state_dir": str(Path(self.state_dir).resolve()), "model": self.model, "cli_path": self.cli_path,
                "tool_timeout": self.tool_timeout, "effort": self.effort, "workspace_dir": self.workspace_dir,
                "native_tools": self.native_tools}

    def public(self):
        return {"backend": self.backend, "runtime_source": self.runtime_source, "auth_mode": self.auth_mode,
                "model": self.model, "protocol": "claude-stream-json", "cost_limit_supported": False}


class ManagedClaudeCodeSession(ManagedClaudeSession):
    def __init__(self, config: ClaudeConfig, tool_definitions=None, tool_handler=None, permission_handler=None, *,
                 runner_path=None):
        super().__init__(config, tool_definitions, tool_handler, permission_handler,
                         runner_path=runner_path or Path(__file__).with_name("claude_runner.py"))
