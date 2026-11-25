# C1 agentd → 角色进程事件 v2.8：语义行为字段、分句级意图、只出字的台词、生成动作、播放器原语和本地动作

> 角色进程指 `private/renderer/host`（私有组件，不在公开仓库） 的 `metal-avatar-host`。

状态：已批，2026-10-19，定稿 2b67b239（agent 起草）。interaction（6 条补充）、host（3 条）、animation（5 条）都已同意，补充都已并入；
§3 按 C3 v11 改稿 1a63d7a4 改了两处（协调会话 2026-10-19 11:38 定）。
共用夹具：`protocol/C1-agent-events/fixtures/`（每个文件一条消息或一串消息）；校验器 `agent/agentd/c1.py`
（`python3 -I agent/agentd/c1.py protocol/C1-agent-events/fixtures` 全部通过才算夹具有效）。夹具 01–08 各对应一条用例或
一条规则，09 是分句级意图，10、11 是断线和重连，12 是 agentd 判断的结束条件，13 是只出字的台词，14 是生成动作 `perform`（§1.4），15 是宿主请求的生成动作 `motion`（§1.5），16 是 v2.8 的反应链和坐姿里的片段，17 是用户自己的播放结束 agentd 的片段；接收端的测试读同一批文件。
`fixtures/invalid/` 下是校验器必须报错的样例，不在上面的命令里。`fixtures/player/` 下是播放器一致性夹具（§6），格式和上面不同，
由 `c1.check_player_fixture` 查，也不在上面的命令里。

## 0. 不变的部分

### 2026-10-29 角色自身执行状态与表现

角色自己的运行、问题与审批投影为 `display_session = role:<run_id>`，不写入外部编码会话列表。
`intent` 可增加 `run_id`、`conversation_id`、`run_generation`、`phase`、`outcome`，只含有界元数据。
`run_generation` 是该运行的版本，不能与全局 `turn_generation` 混用；所有 intent 带全局 generation。
问题与审批优先，角色工作优先于外部同类工作；完成反应不抢占新工作。
维护性的记忆提炼与截图理解不投影为用户任务。前台/后台的执行归属由 C6 的 `work_kind` 表示。

`completed` 只表示模型轮结束；`outcome` 区分普通回答 `answered`、核验通过 `succeeded`、
待复核 `needs_review`、核验失败 `failed`、后台仍工作 `background_pending`。
只有 `succeeded` 选择庆祝，普通回答用确认，待复核用不确定，失败用歉意。
终态反应保留 8 秒；这不是用户已查看/接受的回执，交付账本仍应独立保存未处理结果。
带 `outcome` 的终态 intent 可带 `occurrence_id`（1–64 字节的字符串，v2.7）：这一次终态表现的编号，同一次终态续发、重发都用同一个编号。
渲染器不演在 snapshot 的 `consumed` 里见过的编号，也不再演自己已经演过的编号（§4.2 的 `session_reaction` 同此）。
问题的实际状态与到期控制等待表现；回答、撤销、角色切换、重置后最多 0.5 秒重新对账。
同一运行的并行工具按 `tool_call_id` 匹配结束事件，最后一个工具结束之前仍显示执行中。

可选 `quiet: bool` 为 true 时宿主保留脸部表现，抑制任务状态触发的全身动作；不取消用户主动语音、拖动或姿势所有权。
宿主在每帧检查 intent 的绝对到期时间，新 generation 退休旧表现，持续等待状态退出后不得补演。
说话中被推迟的一次性 session 反应最多等待 60 秒；不推迟用户拖动等直接输入。
角色自身等待使用 `listen target=user` 的 eyes/head 通道，跳过外部 hook 的防抖，忙标志与打字不能将它改成思考。
`listen` 与 `attend_session` 和 `accompany` 一样可按相同状态续期，不能等待 5 分钟后无声失效。

无窗口 `attend_session` 仅 eyes/head 可原地看向用户。新能力 `attend_session@user` 单独说明是否有角色包里的 gaze 控件；
有窗口的 `attend_session` 仍要求原有空间执行能力。
这些状态投影本身不新增视觉完成回执；C3 behavior/action 的 completed 也不能证明用户看见或接受结果。

### 2026-10-28：角色自主朝向扩展

新增 `behavior.type = "face"`，`target = null`、`channels = ["full_body"]`，必填 `facing_yaw` 为有限的 -180…180 度；其余行为不得带该字段。
`trigger.source` 新增 `agent` / `decision`。`decision_reason` 为产品记录的决定依据，不是用户授权。
只在角色能力报告明确提供 `face: null` 时发送。

角度来自角色 agent 的 `avatar_face` 工具或 agentd 的规则策略；执行器不得按专注时长、说话或空闲状态自行挑选角度。
没有有效指令、模型失败或结果过期时保持当前朝向。手动朝向设置优先，动作仍服从资源检查、身体仲裁与用户拖动。
工具返回 accepted/requested 只代表请求已发出；实际转身回执依次 prepared、running、completed，完成前不得宣称已完成。
同角度的续期沿用执行器，新角度替换必须重新准备和执行。取消/到期释放执行器，不隐含回正指令。

- `GET /events` 的 SSE、`seq`、游标、`event: snapshot`、`event: intent`、`event: speech_cancelled` 都不变。
- 旧消费者不认识新事件名时跳过即可。v2 只加不改，v2.7 例外（见 §5）。
- intent 事件的 `state`（`agent/agentd/sessions/registry.py` 的 `STATES`）和 `intent` 只给脸和气泡用，v2.7 起角色进程不再按它们选身体动作；
  换工具时 agentd 重发同一个 `state` 和 `intent`（`test_registry.UnityIntentFieldsTest` 钉住）。
- `state` 为 `background` 时角色只有后台任务在跑（`intent` 为 `think`）；前台工作、等待和刚完成都排在它前面。
- 新事件和 `intent` 共用 `seq`。
- `event: snapshot` 加 `behaviors`：在跑的全部 §1 对象的数组（没有时为 `[]`；通道不重叠的行为可以并行，例如扶窗和听，
  夹具 06）。bridge 不带游标连 `/events`、在 `/speech` reset 后重连，断线期间发的 `behavior`、`behavior_cancel` 靠它补上
  （夹具 11）。host 的 adapter 把它放在 LastState 顶层，之后的 `behavior` 加进去或按 `replaces` 替换，同 id 的
  `behavior_cancel` 把它移出；`behavior`、`behavior_cancel`、`clause_intent`、`text_line`
  按 speech.cancelled 的封装原样转，丢掉 `seq` ≤ 游标的和第一条 snapshot 之前的。
