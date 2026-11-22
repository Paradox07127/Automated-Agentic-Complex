# UI 桥：桥 op 与 agentd 路由分类

网页 UI 经桥的 `agentd.request` 访问 agentd。桥对 agentd 路由「默认拒绝」：只有 [routes.json](routes.json) 里分了类、且类和面板都放行的路由才转发。

`routes.json` 由 `protocol/tools/gen_routes.py` 从 `agent/agentd/route_registry.py` 生成，和 agentd 的路由表一一对应：每条路由恰好一项，不多不少。`agent/agentd/tests/test_ui_route_classes.py` 检查这一点。`ops.json`、`onboarding-ops.json` 是 `protocol/tools/gen_bridge.py` 生成 TS 桥表的输入。改完在仓库根目录跑 `python3 -I protocol/tools/gen_all.py --write` 重新生成全部，`protocol/tools/tests/` 检查是否过期。

## 字段

| 字段 | 含义 |
|---|---|
| `method` | HTTP 方法，与 `route_registry.py` 里的登记相同 |
| `path` | 登记里的路径。以 `^` 开头的是正则（登记里正则的 `pattern` 原文），用 full match 比对；其余是字面路径，整串相等才算命中。比对的是去掉 query 的路径；path 含 `;` 的请求桥直接拒绝 |
| `class` | 分类，见下表 |
| `surfaces` | 允许发这条请求的面板，取自 `"main"`、`"stack"`、`"onboarding"`。拒绝类为空数组 |

## 分类

| class | 含义 | 桥的处理 |
|---|---|---|
| `read` | 带 ui_token 的读接口 | 面板在 `surfaces` 里就转发 |
| `write` | 带 ui_token 的写接口 | 面板在 `surfaces` 里就转发 |
| `confirm_native` | 破坏性操作（`POST /reset`） | 先弹原生确认，用户确认后才转发 |
| `native_only` | 要和原生侧状态一起改的接口，JS 只能经原生 op 间接触发 | 拒绝 |
| `host_only` | Companion 宿主或角色进程自己上报、驱动的接口（采集、播放回执、角色切换、头像显隐等） | 拒绝 |
| `hook_only` | 只认 hook_token 的接口（Claude、Codex hook，浏览器扩展） | 拒绝 |
| `integration_only` | 只认 integration_token 的外部 agent 接入接口（`/integration/*`） | 拒绝 |
| `stream` | 长连接（SSE、NDJSON） | 拒绝；事件由原生侧订阅后经桥推给 webview |

## 桥的用法

