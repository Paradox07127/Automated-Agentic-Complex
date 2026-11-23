# C9 agentd 进程 v1（宿主 ↔ agentd 进程）

状态：v1，2026-11-06

宿主（Electron 外壳，`app/electron/src/main/agentd/` 和 `app/electron/src/common/agentd.ts`）怎么启动 agentd、怎么判断它的退出、去哪里找它的端口和令牌。HTTP 端点本身是 C6，事件流是 C1，harness runner 是 C8。本合同按现有代码写：`agent/agentd/daemon/main.py`、`app/Resources/agentd_launcher.py`、`app/electron/src/common/agentd.ts` 的 `agentdArguments()`。

## 启动

本节以 `agentdArguments()` 实际拼的命令行为准。

可执行文件：config 的 `python`。打包版是 runtime.python 组件的 `python` 入口（`bin/agentic-complex-python`），一个执行 `$(dirname $0)/python3 -I -B` 的 sh 包装。第一个参数是 launcher 脚本（agentd 组件的 `launcher` 入口；没有组合锁的开发版用 app Resources 里的 `agentd_launcher.py`），然后是 launcher 自己的参数、`--`、agentd 的参数：

```
<python> <agentd_launcher.py> --agentd-dir <agentd 目录> --parent-pid <Companion pid> -- <agentd 参数…>
```

launcher 的参数：

| 参数 | 取值 | 必传 | 作用 |
|---|---|---|---|
| `--agentd-dir` | config `agentd_dir`；设了 `dev_resources` 时是其中的 agentd 目录 | 是 | 插到 `sys.path` 最前，再以 `<目录>/server.py` 为 `argv[0]` 在本进程里跑 agentd 的 `main()` |
| `--parent-pid` | Companion 的 pid | 宿主必传；不带时 launcher 不看父进程 | 启动时父进程已不是它就以 0 退出；之后父进程一退出就 `os._exit(0)`，不做清理 |

agentd 的参数（`--` 之后）。宿主必传的只有 `--port` 和 `--state-dir`：它们决定 `/health` 在哪、发现文件写在哪，宿主和渲染器都要知道。其余都可选，不传时用 agentd 的默认值。

