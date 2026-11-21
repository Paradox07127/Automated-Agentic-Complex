# Electron 外壳与平台 helper

[English](shell.en.md) · [文档索引](../README.md)

`app/electron` 是产品唯一的外壳。它读 `--config` 指的 config.json，监督 agentd、渲染器、平台 helper 和语音隧道，在自己的窗口里承载 `web/` 的网页 UI。进程之间怎么通信见[仓库与运行架构](overview.md)，网页一侧见[网页 UI](web-ui.md)。

## 外壳做什么

- 页面经自定义协议 `agentic-complex-ui://app/` 提供，CSP 在 `src/common/ui.ts`。主窗口加载 `main.html`，桌面浮层加载 `stack.html`。找不到页面文件时主窗口显示「界面文件缺失」页，托盘照常工作。
- 托盘菜单列出每个子进程的状态，各行的文字见[发行组件 §5](../components.md#5-缺组件时)。
- 页面里的 `window.agenticComplex` 把每个 op 经 IPC 送到主进程。主进程按 `protocol/ui-bridge/ops.json` 核对面板和 op 名，再交给 `src/main/ops/` 里的处理函数。不许这个面板用的 op 回 `op_not_allowed`，没有处理函数的回 `not_implemented`。

## 源码布局

| 目录 | 内容 |
|---|---|
| `src/common/` | 两端共用的纯逻辑：op 校验与分发、页面里的桥、C3 帧格式、放置、设置项与热键、卡片源、桌面浮层的摆放规则 |
| `src/main/` | 主进程：`index.ts`（窗口、托盘、协议、IPC），以及 agentd 与渲染器的监督、C3 一端、放置、组件导入 |
| `src/main/ops/` | 每个 op 命名空间一个文件；处理函数只经 `context.ts` 的 `OpsContext` 碰 Electron，测试换成假的 |
| `src/main/desktop/` | 桌面浮层的面板窗口和装配 |
| `src/main/preview/` | 角色页预览的会话、取片段和窗口一侧 |
| `src/main/platform/` | 平台差异：默认目录、浮层窗口选项、坐标换算、helper 路径 |
| `native/mac/` | macOS 的 Node-API 插件 `preview.m`：预览 XPC 的客户端和 `setPreventsActivation` |
| `src/preload/` | 在页面世界里装桥；主窗口里还接收预览帧 |
| `test/` | `node --test` 单测；`e2e-headless.test.ts` 只在设了 `AAC_ELECTRON_E2E=1` 时运行 |

`tools/qa/xplat_guard.py` 检查两条分层规则：`src/common/` 不 import `electron` 和 `node:*`；只有 `src/main/platform/` 读当前平台。

## 构建产物

`npm --prefix app/electron run build` 先跑 `tsc --noEmit`，再由 `build.mjs` 用 esbuild 打出 `dist/main.mjs`（ESM）和 `dist/preload.cjs`（沙盒里的 preload 只能是一个 CommonJS 文件）。在 macOS 上它还编出预览插件 `dist/native/preview.node`。

`build.mjs` 往 `dist/main.mjs` 里写两个值：检出的提交（`git rev-parse --short HEAD`）和发行 profile 的 `ui_art` 目录。C3 `hello.build.git` 取前者，没有时为 `unknown`。`agentic-complex-ui://app/art/` 从后者读；没有美术目录时页面不设 `html[data-art]`，按没有贴图的样子显示。公开 profile 不带美术。

## 开发模式

`--dev-web-server <url>` 让页面改从 vite 开发服务器取：

- 只在从仓库启动时生效（app 包里没有 `distribution.json`）。打包的 app 带上它时记一行 `DEV_WEB ignored` 并照旧读 web-ui 组件。
- 只接受 `127.0.0.1` 或 `localhost` 上带端口的 http 源。
- 页面仍在 `agentic-complex-ui://app/` 上，真桥、来源检查和导航守卫都不变。协议把请求经 `net.fetch` 转给 vite；`art/` 和 `characters/` 仍由外壳自己供。
- vite 的回答带开发 CSP：脚本和样式加 `'unsafe-inline'`，`connect-src` 放开 vite 的 HMR websocket。vite 要带 `EF_DEV_HMR_PORT=<端口>` 启动（`web/vite.config.ts`），因为协议 URL 里没有端口。
- 每个页面文档在 `companion.log` 记一行 `DEV_WEB <页面> <- <vite 地址> <状态>`。

`--quit-after <秒>`（1–600）到时记一行 `QUIT_AFTER …`，再像托盘的「退出」一样退出。`--no-push-to-talk` 不建按住说话；`--no-attention` 不采样用户的窗口、不注册全局热键。开发面板默认带这两个参数，见[开发与发行](../development.md#开发运行dev-console)。

## 从 app 包启动

`Contents/Resources/distribution.json` 存在就是从 app 包启动（`src/main/packaged.ts`），不存在就按仓库启动。从 app 包启动时：

1. config.json 在支持目录里。拆分版先把 app 旁的 `components/` 导入支持目录，再解析组合锁。
2. 第一次启动用 `character_tool.py compose` 合出种子角色库 `character-libraries/seed-<sha16>`；它的 SHA 必须等于 `distribution.json` 的 `catalogSHA256`。种子换了时经 `distribution_seed.py` 迁移。缺 agentd、runtime.python 或角色组件时不合成，config.json 记 `character_library_missing`。
3. config.json 新建时写默认值，已有时保留用户设置。每次启动重算 `avatar_app`、组件路径和 `missing_components`，整份先按 `parseConfig` 校验，变了才原子替换（权限 0600）。
4. 页面从 web-ui 组件的 `ui/` 提供，helper 是 `Contents/MacOS/ac-helper`。

## 桌面浮层

桌面浮层是六个透明、无边框、无阴影的面板窗口，都加载 `stack.html` 的一个路由（`src/main/desktop/assembly.ts`）：

| 面板 | 路由 | 层级（高于角色窗口） | 内容 |
|---|---|---|---|
| 气泡 | `#/bubble` | 1 | 她的话、快速输入；她隐藏或被全屏挡住时改成菜单栏下的字幕条 |
| hud | `#/hud` | 2 | 卡片栈 |
| 图标环 | `#/ring` | 3 | 指针停在她身上时展开的一行图标 |
| 命令层 | `#/cmd` | 弹出菜单一级 | 命令环、镜头与动作，一次一层 |
| 控制台 | `#/console` | 弹出菜单一级 | 菜单栏图标下的卡片 |
| 状态小图标 | `#/chip` | 1 | 气泡旁的圆点 |

- macOS 上面板是 `type: 'panel'` 加 `setPreventsActivation`，显示在所有 Space 和全屏 app 之上（`platform/index.ts` 的 `overlayOptions`、`makeOverlay`）。
- 面板平时点穿（`setIgnoreMouseEvents(true, {forward: true})`）。主进程每 1/30 s 查一次指针，指针在页面报的交互区里才接点击。页面经 `window.setInteractiveRegions`、`window.setContentSize` 报交互区和内容大小。
- 位置跟着她走：身体框来自 C3 的 `hit_capsules` 和 `placement`，规则在 `common/desktop-follow.ts` 和 `common/desktop-layout.ts`，算出的锚点推给页面的 `window.onAnchor`。
- 卡片来自 `common/stack-source.ts`：轮询读 `/approvals`、`/tasks`、`/agent/interactions`、`/agent/tasks` 和 `/commitments?state=triggered`，出审批、编码验收、问题、交付和提醒卡；`/feed` 的 `announce` 按 `notify_*` 设置变成卡片。外壳自己也发卡（按住说话的提示、拖给她的东西、通知）。
- 键盘：面板平时不取焦点。`window.requestKey` 只在面板显示、1 s 内在交互区里按过鼠标时让面板成为 key；打开命令层时面板直接成为 key。成为 key 用面板窗口的 `focus()`，不激活本 app，前台 app 不变。`window.releaseKey` 交还键盘。
- 拖动：页面报 `drag: true` 的交互区可以拖动面板。松手时离默认位置不到 12 pt 回到默认位置；离她的身体框超过 400 pt 就钉在那里；否则记下相对她的一侧和间距（最多 96 pt），之后跟着她走都保持这个偏移。偏移跨启动保留，按 `desktopPanelOffset.v3.<面板>` 存在支持目录的 `desktop-offsets.json`。

## 托盘与菜单

macOS 上左键点菜单栏图标开关控制台，右键或按住 Option 左键先收起控制台再弹出菜单；没有桌面浮层时左键也弹出菜单（`desktop/tray.ts`）。Windows 上托盘菜单是右键的 context menu。

## 角色页预览

macOS 上主窗口的角色页连渲染器的预览 XPC 服务（C3 合同的「附录：预览 XPC」）。服务名是主 bundle 的 id 加 `.preview`，所以服务必须在这个 app 的 `Contents/XPCServices/<bundle id>.preview.xpc` 里。`node_modules` 里的开发用 Electron.app 没有这个服务，从仓库启动时角色页预览报「预览服务断开了」，页面退回静态立绘。

主进程把每帧的 IOSurface 用 `sharedTexture.importSharedTexture` 导入，经 `sendSharedTexture` 交给主窗口，preload 把它画进页面报的矩形。窗口隐藏、最小化或页面隐藏预览时发 `pause`，回来时发 `resume`。Windows 上还没有预览通道，`avatar.preview.*` 回 `not_implemented`。

## 平台 helper

`ac-helper` 是外壳和系统之间的一层：macOS 版是 Swift 写的 `app/helpers/mac`，Windows 版是 C++ 写的 `app/helpers/windows`（`ac-helper.exe`）。主进程启动它，经 stdin 和 stdout 用 [C12](../../protocol/C12-platform-helper/CONTRACT.md) 的 NDJSON 协议对话；stderr 是它的日志。helper 只调系统 API、回原始读数，策略都在主进程。

- macOS：AppKit 的 op 和各种 watch 在主线程上跑，helper 一直跑着主线程的 run loop；其余 op 在并发队列上跑。
- Windows：除 `hello`、`cancel`、`shutdown` 外，每个请求在自己的线程上跑。一把锁管 stdout 和在途请求的集合，所以每个请求恰好有一个回答：来自处理函数、`cancel`（`cancelled`）或 `shutdown`（先对所有在途请求回 `cancelled`，再回自己）。
- Windows 版用自己写的约 300 行 JSON 解析器，不引第三方单头文件：C12 要分清 `1` 和 `1.0`、拒绝 NaN 和过深嵌套、原样传 UTF-8，也省去第三方代码的许可和更新管理。

## 平台 helper 与权限

- 系统的权限框写的是 app（helper 的责任进程），不是 helper。从终端启动 helper 时，授权算在终端上。
- `permissions.status` 把 helper 的读数换成网页的取值（`src/main/ops/permissions.ts`）：`notApplicable` 换成 `unsupported`；屏幕录制和辅助功能没允许时一律是 `notDetermined`，因为系统分不出拒绝和没问过。通知权限 Electron 读不到，总是 `unsupported`。
- 引导页的权限行：Windows 上的 `notApplicable` 算作已允许；自动化没决定时显示「用到时询问」。
- `permissions.openSettings` 打开系统设置的对应页。macOS 上屏幕录制和辅助功能两页先调一次 helper 的 `permissions.request`，app 才会出现在那一页的列表里。Windows 上只有麦克风一页（`ms-settings:privacy-microphone`），其他页回 `failed`。

## 坐标系

- 放置空间（`src/common/placement.ts`）是一个全局空间，y 向上，主屏在前。
- C3：macOS 上是 AppKit 点、y 向上，和放置空间相同；Windows 上是物理像素、y 向下，外壳经 `screen.dipToScreenRect` 换算再把 y 取负（`src/main/platform/screens.ts`）。
- helper：原点在主屏左上、y 向下。主进程按平台换成 C3 坐标：macOS 上翻成 AppKit 坐标，Windows 上不变（`common/attention.ts` 的 `HelperY`）。

## 隐私规则

attention 采样（每秒一拍，读前台窗口、标题和输入计数）：

- 黑名单 `<agentd_state_dir>/blacklist.json` 按 bundle、app 名、域名及子域、标题正则过滤。外壳自己的进程和自己的 bundle 总是隐藏。
- 可能无痕的浏览器窗口不带标题；前台是无痕窗口时整个前台记为 `<hidden>`；无痕状态未知的浏览器只发 app 和 bundle id。
- 安全输入时不发标题。`redact_sensitive` 开着时标题先脱敏，再截到 256 个码点。
- 被隐藏的前台窗口在鼠标下时，鼠标下的窗口也隐藏。

屏幕上下文（读前台窗口的文字、OCR、截图）：

- 黑名单（含自己的进程）、无痕、无痕状态未知的浏览器、安全输入时不读也不发。
- 密码控件的节点不发。`redact_sensitive` 开着时文字和标题先脱敏，标题截到 512 个码点。
- 用户收窄同意范围时经 `POST /context/privacy/sync` 撤回已发的内容。
- 读选区时，剪贴板里标了保密或临时的内容不读。

带 `--no-attention` 启动时以上采样都不建，helper 收不到读窗口的请求。

## 电脑控制

`src/common/computer-control.ts` 是授权、次数和时限、请求检查的纯规则，`src/main/control/` 调 helper。授权的寿命和次数见[工具网关](tool-gateway.md)。外壳一侧的规则：

- 每个会话、一个精确的窗口（进程代际和几何）、四种权限分别授权；授权只来自授权小窗上用户点的按钮。没授权时回 `permission_required`，另一个会话占着时回 `desktop_busy`。
- 快照 15 s 过期，每次动作后全部作废，两次动作至少隔 250 ms。
- 浏览器回 `browser_driver_required`。黑名单里的 app 和窗口标题回 `blacklisted`；有标题规则而读不到标题时也回 `blacklisted`。外壳自己的进程不能当目标。窗口变了回 `target_changed`。
- 用户自己按键、点击或滚动时任务暂停、快照作废，点「继续」后要重新观察。helper 不给输入监控时不执行动作（`input_monitor_unavailable`）。密码控件、安全输入、前台和遮挡由 helper 判断。
- 停止、取消、撤销授权和用户接管立即打断：在途请求回 `stopped`，已发给 helper 的 `control.act` 收到 C12 `cancel`。

## 全局热键

外壳在桌面浮层起来之后用 Electron 的 `globalShortcut` 注册这些热键，设置里可以改。

| config.json 键 | 默认 | 作用 |
|---|---|---|
| `hotkey_quick_input` | `control+option+space` | 打开快速输入 |
| `hotkey_look` | `control+option+l` | 识读屏幕 |
| `hotkey_toggle_avatar` | `control+option+h` | 显示或隐藏角色 |
| `hotkey_click_through` | `control+option+p` | 临时全部点穿 |
| `hotkey_radial_menu` | `control+option+r` | 打开或收起命令环 |
| `hotkey_selection` | `control+option+s` | 读取选中文字，随快速输入发出 |
| `voice_hotkey` | `right_option` | 按住说话（经 helper 注册） |

空值不注册。注册失败（被别的程序占用或不是热键）的名字在设置页标出。带 `--no-attention` 时一个都不注册。

## 按住说话

`src/common/push-to-talk.ts` 组合 helper 的 op：

- agentd 在运行、helper 握过手时用 `voice_hotkey` 注册。`right_option` 按满 0.15 s 才开始；组合键立即开始。
- 开始时先打断她：发 C3 `stop_speech`，再 `POST /turn/cancel`（`reason: "barge_in"`）。麦克风已允许就开始录音，没决定时先弹系统框、这次不录。
- 松开后按住不到 0.3 s 或没有识别出文字就不发，否则 `POST /say`（`source: "voice"`）。每次发送带一个新的 `Idempotency-Key`，连接断了用同一个键再发一次。

## 语音隧道

`src/main/tunnel/supervisor.ts`：config.json 的 `tts_tunnel_host` 非空、`tts_url` 写了端口时，外壳用 runtime.python 跑 `app/Resources/parent_watch.py`，由它拉起 `ssh -N -L 127.0.0.1:<端口>:127.0.0.1:<端口> <主机>`，外壳退出时隧道一起退出。输出写进 `logs/tunnel.log`。

- 主机名以 `-` 开头或含空白、控制字符时不起 ssh，状态是「SSH 转发主机无效」。
- 端口已被占用且占着的全是本用户的 ssh 时，状态是 `external`（沿用已有连接），60 s 后再查；否则是「端口 <端口> 被占用」。
- 崩溃后按 agentd 的退避重启。停止时先 SIGTERM，4 s 后 SIGKILL。

## 单实例与页面守卫

- 每个支持目录一个外壳：`app.requestSingleInstanceLock` 在 `userData` 设到 `<支持目录>/electron` 之后取锁，所以带不同 `--config` 的运行互不阻挡。取不到锁时记 `LOCKED …` 并以 0 退出。
- 页面守卫（`src/main/web-guard.ts`）：导航只放行 `agentic-complex-ui://app`，http(s) 链接交给系统浏览器；页面不能开新窗口；右键菜单只在可编辑处和有选中文字时出现。
- 页面的错误级控制台消息写进页面日志目录的 `ui.log`：每分钟最多 60 条，每条截到 4096 字节，满 1 MiB 时移到 `ui.log.1`。

## 退出

SIGTERM 和 SIGINT 每次收到都调 `app.quit()`，和托盘的「退出」走同一条路：`will-quit` 先停渲染器、agentd 和 helper（`src/main/quit.ts`）。Electron 自己的处理器只接第一次信号，之后恢复默认动作，子进程还没停完时第二个信号会直接杀掉主进程。Electron 的处理器在主脚本第一次运行之后才装上，所以外壳在 `app.whenReady()` 之后再装自己的。Windows 上没有可接的 SIGTERM。

## Windows 差异

- 渲染器是 `efw.exe`。Windows 上没有 app 包，config.json 必须写 `avatar_executable`。外壳连渲染器建的命名管道，经 `--agentic-complex-host-socket` 告诉它管道名。
- 用角色库（`character_catalog`）时，外壳为每个角色算出 `--package <角色目录>`：`current.json` 条目 → `character.json` 的 `components.render.native_bundle.file` → bundle 里该角色的 `d3d11_frame.file` → 它所在的目录。没有 `d3d11_frame` 的角色在 Windows 上不渲染，和纯文字角色一样。
- 切角色：外壳给 efw 传每个可渲染角色的 `--package-of <id>=<角色目录>`，efw 在进程内应答 `set_character`，不重启渲染器；切到或切出纯文字角色时重启。
- 「录屏时隐藏角色」（`hide_on_screen_capture`）在 Windows 上默认关，改了要重启渲染器。
- 不带 `--config` 时的默认目录：支持目录 `%APPDATA%\Agentic Complex`，agentd 状态目录 `%LOCALAPPDATA%\Agentic Complex\agentd`，页面日志 `%LOCALAPPDATA%\Agentic Complex\Logs`。
- Windows helper 只实现屏幕、窗口、剪贴板、应用、进程、权限、注意力采样、监视和截图类的 op。按住说话、电脑控制、辅助功能读取和 OCR 的 op 回 `unsupported`。
- 没有角色页预览、安装器和签名。

## 给 helper 加 op

macOS（`app/helpers/mac`）：

1. 写好 op，加进 `Ops.handlers`。
2. 加进 `Tests/replay.py` 的 `IMPLEMENTED`，在 `check_answer` 里检查结果；要辅助功能权限的再加进 `NEEDS_AX`。
3. `ops.json` 改了时把改动抄进 `OpTable.specs` 和 `Ops.events`。

Windows（`app/helpers/windows`）：

1. 在 `src/ops_win32.cpp`（或新的 `src/*.cpp`，`build.bat` 全部编译）里写 `Outcome my_op(const json::Value& params)`。`params` 已通过 `ops.json` 的检查。返回 `success(result)` 或 `failure(code, message)`；错误码用 C12 的通用码或该 op 的 `errors`，消息里不放 op 读到的内容。
2. 加进 `find_handler` 的表。从此 `hello` 列出它；在此之前它回 `unsupported`。
3. 加进 `tests/replay.py` 的 `IMPLEMENTED`，样例允许时在 `check_answer` 里检查结果。
4. `ops.json` 改了时把改动抄进 `src/ops.cpp` 的 `op_specs()`；两边的必填参数不一致时回放失败。
5. 碰 UI Automation 的 op 在一个 MTA 线程上跑并自己设超时（C12 §5.3）；打开监听或设备的 op 在回 `shutdown` 之前停掉（C12 §6.1）。
