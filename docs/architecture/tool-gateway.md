# 工具网关与授权路径

[English](tool-gateway.en.md)

agentd 给模型的每个工具调用，由 `agent/agentd/tool_gateway/` 决定走哪种授权方法、等多久、什么时候撤销，并记进同一份决策 trace 和效果账本。Companion 仍是桌面授权的最终决定者（原生小窗、停止、接管）；网关只命名方法、持有 agentd 这一侧的桌面租约、记录发生了什么。

| 模块 | 内容 |
|---|---|
| [policy.py](../../agent/agentd/tool_gateway/policy.py) | `ApprovalPolicy`（单例 `POLICY`）、`Verdict`、`METHODS`、`WINDOWS`、`MIRRORS`、`REVOKE_ON`；唯一调用 `danger.classify` 的模块 |
| [registry.py](../../agent/agentd/tool_gateway/registry.py) | `ToolSpec`、`BUILTIN`（每个内置工具的元数据）、`ToolRegistry.offer()`、`mcp_tools()` |
| [ledger.py](../../agent/agentd/tool_gateway/ledger.py) | `EffectLedger`：`runs.sqlite` 里 `character_effects` 表的唯一读写入口；`ledger_path()` |
| [desktop.py](../../agent/agentd/tool_gateway/desktop.py) | `DesktopLeases`（角色 run 的桌面租约）；own 会话用的 `release_session` / `status` / `session_client`；唯一构造 `ComputerControlClient` 的地方 |
| [computer_toolset.py](../../agent/agentd/tool_gateway/computer_toolset.py) | `available()`、`run_desktop_task()`：`desktop_task` 在 `computer` 路由内核上开的一次受限子运行，动作经过同一租约；不使用 CLI 自带 computer-use |
| [gateway.py](../../agent/agentd/tool_gateway/gateway.py) | `ToolGateway`（每个 `CharacterAgentController` 一个，即 `self.tools`）、`ToolSession`、`SessionKey` |

规则本身（危险命令、路径）在 [danger.py](../../agent/agentd/sessions/danger.py)；三个呈现者保持各自的位置：broker 卡片（[approvals.py](../../agent/agentd/sessions/approvals.py)）、Companion 授权小窗（[panel.ts](../../app/electron/src/main/control/panel.ts)）、逐次审批收件箱（[interactions.py](../../agent/agentd/character_agent/services/interactions.py)，网页卡片 RoleApprovalStackCard.tsx）。

## 路径

| 路径 | 调用者 | 策略调用 | 方法 | 呈现者 | 记录 |
|---|---|---|---|---|---|
| Claude PermissionRequest（own 会话的 http hook，或未带 `X-Agentd-Observe: 1` 的用户 hook） | `api/hooks.py` `/hook/claude` → `broker.open` | `POLICY.card` | `card` | broker 卡片 | `approval.*` |
| Codex 命令 / 文件改动审批 | `own.py` `ask` → `broker.open` | `POLICY.card` | `card` | broker 卡片 | `approval.*`、`tool.verdict` |
| 派活（dispatch） | `sessions/dispatch.py` → `broker.open(kind="dispatch")` | `POLICY.window("dispatch")`；提示词不判危险 | `card` | broker 卡片 | `dispatch.*` |
| Codex 的 `desktop_act` 审批表单（own 会话） | `own.py` 的 `mcpServer/elicitation/request` | `POLICY.desktop_elicitation` | `native_panel`, `card` | 已有窗口授权时直接接受、由原生小窗把关；否则 broker 卡片 | `tool.verdict` |
| 角色的 `desktop_*` | `integration.py` 的原生处理 → `tools.desktop.call` | `POLICY.desktop("character", name)` | `none`, `native_panel` | Companion 原生小窗 | `tool.verdict`、`desktop.lease_*`；`desktop_act` / `desktop_task` 进账本 |
| 角色的 `schedule_update`（启用、停用、修改、删除、立即运行计划任务） | `orchestration.py` `OrchestrationTurn._schedule_update` → `interactions.approve(single_only=True)` | 无；每次调用都发卡，不给「本对话都允许」 | `card` | 逐次审批收件箱 | 收件箱条目 |
| 角色的 `settings_update`（主动陪伴与免打扰时段、静音的主动类型、暂停观察、回复语言；凭据、内核、隐私黑名单和文件夹范围不在其中） | `orchestration.py` `OrchestrationTurn._settings_update` → `interactions.approve(single_only=True)` | 无；每次调用都发卡，不给「本对话都允许」 | `card` | 逐次审批收件箱 | 收件箱条目 |
| 内核自带工具（含用户自己的 MCP 服务）的审批 | 内核 runner 的权限请求 → `integration.py` `_harness_permission` → `interactions.approve` | 无；Pi 开审批时 `bash`、`powershell`、`write`、`edit` 和每个 `mcp__*` 调用都发请求，codex、claude、acp 按各自 CLI 的请求 | `exact_call` | 逐次审批收件箱 | 收件箱条目 |
| own 会话的 `desktop_*`（MCP facade） | `tools/computer_use_mcp.py` | 无；Companion 决定 | `native_panel` | Companion 原生小窗 | `desktop_act` 进账本，`run_id` 为 `own:<session_id>` |
| 角色的其它内置工具 | `runtime.py` → `tools.registry.offer(mode, ...)` | 无；传入的定义都提供，调用时按模式拒绝（`tool_not_allowed_in_mode`）；记忆、编排、提问工具只在有对应会话的 run 里传入 | `none`, `run_actions`, `scope` | 无 | 无 |
| 任务验证命令 | `sessions/tasks.py` `check_verify` | `POLICY.verify_command` | `none` | 无 | 无 |
| Codex hook、带 `X-Agentd-Observe: 1` 的用户 hook | `api/hooks.py` hook 分支，直接返回 | 无 | `observe_only` | CLI 自己的审批 | 无 |