| 参数 | Companion 何时传 | agentd 默认 |
|---|---|---|
| `--port N` | 总传，config `agentd_port` | 48800；`0` 由系统挑空闲端口，实际端口见发现文件 |
| `--state-dir D` | 总传，config `agentd_state_dir` | 工作目录下的 `agentd-state` |
| `--character ID` | 总传，本次要启动的角色 | 角色库的 `default_character` |
| `--interaction-preset quiet\|balanced\|active` | 总传 | `balanced` |
| `--break-reminder-minutes N` | 总传（agentd 默认是 50，省掉 0 就成了每 50 分钟） | 50；0 为关 |
| `--water-reminder-minutes N` | 总传，config `water_reminder_minutes` | 90；0 为关 |
| `--ritual-report-time HH:MM` | 总传，config `ritual_report_time`（12:00 到 23:30 的整点或半点，其他值按 17:30） | 17:30 |
| `--character-catalog PATH` | config 有 `character_catalog` 时 | 环境变量 `AGENTD_DEV_CATALOG`，没有时读仓库的公开样例库 `characters/sample-library/current.json` |
| `--harness-site harness.pi=DIR` | 有组合锁时，锁里的 `harness.pi` 组件传一次，DIR 是它的载荷目录，内有 `node/bin/node` 和 `pi-runtime/node_modules/` | 无；ID 只接受 `harness.pi`，DIR 必须是已存在的绝对目录；未知 ID、重复 ID、相对路径或目录不存在是参数错误（退出 2） |
| `--privacy-config PATH` | 有 config 文件路径时；agentd 读哪些键见 C10 | 无 |
| `--computer-control-socket PATH` 和 `--computer-control-token-file PATH` | 电脑控制开着时，两个一起传：`<support>/run/computer-control.sock`、`<support>/run/computer-control.token` | 无（只给一个是参数错误） |
| `--share-page-text`、`--share-window-text`、`--share-typed-text`、`--share-agent-sessions`、`--share-screenshots` | 对应设置开着时 | 关 |
| `--plugin-on ID`、`--plugin-off ID` | 可重复。未知 ID 为启动错误，同一 ID 同时指定时按关闭处理 | `protocol/plugins/plugins.json` 中的默认值 |
| `--no-redact` | 设置「脱敏」关掉时 | 脱敏开 |
| `--no-proactive` | 设置「主动说话」关掉时 | 开 |
| `--mute` | 静音时 | 关 |
| `--tts-url URL` | config `services.tts` 不是 `off` 时：直连地址，或外壳开的 SSH 转发、本机进程的地址 | 无，只出字 |
| `--tts-ensure-host HOST` 和 `--tts-ensure-script PATH` | TTS 走 SSH 并且有 `start_script` 时，两个一起传 | 无，不按需启动 TTS |
| `--motion-url URL` | 动作服务（Kimodo）不是关时：直连地址，或 Companion 开的 SSH 隧道、本机进程的地址；http 或 https，不带用户名、密码、query、fragment（不合是参数错误） | 无，不生成动作（`POST /motions/generate` 回 409 `no_service`） |
| `--motion-ensure-host HOST` 和 `--motion-ensure-script PATH` | 动作服务走 SSH 并且有启动脚本时，两个一起传 | 无，不按需启动动作服务 |
| `--llm-url URL` | 兼容 OpenAI 的模型 API 不是关时，地址同上；https，或 localhost / 127.0.0.1 / ::1 的 http，不带用户名、密码、query、fragment（不合是参数错误） | 无，兼容 API 关（`llm_service_off`，C6） |
| `--llm-ensure-host HOST` 和 `--llm-ensure-script PATH` | 模型 API 走 SSH 并且有启动脚本时，两个一起传 | 无，不按需启动模型 API |
| `--tts-ssh-host HOST`、`--motion-ssh-host HOST`、`--llm-ssh-host HOST` | 该服务 mode 为 `ssh` 时一律传（不论有没有启动脚本），和它的 `--<id>-url` 一起；HOST 非空、不含空白（不合或缺 url 是参数错误）。motion 和 llm 的 url 加这个主机是凭据所属的端点：和上次启动记下的（`<state-dir>/service-endpoints.json`）不同时，agentd 删掉动作服务令牌或兼容 API 的 Key | 无 |
| `--tts-token-file PATH` | 总传，`<support>/tts-token`，文件不在也传（C10） | 凭据引用的基础路径取 `$AAC_TTS_TOKEN_FILE`，缺省取 `<state-dir>/tts-token` |

agentd 还认 `--hook-timeout`、`--margin`、`--ritual-report-time`、`--ledger-root`、`--exit-with-parent/--no-exit-with-parent`、`--describe`；Companion 不传。含义见 `python3 agent/agentd/server.py --help`。

