"""Stage component payloads before signing, then write their C11 manifests."""
import copy
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'agent/agentd'))
from character_library import Library, Package, digest, json_bytes
import component_manifest
import local_paths
import pool_codec
from harness_runtime import LAYOUT, copy_python_site, python_pins, validate_runtime
from release import CONTENT_PACKAGES, CONTENT_SOURCES, check_no_imported_appearance

CANON_RELATIVE = Path('brain/canon-windows.json')
# The content override key of the outbound guard in the agentd payload.
GUARD_OVERRIDE = 'agentd/agentd/' + CANON_RELATIVE.as_posix()
UFBX_LICENSE = ROOT / 'characters/agentic_complex_build/motion_import/native/UFBX-LICENSE'
# native_bundle.py's own repo-root import path; the staged copy imports resource_store from agentd.
NATIVE_BUNDLE_ROOT = "sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[2]/'agent/agentd'))\n"
# Parts of the standalone CPython prefix agentd never loads: bin/python3.12 links no libpython, and nothing imports Tk.
PYTHON_SKIPPED = ('include', 'share', 'lib/pkgconfig', 'lib/libpython3.12.dylib', 'bin/python3-config', 'bin/python3.12-config',
                  *('lib/python3.12/' + name for name in ('site-packages', 'test', 'tkinter', 'idlelib', 'turtledemo', 'ensurepip',
                    'lib2to3', 'pydoc_data', 'config-3.12-darwin', 'lib-dynload/_tkinter.cpython-312-darwin.so')))
# Tcl/Tk libraries in lib/ and the launchers in bin/ of the modules left out; their names carry versions.
PYTHON_SKIPPED_PREFIXES = {'lib': ('tcl', 'tk', 'itcl', 'thread', 'libtcl'), 'bin': ('2to3', 'idle3', 'pip')}


def validate_canon_windows(path):
    """Require the hash-only outbound guard that clean installations depend on."""
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError) as exc:
        raise ValueError(f'Invalid bundled outbound guard: {path}') from exc
    if (not isinstance(data, dict) or type(data.get('n')) is not int or data['n'] != 7
            or not isinstance(data.get('hashes'), list) or not data['hashes']
            or any(not isinstance(value, str) or re.fullmatch(r'[0-9a-f]{16}', value) is None
                   for value in data['hashes'])):
        raise ValueError(f'Invalid bundled outbound guard: {path}')


def check_manifest_file(source, name, what):
    """Raise unless name is a relative path whose file lies inside source with no symlink on the way."""
    relative = PurePosixPath(name)
    if (not name or relative.is_absolute() or '..' in relative.parts or '\\' in name or ':' in name
            or (source.resolve() / relative).resolve() != source.resolve() / relative):
        raise ValueError(what + ' file outside its directory: ' + name)


def copy_ui_art(source, target):
    """Copy the files art-manifest.json lists after checking each SHA-256; web pages load them from ui/art/."""
    manifest_path = source / 'art-manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    for entry in manifest['files']: check_manifest_file(source, entry['file'], 'UI art')
    files = [entry['file'] for entry in manifest['files']]
    for entry in manifest['files']:
        if digest(source / entry['file']) != entry['sha256']: raise ValueError('UI art hash mismatch: ' + entry['file'])
    for file in files:
        (target / file).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / file, target / file)
    return dict(files=len(files), manifest_sha256=digest(manifest_path))


def stage_ui(web_dist, ui_art, target):
    """Copy ui/ and ui-bridge/ into target; return the UI art receipt."""
    ui = target / 'ui'
    shutil.copytree(web_dist, ui)
    ui_art_receipt = copy_ui_art(ui_art, ui / 'art') if ui_art else None
    (target / 'ui-bridge').mkdir()
    shutil.copy2(ROOT / 'protocol/ui-bridge/routes.json', target / 'ui-bridge/routes.json')
    return ui_art_receipt


def stage_agentd(service):
    """Copy the files git tracks in agent/agentd (no tests or caches) into service and check its outbound guard."""
    service.mkdir(parents=True)
    tracked = subprocess.check_output(['git', 'ls-files', '-z', '--', 'agent/agentd'], cwd=ROOT, text=True).split('\0')[:-1]
    for name in sorted(tracked):
        path = ROOT / name
        relative = path.relative_to(ROOT / 'agent/agentd')
        if any(p in ('tests', '__pycache__') for p in relative.parts): continue
        if path.suffix not in ('.py', '.json', '.txt', '.md', '.mjs', '.lock'): continue
        target = service / relative; target.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(path, target)
    validate_canon_windows(service / CANON_RELATIVE)
    return service


