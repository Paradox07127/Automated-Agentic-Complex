# 开发与发行

[English](development.en.md)

## 环境

- **macOS（主平台）**：macOS 15 以上，Xcode 自带 Swift 工具链，Apple Silicon。
- 安装 Node.js ≥ 24.22.1（`web/package.json` 与 `app/electron/package.json` 的 `engines.node`）。
- 在仓库根目录创建 agentd 的 Python 3.12 环境，安装 `agent/agentd/requirements.txt` 和发布版内置的 numpy（`app/packaging/requirements-content.lock`，外壳用这个环境跑 MMD 动作导入）：

  ```sh
  uv venv --python 3.12 agent/.venv
  uv pip install --python agent/.venv/bin/python -r agent/agentd/requirements.txt
  uv pip install --python agent/.venv/bin/python --require-hashes --only-binary=:all: -r app/packaging/requirements-content.lock
  ```

- 安装 Pi SDK 运行时到 `.local/pi-runtime`。这一步必装：**Pi** 是默认角色内核，agentd 单测也要用它（`--npm` 须传 `npm` 的绝对路径，详情见 [Pi 运行时说明](../agent/agentd/character_agent/pi-runtime/RUNTIME.md)）：

  ```sh
  python3 -I agent/agentd/character_agent/harness/pi_install_runtime.py \
    --destination .local/pi-runtime --npm "$(which npm)"
  ```

- 为角色包工具（`characters/`）创建 `.local/venvs/pipeline`，安装 `characters/agentic_complex_build/requirements-mmd.txt`（NumPy，够 VMD 导入用；通用交互动作的工具另外需要 SciPy，见本机说明 `INTERACTIONS.md`，不在公开仓库）；运行工具时使用 `.local/venvs/pipeline/bin/python3`：

  ```sh
  uv venv --python 3.12 .local/venvs/pipeline
  uv pip install --python .local/venvs/pipeline/bin/python3 -r characters/agentic_complex_build/requirements-mmd.txt
  ```

