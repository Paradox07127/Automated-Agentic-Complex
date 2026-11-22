# C3 宿主通信 v27（渲染器 ↔ Companion）

> 渲染器指 `private/renderer/host`（私有组件，不在公开仓库） 的 `metal-avatar-host`；Windows 上指 `private/renderer/windows` 的 `efw.exe`，和本文不同的地方见附录「Windows」。

v27（2026-11-15）：只加不改。加能力 `render_live`、`ambient`，Companion 的 `set_render`、`ambient_sample`，规则 43、44：渲染设置保存后不重启渲染器就生效，Companion 可以把屏幕、壁纸或外观的颜色交给渲染器做环境融合；`pipeline.render` 加可选键；加启动参数 `--agentic-complex-ground-shadow`、`--agentic-complex-ambient`、`--agentic-complex-light-wrap`。v27 是本轮的开放版本，后续合同卡只往这一版追加。消息版本仍为 1。追加（只加不改）：加能力 `touch`；Companion 的 `touch_settings`；渲染器 `click` 的可选 `region`；规则 3、10 增补；规则 45：按部位的点击反应、摸头、捏脸和迎接，四个开关默认关。消息版本仍为 1。追加（只加不改）：加能力 `motion_media`、`action_loop`；`actions[]` 的可选 `media`；`play_action` 的可选 `loop`；Companion 的 `stop_action`；`action_played` 的 `interrupted` 加 reason `stopped`；规则 29、30 增补：动作可以循环播、可以停，带媒体轨的动作报出有哪些轨。消息版本仍为 1。追加（只加不改）：加能力 `layers`；渲染器的 `layers_changed`、`layers_change_failed`；Companion 的 `set_layers`；`hello`、`character_changed` 的可选 `layers`、`hidden_layers`；`set_character` 的可选 `hidden_layers`；外观列表条目的可选 `kind`、`desc`；启动参数 `--agentic-complex-hidden-layers`；规则 46：服装分层，按层隐藏、显示她的服装部件。消息版本仍为 1。追加：「启动」表加启动参数 `--agentic-complex-secondary-motion`（头发衣物物理）和 `--agentic-complex-speech-expressions`（说话表情）；规则 42 补一句：角色页「设定」打开期间主窗口的 `frame` 按 `dialog` 矩形交出，她走到主窗口旁（Companion 侧行为）；规则 35 和 `set_opacity` 一行改成和代码一致：被盖住时她让开、不变淡，Companion 不为盖住发 `set_opacity`。线上格式不变，消息版本仍为 1。追加（只加不改）：加能力 `poses`；`actions[].pose`；Companion 的 `set_pose`；渲染器的 `pose_state`；规则 47：用户让她摆一个姿态并保持，锁定时 agent 不能让她走动或坐下。消息版本仍为 1。追加：规则 19「夹到屏内」的全屏视口部分改成和代码一致：锚点留在屏内（自由边往里 12 pt），身体、头发、道具可以部分出屏；共享边在放置落定后移回本屏；动作播放期间不移动。线上格式不变，消息版本仍为 1。追加（只加不改）：加启动参数 `--agentic-complex-scene-pack`、`--agentic-complex-scene-pack-sha256`、`--agentic-complex-scene-parallax`（场景包见 private/renderer/scene-pack）。渲染器拒收场景包时照常启动角色。有场景包时，全屏视口下渲染器窗口取盒子矩形、不随她移动；规则 20 的视口语义不变。没有新的线上消息，消息版本仍为 1。追加（只加不改）：加能力 `camera_free`、`camera_track`；`set_render.camera` 的可选 `zoom`、`sway`、`closeup`、`live`、`track`，列了 `camera_free` 时 `camera.yaw` 接受 −180…180；`pipeline.render.camera` 的可选 `zoom`、`sway`、`closeup`、`closeup_zoom`、`track`、`stage`；启动参数 `--agentic-complex-camera-zoom`、`--agentic-complex-camera-sway`、`--agentic-complex-camera-track`；规则 49：自由镜头（绕头部放大、晃动、对话近景、拖动中的短跟随）和带相机轨的动作在舞台框里回放。消息版本仍为 1。追加（只加不改）：加能力 `filters`、`capture`、`photo`（`photo` 只占名，字段待定）；`set_render.filter`；Companion 的 `capture`、渲染器的 `captured`；`pipeline.render` 的可选 `filter`；启动参数 `--agentic-complex-filter`、`--agentic-complex-capture-dir`、`--agentic-complex-looks`；规则 43 增补：复刻游戏拍照模式的滤镜，只改她的颜色；规则 50：截图（透明背景、当前输出分辨率，只写进启动参数给的目录）。消息版本仍为 1。追加（只加不改）：加启动参数 `--agentic-complex-scene-stage`（角色包里的 3D 展示台）。找不到展示台时照常启动角色；有展示台时窗口取盒子矩形，她固定在盒子的地面中点。没有新的线上消息，消息版本仍为 1。追加（只加不改）：加能力 `camera_gesture`；渲染器的 `camera_gesture`；规则 49 增补 (h)：按住 ⌘ 在她身上拖动转镜头，⌘ 滚轮、触控板捏合缩放，展示台里不按 ⌘ 的拖动也转镜头，不必先进镜头模式。消息版本仍为 1。追加（只加不改）：加能力 `motion_overrides`、`play_chain`；Companion 的 `set_motion_overrides`、`play_chain`；渲染器的 `motion_overrides`；`action_played` 的可选 `chain`；规则 51：动作覆盖，按角色关链、整池替换池子、改混合时长，运行时生效；规则 52：从一条链的起头片段播一次；附录「预览 XPC」升 `preview_protocol` 2，加 `sequence`。消息版本仍为 1。追加（只加不改）：`motion_overrides` 的可选 `truncated`；规则 51 (g) 增补：回执一行放不下时从 `adjusted` 尾部截掉。消息版本仍为 1。追加（只加不改）：能力 `photo` 定下字段：`set_render` 的组 `dof`、`photo`；`pipeline.render` 的可选 `dof`、`photo`；启动参数 `--agentic-complex-dof`；规则 43 增补：景深开关（镜头处于近景时自动虚化）和拍照面板的光圈、对焦。消息版本仍为 1。追加：加能力 `mod_settings`；Companion 的 `set_mod_settings`、渲染器的 `mod_settings`；`set_character` 的可选 `mod_settings`；启动参数 `--agentic-complex-mod-settings`；规则 53：mod 运行时开关，按外观选开关的取值，不重载角色。另改一个数值：`hello.capabilities` 的上限从 32 项放宽到 64 项（两端运行时都不检查这个上限，旧端不受影响）。消息版本仍为 1。追加：附录「预览 XPC」升 `preview_protocol` 3，`load` 加可选 `loop`：所选片段到片尾从头重播，不回默认片段。C3 线上格式不变，消息版本仍为 1。追加（只加不改）：`actions[].section` 加取值 `"battle"`（攻击动作，桌面上带武器）。消息版本仍为 1。追加（只加不改）：加能力 `camera_bust`；`set_render.camera` 的可选 `framing`（`"full"` / `"bust"`）；`pipeline.render.camera` 的可选 `framing`；启动参数 `--agentic-complex-camera-framing`；规则 49 增补 (i)：半身固定，只画她的上半身、机位不动，交互和触控照常。消息版本仍为 1。追加（只加不改）：`actions[]` 的可选 `default_enabled`；规则 28 增补：actions.json 写了 `default_enabled`=false 的行默认关。消息版本仍为 1。追加（只加不改）：加附录「Windows」：Windows 的渲染器 `efw.exe` 建命名管道、Companion 去连，读到 EOF 不退出、等下一个连接；坐标是物理像素、y 向下；列出 Windows 渲染器本版实现和没实现的消息与能力。macOS 的线上格式和启动参数不变，消息版本仍为 1。追加：规则 14 的 `character_change_failed` 去掉 `superseded`：切换中（收到 `set_character` 到回复它之前）又收到的 `set_character`，Mac 和 Windows 渲染器都立刻回 `switching`；规则 18 和 v9 的说明改成 Companion 每条 `move_window`、`set_visible`、`set_placement`、`fps_tier` 都带 `req`。消息版本仍为 1。追加：「传输」的单连接规则改成已握手的连接保有链接：它关闭之前，另一条连接的 `hello` 被拒绝、连接被关掉，不再顶替旧连接。线上格式不变，消息版本仍为 1。追加（只加不改，C1 v2.7）：渲染器的 `motion_state`，规则 54：片段边界的播放状态，Companion 和 `behavior_receipt` 一样转给 agentd，算进同一个限额；规则 25 增补：`cancelled` 的 reason 加 `user_click`、`give_way`，规则 42 坐、扶被让路结束时回 `give_way`；规则 19 增补：C1 `short_walk` 的 `edge` 目标在自由边上可以让身体部分出屏。样例在 `examples/pending/`。消息版本仍为 1。追加（只加不改）：附录「预览 XPC」的 `load` 加可选键 `render_args`、`output`：角色页预览按桌面的渲染设置和舞台大小渲染；附录的表面尺寸改成和代码一致（缺省 480×576）。消息版本仍为 1。追加（只加不改）：附录「预览 XPC」的 `load` 加可选键 `hidden_layers`：角色页预览按桌面的服装分层画。消息版本仍为 1。追加（只加不改）：加能力 `reactions`（只由 Companion 列）；渲染器的 `reaction`；规则 55：她开始摸头、捏脸、迎接的反应时各报一条，Companion 连同她身上的拖起和右键一起转给 agentd，记进每日简报。样例在 `examples/pending/`。消息版本仍为 1。追加（只加不改）：附录「预览 XPC」的服务 → App 加 `progress`：重新加载时报载入进度，旧服务不发时 App 照常工作。消息版本仍为 1。

v26（2026-11-06）：只加不改。加能力 `keep_clear`、Companion 的 `keep_clear`、规则 42：Companion 把盖在她身上的小矩形（输入框和插入点、对话框按钮、横幅、用户用过的控件、视频）交给渲染器，渲染器让她走开；视频和游戏找不到空地时走到较近的一侧、转向屏幕陪用户看。规则 35 的 `covered` 不变。消息版本仍为 1。

v23（2026-11-04，dual-motion 阶段 2）：只加不改。加能力 `motion_requests`、渲染器的 `motion_request`、规则 40：生成动作后端下，宿主为自己算好的几何向 Companion 请求一段生成片段，Companion 转给 agentd，结果走 C1 v2.5 `event: motion`。消息版本仍为 1。

v22.1（2026-11-03）：只加不改。加 Companion 的 `attention_side`、`present`，渲染器的 `motion.stroke`，规则 39：她看向面板或焦点窗口所在的一侧，展示面板时打响指，响指那一刻告诉 Companion。消息版本仍为 1。

v16.1（2026-10-22，用户授权第一批修复）：补规则 17 的首心跳期限；消息版本仍为 1，字段和已有稳态期限不变。具有 heartbeat 能力的渲染器完成 hello 后，即使从未发出首条心跳也不能无限保持健康。

状态：v27，2026-11-15，见上。v26（2026-11-06）见上；v25（2026-11-06）只加不改：加「启动」一节（Companion 传给渲染器的参数、退出码、startup-status 文件、`--describe`）和附录「预览 XPC」，线上消息和启动参数都不变；v24（2026-11-05）加能力 `pass_through`、Companion 的 `pass_through`、规则 41：光标下是别的 app 的可交互控件时，她在那里的身体不接点击，渲染器自己的指针判定也不在那里开始接点击；v23（2026-11-04）见上。v22（2026-11-02）给 `hit_capsules` 加可选 `visual`：她所有可见网格（含袖子、披风、武器）的外接矩形，供 Companion 摆放面板时避开；v21 加能力 `drop`、渲染器的 `drop`、规则 38：拖到她身上的文件、链接和文字交给 Companion；v20 心跳携带渲染进度，Companion 在渲染停滞时重启渲染器，单帧 GPU 错误只计数；v19 Companion 空闲 working 30、交互 interactive 60，`fps_tier` 增加实时上限字段；v18 角色轮廓在前台窗口上仍可点击（规则 1、35），光标注视不再由 near/hover 门槛开关（规则 36），线上字段不变；v17 加能力 `pipeline`、渲染器的 `pipeline`、`hello.build.renderer`、规则 37。v2 加了 `speech_cancelled`，v3 加了 `stop_speech`，v4 加了 `point_at`，v5 加了 `click`、`stats`，v6 加了 `move_window`、`set_visible`，v7 加了 `set_character`、`character_changed`、`character_change_failed`，渲染器的 `hello` 加了可选字段 `character`，v8 加了 `set_appearance`、`appearance_changed`、`appearance_change_failed`，`hello`、`character_changed` 加了可选字段 `appearance`、`appearances`，`set_character` 加了可选字段 `appearance`。v9 加了全屏视口要的能力协商、`hello.build`、主线程心跳和外部看门狗（`heartbeat`）、命令回执（`ack`）、全局坐标的命中胶囊（`space`、`pose_revision`、`submitted_frame`）、拖动的抓点和速度（`drag` 加 `move`）、角色放置和缩放（`placement`、`set_placement`）、取值和数量限制（规则 21）。v10 加了 Trace 转发（`trace`、Companion `hello.trace_epoch`，C6 T1）、播放回执（`playback`）、`stop_speech.turn_generation`（C2 v2 规则 8），规则 22–24。v11 加了行为回执（`behavior_receipt`，C1 v2 §3）和规则 25。v12 加了切换角色前的释放（规则 14 改）、Companion 的回复超时改 11 s、规则 26（一次一个切换）。v13 加了角色动作数据（能力 `actions`；渲染器的 `actions`、`action_switches`、`action_played`；Companion 的 `get_actions`、`set_action_switches`、`play_action`；规则 27–30）。v13.1 改了规则 19 窗口视口那一条：角色大小只由 `scale` 决定，窗口视口执行 `set_placement` 的 `scale`（改窗口尺寸），加了启动参数 `--agentic-complex-scale`；v14 加了桌面表面（能力 `surfaces`；Companion 的 `surfaces`、`surface`；渲染器的 `track_surface`、`untrack_surface`；规则 31–33），加了启动参数 `--agentic-complex-battery-low-fps`。v14.1 改了规则 20：全屏视口跟着拖动的光标和 `set_placement` 的点换屏，Companion 按角色记上次的屏，没有菜单栏的屏不去掉状态栏厚度。v14.2 改了规则 29：同一动作再来一条 `play_action` 时接着当前进度播。v15 加了前后层次和让开（能力 `opacity`、`layering`；渲染器的 `attach`；Companion 的 `set_opacity`、`covered` 和 `surface.window.above`；规则 1、14 各加一条，规则 34–35），改了规则 2：带 host socket 启动即点穿。v16 加了光标状态（能力 `pointer`；Companion 的 `pointer`；规则 36）。2026-10-23 起 hit_capsules 按变化发送。v13.1、v14.1、v14.2 和 v15 的规则 2 是改动，其余都只加不改，消息里的 `v` 仍为 1。改这份合同要升版本号。
参与方：渲染器（`private/renderer/host` 的 `metal-avatar-host`；C3 连接由其中的 `Sources/NativeHostBridge/` 实现，下称插件）↔ `app/electron` 的 Electron 外壳（下称 Companion）。

## 传输

- Companion 建目录 `<support>/run`（0700），在 `<support>/run/avatar.sock` 上 listen。`<support>` = `~/Library/Application Support/local.agenticcomplex.companion`。启动前删掉残留的 socket 文件。路径超过 103 字节时 Companion 报错，不启动渲染器（`sun_path` 上限 104 字节）。
- Companion 启动渲染器时传 `--agentic-complex-host-socket <path>`。没有这个参数时渲染器不连接，独立运行。
- Companion 启动渲染器时传 `--agentic-complex-character <id>`（`id` 取 config 里选中的角色 id）。渲染器启动时直接加载这个角色，不淡出淡入。这个角色不在角色库里、或 pack.json 的 sha 核对失败时，渲染器打日志 `AAC_CHARACTER_LOAD_FAILED id=<id> reason=<reason>`，改为加载默认角色。
- Companion 启动渲染器时再传 `--agentic-complex-appearance <id>`（这个角色上次的外观）。渲染器读到就按这个外观加载。角色没有这个外观时，渲染器按默认外观加载，打日志 `AAC_APPEARANCE_FALLBACK want=<id> have=<id>`，并在 `hello.appearance` 报实际的外观。
- Companion 启动渲染器时再传 `--agentic-complex-viewport fullscreen` 或 `window`（v9）。没有这个参数时按 `window`（v8 的小窗口）。`fullscreen` 见规则 20。
- Companion 启动渲染器时再传 `--agentic-complex-placement <x>,<y>,<scale>`（v9，这个角色在这块屏上次的放置，见「放置」；`fullscreen` 时这块屏见规则 20，v14.1）。没有时渲染器按默认放置。
- Companion 的设置 `battery_low_fps`（默认开）关掉时，启动渲染器再传 `--agentic-complex-battery-low-fps 0`（v14）。Metal 宿主用它初始化电池上限（没这个参数时为 true），用 `--agentic-complex-render-fps` 初始化用户上限。`battery_low_fps`、`render_fps` 和 `idle_low_fps` 保存后通过 C3 `fps_tier` 实时生效，无需重启渲染器。
- `viewport`=`window` 时 Companion 改传 `--agentic-complex-scale <scale>`（v13.1，这个角色上次的 `placement.scale`，规则 19）。没有、或不在 0.5–2.0 时渲染器按 1。
- 渲染器是客户端：启动后每 0.5 s 尝试 connect 一次，10 s 内连不上就放弃，独立运行。
- Companion 同一时刻只保留一个渲染器连接：已有握手过的连接时，另一条连接发来的 `hello` 被拒绝，Companion 不回 `hello`、关掉这条连接，原连接照常；原连接关闭之后新连接才能握手（渲染器重启时旧进程的连接先关闭）。
- 帧格式：NDJSON。每行一个 UTF-8 JSON 对象，以 `\n` 结尾，行内不含换行。单行（含 `\n`）最多 65536 字节；收到超长行的一方关闭连接。
- 每条消息都有 `"v": 1` 和 `"type"`。接收方忽略未知的 `type` 和未知字段；`validate.py` 对未定义的 `type` 报错，用来抓拼写错误。
- 连接建立后双方第一条消息都是 `hello`。收到对方 `hello` 之前的其他消息丢弃。
- 本机受监督启动可加 `--agentic-complex-startup-status <每次启动唯一的绝对路径>`（同时带 `--agentic-complex-parent-pid`）。这是私有状态文件，不是 C3 消息：JSON `schema=endfield-startup/v1`、`pid`、`character`、`stage`（`loading_character` / `loading_animations` / `preparing_graphics` / `ready` / `failed`）。Companion 校验本次子进程 pid、角色和路径，解析中的半条记录忽略后重试；不会据此伪造百分比。
- Metal 宿主启动失败的退出码：角色包、包引用校验或 schema 解码失败以退出码 78（配置错误）结束；没有可用 Metal 设备以 69（服务不可用）结束；其他启动错误仍为 1。
- 受监督启动的 `hello` 等实际加载角色报告、且首个渲染帧提交后再发；此时之前不启用握手后的主线程心跳看门狗。Companion 独立于渲染器主线程显示加载动画，最多等待 180 s；过期终止本次子进程并显示重试，不自动反复启动。首次角色加载的预算也是 180 s，运行中切换仍为 8 s（插件回退 9 s）。没有启动状态参数的启动（例如探针）保留 3 s 的 hello 回退；普通 HostLink 握手仍等 5 s，受监督启动显式等 185 s（子进程监督的 180 s 先到）。状态 `ready` 只在首个帧提交时写入；Companion 收到握手后才收起动画。

- 关闭：渲染器读到 EOF 视为 Companion 已退出，按 `quit` 处理。Companion 读到 EOF 视为渲染器断开，由子进程监督决定是否重启。

## 启动（v25）

本节以 `app/electron/src/main/renderer/supervisor.ts` 的 `rendererArguments()` 实际拼的命令行为准；上面「传输」里各参数的含义不变，两处不一致时以本节为准。

可执行文件：config 有 `avatar_executable` 时用它，否则 `<avatar_app>/Contents/MacOS/<Info.plist 的 CFBundleExecutable>`。参数按下表顺序传，全部是「名字 值」两段（`--describe` 除外）。

| 参数 | 取值 | 何时传 | 渲染器怎么用 |
|---|---|---|---|
| `--agentic-complex-window-level` | `status` | 总传 | 窗口层级 25，在菜单栏之上 |
| `--agentic-complex-parent-pid` | Companion 的 pid | 总传 | 父进程退出就退出（规则 8）；`--agentic-complex-startup-status` 要求同时有它 |
| `--agentic-complex-agentd` | `<agentd 状态目录>/events-runtime.json` | 总传 | agent 桥配置；启动时这个文件可以还不存在 |
| `--agentic-complex-character` | 角色 id | 总传 | 启动角色；不能加载时回退默认角色（见「传输」） |
| `--agentic-complex-startup-status` | `<support>/run/startup-<UUID>.json`，每次启动新的 | 总传 | 见下文「startup-status 文件」；不是绝对路径、文件已存在或缺 `--agentic-complex-parent-pid` 时以退出码 1 结束 |
| `--agentic-complex-appearance` | 外观 id | 这个角色记有上次外观时 | 启动外观；没有这个外观时回退（见「传输」） |
| `--agentic-complex-hidden-layers` | `<id>,<id>…`（分层 id，逗号分隔） | 这个角色记有隐藏的层时 | 启动时隐藏的层（v27，规则 46）；未知的 id 丢弃，打日志 `AAC_LAYERS_FALLBACK want=<…> have=<…>` |
| `--agentic-complex-mod-settings` | JSON 对象 `{外观 id: {开关 id: 整数}}`，同 `set_character.mod_settings` | 这个角色记有 mod 设置时 | 启动时各外观的开关取值（v27，规则 53）；整段不是合规 JSON 时全部丢弃，未知的外观、开关或取值逐项丢弃，打日志 `AAC_MOD_SETTINGS_DROPPED` |
| `--agentic-complex-viewport` | `window` / `fullscreen` | 总传 | 规则 19、20 |
| `--agentic-complex-placement` | `x,y,scale`（`%.1f,%.1f,%.3f`） | `fullscreen` 且这个角色在启动屏上记有放置时 | 规则 19、20 |
| `--agentic-complex-scale` | `%.3f`，0.5–2.0 | 这个角色记有窗口 `scale` 时；`fullscreen` 也传（宿主没有全屏视口时退回窗口视口） | 窗口视口的大小（规则 19） |
| `--agentic-complex-battery-low-fps` | `0` | 设置 `battery_low_fps` 关掉时 | 电池上限初值；不传时为开 |
| `--agentic-complex-ssaa` | `2` / `1` | 总传 | 渲染设置，以下 19 项都来自 Companion 设置 `render_*`（`AvatarRenderOptions.arguments`） |
| `--agentic-complex-display-resolution` | `true` / `false` | 总传 | 同上 |
| `--agentic-complex-shadow-resolution` | `1024` / `512` / `256` | 总传 | 同上 |
| `--agentic-complex-render-fps` | `60` / `45` / `30` | 总传 | 用户帧率上限初值，之后由 `fps_tier` 更新 |
| `--agentic-complex-outline` | `original` / `subtle` / `contrast` | 总传 | 同上 |
| `--agentic-complex-light-yaw` | `-15` / `0` / `15` | 总传 | 同上 |
| `--agentic-complex-light-pitch` | `-10` / `0` / `10` | 总传 | 同上 |
| `--agentic-complex-light-strength` | `0.5` / `0.75` / `1` / `1.25` / `1.5` | 总传 | 同上 |
| `--agentic-complex-camera-mode` | `show` / `overview` / `document` | 总传 | 同上 |
| `--agentic-complex-camera-yaw` | 数（度），`-180`…`180`，取到 0.5°（v27 规则 49 起不再只限 `-90` / `-45` / `0` / `45` / `90` / `180`） | 总传 | 同上 |
| `--agentic-complex-camera-pitch` | 数（度），`-20`…`20`，取到 0.5° | 总传 | 同上 |
| `--agentic-complex-facing-mode` | `auto` / `front` / `side` / `back` | 总传 | 同上 |
| `--agentic-complex-ground-shadow` | `off` / `contact` | 总传 | 脚下的接触阴影（v27）；不传时为 `off` |
| `--agentic-complex-ambient` | `off` / `wallpaper` / `screen` | 总传 | 环境融合的颜色来源（v27，规则 44）；不传时为 `off` |
| `--agentic-complex-light-wrap` | `0` / `1` | 总传 | 边缘光（light wrap：轮廓内侧一窄带背景色，v27）；不传时为 `0` |
| `--agentic-complex-camera-zoom` | 数，`1`…`4` | 总传 | 绕头部放大她的画面，相机不动（v27，规则 49）；不传时为 `1` |
| `--agentic-complex-camera-sway` | `0` / `1` | 总传 | 脚在可见区外时轻微晃动（v27，规则 49）；不传时为 `0` |
| `--agentic-complex-camera-track` | `off` / `stage` | 总传 | 带相机轨的动作怎么播（v27，规则 49）；不传时为 `off` |
| `--agentic-complex-camera-framing` | `full` / `bust` | 只在 `bust` 时传 | 半身固定（v27，规则 49 (i)）；不传时为 `full` |
| `--agentic-complex-secondary-motion` | `1` / `0` | 总传 | 头发衣物物理（设置 `render_secondary_motion`，v27）：`1` 加载角色包的 `interaction/bone-physics.json`，连续重置，全屏视口下接收桌面平移和朝向；`0`、其他值或不传时不加载（预览、快照、独立运行都不跑物理）；环境变量 `AAC_BONE_PHYSICS_DISABLED=1` 优先 |
| `--agentic-complex-speech-expressions` | `on` / `off` | 总传 | 说话时按 C1 意图换表情（v27，角色包的 `interaction/speech-expressions.json`）；不传时为 `off`；缺值或其他值时加载角色出错（启动时以退出码 1 结束） |
| `--agentic-complex-filter` | `none` / `filter_1`…`filter_8` / `sp_filter_1`…`sp_filter_7` | 总传 | 滤镜（设置 `render_filter`，v27，规则 43）；不传时为 `none`；不认识的值按 `none`，打日志 `AAC_FILTER_FALLBACK want=<值>` |
| `--agentic-complex-capture-dir` | 绝对路径（截图目录） | 总传 | 截图只写进这个目录（v27，规则 50）；不传时不列能力 `capture`、不截图 |
| `--agentic-complex-looks` | 绝对路径（滤镜资源目录，含 `looks.json`） | Companion 不传（开发时覆盖用） | 滤镜资源从这里读（v27）；不传时读渲染器 bundle 的 `Resources/looks/photomode-v1/`；找不到或校验失败时不列能力 `filters`，角色照常启动 |
| `--agentic-complex-dof` | `off` / `closeup` | 总传 | 景深开关（设置 `render_dof`，v27，规则 43）：`closeup` 时镜头处于近景时自动虚化；不传或其他值时为 `off` |
| `--agentic-complex-scene-pack` | 绝对路径（指向 `scene.json`） | `scene_mode` 不是 `off`、视口是 `fullscreen`、找得到场景包时 | 场景包见 private/renderer/scene-pack（v27） |
| `--agentic-complex-scene-pack-sha256` | 64 位小写十六进制 | 同上 | `scene.json` 的 SHA-256（v27） |
| `--agentic-complex-scene-parallax` | `0` | `scene_parallax` 为 false 时 | 场景视差（v27）；缺省为开 |
| `--agentic-complex-scene-stage` | 展示台 id，`^[a-z0-9][a-z0-9-]{0,47}$`；现在只有 `charinfo` | `scene_mode` 为 `stage`、视口是 `fullscreen` 时 | 和 `--agentic-complex-scene-pack` 互斥；渲染器在角色包里找这个展示台（v27） |
| 角色的 `avatar_args` | config 原样；角色目录里的角色是 `--character-catalog <catalog 路径>` | 有就传 | 资源来源 |
| `--agentic-complex-host-socket` | `<support>/run/avatar.sock` | Companion 有 HostLink 时（正常运行都有），放在最后 | 连 C3 socket；带它且没有 `--frames` 时宿主常驻 |

