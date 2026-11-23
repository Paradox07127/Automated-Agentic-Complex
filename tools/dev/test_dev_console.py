import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import dev_console as dc


class Paths(unittest.TestCase):
    """The console's support and state dirs under a temporary directory."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        tmp = Path(self.tmp.name)
        patches = {'SUPPORT_DIR': tmp / 'support', 'CONFIG': tmp / 'support/config.json', 'STATE_DIR': tmp / 'agentd-state',
                   'RUN': tmp}
        for name, value in patches.items():
            p = mock.patch.object(dc, name, value)
            p.start()
            self.addCleanup(p.stop)
        for name, value in {'release_catalog': lambda: str(tmp / 'library/current.json'), 'DEV_LIBRARY': tmp / 'dev-library',
                            'CATALOG': str(tmp / 'dev-library/current.json')}.items():
            p = mock.patch.object(dc, name, value)
            p.start()
            self.addCleanup(p.stop)
        # The checkouts under /w have the renderer's sources unless a test says otherwise.
        sources = mock.patch.object(dc, 'renderer_sources', lambda checkout: True)
        sources.start()
        self.addCleanup(sources.stop)

    def tearDown(self):
        self.tmp.cleanup()


class ShellConfigTest(Paths):
    def test_a_checkout_without_the_renderer_names_no_renderer(self):
        with mock.patch.object(dc, 'renderer_sources', lambda checkout: False):
            config = dc.shell_config(None, Path('/w/a'), Path('/w/r'))
        self.assertNotIn('avatar_app', config)
        self.assertNotIn('avatar_executable', config)

    def test_names_the_chosen_checkouts_and_the_console_dirs(self):
        agentd, renderer = Path('/w/a'), Path('/w/r')
        config = dc.shell_config(None, agentd, renderer)
        self.assertEqual(config['agentd_dir'], '/w/a/agent/agentd')
        self.assertEqual(config['avatar_executable'], '/w/r/private/renderer/host/.build/debug/metal-avatar-host')
        self.assertEqual(config['avatar_app'], '/w/r/private/renderer/host/.build/debug')
        self.assertEqual(config['python'], str(dc.MAIN / 'agent/.venv/bin/python'))
        self.assertEqual((config['agentd_port'], config['gpu_hold_files']), (48790, []))
        self.assertEqual(config['support_dir'], str(dc.SUPPORT_DIR))
        self.assertEqual(config['agentd_state_dir'], str(dc.STATE_DIR))
        self.assertEqual(config['character_catalog'], dc.CATALOG)
        self.assertEqual(config['plugins'], {'screen_awareness': False, 'computer_use': False})
        self.assertNotIn('observe_activity', config)
        self.assertNotIn('computer_use_enabled', config)

    def test_keeps_settings_and_recomputes_the_managed_keys(self):
        old = {'render_fps': 45, 'plugins': {'screen_awareness': True}, 'agentd_dir': '/old', 'agentd_port': 1, 'support_dir': '/old'}
        config = dc.shell_config(old, Path('/w/a'), Path('/w/r'))
        self.assertEqual((config['render_fps'], config['plugins']), (45, {'screen_awareness': True}))
        self.assertEqual((config['agentd_dir'], config['agentd_port'], config['support_dir']),
                         ('/w/a/agent/agentd', 48790, str(dc.SUPPORT_DIR)))

    def test_services_are_off_unless_the_config_chose_them(self):
        config = dc.shell_config({'render_fps': 45}, Path('/w/a'), Path('/w/r'))
        self.assertNotIn('services', config)
        self.assertFalse({'voice_service', 'tts_url', 'tts_tunnel_host'} & config.keys())
        chosen = {'services': {'tts': {'mode': 'ssh', 'url': 'http://127.0.0.1:9999', 'ssh_host': 'ws'}}}
        self.assertLessEqual(chosen.items(), dc.shell_config(chosen, Path('/w/a'), Path('/w/r')).items())

    def test_written_owner_only_and_kept_across_runs(self):
        path = dc.write_config(Path('/w/a'), Path('/w/r'))
        self.assertEqual(path, dc.CONFIG)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        saved = json.loads(path.read_text())
        path.write_text(json.dumps({**saved, 'render_fps': 30}))
        dc.write_config(Path('/w/b'), Path('/w/r'))
        again = json.loads(path.read_text())
        self.assertEqual((again['render_fps'], again['agentd_dir']), (30, '/w/b/agent/agentd'))


class ReleaseCatalogTest(unittest.TestCase):
    def test_public_profile_names_the_sample_library(self):
        with mock.patch.object(dc, 'default_profile', return_value=dc.ROOT / 'app/packaging/release.json'):
            catalog = dc.release_catalog()
        self.assertEqual(catalog, str(dc.ROOT / 'characters/sample-library/current.json'))
        self.assertTrue(Path(catalog).is_file())


class DevCatalogTest(Paths):
    """The console's imports go to its own copy of the release library, never into the release library."""

    def test_copies_the_release_library_and_keeps_imports_until_it_changes(self):
        release = Path(self.tmp.name, 'library')
        (release / 'packages/a').mkdir(parents=True)
        (release / 'packages/a/character.json').write_text('{}')
        (release / 'current.json').write_text('{"v": 1}')
        catalog = Path(dc.dev_catalog())
        self.assertEqual(catalog, dc.DEV_LIBRARY / 'current.json')
        self.assertEqual(catalog.read_text(), '{"v": 1}')
        self.assertTrue((dc.DEV_LIBRARY / 'packages/a/character.json').is_file())
        # An import writes into the copy only, and the copy keeps it while the release library is the same.
        (dc.DEV_LIBRARY / 'mmd-library').mkdir()
        catalog.write_text('{"v": 1, "imported": true}')
        dc.dev_catalog()
        self.assertTrue((dc.DEV_LIBRARY / 'mmd-library').is_dir())
        self.assertEqual(sorted(p.name for p in release.iterdir()), ['current.json', 'packages'])
        # A new release library replaces the copy, its imports dropped.
        (release / 'current.json').write_text('{"v": 2}')
        dc.dev_catalog()
        self.assertEqual(catalog.read_text(), '{"v": 2}')
        self.assertFalse((dc.DEV_LIBRARY / 'mmd-library').exists())

    def test_none_without_a_release_library(self):
        self.assertIsNone(dc.dev_catalog())
        self.assertFalse(dc.DEV_LIBRARY.exists())


