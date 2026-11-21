"""Replays the C12 fixtures against ac-helper.exe on Windows and checks every answer.

Usage: python -I app/helpers/windows/tests/replay.py [--exe PATH]   (after build.bat)

- ok-*.ndjson: sends each file's requests to a fresh helper, one at a time; the whole session must pass
  protocol/C12-platform-helper/validate.py's check(); the ops this helper implements must succeed, the others must
  answer unsupported; the helper must exit 0 when stdin closes or after shutdown.
- bad-*.ndjson the helper can trigger (request before hello, unknown op, missing param, one-of, wrong v): the
  helper's error code or exit code; plus an overlong line, a line of exactly max_line_bytes, a non-JSON line and a
  protocol mismatch, which have no fixture.
- every op of ops.json sent with empty params: never unknown_op, bad_request exactly when the op has required params.
- permissions.request of the four kinds without a Windows switch answers notApplicable.
Requests that would act on or read other programs' windows are aimed at a window this script opens itself. A
microphone permissions.request is never sent (not_sent): it opens the microphone, which may show a system prompt.
apps.installed is checked for shape only and reported as a count. capture.window and capture.ambient are aimed at
the test window (the screen rect, excluding the helper's pid) and the primary display's wallpaper; their images must
decode to the size they claim; without a desktop they may fail with one of their op's codes. The attention ops are checked for shape and for
the fields Windows always answers the same way: from ssh the helper runs in session 0, with no desktop and no input.
With a desktop (winhost.py test helper-win --interactive) one more session checks real readings: the test window has
a solid COLOUR, capture.window's PNG and JPEG decode (GDI+, in memory) to it at their centre, max_long_side and
max_bytes hold, a closed window answers window_gone; capture.ambient screen over the window averages to COLOUR and,
with the replay's pid excluded, does not; a second test window taking the foreground gives workspace.changed;
attention.sample's front is that window. presence.edge and input.activity need a session lock or real input, which the
replay never makes: only their watches are checked.
Events the helper sends between answers go into the session that validate.check reads.
Prints a line for each failed check and ends with `HELPER-WIN: <n> checks, <m> failed`; exits 1 when one failed.
"""
import argparse
import base64
import ctypes
import importlib.util
import json
import os
from pathlib import Path
import queue
import struct
import subprocess
import sys
import threading
import time

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
C12 = REPO / 'protocol/C12-platform-helper'
EXE = REPO / '.local/build/helper-windows/ac-helper.exe'
SESSION = {'hello', 'cancel', 'shutdown'}
IMPLEMENTED = {'screens.list', 'windows.list', 'windows.at_point', 'clipboard.read', 'apps.running', 'apps.activate',
               'process.usage', 'permissions.status', 'permissions.request', 'apps.installed', 'workspace.watch',
               'attention.sample', 'presence.watch', 'input.modifiers', 'input.watch', 'capture.window',
               'capture.ambient'}
# Without a desktop (session 0) these may fail, with one of their op's own codes.
CAPTURES = {'capture.window', 'capture.ambient'}
EVENTS = {'workspace.changed', 'presence.edge', 'input.activity'}
WATCHES = {'workspace.watch', 'presence.watch', 'input.watch'}
# attention.sample fields the Windows helper always answers null (CONTRACT §7.3; no UI Automation yet).
NULL_ON_WINDOWS = ('focus_role', 'focus_native_role', 'focus_window_role', 'focus_window_native_role',
                   'focus_window_subrole', 'camera_active', 'video_pids', 'capture_indicator')
NOT_APPLICABLE = ('accessibility', 'screenRecording', 'automation', 'inputMonitoring')
# bad-* fixtures whose rule the helper enforces: the error code of the last request, or the exit code.
BAD_CODES = {'bad-before-hello.ndjson': 'not_ready', 'bad-unknown-op.ndjson': 'unknown_op',
             'bad-missing-param.ndjson': 'bad_request', 'bad-one-of.ndjson': 'bad_request'}
BAD_EXITS = {'bad-v.ndjson': 2}
WINDOW_TITLE = 'C12 replay window'
WINDOW_RECT = {'x': 160, 'y': 160, 'width': 480, 'height': 320}  # where the test window is created
COLOUR = (208, 48, 144)  # the test windows' background, R G B
SECOND_TITLE = 'C12 replay second window'
SECOND_RECT = {'x': 700, 'y': 160, 'width': 320, 'height': 240}  # shown only to take the foreground
GONE_WINDOW_ID = 999  # ok-capture-ocr.ndjson's window that is not on screen
ABSENT_APP = 'c12-replay-absent.exe'