「总传」的参数缺了渲染器也能启动（独立运行、取默认值），只是 Companion 自己从不省略。

渲染器拒收场景包时照常启动角色，只记日志；有场景包时，全屏视口下渲染器窗口取盒子矩形、不随她移动，规则 20 的视口语义（内容区和放置坐标）不变。

`--agentic-complex-scene-stage`：找不到展示台、窗口视口、帧图有时间历史时照常启动角色，只记日志；有展示台时窗口取盒子矩形、不随她移动，她固定在盒子的地面中点，不走动；规则 20 的视口语义不变。

### 退出码

| 码 | 渲染器何时发出 | Companion 怎么处理 |
|---|---|---|
| 0 | 正常结束：`quit`、socket EOF、父进程退出、`--frames` 跑完、快照写完、`--describe`、`--validate-pack` 通过 | Companion 自己停的（退出、重启、切换）不处理；否则同 1 |
| 1 | 其他启动错误（参数不合、startup-status 路径不合规、建窗口失败等）和未归类的错误 | 当作崩溃：按退避重启，等 1、2、4、8、16 s，第 6 次起 30 s（运行满 60 s 后重新从 1 s 起）；300 s 内崩溃 5 次后不再重启，停在失败「300 秒内崩溃 5 次」 |
| 69 | 没有可用 Metal 设备（`HostStartupFailure.metalUnavailable`） | 不重启，删掉 startup-status 文件，状态失败「无法使用 GPU」 |
| 78 | 角色包、包引用校验或 schema 解码失败（`HostStartupFailure.pack`、`DecodingError`、`ActorRuntimeError`），默认角色也加载不了 | 不重启，删掉 startup-status 文件，状态失败「角色包与程序版本不符」 |
| 信号 | 崩溃，或 Companion 在 180 s 启动期限到时发 SIGKILL | 崩溃同 1；期限到时 Companion 先删文件、显示「角色准备超时，请重新启动」，不再自动重启 |

### startup-status 文件

- 渲染器以原子替换（写临时文件再改名）写一个 JSON 对象，键排序：`{"character":<实际加载的角色>,"pid":<渲染器 pid>,"schema":"endfield-startup/v1","stage":<阶段>}`。`character` 是回退后的实际角色。
- 阶段依次为 `loading_character`（参数解析完）→ `preparing_graphics` → `loading_animations` → `ready`（第一个命令缓冲提交后）；任何启动错误先写 `failed` 再按上表退出。
- Companion 每 0.2 s 读一次：文件超过 4096 字节、解析失败、`schema` 或 `pid` 不对的都忽略后再读。`failed` 时显示「角色加载失败」；`ready` 且 C3 已握手、`hello` 的角色与文件里的相同（没有 HostLink 时只看 `ready`）时收起加载动画并删掉文件。

### `--describe`

- 渲染器只要在参数里见到 `--describe`，就在做任何别的事之前（包括进入预览服务模式）向 stdout 写一行 JSON、以 0 退出；不建窗口、不连 socket、不写 startup-status、不碰 GPU，其他参数都忽略。宿主可以在启动前用它问版本。
- 格式（一行，键排序，以 `\n` 结尾）：`{"c3_contract":"v27","c3_protocol":1,"component":"renderer","version":"0.0.1"}`。
  - `component`：固定 `renderer`。
  - `version`：主 bundle Info.plist 的 `CFBundleShortVersionString`，没有就用 `CFBundleVersion`，都没有（`swift build` 出的裸可执行文件）写 `unknown`。
  - `c3_protocol`：C3 消息的 `v`，即 `hello.protocol`，现为 1。
  - `c3_contract`：渲染器实现的本合同版本，与上面状态行的版本相同。

## 坐标

| 名称 | 单位与原点 | 用在 |
|---|---|---|
| 全局点 | AppKit 屏幕坐标，单位 point，原点在主屏（`NSScreen.screens[0]`）左下角，y 向上 | `window_frame.frame`、`move_window`；v14 的窗口项 `frame`、`segments`；v15 的 `surface.window.above`、`covered.frame` |
| 窗口点 | 单位 point，原点在角色窗口内容区左下角，y 向上。等于窗口内容区的像素坐标除以 `window_frame.scale` | `hit_capsules`（`space`=`window`）、`cursor`、`point_at`、`click` |

Companion 用最近一次 `window_frame` 把全局光标位置换成窗口点。v9 起 `hit_capsules`（`space`=`global`）、`drag`、`placement`、`set_placement` 用全局点。v14 的 `surfaces`、`surface` 也用这同一种全局点，和 `placement` 可以直接比较。

## 放置（v9）

- 锚点：rigRoot 原点沿 rig profile 的 `frame.up` 投到 `frame.ground` 的那一点，全局点（站立时约为脚底中点，走路时不随脚抖）。角色在桌面上的位置就是锚点的位置。
- `scale` 是角色放置的缩放；命中胶囊用提交帧的放置。
- `scale`：角色大小，1 = 默认大小（render 输出 1080×1560 像素、在 2 倍屏上占 540×780 pt 的那个大小）。取值 0.5–2.0。
- `display_id`：锚点所在屏的 `CGDirectDisplayID`（正整数）。

## 能力（v9）

- 双方的 `hello` 必带 `capabilities`：字符串数组，最多 64 项（v27 起 64，之前 32），不重复。
- 一方只在对方列出某项能力时才用对应的行为。

| 能力 | 谁列 | 列了表示 |
|---|---|---|
| `heartbeat` | 渲染器 | 发 `heartbeat`（规则 17） |
| `render_progress` | 渲染器 | `heartbeat` 带 `frames`、`render`；`stats` 带 `gpu_errors`、`drawable_misses`（规则 17） |
| `ack` | 渲染器 | 对带 `req` 的命令回 `ack`（规则 18） |
| `drag_motion` | 渲染器 | `drag` 带位置、抓点、速度，并发 `move`（规则 3） |
| `placement` | 渲染器 | 发 `placement`，处理 `set_placement` 和 `--agentic-complex-placement`（规则 19） |
| `viewport_fullscreen` | 渲染器 | 支持 `--agentic-complex-viewport fullscreen`（规则 20） |
| `capsules_global` | Companion | 收得懂 `space`=`global` 的 `hit_capsules`；渲染器只在 Companion 列了它时才发 `global` |
| `watchdog` | Companion | 按规则 17 看心跳 |
| `trace` | 渲染器 | 发 `trace`（v10，规则 22） |
| `trace` | Companion | 收 `trace` 并转给 agentd；`hello` 带 `trace_epoch`（v10，规则 22） |
| `playback` | 渲染器 | 发 `playback`（v10，规则 23） |
| `turn_generation` | 渲染器 | 按 `stop_speech.turn_generation` 打断并丢旧代际的语音（v10，规则 24） |
| `behavior_receipt` | 渲染器 | 发 `behavior_receipt`（v11，规则 25）；只在 Companion 也列了它时发 |
| `behavior_receipt` | Companion | 收 `behavior_receipt` 并转给 agentd（v11，规则 25） |
| `actions` | 渲染器 | 发 `actions`、`action_switches`、`action_played`，处理 `get_actions`、`set_action_switches`、`play_action`（v13，规则 27–30） |
| `actions` | Companion | 收得懂上面三条渲染器消息（v13） |
| `surfaces` | Companion | 发 `surfaces`、`surface`，处理 `track_surface`、`untrack_surface`（v14，规则 31–33） |
| `surfaces` | 渲染器 | 收得懂 `surfaces`、`surface`，会发 `track_surface`、`untrack_surface`（v14） |
| `opacity` | 渲染器 | 处理 `set_opacity`、`covered`（v15，规则 35） |
| `opacity` | Companion | 发 `set_opacity`、`covered`（v15，规则 35） |
| `layering` | 渲染器 | 发 `attach`，收得懂 `surface.window.above`（v15，规则 34） |
| `layering` | Companion | 处理 `attach`，在 attach 的那个跟踪的 `surface` 里带 `above`（v15，规则 34） |
| `pointer` | 渲染器 | 收 `pointer`（v16，规则 36） |
| `pointer` | Companion | 发 `pointer`（v16，规则 36） |
| `pipeline` | 渲染器 | 发 `pipeline`（v17，规则 37） |
| `drop` | 渲染器 | 收拖入，发 `drop`（v21，规则 38）；只在 Companion 也列了它时收、发 |
| `drop` | Companion | 收 `drop`（v21，规则 38） |
| `motion_requests` | 渲染器 | 发 `motion_request`（v23，规则 40）；只在 Companion 也列了它时发 |
| `motion_requests` | Companion | 收 `motion_request` 并转给 agentd（v23，规则 40） |
| `pass_through` | 渲染器 | 处理 `pass_through`：自己的指针判定不在那些矩形里开始接点击（v24，规则 41） |
| `pass_through` | Companion | 发 `pass_through`（v24，规则 41） |
| `keep_clear` | 渲染器 | 处理 `keep_clear`：让她走开，不挡那些矩形（v26，规则 42） |
| `keep_clear` | Companion | 发 `keep_clear`（v26，规则 42） |
| `render_live` | 渲染器 | 处理 `set_render`（v27，规则 43） |
| `render_live` | Companion | 发 `set_render`（v27，规则 43） |
| `ambient` | 渲染器 | 收 `ambient_sample`（v27，规则 44） |
| `ambient` | Companion | 发 `ambient_sample`（v27，规则 44） |
| `touch` | 渲染器 | 收 `touch_settings`；`click` 可带 `region`（v27，规则 45） |
| `touch` | Companion | 发 `touch_settings` |
| `motion_media` | 渲染器 | `actions[]` 的项可带 `media`；带 BGM 的动作也接受 `speed` 0.5、2，音乐同步变速（v27，规则 29） |
| `action_loop` | 渲染器 | 处理 `play_action.loop`、`stop_action`（v27，规则 29） |
| `action_loop` | Companion | 会发 `play_action.loop`、`stop_action`（v27，规则 29） |
| `layers` | 渲染器 | 处理 `set_layers`、`set_character.hidden_layers`，发 `layers_changed`、`layers_change_failed`（v27，规则 46） |
| `layers` | Companion | 会发 `set_layers`，收得懂上面两条渲染器消息（v27，规则 46） |
| `poses` | 渲染器 | `actions[].pose`；处理 `set_pose`；发 `pose_state`（v27，规则 47） |
| `poses` | Companion | 发 `set_pose`（v27，规则 47） |
| `camera_free` | 渲染器 | 处理 `set_render.camera` 的 `zoom`、`sway`、`closeup`、`live`，`camera.yaw` 接受 −180…180（v27，规则 49）；只在全屏视口、有 actor 时列 |
| `camera_free` | Companion | 会发上面这些字段（v27，规则 49） |
| `camera_track` | 渲染器 | 处理 `set_render.camera.track`，带相机轨的动作在舞台框里播（v27，规则 49）；只在全屏视口、有 actor 时列 |
| `camera_track` | Companion | 会发 `track`（v27，规则 49） |
| `camera_gesture` | 渲染器 | 她身上的 ⌘ 拖动、⌘ 滚轮、捏合和展示台里的拖动发 `camera_gesture`，不发 `drag`（v27，规则 49 (h)）；和 `camera_free` 同时列 |
| `camera_gesture` | Companion | 收得懂 `camera_gesture`，换算成镜头值发 `set_render.camera`（v27，规则 49 (h)） |
| `camera_bust` | 两边 | 渲染器收得懂 `set_render.camera.framing`，Companion 会发；渲染器和 `camera_free` 一起列（v27，规则 49 (i)） |
| `filters` | 渲染器 | 处理 `set_render.filter`，`pipeline.render` 带 `filter`（v27，规则 43）；只在找到并校验过滤镜资源、有 actor 时列 |
| `filters` | Companion | 会发 `set_render.filter`（v27，规则 43） |
| `capture` | 渲染器 | 处理 `capture`，发 `captured`（v27，规则 50）；只在有 `--agentic-complex-capture-dir`、有 actor 时列 |
| `capture` | Companion | 会发 `capture`，收得懂 `captured`（v27，规则 50） |
| `photo` | 渲染器 | 处理景深开关 `set_render.dof`（`{mode}`，对应设置 `render_dof`：`off` / `closeup`）和拍照面板 `set_render.photo`（`{active, aperture, focus}`），`pipeline.render` 带 `dof{mode}`、`photo{active}`（v27，规则 43）；有 actor 时列 |
| `photo` | Companion | 会发 `set_render.dof`、`set_render.photo`（v27，规则 43） |
| `motion_overrides` | 渲染器 | 处理 `set_motion_overrides`，回 `ack`，发 `motion_overrides`（v27，规则 51）；和 `actions`、`ack` 同时列 |
| `motion_overrides` | Companion | 会发 `set_motion_overrides`，收得懂 `motion_overrides`（v27，规则 51） |
| `play_chain` | 渲染器 | 处理 `play_chain`，回 `ack`，用带 `chain` 的 `action_played` 回执（v27，规则 52）；和 `actions`、`ack` 同时列 |
| `play_chain` | Companion | 会发 `play_chain`，收得懂 `action_played.chain`（v27，规则 52） |
| `mod_settings` | 渲染器 | 处理 `set_mod_settings`、`set_character.mod_settings` 和 `--agentic-complex-mod-settings`，回 `ack`，发 `mod_settings`（v27，规则 53）；有 actor 时列，和 `ack` 同时列 |
| `mod_settings` | Companion | 会发 `set_mod_settings`、`set_character.mod_settings`，收得懂 `mod_settings`（v27，规则 53） |
| `reactions` | Companion | 收 `reaction` 并转给 agentd（v27，规则 55）；渲染器不列这一项 |

- `actions`（v13）两边都列了才用；只有一边列时，角色卡显示「这个版本的角色不支持动作设置」，渲染器用 actions.json 的默认（全开）。
- `surfaces`（v14）两边都列了才用。只有一边列时，Companion 不发表面消息；渲染器没有窗口几何，要窗口的行为一律回执 `blocked` / `target_gone`（C1 v2 §3，agentd 换类型），随机挑选时不挑要窗口的。
- `opacity`（v15）两边都列了才发 `set_opacity`、`covered`。没用上时 Companion 照样按规则 35 判盖住，只是不发这两条；盖住状态不扣除可见角色的命中。
- `layering`（v15）两边都列了、而且两边都列了 `surfaces` 才用。
- `pointer`（v16）两边都列了才发。
- `drop`（v21）两边都列了才用；否则渲染器不收拖入。
- `motion_requests`（v23）两边都列了才用；否则渲染器不发请求，直接用角色包动作片段。
- `pass_through`（v24）两边都列了才发；没用上时 Companion 照样按规则 41 判 `cursor.hit`。
- `keep_clear`（v26）两边都列了才发；没用上时她不为这些矩形走开。
- `render_live`、`ambient`（v27）两边都列了才发。渲染器只在有 actor 时列这两项。`camera_free`、`camera_track`（v27，规则 49）两边都列了才发对应字段；渲染器只在全屏视口、有 actor 时列这两项。`camera_gesture`（v27，规则 49 (h)）两边都列了才发；否则 ⌘ 拖动照旧搬动她，滚轮、捏合不处理。`filters`、`capture`、`photo`（v27）两边都列了才发对应的 `set_render.filter`、`capture`、`set_render.dof` / `set_render.photo`；没用上时滤镜为 `none`、不截图、景深关。
- `action_loop`（v27）两边都列了才用；否则 Companion 不带 `loop`、不发 `stop_action`。`motion_media`（v27）只由渲染器列；没列时 Companion 和网页照旧把带 BGM 的动作锁在 1×。
- `motion_overrides`、`play_chain`（v27）两边都列了才发 `set_motion_overrides`、`play_chain`；否则渲染器照角色包的链、池子和混合时长播，Companion 存下的覆盖不生效。
- `mod_settings`（v27）两边都列了才发 `set_mod_settings`、带 `mod_settings` 的 `set_character` 和 `mod_settings`；否则渲染器按开关表的默认值画。
- `reactions`（v27）只由 Companion 列：Companion 的 `hello` 列了它，渲染器才发 `reaction`。

- `hello.build`（v9，双方都发）：对象，必有 `git`（非空字符串，构建所用源码的提交号，取不到写 `unknown`）；可选 `version`（非空字符串）、`plugin`（非空字符串；渲染器不发，校验器仍接受）；v17 可选 `renderer`（渲染宿主的种类，渲染器发 `"metal"`）。只用于日志和诊断，不据此改行为。

## 外观列表

外观列表由渲染器报，Companion 不在 config 里写。

- `appearances`：数组，每项 `{id, name}`。`id` 是外观代号（非空字符串，例如 `default`、`toppotential`）。`name` 是菜单里显示的名字（非空字符串，来自 pack.json 顶层 `appearances`）。至少一项，第一项是默认外观。
- `appearance`：当前外观的 `id`，必须在 `appearances` 里。
- 两个字段一起出现或一起缺省。缺省表示这个角色只有一种外观。
- v27：`appearances` 的条目可以带可选的 `kind`（`"original"` / `"imported"`，缺省按 `original`）和 `desc`（字符串，≤ 200 字节，菜单和角色页里的说明）。渲染器照 pack.json 转。

## 分层列表（v27）

分层列表由渲染器报，来自 pack.json 顶层 `layers`；Companion 只按角色记隐藏的层。

- `layers`：数组，最多 16 项，每项 `{id, name, appearances?}`。`id` 符合 `^[a-z][a-z0-9_]{0,31}$`，同一角色内唯一；`name` 是菜单里显示的名字（1–64 字节的字符串）；`appearances` 可选，是非空的外观 `id` 数组，表示这层只在这些外观里起作用，缺省表示全部外观。
- `hidden_layers`：数组，当前隐藏的层的 `id`，必须都在 `layers` 里，不重复。空数组表示全部显示。
- 两个字段一起出现或一起缺省。缺省表示这个角色没有分层。

## 桌面表面（v14）

窗口项的 `frame` 和 `segments` 都是「坐标」一节的全局点（AppKit，point，主屏左下角为原点，y 向上），和 `placement` 同一种。

一个窗口项 `window`：

| 键 | 内容 |
|---|---|
| `window_id` | 系统窗口号（`kCGWindowNumber`，正整数），和 C1 `target.window_id` 同一个号 |
| `generation` | 正整数。Companion 第一次见到这个 `window_id` 时取 1；这个号从列表里消失再出现时 +1。目标标识是 (`window_id`, `generation`)，只在这一条连接里有效，断开重连后从 1 重新算 |
| `display_id` | 窗口中心所在屏的 `CGDirectDisplayID`（正整数），同 `placement.display_id` |
| `frame` | `{x, y, w, h}`，全局点，`w`、`h` > 0 |
| `order` | 整数 ≥ 0，前后次序，0 在最前 |
| `edges[]` | 见下；没有可接触的边时为空数组 |

`edges[]` 每项是一条可接触边：

| 键 | 内容 |
|---|---|
| `side` | `"top"` / `"left"` / `"right"` |
| `segments` | `[[a, b], …]`：这条边上没被更前面的窗口、菜单栏、Dock 盖住的段，全局点；`top` 是 x 区间（y = `frame.y + frame.h`），`left`、`right` 是 y 区间（x = `frame.x`、`frame.x + frame.w`）。每段长 ≥ 40 pt，最多 8 段，从小到大 |

- 正面法线由 `side` 定：`top` 朝上 (0, 1)，`left` 朝左 (−1, 0)，`right` 朝右 (1, 0)。撤离方向同法线。
- 预备位、占用归渲染器：预备位按角色大小从 `segments` 和法线算；这个角色有没有占着一条边只有渲染器知道。
- 失效：窗口消失（`surface` 的 `state`=`gone`），或 `frame`、`segments` 变了（渲染器按新值重算，正在扶、坐的按 interaction 的规则决定跟着动还是撤离）。

## 消息：渲染器 → Companion

