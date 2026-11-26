"""Pi SDK configuration. Provider credentials only cross the private pipe."""
from dataclasses import dataclass, field
import math
import os
from pathlib import Path
import re
import shutil
import sys
from urllib.parse import urlsplit

from infra.platform import child_environment

PI_VERSION = "1.4.0"
PI_NODE_MINIMUM = "22.19.0"
# The SDK's thinking levels; a model's own catalog entry narrows them.
THINKING_LEVELS = ("off", "minimal", "low", "medium", "high", "xhigh", "max")


def resolve_pi_runtime(site=None):
    """Return (Node executable, npm root): the packaged harness.pi site, else a source checkout's isolated
    .local tree with the system Node; ("", "") when neither is there.

    The site never falls back to a developer installation; a Pi CLI is not a Node executable.
    """
    if site is not None:
        root = Path(site).resolve()
        # The official Windows zip keeps node.exe at its root.
        node = root / "node" / "node.exe" if sys.platform == "win32" else root / "node" / "bin" / "node"
        return str(node), str(root / "pi-runtime")
    for parent in Path(__file__).resolve().parents:
        if (parent / "agent" / "agentd").is_dir() and (parent / ".local" / "pi-runtime" / "node_modules").is_dir():
            return shutil.which("node") or "", str(parent / ".local" / "pi-runtime")
    return "", ""


@dataclass(frozen=True)
class PiConfig:
    state_dir: str | Path
    provider: str
    model: str
    api_key: str = field(default="", repr=False)
    node: str = field(default_factory=lambda: resolve_pi_runtime()[0])
    runtime_dir: str = field(default_factory=lambda: resolve_pi_runtime()[1])
    # existing_login, like api_key: the key of the connection Endfield holds.
    auth_source: str = "api_key"
    base_url: str | None = None
    api: str | None = None
    supports_images: bool = False
    effort: str | None = None
    # The custom endpoint's model: output budget per call, context window, and whether it thinks.
    max_output_tokens: int = 4096
    context_window: int = 128000
    reasoning: bool = False
    max_turns: int = 24
    max_budget_usd: float = 1.0
    startup_timeout: float = 30.0
    tool_timeout: float = 210.0
    runtime_source: str = "bundled"
    # Pi's own tools work in workspace_dir; native_tools False keeps them off (semantic work).
    workspace_dir: str | Path | None = None
    native_tools: bool = False
    # An approval card before each bash, powershell, write and edit call; a refusal or timeout blocks the call.
    tool_approval: bool = True
    permission_timeout: float = 180.0
    # With native_tools: the user's own Pi agent directory (its mcp.json) and the Skill directories Pi reads.
    user_agent_dir: str | Path | None = None
    skill_dirs: tuple = ()

    def validate(self, require_key=True):
        if self.auth_source not in ("api_key", "existing_login", "none"):
            raise ValueError("unsupported_auth_source")
        if not isinstance(self.provider, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}", self.provider):
            raise ValueError("invalid_provider")
        if not isinstance(self.model, str) or not self.model.strip() or len(self.model) > 256 or any(ord(c) < 32 for c in self.model):
            raise ValueError("invalid_model")
        if self.api not in (None, "openai-completions", "openai-responses", "anthropic-messages"):
            raise ValueError("unsupported_pi_api")
        if type(self.supports_images) is not bool:
            raise ValueError('invalid_supports_images')
        if self.effort is not None and self.effort not in THINKING_LEVELS:
            raise ValueError("invalid_reasoning_effort")
        if type(self.max_output_tokens) is not int or not 128 <= self.max_output_tokens <= 32768:
            raise ValueError("invalid_output_budget")
        if type(self.context_window) is not int or not 1024 <= self.context_window <= 10_000_000:
            raise ValueError("invalid_context_window")
        if type(self.reasoning) is not bool:
            raise ValueError("invalid_reasoning")
        local = False
        if self.base_url:
            url = urlsplit(self.base_url)
            local = url.hostname in ("127.0.0.1", "localhost", "::1")
            if url.username or url.password or url.query or url.fragment or not url.hostname or (url.scheme != "https" and not (url.scheme == "http" and local)):
                raise ValueError("invalid_api_url")
        if self.auth_source == "none" and not (self.base_url and local):
            raise ValueError("unauthenticated_provider_requires_loopback")
        if self.auth_source == "existing_login" and self.base_url:
            raise ValueError("native_login_requires_native_provider")
        if require_key and self.auth_source != "none" and (not isinstance(self.api_key, str) or not self.api_key.strip()):
            raise ValueError("credentials_missing")
        if isinstance(self.max_turns, bool) or not isinstance(self.max_turns, int) or not 1 <= self.max_turns <= 100:
            raise ValueError("invalid_max_turns")
        if type(self.native_tools) is not bool or type(self.tool_approval) is not bool:
            raise ValueError("invalid_native_tools")
        for value in (self.max_budget_usd, self.startup_timeout, self.tool_timeout, self.permission_timeout):
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
                raise ValueError("invalid_budget")
        for path in (self.node, self.runtime_dir, self.workspace_dir, self.user_agent_dir, *self.skill_dirs):
            if path is not None and not Path(path).is_absolute():
                raise ValueError("pi_path_must_be_absolute")
        if self.runtime_source not in ("bundled", "local"):
            raise ValueError("invalid_runtime_source")
        return self

    def wire(self):
        self.validate(require_key=False)
        return {"state_dir": str(Path(self.state_dir).resolve()), "runtime_dir": self.runtime_dir,
                "provider": self.provider, "model": self.model, "api_key": self.api_key,
                "auth_source": self.auth_source,
                "base_url": self.base_url, "api": self.api, "supports_images": self.supports_images,
                "thinking_level": self.effort or "off", "max_output_tokens": self.max_output_tokens,
                "context_window": self.context_window, "reasoning": self.reasoning,
                "max_turns": self.max_turns, "max_budget_usd": self.max_budget_usd,
                "tool_timeout": self.tool_timeout,
                "workspace_dir": str(self.workspace_dir) if self.workspace_dir else None,
                "native_tools": self.native_tools, "tool_approval": self.tool_approval,
                "permission_timeout": self.permission_timeout,
                "user_agent_dir": str(self.user_agent_dir) if self.user_agent_dir else None,
                "skill_dirs": [str(path) for path in self.skill_dirs]}

    def public(self):
        return {"backend": "pi", "sdk_version": PI_VERSION, "entry_kind": "node_sdk",
                "version_source": "bundled_build_metadata", "compatibility_strategy": "runtime_capabilities",
                "node_minimum": PI_NODE_MINIMUM, "provider": self.provider, "model": self.model,
                "auth_source": self.auth_source, "has_key": bool(self.api_key),
                "runtime_source": self.runtime_source, "max_turns": self.max_turns,
                "max_budget_usd": self.max_budget_usd, "persist_session": False}


