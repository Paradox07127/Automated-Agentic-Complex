import json
import os
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_agent.services.workspace import WorkspaceError, WorkspaceService
from character_agent.services.workspace import MAX_BYTES
from test_workspace_extract import docx, xlsx


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

    def source(self, name='note.md', content='source evidence'):
        (self.inputs / name).write_text(content, encoding='utf-8')
        self.call('workspace_list', {})
        return 'r0:' + name

    def assertCode(self, code, fn):
        with self.assertRaises(WorkspaceError) as error: fn()
        self.assertEqual(error.exception.code, code)


class WorkspaceTests(WorkspaceCase):
    def test_list_read_and_search_return_provenance_and_apply_egress(self):
        source = self.source(content='hello SECRET quiet room')
        result = self.call('workspace_read', {'source_id': source})
        self.assertEqual(result['text'], 'hello [hidden] quiet room')
        self.assertEqual(result['trust'], 'source_material')
        self.assertEqual(len(result['sha256']), 64)
        hits = self.call('workspace_search', {'query': 'quiet'})['matches']
        self.assertEqual(hits[0]['source_id'], source)
        self.assertNotIn('SECRET', json.dumps(hits))

    def test_read_pagination_applies_after_redaction(self):
        source = self.source(content='SECRET abc')
        first = self.call('workspace_read', {'source_id': source, 'limit': 5})
        second = self.call('workspace_read', {'source_id': source, 'offset': first['next_offset'], 'limit': 20})
        self.assertEqual(first['text'] + second['text'], '[hidden] abc')
        self.assertCode('invalid_arguments', lambda: self.call('workspace_read', {'source_id': source, 'limit': True}))

    def test_unselected_files_and_symlinks_cannot_be_read(self):
        outside = self.root / 'private.md'; outside.write_text('private', encoding='utf-8')
        (self.inputs / 'link.md').symlink_to(outside)
        self.assertEqual(self.call('workspace_list', {})['sources'], [])
        self.assertCode('unknown_source', lambda: self.call('workspace_read', {'source_id': '../private.md'}))
        source = self.source()
        (self.inputs / 'note.md').unlink(); (self.inputs / 'note.md').symlink_to(outside)
        self.assertCode('path_not_allowed', lambda: self.call('workspace_read', {'source_id': source}))

    def test_a_directory_symlink_loop_is_skipped_and_the_listing_is_complete(self):
        (self.inputs / 'a').mkdir(); (self.inputs / 'a' / 'z.txt').write_text('a', encoding='utf-8')
        (self.inputs / 'loop').symlink_to('.', target_is_directory=True)
        (self.inputs / 'zz.txt').write_text('z', encoding='utf-8')
        listed = self.call('workspace_list', {})
        self.assertEqual(([s['path'] for s in listed['sources']], listed['truncated']), (['a/z.txt', 'zz.txt'], False))

    def test_scope_is_unavailable_while_its_directory_is_missing(self):
        self.inputs.rename(self.root / 'old')
        self.assertCode('scope_changed', lambda: self.call('workspace_list', {}))
        self.inputs.mkdir(); (self.inputs / 'new.md').write_text('back again', encoding='utf-8')
        self.assertEqual([s['path'] for s in self.call('workspace_list', {})['sources']], ['new.md'])

    def test_scope_revocation_and_expiration_fail_closed(self):
        fingerprint = self.service.fingerprint(self.scope)
        self.assertEqual(len(fingerprint), 64)
        self.service.revoke_scope(self.scope)
        self.assertCode('scope_revoked', lambda: self.call('workspace_list', {}))
        self.assertTrue(self.service.list_scopes()[0]['revoked'])
        scope = self.service.create_scope([str(self.inputs)], str(self.output), ttl=1)
        self.service.clock = lambda: scope['expires_at'] + 1
        self.assertCode('scope_expired', lambda: self.service.validate_scope(scope['scope_id']))

    def test_unsupported_and_binary_inputs_are_not_claimed_understood(self):
        (self.inputs / 'document.pdf').write_bytes(b'%PDF-synthetic')
        (self.inputs / 'binary.txt').write_bytes(b'a\x00b')
        (self.inputs / 'bad.md').write_bytes(b'\xff\xfe')
        self.assertEqual(self.call('workspace_list', {})['sources'], [])

    def test_office_source_is_listed_read_and_searched_as_text(self):
        data = docx('季度报告', '结论：库存充足')
        (self.inputs / 'report.docx').write_bytes(data)
        listed = self.call('workspace_list', {})['sources']
        self.assertEqual([(s['source_id'], s['bytes']) for s in listed], [('r0:report.docx', len(data))])
        self.assertEqual(self.call('workspace_read', {'source_id': 'r0:report.docx'})['text'], '季度报告\n结论：库存充足')
        self.assertEqual([m['source_id'] for m in self.call('workspace_search', {'query': '库存'})['matches']], ['r0:report.docx'])

    def test_search_skips_an_office_file_without_text(self):
        (self.inputs / 'broken.docx').write_bytes(b'not a zip')
        self.source(content='quiet room')
        self.assertEqual([m['source_id'] for m in self.call('workspace_search', {'query': 'quiet'})['matches']], ['r0:note.md'])

    def test_listing_reports_skipped_files_and_does_not_extract(self):
        (self.inputs / 'big.txt').write_bytes(b'a' * (MAX_BYTES + 1))
        (self.inputs / 'report.docx').write_bytes(docx('正文'))
        with patch('character_agent.services.workspace.extract') as extract:
            listing = self.call('workspace_list', {})
        extract.assert_not_called()
        self.assertEqual([s['path'] for s in listing['sources']], ['report.docx'])
        self.assertEqual(listing['skipped'], [{'path': 'big.txt', 'reason': 'file_too_large'}])

    def test_source_code_and_logs_are_read_as_text_but_env_files_are_not(self):
        (self.inputs / 'tool.py').write_text('print("SECRET")\n', encoding='utf-8', newline='')
        (self.inputs / 'run.log').write_text('12:00 started\n', encoding='utf-8', newline='')
        (self.inputs / '.env').write_text('TOKEN=x\n', encoding='utf-8')
        (self.inputs / 'prod.env').write_text('TOKEN=x\n', encoding='utf-8')
        self.assertEqual([s['path'] for s in self.call('workspace_list', {})['sources']], ['run.log', 'tool.py'])
        self.assertEqual(self.call('workspace_read', {'source_id': 'r0:tool.py'})['text'], 'print("[hidden]")\n')
        self.assertEqual(self.call('workspace_read', {'source_id': 'r0:run.log'})['text'], '12:00 started\n')

    def test_artifact_paths_keep_the_four_text_formats(self):
        for name in ('x.py', 'x.log', 'x.yaml'):
            self.assertCode('unsupported_format', lambda: self.call('artifact_write', {'path': name, 'content': 'x', 'source_refs': []}))
        self.assertEqual(self.call('artifact_write', {'path': 'x.md', 'content': 'x', 'source_refs': []})['version'], 1)

    def test_office_artifact_paths_stay_unsupported(self):
        self.assertCode('unsupported_format', lambda: self.call('artifact_write', {'path': 'x.docx', 'content': 'x', 'source_refs': []}))

    def test_cancelled_run_and_unknown_tools_cannot_execute(self):
        self.service.cancel_run('run')
        self.assertCode('run_cancelled', lambda: self.call('workspace_list', {}))
        self.assertCode('unknown_tool', lambda: self.call('Bash', {'command': 'echo x'}, run='other'))
        self.assertCode('invalid_arguments', lambda: self.call('workspace_list', {'root': '/'}, run='other'))

    def test_missing_roots_are_rejected(self):
        self.assertCode('invalid_roots', lambda: self.service.create_scope([], str(self.output)))
        self.assertCode('invalid_root', lambda: self.service.create_scope([str(self.root / 'missing')], str(self.output)))

    def test_folder_scope_without_output_root_writes_to_drop_outputs(self):
        scope = self.service.create_scope(roots=[str(self.inputs)])
        self.assertEqual(scope['kind'], 'directory')
        self.assertEqual(scope['output']['path'], str((self.root / 'state' / 'drop-outputs' / scope['scope_id']).resolve()))

    def test_source_version_changes_on_reread(self):
        source = self.source(content='before')
        first = self.call('workspace_read', {'source_id': source})
        (self.inputs / 'note.md').write_text('after', encoding='utf-8')
        second = self.call('workspace_read', {'source_id': source})
        self.assertEqual(second['version'], first['version'] + 1)
        self.assertNotEqual(second['sha256'], first['sha256'])

    def test_input_fingerprint_and_freshness_are_independent_of_artifacts(self):
        source = self.source(content='one')
        self.call('workspace_read', {'source_id': source})
        before = self.service.run_fingerprint('run')['sha256']
        self.assertTrue(self.service.validate_inputs('run')['ok'])
        (self.inputs / 'note.md').write_text('two', encoding='utf-8')
        self.assertFalse(self.service.validate_inputs('run')['ok'])
        self.call('workspace_read', {'source_id': source})
        self.assertNotEqual(self.service.run_fingerprint('run')['sha256'], before)
        self.assertTrue(self.service.validate_inputs('run')['ok'])
        self.service.revoke_scope(self.scope)
        self.assertFalse(self.service.validate_inputs('run')['ok'])

    def test_run_files_lists_reads_writes_and_modifies_with_line_counts(self):
        source = self.source(content='one')
        self.call('workspace_read', {'source_id': source})
        self.call('artifact_write', {'path': 'new.md', 'content': 'a\nb\nc\n', 'source_refs': [source]})
        self.call('artifact_write', {'path': 'out/edited.md', 'content': 'x', 'source_refs': []})
        self.call('artifact_write', {'path': 'out/edited.md', 'content': 'y\nz', 'source_refs': [],
                                     'expected_version': 1})
        written = Path(self.service.run_artifacts('run')[0]['absolute_path']).parent
        self.assertEqual(self.service.run_files('run'), [
            {'path': str(self.inputs.resolve() / 'note.md'), 'op': 'read', 'added': None, 'removed': None},
            {'path': str(written / 'new.md'), 'op': 'write', 'added': 3, 'removed': 0},
            {'path': str(written / 'out/edited.md'), 'op': 'modify', 'added': None, 'removed': None}])
        (written / 'new.md').write_text('changed later', encoding='utf-8')
        self.assertEqual(self.service.run_files('run')[1]['added'], None)
        self.assertEqual(self.service.run_files('other'), [])

    def write(self, content, **kwargs):
        return self.call('artifact_write', {'path': 'out/report.md', 'content': content, 'source_refs': [], **kwargs})

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
        source = self.source(content='evidence')
        self.call('workspace_read', {'source_id': source})
        first = self.call('artifact_write', {'path': 'out/report.md', 'content': 'first', 'source_refs': [source]})
        self.write('second', expected_version=1)
        reverted = self.service.revert_artifact('run', 'out/report.md', scope_id=self.scope, expected_version=2)
        path = Path(first['absolute_path'])
        self.assertEqual(path.read_text(encoding='utf-8'), 'first')
        self.assertEqual(reverted['version'], 3)
        self.assertEqual(reverted['source_refs'], [source])
        self.assertEqual(reverted['input_manifest'], first['input_manifest'])
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

    def test_kept_versions_are_neither_sources_nor_artifacts(self):
        self.scope = self.service.create_scope([str(self.inputs)], str(self.inputs / 'made'))['scope_id']
        self.write('first'); self.write('second', expected_version=1)
        (Path(self.service.run_artifacts('run')[0]['absolute_path']).parent / '.versions' / 'kept.md').write_text('x', encoding='utf-8')
        listed = self.call('workspace_list', {})
        self.assertEqual([s['path'] for s in listed['sources'] if '.versions' in s['path']], [])
        self.assertEqual([s['path'] for s in listed['skipped'] if '.versions' in s['path']], [])
        self.assertEqual([a['path'] for a in self.service.run_artifacts('run')], ['out/report.md'])
        self.assertEqual([f['path'] for f in self.service.run_files('run') if '.versions' in f['path']], [])

    def test_scope_and_dependency_survive_service_restart(self):
        source = self.source(); first = self.call('workspace_read', {'source_id': source})
        self.service.close(); self.service = WorkspaceService(self.root / 'state')
        self.assertEqual(self.call('workspace_read', {'source_id': source})['sha256'], first['sha256'])