| type | 字段 | 何时发 |
|---|---|---|
| `hello` | `role`=`"avatar"`、`pid`（正整数）、`protocol`=1；可选 `character`（实际加载的角色 id，非空字符串）；可选 `appearance`、`appearances`（见「外观列表」）；`capabilities`（必有）、v9 可选 `build`（见「能力」）；v27 可选 `layers`、`hidden_layers`（见「分层列表」，规则 46） | 连接后第一条 |
| `window_frame` | `frame{x,y,w,h}`（全局点，`w`、`h` > 0）、`scale`（backingScaleFactor，> 0）、`window_number`（正整数）；v9 可选 `viewport`：`"window"` / `"fullscreen"`、`display_id`（正整数） | `hello` 之后立刻一次；之后窗口移动、缩放、换屏时各一次 |
| `hit_capsules` | `frame`（渲染器帧号，整数 ≥ 0）、`capsules[]`：`{a:[x,y], b:[x,y], r}`，`r` > 0，最多 64 个；空数组表示这一帧没有可点区域。v9 可选 `space`：`"window"`（缺省，窗口点）/ `"global"`（全局点）；可选 `pose_revision`（整数 ≥ 0，算胶囊用的那份姿态的序号，每写一次新姿态 +1）、`submitted_frame`（整数 ≥ 0，用这份姿态和相机提交渲染的渲染器帧号）；v22 可选 `visual`：`[x, y, w, h]`，同一提交帧所有可见网格的外接矩形，全局点、原点左下，`w`、`h` > 0，只随 `space`=`global` 发；算不出时（窗口视口、隐藏、切换角色）不带 | 胶囊或窗口位置变化时发，最多 30 Hz；不变时每 100 ms 发一次保活；隐藏、切换角色引起的清空最多晚 100 ms；v9 在姿态和相机冻结之后算 |
| `drag` | `phase`：`"begin"` / `"end"`；v9（`drag_motion`）加 `"move"`，三种都带 `x`、`y`（光标，全局点）、`grab{x,y}`（抓点相对锚点的偏移，point）、`vx`、`vy`（光标速度，pt/s，取最近 50 ms） | 开始拖时发 `begin`，拖动中每帧最多一条 `move`（≤ 60 条/s），鼠标抬起时发 `end`（规则 3） |
| `speech_cancelled` | `speech_id`（非空字符串）、`reason`：`"client_cancel"` / `"playback_failed"` | 渲染器本地停掉一段语音后（C2 规则 4：先停播放、清 cue、嘴归中性，再发） |
| `click` | `button`：`"left"` / `"right"`、`count`：1 / 2（`right` 只有 1）、`x`、`y`（按下处的窗口点）；v27 可选 `region`（1–32 字节，`[a-z_]`，取值见规则 45）：只在本连接收到过 `regions`=true 的 `touch_settings`、而且按下处有区域时带；只用于 `left`、`count`=1 | 在命中胶囊上完成一次单击、双击或右键时（规则 10） |
| `stats` | `fps`（上一秒提交的帧数，≥ 0）、`frame_ms_p95`（上一秒帧间隔的 P95，毫秒，> 0；`fps` 为 0 时为 `null`）、`gpu_ms`（上一秒 GPU 帧时间中位数，毫秒，> 0；取不到时为 `null`）；v20，具有 `render_progress` 时加 `gpu_errors`、`drawable_misses`（整数 ≥ 0，自本连接的 `hello` 起累计） | `hello` 之后每秒一次（规则 11） |
| `character_changed` | `id`（非空字符串）、`ms`（整数 ≥ 0，从开始释放到淡入结束的耗时；已经是这个角色时为 0）；可选 `appearance`、`appearances`（新角色的，见「外观列表」）；v27 可选 `layers`、`hidden_layers`（新角色的，见「分层列表」，规则 46） | 切换成功、淡入结束后（规则 14） |
| `character_change_failed` | `id`（非空字符串）、`reason`：`"switching"` / `"unknown_character"` / `"pack_rejected"` / `"load_failed"` | 切换失败、淡入结束后；切换中收到的请求立刻发（规则 14） |
| `appearance_changed` | `id`（非空字符串） | 切换外观成功后（规则 16） |
| `appearance_change_failed` | `id`（非空字符串）、`reason`：`"superseded"` / `"switching"` / `"unknown_appearance"` / `"load_failed"` | 切换外观失败后，或请求被顶掉时（规则 16） |
| `layers_changed` | `hidden`（数组，现在实际隐藏的层的 `id`，同 `hidden_layers`） | v27（`layers`）。`set_layers` 生效后（规则 46） |
| `layers_change_failed` | `hidden`（同请求）、`reason`：`"superseded"` / `"switching"` / `"unknown_layer"` / `"load_failed"` | v27（`layers`）。`set_layers` 失败后，或请求被顶掉时（规则 46） |
| `heartbeat` | `seq`（整数 ≥ 0，每条 +1）、`click_through`（布尔，发送时窗口的 `ignoresMouseEvents`）；v20，具有 `render_progress` 时加 `frames`（整数 ≥ 0，自本连接的 `hello` 起 GPU 已完成帧数，不递减）、`render`（`active`：渲染器此刻打算绘帧；`idle`：`paused` 档、`set_visible` 隐藏、系统挂起、锁屏或屏幕休眠、窗口被完全遮挡（`occlusionState` 不含 visible）、角色或外观加载或切换期间） | v9。`hello` 之后由渲染器主线程每 100 ms 一条，和帧率档位、隐藏、切换角色无关（规则 17） |
| `ack` | `req`（正整数，对应命令的 `req`）、`ok`（布尔）；`ok` 为 false 时 `error`：`"invalid"` / `"busy"` / `"unsupported"` / `"failed"` | v9。收到带 `req` 的命令后一条（规则 18） |
| `placement` | `x`、`y`（锚点，全局点）、`scale`（0.5–2.0）、`display_id`（正整数）、`reason`：`"start"` / `"drag"` / `"behavior"` / `"set_placement"` | v9。启动后第一帧一次；锚点或缩放停止变化 150 ms 后一次；执行完 `set_placement` 后一次。不逐帧发（规则 19） |
| `trace` | `events[]`：1–50 个 C6 §4.1 T1 事件对象，每个 `producer`=`"avatar"`、`producer_epoch`=Companion 这次 `hello` 的 `trace_epoch` | v10（`trace`）。有事件就发，同一帧的事件合成一条；每秒最多 20 条（规则 22） |
| `playback` | `speech_id`（非空字符串）、`clause_id`（字符串或 `null`）、`state`：`"started"` / `"buffering"` / `"resumed"` / `"ended"` / `"interrupted"` / `"failed"` / `"degraded"`、`sample`（整数 ≥ 0，到这一刻已播出的采样数）、`rate`（整数 > 0，采样率）；`interrupted`、`failed`、`degraded` 必带 `reason`（非空字符串）；可选 `utterance_id`（非空字符串）、`spoken_text_revision`（整数 ≥ 0），C2 v2 `begin` 带了就照抄 | v10（`playback`）。每段语音每次状态变化一条（规则 23） |
| `behavior_receipt` | `behavior_id`（非空字符串，≤ 64 字节，来自 C1 `event: behavior`）；`phase`：`"prepared"` / `"rejected"` / `"running"` / `"completed"` / `"blocked"` / `"cancelled"` / `"expired"`；`reason`（字符串或 `null`；`rejected`、`blocked` 必须非空，取值见 C1 v2 §3）；`at_ms`（整数 ≥ 0，墙钟毫秒）；`turn_generation`（整数 ≥ 0，这个行为的 `turn_generation`） | v11（`behavior_receipt`）。每个行为每次阶段变化一条（规则 25） |
| `motion_state` | `behavior_id`（来自 C1 `event: behavior` 的非空字符串，≤ 64 字节；本地反应为 `null`）；`origin`：`"agent"`（C1 `perform`）/ `"local"`（渲染器按 C1 snapshot `reactions` 本地挑的反应）；`behavior_id` 为 `null` 只和 `"local"` 一起；`phase`：`"started"` / `"cycle_end"` / `"ended"` / `"expired"` / `"rejected"`；`resting`、`busy`（布尔）；`clip`（这条片段的 id，1–64 字节） | v27（C1 v2.7）。只在片段边界发（规则 54） |
| `actions` | `character`（非空字符串，这份清单所属的角色）、`actions[]`（见下）、`switches`（对象，`id → bool`，渲染器现在实际用的开关表，清单里每个 `id` 都有）；可选 `error`：`"not_ready"` / `"too_large"`（这时 `actions` 为空数组、`switches` 为空对象） | v13（`actions`）。握手后清单第一次就绪时；`character_changed` 之后新角色的清单就绪时；收到 `get_actions` 时 |
| `action_switches` | `character`、`switches`（同上，应用之后实际生效的表）、`adjusted[]`：`{id, reason}`，请求里和生效结果不同的每一项，`reason`：`"required"` / `"missing"` / `"last_in_section"`；可选 `error`：`"wrong_character"` / `"switching"` / `"not_ready"`（这时没有应用，`switches` 是原来的表，`adjusted` 为空） | v13。收到 `set_action_switches` 后一条 |
| `action_played` | `play_id`（同请求）、`id`（动作）、`phase`：`"started"` / `"completed"` / `"interrupted"` / `"rejected"`；`reason`（字符串或 `null`，`rejected`、`interrupted` 必须非空，取值见规则 29）；v27 可选 `chain`（`play_chain` 的回执带，值同请求的 `start`，这时 `id` 也是 `start`，`play_chain`，规则 52） | v13。收到 `play_action` 后：开始播时 `started`，播完回到内置动作时 `completed`；被打断时 `interrupted`；不播时只回一条 `rejected` |
| `track_surface` | `track_id`（非空字符串，≤ 64 字节，每次新取）、`window_id`（正整数）；可选 `generation`（正整数） | v14（`surfaces`）。渲染器开始一个要跟着窗口的行为时（扶窗沿、坐窗口顶、爬窗口顶、走到会话窗口前）（规则 32） |
| `untrack_surface` | `track_id` | v14。这个行为结束时 |
| `attach` | `track_id`（渲染器正在跟的 `track_id`，非空字符串，≤ 64 字节）或 `null` | v15（`layering`）。扶窗沿、坐窗口顶成立时发这个行为的 `track_id`；行为结束、被拖放手时发 `null`（规则 34） |
| `pipeline` | `renderer`（非空字符串）、`bundle_sha256`（64 位小写十六进制或 `null`）、`character`、`appearance`（非空字符串）、`appearance_fallback`（`{requested, reason}` 或 `null`）、`render`（`{ssaa, shadow_resolution, outline, display_resolution, unsupported[]}`，实际生效的渲染设置；v27 可选 `camera{mode,yaw,pitch}`、`light{yaw,pitch,strength}`、`facing`、`grounding{mode}`、`ambient{mode,light_wrap}`，也是实际生效值，取值见规则 43；v27 `camera` 另有可选 `zoom`、`sway`、`closeup`、`closeup_zoom`、`track`、`stage`，见规则 49；v27 可选 `filter`（实际生效的滤镜 id，`none` 表示无，见规则 43）；v27 可选 `dof`（`{mode}`）、`photo`（`{active}`），实际生效值，见规则 43、`fps`（`{requested, target}`，整数 ≥ 0）、`suspended`（`null` / `"system_sleep"` / `"screen_sleep"` / `"session_inactive"` / `"switching"`）、`gpu`（`{allocated_mb}`，数 ≥ 0）、`frames`（`{submitted, completed}`，整数 ≥ 0）、`clip`（字符串或 `null`）、`error`（字符串或 `null`）。所有键都必有 | v17（`pipeline`）。`hello` 之后一条；除 `gpu`、`frames`、`clip` 外有字段变化时下一帧发（每秒最多 4 条）；否则每 5 s 一条（规则 37） |
| `drop` | `items[]`：1–16 项，每项 `{kind: "file", path}`（绝对路径）/ `{kind: "url", url}` / `{kind: "text", text}`（≤ 16384 字节），都是非空字符串；`x`、`y`（放下处的光标，全局点）；可选 `truncated`（布尔，有项或文字被截掉时为 true） | v21（`drop`）。拖入在她的命中胶囊上放下时一条（规则 38） |
| `motion.stroke` | `token`（同 `present`）、`clip`（片段名，非空字符串） | v22.1。`present` 那条动作链里带 `stroke_s` 的片段播过这一刻时各一条（规则 39） |
| `motion_request` | `request_id`（`"mr-"` 加 16 个小写十六进制字符，每次新取）、`behavior_id`（这个请求服务的 C1 行为，非空字符串，≤ 64 字节）、`kind`：`"turn"` / `"walk"` / `"window_loop"` / `"sit_enter"` / `"sit_loop"` / `"sit_exit"` / `"lean"`、`seconds`（数，1–10）、`geometry`（按 `kind`，见规则 40） | v23（`motion_requests`）。生成动作后端下，宿主的执行器要一段按它算好的几何生成的片段时一条（规则 40） |
| `pose_state` | `character`（字符串）、`id`（现在保持的姿态行的动作 `id`，≤ 64 字节；没有姿态、回到自动时为 `null`）、`locked`（布尔） | v27（`poses`）。姿态状态变化时一条；每次回 `set_pose` 的 `ack` 之后也一条（规则 47） |
| `captured` | `req`（正整数，同 `capture`）、`file`（文件名，非空字符串，不含目录、不含 `/`）、`width`、`height`（正整数，PNG 的像素尺寸） | v27（`capture`）。截图文件写完、回过 `ack` `ok`=true 之后一条（规则 50） |
| `camera_gesture` | `phase`：`"began"` / `"changed"` / `"ended"`、`dx`、`dy`（这一事件的光标位移，屏幕点，右、下为正，绝对值 ≤ 100000）、`zoom`（这一事件的缩放倍数，> 0，1 = 不变） | v27（`camera_gesture`）。她身上的镜头手势：开始一条 `began`，每个事件一条 `changed`，结束一条 `ended`（规则 49 (h)） |
| `motion_overrides` | `req`（正整数，同 `set_motion_overrides`）、`character`（非空字符串）、`applied`（`{chains, pools, blend_in}`，各是整数 ≥ 0，请求里实际采用的项数）、`adjusted[]`：`{kind, key, reason}`，请求里没采用的每一项，`kind`：`"chain"` / `"pool"` / `"blend_in"`，`key` 是那一项的键（链 key、池 key 或 clip 名），`reason` 取值见规则 51；可选 `truncated`（布尔，只在 `adjusted` 截过时出现，值为 `true`，规则 51 (g)） | v27（`motion_overrides`）。回过 `set_motion_overrides` 的 `ack` `ok`=true 之后一条（规则 51） |
| `mod_settings` | `req`（正整数，同 `set_mod_settings`；渲染器自己报时为 `null`）、`character`（非空字符串）、`appearance`（外观 id，1–64 字节）、`values`（对象，开关 id → 整数 0–255，这个外观全部开关的实际生效值）；可选 `adjusted[]`：`{id, reason}`，生效值和请求不同或请求里没给的每个开关，`reason`：`"defaulted"` / `"unsupported"`（规则 53 (c)） | v27（`mod_settings`）。回过 `set_mod_settings` 的 `ack` `ok`=true 之后一条；规则 53 (e) 的自报 |
| `reaction` | `trigger`：`"pat"` / `"pinch"` / `"greet"`；除 `v`、`type` 外只有这一个键，不带时刻 | v27（`reactions`）。她开始一次反应时一条：摸头每划一下、捏脸每抓一次、每播一次迎接（规则 55） |

`actions[]` 每项（v13）：

| 键 | 内容 |
|---|---|
| `id` | 非空字符串，≤ 64 字节，同一角色内唯一 |
| `name` | 非空字符串，中文名 |
| `section` | `"talk"` / `"react"` / `"idle"` / `"move"` / `"touch"` / `"battle"` |
| `duration` | 秒，数 > 0；循环动作为 `null`（animation 沿链加 clip 长度算出） |
| `trigger` | 非空字符串，触发条件，ui 原样显示 |
| `required_reason` | 必需动作写原因（非空字符串），否则 `null` |
| `missing` | 缺资源时写缺什么（非空字符串），否则 `null` |
| `media` | v27 可选（`motion_media`）：`{bgm, face, camera}`，三个布尔都必有，各表示这个动作有没有音乐、脸部、相机轨；只对有媒体轨的动作给 |
| `pose` | v27 可选（`poses`）：`"stand"` / `"akimbo"` / `"sit"` / `"floor"` / `"lie"` 之一，表示这一行是姿态行；渲染器列了 `poses` 才带（规则 47） |
| `default_enabled` | v27 可选：布尔，只对默认关的行给，值为 `false`；没有这个键的行默认开（规则 28） |

## 消息：Companion → 渲染器

| type | 字段 | 何时发 |
|---|---|---|
| `hello` | `role`=`"companion"`、`pid`（正整数）、`protocol`=1；`capabilities`（必有）、v9 可选 `build`（见「能力」）；v10 可选 `trace_epoch`（整数 ≥ 1，Companion 列了 `trace` 时必有，规则 22） | 收到渲染器的 `hello` 后回一条 |
| `cursor` | `x`、`y`（窗口点）、`inside`（光标在窗口矩形内）、`hit`（命中任一胶囊） | 光标移动时判定（规则 1）；值变了就发；v9 没变也至少每 100 ms 发一次（v8 是 1 s） |
| `fps_tier` | `tier`、`fps`，取值见下表；v19 可选字段对 `user_fps`（整数 30/45/60）、`battery_low`（布尔，电池供电时是否上限 30），必须同时出现 | `hello` 之后一次；档位或上限设置保存变化时各一次，实时更新宿主策略，无需重启 |
| `quit` | `reason`（非空字符串，例如 `companion_exit`、`restart`） | Companion 要渲染器退出时 |
| `stop_speech` | `reason`=`"barge_in"`；v10 可选 `turn_generation`（整数 ≥ 0，agentd `POST /turn/cancel` 回的新 generation；渲染器列了 `turn_generation` 时才带，规则 24） | 用户按下按住说话热键时（打断角色说话） |
| `point_at` | `nudge_id`（非空字符串）、`kind`=`"alert"`、`rect`：`{x,y,w,h}`（窗口点，`w`、`h` > 0）或 `null` | 收到 agentd `/feed` 的 `nudge`（`kind`=`alert`）时一次（规则 9） |
| `move_window` | `x`、`y`（窗口左下角的新位置，全局点） | 恢复记下的位置、「放回默认位置」时（规则 12） |
| `set_visible` | `visible`（布尔） | 「隐藏角色」开始和结束时（规则 13） |
| `set_character` | `id`（非空字符串，角色 id，例如 `aster`、`birch`）；可选 `appearance`（新角色上次的外观，非空字符串）；v27 可选 `hidden_layers`（新角色上次隐藏的层，`id` 数组，最多 16 项，不重复，规则 46）；v27 可选 `mod_settings`（新角色记下的 mod 设置，对象，外观 id → `values`，`values` 同 `set_mod_settings`，`mod_settings`，规则 53） | 用户在菜单栏或角色菜单里选了另一个角色时（规则 14） |
| `set_appearance` | `id`（非空字符串，当前角色 `appearances` 里的 `id`） | 用户在菜单栏或角色菜单里选了另一个外观时；握手后 `hello.appearance` 和这个角色上次的外观不同时一次（规则 16） |
| `set_layers` | `hidden`（数组，要隐藏的全部层的 `id`，最多 16 项，不重复；`[]` 全部显示） | v27（`layers`）。用户在菜单或角色页里开关某一层时，带整组（规则 46） |
| `set_placement` | 可选 `x`、`y`（锚点，全局点，两个一起出现）、可选 `scale`（0.5–2.0）；至少有其一；可选 `req` | v9（`placement`）。用户调角色大小、「放回默认位置」时（规则 19） |
| `get_actions` | 无 | v13（`actions`）。打开角色卡时；Companion 认为清单过期时（例如收到 `actions` 带 `error`=`not_ready` 后 2 s） |
| `set_action_switches` | `character`（非空字符串）、`switches`（对象，`id → bool`，最多 128 项） | v13。收到某个角色的 `actions`、而用户配置里存的这个角色的表和报来的 `switches` 不同时一次；用户在角色卡里保存时一次 |
| `touch_settings` | `regions`、`pat`、`pinch`、`greet`，四个布尔都必有 | v27（`touch`）。两边都列了 `touch` 时，hello 之后一条；任一值在设置里保存变化时一条 |
| `play_action` | `play_id`（非空字符串，≤ 64 字节，每次新取）、`character`（非空字符串）、`id`（动作 `id`）、`speed`：`0.5` / `1` / `2`；v27 可选 `loop`（布尔，缺省 false，`action_loop`，规则 29） | v13。用户在角色卡里点「在桌面上播一次」时 |
| `stop_action` | `play_id`（要停的那次播放，非空字符串，≤ 64 字节）；没有别的字段 | v27（`action_loop`）。要停下正在播的动作时（规则 29） |
| `set_pose` | `req`（正整数，必有）、`character`（非空字符串）、`id`（姿态行的动作 `id`，1–64 字节；`null` 表示回到自动）、`lock`（布尔） | v27（`poses`）。用户选一个姿态或解除姿态时一条（规则 47）。渲染器回 `ack`；`ok`=false 时 `error`：未知 `id` 或这一行不是姿态行回 `invalid`，身体忙回 `busy`，不支持回 `unsupported`，其他失败回 `failed` |
| `surfaces` | `seq`（整数 ≥ 0，每条 +1）、`windows[]`（窗口项，最多 32 个，从前到后） | v14（`surfaces`）。握手后一次；之后每 500 ms 查一次（2 Hz），列表有变化才发；前台 app 变化、切 Space、屏幕配置变化时立刻查一次（规则 31） |
| `surface` | `track_id`（同请求）、`state`：`"tracking"` / `"gone"`；`tracking` 时带 `window`（窗口项），`gone` 时带 `reason`（规则 32） | v14。收到 `track_surface` 后立刻一条；之后每 33 ms 查一次（30 Hz），`window` 有变化就发，没变化每 100 ms 照发一条；窗口消失时发一条 `gone`，跟踪结束。v15（`layering`）：attach 的那个 `track_id` 的 `tracking` 在 `window` 里带 `above[]`（规则 34） |
| `set_opacity` | `opacity`（0.2–1）、`duration_ms`（整数 0–2000，从当前值线性变到 `opacity` 的时长） | v15（`opacity`）。盖住时不发：被盖住时她让开、不变淡（规则 35） |
| `covered` | 盖住时 `window_id`（正整数）、`generation`（正整数，同窗口项）、`frame`（`{x, y, w, h}`，全局点，`w`、`h` > 0）；离开时只有 `window_id`=`null` | v15（`opacity`）。进入盖住时一条；仍在盖住而盖她的窗口换了一个时一条；离开时一条（规则 35） |
| `pointer` | `speed`（pt/s，≥ 0）、`hover_ms`（整数 ≥ 0）、`near`（布尔）、`shake`（布尔） | v16（`pointer`）。值变化时，每秒最多 10 条（规则 36） |
| `attention_side` | `source`：`"panel"` / `"focus"`、`kind`（非空字符串，面板或窗口的种类）、`side`：`"left"` / `"right"`（屏幕上在她身体中心的哪一侧）、`generation`（整数 ≥ 0，每条 +1） | v22.1。面板出现在她一侧时；焦点切到中心离她超过 300 pt 的窗口、停留 ≥ 3 s 时。同一来源两条至少隔 45 s（规则 39） |
| `present` | `token`（非空字符串，≤ 64 字节，每次 `open` 新取，`close` 用同一个）、`side`：`"left"` / `"right"`、`phase`：`"open"` / `"close"` | v22.1。要在她旁边展示面板或选项时 `open`，收起时 `close`（规则 39） |
| `pass_through` | `rects[]`：`{x, y, w, h}`（全局点，同 `covered.frame`，`w`、`h` > 0），0–8 项；`[]` 清掉 | v24（`pass_through`）。列表变化时发一条，带当前全部矩形（规则 41） |
| `keep_clear` | 请求时 `id`（非空字符串，≤ 64 字节，每个请求新取）、`kind`：`"text_input"` / `"caret"` / `"control"` / `"dialog"` / `"banner"` / `"ime"` / `"near_clicks"` / `"video"` / `"game"`、`rects[]`：`{x, y, w, h}`（全局点，`w`、`h` > 0），1–8 项；撤回时只有 `id`=`null` | v26（`keep_clear`）。矩形碰到她的身体满 1.2 s、键盘静了 1.5 s 时一条，之后 8 s 冷却（`dialog`、`banner` 不等冷却）；不再需要时一条 `null`（规则 42） |
| `set_render` | 至少一组：`camera`（`{mode, yaw, pitch}`）、`light`（`{yaw, pitch, strength}`）、`outline`、`facing`、`grounding`（`{mode}`）、`ambient`（`{mode, light_wrap}`），组内字段都可选；v27 `camera` 另有可选 `zoom`、`sway`、`closeup`、`live`（`camera_free`）、`track`（`camera_track`），见规则 49；v27 另有组 `filter`（字符串，`filters`），见规则 43；v27 另有组 `dof`（`{mode}`）、`photo`（`{active, aperture, focus}`）（`photo`），见规则 43；可选 `req` | v27（`render_live`）。用户保存渲染设置时一条，只带变了的组（规则 43） |
| `ambient_sample` | `source`：`"screen"` / `"wallpaper"` / `"appearance"`、`colors`：`{mean, top, bottom, left, right}`，每个 `[r, g, b]`（线性 sRGB，0–1）；不带 `req` | v27（`ambient`）。`render_ambient` 不为 off 时，最多 2 Hz（规则 44） |
| `capture` | `req`（正整数，必有）、`background`：`"transparent"`（本版只有这一种） | v27（`capture`）。用户要保存截图时一条（规则 50）。渲染器回 `ack`，成功时再发 `captured` |
| `set_motion_overrides` | `req`（正整数，必有）、`character`（非空字符串）、`chains`（对象，链 key → 布尔，最多 512 项）、`pools`（对象，池 key → `[{clip, weight}]`，最多 64 个池，每池 1–64 项，`clip` 不重复，`weight` 整数 1–100000）、`blend_in`（对象，clip 名 → 秒，0–2，最多 512 项）；三个对象都必有，`{}` 表示这一类不覆盖 | v27（`motion_overrides`）。角色就绪、用户配置里有这个角色的覆盖时一次；用户保存时一次；每次带这个角色的整份覆盖（规则 51）。渲染器回 `ack`，`ok`=true 时再发 `motion_overrides` |
| `play_chain` | `req`（正整数，必有）、`play_id`（非空字符串，≤ 64 字节，每次新取）、`character`（非空字符串）、`start`（链 key，即这条链起头片段的 clip 名）；可选 `speed`：`0.5` / `1` / `2`，缺省 1 | v27（`play_chain`）。用户在动作设置里点「在桌面上播这条链」时（规则 52）。渲染器回 `ack`，`ok`=true 时再照规则 29 发 `action_played` |
| `set_mod_settings` | `req`（正整数，必有）、`character`（非空字符串）、`appearance`（外观 id，1–64 字节，可以不是当前外观）、`values`（对象，开关 id → 整数 0–255，最多 64 项；`{}` 表示全部回到默认） | v27（`mod_settings`）。连上或换角色时，Companion 记下的这个角色每个外观一条；用户改一次一条（规则 53）。渲染器回 `ack`，`ok`=true 时再发 `mod_settings` |