def user_pi_dirs():
    """The user's own Pi agent directory, found as Pi finds it (PI_CODING_AGENT_DIR, else ~/.pi/agent), and the Skill
    directories Pi reads for that user: its skills/ and the shared ~/.agents/skills."""
    agent = Path(os.environ.get("PI_CODING_AGENT_DIR") or Path.home() / ".pi" / "agent").expanduser().resolve()
    return agent, (agent / "skills", Path.home() / ".agents" / "skills")


def pi_runner_environment(state_dir):
    root = Path(state_dir).resolve()
    for child in (root, root / "home", root / "agent", root / "workspace", root / "tmp"):
        child.mkdir(mode=0o700, parents=True, exist_ok=True)
        child.chmod(0o700)
    env = {**child_environment(root / "tmp"), "HOME": str(root / "home"), "LANG": "en_US.UTF-8",
           "PI_CODING_AGENT_DIR": str(root / "agent"), "PI_OFFLINE": "1", "DO_NOT_TRACK": "1", "NO_COLOR": "1"}
    # Pi's own tools run the user's programs; on Windows it looks for Git Bash and PowerShell under ProgramFiles.
    if os.environ.get("PATH"):
        env["PATH"] = os.environ["PATH"]
    if sys.platform == "win32":
        env.update({key: os.environ[key] for key in ("ProgramFiles", "ProgramFiles(x86)") if os.environ.get(key)})
    for key in ("SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"):
        if os.environ.get(key):
            env[key] = os.environ[key]
    proxies = {key: os.environ[key] for name in ("HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY")
               for key in (name, name.lower()) if os.environ.get(key)}
    if proxies:
        # Node's fetch reads the proxy variables only with this set.
        env.update(proxies, NODE_USE_ENV_PROXY="1")
    return env
