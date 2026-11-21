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
        catalog = mock.patch.object(dc, 'release_catalog', lambda: str(tmp / 'library/current.json'))
        catalog.start()
        self.addCleanup(catalog.stop)
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
        self.assertEqual(config['character_catalog'], str(dc.release_catalog()))
        self.assertEqual(config['plugins'], {'screen_awareness': False, 'computer_use': False})
        self.assertNotIn('observe_activity', config)
        self.assertNotIn('computer_use_enabled', config)

    def test_keeps_settings_and_recomputes_the_managed_keys(self):
        old = {'render_fps': 45, 'plugins': {'screen_awareness': True}, 'agentd_dir': '/old', 'agentd_port': 1, 'support_dir': '/old'}
        config = dc.shell_config(old, Path('/w/a'), Path('/w/r'))
        self.assertEqual((config['render_fps'], config['plugins']), (45, {'screen_awareness': True}))
        self.assertEqual((config['agentd_dir'], config['agentd_port'], config['support_dir']),
                         ('/w/a/agent/agentd', 48790, str(dc.SUPPORT_DIR)))

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
            config = dc.shell_config({'character_catalog': '/old/current.json'}, dc.ROOT, dc.ROOT)
        self.assertEqual(config['character_catalog'], str(dc.ROOT / 'characters/sample-library/current.json'))
        self.assertTrue(Path(config['character_catalog']).is_file())


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
        self.assertEqual(steps[-1], (dc.shell_command(shell, dc.SHELL_ARGS), {}, 'run'))
        self.assertEqual([s[2] for s in steps[-3:]], ['call', 'call', 'run'])

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
        self.assertEqual(steps[-1], (dc.shell_command(shell, dc.SHELL_ARGS, 'win32'), {}, 'run'))
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
                mock.patch.object(dc.time, 'sleep'), mock.patch('builtins.print', lambda *a, **kw: out.append(' '.join(map(str, a)))):
            with self.assertRaises(SystemExit) as exit:
                dc.main(['--check', '--quit-after', '5'])
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
