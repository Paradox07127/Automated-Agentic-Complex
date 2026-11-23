#!/usr/bin/env python3
"""Stage the Windows portable directory `Agentic Complex\\` (C11 windows-x64, portable only) from build outputs and make the
Velopack release of it.

Takes the official Electron win32-x64 root, app/electron after `npm run build`, ac-helper.exe, private\\renderer\\windows\\build
(efw.exe and its product .spv), fbx-motion.exe, the web build, the prepared harness runtime, a CPython 3.12 base prefix,
a character library, vpk and, optionally, the UI art (as release.py's ui_art: the pages' art and the
exe's icon). `vpk pack` turns the directory into <output>/releases/ (Setup.exe, .nupkg, portable zip, feed files); no
signing. Prints one JSON line, the receipt, also written to <output>/pack-receipt.json.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(ROOT / 'agent/agentd'))
from character_library import Library, digest, write_json
from character_tool import compose
import build_components
import windows_exe

PLATFORM = 'windows-x64'
EXECUTABLE = 'Agentic Complex.exe'
HELPER = 'ac-helper.exe'
# The speech runtime ac-helper.exe loads from its own directory, where build.bat puts it (app/helpers/windows/third_party.ps1).
HELPER_DLLS = ('sherpa-onnx-c-api.dll', 'onnxruntime.dll')
# Their licence texts (sherpa-onnx v2.0.2; ONNX Runtime 1.28.2, the build that release carries), copied into licenses\.
HELPER_LICENSES = ROOT / 'app/helpers/windows/licenses'
RENDERER = 'efw.exe'
# The built main process as app/electron/build.mjs writes it on Windows (no preview addon); source maps stay out.
ELECTRON_APP_FILES = ('dist/main.mjs', 'dist/preload.cjs')
# What main/velopack.ts imports from app/electron's node_modules at run time: the velopack package with its win-x64 module
# and its loader @neon-rs/load.
VELOPACK_SDK_FILES = ('node_modules/velopack/package.json', 'node_modules/velopack/lib/index.js', 'node_modules/velopack/lib/load.js',
                      'node_modules/velopack/lib/native/velopack_nodeffi_win_x64_msvc.node',
                      'node_modules/@neon-rs/load/package.json', 'node_modules/@neon-rs/load/dist/index.js',
                      'node_modules/@neon-rs/load/LICENSE')
# vpk's stable package id: Setup.exe installs to %LocalAppData%\<it> and names the uninstall entry after it.
PACK_ID = 'AgenticComplex'
# A SemVer2 MAJOR.MINOR.PATCH, and dot-separated numbers without leading zeros.
APP_VERSION = re.compile(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)')
BUILD_VERSION = re.compile(r'(0|[1-9]\d*)(\.(0|[1-9]\d*))*')
# What agentd, its harness and mcp's Windows stdio client (pywin32) import from runtime.python; agentd imports no anthropic SDK.
RUNTIME_IMPORTS = 'ssl, sqlite3, ctypes, httpx, jwt, mcp, numpy, pydantic_core, cryptography, win32api, win32job'
# The UI art's square icon, from which the macOS release's AppIcon.icns is made too.
ICON_SOURCE = 'brand/AppIcon-1024.png'
# Electron's locales\*.pak the package keeps: Chromium falls back to en-US.pak for any other system language.
LOCALES = ('en-US', 'ja', 'zh-CN', 'zh-TW')
# What agent/browser/native_host.py reads at run time; main/index.ts looks for it in browser\ beside agentd\.
BROWSER_HOST_FILES = ('native_host.py', 'extension-origin')
# contents() lists every file at least this large.
LARGE_FILE = 100 * 1024 * 1024


def stage_host(host, electron_runtime, electron_dir, helper, product_name, app_version):
    """Fill the host payload from the Electron root, the built main process and ac-helper.exe with the DLLs beside it;
    return its placed paths, the executable first."""
    shutil.copytree(electron_runtime, host)
    (host / 'electron.exe').rename(host / EXECUTABLE)
    for pak in (host / 'locales').glob('*.pak'):
        if pak.stem not in LOCALES: pak.unlink()
    # Electron's own app, loaded when resources\app is missing.
    (host / 'resources/default_app.asar').unlink()
    source = json.loads((Path(electron_dir) / 'package.json').read_text(encoding='utf-8'))
    if source['main'] not in ELECTRON_APP_FILES: raise ValueError('electron_main_not_built: ' + source['main'])
    app = host / 'resources/app'
    for relative in ELECTRON_APP_FILES + VELOPACK_SDK_FILES:
        (app / relative).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(Path(electron_dir) / relative, app / relative)
    write_json(app / 'package.json', dict(name=source['name'], productName=product_name, version=app_version,
                                          private=True, type=source['type'], main=source['main']))
    shutil.copy2(helper, host / HELPER)
    for name in HELPER_DLLS:
        if not (Path(helper).parent / name).is_file(): raise ValueError('helper_dll_missing: ' + name)
        shutil.copy2(Path(helper).parent / name, host / name)
    shutil.copytree(HELPER_LICENSES, host / 'licenses')
    shutil.copy2(ROOT / 'app/Resources/parent_watch.py', host / 'resources/parent_watch.py')
    first = [EXECUTABLE, HELPER]
    rest = [path.name for path in host.iterdir() if path.name not in ('resources', 'licenses')]
    rest += [f'{folder}/{path.name}' for folder in ('resources', 'licenses') for path in (host / folder).iterdir()]
    return first + sorted(path for path in rest if path not in first)


def stage_renderer(renderer, build):
    """Copy efw.exe and the product .spv it loads from its own directory; return their names, efw.exe first."""
    shaders = sorted(path.name for path in Path(build).glob('*.spv'))
    if not shaders: raise ValueError('renderer_shaders_missing: ' + str(build))
    renderer.mkdir(parents=True)
    for name in [RENDERER, *shaders]: shutil.copy2(Path(build) / name, renderer / name)
    return [RENDERER, *shaders]


def brand(executable, ui_art, product_name, app_version, build_version):
    """The exe's version resource, and its icon from the UI art when there is one; what reads back."""
    icon = Path(ui_art) / ICON_SOURCE if ui_art else None
    return windows_exe.brand(executable, icon_png=icon.read_bytes() if icon else None, product_name=product_name,
                             app_version=app_version, build_version=build_version, executable=Path(executable).name)


