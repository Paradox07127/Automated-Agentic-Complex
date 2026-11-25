# Tool gateway and authorization paths

[简体中文](tool-gateway.md)

For each tool call offered to a model, `agent/agentd/tool_gateway/` selects the authorization method, timeout, and revocation behavior, and records events in the shared decision trace and effect ledger. Companion makes the final decision on desktop access through its native prompt, stop, and takeover controls. The gateway names the method, holds the agentd side of the desktop lease, and records events.

| Module | Contents |
|---|---|
| [policy.py](../../agent/agentd/tool_gateway/policy.py) | `ApprovalPolicy` (the `POLICY` singleton), `Verdict`, `METHODS`, `WINDOWS`, `MIRRORS`, and `REVOKE_ON`. The only module that calls `danger.classify`. |
| [registry.py](../../agent/agentd/tool_gateway/registry.py) | `ToolSpec`, `BUILTIN` (metadata for every built-in tool), `ToolRegistry.offer()`, and `mcp_tools()`. |
| [ledger.py](../../agent/agentd/tool_gateway/ledger.py) | `EffectLedger`, the only read and write API for the `character_effects` table in `runs.sqlite`, and `ledger_path()`. |
| [desktop.py](../../agent/agentd/tool_gateway/desktop.py) | `DesktopLeases` for character runs, plus `release_session`, `status`, and `session_client` for app-owned sessions. This module is the only constructor of `ComputerControlClient`. |
| [computer_toolset.py](../../agent/agentd/tool_gateway/computer_toolset.py) | `available()` and `run_desktop_task()`: `desktop_task` as one bounded sub-run on the `computer` route's kernel. Actions use the same lease through the host, independently of the CLI's computer-use tools. |
| [gateway.py](../../agent/agentd/tool_gateway/gateway.py) | `ToolGateway` (one per `CharacterAgentController`, as `self.tools`), `ToolSession`, and `SessionKey`. |

Rules for dangerous commands and paths live in [danger.py](../../agent/agentd/sessions/danger.py). Each enforcement path keeps its own presenter. Broker cards use [approvals.py](../../agent/agentd/sessions/approvals.py), Companion's authorization panel uses [panel.ts](../../app/electron/src/main/control/panel.ts), and individual approvals use [interactions.py](../../agent/agentd/character_agent/services/interactions.py) and the web card `RoleApprovalStackCard.tsx`.

## Paths

| Path | Caller | Policy call | Method | Presenter | Records |
|---|---|---|---|---|---|
| Claude PermissionRequest (HTTP hook for an app-owned session, or user hook without `X-Agentd-Observe: 1`) | `api/hooks.py` `/hook/claude` → `broker.open` | `POLICY.card` | `card` | Broker card | `approval.*` |
| Codex command and file change approvals | `own.py` `ask` → `broker.open` | `POLICY.card` | `card` | Broker card | `approval.*`, `tool.verdict` |
| Dispatch | `sessions/dispatch.py` → `broker.open(kind="dispatch")` | `POLICY.window("dispatch")`. Prompts bypass danger classification. | `card` | Broker card | `dispatch.*` |
| Codex `desktop_act` approval form (app-owned session) | `mcpServer/elicitation/request` in `own.py` | `POLICY.desktop_elicitation` | `native_panel`, `card` | With an existing window grant, Companion's native panel governs the action. Otherwise the broker presents a card. | `tool.verdict` |
| Character `desktop_*` | Native handler in `integration.py` → `tools.desktop.call` | `POLICY.desktop("character", name)` | `none`, `native_panel` | Companion native panel | `tool.verdict`, `desktop.lease_*`. `desktop_act` and `desktop_task` write to the ledger. |
| Character `schedule_update` (enable, disable, edit, delete or run a schedule now) | `OrchestrationTurn._schedule_update` in `orchestration.py` → `interactions.approve(single_only=True)` | —. Every call shows a card, with no allow-for-this-conversation option. | `card` | Individual approval inbox | Inbox entry |
| Character `settings_update` (companion mode and quiet hours, muted line kinds, observation pause, reply language; never credentials, kernel, privacy blacklist or folder scopes) | `OrchestrationTurn._settings_update` in `orchestration.py` → `interactions.approve(single_only=True)` | —. Every call shows a card, with no allow-for-this-conversation option. | `card` | Individual approval inbox | Inbox entry |
| App-owned session `desktop_*` (MCP facade) | `tools/computer_use_mcp.py` | Companion decides | `native_panel` | Companion native panel | `desktop_act` writes to the ledger with `run_id` of `own:<session_id>`. |
| Approval for a kernel's own tools, including the user's own MCP servers | Kernel runner permission request → `_harness_permission` in `integration.py` → `interactions.approve` | —. With approval on, Pi asks for `bash`, `powershell`, `write`, `edit`, and every `mcp__*` call. codex, claude, and acp ask when their CLI asks. | `exact_call` | Individual approval inbox | Inbox entry |
| Other built-in character tools | `runtime.py` → `tools.registry.offer(mode, ...)` | Availability determined by mode | `none`, `run_actions`, `scope` | — | — |
| Task verification commands | `check_verify` in `sessions/tasks.py` | `POLICY.verify_command` | `none` | — | — |
| Codex hook or user hook with `X-Agentd-Observe: 1` | Hook branch in `api/hooks.py` returns directly | — | `observe_only` | CLI approval | — |