class CommandTest(Paths):
    def test_shell_command_line(self):
        checkout = Path('/w/tree')
        self.assertEqual(dc.shell_command(checkout, ['--no-push-to-talk', '--no-attention']), [
            dc.ROOT / 'tools/platform/gpu-lock.sh', 'devconsole:tree', checkout / 'app/electron/node_modules/.bin/electron',
            checkout / 'app/electron', '--config', dc.CONFIG, '--dev-web-server', 'http://127.0.0.1:5190',
            '--no-push-to-talk', '--no-attention'])
        self.assertEqual(dc.SHELL_ARGS, ['--no-push-to-talk', '--no-attention'])

    def test_shell_steps_build_each_part_in_its_checkout(self):
        shell, renderer = Path(self.tmp.name, 'shell'), Path(self.tmp.name, 'renderer')
        (shell / 'app/electron').mkdir(parents=True)
        with mock.patch.dict(dc.PARTS, {'agentd': str(shell), 'renderer': str(renderer)}):
            steps = dc.COMPONENTS['shell'].steps(shell)
        commands = [s[0] for s in steps if s[2] != 'call']
        electron = shell / 'app/electron'
        self.assertIn((['node', electron / 'node_modules/electron/install.js'], {'cwd': electron}, 'wait'), steps)
        self.assertIn((['npm', 'run', 'build'], {'cwd': electron}, 'wait'), steps)
        self.assertIn(['swift', 'build', '-c', 'release', '--package-path', shell / 'app/helpers/mac'], commands)
        self.assertIn(['swift', 'build', '--package-path', renderer / 'private/renderer/host', '--product', 'metal-avatar-host'], commands)
        command, kw, mode = steps[-1]
        self.assertEqual((command, mode), (dc.shell_command(shell, dc.SHELL_ARGS), 'run'))
        self.assertNotIn('ELECTRON_OVERRIDE_DIST_PATH', kw['env'])
        self.assertEqual([s[2] for s in steps[-3:]], ['call', 'call', 'run'])

    def test_without_the_renderer_the_shell_runs_node_modules_electron(self):
        shell = Path(self.tmp.name, 'shell')
        (shell / 'app/electron').mkdir(parents=True)
        with mock.patch.object(dc, 'renderer_sources', lambda checkout: False), \
                mock.patch.dict(dc.PARTS, {'agentd': str(shell), 'renderer': str(shell)}):
            steps = dc.COMPONENTS['shell'].steps(shell)
        self.assertEqual(steps[-1], (dc.shell_command(shell, dc.SHELL_ARGS), {'env': {**os.environ,
                         'AGENTD_FRAME_LOG': str(dc.STATE_DIR / 'harness-frames.jsonl')}}, 'run'))

    def test_release_renderer_builds_and_names_the_release_host(self):
        with mock.patch.object(dc, 'RENDERER_BUILD', 'release'):
            config = dc.shell_config(None, Path('/w/a'), Path('/w/r'))
            builds = [c for c, _, mode in dc.COMPONENTS['shell'].steps(Path('/w/s')) if mode == 'wait' and 'metal-avatar-host' in c]
        self.assertEqual(config['avatar_executable'], '/w/r/private/renderer/host/.build/release/metal-avatar-host')
        self.assertEqual(config['avatar_app'], '/w/r/private/renderer/host/.build/release')
        self.assertEqual([c[:4] for c in builds], [['swift', 'build', '-c', 'release']])

    def test_main_takes_release_renderer_and_keeps_it_from_the_shell(self):
        started = []
        with mock.patch.object(dc, 'RENDERER_BUILD', 'debug'), mock.patch.object(dc.http.server, 'ThreadingHTTPServer'), \
                mock.patch.object(dc.signal, 'signal'), mock.patch.object(dc, 'stop_all'), \
                mock.patch.object(dc.Component, 'start', lambda self, checkout, args=None: started.append(args)):
            dc.main(['--release-renderer', '--quit-after', '5'])
            self.assertEqual(dc.RENDERER_BUILD, 'release')
        self.assertEqual(started[1], dc.SHELL_ARGS + ['--quit-after', '5'])

    def test_web_runs_vite_with_the_hmr_port_and_no_fake_bridge(self):
        web = Path(self.tmp.name, 'w')
        (web / 'web/node_modules').mkdir(parents=True)
        [(command, kw, mode)] = dc.COMPONENTS['web'].steps(web)
        self.assertEqual(command, ['npx', 'vite', '--host', '127.0.0.1', '--port', 5190, '--strictPort'])
        self.assertEqual((kw['cwd'], kw['env']['EF_DEV_HMR_PORT'], mode), (web / 'web', '5190', 'run'))
        self.assertNotIn('VITE_EF_DEV_CONSOLE', kw['env'])

    def test_missing_dependencies_use_the_selected_package_lock(self):
        main, checkout = Path(self.tmp.name, 'main'), Path(self.tmp.name, 'checkout')
        for name, relative in [('web', 'web'), ('shell', 'app/electron')]:
            package = checkout / relative
            package.mkdir(parents=True)
            (package / 'package-lock.json').write_text('{"name":"selected"}')
            with self.subTest(component=name), mock.patch.object(dc, 'MAIN', main):
                for has_modules in (False, True):
                    if has_modules:
                        (main / relative / 'node_modules').mkdir(parents=True)
                        (main / relative / 'package-lock.json').write_text('{"name":"main"}')
                    with self.subTest(main_installed=has_modules):
                        command, kw, mode = dc.Component(name).steps(checkout)[0]
                        self.assertEqual((command[:2], kw.get('cwd'), mode), (['npm', 'ci'], package, 'wait'))


