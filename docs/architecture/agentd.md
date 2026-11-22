# agentd

[English](agentd.en.md) · [文档索引](../README.md)

agentd 是角色一侧的后台服务，Python 3.12 实现，只监听 127.0.0.1。它接收 Claude Code 和 Codex 的 hook，维护多会话登记和焦点，代理 Claude 的审批，向角色进程推行为与意图，并运行角色的对话、任务、记忆和观察。HTTP 端点的字段和错误码见 [C6 合同](../../protocol/C6-agentd-api/CONTRACT.md)（§3 总表、§4 细则），进程参数和发现文件见 [C9 合同](../../protocol/C9-agentd-process/CONTRACT.md)，工具授权见[工具网关](tool-gateway.md)。

## 概述

- 依赖在 `agent/agentd/requirements.txt`（HTTP 客户端 `httpx`、OIDC 校验 `PyJWT`）。
- agentd 自己不安装 hook，不改 `~/.claude`、`~/.codex`。只观察的 hook 由用户运行 `tools/install_hooks.py` 安装（见「hook 安装」）。
- Companion 经 `app/Resources/agentd_launcher.py` 启动它；单独运行的命令见 [C9 合同](../../protocol/C9-agentd-process/CONTRACT.md)末节。

## 代码结构

新模块放进所属的领域包；根目录只收包外有东西按路径或顶层模块名引用的文件。代码分三层：入口 `server.py` → `daemon/` 和 `api/` → 各领域包 → `infra/`。领域包不导入 `daemon/`、`api/`；`infra/` 不导入上面任何一层。

| 包 | 内容 |
|---|---|
| `api/` | HTTP `Handler`（`api/handler.py`：`parse_request` 的关卡、`_dispatch` 把请求交给 `route_registry.py` 里这条路由的 owner）；按 URL 前缀分开的 mixin：`hooks`、`sessions`、`memory`、`episodes`、`observation`、`context`、`speech`、`diag`、`character`、`settings`；`views.py` 是 `api/` 和 `daemon/` 共用的视图与字段检查；`integration.py` 是外部 agent 接入的 `/integration/*` 路由（[INTEGRATION.md](../../protocol/C6-agentd-api/INTEGRATION.md)） |
| `daemon/` | `main.py`（参数、启动顺序、服务循环）；`agentd_server.py` 的 `AgentdServer` 和 `StateView`；按关注点分开的 mixin：`announce`、`turns`、`speech_control`、`context`、`switches`、`ingest`、`character_switch`、`rituals_glue`、`memory_sync`、`tracing`、`diagnostics`、`lifecycle`；共用常量 `constants.py` |
| `infra/` | SQLite 存储与表结构（`store`、`store_schemas`、`data_lifecycle`）、0600 令牌文件（`tokens`）、状态路径（`paths`）、提示里的本地时间（`localtime`）、平台差异（`platform/`） |
| `sessions/` | 事件归一化、会话登记、审批与危险判定（`approvals`、`danger`）、自有会话与派活（`own`、`lifecycle`、`dispatch`、`tasks`）、会话摘要、harness 账本与日报 |
| `observation/` | 注意力时间线与黑名单、截图与看图（`capture`）、隐私与授权（`privacy`）、现场判断与用户状态、桌面时间线（`timeline`）、桌面呈现、空间行为与朝向 |
| `personal/` | 事实记忆、个人时段、聊天记录与对话、提醒、定时任务、点按仪式、工作记忆 |
| `character/` | 她自己的状态（`character_state`）、行为 tick（`behavior`）、主动说话的闸门与判断（`gate`、`judge`、`proactive`）、想法（`thoughts`）、互动档位（`interactions`）、给外壳的编号事件（`feed`）、角色绑定和动作图、mod 设置路由 |
| `voice/` | C2 语音转发（`speech`）、按分句切回复（`clauses`）、按需启动 TTS（`tts_ensure`）、声音来源、语音测试 |
| `models/` | ChatGPT 登录（`model_auth`）、模型设置（`model_backends`）、用量与费用（`usage`）、能力快照（`capabilities`） |
| `motion/` | 动作目录、生成与导入（含 ZIP 导入）、动作设置和 `/motion*` 路由 |
| `traces/` | T1 trace 格式校验（`trace_format`）和存储（`trace_store`） |
| `tool_gateway/` | 工具网关，见[工具网关](tool-gateway.md) |
| `brain/` | 「嘴」：按 id 读角色卡、设定和默认角色（`characters`）、角色卡排版（`persona`）、关键词设定（`lorebook`）、交给角色内核写台词（`provider`）、行内标记、确定性命令（`parser`）、出站守卫与出站检查（`outbound`、`egress`） |
| `character_agent/` | 角色主会话与可替换内核，见「角色内核」 |
| `tools/` | 单独运行的脚本：`install_hooks.py`、`tts_token.py`、自有会话的桌面控制 MCP 门面 `computer_use_mcp.py`、外部 agent 接入 CLI `agentic_complex.py` |
| `tests/` | unittest 测试、假 CLI（`fakes/`）、夹具（`fixtures/`）和共用的 `support.py` |