def load_validate():
    spec = importlib.util.spec_from_file_location('c12_validate', C12 / 'validate.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


validate = load_validate()
SPEC = validate.load_spec()
HELLO = {'v': 1, 'id': 1, 'op': 'hello', 'params': {'protocol': 1, 'client': 'replay'}}


class Checks:
    def __init__(self):
        self.total = self.failed = 0

    def expect(self, ok, name, detail=''):
        self.total += 1
        if not ok:
            self.failed += 1
            print(f'FAIL {name}: {detail}', flush=True)
        return ok


class Helper:
    """One ac-helper.exe process; transcript holds both directions in order, as validate.check wants them."""

    def __init__(self, exe):
        self.proc = subprocess.Popen([str(exe)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.lines = queue.Queue()
        self.stderr = []
        self.transcript = []
        self.events = []
        threading.Thread(target=self._read, daemon=True).start()
        self._errors = threading.Thread(target=lambda: self.stderr.extend(self.proc.stderr), daemon=True)
        self._errors.start()

    def _read(self):
        for raw in self.proc.stdout:
            self.lines.put(raw.decode('utf-8'))
        self.lines.put(None)

    def send(self, data):
        try:
            self.proc.stdin.write(data)
            self.proc.stdin.flush()
        except OSError:
            pass  # it exited; the caller checks the exit code

    def next_line(self, timeout):
        try:
            line = self.lines.get(timeout=timeout)
        except queue.Empty:
            return None
        if line is not None:
            self.transcript.append(line)
        return line

    def request(self, message, timeout=None):
        """The helper's answer as a dict, or None when it sent nothing in time; events before it stay in transcript."""
        line = json.dumps(message, ensure_ascii=False, separators=(',', ':'))
        self.transcript.append(line + '\n')
        self.send(line.encode('utf-8') + b'\n')
        op = SPEC['ops'].get(message.get('op'), {})
        while True:
            got = self.next_line(timeout or op.get('timeout_ms', 5000) / 1000 + 2)
            answer = json.loads(got) if got else None
            if not answer or 'event' not in answer:
                return answer
            self.events.append(answer)

    def wait_event(self, match, timeout):
        """The first event match accepts, reading for up to timeout seconds; None when none came."""
        deadline = time.monotonic() + timeout
        while True:
            found = next((e for e in self.events if match(e)), None)
            left = deadline - time.monotonic()
            if found or left <= 0:
                return found
            got = self.next_line(left)
            message = json.loads(got) if got else {}
            if 'event' in message:
                self.events.append(message)

    def exit_code(self, timeout=10):
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        try:
            code = self.proc.wait(timeout)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
            code = None
        self._errors.join(5)
        return code


def user32():
    """user32 with the argument types of the calls the replay makes on its own windows."""
    from ctypes import wintypes
    user = ctypes.WinDLL('user32')
    user.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                  ctypes.c_int, wintypes.UINT]
    user.SetForegroundWindow.argtypes = [wintypes.HWND]
    user.GetForegroundWindow.restype = wintypes.HWND
    user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user.IsWindow.argtypes = [wintypes.HWND]
    user.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    return user


def foreground_pid():
    from ctypes import wintypes
    user, pid = user32(), wintypes.DWORD()
    front = user.GetForegroundWindow()
    if front:
        user.GetWindowThreadProcessId(front, ctypes.byref(pid))
    return pid.value


class TestWindow:
    """Plain top-level windows of this process, painted COLOUR: the only windows the replay lets the helper read,
    capture or activate. second stays hidden until focus_second."""

    def __init__(self):
        self.hwnd = self.second = None
        self.gone = None  # the id of a window created and destroyed at once
        self.ready = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()
        self.ready.wait(10)

    def _run(self):
        from ctypes import wintypes
        user32 = ctypes.WinDLL('user32', use_last_error=True)
        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        lresult = ctypes.c_ssize_t
        wndproc = ctypes.WINFUNCTYPE(lresult, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)
        user32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        user32.DefWindowProcW.restype = lresult

        def proc(hwnd, msg, wparam, lparam):
            if msg == 0x0002 and hwnd == self.hwnd:  # WM_DESTROY
                user32.PostQuitMessage(0)
                return 0
            return user32.DefWindowProcW(hwnd, msg, wparam, lparam)

        self._proc = wndproc(proc)

        class WNDCLASSW(ctypes.Structure):
            _fields_ = [('style', wintypes.UINT), ('lpfnWndProc', wndproc), ('cbClsExtra', ctypes.c_int),
                        ('cbWndExtra', ctypes.c_int), ('hInstance', wintypes.HINSTANCE), ('hIcon', wintypes.HICON),
                        ('hCursor', wintypes.HANDLE), ('hbrBackground', wintypes.HBRUSH),
                        ('lpszMenuName', wintypes.LPCWSTR), ('lpszClassName', wintypes.LPCWSTR)]

        kernel32.GetModuleHandleW.restype = wintypes.HMODULE
        instance = kernel32.GetModuleHandleW(None)
        gdi32 = ctypes.WinDLL('gdi32')
        gdi32.CreateSolidBrush.restype = wintypes.HBRUSH
        red, green, blue = COLOUR
        brush = gdi32.CreateSolidBrush(red | green << 8 | blue << 16)
        user32.RegisterClassW(ctypes.byref(WNDCLASSW(lpfnWndProc=self._proc, hInstance=instance, hbrBackground=brush,
                                                     lpszClassName='C12ReplayWindow')))
        user32.CreateWindowExW.restype = wintypes.HWND
        user32.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
                                           ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.HWND,
                                           wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID]
        user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                        ctypes.c_int, wintypes.UINT]
        user32.DestroyWindow.argtypes = [wintypes.HWND]
        self.gone = user32.CreateWindowExW(0, 'C12ReplayWindow', 'C12 gone window', 0x00CF0000, 0, 0, 100, 100,
                                           None, None, instance, None)
        user32.DestroyWindow(self.gone)
        r = WINDOW_RECT
        self.hwnd = user32.CreateWindowExW(0, 'C12ReplayWindow', WINDOW_TITLE, 0x00CF0000, r['x'], r['y'], r['width'],
                                           r['height'], None, None, instance, None)  # WS_OVERLAPPEDWINDOW
        # Not ShowWindow: its first call in a process takes the launcher's STARTUPINFO, which ssh sets to hidden.
        # SWP_SHOWWINDOW | SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOSIZE | SWP_NOMOVE: shown, foreground untouched.
        user32.SetWindowPos(self.hwnd, None, 0, 0, 0, 0, 0x0040 | 0x0010 | 0x0004 | 0x0001 | 0x0002)
        r = SECOND_RECT
        self.second = user32.CreateWindowExW(0, 'C12ReplayWindow', SECOND_TITLE, 0x00CF0000, r['x'], r['y'],
                                             r['width'], r['height'], None, None, instance, None)
        self.ready.set()
        msg = wintypes.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))

    def focus_second(self):
        """Shows the second window and gives it the foreground; whether it has it within 2 s."""
        user = user32()
        # SWP_SHOWWINDOW | SWP_NOZORDER | SWP_NOSIZE | SWP_NOMOVE
        user.SetWindowPos(self.second, None, 0, 0, 0, 0, 0x0040 | 0x0004 | 0x0001 | 0x0002)
        user.SetForegroundWindow(self.second)
        deadline = time.monotonic() + 2
        while user.GetForegroundWindow() != self.second and time.monotonic() < deadline:
            time.sleep(0.05)
        return user.GetForegroundWindow() == self.second

    def close_second(self):
        """Closes the second window; whether it is gone within 5 s."""
        user = user32()
        user.PostMessageW(self.second, 0x0010, 0, 0)  # WM_CLOSE
        deadline = time.monotonic() + 5
        while user.IsWindow(self.second) and time.monotonic() < deadline:
            time.sleep(0.05)
        return not user.IsWindow(self.second)

    def topmost(self, on):
        """The first window above every other non-topmost window, or back among them; never activated."""
        # HWND_TOPMOST or HWND_NOTOPMOST; SWP_NOACTIVATE | SWP_NOSIZE | SWP_NOMOVE
        user32().SetWindowPos(self.hwnd, ctypes.c_void_p(-1 if on else -2), 0, 0, 0, 0, 0x0010 | 0x0001 | 0x0002)

    def shown(self, on):
        """Shows or hides the first window; never activated."""
        # SWP_SHOWWINDOW or SWP_HIDEWINDOW; SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOSIZE | SWP_NOMOVE
        user32().SetWindowPos(self.hwnd, None, 0, 0, 0, 0, (0x0040 if on else 0x0080) | 0x0010 | 0x0004 | 0x0001 | 0x0002)

    def close(self):
        if self.second:
            self.close_second()
        if self.hwnd:
            from ctypes import wintypes
            post = ctypes.WinDLL('user32').PostMessageW
            post.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
            post(self.hwnd, 0x0010, 0, 0)  # WM_CLOSE
        self.thread.join(5)