class RefusalTest(unittest.TestCase):
    def test_refuses_the_installed_apps_port_and_dirs(self):
        home = Path('/Users/u')
        ok = (Path('/repo/.local/cache/dev-console/support'), Path('/repo/.local/cache/dev-console/agentd-state'))
        self.assertIsNone(dc.check_isolated(*ok, 48790, [], home))
        with self.assertRaisesRegex(dc.Refused, '48800'):
            dc.check_isolated(*ok, 48800, [], home)
        for support in (home / 'Library/Application Support/Agentic Complex', home / 'Library/Application Support/Agentic Complex/x',
                        home / 'Library/Application Support/local.agenticcomplex.companion'):
            with self.assertRaises(dc.Refused):
                dc.check_isolated(support, ok[1], 48790, [], home)
        with self.assertRaises(dc.Refused):
            dc.check_isolated(ok[0], home / 'Library/Application Support/AgenticComplex/agentd', 48790, [], home)
        with self.assertRaisesRegex(dc.Refused, '--config'):
            dc.check_isolated(*ok, 48790, ['--config', '/x/config.json'], home)

    def test_main_exits_before_starting_anything(self):
        with mock.patch.object(dc, 'AGENTD_PORT', 48800), mock.patch.object(dc.http.server, 'ThreadingHTTPServer') as server:
            with self.assertRaises(SystemExit) as e:
                dc.main([])
        self.assertNotEqual(e.exception.code, 0)
        server.assert_not_called()

    def test_help_prints_the_usage_and_starts_nothing(self):
        out = []
        with mock.patch.object(dc.http.server, 'ThreadingHTTPServer') as server, mock.patch.object(dc.Component, 'start') as start, \
                mock.patch('builtins.print', lambda *a, **kw: out.append(' '.join(map(str, a)))):
            for flag in ('--help', '-h'):
                with self.assertRaises(SystemExit) as e:
                    dc.main([flag])
                self.assertEqual(e.exception.code, 0)
        self.assertIn('--catalog PATH', out[0])
        server.assert_not_called()
        start.assert_not_called()

    def test_write_config_refuses_too(self):
        with mock.patch.object(dc, 'SUPPORT_DIR', Path.home() / 'Library/Application Support/Agentic Complex'):
            with self.assertRaises(dc.Refused):
                dc.write_config(Path('/w/a'), Path('/w/r'))


class StartupTest(Paths):
    """A start that fails before the shell and agentd are up prints one line and exits 1."""

    def fakes(self, phase):
        return {name: mock.Mock(snapshot=mock.Mock(return_value={'phase': phase}), log=Path(self.tmp.name, f'{name}.log'))
                for name in ('web', 'shell')}

    def test_a_failed_step_is_a_failure(self):
        with mock.patch.dict(dc.COMPONENTS, self.fakes("failed([Errno 2] No such file or directory: 'npm')")):
            failure = dc.startup_failure(0)
        self.assertIn("web failed([Errno 2] No such file or directory: 'npm')", failure)

    def test_a_config_error_after_this_start_is_a_failure(self):
        log = dc.SUPPORT_DIR / 'logs/companion.log'
        log.parent.mkdir(parents=True)
        log.write_text('t companion: ERROR config old\n')
        start = log.stat().st_size
        with mock.patch.dict(dc.COMPONENTS, self.fakes('running')):
            self.assertIsNone(dc.startup_failure(start))
            with log.open('a') as f:
                f.write('t companion: STARTED pid=1\nt companion: ERROR config 缺少字段 characters\n')
            failure = dc.startup_failure(start)
        self.assertIn('ERROR config 缺少字段 characters', failure)
        self.assertNotIn('ERROR config old', failure)

    def test_main_prints_the_failure_and_exits_1(self):
        class Server:
            def __init__(self, *_):
                self.done = dc.threading.Event()
            def serve_forever(self):
                self.done.wait(5)
            def shutdown(self):
                self.done.set()
        errors = []
        with mock.patch.object(dc.http.server, 'ThreadingHTTPServer', Server), mock.patch.object(dc.signal, 'signal'), \
                mock.patch.object(dc, 'stop_all') as stop_all, mock.patch.object(dc.Component, 'start'), \
                mock.patch.object(dc, 'startup_failure', lambda start: 'shell failed(exit 1)'), \
                mock.patch.object(dc.sys, 'stderr', mock.Mock(write=errors.append)):
            with self.assertRaises(SystemExit) as e:
                dc.main([])
        self.assertEqual(e.exception.code, 1)
        self.assertIn('dev console: shell failed(exit 1)', ''.join(errors))
        stop_all.assert_called_once()



