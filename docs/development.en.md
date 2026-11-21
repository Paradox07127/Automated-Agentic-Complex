# Development and releases

[简体中文](development.md)

## Environment

- **macOS (Primary platform)**: Apple Silicon, macOS 26 or later, and the Xcode Swift toolchain.
- Install Node.js 24.22.1 or later, as specified by `engines.node` in `web/package.json` and `app/electron/package.json`.
- From the repository root, create a Python 3.12 environment for `agentd` and install `agent/agentd/requirements.txt`:

  ```sh
  uv venv --python 3.12 agent/.venv
  uv pip install --python agent/.venv/bin/python -r agent/agentd/requirements.txt
  ```

- Install the Pi SDK runtime into `.local/pi-runtime`. This step is required: **Pi** is the default character kernel, and the agentd unit tests use it too (`--npm` must be an absolute path to `npm`; see [Pi runtime notes](../agent/agentd/character_agent/pi-runtime/RUNTIME.md)):

  ```sh
  python3 -I agent/agentd/character_agent/harness/pi_install_runtime.py \
    --destination .local/pi-runtime --npm "$(which npm)"
  ```

- Create `.local/venvs/pipeline` for the character package tools in `characters/`, install `characters/agentic_complex_build/requirements-mmd.txt` (NumPy, enough for VMD import; the universal-interaction tools also need SciPy, see the local `INTERACTIONS.md`, not in the public repository), and run the tools with `.local/venvs/pipeline/bin/python3`:

  ```sh
  uv venv --python 3.12 .local/venvs/pipeline
  uv pip install --python .local/venvs/pipeline/bin/python3 -r characters/agentic_complex_build/requirements-mmd.txt
  ```