def requests_of(path):
    return [m for m in (json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip())
            if 'op' in m]


def not_sent(request):
    """A microphone request: it opens the microphone, which may show the system's first-use prompt (CONTRACT §7.9)."""
    return request['op'] == 'permissions.request' and request['params'].get('kind') == 'microphone'


def start_menus():
    """The current user's and all users' Start menu folders, lower case, each ending in a separator."""
    return tuple(os.path.join(os.environ[root], 'Microsoft', 'Windows', 'Start Menu', '').lower()
                 for root in ('APPDATA', 'PROGRAMDATA'))


def desktop_visible():
    """False in session 0 (ssh): its desktop window lacks WS_VISIBLE, so no top-level window counts as visible."""
    from ctypes import wintypes
    user32 = ctypes.WinDLL('user32')
    user32.GetDesktopWindow.restype = wintypes.HWND
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    return bool(user32.IsWindowVisible(user32.GetDesktopWindow()))


def find_test_window(exe, window, checks):
    """The test window's entry in windows.list, or None when no window can be visible here."""
    if not desktop_visible():
        print('note: no visible desktop (session 0); windows.list, windows.at_point, apps.activate and '
              'apps.running regular are checked for shape only', flush=True)
        return None
    helper = Helper(exe)
    helper.request(HELLO)
    got = helper.request({'v': 1, 'id': 2, 'op': 'windows.list',
                          'params': {'pid': os.getpid(), 'include_titles': True}})
    helper.exit_code()
    listed = (got or {}).get('result', {}).get('windows', [])
    found = next((w for w in listed if w['window_id'] == window.hwnd), None)
    checks.expect(found is not None and found.get('title') == WINDOW_TITLE, 'windows.list finds the test window',
                  f'answer {got!r:.300}')
    return found


