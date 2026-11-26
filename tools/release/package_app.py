#!/usr/bin/env python3
"""Stage Agentic Complex.app with portable or split components and a selectable character library, which may be empty.

Requires the locked Electron.app, the built app/electron, ac-helper and Metal binaries, and a validated seed library.
Never writes to the installed app, primary checkout or user configuration.
App signing and hardware smoke follow staging and are recorded separately.
"""
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(ROOT / 'agent/agentd'))
from character_library import Library, Package, digest, write_json
from character_tool import compose
from release import release_guard
from harness_runtime import LAYOUT, validate_runtime
import build_components
import component_manifest
import source_fingerprint


def tree_sha256(root):
    """SHA-256 of the sorted {relative path: file SHA-256} JSON of every file under root."""
    files = {path.relative_to(root).as_posix(): digest(path) for path in sorted(root.rglob('*')) if path.is_file()}
    return hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()


def sign_payload(payload):
    subprocess.run(['bash', str(ROOT / 'tools/platform/sign_bundle.sh'), '--payload', str(payload)], check=True)


def strip_local_symbols(binary):
    """Remove the local and debug symbols of a staged Mach-O; the build's dSYM stays outside the app."""
    subprocess.run(['strip', '-x', str(binary)], check=True)


USAGE_DESCRIPTIONS = dict(NSAppleEventsUsageDescription='按设置读取前台浏览器域名或跳转会话。',
    NSMicrophoneUsageDescription='按住说话时将语音转为文字。',
    NSSpeechRecognitionUsageDescription='按住说话时在本机把语音转成文字。')
# The built main process as app/electron/build.mjs writes it; source maps stay out.
ELECTRON_APP_FILES = ('dist/main.mjs', 'dist/preload.cjs', 'dist/native/preview.node')
# Electron's own app (loaded when Resources/app is missing) and its icon.
ELECTRON_DROPPED = ('Resources/default_app.asar', 'Resources/electron.icns')
# The .lproj languages kept in the app and in Electron Framework; Chromium names its gendered variants <language>_<GENDER>.
ELECTRON_LANGUAGES = ('en', 'zh_CN', 'zh_TW', 'ja')


def stage_electron_host(host, electron_app, electron_dir, helper, identity, product_name, app_version):
    """Fill the host payload from the locked Electron.app, the built main process and the platform helper;
    return the host's placed paths, the executable first."""
    shutil.copytree(Path(electron_app) / 'Contents', host, symlinks=True)
    main = plistlib.loads((host / 'Info.plist').read_bytes()); electron_id = main['CFBundleIdentifier']
    (host / 'MacOS' / main['CFBundleExecutable']).rename(host / 'MacOS/AgenticComplex')
    for relative in ELECTRON_DROPPED: (host / relative).unlink()
    for resources in (host / 'Resources', host / 'Frameworks/Electron Framework.framework/Versions/A/Resources'):
        for lproj in sorted(resources.glob('*.lproj')):
            if re.sub('_(FEMININE|MASCULINE|NEUTER)$', '', lproj.stem) not in ELECTRON_LANGUAGES: shutil.rmtree(lproj)
    # Electron's helper ids extend its own; they take the distribution id in its place.
    for plist in sorted((host / 'Frameworks').glob('*.app/Contents/Info.plist')):
        info = plistlib.loads(plist.read_bytes())
        if not info['CFBundleIdentifier'].startswith(electron_id + '.'):
            raise ValueError('electron_helper_id_unexpected: ' + info['CFBundleIdentifier'])
        info['CFBundleIdentifier'] = identity + info['CFBundleIdentifier'][len(electron_id):]
        plist.write_bytes(plistlib.dumps(info))
    source = json.loads((Path(electron_dir) / 'package.json').read_text())
    if source['main'] not in ELECTRON_APP_FILES: raise ValueError('electron_main_not_built: ' + source['main'])
    app = host / 'Resources/app'
    for relative in ELECTRON_APP_FILES:
        (app / relative).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(Path(electron_dir) / relative, app / relative)
    write_json(app / 'package.json', dict(name=source['name'], productName=product_name, version=app_version,
                                          private=True, type=source['type'], main=source['main']))
    shutil.copy2(helper, host / 'MacOS/ac-helper')
    strip_local_symbols(host / 'MacOS/ac-helper')
    shutil.copy2(ROOT / 'app/Resources/parent_watch.py', host / 'Resources/parent_watch.py')
    first = ['MacOS/AgenticComplex', 'MacOS/ac-helper']
    rest = [path.relative_to(host).as_posix() for path in host.iterdir() if path.name not in ('MacOS', 'Resources')]
    rest += [path.relative_to(host).as_posix() for name in ('MacOS', 'Resources') for path in (host / name).iterdir()]
    return first + sorted(path for path in rest if path not in first)


