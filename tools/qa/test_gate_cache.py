"""gate.py's per-suite result cache against a stub tree with its own suites.json."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

from test_gate_runner import gate_receipt, source_fingerprint, tree, write


def stub_suite(sid, **extra):
    """A suite that notes its id in <tmp>/ran and fails while <tmp>/fail-<id> exists."""
    return dict(run=['bash', '-c', f'echo {sid} >> {{repo}}/../ran; test ! -e {{repo}}/../fail-{sid}'], parse='exit',
                line={'pass': f'{sid.upper()} ok', 'fail': f'{sid.upper()} fail'}, **extra)


SUITES = {
    'schema': 'endfield-gate-suites/v1',
    'full_on': ['tools/qa/gate.py', 'tools/qa/suites.json', 'tools/release/gate_receipt.py',
                'tools/release/source_fingerprint.py', 'tools/platform/'],
    'no_suite': [],
    'suites': {
        'a': stub_suite('a', paths=['a/']),
        'b': stub_suite('b', paths=['b/']),
        'n': stub_suite('n'),
        'f': stub_suite('f', paths=['f/'], fatal=True),
        'dep': stub_suite('dep', paths=['d/']),
        'user': stub_suite('user', paths=['u/'], requires=['dep']),
        'l': stub_suite('l', paths=['l/']),
        'e': dict(stub_suite('e', paths=['e/']),
                  run=['bash', '-c', 'echo e >> {repo}/../ran; echo "x = $RANDOM" > agent/agentd/edited.py']),
        't': dict(stub_suite('t', paths=['t/']),
                  run=['bash', '-c', 'echo t >> {repo}/../ran; echo "$RANDOM" > t/x.txt']),
    },
    'profiles': {
        'p': {'phases': [{'lanes': [['a', 'b', 'n', 'f'], ['dep', 'user']]},
                         {'lanes': [[{'lock': 'stub', 'label': 'stub-{name}', 'suites': ['l']}]]}]},
        'edit': {'phases': [{'lanes': [['a', 'e']]}]},
        'inputs': {'phases': [{'lanes': [['a', 't']]}]},
    },
}
STORED = {'a', 'b', 'dep', 'user'}
ALWAYS = {'n', 'f', 'l'}


class Cache(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name, 'checkout').resolve()
        self.logs = Path(self.tmp.name, 'logs').resolve()
        tree(self.root)
        write(self.root / 'tools/qa/suites.json', json.dumps(SUITES, indent=1))
        for folder in ('a', 'b', 'f', 'd', 'u', 'l', 'e', 't'):
            write(self.root / folder / 'x.txt', f'{folder}\n')
        for args in (['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'suites']):
            subprocess.run(['git', '-C', str(self.root), *args], check=True, capture_output=True)
        self.cache = self.root / '.local/cache/gate-results'

    def tearDown(self):
        self.tmp.cleanup()

    def gate(self, *args, profile='p', python=sys.executable):
        Path(self.tmp.name, 'ran').unlink(missing_ok=True)
        env = dict(os.environ, AGENTD_PYTHON=str(python))
        result = subprocess.run([sys.executable, '-I', str(self.root / 'tools/qa/gate.py'), '--checkout', str(self.root),
                                 '--logs', str(self.logs), '--profile', profile, *args],
                                capture_output=True, text=True, env=env, timeout=300)
        ran = Path(self.tmp.name, 'ran')
        self.ran = set(ran.read_text().split()) if ran.exists() else set()
        return result

    def gate_after_lock(self, edit):
        """(exit code, stdout) of the stub tree's gate.py run in this process; its checkout lock calls edit, then yields."""
        Path(self.tmp.name, 'ran').unlink(missing_ok=True)
        spec = importlib.util.spec_from_file_location('stub_gate', self.root / 'tools/qa/gate.py')
        stub = importlib.util.module_from_spec(spec)
        with mock.patch.object(sys, 'path', list(sys.path)):
            spec.loader.exec_module(stub)

        @contextlib.contextmanager
        def lock(repo, profile):
            edit()
            yield 0.0

        out = io.StringIO()
        with mock.patch.object(stub, 'checkout_lock', lock), mock.patch.dict(os.environ, AGENTD_PYTHON=sys.executable), \
                contextlib.redirect_stdout(out):
            code = stub.main(['--checkout', str(self.root), '--logs', str(self.logs), '--profile', 'p'])
        ran = Path(self.tmp.name, 'ran')
        self.ran = set(ran.read_text().split()) if ran.exists() else set()
        return code, out.getvalue()

    def receipt(self):
        return json.loads((self.logs / 'gate-receipt.json').read_text())

    def reused(self):
        return {s['id'] for s in self.receipt()['suites'] if s['cached']}

    def stored(self):
        return {p.parent.name for p in self.cache.glob('*/*.json')}

    def test_a_second_run_of_the_same_tree_reuses_every_cacheable_suite(self):
        first = self.gate()
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        self.assertEqual(self.ran, STORED | ALWAYS)
        self.assertFalse(any(line.startswith('CACHE:') for line in first.stdout.splitlines()))
        self.assertEqual(self.stored(), STORED)
        receipt = self.receipt()
        self.assertEqual(receipt['cache'], {'enabled': True, 'reused': []})
        self.assertEqual(len(receipt['timing']['phases_s']), 2)
        self.assertGreaterEqual(receipt['timing']['setup_s'], 0)
        self.assertGreaterEqual(receipt['timing']['teardown_s'], 0)

        second = self.gate()
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assertEqual(self.ran, ALWAYS)
        lines = second.stdout.splitlines()
        self.assertEqual(lines[0], 'CACHE: 4 of 7 suites reused')
        self.assertEqual(lines[1:], first.stdout.splitlines())
        receipt = self.receipt()
        self.assertFalse(receipt['partial'])
        self.assertEqual(gate_receipt.validate(receipt, receipt['source']['fingerprint']), [])
        self.assertEqual(sorted(receipt['cache']['reused']), sorted(STORED))
        a = next(s for s in receipt['suites'] if s['id'] == 'a')
        self.assertEqual((a['status'], a['seconds'], a['lines']), ('PASS', 0, ['A ok']))
        self.assertEqual(set(a['cached']), {'key', 'from_checkout', 'from_started_at', 'seconds'})
        self.assertEqual(a['cached']['from_checkout'], str(self.root))
        self.assertTrue((self.cache / 'a' / f'{a["cached"]["key"]}.json').exists())

    def test_a_changed_file_under_a_suites_paths_reruns_only_that_suite(self):
        self.gate()
        write(self.root / 'a/x.txt', 'changed\n')
        self.assertEqual(self.gate().returncode, 0)
        self.assertEqual(self.ran, {'a'} | ALWAYS)
        write(self.root / 'b/new.txt', 'untracked\n')
        self.assertEqual(self.gate().returncode, 0)
        self.assertEqual(self.ran, {'b'} | ALWAYS)
        (self.root / 'b/x.txt').unlink()
        self.assertEqual(self.gate().returncode, 0)
        self.assertEqual(self.ran, {'b'} | ALWAYS)

    def test_no_cache_reruns_everything_and_still_stores(self):
        self.gate()
        result = self.gate('--no-cache')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.ran, STORED | ALWAYS)
        self.assertFalse(any(line.startswith('CACHE:') for line in result.stdout.splitlines()))
        self.assertEqual(self.receipt()['cache'], {'enabled': False, 'reused': []})
        self.assertEqual(self.stored(), STORED)

    def test_storing_a_suite_deletes_its_results_older_than_the_limit(self):
        stale = self.cache / 'a/stale.json'
        write(stale, '{}\n')
        old = time.time() - 15 * 86400
        os.utime(stale, (old, old))
        fresh = self.cache / 'b/fresh.json'
        write(fresh, '{}\n')
        self.gate('--no-cache')
        self.assertFalse(stale.exists())
        self.assertTrue(fresh.exists())

    def test_a_failed_suite_is_not_stored_and_runs_again(self):
        Path(self.tmp.name, 'fail-b').write_text('')
        self.assertEqual(self.gate().returncode, 1)
        self.assertEqual(self.stored(), STORED - {'b'})
        Path(self.tmp.name, 'fail-b').unlink()
        result = self.gate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.ran, {'b'} | ALWAYS)
        self.assertEqual(self.reused(), STORED - {'b'})

    def test_a_failure_under_a_stored_key_deletes_that_pass(self):
        self.gate()
        Path(self.tmp.name, 'fail-b').write_text('')
        self.assertEqual(self.gate('--no-cache').returncode, 1)
        self.assertEqual(self.stored(), STORED - {'b'})
        Path(self.tmp.name, 'fail-b').unlink()
        self.assertEqual(self.gate().returncode, 0)
        self.assertEqual(self.ran, {'b'} | ALWAYS)

    def test_checkouts_with_their_own_venv_link_to_one_interpreter_share_results(self):
        links = Path(self.tmp.name, 'venvs')
        for name in ('main', 'gr'):
            (links / name).mkdir(parents=True)
            (links / name / 'python').symlink_to(sys.executable)
        self.gate(python=links / 'main/python')
        self.gate(python=links / 'gr/python')
        self.assertEqual(self.ran, ALWAYS)

    def test_the_release_profile_picks_the_fingerprint_but_no_suite_sees_it_and_results_are_shared(self):
        doc = json.loads(json.dumps(SUITES))
        doc['suites']['env'] = dict(stub_suite('env', paths=['a/']),
                                    run=['bash', '-c', 'echo env >> {repo}/../ran; test -z "${AAC_RELEASE_PROFILE+set}"'])
        doc['profiles']['env'] = {'phases': [{'lanes': [['a', 'env']]}]}
        write(self.root / 'tools/qa/suites.json', json.dumps(doc, indent=1))
        write(self.root / 'app/electron/src/main.ts', 'main\n')
        for args in (['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'electron']):
            subprocess.run(['git', '-C', str(self.root), *args], check=True, capture_output=True)
        profile = Path(self.tmp.name, 'electron.json')
        profile.write_text(json.dumps({'schema': 'endfield-release-config/v1'}))
        with mock.patch.dict(os.environ, AAC_RELEASE_PROFILE=str(profile)):
            electron = self.gate(profile='env')
            fingerprint = source_fingerprint.compute(self.root)[1]
        self.assertEqual(electron.returncode, 0, electron.stdout + electron.stderr)
        self.assertEqual(self.ran, {'a', 'env'})
        source = self.receipt()['source']
        self.assertEqual(source['fingerprint'], fingerprint)
        default = self.gate(profile='env')
        self.assertEqual(default.returncode, 0, default.stdout + default.stderr)
        self.assertEqual(self.ran, set())
        source = self.receipt()['source']
        self.assertEqual(source['fingerprint'], source_fingerprint.compute(self.root)[1])
        self.assertNotEqual(source['fingerprint'], fingerprint)

    def test_a_run_whose_sources_changed_stores_nothing(self):
        result = self.gate(profile='edit')
        self.assertIn('SOURCES-CHANGED FAIL', result.stdout.splitlines())
        self.assertEqual(self.stored(), set())
        self.gate(profile='edit')
        self.assertIn('a', self.ran)

    def test_a_run_that_edits_a_suite_input_fails_and_stores_nothing(self):
        result = self.gate(profile='inputs')
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn('SOURCES-CHANGED FAIL', result.stdout.splitlines())
        self.assertEqual(self.stored(), set())

    def test_an_edit_while_the_run_waits_for_the_lock_is_not_answered_from_the_cache(self):
        self.gate()
        code, out = self.gate_after_lock(lambda: write(self.root / 'a/x.txt', 'changed\n'))
        self.assertEqual(code, 0, out)
        self.assertIn('a', self.ran)
        self.assertNotIn('a', self.reused())

    def test_an_edit_while_the_run_waits_for_the_lock_is_stored_under_the_edited_key(self):
        code, out = self.gate_after_lock(lambda: write(self.root / 'a/x.txt', 'changed\n'))
        self.assertEqual(code, 0, out)
        self.gate()
        self.assertNotIn('a', self.ran)
        write(self.root / 'a/x.txt', 'a\n')
        self.gate()
        self.assertIn('a', self.ran)

    def test_a_changed_prerequisite_input_reruns_its_dependent(self):
        self.gate()
        write(self.root / 'd/x.txt', 'changed\n')
        result = self.gate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.ran, {'dep', 'user'} | ALWAYS)
        self.assertEqual(self.reused(), {'a', 'b'})

    def test_a_suite_required_by_a_running_suite_runs_and_a_locked_suite_is_never_stored(self):
        self.gate()
        write(self.root / 'u/x.txt', 'changed\n')
        result = self.gate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.ran, {'user', 'dep'} | ALWAYS)
        self.assertEqual(self.reused(), {'a', 'b'})
        self.assertFalse((self.cache / 'l').exists())

    def test_dry_run_marks_the_cached_suites(self):
        self.gate()
        result = self.gate('--dry-run')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        marked = {line.split(':')[0].strip() for line in result.stdout.splitlines() if '(cached)' in line}
        self.assertEqual(marked, STORED)


if __name__ == '__main__':
    unittest.main()