环境和工作目录：Companion 不设工作目录，环境变量也继承 Companion 的，只有 config `proxy_url` 不为空时例外：去掉继承来的各种大小写的 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`，设 `HTTP_PROXY` 和 `HTTPS_PROXY` 为它，`NO_PROXY` 为原有的主机加上 `localhost,127.0.0.1,::1` 和开着的各项服务地址的主机。agentd 按 C10 的凭据引用读取系统保存的 TTS 令牌。没有配置令牌时仍可启动。

Companion 每次启动 agentd 前把 `<support>/bin/agentic-complex-hook`（0755）改写成 `exec '<python>' '<agentd 目录>/codex_hook_forward.py' "$@"`。用户的 Claude/Codex hook 配置只存这个固定路径（`install_hooks.py --hook-script`），agentd 换位置后 hook 照样能用。

stdout 和 stderr 都写到 `<support>/logs/agentd.log`。stderr 每行前加时间和 pid；就绪时 stdout 打一行 `agentd listening on 127.0.0.1:<port>; …`，这一行不是接口，宿主不要解析它。

agentd 自己的错误记录写到 `<support>/logs/agentd-error.jsonl`（`daemon/error_record.py`；目录是 `--tts-token-file` 所在目录下的 `logs`，没传时是 `<state-dir>/logs`），和 Companion 的 `error.jsonl` 分开，两个进程不追加同一个文件。每行一个 JSON，信封同 `error.jsonl`：`{t, component, code, message, detail?, turn_id?, trace_id?, req?, count}`，`t` 是 UTC ISO 时间（到毫秒），`component` 为 `agentd`，`message` 截到 300 字符、`detail` 截到 500；同一 (component, code, message) 一分钟内的重复合成一行，`count` 是这一行代表的次数，正常关闭时写出还没写的次数。`code` 的取值见 `daemon/error_record.py` 文件头。文件 0600，agentd 只追加，写失败就丢掉这一行。不写提示词、工具输入、文件内容、查询值和密钥。轮转归 Companion（`src/main/log.ts` `rotateLogs`）：启动时把它设成 0600；运行中写日志时至多每分钟查一次，超过 20 MiB 就复制成 `agentd-error.jsonl.1`（覆盖旧的）再原地清空，agentd 接着追加。诊断的「错误」面板经 ui-bridge `logs.errors` 读它和 `error.jsonl` 各自最后 500 行。

`--exit-with-parent`（默认开）：agentd 每秒看一次 `getppid()`，变了就正常关闭（退出码 0）。经 launcher 启动时 agentd 的父进程是 Companion。

宿主启动前自己检查端口：端口被别的进程占着时 Companion 不启动 agentd，状态为 `portInUse`，每 30 s 再查一次；占着的是上一个 agentd 时按崩溃处理。

## 退出码

| 码 | agentd 何时发出 | Companion 怎么处理 |
|---|---|---|
| 0 | 正常结束：SIGTERM 或 SIGINT 后关闭完、`--exit-with-parent` 看到父进程换了、`--describe`、`--help`；launcher 启动时父进程已不是 `--parent-pid`、或之后父进程退出 | Companion 自己停的（退出、重启）不处理；否则同 1 |
| 1 | 未捕获的异常，traceback 写 stderr：端口被占（`OSError: [Errno 48] Address already in use`）、`--character` 不在角色库、角色库读不了、状态目录或令牌文件不属于当前用户 / 不是普通文件 / 令牌不是 0600（`infra/tokens.py` 的 `SystemExit`）、其他初始化失败；launcher 的参数里没有 `--`（打印用法）；`--agentd-dir` 下没有 `server.py`（`ModuleNotFoundError`） | 当作崩溃：按退避重启，等 1、2、4、8、16 s，第 6 次起 30 s（运行满 60 s 后重新从 1 s 起）；300 s 内崩溃 5 次后不再重启，停在失败「300 秒内崩溃 5 次」 |
| 2 | 参数错误（argparse）：不认识的参数、取值不合、`--computer-control-socket` 和 `--computer-control-token-file` 只给了一个；launcher 缺 `--agentd-dir` | 同 1 |
| 信号 | 崩溃，或 Companion 发 SIGKILL：`/health` 连续 15 s 没回，或启动 90 s 还没就绪 | 同 1 |

Companion 现在不区分 0、1、2，也不读 stderr。

## `--describe`

- agentd 在解析完参数后、读角色库、建状态目录、绑定端口之前处理 `--describe`：向 stdout 写一行 JSON、以 0 退出。不写任何文件。其他参数仍要能通过 argparse 校验（不认识的参数照样退出 2），但它们的值不用。
- 要先 import agentd 的全部模块，所以要用跑 agentd 的同一个 Python（带 agentd 的依赖）。
- 格式（一行，键排序，`,` `:` 两边不留空格，以 `\n` 结尾）：`{"c1_contract":"v2.6","c6_contract":"v1","c8_protocol":1,"c9_contract":"v1","component":"agentd"}`，见 `examples/describe.json`。
  - `component`：固定 `agentd`。
  - `c1_contract`：agentd 实现的 C1 合同版本，字符串。
  - `c6_contract`：C6 合同版本，字符串；和 `/health` 的 `c6_contract` 相同。
  - `c8_protocol`：C8 帧的 `v`，整数，现为 1。
  - `c9_contract`：本合同版本，字符串。
  - 没有 `version` 键：agentd 没有包版本号，组件的包版本由组件清单 C11 给。
- 经 launcher 也能用，不带 `--parent-pid`：`python3 -I app/Resources/agentd_launcher.py --agentd-dir agent/agentd -- --describe`。

## 发现文件

agentd 在 `--state-dir` 下写两个文件，告诉别的进程它的地址和本次的令牌：

| 文件 | 读方 | 内容 |
|---|---|---|
| `<state-dir>/ui-runtime.json` | Companion 的 C6 客户端（`app/electron/src/main/agentd/client.ts`，每个请求读一次）、浏览器 native host、`tools/qa/live_routes.py` | `ui_token`：读写 UI 路由用 |
| `<state-dir>/events-runtime.json` | 渲染器（Companion 用 `--agentic-complex-agentd <state-dir>/events-runtime.json` 把路径交给它，C3「启动」）的 `AgentBridgeConfiguration.load` | `events_token`：只读，`GET /events` 和 `GET /state` 用 |

- 写入时机：初始化全部完成后（启动阶段 `behavior` 之后、`publishing`），先写 `ui-runtime.json` 再写 `events-runtime.json`，之后 `/health` 才回 `ok`。所以文件在、`/health` 回 `ok` 时两个令牌都能用；`/health` 还是 `starting` 时文件可能还是上一次启动留下的。正常退出（SIGTERM、Ctrl-C）时 agentd 先删 `ui-runtime.json` 再关监听；被强杀时文件会留下。
- 写法：写临时文件再改名（原子替换），权限 0600；状态目录 0700。agentd 退出时不删这两个文件，里面的令牌随之作废；每次启动都换新令牌，所以读方不要缓存令牌。
- 已有的同名文件不是普通文件、硬链接数不是 1 或不属于当前用户时，agentd 以 1 退出。
- 内容：一个 JSON 对象，2 空格缩进，没有结尾换行。见 `examples/ui-runtime.json`、`examples/events-runtime.json`。

| 键 | 类型 | 含义 |
|---|---|---|
| `schema` | 整数 | 现为 1。字段含义变得不兼容时才加 1；只加键不改它 |
| `base_url` | 字符串 | `http://127.0.0.1:<实际端口>`，没有结尾 `/`；`--port 0` 时是系统挑的端口 |
| `ui_token`（只在 `ui-runtime.json`） | 字符串 | 本次启动随机生成（`secrets.token_urlsafe(24)`，32 个 URL 安全字符），HTTP 头 `Authorization: Bearer <令牌>` |
| `events_token`（只在 `events-runtime.json`） | 字符串 | 同上，另一个令牌 |