v9：`move_window`、`set_visible`、`set_placement`、`fps_tier` 带字段 `req`（正整数，每条命令新取一个）；Companion 每条都带。渲染器对带 `req` 的命令回一条 `ack`（规则 18）。

| tier | fps | 场景 |
|---|---|---|
| `interactive` | 60 | 指针悬浮角色轮廓、拖动、可见对话或气泡、说话；关闭 `idle_low_fps` 时始终使用（暂停优先） |
| `working` | 30 | `idle_low_fps` 默认开启时的空闲基线 |
| `idle` | 15 | 保留档位，Companion 当前不发送 |
| `sleep` | 5 | 保留档位，Companion 当前不发送 |
| `paused` | 0 | 被遮挡或用户暂停；停止提交渲染 |

Metal 宿主把 `fps_tier.fps` 作为自动基线，消息格式和上表取值不变：

- **暂停**：窗口隐藏、系统挂起或 `fps`=0 时，目标为 0；暂停 display link 和渲染提交，继续收发消息。
- **硬上限**：用户 `--agentic-complex-render-fps`（30/45/60，收到带上限的 `fps_tier` 后用其 `user_fps`）；启用 `battery_low_fps`（收到带上限的 `fps_tier` 后用其 `battery_low`）时电池供电 30；低电量模式 30；热状态 serious 30、critical 15。取所有生效上限的最小值，活动不能突破。
- **自动基线和活动**：通常目标为基线与硬上限的最小值；拖动窗口、指针按下、胶囊命中时 cursor revision 变化、说话、行走、转身、播放动作或切换角色期间可提升到 60，仍受硬上限限制。最后一次活动信号后保持 2 s，再回到基线。
- 低电量模式和热状态由系统通知实时更新，无需重启。display link 的首选帧率范围随目标更新；停止回调时才用间隔 `1/max(target, 4)` s 的 Timer 兜底，容差至少为间隔的 10%。只改目标帧率不重置时间历史；隐藏和挂起状态变化仍重置。

## 规则

1. 命中：Companion 用最近一帧 `hit_capsules` 判断光标是否落在某个胶囊里（点到线段 `ab` 的距离 ≤ `r`）；`space`=`global` 时直接用全局光标位置比。超过 500 ms 没有收到 `hit_capsules` 时，`hit` 一律为 false。v9：判定由光标移动事件触发（全局和本地的鼠标移动监视），光标离胶囊外接矩形 120 pt 以内时另加 16 ms 轮询兜底，外接矩形外扩 10 pt；其余时候按 100 ms 的保活间隔判定。v15：attach 期间（规则 34），光标落在最近一条 `surface.window.above` 的任一矩形里时 `hit` 为 false；v18：前台窗口重叠（规则 35）不再扣除可见角色轮廓的命中。都按全局点比，胶囊照旧算。
2. 穿透：渲染器收到 `cursor` 后设 `window.ignoresMouseEvents = !hit`。拖动期间（`drag` `begin` 到 `end`）渲染器保持接收鼠标，Companion 也把 `hit` 固定为 true。按下到抬起之间（还没判定成单击或拖动）渲染器同样保持接收鼠标。v15：带 `--agentic-complex-host-socket` 启动时，渲染器第一次选中窗口就设 `ignoresMouseEvents=YES`，收到第一条 `cursor` 之前一直保持穿透（`hello` 之前、握手中都是）。
3. 拖动由渲染器自己做，拖动中窗口位置变化照常发 `window_frame`。左键按下后移动 4 pt 以上就开始拖，不需要按修饰键；这次按下不再算单击，不发 `click`。`viewport`=`window` 时渲染器按鼠标位移移动窗口（v8）。`viewport`=`fullscreen` 时窗口不动：插件把光标位置、抓点和速度交给渲染器的放置（`HostPlacementLink`），角色怎么跟（钉在光标下、拎起、抛落）由它决定，拖完由 `placement`（`reason`=`drag`）报新位置。`grab` 在 `begin` 时取一次（按下点减锚点），整次拖动不变。v27：`touch_settings.pinch` 为 true 且按下处的区域是 `cheek_l` / `cheek_r` 时，这次按下是捏脸：不开始拖动、不发 `drag`、不发 `click`；按下到抬起之间照规则 2 保持接收鼠标。
4. 帧率：渲染器收到 `fps_tier` 后按上节的暂停、硬上限和自动基线规则确定 Metal 目标帧率；`fps`=0 时停止提交渲染，但继续收发消息。降帧必须降低 CommandBuffer 提交频率。
5. 退出：渲染器收到 `quit` 或读到 EOF 后 4 s 内退出进程。Companion 发 `quit` 后等 4 s，进程还在就 SIGKILL。
6. 语音取消：渲染器没有 agentd 的可写令牌。收到 `speech_cancelled` 后，由 Companion 用 ui token 调 agentd 的 `POST /speech/cancel`，body `{"speech_id", "reason"}`。reason 映射：`client_cancel` → `client_cancel`，`playback_failed` → `error`。agentd 回 202、409（已结束）、404（未知）、503（无 TTS）都只记日志，不重试。
7. 打断：Companion 按下热键时发 `stop_speech`，同时照旧调 agentd 的 `POST /speech/cancel`（body `{"reason": "barge_in"}`）。合成完成后 agentd 可能已没有可取消的流，渲染器却还在播缓冲里的音频，所以渲染器必须自己停。渲染器收到后若正在播一段语音，按 C2 规则 4 停掉（停播放、清 cue、嘴归中性），再按第 6 条发 `speech_cancelled`（`reason`=`client_cancel`）；没在播就忽略。
8. 父进程监视与本合同独立：渲染器还按 `--agentic-complex-parent-pid` 监视 Companion，父进程退出就退出。
9. 指向：agentd 的 `nudge` 带 `target`（目标窗口的 `window_id`）。Companion 用 `CGWindowListCopyWindowInfo` 取这个窗口的 `kCGWindowBounds`（CG 全局坐标，原点在主屏左上角，y 向下），换成全局点（y = 主屏高 − (y + h)），再减去最近一次 `window_frame.frame` 的原点，得到窗口点的 `rect`。`rect` 可以在角色窗口外面（坐标为负或大于 `w`、`h`）。`target` 为 null、窗口已不在、或还没收到 `window_frame` 时，`rect` 为 null。渲染器收到后换表情，`rect` 不为 null 时朝 `rect` 的中心指；表情、指向动作和持续时间归 animation。没完成握手时 Companion 不补发。`kind`=`comment` 的 nudge 不发 `point_at`（台词照常走 C2）。
10. 点击：都只在命中胶囊上算。左键按下到抬起少于 300 ms、移动少于 4 pt，发 `click`（`button`=`left`、`count`=1）。上一次单击抬起后 350 ms 内又完成一次单击，再发一条 `count`=2；第一次的 `count`=1 已经发过，不撤回。右键按下，或按住 Control 左键按下，发 `button`=`right`、`count`=1，不等抬起。点击反应由渲染器在本进程里播（归 animation），不经过 Companion；角色正在说话时单击，结果是先停语音、再播反应：渲染器先按规则 7 停掉语音（发 `speech_cancelled`），再播反应，反应不因为刚才在说话而被跳过。Companion 收到 `count`=2 打开会话面板，收到 `right` 在 (`x`, `y`) 换算出的屏幕位置弹出角色菜单，`count`=1 的左键等到不再可能成为双击后发 `POST /interaction/tap`：有待说的仪式时说仪式，否则说一句由模型现写的点击回应（`reason.code`=`tap`）。v27：`regions` 为 true 时，单击反应先找 `click.<区域>` 池，再按规则 45 的退回链，最后 `click.single`，都在渲染器内选；为 false 时同以前。
11. 帧统计：渲染器每秒发一条 `stats`，`fps`=0（`paused` 档）时照发。`gpu_ms` 用 command buffer 的 `gpuEndTime − gpuStartTime`，取不到为 `null`。Companion 只用它显示状态，不据此改 `fps_tier`。Companion 仍不从 `stats` 改 `fps_tier`；渲染停滞按规则 17 处理。
12. 移动窗口：渲染器收到 `move_window` 后把窗口左下角移到 (`x`, `y`)，大小不变；正在拖动时忽略这条。`viewport`=`fullscreen` 时忽略这条（回 `ack` 时 `error`=`unsupported`）；全屏视口下的换屏归规则 20。移动后照常发 `window_frame`。位置按哪块显示器记、窗口不能移出可见区域，都由 Companion 算好再发，渲染器不再校正。
13. 显示隐藏：`visible`=false 时渲染器把窗口从屏幕上拿掉（`orderOut`），继续收发消息，`hit_capsules` 照发空数组；`visible`=true 时放回原位置。Companion 在隐藏期间把 `cursor.hit` 固定为 false，并发 `fps_tier` 的 `paused` 档；放回时恢复原来的档位。
14. 切换角色：
    - **以 hello 为准**：Companion 把渲染器 `hello` 的 `character` 当作当前角色，不以自己传的 `--agentic-complex-character` 为准。两者不同时（渲染器已回退到默认角色），Companion 记日志、菜单显示 `hello.character`，不自动再发 `set_character`。
    - **回复**：每条 `set_character` 渲染器都回且只回一条 `character_changed` 或 `character_change_failed`，`id` 和请求相同。
    - **已经是这个角色**：不释放、不淡出，立刻回 `character_changed`，`ms`=0。
    - **释放**（v12）：开始淡出之前，插件把释放请求计数加 1（带目标 id），等渲染器的切换器释放完后调 `EW_HostReleaseFinished()`，或者 1200 ms 到，再开始淡出。释放期间照常提交画面，`ignoresMouseEvents` 和命中照常；穿透从开始淡出算。切换外观（规则 16）不释放。
    - **切换中**：切换进行中又收到 `set_character`（Companion 不这样发，见规则 26），渲染器立刻回 `character_change_failed`，`reason`=`switching`，当前这次照常做完。
    - **`reason` 取值**：`switching`（切换角色中）、`unknown_character`（没有这个角色的包）、`pack_rejected`（pack.json 的 sha 核对不过）、`load_failed`（其他加载失败）。失败时渲染器已恢复旧角色。
    - **穿透**：从开始淡出到淡入结束，渲染器设 `ignoresMouseEvents=YES`，不看 `cursor.hit`，`hit_capsules` 发空数组。Companion 从发出 `set_character` 到收到这条的回复（或超时），把 `cursor.hit` 固定为 false。
    - **透明度**（v15）：窗口的 `alphaValue` = 切换淡入淡出的 alpha × `set_opacity` 的当前值（规则 35；没收到过时为 1）。淡入的终点是 `set_opacity` 的当前值，不是 1。`set_opacity` 不改 `ignoresMouseEvents`，上一条的穿透照旧。
    - **拖动中**：正在拖动时收到 `set_character`，等 `drag` `end` 之后再开始释放。
    - **移动窗口**：从开始淡出到开始淡入之间收到的 `move_window`，渲染器只留最后一条，在开始淡入前执行；其余时间照规则 12。
    - **隐藏时**：`set_visible`=false 期间收到 `set_character`，照常释放，不做淡出淡入，直接切换、回复；窗口保持隐藏。切换中收到 `set_visible`=false，跳过还没做的淡入，照常回复。
    - **超时**：Companion 发出 `set_character` 后 11 s（释放 1.0 + 淡出 0.2 + 加载 9 + 淡入 0.2 = 10.4 s）没收到回复，按失败处理：恢复 `cursor.hit` 的正常计算，记日志，菜单里的当前角色不变。之后再收到这条的 `character_change_failed` 只记日志；再收到这条的 `character_changed`，Companion 发 `set_character` 换回它记的当前角色（照规则 26 一次一条）。
    - **记住选择**：Companion 只在收到 `character_changed` 后把这个 id 记为「上次的角色」。
    - **切换角色时带外观**：`set_character` 带 `appearance` 时，渲染器在同一次切换里按这个外观加载新角色，不另外淡出淡入。新角色没有这个外观时按默认外观加载，仍回 `character_changed`，用其中的 `appearance` 报实际外观。
15. 渲染器的 `hello` 没有 `character` 时，Companion 按 `aster` 处理。
16. 切换外观：
    - **回复**：每条 `set_appearance` 渲染器都回且只回一条 `appearance_changed` 或 `appearance_change_failed`，`id` 和请求相同。
    - **不淡出淡入**：渲染器在下一帧直接换外观，不改 `ignoresMouseEvents`。Companion 不固定 `cursor.hit`。
    - **已经是这个外观**：立刻回 `appearance_changed`。
    - **排队**：上一个外观还没换完又收到 `set_appearance`，只留最后一个；被顶掉的立刻回 `appearance_change_failed`，`reason`=`superseded`。
    - **切换角色中**：从收到 `set_character` 到回复它之前收到的 `set_appearance`，立刻回 `appearance_change_failed`，`reason`=`switching`。Companion 在这段时间禁用外观菜单。
    - **`reason` 取值**：`superseded`（被顶掉）、`switching`（切换角色中）、`unknown_appearance`（当前角色没有这个外观）、`load_failed`（其他失败）。失败时渲染器保持原外观。
    - **超时**：Companion 发出 `set_appearance` 后 10 s 没收到回复，按失败处理，菜单里的当前外观不变。之后再收到这条的回复只记日志。
    - **记住选择**：Companion 按角色记外观，只在收到 `appearance_changed`，或 `hello` / `character_changed` 报了 `appearance` 时更新。

17. 心跳与看门狗（v9）：
    - **渲染器发**：渲染器列了 `heartbeat` 时，从 `hello` 之后起，主线程每 100 ms 发一条 `heartbeat`。计时器挂在主线程 run loop 的 common modes 上，帧率档位为 `paused`、窗口隐藏、切换角色时照发。
    - **渲染器自己的判定**：`cursor.hit` 为 true 而超过 200 ms 没有收到新的 `cursor` 时，渲染器设 `ignoresMouseEvents=YES`（拖动中、按下到抬起之间除外）。
    - **Companion 看**：Companion 列了 `watchdog` 时，具有 `heartbeat` 能力的连接从 hello 开始等首条心跳，超过 10 s 仍未收到就以 `first_heartbeat_timeout` 终止渲染器，由子进程监督退避重启；收到第一条后按以下稳态规则计时。未声明 heartbeat 的旧连接不受此新期限影响：
      1. 最后一条 `heartbeat` 的 `click_through` 为 false（窗口在接收鼠标）且没有被 `set_visible` 隐藏，或正在拖动，且超过 800 ms 没有新的 `heartbeat`：SIGKILL 渲染器，由子进程监督重启。
      2. 最后一条的 `click_through` 为 true：超过 10 s 没有新的 `heartbeat` 才 SIGKILL。
      3. 300 ms 没有新的 `heartbeat` 时记一行日志；恢复后再记一行。
    - **渲染进度（v20）**：列了 `render_progress` 的渲染器在每条 `heartbeat` 中填写 `frames`、`render`。
    - **Companion 看渲染（v20）**：对具有 `render_progress` 的连接，`render` 连续为 `active` 且 `frames` 4 s 没有增加时，Companion 以 `render_stall` 为原因 SIGKILL 渲染器，由子进程监督重启。4 s 从最后一次 `frames` 增加、本连接的 `hello`、最后一次 `render` 从 `idle` 变为 `active` 三者中最晚的时刻算起。心跳停止的连接按上面第 1–3 项处理，不按本项处理。
    - **单次错误（v20）**：一次 command buffer 失败或一次 `nextDrawable` 返回 nil 不停止渲染器；在 `stats` 中计数并继续渲染。
    - 只能杀进程，不能从外部改穿透：主线程卡住时，同一进程别的线程改窗口的穿透标记要等主线程恢复才生效（host 探针 2026-10-19）。
    - 渲染器主线程做长时间的事（加载角色等）之前先设 `ignoresMouseEvents=YES`，这样心跳停了也只按第 2 步等 10 s（规则 14 的切换已经这样做）。
    - 检测加恢复 ≤ 1.0 s：800 ms 后杀进程，进程退出后窗口消失。
    - 验收：① 接收鼠标时卡住主线程：800 ms 内被杀、监督重启、1 s 内点击能穿过；② 已设穿透时卡住主线程：10 s 之前不被杀。
18. 回执（v9）：
    - Companion 每条 `move_window`、`set_visible`、`set_placement`、`fps_tier` 都带 `req`。渲染器对每条带 `req` 的这四种命令回且只回一条 `ack`，`req` 相同。
    - `ok`=true：命令已执行。`error`：`invalid`（字段取值不合规则 21）、`busy`（拖动中、切换角色中，命令被丢弃）、`unsupported`（这个视口或这个版本不支持）、`failed`（执行失败）。
    - `set_character`、`set_appearance` 照旧用规则 14、16 的回复，不回 `ack`。
    - Companion 等 `ack` 最多 2 s，超时记日志，不重发。
19. 放置（v9）：
    - **记住**：Companion 按角色和屏记最近一条 `placement` 的 `x`、`y`、`scale`（代替 v6 按角色和屏记窗口位置），启动渲染器时用 `--agentic-complex-placement` 传回。
    - **改**：用户调角色大小时 Companion 发 `set_placement {scale}`；「放回默认位置」发 `set_placement {x, y}`（默认锚点由 Companion 算：所在屏 `visibleFrame` 右下角往里 200 pt、底边往上 0 pt）。
    - **缺省锚点**：`viewport`=`fullscreen` 且没有 `--agentic-complex-placement` 时，渲染器的缺省锚点同上，用窗口所在屏的 `visibleFrame`（∩ 窗口）：右边往里 200 pt、站在底边上，不压 Dock。
    - **夹到屏内**：窗口视口下渲染器让角色整个留在窗口里。全屏视口下（v27）锚点留在屏内：没有别的屏相邻的边（自由边）锚点离可见区边缘至少 12 pt，身体、头发、道具可以部分出屏；与另一块屏相邻的边（共享边）在放置落定后（换屏、拖动松手、执行 `set_placement`、走路结束）把她整个可见范围移回本屏，0.25 s 内缓动过去；动作播放期间不为留在屏内移动她。y 方向仍让身体留在屏内，她自己走路选的终点也让身体留在屏内；C1 `short_walk` 的 `edge` 目标例外，终点在自由边上时身体可以部分出屏，锚点照上面离可见区边缘至少 12 pt。请求的锚点做不到时就近夹住，用 `placement`（`reason`=`set_placement`）报实际值。全屏站在地面上时，锚点 y 落在地面带内（渲染器夹），`placement` 报夹后的值。
    - **拖动中**收到 `set_placement`：丢弃，回 `ack` `busy`。
    - **大小**（v13.1）：角色在屏上的大小只由 `scale` 决定（1 = 540×780 pt），和窗口尺寸无关，两种视口都是。
    - `viewport`=`window` 时（v13.1）：
        - 窗口内容 = 540×780 pt × `scale`。
        - `set_placement` 只执行 `scale`：以窗口底边中点为锚改窗口尺寸。窗口放不进所在屏的 `visibleFrame` 时，先把 `scale` 降到放得下，再把窗口移进 `visibleFrame`。回 `ack` ok，发 `placement`（`reason`=`set_placement`，`scale` 为实际值）。
        - 带 `x`、`y` 的 `set_placement` 不执行，回 `ack` `unsupported`；位置照 v6 用 `move_window`，Companion 照 v6 按角色和屏记窗口位置，不传 `--agentic-complex-placement`（渲染器收到也忽略）。
        - `placement` 照发：锚点由窗口位置算，`scale` 为窗口的 `scale`。Companion 按角色记最近一条 `placement` 的 `scale`，启动渲染器时用 `--agentic-complex-scale` 传回。上面「记住」的 `x`、`y` 只用于 `fullscreen`。
    - 谁移动角色：拖动归规则 3；自主活动由渲染器改放置，`reason`=`behavior`。
20. 全屏视口（v9）：
    - Metal 局部呈现实现（2026-10-26）：`fullscreen` 表示角色可活动的桌面坐标域，允许物理透明窗口只覆盖当前可见几何及安全余量，并随动作、走动改变范围。以下屏幕范围规则继续用于逻辑活动域；`window_frame.frame` 始终报告实际窗口，不伪报为整屏。命中胶囊按实际窗口变换，协商 `capsules_global` 时直接发送桌面全局点；角色位置仍只由 `placement` 表达，物理窗口移动不等同于角色移动。窗口尺寸/位置与对应画面在同一 Core Animation transaction 提交；跨屏夹紧和 24 pt 滞回依据逻辑活动屏，不能依据局部窗口碰到的屏幕。关闭局部呈现的兼容路径（`--debug-fullscreen-window`）沿用下面的整屏窗口规则。
    - `--agentic-complex-viewport fullscreen` 时，渲染器把窗口铺满锚点所在的屏（没有 `--agentic-complex-placement` 时用主屏），但不含顶上菜单栏那一条：窗口 = 该屏 `frame` 去掉顶上 `frame.maxY − visibleFrame.maxY`（这个差为 0、菜单栏自动隐藏时，去掉 `NSStatusBar.systemStatusBar.thickness`；v14.1：不显示菜单栏的屏不去掉，即「显示器使用单独空间」关时主屏以外的屏，窗口 = 整个 `frame`）。
    - 窗口 `animationBehavior`=none，不用原生全屏（不进单独的 Space），level 25，`canJoinAllSpaces|stationary|ignoresCycle|fullScreenAuxiliary`。
    - 角色在画面里移动，窗口不动。`window_frame` 带 `viewport`=`fullscreen` 和 `display_id`。
    - 屏的大小或缩放变了（接拔屏、改分辨率）时，渲染器按上面的规则重铺窗口，再发 `window_frame`。
    - 换屏（v14.1）：
        1. 拖动中光标离开窗口所在屏的 `frame` 超过 24 pt、落在另一块屏上时，渲染器把窗口铺到那块屏（同样按上面的规则去掉菜单栏那一条），再发 `window_frame`（带新的 `display_id`）。之后放置按新窗口夹紧。光标在交界两侧 24 pt 以内来回时不换屏，窗口不来回铺。
        2. `set_placement` 带的点在另一块屏时，渲染器先把窗口铺到那块屏，再执行请求。这里不留 24 pt。
        3. 自主活动（`reason`=`behavior`）不换屏。
        4. Companion 按角色记最近一条 `placement` 所在的屏（`display_id`）。下次启动时那块屏还接着，`--agentic-complex-placement` 就用它在那块屏记下的放置，否则用主屏的。
        - 要求：从挪窗口到下一帧胶囊提交 ≤ 100 ms。插件打日志 `AAC_HOSTLINK screen_switch display=<id>` 和 `AAC_HOSTLINK screen_switch_frame ms=<ms>`。
    - Companion 的气泡、菜单、审批卡窗口放在这个窗口之上（level 高于 25）。
21. 取值和数量限制（v9）。收到的消息不合下面任一条时丢弃这一条、记日志，连接不断（`ack` 回 `invalid`）：
    - 数都是有限值；坐标的绝对值 ≤ 100000；`scale` 在 0.5–2.0；`r` ≤ 10000；`vx`、`vy` 的绝对值 ≤ 100000。
    - 字符串最长 256 字节；`id`、`speech_id`、`nudge_id` 最长 64 字节。
    - `fps_tier` 的 `tier` 和 `fps` 必须是表里的一对；渲染器收到其他值不改帧率。`fps_tier` 带上限时，`user_fps` 必须是整数 30/45/60、`battery_low` 必须是布尔且同时出现；不合规时整条丢弃，保留原档位和上限。不带时保留启动参数或上次收到的上限。
    - 渲染器只接受 `role`=`companion`、`protocol`=1、`v`=1 的 `hello`；不合的不算握手。
    - 任一方在 1 s 内收到对方超过 2000 行时，关闭连接。
22. Trace 转发（v10，C6 T1）：
    - 渲染器只在 Companion 列了 `trace` 时发 `trace`。`producer_epoch` 用 Companion 这次 `hello` 的 `trace_epoch`；`seq` 在这个 epoch 内从 1 严格递增。
    - `trace_epoch`：Companion 每启动一次渲染器取一个新值 = max(上次的值 + 1, 当前 Unix 毫秒)。上次的值存在 Companion 的 support dir，Companion 重启也不回退。
    - 渲染器一侧的事件：语音播放（`HostPlaybackTrace`）发 `playback.started`、`playback.ended`、`playback.interrupted`（带 `reason`、`planned_ms`）、成对的 `playback.buffering` / `playback.resumed`、`playback.degraded`，带 C2 v2 `begin` 的 `trace_id`、`turn_id`、`turn_generation`。
    - Companion 把渲染器的事件和自己的事件（`producer`=`companion`）合批调 agentd `POST /trace/events`：每批 ≤ 200 条，攒满 200 条或攒了 500 ms 就发。agentd 不可达时内存里最多留 2000 条，超出丢最旧的，并在下一批开头补一条 `trace.dropped`（`producer`=`companion`）。agentd 回的 `rejected` 只记日志。
    - Companion 不改事件内容，只按 C6 §4.1 校验必有字段；不合规的那一条丢掉、记日志，同一条 `trace` 里的其他事件照收。
    - 一条 `trace` 超过 50 个事件，或一秒内超过 20 条 `trace`：Companion 丢掉超出的部分、记日志，连接不断（规则 21 的 2000 行上限照旧）。