- 每条 `event: snapshot` 都带 agentd 的 `epoch`：连上时的第一条和之后的每条实时 snapshot 一样（`test_server` 钉住）。
- `event: snapshot` 可另带下面三个字段（v2.7）。角色加载或换角色时、重连时都带上，不依赖终态的有效期；带了的字段整份替换渲染器
  手里的那一份，没带的保持原值。

  | 字段 | 内容 |
  |---|---|
  | `reactions` | 对象：触发名 → 非空数组 `[{clip, weight, layer}]`。触发名只能是 `click`、`pat`、`pinch`、`drag_lift`、`drop`、`attention_left`、`attention_right`、`point_at`、`present`、`hover`（指针停在她身上，什么时候算停由渲染器定）；`clip` 同 §1.4 `clip.id`（1–64 字节的字符串）；`weight` 是 > 0 的数；`layer` 同 §1.4（`base` / `overlay`）。这个触发在本地发生时，渲染器按 `weight` 加权随机挑一条、在本地播，不做别的策略；表里没有这个触发名就不播 |
  | `stage` | `{level, revision}`：`level` 是当前存在感等级，`offstage` / `quiet` / `normal` / `engaged`；`revision` 是整数 ≥ 0，等级每变一次 +1 |
  | `consumed` | 数组，最多 64 个终态编号（`occurrence_id`，各 1–64 字节的字符串）：被挡掉、不再演的终态（§0 2026-10-29 一节、§4.2） |

- `reactions` 的条目（v2.8）是 `{clip, weight, layer, chain?, hold?, hold_s?, stroke_s?}`：
  - `chain`：1–8 个片段 id（各同 `clip`）的数组，在 `clip` 之后按顺序在同一层上播，每条在前一条的出口开始（同 §1.4 `start: "after_exit"`）。
    每个触发都可以带，带不带 `hold` 都行：`clip` 是角色包里一条链的开头时，agentd 给出整条链（mac 原来播的就是池子里链头的整条链）。
  - `hold`：`[clip] + chain` 里的一条循环片段 id；渲染器停在它上面，直到这个触发结束，再播列表里剩下的。只有下面的触发可以带 `hold`，
    各自的结束是：`pat`（摸头结束）、`present`（这次 present 关闭）、`drag_lift`（放下）、`attention_left` / `attention_right`
    （渲染器自己抽的保持时长，mac 上是 1.5–3 s）。别的触发带 `hold`、`hold` 不在这个列表里，校验器都报错。
  - `stroke_s`：对象，片段 id → 秒数：渲染器在这条片段播到这个秒数时，给这次打开的 present 发 C3 `motion.stroke`；键是
    `[clip] + chain` 里的片段，值是 ≥ 0 的数；只用于 `present`。
  - `hold_s`：对象，片段 id → 秒数：列表里这条循环片段播这么多秒，再播列表里的下一条（角色包条目的 `hold_seconds`）；键是
    `[clip] + chain` 里不是 `hold` 的循环片段，值是 > 0 的数；每个触发都可以带。列表里的循环片段既不是 `hold` 也不在 `hold_s`
    里时只播一圈。键不在列表里、是 `hold`、值不大于 0，校验器都报错；校验器不读角色包，查不了键是不是循环片段。
  - 同一层上新起的本地触发让在停的条目立刻结束（不播出口）；渲染器因为别的原因离开在停的条目时，播它的出口。
  - 触发自己的结束不算新的触发：放下让在停的 `drag_lift` 循环走完这一圈，播它后面的列表（出口），`drop` 的条目（表里有的话）在
    那段出口播完之后开始；摸头结束、present 关闭也一样只让列表往下走（播放器夹具 `09-lift-then-drop.json`）。
- 触发名（v2.8）另加 `click_head`、`click_cheek`、`click_hand`、`click_repeat`、`pinch_annoyed`。渲染器认出点在某个部位时，表里有
  这个部位的触发就播它，没有就播 `click`；认出连点时，表里有 `click_repeat` 就播它，没有就当一次单击。agentd 按原来的回退填部位
  触发（`cheek` → `click.cheek`，没有就 `click.face`；`head` → `click.head`；`hand` → `click.hand`），角色包没有对应池子的触发不给。

## 1. `event: behavior`（agentd 选的一个持续活动）

agentd 的行为 tick 或事件触发选出一个活动时发一条。角色进程维持它（`private/renderer/runtime` 的
`AgentBehaviorScheduler`），按 `channels` 分配身体占用。新 behavior 替换旧的（`replaces`），承重骨链先安全释放再切，
旧的不延迟复活。`replaces` 为 null 且 `channels` 和正在跑的行为不重叠时，两个一起跑
（扶窗中用眼、头、嘴回应说话，夹具 06）；重叠时按 `priority` 替换。
- 身体片段只来自 `perform`（§1.4）和别的行为类型。intent 的 `state`、`activity` 不再让渲染器选全身片段，只给脸和气泡用（v2.7）。
- agentd 选片发出的 `perform`（带 `clip`，§1.4）是片段层：它只和别的 `perform` 以及驱动全身的 `short_walk`、`sit`、`hold_window_edge`、`climb_window_top` 按通道互相取代；`idle`、`observe`、`listen`、`think`、`accompany`、`attend_session`、`face` 只定朝向和目标，和它通道重叠也一起跑，片段照播，朝向和看向叠在片段上（v2.7）。
- `replaces` 指向的行为已经结束时，忽略 `replaces`，照常按 `channels` 和 `priority` 定。
- 用户拖动、拎起是角色进程本地的，算 `priority` 2：和它重叠的行为以 `user_drag` 结束（回执 `cancelled`）；拖动中要
  `full_body` 或 `contact` 的新行为回执 `rejected` / `busy`。用户单击的本地反应打断的行为以 `user_click` 结束，渲染器为让开
  用户正在用的东西结束的坐、扶以 `give_way` 结束（C3 规则 42），回执都是 `cancelled`（v2.7）。
- agentd 发出的新行为和在跑的行为通道重叠时，必须声明被取代的那个：`replaces` 填旧 id，或先发 `behavior_cancel` /
  `replaced`。否则旧的会一直留在各消费端的 `behaviors` 里。校验器按这条查。
- 到期是本地的：到期的行为不发 `behavior_cancel`；消费端按墙钟把 `expires_at_ms` 已过的项从 `behaviors` 里去掉。
  agentd 发 `behavior_cancel` / `expired` 也可以，没有副作用。
- 重连对账（角色进程）：
  - 先接手 snapshot `behaviors` 里的新 id，再结束不在数组里的本地行为。C3 断线后本地行为已记成失联，agentd 会用新 id
    续上同 `type`、同 `target`；先结束再接手的话新 id 接不上，入场动作会重放。
  - 不在数组里、也没失联的本地行为（只有 agentd 的 SSE 重连，角色进程一直连着）：安全释放，回执 `cancelled`、reason
    null，保证每个行为都有一条终态回执。失联的不发回执（C3 v11 规则 25）。
  - 数组里不会有 Companion 已补发过 `connection_lost` 的 id（§3），所以「数组里有的就保留」只用于 SSE 重连这种情况。

