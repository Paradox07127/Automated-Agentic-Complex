# C6 Companion ↔ agentd 接口 v1

> 正文里的「Avatar」「player」指角色进程，现由渲染器 `private/renderer/host`（私有组件，不在公开仓库）实现。

双方：Companion（Electron 外壳，含 Metal 角色进程经 Companion 转发的部分）↔ agentd（Python）。归属：agent。
T1 trace 事件格式是 C6 的一部分，见 [T1-TRACE.md](T1-TRACE.md)。全部端点见 §3 端点总表；逐条的字段和错误码见表中「规格」列指的文档；本文件的端点细则在 §2 和 §4。
本合同版本 v1；agentd 在 `GET /health` 的回复里以 `c6_contract`（字符串 `"v1"`）报它实现的版本，`agentd --describe`（C9）也报同一个值。

## 2026-11-22 一段时间的 trace 事件 GET /trace/events（只加不改）

- 新端点 `GET /trace/events?since=&until=&kinds=&limit=&cursor=`（ui 令牌，`read`）：时间范围内所有 trace 的事件，按存入先后，一页一页读，文本只有 `{len, head}`；「动作线」视图用它。字段见 §4.2 的这一行，回包样例 `fixtures/trace-events.json`。
- `behavior.receipt` 的 `causation_id` 为它那个行为的 `behavior.dispatched`（知道时），见 T1「动作线」。

## 2026-11-22 动作分组提案 GET /characters/:character_id/motion-groups（只加不改）

- 新端点 `GET /characters/:character_id/motion-groups`（ui 令牌，`read`）：当前角色动作图里每个片段归到哪里，包里还没抽的片段提议进哪个现有池子；只读，什么都不改。不是当前角色 409 `not_current`，没有动作选择器或动作图 404 `motion_graph_missing`。字段见 §2 的这一条，回包样例 `fixtures/motion-groups.json`。
- 按词义提议：`pools` 改为 agentd 认得的每个事件键（包里没有的也列，`pack` 为 `[]`）和每个空闲档；一个片段可以出现在多个池子的 `proposal`（`why` 新增 `meaning:<规则 id>`），已在包池子里的片段也可以被提议进别的池子；新增 `counts.proposals`（片段-池子提议的条数），其余计数每个片段只记一次，记在它的第一类。

## 2026-11-21 每日简报的触碰和桌面时长 POST /interaction/record（只加不改）

- 新端点 `POST /interaction/record`（ui 令牌，`host_only`）：Companion 转来她的一次触碰或迎接（C3 规则 55），回 204；body 不合 400 `invalid_payload`。字段见 §4.2 的这一行。
- `PUT /avatar/visibility` 每次都记进显示时长；agentd 自己让她停在屏幕边缘时（安静阶段）记下停留区间。`GET /brief/day` 的 `her.touch`、`items.touch`、`her.desk` 的 `edge`、`greet` 行和 `her.on_desk_min` 改读这些记录，不再从 tap、ritual 输入和拖动打断回执推算。

## 2026-11-22 动作设置 PUT /behavior/motion_prefs（只加不改）

- 新端点 `PUT /behavior/motion_prefs`（ui 令牌，`host_only`）：Companion 把当前角色的动作开关和动作覆盖交给 agentd 的动作选择器；半身框选仍走 `PUT /behavior/switches` 的 `bust_framing`，回 200 和调整结果；body 不合 400 `invalid_motion_prefs`，不是当前角色 409 `character_changed`，没有动作选择器 409 `no_motion`。字段见 §4.2 的这一行，请求样例 `fixtures/behavior-motion-prefs.json`。

## 2026-11-21 播放状态 POST /behavior/motion_state（只加不改）

- 新端点 `POST /behavior/motion_state`（ui 令牌，`host_only`）：Companion 把渲染器的 C3 `motion_state`（C3 规则 54）原样转来，回 204；body 不合 400 `invalid_motion_state`。字段见 §4.2 的这一行。

## 2026-11-21 桌面时间线 POST /context/timeline（只加不改）

- 新端点 `POST /context/timeline`（ui 令牌，`host_only`）：Companion 批量发桌面时间线记录，body `{"records": [...]}`，1–200 条，回 200 `{"stored": n, "dropped": m}`；`invalid_records`、`too_many_records`、503 `no_timeline`。记录字段、上限、过滤和清除规则见 §4.2 的这一行，请求样例 `fixtures/context-timeline.json`。`/context/events` 不变。

## 2026-11-21 角色状态档位改为英文代码

- `GET /character/state` 和 `/diag/state` `character_state` 的 `labels` 取值改为固定的英文代码，不再是显示用的词：`energy` 为 `lively`、`okay`、`sleepy`、`very_sleepy`，`mood` 为 `good`、`steady`、`low`，`engagement` 为 `absorbed`、`some`、`idle`。界面自己把代码换成要显示的文字。键和档位的划分不变。
- `GET /desktop/presence` 的 `role.mood` 是同一个 `mood` 代码（没有状态时为 null）。

## 2026-11-21 模型列表来自 Pi 的离线目录，Pi 目录里的其他服务，兼容 API 的模型能力

- `POST /model/catalog` 的 200 回包改为 `{providers, models}`。已存 `provider` 是 `anthropic`、`deepseek`、`xai`、`openai`、`pi_catalog` 时，列表来自 Pi SDK 随包的离线目录（不联网、不要 Key）：`models[]` 每项 `{id, name, context_window, max_tokens, input, reasoning, thinking_levels, priced}`，`providers[]` 是 Pi 目录里能用 API Key、并且有 Endfield 包里能跑的模型的服务 `{id, name}`（没有 Google、Vertex、Bedrock 和只能用订阅登录的服务）。`compatible` 和 `chatgpt` 仍拉服务自己的 `/models`：`providers` 为 `[]`，`models[]` 除 `id`、`name` 外都是 null。新错误码：`pi_runtime_unavailable`、`pi_runner_error`、`pi_node_version_mismatch`、`sdk_policy_capability_missing`、`sdk_startup_timeout`。
- `GET /model/settings` 的 `backends` 多一个 `pi_catalog`（「其他（Pi 目录）」）：`{model, base_url, pi_provider, max_output_tokens, reasoning_effort, has_key}`，`base_url` 恒为 `""`，`pi_provider` 是 Pi 目录里的服务 id（`""` 为没选），`has_key` 是这个服务自己的 Key。`compatible` 总有 `supports_images`（缺省 false）、`context_window`（缺省 128000）、`reasoning`（缺省 false）。
- `POST /model/settings` 的 `provider` 接受 `pi_catalog`；它的 `pi_provider` 换了时 `model` 清空，`api_key` 和 `clear_key` 只作用于当前 `pi_provider` 的 Key，每个服务的 Key 各自保留；没选 `pi_provider` 时给 `api_key` 或 `clear_key` 回 `invalid_pi_provider`。`compatible` 接受 `context_window`（整数 1024–10000000）和 `reasoning`（布尔），错误码 `invalid_context_window`、`invalid_reasoning`。`reasoning_effort` 接受 Pi 的思考档位：`""`、`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。
- Pi 的思考档位：用途路由的强度为空（或「沿用内核配置」）时，Pi 用这个连接后端的 `reasoning_effort`，也为空时为 `off`。兼容 API 的模型按 `context_window`、`reasoning`、`supports_images`、`max_output_tokens` 注册。

## 2026-11-21 Pi 用自己的模型目录，xAI 有自己的凭据，测试连接回报所用连接

- `GET /model/settings` 的 `backends` 多一个 `xai`（Grok），默认地址 `https://api.x.ai/v1`；`POST /model/settings` 的 `provider` 接受 `xai`。没有已存 provider 时按 `anthropic` → `deepseek` → `xai` → `openai` → `compatible` 取第一个有凭据的。
- `GET /character/runtime` 的 `provider_profiles[]` 去掉 `api`；`credential_backend` 是这个 provider 自己的后端（`deepseek`、`xai`），不再是 `compatible`。内核 `provider` 写 `deepseek` 或 `xai` 时读那个后端的地址和 Key，不读兼容 API 的；不再有 `provider_profile_endpoint_mismatch`。
- Pi 连 `anthropic`、`openai`、`deepseek`、`xai` 时用 Pi 模型目录里的模型：思考档位、上下文、最大输出、价格、能否收图都来自目录。地址不是目录里的地址时只换地址。模型 id 不在目录里时（比如代理网关上的自定义模型），按兼容 API 的方式注册这个模型，不计价。目录里有价格的模型记费用，`max_budget_usd` 对它生效；兼容 API 和 ChatGPT 订阅仍不计价。
- `POST /model/test` 的 200 回包改为 `{ok, kernel, provider, model, elapsed_ms, tokens, cost_usd}`。内核是 Pi 时直接用 Pi 的主连接调一次模型（不走 `judge` 路由，不带角色上下文），`provider` 是这次用的服务，`tokens` 是 `{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}`，`cost_usd` 是数或 null（不计价）。别的内核仍跑一次 `review` 语义任务，`provider`、`tokens`、`cost_usd` 为 null。`elapsed_ms` 是整数。

## 2026-11-21 /character/runtime 回复语言

- GET 和 PUT 的回包加 `reply_language`，取 `auto`（默认）、`zh-Hans`、`en`、`ja`、`harness`：角色回答用的语言。`auto` 时按用户最新一条消息判出的语言（假名为日文，有汉字没有假名为简体中文，至少 3 个拉丁字母词为英文，代码和网址不算），判不出时沿用上一次的，还没有消息时用系统首选语言里第一个支持的（中文都按简体中文），都不支持时用英文；`zh-Hans`、`en`、`ja` 固定用这种语言；`harness` 时不发语言指令，由用户自己内核的配置决定。PUT 的 body 接受它；不是这 5 个值时 400 `invalid_reply_language`。

## 2026-11-20 /character/runtime 工作区，去掉运行上限和 ACP 权限字段

- GET 和 PUT 的回包加 `workspace_dir`（绝对路径或 null）：桥接内核（Claude Code、Codex、ACP agent）自带工具的工作目录，也是派单在没有指定目录、没有匹配项目、没有聚焦会话时的目录。null 时用 `~/AgenticComplex`，第一次用到时创建。PUT 的 body 接受它；不是绝对路径时 400 `invalid_workspace_dir`。
- 回包和 body 不再有 `max_turns`、`timeout_seconds`、`acp_permission`；body 带它们会被拒（`invalid_runtime_settings`）。已保存的设置文件里的这三个键在读入时丢掉。`max_budget_usd` 只对 Pi 生效。
- 内核的权限请求转成的审批卡，`preview.source` 按内核取 `claude`、`codex` 或 `acp_agent`。
- 派单卡的 `dispatch.cwd_from.matched` 多一个值 `workspace`。

## 2026-11-18 /character/runtime 按用途指定内核

- PUT 的 body 接受 `routes`：`{用途: {backend, acp_agent, model, effort}}`，用途是 `chat`、`quick`、`background`、`judge`、`understand`、`memory`、`computer`，每项可省；除 `quick` 外，省掉的用途跟随主内核。`quick` 固定使用 light_ai 的 Pi 和模型设置中的 AI 账号；省略模型时，若聊天走同一提供商的 Pi 则沿用聊天模型，否则使用账号的默认模型。`backend` 取 `pi`、`codex`、`claude`、`acp`；`backend=acp` 时 `acp_agent` 必填（本机 agent），否则为 null；`model` 为 null 时同内核沿用 `model`、换了内核用那个内核自己的模型；`effort` 取 null、`inherit`、`low`、`medium`、`high`。错误码 `invalid_routes`、`invalid_route_backend`、`invalid_route_model`、`invalid_route_effort`、`invalid_acp_agent`。
- GET 和 PUT 的回包里 `routes` 列出全部 7 个用途：`{backend, acp_agent, model, effort, follows_main, ready, error}`。`follows_main` 为 true 时 `backend`、`acp_agent` 是主内核的，`model`、`effort` 为 null，`ready`、`error` 同主内核；否则 `ready`、`error` 是那个内核自己的就绪结果，错误码同顶层 `error`。
- 回包和 body 不再有 `chat_effort`、`front_model`、`back_model`、`back_effort`；body 带它们会被拒（`invalid_runtime_settings`）。
- 前台闲聊走 `quick`，带当前对话最近 8 轮。角色回执、近期任务、记忆和观察与 `chat` 共用同一套上下文，放在系统提示之后。快速回复关闭推理，不开放工具，回答最多 1024 tokens。快速路由不可用时使用就绪的聊天路由。需要文件、观察、回复引用、电脑操作、设置或更改提醒（含取消）、明确要求记住内容的输入走 `chat`。快速回复以 `[handoff]` 开头时，同一轮转交 `chat`。开启记忆时，两条路由的对话都进入后台记忆提取流程。最终路由存于 trace 的 `turn.settled.attrs.route`。
- 后台语义任务按用途走：`judge`（主动判断、朝向、复核、重复检测、主动想法）、`understand`（屏幕理解、看截图、简报、任务推测）、`memory`（记忆提取、工作日志）。用途指定的内核没就绪时，这次任务以它的错误码失败，不改用主内核。后台任务（`background`）提交时按它的就绪结果拒绝。

## 2026-11-18 ACP agent 安装与直连标记（只加不改）

- `GET /character/acp/agents` 的每个 agent 多一个键 `native_backend`：`claude`（claude-acp）、`codex`（codex-acp）或 null。不为 null 的 agent 有直连内核，设置页改用那个内核。
- 新增 `POST /character/acp/install`，body `{agent_id}`：registry 里有 `npx` 分发的跑 `npm install -g <package>`，有 `uvx` 分发的跑 `uv tool install <package>`，最多 300 秒；回 200 `{ok, agent_id, command, exit, output_tail}`，超时时 `exit` 为 null、`ok` 为 false。没有这两种分发 400 `acp_install_unsupported`，本机找不到 npm 或 uv 400 `acp_installer_missing`，未知 id 400 `invalid_acp_agent`。只由用户点「安装」触发。

## 2026-11-18 /character/runtime Claude Code 内核（只加不改）

- `backend` 多一个值 `claude`：本机 Claude Code CLI（`claude -p` 的 stream-json），只能 `runtime_source: local`、`auth_source: existing_login`，`provider` 为空串或 `anthropic`；`model` 为空串时用 CLI 自己的模型。
- `available_backends`、`installed_runtimes` 多出 `claude` 行；`installed_runtimes[].login_command` 对 `claude` 是 `<路径> auth login`。

## 2026-11-18 /character/runtime 去掉轻量对话字段

- GET 和 PUT 的回包不再有 2026-11-15 加的两个轻量对话字段；PUT 的 body 带它会被拒（`invalid_runtime_settings`）。内核没就绪时不再由对话模型代答。
- `POST /model/test` 改为经当前内核跑一次后台语义任务，回包形状不变：`{ok, model}`；失败时 400 带错误码。

## 2026-11-17 /character/runtime ACP 内核字段（只加不改）

- `backend` 多一个值 `acp`；GET 和 PUT 的回包加 `acp_agent`（ACP registry id 或 null）、`acp_launcher`（`local`、`npx` 或 `uvx`）、`acp_permission`（`auto`、`ask` 或 `deny`）。
- PUT 的 body 接受这三个键；`backend=acp` 时 `acp_agent` 必填。
- `GET /character/acp/agents` 列出本机能用和能下载运行的 ACP agent。

## 2026-11-15 /character/runtime 轻量对话字段（只加不改）

- GET 和 PUT 的回包加 `light_chat`（设置值：null、off 或 fallback）和 `light_chat_state`（`{ready, reason, model_usable}`）。
- PUT 的 body 接受 `light_chat`；改它不重启内核。

## 2026-10-29 执行归属与结果语义补充

- 角色控制器发出的 `agent_item`、`agent_run`、`plan` 带 `work_kind`：`foreground`、`background` 或 `semantic`。
  后台帧另有 `job_id`；角色运行帧携带 `run_id`、`conversation_id` 与运行 `generation`。
  这些字段是产品归属，不能由模型正文推断；后台与维护文本不得混入前台对话。
- `agent_run.phase=completed` 表示模型轮结束，不能作为任务成功证明。新 `outcome` 为
  `answered`、`succeeded`、`needs_review`、`failed`、`background_pending`；核验期间发 `verifying`，
  核验失败发 `verification_failed`。公开事件与持久化元数据使用相同 outcome。
- 对话实时文本来自 `agent_item.kind=assistant_text`，按 run/item 身份聚合并按 SSE ID 去重。
  不展示原始思考或工具参数。`line.final_item_id` 用于合并最终答案；没有匹配 ID 时，
  产品经验证修订的最终 `line` 文本是权威结果，不能被早期模型的成功措辞覆盖。
  feed gap 后清除不完整增量并从持久化历史恢复，不能把缺少前文的文本称为完整回复。
- 停止当前对话使用 `POST /conversations/<id>/cancel {run_id,generation}`；历史对话无有效运行身份时不显示可执行停止。
  该操作按现有接口语义取消本对话的前台和后台工作，不作用于其他对话。
- 回答与取消共用运行生命周期栅栏。回答已提交时的回执不因读取线程清空答案而变为空；自动续接后的状态/版本仍以产品对象为准。
  自动续接在原 run 的 result 中保存仅含身份的 continuation，按 conversation/character/run/generation 校验。
  旧问题的取消仅沿实际自动续接链操作，不能跳到用户后来手动重试的同 job 新版本；进程重启后不能用旧 generation 取消无关新轮次。
  记忆删除、上下文撤权和重置也受同一栅栏保护，不能在校验与派发间复活已取消工作。
- `/desktop/presence.role` 与 C1 使用相同的元数据投影，可含 `run_id`、`conversation_id`、`generation`、`phase`、`outcome`。
  待处理问题/审批按实际对象状态存在，表现的短暂到期不等于交付被查看或接受。
- 删除自动记忆的共享来源时，同源失去证据的事实一并撤回，所有版本正文、相关运行 item、历史及 trace 按删除语义清理。
  用户纠正的主事实保留新版本及用户来源；不再引用已删除的 episode。无共享来源的事实不受影响。

## 1. 方向总表


| 方向 | 形式 | 状态 |
|---|---|---|
| hook → agentd | `POST /hook/claude`、`/hook/codex`：hook 输入原样，转发器加 `agentd_origin` 和 `agentd_started_at`（转发器启动时的 Unix 秒，浮点；agentd 按它给事件定时间和先后，不晚于到达时间，缺省或不是有限数时用到达时间）；`POST /integrations/hooks/disconnect` 回 `{target, removed}` | 已有 |
| Companion → agentd | `POST /say`（已有）、`POST /context/attention`、`POST /context/text`、`POST /context/image` | `/context/attention` 已有，心跳的 `focus_window` 已有；`/context/text`、`/context/image`、`/look` 已有 |
| 浏览器 host → agentd | `POST /context/browser` | 已有 |
| Companion → agentd | `GET /approvals`、`POST /approvals/<id>/decision`、`POST /speech/cancel`、`POST /character`、`/sessions*`、`/attention*` | 前三个已有；`GET /attention/summary`、`DELETE /attention` 已有；`/sessions*` 已有；`POST /character` 和 `GET /state` 的 `character` 已有 |
| agentd → 渲染器 | SSE `event: intent`：已有字段，加 `line_id`、`target`、`activity`、`mood` | `activity`、`mood` 已加；`target` 待做；C1 v2（`behavior`、`behavior_cancel`、`clause_intent`、执行回执、开关）见 `protocol/C1-agent-events/CONTRACT.md` |
| agentd → 渲染器（C2） | `GET /speech`：C2 NDJSON 原样转发，只改写 `session_epoch`（agentd epoch）、`turn_id`（= `line_id`）；agentd 截断时补 `cancelled`（见 §4.7） | 已有 |
| agentd → TTS 主机 | `POST /speech_stream`（`--tts-url`） | 已有 |
| agentd → Companion | `GET /feed` SSE：`event: line`、`agent_item`、`announce`、`command`、`request`、`nudge`、`thought`、`turn_accepted`（字段见 §4.4） | announce、line、command、request 已有；`nudge` 已有（`alert`、`comment`）；`/feed` announce 加 `trace_id`（只加不改）；`agent_item`：运行中的 item 帧；`delta` 只带新增文本，同一 item 每 100 ms 至多一条；`line` 的 `final: true` 帧加 `final_item_id`（只加不改）；`thought`：她的一句内心想法（只加不改）；`turn_accepted`：agentd 接受一句交给模型的输入、回 202 之前发，早于这一轮的任何 `line`、`agent_run`，被拒的输入和确定性命令不发；说话路由（`POST /say`、`POST /conversations/:id/messages`）的 202 加 `trace_id`，与它的 `trace_id` 相同（只加不改） |
| intent 枚举 | apologize、offer、listen、explain、think、acknowledge、celebrate、idle；活动集合另放 `activities.json` | 扩展待做 |
| Companion → agentd | `POST /trace/events`；`GET /trace/*`、`GET /diag/*`（[T1-TRACE.md](T1-TRACE.md)） | 格式已定（T1 v1）；端点和存储待做 |

**C6 `/context/attention` 的可选字段**。都可以省略，省略时 agentd 照旧处理；任一字段不合法整条心跳 400 `invalid_attention`。这些字段只在本机用，不进任何提示：
- `input`：对象，键只能是 `key_idle_s`、`pointer_idle_s`、`scroll_idle_s`、`click_idle_s`、`keys_10s`、`keys_60s`、`clicks_10s`、`scrolls_30s`、`moves_10s`、`switches_60s`、`near_clicks_10s`，值是非负数。只有计数和空闲秒数，不带任何键码、按键内容或坐标。
- `front.category`：字符串或 null，取自前台 app 的 `LSApplicationCategoryType`。`front` 命中黑名单时不发；agentd 收到后也按黑名单去掉，不写入 SQLite。
- `front_audio_out`：布尔或 null，表示前台 app 是否在出声。
- `front_video`：布尔或 null，表示前台 app 是否持有视频播放的电源断言。
- `front_gpu`：0 到 1 之间的数或 null，是前台 app 自上一次心跳以来的 GPU 忙碌比例。
- `screen_captured`：布尔或 null，表示系统的屏幕录制指示开着，而麦克风和摄像头都没在用（共享屏幕或录屏）。
- `edge`：`"lock"`、`"unlock"`、`"sleep"`、`"wake"` 或 null。

`input`、`front_audio_out`、`front_video`、`front_gpu`、`screen_captured` 只进 agentd 内存里保留 300 s 的环（`AttentionStore.inputs(window_s)`），不写 SQLite，重启即丢。这些字段只在本机使用，不进任何提示文本、judge 的 state 和 trace 文本；Companion 设置 `sense_input_counts` 关掉时不发。`events_raw.input_near` 是 agentd 由内存环推出的 0/1/空标记（事件前后 2 秒内有没有按键、点击或滚动），不存计数。

**本机用户状态**（`observation/user_now.py`）。两个核心端点使用外壳的 ui 令牌，不属于任何插件，关闭屏幕感知时照常可用。粗信号、快照和事件只在内存里，重启即丢：不写 SQLite（屏幕感知关时不建 `attention.sqlite`）、文件或日志（日志只可记事件名，不记粗信号的值），不进提示文本、judge 的 state 和 trace。

- `POST /user/coarse` 成功 200 `{presence, stage, doing, absence, revision, typing}`：判定这条样本之后快照里的前五项，`typing` 是布尔：快照的 `typing`，它为 null（没有键鼠计数）时取 `input_active`（回包样例 `fixtures/user-coarse-reply.json`，接在 minimal 之后发 full 的回包）；外壳留住最后一次回包，按它读离开、回来、等级、开会和打字，不自己判定；没有回包（agentd 没起或最近一次失败）时按在场、等级 `normal`、`doing` 为 `idle`、不在打字处理。字段白名单：必填数值 `ts`（Unix 秒）和非负数值 `idle_s`（HID 空闲秒数）；可选布尔 `locked`、`asleep`、`fullscreen`；`edge` 为 `lock`、`unlock`、`sleep`、`wake` 或 null；可选的布尔或 null：`front_video`、`front_audio_out`、`camera_active`、`mic_active`（只算别的 app 占用麦克风，不含本 app）、`screen_captured`、`user_speaking`；`front_gpu` 为 0–1 的数或 null；可选对象 `input` 只收非负数值 `key_idle_s`、`pointer_idle_s`、`keys_10s`、`keys_60s`、`switches_60s`。保存的 `sense_input_counts` 没开时带 `input` 就拒收。任一层出现白名单外的键（如 `front`、`title`、`app`），或类型、取值不对，整条 400 `{"error": "invalid_coarse"}`。请求样例：`fixtures/user-coarse-full.json`（全部字段）、`fixtures/user-coarse-minimal.json`（只有 `ts`、`idle_s`）、`fixtures/user-coarse-invalid.json`（带 `front`，400）。
- 暂停：只有 `PUT /observation/paused` 冻结它。暂停期间仍校验请求、合法的回 200 `{}` 但不收，观察到的维度停在上一个值，快照 `paused: true`；暂停结束后下一次判定按样本缺失处理。手动开会和安静（`PUT /observation/meeting`、`/observation/quiet`）不冻结它，只是覆盖项：手动开会让 `doing` 为 `meeting`，期间不收屏幕感知的内容提示（同观察暂停）；安静让 `stage` 为 `quiet`。
- `GET /user/now` 200 `{snapshot, events}`，读取不触发判定；agentd 收到样本、内容提示、开关变化时判定一次，另每秒按时钟判定一次（样本间隔、迟滞到点、到期）。`snapshot`：`revision`（每次变化 +1）、`presence`（`asleep` > `locked` > `away` > `present` > `unknown`）、`doing`（`sharing` > `meeting` > `gaming` > `watching` > `reading` > `browsing` > `idle`）、`input_active`（在场且 HID 空闲 ≤ 2 s）、`typing`（没有键鼠计数时 null；10 s 内 ≥ 8 次按键且键盘空闲 ≤ 2 s 开始，键盘空闲 5 s 结束）、`flags` `{fullscreen, music, late_night, user_speaking, focused}`（`focused` 没有 `switches_60s` 时 null）、`overrides` `{meeting_manual, dnd_until, focus_timer}`、`stage`（`offstage`、`quiet`、`normal`、`engaged`）、`absence`（`{id, since}` 或 null；`id` 是跨重启唯一的字符串）、`paused`。`events` 是最近 20 条，先旧后新，每条 `{revision, ts, name, data}`；`name` 为 `user.enter.<值>`、`user.leave.<值>`（`presence` 和 `doing` 的值）、`user.return`（`data` `{absence_id, away_s}`）或 `stage.<等级>`，其余 `data` 为 `{}`。回包样例：`fixtures/user-now.json`。
- 规则：HID 空闲 180 s 为 `away`；`away`、`locked`、`asleep` 连成一段离开，开始时间回溯到最后一次输入（进入时的 `ts - idle_s`），回到 `present` 时这段结束并只发一次 `user.return`，`away_s` 从回溯的开始算。样本间隔超过 5 s 为 `unknown`（不算离开），之前来过 `lock` 或 `sleep` 边沿时保持锁屏或睡眠。`meeting`：手动开会，或摄像头开，或麦克风被别的 app 占用；`sharing`：`screen_captured`；`gaming`：全屏且最近 5 拍里至少 3 拍 `front_gpu` ≥ 0.5，或内容提示为游戏；`watching`：`front_video`；`reading`、`browsing` 只来自内容提示。迟滞：默认进 3 s、出 5 s，`sharing`、`meeting`、`locked`、`asleep` 立即，`focused` 进 600 s（同一 `doing`、`switches_60s` 为 0）出 60 s。`stage` 按序取第一条成立的：1 `sharing` → `offstage`；2 `locked`、`asleep`、`away` → `offstage`；3 全屏的 `gaming` 或 `watching` → `offstage`；4 `meeting`（含手动）或安静未到期 → `quiet`；5 `focused`、`typing`（没有计数时为在场满 60 s 且 `input_active`）或非全屏 `watching` → `quiet`；6 回来、说过话或点过她 60 s 内 → `engaged`；7 `unknown` → `normal`；8 其余 → `normal`。