- 生成角色包用的本地输入放在 `.local/inputs/` 或 `.local/output/<任务>/`，不要把素材放进仓库。角色包由外部工具生成，格式见[角色库规范](../protocol/character-library/CONTRACT.md)。
- **Windows x64（开发中）**：需要 Visual Studio 2022（C++ x64 构建工具）、Node.js ≥ 24.22.1 与 Python 3.12，用于构建 `ac-helper.exe`、Electron 外壳与便携目录（`efw.exe` 是私有组件，不在公开仓库）。具体见下面的 [Windows](#windows) 一节。

## 开发运行（Dev Console）

日常开发推荐使用本地开发面板，一条命令启动 Vite 热更新服务（`127.0.0.1:5190`）和真 Electron 外壳，外壳按配置监督 `agentd`（端口 `48790`）和 `ac-helper`，不打包 `.app`。渲染器是私有组件：检出里没有 `private/renderer` 时，面板不编也不起渲染器，角色只显示文字。

```sh
python3 -I tools/dev/dev_console.py
# 有私有渲染器源码时，以 release 优化构建它：
python3 -I tools/dev/dev_console.py --release-renderer
```

启动后访问 `http://127.0.0.1:48780/`，可为 `web`、`shell`、`agentd`、`renderer` 分别切换工作树并查看日志；`web` 和 `shell` 可以单独重启，给 `agentd` 或 `renderer` 换工作树会重建并重启外壳。默认传 `--no-push-to-talk --no-attention`，可在面板或命令行末尾追加外壳参数。面板还显示 agentd 的 `/health`（含 `degraded` 项）、渲染器是否连上和它的角色（取本次外壳启动后 `companion.log` 里最后一行 `HOSTLINK`），以及外壳构建后工作树又有新提交时的提示；日志可按文字过滤，或只看错误和警告。日志的时间戳单列一栏，跨天时插一行日期。日志旁的 `trace` 和 `runs` 只读 agentd 状态目录里的数据库：`trace` 是 `agentd.sqlite` 的 `trace_events`（每回合的输入、上下文、模型开始 / 首字 / 结束及模型名、token、耗时，语音和收尾；不含每几秒一次的 `behavior.ticked`），`runs` 是 `character-agent/runs.sqlite` 的角色内核运行事件和条目（后端、模型、各段耗时、工具调用、回复文字）。两者都取最近 1000 条；`turn=` 和 `run=` 是同一个 id，用它过滤可以对上一回合。`frames` 是 agentd 和内核 runner 之间的每一帧：面板启动外壳时设 `AGENTD_FRAME_LOG=.local/cache/dev-console/agentd-state/harness-frames.jsonl`，记下 `init`（系统提示词、工具定义、配置，凭据已换成 `[redacted]`）、`query`（提示词和历史）、工具请求和结果、增量文字和带用量的 `result`。内核自己再加的系统提示词和它发给模型服务的原始 HTTP 请求不经过这里，所以不在其中。文件超过 64 MiB 时改名成 `harness-frames.jsonl.1`（替换上一份），再从新文件记起；面板只读当前文件。

- 开发版的设置、数据和日志放在 `.local/cache/dev-console/`，不用正式安装版的 `48800` 端口和 `~/Library/Application Support/` 数据目录。内核的工作区和正式版一样，默认是 `~/AgenticComplex`（在「设置 › 角色内核 › 工作区」改）；Codex 等本机内核还会写它们自己的目录，例如 `~/.codex`。
- agentd 端口固定是 `48790`，开发面板没有改端口的参数。公开检出里开发面板默认读示例角色库 `characters/sample-library/`（纯文字角色「助手」`aide`）；`--catalog <current.json>` 换成别的角色库。
- 接模型：开发版第一次启动会打开「首次设置」向导，可以先关掉。然后二选一：在「设置 › pi 账号与凭据」填 API Key 或登录；或者先在终端运行 `codex login`，再在「设置 › 角色内核」改选 Codex。没接模型时，对话会回 `pi_connection_missing`。

面板给每个组件做这些事：

- **web**：在所选工作树的 `web` 起 vite（`127.0.0.1:5190`，`EF_DEV_HMR_PORT=5190`），改网页即热更新。工作树没有 `node_modules` 时先在它的 `web` 里运行 `npm ci`。
- **shell**：在所选工作树的 `app/electron` 里按需运行 `npm ci` 和 `node node_modules/electron/install.js`，再 `npm run build`；用 `swift build -c release` 建同一工作树的 `app/helpers/mac`；有 `private/renderer` 时用 `swift build`（带 `--release-renderer` 时是 `-c release`）建渲染器；写 config.json；等 vite 起来后启动 `electron app/electron --config <config.json> --dev-web-server http://127.0.0.1:5190 --no-push-to-talk --no-attention [外壳参数…]`。主窗口和桌面浮层的页面都取自 vite，真桥不变（见 [Electron 外壳 · 开发模式](architecture/shell.md#开发模式)）。
- **agentd**、**renderer**：在外壳里运行。面板只选它们的工作树（写进 config.json 的 `agentd_dir`、`avatar_executable`），「应用」会重建并重启外壳。不重建、只重启 agentd 和渲染器时用外壳托盘的「重启子进程」，它会重读 config.json。

Ctrl-C 先停外壳（外壳按顺序停渲染器、agentd 和 helper），再停 vite。

config.json 在主检出的 `.local/cache/dev-console/support/`（外壳的支持目录，跨次保留）。每次启动重算 `agentd_dir`、`python`（主检出的 `agent/.venv`）、`agentd_port`（`48790`）、`support_dir`、`agentd_state_dir`（`.local/cache/dev-console/agentd-state`）、`character_catalog`（开发面板自己的角色库副本，见下）、`avatar_app` 和 `avatar_executable`，别的设置保留。没写的感知和分享类开关按关补上，没写 `services` 时三个外置服务都是关闭（TTS 无语音），和打包 app 的默认值一样；要用外置服务，在「设置」的「服务」组里选接法并填地址，之后保留。端口是已装 app 的 `48800`、目录落在已装 app 的数据目录里，或外壳参数里有 `--config` 时，面板报错退出。

日志在主检出的 `.local/cache/dev-console/`：`web.log`、`shell.log`（构建步骤和 Electron 的输出），以及外壳支持目录下的 `support/logs/companion.log`（页面来源记作 `DEV_WEB …`）、`agentd.log`、`avatar.log`（渲染器）和 `helper.log`。面板里都能看。

面板自己的参数（不传给外壳）：`--help`；`--release-renderer`；`--python <路径>`，agentd 用的 Python；`--catalog <current.json>`，角色库（默认是主检出 `.local/dev-library/` 里发行配置角色库的副本，公开配置下是示例角色库 `characters/sample-library/` 的副本：面板里导入的动作和服装只写进副本，发行角色库保持 `catalog_sha256` 固定的那一版；发行库的 `current.json` 变了，下次启动重新复制，副本里的导入随之丢弃）；`--check`，见下。外壳或 agentd 起不来时，面板在终端打一行 `dev console: …` 说明原因，然后以 1 退出。

```sh
python3 -I tools/dev/dev_console.py --check [--catalog <current.json>] [外壳参数…]
```

`--check` 不起面板，用一个临时支持目录（日志也在里面）起 web 和外壳，依次等 vite 监听、外壳构建完并起来、agentd 的 `/health` 回 `ok`、渲染器的 hello（`companion.log` 里的 `HOSTLINK hello character=`），然后全部停下，打印一行 `DEV-CONSOLE-CHECK pass: …` 或 `DEV-CONSOLE-CHECK fail at <步骤> (…); passed …; logs in <临时目录>`，退出码 0 或 1。通过时删掉临时目录，失败时留着。它会开外壳和渲染器的窗口，要在有桌面的会话里跑。

若只需脱离外壳调试网页 UI 与样式，可直接在 `web/` 启动开发服务器（使用内置 Fake Bridge 与 Mock 数据）：

```sh
npm --prefix web ci --ignore-scripts
npm --prefix web run dev
```

## 构建与测试

agentd 单测（需要先装好 Pi 运行时）：

```sh
cd agent/agentd/tests
AGENTD_DEV_CATALOG="$PWD/fixtures/characters/current.json" ../../.venv/bin/python -I -m unittest discover -s . -p 'test_*.py'
```

### Electron 外壳

```sh
npm --prefix app/electron ci
npm --prefix app/electron run build   # tsc --noEmit，再 node build.mjs
npm --prefix app/electron test        # node --test
AAC_ELECTRON_E2E=1 npm --prefix app/electron test   # 另跑无头端到端测试
```

`npm ci` 会跑 electron 的 postinstall 下载 Electron 运行时；用 `--ignore-scripts` 装的要另跑 `node app/electron/node_modules/electron/install.js`。构建产物和预览插件见 [Electron 外壳 · 构建产物](architecture/shell.md#构建产物)。

### 单独运行外壳

不经开发面板时：

```sh
npm --prefix web run build && npm --prefix app/electron run build && npm --prefix app/electron start -- --config <config.json>
```

页面读 `web/dist`。不带 `--config` 时外壳用已装 app 的数据目录，所以测试一律用临时目录里的 config.json。

### 平台 helper（macOS）

```sh
swift build -c release --package-path app/helpers/mac      # app/helpers/mac/.build/release/ac-helper
app/helpers/mac/.build/release/ac-helper
{"v":1,"id":1,"op":"hello","params":{"protocol":1,"client":"manual"}}
bash app/helpers/mac/Tests/gate.sh                          # 构建、单测和 C12 回放
```

`Tests/gate.sh` 构建 helper、跑包的单测和 `Tests/replay.py`。回放把 C12 的每个 `examples/ok-*.ndjson` 发给 helper，用 `validate.py` 检查整段会话。回放只开自己的测试面板 `ac-helper-testwindow`，不弹权限框、不激活别的 app；读私有剪贴板（`AC_HELPER_PASTEBOARD`），麦克风换成 440 Hz 的合成音（`AC_HELPER_MIC_SYNTHETIC`），点击和滚动事件只记录不发出，所以不需要任何系统授权。

`Tests/manual_ax.sh` 对前台窗口手动跑全部 `ax.*` op，只打印数量、角色和长度，不打印标题或读到的文字。`Tests/manual_media.sh` 截前台窗口、做 OCR、录 2 s 麦克风后以 `discard` 停止，只打印尺寸、行数、音量和耗时，不保存任何东西。这两个脚本读真实的窗口和麦克风，只在自己的机器上手动运行。

### 网页

所有命令在仓库根目录运行，或先进 `web/` 去掉 `--prefix`。

```sh
npm --prefix web ci --ignore-scripts   # 装依赖（版本锁在 package-lock.json）
npm --prefix web run dev               # 开发服务器，打开 /main.html#/overview
npm --prefix web run gen:tokens        # tokens.json -> tokens.css
npm --prefix web run check             # tsc --noEmit（strict）
npm --prefix web run build             # 产出 dist/main.html、dist/stack.html
npm --prefix web test                  # vitest 单测
npm --prefix web run lint:size         # src 下单文件不超过 400 行
npm --prefix web run check:copy        # 上屏文字检查
npm --prefix web run check:boundary    # 演示边界检查
npm --prefix web run check:routes      # 路由契约检查
npm --prefix web run e2e:smoke         # Playwright（Chromium）；设 EF_SHOTS=1 才截图到 .shots/
npm --prefix web run e2e               # 全部 e2e
```

e2e 的端口默认是 `4317`，并行的工作树各设一个 `EF_WEB_PORT`。第一次跑 e2e 前装浏览器（下到 Playwright 的默认缓存，不进仓库）：`npx playwright install chromium`。各项检查的规则见[网页 UI](architecture/web-ui.md)。

## Windows

需要 Visual Studio 2022 或它的 Build Tools，带「使用 C++ 的桌面开发」（x64 C++ 工具和 Windows SDK 的 `fxc`），`vswhere.exe` 在默认位置；Node 24（`node`、`npm.cmd`、`npx.cmd` 在 PATH 上）和 Git；装了 agentd 依赖的 CPython 3.12（主检出的 `agent\.venv\Scripts\python.exe`，或用 `--python`、`AGENTD_PYTHON` 指定）；装了 Vulkan 的显卡驱动（`vulkan-1.dll`）；带 `vulkan_frame` 的角色库（Windows 渲染器只画这种角色）。

平台 helper：

```
app\helpers\windows\build.bat
.local\build\helper-windows\ac-helper.exe
{"v":1,"id":1,"op":"hello","params":{"protocol":1,"client":"manual"}}
python -I app\helpers\windows\tests\replay.py
```

`build.bat` 用 `vswhere` 找到 Visual Studio，载入 `vcvars64.bat`，用静态 CRT 编 `src\*.cpp`，exe 不需要另装运行库；产物在 `<仓库>\.local\build\helper-windows\ac-helper.exe`，外壳在那里找它。`tests\replay.py`（只用标准库）回放 C12 的每个 `ok-*.ndjson` 并用 `validate.py` 检查，核对 helper 能触发的 `bad-*` 情形的错误码和退出码，并核对 helper 的 op 表和 `ops.json` 一致。会读或操作别的窗口的请求都对准脚本自己开的窗口；不发麦克风的 `permissions.request`，因为它会打开麦克风。

开发面板：在有桌面的会话里跑同一条命令（`py -3 -I tools\dev\dev_console.py …` 或 `python -I …`，可带 `--catalog <current.json>`）。和 macOS 不同的地方：

- helper 用 `app\helpers\windows\build.bat` 建；渲染器 `efw.exe` 是私有组件，config.json 的 `avatar_executable` 指向它。
- 外壳直接起 `app\electron\node_modules\electron\dist\electron.exe`。
- 停组件用 `taskkill /T /F /PID`，整棵进程树一起结束，外壳来不及按顺序停渲染器、agentd 和 helper。子进程在各自的进程组里，控制台的 Ctrl-C 只到面板，由面板按顺序停外壳和 vite。
- 「已装 app 的数据目录」检查看 `%APPDATA%\Agentic Complex` 和 `%LOCALAPPDATA%\Agentic Complex`。

手动运行外壳时，config.json 必须有 `agentd_dir`、`python`、`agentd_port`、`gpu_hold_files` 和 `avatar_executable`；不写 `support_dir`、`agentd_state_dir` 时取默认目录。Windows 外壳和 macOS 的其他差异见 [Electron 外壳 · Windows 差异](architecture/shell.md#windows-差异)。

## 门禁

`tools/qa/gate.py` 按 `tools/qa/suites.json` 里的档（profile）选测试套件来跑，每次运行写一份 JSON 回执。

- 公开仓库的完整校验：`python3 -I tools/qa/gate.py --profile public`。它不需要私有素材或 GPU。
- 开发中只跑改动碰到的套件：`python3 -I tools/qa/gate.py --profile dev --checkout "$PWD" --changed main`；`--only a,b` 只跑列出的套件。这两种运行的回执标为 partial。
- 套件的输入和上一次 PASS 完全相同时，门禁复用那次结果，输出第一行是 `CACHE: <n> of <m> suites reused`。
- 搬目录或改文档后，`python3 -I tools/qa/check_paths.py --links` 检查断链，`python3 -I tools/qa/xplat_guard.py "$PWD"` 检查跨平台路径规则。

渲染器的套件（`metal-*`、`renderer-*`、`characters-swift`）写在 `private/suites.json`，只在有私有源码的检出里加入同名档；公开检出跑 `public` 档。

## 发行

`build_app.sh` 的产物在 `app/build/releases/<时间-提交>/`。下面的 `release_dir` 是这个目录名：

```sh
bash app/build_app.sh
codesign --verify --strict --deep "app/build/releases/${release_dir}/Agentic Complex.app"
```

- `build_app.sh` 是唯一的 macOS 发行入口，默认读公开 profile `app/packaging/release.json`，本机 profile 存在时用本机的，最后一行 JSON 给出 app 路径。默认 `--layout portable` 只产出一个 `Agentic Complex.app`；`--layout split` 另在 app 旁边放 `components/`。两种版本旁边都只有 JSON 构建回执，不打 DMG。
- 两种版本的组件、比对、安装和缺组件时的表现见 [components.md](components.md)。
- **Windows 便携目录（开发中）**：`tools/release/package_windows.py` 在 Windows 上生成 `Agentic Complex/` 便携目录，细节见[发行组件 · Windows 便携版](components.md#windows-便携版)。
- `release.py` 要求发行相关源码没有未提交改动，并要求同一份源码有 `commit` 或 `release` 档的通过回执。`python3 -I tools/qa/gate.py --profile commit` 生成这份回执，默认写在 `.local/gate-receipts/`；`--gate-receipt <文件>` 可以指定另一份。
- 构建仅生成产物。安装时先退出正在运行的 app，再按[对应布局的说明](components.md#4-安装和运行)替换。配置和数据保存在 `~/Library/Application Support/`。
- 装完启动 App 后先跑 `python3 -I tools/qa/live_routes.py`（只发 GET，用真实库逐个请求界面能读的接口），汇总行失败数为 0 才算装好。
- 打包工具和 app 包里各部分的来历见[发行组件 · 打包内部](components.md#7-打包内部)。

### 发行配置

- `python3 -I tools/release/release.py --print-profile` 打印实际用的发行配置路径。
- 发行角色库由配置的 `character_catalog`（库的 `current.json`）指定，这个文件的 SHA-256 必须等于配置的 `catalog_sha256`。`character_catalog` 为 null 时发行不带角色，角色包之后在 app 里导入。`--library <目录>` 显式选另一个库，这时不比 SHA。
- 公开 profile 不带角色库和拍照滤镜（`photo_looks` 为 null 或不写）。`ui_art` 指仓库里的自绘 UI 美术 `app/packaging/ui-art`：源是 `app/packaging/ui-art-src/` 的 SVG，改完跑 `python3 -I tools/release/render_ui_art.py` 重出 PNG、`AppIcon.icns` 和 `art-manifest.json`。
- `content_overrides`（`{组件内的相对路径: 仓库相对的源文件}`）在签名前把源文件放进对应组件，路径不能跳出组件目录。

### 准备内核运行时

不构建 app，单独准备并校验 `harness.pi` 和 Python 依赖的缓存：

```sh
agent/.venv/bin/python -I tools/release/harness_runtime.py --output .local/cache/personal-agent-runtime/manual
agent/.venv/bin/python -I tools/release/harness_runtime.py --output .local/cache/personal-agent-runtime/manual --check
```

Windows 上用 `--python` 传一个 CPython 3.12 的 `python.exe`；默认是 macOS 的 `agent/.venv/bin/python`。内容见[发行组件 · 内核运行时](components.md#内核运行时)。

### 升级 Electron

1. 改 `app/electron/package.json` 里的 `electron` 和它的 lockfile。
2. 在 `app/packaging/electron-runtime.lock.json` 里改 `version`，以及 `archive`、`url`、`checksum_source` 里的版本。
3. 从新版的 `SHASUMS256.txt` 把 `*electron-v<版本>-darwin-arm64.zip` 一行的哈希抄进 `sha256`，把 `*electron-v<版本>-win32-x64.zip` 一行的哈希连同新的 `archive`、`url` 抄进 `platforms.win32-x64`。两个包各下载一次、自己算 SHA256，两边一致才提交。
4. 两处版本不一致时 `tools/release/tests/test_electron_runtime.py` 失败。

## 开发部署

测试阶段改了网页或 agentd，不重新打包就能在已安装的正式 `Agentic Complex.app` 上试（仅限 macOS，依赖 APFS 克隆与软链接）。签名、权限、原生外壳和 Metal 都还是那个 app 的，只有网页文件、`routes.json` 和 agentd 代码改从开发目录读。开发目录由打包流程里同一段代码（`tools/release/build_components.py` 的 `stage_ui`、`stage_agentd`）生成，逐字节等于打包结果。

开启：在 `~/Library/Application Support/local.agenticcomplex.companion/config.json` 加一行，然后重启 App 一次。

```json
"dev_resources": "<仓库绝对路径>/.local/dev-runtime/current"
```

部署（在主检出里跑；第一次先跑 `all`）：

```sh
python3 -I tools/release/dev_deploy.py web      # 构建 web，连同 UI 素材和 routes.json 部署，网页面板重新载入
python3 -I tools/release/dev_deploy.py agentd   # 部署 agent/agentd，只重启后台服务
python3 -I tools/release/dev_deploy.py all      # 两样都做
```

- 每次部署写一个新目录 `.local/dev-runtime/<UTC 时间>-<提交>[-dirty]/`，没部署的那一半从上一份 APFS 克隆，`dev-receipt.json` 记提交、有没有未提交改动、部署部分（`part`）以及 ui 和 agentd 的哈希；随后通过一次原子 rename 把 `current` 软链指过去，正在跑的 agentd 不会读到半新半旧的文件。只留最近 5 份。
- 运行中的 Electron 外壳通过 `app/electron/src/main/dev-reload.ts` 监听 `dev_resources` 所在父目录的变更；当 `current` 切到新部署并读到新的 `dev-receipt.json` 时，按 `part` 自动处理：`web` 重载网页面板，`agentd` 重启 `agentd`，`all` 两者都做，并在 `companion.log` 记一行 `dev reload <part> commit=...`。App 没在跑时只写好部署文件。脚本最后打印提交号和两个哈希。
- 「诊断」页健康行右侧的「运行来源」会显示「开发目录 │ 提交号」（有未提交改动时注明「含未提交改动」），并用警示色提示；正式打包时显示「正式打包」。App 启动时会在 `companion.log` 记一行 `dev_resources <路径> commit=<提交>`。
- 开发目录里缺的文件仍从 App 自己的 Resources 读；agentd 用开发目录的代码，Python 仍是 App 自带的。

关闭：从 `config.json` 删掉 `dev_resources`，重启 App 一次，就回到 App 自带的网页和 agentd。

这些改动仍要重新打包：Electron 外壳、helper、Metal 渲染、预览服务、`Info.plist`，以及 agentd 新增的 Python 依赖（开发部署只换代码，不换 App 自带的 Python 环境）。
