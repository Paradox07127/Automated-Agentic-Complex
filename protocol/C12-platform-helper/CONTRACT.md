# C12 平台 helper 协议 v1（Electron 主进程 ↔ 原生 helper 子进程）

状态：v1 草案，2026-11-19。还没有实现方；两个 helper 实现时回放 `examples/`，定稿后改这一行。
参与方：Electron 主进程（客户端，启动和监督 helper）↔ 平台 helper（每个 OS 一个原生进程：macOS 用 Swift（`app/helpers/mac`）；Windows 用 C++：起步 C++17，接入 C++/WinRT 的块（UIA、WGC、OCR 等）升到 C++20）。
改这份合同照 `protocol/README.md`「怎么改协议」：正文、`ops.json`、`validate.py`、`examples/` 同一个提交改。

## 1. 分工

1. helper 只调系统 API，回原始读数：屏幕和窗口列表、AX/UIA、截图、OCR、麦克风和本机识别、按住说话的按键、合成输入、系统权限、剪贴板、其他进程的信息。
2. 策略留在主进程（TypeScript，`app/electron/src/common/`）：黑名单、无痕和安全输入的拦截（`capture-rules.ts` 的 `captureBlockReason`）、文字脱敏（`attention.ts` 的 `redactText`）、读屏同意和代际、注意力心跳的拼装和滑动计数（`InputActivity`）、锁屏和睡眠的去抖（`PresenceEdges`、`AttentionSleepState`）、全屏和录屏时隐藏、keep-clear 的取舍、电脑控制的授权次数和时限（`computer-control.ts`）。
3. helper 不连 agentd 和渲染器，不读 `config.json`，不写文件；例外是 `control.listen` 建的端点和令牌文件。
4. 一个 helper 进程只服务一个主进程。

## 2. 传输

1. 主进程用 `child_process.spawn` 启动 helper，stdin、stdout 走本协议；stderr 是 helper 的日志，主进程原样写进自己的日志文件。helper 跑在用户的交互会话里（Windows 的 session 0 里 WGC 不可用）。
2. 每条消息是一行 UTF-8 JSON 对象，以 `\n` 结尾；一行连同换行最多 `max_line_bytes` = 16 MiB（16777216 字节），两个方向相同。
3. 每条消息都有 `"v": 1`（整数）。
4. 消息分三种，按出现的是 `op`、`ok` 还是 `event` 区分，一条消息恰好有其中一个：

   | 种类 | 方向 | 字段 |
   |---|---|---|
   | 请求 | 主进程 → helper | `id` 正整数；`op` 字符串；`params` 对象（没有参数时 `{}`） |
   | 回包 | helper → 主进程 | `id`（对应的请求）；`ok` 布尔；`ok: true` 时 `result` 对象，`ok: false` 时 `error` 对象（第 3 节） |
   | 事件 | helper → 主进程 | `event` 字符串；`seq` 正整数；`data` 对象 |

5. `id` 由主进程分配，同一 helper 进程内严格递增。helper 对每个请求恰好回一个回包，被取消或超时的也回。回包顺序可以和请求顺序不同。
6. `seq` 是 helper 每个进程一个的计数器，从 1 开始，每发一个事件加 1。
7. 字段只加不改；接收方忽略不认识的字段。
8. 坐标：`rect` 是 `{x, y, width, height}`，`point` 是 `{x, y}`。屏幕坐标的原点在主显示器左上角，y 向下；macOS 的单位是点（即 CG 全局坐标），Windows 的单位是物理像素（虚拟屏幕坐标）。换成 Electron 的 DIP（Windows 用 `screen.screenToDipRect`）或 C3 要的坐标（macOS 的 AppKit 左下原点）由主进程做。OCR 的 `bounds` 是相对图像的 0–1 归一化坐标，原点在左上；主进程转发给 agentd 前把它换成 agentd 现在收的左下原点，agentd 不用改。
9. 标识：`pid` 是进程号。`window_id` 在 macOS 是 CGWindowID，在 Windows 是 HWND 的整数值。`app_id` 在 macOS 是 bundle id；在 Windows 是打包应用的 AUMID，否则是小写的可执行文件名（例如 `notepad.exe`）。`display_id` 在 macOS 是 CGDirectDisplayID，在 Windows 是 HMONITOR 的整数值。
10. 角色名：两端的 `role`、`subrole` 都用 AX 名字（`AXTextArea`、`AXSecureTextField`），主进程和 agentd 只认这一套。`native_role` 是平台原名：macOS 和 `role` 相同；Windows 是 UIA ControlType 的程序名（`Document`、`Edit`），helper 按第 7.13 节的表换成 `role`，表里没有的类型 `role` 为 `AXUnknown`。
11. 时间：`ts`、`launched_at` 是 Unix 秒（可带小数）；`*_ms` 是毫秒；`idle_s` 和 `input_idles` 的值是秒。二进制数据用标准 base64（带填充）。

## 3. 错误

`error` 是 `{code, message, retryable?}`：`code` 字符串，`message` 给日志看的英文短句，`retryable` 布尔，省略等于 `false`。`message` 不含读到的内容（文字、标题、路径以外的用户数据）。

通用错误码，任何 op 都可能回：

| code | 含义 |
|---|---|
| `bad_request` | `params` 缺字段、类型不对或取值越界 |
| `unknown_op` | 不认识的 op（主进程比 helper 新） |
| `unsupported` | 这个平台或这台机器不支持这个 op，或平台支持但本 helper 版本还没实现（没出现在 `hello` 回包的 `ops` 里）；后一种 `message` 写明 not implemented |
| `not_ready` | `hello` 之前的请求 |
| `cancelled` | 被 `cancel` 中止 |
| `timeout` | helper 自己给这次调用设的上限到了 |
| `internal` | 其他失败；`message` 写原因 |

没有单独的「未实现」错误码：未实现的 op 一律回 `unsupported`，主进程以 `hello.ops` 为准。

判定顺序：`not_ready` → `unknown_op` → `bad_request`（参数校验和平台无关，缺参数的请求即使 op 不被支持也先回 `bad_request`）→ `unsupported`。

各 op 自己的错误码见第 7 节和 `ops.json` 的 `errors`。以下名字跨 op 含义相同：`permission_denied`（缺系统权限，不弹窗）、`ax_timeout`（对方 app 没在 AX/UIA 上限内回答，`retryable: true`）、`process_gone`、`window_gone`。

主进程本地还有三个错误，不在线上出现：`helper_exited`（在途请求遇到 helper 退出）、`helper_timeout`（第 5 节第 1 条）、`protocol_error`（第 6 节第 3 条）。

## 4. 握手和版本

1. helper 启动后什么都不发，等 `hello`。
2. 主进程的第一条请求是 `hello`。`hello` 回包之前，helper 对其他请求回 `not_ready`，也不发事件。
3. `hello.params.protocol` 和 helper 的不一致：helper 回 `protocol_mismatch`，以退出码 3 退出；主进程不重启它，报告 helper 版本不对。
4. `hello` 回包的 `ops` 是这台机器上可用的 op，`events` 是 helper 会发的事件。主进程只调 `ops` 里有的 op；调其他的，`ops.json` 里有的回 `unsupported`，没有的回 `unknown_op`。`ops` 只列已实现的 op；平台支持但本版本没实现的不列，回 `unsupported`（第 3 节）。
6. 允许第二次 `hello`：按第一次的规则再回一次，内容相同，不重置任何状态。
5. 只加 op、字段、错误码、事件时 `protocol` 不变，主进程按 `ops` 判断新 op 在不在。改已有字段的含义时 `protocol` 加 1。选填字段可能不出现（helper 旧或另一个平台暂不给），主进程按缺省处理。

## 5. 超时和取消

