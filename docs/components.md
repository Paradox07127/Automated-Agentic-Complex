# 发行组件与安装

[English](components.en.md)

Agentic Complex 由 7 种组件组成（`characters.<id>` 每个角色一个）。macOS `Agentic Complex.app` 是当前主发行形态，同一次构建的组件可以组装成两种版本：

- portable 版：一个 `Agentic Complex.app`，装着全部组件。
- 拆分版：`Agentic Complex.app` 只装 host、renderer、web-ui。其余组件放在 app 旁边的 `components/` 目录里，首次启动时导入。

两种版本里同一组件的内容相同。C11 清单与组合锁同样支持 `windows-x64`（用于开发中的 Windows 便携目录构建 `tools/release/package_windows.py`，见 [Windows 便携版](#windows-便携版)）。组件清单、组合锁和导入索引的格式见 [C11](../protocol/C11-components/CONTRACT.md)。组件之间的接口见 [协议索引](../protocol/README.md)。

## 1. 组件

| ID | 内容 | 依赖 | portable 版的位置 | 拆分版的位置 |
|---|---|---|---|---|
| `host` | Electron 外壳 `MacOS/AgenticComplex` 和它的 `Resources/app/`、平台 helper `MacOS/ac-helper`；解析和导入组件，监督子进程 | 接口 C6、C9（由 agentd 提供） | app 内固定位置 | 同左 |
| `renderer` | Metal 渲染器 `MacOS/AgenticComplexMetalAvatar`（也提供角色页预览） | — | app 内固定位置 | 同左 |
| `web-ui` | 网页 UI `ui/` 和桥路由表 `ui-bridge/` | — | `Contents/Resources/components/web-ui/` | 同左 |
| `runtime.python` | CPython 和 agentd 用的 Python 依赖；入口 `bin/agentic-complex-python` | — | `Contents/Resources/components/<ID>/` | `components/<ID>/` |
| `agentd` | agentd 代码、`content/`、`agentd_launcher.py`、`character_tool.py` 等工具 | `runtime.python` | 同上 | 同上 |
| `harness.pi` | Node 和 Pi 运行时 | — | 同上 | 同上 |
| `characters.<id>` | 一个角色包 | — | 同上 | 同上 |

- 每个组件目录里有 `component.json`（ID、版本、树哈希、入口、依赖）。host 和 renderer 的文件在 app 内原位，其余组件的文件在 `payload/` 下。
- 浏览器扩展（`agent/browser`）不进发行产物。

## 2. 出包

前提：

- 在 main 的检出里构建，发行相关的源码没有未提交改动。构建开始和结束时各查一次，构建期间不要推进 main。
- 同一源码指纹有一份通过的门禁回执：`commit` 或 `release` profile，不是 partial。回执由 `python3 -I tools/qa/gate.py --profile commit` 生成，见[开发与发行](development.md#门禁)。
- PATH 上有 Node.js 24.22.1 或更新版本。先准备发行角色库及配置所需的 UI 美术，缺少必需输入时构建会报错退出。发行配置默认读公开 profile `app/packaging/release.json`；本机 profile 存在时用本机的。

```sh
bash app/build_app.sh                    # portable 版
bash app/build_app.sh --layout split     # 拆分版
bash app/build_app.sh --check            # 只检查前提，不构建
```

- `--output <目录>`：输出目录，不能已存在。默认 `app/build/releases/<时间>-<提交前 8 位>/`。
- `--build-version <版本>`：写进 `CFBundleVersion` 和 host、renderer、web-ui、agentd 的组件版本。默认是构建时刻。
- 最后一行输出是 JSON，`release_ready` 为 `true`，`app` 是 app 路径。

输出目录：

| 文件 | portable 版 | 拆分版 |
|---|---|---|
| `Agentic Complex.app` | 全部组件 | host、renderer、web-ui |
| `components/index.json`、`components/<ID>/` | 无 | 外置组件和它们的索引 |
| `release-receipt.json` | 发行回执：提交、layout、组件引用、门禁回执、冒烟结果 | 同左 |
| `staging-manifest.json` | 组装清单：layout、host 和组件引用 | 同左 |
| `source-manifest.json` | 打包的源码文件和源码指纹 | 同左 |
| `bundle-manifest.json` | 签名后 app 的文件清单 | 同左 |
| `artifact-smoke.json` | 产物冒烟的结果 | 同左 |
| `gate-receipt.json` | 构建所用的门禁结果和源码指纹 | 同左 |

组件里的 Mach-O 在组件构建时签一次，两种版本拷同一份字节。app 签名跳过 `Contents/Resources/components/`。

## 3. 比对两种版本

用同一个提交、同一个 `--build-version` 各出一次包，再比对：

```sh
bash app/build_app.sh --build-version "$build_version" --output "$portable_dir"
bash app/build_app.sh --layout split --build-version "$build_version" --output "$split_dir"
python3 -I tools/release/compare_layouts.py --portable "$portable_dir" --split "$split_dir"
```

将 `build_version` 设为两种布局共同使用的版本，并为 `portable_dir` 与 `split_dir` 选择两个不同且尚不存在的路径。比对规则如下。

- 两边的组件 ID 集合相同，每个组件的文件集合相同。
- Mach-O 文件逐个架构切片比 CDHash。
- host 主程序比代码页哈希。它的签名封住 `Contents/Resources`，两种版本的 `Contents/Resources` 本来就不同。
- 签名包里的 `_CodeSignature/CodeSignature` 不比。这个 CMS 块只差签名时间；它旁边的 CodeDirectory 照比。
- `component.json` 去掉 `tree_sha256` 后比；`distribution.json` 去掉 `layout` 后比。
- 其余文件比 sha256。不比执行位。

每个组件输出一行结果，最后一行是 `LAYOUTS SAME`（退出码 0）或 `LAYOUTS DIFFER`（退出码 1）。参数或读取错误退出码 2。

## 4. 安装和运行

支持目录是 `~/Library/Application Support/<发行 ID>/`，发行 ID 写在 app 的 `Contents/Resources/distribution.json` 的 `id` 里，正式版是 `local.agenticcomplex.companion`。设置、角色库和日志都在这里，换 app 不影响它们。

### portable 版

退出 Agentic Complex，用新的 `Agentic Complex.app` 替换旧的，再启动。

### 拆分版

1. 把 `Agentic Complex.app` 和 `components/` 放在同一个目录里。
2. 启动 app。宿主将外置索引与签名覆盖的 `Contents/Resources/components-index.json` 逐字节核对，把还没装的组件逐个复制到 `<支持目录>/components/<ID>/<版本>-<树哈希前 8 位>/`。每个复制品都重算树哈希、核对入口，通过后才改名就位。然后宿主写 `<支持目录>/components/composition.lock.json`。
3. 一个组件没通过时，`<支持目录>/logs/companion.log` 记一行 `component import failed: <ID> <原因>`。这个组件记为缺，其余组件照常导入。
4. 每次启动都校验已装组件的清单 SHA-256、载荷树哈希、文件数、字节数和入口。
5. 移走外置目录后，宿主仍按 app 内的签名索引校验已装的组件。
6. `index.json` 本身坏了时报「组件导入失败」，所有子进程都不起。

升级时先退出 app，再用同一次构建的 `Agentic Complex.app` 和 `components/` 一起替换旧的，再启动。新版本装进新的版本目录，旧版本目录不会自动删除。外置索引必须与 app 内的索引一致。

## 5. 缺组件时

宿主每次启动都读组合锁，逐个核对组件清单、入口和依赖。没通过的组件写进 `<支持目录>/config.json` 的 `missing_components`（ID → 原因），它的子进程不启动，也不进重启循环。

原因的取值：`componentMissing`、`manifestInvalid`、`manifestMismatch`、`entrypointMissing`、`requirementUnmet`。依赖没满足的组件也记为缺：缺 `runtime.python` 时，`agentd` 记为 `requirementUnmet`。拆分版导入时没通过的组件，导入原因（例如 `treeMismatch`）只记在日志里；它没装进支持目录，所以在 `missing_components` 里记为 `componentMissing`。

状态栏菜单里每个子进程一行：「角色」是 renderer，「后台」是 agentd。

| 缺的组件 | 状态栏菜单 | 照常工作的 |
|---|---|---|
| `renderer` | 「角色」：失败：缺 renderer 组件 | 后台、网页面板 |
| `agentd` | 「后台」：失败：缺 agentd 组件。导入角色包、导入动作时提示「缺 agentd 组件」 | 角色照常显示 |
| `runtime.python` | 「后台」：失败：缺 agentd 组件 | 角色照常显示 |
| 某个 `characters.<id>`，已有角色库 | 无 | 全部。宿主继续用已有的角色库，日志记 `seed migration deferred` |
| `agentd`、`runtime.python` 或某个 `characters.<id>`，首次启动、还没有角色库 | 「角色」「后台」：失败：没有角色库：缺 `<ID>` 组件 | 状态栏菜单。补上组件后，下次启动自动建角色库 |
| `web-ui` | 主窗口打开后备页：读不到网页接口表 routes.json：<路径> | 角色、后台 |

子进程崩溃时按退避重启：300 秒内崩 5 次就停在「失败」。渲染器以退出码 78（角色包和程序版本不符）或 69（无法使用 GPU）退出时直接进「失败」，不重启。

## 6. 每个组件单独运行

下表的命令不需要别的组件在场。`<python>` 是 runtime.python 的 `bin/agentic-complex-python`，在仓库里是 `agent/.venv/bin/python -I -B`；`<agentd>` 是 agentd 组件的 `payload/`，在仓库里 launcher 是 `app/Resources/agentd_launcher.py`，agentd 目录是 `agent/agentd`。

| 组件 | 单独运行 | 对端不在时 | 门禁套件 |
|---|---|---|---|
| `host` | `app/electron/test/e2e-headless.test.ts`：不开窗口，起主进程的进程监督、本检出的 agentd、模拟渲染器（夹具 `app/Tests/Fixtures/HeadlessE2E`）和假 TTS，包括缺 agentd、缺 renderer 两个场景。`npm --prefix app/electron run build` 后在 `app/electron` 里跑 `AAC_ELECTRON_E2E=1 node --test test/e2e-headless.test.ts`；不设 `AAC_ELECTRON_E2E=1` 时全部跳过 | 缺的子进程停在「失败：缺 `<ID>` 组件」，其余子进程照常 | `electron-e2e` |
| `renderer` | `Agentic Complex.app/Contents/MacOS/AgenticComplexMetalAvatar --describe` 打印它实现的接口版本；`--validate-pack <bundle.json>` 只校验角色包。不带 `--agentic-complex-host-socket` 时独立运行，不连 Companion | 连不上 agentd 时报 `configuration_unavailable`，定时重连，角色照常显示 | `host-link`（真渲染器读 C1 样例）、`metal-host` |
| `web-ui` | `npm --prefix web run dev`，打开 `/main.html#/overview`。假桥代替宿主和 agentd | — | `web-unit`、`web-visual` |
| `runtime.python` | `<python> -c 'import sys; print(sys.version)'` | — | 发行时的 `artifact_smoke.py` |
| `agentd` | `<python> <agentd>/agentd_launcher.py --agentd-dir <agentd>/agentd -- --port 0 --state-dir <目录> --character-catalog <角色库>/current.json`。端口为 0 时由系统挑，实际端口写在 `<目录>/ui-runtime.json`。用组件跑时必须带 `--character-catalog`；不带时 agentd 读仓库里 `characters/sample-library` 的样例库，组件里没有这个目录，启动就失败。参数换成 `-- --describe` 时只打印契约版本 | 不需要宿主 | `agentd-unit`（`test_c9_process.py` 等） |
| `characters.<id>` | `<python> <agentd>/agentd/character_tool.py validate <角色包目录>`；`AgenticComplexMetalAvatar --validate-pack <bundle.json>` | — | `agentd-unit`（`test_character_library.py`、`test_character_compose.py`） |
| 浏览器扩展（不是发行组件） | `node --test agent/browser/extension/test_*.mjs` | native host 在 agentd 不在时照常运行，报 agentd 不在 | `browser-unit` |

跨组件的读写只能走协议索引里的接口。门禁的 `cross-paths` 套件（`python3 -I tools/qa/check_paths.py --components`）检查发行源码有没有直接引用别的组件的路径；允许的例外和待还的债列在 `protocol/cross-paths.json`。

## 7. 打包内部

### 发行工具

发行入口是 `bash app/build_app.sh`，它经 `app/package_release.sh` 调 `tools/release/release.py`。`tools/release/` 里的工具：

- `release.py`：主线发行。检查 main 和未提交的产品源码、门禁回执和 UI 美术，构建网页、Electron 外壳和 Swift 二进制（helper、渲染器），再调 `package_app.py`、签名、`inventory_app.py` 和产物冒烟，写 `release-receipt.json`。
- `package_app.py`：装配 `Agentic Complex.app` 和 C11 组件，写 `source-manifest.json` 和 `staging-manifest.json`。
- `build_components.py`：签名前暂存各组件的载荷，签名后写它们的 `component.json`。
- `component_manifest.py`：写组件清单和组合锁，算载荷的树哈希（`hash <目录>` 只打印一行树哈希）。
- `compare_layouts.py`：比对两种版本，见 [§3](#3-比对两种版本)。
- `harness_runtime.py`：准备并校验内核运行时（Python 依赖、Pi 与 Node），见下面的[内核运行时](#内核运行时)。
- `inventory_app.py`：签名后的 app 文件清单 `bundle-manifest.json`。
- `source_fingerprint.py`、`gate_receipt.py`：源码指纹和门禁回执，由 `tools/qa/gate.py` 写、`release.py` 查。
- `dev_deploy.py`：不重新打包，把网页 UI 和 agentd 部署给已安装的 app，见[开发与发行 · 开发部署](development.md#开发部署)。

### 发行 profile 键

`release.py` 构建 `app/electron`（`npm run build`）和 `app/helpers/mac`，从锁定的 `Electron.app` 装配 host。它读发行 profile 的这些键：

| 键 | 默认 | 含义 |
|---|---|---|
| `product_name` | `"Agentic Complex"` | `Resources/app/package.json` 的 `productName`，以及 `CFBundleName`、`CFBundleDisplayName`。app 目录名仍是 `Agentic Complex.app` |
| `app_version` | `"0.2.0"` | `Resources/app/package.json` 的 `version` 和 `CFBundleShortVersionString` |
| `notary_keychain_profile` | 不设 | `notarytool store-credentials` 的 profile 名。设了它时签名身份必须以 `Developer ID Application:` 开头；签名后发行经 `tools/release/notarize.py` 公证并装订票据，把提交 id 和状态记进 `release-receipt.json` 的 `notarization` |

角色库、美术和 `content_overrides` 这些键见[开发与发行 · 发行配置](development.md#发行配置)。

### Electron 运行时

host 用 Electron 官方的 macOS 或 Windows 发行包装配，不用 `app/electron/node_modules/electron/dist`（`npm ci --ignore-scripts` 不下载它）。`tools/release/electron_runtime.py` 按 `app/packaging/electron-runtime.lock.json` 取当前平台（`darwin-arm64`，Windows 上是 `win32-x64`）的压缩包，核对 SHA256 后解开：

```sh
python3 -I tools/release/electron_runtime.py
```

缓存默认在 `.local/cache/electron-runtime/`。核对过的压缩包留在缓存里，哈希对得上就不再下载；每次重新解到 `electron-v<版本>-<平台>/`，里面是 `Electron.app` 和发行包的许可文件。macOS 上用 `/usr/bin/ditto` 解包，它保留框架的符号链接和执行位，Python 的 `zipfile` 会丢掉这些。Windows 的 zip 没有链接，用 `zipfile` 解，根目录是 `electron.exe`、它的 DLL、`resources/`、`locales/` 和许可文件。

锁文件的顶层字段是 `darwin-arm64` 那一项；`platforms.win32-x64` 给出同一版本 Windows 包的 `archive`、`url`、`sha256`，其余字段共用。

| 字段 | 含义 |
|---|---|
| `schema` | `endfield-electron-runtime/v1`，别的值拒收 |
| `version` | Electron 版本，必须等于 `app/electron/package.json` 的 `devDependencies.electron` |
| `platform` | 顶层那一项的平台，`darwin-arm64` |
| `archive` | 包的文件名 `electron-v<版本>-<平台>.zip` |
| `url` | 包的 URL，只接受 `https://github.com/electron/electron/releases/download/` 下的 |
| `sha256` | 包的 SHA256，抄自该版本的 `SHASUMS256.txt` |
| `checksum_source` | 同一版本 `SHASUMS256.txt` 的 URL |
| `license_file` | 包根目录里 Electron 的许可文件，在 `Electron.app` 旁边（Windows 上在 `electron.exe` 旁边） |
| `platforms` | `{"win32-x64": {"archive", "url", "sha256"}}`，规则同顶层字段 |

升级 Electron 的步骤见[开发与发行 · 升级 Electron](development.md#升级-electron)。

### 外壳装配

`package_app.py` 的 `stage_electron_host` 整份拿 `Electron.app/Contents`：

- 把 `MacOS/Electron` 改名为 `MacOS/AgenticComplex`，删掉 `Resources/default_app.asar` 和 `Resources/electron.icns`。
- Electron 各 helper app 的 bundle id 换成发行 id 开头。
- 加上 `Resources/app/`（`package.json`、`dist/main.mjs`、`dist/preload.cjs`、`dist/native/preview.node`）和 `MacOS/ac-helper`。
- `Info.plist` 保留 Electron 的键，去掉 `ElectronAsarIntegrity`、图标和所有 `*UsageDescription`，再写入发行身份、app 自己的权限用途说明和构建键。

### 熔丝

签名之前，`tools/release/flip_fuses.mjs` 用 `@electron/fuses`（`app/electron` 的开发依赖，所以要先在 `app/electron` 里 `npm ci --ignore-scripts`）关掉 `RunAsNode`、`EnableNodeOptionsEnvironmentVariable` 和 `EnableNodeCliInspectArguments` 三个熔丝，其余熔丝保持 Electron 的默认值：

```sh
node tools/release/flip_fuses.mjs "<输出目录>/Agentic Complex.app"
```

macOS 上熔丝在 `Contents/Frameworks/Electron Framework.framework/Electron Framework` 里。脚本把读回的熔丝打印成一个 JSON 对象（`file`、`version`，以及 `fuses`：每个熔丝名对应 `enabled`、`disabled` 或 `removed`）；框架里没有熔丝时失败。它不重签，`sign_bundle.sh` 随后签整个 app。`app/electron/node_modules` 里的开发用 Electron 不翻熔丝。

### 签名权限

`tools/platform/sign_bundle.sh` 只在签名身份是 Developer ID Application 证书（开 hardened runtime）时，用 `--entitlements` 传 `app/packaging/entitlements/` 里的文件。它按 app 的 `Contents/` 下（或组件载荷下）的路径匹配，app 本身用 `main.plist`。Apple 规定只给可执行文件加权限，共享库、框架和进程内插件继承宿主可执行文件的权限（[Hardened Runtime](https://developer.apple.com/documentation/security/hardened-runtime)）。没有文件给 `com.apple.security.get-task-allow`，公证会拒收它（[Resolving common notarization issues](https://developer.apple.com/documentation/security/resolving-common-notarization-issues)）。

| 文件 | 签的路径 | 来历 |
|---|---|---|
| `main.plist` | app（`Contents/MacOS/AgenticComplex`） | osx-sign 的 `default.darwin.plist` 去掉摄像头、蓝牙、打印、USB、定位和照片，加上 Apple Events |
| `helper.plist` | `Frameworks/* Helper.app` | `main.plist` 去掉录音和 Apple Events：页面不录音，只有主进程起 `osascript` |
| `helper-gpu.plist` | `Frameworks/* Helper (GPU).app` | osx-sign 的 `default.darwin.gpu.plist` |
| `helper-renderer.plist` | `Frameworks/* Helper (Renderer).app` | osx-sign 的 `default.darwin.renderer.plist` |
| `helper-plugin.plist` | `Frameworks/* Helper (Plugin).app` | osx-sign 的 `default.darwin.plugin.plist` |
| `node.plist` | `harness.pi` 载荷里的 `node/bin/node` | Node 的 `tools/osx-entitlements.plist` 去掉 `get-task-allow` |
| `python.plist` | `runtime.python` 载荷里的 `bin/python3.<次版本>` | 空 |
| `ac-helper.plist` | `MacOS/ac-helper` | 平台 helper 自己录音、发 Apple Events，它和 app 都带这两个键 |
| `renderer.plist` | `MacOS/AgenticComplexMetalAvatar` | 空 |

osx-sign 的文件取自提交 `ca7726ffb7da556a20ba95ab9c013049afdda6fb`（[entitlements](https://github.com/electron/osx-sign/tree/ca7726ffb7da556a20ba95ab9c013049afdda6fb/entitlements)），它的 `src/sign.ts` 按路径选：`(Plugin).app`、`(GPU).app`、`(Renderer).app`，其余（app 和普通的 `Helper.app`）用 `default.darwin.plist`。Node 的文件取自标签 `v24.22.1`（`app/packaging/node-runtime.lock.json` 锁定的版本，[osx-entitlements.plist](https://github.com/nodejs/node/blob/v24.22.1/tools/osx-entitlements.plist)），Node 自己的 `tools/osx-codesign.sh` 用它加 `--options runtime` 和 `--timestamp` 签 `bin/node`。

| 键 | 文件 | 含义 |
|---|---|---|
| [`com.apple.security.cs.allow-jit`](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.allow-jit) | main、helper、helper-gpu、helper-renderer、helper-plugin、node | 可以用 `MAP_JIT` 建可写可执行内存 |
| [`com.apple.security.device.audio-input`](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input) | main、ac-helper | 可以用麦克风录音 |
| [`com.apple.security.automation.apple-events`](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.automation.apple-events) | main、ac-helper | 可以请求用户允许向别的 app 发 Apple Events |
| [`com.apple.security.cs.allow-unsigned-executable-memory`](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.allow-unsigned-executable-memory) | helper-plugin、node | 可以不受 `MAP_JIT` 限制地建可写可执行内存 |
| [`com.apple.security.cs.disable-library-validation`](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.disable-library-validation) | helper-plugin、node | 可以加载未签名的插件或框架 |
| [`com.apple.security.cs.disable-executable-page-protection`](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.disable-executable-page-protection) | node | 关掉启动和运行期间的全部代码签名保护 |
| [`com.apple.security.cs.allow-dyld-environment-variables`](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.allow-dyld-environment-variables) | node | 受动态链接器环境变量影响 |

### 内核运行时

发行只带一个内核：Pi，在 `harness.pi` 组件里。不打包 Claude Agent SDK、Codex 包或 Claude、Codex 的 CLI；Claude 和 Codex 用用户机器上装好的 CLI。也不打包任何用户凭据。

- Python 依赖按 `agent/agentd/requirements-character-agent.lock` 和 `app/packaging/requirements-content.lock`（给 VMD 导入用的 numpy）安装，必须带 wheel 哈希。每个平台 wheel 另带第二个 `--hash`（`win_amd64` 的 cp312 wheel）；`pywin32`（Windows 上 `mcp` 的依赖）带 `; sys_platform == "win32"`，macOS 上跳过。
- 准备时总是装 Pi 锁定的 npm 依赖树（不跑生命周期脚本）和官方的独立 Node 二进制。Node 的版本和 SHA256 锁在 `app/packaging/node-runtime.lock.json`：顶层字段是 `darwin-arm64` 的 tarball，`platforms.win32-x64` 给出官方 `node-v<版本>-win-x64.zip` 的 `archive`、`url`、`sha256`。macOS 上检查版本和 Mach-O 依赖库，拒收 Homebrew 的启动器；Windows 上只查版本。
- `npm ci` 之后删掉 `@earendil-works/*` 包和 `@aws-sdk`、`@smithy`、`@google` 这些服务商 SDK 里的 `docs/`、`examples/` 和 `CHANGELOG.md`。
- 准备工具用一个临时的安装用 venv，不往开发用的解释器里装 pip 或包。缓存的载荷记录源锁的哈希和每个文件、链接的哈希；缺文件、权限被改、外部链接、过期的锁、包版本不对、缺 Node 或 Pi 树都校验失败。打包时只复制由哈希锁定的 wheel 安装生成的站点包。
- 依赖原有的许可声明留在各自的包里；numpy 的另抄到 `runtime.python/payload/licenses/numpy`。`staging-manifest.json` 记录运行时的来源和全部组件引用，`release-receipt.json` 抄下这些引用并记录 layout。
- 载荷路径：Node 是 `harness.pi/payload/node/bin/node`，Pi 是 `harness.pi/payload/pi-runtime`，Node 的许可是 `harness.pi/payload/licenses/Node-LICENSE`。Windows 上准备好的运行时保留 zip 的布局（`node/node.exe` 和 `node/node_modules/npm`），安装用 venv 的解释器是 `Scripts\python.exe`。
- 发行入口的 `--check` 只读：报告 layout 和当前依赖缓存是否已准备好。正常构建在需要时准备缓存。显式的 `--harness-runtime <绝对路径>` 必须已经能通过校验。单独准备的命令见[开发与发行 · 准备内核运行时](development.md#准备内核运行时)。

### Windows 便携版

Windows 只有 portable：`tools/release/package_windows.py` 把构建产物装成一个目录 `Agentic Complex\`，不做安装器和签名。

- 根目录：`Agentic Complex.exe`（改名的 `electron.exe`，删掉 `resources\default_app.asar`，`flip_fuses.mjs` 直接翻 exe 里的熔丝）、Electron 的 DLL 和资源、`ac-helper.exe`、`efw.exe` 和它旁边读的 `*.dxbc`。`resources\` 下是 `app\`、`parent_watch.py`、`distribution.json`、`composition.lock.json` 和 `components\<id>\`。清单和组合锁的平台是 `windows-x64`。
- `runtime.python`：构建机上 CPython 3.12 的基础前缀（不含 `Scripts`、`Doc`、`include`、`libs`、`Tools`、`Lib\test` 和原来的 `Lib\site-packages`）。准备好的锁定站点包放进 `Lib\site-packages`，`pywin32.pth` 因此生效。入口是 `python.exe`，没有 shell 包装，`-I -B` 由外壳传。打包最后在成品目录里只带 `SYSTEMROOT` 运行它，导入失败或前缀、`sys.path` 落在目录外都报错。
- `harness.pi` 的入口是 `node\node.exe`；agentd 组件的 `fbx_tool` 是 `tools\fbx-motion.exe`。