23. 播放回执（v10）：
    - 渲染器只在 `hello` 列了 `playback` 时发。来源是语音播放的 `HostPlaybackReceipt`。
    - 每段语音从 `started` 开始，以 `ended`、`interrupted`、`failed` 之一结束，之后同一个 `speech_id` 不再发。`buffering` 和 `resumed` 成对，可以出现多次。`degraded`（PCM 长度和 `total_samples` 不符）不结束这段语音。
    - 本地停播（规则 7 的 `stop_speech`、单击打断、切换角色、规则 24 的代际打断）发 `interrupted`，`reason` 和 `speech_cancelled.reason` 相同；`speech_cancelled` 照旧发。
    - Companion 把每条 `playback` 原样（去掉 `v`、`type`）转给 agentd `POST /speech/playback`（ui token，C6）；回 200 `{applied, why}` 只记日志，不重试。
    - 连接断开时，Companion 对已 `started`、还没结束的每段语音补发一条 `state`=`interrupted`、`reason`=`connection_lost`、`sample` 取最后一条的值。
24. 代际打断（v10，C2 v2 规则 8）：
    - `stop_speech` 带 `turn_generation` 时，渲染器调 `ActorSpeechController.interrupt`（`epoch` 取当前 C2 流的 `session_epoch`）：停掉代际低于它的语音，并把它记为代际下限，之后这个 `session_epoch` 里更低代际的 C2 行一律丢弃。
    - 没带 `turn_generation` 时照 v9 取消当前语音（`speech.cancel(reason: "C3_stop_speech")`，规则 7）。渲染器没列 `turn_generation` 时 Companion 不带这个字段。
25. 行为回执（v11，C1 v2 §3）：
    - 每个 `behavior_id` 的第一条回执是 `prepared`、`running` 或 `rejected`（目标已就位的行为可以在同一帧开始，直接 `running`）。`rejected`、`completed`、`blocked`、`cancelled`、`expired` 是终态，之后同一个 `behavior_id` 不再发。
    - Companion 把每条 `behavior_receipt` 原样（去掉 `v`、`type`）转给 agentd `POST /behavior/receipts`（ui token，C6）。同一个 `behavior_id` 的回执按收到的顺序转。agentd 的回复只记日志，不重试；agentd 不可达时这条丢掉、记日志。
    - 连接断开时，Companion 对已 `prepared` 或 `running`、还没到终态的每个行为补发一条 `phase`=`cancelled`、`reason`=`connection_lost`、`at_ms` 取补发时刻、`turn_generation` 取最后一条的值。
    - 一秒内超过 20 条 `behavior_receipt`：Companion 只丢超出的非终态回执、记日志，终态回执一律转发，连接不断（规则 21 照旧）。丢掉的回执照样更新 Companion 记的阶段，所以已经结束的行为在断线时不会再补 `connection_lost`。规则 54 的 `motion_state` 和回执算进同一个每秒 20 条。
    - `cancelled` 的 reason（C1 v2.7）：用户单击，规则 10 的点击反应打断了一个 C1 行为时为 `user_click`；规则 42 为让开矩形结束坐、扶时为 `give_way`；拖动、拎起仍为 `user_drag`。
    - 断线后：Companion 为某个 `behavior_id` 补过 `connection_lost` 之后，渲染器不再为它发回执。重连后快照里的 `behavior` 不会是这个 id；要接着做，agentd 发一个同 `type`、同 `target` 的新行为（C1 v2 的续期规则），渲染器把它当续期，不重做进场动作。
    - 回执不是 trace 事件。

26. 一次一个切换（v12）：Companion 在一条 `set_character` 的回复（或规则 14 的 11 s 超时）之前不发下一条。这期间用户又选了角色，Companion 只记最后一个，当前这条结束后再发。

27. 动作清单（v13）：
    - 渲染器的清单来自当前角色包的 `animation/actions.json` 和 `interaction/actions.json`，按这个顺序合并，`duration`、`missing` 由渲染器加载时算出。
    - 握手时清单还没就绪（角色在加载）就不发，就绪后发一次。收到 `get_actions` 时没就绪，回 `error`=`not_ready`，就绪后再主动发一次。
    - 切换角色（规则 14）从开始释放起，旧角色的清单作废：这期间收到 `get_actions` 回 `not_ready`。新角色就绪后主动发一次。
    - 清单最多 128 项。一条 `actions` 超过一行的上限（64 KiB）时，渲染器记日志，发 `error`=`too_large`、空清单。
    - animation 和 interaction 两份 actions.json 的 `id` 冲突是数据错误，渲染器加载角色时报错（`ActorMotionPolicy`），线上不出现，本合同不规定处理办法。
    - 每条 `actions` 都带完整清单，不发增量。
28. 开关表（v13）：
    - 存放：Companion 按角色存用户在角色卡里选的表（config.json 的 `action_switches`：`{角色 id: {动作 id: bool}}`），存的是用户选的，不是渲染器改过的。渲染器不落盘；连接断开或重启后，用 actions.json 的默认（全开），直到收到 `set_action_switches`。
    - 何时发：收到某个角色的 `actions` 后，用户配置里有这个角色的表、而且和 `actions.switches` 不同时，发一次 `set_action_switches`。用户保存时发一次。不重试。
    - 渲染器应用：必需动作恒为开，缺资源的动作恒为关；一个 section 里要关掉最后一个开着的动作时，它保持开（`last_in_section`）；`section`=`move` 不受这条限制，move 行全关时她站着不动，拖动照旧。表里没有的 `id` 按开处理（v27：带 `default_enabled`=false 的行按关处理，断开或重启后的默认也是关）；不认识的 `id` 忽略，不进 `adjusted`。下一次挑选动作起生效，正在播的不打断，不重启。
    - 渲染器的回复：每条 `set_action_switches` 回且只回一条 `action_switches`。`character` 和当前角色不同时回 `error`=`wrong_character`；切换角色进行中回 `switching`；清单没就绪回 `not_ready`。这三种都不应用。
    - Companion 等 `action_switches` 最多 2 s。角色卡保存的结果以 `action_switches.switches` 为准，和用户选的不同处由 ui 显示（`saveMismatch`）。超时或带 `error` 时，保存按失败报给 ui，用户配置照样写入。
29. 播一次（v13）：
    - 渲染器播这个动作的链，速率 `speed`。旧循环段按 intent map 的 `hold_seconds` 后返回；显式 `hold_policy=while_requested` 的原循环持续到新意图、取消或安全退出，`duration=null`，有限动作仍按原时长结束。停用的动作也能播。
    - 同一动作再播（v14.2）：这个动作的链正在播，或角色此刻就在这条链的某个 clip 上时，又来一条同一 `id` 的 `play_action`，旧的 `play_id` 照样 `interrupted`/`superseded`，新的从当前进度接着播，不从头重来；`speed` 不同时只换速率。
    - 身体忙：渲染器的 `motion.bodyBusy`（`ActorControls.swift`）为 true，或正在拖动。前者包括：要身体的 C1 行为在 prepared/running（不是原地行为和 `face`，占 `full_body` 或 `contact`）；坐着或还没站起来（地面、窗口顶）；手扶着窗沿；姿态场景占着；被拎着或在走路。
    - `rejected` 的 `reason`：`missing`（缺资源）、`unknown_action`、`not_playable`（没有 clip 的程序动作，例如看向鼠标；以及所有 `section`=`move` 的动作）、`wrong_character`（`character` 不是当前角色）、`releasing`（规则 14 的释放中，`Releasing`）、`switching`（释放之后、新角色就绪之前）、`busy`（收到 `play_action` 时身体忙；不打断 C1 行为）。
    - `interrupted` 的 `reason`：`character_switch`（开始释放）、`superseded`（又来一条 `play_action`，旧的立刻 `interrupted`）、`behavior`（播放中身体变忙）、`drag`（播放中开始拖动）、`connection_lost`（Companion 补发，见下）、`stopped`（v27，`stop_action`）。`behavior`、`drag` 由 animation 判。
    - 每个 `play_id` 的第一条是 `started` 或 `rejected`；`completed`、`interrupted`、`rejected` 是终态。
    - 播放开始等待独立于清单/保存的 2 s：渲染器从 socket 首次接收 `play_action` 起使用包含系统睡眠的连续单调时钟，给未 `started` 的请求总共 30 s；队列、资源预热、前一动作安全退出、exact acquisition 和首次提交共用同一个 deadline，不在阶段间重置。过期回 `rejected`/`busy`，撤销该请求尚未启动的目标；旧 owner 可继续安全退出，过期目标不得稍后开始。队列满同样明确回 `rejected`/`busy`。deadline 为 host 内部状态，不增加线上 JSON 字段。
    - Companion 等第一条最多 35 s（连续时钟，为 host 30 s 留回执余量）：收到 `started` 时 `playOnDesktop` 返回，收到 `rejected` 或超时时按失败报给 ui。之后的 `completed`、`interrupted` 只记日志。断开连接时，对已 `started` 未到终态的 `play_id` 记一条 `interrupted`/`connection_lost` 日志。已 started 的持续动作不受开始 deadline 限制；新 play_id 使用自己的接收时间，旧请求的到期不得取消新请求。
    - 循环（v27，`action_loop`）：`play_action.loop`=true 时，有限动作播到末尾不回内置动作，从头再播，音轨从 0 重起，不发 `completed`；`hold_policy=while_requested` 的动作忽略 `loop`。缺省或 false 照旧播一次。
    - 停下（v27，`action_loop`）：收到 `stop_action` 时，`play_id` 是正在播的那条就停下，回 `interrupted`、`reason`=`stopped`；不认识的或已到终态的 `play_id` 忽略，不回。
    - 补记现状（v27，不改行为）：意图为 `end_at_length` 的动作（导入动作）再来一条同一 `id` 的 `play_action` 时从 0 开始播，音乐也从 0 起，不照上面 v14.2 那条接着当前进度播。
30. 取值和数量限制（规则 21 加）：`actions` 最多 128 项，`switches` 最多 128 项，`adjusted` 不多于 `switches`；`id`、`play_id` 最长 64 字节；`name`、`trigger`、`required_reason`、`missing`、`reason` 照规则 21 最长 256 字节；`speed` 只能是 0.5、1、2；`duration` 是有限数且 > 0。不合时丢弃这一条、记日志，连接不断。v27：`play_action.loop` 必须是布尔；`actions[].media` 恰好有 `bgm`、`face`、`camera` 三个键，都是布尔；`stop_action` 只有 `play_id`，非空字符串，最长 64 字节。
31. 表面快照（v14）：
    - 取数：Companion 用 `CGWindowListCopyWindowInfo(.optionOnScreenOnly, .excludeDesktopElements)`，只读 `kCGWindowNumber`、`kCGWindowBounds`、`kCGWindowLayer`、`kCGWindowAlpha`、`kCGWindowOwnerPID`，不读标题和名字，不用辅助功能 API，不注册事件 tap，不改别的窗口。CG 的边框（y 向下）换成全局点再发。
    - 不列：layer 不为 0 的；alpha 为 0 的；宽或高小于 80 pt 的；Companion 自己的窗口（气泡、菜单、审批卡、字幕条、各面板）和渲染器进程的窗口；全部在屏外的。另一个 Space 里的全屏 app 不在 `optionOnScreenOnly` 里，也不列。
    - `segments` 的遮挡只算更前面、也满足上面条件的窗口，加菜单栏和 Dock 的区域（`NSScreen.visibleFrame` 之外）。
    - 渲染器只把最新一条 `surfaces` 当现状，不合并增量。
32. 跟踪目标（v14）：
    - 同一时刻最多 4 个 `track_surface` 在跟。第 5 个请求时 Companion 回 `surface` `gone`（`reason`=`too_many`）。
    - `track_surface` 带 `generation` 且和 Companion 现在的不同，或这个 `window_id` 现在不在列表里（含「不列」的那些），立刻回 `gone`。不带 `generation` 时按现在的那个。跟踪不受快照 32 个的上限。
    - 过期：渲染器 250 ms 没收到某个 `track_id` 的 `surface`，就当这个目标失效（回执 `blocked` / `target_gone`），不等 `gone`。
    - `gone` 之后这个 `track_id` 不再有消息；渲染器不必再发 `untrack_surface`。Companion 收到不认识的 `track_id` 的 `untrack_surface` 时忽略。
    - 连接断开时全部跟踪结束；重连后渲染器按新的 `surfaces` 重新请求，旧 `generation` 不再有效。
    - `gone` 的 `reason`：`"closed"`（窗口不在了）/ `"generation"`（请求的 generation 不对）/ `"not_listed"`（窗口在，但按规则 31 不列）/ `"too_many"`。
33. 取值和数量限制（规则 21 加，v14）：`surfaces.windows` 最多 32 项，`edges` 每个窗口最多 3 条，`segments` 每条边最多 8 段；`track_id` 最长 64 字节；`track_surface` 每秒最多 10 条，超过的 Companion 回 `gone` `too_many`。不合时丢弃这一条、记日志，连接不断。
34. 前后层次（v15）：
    - attach：她扶窗沿、坐窗口顶（以后同类的行为也一样）成立时，渲染器发 `attach {track_id}`，`track_id` 是这个行为在跟的 `track_surface`；行为结束、被拖放手时发 `attach {track_id: null}`。同一时刻最多一个 attach，新的一条代替旧的。
    - Companion 不认识的 `track_id`（没在跟、已 `gone`、已 untrack）按 `null` 处理。这个跟踪 `gone`、被 `untrack_surface`、连接断开时 attach 随之结束，渲染器不必再发 `null`。
    - above：attach 期间 Companion 在这个 `track_id` 的每条 `tracking` 的 `window` 里带 `above[]`：同一次读取里排在 W 前面、layer 0、alpha > 0、不是 Companion 和渲染器进程的、和她的身体外框外扩 40 pt 相交的窗口的 `frame`（`{x, y, w, h}`，全局点），最多 8 个，从前到后；没有时为空数组。身体外框 = 最近一帧 `hit_capsules` 的外接矩形（全局点）。收到 `attach` 后下一条 `surface` 起带；别的 `track_id` 和不 attach 时不带。
    - 画面：attach 期间渲染器把 `above` 矩形里的那部分画成全透明（`HostOcclusion`）。W 自己不在 `above` 里，搭在 W 边上的手照常画在 W 前面。不 attach 时照常画在所有窗口前面。
    - 命中按规则 1 扣掉 `above`。画面和命中用同一组矩形，可以差一帧。
    - 渲染器不为此改窗口的 level，也不用 `orderWindow:relativeTo:`。
    - attach 期间不判盖住（规则 35）。
    - 取值（规则 21 加）：`above` 最多 8 项，每项 `w`、`h` > 0，坐标照规则 21；`attach.track_id` 最长 64 字节。不合时丢弃这一条、记日志，连接不断。
35. 让开（v15）：
    - 盖她的窗口：前台 app 在规则 31 那次读取里最前的 layer 0 窗口；前台是渲染器或 Companion、或前台 app 没有 layer 0 窗口（例如桌面）时为空。
    - 进入盖住：盖她的窗口的 `frame` 和身体外框（规则 34）相交的面积 ≥ 身体外框面积的 15%，持续 300 ms。离开：< 5%（窗口为空按 0），持续 300 ms。
    - 盖住期间：进入时发 `covered {window_id, generation, frame}`，离开时发 `covered {window_id: null}`。被盖住时她让开、不变淡：Companion 不为盖住发 `set_opacity`。v18：只要角色轮廓仍可见，前台窗口重叠不关闭其点击；窗口视口在鼠标悬浮轮廓期间也不自动隐藏。attach 的真实遮挡仍按规则 34 扣除。
    - 不判：拖动中（`drag` `begin` 到 `end`）、`set_visible`=false 期间、attach 期间。正在盖住时进入这三种状态，按离开处理。
    - 节奏：没有跟踪时每 100 ms 读一次窗口表（只在有胶囊、没隐藏时读）；有跟踪时用规则 32 那次 30 Hz 的读取。
    - 渲染器收到 `set_opacity`：在 `duration_ms` 内把这个值从当前值线性变到 `opacity`（0 时立刻），窗口 alpha 按规则 14 相乘。只改 alpha，不改 `ignoresMouseEvents`。两种视口都适用。
    - 渲染器收到 `covered` 后，找得到空地时以本地行为走过去（不发 C1 回执；位置变了照常发 `placement`，`reason`=`behavior`）；走路关着、正被拖、正 attach、找不到空地时不动。
    - 以后悬停变淡走 `set_opacity`。
    - 取值（规则 21 加）：`opacity` 0.2–1，`duration_ms` 整数 0–2000；`covered` 盖住时三个字段都有，离开时只有 `window_id`=`null`；坐标照规则 21。不合时丢弃这一条、记日志，连接不断。
36. 光标状态（v16）：
    - v18 Metal 宿主注视策略：连接有效且光标位于角色所在显示器时持续跟随，不以 `near`、`hover_ms` 或速度决定注视开关；跨屏返回不必重新悬浮角色，旋转范围和缓动仍交给 procedural 层。以下 `pointer` 指标保留给行为判断。
    - 内容：`speed` 是最近 100 ms 的光标路程除以时长（pt/s），`hover_ms` 是光标停在胶囊上的毫秒数（不在胶囊上为 0），`near` 在光标离胶囊外接矩形 ≤ 120 pt 时变真、> 160 pt 时才变假，这个矩形取最近 1 s 内各次外接矩形的并集，`shake` 是 600 ms 内 x 方向反转 ≥ 4 次；都按全局点算。不带光标位置。
    - 只在值变化时发：和上一条发出的比，`hover_ms`、`near`、`shake` 有一个不同，或 `speed` 差 ≥ 50 pt/s；`speed` 变化小于 50 pt/s 不算变化。连接开始时上一条按 `{speed: 0, hover_ms: 0, near: false, shake: false}` 算。
    - 每秒最多 10 条：和上一条至少隔 100 ms；不到 100 ms 的变化先不发，到时再拿当时的值比。光标停在胶囊上时 `hover_ms` 一直在变，按每秒 10 条发。
    - 渲染器只存最新一条，不据此改穿透和命中。
    - 取值（规则 21 加）：`speed` 有限数 ≥ 0，`hover_ms` 整数 ≥ 0，`near`、`shake` 布尔。不合时丢弃这一条、记日志，连接不断。
37. 管线状态（v17）：
    - 渲染器列了 `pipeline` 才发。内容是宿主此刻实际生效的值，不是 Companion 请求的值：`render` 是解析启动参数后真正用上的渲染设置，`unsupported` 列出被忽略的设置名；`fps.requested` 是最近一条 `fps_tier` 的 `fps`，`fps.target` 是宿主按电池、用户上限算出的目标；`gpu.allocated_mb` 是 GPU 设备当前已分配的显存。
    - 宿主因致命错误要退出时，先发一条 `error` 非空的 `pipeline`，再退出。Companion 在连接断开后保留最后一条，用于监控页显示。
    - Companion 只用它显示状态，不据此改档位或重启。字段不合（缺键、类型不对）时丢弃这一条、记日志，连接不断。
38. 拖入（v21）：
    - 两边都列了 `drop` 才用。渲染器的内容视图接受文件 URL、URL 和字符串的拖入；拖入点在命中胶囊上（规则 1 同一判定，用这一帧的胶囊）时给复制操作，胶囊外给无操作。放下时发一条 `drop`。
    - 点穿的窗口不是拖放目标，而 Companion 在别处按下的按键期间按规则 1 回 `hit`=false。所以按住按键的光标移到胶囊上时渲染器自己停止点穿，拖入悬在胶囊上期间不按 `cursor` 恢复点穿；拖入离开胶囊、放下、结束或左键抬起后，下一条 `cursor` 照旧决定。
    - 每个拖入项取一项：文件 URL 取路径（不打开、不读文件），否则 URL，否则文字。最多 16 项，文字截到 16384 字节（按整字）；整行超过 65536 字节时去掉后面的项，只剩一段文字时把它对半截，直到放得下；有截掉时带 `truncated`=true。一项也放不下时不发。
    - 规则 21 的字符串 256 字节上限不用于 `items`；`items` 按上一条限。不合时丢弃这一条、记日志，连接不断。
    - Companion 只把 `drop` 交给一个回调；之后怎么用不在本合同里。
39. 看向一侧与展示（v22.1）：
    - `attention_side`：渲染器按她的朝向把屏幕一侧换成她自己的一侧（面向镜头时屏幕右侧是她的左手边），播角色包 `look.left` / `look.right`（她自己的左、右）的池：回看的开始、循环停 1.5–3 s、结束。两侧合起来 45 s 内只播一次。没有这个池、坐着、身体被会话链占用或预算用完时，改为只把头和眼睛转向那一侧，同样停 1.5–3 s，同样计入 45 s；不排队、不回执。
    - `present`：`open` 时渲染器播角色包 `present.snap` 的池；面板开着时停在这条链的循环上；收到同一 `token` 的 `close` 时经循环的出口收尾。`open` 时上一条 `present` 的链还在播，换成新的 `token`，不重播。
    - `motion.stroke`：`present` 那条链里每个带 `stroke_s` 的片段，自己的播放时间越过 `stroke_s` 时发一条。时间从这个片段自己开始算，先移到基底的过渡不算。坐着、没有池、播不了或排队后被别的请求顶掉时，立刻发一条，`clip` 为她正在播的片段；Companion 等不到时按自己的超时照常显示或收起。站着被会话链占用时，`present.snap`（interrupt `user`）排在这条链的出口后播。
    - 光标悬停（规则 36 的 `pointer`）：`near`、`hover_ms` ≥ 800 且 `speed` ≤ 100 pt/s 时，渲染器每次悬停最多播一次角色包 `user.hover` 的池，60 s 内只播一次。身体正忙时，指针留在角色身上可在两秒内短暂重试；离开或超时就丢弃，不插队。
    - 取值（规则 21 加）：`token` 最长 64 字节；`kind`、`clip` 照规则 21 最长 256 字节；`generation` 整数 ≥ 0。不合时丢弃这一条、记日志，连接不断。
40. 生成动作请求（v23，dual-motion 阶段 2）：
    - 两边都列了 `motion_requests` 才发。宿主只在生成动作后端下、执行器要一段按它的几何生成的片段时发；同一个行为可以发多条，每条新取 `request_id`。
    - `geometry` 的点都在请求那一刻她的 rig root 系里：左手系，米，+z 她的前方，+x 她的右手，y 从她的地面向上。yaw 是度数，正值转向 +x。各 `kind` 只带下表的键，不多不少：

      | `kind` | `geometry` |
      |---|---|
      | `turn` | `{yaw}`，\|`yaw`\| ≤ 180 |
      | `walk` | `{to: [x, z], end_yaw}` |
      | `window_loop` | `{hips: [x, y, z]}` |
      | `sit_enter`、`sit_loop`、`sit_exit` | `{seat: [x, y, z]}` |
      | `lean` | `{hand: "left" / "right", grip: [x, y, z]}` |

    - 坐标照规则 21 是有限数、绝对值 ≤ 100000。整行（含 `\n`）最多 4096 字节。
    - Companion 不回任何一行。它把这条去掉 `v`、`type` 原样转给 agentd `POST /motions/generate`（ui token），agentd 的回复只记日志，不重试；agentd 不可达时这条丢掉、记日志。结果是 C1 v2.5 的 `event: motion`（同一个 `request_id`），宿主从已连着的 `/events` 收，再用 events token 取 `GET /motions/<id>/meta`、`/keys`、`/tracks`。
    - 回退：事件 `ok` 为 false、请求后 2.5 s（宿主的动作时钟）没收到事件、或文件校验不过，宿主就照现在的执行器用角色包动作片段。等待期间行为保持 `prepared`。
    - 不合时（含超过 4096 字节）丢弃这一条、记日志，连接不断；宿主那边等不到事件，按上一条回退。
41. 让过别的 app 的控件（v24）：
    - 探测：光标在她附近时，Companion 向光标下的那个 app 要这一点的元素（对那个 app 的 AX 元素做 hit-test，不用 system-wide 元素）。它或往上至多 3 层祖先之一是可交互控件时，这个控件的 frame（换成全局点）作为一个让过矩形，保留 2 s；光标停在这个矩形里时每 0.5 s 重新探测一次。
    - 命中：光标在让过矩形里时 `cursor.hit` 为 false（规则 1），只有在她身上开始的按下还按住时除外。不改透明度。
    - 发送：两边都列了 `pass_through` 时，矩形列表变化就发一条 `pass_through`，带当前全部矩形；全部过期时发 `[]`。
    - 渲染器只存最新一条，连接断开时清掉。它自己的指针判定（光标移到胶囊上时按规则 1 同一判定、不等下一条 `cursor` 就开始接点击，含规则 38 的拖入）在让过矩形里永不开始接点击；`cursor` 照旧按规则 2 决定穿透。
    - 取值（规则 21 加）：`rects` 最多 8 项，每项 `w`、`h` > 0，坐标照规则 21。不合时丢弃这一条、记日志，连接不断。
