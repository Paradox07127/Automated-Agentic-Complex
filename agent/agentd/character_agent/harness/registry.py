"""Per-harness facts, keyed by the settings `backend` value."""
from dataclasses import dataclass
from typing import Callable, Optional


@dataclass(frozen=True)
class Harness:
    title: str
    default_model: str
    # None: the harness reaches the user-configured provider through `_pi_connection`.
    provider: Optional[str]
    # Backend name in DiscoveryService rows; None: not a discovered CLI runtime.
    discovery_name: Optional[str]
    # Appended to the discovered executable to sign in; None: no login command.
    login_suffix: Optional[str]
    web_access: bool
    cost_limit_supported: bool
    # (integration, config, common, definitions) -> session
    session: Callable


def _pi_session(integration, config, common, definitions):
    from character_agent.harness.pi_config import PiConfig, resolve_pi_runtime, user_pi_dirs
    from character_agent.harness.pi_transport import ManagedPiSession
    node, runtime_dir = resolve_pi_runtime(integration.harness_sites.get("harness.pi"))
    connection = integration._pi_connection(config)
    # 「pi 账号与凭据」 rows of the connection's backend: its thinking default and a compatible model's capabilities.
    saved = integration.server.models.snapshot() if integration.server.models else {"backends": {}}
    backend = saved["backends"].get(config["provider"] or saved.get("provider"), {})
    if connection["provider"] == "compatible":
        connection = {**connection, **{key: backend[key] for key in ("context_window", "reasoning") if key in backend}}
    credential = None
    if connection["auth_source"] != "none":
        # Read again for every query: a ChatGPT token expires while the pi session lives on.
        credential = lambda: integration._credential(config)
        common = {**common, "api_key": credential()}
    if common["native_tools"]:
        # Pi's own MCP servers and Skills come from the user's Pi configuration; the runner's HOME is private.
        user_agent_dir, skill_dirs = user_pi_dirs()
        common = {**common, "user_agent_dir": user_agent_dir, "skill_dirs": skill_dirs}
    options = PiConfig(**common, **connection, max_budget_usd=config["max_budget_usd"],
        effort=config.get('_semantic_effort') or config.get('_turn_effort') or backend.get("reasoning_effort") or None,
        node=config["executable"] if config["runtime_source"] == "local" else node, runtime_dir=runtime_dir,
        tool_approval=config["pi_tool_approval"])
    return ManagedPiSession(options, definitions, credential=credential,
        permission_handler=lambda request: integration._harness_permission(request, "pi", HARNESSES["pi"].title),
        on_ready=integration._pi_ready if common["native_tools"] else None)


def pi_catalog(integration, provider):
    """Pi's offline catalog ({providers, models of `provider`}), read with the Node and SDK Pi sessions use."""
    from character_agent.harness.pi_config import resolve_pi_runtime
    from character_agent.harness.pi_transport import list_models
    config = integration.settings.snapshot()
    node, runtime_dir = resolve_pi_runtime(integration.harness_sites.get("harness.pi"))
    if config["backend"] == "pi" and config["runtime_source"] == "local":
        node = config["executable"]
    return list_models(node, runtime_dir, integration.state_dir / "character-agent" / "runner" / "pi" / "catalog", provider)


def _cli_common(integration, config, common):
    selected = integration._selected_runtime(config)
    if not selected or not selected["entry_supported"]:
        raise ValueError("runtime_unavailable")
    common.update(python=integration.python, cli_path=selected["path"],
                  auth_mode=config["auth_source"], persist_session=False, effort=config.get('_semantic_effort') or config.get('_turn_effort'))


def _codex_session(integration, config, common, definitions):
    _cli_common(integration, config, common)
    from character_agent.harness.codex_transport import CodexConfig, ManagedCodexSession
    return ManagedCodexSession(CodexConfig(**common), definitions,
        permission_handler=lambda request: integration._harness_permission(request, "codex", HARNESSES["codex"].title))


def _claude_session(integration, config, common, definitions):
    _cli_common(integration, config, common)
    from character_agent.harness.claude_transport import ClaudeConfig, ManagedClaudeCodeSession
    return ManagedClaudeCodeSession(ClaudeConfig(**common), definitions,
        permission_handler=lambda request: integration._harness_permission(request, "claude", HARNESSES["claude"].title))


def acp_agent(config):
    """The configured ACP agent as {id, name, source, command[, env]} when it can start here, else None."""
    from character_agent.harness import acp_agents
    launcher = config["acp_launcher"]
    rows = acp_agents.find_local() if launcher == "local" else acp_agents.launchable()
    return next((a for a in rows if a["id"] == config["acp_agent"] and a["source"] == launcher), None)


def _acp_session(integration, config, common, definitions):
    from character_agent.harness.acp_agents import launch
    from character_agent.harness.acp_transport import AcpConfig, ManagedAcpSession
    agent = acp_agent(config)
    if agent is None:
        raise ValueError("acp_agent_missing")
    command, env, session_meta, mode = launch(agent, common["native_tools"])
    options = AcpConfig(**common, python=integration.python, agent_id=agent["id"], agent_command=command,
        agent_env=env, session_meta=session_meta, mode=mode,
        effort=config.get('_semantic_effort') or config.get('_turn_effort'))
    return ManagedAcpSession(options, definitions,
        permission_handler=lambda request: integration._harness_permission(request, "acp_agent", agent["name"]),
        on_auth=lambda ok: integration._acp_logins.update({agent["id"]: ok}))


HARNESSES = {
    "codex": Harness(title="Codex", default_model="default", provider="openai", discovery_name="codex",
        login_suffix=" login", web_access=False, cost_limit_supported=False, session=_codex_session),
    "pi": Harness(title="Pi", default_model="", provider=None, discovery_name=None, login_suffix=None,
        web_access=False, cost_limit_supported=True, session=_pi_session),
    # The agent holds its own login and model connection; tools reach it over stdio MCP.
    "acp": Harness(title="ACP", default_model="", provider="acp", discovery_name=None, login_suffix=None,
        web_access=False, cost_limit_supported=False, session=_acp_session),
    # The local CLI over stream-json; an empty model is the CLI's own.
    "claude": Harness(title="Claude Code", default_model="", provider="anthropic", discovery_name="claude",
        login_suffix=" auth login", web_access=False, cost_limit_supported=False, session=_claude_session),
}

# DiscoveryService backend name -> settings backend.
DISCOVERED = {h.discovery_name: key for key, h in HARNESSES.items() if h.discovery_name}


def harness(backend):
    return HARNESSES.get(backend)
