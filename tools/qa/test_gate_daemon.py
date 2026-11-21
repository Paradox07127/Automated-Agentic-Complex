"""gate_daemon.py on a temporary git repo whose tools/qa/gate.py is a stub driven by $GATE_STUB_CTL."""
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gate_daemon  # noqa: E402
import gate_receipt  # noqa: E402
import source_fingerprint  # noqa: E402

DAEMON = Path(__file__).resolve().parent / 'gate_daemon.py'
RELEASE = Path(__file__).resolve().parents[1] / 'release'

# Fails every suite named in <checkout>/broken, and once the suite 'web' while $GATE_STUB_CTL/flaky exists.
STUB = '''import json, os, subprocess, sys
from pathlib import Path
a = sys.argv[1:]
opt = lambda k: a[a.index(k) + 1] if k in a else None
checkout, logs, ctl = Path(opt('--checkout')), Path(opt('--logs')), Path(os.environ['GATE_STUB_CTL'])
head = subprocess.run(['git', '-C', str(checkout), 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
with open(ctl / 'calls.jsonl', 'a') as f:
    f.write(json.dumps(dict(argv=a, head=head, release_profile=os.environ.get('AAC_RELEASE_PROFILE'))) + '\\n')
red = []
if (ctl / 'flaky').exists():
    (ctl / 'flaky').unlink()
    red.append('web')
if (checkout / 'broken').exists():
    red += (checkout / 'broken').read_text().split()
if opt('--only'):
    red = [s for s in red if s in opt('--only').split(',')]
logs.mkdir(parents=True, exist_ok=True)
(logs / 'gate-receipt.json').write_text(json.dumps(dict(
    profile=opt('--profile'), suites=[dict(id=s, status='FAIL') for s in red] + [dict(id='swift', status='PASS')])))
print('receipt: ' + str(logs / 'gate-receipt.json'))
print('GATE FAIL' if red else 'GATE PASS')
sys.exit(1 if red else 0)
'''


class GateDaemonTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='gate-daemon-test.')).resolve()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.repo = self.tmp / 'repo'
        self.ctl = self.tmp / 'ctl'
        self.ctl.mkdir()
        env = mock.patch.dict(os.environ, GATE_STUB_CTL=str(self.ctl))
        env.start()
        self.addCleanup(env.stop)
        self.notes = []
        patch = mock.patch.object(gate_daemon, 'notify', lambda title, text: self.notes.append((title, text)))
        patch.start()
        self.addCleanup(patch.stop)
        quiet = contextlib.redirect_stdout(io.StringIO())
        quiet.__enter__()
        self.addCleanup(quiet.__exit__, None, None, None)
        self.repo.mkdir()
        self.git('init', '-q', '-b', 'main')
        self.git('config', 'user.name', 'Test')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('config', 'commit.gpgsign', 'false')
        self.write('.gitignore', '.claude/\n.local/\nagent/.venv\n/private/\n')
        self.write('tools/qa/gate.py', STUB)
        self.write('tools/qa/gate_daemon.py', DAEMON.read_text())
        for name in ('release.py', 'gate_receipt.py', 'source_fingerprint.py'):
            self.write('tools/release/' + name, (RELEASE / name).read_text())
        self.write('app/packaging/release.json', json.dumps(dict(
            character_catalog='characters/sample-library/current.json', ui_art=None, photo_looks=None)))
        self.write('characters/sample-library/current.json', '{}')
        self.write('private/release/release.json', json.dumps(dict(character_catalog='.local/output/rel-1/library/current.json',
            ui_art='.local/output/ui-art-1/art', photo_looks='.local/output/looks-1/looks')))
        self.write('agent/.venv/bin/python', 'stub')
        self.c0 = self.commit('base')
        self.daemon = gate_daemon.Daemon(self.repo)

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.repo), *args], check=True, capture_output=True,
                              text=True).stdout.strip()

    def write(self, name, text):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def commit(self, subject):
        self.git('add', '-A')
        self.git('commit', '-q', '-m', subject)
        return self.git('rev-parse', 'HEAD')

    def calls(self):
        path = self.ctl / 'calls.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def status(self):
        return json.loads((self.repo / '.local/gate-daemon/status.json').read_text())

    def green(self):
        return self.git('rev-parse', '--verify', '-q', 'refs/endfield/green')

    def test_new_main_commit_turns_green_then_idle_runs_one_no_cache_run(self):
        self.assertFalse(self.daemon.tick())
        self.assertEqual(self.green(), self.c0)
        gr = self.repo / '.claude/worktrees/gr'
        [call] = self.calls()
        self.assertEqual(call['head'], self.c0)
        self.assertEqual(call['argv'], ['--profile', 'commit', '--checkout', str(gr),
                                        '--logs', str(self.repo / '.local/gate-daemon/logs' / self.c0[:12])])
        for name in ['.local/inputs', '.local/cache/character-system',
                     '.local/output/rel-1', '.local/output/ui-art-1', '.local/output/looks-1', '.local/gate-receipts',
                     '.local/pi-runtime']:
            self.assertEqual(os.readlink(gr / name), str(self.repo / name), name)
        self.assertFalse((gr / 'agent/.venv').is_symlink())
        self.assertEqual((gr / 'agent/.venv/bin/python').read_text(), 'stub')
        self.assertEqual(self.status()['last']['result'], 'PASS')
        self.assertEqual(self.notes, [])
        self.daemon.tick()
        self.assertEqual(len(self.calls()), 2)
        self.assertIn('--no-cache', self.calls()[1]['argv'])
        self.assertEqual(self.status()['last_full']['sha'], self.c0)
        self.daemon.tick()
        self.assertEqual(len(self.calls()), 2)

    def test_fail_reruns_same_sha_and_second_pass_records_flaky(self):
        (self.ctl / 'flaky').touch()
        self.daemon.tick()
        calls = self.calls()
        self.assertEqual([c['head'] for c in calls], [self.c0, self.c0])
        logs = self.repo / '.local/gate-daemon/logs'
        self.assertEqual(calls[0]['argv'][-1], str(logs / self.c0[:12]))
        self.assertEqual(calls[1]['argv'][-1], str(logs / f'{self.c0[:12]}-rerun'))
        self.assertEqual(self.green(), self.c0)
        [flaky] = self.status()['flaky']
        self.assertEqual((flaky['sha'], flaky['suites']), (self.c0, ['web']))
        self.assertEqual(self.notes, [])

    def test_release_fail_reruns_same_sha_and_second_pass_records_flaky(self):
        (self.ctl / 'flaky').touch()
        self.assertEqual(gate_daemon.release(self.daemon, None), 0)
        calls = self.calls()
        self.assertEqual([c['head'] for c in calls], [self.c0, self.c0])
        logs = self.repo / '.local/gate-daemon/logs'
        self.assertEqual([c['argv'][1] for c in calls], ['release', 'release'])
        self.assertEqual(calls[0]['argv'][-1], str(logs / f'{self.c0[:12]}-release'))
        self.assertEqual(calls[1]['argv'][-1], str(logs / f'{self.c0[:12]}-release-rerun'))
        [flaky] = self.status()['flaky']
        self.assertEqual((flaky['sha'], flaky['suites']), (self.c0, ['web']))

    def test_release_that_fails_twice_is_red(self):
        self.write('broken', 'web')
        self.commit('broken')
        self.assertEqual(gate_daemon.release(self.daemon, None), 1)
        self.assertEqual(len(self.calls()), 2)
        self.assertIsNone(self.daemon.load().get('flaky'))

    def test_verify_and_release_restore_checkout_before_retry(self):
        gr = self.daemon.gr
        for profile in ('commit', 'release'):
            with self.subTest(profile=profile):
                def gate(logs, **kw):
                    tracked, extra, cache = gr / 'characters/sample-library/current.json', gr / 'suite.tmp', gr / '.local/build'
                    if not logs.endswith('-rerun'):
                        tracked.write_text('suite edit')
                        extra.touch()
                        cache.write_text('cached')
                        return False, ['one'], None
                    self.assertEqual((tracked.read_text(), extra.exists(), cache.read_text()), ('{}', False, 'cached'))
                    return True, [], None
                with mock.patch.object(self.daemon, 'run_gate', gate):
                    if profile == 'commit':
                        self.daemon.verify(self.c0)
                    else:
                        gate_daemon.gate_main(self.daemon, self.c0, profile)

    def test_two_failures_bisect_to_first_red_commit_then_green_notifies(self):
        self.daemon.tick()
        self.daemon.tick()
        c1 = self.commit_file('one', 'x', 'one')
        c2 = self.commit_file('broken', 'agentd', 'Break agentd')
        c3 = self.commit_file('three', 'x', 'three')
        before = len(self.calls())
        self.daemon.tick()
        calls = self.calls()[before:]
        self.assertEqual([c['head'] for c in calls[:2]], [c3, c3])
        bisect = calls[2:]
        self.assertEqual([c['head'] for c in bisect], [c2, c1])
        for call in bisect:
            self.assertEqual(call['argv'][call['argv'].index('--only') + 1], 'agentd')
        self.assertEqual(self.green(), self.c0)
        red = self.status()['last_red']
        self.assertEqual((red['sha'], red['suites']), (c3, ['agentd']))
        self.assertEqual((red['first_bad']['sha'], red['first_bad']['subject']), (c2, 'Break agentd'))
        self.assertTrue(red['first_bad']['author_time'])
        self.assertEqual(subprocess.run(['git', '-C', str(self.repo / '.claude/worktrees/gr'), 'rev-parse', 'HEAD'],
                                        capture_output=True, text=True).stdout.strip(), c3)
        self.assertEqual(len(self.notes), 1)
        (self.repo / 'broken').unlink()
        c4 = self.commit('Fix agentd')
        self.daemon.tick()
        self.assertEqual(self.green(), c4)
        self.assertEqual(len(self.notes), 2)

    def test_bisect_runs_the_red_suites_with_what_they_require(self):
        self.write('tools/qa/suites.json', json.dumps(dict(suites=dict(
            agentd=dict(requires=['prep']), prep=dict(requires=['node']), node={}))))
        self.commit('Add suites')
        self.daemon.tick()
        self.daemon.tick()
        self.commit_file('one', 'x', 'one')
        c2 = self.commit_file('broken', 'agentd', 'Break agentd')
        self.commit_file('three', 'x', 'three')
        before = len(self.calls())
        self.daemon.tick()
        bisect = self.calls()[before + 2:]
        self.assertTrue(bisect)
        for call in bisect:
            self.assertEqual(call['argv'][call['argv'].index('--only') + 1], 'agentd,prep,node')
        self.assertEqual(self.status()['last_red']['first_bad']['sha'], c2)

    def test_a_checkout_with_its_own_receipts_moves_them_to_the_main_store_and_links_it(self):
        gr = self.repo / '.claude/worktrees/gr'
        self.daemon.prepare(gr)
        old = gr / '.local/gate-receipts/commit'
        old.mkdir(parents=True)
        (old / '20261117T000000Z-abc.json').write_text('{"run": 1}')
        (old / 'gate-receipt.json').write_text('{"latest": 1}')
        self.daemon.tick()
        self.assertTrue((gr / '.local/gate-receipts').is_symlink())
        store = self.repo / '.local/gate-receipts/commit'
        self.assertEqual((store / '20261117T000000Z-abc.json').read_text(), '{"run": 1}')
        self.assertFalse((store / 'gate-receipt.json').exists())

    def test_pack_reinstalls_web_and_electron_packages_before_building(self):
        bin_dir = self.tmp / 'bin'
        bin_dir.mkdir()
        (bin_dir / 'npm').write_text(f'#!/bin/bash\necho "npm $*" >> {self.ctl}/tools.log\n')
        (bin_dir / 'npm').chmod(0o755)
        self.write('app/' + 'build_app.sh', f'echo "build $*" >> {self.ctl}/tools.log\n'
                                            'mkdir -p "app/build/releases/new/Agentic Complex.app"\n'
                                            ': > app/build/releases/.DS_Store\n'
                                            'echo "{\\"release_ready\\": true, \\"app\\": \\"$PWD/app/build/releases/new/Agentic Complex.app\\"}"\n')
        c1 = self.commit('Add build stub')
        self.daemon.tick()
        releases = self.repo / '.claude/worktrees/pk/app/build/releases'
        self.daemon.prepare(releases.parents[2])
        (releases / 'old/Agentic Complex.app').mkdir(parents=True)
        path = mock.patch.dict(os.environ, PATH=f'{bin_dir}:{os.environ["PATH"]}')
        path.start()
        self.addCleanup(path.stop)
        self.assertEqual(gate_daemon.pack(self.daemon), 0)
        self.assertEqual((self.ctl / 'tools.log').read_text().splitlines(),
                         ['npm --prefix web ci --ignore-scripts --prefer-offline',
                          'npm --prefix app/electron ci --ignore-scripts --prefer-offline',
                          'build '])
        self.assertEqual(subprocess.run(['git', '-C', str(self.repo / '.claude/worktrees/pk'), 'rev-parse', 'HEAD'],
                                        capture_output=True, text=True).stdout.strip(), c1)
        self.assertEqual(sorted(p.name for p in releases.iterdir()), ['.DS_Store', 'new'])

    def test_pack_reports_a_failed_build_whose_output_ends_in_a_multiline_json_object(self):
        bin_dir = self.tmp / 'bin'
        bin_dir.mkdir()
        (bin_dir / 'npm').write_text('#!/bin/bash\n')
        (bin_dir / 'npm').chmod(0o755)
        self.write('app/' + 'build_app.sh', 'echo "{\\"release_ready\\": false}"\nprintf "{\\n  \\"result\\": \\"FAIL\\"\\n}\\n"\nexit 1\n')
        self.commit('Add failing build stub')
        self.daemon.tick()
        path = mock.patch.dict(os.environ, PATH=f'{bin_dir}:{os.environ["PATH"]}')
        path.start()
        self.addCleanup(path.stop)
        self.assertEqual(gate_daemon.pack(self.daemon), 1)

    def electron_pack(self):
        """A main whose sources the fingerprint reads, npm and build_app stubs, and an electron profile; (sha, profile)."""
        for relative in source_fingerprint.EXTRA_FILES:
            if not (self.repo / relative).exists():
                self.write(relative, 'stub\n')
        self.write('app/electron/src/main.ts', 'main\n')
        bin_dir = self.tmp / 'bin'
        bin_dir.mkdir()
        (bin_dir / 'npm').write_text('#!/bin/bash\n')
        (bin_dir / 'npm').chmod(0o755)
        self.write('app/' + 'build_app.sh', f'echo "build $AAC_RELEASE_PROFILE" >> {self.ctl}/tools.log\n'
                                            'mkdir -p "app/build/releases/new/Agentic Complex.app"\n'
                                            'echo "{\\"release_ready\\": true, \\"app\\": \\"$PWD/app/build/releases/new/Agentic Complex.app\\"}"\n')
        sha = self.commit('Add build stub')
        path = mock.patch.dict(os.environ, PATH=f'{bin_dir}:{os.environ["PATH"]}')
        path.start()
        self.addCleanup(path.stop)
        profile = self.tmp / 'electron.json'
        profile.write_text(json.dumps(dict(character_catalog='characters/sample-library/current.json', ui_art=None,
                                           photo_looks=None)))
        return sha, profile

    def built(self):
        path = self.ctl / 'tools.log'
        return path.read_text().splitlines() if path.exists() else []

    def test_pack_with_a_profile_gates_main_under_it_first_then_builds_with_it(self):
        sha, profile = self.electron_pack()
        self.assertEqual(gate_daemon.pack(self.daemon, profile), 0)
        [call] = self.calls()
        gr = self.repo / '.claude/worktrees/gr'
        self.assertEqual((call['head'], call['release_profile']), (sha, str(profile)))
        self.assertEqual(call['argv'], ['--profile', 'commit', '--checkout', str(gr),
                                        '--logs', str(self.repo / '.local/gate-daemon/logs' / f'{sha[:12]}-commit')])
        self.assertEqual(self.built(), [f'build {profile}'])

    def test_pack_with_a_profile_and_a_receipt_of_its_fingerprint_builds_without_gating(self):
        _, profile = self.electron_pack()
        with mock.patch.dict(os.environ, AAC_RELEASE_PROFILE=str(profile)):
            fingerprint = source_fingerprint.compute(self.repo)[1]
            runner = gate_receipt.runner_digest(self.repo)
        self.assertNotEqual(source_fingerprint.compute(self.repo)[1], fingerprint)
        receipts = gate_receipt
        receipts.write(receipts.build(
            profile='commit', result='PASS', partial=False, started_at='2026-11-20T00:00:00Z',
            source=dict(fingerprint=fingerprint, changed_during_run=False),
            suites_sha256=receipts._sha256(self.repo, []), runner_sha256=runner),
            store=receipts.store_dir(self.repo))
        self.assertEqual(gate_daemon.pack(self.daemon, profile), 0)
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.built(), [f'build {profile}'])

    def test_pack_with_a_profile_whose_gate_fails_twice_builds_nothing(self):
        self.write('broken', 'web')
        sha, profile = self.electron_pack()
        self.assertEqual(gate_daemon.pack(self.daemon, profile), 1)
        self.assertEqual([Path(c['argv'][-1]).name for c in self.calls()], [f'{sha[:12]}-commit', f'{sha[:12]}-commit-rerun'])
        self.assertEqual(self.built(), [])

    def test_release_with_a_profile_gates_main_under_it(self):
        _, profile = self.electron_pack()
        daemon = [sys.executable, '-I', str(self.repo / 'tools/qa/gate_daemon.py'), 'release', '--profile', str(profile)]
        result = subprocess.run(daemon, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual([(c['argv'][1], c['release_profile']) for c in self.calls()], [('release', str(profile))])

    def commit_file(self, name, text, subject):
        self.write(name, text)
        return self.commit(subject)

    def test_tick_asks_for_restart_when_the_checked_out_daemon_differs(self):
        self.daemon.tick()
        self.write('tools/qa/gate_daemon.py', DAEMON.read_text() + '\n# changed\n')
        self.commit('Change the daemon')
        self.assertTrue(self.daemon.tick())

    def test_existing_venv_in_a_checkout_is_left_alone(self):
        gr = self.repo / '.claude/worktrees/gr'
        self.daemon.prepare(gr)
        (gr / 'agent/.venv/bin/python').write_text('kept')
        self.daemon.tick()
        self.assertEqual((gr / 'agent/.venv/bin/python').read_text(), 'kept')

    def test_link_gives_a_session_worktree_the_runner_inputs_and_a_venv(self):
        wt = self.tmp / 'session-wt'
        self.git('worktree', 'add', '-q', '--detach', str(wt), 'main')
        daemon = [sys.executable, '-I', str(self.repo / 'tools/qa/gate_daemon.py'), 'link']
        self.assertEqual(subprocess.run(daemon + [str(wt)], capture_output=True).returncode, 0)
        self.assertEqual((wt / 'agent/.venv/bin/python').read_text(), 'stub')
        self.assertFalse((wt / 'agent/.venv').is_symlink())
        for name in ['private', '.local/gate-receipts', '.local/output/rel-1', '.local/output/ui-art-1']:
            self.assertEqual((wt / name).resolve(), self.repo / name)
        self.assertNotEqual(subprocess.run(daemon + [str(self.repo)], capture_output=True).returncode, 0)

    def test_link_replaces_a_private_dir_left_with_only_ignored_build_output(self):
        wt = self.tmp / 'old-wt'
        self.git('worktree', 'add', '-q', '--detach', str(wt), 'main')
        (wt / 'private/renderer/host/.build').mkdir(parents=True)
        self.daemon.link(wt)
        self.assertEqual((wt / 'private').resolve(), self.repo / 'private')

    def test_link_without_a_local_profile_takes_only_what_the_public_profile_names(self):
        wt = self.tmp / 'public-wt'
        self.git('worktree', 'add', '-q', '--detach', str(wt), 'main')
        shutil.rmtree(self.repo / 'private')
        self.daemon.link(wt)
        self.assertFalse((wt / 'private').exists())
        self.assertTrue((wt / '.local/gate-receipts').is_symlink())
        self.assertFalse((wt / '.local/output').exists())
        self.assertFalse((wt / 'characters/sample-library/current.json').is_symlink())

    def test_second_serve_is_refused_and_a_dead_holder_is_reclaimed(self):
        lock = self.repo / '.local/cache/gate-daemon.lock'
        lock.mkdir(parents=True)
        (lock / 'pid').write_text(f'{os.getppid()}\n')
        self.assertEqual(gate_daemon.serve(self.daemon), 1)
        self.assertEqual((lock / 'pid').read_text().strip(), str(os.getppid()))
        dead = subprocess.Popen([sys.executable, '-c', 'pass'])
        dead.wait()
        (lock / 'pid').write_text(f'{dead.pid}\n')
        self.assertTrue(gate_daemon.acquire(lock, 'test', wait=False))
        self.assertEqual((lock / 'pid').read_text().strip(), str(os.getpid()))

    def test_status_json_fields(self):
        run = lambda: json.loads(subprocess.run(
            [sys.executable, '-I', str(self.repo / 'tools/qa/gate_daemon.py'), 'status', '--json'],
            check=True, capture_output=True, text=True).stdout)
        doc = run()
        self.assertEqual((doc['running'], doc['green'], doc['main'], doc['ahead']), (False, None, self.c0, None))
        self.daemon.tick()
        c1 = self.commit_file('one', 'x', 'one')
        doc = run()
        self.assertEqual(set(doc), {'running', 'pid', 'current', 'main', 'green', 'ahead', 'last', 'last_red',
                                    'flaky', 'last_full', 'checkout_lock'})
        self.assertEqual((doc['green'], doc['main'], doc['ahead']), (self.c0, c1, 1))
        self.assertIsNone(doc['checkout_lock'])
        self.assertEqual(doc['last']['sha'], self.c0)

    def test_logs_keep_the_newest_ten_directories(self):
        logs = self.repo / '.local/gate-daemon/logs'
        for n in range(12):
            (logs / f'{n:012d}').mkdir(parents=True)
            os.utime(logs / f'{n:012d}', (n, n))
        gate_daemon.prune(logs)
        self.assertEqual(sorted(p.name for p in logs.iterdir()), [f'{n:012d}' for n in range(2, 12)])


if __name__ == '__main__':
    unittest.main()