- Keep local character package inputs in `.local/inputs/` or `.local/output/<task>/`, outside version control. External tools generate character packages in the format defined by [the character library contract](../protocol/character-library/CONTRACT.md).
- **Windows x64 (WIP)**: Requires Visual Studio 2022 (C++ x64 build tools), Node.js ≥ 24.22.1, and Python 3.12 to build `ac-helper.exe`, the Electron shell, and the portable directory package (`efw.exe` is a private component and not in the public repository). See the [Windows](#windows) section below.

## Local development (Dev Console)

For day-to-day development, the Dev Console starts the Vite hot-reload server (`127.0.0.1:5190`) and the real Electron shell with one command—supervising `agentd` (port `48790`) and `ac-helper`, with no `.app` build. The renderer is a private component: without `private/renderer` in the checkout, the console neither builds nor starts a renderer, and characters show as text only.

```sh
python3 -I tools/dev/dev_console.py
# With the private renderer sources, build the renderer in release mode:
python3 -I tools/dev/dev_console.py --release-renderer
```

Open `http://127.0.0.1:48780/` to pick worktrees per component (`web`, `shell`, `agentd`, `renderer`) and inspect logs. `web` and `shell` restart individually; choosing an `agentd` or `renderer` worktree rebuilds and restarts the shell. It defaults to `--no-push-to-talk --no-attention`; additional shell arguments can be supplied via the UI or command line.

- The dev build keeps its settings, data and logs in `.local/cache/dev-console/` and does not use the installed app's port `48800` or `~/Library/Application Support/`. The kernels' workspace is `~/AgenticComplex` by default, as in the installed app (change it under Settings › 角色内核 › 工作区 (Workspace)); local kernels such as Codex also write their own directories, for example `~/.codex`.
- The agentd port is fixed at `48790`; the dev console has no option to change it. In a public checkout the dev console reads the sample library `characters/sample-library/` (the text-only character `aide`) by default; `--catalog <current.json>` picks another library.
- Connect a model: the first start of the dev build opens the 首次设置 (first-run setup) assistant; you can close it. Then do one of these: enter an API key or sign in under Settings › pi 账号与凭据 (pi account and credentials); or run `codex login` in a terminal first and then choose Codex under Settings › 角色内核 (Character kernel). Without a model, a chat replies `pi_connection_missing`.

The console does this for each component:

- **web**: starts vite in the chosen worktree's `web` (`127.0.0.1:5190`, `EF_DEV_HMR_PORT=5190`), so page edits hot-reload. A worktree without `node_modules` first gets `npm ci` in its `web`.
- **shell**: in the chosen worktree's `app/electron` it runs `npm ci` and `node node_modules/electron/install.js` when needed, then `npm run build`; it builds the same worktree's `app/helpers/mac` with `swift build -c release`, and, when `private/renderer` exists, the renderer with `swift build` (`-c release` with `--release-renderer`); it writes config.json; once vite is up it starts `electron app/electron --config <config.json> --dev-web-server http://127.0.0.1:5190 --no-push-to-talk --no-attention [shell arguments…]`. The main window's and desktop panels' pages all come from vite with the real bridge (see [Electron shell · development mode](architecture/shell.en.md#development-mode)).
- **agentd**, **renderer**: run inside the shell. The console only picks their worktrees (written to `agentd_dir` and `avatar_executable` in config.json), and 应用 (Apply) rebuilds and restarts the shell. To restart agentd and the renderer without a rebuild, use the shell tray's 重启子进程 (Restart child processes), which rereads config.json.

Ctrl-C stops the shell first (the shell stops the renderer, agentd and the helper in order), then vite.

config.json is in the main checkout's `.local/cache/dev-console/support/` (the shell's support directory, kept across runs). Each start recomputes `agentd_dir`, `python` (the main checkout's `agent/.venv`), `agentd_port` (`48790`), `support_dir`, `agentd_state_dir` (`.local/cache/dev-console/agentd-state`), `character_catalog` (the release profile's library), `avatar_app` and `avatar_executable`, and keeps the other settings. A new file has every sensing and sharing switch off, like a packaged app's defaults. The console refuses to run when the port is the installed app's `48800`, when a directory falls inside the installed app's data directories, or when the shell arguments name `--config`.

Logs are in the main checkout's `.local/cache/dev-console/`: `web.log`, `shell.log` (build steps and Electron's output), and under the shell's support directory `support/logs/companion.log` (page sources logged as `DEV_WEB …`), `agentd.log`, `avatar.log` (the renderer) and `helper.log`. The console shows them all.

The console's own arguments (not passed to the shell): `--help`; `--release-renderer`; `--python <path>`, the Python agentd runs with; `--catalog <current.json>`, the character library (default: the release profile's, which in the public profile is the sample library `characters/sample-library/current.json`); `--check`, below. When the shell or agentd does not start, the console prints one `dev console: …` line with the reason in the terminal and exits with 1.

```sh
python3 -I tools/dev/dev_console.py --check [--catalog <current.json>] [shell arguments…]
```

`--check` starts no console. With a temporary support directory (logs included) it starts web and the shell, waits in turn for vite to listen, the shell to build and start, agentd's `/health` to answer `ok` and the renderer's hello (`HOSTLINK hello character=` in `companion.log`), then stops everything and prints one line, `DEV-CONSOLE-CHECK pass: …` or `DEV-CONSOLE-CHECK fail at <step> (…); passed …; logs in <temporary dir>`, with exit code 0 or 1. A pass deletes the temporary directory; a failure keeps it. It opens the shell's and renderer's windows, so run it in a session with a desktop.

To debug only Web UI layout and styling with the built-in fake bridge and mock fixtures:

```sh
npm --prefix web ci --ignore-scripts
npm --prefix web run dev
```

## Build and test

agentd unit tests (install the Pi runtime first):

```sh
cd agent/agentd/tests
AGENTD_DEV_CATALOG="$PWD/fixtures/characters/current.json" ../../.venv/bin/python -I -m unittest discover -s . -p 'test_*.py'
```

### Electron shell

```sh
npm --prefix app/electron ci
npm --prefix app/electron run build   # tsc --noEmit, then node build.mjs
npm --prefix app/electron test        # node --test
AAC_ELECTRON_E2E=1 npm --prefix app/electron test   # also runs the headless end-to-end tests
```

`npm ci` runs electron's postinstall, which downloads the Electron runtime; after an install with `--ignore-scripts`, run `node app/electron/node_modules/electron/install.js`. See [Electron shell · build output](architecture/shell.en.md#build-output) for the bundles and the preview addon.