`tool.verdict` carries `tool, method, dangerous, rule, reason`. `ApprovalBroker.report` writes it to the decision trace (see [trace_format.py](../../agent/agentd/traces/trace_format.py)). Character paths use the run ID and app-owned sessions use the session ID.

## Methods

| Method | Meaning | Prompt window | Authorization lifetime |
|---|---|---|---|
| `none` | Available without prompting for read-only tools, and tools that revoke their own grant. | — | Current call |
| `run_actions` | The run mode determines availability. `actions` is a foreground text or voice run recorded in memory. Offered tools are callable. | — | Current run |
| `scope` | Restricted to the workspace in the run's `scope_id`. | — | Current run |
| `card` | Broker card. Dangerous calls use `single_only` and offer a one-time grant. | Hook card `hook_timeout - margin` (55 s by default), or `dispatch` for dispatch | Current call or a user-selected session scope |
| `native_panel` | Companion's desktop prompt grants access for a session, process generation, window, and geometry. agentd names the method. | `native_wait` | `native_grant_ttl`, with separate controls below |
| `exact_call` | One individual approval card per kernel tool call. | `exact_call` | Current call |
| `observe_only` | agentd displays the event and the CLI handles approval. | — | CLI decides |

## Time limits

| Name | Value | Unit | Location | Meaning |
|---|---|---|---|---|
| `dispatch` | 600 | s | `WINDOWS` | Time for the user to answer a dispatch card |
| `exact_call` | 180 | s | `WINDOWS` | Time for the user to answer an individual approval |
| `native_grant_ttl` | 600 | s | `MIRRORS` (enforced by Companion) | Maximum window grant lifetime |
| `native_snapshot_ttl` | 15 | s | `MIRRORS` (enforced by Companion) | Lifetime of an observation snapshot |
| `native_wait` | 180 | s | `MIRRORS` (enforced by Companion) | Time for the user to answer the native prompt |
| `native_control_actions` | 5 | actions | `MIRRORS` (enforced by Companion) | Maximum actions in one control grant |
| `native_control_window` | 120 | s | `MIRRORS` (enforced by Companion) | Lifetime of one control grant |
| `IDLE_RELEASE` | 120 | s | `desktop.py` | Time to retain the character lease after the last conversation run ends |
| `ACQUIRE_WAIT` | 3 | s | `desktop.py` | Maximum time for a new lease to wait for release in progress |

`POLICY.window(name)` reads `WINDOWS`. `ControlConsent` in [computer-control.ts](../../app/electron/src/common/computer-control.ts) enforces the values that agentd mirrors in `MIRRORS`.

### Control grants

A single action grant applies to the authorized window for up to five actions or 120 seconds, whichever comes first. A `type` or `set_value` write consumes the full grant. Requesting another window immediately invalidates the control grant. After the grant is consumed or expires, `desktop_act` returns `approval_required` and the user must approve again. An old snapshot still returns `stale_snapshot` and the action is discarded.

## Revocation