| 字段 | 类型 | 说明 |
|---|---|---|
| `behavior_id` | string | `b-<agentd epoch>-<n>`，≤ 64 字节，本进程内唯一；回执、`motion.started`（C3 v10 规则 22）用它 |
| `type` | enum | 见 §1.1 |
| `variant` | string 或 null，可缺省 | v2.2，只用于 `sit`：`still`、`read`、`tea`、`ground`、`rest`；缺省或 null 是原来的坐。角色没有这个 variant 时角色进程回执 `rejected` / `unsupported`。`rest` 是原来的坐再打盹：角色有坐姿的 `rest.sleep` 动作池（按坐循环的姿态取 `rest.sleep@sit` 或 `rest.sleep@floor`）就在坐循环的边界播它，没有就一直坐着；只在宿主的 C3 `behavior_capabilities` 报 `sit/rest` 为 null 时发 |
| `target` | object 或 null | 见 §1.2 |
| `trigger` | object | `{source, event}`；`source` ∈ `tick`（随机 tick）、`session`（会话状态变化）、`user`（用户输入、说话、打字）、`speech`（嘴在说）、`receipt`（上一个行为受阻后换目标）；`event` 是具体原因字符串，例如 `session_state:awaiting_approval`、`typing`，可为 null |
| `display_session` | string 或 null | 和这个行为有关的会话（`attend_session` 必填） |
| `turn_id` | string 或 null | 由某一轮对话引起时填（`listen`、`think`） |
| `turn_generation` | int | 发出时的 `turn_generation`；角色进程收到比当前小的直接丢弃并回执 `rejected` / `stale` |
| `priority` | int 0–3 | 0 随机 tick；1 会话事件；2 用户交互（说话、打字、点击后的转注意）；3 安全退出（目标窗口没了、全屏让开）。角色进程只让同级或更高的替换正在跑的行为；低的回执 `rejected` / `busy` |
| `expires_at_ms` | int | 墙钟毫秒（跨进程期限用墙钟）；到期角色进程结束行为并回执 `expired` |
| `intensity` | number 0.0–1.0 | 动作幅度和走动意愿；用户打字时 ≤ 0.3，且 `type` 不会是 `short_walk`、`climb_window_top` |
| `channels` | string[] | 允许占用的身体通道，取自 `voice`、`mouth`、`eyes`、`head`、`left_hand`、`right_hand`、`full_body`、`contact`；不列出的通道不能占（例如扶窗中回应说话，用 `eyes`、`head`、`mouth`）。`full_body` 只指承重链（骨盆、腿、脊柱），不含眼、头、嘴和两只手 |
| `exit` | string[] | 结束条件，取自 `focus_change`、`session_state`、`speech_start`、`speech_end`、`user_typing`、`target_gone`、`user_drag`；任一发生角色进程结束行为并回执 `completed`（条件达成）或 `cancelled`（被打断） |
| `replaces` | string 或 null | 被这条替换的 `behavior_id` |
| `trace_id` | string | T1 trace（C6 `T1-TRACE.md`） |

`exit` 条件达成时的回执：

| `exit` | 回执 |
|---|---|
| `speech_end`、`session_state`、`focus_change` | `completed` |
| `speech_start`、`user_typing`、`user_drag` | `cancelled` |
| `target_gone` | `blocked` / `target_gone` |

谁判断：角色进程看不到说话、会话状态、焦点和打字，所以 `speech_start`、`speech_end`、`session_state`、`focus_change`、
`user_typing` 由 agentd 判断，成立时发 `behavior_cancel` / `exit`，`condition` 是成立的那个（§2），角色进程安全释放后按上表
回执；`user_drag`、`target_gone` 和到期只由角色进程判断，agentd 不发。agentd 每 1 s 查一次，从发生到发出 cancel：
会话状态和角色的语音 ≤ 1 s，用户说话、焦点窗口和打字 ≤ 2 s（Companion 每 1 s 一条心跳），但打字要先连续活跃 60 s
才算（细节见 `protocol/C6-agentd-api/CONTRACT.md` §4.8）。

### 1.1 `type`

`idle`（待机）、`observe`（观察屏幕上的东西）、`short_walk`（沿屏幕底边短走）、`sit`（坐，地面或窗口顶）、
`hold_window_edge`（扶窗沿）、`climb_window_top`（上窗口顶）、`attend_session`（看向、关注某个会话）、
`accompany`（安静陪伴）、`listen`（在听）、`think`（在想）。

允许长时间停留的：`sit`、`accompany`（30 分钟回放验收用）。

### 1.2 `target`

| `kind` | 其他字段 | 用于 |
|---|---|---|
| `window` | `window_id`（int，系统窗口号）、`side`（`left` / `right` / null） | `hold_window_edge`（`side` 必填，决定手：left → `Bip001_L`）；`sit`（窗口顶）、`climb_window_top`、`observe`、`short_walk` 的 `side` 可为 null；`short_walk` 走到窗口下方离她近的一侧，到了朝向窗口 |
| `session` | `display_session`、`window_id`（int 或 null：agentd 的 ActivityContext 里这个会话所在的窗口） | `attend_session`；无窗口且仅 eyes/head 时，可按 `attend_session@user` 能力原地看向用户；其余无窗口目标回执 `blocked` / `target_gone` |
| `point` | `x`、`y`（全局点）、`display_id` | `short_walk` 的终点、`observe` |
| `user` | 无 | `listen` |
| `object` | `object_id`（string 或 null：由角色进程选物体） | v2.2，`sit`（坐在场景物体上）；agentd 现在不发这种目标 |
| `edge` | `side`（`nearest` / `left` / `right`） | v2.7，`short_walk`：走到当前显示器的一条自由边 |

`target` 为 null：`sit` 是在屏幕底边当前位置坐下；`idle`、`accompany`、`think` 没有目标；`short_walk` 由角色进程选终点。

`short_walk` 的 `edge` 目标（v2.7）：
- 自由边是当前显示器上不和别的显示器相接的左边或右边。角色进程在当前显示器、当前地面线上找：`nearest` 取离她近的那条自由边，
  `left` / `right` 只取那一边；没有可取的自由边时回执 `blocked` / `no_room`。
- 走到那条边上（在到达容差内）回执 `completed`，不走回程。终点可以让身体部分出屏，锚点照 C3 规则 19 的自由边限位。
- 已经在那条边上：不走，直接回执 `completed`（第一条回执照 §3 是 `running`），不回 `blocked` / `no_room`。
- 窗口视口、固定舞台（展示台、场景盒）或角色没有走路数据：第一条回执就是 `rejected` / `unsupported`。

窗口几何以系统 API 为准，agentd 只给窗口号，不给坐标、窗口代际或 display_id；角色进程用
`HostSurfaceLink` 按 `window_id` 取几何，取不到就回执 `blocked` / `target_gone`。
原生宿主在目标可用时把 `observe` 或带窗口的 `attend_session` 送给头眼控制，目标随窗口移动更新；
窗口消失后停止注视并回执 `blocked` / `target_gone`。从未找到的目标没有 `running` 回执。

