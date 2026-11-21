# 接入自己的 TTS 引擎

实现一个独立的 HTTP 服务即可；Agentic Complex 通过服务地址和 Bearer 令牌连接。引擎不打包进应用。时间轴以 [CONTRACT.md](CONTRACT.md) 为准；下面包含 C2 v2.2 的 `en` 和可省略的对齐元数据。

## HTTP 接口

- `GET /health`：不需要令牌，返回 HTTP 200 和 JSON，例如 `{"status":"running"}`。无令牌的响应只报告存活状态，不返回音频、模型路径或注册表。
- `POST /speech_stream`：接收 `Content-Type: application/json` 和 `Authorization: Bearer <token>`，成功返回 HTTP 200、`Content-Type: application/x-ndjson`。逐行发送 UTF-8 JSON，不把整个响应攒到合成结束才发送。
- 缺令牌、令牌错误或不是 Bearer 认证，在输出任何流事件之前返回 HTTP 401。令牌用恒定时间比较；服务从 `AAC_TTS_TOKEN_FILE` 指定的 0600 文件读取，路径必须显式提供。
- 必填字段缺失、字段类型或取值无效、v2 分句字段不完整，在开始流之前返回 HTTP 422。不要用一条 HTTP 200 的错误文本替代这些状态。

Agentic Complex 一次只合成一个请求；引擎也应串行处理合成，不交错两条请求的 PCM 或事件。客户端断开时停止该请求、释放资源，再处理下一个请求。应用支持可信网络内的 HTTP，也可通过 `ssh -L` 使用回环 HTTP；不要求引擎内置 TLS。

## 请求 JSON

字段来自 `agent/agentd/voice/speech.py` 的 `SpeechRelay._run` 和 `add_clause`。所有请求都含以下字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `character` | string | 当前角色的 TTS 标识；不是固定的角色枚举 |
| `language` | string | `zh`、`ja` 或 `en`；在 begin 中回传为 `lang` |
| `text` | string | 要合成的文本；现有适配器接受 1–1500 字符 |
| `allow_unvalidated_pilot` | boolean | agentd 发送 `true`；GPT-SoVITS 预览未验收 pilot 的许可 |
| `accelerated` | boolean | agentd 发送 `true`；GPT-SoVITS 的加速请求 |
| `session_epoch` | string | 会话代际，每条事件原样带回 |
| `turn_id` | string | 当前轮次，每条事件原样带回 |
| `speech_id` | string | 本条流的唯一标识，每条事件原样带回 |
| `expires_at_ms` | integer | Unix 毫秒过期时间，在 begin 中原样带回；样本时间轴不用它计时 |

其他引擎可以接受但忽略 `allow_unvalidated_pilot`、`accelerated`，无需模拟 GPT-SoVITS 的训练或加速实现。

v2 请求另外带以下八个字段。一条请求只合成一个分句；同一句台词的分句按 `clause_index` 顺序各发一次请求。

| 字段 | 类型和范围 | 含义 |
|---|---|---|
| `utterance_id` | string，1–64 UTF-8 字节 | 一句台词的标识 |
| `clause_id` | string，1–64 UTF-8 字节 | 分句标识，同一 utterance 内唯一 |
| `clause_index` | integer ≥ 0 | 从 0 开始的分句次序 |
| `spoken_text_revision` | integer ≥ 1 | 台词文本版本 |
| `voice_profile_id` | string，1–64 UTF-8 字节 | 声音配置标识，例如 `aide.zh.default` |
| `interrupt_policy` | `immediate` 或 `clause_end` | 立刻打断或播完当前分句 |
| `turn_generation` | integer ≥ 0 | 对话代际 |
| `trace_id` | UUID string | 对话 trace 标识 |

有 `utterance_id` 时返回 v2，前七个分句字段必须一起提供，缺失或部分提供返回 422。agentd 当前还会提供 `trace_id`；现有 GPT-SoVITS 适配器在请求侧允许省略它，由 agentd 在转发 begin 时补写。直接实现完整 v2 时，begin 必须包含上表八项，收到的值原样带回。没有分句字段的旧请求返回 v1，不要求旧客户端提供这些字段。

## 最小流

所有事件都带 `event`、`session_epoch`、`turn_id`、`speech_id`、`seq`。`seq` 是从 0 开始、每行加 1 的整数，按实际输出顺序分配。

1. 第一行必须是 `speech.begin`，`seq=0`。v1 用 `schema: "endfield-speech-timeline-v1"`；v2 用 `schema: "endfield-speech-timeline-v2"` 并带回八个 v2 字段。两种流都带 `clock: {"unit":"sample","sample_rate":48000,"origin":"first_pcm_sample"}`、`format: "pcm_s16le"`、`channels: 1`、`lang`、`engine`、`expires_at_ms`。
2. 合成时发送一条或多条 `audio`：`segment_index`、`start_sample`、`samples`、`pcm_base64`。PCM 是 **48 kHz、有符号 16 位小端、单声道**；先转换到此格式再发送。`pcm_base64` 解码后必须正好是 `2 * samples` 字节。首块 `start_sample=0`，后块从前块的 `start_sample + samples` 接续，不重叠、不留空隙。计数单位始终是样本，不是字节、毫秒或网络到达时间。
3. **`complete` 必发**：每条正常完成的流都以它结束，即使没有 `segment` 或 `cues`。带 `total_samples`（所有 audio 的样本总数）、`segments`（实际发出的 segment 数）和 `cues_complete`；不能用直接断开或 EOF 代替。合成完成与用户播放完成是两回事。

`speech.begin.engine` 沿用 GPT-SoVITS 形式 `{"gpt_sovits_commit":"1b47ca07","variant":"v5dev"}`。`lang` 支持 `zh`、`ja`、`en`。`engine.voice_fingerprint` 仍是契约规定的可选字段。

### 不提供音素对齐（C2 v2.2）

`segment` 和 `cues` 都是可选事件。最小引擎可以只发送 `speech.begin → audio… → complete`，不生成假的 phones、语义 token 或对齐结果。完全不发 segment/cues 时：

- 每条 `audio.segment_index` 设为 **0**。
- `complete.segments` 设为 **0**，`complete.cues_complete` 设为 **true**，`total_samples` 仍为实际 PCM 样本数。
- 渲染器从 PCM 驱动嘴部运动。

能够提供 segment 时，其字段及 `speech_samples = 1920 * semantic_tokens` 等约束仍按契约执行；不能为满足此等式编造 token 数。能提供 cues 时，cue 区间必须落在对应 segment 的语音范围内，phone 到元音映射使用 [phone-vowel-map.json](phone-vowel-map.json)。同段 cue 用更高 revision 整体替换，`cues_complete: true` 表示后面不会再有 cues，并不表示每段都有某个固定 revision。提供 segment 但不提供 cues 时，也可在最后用 `cues_complete: true` 结束。

### 取消和错误

正常结束必须发 complete；已开始的流若取消或失败，按契约改用 `cancelled` 终止，带 `reason`（`client_cancel`、`superseded` 或 `error`）和 `last_sample_sent`，不再伪装成正常完成。连接已经断开时无需向断开的连接强发结束行。`immediate` 允许立即截断当前请求；`clause_end` 应让当前分句正常流到 complete，只停止后续分句。

消费方会丢弃不匹配当前会话、轮次、speech，或过期、旧代际、旧文本版本的事件；引擎必须正确回传标识和代际，不能用本机固定值代替。`stream_seq` 和 `stream.*` 是 agentd 到角色进程之间的中继游标协议，外部引擎不生成它们。
