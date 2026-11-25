# C2 语音流时间轴 v2.3

> 角色进程指私有渲染器的 `metal-avatar-host`。

状态：v2，2026-10-19 由协调会话定稿（audio、agent、animation 同意）；v2.1 2026-10-23 由协调会话加：同代际停声（规则 8 第 3 条子项）；v2.2 只加字段：`en` 和不带对齐的流（见 v2.2 节）；v2.3 2026-11-12 修正规则 9 的播放器等待行为，线上字段和 schema 保持原样。v1 2026-10-18 定稿。
参与方：音频组（TTS 主机上的 TTS 服务，生产方）→ Agent 组（agentd，唯一的 TTS 客户端，原样转发）→ 角色进程（消费方，渲染器的 `AgentSpeechSession`）。
改这份合同要先找协调会话；三方同意后升版本号。

## 传输

- 一行一个 JSON 对象（NDJSON），UTF-8。
- TTS 主机 → agentd：沿用服务现有的 HTTP 流式响应。agentd → 角色进程：loopback HTTP 流，路径由 agentd 定（`GET /speech`，见 `protocol/C6-agentd-api/CONTRACT.md`）。
- agentd 只改写 `session_epoch`、`turn_id`（换成自己的会话代际），其余字段原样转发。

## 时间基准

- 所有时间都是整数样本，`sample_rate` 固定 48000。
- 第 0 个样本 = 本 speech 第一个 `audio` 事件的第一个样本。不用墙钟和网络到达时间。

## 事件

每行都有 `event`、`session_epoch`、`turn_id`、`speech_id`、`seq`（从 0 起，每行加 1）。

| event | 必填字段 | 说明 |
|---|---|---|
| `speech.begin` | `schema`=`"endfield-speech-timeline-v1"`、`clock{unit:"sample",sample_rate:48000,origin:"first_pcm_sample"}`、`format`=`"pcm_s16le"`、`channels`=1、`lang`（`zh`/`ja`）、`engine{gpt_sovits_commit,variant}`、`expires_at_ms` | 第一行，seq=0 |
| `segment` | `segment_index`、`norm_text`、`phones[]`、`start_sample`、`semantic_tokens`、`token_hop_samples`=1920、`speech_samples`=1920·`semantic_tokens`、`tail_silence_samples` | 中文另带 `word2ph[]` |
| `audio` | `segment_index`、`start_sample`、`samples`、`pcm_base64` | 必须连续：`start_sample` = 上一个 audio 的 `start_sample + samples` |
| `cues` | `segment_index`、`revision`（≥1）、`source`（`mfa`/`qwen3-fa`/`mrte-attn`/`ulipsync`/`rms`）、`items[{start,end,phone,vowel,weight,confidence}]` | `vowel` ∈ a/i/u/e/o；可以晚于对应 audio 到达 |
| `complete` | `total_samples`、`segments`、`cues_complete` | 正常结束 |
| `cancelled` | `reason`（`client_cancel`/`superseded`/`error`）、`last_sample_sent` | 异常结束 |

## 规则

1. 每个 `cues.items[i]` 必须落在 `[segment.start_sample, segment.start_sample + speech_samples)` 内，`start < end`，`0 ≤ weight ≤ 1`。违反的 item 丢弃，嘴归中性，不硬凑元音。
2. 同一 `segment_index` 收到多次 `cues` 时，以 `revision` 最大的那次整体替换该段的 cue。
3. 角色进程只应用 `end` 大于当前播放游标的 cue。
4. 取消以角色进程本地为准：角色进程先停播放、清空 cue、嘴归中性，再通知 agentd；不等服务端的 `cancelled`。
5. `session_epoch`、`turn_id`、`speech_id` 任一不匹配当前播放，或超过 `expires_at_ms`，整行丢弃。
6. phone → 元音的映射以 `protocol/C2-speech-stream/phone-vowel-map.json` 为准（用户 2026-10-18 审定，animation 编写）。映射里每项给 `vowel` 和 `weight`；映射表里没有的 phone 不出 cue。
7. `complete.cues_complete=true` 表示本条流之后不会再有 `cues` 行，不表示每段都有最高 revision。某段缺少更高 revision（例如中英混排段没有 MFA 的 revision 2）时，原因写在 `complete.result.cue_warnings`；这一段沿用已收到的最高 revision。

## v2 新增（2026-10-19）

