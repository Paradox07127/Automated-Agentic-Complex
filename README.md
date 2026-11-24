# Agentic Complex（终末地桌面角色）

[English](README.en.md)

> [!CAUTION]
> **实验性质项目 · 仅供开发与学习使用**
>
> 本项目当前是一个**实验性质项目，仅供开发与技术学习所用**，目前仍处于**早期开发阶段**，请勿作为成熟稳定的日常软件使用。实际运行中可能出现以下问题：
> - **渲染异常**：透明桌面窗口、局部渲染范围、光影或动作重定向在不同设备/动作下可能出现闪烁、错位或性能开销过高；
> - **Token 消耗异常**：后台活动观察、简报、主动发言判断以及多步工具调用会持续触发模型请求，若配置不当或发生循环调用可能产生预期外的 API 费用；
> - **功能接不上 / 未接通**：部分前端界面、桥接操作、平台能力（尤其是正在开发中的 Windows 端）或外部服务可能处于半接入、仅调试状态或尚未接通；
> - **页面 UI 混乱或未适配**：控制面板与桌面浮层仍在频繁迭代，不同窗口尺寸、无内置美术资源的公开构建或异常状态下可能出现排版错乱与文案缺省。
>
> **使用建议**：强烈建议在 **AI Agent（如 Codex、Claude Code 等编程智能体）的协助下** 阅读源码、配置环境、核对模型路由与预算上限，并通过「诊断」「运行记录」与日志排查运行问题，妥善使用。

**Agentic Complex**（仓库目录名 `Endfield`）是一个桌面角色与个人智能体实验应用，也是面向桌面角色包的开发框架：它在桌面上渲染兼容格式的角色包，并为每个角色内置一个可切换内核的个人智能体，可进行文字/语音对话、任务执行、记忆管理，并在用户授权后感知桌面活动。