class StatusTest(Paths):
    """What the console page shows besides each process's phase."""

    def companion(self, text):
        log = dc.SUPPORT_DIR / 'logs/companion.log'
        log.parent.mkdir(parents=True, exist_ok=True)
        with log.open('a') as f:
            f.write(text)
        return log

    def test_renderer_link_is_the_last_hostlink_line_of_this_run(self):
        self.assertEqual(dc.renderer_link(0), {'state': 'waiting', 'character': None})
        log = self.companion('t hostlink: HOSTLINK hello character=old capabilities=a\n')
        mark = log.stat().st_size
        self.assertEqual(dc.renderer_link(mark)['state'], 'waiting')
        self.companion('t hostlink: HOSTLINK avatar connected\n')
        self.assertEqual(dc.renderer_link(mark)['state'], 'connecting')
        self.companion('t hostlink: HOSTLINK hello character=jsspsi capabilities=heartbeat,ack\nt hostlink: HOSTLINK heartbeat\n')
        self.assertEqual(dc.renderer_link(mark), {'state': 'connected', 'character': 'jsspsi'})
        self.companion('t hostlink: HOSTLINK avatar disconnected: EOF\n')
        self.assertEqual(dc.renderer_link(mark)['state'], 'disconnected')

    def test_shell_start_records_the_heads_it_builds_and_the_log_mark(self):
        self.companion('before\n')
        trees = [{'path': '/w/s', 'head': 'aaa'}, {'path': '/w/a', 'head': 'bbb'}, {'path': '/w/r', 'head': 'ccc'}]
        shell = dc.Component('shell')
        with mock.patch.object(dc, 'worktrees', return_value=trees), mock.patch.object(dc.Component, '_run'), \
                mock.patch.dict(dc.PARTS, {'agentd': '/w/a', 'renderer': '/w/r'}):
            shell.start('/w/s')
            web = dc.Component('web')
            web.start('/w/a')
        self.assertEqual(shell.snapshot()['built'], {'shell': 'aaa', 'agentd': 'bbb', 'renderer': 'ccc'})
        self.assertEqual(shell.mark, len('before\n'))
        self.assertEqual(web.snapshot()['built'], {'web': 'bbb'})

    def test_agentd_health_is_its_object_or_none(self):
        class Connection:
            body = b'{"status": "ok", "degraded": ["tts"]}'
            def __init__(self, *_, **__): pass
            def request(self, *_): pass
            def getresponse(self): return mock.Mock(read=lambda: self.body)
            def close(self): pass
        with mock.patch.object(dc.http.client, 'HTTPConnection', Connection):
            self.assertEqual(dc.agentd_health(), {'status': 'ok', 'degraded': ['tts']})
            self.assertTrue(dc.agentd_ready())
            Connection.body = b'[]'
            self.assertIsNone(dc.agentd_health())
            self.assertFalse(dc.agentd_ready())
            Connection.request = mock.Mock(side_effect=ConnectionRefusedError)
            self.assertIsNone(dc.agentd_health())

    def serve(self):
        server = dc.http.server.ThreadingHTTPServer(('127.0.0.1', 0), dc.Handler)
        dc.threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

        def get(path):
            connection = dc.http.client.HTTPConnection('127.0.0.1', server.server_address[1], timeout=5)
            connection.request('GET', path, headers={'Host': f'127.0.0.1:{dc.PORT}'})
            return connection.getresponse().read()
        return get

    def test_state_has_agentd_health_and_the_renderer_link_while_the_shell_runs(self):
        get = self.serve()
        fakes = {n: mock.Mock(snapshot=mock.Mock(return_value={'phase': 'running', 'built': None}), mark=7)
                 for n in ('web', 'shell')}
        with mock.patch.dict(dc.COMPONENTS, fakes), mock.patch.object(dc, 'worktrees', return_value=[]), \
                mock.patch.object(dc, 'agentd_health', return_value={'status': 'ok', 'degraded': []}), \
                mock.patch.object(dc, 'renderer_link', return_value={'state': 'connected', 'character': 'x'}) as link:
            state = json.loads(get('/api/state'))
            link.assert_called_once_with(7)
            self.assertEqual(state['agentd'], {'status': 'ok', 'degraded': []})
            self.assertEqual(state['renderer'], {'state': 'connected', 'character': 'x'})
            self.assertEqual(state['ports'], {'console': 48780, 'web': 5190, 'agentd': 48790})
            self.assertEqual(set(state['logs']), set(dc.LOGS) | set(dc.RECORDS))
            for fake in fakes.values():
                fake.snapshot.return_value = {'phase': 'stopped'}
            state = json.loads(get('/api/state'))
        self.assertEqual((state['agentd'], state['renderer']), (None, None))

    def test_a_long_log_is_its_tail_from_a_whole_line(self):
        get = self.serve()
        log = Path(self.tmp.name, 'web.log')
        log.write_text('first line\nsecond\nthird\n')
        with mock.patch.dict(dc.LOGS, {'web': log}):
            self.assertEqual(get('/api/log?component=web'), log.read_bytes())
            with mock.patch.object(dc, 'LOG_TAIL', 12):
                self.assertEqual(get('/api/log?component=web'), b'third\n')


