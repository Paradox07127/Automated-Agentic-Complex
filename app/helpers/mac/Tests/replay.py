"""Replays the C12 fixtures against the macOS ac-helper and checks every answer.

Usage: python3 -I app/helpers/mac/Tests/replay.py [--exe PATH]   (after swift build -c release in app/helpers/mac)

The session, bad-fixture, edge-case and op-table checks are the Windows helper's (app/helpers/windows/tests/replay.py,
imported); this file holds the macOS replay of examples/ok-*.ndjson and its answer checks:
- every ok-*.ndjson is replayed, ok-windows-helper.ndjson too: its ops either succeed (permissions.status) or answer
  unsupported, so the session stays valid on macOS; permissions.request and terminal.focus are left out (NOT_SENT);
- the requests are aimed so that nothing on this Mac changes and no other program's window is read: apps.activate
  names a process without an interface (the replay) or an app id nobody has, so it activates nothing;
  windows.at_point with titles and ax.hit_chain look off every screen; every other ax.* op names the replay, which has
  no window; attention.sample reads no titles; browser.front_tab names an app id nobody has; clipboard.read reads a
  private pasteboard (AC_HELPER_PASTEBOARD), never the user's clipboard; capture.window and ocr.recognize name a window
  nobody has; capture.ambient answers side×side pixels only; every helper records a synthetic tone in place of the
  microphone (AC_HELPER_MIC_SYNTHETIC); ptt.register takes right_option or a combo nobody uses, never the fixtures';
- the AX ops and input.watch answer permission_denied when the helper lacks the Accessibility grant (read first with
  permissions.status), and otherwise succeed or answer one of their own errors; the screen and right_option ops follow
  the Screen Recording and Input Monitoring grants the same way;
- params checks, the absent-process and no-grant paths (the AC_HELPER_*_DENIED switches), cancel next to an AX request,
  the watches on and off, the media checks (one window captured at 64 px and dropped after its size and format are
  checked, mic.start twice, mic.stop twice, the same combo twice and a combo another helper holds), and an op-table
  sweep that knows which ops need the grant;
- each watch's first event follows its answer (AC_HELPER_WATCH_PROBE); ptt.typed comes inside a right_option hold
  (AC_HELPER_PTT_PROBE, a scripted key state) and speech.download before mic.start's answer (AC_HELPER_DOWNLOAD_PROBE);
- control.listen and control.respond over a socket in a temporary directory the replay connects to itself, and
  control.observe, control.act and control.read on the replay's own window (ac-helper-testwindow, a panel that never
  takes focus) under AC_HELPER_INPUT_RECORD, so that no input is posted; ax.watch's watch ids, reads at subscription,
  text, keys and window on the same window, whose app reports its text field as the focus without taking the keyboard;
  ax.watch and ax.window_text also while that window's app is stopped (SIGSTOP), so that its AX messages time out.
Events may arrive between answers (input.activity while the user types); they stay in the transcript validate.check
reads. Opens no window but its own panel and asks for no permission; failure lines print result shapes, never what was read. Ends with `HELPER-MAC: <n> checks, <m> failed`; exits 1 when one failed.
"""
import argparse
import base64
import importlib.util
import json
import os
from pathlib import Path
import select
import signal
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
EXE = HERE.parent / '.build/release/ac-helper'
TEST_WINDOW = HERE.parent / '.build/release/ac-helper-testwindow'
ABSENT_APP = 'local.c12-replay.absent'