### 1.3 agentd 只给当前能做的

- 开关关掉的类型不发：`stay_in_place` 开时不发 `short_walk`、`climb_window_top`；
  `sit_window_top` 关时不发窗口顶的 `sit`、`climb_window_top`；`hold_window_edge` 关时不发 `hold_window_edge`；
  `bust_framing` 开时不发走动类、`sit`、`hold_window_edge`、`face`，agent 的转身请求回 `facing_unavailable`；
  `hold_free_walks` 开时 agentd 自己不起新的走动类、`hold_window_edge`、窗口顶的 `sit`（随机 tick、作息、焦点走动、`blocked` 后换的、进 quiet 走到边的等到它关），
  正在跑的照常跑完，不发 `behavior_cancel`；
  `fullscreen_give_way` 开且前台全屏时只发 `idle`（`priority` 3，`trigger.event` = `fullscreen`）。
- 开关由 Companion 写入 `PUT /behavior/switches`（C6，ui token）。body 每次是完整对象
  `{stay_in_place, sit_window_top, hold_window_edge, fullscreen_give_way}`，都是布尔，可选再带 `bust_framing`（半身固定，缺省 false）、`hold_free_walks`（她身边的悬停按钮开着，缺省 false；Companion 每次按钮开合时也重新 PUT）；缺键、多键、非布尔回 400
  `invalid_switches`；200 回存下的值。agentd 只存在内存里；Companion 在 agentd 每次变健康时和每次改动时重新 PUT。
  没写过时按默认：`stay_in_place` false，其余 true。前台全屏仍取 attention 心跳的 `fullscreen`。
- 续期（夹具 03）：和正在跑的行为同类型、同目标的不重发（重复的会话事件合并）。`accompany`、`sit` 快到
  `expires_at_ms` 时，agentd 发一条同类型、同目标、`replaces` = 旧 id 的；角色进程当作续期，不重做入场动作，旧的回执
  `cancelled`。校验器按这条检查夹具。
- 事件触发优先于随机 tick：会话状态变化、用户说话或打字，在下一次 tick 之前立刻发。
- 用户打字（ActivityContext `typing`）时：不发 `short_walk`、`climb_window_top`，`intensity` ≤ 0.3，
  `exit` 含 `user_typing` 的行为立刻结束。

### 1.4 生成动作：`type: "perform"`（v2.4）

动作后端为 `generated` 时，agentd 把台词里的 `[motion:<英文描述>|<秒数>]` 交给动作服务生成，重定向到当前角色，作为一条普通
`behavior` 发出。只多一个类型和一个字段：

- `type: "perform"`，`target: null`，`channels: ["full_body"]`（叠加层见下面的 `layer`）。其余字段和别的行为一样（behavior_id、trigger、turn_generation、
  priority、expires_at_ms、intensity、exit、trace_id、replaces）。agentd 发的 `trigger.source` 是 `agent`。
- `motion`、`action`（v2.6）或 `clip`（v2.7）：`perform` 带且只带其中一个，别的类型都不能带。`motion` 是生成片段：
  - `id`：`"gm-"` 加 16 个小写十六进制字符；
  - `meta_sha256`、`keys_sha256`：64 个小写十六进制字符；
  - `rig_sha256`：64 个小写十六进制字符，是宿主 `ActorArchive.rigSHA256` 里那份角色 rig 文档的 sha256；
  - `length_s`：数，0.2–10。
- `action`（v2.6）是当前角色包里的角色包动作：
  - `id`：角色包 `animation/actions.json` 里一条动作的 `id`，1–64 字节的字符串；
  - `length_s`：数，0.2–10，是该动作片段的原长（actions.json 的 `duration`，没有时为各 clip 长度之和）。
  - agentd 只在 `[motion:]` 的文字配到当前角色的角色包动作时发它（`agent/agentd/motion/catalog.py` 和 `phrases.json`）：
    section 为 talk / react / touch / idle、没有 `command` 和 `unavailable_reason`、clip 都在 clip-catalog、原长 ≤ 8 s 的
    动作才进匹配目录。`behavior_id` 是 `"b-ga-"` 加 16 个小写十六进制字符，`expires_at_ms` 是发出时刻加 `length_s` 再加 6 s，
    其余字段同 `motion`。不调动作服务，不取文件。
  - 追加（只加不改）：角色工具 `avatar_motion` 按 id 点名这个目录里的一条动作时，agentd 也发它，其余同上；用户关掉的动作
    （`PUT /behavior/motion_prefs` 的 `action_switches`）和片段缺失的动作不发。它的 `behavior.dispatched` 记在发起轮次的 trace 里。
  - 宿主按 `id` 取该动作的片段，当身体片段按原长播（不拉伸、不截短，和标记里的秒数无关），进出都用默认交叉淡化，
    播完回到待机底层，发 `completed`；片段第一次参与提交的帧时发 `running`。角色没有这条动作或片段不可播时发 `rejected`，
    reason `unsupported`。
- `clip`（v2.7）是角色包里的一条片段：`{"id"}`，`id` 是角色包 `c7/interaction/motion-metadata.json` 里一条片段的 id，1–64 字节的
  字符串。宿主按 `id` 取片段，片段第一次参与提交的帧时发 `running`；不循环的播完发 `completed`；角色没有这条片段或片段不可播时
  发 `rejected` / `unsupported`。
- 怎么播（v2.7，只用于 `perform`，别的类型都不能带）：

  | 字段 | 类型 | 说明 |
  |---|---|---|
  | `layer` | `"base"` / `"overlay"`，可缺省 | 缺省 `base`。`base` 是基础层，`channels` 为 `["full_body"]`。`overlay` 是叠加层，按骨骼遮罩（缺省上半身，片段元数据可改）盖在基础层上，`channels` 正好是 `["head", "left_hand", "right_hand"]`，不能含 `full_body`；它和基础层的 `perform` 通道不重叠，两个一起跑 |
  | `start` | `"now"` / `"sync"` / `"cycle_end"` / `"after_exit"`，可缺省 | 缺省 `now`：立刻开始，同一层上原来的片段交叉淡化出去。`sync`：立刻切，新片段从旧片段当前的归一化相位开始。`cycle_end`：等这一层当前的循环片段走完这一圈再切。`after_exit`：等这一层当前的行为走完出口段（坐、扶窗先起身、松手，一次性片段先播完）再开始 |
  | `blend_s` | 数 0–2，可缺省 | 切进这条片段的交叉淡化秒数；缺省用默认交叉淡化 |
  | `loop` | 布尔，可缺省，只用于 `layer: "base"` | `true` 时这条 `perform` 就是当前的休息循环：片段循环播，不受 `length_s` 限制，只在被替换、取消或到期时结束 |
  | `ttl_s` | 数 0.5–120，可缺省 | 渲染器收到这条行为起 `ttl_s` 秒内没有续期就丢掉它，回执 `expired`，回到当前姿势的默认休息循环；`expires_at_ms` 照旧，先到的那个算 |
  | `within` | string，可缺省，只用于带 `clip` 的 `layer: "base"` 的 `perform`（v2.8） | 一个在跑的 `sit` 或 `climb_window_top` 的 `behavior_id`。渲染器把片段当成她在这个行为里的姿势播：坐保持位置和接触，不结束；这个行为结束时片段也结束（回执 `cancelled` / `replaced`）。`within` 指的行为没在跑时回执 `rejected` / `target_gone`。不支持 `sit` 的渲染器收不到这种 `perform`。它和 `within` 指的行为不互相取代 |

  - 续期照 §1.3：同一层、同一载荷、`replaces` 为旧 id 的 `perform` 是续期，片段接着播，不重新开始，`ttl_s` 从收到续期时重算。
  - 当前姿势的默认休息循环是角色包里固定的一条，渲染器不挑选；一层上的行为到期（`ttl_s` 或 `expires_at_ms`）、被取消且没有接替时回到它。
  - `/events` 断开不结束行为：断开期间行为照常播，没有续期就按 `ttl_s`、`expires_at_ms` 到期；重连后按上面的重连对账，snapshot `behaviors` 里有的保留，没有的安全释放。
  - 片段边界的播放状态由渲染器经 C3 `motion_state`（规则 54）报给 agentd。
