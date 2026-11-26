import csv
import hashlib
from importlib import metadata
import json
import os
import re
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build_components
import component_manifest
from harness_runtime import inventory_tree, normalized, python_pins
from test_harness_runtime import prepared_fixture

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'agent/agentd/tests'))
from test_character_library import fixture as character_fixture
from character_library import Package
import pool_codec
LIBRARY = ROOT / 'protocol/character-library/fixtures/library'


class BuildComponentsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.stage = self.root / 'stage'; self.stage.mkdir()
        self.python = self.root / 'python'; (self.python / 'bin').mkdir(parents=True)
        (self.python / 'bin/python3.12').write_text('#!/bin/sh\nprintf "3.12.99\\n"\n')
        (self.python / 'bin/python3.12').chmod(0o755)
        (self.python / 'bin/python3').symlink_to('python3.12')
        inherited = self.python / 'lib/python3.12/site-packages'; inherited.mkdir(parents=True)
        (inherited / 'inherited.py').write_text('must be replaced')
        self.prepared = prepared_fixture(self.root / 'prepared')
        self.pins = python_pins()
        site = self.prepared / 'python-site'
        self.add_files(site, 'pydantic', {'pydantic/__init__.py': 'locked pydantic',
                                        'shared/dependency.py': 'shared dependency'})
        self.web = self.root / 'web'; (self.web / 'assets').mkdir(parents=True)
        for name in ('main.html', 'stack.html', 'assets/main.js'):
            (self.web / name).write_text('web ' + name)
        self.art = self.root / 'art'; (self.art / 'brand').mkdir(parents=True)
        icon = self.art / 'brand/AppIcon.icns'; icon.write_bytes(b'icon')
        (self.art / 'art-manifest.json').write_text(json.dumps(dict(files=[
            dict(file='brand/AppIcon.icns', sha256=hashlib.sha256(icon.read_bytes()).hexdigest())])))
        self.fbx_tool = self.root / 'fbx-motion'; self.fbx_tool.write_text('#!/bin/sh\n'); self.fbx_tool.chmod(0o755)
        self.update_prepared_manifest()

    def add_files(self, site, name, files):
        info = site / (name.replace('-', '_') + '-' + self.pins[name] + '.dist-info')
        with (info / 'RECORD').open('a', newline='') as stream:
            writer = csv.writer(stream)
            for relative, text in files.items():
                target = site / relative; target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(text)
                writer.writerow([relative, '', ''])

    def update_prepared_manifest(self):
        path = self.prepared / 'manifest.json'
        manifest = json.loads(path.read_text())
        manifest['files'] = inventory_tree(self.prepared)
        path.write_text(json.dumps(manifest))

    def stage_components(self, library=LIBRARY):
        return build_components.stage_components(self.stage, python=self.python,
            harness_runtime=self.prepared, web_dist=self.web, ui_art=self.art, library=library,
            build_version='20261106.1', fbx_tool=self.fbx_tool)

    def files(self, root):
        return {path.relative_to(root).as_posix(): path.read_bytes()
                for path in root.rglob('*') if path.is_file()}

    def test_catalog_definition_is_checked_before_character_staging(self):
        library = self.root / 'library'
        shutil.copytree(LIBRARY, library)
        definition = library / json.loads((library / 'current.json').read_text())['characters'][0]['definition']['file']
        definition.write_bytes(definition.read_bytes() + b' ')
        with self.assertRaisesRegex(ValueError, 'definition_sha_mismatch'):
            self.stage_components(library)

    def test_staged_definition_matches_the_verified_catalog_bytes(self):
        library = self.root / 'library'
        shutil.copytree(ROOT / 'characters/sample-library', library)
        package = build_components.Library(library).packages()[0]
        definition = package.root / 'character.json'
        definition.write_bytes(definition.read_bytes() + b' ')
        with self.assertRaisesRegex(ValueError, 'definition_sha_mismatch'):
            build_components.stage_character(package, self.root / 'character', 'macos-arm64')

    def test_character_payload_contains_only_the_definition_and_inventory(self):
        library = self.root / 'library'
        shutil.copytree(ROOT / 'characters/sample-library', library)
        package = build_components.Library(library).packages()[0]
        (package.root / 'release-note.txt').write_text('unlisted')
        target = self.root / 'character'
        build_components.stage_character(package, target, 'macos-arm64')
        self.assertEqual(set(self.files(target)), {'character.json', *package.inventory})

    def test_payload_layout_and_runtime_python_distribution_inventory(self):
        with patch.object(component_manifest, '_tree', side_effect=AssertionError('stage computed a tree hash')), \
                patch.object(component_manifest, 'write_component', side_effect=AssertionError('stage wrote a manifest')):
            components = self.stage_components()
        ids = {'runtime.python', 'harness.pi', 'agentd', 'web-ui', 'characters.fixture'}
        self.assertEqual({entry['id'] for entry in components}, ids)
        self.assertEqual({path.name for path in self.stage.iterdir()}, ids)
        self.assertEqual(list(self.stage.rglob('component.json')), [])
        specs = {entry['id']: entry for entry in components}
        expected_entries = {
            'runtime.python': {'python': 'bin/agentic-complex-python'},
            'harness.pi': {'node': 'node/bin/node'},
            'agentd': {'launcher': 'agentd_launcher.py', 'hook_forwarder': 'agentd/codex_hook_forward.py',
                      'character_tool': 'agentd/character_tool.py', 'motion_tool': 'agentd/motion_tool.py',
                      'install_hooks': 'agentd/tools/install_hooks.py', 'distribution_seed': 'agentd/distribution_seed.py',
                      'fbx_tool': 'tools/fbx-motion'},
            'web-ui': {'index': 'ui/main.html'}, 'characters.fixture': {}}
        versions = {'runtime.python': '3.12.99', 'harness.pi': '1.4.0',
                    'agentd': '20261106.1', 'web-ui': '20261106.1', 'characters.fixture': '1.0.0'}
        for id, entry in specs.items():
            with self.subTest(component=id):
                payload = self.stage / id / 'payload'
                self.assertEqual(entry, dict(id=id, version=versions[id], entrypoints=expected_entries[id],
                    provides={'C6': '1', 'C9': '1'} if id == 'agentd' else {},
                    requires={'runtime.python': '3.12.99'} if id == 'agentd' else {}))
                for relative in entry['entrypoints'].values(): self.assertTrue((payload / relative).is_file(), relative)
        runtime = self.stage / 'runtime.python/payload'
        self.assertTrue((runtime / 'bin/python3').is_symlink())
        wrapper = runtime / 'bin/agentic-complex-python'
        self.assertEqual(wrapper.read_text(), '#!/bin/sh\nexec "$(dirname "$0")/python3" -I -B "$@"\n')
        self.assertTrue(wrapper.stat().st_mode & 0o111)
        self.assertEqual((runtime / 'licenses/numpy/LICENSE.txt').read_text(), 'synthetic numpy notice')
        runtime_site = runtime / 'lib/python3.12/site-packages'
        self.assertEqual((runtime_site / 'pydantic/__init__.py').read_text(), 'locked pydantic')
        self.assertEqual((runtime_site / 'shared/dependency.py').read_text(), 'shared dependency')
        self.assertFalse((runtime_site / 'inherited.py').exists())
        self.assertEqual(list(runtime_site.rglob('obsolete.py')), [])
        actual = {normalized(dist.metadata['Name']): dist.version for dist in metadata.distributions(path=[str(runtime_site)])}
        self.assertEqual(actual, self.pins)
        pi = self.stage / 'harness.pi/payload'
        self.assertEqual((pi / 'node/bin/node').read_bytes(), (self.prepared / 'node/bin/node').read_bytes())
        self.assertEqual((pi / 'licenses/Node-LICENSE').read_bytes(), (self.prepared / 'node/LICENSE').read_bytes())
        self.assertEqual(self.files(pi / 'pi-runtime'), self.files(self.prepared / 'pi-runtime'))
        service = self.stage / 'agentd/payload'
        self.assertEqual({p.name for p in service.iterdir()}, {'agentd', 'content', 'agentd_launcher.py', 'tools', 'licenses'})
        self.assertEqual((service / 'tools/fbx-motion').read_bytes(), self.fbx_tool.read_bytes())
        self.assertTrue((service / 'tools/fbx-motion').stat().st_mode & 0o111)
        self.assertEqual((service / 'licenses/ufbx').read_bytes(), build_components.UFBX_LICENSE.read_bytes())
        self.assertEqual((service / 'agentd_launcher.py').read_bytes(), (ROOT / 'app/Resources/agentd_launcher.py').read_bytes())
        self.assertTrue((service / 'content/mmd/rotation.py').is_file())
        self.assertFalse((service / 'agentd/tests').exists())
        self.assertFalse(list((service / 'agentd').rglob('__pycache__')))
        ui = self.stage / 'web-ui/payload'
        self.assertEqual((ui / 'ui/main.html').read_bytes(), (self.web / 'main.html').read_bytes())
        self.assertEqual((ui / 'ui/art/brand/AppIcon.icns').read_bytes(), b'icon')
        self.assertEqual((ui / 'ui-bridge/routes.json').read_bytes(), (ROOT / 'protocol/ui-bridge/routes.json').read_bytes())
        catalog = json.loads((LIBRARY / 'current.json').read_text())
        package = (LIBRARY / catalog['characters'][0]['definition']['file']).parent
        self.assertEqual(self.files(self.stage / 'characters.fixture/payload'), self.files(package))

    def test_the_windows_release_content_checks_name_their_encoding(self):
        # package_windows.py runs with -I, so PYTHONUTF8 is ignored and an unnamed encoding is the host's code page.
        probe = ('import sys; from pathlib import Path; sys.path.insert(0, sys.argv[1]); import build_components; '
                 'build_components.check_no_imported_appearance(Path(sys.argv[2])); build_components.stage_content(Path(sys.argv[3]))')
        run = subprocess.run([sys.executable, '-I', '-X', 'warn_default_encoding', '-W', 'error::EncodingWarning', '-c', probe,
                              str(Path(build_components.__file__).parent), str(LIBRARY / 'current.json'), str(self.root / 'content')],
                             capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)

    def test_runtime_python_leaves_out_libpython_tk_ensurepip_and_tests(self):
        dropped = ['include/Python.h', 'share/man/python.1', 'lib/libpython3.12.dylib', 'lib/libtcl9.0.dylib', 'lib/tcl9.0/init.tcl',
                   'lib/tk9.0/tk.tcl', 'lib/itcl4.3.8/itcl.tcl', 'lib/thread3.0.6/x', 'lib/pkgconfig/python3.pc', 'bin/pip3', 'bin/idle3.12',
                   'bin/2to3', 'bin/python3.12-config', 'lib/python3.12/tkinter/__init__.py', 'lib/python3.12/idlelib/idle.py',
                   'lib/python3.12/ensurepip/__init__.py', 'lib/python3.12/lib2to3/main.py', 'lib/python3.12/test/x.py',
                   'lib/python3.12/config-3.12-darwin/Makefile', 'lib/python3.12/lib-dynload/_tkinter.cpython-312-darwin.so']
        kept = ['lib/python3.12/os.py', 'lib/python3.12/lib-dynload/_ssl.cpython-312-darwin.so', 'lib/python3.12/threading.py']
        for relative in dropped + kept:
            (self.python / relative).parent.mkdir(parents=True, exist_ok=True); (self.python / relative).write_text(relative)
        self.add_files(self.prepared / 'python-site', 'pydantic', {'tested/__init__.py': 'keep', 'tested/tests/test_x.py': 'drop',
                                                  'tested/sub/tests/data/x.txt': 'drop'})
        build_components.stage_runtime_python(self.stage, python=self.python,
                                              prepared_site=self.prepared / 'python-site', pins=self.pins)
        runtime = self.stage / 'runtime.python/payload'
        for relative in dropped: self.assertFalse((runtime / relative).exists(), relative)
        for relative in kept: self.assertTrue((runtime / relative).is_file(), relative)
        self.assertTrue((runtime / 'bin/python3.12').is_file())
        site = runtime / 'lib/python3.12/site-packages'
        self.assertTrue((site / 'tested/__init__.py').is_file())
        self.assertEqual(list(site.rglob('tests')), [])

    def test_runtime_python_carries_no_build_host_path(self):
        stdlib = self.python / 'lib/python3.12'
        (stdlib / '__pycache__').mkdir(parents=True)
        (stdlib / '__pycache__/os.cpython-312.pyc').write_bytes(str(stdlib / 'os.py').encode())
        (stdlib / '_sysconfigdata__darwin_darwin.py').write_text(
            f"build_time_vars = {{'BINDIR': '{self.python.resolve()}/bin', 'CC': 'clang'}}\n")
        build_components.stage_runtime_python(self.stage, python=self.python,
                                              prepared_site=self.prepared / 'python-site', pins=self.pins)
        runtime = self.stage / 'runtime.python/payload'
        self.assertEqual(list(runtime.rglob('*.pyc')), [])
        self.assertEqual((runtime / 'lib/python3.12/_sysconfigdata__darwin_darwin.py').read_text(),
                         "build_time_vars = {'BINDIR': '/install/bin', 'CC': 'clang'}\n")

    def test_ui_art_naming_a_file_outside_the_art_directory_is_refused(self):
        outside = self.root / 'outside.png'; outside.write_bytes(b'outside')
        (self.art / 'link.png').symlink_to(outside)
        for name in ('../outside.png', str(outside), 'brand/../../outside.png', 'link.png'):
            with self.subTest(name=name):
                (self.art / 'art-manifest.json').write_text(json.dumps(dict(files=[
                    dict(file=name, sha256=hashlib.sha256(outside.read_bytes()).hexdigest())])))
                target = self.root / 'ui-art'
                with self.assertRaisesRegex(ValueError, 'UI art file outside its directory: ' + re.escape(name)):
                    build_components.copy_ui_art(self.art, target)
                self.assertFalse(target.exists())

    def test_agentd_ships_only_the_files_git_tracks(self):
        root = self.root / 'checkout'; agentd = root / 'agent/agentd'
        for name, text in {'a.py': 'tracked', 'tests/t.py': 'tests', 'credentials.json': 'secret', 'brain/x.json': '{}'}.items():
            (agentd / name).parent.mkdir(parents=True, exist_ok=True); (agentd / name).write_text(text)
        subprocess.run(['git', 'init', '-q'], cwd=root, check=True)
        subprocess.run(['git', 'add', '--', 'agent/agentd/a.py', 'agent/agentd/tests/t.py', 'agent/agentd/brain'], cwd=root, check=True)
        service = self.root / 'service'
        with patch.object(build_components, 'ROOT', root):
            build_components.stage_agentd(service)
        self.assertEqual({path.relative_to(service).as_posix() for path in service.rglob('*') if path.is_file()},
                         {'a.py', 'brain/x.json'})

    def test_a_macos_character_payload_is_sealed_without_its_vulkan_files(self):
        source = self.root / 'role'; character_fixture(source, neutral=True, vulkan=True)
        package = Package(source)
        build_components.stage_character(package, self.root / 'mac', 'macos-arm64')
        build_components.stage_character(package, self.root / 'windows', 'windows-x64')
        self.assertEqual(self.files(self.root / 'windows'), self.files(source))
        mac = Package(self.root / 'mac')
        self.assertNotIn('vulkan_frame', mac.native_entry)
        self.assertFalse((mac.root / 'runtime/vulkan').exists())
        self.assertNotEqual(mac.sha256, package.sha256)
        self.assertEqual({key for key in mac.inventory}, {key for key in package.inventory} - {'runtime/vulkan/frame.bin'})
        self.assertEqual({ref['file'] for ref in mac.native['files']}, {ref['file'] for ref in package.native['files']} - {'vulkan/frame.bin'})
        self.assertEqual({key: value for key, value in mac.native_entry.items()},
                         {key: value for key, value in package.native_entry.items() if key != 'vulkan_frame'})
        plain = self.root / 'plain'; character_fixture(plain)
        build_components.stage_character(Package(plain), self.root / 'plain-mac', 'macos-arm64')
        self.assertEqual(self.files(self.root / 'plain-mac'), self.files(plain))

    def test_a_macos_character_payload_stores_its_compressible_pool_files_as_containers(self):
        compressible, incompressible = b''.join(b'texel %d ' % (i % 89) for i in range(5000)), os.urandom(4096)
        sha = lambda data: hashlib.sha256(data).hexdigest()
        files = ['runtime/Files/' + sha(compressible) + '.bytes', 'runtime/Files/' + sha(incompressible) + '.bytes']
        for name, vulkan in (('framed', True), ('plain', False)):
            with self.subTest(name):
                source = self.root / name; character_fixture(source, neutral=vulkan, vulkan=vulkan, pool=[compressible, incompressible])
                package = Package(source)
                build_components.stage_character(package, self.root / (name + '-mac'), 'macos-arm64')
                build_components.stage_character(package, self.root / (name + '-windows'), 'windows-x64')
                self.assertEqual(self.files(self.root / (name + '-windows')), self.files(source))
                mac = Package(self.root / (name + '-mac'))
                stored = (mac.root / files[0]).read_bytes()
                self.assertEqual(stored[:8], pool_codec.MAGIC)
                self.assertEqual(pool_codec.decode(stored), compressible)
                self.assertEqual((mac.root / files[1]).read_bytes(), incompressible)
                index = {ref['file']: ref for ref in mac.native['files']}
                for file in files + [mac.native_ref['file']]:
                    data = (mac.root / file).read_bytes(); identity = dict(sha256=sha(data), byte_count=len(data))
                    self.assertEqual({key: mac.inventory[file][key] for key in identity}, identity)
                    if file != mac.native_ref['file']:
                        self.assertEqual({key: index[file[len('runtime/'):]][key] for key in identity}, identity)
                self.assertEqual(mac.document['components']['render']['native_bundle'], mac.inventory[mac.native_ref['file']])
                self.assertEqual('vulkan_frame' in mac.native_entry, False)

    def test_a_pool_already_stored_as_containers_is_left_as_it_is(self):
        # A container of this pool file is itself compressible, so a second encode would nest it.
        pool = b'a' * 200000
        source = self.root / 'role'; character_fixture(source, pool=[pool])
        target = self.root / 'once'; shutil.copytree(source, target)
        self.assertEqual(build_components.compress_pool(target), 1)
        once = self.files(target)
        self.assertEqual(build_components.compress_pool(target), 0)
        self.assertEqual(self.files(target), once)
        Package(target)

    def test_manifests_hash_changed_payloads_and_pass_c11_validation(self):
        components = self.stage_components()
        self.assertEqual(list(self.stage.rglob('component.json')), [])
        payload = self.stage / 'runtime.python/payload'
        before = component_manifest.tree_sha256(payload)
        binary = payload / 'bin/python3.12'
        binary.write_bytes(binary.read_bytes() + b'# signed\n')
        references = build_components.write_manifests(self.stage, components)
        self.assertEqual([ref['id'] for ref in references], [entry['id'] for entry in components])
        for entry, ref in zip(components, references):
            with self.subTest(component=entry['id']):
                path = self.stage / entry['id'] / 'component.json'
                doc = json.loads(path.read_text())
                self.assertEqual(ref, {key: doc[key] for key in ('id', 'version', 'tree_sha256')})
                self.assertEqual({key: doc[key] for key in entry}, entry)
                self.assertEqual(doc['tree_sha256'], component_manifest.tree_sha256(path.parent / 'payload'))
                if entry['id'] == 'runtime.python': self.assertNotEqual(doc['tree_sha256'], before)
                result = subprocess.run(['python3', '-I', str(ROOT / 'protocol/C11-components/validate.py'), str(path)],
                                        capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertFalse((path.parent / 'payload/component.json').exists())

    def test_manifest_rejects_missing_or_escaping_entry(self):
        payload = self.stage / 'agentd/payload'; payload.mkdir(parents=True)
        outside = self.root / 'outside.py'; outside.write_text('outside')
        entry = payload / 'agentd_launcher.py'
        component = dict(id='agentd', version='1', entrypoints={'launcher': entry.name}, provides={}, requires={})
        for damage in ('missing', 'symlink'):
            with self.subTest(entry=damage):
                if damage == 'symlink': entry.symlink_to(outside)
                with self.assertRaisesRegex(ValueError, 'agentd.*agentd_launcher.py'):
                    build_components.write_manifests(self.stage, [component])
                self.assertFalse((payload.parent / 'component.json').exists())

    def test_content_overrides_replace_and_add_files_inside_their_component(self):
        payload = self.stage / 'agentd/payload'; (payload / 'agentd/brain').mkdir(parents=True)
        (payload / 'agentd/brain/table.json').write_text('stub')
        table = self.root / 'table.json'; table.write_text('local table')
        hints = self.root / 'hints.json'; hints.write_text('local hints')
        applied = build_components.apply_content_overrides(dict(agentd=payload), {
            'agentd/agentd/brain/table.json': table, 'agentd/content/efmi-slot-hints.json': hints})
        self.assertEqual(applied, [('agentd', 'agentd/brain/table.json'), ('agentd', 'content/efmi-slot-hints.json')])
        self.assertEqual(self.files(payload), {'agentd/brain/table.json': b'local table',
                                               'content/efmi-slot-hints.json': b'local hints'})

    def test_a_content_override_outside_its_component_is_refused(self):
        payload = self.stage / 'agentd/payload'; payload.mkdir(parents=True)
        source = self.root / 'source.json'; source.write_text('{}')
        for relative in ('agentd/../web-ui/payload/x.json', 'agentd/../../escaped.json', 'agentd/', 'agentd', 'web-ui/x.json',
                         '../agentd/x.json'):
            with self.subTest(relative=relative), self.assertRaisesRegex(ValueError, 'content_override_outside_component'):
                build_components.apply_content_overrides(dict(agentd=payload), {relative: source})
        self.assertEqual([p for name in ('x.json', 'escaped.json') for p in self.root.rglob(name)], [])

    def test_release_content_applies_its_overrides_and_refuses_a_library_with_local_paths(self):
        payload = self.stage / 'agentd/payload'; payload.mkdir(parents=True)
        hints = self.root / 'hints.json'; hints.write_text('local hints')
        overrides = {'agentd/content/efmi-slot-hints.json': hints}
        library = self.root / 'library'; shutil.copytree(LIBRARY, library)
        self.assertEqual(build_components.stage_release_content(dict(agentd=payload), overrides, library),
                         [('agentd', 'content/efmi-slot-hints.json')])
        (library / 'notes.txt').write_text('built in /Users/someone/library')
        with self.assertRaisesRegex(ValueError, 'release library holds 1 local absolute paths: notes.txt'):
            build_components.stage_release_content(dict(agentd=payload), overrides, library)


if __name__ == '__main__': unittest.main()