42. 走开，不挡用户正在用的东西（v26）：
    - 发送：两边都列了 `keep_clear` 时，Companion 在矩形碰到她的身体（规则 34 的身体外框）满 1.2 s、键盘静了 1.5 s 后发一条请求，之后 8 s 内不再发（`dialog`、`banner` 不等）。所以渲染器收到就走，不再等。
    - Companion 自己的主窗口（v27）：角色页「设定」打开期间，Companion 把主窗口在屏上的 `frame` 作为一个 `dialog` 矩形交给渲染器，她走到主窗口旁；「设定」关掉、主窗口关闭或缩到程序坞时去掉。线上格式不变。
    - 什么时候走：和规则 35 的 `covered` 同样的条件：全屏视口、有走路数据、没在拖、没被拎起、没在走、拖动结束后 2 s。没有 1.2 s 的停留，也没有 8 s 的冷却。同一个 `id` 只走一次，不走回来。正在走时来的请求等这一趟走完。请求排在等着的 `covered` 窗口前面。
    - 去哪：她身体外框（画出来的大小）离每个和身体外框 y 区间相交的矩形的 x 区间都至少 16 pt、在屏幕夹取之内、离她最近、至少一段短走的锚点 x；y 区间不相交的矩形不算。
    - 没有这样的 x：`kind` 为 `video`、`game` 时，较近一侧的夹取端点至少一段短走远就走过去，然后转向视口的水平中心（有 90° 原地转身时用它，转到侧身 ±90°）；不能转身的角色保持朝前。其他 `kind` 不动。
    - 撤回：`id`=`null` 丢掉还没走的请求；按上一条走到一侧之后，`null` 让她转回朝前。都不走回去。
    - 坐着、扶着窗沿，而且矩形和她的身体外框相交：按用户拖动结束坐、扶的同一条路结束它，C1 回执 `cancelled` / `give_way`（不是 `user_drag`），之后照上面走开。
    - 身体：agentd 在前台全屏时一直放的 `idle`（优先级 3、`full_body`）是原地行为，不占身体，不挡这一趟走，这一趟走也不结束它。
    - 位置变了照常发 `placement`（`reason`=`behavior`），不发 C1 回执。连接断开时渲染器丢掉还没处理的请求，当作一条 `null`。
    - 取值（规则 21 加）：`id` 最长 64 字节；`kind` 只能是上面九种；`rects` 1–8 项，每项 `w`、`h` > 0，坐标照规则 21；`null` 时不带 `kind`、`rects`。不合时丢弃这一条、记日志，连接不断。
43. 即时渲染设置（v27）：
    - 两边都列了 `render_live` 才发。例：`{"v":1,"type":"set_render","req":7,"camera":{"mode":"show","yaw":0,"pitch":0},"light":{"yaw":0,"pitch":0,"strength":1},"outline":"original","facing":"auto","grounding":{"mode":"off"},"ambient":{"mode":"off","light_wrap":false}}`。
    - 组：`camera`、`light`、`outline`、`facing`、`grounding`、`ambient`，至少带一组；组内字段都可选，没带的字段保持现值。
    - 取值同「启动」一节的参数表，数取表里最小到最大之间的值：`camera.mode` `show` / `overview` / `document`，`camera.yaw` −90…180，`camera.pitch` −20…20；`light.yaw` −15…15，`light.pitch` −10…10，`light.strength` 0.5…1.5；`outline` `original` / `subtle` / `contrast`；`facing` `auto` / `front` / `side` / `back`；`grounding.mode` `off` / `contact`（`--agentic-complex-ground-shadow`）；`ambient.mode` `off` / `wallpaper` / `screen`（`--agentic-complex-ambient`），`ambient.light_wrap` 布尔（`--agentic-complex-light-wrap`）。
    - 回执：带 `req` 时渲染器列了 `ack` 就按规则 18 回一条。`invalid`：未知组或组内未知字段、越界、一组都没带、Companion 的 `hello` 没列 `render_live`（同规则 21 丢弃这一条）、待处理的请求已满 16 条；`unsupported`：渲染器做不到这一组（没有 actor）。
    - 生效：从下一个提交帧开始。`camera.yaw`、`camera.pitch`、`light.yaw`、`light.pitch` 和机位切换在 0.4 s 内过渡；描边、朝向、阴影开关立即。之后的 `pipeline.render` 报实际生效值。
    - 滤镜（v27 追加，`filters`）：组 `filter`，字符串，`none` 或 `filter_1`…`filter_8`、`sp_filter_1`…`sp_filter_7`（`--agentic-complex-filter`，Companion 设置 `render_filter`），复刻游戏拍照模式的滤镜。例：`{"v":1,"type":"set_render","req":9,"filter":"sp_filter_2"}`。两边都列了 `filters` 才带这一组，否则按「未知组」回 `invalid`；id 不在渲染器的滤镜资源里也回 `invalid`。立即生效，不过渡。滤镜只改她的颜色，不改桌面和舞台盒背景；`none` 时画面和没有滤镜时相同。`pipeline.render.filter` 报实际生效的 id。
    - 景深（v27 追加，`photo`）：组 `dof`，`{mode}`，`mode` 为 `off` 或 `closeup`（`--agentic-complex-dof`，Companion 设置 `render_dof`），持久设置：`closeup` 时镜头处于近景时按 f/2.8 对焦到她头部关节、虚化她身上离焦的部分，全身景别下不虚化。组 `photo`，`{active, aperture, focus}`，拍照面板的临时状态，不持久：`active` 布尔，面板关时为 `false`；`aperture` f 值 1.4…32，32 表示不虚化；`focus` 为 `"auto"`（对焦到头部关节在相机空间沿视轴的距离）或 0.1…10（米）。`photo.active` 为 `true` 且 `aperture` < 32 时按面板的光圈、对焦虚化，不论景别；否则按 `dof`。例：`{"v":1,"type":"set_render","req":8,"dof":{"mode":"closeup"}}`、`{"v":1,"type":"set_render","req":9,"photo":{"active":true,"aperture":2.8,"focus":"auto"}}`。两边都列了 `photo` 才带这两组，否则按「未知组」回 `invalid`；越界回 `invalid`。开关从渲染器准备好的那一帧起生效，不过渡；关时画面和没有景深时相同。`pipeline.render.dof`、`pipeline.render.photo` 报实际生效的 `mode`、`active`。
    - 不合时丢弃这一条、记日志，连接不断。
44. 环境取色（v27）：
    - 两边都列了 `ambient` 且 Companion 设置 `render_ambient` 不为 off 时才发；不带 `req`，不回 `ack`；最多 2 Hz。例：`{"v":1,"type":"ambient_sample","source":"screen","colors":{"mean":[0.42,0.40,0.38],"top":[0.5,0.5,0.52],"bottom":[0.3,0.3,0.3],"left":[0.4,0.4,0.4],"right":[0.45,0.44,0.4]}}`。
    - `source`：颜色从哪来，`screen`（屏幕）、`wallpaper`（壁纸）或 `appearance`（系统外观）。
    - `colors`：正好 `mean`、`top`、`bottom`、`left`、`right` 五个键，每个是 3 个线性 sRGB 的有限数，0–1，最多 3 位小数。不带图像和窗口信息。
    - 渲染器只留最新一条。
    - 不合时丢弃这一条、记日志，连接不断。
45. 触摸（v27，`touch`）：
    - (a) 区域：`head_top`、`head`、`face`、`cheek_l`、`cheek_r`、`hair`、`accessory`、`chest`、`waist`、`arm`、`hand_l`、`hand_r`、`leg`、`skirt`、`body`，共 15 个；左右以她自己为准。
    - (b) 退回链：`cheek_l` / `cheek_r` → `click.cheek` → `click.face`，`head_top` → `click.head`，`hand_l` / `hand_r` → `click.hand`；事件键可以带 `@姿态`。
    - (c) 摸头：`pat` 为 true 时，光标不按键、在 `head_top` 上来回划动，渲染器播 `pat.head` 的循环，停手后走出口段；阈值属于渲染器内部行为，不上线。
    - (d) 捏脸见规则 3。
    - (e) 迎接：`greet` 为 true 时，一次系统暂停结束、提交第一帧时，播 `user.greet`，没有这个池就播 `character.enter`；两次至少隔 600 s。系统暂停指 `fps_tier`=`paused` 并且没有被 `set_visible` 隐藏，或者系统睡眠、屏幕睡眠、会话不活跃，持续 ≥ 5 s。
    - (f) 收到 `touch_settings` 之前、连接断开以后，四项都按 false。
    - (g) 限制：`region` 1–32 字节；`touch_settings` 缺字段或字段不是布尔时，丢弃这一条、记日志，连接不断。
46. 服装分层（v27，`layers`）：
    - (a) 报：角色包有 `layers` 时，渲染器在 `hello`、`character_changed` 里带上 `layers` 和 `hidden_layers`（见「分层列表」）；没有就两样都不带。
    - (b) 回复：每条 `set_layers` 渲染器都回且只回一条 `layers_changed` 或 `layers_change_failed`。新请求顶掉还没完成的旧请求，旧的回 `superseded`；切换角色期间（从收到 `set_character` 到回复它之前）回 `switching`；含未知 `id` 时回 `unknown_layer`，隐藏集合不变；其他失败回 `load_failed`。
    - (c) 画面：从下一帧起，被隐藏的层的网格不画，不淡出淡入；`hit_capsules.visual` 跟着变。
    - (d) 归属：隐藏集合属于当前角色。`set_appearance` 时保留，渲染器按新外观重算；某层的 `appearances` 不含当前外观时，这层不起作用。
    - (e) 切换角色：`set_character` 带 `hidden_layers` 时，新角色加载时就按它画；未知 `id` 丢弃并打日志；实际生效的集合由 `character_changed` 报告。`--agentic-complex-hidden-layers` 同理，由 `hello` 报告。
    - (f) 超时和记忆：Companion 发出 `set_layers` 后 10 s 收不到回复，按失败处理。Companion 只在收到 `layers_changed`，或 `hello` / `character_changed` 报了 `hidden_layers` 时更新这个角色的记忆。
    - (g) 协商：两边的 `hello` 都列了 `layers`，Companion 才发 `set_layers`。
    - (h) 取值（规则 21 加）：`layers` 最多 16 项；`id` 符合 `^[a-z][a-z0-9_]{0,31}$`；`name` 1–64 字节；`hidden`、`hidden_layers` 最多 16 项、不重复；`reason` 只能是 (b) 的四种；外观条目的 `kind` 只能是 `original` / `imported`，`desc` ≤ 200 字节。不合时丢弃这一条、记日志，连接不断。
47. 姿态（v27，`poses`）：
    - (a) 清单：姿态清单就是 `actions` 里带 `pose` 的动作行；Companion 不另建清单。
    - (b) 进入：`set_pose` 带 `id` 时，渲染器按这一行自己的执行方式进入（clip 链、seat、scene，和 `play_action` 一样），并保持到释放。
    - (c) 释放：`id`=`null` 时走这一行的出口段，回到自动。
    - (d) 锁定：`lock`=true 时，姿态保持期间身体归用户，agent 不能让她走动或坐下：C1 需要身体的行为回执 `rejected`、reason `busy`（C1 v2 §3），`play_action` 也回 `rejected` / `busy`；拖动和拎起照常，落地后重新进入这个姿态。
    - (e) 不锁定：`lock`=false 时，任何新意图（C1 行为、`play_action`、拖动）都会顶掉姿态，之后发一条 `pose_state`，`id` 为 `null`。
    - (f) 切换角色：姿态清空；新角色的 `actions` 到达后，由 Companion 按自己的配置恢复锁定。
    - (g) 限制（规则 21 加）：`id` ≤ 64 字节，`pose` 只能取 `stand` / `akimbo` / `sit` / `floor` / `lie` 之一。不合时丢弃这一条、记日志，连接不断。
49. 自由镜头和相机轨（v27，`camera_free`、`camera_track`）：
    - (a) 字段：`set_render.camera` 的新可选字段，`zoom`（数，1…4，绕头部放大她的画面，相机不动；1 = 不放大）、`sway`（布尔，脚在可见区外时轻微晃动）、`closeup`（布尔，对话近景请求；false 回到 `zoom`）、`live`（布尔，缺省 false：这一条来自正在拖的手势，`yaw`、`pitch`、`zoom` 用短跟随，不走规则 43 的 0.4 s 过渡）、`track`（`"off"` / `"stage"`，带相机轨的动作怎么播）。例：`{"v":1,"type":"set_render","camera":{"yaw":-135,"pitch":8,"zoom":2.2,"live":true}}`。
    - (b) 门控：两边都列了 `camera_free` 才发 `zoom`、`sway`、`closeup`、`live`；两边都列了 `camera_track` 才发 `track`；否则按规则 43 的「组内未知字段」回 `invalid`。`camera.yaw` 的 −180…−90 只在两边都列了 `camera_free` 时合法，否则仍是 −90…180。
    - (c) 放大或近景期间：渲染器不开始要身体的行为（C1 回执 `rejected` / `busy`，优先级 3 除外），不让路走动，不自发转身。被拖动、`keep_clear` 让路、来了优先级 3 的行为时，先缩回 1 再做，做完回到原来的放大。坐窗、扶窗沿、拖动中收到 `closeup`=true 时，等身体空下来再放大。
    - (d) `track`=`stage`：播 `media.camera`=true 的动作期间，窗口取舞台框，相机按相机轨逐帧取，时钟和动作、音乐同一个；结束或被打断就回到桌面镜头。`track`=`off`：照旧，不播相机轨。
    - (e) 上报：`pipeline.render.camera` 的 v27 可选键加 `zoom`、`sway`、`closeup`（`"off"` / `"active"` / `"deferred"`）、`closeup_zoom`（数，1…4，宿主按她当前姿态算出的近景倍数，给镜头模式的「近景」按钮用）、`track`、`stage`（布尔：当前是否在舞台里播），都是实际生效值。
    - (f) 不改的部分：规则 43 的回执、队列上限 16、`camera.mode` 和 `camera.pitch` 的取值。
    - (g) 不合时丢弃这一条、记日志，连接不断。
    - (h) 直接手势（`camera_gesture`）：两边都列了 `camera_gesture` 时，在她身上（命中测试同左键按下）按下左键时按着 ⌘，或者在展示台里（`--agentic-complex-scene-stage` 生效）不按修饰键，之后的拖动不发 `drag`、不搬动她，改发 `camera_gesture`；按着 ⌘ 的滚轮和触控板捏合（不需要 ⌘）也发。不带修饰键的滚轮仍不处理；⌘ 单击照旧是单击。一个手势是一条 `began`、若干 `changed`、一条 `ended`，拖动和缩放重叠时算同一个手势；三条都带 `dx`、`dy`、`zoom`，`began`、`ended` 不带位移（0、0、1）。拖动的 `dx`、`dy` 是光标位移（右、下为正）；滚轮的 `zoom` 按镜头模式的换算取 `exp(0.01 × 点数)`（一格按 10 点，向上滚放大），捏合取 `1 + magnification`；滚轮的惯性不算，停 0.3 s 没有下一格就发 `ended`。Companion 按镜头模式拖动、缩放的换算把它们加到当前的 yaw、pitch、zoom 上：`changed` 发 `live`=true 的 `set_render.camera`，`ended` 像镜头模式的「完成」一样保存，再发不带 `live` 的 `set_render`；镜头模式开着时忽略。例：`{"v":1,"type":"camera_gesture","phase":"changed","dx":12.5,"dy":-3,"zoom":1}`。不合时（`phase` 不在三者里、位移越界、`zoom` ≤ 0）丢弃这一条、记日志，连接不断。
    - (i) 半身固定（`camera_bust`）：两边都列了 `camera_bust` 才发 `set_render.camera.framing`（`"full"` / `"bust"`，缺省 `"full"`），否则按规则 43 的「组内未知字段」回 `invalid`；渲染器只在全屏视口、有 actor 时列（和 `camera_free` 一起）。启动参数 `--agentic-complex-camera-framing full|bust`，不传为 `full`。`bust` 生效那一刻锁定倍数（站姿胸到头顶跨度占她站姿高度的约 0.8，再乘 `zoom`，夹 1…4）、中心（头部，之后约 2 s 时间常数慢跟随）和裁切线（站姿胸点往下约到髋部）；头顶夹在屏内。期间：(c) 的门控不缩回，`closeup`、`sway` 不生效；裁切线以下不画、不算命中，`capsules` 和可见矩形按裁切线截掉；要身体的 C1 行为不论优先级都回 `rejected` / `busy`；只播起止都是站姿的片段（必播片段除外），姿态不是站姿的 `set_pose` 回 `ack` `busy`；拖动只平移，不拎起、不下落；不自发转身，保持正面。`pipeline.render.camera` 两边都列了 `camera_bust` 时带 `framing`（实际生效值）。例：`{"v":1,"type":"set_render","req":5,"camera":{"framing":"bust"}}`。
50. 截图（v27，`capture`）：
    - (a) 协商：两边都列了 `capture` 才发 `capture`；渲染器只在有 `--agentic-complex-capture-dir`、有 actor 时列。例：`{"v":1,"type":"capture","req":12,"background":"transparent"}`。
    - (b) 回执：渲染器截请求之后提交的第一帧，PNG 文件写完之后才回 `ack` `ok`=true，接着发同一 `req` 的 `captured`。不成时只回 `ack` `ok`=false、不发 `captured`：没有 actor 回 `unsupported`；Companion 本版只发 `transparent`，渲染器收到别的字符串（如留给以后的 `"stage"`）也回 `unsupported`；上一张还没写完回 `busy`；截取或写盘失败回 `failed`；Companion 的 `hello` 没列 `capture` 回 `invalid`（同规则 21）。
    - (c) 文件：只写进 `--agentic-complex-capture-dir` 给的目录；文件名由渲染器生成（`Endfield-<角色>-<yyyyMMdd-HHmmss>.png`，重名时加 `-2`、`-3`），Companion 不传文件名或路径；先写临时文件，写完再改名，所以目录里不会出现写了一半的 `.png`。`captured.file` 只是文件名，不含目录。
    - (d) 画面：透明背景（舞台盒背景不在里面）；尺寸是当前输出分辨率（`width`、`height`）；sRGB、非预乘 alpha；按 opacity 1 画，不跟 `set_opacity` 和淡出；不做遮挡清零，被窗口盖住的部分也在。描边、接地阴影、边缘光、滤镜同屏上那一帧。
    - (e) 截图那一帧屏上的画面不变。
    - (f) 不合时（没带 `req`、字段不合）丢弃这一条、记日志，连接不断。
51. 动作覆盖（v27，`motion_overrides`）：
    - (a) 键：都按当前角色包的 `animation/motion-graph.json`（`endfield-motion-graph/v1`）。链 key 是 `chains` 的键，即这条链起头片段的 clip 名；池 key 是 `clips[].uses[]` 里 `type` 为 `event`、`tier` 的项的 `key`（事件键原样，可带 `@姿态`，如 `session.thinking`、`rest.sleep@sit`；待机档 `idle.t<N>`）。活动、意图、说话手势的池不能覆盖（活动和意图的名字会重名，如 `think`），给了回 `unknown_pool`；clip 名是 `clips[].name`。
    - (b) 存放和何时发：照规则 28。Companion 按角色存用户选的覆盖（config.json 的 `motion_overrides`：`{角色 id: {chains, pools, blend_in}}`），存的是用户选的，不是渲染器改过的。收到某个角色的 `actions`（不带 `error`）、用户配置里这个角色的覆盖不为空时发一次；用户保存时发一次。不重试。渲染器不落盘；连接断开、重启或切换角色后按角色包，直到收到 `set_motion_overrides`。
    - (c) 整份替换：每条带这个角色的全部覆盖，替换上一条；`chains`、`pools`、`blend_in` 为 `{}` 表示这一类不覆盖，三个都为 `{}` 即清除。表里没有的链、池、clip 照角色包。
    - (d) 链：`false` 只把这条链的起头片段放进停用集合，和规则 28 动作开关停用的片段取并集；链上别的片段（循环、收尾、站姿，可能和别的链共用）不停用。池子抽到停用的片段时跳过，和动作开关一样。`true` 不因本表停用，但不会让不在任何池里的链被抽到；要被抽到，把起头片段放进池子。基础站姿、桥接和绑定（`uses[].type` 为 `base`、`bridge`、`binding`）的片段不能关，不采用，`reason`=`required`。不是任何链的起头时 `reason`=`unknown_chain`。规则 52 和 `play_action` 照样能播关掉的链。
    - (e) 池子：整池替换，这个池 key 的池子就是请求里的这些 `clip` 和 `weight`（相对权重），不和角色包的合并。渲染器先逐项校验，有一项不过就不采用这个池（保持角色包的池子），在 `adjusted` 里写一条，`reason` 取第一项不过的原因：`unknown_pool`（角色包没有这个池）、`unknown_clip`（clip 不在角色的动作 archive 里）、`excluded_family`（起头或收尾所在的姿势族在排除名单 `runtime.excluded_families` 里）、`no_return`（从这个 clip 起的链最后没回到基础站姿）、`stance_mismatch`（链起头的站姿和池子的不一致：池 key 带 `@姿态` 时取它，待机档取档位的站姿，其余为站）。
    - (f) 混合：`blend_in` 的秒数覆盖角色包里进入这个 clip 的混合时长（`ActorMotionPolicy.blendIn`），0 为硬切；其余混合规则不变。clip 不在 archive 里时不采用，`reason`=`unknown_clip`。
    - (g) 回执：渲染器先回 `ack`。`ok`=false 时不应用、不发 `motion_overrides`：字段不合、超过 (j) 的上限、`character` 不是当前角色、Companion 的 `hello` 没列 `motion_overrides` 回 `invalid`；切换角色进行中（从收到 `set_character` 到回复它）或清单还没就绪回 `busy`；没有 actor 回 `unsupported`。`ok`=true 后发同一 `req` 的 `motion_overrides`：`applied` 是三类各采用的项数，`adjusted` 是没采用的每一项（一个池一条）；每一类的 `applied` 加上 `adjusted` 里这一类的条数等于请求里这一类的项数。`motion_overrides` 整行会超过 65536 字节时，渲染器从 `adjusted` 尾部去掉条目直到放得下，并加 `"truncated": true`；`applied` 不变，这时上面的等式不成立。
    - (h) 生效：下一次挑选动作起生效；正在播的不打断，不重启。
    - (i) Companion 等 `motion_overrides` 最多 2 s。保存的结果以 `applied`、`adjusted` 为准，和用户选的不同处由 ui 显示。超时或 `ack` `ok`=false 时，保存按失败报给 ui，用户配置照样写入。
    - (j) 取值和数量限制（规则 21 加）：`chains` 最多 512 项，值是布尔；`pools` 最多 64 个池，每池 1–64 项，同一池里 `clip` 不重复，`weight` 是整数，1–100000；`blend_in` 最多 512 项，值是有限数，0–2；链 key、池 key、clip 名、`adjusted[].key` 都是 1–128 字节的字符串；`adjusted[].kind` 只能是 `chain` / `pool` / `blend_in`，`reason` 只能是 (d)–(f) 里这一类的那几种。任何一处超限或不合，整条回 `invalid`，什么都不应用。上限内的整份也可能超过一行 65536 字节：Companion 发不下时不发，保存按失败报给 ui。
52. 按链播放（v27，`play_chain`）：
    - (a) 播什么：渲染器从 `start` 起走这条链，走法同 `ActorMotionPolicy.chain`（也是 motion-graph.json 的 `chains[start]`：有源自带的返回就走它，否则走 `next`，持续循环之后接它的出口），走完回到基础站姿；速率 `speed`。持续循环（`held`）播一圈就走出口，不等请求结束；带 `hold_seconds` 的循环按它。
    - (b) 回执：先回 `ack`。`ok`=false 时不播、不发 `action_played`：字段不合、Companion 的 `hello` 没列 `play_chain` 回 `invalid`；没有 actor 回 `unsupported`。`ok`=true 后照规则 29 发 `action_played`，`id` 和 `chain` 都是 `start`；不另造回执。
    - (c) 其余同规则 29：身体忙、`rejected` 和 `interrupted` 的 `reason`、开始等待的 30 s 期限、Companion 等第一条最多 35 s、同一条链再来一条时接着当前进度播、断线补记。`unknown_action` 表示 `start` 不是角色包里任何一条链的起头；`missing` 表示链上有片段缺资源；`not_playable` 表示链上有走路段。规则 51 关掉的链也能播。`play_chain` 和 `play_action` 互相顶掉，旧的回 `interrupted`、`reason`=`superseded`。
    - (d) 取值（规则 21 加）：`play_id` 最长 64 字节；`start` 1–128 字节；`speed` 只能是 0.5、1、2，缺省 1。不合时回 `ack` `invalid`、丢弃这一条、记日志，连接不断。
