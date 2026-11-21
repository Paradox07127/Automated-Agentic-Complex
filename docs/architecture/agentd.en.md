# agentd

[简体中文](agentd.md) · [Documentation index](../README.en.md)

agentd is the character-side background service. It is written in Python 3.12 and listens on 127.0.0.1 only. It receives Claude Code and Codex hooks, keeps the multi-session registry and the focus, brokers Claude's approvals, pushes behaviors and intents to the character process, and runs the character's conversations, tasks, memory, and observation. HTTP endpoint fields and error codes are in the [C6 contract](../../protocol/C6-agentd-api/CONTRACT.md) (§3 table, §4 details); process arguments and discovery files are in the [C9 contract](../../protocol/C9-agentd-process/CONTRACT.md); tool authorization is in the [tool gateway](tool-gateway.en.md).

## Overview

- Dependencies are in `agent/agentd/requirements.txt` (the `httpx` HTTP client and `PyJWT` for OIDC checks).
- agentd installs no hooks itself and does not change `~/.claude` or `~/.codex`. The user installs observe-only hooks by running `tools/install_hooks.py` (see "Hook installation").
- Companion starts it through `app/Resources/agentd_launcher.py`; the standalone command is in the last section of the [C9 contract](../../protocol/C9-agentd-process/CONTRACT.md).

## Code layout

A new module goes into the domain package it belongs to; the root holds only files that something outside the package finds by path or by top-level module name. The code has three layers: the entry point `server.py` → `daemon/` and `api/` → the domain packages → `infra/`. Domain packages do not import `daemon/` or `api/`; `infra/` imports none of the layers above it.

| Package | Contents |
|---|---|
| `api/` | The HTTP `Handler` (`api/handler.py`: the `parse_request` checks, and `_dispatch`, which hands a request to the owner of its route in `route_registry.py`); mixins split by URL prefix: `hooks`, `sessions`, `memory`, `episodes`, `observation`, `context`, `speech`, `diag`, `character`, `settings`; `views.py` holds the views and field checks shared by `api/` and `daemon/`; `integration.py` holds the `/integration/*` routes for outside agents ([INTEGRATION.md](../../protocol/C6-agentd-api/INTEGRATION.md)) |
| `daemon/` | `main.py` (arguments, startup order, serve loop); `AgentdServer` and `StateView` in `agentd_server.py`; mixins split by concern: `announce`, `turns`, `speech_control`, `context`, `switches`, `ingest`, `character_switch`, `rituals_glue`, `memory_sync`, `tracing`, `diagnostics`, `lifecycle`; shared constants in `constants.py` |
| `infra/` | SQLite storage and schemas (`store`, `store_schemas`, `data_lifecycle`), 0600 token files (`tokens`), state paths (`paths`), local time in prompts (`localtime`), platform differences (`platform/`) |
| `sessions/` | Event normalization, the session registry, approvals and danger rules (`approvals`, `danger`), own sessions and dispatch (`own`, `lifecycle`, `dispatch`, `tasks`), session digests, the harness ledger and day summaries |
| `observation/` | The attention timeline and blacklist, capture and image description (`capture`), privacy and consent (`privacy`), activity judgement and user state, the desktop timeline (`timeline`), desktop presence, spatial behavior and facing |
| `personal/` | Fact memory, personal episodes, chat history and conversations, reminders, schedules, tap rituals, work memory |
| `character/` | Her own state (`character_state`), the behavior tick (`behavior`), the proactive speech gate and judges (`gate`, `judge`, `proactive`), thoughts (`thoughts`), interaction presets (`interactions`), numbered events for the shell (`feed`), character bindings, the motion graph, and mod-settings routes |
| `voice/` | C2 speech relay (`speech`), clause splitting (`clauses`), on-demand TTS start (`tts_ensure`), voice source, voice test |
| `models/` | ChatGPT sign-in (`model_auth`), model settings (`model_backends`), usage and cost (`usage`), the capability snapshot (`capabilities`) |
| `motion/` | Motion catalog, generation and import (including ZIP import), motion settings, and the `/motion*` routes |
| `traces/` | T1 trace format checks (`trace_format`) and storage (`trace_store`) |
| `tool_gateway/` | The tool gateway; see the [tool gateway](tool-gateway.en.md) |
| `brain/` | The "mouth": character cards, lore and the default character by id (`characters`), card rendering (`persona`), keyword lore (`lorebook`), handing lines to the character kernel (`provider`), inline markers, deterministic commands (`parser`), the outbound guard and outbound checks (`outbound`, `egress`) |
| `character_agent/` | The main character conversation and swappable kernels; see "Character kernels" |
| `tools/` | Standalone scripts: `install_hooks.py`, `tts_token.py`, the desktop-control MCP facade for own sessions `computer_use_mcp.py`, the outside-agent CLI `agentic_complex.py` |
| `tests/` | unittest tests, fake CLIs (`fakes/`), fixtures (`fixtures/`), and the shared `support.py` |

