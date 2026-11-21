"""Local ACP agents: the registry snapshot, what is installed here, and an initialize-only probe."""
import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from .acp_runner import CLIENT_CAPABILITIES, AcpAgent, AcpError, RunnerFailure

REGISTRY = Path(__file__).resolve().with_name("acp_registry.json")
SEARCH_DIRS = ("/opt/homebrew/bin", "/usr/local/bin", "~/.local/bin", "~/.npm-global/bin", "~/.bun/bin", "~/.cargo/bin")
# Turns off DeepSeek Harness's session-log upload; the locked patch also turns off its own tools, so its model sees
# only Endfield's MCP tools. JSON, which dsh reads as YAML, because the app bundle ships only .py/.json/... files from agentd.
DSH_PATCH = Path(__file__).resolve().with_name("dsh-acp.patch.json")
DSH_LOCKED_PATCH = Path(__file__).resolve().with_name("dsh-acp-locked.patch.json")

# Registry id -> (command name after a global install, ACP arguments). Binary entries use the
# registry's darwin-aarch64 cmd file name and args; npm and uv entries use the package's `bin` or
# console script name with the registry's args.
LOCAL_COMMANDS = {
    "agoragentic-acp": ("agoragentic-mcp", ["--acp"]),
    "amp-acp": ("amp-acp", []),
    "auggie": ("auggie", ["--acp"]),
    "autohand": ("autohand", ["--acp"]),
    "bob": ("bob", ["acp"]),
    "claude-acp": ("claude-agent-acp", []),
    "cline": ("cline", ["--acp"]),
    "codebuddy-code": ("codebuddy", ["--acp"]),
    "codex-acp": ("codex-acp", []),
    "cortex-code": ("cortex", ["acp", "serve"]),
    "corust-agent": ("corust-agent-acp", []),
    "crow-cli": ("crow-cli", ["acp"]),
    "cursor": ("cursor-agent", ["acp"]),
    "deepagents": ("deepagents-acp", []),
    # Local only: the registry entry has no distribution, so it is never launched through npx.
    "deepseek-harness": ("dsh", ["--profile", "acp", "--patch", str(DSH_PATCH)]),
    "devin": ("devin", ["acp"]),
    "dimcode": ("dimcode", ["acp"]),
    "dirac": ("dirac", ["--acp"]),
    "factory-droid": ("droid", ["exec", "--output-format", "acp-daemon"]),
    "fast-agent": ("fast-agent-acp", ["-x"]),
    "gemini": ("gemini", ["--acp"]),
    "github-copilot": ("copilot-language-server", ["--acp"]),
    "github-copilot-cli": ("copilot", ["--acp"]),
    "glm-acp-agent": ("glm-acp-agent", []),
    "goose": ("goose", ["acp"]),
    "grok-build": ("grok", ["agent", "stdio"]),
    "harn": ("harn", ["serve", "acp"]),
    "junie": ("junie", ["--acp=true"]),
    "kilo": ("kilo", ["acp"]),
    "kimchi": ("kimchi", ["--mode", "acp"]),
    "kimi": ("kimi", ["acp"]),
    "kimi-code": ("kimi-code", ["acp"]),
    "kiro": ("kiro-cli", ["acp", "--agent-engine=v3"]),
    "minimax-code": ("mcode", ["acp"]),
    "minion-code": ("minion-code", ["acp"]),
    "mistral-vibe": ("vibe-acp", []),
    "muse-code": ("muse", ["acp"]),
    "nova": ("nova", ["acp"]),
    # Also covers registry id opencode-v2: the same binary and arguments.
    "opencode": ("opencode", ["acp"]),
    "pi-acp": ("pi-acp", []),
    "qoder": ("qodercli", ["--acp"]),
    "qwen-code": ("qwen", ["--acp"]),
    "sigit": ("sigit", []),
    "stakpak": ("stakpak", ["acp"]),
    "vtcode": ("vtcode", ["acp"]),
}

# Bridges of harnesses that have their own kernel; settings offer that kernel instead.
NATIVE_BACKENDS = {"claude-acp": "claude", "codex-acp": "codex"}

# Registry source -> (installer, arguments before the package spec) of a global install.
INSTALLERS = {"npx": ("npm", ["install", "-g"]), "uvx": ("uv", ["tool", "install"])}
INSTALL_TIMEOUT = 300

_claude = shutil.which("claude")
PROFILE_ENV = {"claude-acp": {"CLAUDE_CODE_EXECUTABLE": _claude} if _claude else {}}
# What keeps a background semantic task from the agent's own tools and the user's own configuration.
LOCKS = {
    "claude-acp": {"session_meta": {"claudeCode": {"options": {"settingSources": []}}}, "mode": "default"},
    # OpenCode names MCP tools `<server>_<tool>`; acp_runner names Endfield's server `agentic_complex`.
    "opencode": {"env": {"OPENCODE_CONFIG_CONTENT": json.dumps({"permission": {"*": "deny", "agentic_complex_*": "allow"}})}},
}


