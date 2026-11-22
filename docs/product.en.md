# Product guide

[简体中文](product.md) · [Documentation index](README.en.md) · [Project README](../README.en.md)

**Agentic Complex** is an experimental desktop character app primarily targeting Apple Silicon macOS (with Windows x64 support in active development) that brings character interaction, a personal agent, and activity review into one app. The desktop character handles quick interactions, while the main window serves as the control panel: it opens on the watch-style **Home** hub (`主页`): a tilted 3D watch face: page keys on the left, tool keys on the right, a centre disc with 待批准 / 在做 / 今日 pages that you switch by tab or by swiping sideways, today's task progress below it, a character card with what she is doing, her outfit and the render frame rate, and the clock, connection state and reminder banner at the top right. The top command bar switches across **Briefing** (`工业简报`, `⌘1`), **Chat** (`对话`, `⌘2`), **Memory** (`记忆`, `⌘3`), **Character** (`角色`), **Schedules** (`定时任务`), **Trace** (`运行记录`), **Diagnostics** (`诊断`), and **Settings** (`设置`, `⌘,`), plus developer-mode pages (**Pipeline** and **Tune**). This guide follows the feature order of the [README](../README.en.md) and explains usage and operational details.

> [!CAUTION]
> **Experimental & Early-Stage Notice**
>
> This project is still in early development and intended solely for development and learning. You may encounter rendering glitches, unexpected token consumption, partially wired or non-functional features, and rough or broken page layouts. We strongly recommend running and troubleshooting it **with the help of an AI Agent**, using **Diagnostics**, **Trace**, and logs to inspect errors and keep an eye on model routing and privacy switches.

## Personal agent

| What you want to do | How it works |
| --- | --- |
| Chat for a moment | Use quick input (`⌃⌥Space`), push-to-talk (macOS), or open or resume a character conversation on the **Chat** (`对话`, `⌘2`) page. |
| Give the character a task | Describe the goal, constraints, and expected result. Check **Briefing** (`工业简报`, `⌘1`) for run status, follow-up questions, approval requests, and deliverables; inspect raw step details on **Trace** (`运行记录`). |
| Dispatch a coding task | Choose Claude Code or Codex, a working directory, and a permission mode from the task entry on Briefing or Home. **Briefing** aggregates both character tasks and coding sessions. |
| Set reminders and schedules | Ask the character to note a reminder and acknowledge or snooze it on desktop cards. Configure recurring tasks on **Schedules** (`定时任务`) to run daily, weekly, or when a matching coding session ends. |

**Kernels, routing, and models.** Settings › 角色内核 (Character kernel) lists available execution kernels:

- Bundled **Pi** (default, using the included Node SDK runtime).
- Locally installed **Codex** or **Claude Code**.
- Another local agent tool connected through **ACP** (local commands or `npx`/`uvx` agents).

Local kernel executables are detected automatically by default or can be chosen manually. The account source is the CLI tool's own login by default; Codex can also use API credentials. Pi's providers are configured in Settings › pi 账号与凭据 (pi account and credentials), supporting **Anthropic API**, **DeepSeek**, **Grok / xAI**, **OpenAI API**, **OpenAI-compatible APIs** (including keyless local loopback), additional providers from Pi's offline catalog (**其他（Pi 目录）**), and **ChatGPT subscriptions**.

Under Settings › 角色内核 › 按用途指定 (Route by purpose), you can assign separate kernels, models, and reasoning efforts for **对话 (chat)**, **后台任务 (background tasks)**, **主动判断 (proactive judge)**, **屏幕理解 (screen understanding)**, **记忆与日志 (memory and journal)**, and **电脑操控 (computer control)**. Reply language is configured in Settings › 说话与通知 › 回复语言 (跟随对话 / 简体中文 / English / 日本語 / 按内核设置).