`tool.verdict` 字段为 `tool, method, dangerous, rule, reason`，经 `ApprovalBroker.report` 进决策 trace（格式见 [trace_format.py](../../agent/agentd/traces/trace_format.py)）；角色路径以 run id 为键，own 会话以 session id 为键。

## 方法

| 方法 | 含义 | 窗口 | 授权寿命 |
|---|---|---|---|
| `none` | 不经授权：只读工具、撤销自身授权的工具 | 无 | 本次调用 |
| `run_actions` | 由 run 的模式决定能否调用（`actions` 是前台 text/voice 且记入记忆的 run）；其它模式调用时返回 `tool_not_allowed_in_mode` | 无 | 本次 run |
| `scope` | 限定在 run 的 `scope_id` 工作区内 | 无 | 本次 run |
| `card` | broker 卡片；危险时 `single_only`，不给「本会话都允许」 | hook 卡片为 `hook_timeout - margin`（默认 55 s）；派活为 `dispatch` | 本次调用，或用户选的会话范围 |
| `native_panel` | Companion 头顶授权小窗按会话、进程代际、窗口和几何授予；agentd 只命名方法 | `native_wait` | `native_grant_ttl`；控制许可见下文 |
| `exact_call` | 内核的一次工具调用一张逐次审批卡 | `exact_call` | 本次调用 |
| `observe_only` | agentd 只展示，由 CLI 自己审批 | 无 | 由 CLI 决定 |

## 时长

| 名称 | 值 | 单位 | 位置 | 含义 |
|---|---|---|---|---|
| `dispatch` | 600 | s | `WINDOWS` | 派活卡片等用户的时间 |
| `exact_call` | 180 | s | `WINDOWS` | 逐次审批等用户的时间 |
| `native_grant_ttl` | 600 | s | `MIRRORS`（Companion 执行） | 一次窗口授权的最长寿命 |
| `native_snapshot_ttl` | 15 | s | `MIRRORS`（Companion 执行） | 一次观察的快照寿命 |
| `native_wait` | 180 | s | `MIRRORS`（Companion 执行） | 原生小窗等用户的时间 |
| `native_control_actions` | 5 | 次 | `MIRRORS`（Companion 执行） | 一次控制许可可用的动作数 |
| `native_control_window` | 120 | s | `MIRRORS`（Companion 执行） | 一次控制许可的寿命 |
| `IDLE_RELEASE` | 120 | s | `desktop.py` | 对话最后一个 run 结束后，角色租约保留的时间 |
| `ACQUIRE_WAIT` | 3 | s | `desktop.py` | 新租约等仍在进行的释放的上限 |

`WINDOWS` 由 `POLICY.window(name)` 读取；`MIRRORS` 的值由 Companion（[computer-control.ts](../../app/electron/src/common/computer-control.ts) 的 `ControlConsent`）执行，agentd 只镜像。

### 控制许可