### 根目录文件

根目录有 13 个 `.py` 文件，每个都有包外的东西按路径或顶层模块名找它：

- `server.py`：入口；`app/Resources/agentd_launcher.py` 按路径启动它。
- `codex_hook_forward.py`：hook 转发器；`config-examples/` 的 hook 配置和 `tools/install_hooks.py` 写进用户配置的命令按路径调它。
- `c1.py`：C1 消息校验；`python3 -I agent/agentd/c1.py protocol/C1-agent-events/fixtures` 校验夹具。
- `route_registry.py`：HTTP 路由登记；`protocol/tools/gen_routes.py` 导入它，生成 `protocol/ui-bridge/routes.json`、C6 路由表和网页的 `agentd-routes.generated.ts`。
- `control_panel.py`：对话与自有会话的控制面板路由（`/conversations*`、`PUT/DELETE /sessions/<id>`）。
- `character_tool.py`、`motion_tool.py`、`outfit_tool.py`、`distribution_seed.py`：Companion 按脚本路径运行的角色包、动作、外观和发行角色库工具。发行版 Python 带 `-I`，这些脚本自己把所在目录加进 `sys.path`。
- `character_library.py`、`resource_store.py`：角色库的校验与发布、写时复制；`characters/` 的构建脚本按顶层模块导入它们。
- `fsutil.py`：整文件原子替换。
- `pool_codec.py`：角色池文件的压缩容器；`character_library.py`、`tools/release/` 和 `characters/` 的构建脚本导入它。

### 开发约定

- 导入一律写绝对路径（`from observation.blacklist import X`）；相对导入只在 `character_agent/harness/` 里有。搬模块时改调用方，不留兼容转发模块。
- 新 HTTP 路由就是在 `route_registry.py` 的 `REGISTRY` 里加一条 `Route(...)`：由 `Handler` 自己答的写 `owner=SERVER` 和 `action`（`Handler` 的方法名），别的 owner 由那个模块的 `route()` 答；`spec` 指向写这条路由字段的合同。改完在仓库根目录运行 `python3 -I protocol/tools/gen_all.py --write`。
- 令牌由 `parse_request` 按登记里这条路由的 `tokens` 检查：不在登记里的路径 404，令牌不对 401。
- 角色名单、卡和设定都取角色库（`brain/characters.py` 的 `Repository`）。

## 状态目录与令牌

`--state-dir` 下的令牌和发现文件（`hook.token`、`ui-runtime.json`、`events-runtime.json`）由 [C9 合同](../../protocol/C9-agentd-process/CONTRACT.md)定义。三种令牌分开：

- hook token 给 hook 和浏览器 native host，拿不到提交审批决定的权限。
- ui token 给外壳，可以调 UI 路由。
- events token 给角色进程，只能读 `GET /events`、`GET /state`、`GET /speech` 和 `GET /character/state`。

同一用户的任意进程都能读这些文件，这不是沙箱。

审批截止时间 = `--hook-timeout`（默认 60 s）减 `--margin`（默认 5 s），必须短于 Claude 配置里 PermissionRequest hook 的 timeout。

## 退出

收到 SIGTERM、SIGINT，或启动它的父进程退出（`--exit-with-parent`，默认开）时，agentd 按这个顺序关闭：

1. 停接任务：`POST /sessions*`、`POST /say` 和 Claude 的 PermissionRequest hook 回 503 `{"error": "shutting_down"}`，读端点照常。
2. 撤掉所有待决卡（等着的 hook 回 `{}`）。
3. 打断忙着的自有会话，停掉全部自有会话进程，总共最多等 5 s。每个自有会话进程在自己的进程组里，停止时信号发给整组，CLI 自己起的子进程一起结束。
4. 停服务。

## 模型与凭据

- `model-settings.json` 保存各后端连接和 API Key；`chatgpt-auth.json` 保存安装标识、各账号注册和令牌。两者都在 `--state-dir` 下，以 0600 原子写入。HTTP 读端点和 UI 不返回凭据。
- 没保存过设置时 provider 为 `chatgpt`。保存后只影响后续请求。
- ChatGPT 订阅：在系统浏览器登录，回调校验 state、PKCE（S256）、ID token 和 nonce；只有授权里有 `chatgpt.tokens.use.direct` 才允许推理。刷新按连接串行，并加文件锁。订阅令牌只发往 `https://api.openai.com/v1`，不读取或复用 Codex 应用的登录文件。退出时尝试撤销远端刷新令牌。
- OpenAI 与兼容 API：Base URL 只收 https，或本机（localhost、127.0.0.1、::1）的 http。输出上限默认 4096 token，可设 128–32768。DeepSeek 固定官方地址 `https://api.deepseek.com`，必须有 Key。
- 自有 Claude、Codex 工作会话仍由各自 CLI 管理登录，模型设置不改变它们。
- 端点规则见 C6 §2。

