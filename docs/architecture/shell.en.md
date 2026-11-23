# Electron shell and platform helper

[简体中文](shell.md) · [Documentation index](../README.en.md)

`app/electron` is the product's only shell. It reads the config.json that `--config` names, supervises agentd, the renderer, the platform helper and the external services, and hosts the `web/` UI in its windows. See [repository and runtime architecture](overview.en.md) for how the processes talk, and [web UI](web-ui.en.md) for the page side.

## What the shell does

- Pages are served over the custom scheme `agentic-complex-ui://app/`; the CSP is in `src/common/ui.ts`. The main window loads `main.html` and the desktop panels load `stack.html`. When the page files are missing, the main window shows the 界面文件缺失 (UI files missing) page and the tray keeps working.
- The tray menu lists the state of each child process; the row texts are in [release components §5](../components.en.md#5-missing-components).
- `window.agenticComplex` in a page sends each op to the main process over IPC. The main process checks the surface and op name against `protocol/ui-bridge/ops.json` and hands the op to its handler in `src/main/ops/`. An op the surface may not use answers `op_not_allowed`; an op without a handler answers `not_implemented`.

## Source layout

| Directory | Contents |
|---|---|
| `src/common/` | Pure logic both ends share: op checks and dispatch, the in-page bridge, C3 framing, placement, settings and hot keys, the card source, the desktop panel layout rules |
| `src/main/` | The main process: `index.ts` (windows, tray, scheme, IPC), plus agentd and renderer supervision, the C3 end, placement and component import |
| `src/main/ops/` | One file per op namespace; handlers touch Electron only through `OpsContext` in `context.ts`, which tests replace with fakes |
| `src/main/desktop/` | The desktop panel windows and their assembly |
| `src/main/preview/` | The character page preview: session, clip choice and the window side |
| `src/main/platform/` | Platform differences: default directories, overlay window options, coordinate maps, helper paths |
| `native/mac/` | The macOS Node-API addon `preview.m`: the preview XPC client and `setPreventsActivation` |
| `src/preload/` | Installs the bridge in the page world; in the main window it also receives preview frames |
| `test/` | `node --test` unit tests; `e2e-headless.test.ts` runs only with `AAC_ELECTRON_E2E=1` |

`tools/qa/xplat_guard.py` checks two layer rules: `src/common/` imports neither `electron` nor `node:*`, and only `src/main/platform/` reads the current platform.

## Build output

`npm --prefix app/electron run build` runs `tsc --noEmit`, then `build.mjs` bundles `dist/main.mjs` (ESM) and `dist/preload.cjs` (a sandboxed preload must be one CommonJS file) with esbuild. On macOS it also compiles the preview addon `dist/native/preview.node`.

`build.mjs` writes two values into `dist/main.mjs`: the checkout's commit (`git rev-parse --short HEAD`) and the release profile's `ui_art` directory. C3 `hello.build.git` takes the first, or `unknown` without one. `agentic-complex-ui://app/art/` reads from the second; without an art directory the page sets no `html[data-art]` and shows its no-art look. The public profile has no art.

## Development mode

`--dev-web-server <url>` takes the pages from the vite dev server:

- It works only for a launch from the repository (the app has no `distribution.json`). A packaged app logs `DEV_WEB ignored` and keeps reading the web-ui component.
- It accepts only an http origin with a port on `127.0.0.1` or `localhost`.
- Pages stay on `agentic-complex-ui://app/`, so the real bridge, origin checks and navigation guard do not change. The scheme forwards requests to vite through `net.fetch`; `art/` and `characters/` still come from the shell.
- Vite's answers carry a dev CSP: scripts and styles allow `'unsafe-inline'`, and `connect-src` admits vite's HMR websocket. Start vite with `EF_DEV_HMR_PORT=<port>` (`web/vite.config.ts`), because the scheme URL has no port.
- Each page document logs one line `DEV_WEB <page> <- <vite url> <status>` in `companion.log`.

`--quit-after <seconds>` (1–600) logs a `QUIT_AFTER …` line when the time is up, then quits as the tray's 退出 (Quit) does. `--no-push-to-talk` builds no push-to-talk; `--no-attention` samples none of the user's windows and registers no global hot key. The dev console passes both by default; see [development and releases](../development.en.md#local-development-dev-console).

## Launch from the app bundle

A `Contents/Resources/distribution.json` means a launch from the app bundle (`src/main/packaged.ts`); without it the shell runs as from the repository. From the app bundle:

1. config.json is in the support directory. The split layout first imports `components/` beside the app into the support directory, then resolves the composition lock.
2. The first launch composes the seed character library `character-libraries/seed-<sha16>` with `character_tool.py compose`; its SHA must equal `catalogSHA256` in `distribution.json`. A changed seed is migrated with `distribution_seed.py`. Without the agentd, runtime.python or character components nothing is composed and config.json records `character_library_missing`.
3. A new config.json gets the defaults; an existing one keeps the user's settings. Each launch recomputes `avatar_app`, the component paths and `missing_components`, checks the whole file with `parseConfig`, and replaces it atomically (mode 0600) only when it changed.
4. Pages come from the web-ui component's `ui/`, and the helper is `Contents/MacOS/ac-helper`.

## Desktop panels

The desktop layer is six transparent, frameless, shadowless panel windows, each loading one route of `stack.html` (`src/main/desktop/assembly.ts`):

| Panel | Route | Level (above the character window) | Contents |
|---|---|---|---|
| Bubble | `#/bubble` | 1 | Her lines and quick input; a subtitle strip under the menu bar while she is hidden or covered by a full-screen app |
| HUD | `#/hud` | 2 | The card stack |
| Icon ring | `#/ring` | 3 | A row of icons that opens while the pointer rests on her |
| Command layer | `#/cmd` | Pop-up menu level | The command ring, or camera and motion, one layer at a time |
| Console | `#/console` | Pop-up menu level | The card under the menu bar icon |
| Status chip | `#/chip` | 1 | The dot beside the bubble |

- On macOS the panels are `type: 'panel'` with `setPreventsActivation`, above every Space and full-screen app (`overlayOptions` and `makeOverlay` in `platform/index.ts`).
- Panels pass clicks through by default (`setIgnoreMouseEvents(true, {forward: true})`). The main process checks the pointer every 1/30 s and takes clicks only inside the interactive regions the page reports. The page reports its regions and content size through `window.setInteractiveRegions` and `window.setContentSize`.
- Panels follow her: her body box comes from C3 `hit_capsules` and `placement`, the rules are in `common/desktop-follow.ts` and `common/desktop-layout.ts`, and the resulting anchor goes to the page's `window.onAnchor`.
- Cards come from `common/stack-source.ts`: it polls `/approvals`, `/tasks`, `/agent/interactions`, `/agent/tasks` and `/commitments?state=triggered` for approval, code review, question, delivery and reminder cards, and turns `/feed` `announce` events into cards by the `notify_*` settings. The shell adds its own cards (push-to-talk hints, things dropped on her, notices).
- Keyboard: panels do not take focus by default. `window.requestKey` makes a panel key only while it is shown and within 1 s of a mouse press in its regions; opening the command layer makes its panel key at once. Becoming key uses the panel window's `focus()`, which does not activate this app, so the front app stays in front. `window.releaseKey` gives the keyboard back.
- Dragging: a region the page reports with `drag: true` drags the panel. On release, a panel within 12 pt of its default position goes back to it; one more than 400 pt from her body box stays pinned there; otherwise the side and gap (at most 96 pt) relative to her are kept, and the panel keeps that offset as it follows her. Offsets persist across launches under `desktopPanelOffset.v3.<panel>` in `desktop-offsets.json` in the support directory.

## Tray and menus

On macOS a left click on the menu bar icon opens or closes the console; a right click or an Option left click closes the console and pops up the menu. Without the desktop panels a left click also pops up the menu (`desktop/tray.ts`). On Windows the tray menu is the right-click context menu.

## Character page preview

On macOS the main window's character page connects to the renderer's preview XPC service (the C3 contract's 附录：预览 XPC (appendix: preview XPC)). The service name is the main bundle id plus `.preview`, so the service must be in this app's `Contents/XPCServices/<bundle id>.preview.xpc`. The development Electron.app in `node_modules` lacks it. The dev console (`tools/dev/dev_console.py`) clones Electron.app into `.local/cache/dev-console/electron-dist/`, puts the current `metal-avatar-host` build in it as the preview service, and starts the shell from that clone with `ELECTRON_OVERRIDE_DIST_PATH`. A shell started with `node_modules`' Electron directly reports 预览服务断开了 (preview service disconnected) on the character page preview, and the page falls back to a still portrait.

The main process imports each frame's IOSurface with `sharedTexture.importSharedTexture` and passes it to the main window through `sendSharedTexture`; the preload draws it into the rectangle the page reports. A hidden or minimized window, or a page that hides the preview, sends `pause`; coming back sends `resume`. Windows has no preview channel yet, and `avatar.preview.*` answers `not_implemented`.

## Platform helper

`ac-helper` is the layer between the shell and the system: the macOS one is `app/helpers/mac` in Swift, the Windows one is `app/helpers/windows` (`ac-helper.exe`) in C++. The main process starts it and talks to it over stdin and stdout with the NDJSON protocol of [C12](../../protocol/C12-platform-helper/CONTRACT.md); stderr is its log. The helper only calls system APIs and returns raw readings; policy stays in the main process.

- macOS: AppKit's ops and the watches run on the main thread, whose run loop the helper keeps running; the other ops run on a concurrent queue.
- Windows: each request other than `hello`, `cancel` and `shutdown` runs on its own thread. One lock guards stdout and the set of requests in flight, so every request gets exactly one answer: from its handler, from `cancel` (`cancelled`), or from `shutdown` (which answers every request in flight with `cancelled` before its own answer).
- The Windows helper uses its own JSON parser of about 300 lines rather than a third-party single header: C12 must tell `1` from `1.0`, refuse NaN and deep nesting, and pass UTF-8 through, and no vendored code needs licence and update tracking.

## Platform helper and permissions

- System permission prompts name the app (the helper's responsible process), not the helper. A helper started from a terminal gets the terminal's grants.
- `permissions.status` maps the helper's readings to the page's values (`src/main/ops/permissions.ts`): `notApplicable` becomes `unsupported`; Screen Recording and Accessibility read `notDetermined` until granted, because the system cannot tell a refusal from a grant never asked. Electron cannot read the notification grant, so it is always `unsupported`.
- `permissions.openSettings` opens the matching system settings page. On macOS the Screen Recording and Accessibility pages first call the helper's `permissions.request` once, so the app appears in that page's list. Windows has only the microphone page (`ms-settings:privacy-microphone`); other pages answer `failed`.

## Coordinate spaces

- The placement space (`src/common/placement.ts`) is one global space, y up, main display first.
- C3: on macOS AppKit points with y up, the same as the placement space; on Windows physical pixels with y down, which the shell converts through `screen.dipToScreenRect` and then negates y (`src/main/platform/screens.ts`).
- The helper: origin at the main display's top left, y down. The main process maps it to C3 by platform: flipped to AppKit coordinates on macOS, unchanged on Windows (`HelperY` in `common/attention.ts`).

## Privacy rules

Attention sampling (one tick per second; reads the front window, titles and input counts):

- The blacklist `<agentd_state_dir>/blacklist.json` filters by bundle, app name, domain and subdomain, and title regex. The shell's own processes and its own bundle are always hidden.
- A browser window that may be private carries no title; a private front window is recorded as `<hidden>` as a whole; a browser whose private state is unknown sends only the app and bundle id.
- Secure input sends no title. With `redact_sensitive` on, titles are redacted first, then cut to 256 code points.
- When a hidden front window is under the mouse, the window under the mouse is hidden too.

Screen context (reading the front window's text, OCR, screenshots):

- Nothing is read or sent for the blacklist (which includes the shell's own processes), private windows, browsers whose private state is unknown, or secure input.
- Password field nodes are never sent. With `redact_sensitive` on, text and titles are redacted first, and titles are cut to 512 code points.
- When the user narrows consent, `POST /context/privacy/sync` withdraws what was sent.
- When reading the selection, clipboard items marked concealed or transient are not read.

With `--no-attention` none of these samplers is built, and the helper gets no window-reading requests.

## Computer control

`src/common/computer-control.ts` holds the pure rules for grants, counts and time limits, and request checks; `src/main/control/` calls the helper. Grant lifetimes and counts are in the [tool gateway](tool-gateway.en.md). The shell-side rules:

- Grants are per session, per exact window (process generation and geometry), and per each of four permissions; they come only from the user's button presses in the authorization panel. Without a grant a request answers `permission_required`; while another session holds the desktop it answers `desktop_busy`.
- A snapshot expires after 15 s and every action voids all snapshots; two actions are at least 250 ms apart.
- Browsers answer `browser_driver_required`. Blacklisted apps and window titles answer `blacklisted`, also when the blacklist has title rules and the title cannot be read. The shell's own processes cannot be targets. A changed window answers `target_changed`.
- The user's own key presses, clicks or scrolls pause the task and void snapshots; after 继续 (Continue) the session must observe again. Without input monitoring from the helper no action runs (`input_monitor_unavailable`). The helper judges password fields, secure input, the front window and occlusion.
- Stop, cancel, revoking a grant and user takeover interrupt at once: requests in flight answer `stopped`, and a `control.act` already sent to the helper gets a C12 `cancel`.

## Global hot keys

The shell registers these hot keys with Electron's `globalShortcut` once the desktop panels are up; the settings page can change them.

| config.json key | Default | Action |
|---|---|---|
| `hotkey_quick_input` | `control+option+space` | Open quick input |
| `hotkey_look` | `control+option+l` | Look at the screen |
| `hotkey_toggle_avatar` | `control+option+h` | Show or hide the character |
| `hotkey_click_through` | `control+option+p` | Temporary click-through for everything |
| `hotkey_radial_menu` | `control+option+r` | Open or close the command ring |
| `hotkey_selection` | `control+option+s` | Read the selected text and send it with quick input |
| `voice_hotkey` | `right_option` | Push to talk (registered through the helper) |

An empty value registers nothing. Names that fail to register (taken by another program, or not a hot key) are marked on the settings page. With `--no-attention` none is registered.

## Push to talk

`src/common/push-to-talk.ts` combines the helper's ops:

- While agentd runs and the helper has shaken hands, the shell registers `voice_hotkey`. `right_option` starts after being held 0.15 s; a key combo starts at once.
- Starting first interrupts her: a C3 `stop_speech`, then `POST /turn/cancel` (`reason: "barge_in"`). With the microphone granted it records; when undecided it shows the system prompt first and does not record this time.
- On release, a hold under 0.3 s or no recognized text sends nothing; otherwise it sends `POST /say` (`source: "voice"`). Each send carries a new `Idempotency-Key`, and a dropped connection is retried once with the same key.

## External services

TTS (`tts`), the motion service Kimodo (`motion`) and the OpenAI-compatible model API (`llm`) run outside the agent. Each service is described by `services.<id>` in config.json, which the 服务 (Services) group in Settings edits.

- Fields: `mode`, `url`, `ssh_host`, `start_script`, `command` (an argv array), `cwd`. A missing field takes its default; an unknown field or a field of the wrong type makes config.json fail validation (`serviceRecord` in `src/common/config.ts`).
- `mode` picks one of four ways to connect: `off` disables the service; `url` connects straight to `url` and the shell starts no process; `ssh` forwards the port of `url` over SSH; `local` has the shell run `command` on this machine.
- Validation: `url` is an http, https, ws or wss address. Under `ssh` and `local`, `url` must be a loopback address with a port. Under `ssh`, `ssh_host` must not be empty, start with `-`, or hold whitespace or control characters. Under `local`, `command` must not be empty. For `llm` over http, only a loopback address is allowed; another host needs https.
- Process management (`ServiceSupervisor` in `src/main/services/supervisor.ts`, one per service): under `ssh`, the shell runs `app/Resources/parent_watch.py` with runtime.python, which starts `ssh -N -L 127.0.0.1:<port>:127.0.0.1:<port> <host>`; under `local`, it runs `command` in `cwd`, and the service counts as running once its port listens. The process exits with the shell.
- When the port is taken: under `ssh`, if every holder is this user's ssh, the shell reuses it, the state is `external`, and it checks again after 60 s; otherwise the state is 端口 <port> 被占用 (port in use). Under `local`, the state is always 端口 <port> 被占用. A missing `cwd` gives the state 工作目录不存在 <cwd> (working directory missing).
- After a crash it restarts with agentd's backoff. Stopping sends SIGTERM, then SIGKILL after 4 s.
- The output of all three services goes to `logs/services.log`.
- Remote script: under `ssh` with a non-empty `start_script`, both the shell and agentd call `ssh -o BatchMode=yes -o ConnectTimeout=5 -- <host> <script> ensure|stop|status`. `ensure` answers `ready <seconds>` or `fail <reason>` on its first line; `stop` answers `stopped` or `fail <reason>`; `status` answers `running …` or `stopped`.
- When a save of an `ssh` record changes `start_script` or `ssh_host`, the shell first asks for confirmation, naming the host the script will run on.
- Bridge ops (`protocol/ui-bridge/ops.json`, implemented in `src/main/ops/services.ts`): `services.read` reads the three records in config.json; `services.save` stores one record and restarts that service and agentd; `services.start`, `services.stop` and `services.restart` control one service, and under `ssh` with a script they also run the remote `ensure` or `stop`. `services` in `app.runtime` reports each service's state.
- agentd arguments: `--<id>-url` when the service is not `off`; under `ssh`, always `--<id>-ssh-host`, and with a `start_script` also `--<id>-ensure-host` and `--<id>-ensure-script` (C9).

## Single instance and page guard

- One shell per support directory: `app.requestSingleInstanceLock` takes the lock after `userData` is set to `<support dir>/electron`, so runs with different `--config` do not block each other. Without the lock the shell logs `LOCKED …` and exits 0.
- Page guard (`src/main/web-guard.ts`): navigation is allowed only to `agentic-complex-ui://app`, and http(s) links go to the system browser; pages cannot open new windows; the context menu appears only in editable fields and over selected text.
- Error-level console messages of a page go to `ui.log` in the page log directory: at most 60 lines a minute, each cut to 4096 bytes, moved to `ui.log.1` at 1 MiB.

## Logs and error records

- A `.log` under `<support dir>/logs/` past 20 MiB moves to `.log.1` (one generation): at shell start; while running, a log the shell writes itself at each line it writes, the others (`avatar.log`, `agentd.log` and the rest that children hold open) at most once a minute, copied to `.1` and emptied in place, so the child writes on from the start.
- Error records go to `logs/error.jsonl` (`src/common/error-record.ts`), one JSON object a line: `{t, component, code, message, detail?, turn_id?, trace_id?, req?, count}`. `t` is ISO time; `component` is one of `shell`, `renderer-link`, `bridge`, `page`, `agentd`, `host`, `helper`, `tts`; `message` is cut to 300 characters, `detail` to 500. No prompt text, tool input, op arguments or secrets.
- The first occurrence of a (`component`, `code`, `message`) is written at once with `count` 1; its repeats within 60 s become one line when that minute is over, `count` being the repeats, and one line a minute while they go on. The total of an error is the sum of its lines' `count`. At quit the counts not yet written are written.
- `code` is one of these only (`ERROR_CODES`):

| code | Written by | message |
|---|---|---|
| `op_failed` | bridge: an op the page called failed | `<op> <bridge error code>`, `req` the op |
| `host_exit` | host: the renderer exited on its own (non-zero or by a signal) | `status=<n>` or `signal=<n>`, `detail` the last `error:` line of that run's output |
| `host_message_rejected` | renderer-link: the renderer sent a message against C3 | `type=<type> why=<field or reason>` |
| `permission_denied` | helper: a system grant is missing | `<grant> <op>`, the grant `accessibility`, `screenRecording`, `inputMonitoring` or `microphone`, `req` the op |
| `page_exception` | page: an exception of a page (caught by an error boundary, or uncaught) | `[<route>: ]<Type: message>`, `detail` the first component frame or the source |

- Noise: on one connection, `rejected type=… why=…` and `heartbeat stale` go out at most once a minute each, the skipped count riding on the next one as `(+N more)`; a `heartbeat resumed` only follows a logged stale. `desk: <panel> frame` at most once a minute per panel (the latest frame); the character page preview's frame-rate line after each load's first at most once a minute.
- 复制诊断信息 adds, after the error lines of companion.log and agentd.log, the last 50 error records, the last 40 lines of `avatar.log` (without the JSON run report of an exit) and the last 40 lines of `ui.log`.

## Quitting

Each SIGTERM and SIGINT calls `app.quit()`, the same path as the tray's 退出 (Quit): `will-quit` first stops the renderer, agentd and the helper (`src/main/quit.ts`). Electron's own handler takes only the first signal and then restores the default action, so a second signal while the children stop would kill the main process at once. Electron installs its handler after the main script's first run, so the shell installs its own after `app.whenReady()`. Windows has no SIGTERM to catch.

## Windows differences

- The renderer is `efw.exe`. Windows has no app bundle, so config.json must set `avatar_executable`. The shell connects to the named pipe the renderer creates and tells it the pipe name with `--agentic-complex-host-socket`.
- With a character library (`character_catalog`) the shell works out `--package <character dir>` for each character: the `current.json` entry → `components.render.native_bundle.file` of its `character.json` → that character's `vulkan_frame.file` in the bundle → the directory holding it. A character without `vulkan_frame` is not rendered on Windows, like a text-only character.
- Switching characters: the shell passes efw `--package-of <id>=<character dir>` for each renderable character, and efw answers `set_character` in process without a renderer restart; switching to or from a text-only character restarts it.
- 录屏时隐藏角色 (hide the character from screen capture, `hide_on_screen_capture`) defaults to off on Windows; changing it restarts the renderer.
- Default directories without `--config`: support directory `%APPDATA%\Agentic Complex`, agentd state directory `%LOCALAPPDATA%\Agentic Complex\agentd`, page logs `%LOCALAPPDATA%\Agentic Complex\Logs`.
- The Windows helper implements only the screen, window, clipboard, app, process, permission, attention sampling, watch and capture ops. The push-to-talk, computer control, accessibility reading and OCR ops answer `unsupported`.
- There is no character page preview, installer or signing.

## Adding a helper op

macOS (`app/helpers/mac`):

1. Write the op and add it to `Ops.handlers`.
2. Add it to `IMPLEMENTED` in `Tests/replay.py` with a check of its result in `check_answer`, and to `NEEDS_AX` when it needs the Accessibility grant.
3. When `ops.json` changes, copy the change into `OpTable.specs` and `Ops.events`.

Windows (`app/helpers/windows`):

1. Write `Outcome my_op(const json::Value& params)` in `src/ops_win32.cpp` (or a new `src/*.cpp`; `build.bat` compiles them all). `params` has already passed the `ops.json` check. Return `success(result)` or `failure(code, message)`; the code is a common C12 code or one in the op's `errors`, and the message never holds what the op read.
2. Add it to the table in `find_handler`. From then on `hello` lists it; before that it answers `unsupported`.
3. Add it to `IMPLEMENTED` in `tests/replay.py`, with a check of its result in `check_answer` when the fixtures allow one.
4. When `ops.json` changes, copy the change into `op_specs()` in `src/ops.cpp`; the replay fails when the two disagree about required params.
5. Ops that touch UI Automation run on one MTA thread and set their own timeouts (C12 §5.3); ops that open listeners or devices stop before the `shutdown` answer (C12 §6.1).
