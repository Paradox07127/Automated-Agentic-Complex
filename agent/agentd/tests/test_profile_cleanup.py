"""Runner actor lifetime and startup cleanup; no real model or profile access."""
import hashlib
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_agent.harness.codex_transport import CodexConfig, ManagedCodexSession
from character_agent.harness.profile_cleanup import purge_runner_indexes, purge_idle_runner_actors
from character_agent.harness.transport import join_reapers
from test_character_agent_transport import FAKE_RUNNER

# Every bridged harness config names the directory its own tools work in.
WORK = {"workspace_dir": tempfile.gettempdir(), "native_tools": True}


def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()


def index(path, rows=1):
    path.parent.mkdir(parents=True,exist_ok=True)
    db=sqlite3.connect(path)
    db.execute('CREATE TABLE threads(id TEXT, rollout_path TEXT, cwd TEXT, source TEXT)')
    for i in range(rows):db.execute('INSERT INTO threads VALUES (?,?,?,?)',(str(i),'/native/sessions/canary','/native','cli'))
    db.commit();db.close()


class OwnedCleanupTests(unittest.TestCase):
    def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve()
    def tearDown(self):self.tmp.cleanup()
    @unittest.skipIf(sys.platform == "win32", "profile_cleanup.py locks runner actors with O_DIRECTORY and O_NOFOLLOW; no Windows port yet")
    def test_only_legacy_product_indexes_are_removed_and_purge_is_idempotent(self):
        runner=self.root/'product/character-agent/runner'
        first=runner/'codex/sqlite/state_5.sqlite';second=runner/'codex/jobs/semantic-one/sqlite/state_5.sqlite'
        index(first,2);index(second,3)
        original=self.root/'native/state_5.sqlite';index(original,4);before=sha(original)
        product=self.root/'product/character-agent/runs.sqlite';index(product,6);product_before=sha(product)
        other=runner/'codex/isolated-state-v1/sqlite/state_5.sqlite';index(other,0)
        self.assertEqual(purge_runner_indexes(runner)['thread_rows'],5)
        result=purge_runner_indexes(runner,apply=True);self.assertEqual(result['databases'],2)
        self.assertFalse(first.exists());self.assertFalse(second.exists())
        self.assertEqual(sha(original),before);self.assertEqual(sha(product),product_before);self.assertTrue(other.exists())
        self.assertEqual(purge_runner_indexes(runner,apply=True)['databases'],0)
    def test_native_root_arbitrary_files_and_links_cannot_be_cleanup_targets(self):
        original=self.root/'native/state_5.sqlite';index(original);before=sha(original)
        with self.assertRaisesRegex(ValueError,'unowned'):purge_runner_indexes(original.parent,apply=True)
        runner=self.root/'product/character-agent/runner';directory=runner/'codex/sqlite';directory.mkdir(parents=True)
        (directory/'state_5.sqlite').symlink_to(original)
        self.assertEqual(purge_runner_indexes(runner,apply=True)['databases'],0)
        (directory/'state_5.sqlite').unlink();os.link(original,directory/'state_5.sqlite')
        with self.assertRaisesRegex(ValueError,'hardlink'):purge_runner_indexes(runner,apply=True)
        self.assertEqual(sha(original),before)
    def test_wrong_schema_and_domain_databases_are_preserved(self):
        runner=self.root/'product/character-agent/runner';path=runner/'codex/sqlite/state_9.sqlite';path.parent.mkdir(parents=True)
        db=sqlite3.connect(path);db.execute('CREATE TABLE facts(text TEXT)');db.close();before=sha(path)
        self.assertEqual(purge_runner_indexes(runner,apply=True)['databases'],0);self.assertEqual(sha(path),before)


