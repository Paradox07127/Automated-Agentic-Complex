import os
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_agent.services.workspace import WorkspaceError, WorkspaceService
from test_workspace_extract import xlsx


class WorkspaceCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.inputs = self.root / 'inputs'; self.inputs.mkdir()
        self.output = self.root / 'output'
        self.service = WorkspaceService(self.root / 'state', egress=lambda text: text.replace('SECRET', '[hidden]'))
        self.scope = self.service.create_scope([str(self.inputs)], str(self.output))['scope_id']

    def tearDown(self):
        self.service.close(); self.temp.cleanup()

    def call(self, name, args, run='run', **kwargs):
        return self.service.call(name, args, scope_id=self.scope, run_id=run, **kwargs)

    def assertCode(self, code, fn):
        with self.assertRaises(WorkspaceError) as error: fn()
        self.assertEqual(error.exception.code, code)


class WorkspaceTests(WorkspaceCase):
    def test_scope_is_unavailable_while_its_directory_is_missing(self):
        self.inputs.rename(self.root / 'old')
        self.assertCode('scope_changed', lambda: self.call('artifact_write', {'path': 'x.md', 'content': 'x'}))
        self.inputs.mkdir()
        self.assertEqual(self.call('artifact_write', {'path': 'x.md', 'content': 'x'})['version'], 1)

    def test_scope_revocation_and_expiration_fail_closed(self):
        fingerprint = self.service.fingerprint(self.scope)
        self.assertEqual(len(fingerprint), 64)
        self.service.revoke_scope(self.scope)
        self.assertCode('scope_revoked', lambda: self.call('artifact_write', {'path': 'x.md', 'content': 'x'}))
        self.assertTrue(self.service.list_scopes()[0]['revoked'])
        scope = self.service.create_scope([str(self.inputs)], str(self.output), ttl=1)
        self.service.clock = lambda: scope['expires_at'] + 1
        self.assertCode('scope_expired', lambda: self.service.validate_scope(scope['scope_id']))

    def test_only_the_artifact_tools_are_offered(self):
        self.assertEqual([d['name'] for d in self.service.tool_definitions()],
                         ['artifact_write', 'artifact_read', 'artifact_verify'])
        self.assertCode('unknown_tool', lambda: self.call('workspace_list', {}))

    def test_artifact_read_applies_egress(self):
        self.call('artifact_write', {'path': 'x.md', 'content': 'hello SECRET'})
        self.assertEqual(self.call('artifact_read', {'path': 'x.md'})['text'], 'hello [hidden]')

    def test_artifact_paths_allow_text_and_code_formats(self):
        for name in ('x.md', 'x.py', 'x.log', 'x.yaml'):
            self.assertEqual(self.call('artifact_write', {'path': name, 'content': 'x'})['version'], 1)
        for bad in ('x.env', 'x.exe'):
            self.assertCode('unsupported_format', lambda: self.call('artifact_write', {'path': bad, 'content': 'x'}))

    def test_an_unsupported_format_error_names_the_text_formats_it_takes(self):
        with self.assertRaises(WorkspaceError) as error:
            self.call('artifact_write', {'path': 'x.exe', 'content': 'x'})
        for name in ('MD', 'CSV', 'PY', 'SH', 'PS1', 'LOG'):
            self.assertIn(name, error.exception.message.replace(',', ' ').split())

    def test_office_and_image_artifact_paths_stay_unsupported(self):
        for name in ('x.docx', 'x.png'):
            self.assertCode('unsupported_format', lambda: self.call('artifact_write', {'path': name, 'content': 'x'}))

    def test_cancelled_run_and_unknown_tools_cannot_execute(self):
        self.service.cancel_run('run')
        self.assertCode('run_cancelled', lambda: self.call('artifact_write', {'path': 'x.md', 'content': 'x'}))
        self.assertCode('unknown_tool', lambda: self.call('Bash', {'command': 'echo x'}, run='other'))
        self.assertCode('invalid_arguments', lambda: self.call('artifact_read', {'path': 'x.md', 'root': '/'}, run='other'))

    def test_missing_roots_are_rejected(self):
        self.assertCode('invalid_roots', lambda: self.service.create_scope([], str(self.output)))
        self.assertCode('invalid_root', lambda: self.service.create_scope([str(self.root / 'missing')], str(self.output)))

    def test_folder_scope_without_output_root_writes_to_drop_outputs(self):
        scope = self.service.create_scope(roots=[str(self.inputs)])
        self.assertEqual(scope['kind'], 'directory')
        self.assertEqual(scope['output']['path'], str((self.root / 'state' / 'drop-outputs' / scope['scope_id']).resolve()))

    def test_run_files_lists_writes_and_modifies_with_line_counts(self):
        self.call('artifact_write', {'path': 'new.md', 'content': 'a\nb\nc\n'})
        self.call('artifact_write', {'path': 'out/edited.md', 'content': 'x'})
        self.call('artifact_write', {'path': 'out/edited.md', 'content': 'y\nz', 'expected_version': 1})
        written = Path(self.service.run_artifacts('run')[0]['absolute_path']).parent
        self.assertEqual(self.service.run_files('run'), [
            {'path': str(written / 'new.md'), 'op': 'write', 'added': 3, 'removed': 0},
            {'path': str(written / 'out/edited.md'), 'op': 'modify', 'added': None, 'removed': None}])
        (written / 'new.md').write_text('changed later', encoding='utf-8')
        self.assertEqual(self.service.run_files('run')[0]['added'], None)
        self.assertEqual(self.service.run_files('other'), [])

    def write(self, content, **kwargs):
        return self.call('artifact_write', {'path': 'out/report.md', 'content': content, **kwargs})

    def test_overwrite_keeps_the_previous_version_beside_the_artifact(self):
        first = self.write('first')
        self.write('second', expected_version=first['version'])
        versions = Path(first['absolute_path']).parent / '.versions'
        self.assertEqual(sorted(p.name for p in versions.iterdir()), ['report.md.v1'])
        self.assertEqual((versions / 'report.md.v1').read_text(encoding='utf-8'), 'first')

    def test_overwrite_retries_while_another_process_holds_the_file(self):
        first = self.write('first'); replace = os.replace; refused = []
        def held(source, target):
            if not refused: refused.append(target); raise PermissionError('in use')
            return replace(source, target)
        with patch('character_agent.services.workspace.os.replace', side_effect=held):
            self.assertEqual(self.write('second', expected_version=first['version'])['version'], 2)
        self.assertEqual(len(refused), 1)
        self.assertEqual(Path(first['absolute_path']).read_text(encoding='utf-8'), 'second')

    def test_revert_writes_the_previous_version_back_as_a_new_version(self):
        first = self.write('first')
        self.write('second', expected_version=1)
        reverted = self.service.revert_artifact('run', 'out/report.md', scope_id=self.scope, expected_version=2)
        path = Path(first['absolute_path'])
        self.assertEqual(path.read_text(encoding='utf-8'), 'first')
        self.assertEqual(reverted['version'], 3)
        self.assertEqual(self.service.read_artifact('run', 'out/report.md')['current_sha256'], reverted['sha256'])
        versions = path.parent / '.versions'
        self.assertEqual(sorted(p.name for p in versions.iterdir()), ['report.md.v1', 'report.md.v2'])
        self.assertEqual((versions / 'report.md.v2').read_text(encoding='utf-8'), 'second')
        self.assertCode('version_conflict', lambda: self.service.revert_artifact(
            'run', 'out/report.md', scope_id=self.scope, expected_version=2))

    def test_revert_without_a_previous_version_fails(self):
        self.write('only')
        self.assertCode('no_previous_version', lambda: self.service.revert_artifact(
            'run', 'out/report.md', scope_id=self.scope, expected_version=1))

    def test_unchanged_rewrite_keeps_no_version(self):
        first = self.write('same')
        self.assertTrue(self.write('same', expected_version=1)['unchanged'])
        self.assertFalse((Path(first['absolute_path']).parent / '.versions').exists())

    def test_a_different_kept_version_is_not_overwritten(self):
        first = self.write('first')
        versions = Path(first['absolute_path']).parent / '.versions'; versions.mkdir()
        (versions / 'report.md.v1').write_text('other', encoding='utf-8')
        self.assertCode('version_store_conflict', lambda: self.write('second', expected_version=1))
        self.assertEqual(Path(first['absolute_path']).read_text(encoding='utf-8'), 'first')
        self.assertEqual((versions / 'report.md.v1').read_text(encoding='utf-8'), 'other')

    def test_a_version_store_linked_outside_the_output_is_refused(self):
        first = self.write('first')
        outside = self.root / 'elsewhere'; outside.mkdir()
        (Path(first['absolute_path']).parent / '.versions').symlink_to(outside, target_is_directory=True)
        self.assertCode('path_not_allowed', lambda: self.write('second', expected_version=1))
        self.assertEqual(list(outside.iterdir()), [])
        self.assertEqual(Path(first['absolute_path']).read_text(encoding='utf-8'), 'first')

    def test_kept_versions_are_not_artifacts(self):
        self.write('first'); self.write('second', expected_version=1)
        (Path(self.service.run_artifacts('run')[0]['absolute_path']).parent / '.versions' / 'kept.md').write_text('x', encoding='utf-8')
        self.assertEqual([a['path'] for a in self.service.run_artifacts('run')], ['out/report.md'])
        self.assertEqual([f['path'] for f in self.service.run_files('run') if '.versions' in f['path']], [])

    def test_scope_and_artifact_survive_service_restart(self):
        first = self.write('kept')
        self.service.close(); self.service = WorkspaceService(self.root / 'state')
        self.assertEqual(self.call('artifact_read', {'path': 'out/report.md'})['current_sha256'], first['sha256'])


class DropScopeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.folder = self.root / 'desktop'; self.folder.mkdir()
        (self.folder / 'note.md').write_text('picked note', encoding='utf-8')
        (self.folder / 'sibling.md').write_text('sibling words', encoding='utf-8')
        self.service = WorkspaceService(self.root / 'state')

    def tearDown(self):
        self.service.close(); self.temp.cleanup()

    def drop(self, *names):
        return self.service.create_scope(files=[str(self.folder / name) for name in names])

    def call(self, scope, name, args):
        return self.service.call(name, args, scope_id=scope['scope_id'], run_id='run')

    def assertCode(self, code, fn):
        with self.assertRaises(WorkspaceError) as error: fn()
        self.assertEqual(error.exception.code, code)

    def test_drop_scope_holds_exactly_the_given_files(self):
        scope = self.drop('note.md')
        self.assertEqual(scope['kind'], 'drop')
        self.assertEqual([f['path'] for f in scope['files']], [str((self.folder / 'note.md').resolve())])
        self.assertEqual(scope['roots'], [])
        self.assertEqual(scope['expires_at'] - scope['created_at'], 86400)
        self.assertTrue(Path(scope['output']['path']).is_relative_to((self.root / 'state').resolve()))

    def test_drop_scope_reports_unsupported_types(self):
        (self.folder / 'paper.pdf').write_bytes(b'%PDF-synthetic')
        (self.folder / 'clip.mov').write_bytes(b'moov')
        scope = self.drop('paper.pdf', 'note.md', 'clip.mov')
        self.assertEqual(scope['unsupported'], [
            {'path': str(self.folder / 'paper.pdf'), 'reason': 'unsupported_type'},
            {'path': str(self.folder / 'clip.mov'), 'reason': 'unsupported_type'}])
        self.assertEqual([f['path'] for f in scope['files']], [str((self.folder / 'note.md').resolve())])
        self.assertCode('no_supported_files', lambda: self.drop('paper.pdf'))

    def test_drop_scope_accepts_source_code_and_logs_but_not_env_files(self):
        (self.folder / 'tool.py').write_text('print(1)\n', encoding='utf-8', newline='')
        (self.folder / 'run.log').write_text('started\n', encoding='utf-8', newline='')
        (self.folder / '.env').write_text('TOKEN=x\n', encoding='utf-8')
        scope = self.drop('tool.py', 'run.log', '.env')
        self.assertEqual(scope['unsupported'], [{'path': str(self.folder / '.env'), 'reason': 'unsupported_type'}])
        self.assertEqual([Path(f['path']).name for f in scope['files']], ['tool.py', 'run.log'])

    def test_drop_scope_accepts_a_spreadsheet(self):
        (self.folder / 'stock.xlsx').write_bytes(xlsx())
        self.assertEqual(self.drop('stock.xlsx')['unsupported'], [])

    def test_drop_scope_accepts_an_image(self):
        (self.folder / 'a.png').write_bytes(b'\x89PNG')
        self.assertEqual(self.drop('a.png')['unsupported'], [])

    def test_drop_scope_revoked_denies_writes(self):
        scope = self.drop('note.md')
        self.service.revoke_scope(scope['scope_id'])
        self.assertCode('scope_revoked', lambda: self.call(scope, 'artifact_write', {'path': 'x.md', 'content': 'x'}))

    def test_drop_scope_rejects_relative_missing_and_too_many_files(self):
        self.assertCode('invalid_file', lambda: self.service.create_scope(files=['note.md']))
        self.assertCode('invalid_file', lambda: self.drop('missing.md'))
        self.assertCode('invalid_files', lambda: self.drop(*['note.md'] * 17))

    def test_dropped_directory_becomes_a_root(self):
        scope = self.service.create_scope(files=[str(self.folder)])
        self.assertEqual(scope['kind'], 'drop')
        self.assertEqual([r['path'] for r in scope['roots']], [str(self.folder.resolve())])
        self.assertEqual(scope['files'], [])
        self.assertEqual(self.service.get_scope(scope['scope_id'])['roots'], scope['roots'])

    def test_dropped_directory_with_a_text_suffix_becomes_a_root(self):
        (self.folder / 'x.md').mkdir()
        scope = self.drop('x.md')
        self.assertEqual([r['path'] for r in scope['roots']], [str((self.folder / 'x.md').resolve())])
        self.assertEqual(scope['files'], [])

    def test_drop_mixes_directory_file_and_unsupported(self):
        (self.folder / 'sub').mkdir(); (self.folder / 'b.xyz').write_text('other', encoding='utf-8')
        scope = self.drop('sub', 'note.md', 'b.xyz')
        self.assertEqual([r['path'] for r in scope['roots']], [str((self.folder / 'sub').resolve())])
        self.assertEqual([f['path'] for f in scope['files']], [str((self.folder / 'note.md').resolve())])
        self.assertEqual(scope['unsupported'], [{'path': str(self.folder / 'b.xyz'), 'reason': 'unsupported_type'}])

    def test_a_symlink_of_an_unsupported_type_does_not_fail_the_drop(self):
        (self.folder / 'b.xyz').write_text('other', encoding='utf-8'); (self.folder / 'link.xyz').symlink_to(self.folder / 'b.xyz')
        scope = self.drop('note.md', 'link.xyz')
        self.assertEqual([item['path'] for item in scope['unsupported']], [str(self.folder / 'link.xyz')])

    def test_drop_of_only_unsupported_files_still_fails(self):
        (self.folder / 'b.xyz').write_text('other', encoding='utf-8')
        self.assertCode('no_supported_files', lambda: self.drop('b.xyz'))

    def test_dropped_directories_share_the_root_limit(self):
        dirs = []
        for i in range(17):
            (self.folder / f'd{i}').mkdir(); dirs.append(f'd{i}')
        # The files list limit stops 17 dropped directories before the roots limit sees them.
        self.assertCode('invalid_files', lambda: self.drop(*dirs))
        roots = [str(self.folder / name) for name in dirs[:10]]
        files = [str(self.folder / name) for name in dirs[10:]]
        self.assertCode('invalid_roots', lambda: self.service.create_scope(roots, files=files))
        scope = self.service.create_scope(roots[:1], files=roots[:1] + roots[:1])
        self.assertEqual(len(scope['roots']), 1)


if __name__ == '__main__': unittest.main()