- 读方必须忽略不认识的键。`AgentdClient.Runtime`、`AgentBridgeConfiguration.load` 的 `File` 都是 `Decodable`，`native_host.py`、`live_routes.py` 按键取值，都满足。渲染器另外要求文件权限没有 group / other 位、不超过 16384 字节。
- 状态目录里还有 `hook.token`（0600，第一次启动时生成，以后不变），Claude / Codex hook 和浏览器 native host 用它；它不是发现文件，本合同不规定它的格式（一行令牌）。

## `/health`

见 C6 `GET /health`，样例 `protocol/C6-agentd-api/fixtures/health.json`。不要令牌。回复里的 `c6_contract`（字符串，现为 `"v1"`）是 agentd 实现的 C6 版本，就绪和启动中两种回复都带。Companion 启动 agentd 后每 0.25 s 问一次，按 `status` 和 `stage` 显示启动进度，`ok` 才算就绪。

## 工具入口

下面 3 个脚本和 `server.py` 放在同一个 agentd 目录里，是 agentd 组件对外声明的入口。宿主用跑 agentd 的同一个 Python 按脚本路径调用（Companion 用 config 的 `python` 和 `agentd_dir`，不经 launcher，不认 `dev_resources`），工作目录设成 agentd 目录（`distribution_seed.py` 除外，它不设）。各脚本自己把所在目录插进 `sys.path`，所以可以带 `-I`。

