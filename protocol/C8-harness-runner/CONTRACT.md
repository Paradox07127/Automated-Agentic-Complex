# C8 harness runner 协议 v1（agentd ↔ 私有 runner 子进程）

状态：v1，2026-11-06

agentd 用私有 runner 子进程接 harness。父进程一侧是 `ManagedClaudeSession`（`agent/agentd/character_agent/harness/transport.py`）及其子类 `ManagedCodexSession`、`ManagedPiSession`、`ManagedAcpSession`、`ManagedClaudeCodeSession`；runner 一侧现有四个：

| runner | harness | 启动方式 |
|---|---|---|
| `codex_runner.py` | Codex app-server（stdio） | `python -I -B codex_runner.py` |
| `pi_runner.mjs` | Pi Node SDK | `node pi_runner.mjs` |
| `acp_runner.py` | 本机 ACP v1 agent（stdio，`init.config.agent_command` 指定） | `python -I -B acp_runner.py` |
| `claude_runner.py` | 本机 Claude Code CLI（`claude -p` 的 stream-json，`init.config.cli_path` 指定） | `python -I -B claude_runner.py` |

runner 在新的进程组里运行，stdin、stdout 走本协议，stderr 丢弃。本文只写 stdin/stdout 上的帧；runner 的环境变量、凭据和 harness 自身的协议不在这里。

一个帧流指一个 runner 进程从启动到退出的全部帧。agentd 换系统提示、`invalidate()` 或出错时会关掉旧进程、起一个新进程，新进程是一个新的帧流。

## 1. 帧格式

1. 每帧是一行 UTF-8 JSON 对象，以 `\n` 结尾。
2. 每帧都有 `"v": 1`（整数）和 `type`（字符串）。
3. runner 发给 agentd 的帧还有 `seq`；agentd 发给 runner 的帧没有 `seq`。
4. 两个方向的 `type` 不重名，接收方按 `type` 就能分出方向。
5. 字段只加不改（见 `protocol/README.md`「怎么改协议」第 1 条）：接收方忽略不认识的字段。

## 2. `v` 检查

1. agentd 发出的每帧都带 `v: 1`。
2. agentd 收到的行不是 JSON 对象，或 `v` 不等于 1：按协议错误处理（第 5 节）。
3. Python runner（Codex、ACP、Claude）收到的行不是 JSON 对象，或 `v` 不等于 1：发一个 `error` 帧（`code: "invalid_protocol"`），然后退出。
4. Pi runner 收到的行不是 JSON，或 `v` 不严格等于 1：发一个 `error` 帧（`code: "pi_runner_error"`），继续运行。

## 3. `seq`

1. runner 每个进程一个计数器，从 1 开始，每发一帧加 1，所有类型共用。
2. agentd 要求 `seq` 是正整数（布尔不算），否则按协议错误处理。
3. `seq` 不大于本进程已收到的最大 `seq` 的帧，agentd 直接丢弃，不报错。
4. 换进程后计数从头开始。

## 4. 帧大小

上限 `MAX_FRAME` = 40 MiB（41943040 字节），在 `transport.py` 定义，`codex_runner.py` 从那里导入；`pi_runner.mjs` 自留同值副本。

1. agentd 写：一帧连同行尾换行超过上限就不发，调用方得到 `frame_too_large`。
2. agentd 读：一行连同换行超过上限，或读到流尾仍没有换行，按协议错误处理。
3. Python runner 写：超过上限时这一帧不发，按 runner 内部失败处理（`frame_too_large`）。
4. Python runner 读：超过上限时同第 2 节第 3 条，按 `invalid_protocol` 退出。
5. Pi runner 写：一帧（不含换行）超过上限时，进程以退出码 2 退出。
6. Pi runner 读：一行（不含换行）超过上限，或缓冲里没有换行的数据超过上限，进程以退出码 2 退出。

## 5. 协议错误