def load_windows_replay():
    spec = importlib.util.spec_from_file_location('c12_replay_win', REPO / 'app/helpers/windows/tests/replay.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


win = load_windows_replay()
SESSION, C12 = win.SESSION, win.C12
IMPLEMENTED = {'screens.list', 'windows.list', 'windows.at_point', 'clipboard.read', 'apps.running', 'apps.activate',
               'process.usage', 'permissions.status', 'workspace.watch', 'attention.sample', 'presence.watch',
               'browser.front_tab', 'input.modifiers', 'input.watch', 'input.actions', 'ax.focused', 'ax.dialog_buttons', 'ax.overlays',
               'ax.hit_chain', 'ax.window_text', 'ax.window_tree', 'ax.selected_text', 'ax.video_rect', 'ax.watch', 'capture.window',
               'capture.ambient', 'ocr.languages', 'ocr.recognize', 'speech.locales', 'mic.start', 'mic.stop',
               'ptt.register', 'ptt.unregister', 'control.observe', 'control.act', 'control.read', 'control.listen',
               'control.respond', 'apps.installed', 'permissions.request', 'terminal.focus'}
# Never sent with params that pass: they may show a system prompt or bring a terminal to the front. The unit tests check
# them over fake system calls.
NOT_SENT = {'permissions.request', 'terminal.focus'}
EVENTS = {'workspace.changed', 'presence.edge', 'input.activity', 'input.action', 'ax.notification', 'mic.level', 'speech.partial',
          'ptt.down', 'ptt.up', 'ptt.typed', 'speech.download', 'control.request'}
NEEDS_AX = {'ax.focused', 'ax.dialog_buttons', 'ax.overlays', 'ax.hit_chain', 'ax.window_text', 'ax.window_tree', 'ax.selected_text',
            'ax.video_rect', 'ax.watch', 'input.watch', 'input.actions', 'control.observe'}
PERMISSION_STATES = {'granted', 'denied', 'notDetermined'}
OFF_SCREEN = {'x': -100000, 'y': -100000}
ABSENT_WINDOW = 2147483000
OCR_DEFAULTS = ['zh-Hans', 'en-US']
# A combo nobody uses, held for well under a second; command+space and the fixtures' others belong to the user.
REPLAY_COMBO = 'control+option+shift+command+f12'
COMBO_KEYS = {'space'} | set('abcdefghijklmnopqrstuvwxyz0123456789') | {f'f{k}' for k in range(1, 13)}
COMBO_MODIFIERS = {'command', 'cmd', 'option', 'alt', 'control', 'ctrl', 'shift'}
SYNTHETIC_RMS = 0.25 / 2 ** 0.5  # the synthetic tone's amplitude over the square root of 2
GRANTS = {}  # permissions.status as the replay's helpers see it
CONTROL_DIR = []  # the private directory of control.listen's endpoint and token file, made by main()


def combo_ok(combo):
    """PushToTalk.parse in Python: right_option, or modifiers and one key."""
    *mods, key = combo.lower().split('+')
    return combo.lower() == 'right_option' or (key in COMBO_KEYS and all(m in COMBO_MODIFIERS for m in mods))


def granted(kind):
    return GRANTS.get(kind) == 'granted'


class Helper(win.Helper):
    """win.Helper whose request() skips the events before the answer; they stay in the transcript."""

    def __init__(self, exe):
        super().__init__(exe)
        self.recording = set()  # the mic.start sessions not stopped yet

    def events_named(self, name, wait):
        """The `name` events that arrived within `wait` seconds, as data dicts; other lines stay in the transcript."""
        seen, deadline = [], time.monotonic() + wait
        while (left := deadline - time.monotonic()) > 0:
            got = self.next_line(left)
            if got and json.loads(got).get('event') == name:
                seen.append(json.loads(got)['data'])
        return seen

    def request(self, message, timeout=None):
        line = json.dumps(message, ensure_ascii=False, separators=(',', ':'))
        self.transcript.append(line + '\n')
        self.send(line.encode('utf-8') + b'\n')
        return self.answer(timeout or win.SPEC['ops'].get(message.get('op'), {}).get('timeout_ms', 5000) / 1000 + 2)

    def answer(self, timeout):
        """The next line that is not an event, as a dict, or None when nothing came in time."""
        deadline = time.monotonic() + timeout
        while True:
            got = self.next_line(max(0.01, deadline - time.monotonic()))
            if not got:
                return None
            message = json.loads(got)
            if 'event' not in message:
                return message


def read_grants(exe):
    helper = Helper(exe)
    helper.request(win.HELLO)
    got = helper.request({'v': 1, 'id': 2, 'op': 'permissions.status', 'params': {}}) or {}
    helper.exit_code()
    GRANTS.update(got.get('result', {}))
    return granted('accessibility')


def stops(op, params):
    return (op == 'ax.watch' and params.get('pid') is None) or (op in ('input.watch', 'input.actions') and not params.get('enabled'))


def act_params_error(params):
    """The error control.act answers from its params alone (Control.paramsProblem), or None."""
    action = params['action']
    if action in ('press', 'set_value', 'type') and 'element_id' not in params:
        return 'element_required'
    if action in ('set_value', 'type') and ('text' not in params or len(params['text'].encode('utf-8')) > 4096):
        return 'invalid_text'
    if action in ('click', 'scroll') and not ('x' in params and 'y' in params):
        return 'invalid_point'
    if action == 'scroll' and 'delta_y' not in params:
        return 'invalid_scroll'
    return None


def wanted_error(op, params, trusted, helper=None):
    """The error code the aimed request must answer, or None when it must succeed (or, with the grant, may answer one of
    the op's own errors other than permission_denied). `helper.recording` holds the sessions mic.start opened."""
    if op == 'control.act':
        return act_params_error(params) or ('stale_snapshot' if trusted else 'permission_denied')
    if op in NEEDS_AX and not trusted and not stops(op, params):
        return 'permission_denied'
    if op == 'control.observe':
        return 'permission_denied' if params.get('include_image') and not granted('screenRecording') else 'window_gone'
    if op == 'control.read':
        return 'stale_snapshot'  # the fixtures' snapshot ids are no snapshots of this helper
    if op == 'control.respond':
        return 'conn_gone'  # nothing connects to the fixture's endpoint
    if op == 'browser.front_tab':
        return 'process_gone'
    if op == 'ocr.recognize' and not set(params.get('languages', OCR_DEFAULTS)) & set(OCR_DEFAULTS):
        return 'ocr_unavailable'  # the Windows fixture's zh-Hans-CN is no Vision language; checked before any capture
    if op in ('capture.window', 'ocr.recognize') and 'window_id' in params:
        return 'window_gone' if granted('screenRecording') else 'permission_denied'
    if op == 'capture.ambient' and params['source'] == 'screen' and not granted('screenRecording'):
        return 'permission_denied'
    if op == 'ptt.register':
        if not combo_ok(params['combo']):
            return 'bad_hotkey'
        if params['combo'] == 'right_option' and not granted('inputMonitoring'):
            return 'permission_denied'
    if op == 'mic.stop' and helper is not None and params['session'] not in helper.recording:
        return 'not_recording'
    return None


def aim(request, helper):
    """The request with every pid, point and app id that could reach another program pointed away from it."""
    op, params = request['op'], dict(request['params'])
    if op == 'apps.activate':
        if 'pid' in params:
            # The replay has no interface, and its ancestors (a terminal, the gate's app) must not come to the front.
            params['pid'] = os.getpid()
            params.pop('ancestors', None)
        else:
            params['app_id'] = ABSENT_APP
    elif op == 'windows.at_point' and params.get('include_titles'):
        params['point'] = {'x': -100000, 'y': -100000}
    elif op == 'process.usage':
        params['pids'] = [helper.proc.pid, os.getpid()]
    elif op == 'ax.hit_chain':
        params['point'] = OFF_SCREEN
    elif op.startswith('ax.') and op != 'ax.overlays' and (op != 'ax.watch' or params.get('pid') is not None):
        params['pid'] = os.getpid()
    elif op == 'attention.sample':
        params.pop('include_titles', None)
    elif op == 'browser.front_tab':
        params['app_id'] = ABSENT_APP
    elif op in ('capture.window', 'ocr.recognize') and 'window_id' in params:
        params['window_id'] = ABSENT_WINDOW
    elif op == 'capture.ambient':
        # Only side×side pixels come back; the main display stands in for the fixture's.
        params.pop('display_id', None)
        params['exclude_pids'] = [helper.proc.pid]
    elif op == 'mic.start':
        params['transcribe'] = False  # the synthetic tone, with no recognizer behind it
    elif op == 'ptt.register' and params['combo'] != 'right_option' and combo_ok(params['combo']):
        params['combo'] = REPLAY_COMBO
    elif op == 'control.observe':
        params.update(pid=os.getpid(), window_id=ABSENT_WINDOW)
    elif op == 'control.listen':
        params.update(endpoint=f'{CONTROL_DIR[0]}/fixture/cc.sock', token_file=f'{CONTROL_DIR[0]}/fixture/cc.token')
    return dict(request, params=params)


def shape(value):
    """A result with every string replaced by its length, for failure lines that must not print what was read."""
    if isinstance(value, dict):
        return {k: shape(v) for k, v in value.items()}
    if isinstance(value, list):
        return [shape(v) for v in value[:4]]
    return f'<str {len(value)}>' if isinstance(value, str) else value


def check_answer(checks, name, request, got, hello, helper, trusted):
    op, params = request['op'], request['params']
    code = got.get('error', {}).get('code')
    want = wanted_error(op, params, trusted, helper) if op in IMPLEMENTED else None
    if op == 'mic.start' and got.get('ok'):
        helper.recording.add(params['session'])
    elif op == 'mic.stop' and got.get('ok'):
        helper.recording.discard(params['session'])
    if want:
        checks.expect(code == want, f'{name} answers {want}', f'error {got.get("error")!r:.300}')
        return
    if op in NEEDS_AX and trusted and code is not None:
        allowed = set(win.SPEC['ops'][op]['errors']) - {'permission_denied'}
        checks.expect(code in allowed, f'{name} answers one of its own errors', f'error {got.get("error")!r:.300}')
        return
    if op in SESSION or op in IMPLEMENTED:
        if not checks.expect(got.get('ok') is True, f'{name} succeeds', f'error {got.get("error")!r:.300}'):
            return
    elif hello and op not in hello['ops']:
        checks.expect(got.get('error', {}).get('code') == 'unsupported', f'{name} is unsupported',
                      f'error {got.get("error")!r:.300}')
        return
    result = got.get('result', {})
    if op == 'hello':
        checks.expect(set(result.get('ops', [])) == SESSION | IMPLEMENTED, f'{name} lists the implemented ops',
                      f'ops {result.get("ops")}')
        checks.expect(result.get('platform') == 'macos' and result.get('pid') == helper.proc.pid
                      and set(result.get('events', [])) == EVENTS,
                      f'{name} is the macOS helper', f'platform {result.get("platform")}, pid {result.get("pid")}')
    elif op == 'screens.list':
        primary = [s for s in result.get('screens', []) if s['primary']]
        checks.expect(len(primary) == 1 and primary[0]['frame']['x'] == 0 and primary[0]['frame']['y'] == 0,
                      f'{name} has one primary screen at the origin', f'{len(primary)} primary')
    elif op == 'windows.list':
        windows = result.get('windows', [])
        checks.expect(all(w.get('layer') == 0 and 'title' not in w and 'app_name' not in w for w in windows),
                      f'{name} keeps layer 0 and reads no titles', f'{len(windows)} windows')
    elif op == 'windows.at_point' and params.get('include_titles'):
        checks.expect(result.get('window') is None, f'{name} finds no window off every screen', 'a window')
    elif op == 'process.usage':
        usage = result.get('usage', [])
        pids = {u['pid'] for u in usage}
        checks.expect(pids == set(params['pids']) and all(u['cpu_time_ns'] > 0 and u['resident_bytes'] > 0 for u in usage),
                      f'{name} reads the helper and the replay', f'pids {sorted(pids)}')
    elif op == 'apps.activate':
        checks.expect(result == {'activated': False, 'pid': None}, f'{name} activates nothing', f'result {result}')
    elif op == 'apps.running':
        apps = result.get('apps', [])
        checks.expect(all(a.get('regular') is True for a in apps) and any(a.get('app_id') == 'com.apple.finder' for a in apps),
                      f'{name} lists regular apps, Finder among them', f'{len(apps)} apps')
    elif op == 'apps.installed':
        apps = result.get('apps', [])
        checks.expect(all(set(a) == {'path', 'name'} and a['path'].endswith('.app') and isinstance(a['name'], str) for a in apps)
                      and any(a['path'].startswith('/System/Applications/') for a in apps),
                      f'{name} lists .app paths and names, system apps among them', f'{len(apps)} apps')
    elif op == 'clipboard.read':
        checks.expect(result == {'items': [], 'concealed': False, 'truncated': False}, f'{name} reads the empty private pasteboard',
                      f'{len(result.get("items", []))} items')
    elif op == 'permissions.status':
        optional = ('speech', 'notifications')
        checks.expect({v for k, v in result.items() if k not in optional} <= PERMISSION_STATES
                      and all(result.get(k) in PERMISSION_STATES | {'notApplicable'} for k in optional),
                      f'{name} on macOS, speech and notifications among them', f'result {result}')
    elif op == 'workspace.watch':
        front = result.get('front_pid', 'absent')
        checks.expect(result.get('watching') == params['enabled'] and len(result) == 1 + params['enabled']
                      and (front is None or isinstance(front, int) if params['enabled'] else front == 'absent'),
                      f'{name} answers watching, and the front pid when turned on', f'keys {sorted(result)}')
    elif op in ('presence.watch', 'input.watch'):
        checks.expect(result == {'watching': params['enabled']}, f'{name} answers watching', f'result {result}')
    elif op == 'ax.watch':
        want = {'watching': params['pid'] is not None, 'pid': params['pid']}
        if 'watch_id' in params:
            want['watch_id'] = params['watch_id']
        if params['pid'] is not None:
            want.update(element=None, window=None)  # the replay has no AX tree
            if params.get('manual_accessibility'):
                want['manual_accessibility'] = result.get('manual_accessibility')
        checks.expect(result == want and isinstance(result.get('manual_accessibility', False), bool),
                      f'{name} answers watching, the pid, its watch id and nothing read', f'result {shape(result)}')
    elif op == 'input.modifiers':
        checks.expect(set(result) == {'alt', 'shift', 'control', 'meta'} and all(isinstance(v, bool) for v in result.values()),
                      f'{name} reads four flags', f'result {result}')
    elif op == 'attention.sample':
        front = result.get('front') or {}
        checks.expect(set(result) == set(win.SPEC['ops'][op]['result']) and abs(result.get('ts', 0) - time.time()) < 60
                      and isinstance(result.get('locked'), bool) and isinstance(result.get('secure_input'), bool)
                      and (result.get('input_counters') is not None) == bool(params.get('include_input'))
                      and (result.get('audio_clients') is None or params.get('include_audio'))
                      and 'title' not in (front.get('window') or {}) and 'focused_window_title' not in front,
                      f'{name} reads every field, the asked ones only, and no titles', f'result {shape(result)}')
    elif op == 'ax.hit_chain':
        checks.expect(result == {'pid': None, 'chain': []}, f'{name} finds nothing off every screen', f'result {shape(result)}')
    elif op in ('ax.focused', 'ax.selected_text', 'ax.video_rect'):
        checks.expect(list(result.values()) == [None], f'{name} reads nothing of the replay', f'result {shape(result)}')
    elif op == 'ax.dialog_buttons':
        checks.expect(result == {'buttons': []}, f'{name} finds no dialog of the replay', f'result {shape(result)}')
    elif op == 'ax.window_text':
        checks.expect(result.get('matched') is False and result.get('nodes') == [] and result.get('text') == '',
                      f'{name} finds no window of the replay', f'result {shape(result)}')
    elif op == 'capture.ambient':
        side = params['side']
        checks.expect(result.get('width') == side == result.get('height')
                      and len(base64.b64decode(result.get('rgba', ''))) == side * side * 4,
                      f'{name} answers side×side RGBA', f'result {shape(result)}')
    elif op == 'ocr.languages':
        checks.expect({'zh-Hans', 'en-US'} <= set(result.get('languages', [])), f'{name} has Chinese and English',
                      f'{len(result.get("languages", []))} languages')
    elif op == 'ocr.recognize':
        checks.expect(result == {'text': '', 'lines': [], 'languages': params.get('languages', OCR_DEFAULTS)},
                      f'{name} reads nothing in one pixel, in the default languages', f'result {shape(result)}')
    elif op == 'speech.locales':
        checks.expect(result.get('engine') == 'SpeechTranscriber' and 'en-US' in result.get('locales', []),
                      f'{name} lists SpeechTranscriber locales', f'result {shape(result)}')
    elif op == 'mic.start':
        checks.expect(result.get('session') == params['session'] and result.get('sample_rate') == 16000
                      and isinstance(result.get('locale'), str), f'{name} records the synthetic tone', f'result {shape(result)}')
    elif op == 'mic.stop':
        checks.expect(result.get('session') == params['session'] and result.get('text') == ''
                      and result.get('duration_ms', -1) >= 0, f'{name} answers without a transcript', f'result {shape(result)}')
    elif op == 'ptt.register':
        checks.expect(result == {'registered': True}, f'{name} registers', f'result {result}')
    elif op == 'ptt.unregister':
        checks.expect(isinstance(result.get('unregistered'), bool), f'{name} answers unregistered', f'result {result}')
    elif op == 'control.listen':
        checks.expect(result == {'endpoint': params['endpoint']}, f'{name} answers its endpoint', f'result {result}')


def replay_ok(exe, checks, trusted):
    for path in sorted((C12 / 'examples').glob('ok-*.ndjson')):
        helper, hello = Helper(exe), None
        for request in win.requests_of(path):
            if request['op'] in NOT_SENT:
                continue
            request = aim(request, helper)
            name = f'{path.name} {request["id"]} {request["op"]}'
            got = helper.request(request)
            if not checks.expect(got is not None, name, 'no answer'):
                break
            if request['op'] == 'hello' and got.get('ok'):
                hello = got['result']
            check_answer(checks, name, request, got, hello, helper, trusted)
        code = helper.exit_code()
        checks.expect(code == 0, f'{path.name} exit', f'exit code {code}')
        problem = win.validate.check(helper.transcript, win.SPEC)
        checks.expect(problem is None, f'{path.name} validate.check', problem)


def dead_pid():
    child = subprocess.Popen(['/usr/bin/true'])
    child.wait()
    return child.pid


def session_checks(exe, checks, trusted):
    """Params checks, the absent-process path, cancel next to an AX read, the watches on and off."""
    me = os.getpid()
    # validate.check rejects these requests itself, so they get a session of their own.
    helper = Helper(exe)
    helper.request(win.HELLO)
    got = helper.request({'v': 1, 'id': 99, 'op': 'cancel', 'params': {'target': 98}}) or {}
    checks.expect(got.get('result') == {'cancelled': False}, 'cancel of an id never sent', f'answer {got!r:.200}')
    for n, (op, params) in enumerate([
            ('ax.window_text', {'pid': me, 'level': 'page'}), ('ax.window_text', {'pid': me, 'level': 'window', 'max_nodes': 0}),
            ('ax.watch', {'pid': me, 'notifications': ['bogus']}), ('ax.watch', {'pid': 0, 'notifications': []}),
            ('ax.hit_chain', {'point': {'x': 1}}), ('attention.sample', {'include_input': 'yes'}),
            ('input.watch', {'enabled': 1}), ('browser.front_tab', {'app_id': ''}), ('control.observe', {'pid': me}),
            ('control.act', {'snapshot_id': 'o', 'action': 'drag'}), ('control.act', {'snapshot_id': 'o', 'action': 'scroll', 'delta_y': 1.5}),
            ('control.read', {'snapshot_id': '', 'element_id': 'e0'}), ('control.listen', {'endpoint': '/tmp/x.sock'}),
            ('control.respond', {'conn': 0, 'response': {}}), ('control.respond', {'conn': 1, 'response': []})], start=100):
        got = helper.request({'v': 1, 'id': n, 'op': op, 'params': params}) or {}
        checks.expect(got.get('error', {}).get('code') == 'bad_request', f'{op} {json.dumps(params)} answers bad_request',
                      f'answer {got!r:.200}')
    checks.expect(helper.exit_code() == 0, 'bad params session exit', '')

    helper = Helper(exe)
    helper.request(win.HELLO)
    n = 1

    def ask(op, params):
        nonlocal n
        n += 1
        return helper.request({'v': 1, 'id': n, 'op': op, 'params': params}) or {}

    gone = dead_pid()
    want = 'process_gone' if trusted else 'permission_denied'
    for op, params in [('ax.window_text', {'pid': gone, 'level': 'window'}), ('ax.dialog_buttons', {'pid': gone}),
                       ('ax.video_rect', {'pid': gone}), ('ax.watch', {'pid': gone, 'notifications': ['focus']})]:
        got = ask(op, params)
        checks.expect(got.get('error', {}).get('code') == want, f'{op} of an exited process answers {want}',
                      f'answer {got!r:.200}')
    got = ask('input.watch', {'enabled': True})
    checks.expect(got.get('ok') is True if trusted else got.get('error', {}).get('code') == 'permission_denied',
                  f'input.watch {"with" if trusted else "without"} the grant', f'answer {got!r:.200}')
    ask('input.watch', {'enabled': False})
    for op in ('workspace.watch', 'presence.watch'):
        answers = [ask(op, {'enabled': on}).get('result', {}).get('watching') for on in (True, True, False, False)]
        checks.expect(answers == [True, True, False, False],
                      f'{op} turns on and off, each twice', f'answers {answers}')
    got = ask('ax.watch', {'pid': None, 'notifications': []})
    checks.expect(got.get('result') == {'watching': False, 'pid': None}, 'ax.watch null stops, with or without the grant',
                  f'answer {got!r:.200}')

    # cancel right behind an AX read: one answer each, and cancelled exactly when the read was still running.
    target, cancel = n + 1, n + 2
    n += 2
    lines = [{'v': 1, 'id': target, 'op': 'ax.window_text', 'params': {'pid': me, 'level': 'window'}},
             {'v': 1, 'id': cancel, 'op': 'cancel', 'params': {'target': target}}]
    sent = [json.dumps(m, separators=(',', ':')) + '\n' for m in lines]
    helper.transcript.extend(sent)
    helper.send(''.join(sent).encode('utf-8'))
    answers = [helper.answer(10), helper.answer(10)]
    by_id = {a['id']: (k, a) for k, a in enumerate(answers) if a}
    if checks.expect(set(by_id) == {target, cancel}, 'an AX read and its cancel get one answer each', f'answers {answers!r:.300}'):
        (t_at, t), (c_at, c) = by_id[target], by_id[cancel]
        code = t.get('error', {}).get('code')
        ok = code == 'cancelled' if c['result']['cancelled'] else t_at < c_at and code != 'cancelled'
        checks.expect(ok, 'cancel answers cancelled exactly when the read was still running',
                      f'cancel {c["result"]}, read {code or "ok"}')
    checks.expect(helper.exit_code() == 0, 'session checks exit', '')
    problem = win.validate.check(helper.transcript, win.SPEC)
    checks.expect(problem is None, 'session checks validate.check', problem)


def protocol_error_checks(exe, checks):
    """C12 §2.3, §2.5 and §6.2: a request id not above every earlier one, a "v" that is not the integer 1 and a last
    line without its newline end the session with exit code 2 and a line on stderr, and get no answer."""
    for label, data in [('a request id not above an earlier one', b'{"v":1,"id":1,"op":"screens.list","params":{}}\n'),
                        ('"v": 1.0', b'{"v":1.0,"id":2,"op":"screens.list","params":{}}\n'),
                        ('a last line without its newline', b'{"v":1,"id":2,"op":"screens.list","params":{}}')]:
        helper = Helper(exe)
        helper.request(win.HELLO)
        helper.send(data)
        exit_code = helper.exit_code(30)
        got = helper.next_line(1)
        checks.expect(got is None and exit_code == 2 and helper.stderr, f'{label} exits 2',
                      f'answer {got!r:.200}, exit {exit_code}')


ONE_PIXEL = {'format': 'png', 'width': 1, 'height': 1,
             'data': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='}


def media_checks(exe, checks):
    """Capture, OCR, the synthetic microphone and the push-to-talk key: params checks, sessions on and off, a second
    mic.start, the same combo twice and a combo another helper holds. A captured window is checked for its size and
    format only and then dropped; nothing captured or heard is printed."""
    helper = Helper(exe)
    helper.request(win.HELLO)
    for n, (op, params) in enumerate([
            ('capture.window', {'window_id': 1, 'format': 'gif'}), ('capture.ambient', {'source': 'window', 'side': 2}),
            ('capture.ambient', {'source': 'screen', 'side': 0}), ('ocr.recognize', {'window_id': 1, 'image': ONE_PIXEL}),
            ('ocr.recognize', {'image': dict(ONE_PIXEL, data='not base64')}), ('ocr.recognize', {'image': dict(ONE_PIXEL, data='AAAA')}),
            ('mic.start', {'session': '', 'locale': 'en-US'}), ('mic.start', {'session': 'm'}), ('mic.stop', {}),
            ('ptt.register', {'combo': ''})], start=2):
        got = helper.request({'v': 1, 'id': n, 'op': op, 'params': params}) or {}
        checks.expect(got.get('error', {}).get('code') == 'bad_request', f'{op} {json.dumps(params)[:60]} answers bad_request',
                      f'answer {shape(got)!r:.200}')
    checks.expect(helper.exit_code() == 0, 'bad media params session exit', '')

    helper = Helper(exe)
    helper.request(win.HELLO)
    n = 1

    def ask(op, params):
        nonlocal n
        n += 1
        return helper.request({'v': 1, 'id': n, 'op': op, 'params': params}) or {}

    def code(got):
        return got.get('error', {}).get('code')

    screen = granted('screenRecording')
    windows = ask('windows.list', {'layer0_only': True}).get('result', {}).get('windows', [])
    if windows:
        got = ask('capture.window', {'window_id': windows[0]['window_id'], 'max_long_side': 64})
        image = got.get('result', {}).get('image', {})
        data = base64.b64decode(image.get('data', ''))
        checks.expect(data[:4] == b'\x89PNG' and image.get('format') == 'png' and 0 < max(image['width'], image['height']) <= 64
                      and got['result']['scale'] > 0 if screen else code(got) == 'permission_denied',
                      'capture.window of a window on screen: a PNG within max_long_side' if screen else 'capture.window without the grant',
                      f'answer {shape(got)!r:.200}')
        del data, image, got
        got = ask('capture.window', {'window_id': windows[0]['window_id'], 'format': 'jpeg', 'max_long_side': 64, 'max_bytes': 1})
        checks.expect(code(got) == ('too_large' if screen else 'permission_denied'), 'capture.window over max_bytes',
                      f'answer {shape(got)!r:.200}')
    got = ask('capture.ambient', {'source': 'screen', 'side': 2, 'rect': {'x': -100000, 'y': -100000, 'width': 10, 'height': 10}})
    checks.expect(code(got) == ('capture_failed' if screen else 'permission_denied'), 'capture.ambient off every screen',
                  f'answer {shape(got)!r:.200}')
    got = ask('ocr.recognize', {'image': ONE_PIXEL, 'languages': ['xx-YY']})
    checks.expect(code(got) == 'ocr_unavailable', 'ocr.recognize in no language Vision has', f'answer {shape(got)!r:.200}')

    got = ask('mic.start', {'session': 'm-1', 'locale': 'zh-CN', 'transcribe': False, 'level_events': True})
    checks.expect(got.get('result') == {'session': 'm-1', 'locale': 'zh-CN', 'sample_rate': 16000}, 'mic.start of the synthetic tone',
                  f'answer {shape(got)!r:.200}')
    got = ask('mic.start', {'session': 'm-2', 'locale': 'zh-CN', 'transcribe': False})
    checks.expect(code(got) == 'mic_busy', 'a second mic.start answers mic_busy', f'answer {shape(got)!r:.200}')
    got = ask('attention.sample', {})
    checks.expect(got.get('ok') is True and got['result']['mic_active'] is None, 'mic_active is null while the helper records',
                  f'mic_active {got.get("result", {}).get("mic_active")!r}')
    levels = helper.events_named('mic.level', 1.0)
    checks.expect(5 <= len(levels) <= 21 and all(d['session'] == 'm-1' and abs(d['rms'] - SYNTHETIC_RMS) < 0.01 for d in levels),
                  'mic.level reports the tone, at most 20 a second', f'{len(levels)} levels, {levels[:2]}')
    got = ask('mic.stop', {'session': 'm-2'})
    checks.expect(code(got) == 'not_recording', 'mic.stop of another session answers not_recording', f'answer {shape(got)!r:.200}')
    got = ask('mic.stop', {'session': 'm-1', 'discard': True})
    result = got.get('result', {})
    checks.expect(result.get('session') == 'm-1' and result.get('text') == '' and result.get('duration_ms', 0) >= 900,
                  'mic.stop with discard answers no text and the duration', f'answer {shape(got)!r:.200}')
    checks.expect(helper.events_named('mic.level', 0.3) == [], 'no mic.level after mic.stop', '')
    got = ask('mic.stop', {'session': 'm-1'})
    checks.expect(code(got) == 'not_recording', 'a second mic.stop answers not_recording', f'answer {shape(got)!r:.200}')
    got = ask('mic.start', {'session': 'm-3', 'locale': 'xx-YY'})
    checks.expect(code(got) == 'locale_unsupported', 'mic.start in a locale SpeechTranscriber lacks', f'answer {shape(got)!r:.200}')
    got = ask('mic.start', {'session': 'm-4', 'locale': 'en-US'})
    checks.expect(got.get('result', {}).get('locale') == 'en-US', 'mic.start with the recognizer on the tone',
                  f'answer {shape(got)!r:.200}')
    helper.events_named('speech.partial', 0.5)
    got = ask('mic.stop', {'session': 'm-4'})
    checks.expect(got.get('ok') is True and isinstance(got['result'].get('text'), str), 'mic.stop waits for the transcript',
                  f'answer {shape(got)!r:.200}')
    got = ask('attention.sample', {})
    checks.expect(got.get('result', {}).get('mic_active') in (True, False, None), 'attention.sample after the recording',
                  f'answer {shape(got)!r:.200}')

    answers = [ask('ptt.register', {'combo': REPLAY_COMBO}).get('result') for _ in range(2)]
    checks.expect(answers == [{'registered': True}] * 2, 'ptt.register of the same combo twice', f'answers {answers}')
    other = Helper(exe)
    other.request(win.HELLO)
    got = other.request({'v': 1, 'id': 2, 'op': 'ptt.register', 'params': {'combo': REPLAY_COMBO}}) or {}
    checks.expect(code(got) == 'hotkey_taken', 'ptt.register of a combo another helper holds answers hotkey_taken',
                  f'answer {got!r:.200}')
    got = ask('ptt.register', {'combo': 'control+f99'})
    checks.expect(code(got) == 'bad_hotkey', 'ptt.register of an unknown key', f'answer {got!r:.200}')
    got = ask('ptt.unregister', {})
    checks.expect(got.get('result') == {'unregistered': True}, 'ptt.unregister keeps the combo through a bad one', f'answer {got!r:.200}')
    got = other.request({'v': 1, 'id': 3, 'op': 'ptt.register', 'params': {'combo': REPLAY_COMBO}}) or {}
    checks.expect(got.get('result') == {'registered': True}, 'the combo is free once unregistered', f'answer {got!r:.200}')
    checks.expect(other.exit_code() == 0, 'second helper exit', '')
    got = ask('ptt.register', {'combo': 'right_option'})
    checks.expect(got.get('result') == {'registered': True} if granted('inputMonitoring') else code(got) == 'permission_denied',
                  'ptt.register right_option', f'answer {got!r:.200}')
    answers = [ask('ptt.unregister', {}).get('result') for _ in range(2)]
    checks.expect(answers == [{'unregistered': granted('inputMonitoring')}, {'unregistered': False}],
                  'ptt.unregister twice', f'answers {answers}')
    ask('mic.start', {'session': 'm-5', 'locale': 'en-US', 'transcribe': False})
    checks.expect(helper.exit_code() == 0, 'media session exit while recording', '')
    problem = win.validate.check(helper.transcript, win.SPEC)
    checks.expect(problem is None, 'media session validate.check', problem)


DENIED = ('AC_HELPER_AX_DENIED', 'AC_HELPER_SCREEN_DENIED', 'AC_HELPER_MIC_DENIED', 'AC_HELPER_INPUT_DENIED')


def denied_checks(exe, checks):
    """The no-grant paths on a Mac that may have the grants: the AC_HELPER_*_DENIED switches make the helper's checks of
    Accessibility, Screen Recording, Microphone and Input Monitoring fail. The real microphone stays closed: the grant
    check comes before it."""
    synthetic = os.environ.pop('AC_HELPER_MIC_SYNTHETIC', None)
    os.environ.update(dict.fromkeys(DENIED, '1'))
    try:
        helper = Helper(exe)
    finally:
        for name in DENIED:
            del os.environ[name]
        if synthetic:
            os.environ['AC_HELPER_MIC_SYNTHETIC'] = synthetic
    helper.request(win.HELLO)
    me = os.getpid()
    asks = [('ax.focused', {}), ('ax.focused', {'pid': me}), ('ax.dialog_buttons', {'pid': me}), ('ax.overlays', {}),
            ('ax.hit_chain', {'point': OFF_SCREEN}), ('ax.window_text', {'pid': me, 'level': 'focused'}),
            ('ax.selected_text', {'pid': me}), ('ax.video_rect', {'pid': me}),
            ('ax.watch', {'pid': me, 'notifications': ['focus']}), ('input.watch', {'enabled': True}),
            ('capture.window', {'window_id': ABSENT_WINDOW}), ('capture.ambient', {'source': 'screen', 'side': 2}),
            ('ocr.recognize', {'window_id': ABSENT_WINDOW}), ('mic.start', {'session': 'denied', 'locale': 'en-US'}),
            ('ptt.register', {'combo': 'right_option'}), ('control.observe', {'pid': me, 'window_id': ABSENT_WINDOW}),
            ('control.act', {'snapshot_id': 'o-none-1', 'action': 'click', 'x': 1, 'y': 1})]
    for n, (op, params) in enumerate(asks, start=2):
        got = helper.request({'v': 1, 'id': n, 'op': op, 'params': params}) or {}
        checks.expect(got.get('error', {}).get('code') == 'permission_denied', f'{op} without the grant answers permission_denied',
                      f'answer {got!r:.200}')
    n = len(asks) + 2
    for op, params, want in [('ax.watch', {'pid': None, 'notifications': []}, {'watching': False, 'pid': None}),
                             ('input.watch', {'enabled': False}, {'watching': False})]:
        got = helper.request({'v': 1, 'id': n, 'op': op, 'params': params}) or {}
        checks.expect(got.get('result') == want, f'{op} stops without the grant', f'answer {got!r:.200}')
        n += 1
    got = helper.request({'v': 1, 'id': n, 'op': 'attention.sample', 'params': {}}) or {}
    result = got.get('result', {})
    checks.expect(got.get('ok') is True and result.get('focus_role') is None and result.get('capture_indicator') is None,
                  'attention.sample without the grant leaves the AX fields null', f'answer {shape(got)!r:.300}')
    checks.expect(helper.exit_code() == 0, 'no-grant session exit', '')
    problem = win.validate.check(helper.transcript, win.SPEC)
    checks.expect(problem is None, 'no-grant session validate.check', problem)


def connect(path, payload=b''):
    """A connection to control.listen's endpoint that has sent `payload`."""
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(5)
    client.connect(path)
    try:
        client.sendall(payload)
    except OSError:
        pass  # the helper closed it
    return client


def reply(client):
    """What the helper wrote before it closed the connection, or None when it stayed open past the timeout."""
    data = b''
    try:
        while chunk := client.recv(65536):
            data += chunk
    except OSError:
        return None
    finally:
        client.close()
    return data


def control_checks(exe, checks):
    """control.listen and control.respond over a socket in a private temporary directory: the modes of the directory,
    the socket and the token file, a second listen here and in another helper, bad params, a wrong token, a request and
    its answer, an answer to a connection that hung up or never was, a line over 64 KiB, a fifth connection at once,
    a desktop_cancel beside four requests waiting for their answers, and the files gone after exit."""
    run = Path(CONTROL_DIR[0]) / 'run'
    endpoint, token_file = str(run / 'cc.sock'), str(run / 'cc.token')
    listen = {'endpoint': endpoint, 'token_file': token_file}
    helper = Helper(exe)
    helper.request(win.HELLO)
    n = 1

    def ask(op, params):
        nonlocal n
        n += 1
        return helper.request({'v': 1, 'id': n, 'op': op, 'params': params}) or {}

    def code(got):
        return got.get('error', {}).get('code')

    for params, why in [({'endpoint': 'run/cc.sock', 'token_file': 'run/cc.token'}, 'relative paths'),
                        ({'endpoint': f'{run}/{"s" * 120}.sock', 'token_file': token_file}, 'an endpoint over 103 bytes'),
                        ({'endpoint': endpoint, 'token_file': f'{CONTROL_DIR[0]}/cc.token'}, 'a token file in another directory')]:
        got = ask('control.listen', params)
        checks.expect(code(got) == 'endpoint_unavailable', f'control.listen with {why} answers endpoint_unavailable', f'answer {got!r:.200}')
    got = ask('control.listen', listen)
    if not checks.expect(got.get('result') == {'endpoint': endpoint}, 'control.listen answers its endpoint', f'answer {got!r:.200}'):
        helper.exit_code()
        return
    modes = [stat.S_IMODE(os.lstat(p).st_mode) for p in (run, endpoint, token_file)]
    token = Path(token_file).read_text()
    checks.expect(modes == [0o700, 0o600, 0o600] and stat.S_ISSOCK(os.lstat(endpoint).st_mode) and len(token) == 64,
                  'control.listen makes a 0700 directory, a 0600 socket and a 0600 token of 64 characters',
                  f'modes {[oct(m) for m in modes]}, token of {len(token)}')
    got = ask('control.listen', listen)
    checks.expect(code(got) == 'already_running', 'a second control.listen answers already_running', f'answer {got!r:.200}')
    other = Helper(exe)
    other.request(win.HELLO)
    got = other.request({'v': 1, 'id': 2, 'op': 'control.listen', 'params': listen}) or {}
    checks.expect(code(got) == 'already_running', 'control.listen on the endpoint another helper holds answers already_running',
                  f'answer {got!r:.200}')
    checks.expect(other.exit_code() == 0 and os.path.exists(endpoint) and os.path.exists(token_file),
                  'the other helper leaves the endpoint and the token alone', '')

    def line(message):
        return json.dumps(message).encode('utf-8') + b'\n'

    request = {'id': 'r1', 'session_id': 's', 'method': 'desktop_status', 'params': {}}
    answer = reply(connect(endpoint, line(dict(request, token='0' * 64))))
    checks.expect(answer and json.loads(answer).get('error', {}).get('code') == 'unauthorized'
                  and helper.events_named('control.request', 0.3) == [], 'a wrong token is refused without control.request',
                  f'reply {answer!r:.100}')
    client = connect(endpoint, line(dict(request, token=token)))
    events = helper.events_named('control.request', 2)
    if checks.expect(len(events) == 1 and events[0]['request'] == request, 'control.request carries the request without its token',
                     f'{len(events)} events'):
        response = {'id': 'r1', 'result': {'enabled': False}}
        got = ask('control.respond', {'conn': events[0]['conn'], 'response': response})
        answer = reply(client)
        checks.expect(got.get('result') == {'sent': True} and answer and answer.endswith(b'\n') and answer.count(b'\n') == 1
                      and json.loads(answer) == response,
                      'control.respond writes the answer and closes the connection', f'answer {got!r:.100}, reply {answer!r:.100}')
        got = ask('control.respond', {'conn': events[0]['conn'], 'response': response})
        checks.expect(code(got) == 'conn_gone', 'a second control.respond answers conn_gone', f'answer {got!r:.200}')
    client = connect(endpoint, line(dict(request, token=token)))
    events = helper.events_named('control.request', 2)
    client.close()
    helper.events_named('control.request', 0.3)
    got = ask('control.respond', {'conn': events[0]['conn'] if events else 99, 'response': {}})
    checks.expect(len(events) == 1 and code(got) == 'conn_gone', 'control.respond to a connection that hung up answers conn_gone',
                  f'{len(events)} events, answer {got!r:.200}')
    got = ask('control.respond', {'conn': 9999, 'response': {}})
    checks.expect(code(got) == 'conn_gone', 'control.respond to a connection never made answers conn_gone', f'answer {got!r:.200}')
    for params, want in [({'action': 'press'}, 'element_required'), ({'action': 'type', 'element_id': 'e0'}, 'invalid_text'),
                         ({'action': 'set_value', 'element_id': 'e0', 'text': 'x' * 4097}, 'invalid_text'),
                         ({'action': 'click', 'x': 1}, 'invalid_point'), ({'action': 'scroll', 'x': 1, 'y': 1}, 'invalid_scroll'),
                         ({'action': 'click', 'x': 1, 'y': 1}, 'stale_snapshot' if GRANTS.get('accessibility') == 'granted' else 'permission_denied')]:
        got = ask('control.act', dict(params, snapshot_id='o-none-1'))
        checks.expect(code(got) == want, f'control.act {json.dumps(params)[:50]} answers {want}', f'answer {got!r:.200}')
    got = ask('control.read', {'snapshot_id': 'o-none-1', 'element_id': 'e0'})
    checks.expect(code(got) == 'stale_snapshot', 'control.read of a snapshot never made answers stale_snapshot', f'answer {got!r:.200}')
    answer = reply(connect(endpoint, b'{"token":"' + b'0' * 70000))
    checks.expect(answer == b'' and helper.events_named('control.request', 0.3) == [], 'a line over 64 KiB is closed without an answer',
                  f'reply {answer!r:.100}')
    silent = [connect(endpoint) for _ in range(4)]
    helper.events_named('control.request', 0.3)
    started = time.monotonic()
    answer = reply(connect(endpoint))
    checks.expect(answer == b'' and time.monotonic() - started < 1.5, 'a fifth connection at once is closed at once',
                  f'reply {answer!r:.100} after {time.monotonic() - started:.1f} s')
    answers = [reply(c) for c in silent]
    checks.expect(answers == [b''] * 4, 'connections that send nothing are closed after their read timeout', f'replies {answers}')
    client = connect(endpoint, line(dict(request, token=token)))
    events = helper.events_named('control.request', 2)
    checks.expect(len(events) == 1, 'every closed connection gave its slot back', f'{len(events)} events')
    client.close()
    waiting = [connect(endpoint, line(dict(request, id=f'w{k}', token=token))) for k in range(4)]
    events = helper.events_named('control.request', 1)
    waiting.append(connect(endpoint, line({'id': 'c', 'session_id': 's', 'method': 'desktop_cancel', 'params': {}, 'token': token})))
    late = helper.events_named('control.request', 1)
    checks.expect(len(events) == 4 and [e['request']['method'] for e in late] == ['desktop_cancel'],
                  'a desktop_cancel beside four requests waiting for their answers reaches the main process',
                  f'{len(events)} waiting, then {late!r:.200}')
    for client in waiting:
        client.close()
    checks.expect(helper.exit_code() == 0, 'control listen session exit', '')
    checks.expect(not os.path.exists(endpoint) and not os.path.exists(token_file), 'exit removes the endpoint and the token file', '')
    problem = win.validate.check(helper.transcript, win.SPEC)
    checks.expect(problem is None, 'control listen session validate.check', problem)


def window_checks(exe, checks, trusted):
    """control.observe, control.act and control.read on the replay's own window (ac-helper-testwindow, a panel that
    never takes focus): its text field and button, set_value read back, press, snapshots made stale by an action and
    unknown to another helper, an element the snapshot lacks, a point outside the window, click and scroll on a window
    that is not in front under AC_HELPER_INPUT_RECORD (nothing posted, nothing recorded), the element and text budgets,
    target_changed once the window moved, an act cancelled during its cooldown and one whose window moved during it. Needs the Accessibility grant; prints a note and checks nothing without."""
    if not trusted:
        print('note: no Accessibility grant; the control ops on the replay window are not checked', flush=True)
        return
    window = subprocess.Popen([str(TEST_WINDOW)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)

    def window_line():
        ready, _, _ = select.select([window.stdout], [], [], 10)
        return window.stdout.readline().strip() if ready else ''

    os.environ['AC_HELPER_INPUT_RECORD'] = '1'
    try:
        helper = Helper(exe)
    finally:
        del os.environ['AC_HELPER_INPUT_RECORD']
    try:
        first = window_line().split()
        if not checks.expect(len(first) == 2, 'the replay window starts', f'line {first}'):
            return
        pid, wid = map(int, first)
        helper.request(win.HELLO)
        n = 1

        def ask(op, params):
            nonlocal n
            n += 1
            return helper.request({'v': 1, 'id': n, 'op': op, 'params': params}) or {}

        def code(got):
            return got.get('error', {}).get('code')

        def observe(**extra):
            for _ in range(20):
                got = ask('control.observe', dict({'pid': pid, 'window_id': wid, 'include_text': True}, **extra))
                if code(got) != 'window_gone':
                    break
                helper.events_named('control.request', 0.1)  # the window server lists the panel a moment after it shows
            return got.get('result', {}), got

        def find(result, role):
            return next((e for e in result.get('elements', []) if e['role'] == role), {})

        for _ in range(20):
            result, got = observe()
            target = result.get('target', {})
            if target.get('bounds', {}).get('width') == 220:
                break
            helper.events_named('control.request', 0.1)  # on a busy machine the window server reports the panel 218 wide as it appears
        field, button = find(result, 'AXTextField'), find(result, 'AXButton')
        if not checks.expect(target.get('pid') == pid and target.get('window_id') == wid and target['bounds']['width'] == 220
                             and field.get('value') == 'c12 replay' and button.get('title') == 'Press'
                             and 'AXPress' in button.get('actions', []) and result.get('truncated') is False,
                             'control.observe reads the replay window: its text field and its button', f'answer {shape(got)!r:.300}'):
            return
        snapshot = result['snapshot_id']
        got = ask('control.read', {'snapshot_id': snapshot, 'element_id': field['element_id']})
        checks.expect(got.get('result', {}).get('value') == 'c12 replay', 'control.read reads the text field', f'answer {shape(got)!r:.200}')
        got = ask('control.act', {'snapshot_id': snapshot, 'action': 'set_value', 'element_id': field['element_id'], 'text': 'set'})
        checks.expect(got.get('result') == {'effect': 'confirmed'}, 'control.act set_value reads the text back', f'answer {got!r:.200}')
        got = ask('control.read', {'snapshot_id': snapshot, 'element_id': field['element_id']})
        checks.expect(code(got) == 'stale_snapshot', 'an action makes the snapshot stale', f'answer {got!r:.200}')
        result, got = observe()
        checks.expect(find(result, 'AXTextField').get('value') == 'set', 'a new observation sees the text set', f'answer {shape(got)!r:.200}')
        got = ask('control.act', {'snapshot_id': result.get('snapshot_id', 'none'), 'action': 'press',
                                  'element_id': find(result, 'AXButton').get('element_id', 'e1')})
        checks.expect(got.get('result') == {'effect': 'unverifiable'}, 'control.act press', f'answer {got!r:.200}')
        result, got = observe()
        checks.expect(find(result, 'AXTextField').get('value') == 'pressed', 'the press reached the button', f'answer {shape(got)!r:.200}')
        snapshot = result.get('snapshot_id', 'none')
        field = find(result, 'AXTextField')
        refusals = [({'action': 'press', 'element_id': 'e999'}, 'element_gone', 'an element the snapshot lacks'),
                    ({'action': 'click', 'x': -5, 'y': 5}, 'invalid_point', 'a point outside the window')]
        front = (ask('attention.sample', {}).get('result', {}).get('front') or {}).get('pid')
        if checks.expect(front != pid, 'the replay window is not the front app',
                         'the replay window took the foreground; a click and a scroll on a window not in front are not checked'):
            refusals += [({'action': 'click', 'x': 10, 'y': 40}, 'foreground_required', 'a click on a window not in front'),
                         ({'action': 'scroll', 'x': 10, 'y': 40, 'delta_y': 5000}, 'foreground_required', 'a scroll on a window not in front')]
        for params, want, why in refusals:
            got = ask('control.act', dict(params, snapshot_id=snapshot))
            checks.expect(code(got) == want, f'control.act with {why} answers {want}', f'answer {got!r:.200}')
        got = ask('control.read', {'snapshot_id': snapshot, 'element_id': field.get('element_id', 'e1')})
        checks.expect(got.get('result', {}).get('value') == 'pressed', 'refused actions leave the snapshot live', f'answer {shape(got)!r:.200}')
        result, got = observe(max_elements=1)
        checks.expect(len(result.get('elements', [])) == 1 and result.get('truncated') is True, 'max_elements bounds the walk',
                      f'answer {shape(got)!r:.200}')
        result, got = observe(max_elements=2 ** 63 - 1)
        checks.expect(find(result, 'AXButton') and result.get('truncated') is False, 'control.observe with the largest max_elements reads the window',
                      f'answer {shape(got)!r:.200}')
        result, got = observe(max_text_scalars=3)
        scalars = sum(len(e.get('title', '')) + len(e.get('value', '')) for e in result.get('elements', []))
        checks.expect(result.get('text_truncated') is True and scalars <= 3, 'max_text_scalars bounds the text', f'{scalars} scalars')
        if granted('screenRecording'):
            result, got = observe(include_image=True)
            image = result.get('image', {})
            data = base64.b64decode(image.get('data', ''))
            checks.expect(data[:4] == b'\x89PNG' and image.get('format') == 'png' and image.get('width', 0) >= 220,
                          'control.observe with include_image adds the window as PNG', f'answer {shape(got)!r:.200}')
            del data, image
        other = Helper(exe)
        other.request(win.HELLO)
        got = other.request({'v': 1, 'id': 2, 'op': 'control.read', 'params': {'snapshot_id': snapshot, 'element_id': 'e0'}}) or {}
        checks.expect(code(got) == 'stale_snapshot', "another helper's snapshot is stale", f'answer {got!r:.200}')
        other.exit_code()
        window.stdin.write('move\n')
        window.stdin.flush()
        moved = window_line()
        got = ask('control.read', {'snapshot_id': snapshot, 'element_id': field.get('element_id', 'e1')})
        checks.expect(moved == 'moved' and code(got) == 'target_changed', 'control.read after the window moved answers target_changed',
                      f'answer {got!r:.200}')
        got = ask('control.act', {'snapshot_id': snapshot, 'action': 'click', 'x': 10, 'y': 40})
        checks.expect(code(got) == 'target_changed', 'control.act after the window moved answers target_changed', f'answer {got!r:.200}')

        def set_value(result, text, id):
            return {'v': 1, 'id': id, 'op': 'control.act', 'params': {'snapshot_id': result.get('snapshot_id', 'none'), 'action': 'set_value',
                                                                       'element_id': find(result, 'AXTextField').get('element_id', 'e1'), 'text': text}}

        result, got = observe()
        ask('control.act', set_value(result, 'before cancel', 0)['params'])
        result, got = observe()
        target, cancel = n + 1, n + 2
        n += 2
        sent = [json.dumps(m, separators=(',', ':')) + '\n'
                for m in (set_value(result, 'cancelled', target), {'v': 1, 'id': cancel, 'op': 'cancel', 'params': {'target': target}})]
        helper.transcript.extend(sent)
        helper.send(''.join(sent).encode('utf-8'))
        answers = {a['id']: a for a in (helper.answer(10), helper.answer(10)) if a}
        helper.events_named('control.request', 0.5)  # past the cooldown, when a cancelled act that went on would have written
        result, got = observe()
        checks.expect(answers.get(cancel, {}).get('result') == {'cancelled': True} and find(result, 'AXTextField').get('value') == 'before cancel',
                      'a control.act cancelled during its cooldown writes nothing', f'answers {answers!r:.200}, then {shape(got)!r:.200}')
        ask('control.act', set_value(result, 'cooled', 0)['params'])
        acted = time.monotonic()
        result, got = observe()
        n += 1
        sent = json.dumps(set_value(result, 'too late', n), separators=(',', ':')) + '\n'
        if time.monotonic() - acted < 0.1:
            helper.transcript.append(sent)
            helper.send(sent.encode('utf-8'))
            time.sleep(0.05)  # the act's own checks are done; it waits out the cooldown, which the move falls in
            window.stdin.write('move\n')
            window.stdin.flush()
            moved = window_line()
            got = helper.answer(5) or {}
            checks.expect(moved == 'moved' and code(got) == 'target_changed',
                          'control.act checks the window again after its cooldown: moved meanwhile, it answers target_changed', f'answer {got!r:.200}')
        else:
            print('note: the observation took longer than the cooldown; the window moving during it is not checked', flush=True)
    finally:
        status = helper.exit_code()
        window.stdin.close()
        window.wait(10)
    checks.expect(status == 0, 'control window session exit', '')
    recorded = [l for l in helper.stderr if b'recorded input' in l]
    checks.expect(recorded == [], 'nothing reached the point of posting input', f'{len(recorded)} recorded')
    problem = win.validate.check(helper.transcript, win.SPEC)
    checks.expect(problem is None, 'control window session validate.check', problem)


def ax_watch_checks(exe, checks, trusted):
    """ax.watch on the replay's own window (ac-helper-testwindow, whose app reports its text field as the focus without
    taking the keyboard): the focus and the window read as it subscribes, element_key, read_value, manual_accessibility,
    two watch ids and the default one side by side, source_key of the focused element and of another one, the window of a
    title notification, and stopping one watch id. Needs the Accessibility grant; prints a note and checks nothing
    without."""
    if not trusted:
        print('note: no Accessibility grant; ax.watch on the replay window is not checked', flush=True)
        return
    window = subprocess.Popen([str(TEST_WINDOW)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)

    def window_line():
        ready, _, _ = select.select([window.stdout], [], [], 10)
        return window.stdout.readline().strip() if ready else ''

    def tell(command):
        window.stdin.write(command + '\n')
        window.stdin.flush()
        return window_line()

    helper = Helper(exe)
    try:
        first = window_line().split()
        if not checks.expect(len(first) == 2, 'the replay window starts for ax.watch', f'line {first}'):
            return
        pid = int(first[0])
        helper.request(win.HELLO)
        n = 1

        def ask(op, params):
            nonlocal n
            n += 1
            return helper.request({'v': 1, 'id': n, 'op': op, 'params': params}) or {}

        def notified(kind, wait=1.0):
            return [e for e in helper.events_named('ax.notification', wait) if e['notification'] == kind]

        got = ask('ax.watch', {'pid': pid, 'notifications': ['focus', 'window', 'title', 'value'], 'watch_id': 'activity',
                               'read_value': True, 'manual_accessibility': True})
        result = got.get('result', {})
        element = result.get('element') or {}
        key = element.get('element_key')
        checks.expect(result.get('watching') is True and result.get('watch_id') == 'activity' and element.get('role') == 'AXTextField'
                      and isinstance(key, str) and element.get('value') == 'c12 replay' and element.get('value_length') == 10
                      and (result.get('window') or {}).get('title') == 'c12 replay'
                      and isinstance(result.get('manual_accessibility'), bool),
                      'ax.watch reads the focused field, its text and the window of the replay window as it subscribes',
                      f'answer {shape(got)!r:.300}')
        got = ask('ax.watch', {'pid': pid, 'notifications': ['value'], 'watch_id': 'context'})
        result = got.get('result', {})
        checks.expect(result.get('watch_id') == 'context' and (result.get('element') or {}).get('element_key') == key
                      and 'value' not in (result.get('element') or {}) and 'manual_accessibility' not in result,
                      'a second watch id subscribes beside the first, without the text', f'answer {shape(got)!r:.300}')
        got = ask('ax.watch', {'pid': pid, 'notifications': ['title']})
        checks.expect(got.get('result', {}).get('watching') is True and 'watch_id' not in got.get('result', {}),
                      'the default subscription subscribes beside them without a watch id', f'answer {shape(got)!r:.300}')
        tell('value typed')
        by_id = {e.get('watch_id'): e for e in notified('value')}
        activity, context = by_id.get('activity', {}), by_id.get('context', {})
        checks.expect(set(by_id) == {'activity', 'context'} and (activity.get('element') or {}).get('value') == 'typed'
                      and activity.get('source_key') == key == context.get('source_key')
                      and (context.get('element') or {}).get('element_key') == key and 'value' not in (context.get('element') or {})
                      and 'window' not in activity,
                      'a value change of the focused field reaches both watch ids, its text only where asked',
                      f'watch ids {sorted(map(str, by_id))}, {shape(activity)!r:.200}')
        tell('other')
        events = notified('value')
        checks.expect(len(events) >= 2 and all(e.get('source_key') not in (None, key) and (e.get('element') or {}).get('element_key') == key
                                               for e in events),
                      'a value change of another element names it in source_key', f'{len(events)} events')
        tell('title renamed')
        events = notified('title')
        checks.expect({e.get('watch_id') for e in events} == {'activity', None}
                      and all((e.get('window') or {}).get('title') == 'renamed' for e in events),
                      'a title change carries the focused window to the watches that asked for it', f'{shape(events)!r:.300}')
        got = ask('ax.watch', {'pid': None, 'notifications': [], 'watch_id': 'context'})
        checks.expect(got.get('result') == {'watching': False, 'pid': None, 'watch_id': 'context'},
                      'ax.watch null with a watch id stops that one', f'answer {got!r:.200}')
        tell('value again')
        events = notified('value')
        checks.expect(len(events) >= 1 and {e.get('watch_id') for e in events} == {'activity'},
                      'the other subscriptions stay', f'watch ids {[e.get("watch_id") for e in events]}')
        ask('ax.watch', {'pid': None, 'notifications': [], 'watch_id': 'activity'})
        got = ask('ax.watch', {'pid': None, 'notifications': []})
        tell('title quiet')
        checks.expect(got.get('result') == {'watching': False, 'pid': None} and notified('title', 0.5) == [],
                      'no notification once every subscription stopped', f'answer {got!r:.200}')
        # A stop of one watch id sent while its start waits on the window's app, stopped so that each AX message to it
        # waits out its timeout: the stop, sent last, wins.
        os.kill(window.pid, signal.SIGSTOP)
        try:
            for params in ({'pid': pid, 'notifications': ['title'], 'watch_id': 'race'},
                           {'pid': None, 'notifications': [], 'watch_id': 'race'}):
                n += 1
                line = json.dumps({'v': 1, 'id': n, 'op': 'ax.watch', 'params': params}, separators=(',', ':'))
                helper.transcript.append(line + '\n')
                helper.send(line.encode('utf-8') + b'\n')
                time.sleep(0.05)
            answers = [helper.answer(4)]
        finally:
            os.kill(window.pid, signal.SIGCONT)
        answers.append(helper.answer(4))
        tell('title raced')
        events = [e for e in notified('title', 0.5) if e.get('watch_id') == 'race']
        checks.expect(all(answers) and events == [], 'a stop sent while a start of the same watch id subscribes leaves it stopped',
                      f'{len(events)} events of the stopped watch')
    finally:
        status = helper.exit_code()
        window.stdin.close()
        window.wait(10)
    checks.expect(status == 0, 'ax.watch window session exit', '')
    problem = win.validate.check(helper.transcript, win.SPEC)
    checks.expect(problem is None, 'ax.watch window session validate.check', problem)


def window_text_checks(exe, checks, trusted):
    """ax.window_text on the replay's own window (ac-helper-testwindow, whose app reports its text field as the focus): a
    field value longer than a page's scalar budget comes whole over the cursors, and a summary cut to max_scalars says
    char_budget. Needs the Accessibility grant; prints a note and checks nothing without."""
    if not trusted:
        print('note: no Accessibility grant; ax.window_text on the replay window is not checked', flush=True)
        return
    window = subprocess.Popen([str(TEST_WINDOW)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)

    def window_line():
        ready, _, _ = select.select([window.stdout], [], [], 10)
        return window.stdout.readline().strip() if ready else ''

    helper = Helper(exe)
    try:
        first = window_line().split()
        if not checks.expect(len(first) == 2, 'the replay window starts for ax.window_text', f'line {first}'):
            return
        pid = int(first[0])
        long_value = ''.join(f'{k:03d},' for k in range(60))
        window.stdin.write(f'value {long_value}\n')
        window.stdin.flush()
        window_line()
        helper.request(win.HELLO)
        n = 1

        def ask(params):
            nonlocal n
            n += 1
            return (helper.request({'v': 1, 'id': n, 'op': 'ax.window_text', 'params': params}) or {}).get('result', {})

        values, cursor, pages = [], None, 0
        while pages < 30:
            result = ask(dict({'pid': pid, 'level': 'window', 'max_scalars': 40}, **({'cursor': cursor} if cursor else {})))
            pages += 1
            values += [node['value'] for node in result.get('nodes', []) if node['role'] == 'AXTextField']
            cursor = result.get('coverage', {}).get('next_cursor')
            if not cursor:
                break
        checks.expect(''.join(values) == long_value, 'a field value longer than a page comes whole over the cursors',
                      f'{len(values)} parts of {len("".join(values))} scalars in {pages} pages, {len(long_value)} written')
        result = ask({'pid': pid, 'level': 'focused', 'max_scalars': 20})
        coverage = result.get('coverage', {})
        checks.expect(len(result.get('text', '')) == 20 and coverage.get('status') == 'partial'
                      and 'char_budget' in coverage.get('reasons', []),
                      'a focused summary cut to max_scalars is partial with char_budget', f'coverage {coverage}')
        cursor = ask({'pid': pid, 'level': 'window', 'max_nodes': 1}).get('coverage', {}).get('next_cursor')
        # Stopped, the window's app lets each AX message wait out its 250 ms; the first one puts it on the skip list.
        os.kill(window.pid, signal.SIGSTOP)
        try:
            n += 1
            started = time.monotonic()
            got = helper.request({'v': 1, 'id': n, 'op': 'ax.window_text', 'params': {'pid': pid, 'level': 'window', 'cursor': cursor}})
            took = time.monotonic() - started
        finally:
            os.kill(window.pid, signal.SIGCONT)
        checks.expect(bool(cursor) and (got or {}).get('error', {}).get('code') == 'ax_timeout' and took < 0.45,
                      'a cursor whose app stopped answering answers ax_timeout after one message timed out',
                      f'answer {shape(got)!r:.200} after {took:.2f} s')
    finally:
        status = helper.exit_code()
        window.stdin.close()
        window.wait(10)
    checks.expect(status == 0, 'ax.window_text window session exit', '')
    problem = win.validate.check(helper.transcript, win.SPEC)
    checks.expect(problem is None, 'ax.window_text window session validate.check', problem)


def watch_order_checks(exe, checks, trusted):
    """A watch's events follow its success answer: with AC_HELPER_WATCH_PROBE each watch sends one event of its own as it
    starts, which must arrive after the answer and not before it."""
    os.environ['AC_HELPER_WATCH_PROBE'] = '1'
    try:
        helper = Helper(exe)
    finally:
        del os.environ['AC_HELPER_WATCH_PROBE']
    helper.request(win.HELLO)
    watches = [('workspace.watch', {'enabled': True}, 'workspace.changed'), ('presence.watch', {'enabled': True}, 'presence.edge'),
               ('input.watch', {'enabled': True}, 'input.activity'),
               ('ax.watch', {'pid': os.getpid(), 'notifications': ['focus']}, 'ax.notification')]
    for n, (op, params, event) in enumerate(watches, start=2):
        if op in NEEDS_AX and not trusted:
            continue
        line = json.dumps({'v': 1, 'id': n, 'op': op, 'params': params}, separators=(',', ':'))
        helper.transcript.append(line + '\n')
        helper.send(line.encode('utf-8') + b'\n')
        before, answer, deadline = [], None, time.monotonic() + 5
        while answer is None and (left := deadline - time.monotonic()) > 0:
            got = helper.next_line(left)
            if not got:
                break
            message = json.loads(got)
            if 'event' in message:
                before.append(message['event'])
            else:
                answer = message
        after = helper.events_named(event, 0.5)
        checks.expect(bool(answer and answer.get('ok')) and event not in before and len(after) >= 1,
                      f'{op}: its first event follows its answer', f'events before the answer {before}, {len(after)} after')
    checks.expect(helper.exit_code() == 0, 'watch order session exit', '')
    problem = win.validate.check(helper.transcript, win.SPEC)
    checks.expect(problem is None, 'watch order session validate.check', problem)


def voice_probe_checks(exe, checks):
    """ptt.typed and speech.download without a key pressed or a model downloaded: with AC_HELPER_PTT_PROBE right_option's
    poll reads a scripted hold with a key typed inside it; with AC_HELPER_DOWNLOAD_PROBE mic.start sends one
    speech.download before its answer, and none after it."""
    os.environ.update(AC_HELPER_PTT_PROBE='1', AC_HELPER_DOWNLOAD_PROBE='1')
    try:
        helper = Helper(exe)
    finally:
        del os.environ['AC_HELPER_PTT_PROBE'], os.environ['AC_HELPER_DOWNLOAD_PROBE']
    helper.request(win.HELLO)
    got = helper.request({'v': 1, 'id': 2, 'op': 'ptt.register', 'params': {'combo': 'right_option'}}) or {}
    names, deadline = [], time.monotonic() + 1.0
    while (left := deadline - time.monotonic()) > 0:
        line = helper.next_line(left)
        if line and 'event' in json.loads(line):
            names.append(json.loads(line)['event'])
    checks.expect(got.get('result') == {'registered': True} and names == ['ptt.down', 'ptt.typed', 'ptt.up'],
                  'ptt.typed comes once between ptt.down and ptt.up of a right_option hold with a key typed', f'events {names}')
    helper.request({'v': 1, 'id': 3, 'op': 'ptt.unregister', 'params': {}})
    line = json.dumps({'v': 1, 'id': 4, 'op': 'mic.start', 'params': {'session': 'd-1', 'locale': 'en-US', 'transcribe': False}},
                      separators=(',', ':'))
    helper.transcript.append(line + '\n')
    helper.send(line.encode('utf-8') + b'\n')
    before, answer, deadline = [], None, time.monotonic() + 5
    while answer is None and (left := deadline - time.monotonic()) > 0:
        got = helper.next_line(left)
        if not got:
            break
        message = json.loads(got)
        if 'event' in message:
            before.append(message)
        else:
            answer = message
    after = helper.events_named('speech.download', 0.5)
    checks.expect(bool(answer and answer.get('ok')) and after == []
                  and [(m['event'], m['data']) for m in before] == [('speech.download', {'session': 'd-1', 'fraction': 0.5, 'completed': 1, 'total': 2})],
                  'speech.download comes before mic.start\'s answer and not after it', f'before {before}, {len(after)} after')
    helper.request({'v': 1, 'id': 5, 'op': 'mic.stop', 'params': {'session': 'd-1', 'discard': True}})
    checks.expect(helper.exit_code() == 0, 'voice probe session exit', '')
    problem = win.validate.check(helper.transcript, win.SPEC)
    checks.expect(problem is None, 'voice probe session validate.check', problem)


def sweep(exe, checks, trusted):
    """win.sweep, with the ops that need the Accessibility grant answering permission_denied without it."""
    helper = Helper(exe)
    hello = (helper.request(win.HELLO) or {}).get('result', {})
    for n, (op, spec) in enumerate(sorted(win.SPEC['ops'].items()), start=2):
        if op in SESSION:
            continue
        got = helper.request({'v': 1, 'id': n, 'op': op, 'params': {}}) or {}
        if spec.get('params') or spec.get('params_one_of'):
            want = 'bad_request'
        elif op not in hello.get('ops', []):
            want = 'unsupported'
        else:
            want = 'permission_denied' if op in NEEDS_AX and not trusted else None
        code = None if got.get('ok') else got.get('error', {}).get('code')
        checks.expect(code == want, f'{op} with params {{}}', f'wanted {want or "success"}, got {code}')
    checks.expect(helper.exit_code() == 0, 'sweep exit', '')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--exe', type=Path, default=EXE)
    args = parser.parse_args(argv)
    if not args.exe.is_file():
        print(f'HELPER-MAC: FAIL no helper at {args.exe}; run swift build -c release in app/helpers/mac')
        return 1
    # Inherited by every helper this replay starts.
    os.environ['AC_HELPER_PASTEBOARD'] = f'c12-replay-{os.getpid()}'
    os.environ['AC_HELPER_MIC_SYNTHETIC'] = '1'
    checks = win.Checks()
    CONTROL_DIR.append(tempfile.mkdtemp(prefix='c12-'))
    trusted = read_grants(args.exe)
    print(f'note: Accessibility {"granted" if trusted else "not granted"}; the AX ops are checked '
          f'{"for their answers" if trusted else "for permission_denied"}; Screen Recording '
          f'{GRANTS.get("screenRecording")}, Input Monitoring {GRANTS.get("inputMonitoring")}', flush=True)
    replay_ok(args.exe, checks, trusted)
    win.replay_bad(args.exe, checks)
    win.edge_cases(args.exe, checks)
    session_checks(args.exe, checks, trusted)
    protocol_error_checks(args.exe, checks)
    media_checks(args.exe, checks)
    denied_checks(args.exe, checks)
    watch_order_checks(args.exe, checks, trusted)
    voice_probe_checks(args.exe, checks)
    control_checks(args.exe, checks)
    window_checks(args.exe, checks, trusted)
    ax_watch_checks(args.exe, checks, trusted)
    window_text_checks(args.exe, checks, trusted)
    sweep(args.exe, checks, trusted)
    shutil.rmtree(CONTROL_DIR[0], ignore_errors=True)
    print(f'HELPER-MAC: {checks.total} checks, {checks.failed} failed')
    return 1 if checks.failed else 0


if __name__ == '__main__':
    sys.exit(main())
