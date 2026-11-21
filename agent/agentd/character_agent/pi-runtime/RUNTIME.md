# Endfield Pi runtime

Pinned npm package: `@earendil-works/pi-coding-agent` **1.4.0**, MIT.
Official source: https://github.com/earendil-works/pi/tree/main/packages/coding-agent
SDK reference: https://pi.dev/docs/latest/sdk
Minimum Node: **22.19.0**.

`package-lock.json` records the entire npm dependency graph with registry integrity
digests. `dependencies.json` records declared licenses and exact versions. The
install helper (`agent/agentd/character_agent/harness/pi_install_runtime.py`, which
takes an absolute `--npm` path) runs `npm ci --ignore-scripts --no-audit --no-fund`,
validates the installed package versions, and writes a manifest with the lock hash
and the original license file hashes. Dependency license and notice files stay in
the shipped npm tree.

The app layout is the `harness.pi` component's `node/bin/node` and
`pi-runtime/node_modules/`, with a standalone Node distribution whose original
LICENSE is kept. `pi_runner.mjs` ships with the Python adapter.

The adapter uses the official `createAgentSession`, `ModelRuntime`,
`SessionManager.inMemory`, `SettingsManager.inMemory`, and custom tool APIs.
The version-pinned internal `core/auth-storage.js` module provides Pi's own
credential store because 1.4.0 does not re-export AuthStorage from its root entry.
Only the selected Pi auth file is used; Claude and Codex auth files are not read.

Global and project extensions, context files and prompt templates are absent from
the resource loader. Without Pi's own tools (semantic work) only Endfield's exact
custom tool allowlist is active, verified against the SDK's live tool inventory.
With them (conversations), Pi's shell and file tools work in the workspace, and
Pi's built-in MCP, codemode and tool_search extensions and its Skills loader read
the user's own Pi configuration: `mcp.json` in the user's Pi agent directory
(`PI_CODING_AGENT_DIR`, else `~/.pi/agent`), Skills in its `skills/` and in
`~/.agents/skills`. While tool approval (工具审批) is on, every `mcp__*` call waits
for an approval card like bash, powershell, write and edit. Settings and native
transcripts stay in memory.

Cache warming and automatic compaction are disabled, so no automatic hidden model
work runs; model retries keep the SDK defaults. Product history and checkpoints rebuild the
conversation after invalidation; raw Pi transcripts are not migrated. Context
overflow is reported as a failure, not silently truncated.

Turn and wall-clock limits are enforced; provider catalog cost is an estimate
checked after each response. Custom endpoint prices are unknown and return
`total_cost_usd: null` plus `cost_tracking: unpriced_custom_endpoint`; the USD limit
cannot constrain an unpriced endpoint. API credentials reach the runner only through
a private inherited pipe, with an allowlisted child environment. No auth values
appear in the public configuration, readiness metadata, or this manifest.