agentd 读到非法帧（第 2、3、4 节，或 `capabilities` 不符合第 10 节的 `ready`）时：

1. 交给当前调用方一个 `error` 事件：`code: "runner_protocol_error"`，`message: "Invalid harness response"`。不转发原始内容。
2. 结束 runner 进程组（SIGTERM，2 秒后 SIGKILL）。
3. 启动阶段遇到它，`probe()`、`stream()` 抛 `HarnessError("runner_protocol_error")`；运行阶段遇到它，`stream()` 抛同一个错误。

## 6. agentd → runner 的帧

| type | 必填字段 | 选填字段 | 说明 |
|---|---|---|---|
| `init` | `config` 对象；`system_prompt` 字符串；`tools` 数组 | `config.site_dirs` 字符串数组；`config.workspace_dir` 绝对路径、`config.native_tools` 布尔（Claude、Codex、ACP：为真时 harness 用自己的工具和用户配置，在 `workspace_dir` 里工作）；Pi 在 `config.native_tools` 为真时另有 `config.user_agent_dir` 绝对路径、`config.skill_dirs` 绝对路径数组，从中读用户自己的 `mcp.json` 和 Skills | 进程启动后第一帧，只发一次。`tools` 每项有 `name`、`description`、`input_schema`（`type` 为 `object` 的 JSON Schema）。`config` 是私有配置，含凭据，不记日志 |
| `query` | `run_id` 字符串；`prompt` 字符串；`history` 数组或 `null` | `ask_user_result` 对象；`api_key` 字符串 | 开始一次 run。进程启动后的第一个 `query` 带调用方给的 `history`，之后都是 `null`。`ask_user_result` 用来在新 run 里接上之前挂起的 `ask_user` 回答，含 `tool_call_id`、`args`、`result`。`api_key` 是这次 run 用的当前凭据（Pi runner 用它替换 `init` 时的 key），不记日志 |
| `tool_result` | `tool_call_id` 字符串；`run_id` 字符串；`result` 任意 JSON；`is_error` 布尔 | | 回答一个 `tool_request` |
| `permission_result` | `run_id` 字符串；`request_id` 字符串；`option_id` 字符串或 `null` | | 回答一个 `permission_request`。`option_id` 取自请求的 `options[].option_id`；`null` 表示拒绝 |
| `interrupt` | `run_id` 字符串 | | 取消这个 run |
| `close` | | | 让 runner 退出 |
| `list_models` | `runtime_dir` 字符串；`provider` 字符串或 `null` | | 只有 Pi runner 接受，代替 `init` 作为进程的第一帧。runner 读 Pi 的离线模型目录（不联网、不要 key），回一个 `models` 帧；agentd 收到后关掉 stdin，runner 退出 |

`init.config.site_dirs` 可省略，每项是绝对目录路径。Python runner 在导入 harness SDK 前把这些目录按数组顺序放到 `sys.path` 最前（第一项优先）；省略或空数组不改变搜索路径。

runner 一侧的规则：

1. Python runner 收到第二个 `init`、`run_id` 或 `prompt` 不是字符串的 `query`、已有 run 在跑时的 `query`、或不认识的 `type`，发 `error` 帧后退出。
2. Pi runner 在 `init` 完成前收到 `query`，发 `error`（`code: "pi_not_initialized"`，带 `run_id`）；已有 run 在跑时收到 `query`，发 `error`（`code: "run_busy"`，带 `run_id`）；两种情况都继续运行。不认识的 `type` 发 `error`（`code: "pi_runner_error"`），继续运行。
3. `tool_result` 的 `tool_call_id` 没有在等、`run_id` 对不上，或这个调用已经有了答案：runner 忽略这一帧。
4. `interrupt` 的 `run_id` 不是当前 run：runner 忽略这一帧。
5. stdin 关闭等同 `close`。
6. `permission_result` 的 `request_id` 没有在等、`run_id` 对不上，或这个请求已经有了答案：runner 忽略这一帧。Claude、Codex runner 只在 `option_id` 是 `allow_once` 时允许，其余（含等了 `config.permission_timeout` 秒仍没有答案）都拒绝。ACP runner 按 `option_id` 回 agent：`null`、不在请求的 `options` 里、或等了 `config.permission_timeout` 秒（默认 180）仍没有答案时回 agent 的 `reject_once` 选项（没有就 `reject_always`，都没有回 cancelled）；run 已取消（发过 `session/cancel`）时按 ACP 规范回 `cancelled` 结果，等着的请求和之后来的请求都是；选中 `allow_always` 时改回 `allow_once`（没有 `allow_once` 就按拒绝处理）。