### `character_tool.py`

```
character_tool.py install <包目录或文件> --library <角色库目录> [--validate-with <渲染器可执行文件>]
character_tool.py validate <包>
character_tool.py export <包> --output <文件>
character_tool.py list --library <角色库目录>
```

- 成功：stdout 一行 JSON，退出 0。`install` → `{"revision", "ids"}`；`validate` → `{"id", "sha256", "capabilities"}`；`export` → `{"file"}`；`list` → 角色库条目数组。
- `PackageError`、`OSError`、`ValueError`：错误文本写 stderr，退出 2。`install` 不带 `--validate-with` 也走这条（`load_failed: host executable is not configured`）。
- 参数错误 2；其他异常 1。
- Companion（`app/electron/src/main/ops/character.ts`）只用 `install`，带 `--validate-with`；非 0 时把输出末尾 8 KiB 当失败原因显示。

### `motion_tool.py`

```
motion_tool.py import --library <角色库目录> --character <角色 id> --source <动作文件或 .zip> [--extra <文件>]… [--format auto|vmd|bvh|gltf|vrma|fbx] [--take <段号>] [--bgm <音频文件>] [--bgm-start <秒>] [--title <标题>] [--no-foot-lock] [--bone-map <JSON 文件>] --validate-with <渲染器可执行文件>
motion_tool.py probe --source <动作文件> [--format auto|vmd|bvh|gltf|vrma|fbx] [--take <段号>]
motion_tool.py list --library <角色库目录> --character <角色 id>
motion_tool.py rename --library <角色库目录> --character <角色 id> --action <动作 id> --title <标题> --validate-with <渲染器可执行文件>
motion_tool.py remove --library <角色库目录> --character <角色 id> --action <动作 id> --validate-with <渲染器可执行文件>
motion_tool.py chain --library <角色库目录> --character <角色 id> --proposal <JSON 文件> [--check] --validate-with <渲染器可执行文件>
```