53. mod 运行时开关（v27，`mod_settings`）：
    - (a) 表：开关表在角色包里，按外观分组（开关 id、每个开关可取的整数值和默认值，见 protocol/character-library 的「mod 设置」），不在线上传；只有带表的外观才有 mod 设置。例：`{"v":1,"type":"set_mod_settings","req":21,"character":"birch","appearance":"mod_1a2b3c4d","values":{"coat":1,"color":2}}`。
    - (b) 回执：渲染器先回 `ack`。`ok`=false 时值不变、不发 `mod_settings`：字段不合、超过 (h) 的上限、`character` 不是当前角色、这个外观没有表、开关 id 未知、取值不在这个开关的表里、Companion 的 `hello` 没列 `mod_settings` 回 `invalid`；切换角色进行中（从收到 `set_character` 到回复它）回 `busy`；没有 actor 回 `unsupported`。`ok`=true 后发同一 `req` 的 `mod_settings`。
    - (c) 整份替换和回报：每条带这个外观的全部选择，替换上一条；表里有、请求里没给的开关取表的默认值，`{}` 表示全部回到默认。`mod_settings.values` 是这个外观全部开关的实际生效值；请求里没给而取默认值的开关在 `adjusted` 里记 `defaulted`，渲染器画不出所选取值、改按默认值画的记 `unsupported`；都没有时不带 `adjusted`。
    - (d) 非当前外观：`appearance` 可以不是当前外观。渲染器在本进程内记下（不落盘），以后 `set_appearance` 换到这个外观时，同一帧就按记下的值画，不先画一帧默认值。
    - (e) 画面和自报：当前外观的值从下一帧起生效，不淡入淡出，不重载角色；`hit_capsules.visual` 和窗口包络不随开关变化。`hello`、`character_changed`、`appearance_changed` 之后，当前外观带表时渲染器发一条 `req` 为 `null` 的 `mod_settings`。
    - (f) 切换角色和启动：`set_character` 带 `mod_settings` 时，新角色加载时就按它画各外观；`--agentic-complex-mod-settings` 同理，用于启动的角色。未知的外观、开关或取值逐项丢弃并打日志，不回 `ack`；实际生效值由 (e) 的自报报告。
    - (g) 记忆和协商：Companion 按角色、外观存用户选的值（config.json 的 `mod_settings`：`{角色 id: {外观 id: {开关 id: 整数}}}`）。两边的 `hello` 都列了 `mod_settings` 才发；否则渲染器一律按表的默认值画。Companion 等 `mod_settings` 最多 2 s，超时或 `ack` `ok`=false 时按失败报给 ui。
    - (h) 取值（规则 21 加）：开关 id 符合 `^[a-z][a-z0-9_]{0,31}$`；取值是 0–255 的整数；`appearance` 1–64 字节；每个外观（`values`、`set_character.mod_settings` 的每一项、`--agentic-complex-mod-settings` 的每一项）最多 64 个开关；`adjusted` 最多 64 项，`reason` 只能是 `defaulted` / `unsupported`；整行（含 `\n`）最多 65536 字节，`--agentic-complex-mod-settings` 的值也最多 65536 字节。`set_mod_settings`、`mod_settings` 不合时（`set_mod_settings` 先回 `ack` `invalid`）丢弃这一条、记日志，连接不断；`set_character.mod_settings` 不合时只丢弃这个字段、记日志，切换照规则 14。
54. 播放状态（v27，C1 v2.7）：
    - 发送：两边都列了 `behavior_receipt` 时，渲染器只在片段边界发 `motion_state`：C1 `perform` 的片段和按 C1 snapshot `reactions` 本地挑的反应片段（`origin`=`local`、`behavior_id`=`null`）。当前姿势的默认休息循环不发。
    - `phase`：`started`，片段第一次参与提交的帧；`cycle_end`，循环片段走完一圈（这一圈之后被替换时不发 `cycle_end`，发 `ended`）；`ended`，不循环的片段播完，或片段被替换、被取消（`fade_out` 时淡完）而结束；`expired`，C1 `ttl_s` 内没有续期或 `expires_at_ms` 到了，渲染器丢掉这条行为、回到默认休息循环；`rejected`，片段不可播（角色包没有这条片段）。
    - 替换：同一层上换片段时，先发旧片段的 `ended`，再发新片段的 `started`。C1 的续期（同一层、同一载荷）不发 `ended`、`started`，之后的 `motion_state` 带新的 `behavior_id`。
    - `resting`、`busy` 是这个边界之后的身体状态：`resting` 为 true 时基础层播的是休息循环（循环的 base `perform` 或默认休息循环），叠加层空着；`busy` 为 true 时还有一次性片段在播（不循环的 base `perform`、叠加层片段或本地反应）。
    - 转发：Companion 和规则 25 的回执一样，把每条 `motion_state` 原样（去掉 `v`、`type`）按收到的顺序转给 agentd；agentd 的回复只记日志，不重试；agentd 不可达时这条丢掉、记日志。
    - 限额：`motion_state` 和 `behavior_receipt` 合计一秒超过 20 条时，Companion 丢掉超出的 `motion_state`、记日志，终态回执照规则 25 一律转发，连接不断。
    - 取值（规则 21 加）：字段见「消息：渲染器 → Companion」；不合时丢弃这一条、记日志，连接不断。
55. 反应计数（v27，`reactions`）：
    - 发送：Companion 的 `hello` 列了 `reactions` 时，渲染器在她开始一次反应时发一条 `reaction`：`pat` 是规则 45 (c) 的摸头，每划一下一条；`pinch` 是规则 3 的捏脸，每抓一次一条；`greet` 是规则 45 (e) 的迎接，每播一次一条。没列时不发。例：`{"v":1,"type":"reaction","trigger":"pat"}`。
    - 时刻：消息不带时刻，Companion 收到时就是这次反应的时刻。
    - 转发：Companion 把每条 `reaction` 的 `trigger` 作为 `kind` 转给 agentd `POST /interaction/record`（C6，`{"kind": "pat"}`）；另外渲染器的每条 `drag` `begin` 转一条 `drag`，每次她身上的右键（规则 10 的 `button`=`right`，弹出角色菜单）转一条 `wheel`，走同一个端点。agentd 的回复只记日志，不重试；agentd 不可达时这条丢掉、记日志。
    - 取值（规则 21 加）：只有 `v`、`type`、`trigger` 三个键，`trigger` 只能是 `pat`、`pinch`、`greet` 之一。Companion 没列 `reactions` 时收到的、或不合的，丢弃这一条、记日志，连接不断。

## 样例与校验

- `examples/avatar-to-companion.ndjson`、`examples/companion-to-avatar.ndjson`：两个方向各一段完整会话。
- `examples/invalid/`：每个文件一行，各违反一条规则，文件名前缀 `a2c-` / `c2a-` 表示方向。v15 的能力类坏样例是两行：先一条没列这项能力的 `hello`，再那条消息。`validate.py` 见过 `hello` 之后，按它的 `capabilities` 查 `attach`（`layering`）、`set_opacity` 和 `covered`（`opacity`）、带 `above` 的 `surface`（`layering`），v16 的 `pointer`（`pointer`），v21 的 `drop`（`drop`）。v22.1 的 `attention_side`、`present`、`motion.stroke` 不需要能力。v23 的 `motion_request` 查 `motion_requests`；`examples/avatar-to-companion-v23.ndjson` 是合法会话，`a2c-motion-request-*` 是坏样例（超过 4096 字节的那条用空白撑长）。v24 的 `pass_through` 查 `pass_through`；`examples/companion-to-avatar-v22.1.ndjson` 里有一条合法的，`c2a-pass-through-*` 是坏样例。v26 的 `keep_clear` 查 `keep_clear`；同一个文件里有合法的请求和 `null`，`c2a-keep-clear-*` 是坏样例。v27 的 `set_render` 查 `render_live`、`ambient_sample` 查 `ambient`；`examples/companion-to-avatar-v27.ndjson`、`examples/avatar-to-companion-v27.ndjson` 是合法会话，`c2a-set-render-*`、`c2a-ambient-*` 是坏样例。v27 的 `touch_settings` 和带 `region` 的 `click` 查 `touch`；`examples/companion-to-avatar-touch.ndjson`、`examples/avatar-to-companion-touch.ndjson` 是合法会话，`c2a-touch-settings-*`、`a2c-click-region-*` 是坏样例。`a2c-click-region-without-capability` 在 `hello` 和 `click` 之间多一条 `window_frame`：Companion 没有窗口位置时会先丢弃 `click`。v27 的 `stop_action` 和带 `loop` 的 `play_action` 查 `action_loop`，带 `media` 的 `actions` 查 `motion_media`；`examples/companion-to-avatar-motion-media.ndjson`、`examples/avatar-to-companion-motion-media.ndjson` 是合法会话，`c2a-play-action-loop-*`、`c2a-stop-action-*`、`a2c-actions-media-*` 是坏样例。v27 的 `set_pose`、`pose_state` 和带 `pose` 的 `actions` 查 `poses`；`examples/companion-to-avatar-poses.ndjson`、`examples/avatar-to-companion-poses.ndjson` 是合法会话，`c2a-set-pose-*`、`a2c-pose-state-*`、`a2c-actions-bad-pose` 是坏样例。v27 规则 49：`set_render.camera` 带 `zoom`、`sway`、`closeup`、`live` 或 `yaw` < −90 时查 `camera_free`，带 `track` 时查 `camera_track`；`examples/companion-to-avatar-v27-camera.ndjson`、`examples/avatar-to-companion-v27-camera.ndjson` 是合法会话，`c2a-set-render-zoom-range`、`c2a-set-render-closeup-without-capability`、`c2a-set-render-yaw-without-camera-free` 是坏样例。规则 49 (h) 的 `camera_gesture` 查 `camera_gesture`；`examples/avatar-to-companion-v27.ndjson` 里有一个合法的手势，`a2c-camera-gesture-*` 是坏样例。v27 的 `set_render.filter` 查 `filters`，`capture`、`captured` 查 `capture`（规则 43、50）；`examples/companion-to-avatar-v27-look.ndjson` 是合法会话，`c2a-set-render-bad-filter`、`c2a-capture-without-capability` 是坏样例。v27 的 `set_render.dof`、`set_render.photo` 查 `photo`（规则 43）；`examples/companion-to-avatar-v27.ndjson` 里有合法的，`c2a-set-render-bad-aperture`、`c2a-set-render-photo-without-capability` 是坏样例。v27 的 `set_motion_overrides`、`motion_overrides` 查 `motion_overrides`，`play_chain` 和带 `chain` 的 `action_played` 查 `play_chain`（规则 51、52）；`examples/companion-to-avatar-v27.ndjson`、`examples/avatar-to-companion-v27.ndjson` 里有合法的，`c2a-set-motion-overrides-*`、`a2c-motion-overrides-*`、`c2a-play-chain-*`、`a2c-action-played-chain-*` 是坏样例。v27 的 `set_mod_settings` 和带 `mod_settings` 的 `set_character` 查 `mod_settings`（规则 53）；`examples/companion-to-avatar-v27-mod.ndjson` 是合法会话，`c2a-set-mod-settings-*`、`c2a-set-character-mod-settings-*` 是坏样例。`--agentic-complex-mod-settings` 的值由 `validate.check_mod_settings_arg` 查。
- `examples/pending/`：一侧还没实现的规则的样例放这里，不在宿主连接测试（本机工具 `run_host_link.sh`，不在公开仓库）和 Companion 的 `HostLinkC3ExamplesTests` 扫描的位置；两侧都实现之后移到 `examples/`、`examples/invalid/`。现在放着规则 54 和规则 25 新 reason 的样例：`pending/avatar-to-companion-motion-state.ndjson`、`pending/avatar-to-companion-cancel-reasons.ndjson` 是合法会话，`pending/invalid/a2c-motion-state-*` 是坏样例；还有规则 55 的 `pending/avatar-to-companion-reactions.ndjson`（合法会话）和 `pending/invalid/a2c-reaction-*`（坏样例）。`reaction` 的能力由 Companion 的 `hello` 列，单方向的 a2c 会话里没有它，`validate.py` 不查这一项的能力，只查字段。
- `python3 -I validate.py`：合法样例（含 `pending/`）全部通过、坏样例（含 `pending/invalid/`）全部被拒时退出 0。
- `python3 -I validate.py --direction a2c|c2a <录下的会话.ndjson>...`：校验实际录到的会话（冒烟用）。


### 角色行为能力（Metal，v13 actions 的可选扩展）

`actions` 可携带 `behavior_capabilities`：最多 16 项的对象，键为行为标识（非空，最多 64 UTF-8 字节），值为 `null`（角色具备执行数据）或具体不可用原因（非空，最多 512 UTF-8 字节）。Windows 渲染器的 `actions` 不带这个字段；省略整个字段表示渲染器没有报告，不能推断为全部不可用。能力描述角色资源和执行器，不替代用户开关、全屏条件、窗口空间与身体仲裁。

2026-10-29 增加 `attend_session@user`：无窗口时，仅 eyes/head 原地看向用户所需的角色包里的 gaze 控件。
这项不表示有窗口移动/跟随能力；原有 `attend_session` 含义不变。没有面控的角色应报告具体不可用原因。

当前键为 `short_walk`、`auto_facing`、`observe`、`attend_session`、`sit`、`sit@window`、`hold_window_edge`、`fullscreen_give_way`、`climb_window_top`。普通坐姿和窗口坐姿分别报告。角色页显示报告；Companion 将实际加载角色的报告经 UI 鉴权的 `PUT /behavior/capabilities` 转给 agentd。请求为 `{character_id, capabilities}`，旧角色返回 409；agentd 据此过滤所有调度入口，并在切换角色时清除旧报告和 unsupported 冷却。能力不会覆盖持久化的行为开关。C1 执行回执继续使用现有 `unsupported` / `path_blocked` / `no_room` 等原因。

### Optional presentation capability

Both peers advertise `presentation` before exchanging `get_presentation`,
`set_presentation` and `presentation_state`. This extension is role scoped and
never changes body position, playback speed or render-target resolution.

`get_presentation` takes `character` and a nonnegative `req`. `set_presentation`
also takes at least one of these inputs:

- `weather`: `{condition: "clear" | "rain" | "snow", intensity: 0...1,
  wetness?: 0...1, snow?: 0...1}`. Clear requires zero intensity.
- `expression`: `{pose: exact_original_pose_name | null, weight?: 0...1}`.
  Null explicitly releases the expression. The state lists adaptable poses.
- `face_effect`: `{index: 0...3, blend: 0...1}`, the original emotion atlas cell.
- `facial_animation`: `{id: exact_original_timeline_id | null, rate?: 0.5...2,
  weight?: 0...1}`. Null releases the active timeline through its exit blend.
  Original named control curves use the role's face-control contract and remain
  separate from the speaking mouth owner. Interruption blends from the visible
  sample; loading and identity checks finish before ownership changes.

An optional `valid_for_seconds` bounds weather ownership to 1...3600 seconds
(default 900). Expiry requests clear weather; surface moisture and snow then
fade according to the desktop response policy. Weather providers map their
condition codes and intensity units before calling this interface; no location
or network provider is selected by the renderer.

`presentation_state` includes `req`, `character`, `phase`, `expressions`, current
`expression`, `weather_supported`, `face_effect_supported`, and normalized
`coverage: {drops, wetness, snow}`. `phase: "applied"` requires the actual submitted
`frame`; validation or acceptance alone never produces this receipt. Rejections
have `phase: "rejected"` and a reason. A newer request supersedes an unsubmitted
request explicitly. `phase: "state"` answers a read.

The optional `facial_animations` list contains compatible timeline identifiers,
original names and durations. `facial_animation` reports the current identifier,
sample time and completion state. Body/composite clocks and the independent App
preview never change in response to a facial request. The App preview uses a
private XPC service and two GPU-shared IOSurfaces, not this desktop control channel.

The current original surface ABI is hash bound to the C7 role package. A missing
contract rejects unsupported surface updates. Scene precipitation separately
requires the optional original-weather-particles contract and precompiled shader
variants; surface support alone does not imply atmospheric particles or world
collision support.

## 附录：预览 XPC（v25）

App 角色页里的预览（`app/electron/src/main/preview/`）不走上面的 socket，而是连一个私有 XPC 服务。服务端用 `private/renderer/preview/Sources/PreviewTransport/PreviewTransport.m`，客户端是 `app/electron/native/mac/preview.m`（同一套线上格式）；服务端是 `private/renderer/host/Sources/MetalAvatarHost/App/HostPreview.swift`。服务端只渲染，不建桌面窗口、不连 C3 socket、不做放置、输入监视和语音。

- 服务名：`<Companion 的 bundle id>.preview`（`protocol/ids.json` 的 `preview_xpc_suffix`；取不到 bundle id 时用 `local.agenticcomplex.companion`）。打包时把 `metal-avatar-host` 复制为 `Contents/XPCServices/<bundle id>.preview.xpc/Contents/MacOS/AgenticComplexMetalPreview`，它的 Info.plist 带 `AgenticComplexPreviewService=true` 和 `XPCService={ServiceType=Application, RunLoopType=dispatch_main}`。渲染器见到这个 Info.plist 键就进入预览服务模式（`--describe` 仍先处理）。
- 消息：XPC 字典，键 `json` 是 C 字符串，内容为一个 UTF-8 JSON 对象，`strlen` 最多 8192 字节。发送方遇到更长的直接丢掉、不发；接收方遇到更长的或没有 `json` 的丢掉。可选键 `sequence`（uint64）和 `surface`（`IOSurfaceCreateXPCObject` 做的 XPC 对象，接收方 `IOSurfaceLookupFromXPCObject`）。
- 版本：JSON 里没有 `v`。App 和服务在同一个 bundle 里发布，线上格式只有本附录这一版。
- App → 服务（`op`），全部用 `xpc_connection_send_message_with_reply` 发：
  - `load`：`bundle`（原生包 manifest 路径）、`sha256`（64 字符）、`character` 必填；`clip`、`facial` 可选；`rate` 可选，0.5–2，缺省 1。同一包和角色再来一条只换片段，否则重新加载。
  - `load` 的可选键（v27 追加，只加不改）：`appearance`（外观 id），画这个外观，缺省为角色的默认外观；同一包和角色再来一条时也换到它。`mod_settings`（对象 `{外观 id: {开关 id: 整数}}`，同 `--agentic-complex-mod-settings`，规则 53），每条带上时，带表的各外观取它给的值、没给的取表的默认值；不合的外观、开关或取值逐项丢弃。
  - `load` 的可选键 `loop`：布尔，缺省 false。为 true 时 `clip` 播到片尾就从第 0 秒重播（`facial` 一起重播），不回到默认片段，直到下一条 `load` 或 `sequence`；`sequence` 不循环。没有 `clip` 时不起作用。
  - `load` 的可选键（v27 追加，只加不改）：`render_args`（字符串数组），桌面渲染器的渲染设置参数，App 传 `app/electron/src/main/renderer/supervisor.ts` 的 `lookArguments`。服务端只收这些参数和紧跟的一个值：`--agentic-complex-ssaa`、`--agentic-complex-shadow-resolution`、`--agentic-complex-outline`、`--agentic-complex-light-yaw`、`--agentic-complex-light-pitch`、`--agentic-complex-light-strength`、`--agentic-complex-secondary-motion`、`--agentic-complex-ground-shadow`、`--agentic-complex-filter`、`--agentic-complex-dof`（取值照「启动」一节）；别的参数、缺值或值以 `--` 开头的逐项丢掉，记日志 `AAC_PREVIEW_RENDER_ARGS_DROPPED`。不带时阴影分辨率 512、SSAA 2。`output`（`[w, h]`，整数，每边 240–2048）：输出像素；不带时 480×576，超出范围回 `error`。渲染尺寸是输出乘以 SSAA 倍数（`--agentic-complex-ssaa 1` 且包里有 1× 程序库时为 1，否则 2）。包、角色、`render_args`（收下的部分）和 `output` 都和上一条相同时只换片段；只有 `output` 不同时，服务端在原处改渲染目标和表面的尺寸、不重新加载（改不了时才重新加载）；包、角色或 `render_args` 不同时重新加载。
  - `load` 的可选键（v27 追加，只加不改）：`hidden_layers`（字符串数组），桌面隐藏的服装分层 id，和 `set_layers` 同义；不带或空数组显示全部分层。新建 actor 时按 `--agentic-complex-hidden-layers` 传入，只换片段时直接替换隐藏集合；有包里没有的 id 回 `error`。
  - `pause`、`resume`：停、续播放。
  - `ack`：`sequence`，App 的 GPU 用完那一帧后回。
  - `load_id`（v1 已有，补记）：`load`、`sequence` 可选带一个 uint64，缺省 0。服务端开始播一条 `load` 或 `sequence` 时记下它，之后的 `frame`、`loaded`、`stats`、`error` 都原样带上；请求本身出错时 `error` 带这条请求的 `load_id`。App 每发一条 `load` 或 `sequence` 换一个新值，丢掉 `load_id` 不是最新的 `frame`（照样回 `ack`）、`stats` 和 `error`。
  - `sequence`：`clips`（1–32 个 clip 名）、`blend_s`（数组，比 `clips` 少一项，每项 0–2 秒）必填。这个连接要先有一次成功的 `load`；片段直接从那个包的动作 archive 里取，不查链表，所以还没重建进包的链也能放。从 `clips[0]` 的第 0 秒起依次各播一遍（循环片段也只播一遍），`clips[i]` 播完后用 `blend_s[i]` 秒混到 `clips[i+1]` 的第 0 秒；最后一项播完照 `load` 回到角色的默认片段。成功时发 `loaded`（`clip` 为 `clips[0]`）；没有 `load` 过、片段不在 archive 里、`blend_s` 项数或取值不对时回 `error`。和 JSON 里 `ack` 的 `sequence` 字段、XPC 键 `sequence` 无关。
- 回复：服务端把 `load`、`sequence`、`ack`、`resume` 留作「待回的帧请求」（再来一条时先给旧的回 `{"event":"superseded"}`），其他请求立刻回 `{"event":"accepted"}`。下一帧作为待回帧请求的回复发出；没有待回请求时作为普通消息发。
- 服务 → App（`event`）：
  - `frame`：带 `sequence` 和 `surface`。表面为 `load` 的 `output`（缺省 480×576）、BGRA（`0x42475241`）、每行宽 × 4 字节，服务端轮用两块；一块只有在 App 回了它那一帧的 `ack` 后才再用。
  - `loaded`：`character`、`clip`，重新加载时再带 `render_pixels`（缺省 `[960,1152]`）、`output_pixels`（缺省 `[480,576]`）。
  - `progress`（v27 追加，只加不改）：`load_id`、`fraction`（0–1，同一条 `load` 里不减）。只在重新加载的 `load` 里、`loaded` 之前发；只换片段的 `load` 和 `sequence` 不发。App 丢掉 `load_id` 不是最新的，把 `loaded` 记作 0.95、这条 `load` 画出的第一帧记作 1，用它画角色页的载入条。
  - `error`：`reason`；有待回帧请求时作为它的回复发。
  - `stats`：每 30 帧一条，`sequence`、`prepare_ms`、`gpu_ms`（可为 null）、`allocated_bytes`、`footprint`。
  - `completed`：`scope`，只用于角色包 CG 检查片段播完。
- 传输层自己生成、不在线上的事件：服务端接受连接时交给服务 `{"event":"connected"}`；任一方收到 XPC 错误（包括连不上服务时请求的错误回复）时交给本方 `{"event":"disconnected"}`。
- 连接：服务端同时只留一个连接，新连接进来时取消旧的。服务端收到 `disconnected` 就停播，0.25 s 内没有新连接进来就以 0 退出（留出这段时间给换上来的新连接接手）。App 停止预览时取消连接，之后旧连接的消息都丢弃。

## 附录：Windows（v27 追加）

Windows 上渲染器是 `private/renderer/windows` 的 `efw.exe`（下称 efw）：用 Vulkan 按游戏原版 SPIR-V 画，经 D3D11 和 DirectComposition 显示；Companion 是 Electron 外壳（`app/electron`）。本附录只写和上文不同的地方，没写的照上文。

### 传输