def primary_display():
    """The primary monitor's HMONITOR, the display_id the helper gives it."""
    from ctypes import wintypes
    user32 = ctypes.WinDLL('user32')
    user32.MonitorFromPoint.argtypes = [wintypes.POINT, wintypes.DWORD]
    user32.MonitorFromPoint.restype = wintypes.HANDLE
    return user32.MonitorFromPoint(wintypes.POINT(0, 0), 1)  # MONITOR_DEFAULTTOPRIMARY


def aim(request, helper, target, window):
    """The request with every pid, point, window, rect, display and app id that could reach another program's window
    pointed at ours; capture.window's id that no window has stays gone (a destroyed window of ours)."""
    op, params = request['op'], dict(request['params'])
    if op == 'capture.window':
        params['window_id'] = (window.gone if params['window_id'] == GONE_WINDOW_ID
                               else (target or {}).get('window_id', window.hwnd))
    elif op == 'capture.ambient' and params['source'] == 'screen':
        params['rect'] = (target or {}).get('bounds', WINDOW_RECT)
        params['exclude_pids'] = [helper.proc.pid]
    elif op == 'capture.ambient':
        params['display_id'] = primary_display()
    elif op == 'apps.activate':
        if 'pid' in params:
            params['pid'] = os.getpid()
        else:
            params['app_id'] = ABSENT_APP
    elif op == 'windows.at_point' and params.get('include_titles'):
        bounds = (target or {}).get('bounds')
        params['point'] = ({'x': bounds['x'] + bounds['width'] // 2, 'y': bounds['y'] + bounds['height'] // 2}
                           if bounds else {'x': -100000, 'y': -100000})
    elif op == 'process.usage':
        params['pids'] = [helper.proc.pid, os.getpid()]
    return dict(request, params=params)


def image_size(data, kind):
    """(width, height) of a whole PNG (signature, IHDR, IEND) or JPEG (SOI, SOF, EOI); None when data is not one."""
    if kind == 'png':
        if data[:8] != b'\x89PNG\r\n\x1a\n' or data[12:16] != b'IHDR' or data[-8:-4] != b'IEND':
            return None
        return struct.unpack('>II', data[16:24])
    if data[:2] != b'\xff\xd8' or data[-2:] != b'\xff\xd9':
        return None
    at = 2
    while at + 9 <= len(data) and data[at] == 0xFF:
        marker, length = data[at + 1], int.from_bytes(data[at + 2:at + 4], 'big')
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            height, width = struct.unpack('>HH', data[at + 5:at + 9])
            return width, height
        at += 2 + length
    return None


def check_capture(checks, name, request, got, target, window):
    """The image's shape and that it decodes; without a desktop (session 0) a failure with one of the op's codes."""
    op, params = request['op'], request['params']
    code = got.get('error', {}).get('code')
    if op == 'capture.window' and params['window_id'] == window.gone:
        checks.expect(code == 'window_gone', f'{name} of a destroyed window answers window_gone', f'answer {got!r:.300}')
        return
    if not got.get('ok'):
        if target is None:
            print(f'note: {name} answers {code} ({got.get("error", {}).get("message")}) without a desktop', flush=True)
        checks.expect(target is None and code in SPEC['ops'][op]['errors'],
                      f'{name} succeeds, or without a desktop fails with a code of its op', f'answer {got!r:.300}')
        return
    result = got['result']
    if op == 'capture.window':
        image = result['image']
        size = image_size(base64.b64decode(image['data']), image['format'])
        longest = params.get('max_long_side')
        checks.expect(image['format'] == params.get('format', 'png') and size == (image['width'], image['height'])
                      and (not longest or max(size) <= longest), f'{name} is a whole image of its size',
                      f'format {image["format"]}, {image["width"]}x{image["height"]}, decoded size {size}')
    else:
        side = params['side']
        rgba = base64.b64decode(result['rgba'])
        checks.expect(result['width'] == result['height'] == side and len(rgba) == side * side * 4,
                      f'{name} is side x side RGBA', f'{result["width"]}x{result["height"]}, {len(rgba)} bytes')


def check_answer(checks, name, request, got, hello, helper, target, window):
    op, params = request['op'], request['params']
    if op in CAPTURES:
        return check_capture(checks, name, request, got, target, window)
    if op in SESSION or op in IMPLEMENTED:
        if not checks.expect(got.get('ok') is True, f'{name} succeeds', f'answer {got!r:.300}'):
            return
    elif hello and op not in hello['ops']:
        checks.expect(got.get('error', {}).get('code') == 'unsupported', f'{name} is unsupported',
                      f'answer {got!r:.300}')
        return
    result = got.get('result', {})
    if op == 'hello':
        checks.expect(set(result.get('ops', [])) == SESSION | IMPLEMENTED, f'{name} lists the implemented ops',
                      f'ops {result.get("ops")}')
        checks.expect(set(result.get('events', [])) == EVENTS, f'{name} lists the watches\' events',
                      f'events {result.get("events")}')
    elif op in WATCHES:
        checks.expect(result == {'watching': params['enabled']}, f'{name} answers watching only', f'result {result}')
    elif op == 'attention.sample':
        check_sample(checks, name, params, result)
    elif op == 'process.usage':
        pids = {u['pid'] for u in result.get('usage', [])}
        checks.expect(pids == set(params['pids']), f'{name} reads the helper and the replay', f'pids {sorted(pids)}')
    elif op == 'apps.activate' and 'pid' in params and target:
        checks.expect(result.get('pid') == os.getpid(), f'{name} finds the test window', f'result {result}')
    elif op == 'apps.activate':
        checks.expect(result == {'activated': False, 'pid': None}, f'{name} of an app that is not running',
                      f'result {result}')
    elif op == 'windows.at_point' and params.get('include_titles') and target:
        window = result.get('window') or {}
        checks.expect(window.get('window_id') == target['window_id'] and window.get('title') == WINDOW_TITLE,
                      f'{name} hits the test window', f'window id {window.get("window_id")}')
    elif op == 'apps.running' and target:
        mine = [a for a in result.get('apps', []) if a['pid'] == os.getpid()]
        checks.expect(len(mine) == 1 and mine[0].get('regular') is True, f'{name} lists the replay as regular',
                      f'entries {mine}')
    elif op == 'permissions.status':
        others = {k: v for k, v in result.items() if k != 'microphone'}
        checks.expect(set(others.values()) == {'notApplicable'}, f'{name} on Windows', f'result {result}')
    elif op == 'permissions.request':
        checks.expect(result == {'state': 'notApplicable'}, f'{name} {params["kind"]} on Windows', f'result {result}')
    elif op == 'apps.installed':
        apps = result.get('apps', [])
        roots = start_menus()
        shaped = [a for a in apps if set(a) == {'path', 'name'} and isinstance(a['name'], str)
                  and a['path'].lower().endswith('.lnk') and a['path'].lower().startswith(roots)]
        print(f'note: {name} lists {len(apps)} shortcuts', flush=True)
        checks.expect(bool(apps) and len(shaped) == len(apps), f'{name} lists Start menu shortcuts and names',
                      f'{len(apps)} apps, {len(apps) - len(shaped)} of another shape')


def check_sample(checks, name, params, result):
    """The fields that do not depend on the desktop; validate.check has checked the types."""
    fixed = {key: result.get(key, 'absent') for key in NULL_ON_WINDOWS}
    checks.expect(set(fixed.values()) == {None} and result.get('secure_input') is False,
                  f'{name} answers the Windows constants', f'fields {fixed}, secure_input {result.get("secure_input")}')
    for key, asked in (('audio_clients', 'include_audio'), ('input_counters', 'include_input'),
                       ('input_idles', 'include_input')):
        if not params.get(asked):
            checks.expect(result.get(key, 'absent') is None, f'{name} {key} is null without {asked}',
                          f'{key} {result.get(key, "absent")!r:.200}')
    front = result.get('front')
    if front is not None:
        checks.expect(front.get('category', 'absent') is None and 'focused_window_title' not in front,
                      f'{name} front has a null category and no focused_window_title', f'front keys {sorted(front)}')
    windows = [w for w in ((front or {}).get('window'), result.get('mouse_window')) if w]
    if not params.get('include_titles'):
        checks.expect(all('title' not in w and 'app_name' not in w for w in windows),
                      f'{name} reads no titles without include_titles', f'{len(windows)} windows')


def decode(data):
    """(width, height, (r, g, b) of the centre pixel) of a PNG or JPEG, decoded by GDI+ from a memory stream; None
    when it does not decode."""
    from ctypes import wintypes
    gdiplus, shlwapi = ctypes.WinDLL('gdiplus'), ctypes.WinDLL('shlwapi')

    class StartupInput(ctypes.Structure):
        _fields_ = [('version', ctypes.c_uint32), ('callback', ctypes.c_void_p), ('no_thread', wintypes.BOOL),
                    ('no_codecs', wintypes.BOOL)]

    shlwapi.SHCreateMemStream.argtypes = [ctypes.c_char_p, wintypes.UINT]
    shlwapi.SHCreateMemStream.restype = ctypes.c_void_p
    gdiplus.GdipCreateBitmapFromStream.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
    gdiplus.GdipGetImageWidth.argtypes = gdiplus.GdipGetImageHeight.argtypes = [ctypes.c_void_p,
                                                                                ctypes.POINTER(wintypes.UINT)]
    gdiplus.GdipBitmapGetPixel.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.POINTER(wintypes.DWORD)]
    gdiplus.GdipDisposeImage.argtypes = [ctypes.c_void_p]
    gdiplus.GdiplusShutdown.argtypes = [ctypes.c_size_t]
    token = ctypes.c_size_t()
    if gdiplus.GdiplusStartup(ctypes.byref(token), ctypes.byref(StartupInput(1)), None):
        return None
    stream = shlwapi.SHCreateMemStream(data, len(data))
    bitmap, width, height, argb = ctypes.c_void_p(), wintypes.UINT(), wintypes.UINT(), wintypes.DWORD()
    try:
        if not stream or gdiplus.GdipCreateBitmapFromStream(stream, ctypes.byref(bitmap)) or \
                gdiplus.GdipGetImageWidth(bitmap, ctypes.byref(width)) or \
                gdiplus.GdipGetImageHeight(bitmap, ctypes.byref(height)) or \
                gdiplus.GdipBitmapGetPixel(bitmap, width.value // 2, height.value // 2, ctypes.byref(argb)):
            return None
        return width.value, height.value, ((argb.value >> 16) & 255, (argb.value >> 8) & 255, argb.value & 255)
    finally:
        if bitmap:
            gdiplus.GdipDisposeImage(bitmap)
        if stream:  # IUnknown::Release, the third entry of the stream's vtable
            vtable = ctypes.cast(stream, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p)))[0]
            ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)(vtable[2])(stream)
        gdiplus.GdiplusShutdown(token)