v2 只在 v1 上加东西；没写到的照上面 v1 的各节。

### v2-1. 一条流 = 一个分句

- 一条 C2 流（一次 `POST /speech_stream`）只合成一个分句（clause）。一句台词（utterance）拆成几个分句，就有几条流，按 `clause_index` 顺序请求和播放。
- `speech_id` 仍然每条流唯一。

### v2-2. `speech.begin` 新增字段

| 字段 | 类型 | 谁写 | 含义 |
|---|---|---|---|
| `schema` | `"endfield-speech-timeline-v2"` | TTS | v2 流 |
| `utterance_id` | 字符串，≤ 64 字节 | agentd 在请求里给，TTS 原样带回 | 一句台词一个 |
| `clause_id` | 字符串，≤ 64 字节 | 同上 | 一个分句一个；同一 `utterance_id` 内唯一 |
| `clause_index` | 整数 ≥ 0 | 同上 | 分句在这句台词里的顺序 |
| `spoken_text_revision` | 整数 ≥ 1 | 同上 | 这句台词的文本版本。改写后重合成时加 1 |
| `voice_profile_id` | 字符串，≤ 64 字节 | 同上 | 角色加声音的配置（例如 `aide.zh.default`） |
| `interrupt_policy` | `"immediate"` 或 `"clause_end"` | 同上 | 被打断时：`immediate` 立刻停；`clause_end` 播完当前分句再停 |
| `turn_generation` | 整数 ≥ 0 | agentd 改写（和 `turn_id` 一样） | 对话代际 |
| `trace_id` | UUID 字符串 | agentd 改写（和 `turn_id` 一样） | T1 的 trace_id（protocol/C6-agentd-api/T1-TRACE.md）；角色进程发 `playback.*` 事件时带上它和 `turn_id`（host 2026-10-19 提） |
| `engine.voice_fingerprint` | 64 位小写十六进制，可选 | TTS | 声音身份：把 `{engine{gpt_sovits_commit,variant}, run, gpt_sha256, sovits_sha256, frontend_lexicon_sha256, reference{wav_sha256,text_sha256,inference_parameters}}` 用 `json.dumps(sort_keys=True, separators=(',',':'), ensure_ascii=False)` 序列化，取 UTF-8 字节的 sha256 |

agentd 仍然只改写 `session_epoch`、`turn_id`、`turn_generation`、`trace_id`，其余字段原样转发。

什么时候发 v2：请求里带 `utterance_id` 时，TTS 发 v2 流，上表中由请求给的 7 个字段（`utterance_id`、`clause_id`、`clause_index`、`spoken_text_revision`、`voice_profile_id`、`interrupt_policy`、`turn_generation`）必须一起给，缺一个回 HTTP 422。请求里不带 `utterance_id` 时，照旧发 v1（过渡期旧客户端不用改）。

### v2-3. 新增规则（接在上面的规则 7 之后）

8. 丢弃：`turn_generation` 小于当前对话代际的整条流丢弃。角色进程的当前代际 = 同一 `session_epoch` 内见过的最大 `turn_generation`，来源包括 C2 流的 begin 和打断信号（C1 的 `speech.cancelled`、state 快照，C3 的 `stop_speech`，这三处都要带 `turn_generation`：C1 归 agent，C3 在 v10 里加，归 host）；`session_epoch` 换了就重置。打断信号先到、新流还没来时，旧代际的迟到行照样丢弃。同一 `utterance_id` 收到更大的 `spoken_text_revision` 后，旧 revision 的流和它们的回执都不再生效（验收：重合成后旧 clause 的回执不生效）。
   - 「整条流丢弃」指还没开始播的行和分句。代际升高时已经在播的那个分句：
     - 代际是由显式打断升高的（C1 `speech.cancelled`、C3 `stop_speech.turn_generation`）：不管 `interrupt_policy`，立刻停。agentd 对按住说话、`/turn/cancel`、停止、切换角色、`POST /speech/cancel` 都发显式打断。
     - 代际没变、C1 `speech.cancelled` 带 `utterance_id`（agentd 对“静音”和隐藏角色发这种）：这条 utterance 正在播的分句不管 `interrupt_policy` 立刻停；等待中的和之后才到的分句丢弃。不带 `utterance_id` 的同代际 `speech.cancelled` 不停任何分句。
     - 代际只由新流的 `begin` 或 state 快照升高（例如用户在主动台词播放中打了一句新话）：按这个分句的 `interrupt_policy`。`immediate` 立刻停；`clause_end` 播到它的 `end`，新代际的分句等它播完再播。