**C6 角色状态端点**（消费方是角色页和 Trace）。字段和规则见 §4.2：
- `GET /character/state`（ui 或 events token）：当前角色的 `{character_id, energy, valence, engagement, activity, labels, causes, affects_behavior}`，值是真实记录的，和开关无关。精力的钟点目标：9–18 点 0.8，19–22 点 0.6，6–8 点 0.5，23–5 点 0.3；坐、待着、睡只把精力补回到钟点目标为止。
- `DELETE /character/state {character_id}`（ui）：服务端在角色切换锁内核对预期角色、清空并返回新状态。缺少身份回 400；角色已变回 409 `character_changed`，切换事务中回 409 `switching`；这些失败均不清空任何角色。只删指定的当前角色，从钟点目标和心情基线重新开始。
- `PUT /character/state/switch {affects_behavior}`（ui）：「状态影响行为」开关，只在内存里，默认 true。关掉时照样记状态，但权重、系数一律取 1，摘要和档位为空。
- `GET /diag/state` 多一个 `character_state` 块，内容同 `GET /character/state`；`gate.cooldown_s` 的 `comment` 乘上状态系数，和闸门实际用的一致。
- `POST /reset` 的清单加 `agentd.sqlite` 的 `character_state`（所有角色的行）。

**C6 活动摘要 v2 端点**（消费方是 Companion 的时间线和设置）。字段和规则见 §4.2：
- `GET /episodes/<id>/evidence`（ui）：这段摘要依据的事实表 header、编号行 `{n, tag, text}` 和运行回执 `run`；原文只在 48 小时内有，过期、被删或没有 `run_id` 回 410 `evidence_expired`，没有网页正文同意回 403 `page_text_off`。
- `PATCH /episodes/<id> {title, description}`（ui）：用户改标题（1–16 字）和描述（1–100 字），`edited` 置 true，改前改后记进 `summary_corrections`，留给夜间整合当反例；`GET /episodes` 每条多 `outcome` 和 `edited`。
- `GET /summary/runs?date=&kinds=`（ui）：一天的运行回执，新的在前，`kinds` 默认 `memory_extract`，不带输入、输出文字。
- `POST /blacklist/defaults {}`（ui）：把用户删掉的默认排除项加回来，回 `{added}`。
- `POST /reset` 的清单加 `agentd.sqlite` 的 `summary_corrections`。

**C6 角色工具审批**

`GET /agent/interactions` 的 `kind: approval` 请求在 `data.approval_answers` 列出可发送的答案：普通工具为 `["allow", "allow_session", "deny"]`，命中危险规则或策略 `single_only` 时仅 `["allow", "deny"]`。旧客户端的 `允许` / `拒绝` 仍有效；省略该字段的旧卡只支持单次允许和拒绝。`data.questions[].options` 的对应显示文字是「允许」「本对话都允许」「拒绝」。

`POST /agent/interactions/:interaction_id/answer` 请求体为 `{"expected_version": 1, "answers": {"decision": ["allow_session"]}}`（审批体 schema：`fixtures/approval-answer.schema.json`；普通提问仍接受自由文本）。必须回显 revision；未提供的答案、危险卡的 `allow_session` 返回 400 `invalid_approval`，卡仍待决。现有过期、失效和版本检查照旧。

授权仅留在 agentd 内存，以 run 的 conversation_id（未知时限于该 run）、server 和 tool 为键；MCP 还必须匹配 `catalog_sha256`。同对话后续轮次可复用，参数可以不同，但每次仍先经过 ApprovalPolicy 危险判断。catalog 改变会移除旧授权；换对话不继承，重启清空，失效/清理所属运行也撤销授权。内置工具没有 MCP catalog；原有无需卡片的 sandbox、scope、native panel 权限流程照旧。

自动允许的调用仍通过 effect ledger，效果回执保留原始 `approval_request_id` 并标记 `session_allowed: true`；工具结果 `endfield_approval` 同样带此标记和本次输入摘要。`agent_interaction` feed 事件以 `state: allowed_session`、`session_allowed: true`、`conversation_id`、`run_id`、`server`、`tool`、epoch 秒 `at` 通知当前聊天，在该调用下显示淡色「已按本对话设置允许」。该提示是当前网页会话的 feed 展示，刷新后不回放；审计依据仍是 effect ledger。

## 2. 健康、模型设置与能力快照


只记 `api/handler.py`、`api/settings.py`、`models/model_backends.py`、`models/model_auth.py`、`models/capabilities.py` 现在的行为。
夹具：`protocol/C6-agentd-api/fixtures/`，每个 GET 一份示例回包（值是假的）；`loose-fields.json` 列出可为 null 的字段（`nullable`）和键不固定的映射（`free_keys`）。
`agent/agentd/tests/test_c6_fixtures.py` 在进程内起 agentd，逐层比对真实回包和夹具的键集合（数组比第一项）和 JSON 类型；外壳一侧 `app/electron/test/c6.test.ts` 解码 health 和 state 的夹具。

**`/model/*` POST 的共同规则**（下面各条不再重复）：
- 令牌：ui token；别的令牌 401 `unauthorized`。先在 `api/handler.py` 的 `parse_request` 中检查路由和令牌，通过后才在 `_dispatch` 中检查重置状态；`POST /reset` 进行中时回 503 `resetting`。不在下列路径里的 `/model/...` 回 404 `not_found`。
- 请求体：必须有，`Content-Length` 1 字节到 8 MiB，否则 400 `invalid_body_size`；不是 JSON 时 400，`error` 是 Python 的 JSON 解析报错原文（文本未定义）；不是对象 400 `invalid_payload`。下面写「请求体 `{}`」的端点不读内容，但仍要发一个对象。
- agentd 没有模型设置时（`server.models` 为 None）一律 503 `models_unavailable`。
- 业务错误 400 `{"error": <码>}`；连不上 provider 502 `provider_unreachable`；其他异常 502 `provider_request_failed`（不回异常文本）。
- 连接类错误码（`catalog` 用，来自 `ModelSettings.connection()`、`ChatGPTAuth.access_token()`、`check_response()`）：设置文件读不了时的 `credential_permissions` / `settings_unreadable`，`missing_api_key`，`sign_in_required`，`plan_usage_not_enabled`，`auth_unavailable`，`invalid_token_response`；provider 回 401 `credentials_rejected`、403 `model_access_denied`、429 `usage_limit`、其他 `provider_http_<状态码>`，回包 `error.code` 是 `subscription_sharing_usage_limit_exceeded` / `subscription_sharing_usage_unavailable` 时原样用这个码。

**`GET /health`**
- 令牌：无（在令牌检查之前回）。请求体：无。
- 就绪：200 `{"status": "ok", "degraded": [...], "c6_contract": "v1"}`；`degraded` 是启动失败、agentd 不带它继续运行的可选子系统名（字符串数组，可空）：`observations`、`memory_pipeline`、`recover_tasks`、`recover_commitments`、`speech`。
- 启动中（套接字已绑定、初始化未完成）：200 `{"status": "starting", "stage": <阶段名>, "degraded": [...], "c6_contract": "v1"}`；`stage` 是英文短词（`init`、`storage`、`character_agent`、`observation`、`sessions`、`speech`、`recovery`、`memory`、`behavior`）。这期间其他所有路由（含 hook 端点）在令牌检查之后回 503 `{"error": "starting"}`。没有错误回包。

**`GET /model/settings`**
- 令牌：只收 ui token（events token 也 401 `unauthorized`）。503 `models_unavailable`：没有模型设置。
- 200（`ModelSettings.public()` 加 `mouth_ready`）：「pi 账号与凭据」页，只存内置 pi 内核用的凭据：
  - `provider`：字符串，`anthropic` / `deepseek` / `xai` / `openai` / `compatible` / `pi_catalog` / `chatgpt`，pi 没写服务提供方时用的连接；这一项后端的 `model` 是 pi 的默认模型，`reasoning_effort` 是 pi 的默认思考档位。`catalog` 也用它。
  - `backends`：对象，键就是这七个 provider，值：
    `model` 字符串（`""` 为没选）、`base_url` 字符串、`max_output_tokens` 整数（缺省 4096）、`reasoning_effort` 字符串（`""` 为不设，或 Pi 的思考档位 `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`）、
    `has_key` 布尔（存了 `api_key`；`pi_catalog` 是当前 `pi_provider` 的 Key）。
    `compatible` 另有 `supports_images` 布尔（缺省 false）、`context_window` 整数（缺省 128000）、`reasoning` 布尔（缺省 false）：Pi 按它们注册这个模型。
    `pi_catalog` 另有 `pi_provider` 字符串（Pi 目录里的服务 id，`""` 为没选），`base_url` 恒为 `""`（地址来自 Pi 目录）。
    `api_key` 从不回。
  - 没有设置文件时 `provider` 为 `chatgpt`。
  - `chatgpt`：`active` 字符串或 null（当前登录项 id，没有为 null）、`pending` 布尔（登录在等浏览器回调）、`error` 字符串或 null（最近一次登录失败的码，如 `sign_in_expired`、`sign_in_denied`、`account_mismatch`）、
    `profiles` 数组，每项 `{id, label, email, connected, sharing}`：`email` 不知道时为 `""`，`connected` 为有 access token，`sharing` 为已连接且授权里有 `chatgpt.tokens.use.direct`。
  - `error`：null；或设置文件读不了的码（`credential_permissions`、`settings_unreadable`），这时回的是默认设置，连接都报这个码，每次读都会重试读文件。
  - `mouth_ready`：布尔，agentd 有没有角色对话（`server.mouth` 不为 None）。

**`POST /model/settings`**
- 请求体：`provider`（必填，同上七个之一，否则 `invalid_provider`）；可选 `model`、`base_url`（字符串 ≤ 1024）、`api_key`（字符串 ≤ 8192）、`max_output_tokens`（整数 128–32768）、`reasoning_effort`（`""` 或上面的 Pi 思考档位）、
  `supports_images`（布尔）、`context_window`（整数 1024–10000000）、`reasoning`（布尔）：这三项只对 `compatible` 生效；`pi_provider`（字符串，`[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}`，只对 `pi_catalog` 生效，换了时 `model` 清空）、`clear_key`（为 true 时删 key）。只改 `provider` 那一项后端；别的键忽略。
- `pi_catalog` 的 `api_key`、`clear_key` 只作用于当前 `pi_provider` 的 Key，每个服务的 Key 各自保留；没选 `pi_provider` 时回 `invalid_pi_provider`。它的 `base_url` 不存。
- `base_url` 只收 https，或 localhost / 127.0.0.1 / ::1 的 http，不能带用户名、密码、query、fragment；`chatgpt` 的 `base_url` 固定为 `https://api.openai.com/v1`、不存 key；换了主机又没给新 `api_key` 时旧 key 删掉。
- `deepseek` 的地址固定为 `https://api.deepseek.com`，必须有 Key。
- 200：同 `GET` 但没有 `mouth_ready`。400：`invalid_provider`、`invalid_model`、`invalid_base_url`、`invalid_api_key`、`invalid_output_budget`、`invalid_reasoning_effort`、`invalid_supports_images`、`invalid_context_window`、`invalid_reasoning`、`invalid_pi_provider`。

**`POST /model/catalog`**
- 请求体 `{}`。列出已存 `provider` 的模型：
  - `anthropic`、`deepseek`、`xai`、`openai`、`pi_catalog`：Pi SDK 随包的离线目录（`pi_catalog` 用它的 `pi_provider`，没选时 `models` 为 `[]`），由一个只读的 Pi runner 进程读出，不联网、不要 Key。
  - `compatible`、`chatgpt`：用已存连接拉服务自己的 `/models`（`chatgpt` 只留 `visibility` 为 `list` 的）。
- 200 `{"providers": [{"id", "name"}], "models": [{"id", "name", "context_window", "max_tokens", "input", "reasoning", "thinking_levels", "priced"}]}`。
  `providers` 是 Pi 目录里能用 API Key、并且有 Endfield 包里能跑的模型的服务（没有 Google、Vertex、Bedrock，也没有只能订阅登录的服务）；拉服务自己的 `/models` 时为 `[]`。
  `context_window`、`max_tokens` 整数；`input` 是 `"text"` / `"image"` 数组；`reasoning` 布尔；`thinking_levels` 是这个模型能用的 Pi 思考档位（不思考的模型只有 `["off"]`）；`priced` 布尔，目录里有价格。拉服务自己的 `/models` 时这六项都是 null。
- 400：共同规则的连接类错误码；Pi 目录读不出时 `pi_runtime_unavailable`、`pi_runner_error`、`pi_node_version_mismatch`、`sdk_policy_capability_missing`、`sdk_startup_timeout`。

**`POST /model/test`**
- 请求体 `{}`。内核是 Pi 时用它的主连接（不走 `judge` 路由）调一次模型；别的内核跑一次 `review` 语义任务。都只要求回 `{"ok":true}`，不带角色上下文和桌面内容。
- 200 `{"ok": true, "kernel": <内核>, "provider": <字符串或 null>, "model": <字符串>, "elapsed_ms": <整数>, "tokens": <对象或 null>, "cost_usd": <数或 null>}`，`model` 是内核报告的模型；`provider`、`tokens`（`input_tokens`、`output_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens`）只有 Pi 有，`cost_usd` 只在模型有目录价格时有。400：语义任务和内核就绪的错误码（如 `unsupported_harness`、`semantic_busy`、`pi_model_unavailable`）。

**`POST /model/chatgpt/start`**
- 请求体 `{"profile_id"?}`：给已有 id 时重新登录这一项，不给或 null 时新建一项。agentd 在 127.0.0.1 随机端口开回调，用系统浏览器打开 `auth.openai.com` 的授权页；180 s 内没回调 `chatgpt.error` 变成 `sign_in_expired`。
- 200：`chatgpt` 块（同 `GET /model/settings` 的 `chatgpt`），`pending` 为 true。400：`sign_in_pending`、`unknown_profile`、`browser_unavailable`。

**`POST /model/chatgpt/cancel`**
- 请求体 `{}`。停掉在等的登录（没有也照样）。200：`chatgpt` 块。

**`POST /model/chatgpt/select`**
- 请求体 `{"profile_id"}`。设为当前项。200：`chatgpt` 块。400：`unknown_profile`、`credential_permissions`。

**`POST /model/chatgpt/logout`**
- 请求体 `{"profile_id"}`。有 refresh token 时向 OpenAI 撤销，再删掉这一项的令牌；这一项本身留在 `profiles` 里（`connected` 变 false）。
- 200 `{"revoked": <布尔>}`：没有 refresh token，或撤销端点回 200，为 true。400：`sign_in_pending`、`unknown_profile`。

**`GET /capabilities`**
- 令牌：只收 ui token。总是 200，只读 agentd 已有的状态，不发请求。
- 200 `{"plugins": {插件 ID: bool}, "items": {名字: {"state", "reason"}}, "at"}`：`state` 为 `configured`、`ready`、`degraded`、`unavailable`、`unknown` 之一；`reason` 为原因码字符串或 null；`at` 为本地时区 ISO 8601，毫秒。
- `items` 的名字和取值：
  - `generation`：设置读错 `degraded` / 那个码；`chatgpt` 未登录或没授权 `unavailable` / `sign_in_required` 或 `plan_usage_not_enabled`；非 `compatible` 没 key `unavailable` / `missing_api_key`；否则 `configured` / null。
  - `mouth`：有角色对话 `ready` / null，没有 `unavailable` / `no_llm`。
  - `voice`：没有 TTS `unavailable` / `no_tts`；静音 `configured` / `muted`；最近一次语音结果是失败时 `degraded` / 那次 `speech.failed` 的 `reason`（取值本节未定义）；否则 `ready` / null。
  - `personal_agent`：只在 agentd 有个人代理运行时（`server.character_agent` 不为 None）时出现。还没扫描过运行时 `unknown` / `runtime_not_scanned`；否则就绪为 `configured`、不就绪为 `unavailable`，`reason` 是最近一次扫描的错误码或 null。选了个人代理时 `generation` 取同一个值。
  - `share_window_text`、`share_page_text`、`share_screenshots`、`share_typed_text`、`share_agent_sessions`：当前生效的授权里这项开着为 `configured` / null，否则 `unavailable` / `off`。取的是 `ConsentPolicy.snapshot()`：启动能力与保存的隐私设置取与，保存的设置关掉或撤销后不用重启就报 `off`。
  - 上面某项的依赖不在时（`models` 为 None 等）为 `unknown` / `not_running`。

**`POST /voice/test`**
- 令牌：只收 ui token。请求体 `{"url"?: 字符串, "token"?: 字符串}`，省略 `url` 时取当前 `server.speech` 的地址；角色和语言也取当前中继。省略 `token` 时，只有 `url` 的协议、主机和端口与当前中继相同才带上保存的令牌，别的地址不带令牌。未配置中继时 503 `no_tts`；字段类型不对时 400 `invalid_payload`。
- 先 GET `<url>/health`，再 POST `<url>/speech_stream` 合成固定短句「你好。」并检查 C2 流（没有任何 audio 的流算 `bad_stream`），不写入 `/speech` 缓冲，不出声。地址接受有主机名的 HTTP 或 HTTPS，包括非回环 HTTP。
- 200 `{"ok": 布尔, "first_audio_ms": 整数或 null, "total_ms": 整数或 null, "reason": 字符串或 null}`；耗时从 POST 开始，分别到首个 audio 和 complete。成功时 `reason` 为 null，失败为 `invalid_url`、`unreachable`、`http_401`、`http_<状态码>`、`bad_stream` 或 `timeout`。

**角色对话**

- `GET /conversations?character=<id>` 返回 `{character, conversations, busy}`。省略角色时取桌面角色，未知角色返回 404 `unknown_character`。列表包含该角色的归档对话。每行的 `active` 表示该角色当前选中的话题，`character_id` 是所属角色。`preview` 取最新一轮的回复，回复为空时取用户原文，去掉标记、合并空白后保留前 60 个字符。空对话的预览为空字符串。
- `POST /conversations {title?, character_id?}` 为指定角色创建并选中话题，默认取桌面角色。`POST /conversations/:id/activate {expected_version}` 选中话题所属角色的对话。切换桌面角色会载入她选中的话题，首次切换时创建「新对话」。创建、选中、编辑或删除其他角色的话题均可在当前角色忙碌时进行。
- 旧对话归属于其中发言轮数最多的角色。没有轮次时归属于角色目录的默认角色。升级会保留旧的选中话题。话题中有排队或运行中的后台任务时，删除返回 409 `busy`。

**`POST /conversations/:id/messages`**

- 发送文字时可带 `quote_turn: {"turn_id": 字符串, "part": "user" | "reply"}`。角色用 chat 回答，上下文标明引用来自本对话的历史消息及其说话者。引用格式错误、轮次不存在或属于其他对话时返回 400 `invalid_quote_turn`。
- 对话所属角色不在桌面时返回 409 `{"error":"character_not_present","character_id":"<owner>"}`。
- 令牌：只收 ui token。请求体 `{"text": 字符串, "look"?: 布尔, "no_memory"?: 布尔, "scope_id"?: 字符串, "quote_turn"?: 对象}`；`text` 去掉首尾空白后 1–8000 字符，缺 `text` 或有别的字段 400 `invalid_text`；`look`、`no_memory` 不是布尔 400 `invalid_look`、`invalid_no_memory`。
- `scope_id` 是 `POST /agent/scopes` 建的资料范围，这一轮按它读写；不是 1–128 字符的字符串 400 `invalid_scope_id`；与 `no_memory: true` 同给 400 `temporary_scope_not_allowed`；范围失效时 409，码同 `POST /say`（`scope_revoked` 等）。

**`POST /voice/token`**
- 令牌：只收 ui token。请求体 `{"token": 字符串}`；空白、空或非字符串令牌返回 400 `invalid_token`。
- 将令牌写入系统凭据存储（C10），并立即替换 `server.speech.token`。200 `{"ok": true}`，后续请求无需重启即可使用新令牌。

**`POST /interaction/tap`**
- 请求体和回包见 §4.2；请求体另可带 `"region"?: 字符串`，取值同 C3 规则 45(a) 的 15 个触摸区域，表示点中的部位。
- `region` 不是字符串或不在这 15 个里时忽略（agentd 在 stderr 记一行），照没带处理，不返回错误。认得的 `region` 只在说点击回应时作为部位告诉「嘴」；`reason` 仍是 `{"code": "tap"}`，说仪式时不用它。回包不变。

**`GET /characters/:character_id/motion-graph`**
- 令牌：只收 ui token。请求体：无。处理模块 `character/motion_graph_routes.py`。
- 200：已装角色包里 C7 包的 `animation/motion-graph.json`（`characters/agentic_complex_build/motion_graph.py` 写的，schema `endfield-motion-graph/v1`），内容原样，只在顶层加 `package_sha256`（已装包 `character.json` 的 sha256，`motion_tool.py chain` 提案的 `package_sha256` 填它）。示例（节选，值是假的）：
  `{"schema": "endfield-motion-graph/v1", "character": "aster", "crossfade_s": 0.25, "runtime": {…}, "groups": [{"id": "base", "title": "基础站姿与桥接", "parent": null}], "clips": [{"name": "idle", …}], "edges": [{"from": "idle", "to": "wave", "gap": 3.2, …}], "chains": {"wave": [{"clip": "wave", …}]}, "counts": {"clips": 1, "edges": 1, "chains": 1, …}, …}`
- 404 `unknown_character`：角色库里没有这个 id（没有角色库时，开发用的源目录不算已装包，一律如此）。404 `motion_graph_missing`：包里没有这份文件（没有 C7 包的纯文字角色也是）。

**`GET /characters/:character_id/motion-groups`**
- 令牌：只收 ui token。请求体：无。处理模块 `character/motion_graph_routes.py`，分类在 `motion/groups.py`，规则是数据 `motion/groups.json`（排除规则各带 `reason`，名字规则各带 `id`），不写角色 id 和片段名。
- 只答当前角色：别的 id（含不认识的）409 `not_current`。当前角色没有动作选择器（纯文字角色）或 C7 包里没有 `animation/motion-graph.json` 时 404 `motion_graph_missing`。
- 200 `{character, pools, excluded, unclassified, counts}`。`pools` 是动作选择器认得的每个池子键（agentd 认得的每个事件键，包里没有的也在，和 `idle.t<n>`）→ `{posture, pack, proposal, rejected}`：`posture` 是这个池子的姿势；`pack` 是包自己的池子（不算用户的覆盖），`[{clip, weight}]`，`click.` 开头的键（`click.repeat` 除外）是 `events` 的池子，其余有审过的 `motion_library` 片段时是它们，否则是 `events` 或 `idle_tiers` 的池子，包里没有的键为 `[]`；`proposal` 是提议加进来的 `[{clip, weight: 1, why}]`，`why` 为 `token:<规则 id>`、`meaning:<规则 id>` 或 `structure:chain|loop|one_shot`，同一片段可以出现在多个池子的 `proposal`；`rejected` 是规则指到这个池子、但过不了动作选择器的池子检查（同 `PUT /behavior/motion_prefs` 覆盖池子的检查）的 `[{clip, reason}]`，`reason` 为 `unknown_clip`、`stance_mismatch`、`excluded_family`、`no_return`。
- 动作图的片段按顺序取第一条成立的：在某个 `pack` 里或在它们抽出的链里（`counts.pooled`）；动作图的 `group` 不是 `unwired`，包用别的方式播它（`excluded`，`reason: "wired"`）；排除规则（`excluded`，`reason` 是规则的，如 `battle`、`monster`、`cutscene`、`locomotion`、`prop`）；不是动作图 `chains` 的键，只在别的片段的链里（`excluded`，`reason: "in_chain"`）；名字规则（第一条有池子的）和每条词义规则；这些都没有时结构规则：链在起头之后有循环 → `chain`，起止姿势相同、有这个姿势的空闲档的循环 → `loop`，站着开始、链停在站姿、短于 4 s 的一次性片段 → `one_shot`；都不成立的进 `unclassified`（片段名列表）。`excluded` 和 `unclassified` 里的片段不在任何 `proposal`、`rejected` 里。名字和结构规则各列一串池子键（`idle.*` 是按顺序的每个空闲档），取其中动作选择器认得、姿势等于片段起始姿势的第一个，没有就取认得的第一个；一个都不认得的名字规则跳过。
- 词义规则（`meanings`，各带 `id`）：片段名按 `_` 切成词、小写、去掉词尾数字，有一个词在规则的词表里就成立，每条成立的规则把片段提议进它列的每个事件键；键 `k` 对站姿起始的片段就是 `k`，对别的起始姿势是 `k@<姿势>`（坐着起始的片段只进 `@sit` 的键），本身带 `@` 的键只给这个姿势起始的片段，动作选择器不认得的键跳过；同一片段同一池子只记第一条规则。已在包池子里的片段只走词义规则，只提议进它不在其 `pack` 里的池子，且须是动作图 `chains` 的键、不中排除规则。
- `counts` `{clips, pooled, proposed, rejected, excluded, unclassified, proposals}`：每个片段只记一次，记在它的第一类（`pooled`、`proposed`、`rejected`、`excluded`、`unclassified` 的顺序），这五项加起来等于 `clips`（动作图的片段数）；`proposals` 是所有池子 `proposal` 的条数之和。
- 示例：`fixtures/motion-groups.json`（`loose-fields.json` 里 `pools` 的键不固定）。

