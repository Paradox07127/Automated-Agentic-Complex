import json
from pathlib import Path
import sys
from unittest import mock
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_agent.services.workspace import WorkspaceError, validate_text
from test_character_agent_workspace import WorkspaceCase


class ArtifactTests(WorkspaceCase):
    def write(self, path='report.md', content='# Report\nA useful conclusion.', **kwargs):
        return self.call('artifact_write', {'path': path, 'content': content, 'source_refs': [], **kwargs})

    def test_inapplicable_csv_assertions_do_not_poison_markdown_repair(self):
        self.write()
        self.assertCode('checks_require_csv_artifact',lambda:self.call('artifact_verify',
            {'path':'report.md','checks':{'numeric_columns':['金额'],'row_count':4}}))
        row=self.service.run_artifacts('run')[0]
        self.assertIsNone(row['validation'])
        self.assertTrue(self.call('artifact_verify',{'path':'report.md','checks':{'required_sections':['Report']}})['ok'])
        self.assertCode('checks_conflict',lambda:self.call('artifact_verify',{'path':'report.md','checks':{'required_sections':[]}}))

    def test_empty_csv_check_lists_are_inert_for_markdown(self):
        self.write()
        self.assertTrue(self.call('artifact_verify',{'path':'report.md','checks':{'numeric_columns':[],'required_columns':[],'calculations':[]}})['ok'])

    def test_host_csv_contract_for_markdown_is_rejected_before_execution(self):
        self.assertCode('checks_require_csv_artifact',lambda:self.service.set_expectations('run',
            {'artifacts':[{'path':'report.md','checks':{'required_columns':['金额']}}]}))

    def test_missing_artifact_never_succeeds(self):
        result = self.service.verify_run('run', self.scope)
        self.assertFalse(result['ok']); self.assertFalse(result['self_checked'])

    def test_write_read_verify_and_final_verification_are_separate(self):
        receipt = self.write()
        self.assertTrue(Path(receipt['absolute_path']).exists())
        self.assertIsNone(self.service.run_artifacts('run')[0]['validation'])
        final = self.service.verify_run('run', self.scope)
        self.assertTrue(final['ok']); self.assertFalse(final['self_checked'])
        result = self.call('artifact_verify', {'path': 'report.md', 'checks': {'required_sections': ['Report']}})
        self.assertTrue(result['ok'])
        self.assertTrue(self.service.verify_run('run', self.scope)['self_checked'])

    def test_empty_file_missing_file_and_tampering_fail(self):
        receipt = self.write(content='')
        self.assertFalse(self.service.verify_run('run')['ok'])
        Path(receipt['absolute_path']).write_text('externally changed', encoding='utf-8')
        self.assertFalse(self.service.verify_run('run')['ok'])
        Path(receipt['absolute_path']).unlink()
        self.assertFalse(self.service.verify_run('run')['ok'])

    def test_rewrite_requires_version_and_invalidates_old_validation(self):
        first = self.write()
        self.call('artifact_verify', {'path': 'report.md'})
        self.assertCode('version_conflict', lambda: self.write(content='new content'))
        second = self.write(content='new content', expected_version=first['version'])
        self.assertEqual(second['version'], 2); self.assertIsNone(second['validation'])
        self.assertFalse(self.service.run_artifacts('run')[0]['self_checked'])
        self.assertCode('version_conflict', lambda: self.write(content='third content', expected_version=1))

    def test_repeated_effect_is_idempotent_and_cannot_change_parameters(self):
        args = {'path': 'report.md', 'content': 'one', 'source_refs': []}
        first = self.call('artifact_write', args, effect_id='tool-1')
        second = self.call('artifact_write', args, effect_id='tool-1')
        self.assertEqual(first, second)
        self.assertEqual(len(self.service.run_artifacts('run')), 1)
        self.assertCode('effect_conflict', lambda: self.call('artifact_write', {**args, 'content': 'two'}, effect_id='tool-1'))

    def test_read_source_required_and_changed_input_stales_result(self):
        source = self.source()
        self.assertCode('source_not_read', lambda: self.write(content=source, source_refs=[source]))
        self.call('workspace_read', {'source_id': source})
        self.write(content=source, source_refs=[source])
        self.assertTrue(self.call('artifact_verify', {'path': 'report.md'})['ok'])
        (self.inputs / 'note.md').write_text('changed evidence', encoding='utf-8')
        self.assertFalse(self.service.verify_run('run')['ok'])
        self.call('workspace_read', {'source_id': source})
        self.assertFalse(self.service.verify_run('run')['ok'])  # re-reading alone cannot approve the old output
        self.write(content=source, source_refs=[source], expected_version=1)
        self.assertTrue(self.service.verify_run('run')['ok'])

    def test_fixed_numeric_csv_keeps_provenance_out_of_its_content(self):
        source = self.source()
        self.assertCode('source_not_read', lambda: self.write('totals.csv', 'gross,refund,net\n262,12,250\n', source_refs=[source]))
        self.call('workspace_read', {'source_id': source})
        spec = {'required_columns': ['gross', 'refund', 'net'], 'numeric_columns': ['gross', 'refund', 'net'], 'row_count': 1,
                'required_source_ids': [source],
                'calculations': [{'column': 'net', 'sum': [{'column': 'gross'}, {'column': 'refund', 'multiply': -1}]}]}
        self.write('totals.csv', 'gross,refund,net\n262,12,250\n', source_refs=[source])
        self.assertTrue(self.call('artifact_verify', {'path': 'totals.csv', 'checks': spec})['ok'])
        self.assertEqual(self.service.run_artifacts('run')[0]['source_refs'], [source])
        self.assertTrue(self.service.verify_run('run')['ok'])
        (self.inputs / 'note.md').write_text('changed evidence', encoding='utf-8')
        self.assertFalse(self.service.verify_run('run')['ok'])

    def test_explicit_inline_source_requirement_is_still_enforced(self):
        source = self.source()
        self.call('workspace_read', {'source_id': source})
        self.write(content='A conclusion without inline citations.', source_refs=[source])
        result = self.call('artifact_verify', {'path': 'report.md', 'checks': {'required_inline_source_ids': [source]}})
        self.assertIn({'check': 'source_reference', 'source_id': source, 'ok': False}, result['checks'])
        self.assertFalse(result['ok'])

    def test_required_provenance_must_be_declared_on_the_artifact_not_only_read(self):
        source = self.source()
        self.call('workspace_read', {'source_id': source})
        self.write(content='A conclusion without provenance.')
        result = self.call('artifact_verify', {'path':'report.md','checks':{'required_source_ids':[source]}})
        self.assertFalse(result['ok'])
        self.assertIn({'check':'source_provenance','source_id':source,'ok':False},result['checks'])

    def test_idempotent_receipt_cannot_hide_external_tampering(self):
        args = {'path': 'report.md', 'content': 'original', 'source_refs': []}
        first = self.call('artifact_write', args, effect_id='same')
        Path(first['absolute_path']).write_text('changed externally', encoding='utf-8')
        self.assertCode('artifact_changed', lambda: self.call('artifact_write', args, effect_id='same'))

    def test_scope_mismatch_and_output_path_escapes_are_rejected(self):
        self.assertCode('invalid_path', lambda: self.write(path='../outside.md'))
        self.assertCode('invalid_path', lambda: self.write(path='/outside.md'))
        self.assertCode('unsupported_format', lambda: self.write(path='command.sh'))
        receipt = self.write()
        run_dir = Path(receipt['absolute_path']).parent
        outside = self.root / 'outside'; outside.mkdir()
        (run_dir / 'redirect').symlink_to(outside)
        self.assertCode('path_not_allowed', lambda: self.write(path='redirect/escape.md'))
        self.assertFalse((outside / 'escape.md').exists())
        other = self.service.create_scope([str(self.inputs)], str(self.root / 'other-output'))['scope_id']
        self.assertCode('unknown_artifact', lambda: self.service.read_artifact('run', 'report.md', scope_id=other))

    def test_new_output_race_does_not_overwrite_unowned_file(self):
        import os
        original = os.link
        def publish(source, destination):
            Path(destination).write_bytes(b'belongs to another writer')
            return original(source, destination)
        with mock.patch('character_agent.services.workspace.os.link', side_effect=publish):
            self.assertCode('output_exists', lambda: self.write())
        self.assertEqual(next(self.output.rglob('report.md')).read_text(encoding='utf-8'), 'belongs to another writer')
        self.assertEqual(self.service.run_artifacts('run'), [])

    def test_cancel_before_commit_produces_no_artifact(self):
        calls = [0]
        def current():
            calls[0] += 1
            return calls[0] < 3
        self.assertCode('run_cancelled', lambda: self.call('artifact_write',
                        {'path': 'report.md', 'content': 'cancelled', 'source_refs': []}, is_current=current))
        self.assertEqual(self.service.run_artifacts('run'), [])
        self.assertEqual(list(self.output.rglob('*.md')), [])

    def test_host_contract_cannot_be_weakened_by_model_checks(self):
        self.service.set_expectations('run', {'artifacts': [{'path': 'report.md', 'checks': {'required_sections': ['Evidence']}}]})
        self.write()
        self.assertFalse(self.call('artifact_verify', {'path': 'report.md', 'checks': {}})['ok'])
        self.assertCode('expectations_frozen', lambda: self.service.set_expectations('run', {'artifacts': [{'path': 'other.md'}]}))
        self.assertFalse(self.service.verify_run('run')['ok'])

    def test_registered_checks_and_unknown_source_cannot_be_silently_approved(self):
        self.write(content='Required\nunknown-reference')
        self.call('artifact_verify', {'path': 'report.md', 'checks': {'required_sections': ['Required']}})
        self.assertCode('checks_conflict', lambda: self.call('artifact_verify', {'path': 'report.md', 'checks': {'required_sections': []}}))
        result = self.call('artifact_verify', {'path': 'report.md', 'checks': {'required_source_ids': ['unknown-reference']}})
        self.assertFalse(result['ok'])

    def test_csv_math_failure_can_be_fixed_then_rechecked(self):
        text = 'hourly,one_time,total\n45,30,90\n'
        spec = {'required_columns': ['hourly', 'one_time', 'total'], 'row_count': 1,
                'calculations': [{'column': 'total', 'sum': [{'column': 'hourly', 'multiply': 2}, {'column': 'one_time'}]}]}
        first = self.write('comparison.csv', text)
        failed = self.call('artifact_verify', {'path': 'comparison.csv', 'checks': spec})
        self.assertFalse(failed['ok'])
        calculation = next(c for c in failed['checks'] if c['check'] == 'calculation')
        self.assertEqual(calculation['expected'], 120)
        self.write('comparison.csv', text.replace(',90', ',120'), expected_version=first['version'])
        self.assertTrue(self.call('artifact_verify', {'path': 'comparison.csv'})['ok'])
        self.assertTrue(self.service.verify_run('run')['ok'])

    def test_malformed_csv_json_and_nonfinite_numbers_fail(self):
        self.assertFalse(all(c['ok'] for c in validate_text('x.csv', 'a,a\n1,2\n', {})))
        self.assertFalse(all(c['ok'] for c in validate_text('x.csv', 'a,b\n1\n', {})))
        self.assertFalse(all(c['ok'] for c in validate_text('x.csv', 'a\nNaN\n', {'numeric_columns': ['a']})))
        self.assertFalse(all(c['ok'] for c in validate_text('x.json', '{"a":NaN}', {})))
        with self.assertRaises(WorkspaceError): validate_text('x.csv', 'a\n1\n', {'calculations': [{'column': 'a', 'sum': [{'eval': '1'}]}]})

    def test_success_after_write_but_before_receipt_is_reconciled_not_replayed(self):
        with mock.patch.object(self.service, '_commit_receipt', side_effect=RuntimeError('simulated crash')):
            with self.assertRaises(RuntimeError): self.write()
        self.assertFalse(self.service.verify_run('run')['ok'])
        result = self.service.reconcile('run')
        self.assertEqual(result[0]['state'], 'committed')
        self.assertEqual(len(self.service.run_artifacts('run')), 1)
        self.assertTrue(self.service.verify_run('run')['ok'])

    def test_unknown_effect_without_matching_output_is_not_replayed(self):
        with mock.patch('character_agent.services.workspace.os.link', side_effect=OSError('simulated crash')):
            with self.assertRaises(OSError): self.write()
        self.assertEqual(self.service.reconcile('run')[0]['state'], 'unknown')
        self.assertFalse(self.service.verify_run('run')['ok'])
        self.assertCode('effect_unknown', lambda: self.write())

    def test_synthetic_venue_fixture_contract(self):
        fixture = Path(__file__).parent / 'fixtures' / 'character_agent'
        for source in fixture.glob('venue_*.md'):
            (self.inputs / source.name).write_bytes(source.read_bytes())
        self.service.set_expectations('run', json.loads((fixture / 'acceptance.json').read_text(encoding='utf-8')))
        refs = [x['source_id'] for x in self.call('workspace_list', {})['sources']]
        for source_id in refs: self.call('workspace_read', {'source_id': source_id})
        self.write('report.md', '# 结论\n青禾符合八人和安静的要求。资料未提供实际可订时段。\n'+'\n'.join(refs), source_refs=refs)
        csv = 'source_id,venue,capacity,hourly,one_time,total,fits_eight\n' + '\n'.join([
            'r0:venue_a.md,月台,6,45,30,120,false', 'r0:venue_b.md,青禾,10,60,0,120,true', 'r0:venue_c.md,松间,8,50,10,110,true'])+'\n'
        self.write('comparison.csv', csv, source_refs=refs)
        for path in ('report.md', 'comparison.csv'): self.assertTrue(self.call('artifact_verify', {'path': path})['ok'])
        self.assertTrue(self.service.verify_run('run')['ok'])
        self.assertTrue(self.service.verify_run('run')['self_checked'])


if __name__ == '__main__': unittest.main()