ACP runner 对 agentd 自己的工具（`title` 是 `mcp__agentic_complex__<init.tools 里的名字>`）直接允许一次，其余每个请求都发 `permission_request`。不在 run 里或 `sessionId` 不对的权限请求，runner 直接拒绝；run 已取消时回 `cancelled`。runner 自己从不选 `allow_always`。

## 7. runner → agentd 的帧

每帧都有 `v`、`seq`、`type`。

| type | 必填字段 | 选填字段 | 谁发 |
|---|---|---|---|
| `ready` | `tool_names` 字符串数组；`tool_inventory_verified` 布尔；`model` 字符串；`capabilities` 对象（第 10 节） | `session_id` 字符串或 `null`；`run_id` 字符串；其余诊断字段（`sdk_version`、`cli_version`、`cli_pid` 等） | 四个 runner |
| `tool_request` | `run_id` 字符串；`tool_call_id` 非空字符串；`name` 字符串；`args` 对象 | `item_id`、`kind`、`status`、`phase`、`parent_item_id` | 四个 runner |
| `text_delta` | `run_id` 字符串；`text` 字符串 | `item_id`、`kind`、`status`、`phase`、`parent_item_id`、`name` | 四个 runner |
| `item` | `run_id` 字符串；`item_id` 字符串；`kind` 字符串；`status` 为 `started`、`delta`、`completed` 之一 | `text`、`name`、`args`、`summary`、`phase`、`parent_item_id` | Codex、ACP、Claude |
| `plan` | `run_id` 字符串；`title` 字符串或 `null`；`steps` 数组（每项有字符串 `text`、`status`）；`source` 字符串 | | Codex、ACP |
| `permission_request` | `run_id` 字符串；`request_id` 非空字符串；`title` 字符串；`kind` 字符串或 `null`；`locations` 字符串数组或 `null`；`raw_input` 对象或 `null`；`options` 数组（每项有字符串 `option_id`、`name`、`kind`） | | ACP、Claude、Codex |
| `result` | `run_id` 字符串；`success` 布尔；`subtype` 字符串 | `session_id`、`model`、`text`、`final_text`、`usage`、`total_cost_usd`、`cost_usd`、`cost_source`、`num_turns`、`model_usage`、`failure`、`error` 等 | 四个 runner |
| `error` | `code` 字符串 | `run_id` 字符串；`message` 字符串；`failure` 对象（`code`、`retryable`、`public_message`） | 四个 runner |
| `models` | `providers` 数组（每项有 `id`、`name`）；`models` 数组（`provider` 为空时是空数组；每项有 `id`、`name`、`context_window`、`max_tokens`、`input`、`reasoning`、`thinking_levels`、`priced`） | | Pi，只回答 `list_models` |

各帧的含义：