**`GET /characters/:character_id/mod-settings`**
- 令牌：只收 ui token。请求体：无。处理模块 `character/mod_settings_routes.py`。
- 200：已装角色包里 C7 包经 `pack.json` 的 `interaction.data` 登记的 `interaction/mod-settings.json`（schema `endfield-mod-settings/v1`），每个外观只回 `settings`，每项只留 `id`、`name`、`category`（表里有才回，取值见 `protocol/character-library/CONTRACT.md`「mod 设置」）、`values`、`default`（不回 `origin`，也不回 `segments`、`textures`）；顶层带 `character` 和 `package_sha256`（已装包 `character.json` 的 sha256）。包里没有这张表（含没有 C7 包的纯文字角色）时 `appearances` 为 `{}`，仍是 200。选了哪个值不在 agentd 存。示例（值是假的）：
  `{"character": "aster", "package_sha256": "…", "schema": "endfield-mod-settings/v1", "appearances": {"mod_a": {"settings": [{"id": "coat", "name": "外套", "category": "clothing", "values": [{"value": 0, "name": "穿"}, {"value": 1, "name": "脱"}], "default": 0}]}}}`
- 404 `unknown_character`：同 motion-graph。409 `component_sha_mismatch` 或 `component_length_mismatch`：`pack.json` 或这张表装好后被改过，和包登记的 sha256 或长度不符。

## 3. 端点总表（生成）

<!-- gen:routes begin -->
由 `protocol/tools/gen_routes.py` 从 `agent/agentd/route_registry.py` 生成，不要手改；改登记后在仓库根目录跑 `python3 -I protocol/tools/gen_routes.py --write`。

每个请求依次过这些关（`api/handler.py` 的 `Handler.parse_request`、`_answers_500`）：Host 不是本机或端口不符 400 `invalid_host` → 带 `Origin` 或 `Sec-Fetch-Site` 不是 `none` 403 `cross_site` → `OPTIONS` 405 `method_not_allowed` → POST/PUT/PATCH 带请求体且 `Content-Type` 不是 JSON 415 `unsupported_media_type` → 方法加路径不在本表 404 `not_found` → 令牌不在「令牌」列 401 `unauthorized` → 启动未完成 503 `starting`（`GET /health` 除外）→ 所属插件已关闭 409 `plugin_off` → 处理模块 → 回状态行前未捕获的异常 500 `internal_error`。

「路径」里 `:name` 是一段路径参数；「面板」是可以发这条请求的网页面板，「—」为没有；「规格」是写这条端点字段和错误码的文档，「—」为还没有；「回包夹具」是 `fixtures/` 下的示例回包。

| 方法 | 路径 | 令牌 | 网页类 | 面板 | 处理模块 | 规格 | 回包夹具 |
|---|---|---|---|---|---|---|---|
| GET | `/health` | 无 | `read` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | `health.json` |
| GET | `/context/browser/policy` | hook | `hook_only` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/state` | ui 或 events | `read` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | `state.json` |
| GET | `/events` | ui 或 events | `stream` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/speech` | ui 或 events | `stream` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/character/state` | ui 或 events | `read` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | `character-state.json` |
| GET | `/character/state/history` | ui | `read` | main | `api.handler` | — | — |
| GET | `/characters/:character_id/binding` | ui | `read` | main | `character.binding_routes` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/characters/:character_id/motion-graph` | ui | `read` | main | `character.motion_graph_routes` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/characters/:character_id/motion-groups` | ui | `read` | main | `character.motion_graph_routes` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/characters/:character_id/mod-settings` | ui | `read` | main | `character.mod_settings_routes` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/approvals` | ui | `read` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/feed` | ui | `stream` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/agent/snapshot` | ui | `read` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | `agent-snapshot.json` |
| GET | `/attention/summary` | ui | `read` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/attention/browser` | ui | `read` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/sessions` | ui | `read` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/history` | ui | `read` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | `history.json` |
| GET | `/history/export` | ui | `read` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/memory` | ui | `read` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | `memory.json` |
| GET | `/memory/sessions` | ui | `read` | main | `character_agent.routes.worklog_http` | `protocol/C6-agentd-api/CONTRACT.md` | `memory-sessions.json` |
| GET | `/memory/tasks` | ui | `read` | main | `character_agent.routes.worklog_http` | `protocol/C6-agentd-api/CONTRACT.md` | `memory-tasks.json` |
| GET | `/memory/tasks/:task_id` | ui | `read` | main | `character_agent.routes.worklog_http` | `protocol/C6-agentd-api/CONTRACT.md` | `memory-task.json` |
| PATCH | `/memory/tasks/:task_id` | ui | `write` | main | `character_agent.routes.worklog_http` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/memory/days` | ui | `read` | main | `character_agent.routes.worklog_http` | `protocol/C6-agentd-api/CONTRACT.md` | `memory-days.json` |
| GET | `/memory/days/:date` | ui | `read` | main | `character_agent.routes.worklog_http` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/memory/export` | ui | `read` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/diag/state` | ui | `read` | main、onboarding | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/diag/stream` | ui | `stream` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/blacklist` | ui | `read` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/desktop/presence` | ui | `host_only` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | `desktop-presence.json` |
| GET | `/user/now` | ui | `host_only` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | `user-now.json` |
| POST | `/desktop/sessions/seen` | ui | `write` | main、stack | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/model/settings` | ui | `read` | main、onboarding | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | `model-settings.json` |
| GET | `/motion/settings` | ui | `read` | main | `motion.routes` | `protocol/C1-agent-events/CONTRACT.md` | — |
| GET | `/motions/:motion_id/meta`、`/motions/:motion_id/keys` | ui 或 events | `host_only` | — | `motion.routes` | `protocol/C1-agent-events/CONTRACT.md` | — |
| GET | `/motions/:motion_id/tracks` | ui 或 events | `host_only` | — | `motion.routes` | `protocol/C1-agent-events/CONTRACT.md` | — |
| GET | `/tasks` | ui | `read` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | `tasks.json` |
| GET | `/capabilities` | ui | `read` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | `capabilities.json` |
| GET | `/day/segments` | ui | `read` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | `day-segments.json` |
| GET | `/episodes` | ui | `read` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | `episodes.json` |
| GET | `/commitments` | ui | `read` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | `commitments.json` |
| GET | `/schedules` | ui | `read` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | `schedules.json` |
| POST | `/schedules` | ui | `write` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| PUT | `/schedules/:schedule_id` | ui | `write` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| DELETE | `/schedules/:schedule_id` | ui | `write` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/schedules/:schedule_id/run` | ui | `write` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/focus` | ui | `read` | main、stack | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | `focus.json` |
| GET | `/proactive/mutes` | ui | `read` | main、stack | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/proactive/settings` | ui | `read` | main、onboarding | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/proactive/stats` | ui | `read` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/brief/day` | ui | `read` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/summary/runs` | ui | `read` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | `summary-runs.json` |
| GET | `/trace/turns` | ui | `read` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | `trace-turns.json` |
| GET | `/trace/decisions` | ui | `read` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/trace/export` | ui | `read` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/trace/events` | ui | `read` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | `trace-events.json` |
| GET | `/sessions/:session_id/lines` | ui | `read` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/trace/turns/:trace_id` | ui | `read` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/episodes/:episode_id/evidence` | ui | `read` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/diag/observations/:request_id` | ui | `read` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/conversations` | ui | `read` | main | `control_panel` | `protocol/C6-agentd-api/CONTRACT.md` | `conversations.json` |
| GET | `/conversations/:conversation_id/turns` | ui | `read` | main | `control_panel` | — | `conversations-turns.json` |
| GET | `/character/runtime` | ui | `read` | main、stack、onboarding | `character_agent.routes.http` | `protocol/C6-agentd-api/CONTRACT.md` | `character-runtime.json` |
| GET | `/character/capabilities` | ui | `read` | main | `character_agent.routes.http` | `protocol/C6-agentd-api/CONTRACT.md` | `character-capabilities.json` |
| GET | `/character/acp/agents` | ui | `read` | main | `character_agent.routes.http` | — | — |
| GET | `/agent/scopes` | ui | `read` | main、stack | `character_agent.routes.http` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/agent/runs` | ui | `read` | main | `character_agent.routes.http` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/agent/runs/:run_id/items` | ui | `read` | main | `character_agent.routes.http` | — | — |
| GET | `/agent/runs/:run_id/files` | ui | `read` | main | `character_agent.routes.http` | — | — |
| GET | `/memory/runs` | ui | `read` | main | `character_agent.routes.http` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/memory/runs/:run_id` | ui | `read` | main | `character_agent.routes.http` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/agent/goals` | ui | `read` | main | `character_agent.routes.http` | `protocol/C6-agentd-api/CONTRACT.md` | `agent-goals.json` |
| GET | `/agent/goals/:goal_id` | ui | `read` | main | `character_agent.routes.http` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/agent/jobs` | ui | `read` | main | `character_agent.routes.http` | `protocol/C6-agentd-api/CONTRACT.md` | `agent-jobs.json` |
| GET | `/agent/tasks` | ui | `read` | main | `character_agent.routes.http` | — | `agent-tasks.json` |
| GET | `/agent/tasks/:task_id`、`/agent/tasks/:task_id/steps` | ui | `read` | main | `character_agent.routes.http` | — | — |
| GET | `/agent/tasks/:task_id/files` | ui | `read` | main | `character_agent.routes.http` | — | — |
| GET | `/agent/deliveries` | ui | `read` | main | `character_agent.routes.http` | — | — |
| GET | `/agent/deliveries/:delivery_id` | ui | `read` | main | `character_agent.routes.http` | — | — |
| POST | `/agent/tasks/:task_id/accept`、`/agent/tasks/:task_id/reject` | ui | `write` | main、stack | `character_agent.routes.http` | — | — |
| POST | `/agent/deliveries/:delivery_id/presented`、`/agent/deliveries/:delivery_id/viewed` | ui | `write` | main | `character_agent.routes.http` | — | — |
| GET | `/task-understanding` | ui | `read` | main | `character_agent.routes.task_understanding_http` | — | `task-understanding.json` |
| GET | `/observation/state` | ui | `read` | main | `character_agent.routes.observation_http` | `protocol/C6-agentd-api/CONTRACT.md` | `observation-state.json` |
| GET | `/observation/sources` | ui | `read` | main | `character_agent.routes.observation_http` | `protocol/C6-agentd-api/CONTRACT.md` | `observation-sources.json` |
| GET | `/observation/sources/:source_id`、`/observation/sources/:source_id/changes`、`/observation/sources/:source_id/image` | ui | `read` | main | `character_agent.routes.observation_http` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/observation/analyze` | ui | `write` | main | `character_agent.routes.observation_http` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/observation/refresh` | ui | `write` | main | `character_agent.routes.observation_http` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/observation/briefs` | ui | `read` | main | `character_agent.routes.observation_briefs_http` | `protocol/C6-agentd-api/CONTRACT.md` | `observation-briefs.json` |
| GET | `/observation/briefs/settings` | ui | `read` | main | `character_agent.routes.observation_briefs_http` | `protocol/C6-agentd-api/CONTRACT.md` | `observation-briefs-settings.json` |
| GET | `/observation/briefs/:brief_id` | ui | `read` | main | `character_agent.routes.observation_briefs_http` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/observation/briefs` | ui | `write` | main | `character_agent.routes.observation_briefs_http` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/observation/briefs/settings` | ui | `write` | main | `character_agent.routes.observation_briefs_http` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| DELETE | `/observation/briefs/:brief_id` | ui | `write` | main | `character_agent.routes.observation_briefs_http` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/task-understanding/:item_id/correct` | ui | `write` | main | `character_agent.routes.task_understanding_http` | — | — |
| GET | `/agent/jobs/:job_id` | ui | `read` | main | `character_agent.routes.http` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/agent/interactions` | ui | `read` | main | `character_agent.routes.http` | `protocol/C6-agentd-api/CONTRACT.md` | `agent-interactions.json` |
| POST | `/hook/claude` | hook | `hook_only` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/hook/codex` | hook | `hook_only` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/context/browser` | hook | `hook_only` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/integration/notify` | integration | `integration_only` | — | `api.integration` | `protocol/C6-agentd-api/INTEGRATION.md` | — |
| POST | `/integration/reminders` | integration | `integration_only` | — | `api.integration` | `protocol/C6-agentd-api/INTEGRATION.md` | — |
| GET | `/integration/reminders/:request_id` | integration | `integration_only` | — | `api.integration` | `protocol/C6-agentd-api/INTEGRATION.md` | — |
| GET | `/integration/memory` | integration | `integration_only` | — | `api.integration` | `protocol/C6-agentd-api/INTEGRATION.md` | — |
| POST | `/integration/memory` | integration | `integration_only` | — | `api.integration` | `protocol/C6-agentd-api/INTEGRATION.md` | — |
| GET | `/integration/timeline` | integration | `integration_only` | — | `api.integration` | `protocol/C6-agentd-api/INTEGRATION.md` | — |
| POST | `/integrations/hooks/disconnect` | ui | `write` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/context/privacy/sync` | ui | `native_only` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/chat/prewarm` | ui | `write` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | `chat-prewarm.json` |
| POST | `/say` | ui | `write` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/speech/cancel` | ui | `host_only` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/speech/playback` | ui | `host_only` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/voice/reset` | ui | `write` | main、onboarding | `api.handler` | — | — |
| POST | `/voice/test` | ui | `write` | main、onboarding | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/voice/token` | ui | `write` | main、onboarding | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/turn/cancel` | ui | `write` | main、stack | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/character` | ui | `host_only` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/user/coarse` | ui | `host_only` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/context/attention` | ui | `host_only` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/context/events` | ui | `host_only` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/context/timeline` | ui | `host_only` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| GET | `/context/timeline/summaries` | ui | `read` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| DELETE | `/context/timeline/summaries/:segment` | ui | `write` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/sessions` | ui | `write` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/context/text` | ui | `host_only` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/context/image` | ui | `host_only` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/look` | ui | `host_only` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/trace/events` | ui | `host_only` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/memory/facts` | ui | `write` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/feedback` | ui | `write` | main、stack | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/blacklist` | ui | `write` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/blacklist/defaults` | ui | `write` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/blacklist/mode` | ui | `write` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/reset` | ui | `confirm_native` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/behavior/receipts` | ui | `host_only` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/behavior/motion_state` | ui | `host_only` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/motions/generate` | ui | `host_only` | — | `motion.routes` | `protocol/C1-agent-events/CONTRACT.md` | — |
| POST | `/focus` | ui | `write` | main、stack | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/interaction/tap` | ui | `host_only` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/interaction/gift` | ui | `host_only` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/interaction/record` | ui | `host_only` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/model/settings` | ui | `write` | main、onboarding | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/model/catalog` | ui | `write` | main、onboarding | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/model/test` | ui | `write` | main、onboarding | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/model/chatgpt/start` | ui | `write` | main、onboarding | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/model/chatgpt/cancel` | ui | `write` | main、onboarding | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/model/chatgpt/select` | ui | `write` | main、onboarding | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/model/chatgpt/logout` | ui | `write` | main、onboarding | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/character/prepare` | ui | `host_only` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/character/commit` | ui | `host_only` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/character/abort` | ui | `host_only` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/approvals/:request_id/decision` | ui | `write` | main、stack | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/sessions/:session_id/messages`、`/sessions/:session_id/interrupt` | ui | `write` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/memory/facts/:fact_id/confirm` | ui | `write` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/memory/facts/:fact_id/reject` | ui | `write` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/tasks/:task_id/accept`、`/tasks/:task_id/reject` | ui | `write` | main、stack | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/commitments/:commitment_id/cancel`、`/commitments/:commitment_id/snooze`、`/commitments/:commitment_id/complete` | ui | `write` | main、stack | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/commitments/:commitment_id/seen` | ui | `write` | main、stack | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/conversations` | ui | `write` | main | `control_panel` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/conversations/:conversation_id/activate`、`/conversations/:conversation_id/messages`、`/conversations/:conversation_id/cancel` | ui | `write` | main | `control_panel` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/agent/scopes` | ui | `write` | main、stack | `character_agent.routes.http` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/agent/scopes/:scope_id/revoke` | ui | `write` | main、stack | `character_agent.routes.http` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/agent/artifacts/revert` | ui | `write` | main | `character_agent.routes.http` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/tasks/:task_id/continue`、`/tasks/:task_id/cancel` | ui | `write` | main | `character_agent.routes.http` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/agent/runs/:run_id/cancel` | ui | `write` | main、stack | `character_agent.routes.http` | `protocol/ui-bridge/CONTRACT.md` | — |
| POST | `/character/acp/install` | ui | `write` | main | `character_agent.routes.http` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/agent/interactions/:interaction_id/answer`、`/agent/interactions/:interaction_id/dismiss`、`/agent/interactions/:interaction_id/continue` | ui | `write` | main、stack | `character_agent.routes.http` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/agent/goals` | ui | `write` | main | `character_agent.routes.http` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/agent/goals/:goal_id` | ui | `write` | main | `character_agent.routes.http` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/agent/jobs` | ui | `write` | main、stack | `character_agent.routes.http` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| POST | `/agent/jobs/:job_id/cancel`、`/agent/jobs/:job_id/resume` | ui | `write` | main、stack | `character_agent.routes.http` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| PUT | `/observation/paused` | ui | `write` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| PUT | `/observation/meeting` | ui | `write` | main、stack | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| PUT | `/observation/quiet` | ui | `write` | main、stack | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| PUT | `/proactive/mutes` | ui | `write` | main、stack | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| PUT | `/proactive/settings` | ui | `write` | main、onboarding | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| PUT | `/motion/settings` | ui | `write` | main | `motion.routes` | `protocol/C1-agent-events/CONTRACT.md` | — |
| PUT | `/characters/:character_id/binding` | ui | `write` | main | `character.binding_routes` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| PUT | `/context/activity` | ui | `write` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| PUT | `/behavior/capabilities` | ui | `host_only` | — | `api.handler` | — | — |
| PUT | `/behavior/motion_prefs` | ui | `host_only` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| PUT | `/behavior/switches` | ui | `native_only` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| PUT | `/avatar/visibility` | ui | `host_only` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| PUT | `/character/state/switch` | ui | `native_only` | — | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| PUT | `/memory/paused` | ui | `write` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| PUT | `/conversations/:conversation_id` | ui | `write` | main | `control_panel` | — | — |
| PUT | `/sessions/:session_id` | ui | `write` | main | `control_panel` | — | — |
| PUT | `/character/runtime` | ui | `write` | main、onboarding | `character_agent.routes.http` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| PATCH | `/episodes/:episode_id` | ui | `write` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| PATCH | `/memory/facts/:fact_id` | ui | `write` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| DELETE | `/attention` | ui | `write` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| DELETE | `/focus` | ui | `write` | main、stack | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| DELETE | `/history` | ui | `write` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| DELETE | `/memory` | ui | `write` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| DELETE | `/observation` | ui | `write` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| DELETE | `/blacklist` | ui | `write` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| DELETE | `/character/state` | ui | `write` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| DELETE | `/memory/facts/:fact_id` | ui | `write` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| DELETE | `/context/items/:type` | ui | `write` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| DELETE | `/episodes/:episode_id` | ui | `write` | main | `api.handler` | `protocol/C6-agentd-api/CONTRACT.md` | — |
| DELETE | `/conversations/:conversation_id` | ui | `write` | main | `control_panel` | — | — |
| DELETE | `/sessions/:session_id` | ui | `write` | main | `control_panel` | — | — |
<!-- gen:routes end -->

## 4. 端点细则

§3 表里「规格」列为本文件的端点，字段和错误码写在 §2 或本节。本节的「她」指当前角色，「嘴」指写角色台词的那条模型调用，「现场情况」指每轮交给它的现场材料。

### 4.1 通用规则

通用规则：任一请求（GET/POST/PUT/PATCH/DELETE）处理时抛出未捕获的异常、而状态行还没发出时，回 500 `{"error": "internal_error", "route": "<方法> <路径，不含 query>"}`，完整 traceback 照旧写进 stderr 日志；已经开始写响应的（`/events`、`/speech` 等流式接口）照旧断开连接。

令牌不对返回 401。

### 4.2 端点