1. 先检查请求的来源和形状：请求必须来自外壳加载的面板页面的主 frame；`method` 是 `GET`、`POST`、`PUT`、`PATCH`、`DELETE` 之一；`path` 以 `/` 开头，不含 `//`、`..`、`#`、`;` 和控制字符，最长 2048 UTF-8 字节，并且原样发出时不被改写（没有 `%2e`、`.` 段、`\` 或会被百分号编码的字符）。
2. path 含 `;` 的拒绝：agentd 用 `urlparse(...).path` 取路径，会再去掉最后一段的 `;params`，与桥比对的串不一致。
3. 用 `method` 和去掉 query 的 path 在 `routes.json` 里找：先比字面路径，再按顺序试正则。找不到就拒绝。
4. `class` 是 `native_only`、`host_only`、`hook_only`、`integration_only`、`stream` 的拒绝。
5. 发起面板不在 `surfaces` 里的拒绝。
6. `confirm_native` 先弹原生确认，取消就不发。
7. 下列字段只收 `files.pickFile` / `files.pickFolder` 返回的不透明句柄，由桥换成真实路径后再发；收到明文路径字符串就拒绝整个请求：
   - `PUT /character/runtime` 的可执行文件路径：`pickFile({purpose:'runtime_executable'})`；`workspace_dir`：`pickFolder({purpose:'session_cwd'})`；
   - `POST /agent/scopes` 的 `roots` 各项：`pickFolder({purpose:'scope_root'})`，`output_root`：`pickFolder({purpose:'scope_output'})`（agentd 接受任意非符号链接目录，并对 `output_root` 做 `mkdir -p`）；
   - `POST /agent/scopes` 的 `files` 各项：`pickFile({purpose:'scope_file'})`（宿主只让选 `.md .txt .csv .json`）；这一项也收交给她卡上文件项的 `handle`：外壳在本次运行里收到原生拖入或交出剪贴板文件时为每个文件发一个，这张卡建几次范围都能用；也收 `files.adoptDropped(files)`（拖进页面的文件，preload 用 `webUtils.getPathForFile` 取路径，页面造的 File 取不到）和 `files.adoptPasted(items)`（粘贴的 png/jpeg/gif/webp，外壳写进 `<支持目录>/pasted/`）返回的句柄，和 pickFile 的句柄一样只用一次。只有主窗口的可信主框架可接收拖放或粘贴，每次最多取前 16 项，每项至多 5 MiB，每个范围最多 16 个文件。页面放弃附件时调用 `files.release(handle)`，关闭或刷新页面也会删除未使用的粘贴副本。已交给范围的文件保留供 agentd 读取，应用启动或清除本地数据时清空 `pasted/`。明文路径字符串一律拒绝；
   - `POST /sessions` 的 `cwd`：`pickFolder({purpose:'session_cwd'})`（agentd 接受任意目录和 `workspace_write` 模式）；
   - `POST /say` 带 `cwd` 字段的拒绝（见「现行取舍」）。
8. 其余由 `AgentdClient` 带 token 转发。

## 原生 op

`ops.json` 的 `internal` 是只由注入脚本发的 op：`feed.unsubscribe`、`diag.unsubscribe` 退订对应流；`events.unsubscribe(id)` 退订 `avatar.onState`、`avatar.onStats`、`computerUse.onState`、`voice.onPushToTalk`、`settings.onChange` 这类 `on<Name>(cb)` 订阅，事件的 `data` 是交给 `cb` 的 JSON。

`app.runtime()` 返回 Companion 的运行状态快照（`app/electron/src/common/runtime.ts` 的 `runtimeJson`，snake_case），`app.onRuntime(cb)` 订阅后先收到当前快照、此后每次变化收到一份；main 和 stack 放行。

`computerUse.onPanel(cb)` 推电脑操作授权小窗的整份状态（`web/src/bridge/computerUse.ts` 的 `ComputerUsePanel`），订阅时先推当前的；`computerUse.grant(scopes)`、`revoke(scopes)`、`resume()`、`dismiss()` 是小窗的按钮。这五个只放行 stack，宿主只给小窗那一页（`stack.html#/computer`）处理函数。

`camera.onState(cb)` 推「调整镜头」浮层的状态（接收区在页面里的框、当前镜头值、能不能编辑、「近景」能不能点），订阅时先推当前的；`camera.drag(dx, dy)`（页面点，y 向下）、`endDrag()`、`scroll(deltaY)`（点，正数拉近）、`magnify(m)` 页面不等它们的回复；`camera.act(name)` 是「全身」`fullBody`、「近景」`closeup`、「复位」`reset`、「完成」`commit` 和取消 `cancel`。这六个只放行 stack，宿主只给浮层那一页（`stack.html#/camera`）处理函数。

`region.finish(from, to)` 交出「框选给她看」那一页拖出的两个角（页面点，y 向下，按下处和松开处），有一边不到 8 点时宿主按取消算；`region.cancel()` 是右键或没按下就松开。这两个只放行 stack，宿主只给框选那一页（`stack.html#/region`）处理函数。

`resize.onState(cb)` 推「调整大小」缩放框的状态（她在页面里的框 `frame`、`scale`、到 50 % 或 200 % 时的 `limit`（`min` / `max`）、正在拖的角 `dragging`），订阅时先推当前的；`resize.drag(corner, dx, dy)`（`topLeft`、`topRight`、`bottomLeft`、`bottomRight` 之一，从按下起的总位移，页面点，y 向下）、`endDrag()` 页面不等它们的回复；`resize.act(name)` 是「恢复默认」`restoreDefault`、「完成」`done` 和取消 `cancel`。这四个只放行 stack，宿主只给缩放框那一页（`stack.html#/resize`）处理函数。

`window.logInfo(message)` 不等回复，原生把 `message` 作为一行 info 写进该面板的 `ui.log`（与注入的错误脚本经 `efLog` 写的错误行同一个文件、同一个每分钟限额，消息以 `info: ` 开头）；只放行 stack。

桌面层（浮窗栈、角色附属层、命令层）的桥 op 是 `window.onAnchor`、`window.setContentSize`、`window.releaseKey` 和 `desktop.onState`、`desktop.onPresence`、`desktop.onCommand`、`desktop.say`、`desktop.action`：`/desktop/presence` 由原生读了再经 `desktop.onPresence` 推给页面，快速输入经 `desktop.say` 走原生发送路径，不走 `/say` 路由。这些 op 不改 routes.json。

