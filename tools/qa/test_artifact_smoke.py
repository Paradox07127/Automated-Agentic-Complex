"""artifact_smoke.py against an ad-hoc signed stub .app; no real Companion is launched."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'release'))
import artifact_smoke
import component_manifest

F = 'F' * 64
ROOT = Path(__file__).resolve().parents[2]
LIBRARY = ROOT / 'protocol/character-library/fixtures/library'
# Its default character is text-only: the app starts no renderer for it.
TEXT_LIBRARY = ROOT / 'characters/sample-library'
# Stands in for Companion: logs as Companion does, starts the bundle's agentd and handles SIGTERM.
STUB = r'''#!/bin/bash
cfg=$2
# The Electron shell starts only on a temporary --config and without push-to-talk and attention.
[ "$*" = "--config $cfg --no-push-to-talk --no-attention" ] || exit 1
get() { /usr/bin/plutil -extract "$1" raw -o - "$cfg"; }
support=$(get support_dir); state=$(get agentd_state_dir); port=$(get agentd_port); py=$(get python); launcher=$(get agentd_launcher)
mkdir -p "$support/logs"; log=$support/logs/companion.starting
say() { echo "$(date +%FT%T) pid=$$ $1" >> "$log"; }
say "companion: STARTED pid=$$ app=$0 config=$cfg"
"$py" "$launcher" --port "$port" --state-dir "$state" & child=$!
echo "$child $py ${launcher%/*}/agentd/server.py --port $port --state-dir $state" > "$support/stub-processes"
trap '@REAP@ exit 0' TERM
@READY@
say "supervisor: STATUS agentd=running"
echo "AAC_WINDOW envelope=bundle character=voice_a" > "$support/logs/avatar.log"
@HELLO@
mv "$log" "$support/logs/companion.log"; log=$support/logs/companion.log
while :; do sleep 0.1; done
'''
SERVER = '''import argparse, http.server, json
p = argparse.ArgumentParser(); p.add_argument('--port', type=int); p.add_argument('--state-dir'); a = p.parse_args()
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({'status': 'ok'}).encode(); self.send_response(200); self.end_headers(); self.wfile.write(body)
    def log_message(self, *args): pass
http.server.HTTPServer(('127.0.0.1', a.port), H).serve_forever()
'''


def write(path, text, mode=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    if mode: path.chmod(mode)


def stub_app(root, fingerprint=F, hello=True, reap=True, layout='portable', sockets=True, library=LIBRARY):
    app = root / 'Agentic Complex.app'
    contents = app / 'Contents'
    resources = contents / 'Resources'
    (contents / 'MacOS').mkdir(parents=True)
    (contents / 'Info.plist').write_bytes(plistlib.dumps(dict(CFBundleIdentifier='local.agenticcomplex.smoke-stub', CFBundlePackageType='APPL',
        CFBundleExecutable='AgenticComplex', LSUIElement=True, AgenticComplexBuildFingerprint=fingerprint)))
    write(resources / 'distribution.json', json.dumps(dict(schema='endfield-distribution/v3', id='local.agenticcomplex.smoke-stub',
        layout=layout, catalogSHA256=hashlib.sha256((library / 'current.json').read_bytes()).hexdigest(),
        defaultCharacter=json.loads((library / 'current.json').read_text()).get('default_character'), port=48813)))
    write(resources / 'stub-current.json', (library / 'current.json').read_text())
    components = resources / 'components'
    service = components / 'agentd/payload'
    write(service / 'agentd/server.py', SERVER if sockets else 'import time\nwhile True: time.sleep(1)\n')
    write(service / 'agentd_launcher.py', 'import os, sys\nfrom pathlib import Path\n'
        'os.execv(sys.executable, [sys.executable, "-I", "-B", str(Path(__file__).parent / "agentd/server.py"), *sys.argv[1:]])\n')
    for name in ('character_tool.py', 'character_library.py', 'resource_store.py', 'pool_codec.py', 'fsutil.py',
                 'brain/__init__.py', 'brain/persona.py', 'brain/language.py', 'brain/lorebook.py',
                 'infra/__init__.py', 'infra/platform/__init__.py', 'infra/platform/posix.py', 'infra/platform/windows.py'):
        write(service / 'agentd' / name, (ROOT / 'agent/agentd' / name).read_text())
    # Synthetic numpy and importer; content_import_error only proves they resolve from the bundle's import roots.
    write(service / 'agentd/numpy.py', '')
    write(service / 'content/__init__.py', '')
    write(service / 'content/import_vmd.py', 'import numpy, character_library_stub, content_root_stub\n')
    write(service / 'content/content_root_stub.py', '')
    write(service / 'agentd/character_library_stub.py', '')
    write(service / 'tools/fbx-motion', '#!/bin/sh\necho \'{"tool":"fbx-motion/1","ufbx":"0.23.1"}\'\n', 0o755)
    write(components / 'runtime.python/payload/bin/agentic-complex-python', f'#!/bin/sh\nexec "{sys.executable}" -I -B "$@"\n', 0o755)
    (components / 'runtime.python/payload/bin/python').symlink_to('agentic-complex-python')
    write(components / 'harness.pi/payload/node/bin/node', '#!/bin/sh\nexit 0\n', 0o755)
    write(components / 'web-ui/payload/ui/main.html', '<html></html>')
    write(components / 'renderer/payload/MacOS/AgenticComplexMetalAvatar', '#!/bin/sh\nexit 0\n', 0o755)
    stub = STUB.replace('@REAP@', 'kill $child; wait $child;' if reap else '')
    stub = stub.replace('@HELLO@', 'say "hostlink: HOSTLINK hello character=voice_a capabilities= build.git="' if hello else '')
    stub = stub.replace('@READY@', 'until /usr/bin/curl -sf "http://127.0.0.1:$port/health" > /dev/null; do sleep 0.1; done' if sockets else ':')
    write(components / 'host/payload/MacOS/AgenticComplex', stub, 0o755)
    entries = {'host': {'executable': 'MacOS/AgenticComplex'}, 'renderer': {'executable': 'MacOS/AgenticComplexMetalAvatar'},
        'web-ui': {'index': 'ui/main.html'}, 'runtime.python': {'python': 'bin/python'},
        'agentd': {'launcher': 'agentd_launcher.py'},
        'harness.pi': {'node': 'node/bin/node'}}
    catalog = json.loads((library / 'current.json').read_text())
    if catalog['characters']:
        package = (library / catalog['characters'][0]['definition']['file']).parent
        shutil.copytree(package, components / 'characters.fixture/payload')
        entries['characters.fixture'] = {}
    refs = []
    for id, entrypoints in entries.items():
        payload = components / id / 'payload'
        placed = {entrypoints['executable']: entrypoints['executable']} if id in ('host', 'renderer') else None
        manifest = component_manifest.write_component(payload, id, '1', entrypoints, {}, {}, placed=placed)
        ref = {key: manifest[key] for key in ('id', 'version', 'tree_sha256')}
        if id == 'host': host = ref
        else: refs.append(dict(ref, placement='bundle'))
        if placed:
            for source, destination in placed.items(): shutil.move(payload / source, contents / destination)
            shutil.rmtree(payload)
    if layout == 'portable':
        component_manifest.write_lock(resources / 'composition.lock.json', layout, host, refs)
    else:
        external = root / 'components'; external.mkdir()
        index = []
        for ref in refs:
            if ref['id'] in ('renderer', 'web-ui'): continue
            shutil.move(components / ref['id'], external / ref['id'])
            index.append({key: ref[key] for key in ('id', 'version', 'tree_sha256')} | {'dir': ref['id'],
                'manifest_sha256': hashlib.sha256((external / ref['id'] / 'component.json').read_bytes()).hexdigest()})
        write(external / 'index.json', json.dumps(dict(schema='endfield-components-index/v1', components=index)))
        shutil.copy2(external / 'index.json', resources / 'components-index.json')
    subprocess.run(['codesign', '--force', '--deep', '-s', '-', str(app)], check=True, capture_output=True)
    return app


def free_port():
    with socket.socket() as s:
        try: s.bind(('127.0.0.1', 0))
        except PermissionError as e: raise unittest.SkipTest('sandbox cannot bind sockets: ' + str(e))
        return s.getsockname()[1]


class ArtifactSmokeTests(unittest.TestCase):
    def setUp(self):
        # An outer holder of the gpu lock makes gpu-lock.sh exec the app directly, leaving the shared lock alone.
        tmp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.addCleanup(tmp.cleanup)
        self.root = Path(os.path.realpath(tmp.name))
        env = mock.patch.dict(os.environ, {'AAC_LOCK_HELD_gpu': '1', 'TMPDIR': str(self.root)})
        env.start()
        self.addCleanup(env.stop)
        self.enterContext(mock.patch.object(tempfile, 'tempdir', str(self.root)))
        self.enterContext(mock.patch.object(Path, 'home', return_value=self.root / 'real-home'))

    def smoke(self, app, fingerprint=F, port=None, **timeouts):
        result = artifact_smoke.smoke(app, fingerprint, port=free_port() if port is None else port,
            label='test', **dict(dict(status_s=20, hello_s=20), **timeouts))
        if result['support_dir']: self.addCleanup(shutil.rmtree, result['support_dir'], True)
        return result

    def stub_processes(self, support):
        lines = []
        for path in Path(support).rglob('stub-processes'):
            for line in path.read_text().splitlines():
                pid = int(line.split()[0])
                try:
                    if str(support) not in line: continue
                    os.kill(pid, 0)
                except ProcessLookupError: continue
                lines.append(line)
        return lines

    def socketless_smoke(self, app, **timeouts):
        # The sandbox forbids process enumeration; these are the stub's actual child PIDs.
        with mock.patch.object(artifact_smoke, 'processes', side_effect=self.stub_processes):
            return self.smoke(app, port=48812, **timeouts)

    def test_stub_app_passes(self):
        for layout in ('portable', 'split'):
            with self.subTest(layout=layout):
                result = self.smoke(stub_app(self.root / layout, layout=layout))
                self.assertEqual(result['result'], 'PASS', result)
                self.assertEqual(result['layout'], layout)
                self.assertEqual(result['leftover'], [])
                self.assertNotIn('normal_launch', result)
                self.assertFalse(Path(result['support_dir']).exists())

    def test_main_writes_the_result_and_exits_zero(self):
        app, output = stub_app(self.root), self.root / 'smoke.json'
        run = subprocess.run([sys.executable, '-I', '-B', str(Path(artifact_smoke.__file__)), '--app', str(app), '--fingerprint', F,
            '--port', str(free_port()), '--output', str(output)], capture_output=True, text=True, timeout=120)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertEqual(json.loads(output.read_text())['result'], 'PASS')

    def test_window_envelope_logs(self):
        cases = [
            ('AAC_WINDOW envelope=bundle character=voice_a', 'PASS', None),
            ('AAC_WINDOW envelope=missing reason=file_missing source=none character=voice_a', 'FAIL', 'envelope=missing'),
            ('', 'FAIL', 'no AAC_WINDOW'),
            ('AAC_WINDOW envelope=argument character=voice_a', 'FAIL', 'envelope=argument'),
            ('AAC_WINDOW envelope=bundle character=voice_a_other', 'FAIL', 'no AAC_WINDOW'),
        ]
        log = self.root / 'avatar.log'
        for envelope, expected, error in cases:
            with self.subTest(envelope=envelope):
                log.write_text(envelope + '\n')
                reason = artifact_smoke.window_envelope_error(log, 'voice_a')
                if expected == 'PASS': self.assertIsNone(reason)
                else: self.assertIn(error, reason)

    def test_missing_hello_fails(self):
        result = self.smoke(stub_app(self.root, hello=False), hello_s=3)
        self.assertEqual(result['result'], 'FAIL')
        self.assertIn('HOSTLINK hello', result['error'])

    def test_text_only_default_character_passes_without_hello(self):
        result = self.smoke(stub_app(self.root, hello=False, library=TEXT_LIBRARY), hello_s=3)
        self.assertEqual(result['result'], 'PASS', result)

    def test_empty_library_passes_without_a_renderer(self):
        library = self.root / 'empty'
        subprocess.run([sys.executable, '-I', '-B', str(ROOT / 'agent/agentd/character_tool.py'),
                        'compose', '--output', str(library)], check=True, capture_output=True)
        app = stub_app(self.root, library=library, hello=False, sockets=False)
        with mock.patch.object(artifact_smoke, 'health_ok', return_value=True):
            result = self.socketless_smoke(app, hello_s=0)
        self.assertEqual(result['result'], 'PASS', result)

    def test_child_left_running_after_quit_fails_and_is_killed(self):
        result = self.smoke(stub_app(self.root, reap=False), quit_s=3)
        self.assertEqual(result['result'], 'FAIL')
        self.assertIn('still running', result['error'])
        self.assertTrue(any('server.py' in line for line in result['leftover']), result)
        self.assertEqual(artifact_smoke.processes(result['support_dir']), [])

    def test_plist_fingerprint_mismatch_fails_before_launch(self):
        app = stub_app(self.root, fingerprint='0' * 64)
        with mock.patch.object(artifact_smoke, 'launch', side_effect=AssertionError('launched')):
            result = self.smoke(app, port=artifact_smoke.PORT)
        self.assertEqual(result['result'], 'FAIL')
        self.assertIn('AgenticComplexBuildFingerprint', result['error'])

    def test_bundled_python_without_the_importer_fails_before_launch(self):
        app = stub_app(self.root)
        self.assertIsNone(artifact_smoke.content_import_error(artifact_smoke.build_config(app, self.root / 'probe')))
        service = app / 'Contents/Resources/components/agentd/payload'
        (service / 'agentd/numpy.py').unlink()
        (service / 'content/import_vmd.py').unlink()
        subprocess.run(['codesign', '--force', '--deep', '-s', '-', str(app)], check=True, capture_output=True)
        with mock.patch.object(artifact_smoke, 'launch', side_effect=AssertionError('launched')):
            result = self.smoke(app, port=artifact_smoke.PORT)
        self.assertEqual(result['result'], 'FAIL')
        self.assertIn('cannot import numpy and content.import_vmd: ModuleNotFoundError', result['error'])

    def test_unsigned_app_fails(self):
        app = stub_app(self.root)
        (app / 'Contents/Resources/components/characters.fixture/payload/character.json').write_text('{"changed": true}')
        with mock.patch.object(artifact_smoke, 'launch', side_effect=AssertionError('launched')):
            result = self.smoke(app, port=artifact_smoke.PORT)
        self.assertEqual(result['result'], 'FAIL')
        self.assertIn('codesign', result['error'])

    def test_split_component_hash_mismatch_fails_before_launch(self):
        for damage in ('payload', 'index', 'manifest'):
            with self.subTest(damage=damage):
                app = stub_app(self.root / damage, layout='split')
                external = app.parent / 'components'
                if damage == 'payload':
                    (external / 'harness.pi/payload/node/bin/node').write_text('changed bytes')
                elif damage == 'index':
                    path = external / 'index.json'
                    doc = json.loads(path.read_text())
                    next(row for row in doc['components'] if row['id'] == 'harness.pi')['tree_sha256'] = '0' * 64
                    path.write_text(json.dumps(doc))
                else:
                    path = external / 'harness.pi/component.json'
                    doc = json.loads(path.read_text()); doc['tree_sha256'] = '0' * 64
                    path.write_text(json.dumps(doc))
                with mock.patch.object(artifact_smoke, 'launch', side_effect=AssertionError('launched')):
                    result = self.smoke(app, port=artifact_smoke.PORT)
                self.assertEqual(result['result'], 'FAIL')
                self.assertEqual(result['layout'], 'split')
                expected = {'payload': 'component harness.pi tree_sha256 mismatch',
                            'manifest': 'component manifest mismatch: harness.pi', 'index': 'external component index mismatch'}
                self.assertIn(expected[damage], result['error'])

    def test_composed_catalog_hash_mismatch_fails_before_launch(self):
        for layout in ('portable', 'split'):
            with self.subTest(layout=layout):
                app = stub_app(self.root / layout, layout=layout)
                path = app / 'Contents/Resources/distribution.json'
                doc = json.loads(path.read_text()); doc['catalogSHA256'] = '0' * 64
                path.write_text(json.dumps(doc))
                subprocess.run(['codesign', '--force', '--deep', '-s', '-', str(app)], check=True, capture_output=True)
                with mock.patch.object(artifact_smoke, 'launch', side_effect=AssertionError('launched')):
                    result = self.smoke(app, port=artifact_smoke.PORT)
                self.assertEqual(result['result'], 'FAIL')
                self.assertEqual(result['layout'], layout)
                self.assertIn('catalogSHA256', result['error'])

    def test_config_points_into_the_bundle_and_a_temp_support_dir(self):
        for layout in ('portable', 'split'):
            with self.subTest(layout=layout):
                app, support = stub_app(self.root / layout, layout=layout), self.root / (layout + '-support')
                config = artifact_smoke.build_config(app, support)
                resources = app / 'Contents/Resources'
                payloads = {}
                source = resources / 'components' if layout == 'portable' else app.parent / 'components'
                for id in ('agentd', 'runtime.python', 'harness.pi', 'characters.fixture'):
                    manifest = json.loads((source / id / 'component.json').read_text())
                    installed = source / id if layout == 'portable' else support / 'components' / id / (
                        manifest['version'] + '-' + manifest['tree_sha256'][:8])
                    payloads[id] = installed / 'payload'
                    self.assertEqual(component_manifest.tree_sha256(payloads[id]), manifest['tree_sha256'])
                    self.assertEqual((installed / 'component.json').read_bytes(), (source / id / 'component.json').read_bytes())
                self.assertEqual((config['agentd_dir'], config['python'], config['agentd_launcher'], config['avatar_executable']),
                    (str(payloads['agentd'] / 'agentd'), str(payloads['runtime.python'] / 'bin/python'),
                     str(payloads['agentd'] / 'agentd_launcher.py'), str(app / 'Contents/MacOS/AgenticComplexMetalAvatar')))
                self.assertEqual(config['harness_sites'], {'harness.pi': str(payloads['harness.pi'])})
                catalog_path = Path(config['character_catalog'])
                self.assertTrue(catalog_path.is_relative_to(support))
                self.assertEqual(catalog_path.name, 'current.json')
                self.assertEqual(catalog_path.read_bytes(), (LIBRARY / 'current.json').read_bytes())
                catalog = json.loads(catalog_path.read_text())
                self.assertTrue((catalog_path.parent / catalog['native_bundle']['file']).is_file())
                for row in catalog['characters']:
                    self.assertTrue((catalog_path.parent / row['definition']['file']).is_file())
                self.assertFalse((resources / 'characters').exists())
                self.assertEqual((resources / 'composition.lock.json').exists(), layout == 'portable')
                self.assertEqual((config['agentd_port'], config['support_dir'], config['agentd_state_dir']),
                    (48811, str(support), str(support / 'agentd')))
                self.assertNotIn('services', config)
                self.assertFalse(any(v for k, v in config.items() if k.startswith('share_')))
                self.assertNotIn('dev_resources', config)

    def test_companion_port_is_refused(self):
        with self.assertRaisesRegex(ValueError, '48800'):
            artifact_smoke.smoke(self.root / 'Agentic Complex.app', F, port=48800)


if __name__ == '__main__':
    unittest.main()