| 端点 | 令牌 | 说明 |
|---|---|---|
| `GET /health` | 无 | 存活 |
| `POST /hook/claude`、`POST /hook/codex` | hook | 立即 200 `{}`；只有 Claude 的 PermissionRequest 阻塞到有决定或截止时间（带 `X-Agentd-Observe: 1` 的除外，见下文）。`/hook/codex` 的 `session_id` 是自有 Codex 会话的 thread id 时什么都不改，回 `{}` |
| `GET /state` | ui 或 events | `{epoch, focus, sessions[], outcomes[], character, character_generation, switching, turn_generation, observation, avatar}`；`observation` 是 `{paused_until, meeting, quiet_until}`（给菜单栏图标）：观察暂停到何时（ISO 8601，没暂停为 null），手动开会模式是否开着、安静到何时（ISO 8601，没安静为 null）；`character` 是当前角色 id；`character_generation` 是 换角色的代数（启动时 0，每次 `POST /character/commit` 成功 +1，`POST /character` 不加）；`switching` 是开着的 换角色事务 `{switch_id, to, expires_at}`（`expires_at` 为租约到期时刻，ISO 8601），没有时为 null；`turn_generation` 是当前轮次编号（见 `POST /turn/cancel`）；`avatar` 是 `{visible, reason, since}`（见 `PUT /avatar/visibility`）。`sessions[]` 每项带 `observed_at`（最后收到这个会话 hook 的时间）；`state` 为 `stale` 表示 agentd 失联：在跑工具、思考、压缩、等审批时超过 TTL 没有新 hook，面板显示「失联，最后收到于 observed_at」，intent 按 idle |
| `GET /desktop/presence` | ui | 桌面层读的小快照（`observation.desktop_presence.snapshot`），不含对话原文、工具参数和模型推理；重置或退出中 503 `presence_unavailable`。200 `{sampled_at, character_id, role, sessions, additional_sessions, pending, ritual, agent}`：`pending` 的 `questions`、`approvals`、`tasks`、`results`、`reminders` 各是最新的至多 3 行，另带 `<kind>_more` 为余下的行数，`observed_waiting` 为只被 hook 观察、正在自己的 app（Claude Code、Codex）里等权限确认的外部会话数（这些会话不进 `sessions`）；`ritual` 是现在点她会说的仪式 `{kind, since}`（`kind` 同 `/feed` `pending` 的 `kinds[0]`，`since` 为这组待说仪式上次变化的时刻，Unix 秒），没有时为 null；`agent` 是一个 agent 状态 `{state, since, count}`（`sessions/agent_state.py`）：`state` 按优先级为 `waiting_you`（有待决审批或提问、或会话在等输入）、`failed`（120 s 内出错）、`working`（会话忙或她自己的任务在跑）、`done`（60 s 内做完）、`idle`，`since` 为最早一个原因的时刻（Unix 秒，idle 为 null），`count` 为原因个数；读它时先按 `/feed` `pending` 的规则核一次，变了就先发那条 `pending` |
| `POST /desktop/sessions/seen` | ui | 你点开一张「做完了」或「出错」的会话卡：body `{session_id, updated_at?}`；`updated_at` 给了就必须等于那次完成或出错的时刻，旧的点击不会藏掉更新的结果。200 `{seen: bool}`；之后 `/desktop/presence` 不再列这次结果（没点开的最多留 30 分钟）。重置或退出中 503 `presence_unavailable`。 |
| `GET /approvals` | ui | 待决请求（FIFO），含 `request_id`、`generation`、`display_session`、`tool_name`、`tool_summary`、`kind`、`dispatch`、`cwd`、`dangerous`、`danger_rule`、`options`、`session_scope`、`seconds_left`、`created_at`（卡片创建时刻，epoch 秒（float））。`cwd` 是工具运行的目录：Claude 卡取自 hook 的 `cwd`，自有会话的卡取自那个会话的 `cwd`；派活卡为 null，目录在 `dispatch.cwd`。`options` 是卡上能点的决定：agent 自己的协议提供「本会话都允许」且卡不危险时为 `["allow", "allow_session", "deny"]`，否则 `["allow", "deny"]`；`session_scope` 在提供时为 `{kind, detail}`，否则 null：`kind` 为 `rule`（Claude 的规则，`detail` 如 `Bash(rm -rf node_modules)`，多条以 `; ` 分隔；只有目录时是这些目录）、`all_edits`（Claude 的 acceptEdits：本会话里工作区所有编辑和 mkdir/touch/rm/rmdir/mv/cp/sed 都不再问，卡上要这样写明；同一张卡里 Claude 还建议了规则或目录时，它们一起授权，`detail` 照 `rule` 的写法列出，卡上也要显示；没有时为 null）、`same_files`（自有 Codex 会话的文件改动：之后对同一批文件的改动不再问，`detail` 是这些路径，换行分隔；拿不到变更集时不提供）；自有 Codex 会话的命令卡不提供。`dangerous` 由 agentd 按工具和命令或路径判定（`sessions/danger.py`：`rm` 递归加强制、`sudo`、`git push --force`、`git reset --hard` 等、下载后管道给 shell、递归改权限、写磁盘、`find -delete`；写系统目录、`.ssh`、shell 启动文件、`.git/hooks`），`danger_rule` 是命中的规则名；自有 Codex 会话的文件改动按每个变更的路径（含改名目标）逐个判，任一危险整张卡就危险；引号里的文字不算命令；派活卡恒为 false。界面只按它换样式。`kind` 是 `tool`（Claude 的 PermissionRequest）或 `dispatch`（agentd 自己要派的任务，`dispatch` 为 `{target, cwd, prompt, source, utterance, modes, mode, cwd_from}`，确认卡要完整显示 `target`、`cwd`、`prompt`；`cwd_from` 是目录的来源：`/say` 显式给了 `cwd` 时为 `{"source": "explicit"}`，取自焦点会话时为 `{"source": "focus", "display_session", "state"}`（那个焦点会话和它当时的状态），卡上要写明；`source` 是 `voice` 时 `utterance` 是识别原文，卡上也要显示，`text` 时为 null；`modes` 是可选的权限模式 `["read_only", "workspace_write"]`，`mode` 是默认的 `read_only`） |
| `POST /approvals/<request_id>/decision` | ui | body `{"decision": "allow"\|"allow_session"\|"deny", "generation": N, "mode": "read_only"\|"workspace_write", "message": "..."}`（`mode` 只给派活卡、可省，省略为 `read_only`，见 `POST /sessions`；`message` 可省，拒绝时把用户的理由交给工具，最多 500 字；其他键 400 `invalid_payload` `{"field": "<键>"}`）；200 接受，409 已决/过期/代际不符，404 未知；400：`invalid_decision`（不认识的决定）、`scope_unavailable`（这张卡没提供 `allow_session`）、`invalid_mode`（工具卡带了 `mode`）、`unsupported_mode`（`mode` 不在 `modes` 里）；400 时卡仍待决 |
| `GET /events` | ui 或 events | SSE，`event: intent`，`id` 为 seq；支持 `Last-Event-ID` / `?after=`。新连上（不带游标）时先发一条 `event: snapshot`：当前 intent，另带 `turn_generation`（当前轮次编号）和 `behaviors`（正在跑的全部 C1 v2 行为对象的数组，先发的在前，没有时为 `[]`；通道不重叠的行为可以并行）。`event: behavior` 和 `event: behavior_cancel`（C1 v2 §1、§2，和 intent 共用 seq）见 §4.8；`behavior_cancel` 的 `reason` 为 `replaced`、`switch_off`、`fullscreen`、`turn_cancelled`、`expired`、`exit`（agentd 判断的结束条件成立，另带 `condition`，见 §4.8；别的 `reason` 不带 `condition`）或 `character_switch`（`POST /character/prepare` 结束在跑的全部行为）。`event: speech_cancelled`（C2 v2-3 规则 8，和 intent 共用 seq）的 data 为 `{seq, session_epoch, turn_generation, speech_id, utterance_id, reason}`，`turn_generation` 是打断后的新值，`speech_id` 是被截断的那条（正在播或正在合成的分句），没有时为 null，`utterance_id` 是被截断分句所属的台词，没有时为 null，`reason` 是 C2 `cancelled` 的 reason；`POST /turn/cancel`（含 `barge_in`、事实被删、上下文被清掉或更正）、「停下」、`POST /character` 每次都发，静音、隐藏角色（`PUT /avatar/visibility`）和 `POST /speech/cancel` 只在真截断了语音时发；新台词顶掉 `immediate` 的旧台词时发（`reason: superseded`，真截断了语音时），顶掉 `clause_end` 的不发。`event: clause_intent`（C1 v2 §4，和 intent 共用 seq）的 data 为 `{seq, line_id, utterance_id, clause_id, spoken_text_revision, intent, turn_generation, trace_id}`：「嘴」台词里的 `[intent:x]` 归到标记后面那个字所在的 C2 v2 分句（台词最后的标记归最后一个分句），`utterance_id`、`clause_id`、`spoken_text_revision` 取自这个分句，`turn_generation` 是这句台词的，`trace_id` 是这轮的；每个分句最多一条，分句里有几个标记只发第一个；这个分句排进合成队列后立刻发（两条流不保证先后，见 C1 v2 §4「时机」）。只出字不出声（没开 `--tts-url`、静音、这句没送合成）时整句只发一条，取第一个标记，三个 id 字段为 null，在显示的字里解析出这个标记时发（紧跟这句的 `text_line` started）；台词被取消或过期后不再发。`event: text_line`（C1 v2.3 §4.1，和 intent 共用 seq）的 data 为 `{seq, line_id, turn_generation, trace_id, state, hold_ms}`，只给只出字的台词发，出声的台词不发：第一个可见的字显示时发 `state: started`，台词结束（完成、取消、出错）时发 `state: ended`；`hold_ms` 只在 `ended` 上，是宿主在文字结束后再保持说话状态的毫秒数，完成时为 `min(3000, 60 × 显示的字数)`，取消或出错时为 0；台词被取消或过期后只补发已 started 那句的 `ended`。`/feed` 的 `line.intents` 不变 |
| `PUT /avatar/visibility` | ui | Companion 告诉 agentd 角色是否显示，agentd 启动后和每次变化时各 PUT 一次。body `{visible, reason}`：`visible` 布尔；`reason` 为 ≤64 字节的字符串或 null（Companion 自己的标签，例如 `user`、`fullscreen`，agentd 只存不用）；body 不对 400 `invalid_payload`。200 `{visible, reason, since}`，`since` 是 `visible` 最后一次变化的时刻（ISO 8601；`visible` 不变的 PUT 不改它）。只在内存里，agentd 启动时为显示；另外每次 PUT 记进每日简报的显示时长（`desk_log`，`visible` 为 true 开始一段、false 结束，重启前没结束的一段止于它最后一次确认的时刻，误差不超过 60 s）。隐藏时：用户开始的台词（`POST /say`，任何 `source`）照常出声；主动台词和播报只出字（Companion 显示在字幕条）：主动台词不送 `/speech`，`line` 的 `speak` 为 false，照常说完、存进聊天记录、按只出字的规则发 `clause_intent`，闸门照静音时一样计数；播报照常发 `announce` 卡，不出声也不进槽，槽里已有的不播（照常 15 s 过期，重新显示时还没过期的照常播）。变成隐藏时，正在播的主动台词或播报的语音立刻停（`client_cancel`，按 `immediate`，真截断时在 `GET /events` 发 `speech_cancelled`），还在生成的主动台词接着只出字；用户的台词不动。变成显示时不动正在进行的。`/diag/state` 的 `mouth_voice.avatar_visible` 同 `visible`。`POST /reset` 时 503 `resetting` |
| `PUT /behavior/switches` | ui | 行为开关（C1 v2 §1.3）：body 每次是完整对象 `{stay_in_place, sit_window_top, hold_window_edge, fullscreen_give_way}`，都是布尔，可选再带 `bust_framing`；缺键、多键、非布尔或 body 读不出 400 `invalid_switches`；200 回存下的值。只存在内存里，重启回到默认（`stay_in_place` false，其余 true）。关掉的开关禁止正在跑的行为时发 `behavior_cancel`（`reason: switch_off`） |
| `POST /behavior/receipts` | ui | 角色进程的执行回执（C1 v2 §3），由 Companion 原样转来：body `{behavior_id, phase, reason, at_ms, turn_generation}`，按 `c1.py` 的回执规则校验，不合法 400 `invalid_receipt`。200 `{applied, why}`：`why` 为 null、`unknown_behavior`（不是最近 64 个行为之一）、`after_terminal`（这个行为已收到过终态回执）或 `stale`（回执的 `turn_generation` 不是这个行为发出时的值；行为跨轮次继续有效，回执带的是它自己的代际）。只有 `completed` 记为做完（「走到了」「已松手」只在这时算数）；`cancelled` / `connection_lost` 记为失联，既不算做完也不算被打断；终态回执后这个行为不再算在跑；`blocked` 时这个目标 60 s 内不再选，并立刻换目标或换类型重发（`trigger.source: receipt`） |
| `POST /behavior/motion_state` | ui | 渲染器片段边界的播放状态（C3 规则 54），由 Companion 去掉 `v`、`type` 后原样转来，和回执同一个队列、按收到的顺序：body 正好是 `{behavior_id, origin, phase, resting, busy, clip}`；`origin` 为 `agent` / `local` / `user`（用户自己的播放和姿态场景，C3 规则 54）；`behavior_id` 为 1–64 字节的字符串，`origin`=`local` 时可以为 null，`origin`=`user` 时必须为 null；`phase` 为 `started` / `cycle_end` / `ended` / `expired` / `rejected`，`user` 没有 `cycle_end`；`resting`、`busy` 为布尔；`clip` 为 1–64 字节的字符串。不合 400 `invalid_motion_state`。合的回 204、无 body：动作选择器自己挑的片段（`perform` 的 `chosen`）在 `cycle_end`、`ended` 时把它的播放头对到渲染器的位置，`user` 的 `started` 起到它结束或断线，动作选择器不发基础层片段；别的只收下 |
| `PUT /behavior/motion_prefs` | ui | 当前角色的动作开关和动作覆盖，取自 Companion 的 config.json（`action_switches`、`motion_overrides` 去掉 `notes`）。Companion 每次给渲染器发 `set_action_switches`、`set_motion_overrides` 时、渲染器报来角色的 `actions`（不带 `error`）时、agentd 每次启动后各 PUT 一次。body 正好是 `{character_id, action_switches, motion_overrides}`：`character_id` 为 1–64 字节的字符串；`action_switches` 同 C3 `set_action_switches` 的 `switches`（id → 布尔，最多 128 项）；`motion_overrides` 正好是 `{chains, pools, blend_in}`，取值和上限同 C3 规则 51 (j)。不合 400 `invalid_motion_prefs`；`character_id` 不是当前角色 409 `character_changed`；当前角色没有动作选择器 409 `no_motion`。200 `{character_id, action_switches: {switches, adjusted}, motion_overrides: {applied, adjusted}}`：两块的含义和 C3 渲染器的 `action_switches`、`motion_overrides` 回复相同（规则 28、51 (d)–(g)），`switches` 是应用之后的整张表，不截断。动作选择器照渲染器的规则应用：关掉的动作行和关掉的链的起头片段不再挑，覆盖的池子整池替换，`blend_in` 作为 `perform` 的 `blend_s`，`PUT /behavior/switches` 的 `bust_framing` 开着时只挑起止都是站姿的片段（必需动作行的片段除外）；正在播、被关掉的循环在下一个安全退出点换成选择器的下一个挑选。改动让 snapshot 的 `reactions` 变了时发一条带新 `reactions` 的 snapshot（C1 §0）。只存在内存里，换角色后清空，直到 Companion PUT 新角色的。请求样例 `fixtures/behavior-motion-prefs.json` |
| `POST /interaction/record` | ui | 她的一次触碰或迎接，记进每日简报（`GET /brief/day`），由 Companion 在收到时转来（C3 规则 55）：body 正好是 `{kind}`，`kind` 为 `pat`（摸头每划一下）、`pinch`（捏脸每抓一次）、`greet`（每播一次迎接）、`drag`（渲染器的每次 `drag` `begin`）或 `wheel`（她身上的每次右键）；时刻是 agentd 收到的时刻。不合 400 `invalid_payload`；没有记录库 503 `no_desk_log`。合的回 204、无 body。记录存在 agentd.sqlite 的 `desk_log`，按聊天记录保留设置（`history_retention`）删旧的，`POST /reset` 清空 |
| `GET /feed` | ui | SSE，给外壳：`event: announce`（harness 和自有会话的播报，data 带 `state`：`terminal`\|`progress`，见下文 announce 的 data），`line`（台词）、`command`、`request`（见下文 `event: request`）、`nudge`（见下文）、`thought`（她的想法，见下表）、`memory`（「记住…」写下一条事实时 `{action: "added", fact_id, text, kind, source}`，Companion 显示「记下了… 撤销」，撤销即 `DELETE /memory/facts/<fact_id>`）、`turn_accepted`（接受一句输入，见下表）、`presence`（`GET /desktop/presence` 除 `sampled_at` 外的内容变了；data 只有 `seq`，内容要再读那个路由）；`id` 为 `<stream_epoch>-<seq>`：`stream_epoch` 是本进程 feed 缓冲的随机名，seq 是 feed 自己的，和 `/events` 无关；缓冲留最近 256 项。每次连上先发一项 `event: stream`（无 `id`），data `{stream_epoch, oldest_seq, latest_seq}`（`oldest_seq` 是还留着的最早一项，空时为 `latest_seq + 1`）。游标用 `Last-Event-ID` / `?after=`（只给整数时按本进程的 seq）：在范围内就补发它之后的项；属于别的进程（`stream_epoch` 不同，或序号比 `latest_seq` 还新）时发 `event: reset` `{reason: "other_process", stream_epoch, oldest_seq, latest_seq}`，不补发，只发之后的新项；早于 `oldest_seq - 1`（断线期间被挤掉）时发 `event: gap` `{reason: "cursor_expired", from, to, stream_epoch, oldest_seq, latest_seq}`（`from`..`to` 是丢掉的 seq），再补发还留着的全部项；格式不对 400 `invalid_cursor`。不带游标不重放历史。收到 `reset` 或 `gap` 时消费端重新取快照（`GET /agent/snapshot`，以及 `GET /state` 等），agentd 不另做什么 |
| `GET /agent/jobs` | ui | 后台工作列表，见下文角色内核端点的 `GET/POST /agent/jobs` |
| `POST /agent/interactions/<id>/answer` | ui | 提问时本轮结束，run/job 转 `waiting_user`，释放执行槽，等待时间不计截止；回答后同一 job 重新入队、前台从检查点续接，答案作为原 `ask_user` 工具调用的结构化结果送回，问题原文不进用户消息。当前对话恰好一张待答问题卡时，聊天消息就是它的回答。角色工具审批另支持按 `data.approval_answers` 发送 `allow_session`，仅同对话、同 server/tool、同 MCP catalog 生效；危险调用只准单次。契约与 schema 见上文「C6 角色工具审批」。 |
| `GET /agent/snapshot` | ui | 一次取齐卡片状态：200 `{stream_epoch, seq, conversations, interactions, jobs, tasks, commitments, approvals}`。`stream_epoch`、`seq` 是 `/feed` 水位，先于各部分读出：之后的变化都会出现在 `/feed?after=<stream_epoch>-<seq>` 里。各部分与对应路由的 body 相同：`GET /conversations`、`GET /agent/interactions`（未结束的：`pending`、`answered`、`resuming`）、`GET /agent/jobs`、`GET /tasks`、`GET /commitments?state=armed&state=triggered`、`GET /approvals`；某部分的服务不可用时为 null。收到 `gap` 或 `reset` 后重取快照，再从它的水位续流。 |
| `GET /speech` | ui 或 events | C2 语音流（`protocol/C2-speech-stream/CONTRACT.md`），`application/x-ndjson`，给 角色进程。每行转发的 C2 行顶层多一个 `stream_seq`（中继缓冲的序号，留最近 512 行），C2 字段不变。每次连上先发一行 `{"event": "stream.hello", stream_epoch, oldest_seq, latest_seq}`（不属于任何语音，角色进程解析语音时跳过 `event` 以 `stream.` 开头的行）。不带游标只发连上之后的行；`?after=<stream_epoch>-<stream_seq>` 补发它之后还留着的行；游标属于别的进程（判定同 `/feed`）时先发 `{"event": "stream.reset", "reason": "other_process", …同上三项}`，只发之后的新行；早于 `oldest_seq - 1` 时先发 `{"event": "stream.gap", "reason": "cursor_expired", from, to, …同上三项}`，再补发还留着的全部行；格式不对 400 `invalid_cursor`。收到 `stream.reset` 或 `stream.gap` 时消费端重新取快照。每 10 s 无数据时发一个空行当心跳，读端跳过空行。没开 `--tts-url` 时 503 |
| `POST /speech/cancel` | ui | body `{"speech_id": "...", "reason": "client_cancel"}`（`reason` 可省，取值 `client_cancel`、`superseded`、`error`）。按 `speech_id` 结束一条语音，不走命令解析；202 已取消，404 未知 `speech_id`，409 已经结束，没开 `--tts-url` 时 503。结束后 `/speech` 上照常补一行 `cancelled`。一律立刻停（`immediate`），不管台词的 `interrupt_policy`；`speech_id` 是某句台词的一个分句时整句台词都停。真截断了语音时在 `GET /events` 发 `speech_cancelled`。不带 `speech_id` 时（如 `{"reason": "barge_in"}`）结束正在播的那条；`reason` 为 `barge_in` 时按 `POST /turn/cancel` 结束整轮（还停掉还在等待或生成的 `line`，它以 `cancelled: true` 结束；还撤回这句在等的「看一下」请求）。有语音、`line` 或「看一下」请求被停都回 202 `{"ok": true}`；都没有才回 404 `{"error": "no_speech"}`。合成已完成（`/speech` 已发 `complete`）但按「首个 `audio` 转发时刻 + `total_samples`/48000 s」估算 角色进程还在播时也回 202：流已结束，不再补 `cancelled` 行，角色进程侧停止由 host 经 C3 发；这句记为被打断，下一句「嘴」的现场情况里会写「上一句话没说完就被<称呼>打断了」（称呼来自角色卡 `user_title`）。同一句再取消回 404。`reason` 还可取 `barge_in`，在 `/speech` 的 `cancelled` 行里记为 `client_cancel`。给外壳：角色进程本地停播后经 C3 告诉外壳，再由它调这里 |
| `POST /speech/playback` | ui | 播放回执，由外壳转来 角色进程的 C3 playback 消息：body `{speech_id, clause_id, state, sample, rate, reason}`（`speech_id` 非空 ≤64 字节；`clause_id` 字符串或 null；`state` 为 `started`\|`buffering`\|`resumed`\|`ended`\|`interrupted`\|`failed`\|`degraded`；`sample` 整数 ≥0，到此刻已播出的采样数；`rate` 整数 >0；`interrupted`、`failed`、`degraded` 必带 `reason`，非空 ≤64 字节；可多带 `utterance_id`、`spoken_text_revision`，不校验），不合法 400 `invalid_payload`，没开 `--tts-url` 时 503 `no_speech`。回 200 `{applied, why}`，`why` 为 null、`superseded`（语音的 `turn_generation` 不是当前的，旧语音回执不改变新轮）、`unknown_speech` 或 `already_ended`（已 `ended`、`interrupted`、`failed` 或失联）。收到过回执的语音以回执算说话状态：`started`、`buffering`、`resumed`、`degraded` 时在说（`buffering` 时过了估算的结束时刻也算），`ended`、`interrupted`、`failed` 时不在说；最近一次回执后超过「剩余音频时长 + 10 s」没有新回执就记为失联（`unknown`），不再算在说；没收到回执的语音仍按估算。`reason` 为 `connection_lost` 的 `interrupted`（Companion 断线）记为失联，不算打断；其他 `interrupted`（合成结束后也算）把这句记为被打断：台词（不是 `announce-` 播报）在聊天记录和「嘴」的窗口里只留用户听到的部分：它前面播完的分句，加上这个分句按 `sample` 占其采样数的比例从开头截的字，后面的分句不算。`clause_end` 的台词被新台词顶掉、后面的分句不再播时，也当场这样截。回执写进 trace 由 Companion 经 `POST /trace/events` 做，这里不写。`/diag/state` 的 `mouth_voice.voice` 有回执时为 `playing`、`buffering` 或 `unknown` |
| `POST /turn/cancel` | ui | 整轮打断（按住说话那一刻调）。body `{"reason": "barge_in"\|"client_cancel", "generation": N, "line_id": "..."}`（`generation`、`line_id` 可省）；字段不对 400 `invalid_payload`。`line_id`（1–64 字节字符串，`/feed` `line` 的 `line_id`）给了但不是正在出（含旁路）或正在播的那句时什么都不做，409 `{"error": "stale_line"}`。`generation` 给了但不是当前 `turn_generation` 时什么都不做，409 `{"error": "stale_generation", "generation": 当前值}`。否则 `turn_generation` +1，当前 `line` 以 `cancelled: true` 结束（不再调或继续「嘴」，不送 TTS），当前语音按 `client_cancel` 立刻结束（`immediate`，主动台词也一样；规则同 `POST /speech/cancel`），并在 `GET /events` 发 `speech_cancelled`（没截断语音时 `speech_id` 为 null），这轮在等的「看一下」请求结束为 `cancelled`（`reason: "turn_cancelled"`，之后交图 404）；202 `{"generation": 新值, "cancelled": {"line", "speech", "observation"}}`，三个布尔表示各自是否真的打断了东西（都为 false 时 generation 照样 +1）。旧 generation 的结果一律丢弃：`line` 在等图后、调「嘴」前、每个 delta、送 TTS 前比对；`/speech` 转发每行前比对，不符就按 `superseded` 截断并补一行 `cancelled`（播报带发出时的 generation；`clause_end` 的台词被新台词顶掉时，截在正在播的那个分句之后，后面已合成的标 cancelled、正在合成的按 `superseded` 截断；没有分句在播时，正在合成的那个分句不比对，照常发到结束）。新的「嘴」台词、主动台词、「停下」、`POST /character` 也会 +1。没有「嘴」、没开 TTS 时也能调（只 +1） |
| `POST /interaction/tap` | ui | 单击她（只限宿主）。body `{"at": ISO 8601, "count"?: 1–20 的整数}`，`count` 是自上一次发这个请求以来的点击数（含被当作连点、没发请求的），缺省 1；不是整数或越界 400 `{"error": "invalid_payload", "field": "count"}`。可选 `region` 是 C3 规则 45(a) 的部位名（`head_top`、`face`、`cheek_l`…，左右按她自己的；全表见 `daemon/rituals_glue.py` 的 `TAP_REGION_TEXT`），点击回应会告诉「嘴」点的是哪里；未知值忽略（stderr 记一行），不报错。有待说的仪式时说优先级最高的那个，202 `{line_id, kind}`；否则说一句点击回应（`reason.code` `tap`），`count` > 1 时告诉「嘴」用户（按角色卡 `user_title` 称呼）连着点了 N 下，202 `{line_id, kind: "tap"}`；指令被出口拦下 200 `{kind: null}`。切换角色中 409 `switching`；没有「嘴」503 `no_llm`；忙时 409 `{"error": "busy", "while": "speaking" \| "working"}`：`speaking` 是她正在出一句或语音还在播，`working` 是她在跑一轮任务。不计闸门和主动台词额度 |
| `POST /interaction/gift` | ui | body `{}` 或 `{action_id}`（≤64 字节，只进 trace），其他 400 `invalid_payload`。202 `{gift_id}`。礼物作为当前对话的一轮（`source: gift`，用户侧固定为「（送了你一份礼物）」），角色用一句台词回应，按用户发起的台词规则出声；忙时排队，当前这句结束后再回应，不打断；排队期间再送的合并成一条（同一 `gift_id`，文字写份数）。`/feed` 发 `gift` `{gift_id, state: queued \| answered, count, line_id}`。不计闸门和主动台词额度 |
| `POST /feedback` | ui | 气泡上对一句主动台词或一条想法的反馈：「有用」`useful`、「少说点」`less`、关闭 `dismissed`、「关闭此类」`dont_disturb`。body `{"line_id": "...", "value": "useful"\|"less"\|"dismissed"\|"dont_disturb", "mute"?: bool}`（`line_id` 非空 ≤64 字节，台词的 `line_id` 或想法的 `id`）；不对 400 `invalid_payload`（`ignored` 只由 agentd 自己记：台词说完 60 s 没回应、想法被下一条替换或显示超过 600 s 没回应）；`dont_disturb` 带 `mute: true`（气泡上的「别再提这类」）时再把这句的类别（`reason.kind`）加进 `GET /proactive/mutes`；每句、每条只有第一次投票生效；`line_id` 既不是这个进程开过的主动台词（记最近 64 句），也不是主动消息记录里的想法时 404 `unknown_line`。200 `{}`。写一条决策事件 `proactive.feedback` `{line_id, value}`（`GET /trace/decisions`、`/diag/stream` 的 `decision`），供离线对比，结果记进主动消息记录（`GET /proactive/stats` 的 `feedback`）。台词：`useful` 算这句有回应，`dont_disturb`、`dismissed` 算没回应（见 nudge 的 `comment`），`less` 只结束等回应；想法不影响台词的没回应退避。`less` 把台词和想法共用的「少说点」倍数 ×1.5（最多 ×4），`useful` ÷1.5（最少 ×1），倍数存在 `proactive_settings`，重启后保留；它乘在 `comment` 的同类冷却和想法的间隔上；同一触发原因最近 5 条想法里有 ≥3 条 `ignored` 或 `dismissed` 时，这个原因的想法间隔再 ×2 |
| `POST /character` | ui | body `{"id": "<C7 角色代号>"}`。换成这个角色的卡、lore、TTS 的 `character`/`language` 和行为提示里的名字；正在出的台词以 `cancelled: true` 结束，正在播的语音以 `superseded` 结束；会话、审批、注意力、静音、epoch 和闸门保留，「嘴」载入新角色当前话题的历史。200 `{id, changed}`（已经是这个角色时 `changed: false`，什么都不取消）；400 `{"error": "unknown_character"}`（没有这张卡或 body 不对）；409 `{"error": "outbound_blocked"}`（新卡没过出站守卫，保留旧角色）；换角色事务开着时 409 `{"error": "switching"}`，什么都不变。不加 `character_generation`。Companion 只在收到 C3 `character_changed` 后、或 Avatar `hello.character` 和 agentd 启动时的角色不同时调；`character_change_failed` 和 10 s 超时都不调。agentd 不存角色，重启时由 Companion 传 `--character`。Companion 用下面三个端点换角色，这个只留给对齐（`hello.character` 和 agentd 当前角色不同） |
| `POST /character/prepare` | ui | 换角色第 1 步。body `{"id": "<C7 角色代号>"}`。按顺序检查：body 不是 `{id: 字符串}` 或没有这张卡 400 `unknown_character`；已有开着的事务 409 `switching`；就是当前角色 409 `same_character`；新卡没过出站守卫 409 `outbound_blocked`；这些都不改任何东西。都过了才一步做完：开事务（`switch_id` 为 `k2-` 加 12 位十六进制，租约 25 s），`turn_generation` +1，正在出的台词以 `cancelled: true` 结束，正在播的语音以 `superseded` 结束并在 `GET /events` 发 `speech_cancelled`，在跑的全部行为发 `behavior_cancel` / `character_switch`；新角色的「嘴」这时建好，留给 commit。200 `{switch_id, turn_generation}`（新的 generation）。事务开着时：`POST /say`（任何 `source`）和 `POST /character` 回 409 `switching`；主动台词不开始；播报不出声，一律进槽（P0 也是），槽照常 15 s 过期，事务结束后的 tick 再播；空间行为和行为 tick 不轮询；`POST /turn/cancel`、`/sessions*`、审批、hook、上下文端点照常。`POST /reset` 时 503 `resetting`，重置会中止开着的事务 |
| `POST /character/commit` | ui | 换角色第 5 步，Avatar 回 `character_changed` 后调。body `{"switch_id": "..."}`。是开着的事务时换「嘴」（载入新角色当前话题）、角色、TTS 的 `character`/`language` 和行为提示里的名字，`character_generation` +1，关事务；200 `{id, character_generation}`。同一个 `switch_id` 在 commit 后 60 s 内再调回同样的 200，什么都不变。不认识、租约过期或已中止的 `switch_id` 404 `unknown_switch`。换的过程中出错 500 `commit_failed`：什么都没换，事务还开着（租约照走），可以再 commit 或 abort |
| `POST /character/abort` | ui | 换角色回滚。body `{"switch_id": "..."}`。是开着的事务时关掉它，角色、语音、`character_generation` 都不变，恢复输入；200 `{}`。已经 commit（60 s 内）409 `{"error": "committed", "id": <新角色>}`；其他 404 `unknown_switch`。`prepare` 后 20 s 既没 commit 也没 abort 时 agentd 在 tick 里自己按 abort 处理 |
| `GET /characters/:character_id/binding` | ui | 角色绑定：200 `{character_id, revision, voice, motion, persona}`。`voice` 为 `{voice_id, language, source}`，来源 `package` 或 `user`；无包内语音且未覆盖时为 null。`motion` 为 `{driver, source}`，driver 为 `game` 或 `generated`，来源 `global` 或 `user`；默认随当前全局 motion backend。`persona` 为 `{overrides, source}`，默认空 overrides、来源 `package`，覆盖后为 `user`。未知角色 404 `unknown_character`；agentd 启动早期绑定还没建好时 503 `no_bindings`。 |
| `PUT /characters/:character_id/binding` | ui | body `{revision, voice?, motion?, persona?}`：voice `{voice_id, language}`（非空字符串，各至多 64 字符），motion `{driver}`，persona `{overrides}`（只允许 `brain.persona.SECTIONS`、`post_history_instructions`、`familiarity_rules`，类型同包内卡，缺省 familiarity_rules 按字符串；每个值 JSON 序列化后至多 20000 字符，合并卡须通过 persona 渲染）。省略的键不变，null 恢复默认。形状或包装字段不对 400 `invalid_payload`；值不对分别为 `invalid_voice`、`invalid_motion_driver`、`invalid_persona_override`；未知角色 404 `unknown_character`；整份文件的 revision 不符 409 `{error: "revision_conflict", revision}`；提示被出站守卫拦截 409 `outbound_blocked`。成功 revision +1，原子写入 `<state-dir>/character-bindings.json`，200 同 GET。当前角色的语音变更即时更新语音中继和语音启用状态；当前角色的 motion driver 或 persona overrides 变了时刷新它的系统提示，从下一轮生效，改别的角色不刷新。 |
| `GET /character/state` | ui 或 events | 当前角色她自己的状态（`character/character_state.py`）。200 `{character_id, energy, valence, engagement, activity, labels: {energy, mood, engagement}, causes: [{attr, cause, delta, at}], affects_behavior}`：`energy`、`engagement` 0–1，`valence` −1–1，都保留两位小数；`activity` 是她投入的随机 tick 行为或 持续活动类型，没有时 null；`labels` 是档位代码（精神 `lively`/`okay`/`sleepy`/`very_sleepy`，心情 `good`/`steady`/`low`，投入 `absorbed`/`some`/`idle`；web 显示成中文词）；`causes` 是最近 8 次按事件的变化，`cause` 取 `session_done`、`session_error`、`dispatch_done`、`dispatch_failed`、`user_spoke`、`feedback_useful`、`blocked`、`short_walk`、`climb_window_top`、`line`，`at` 为 ISO 8601。值永远是真实记录的，和开关无关。精力按钟点的目标回归（半衰期 45 min）：9–18 点 0.8，19–22 点 0.6，6–8 点 0.5，23–5 点 0.3；坐、待着、睡在跑时把精力补回来，但只补到这个钟点的目标为止，不会超过。心情按半衰期 20 min 回到基线。她的事件：焦点会话变成 `done` / `error`（hook 会话，`session_done` / `session_error`）、派活结果、`/say`、`POST /feedback` `useful`、她自己的行为回执，以及她每说出一句（开始出声那一刻，或只显示文字时整句显示完）记一次 `line`；播报不算她的台词。没有状态模块时 503 `no_state` |
| `DELETE /character/state` | ui | 「重置她的状态」：删掉当前角色在 `character_state` 表里的行，状态从当前钟点的目标精力和心情基线重新开始，原因清空，旧值不会再写回；别的角色的行不动。200 回同 `GET /character/state` 的新状态；没有状态模块时 503 `no_state` |
| `PUT /character/state/switch` | ui | 「状态影响行为」开关：body 正好是 `{"affects_behavior": 布尔}`，否则 400 `invalid_payload`；200 回存下的值。只存在内存里，重启回到默认 true。关掉时照样记状态（事件、回归、行为回执都照常进 `character_state`），但随机 tick 的类型权重一律 1、tick 间隔和短走间隔系数 1、`intensity` 0.4–0.7、主动说话冷却的状态系数 1、持续活动的 `mood` 不因心情变 `happy`、不因精力低提前打哈欠或睡觉、投入不挡随机 tick，给嘴的摘要和行为提示里的档位为空 |
| `POST /chat/prewarm` | ui | body `{}`。输入暂停时可预热当前角色的快速回复 Pi 进程，200 `{"ready": true}`；已启动时复用进程，不发送模型请求。内核不可用时回 503 和错误码。 |
| `POST /say` | ui | body `{"text": "...", "source": "text"\|"voice"}`，`text` 去掉首尾空白后 1–2000 字，`source` 省略时为 `text`，其他值 400 `invalid_source`。`source` 为 `voice` 时可带 `voice_timing` `{pressed_ms, released_ms, final_ms}`（按下、松开说话键和拿到最终识别结果的时刻，整数 Unix 毫秒，都 > 0 且依次不减），原样写进这一轮 trace 的 `input.received` attrs；不合格或 `source` 不是 `voice` 时 400 `{"error": "invalid_payload", "field": "voice_timing"}`。可带 `surface`（文字从哪个入口来）：`quick_input`（桌面快速输入）、`bubble_reply`（气泡「回复」）、`thought_offer`（接受想法的建议动作）、`chat`（主窗口对话页），写进这一轮 trace，角色内核这一轮的上下文写明从哪里发来；其他值 400 `{"error": "invalid_payload", "field": "surface"}`。可带 `quote` `{text, app}`（带选区打字时的选区原文和来源 App）：`text` 去掉首尾空白后 1–2000 字，`app` 为字符串或 null；只进这一轮的上下文（标明是数据不是指令，经出站过滤），不进聊天记录；形状不对 400 `{"error": "invalid_payload", "field": "quote"}`。可带 `reply_to` `{kind, id}`（用户在回应她的哪一句）：`kind` 为 `line`（她说出口的一句，含主动台词）或 `thought`（想法气泡），`id` 是那句台词或那条想法的 id（非空字符串）；写进这一轮 trace，上下文写明在回应她哪句（在主动发言记录里找到原文时引原文，经出站过滤；找不到时只说在回应她之前的一句话）；主动发言记录只把这一条记成已回应（想法的 `reply` 原文为「已接受」），主动台词的冷却也只把这一条算作回应，不带 `reply_to` 的输入不记任何回应；形状不对 400 `{"error": "invalid_payload", "field": "reply_to"}`。换角色事务开着时 409 `{"error": "switching"}`，什么都不做（不清播报槽）。先过确定性命令（停下、拒绝、静音、取消静音、打开 X、跳到 X、让 Claude/Codex ……）；没命中就交给「嘴」，返回 202 `{line_id, generation}`（`generation` 是这句的 `turn_generation`，给 `POST /turn/cancel`），「看一下」「你看看这个」等返回 202 `{line_id, generation, command: "look"}`：先按 `POST /look` 要一张图，等描述回来（最多 20 s）再让「嘴」回答，要图被拒（没开截图、被拦、到每日上限）就直接回答；台词从 `/feed` 的 `line` 流出，边生成边按分句送 TTS（C2 v2 utterance，每个分句一条 `/speech` 流；`text`、`voice` 的台词 `interrupt_policy` 为 `immediate`，主动台词和播报为 `clause_end`）；新的一句会打断上一句（按上一句的 `interrupt_policy`）。「让 Claude/Codex ……」开一张 `dispatch` 确认卡，返回 202 `{command, request_id}`：目录用 body 的 `cwd`（可省；给了就必须是存在的绝对目录，否则 400 `{"error": "invalid_payload", "field": "cwd"}`，不管这句是不是派活），没给时用焦点会话的 cwd，也没有焦点会话时 409 `{"error": "no_cwd"}`；这一轮不记（`no_memory: true`）时 409 `{"error": "no_memory_dispatch"}`，不开卡。body 可带 `verify_cmd`（字符串，验证命令）：卡片以 `read_only` 打开，这时只能是只读预设之一（`git diff --stat`、`git status --short`、`git log -1 --stat`），否则 400 `{"error": "invalid_verify_cmd"}`、不开卡；不是字符串 400 `{"error": "invalid_payload", "field": "verify_cmd"}`（不管这句是不是派活）。它写进卡的 `dispatch.verify_cmd`（没有时 null），随卡一起批准；卡上换了 `mode` 时按最终模式再校验一次，不合格就不验证（任务 `result` 记 `{"reason": "verify_rejected"}`）。`verify_cmd` 是单条命令，按 `shlex.split` 拆成 argv 在任务的 cwd 里直接执行、不经 shell（管道、重定向、`&&` 都不生效），超时 120 s，保留输出尾部 4 KB。每张派活卡是一个任务（`GET /tasks`，`task_id` 即卡的 `request_id`）。点「允许」后开一个自有会话（见下），它的第一轮 CLI 答完（有没有最终文字都算）只是 CLI 的回答，之后在后台验证并按结果发 `announce`（`detail` 是最终文字，截到 4000 字，没有时 null）：有 `verify_cmd` 且退出码为 0 为 `dispatch_done`（`P0`，「<target> 的任务完成了，验证通过」），非 0、超时或起不来为 `dispatch_failed`（`P1`，「<target> 的任务验证没过」），没有 `verify_cmd` 为 `dispatch_review`（`P2`，「<target> 回话了，结果待你确认」，用 `POST /tasks/<id>/accept\|reject` 定结果）。第一轮出错或进程退出为 `dispatch_failed`（`P1`，「<target> 的任务失败了」），任务 `failed`；被打断的轮不播，任务 `cancelled`（`result` `{"reason": "interrupted"}`）。之后的轮答完不播，出错或进程退出播 `session_failed`（`P1`，「<target> 的会话出错了」）。可带请求头 `Idempotency-Key`，规则同 `POST /sessions*` 的幂等键：同一个键同样的 body 回第一次的结果（派活只开一张卡、同一个 `request_id`）。其他命令返回 200 `{command}`；「拒绝」只在恰好一张待决卡时生效，否则 409；「停止任务」「取消任务」「别做了」（`stop_task`）只在恰好一个自有会话正在跑一轮时生效：打断它（同 `POST /sessions/<id>/interrupt`），它的派活任务还在跑时转 `cancelled`（`result` `{"reason": "stop_task"}`），200 `{"command": "stop_task"}`；没有在跑的 409 `{"error": "no_task"}`，多于一个 409 `{"error": "ambiguous_task"}`；没有 key 时 503。整句以「提醒我」开头（去掉角色名和「请」之后；句中出现的不算）时记一条提醒（`commitments`，本地时区，时间如「十分钟后」「半小时后」「明天8点」「下午三点半」「15:30」），200 `{command: "remind", commitment}`（`commitment` 是这条提醒的行 `{id, text, due_at, state, created_at, created_line, delivered_line, updated_at, seen_at}`），`/feed` 发 `commitment` `{action: "added", commitment}` 并播 `reminder_set`；到点时播 `reminder_due`，播出（交给语音或排进播报槽）后提醒转 `fulfilled`；只显示不播时停在 `triggered`，等用户操作，`/feed` 发 `commitment` `{action: "fulfilled", commitment}`；`state` 为 `armed` → `triggered` → `fulfilled`，旁路 `missed`（重启错过）和 `cancelled`（`POST /commitments/<id>/cancel`）。没说清时间或要提醒的事时 409 `{"error": "no_reminder_time"}`，不记也不交给「嘴」；没有提醒库时 503 `{"error": "no_commitments"}`。body 可带 `"no_memory": true`：这一轮不写事实记忆，聊天记录照常存；`no_memory` 不是布尔值时 400 `invalid_no_memory`。body 可带 `"look": true`：没命中确定性命令的文字照「看一下」处理（先按 `POST /look` 要一张图，等描述回来最多 20 s 再回答，要图被拒就直接回答），回 202 `{line_id, generation, command: "look"}`；命中确定性命令时忽略 `look`；`look` 不是布尔值时 400 `invalid_look`。body 可带 `look_window` `{window_id, pid?}`（用户把角色拖到的那个窗口，`window_id` 必填、`pid` 可选，都是正整数）：同 `look: true`，但向这个窗口要文字（`/feed` `request` 的 `mode: "text"`、`reason: "look_window"`），文字回来后进这一轮的上下文；Companion 报读不到（`POST /context/image` 带 `error` `ax_empty` 或 `ax_unavailable`）且截图开着时，在同一个 20 s 内改要这个窗口的图（`mode: "image"`、`reason: "look_window"`）；没开窗口文字时被拒（`permission_unavailable`）并直接回答；形状不对或和 `look: true` 同时给 400 `{"error": "invalid_payload", "field": "look_window"}`。每句台词（含被取消、出错的）写进 `<state-dir>/agentd.sqlite` 的 `history_turns`，永久保留；发给 API 的仍只是最近 8 轮说完或被打断的（被打断的只送用户听到的部分）。交给「嘴」的 202 都另带 `trace_id`（这一轮 T1 trace 的 id，与 `input.received`、`/feed` `turn_accepted` 的相同；`POST /conversations/:id/messages` 的 202 同样带）。 |
| `POST /context/attention` | ui | 外壳每秒一条心跳：`{ts, front: {app, bundle_id, pid, window_id, title, url_host}, mouse: {app, bundle_id, pid, window_id}\|null, idle_s, locked, asleep, focus_role, secure_input}`。`title`、`focus_role` 缺权限时为 null（合法）；`title` 最长 256 字，agentd 再截一次。`url_host` 只是主机名（不带路径、端口以外的 URL 部分），浏览器没给 Automation 权限时为 null；带路径的值被 agentd 丢成 null。黑名单命中的窗口（`front` 或 `mouse`）发 `{"app": "<hidden>"}`；`secure_input` 为真时 `front` 不带 `title`。无痕只在采集端判定：Chrome 用 AppleScript 的窗口 mode，**Safari 私密窗口检测不到（已知缺口）**；命中的窗口按 hidden 发，POST 里没有 incognito 字段，所以 agentd 的第二道过滤拦不住无痕。agentd 收到后再按黑名单（含 `url_host` 对 `domains`）过一遍、丢掉 `secure_input` 时的标题，再合并进时间线。可选布尔字段（省略为 false）设置主动说话闸门的情境，每条心跳覆盖上一条：`fullscreen`（前台窗口全屏）、`camera_active`（摄像头在用）、`mic_active`（**别的 app** 在用麦克风，Companion 自己听语音不算）、`user_speaking`（按住说话键期间为 true）；`camera_active` 或 `mic_active` 为真时按开会处理。可选 `focus_window: {role, subrole}`\|null：焦点元素所在窗口的 AX role 和 subrole，各为字符串或 null；host 先取焦点元素的 `AXWindow`，取不到就沿 `AXParent` 往上找；省略或 null 表示不知道；`front` 命中黑名单时为 null。200 `{}`；字段不对（含这四个不是布尔、`focus_window` 不是对象或 null、`role`/`subrole` 不是字符串或 null）400 `invalid_attention` |
| `POST /context/events` | ui | Companion 批量发的辅助功能事件，存进 `attention.sqlite` 的 `events_raw`，保留 48 小时。body `{"events": [Event, ...]}`，1–200 条；超过 400 `too_many_events`，body 不是对象、`events` 不是列表或为空 400 `invalid_events`。Event：`ts`（数字，unix 秒，早于 now−600 或晚于 now+5 的丢掉）、`kind`（`app`\|`window`\|`focus`\|`value`\|`selection`；`prompt` 只由 agentd 自己写，POST 里出现就丢）、`app`（≤128）、`bundle_id`（≤256\|null）、`pid`（整数，不存）、`window`（≤256\|null）、`url_host`（只是主机名\|null，带路径的置 null）、`doc`（≤512\|null）、`role`/`subrole`（≤64\|null）、`label`（≤120\|null）、`value`（≤500\|null）、`value_len`/`shrink`/`edits`（非负整数\|null）。字符串超长的截断；不合法的那条丢掉、计入 `dropped`，不让整批失败。黑名单命中（`app`、`bundle_id`、`url_host`，窗口标题按 `title_patterns`）的整条丢掉，读的时候再过一遍。同意项 `typed_text`（启动参数 `--share-typed-text` 且配置里 `share_typed_text` 为 true，默认关）为假时 `value` 一律置 null 再存；最近一次心跳 `secure_input` 为真时也置 null。这项管输入框和用户提问的文字；完整编码会话证据另由 `agent_sessions` 控制。撤回 `typed_text`（含 `/context/privacy/sync` 的 revoke）或启动时不被允许，就把已存的 `value` 全部置 null、删掉 `kind='prompt'` 的行。暂停观察时 200 `{"paused": true}`，不存。`DELETE /observation`、`DELETE /attention`、`POST /blacklist` 的删除和 `POST /reset` 一并覆盖这张表。200 `{"stored": n, "dropped": m}` |
| `POST /context/timeline` | ui | Companion 批量发的桌面时间线记录，存进 `timeline.sqlite`（`observation/timeline.py`），按 `ts` 分进 10 分钟段（`segment = int(ts // 600) * 600`），保留 24 小时（打开时、每次收下一批后和周期 tick 每 60 秒删一次更早的）；之后的本机压缩、摘要和实时理解只读它。body `{"records": [Record, ...]}`，1–200 条；超过 400 `too_many_records`，body 不是对象、`records` 不是列表或为空 400 `invalid_records`；没有时间线 503 `no_timeline`。Record：`ts`（数字，窗口同 `/context/events`）、`kind`（`window`\|`click`\|`context_menu`\|`shortcut`\|`submit`\|`text_input`\|`selection`）、`app`、`bundle_id`（字符串\|null）、`pid`、`window_id`（整数\|null）、`window_title`（≤500\|null）、`url_host`（只是主机名\|null，带路径的置 null）、`target`（`{role, subrole, title, description, identifier, value}` 各为字符串\|null，各 ≤200、`value` ≤2000；或 null）、`keys`（≤64\|null）、`text`（≤2000\|null）、`tree`（`{mode: "full"\|"diff", text}`，`text` ≤32000；或 null）。超长的截断后收下；类型不对或 `kind` 不认识的那条丢掉、计入 `dropped`。黑名单命中（规则同 `/context/events`，窗口标题按 `window_title`）的整条丢掉。同意项 `typed_text` 为假时 `text` 和 `target.value` 置 null 再存；同意项 `window_text` 为假或 `screen_context_level` 不是 `window`（窗口摘要）时 `tree` 置 null 再存；最近一次心跳 `secure_input` 为真时这三项都置 null。撤回 `typed_text` 或启动时不被允许就把已存的 `text` 和 `target.value` 全部置 null；撤回 `window_text` 或启动时不被允许就把已存的 `tree` 全部置 null。暂停观察时，或有 `--privacy-config` 而其中 `share_actions` 不为 true 时，200 `{"paused": true}`，整批不存；暂停期间的记录事后补发也丢掉。`DELETE /observation`、`DELETE /attention`、`POST /blacklist` 的删除和 `POST /reset` 一并覆盖；清除后补发的、`ts` 早于清除时刻的记录不存。样例：`protocol/C6-agentd-api/fixtures/context-timeline.json`。200 `{"stored": n, "dropped": m}` |
| `GET /context/timeline/summaries?q=&since=&limit=` | ui | 读取或按关键词检索 10 分钟时间线摘要（`timeline.sqlite` 的 `summaries` FTS5 表）：不带 `q` 时按 `segment` 倒序返回最近 `limit`（1–100，默认 50）条（可带 `since` 秒时间戳过滤）；带 `q` 时走 FTS5 词匹配。返回 200 `{"summaries": [{"segment": int, "text": str}]}`；参数无效 400 `invalid_limit`/`invalid_since`；没有时间线 503 `no_timeline`。 |
| `DELETE /context/timeline/summaries/<segment>` | ui | 删除指定 10 分钟段的摘要并执行 FTS `optimize` 清理，同时令依赖该段的简报失效。返回 200 `{"deleted": bool, "segment": int}`；没有时间线 503 `no_timeline`。 |
| `GET /attention/summary?since=&by=` | ui | `by` 取 `app`（默认）、`title`、`domain`（按 `url_host`，含浏览器扩展的数据）；`since` 默认今天 0 点。返回 `{since, until, active_s, afk_s, unknown_s, items: [{key, seconds}]}`，按时长排序，最多 20 项。活跃 = 窗口 ∩ 非 AFK。两次 POST 间隔超过 5 s 的空档算 `unknown`：不算活跃也不算 AFK，不用上一个状态补 |
| `GET /context/browser/policy` | hook | Native host 每次采样前查询 `{enabled, text_enabled}`。未启动注意力、暂停观察、重置或安全输入时 enabled 为 false；text_enabled 还要求 share_page_text 开启。策略失败时扩展停止采集。 |
| `POST /context/browser` | hook | heartbeat / page / selection / selection_cleared / metrics；身份为 browser_session、tab_id、document_id、revision。心跳保存 window_focused 和 visible，失焦停止网页时间与当前正文上下文；page 允许空字符串以失效旧正文。share_page_text 关闭时 page/selection 不存储（200）。metrics 只接受数字、布尔与固定枚举白名单，须匹配当前前台文档及 revision，且只保留最新一份在内存中。消息格式见 [docs/architecture/agentd.md](../../docs/architecture/agentd.md#浏览器扩展消息)。 |
| `GET /attention/browser` | ui | 今日网站时长 summary + connected、focused、current、page_switches、samples_received。current 仅含域名、采样时间、滚动和媒体数值及标签数量，15 秒过期；不含标题、正文、选区或身份，不进入模型上下文。最多 20 个网站；黑名单过滤。 |
| `POST /context/text` | ui | 外壳发窗口文字：`{window_id, app, bundle_id, title, url_host, text, source: "ax"\|"ocr", secure_input, incognito, request_id}`，`text` ≤20000 个 Unicode scalar（不是 UTF-8 字节数），`secure_input`、`incognito` 省略为 false，`request_id` 回应 `request` 时带上，否则 null。`url_host` 可省略或 null，有就只能是主机名（不含 `/?#@` 和空格），命中黑名单 `domains` 时按 `blacklisted` 丢弃。202 `{"accepted": true}`；黑名单窗口、无痕窗口或 `secure_input` 时 202 `{"accepted": false, "reason": "blacklisted"\|"incognito"\|"secure_input"}`，文字丢弃；字段不对 400 `invalid_payload`；没有注意力存储时 503 `no_attention` |
| `POST /context/image` | ui | 回应 `mode: image` 的 `request`：`{request_id, window_id, url_host, png_base64}` 或 `{request_id, window_id, url_host, jpeg_base64}`，二者恰好带一个（都带 400 `invalid_payload`），只收 PNG 或 JPEG（JPEG 的宽高取自 SOF0/SOF2 段），长边 ≤1280；`url_host` 规则同 `/context/text`，命中黑名单 `domains` 时 409 `blocked`/`blacklisted`。202 `{"accepted": true, request_id, "status": "pending"}`；没有对应的未过期请求（60 s，`secure_input` 变真、黑名单文件改动或 `DELETE /attention` 会取消所有在途请求）或 `window_id` 不符 404 `unknown_request`；窗口已进黑名单、是无痕窗口或 `secure_input` 时 409 `{"error": "blocked", "reason": "blacklisted"\|"incognito"\|"secure_input", "status": "declined"}`；长边超过 16384 或像素超过 6400 万 413 `too_large`；字段里的字节不是对应格式（PNG 签名加 IHDR，或 JPEG 的 SOI `FF D8` 加 SOF0/SOF2）400 `invalid_payload`。Companion 拿不到图时两个图字段都不带、改带 `"error"`：`capture_failed`、`permission_denied`、`window_gone`（其他值 400 `invalid_payload`），这个请求分别结束为 `failed`、`declined`、`unavailable`，回 200 `{request_id, status}`；没有对应的未过期请求（含图已交过）时 404 `unknown_request`。每个请求只有一个终态，结束后再交图或回报失败都是 404 |
| `POST /look` | ui | 「看一下」，body `{}`：给焦点窗口发一个 `image` 请求，不问 judge、不受 30 s 间隔和每小时上限，受黑名单、无痕、`secure_input` 和每日上限约束。202 `{request_id, "status": "pending"}`；409 `{"error": ..., "status": ...}`：`vision_off`（没开 `--share-screenshots`）、`no_focus`、`daily_cap` 的 `status` 为 `unavailable`；`blocked`（带 `reason`，同上）的 `status` 为 `declined`；观察暂停时 409 `{"error": "paused", "reason": "paused", "status": "unavailable"}`（「看一下」同样被拒）。「看一下」那句台词只用这个 `request_id` 自己的结果：结束为 `ready` 时带描述，否则写没看到和原因（`failed`、`declined` 等，或 `timeout`），不拿更早的描述补位 |
| `DELETE /attention` | ui | 清空注意力和浏览器上下文，连同 T1 trace 事件（protocol/C6-agentd-api/T1-TRACE.md），返回 `{deleted, trace_deleted}`；清空后在途轮不再写 trace |
| `PUT /observation/paused` | ui | 暂停观察：body `{"minutes": 0–1440 的整数}`，0 恢复；200 `{"paused_until": ISO 8601 或 null}`；其他 400 `invalid_payload`。到 `paused_until` 自己结束（每次用到时看时钟）。暂停期间 `/context/attention`、`/context/browser`、`/context/text`、`/context/image` 一律 200 `{"paused": true}`，什么都不存，心跳里的闸门情境（含 `camera_active`/`mic_active` 的开会）保持上一次的值；capture 不发 `request`；`POST /look` 和「看一下」被拒（见 `POST /look`）；主动说话收不到心跳（没有搭话也没有提醒）。只在内存里，重启后不再暂停 |
| `PUT /observation/meeting` | ui | 手动开会模式：body `{"on": true\|false}`，200 `{"meeting": bool}`；不是布尔 400 `invalid_payload`。开着时闸门理由为 `meeting`（和心跳里的 `camera_active`/`mic_active` 任一为真同样处理）：主动搭话和非 P0 播报不出声，P0 照常；观察也按 `PUT /observation/paused` 暂停，直到关掉：上面那几路输入和 `/context/events` 什么都不存，不写活动摘要，开着期间的事件事后补发也丢掉。只在内存里 |
| `PUT /observation/quiet` | ui | `{until: unix 秒 \| null}` → `{quiet_until}`：安静总开关，期间开会模式开、观察暂停，到点自动结束；期间到期的提醒等安静结束再说。 |
| `GET /focus` | ui | 用户自己开的专注时段：200 `{focus: {started_at, until, minutes, started_by: "user"} \| null}`（unix 秒）。`/desktop/presence` 的 `focus` 是 `{until, minutes}` 或 null。 |
| `POST /focus` | ui | body `{"minutes": 5–120 的整数}` 启动专注计时；200 `{focus}`（同 `GET /focus`）；字段不对 400 `{"error": "invalid_payload", "field": "minutes"}`，超出范围 400 `invalid_minutes`，已有一个在跑 409 `focus_running`。专注期间闸门对非 P0、P1 的一律给理由 `focus`（主动搭话和 P2 播报不出声），她的持续活动是 `think`；它不开观察。存在 `<state-dir>/focus.json`，重启后在时段内照旧。到点（或提前结束）播 `focus_done`（`P1`）：「这次专注了 N 分钟：完成了 a 个 agent 会话，处理了 b 张审批，送达了 c 条提醒；<应用类别> m 分钟。休息 5 分钟？」，只列非零的计数；应用类别分钟只算观察开着时的心跳。 |
| `DELETE /focus` | ui | 提前结束专注，同样播 `focus_done`；200 `{"focus": null}`；没有在跑的 409 `no_focus`。 |
| `GET /proactive/mutes` | ui | 用户关掉的主动台词类别：200 `{"muted": [...]}`，按字母序，取值为 `comment`、`back`、`break`、`stuck`（`/feed` `line` 的 `reason.kind`、nudge 的 `kind`）和 `thought`（`/feed` 的 `thought` 想法）。这些类别的 P2 台词闸门理由为 `muted`，P0、P1 播报不受影响；存在 `agentd.sqlite` 的 `gate_mute`，重启和 `POST /reset` 后仍在。 |
| `PUT /proactive/mutes` | ui | body `{"muted": [...]}` 整个替换（设置页「恢复」发去掉那一类的列表）；有不在上面五类里的值或不是列表 400 `invalid_payload`；200 同 `GET`。 |
| `GET /proactive/settings` | ui | 主动提示开关和安静时段：200 `{"companion_mode": bool, "quiet_start": int, "quiet_end": int}`。没存过 `companion_mode` 时跟随主动说话开关；小时 0–23，本地时间，可跨午夜，两者相等表示没有安静时段，默认 22 与 8。 |
| `PUT /proactive/settings` | ui | body 是 `companion_mode`、`quiet_start`、`quiet_end` 的任意非空子集，不重启即生效；其他键或小时不是 0–23 的整数 400 `invalid_payload`；200 同 `GET`。 |
| `GET /proactive/stats?days=` | ui | 最近 `days` 天（默认 7，最多按 30 算，< 1 或非整数 400 `invalid_days`）出现过的主动消息按触发类别计数：200 `{<trigger>: {shown, replied, accepted, feedback}}`；没有主动消息记录时 200 `{}`。 |
| `DELETE /observation?range=15m\|1h\|today` | ui | 删除最近看到的：截止点为现在减 15 分钟、1 小时，或今天本地 0 点；其他值或缺省 400 `invalid_range`；没有注意力存储时 503 `no_attention`。删掉开始于截止点及之后的注意力事件（跨过截止点的事件截到截止点）、`ts` 不早于截止点的浏览器上下文、截止点及之后发出的 capture 请求记录，以及截止点及之后收到的看图描述和窗口文字；记忆里来源为 `observed_context`、`inferred_hypothesis` 且记录时间不早于截止点的事实一并删除（同 `DELETE /memory/facts/<fact_id>`，原文清掉，说过它的轮的 trace 文字一并清掉），每条在 `/feed` 发一条 `memory` `{action: "deleted", fact_id}`。200 `{events, context, observations, facts}`，都是实际删掉的行数（截短的事件不算）。正在进行、上下文用了这些内容的一轮按 `DELETE /context/items/<type>` 的规则结束（`error: "context_cleared"`） |
| `DELETE /context/items/<type>` | ui | 清掉一条上下文，`type` 为 `view`（capture 现在的看图描述）、`window_text`（前台窗口现在的文字）、`page`、`selection`（浏览器现在这一页的正文或选区：这一页的这类记录全部删掉，同页更早的不会顶上来）；其他值 400 `invalid_type`。没有这条、没有 capture 或注意力存储时 `cleared: false`，照样 200 `{type, cleared, cancelled_line}`。正在等待或生成、且已经组好上下文并用了这一类的那句台词按 `POST /turn/cancel` 结束整轮（`cancel.requested` 的 `by` 为 `system`），`line` 的末条 `cancelled: true`、`error: "context_cleared"`，语音按 `client_cancel` 立刻停；还没组好上下文的不取消，已经播出的语音不撤回；`cancelled_line` 表示是否真的切断了一句 |
| `PUT /context/activity` | ui | 更正现场判断：body `{"activity": a, "minutes": 1–240 的整数}`，`a` 为 活动标签（不含 `unknown`），或 `{"activity": null}` 撤掉更正；其他 400 `invalid_payload`。agentd 只记一条更正 `{activity, until, focus_id}`（`focus_id` 是此刻现场判断的焦点 id，可为 null）；在同一焦点（`focus_id` 为 null 时不限）且没过 `until` 时，现场判断（给「嘴」的上下文、主动搭话、`/diag/state`）的活动就是它，`confidence` 1.0、`corrected: true`，不跑规则和 judge，打断许可仍受连续输入、全屏等条件限制；换了焦点或过了 `until` 就回到推断，更正在下次用到时丢掉。只在内存里。200 `{activity, until, focus_id, cancelled_line}`（撤掉时前三个为 null）；正在生成、上下文用了现场判断的那句按上一行同样结束（`error: "context_cleared"`） |
| `GET /blacklist` | ui | 200 `blacklist.json` 的内容（见下文）；没有注意力存储时 503 `no_attention` |
| `POST /blacklist` | ui | 加一条黑名单：body `{"field": "bundle_ids"\|"app_names"\|"domains"\|"title_patterns", "value": 1–200 字, "delete_existing": bool}`；`title_patterns` 编译不过 400 `invalid_pattern`，其他字段不对 400 `invalid_payload`。已有同值时不重复加；文件经临时文件改名整体替换（0600），随即重读。`delete_existing` 为真时删掉这一条（只按这一条）命中的已有记录：`window`、`focus` bucket 按 `app`/`bundle_id`/`title`/`url_host`，`browser` bucket 和上下文行按 `url_host`/`title`；capture 里这些窗口的请求记录删掉，看图描述和窗口文字随黑名单重读一起作废。200 `{"added": bool, "deleted": {events, context, observations}}`（行数；`delete_existing` 为假时都是 0）。T1 trace 事件不删。带 `"list": "allow"` 时加到白名单：`field` 只能是 `bundle_ids`、`app_names`、`domains`，不读 `delete_existing`，不删记录，回 200 `{"added": bool, "deleted": {三项都是 0}}`。 |
| `DELETE /blacklist` | ui | 去掉一条黑名单（给设置里黑名单条目的删除按钮）：body `{"field": "bundle_ids"\|"app_names"\|"domains"\|"title_patterns", "value": 1–200 字}`；回 200 `{"removed": bool}`（这一条本来不在为 false）；字段或值不对回 400 `invalid_payload`。文件原子写（临时文件再改名，0600），写完重读。它藏掉后已删的记录不会回来 带 `"list": "allow"` 时从白名单去掉一条，`field` 同上。 |
| `POST /blacklist/mode` | ui | 切换读取模式：body `{"mode": "allow"\|"deny"}`；别的值 400 `invalid_payload`；没有注意力存储时 503 `no_attention`；回 200 `{"mode": ...}`。改的是 `blacklist.json` 的 `mode`，不删已有记录 |
| `GET /trace/turns?since=&limit=&source=&result=` | ui | 每轮一行，新的在前：200 `{turns}`，每项 `{trace_id, turn_id, source, head, len, started_at, result, duration_ms, producers}`（`len` 是输入全文的字数，没有文本时为 null；`producers` 是这一轮出现过的产生方，排好序）（`result` 为 `completed`\|`text_generated`\|`unknown`\|`interrupted`\|`failed`\|`blocked`\|`open`）；`limit` 默认 50、1–200，`since` 为带时区的 ISO 8601，不合法 400 `invalid_query`；没有 trace 库时 `/trace/*` 一律 503 `no_trace`；`events_token` 读 `/trace/*` 一律 401 |
| `GET /trace/turns/<trace_id>?with_text=1` | ui | 这一轮全部事件，按 [T1-TRACE.md](T1-TRACE.md)「时间」的规则排好：200 `{trace_id, events, skew_ms}`；文本默认只有 `{len, head}`，`with_text=1` 才带 `text` 全文；不存在 404 `unknown_trace` |
| `GET /trace/decisions?kind=&since=&limit=&trace_id=&request_id=` | ui | 闸门、判断、行为、派活、审批、主动台词反馈事件，新的在前：200 `{events}`；`kind` 可写 `dispatch`、`approval` 前缀；`limit` 默认 100、1–200，不合法 400 `invalid_query`；`trace_id` / `request_id` 只留这一轮 / 这张卡片（`attrs.request_id`）的决策，与其他条件同时成立，空值 400 `invalid_query` |
| `GET /trace/export?with_text=1` | ui | 全部 trace 事件，旧的在前：200 `{events}`；默认去掉 `text` 和 attrs 里每个文本值的 `head`，只留 `len`；`with_text=1` 带全文。Companion 不调；给工具和人工排查用。Companion 的单轮导出用 `/trace/turns/<trace_id>` |
| `GET /trace/events?since=&until=&kinds=&limit=&cursor=` | ui | 所有 trace 里 `since` ≤ `t_wall` ≤ `until` 的事件，按 agentd 存入的先后，旧的在前：200 `{events, cursor}`；`since`、`until` 为带时区的 ISO 8601，省略时那一头不限；`kinds` 为逗号分隔的 kind 名（T1 的 kind 表），只回这些 kind；`limit` 默认 200、1–200；还有下一页时 `cursor` 为不透明字符串，带上它（其余参数不变）读下一页，没有了为 null。文本只有 `{len, head}`，不带 `text`（不认 `with_text`）。参数不合法（时间不带时区、未知 kind、空的 `kinds` 或 `cursor`、读不懂的 `cursor`）400 `invalid_query` |
| `GET /diag/state?with_text=1` | ui | 诊断快照，十三个区块 `hooks`、`turn`、`mouth_voice`、`gate`、`proactive`、`observation`、`body`、`sessions`、`budget`、`connections`、`context`、`behavior`、`character_state`（`character_state` 同 `GET /character/state`，没有状态模块时各值为 null、`causes` 为 `[]`；`behavior` 为 `{running: [{behavior_id, type, target, since}]（在跑的全部行为，先发的在前，没有时为 `[]`，同 `/events` snapshot 的 `behaviors`）, switches, last_receipt: {behavior_id, phase, reason, at} 或 null}`，`since`、`at` 是 agentd 发出、收到的时刻；`observation` 还带 `paused_until`、`meeting`，同 `GET /state`；`context`：这一轮给了嘴哪些内容、各自何时失效、最近一次被拒的观察和 `reason`：`no_permission`\|`capture_failed`\|`not_connected`\|`expired`\|`unavailable`；`context.activity` 为 `{activity, confidence, corrected, until}`，现在的现场判断，`until` 是 `PUT /context/activity` 更正的到期时刻，没在更正时为 null；没有注意力存储时整块为 null；`gate` 带 `today`（今天放行的非 P0 台词数）和 `blocked_today`（今天被闸门拦下的非 P0 台词数，主动搭话和播报都算，P0 不算）；`hooks` 为 `{claude: {installed, last_at}, codex: {installed, last_at}}`（只观察 hook）：`installed` 为 true 时，设置文件里有指向本 agentd 地址的只观察 hook（判断同 `tools/install_hooks.py`）；文件不存在时为 false；没有可查的文件、或文件读不了时为 null。codex 查 `~/.codex/hooks.json`，claude 查用户级 Claude Code 设置文件（`infra/paths.py` 的 `CLAUDE_SETTINGS`）；只看文件，不看 Codex 是否信任这些 hook。`last_at` 是最近一次收到这一路 hook 请求的时刻，本次启动后没收到时为 null），每块带 `updated_at`（块内数据最后变化的时刻，随时钟走的耗时、冷却秒数不算）；窗口标题、页面标题、选区等文本默认只给 `{len, head}`，`with_text=1` 才多给 `text` 全文；`events_token` 401 |
| `GET /diag/observations/<request_id>` | ui | 按需读取内存中的观察详情；重新检查截图授权、黑名单和策略版本。视觉描述最多 4000 字，不返回原始截图；`current` 表示读取时仍可用于上下文，`used_in_last_turn` 仅表示最近一次上下文组装使用过该记录，不代表回答已显示。请求不存在返回 404，观察模块不可用返回 503。 |
| `GET /diag/stream` | ui | SSE，`id` 为 `<进程>-<序号>`；连上先发 `event: state`（整份快照），之后快照变化时发 `state`（每秒查一次）、新 trace 事件发 `trace`、决策事件发 `decision`（都只带 `{len, head}`；每项有 `event_id, trace_id, turn_id, kind, producer, status, span_id, parent_span_id, duration_ms, at, attrs`）；带 `Last-Event-ID` 重连从它之后补发（保留最近 512 项），序号已被挤掉或属于上一个进程时先发 `event: reset` 再发一份完整 `state`；10 s 没数据发 `: heartbeat` |
| `POST /trace/events` | ui | Companion、Avatar 转发的 T1 事件：body `{"events": [...]}`，`producer` 只能是 `companion` 或 `avatar`；200 `{accepted, rejected: [{index, error}]}`，收下的带 `t_recv_wall`；`events` 不是列表 400 `invalid_payload`；超 200 条 413 `too_many` |
| `GET /history?before=&limit=` | ui | 聊天记录，新的在前：200 `{turns, next}`，`turns` 每项 `{id, event_id, turn_id, source, character_id, persona_revision, user_text, reply, state, started_at, ended_at}`（`source` 为 `text`\|`voice`\|`proactive`，`state` 为 `completed`\|`cancelled`\|`interrupted`\|`failed`，`reply` 是显示出来的整句、不含标记；`interrupted` 的 `reply` 是用户听到的部分，「嘴」的窗口里也只送这部分）；`next` 作下一页的 `before`，没有更早的时为 null。`before` 可省，`limit` 默认 50、1–200，不合法 400 `invalid_cursor`；没有记录库时 503 `{error: "no_history", detail}`（`detail` 是给人看的原因：功能没开，不是出错） |
| `GET /history/export` | ui | 全部聊天记录，旧的在前：200 `{turns}`，每项同 `GET /history` |
| `DELETE /history` | ui | 清空聊天记录和「嘴」的当前窗口，返回 `{deleted}`。Companion 清聊天记录调的是 `DELETE /memory?scope=history`，不调这个 |
| `GET /memory` | ui | 事实记忆：200 `{paused, facts, counts}`，`facts` 是全部有效事实（平铺），每项 `{fact_id, version, kind, text, source, evidence, occurred_at, recorded_at, last_used_at, stale, score}`，`score` 是证据分数（实现在 `personal/memory.py` 的 `evidence_score`）：用户每再说一次 +1，从最后一次起每 30 天减半；确认保留分数，更正清零；分数只显示，从不把事实改成 `confirmed_by_user`；没有争议分（agentd 没有争议信号）；`stale` 为 `last_used_at`（没用过时取 `recorded_at`）早于 30 天前；`counts` 是四种来源各自的条数。没有记忆库时 `/memory*` 一律 503 `{error: "no_memory", detail}`（`detail` 是给人看的原因：功能没开，不是出错）；`events_token` 一律 401 |
| `POST /memory/facts` | ui | 手动加一条：body `{text, kind?}`，`kind` 默认 `fact`；`name`、`birthday` 记为 `confirmed_by_user`，其他记为 `asserted_by_user`；暂停时也写。201 `{fact_id}`；同一类、同样文字、同一来源的有效事实已存在时不新写，给它的分数 +1，200 `{fact_id, reinforced: true}`；`text` 空或超 500 字 400 `invalid_text`，`kind` 不合法 400 `invalid_kind` |
| `PATCH /memory/facts/<fact_id>` | ui | 更正：body `{text}`，写新版本，200 `{version}`；未知 404 `unknown_fact`，`text` 空或超 500 字 400 `invalid_text`。正在出或刚说完的那句用到了这条时，按 `DELETE /memory/facts/<fact_id>` 的规则撤下 |
| `POST /memory/facts/<fact_id>/confirm` | ui | 确认，不要 body：写新版本，来源变 `confirmed_by_user`，200 `{version}`；未知 404 `unknown_fact` |
| `POST /memory/facts/<fact_id>/reject` | ui | 否认一条候选记忆，body `{expected_version}`：候选行删掉，同一条（按 Unicode、大小写、空白归一后的文字）不再提出。200 `{rejected: true}`；未知或不是候选 404 `unknown_fact`，版本不符 409 `version_conflict` `{current_version}` |
| `DELETE /memory/facts/<fact_id>` | ui | 删除（所有版本的原文都清掉），200 `{"deleted": true}`；未知 404 `unknown_fact`。用到这条的那句还在生成或语音还在播时按 `POST /turn/cancel` 结束整轮（`cancel.requested` 的 `by` 为 `system`）；已经说完时那一行聊天记录改为 `cancelled`，也从「嘴」的窗口里拿掉。台词出完、送 TTS 前再核一次用到的事实版本，有变就不送 TTS，聊天记录记 `cancelled`，`line` 的 final 带 `error: "memory_changed"`。回复里说过这条事实的更早轮次同样撤回：聊天记录改为 `cancelled`、文字清空，从窗口拿掉；只注入过、没说出口的更早轮次不动。说过它的轮的 trace 文字（`text` 全文和每个 `head`）一并清掉，事件本身留着 |
| `PUT /memory/paused` | ui | body `{"paused": true\|false}`，200 `{paused}`；不是布尔 400 `invalid_payload`。暂停时「记住…」不写，手动加照常写 |
| `GET /memory/export` | ui | 与 `GET /memory` 同样支持 `?owner=shared` 或 `?owner=<角色 ID>` 精确筛选。每条事实的 `owner` 是角色 ID 或 null（共享），不传筛选条件时列出所有归属。200 `{facts}`，全部有效事实；只导出，没有导入 |
| `DELETE /memory?scope=facts\|history\|all` | ui | `facts` 删除称呼（`name`）和生日（`birthday`）以外的事实；`history` 同 `DELETE /history`；`all` 两者都清、事实全删。删掉的事实按 `DELETE /memory/facts/<fact_id>` 撤回轮次，说过它的轮的 trace 文字一并清掉。200 `{facts_deleted, history_deleted}`；`scope` 缺或不合法 400 `invalid_scope` |
| `POST /reset` | ui | 统一重置，只由用户在界面上输入确认后发出：body 必须正好是 `{"confirm": "delete all local data"}`，否则 400 `confirmation_required`；已有一次在跑时 409 `resetting`。顺序：先置重置标志，此后到结束前除 `POST /reset` 外所有 `POST`/`PUT`/`PATCH`/`DELETE`（含 `/hook/*`、`/context/*`）回 503 `{"error": "resetting"}`，读端点照常，后台写入方（捕获 tick、行为 tick、主动搭话）这期间不干活；再停正在写的：按 `POST /turn/cancel`（`client_cancel`）结束当前一轮并等这句记完，打断并停掉全部自有会话进程、忘掉这些会话（不同于退出，之后还能新建），待决卡全部撤掉（`reason: reset`）；然后逐库各在自己的锁下一个事务清空：`agentd.sqlite` 的 `history_turns`、`own_sessions`、`trace_events`、`facts`、`character_state`（她自己的状态，所有角色的行；当前角色随后从钟点目标和心情基线重新开始），`attention.sqlite` 的 `events`、`context`；每个 SQLite 文件随后 `VACUUM` 加 `PRAGMA wal_checkpoint(TRUNCATE)`，删掉的行不留在空闲页和 WAL 里；日志 `capture.jsonl`、`capture-judge.jsonl`、`proactive-judge.jsonl`、`outbound-guard.jsonl` 在各自写入方的锁下截成 0 字节；内存里的捕获状态、「嘴」的当前窗口、最近一次上下文、最近一次被拒的观察、活动纠正、会话命令回执、决策 trace 索引一起清掉，`/feed`、`/diag/stream` 和 `/speech` 的缓冲丢掉并换新的 `stream_epoch`（带旧游标重连的收到 `reset`），`/feed` 再发一条 `reset` `{at}`，连着的面板据此重新拉快照。最后在新连接上逐表数行，有不为 0 的 500 `{"error": "reset_incomplete", "rows": {…}}`。成功 200 `{"deleted": {表: 行数}, "rows": {表: 0}, "logs": [截断的文件名]}`。故意保留（设置和花费上限，不是用户数据）：`memory_settings`（记忆暂停开关）、`capture_budget`、`model_usage`、观察暂停（`paused_until`）、`blacklist.json`、令牌、`canon-windows.json`。agentd 自己没有配置备份；`own-claude-settings.json` 是每次启动重新生成的配置，保留 |
| `POST /sessions` | ui | body `{target: "claude"\|"codex", cwd, prompt, mode}`，`mode` 可省，默认 `read_only`（Claude `--permission-mode default`，Codex sandbox `read-only`）；`workspace_write` 为 Claude `acceptEdits`、Codex `workspace-write`；Codex 的审批策略和审查方照用户 `config.toml` 的设置；恢复会话时沿用原模式。`read_only` 下两边改文件都先开审批卡、批准后才写（Codex 的 read-only 沙箱没有可写目录，每个补丁都问），命令在 Codex 的只读沙箱里跑；`workspace_write` 下工作区内的改动不问；没有跳过审批的模式。其他值（含 `bypassPermissions`、`danger-full-access`、非字符串）400 `{"error": "unsupported_mode"}`，不建会话。新建自有会话，201 `{session_id, state: "accepted"}`（`own:<hex>`；会话已开、第一轮已发出，没跑完）；CLI 起不来（找不到命令、握手失败）时 502 `{"error": "start_failed"}`，会话照样建了、状态为 `error`（`GET /sessions` 里能看到，可以 `messages` 重试），`lines` 里记一行 `error`，并播 `session_failed`。这样建的会话答完的轮不播，出错或进程退出的轮播 `session_failed`（`P1`）。进程退出时撤掉它所有待批的卡（`cancelled`）。不开确认卡：面板表单在用户点开始前已显示 target、cwd、prompt。字段不对 400 `{"error": "invalid_session", "field": "target"\|"cwd"\|"prompt"}`（`cwd` 不存在或不是目录也算） |
| `POST /sessions/<id>/messages` | ui | body `{text}`，追问；202 `{state: "accepted"}`（只表示这一轮已开始，结果看 `GET /sessions`）；正在跑一轮时 409 `busy`；CLI 起不来（找不到命令、握手失败）时 502 `start_failed`，这一轮按 `error` 结束；外部会话 409 `not_own`；不存在的 id 404 `unknown_session` |
| `POST /sessions/<id>/interrupt` | ui | 打断当前一轮；202 `{state: "accepted"}` 只表示打断已发出：`GET /sessions` 里这个会话的 `cancel_requested` 为 true，直到后端确认这一轮结束才变 false、state 才变；没在跑时 409 `idle`；外部会话 409 `not_own`；不存在的 id 404 |
| 幂等键 | ui | 上面三个 `POST /sessions*` 和 `POST /say` 可带请求头 `Idempotency-Key`（1–128 字节，否则 400 `invalid_idempotency_key`）：同一个键再次提交同样的请求（路径和 body 都相同），回第一次的状态码和 body，不再执行；同一个键换了请求，409 `idempotency_conflict`；同时到达的重复请求等第一个答完再回同一结果。agentd 记最近 256 个键，只在本进程内有效。`state: "accepted"` 是「已接受」，不是「已完成」 |
| `GET /sessions` | ui | `{sessions: [{session_id, own, target, cwd, title, state, last_line, started_at, updated_at, origin, capabilities}]}`，自有会话多一个 `mode`（`read_only`\|`workspace_write`）和 `task_id`（开它的派活卡的任务，`GET /tasks`；不是派活开的为 null），外部会话多一个 `observed_at`（最后收到这个会话 hook 的时间，epoch 秒；同 `/state`）。外部会话（hook 来的）和自有会话一起列出；自有 Claude 会话不会重复出现。`title`：自有会话是首条 prompt 的第一行，截到 80 字；外部会话为 null。`last_line` 是最近一段 agent 文本，最多 200 字；外部会话为 null。`origin`：自有会话为 null；外部会话为 `{kind: "tmux"\|"terminal"\|"desktop"\|"unknown", term_program, tty, tmux_pane, tmux_socket, pid, entrypoint, bundle_id, wezterm_pane, kitty_window_id, kitty_listen_on}`，取该会话最近一次命令型 hook（`codex_hook_forward.py`）带来的值，从没带过时 kind 为 `unknown`、其余为 null。外部会话的 `cwd`、`started_at` 可以为 null（hook 没带 cwd 时；外部会话不记开始时间）。自有会话一轮结束时的状态：正常完成为 `done`，被打断为 `idle`，出错或进程退出为 `error`；之后保持不变，直到下一条消息把它变成 `thinking`。外部会话的状态来自 hook，`done` 约 4 s 后自己回到 `idle`。`capabilities`（`/state` 的 `sessions[]` 也带）：外部会话是 `["observe"]`，`origin.kind` 不是 `unknown` 时加 `"navigate"`；自有会话是 `["observe", "resume", "control"]`。面板只显示列出的按钮；`fork` 目前没有会话提供。host 每秒轮询一次；一轮在 202 之后状态变成 done、idle 或 error 时结束 |
| `GET /sessions/<id>/lines?after=<seq>` | ui | `{lines: [{seq, role: "user"\|"agent"\|"tool"\|"error", text, ts}], next}`，`after` 默认 0，最多保留最近 500 行。自有会话记下 user 输入、agent 文本、工具调用（Claude 为 `工具名: 摘要`，Codex 为命令）；外部会话没有记录，返回空 `lines`；不存在的 id 404 |
| `GET /tasks` | ui | 派活任务（`sessions/tasks.py`），最近更新的在前，最多 50 条：200 `{tasks: [{task_id, target, cwd, title, mode, state, verify_cmd, session_id, created_at, updated_at, result}]}`。`task_id` 为派活卡的 `request_id`；`title` 是提示词第一行，截到 80 字；`mode`、`verify_cmd` 为卡批准时的值。`state`：`proposed`（卡待批）→ `approved` → `running`（会话已开）→ `returned`（第一轮答完）→ `verifying` → `succeeded` / `failed` / `needs_review`；旁路终态 `denied`、`expired`、`cancelled`（会话没能开始 `result` `{"reason": "start_failed"}`，被打断 `interrupted`，「停止任务」`stop_task`）、`interrupted`（重启时在跑、已返回待验证或在验证）；重启时还没开始的记 `expired`。`result` 是验证结果 `{exit_code, output_tail, reason}`（`reason` 为 null、`timeout`、`not_started`、`no_verify_cmd`），或上面的 `{reason}`，没有时 null。没有任务表时 503 `no_tasks`。任务表随 `POST /reset` 清空 |
| `POST /tasks/<task_id>/accept`、`POST /tasks/<task_id>/reject` | ui | 不要 body。用户给 `needs_review` 的任务定结果：accept 转 `succeeded`，reject 转 `failed`，200 `{task}`；其他状态 409 `{"error": "invalid_state"}`；不存在的 id 404 `{"error": "unknown_task"}` |
| `GET /commitments?state=` | ui | 「提醒我…」记下的提醒，按 `due_at` 从早到晚：200 `{commitments: [{id, text, due_at, state, created_at, created_line, delivered_line, updated_at, repeat, seen_at}]}`（`repeat` 为 `daily`、`weekdays` 或 null：重复的提醒到点、完成或重启时错过后都改到下一次并保持 `armed`，`/feed` 发 `commitment` `{action: "rescheduled"}`；安静时到点的提醒照常送达成不出声的卡片，`delivered_line` 为 `silent_card`；`seen_at` 是这次到点后它的卡片第一次出现在屏上的时间（epoch 秒，`POST /commitments/<id>/seen`），还没出现过时为 null，每次转 `triggered` 时清回 null）（行同 `POST /say` 的 `commitment`）。`state` 可写多次（`?state=armed&state=fulfilled`），只列这些状态，省略时列全部；取值 `armed`、`triggered`、`fulfilled`、`missed`、`cancelled`，其他 400 `{"error": "invalid_state"}`。没有提醒库时 503 `{"error": "no_commitments"}` |
| `POST /commitments/<id>/cancel` | ui | 不要 body。取消一条还没到点（`armed`）或已到点未处理（`triggered`）的提醒，它转 `cancelled`，到点不再播，重启也不记 `missed`；200 `{commitment}`（改后的行），`/feed` 发 `commitment` `{action: "cancelled", commitment}`。已完成、已错过或已取消的 409 `{"error": "illegal_transition"}`（和到点同时发生时谁先拿到提醒库的锁算谁的）；不存在的 id 404 `{"error": "unknown_commitment"}`；没有提醒库时 503 `{"error": "no_commitments"}` |
| `GET /schedules` | ui | 本地定时任务：200 `{schedules: [{schedule_id, title, instruction, trigger, enabled, created_from, conversation_id, next_run_at, last_run_at, last_job_id, created_at, updated_at}]}`。`trigger` 为 `{kind: "daily", at: "HH:MM", weekdays: [1–7]}`、`{kind: "weekly", weekday, at}` 或 `{kind: "session_done", target: "claude"\|"codex"\|null, project}`，按系统本地时区算；`created_from` 为 `user` 或 `agent_proposal`（她用 `schedule_propose` 提的，建出来一律 `enabled: false`，只有用户能启用）。到点时作为后台作业提交，结果按派活回报播出；重启后错过不到 6 小时的补跑一次，更早的记 `missed`。没有存储时 503 `{"error": "no_schedules"}` |
| `POST /schedules` | ui | body `{title, instruction, trigger, enabled?, conversation_id?}`，缺键或多键 400 `invalid_schedule`，触发条件不合法 400 `invalid_schedule_trigger`；201 `{schedule}`，`created_from` 为 `user` |
| `PUT /schedules/<id>` | ui | body 可改 `title`、`instruction`、`trigger`、`enabled`；200 `{schedule}`；不存在 404 `unknown_schedule`，不合法 400 |
| `DELETE /schedules/<id>` | ui | 删掉这条定时任务和它的运行记录；200 `{"deleted": true}`；不存在 404 `unknown_schedule` |
| `POST /schedules/<id>/run` | ui | 不要 body，立即作为后台作业运行一次（未启用的也可以），不改原定的下次时间；202 `{job_id}`；不存在 404 `unknown_schedule`，后台不可用 503 `schedule_unavailable` |
| `POST /commitments/<id>/snooze` | ui | body `{minutes: 5 \| 10 \| 15 \| 60}`，其他 400 `{"error": "invalid_payload", "field": "minutes"}`。`armed` 或 `triggered` 的提醒，以及 24 小时内转 `fulfilled` 的提醒，改到 `now + minutes` 并转 `armed`，到点再播；200 `{commitment}`，`/feed` 发 `commitment` `{action: "snoozed", commitment}`。其他状态 409 `illegal_transition`，不存在 404 `unknown_commitment`，没有提醒库 503 `no_commitments` |
| `POST /commitments/<id>/complete` | ui | 不要 body。`armed` 或 `triggered` 的提醒转 `fulfilled`；200 `{commitment}`，`/feed` 发 `commitment` `{action: "completed", commitment}`。错误同 snooze |
| `POST /commitments/<id>/seen` | ui | body `{}`，有别的键或不是对象 400 `{"error": "invalid_payload"}`。Companion 在提醒的卡片出现在屏上时发：没记过 `seen_at` 时记成现在，`/feed` 发 `commitment` `{action: "seen", commitment}`；已记过时不变、不发。不改 `state`、`revision`、`updated_at`，任何状态都收。200 `{commitment}`；不存在 404 `unknown_commitment`，没有提醒库 503 `no_commitments` |
| `GET /capabilities` | ui | 能力快照（`models/capabilities.py`），只读 agentd 已有的状态，不发请求、不调付费推理：200 `{plugins: {id: bool}, items: {name: {state, reason}}, at}`，`state` 为 `configured`、`ready`、`degraded`、`unavailable`、`unknown` 之一，`reason` 为原因码或 null；`name` 为 `generation`、`mouth`、`voice` 和各 `share_<kind>`；`at` 为 ISO 8601 |
| `GET /day/segments?date=YYYY-MM-DD` | ui | 一天的分项目工作段明细（`sessions.day_summary.segments`），给界面和诊断看，不进台词。`date` 省略时为本地今天，不是合法的 `YYYY-MM-DD` 时 400 `{"error": "invalid_date"}`。200 `{date, projects: [{project, name, sessions: [{session_id, started_at, ended_at, agents_done, agents_failed, last_gate, guard_blocks}], own: [{session_id, title, state, last_line, started_at, updated_at, task_id}]}]}`：`sessions` 读 `--ledger-root` 下那天的 harness 账本，`own` 是那天开始的自有会话（`last_line` 截到 200 字）；`last_gate` 为 `{at, passed}` 或 null；项目按最早开始的排前 |
| `GET /episodes?date=YYYY-MM-DD` | ui | 那天本地 0 点到次日 0 点之间开始的十分钟活动摘要（`personal.episodes.Episodes.day`），按开始时间升序。`date` 规则同 `GET /day/segments`（400 `{"error": "invalid_date"}`）；没有情节库 503 `{"error": "no_episodes"}`；没有网页正文同意（`page_text`）时 200 `{date, enabled: false, episodes: []}`；否则 200 `{date, enabled: true, episodes: [{id, start, end, title, description, threads, open_questions, apps, hosts, created_at, titles, typed, presence, user_actions, agent_actions, version, run_id, outcome, edited, owner}]}`，时间为带毫秒的本地 ISO 8601，不带原始事件。`presence`（`present`、`partly`、`away`、`unknown`）、`user_actions`、`agent_actions`（`[{text, evidence}]`、`[{session, text, evidence}]`，`evidence` 是事实表行号）、`version`（3）、`run_id`（写它的 `memory_agent_runs` 行）、`outcome`（那次运行的 outcome，没有为 null）、`edited`（用户改过标题或描述为 true）、`owner`（看到这段活动的角色 id；为 null 时所有角色都能读到） |
| `DELETE /episodes/<id>` | ui | 删一段摘要（`id` 为数字，否则 404 `not_found`）：不存在 404 `{"error": "unknown_episode"}`；删掉它和以它为证据（`episode:<id>@…`）的整合事实（同 `DELETE /memory/facts/<fact_id>`，每条在 `/feed` 发 `memory` `{action: "deleted", fact_id}`），WAL 截断；200 `{"deleted": 1, "facts": n}`；重置中 503 |
| `GET /episodes/<id>/evidence` | ui | 一段摘要的出处：它的 `run_id` 那次记忆运行交给内核的证据，每条线程引用的证据一行；200 `{header: [String], lines: [{n, tag, text}], run: {backend, model, attempt, duration_ms, outcome, reasons}}`。来源权限已收回 403 `{"error": "source_permission_revoked"}`；运行详情已没有 410 `{"error": "evidence_expired"}`；`id` 不是数字或不存在 404 `{"error": "unknown_episode"}`；没有情节库 503 `{"error": "no_episodes"}` |
| `PATCH /episodes/<id>` | ui | 用户改一段摘要，body `{title, description}`：去掉首尾空白后 `title` 1–16 字，否则 400 `{"error": "invalid_title"}`；`description` 1–100 字，否则 400 `{"error": "invalid_description"}`；404、403 同 `GET /episodes/<id>/evidence`；重置中 503。改 `title`、`description`，`edited` 置 true，重建它的搜索索引，在 `summary_corrections` 记一行改前改后的值（删这段摘要、`DELETE /attention`、`POST /reset` 时一起删）；200 `{episode}`，形状同 `GET /episodes` 的一条 |
| `GET /summary/runs?date=YYYY-MM-DD&kinds=memory_extract` | ui | 那天本地 0 点到次日 0 点之间开始的代理运行回执（`memory_agent_runs`），新的在前：200 `{date, runs: [{run_id, kind, started_at, span_start, span_end, outcome, error, attempt, duration_ms, backend, model, episode_id, reasons}]}`，时间为带毫秒的本地 ISO 8601，span 为空时 null，不带任何输入、输出文字。`kinds` 逗号分隔，取值见 `api/episodes.py` 的 `RUN_KINDS`（`memory_extract`、`observation_interpret`、`observation_vision`、`user_vision`、`proactive_decide`、`facing_decide`、`observation_brief`、`review`、`conversation`），省略时 `memory_extract`，其他 400 `{"error": "invalid_kinds"}`；`date` 规则同 `GET /episodes`；没有记忆运行记录 503 `{"error": "no_memory_journal"}` |
| `POST /blacklist/defaults` | ui | 设置里「恢复默认排除」，body `{}`：把 `observation.blacklist.DEFAULTS` 里 `bundle_ids`、`app_names`、`domains` 中当前名单没有的项加回去，不删已有项，也不删已有记录；200 `{"added": n}`；没有注意力库 503 `{"error": "no_attention"}`；重置中 503 |

角色内核与工作记忆的端点（`character_agent/routes/`）全部只收 ui token；hook、events token 一律 401：

- `GET/PUT /character/runtime`：配置、发现、登录类别、可用性与原因。GET 默认用发现缓存（30 秒内有效，可执行文件变化即失效）；`?refresh=1` 强制重新探测本机运行时，耗时数秒，同时到达的刷新共用一次探测。
- `GET/POST /agent/scopes`：资料范围；POST 使用 `roots` 与 `output_root`，或 `files`（拖给她的文件，至多 16 个绝对路径，只读这几个文件，`output_root` 省略时输出在状态目录 `drop-outputs/<scope_id>`，24 小时到期；不支持的类型在回包 `unsupported` 里）。
- `POST /agent/scopes/<id>/revoke`：撤销范围并停止当前动作。
- `POST /agent/artifacts/revert`：body `{run_id, path, expected_version}`，把上一版写回为新的一版（版本号加一），回包是该产物的公开视图。产物每次被覆盖前，旧内容留在同目录 `.versions/<文件名>.v<旧版本号>`，不清理；没有上一版 400 `no_previous_version`，版本不符 400 `version_conflict`，未知产物 404 `unknown_artifact`。
- `GET /agent/runs`：产品运行记录。
- `POST /say`：可附 `scope_id`、`expected_outputs`、`resume_run_id`。
- 文件校验中 `required_source_ids` 要求产物 `source_refs` 的来源链（授权、读取和版本均复核）；只有 `required_inline_source_ids` 要求来源编号逐字出现在文件正文。固定数值 CSV 无需添加来源列或注释。
- `POST /tasks/<id>/continue`：可附 `text`，从最近产品检查点继续。
- `POST /tasks/<id>/cancel`：停止执行。
- `GET /character/capabilities`：安装、鉴权、边界核验及实现能力，不把登录当成任务验收。
- 每轮读取共享事实和本角色的事实。自动提取按对话行所属角色分组。每条提案用 `scope: shared` 保存用户的一般偏好、日程、工作、人际关系或生活事实，用 `scope: character` 保存双方的昵称、约定、私下的玩笑和只对她说的相处方式。轮内 `memory_propose` 也接受 `scope`，默认共享。
- `GET /memory/runs`、`GET /memory/runs/<id>`：统一生成记录与详情。
- 工作记忆（ui 令牌，主窗口用；观察暂停或缺对应许可的行不返回；没有工作记忆库时 503 `worklog_unavailable`）：`GET /memory/sessions?day=YYYY-MM-DD`（默认今天）当天已完成的会话摘要 `{day, sessions}`；`GET /memory/tasks?status=active,done,parked,uncertain` 任务卡 `{tasks, counts}`，`counts` 按四种状态计数；`GET /memory/tasks/<task_id>` 一张任务卡及其会话摘要 `{task, sessions}`，不存在或不可见 404 `task_not_found`；`PATCH /memory/tasks/<task_id>` 用户更正，body 必带 `expected_revision`，另含 `status`、`title`、`goal` 至少一项，版本不符 409 `revision_conflict`（附当前 `task`）；`GET /memory/days?from=&to=`（默认今天，跨度 < 31 天）每日摘要 `{days}`；`GET /memory/days/<date>?period=day|week` 一天或一周的摘要，没有已完成的 404 `day_not_found`。参数不合法 400（`invalid_date`、`invalid_status`、`invalid_range`、`invalid_period`、`invalid_payload`）。
- `GET/POST /agent/goals`、`GET/POST /agent/goals/<id>`：查看、建立和按版本修改目标。
- `GET/POST /agent/jobs`、`GET /agent/jobs/<id>`、`POST /agent/jobs/<id>/cancel|resume`：后台工作及续接。续接可附 `text` 和显式 `use_current_backend`。

每日／每周观察简报（ui token）：`GET /observation/briefs`，`GET/DELETE /observation/briefs/<id>`，`GET/POST /observation/briefs/settings`。`POST /observation/briefs {period:"daily"|"weekly",date?:"YYYY-MM-DD"}` 返回202及id，推理在后台执行，可轮询状态。`observation_brief` feed事件只带id/状态；角色通过 `knowledge_search/knowledge_read` 的 `briefs` 来源读取，临时轮禁读。

连续观察（ui token）：`GET /observation/state`、`GET /observation/sources`、`GET /observation/sources/<id>` 及 `/changes`、`/image`，`POST /observation/analyze`、`POST /observation/refresh`。检索支持 since、kind、cursor；全文读取支持 offset、max_chars、query 和模型工具的 tree/metadata 分页。

隐私同步：Companion 保存后的 `POST /context/privacy/sync {}` 只允许 UI token，返回 `{permissions: {window_text, page_text, screenshots, typed_text, agent_sessions}, consent_epoch}`。可带 `revoke: ["window_text"|"page_text"|"screenshots"|"typed_text"|"agent_sessions"]` 作为撤销记录，确保快速关闭再开启也会丢掉旧缓存。请求本身不授予权限，后台仍只认保存配置；ticker 和读取/出站边界也会复核，UI 离线不影响后台自行收窄。

hook 解绑：设置 › 会话中的每个已安装工具提供「解绑」。该动作走 `POST /integrations/hooks/disconnect {"target":"claude"|"codex"}`，只接受 UI token，配置路径由服务器确定；只移除本服务的 observe-only 组，不留副本，保留其他 hooks、配置键和会话记录。响应为 `{target, removed}`；重复解绑不写文件。JSON 损坏或预备期间文件改变返回 409，读写失败返回 500，不显示成功。`installed=false` 优先于历史 `last_at`，避免解绑后仍误报「接上了」。已经运行的编码工具可能保留旧 hook 配置，重启后生效。解绑不删除历史，也不撤销曾经授予源工具的其他权限。

#### 每日简报 `GET /brief/day?date=YYYY-MM-DD`

主窗口使用 ui token。按服务所在时区的自然日查询，含今天及之前六天。缺少日期、格式不符或日期不存在，回 400 `{"error":"invalid_date"}`。日期有效但超出范围，回 400 `{"error":"date_out_of_range"}`。

200 的顶层字段为 `date`、`partial`、`switches`、`items`、`focus` 和 `her`。今天的 `partial` 为 true，统计截至请求时刻。所有时间戳均为 Unix 秒。

- `switches` 表示当前有效开关。`scr` 对应屏幕感知插件，`read` 对应屏幕识读插件且允许窗口文字或网页正文，`shot` 对应截图同意，`code` 对应编码会话插件且允许读取编码会话，`agent` 对应个人 Agent 插件，`voice` 表示已配置 TTS、当前角色启用语音且未静音。
- `items` 含 `done/err`（任务、运行和会话的完成或失败记录）、`turn`（对话往返）、`line`（角色发言）、`fg`（非 AFK 分钟）、`say`（主动台词）、`motion`（动作开始）、`touch`（有记录的触碰）、`voice`（语音秒数）、`mem`（新事实）、`cost`（美元）、`code`（活跃编码会话）、`shot`（已发送截图）、`mask`（有日期记录的外发遮蔽数）和 `rem`（到期提醒）。每项均为 `{enabled,today,hours,avg7,yesterday}`。一个会话在同一天计一次，归入当天首次有活动记录的小时。
- `hours` 的 24 项对应本地 0–23 点。`cost` 和 `mask` 按日返回，`hours` 为 null。`avg7` 为所选日期之前七个自然日的总数除以七，七天内无该项记录为 null。昨天无记录时 `yesterday` 为 null。所需开关全部关闭时，跳过该来源，`enabled` 为 false，合计为零，比较值为 null。
- `focus` 为 `{enabled,away_min,longest,pauses,apps,sites}`。`longest` 为 `{start,minutes}` 或 null，`pauses` 为当天已知暂停区间 `[start,end][]`。`apps` 和 `sites` 分别为 `{name,minutes}[]` 和 `{host,minutes}[]`，按前台分钟降序各取前六。屏幕感知关闭时整块为空值。站点另需开启识读并允许网页正文，仅计能排除无痕的前台浏览记录。
- `her.said` 为 `{total,self,replied}`，分别为发言总数、主动台词数和用户回复过的主动台词数。`lines` 按 `self`、`reply`、`miss` 各取最近一条 `{at,kind,text,note}`。`touch` 含 `pat,pinch,drag,wheel` 四项。`why` 和 `motions` 为按次数降序排列的 `{key,label,count}[]`，动作最多六项。`desk` 的同形记录另带 `minutes`，计次行为为 null。
- `her.tools` 为 `{enabled,by_name,files_changed,run_minutes,asked}`，包括各工具的 `{key,label,count}`、确认写入的不同文件数、当天的运行分钟以及提问或审批卡数。插件关闭时返回空列表和零。`mood` 取当前角色，按时间升序返回 `[at,energy,valence][]`。`on_desk_min` 无可用时长记录时为 null。
- 所有读数限于各来源保留的记录。触碰和迎接来自 `POST /interaction/record` 的记录：`her.touch` 的四项是当天 `pat`、`pinch`、`drag`、`wheel` 的次数，`items.touch` 是这四项的合计（按记录时刻的小时），迎接不算触碰。`her.desk` 依次为 `window_top`（坐窗顶）、`edge`（屏幕边缘陪你）、`give_way`（给窗口让路）、`greet`（迎接），当天没有的行不出现。窗顶分钟按运行与终态回执配对，其间跨午夜按日切分；仍在执行的行为计至请求时刻。让路按取消回执计次。`edge` 的分钟是 agentd 让她停在屏幕边缘的区间（安静阶段走到边缘或就地停下起，到安静阶段结束），次数是当天开始的停留数。`on_desk_min` 是 `PUT /avatar/visibility` 记下的显示区间落在当天的分钟。区间跨午夜按日切分，还在进行的计至请求时刻。外发遮蔽只汇总有时间戳的 `egress.checked`，进程累计值无法分配给具体日期。

### 4.3 `tool_summary`

`tool_summary`：`tool_input` 里有 `command` 就取它，其次 `file_path`、`notebook_path`，都截到 2000 字符；否则取 `tool_input` 的 JSON，截到 200 字符；截断时末尾是 `…`；没有 `tool_input` 时为 `null`。

### 4.4 `/feed` 事件

| /feed 事件 | data |
|---|---|
| `line` | `{seq, line_id, text_delta, intents, points, final, speak, utterance_id, cancelled, error, generation, reason, remembered, run_id, lane, final_item_id}`。`lane` 为 `agent`（角色前台 run 的台词，`run_id` 为这个 run）、`side`（前台 run 进行中、不属于它的台词，即旁路会话的回答，`run_id` 为 null）或 `character`（其余台词，`run_id` 为 null），同一句的每条都带。`text_delta` 已去掉标记；`intents` 只含 C1 的 12 个值；`points` 是 `{x, y}` 或 `{window}`；每句最后一条 `final: true`；`speak` 为 false 表示静音中、没有语音服务，或角色隐藏时的主动台词（只出字，见 `PUT /avatar/visibility`）；`utterance_id` 是发出这句语音的 utterance（与宿主 `playback` 的 `utterance_id` 相同），从这句第一个子句送去 TTS 之后的那条起带上（发了声的句子 `final: true` 那条一定带）；只出字或还没送出子句时为 null；被打断（含 `turn_generation` 已变）时 `cancelled: true`；出错时 `error` 是异常类名（`memory_changed`、`context_cleared` 见 `DELETE /memory/facts/<fact_id>`、`DELETE /context/items/<type>`）；`generation` 是这句的 `turn_generation`；`reason` 是主动台词为什么说（给气泡显示），主动台词都带 `kind`（闸门类别，见 `GET /proactive/mutes`）和 `text`（一句给气泡的「为什么现在说」），主动搭话为 `{"code": "long_dwell", "kind": "comment", "text": "你在这个窗口停了 N 分钟", "activity": 活动标签或 null, "dwell_min": 停留分钟}`，另有 `back`（`away_min`、`before`）、`break`（`minutes`）、`stuck`（`minutes`），`kind` 与 `code` 相同，同一句的每条都带；用户的台词为 null；`remembered` 为 false 时 `history_turns` 不留这一句（这一轮不记，或没有聊天记录库），同一句的每条都带。`final_item_id` 仅角色 agent 回复的 `final: true` 帧携带，为最终答案对应的 `assistant_text` item id，无匹配时为 null，供转录视图去重。 |
| `turn_accepted` | `{seq, line_id, conversation_id, source, trace_id, side}`：agentd 接受一句交给「嘴」的输入（`POST /say`、`POST /conversations/:id/messages`），回 202 之前发，早于这一轮的任何 `line`、`agent_run`；被拒的输入（400、409、503）和确定性命令不发。`line_id` 同 202 的 `line_id`；`conversation_id` 是这一轮所属的对话（同这一轮 `line` 的 `conversation_id`），没有聊天记录库时为 null；`source` 为 `text` 或 `voice`；`trace_id` 同 202 的 `trace_id`；`side` 为 true 表示前台 run 进行中、这句走旁路会话。 |
| `agent_item` | `{seq, run_id, conversation_id, item_id, item_seq, kind, phase, status, name, summary, parent_item_id}`；`conversation_id` 可为 null，`item_seq` 是 item 在该 run 中的 `seq`；`status` 为 `started`、`delta`、`completed`。仅 `assistant_text`、`reasoning_summary` 的 `delta` 帧带 `text_delta`（只带新增文本）；同一 item 每 100 ms 至多一条 delta，completed 前先刷出待发文本。Claude thinking 无文本；commentary 仅供展示，不进入语音和历史；这一轮不记仍发布。 |
| `plan` | `{seq, run_id, conversation_id, revision, title, steps, status, source}`：内核的计划。`revision` 在同一 run 内从 1 递增，每条都带完整计划；`steps` 为 `[{text, status}]`，`status` 为 `pending`、`in_progress`、`completed`，最多 32 步、每步 200 字；`status` 全部步骤完成时为 `completed`，否则 `in_progress`；`source` 为 `codex`（`turn/plan/updated`）或 `task_plan`（每个输出路径一步）。这一轮不记仍发布。 |
| `thought` | `{seq, id, text, offer, reply, reason, at, session_id}`：她的一句第一人称想法（`character/thoughts.py`）。`reason` 为 `started`、`finished`、`needs_input`、`error`（registry 里一个会话开始一轮、做完、等审批或等回话、出错，`session_id` 为它的 `display_session`）或 `activity`（空间轮询看到的现场判断换了活动，置信度不低于规则给的最低档 0.5，`session_id` 为 null）或 `returned`（现场从离开或空闲变为在场，`session_id` 为 null）；`text` 不超过 60 字，`offer` 是一句问用户的建议动作或 null（提示词里对用户的称呼来自角色卡 `user_title`）；有 `offer` 时，`reply` 必须是用户接受建议时以自己口吻说的话，否则为 null；`at` 为本地时区 ISO 时间。用户离开或在放空时不出；生成中收到的触发只留最新一条，结束后（离上一条不足 90 s 时在之后的现场轮询里）照常检查闸门和预算；两条至少隔 90 s，活动和各会话状态都和上一条时一样时间隔加倍，最长 15 分钟，有变化就回到 90 s；每个本地日最多 120 条（只在内存里计数）。闸门类别 `thought`、级别 `P2`：总开关、静音类别、会议、专注、用户说话、全屏、安静时段照常拦下，主动台词的每日次数和冷却不算它。每条经当前内核跑一次 `thought` 语义任务，只发文字，60 s 超时（含排队等语义槽）；调用失败或回复不是 `{"thought", "offer", "reply"}` JSON 时这次没有想法，不重试，等下一次触发。没开网页文字（`page_text`）时只发活动名和会话状态，不发标题、目录名和文字；开了时发 `_attention_context` 的现场摘要和会话目录名，标为观察数据而非指令。agentd 留最近 20 条，`server.thoughts.latest()` 给最新一条，10 分钟后为 null。 |

nudge 的 data：`{seq, nudge_id, kind, level, target, line_id, speak, gate}`。`nudge_id` 是 12 位 hex；`level` 固定 `P2`；`target` 是窗口的 `window_id`，没有时为 null。
- `kind: "alert"`：心跳的 `focus_window.role` 是 `AXSheet`，或 `subrole` 是 `AXDialog`、`AXSystemDialog`，且 `front` 有 `window_id`、没命中黑名单。同一 `window_id` 600 s 内只发一次。`speak` 恒为 false，`line_id`、`gate` 恒为 null：只换表情、指着 `target`，不出气泡、不出声；不过闸门，不占闸门的冷却和每日次数。
- `kind: "comment"`：主动提示开启时，注意力时间线的同一段关注（`focus` bucket 的同一条，换窗口或标题就是新的一段）连续 ≥180 s 时，每段问一次 judge，一次调用两个 yes_no：`want_comment`（现在搭话合适吗）和 `useful`（搭话的内容对用户当前在做的事明显有用吗；问题里的称呼来自角色卡 `user_title`）。judge 的 state 只有 `{category, dwell_min, hour, activity}`（app 类别、停留分钟、本地小时、现场判断的活动标签），不带标题和文字；有 key 时用 Haiku，记在 `<state-dir>/proactive-judge.jsonl`；没有 key 时不问、不发。`want_comment` 答否时不发 nudge。答是时按顺序查，第一条不过的就是 `gate`，`speak: false`、`line_id: null`：`not_useful`（`useful` 不是「是」）、`focus_changed`（问 judge 之后关注换了一段）、`user_speaking`（用户开始说话）、`activity_changed`（现场判断的活动、对象或焦点窗口变了）、`cannot_interrupt`（现场判断不许打断，比如正在连续输入）、`same_subject`（最近 20 次搭话里说过同一对象）；再过闸门（类别 `comment`、级别 `P2`），拦下时 `gate` 为闸门原因；闸门的冷却和每日次数只在这句真出声时才算（第一个分句送 `/speech` 时；没开 TTS、静音或角色隐藏时是末条 `line` 没被取消地发出时），被拦、出错、第一个分句前被取消的都不算；最后占「嘴」：正在出一句或语音还在播时 `gate: "busy"`，空闲时占住并开一句，两者是一步。放行时 `speak: true`、`line_id` 是一句「嘴」的台词，台词照常从 `line` 事件流出、送 `/speech`，不打断别的台词。第一个分句送 `/speech` 前再查一次（同一段关注、同一现场判断、闸门没被会议、说话、全屏、静音时段或总开关拦下）；不过时这句一个字也不出声，`line` 的末条 `cancelled: true`，历史记录为 `cancelled`。`target` 是关注窗口的 `window_id`。没回应退避：一句出声的主动台词说完（语音停了，没语音时是这句出完）后 60 s 内来了 `/say`（文字或语音，说着时来的也算）或 `POST /feedback` `useful` 就算有回应，否则（窗口过了、下一句主动台词出声了、或 `dont_disturb`）算没回应；连续 3 句没回应 `comment` 的同类冷却 ×2，再 3 句 ×4，最多 ×4，有一次回应就回到 ×1；这个倍数再乘她自己状态的系数（`comment_scale()`，精力 < 0.3 ×1.5、投入 ≥ 0.6 ×1.25，最多 ×1.5，小于 1 按 1 算），只加长 `comment` 的同类冷却；`/diag/state` 的 `proactive` 块带 `misses`（连续没回应的句数）和 `factor`（当前倍数），`gate.cooldown_s` 按倍数算，`comment` 的再乘状态系数，和闸门实际用的一致。
- `kind: "back"`：用户回来时（`user_now` 的 `user.return`，一段离开区间只发一次），离开时长取它的 `away_s`。离开期间 registry 里有会话完成（`done`）、出错（`error`），或现在在等审批、等回话且是离开期间进的这个状态，就说一句汇报，只带会话名（`cwd` 的末段，没有时为 `display_session`）和状态，不带会话内容；没有这些时不发 nudge。按顺序查：`cannot_interrupt`（现场判断不许打断）、`busy`；再过闸门（类别 `back`、级别 `P2`，会议、说话、全屏、静音时段照常拦下）；`back` 的同类冷却在这句出声时开始。`target` 为 null。

command 的 data：`{seq, action, target}`，`action` 是 `open` 或 `jump`，由外壳执行。

announce 的 data：`{seq, ts, level, kind, headline, project, session_id, detail, origin, speak, gate, state, trace_id}`。`origin` 每条都带：公告自己的 `origin`，没有时为 `session_id` 所属自有会话的派活卡 `request_id`，都没有时为 null。`trace_id`是这条播报来源的决策 trace（`GET /trace/turns/<trace_id>`）：按 `origin`，没有 `origin` 时按 `session_id` 所属自有会话的派活卡 `request_id`，找到这张卡还开着的决策 trace（`dispatch.*`、`approval.*` 事件所在的那条）；找不到时为 null。派活卡自己的结局没有会话，`session_id` 为 null，另带 `origin`（卡的 `request_id`）：`dispatch_closed`（`P2`，卡过期了、没开始）和 `dispatch_failed`（`P1`，允许后会话没能建起来）。自有会话的 kind 见 `POST /say` 与 `POST /sessions`：`dispatch_done`（验证通过）、`dispatch_review`（没有验证命令，待你确认）、`dispatch_failed`（验证没过或第一轮失败）、`session_failed`。启动时每个被重启截断的任务（`GET /tasks`）发一条，带 `origin`（任务的 `task_id`），`session_id` 为任务的会话（还没开会话时 null）：卡没批或批了还没开始为 `task_expired`（`P2`，「「<标题>」没开始就过期了」），在跑、已返回待验证或在验证为 `task_interrupted`（`P1`，「「<标题>」被重启打断了」）。提醒（`POST /say` 的「提醒我…」）的三种都带 `origin`（提醒的 `id`），`project`、`session_id`、`detail` 为 null：记下时 `reminder_set`（`P0`，「好，<HH:MM>提醒你<事>。」，不是当天时为「明天 <HH:MM>」，本地时区）；到点时 `reminder_due`（`P0`，「提醒你：<事>」，同一个 tick 到点的几条合成一条，事之间用「；」分隔，`origin` 是第一条，另带 `commitment_ids`：合进来的每条提醒的 `id`，顺序同 `headline`）；启动时每条被重启错过的（过点超过 600 s 还没播，或播到一半被重启截断）一条 `reminder_missed`（`P1`，「错过了提醒：<事>（原定 <HH:MM>）」）。`state`为 `terminal`（`dispatch_done`、`dispatch_review`、`dispatch_failed`、`dispatch_closed`、`session_failed`、`agent_failed`、`mmrun_done`、`task_expired`、`task_interrupted`、`reminder_set`、`reminder_due`、`reminder_missed`：报的事已结束）或 `progress`（其余 kind）。`speak` 为 false 时只出卡片或换表情，不出声、不弹气泡；`gate` 是拦下的原因（`disabled`、`meeting`、`user_speaking`、`fullscreen`、`quiet_hours`、`daily_limit`、`same_cooldown`、`cross_cooldown`），放行时为 `null`。`speak` 只表示闸门放行，不表示真的出声。`speak` 为 true 且开了 `--tts-url`、没静音、角色没隐藏（`PUT /avatar/visibility`；隐藏时只出卡片，也不进槽）、不在退出时，agentd 把 `headline` 送去合成，走和「嘴」的台词同一条 `/speech`，`turn_id` 为 `announce-<seq>`；上一句（台词或播报）还在合成或按估算还在播时，只有 P0 播报会打断它（上一句以 `superseded` 结束），其余级别的播报放进自己的槽等语音停下。槽按 `session_id` 分（账本行的 `session_id` 是某个自有会话的 CLI 原生会话 id 时，按那个自有会话的 `own:…` 分，和它的派活播报同一个槽），它为 null 时按 `project`，都为 null 时按 `kind`；每个槽只留最新的有效状态：新的 `progress` 换掉槽里的 `progress`，`terminal` 换掉槽里的任何一条，`progress` 不换 `terminal`。一个槽的 `terminal` 进了槽或出了声之后 15 s 内，同一个槽后来的非 P0 `progress` 只出卡片，不出声也不进槽；自有会话经 `POST /sessions/<id>/messages` 开始新的一轮时提前解除。P0 出声时清掉同一个槽。语音空闲、没静音、角色没隐藏、不在退出、重置或 换角色时，每个 tick（约 0.1 s）播一条最早进槽的；进槽 15 s 还没播的悄悄丢掉；新的 `/say`（文字或语音）、插话（`barge_in`）和 `POST /reset` 清空所有槽。插话打断播报只停语音，不打断、不停止任何会话或派活。闸门的总开关默认开，`--no-proactive` 关掉；安静时段 22:00–08:00，同类冷却 600 s，跨类冷却 30 s，每天 20 次；`P0` 不受闸门限制。`level` 是 `P0`、`P1`（失败）、`P2` 或 `done`；`project` 为 null 或会话的项目。harness 账本（`--ledger-root`，默认 `~/.claude/harness/events`）只给日程分段和日报计数读，不播报：子 agent 撞门禁、被拒、被守卫拦下由 harness 自己处理。

`event: request` 的 data：`{seq, request_id, window_id, mode: "text"|"ocr"|"image", reason}`。`reason`：`low_ax_text`（AX 文字少于 200 字且内容变了，要本地 OCR）、`next_check`（judge 定的复查时间到了）、`judge`（judge 要看图）、`look`、`look_window`（`POST /say` 的 `look_window`：那个窗口的文字，读不到时它的图）。窗口已关就丢掉请求。

### 4.5 决策记录

闸门、两个 judge（主动说话、截图）、行为 tick、审批 broker、派活、主动台词的反馈各写 `gate.decided`、`judge.decided`、`behavior.ticked`、`approval.*`、`dispatch.*`、`proactive.feedback` 进 trace（`GET /trace/decisions`）；同一件事（一张审批卡或派活卡的 `request_id`、一次主动搭话）的几条在同一个 trace 里按因果串起，主动搭话的 judge、闸门和随后那句台词的 `input.received`（`source: proactive`）同一个 trace；原生框先答（Claude 断开 hook）记 `approval.decided` `by: native`，超时、工具事件、会话结束撤卡记 `approval.retired`。`behavior.ticked` 带 `{options, chosen, mood, reason}`，有角色状态时再带 `state`：她的精力、心情、投入的档位（`{energy, mood, engagement}`，只有档位，没有数值）。

### 4.6 hook

PermissionRequest 的响应：
- Claude：有决定时 `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`；`allow_session` 时 `decision` 为 `{"behavior":"allow","updatedPermissions":[...]}`，取 hook 输入 `permission_suggestions` 里的 `addRules`（`behavior: allow`）、`setMode`（只认 `acceptEdits`）、`addDirectories`，`destination` 一律改成 `session`（只在内存里，不写设置文件），其余丢掉；无决定时 `{}`，原生审批框照常出现。
- Claude 带请求头 `X-Agentd-Observe: 1`（转发器的 `--observe`，`tools/install_hooks.py` 装的 hook 都带）：和 Codex 一样不开卡、不阻塞，立即 `{}`，会话照样进 awaiting_approval，原生审批框照常出现。不带这个头时不变（示例配置和自有会话照样出卡）。
- Codex：不开卡、不阻塞，立即 `{}`；会话照样进 awaiting_approval，之后的 PostToolUse 等事件把它带走。`codex_hook_forward.py` 什么都不打印、退出 0，Codex 按自己的审批配置继续（原生框或自动审查）。

焦点优先级：error > awaiting_approval > awaiting_input > running_tool > thinking > compacting > subagent > done > stale > idle；同优先级保持当前焦点。PerformanceIntent 的 `intent` 取 §1「intent 枚举」。

撤卡：原生审批框与卡片并行，先答者赢；以下情况 agentd 撤掉待决卡片，hook 按"无决定"返回，会话回到 thinking（连接被关闭时回到 awaiting_input）：
- 同会话、同 agent、同工具、同 `tool_input` 的 PostToolUse / PostToolUseFailure，且只匹配到一张卡（多于一张时等截止时间）；
- 主 agent 的 Stop / StopFailure / Interrupt 撤主 agent 的卡，SubagentStop 撤该子 agent 的卡，SessionEnd 撤整个会话的卡；PermissionRequest 的 hook 连接被对端关闭时撤这一张。

去重：完全相同的 Stop payload 第二次到达，或已结束回合（`turn_id`，Claude 用 `prompt_id`）里完全相同的 PermissionRequest 再次到达，视为重放，直接返回、不开卡、不改状态，`outcomes` 记 `replay_dropped`。主 agent 的 PostToolUse / PostToolUseFailure 若属于已结束回合，只更新最后事件时间，不改状态。

顺序：事件的时间是转发器启动的时间 `agentd_started_at`（不晚于到达时间；没有或不是有限数时用到达时间）。安装的 hook 都在后台跑，先触发的可能后到；比会话最后一个事件早的事件到达时什么都不改（例如 PostToolUse 先到、它的 PreToolUse 后到，会话停在 thinking）。

#### 会话来源

http 型 hook 读不到环境变量和 tty，所以来源由命令型 hook 的转发器 `codex_hook_forward.py` 采集，放进转发的 JSON 的 `agentd_origin`：

- `kind`：有 `$TMUX` 为 `tmux`；`CLAUDE_CODE_ENTRYPOINT=claude-desktop` 为 `desktop`；能打开 `/dev/tty` 为 `terminal`；否则 `unknown`。
- `term_program`＝`$TERM_PROGRAM`，`tty`＝控制终端（`/dev/ttysNNN`），`tmux_pane`＝`$TMUX_PANE`，`tmux_socket`＝`$TMUX` 逗号前的部分，`pid`＝hook 进程的父进程。
- `entrypoint`＝`$CLAUDE_CODE_ENTRYPOINT`，`bundle_id`＝`$__CFBundleIdentifier`（区分同样报 `TERM_PROGRAM=vscode` 的 VS Code、Cursor 等），`wezterm_pane`＝`$WEZTERM_PANE`，`kitty_window_id`＝`$KITTY_WINDOW_ID`，`kitty_listen_on`＝`$KITTY_LISTEN_ON`；没设的变量为 null。在 tmux 里 `term_program` 是 `tmux`，外层终端由外壳找。可靠性：`__CFBundleIdentifier` 只在由 macOS 图形界面启动的应用及其子进程里有（ssh 登录、launchd 启动的没有）；`KITTY_LISTEN_ON` 只在 kitty 配了 `allow_remote_control` 和 `listen_on` 时才有；`WEZTERM_PANE` 由 WezTerm 给每个 pane 设置。
- 转发器同时放进 `agentd_started_at`：它启动时的 Unix 时间（秒，浮点），agentd 拿它给事件排序（见 §4.6「顺序」）。
- Claude：示例配置把 `UserPromptSubmit` 改成命令型 hook（`--endpoint /hook/claude`），其他事件仍是 http；同一事件只配一个 hook，不会重复上报。Codex 本来就全是命令型。
- 编码会话的完整 live-hook 证据（工具输入、工具输出、结果、最后一条助手消息）由独立同意项 `agent_sessions` 控制：Companion 的 `share_agent_sessions` 默认开，启动时传 `--share-agent-sessions`；保存配置缺少此键按默认开，显式关闭则不采集。证据在本机保存 48 小时，不读取原生会话文件。人类或来源未知的 `UserPromptSubmit` 提问须同时允许 `agent_sessions` 和 `typed_text`；会话预览进入观察证据时也遵守这两个范围。撤回 `agent_sessions` 走与撤回 `typed_text` 相同的观察失效路径，删除已存 live-hook 证据和派生摘要。
- `UserPromptSubmit` 在活动时间线里的提问预览：启用 `coding_sessions` 插件且同意项 `agent_sessions`、`typed_text` 均为真时保留正文。agentd 往 `attention.sqlite` 的 `events_raw` 写一行 `kind='prompt'`（`app` 为来源 `claude`/`codex`，`doc` 为 cwd，`value` 为获准保留的 `prompt` 前 500 字，否则为 null，`value_len` 为全长），保留 48 小时；`prompt` 不是字符串或为空时不写。会话登记和 `/feed` 都不带正文。
- 转发器 HTTP 超时默认 3 s（`--timeout`，安装器给 0.8 s），查 tty 的 `ps` 最多等 0.2 s：agentd 没开（连接被拒）时立刻退出，卡住时整次约 1 s 内结束。任何失败（token 文件缺失或读不了、stdin 不是 JSON、回复不对）都不打印、退出 0，不挡会话。agentd 只保留形状正确的字段（`tty` 必须以 `/dev/` 开头，字符串最长 256）。

### 4.7 语音中继

启动时给 `--tts-url`（TTS 主机上的服务，例如经 `ssh -N -L 19888:127.0.0.1:9888 <主机>` 后的 `http://127.0.0.1:19888`）才开。「嘴」的一句台词正常结束、没出错、没被打断、没静音时，agentd 把去掉标记的文本 POST 给 TTS 主机的 `/speech_stream`（不超过 50 字时是全文；更长时只送第一句，第一句也超过 50 字时截到 50 字内最后一个「，」，没有逗号就截到 50 字；`/feed` 的文字仍是全文）（`character`、`language` 取当前角色卡的 `tts`；`allow_unvalidated_pilot=true`、`accelerated=true`、`expires_at_ms` = 现在 + 120 s），收到的每行只改写 `session_epoch`（registry 的 epoch，字符串）和 `turn_id`（= 这句的 `line_id`）后原样转发到 `GET /speech`。同一时刻只有一条语音：新的 `/say`、「停下」、「静音」会先结束当前语音；被 agentd 截断或上游断开的流，由 agentd 补一行 `cancelled`（`superseded`、`client_cancel` 或 `error`，`seq` 接着上一行，`last_sample_sent` 是已转发的样本数）。角色进程读到 `speech.begin` 的 `turn_id` 与当前不同时，先按新的 epoch / turn 重置时间轴再应用。请求带 `Authorization: Bearer <令牌>`，agentd 通过 C10 的凭据引用读取系统保存的令牌。用 `tools/tts_token.py push --ssh user@host --remote /srv/agentic-complex-tts/state/tts-token` 可经 SSH 标准输入复制到 TTS 主机。TTS 在发出任何行之前就失败（401、500、连不上）时 `/speech` 上什么都没有，agentd 在 `/feed` 发 `speech_failed` `{speech_id, reason}`（`reason` 为 `http_<状态码>`、`unreachable`、`bad_stream` 或 `empty_stream`），说话状态随即释放；这次失败也记进 `/diag/state` 的 `mouth_voice.speech_failed` 和 `connections.tts`。连不上（5 s 内没接受连接也算；ensure 之后仍然如此）也按这样的失败处理：这一句只出文字，不改发到别的 TTS 地址。

### 4.8 行为 tick 与空间行为

行为 tick（`character/behavior.py`）：intent 事件每条都带 `activity`（`idle`、`relax`、`fidget`、`think`、`wait`、`react`、`yawn`、`sleep`、`fly`、`guard`）和 `mood`（`normal`、`happy`、`sad`、`surprised`），还没选过时为 null；活动或心情变了就发一条新的 intent 事件，焦点字段照旧。`emotion` 仍是 `{v, a, d}`，和 `mood` 无关。有角色状态时：心情比基线高 0.2 以上，持续活动的 `mood` 为 `happy`（`sad` 只来自失败的 `react`）；精力低于 0.35 时任何钟点都能 `yawn`（仍 30 分钟一次），离开 300 s（平时 600 s）就 `sleep`；给模型的提示末尾带她的精神和心情档位，不带数值。

空间行为（`observation/spatial.py`，C1 v2）：另一个循环每 1 s 看一次事件，每 60–120 s（均匀随机；她精力低于 0.35 时 ×1.5，即 90–180 s）做一次随机 tick，只发当前能做的活动，`/events` 上是 `event: behavior`（`behavior_id` 为 `b-<registry epoch>-<n>`，`turn_generation` 取当前值，每个行为一个新的 T1 `trace_id`）。按下表从上往下取第一条成立的：前台全屏且 `fullscreen_give_way` 开 → `idle`（`priority` 3，`trigger` session / `fullscreen`；这时不做随机 tick）；用户在说话 → `listen`（目标 user，2）；嘴在生成或说一句 → `think`（2，`turn_id` 是这句的 line_id）；现场判断为 `typing` → `accompany`（user / `typing`，2）；焦点会话 `awaiting_approval`、`error`、`done` → `attend_session`（1，目标的 `window_id` 是焦点窗口，只在这个会话属于现场判断的 `related_session_ids` 时给，否则 null）；焦点会话在思考、跑工具、压缩或有子 agent → `accompany`（1）。条件一变就立刻发，同类型、同目标、同触发的不重发；`accompany`、`sit` 到期前 30 s 条件还成立时续期（`replaces` 指向旧的）。随机 tick 在 `idle`、`observe`、`short_walk`、`sit`、`hold_window_edge`、`climb_window_top` 里选（`priority` 0，`intensity` 0.4–0.7、精力低于 0.35 时 0.4–0.5，1–3 分钟，`sit` 10 分钟；类型按角色状态的权重抽：困时少走动、多坐和待着，精神很好或心情好时多走动和看；她对正在跑的随机行为投入 ≥ 0.6 时这次 tick 不换；现场判断的 `activity` 为 `reading` 时，有焦点窗口且 `observe` 能做就直接看焦点窗口，不再抽；为 `switching` 或 `meeting` 时这一轮不出 tick，下一轮照常排），`short_walk` 两次之间隔 180–600 s（随机短走先按 walk 偏好 more ×0.5、less ×2、stay 不发，再按精力：低于 0.35 ×2、高于 0.7 ×0.8，状态不会让 stay 发短走），开关禁止的不选，要窗口的在没有焦点窗口时不选，`blocked` 过的目标 60 s 内不选，会被更高优先级的在跑行为挡住的不选。用户打字时不发 `short_walk`、`climb_window_top`，所有行为 `intensity` ≤ 0.3，`exit` 含 `user_typing` 的在跑行为被下一个行为替换。和在跑行为占同一身体通道时 `replaces` 指向它，否则为 null、两个一起跑；一次取代几个时，`replaces` 指向续期的那个（没有就是最后发出的那个），其余每个在新行为之前各发一条 `behavior_cancel` / `replaced`；`priority` 比新行为高的不进 `replaces`（角色进程会回 `rejected` / `busy`），一律先发 cancel。结束条件（C1 v2 §1 `exit`）里 agentd 判断五个：每次轮询在上面的事件、tick、续期之后查一遍在跑的行为（这次刚被替换的不算），`exit` 里有一个成立就发 `behavior_cancel` `{seq, behavior_id, reason: "exit", condition, turn_generation}`，`condition` 是 `exit` 里第一个成立的，一个行为只发一次。「有声」指用户在说话（心跳的 `user_speaking`）或中继有语音没播完（分句在合成、排队，或按 角色进程回执、估算还在播）。`speech_start`：行为开始后某次轮询无声、现在有声；`speech_end`：开始后某次轮询有声、现在无声；`session_state`：焦点会话或它的状态和行为自己的（`display_session` 和 `trigger.event` 的 `session_state:<state>`）不同；`focus_change`：焦点窗口号和发出时不同（心跳停了或用户进入 AFK 5 s 以上时窗口号为 null，也算变了），全屏让开的 `idle` 在全屏关掉时也算；`user_typing`：现场判断为 `typing`。`user_drag`、`target_gone` 和到期由 角色进程判断，agentd 不发。条件成立后那一行事件若仍成立（比如换了焦点窗口还在打字），不重发，等事件行变了才发。从现实里发生到发出 cancel（轮询间隔 1 s，Companion 心跳每 1 s 一条，`activity()` 每次现算、不缓存）：会话状态 ≤ 1 s（hook 到了之后；外部会话的 `done` 约 4 s 后自己回到 `idle`）；角色的语音 ≤ 1 s（中继状态一变；开始算在分句送去合成时，比真出声早，结束算在 角色进程回执播完或估算播完时）；用户说话 ≤ 2 s；焦点窗口 ≤ 2 s（鼠标停在别的窗口上、5 s 没有键鼠输入时焦点算鼠标下的窗口；心跳停了或进入 AFK 之后 ≤ 6 s）；打字 ≤ 2 s，前提是用户已连续活跃（键鼠闲置不到 180 s、心跳不断）≥ 60 s，离开或心跳断了 5 s 以上之后要再活跃 60 s，即 60–62 s；打字规则排在 `editing_code` 前，在编辑器里连续输入也算打字，现场判断先命中更前的规则（如等审批、构建失败）时不算。agentd 认为一个行为结束于：终态回执、`expires_at_ms` 到了、被替换、被开关撤销、结束条件成立、换角色（`POST /character/prepare`；之后仍成立的事件行在下次轮询重发）。intent 事件的 `activity`、`mood` 照旧。
- 每 5 s 本地看一次情境（时段、焦点会话状态、待批数、在不在电脑前、前台 app 的类别，以及 guard、fly 是否成立）；情境变了、满 90 s、或派出的会话刚完成或失败时重新挑。情境里只有状态、计数和类别，没有窗口标题和文字。现场判断取空间行为最近一次 `activity()` 的结果：`activity`（开会即 `meeting`）和 `holds` 里的 `fullscreen`；开会、打字取 `user_now` 的 `doing`、`typing`（没有键鼠计数时 `input_active`）。
- sleep（AFK ≥10 min）、wait（有待批）、guard（现场判断为 `gaming` 且用户在用电脑）、fly（焦点会话连续在跑 ≥ 20 s，用户在用电脑，且不在开会、全屏或连续输入中）、think（焦点会话在跑）这类有硬条件的活动由规则定，不问模型；顺序是 sleep、react、wait、guard、fly、think，取第一条成立的。fly 还差 20 s 时是 think；条件有一条不再成立，下一次检查就换掉 fly。「连续在跑」从这 5 s 检查第一次看到焦点会话在思考、跑工具、压缩或有子 agent 时算起，看到别的状态就重来。其余时候也由规则定（`Behavior` 不接模型后端）。
- 一次性活动（`fidget`、`react`、`yawn`）在说话（`/speech` 在合成或按估算在播）时不发，下个 tick 再挑；同一个一次性活动不连发；`fidget` 只在当前是 `relax` 时发。角色进程不认识的 `activity` 按 `idle`，不认识的 `mood` 按 `normal`。
