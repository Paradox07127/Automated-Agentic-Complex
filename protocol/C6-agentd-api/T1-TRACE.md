# T1 Trace 事件格式 v1（C6 的一部分）

> 正文里的「Avatar」「player」指角色进程，现由渲染器 `private/renderer/host`（私有组件，不在公开仓库）实现。

「日志与 Trace」窗口和调试读同一份事件，不解析日志。校验脚本：`agent/agentd/traces/trace_format.py <file.ndjson>`；样例：`agent/agentd/tests/trace-sample.ndjson`（打字一轮，从输入到渲染器播放结束，含一个被闸门拦下的主动触发）。

**事件**：一个 JSON 对象。agentd 存进本机 SQLite 表 `trace_events`；转发和导出用 NDJSON，一行一个。

| 字段 | 类型 | 含义 |
|---|---|---|
| `v` | 整数 | 1 |
| `event_id` | UUID 字符串 | 产生方生成，全局唯一 |
| `trace_id` | UUID 字符串 | 一次根输入（打字、语音、主动触发、播报事件）一个；它派生的观察、模型调用、语音、播放都带同一个 |
| `turn_id` | 字符串或 null | 对话轮次；没有轮次的事件为 null |
| `turn_generation` | 整数 ≥ 0 或 null | 与 `turn_id` 同时为 null 或同时有值 |
| `span_id` | 16 位小写十六进制 | 本事件所属的段；段开始和段结束事件用同一个 |
| `parent_span_id` | 同上或 null | 瀑布图的上一层 |
| `causation_id` | UUID 或 null | 直接引起它的那条事件的 `event_id`；根输入为 null |
| `producer` | 枚举 | `agentd`、`companion`、`avatar`、`tts`。日志窗口的「组件」筛选取这四个值。v1 里 `tts` 段由 agentd 的转发器按 C2 行代写，`producer` 仍填 `tts` |
| `producer_epoch` | 整数 ≥ 1 | 产生方进程每启动一次加 1（agentd 用 registry epoch） |
| `seq` | 整数 ≥ 1 | 同一 `producer`+`producer_epoch` 内严格递增，不重复 |
| `kind` | 字符串 | 见下表 |
| `t_wall` | 字符串 | 墙钟，ISO 8601，毫秒，带时区：`2026-10-19T09:12:03.418-04:00` |
| `t_mono_ms` | 整数 ≥ 0 | 产生方自己的单调钟 |
| `t_recv_wall` | 字符串或缺省 | 只由 agentd 在收到远端事件（`POST /trace/events`）时加，格式同 `t_wall`；产生方不填 |
| `duration_ms` | 整数 ≥ 0 | 只在段结束事件上出现，且必须有（段结束事件见下表「结束」列） |
| `status` | 枚举 | `ok`、`blocked`、`failed`、`cancelled`、`expired`、`unknown` |
| `attrs` | 对象 | 按 `kind` 定；必有的键见下表，可多带。文本值一律写成 `{"len": 字数, "head": 前 8 个字}` |
| `text` | 对象或缺省 | 只在本机存储和 `with_text=1` 的回包里出现：`{"attrs 里文本值的键": 全文}` |

**kind 与必有 attrs**（「结束」= 段结束事件，带 `duration_ms`）：