def launch(agent, native_tools):
    """(command, env, session _meta, mode) of an agent row: with native_tools the agent's own tools and the user's own
    configuration, else only Endfield's tools."""
    env = {**PROFILE_ENV.get(agent["id"], {}), **agent.get("env", {})}
    if native_tools:
        return agent["command"], env, None, None
    lock = LOCKS.get(agent["id"], {})
    command = [str(DSH_LOCKED_PATCH) if arg == str(DSH_PATCH) else arg for arg in agent["command"]]
    return command, {**env, **lock.get("env", {})}, lock.get("session_meta"), lock.get("mode")


def registry():
    with open(REGISTRY, encoding="utf-8") as f:
        return json.load(f)


def search_path(paths=None):
    if paths is None:
        paths = [p for p in os.environ.get("PATH", "").split(os.pathsep) if p] + list(SEARCH_DIRS)
    return os.pathsep.join(os.path.expanduser(p) for p in paths)


def _which(name, path):
    found = shutil.which(name, path=path)
    return os.path.abspath(found) if found else None


def find_local(paths=None):
    path = search_path(paths)
    names = {agent["id"]: agent["name"] for agent in registry()["agents"]}
    found = []
    for agent_id, (command, args) in LOCAL_COMMANDS.items():
        executable = _which(command, path)
        if executable:
            found.append({"id": agent_id, "name": names[agent_id], "command": [executable, *args], "source": "local"})
    return found


def launchable(paths=None):
    """Registry npx/uvx agents not installed here, as commands; nothing is run."""
    path = search_path(paths)
    runners = {source: _which(source, path) for source in ("npx", "uvx")}
    local = {agent["id"] for agent in find_local(paths)}
    entries = []
    for agent in registry()["agents"]:
        if agent["id"] in local:
            continue
        for source, prefix in (("npx", ["-y"]), ("uvx", [])):
            spec = agent["distribution"].get(source)
            if spec and runners[source]:
                entries.append({"id": agent["id"], "name": agent["name"], "source": source,
                                "command": [runners[source], *prefix, spec["package"], *(spec.get("args") or [])],
                                "env": dict(spec.get("env") or {})})
                break
    return entries


def install_command(agent_id, paths=None):
    """The global install argv of a registry npx/uvx agent; ValueError when it has no such package or no installer."""
    agent = next((a for a in registry()["agents"] if a["id"] == agent_id), None)
    if agent is None:
        raise ValueError("invalid_acp_agent")
    source = next((s for s in INSTALLERS if s in agent["distribution"]), None)
    if source is None:
        raise ValueError("acp_install_unsupported")
    installer, args = INSTALLERS[source]
    executable = _which(installer, search_path(paths))
    if executable is None:
        raise ValueError("acp_installer_missing")
    return [executable, *args, agent["distribution"][source]["package"]]


def install(agent_id, paths=None, timeout=INSTALL_TIMEOUT):
    """Run the global install of one registry agent; returns its exit code and the end of its output."""
    command = install_command(agent_id, paths)
    # npm and uv are scripts that find node or python on PATH.
    env = {**os.environ, "PATH": search_path(paths)}
    try:
        done = subprocess.run(command, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, timeout=timeout)
        code, output = done.returncode, done.stdout
    except subprocess.TimeoutExpired as error:
        code, output = None, error.output or b""
    return {"ok": code == 0, "agent_id": agent_id, "command": command, "exit": code,
            "output_tail": output.decode("utf-8", "replace")[-4000:]}


async def _probe(command, env, timeout):
    async def no_requests(_method, _params):
        return None

    with tempfile.TemporaryDirectory(prefix="efacp-probe-") as cwd:
        agent = AcpAgent(command, {**os.environ, **(env or {})}, cwd, no_requests, lambda *_: None, lambda _code: None)
        try:
            await agent.start()
            init = await agent.request("initialize", {"protocolVersion": 1, "clientCapabilities": CLIENT_CAPABILITIES,
                "clientInfo": {"name": "endfield_personal_agent", "version": "1"}}, timeout=timeout)
            ok = init.get("protocolVersion") == 1
            return {"ok": ok, "agent_info": init.get("agentInfo"), "auth_methods": init.get("authMethods", []),
                    "capabilities": init.get("agentCapabilities"),
                    "error": None if ok else "acp_protocol_version_unsupported"}
        except (RunnerFailure, AcpError) as error:
            code = str(error) if isinstance(error, RunnerFailure) else "acp_request_rejected"
            return {"ok": False, "agent_info": None, "auth_methods": [], "capabilities": None, "error": code}
        finally:
            await agent.disconnect()


def probe(command, env=None, timeout=10):
    """Start the agent, send ACP initialize only (no session), then end the process."""
    return asyncio.run(_probe(list(command), env, timeout))
