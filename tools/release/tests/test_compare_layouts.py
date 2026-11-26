import json
import os
from pathlib import Path
import plistlib
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / 'tools/release/compare_layouts.py'


class CompareLayoutsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir=ROOT, prefix='.test-compare-layouts-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.portable = self.root / 'portable'
        self.split = self.root / 'split'
        for output, layout in ((self.portable, 'portable'), (self.split, 'split')):
            output.mkdir()
            self.write_json(output / 'staging-manifest.json', dict(app='Agentic Complex.app', layout=layout,
                host=dict(id='host', version='1', tree_sha256='a' * 64), components=[
                    dict(id=id, version='1', tree_sha256='a' * 64,
                         placement='bundle' if layout == 'portable' or id in ('renderer', 'web-ui') else 'support')
                    for id in ('renderer', 'web-ui', 'agentd')]))
            contents = output / 'Agentic Complex.app/Contents'
            files = {'MacOS/AgenticComplex': b'host', 'Resources/host-data/nested/data.txt': b'host data',
                     'Resources/distribution.json': json.dumps(dict(layout=layout, port=48900)).encode(),
                     'MacOS/AgenticComplexMetalAvatar': b'renderer',
                     'Info.plist': plistlib.dumps(dict(CFBundleExecutable='AgenticComplex',
                         CFBundleIdentifier='local.agenticcomplex.compare-fixture', CFBundlePackageType='APPL'))}
            for relative, content in files.items():
                path = contents / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
            for id in ('host', 'renderer', 'web-ui', 'agentd'):
                directory = self.component(output, id)
                directory.mkdir(parents=True)
                manifest = dict(schema='endfield-component/v1', id=id, version='1', tree_sha256='a' * 64,
                                files=1, bytes=1, platform='macos-arm64', entrypoints={}, provides={}, requires={})
                if id == 'host':
                    manifest['entrypoints'] = dict(executable='MacOS/AgenticComplex')
                    manifest['placed'] = {'MacOS/AgenticComplex': 'MacOS/AgenticComplex', 'Info.plist': 'Info.plist',
                                          'assets': 'Resources/host-data'}
                elif id == 'renderer':
                    manifest['entrypoints'] = dict(executable='MacOS/AgenticComplexMetalAvatar')
                    manifest['placed'] = {'MacOS/AgenticComplexMetalAvatar': 'MacOS/AgenticComplexMetalAvatar'}
                else:
                    payload = directory / 'payload'
                    (payload / 'nested').mkdir(parents=True)
                    (payload / 'nested/data.txt').write_bytes(b'data')
                    (payload / 'link').symlink_to('nested/data.txt')
                    (payload / 'directory-link').symlink_to('nested', target_is_directory=True)
                    (payload / 'dangling').symlink_to('missing')
                self.write_json(directory / 'component.json', manifest)

    def component(self, output, id):
        base = output if output == self.split and id not in ('host', 'renderer', 'web-ui') else output / 'Agentic Complex.app/Contents/Resources'
        return base / 'components' / id

    def write_json(self, path, document):
        path.write_text(json.dumps(document), encoding='utf-8')

    def compare(self):
        return subprocess.run([sys.executable, '-I', str(SCRIPT), '--portable', str(self.portable),
                               '--split', str(self.split)], capture_output=True, text=True)

    def assert_same(self):
        result = self.compare()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout.splitlines(), ['distribution.json: same', 'agentd: same', 'host: same', 'renderer: same',
                                                      'web-ui: same', 'LAYOUTS SAME'])

    def assert_different(self, *details):
        result = self.compare()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertEqual(result.stdout.splitlines()[-1], 'LAYOUTS DIFFER')
        for detail in details:
            self.assertIn(detail, result.stdout)

    def sign(self, path):
        result = subprocess.run(['codesign', '--force', '--sign', '-', '--timestamp=none', str(path)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def macho(self, universal=False):
        missing = [tool for tool in ('cc', 'codesign') if shutil.which(tool) is None]
        if missing: self.skipTest('missing tool(s): ' + ', '.join(missing))
        path = self.root / 'tool'
        source = self.root / 'tool.c'
        source.write_text('int main(void) { return 0; }\n')
        arch = ['-arch', 'arm64', '-arch', 'x86_64'] if universal else []
        result = subprocess.run(['cc', *arch, str(source), '-o', str(path)], capture_output=True, text=True,
                                env=dict(os.environ, TMPDIR=str(self.root)))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.sign(path)
        return path

    def load_commands(self, data):
        bases = [0]
        if data[:4] == b'\xca\xfe\xba\xbe':
            count = struct.unpack_from('>I', data, 4)[0]
            bases = [struct.unpack_from('>I', data, 8 + index * 20 + 8)[0] for index in range(count)]
        for base in bases:
            self.assertEqual(data[base:base + 4], b'\xcf\xfa\xed\xfe')
            offset = base + 32
            for _ in range(struct.unpack_from('<I', data, base + 16)[0]):
                command, size = struct.unpack_from('<II', data, offset)
                yield base, command, offset
                offset += size

    def change_code_byte(self, path, cputype=None):
        data = bytearray(path.read_bytes())
        for base, command, offset in self.load_commands(data):
            if command != 0x19 or cputype is not None and struct.unpack_from('<I', data, base + 4)[0] != cputype: continue
            for index in range(struct.unpack_from('<I', data, offset + 64)[0]):
                section = offset + 72 + index * 80
                if data[section:section + 16].rstrip(b'\0') != b'__text': continue
                code = base + struct.unpack_from('<I', data, section + 48)[0]
                data[code] ^= 1
                path.write_bytes(data)
                return
        self.fail('fixture has no __text section')

    def test_resigned_macho_uses_cdhash_for_thin_and_fat(self):
        for universal in (False, True):
            with self.subTest(universal=universal):
                binary = self.macho(universal)
                data = bytearray(binary.read_bytes())
                padding = []
                for base, command, offset in self.load_commands(data):
                    if command != 0x1d: continue
                    start, size = struct.unpack_from('<II', data, offset + 8)
                    start += base
                    length = struct.unpack_from('>I', data, start + 4)[0]
                    self.assertLess(length, size, 'fixture signature must have unsealed padding')
                    padding.append(start + size - 1)
                self.assertTrue(padding)
                left = self.component(self.portable, 'agentd') / 'payload/tool'
                right = self.component(self.split, 'agentd') / 'payload/tool'
                shutil.copy2(binary, left)
                shutil.copy2(binary, right)
                self.sign(right)
                # Ad hoc signing is deterministic; unsealed padding makes a raw-byte comparison fail.
                for offset in padding: data[offset] ^= 1
                left.write_bytes(data)
                verify = subprocess.run(['codesign', '--verify', '--strict', str(left)],
                                        capture_output=True, text=True)
                self.assertEqual(verify.returncode, 0, verify.stderr)
                self.assertTrue(left.read_bytes() != right.read_bytes(), 'signature bytes must differ')
                self.assert_same()

    def test_changed_macho_code_byte(self):
        binary = self.macho()
        for output in (self.portable, self.split):
            shutil.copy2(binary, self.component(output, 'agentd') / 'payload/tool')
        path = self.component(self.split, 'agentd') / 'payload/tool'
        before = path.read_bytes()
        self.change_code_byte(path)
        self.assertEqual(sum(a != b for a, b in zip(before, path.read_bytes())), 1)
        self.sign(path)
        self.assert_different('agentd:', 'tool', 'CDHash')

    def test_every_slice_of_a_fat_macho_is_compared(self):
        binary = self.macho(universal=True)
        for output in (self.portable, self.split):
            shutil.copy2(binary, self.component(output, 'agentd') / 'payload/tool')
        path = self.component(self.split, 'agentd') / 'payload/tool'
        self.change_code_byte(path, cputype=0x01000007)  # x86_64, not the arm64 slice codesign shows by default
        self.sign(path)
        self.assert_different('agentd:', 'tool', 'CDHash')

    def test_distribution_json_differs_only_in_layout(self):
        self.assert_same()
        path = self.split / 'Agentic Complex.app/Contents/Resources/distribution.json'
        path.write_text(json.dumps(dict(layout='split', port=48901)))
        self.assert_different('distribution.json: port differs')

    def signed_apps(self):
        binary = self.macho()
        executables = []
        for output, layout in ((self.portable, 'portable'), (self.split, 'split')):
            app = output / 'Agentic Complex.app'
            executable = app / 'Contents/MacOS/AgenticComplex'
            shutil.copy2(binary, executable)
            shutil.copy2(binary, app / 'Contents/MacOS/AgenticComplexMetalAvatar')
            self.sign(app)
            executables.append(executable)
        displays = [subprocess.run(['codesign', '-d', '-vvv', str(path)], capture_output=True, text=True).stderr
                    for path in executables]
        hashes = [next(line for line in display.splitlines() if line.startswith('CDHash=')) for display in displays]
        self.assertNotEqual(*hashes)
        return executables

    def test_host_ignores_changed_bundle_resource_seal(self):
        self.signed_apps()
        self.assert_same()

    def test_host_code_byte_change_still_differs(self):
        left, right = self.signed_apps()
        self.change_code_byte(right)
        self.sign(self.split / 'Agentic Complex.app')
        self.assert_different('host:', 'MacOS/AgenticComplex', 'code-page hashes')

    def test_non_host_bundle_executable_still_uses_cdhash(self):
        executables = self.signed_apps()
        for output, executable in zip((self.portable, self.split), executables):
            shutil.copy2(executable, output / 'Agentic Complex.app/Contents/MacOS/AgenticComplexMetalAvatar')
        self.assert_different('renderer:', 'MacOS/AgenticComplexMetalAvatar: CDHash differs')

    def test_unreadable_macho_signature_is_read_error(self):
        binary = self.macho()
        result = subprocess.run(['codesign', '--remove-signature', str(binary)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        for output in (self.portable, self.split):
            shutil.copy2(binary, self.component(output, 'agentd') / 'payload/tool')
        result = self.compare()
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn('tool', result.stderr)
        self.assertNotIn('LAYOUTS SAME', result.stdout)

    def test_identical_component_payloads_in_both_layouts(self):
        self.assert_same()

    def test_changed_non_macho_file(self):
        (self.component(self.split, 'agentd') / 'payload/nested/data.txt').write_bytes(b'changed')
        self.assert_different('agentd:', 'nested/data.txt', 'sha256')

    def test_nested_bundle_cms_blob_is_skipped_but_its_code_directory_is_compared(self):
        for output in (self.portable, self.split):
            seal = output / 'Agentic Complex.app/Contents/Resources/host-data/UI.bundle/Contents/_CodeSignature'
            seal.mkdir(parents=True)
            (seal / 'CodeDirectory').write_bytes(b'directory')
            (seal / 'CodeSignature').write_bytes(b'signed at ' + output.name.encode())
        self.assert_same()
        (self.split / 'Agentic Complex.app/Contents/Resources/host-data/UI.bundle/Contents/_CodeSignature/CodeDirectory').write_bytes(b'other')
        self.assert_different('host:', 'UI.bundle/Contents/_CodeSignature/CodeDirectory', 'sha256')

    def test_executable_bit_lost(self):
        for output in (self.portable, self.split):
            (self.component(output, 'agentd') / 'payload/nested/data.txt').chmod(0o755)
        self.assert_same()
        (self.component(self.split, 'agentd') / 'payload/nested/data.txt').chmod(0o644)
        self.assert_different('agentd:', 'nested/data.txt', 'executable bit differs')

    def test_changed_file_under_placed_directory(self):
        (self.split / 'Agentic Complex.app/Contents/Resources/host-data/nested/data.txt').write_bytes(b'changed')
        self.assert_different('host:', 'assets/nested/data.txt', 'sha256')

    def test_missing_payload_file(self):
        (self.component(self.split, 'web-ui') / 'payload/nested/data.txt').unlink()
        self.assert_different('web-ui:', 'nested/data.txt', 'missing in split')

    def test_missing_placed_file(self):
        (self.split / 'Agentic Complex.app/Contents/MacOS/AgenticComplexMetalAvatar').unlink()
        self.assert_different('renderer:', 'MacOS/AgenticComplexMetalAvatar', 'missing in split')

    def test_missing_component_in_either_layout(self):
        for output, id, side in ((self.split, 'agentd', 'split'), (self.portable, 'web-ui', 'portable')):
            with self.subTest(side=side):
                shutil.rmtree(self.component(output, id))
                self.assert_different(f'{id}:', 'component missing in ' + side)

    def test_component_manifest_other_keys_must_match(self):
        path = self.component(self.split, 'agentd') / 'component.json'
        original = json.loads(path.read_text())
        for key, value in (('version', '2'), ('files', 2), ('bytes', 2), ('requires', {'runtime.python': '3'})):
            with self.subTest(key=key):
                self.write_json(path, dict(original, **{key: value}))
                self.assert_different('agentd:', 'component.json', key)

    def test_component_manifest_ignores_only_tree_sha256_and_json_formatting(self):
        path = self.component(self.split, 'agentd') / 'component.json'
        manifest = json.loads(path.read_text())
        manifest['tree_sha256'] = 'b' * 64
        path.write_text(json.dumps(manifest, indent=2, sort_keys=True))
        self.assert_same()

    def test_symlink_target_changes(self):
        payload = self.component(self.split, 'agentd') / 'payload'
        for relative, target in (('link', './nested/data.txt'), ('directory-link', './nested'),
                                 ('dangling', 'other-missing')):
            with self.subTest(relative=relative):
                path = payload / relative
                original = os.readlink(path)
                path.unlink()
                path.symlink_to(target)
                self.assert_different('agentd:', relative, 'symlink target')
                path.unlink()
                path.symlink_to(original)

    def test_symlink_replaced_by_file(self):
        path = self.component(self.split, 'agentd') / 'payload/link'
        path.unlink()
        path.write_bytes(b'data')
        self.assert_different('agentd:', 'link', 'file type')

    def test_missing_or_invalid_manifest_is_read_error(self):
        path = self.split / 'staging-manifest.json'
        for content in (None, '{', '{}'):
            with self.subTest(content=content):
                if content is None: path.unlink()
                else: path.write_text(content)
                result = self.compare()
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertIn('staging-manifest.json', result.stderr)
                self.assertNotIn('LAYOUTS SAME', result.stdout)

    def test_layout_arguments_must_match_staging_manifests(self):
        path = self.split / 'staging-manifest.json'
        stage = json.loads(path.read_text())
        stage['layout'] = 'portable'
        self.write_json(path, stage)
        result = self.compare()
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn('layout', result.stderr)

    def test_non_object_manifest_is_read_error(self):
        for path in (self.split / 'staging-manifest.json', self.component(self.split, 'agentd') / 'component.json'):
            original = path.read_text()
            for content in ('[]', 'null'):
                with self.subTest(path=path.name, content=content):
                    path.write_text(content)
                    result = self.compare()
                    self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                    self.assertIn(path.name, result.stderr)
            path.write_text(original)

    def test_unreadable_component_root_is_read_error(self):
        path = self.split / 'Agentic Complex.app/Contents/Resources/components'
        shutil.rmtree(path)
        for content in (None, 'not a directory'):
            with self.subTest(content=content):
                if content is not None: path.write_text(content)
                result = self.compare()
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertIn('components', result.stderr)


if __name__ == '__main__':
    unittest.main()
