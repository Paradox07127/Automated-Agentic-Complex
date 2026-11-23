# Release components and installation

[简体中文](components.md)

Agentic Complex has seven component types, with a separate `characters.<id>` component for each character. The macOS `Agentic Complex.app` is the primary packaged format, and components from a single build can be assembled into two layouts.

- **Portable.** One `Agentic Complex.app` bundles every component.
- **Split.** `Agentic Complex.app` bundles host, renderer, and web-ui. The other components ship in `components/` beside the app and are imported on first launch.

The same component has the same contents in both layouts. C11 manifests and composition locks also support `windows-x64` for the work-in-progress Windows portable directory build (`tools/release/package_windows.py`; see [Windows portable directory](#windows-portable-directory)). [C11](../protocol/C11-components/CONTRACT.md) defines manifests, composition locks, and the import index. The [protocol index](../protocol/README.md) lists interfaces between components.

## 1. Components

| ID | Contents | Dependencies | Portable location | Split location |
|---|---|---|---|---|
| `host` | The Electron shell `MacOS/AgenticComplex` with its `Resources/app/`, and the platform helper `MacOS/ac-helper`. Resolves and imports components and supervises subprocesses. | C6 and C9 interfaces provided by agentd | Fixed paths in the app | Same |
| `renderer` | Metal renderer `MacOS/AgenticComplexMetalAvatar` (also serves the character page preview) | — | Fixed paths in the app | Same |
| `web-ui` | Web UI in `ui/` and bridge routing table in `ui-bridge/` | — | `Contents/Resources/components/web-ui/` | Same |
| `runtime.python` | CPython and agentd's Python dependencies. Entrypoint `bin/agentic-complex-python`. | — | `Contents/Resources/components/<ID>/` | `components/<ID>/` |
| `agentd` | agentd code, `content/`, `agentd_launcher.py`, and tools such as `character_tool.py` | `runtime.python` | As above | As above |
| `harness.pi` | Node and the Pi runtime | — | As above | As above |
| `characters.<id>` | One character package | — | As above | As above |

- Each component directory contains a `component.json` with its ID, version, tree hash, entrypoints, and dependencies. Host and renderer files stay at their designated paths within the app. Other components use `payload/`.
- The browser extension in `agent/browser` is installed separately from the release.

## 2. Build a release

- Build from the current `main` commit with clean shipping sources. The build checks both conditions at the start and end. Keep `main` at the same commit throughout the build.
- Prepare a full passing gate receipt for the same source fingerprint from the `commit` or `release` profile. Not a partial one. `python3 -I tools/qa/gate.py --profile commit` produces the receipt; see [development and releases](development.en.md#verification-gates).
- Put Node.js 24.22.1 or later on PATH and prepare the character library and any UI art required by the release profile. The build stops when a required input is missing. The release reads the public profile `app/packaging/release.json` by default, or the local profile when one exists.

```sh
bash app/build_app.sh                    # Portable
bash app/build_app.sh --layout split     # Split
bash app/build_app.sh --check            # Check release inputs without building
```

- `--output <directory>` selects a new output directory. The default is `app/build/releases/<timestamp>-<first-eight-commit-characters>/`.
- `--build-version <version>` sets `CFBundleVersion` and the versions of host, renderer, web-ui, and agentd. The default is the build timestamp.
- On success, the final JSON line has `release_ready: true` and gives the app path in `app`.

The output directory contains the following.

| File | Portable | Split |
|---|---|---|
| `Agentic Complex.app` | All components | host, renderer, and web-ui |
| `components/index.json`, `components/<ID>/` | — | External components and index |
| `release-receipt.json` | Commit, layout, component references, gate receipt, and smoke-test results | Same |
| `staging-manifest.json` | Layout, host, and component references | Same |
| `source-manifest.json` | Packaged source files and source fingerprint | Same |
| `bundle-manifest.json` | Files in the signed app | Same |
| `artifact-smoke.json` | Artifact smoke-test results | Same |
| `gate-receipt.json` | Gate results and source fingerprint for the build | Same |

Mach-O files in component payloads are signed once during component assembly and copied byte-for-byte into both layouts. App signing skips `Contents/Resources/components/`.

## 3. Compare layouts

Build both layouts from the same commit and use the same `--build-version` for both.

```sh
bash app/build_app.sh --build-version "$build_version" --output "$portable_dir"
bash app/build_app.sh --layout split --build-version "$build_version" --output "$split_dir"
python3 -I tools/release/compare_layouts.py --portable "$portable_dir" --split "$split_dir"
```

Set `build_version` to the shared version and choose distinct, new paths for `portable_dir` and `split_dir`. The comparison checks the following.

- The two layouts have the same component IDs and the same set of files in each component.
- Mach-O comparisons use the CDHash of each architecture slice.
- The host executable is compared by code page hashes. Its signature seals `Contents/Resources`, which differs by layout.
- Signed bundles are compared by CodeDirectory. Their `_CodeSignature/CodeSignature` CMS blobs are skipped because the signing timestamps differ.
- `component.json` is compared without `tree_sha256`, and `distribution.json` without `layout`.
- Other files are compared by SHA-256. Execute bits are excluded from the comparison.

The tool reports one result per component and ends with `LAYOUTS SAME` (exit 0) or `LAYOUTS DIFFER` (exit 1). Argument or read errors exit with code 2.

## 4. Install and run

The support directory is `~/Library/Application Support/<distribution-id>/`. The ID comes from the `id` field in `Contents/Resources/distribution.json`. The release ID is `local.agenticcomplex.companion`. Settings, the character library, and logs stay in this directory when the app is replaced.

### Portable

Quit Agentic Complex, replace the old `Agentic Complex.app` with the new one, and launch it.

### Split

1. Place `Agentic Complex.app` and `components/` in the same directory.
2. Launch the app. The host checks the sibling index against the sealed `Contents/Resources/components-index.json` and copies missing components to `<support-dir>/components/<ID>/<version>-<first-eight-tree-hash-characters>/`. It recomputes the tree hash and checks entrypoints before renaming each verified copy into place. It then writes `<support-dir>/components/composition.lock.json`.
3. If a component fails verification, the host records `component import failed: <ID> <reason>` in `<support-dir>/logs/companion.log`, marks the component as missing, and continues importing the others.
4. On every launch the host verifies the manifest SHA-256, payload tree hash, file count, byte count and entrypoints of installed components before using them.
5. If the sibling directory is absent, the app still verifies installed components against its sealed index.
6. If `index.json` is invalid, the app reports a component import failure and skips starting subprocesses.

To upgrade, quit the app, replace `Agentic Complex.app` and `components/` together with the pair from one build, and launch it. New component versions install in new directories. Older versions remain on disk. The app's `distribution.json` pins the character catalog SHA. The sibling index must match the build.

## 5. Missing components

On launch, the host reads the composition lock and checks every component's manifest, entrypoints, and dependencies. It records failed components in the `missing_components` map (ID to reason) in `<support-dir>/config.json`. Their subprocesses stay stopped.

Reasons include `componentMissing`, `manifestInvalid`, `manifestMismatch`, `entrypointMissing`, and `requirementUnmet`. An unmet dependency also marks a component as missing. For example, missing `runtime.python` marks `agentd` with `requirementUnmet`. In the split layout, a failed import logs the import reason, such as `treeMismatch`. For a rejected external component, `missing_components` records it as `componentMissing`.

The menu bar shows one row per subprocess. The renderer is labeled 「角色」, and agentd is labeled 「后台」.

| Missing component | Menu bar or window feedback | What still works |
|---|---|---|
| `renderer` | 「角色」 reports a missing renderer component. | Background service and web panels |
| `agentd` | 「后台」 reports a missing agentd component. Character and animation imports report the same missing component. | Character display |
| `runtime.python` | 「后台」 reports missing agentd. | Character display |
| A `characters.<id>` component, with an existing character library | — | The host continues with the existing library and logs `seed migration deferred`. |
| `agentd`, `runtime.python`, or a `characters.<id>` component on first launch without a character library | 「角色」 and 「后台」 report that the missing `<ID>` component prevents character library setup. | Menu bar. Supply the component and relaunch to build the library. |
| `web-ui` | The main window opens a fallback page showing the unreadable `routes.json` path. | Character and background service |

The host restarts crashed subprocesses with backoff and marks them as failed after five crashes in 300 seconds. Renderer exit code 78 (package and program version mismatch) or 69 (GPU unavailable) goes directly to the failed state.

## 6. Run components independently

The commands below can run without other release components installed. `<python>` means `bin/agentic-complex-python` from runtime.python, or `agent/.venv/bin/python -I -B` in the checkout. `<agentd>` means the agentd component's `payload/`. In the checkout, the launcher is `app/Resources/agentd_launcher.py` and the Python source directory is `agent/agentd`.

| Component | Run independently | When a peer is absent | Gate suite |
|---|---|---|---|
| `host` | `app/electron/test/e2e-headless.test.ts` starts the main process's supervision, agentd from the checkout, a simulated renderer (fixtures in `app/Tests/Fixtures/HeadlessE2E`), and fake TTS without windows. It covers missing agentd and missing renderer. After `npm --prefix app/electron run build`, run `AAC_ELECTRON_E2E=1 node --test test/e2e-headless.test.ts` in `app/electron`. Tests skip unless `AAC_ELECTRON_E2E=1` is set. | The missing subprocess is marked failed. Other subprocesses continue. | `electron-e2e` |
| `renderer` | `Agentic Complex.app/Contents/MacOS/AgenticComplexMetalAvatar --describe` prints supported interface versions. `--validate-pack <bundle.json>` validates a character package. Omitting `--agentic-complex-host-socket` runs the renderer independently of Companion. | If agentd is unavailable it reports `configuration_unavailable`, retries periodically, and continues showing the character. | `host-link` (real renderer reads C1 fixtures), `metal-host` |
| `web-ui` | Run `npm --prefix web run dev` and open `/main.html#/overview`. The fake bridge supplies host and agentd responses. | — | `web-unit`, `web-visual` |
| `runtime.python` | `<python> -c 'import sys; print(sys.version)'` | — | Release `artifact_smoke.py` |
| `agentd` | `<python> <agentd>/agentd_launcher.py --agentd-dir <agentd>/agentd -- --port 0 --state-dir <dir> --character-catalog <library>/current.json`. Port 0 asks the operating system to choose a port, written to `<dir>/ui-runtime.json`. The bundled component requires `--character-catalog` because the checkout's sample library under `characters/sample-library` is absent. Use `-- --describe` to print contract versions. | Runs without the host. | `agentd-unit` (including `test_c9_process.py`) |
| `characters.<id>` | `<python> <agentd>/agentd/character_tool.py validate <character-package-dir>`, or `AgenticComplexMetalAvatar --validate-pack <bundle.json>` | — | `agentd-unit` (`test_character_library.py`, `test_character_compose.py`) |
| Browser extension (separate from the release) | `node --test agent/browser/extension/test_*.mjs` | The native host runs and reports that agentd is unavailable. | `browser-unit` |

Component reads and writes go through the interfaces in the protocol index. The `cross-paths` gate (`python3 -I tools/qa/check_paths.py --components`) checks shipping sources for direct paths into other components. `protocol/cross-paths.json` lists permitted exceptions and known cases to fix.

## 7. Packaging internals

### Release tools

The release entry point is `bash app/build_app.sh`, which calls `tools/release/release.py` through `app/package_release.sh`. The tools in `tools/release/`:

- `release.py`: the mainline release. It checks main and uncommitted product sources, the gate receipt and the UI art, builds the web UI, the Electron shell and the Swift binaries (helper, renderer), then calls `package_app.py`, signs, runs `inventory_app.py` and the artifact smoke test, and writes `release-receipt.json`.
- `package_app.py`: assembles `Agentic Complex.app` and the C11 components, and writes `source-manifest.json` and `staging-manifest.json`.
- `build_components.py`: stages each component's payload before signing and writes its `component.json` after signing.
- `component_manifest.py`: writes component manifests and composition locks, and computes payload tree hashes (`hash <dir>` prints one tree hash).
- `compare_layouts.py`: compares the two layouts; see [§3](#3-compare-layouts).
- `harness_runtime.py`: prepares and validates the harness runtime (Python dependencies, Pi and Node); see [harness runtime](#harness-runtime) below.
- `inventory_app.py`: the signed app's file list `bundle-manifest.json`.
- `source_fingerprint.py`, `gate_receipt.py`: the source fingerprint and gate receipts, written by `tools/qa/gate.py` and checked by `release.py`.
- `dev_deploy.py`: deploys the web UI and agentd to an installed app without repackaging; see [development and releases · development deployment](development.en.md#development-deployment).

### Release profile keys

`release.py` builds `app/electron` (`npm run build`) and `app/helpers/mac`, and assembles the host from the locked `Electron.app`. It reads these keys of the release profile:

| Key | Default | Meaning |
|---|---|---|
| `product_name` | `"Agentic Complex"` | `productName` of `Resources/app/package.json`, plus `CFBundleName` and `CFBundleDisplayName`. The app directory stays `Agentic Complex.app` |
| `app_version` | `"0.2.0"` | `version` of `Resources/app/package.json` and `CFBundleShortVersionString` |
| `notary_keychain_profile` | absent | A `notarytool store-credentials` profile name. With it the signing identity must start with `Developer ID Application:`; after signing the release notarizes and staples the app through `tools/release/notarize.py` and records the submission id and status as `notarization` in `release-receipt.json` |

The character library, art and `content_overrides` keys are in [development and releases · release profile](development.en.md#release-profile).

### Electron runtime

The host is assembled from Electron's official macOS or Windows release, not from `app/electron/node_modules/electron/dist` (`npm ci --ignore-scripts` does not download it). `tools/release/electron_runtime.py` fetches the archive that `app/packaging/electron-runtime.lock.json` names for the running platform (`darwin-arm64`, or `win32-x64` on Windows), checks its SHA256 and unpacks it:

```sh
python3 -I tools/release/electron_runtime.py
```

The default cache is `.local/cache/electron-runtime/`. It keeps the verified archive, which is not downloaded again while its hash matches, and unpacks it afresh into `electron-v<version>-<platform>/` with `Electron.app` and the release's license files. On macOS unpacking uses `/usr/bin/ditto`, which keeps the framework symlinks and executable bits that Python's `zipfile` drops. The Windows zip has no links and is unpacked with `zipfile`; its root holds `electron.exe`, its DLLs, `resources/`, `locales/` and the license files.

The lock's top-level fields are the `darwin-arm64` entry; `platforms.win32-x64` gives `archive`, `url` and `sha256` of the Windows asset of the same release, and the other fields are shared.

| Field | Meaning |
|---|---|
| `schema` | `endfield-electron-runtime/v1`; any other value is rejected |
| `version` | Electron version; must equal `devDependencies.electron` in `app/electron/package.json` |
| `platform` | Platform of the top-level entry, `darwin-arm64` |
| `archive` | Asset file name, `electron-v<version>-<platform>.zip` |
| `url` | Asset URL; only `https://github.com/electron/electron/releases/download/` is accepted |
| `sha256` | SHA256 of the archive, copied from the release's `SHASUMS256.txt` |
| `checksum_source` | The `SHASUMS256.txt` URL of the same release |
| `license_file` | Electron's license at the archive root, next to `Electron.app` (on Windows next to `electron.exe`) |
| `platforms` | `{"win32-x64": {"archive", "url", "sha256"}}`, with the same rules as the top-level fields |

The upgrade steps are in [development and releases · upgrading Electron](development.en.md#upgrading-electron).

### Host assembly

`stage_electron_host` in `package_app.py` takes `Electron.app/Contents` whole:

- It renames `MacOS/Electron` to `MacOS/AgenticComplex` and removes `Resources/default_app.asar` and `Resources/electron.icns`.
- The bundle ids of Electron's helper apps start with the distribution id instead.
- It adds `Resources/app/` (`package.json`, `dist/main.mjs`, `dist/preload.cjs`, `dist/native/preview.node`) and `MacOS/ac-helper`.
- `Info.plist` keeps Electron's keys except `ElectronAsarIntegrity`, the icon and every `*UsageDescription`, then takes the distribution identity, the app's own usage strings and the build keys.

### Fuses

Before the staged app is signed, `tools/release/flip_fuses.mjs` turns off the `RunAsNode`, `EnableNodeOptionsEnvironmentVariable` and `EnableNodeCliInspectArguments` fuses with `@electron/fuses` (a devDependency of `app/electron`, so `app/electron` needs `npm ci --ignore-scripts` first) and leaves every other fuse at Electron's default:

```sh
node tools/release/flip_fuses.mjs "<output>/Agentic Complex.app"
```

On macOS the fuse wire is in `Contents/Frameworks/Electron Framework.framework/Electron Framework`. The script prints the fuses read back as one JSON object (`file`, `version`, and `fuses` mapping each fuse name to `enabled`, `disabled` or `removed`); it fails when the framework has no fuse wire. It does not re-sign; `sign_bundle.sh` signs the whole app right after. The development Electron in `app/electron/node_modules` is never flipped.

### Entitlements

`tools/platform/sign_bundle.sh` passes the files in `app/packaging/entitlements/` with `--entitlements` only when the identity is a Developer ID Application certificate (hardened runtime on). It matches the path below the app's `Contents/` (or below a component payload); the app itself uses `main.plist`. Apple adds entitlements only to executables; shared libraries, frameworks and in-process plug-ins inherit those of their host executable ([Hardened Runtime](https://developer.apple.com/documentation/security/hardened-runtime)). No file grants `com.apple.security.get-task-allow`, which notarization rejects ([Resolving common notarization issues](https://developer.apple.com/documentation/security/resolving-common-notarization-issues)).

| File | Signed path | Origin |
|---|---|---|
| `main.plist` | the app (`Contents/MacOS/AgenticComplex`) | osx-sign `default.darwin.plist` without camera, bluetooth, print, USB, location and photos; plus Apple Events |
| `helper.plist` | `Frameworks/* Helper.app` | `main.plist` without audio input and Apple Events: the pages record nothing, and only the main process starts `osascript` |
| `helper-gpu.plist` | `Frameworks/* Helper (GPU).app` | osx-sign `default.darwin.gpu.plist` |
| `helper-renderer.plist` | `Frameworks/* Helper (Renderer).app` | osx-sign `default.darwin.renderer.plist` |
| `helper-plugin.plist` | `Frameworks/* Helper (Plugin).app` | osx-sign `default.darwin.plugin.plist` |
| `node.plist` | `node/bin/node` in the `harness.pi` payload | Node's `tools/osx-entitlements.plist` without `get-task-allow` |
| `python.plist` | `bin/python3.<minor>` in the `runtime.python` payload | empty |
| `ac-helper.plist` | `MacOS/ac-helper` | the platform helper records audio and sends Apple events itself; it and the app both carry those keys |
| `renderer.plist` | `MacOS/AgenticComplexMetalAvatar` | empty |

The osx-sign files are taken at commit `ca7726ffb7da556a20ba95ab9c013049afdda6fb` ([entitlements](https://github.com/electron/osx-sign/tree/ca7726ffb7da556a20ba95ab9c013049afdda6fb/entitlements)); its `src/sign.ts` picks them by path: `(Plugin).app`, `(GPU).app`, `(Renderer).app`, else `default.darwin.plist` for the app and a plain `Helper.app` alike. Node's file is taken at tag `v24.22.1` (the runtime locked in `app/packaging/node-runtime.lock.json`, [osx-entitlements.plist](https://github.com/nodejs/node/blob/v24.22.1/tools/osx-entitlements.plist)); Node's own `tools/osx-codesign.sh` signs `bin/node` with it, `--options runtime` and `--timestamp`.

| Key | Files | Meaning |
|---|---|---|
| [`com.apple.security.cs.allow-jit`](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.allow-jit) | main, helper, helper-gpu, helper-renderer, helper-plugin, node | May create writable and executable memory with `MAP_JIT` |
| [`com.apple.security.device.audio-input`](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input) | main, ac-helper | May record audio with the microphone |
| [`com.apple.security.automation.apple-events`](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.automation.apple-events) | main, ac-helper | May ask the user's permission to send Apple events to other apps |
| [`com.apple.security.cs.allow-unsigned-executable-memory`](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.allow-unsigned-executable-memory) | helper-plugin, node | May create writable and executable memory without the `MAP_JIT` restrictions |
| [`com.apple.security.cs.disable-library-validation`](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.disable-library-validation) | helper-plugin, node | May load plug-ins or frameworks that are not code signed |
| [`com.apple.security.cs.disable-executable-page-protection`](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.disable-executable-page-protection) | node | Turns off all code signing protections at launch and while running |
| [`com.apple.security.cs.allow-dyld-environment-variables`](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.allow-dyld-environment-variables) | node | May be affected by dynamic linker environment variables |

### Harness runtime

A release ships one harness: Pi, in the `harness.pi` component. No Claude Agent SDK, Codex package or Claude or Codex CLI is packaged; Claude and Codex run through the CLI installed on the user's machine. No user credentials are packaged.

- The Python packages are installed from `agent/agentd/requirements-character-agent.lock` and `app/packaging/requirements-content.lock` (numpy for the VMD importer) with mandatory wheel hashes. Every platform wheel carries a second `--hash` (the `win_amd64` cp312 wheel); `pywin32` (an `mcp` dependency on Windows) is pinned with `; sys_platform == "win32"` and skipped on macOS.
- Preparation always installs Pi's locked npm tree (without lifecycle scripts) and the official standalone Node binary. Node's version and SHA256 are pinned in `app/packaging/node-runtime.lock.json`: its top-level fields are the `darwin-arm64` tarball, and `platforms.win32-x64` gives `archive`, `url` and `sha256` of the official `node-v<version>-win-x64.zip`. On macOS the version and Mach-O library checks reject a Homebrew launcher; on Windows only the version is checked.
- After `npm ci` the installer drops `docs/`, `examples/` and `CHANGELOG.md` from the `@earendil-works/*` packages and the `@aws-sdk`, `@smithy` and `@google` provider SDKs.
- The preparation tool uses a temporary installer venv and adds neither pip nor packages to the developer interpreter. Cached payloads record the source-lock hashes and every file and link hash; missing files, altered permissions, external links, stale locks, wrong package versions and a missing Node or Pi tree fail validation. Packaging copies site-packages exclusively from the prepared, hash-locked wheel installation.
- Original dependency licence notices stay inside their packages; numpy's are also copied to `runtime.python/payload/licenses/numpy`. `staging-manifest.json` records the runtime's provenance and every component reference; `release-receipt.json` copies the references and records the layout.
- Payload paths: Node is `harness.pi/payload/node/bin/node`, Pi is `harness.pi/payload/pi-runtime`, and Node's licence is `harness.pi/payload/licenses/Node-LICENSE`. A prepared Windows runtime keeps the zip layout (`node/node.exe` and `node/node_modules/npm`), and the installer venv's interpreter is `Scripts\python.exe`.
- `--check` on the release entry is read-only: it reports the layout and whether the dependency cache is prepared. A normal build prepares the cache when needed. An explicit `--harness-runtime <absolute path>` must already validate. The stand-alone commands are in [development and releases · preparing the harness runtime](development.en.md#preparing-the-harness-runtime).

### Windows portable directory

Windows has only the portable layout: `tools/release/package_windows.py` assembles the build outputs into one directory `Agentic Complex\`, with no installer and no signing.

- Root: `Agentic Complex.exe` (the renamed `electron.exe` without `resources\default_app.asar`; `flip_fuses.mjs` flips the fuses in the exe itself), Electron's DLLs and resources, `ac-helper.exe`, and `efw.exe` with the `*.dxbc` files it reads from its own directory. `resources\` holds `app\`, `parent_watch.py`, `distribution.json`, `composition.lock.json` and `components\<id>\`. Manifests and the composition lock use platform `windows-x64`.
- `runtime.python`: the build host's CPython 3.12 base prefix (without `Scripts`, `Doc`, `include`, `libs`, `Tools`, `Lib\test` and the original `Lib\site-packages`). The prepared locked packages go into `Lib\site-packages`, so `pywin32.pth` takes effect. The entry point is `python.exe` with no shell wrapper; the shell passes `-I -B`. Packaging finally runs it in the finished directory with only `SYSTEMROOT` set, and an import failure or a prefix or `sys.path` outside the directory is an error.
- The `harness.pi` entry point is `node\node.exe`; the agentd component's `fbx_tool` is `tools\fbx-motion.exe`.