class RecordsTest(Paths):
    """agentd's trace events and character runs, read from its databases without writing."""

    def trace_db(self):
        dc.STATE_DIR.mkdir(parents=True)
        db = dc.sqlite3.connect(dc.STATE_DIR / 'agentd.sqlite')
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('CREATE TABLE trace_events (id INTEGER PRIMARY KEY, t_wall TEXT, kind TEXT, status TEXT, trace_id TEXT, '
                   'turn_id TEXT, event TEXT, text TEXT)')
        rows = [('2026-11-21T06:26:29.475-05:00', 'model.started', 'ok', 'bbb57074-71', 't1', {'attrs': {}}, None),
                ('2026-11-21T06:26:29.480-05:00', 'behavior.ticked', 'ok', 'ccc', None, {'attrs': {}}, None),
                ('2026-11-21T06:26:29.497-05:00', 'model.finished', 'ok', 'bbb57074-71', 't1',
                 {'attrs': {'model': 'fixture', 'input_tokens': 20}, 'duration_ms': 21}, None),
                ('2026-11-21T06:26:29.500-05:00', 'speech.finished', 'failed', 'bbb57074-71', 't1',
                 {'attrs': {'reason': 'unreachable'}}, {'text': '第一行\n第二行'})]
        db.executemany('INSERT INTO trace_events (t_wall, kind, status, trace_id, turn_id, event, text) VALUES (?,?,?,?,?,?,?)',
                       [(*r[:5], json.dumps(r[5]), r[6] and json.dumps(r[6], ensure_ascii=False)) for r in rows])
        db.commit()
        return db

    def test_trace_lines_are_the_events_without_the_behavior_tick(self):
        self.assertEqual(dc.trace_lines(), [])
        self.addCleanup(self.trace_db().close)
        self.assertEqual(dc.trace_lines(), [
            '2026-11-21T06:26:29.475-05:00 model.started trace=bbb57074 turn=t1',
            '2026-11-21T06:26:29.497-05:00 model.finished trace=bbb57074 turn=t1 model=fixture input_tokens=20 duration_ms=21',
            '2026-11-21T06:26:29.500-05:00 speech.finished failed trace=bbb57074 turn=t1 reason=unreachable text=第一行 第二行'])
        with mock.patch.object(dc, 'RECORD_ROWS', 1):
            self.assertEqual(len(dc.trace_lines()), 1)

    def test_the_trace_is_read_without_writing(self):
        db = self.trace_db()
        self.addCleanup(db.close)
        with closing_read_only(dc.STATE_DIR / 'agentd.sqlite') as reader, self.assertRaises(dc.sqlite3.OperationalError):
            reader.execute("DELETE FROM trace_events")

    def test_run_lines_merge_events_and_items_in_time_order(self):
        (dc.STATE_DIR / 'character-agent').mkdir(parents=True)
        db = dc.sqlite3.connect(dc.STATE_DIR / 'character-agent/runs.sqlite')
        self.addCleanup(db.close)
        db.execute('CREATE TABLE character_run_events (run_id TEXT, seq INTEGER, kind TEXT, metadata TEXT, at REAL)')
        db.execute('CREATE TABLE character_run_items (run_id TEXT, item_id TEXT, kind TEXT, status TEXT, name TEXT, '
                   'summary TEXT, text TEXT, updated_at REAL)')
        db.executemany('INSERT INTO character_run_events VALUES (?,?,?,?,?)', [
            ('r1', 1, 'running', json.dumps({'backend': 'pi', 'model': 'fixture'}), 100.0),
            ('r1', 2, 'completed', json.dumps({'outcome': 'answered'}), 103.0)])
        db.executemany('INSERT INTO character_run_items VALUES (?,?,?,?,?,?,?,?)', [
            ('r1', 'r1:t1', 'tool_call', 'completed', 'read_file', 'path=a.md', '', 101.0),
            ('r1', 'r1:m2', 'assistant_text', 'completed', None, None, 'x' * 500, 102.0)])
        db.commit()
        lines = [line.split(' ', 1)[1] for line in dc.run_lines()]
        self.assertEqual(lines, ['run=r1 running backend=pi model=fixture', 'run=r1 item.tool_call completed read_file text=path=a.md',
                                 f'run=r1 item.assistant_text completed text={"x" * 400}…', 'run=r1 completed outcome=answered'])
        self.assertRegex(dc.run_lines()[0], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:40\.000[+-]\d\d:\d\d run=r1 ')

    def test_a_record_that_cannot_be_read_says_why(self):
        server = dc.http.server.ThreadingHTTPServer(('127.0.0.1', 0), dc.Handler)
        dc.threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        dc.STATE_DIR.mkdir(parents=True)
        dc.sqlite3.connect(dc.STATE_DIR / 'agentd.sqlite').close()
        connection = dc.http.client.HTTPConnection('127.0.0.1', server.server_address[1], timeout=5)
        connection.request('GET', '/api/log?component=trace', headers={'Host': f'127.0.0.1:{dc.PORT}'})
        body = connection.getresponse().read().decode()
        self.assertIn('no such table: trace_events', body)
        self.assertIn(str(dc.STATE_DIR / 'agentd.sqlite'), body)


    def frames(self, *records, partial=b''):
        dc.STATE_DIR.mkdir(parents=True, exist_ok=True)
        with dc.frame_log().open('ab') as f:
            for record in records:
                f.write(json.dumps(record, ensure_ascii=False).encode() + b'\n')
            f.write(partial)

    def test_frame_lines_show_each_frame_and_its_long_values_as_blocks(self):
        self.assertEqual(dc.frame_lines(), [])
        self.frames({'at': 'T1', 'dir': 'out', 'backend': 'Pi', 'pid': 7,
                     'frame': {'v': 1, 'type': 'query', 'run_id': 'r1', 'prompt': '第一行\n第二行', 'history': [{'role': 'user'}]}},
                    {'at': 'T2', 'dir': 'in', 'backend': 'Pi', 'pid': 7,
                     'frame': {'v': 1, 'seq': 3, 'type': 'text_delta', 'run_id': 'r1', 'text': '你好'}},
                    partial=b'{"at": "T3", "dir"')
        self.assertEqual(dc.frame_lines(), ['T1 → Pi pid=7 query run=r1 history=[{"role":"user"}]', '    prompt:', '    │ 第一行', '    │ 第二行',
                                            'T2 ← Pi pid=7 text_delta run=r1 text=你好'])
        with mock.patch.object(dc, 'FRAME_BLOCK_LINES', 1):
            self.assertEqual(dc.frame_lines()[3], f'    │ … 1 more lines in {dc.frame_log()}')

def closing_read_only(path):
    return dc.closing(dc.read_only(path))

class CleanupTest(unittest.TestCase):
    def test_ctrl_c_stops_the_shell_before_vite(self):
        stopped = []
        fakes = {name: mock.Mock(stop=lambda name=name: stopped.append(name)) for name in ('web', 'shell')}
        with mock.patch.dict(dc.COMPONENTS, fakes):
            dc.stop_all()
        self.assertEqual(stopped, ['shell', 'web'])

    def test_preparation_and_lock_wait_stop_the_process_group(self):
        for phase in ('preparing', 'running'):
            with self.subTest(phase=phase):
                component = dc.Component('shell')
                component.phase, component.proc = phase, mock.Mock(pid=42)
                component.proc.poll.return_value = None
                with mock.patch.dict(os.environ, AAC_LOCK_HELD_gpu=''), mock.patch.object(dc.subprocess, 'run') as pgrep, \
                        mock.patch.object(os, 'kill') as kill, mock.patch.object(os, 'killpg') as killpg:
                    # The lock waiter has only a sleep child.
                    pgrep.side_effect = lambda argv, **kw: mock.Mock(stdout='43' if '-f' not in argv or re.search(argv[-1], 'sleep 2') else '')
                    component.stop()
                self.assertIn(mock.call(42, signal.SIGTERM), killpg.call_args_list)
                kill.assert_not_called()

    def test_child_exiting_during_sigterm_still_cleans_up_and_stops_web(self):
        shell, web = dc.Component('shell'), mock.Mock()
        shell.phase, shell.proc = 'running', mock.Mock(pid=42)
        shell.proc.poll.return_value = None
        with mock.patch.dict(dc.COMPONENTS, shell=shell, web=web), mock.patch.dict(os.environ, AAC_LOCK_HELD_gpu=''), \
                mock.patch.object(dc.subprocess, 'run', return_value=mock.Mock(stdout='43')), \
                mock.patch.object(os, 'kill', side_effect=ProcessLookupError), mock.patch.object(os, 'killpg') as killpg:
            dc.stop_all()
        killpg.assert_any_call(42, signal.SIGKILL)
        web.stop.assert_called_once()

    @unittest.skipIf(sys.platform == 'win32', 'process groups and SIGTERM are POSIX')
    def test_shell_stop_signals_the_shell_not_its_lock_wrapper(self):
        """The shell quits its renderer, agentd and helper in order; the wrapper only waits for it."""
        with tempfile.TemporaryDirectory() as tmp:
            marks = Path(tmp)
            child = (f'import os, signal, sys, time, pathlib\n'
                     f'signal.signal(signal.SIGTERM, lambda *_: (pathlib.Path({str(marks)!r}, "child").write_text("term"), sys.exit(0)))\n'
                     f'pathlib.Path({str(marks)!r}, "ready").write_text(str(os.getpid()))\n'
                     f'time.sleep(30)\n')
            wrapper = ['bash', '-c', f'trap \'echo term > {marks}/wrapper\' TERM; "$@"; echo done > {marks}/done', 'w',
                       sys.executable, '-c', child]
            component = dc.Component('shell')
            component.phase = 'running'
            component.proc = subprocess.Popen(wrapper, start_new_session=True)
            deadline = time.time() + 10
            while not (marks / 'ready').exists() and time.time() < deadline:
                time.sleep(0.05)
            # The wrapper runs a Python stand-in for the Electron launcher.
            def pgrep(argv, **kw):
                self.assertEqual(argv[:4], ['pgrep', '-P', str(component_pid), '-f'])
                self.assertRegex('node /checkout/app/electron/node_modules/.bin/electron /checkout/app/electron', argv[-1])
                return mock.Mock(stdout=(marks / 'ready').read_text())
            component_pid = component.proc.pid
            with mock.patch.dict(os.environ, {}, clear=False), mock.patch.object(dc.subprocess, 'run', pgrep):
                os.environ.pop('AAC_LOCK_HELD_gpu', None)
                component.stop()
            self.assertEqual((marks / 'child').read_text(), 'term')
            self.assertFalse((marks / 'wrapper').exists())
            self.assertEqual((marks / 'done').read_text(), 'done\n')


class WindowsTest(Paths):
    """The Windows seam, with the platform passed in, so it runs on macOS too."""

    def test_config_names_efw_and_the_agentd_python(self):
        venv = dc.MAIN / 'agent/.venv/Scripts/python.exe'
        with mock.patch.dict(os.environ, AGENTD_PYTHON='C:\\py\\python.exe'):
            config = dc.shell_config(None, Path('/w/a'), Path('/w/r'), 'win32')
            self.assertEqual(config['avatar_executable'], str(Path('/w/r/private/renderer/windows/build/efw.exe')))
            self.assertEqual(config['avatar_app'], str(Path('/w/r/private/renderer/windows/build')))
            self.assertEqual(config['python'], 'C:\\py\\python.exe')
            with mock.patch.object(dc, 'PYTHON', 'D:\\other\\python.exe'):
                self.assertEqual(dc.shell_config(None, Path('/w/a'), Path('/w/r'), 'win32')['python'], 'D:\\other\\python.exe')
            # macOS keeps the main checkout's venv.
            self.assertEqual(dc.shell_config(None, Path('/w/a'), Path('/w/r'), 'darwin')['python'], str(dc.MAIN / 'agent/.venv/bin/python'))
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop('AGENTD_PYTHON', None)
            with mock.patch.object(Path, 'exists', lambda p: p == venv):
                self.assertEqual(dc.shell_config(None, Path('/w/a'), Path('/w/r'), 'win32')['python'], str(venv))
            with mock.patch.object(Path, 'exists', lambda p: False), self.assertRaisesRegex(ValueError, '--python'):
                dc.shell_config(None, Path('/w/a'), Path('/w/r'), 'win32')

    def test_catalog_option_names_the_library(self):
        with mock.patch.object(dc, 'CATALOG', 'C:\\lib\\current.json'):
            self.assertEqual(dc.shell_config(None, Path('/w/a'), Path('/w/r'), 'darwin')['character_catalog'], 'C:\\lib\\current.json')

    def test_release_renderer_changes_nothing(self):
        with mock.patch.dict(os.environ, AGENTD_PYTHON='C:\\py\\python.exe'):
            debug = dc.shell_config(None, Path('/w/a'), Path('/w/r'), 'win32')
            with mock.patch.object(dc, 'RENDERER_BUILD', 'release'):
                self.assertEqual(dc.shell_config(None, Path('/w/a'), Path('/w/r'), 'win32'), debug)

    def test_shell_command_runs_electron_exe_without_the_gpu_lock(self):
        checkout = Path('/w/tree')
        self.assertEqual(dc.shell_command(checkout, ['--no-push-to-talk'], 'win32'), [
            checkout / 'app/electron/node_modules/electron/dist/electron.exe', checkout / 'app/electron', '--config', dc.CONFIG,
            '--dev-web-server', 'http://127.0.0.1:5190', '--no-push-to-talk'])

    def test_shell_steps_use_the_windows_builders(self):
        shell, renderer = Path(self.tmp.name, 'shell'), Path(self.tmp.name, 'renderer')
        electron = shell / 'app/electron'
        electron.mkdir(parents=True)
        with mock.patch.dict(dc.PARTS, {'agentd': str(shell), 'renderer': str(renderer)}):
            steps = dc.Component('shell').steps(shell, 'win32')
        self.assertEqual(steps[0], (['npm.cmd', 'ci', '--ignore-scripts', '--prefer-offline'], {'cwd': electron}, 'wait'))
        self.assertIn((['node', electron / 'node_modules/electron/install.js'], {'cwd': electron}, 'wait'), steps)
        self.assertIn((['npm.cmd', 'run', 'build'], {'cwd': electron}, 'wait'), steps)
        self.assertIn((['cmd', '/d', '/c', 'build.bat'], {'cwd': shell / 'app/helpers/windows'}, 'wait'), steps)
        self.assertIn((['cmd', '/d', '/c', 'run.bat'], {'cwd': renderer / 'private/renderer/windows'}, 'wait'), steps)
        self.assertFalse([s for s in steps if s[2] != 'call' and 'swift' in s[0]])
        self.assertEqual(steps[-1], (dc.shell_command(shell, dc.SHELL_ARGS, 'win32'), {'env': {**os.environ,
                         'AGENTD_FRAME_LOG': str(dc.STATE_DIR / 'harness-frames.jsonl')}}, 'run'))
        self.assertEqual([s[2] for s in steps[-3:]], ['call', 'call', 'run'])

    def test_web_runs_vite_through_npx_cmd(self):
        web = Path(self.tmp.name, 'w')
        web.joinpath('web').mkdir(parents=True)
        steps = dc.Component('web').steps(web, 'win32')
        self.assertEqual([s[0][:2] for s in steps], [['npm.cmd', 'ci'], ['npx.cmd', 'vite']])

    def test_children_start_in_their_own_group(self):
        self.assertEqual(dc.group_kwargs('win32'), {'creationflags': 0x200})
        self.assertEqual(dc.group_kwargs('darwin'), {'start_new_session': True})

    def test_stop_kills_the_process_tree(self):
        for phase in ('preparing', 'running'):
            with self.subTest(phase=phase):
                component, proc = dc.Component('shell'), mock.Mock(pid=42)
                component.phase, component.proc = phase, proc
                proc.poll.return_value = None
                with mock.patch.object(dc.subprocess, 'run') as run, mock.patch.object(os, 'kill') as kill, \
                        mock.patch.object(os, 'killpg') as killpg:
                    component.stop('win32')
                self.assertEqual(run.call_args.args[0], ['taskkill', '/T', '/F', '/PID', '42'])
                proc.wait.assert_called()
                kill.assert_not_called()
                killpg.assert_not_called()

    def test_refuses_the_installed_apps_dirs(self):
        home = 'C:\\Users\\u'
        env = {'APPDATA': 'C:\\Users\\u\\AppData\\Roaming', 'LOCALAPPDATA': 'C:\\Users\\u\\AppData\\Local'}
        ok = ('C:\\repo\\.local\\cache\\dev-console\\support', 'C:\\repo\\.local\\cache\\dev-console\\agentd-state')
        self.assertIsNone(dc.check_isolated(*ok, 48790, [], home, 'win32', env))
        self.assertIsNone(dc.check_isolated('C:\\Users\\u\\AppData\\Roaming\\Agentic Complex Dev', ok[1], 48790, [], home, 'win32', env))
        for support in ('c:\\users\\u\\appdata\\roaming\\agentic complex', 'C:\\Users\\u\\AppData\\Roaming\\Agentic Complex\\x',
                        'C:/Users/u/AppData/Local/Agentic Complex/agentd'):
            with self.subTest(support=support), self.assertRaises(dc.Refused):
                dc.check_isolated(support, ok[1], 48790, [], home, 'win32', env)
        # Without APPDATA and LOCALAPPDATA, the same directories under the home directory.
        with self.assertRaises(dc.Refused):
            dc.check_isolated(ok[0], 'C:\\Users\\u\\AppData\\Local\\Agentic Complex\\agentd', 48790, [], home, 'win32', {})


class CheckTest(Paths):
    """--check: starts web and the shell, waits for each step in turn, prints one line and stops everything."""

    def run_check(self, reached, phase='running', catalog=True):
        library, self.check = Path(self.tmp.name, 'library/current.json'), Path(self.tmp.name, 'check')
        self.check.mkdir()
        if catalog:
            library.parent.mkdir(parents=True)
            library.write_text('{}')
        fakes = {name: mock.Mock(snapshot=mock.Mock(return_value={'phase': phase})) for name in ('web', 'shell')}
        probes = {name: (lambda name=name: name in reached) for name in ('web_listening', 'shell_running', 'agentd_ready', 'renderer_hello')}
        out = []
        with mock.patch.dict(dc.COMPONENTS, fakes), mock.patch.object(dc, 'CHECK_SECONDS', dict.fromkeys(dc.CHECK_SECONDS, 0.2)), \
                mock.patch.multiple(dc, **probes), mock.patch.object(dc, 'stop_all') as stop_all, \
                mock.patch.object(dc.tempfile, 'mkdtemp', return_value=str(self.check)), \
                mock.patch.object(dc, 'CATALOG', None), \
                mock.patch.object(dc.time, 'sleep'), mock.patch('builtins.print', lambda *a, **kw: out.append(' '.join(map(str, a)))):
            with self.assertRaises(SystemExit) as exit:
                dc.main(['--check', '--quit-after', '5'])
            self.catalog = dc.CATALOG
        return exit.exception.code, out, fakes, stop_all

    def test_passes_when_every_step_is_reached(self):
        code, out, fakes, stop_all = self.run_check({'web_listening', 'shell_running', 'agentd_ready', 'renderer_hello'})
        self.assertEqual(code, 0)
        self.assertRegex(out[-1], r'^DEV-CONSOLE-CHECK pass: vite, builds, agentd health, renderer hello in \d+ s$')
        stop_all.assert_called_once()
        self.assertEqual(fakes['shell'].start.call_args.args[1], dc.SHELL_ARGS + ['--quit-after', '5'])
        # A temporary support dir, logs included, removed after a pass.
        self.assertEqual(dc.SUPPORT_DIR, self.check / 'support')
        self.assertEqual(fakes['web'].log, self.check / 'web.log')
        self.assertFalse(self.check.exists())
        self.assertEqual(self.catalog, str(dc.DEV_LIBRARY / 'current.json'))

    def test_fails_at_the_first_step_not_reached(self):
        code, out, _, stop_all = self.run_check({'web_listening', 'shell_running'})
        self.assertEqual(code, 1)
        self.assertEqual(out[-1], f'DEV-CONSOLE-CHECK fail at agentd health (not within 0.2 s); passed vite, builds; logs in {self.check}')
        self.assertTrue(self.check.exists())
        stop_all.assert_called_once()

    def test_fails_when_a_component_stops(self):
        code, out, _, _ = self.run_check({'web_listening'}, phase='failed(exit 1)')
        self.assertEqual(code, 1)
        self.assertIn('fail at builds (web failed(exit 1), shell failed(exit 1))', out[-1])

    def test_without_the_renderer_it_does_not_wait_for_its_hello(self):
        with mock.patch.object(dc, 'renderer_sources', lambda checkout: False):
            code, out, _, _ = self.run_check({'web_listening', 'shell_running', 'agentd_ready'})
        self.assertEqual(code, 0)
        self.assertRegex(out[-1], r'^DEV-CONSOLE-CHECK pass: vite, builds, agentd health in \d+ s$')

    def test_needs_a_character_library(self):
        code, out, fakes, _ = self.run_check(set(), catalog=False)
        self.assertEqual(code, 1)
        self.assertIn('fail at character library', out[-1])
        fakes['shell'].start.assert_not_called()


if __name__ == '__main__':
    unittest.main()