9. 顺序：播放器按 `clause_index` 播放同一 `utterance_id` 的分句。收到 `cancelled` 的分句可跳过。前一分句播完 1500 ms 后，若缺少期望分句的 begin 且已有更高序号的分句在等，跳到下一段已收到的分句，丢弃之后才到的旧序号。没有后续分句在等时，继续接受当前期望序号的 begin，并按原有的有效期、代际及取消规则检查。
10. 打断：`immediate` 时按 v1 规则 4 立刻停。`clause_end` 时播完当前分句，后面的分句不再播。`clause_end` 时 agentd 和 TTS 不截断当前分句的流，也不给它补 `cancelled` 行，只是不再发后面的分句；当前分句照常发到 `end`。
11. 回执：播放回执（经 C3 v10 转发）带 `speech_id`、`utterance_id`、`clause_id`、`spoken_text_revision`，按第 8 条判断是否生效。

### v2-4. 鉴权

- agentd 请求 TTS 时带 `Authorization: Bearer <token>`。缺令牌或令牌错，TTS 在发任何流之前回 HTTP 401。
- TTS 主机上的服务从环境变量 `AAC_TTS_TOKEN_FILE` 指的文件读令牌。文件权限必须是 0600，更宽就拒绝启动。默认路径：TTS 主机上是 `<TTS 根目录>/state/tts-token`，agentd 客户端从系统凭据存储读取令牌（见 C10）。
- 令牌由 agent 在 Mac 上生成，安装时用 ssh 拷到 TTS 主机；生成、拷贝和轮换的细节见 `protocol/C2-speech-stream/TTS-TOKEN.md`。服务端比较令牌用 `hmac.compare_digest`。
- 要令牌的端点：所有 POST 端点和 `GET /artifacts/...`。`GET /health` 不要令牌：隧道和 Companion 用它查存活，它不返回音频。

### v2-5. 兼容

- v1 流（`schema`=`endfield-speech-timeline-v1`）在过渡期仍然合法。角色进程收到 v1 流时，把它当作只有一个分句、`interrupt_policy`=`immediate` 的台词。
- `validate.py` 按 `schema` 分开检查：v2 流必须有 v2-2 节除 `voice_fingerprint` 外的所有字段，`clause_index` 和 `spoken_text_revision` 的取值范围要对。
- 所有方都切到 v2 后，再定什么时候不收 v1。

### v2-6. agentd → 角色进程一段的流游标（2026-10-19 附加）

- 只在 agentd → 角色进程这一段（`GET /speech`）。TTS 的输出和 `validate.py` 不变。
- agentd 转发的每行顶层多一个 `stream_seq`（中继缓冲的序号）。其余字段照 v2-2 节原样转发。
- agentd 另发三种控制行：`stream.hello`、`stream.reset`、`stream.gap`。它们不属于任何语音，没有 `session_epoch`、`turn_id`、`speech_id`、`seq`。角色进程解析语音时跳过 `event` 以 `stream.` 开头的行。
- 游标、补发和三种控制行的字段以 `protocol/C6-agentd-api/CONTRACT.md` §4.2 的 `GET /speech` 一行为准。收到 `stream.reset` 或 `stream.gap` 时，消费端重新取 state 快照。

## v2.2 新增：`en` 和不带对齐的流

v2.2 只加字段；没写到的照上面 v1、v2 的各节。

- `lang` 增加 `en`，取值为 `zh`、`ja`、`en`。
- 流可以不发 `segment` 和 `cues`；这时 `audio.segment_index` 恒为 0；`complete.segments`=0、`complete.cues_complete`=true。音频仍是 48000 Hz、`pcm_s16le`、单声道。
- `schema` 仍是 `endfield-speech-timeline-v2`：只加了字段，旧的消费方照 v2 解析即可。
- 不带 `utterance_id` 的请求照旧回 v1 流（v2-2 节「什么时候发 v2」）。

## 参照实现

- `validate.py <file.ndjson>`：按上面的字段和规则 1、2、连续性检查一条流，v2 流另查 v2-2 节的 begin 字段；返回 0 表示合法。
- `examples/`：合法样例 `ok-*.ndjson`，非法样例 `bad-*.ndjson`。`test_validate.py` 要求前者全过、后者全拒。