| kind | 必有 attrs | 结束 |
|---|---|---|
| `input.received` | `source`：text / voice / proactive / announce / ritual / gift / tap / background；`text`（文本值，可为 null）。后台运行使用自己的 run ID，无任务正文 | |
| `context.assembled` | `items`：列表，每项 `{type, observation_id, at}`，`type` 取 window_text / page / selection / view / sessions / memory / lore / approvals / activity；`lore` 项的 `observation_id` 是条目 id，另带 `reason`：`key:<触发词>`、`alias:<别名>` 或 `sticky` | |
| `observation.requested` | `request_id`、`mode`：text / ocr / image、`purpose`：current / recall、`window_id` | |
| `observation.settled` | `request_id`、`state`：ready / declined / unavailable / expired / cancelled / failed | 是 |
| `egress.checked` | `result`：pass / blocked、`category`（拦下的文本类别，通过时 null）、`redactions`（整数） | |
| `model.started` | `model`、`call`：judge / behavior / vision / capture_judge / eval / character_agent | |
| `model.first_token` | — | |
| `model.finished` | `model`、`input_tokens`、`output_tokens`、`stop_reason`；可选 `cached_tokens`、`reasoning_tokens`（整数）、`cost_usd`（≥ 0 的数，harness 估的这次运行花费），harness 报了才带，没报不带 | 是 |
| `tool.started` | `tool`（工具名）、`call_id`（本轮不透明标识）。仅 agentd 发出 | |
| `tool.settled` | `tool`、`call_id`、`outcome`：completed / failed / waiting_user，`error_code`（可为 null）。参数、结果正文不进入 trace。仅 agentd 发出 | 是 |
| `turn.settled` | `state`：completed / failed / cancelled / interrupted / waiting_user，`error_code` 和 `outcome`（均可为 null）。`error_code` 是 agentd 或 harness 自己的错误码；异常归为 `timeout`、`auth_expired`、`rate_limited`、`network`、`cli_exit_<n>` 或 `unknown`（`agent/agentd/daemon/error_record.py`）。`failed` 时另带 `error_message`：异常类名或原错误码，不含正文。这是本轮处理终态，播放是否完成仍由宿主回执决定。仅 agentd 发出 | 是 |
| `line.parsed` | `line_id`、`intents`（列表）、`target`（null 可）、`first_sentence_only`（布尔）、`text`（文本值） | |
| `motion.published` | `motion_id`、`behavior_id`、`total_ms`（从动作标记到发出 `perform` 的毫秒数；另有 `generate_ms`、`retarget_ms`）；由 `[motion:]` 标记来的另带 `prompt`（文本值，标记里的英文文字；「这一轮不记」时不带） | |
| `motion.fallback` | `reason`：no_service / ensure_failed（按需启动没起来）/ timeout / replaced / 服务的错误名 / `<阶段>_failed`；生成后端没发出 `perform`，这句台词只用角色包动作；由 `[motion:]` 标记来的另带 `prompt`（文本值，同上）；几何请求（`POST /motions/generate`）的步骤用由 request_id 派生的 UUID 作 trace_id，没有 `prompt`，失败时另发 `ok:false` 的 `event: motion` | |
| `motion.matched` | `action_id`（配到的角色包动作 id）、`group`（短语表的组名）、`length_s`（动作原长，秒）、`seconds`（标记里的秒数）、`prompt`（文本值，同上）；`[motion:]` 的文字配到当前角色的角色包动作，发了带 `action` 的 `perform`（C1 v2.6），没调动作服务 | |
| `speech.requested` | `speech_id`、`line_id`、`clause_id`（null 可）、`text`（文本值） | |
| `speech.first_audio` | `speech_id`、`clause_id` | |
| `speech.finished` | `speech_id`、`clause_id`、`total_samples` | 是 |
| `playback.started` | `speech_id`、`clause_id` | |
| `playback.ended`、`playback.interrupted` | `speech_id`、`clause_id`；interrupted 另有 `reason`、`planned_ms`（这一段按计划要播的毫秒数，不知道写 null）。播放失败记 `playback.ended`、`status=failed`；`playback.interrupted` 只用于被打断（C3 playback 回执的 `state=failed` 不受影响） | 是 |
| `playback.buffering`、`playback.resumed` | `speech_id`、`clause_id`（渲染器缓冲不足停住、再接着播；成对，可以多次） | |
| `playback.degraded` | `speech_id`、`clause_id`、`reason`（例如 PCM 长度和 `total_samples` 不符；不结束这段语音） | |
| `motion.started` | `behavior_id`（渲染器本地触发的动作写 null）、`clip` | |
| `motion.ended` | `behavior_id`（同上）、`clip` | 是 |
| `cancel.requested` | `by`：ptt / text / stop_command / supersede / character_switch / system；`target`：turn / speech / observation / dispatch | |
| `cancel.acked` | `target` | 是 |
| `gate.decided` | `kind`、`level`、`speak`（布尔）、`reason` | |
| `judge.decided` | `backend`：rules / character_agent，`answers`（列表 `{id, value, prob}`）；判断失败时 `answers` 为空并带 `failure_reason`（安全原因代码） | `status=ok` 表示判断已产生；`status=failed` 表示判断失败，这次主动决策跳过，不用规则补答。 |
| `behavior.ticked` | `options`（列表）、`chosen`、`reason` | |
| `behavior.dispatched` | `behavior_id`、`behavior_type`（动作指令发出）。角色工具发出的动作与发起轮次使用同一个 trace ID | |
| `behavior.receipt` | `behavior_id`、`behavior_type`、`phase`、`reason`（可为 null）。只记录 agentd 接受的 C1 宿主回执，不推断上屏画面 | |
| `behavior.refused` | `behavior_type`、`trigger_source`、`trigger_event`（可为 null）、`priority`、`channels`（列表）、`reason`：admit 的理由（stale / unsupported / switch_off / lifted / stage / typing / speech / posture / busy）或 `user_play`（用户自己的播放占着基础层）。agentd 的一个行为提议没有发出。仅 agentd 发出 | |
| `signal.changed` | `source`：coarse / content / pointer / attention / present / touch / override / pause；`key`；`value`：布尔、数或一个枚举词（小写字母开头，只含小写字母、数字和 `_`，≤ 32 字；不知道写 `unknown`），不写用户文字、窗口标题、应用名、网址；`revision`（user_now 的 revision，没有为 null）。只在判断出的值变了时写，不按采样写。仅 agentd 发出 | |
| `stage.changed` | `from`、`to`：offstage / quiet / normal / engaged；`revision`（这次变化的 user_now revision）。仅 agentd 发出 | |
| `motion.chosen` | `clip`、`why`（选择器给的理由）、`layer`：base / overlay，这次选择没提出 `perform` 时为 null；`behavior_id`：播它的行为，被拒或没有行为播它时为 null；`t_s`（选择器时钟上的秒数）。选择器的每次选择一条。仅 agentd 发出 | |
| `motion.state` | `origin`：agent / local / user，`phase`：started / cycle_end / ended / expired / rejected，`clip`，`behavior_id`（null 可）；agentd 收到的 C3 规则 54 `motion_state`。仅 agentd 发出 | |
| `proactive.feedback` | `line_id`、`value`：useful / dont_disturb（`POST /feedback`） | |
| `dispatch.proposed`、`dispatch.decided`、`dispatch.failed`、`dispatch.finished` | `request_id`；decided 另有 `decision`；failed 另有 `error`（异常类名，派活没能开始，不结束）；finished 结束 | finished |
| `approval.opened`、`approval.decided`、`approval.retired` | `request_id`、`tool`；decided 另有 `decision`、`by`：card / native；retired 另有 `reason` | decided、retired |
| `trace.dropped` | `count`、`since`（ISO 8601）：超出每日上限后丢掉的事件数 | |
| `ui.submitted` | —（`producer`=companion；用户按下发送） | |
| `ui.ack` | —（`producer`=companion；本地可见反馈出现） | |
| `ui.first_text` | —（`producer`=companion；第一条带文字的 `line` 到达 Companion，气泡和字幕条从这里开始显示；对话页按 `assistant_text` 增量显示，比它早） | |

