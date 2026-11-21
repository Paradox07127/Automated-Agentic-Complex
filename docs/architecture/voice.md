# 语音合成服务

[English](voice.en.md) · [文档索引](../README.md)

## 概述

`voice/tts-service/` 是基于 GPT-SoVITS 的 HTTP 语音合成服务，跑在带 NVIDIA GPU 的 TTS 主机上。agentd 按 [C2 语音流](../../protocol/C2-speech-stream/CONTRACT.md)调用它的 `POST /speech_stream`；接入别的引擎见 [TTS 引擎接口](../../protocol/C2-speech-stream/ENGINE.md)。部署和连接见[部署语音服务](../guides/tts-deploy.md)。

## 文件

| 文件 | 内容 |
|---|---|
| `serve_tts.py` | FastAPI 服务。`python serve_tts.py [port] [--listen-address ADDR]`，默认端口 9888、地址 `127.0.0.1` |
| `auth.py` | 读令牌文件；ASGI 中间件 `TokenAuth` 检查 `Host` 和 Bearer 令牌 |
| `model_residency.py` | 同时只驻留一个模型；载入前检查 GPU 剩余显存，不够时请求回 HTTP 503 |
| `tts_runtime.py` | 载入 `<TTS 根目录>/runs/<run>/` 里已选的权重并合成；装上 `SegmentRecorder` |
| `segment_meta.py` | 片段元数据记录（`SegmentRecorder`，含 MRTE 注意力抓取）和 C2 事件生成（`C2Stream`） |
| `cues.py` | `cues` 事件：MRTE Viterbi（revision 1）、phone→元音映射、MFA 子进程客户端（`MfaClient`）和每条流的 cue 收发（`CueStream`）。只依赖标准库和 numpy |
| `mfa_worker.py` | MFA 子进程（kalpy 进程内对齐，CPU，beam 10），stdin/stdout 一行一个 JSON |
| `requirements-mfa.lock` | MFA 子进程环境的 Linux Conda 显式工件 URL 和 MD5 清单 |
| `test_*.py` | 单测，用假引擎和假 MFA 子进程 |
| `deploy/` | Docker 部署：`Dockerfile`、`compose.yaml`、`deploy.sh` |

## 端点

| 端点 | 格式 |
|---|---|
| `POST /speech_stream` | C2 语音流，响应 `application/x-ndjson`，每行一个 C2 事件 |
| `GET /health` | 服务状态；无有效令牌时只含 `status` |
| `POST /synthesize`、`POST /synthesize_stream`、`GET /artifacts/{id}/{audio,timing}` | 旧格式。`/synthesize` 写 WAV 并给 `audio_url`；`/synthesize_stream` 默认不写文件 |

## 连接与令牌

- 服务启动时从环境变量 `AAC_TTS_TOKEN_FILE` 指的文件读令牌，没设就拒绝启动。文件以 `O_NOFOLLOW` 打开并用 `fstat` 检查：不存在、为空、是符号链接、所有者不是当前用户或有任何 group/other 权限位时，服务拒绝启动。
- HTTP 和 WebSocket 先检查 `Host`，只接受 `127.0.0.1`、`localhost`、`[::1]`（可带端口）。其他值回 HTTP 400（`{"detail":"Invalid host header"}`），WebSocket 在 accept 前以 1008 关闭。环境变量 `AAC_TTS_REMOTE=1` 时接受任意 `Host`。
- 除 `GET /health` 外，所有 HTTP 请求和 WebSocket 都要带 `Authorization: Bearer <token>`，令牌用恒定时间比较。缺令牌或令牌不对时回 HTTP 401（`{"detail":"Unauthorized"}`），WebSocket 在 accept 前以 1008 关闭，不开始任何流。

## 口型 cue

`/speech_stream` 先发 `speech.begin`，再对每个句段片段依次发 `segment`、该段的 `audio` 和该段 revision 1 的 `cues`。

| revision | source | 方法 | `confidence` |
|---|---|---|---|
| 1 | `mrte-attn` | 合成时在 `enc_p.mrte.cross_attention` 上挂 hook，取目标句的注意力，用单调 Viterbi 求每个 phone 的帧区间（中文用第 0 头，日语用 4 头均值；停顿只放在片段首尾和标点处）。一帧 960 样本 | phone 在其帧上的平均注意力，[0,1] |
| 2 | `mfa` | `mfa_worker.py` 对该段语音部分（不含尾静音）做 MFA 对齐，映射回 GSV phone。只用 beam 10，对不上不重试 | 1.0 |

- MFA 只在设了 `AAC_MFA_PYTHON` 时启用（见[部署语音服务](../guides/tts-deploy.md)）。revision 2 在 MFA 回复到达时发出，可能夹在后面片段的行之间。客户端用 revision 大的整体替换同段的 cue。
- 合成结束后，服务最多再等 5 秒，收齐本条流已提交的 MFA 回复，然后发 `complete`。有段没等到时 `cues_complete` 为 `false`，之后到达的回复丢弃。`complete.result.cue_warnings` 列出没有 revision 2 的段：`error` 为 `beam`（beam 10 对不上）、`mfa_timeout`（超时），或 MFA 子进程报的其他错误。这些段只有 revision 1。
- 混了英文的段：GSV 按语言把文本分成几部分，服务记下每部分的语言和 phone 区间，只用在服务内部和 MFA 请求里，不进 C2 的 `segment`。MFA 的 transcript 里每个英文部分写一个 `<unk>`，由声学模型的 `spn` 音素吸收；英文期间没有 revision 2 的 cue。MRTE 把英文 phone 当作普通 phone 列，不当静音。
- 两个 revision 都只出 `protocol/C2-speech-stream/phone-vowel-map.json` 里有的 phone，`vowel`、`weight` 取表值；区间裁到该段的语音范围，裁空的丢掉。
- `seq` 的分配和入队在同一把锁里，合成线程和 MFA 回复线程交错写出时 `seq` 仍按输出顺序递增。
- 服务在每个片段上核对：vocoder 吃的 phones 与记录的文本段相同；片段样本数等于 `1920 × 语义 token 数 + 尾静音`；MRTE 注意力形状符合。不一致时这条流以 `cancelled{reason:"error"}` 结束，不发错误的元数据。

## 取消

客户端断开后（`/speech_stream` 和 `/synthesize_stream` 一样），合成在下一次写出时、下一个语义 token（T2S 每步的 `ar_predict_layer`）之前或下一个 CFM 步之前停下，然后释放 GPU 锁，排队的下一个请求接着做。已经排进 GPU 队列的计算会先跑完。迟到的 MFA 回复直接丢弃。

## 测试

单测只需要 numpy，不需要 torch 或 kalpy：

```sh
cd voice/tts-service && ../../agent/.venv/bin/python -I -m unittest discover -s . -p 'test_*.py'
```
