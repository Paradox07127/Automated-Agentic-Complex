"""Local ACP agents: the registry snapshot, what is installed here, an initialize-only probe and sign-in."""
import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from .acp_runner import CLIENT_CAPABILITIES, AcpAgent, AcpError, RunnerFailure

REGISTRY = Path(__file__).resolve().with_name("acp_registry.json")
SEARCH_DIRS = ("/opt/homebrew/bin", "/usr/local/bin", "~/.local/bin", "~/.npm-global/bin", "~/.bun/bin", "~/.cargo/bin",
               # The dsh that the DeepSeek desktop client ships, for when the CLI is not installed.
               "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin")
# Turns off DeepSeek Harness's session-log upload; the locked patch also turns off its own tools, so its model sees
# only Endfield's MCP tools. JSON, which dsh reads as YAML, because the app bundle ships only .py/.json/... files from agentd.
DSH_PATCH = Path(__file__).resolve().with_name("dsh-acp.patch.json")
DSH_LOCKED_PATCH = Path(__file__).resolve().with_name("dsh-acp-locked.patch.json")
# Moves dsh's ACP model route to the DeepSeek account that the DeepSeek desktop client signs in (shared ~/.dsh).
DSH_ACCOUNT_PATCH = Path(__file__).resolve().with_name("dsh-acp-account.patch.json")

# Registry id -> (command name after a global install, ACP arguments). Binary entries use the
# registry's darwin-aarch64 cmd file name and args; npm and uv entries use the package's `bin` or
# console script name with the registry's args.
LOCAL_COMMANDS = {
    "agoragentic-acp": ("agoragentic-mcp", ["--acp"]),
    "amp-acp": ("amp-acp", []),
    # Local only: the registry entry is a binary archive, which is never launched from here.
    "antigravity-acp": ("agy", ["acp"]),
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
    configuration, else only Endfield's tools; ValueError for an agent that cannot be locked to them."""
    env = {**(profile_env() if agent["id"] == "claude-acp" else {}), **agent.get("env", {})}
    if native_tools:
        return agent["command"], env, None, None
    if agent["id"] not in LOCKS and str(DSH_PATCH) not in agent["command"]:
        raise ValueError("acp_agent_unrestricted")
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


def profile_env():
    """The claude CLI that claude-agent-acp runs, looked up now: it may be installed while agentd runs."""
    claude = _which("claude", search_path())
    return {"CLAUDE_CODE_EXECUTABLE": claude} if claude else {}


def acp_child_env(extra=None):
    """The environment of an agent or installer this process starts: agentd's own AGENTD_* and AAC_* stay out, and
    `#!/usr/bin/env node` scripts find their interpreter on the search path."""
    env = {key: value for key, value in os.environ.items() if not key.startswith(("AGENTD_", "AAC_"))}
    return {**env, "PATH": search_path(), **profile_env(), **(extra or {})}


def registry_env(distribution):
    """The env a registry distribution sets; binary entries use darwin-aarch64's, as LOCAL_COMMANDS does."""
    for spec in (distribution.get("npx"), distribution.get("uvx"), (distribution.get("binary") or {}).get("darwin-aarch64")):
        if spec and spec.get("env"):
            return dict(spec["env"])
    return {}


def find_local(paths=None):
    path = search_path(paths)
    agents = {agent["id"]: agent for agent in registry()["agents"]}
    found = []
    for agent_id, (command, args) in LOCAL_COMMANDS.items():
        executable = _which(command, path)
        if executable:
            row = {"id": agent_id, "name": agents[agent_id]["name"], "command": [executable, *args], "source": "local"}
            env = registry_env(agents[agent_id]["distribution"])
            found.append({**row, "env": env} if env else row)
    return found


def launchable(paths=None):
    """Registry npx/uvx agents, installed here or not, as commands; nothing is run."""
    path = search_path(paths)
    runners = {source: _which(source, path) for source in ("npx", "uvx")}
    entries = []
    for agent in registry()["agents"]:
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
    env = acp_child_env({"PATH": search_path(paths)})
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
        agent = AcpAgent(command, acp_child_env(env), cwd, no_requests, lambda *_: None, lambda _code: None)
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


async def _auth_call(command, env, method, params, timeout, cancel):
    """Initialize, then send `method` (authenticate or logout): None when done, else why not: the agent's own message,
    or "" when it cannot do it, gives no message or `cancel` is set first."""
    async def no_requests(_method, _params):
        return None

    with tempfile.TemporaryDirectory(prefix="efacp-auth-") as cwd:
        agent = AcpAgent(command, acp_child_env(env), cwd, no_requests, lambda *_: None, lambda _code: None)
        try:
            await agent.start()
            init = await agent.request("initialize", {"protocolVersion": 1, "clientCapabilities": CLIENT_CAPABILITIES,
                "clientInfo": {"name": "endfield_personal_agent", "version": "1"}}, timeout=10)
            if method == "logout" and "logout" not in ((init.get("agentCapabilities") or {}).get("auth") or {}):
                return ""
            call = asyncio.ensure_future(agent.request(method, params, timeout=timeout))
            while not call.done():
                await asyncio.wait({call}, timeout=0.5)
                if cancel is not None and cancel.is_set():
                    call.cancel()
                    return ""
            call.result()
            return None
        except RunnerFailure:
            return ""
        except AcpError as error:
            return str(error)
        finally:
            await agent.disconnect()


def authenticate(command, env, method_id, timeout, cancel):
    """ACP authenticate with one of the agent's own (type "agent") methods; the agent opens the browser itself. None when
    signed in, else the agent's reason ("" without one)."""
    return asyncio.run(_auth_call(list(command), env, "authenticate", {"methodId": method_id}, timeout, cancel))


def logout(command, env):
    """ACP logout; False when the agent does not offer it or refuses."""
    return asyncio.run(_auth_call(list(command), env, "logout", {}, 30, None)) is None


async def _account_models(command, timeout):
    async def no_requests(_method, _params):
        return None

    with tempfile.TemporaryDirectory(prefix="efacp-probe-") as cwd:
        agent = AcpAgent(command, acp_child_env(), cwd, no_requests, lambda *_: None, lambda _code: None)
        try:
            await agent.start()
            await agent.request("initialize", {"protocolVersion": 1, "clientCapabilities": CLIENT_CAPABILITIES,
                "clientInfo": {"name": "endfield_personal_agent", "version": "1"}}, timeout=timeout)
            session = await agent.request("session/new", {"cwd": cwd, "mcpServers": []}, timeout=timeout)
            return [option["value"] for config in session.get("configOptions") or [] if config.get("id") == "model"
                    for group in config.get("options") or [] if group.get("group") == "deepseek-account"
                    for option in group.get("options") or []]
        except (RunnerFailure, AcpError):
            return []
        finally:
            await agent.disconnect()


def deepseek_signed_in(command, timeout=20):
    """Whether dsh `command` (DSH_ACCOUNT_PATCH applied) has a DeepSeek account signed in. Signed out, the account route
    lists only the model the patch selects; signed in, it lists the account's own models besides it."""
    selected = json.dumps(["deepseek-account", json.loads(DSH_ACCOUNT_PATCH.read_text(encoding="utf-8"))[0]["config"]["model"]],
                          separators=(",", ":"))
    return any(value != selected for value in asyncio.run(_account_models(list(command), timeout)))