def electron_info(info, identity, product_name, app_version, common, icon):
    """Electron's Info.plist as the host's: without its usage strings and its default app's asar integrity."""
    kept = {key: value for key, value in info.items()
            if key not in ('ElectronAsarIntegrity', 'CFBundleIconFile') and not key.endswith('UsageDescription')}
    return {**kept, **common, 'CFBundleShortVersionString': app_version, 'CFBundleIdentifier': identity,
            'CFBundleName': product_name, 'CFBundleDisplayName': product_name, 'CFBundleExecutable': 'AgenticComplex',
            **USAGE_DESCRIPTIONS, **(dict(CFBundleIconFile='AppIcon') if icon else {})}


def stage(args):
    out = args.output.resolve()
    layout = getattr(args, 'layout', 'portable')
    if out.exists(): raise ValueError('output already exists')
    if not getattr(args, 'harness_runtime', None): raise ValueError('prepared personal-agent runtime required')
    harness_manifest = validate_runtime(args.harness_runtime)
    harness_receipt = {key: value for key, value in harness_manifest.items() if key != 'files'}
    harness_receipt['prepared_manifest_sha256'] = digest(args.harness_runtime / 'manifest.json')
    library = Library(args.library.resolve())
    catalog = library.snapshot()
    out.mkdir(parents=True)
    identity = args.id or 'local.agenticcomplex.companion'
    port = args.port or 48800
    product_name = getattr(args, 'product_name', None) or 'Agentic Complex'
    app_version = getattr(args, 'app_version', None) or '0.2.0'
    app = out / 'Agentic Complex.app'
    contents = app / 'Contents'; resources = contents / 'Resources'; macos = contents / 'MacOS'
    resources.mkdir(parents=True)
    with tempfile.TemporaryDirectory(prefix='.components-', dir=out) as temporary:
        component_stage = Path(temporary)
        components = build_components.stage_components(component_stage, python=args.python,
            harness_runtime=args.harness_runtime, web_dist=args.web_dist,
            ui_art=getattr(args, 'ui_art', None), library=args.library, build_version=args.build_version,
            fbx_tool=args.fbx_tool)
        strip_local_symbols(component_stage / 'harness.pi/payload' / LAYOUT['darwin-arm64']['node'])
        # The staged payloads, not the library's packages: a macOS character payload is sealed again without its Vulkan files.
        packages = [Package(component_stage / component['id'] / 'payload', deep=False)
                    for component in components if component['id'].startswith('characters.')]
        host = component_stage / 'host/payload'; host_resources = host / 'Resources'
        host_paths = stage_electron_host(host, args.electron_app, args.electron_dir, args.helper, identity,
                                         product_name, app_version)
        ui = component_stage / 'web-ui/payload/ui'
        app_icon = (ui / 'art/brand/AppIcon.icns').is_file()
        if app_icon:
            shutil.copy2(ui / 'art/brand/AppIcon.icns', host_resources / 'AppIcon.icns')
            host_paths.append('Resources/AppIcon.icns')
        ui_art = None
        if getattr(args, 'ui_art', None):
            ui_art = dict(files=sum(path.is_file() for path in (ui / 'art').rglob('*')),
                          manifest_sha256=digest(args.ui_art / 'art-manifest.json'))
        node_version = subprocess.check_output(['node', '--version'], text=True).strip()
        # Without --host (a public checkout has no renderer) the app has no renderer component and runs text-only characters.
        renderer = component_stage / 'renderer/payload' if args.host else None
        renderer_paths = []
        if renderer:
            (renderer / 'MacOS').mkdir(parents=True)
            shutil.copy2(args.host.resolve(), renderer / 'MacOS/AgenticComplexMetalAvatar')
            strip_local_symbols(renderer / 'MacOS/AgenticComplexMetalAvatar')
            renderer_paths = ['MacOS/AgenticComplexMetalAvatar']
        payloads = {component['id']: component_stage / component['id'] / 'payload' for component in components}
        placed = dict(host=host_paths, **(dict(renderer=renderer_paths) if renderer else {}))
        overrides = dict(item.split('=', 1) for item in getattr(args, 'content_override', None) or [])
        for component, relative in build_components.stage_release_content(dict(payloads, host=host, **(dict(renderer=renderer) if renderer else {})),
                                                                           overrides, args.library):
            if component in placed and relative not in placed[component]: placed[component].append(relative)
        baseline = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        sources, fingerprint = source_fingerprint.compute(ROOT)
        write_json(out / 'source-manifest.json', dict(schema='endfield-release-source/v1', baseline=baseline, files=sources, fingerprint=fingerprint))
        common = dict(CFBundlePackageType='APPL', LSMinimumSystemVersion='15.0', LSUIElement=True,
                      CFBundleVersion=args.build_version, CFBundleShortVersionString='0.2.0',
                      AgenticComplexBuildGit=baseline, AgenticComplexGitCommit=baseline, AgenticComplexBuildFingerprint=fingerprint)
        (host / 'Info.plist').write_bytes(plistlib.dumps(electron_info(plistlib.loads((host / 'Info.plist').read_bytes()),
            identity, product_name, app_version, common, app_icon)))
        # @electron/fuses takes an .app; point its Contents at the unsigned payload the manifest will hash.
        fuse_app = component_stage / app.name
        fuse_app.mkdir(); (fuse_app / 'Contents').symlink_to(host, target_is_directory=True)
        fuses = json.loads(subprocess.check_output(['node', str(ROOT / 'tools/release/flip_fuses.mjs'), str(fuse_app)], text=True))
        for component in components: sign_payload(component_stage / component['id'] / 'payload')
        with tempfile.TemporaryDirectory(prefix='.catalog-', dir=out) as temporary_catalog:
            compose([component_stage / component['id'] / 'payload' for component in components
                     if component['id'].startswith('characters.')], catalog.get('default_character'), Path(temporary_catalog))
            catalog_sha256 = digest(Path(temporary_catalog) / 'current.json')
        # Layout metadata stays outside the host payload so its bytes match in both layouts.
        write_json(resources / 'distribution.json', dict(schema='endfield-distribution/v3', id=identity,
            layout=layout, port=port, catalogSHA256=catalog_sha256, defaultCharacter=catalog.get('default_character')))
        components.extend([
            dict(id='host', version=args.build_version, entrypoints={'executable': 'MacOS/AgenticComplex'},
                 provides={}, requires={'C6': '1', 'C9': '1'}, placed={path: path for path in host_paths})])
        if renderer:
            components.append(dict(id='renderer', version=args.build_version, entrypoints={'executable': 'MacOS/AgenticComplexMetalAvatar'},
                                   provides={}, requires={}, placed={path: path for path in renderer_paths}))
        references = build_components.write_manifests(component_stage, components)
        bundled = {'host', 'renderer', 'web-ui'} if layout == 'split' else {ref['id'] for ref in references}
        for component in components:
            source = component_stage / component['id']
            target = (resources if component['id'] in bundled else out) / 'components' / component['id']
            if 'placed' not in component:
                shutil.copytree(source, target, symlinks=True)
                continue
            target.mkdir(parents=True)
            shutil.copy2(source / 'component.json', target / 'component.json')
            for relative, placed in component['placed'].items():
                path = source / 'payload' / relative; destination = contents / placed
                destination.parent.mkdir(parents=True, exist_ok=True)
                if path.is_dir() and not path.is_symlink(): shutil.copytree(path, destination, symlinks=True)
                else: shutil.copy2(path, destination, follow_symlinks=False)
        host_ref = next(ref for ref in references if ref['id'] == 'host')
        refs = [dict(ref, placement='bundle' if ref['id'] in bundled else 'support') for ref in references if ref['id'] != 'host']
        if layout == 'portable':
            component_manifest.write_lock(resources / 'composition.lock.json', layout, host_ref, refs)
        else:
            write_json(out / 'components/index.json', dict(schema='endfield-components-index/v1',
                components=[dict(ref, dir=ref['id'], manifest_sha256=digest(out / 'components' / ref['id'] / 'component.json'))
                            for ref in references if ref['id'] not in bundled]))
            shutil.copy2(out / 'components/index.json', resources / 'components-index.json')
        write_json(out / 'staging-manifest.json', dict(schema='endfield-character-distribution-stage/v1',
            baseline=baseline, app=app.name, distribution_id=identity, layout=layout, port=port, single_app=True,
            characters=[dict(id=p.id, version=p.document['version'], definition_sha256=p.sha256,
                portrait='portrait' in p.components.get('ui', {}), voice_enabled=p.voice_enabled) for p in packages],
            companion_sha256=digest(macos / 'AgenticComplex'), host_sha256=digest(macos / 'AgenticComplexMetalAvatar') if renderer else None,
            ui_sha256=tree_sha256(ui), ui_art=ui_art, node_version=node_version, host=host_ref, components=refs, electron_fuses=fuses,
            self_contained_runtime=layout == 'portable', personal_agent_runtime=harness_receipt,
            installed_app_modified=False, notarized=False))
    print(app, flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ['library', 'python', 'harness-runtime', 'web-dist', 'output', 'fbx-tool']:
        parser.add_argument('--' + key, type=Path, required=True)
    parser.add_argument('--host', type=Path, help='The built metal-avatar-host; without it the app has no renderer component')
    parser.add_argument('--electron-app', type=Path, required=True, help='The locked Electron.app')
    parser.add_argument('--electron-dir', type=Path, required=True, help='app/electron after npm run build')
    parser.add_argument('--helper', type=Path, required=True, help='The built ac-helper')
    parser.add_argument('--product-name', help='The app name; default Agentic Complex')
    parser.add_argument('--app-version', help='CFBundleShortVersionString; default 0.2.0')
    parser.add_argument('--layout', choices=['portable', 'split'], default='portable')
    parser.add_argument('--id')
    parser.add_argument('--port', type=int)
    parser.add_argument('--build-version', default='20261026.2')
    parser.add_argument('--ui-art', type=Path, help='UI art directory with art-manifest.json')
    parser.add_argument('--content-override', action='append', metavar='COMPONENT/PATH=SOURCE',
                        help='Copy SOURCE to PATH in the staged component COMPONENT before signing; repeatable')
    args = parser.parse_args()
    release_guard(ROOT)
    stage(args)
