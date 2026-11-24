# Agentic Complex (Endfield Desktop Character)

[简体中文](README.md)

> [!CAUTION]
> **Experimental Project · For Development and Learning Only**
>
> This is an **experimental project intended solely for development and learning**. It is still in **early development** and should not be treated as stable everyday consumer software. When running it, you may encounter:
> - **Rendering issues**: visual glitches, flicker, misalignment, or high GPU/CPU overhead on the transparent desktop overlay, regional rendering bounds, lighting, or retargeted animations;
> - **Abnormal token consumption**: background activity observation, briefs, proactive speech judges, and multi-step tool runs continuously make LLM requests and can incur unexpected API costs if misconfigured or looped;
> - **Unwired or broken features**: some UI controls, bridge operations, platform capabilities (especially the work-in-progress Windows port), or external integrations may be incomplete, stubbed, or disconnected;
> - **Rough or chaotic page UI**: the control panel and desktop overlays are under active iteration, so layout issues, missing states, or mismatched text may appear—especially in public builds without bundled art assets.
>
> **Recommendation**: We strongly recommend configuring, troubleshooting, and operating this project **with the assistance of an AI Agent** (such as Codex or Claude Code) to inspect logs, verify model routing and cost caps, and navigate development issues safely.

**Agentic Complex** (repository directory `Endfield`) is an experimental desktop character app and character-package development framework. It renders compatible character packages on the desktop and embeds a personal agent with switchable execution kernels for text/voice conversation, task execution, memory management, and optional desktop awareness.