## 现行取舍

下面几条路由的分类取更严的一类：

- `POST /speech/cancel`：只有宿主（`app/electron/src/main/renderer/reports.ts`）调用，为 `host_only`。
- `POST /look`：由原生热键、菜单经 `app/electron/src/main/context/capturer.ts` 发起，后续截图也由宿主完成，为 `host_only`。UI 的「看一下」走 `app.look()`，由原生代发。
- `POST /character`：旧的一步切换，只有宿主的角色切换流程（`CharacterSwitch`）调用，为 `host_only`。UI 切角色走原生的三步切换流程（`/character/prepare`、`commit`、`abort`）。
- `GET /desktop/presence`：ui_token 的 GET，但只有宿主的 `DesktopInteraction` 读，为 `host_only` 而不是 `read`。
- `POST /context/privacy/sync`：要先由原生保存配置再同步，为 `native_only`，UI 改隐私设置走 `settings.save`。关掉 `wintext`/`web`/`typing`/`agent_sessions` 前要显示的删除条数走 `settings.previewDestructive(id)`，由原生发 `dry_run`。
- `PUT /behavior/switches`、`PUT /character/state/switch`：原生把 `config.json` 里的 `stay_mode`、`sit_on_windows`、`lean_on_edges`、`state_affects_behavior` 同步给 agentd（agentd 每次启动重推，设置保存后再 PUT）。JS 直写会绕过 `settings.save`，让 `config.json` 和 agentd 不一致，故为 `native_only`；UI 改这些开关走 `settings.save`。
- `POST /say` 的 `cwd`：`pickFolder` 没有对应的 purpose，桥拒绝带 `cwd` 的 `/say`。
- `DELETE /history`、`DELETE /memory`：全量删除，为 `write`。
- stack 面板只放行 `routes.json` 里 `surfaces` 含 `stack` 的路由：卡片上的决定类写接口（审批、任务、提醒、问题、后台任务）、`PUT /observation/quiet`、`PUT /observation/meeting`（免打扰与开会）、任务轨的 `POST /agent/runs/<id>/cancel`、`POST /agent/jobs/<id>/cancel|resume`，以及少量小窗自己要读的接口。`/agent/deliveries/*/presented|viewed` 回执不在 stack 放行之列；stack 要展示的其他数据由原生推送。

## 返回值夹具

`returns/` 下的 JSON 用例描述 `web/src/bridge/protocol.ts`、`onboarding.ts` 和 `desktop.ts` 里返回 promise 的调用解析出的值。`web/tests/unit/bridge-returns.test.ts` 用一个新建并冻结的假桥逐条核对，并对照生成的 op 目录检查 UI 面板上可用的调用都有用例。订阅回调的 payload 是事件；订阅和同步返回的行为由 `bridge-surfaces.test.ts` 覆盖。

- `computerUse.grant`、`computerUse.revoke`、`computerUse.resume`、`computerUse.dismiss` 只放行 stack，外壳只给电脑操作小窗那一页（`computer-use.json`）。
- `camera.*` 只给「调整镜头」那一页（`camera.json`）；`region.*` 只给「框选给她看」那一页（`region.json`）；`resize.*` 只给「调整大小」那一页（`resize.json`）。

每个用例写明 `op`、允许的 `surface`、可选的 `args`，以及为到达合法状态要先调的 `before`。`value` 是一个有代表性的 JSON 值：`web/tests/unit/shape.ts` 比较键集合和 JSON 类型，不比较标量值，数组只比第一项。`nullable` 和 `free_keys` 的含义同 C6 夹具（`protocol/C6-agentd-api/fixtures/loose-fields.json`）。`kind: "undefined"` 表示解析为 void，JSON 写不出这个值。

用例覆盖假桥实现的成功和失败变体：agentd 请求、角色切换和桌面说话。文件选择和热键录制走取消分支，因为浏览器假桥没有原生面板。

`responses/observation-state-unauthorized.json` 是没有观察同意时 `GET /observation/state` 的回包（HTTP 200，与 UI 令牌无效时的 HTTP 401 不同）。`web/tests/unit/wire-fixtures.test.ts` 把它和 mock 的 `?demo=unauthorized` 回包比较。

## 运行时快照夹具

`runtime/initial.json` 是新启动的外壳（所有进程都没起，`phase` 为 `starting`）的 `app.runtime()` 值；`web/tests/unit/bridge-ops.test.ts` 检查假桥的快照恰好有这些键路径。