## 用量与计价

用量按天、模型和用途记在 `agentd.sqlite` 的 `model_usage`，每行带渠道明细。`GET /diag/state` 的 `budget.model` 给合计、`by_call`、`by_channel`、`usage_missing`（用量缺失或不完整的调用数）和 `pricing_unverified`（用量完整但价格条件无法核实的调用数）。

- Anthropic 官方直连：模型费率已知、用量与缓存写入完整，且响应确认标准服务层、标准速度和 global 或 us 地域时才计价；us 地域乘 1.1。
- DeepSeek 官方直连：用量完整时按 Flash、Pro 的输入、缓存命中和输出费率计价；工作日 UTC 01–04 时、06–10 时按两倍算。
- Pi 内核报告的目录价格估计照用。订阅、代理和其他未知费率不计价。

数额是 agentd 可核实部分的估计，不是供应商账单；外部 CLI 会话不计入。

## 出站守卫与遮蔽

- 出站守卫：agentd 读 `<state-dir>/canon-windows.json`（有这个文件就用它，即使它不合法），没有时用随包的 `brain/canon-windows.json`。文件是原作台词每 7 个内容字（去掉标点和空白）的哈希，不含原文。文件读不出或格式不对时 agentd 不启动。
- 我们写给模型的文本（角色卡、示例、设定、每轮提示）和重发的模型回复，发出前都过守卫：有任何一段 7 字和原句相同就不发请求（`OutboundBlocked`）。`outbound-guard.jsonl` 只记段名、字数和命中数。
- 用户输入和屏幕内容不拦，只遮蔽 API key、令牌、邮箱、电话（`--redact` 默认开，`--no-redact` 关）。遮蔽次数按类累计，供诊断页读。

## 角色与对话请求

- `--character <id>` 选启动时的角色，不给时用角色库的 `default_character`。运行中用 `/character/prepare`、`commit`、`abort` 三步换角色（C6 §4.2）。agentd 不存角色，重启时由 Companion 传 `--character`。
- 角色卡和设定只有一个来源：`--character-catalog` 传入的角色库。没有这个参数时读 `AGENTD_DEV_CATALOG`，再没有就读公开样例库 `characters/sample-library/current.json`（只有纯文字角色 `aide`）。卡、设定和默认角色读时不改写。
- 角色卡（`<id>/persona.json`，10 节）渲染成 system。每轮另加：用户说过或确认过的记忆、关键词命中的设定条目（`<id>/lore.json`：world、relations、events，带 sticky、cooldown 和 token 预算），以及现场情况。
- 现场情况里的审批：每张待批卡写会话、工具、摘要和剩余时间；600 s 内结束的卡（最多 3 张）写结果。她自己的状态偏离平常时（很困、很投入、心情离基线较远）加一句摘要，这句也过出站守卫，被拦时整句不加。
- 现场材料和低信任记忆标明是材料、不是指令。聊天历史只存用户原话；发给模型的是最近 8 轮。
- 会话、注意力时间线和记忆不分角色。

## 语音

- 启动时给 `--tts-url` 才有语音。例如 TTS 在远端主机时用 `ssh -N -L 19888:127.0.0.1:9888 <主机>`，再给 `--tts-url http://127.0.0.1:19888`。
- 请求带 `Authorization: Bearer <令牌>`。令牌文件取 `--tts-token-file`，没给时取 `$AAC_TTS_TOKEN_FILE`（C10）；文件必须是 0600。在仓库根目录运行 `agent/.venv/bin/python agent/agentd/tools/tts_token.py push --ssh user@host --remote /srv/agentic-complex-tts/state/tts-token` 生成令牌并复制到 TTS 主机。将示例里的账户、主机和部署根目录换成实际值，随后重启 TTS 和 agentd。
- TTS 地址收 `http` 和 `https`。HTTPS 默认 443 端口，初次连接和重连都校验证书和主机名；URL 里的用户信息和其他协议拒收。明文 HTTP 对任何主机都收，令牌和文本不加密。
- 转发规则（`/speech` 中继、截断补 `cancelled`、失败时 `speech_failed`）见 C6 §4.7。

## 会话与焦点

焦点优先级：error > awaiting_approval > awaiting_input > running_tool > thinking > compacting > subagent > done > stale > idle；同优先级保持当前焦点。hook 的响应、撤卡、去重和事件顺序见 C6 §4.6。

## 自有会话

agentd 自己开的 Claude、Codex 会话（`POST /sessions` 和派活）：