- **Primary platform**: Apple Silicon Mac (macOS 15 or later), built with an Electron shell, a native Swift Metal renderer, and a Swift platform helper.
- **Windows x64 (WIP / Experimental)**: A Vulkan renderer (`efw.exe`), Windows helper (`ac-helper.exe`), and portable directory packaging are under active development and not yet feature-complete (e.g., push-to-talk and live 3D character-page previews are not implemented yet).
- **Assets & fan notice**: This repository ships no game assets or release character library; the public profile ships no characters and provides only a text-only example character, `aide`, under `characters/sample-library/` for testing and learning. See the [unofficial fan project notice](#unofficial-fan-project-notice) below.

## Features

### Personal agent

- **Main window & control panel**: The main window opens on **主页 (Home)**—a tilted 3D watch face: page keys on the left, tool keys on the right, a centre disc with 待批准 / 在做 / 今日 pages that you switch by tab or by swiping sideways, today's task progress below it, a character card with what she is doing, her outfit and the render frame rate, and the clock, connection state and reminder banner at the top right—while the top command bar navigates across **工业简报 (Briefing, `⌘1`)** for today's timeline, pending approvals/questions, running tasks, and daily briefs; **对话 (Chat, `⌘2`)**; **记忆 (Memory, `⌘3`)**; **角色 (Character)**; **定时任务 (Schedules)**; **运行记录 (Trace)**; **诊断 (Diagnostics)**; and **设置 (Settings, `⌘,`)**. Enabling **开发者模式 (Developer mode)** in Settings › 启动与关于 unlocks additional pages such as **管线 (Pipeline)** and **调参 (Tune)**.
- **Memory**: The **记忆 (Memory)** page stores user-confirmed facts and sourced records; facts extracted from observed activity enter as candidates for your review.
- **Switchable kernels & per-purpose routing**: Choose the active execution kernel in Settings › 角色内核 (Character kernel): the bundled **Pi** runtime (default), locally installed **Codex** or **Claude Code**, or another local agent tool via **ACP**. You can also route individual purposes (chat, background tasks, proactive judge, screen understanding, memory/journal, computer control) to different kernels, models, and reasoning efforts. Character persona, conversation history, tasks, and memory stay in the app across kernel switches.
- **Accounts & credentials**: Local kernels reuse their own CLI login by default; Codex can also use API credentials. Pi's providers are configured in Settings › pi 账号与凭据 (pi account and credentials), supporting **Anthropic API**, **DeepSeek**, **Grok / xAI**, **OpenAI API**, **OpenAI-compatible APIs** (including keyless local loopback servers), additional providers from Pi's offline catalog (**其他（Pi 目录）**), and **ChatGPT subscriptions**. Reply language is configurable in Settings › 说话与通知 (Speech and notifications).
- **Token & cost warning**: Background observation, briefs, proactive speech, and multi-step runs trigger model calls. Monitor call counts, estimated costs, and turn traces in **诊断 (Diagnostics)** and **运行记录 (Trace)**, set the per-run cost cap in Settings › 角色内核 › 限额 (Limits, shown when Pi is selected), and keep unused background observation/proactive toggles off during experimentation.

### Companionship and awareness

- **Activity observation (off by default)**: When enabled in Settings › 隐私 (Privacy), the app records foreground app, window, and activity summaries locally and can generate daily or weekly briefs. Filtering supports both exclude mode (**名单外都读**) and allow-list mode (**只读名单里的**, the default).
- **Proactive speech & Do Not Disturb**: Choose when she speaks up, how often, and quiet-hour ranges in Settings › 交流 (Communication). Break and water reminders are built into the character; turn one kind off with 关闭此类 (Mute this kind) in the bubble menu. Quiet / Meeting modes cover quiet times and screen sharing.
- **Coding sessions**: When 读取编码会话 (Read coding sessions) is on and the hooks are installed, progress, completion, and approval requests from local Claude Code and Codex sessions appear on desktop overlays.
- **Desktop interactions**: Reacts to clicking body regions, dragging, and gifts from the context menu, and plays idle animations when inactive.

### Rendering and desktop

- **Native rendering**: Uses a native Metal pipeline (`metal-avatar-host`) on macOS with lighting and post-processing matched to the in-game character detail screen; Windows uses a work-in-progress Vulkan renderer (`efw.exe`).
- **Desktop behavior**: Borderless transparent overlay draggable anywhere on screen; automatically steps aside when covered by windows (or stays fixed when **自由活动 (Free roam)** is unchecked in the context menu's 更多 (More) submenu); hides by default behind full-screen apps while staying at the edge for full-screen video or games.
- **Hide while recording**: **录屏时隐藏角色 (Hide character while recording)** is on by default on macOS (she hides once when recording or sharing starts; press `⌃⌥H` to show her again) and off by default on Windows; change it under Settings › 说话与通知 › 免打扰.

### Characters, appearance and motion

- Switch character packages on the **角色 (Character)** page, whose top tabs cover **动作 (Motion)**, **编排 (Motion chain)**, **外观 (Appearance)**, **设定 (Setup)**, **拍照 (Photo)**, **MMD**, and **导入 (Import)**.
- Each character is a self-contained package containing models, motions, voice settings, and persona; see the [character package contract](protocol/character-library/CONTRACT.md).
- On 角色 › 导入 (Import), import EFMI mod outfits with part/color toggles, as well as VMD, BVH, glTF, GLB, VRMA, FBX, and VMD ZIP dances with background music (dropping directly onto the character accepts VMD and ZIP). See [motion import](docs/guides/motion-import.en.md).

### Voice

- **Push-to-talk (macOS)**: Hold the right `Option` key to speak and release to send; speech recognition runs locally via macOS speech frameworks.
- **Speech synthesis**: Replies can be read aloud when an external TTS service is configured. **Without an external TTS service configured, replies are shown as text only (no speech).**

### Privacy and computer use

- Activity observation and computer use are both off by default. Window text, page text, typed text, coding sessions, screenshots, input counts, and microphone-using apps each have their own toggle; outbound redaction and exclude/allow lists are also available.
- Computer use allows supported sessions to observe controls, read text, capture screenshots, or perform actions on native windows, after you authorize each window and each permission. See the [product guide](docs/product.en.md) for full details.

## Architecture overview

The app coordinates multiple processes across well-defined contracts (see [Repository and runtime architecture](docs/architecture/overview.en.md)):

- **`app/electron`**: Electron shell managing windows, tray menu, desktop overlays, global shortcuts, subprocess supervision, and `ui-bridge`;
- **`web/`**: React + TypeScript UI for the main control panel (`main.html`) and floating desktop stack (`stack.html`);
- **`app/helpers/mac` & `app/helpers/windows`**: Native platform helper `ac-helper` (protocol C12) for permissions, window/AX readings, screen capture, OCR, and push-to-talk;
- **`agent/agentd`**: Python 3.12 daemon managing character sessions, replaceable harnesses (Pi / Codex / Claude Code / ACP), memory, observation, tool gateway, and C1/C2/C6/C9 endpoints;
- **Renderer component**: the macOS Metal host (`metal-avatar-host` + XPC preview service) and the WIP Windows Vulkan renderer (`efw.exe`). Its source is not in the public repository; it ships only inside the released `Agentic Complex.app`, and a build from the public repository shows characters as text only;
- **`characters/`, `voice/`, `motion/`, `protocol/`, `tools/`**: Character/motion build pipelines, external TTS & motion generation services, inter-process contracts, and dev/QA/release tooling.

## Shortcuts

| Shortcut | Action |
|---|---|
| Hold right `Option` | Push-to-talk (macOS) |
| `⌃⌥Space` | Quick input |
| `⌃⌥H` | Show or hide the character |
| `⌃⌥L` | Screen reading |
| `⌃⌥S` | Read selected text (or clipboard if none selected) into quick input |
| `⌃⌥P` | Temporarily let clicks pass through the character and floating overlays |

Shortcuts can be customized in Settings › 快捷键 (Shortcuts). Inside the main window: `⌘0`–`⌘3` and `⌘,` jump to pages, `Q`/`E` cycle page tabs, `⌘K` opens the command palette, and `Esc` returns to Home.

## Requirements

### macOS (Primary platform)

- Apple Silicon Mac, macOS 15 or later.
- Xcode Swift toolchain, Node.js ≥ `24.22.1`, Python `3.12` (recommended via `uv`).
- Per-feature system permissions (inspectable in Settings › 权限与授权):

| Permission | Use |
|---|---|
| Microphone, Speech Recognition, Input Monitoring | Push-to-talk |
| Accessibility | Reading window text, computer use |
| Screen Recording | Screen reading and screenshots |
| Automation | Jumping to coding sessions in terminal apps |
| Notifications | When using macOS system notifications |

### Windows x64 (Experimental / WIP)

- Windows x64, Visual Studio 2022 C++ Build Tools, Node.js ≥ `24.22.1`, Python `3.12`.
- Built and packed into a portable directory via `private/remote/winhost.py` (private; not in the public repository) and `tools/release/package_windows.py`; still in active development.

## Development setup & Dev deployment

This repository has no prebuilt installers. Below are all ways to set up from source, run the Dev Console, hot-deploy dev changes onto an installed `.app`, or build a full package.

### 1. Prepare runtime dependencies

From the repository root:

```sh
# 1) Create agentd's Python 3.12 virtual environment
uv venv --python 3.12 agent/.venv
uv pip install --python agent/.venv/bin/python -r agent/agentd/requirements.txt

# 2) Install the Pi SDK runtime to .local/pi-runtime (required: Pi is the default kernel, and the agentd unit tests use it)
python3 -I agent/agentd/character_agent/harness/pi_install_runtime.py \
  --destination .local/pi-runtime --npm "$(which npm)"
```

> Note: `--npm` requires an absolute path to `npm`; see [Pi runtime notes](agent/agentd/character_agent/pi-runtime/RUNTIME.md). For offline motion/character package pipelines, also create `.local/venvs/pipeline` per [Development and releases](docs/development.en.md).

### 2. Local Dev Console (Recommended for daily development, no `.app` build)

Starts Vite with hot module reload (`127.0.0.1:5190`) alongside the real Electron shell, which supervises `agentd` (dev port `48790`), `ac-helper`, and `metal-avatar-host`:

```sh
python3 -I tools/dev/dev_console.py
# Or build the Metal renderer in release mode for the app's frame rate (each edit recompiles the whole module, so it is slower):
python3 -I tools/dev/dev_console.py --release-renderer
```

The public repository has no renderer source: the dev console then starts no `metal-avatar-host`, characters show as text only, and `--release-renderer` has no effect.

Open **`http://127.0.0.1:48780/`** in your browser to switch component worktrees, inspect process logs, and restart parts independently.

- The dev build keeps its settings, data and logs in `.local/cache/dev-console/` and does not use the installed app's port `48800` or `~/Library/Application Support/`. The kernels' workspace is `~/AgenticComplex` by default, as in the installed app (change it under Settings › 角色内核 › 工作区 (Workspace)); local kernels such as Codex also write their own directories, for example `~/.codex`.
- The agentd port is fixed at `48790`; the dev console has no option to change it. In a public checkout the dev console reads the sample library `characters/sample-library/` (the text-only character `aide`) by default; `--catalog <current.json>` picks another library.
- Connect a model: the first start of the dev build opens the 首次设置 (first-run setup) assistant; you can close it. Then do one of these: enter an API key or sign in under Settings › pi 账号与凭据 (pi account and credentials); or run `codex login` in a terminal first and then choose Codex under Settings › 角色内核 (Character kernel). Without a model, a chat replies `pi_connection_missing`.
- Passes `--no-push-to-talk --no-attention` by default, so the global push-to-talk key and the observation samplers stay off; additional shell arguments can be appended or edited in the console UI.
- Note: Running Electron from `node_modules` lacks the packaged preview XPC service, so the 3D preview on the Character page falls back to static portraits.

### 3. Dev deployment onto an installed `Agentic Complex.app` (`dev_deploy.py`, macOS)

To test changes to `web/` or `agent/agentd/` directly inside an already-installed `Agentic Complex.app`—preserving its code signing, macOS permissions, Electron shell, helper, and Metal renderer without rebuilding the whole `.app`:

1. **Enable**: Add the following key to `~/Library/Application Support/local.agenticcomplex.companion/config.json` and restart the app once:

   ```json
   "dev_resources": "<absolute-checkout-path>/.local/dev-runtime/current"
   ```

2. **Deploy** from the repository root (the first run must be `all`):

   ```sh
   python3 -I tools/release/dev_deploy.py all      # First deployment: build web UI and stage agentd
   python3 -I tools/release/dev_deploy.py web      # Rebuild and deploy web UI, art, and routes.json only
   python3 -I tools/release/dev_deploy.py agentd   # Deploy agent/agentd code and restart backend only
   ```

3. **Live reload**: `dev_deploy.py` writes `.local/dev-runtime/<UTC>-<commit>[-dirty]/` with `dev-receipt.json` and atomically switches the `current` symlink. The running Electron shell watches the parent directory (`dev-reload.ts`) and reads `dev-receipt.json`: `web` reloads the web panels, `agentd` restarts `agentd`, and `all` does both. Verify the active source under **诊断 (Diagnostics)**: it shows 开发目录 │ <commit>.
4. **Limitations & disable**: Changes to the Electron shell, `ac-helper`, Metal renderer, preview XPC, `Info.plist`, or new Python dependencies still require rebuilding `.app`. Remove `dev_resources` from `config.json` and restart once to revert to bundled resources. See [Development and releases](docs/development.en.md#development-deployment).

### 4. Standalone Web UI development (Fake Bridge)

To work purely on UI layouts and components without Electron, Python, or Metal:

```sh
npm --prefix web ci --ignore-scripts
npm --prefix web run dev
```

Open `/main.html#/overview`; the frontend automatically falls back to its built-in fake bridge and mock fixtures. See [web UI](docs/architecture/web-ui.en.md).

### 5. Full release build & layouts

The canonical macOS release entry point is `bash app/build_app.sh` (must be run from a clean `main` commit with a matching passing `commit` or `release` gate receipt; reads the local profile `private/release/release.json` if present, else the public `app/packaging/release.json`). The public profile ships no characters (`character_catalog` is `null`); after launch, you can import `characters/sample-library/packages/aide/<sha256>/` on 角色 › 导入 (Import) or compatible character packages inside the app.

| Layout | Command | Output |
|---|---|---|
| `portable` (default) | `bash app/build_app.sh` | One self-contained `Agentic Complex.app` with all components |
| `split` | `bash app/build_app.sh --layout split` | An `Agentic Complex.app` containing `host`, `renderer`, and `web-ui`, plus a sibling `components/` directory imported on first launch |

- Run `bash app/build_app.sh --check` to verify prerequisites without building; use `python3 -I tools/qa/gate_daemon.py pack` when building via the gate runner.
- On first launch, a setup assistant guides through enabling the character, testing push-to-talk, setting your name, and connecting coding sessions; every step can be skipped (re-runnable later in Settings › 启动与关于).
- See [Development and releases](docs/development.en.md) and [Release components](docs/components.en.md); for WIP Windows portable directory packaging, see [release components · Windows portable directory](docs/components.en.md#windows-portable-directory).

### 6. Common verification commands

```sh
python3 -I tools/qa/gate.py --profile public                               # Baseline public checks
python3 -I tools/qa/gate.py --profile dev --checkout "$PWD" --changed main # Incremental dev gate in a worktree
python3 -I tools/qa/live_routes.py                                         # Read-only GET route check against running app
```

agentd unit tests (install the Pi runtime first):

```sh
cd agent/agentd/tests
AGENTD_DEV_CATALOG="$PWD/fixtures/characters/current.json" ../../.venv/bin/python -I -m unittest discover -s . -p 'test_*.py'
```

## Optional external components

These services run separately and are deployed by the user; the app stores only their URLs and tokens and contains no model weights or images:

- **Speech synthesis service**: HTTP service based on GPT-SoVITS providing character voices. See [deploying the voice service](docs/guides/tts-deploy.en.md) and the [TTS engine interface](protocol/C2-speech-stream/ENGINE.md).
- **Motion generation service**: HTTP service in `motion/` generating motion clips from text prompts (currently backed by NVIDIA Kimodo). Configure via right-click character menu › 镜头与动作… › switch 动作来源 to 模型生成 and supply the service URL (no full deployment guide yet).

## Community

Join the QQ group "终末地集成智能体系统" to discuss usage and development or report issues: group number **1079677371**, or scan the code:

<img src="docs/assets/qq-group.jpg" alt="QR code of the QQ group 终末地集成智能体系统, number 1079677371" width="240">

## Unofficial fan project notice

This is an unofficial, experimental fan project created for development and learning. It is not affiliated with or endorsed by the developer or publisher of *Arknights: Endfield*. All game names, characters, and related assets belong to their respective owners. Release character assets and libraries are not included in this repository; only the text-only sample character `aide` is included in public source.

## Documentation

- [Documentation index](docs/README.en.md)
- [Product guide](docs/product.en.md)
- [Repository and runtime architecture](docs/architecture/overview.en.md)
- [Development and releases](docs/development.en.md)
- [Release components and installation](docs/components.en.md)
- [Local Dev Console](docs/development.en.md#local-development-dev-console)
- [Protocol index](protocol/README.md)
- [AGPL-3.0 License](LICENSE)
