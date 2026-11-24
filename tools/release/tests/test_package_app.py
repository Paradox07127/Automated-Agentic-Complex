import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from package_app import stage
import build_components
import component_manifest
import package_app
import release
from release import CONTENT_SOURCES, shipping_path
import source_fingerprint
from test_harness_runtime import prepared_fixture

sys.path.insert(0, str(package_app.ROOT / 'agent/agentd/tests'))
from test_character_library import fixture as character_fixture
import character_library

NODE = shutil.which('node')


def synthetic_fbx_tool(directory):
    tool = Path(directory) / 'fbx-motion'
    tool.write_text('#!/bin/sh\necho \'{"tool":"fbx-motion/1","ufbx":"0.23.1"}\'\n'); tool.chmod(0o755)
    return tool


def electron_fields(test, directory):
    """package_app's Electron inputs under directory, with a node on PATH that answers --version and flips the fuses."""
    directory = Path(directory)
    helper = directory / 'ac-helper'; helper.write_bytes(b'synthetic helper tool'); helper.chmod(0o755)
    node = directory / 'node'
    node.write_text('#!/bin/sh\nif [ "$1" = --version ]; then echo v24; exit 0; fi\n'
        'case "$1" in */flip_fuses.mjs) ;; *) exit 1;; esac\n'
        'printf fused > "$2/Contents/Frameworks/Electron Framework.framework/Electron Framework" || exit 1\n'
        'echo \'{"file":"Contents/Frameworks/Electron Framework.framework/Electron Framework","fuses":{"RunAsNode":"disabled"}}\'\n')
    node.chmod(0o755)
    test.enterContext(patch.dict(os.environ, PATH=str(directory) + os.pathsep + os.environ['PATH']))
    return dict(electron_app=synthetic_electron_app(directory), electron_dir=synthetic_electron_dir(directory), helper=helper,
                product_name='Agentic Complex', app_version='0.3.0')


class SingleAppStageTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.object(package_app, 'sign_payload', create=True))
        self.enterContext(patch.object(package_app, 'strip_local_symbols'))

    def test_stage_keeps_identity_and_embeds_every_runtime(self):
        library = Path(__file__).resolve().parents[3] / 'protocol/character-library/fixtures/library'
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            binaries = root / 'binaries'; binaries.mkdir()
            (binaries / 'metal-avatar-host').write_bytes(b'synthetic executable')
            fbx_tool = synthetic_fbx_tool(binaries)
            runtime = root / 'python'; (runtime / 'bin').mkdir(parents=True)
            (runtime / 'bin/python3').write_text('#!/bin/sh\nprintf "3.12.99\\n"\n')
            (runtime / 'bin/python3').chmod(0o755)
            web = root / 'web-dist'; (web / 'assets').mkdir(parents=True)
            for name in ['main.html', 'stack.html', 'assets/main.js']:
                (web / name).write_text('synthetic ' + name)
            harness = prepared_fixture(root / 'harness')
            with contextlib.redirect_stdout(io.StringIO()):
                out = root / 'out'
                args = SimpleNamespace(output=out, library=library, id=None,
                    port=None, python=runtime,
                    harness_runtime=harness,
                    host=binaries / 'metal-avatar-host', build_version='1', web_dist=web, fbx_tool=fbx_tool,
                    **electron_fields(self, binaries))
                stage(args)
                app = out / 'Agentic Complex.app'
                info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
                self.assertEqual(info['CFBundleName'], 'Agentic Complex')
                self.assertEqual(info['CFBundleIdentifier'], 'local.agenticcomplex.companion')
                self.assertNotIn('CFBundleIconFile', info)
                self.assertEqual(sorted(p.name for p in (app / 'Contents/MacOS').iterdir()),
                                 ['AgenticComplex', 'AgenticComplexMetalAvatar', 'ac-helper'])
                self.assertEqual(sorted(p.name for p in app.rglob('*.app')), sorted(name + '.app' for name in ELECTRON_HELPERS))
                resources = app / 'Contents/Resources'
                components = resources / 'components'
                service = components / 'agentd/payload'
                runtime_payload = components / 'runtime.python/payload'
                pi = components / 'harness.pi/payload'
                web_payload = components / 'web-ui/payload'
                self.assertTrue((service / 'agentd/server.py').is_file())
                guard_path = service / 'agentd/brain/canon-windows.json'
                guard = json.loads(guard_path.read_text())
                self.assertIs(type(guard['n']), int)
                self.assertEqual(guard['n'], 7)
                self.assertTrue(guard['hashes'])
                for value in guard['hashes']:
                    self.assertIsInstance(value, str)
                    self.assertRegex(value, r'^[0-9a-f]{16}$')
                self.assertEqual(guard_path.read_bytes(),
                                 (package_app.ROOT / 'agent/agentd/brain/canon-windows.json').read_bytes())
                self.assertTrue((service / 'agentd/character_agent/harness/pi_runner.mjs').is_file())
                self.assertTrue((service / 'agentd_launcher.py').is_file())
                self.assertTrue((pi / 'node/bin/node').is_file())
                self.assertTrue((pi / 'licenses/Node-LICENSE').is_file())
                self.assertEqual((runtime_payload / 'licenses/numpy/LICENSE.txt').read_text(), 'synthetic numpy notice')
                self.assertTrue((service / 'content/import_vmd.py').is_file())
                self.assertTrue((service / 'content/mmd/rotation.py').is_file())
                self.assertFalse((components / 'harness.claude').exists())
                self.assertFalse((components / 'harness.codex').exists())
                self.assertTrue((pi / 'pi-runtime/node_modules/@earendil-works/pi-coding-agent/package.json').is_file())
                receipt = json.loads((out / 'staging-manifest.json').read_text())
                self.assertEqual(receipt['personal_agent_runtime']['node_version'], '24.22.1')
                source_document = json.loads((out / 'source-manifest.json').read_text())
                self.assertEqual(source_fingerprint.compute(package_app.ROOT)[1], source_document['fingerprint'])
                source_manifest = source_document['files']
                self.assertIn('agent/agentd/character_agent/harness/pi_runner.mjs', source_manifest)
                self.assertIn('agent/agentd/requirements-character-agent.lock', source_manifest)
                self.assertIn('agent/agentd/brain/canon-windows.json', source_manifest)
                self.assertIn('app/packaging/requirements-content.lock', source_manifest)
                for relative in CONTENT_SOURCES + ('characters/agentic_complex_build/mmd/rotation.py',):
                    self.assertIn(relative, source_manifest)
                self.assertTrue((web_payload / 'ui/main.html').is_file())
                self.assertTrue((web_payload / 'ui/stack.html').is_file())
                self.assertEqual((web_payload / 'ui-bridge/routes.json').read_bytes(),
                                 (package_app.ROOT / 'protocol/ui-bridge/routes.json').read_bytes())
                self.assertRegex(receipt['ui_sha256'], r'^[0-9a-f]{64}$')
                self.assertIn('protocol/ui-bridge/routes.json', source_manifest)
                self.assertIn('web/src/main.tsx', source_manifest)
                self.assertIn('web/src/design/tokens.json', source_manifest)
                self.assertIn('web/package-lock.json', source_manifest)
                self.assertFalse([p for p in source_manifest if '/node_modules/' in p])
                self.assertFalse((resources / 'characters').exists())
                manifest = json.loads((resources / 'distribution.json').read_text())
                self.assertEqual(manifest['schema'], 'endfield-distribution/v3')
                self.assertEqual(manifest['layout'], 'portable')
                self.assertEqual(manifest['defaultCharacter'], 'fixture')
                host = json.loads((components / 'host/component.json').read_text())
                self.assertNotIn('Resources/AppIcon.icns', host['placed'])
                self.assertEqual([p.name for p in out.iterdir() if p.suffix != '.json'], ['Agentic Complex.app'])
            copy2 = package_app.shutil.copy2
            for damage in ('missing', 'invalid'):
                with self.subTest(staged_guard=damage):
                    args.output = root / ('damaged-' + damage)
                    def damaged_copy(source, target, *a, **kw):
                        if Path(source).name == 'canon-windows.json':
                            if damage == 'invalid':
                                Path(target).write_text('{}')
                            return target
                        return copy2(source, target, *a, **kw)
                    with patch.object(package_app.shutil, 'copy2', side_effect=damaged_copy):
                        with self.assertRaisesRegex(ValueError, 'Invalid bundled outbound guard'):
                            stage(args)
                    self.assertFalse((args.output / 'staging-manifest.json').exists())

    def test_ui_art_is_verified_and_shipped_inside_the_hashed_ui_tree(self):
        library = Path(__file__).resolve().parents[3] / 'protocol/character-library/fixtures/library'
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            binaries = root / 'binaries'; binaries.mkdir()
            (binaries / 'metal-avatar-host').write_bytes(b'synthetic executable')
            fbx_tool = synthetic_fbx_tool(binaries)
            runtime = root / 'python'; (runtime / 'bin').mkdir(parents=True)
            (runtime / 'bin/python3').write_text('#!/bin/sh\nprintf "3.12.99\\n"\n')
            (runtime / 'bin/python3').chmod(0o755)
            web = root / 'web-dist'; web.mkdir()
            for name in ['main.html', 'stack.html']:
                (web / name).write_text('synthetic ' + name)
            art = root / 'art'
            files = {'pages/overview/complete-halo.png': b'halo', 'common/contour.png': b'contour', 'brand/AppIcon.icns': b'icns'}
            for name, data in files.items():
                (art / name).parent.mkdir(parents=True, exist_ok=True); (art / name).write_bytes(data)
            manifest = dict(schema='endfield-ui-art/v1', files=[dict(key=name[:-4], file=name, sha256=package_app.digest(art / name))
                                                               for name in files])
            (art / 'art-manifest.json').write_text(json.dumps(manifest))
            args = SimpleNamespace(output=root / 'out', library=library, id=None,
                port=None, python=runtime,
                harness_runtime=prepared_fixture(root / 'harness'),
                host=binaries / 'metal-avatar-host', build_version='1', web_dist=web, ui_art=art, fbx_tool=fbx_tool,
                **electron_fields(self, binaries))
            with contextlib.redirect_stdout(io.StringIO()), \
                 patch.object(source_fingerprint, 'compute', return_value=({'x': 'y'}, 'sentinel')) as compute:
                stage(args)
            compute.assert_called_once_with(package_app.ROOT)
            source_document = json.loads((args.output / 'source-manifest.json').read_text())
            self.assertEqual((source_document['files'], source_document['fingerprint']), ({'x': 'y'}, 'sentinel'))
            ui = args.output / 'Agentic Complex.app/Contents/Resources/components/web-ui/payload/ui'
            for name, data in files.items():
                self.assertEqual((ui / 'art' / name).read_bytes(), data)
            shipped = {p.relative_to(ui).as_posix(): package_app.digest(p) for p in sorted(ui.rglob('*')) if p.is_file()}
            self.assertIn('art/pages/overview/complete-halo.png', shipped)
            receipt = json.loads((args.output / 'staging-manifest.json').read_text())
            self.assertEqual(receipt['ui_sha256'], hashlib.sha256(json.dumps(shipped, sort_keys=True).encode()).hexdigest())
            self.assertEqual(receipt['ui_art'], dict(files=3, manifest_sha256=package_app.digest(art / 'art-manifest.json')))
            contents = args.output / 'Agentic Complex.app/Contents'
            self.assertEqual((contents / 'Resources/AppIcon.icns').read_bytes(), b'icns')
            self.assertEqual(plistlib.loads((contents / 'Info.plist').read_bytes())['CFBundleIconFile'], 'AppIcon')
            self.assertEqual(plistlib.loads((contents / 'Info.plist').read_bytes())['AgenticComplexBuildFingerprint'], 'sentinel')
            (art / 'common/contour.png').write_bytes(b'tampered')
            args.output = root / 'tampered'
            with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(ValueError, 'UI art hash mismatch: common/contour.png'):
                stage(args)
            self.assertFalse((args.output / 'staging-manifest.json').exists())

    def test_bridge_routes_are_a_shipping_source(self):
        self.assertTrue(shipping_path('protocol/ui-bridge/routes.json'))

    def test_importer_sources_ship_and_other_pipeline_tools_do_not(self):
        for relative in CONTENT_SOURCES + ('characters/agentic_complex_build/mmd/rotation.py',
                                           'characters/agentic_complex_build/motion_import/take.py'):
            self.assertTrue(shipping_path(relative), relative)
        self.assertFalse(shipping_path('characters/agentic_complex_build/assemble.py'))
        self.assertFalse(shipping_path('characters/agentic_complex_build/__init__.py'))

    def test_staged_content_holds_the_importer_and_inserts_no_repo_root(self):
        mmd = package_app.ROOT / 'characters/agentic_complex_build/mmd'
        motion_import = package_app.ROOT / 'characters/agentic_complex_build/motion_import'
        with tempfile.TemporaryDirectory() as tmp:
            content = build_components.stage_content(Path(tmp) / 'runtime/content')
            staged = sorted(p.relative_to(content).as_posix() for p in content.rglob('*') if p.is_file())
            self.assertEqual(staged, sorted(['__init__.py', 'import_vmd.py', 'common.py', 'stance.py', 'native_bundle.py', 'neutral_package.py', 'package_format.py', 'vulkan_outfit.py',
                'import_generated.py', 'secondary_fit.py', 'keys_v2.py', 'live_motion.py', 'style_retarget.py',
                'kimodo_stand_reference.json', 'efmi_mod.py', 'outfit_compose.py', 'import_outfit.py',
                'motion_graph.py', 'motion_families.py', 'pose_family.py',
                'mesh_codec.py', 'efmi_geometry.py', 'mod_settings.py', 'texture_mips.py', 'texture_dhash.py', *('mmd/' + p.name for p in mmd.iterdir() if p.suffix in ('.py', '.json')),
                *('motion_import/' + p.name for p in motion_import.iterdir() if p.suffix in ('.py', '.json'))]))
            self.assertIn('mmd/rotation.py', staged)
            self.assertIn('motion_import/take.py', staged)
            for name in staged:
                text = (content / name).read_text()
                self.assertNotIn('sys.path', text, name)
                self.assertNotIn('__file__', text, name)
            source = (package_app.ROOT / 'characters/packaging/native_bundle.py').read_text()
            self.assertEqual((content / 'native_bundle.py').read_text(), source.replace(build_components.NATIVE_BUNDLE_ROOT, ''))
            # Without numpy the probe stubs it, which still proves the importer's import closure; the artifact smoke imports real numpy.
            probe = '\n'.join([
                'import importlib, importlib.util, json, sys, types',
                'sys.path[:0] = sys.argv[1:4]',
                'names = ["native_bundle", "content.import_vmd"]',
                'if importlib.util.find_spec("numpy"): names += ["content.mmd.retarget", "content.mmd.rig_math", "content.mmd.reference",',
                '    "content.live_motion"]',
                'else: sys.modules["numpy"] = types.ModuleType("numpy")',
                'for name in names: importlib.import_module(name)',
                'print(json.dumps({k: m.__file__ for k, m in sys.modules.items() if getattr(m, "__file__", None)}))'])
            run = subprocess.run([sys.executable, '-I', '-B', '-c', probe, tmp + '/runtime', str(content),
                                  str(package_app.ROOT / 'agent/agentd')], capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            files = json.loads(run.stdout)
            self.assertTrue(Path(files['content.import_vmd']).is_relative_to(content))
            self.assertEqual(Path(files['native_bundle']), content / 'native_bundle.py')
            self.assertEqual(Path(files['character_library']), package_app.ROOT / 'agent/agentd/character_library.py')
            self.assertFalse([f for f in files.values() if Path(f).is_relative_to(package_app.ROOT / 'pipeline')])

    def test_a_library_with_an_imported_appearance_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            library = character_library.Library(Path(tmp) / 'library')
            character_fixture(Path(tmp) / 'source'); library.install(Path(tmp) / 'source')
            catalog = library.root / 'current.json'
            release.check_no_imported_appearance(catalog)
            [package] = library.packages()
            pack = package.root / 'runtime' / package.native_entry['c7']['file']
            doc = json.loads(pack.read_text())
            doc['appearances'].append(dict(id='mod_1a2b3c4d', name='示例外观', kind='imported',
                                           source=dict(format='efmi', fingerprint='0' * 64, imported_at='2026-11-16T00:00:00+00:00')))
            pack.write_text(json.dumps(doc))
            with self.assertRaisesRegex(ValueError, '^release_contains_imported_appearance: fixture/mod_1a2b3c4d$'):
                release.check_no_imported_appearance(catalog)

    def test_staged_motion_import_imports_under_the_content_name(self):
        if importlib.util.find_spec('numpy') is None: self.skipTest('numpy is not installed')
        with tempfile.TemporaryDirectory() as tmp:
            runtime = Path(tmp) / 'runtime'
            content = build_components.stage_content(runtime / 'content')
            modules = sorted((content / 'motion_import').glob('*.py'))
            for path in modules:
                self.assertNotIn('agentic_complex_build', path.read_text(), path.name)
            names = [p.stem for p in modules if p.stem != '__init__']
            self.assertIn('take', names)
            # Same import roots as motion_tool.importer() in the app.
            code = '\n'.join([
                'import importlib, sys',
                'sys.path[:0] = sys.argv[1:4]',
                'for name in sys.argv[4:]: importlib.import_module("content.motion_import." + name)',
                'print("ok")'])
            run = subprocess.run([sys.executable, '-I', '-c', code, str(runtime), str(content),
                                  str(package_app.ROOT / 'agent/agentd')] + names, capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertEqual(run.stdout.splitlines()[-1], 'ok')

    def test_fbx_tool_sources_ship_and_enter_the_fingerprint(self):
        files = source_fingerprint.source_files(package_app.ROOT)
        for name in ('build.sh', 'fbx_motion.c', 'ufbx.c', 'ufbx.h'):
            relative = 'characters/agentic_complex_build/motion_import/native/' + name
            self.assertTrue(shipping_path(relative), relative)
            self.assertIn(relative, files)

    def test_release_builds_the_fbx_tool_with_the_vendored_build_script(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(release.subprocess, 'run') as run:
            tool = release.build_fbx_tool(package_app.ROOT, Path(tmp))
        self.assertEqual(tool, Path(tmp) / 'fbx-motion')
        run.assert_called_once_with(['bash', str(package_app.ROOT / 'characters/agentic_complex_build/motion_import/native/build.sh'),
                                     str(tool)], check=True)
        result = subprocess.run([sys.executable, '-I', str(package_app.ROOT / 'tools/release/package_app.py'), '--help'],
                                capture_output=True, text=True)
        self.assertIn('--fbx-tool', result.stdout)

    def test_stage_fbx_tool_copies_an_executable_and_the_ufbx_license(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = Path(tmp) / 'payload'; service.mkdir()
            build_components.stage_fbx_tool(synthetic_fbx_tool(tmp), service)
            tool = service / 'tools/fbx-motion'
            self.assertTrue(tool.is_file())
            self.assertTrue(os.access(tool, os.X_OK))
            self.assertEqual((service / 'licenses/ufbx').read_bytes(), (package_app.ROOT /
                'characters/agentic_complex_build/motion_import/native/UFBX-LICENSE').read_bytes())

    def test_motion_tool_names_the_shipped_or_the_dev_fbx_tool(self):
        sys.path.insert(0, str(package_app.ROOT / 'agent/agentd'))
        import motion_tool
        sha = hashlib.sha256()
        for name in ('build.sh', 'fbx_motion.c', 'ufbx.c', 'ufbx.h'):
            sha.update((package_app.ROOT / 'characters/agentic_complex_build/motion_import/native' / name).read_bytes())
        dev = package_app.ROOT / 'characters/.build/fbx-motion' / sha.hexdigest()[:16] / 'fbx-motion'
        with tempfile.TemporaryDirectory() as tmp:
            app = Path(tmp) / 'payload'; (app / 'content').mkdir(parents=True); (app / 'content/import_vmd.py').write_text('')
            for agentd, expected in ((motion_tool.AGENTD, dev), (app / 'agentd', app / 'tools/fbx-motion')):
                with self.subTest(agentd=agentd), patch.dict(os.environ), patch.object(sys, 'path', list(sys.path)), \
                        patch.object(motion_tool, 'AGENTD', agentd):
                    os.environ.pop('AAC_FBX_TOOL', None)
                    motion_tool.importer()
                    self.assertEqual(os.environ['AAC_FBX_TOOL'], str(expected))
            with patch.dict(os.environ, {'AAC_FBX_TOOL': '/elsewhere/fbx-motion'}), patch.object(sys, 'path', list(sys.path)):
                motion_tool.importer()
                self.assertEqual(os.environ['AAC_FBX_TOOL'], '/elsewhere/fbx-motion')

    def test_missing_or_invalid_guard_rejects_staging_before_creating_output(self):
        valid_hash = '0123456789abcdef'
        cases = [None, '{', '[]', json.dumps({'n': 7, 'hashes': []}),
                 json.dumps({'n': 8, 'hashes': [valid_hash]}),
                 json.dumps({'n': True, 'hashes': [valid_hash]}),
                 json.dumps({'n': '7', 'hashes': [valid_hash]}),
                 json.dumps({'n': 7, 'hashes': valid_hash}),
                 json.dumps({'n': 7, 'hashes': [valid_hash, 123]}),
                 json.dumps({'n': 7, 'hashes': [valid_hash.upper()]}),
                 json.dumps({'n': 7, 'hashes': [valid_hash[:-1]]})]
        with tempfile.TemporaryDirectory() as tmp, patch.object(package_app, 'ROOT', Path(tmp)):
            path = Path(tmp) / 'agent/agentd/brain/canon-windows.json'
            path.parent.mkdir(parents=True)
            for index, content in enumerate(cases):
                with self.subTest(case=index):
                    if content is not None:
                        path.write_text(content)
                    out = Path(tmp) / f'output-{index}'
                    with self.assertRaisesRegex(ValueError, 'Invalid bundled outbound guard'):
                        stage(SimpleNamespace(output=out))
                    self.assertFalse(out.exists())


class PortableComponentStageTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(contextlib.redirect_stdout(io.StringIO()))
        self.sign = self.enterContext(patch.object(package_app, 'sign_payload', create=True))
        self.strip = self.enterContext(patch.object(package_app, 'strip_local_symbols'))
        binaries = self.root / 'binaries'; binaries.mkdir()
        (binaries / 'metal-avatar-host').write_bytes(b'synthetic executable'); (binaries / 'metal-avatar-host').chmod(0o755)
        python = self.root / 'python'; (python / 'bin').mkdir(parents=True)
        (python / 'bin/python3.12').write_text('#!/bin/sh\nprintf "3.12.99\\n"\n')
        (python / 'bin/python3.12').chmod(0o751)
        (python / 'bin/python3').symlink_to('python3.12')
        web = self.root / 'web'; web.mkdir(); (web / 'main.html').write_text('synthetic web')
        art = self.root / 'art'; (art / 'brand').mkdir(parents=True)
        (art / 'brand/AppIcon.icns').write_bytes(b'icon')
        (art / 'art-manifest.json').write_text(json.dumps(dict(files=[
            dict(file='brand/AppIcon.icns', sha256=package_app.digest(art / 'brand/AppIcon.icns'))])))
        library = self.root / 'library'
        packages = []
        for id in ['aaa', 'fixture']:
            payload = library / 'selected' / id
            character_fixture(payload, id)
            packages.append(package_app.Package(payload))
        self.catalog = package_app.Library(library).publish(packages, default='fixture')
        self.args = SimpleNamespace(output=self.root / 'out',
            library=library,
            id='local.agenticcomplex.components-test', port=19123,
            python=python, harness_runtime=prepared_fixture(self.root / 'harness'),
            host=binaries / 'metal-avatar-host', build_version='20261106.5', web_dist=web, ui_art=art,
            fbx_tool=synthetic_fbx_tool(binaries), **electron_fields(self, binaries))
        self.contents = self.args.output / 'Agentic Complex.app/Contents'
        self.resources = self.contents / 'Resources'
        self.components = self.resources / 'components'
        self.character_ids = {'characters.' + row['id'] for row in self.catalog['characters']}
        self.payload_ids = {'runtime.python', 'agentd', 'web-ui', 'harness.pi'} | self.character_ids

    def test_stage_ignores_developer_site_packages(self):
        site = self.root / 'developer-site'
        site.mkdir()
        (site / 'local-startup.pth').write_text('# developer environment')
        self.args.site_packages = site
        stage(self.args)
        runtime = self.components / 'runtime.python/payload/lib/python3.12/site-packages'
        self.assertFalse((runtime / 'local-startup.pth').exists(), 'staged developer startup file')

    def test_portable_embeds_every_character_component_in_the_lock(self):
        stage(self.args)
        lock = json.loads((self.resources / 'composition.lock.json').read_text())
        self.assertEqual({ref['id'] for ref in lock['components'] if ref['id'].startswith('characters.')}, self.character_ids)
        for row in self.catalog['characters']:
            payload = self.components / ('characters.' + row['id']) / 'payload'
            self.assertEqual((payload / 'character.json').read_bytes(),
                             (self.args.library / row['definition']['file']).read_bytes())
        self.assertFalse((self.resources / 'characters').exists())
        self.assertFalse((self.args.output / 'resource-materialization.json').exists())

    def test_staging_receipt_accepts_text_only_sample_without_ui_component(self):
        self.args.library = package_app.ROOT / 'characters/sample-library'
        stage(self.args)
        receipt = json.loads((self.args.output / 'staging-manifest.json').read_text())
        self.assertEqual([character['id'] for character in receipt['characters']], ['aide'])
        self.assertFalse(receipt['characters'][0]['portrait'])

    def test_an_empty_library_stages_no_character_and_an_empty_seed(self):
        (self.args.python / 'bin/python3.12').write_text('#!/bin/sh\nexec "' + sys.executable + '" "$@"\n')
        self.args.library = self.root / 'empty'; self.args.library.mkdir()
        stage(self.args)
        lock = json.loads((self.resources / 'composition.lock.json').read_text())
        self.assertFalse([ref['id'] for ref in lock['components'] if ref['id'].startswith('characters.')])
        receipt = json.loads((self.args.output / 'staging-manifest.json').read_text())
        self.assertEqual(receipt['characters'], [])
        distribution = json.loads((self.resources / 'distribution.json').read_text())
        self.assertIsNone(distribution['defaultCharacter'])
        python = self.components / 'runtime.python'
        agentd = self.components / 'agentd'
        python_entry = json.loads((python / 'component.json').read_text())['entrypoints']['python']
        tool_entry = json.loads((agentd / 'component.json').read_text())['entrypoints']['character_tool']
        composed = self.root / 'composed'
        result = subprocess.run([str(python / 'payload' / python_entry), str(agentd / 'payload' / tool_entry), 'compose',
                                 '--output', str(composed)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(distribution['catalogSHA256'], hashlib.sha256((composed / 'current.json').read_bytes()).hexdigest())
        self.assertEqual(json.loads((composed / 'current.json').read_text())['characters'], [])

    def test_distribution_v3_catalog_matches_compose_on_shipped_payloads(self):
        (self.args.python / 'bin/python3.12').write_text('#!/bin/sh\nexec "' + sys.executable + '" "$@"\n')
        stage(self.args)
        distribution = json.loads((self.resources / 'distribution.json').read_text())
        self.assertEqual(distribution['schema'], 'endfield-distribution/v3')
        python = self.components / 'runtime.python'
        agentd = self.components / 'agentd'
        python_entry = json.loads((python / 'component.json').read_text())['entrypoints']['python']
        tool_entry = json.loads((agentd / 'component.json').read_text())['entrypoints']['character_tool']
        composed = self.root / 'composed'
        command = [str(python / 'payload' / python_entry), str(agentd / 'payload' / tool_entry), 'compose',
                   '--default', self.catalog['default_character'], '--output', str(composed)]
        for id in sorted(self.character_ids): command += ['--package', str(self.components / id / 'payload')]
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        sha = hashlib.sha256((composed / 'current.json').read_bytes()).hexdigest()
        self.assertNotEqual(sha, package_app.digest(self.args.library / 'current.json'))
        self.assertEqual(distribution, dict(schema='endfield-distribution/v3', id=self.args.id,
            layout='portable', port=self.args.port, catalogSHA256=sha, defaultCharacter=self.catalog['default_character']))
        snapshot = json.loads((composed / 'current.json').read_text())
        self.assertTrue((composed / snapshot['native_bundle']['file']).is_file())
        self.assertEqual({row['id'] for row in snapshot['characters']}, {'aaa', 'fixture'})
        for row in snapshot['characters']:
            self.assertTrue((composed / 'packages' / row['id'] / row['definition']['sha256'] / 'character.json').is_file())

    def test_split_host_refuses_substituted_and_damaged_runtimes(self):
        self.args.layout = 'split'
        stage(self.args)
        external = self.args.output / 'components'
        index = external / 'index.json'
        original = index.read_bytes()
        def launch(support=self.root / 'support'):
            script = """import {prepareComponents} from './app/electron/src/main/components.ts';
const [resources, support] = process.argv.slice(1);
console.log(JSON.stringify(prepareComponents({resources, support, layout:'split', platform:'mac'})));"""
            return subprocess.run([NODE, '--input-type=module', '-e', script, str(self.resources), str(support)],
                                  cwd=package_app.ROOT, capture_output=True, text=True)
        good = launch()
        self.assertEqual(good.returncode, 0, good.stderr)
        python = Path(json.loads(good.stdout)['python'])
        doc = json.loads(original)
        ref = next(ref for ref in doc['components'] if ref['id'] == 'runtime.python')
        source = external / ref['dir']
        (source / 'payload/bin/agentic-complex-python').write_text('replacement')
        manifest = json.loads((source / 'component.json').read_text())
        ref['tree_sha256'], manifest['files'], manifest['bytes'] = component_manifest._tree(source / 'payload')
        manifest['tree_sha256'] = ref['tree_sha256']
        (source / 'component.json').write_text(json.dumps(manifest))
        ref['manifest_sha256'] = package_app.digest(source / 'component.json')
        index.write_text(json.dumps(doc))
        with self.subTest('substitution'):
            self.assertNotEqual(launch(self.root / 'fresh-support').returncode, 0, 'host accepted a replacement distribution')
        shutil.rmtree(external)
        cache = python.parent / '__pycache__'
        cache.mkdir()
        (cache / 'unsealed.pyc').write_bytes(b'cache')
        with self.subTest('unsealed bytecode'):
            self.assertIsNone(json.loads(launch().stdout)['python'], 'accepted a bytecode cache outside the signed tree')
        shutil.rmtree(cache)
        python.write_text('damaged')
        offline = launch()
        self.assertEqual(offline.returncode, 0, offline.stderr)
        self.assertIsNone(json.loads(offline.stdout)['python'], 'host accepted a damaged installed runtime')

    def test_split_app_seals_the_external_index(self):
        self.args.layout = 'split'
        stage(self.args)
        signed = self.resources / 'components-index.json'
        self.assertTrue(signed.is_file(), 'split app has no sealed component identities')
        self.assertEqual(signed.read_bytes(), (self.args.output / 'components/index.json').read_bytes())
        for ref in json.loads(signed.read_bytes())['components']:
            manifest = self.args.output / 'components' / ref['dir'] / 'component.json'
            self.assertEqual(ref['manifest_sha256'], package_app.digest(manifest))

    def test_split_keeps_only_fixed_components_and_web_ui_and_writes_valid_index(self):
        self.args.layout = 'split'
        stage(self.args)
        self.assertEqual({p.name for p in self.components.iterdir()}, {'host', 'renderer', 'web-ui'})
        self.assertFalse((self.resources / 'composition.lock.json').exists())
        self.assertFalse((self.resources / 'characters').exists())
        self.assertEqual(json.loads((self.resources / 'distribution.json').read_text())['layout'], 'split')
        external = self.args.output / 'components'
        index_path = external / 'index.json'
        result = subprocess.run(['python3', '-I', str(package_app.ROOT / 'protocol/C11-components/validate.py'),
                                 str(index_path)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        index = json.loads(index_path.read_text())
        self.assertEqual({ref['id'] for ref in index['components']}, self.payload_ids - {'web-ui'})
        self.assertEqual({p.name for p in external.iterdir()}, (self.payload_ids - {'web-ui'}) | {'index.json'})
        for ref in index['components']:
            directory = external / ref['dir']
            self.assertEqual({p.name for p in directory.iterdir()}, {'component.json', 'payload'})
            manifest = json.loads((directory / 'component.json').read_text())
            self.assertEqual(ref, dict({key: manifest[key] for key in ('id', 'version', 'tree_sha256')}, dir=manifest['id'],
                manifest_sha256=package_app.digest(directory / 'component.json')))
            self.assertEqual(component_manifest.tree_sha256(directory / 'payload'), ref['tree_sha256'])
        receipt = json.loads((self.args.output / 'staging-manifest.json').read_text())
        self.assertEqual(receipt['layout'], 'split')
        self.assertFalse(receipt['self_contained_runtime'])
        host = json.loads((self.components / 'host/component.json').read_text())
        self.assertEqual(receipt['host'], {key: host[key] for key in ('id', 'version', 'tree_sha256')})
        references = {ref['id']: ref for ref in receipt['components']}
        self.assertEqual(set(references), self.payload_ids | {'renderer'})
        for id, ref in references.items():
            directory = self.components / id if id in {'renderer', 'web-ui'} else external / id
            manifest = json.loads((directory / 'component.json').read_text())
            self.assertEqual(ref, dict({key: manifest[key] for key in ('id', 'version', 'tree_sha256')},
                placement='bundle' if id in {'renderer', 'web-ui'} else 'support'))
        self.assertEqual({p.name for p in self.args.output.iterdir()},
                         {'Agentic Complex.app', 'components', 'source-manifest.json', 'staging-manifest.json'})

    def test_split_components_match_portable_manifest_bytes_and_payload_hashes(self):
        stage(self.args)
        self.args.layout = 'split'; self.args.output = self.root / 'split'
        stage(self.args)
        split_contents = self.args.output / 'Agentic Complex.app/Contents'
        for directory in sorted(self.components.iterdir()):
            with self.subTest(component=directory.name):
                split = (split_contents / 'Resources/components' if directory.name in {'host', 'renderer', 'web-ui'}
                         else self.args.output / 'components') / directory.name
                self.assertTrue(split.is_dir(), 'split component missing: ' + directory.name)
                self.assertEqual((directory / 'component.json').read_bytes(), (split / 'component.json').read_bytes())
                doc = json.loads((directory / 'component.json').read_text())
                payloads = [directory / 'payload', split / 'payload']
                if 'placed' in doc:
                    payloads = []
                    for layout, contents in [('portable', self.contents), ('split', split_contents)]:
                        payload = self.root / (layout + '-' + directory.name); payload.mkdir()
                        for relative, target in doc['placed'].items():
                            source = contents / target; destination = payload / relative
                            destination.parent.mkdir(parents=True, exist_ok=True)
                            if source.is_dir(): shutil.copytree(source, destination, symlinks=True)
                            else: shutil.copy2(source, destination, follow_symlinks=False)
                        payloads.append(payload)
                for payload in payloads: self.assertEqual(component_manifest.tree_sha256(payload), doc['tree_sha256'])

    def test_component_manifests_cover_payloads_and_fixed_placements(self):
        stage(self.args)
        self.assertTrue(self.components.is_dir(), 'portable app must contain C11 components')
        self.assertEqual({p.name for p in self.components.iterdir()}, self.payload_ids | {'host', 'renderer'})
        placements = {
            'host': ['MacOS/AgenticComplex', 'MacOS/ac-helper', 'Frameworks', 'Info.plist', 'PkgInfo', 'Resources/app',
                     'Resources/en.lproj', 'Resources/parent_watch.py', 'Resources/AppIcon.icns'],
            'renderer': ['MacOS/AgenticComplexMetalAvatar']}
        for directory in sorted(self.components.iterdir()):
            with self.subTest(component=directory.name):
                self.assertTrue((directory / 'component.json').is_file())
                doc = json.loads((directory / 'component.json').read_text())
                self.assertEqual(doc['id'], directory.name)
                payload = directory / 'payload'
                if directory.name in placements:
                    self.assertFalse(payload.exists())
                    self.assertEqual(doc['placed'], {p: p for p in placements[directory.name]})
                    self.assertEqual(doc['version'], self.args.build_version)
                    self.assertEqual(doc['entrypoints'], {'executable': placements[directory.name][0]})
                    self.assertEqual(doc['requires'], {'C6': '1', 'C9': '1'} if directory.name == 'host' else {})
                    payload = self.root / ('unplaced-' + directory.name); payload.mkdir()
                    for relative, target in doc['placed'].items():
                        source = self.contents / target
                        self.assertTrue(source.exists(), target)
                        destination = payload / relative; destination.parent.mkdir(parents=True, exist_ok=True)
                        if source.is_dir(): shutil.copytree(source, destination, symlinks=True)
                        else: shutil.copy2(source, destination, follow_symlinks=False)
                else:
                    self.assertTrue(payload.is_dir())
                    self.assertNotIn('placed', doc)
                self.assertEqual(component_manifest.tree_sha256(payload), doc['tree_sha256'])
                self.assertEqual(component_manifest._tree(payload)[1:], (doc['files'], doc['bytes']))
                for relative in doc['entrypoints'].values(): self.assertTrue((payload / relative).is_file())
        python = self.components / 'runtime.python/payload/bin'
        self.assertTrue((python / 'python3').is_symlink())
        self.assertEqual((python / 'python3').readlink(), Path('python3.12'))
        self.assertEqual((python / 'python3.12').stat().st_mode & 0o777, 0o751)
        self.assertTrue((python / 'agentic-complex-python').stat().st_mode & 0o111)
        source = json.loads((self.args.output / 'source-manifest.json').read_text())
        info = plistlib.loads((self.contents / 'Info.plist').read_bytes())
        self.assertEqual(info['AgenticComplexBuildFingerprint'], source['fingerprint'])
        self.assertEqual(info['NSSpeechRecognitionUsageDescription'], '按住说话时在本机把语音转成文字。')
        self.assertFalse((self.resources / 'characters').exists())

    def test_content_overrides_land_in_their_components_before_signing_and_placement(self):
        local = self.root / 'local'; local.mkdir()
        guard = local / 'canon-windows.json'; guard.write_text(json.dumps(dict(n=7, hashes=['0123456789abcdef'])))
        envelopes = local / 'window-envelopes.json'; envelopes.write_text('{"schema": "endfield-window-envelopes/v1"}')
        hints = local / 'efmi-slot-hints.json'; hints.write_text('{}')
        self.args.content_override = ['agentd/agentd/brain/canon-windows.json=' + str(guard),
            'agentd/content/efmi-slot-hints.json=' + str(hints), 'renderer/Resources/window-envelopes.json=' + str(envelopes)]
        signed = []
        self.sign.side_effect = lambda payload: signed.append({p.name: p.read_bytes() for p in payload.rglob('*.json')})
        stage(self.args)
        service = self.components / 'agentd/payload'
        self.assertEqual((service / 'agentd/brain/canon-windows.json').read_bytes(), guard.read_bytes())
        self.assertEqual((service / 'content/efmi-slot-hints.json').read_bytes(), b'{}')
        self.assertTrue(any(files.get('canon-windows.json') == guard.read_bytes() for files in signed))
        self.assertEqual((self.resources / 'window-envelopes.json').read_bytes(), envelopes.read_bytes())
        placed = list(json.loads((self.components / 'renderer/component.json').read_text())['placed'])
        self.assertEqual(placed[:2], ['MacOS/AgenticComplexMetalAvatar', 'Resources/window-envelopes.json'])
        self.args.output = self.root / 'bad-guard'
        guard.write_text('{}')
        with self.assertRaisesRegex(ValueError, 'Invalid bundled outbound guard'):
            stage(self.args)
        self.args.output = self.root / 'escaping'
        self.args.content_override = ['renderer/../host/payload/x.json=' + str(hints)]
        with self.assertRaisesRegex(ValueError, 'content_override_outside_component'):
            stage(self.args)

    def test_agentd_names_the_fbx_tool_and_it_is_staged_before_the_manifests(self):
        write_manifests = build_components.write_manifests
        def checked(stage_dir, components):
            agentd = next(c for c in components if c['id'] == 'agentd')
            self.assertEqual(agentd['entrypoints']['fbx_tool'], 'tools/fbx-motion')
            self.assertTrue(os.access(Path(stage_dir) / 'agentd/payload/tools/fbx-motion', os.X_OK))
            return write_manifests(stage_dir, components)
        with patch.object(build_components, 'write_manifests', side_effect=checked) as called:
            stage(self.args)
        called.assert_called_once()
        payload = self.components / 'agentd/payload'
        self.assertEqual((payload / 'tools/fbx-motion').read_bytes(), self.args.fbx_tool.read_bytes())
        self.assertTrue((payload / 'licenses/ufbx').is_file())

    def test_portable_lock_and_all_manifests_pass_c11_validator(self):
        stage(self.args)
        lock_path = self.resources / 'composition.lock.json'
        manifests = sorted(self.components.glob('*/component.json'))
        result = subprocess.run(['python3', '-I', str(package_app.ROOT / 'protocol/C11-components/validate.py'),
                                 str(lock_path), *(str(path) for path in manifests)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        lock = json.loads(lock_path.read_text())
        self.assertEqual(lock['edition'], 'portable')
        self.assertEqual(lock['host']['id'], 'host')
        self.assertEqual({ref['id'] for ref in lock['components']}, self.payload_ids | {'renderer'})
        self.assertTrue(all(ref['placement'] == 'bundle' for ref in lock['components']))
        receipt = json.loads((self.args.output / 'staging-manifest.json').read_text())
        self.assertEqual(receipt['layout'], 'portable')
        self.assertEqual(receipt['host'], lock['host'])
        self.assertEqual(receipt['components'], lock['components'])

    def test_signs_each_payload_once_before_any_manifest_and_hashes_signed_bytes(self):
        def signed(payload):
            self.assertEqual(payload.name, 'payload')
            self.assertIn(payload.parent.name, self.payload_ids)
            self.assertEqual(list(payload.parent.parent.rglob('component.json')), [])
            self.assertEqual(list(self.components.rglob('component.json')), [])
            (payload / 'signed').write_bytes(b'synthetic signature')
            (payload / 'signed').chmod(0o751)
        self.sign.side_effect = signed
        stage(self.args)
        self.assertEqual(self.sign.call_count, len(self.payload_ids), 'sign each payload exactly once')
        self.assertEqual({call.args[0].parent.name for call in self.sign.call_args_list}, self.payload_ids)
        for id in self.payload_ids:
            payload = self.components / id / 'payload'
            self.assertEqual((payload / 'signed').read_bytes(), b'synthetic signature')
            self.assertEqual((payload / 'signed').stat().st_mode & 0o777, 0o751)
            doc = json.loads((payload.parent / 'component.json').read_text())
            self.assertEqual(doc['tree_sha256'], component_manifest.tree_sha256(payload))
        self.assertTrue(all(not call.args[0].exists() for call in self.sign.call_args_list))

    def test_no_stage_directory_remains(self):
        stage(self.args)
        self.assertEqual({p.name for p in self.args.output.iterdir()},
                         {'Agentic Complex.app', 'source-manifest.json', 'staging-manifest.json'})


ELECTRON_ID = 'com.github.Electron'
# Synthetic helper ids; the host keeps whatever Electron appends to its own id.
ELECTRON_HELPERS = {'Electron Helper': '.helper', 'Electron Helper (GPU)': '.helper.GPU',
                    'Electron Helper (Renderer)': '.helper.Renderer', 'Electron Helper (Plugin)': '.helper.Plugin'}


def synthetic_electron_app(directory):
    """The official Electron.app in miniature: the main plist keys the host rewrites, framework links, four helper apps."""
    contents = Path(directory) / 'Electron.app/Contents'
    def write(relative, data, mode=0o644):
        path = contents / relative; path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data); path.chmod(mode)
    write('MacOS/Electron', b'synthetic electron', 0o755)
    write('PkgInfo', b'APPL????')
    write('Resources/default_app.asar', b'synthetic default app')
    write('Resources/electron.icns', b'synthetic electron icon')
    write('Resources/en.lproj/locale.pak', b'synthetic locale')
    framework = contents / 'Frameworks/Electron Framework.framework'
    write('Frameworks/Electron Framework.framework/Versions/A/Electron Framework', b'synthetic library', 0o755)
    write('Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist',
          plistlib.dumps(dict(CFBundleIdentifier=ELECTRON_ID + '.framework')))
    (framework / 'Versions/Current').symlink_to('A')
    (framework / 'Electron Framework').symlink_to('Versions/Current/Electron Framework')
    (framework / 'Resources').symlink_to('Versions/Current/Resources')
    for name, suffix in ELECTRON_HELPERS.items():
        write(f'Frameworks/{name}.app/Contents/MacOS/{name}', b'synthetic helper', 0o755)
        write(f'Frameworks/{name}.app/Contents/Info.plist', plistlib.dumps(dict(
            CFBundleIdentifier=ELECTRON_ID + suffix, CFBundleExecutable=name, CFBundleName=name, CFBundlePackageType='APPL')))
    write('Info.plist', plistlib.dumps(dict(CFBundleDisplayName='Electron', CFBundleExecutable='Electron',
        CFBundleIconFile='electron.icns', CFBundleIdentifier=ELECTRON_ID, CFBundleName='Electron', CFBundlePackageType='APPL',
        CFBundleShortVersionString='45.4.1', CFBundleVersion='45.4.1', LSMinimumSystemVersion='12.0',
        LSEnvironment=dict(MallocNanoZone='0'), NSMainNibFile='MainMenu', NSPrincipalClass='AtomApplication',
        NSHighResolutionCapable=True, NSSupportsAutomaticGraphicsSwitching=True,
        NSCameraUsageDescription='This app needs access to the camera',
        NSMicrophoneUsageDescription='This app needs access to the microphone',
        NSBluetoothAlwaysUsageDescription='This app needs access to Bluetooth',
        NSBluetoothPeripheralUsageDescription='This app needs access to Bluetooth',
        NSAudioCaptureUsageDescription='This app needs access to audio capture',
        ElectronAsarIntegrity={'Resources/default_app.asar': dict(algorithm='SHA256', hash='0' * 64)})))
    return contents.parent


def synthetic_electron_dir(directory):
    """app/electron after `npm run build`: package.json and dist/ with a source map that stays out of the app."""
    electron = Path(directory) / 'electron'
    for relative in ['dist/main.mjs', 'dist/main.mjs.map', 'dist/preload.cjs', 'dist/native/preview.node']:
        (electron / relative).parent.mkdir(parents=True, exist_ok=True)
        (electron / relative).write_text('synthetic ' + relative)
    (electron / 'package.json').write_text(json.dumps(dict(name='agentic-complex-electron', version='0.0.0', private=True,
        type='module', main='dist/main.mjs', scripts=dict(build='node build.mjs'), devDependencies=dict(electron='45.4.1'))))
    return electron


class ElectronHostStageTests(unittest.TestCase):
    setUp = PortableComponentStageTests.setUp

    def test_host_manifest_and_lock_hash_the_fused_framework(self):
        stage(self.args)
        host = json.loads((self.components / 'host/component.json').read_text())
        payload = self.root / 'unsigned-host'
        for source, placed in host['placed'].items():
            path = self.contents / placed
            target = payload / source
            target.parent.mkdir(parents=True, exist_ok=True)
            if path.is_dir(): shutil.copytree(path, target, symlinks=True)
            else: shutil.copy2(path, target)
        framework = 'Frameworks/Electron Framework.framework/Electron Framework'
        (payload / framework).write_bytes(b'fused')
        expected = component_manifest.tree_sha256(payload)
        lock = json.loads((self.resources / 'composition.lock.json').read_text())
        self.assertEqual(host['tree_sha256'], expected)
        self.assertEqual(lock['host']['tree_sha256'], expected)
        self.assertEqual((self.contents / framework).read_bytes(), b'fused')
        self.assertEqual((self.args.electron_app / 'Contents' / framework).read_bytes(), b'synthetic library')

    def test_electron_host_layout_takes_the_locked_app_the_main_process_and_the_helper(self):
        stage(self.args)
        contents = self.contents
        self.assertEqual(sorted(p.name for p in (contents / 'MacOS').iterdir()),
                         ['AgenticComplex', 'AgenticComplexMetalAvatar', 'ac-helper'])
        self.assertEqual((contents / 'MacOS/AgenticComplex').read_bytes(), b'synthetic electron')
        self.assertTrue(os.access(contents / 'MacOS/AgenticComplex', os.X_OK))
        self.assertEqual((contents / 'MacOS/ac-helper').read_bytes(), b'synthetic helper tool')
        # The TTS tunnel's watcher, which the shell runs from the app's Resources.
        self.assertEqual((contents / 'Resources/parent_watch.py').read_bytes(), (package_app.ROOT / 'app/Resources/parent_watch.py').read_bytes())
        self.assertTrue(os.access(contents / 'MacOS/ac-helper', os.X_OK))
        app = self.resources / 'app'
        self.assertEqual(sorted(p.relative_to(app).as_posix() for p in app.rglob('*') if p.is_file()),
                         ['dist/main.mjs', 'dist/native/preview.node', 'dist/preload.cjs', 'package.json'])
        self.assertEqual(json.loads((app / 'package.json').read_text()), dict(name='agentic-complex-electron',
            productName='Agentic Complex', version='0.3.0', private=True, type='module', main='dist/main.mjs'))
        for dropped in ['default_app.asar', 'electron.icns']: self.assertFalse((self.resources / dropped).exists(), dropped)
        self.assertEqual((self.resources / 'AppIcon.icns').read_bytes(), b'icon')
        self.assertTrue((self.resources / 'en.lproj/locale.pak').is_file())
        self.assertEqual((contents / 'PkgInfo').read_bytes(), b'APPL????')
        framework = contents / 'Frameworks/Electron Framework.framework'
        self.assertEqual(os.readlink(framework / 'Versions/Current'), 'A')
        self.assertEqual(os.readlink(framework / 'Electron Framework'), 'Versions/Current/Electron Framework')
        helpers = {p.name: plistlib.loads((p / 'Contents/Info.plist').read_bytes())['CFBundleIdentifier']
                   for p in (contents / 'Frameworks').glob('*.app')}
        self.assertEqual(helpers, {name + '.app': self.args.id + suffix for name, suffix in ELECTRON_HELPERS.items()})
        self.assertFalse((contents / 'XPCServices').exists())
        host = json.loads((self.components / 'host/component.json').read_text())
        self.assertEqual(host['entrypoints'], {'executable': 'MacOS/AgenticComplex'})
        self.assertEqual(list(host['placed']), ['MacOS/AgenticComplex', 'MacOS/ac-helper', 'Frameworks', 'Info.plist', 'PkgInfo',
                                                'Resources/app', 'Resources/en.lproj', 'Resources/parent_watch.py', 'Resources/AppIcon.icns'])
        self.assertEqual(host['placed'], {path: path for path in host['placed']})
        receipt = json.loads((self.args.output / 'staging-manifest.json').read_text())
        self.assertEqual(receipt['companion_sha256'], package_app.digest(contents / 'MacOS/AgenticComplex'))

    def test_only_the_kept_languages_and_stripped_binaries_are_staged(self):
        framework = 'Frameworks/Electron Framework.framework/Versions/A/Resources/'
        kept = ['Resources/zh_CN.lproj', 'Resources/ja.lproj', framework + 'en.lproj', framework + 'zh_TW_FEMININE.lproj']
        dropped = ['Resources/de.lproj', 'Resources/en_GB.lproj', framework + 'de.lproj', framework + 'en_GB_NEUTER.lproj', framework + 'fr_MASCULINE.lproj']
        for relative in kept + dropped:
            path = self.args.electron_app / 'Contents' / relative / 'locale.pak'
            path.parent.mkdir(parents=True); path.write_bytes(b'synthetic locale')
        staged = []
        self.strip.side_effect = lambda binary: (staged.append(Path(binary).name), Path(binary).write_bytes(b'stripped'))
        stage(self.args)
        for relative in kept + ['Resources/en.lproj']: self.assertTrue((self.contents / relative / 'locale.pak').is_file(), relative)
        for relative in dropped: self.assertFalse((self.contents / relative).exists(), relative)
        self.assertEqual(sorted(staged), ['AgenticComplexMetalAvatar', 'ac-helper', 'node'])
        for binary in (self.contents / 'MacOS/AgenticComplexMetalAvatar', self.contents / 'MacOS/ac-helper',
                       self.components / 'harness.pi/payload/node/bin/node'):
            self.assertEqual(binary.read_bytes(), b'stripped', binary)
        self.assertEqual(self.args.host.read_bytes(), b'synthetic executable')

    def test_electron_info_plist_is_the_host_identity_without_electron_defaults(self):
        stage(self.args)
        info = plistlib.loads((self.contents / 'Info.plist').read_bytes())
        source = json.loads((self.args.output / 'source-manifest.json').read_text())
        self.assertEqual({key: info[key] for key in ['CFBundleIdentifier', 'CFBundleName', 'CFBundleDisplayName', 'CFBundleExecutable',
                'CFBundleIconFile', 'CFBundlePackageType', 'CFBundleShortVersionString', 'CFBundleVersion', 'LSMinimumSystemVersion',
                'LSUIElement', 'AgenticComplexBuildFingerprint']},
            dict(CFBundleIdentifier=self.args.id, CFBundleName='Agentic Complex', CFBundleDisplayName='Agentic Complex',
                 CFBundleExecutable='AgenticComplex', CFBundleIconFile='AppIcon', CFBundlePackageType='APPL',
                 CFBundleShortVersionString='0.3.0', CFBundleVersion=self.args.build_version, LSMinimumSystemVersion='15.0',
                 LSUIElement=True, AgenticComplexBuildFingerprint=source['fingerprint']))
        self.assertEqual({key: value for key, value in info.items() if key.endswith('UsageDescription')},
                         dict(NSAppleEventsUsageDescription='按设置读取前台浏览器域名或跳转会话。',
                              NSMicrophoneUsageDescription='按住说话时将语音转为文字。',
                              NSSpeechRecognitionUsageDescription='按住说话时在本机把语音转成文字。'))
        self.assertNotIn('ElectronAsarIntegrity', info)
        for kept in ['NSPrincipalClass', 'NSMainNibFile', 'LSEnvironment', 'NSHighResolutionCapable']:
            self.assertIn(kept, info)
        self.args.output = self.root / 'no-art'; self.args.ui_art = None
        stage(self.args)
        self.assertNotIn('CFBundleIconFile', plistlib.loads((self.args.output / 'Agentic Complex.app/Contents/Info.plist').read_bytes()))

    def test_electron_host_defaults_the_product_name_and_version(self):
        self.args.product_name = self.args.app_version = None
        stage(self.args)
        package = json.loads((self.resources / 'app/package.json').read_text())
        self.assertEqual((package['productName'], package['version']), ('Agentic Complex', '0.2.0'))
        self.assertEqual(plistlib.loads((self.contents / 'Info.plist').read_bytes())['CFBundleShortVersionString'], '0.2.0')

    def test_a_helper_id_outside_electrons_own_is_refused(self):
        plist = self.args.electron_app / 'Contents/Frameworks/Electron Helper (GPU).app/Contents/Info.plist'
        plist.write_bytes(plistlib.dumps(dict(CFBundleIdentifier='org.example.gpu')))
        with self.assertRaisesRegex(ValueError, '^electron_helper_id_unexpected: org.example.gpu$'):
            stage(self.args)
        self.assertFalse((self.args.output / 'staging-manifest.json').exists())

    def test_electron_portable_and_split_pass_c11_and_compare_same(self):
        stage(self.args)
        portable = self.args.output
        result = subprocess.run(['python3', '-I', str(package_app.ROOT / 'protocol/C11-components/validate.py'),
                                 str(self.resources / 'composition.lock.json'),
                                 *map(str, sorted(self.components.glob('*/component.json')))], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.args.layout = 'split'; self.args.output = self.root / 'split'
        stage(self.args)
        split = self.args.output / 'Agentic Complex.app/Contents/Resources/components'
        self.assertEqual({p.name for p in split.iterdir()}, {'host', 'renderer', 'web-ui'})
        result = subprocess.run([sys.executable, '-I', str(package_app.ROOT / 'tools/release/compare_layouts.py'),
                                 '--portable', str(portable), '--split', str(self.args.output)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('host: same', result.stdout.splitlines())
        self.assertEqual(result.stdout.splitlines()[-1], 'LAYOUTS SAME')
