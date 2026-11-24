"""Observation prune keeps the retention tiers in bounded batches; the first /character/runtime GET does not wait on probes."""
import cProfile
import io
import json
from pathlib import Path
import pstats
import sqlite3
import statistics
import sys
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from infra.store import open_store
from infra.store_schemas import CONTINUOUS_OBSERVATION_SCHEMA, OBSERVATION_BRIEF_SCHEMA
from character_agent.services.observation import (EVENT_KEEP, FRAME_KEEP_S, IMAGE_KEEP_S, KEPT_METADATA, TEXT_KEEP_S,
                                                   ObservationService, digest, dump)
from character_agent.services.observation_briefs import ObservationBriefs, RETENTION
from character_agent.harness.discovery import DiscoveryService
from character_agent.routes.http import route
import test_character_agent_semantic as fixture

TABLES = ('observation_frames', 'observation_content', 'observation_processed',
          'observation_input_identity', 'observation_aliases', 'observation_analyses',
          'observation_work_events', 'observation_briefs')
NOW = 2000000000


def reference_prune(db):
    """The retention tiers as plain unbatched statements over the whole tables."""
    db.execute('DELETE FROM observation_frames WHERE at<?', (NOW-FRAME_KEEP_S,))
    db.execute('DELETE FROM observation_processed WHERE id NOT IN (SELECT id FROM observation_frames)')
    db.execute('DELETE FROM observation_input_identity WHERE observation_id NOT IN (SELECT id FROM observation_frames)')
    db.execute('DELETE FROM observation_aliases WHERE id NOT IN (SELECT id FROM observation_frames) OR canonical_id NOT IN (SELECT id FROM observation_frames)')
    db.execute('DELETE FROM observation_content WHERE hash NOT IN (SELECT content_hash FROM observation_frames)')
    for column, empty, keep in (('image', 'NULL', IMAGE_KEEP_S), ('text', "''", TEXT_KEEP_S)):
        db.execute(f'UPDATE observation_content SET {column}={empty} WHERE created_at<?1 AND NOT EXISTS '
                   '(SELECT 1 FROM observation_frames f WHERE f.content_hash=observation_content.hash AND f.at>=?1)', (NOW-keep,))
    for rowid, raw in db.execute('SELECT rowid,metadata FROM observation_frames WHERE at<?', (NOW-TEXT_KEEP_S,)).fetchall():
        meta = json.loads(raw)
        kept = {k: meta[k] for k in KEPT_METADATA if k in meta}
        if isinstance(meta.get('nodes'), list):
            kept.update(nodes_sha256=digest(meta['nodes']), nodes_count=len(meta['nodes']))
        db.execute('UPDATE observation_frames SET metadata=? WHERE rowid=?', (dump(kept), rowid))
    for table in ('observation_analyses', 'observation_work_events'):
        db.execute('DELETE FROM '+table+' WHERE at<?', (NOW-EVENT_KEEP,))
    db.execute('DELETE FROM observation_briefs WHERE updated_at<?', (NOW-RETENTION,))
    db.commit()


# Frame i is captured this long ago: past every tier, past the text, past the screenshot, or just now.
AGES = (FRAME_KEEP_S+1, TEXT_KEEP_S+1, IMAGE_KEEP_S+1, 0)