Character persona, tone, and performance come from the character package, while the app manages tasks, memory, tool calls, and authorizations, and keeps them across kernel switches. See the [character conversation and runtime guide](architecture/agentd.en.md#character-kernels).

**Token & cost notice.** Enabling activity observation, daily/weekly briefs, proactive speech, or multi-step background tasks continuously triggers model calls. During experimentation:
- Monitor call counts, estimated costs, and turn context sizes in **Diagnostics** (`诊断`) and **Trace** (`运行记录`);
- Configure Pi's per-run cost cap (`单次费用上限`) in Settings › 角色内核 › 限额 (Limits) and route lightweight tasks (judge, screen understanding) to smaller models or low effort;
- Turn off the observation brief and proactive speech toggles when you do not use them.

**Memory.** The **Memory** (`记忆`, `⌘3`) page stores user-confirmed facts, project work tasks, and sourced records. You can add, confirm, edit, or delete memories and open source links on supported entries. Facts extracted automatically from observed activity appear as candidates for review first.

## Companionship and awareness

- **Activity observation** is turned on in Settings › 隐私 › 观察 (off by default). It reads the front app, windows, and recent activity per settings and permissions, and can be paused for 1 hour.
- **Filter modes**: Settings › 隐私 supports **allow-list mode** (`只读名单里的`, the default) by app name, bundle ID, or domain, and **exclude mode** (`名单外都读`), which can also exclude by window title regex. Incognito/private browser windows are always excluded.
- **Briefs** summarize observed activity. **Briefing** shows the day's timeline and daily report; daily and weekly briefs are toggled in Settings › 隐私.
- **Proactive speech** is adjusted in Settings › 说话与通知 › 主动程度: proactivity level controls frequency, the 主动发言 (proactive speech) switch controls whether she speaks up when something is worth mentioning, 主动提示 (proactive hints) controls whether she offers help when she sees a chance, and break reminders trigger after continuous usage.
- **Do not disturb** is in Settings › 说话与通知 › 免打扰: **Quiet** pauses observation and shows reminder cards silently; **Meeting** keeps reminders active during screen sharing. Notification methods per event kind are also configured here.
- **Coding sessions**: when Read coding sessions is on, progress, completions, and approval prompts from local Claude Code and Codex sessions show as desktop notifications and approval cards.
- **Proactive sharing**: `⌃⌥S` reads the selected text (or clipboard when nothing is selected) into quick input; `⌃⌥L` triggers screen reading.
- **The browser extension** is installed separately and reports regular Chrome tab status; page text and selection collection require separate toggles. See the [browser extension guide](guides/browser-extension.en.md).

## Desktop and rendering

- **Desktop panels** carry short replies, due reminders, and pending approval/question cards; you can handle them directly or look at them later.
- The character has no window frame and can be dragged anywhere. When covered by a window, she steps aside; she stays put when **自由活动 (Free roam)** is unchecked in the context menu's 更多 (More) submenu.
- When the front app is full screen, she hides by default, or remains at the screen edge for full-screen video or games.
- **Hide character while recording** is on by default on macOS (she hides once when recording or sharing starts; press `⌃⌥H` to show her again) and off by default on Windows; change it in Settings › 说话与通知 › 免打扰.
- `⌃⌥P` temporarily passes all clicks through the character and desktop panels.

## Characters, appearance and motion

The **Character** (`角色`) page switches character packages and browses the available motions and appearances across its top tabs:

- **动作 (Motion)**: browse, preview (live 3D on macOS when the character is connected and the preview XPC service is available; not yet on Windows), and toggle motions included in the package.
- **编排 (Chain)**: inspect and compose motion chains.
- **外观 (Appearance)**: switch outfits and the part/color toggles that EFMI mods provide.
- **设定 (Setup)**: adjust character-specific behavior, rendering parameters, and stage/scene settings.
- **拍照 (Photo)**: open the photo panel to take photos of the character (including transparent-background captures).
- **MMD**: shared MMD dance library for playing, renaming, and deleting imported VMD/ZIP dances with optional background music.
- **导入 (Import)**: import EFMI mod outfits and external motion files (VMD, BVH, glTF, GLB, VRMA, FBX; when you drop files directly onto the character, only VMD and ZIP are imported as motions).

Renderable character packages supply models and assets; text-only packages (such as the public sample `aide`) can still be used for conversations. The persona and setting come with the package. See [motion import](guides/motion-import.en.md) for supported formats and limits.

## Voice

- **Push-to-talk (macOS)**: hold the right `Option` key to speak and release to send; select recognition language in Settings › 说话与通知. Push-to-talk is not yet implemented on Windows.
- **Speech synthesis**: replies are read aloud in the character's voice when an external TTS service is configured. **Without an external TTS service configured, replies are shown as text only (no speech).** See [deploying the voice service](guides/tts-deploy.en.md).

## Privacy and data

- Window text, page text, typed text, coding sessions, screenshots, input counts, and microphone-using apps each have independent switches, plus outbound sensitive-content redaction.
- Configuration and run records stay in the local support directory (on macOS `~/Library/Application Support/local.agenticcomplex.companion/` and `AgenticComplex/agentd/`); manage stored records and the archive retention under Settings › 数据.
- When a model backend or external TTS service is enabled, the required request context or spoken text is sent to the configured endpoint.

## Window actions and permissions

Computer use is off by default. When enabled, supported sessions can request to inspect controls, read text, capture a screenshot, or act within a specified native app window; each capability is authorized individually in the floating permission prompt and can be stopped or expire. The computer-use bridge covers native app windows; the Chrome extension provides browser context. See the [computer-use guide](architecture/tool-gateway.en.md#computer-use) and [tool gateway](architecture/tool-gateway.en.md).

Check system permissions in Settings › 权限与授权 (grantable on demand when a feature is used):

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

- **Developer mode**: enable **开发者模式 (Developer mode)** in Settings › 启动与关于 to unlock **Pipeline** (`管线`) and **Tune** (`调参`), plus internal metrics (2× SSAA, render dimensions, turn generations); you can also re-run **首次设置 (Onboarding)** here.
- **Diagnostics (`诊断`)**: open it from the page menu or click the backend/kernel/character status lights at the right of the top bar to inspect subprocess health, connections, today's model call counts and estimated cost, recent turns and failure events, and the source of a dev deployment.
- **Trace (`运行记录`)**: inspect the record of each model run and its tool calls.
- **Settings › 高级 (Advanced)**: restart `agentd` when it is not running (while it runs, use the restart menu on Diagnostics), open `config.json`, open the logs directory, copy sanitized diagnostics (without chat or memory text), or reset settings to defaults (the kernel and credentials stay).

A release can be one portable app or an app with a split components directory; see [runtime architecture](architecture/overview.en.md) and [release components](components.en.md).