| Method | Revocation reasons |
|---|---|
| `native_panel` | `run_end`, `turn_cancelled`, `user_cancelled_task`, `context_changed`, `scope_revoked`, `memory_changed`, `history_cleared`, `runtime_changed`, `shutdown`, `own_delete`, `own_interrupt`, `own_idle`, `own_stop`, `own_turn_end`, `conversation_idle`, `conversation_switch` |
| `exact_call` | `call_returned`, `expired`, `run_invalidated`, `shutdown` |
| `card` | `expired`, `tool_event`, `agent_stopped`, `session_ended`, `shutdown`, `reset` |

### Release and cancellation

`desktop_release` returns desktop access quietly. `desktop_cancel` cancels the task. Older Companion versions that lack `desktop_release` fall back to `desktop_cancel`.

| Reason | Native call | Initiator |
|---|---|---|
| `run_end` | `desktop_release` | Character run ends as `ToolSession` exits. If the run belongs to a conversation, this starts the `IDLE_RELEASE` timer. Runs that used `desktop_task` release immediately. |
| `conversation_idle` | `desktop_release` | `IDLE_RELEASE` has elapsed after the last run in a conversation. |
| `conversation_switch` | `desktop_release` | A run from a different conversation starts. |
| `shutdown` | `desktop_release` | agentd shuts down. |
| `own_turn_end` | `desktop_release` | Each app-owned session turn ends. |
| `own_idle` | `desktop_release` | App-owned session is reaped when idle. |
| `turn_cancelled` | `desktop_cancel` | Character turn is cancelled. |
| `user_cancelled_task` | `desktop_cancel` | User cancels the character task. |
| `context_changed`, `scope_revoked`, `memory_changed`, `history_cleared`, `runtime_changed` | `desktop_cancel` | Changes that invalidate a character run via `close_all` or individual `close`. |
| `own_delete`, `own_interrupt`, `own_stop` | `desktop_cancel` | App-owned session is deleted, interrupted, or stopped. |

### Character desktop leases

- One lease per conversation, or per run when no conversation exists. The first `desktop_*` call opens it. The native session ID is `character:<conversation_id>`, or `character:<run_id>` outside a conversation. Subsequent runs in the conversation reuse the lease.
- Release occurs `IDLE_RELEASE` after the last run ends. A new run in the same conversation cancels the timer. A run in another conversation releases the previous lease immediately.
- The `desktop_cancel` reasons above revoke access immediately.
- Companion holds one grant at a time. A new lease waits up to `ACQUIRE_WAIT` for an in-progress release to avoid `desktop_busy` on the next run.
- Ordinary desktop tools return `image_bridge_unavailable` for `include_image`. Outbound text is filtered and image fields are dropped. The internal `computer_call` for `desktop_task` uses the same lease to pass images in memory. Images stay out of the trace.
- `desktop_task` (`available()`) requires a `computer` route kernel whose adapter passes image tool results to the model (pi, codex, or claude; for acp, the probed `promptCapabilities.image` must be true), the Companion bridge, and enabled computer use reported by the bridge. The sub-run offers only screenshot, click (one left click), type (replaces the whole value of a text control from the latest screenshot), vertical scroll, and done. Click, type, and scroll need a fresh screenshot first and otherwise return `screenshot_required`. Every call except done counts as a step, with a default and limit of 30 steps (`max_actions`), and the whole task runs for up to 180 seconds. A grant error from the host ends the run with `grant_required` immediately, without waiting or retrying. Screenshots reach the kernel in memory only; events record just the member name, step count, and result code.

### App-owned session desktop grants

An app-owned session uses its session ID as the native session ID. Each turn releases access with `own_turn_end`. A later turn requires a new grant, so an ended app-owned turn leaves the character free of `desktop_busy` from that grant.

## Effect ledger

`EffectLedger` is the sole API for the `character_effects` table in `<state_dir>/character-agent/runs.sqlite` (`prepare`, `settle`, `effect`, `effects`, `unsettled`, `reconcile`, and `forget_run`). The table and columns are shared with older agentd versions that use the same state directory.

