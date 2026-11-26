# Product guide

[简体中文](product.md) · [Documentation index](README.en.md) · [Project README](../README.en.md)

**Agentic Complex** is an experimental desktop character app primarily targeting Apple Silicon macOS (with Windows x64 support in active development) that brings character interaction, a personal agent, and activity review into one app. The desktop character handles quick interactions, while the main window serves as the control panel: it opens on the watch-style **Home** hub (`主页`): a tilted 3D watch face: page keys on the left, tool keys on the right, a centre disc with 待处理 (pending) and 进行中 (in progress) pages that you switch by tab or by swiping sideways, today's task progress below it, a character card with what she is doing, her outfit and the render frame rate, and the clock, connection state and reminder banner at the top right. The top command bar switches across **Briefing** (`每日简报`, `⌘1`), **Chat** (`对话`, `⌘2`), **Memory** (`记忆`, `⌘3`), **Character** (`角色`), **MMD**, and **Settings** (`设置`, `⌘,`); developer mode adds **Diagnostics** (`诊断`, which now holds the former Trace page). **Pipeline** (`管线`) is a developer-mode tab of the Memory page, and **Schedules** (`定时任务`) has no navigation entry: open it from Briefing. The Home pages 待处理 / 进行中 pages and today's task progress need the Daily Brief feature to be on; with it off the whole block is unavailable. This guide follows the feature order of the [README](../README.en.md) and explains usage and operational details.

> [!CAUTION]
> **Experimental & Early-Stage Notice**
>
> This project is still in early development and intended solely for development and learning. You may encounter rendering glitches, unexpected token consumption, partially wired or non-functional features, and rough or broken page layouts. We strongly recommend running and troubleshooting it **with the help of an AI Agent**, using **Diagnostics** and logs to inspect errors and keep an eye on model routing and privacy switches.

## Personal agent

| What you want to do | How it works |
| --- | --- |
| Chat for a moment | Use quick input (`⌃⌥Space`), push-to-talk (macOS), or open or resume a character conversation on the **Chat** (`对话`, `⌘2`) page. |
| Give the character a task | Describe the goal, constraints, and expected result. Check **Briefing** (`每日简报`, `⌘1`) for run status, follow-up questions, approval requests, and deliverables; inspect raw step details under 对话轮次 on **Diagnostics** (developer mode). |
| Dispatch a coding task | Choose Claude Code or Codex, a working directory, and a permission mode from the task entry on Briefing or Home. **Briefing** aggregates both character tasks and coding sessions. |
| Set reminders and schedules | Ask the character to note a reminder. A due reminder shows as a desktop bubble; once the card appears it counts as seen and a non-repeating reminder is then done. To snooze it or change its time, tell the character in the conversation, or snooze, complete or cancel it from the reminders on the main window's **Briefing** page. Configure recurring tasks on **Schedules** (`定时任务`, opened from Briefing) to run daily, weekly, or when a matching coding session ends. |

**Kernels, routing, and models.** Settings › 内核 (Kernel) lists available execution kernels:

- Bundled **Pi** (default, using the included Node SDK runtime).
- Locally installed **Codex** or **Claude Code**.
- Another local agent tool connected through **ACP** (local commands or `npx`/`uvx` agents).

Local kernel executables are detected automatically by default or can be chosen manually. The account source is the CLI tool's own login by default; Codex can also use API credentials. Pi's providers are configured in Settings › 内核 › 账号 (Kernel › Account), supporting **Anthropic API**, **DeepSeek**, **Grok / xAI**, **OpenAI API**, **OpenAI-compatible APIs** (including keyless local loopback), additional providers from Pi's offline catalog (**其他（Pi 目录）**), and **ChatGPT subscriptions**.

With developer mode on and 外部执行内核接入 (external kernel access) on in Settings › 内核, Settings › 内核 › 模型 shows 按用途分配执行内核 (Route kernels by purpose), where you can assign separate kernels, models, and reasoning efforts for **对话 (chat)**, **后台任务 (background tasks)**, **主动判断 (proactive judge)**, **屏幕理解 (screen understanding)**, **记忆与日志 (memory and journal)**, and **电脑操控 (computer control)**. Reply language is configured in Settings › 交流 › 语音与播报 › 回复语言 (跟随对话 / 简体中文 / English / 日本語 / 按内核设置).