def near(rgb, colour=COLOUR, tolerance=16):
    return rgb is not None and colour is not None and all(abs(a - b) <= tolerance for a, b in zip(rgb, colour))


def average(rgba):
    """The mean (r, g, b) of RGBA bytes."""
    count = len(rgba) // 4
    return tuple(round(sum(rgba[c::4]) / count) for c in range(3)) if count else None


def check_image(checks, name, got, kind, bounds, longest=None):
    """A capture.window answer of the test window: a whole PNG or JPEG of the size it claims, COLOUR at its centre,
    its long side longest or else within 64 px of the window's bounds."""
    if not checks.expect(got.get('ok') is True, f'{name} succeeds', f'answer {got!r:.300}'):
        return
    image = got['result']['image']
    data = base64.b64decode(image['data'])
    decoded = decode(data)
    size = (image['width'], image['height'])
    print(f'note: {name} is {kind} {size[0]}x{size[1]}, {len(data)} bytes, centre {decoded and decoded[2]}, '
          f'window bounds {bounds["width"]}x{bounds["height"]}', flush=True)
    checks.expect(image['format'] == kind and image_size(data, kind) == size and decoded is not None
                  and decoded[:2] == size, f'{name} decodes to its size', f'decoded {decoded}, claimed {size}')
    checks.expect(decoded is not None and near(decoded[2]), f'{name} has the test window\'s colour at its centre',
                  f'centre {decoded and decoded[2]}, colour {COLOUR}')
    if longest:
        checks.expect(max(size) == longest, f'{name} keeps max_long_side', f'size {size}, max_long_side {longest}')
    else:
        checks.expect(abs(size[0] - bounds['width']) <= 64 and abs(size[1] - bounds['height']) <= 64,
                      f'{name} is the window\'s size', f'size {size}, bounds {bounds}')