一次「执行操作」许可只对授权时的那个窗口有效，最多 5 个动作、120 秒，先到者为止；`type` 和 `set_value` 写文字时用掉整次许可，所以打字仍是单次。会话请求另一个窗口时控制许可立即作废。用完或过期后 `desktop_act` 返回 `approval_required`，需要用户重新允许；旧快照照样返回 `stale_snapshot`，不会重放动作。

## 撤销

| 方法 | 撤销原因 |
|---|---|
| `native_panel` | `run_end`, `turn_cancelled`, `user_cancelled_task`, `context_changed`, `scope_revoked`, `memory_changed`, `history_cleared`, `runtime_changed`, `shutdown`, `own_delete`, `own_interrupt`, `own_idle`, `own_stop`, `own_turn_end`, `conversation_idle`, `conversation_switch` |
| `exact_call` | `call_returned`, `expired`, `run_invalidated`, `shutdown` |
| `card` | `expired`, `tool_event`, `agent_stopped`, `session_ended`, `shutdown`, `reset` |

### 释放与取消

桌面授权按原因走两种原生调用：`desktop_release` 交还授权，小窗不显示「任务已取消」；`desktop_cancel` 取消任务。旧版 Companion 不认 `desktop_release` 时退回 `desktop_cancel`。

| 原因 | 原生调用 | 谁发起 |
|---|---|---|
| `run_end` | `desktop_release` | 角色 run 结束（`ToolSession` 退出）；有对话时只启动 `IDLE_RELEASE` 计时；使用过 `desktop_task` 的 run 立即释放 |
| `conversation_idle` | `desktop_release` | 对话最后一个 run 结束满 `IDLE_RELEASE` |
| `conversation_switch` | `desktop_release` | 另一个对话的 run 开始 |
| `shutdown` | `desktop_release` | agentd 关闭 |
| `own_turn_end` | `desktop_release` | own 会话每个回合结束 |
| `own_idle` | `desktop_release` | own 会话空闲回收 |
| `turn_cancelled` | `desktop_cancel` | 取消角色回合 |
| `user_cancelled_task` | `desktop_cancel` | 用户取消角色任务 |
| `context_changed`, `scope_revoked`, `memory_changed`, `history_cleared`, `runtime_changed` | `desktop_cancel` | 失效角色 run 的变更（`close_all` 或逐个 `close`） |
| `own_delete`, `own_interrupt`, `own_stop` | `desktop_cancel` | 删除、打断、停止 own 会话 |

### 角色的桌面租约

- 一个对话一份租约（没有对话时按 run），由该对话第一次 `desktop_*` 调用打开；原生会话 id 为 `character:<conversation_id>`（无对话时 `character:<run_id>`）。同一对话的后续 run 复用它，不再弹窗。
- 最后一个 run 结束后再过 `IDLE_RELEASE` 释放；期间同一对话有新 run 开始则取消计时。另一个对话的 run 开始时立即释放旧对话的租约。
- 取消（上表的 `desktop_cancel` 原因）立即撤销，不等计时。
- Companion 同一时间只持有一个授权；新租约最多等 `ACQUIRE_WAIT` 让仍在进行的释放完成，避免下一个 run 撞上 `desktop_busy`。
- 普通桌面工具不支持 `include_image`（返回 `image_bridge_unavailable`）；返回的文字经出口过滤，图像字段被丢弃。`desktop_task` 的内部 `computer_call` 通过同一租约传递图片，图片只留内存，不进 trace。
- `desktop_task`（`available()`）要求 `computer` 路由的内核能把图片工具结果交给模型（pi、codex、claude；acp 须其探测到的 `promptCapabilities.image` 为 true）、Companion 桥存在且桥报告电脑操作已启用。子运行只提供 screenshot、click（单次左键）、type（整体替换截图里某个文本控件的值）、垂直 scroll、done；click、type、scroll 之前须有新截图，否则返回 `screenshot_required`。除 done 外每次调用计一步，默认与上限都是 30 步（`max_actions`），整个任务最多 180 秒。主机返回授权类错误时立即以 `grant_required` 结束，不等待或重试。截图图片只在内存里交给内核，事件只记成员名、步数和结果码。

### own 会话的桌面授权

own 会话的原生会话 id 就是它的 session id。每个回合结束时以 `own_turn_end` 释放，下一回合需重新授权，所以结束的 own 回合不会让角色撞上 `desktop_busy`。

## 账本