def contents(package):
    """Bytes and file count per top-level entry and per component (host and renderer by their placed paths), the files of
    LARGE_FILE bytes or more, and what looks removable: source maps, __pycache__, test directories, node_modules trees
    and files of 1 MiB or more that appear more than once with the same bytes."""
    package = Path(package)
    files = {path.relative_to(package).as_posix(): path.stat().st_size for path in package.rglob('*') if path.is_file()}

    def under(prefix):
        return [p for p in files if p == prefix or p.startswith(prefix + '/')]

    def tally(paths):
        return dict(files=len(paths), bytes=sum(files[p] for p in paths))
    top = [dict(entry=name, **tally(under(name))) for name in {p.split('/')[0] for p in files}]
    components = []
    for manifest in (package / 'resources/components').glob('*/component.json'):
        doc = json.loads(manifest.read_text(encoding='utf-8'))
        paths = under(manifest.parent.relative_to(package).as_posix())
        paths += [p for placed in doc.get('placed', {}).values() for p in under(placed)]
        components.append(dict(id=doc['id'], **tally(paths)))
    # The outermost node_modules directories.
    modules = {p[:('/' + p).index('/node_modules/') + len('node_modules')] for p in files if '/node_modules/' in '/' + p}
    removable = [dict(what='source maps (*.map)', **tally([p for p in files if p.endswith('.map')])),
                 dict(what='__pycache__ and *.pyc', **tally([p for p in files if '/__pycache__/' in '/' + p or p.endswith('.pyc')])),
                 dict(what='tests/ and test/ directories', **tally([p for p in files if {'tests', 'test'} & set(p.split('/')[:-1])])),
                 *[dict(what=root, **tally(under(root))) for root in sorted(modules)
                   if not any(other != root and root.startswith(other + '/') for other in modules)]]
    same = {}
    for p, size in files.items():
        if size >= 1024 * 1024: same.setdefault((size, digest(package / p)), []).append(p)
    by_size = lambda rows: sorted(rows, key=lambda row: -row['bytes'])
    return dict(top=by_size(top), components=by_size(components),
                large=by_size(dict(path=p, bytes=size) for p, size in files.items() if size >= LARGE_FILE),
                removable=[row for row in removable if row['files']],
                duplicates=by_size(dict(paths=sorted(paths), bytes=size * (len(paths) - 1))
                                   for (size, _), paths in same.items() if len(paths) > 1))


def flip_fuses(executable):
    """flip_fuses.mjs on the exe, whose fuse wire Electron keeps in electron.exe itself on Windows."""
    return json.loads(subprocess.check_output(['node', str(ROOT / 'tools/release/flip_fuses.mjs'), str(executable)],
                                              text=True, encoding='utf-8'))