1. 每个 op 有一个 `timeout_ms`（`ops.json`）。到时没回包，主进程发 `cancel`，调用方得到 `helper_timeout`；之后迟到的回包丢弃。同一个 op 连续 3 次 `helper_timeout`，主进程按 helper 卡死处理（第 6 节第 3 条）。
2. `cancel` 的回包 `cancelled: true` 表示目标还在执行、已中止，目标自己的回包是 `cancelled` 错误；`false` 表示目标已经回过包或 id 不认识。
3. helper 给每次 AX/UIA 调用设自己的上限，不靠主进程的超时：macOS 沿用现有的 `AXUIElementSetMessagingTimeout`（探测类 50 ms，读文字 250 ms）；Windows 把 UIA 的 `ConnectionTimeout`、`TransactionTimeout` 调到 2000 ms 以下，UIA 只在专用的 MTA 线程上调。某个 app 超时后 2 秒内对它的 AX 探测直接回 `ax_timeout`（沿用 `FocusProbe`、`UnderlayProbe` 的做法）。

## 6. 退出和重启

1. 收到 `shutdown`：helper 先给每个还在执行的请求回 `cancelled`，再回 `shutdown` 的包，再停所有监听、关麦克风、注销按住说话的按键、关 `control.listen` 的端点并删令牌文件，以退出码 0 退出（样例 `examples/ok-shutdown-inflight.ndjson`）。stdin 关闭等同 `shutdown`，只是不回包。
2. 退出码：0 正常；2 协议错误（收到非 JSON、超长的行、`v` 不对，请求缺 `id` 或 `id` 非法、`op` 不是字符串，或主进程发来回包或事件；这些都没有可回的 `id`，退出前往 stderr 写一行原因）；3 版本不符；其他视为崩溃。
3. 主进程读到 helper 的非法消息（非 JSON、超长、`v` 不对、回包的 `id` 不在途、事件名不在 `hello.events` 里），或判定 helper 卡死：结束 helper（macOS 先 SIGTERM，2 秒后 SIGKILL；Windows `TerminateProcess`），按崩溃处理。
4. 崩溃后：在途请求以 `helper_exited` 失败；主进程退避 1、2、4、8 秒……最多 30 秒后重启，稳定运行 60 秒后退避清零。重启后重新 `hello`，并重放之前生效的 `workspace.watch`、`presence.watch`、`input.watch`、`ax.watch`（每个 `watch_id` 一份）、`ptt.register`、`control.listen`。录音不重放，按住说话按被打断处理。
5. helper 不保存任何状态。重启后旧的 `control.observe` 快照回 `stale_snapshot`；旧的 `ax.window_text` 游标从头读，`coverage.reasons` 带 `cursor_reset`；旧的 `ax.window_tree` 的 `previous` 不认识，回整棵树。
6. 主进程退出时发 `shutdown`，等 1 秒再结束 helper。

## 7. op

平台一列：「两者」= macOS 和 Windows 都实现；「仅 Mac」= Windows 的 `hello.ops` 不列它。错误码一列只列该 op 自己的，通用错误码（第 3 节）不重复。字段类型见第 7.12 节和 `ops.json` 的 `types`。

### 7.1 会话

| op | 平台 | 参数 | 回包 | 错误码 |
|---|---|---|---|---|
| `hello` | 两者 | `protocol`、`client`；选填 `client_version` | `protocol`、`platform`（`macos`/`windows`）、`helper_version`、`os_version`、`arch`、`pid`、`ops`、`events` | `protocol_mismatch` |
| `cancel` | 两者 | `target`（要取消的请求 id） | `cancelled` | — |
| `shutdown` | 两者 | — | `{}` | — |

### 7.2 前台窗口和屏幕

| op | 平台 | 参数 | 回包 | 错误码 |
|---|---|---|---|---|
| `screens.list` | 两者 | — | `screens`：`screen` 数组 | — |
| `windows.list` | 两者 | 选填 `pid`、`layer0_only`、`include_titles`、`limit` | `windows`：`window` 数组，从前到后 | — |
| `windows.at_point` | 两者 | `point`；选填 `exclude_pids`、`layer0_only`、`include_titles` | `window`：最前面的一个，没有时 null | — |
| `workspace.watch` | 两者 | `enabled` | `watching`；选填 `front_pid` | — |

- `windows.list` 只列屏幕上的窗口，不含桌面元素。不带 `include_titles` 时不读标题和应用名（C3 规则 31 只用 id、pid、layer、alpha、bounds）。macOS 读标题要录屏权限，没有时 `title` 为 null，不报错。
- `layer`：macOS 是 CGWindowLayer；Windows 普通顶层窗口为 0，`WS_EX_TOPMOST` 的为 1，只列可见且没被 cloak 的顶层窗口。`alpha`：Windows 取 layered 窗口的整体透明度，其他为 1。
- `workspace.watch` 打开后，前台 app、桌面空间（macOS Space、Windows 虚拟桌面）或显示器变化时发 `workspace.changed`。Windows 的前台变化要用 `GetForegroundWindow` 复核后再发（`EVENT_SYSTEM_FOREGROUND` 会报不真实的前台）。
- `workspace.watch` 打开（`enabled: true`）时回包另带 `front_pid`：此刻的前台 app（macOS `NSWorkspace.frontmostApplication`），没有时 null；关掉时不带。Windows 暂不给（不出现）。

### 7.3 注意力

| op | 平台 | 参数 | 回包 | 错误码 |
|---|---|---|---|---|
| `attention.sample` | 两者 | 选填 `include_titles`、`include_input`、`include_audio` | 见下 | — |
| `presence.watch` | 两者 | `enabled` | `watching` | — |
| `browser.front_tab` | 两者 | `app_id` | `url_host`、`incognito`，读不到时为 null | `automation_denied`、`process_gone` |
| `input.modifiers` | 两者 | — | `alt`、`shift`、`control`、`meta` | — |
| `input.watch` | 两者 | `enabled` | `watching` | `permission_denied` |
| `input.actions` | 两者 | `enabled` | `watching` | `permission_denied` |

`attention.sample` 一次读完下列字段，任何一项读不到时为 null，不报错：

| 字段 | 含义 | Windows |
|---|---|---|
| `ts` | 读取时刻 | 同 |
| `front` | 前台 app（`front` 类型）和它最前面的普通窗口 | `GetForegroundWindow`；`category` 为 null |
| `mouse_window` | 鼠标下最前面的普通窗口 | `WindowFromPoint` 取顶层窗口 |
| `idle_s` | 距上一次任何输入的秒数 | `GetLastInputInfo` |
| `locked` | 屏幕已锁 | WTS 会话状态 |
| `secure_input` | 系统安全输入开着（macOS `IsSecureEventInputEnabled`） | 恒为 false |
| `focus_role`、`focus_native_role`、`focus_window_role`、`focus_window_native_role`、`focus_window_subrole` | 焦点控件的角色，及其所在窗口或 sheet 的角色（第 2 节第 10 条） | UIA 的焦点元素，和从它往上第一个 `Window` 控件（焦点元素自己是窗口时就是它）；`native_role` 是 ControlType 名，按第 7.13 节换成 AX 名字；UIA 400 ms 内没答完或焦点在桌面上时都为 null，往上 16 层没有窗口时 `focus_window_*` 为 null |
| `camera_active`、`mic_active` | 有设备在用；helper 自己在录音时 `mic_active` 为 null | 摄像头看当前用户的 `CapabilityAccessManager\ConsentStore\webcam`（打包应用是它的子键，桌面应用是它的 `NonPackaged` 的子键）：有一项 `LastUsedTimeStart` 大于 0 且 `LastUsedTimeStop` 为 0 就是有应用正在用，读不到这个键时 null；麦克风看默认采集端点上有没有活动的会话 |
| `audio_clients` | 有音频输入或输出的进程（`include_audio`） | `IAudioSessionManager2` 枚举采集和播放端点 |
| `input_counters`、`input_idles` | 会话级的按键、点击、滚动、移动累计数和各自的空闲秒数，从不含键码（`include_input`） | helper 用 Raw Input 自己计数，从启动时起算 |
| `video_pids` | 持有「显示器不睡」电源断言的 app 进程 | null（没有不提权读别人电源请求的接口） |
| `front_gpu_busy` | 前台进程占 GPU 时间的比例 0–1；距上次读不到 1 秒时为 null | PDH `GPU Engine` 计数器 |
| `capture_indicator` | 菜单栏的录屏指示亮着 | null（系统没有对应指示） |