不在表里的 kind 校验报错；加 kind 时同时改本表和 `agent/agentd/traces/trace_format.py`。

**时间**：先后以 `causation_id` 和同一产生方内的 `seq` 为准；同一产生方内用 `t_mono_ms` 算间隔。跨产生方摆位置时，agentd 用每批的 `t_recv_wall − t_wall` 估各产生方的时钟偏差，修正后排，瀑布图标出误差范围。不把接收顺序当执行顺序（Companion 按批转发）。

**日志行**：agentd 处理一轮（打字、语音、主动、后台运行）期间写进 `agentd.log` 的行，末尾带 ` trace_id=<这一轮的 trace_id>`，运行记录的日志页据此标出轮次；缩进的续行（traceback 的栈）和不在轮内的行不带。

**存储与上限**（agentd 定）：
- `text` 列不加密。它和 `attention.sqlite` 里的选区、网页正文同级：只在本机，库文件 0600、state dir 0700，保留 7 天，和注意力记录一起清空。理由：密钥只能放在同一个 state dir，挡不住能读这个目录的进程；整盘加密交给 FileVault。
- 单条事件的每个全文值截到 4000 字。
- 每个本地自然日到达 50,000 条后，仍保留每轮输入、决策和终态（`input.received`、`gate.decided`、`judge.decided`、`behavior.ticked`、`dispatch.*`、`approval.*`、`egress.checked`、`cancel.*`、所有「结束」事件，以及 `status` 不是 `ok` 的事件）。其余丢掉，每满 1,000 条或跨日时写一条 `trace.dropped`。