def release_version(app_version, build_version):
    """The SemVer2 version vpk packs: app_version with build_version as its prerelease. Prerelease numbers compare one by
    one as numbers, so a later build_version (a greater date, or the same date and a greater count) of one app_version is
    the greater version."""
    if not APP_VERSION.fullmatch(app_version): raise ValueError('app_version_not_semver: ' + app_version)
    if not BUILD_VERSION.fullmatch(build_version): raise ValueError('build_version_not_numeric: ' + build_version)
    return f'{app_version}-{build_version}'


def vpk_pack(vpk, package, releases, version, title, icon):
    """vpk pack of the staged directory into releases (Setup.exe, the full .nupkg, a delta .nupkg when releases holds an
    earlier one, the portable zip and the feed files), unsigned; return each file's name, bytes and sha256."""
    argv = [str(vpk), 'pack', '--packId', PACK_ID, '--packVersion', version, '--packDir', str(package), '--mainExe', EXECUTABLE,
            # Without --runtime vpk marks the package x86.
            '--packTitle', title, '--runtime', 'win-x64', '--outputDir', str(releases), *(['--icon', str(icon)] if icon else []),
            # No check for a newer vpk and no live console widgets in a build log.
            '--skip-updates', '--legacyConsole']
    subprocess.run(argv, check=True, timeout=1800)
    return [dict(file=path.name, bytes=path.stat().st_size, sha256=digest(path)) for path in sorted(Path(releases).iterdir())
            if path.is_file()]


def check_runtime_python(python):
    """Run the shipped python.exe with only SYSTEMROOT in its environment: it must import RUNTIME_IMPORTS and have
    its prefix and every sys.path entry in its own directory, so no installed Python is needed."""
    code = 'import json, sys, ' + RUNTIME_IMPORTS + '; print(json.dumps([sys.prefix, sys.path]))'
    done = subprocess.run([str(python), '-I', '-B', '-c', code], env={'SYSTEMROOT': os.environ.get('SYSTEMROOT', 'C:\\Windows')},
                          cwd=python.parent, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=120)
    if done.returncode:
        raise ValueError('runtime_python_import_failed: ' + (done.stderr.strip().splitlines() or ['exit ' + str(done.returncode)])[-1])
    prefix, path = json.loads(done.stdout)
    home = os.path.normcase(str(python.parent))
    if os.path.normcase(prefix) != home: raise ValueError('runtime_python_prefix: ' + prefix)
    outside = [entry for entry in path if os.path.normcase(entry) != home and not os.path.normcase(entry).startswith(home + os.sep)]
    if outside: raise ValueError('runtime_python_path_outside: ' + ', '.join(outside))