全屏判断、黑名单、无痕、`InputActivity` 的滑动计数都由主进程按这些读数算。

`front.focused_window_title`（选填）：前台 app 焦点窗口的 AX 标题（`kAXFocusedWindowAttribute` 的 `kAXTitleAttribute`），只在 `include_titles` 时读，读不到或没有辅助功能权限时 null；不带 `include_titles` 时不出现。主进程的 `chooseTitle`（`app/electron/src/common/attention.ts`）优先用它、空时再用 `front.window.title`。Windows 暂不给（不出现）。

- `presence.watch` 打开后发 `presence.edge`：`lock`/`unlock`（macOS 屏幕锁定通知，Windows `WTSRegisterSessionNotification`），`sleep`/`wake`（系统睡眠和唤醒，Windows `PBT_APMSUSPEND`/`PBT_APMRESUMEAUTOMATIC`），`display_sleep`/`display_wake`（显示器，Windows `GUID_CONSOLE_DISPLAY_STATE`）。边沿原样发，去抖由主进程做。
- `browser.front_tab` 用 AppleScript 读 Safari 或 Chrome 前台标签页的地址和无痕状态；没有自动化权限时不弹窗，回 `automation_denied`。Safari 读不出无痕状态，`incognito` 为 null。
  - Windows 读 Chrome（`chrome.exe`）和 Edge（`msedge.exe`），用 UIA，不要权限，不回 `automation_denied`：取这个 `app_id` 最前面的浏览器窗口（可见、没被 cloak、没有属主、类名 `Chrome_WidgetWin_1`、有标题，最小化的也算），没有时回 `process_gone`；控件按 Chromium 的视图类名（UIA ClassName，不随界面语言变）找：地址是 `OmniboxViewViews` 的值，`url_host` 只取其中的主机名，小写，不带协议、端口、路径和查询，Chromium 省掉 `http://`、`https://` 时也认，不是带主机名的网址（正在输入的搜索词、`about:blank`）时为 null。无痕看窗口标题和窗口下 `BrowserRootView` 的 Name（Chromium 读给读屏软件的窗口标题）：Edge 的两处都带 `InPrivate`，这个名字各语言都不翻译；Chrome 的窗口标题不带无痕标记，`BrowserRootView` 的 Name 是标题后面加 ` (Incognito)`，这个词随界面语言翻译，所以 Name 里有 `Incognito` 为 true，Name 和标题相同为 false（任何语言都对），两处不同又没有这个词（别的语言的无痕标记，或 Chromium 给 Name 加的标签状态等）为 null。`incognito` 不为 false 时 `url_host` 为 null（同 macOS 的 Chrome）。其他 `app_id` 回两个 null；UIA 1500 ms 内没读完时也是两个 null。
- `input.modifiers` 读当前的全局修饰键状态；`meta` 是 Command 键或 Windows 键。
- `input.watch` 打开后，用户每次按键、按下鼠标键、松开鼠标键或滚动发一个 `input.activity`，只带种类，不带键码和位置；helper 自己合成的输入（`control.act`）不算。按键和滚动同一种类 100 ms 内最多发一个；`mouse_down`、`mouse_up` 每次都发，主进程靠这一对知道鼠标键此刻是否按着（`HostLink.buttonsDown`）。macOS 监听按键要辅助功能权限，没有时回 `permission_denied`。Windows 暂不发 `mouse_up`：主进程在一个 helper 进程发来第一个 `mouse_up` 之前，把每次 `mouse_down` 只当作一次按下。
- `input.actions` 打开后，用户的一次动作发一个 `input.action`，带动作落到的控件：`target` 是 `ax_element`（读不到时 null），不带 `value`；落在静态文字上时 `label` 取它的文字（没有占位符时，最多 200 字）。它和 `input.watch` 各用自己的只监听 event tap，`input.watch` 照旧不读键码和位置；helper 自己合成的输入（`control.act`）不算。
  - 松开左键发 `kind: click`，按下右键发 `kind: context_menu`：helper 读点击位置，用系统级元素问这个位置上的控件，`pid` 是它所属的 app；位置本身不进事件，问不到控件时不发。同一控件 150 ms 内的重复 `click` 只发一个。
  - 按键只读修饰键和键码：带 Command、Control 或 Option 的是 `kind: shortcut`，`keys` 是小写的修饰键按 `ctrl`、`alt`、`shift`、`cmd` 的顺序加主键，用 `+` 连（`shift+cmd+p`）；主键是当前键盘布局上不带修饰键的字符，Return、Tab、空格、Delete、Esc、方向键用名字（`return`、`tab`、`space`、`delete`、`forward_delete`、`escape`、`left`、`right`、`up`、`down`），没有可见字符时是 `key<键码>`。不带这三个修饰键的 Return 和小键盘 Enter 是 `kind: submit`，`keys: "return"`。其余按键（普通打字、只带 Shift 的键）不发事件，也不读字符。按键的 `pid` 是前台 app，`target` 是它的焦点控件。
  - 没有辅助功能权限时回 `permission_denied`。
  - Windows：动作来自第 7.3 节输入计数的那个隐藏窗口和那一份 Raw Input 注册（不另注册），不要权限，不回 `permission_denied`。Raw Input 不带位置，点击位置取处理它时的光标位置，在 UIA 线程上用 `ElementFromPoint` 问控件，`pid` 是控件所属的进程；那个 app 在 2 秒的退避里时不问，`target` 为 null。Ctrl、Alt 和 Windows 键（写 `cmd`）算快捷键的修饰键，AltGr 带出的左 Ctrl 不算；主键的字符按前台窗口的键盘布局用 `MapVirtualKeyEx` 取，`key<键码>` 是虚拟键码，`delete` 是 Backspace，`forward_delete` 是 Delete；没有 Raw Input 的重复标志，按键没松开又按下算自动重复，不发。没有设备句柄的 Raw Input（`SendInput` 合成的输入，不管哪个程序合成）不算动作；Windows helper 自己不合成输入。

### 7.4 读屏（AX / UIA）

| op | 平台 | 参数 | 回包 | 错误码 |
|---|---|---|---|---|
| `ax.focused` | 两者 | 选填 `pid`（缺省取系统焦点所在的 app） | `focus`，没有焦点控件时 null；选填 `app_pid` | `permission_denied`、`ax_timeout` |
| `ax.dialog_buttons` | 两者 | `pid` | `buttons`：`rect` 数组 | `permission_denied`、`ax_timeout`、`process_gone` |
| `ax.overlays` | 两者 | — | `banners`、`ime`：`rect` 数组 | `permission_denied`、`ax_timeout` |
| `ax.hit_chain` | 两者 | `point`；选填 `exclude_pids` | `pid`（或 null）、`chain`：`ax_hit` 数组 | `permission_denied`、`ax_timeout` |
| `ax.window_text` | 两者 | `pid`、`level`（`focused`/`window`）；选填 `window_bounds`、`cursor`、`max_nodes`、`max_scalars` | `snapshot_id`、`matched`、`text`、`nodes`：`ax_node` 数组、`coverage` | `permission_denied`、`ax_timeout`、`ax_unavailable`、`process_gone` |
| `ax.window_tree` | 两者 | `pid`；选填 `window_bounds`、`previous`、`max_lines`、`max_scalars` | `matched`、`tree_id`、`mode`（`full`/`diff`/`no_change`）、`text`、`lines`、`truncated`、`secure` | `permission_denied`、`ax_timeout`、`ax_unavailable`、`process_gone` |
| `ax.selected_text` | 两者 | `pid` | `text`，没有时 null | `permission_denied`、`ax_timeout` |
| `ax.video_rect` | 仅 Mac | `pid` | `rect`，没有时 null | `permission_denied`、`ax_timeout`、`process_gone` |
| `ax.watch` | 两者 | `pid`（null 表示停止）、`notifications`；选填 `read_selected_text`、`read_value`、`manual_accessibility`、`watch_id` | `watching`、`pid`；选填 `watch_id`、`element`、`window`、`manual_accessibility` | `permission_denied`、`process_gone` |