**隐私**：
- 端点默认只回 `{len, head}`。短于 8 个字的文本，`head` 就是全文；它只出现在本机端点（ui token），导出时照样删掉。带 `with_text=1` 且用 ui token 才回 `text`。`events_token` 不能读 `/trace/*` 和 `/diag/*`。
- 导出默认去掉 `text`，并把 `attrs` 里所有 `{len, head}` 的 `head` 递归删掉，只留 `len`。带文本导出要用户在界面上二次确认。

**端点**（ui token）：
- `GET /trace/turns?since=&limit=&source=&result=&turn_id=&trace_id=`：每轮一行。后两项按标识精确查询。每行带 `conversation_id`：留存的对话记录里拥有这一轮的对话，无记录时为 null。每行包含 `turn_state` 和 `turn_outcome`，尚无 `turn.settled` 时均为 null。
- `GET /trace/turns/{trace_id}`：这一轮全部事件，按上面的时间规则排好。
- `GET /trace/decisions?kind=&since=`
- `GET /trace/events?since=&until=&kinds=&limit=&cursor=`：所有 trace 在这段时间里的事件，按存入先后、旧的在前，每页 ≤ 200 条，`cursor` 接着读下一页；文本只回 `{len, head}`。
- `GET /diag/state`：诊断页的九个区块（这一轮、嘴和声音、闸门、主动说话、观察、身体、会话、预算、连接），每块带 `updated_at`。
- `GET /diag/stream`：SSE，推快照变化和新事件；按 `Last-Event-ID` 续，cursor 过期回 `event: reset`。
- `POST /trace/events`：body `{"events": [...]}`，每批 ≤ 200 条，`producer` 只能是 `companion` 或 `avatar`。回 200 `{"accepted": n, "rejected": [{"index", "error"}]}`；超 200 条 413。

---

**动作线**（agentd）：一条 trace 可以按输入、舞台、决策、渲染器反馈几条线并排读：
- 每条 `signal.changed` 开一条自己的 trace，`causation_id` 为 null；同一次 user_now 变化里的 `stage.changed` 接在这次最后一条 `signal.changed` 的 trace 里、由它引起，这次没有别的值变时自开一条。
- 决策事件（`motion.chosen`、`behavior.refused`、`behavior.dispatched`）指向它读到的最新输入事件：`signal.changed`、`stage.changed`，或渲染器自己挑的反应和用户自己的播放（`origin` 为 local / user 的 `motion.state`），并进那条输入的 trace。选择器自己的一拍和她自己的日程（随机一拍、作息、受阻后另选、焦点走动）各开一条 trace，`causation_id` 为 null。
- `behavior.dispatched` 指向它播的那次 `motion.chosen`；选择器选的片段被拒时 `behavior.refused` 指向它的 `motion.chosen`；续期指向被续的那个行为的 `behavior.dispatched`。`motion.state` 和 `behavior.receipt` 写在它那个行为的 trace 里；`motion.state` 指向那个行为的 `behavior.dispatched`，不知道是哪个行为时自开一条 trace。
- 带轮次 trace 的提议（`think`、角色工具的 `face`）不写 `behavior.refused`、`behavior.dispatched`，由那一轮自己记。
- 同一个拒绝（`behavior_type`、`trigger_event`、`reason` 都相同）连着出现、中间没有别的动作线事件时只写第一条：身体被占着时基础循环每秒重试一次，每次都被拒。
- 每日上限之后 `signal.changed`、`stage.changed` 和输入一样保留；`motion.chosen`、`behavior.refused`、`behavior.dispatched`、`motion.state` 照常丢。
- `behavior.receipt` 指向它那个行为的 `behavior.dispatched`；那个行为没写 `behavior.dispatched`（带轮次 trace 的提议）或它被每日上限丢掉时为 null。
- 视图按时间读：`GET /trace/events?since=&until=`，跟着 `cursor` 读完这段时间。