def seed(db, count):
    for statement in CONTINUOUS_OBSERVATION_SCHEMA:
        if not statement.startswith('CREATE TRIGGER'): db.execute(statement)
    db.execute(OBSERVATION_BRIEF_SCHEMA[0])
    db.executemany('INSERT INTO observation_content VALUES(?,?,?,?)',
                   [(str(i), 'body '+str(i), b'pixels', NOW-AGES[i%4]) for i in range(2, count)])
    # Frames 0, 1 and 31 share old content '31': it keeps its screenshot and text while fresh frames hold it.
    db.execute("UPDATE observation_content SET created_at=? WHERE hash='31'", (NOW-FRAME_KEEP_S-10,))
    db.executemany('INSERT INTO observation_frames VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                   [(str(i), ('aster','birch')[i%2], NOW-(AGES[i%4] if i>=2 else (FRAME_KEEP_S+1, 0)[i]),
                     'native_ax', 'editor', str(i), 0, '[]',
                     json.dumps({'blob':'x'*1024, 'app':'Xcode', 'kind':'live_hook', 'title':'private',
                                 **({'nodes':[{'value':str(i)}]} if i%3 == 0 else {})}),
                     '31' if i<2 else str(i), None) for i in range(count)])
    db.executemany('INSERT INTO observation_processed VALUES(?,?,?)', [(str(i),'a',NOW) for i in range(count)])
    db.executemany('INSERT INTO observation_input_identity VALUES(?,?)', [(str(i),str(i)) for i in range(count)])
    db.executemany('INSERT INTO observation_aliases VALUES(?,?)', [('31','0'), ('1','32'), ('33','34')])
    for i, at in enumerate((NOW-EVENT_KEEP-1, NOW-EVENT_KEEP, NOW)):
        db.execute('INSERT INTO observation_analyses VALUES(?,?,?,?,?,?)',(str(i),'aster',at,'r','{}','[]'))
        db.execute('INSERT INTO observation_work_events VALUES(?,?,?,?,?,?,?)',(str(i),'aster',at,'title','{}','[]','a'))
        db.execute('INSERT INTO observation_briefs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
                   (str(i),'aster','daily','2026-01-01','UTC',0,1,at,'completed',1,'{}','[]',0))
    db.commit()


def services(db):
    observation = object.__new__(ObservationService)
    observation.db, observation.lock, observation.clock = db, threading.RLock(), lambda: NOW
    observation.stripped = (0, 0)
    briefs = object.__new__(ObservationBriefs)
    briefs.db, briefs.lock, briefs.clock = db, observation.lock, observation.clock
    briefs.controller = SimpleNamespace(retention=lambda: None)
    return observation, briefs


def stats(label, samples):
    print(f'{label}: n={len(samples)}, median={statistics.median(samples):.3f} ms, '
          f'min={min(samples):.3f}, max={max(samples):.3f}')