- 命名管道由渲染器建，名字由 Companion 给：`\\.\pipe\agentic-complex-<h>-avatar`，`<h>` 是 support 目录路径转小写后的 UTF-8 的 SHA-256 前 16 字节，写成 32 个小写十六进制字符（`app/electron/src/main/renderer/link.ts` 的 `hostPipePath`）；作为 `--agentic-complex-host-socket` 的值传，放在最后。efw 只要求它以 `\\.\pipe\` 开头。
- efw 建管道用 `FILE_FLAG_FIRST_PIPE_INSTANCE`（名字已被别的进程占着时建不成，以退出码 1 结束，不去连别人的管道）、实例数 1、字节模式、`PIPE_REJECT_REMOTE_CLIENTS`，安全描述符 `D:P(A;;GA;;;<当前用户 SID>)`：只有同一用户的本机进程能连，和 agentd 的 `serve_ipc`（`agent/agentd/infra/platform/windows.py`）一样。
- efw 在首帧画出、startup-status 写 `ready` 之前建好管道，之后一直在。Companion 每 0.5 s 连一次，连上为止，断开后也这样重连；上文「渲染器每 0.5 s connect、10 s 内连不上就放弃」在 Windows 上不适用。
- 同一时刻只有一个连接。连接断开（EOF、读写出错、超长行、1 s 内超过 2000 行、efw 没送出的输出超过 1 MiB）后 efw 回到等待，接下一个连接；新连接从双方的 `hello` 重新开始，`heartbeat.seq`、`heartbeat.frames`、`stats` 的累计都从这次 `hello` 起。
- 和上文「关闭」不同：efw 读到 EOF 不退出，Companion 退出由 `--agentic-complex-parent-pid` 发现（规则 8）。断开时正在播的动作结束、不发回执（Companion 照规则 29 记 `connection_lost`），开关表回到默认。
- 帧格式、行长上限、`hello` 先行照上文。

### 坐标

- Windows 上 C3 的屏幕坐标是物理像素，原点在主屏左上角，y 向下（虚拟屏幕坐标；efw 按 Per-Monitor DPI Aware V2 运行）；窗口点也是物理像素，原点在窗口内容区左上角，y 向下。上文「坐标」一节的 point 和 y 向上只用于 macOS。Electron 用 `screen.screenToDipRect`、`screen.dipToScreenRect` 换算。
- efw 用这些单位收发 `window_frame`、`hit_capsules`、`cursor`、`click`、`drag`、`move_window`（见下面「efw 本版实现的部分」）；`move_window` 的 (`x`, `y`) 是窗口左上角。`window_frame.scale` 为 1（窗口点就是物理像素）。规则 3、10 的 4 pt 按窗口的 DPI 换成物理像素（4 × DPI / 96）。

### 启动

- 参数照「启动」一节，`--agentic-complex-*` 都接受；没实现的只记日志。另有 efw 自己的参数：
  - `--package <目录>`：角色目录，必有。efw 读其中的 Vulkan 段 `vulkan\frame.bin`，帧表里每个 blob 的名字是相对角色目录的路径（`/` 分段，每段只含 `[A-Za-z0-9._-]`，不许 `.`、`..`、空段），读到后核 SHA-256 和大小（大小不等于记录的是池压缩容器，按[角色库合同](../character-library/CONTRACT.md)的「池文件压缩」先解码再核）；播放器核心（`private/renderer/core`）读同一目录的 `actor\`（rig、manifest、片段，按 manifest 列的大小和 SHA-256 核）和 `c7\`，姿势都由它算（见下面「身体」）。Companion 用角色的 `avatar_args` 传。
  - `--package-of <角色 id>=<目录>`：可重复，`set_character` 能换到的角色和它的角色目录（目录同 `--package`，可以是相对路径、可以超过 `MAX_PATH`）。角色 id 照规则 21（非空、最多 64 字节），到第一个 `=` 为止；同一 id 只能出现一次；不合时以退出码 1 结束。efw 不读角色库，Companion 对每个在 Windows 上能画的角色（启用渲染、角色包条目有 `vulkan_frame`）各传一个，启动的角色也在内，和 `--package` 一起放在角色的 `avatar_args` 里。启动时只核参数，目录到 `set_character` 时才读。
  - `--clip <片段名>`：默认休息循环（C1 §1.4「当前姿势的默认休息循环」）；不传时是角色包里固定的那一条，同 Mac 的 `ActorMotionPolicy.normal`：`c7\animation\pose-families.json` 的 `hub` 那个基座，没有这个文件时 `motion-bindings.json` 的 `overview`。`set_character` 换到的角色用它自己的这一条。
  - `--offscreen`：不建窗口、离屏画帧，供 session 0 的测试；Companion 不传。
  - `--seconds <1-20>`、`--out <目录>`：测试用的时限（到了还没收到 `quit` 就以 1 退出）和输出目录（日志 `host.txt`，退出时窗口下的屏幕截图；启动和每次换角色成功后，这个角色画的第一帧是播放器核心采样的默认休息循环第 60 帧，读回存 `probe-<序号>`，日志行 `probe <序号>: character=<id> ... sha256=<显示输出的 SHA-256>`）；Companion 不传。
  - `--power ac|battery|saver`：测试用，假定交流供电、电池供电、电池供电且开着节电模式，不读系统电源；Companion 不传。
  - `--work-area <宽>x<高>`：测试用，把主屏工作区当成这个大小（物理像素，左上角不变）来定窗口大小和位置；Companion 不传。
- Windows 另有启动参数 `--agentic-complex-hide-on-screen-capture`：传 `1` 时 efw 不进截图（见下面「不被截图」）；传 `0` 或不传时照常进截图和录屏。设置 `hide_on_screen_capture` 在 Windows 上默认关，Companion 启动 efw 时总传这个参数（开传 `1`、关传 `0`）。本版没有对应的 C3 消息：改这个设置后外壳重启渲染器，新起的 efw 按新值生效。
- `pipeline.render.unsupported` 列出传了而 efw 不照办的渲染设置，名字是参数名去掉 `--agentic-complex-`、`-` 换成 `_`（例如 `ssaa`、`secondary_motion`、`ground_shadow`、`speech_expressions`、`camera_track`；`render_fps` 只在值不是 30/45/60 时列）。efw 画的是 `ssaa` 2（帧包按 2 倍尺寸渲染，再 2×2 降到输出尺寸；没有 1× 程序库，传 1 时列出 `ssaa`）、帧包的阴影分辨率、传入的 `outline`，镜头、光照、滤镜等都是帧包里固定的值。
- startup-status 文件同上文，`character` 是帧包里的角色。退出码：0 同上文（`quit`、父进程退出）；1 是参数不合、startup-status 路径不合规、建窗口或管道失败、渲染出错；71 是 Vulkan 在这台机器上画不了（没有 Vulkan 加载器或和 D3D11 硬件适配器同一 LUID 的设备、建不成 D3D11 硬件设备、显示用的共享纹理导入不了 Vulkan；Companion 和 69 一样报「无法使用 GPU」、不重启）；78 是帧包读不了或校验不过（没有 `vulkan\frame.bin` 或版本不对、表或 blob 不合、blob 名字出了角色目录、actor 或 producer 记录不合、没有片段），或播放器核心读不了 `actor\`、`c7\`（文件缺或校验不过、rig 节点数和帧包不同、没有默认休息循环或它放不了）。`--describe` 本版不支持。
- 窗口：无边框、逐像素透明、置顶、不抢焦点、没有任务栏按钮，大小是 540×780 DIP（Mac 的 540×780 pt）乘 `--agentic-complex-scale`（0.5–2，没传或不合时 1），按主屏的 DPI（`GetDpiForMonitor`）换成物理像素、四舍五入，放不进工作区时等比缩小到放得进，放在主屏工作区正中；日志行 `window: 540x780 DIPs x scale <s> at <dpi> dpi: <宽>x<高> ...` 报它。角色的显示输出（帧包的输出尺寸，现在的角色是 1080×1560）和窗口一样大时逐像素拷进窗口，不一样大时按预乘 alpha 双线性缩放到窗口大小。建窗时整窗点穿（`WS_EX_TRANSPARENT`，即规则 2 收到第一条 `cursor` 之前的状态），之后照下面的「点穿」切换。
- 不被截图：`hide_on_screen_capture` 开着时（见上），efw 建好窗口就设 `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`：她照常显示在屏上，别的程序的截图、录屏、共享屏幕和桌面复制里都没有这个窗口（那块是窗口下面的画面）。macOS 上同一个设置是 Companion 在录屏、共享屏幕期间把她隐藏起来；Windows 上用户自己一直看得见她，截图里一直没有她，不只是录屏期间。Windows 10 2004 之前的系统上这个设置按 `WDA_MONITOR` 生效：截图里这块是空的窗口。`--out` 退出时截窗口下的屏幕，桌面复制存 `screen`、GDI 屏幕复制（`BitBlt`）存 `gdi`；排除截图时先对截图放开窗口截 `screen-shown`、`gdi-shown`，再排除后截 `screen`、`gdi`。

### efw 本版实现的部分

- `hello`：`capabilities` 为 `heartbeat`、`render_progress`、`ack`、`actions`、`action_loop`、`pipeline`、`drag_motion`、`opacity`，传了 `--agentic-complex-agentd` 时另有 `playback`、`turn_generation`、`behavior_receipt`；`build` 为 `{"git": "unknown", "renderer": "vulkan"}`；`character` 是帧包里的角色；`appearances` 是帧包的外观列表（照 pack.json 顶层 `appearances` 转，第一项是默认外观），`appearance` 是正在画的外观；不带 `layers`。连上就发（这时首帧已画出）；换角色后不重发，新角色由 `character_changed` 报。
- `heartbeat`：握手后每 100 ms 一条；`render` 在画时为 `active`，`set_visible` 隐藏或 `fps_tier` 为 `paused` 时为 `idle`；`frames` 是画出的帧数。`stats`：每秒一条，`gpu_ms` 为 null，`gpu_errors` 是失败的 Present 数，`drawable_misses` 是交换链 20 ms 内没空出来的次数。`pipeline`：照规则 37 的时机；`renderer` 为 `"vulkan"`，`bundle_sha256` 是 `vulkan\frame.bin` 的 SHA-256，`appearance` 是正在画的外观（启动时是 `--agentic-complex-appearance` 给的外观；帧包没有这个外观时是默认外观，打日志 `AAC_APPEARANCE_FALLBACK want=<id> have=<id>`，`appearance_fallback` 报它），`fps.requested` 是最近一条 `fps_tier` 的 `fps`（还没收到时 30），`fps.target` 是下面算出的目标帧率，`frames.completed` 同 `submitted`，`clip` 是正在画的片段。
- 帧率（规则 4 和 `fps_tier` 档位表下的 Metal 宿主规则）：暂停：隐藏或 `fps`=0 时目标为 0，不画、照常收发消息。硬上限：用户上限（`--agentic-complex-render-fps` 30/45/60，其他值按 60；收到带上限的 `fps_tier` 后用其 `user_fps`）；电池上限开着（`--agentic-complex-battery-low-fps`，收到带上限的 `fps_tier` 后用其 `battery_low`）且电池供电时 30；系统节电模式开着时 30；Windows 没有热状态，没有热状态上限。电池供电是 `GetSystemPowerStatus` 的 `ACLineStatus`=0，节电模式是它的 `SystemStatusFlag`=1，最多每 2 s 读一次。基线：`fps_tier.fps`，还没收到时 30；`play_action` 在播期间和停后 2 s 提升到 60。目标取基线和所有生效上限的最小值。每 1/目标 s 画一帧、`Present` 到下一次垂直同步；帧包的着色器时间仍按帧包的帧率走。连接断开后档位回到还没收到 `fps_tier` 时，上限保留。
- `ack`：`set_visible` 执行后回 `ok`；`fps_tier` 校验（规则 21）后照上条生效、回 `ok`；`move_window` 执行后回 `ok`，按下或拖动中回 `busy`，坐标不合回 `invalid`；`set_placement` 回 `unsupported`。
- `window_frame`：Companion 的 `hello` 之后一次，`move_window` 和拖动移动窗口后各一次；`viewport`=`window`，不带 `display_id`，`window_number` 是窗口的 HWND 值（`--offscreen` 时为 1，`frame` 是窗口会在的位置）。`move_window` 照规则 12 移窗口；切换角色中（淡出淡入期间也）照常立刻执行，不留到淡入前。
- `hit_capsules`：Windows 帧包里没有胶囊数据，efw 从画出的帧的 alpha 算：每 100 ms 把显示输出拷到 staging 纹理、不等 GPU 地读回，把窗口按行分成至多 64 条带，每条带一个横向胶囊，盖住这条带里 alpha ≥ 32 的像素的左右范围；`space`=`window`，每次读回都发（不变时就是 100 ms 保活）。`set_visible` 隐藏和切换角色（从收到 `set_character` 到回复它）时立刻发空数组，之后每 100 ms 照发。
- 点穿：窗口只在按下到抬起之间、拖动中，或最近 0.2 s 内收到的 `cursor` 的 `hit` 为 true 时接收鼠标（去掉 `WS_EX_TRANSPARENT`），其余时候、切换角色和隐藏时点穿（规则 2、14、17）；`heartbeat.click_through` 报当时的实际状态。
- `click`、`drag`：照规则 3、10，不带 `region`。窗口不抢焦点，不用鼠标捕获：按下后每轮主循环读光标位置（`GetCursorPos`）和主键状态（`GetAsyncKeyState`），移动 4 pt 以上开始拖，窗口跟着光标走，主键抬起结束。`drag` 三种都带 `x`、`y`、`grab`、`vx`、`vy`（`drag_motion`），`grab` 相对窗口底边中点，`move` 和拖动中的 `window_frame` 每 1/60 s 至多一条。拖动或按下中收到的 `set_character` 等抬起后才开始。
- 注视（规则 9、36，播放器核心 `player_gaze.h`，照 Mac 的 ActorProceduralLayer，不含走路倾身）：每帧在播放器核心的姿势之后、口型之前转她的脖子和头。`cursor` 的 `x`、`y` 是她看的点；efw 不看 `cursor` 的 `inside`，自己判：连接已握手、光标在和窗口交叠最多的那块屏上。光标停下 4 s 后她不再看它，改看用户或随机瞥一眼（同 Mac）。`point_at` 照规则 9 校验（不合时记 `c3 rejected type=point_at why=fields`），之后 4 s 她看 `rect` 的中心，盖过光标；`rect` 为 null 时这 4 s 不看任何点。表情 `surprised` 和指向反应片段本版不做。拖动窗口时上身照 Mac 的弹簧左右摆。`set_action_switches` 里的 `look_cursor`、`drag_sway` 开关光标注视和拖动摇摆（不带的保持原值，换角色后都回到开），不进 `action_switches` 的表。眼睛不动：帧包没有 `eyeyawmin|max`、`eyepitchmin|max` 的脸部记录。
- `set_visible`：隐藏、放回窗口；隐藏时不画，语音照播（隐藏角色时该停的主动台词由 agentd 在 `/events` 发 `speech_cancelled`，见下条）。
- 语音（C2）：传了 `--agentic-complex-agentd` 时，efw 每次连接前重读这个文件，用它的 `events_token` 连 `GET /speech`（断开 1 s 后重连，带 `?after=<stream_epoch>-<stream_seq>` 续传）和 `GET /events`；文件还不存在或连不上时每秒再试。PCM 在默认输出设备上用 WASAPI 共享模式播；没有输出设备时（例如 session 0）用 48 kHz 静音时钟推进，回执照常。`/events` 里语音只用两种事件（C1 的身体事件见下条）：`snapshot` 的 `turn_generation`（当前代际），`speech_cancelled`（C2 规则 8：代际升高时停掉低于它的语音，带 `utterance_id` 时这句台词正在播的分句立刻停、等着的和之后到的分句丢弃；`session_epoch` 不是当前 C2 流的、代际低于当前的不理）。`playback` 照规则 23（`clause_id`、`utterance_id`、`spoken_text_revision` 照抄 C2 v2 `begin`，v1 流的 `clause_id` 为 null），本地停播（`stop_speech`、规则 24 的代际打断、上面 `/events` 的取消、开始载入新角色）发 `interrupted` 和同 reason 的 `speech_cancelled`；Companion 的 `hello` 之前的回执留到握手后发；连接断开时正在播的语音停掉、不发回执（Companion 已照规则 23 补发 `connection_lost`）。`stop_speech`：照规则 7、24，`reason` 不是 `barge_in` 或 `turn_generation` 不合规则 21 时丢弃、记日志；没在播时什么都不发。不发 `trace`。嘴不动：帧包没有脸部控制数据（见下面「efw 本版没有的能力」）。
- 身体（C1 v2.7）：每帧 `pc_advance` 一次、`pc_apply(PC_STAGE_ALL)` 一次（基础层、叠加层；程序化块本版不开），口型叠在它上面；隐藏或 `paused` 时播放器照走，每秒 10 步。基础层平时播默认休息循环（「启动」的 `--clip`），它不发 `motion_state`。传了 `--agentic-complex-agentd` 时 `/events` 另读 `behavior`、`behavior_cancel`、`session_reaction` 和 snapshot 的 `behaviors`、`reactions`、`stage`、`consumed`：一条连接第一条 snapshot 之前的、`seq` 不大于上一条的丢掉，不合 C1 的丢掉、记日志。
  - `perform`：`clip` 按片段名、`action` 按 `c7\animation\actions.json` 里这条动作的第一个片段成为基础层或叠加层的一条播放（`layer`、`start`、`blend_s`、`loop` 照用；`action` 不带 `loop` 时播一遍）。角色没有这个片段时发 `motion_state` `rejected`、回执 `rejected` / `unsupported`；`motion`（生成动作）本版都这样拒绝；别的行为类型回执 `rejected` / `unsupported`。`play_action` 在播时基础层的 `perform` 回执 `rejected` / `busy`。`turn_generation` 小于当前代际（snapshot 的，`speech_cancelled` 调高）的回执 `rejected` / `stale`。同层同载荷、`replaces` 为在播行为的是续期：旧 id 回执 `cancelled` / `replaced`，新 id 接着 `running`，不发 `motion_state`；`replaces` 指向另一层上的行为时，那一个结束、回执 `cancelled` / `replaced`。
  - 结束：`behavior_cancel` 取消的是还在等开始（`start` 不是 `now`）的那条时只丢掉它，这一层在播的照播；叠加层照 `mode`、`fade_s` 停（`fade_out` 不带 `fade_s` 时 0.25 s）；基础层回到默认休息循环（`fade_out` 时以 `fade_s` 交叉淡化），`ended` 在换上休息循环那一帧发；回执照 C1 §2。`ttl_s` 内没续期、`expires_at_ms` 到了时同样结束，`motion_state`、回执为 `expired`。`/events` 断开不结束行为：在播的照播，照 `ttl_s`、`expires_at_ms` 到期；重连后的 snapshot 的 `behaviors` 先照 `perform` 接手里面没在播的 id（续期照上条），再结束不在里面的在播行为、回执 `cancelled`、reason null。
  - 本地反应：单击（规则 10 左键 `count` 1）、拖起、放下是 `reactions` 的 `click`、`drag_lift`、`drop`，按 `weight` 以这次载入角色的种子加权挑一条、本地播（`origin` `local`）；它打断的 C1 行为回执 `cancelled`，reason `user_click` / `user_drag`。`session_reaction` 不带片段，efw 不播，只记它的 `occurrence_id`。
  - 两边 `hello` 都列了 `behavior_receipt` 时发 `motion_state`（规则 54，`resting`、`busy` 是这一帧边界之后的层状态）和 `behavior_receipt`（规则 25）；两种合计每秒超过 20 条时 efw 自己丢多出的 `motion_state` 和非终态回执、记日志。Companion 断开后在播的行为不再回执（规则 25），照播到被替换或到期。换角色时在播的发 `ended`、回执 `cancelled` / `character_switch`，`reactions`、`consumed`、`stage` 留给新角色。
- 动作清单：帧包没有 actions.json，帧包里的片段按包里的顺序一个片段一行，最多 128 行（规则 30）：`id`、`name` 都是片段名，`section` 循环片段为 `idle`、其他为 `react`，`duration` 循环片段为 null、其他为片段长度，`trigger` 为 `仅手动播放`，`required_reason`、`missing` 为 null；名字超过 64 字节的片段不列。没列进清单的片段 `play_action` 照样能播。握手后（Companion 列了 `actions`）发一次，`get_actions` 时再发。`set_action_switches` 照规则 28 回 `action_switches`（没有必需和缺资源的行），表只记着：efw 本版不自己挑动作。换角色时（从收到 `set_character` 到回复它）`get_actions` 回 `not_ready`、`set_action_switches` 回 `switching`；换成后开关表是新角色的默认，清单在 `character_changed` 之后发一次（换角色失败时也发一次旧角色的）。
- `play_action`：播放器核心的基础层换到这个片段从 0 播（正在画的就是这个片段时按相位接着播），用默认交叉淡化（`blend-times.json` 的 `blend_in_s`，没有时 0.25 s），`speed` 是它在播时播放器时钟的倍率；画出第一帧后发 `started`；循环片段一直播到 `stop_action`、下一条 `play_action` 或断开；非循环片段播完发 `completed`、回到默认休息循环，`loop`=true 时从头重播。`rejected` 只会是 `wrong_character`、`unknown_action`（帧包里没有这个片段）、`missing`（播放器核心没有这个片段，或片段的 key 读不出、校验不过；key 在第一次播时读入）、`switching`（换角色时）；`interrupted` 只会是 `superseded`、`stopped`、`character_switch`（开始载入新角色时）。不画时（窗口隐藏或 `paused`）收到的 `play_action` 立刻 `started`。`stop_action` 照规则 29。
- `set_appearance`：照规则 16。帧包没有这个外观时回 `appearance_change_failed` `unknown_appearance`，外观不变；已经是这个外观时立刻回 `appearance_changed`；否则下一帧换成它，画出这一帧后回 `appearance_changed`（不画时立刻回）；还没画出又来一条时，前一条回 `superseded`。从收到 `set_character` 到回复它之间收到的回 `switching`。可见网格照 Mac 的规则：片段和外观都允许的网格才画；帧包标为粒子网格的（特效的粒子面片）在所有外观下都不画，efw 本版没有粒子运行时。
- `set_character`：照规则 14、26，在同一个进程里换，不重发 `hello`，pid 不变。已经是这个角色时立刻回 `character_changed`、`ms`=0；没有这个 id 的 `--package-of` 时立刻回 `character_change_failed` `unknown_character`；否则正在播的动作 `interrupted` `character_switch`，窗口在 0.2 s 内线性淡出（旧角色照常画），淡完后 efw 在旧角色旁边建新角色（帧包、actor、资源、执行器），建成后换上并丢掉旧的，新角色画出第一帧后窗口在 0.2 s 内线性淡入到 `set_opacity` 的当前值，淡入结束后回 `character_changed`（`ms` 是收到请求到淡入结束），带新角色的 `appearance`、`appearances`。新角色的输出尺寸不必和窗口相同（见「窗口」）。建不成（目录里没有帧包、校验不过、资源建不成）时旧角色淡入回来，淡入结束后回 `load_failed`，旧角色照常画、照常收 `play_action`。窗口 alpha 经 DirectComposition 的 effect group 设，每秒至多 60 步；每段淡变结束时打日志 `window: alpha <switch-out|switch-in|set_opacity> <起> -> <止> in <秒> s, <n> steps: <毫秒>:<alpha> ...`。隐藏或 `paused` 时不淡出淡入，建成就回；切换中隐藏时跳过还没做的淡入（规则 14「隐藏时」）。带 `appearance` 时按它载入，新角色没有这个外观时穿默认外观、打日志 `AAC_APPEARANCE_FALLBACK`，`pipeline.appearance_fallback` 报它。从收到一条 `set_character` 到回复它之间又收到的回 `switching`（规则 14）；请求在还没画出的 `play_action` 或 `set_appearance` 之后才开始。规则 14 的「穿透」照上面「点穿」，从收到请求到回复都点穿、`hit_capsules` 为空。载入在主线程上做，期间不发心跳。连接断开时还没开始的请求丢弃，已换上的角色留着。
- `set_opacity`：照规则 35，在 `duration_ms` 内从当前值线性变到 `opacity`，窗口 alpha 是它乘切换的淡出淡入（规则 14）；不改点穿。不合规则 35 的取值时丢弃、记日志 `c3 rejected type=set_opacity why=fields`。`covered` 照下条丢弃：efw 没有走路，她不让开。
- `quit`：销毁窗口、关管道，以 0 退出。父进程退出时同样。
- 别的 Companion 消息（`set_layers`、`touch_settings`、`set_render` 等）照「接收方忽略未知的 `type`」丢弃、记日志，连接不断。

### efw 本版没有的能力

`placement`、`viewport_fullscreen`、`trace`、`surfaces`、`layering`、`pointer`、`drop`、`motion_requests`、`pass_through`、`keep_clear`、`render_live`、`ambient`、`touch`、`motion_media`、`layers`、`poses`、`camera_free`、`camera_track`、`camera_gesture`、`camera_bust`、`filters`、`capture`、`photo`、`motion_overrides`、`play_chain`、`mod_settings`。

说话时的嘴型：`vulkan\frame.bin` 的 Actor 表有 `face_control`、`face_delta` 和 a/i/u/e/o 五条 `vowel` 记录（`windows_actor_export.py` 的 `face_records` 从 `original-face-controls.json`、`original-audio-face-controls.json`、`emotion-lipsync.json` 导出默认口型组）。efw 把 C2 cue 的元音权重按 40 ms 升、80 ms 落平滑，按这些记录把关节增量叠在片段姿势上；没有这些记录的帧包嘴不动，`playback` 照发。

### 校验

`private/renderer/windows/tools/c3_host_check.py` 在 Windows 上扮 Companion：照 Electron supervisor 的参数起 efw（`--offscreen`），连管道走一遍上面的消息，用 `validate.py` 查 efw 发的每一行（套件 `renderer-win-host`）；`--pipe` 时连一个已经在交互会话里跑的 efw。