- 入场（v2.8）：agentd 从角色包的 `character.enter` 池挑一条，发基础层的 `clip` `perform`，`trigger.event` 为 `character.enter`：
  在它第一次提基础层时、状态目录的文件里没有还在播的循环时发（app 启动，不是 agentd 很快重启），换角色提交后也发。舞台为 `quiet`
  或 `offstage`、她坐着时先不发，等到第一次舞台不是这两种、她也没坐着的基础层提议时再发。等的时候换了角色，只发新角色的一次入场；
  等的时候演过用户回来的表演（哪怕只有转向用户），就不再发：她已经招呼过用户了。
- 下面取文件、校验的规则只对 `motion`。宿主用 AgentBridgeTransport 发 GET 时已用的基址和令牌取两个文件（C6，ui 或 events 令牌）：
  - `GET /motions/<id>/meta` 回一份 `metal-actor-clip-v1` JSON：`{schema, name, length, frame_rate, loop:false, curves,
    keys:{file, sha256, byte_count}}`，和 `characters/agentic_complex_build/import_vmd.py:append_clip` 写的一样；`name` 等于 `<id>`。
  - `GET /motions/<id>/keys` 回 EFKEY001 字节；它的 sha256 等于 `keys_sha256` 和 meta 的 `keys.sha256`。
  - 不认识的 id 两个都回 404 `{"error":"unknown_motion"}`。agentd 在内存里留最近 16 个动作。
- 宿主：
  - 收到 `prepared` 时取到并校验两个文件：sha256、rig、schema、长度和 `length_s` 相差不超过 0.05 s。
  - 以 `<id>` 为名注册这个片段，当身体片段播，进用默认交叉淡化，出按片尾与待机基座的姿势距离取 0.25–0.9 s。
  - 播完回到待机底层，发 `completed`。
  - 取文件或校验失败发 `rejected`，reason `unsupported`。
  - 收到行为后最多等文件 5 s，过了发 `rejected` / `unsupported`。
  - `behavior_cancel` 或更高优先级的行为照别的行为一样结束它。
- 回执就是 §3 的回执。片段第一次参与提交的帧时发 `running`。
- agentd 一侧：
  - 从标记解析到发出整条链（生成 → 重定向 → 存 → 发）超过 4 s 或任何一步失败，就什么也不发，只在这一轮的 trace 记一步
    `motion.fallback`（带 `reason`）；这句台词的 `clause_intent` 照常驱动角色包手势。重定向后的质量检查不过（hips 首末水平
    净位移超过 0.25 m，或源动作脚尖低于地面 3 cm 以上）也按失败处理，reason `quality`，`checks` 列出 `travel` / `floor`。成功时记 `motion.published`，带
    `generate_ms`、`retarget_ms`、`total_ms`。一次只跑一个动作，更新的替换还在等的那个。
  - 生成之前先匹配（v2.6）：配到角色包动作就立刻发带 `action` 的 `perform`，记 `motion.matched`，不进生成队列；配不到才
    照上面生成。宁可漏配不误配。
  - 标记的文字是可打印 ASCII，3–160 个字符；秒数是 1–6 的数；整个标记最长 200 个字符。标记总是从说出的文字里去掉；
    动作后端为 `game` 时什么也不做，提示词里也没有这条标记的说明。
  - `GET /motion/settings`（ui 令牌）回 `{backend, token_set}`，从不回令牌。`PUT /motion/settings`（ui 令牌）
    收 `{backend, token?}`：`backend` 是 `game`（默认）或 `generated`，`token` 是动作服务的 bearer 令牌（缺省保留，`""` 删掉）。键不对 400 `invalid_payload`，后端不认识 400
    `invalid_backend`，令牌不是字符串 400 `invalid_token`；200 回存下的设置（同 GET）。动作服务的地址是 agentd 的 `--motion-url`（C9）。
    设置存在状态目录的 `motion-settings.json`，令牌保存在系统凭据存储中，设置文件只记录引用。

### 1.5 宿主请求的生成动作：`event: motion`（v2.5）

宿主经 C3 v23 `motion_request`（规则 40）→ Companion → agentd `POST /motions/generate` 请求一段按它的几何生成的片段，agentd
生成、重定向、存好后在 `/events` 上发一条 `motion`。它和 `intent`、`behavior` 共用 `seq`。

- 成功：`{seq, request_id, behavior_id, ok: true, motion}`。
  - `request_id`、`behavior_id` 照抄请求。
  - `motion` 是 `{id, meta_sha256, keys_sha256, rig_sha256, length_s, tracks_sha256}`；前五个同 §1.4，`tracks_sha256` 是
    64 个小写十六进制字符，等于 `GET /motions/<id>/tracks` 回的字节的 sha256。
- 失败：`{seq, request_id, behavior_id, ok: false, reason}`，不带 `motion`；`reason` ∈ `timeout`（从收到请求到发出超过
  2.5 s）、`no_service`、`busy`、`failed`、`game_backend`。
- 动作后端为 `game` 或没有动作服务时，`POST /motions/generate` 回 409（`motion_backend_game` / `no_service`），并立即发一条
  `ok: false` 的 `motion`（`reason` 为 `game_backend` / `no_service`），宿主不必等满 2.5 s 就用角色包动作片段。