1. `ready`：`init` 成功后发一次，不带 `run_id`。现有四个 runner 都只发这一次。每个 `ready` 都带 `capabilities`。
2. `tool_request`：请 agentd 执行一个工具，规则见第 8 节。
3. `text_delta`：给用户看的回答文本增量。子代理和工具结果里的文本用 `item`（带 `text`）发，不用 `text_delta`。
4. `item`：一个条目（回答文本、推理摘要、工具调用、工具结果、计划、提问等）的开始、增量和完成。`kind` 现有取值：`assistant_text`、`reasoning_summary`、`tool_call`、`tool_result`、`plan`、`question`、`other`。私有思考内容不出现在任何帧里：ACP runner 不转发 agent 的 `agent_thought_chunk`。
5. `plan`：Codex 的计划更新，`steps[].status` 现有取值 `pending`、`in_progress`、`completed`。
6. `permission_request`：harness 要执行一个需要用户同意的工具，请 agentd 选一个选项，用 `permission_result` 回答（第 6 节 runner 一侧第 6 条）。`request_id` 由 runner 生成，本进程内唯一。`title`、`kind` 取 ACP `toolCall` 的同名字段（`title` 缺时为空串），`kind` 现有取值见 ACP ToolKind（`read`、`edit`、`delete`、`move`、`search`、`execute`、`think`、`fetch`、`switch_mode`、`other`）；`locations` 是 `toolCall.locations[].path`；`raw_input` 是 `toolCall.rawInput`（不是对象时为 `null`；Claude、Codex、Pi runner 在它编码后超过 30000 字时发截断预览：`{"truncated": true}` 后先放放得下的关键字段原值（Pi 为 `path`、`command`，Claude、Codex 另有 `file_path`、`cwd`、`grantRoot`），其余字段截到剩下的长度，非字符串值截其 JSON 文本，工具仍以完整参数执行；整帧仍超过帧上限时为 `{"truncated": true}`）；`options[].kind` 是 `allow_once`、`allow_always`、`reject_once`、`reject_always` 之一。Claude runner 的请求来自 `--permission-prompt-tool`：`title` 是工具名，参数里有字符串 `command` 时为 `<工具名>: <command>`，`kind` 为 `null`，`raw_input` 是工具参数。Codex runner 的请求来自 app-server 的 `item/commandExecution/requestApproval`（`kind: "execute"`）、`item/fileChange/requestApproval`（`edit`）、`item/permissions/requestApproval`（`other`），`raw_input` 是请求参数。这两个 runner 的 `options` 只有 `allow_once`、`reject_once`。
7. `result`：run 结束，每个 run 恰好一个。取消时 `success: false`、`subtype: "cancelled"`。
8. `error`：带 `run_id` 时这个 run 失败结束；不带 `run_id` 时是进程级失败（启动失败、协议错误）。Python runner 发进程级 `error` 后退出。

agentd 一侧的规则：

1. 启动阶段 agentd 等 `ready` 最多 `startup_timeout` 秒（默认 30），超时得到 `sdk_startup_timeout`。这期间收到 `error` 或进程退出，抛出 `HarnessError(code)`；其它帧丢弃。
2. 收到的 `ready` 的 `capabilities` 不是对象、缺第 10 节的键、或取值不在第 10 节的表里，按协议错误处理（第 5 节）。agentd 把启动阶段 `ready` 里的 `capabilities` 存到会话的 `capabilities` 属性上。
3. 不认识的 `type` 交给调用方，不报错。
4. 运行阶段收到 `error` 或进程退出，`stream()` 抛出 `HarnessError`（进程退出时是 `runner_disconnected`）。
5. agentd 的事件队列上限 512 帧，满了就结束 runner 进程组。
6. 收到 `permission_request`：`run_id` 不是当前 run、当前 run 已取消、`request_id` 不是非空字符串、或这个 `(run_id, request_id)` 在本进程里出现过，立刻回 `permission_result`（`option_id: null`）。否则交给调用方一个 `permission_requested` 事件（字段同请求），再在后台线程调会话或这次 `stream()` 的 `permission_handler(request)`，把它返回的字符串作为 `option_id` 回给 runner；没有 handler、handler 出错或返回的不是字符串、或等它期间 run 被取消或已换进程，回 `option_id: null`。

`tool_started`、`tool_finished`、`waiting_user`、`permission_requested`、`eof` 是 agentd 自己给调用方的事件，不是 wire 上的帧，runner 不发。