| Writer | Tool | `run_id` | Receipt |
|---|---|---|---|
| Character run (`runtime.py`) | `desktop_act`, `desktop_task` | Character run ID | `{"effect", "tool"}`. `committed` when `effect` is `confirmed`, otherwise `unknown`. |
| App-owned session MCP facade (`computer_use_mcp.py`, `--ledger`) | `desktop_act` | `own:<session_id>` | Same as character `desktop_act`. |

- Reusing an effect ID returns the original receipt for `committed` and `effect_unknown` for other states. Different input or a different run returns `effect_conflict`.
- A handler exception records `unknown`. A process exit leaves `prepared` for cleanup on restart. A character run with unsettled effects cannot resume and reports `effect_unknown`.
- The facade opens its own connection using `EffectLedger.open` with WAL and a five-second timeout. If the ledger cannot open or write, `desktop_act` proceeds and logs a diagnostic to stderr. Deleting the app-owned session removes its receipts with `forget_run("own:<session_id>")`.
- The workspace `effects` table is the write-ahead log for artifact writes. `EffectLedger.reconcile` reads it.

## Registry

`BUILTIN` provides a `ToolSpec` for each built-in tool. The schemas live in their owning modules. `ToolRegistry.offer(mode, definitions)` keeps every registered definition whatever the mode and drops unregistered names (deny by default). A tool the mode does not allow returns `tool_not_allowed_in_mode` from `call()` in `runtime.py`. The app-owned session MCP facade lists tools with `mcp_tools("own_session")`.

| Family | Tools | Methods | Callers | Modes |
|---|---|---|---|---|
| `knowledge` | `personal_profile`, `knowledge_search`, `knowledge_read`, `task_context`, `behavior_context`, `observation_status`, `observation_search`, `observation_read`, `observation_changes`, `observation_image`, `observation_refresh` | `none` | `character`, `character_side`, `character_background` | All |
| `desktop` | `desktop_status`, `desktop_observe`, `desktop_act`, `desktop_verify`, `desktop_cancel`, `desktop_task` | `none`, `native_panel` | `character`, `own_session` | `actions` |
| `embodied` | `avatar_face`, `avatar_facing_status`, `avatar_motions_list`, `avatar_motion` | `none` | `character` | `actions`, `embodied_only` |
| `workspace` | `workspace_list`, `workspace_read`, `workspace_image`, `workspace_search`, `artifact_write`, `artifact_read`, `artifact_verify` | `scope` | `character`, `character_background` | `actions`, `background` |
| `task` | `task_plan`, `artifact_read_previous` | `run_actions`, `scope` | `character`, `character_background` | `actions`, `background` |
| `memory` | `memory_propose` | `run_actions` | `character` | `actions` |
| `orchestration` | `dispatch_session`, `dispatch_status`, `reminders_list`, `reminder_create`, `reminder_update`, `goals_list`, `goal_create`, `goal_update`, `background_start`, `background_status`, `background_cancel`, `task_continue`, `schedule_propose`, `schedules_list`, `schedule_update`, `settings_read`, `settings_update` | `none`, `card`, `run_actions` | `character` | `actions` |
| `interaction` | `ask_user` | `none` | `character`, `character_background` | `actions`, `background` |

`desktop_task` is offered only to `character`, outside the app-owned session MCP tool list. `desktop_act` and `desktop_task` carry a `receipt`. UI effects require separate confirmation, so `desktop_task` keeps its aggregate receipt as `unverifiable`.

## Computer use

Own Claude and Codex sessions and the character's own runs use one set of desktop tools, `desktop_status`, `desktop_observe`, `desktop_act`, `desktop_verify`, and `desktop_cancel`, which Companion executes natively with AX and targeted events: own sessions call them through a temporary MCP config, and character runs reach them directly through agentd's `DesktopLeases` (see "Character desktop leases" above). There is no second planning model, and the user's global MCP config is never changed.

### Enabling and granting