- **主平台**：Apple Silicon Mac（macOS 15 及以上），使用 Electron 外壳 + 原生 Metal 渲染器 + Swift 平台 Helper。
- **Windows x64（开发中 / 实验性）**：Vulkan 渲染器（`efw.exe`）、Windows Helper（`ac-helper.exe`）与便携版打包正在积极开发中，尚未达到功能完整（例如按住说话与角色页实时预览暂未实现）。
- **资产与同人声明**：本仓库不包含任何游戏本体素材与发行用角色库；公开构建配置仅提供纯文字示例角色「助手」（`aide`）。详见文末[非官方同人声明](#非官方同人声明)。

## 核心功能

### 个人智能体

- **主窗口与控制台**：应用主窗口默认打开手表盘风格的**「主页」**（倾斜的立体手表盘：左列是页面键，右侧是工具键；中间圆盘分「待批准」「在做」「今日」三页，可点标签或左右滑动切换；下方是今日任务进度；角色卡显示角色当前在做的事、着装和渲染帧率；右上是时钟、连接状态和提醒横幅）；顶部导航栏可切换到**「工业简报」**（`⌘1`，查看今日时间线、待审批/待回答事项、运行中任务与日报）、**「对话」**（`⌘2`）、**「记忆」**（`⌘3`）、**「角色」**、**「定时任务」**、**「运行记录」**、**「诊断」**和**「设置」**（`⌘,`）；在「设置 › 启动与关于」开启**开发者模式**后还会显示「管线」「调参」等调试页面。
- **记忆管理**：在**「记忆」**页查看、确认、编辑或删除角色记录的用户事实与带来源条目；角色从活动中自动提炼的内容会先作为候选记录等待确认。
- **可替换内核与按用途路由**：在**「设置 › 角色内核」**选择执行内核：默认使用随应用提供的 **Pi**（内置 Node SDK 运行时），也可使用本机安装的 **Codex** 或 **Claude Code**，或通过 **ACP** 协议接入本机其他智能体工具；支持为不同用途（对话、后台任务、主动判断、屏幕理解、记忆与日志、电脑操控）单独指定内核、模型与推理强度。切换内核后，角色人设、对话历史、任务和记忆仍由应用保留。
- **账号与凭据**：本机内核默认复用各自 CLI 工具的登录，其中 Codex 也可改用 API 凭据；Pi 使用的模型服务在**「设置 › pi 账号与凭据」**配置，支持 **Anthropic API**、**DeepSeek**、**Grok / xAI**、**OpenAI API**、**兼容 API**（支持本机回环地址无密钥连接）、**其他（Pi 目录）**离线目录中的服务，以及 **ChatGPT 订阅**。回复语言可在**「设置 › 说话与通知」**中设置。
- **Token 与费用提示**：开启活动观察、每日/每周简报、主动发言或后台任务会持续触发模型请求。可在**「诊断」**与**「运行记录」**查看调用次数、估算费用与每次运行的上下文，并在「设置 › 角色内核 › 限额」（选用 Pi 时）调整单次费用上限，实验期间按需关闭不需要的后台能力。

### 陪伴与感知

- **活动观察（默认关闭）**：在**「设置 › 隐私」**开启后，应用会在本机记录前台应用、窗口与活动摘要，并按设置生成每日或每周简报；同时支持黑名单排除（**「名单外都读」**）与白名单（**「只读名单里的」**，默认）两种模式。
- **主动发言与免打扰**：在**「设置 › 交流」**里选主动开口、主动频率和免打扰时段；休息和喝水提醒是角色自带的，不想听就在气泡「更多操作」里点「关闭此类」；需要安静或共享屏幕时可开启「免打扰」（安静 / 会议）。
- **编码会话观察**：开启「读取编码会话」并安装 hook 后，可留意本机 Claude Code 和 Codex 会话进度，并在桌面浮窗显示完成通知与审批卡。
- **桌面互动**：支持点击角色不同部位、拖动、从右键菜单送礼物，以及待机和闲时动作。

### 画面与桌面

- **原生渲染**：macOS 使用应用自带的 Metal 管线（`metal-avatar-host`），默认采用游戏内角色详情页灯光与后期参数；Windows 端使用 Vulkan 渲染器（`efw.exe`，开发中）。
- **桌面行为**：无边框透明悬浮显示，可拖动到任意位置；窗口遮挡时自动让位到窗口旁（在右键菜单「更多」里取消勾选「自由活动」可固定位置）；前台全屏时默认隐藏，全屏视频或游戏时停留在屏幕边缘。
- **录屏隐藏**：「录屏时隐藏角色」在 macOS 上默认开启（开始录屏/共享时隐藏一次，按 `⌃⌥H` 恢复显示），在 Windows 上默认关闭，可在「设置 › 说话与通知 › 免打扰」调整。

### 角色、外观与动作

- 在**「角色」**页切换角色包，顶部页签提供**动作**、**编排**（动作链）、**外观**、**设定**（行为/画面/场景）、**拍照**、**MMD**（共享舞蹈库）与**导入**。
- 每个角色为独立角色包（包含模型、动作、声线配置与人设），格式见[角色包规范](protocol/character-library/CONTRACT.md)。
- 支持在「角色 › 导入」导入 EFMI 模组更换外观、切换部件与颜色开关，以及导入 VMD、BVH、glTF、GLB、VRMA、FBX 和带 VMD 的 ZIP（可附带背景音乐，直接拖到角色身上接收 VMD 与 ZIP）。格式与限制见[动作导入](docs/guides/motion-import.md)。

### 语音

- **按住说话（macOS）**：按住右侧 `Option` 键说话，松开后发送；语音识别使用 macOS 系统语音识别框架在本机完成。
- **语音合成**：配置外部 TTS 服务后可按角色声线朗读回复；**未配置外部语音服务时，回复仅显示文字、不朗读**（不回退系统朗读）。

### 隐私与电脑操控

- 活动观察与电脑操控均默认关闭。窗口文字、网页正文、输入的文字、编码会话、截图、键鼠计数与麦克风应用均有独立开关；外发前支持敏感信息遮蔽，也可配置排除/允许名单。
- 电脑操控桥允许受支持的会话在用户逐窗口、逐项授权后观察原生应用窗口控件、读取文字、查看截图或执行操作，详情与完整功能说明见[产品指南](docs/product.md)。

## 架构概览

应用采用多进程协作架构，详见[仓库与运行架构](docs/architecture/overview.md)：

- **`app/electron`（Electron 外壳）**：主进程负责窗口、托盘菜单、桌面浮层、全局热键、子进程监督与安全桥接（`ui-bridge`）；
- **`web/`（React + TypeScript 网页 UI）**：控制面板（`main.html`）与桌面浮窗栈（`stack.html`）；
- **`app/helpers/mac` & `app/helpers/windows`（平台 Helper）**：`ac-helper` 原生进程（C12 协议），提供系统权限、窗口/AX 读数、截图、OCR 与按住说话按键；
- **`agent/agentd`（Python 守护进程）**：负责角色主会话、可替换 Harness（Pi / Codex / Claude Code / ACP）、记忆、观察理解、工具网关与 C1/C2/C6/C9 接口；
- **渲染器组件**：macOS Metal 宿主（`metal-avatar-host` + XPC 预览服务）与开发中的 Windows Vulkan 渲染器（`efw.exe`）。源码不在公开仓库，只随发行版的 `Agentic Complex.app` 提供；从公开仓库构建时角色只显示文字；
- **`characters/`、`voice/`、`motion/`、`protocol/`、`tools/`**：角色包与动作构建工具、外部 TTS 服务、外部动作生成服务、跨进程协议契约与开发/测试/打包工具。

## 快捷键

| 快捷键 | 作用 |
|---|---|
| 按住右侧 `Option` | 按住说话（macOS） |
| `⌃⌥Space` | 快速输入 |
| `⌃⌥H` | 显示或隐藏角色 |
| `⌃⌥L` | 屏幕识读 |
| `⌃⌥S` | 读取选中的文字（未选中时读剪贴板），带入快速输入 |
| `⌃⌥P` | 临时让所有点击穿过角色和浮窗 |

快捷键可在「设置 › 快捷键」中修改；主窗口内还支持 `⌘0`–`⌘3`、`⌘,` 切页，`Q`/`E` 切换页内标签，`⌘K` 打开命令面板，`Esc` 返回主页。

## 系统要求

### macOS（主支持平台）

- Apple Silicon Mac，macOS 15 或更新版本。
- Xcode（Swift 工具链）、Node.js ≥ `24.22.1`、Python `3.12`（推荐使用 `uv`）。
- 按功能按需授予系统权限（也可在「设置 › 权限与授权」查看）：

| 权限 | 用途 |
|---|---|
| 麦克风与语音识别、输入监控 | 按住说话 |
| 辅助功能 | 读取窗口文字、电脑操控 |
| 屏幕录制 | 屏幕识读与截图 |
| 自动化 | 跳转到终端里的编码会话 |
| 通知 | 改用 macOS 系统通知时 |

### Windows x64（开发中 / 实验性）

- Windows x64，Visual Studio 2022（C++ x64 构建工具）、Node.js ≥ `24.22.1`、Python `3.12`。
- 当前通过 `private/remote/winhost.py`（私有，不在公开仓库） 在构建主机上同步、构建与打包便携目录（`package_windows.py`），仍在迭代中。

## 开发环境与 Dev 版本部署

本仓库不提供预构建安装包。以下列出从源码准备环境、启动 Dev Console、将 Dev 版本热部署到已安装的 `.app` 以及完整打包的全部方式。

### 1. 准备基础依赖

在仓库根目录执行：

```sh
# 1) 准备 agentd 的 Python 3.12 虚拟环境
uv venv --python 3.12 agent/.venv
uv pip install --python agent/.venv/bin/python -r agent/agentd/requirements.txt

# 2) 安装 Pi SDK 运行时到 .local/pi-runtime（必装：Pi 是默认内核，agentd 单测也要用它）
python3 -I agent/agentd/character_agent/harness/pi_install_runtime.py \
  --destination .local/pi-runtime --npm "$(which npm)"
```

> 说明：`pi_install_runtime.py` 的 `--npm` 需要传入 `npm` 的绝对路径，详情见 [Pi 运行时说明](agent/agentd/character_agent/pi-runtime/RUNTIME.md)。若需离线导入 VMD/外部动作或构建角色包，另需按[开发与发行](docs/development.md)准备 `.local/venvs/pipeline`。

### 2. Dev Console 一键本地运行（推荐开发方式，不打包 app）

开发面板会一条命令启动 Vite 热更新服务（`127.0.0.1:5190`）与真实的 Electron 外壳，由外壳拉起并监督 `agentd`（开发端口 `48790`）、`ac-helper` 与 `metal-avatar-host`：

```sh
python3 -I tools/dev/dev_console.py
# 若需要正式构建帧率的 Metal 渲染器（每次修改都整模块重编，较慢）：
python3 -I tools/dev/dev_console.py --release-renderer
```

公开仓库没有渲染器源码：开发面板此时不起 `metal-avatar-host`，角色只显示文字，`--release-renderer` 不起作用。

启动后在浏览器打开 **`http://127.0.0.1:48780/`** 即可查看控制台、为各组件切换工作树、查看日志和重启进程。

- 开发版的设置、数据和日志放在 `.local/cache/dev-console/`，不用正式安装版的 `48800` 端口和 `~/Library/Application Support/` 数据目录。内核的工作区和正式版一样，默认是 `~/AgenticComplex`（在「设置 › 角色内核 › 工作区」改）；Codex 等本机内核还会写它们自己的目录，例如 `~/.codex`。
- agentd 端口固定是 `48790`，开发面板没有改端口的参数。公开检出里开发面板默认读示例角色库 `characters/sample-library/`（纯文字角色「助手」`aide`）；`--catalog <current.json>` 换成别的角色库。
- 接模型：开发版第一次启动会打开「首次设置」向导，可以先关掉。然后二选一：在「设置 › pi 账号与凭据」填 API Key 或登录；或者先在终端运行 `codex login`，再在「设置 › 角色内核」改选 Codex。没接模型时，对话会回 `pi_connection_missing`。
- 默认附带 `--no-push-to-talk --no-attention` 参数以避免开发时干扰全局热键与采样，可在控制台 UI 或命令行后追加其他外壳参数。
- 注意：直接从 `node_modules` 启动 Electron 时没有 XPC 预览服务，控制面板「角色」页的 3D 预览会退回静态立绘。

### 3. Dev 版本部署到已安装的 `Agentic Complex.app`（`dev_deploy.py`，macOS）

如果需要在**保留已安装正式 App 的签名、macOS 系统权限、Electron 外壳、Helper 和 Metal 渲染器**的前提下，快速调试 `web/` 或 `agent/agentd/` 代码而无需每次重新完整打包，可启用开发部署：

1. **开启配置**：在 `~/Library/Application Support/local.agenticcomplex.companion/config.json` 中加入一行，并重启一次 App：

   ```json
   "dev_resources": "<仓库绝对路径>/.local/dev-runtime/current"
   ```

2. **执行部署**（在仓库根目录运行，首次必须先跑 `all`）：

   ```sh
   python3 -I tools/release/dev_deploy.py all      # 首次部署：构建 web UI 并同步 agentd
   python3 -I tools/release/dev_deploy.py web      # 仅构建并更新网页 UI、素材与 routes.json
   python3 -I tools/release/dev_deploy.py agentd   # 仅更新 agent/agentd 代码并重启后台服务
   ```

3. **热重载机制**：`dev_deploy.py` 会将产物写入 `.local/dev-runtime/<UTC时间>-<提交>[-dirty]/` 并原子切换 `current` 软链；运行中的 Electron 外壳监听 `dev_resources` 的父目录变化后，会读取 `dev-receipt.json`：`web` 重载网页面板，`agentd` 重启 `agentd`，`all` 两者都做。可在主窗口「诊断」页检查当前运行来源是否显示为「开发目录 │ 提交号」。
4. **局限与关闭**：Electron 主进程/preload、`ac-helper`、Metal 渲染器、XPC 预览服务、`Info.plist` 或新增 Python 依赖的改动仍需重新打包 `.app`；从 `config.json` 删除 `dev_resources` 并重启 App 即可恢复使用包内自带资源。更多细节见[开发与发行 · 开发部署](docs/development.md#开发部署)。

### 4. 仅调试网页前端（Fake Bridge）

如果只调试前端界面样式与交互，无需启动 Electron、Python 或 Metal：

```sh
npm --prefix web ci --ignore-scripts
npm --prefix web run dev
```

访问 `/main.html#/overview`，前端会自动切换为内置 Fake Bridge 与 Mock 数据。详情见[网页 UI](docs/architecture/web-ui.md)。

### 5. 完整构建与两种发行布局

macOS 唯一正式打包入口为 `bash app/build_app.sh`（须在干净的 `main` 提交上执行，并具备匹配的 `commit` 或 `release` 档通过门禁回执；本机存在 `private/release/release.json` 时优先使用本机配置，否则使用公开配置 `app/packaging/release.json`）。公开发行配置默认不携带角色库（`character_catalog` 为 `null`），安装启动后可在「角色 › 导入」或使用 `characters/sample-library/packages/aide/<sha256>/` 导入纯文字示例角色。

| 布局 | 命令 | 产物 |
|---|---|---|
| `portable`（默认） | `bash app/build_app.sh` | 单个自包含全部组件的 `Agentic Complex.app` |
| `split` | `bash app/build_app.sh --layout split` | 仅含 `host`、`renderer`、`web-ui` 的 `Agentic Complex.app`，以及旁边的 `components/` 目录（首次启动时导入） |

- 构建前可用 `bash app/build_app.sh --check` 预检前提条件；通过门禁执行器打包使用 `python3 -I tools/qa/gate_daemon.py pack`。
- 首次启动会进入设置向导，引导开启角色、试用按住说话、设置称呼与接入编码会话；每一步都可跳过，之后可在「设置 › 启动与关于」重新打开向导。
- 详细打包与安装流程见[开发与发行](docs/development.md)和[发行组件](docs/components.md)；Windows 便携目录打包（WIP）见[发行组件 · Windows 便携版](docs/components.md#windows-便携版)。

### 6. 常用测试与门禁校验

```sh
python3 -I tools/qa/gate.py --profile public                               # 公开环境基础校验
python3 -I tools/qa/gate.py --profile dev --checkout "$PWD" --changed main # 开发工作树增量 dev 门禁
python3 -I tools/qa/live_routes.py                                         # 已安装/运行态只读接口检查
```

agentd 单测（需要先装好 Pi 运行时）：

```sh
cd agent/agentd/tests
AGENTD_DEV_CATALOG="$PWD/fixtures/characters/current.json" ../../.venv/bin/python -I -m unittest discover -s . -p 'test_*.py'
```

## 外部可选组件

以下两个服务独立于应用运行，由用户自行部署；应用只保存服务地址和令牌，不携带镜像或模型权重：

- **语音合成服务**：基于 GPT-SoVITS 的 HTTP 服务，提供角色声线。部署步骤见[语音服务部署](docs/guides/tts-deploy.md)；接入其他语音合成引擎的接口规范见[TTS 引擎接口](protocol/C2-speech-stream/ENGINE.md)。
- **动作生成服务**：`motion/` 中的 HTTP 服务，按文字描述生成动作（当前后端为 NVIDIA Kimodo）。在角色右键菜单打开「镜头与动作…」，将「动作来源」设为「模型生成」并填写服务地址（目前尚无完整部署文档）。

## 交流群

欢迎加入 QQ 群「终末地集成智能体系统」讨论使用、开发与反馈问题，群号 **1079677371**，也可以扫码加入：

<img src="docs/assets/qq-group.jpg" alt="QQ 群「终末地集成智能体系统」二维码，群号 1079677371" width="240">

## 非官方同人声明

本项目是爱好者制作的非官方实验性同人项目，与《明日方舟：终末地》的开发商和发行商没有关联，也没有得到其认可。游戏名称、角色和相关素材的权利归各自权利人所有。发行用的游戏角色资产与角色库不在本仓库中，公开源码仅随附纯文字示例角色 `aide` 用于开发与学习测试。

## 文档

- [文档索引](docs/README.md)
- [产品指南](docs/product.md)
- [仓库与运行架构](docs/architecture/overview.md)
- [开发与发行](docs/development.md)
- [发行组件与安装](docs/components.md)
- [本机开发面板（Dev Console）](docs/development.md#开发运行dev-console)
- [协议索引](protocol/README.md)
- [AGPL-3.0 许可证](LICENSE)