- 这一组都不读密码控件：macOS 的 `AXSecureTextField` 和角色、标题、描述里带 password、密码等字样的节点（`ScreenContextNode.secure`），Windows 的 `IsPassword`。`ax.focused` 遇到它们 `caret` 为 null。
- `ax.focused` 不读值，只给角色、框和插入点；`editable` 由 helper 判断：两端都按换算后的 `role`、`subrole` 用 `ScreenTargets.isEditable` 的规则，Windows 另把支持 ValuePattern 且不是只读的控件算进去。`element_key` 是焦点控件的不透明标识，焦点换了它就变（macOS 用 `CFHash`，Windows 用 RuntimeId）。
- `ax.focused` 不带 `pid` 时回包另带 `app_pid`：系统焦点所在的 app（macOS 系统级元素的 `kAXFocusedApplicationAttribute`），`focus` 为 null 时也给，读不到时 null；带 `pid` 时不出现。主进程拿它调 `ax.dialog_buttons`，排除自己的 pid 由主进程做。Windows 暂不给（不出现）。
- `ax.dialog_buttons`：焦点窗口是对话框或带 sheet 时，默认和取消按钮的框。Windows 取 `WindowPattern.IsModal` 的窗口里 AutomationId 为 `1`、`2` 的按钮，要实测。
- `ax.overlays`：`banners` 是系统通知横幅，`ime` 是输入法候选窗。Windows 的候选窗按 AutomationId `IME_Candidate_Window`、`IME_Prediction_Window` 找，第三方输入法是否遵守要实测。
- `ax.hit_chain`：`point` 下的元素加最多 3 层祖先。只问 `point` 下那个窗口所属的 app，不用系统级元素（她挡在上面时系统级元素回的是她自己）。
- `ax.window_text`：有上限的投影，不是整棵树。`level: window` 读整个窗口，`focused` 只读焦点控件一带；`window_bounds` 给出时只读框对得上的那个窗口，`matched` 表示找到了；节点数和字数默认最多 2048 个、6000 个字（`focused` 时 2000）。读不完时 `coverage.status` 为 `partial`，`next_cursor` 交给下一次的 `cursor` 接着读。文字原样返回，脱敏由主进程做。
- `ax.window_tree`：一个窗口的控件树的文字版，`window_bounds` 和 `matched` 同 `ax.window_text`。整棵树（`mode: full`）先序遍历，每个控件一行：`<深度个 tab><编号> <角色>[ <标题>][, Value: <值>][, Description: <说明>]`，再按需加 ` (selected)`、` (disabled)`、` (collapsed)` 或 ` (expanded)`、` (showing a-b of n items)`。
  - 编号从 0 起按先序递增，只在这一版里有意义。角色去掉 `AX` 前缀、按词拆开并小写（`AXStaticText` 写 `static text`）。标题取 `AXTitle`，没有时取 `AXDescription`，这时不再写 Description。值只写文本类和可选中类控件的（静态文字、文本框、文本区、组合框、复选框、单选按钮、弹出按钮），每个最多 500 个字；值和标题里的换行写成 `\n`，tab 写成空格。
  - 有 `AXVisibleRows`（或 `AXVisibleChildren`）且比 `AXRows`（或 `AXChildren`）少的容器写 ` (showing a-b of n items)`，只往下走可见的那些。没有标题、值、说明、状态，只有一个子控件的纯容器（`AXGroup`、`AXUnknown`、`AXLayoutArea`、`AXLayoutItem`、`AXSplitGroup`）不占行，子控件接到它的位置上。
  - 密码控件（同本节第一条）照样占一行，但不读值；树里有密码控件时 `secure: true`。
  - 每次回包是一个新版本 `tree_id`，helper 记最近 8 版。`previous` 是其中一版、且是同一个窗口时只回差异：按行比（不看编号），新增的行写 `+<新行>`，没了的写 `-<旧行>`，同一位置深度、角色、标题相同只是值或状态变了的写 `~<新行>`，不变的行不写，`mode: diff`；一行都没变时 `mode: no_change`，`text` 为空串。`previous` 不认识或是别的窗口时回整棵树。`lines` 总是这一版整棵树的行数。
  - 上限：默认最多 800 行、32000 个字（每行连换行一起算；放不下的那一行不写）；整次读取最多 250 ms。到了任何一个上限就停，`truncated: true`，这时 `previous` 认识也回整棵树（`mode: full`），没读到的行不写成 `-`。没找到窗口时 `matched: false`、`mode: full`、`text` 为空串。
  - Windows：一次带 `TreeScope_Subtree` 的 UIA 缓存请求（control view）读整棵树，再一次 `FindAll` 只读不是密码控件的文本框、文本区、组合框的值（密码控件的值从不请求）。标题取 Name，说明取 HelpText；`Text` 控件的 Name 是它的值（同 `AXStaticText`）；复选框的值是 ToggleState（`0`/`1`/`2`），单选按钮和标签页的值是选没选中（`1`/`0`），其他带 SelectionItem 的选中时写 ` (selected)`；`IsEnabled` 为假写 ` (disabled)`；ExpandCollapse 的状态写 ` (expanded)` 或 ` (collapsed)`；列表、树、表格的子项有的在屏幕外（`IsOffscreen`）时只往下走屏幕上的那些，写 ` (showing a-b of n items)`。没有 250 ms 的上限：UIA 每次调用最多 1000 ms（第 5 节第 3 条），整次最多等 1700 ms，到时回 `ax_timeout`；读值之前已用掉 1000 ms 时不读值，`truncated: true`。
- `ax.video_rect`：焦点窗口里第一个 `AXVideo` 元素的框，最多走 12 层、400 个节点。UIA 没有视频控件类型，Windows 由主进程直接用前台窗口的框。
- `ax.watch` 订阅一个 app 的 AX/UIA 通知。`notifications` 取 `focus`、`window`、`title`、`value`、`selection`。每次通知发一个 `ax.notification`，`element` 是通知时的焦点控件：`value_length` 是值的字数，不带值本身；`selected_text` 只在 `read_selected_text: true` 时带（对应「分享打字内容」开关）。
  - 订阅标识 `watch_id`（选填）：每个 `watch_id` 各是一份订阅，同一个 `watch_id` 新的替换旧的，不同的互不影响，可以订同一个 `pid`（活动记录和读屏各订一份）。不带 `watch_id` 是默认的那一份，含义和以前相同：同时一个 `pid`，新的替换旧的；`pid: null` 不带 `watch_id` 只停默认那份，带 `watch_id` 只停那一份。带 `watch_id` 时回包和这份订阅的每个 `ax.notification` 都带同一个 `watch_id`，不带时都不出现。`process_gone`、`permission_denied` 不动已有的订阅。
  - 回包在 `watching: true` 时另带订上那一刻读的 `element`（同通知里的 `element`，读不到时 null）和 `window`（`ax_window`：该 app 焦点窗口的标题和文档路径，读不到时 null）；停止时不带。
  - `element_key`：`ax_element` 也带焦点控件的不透明标识，规则同 `focus.element_key`（macOS `CFHash`）。
  - `source_key`：`ax.notification` 带发出通知的那个元素的标识（同一套 `element_key`），主进程拿它和上一次焦点的 `element_key` 比，丢掉焦点以外元素的值变化。
  - `window`：`window`、`title` 两种通知另带 `ax_window`，焦点控件读不到、`element` 为 null 时也读，读不到窗口时 null；其他通知不出现。
  - `read_value`（选填，默认 false）：为 true 时 `element.value` 带控件值的文字（先 `AXStringForRange` 读 0 到 `value_length`，读不到再读 `AXValue`）；密码控件和系统安全输入开着时为 null。不带或 false 时 `value` 不出现。只在主进程的「分享打字内容」开着时传 true，写法同 `read_selected_text`。
  - `manual_accessibility`（选填，默认 false）：为 true 时订阅前给这个 app 设 `AXManualAccessibility = true`（Electron、Chromium 类 app 要这样才建 AX 树），回包带 `manual_accessibility`：设成功了没有；不带时不出现。名单由主进程按 bundle id 决定（`app/electron/src/main/activity/recorder.ts` 的 `MANUAL_ACCESSIBILITY`）：`com.microsoft.VSCode`、`com.todesktop.230313mzl4w4u92`、`com.openai.codex`、`com.anthropic.claudefordesktop`、`md.obsidian`。
  - Windows：`element_key`、`source_key` 用 RuntimeId；`window` 的 `title` 是这个 app 前台窗口的标题，`doc` 恒为 null（UIA 没有文档路径），`ax_element` 不带 `doc`；`read_value` 的值先读 ValuePattern、再读 TextPattern（Document 反过来），最多 262144 个 UTF-16 单元；回包的 `element` 300 ms 内没读完时为 null。`manual_accessibility` 在 Windows 没有对应的设置：被接受，传 true 时回包带 `manual_accessibility: false`。