def stage_content(content):
    """Copy the motion importers into content; its caller supplies the import roots."""
    content.mkdir(parents=True)
    (content / '__init__.py').write_text('"""VMD importer shipped in the app; the caller provides its import roots."""\n', encoding='utf-8')
    for relative in CONTENT_SOURCES:
        text = (ROOT / relative).read_text(encoding='utf-8')
        if Path(relative).name == 'native_bundle.py':
            if text.count(NATIVE_BUNDLE_ROOT) != 1: raise ValueError('native_bundle.py no longer has its repo-root import line')
            text = text.replace(NATIVE_BUNDLE_ROOT, '')
        (content / Path(relative).name).write_text(text, encoding='utf-8')
    for package in CONTENT_PACKAGES:
        target = content / Path(package).name; target.mkdir(parents=True)
        for path in sorted((ROOT / package).iterdir()):
            if path.is_file() and path.suffix in ('.py', '.json'): shutil.copy2(path, target / path.name)
    return content


def apply_content_overrides(payloads, overrides):
    """Copy each {'<component id>/<path in its payload>': source} over payloads ({component id: payload directory});
    return the (component id, path) pairs in order."""
    applied = []
    for relative, source in overrides.items():
        component, _, inner = relative.partition('/')
        payload = Path(payloads[component]).resolve() if component in payloads else None
        target = (payload / inner).resolve() if payload is not None else None
        if target is None or target == payload or not target.is_relative_to(payload):
            raise ValueError('content_override_outside_component: ' + relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        applied.append((component, target.relative_to(payload).as_posix()))
    return applied


def stage_release_content(payloads, overrides, library):
    """apply_content_overrides, then check the staged outbound guard, which must be the override's bytes when overrides
    names one, and refuse a library that holds a local absolute path or an imported appearance; return the applied pairs."""
    applied = apply_content_overrides(payloads, overrides)
    guard = Path(payloads['agentd']) / 'agentd' / CANON_RELATIVE
    validate_canon_windows(guard)
    if GUARD_OVERRIDE in overrides and guard.read_bytes() != Path(overrides[GUARD_OVERRIDE]).read_bytes():
        raise ValueError('outbound_guard_not_the_override: ' + str(overrides[GUARD_OVERRIDE]))
    local_paths.require_none(library)
    # An empty directory is a library without characters.
    catalog = Path(library) / 'current.json'
    if catalog.is_file(): check_no_imported_appearance(catalog)
    return applied


def python_version(executable):
    return subprocess.check_output([str(executable), '-I', '-B', '-c', 'import platform; print(platform.python_version())'],
                                   text=True).strip()


def stage_runtime_python(stage, *, python, prepared_site, pins):
    """Stage the stripped CPython prefix and locked site-packages."""
    stage, python, prepared_site = map(Path, (stage, python, prepared_site))
    prepared_site = prepared_site.resolve()
    version = python_version(python.resolve() / 'bin/python3')
    runtime = stage / 'runtime.python/payload'
    python = python.resolve()
    skipped = {python / relative for relative in PYTHON_SKIPPED}
    # __pycache__: the build host's own runs compiled it, and each .pyc names its source by the host's path.
    shutil.copytree(python, runtime, symlinks=True, ignore=lambda directory, names: [
        name for name in names if Path(directory, name) in skipped or name == '__pycache__'
        or name.startswith(PYTHON_SKIPPED_PREFIXES.get(Path(directory).relative_to(python).as_posix(), ()))])
    # The installer rewrote the build prefixes to its install path; /install is the prefix python-build-standalone builds with.
    for sysconfig in (runtime / 'lib/python3.12').glob('_sysconfigdata_*.py'):
        sysconfig.write_text(sysconfig.read_text().replace(str(python), '/install'))
    runtime_site = runtime / 'lib/python3.12/site-packages'
    copy_python_site(prepared_site, runtime_site)
    for tests in sorted(runtime_site.rglob('tests')):
        if tests.is_dir(): shutil.rmtree(tests)
    wrapper = runtime / 'bin/agentic-complex-python'
    wrapper.write_text('#!/bin/sh\nexec "$(dirname "$0")/python3" -I -B "$@"\n'); wrapper.chmod(0o755)
    shutil.copytree(prepared_site / ('numpy-' + pins['numpy'] + '.dist-info/licenses'), runtime / 'licenses/numpy')
    return dict(id='runtime.python', version=version, entrypoints={'python': 'bin/agentic-complex-python'},
                provides={}, requires={})


# Base prefix parts a relocated python.exe does not run from; Scripts' launchers name the build host's python.exe by path.
WINDOWS_PYTHON_SKIPPED = ('Doc', 'include', 'libs', 'Scripts', 'Tools', 'Lib/site-packages', 'Lib/test')


def stage_runtime_python_windows(stage, *, python, prepared_site, pins):
    """runtime.python from a Windows CPython base prefix: python.exe at the payload root and the locked site in
    Lib/site-packages, where site reads pywin32.pth; no wrapper, the shell passes -I -B itself."""
    stage, python, prepared_site = map(Path, (stage, python, prepared_site))
    python = python.resolve(); prepared_site = prepared_site.resolve()
    version = python_version(python / 'python.exe')
    skipped = {python / relative for relative in WINDOWS_PYTHON_SKIPPED}
    runtime = stage / 'runtime.python/payload'
    shutil.copytree(python, runtime, ignore=lambda directory, names: [
        name for name in names if name == '__pycache__' or name.endswith('.pyc') or Path(directory, name) in skipped])
    runtime_site = runtime / 'Lib/site-packages'
    copy_python_site(prepared_site, runtime_site)
    shutil.copytree(prepared_site / ('numpy-' + pins['numpy'] + '.dist-info/licenses'), runtime / 'licenses/numpy')
    return dict(id='runtime.python', version=version, entrypoints={'python': 'python.exe'}, provides={}, requires={})


def stage_character(package, target, platform):
    """Copy package to target. A macOS payload leaves out the Vulkan frame table and its blobs, which only the Windows
    renderer reads, stores its pool files compressed where that is smaller, and is sealed again: its character.json and
    native bundle differ from the library's."""
    for name in ('character.json', *package.inventory):
        destination = target / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(package.root / name, destination)
    expected = package.sha256
    package = Package(target)
    if package.sha256 != expected: raise ValueError('definition_sha_mismatch')
    if platform != 'macos-arm64' or not package.render_enabled: return
    if 'vulkan_frame' in package.native_entry:
        prefix = PurePosixPath(package.native_ref['file']).parent
        folder = PurePosixPath(package.native_entry['vulkan_frame']['file']).parent
        dropped = {ref['file'] for ref in package.native['files'] if PurePosixPath(ref['file']).is_relative_to(folder)}
        native = dict(package.native, files=[ref for ref in package.native['files'] if ref['file'] not in dropped],
                      characters=[{key: value for key, value in package.native_entry.items() if key != 'vulkan_frame'}])
        shutil.rmtree(target / prefix / folder)
        seal(package, target, native, {}, {str(prefix / file) for file in dropped})
    compress_pool(target)


def seal(package, target, native, stored, dropped=()):
    """Write native as target's bundle.json, then target's character.json from package's: the new bundle.json, the files
    of stored ({path in the package: {sha256, byte_count}}) as they are now stored, and no inventory entry for dropped."""
    bundle = package.native_ref['file']
    data = json_bytes(native)
    (target / bundle).write_bytes(data)
    sealed = dict(file=bundle, sha256=hashlib.sha256(data).hexdigest(), byte_count=len(data))
    document = copy.deepcopy(package.document)
    document['components']['render']['native_bundle'] = sealed
    document['inventory'] = [sealed if ref['file'] == bundle else dict(ref, **stored.get(ref['file'], {}))
                             for ref in document['inventory'] if ref['file'] not in dropped]
    (target / 'character.json').write_bytes(json_bytes(document))


def compress_pool(target):
    """Replace each pool file bundle.json lists in the package at target (Files/ beside its source manifest) by its
    pool_codec container where that is smaller, seal the package again and check it; return the files replaced. A file
    already stored as the container of its raw identity (its name) stays as it is."""
    package = Package(target, deep=False)
    prefix = PurePosixPath(package.native_ref['file']).parent
    pool = PurePosixPath(package.native_entry['source']['file']).parent / 'Files'
    stored = {}
    for ref in package.native['files']:
        if PurePosixPath(ref['file']).parent != pool: continue
        path = target / prefix / ref['file']
        try: raw_sha256 = pool_codec.raw_identity(path, ref['byte_count'])[0]
        except ValueError: raw_sha256 = None
        if raw_sha256 == PurePosixPath(ref['file']).stem: continue
        container = pool_codec.encode(path.read_bytes())
        if container is None: continue
        path.write_bytes(container)
        stored[ref['file']] = dict(sha256=hashlib.sha256(container).hexdigest(), byte_count=len(container))
    if stored:
        native = dict(package.native, files=[dict(ref, **stored.get(ref['file'], {})) for ref in package.native['files']])
        seal(package, target, native, {str(prefix / file): identity for file, identity in stored.items()})
    Package(target)
    return len(stored)


def stage_fbx_tool(fbx_tool, service, name='fbx-motion'):
    """Copy the fbx-motion executable to service/tools/<name> and ufbx's license to service/licenses/ufbx."""
    (service / 'tools').mkdir(); shutil.copy2(fbx_tool, service / 'tools' / name)
    (service / 'licenses').mkdir(); shutil.copy2(UFBX_LICENSE, service / 'licenses/ufbx')


# Per C11 platform: the harness runtime's platform, runtime.python's staging and the fbx-motion file name.
PLATFORMS = {'macos-arm64': ('darwin-arm64', stage_runtime_python, 'fbx-motion'),
             'windows-x64': ('win32-x64', stage_runtime_python_windows, 'fbx-motion.exe')}


def stage_components(stage, *, python, harness_runtime, web_dist, ui_art, library,
                     build_version, fbx_tool, platform='macos-arm64'):
    """Fill a new empty stage with payloads and return the arguments for write_component."""
    stage, python, prepared, library = map(Path, (stage, python, harness_runtime, library))
    prepared = prepared.resolve(); library = library.resolve()
    harness_platform, stage_python, fbx_name = PLATFORMS[platform]
    manifest = validate_runtime(prepared, platform=harness_platform)
    pins = python_pins()
    packages = Library(library).packages()
    prepared_site = prepared / 'python-site'
    component = stage_python(stage, python=python, prepared_site=prepared_site, pins=pins)
    python_version = component['version']
    components = [component]
    pi = stage / 'harness.pi/payload'
    node = LAYOUT[harness_platform]['node']
    (pi / node).parent.mkdir(parents=True); (pi / 'licenses').mkdir()
    shutil.copy2(prepared / node, pi / node)
    shutil.copy2(prepared / 'node/LICENSE', pi / 'licenses/Node-LICENSE')
    shutil.copytree(prepared / 'pi-runtime', pi / 'pi-runtime', symlinks=True, ignore=shutil.ignore_patterns('__pycache__'))
    components.append(dict(id='harness.pi', version=manifest['pi_version'], entrypoints={'node': node},
                           provides={}, requires={}))
    service = stage / 'agentd/payload'
    stage_agentd(service / 'agentd')
    stage_content(service / 'content')
    stage_fbx_tool(fbx_tool, service, fbx_name)
    shutil.copy2(ROOT / 'app/Resources/agentd_launcher.py', service / 'agentd_launcher.py')
    components.append(dict(id='agentd', version=build_version,
        entrypoints={'launcher': 'agentd_launcher.py', 'hook_forwarder': 'agentd/codex_hook_forward.py',
                     'character_tool': 'agentd/character_tool.py', 'motion_tool': 'agentd/motion_tool.py',
                     'install_hooks': 'agentd/tools/install_hooks.py', 'distribution_seed': 'agentd/distribution_seed.py',
                     'fbx_tool': 'tools/' + fbx_name},
        provides={'C6': '1', 'C9': '1'}, requires={'runtime.python': python_version}))
    stage_ui(web_dist, ui_art, stage / 'web-ui/payload')
    components.append(dict(id='web-ui', version=build_version, entrypoints={'index': 'ui/main.html'},
                           provides={}, requires={}))
    for package in packages:
        id = 'characters.' + package.id
        stage_character(package, stage / id / 'payload', platform)
        components.append(dict(id=id, version=package.version, entrypoints={}, provides={}, requires={}))
    return components


def write_manifests(stage, components, platform='macos-arm64'):
    """Check entrypoints and hash the current payload bytes after signing."""
    references = []
    for component in components:
        payload = (Path(stage) / component['id'] / 'payload').resolve()
        for relative in component['entrypoints'].values():
            path = (payload / relative).resolve()
            if not path.is_relative_to(payload) or not path.is_file():
                raise ValueError('component_entry_missing_or_escaping: ' + component['id'] + ': ' + relative)
        manifest = component_manifest.write_component(payload, **component, platform=platform)
        references.append({key: manifest[key] for key in ('id', 'version', 'tree_sha256')})
    return references
