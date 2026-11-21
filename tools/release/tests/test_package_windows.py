"""package_windows.py stages the Windows portable directory from tiny build outputs under a path with a space."""
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build_components
import component_manifest
import package_windows
import windows_exe
from test_harness_runtime import prepared_fixture

ROOT = Path(__file__).resolve().parents[3]
LIBRARY = ROOT / 'protocol/character-library/fixtures/library'
FUSES = {'file': '', 'version': '1', 'fuses': {'RunAsNode': 'disabled'}}
BRANDING = {'version': {'ProductName': 'Agentic Complex'}, 'icons': 6, 'icon_groups': ['1'], 'icon_sizes': [256]}


class PackageWindowsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve() / 'build inputs'
        python = self.root / 'Python312'
        for relative in ('python.exe', 'pythonw.exe', 'python312.dll', 'vcruntime140.dll', 'DLLs/_ssl.pyd', 'DLLs/libssl-3.dll',
                         'Lib/os.py', 'Lib/encodings/__init__.py', 'Lib/__pycache__/os.cpython-312.pyc', 'Lib/test/test_os.py',
                         'Lib/site-packages/host_only.py', 'Scripts/pip.exe', 'include/Python.h', 'libs/python312.lib',
                         'Doc/python.chm', 'Tools/i18n/msgfmt.py', 'LICENSE.txt'):
            (python / relative).parent.mkdir(parents=True, exist_ok=True); (python / relative).write_text('python ' + relative)
        self.python = python
        self.prepared = prepared_fixture(self.root / 'harness', platform='win32-x64')
        self.web = self.root / 'web'; self.web.mkdir()
        for name in ('main.html', 'stack.html'): (self.web / name).write_text('web ' + name)
        electron = self.root / 'electron-v45.4.1-win32-x64'
        for relative in ('electron.exe', 'ffmpeg.dll', 'icudtl.dat', 'locales/en-US.pak', 'locales/en-GB.pak', 'locales/fr.pak',
                         'locales/ja.pak', 'locales/zh-CN.pak', 'locales/zh-TW.pak', 'resources/default_app.asar', 'LICENSE'):
            (electron / relative).parent.mkdir(parents=True, exist_ok=True); (electron / relative).write_text('electron ' + relative)
        self.electron_runtime = electron
        self.electron_dir = self.root / 'app/electron'; (self.electron_dir / 'dist').mkdir(parents=True)
        (self.electron_dir / 'package.json').write_text(json.dumps(dict(name='agentic-complex-electron', type='module',
                                                                        main='dist/main.mjs', devDependencies={})))
        for name in ('main.mjs', 'main.mjs.map', 'preload.cjs'): (self.electron_dir / 'dist' / name).write_text('shell ' + name)
        self.helper = self.root / 'ac-helper.exe'; self.helper.write_text('helper')
        self.renderer = self.root / 'renderer'; self.renderer.mkdir()
        for name in ('efw.exe', 'depth_copy.dxbc', 'premultiply_alpha.dxbc', 'main.obj', 'product.txt'):
            (self.renderer / name).write_text('renderer ' + name)
        self.fbx_tool = self.root / 'fbx-motion.exe'; self.fbx_tool.write_text('fbx')
        self.output = self.root / 'pack out'

    def stage(self, **changes):
        args = dict(library=LIBRARY, python=self.python, harness_runtime=self.prepared,
                    web_dist=self.web, electron_runtime=self.electron_runtime, electron_dir=self.electron_dir,
                    helper=self.helper, renderer=self.renderer, fbx_tool=self.fbx_tool, output=self.output,
                    build_version='20261121.1', port=None, id=None, product_name=None, app_version=None)
        args.update(changes)
        order = []
        with patch.object(build_components, 'python_version', return_value='3.12.10') as version, \
                patch.object(package_windows, 'brand', side_effect=lambda *a: order.append('brand') or BRANDING) as brand, \
                patch.object(package_windows, 'flip_fuses', side_effect=lambda *a: order.append('fuses') or FUSES) as fuses, \
                patch.object(package_windows, 'check_runtime_python') as check:
            receipt = package_windows.stage(**args)
        self.brand, self.order = brand, order
        return receipt, version, fuses, check

    def art(self):
        """A UI art directory: art-manifest.json, a page image and the brand icon."""
        art = self.root / 'ui art'
        (art / 'brand').mkdir(parents=True); (art / 'common').mkdir()
        (art / 'brand/AppIcon-1024.png').write_bytes(windows_exe.write_png(2, 2, [bytearray(8), bytearray(8)]))
        (art / 'common/tab.png').write_bytes(b'tab')
        # A character the library does not have: its art stays out.
        (art / 'characters/elsewhere').mkdir(parents=True); (art / 'characters/elsewhere/round.png').write_bytes(b'round')
        files = [dict(key=f[:-4], file=f, sha256=package_windows.digest(art / f))
                 for f in ('brand/AppIcon-1024.png', 'common/tab.png', 'characters/elsewhere/round.png')]
        (art / 'art-manifest.json').write_text(json.dumps(dict(schema='endfield-ui-art/v1', files=files)))
        return art

    def files(self, root):
        return {path.relative_to(root).as_posix() for path in root.rglob('*') if path.is_file()}

    def test_the_portable_directory_has_the_shell_helper_renderer_and_components_in_place(self):
        receipt, version, fuses, check = self.stage()
        package = self.output / 'Agentic Complex'
        self.assertEqual(receipt['package'], package.name)
        files = self.files(package)
        self.assertEqual(receipt['files'], len(files))
        self.assertEqual(receipt['bytes'], sum((package / f).stat().st_size for f in files))
        self.assertEqual(receipt['fuses'], FUSES)
        top = {f for f in files if '/' not in f}
        self.assertEqual(top, {'Agentic Complex.exe', 'ac-helper.exe', 'efw.exe', 'depth_copy.dxbc', 'premultiply_alpha.dxbc',
                               'ffmpeg.dll', 'icudtl.dat', 'LICENSE'})
        self.assertEqual((package / 'Agentic Complex.exe').read_text(), 'electron electron.exe')
        # Chromium's strings only in the languages kept; it falls back to en-US.pak for the others.
        self.assertEqual({f for f in files if f.startswith('locales/')},
                         {'locales/en-US.pak', 'locales/ja.pak', 'locales/zh-CN.pak', 'locales/zh-TW.pak'})
        self.assertNotIn('resources/default_app.asar', files)
        self.assertEqual({f for f in files if f.startswith('resources/app/')},
                         {'resources/app/package.json', 'resources/app/dist/main.mjs', 'resources/app/dist/preload.cjs'})
        app = json.loads((package / 'resources/app/package.json').read_text())
        self.assertEqual(app, dict(name='agentic-complex-electron', productName='Agentic Complex', version='0.2.0', private=True,
                                   type='module', main='dist/main.mjs'))
        self.assertEqual((package / 'resources/parent_watch.py').read_bytes(), (ROOT / 'app/Resources/parent_watch.py').read_bytes())
        # The electron.exe the fuses were flipped in is the host payload's renamed one.
        self.assertEqual(Path(fuses.call_args.args[0]).name, 'Agentic Complex.exe')
        version.assert_called_once_with(self.python.resolve() / 'python.exe')
        # The relocation check runs the shipped python.exe, under the path with the space.
        python = package / 'resources/components/runtime.python/payload/python.exe'
        check.assert_called_once_with(python)
        self.assertIn(' ', str(python))

    def test_runtime_python_is_the_base_prefix_without_build_parts_and_the_locked_site(self):
        self.stage()
        runtime = self.output / 'Agentic Complex/resources/components/runtime.python/payload'
        files = self.files(runtime)
        for relative in ('python.exe', 'pythonw.exe', 'python312.dll', 'vcruntime140.dll', 'DLLs/_ssl.pyd', 'DLLs/libssl-3.dll',
                         'Lib/os.py', 'Lib/encodings/__init__.py', 'LICENSE.txt',
                         'licenses/numpy/LICENSE.txt'):
            self.assertIn(relative, files)
        for relative in ('Lib/__pycache__/os.cpython-312.pyc', 'Lib/test/test_os.py', 'Lib/site-packages/host_only.py',
                         'Scripts/pip.exe', 'include/Python.h', 'libs/python312.lib', 'Doc/python.chm', 'Tools/i18n/msgfmt.py'):
            self.assertNotIn(relative, files)
        self.assertFalse([f for f in files if f.startswith('bin/')])
        # The build host's installer stays out.
        self.assertFalse([f for f in files if f.startswith(('Lib/site-packages/pip/', 'Lib/site-packages/pip-'))])

    def test_every_manifest_and_the_lock_are_windows_x64_and_compose(self):
        self.stage()
        resources = self.output / 'Agentic Complex/resources'
        lock = json.loads((resources / 'composition.lock.json').read_text())
        self.assertEqual((lock['platform'], lock['edition'], lock['host']['id']), ('windows-x64', 'portable', 'host'))
        ids = {'runtime.python', 'harness.pi', 'agentd', 'web-ui', 'characters.fixture', 'renderer'}
        self.assertEqual({ref['id'] for ref in lock['components']}, ids)
        self.assertEqual({ref['placement'] for ref in lock['components']}, {'bundle'})
        manifests = {path.parent.name: json.loads(path.read_text()) for path in (resources / 'components').glob('*/component.json')}
        self.assertEqual(set(manifests), ids | {'host'})
        self.assertEqual({doc['platform'] for doc in manifests.values()}, {'windows-x64'})
        c11 = component_manifest.c11
        for doc in manifests.values(): self.assertIsNone(c11.check_component(doc), doc['id'])
        self.assertIsNone(c11.check_lock(lock))
        self.assertIsNone(c11.check_composition(lock, list(manifests.values())))
        entries = {id: doc['entrypoints'] for id, doc in manifests.items()}
        self.assertEqual(entries['runtime.python'], {'python': 'python.exe'})
        self.assertEqual(entries['harness.pi'], {'node': 'node/node.exe'})
        self.assertEqual(entries['agentd']['fbx_tool'], 'tools/fbx-motion.exe')
        self.assertEqual(entries['host'], {'executable': 'Agentic Complex.exe'})
        self.assertEqual(entries['renderer'], {'executable': 'efw.exe'})
        self.assertEqual(manifests['agentd']['requires'], {'runtime.python': '3.12.10'})
        self.assertEqual(manifests['renderer']['placed'], {name: name for name in ('efw.exe', 'depth_copy.dxbc', 'premultiply_alpha.dxbc')})
        placed = manifests['host']['placed']
        self.assertEqual(list(placed)[:2], ['Agentic Complex.exe', 'ac-helper.exe'])
        self.assertTrue({'resources/app', 'resources/parent_watch.py', 'locales', 'ffmpeg.dll'} <= set(placed))
        self.assertFalse({'resources', 'resources/default_app.asar', 'electron.exe'} & set(placed))
        package = self.output / 'Agentic Complex'
        for id in ('host', 'renderer'):
            for target in manifests[id]['placed'].values(): self.assertTrue((package / target).exists(), target)
        for id in ids - {'renderer'}:
            payload = resources / 'components' / id / 'payload'
            self.assertEqual(manifests[id]['tree_sha256'], component_manifest.tree_sha256(payload), id)
            for relative in manifests[id]['entrypoints'].values(): self.assertTrue((payload / relative).is_file(), relative)
        self.assertEqual((resources / 'components/agentd/payload/tools/fbx-motion.exe').read_text(), 'fbx')
        self.assertEqual((resources / 'components/harness.pi/payload/node/node.exe').read_bytes(), b'synthetic executable')
        self.assertFalse(list(self.output.glob('.components*')))

    def test_distribution_names_the_portable_layout_and_the_composed_catalog(self):
        self.stage(port=48820)
        distribution = json.loads((self.output / 'Agentic Complex/resources/distribution.json').read_text())
        catalog = json.loads((LIBRARY / 'current.json').read_text())
        self.assertEqual({k: v for k, v in distribution.items() if k != 'catalogSHA256'},
                         dict(schema='endfield-distribution/v3', id='local.agenticcomplex.companion', edition='replacement',
                              layout='portable', port=48820, defaultCharacter=catalog.get('default_character')))
        self.assertRegex(distribution['catalogSHA256'], '^[0-9a-f]{64}$')

    def test_no_payload_is_staged_in_a_mkdtemp_directory(self):
        # On Windows mkdtemp's directory admits only its creator, and what is moved out of it keeps that ACL.
        with patch.object(tempfile, 'mkdtemp', wraps=tempfile.mkdtemp) as mkdtemp:
            self.stage()
        made = [dict(zip(('suffix', 'prefix', 'dir'), call.args), **call.kwargs) for call in mkdtemp.call_args_list]
        # Only the catalog's, which is hashed and removed.
        self.assertEqual({str(m['prefix']) for m in made if Path(m['dir']) == self.output}, {'.catalog-', '.compose-'})

    def test_an_existing_output_or_a_renderer_without_shaders_is_refused(self):
        self.output.mkdir()
        with self.assertRaisesRegex(ValueError, 'output already exists'): self.stage()
        self.output.rmdir()
        for path in self.renderer.glob('*.dxbc'): path.unlink()
        with self.assertRaisesRegex(ValueError, 'renderer_shaders_missing'): self.stage()

    def test_the_relocation_check_runs_python_with_only_systemroot_and_needs_its_own_prefix(self):
        python = self.root / 'Agentic Complex/resources/components/runtime.python/payload/python.exe'
        prefix = str(python.parent)
        for stdout, code, error in ((json.dumps([prefix, [prefix, prefix + os.sep + 'Lib']]), 0, None),
                                    (json.dumps([prefix, ['C:\\Python312\\Lib']]), 0, 'runtime_python_path_outside'),
                                    (json.dumps(['C:\\Python312', []]), 0, 'runtime_python_prefix'),
                                    ('', 1, 'runtime_python_import_failed: .*No module named win32api')):
            with self.subTest(error), patch.object(package_windows.subprocess, 'run') as run:
                run.return_value = package_windows.subprocess.CompletedProcess([], code, stdout,
                                                                               'Traceback\nModuleNotFoundError: No module named win32api\n')
                if error is None: package_windows.check_runtime_python(python)
                else:
                    with self.assertRaisesRegex(ValueError, error): package_windows.check_runtime_python(python)
                argv, env = run.call_args.args[0], run.call_args.kwargs['env']
                self.assertEqual(argv[:4], [str(python), '-I', '-B', '-c'])
                for module in ('ssl', 'sqlite3', 'ctypes', 'httpx', 'jwt', 'mcp', 'numpy', 'pydantic_core', 'cryptography',
                               'win32api'):
                    self.assertIn(module, argv[4])
                self.assertEqual(set(env), {'SYSTEMROOT'})

    def test_the_ui_art_ships_in_the_pages_and_brands_the_exe_before_the_fuses(self):
        art = self.art()
        receipt, *_ = self.stage(ui_art=art)
        ui = self.output / 'Agentic Complex/resources/components/web-ui/payload/ui'
        self.assertEqual((ui / 'art/common/tab.png').read_bytes(), b'tab')
        self.assertTrue((ui / 'art/brand/AppIcon-1024.png').is_file())
        self.assertFalse((ui / 'art/characters/elsewhere').exists())
        self.assertEqual(receipt['ui_art'], dict(files=2, manifest_sha256=package_windows.digest(art / 'art-manifest.json')))
        self.assertEqual(self.order, ['brand', 'fuses'])
        executable, ui_art, *rest = self.brand.call_args.args
        self.assertEqual((Path(executable).name, ui_art, rest), ('Agentic Complex.exe', art, ['Agentic Complex', '0.2.0', '20261121.1']))
        self.assertEqual(receipt['branding'], BRANDING)
        self.assertEqual(json.loads((self.output / 'pack-receipt.json').read_text()), json.loads(json.dumps(receipt)))

    def test_without_ui_art_the_pages_have_none_and_the_exe_gets_only_its_version(self):
        receipt, *_ = self.stage()
        self.assertFalse((self.output / 'Agentic Complex/resources/components/web-ui/payload/ui/art').exists())
        self.assertIsNone(receipt['ui_art'])
        self.assertIsNone(self.brand.call_args.args[1])
        with patch.object(windows_exe, 'brand') as brand:
            package_windows.brand(Path('x.exe'), None, 'Agentic Complex', '0.2.0', '1')
            self.assertIsNone(brand.call_args.kwargs['icon_png'])
            package_windows.brand(Path('x.exe'), self.art(), 'Agentic Complex', '0.2.0', '1')
            self.assertEqual(brand.call_args.kwargs['icon_png'][:8], b'\x89PNG\r\n\x1a\n')

    def test_contents_counts_entries_and_components_and_lists_large_and_removable_files(self):
        with patch.object(package_windows, 'LARGE_FILE', 2 * 1024 * 1024):
            receipt, *_ = self.stage()
        package = self.output / 'Agentic Complex'
        big = os.urandom(2 * 1024 * 1024)
        for relative in ('resources/components/harness.pi/payload/pi-runtime/node_modules/a/big.bin', 'big copy.bin'):
            (package / relative).parent.mkdir(parents=True, exist_ok=True); (package / relative).write_bytes(big)
        (package / 'resources/app/dist/main.mjs.map').write_text('map')
        with patch.object(package_windows, 'LARGE_FILE', 2 * 1024 * 1024):
            found = package_windows.contents(package)
        files = self.files(package)
        top = {row['entry']: row for row in found['top']}
        self.assertEqual(set(top), {f.split('/')[0] for f in files})
        self.assertEqual(sum(row['files'] for row in top.values()), len(files))
        self.assertEqual(top['resources']['files'], len([f for f in files if f.startswith('resources/')]))
        components = {row['id']: row for row in found['components']}
        self.assertEqual(set(components), {'runtime.python', 'harness.pi', 'agentd', 'web-ui', 'characters.fixture', 'renderer', 'host'})
        # host's are its placed paths (the exe, the runtime's files and resources\app) and its component.json.
        host = [f for f in files if '/' not in f and f not in ('efw.exe', 'depth_copy.dxbc', 'premultiply_alpha.dxbc', 'big copy.bin')]
        host += [f for f in files if f.startswith(('locales/', 'resources/app/', 'resources/components/host/'))]
        self.assertEqual(components['host']['files'], len(host + ['resources/parent_watch.py']))
        self.assertEqual(components['renderer']['files'], 4)
        self.assertEqual(sorted(row['path'] for row in found['large']),
                         ['big copy.bin', 'resources/components/harness.pi/payload/pi-runtime/node_modules/a/big.bin'])
        removable = {row['what']: row for row in found['removable']}
        self.assertEqual(removable['source maps (*.map)']['files'], 1)
        self.assertIn('resources/components/harness.pi/payload/pi-runtime/node_modules', removable)
        self.assertEqual(found['duplicates'], [dict(paths=['big copy.bin', 'resources/components/harness.pi/payload/pi-runtime/node_modules/a/big.bin'],
                                                    bytes=len(big))])
        self.assertEqual(receipt['contents']['large'], [])