- 宿主：
  - 按 `request_id` 对上自己在等的请求；不认识的、已经回退了的丢掉。
  - 用 events 令牌取 `/meta`、`/keys`、`/tracks`，按 §1.4 校验（sha256、rig、schema、长度和 `length_s` 相差不超过 0.05 s），
    再校验 `tracks` 的 sha256 和下面的规则，然后以 `<id>` 为名注册片段、按 tracks 播。
  - `ok` 为 false、请求后 2.5 s（宿主的动作时钟）没收到、或校验不过，就用角色包动作片段。
- agentd 一侧：几何请求单独一个槽，同一个 `behavior_id` 更新的请求替换还在等的那个；`perform`（§1.4）不替换它。

`GET /motions/<id>/tracks`（events 或 ui 令牌）回 `endfield-generated-tracks/v1` JSON：

```json
{"schema":"endfield-generated-tracks/v1","id":"gm-…","kind":"walk","rate_hz":30,"loop":false,
 "stance_start":"stand","stance_end":"stand",
 "contacts":{"L":[[t0,t1],…],"R":[…]},
 "travel":[0.0,…],"direction":[x,z],
 "yaw":[0.0,…],
 "seat_centre":[[x,y,z],…],"pelvis":[y,…]}
```

| 键 | 内容 |
|---|---|
| `schema` | `"endfield-generated-tracks/v1"` |
| `id` | 同 `motion.id` |
| `kind` | 同请求的 `kind` |
| `rate_hz` | 30；下面每帧一个值的数组都按它采样 |
| `loop` | 布尔，`window_loop`、`sit_loop` 为 true，其余 false |
| `stance_start`、`stance_end` | `"stand"` / `"sit"` |
| `contacts` | `{L, R}`：脚跟着地的区间 `[t0, t1]`（秒，t0 < t1，从小到大），来自 npz 的 `foot_contacts` |
| `travel`、`direction` | 只有 `walk`：`travel` 是沿 `direction` 的米数，每帧一个，从 0 开始、不减；`direction` 是 rig root x/z 里的单位向量。片段里只留绕平滑 root 的胯部摆动 |
| `yaw` | 只有 `turn`：每帧累计的度数，正值转向 +x，从 0 开始。片段里去掉了朝向 |
| `seat_centre`、`pelvis` | 只有 `window_loop`、`sit_*`：每帧的座位中心 `[x, y, z]` 和胯高 `y`，rig root 米 |

- 坐标同 C3 规则 40：rig root 系，左手系，米，+z 前，+x 她的右手。
- 别的 `kind` 不带用不上的键。`perform` 的动作没有 tracks，`/tracks` 回 404 `{"error":"unknown_tracks"}`；不认识的 id 回 404
  `{"error":"unknown_motion"}`。

## 2. `event: behavior_cancel`

`{seq, behavior_id, reason, turn_generation}`；`reason` ∈ `replaced`、`switch_off`、`fullscreen`、`turn_cancelled`、`expired`、`exit`（agentd 判断的结束条件成立，§1）、`character_switch`（换角色时 `POST /character/prepare` 结束在跑的全部行为）。
`reason` 为 `exit` 时另带 `condition`：`speech_start`、`speech_end`、`session_state`、`focus_change`、`user_typing` 之一，
且在这个行为的 `exit` 里；别的 `reason` 不带 `condition`。
角色进程安全释放后回执 `cancelled`；`exit` 按 §1 的表回执（`speech_end`、`session_state`、`focus_change` → `completed`，
`speech_start`、`user_typing` → `cancelled`、reason null）。校验器按这条查。

可选 `mode`（v2.7）：`abort`（缺省）照上面安全释放；`fade_out` 让片段在 `fade_s` 秒里淡出，淡完再按上面回执。`fade_s` 是
0.05–2 的数，只和 `fade_out` 一起出现；`fade_out` 不带 `fade_s` 时用默认交叉淡化。

## 3. 执行回执（角色进程 → Companion → agentd）

角色进程经 C3（规则 25，和 `playback` 一样）交给 Companion，Companion 原样 `POST /behavior/receipts`
（C6，ui token）给 agentd。agentd 只在收到 `completed` 后才把「走到了」「已松手」当成事实。

| 字段 | 说明 |
|---|---|
| `behavior_id` | 来自 `event: behavior` |
| `phase` | `prepared`、`rejected`、`running`、`completed`、`blocked`、`cancelled`、`expired`（Proposed→Rejected/Prepared→Running→Cancelling→Cancelled/Completed/Failed；`blocked` 和 `expired` 是 Failed 的两种） |
| `reason` | `rejected`：`stale`、`busy`、`unsupported`、`switch_off`、`target_gone`（v2.8，`within` 指的行为没在跑）；`blocked`：`target_gone`、`no_room`、`path_blocked`；`cancelled` 可带 `connection_lost`（角色进程断线，Companion 对没到终态的每个行为补发，C3 v11 规则 25）、`user_drag`、`user_click`（v2.7，用户单击的本地反应打断了它）、`give_way`（v2.7，渲染器为让开用户正在用的东西结束了坐、扶，C3 规则 42）、`replaced`、`character_switch`（换角色前释放）、`user_play`（v2.8，用户自己的播放或姿态场景开始时渲染器结束了 agentd 在基础层播的 `clip` `perform`；叠加层的照播；用户的播放结束之前，新的基础层 `clip` `perform` 回执 `rejected` / `busy`，C3 规则 54；`user_play` 只用于 `cancelled`）；其余可为 null |
| `at_ms` | 墙钟毫秒 |
| `turn_generation` | 回执对应行为的 `turn_generation` |

每个行为的第一条回执是 `prepared`、`running`（目标就在原地时角色进程同一帧开始跑）或 `rejected`；`rejected`、
`completed`、`blocked`、`cancelled`、`expired` 是终态，之后同一个 `behavior_id` 不再有回执（C3 v11 规则 25；校验器按这条
查夹具）。C3 v11 的限流只丢多余的非终态回执，不丢终态。

Companion 给某个行为补发 `cancelled` / `connection_lost` 之后，角色进程不再为它发回执；重连后 snapshot 的 `behaviors`
里没有这个 id。要接着做，agentd 按 §1.3 的续期规则发一条同 `type`、同 `target` 的新行为（新 `behavior_id`）。`cancelled` / `connection_lost` 记成失联：不当作完成，
也不当作被打断（同 C2 的 `connection_lost`）。

`blocked` 时 agentd 换目标或换类型重发（`trigger.source` = `receipt`），同一目标 60 s 内不再选。

## 4. 分句级意图：`event: clause_intent`

嘴的台词里 `[intent:x]` 标记按 C2 v2 分句对齐，animation 用它把手势对到分句开始。

`{seq, line_id, utterance_id, clause_id, spoken_text_revision, intent, turn_generation, trace_id}`；`intent` 取 C1 的
12 值；`clause_id` 是 C2 v2 `clause` 的 id（标记在哪个分句里出现就是哪个）；`spoken_text_revision` 是 C2 的同名字段
（整数 ≥ 1）。只出字不出声时 `utterance_id`、`clause_id`、`spoken_text_revision` 都为 null。

