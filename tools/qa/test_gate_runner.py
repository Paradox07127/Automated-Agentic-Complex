"""gate.py against stub trees: a copy of the runner, its suites.json and stub suites, as app/Tests/t_gate.sh does for gate.sh."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'tools/release'))
import gate
import gate_receipt
import source_fingerprint

RUNNER_FILES = ['tools/qa/gate.py', 'tools/qa/suites.json', 'tools/release/gate_receipt.py',
                'tools/release/source_fingerprint.py', 'tools/release/release.py', 'tools/platform/agentd-python.sh']
# The awk program of app/Tests/gate.sh's metal().
GATE_SH_AWK = r'''
        /error: -\[/ && shown < 8 { sub(/^.*error: /, ""); printf "%s case: %s\n", l, substr($0, 1, 240); shown++ }
        /Test Suite .*\.xctest. (passed|failed)/ { b = 1; next }
        b && /Executed [0-9]+ tests?/ { match($0, /Executed [0-9]+/); n += substr($0, RSTART + 9, RLENGTH - 9)
            if (match($0, /[0-9]+ failures?/)) f += substr($0, RSTART, RLENGTH) + 0; b = 0 }
        END { if (n == 0) printf "%s: FAIL no tests ran\n", l; else printf "%s: %d tests, %d failed\n", l, n, f }'''


def write(path, text, mode=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    if mode: path.chmod(mode)


def profile_ids(doc, name):
    return [s['id'] for lanes in gate.plan(doc, name, True, None) for items in lanes for e in items
            for s in ([e[1]] if e[0] != 'block' else e[2])]


def unit_module(tests):
    body = ''.join(f'    def test_{n}(self):\n        pass\n' for n in range(tests))
    return f'import unittest\n\n\nclass T(unittest.TestCase):\n{body}'


def tree(root):
    """A git checkout at main with the runner files, every fingerprint extra file and two passing agentd modules."""
    for relative in RUNNER_FILES:
        (root / relative).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO / relative, root / relative)
    for relative in source_fingerprint.EXTRA_FILES:
        write(root / relative, 'stub\n')
    write(root / 'agent/agentd/tests/test_a.py', unit_module(2))
    write(root / 'agent/agentd/tests/test_b.py', unit_module(1))
    write(root / 'tools/platform/gpu-lock.sh', '#!/bin/bash\nshift\nexec "$@"\n', 0o755)
    write(root / '.gitignore', '/.local/\n__pycache__/\n')
    for args in (['init', '-q', '-b', 'main'], ['add', '-A'],
                 ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'stub']):
        subprocess.run(['git', '-C', str(root), *args], check=True, capture_output=True)


class StubTree(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name, 'checkout').resolve()
        self.logs = Path(self.tmp.name, 'logs').resolve()
        tree(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def gate(self, *args):
        env = dict(os.environ, AGENTD_PYTHON=sys.executable, PATH=f'{self.root}/bin:{os.environ["PATH"]}')
        return subprocess.run([sys.executable, '-I', str(self.root / 'tools/qa/gate.py'), '--checkout', str(self.root),
                               '--logs', str(self.logs), *args], capture_output=True, text=True, env=env, timeout=300)

    def receipt(self):
        return json.loads((self.logs / 'gate-receipt.json').read_text())

    def test_agentd_profile_prints_the_agentd_gate_lines_and_a_receipt_of_the_tree(self):
        result = self.gate('--profile', 'agentd')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout.splitlines(), ['agentd: Ran 3 tests in 2 modules',
                                                      f'receipt: {self.logs}/gate-receipt.json', 'GATE PASS'])
        receipt = self.receipt()
        self.assertEqual(receipt['schema'], gate_receipt.SCHEMA)
        self.assertEqual(receipt['source']['fingerprint'], source_fingerprint.compute(self.root)[1])
        self.assertEqual((receipt['result'], receipt['partial'], receipt['logs_kept']), ('PASS', False, True))
        self.assertEqual([s['id'] for s in receipt['suites']], ['agentd-unit'])
        self.assertEqual(gate_receipt.validate(receipt, receipt['source']['fingerprint']), [])
        store = gate_receipt.store_dir(self.root)
        self.assertEqual(json.loads((store / 'agentd/gate-receipt.json').read_text()), receipt)
        self.assertEqual(gate_receipt.find(store, 'agentd', receipt['source']['fingerprint'])[1], receipt)

    def test_a_suite_that_edits_a_scoped_file_fails_the_run(self):
        write(self.root / 'agent/agentd/tests/test_edit.py',
              'from pathlib import Path\nimport unittest\n\n\nclass T(unittest.TestCase):\n    def test_edit(self):\n'
              '        Path(__file__).resolve().parents[1].joinpath("edited.py").write_text("x = 1\\n", encoding="utf-8")\n')
        result = self.gate('--profile', 'agentd')
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn('SOURCES-CHANGED FAIL', result.stdout.splitlines())
        self.assertEqual(result.stdout.splitlines()[-1], 'GATE FAIL')
        receipt = self.receipt()
        self.assertTrue(receipt['source']['changed_during_run'])
        self.assertTrue(gate_receipt.validate(receipt))

    def test_only_writes_a_partial_receipt_that_validate_rejects(self):
        result = self.gate('--profile', 'agentd', '--only', 'agentd-unit')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        receipt = self.receipt()
        self.assertTrue(receipt['partial'])
        self.assertTrue(any('partial' in problem for problem in gate_receipt.validate(receipt)))
        self.assertFalse((gate_receipt.store_dir(self.root) / 'agentd/gate-receipt.json').exists())

    def test_a_fatal_web_ci_failure_stops_its_lane(self):
        write(self.root / 'bin/node', '#!/bin/bash\ncase "$1" in -p) echo 24 ;; *) echo v24.1.0 ;; esac\n', 0o755)
        write(self.root / 'bin/npm', '#!/bin/bash\n[ "$1" = ci ] && exit 1\nexit 0\n', 0o755)
        write(self.root / 'web/package.json', '{}\n')
        result = self.gate('--profile', 'web')
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertEqual(result.stdout.splitlines(), ['WEB-NODE ok v24.1.0', 'WEB-CI fail',
                                                      f'receipt: {self.logs}/gate-receipt.json', 'GATE FAIL'])
        skipped = {s['id'] for s in self.receipt()['skipped_suites']}
        self.assertIn('web-types', skipped)
        self.assertIn('web-visual', skipped)

    def test_changed_skips_a_suite_the_diff_does_not_reach(self):
        write(self.root / 'docs/n.md', 'note\n')
        result = self.gate('--profile', 'agentd', '--changed', 'main')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout.splitlines(), ['SELECT: 0 of 1 suites for 1 changed files since main',
                                                      f'receipt: {self.logs}/gate-receipt.json', 'GATE PASS'])
        receipt = self.receipt()
        self.assertTrue(receipt['partial'])
        self.assertEqual(receipt['selection'], {'base': 'main', 'changed': ['docs/n.md'], 'full': None})
        self.assertEqual(receipt['skipped_suites'], [{'id': 'agentd-unit', 'reason': 'not reached by the changes'}])

    def test_changed_runs_a_suite_whose_paths_the_diff_touches(self):
        write(self.root / 'agent/agentd/tests/test_c.py', unit_module(1))
        result = self.gate('--profile', 'agentd', '--changed', 'main')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout.splitlines()[:2], ['SELECT: 1 of 1 suites for 1 changed files since main',
                                                          'agentd: Ran 4 tests in 3 modules'])

    def test_dev_profile_runs_nothing_without_changes(self):
        dev = profile_ids(gate.load_suites(gate.SUITES_FILE, private=self.root / 'private/suites.json'), 'dev')
        result = self.gate('--profile', 'dev', '--changed', 'HEAD')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout.splitlines(), [f'SELECT: 0 of {len(dev)} suites for 0 changed files since HEAD',
                                                      f'receipt: {self.logs}/gate-receipt.json', 'GATE PASS'])
        self.assertEqual(self.receipt()['suites'], [])


class Select(unittest.TestCase):
    DOC = {'suites': {'a': {'paths': ['agent/']}, 'w': {'paths': ['web/'], 'requires': ['ci']},
                      'ci': {'paths': ['web/package.json']}, 'any': {}},
           'no_suite': ['docs/'], 'full_on': ['tools/qa/suites.json']}

    def test_selects_the_suites_whose_paths_hold_a_changed_file(self):
        self.assertEqual(gate.select(self.DOC, ['agent/x.py']), ({'a', 'any'}, None))
        self.assertEqual(gate.select(self.DOC, ['web/src/a.ts']), ({'w', 'ci', 'any'}, None))
        self.assertEqual(gate.select(self.DOC, ['web/package.json']), ({'w', 'ci', 'any'}, None))
        self.assertEqual(gate.select(self.DOC, ['docs/a.md']), ({'any'}, None))

    def test_falls_back_to_the_full_profile(self):
        self.assertEqual(gate.select(self.DOC, ['agent/x.py', 'other/x']), (None, 'other/x is in no suite\'s paths'))
        self.assertEqual(gate.select(self.DOC, ['tools/qa/suites.json']), (None, 'tools/qa/suites.json changes the gate'))
        self.assertEqual(gate.select(self.DOC, []), (None, 'no changed files'))


class LockedBlock(unittest.TestCase):
    def test_failed_lock_command_cannot_return_a_pass(self):
        with tempfile.TemporaryDirectory() as logs:
            out = Path(logs, 'block-test.results.json')
            result = json.dumps([dict(id='one', lines=[], status='PASS', exit=0)])
            block = dict(label='test', lock='gpu')
            for code in (0, 75):
                with self.subTest(code=code):
                    out.write_text(result)
                    def failed(*args):
                        if code:
                            out.write_text(result)
                        return code, ''
                    with mock.patch.object(gate, 'run_command', failed):
                        [suite] = gate.run_block(block, [dict(id='one')], dict(logs=logs, repo=logs))
                    self.assertEqual(suite.status, 'FAIL')


class XctestSum(unittest.TestCase):
    CASES = {
        'pass': "Test Suite 'All tests' started\nTest Suite 'X.xctest' passed at 1\n"
                "\t Executed 12 tests, with 0 failures (0 unexpected) in 0.1 (0.2) seconds\n"
                "Test Suite 'All tests' passed\n\t Executed 12 tests, with 0 failures (0 unexpected)\n",
        'one failure': "/a/T.swift:3: error: -[M.T testX] : XCTAssertEqual failed: (\"1\") is not equal to (\"2\")\n"
                       "Test Suite 'X.xctest' failed\nExecuted 3 tests, with 1 failure (0 unexpected)\n",
        'no tests': "Test Suite 'X.xctest' passed\nExecuted 0 tests, with 0 failures (0 unexpected)\n",
        'one test': "Test Suite 'X.xctest' passed\nExecuted 1 test, with 0 failures (0 unexpected)\n",
        'two bundles': "Test Suite 'A.xctest' passed\nExecuted 2 tests, with 0 failures (0 unexpected)\n"
                       "Test Suite 'B.xctest' failed\nExecuted 5 tests, with 2 failures (0 unexpected)\n",
        'build error': 'error: build failed\n',
    }

    def test_lines_match_gate_sh_awk(self):
        for name, output in self.CASES.items():
            with self.subTest(name):
                awk = subprocess.run(['awk', '-v', 'l=METAL-HOST', GATE_SH_AWK], input=output, capture_output=True,
                                     text=True, check=True).stdout.splitlines()
                self.assertEqual(gate.PARSERS['xctest_sum']({'label': 'METAL-HOST'}, output, 0, None)['lines'], awk)

    def test_skip_limit_is_visible_in_suite_summary(self):
        for skipped, limit, status in ((1, 0, 'FAIL'), (7, 5, 'FAIL'), (0, 0, 'PASS'), (5, 5, 'PASS'), (7, None, 'PASS')):
            with self.subTest(skipped=skipped, limit=limit):
                skip_text = f'{skipped} test' + ('s' if skipped != 1 else '') + ' skipped and ' if skipped else ''
                output = ("Test Suite 'X.xctest' passed\n"
                          f"\t Executed 11 tests, with {skip_text}0 failures (0 unexpected) in 0.1 (0.2) seconds\n")
                suite = {'id': 'e', 'label': 'E2E', 'parse': 'xctest_sum', 'min_tests': 11}
                if limit is not None:
                    suite['max_skipped'] = limit
                result = gate.evaluate(suite, output, 0)
                self.assertEqual((result.tests, result.failures, result.skipped, result.status), (11, 0, skipped, status))
                suffix = f', {skipped} skipped > max {limit}' if status == 'FAIL' else ''
                self.assertEqual(result.lines, ['E2E: 11 tests, 0 failed' + suffix])


class LoadSuites(unittest.TestCase):
    def load(self, item, **extra):
        doc = {'schema': gate.SCHEMA, 'suites': {'w': {'run': ['true'], 'parse': 'exit', 'needs': ['window'], **extra}},
               'profiles': {'p': {'phases': [{'lanes': [[item]]}]}}}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp, 'suites.json')
            path.write_text(json.dumps(doc))
            return gate.load_suites(path, private=Path(tmp, 'private-suites.json'))

    def test_window_suite_outside_a_gpu_block_is_refused(self):
        with self.assertRaisesRegex(ValueError, 'gpu block'):
            self.load('w')
        self.load({'lock': 'gpu', 'label': 'x', 'suites': ['w']})

    def test_a_require_of_an_unknown_suite_is_refused(self):
        with self.assertRaisesRegex(ValueError, 'requires'):
            self.load({'lock': 'gpu', 'label': 'x', 'suites': ['w']}, requires=['nope'])

    def test_a_windows_host_suite_runs_only_in_a_win_profile_and_only_on_windows(self):
        def load(profile, **suite):
            doc = {'schema': gate.SCHEMA, 'suites': {'h': {'run': ['true'], 'parse': 'exit', **suite}},
                   'profiles': {profile: {'phases': [{'lanes': [['h']]}]}}}
            with tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp, 'suites.json')
                path.write_text(json.dumps(doc))
                return gate.load_suites(path, private=Path(tmp, 'private-suites.json'))
        with self.assertRaisesRegex(ValueError, 'only a win-\\* profile'):
            load('dev', os=['windows'], host='win')
        load('win-dev', os=['windows'], host='win')
        for suite in ({'host': 'win'}, {'os': ['macos'], 'host': 'win'}, {'os': ['windows'], 'host': 'linux'}):
            with self.subTest(suite), self.assertRaisesRegex(ValueError, 'host may only'):
                load('win-dev', **suite)
        with self.assertRaisesRegex(ValueError, 'unknown os'):
            load('dev', os=['linux'])

    def load_with_private(self, private):
        doc = {'schema': gate.SCHEMA, 'suites': {'a': {'run': ['true'], 'parse': 'exit'}},
               'profiles': {'p': {'phases': [{'lanes': [['a']]}]}}}
        with tempfile.TemporaryDirectory() as tmp:
            path, extra = Path(tmp, 'suites.json'), Path(tmp, 'private-suites.json')
            path.write_text(json.dumps(doc))
            if private is not None:
                extra.write_text(json.dumps(dict(private, schema=gate.SCHEMA)))
            return gate.load_suites(path, private=extra)

    def test_without_a_private_file_the_suites_are_the_public_ones(self):
        self.assertEqual(self.load_with_private(None),
                         {'schema': gate.SCHEMA, 'suites': {'a': {'run': ['true'], 'parse': 'exit', 'id': 'a'}},
                          'profiles': {'p': {'phases': [{'lanes': [['a']]}]}}})

    def test_private_suites_join_and_their_phases_follow_the_public_ones(self):
        doc = self.load_with_private({'suites': {'b': {'run': ['true'], 'parse': 'exit'}},
                                      'profiles': {'p': {'phases': [{'lanes': [['b']]}]}}})
        self.assertEqual(list(doc['suites']), ['a', 'b'])
        self.assertEqual(doc['suites']['b']['id'], 'b')
        self.assertEqual(doc['profiles']['p']['phases'], [{'lanes': [['a']]}, {'lanes': [['b']]}])
        self.assertEqual(profile_ids(doc, 'p'), ['a', 'b'])

    def test_a_private_suite_with_a_public_id_is_refused(self):
        with self.assertRaisesRegex(ValueError, 'suite a'):
            self.load_with_private({'suites': {'a': {'run': ['true'], 'parse': 'exit'}}, 'profiles': {}})

    def test_a_private_profile_the_public_file_lacks_is_refused(self):
        with self.assertRaisesRegex(ValueError, 'profile q'):
            self.load_with_private({'suites': {'b': {'run': ['true'], 'parse': 'exit'}},
                                    'profiles': {'q': {'phases': [{'lanes': [['b']]}]}}})

    def test_checked_in_suites_load(self):
        doc = gate.load_suites(gate.SUITES_FILE)
        self.assertLessEqual({'agentd', 'web', 'host', 'mac', 'dev', 'commit', 'public', 'release'}, set(doc['profiles']))
        self.assertEqual([sid for sid, suite in doc['suites'].items() if not suite.get('paths')], [])

    @unittest.skipUnless(gate.PRIVATE_SUITES_FILE.exists(), 'the render suites are private')
    def test_render_suites_run_under_the_gpu_lock_in_release_only(self):
        doc = gate.load_suites(gate.SUITES_FILE)
        render = ['render-quality', 'render-budget', 'render-continuity', 'render-contact-sit']
        for name, profile in doc['profiles'].items():
            items = [item for phase in profile['phases'] for lane in phase['lanes'] for item in lane]
            locked = [sid for item in items if isinstance(item, dict) and item['lock'] == 'gpu'
                      for sid in item['suites'] if sid in render]
            with self.subTest(name):
                self.assertEqual(locked, render if name in ('mac', 'release') else [])
                self.assertFalse(set(render) & {item for item in items if isinstance(item, str)})

    def test_dev_is_commit_without_windows_gpu_e2e_or_web_visual(self):
        doc = gate.load_suites(gate.SUITES_FILE)
        dev = profile_ids(doc, 'dev')
        self.assertEqual(dev, [sid for sid in profile_ids(doc, 'commit') if sid != 'web-visual'])
        self.assertFalse([sid for sid in dev if doc['suites'][sid].get('needs')])
        self.assertEqual(doc['profiles']['dev']['empty_changes'], 'none')

    def test_release_is_commit_then_the_mac_profile(self):
        # The private phases follow all public ones, so the merged release holds commit's and mac's suites, not their order.
        doc = gate.load_suites()
        self.assertEqual(sorted(profile_ids(doc, 'release')), sorted(profile_ids(doc, 'commit') + profile_ids(doc, 'mac')))
        public = gate.load_suites(gate.SUITES_FILE, private=gate.SUITES_FILE.with_name('absent-suites.json'))
        self.assertEqual(profile_ids(public, 'release'), profile_ids(public, 'commit') + profile_ids(public, 'mac'))
        for name in ('dev', 'commit', 'release'):
            with self.subTest(name):
                self.assertEqual(public['profiles'][name]['phases'][0]['lanes'][0], ['agentd-unit'])

    @unittest.skipUnless(gate.PRIVATE_SUITES_FILE.exists(), 'the renderer suites are in private/suites.json')
    def test_renderer_build_makes_the_release_metal_host_ahead_of_the_gpu_block(self):
        # render_gate.sh runs private/renderer/host/.build/release/metal-avatar-host.
        doc = gate.load_suites(gate.SUITES_FILE)
        build = doc['suites']['renderer-build']
        self.assertEqual((build['run'], build['cwd']), (['swift', 'build', '-c', 'release'], 'private/renderer/host'))
        for name in ('host', 'mac', 'release'):
            lanes = [lane for phase in doc['profiles'][name]['phases'] for lane in phase['lanes'] if 'renderer-build' in lane]
            with self.subTest(name):
                self.assertEqual([lane.index('renderer-build') for lane in lanes], [0])

    def test_a_script_a_suite_runs_is_in_its_paths(self):
        doc = gate.load_suites(gate.SUITES_FILE)
        for sid, suite in doc['suites'].items():
            for arg in suite['run']:
                if arg.startswith('{repo}/') and arg.endswith(('.sh', '.py')):
                    with self.subTest(sid, script=arg):
                        script = arg[len('{repo}/'):]
                        self.assertTrue(gate._under(script, suite['paths'] + doc['full_on']), script)

    def test_electron_suites_cover_inputs_outside_the_electron_package(self):
        suites = gate.load_suites()['suites']
        unit = ['web/src/bridge/protocol.ts', 'protocol/C11-components/validate.py']
        speech = ['protocol/C2-speech-stream/examples/ok-basic.ndjson']
        inputs = {'electron-build': ['web/tests/unit/shape.ts', 'app/packaging/release.json',
                                     'private/release/release.json', 'tools/release/release.py'],
                  'electron-unit': unit, 'electron-unit-win': unit, 'electron-e2e': speech}
        if 'electron-e2e-win' in suites:
            inputs['electron-e2e-win'] = speech
        missing = [(sid, path) for sid, paths in inputs.items() for path in paths if not gate._under(path, suites[sid]['paths'])]
        self.assertEqual(missing, [])

    def test_top_level_notes_reach_no_suite(self):
        doc = gate.load_suites(gate.SUITES_FILE)
        self.assertEqual(gate.select(doc, ['AGENTS.md', 'README.en.md', 'LICENSE']), (set(), None))

    def test_win_profiles_sync_then_run_protocol_on_the_host_and_mac_profiles_run_nothing_there(self):
        doc = gate.load_suites(gate.SUITES_FILE)
        self.assertEqual(profile_ids(doc, 'win-dev'), ['win-sync'] + profile_ids(doc, 'win-ci'))
        self.assertEqual(profile_ids(doc, 'win-commit'), profile_ids(doc, 'win-dev'))
        self.assertEqual(profile_ids(doc, 'win-ci')[0], 'protocol-win')
        self.assertTrue(doc['suites']['win-sync']['fatal'])
        win = {k: v for k, v in doc['suites']['protocol-win'].items() if k not in ('id', 'os', 'host', 'requires', 'line')}
        self.assertEqual(win, {k: v for k, v in doc['suites']['protocol'].items() if k not in ('id', 'line')})
        win = {k: v for k, v in doc['suites']['agentd-unit-win'].items() if k not in ('id', 'os', 'host', 'requires', 'line')}
        self.assertEqual(win, {k: v for k, v in doc['suites']['agentd-unit'].items() if k not in ('id', 'line')})
        for name in ('dev', 'commit', 'public', 'release', 'mac', 'host', 'agentd', 'web'):
            with self.subTest(name):
                self.assertFalse([sid for sid in profile_ids(doc, name) if doc['suites'][sid].get('host')])


class Remote(unittest.TestCase):
    SUITE = {'id': 'p-win', 'host': 'win', 'os': ['windows'], 'paths': ['protocol/'], 'run': ['{agentd_python}', 'x'],
             'modules': {'dirs': ['d'], 'patterns': ['test_*.py']}, 'parse': 'unittest_modules', 'line': 'P {tests}'}

    def test_outside_windows_a_host_suite_runs_winhost_test_and_reuses_no_stored_result(self):
        with mock.patch.object(gate.os, 'name', 'posix'):
            suite = gate.delegated(self.SUITE)
        self.assertEqual(suite['run'], [sys.executable, '-I', '{repo}/private/remote/winhost.py', 'test', '--checkout', '{repo}', 'p-win'])
        self.assertEqual(suite['parse'], 'remote')
        self.assertNotIn('modules', suite)
        with mock.patch.object(gate.os, 'name', 'nt'):
            self.assertIs(gate.delegated(self.SUITE), self.SUITE)
        phases = [[[('suite', suite)]]]
        self.assertEqual(gate.cache_keys({}, phases, REPO, {'agentd_python': sys.executable}, {}), {})

    def test_the_host_result_of_the_suite_becomes_its_result(self):
        line = json.dumps({'result': 'FAIL', 'suites': [{'id': 'p-win', 'status': 'FAIL', 'lines': ['P 3', 'failing: a.py'],
                                                         'tests': 3, 'failures': 1, 'skipped': 0}]})
        result = gate.evaluate(dict(self.SUITE, parse='remote'), 'host output\n' + line, 1)
        self.assertEqual((result.status, result.lines, result.tests, result.failures), ('FAIL', ['P 3', 'failing: a.py'], 3, 1))
        line = json.dumps({'result': 'PASS', 'suites': [{'id': 'p-win', 'status': 'PASS', 'lines': ['P 3'],
                                                         'tests': 3, 'failures': 0, 'skipped': 0}]})
        self.assertEqual(gate.evaluate(dict(self.SUITE, parse='remote'), line, 0).status, 'PASS')
        result = gate.evaluate(dict(self.SUITE, parse='remote'), 'ssh: connect to host buildhost: timed out', 69)
        self.assertEqual((result.status, result.lines[-1]), ('FAIL', 'p-win: FAIL no result from the Windows host'))


class Store(unittest.TestCase):
    def test_keeps_the_newest_receipts_per_profile(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Path(tmp)
            for n in range(gate_receipt.KEEP + 2):
                receipt = {'schema': gate_receipt.SCHEMA, 'profile': 'agentd', 'result': 'FAIL', 'partial': False,
                           'started_at': f'2026-10-31T00:00:{n:02d}Z', 'source': {'fingerprint': 'f' * 64}}
                gate_receipt.write(receipt, store=store)
            names = sorted(p.name for p in (store / 'agentd').glob('*.json'))
            self.assertEqual(len(names), gate_receipt.KEEP)
            self.assertTrue(names[0].startswith('20261031T000002Z'), names[0])



class SuiteTimeout(unittest.TestCase):
    def test_a_suite_that_sets_no_timeout_is_killed_after_the_default_one_and_fails(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(gate, 'SUITE_TIMEOUT', 1):
            start = time.monotonic()
            result = gate.run_suite({'id': 'hang', 'run': ['sleep', '20'], 'parse': 'tail1'},
                                    {'repo': tmp, 'logs': tmp, 'agentd_python': sys.executable, 'jobs': 1})
        self.assertEqual((result.status, result.lines[-1:]), ('FAIL', ['hang: FAIL timed out after 1 s']))
        self.assertLess(time.monotonic() - start, 10)

if __name__ == '__main__':
    unittest.main()