### 7.5 截图

| op | 平台 | 参数 | 回包 | 错误码 |
|---|---|---|---|---|
| `capture.window` | 两者 | `window_id`；选填 `format`（`png`/`jpeg`，默认 png）、`max_long_side`、`max_bytes` | `image`、`scale` | `permission_denied`、`window_gone`、`capture_failed`、`too_large` |
| `capture.ambient` | 两者 | `source`（`screen`/`wallpaper`）、`side`；选填 `rect`、`exclude_pids`、`display_id` | `width`、`height`、`rgba` | `permission_denied`、`capture_failed` |

- `capture.window` 截一个窗口，按它的像素尺寸，不带鼠标指针。给了 `max_long_side` 就把长边缩到它；`jpeg` 质量 0.8，透明处铺白（沿用 `uploadJPEG`）。编码后超过 `max_bytes` 回 `too_large`；不给 `max_bytes` 时 Windows 按 12533760 字节算，macOS 不设上限、超长的回包由写出端换成 `internal`（base64 后给回包的其余部分留 64 KiB，整行不超过 `max_line_bytes`）。没有录屏权限时不弹窗，回 `permission_denied`（无人值守的请求不能弹系统框）。Windows 用 `CreateForWindow`，保留黄色边框；设了 `WDA_EXCLUDEFROMCAPTURE` 的窗口可能拿到黑帧或拿不到帧，等不到帧时回 `capture_failed`。
- `capture.ambient` 只回一张 `side`×`side` 的小图（RGBA，每像素 4 字节），供主进程算环境色，不留原图。`screen` 截 `rect` 那块屏幕并排除 `exclude_pids` 的窗口（她自己）；`wallpaper` 读 `display_id` 那块屏的壁纸（Windows `SPI_GETDESKWALLPAPER`）。

### 7.6 OCR

| op | 平台 | 参数 | 回包 | 错误码 |
|---|---|---|---|---|
| `ocr.languages` | 两者 | — | `languages` | `ocr_unavailable` |
| `ocr.recognize` | 两者 | `window_id` 和 `image` 二选一；选填 `languages` | `text`、`lines`：`ocr_line` 数组、`languages` | `permission_denied`、`window_gone`、`capture_failed`、`ocr_unavailable` |

- 给 `window_id` 时 helper 自己截图再识别，像素不经过管道。行按从上到下、再从左到右排，`text` 是各行用 `\n` 连起来。`languages` 缺省时 macOS 用 `zh-Hans`、`en-US`，Windows 用 `ocr.languages` 里有的中文和英文。
- Windows（`Windows.Media.Ocr`）的中文结果字间带空格，helper 去掉相邻 CJK 字符之间的空格再回。机器上没有可用的识别语言时回 `ocr_unavailable`。
- `bounds` 是左上原点的归一化坐标。agentd 现在收的是左下原点（`scope` 为 `window_image_ocr_normalized_bottom_left`），主进程转发前换过去，agentd 不改。

### 7.7 按住说话和麦克风

| op | 平台 | 参数 | 回包 | 错误码 |
|---|---|---|---|---|
| `speech.locales` | 两者 | — | `engine`、`locales` | `asr_unavailable` |
| `mic.start` | 两者 | `session`、`locale`；选填 `transcribe`（默认 true）、`level_events` | `session`、`locale`、`sample_rate` | `permission_denied`、`mic_busy`、`no_audio_device`、`locale_unsupported`、`asr_unavailable` |
| `mic.stop` | 两者 | `session`；选填 `discard` | `session`、`text`、`duration_ms` | `not_recording` |
| `ptt.register` | 两者 | `combo` | `registered` | `bad_hotkey`、`hotkey_taken`、`permission_denied` |
| `ptt.unregister` | 两者 | — | `unregistered` | — |