追加（2026-11-22，只加不改）：加 kind `signal.changed`、`stage.changed`、`behavior.refused`、`motion.chosen`、`motion.state`（都只由 agentd 写，`POST /trace/events` 不收）和「动作线」一节；样例加一段动作线。

---

**动作线的输入**（agentd；回放工具 `agent/agentd/tools/motion_replay.py` 靠它们把一段 trace 的输入重新喂给新的 Spatial 和选择器）：Spatial 在入口处记下上面各线没有记的输入。都只由 agentd 写，`POST /trace/events` 不收；每日上限之后和 `signal.changed` 一样保留；各开一条自己的 trace，`causation_id` 为 null，不算「最新输入」（决策事件不指向它们）。不写用户文字，只有枚举词、标识和数。

| kind | 必有 attrs |
|---|---|
| `spatial.began` | `seed`（Spatial 自己随机数的种子；调用方给了随机数时 null）、`epoch`（行为 id 里的 epoch）、`preset`（互动预设名）、`stage`（这时的舞台）、`session_settle`、`session_min_hold`、`recovery_delay`（秒）。Spatial 开始运行时写，紧跟着写当时的 `motion.chooser`、`behavior.switches` 和（已有时）`behavior.capabilities`；回放从这里开始 |
| `situation.observed` | `by`：poll / step / receipt / offer / facing（哪个入口读的）；`fullscreen`、`user_speaking`、`speaking`、`voicing`、`typing`、`turn_traced`（这一轮是否有 trace）为布尔；`line_id`、`session`（标识，可为 null）；`state`；`related`（会话标识列表）；`window_id`（整数或 null）；`activity`（枚举词或 null）；`absence_since`（离开的起点，时钟秒，或 null）；`idle`：active / quiet（键鼠空闲不到 / 满 300 秒）或 null。Spatial 读到的这些值变了才写 |
| `motion.chooser` | `pack`（角色包 id，没有选择器为 null）、`seeds`（选择器各随机流的起始值，对象，或 null）、`kept`（agentd 重启后接着播的基础循环 `{clip, until_ms}`，或 null）。换选择器时写 |
| `motion.intent` | `intent`、`state`、`activity`、`mood`、`display_session`：registry 的意图进选择器的样子（被扣下的终态已换成 `intent=idle`、`state=null`） |
| `motion.input` | `item`：从外面送给选择器的输入，`kind` 为 text_line / voice / clause / clause_end，另带它的 `on` 或 `intent` |
| `motion.clock` | `frames`：动作时钟这时已跑的帧数。一条输入要在动作时钟的一拍之外读选择器的播放位置时（用户的播放结束、选择器选的片段 `cycle_end` / `ended`），先写这一条；帧数取决于那个线程何时醒来，trace 里别处没有 |
| `motion.prefs` | `action_switches`、`motion_overrides`（`PUT /behavior/motion_prefs` 的两项） |
| `motion.return` | `row`、`away_s`、`ended`、`why`：回来演出的决定 |
| `behavior.switches` | `switches`：`PUT /behavior/switches` 存下的值 |
| `behavior.capabilities` | `character`、`capabilities`：宿主报的能力，值为 null 或不可用的原因 |
| `behavior.cancel_all` | `reason`：结束所有行为的原因，例如 character_switch |
| `interaction.preset` | `preset`：`PUT /settings/live` 换上的互动预设名；预设没变不写 |

不另记、从已有事件推出的输入：舞台（`stage.changed` 的 `to`，Spatial 的 `stage.*` 事件跟着它）、渲染器回报（`motion.state`，其中 `resting`、`busy` Spatial 不读；`behavior.receipt`，它的 `turn_generation` 就是那个行为自己的）、渲染器断线（`reason=connection_lost` 的 `behavior.receipt`）。不记、回放不重现：动作生成服务的 `perform`（`offer`）和模型的转向决定（`request_facing`），它们记在发起轮次的 trace 里；她的作息（Routine）和状态（CharacterState）、read model 的 `walk_bias`、`turn_generation`。

追加（2026-11-22，只加不改）：加端点 `GET /trace/events`（一段时间里所有 trace 的事件，分页）；`behavior.receipt` 的 `causation_id` 指向它那个行为的 `behavior.dispatched`。

追加（2026-11-22，只加不改）：加「动作线的输入」一节和其中 11 个 kind。