### Root files

The root has 13 `.py` files; something outside the package finds each one by path or by top-level module name:

- `server.py`: the entry point; `app/Resources/agentd_launcher.py` starts it by path.
- `codex_hook_forward.py`: the hook forwarder; the hook configs in `config-examples/` and the commands `tools/install_hooks.py` writes into user configs call it by path.
- `c1.py`: C1 message checks; `python3 -I agent/agentd/c1.py protocol/C1-agent-events/fixtures` checks the fixtures.
- `route_registry.py`: the HTTP route registry; `protocol/tools/gen_routes.py` imports it to generate `protocol/ui-bridge/routes.json`, the C6 route table, and the web UI's `agentd-routes.generated.ts`.
- `control_panel.py`: control-panel routes for conversations and own sessions (`/conversations*`, `PUT/DELETE /sessions/<id>`).
- `character_tool.py`, `motion_tool.py`, `outfit_tool.py`, `distribution_seed.py`: the character package, motion, outfit and bundled-library tools that Companion runs by script path. The release Python runs with `-I`, so these scripts add their own directory to `sys.path`.
- `character_library.py`, `resource_store.py`: character library checks and publishing, copy-on-write; the build scripts in `characters/` import them as top-level modules.
- `fsutil.py`: atomic whole-file replacement.
- `pool_codec.py`: the compressed container for character pool files; `character_library.py`, `tools/release/` and the build scripts in `characters/` import it.

### Development conventions

- Imports are absolute (`from observation.blacklist import X`); relative imports exist only in `character_agent/harness/`. When you move a module, update its callers; leave no forwarding module behind.
- A new HTTP route is one `Route(...)` entry in `REGISTRY` in `route_registry.py`: a route `Handler` answers itself takes `owner=SERVER` and `action` (the `Handler` method name); any other owner answers through that module's `route()`; `spec` names the contract that specifies the route's fields. Afterwards run `python3 -I protocol/tools/gen_all.py --write` from the repository root.
- `parse_request` checks the token against the route's `tokens` in the registry: a path not in the registry gets 404, a wrong token 401.
- The character list, cards, and lore all come from the character library (`Repository` in `brain/characters.py`).

## State directory and tokens

The [C9 contract](../../protocol/C9-agentd-process/CONTRACT.md) defines the token and discovery files under `--state-dir` (`hook.token`, `ui-runtime.json`, `events-runtime.json`). The three tokens are separate:

- The hook token is for hooks and the browser native host; it cannot submit approval decisions.
- The ui token is for the shell and reaches the UI routes.
- The events token is for the character process and reads only `GET /events`, `GET /state`, `GET /speech`, and `GET /character/state`.

Any process of the same user can read these files; this is not a sandbox.

The approval deadline is `--hook-timeout` (default 60 s) minus `--margin` (default 5 s), and it must be shorter than the PermissionRequest hook timeout in the Claude config.

## Shutdown

On SIGTERM, SIGINT, or exit of the process that started it (`--exit-with-parent`, on by default), agentd shuts down in this order:

1. It stops taking work: `POST /sessions*`, `POST /say` and Claude's PermissionRequest hook return 503 `{"error": "shutting_down"}`; read endpoints work as usual.
2. It withdraws every pending card (a waiting hook gets `{}`).
3. It interrupts busy own sessions and stops every own-session process, waiting at most 5 s in total. Each own-session process runs in its own process group, and the stop signal goes to the whole group, so child processes the CLI started end too.
4. It stops the server.

## Models and credentials

- `model-settings.json` stores each backend's connection and API key; `chatgpt-auth.json` stores the install identity, each account registration, and tokens. Both live under `--state-dir` and are written atomically with mode 0600. HTTP read endpoints and the UI never return credentials.
- Without saved settings the provider is `chatgpt`. A saved change affects later requests only.
- ChatGPT subscription: sign-in happens in the system browser; the callback checks state, PKCE (S256), the ID token, and the nonce. Inference is allowed only when the grant includes `chatgpt.tokens.use.direct`. Refreshes are serialized per connection under a file lock. Subscription tokens go only to `https://api.openai.com/v1`; Codex app login files are never read or reused. Signing out tries to revoke the remote refresh token.
- OpenAI and compatible APIs: the base URL must be https, or http on the local machine (localhost, 127.0.0.1, ::1). The output limit defaults to 4096 tokens and can be set to 128–32768. DeepSeek uses the fixed official address `https://api.deepseek.com` and needs a key.
- Own Claude and Codex work sessions keep the sign-in their CLIs manage; model settings do not change them.
- Endpoint rules are in C6 §2.