`EffectLedger` 是 `<state_dir>/character-agent/runs.sqlite` 里 `character_effects` 表的唯一 API（`prepare` / `settle` / `effect` / `effects` / `unsettled` / `reconcile` / `forget_run`），表名和列不变，旧版 agentd 共用同一状态目录。

| 写入方 | 工具 | `run_id` | 回执 |
|---|---|---|---|
| 角色 run（`runtime.py`） | `desktop_act`, `desktop_task` | 角色 run id | `{"effect", "tool"}`；`effect` 为 `confirmed` 时 `committed`，否则 `unknown` |
| own 会话 MCP facade（`computer_use_mcp.py`，`--ledger`） | `desktop_act` | `own:<session_id>` | 与角色 `desktop_act` 相同 |

- 同一 effect id 再次调用时，`committed` 返回原回执，其它状态返回 `effect_unknown`；输入或 run 不同则 `effect_conflict`。
- 处理器抛异常时记为 `unknown`；进程退出则留在 `prepared`，由重启清扫处理。角色 run 有未结清的效果时不能续跑（`effect_unknown`）。
- facade 用独立连接（`EffectLedger.open`，WAL，超时 5 s）。账本打不开或写失败时 `desktop_act` 照做，只在 stderr 打一行诊断。删除 own 会话时 `forget_run("own:<session_id>")` 清掉它的回执。
- 工作区的 `effects` 表是产物写入的预写日志，只经 `EffectLedger.reconcile` 读取。

## 注册表

`BUILTIN` 给每个内置工具一条 `ToolSpec`；schema 仍在各自模块里。`ToolRegistry.offer(mode, definitions)` 保留所有已注册的定义，不随模式变化；未注册的名字被丢弃（默认拒绝）。该模式不允许的工具在 `runtime.py` 的 `call()` 里返回 `tool_not_allowed_in_mode`。own 会话的 MCP facade 用 `mcp_tools("own_session")` 列出工具。

| 族 | 工具 | 方法 | 调用者 | 模式 |
|---|---|---|---|---|
| `knowledge` | `personal_profile`, `knowledge_search`, `knowledge_read`, `task_context`, `behavior_context`, `observation_status`, `observation_search`, `observation_read`, `observation_changes`, `observation_image`, `observation_refresh` | `none` | `character`, `character_side`, `character_background` | 全部 |
| `desktop` | `desktop_status`, `desktop_observe`, `desktop_act`, `desktop_verify`, `desktop_cancel`, `desktop_task` | `none`, `native_panel` | `character`, `own_session` | `actions` |
| `embodied` | `avatar_face`, `avatar_facing_status`, `avatar_motions_list`, `avatar_motion`, `avatar_outfits_list`, `avatar_outfit` | `none` | `character` | `actions`, `embodied_only` |
| `workspace` | `workspace_list`, `workspace_read`, `workspace_image`, `workspace_search`, `artifact_write`, `artifact_read`, `artifact_verify` | `scope` | `character`, `character_background` | `actions`, `background` |
| `task` | `task_plan`, `artifact_read_previous` | `run_actions`, `scope` | `character`, `character_background` | `actions`, `background` |
| `memory` | `memory_propose` | `run_actions` | `character` | `actions` |
| `orchestration` | `dispatch_session`, `dispatch_status`, `reminders_list`, `reminder_create`, `reminder_update`, `goals_list`, `goal_create`, `goal_update`, `background_start`, `background_status`, `background_cancel`, `task_continue`, `schedule_propose`, `schedules_list`, `schedule_update`, `settings_read`, `settings_update` | `none`, `card`, `run_actions` | `character` | `actions` |
| `interaction` | `ask_user` | `none` | `character`, `character_background` | `actions`, `background` |

`desktop_task` 只提供给 `character`，不会进入 own 会话的 MCP 工具清单。`desktop_act`、`desktop_task` 带 `receipt`；循环结束并不确认 UI 效果，`desktop_task` 的聚合回执保留为 `unverifiable`。

## 电脑操作

自有 Claude、Codex 会话和角色自己的 run 用同一组桌面工具 `desktop_status`、`desktop_observe`、`desktop_act`、`desktop_verify`、`desktop_cancel`，由 Companion 原生执行 AX 和定向事件：自有会话经临时 MCP 配置调用，角色 run 由 agentd 经 `DesktopLeases` 直接调用（见上文「角色的桌面租约」）。没有第二个规划模型，也不改用户全局的 MCP 配置。

### 启用与授权