### Running the shell alone

Without the dev console:

```sh
npm --prefix web run build && npm --prefix app/electron run build && npm --prefix app/electron start -- --config <config.json>
```

Pages are read from `web/dist`. Without `--config` the shell uses the installed app's data directory, so tests always use a config.json in a temporary directory.

### Platform helper (macOS)

```sh
swift build -c release --package-path app/helpers/mac      # app/helpers/mac/.build/release/ac-helper
app/helpers/mac/.build/release/ac-helper
{"v":1,"id":1,"op":"hello","params":{"protocol":1,"client":"manual"}}
bash app/helpers/mac/Tests/gate.sh                          # build, unit tests and the C12 replay
```

`Tests/gate.sh` builds the helper and runs the package's unit tests and `Tests/replay.py`. The replay sends every C12 `examples/ok-*.ndjson` to the helper and checks the whole session with `validate.py`. It opens only its own test panel `ac-helper-testwindow`, shows no permission prompt and activates no other app; it reads a private pasteboard (`AC_HELPER_PASTEBOARD`), replaces the microphone with a 440 Hz synthetic tone (`AC_HELPER_MIC_SYNTHETIC`), and records click and scroll events without posting them, so it needs no system grant.

`Tests/manual_ax.sh` runs every `ax.*` op against the front window by hand and prints counts, roles and lengths only, never a title or text it read. `Tests/manual_media.sh` captures the front window, reads it with OCR and records the microphone for 2 s before stopping with `discard`; it prints sizes, line counts, levels and timings only and saves nothing. Both read real windows and the microphone; run them by hand on your own machine only.

### Web

Run every command from the repository root, or from `web/` without `--prefix`.

```sh
npm --prefix web ci --ignore-scripts   # install dependencies (pinned in package-lock.json)
npm --prefix web run dev               # dev server; open /main.html#/overview
npm --prefix web run gen:tokens        # tokens.json -> tokens.css
npm --prefix web run check             # tsc --noEmit (strict)
npm --prefix web run build             # writes dist/main.html and dist/stack.html
npm --prefix web test                  # vitest unit tests
npm --prefix web run lint:size         # at most 400 lines per file under src
npm --prefix web run check:copy        # on-screen copy check
npm --prefix web run check:boundary    # demo boundary check
npm --prefix web run check:routes      # route contract check
npm --prefix web run e2e:smoke         # Playwright (Chromium); EF_SHOTS=1 writes screenshots to .shots/
npm --prefix web run e2e               # all e2e tests
```