## Usage and pricing

Usage is recorded per day, model, and purpose in `model_usage` in `agentd.sqlite`, with a channel breakdown per row. `budget.model` in `GET /diag/state` gives totals, `by_call`, `by_channel`, `usage_missing` (calls with missing or incomplete usage), and `pricing_unverified` (calls with complete usage whose pricing conditions cannot be verified).

- Direct Anthropic API: a call is priced only when the model rate is known, usage and cache writes are complete, and the response confirms the standard service tier, standard speed, and the global or us region; the us region costs 1.1 times as much.
- Direct DeepSeek API: with complete usage, a call is priced at the Flash or Pro rates for input, cache hits, and output; on weekdays from 01 to 04 and from 06 to 10 UTC the price doubles.
- Catalog cost estimates reported by the Pi kernel are used as given. Subscriptions, proxies, and other unknown rates are not priced.

The amounts estimate what agentd can verify; they are not provider bills. External CLI sessions are not counted.

## Outbound guard and redaction

- Outbound guard: agentd reads `<state-dir>/canon-windows.json` (if that file exists it is used, even when invalid), else the bundled `brain/canon-windows.json`. The file holds hashes of every 7 content characters (punctuation and whitespace removed) of the original game lines; it holds no original text. If the file cannot be read or has the wrong format, agentd does not start.
- Text we write for the model (cards, examples, lore, per-turn notes) and model replies we send again pass the guard first: if any 7-character run matches an original line, the request is not sent (`OutboundBlocked`). `outbound-guard.jsonl` records only the part name, length, and hit count.
- User input and screen content are not blocked; API keys, tokens, email addresses, and phone numbers in them are masked (`--redact`, on by default; `--no-redact` turns it off). Mask counts per kind are kept for the diagnostics page.

## Characters and conversation requests

- `--character <id>` picks the character at startup; without it agentd uses the library's `default_character`. While running, the three-step switch `/character/prepare`, `commit`, `abort` changes the character (C6 §4.2). agentd does not store the character; Companion passes `--character` on restart.
- Cards and lore have one source: the character library passed with `--character-catalog`. Without that argument agentd reads `AGENTD_DEV_CATALOG`, and failing that the public sample library `characters/sample-library/current.json` (only the text-only character `aide`). Cards, lore, and the default character are never rewritten when read.
- The card (`<id>/persona.json`, 10 sections) renders into the system text. Each turn adds memories the user stated or confirmed, keyword-matched lore entries (`<id>/lore.json`: world, relations, events, with sticky, cooldown, and a token budget), and the live context.
- Approvals in the live context: each pending card gives its session, tool, summary, and time left; cards that ended within 600 s (at most 3) give their result. When her own state is unusual (very sleepy, deeply absorbed, mood far from baseline), one sentence about it is added; that sentence also passes the outbound guard and is dropped whole when blocked.
- Live material and low-trust memories are marked as material, not instructions. Chat history stores only the user's own words; the model gets the last 8 turns.
- Sessions, the attention timeline, and memory are shared across characters.

## Voice

- Voice is on only when agentd starts with `--tts-url`. For TTS on a remote host, for example, run `ssh -N -L 19888:127.0.0.1:9888 <host>` and pass `--tts-url http://127.0.0.1:19888`.
- Requests carry `Authorization: Bearer <token>`. The token file is `--tts-token-file`, else `$AAC_TTS_TOKEN_FILE` (C10); the file must be 0600. From the repository root, `agent/.venv/bin/python agent/agentd/tools/tts_token.py push --ssh user@host --remote /srv/agentic-complex-tts/state/tts-token` creates the token and copies it to the TTS host. Substitute the service account, host and deployment root, then restart TTS and agentd.
- TTS URLs may be `http` or `https`. HTTPS uses port 443 by default and verifies the certificate and host name on the first connection and on reconnects; user information in the URL and other schemes are rejected. Plain HTTP is accepted for any host and sends the token and text unencrypted.
- The relay rules (the `/speech` relay, the `cancelled` line on truncation, `speech_failed` on failure) are in C6 §4.7.

## Sessions and focus

Focus priority: error > awaiting_approval > awaiting_input > running_tool > thinking > compacting > subagent > done > stale > idle; on a tie the current focus stays. Hook responses, card withdrawal, de-duplication, and event order are in C6 §4.6.

## Own sessions

Claude and Codex sessions that agentd opens itself (`POST /sessions` and dispatch):