- Claude：常驻 `claude -p --input-format stream-json --output-format stream-json --verbose --permission-mode <模式> --settings <state-dir>/own-claude-settings.json`。settings 由 agentd 写（0600），所有 hook 指向本 agentd，PermissionRequest 的 timeout 等于 `--hook-timeout`，所以写文件、跑命令会出普通审批卡，卡的 `display_session` 是 `own:<hex>`。打断写 `control_request` `interrupt`；被打断的轮靠 `result.terminal_reason == "aborted_streaming"` 识别。
- Codex：`codex app-server`，`thread/start` 按模式带 sandbox（`read-only` 或 `workspace-write`），审批策略和审查方照用户 `config.toml`。`item/commandExecution/requestApproval` 和 `item/fileChange/requestApproval` 开审批卡，允许回 `accept`，拒绝或超时回 `decline`；其他服务端请求回错误。打断用 `turn/interrupt`。Codex 协议字段锁在 `sessions/codex-protocol.lock.json`。
- 子进程环境去掉 `ANTHROPIC_API_KEY` 和 `AGENTD_HOOK_TOKEN`，用用户自己的 CLI 登录。
- 空闲 10 分钟回收进程；下一条消息用 `--resume <session_id>` 或 `thread/resume` 接上。

## hook 安装

`tools/install_hooks.py`（只用标准库）把命令型 hook 加进用户级 Claude Code 设置和 Codex 的 `hooks.json`（默认在 `~/.codex/` 下），agentd 由此看到用户自己的会话：

```sh
python3 agent/agentd/tools/install_hooks.py --dry-run     # 只打印要加的 hook，什么都不写
python3 agent/agentd/tools/install_hooks.py               # 安装；再跑一次什么都不变
python3 agent/agentd/tools/install_hooks.py --uninstall   # 只拿掉它加的
python3 agent/agentd/tools/install_hooks.py --target claude --uninstall   # 只解绑 Claude Code
```

- 事件：Claude 取 `config-examples/claude-settings.agentd.json` 里的 12 个，Codex 取 `config-examples/codex-hooks.agentd.json` 里的 10 个。每个事件追加一组。
- 命令：`<Python> <agentd>/codex_hook_forward.py --endpoint /hook/claude（或 /hook/codex）--observe --timeout 0.8 --url http://127.0.0.1:48800 --token-file <hook.token 的绝对路径>`。Python 默认 `/usr/bin/python3`；token 默认在 macOS 的 `~/Library/Application Support/AgenticComplex/agentd/`、Windows 的 `%LOCALAPPDATA%\Agentic Complex\agentd\`。`--target both|claude|codex` 选工具；`--claude-settings`、`--codex-home`、`--url`、`--token-file`、`--python`、`--forwarder` 可以换。
- 给了 `--hook-script <路径>`（文件名必须是 macOS 的 `agentic-complex-hook`、Windows 的 `agentic-complex-hook.cmd`）时，命令只有这个脚本。Companion 给用户的安装命令都这样装，指向 `<支持目录>/bin/` 下的脚本，并在每次启动 agentd 前把脚本改写成调用当前 agentd 的转发器，所以 agentd 换了位置 hook 照样能用。
- 每组是 `{"hooks": [{"type": "command", "command": <一行命令>, "async": true, "onFailure": "continue", "timeout": 2}]}`；Codex 的组没有 `onFailure`。macOS 上两边都用 `sh -c` 按 `shlex` 转义；Windows 上 Claude 的组加 `"shell": "powershell"`，Codex 用 `%COMSPEC% /C`。
- 只认自己的组：组里只有一个命令型 hook，命令行里有转发器（或 `agentic-complex-hook` 脚本）、`--observe` 和这次的 `--url`。用户自己的键、组和 hook 都不动、不换顺序；自己的旧组原地换新。`--uninstall` 只删自己的组。
- 写法：经同目录临时文件改名替换，保留原权限；新建的文件为 0600。JSON 读不出或形状不对时退出 2，哪个文件都不改。`--dry-run` 只打印自己的组的 diff。
- 只观察：hook 什么都不打印、从不给决定；agentd 没开或卡住时转发器约 1 s 内退出 0。
- Codex 只运行用户信任过的 hook：装完打开一次 codex，在启动时的 “Hooks need review” 里信任，或在 TUI 里用 `/hooks`。命令变了要重新信任。安装器不改 `config.toml`，不写 hook 信任。
- 设置页的「解绑」走 `POST /integrations/hooks/disconnect`（C6 §4.2）。外壳经 `app.info` 的 `hookInstallSteps` 把安装命令交给网页设置页，命令用宿主解析出的 Python 和 agentd 组件里的 `tools/install_hooks.py`。

### 手动接 hook 测试

`config-examples/` 的示例会出审批卡，只用于一次性测试；使用前把其中的 `/ABSOLUTE/PATH` 换成实际路径。Claude 默认的 auto 模式不出审批，测审批要 `--permission-mode default`。

```sh
mkdir -p /tmp/agentd-test/claude && cd /tmp/agentd-test/claude
AGENTD_HOOK_TOKEN="$(cat /tmp/agentd-test/state/hook.token)" \
  claude --settings /ABSOLUTE/PATH/agent/agentd/config-examples/claude-settings.agentd.json \
    --setting-sources '' --permission-mode default
