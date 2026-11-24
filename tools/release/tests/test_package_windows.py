"""package_windows.py stages the Windows portable directory from tiny build outputs under a path with a space."""
import json
import os
import shutil
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
PACK_ID = 'AgenticComplex'
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
        for name in ('main.mjs', 'main.mjs.map', 'preload.cjs', 'native/preview.node'):
            (self.electron_dir / 'dist' / name).parent.mkdir(exist_ok=True); (self.electron_dir / 'dist' / name).write_text('shell ' + name)
        # npm ci's velopack, with the native modules of every platform, and its loader.
        for relative in (*package_windows.VELOPACK_SDK_FILES, 'node_modules/velopack/lib/index.d.ts',
                         'node_modules/velopack/lib/native/velopack_nodeffi_osx.node', 'node_modules/esbuild/package.json'):
            (self.electron_dir / relative).parent.mkdir(parents=True, exist_ok=True); (self.electron_dir / relative).write_text('npm ' + relative)
        self.helper = self.root / 'ac-helper.exe'; self.helper.write_text('helper')
        # build.bat puts the speech runtime's DLLs beside ac-helper.exe.
        for name in ('sherpa-onnx-c-api.dll', 'onnxruntime.dll'): (self.root / name).write_text('dll ' + name)
        self.renderer = self.root / 'renderer'; self.renderer.mkdir()
        for name in ('efw.exe', 'depth_copy.spv', 'premultiply_alpha.spv', 'main.obj', 'product.txt'):
            (self.renderer / name).write_text('renderer ' + name)
        self.fbx_tool = self.root / 'fbx-motion.exe'; self.fbx_tool.write_text('fbx')
        self.envelopes = self.root / 'window-envelopes.json'
        self.envelopes.write_text(json.dumps(dict(schema='endfield-window-envelopes/v1', guard_pt=16, characters=dict(
            fixture=dict(package_version='1.0.0', extents_pt=dict(left=1, right=1, top=1, bottom=1), clips_pt={})))))
        self.output = self.root / 'pack out'

    def stage(self, **changes):
        args = dict(library=LIBRARY, python=self.python, harness_runtime=self.prepared,
                    web_dist=self.web, electron_runtime=self.electron_runtime, electron_dir=self.electron_dir,
                    helper=self.helper, renderer=self.renderer, window_envelopes=self.envelopes, fbx_tool=self.fbx_tool, output=self.output,
                    build_version='20261121.1', vpk=self.root / 'vpk/vpk.exe', port=None, id=None, product_name=None, app_version=None)
        args.update(changes)
        order, self.icon = [], None

        def pack(vpk, package, releases, version, title, icon):
            order.append('vpk')
            self.icon = icon and icon.read_bytes()
            return [dict(file=PACK_ID + '-win-Setup.exe', bytes=1, sha256='0' * 64)]
        with patch.object(build_components, 'python_version', return_value='3.12.10') as version, \
                patch.object(package_windows, 'brand', side_effect=lambda *a: order.append('brand') or BRANDING) as brand, \
                patch.object(package_windows, 'flip_fuses', side_effect=lambda *a: order.append('fuses') or FUSES) as fuses, \
                patch.object(package_windows, 'check_runtime_python') as check, \
                patch.object(package_windows, 'vpk_pack', side_effect=pack) as vpk:
            receipt = package_windows.stage(**args)
        self.brand, self.order, self.vpk = brand, order, vpk
        return receipt, version, fuses, check

    def art(self):
        """A UI art directory: art-manifest.json, a page image and the brand icon."""
        art = self.root / 'ui art'
        (art / 'brand').mkdir(parents=True); (art / 'common').mkdir()
        (art / 'brand/AppIcon-1024.png').write_bytes(windows_exe.write_png(256, 256, [bytearray(b'\x10\x20\x30\xff' * 256)] * 256))
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
        self.assertEqual(top, {'Agentic Complex.exe', 'ac-helper.exe', 'sherpa-onnx-c-api.dll', 'onnxruntime.dll', 'efw.exe',
                               'depth_copy.spv', 'premultiply_alpha.spv', 'window-envelopes.json', 'ffmpeg.dll', 'icudtl.dat', 'LICENSE'})
        self.assertEqual((package / 'window-envelopes.json').read_bytes(), self.envelopes.read_bytes())
        for name in ('sherpa-onnx-c-api.dll', 'onnxruntime.dll'): self.assertEqual((package / name).read_text(), 'dll ' + name)
        self.assertEqual(sorted(p.name for p in (package / 'licenses').iterdir()),
                         ['onnxruntime-LICENSE.txt', 'onnxruntime-ThirdPartyNotices.txt', 'sherpa-onnx-LICENSE.txt'])
        self.assertEqual((package / 'Agentic Complex.exe').read_text(), 'electron electron.exe')
        # Chromium's strings only in the languages kept; it falls back to en-US.pak for the others.
        self.assertEqual({f for f in files if f.startswith('locales/')},
                         {'locales/en-US.pak', 'locales/ja.pak', 'locales/zh-CN.pak', 'locales/zh-TW.pak'})
        self.assertNotIn('resources/default_app.asar', files)
        self.assertEqual({f for f in files if f.startswith('resources/app/')},
                         {'resources/app/package.json', 'resources/app/dist/main.mjs', 'resources/app/dist/preload.cjs',
                          'resources/app/dist/native/preview.node', *('resources/app/' + f for f in package_windows.VELOPACK_SDK_FILES)})
        self.assertIn('resources/app/node_modules/velopack/lib/native/velopack_nodeffi_win_x64_msvc.node', files)
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
        self.assertEqual(manifests['renderer']['placed'], {name: name for name in ('efw.exe', 'depth_copy.spv', 'premultiply_alpha.spv', 'window-envelopes.json')})
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

    def test_the_browser_host_sits_beside_agentd_where_the_shell_looks_for_it(self):
        self.stage()
        # app/electron/src/main/index.ts: resolve(agentdDir, '..', 'browser', 'native_host.py'), agentdDir the payload's agentd.
        payload = self.output / 'Agentic Complex/resources/components/agentd/payload'
        self.assertTrue((payload / 'agentd/codex_hook_forward.py').is_file())
        browser = payload / 'agentd' / '..' / 'browser'
        self.assertEqual(sorted(path.name for path in browser.iterdir()), ['extension-origin', 'native_host.py'])
        for name in ('native_host.py', 'extension-origin'):
            self.assertEqual((browser / name).read_bytes(), (ROOT / 'agent/browser' / name).read_bytes())

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
        for path in self.renderer.glob('*.spv'): path.unlink()
        with self.assertRaisesRegex(ValueError, 'renderer_shaders_missing'): self.stage()

    def test_window_envelopes_without_a_row_at_a_rendering_characters_package_version_are_refused(self):
        for rows in (dict(fixture=dict(package_version='0.9.0')), {}):
            self.envelopes.write_text(json.dumps(dict(characters=rows)))
            with self.assertRaisesRegex(ValueError, 'window_envelopes_stale: fixture'): self.stage()
            shutil.rmtree(self.output)

    def test_a_helper_without_its_speech_dlls_beside_it_is_refused(self):
        (self.root / 'onnxruntime.dll').unlink()
        with self.assertRaisesRegex(ValueError, 'helper_dll_missing: onnxruntime.dll'): self.stage()

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
        self.assertEqual(self.order, ['brand', 'brand', 'brand', 'fuses', 'vpk'])
        calls = [(Path(call.args[0]).name, *call.args[1:])
                 for call in self.brand.call_args_list]
        self.assertEqual(sorted(calls), [(name, art, 'Agentic Complex', '0.2.0', '20261121.1')
                                         for name in ('Agentic Complex.exe', 'ac-helper.exe', 'efw.exe')])
        self.assertEqual(receipt['branding'], {name: BRANDING for name in ('Agentic Complex.exe', 'ac-helper.exe', 'efw.exe')})
        self.assertEqual(json.loads((self.output / 'pack-receipt.json').read_text()), json.loads(json.dumps(receipt)))

    def test_without_ui_art_the_pages_have_none_and_the_exe_gets_only_its_version(self):
        receipt, *_ = self.stage()
        self.assertFalse((self.output / 'Agentic Complex/resources/components/web-ui/payload/ui/art').exists())
        self.assertIsNone(receipt['ui_art'])
        self.assertIsNone(self.brand.call_args.args[1])
        with patch.object(windows_exe, 'brand') as brand:
            package_windows.brand(Path('x.exe'), None, 'Agentic Complex', '0.2.0', '1')
            self.assertIsNone(brand.call_args.kwargs['icon_png'])
            self.assertEqual(brand.call_args.kwargs['executable'], 'x.exe')
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
        host = [f for f in files if '/' not in f and f not in ('efw.exe', 'depth_copy.spv', 'premultiply_alpha.spv', 'window-envelopes.json', 'big copy.bin')]
        host += [f for f in files if f.startswith(('locales/', 'licenses/', 'resources/app/', 'resources/components/host/'))]
        self.assertEqual(components['host']['files'], len(host + ['resources/parent_watch.py']))
        self.assertEqual(components['renderer']['files'], 5)
        self.assertEqual(sorted(row['path'] for row in found['large']),
                         ['big copy.bin', 'resources/components/harness.pi/payload/pi-runtime/node_modules/a/big.bin'])
        removable = {row['what']: row for row in found['removable']}
        self.assertEqual(removable['source maps (*.map)']['files'], 1)
        self.assertIn('resources/components/harness.pi/payload/pi-runtime/node_modules', removable)
        self.assertEqual(found['duplicates'], [dict(paths=['big copy.bin', 'resources/components/harness.pi/payload/pi-runtime/node_modules/a/big.bin'],
                                                    bytes=len(big))])
        self.assertEqual(receipt['contents']['large'], [])

    def test_the_staged_directory_is_packed_by_vpk_into_releases_and_the_receipt_lists_its_files(self):
        art = self.art()
        receipt, *_ = self.stage(ui_art=art, app_version='0.3.1', build_version='20261123.2')
        (vpk, package, releases, version, title, icon), _ = self.vpk.call_args
        self.assertEqual((vpk, package, releases), (self.root / 'vpk/vpk.exe', self.output / 'Agentic Complex', self.output / 'releases'))
        self.assertEqual((version, title), ('0.3.1-20261123.2', 'Agentic Complex'))
        # The icon brand() embeds, only for vpk.
        self.assertEqual(self.icon, windows_exe.ico(windows_exe.icon((art / 'brand/AppIcon-1024.png').read_bytes())))
        self.assertFalse(icon.exists())
        self.assertEqual({k: receipt[k] for k in ('pack_id', 'version', 'releases')},
                         dict(pack_id=PACK_ID, version='0.3.1-20261123.2',
                              releases=[dict(file=PACK_ID + '-win-Setup.exe', bytes=1, sha256='0' * 64)]))
        self.assertEqual(json.loads((self.output / 'pack-receipt.json').read_text())['releases'], receipt['releases'])
        self.stage(output=self.root / 'no art')
        self.assertIsNone(self.vpk.call_args.args[5])

    def test_vpk_packs_the_main_exe_under_the_stable_id_and_its_files_are_listed(self):
        releases = self.root / 'releases'
        written = {PACK_ID + '-win-Setup.exe': b'setup', PACK_ID + '-0.2.0-20261121.1-full.nupkg': b'full',
                   PACK_ID + '-win-Portable.zip': b'portable zip', 'releases.win.json': b'{}'}

        def vpk(argv, **kwargs):
            releases.mkdir()
            for name, data in written.items(): (releases / name).write_bytes(data)
        with patch.object(package_windows.subprocess, 'run', side_effect=vpk) as run:
            found = package_windows.vpk_pack(Path('C:/vpk/vpk.exe'), Path('C:/out/Agentic Complex'), releases, '0.2.0-20261121.1',
                                             'Agentic Complex', Path('C:/out/AppIcon.ico'))
        argv = run.call_args.args[0]
        options = dict(zip(argv[2:-2:2], argv[3:-2:2]))
        self.assertEqual(argv[:2] + argv[-2:], [str(Path('C:/vpk/vpk.exe')), 'pack', '--skip-updates', '--legacyConsole'])
        self.assertEqual(options, {'--packId': PACK_ID, '--packVersion': '0.2.0-20261121.1', '--packDir': str(Path('C:/out/Agentic Complex')),
                                   '--mainExe': 'Agentic Complex.exe', '--packTitle': 'Agentic Complex', '--runtime': 'win-x64',
                                   '--outputDir': str(releases),
                                   '--icon': str(Path('C:/out/AppIcon.ico'))})
        self.assertNotIn(' ', PACK_ID)
        self.assertTrue(run.call_args.kwargs['check'])
        self.assertEqual(found, [dict(file=name, bytes=len(written[name]), sha256=package_windows.digest(releases / name))
                                 for name in sorted(written)])
        with patch.object(package_windows.subprocess, 'run') as run:
            package_windows.vpk_pack(Path('vpk.exe'), Path('pack'), releases, '0.2.0-1', 'Agentic Complex', None)
        self.assertNotIn('--icon', run.call_args.args[0])

    def test_the_release_version_is_the_app_version_with_the_build_as_prerelease_rising_with_the_build(self):
        self.assertEqual(package_windows.release_version('0.2.0', '20261121.1'), '0.2.0-20261121.1')

        def semver(version):
            """SemVer2 precedence of MAJOR.MINOR.PATCH-<numeric prerelease> as a sortable key."""
            core, _, pre = version.partition('-')
            return [int(n) for n in core.split('.')], [int(n) for n in pre.split('.')]
        builds = ['20261121.1', '20261121.2', '20261121.10', '20261122', '20261122.1', '20261201.1']
        versions = [package_windows.release_version('0.2.0', build) for build in builds]
        self.assertEqual(sorted(versions, key=semver), versions)
        self.assertLess(semver(package_windows.release_version('0.2.0', '20291231.9')), semver(package_windows.release_version('0.2.1', '1')))
        for app, build, error in (('0.2', '20261121.1', 'app_version_not_semver'), ('0.2.0-rc', '1', 'app_version_not_semver'),
                                  ('0.2.0', '20261121.01', 'build_version_not_numeric'), ('0.2.0', '2026-11-21', 'build_version_not_numeric'),
                                  ('0.2.0', '', 'build_version_not_numeric')):
            with self.subTest(app=app, build=build), self.assertRaisesRegex(ValueError, error):
                package_windows.release_version(app, build)
        # Refused before anything is written.
        with self.assertRaisesRegex(ValueError, 'build_version_not_numeric'): self.stage(build_version='x')
        self.assertFalse(self.output.exists())

    def test_the_velopack_lock_pins_the_sdk_zip_by_sha512_and_vpk_to_the_shell_package(self):
        lock = json.loads((ROOT / 'app/packaging/velopack.lock.json').read_text())
        sdk = lock['dotnet_sdk']
        self.assertEqual(lock['version'], lock['npm_version'])
        self.assertEqual(json.loads((ROOT / 'app/electron/package.json').read_text())['dependencies'], {'velopack': lock['npm_version']})
        self.assertRegex(sdk['version'], r'^10\.0\.\d+$')
        self.assertEqual(sdk['url'], f'https://builds.dotnet.microsoft.com/dotnet/Sdk/{sdk["version"]}/{sdk["archive"]}')
        self.assertEqual(sdk['archive'], f'dotnet-sdk-{sdk["version"]}-win-x64.zip')
        self.assertRegex(sdk['sha512'], '^[0-9a-f]{128}$')


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