1. 设置 › 隐私 › 「允许会话请求电脑操作」（配置键 `computer_use_enabled`，默认 `false`），保存并重启后台，再新建会话。开关关着时，执行端在每次请求和动作前回读它并拒绝。
2. 会话要指定目标应用的 bundle ID 或 PID；多窗口时还要 `window_id`。`desktop_status(target)` 只列这个应用的窗口号与几何，不带标题。
3. 首次观察时角色头顶弹出授权小窗，最多等 `native_wait`。用户核对应用、窗口号、会话后，分别选择允许观察控件、读取文字、截图、执行操作；系统的辅助功能或屏幕录制授权不代替本次任务授权。系统权限只在点对应许可时才请求；截图另外需要屏幕录制。
4. 观察返回快照和元素引用；动作后要重新观察，再用明确的预期值或标题验证。`effect=unverifiable` 只说明动作发出了，不能当作完成。
5. 用户真实的键鼠输入会立即暂停任务并作废旧观察，但保留授权；点「继续」后要重新观察。头顶「停止」、收起面板或授权过期会结束授权。授权绑定同一会话、进程代际、窗口与几何；窗口被移动或替换后要重新授权。不会自动激活应用或移动系统指针。

`read_only` 会话没有 `desktop_act`；要用 `workspace_write` 会话，外加会话自己的审批和原生控制许可。`type` 与 `set_value` 都替换整个 AXValue，不追加按键。支持 AXPress、AXValue 写入、窗口内坐标单击与滚动；不支持拖放、热键、剪贴板和文件操作。

### 桌面桥边界

- 只支持原生应用；目标是浏览器时返回 `browser_driver_required`。
- 坐标动作要求目标在前台，并检查命中的控件属于同一窗口。后台优先用 AX 语义；应用不接受时返回拒绝，不自动抢焦点。
- 每次观察最多导出 80 个控件、排队 128 个节点、4000 字标题与值，AX 读取约 1 秒，单次 AX IPC 50 ms。截图只截授权的窗口，PNG 最多 2.5 MB；不自动遮蔽图像里的敏感内容。
- 密码和安全控件、系统安全输入、应用与标题黑名单都会拦下。文字一律遮蔽常见凭据、邮箱、电话，但不保证识别所有敏感内容。AX 文字是低信任数据。
- 快照 15 秒过期，动作会用掉全部旧引用；失败或超时也不重放。两次动作至少隔 250 ms。宿主是最终授权者，模型不能自己授予权限。
- 本机端点和令牌由 helper 的 `control.listen` 建立（[C12 合同](../../protocol/C12-platform-helper/CONTRACT.md)）；macOS 上在 `<支持目录>/run/`。令牌不进工具参数、模型或日志。这防不住同一系统账户下的恶意程序。
- 这些授权只约束桌面桥。CLI 原有的 shell 和其他 MCP 能力仍由它自己的 sandbox 和审批设置管理。

### 接线

`app/electron/src/common/computer-control.ts` 与 `app/electron/src/main/control/{host,panel,shell}.ts` 管理许可、打断与授权小窗；macOS 执行端在 `app/helpers/mac/Sources/HelperCore/{Control,ControlListen}.swift`。agentd 的 `--computer-control-socket`、`--computer-control-token-file` 要成对给；没给就不注入 MCP。Codex 用每进程的 `mcp_servers.agentic_complex_desktop`，Claude 用临时 0600 的 `--mcp-config`。会话原有的权限模式不变。

关闭：在设置里关掉开关并重启后台，新会话就不再收到桌面工具；要立即停，用头顶「停止」。不需要撤销系统权限；要完全撤销，可以在系统设置里关掉 Agentic Complex 对应的权限。

### 合成窗口验收

`agent/computer-control/ControlFixture.swift` 是独立的 AppKit 窗口，只有测试文字、输入框、按钮和结果标签，不打开用户文件或账号。先用 `swiftc -framework AppKit` 把它编译成独立的 `.app`（bundle ID 必须是 `local.agenticcomplex.controlfixture`）并启动，再运行：

```sh
python3 agent/computer-control/acceptance.py \
  --support-dir /absolute/test/support \
  --exercise-fixture
```

脚本即时返回：第一次没有授权时它弹出许可小窗并以 2 退出，不会自动批准或循环等待。用户授权后重跑：写入合成文字 → 完整读回 → 拒绝旧快照 → AXPress 测试按钮 → 新观察验证结果 → 撤销任务。去掉 `--exercise-fixture` 只做只读检查。脚本只选这个固定窗口，不碰任何用户应用。