- Claude: a long-running `claude -p --input-format stream-json --output-format stream-json --verbose --permission-mode <mode> --settings <state-dir>/own-claude-settings.json`. agentd writes the settings (0600); every hook points at this agentd and the PermissionRequest timeout equals `--hook-timeout`, so writing files and running commands raise ordinary approval cards whose `display_session` is `own:<hex>`. An interrupt writes a `control_request` `interrupt`; an interrupted turn is recognized by `result.terminal_reason == "aborted_streaming"`.
- Codex: `codex app-server`; `thread/start` passes the sandbox for the mode (`read-only` or `workspace-write`), and the approval policy and reviewer follow the user's `config.toml`. `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` open approval cards; allow answers `accept`, deny or timeout answers `decline`; other server requests get an error. An interrupt uses `turn/interrupt`. The Codex protocol fields are locked in `sessions/codex-protocol.lock.json`.
- The child environment drops `ANTHROPIC_API_KEY` and `AGENTD_HOOK_TOKEN`; the user's own CLI sign-in is used.
- An idle process is reclaimed after 10 minutes; the next message reconnects with `--resume <session_id>` or `thread/resume`.

## Hook installation

`tools/install_hooks.py` (standard library only) adds command hooks to the user-level Claude Code settings and to Codex's `hooks.json` (under `~/.codex/` by default), so agentd sees the user's own sessions:

```sh
python3 agent/agentd/tools/install_hooks.py --dry-run     # print the hooks it would add, write nothing
python3 agent/agentd/tools/install_hooks.py               # install; a second run changes nothing
python3 agent/agentd/tools/install_hooks.py --uninstall   # remove only what it added
python3 agent/agentd/tools/install_hooks.py --target claude --uninstall   # unlink Claude Code only
```

- Events: Claude takes the 12 in `config-examples/claude-settings.agentd.json`, Codex the 10 in `config-examples/codex-hooks.agentd.json`. Each event gets one appended group.
- Command: `<Python> <agentd>/codex_hook_forward.py --endpoint /hook/claude (or /hook/codex) --observe --timeout 0.8 --url http://127.0.0.1:48800 --token-file <absolute path of hook.token>`. Python defaults to `/usr/bin/python3`; the token defaults to `~/Library/Application Support/AgenticComplex/agentd/` on macOS and `%LOCALAPPDATA%\Agentic Complex\agentd\` on Windows. `--target both|claude|codex` picks the tools; `--claude-settings`, `--codex-home`, `--url`, `--token-file`, `--python`, and `--forwarder` override the defaults.
- With `--hook-script <path>` (the file name must be `agentic-complex-hook` on macOS, `agentic-complex-hook.cmd` on Windows) the command is that script alone. The install command Companion gives the user does this, pointing at the script in `<support dir>/bin/`, and Companion rewrites that script before each agentd start to call the current agentd's forwarder, so hooks keep working when agentd moves.
- Each group is `{"hooks": [{"type": "command", "command": <one-line command>, "async": true, "onFailure": "continue", "timeout": 2}]}`; the Codex group has no `onFailure`. On macOS both tools run the command with `sh -c`, quoted with `shlex`; on Windows the Claude group adds `"shell": "powershell"` and Codex uses `%COMSPEC% /C`.
- It recognizes only its own groups: a group with a single command hook whose command line contains the forwarder (or the `agentic-complex-hook` script), `--observe`, and this run's `--url`. The user's own keys, groups, and hooks are never touched or reordered; its own old groups are replaced in place. `--uninstall` removes only its own groups.
- Writes go through a temporary file in the same directory and a rename, keeping the original mode; new files are 0600. If the JSON cannot be read or has the wrong shape, it exits with 2 and changes no file. `--dry-run` prints only the diff of its own groups.
- Observe only: the hooks print nothing and never decide; when agentd is down or stuck, the forwarder exits 0 within about 1 s.
- Codex runs only hooks the user trusted: after installing, open codex once and trust them in the "Hooks need review" prompt at startup, or with `/hooks` in the TUI. A changed command must be trusted again. The installer does not change `config.toml` and writes no hook trust.
- The settings page's 解绑 (Unlink) uses `POST /integrations/hooks/disconnect` (C6 §4.2). The shell hands the install command to the web settings page through `hookInstallSteps` in `app.info`; the command uses the Python the host resolved and `tools/install_hooks.py` in the agentd component.

### Manual hook test

The examples in `config-examples/` raise approval cards and are for one-off tests only; replace `/ABSOLUTE/PATH` in them with the real path first. Claude's default auto mode raises no approvals, so testing approvals needs `--permission-mode default`.

```sh
mkdir -p /tmp/agentd-test/claude && cd /tmp/agentd-test/claude
AGENTD_HOOK_TOKEN="$(cat /tmp/agentd-test/state/hook.token)" \
  claude --settings /ABSOLUTE/PATH/agent/agentd/config-examples/claude-settings.agentd.json \
    --setting-sources '' --permission-mode default