class WorkspaceImageTests(WorkspaceCase):
    PIXELS = b'\x89PNG\r\n\x1a\nimage-fixture-bytes'

    def test_image_and_text_sources_are_listed_with_their_kind(self):
        (self.inputs / 'a.png').write_bytes(self.PIXELS); self.source()
        listed = self.call('workspace_list', {})['sources']
        self.assertEqual([(s['source_id'], s['kind']) for s in listed], [('r0:a.png', 'image'), ('r0:note.md', 'text')])

    def test_read_image_returns_the_original_bytes_and_records_the_run_source(self):
        import base64
        (self.inputs / 'a.png').write_bytes(self.PIXELS); (self.inputs / 'b.jpg').write_bytes(b'jpeg')
        self.call('workspace_list', {})
        result = self.service.read_image(self.scope, 'r0:a.png', 'run')
        self.assertEqual(result['trust'], 'source_material')
        self.assertEqual(result['content'][0]['type'], 'image')
        self.assertEqual(result['content'][0]['mimeType'], 'image/png')
        self.assertEqual(base64.b64decode(result['content'][0]['data']), self.PIXELS)
        self.assertEqual(self.service.run_fingerprint('run')['dependencies'],
                         [{'scope_id': self.scope, 'source_id': 'r0:a.png', 'sha256': result['sha256']}])
        self.assertEqual(self.service.read_image(self.scope, 'r0:b.jpg', 'run')['content'][0]['mimeType'], 'image/jpeg')

    def test_each_reader_refuses_the_other_kind(self):
        (self.inputs / 'a.png').write_bytes(self.PIXELS); source = self.source()
        self.assertCode('image_source', lambda: self.call('workspace_read', {'source_id': 'r0:a.png'}))
        self.assertCode('not_an_image', lambda: self.service.read_image(self.scope, source, 'run'))

    def test_search_returns_text_hits_beside_an_image(self):
        (self.inputs / 'a.png').write_bytes(self.PIXELS); self.source(content='quiet room')
        self.assertEqual([m['source_id'] for m in self.call('workspace_search', {'query': 'quiet'})['matches']], ['r0:note.md'])

    def test_an_image_over_the_limit_is_skipped_and_refused(self):
        (self.inputs / 'big.png').write_bytes(self.PIXELS)
        self.call('workspace_list', {})
        with patch('character_agent.services.workspace.MAX_IMAGE', 4):
            listing = self.call('workspace_list', {})
            self.assertCode('file_too_large', lambda: self.service.read_image(self.scope, 'r0:big.png', 'run'))
        self.assertEqual(listing['sources'], [])
        self.assertEqual(listing['skipped'], [{'path': 'big.png', 'reason': 'file_too_large'}])

    def test_image_artifact_paths_stay_unsupported(self):
        self.assertCode('unsupported_format', lambda: self.call('artifact_write', {'path': 'x.png', 'content': 'x', 'source_refs': []}))

    def test_workspace_image_tool_shows_the_image(self):
        (self.inputs / 'a.png').write_bytes(self.PIXELS)
        self.call('workspace_list', {})
        result = self.call('workspace_image', {'source_id': 'r0:a.png'})
        self.assertEqual(result['source_id'], 'r0:a.png')
        self.assertEqual(result['content'][0]['mimeType'], 'image/png')


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

    def test_drop_scope_reads_exactly_the_given_files(self):
        (self.folder / 'sub').mkdir(); (self.folder / 'sub' / 'deep.md').write_text('sibling deep', encoding='utf-8')
        scope = self.drop('note.md')
        self.assertEqual(scope['kind'], 'drop')
        self.assertEqual([f['path'] for f in scope['files']], [str((self.folder / 'note.md').resolve())])
        self.assertEqual(scope['expires_at'] - scope['created_at'], 86400)
        self.assertTrue(Path(scope['output']['path']).is_relative_to((self.root / 'state').resolve()))
        sources = self.call(scope, 'workspace_list', {})['sources']
        self.assertEqual([s['path'] for s in sources], ['note.md'])
        self.assertEqual(self.call(scope, 'workspace_read', {'source_id': sources[0]['source_id']})['text'], 'picked note')
        self.assertEqual(self.call(scope, 'workspace_search', {'query': 'sibling'})['matches'], [])
        self.assertCode('unknown_source', lambda: self.call(scope, 'workspace_read', {'source_id': 'r0:sibling.md'}))
        self.assertEqual(self.service.run_files('run')[0]['path'], scope['files'][0]['path'])

    def test_drop_scope_reports_unsupported_types(self):
        (self.folder / 'paper.pdf').write_bytes(b'%PDF-synthetic')
        (self.folder / 'clip.mov').write_bytes(b'moov')
        scope = self.drop('paper.pdf', 'note.md', 'clip.mov')
        self.assertEqual(scope['unsupported'], [
            {'path': str(self.folder / 'paper.pdf'), 'reason': 'unsupported_type'},
            {'path': str(self.folder / 'clip.mov'), 'reason': 'unsupported_type'}])
        self.assertEqual([s['path'] for s in self.call(scope, 'workspace_list', {})['sources']], ['note.md'])
        self.assertCode('no_supported_files', lambda: self.drop('paper.pdf'))

    def test_drop_scope_accepts_source_code_and_logs_but_not_env_files(self):
        (self.folder / 'tool.py').write_text('print(1)\n', encoding='utf-8', newline='')
        (self.folder / 'run.log').write_text('started\n', encoding='utf-8', newline='')
        (self.folder / '.env').write_text('TOKEN=x\n', encoding='utf-8')
        scope = self.drop('tool.py', 'run.log', '.env')
        self.assertEqual(scope['unsupported'], [{'path': str(self.folder / '.env'), 'reason': 'unsupported_type'}])
        sources = self.call(scope, 'workspace_list', {})['sources']
        self.assertEqual([s['path'] for s in sources], ['tool.py', 'run.log'])
        self.assertEqual([self.call(scope, 'workspace_read', {'source_id': s['source_id']})['text'] for s in sources],
                         ['print(1)\n', 'started\n'])

    def test_drop_scope_accepts_a_spreadsheet(self):
        (self.folder / 'stock.xlsx').write_bytes(xlsx())
        scope = self.drop('stock.xlsx')
        self.assertEqual(scope['unsupported'], [])
        source = self.call(scope, 'workspace_list', {})['sources'][0]['source_id']
        self.assertIn('苹果\t3.5\t7', self.call(scope, 'workspace_read', {'source_id': source})['text'])

    def test_drop_scope_accepts_an_image(self):
        (self.folder / 'a.png').write_bytes(b'\x89PNG')
        scope = self.drop('a.png')
        self.assertEqual(scope['unsupported'], [])
        self.assertEqual([s['kind'] for s in self.call(scope, 'workspace_list', {})['sources']], ['image'])

    def test_drop_scope_revoked_denies_reads(self):
        scope = self.drop('note.md')
        source = self.call(scope, 'workspace_list', {})['sources'][0]['source_id']
        self.service.revoke_scope(scope['scope_id'])
        self.assertCode('scope_revoked', lambda: self.call(scope, 'workspace_read', {'source_id': source}))
        self.assertCode('scope_revoked', lambda: self.call(scope, 'workspace_list', {}))

    def test_drop_scope_rejects_relative_missing_and_too_many_files(self):
        self.assertCode('invalid_file', lambda: self.service.create_scope(files=['note.md']))
        self.assertCode('invalid_file', lambda: self.drop('missing.md'))
        self.assertCode('invalid_files', lambda: self.drop(*['note.md'] * 17))

    def test_dropped_directory_becomes_a_root(self):
        scope = self.service.create_scope(files=[str(self.folder)])
        self.assertEqual(scope['kind'], 'drop')
        self.assertEqual([r['path'] for r in scope['roots']], [str(self.folder.resolve())])
        self.assertEqual(scope['files'], [])
        sources = {s['path']: s['source_id'] for s in self.call(scope, 'workspace_list', {})['sources']}
        self.assertEqual(sorted(sources), ['note.md', 'sibling.md'])
        self.assertEqual(self.call(scope, 'workspace_read', {'source_id': sources['note.md']})['text'], 'picked note')
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