## 8. 工具调用

1. 一个 run 里同一个 `tool_call_id` 只能请求一次。
2. agentd 收到 `tool_request` 后，以下情况立刻回 `tool_result`（`result: {"error": "run_cancelled_or_busy"}`，`is_error: true`），不执行工具：`run_id` 不是当前 run、当前 run 已取消、`tool_call_id` 不是非空字符串、这个 `(run_id, tool_call_id)` 在本进程里出现过、已有 8 个工具在执行。
3. `name` 不在 `init.tools` 里，或 `args` 不是对象：回 `tool_result`，`result: {"error": "unknown_tool"}`，`is_error: true`。
4. 工具执行完回 `tool_result`。执行期间 run 被取消或已结束，回 `result: {"error": "run_cancelled"}`，`is_error: true`，不把工具结果交回模型。
5. 每个被接下的 `tool_request` 恰好回一个 `tool_result`。agentd 写失败（runner 已退出）时不重试。
6. runner 等 `tool_result` 最多 `config.tool_timeout` 秒（默认 210），超时后按工具失败交回 harness。run 取消时 runner 不再等。
7. `result` 是 MCP 风格的 `{"content": [...]}` 时，runner 把其中的文本、图片块交给 harness；否则把 `result` 序列化成一段文本。

## 9. 取消、超时和迟到帧

取消：

1. 调用方取消后，agentd 发 `interrupt`。各 runner 中断 harness（Codex 发 `turn/interrupt`，Pi 调 `session.abort()`，ACP 发 `session/cancel`，Claude 发 `interrupt` 控制请求），并让在等 `tool_result` 的调用立刻失败。
2. agentd 发 `interrupt` 后最多等 3 秒的 `result`；等不到就关掉 runner，自己给调用方一个 `success: false`、`subtype: "cancelled"` 的结果。
3. 取消后收到的 `result` 一律改成 `success: false`、`subtype: "cancelled"` 交给调用方。
4. run 超过 `timeout_seconds`（默认 300）：agentd 发 `interrupt`、关掉 runner，抛 `run_timeout`。
5. 调用方在 `result` 之前停止读取，agentd 关掉 runner，免得剩下的帧进了下一个 run。

迟到帧：

1. `seq` 不递增的帧丢弃（第 3 节）。
2. 已被替换的旧 runner 进程发来的帧丢弃。
3. 带 `run_id` 但不是当前 run 的帧丢弃；不带 `run_id` 的帧照常处理。
4. 取消之后除 `result`、`error` 外的帧都不交给调用方。
5. runner 在 run 取消后不再发这个 run 的文本：Codex 不发 `item`、`text_delta`、`plan`，Pi 不再转发 harness 事件，ACP 不再转发 agent 的 `session/update`，Claude 不再发回答文本的 `item`、`text_delta`。
6. 迟到的 `tool_request` 按第 8 节第 2 条回 `run_cancelled_or_busy`。

关闭：

1. agentd 发 `close`，等 1 秒（ACP 等 5 秒：runner 要先给 agent 发 `session/close`，最多等 2 秒），再对进程组发 SIGTERM，2 秒后 SIGKILL。
2. runner 收到 `close` 或 stdin 关闭后退出。stdin 关闭时 Python runner 还对自己的进程组发 SIGTERM；ACP runner 在 `ready` 之后不发，按 `close` 处理，agent 声明了 `sessionCapabilities.close` 时先发 `session/close`。

## 10. 能力描述

每个 `ready` 帧带 `capabilities` 对象，描述这个 runner 在本会话里怎么接 harness。7 个键都必填，取值只能是下表所列：