def desktop(exe, checks, window, target):
    """Real readings, in one session, when the replay runs on the user's desktop (see the module docstring)."""
    helper = Helper(exe)
    ids = iter(range(2, 1000))

    def ask(op, **params):
        return helper.request({'v': 1, 'id': next(ids), 'op': op, 'params': params}) or {}

    helper.request(HELLO)
    before = foreground_pid()
    got = ask('workspace.watch', enabled=True)
    checks.expect(got.get('result') == {'watching': True}, 'desktop workspace.watch', f'answer {got!r:.300}')
    took = window.focus_second()
    checks.expect(took and before != os.getpid(), 'desktop: the second test window takes the foreground from another app',
                  f'took {took}, pid in front before {before}, replay pid {os.getpid()}')
    event = helper.wait_event(lambda e: e['event'] == 'workspace.changed'
                              and e['data'] == {'reason': 'front_app', 'front_pid': os.getpid()}, 5)
    checks.expect(event is not None, 'desktop workspace.changed front_app names the replay',
                  f'events {helper.events!r:.300}')

    got = ask('attention.sample', include_titles=True, include_input=True, include_audio=True)
    result = got.get('result', {})
    front = result.get('front') or {}
    checks.expect(front.get('pid') == os.getpid() and (front.get('window') or {}).get('window_id') == window.second
                  and front['window'].get('title') == SECOND_TITLE, 'desktop attention.sample front is the second test window',
                  f'front {front!r:.300}')
    mouse = result.get('mouse_window', 'absent')
    checks.expect(type(result.get('idle_s')) in (int, float) and result['idle_s'] >= 0 and result.get('locked') is False
                  and (mouse is None or isinstance(mouse, dict) and 'window_id' in mouse),
                  'desktop attention.sample idle_s, locked and mouse_window',
                  f'idle_s {result.get("idle_s")!r}, locked {result.get("locked")!r}, mouse_window {mouse!r:.200}')
    checks.expect(isinstance(result.get('audio_clients'), list) and isinstance(result.get('input_counters'), dict)
                  and isinstance(result.get('input_idles'), dict), 'desktop attention.sample audio and input readings',
                  f'audio_clients {result.get("audio_clients")!r:.100}, input_counters {result.get("input_counters")!r}, '
                  f'input_idles {result.get("input_idles")!r}')
    for op in ('presence.watch', 'input.watch'):
        got = ask(op, enabled=True)
        checks.expect(got.get('result') == {'watching': True}, f'desktop {op} turns on', f'answer {got!r:.300}')
    print('note: presence.edge and input.activity stay unverified: they need a session lock or real input', flush=True)

    bounds = target['bounds']
    check_image(checks, 'desktop capture.window png', ask('capture.window', window_id=window.hwnd), 'png', bounds)
    check_image(checks, 'desktop capture.window jpeg', ask('capture.window', window_id=window.hwnd, format='jpeg',
                                                           max_long_side=200), 'jpeg', bounds, longest=200)
    got = ask('capture.window', window_id=window.hwnd, max_bytes=64)
    checks.expect(got.get('error', {}).get('code') == 'too_large', 'desktop capture.window over max_bytes is too_large',
                  f'answer {got!r:.300}')

    # The middle of the test window, which is client area whatever its frame; on top while it is read.
    inner = {'x': bounds['x'] + bounds['width'] // 4, 'y': bounds['y'] + bounds['height'] // 4,
             'width': bounds['width'] // 2, 'height': bounds['height'] // 2}
    window.topmost(True)
    try:
        time.sleep(0.3)  # one DWM frame or more after the z-order change
        shown = ask('capture.ambient', source='screen', side=4, rect=inner)
        hidden = ask('capture.ambient', source='screen', side=4, rect=inner, exclude_pids=[os.getpid()])
        window.shown(False)
        time.sleep(0.3)
        under = ask('capture.ambient', source='screen', side=4, rect=inner)
    finally:
        window.shown(True)
        window.topmost(False)
    seen = {}
    for label, got in (('shown', shown), ('excluded', hidden), ('under', under)):
        result = got.get('result', {})
        rgba = base64.b64decode(result.get('rgba', ''))
        seen[label] = average(rgba)
        checks.expect(got.get('ok') is True and result.get('width') == result.get('height') == 4 and len(rgba) == 64,
                      f'desktop capture.ambient screen {label} is 4 x 4 RGBA', f'answer {got!r:.300}')
    print(f'note: capture.ambient screen averages {seen["shown"]}, {seen["excluded"]} with the replay excluded, '
          f'{seen["under"]} with the test window hidden; colour {COLOUR}', flush=True)
    checks.expect(near(seen['shown']), 'desktop capture.ambient screen averages to the test window\'s colour',
                  f'average {seen["shown"]}, colour {COLOUR}')
    checks.expect(seen['excluded'] is not None and not near(seen['excluded']),
                  'desktop capture.ambient screen leaves out the windows of exclude_pids', f'average {seen["excluded"]}')
    checks.expect(near(seen['excluded'], seen['under']),
                  'desktop capture.ambient screen with exclude_pids reads what is under the left-out window',
                  f'average {seen["excluded"]}, with the window hidden {seen["under"]}')
    got = ask('capture.ambient', source='wallpaper', side=2, display_id=primary_display())
    result = got.get('result', {})
    checks.expect(got.get('ok') is True and result.get('width') == result.get('height') == 2
                  and len(base64.b64decode(result.get('rgba', ''))) == 16, 'desktop capture.ambient wallpaper is 2 x 2 RGBA',
                  f'answer {got!r:.300}')

    checks.expect(window.close_second(), 'desktop: the second test window closes', '')
    got = ask('capture.window', window_id=window.second)
    checks.expect(got.get('error', {}).get('code') == 'window_gone', 'desktop capture.window of a closed window is window_gone',
                  f'answer {got!r:.300}')
    for op in ('workspace.watch', 'presence.watch', 'input.watch'):
        ask(op, enabled=False)
    checks.expect(helper.exit_code() == 0, 'desktop session exit', '')
    problem = validate.check(helper.transcript, SPEC)
    checks.expect(problem is None, 'desktop session validate.check', problem)


def permission_requests(exe, checks):
    """permissions.request of every kind but the microphone, in one session that validate.check accepts."""
    helper = Helper(exe)
    helper.request(HELLO)
    for n, kind in enumerate(NOT_APPLICABLE, start=2):
        request = {'v': 1, 'id': n, 'op': 'permissions.request', 'params': {'kind': kind}}
        got = helper.request(request) or {}
        checks.expect(got.get('ok') is True and got.get('result') == {'state': 'notApplicable'},
                      f'permissions.request {kind} answers notApplicable', f'answer {got!r:.300}')
    checks.expect(helper.exit_code() == 0, 'permission requests exit', '')
    problem = validate.check(helper.transcript, SPEC)
    checks.expect(problem is None, 'permission requests validate.check', problem)


def replay_ok(exe, checks, target, window):
    for path in sorted((C12 / 'examples').glob('ok-*.ndjson')):
        helper, hello = Helper(exe), None
        requests = [r for r in requests_of(path) if not not_sent(r)]
        for request in requests:
            request = aim(request, helper, target, window)
            name = f'{path.name} {request["id"]} {request["op"]}'
            got = helper.request(request)
            if not checks.expect(got is not None, name, 'no answer'):
                break
            if request['op'] == 'hello' and got.get('ok'):
                hello = got['result']
            check_answer(checks, name, request, got, hello, helper, target, window)
        code = helper.exit_code()
        checks.expect(code == 0, f'{path.name} exit', f'exit code {code}')
        problem = validate.check(helper.transcript, SPEC)
        checks.expect(problem is None, f'{path.name} validate.check', problem)


def replay_bad(exe, checks):
    for name, code in BAD_CODES.items():
        helper = Helper(exe)
        *first, last = requests_of(C12 / 'examples' / name)
        for request in first:
            got = helper.request(request)
            checks.expect(got and got.get('ok') is True, f'{name} {request["id"]} {request["op"]}', f'answer {got!r:.300}')
        got = helper.request(last)
        checks.expect(got and got.get('error', {}).get('code') == code, f'{name} answers {code}', f'answer {got!r:.300}')
        checks.expect(helper.exit_code() == 0, f'{name} exit', 'not 0')
    for name, code in BAD_EXITS.items():
        helper = Helper(exe)
        got = helper.request(requests_of(C12 / 'examples' / name)[0], timeout=5)
        exit_code = helper.exit_code()
        checks.expect(got is None and exit_code == code and helper.stderr, f'{name} exits {code}',
                      f'answer {got!r:.200}, exit {exit_code}, stderr {helper.stderr}')


def padded_request(total):
    """A screens.list request line of exactly total bytes, newline included."""
    head, tail = b'{"v":1,"id":2,"op":"screens.list","params":{"pad":"', b'"}}\n'
    return head + b'x' * (total - len(head) - len(tail)) + tail


def edge_cases(exe, checks):
    limit = SPEC['max_line_bytes']
    helper = Helper(exe)
    helper.request(HELLO)
    helper.send(padded_request(limit))
    got = helper.next_line(30)
    checks.expect(got and json.loads(got).get('ok') is True, 'a line of exactly max_line_bytes is read', f'{got!r:.200}')
    got = helper.request({'v': 1, 'id': 3, 'op': 'screens.list'})
    checks.expect(got and got.get('error', {}).get('code') == 'bad_request', 'a request without params',
                  f'answer {got!r:.200}')
    checks.expect(helper.exit_code() == 0, 'stdin closed exits 0', '')

    for label, data, code in [('a line one byte over max_line_bytes', padded_request(limit + 1), 2),
                              ('a line that is not JSON', b'{"v":1,"id":2,\n', 2)]:
        helper = Helper(exe)
        helper.request(HELLO)
        helper.send(data)
        got = helper.next_line(30)
        exit_code = helper.exit_code(30)
        checks.expect(got is None and exit_code == code and helper.stderr, f'{label} exits {code}',
                      f'answer {got!r:.200}, exit {exit_code}')

    helper = Helper(exe)
    got = helper.request(dict(HELLO, params={'protocol': 2, 'client': 'replay'}))
    exit_code = helper.exit_code()
    checks.expect(got and got.get('error', {}).get('code') == 'protocol_mismatch' and exit_code == 3,
                  'hello with another protocol answers protocol_mismatch and exits 3', f'answer {got!r:.200}, exit {exit_code}')


def sweep(exe, checks):
    """Every op of ops.json with params {}: the helper's own op table must agree with ops.json."""
    helper = Helper(exe)
    hello = (helper.request(HELLO) or {}).get('result', {})
    for n, (op, spec) in enumerate(sorted(SPEC['ops'].items()), start=2):
        if op in SESSION:
            continue
        got = helper.request({'v': 1, 'id': n, 'op': op, 'params': {}}) or {}
        needs = bool(spec.get('params')) or bool(spec.get('params_one_of'))
        want = 'bad_request' if needs else None if op in hello.get('ops', []) else 'unsupported'
        code = None if got.get('ok') else got.get('error', {}).get('code')
        checks.expect(code == want, f'{op} with params {{}}', f'wanted {want or "success"}, got {got!r:.200}')
    checks.expect(helper.exit_code() == 0, 'sweep exit', '')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--exe', type=Path, default=EXE)
    args = parser.parse_args(argv)
    if not args.exe.is_file():
        print(f'HELPER-WIN: FAIL no helper at {args.exe}; run build.bat')
        return 1
    checks = Checks()
    window = TestWindow()
    try:
        target = find_test_window(args.exe, window, checks)
        # Before replay_ok, whose apps.activate gives the replay the foreground.
        if target:
            desktop(args.exe, checks, window, target)
        replay_ok(args.exe, checks, target, window)
        permission_requests(args.exe, checks)
        replay_bad(args.exe, checks)
        edge_cases(args.exe, checks)
        sweep(args.exe, checks)
    finally:
        window.close()
    print(f'HELPER-WIN: {checks.total} checks, {checks.failed} failed')
    return 1 if checks.failed else 0


if __name__ == '__main__':
    sys.exit(main())