- 成功：stdout 一行 JSON，退出 0。`import` → 一行 `endfield-motion-import/v1`（见 `protocol/character-library/MOTION-IMPORT.md`），`action.{id,title,duration_s,has_bgm}` 和旧版同义；`probe` → `{"ok": true, "format", "takes", "has_face", "has_camera", "warnings"}`，不要角色库；`list` → `{"ok": true, "character", "version", "motions"}`；`rename` → `{"ok": true, "character", "version", "id", "title"}`；`remove` → `{"ok": true, "character", "version", "id"}`。`rename`、`remove` 和 `import` 一样重建角色包、版本 +1、原地发布。
- `import` 的 `--source` 是 `.zip` 时先安全解到 `<角色库>/.vmd-stage/<角色 id>-inputs/`（`agent/agentd/motion/zip_import.py`）；有 `.zip` 或 `--extra` 时，解出的文件和每个 `--extra` 按内容分类：骨骼帧 >0 的 VMD 是身体（恰好 1 支），只有相机帧的 VMD 是相机（≤1，传给 VMD 导入器），wav/mp3/m4a/aac/flac/aif/aiff 是音频（≤1，`--bgm` 优先）；其余文件不导入，成功行 `warnings` 里各记一条 `ignored_file: <文件名>`。成功或失败都删掉暂存目录。只有一个非 ZIP 的 `--source` 时照旧不分类。
- `import` 成功行的 `tracks` 只有 `body`、`face`、`camera`、`audio`，`face`、`camera` 的字段见 `MOTION-IMPORT.md` 的 `tracks.face`、`tracks.camera`（`take.py` 的 `_FACE`、`_CAMERA`）。`imports.json` v2 条目的 `camera`、`zip` 为 `{file, sha256, name}`（相机 VMD、ZIP 原件按内容寻址存在 `motion-imports/<角色 id>/`）或 null。
- 失败：stderr 最后一行 JSON `{"ok": false, "reason", "detail"}`，退出 2。`reason`：`validate_failed`、`too_many_actions`、`too_many_media`、`bad_vmd`、`too_long`、`missing_bones`、`busy`、`unsupported_format`、`bad_source`（非 VMD 源解析失败；VMD 仍报 `bad_vmd`）、`no_animation`、`unmapped_skeleton`、`already_imported`、`unknown_action`（动作表里没有这个 id）、`not_imported`（这个动作不是导入的）、`bad_title`（去空白后不在 1–64 字符）、`bad_zip`（ZIP 不安全、损坏或超限）、`ambiguous_motion`（多支身体、多支相机或多个音频，`detail` 是逗号连接的文件名；没有身体 VMD 报 `bad_vmd`），其他异常都是 `internal`。
- 参数错误也是 2，但 stderr 没有那行 JSON。
- 需要导入器：agentd 目录的上一级有 `content/import_vmd.py`（打包版的 `runtime/content`）时用它，否则用仓库的 `characters`。
- `chain`（`characters/agentic_complex_build/motion_import/chain_edit.py`）：`--proposal` 是一份结构提案 `{"schema": "endfield-motion-chain-proposal/v1", "character", "package_sha256", "edits"}`，只有这四个键。`character` 是角色 id；`package_sha256` 是提案所依据的包的 `character.json` 的 sha256（角色库条目的 `definition_sha256`），不等于当前包时整份拒绝（`stale`）。`edits` 非空，按顺序套用，后一条看到前一条的结果：
  - `{"op": "set", "clip", "next"?, "exit"?, "hold"?}`：改 intent-motion-map 里 `clip` 的 `next`、`exit`、`hold_seconds`，至少给一个；`null` 表示去掉该字段。`hold` 是 ≥0 的数，只能给循环片段。
  - `{"op": "replace", "chain", "index", "clip"}`：把链 `chain` 的第 `index` 段换成 `clip`。
  - `{"op": "insert", "chain", "index", "clip"}`：在链 `chain` 的第 `index` 段前插入 `clip`。
  - `{"op": "blend", "clip", "seconds"}`：把 blend-times 里 `clip` 的 `blend_in_s` 改成 `seconds`（0–2）。
  - `chain` 是 motion-graph `chains` 的键（链的起头片段）；链按 `motion_graph.policy_chain` 走：先看片段的 source auto-return，否则看 `next`。`index` 从 0 数，replace 要 1 ≤ `index` < 段数，insert 要 1 ≤ `index` ≤ 段数。两者都改写第 `index`−1 段的 `next` 指向 `clip`，再把 `clip` 的 `next` 改成原来的下一段（没有下一段就去掉）。`clip`、`next`、`exit` 必须是包的动作 archive 里的片段。
  - 套用后检查每条链路有变的链（起头是没有片段通向的片段、池子里的片段或动作行的片段）：沿 source auto-return、否则 `next`、否则 `exit` 走不能重复片段；最后一段的 `stance_end` 要等于起头的 `stance_start`；新连上的两段站姿要接得上；包有 pose-families 时，站姿起头的池子片段要过构建器的 `check_families`；动作行的片段原来是 `chains` 键的，改完仍要是。
  - 只改写 intent-motion-map.json、blend-times.json（内容有变时），有 motion-graph.json 时照 `rename` 重生它（用旧图的姿势），重算哈希，版本 +1，写 `provenance/edit-<16 位 hex>.json`（`endfield-motion-edit/v1`，`op` 为 `"chain"`，带 `edits`）。