- 按住说话由主进程组合：`ptt.down` 时 `mic.start`，`ptt.up` 时 `mic.stop`，把 `text` 交给 agentd 的 `POST /say`。按下确认窗口、打断角色说话、提示条都在主进程（`PushToTalkPress`、`VoiceHintTracker`）。
- 只有按住说话的按键进 helper，因为它要松开事件，Electron `globalShortcut` 和 `RegisterHotKey` 只给按下。快速输入、看一眼、显隐角色、点穿、轮盘菜单、选区这些普通热键由主进程用 `globalShortcut` 注册（第 9 节）。
- `ptt.register` 的 `combo` 用 `Config.parseHotkey` 的写法（`right_option`、`control+option+space`）；只有一个按键，再注册时替换旧的。按下发 `ptt.down`，松开发 `ptt.up`。macOS：组合键用 Carbon `RegisterEventHotKey` 收按下和松开；`right_option` 每 50 ms 轮询键状态，要输入监控权限，没有时回 `permission_denied`。Windows：用 Raw Input（`RIDEV_INPUTSINK`，只看这一个键，不记其他按键），和第 7.3 节的输入计数共用同一个隐藏窗口和同一份注册（一个进程每类设备只能注册给一个窗口）；Windows 键（`command`）保留给系统，回 `bad_hotkey`；`option` 对应 Alt，`right_option` 对应右 Alt（带 E0 扩展标志的 `VK_MENU`），AltGr 带出的合成左 Ctrl 不算按键。组合键在主键按下、而按着的修饰键恰好是所列那几个时算按下，主键松开时算松开；按住时的自动重复不再发 `ptt.down`。被别的程序占用时回 `hotkey_taken`，主进程把这个名字报给设置页；Raw Input 查不出占用，Windows 不回 `hotkey_taken`。
- `mic.start` 开麦克风并开始本机识别；`locale` 是 `zh-CN` 这样的标识，helper 换成识别引擎支持的等价语言，没有时回 `locale_unsupported`。macOS 用 SpeechTranscriber（macOS 26 起），缺语言资源时先下载，所以 `timeout_ms` 是 120 秒；低于 macOS 26 时回 `unsupported`。Windows 用 WASAPI 共享模式在默认采集端点上采集，由系统换成 16 kHz 单声道；识别用 sherpa-onnx（`ac-helper.exe` 旁边的 `sherpa-onnx-c-api.dll` 和 `onnxruntime.dll`）的离线 SenseVoice-Small int8 模型，`locale` 按语言子标签对到 `speech.locales` 的一项（`zh` 对 `zh-CN`），识别时由模型自己判语言。模型不随包发：第一次要它的 `mic.start` 用 WinHTTP 下载到 `%LOCALAPPDATA%\AgenticComplex\models\sensevoice-<sha256 前 8 位>\`（第 1 节第 3 条之外 helper 写的另一处文件），先写临时名，大小和 sha256 都对上才改成正式名字；下载失败回 `asr_unavailable`（带原因，`retryable: true`），正式名字下不留残缺的文件；110 秒内没下完也回 `asr_unavailable`（`retryable: true`），下载接着在后台进行，下一次 `mic.start` 等的是同一次下载。识别器第一次用时载入，之后一直留着。一次录音最多录 60 秒。没有麦克风权限时不弹窗，回 `permission_denied`（Windows 从 WASAPI 的拒绝访问看出隐私设置不让桌面应用用麦克风）。同时只有一个会话，第二个回 `mic_busy`。
- 录音期间按 `level_events` 发 `mic.level`（RMS，0–1，每秒最多 20 个），识别有中间结果时发 `speech.partial`。Windows 的 SenseVoice 不是流式的：录音期间每 600 ms 把到此为止的录音重新识别一遍，文字变了才发 `speech.partial`。`speech.locales` 在 Windows 回 `engine` 为 `sherpa-onnx-sensevoice`、`locales` 为 `zh-CN`、`en-US`、`ja-JP`、`ko-KR`、`yue-HK`，只有那两个 DLL 缺失或载入不了时回 `asr_unavailable`。
- `mic.start` 下载语言资源期间每 250 ms 发一个 `speech.download`（`fraction` 0–1；`completed`、`total` 是系统下载进度的单位数，macOS 的 `Progress` 不写单位，主进程当字节读）。这是唯一在打开它的 op 回包之前发的事件（`ops.json` 的 `during`）：只在那次 `mic.start` 还没回包时发，回包后不再发。没有要下载的不发。Windows 下载识别模型时发，`completed`、`total` 是字节。
- `ptt.typed`：`right_option` 按住期间第一次有别的键按下时发一次（每次按住最多一个，在这次的 `ptt.down` 和 `ptt.up` 之间），表示这次按住是在打 Option 字符，不是按住说话。macOS 在 50 ms 的键状态轮询里读 `CGEventSource.secondsSinceLastEventType` 的 keyDown，不记是哪个键。组合键自带一个键，不发。Windows 现在不发；主进程收不到时照旧（只按按住时长判）。
- `mic.stop` 关麦克风，等识别收尾，回最终文字；`discard: true` 时不识别，`text` 为空串。

### 7.8 电脑控制

| op | 平台 | 参数 | 回包 | 错误码 |
|---|---|---|---|---|
| `control.observe` | 两者 | `pid`、`window_id`；选填 `include_text`、`include_image`、`max_elements`、`max_text_scalars` | `snapshot_id`、`target`、`elements`：`control_element` 数组、`truncated`、`text_truncated`；`include_image` 时另有 `image` | `permission_denied`、`window_gone`、`ax_timeout`、`too_large`、`secure_input` |
| `control.act` | 两者 | `snapshot_id`、`action`（`press`/`set_value`/`type`/`click`/`scroll`）；按动作选填 `element_id`、`text`、`x`、`y`、`delta_y` | `effect`（`confirmed`/`unverifiable`） | `permission_denied`、`stale_snapshot`、`element_required`、`element_gone`、`target_changed`、`secure_element`、`secure_input`、`action_refused`、`unsupported_action`、`invalid_text`、`invalid_point`、`invalid_scroll`、`foreground_required`、`occluded_target` |
| `control.read` | 两者 | `snapshot_id`、`element_id` | `value`、`title` | `stale_snapshot`、`element_gone`、`target_changed`、`secure_element`、`secure_input` |
| `control.listen` | 两者 | `endpoint`、`token_file` | `endpoint` | `already_running`、`endpoint_unavailable` |
| `control.respond` | 两者 | `conn`、`response` | `sent` | `conn_gone` |

- 授权（哪个会话、哪个窗口、哪些权限、5 次 120 秒）、暂停、取消、等待授权都在主进程（`ComputerControlConsent`）。主进程先查授权，再调 helper；helper 只管读和做，并且在做之前复核目标。
- `control.observe` 广度优先读窗口的控件，最多 `max_elements`（默认 80）个、文字共 `max_text_scalars`（默认 4000）字；跳过隐藏的、在窗口外的和密码控件；`bounds` 相对窗口左上。`element_id` 只在这次快照里有效。`include_image` 时附窗口截图，PNG 超过 2.5 MB 回 `too_large`。macOS 安全输入开着时回 `secure_input`。
- `control.act`：
  - `press` 要 `element_id`（macOS `AXPress`，Windows InvokePattern）。
  - `set_value`、`type` 要 `element_id` 和最多 4096 字节的 `text`（macOS 写 `AXValue`，Windows ValuePattern.SetValue），写后读回一致时 `effect` 为 `confirmed`。
  - `click`、`scroll` 要窗口内坐标 `x`、`y`（相对窗口左上），`scroll` 另要整数 `delta_y`（夹到 ±600）。目标 app 必须已在前台（`foreground_required`），坐标处的元素必须属于这个窗口（`occluded_target`）。只在 macOS 实现（CGEvent，带标记，`input.watch` 不把它算作用户输入）；Windows 首发不用 `SendInput`，回 `unsupported_action`。
  - 两次动作至少隔 250 ms。任何动作发出后，helper 作废所有快照，之后用旧 `snapshot_id` 回 `stale_snapshot`。
- `control.read` 读快照里一个控件当前的值和标题，主进程拿来和预期比（`desktop_verify`）。
- Windows：UIA，只在 UIA 线程上调（第 5 节第 3 条）。
  - `control.observe` 从窗口的 UIA 元素起按 control view 广度优先读；`IsOffscreen` 的算隐藏，`IsPassword` 的算密码控件，都不列，也不往下走。`target` 和 `windows.list` 的同一个窗口一样（`bounds` 是 DWM 的扩展边框），窗口元素自己的 `bounds` 因此可以比窗口大一圈不可见的边。`title` 取 Name，没有时取 HelpText；`Text` 控件的 Name 是它的 `value`（同第 7.4 节），`title` 只取 HelpText；`Edit`、`Document` 的 `value` 按第 7.4 节的 `read_value` 读。`control.read` 同样：`value` 是 `Text` 控件的 Name 或按 `read_value` 读的值，`title` 是 Name（`Text` 控件为 null）。支持 InvokePattern 的控件 `actions` 为 `["AXPress"]`。`include_image` 的图同 `capture.window` 的 PNG。走查本身最多 1 秒，UIA 没答完回 `ax_timeout`。
  - `control.act`：`press` 的 `effect` 恒为 `unverifiable`。快照之后才成为密码控件的（`IsPassword`），`act`、`read` 回 `secure_element`。动作发出后 UIA 超时的，`effect` 为 `unverifiable`；动作发出之前 UIA 没答完，`act`、`read` 回 `timeout`（`retryable: true`），等不到 UIA 线程回包时 `act` 回 `timeout` 且不带 `retryable`（动作可能已经发出）。
  - `click`、`scroll` 在其他检查（包括 `stale_snapshot`）之前回 `unsupported_action`，不算动作：不作废快照，也不占 250 ms 的间隔。所以 `foreground_required`、`occluded_target`、`invalid_point`、`invalid_scroll` 在 Windows 不出现。
  - 没有系统安全输入，从不回 `secure_input`；不要系统权限，从不回 `permission_denied`。
- `control.listen` 建 agentd 调用桌面工具的本机端点，写令牌文件（0600，Windows 只给当前用户的 DACL）。macOS 的 `endpoint` 是 Unix socket 路径（最长 103 字节，目录 0700 且属于当前用户）；Windows 是 `\\.\pipe\…`，带只允许当前用户的显式 DACL、`PIPE_REJECT_REMOTE_CLIENTS`、`FILE_FLAG_FIRST_PIPE_INSTANCE`。已有实例在听时回 `already_running`。
  - 每个连接一个请求。helper 校验同一用户和令牌后发 `control.request`（`conn` 是 helper 给的连接号，`request` 是去掉令牌后的请求对象，形状见 `app/electron/src/common/computer-control.ts`），主进程处理后用 `control.respond` 把回答写回并关闭连接。连接已断时回 `conn_gone`。
  - 同时最多 4 个连接在读请求，多的 helper 直接拒绝连接。请求读完、令牌验过就不再占名额；在执行的请求由主进程限 4 个（`desktop_cancel`、`desktop_release` 不限），多的回 `bridge_busy`。

### 7.9 权限

| op | 平台 | 参数 | 回包 | 错误码 |
|---|---|---|---|---|
| `permissions.status` | 两者 | — | `accessibility`、`screenRecording`、`microphone`、`automation`、`inputMonitoring`，各为 `granted`/`denied`/`notDetermined`/`notApplicable`；选填 `speech`、`notifications`（同样四种） | — |
| `permissions.request` | 两者 | `kind`（上面五种之一；macOS 还有 `notifications`） | `state` | — |

- 只读不弹窗的是 `permissions.status`；会弹系统框的只有 `permissions.request`，主进程只在用户点了按钮后调它。
- macOS：`automation` 查的是 Terminal 的自动化权限（跳转会话的目标）；`microphone` 请求后，语音识别权限还没决定的话一起请求（麦克风已允许时再请求 `microphone` 不弹麦克风框，只问语音识别）。
- `speech` 是语音识别权限，只有 macOS 回：`notDetermined` 只在 helper 能问时回；helper 所在的应用没写 `NSSpeechRecognitionUsageDescription`（这时问了会结束进程）时回 `notApplicable`。主进程只把 `notDetermined` 当「还没问过」，第一次按住时先问它（`app/electron/src/common/push-to-talk.ts`）；不出现（旧 helper、Windows）按 `notApplicable` 处理。这些权限归属 helper 的「负责进程」（实测时授权弹窗显示的就是它）。
- Windows：辅助功能、录屏、自动化、输入监控没有系统开关，回 `notApplicable`；`permissions.request` 对它们直接回 `notApplicable`。主进程把 `notApplicable` 换成网页认的 `unsupported`。`microphone` 读系统的麦克风隐私开关；请求时短暂打开一次采集，让有逐应用开关的系统弹首次使用框。
- `notifications` 是应用的通知权限，只有 macOS 回：helper 在应用包里时它的主 bundle 就是应用，读 `UNUserNotificationCenter` 的授权（`provisional` 算 `granted`）；请求时向它要提醒和声音的授权，问过后应用才出现在「系统设置 › 通知」里，回问完再读的状态。不在 `.app` 里（开发构建，这时读或问都会抛异常）不问，回 `notApplicable`。Electron 读不到也问不了这个权限，主进程用 helper 的；Windows 上主进程不发这个请求。
- 发通知、登录项和「打开系统设置」不经 helper：主进程用 Electron 的 `Notification`、`app.setLoginItemSettings`、`shell.openExternal`（`x-apple.systempreferences:…`、`ms-settings:privacy-microphone`）。

### 7.10 剪贴板

| op | 平台 | 参数 | 回包 | 错误码 |
|---|---|---|---|---|
| `clipboard.read` | 两者 | 选填 `first_only`、`max_items`、`max_text_bytes` | `items`：`clip_item` 数组、`concealed`、`truncated` | — |

- 每个剪贴板项一个 `clip_item`：`types` 是它的全部类型名（macOS UTI，Windows 剪贴板格式名），再按文件、链接、文字的顺序给出第一个有的：`file`（路径）、`url`、`text`。
- 任何一项标了保密或临时（macOS `org.nspasteboard.ConcealedType`、`TransientType`；Windows `ExcludeClipboardContentFromMonitorProcessing`，或 `CanIncludeInClipboardHistory` 为 0）时整个剪贴板不读：`items` 为空，`concealed: true`。
- `first_only` 只读第一项（选区热键的兜底）。Windows 剪贴板只有一项：`first_only`、`max_items` 被接受但不影响结果。超过 `max_items` 项或某段文字超过 `max_text_bytes` 字节时截断，`truncated: true`。
- 写剪贴板用 Electron 的 `clipboard`，不经 helper。

### 7.11 应用和进程

| op | 平台 | 参数 | 回包 | 错误码 |
|---|---|---|---|---|
| `apps.running` | 两者 | 选填 `regular_only` | `apps`：`app` 数组 | — |
| `apps.installed` | 两者 | — | `apps`：`installed_app` 数组 | — |
| `apps.activate` | 两者 | `pid` 和 `app_id` 二选一；选填 `ancestors` | `activated`、`pid`（被激活的进程，没有时 null） | `process_gone` |
| `terminal.focus` | 仅 Mac | `app`（`terminal`/`iterm`/`ghostty`）；`tty` 和 `cwd` 二选一 | `focused` | `automation_denied`、`not_found`、`script_failed` |
| `process.usage` | 两者 | `pids` | `usage`：`process_usage` 数组，没了的进程不列 | — |

- `apps.running` 的 `regular` 表示有界面、出现在 Dock 或任务栏的 app。
- Windows 的 `app_name`（`window`）和 `name`（`front`、`app`、`installed_app`、`audio_client`）取 exe 版本信息的 `FileDescription`，没有时用不带扩展名的 exe 文件名。
- `apps.installed`：macOS 列 `/Applications`、`/Applications/Utilities`、`/System/Applications`（含 Utilities）和 `~/Applications` 下的 `.app`；Windows 列开始菜单（当前用户和所有用户）的快捷方式。打开它们用 Electron 的 `shell.openPath`，不经 helper。
- `apps.activate` 把 app 带到前台；`ancestors: true` 时从 `pid` 往上找第一个有界面的祖先进程（会话跳转用：tmux 客户端的外层终端）。Windows 受前台锁限制，可能激活不了，这时 `activated: false`，`pid` 仍是目标窗口的进程；找不到窗口时 `pid` 为 null。
- `terminal.focus` 用 AppleScript 切到 Terminal、iTerm 里某个 tty 的标签页，或 Ghostty 里某个目录的窗口；要对应 app 的自动化权限。Windows 没有按 tty 定位终端标签页的接口；tmux、WezTerm、kitty 的命令行跳转由主进程直接起子进程。
- `process.usage`：`cpu_time_ns` 是累计 CPU 时间（用户加系统，纳秒），`resident_bytes` 是常驻内存；算占比由主进程做（`ProcessSampler`）。

### 7.12 字段类型

`ops.json` 的 `types` 是机读版本。类型写法：`str`、`str+`（非空）、`int`、`int+`（正）、`uint`（≥ 0）、`num`、`bool`、`obj`、`b64`、`arr<T>`、`enum(a|b)`，末尾 `?` 表示可以为 null；选填字段可以不出现。

| 类型 | 必填字段 | 选填字段 |
|---|---|---|
| `rect` | `x`、`y`、`width`、`height` | |
| `point` | `x`、`y` | |
| `screen` | `display_id`、`frame`、`visible`、`scale`、`primary` | |
| `window` | `window_id`、`pid`、`bounds` | `layer`、`alpha`、`title`、`app_name`、`app_id` |
| `front` | `pid`、`name`、`app_id`、`window` | `category`（macOS `LSApplicationCategoryType`）、`focused_window_title`（第 7.3 节） |
| `app` | `pid`、`name`、`app_id` | `path`、`launched_at`、`regular` |
| `installed_app` | `path`、`name` | |
| `audio_client` | `pid`、`app_id`、`name`、`running_input`、`running_output` | |
| `input_counters` | `keys`、`left_clicks`、`right_clicks`、`scrolls`、`moves` | |
| `input_idles` | `key`、`pointer`、`scroll`、`click` | |
| `focus` | `pid`、`role`、`native_role`、`subrole`、`frame`、`caret`、`editable` | `element_key` |
| `ax_hit` | `role`、`native_role`、`subrole`、`frame` | |
| `ax_node` | `id`、`parent`（根为 -1）、`role`、`native_role` | `label`、`value`、`selection`、`bounds` |
| `coverage` | `status`（`complete`/`partial`/`empty`）、`scope`、`reasons`、`captured_nodes`、`captured_chars` | `next_cursor` |
| `ax_element` | `role`、`native_role`、`subrole`、`label`、`value_length`、`window_title` | `doc`、`selected_text`、`element_key`、`value`（第 7.4 节） |
| `ax_window` | `title`、`doc` | |
| `image` | `format`（`png`/`jpeg`）、`width`、`height`、`data` | |
| `ocr_line` | `text`、`bounds` | `confidence` |
| `control_target` | `pid`、`app_id`、`window_id`、`bounds`、`launched_at` | |
| `control_element` | `element_id`、`role`、`native_role`、`enabled`、`actions` | `title`、`value`、`bounds` |
| `clip_item` | `types` | `file`、`url`、`text` |
| `process_usage` | `pid`、`cpu_time_ns`、`resident_bytes` | |

Windows 的 `window.app_name` 和各类型的 `name` 同第 7.11 节：exe 版本信息的 `FileDescription`，没有时用不带扩展名的 exe 文件名。

### 7.13 Windows 的角色名映射

Windows helper 把 UIA ControlType 换成 AX 名字填进 `role`，原名填进 `native_role`。表里没有的类型（`Custom`、`TitleBar`、`Header`、`HeaderItem`、`Thumb`、`Separator`、`SemanticZoom`、`AppBar`、`Calendar` 等）`role` 为 `AXUnknown`。`subrole` 只有两种情况不为 null：`IsPassword` 为真的控件是 `AXSecureTextField`，`WindowPattern.IsModal` 为真的窗口是 `AXDialog`。

| UIA ControlType | `role` |
|---|---|
| `Window` | `AXWindow` |
| `Pane`、`Group`、`StatusBar` | `AXGroup` |
| `Document` | `AXTextArea` |
| `Edit` | `AXTextField` |
| `Text` | `AXStaticText` |
| `Button` | `AXButton` |
| `SplitButton` | `AXMenuButton` |
| `CheckBox` | `AXCheckBox` |
| `RadioButton` | `AXRadioButton` |
| `ComboBox` | `AXComboBox` |
| `Hyperlink` | `AXLink` |
| `Image` | `AXImage` |
| `List` | `AXList` |
| `ListItem`、`DataItem`、`TreeItem` | `AXRow` |
| `DataGrid`、`Table` | `AXTable` |
| `Tree` | `AXOutline` |
| `Menu` | `AXMenu` |
| `MenuBar` | `AXMenuBar` |
| `MenuItem` | `AXMenuItem` |
| `Tab` | `AXTabGroup` |
| `TabItem` | `AXRadioButton`（AppKit 的标签页按钮也是这个角色） |
| `Slider` | `AXSlider` |
| `Spinner` | `AXIncrementor` |
| `ProgressBar` | `AXProgressIndicator` |
| `ScrollBar` | `AXScrollBar` |
| `ToolBar` | `AXToolbar` |
| `ToolTip` | `AXHelpTag` |

Windows 窗口属主的要求：UWP 和打包应用的顶层窗口属于 `ApplicationFrameHost.exe`，启动器进程的 pid 也不是窗口的 pid。`app_id` 对 UWP/打包应用取 AUMID（经承载的 CoreWindow 子窗口所在进程解析），对其他应用取小写 exe 名；`pid` 取实际拥有窗口的进程。

已知差异（现状）：helper 对窗口的属主进程直接取 AUMID 和 `FileDescription`，不解析 CoreWindow，UWP 窗口得到的是 `ApplicationFrameHost.exe` 的 pid、名字和 `app_id`，待补齐。

## 8. 事件

每个事件只在打开它的 op 成功之后发（`ops.json` 的 `after`）；关掉或注销后不再发。例外是 `ops.json` 写了 `during` 的事件：只在所列 op 的请求发出后、回包之前发。`data` 的选填字段在 `ops.json` 的 `data_optional`。

| 事件 | 由谁打开 | `data` |
|---|---|---|
| `workspace.changed` | `workspace.watch` | `reason`（`front_app`/`space`/`screens`）、`front_pid`（或 null） |
| `presence.edge` | `presence.watch` | `edge`（`lock`/`unlock`/`sleep`/`wake`/`display_sleep`/`display_wake`） |
| `input.activity` | `input.watch` | `kind`（`key`/`mouse_down`/`mouse_up`/`scroll`） |
| `input.action` | `input.actions` | `kind`（`click`/`context_menu`/`shortcut`/`submit`）、`pid`、`target`（`ax_element`，读不到时 null）；选填 `keys`（`shortcut`、`submit` 带，第 7.3 节） |
| `ax.notification` | `ax.watch` | `pid`、`notification`、`element`（`ax_element`，读不到时 null）；选填 `source_key`、`window`（`ax_window`）、`watch_id`（第 7.4 节） |
| `mic.level` | `mic.start` | `session`、`rms` |
| `speech.partial` | `mic.start` | `session`、`text` |
| `ptt.down` | `ptt.register` | `{}` |
| `ptt.up` | `ptt.register` | `{}` |
| `ptt.typed` | `ptt.register` | `{}`（第 7.7 节） |
| `speech.download` | `mic.start` 回包之前（`during`） | `session`、`fraction`、`completed`、`total`（第 7.7 节） |
| `control.request` | `control.listen` | `conn`、`request` |

## 9. 不经 helper 的平台功能

下面这些系统功能由 Electron 主进程或页面直接做，不进 C12：

| 功能 | 做法 |
|---|---|
| 进程入口、单实例锁、无 Dock 图标 | 主进程入口；`app.requestSingleInstanceLock`；`app.dock.hide`、`skipTaskbar` |
| 装配顺序、应用菜单、退出清理、信号 | 主进程；`Menu.setApplicationMenu`；`before-quit`；`process.on('SIGTERM')` |
| hook 转发脚本、子进程有序停止 | `fs`、`child_process`；Windows 用 `.cmd` 和 `taskkill` |
| 开发重载通知 | 主进程监视 `dev-receipt.json` |
| C3 服务端 | C3：Node `net`，Windows 由渲染器建命名管道 |
| 角色预览 | Electron `sharedTexture` |
| 登录项 | `app.setLoginItemSettings` |
| 设置页录热键 | 页面 `keydown`（`code` 可区分 `AltRight`） |
| 看一眼、显隐角色、点穿、轮盘菜单、选区的全局热键 | `globalShortcut.register`；注册失败（被占用）时报给设置页 |
| 快速输入热键 | `globalShortcut.register` |
| 目录选择 | `dialog.showOpenDialog` |
| 系统通知和点击回调 | `Notification`（Windows 要 AppUserModelID） |
| 面板层级、所有桌面空间、全屏之上 | `setAlwaysOnTop('screen-saver')`、`setVisibleOnAllWorkspaces` |
| 菜单栏图标、菜单、头像右键菜单 | `Tray`、`Menu.buildFromTemplate`、`menu.popup` |
| 主窗口、栈面板、打开目录 | `BrowserWindow`（透明、`setIgnoreMouseEvents(…, {forward: true})`）；`shell.openPath`、`shell.showItemInFolder` |
| 主窗口让位 | 主进程读自己窗口的 `getBounds()`，经 C3 `keep_clear` |
| 悬停和点击轮询 | `screen.getCursorScreenPoint()` |
| `agentic-complex-ui://` 资源 | `protocol.handle` |
| 引导窗口 | 页面加 `permissions.*`（第 7.9 节） |