The e2e port defaults to `4317`; parallel worktrees each set their own `EF_WEB_PORT`. Before the first e2e run, install the browser (into Playwright's default cache, outside the repository): `npx playwright install chromium`. The rules behind each check are in [web UI](architecture/web-ui.en.md).

## Windows

You need Visual Studio 2022 or its Build Tools with "Desktop development with C++" (the x64 C++ tools and the Windows SDK's `fxc`), with `vswhere.exe` in its default place; Node 24 (`node`, `npm.cmd` and `npx.cmd` on PATH) and Git; a CPython 3.12 with agentd's dependencies (the main checkout's `agent\.venv\Scripts\python.exe`, or one named with `--python` or `AGENTD_PYTHON`); and a character library with `d3d11_frame` (the Windows renderer draws only such characters).

Platform helper:

```
app\helpers\windows\build.bat
.local\build\helper-windows\ac-helper.exe
{"v":1,"id":1,"op":"hello","params":{"protocol":1,"client":"manual"}}
python -I app\helpers\windows\tests\replay.py
```

`build.bat` finds Visual Studio with `vswhere`, loads `vcvars64.bat` and compiles `src\*.cpp` against the static CRT, so the exe needs no runtime installed; the output is `<repo>\.local\build\helper-windows\ac-helper.exe`, where the shell looks for it. `tests\replay.py` (standard library only) replays every C12 `ok-*.ndjson` and checks it with `validate.py`, checks the error and exit codes of the `bad-*` cases the helper can trigger, and checks that the helper's op table agrees with `ops.json`. Requests that would read or act on another window are aimed at a window the script opens itself; it never sends a microphone `permissions.request`, because that opens the microphone.

Dev console: run the same command in a session with a desktop (`py -3 -I tools\dev\dev_console.py …` or `python -I …`, optionally with `--catalog <current.json>`). Differences from macOS:

- The helper is built with `app\helpers\windows\build.bat`; the renderer `efw.exe` is a private component, and the `avatar_executable` in config.json points to it.
- The shell runs `app\electron\node_modules\electron\dist\electron.exe` directly.
- Components are stopped with `taskkill /T /F /PID`, which ends the whole process tree, so the shell has no time to stop the renderer, agentd and the helper in order. Child processes are in their own process groups and the console's Ctrl-C reaches only the console, which stops the shell and vite in order.
- The installed-app data check looks at `%APPDATA%\Agentic Complex` and `%LOCALAPPDATA%\Agentic Complex`.

To run the shell by hand, config.json must have `agentd_dir`, `python`, `agentd_port`, `gpu_hold_files` and `avatar_executable`; without `support_dir` and `agentd_state_dir` the defaults apply. See [Electron shell · Windows differences](architecture/shell.en.md#windows-differences) for the shell's other differences from macOS.

## Verification gates

`tools/qa/gate.py` runs the test suites that a profile in `tools/qa/suites.json` selects, and writes a JSON receipt for each run.

- Full check of the public repository: `python3 -I tools/qa/gate.py --profile public`. It needs no private assets and no GPU.
- During development, run only the suites a change touches: `python3 -I tools/qa/gate.py --profile dev --checkout "$PWD" --changed main`; `--only a,b` runs only the listed suites. Receipts of these runs are marked partial.
- When a suite's inputs are identical to an earlier PASS, the gate reuses that result, and the first output line is `CACHE: <n> of <m> suites reused`.
- After moving directories or editing docs, `python3 -I tools/qa/check_paths.py --links` checks for broken links and `python3 -I tools/qa/xplat_guard.py "$PWD"` checks the cross-platform path rules.

The renderer suites (`metal-*`, `renderer-*`, `characters-swift`) live in `private/suites.json` and join the same-named profiles only in a checkout with the private sources; a public checkout runs the `public` profile.

## Releases

The output of `build_app.sh` is in `app/build/releases/<timestamp>-<commit>/`. `release_dir` below is the name of this directory:

```sh
bash app/build_app.sh
codesign --verify --strict --deep "app/build/releases/${release_dir}/Agentic Complex.app"
```

- `build_app.sh` is the sole macOS release entry point. By default it reads the public profile `app/packaging/release.json`, or the local profile when one exists. The final JSON line includes the app path. The default `--layout portable` produces one `Agentic Complex.app`. `--layout split` also writes a `components/` directory beside the app. Both layouts include JSON build receipts and skip DMG creation.
- See [release components](components.en.md) for layout comparison, installation, and what happens when components are missing.
- **Windows portable directory (WIP)**: `tools/release/package_windows.py` builds a portable `Agentic Complex/` directory on Windows; see [release components · Windows portable directory](components.en.md#windows-portable-directory).
- `release.py` needs shipping sources with no uncommitted changes and a passing `commit` or `release` gate receipt for the same sources. `python3 -I tools/qa/gate.py --profile commit` writes this receipt to `.local/gate-receipts/` by default; `--gate-receipt <file>` names another one.
- The build only produces artifacts. For installation, quit the running app and follow the [instructions for your layout](components.en.md#4-install-and-run). Settings and data live in `~/Library/Application Support/`.
- After installation, launch the app and run `python3 -I tools/qa/live_routes.py`. It makes GET requests to each UI-readable route against the real data store. A successful installation check reports zero failures in the summary.
- See [release components · packaging internals](components.en.md#7-packaging-internals) for the packaging tools and where each part of the app bundle comes from.

### Release profile

- `python3 -I tools/release/release.py --print-profile` prints the path of the profile in use.
- The release character library is the profile's `character_catalog` (the library's `current.json`); the SHA-256 of that file must equal the profile's `catalog_sha256`. With `character_catalog` null the release ships no characters, and character packages are imported in the app later. `--library <dir>` picks another library explicitly, and then the SHA is not compared.
- The public profile ships no character library, no game UI art and no photo filters (`ui_art` and `photo_looks` null or absent).
- `content_overrides` (`{path inside the component: repository-relative source file}`) places source files into their components before signing; a path may not leave its component directory.

### Preparing the harness runtime

To prepare and validate the `harness.pi` and Python dependency cache without building an app:

```sh
agent/.venv/bin/python -I tools/release/harness_runtime.py --output .local/cache/personal-agent-runtime/manual
agent/.venv/bin/python -I tools/release/harness_runtime.py --output .local/cache/personal-agent-runtime/manual --check
```

On Windows pass `--python` with a CPython 3.12 `python.exe`; the default is macOS's `agent/.venv/bin/python`. See [release components · harness runtime](components.en.md#harness-runtime) for its contents.

### Upgrading Electron

1. Change `electron` in `app/electron/package.json` and its lockfile.
2. In `app/packaging/electron-runtime.lock.json`, change `version` and the version in `archive`, `url` and `checksum_source`.
3. Copy the hash of the `*electron-v<version>-darwin-arm64.zip` line of the new `SHASUMS256.txt` into `sha256`, and the hash of the `*electron-v<version>-win32-x64.zip` line with the new `archive` and `url` into `platforms.win32-x64`. Download both archives once, compute their SHA256 yourself, and commit only when both agree.
4. `tools/release/tests/test_electron_runtime.py` fails while the two versions differ.

## Development deployment

To test web or `agentd` changes on an installed release build of `Agentic Complex.app` without rebuilding the full bundle (macOS only; relies on APFS clones and symlinks), use development deployment. The installed app still supplies signing, permissions, the native shell, and Metal, while the web files, `routes.json`, and `agentd` code come from the development directory, generated byte-for-byte by `stage_ui` and `stage_agentd` in `tools/release/build_components.py`.

To enable it, add this field to `~/Library/Application Support/local.agenticcomplex.companion/config.json` and restart the app once:

```json
"dev_resources": "<absolute-checkout-path>/.local/dev-runtime/current"
```

Run these commands from the main checkout (use `all` for the first deployment):

```sh
python3 -I tools/release/dev_deploy.py web      # Build and deploy the UI, art, and routes.json, then reload web panels
python3 -I tools/release/dev_deploy.py agentd   # Deploy agentd and restart the background service
python3 -I tools/release/dev_deploy.py all      # Deploy both
```

- Each deployment writes a directory named `.local/dev-runtime/<UTC-timestamp>-<commit>[-dirty]/`. APFS clones the unchanged half from the previous deployment (`cp -c`). `dev-receipt.json` records the commit, dirty status, deployed `part`, and UI/`agentd` hashes. An atomic rename updates the `current` symlink so a running `agentd` cannot read a mix of revisions. The tool keeps the five newest deployments.
- When the app is running, `app/electron/src/main/dev-reload.ts` watches the parent directory of `dev_resources`. As soon as `current` switches to a new receipt, it reloads web panels for `web`, restarts `agentd` for `agentd`, and does both for `all`, logging `dev reload <part> commit=...` in `companion.log`. When the app is not running, the script simply stages the deployment files and prints the commit and both hashes.
- The runtime source label in Diagnostics shows `开发目录 │ <commit>` (with `含未提交改动` if dirty) in a warning color, whereas an ordinary packaged build shows `正式打包`. At startup, `companion.log` records `dev_resources <path> commit=<commit>`.
- The app falls back to its bundled Resources for files missing from the development directory. `agentd` loads development code using the app's bundled Python runtime.

To disable development deployment, remove `dev_resources` from `config.json` and restart the app once. The app resumes using its bundled web UI and `agentd`.

Changes to the Electron shell, the helper, Metal renderer, preview service, `Info.plist`, or `agentd`'s Python dependencies require a new `.app` build. Development deployment switches code only and continues using the app's bundled Python environment.