- 匹配：角色进程按 (`utterance_id`, `clause_id`, `spoken_text_revision`) 对到分句。改写后重合成的台词 `clause_id` 不变、
  revision 加 1，所以旧意图不会挂到新分句上（夹具 09）。
- 每个 (`utterance_id`, `clause_id`, `spoken_text_revision`) 最多一条；agentd 多发时，后一条替换前一条。
- 时机：分句 `playback.started` 时做手势。`/events` 和 `/speech` 是两条流，`clause_intent` 可能在分句开始后才到：
  分句还在播就立刻做，已经播完就丢弃。
- `clause_id` 为 null（只出字）：收到就用，同 `event: intent`。
- 手势占 `full_body`（provider 只有一层片段，每段都动全身）。正在跑的行为占着 `full_body` 或 `contact` 时角色进程跳过
  这个手势。
- `turn_generation` 小于当前的丢弃。
- 词级的手势落点（±150 ms）留到 v2.3，不在本版（v2.1 是 2026-10-21 的短走窗口目标）。

### 4.1 只出字的台词：`event: text_line`（v2.3）

没有语音的台词（没开 TTS、静音、这句没送合成）只显示文字，宿主照样让她「说着」，身体按说话时的规则动。

`{seq, line_id, turn_generation, trace_id, state, hold_ms}`；`state` 为 `started` 或 `ended`。

- `started`：这句台词第一个可见的字显示时发，只发给不出声的台词（出声的台词从不发 `text_line`）。宿主收到就进入说话状态，
  选说话时的动作池和手势，会话事件和说话时一样等到说完再播。
- `ended`：这句台词结束时发（完成、被打断、取消或出错），只跟在发过 `started` 的台词后面；`hold_ms` 只在 `ended` 上，
  是文字结束后宿主再保持说话状态的毫秒数：完成时为 `min(3000, 60 × 显示的字数)`，取消或出错时为 0。
- 这句台词的 `clause_intent`（三个 id 为 null，每句最多一条）在显示的字里解析出第一个标记时发，紧跟在 `started` 之后，
  手势和字一起出来，不等台词结束。
- 轮次过期（`turn_generation` 变大）后不再发新的 `started` 或 `clause_intent`，已发过 `started` 的台词照常发 `ended`。
- `turn_generation` 小于当前的丢弃；宿主收到更新的 `turn_generation`、会话重置或角色切换时立刻结束说话状态。

## 4.2 非焦点会话的一次性反应：`event: session_reaction`

某个会话进入 `done` 或 `error`，而这次 hook 没让它以这个状态成为焦点 intent 时（例如另一个会话在等确认、焦点会话结束时
别的会话还在忙），agentd 发一条。成为焦点 intent 的结束不发，所以同一次结束不会反应两遍。intent 的 `quiet` 为 true 时不发。

`{seq, display_session, state, turn_generation}`，可选 `occurrence_id`（v2.7）；`display_session` 同 intent 的会话 id，`state` 为 `done` 或 `error`，
`turn_generation` 是发出时的值；`occurrence_id` 是这一次终态表现的编号，1–64 字节的字符串。

- 宿主当一次性反应播，不改焦点。
- 渲染器不演在 snapshot 的 `consumed` 里见过的 `occurrence_id`，也不再演自己已经演过的。
- 焦点 intent 是 `awaiting_approval` 或 `awaiting_input` 时丢弃。
- 宿主坐着或躺着、当前姿势没有这个池时不播，不为它起身。

## 5. 版本记录

2026-10-19：结束条件由 agentd 判断（§1 表下、§2 `exit` 和 `condition`，夹具 12）。
2026-10-19 换角色流程批准：§2 `behavior_cancel`、§3 回执 `cancelled` 的 reason 加 `character_switch`（C3 换角色草案第 5 节，已并入 C3 正文）。
2026-10-21 C1 v2.1：`short_walk` 的 `target` 可以是 `window`（§1.2）。agentd 在焦点换到另一个窗口并停 ≥ 10 s 后，按 0.5 概率发一次（`trigger` = `user` / `focus_change`，`priority` 0）；黑名单隐藏的窗口、全屏、打字、开会、游戏、切换中不发，一段焦点只发一次。
2026-10-21 C1 v2.2（只加不改）：`sit` 可带 `variant`（`still` / `read` / `tea` / `ground` / null，缺省或 null 就是原来的坐；别的类型不带）。§1.2 加 target kind `object`：字段 `object_id`（string 或 null，null 时由角色进程选物体），只用于 `sit`。角色没有这个 variant 时角色进程回执 `rejected` / `unsupported`；agentd 按 (`type`, target kind, `variant`) 记不可用，别的 variant 照常可选。
2026-11-02 C1 v2.2 补充（只加不改）：`sit` 的 `variant` 加 `rest`（坐下打盹）。宿主在 C3 `actions.behavior_capabilities` 报 `sit/rest`：有坐姿执行器就是 null；agentd 只在它为 null 时发。坐着时会话事件有该坐姿的动作池就在坐循环边界插播一段再回到坐循环；`session.approval` / `session.input` / `session.error` 在坐姿没有池时让她经坐姿的起身片段站起，宿主以 `completed` 结束占着座位的 `sit`。

