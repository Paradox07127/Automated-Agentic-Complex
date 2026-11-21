# 协议

这里放前后端进程之间的协议：消息格式、校验器、夹具或样例。前端是 Companion（Electron 外壳 `app/electron`）、角色进程（`private/renderer/host`（私有组件，不在公开仓库））和浏览器扩展；后端是 agentd 和 TTS 服务。

进程内的接口不放这里。离线资源的文件格式（例如角色包，见 `characters`）也不放这里；例外是构建端写、运行时读的角色库和角色包里运行时读的文件，它们的共享常量在 `character-library/`。

## 现行协议

| ID | 接口 | 方向 | 传输 | 版本 | 正文 | 校验器、夹具 | 谁在跑 |
|---|---|---|---|---|---|---|---|
| C1 | 行为与分句意图 | agentd → 角色进程，回执经 Companion 回 agentd | SSE `GET /events` | v2.6 | [C1-agent-events/CONTRACT.md](C1-agent-events/CONTRACT.md) | `agent/agentd/c1.py`；[C1-agent-events/fixtures/](C1-agent-events/fixtures/) | `agent/agentd/tests/test_c1.py`；`private/renderer/runtime` 的 `BridgeCoreTests` 直接读这些夹具 |
| C2 | 语音流时间轴 | TTS → agentd → 角色进程 | NDJSON `POST /speech_stream`、`GET /speech` | v2.3 | [C2-speech-stream/CONTRACT.md](C2-speech-stream/CONTRACT.md)；令牌见 [TTS-TOKEN.md](C2-speech-stream/TTS-TOKEN.md) | [C2-speech-stream/validate.py](C2-speech-stream/validate.py)；`examples/` | `agent/agentd/tests/test_speech.py` |
| C3 | 宿主通信 | Companion ↔ 角色进程 | unix socket + NDJSON | v27 | [C3-host-ipc/CONTRACT.md](C3-host-ipc/CONTRACT.md) | [C3-host-ipc/validate.py](C3-host-ipc/validate.py)；`examples/` | `app/Tests/gate.sh`（C3 examples）、`app/electron/test/c3.test.ts`、`link-messages.test.ts`、本机宿主连接测试 `run_host_link.sh`（不在公开仓库）、`HostDescribeTests`、`PreviewTransportTests` |
| C6 | Companion 与 agentd 的 HTTP 端点 | Companion ↔ agentd | HTTP、SSE `GET /feed` | v1 | [C6-agentd-api/CONTRACT.md](C6-agentd-api/CONTRACT.md)，逐条端点见其 §4 | [C6-agentd-api/fixtures/](C6-agentd-api/fixtures/) | `agent/agentd/tests/test_c6_fixtures.py`、`app/electron/test/c6.test.ts` |
| C8 | harness runner 帧协议与能力描述 | agentd ↔ 私有 runner 子进程（Codex app-server、Pi、本机 ACP agent、本机 Claude Code CLI） | stdio + NDJSON | v1 | [C8-harness-runner/CONTRACT.md](C8-harness-runner/CONTRACT.md) | [C8-harness-runner/validate.py](C8-harness-runner/validate.py)；`examples/`；单独驱动器 [drive.py](C8-harness-runner/drive.py) | `test_character_agent_transport.py`、`test_acp_runner.py`、`test_claude_runner.py`、`test_character_agent_codex.py`、`test_character_agent_pi.py`、`test_character_agent_drive.py`（`agent/agentd/tests/`） |
| C9 | agentd 进程：启动参数、退出码、`--describe`、发现文件 | Companion → agentd 进程 | argv、退出码、`<state-dir>/ui-runtime.json`、`events-runtime.json` | v1 | [C9-agentd-process/CONTRACT.md](C9-agentd-process/CONTRACT.md) | `examples/` | `protocol/C9-agentd-process/test_examples.py`、`agent/agentd/tests/test_c9_process.py`、`app/electron/test/c6.test.ts` |
| C10 | 共享文件：`blacklist.json`、`config.json` 里 agentd 读的隐私键、TTS 令牌 | agentd、Companion、浏览器 native host 之间直接读写 | 文件 | v1 | [C10-shared-files/CONTRACT.md](C10-shared-files/CONTRACT.md) | `examples/` | `protocol/C10-shared-files/test_examples.py`、`agent/agentd/tests/test_c10_shared_files.py`、`test_native_host.py`、`app/electron/test/c10.test.ts` |
| T1 | Trace 事件格式（C6 的一部分） | Companion、角色进程、agentd → agentd | `POST /trace/events` | v1 | [C6-agentd-api/T1-TRACE.md](C6-agentd-api/T1-TRACE.md) | `agent/agentd/traces/trace_format.py` | agentd 测试；渲染器的 `HostTraceSampleTests` 读 `agent/agentd/tests/trace-sample.ndjson` |
| ui-bridge | 网页 UI 的桥 op 与 agentd 路由分类 | Companion ↔ 网页 | Electron IPC（preload 的 `bridge:invoke`），推送经 `bridge:push` | 现行 | [ui-bridge/CONTRACT.md](ui-bridge/CONTRACT.md) | [ui-bridge/routes.json](ui-bridge/routes.json)、[ops.json](ui-bridge/ops.json)、[onboarding-ops.json](ui-bridge/onboarding-ops.json) | `agent/agentd/tests/test_ui_route_classes.py`、`protocol/tools/tests/`（生成文件是否最新）、`app/electron/test/bridge.test.ts`、`web/tests/unit/bridge-ops.test.ts` |
| C11 | 组件清单与组合锁 | 构建工具 → 构建端、宿主 | JSON 文件 | v1 | [C11-components/CONTRACT.md](C11-components/CONTRACT.md) | [C11-components/validate.py](C11-components/validate.py)；`examples/`；树哈希 `tools/release/component_manifest.py` | `protocol/C11-components/test_validate.py`、`tools/release/tests/test_component_manifest.py`、`app/electron/test/components.test.ts`（读 `examples/`） |
| C12 | 平台 helper：读屏、截图、OCR、按住说话、注意力采样、电脑控制、权限、剪贴板 | Electron 主进程 ↔ 每个 OS 一个原生 helper 子进程 | stdio + NDJSON | v1 草案 | [C12-platform-helper/CONTRACT.md](C12-platform-helper/CONTRACT.md) | [C12-platform-helper/validate.py](C12-platform-helper/validate.py)、[ops.json](C12-platform-helper/ops.json)；`examples/` | `protocol/tools/tests/test_c12_platform_helper.py`、`app/helpers/mac/Tests/gate.sh`、`app/helpers/windows/tests/replay.py` |
| character-library | 角色库文件（`current.json`、`character.json`、原生包）的共享常量 | 角色构建、agentd → Companion、Metal 宿主 | 文件 | v1 | [character-library/CONTRACT.md](character-library/CONTRACT.md) | [character-library/constants.json](character-library/constants.json) | `agent/agentd/tests/test_character_library_contract.py`、`CharacterLibraryContractTests`、`ActorNativeBundleContractTests` |
| ids | Bundle ID、支持目录、开发重载通知名、agentd 端口、TTS 地址等标识的共享取值；各处自留副本，清单在 `copies` | Companion、agentd、发布与 QA 工具、脚本 | 文件 | v1 | [ids.json](ids.json) | [ids.json](ids.json) | `protocol/tools/tests/test_ids.py` |

## 怎么改协议

1. 只加不改：加字段、加消息、加能力，旧的一方照常工作。改已有字段的含义要升主版本，并写清两边的过渡期。
2. 同一个提交里改正文、校验器、夹具或样例，以及两端的实现。门禁跑校验器。
3. 正文开头的「状态」行写当前版本和日期。