```

Codex: copy `codex-hooks.agentd.json` to `hooks.json` in a one-off directory and point `CODEX_HOME` at it (that directory needs its own sign-in), or put it at `.codex/hooks.json` of a one-off test project. A one-off test can add `--dangerously-bypass-hook-trust`, which applies to that call only.

Watch:

```sh
UI=$(python3 -c 'import json;print(json.load(open("/tmp/agentd-test/state/ui-runtime.json"))["ui_token"])')
curl -s -H "Authorization: Bearer $UI" http://127.0.0.1:48800/state
curl -N -H "Authorization: Bearer $UI" http://127.0.0.1:48800/events
```

This assumes agentd runs with `--port 48800 --state-dir /tmp/agentd-test/state`.

## Attention timeline

Stored in `<state-dir>/attention.sqlite` and kept for 7 days. The merge rules follow ActivityWatch:

- A heartbeat with the same data in the same bucket that arrives within 5 s of the end of the previous span extends that span; a gap longer than 5 s counts as unknown and is not filled from the previous state. When the window changes, the previous span extends to the switch time.
- AFK: `idle_s` ≥ 180, a locked screen, or sleep.
- Gaze: with keyboard input in the last 5 s the front window counts, otherwise the window under the mouse; 5 s or more on one window counts as a gaze.
- Browser extension heartbeats go into the `browser` bucket (pulsetime 80 s) and keep the focused and visible state. Only focused, visible pages playing sound can add active time.
- With `share_page_text` on, page text and selections are stored in the local context table; the mouth gets at most 500 characters of selection and 1500 of page text. After focus leaves, the current page's text is not used. Scroll, media, and tab counts are kept only as the latest in-memory snapshot, expire after 15 seconds, and never reach a model.

The [C10 contract](../../protocol/C10-shared-files/CONTRACT.md) defines the fields of the blacklist file `blacklist.json`.

## Browser extension messages

Installation and use for users are in the [browser extension](../guides/browser-extension.en.md) guide.

- Transport: Chrome Native Messaging. Each message is a 4-byte native-endian length followed by UTF-8 JSON; messages from the extension are at most 1 MiB. The native host is `agent/browser/native_host.py`; from `--state-dir` it reads `hook.token` and the `base_url` in `ui-runtime.json`, never the ui token.
- On connect, and on every `{"type": "policy"}`, the host calls `GET /context/browser/policy` for `{enabled, text_enabled}` and sends the extension `{"type": "config", enabled, text_enabled, domains, title_patterns, mode, allow_domains}` (blacklist values from `blacklist.json`). If the policy cannot be fetched, `enabled` is false.
- Messages from the extension: `heartbeat`, `page`, `selection`, `selection_cleared`, `metrics`. Common fields are `ts` (Unix seconds), `url_host`, `title`, and the document identity `browser_session`, `tab_id`, `document_id`, `revision`. `heartbeat` adds `audible`, `visible`, `window_focused`; `page` and `selection` carry `text` (at most 2000 characters); `metrics` carries `metrics` (scroll percentages, media state, tab counts).
- The host forwards nothing while `enabled` is false and drops `page` and `selection` while `text_enabled` is false. A blacklisted heartbeat becomes `url_host: "<hidden>"`, `title: null`; any other blacklisted message is dropped. Everything else goes as is to `POST /context/browser` (hook token).
- agentd checks again: a wrong type or field gets 400 `invalid_browser`; with the page-text switch off, `page` and `selection` get 200 and are not stored. Endpoint rules are in C6 §4.2.

## Window content and upload budget

- In a new config `share_page_text`, `share_window_text`, and `share_screenshots` are all off; granting Accessibility or Screen Recording does not turn content sharing on.
- With window text on and permission granted, the shell sends `POST /context/text` on demand: on app switch, focus change, after typing or scrolling stops, and when idle.
- `screen_context_level` is `status` (no text read), `focused` (default; only the focused control and the selection), or `window` (a summary of visible text). OCR is used only with `window`, text sharing, and image sharing all on; it runs in the local helper and agentd receives only the resulting text.
- Before sending text or a screenshot, the shell checks the blacklist, `secure_input`, and private windows and sends nothing on a match; agentd's own drop is a second check. Once a window is found blacklisted, private, or under `secure_input`, agentd sends it no more requests.
- The judge answers two questions: `need_image` (whether a screenshot is needed) and `next_check` (`30s`, `2min`, `10min`, `never`). The default rule asks for an image when both the AX and the OCR text have fewer than 200 readable characters, and checks again in `2min` (`10min` after an image was taken). If a window's text has not changed, the judge is not asked again.
- Screenshot limits: at least 30 s apart, at most 20 in any rolling hour and 200 in any rolling 24 hours.
- Continuous observation stores window text, screenshots, and session hook payloads in a shared store with tiered retention: full sources are kept 48 hours, and strings over 4096 characters in hook payloads keep only their first and last 2048; analyses and cited work events are kept 30 days. `capture.jsonl` records why each request was made, refused, or uploaded; `capture-judge.jsonl` records the judgements with only the app, source, and character count.
- `--share-window-text`: the live context includes text received from the focused window in the last 300 s. `--share-screenshots`: only then are image requests sent, and the character kernel's model describes the images; while off, `POST /look` returns 409 `vision_off`.

## Interaction presets

Companion's `interaction_preset` maps to agentd's `--interaction-preset quiet|balanced|active` (default `balanced`) and sets the pace of background analysis, proactive speech, and autonomous movement. It never delays the user's direct requests, stops, or drags, and adds no output tokens per call. `interaction` in `GET /diag/state` returns the actual parameters.

| Preset | Behavior judgement min interval / refresh without change | Proactive speech same-kind cooldown | Random movement interval factor |
|---|---|---|---|
| `quiet` | 600 / 1800 s | proactive speech off | 2 |
| `balanced` | 180 / 900 s | 600 s | 1 |
| `active` | 120 / 600 s | 300 s | 0.75 |

These are per-module throttles, not one token or cost cap.

## Consent and lifecycle

- `observation.privacy.ConsentPolicy` is the live consent version shared by collection caches and outbound text. The config named by `--privacy-config` can narrow the startup capabilities; a missing, corrupt, or half-replaced file refuses all sharing. Turning a share off or narrowing its scope clears old caches, pending observations, and related generations, and refuses late results; turning it back on does not restore old caches. The sync endpoint `POST /context/privacy/sync` is in C6 §4.2.
- A character reply checks the generation once more right before it opens the model stream; a cancel closes the underlying connection first. A request already sent to the model cannot be recalled, but later clauses, late output, and history appends after the cancel are blocked.
- `sessions.lifecycle.SessionRun` covers the startup phase before the CLI handshake. Stop, shutdown, and reset all latch the cancel; a process built late is closed.
- `infra.data_lifecycle.DataLifecycle` declares a reset policy for every table in the shared SQLite stores; a new unclassified table makes a reset return 500 `reset_schema_unclassified`. `memory_settings`, `capture_budget`, and `model_usage` are kept, so clearing data neither resets the user's pause switch nor bypasses budgets.

## Character kernels

`character_agent/` runs the main character conversation. Ordinary conversation is reasoned, tool-called, and checked directly by the selected kernel; outside dispatch the user asks for explicitly still goes through own sessions. The bundled Pi (default), a local Codex, a local Claude Code, and local agents through ACP share one set of product tools, tasks, and semantic services. If the native kernel is unavailable, the call fails explicitly. The persona card sets identity and voice; the current tools and grants set what she can actually do.

### Layout

- `services/`: product domain services (storage, goals and tasks, deliveries, workspace, questions and approvals, memory, knowledge, observation and briefs, semantic tasks, settings, capabilities and embodiment); they depend on no other subdirectory of the package.
- `harness/`: each kernel's config, discovery, isolation, transport, and runner subprocess (including `pi_runner.mjs`); depends only on `services/`.
- `routes/`: the package's HTTP routes; depend only on `services/`.
- Root: `integration.py`, `runtime.py`, `presentation.py`, and `pi-runtime/`, which wire the three layers together.

### Data and execution boundaries

- `integration.py` connects the current card, lore, memory, history, episodes, reminders, behavior observations, file scopes, and desktop permissions to the runtime.
- `runtime.py` manages the lifecycle of character runs, tasks, and checkpoints; `harness/codex_runner.py`, `pi_runner.mjs`, `acp_runner.py`, and `claude_runner.py` run the model loop through their SDK or protocol (frame protocol in the [C8 contract](../../protocol/C8-harness-runner/CONTRACT.md)).
- `services/knowledge.py` searches the personal profile and history by source and permission. Dependencies carry versions and hashes, so deleting a memory, revoking a permission, or changing an input invalidates old context.
- `services/workspace.py` reaches only the input and output directories the user chose in settings; it reads UTF-8 Markdown, TXT, CSV, JSON, and docx, xlsx, pptx (extracted to text by `services/extract.py`), writes artifacts only as Markdown, TXT, CSV, JSON, and refuses directory escape, symbolic links, and overwriting source files. Each artifact belongs to a run and records its sources and check results.
- `services/store.py` stores its own Run, Event, Effect, and Checkpoint records. The character, product history, long-term memory, and task IDs belong to no vendor transcript; vendor-native sessions do not move between kernels.
- Her final answer reuses the existing text, intent marker, speech, playback settlement, and history pipeline; a foreground run checks its results before it delivers the answer.

### Kernel selection and discovery

- In 设置 › 角色内核 (Settings › Character kernel) the user picks the kernel, sign-in source, model, and data scope. Without saved settings Pi is used; only when Pi is unavailable does it fall back to a signed-in local Codex.
- Pi ships with the app; the packaged app finds `node/bin/node` and `pi-runtime/` through `--harness-site harness.pi=DIR`. Codex and Claude Code use local installs only.
- The ACP kernel drives a local ACP v1 agent over stdio: the selectable agents are listed in `harness/acp_registry.json`, installed ones are found through `LOCAL_COMMANDS` in `harness/acp_agents.py`, and missing ones can run through npx or uvx. The agent manages its own sign-in and model connection; Agentic Complex's tools reach it over stdio MCP.
- Codex uses the App Server stdio adapter with product dynamic tools; Codex manages its own sign-in and Agentic Complex copies no token.
- Automatic discovery checks only known CLI entry points or an executable the user picked. Version numbers are diagnostic only; at start the adapter checks the SDK interfaces, isolation options, effective config, and actual tools, and returns a specific error when a capability the turn needs is missing, without loosening the tool boundary.
- Discovery results are cached for 30 seconds; a change in the executable's real path, inode, size, or modification time invalidates them at once. A full discovery probes at most 4 entry points in parallel.
- Codex runs with its built-in execution tools, global MCP and extensions, and automatic approval disabled, and the effective config and tool list are checked. Codex's global `AGENTS.md` and `AGENTS.override.md` are blocked from being read by starting the process under macOS `sandbox-exec`; user files are not changed.

### Tools, MCP, Skills, and questions

`services/interactions.py` manages persistent questions, answer versions, and one-time approvals. In conversations the kernel uses its own tools, MCP servers, and Skills; Pi reads the user's own Pi config (see `pi-runtime/RUNTIME.md`). agentd adds no MCP or Skills gateway of its own. Tool authorization is in the [tool gateway](tool-gateway.en.md).

### Tasks, cancellation, and resumption

- Ordinary chat creates no task. A file task starts with `task_plan`, then reads sources, writes files, and calls `artifact_read` and `artifact_verify`; the server then reads the actual bytes to check them. Acceptance conditions given by the user or the API cannot be weakened by the model; a task that passed only structural checks goes to "needs review".
- Switching kernels cancels the foreground run, invalidates old internal semantic tasks, and closes the old main session; background tasks already started keep their original kernel and continue.
- Continuing from a task card gives the same task ID a new run ID; the new kernel reads the product checkpoint and reads earlier output through `artifact_read_previous`. A change in source files, knowledge dependencies, character, or scope refuses the resumption. An unknown desktop effect is never replayed automatically.
- Proactive greetings use the selected kernel with knowledge reads open; gift and ritual turns can additionally request facing and read receipts, but get no file, desktop, memory, or background work permissions. Temporary conversations cannot write files or act on the desktop and write no long-term history.
- `reminders_list`, `reminder_create`, and `reminder_update` let the character handle explicit one-time reminders through the reminder store; writes have persistent idempotency receipts and changes check the revision. Reminders work only while the app runs.

### Background jobs

- A stable `job_id` identifies the work; each resumption creates a new `run_id`. Asynchronous results are committed after comparison with `expected_run_id`, so an old run cannot overwrite a newer one.
- One foreground turn, two background execution slots, and one quiet semantic slot are managed separately. Cancelling ordinary chat cancels no other work; revocation, reset, and shutdown share one invalidation path.
- The user's original request is user input; work splits the model generated are observation material. Background work cannot fan out recursively, widen the original scope, or weaken check conditions.
- Only checks the user or the API declared make a job `succeeded`; passing conditions the model wrote itself leaves it at `needs_review`.

### Observation briefs

- `services/observation_briefs.py` builds daily and weekly briefs from continuous observation's cited work events, item summaries, and activity segments: development details, recurring problems and improvements, suggested next steps, and coverage gaps. The semantic task can run on the Codex, Pi, ACP, or Claude kernel.
- Every verbatim quote is checked; a recurring problem needs at least two independent instances that do not overlap in time. Suggestions create no goals, background work, or long-term facts.
- By default, after 09:00 in the system time zone, it produces the previous day's daily brief and the weekly brief of the last complete week (Monday to Sunday); the switch, hour, and IANA time zone are settable. Nothing runs while the app is not running; a restart catches up only the latest complete period. Empty data calls no model; after a failure it waits at least an hour before trying again. Briefs are kept at most 30 days.
- The first packet holds 12000 characters for a daily brief and 22000 for a weekly one; a brief gets 120 seconds and at most 12 turns at medium reasoning, and at most 3 brief calls run per day.

### Memory and generation log

- The main conversation uses `memory_propose`; the product verifies explicit requests, verbatim evidence, and the current version. Automatic extraction, live interpretation, image understanding, and proactive judgements all run on the selected kernel through `SemanticService`, with no fallback to a separate model API.
- A whole user utterance, or the text of an explicit memory request, can become a user assertion; other automatically extracted facts are candidates that take effect only after confirmation.
- `MemoryTurn.commit_extraction` commits items, facts, source cursors, and log receipts in the same transaction while the caller holds the memory lock; if the record was cleared or invalidated, everything rolls back.
- The generation log records the full request, visible output, capabilities, tool arguments and results, candidates, and commit or rejection reasons; hidden chains of thought are not stored. Details are kept 48 hours and metadata 30 days; forgetting, revocation, or reset clears them earlier.

### Continuous observation

`services/observation.py` is the resident understanding service: native AX walks run in time slices and resume, full text and tree nodes are stored in content-addressed chunks, screenshots keep their pixels, and OCR keeps text with coordinates. Understanding runs on its own schedule, 120 seconds and at most 16 tool calls each time, within any narrower limits of the selected kernel's settings. The `observation_status`, `search`, `read`, `changes`, `image`, and `refresh` tools serve observation, the main conversation, and briefs alike; `refresh` only requests a capture and never clicks, types, scrolls, or activates a window. The analysis queue is persistent, and an unchanged revision is not reasoned over again.

### New kernel adapters

An adapter implements `stream(prompt, system_prompt, history, cancelled, run_id, tool_handler)`, which yields the events `ready`, `text_delta`, `tool_started`, `tool_finished`, `result`, and `error`, plus `interrupt`, `invalidate`, and `close`. `tool_started` uses the `args` field and `tool_finished` uses `result`; both keep the real `tool_call_id` and go to the product services through `tool_handler.call_with_context`. Cancellation must not block on a tool lock that waits for user consent; late tool writes are checked again against the run and generation. An own-session resume mechanism must never be the only copy of product memory.

A new adapter also states its model and provider range, entry version, credential source, whether tool limits can be verified, the cancellation protocol, whether cost limits are supported, and its packaged dependencies and licenses.

### Limits

- File deliveries support Markdown, TXT, CSV, and JSON only.
- Internal image understanding hands images to the selected kernel through `observation_image`, granted per turn; logs keep only the read event and a hash.
- The product desktop tools are Agentic Complex's own text and AX bridge, not Claude's or Codex's Computer Use; `desktop_task` is described in the [tool gateway](tool-gateway.en.md).
- Codex supports no hard dollar budget; tool-call counts and time limits are used instead.
- Settings show `capabilities.features`; an implementation flag does not replace checking versions, accounts, and real tasks.

## Pi kernel

The Pi kernel uses a pinned `@earendil-works/pi-coding-agent` (version in `character_agent/pi-runtime/package.json`) and needs Node 22.19.0 or later. The lock files, license manifest, isolation, and budget rules are in [`pi-runtime/RUNTIME.md`](../../agent/agentd/character_agent/pi-runtime/RUNTIME.md), which every install copies into the runtime directory.

To install the runtime for a source checkout:

```sh
python3 agent/agentd/character_agent/harness/pi_install_runtime.py \
  --destination .local/pi-runtime --npm /absolute/path/to/npm