```

Codex：把 `codex-hooks.agentd.json` 拷成一次性目录里的 `hooks.json`，用 `CODEX_HOME` 指向该目录（该目录要单独登录），或放到一次性测试项目的 `.codex/hooks.json`。一次性测试可加 `--dangerously-bypass-hook-trust`，只对本次调用生效。

观察：

```sh
UI=$(python3 -c 'import json;print(json.load(open("/tmp/agentd-test/state/ui-runtime.json"))["ui_token"])')
curl -s -H "Authorization: Bearer $UI" http://127.0.0.1:48800/state
curl -N -H "Authorization: Bearer $UI" http://127.0.0.1:48800/events
```

这里假设 agentd 以 `--port 48800 --state-dir /tmp/agentd-test/state` 运行。

## 注意力时间线

存储在 `<state-dir>/attention.sqlite`，保留 7 天。合并规则照 ActivityWatch：

- 同一 bucket 里数据相同、时间落在上一段末尾 5 s 内的心跳并进上一段；超过 5 s 的空档算 unknown，不用上一个状态补。窗口变了时，上一段延到切换时刻。
- AFK：`idle_s` ≥ 180、锁屏或睡眠。
- 注视：键盘 5 s 内有输入时看前台窗口，否则看鼠标所在窗口；同一窗口 ≥ 5 s 算注视。
- 浏览器扩展的心跳进 `browser` bucket（pulsetime 80 s），保存聚焦和可见状态。只有聚焦、可见的发声页面能补充活跃区间。
- `share_page_text` 开启后，网页正文和选区存本机 context 表，给「嘴」时选区最多 500 字符、正文最多 1500 字符。失焦后不用当前页文字。滚动、媒体和标签数只留最新一份内存快照，15 秒过期，不进模型。

黑名单文件 `blacklist.json` 的字段由 [C10 合同](../../protocol/C10-shared-files/CONTRACT.md)定义。

## 浏览器扩展消息

用户的安装和使用见[浏览器扩展](../guides/browser-extension.md)。

- 传输：Chrome Native Messaging。每条消息是 4 字节本机字节序长度加 UTF-8 JSON，扩展发来的最多 1 MiB。native host 是 `agent/browser/native_host.py`，按 `--state-dir` 读 `hook.token` 和 `ui-runtime.json` 里的 `base_url`，不读 ui token。
- 连上和每次收到 `{"type": "policy"}` 时，host 先调 `GET /context/browser/policy` 取 `{enabled, text_enabled}`，再回扩展一条 `{"type": "config", enabled, text_enabled, domains, title_patterns, mode, allow_domains}`（黑名单取自 `blacklist.json`）。取不到策略时 `enabled` 为 false。
- 扩展发的消息：`heartbeat`、`page`、`selection`、`selection_cleared`、`metrics`。共同字段 `ts`（Unix 秒）、`url_host`、`title`，以及文档身份 `browser_session`、`tab_id`、`document_id`、`revision`。`heartbeat` 另带 `audible`、`visible`、`window_focused`；`page`、`selection` 带 `text`（最多 2000 字符）；`metrics` 带 `metrics`（滚动百分比、媒体状态、标签数）。
- host 在 `enabled` 为 false 时什么都不转；`text_enabled` 为 false 时丢掉 `page`、`selection`。黑名单命中的心跳改成 `url_host: "<hidden>"`、`title: null`，其他类型整条丢掉。其余原样 `POST /context/browser`（hook token）。
- agentd 再查一次：类型或字段不对 400 `invalid_browser`；网页文字开关关着时 `page`、`selection` 回 200 但不存。端点规则见 C6 §4.2。

## 窗口内容与上传预算

- 新配置的 `share_page_text`、`share_window_text`、`share_screenshots` 默认都关；授予辅助功能或屏幕录制权限不会自动打开内容分享。
- 开启窗口文字并授权后，外壳在切 app、焦点变化、停止打字、停止滚动、空闲时按需发 `POST /context/text`。
- `screen_context_level` 为 `status`（不读正文）、`focused`（默认，只读焦点控件和选区）或 `window`（读可见文字摘要）。OCR 只在 `window`、文字分享和图片分享都开时用，在本机 helper 里跑，agentd 只收结果文字。
- 外壳发文字或截图前先查黑名单、`secure_input` 和无痕窗口，命中就不发；agentd 的丢弃是第二道检查。一个窗口被判为黑名单、无痕或 `secure_input` 后，agentd 不再给它发请求。
- judge 两道题：`need_image`（是否要图）和 `next_check`（`30s`、`2min`、`10min`、`never`）。默认规则：AX 和 OCR 的可读文字都少于 200 字时要图，复查 `2min`（拍过图后 `10min`）。同一窗口的文字没变时不再问 judge。
- 截图上限：间隔 ≥ 30 s，滚动 1 小时 ≤ 20 张，滚动 24 小时 ≤ 200 张。
- 持续观察把窗口文字、截图和会话 hook 载荷存进共享库，分层保留：完整源保留 48 小时，hook 载荷里超过 4096 字的字符串只留头尾各 2048 字；分析和带引用的工作事件保留 30 天。`capture.jsonl` 记每次请求、拒绝、上传的原因；`capture-judge.jsonl` 记判断，只含 app、来源和字数。
- `--share-window-text`：现场情况里带上焦点窗口最近 300 s 内收到的文字。`--share-screenshots`：才发图片请求，图交给角色内核的模型描述；关着时 `POST /look` 回 409 `vision_off`。

## 交互档位

Companion 的 `interaction_preset` 对应 agentd 的 `--interaction-preset quiet|balanced|active`（默认 `balanced`），控制后台分析、主动发言和自主动作的节奏。它不延迟用户的直接请求、停止和拖拽，不增加单次输出 token。`GET /diag/state` 的 `interaction` 返回实际参数。

| 档位 | 行为判断最短间隔 / 无变化刷新 | 主动发言同类冷却 | 随机动作间隔倍率 |
|---|---|---|---|
| `quiet` | 600 / 1800 s | 关闭主动发言 | 2 |
| `balanced` | 180 / 900 s | 600 s | 1 |
| `active` | 120 / 600 s | 300 s | 0.75 |

这些是各模块的节流，不是统一的 token 或费用上限。

## 权限与生命周期

- `observation.privacy.ConsentPolicy` 是采集缓存和出站共用的实时权限版本。`--privacy-config` 指定的配置可以收窄启动能力；文件缺失、损坏或替换中一律拒绝分享。关闭某项分享或收窄范围时，清掉旧缓存、待处理观察和相关生成，拒收迟到的结果；重新开启不恢复旧缓存。同步端点 `POST /context/privacy/sync` 见 C6 §4.2。
- 角色对话在真正打开模型流前再查一次代际；取消时先断开底层连接。已经发给模型的请求撤不回，但之后的分句、迟到的输出和取消后的历史追加都会被拦下。
- `sessions.lifecycle.SessionRun` 覆盖 CLI 握手前的启动阶段。停止、退出和重置都会锁存取消；迟到建好的进程会被关掉。
- `infra.data_lifecycle.DataLifecycle` 给共享 SQLite 的每张表声明重置策略；新表没归类时重置回 500 `reset_schema_unclassified`。保留 `memory_settings`、`capture_budget` 和 `model_usage`，清空数据不会重置用户的暂停开关或绕过预算。

## 角色内核

`character_agent/` 承接角色主会话。普通对话直接由所选内核推理、调用工具和检查；用户明确指定的外部派活仍走自有会话。内置的 Pi（默认）、本机 Codex、本机 Claude Code 和经 ACP 接入的本机智能体共用同一组产品工具、任务和语义服务。原生内核不可用时明确失败。人格卡负责身份和口吻，当前工具与授权决定实际能力。

### 目录

- `services/`：产品领域服务（存储、目标与任务、交付、工作区、问题与审批、记忆、知识、观察与简报、语义任务、设置、能力与身体），不依赖本包其他子目录。
- `harness/`：各内核的配置、发现、隔离、传输和 runner 子进程（含 `pi_runner.mjs`），只依赖 `services/`。
- `routes/`：本包的 HTTP 路由，只依赖 `services/`。
- 根目录：`integration.py`、`runtime.py`、`presentation.py` 和 `pi-runtime/`，把上面三层接起来。

### 数据与执行边界

- `integration.py` 把当前角色卡、设定、记忆、历史、时段、提醒、行为观察、文件范围和桌面权限接入运行时。
- `runtime.py` 管理角色执行的生命周期、任务与检查点；`harness/codex_runner.py`、`pi_runner.mjs`、`acp_runner.py`、`claude_runner.py` 用各自的 SDK 或协议跑模型循环（帧协议见 [C8 合同](../../protocol/C8-harness-runner/CONTRACT.md)）。设了环境变量 `AGENTD_FRAME_LOG` 时，`harness/transport.py` 把 agentd 和 runner 之间收发的每一帧追加到这个 JSONL 文件（`api_key`、`token` 等键的值换成 `[redacted]`，超过 256 KiB 的字符串截断；文件超过 64 MiB 时改名为 `.1` 再记新文件），写失败只丢这一条记录；只有开发面板设它，安装版不设。
- `services/knowledge.py` 按来源与权限检索个人档案和历史知识。依赖带版本和 hash，记忆删除、撤权或输入变化会让旧上下文失效。
- `services/workspace.py` 只访问用户在设置里选的输入目录和输出目录；读 UTF-8 Markdown、TXT、CSV、JSON 和 docx、xlsx、pptx（由 `services/extract.py` 抽成文本），产物只写 Markdown、TXT、CSV、JSON，拒绝目录逃逸、符号链接和覆盖原文件。产物归属某次 run，记录来源与校验结果。
- `services/store.py` 保存独立的 Run、Event、Effect、Checkpoint。角色、产品历史、长期记忆和任务 ID 不属于任何厂商 transcript；厂商原生会话不跨内核迁移。
- 角色的最终回答复用现有文字、意图标记、语音、播放结算和历史管线；前台执行先检查结果，再交付回答。

### 内核选择与发现

- 在「设置 › 角色内核」选内核、登录来源、模型和资料范围。没保存过设置时用 Pi；只有 Pi 不可用时才自动改用已登录的本机 Codex。
- Pi 随应用内置，打包版从 `--harness-site harness.pi=DIR` 找 `node/bin/node` 和 `pi-runtime/`；Codex 和 Claude Code 只用本机安装。
- ACP 内核驱动一个本机 ACP v1 agent（stdio）：可选的 agent 列在 `harness/acp_registry.json`，本机已装的按 `harness/acp_agents.py` 的 `LOCAL_COMMANDS` 找，没装的可以经 npx 或 uvx 运行；agent 自己管登录和模型连接，Agentic Complex 的工具经 stdio MCP 提供给它。
- Codex 用 App Server stdio 适配器和产品 dynamic tools；本机登录由 Codex 自己管理，Agentic Complex 不复制 token。
- 自动发现只查已知 CLI 入口，或用户明确选的可执行文件。版本号只作诊断；启动时核对 SDK 接口、隔离选项、有效配置和实际工具，缺少本轮必需的能力时返回具体错误，不放宽工具边界。
- 发现结果缓存 30 秒；可执行文件的真实路径、inode、大小或修改时间变了立即失效。完整发现并发最多 4 个入口。
- Codex 禁用内置执行工具、全局 MCP 和扩展、自动审批，并复核有效配置与工具目录。Codex 的全局 `AGENTS.md`、`AGENTS.override.md` 靠 macOS `sandbox-exec` 在新进程里阻止读取，不改用户文件。

### 工具、MCP、Skills 与问题

`services/interactions.py` 管理持久问题、答案版本和单次审批。内核在对话里用自己的工具、MCP 服务和 Skills；Pi 读用户自己的 Pi 配置（见 `pi-runtime/RUNTIME.md`）。agentd 不另设 MCP 或 Skills 网关。工具授权见[工具网关](tool-gateway.md)。

### 任务、取消与续接

- 普通聊天不建任务。文件任务先 `task_plan`，再读资料、写文件、`artifact_read`、`artifact_verify`，服务端再读实际字节检查。用户或 API 给的验收条件不能被模型弱化；只有结构检查通过的任务进入「待复核」。
- 切换内核会取消前台执行、作废旧的内部语义任务并关闭旧主会话；已经开始的后台任务固定原内核继续跑。
- 从任务卡继续时，同一个任务 ID 得到新的 run ID；新内核读产品检查点，经 `artifact_read_previous` 读旧成果。源文件、知识依赖、角色或范围变了时拒绝续接。发生未知桌面效果时不自动重放。
- 主动问候走所选内核，开放知识读取；礼物与仪式轮另外可以请求朝向和读回执，没有文件、桌面、记忆或后台工作权限。临时对话不开放写文件和桌面动作，不写长期历史。
- `reminders_list`、`reminder_create`、`reminder_update` 让角色经提醒库处理明确的单次提醒；写入有持久幂等回执，修改检查 revision。提醒只在应用运行时生效。

### 后台任务

- 稳定的 `job_id` 标识工作，每次续接建新的 `run_id`。异步结果按 `expected_run_id` 比较后提交，旧执行不能覆盖新执行。
- 前台一轮、两个后台执行槽和一个安静语义槽分开管理。普通聊天取消不取消其他工作；撤权、重置和关闭走统一的失效处理。
- 原用户要求作为用户输入，模型生成的分工作为观察资料。后台不能递归扇出，不能扩大原范围或弱化检查条件。
- 用户或 API 声明的检查通过才算 `succeeded`；模型自拟的条件通过仍是 `needs_review`。

### 观察简报

- `services/observation_briefs.py` 从连续观察的带证据工作事件、事项摘要和活动片段生成日报和周报：开发细节、反复问题与优化、下一步建议和覆盖缺口。语义任务可以跑在 Codex、Pi、ACP 或 Claude 内核上。
- 逐字引用逐条校验；反复问题至少要两个独立、时间不重叠的实例。建议不建目标、后台工作或长期事实。
- 默认在系统时区 09:00 后生成前一日日报和最近完整周（周一到周日）的周报；开关、小时和 IANA 时区可设。应用没运行时不执行；重启只补最近完整周期。数据为空时不调用模型；失败后至少隔一小时再试。报告最多保留 30 天。
- 首包日报 12000 字符、周报 22000 字符；一次简报 120 秒、最多 12 轮，medium 推理；每天最多 3 次简报调用。

### 记忆与生成日志

- 主会话用 `memory_propose`；明确请求、逐字证据和当前版本由产品核验。自动提炼、现场解释、图片理解和主动沟通判断都经 `SemanticService` 跑在所选内核上，不回退到独立模型 API。
- 整条用户原话或明确记忆请求里的原文可以成为用户断言；其他自动提炼的事实是候选，确认后才生效。
- `MemoryTurn.commit_extraction` 在调用方持有记忆锁的同一事务里提交事项、事实、来源游标与日志回执；记录已清除或失效时全部回滚。
- 生成日志记录完整的请求、可见输出、能力、工具参数与结果、候选与提交或拒绝原因；不保存隐藏思维链。详情保留 48 小时、元数据 30 天；遗忘、撤权或重置会提前清理。

### 连续观察

`services/observation.py` 是常驻理解服务：原生 AX 遍历分时进行并续接，完整正文和树节点分片存进内容寻址存储；截图保留像素，OCR 保存文字和坐标。后台以独立调度理解，每次 120 秒、最多 16 次工具调用，并受所选内核设置的更窄上限约束。`observation_status`、`search`、`read`、`changes`、`image`、`refresh` 工具同时供观察、主会话和简报用；`refresh` 只申请采集，不点击、输入、滚动或激活窗口。待分析队列持久化，未变的 revision 不重复推理。

### 新内核适配器

适配器实现 `stream(prompt, system_prompt, history, cancelled, run_id, tool_handler)`，返回事件 `ready`、`text_delta`、`tool_started`、`tool_finished`、`result`、`error`，并实现 `interrupt`、`invalidate`、`close`。`tool_started` 用 `args` 字段，`tool_finished` 用 `result`，两者保留真实的 `tool_call_id`，经 `tool_handler.call_with_context` 交给产品服务。取消不能阻塞在等用户授权的工具锁上；迟到的工具写入按 run 和代际再检查。自有会话的恢复机制不能是产品记忆的唯一副本。

新增适配器还要写明：模型和 provider 范围、入口版本、鉴权来源、工具限制能否验证、取消协议、能否限制费用、打包依赖与许可。

### 限制

- 文件交付只支持 Markdown、TXT、CSV、JSON。
- 内部图片理解经本轮授权的 `observation_image` 交给所选内核；日志只留读取事件和 hash。
- 产品桌面工具是自有的文字与 AX 桥，不是 Claude 或 Codex 的 Computer Use；`desktop_task` 见[工具网关](tool-gateway.md)。
- Codex 不支持美元硬预算，用工具调用次数和时间上限代替。
- 设置页显示 `capabilities.features`；实现标记不代替版本、账号和真实任务的核验。

## Pi 内核

Pi 内核用固定版本的 `@earendil-works/pi-coding-agent`（版本见 `character_agent/pi-runtime/package.json`），最低 Node 22.19.0。锁文件、许可清单、隔离方式和预算规则写在 [`pi-runtime/RUNTIME.md`](../../agent/agentd/character_agent/pi-runtime/RUNTIME.md)，这份文件随每次安装复制进运行时目录。

源码模式下安装运行时：

```sh
python3 agent/agentd/character_agent/harness/pi_install_runtime.py \
  --destination .local/pi-runtime --npm /absolute/path/to/npm