Character persona, tone, and performance come from the character package, while the app manages tasks, memory, tool calls, and authorizations, and keeps them across kernel switches. See the [character conversation and runtime guide](architecture/agentd.en.md#character-kernels).

**Token & cost notice.** Enabling activity observation, daily/weekly briefs, proactive speech, or multi-step background tasks continuously triggers model calls. During experimentation:
- Monitor call counts, estimated costs, and turn context sizes in **Diagnostics** (`诊断`, developer mode);
- Configure Pi's per-run cost cap (`单次运行费用上限`) in Settings › 内核 › Pi 运行; with developer mode and 外部执行内核接入 on, also route lightweight tasks (judge, screen understanding) to smaller models or low effort under 按用途分配执行内核;
- Turn off the observation brief and proactive speech toggles when you do not use them.

**Memory.** The **Memory** (`记忆`, `⌘3`) page stores user-confirmed facts, project work tasks, and sourced records. You can add, confirm, edit, or delete memories and open source links on supported entries. Facts extracted automatically from observed activity appear as candidates for review first.

## Companionship and awareness

- **Activity observation** is turned on in Settings › 感知 › 屏幕感知 (off by default). It reads the front app, windows, and recent activity per settings and permissions, and can be paused for 1 hour.
- **Filter modes**: Settings › 感知 › 遮蔽与排除 supports **allow-list mode** (`只读名单里的`, the default) by app name, bundle ID, or domain, and **exclude mode** (`名单外都读`), which can also exclude by window title regex. Incognito/private browser windows are always excluded.
- **Briefs** summarize observed activity. **Briefing** (`每日简报`) shows the day's timeline and daily report; daily and weekly briefs are toggled in Settings › 感知.
- **Proactive speech** is adjusted in Settings › 交流 › 主动交互: 主动交互 chooses between 仅响应对话 (answer only when asked) and 自动触发 (speak up), 主动交互频率 sets how often she speaks and moves, and 免打扰时段 (quiet hours), once on, takes several ranges in which she stays quiet. Break and water reminders are built into the character; 关闭此类 (Mute this kind) in the bubble menu turns one kind off.
- **Do not disturb** is in the menu on the **Briefing** page: **Quiet** pauses observation and shows reminder cards silently, and stays on until its end time even after the backend restarts; **Meeting** keeps reminders active during screen sharing. Notification methods per event kind are configured in Settings › 交流 › 通知送达.
- **Coding sessions**: when Read coding sessions is on, your own local Claude Code and Codex sessions are observed read-only: progress and "waiting for confirmation in X" show up, and approvals stay in the CLI. Only coding sessions the app dispatched produce approval cards and completion notices.
- **Proactive sharing**: `⌃⌥S` reads the selected text (or clipboard when nothing is selected) into quick input; `⌃⌥L` triggers screen reading.
- **The browser extension** is installed separately and reports regular Chrome tab status; page text and selection collection require separate toggles. See the [browser extension guide](guides/browser-extension.en.md).

## Desktop and rendering

- **Desktop panels** carry short replies, due reminders, and pending approval/question cards; you can handle them directly or look at them later.
- The character has no window frame and can be dragged anywhere. When covered by a window, she steps aside; she stays put when **自由活动 (Free roam)** is unchecked in the first level of the right-click command ring or in the menu-bar menu.
- When the front app is full screen, she hides by default, or remains at the screen edge for full-screen video or games.
- **Hide character while recording** is on by default on macOS (she hides once when recording or sharing starts; press `⌃⌥H` to show her again) and off by default on Windows; change it in Settings › 显示 › 桌面显示.
- `⌃⌥P` temporarily passes all clicks through the character and desktop panels.

## Characters, appearance and motion

The **Character** (`角色`) page switches character packages and browses the available motions and appearances through the rail on its right:

- **总览 (Overview)**: the character roster, to switch characters and import a character package.
- **外观 (Appearance)**: switch outfits and the part/color toggles that EFMI mods provide; its 导入 (Import) tab imports EFMI mod outfits.
- **动作 (Motion)**: Browse, preview and toggle motions included in the package. Live 3D preview is available when the connected renderer supports it. Its 编排 (Chain) tab (shown when the character has chains) inspects and composes motion chains, and its 导入 (Import) tab imports external motion files (VMD, BVH, glTF, GLB, VRMA, FBX; when you drop files directly onto the character, only VMD and ZIP are imported as motions).
- **设定 (Setup)**: adjust character-specific behavior, rendering parameters, and stage/scene settings.
- **MMD** (in the rail only when a character renderer is available): opens the **MMD** page, the shared MMD dance library for playing, renaming, and deleting imported VMD/ZIP dances with optional background music.

If switching the character or appearance from the menu bar fails, the desktop shows a notice that says why.

Photos of the character (transparent-background captures) are on the desktop character's quick wheel: pick 拍照 (Photo), set aperture and focus in the bar under her, then press the shutter.

Renderable character packages supply models and assets; text-only packages (such as the public sample `aide`) can still be used for conversations. The persona and setting come with the package. See [motion import](guides/motion-import.en.md) for supported formats and limits.

## Voice

- **Push-to-talk (macOS)**: hold the right `Option` key to speak and release to send; select recognition language in Settings › 交流 › 语音与播报. If recording cannot start, the desktop shows a notice that says why. Push-to-talk is not yet implemented on Windows.
- **Speech synthesis**: replies are read aloud in the character's voice when an external TTS service is configured. **Without an external TTS service configured, replies are shown as text only (no speech).** When a line cannot be read aloud (invalid token, service unavailable or unreachable), the desktop shows a notice that says why. Choose the connection in Settings › 服务 (Services); see [deploying the voice service](guides/tts-deploy.en.md).

## Privacy and data

- Window text, page text, typed text, coding sessions, screenshots, input counts, and microphone-using apps each have independent switches, plus outbound sensitive-content redaction.
- Configuration and run records stay in the local support directory (on macOS `~/Library/Application Support/local.agenticcomplex.companion/` and `AgenticComplex/agentd/`); manage stored records and the archive retention under Settings › 数据.
- When a model backend or external TTS service is enabled, the required request context or spoken text is sent to the configured endpoint.

## Window actions and permissions

Computer use is off by default. When enabled, supported sessions can request to inspect controls, read text, capture a screenshot, or act within a specified native app window; each capability is authorized individually in the floating permission prompt and can be stopped or expire. The computer-use bridge covers native app windows; the Chrome extension provides browser context. See the [computer-use guide](architecture/tool-gateway.en.md#computer-use) and [tool gateway](architecture/tool-gateway.en.md).

Check system permissions in Settings › 能力 › 系统权限 (grantable on demand when a feature is used):

| Permission | Use |
| --- | --- |
| Microphone, Speech Recognition, Input Monitoring | Push-to-talk (macOS) |
| Accessibility | Reading window text, operating the computer |
| Screen Recording | Screen reading and screenshots |
| Automation | Jumping to coding sessions in terminal apps |
| Notifications | When using macOS system notifications |

System permissions control what the app can read; the in-app settings then control what it reads and shares.

## Runtime and diagnostics (early-stage troubleshooting)

The Electron shell manages windows, the tray, and child processes, and the main window and desktop panels are its web windows; the native helper `ac-helper` provides platform services such as system permissions; Python `agentd` manages conversations, tasks, memory, and tool calls; and the Metal host (or WIP Windows `efw.exe`) renders the character and plays its motions. External TTS provides the voice, and the character package provides the performance assets.

When debugging rendering issues, unwired controls, kernel errors, or unexpected token consumption (ideally alongside an AI Agent):

- **Developer mode**: enable **开发者模式 (Developer mode)** in Settings › 关于 › 排障 to unlock the **Diagnostics** (`诊断`) page and the Memory page's **Pipeline** (`管线`) tab, plus internal metrics (2× SSAA, render dimensions, turn generations); you can also re-run **首次设置 (Onboarding)** in the same group.
- **Diagnostics (`诊断`)**: shown in the top bar in developer mode (also reachable from the Home page's right-hand tool keys) to inspect subprocess health, connections, today's model call counts and estimated cost, recent turns and failure events, and the source of a dev deployment; its 对话轮次, 事件线 and 日志 tabs hold the record of each model run and its tool calls.
- **Settings › 关于 › 排障**: in developer mode, restart `agentd` when it is not running (while it runs, use the restart menu on Diagnostics) and open `config.json`; opening the logs directory and copying sanitized diagnostics (without chat or memory text) need no developer mode. Reset settings to defaults (the kernel and credentials stay) is in Settings › 数据.

A release can be one portable app or an app with a split components directory; see [runtime architecture](architecture/overview.en.md) and [release components](components.en.md).