- `chain --check`：只校验，不写角色库，不取锁，不用 `--validate-with`（但仍要给）。stdout 一行 JSON `{"ok", "problems": [{"edit", "reason"}], "graph_changes": {"chains_added", "chains_removed", "chains_changed"}}`，退出 0，提案被拒也是 0（`ok` 为 false）。`edit` 是 `edits` 的下标，整份提案或链的问题为 null。`graph_changes` 是改前、改后两份 motion-graph 的 `chains` 键的增、删和内容有变的键，各自排序；提案或某条 edit 有问题时三项都是空数组。
- `chain` 不带 `--check`：校验通过后照 `rename` 发布，成功 → `{"ok": true, "character", "version"}`。提案被拒时 stderr 最后一行的 `reason` 是 `stale`、`bad_proposal` 或 `chain_refused`，`detail` 是 problems 数组的 JSON 文本；另有 `validate_failed`、`busy`、`internal`。
- `chain` 的 problem `reason`：`bad_proposal`（schema、键、角色不对或 `edits` 为空）、`stale`、`bad_edit`（op 不认识、键或类型不对）、`unknown_clip:<片段>`、`unknown_chain:<片段>`、`bad_index`、`bad_hold`、`bad_blend`、`source_return:<片段>`（这一段由 source auto-return 决定，改 `next` 不起作用）、`cycle:<起头>`、`no_return:<起头>`、`stance_breaks:<前段>><后段>`、`chain_key_lost:<片段>`，以及 `check_families` 的 `pool_pose_unmeasured:<片段>`、`pool_start_family_unbridged:<片段>`、`pool_chain_end_off_base:<片段>`。`--proposal` 不是合法 JSON 时 stderr 报 `bad_proposal`，退出 2。

### `distribution_seed.py`

```
distribution_seed.py --seed-catalog <current.json> --seed-sha256 <hex> --existing-catalog <current.json> --existing-sha256 <hex> --output <新角色库目录>
```

- 调用方必须持有 Companion 实例锁。
- 成功：stdout 一行 JSON `{"revision", "ids"}`，退出 0。`--output` 已存在且是同一对输入生成的，直接返回它。
- `OSError`、`ValueError`（含 sha 不符等 `PackageError`）：错误文本写 stderr，退出 2。参数错误 2；其他异常 1。
- Companion（`app/electron/src/main/packaged.ts`）把 stdout、stderr 写进 `<support>/seed-migration.log`，非 0 时报「角色库迁移失败」，不替换原目录。
- 种子生成的角色库目录里有 `distribution-seed.json`：首次生成时 Companion 写，迁移时本脚本写；`schema` 是 `"endfield-distribution-seed/v1"`，`seed_sha256` 是生成它的种子的 sha256。Companion 读 `seed_sha256` 判断当前角色库是否已经来自这份种子，本脚本读它判断 `--output` 是否由同一对输入生成。

## 样例与校验

- `examples/describe.json`、`examples/ui-runtime.json`、`examples/events-runtime.json`（令牌是假的）。
- `test_examples.py`：只用标准库，查三份样例的键和类型。
- `agent/agentd/tests/test_c9_process.py`：`--describe`（直接跑和经 launcher）的输出逐字等于 `examples/describe.json`，且不建状态目录；真起一个 agentd（`--port 0`），它写出的两个文件和样例的键、类型一致，权限 0600。
- `app/electron/test/c6.test.ts`：读 `examples/ui-runtime.json` 能取到端口和令牌。

## 单独运行

不经 Companion，从仓库根目录跑 agentd（用 agent 的虚拟环境；直接跑 `server.py` 不能带 `-I`，它靠脚本所在目录在 `sys.path` 上找到自己的模块；`--no-exit-with-parent` 让它在启动它的 shell 退出后也不跟着退）：

```sh
agent/.venv/bin/python3 agent/agentd/server.py --port 48820 --state-dir /tmp/agentd-state --no-exit-with-parent
```

或者照 Companion 的样子经 launcher（可以带 `-I`），不带 `--parent-pid`：

```sh
agent/.venv/bin/python3 -I app/Resources/agentd_launcher.py --agentd-dir agent/agentd -- --port 48820 --state-dir /tmp/agentd-state
```

就绪后读 `/tmp/agentd-state/ui-runtime.json` 拿地址和令牌；`curl http://127.0.0.1:48820/health` 不要令牌。用 SIGTERM 或 Ctrl-C 停，退出码 0。端口不要用 48800，那是 Companion 正在用的 agentd。