class RunnerCleanupTests(unittest.TestCase):
    @unittest.skipIf(sys.platform == "win32", "profile_cleanup.py locks runner actors with O_DIRECTORY and O_NOFOLLOW; no Windows port yet")
    def test_fast_privacy_pass_removes_indexes_before_deferred_actor_disposal(self):
        actor=self.runner/'codex/jobs/old'
        database=actor/'sqlite/state_5.sqlite';index(database)
        canary=actor/'fixture.txt';canary.write_text('disposable actor fixture', encoding='utf-8')
        (actor/'.session.lock').touch()  # Managed actors own a lock from creation.
        self.stale(actor)
        purge_runner_indexes(self.runner,apply=True,remove_idle=False)
        self.assertFalse(database.exists())
        self.assertTrue(canary.exists())
        purge_idle_runner_actors(self.runner)
        self.assertFalse(actor.exists())

    def test_controller_becomes_ready_while_idle_cleanup_is_blocked(self):
        import test_character_agent_semantic as fixture
        entered,release,ready=threading.Event(),threading.Event(),threading.Event()
        case=fixture.SemanticTests('test_k03_semantic_records_turn_cost_for_both_harnesses')
        errors=[]
        def cleanup(*args,**kwargs):entered.set();release.wait(5)
        def initialize():
            try:case.setUp();ready.set()
            except BaseException as exc:errors.append(exc)
        worker=threading.Thread(target=initialize)
        try:
            with patch('character_agent.harness.profile_cleanup.purge_idle_runner_actors',side_effect=cleanup):
                worker.start()
                self.assertTrue(entered.wait(2),'cleanup did not start')
                self.assertTrue(ready.wait(2),'idle disposal blocked readiness')
                self.assertFalse(release.is_set())
                self.assertEqual(errors,[])
        finally:
            release.set();worker.join(5)
            if hasattr(case,'c'):case.tearDown()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.runner = self.root / 'character-agent/runner'
        self.script = self.root / 'fake_runner.py'
        self.script.write_text(FAKE_RUNNER, encoding='utf-8')
        self.sessions = []

    def tearDown(self):
        for session in self.sessions:
            session.close()
        join_reapers()
        self.tmp.cleanup()

    def session(self, backend, ident):
        actor = self.runner / backend / 'jobs' / ident
        session = ManagedCodexSession(CodexConfig(actor, 'fixture-model', 'fixture-key', cli_path='/fixture/codex', **WORK),
                                      runner_path=self.script)
        self.sessions.append(session)
        session.probe()
        return session, actor

    def stale(self, path):
        stamp = time.time() - 601
        os.utime(path, (stamp, stamp))

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_ten_closed_sessions_leave_no_actor_directories(self):
        for backend in ('codex',):
            with self.subTest(backend=backend):
                for number in range(10):
                    session, actor = self.session(backend, str(number))
                    proc = session._proc
                    terminate = session._terminate
                    def stop(process):
                        self.assertTrue(actor.is_dir())
                        terminate(process)
                    with patch.object(session, '_terminate', side_effect=stop):
                        session.close()
                        join_reapers()
                    self.assertIsNotNone(proc.poll())
                self.assertEqual(list((self.runner / backend / 'jobs').iterdir()), [])
                self.assertTrue(self.runner.is_dir())

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_active_actor_survives_other_close_and_startup_sweep(self):
        for backend in ('codex',):
            with self.subTest(backend=backend):
                active, actor = self.session(backend, 'active')
                database = actor / 'sqlite/state_5.sqlite'
                index(database)
                before = database.read_bytes()
                self.stale(actor)
                other, closed = self.session(backend, 'other')
                other.close()
                join_reapers()
                stale = self.runner / backend / 'jobs/stale'
                stale.mkdir()
                self.stale(stale)
                result = subprocess.run([sys.executable, '-B', '-I', '-c',
                    'import sys; sys.path.insert(0, sys.argv[1]); '
                    'from character_agent.harness.profile_cleanup import purge_runner_indexes; '
                    'purge_runner_indexes(sys.argv[2], apply=True)',
                    str(Path(__file__).resolve().parents[1]), str(self.runner)], capture_output=True, text=True, encoding='utf-8')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIsNone(active._proc.poll())
                self.assertTrue(actor.is_dir())
                self.assertTrue(database.exists())
                self.assertEqual(database.read_bytes(), before)
                self.assertFalse(closed.exists())
                self.assertFalse(stale.exists())
                active.close()

    @unittest.skipIf(sys.platform == "win32", "the test writes POSIX absolute paths or POSIX path spellings")
    def test_symlinks_never_delete_outside_targets_or_runner_root(self):
        outside = self.root / 'outside'
        outside.mkdir()
        canary = outside / 'keep.txt'
        canary.write_text('keep', encoding='utf-8')
        for backend in ('codex',):
            for operation in ('close', 'sweep'):
                with self.subTest(backend=backend, operation=operation):
                    session, actor = self.session(backend, operation)
                    (actor / 'outside').symlink_to(outside, target_is_directory=True)
                    if operation == 'close':
                        session.close()
                        join_reapers()
                    else:
                        session.close()
                        join_reapers()
                        actor.mkdir(parents=True, exist_ok=True)
                        (actor / 'outside').unlink(missing_ok=True)
                        (actor / 'outside').symlink_to(outside, target_is_directory=True)
                        self.stale(actor)
                        purge_runner_indexes(self.runner, apply=True)
                    self.assertEqual(canary.read_text(encoding='utf-8'), 'keep')
                    self.assertTrue(self.runner.is_dir())
                    self.assertFalse(actor.exists())
        for component in ('runner', 'backend', 'jobs', 'actor'):
            with self.subTest(component=component):
                runner = self.root / component / 'character-agent/runner'
                actor = runner / 'codex/jobs/linked'
                link = {'runner': runner, 'backend': runner / 'codex',
                        'jobs': actor.parent, 'actor': actor}[component]
                link.parent.mkdir(parents=True, exist_ok=True)
                link.symlink_to(outside, target_is_directory=True)
                purge_runner_indexes(runner, apply=True)
                self.assertTrue(link.is_symlink())
                self.assertEqual(canary.read_text(encoding='utf-8'), 'keep')

    @unittest.skipIf(sys.platform == "win32", "profile_cleanup.py locks runner actors with O_DIRECTORY and O_NOFOLLOW; no Windows port yet")
    def test_startup_sweep_removes_only_actors_older_than_ten_minutes(self):
        for backend in ('codex',):
            with self.subTest(backend=backend):
                jobs = self.runner / backend / 'jobs'
                old, new, boundary = (jobs / name for name in ('old', 'new', 'boundary'))
                for path in (old, new, boundary):
                    path.mkdir(parents=True)
                now = time.time()
                os.utime(old, (now - 601, now - 601))
                os.utime(new, (now - 599, now - 599))
                os.utime(boundary, (now - 600, now - 600))
                with patch('time.time', return_value=now):
                    purge_runner_indexes(self.runner)
                    self.assertTrue(old.is_dir())
                    purge_runner_indexes(self.runner, apply=True)
                self.assertTrue(new.is_dir())
                self.assertTrue(boundary.is_dir())
                self.assertTrue(jobs.is_dir())
                self.assertTrue(self.runner.is_dir())
                self.assertFalse(old.exists())