class WindowsExeTests(unittest.TestCase):
    def test_the_icon_is_png_images_of_each_size_in_one_ico_and_one_group(self):
        rows = [bytearray(b''.join(bytes((min(x, 255), min(y, 255), 0, 255 if x > 10 else 0)) for x in range(300))) for y in range(300)]
        images = windows_exe.icon(windows_exe.write_png(300, 300, rows))
        self.assertEqual(list(images), list(windows_exe.ICON_SIZES))
        for size, png in images.items():
            width, height, decoded = windows_exe.read_png(png)
            self.assertEqual((width, height, len(decoded)), (size, size, size))
        # The transparent columns stay without colour; the opaque ones keep theirs.
        first = windows_exe.read_png(images[256])[2][0]
        self.assertEqual((first[:4], first[-4:]), (bytes(4), bytes((255, 0, 0, 255))))
        ico = windows_exe.ico(images)
        self.assertEqual(ico[:6], b'\0\0\1\0' + bytes((len(images), 0)))
        width, height, _, _, planes, bits, size, offset = struct.unpack('<BBBBHHII', ico[6:22])
        self.assertEqual((width, height, planes, bits, ico[offset:offset + size]), (0, 0, 1, 32, images[256]))
        group = windows_exe.group_icon(images)
        self.assertEqual(len(group), 6 + 14 * len(images))
        self.assertEqual(group[6 + 14 * 5 + 12:], b'\x06\x00')
        with self.assertRaisesRegex(ValueError, 'square'):
            windows_exe.icon(windows_exe.write_png(300, 200, rows[:200]))

    def test_the_version_resource_holds_the_product_name_and_versions(self):
        data = windows_exe.version_info('Agentic Complex', '0.2.0', '20261121.1', 'Agentic Complex.exe')
        self.assertEqual(struct.unpack('<HHH', data[:6]), (len(data), 52, 0))
        self.assertEqual(data[6:38].decode('utf-16-le'), 'VS_VERSION_INFO\0')
        self.assertEqual(struct.unpack('<5I', data[40:60]), (0xFEEF04BD, 0x10000, 0x00000002, 0, 0x00000002))
        for key, value in (('ProductName', 'Agentic Complex'), ('OriginalFilename', 'Agentic Complex.exe'), ('FileVersion', '0.2.0'),
                           ('BuildVersion', '20261121.1')):
            with self.subTest(key):
                at = data.index((key + '\0').encode('utf-16-le'))
                length, chars, kind = struct.unpack('<HHH', data[at - 6:at])
                self.assertEqual((chars, kind), (len(value) + 1, 1))
                self.assertEqual(data[at - 6 + length - 2 * chars:at - 6 + length].decode('utf-16-le'), value + '\0')
        for text in ('040904b0', 'StringFileInfo', 'VarFileInfo', 'Translation'):
            self.assertIn(text.encode('utf-16-le'), data)
        self.assertEqual(windows_exe.version_numbers('1.2'), [1, 2, 0, 0])
        for bad in ('20261121.1', '1.2.3.4.5', 'x'):
            with self.subTest(bad), self.assertRaises(ValueError):
                windows_exe.version_numbers(bad)

    @unittest.skipUnless(os.name == 'nt', 'kernel32 resource update: Windows only')
    def test_brand_replaces_the_icon_and_version_of_a_real_exe(self):
        with tempfile.TemporaryDirectory() as tmp:
            exe = Path(tmp, 'Agentic Complex.exe')
            exe.write_bytes(Path(sys.executable).read_bytes())
            rows = [bytearray(b'\x10\x20\x30\xff' * 256) for _ in range(256)]
            read = windows_exe.brand(exe, icon_png=windows_exe.write_png(256, 256, rows), product_name='Agentic Complex',
                                     app_version='0.2.0', build_version='20261121.1', executable=exe.name)
            self.assertEqual(read['version'], dict(ProductName='Agentic Complex', FileDescription='Agentic Complex', FileVersion='0.2.0',
                                                   ProductVersion='0.2.0', OriginalFilename=exe.name, BuildVersion='20261121.1'))
            self.assertEqual((read['icons'], read['icon_sizes']), (len(windows_exe.ICON_SIZES), list(windows_exe.ICON_SIZES)))
            self.assertEqual(len(read['icon_groups']), 1)


if __name__ == '__main__': unittest.main()
