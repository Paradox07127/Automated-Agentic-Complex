# C10 共享文件 v1（agentd ↔ Companion ↔ 浏览器 native host）

状态：v1，2026-11-06

几个组件不经 HTTP、直接读写同一个文件。本合同按现有代码写每个文件的路径、谁写、谁读、何时写、权限和字段：`blacklist.json`、Companion `config.json` 里 agentd 读的隐私键、TTS 令牌文件。agentd 的发现文件 `ui-runtime.json`、`events-runtime.json` 和 `hook.token` 见 C9。

通则：

- 读方必须忽略不认识的键。
- `schema`：整数。字段含义变得不兼容时才加 1；只加键不改它。

## `blacklist.json`

| 项 | 内容 |
|---|---|
| 路径 | `<agentd 状态目录>/blacklist.json`。Companion 用 config 的 `agentd_state_dir`，默认 `~/Library/Application Support/AgenticComplex/agentd`，也是它传给 agentd 的 `--state-dir` |
| 所有者 | agentd（`agent/agentd/observation/blacklist.py` 的 `Blacklist`）。用户经 C6 的 `POST /blacklist`、`DELETE /blacklist`、`POST /blacklist/defaults`、`POST /blacklist/mode` 改它；`GET /blacklist` 回文件内容，缺少的 `mode` 和 `allow` 按上面的默认补上 |
| 读者 | agentd 自己；Electron 外壳的 `BlacklistFile`（`app/electron/src/main/attention/blacklist.ts`：注意力心跳、读屏、环境取色、电脑控制都经它读）；浏览器 native host（`agent/browser/native_host.py`，独立读取 `mode`、`allow.domains`、`domains` 和 `title_patterns`） |
| 写入时机 | agentd 构造 `Blacklist` 时文件不在就写默认内容（`O_EXCL` 新建）；native host 只读，不创建默认文件。上面三个 C6 请求改了内容时整份重写（写临时文件再改名） |
| 权限 | 0600。agentd 的 `Blacklist` 每次重读时发现 group / other 位就改回 0600；Companion 和 native host 只读，不改权限 |
| 格式 | 一个 JSON 对象，2 空格缩进，非 ASCII 字符原样写，结尾换行 |
| 重读 | agentd 和 Companion 都按 mtime 判断，变了就重读；native host 在连接、收到 `policy` 消息和转发前重读；手改的文件照样生效 |

| 键 | 类型 | 含义 |
|---|---|---|
| `schema` | 整数 | 现为 1。agentd 新建文件和每次重写都写它 |
| `bundle_ids` | 字符串数组 | 窗口的 bundle id 等于其中一项就排除 |
| `app_names` | 字符串数组 | 应用名不分大小写等于其中一项就排除；空的应用名不匹配 |
| `domains` | 字符串数组 | 主机名不分大小写等于其中一项，或是它的子域，就排除 |
| `title_patterns` | 字符串数组 | 正则，在窗口标题里搜索，搜到就排除。agentd 和 native host 用 Python `re`，Companion 用 `NSRegularExpression`；Companion 编不过的表达式忽略 |
| `incognito` | 布尔 | 黑名单模式下为真时 Companion 不采集无痕窗口和标签页；白名单模式下无痕一律不采集，不看这个键。只有 Companion 读它 |
| `mode` | 字符串 | `"allow"`（白名单）或 `"deny"`（黑名单）。缺少或是别的值按 `"allow"`。上面四个数组只在 `"deny"` 下用 |
| `allow` | 对象 | 白名单：`{"bundle_ids": [], "app_names": [], "domains": []}`，三个字符串数组，缺少的按空数组。只在 `"allow"` 下用 |

- 少了某个数组键按空数组处理；Companion 少了 `incognito` 按假处理。
- 白名单模式下「排除」的判断（三个读方相同）：
  1. Companion 自己照样排除。
  2. 窗口带非空的 `url_host`（浏览器窗口）：主机名不分大小写等于 `allow.domains` 的一项或是它的子域才不排除，不看应用。
  3. 其余窗口：bundle id 等于 `allow.bundle_ids` 的一项，或应用名不分大小写等于 `allow.app_names` 的一项，才不排除。
  4. 无痕窗口和标签页、安全输入照样不读。
  5. 白名单为空时什么都排除。
- 「排除」在两种模式下的后果相同：注意力心跳只发 `{"app": "<hidden>"}`，不读窗口文字、不截图、不 OCR，浏览器扩展不转发这个标签页。用户主动的划词、框选也按同一个判断；用户拖给她的文件不按名单判断。
- 不管文件写了什么，两端都排除 Companion 自己（bundle id `local.agenticcomplex.companion`、`local.agenticcomplex.development`）。
- 文件不在：agentd 写默认内容；Companion 按空白名单处理，什么都排除；native host 不创建文件。native host 在文件缺失、不可读、JSON 损坏或不是 JSON 对象时不转发任何消息，下次 `config()` 时再读。Companion 读到半截或不是 JSON 对象的文件时沿用上一次的规则，下次再读。
- 默认内容是 `blacklist.py` 的 `DEFAULTS`：`mode` 为 `"allow"`、`allow` 三个数组都空（新装时什么都不读，直到用户加应用或网站）；黑名单数组是密码管理器、聊天软件、银行和支付网站、游戏本身，`incognito` 为真。

## 隐私配置（Companion `config.json` 的一部分）