## 10. 校验

- `validate.py FILE`：先用 `check_spec` 查 `ops.json` 自洽，再按 `ops.json` 检查一个会话（两个方向按时间顺序混排）：第 2 节的消息格式和 `id`、`seq` 规则，第 4 节的握手、`hello` 后的平台和 `ops`，各 op 的参数、回包和错误码，第 8 节事件的前置 op（`after`，或 `during` 的 op 在途）和 `data`（含 `data_optional`）。合法时退出码 0，否则打印第一个错误，退出码 1。`check(lines)` 返回 `None` 或错误字符串。
- `examples/ok-*.ndjson`：合法会话，合起来每个 op 至少有一个成功的请求和回包，每个事件至少出现一次，两个平台各有一份 `hello`；`examples/bad-*.ndjson`：每份违反一条规则。
- 样例测试是 `protocol/tools/tests/test_c12_platform_helper.py`，在门禁的 `protocol` suite 里：`ok-*` 全过、`bad-*` 按预期的错误被拒，`ops.json` 自洽，第 7、8 节表格里的 op、平台和事件与 `ops.json` 一致。
- helper 落地后，两个 helper 各自的测试按 `examples/ok-*.ndjson` 里主进程发的请求回放，回包交给 `check()`；Windows helper 回放时，`hello.ops` 里没有的 op 应回 `unsupported`。