```

发行版把独立的 Node 发行包和这棵锁定的 npm 树装进 `harness.pi` 组件（`node/bin/node`、`pi-runtime/node_modules/`）；发行打包要锁定 Node 的版本和归档 SHA256，保留 Node 原有的 LICENSE，并检查它的动态库。显式给了运行时根目录时，解析器不回退到开发路径。Claude 和 Codex 用用户本机安装的 CLI。

## 测试

在仓库根目录：

```sh
export AGENTD_DEV_CATALOG="$PWD/agent/agentd/tests/fixtures/characters/current.json"
agent/.venv/bin/python -I -m unittest discover -s agent/agentd/tests -p 'test_*.py'
node --test agent/browser/extension/test_*.mjs
```

`AGENTD_DEV_CATALOG` 指向合成的测试角色库（占位人设，不是游戏内容）。这个库由 `agent/agentd/tests/fixtures/characters-src/` 生成，不要手改。改了源文件后，先刷新各 `character.json` 里文件的 SHA-256 和字节数，再在仓库根目录重新生成：

```sh
out=$(mktemp -d)/lib && agent/.venv/bin/python3 -I agent/agentd/character_tool.py compose \
  $(for c in cedar birch aster dahlia elder; do echo --package agent/agentd/tests/fixtures/characters-src/$c; done) \
  --default birch --output "$out" \
  && find agent/agentd/tests/fixtures/characters -mindepth 1 -delete \
  && cp -R "$out"/ agent/agentd/tests/fixtures/characters/
```