| 项 | 内容 |
|---|---|
| 路径 | Companion 的 `config.json`，默认 `~/Library/Application Support/local.agenticcomplex.companion/config.json`。Companion 用 `--privacy-config <路径>` 交给 agentd（C9「启动」）；agentd 不认默认路径 |
| 所有者 | Companion：设置页保存（`SettingsStore.save`）、首次运行（`PackagedDistribution`）。agentd 只读，不写 |
| 读者 | agentd：`observation/privacy.py`（`saved_consent`、`saved_switch`）、`daemon/context.py`（`render_facing_mode`） |
| 写入时机 | 用户保存设置时，整份文件原子替换 |
| 权限 | Companion 按进程的 umask 写，本合同不要求 |
| 版本字段 | 没有。`config.json` 没有版本键，C10 也不往里加；整份配置的键归 Companion 的 `ConfigSchema` 管，本节只管 agentd 读的 8 个键 |
| agentd 何时读 | 不缓存：每次取权限快照（采集、缓存上下文、决定外发前）、每次组朝向决定的情境时各读一次 |

| 键 | 类型 | 缺省时 agentd 当作 | 含义 |
|---|---|---|---|
| `share_window_text` | 布尔 | 假 | 窗口文字；还要 `screen_context_level` 是 `focused` 或 `window` |
| `screen_context_level` | 字符串 `status` / `focused` / `window` | `focused` | 屏幕上下文的粒度 |
| `share_page_text` | 布尔 | 假 | 网页正文和选区 |
| `share_typed_text` | 布尔 | 假 | 输入的文字 |
| `share_actions` | 布尔 | 假 | 桌面操作时间线记录（`POST /context/timeline`） |
| `share_agent_sessions` | 布尔 | 真 | 保留编码会话的内容 |
| `share_screenshots` | 布尔 | 假 | 窗口截图 |
| `render_facing_mode` | 字符串 `auto` / `front` / `side` / `back` | `auto` | 只有 `auto` 时 agentd 才做朝向决定 |

- 布尔键只有 JSON `true` 算开；`"yes"`、`1` 都算关。
- 这些键只能收窄启动时的能力，不能放开：`share_*` 要启动时带了对应的 `--share-*`，存的值才有用。
- 文件读不了、不是 JSON 对象、读的时候被替换：五个分享权限全关，粒度当作 `status`；`render_facing_mode` 读不了时朝向决定关。
- 观察电脑上的活动不在这些键里：它是插件 `screen_awareness`，Companion 读 `config.json` 的 `plugins.screen_awareness`，用 `--plugin-on` / `--plugin-off screen_awareness` 交给 agentd（C9「启动」）；agentd 不从这份文件读它。
- 没有 `--privacy-config`：权限按启动参数，粒度 `focused`，朝向 `auto`。

## TTS 令牌 `tts-token`

| 项 | 内容 |
|---|---|
| 路径 | Companion 支持目录下的 `tts-token`（`~/Library/Application Support/local.agenticcomplex.companion/tts-token`）。Companion 启动 agentd 时总传 `--tts-token-file <支持目录>/tts-token`，文件不在也传。agentd 不认任何默认路径：没有 `--tts-token-file` 时用 `$AAC_TTS_TOKEN_FILE`，两者都没有就没有令牌 |
| 所有者 | `agent/agentd/tools/tts_token.py ensure` / `rotate`（手动跑；默认写上面的路径，`--file` 或 `$AAC_TTS_TOKEN_FILE` 可改） |
| 读者 | agentd（带 `--tts-url` 时，启动阶段读一次）；Mac 备用 TTS（C2 `TTS-TOKEN.md`） |
| 写入时机 | `ensure`：文件不在时新建；`rotate`：先写好 TTS 主机上的副本，再替换本地文件 |
| 权限 | 0600，普通文件，一个硬链接，属于当前用户。不满足时 agentd 以 1 退出（`infra/tokens.py`） |
| 版本字段 | 没有 |

- 格式：纯文本，一行，结尾换行。读方去掉首尾空白，剩下的整串就是令牌。`tts_token.py` 生成的是 `secrets.token_urlsafe(32)`（43 个 URL 安全字符）。
- agentd 拿到令牌后在 TTS 请求上带 `Authorization: Bearer <令牌>`。没有令牌（没给路径或文件不在）时 agentd 照常运行，请求不带令牌，TTS 回 401，agentd 发 `speech_failed`。
- agentd 只在启动时读；换了令牌要重启 agentd。

## 不属于 C10

- `activity-recorder-stats.json`：Companion 私有（`ActivityRecorder` 按应用累计的辅助功能通知统计），写在 Companion 支持目录，没有别的组件读，不属于 C10。

## 样例与校验

- `examples/blacklist.json`、`examples/privacy-config.json`（只含 agentd 读的 7 个键）、`examples/tts-token`（假令牌）。git 不保存 0600，用令牌样例的测试先把它拷成 0600 的临时文件。
- `test_examples.py`：只用标准库，查三份样例的键和类型。
- `agent/agentd/tests/test_c10_shared_files.py`：agentd 新建和重写的 `blacklist.json` 与样例键、类型一致，`schema` 为 1；`saved_consent`、`saved_switch` 读 `examples/privacy-config.json`；`--tts-token-file` 指向样例令牌时取到的令牌等于样例内容。
- `agent/agentd/tests/test_server.py` `test_tts_token_file_comes_from_the_flag_else_the_environment`：先 `--tts-token-file`，再 `$AAC_TTS_TOKEN_FILE`，都没有时没有令牌。
- `agent/agentd/tests/test_native_host.py` `test_reads_the_c10_example_blacklist`：native host 读样例，把其中的 `domains`、`title_patterns` 发给扩展，并按它丢弃。
- `app/electron/test/c10.test.ts`：`BlacklistFile` 读样例；样例 `privacy-config.json` 里的每个键都是 `settings.ts` 的一个设置行，类型一致。
- `app/electron/test/agentd-state.test.ts` 的 agentd 命令行用例：文件不在时外壳也传 `--tts-token-file <支持目录>/tts-token`。