2026-11-17 补充（只加不改）：宿主在 C3 `actions.behavior_capabilities` 另报 `sit/read`、`sit/tea`：坐姿里有这个 variant 就是 null，否则是不可用原因；agentd 对用户活动的坐姿回应只在它为 null 时发该 variant，否则改发 `observe`。
2026-11-03 C1 v2.3（只加不改）：§4.1 新事件 `text_line`（`started` / `ended` + `hold_ms`），只出字的台词显示时宿主保持说话状态；只出字的 `clause_intent` 改为在显示的字里解析出第一个标记时发（原为台词结束时），每句仍最多一条。夹具 13。
2026-11-04 C1 v2.4（只加不改）：§1.4 新类型 `perform` 和它的 `motion` 字段（生成动作），宿主经 `GET /motions/<id>/meta`、`/keys` 取片段；agentd 的 `GET` / `PUT /motion/settings` 切换 `game` / `generated` 动作后端。夹具 14，不合法样例 `fixtures/invalid/14-perform-bad-motion.json`。
2026-11-04 C1 v2.5（只加不改）：§1.5 新事件 `motion`（宿主经 C3 v23 `motion_request` 请求的生成片段，成功带 `motion` 和 `tracks_sha256`，失败带 `reason`），新文件 `GET /motions/<id>/tracks`（`endfield-generated-tracks/v1`）。夹具 15；`agent/agentd/c1.py` 认识 `motion` 之前，这个夹具还过不了校验器。
2026-11-06 C1 v2.6（只加不改）：§1.4 `perform` 带 `motion` 或 `action` 二选一；`action: {id, length_s}` 是当前角色包的角色包动作，`[motion:]` 的文字配到它时 agentd 不生成，宿主按 id 播原片。夹具 14b，不合法样例 `fixtures/invalid/14b-perform-motion-and-action.json`。
2026-11-21 C1 v2.7：agentd 选每一条片段，渲染器只播。§1.4 `perform` 加载荷 `clip`（角色包 `motion-metadata.json` 的片段 id，`motion`、`action`、`clip` 三选一）和 `layer`、`start`、`blend_s`、`loop`、`ttl_s`；§2 `behavior_cancel` 加 `mode`、`fade_s`；snapshot 加 `reactions`、`stage`、`consumed`；带 `outcome` 的终态 intent 和 §4.2 `session_reaction` 加 `occurrence_id`，`consumed` 里的和演过的编号不再演；§1.2 `short_walk` 加目标 `edge`；§3 `cancelled` 加 reason `user_click`、`give_way`；§0、§1 intent 的 `state` 和 `activity` 不再让渲染器选全身片段（这一条改了 v2 的规则）；§6 播放器一致性夹具（`fixtures/player/`，`c1.check_player_fixture`）。不合法样例 `fixtures/invalid/perform-overlay-on-full-body.json`、`perform-two-payloads.json`、`perform-loop-on-overlay.json`、`perform-unknown-start.json`、`snapshot-unknown-reaction-trigger.json`、`cancel-fade-s-without-fade-out.json`。追加（只加不改）：snapshot `reactions` 的触发名加 `hover`，agentd 在角色包有 `user.hover` 池时给出；动作开关、动作覆盖或半身框选改了表时 agentd 发带新 `reactions` 的 snapshot（C6 `PUT /behavior/motion_prefs`）。
2026-11-22 C1 v2.8（只加不改）：mac 渲染器原来自己选的本地动作都改由 agentd 选、两个渲染器播。§0 snapshot `reactions` 的条目加 `chain`、`hold`（只用于 `pat`、`present`、`drag_lift`、`attention_left`、`attention_right`）、`stroke_s`（只用于 `present`），触发名加 `click_head`、`click_cheek`、`click_hand`、`click_repeat`、`pinch_annoyed`；§1.4 基础层 `clip` `perform` 加 `within`（在跑的 `sit` / `climb_window_top` 里的姿势片段：坐着时的待机档、坐姿的会话池、打盹），§3 `rejected` 加 reason `target_gone`；§1.4 加入场（`character.enter` 池）；§6 `local` 加 `end`。夹具 16，播放器夹具 `fixtures/player/07-held-chain.json`，不合法样例 `fixtures/invalid/snapshot-hold-on-click.json`、`snapshot-hold-not-in-list.json`、`snapshot-stroke-off-present.json`、`perform-within-on-overlay.json`、`perform-within-no-sit.json`。追加（只加不改）：`chain` 用于每个触发，条目加 `hold_s`（列表里不是 `hold` 的循环片段播的秒数；两者都没有的循环片段播一圈）；触发自己的结束（放下、摸头结束、present 关闭）不算新的触发，`drop` 的条目在 `drag_lift` 的出口之后开始；入场在舞台为 `quiet` / `offstage`、她坐着时等着，不跳过。夹具 16 加 `hold_s`，播放器夹具 `08-timed-loop-chain.json`、`09-lift-then-drop.json`，不合法样例 `snapshot-hold-s-not-in-list.json`、`snapshot-hold-s-on-the-hold.json`、`snapshot-hold-s-not-positive.json`。追加（只加不改）：§3 `cancelled` 加 reason `user_play`：用户自己的播放（C3 `play_action`、`play_chain`、角色页预览）和姿态场景（C3 `set_pose`）像拖动一样是本地的、`priority` 2；agentd 的 `clip` `perform` 是原地的行为，不让身体变忙，用户的播放不因它们被拒；播放开始时渲染器以 `cancelled` / `user_play` 结束 agentd 基础层的片段，叠加层照播。agentd 从收到这条回执或 C3 `motion_state` `origin` `user` 的 `started` 起不发基础层的 `clip` `perform`（含 `within`），到这次播放的 `ended`、`expired`、`rejected` 或任一条 `cancelled` / `connection_lost` 为止，然后从她的休息循环重新选；这条回执不让 agentd 恢复它取代的行为，也不重发。夹具 17，不合法样例 `fixtures/invalid/receipt-user-play-not-cancelled.json`。

## 6. 播放器一致性夹具（v2.7）

`fixtures/player/` 下每个文件是一个夹具：一串带时刻的 C1 消息和本地输入喂进渲染器，期望渲染器发出的 C3 `motion_state`（规则 54）
序列。mac 和 Windows 的渲染器单测跑同一批文件。

```json
{"name": "…", "character": null,
 "steps": [{"t_ms": 0, "c1": {…}}, {"t_ms": 200, "local": {"input": "click"}}],
 "expect": [{"t_ms_max": 300, "motion_state": {"behavior_id": null, "origin": "local", "phase": "started", "resting": false, "busy": true}}],
 "poses": []}
```

| 键 | 内容 |
|---|---|
| `name` | 非空字符串，说明这个夹具测什么 |
| `character` | 角色 id（非空字符串）或 `null`。`null` 时不用角色包：测试用一套测试片段，夹具里出现的每个 clip id 都是 1000 ms 长、不带位移的片段，循环的一圈 1000 ms |
| `steps` | 非空数组，按 `t_ms` 不减排列。每项是 `{t_ms, c1}` 或 `{t_ms, local}`：`t_ms` 是从夹具开始算的毫秒（整数 ≥ 0）；`c1` 是一条 agentd 发的 C1 消息（不是回执），整串 `c1` 照 §0–§4 的规则合法（`check_file`）；`local` 是 `{input}`，`input` 是 snapshot `reactions` 的一个触发名；或 `{input, end: true}`（v2.8）：用户结束这个触发，只用于 `pat`、`present`（`drag_lift` 的结束是 `drop`） |
| `expect` | 非空数组：渲染器发出的 `motion_state`，按发出的顺序，`t_ms_max` 不减。每项是 `{t_ms_max, motion_state}`：`t_ms_max` 是这条最晚发出的时刻（毫秒，整数 ≥ 0，夹具给一帧以上的余量）；`motion_state` 是 C3 `motion_state` 去掉 `v`、`type`、`clip`（`behavior_id`、`origin`、`phase`、`resting`、`busy`），`behavior_id` 非空时是 `steps` 里发过的行为 |
| `poses` | 可选，留给之后的骨骼姿势期望，现在只能是 `[]` |

- 测试从 0 ms 开始按 `t_ms` 喂 `steps`，到最后一条 `expect` 的 `t_ms_max` 为止；这段时间里渲染器发的 `motion_state`
  逐条等于 `expect`，不多不少，每条不晚于它的 `t_ms_max`。
- 到期按 `ttl_s` 测：夹具里的 `expires_at_ms` 都取远在测试之后的值。
