"""A local ACP agent behind the shared product-facing stream contract."""
from dataclasses import dataclass, field
import math
from pathlib import Path
import sys

from tool_gateway.policy import POLICY

from .acp_agents import search_path
from .transport import HarnessError, ManagedClaudeSession


@dataclass(frozen=True)
class AcpConfig:
    state_dir: str | Path
    model: str
    agent_id: str
    agent_command: tuple | list
    agent_env: dict = field(default_factory=dict, repr=False)
    session_meta: dict | None = None
    mode: str | None = None
    permission_timeout: float = POLICY.window("exact_call")
    effort: str | None = None
    api_key: str = field(default="", repr=False)
    python: str = sys.executable
    startup_timeout: float = 120.0
    tool_timeout: float = 210.0
    runtime_source: str = "local"
    # The agent owns its credentials.
    auth_mode: str = field(default="existing_login", init=False)
    backend: str = field(default="acp", init=False)
    # The directory the harness's own tools work in; native_tools False: the harness offers none of them.
    workspace_dir: str = field(kw_only=True)
    native_tools: bool = field(kw_only=True)

    def validate(self, require_key=True):
        if self.effort not in (None, "low", "medium", "high"): raise ValueError("invalid_reasoning_effort")
        if self.runtime_source != "local":
            raise ValueError("invalid_runtime_source")
        if not isinstance(self.agent_id, str) or not self.agent_id:
            raise ValueError("acp_agent_missing")
        command = self.agent_command
        if not isinstance(command, (list, tuple)) or not command or not all(isinstance(a, str) for a in command):
            raise ValueError("invalid_agent_command")
        if not Path(command[0]).is_absolute():
            raise ValueError("agent_command_must_be_absolute")
        if not isinstance(self.agent_env, dict) or not all(
                isinstance(k, str) and isinstance(v, str) for k, v in self.agent_env.items()):
            raise ValueError("invalid_agent_env")
        if self.session_meta is not None and not isinstance(self.session_meta, dict):
            raise ValueError("invalid_session_meta")
        if self.mode is not None and not isinstance(self.mode, str):
            raise ValueError("invalid_acp_mode")
        # Empty: the agent's own model.
        if not isinstance(self.model, str) or len(self.model) > 256:
            raise ValueError("invalid_model")
        if not isinstance(self.workspace_dir, str) or not Path(self.workspace_dir).is_absolute():
            raise ValueError("workspace_dir_must_be_absolute")
        if type(self.native_tools) is not bool:
            raise ValueError("invalid_native_tools")
        for value in (self.startup_timeout, self.tool_timeout, self.permission_timeout):
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
                raise ValueError("invalid_budget")
        if not Path(self.python).is_absolute():
            raise ValueError("python_path_must_be_absolute")
        return self

    def wire(self):
        self.validate(require_key=False)
        # agentd's PATH plus the usual install directories; `#!/usr/bin/env node` agents need them.
        env = {"PATH": search_path(), **self.agent_env}
        return {"state_dir": str(Path(self.state_dir).resolve()), "agent_command": list(self.agent_command),
                "agent_env": env, "model": self.model, "session_meta": self.session_meta, "mode": self.mode,
                "tool_timeout": self.tool_timeout, "permission_timeout": self.permission_timeout, "effort": self.effort,
                "workspace_dir": self.workspace_dir, "native_tools": self.native_tools}

    def public(self):
        return {"backend": self.backend, "runtime_source": self.runtime_source, "auth_mode": self.auth_mode,
                "agent_id": self.agent_id, "model": self.model, "protocol": "acp-stdio", "cost_limit_supported": False}


class ManagedAcpSession(ManagedClaudeSession):
    # The runner may spend 2 s on session/close and 1 s more waiting for the agent to exit.
    CLOSE_WAIT = 5

    def __init__(self, config: AcpConfig, tool_definitions=None, tool_handler=None, permission_handler=None, *,
                 runner_path=None, on_auth=None):
        super().__init__(config, tool_definitions, tool_handler, permission_handler,
                         runner_path=runner_path or Path(__file__).with_name("acp_runner.py"))
        # (bool) -> None: whether a session start got past the agent's authentication.
        self.on_auth = on_auth

    def _ensure(self, system_prompt):
        try:
            ready = super()._ensure(system_prompt)
        except HarnessError as error:
            if error.code == "acp_auth_required" and self.on_auth:
                self.on_auth(False)
            raise
        if self.on_auth:
            self.on_auth(True)
        return ready

    def stream(self, *args, **kwargs):
        # The agent may accept session/new and still reject session/prompt for its login.
        try:
            yield from super().stream(*args, **kwargs)
        except HarnessError as error:
            if error.code == "acp_auth_required":
                if self.on_auth:
                    self.on_auth(False)
                self.close()
            raise