1. Turn on 设置 › 隐私 › 允许会话请求电脑操作 (Settings › Privacy › Allow sessions to request computer use; config key `computer_use_enabled`, default `false`), save, restart the background services, and start a new session. While the switch is off, the executor reads it again before every request and action and refuses.
2. A session must name the target app's bundle ID or PID, and also a `window_id` when the app has several windows. `desktop_status(target)` lists only that app's window numbers and geometry, without titles.
3. The first observation opens a grant panel above the character, which waits at most `native_wait`. The user checks the app, window number, and session, then separately allows inspecting controls, reading text, taking a screenshot, and acting; the system's Accessibility or Screen Recording permission does not replace this per-task grant. System permissions are requested only when the matching grant is clicked; screenshots also need Screen Recording.
4. An observation returns a snapshot and element references; after an action, observe again and verify with an explicit expected value or title. `effect=unverifiable` only means the action was sent and does not count as done.
5. Real keyboard or mouse input from the user pauses the task at once and invalidates old observations but keeps the grant; after 继续 (Continue) the session must observe again. The 停止 (Stop) button above the character, closing the panel, or expiry ends the grant. A grant is bound to the same session, process generation, window, and geometry; moving or replacing the window needs a new grant. Apps are never activated and the system pointer never moves on its own.

`read_only` sessions have no `desktop_act`; acting needs a `workspace_write` session plus the session's own approvals and a native control grant. `type` and `set_value` both replace the whole AXValue and append no keystrokes. Supported are AXPress, AXValue writes, and clicks and scrolls at window coordinates; drag and drop, hotkeys, the clipboard, and file operations are not.

### Desktop bridge limits

- Only native apps are supported; a browser target returns `browser_driver_required`.
- Coordinate actions need the target in front and check that the hit control belongs to the same window. In the background AX semantics come first; when the app refuses, the call returns a refusal and focus is never taken.
- Each observation exports at most 80 controls, queues 128 nodes, and returns 4000 characters of titles and values; the AX read takes about 1 second and a single AX IPC call 50 ms. Screenshots cover only the granted window, as PNG of at most 2.5 MB; sensitive image content is not masked automatically.
- Password and secure controls, system secure input, and app and title blacklists all block. Text always masks common credentials, email addresses, and phone numbers, but not every kind of sensitive content can be recognized. AX text is low-trust data.
- Snapshots expire after 15 seconds, and an action uses up all old references; failures and timeouts are never replayed. Actions are at least 250 ms apart. The host is the final authority; a model cannot grant itself permission.
- The helper's `control.listen` sets up the local endpoint and token ([C12 contract](../../protocol/C12-platform-helper/CONTRACT.md)); on macOS they live in `<support dir>/run/`. The token never enters tool arguments, models, or logs. This does not isolate against malicious programs in the same OS account.
- These grants constrain only the desktop bridge. The CLI's own shell and other MCP abilities stay under its own sandbox and approval settings.

### Wiring

`app/electron/src/common/computer-control.ts` and `app/electron/src/main/control/{host,panel,shell}.ts` manage grants, interruptions, and the grant panel; the macOS executor is in `app/helpers/mac/Sources/HelperCore/{Control,ControlListen}.swift`. agentd's `--computer-control-socket` and `--computer-control-token-file` must be given together; without them no MCP is injected. Codex gets a per-process `mcp_servers.agentic_complex_desktop`, Claude a temporary 0600 `--mcp-config`. The session's own permission mode is unchanged.

Turning it off: turn the switch off in settings and restart the background services, and new sessions no longer get desktop tools; to stop at once, use 停止 (Stop) above the character. System permissions need not be revoked; to revoke everything, turn off the matching Agentic Complex permissions in System Settings.

### Synthetic window acceptance

`agent/computer-control/ControlFixture.swift` is a standalone AppKit window with only test text, an input field, a button, and a result label; it opens no user files or accounts. First compile it with `swiftc -framework AppKit` into a standalone `.app` (the bundle ID must be `local.agenticcomplex.controlfixture`) and start it, then run:

```sh
python3 agent/computer-control/acceptance.py \
  --support-dir /absolute/test/support \
  --exercise-fixture
```

The script returns at once: without a grant, the first run opens the grant panel and exits with 2; it never approves automatically or polls. After the user grants, run it again: it writes synthetic text → reads it back in full → refuses an old snapshot → presses the test button with AXPress → verifies the result in a new observation → cancels the task. Without `--exercise-fixture` it runs read-only checks. The script targets only this fixed window and touches no user app.