class PruneTests(unittest.TestCase):
    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_prune_keeps_the_tiers_in_batches_and_idle_work_is_bounded(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'domain.sqlite'
            legacy = sqlite3.connect(path)
            seed(legacy, 30000)
            expected = sqlite3.connect(':memory:'); legacy.backup(expected); legacy.close()
            reference_prune(expected)
            db = open_store(path)
            try:
                observation, briefs = services(db)
                batches = []
                db.set_trace_callback(lambda sql: batches.append(sql) if sql.startswith(('UPDATE observation_content', 'DELETE FROM observation_frames')) else None)
                observation.prune(); briefs.prune()
                db.set_trace_callback(None)
                for table in TABLES:
                    self.assertEqual(db.execute('SELECT * FROM '+table+' ORDER BY 1').fetchall(),
                                     expected.execute('SELECT * FROM '+table+' ORDER BY 1').fetchall(), table)
                # 14999 contents past the screenshot and 7499 past the text, 500 rows a batch; frames go 500 a batch too
                # (the trace repeats a DELETE for each trigger statement, so its batches are not counted).
                self.assertEqual([sum(sql.startswith(prefix) for sql in batches) for prefix in
                                  ('UPDATE observation_content SET image', 'UPDATE observation_content SET text')], [30, 15])
                self.assertTrue(all('LIMIT' in sql for sql in batches if sql.startswith('DELETE FROM observation_frames')))
                self.assertEqual(db.execute("SELECT text,image FROM observation_content WHERE hash='31'").fetchone(), ('body 31', b'pixels'))
                self.assertEqual(json.loads(db.execute("SELECT metadata FROM observation_frames WHERE id='9'").fetchone()[0]),
                                 {'app':'Xcode', 'kind':'live_hook', 'title':'private', 'nodes_sha256':digest([{'value':'9'}]), 'nodes_count':1})
                steps = [0]
                def progress(): steps[0] += 100; return 0
                db.set_progress_handler(progress, 100)
                observation.prune(); briefs.prune()
                db.set_progress_handler(None, 0)
                self.assertLess(steps[0], 1000, f'idle prune visited {steps[0]} SQLite VM instructions')
            finally:
                db.close(); expected.close()

    def test_prune_timing(self):
        import tempfile
        samples = {'reference': [], 'current': []}
        with tempfile.TemporaryDirectory() as tmp:
            for iteration in range(7):
                path = Path(tmp)/f'{iteration}.sqlite'
                db = open_store(path)
                seed(db, 30000)
                original = sqlite3.connect(Path(tmp)/f'{iteration}-reference.sqlite'); db.backup(original)
                original.execute('PRAGMA journal_mode=WAL')
                original.execute('PRAGMA secure_delete=ON')
                original.execute('PRAGMA mmap_size=268435456')
                # The reference deletes orphans itself.
                for name, in original.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'observation_%'").fetchall():
                    original.execute('DROP TRIGGER '+name)
                observation, briefs = services(db)
                start = time.perf_counter(); reference_prune(original)
                samples['reference'].append((time.perf_counter()-start)*1000)
                start = time.perf_counter(); observation.prune(); briefs.prune()
                samples['current'].append((time.perf_counter()-start)*1000)
                for table in TABLES:
                    self.assertEqual(db.execute('SELECT * FROM '+table+' ORDER BY 1').fetchall(),
                                     original.execute('SELECT * FROM '+table+' ORDER BY 1').fetchall(), table)
                db.close(); original.close()
        for label, values in samples.items(): stats('30,000-frame prune '+label, values)


class RuntimeTests(unittest.TestCase):
    setUp = fixture.SemanticTests.setUp
    tearDown = fixture.SemanticTests.tearDown
    factory = fixture.SemanticTests.factory

    def test_runtime_get_does_not_wait_for_cold_or_explicit_probes(self):
        cli = self.root/'codex'; cli.write_text('#!/bin/sh\n', encoding='utf-8'); cli.chmod(0o700)
        row = {'backend':'codex', 'runtime_source':'local_cli', 'path':str(cli),
               'entry_supported':True, 'authenticated':True}
        self.c.session_factory_override = None
        self.c.settings.save({'backend':'codex','runtime_source':'local','executable':str(cli)})
        for cold in (True, False):
            with self.subTest(cold=cold):
                service = self.c.discovery = DiscoveryService(candidates=[('codex','local_cli',cli)])
                if not cold:
                    service._cached = {'runtimes':[{**row,'path':str(self.root/'other')}], 'scanned_at':time.time()}
                    service._identities = [None]
                    service._login_at = service._cached['scanned_at']
                release, started, completed = threading.Event(), threading.Event(), threading.Event()
                replies = []
                def inspect(candidate):
                    started.set(); release.wait(5); return row
                handler = SimpleNamespace(server=self.server, path='/character/runtime', auth=lambda token: True,
                                          json=lambda status, body: replies.append((status, body)))
                def request():
                    try: route(handler, 'GET', '/character/runtime')
                    finally: completed.set()
                with patch.object(service, '_inspect', side_effect=inspect):
                    request_thread = threading.Thread(target=request)
                    request_thread.start()
                    try:
                        self.assertTrue(started.wait(2))
                        self.assertTrue(completed.wait(0.5), 'GET waited for an external runtime probe')
                        self.assertEqual(replies[-1][0], 200)
                        self.assertFalse(replies[-1][1]['ready'])
                        self.assertIn(replies[-1][1]['error'], ('runtime_discovery_pending','runtime_probe_pending'))
                    finally:
                        release.set(); request_thread.join(5)
                        if service._background: service._background.join(5)
                        deadline = time.monotonic()+5
                        while getattr(service, '_inspecting', ()) and time.monotonic()<deadline: time.sleep(0.01)
                    self.assertTrue(self.c.public()['ready'])

    def test_first_runtime_get_reuses_completed_discovery(self):
        cli = self.root/'codex'; cli.write_text('#!/bin/sh\n', encoding='utf-8'); cli.chmod(0o700)
        row = {'backend':'codex', 'runtime_source':'local_cli', 'path':str(cli),
               'entry_supported':True, 'authenticated':True, 'version':'0.999.0'}
        self.c.session_factory_override = None
        self.c.settings.save({'backend':'codex','runtime_source':'local','executable':str(cli)})
        replies = []
        handler = SimpleNamespace(server=self.server, path='/character/runtime', auth=lambda token: True,
                                  json=lambda status, body: replies.append((status, body)))
        durations = []; profiles = []
        for _ in range(7):
            service = self.c.discovery = DiscoveryService(candidates=[('codex','local_cli',cli)])
            with patch.object(service, '_inspect', return_value=row):
                service.scan()
            with patch('character_agent.harness.discovery._probe', return_value=SimpleNamespace(
                    returncode=0, stdout='codex-cli 0.999.0\n--listen\nChatGPT', stderr='')), \
                 patch.object(service, '_inspect', wraps=service._inspect) as inspected:
                profile = cProfile.Profile()
                start = time.perf_counter(); profile.runcall(route, handler, 'GET', '/character/runtime')
                durations.append((time.perf_counter()-start)*1000); profiles.append(profile)
                self.assertEqual(replies[-1][0], 200)
                self.assertTrue(replies[-1][1]['ready'], replies[-1])
                self.assertEqual(replies[-1][1]['selected_runtime']['path'], str(cli))
                probe_calls = inspected.call_count
        stats('first GET /character/runtime (completed discovery, native CLI responses stubbed)', durations)
        output = io.StringIO(); pstats.Stats(profiles[durations.index(statistics.median(durations))], stream=output).sort_stats('cumulative').print_stats(12)
        print(output.getvalue())
        self.assertEqual(probe_calls, 0, 'completed discovery must supply the explicit runtime without probing it again')
        with patch.object(service, '_inspect', return_value=row) as inspect:
            cli.write_text('#!/bin/sh\n# updated binary\n', encoding='utf-8')
            service.inspect_runtime(str(cli), 'codex')
            self.assertEqual(inspect.call_count, 1)
            service.inspect_runtime(str(cli), 'codex', refresh=True)
            self.assertEqual(inspect.call_count, 2)
            service.clock = lambda: time.time()+31
            service.inspect_runtime(str(cli), 'codex')
            self.assertEqual(inspect.call_count, 3)

    def test_plain_runtime_get_lists_the_cached_installed_runtimes(self):
        cli = self.root/'codex'; cli.write_text('#!/bin/sh\n', encoding='utf-8'); cli.chmod(0o700)
        row = {'backend':'codex', 'runtime_source':'local_cli', 'path':str(cli),
               'entry_supported':True, 'authenticated':True}
        replies = []
        handler = SimpleNamespace(server=self.server, path='/character/runtime', auth=lambda token: True,
                                  json=lambda status, body: replies.append((status, body)))
        service = self.c.discovery = DiscoveryService(candidates=[('codex','local_cli',cli)])
        with patch.object(service, '_inspect', return_value=row):
            service.scan()
            route(handler, 'GET', '/character/runtime')
        self.assertEqual(replies[-1][0], 200)
        self.assertEqual([r['path'] for r in replies[-1][1]['installed_runtimes']], [str(cli)])


if __name__ == '__main__': unittest.main()