| 键 | 取值 | 含义 |
|---|---|---|
| `cancel` | `native` / `process_kill` | `native`：`interrupt` 走 harness 自己的中断接口；`process_kill`：只能靠 agentd 关掉进程 |
| `tool_injection` | `in_process` / `dynamic_tools` / `mcp_stdio` / `mcp_http` | agentd 的工具怎么交给 harness：在 runner 进程内注册（`in_process`）、作为 harness 的动态工具（`dynamic_tools`）、经 stdio 或 HTTP MCP 服务器（`mcp_stdio`、`mcp_http`，现在没有 runner 用） |
| `builtin_tools` | `disabled_verified` / `unverified` | `disabled_verified`：有测试证明 harness 的内置工具到不了模型或宿主；否则 `unverified` |
| `system_prompt` | `native` / `prompt_prefix` | `native`：`init.system_prompt` 作为 harness 的系统提示传入；`prompt_prefix`：拼在用户消息前 |
| `usage` | `usd` / `tokens` / `none` | `result` 里有什么用量：`usd` 有美元费用（`cost_usd`）；`tokens` 只有 token 数；`none` 都没有 |
| `event_scope` | `session` / `global` | harness 的事件源：`session` 只属于本会话；`global` 是进程级共享的，runner 要按会话或轮次过滤 |
| `native_questions` | 布尔 | `true`：harness 自带的提问工具在本会话里接到 agentd 的 `ask_user` 工具 |

规则：

1. 拿不准的键取保守值：`process_kill`、`unverified`、`prompt_prefix`、`none`、`global`、`false`。
2. `builtin_tools` 只有在现有测试能证明内置工具被禁用时才取 `disabled_verified`。
3. `ready` 的 `capabilities` 不是对象、缺键或取值不在上表里，是协议错误（第 5 节）。不认识的键接收方忽略。
4. 同一进程的多个 `ready` 里，`capabilities` 相同。

现在四个 runner 的取值：

| 键 | Codex | Pi | ACP | Claude |
|---|---|---|---|---|
| `cancel` | `native` | `native` | `native` | `native` |
| `tool_injection` | `dynamic_tools` | `in_process` | `mcp_stdio` | `mcp_stdio` |
| `builtin_tools` | `config.native_tools` 为真时 `unverified`，否则 `disabled_verified` | `config.native_tools` 为真时 `unverified`，否则 `disabled_verified` | `unverified` | `unverified` |
| `system_prompt` | `native` | `native` | agent 声明 `sessionCapabilities.systemPrompt` 时 `native`，否则 `prompt_prefix` | `native` |
| `usage` | `tokens` | 接自定义端点（`config.base_url`）时 `tokens`，否则 `usd` | `none` | `usd` |
| `event_scope` | `global` | `session` | `session` | `session` |
| `native_questions` | `init.tools` 有 `ask_user` 时 `true` | `false` | `false` | `false` |

## 10a. Claude runner

`claude_runner.py` 启动 `init.config.cli_path`：`claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages`，另加 `--mcp-config`（`agentic_complex` 一个 stdio MCP 服务器，即 `tool_bridge.py`）、`--no-session-persistence`、`--no-chrome`。`config.native_tools` 为真时（对话、派单）再加 `--permission-prompt-tool mcp__agentic_complex__endfield_permission`、`--append-system-prompt=<init.system_prompt>`，CLI 用自己的内置工具、用户的设置和 MCP，工作目录是 `config.workspace_dir`；否则（语义任务）加 `--tools ""`、`--strict-mcp-config`、`--allowedTools` 列出 `mcp__agentic_complex__<tool>`、`--permission-mode dontAsk`、`--permission-prompts none`、`--setting-sources ""`、`--disable-slash-commands`、`--system-prompt=<init.system_prompt>`；`config.model` 非空时加 `--model=`，`config.effort` 非空时加 `--effort`（`ready` 带 `effort_applied: true`）。CLI 直接启动，沿用它自己的登录。