def stage(*, library, python, harness_runtime, web_dist, electron_runtime, electron_dir, helper, renderer,
          fbx_tool, output, build_version, vpk, port=None, id=None, product_name=None, app_version=None, ui_art=None):
    """Write output/Agentic Complex/, vpk pack it into output/releases/ and return the receipt: its path, file count, bytes,
    the fuses and the exe's resources read back per exe, the UI art shipped, contents(), the release version and files."""
    output = Path(output).resolve()
    if output.exists(): raise ValueError('output already exists')
    version = release_version(app_version or '0.2.0', build_version)
    identity = id or 'local.agenticcomplex.companion'
    library = Path(library).resolve()
    catalog = Library(library).snapshot()
    output.mkdir(parents=True)
    package = output / 'Agentic Complex'; resources = package / 'resources'
    # Not mkdtemp: on Windows that directory admits only the building user, and the trees moved out of it keep its ACL.
    component_stage = output / '.components'; component_stage.mkdir()
    try:
        components = build_components.stage_components(component_stage, python=python,
            harness_runtime=harness_runtime, web_dist=web_dist, ui_art=ui_art, library=library, build_version=build_version,
            fbx_tool=fbx_tool, platform=PLATFORM)
        browser = component_stage / 'agentd/payload/browser'; browser.mkdir()
        for name in BROWSER_HOST_FILES: shutil.copy2(ROOT / 'agent/browser' / name, browser / name)
        host = component_stage / 'host/payload'
        product_name, app_version = product_name or 'Agentic Complex', app_version or '0.2.0'
        host_paths = stage_host(host, electron_runtime, electron_dir, helper, product_name, app_version)
        renderer_paths = stage_renderer(component_stage / 'renderer/payload', renderer)
        build_components.validate_canon_windows(component_stage / 'agentd/payload/agentd' / build_components.CANON_RELATIVE)
        # Before the fuses: the resource update rewrites the exe.
        branding = {path.name: brand(path, ui_art, product_name, app_version, build_version)
                    for path in (host / EXECUTABLE, host / HELPER, component_stage / 'renderer/payload' / RENDERER)}
        fuses = flip_fuses(host / EXECUTABLE)
        with tempfile.TemporaryDirectory(prefix='.catalog-', dir=output) as temporary_catalog:
            compose([component_stage / component['id'] / 'payload' for component in components
                     if component['id'].startswith('characters.')], catalog.get('default_character'), Path(temporary_catalog))
            catalog_sha256 = digest(Path(temporary_catalog) / 'current.json')
        components.extend([
            dict(id='host', version=build_version, entrypoints={'executable': EXECUTABLE},
                 provides={}, requires={'C6': '1', 'C9': '1'}, placed={path: path for path in host_paths}),
            dict(id='renderer', version=build_version, entrypoints={'executable': RENDERER},
                 provides={}, requires={}, placed={path: path for path in renderer_paths})])
        references = build_components.write_manifests(component_stage, components, platform=PLATFORM)
        # Same volume: the staged trees move into place instead of being copied again.
        for component in components:
            source = component_stage / component['id']
            target = resources / 'components' / component['id']
            target.parent.mkdir(parents=True, exist_ok=True)
            if 'placed' not in component:
                os.replace(source, target)
                continue
            target.mkdir()
            os.replace(source / 'component.json', target / 'component.json')
            for relative, placed in component['placed'].items():
                destination = package / placed
                destination.parent.mkdir(parents=True, exist_ok=True)
                os.replace(source / 'payload' / relative, destination)
        write_json(resources / 'distribution.json', dict(schema='endfield-distribution/v3', id=identity, edition='replacement',
            layout='portable', port=port or 48800, catalogSHA256=catalog_sha256, defaultCharacter=catalog.get('default_character')))
        host_ref = next(ref for ref in references if ref['id'] == 'host')
        build_components.component_manifest.write_lock(resources / 'composition.lock.json', 'portable', host_ref,
            [dict(ref, placement='bundle') for ref in references if ref['id'] != 'host'], platform=PLATFORM)
    finally:
        shutil.rmtree(component_stage)
    check_runtime_python(resources / 'components/runtime.python/payload/python.exe')
    # The .ico brand() embeds, for Setup.exe and Update.exe.
    icon = output / 'AppIcon.ico' if ui_art else None
    if icon: icon.write_bytes(windows_exe.ico(windows_exe.icon((Path(ui_art) / ICON_SOURCE).read_bytes())))
    try:
        releases = vpk_pack(vpk, package, output / 'releases', version, product_name, icon)
    finally:
        if icon: icon.unlink()
    files = [path for path in package.rglob('*') if path.is_file()]
    # Of the manifest's characters/ the package carries only the library's.
    shipped = resources / 'components/web-ui/payload/ui/art'
    receipt = dict(package=package.name, files=len(files), bytes=sum(path.stat().st_size for path in files), fuses=fuses,
                   branding=branding, contents=contents(package),
                   ui_art=ui_art and dict(files=sum(path.is_file() for path in shipped.rglob('*')),
                                          manifest_sha256=digest(Path(ui_art) / 'art-manifest.json')),
                   pack_id=PACK_ID, version=version, releases=releases)
    write_json(output / 'pack-receipt.json', receipt)
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    for key, help in [('library', 'The character library (its current.json)'),
                      ('python', 'The CPython 3.12 base prefix, the directory of python.exe'),
                      ('harness-runtime', 'harness_runtime.py --output'), ('web-dist', 'The vite build of web/'),
                      ('electron-runtime', 'electron_runtime.py: the unpacked root holding electron.exe'),
                      ('electron-dir', 'app/electron after npm run build'), ('helper', 'ac-helper.exe, the DLLs of HELPER_DLLS beside it'),
                      ('renderer', 'private\\renderer\\windows\\build: efw.exe and its .spv'), ('fbx-tool', 'fbx-motion.exe'),
                      ('vpk', "vpk.exe, Velopack's packer, at app/packaging/velopack.lock.json's version"),
                      ('output', 'A new directory; Agentic Complex\\ is written in it')]:
        parser.add_argument('--' + key, type=Path, required=True, help=help)
    parser.add_argument('--ui-art', type=Path, help='The UI art: art-manifest.json, the files it lists and ' + ICON_SOURCE)
    parser.add_argument('--build-version', default='20261121.1')
    parser.add_argument('--port', type=int)
    parser.add_argument('--id')
    parser.add_argument('--product-name')
    parser.add_argument('--app-version')
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding='utf-8')
    print(json.dumps(stage(**{key.replace('-', '_'): value for key, value in vars(args).items()}), ensure_ascii=False), flush=True)