```

A release puts a standalone Node distribution and this locked npm tree into the `harness.pi` component (`node/bin/node`, `pi-runtime/node_modules/`); release packaging locks the Node version and archive SHA256, keeps Node's original LICENSE, and checks its dynamic libraries. When an explicit runtime root is given, the resolver never falls back to developer paths. Claude and Codex use the CLIs installed on the user's machine.

## Tests

From the repository root:

```sh
export AGENTD_DEV_CATALOG="$PWD/agent/agentd/tests/fixtures/characters/current.json"
agent/.venv/bin/python -I -m unittest discover -s agent/agentd/tests -p 'test_*.py'
node --test agent/browser/extension/test_*.mjs
```

`AGENTD_DEV_CATALOG` points at the synthetic test character library (placeholder personas, no game content). It is generated from `agent/agentd/tests/fixtures/characters-src/`; do not edit it by hand. After changing a source file, update the SHA-256 and byte counts of the files listed in each `character.json`, then regenerate from the repository root:

```sh
out=$(mktemp -d)/lib && agent/.venv/bin/python3 -I agent/agentd/character_tool.py compose \
  $(for c in cedar birch aster dahlia elder; do echo --package agent/agentd/tests/fixtures/characters-src/$c; done) \
  --default birch --output "$out" \
  && find agent/agentd/tests/fixtures/characters -mindepth 1 -delete \
  && cp -R "$out"/ agent/agentd/tests/fixtures/characters/
```