1. 启动：runner 发 `initialize` 控制请求，等到回答才发 `ready`。没配模型时 `ready.model` 取 CLI `system/init` 消息的 `model`（最多再等 3 秒）。
2. 语义任务（`config.native_tools` 不为真）里，`system/init` 列出的工具有 `mcp__agentic_complex__<init.tools>` 之外的，runner 发 `error`（`code: "claude_unexpected_tools"`）后退出；全都对上时 `ready.tool_inventory_verified` 为 `true`。
3. 每个 `query` 是一条 stream-json `user` 消息。部分消息的文本增量按 Anthropic 消息 id 发 `item`（`kind: "assistant_text"`、`phase: "final"`，started/delta/completed）和 `text_delta`；`final_text` 是这次 run 全部回答文本。思考内容不转发。
4. Endfield 工具经桥调用，`tool_request` 的 `tool_call_id`、`item_id` 是模型的 `tool_use` id。
5. `result` 带 `usage`（Anthropic 的四个 token 数）、`cost_usd`（CLI 累计 `total_cost_usd` 的本轮增量）、`num_turns`、`model_usage`。失败时 `failure` 按 CLI 的错误提示、`api_error_status` 分类（登录、额度、限流、网络等）。

## 11. 校验

- `validate.py FILE`：检查一个帧流（一行一帧，两个方向可以混排），合法时退出码 0，否则打印第一个错误、退出码 1。`check(lines)` 返回 `None` 或错误字符串。它检查第 1–4 节、第 6、7 节的必填字段和类型、第 10 节的取值，以及第一个 `ready` 之前 runner 只发 `error`。
- `examples/ok-*.ndjson`：每个 runner 一份合法帧流（ACP 另有一份带权限帧的 `ok-acp-permission.ndjson`）；`examples/bad-*.ndjson`：非法样例。
- `test_validate.py`：样例测试，在门禁的 `protocol` suite 里。
- 一致性测试：`agent/agentd/tests/test_character_agent_codex.py`、`test_character_agent_pi.py` 抓真实 runner 发出的帧交给 `check()`，本机缺对应 harness 时跳过；`test_acp_runner.py` 用 `tests/fixtures/fake_acp_agent.py` 驱动真实 `acp_runner.py`（含权限帧），`test_claude_runner.py` 用 `tests/fixtures/fake_claude_cli.py` 驱动真实 `claude_runner.py`，抓到的帧交给 `check()`。`test_character_agent_transport.py` 测 agentd 对 `capabilities` 和 `permission_request` 的处理。

## 单独运行

`drive.py` 只依赖 Python 标准库，不启动 agentd。场景 JSON 包含完整的 `init`、`query` 帧（均带 `v: 1`），以及按工具名索引的 `tool_results`，例如 `{"fixture_read": {"result": {"checked": true}, "is_error": false}}`。驱动收到第一个合法 `ready` 后发一次 `query`；工具回复的 `run_id`、`tool_call_id` 取自请求。缺少对应的预设回复时报错，不执行真实工具。
`agent/agentd/tests/test_character_agent_drive.py` 展示了三个 runner 各自的场景构造方式。

runner 继承调用方环境；启动前须准备好场景 `init.config` 指向的运行目录、harness 及端点（Python runner 需要 `state_dir/workspace`，其余环境见 `transport.py`、`pi_config.py`）。以下命令从仓库根目录运行，`codex.json`、`pi.json` 是准备好的场景文件：

```sh
python3 -I protocol/C8-harness-runner/drive.py --script codex.json -- agent/.venv/bin/python3 -I -B agent/agentd/character_agent/harness/codex_runner.py
python3 -I protocol/C8-harness-runner/drive.py --script pi.json -- node agent/agentd/character_agent/harness/pi_runner.mjs
```

每收到一帧打印其类型，并将截至该帧的接收流交给 `validate.check`。遇到 `result` 或 `error` 后发送 `close`；总时限默认 60 秒，可用 `--timeout` 指定，关闭等待也受剩余时限约束。合法流以 `result` 结束时打印 `C8-DRIVE ok <runner argv>`、退出 0（不要求 `result.success` 为真）；其它情况打印 `C8-DRIVE fail <原因>`、退出非零。
