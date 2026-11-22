"""Replays the C12 fixtures against ac-helper.exe on Windows and checks every answer.

Usage: python -I app/helpers/windows/tests/replay.py [--exe PATH]   (after build.bat)

- ok-*.ndjson: sends each file's requests to a fresh helper, one at a time; the whole session must pass
  protocol/C12-platform-helper/validate.py's check(); the ops this helper implements must succeed, the others must
  answer unsupported; the helper must exit 0 when stdin closes or after shutdown.
- bad-*.ndjson the helper can trigger (request before hello, unknown op, missing param, one-of, wrong v): the
  helper's error code or exit code; plus an overlong line, a line of exactly max_line_bytes, a non-JSON line and a
  protocol mismatch, which have no fixture.
- session rules with no fixture: a repeated or lower request id and a final line without a newline exit 2; an answer
  over max_line_bytes (a capture.ambient wallpaper of a large side) becomes a short internal error; an enum value
  joined from two choices is bad_request; a request cancelled in the same write as itself never runs its handler
  (the helper's CPU time stays flat).
- every op of ops.json sent with empty params: never unknown_op, bad_request exactly when the op has required params.
- permissions.request of the four kinds without a Windows switch answers notApplicable.
- ocr.languages must list the recognizer languages Windows PowerShell's OcrEngine lists; ocr_unavailable only when it
  lists none. ocr.recognize answers are checked for shape (text is its lines joined, bounds within 0..1); by window_id
  without a desktop it may fail with one of its op's codes.
- control.listen on a pipe of this run: its token file, already_running from the same and from a second helper,
  endpoint_unavailable for a name that is no pipe name; a client with a wrong token gets unauthorized and sends no
  control.request; one with the token gets its request out without the token, and control.respond's answer back;
  answering it again is conn_gone; the token file goes when the helper exits. In ok-control.ndjson no client connects,
  so its control.respond answers conn_gone.
- voice: speech.locales lists SenseVoice's locales; ptt.register registers Config.parseHotkey's combos and answers
  bad_hotkey for the Windows key and unknown keys; mic.start answers locale_unsupported, mic_busy and not_recording where
  due, and records (no_audio_device or permission_denied where the machine has no usable microphone) with mic.level
  for level_events. A Chinese and an English sentence spoken to 16 kHz WAVs by Windows' SAPI voices (System.Speech)
  go through the recognizer (ac-helper.exe --transcribe) and must come back with their words; the Chinese one played
  as the microphone (AC_HELPER_MIC_WAV) must give mic.level, speech.partial and mic.stop's text. Every helper of the
  replay keeps the model in MODELS (AC_HELPER_MODELS_DIR), under the checkout, so the first run downloads it.
Requests that would act on or read other programs' windows are aimed at a window this script opens itself. A
microphone permissions.request is never sent (not_sent): it opens the microphone, which may show a system prompt.
apps.installed is checked for shape only and reported as a count. capture.window and capture.ambient are aimed at
the test window (the screen rect, excluding the helper's pid) and the primary display's wallpaper; their images must
decode to the size they claim; without a desktop they may fail with one of their op's codes. The attention ops are checked for shape and for
the fields Windows always answers the same way: from ssh the helper runs in session 0, with no desktop and no input.
The ax.* requests are aimed at the replay's pid and the test window; each must succeed or fail with one of its op's
codes, ax.watch answers watching, pid, watch_id, element and window (no doc) and manual_accessibility false when asked
for, ax.window_tree is a tree of its line count or no window, ax.focused has no app_pid, and an unknown cursor resets.
attention.sample's focus roles come in pairs, a window's being AXWindow. browser.front_tab of the fixtures names an app id
that is no browser (null fields); browser_tab checks the replay's own app id and an absent chrome.exe (process_gone).
With a desktop (winhost.py test helper-win --interactive) one more session checks real readings, and one helper
whose models directory is empty must download the model during mic.start, sending speech.download before it answers: the test window has
a solid COLOUR, capture.window's PNG and JPEG decode (GDI+, in memory) to it at their centre, max_long_side and
max_bytes hold, a window of random pixels too big for one line answers a short too_large without max_bytes, a closed
window answers window_gone; capture.ambient screen over the window averages to COLOUR and,
with the replay's pid excluded, does not; a second test window taking the foreground gives workspace.changed;
attention.sample's front is that window; with one English and one Chinese line painted in the test window,
ocr.recognize by its window_id and by its capture.window PNG as image reads both lines, in that order. presence.edge and
input.activity need a session lock or real input, which the replay never makes: only their watches are checked. With the
test window in front and its edit focused, ax.focused is
an AXTextField with a caret inside the window, ax.selected_text is the edit's selection, ax.window_text holds its text,
ax.hit_chain at its centre starts with it, ax.dialog_buttons is empty, attention.sample's focus roles are the edit's
and its window's; ax.watch answers the edit with its value and selection and sends a focus ax.notification when the
focus moves to the password edit (no value, label or selection) and back; ax.window_tree holds the window and both
edits, secure, gives no_change against its own version and one ~ line after the edit's text changes (WM_SETTEXT); no
line of that session holds the password edit's text. input.actions turns on and off; no input.action is checked, which
needs a real click or key, and no synthetic input is sent to the host. Edge and Chrome windows the replay opens in
profiles of their own (see browser_tab) give browser.front_tab's private state and host.
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
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
C12 = REPO / 'protocol/C12-platform-helper'
EXE = REPO / '.local/build/helper-windows/ac-helper.exe'
SESSION = {'hello', 'cancel', 'shutdown'}
AX = {'ax.focused', 'ax.dialog_buttons', 'ax.overlays', 'ax.hit_chain', 'ax.window_text', 'ax.window_tree',
      'ax.selected_text', 'ax.watch'}
IMPLEMENTED = {'screens.list', 'windows.list', 'windows.at_point', 'clipboard.read', 'apps.running', 'apps.activate',
               'process.usage', 'permissions.status', 'permissions.request', 'apps.installed', 'workspace.watch',
               'attention.sample', 'presence.watch', 'browser.front_tab', 'input.modifiers', 'input.watch',
               'input.actions', 'capture.window', 'capture.ambient', 'ocr.languages', 'ocr.recognize',
               'control.listen', 'control.respond', 'speech.locales', 'mic.start', 'mic.stop', 'ptt.register',
               'ptt.unregister'} | AX
# Without a desktop (session 0) these may fail, with one of their op's own codes.
CAPTURES = {'capture.window', 'capture.ambient'}
OCRS = {'ocr.languages', 'ocr.recognize'}
EVENTS = {'workspace.changed', 'presence.edge', 'input.activity', 'input.action', 'ax.notification', 'control.request',
          'ptt.down', 'ptt.up', 'mic.level', 'speech.partial', 'speech.download'}
WATCHES = {'workspace.watch', 'presence.watch', 'input.watch', 'input.actions'}
# attention.sample fields the Windows helper always answers null (CONTRACT §7.3).
NULL_ON_WINDOWS = ('video_pids', 'capture_indicator')
FOCUS_FIELDS = ('focus_role', 'focus_native_role', 'focus_window_role', 'focus_window_native_role',
                'focus_window_subrole')
VOICE = {'speech.locales', 'mic.start', 'mic.stop', 'ptt.register', 'ptt.unregister'}
LOCALES = {'engine': 'sherpa-onnx-sensevoice', 'locales': ['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'yue-HK']}
MODELS = REPO / '.local/cache/helper-models'
MODEL_FILES = {'model.int8.onnx': 239233841, 'tokens.txt': 315894}  # ops_voice.cpp's kModel
# (SAPI culture, sentence, words the recognizer must return) for the TTS check.
SPEECH = (('zh-CN', '今天天气很好，我们去公园散步。', ('天气', '公园')),
          ('en-US', 'Please open the settings window and check the microphone.', ('settings', 'microphone')))
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
# The noise window's physical size: about 3 bytes a pixel as PNG, over 16 MiB once base64 encoded.
NOISE_SIZE = (2600, 1900)
ABSENT_APP = 'c12-replay-absent.exe'
UNRESOLVED_URL = 'http://c12-replay.invalid/tab?q=1'  # .invalid never resolves (RFC 6761)
OCR_LINES = ('Replay text', '屏幕文字测试')  # painted top to bottom in the test window for ocr.recognize
# The test window's two edits, along its top edge, clear of the middle the capture checks read.
EDIT_TEXT = 'C12 replay edit: milk and eggs'
SELECTED = 'milk'
PASSWORD_TEXT = 'c12-replay-secret-7Qx'
EDIT_ID, PASSWORD_ID = 101, 102
WM_FOCUS_CONTROL = 0x8000  # WM_APP; wParam is EDIT_ID or PASSWORD_ID


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

    def __init__(self, exe, env=None):
        self.proc = subprocess.Popen([str(exe)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     env=env)
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
    user.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    user.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user.SetThreadDpiAwarenessContext.argtypes = [ctypes.c_void_p]
    user.SetThreadDpiAwarenessContext.restype = ctypes.c_void_p
    return user


def physical_rect(hwnd):
    """hwnd's rect in physical pixels, the helper's coordinates, read per-monitor aware: the replay itself is not."""
    from ctypes import wintypes
    user, r = user32(), wintypes.RECT()
    old = user.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))  # DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
    try:
        user.GetWindowRect(hwnd, ctypes.byref(r))
    finally:
        user.SetThreadDpiAwarenessContext(old)
    return {'x': r.left, 'y': r.top, 'width': r.right - r.left, 'height': r.bottom - r.top}


def foreground_pid():
    from ctypes import wintypes
    user, pid = user32(), wintypes.DWORD()
    front = user.GetForegroundWindow()
    if front:
        user.GetWindowThreadProcessId(front, ctypes.byref(pid))
    return pid.value


class TestWindow:
    """Plain top-level windows of this process, painted COLOUR: the only windows the replay lets the helper read,
    capture or activate. second stays hidden until focus_second. The first holds two edits: edit with EDIT_TEXT and
    SELECTED selected, and password (ES_PASSWORD) with PASSWORD_TEXT."""

    def __init__(self):
        self.hwnd = self.second = self.edit = self.password = None
        self.gone = None  # the id of a window created and destroyed at once
        self.text = None  # lines label paints over the first window, black on white
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
        user32.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        user32.SetFocus.argtypes = [wintypes.HWND]

        class PAINTSTRUCT(ctypes.Structure):
            _fields_ = [('hdc', wintypes.HDC), ('fErase', wintypes.BOOL), ('rcPaint', wintypes.RECT),
                        ('fRestore', wintypes.BOOL), ('fIncUpdate', wintypes.BOOL), ('rgbReserved', ctypes.c_byte * 32)]

        user32.BeginPaint.argtypes = user32.EndPaint.argtypes = [wintypes.HWND, ctypes.POINTER(PAINTSTRUCT)]
        user32.BeginPaint.restype = wintypes.HDC
        user32.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
        user32.FillRect.argtypes = [wintypes.HDC, ctypes.POINTER(wintypes.RECT), ctypes.c_void_p]

        def proc(hwnd, msg, wparam, lparam):
            if msg == 0x0002 and hwnd == self.hwnd:  # WM_DESTROY
                user32.PostQuitMessage(0)
                return 0
            if msg == 0x000F and hwnd == self.hwnd and self.text:  # WM_PAINT
                paint, client = PAINTSTRUCT(), wintypes.RECT()
                dc = user32.BeginPaint(hwnd, ctypes.byref(paint))
                user32.GetClientRect(hwnd, ctypes.byref(client))
                user32.FillRect(dc, ctypes.byref(client), gdi32.GetStockObject(0))  # WHITE_BRUSH
                previous = gdi32.SelectObject(dc, font)
                gdi32.SetBkMode(dc, 1)  # TRANSPARENT
                for n, line in enumerate(self.text):
                    gdi32.TextOutW(dc, 24, 32 + n * 96, line, len(line))
                gdi32.SelectObject(dc, previous)
                user32.EndPaint(hwnd, ctypes.byref(paint))
                return 0
            if msg == WM_FOCUS_CONTROL and hwnd == self.hwnd:
                # SetFocus works on this thread's windows only. EM_SETSEL: SELECTED in the edit, all of the password.
                target = self.edit if wparam == EDIT_ID else self.password
                user32.SetFocus(target)
                start = EDIT_TEXT.index(SELECTED)
                user32.SendMessageW(target, 0x00B1, *((start, start + len(SELECTED)) if wparam == EDIT_ID else (0, -1)))
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
        gdi32.GetStockObject.restype = gdi32.SelectObject.restype = gdi32.CreateFontW.restype = ctypes.c_void_p
        gdi32.SelectObject.argtypes = [wintypes.HDC, ctypes.c_void_p]
        gdi32.SetBkMode.argtypes = [wintypes.HDC, ctypes.c_int]
        gdi32.TextOutW.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int, wintypes.LPCWSTR, ctypes.c_int]
        gdi32.CreateFontW.argtypes = [ctypes.c_int] * 5 + [wintypes.DWORD] * 8 + [wintypes.LPCWSTR]
        # 44 px bold Microsoft YaHei, which has Latin and CJK glyphs; DEFAULT_CHARSET, ANTIALIASED_QUALITY
        font = gdi32.CreateFontW(-44, 0, 0, 0, 700, 0, 0, 0, 1, 0, 0, 4, 0, 'Microsoft YaHei')
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
        # WS_CHILD | WS_VISIBLE | WS_BORDER | WS_TABSTOP | ES_AUTOHSCROLL, and ES_PASSWORD for the second.
        style = 0x40000000 | 0x10000000 | 0x00800000 | 0x00010000 | 0x0080
        self.edit = user32.CreateWindowExW(0, 'EDIT', EDIT_TEXT, style, 8, 8, 220, 24, self.hwnd, EDIT_ID, instance,
                                           None)
        self.password = user32.CreateWindowExW(0, 'EDIT', PASSWORD_TEXT, style | 0x0020, 236, 8, 160, 24, self.hwnd,
                                               PASSWORD_ID, instance, None)
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

    def focus_first(self):
        """Gives the first window the foreground; whether it has it within 2 s."""
        user = user32()
        user.SetForegroundWindow(self.hwnd)
        deadline = time.monotonic() + 2
        while user.GetForegroundWindow() != self.hwnd and time.monotonic() < deadline:
            time.sleep(0.05)
        return user.GetForegroundWindow() == self.hwnd

    def focus_control(self, control):
        """Moves the keyboard focus to the edit (EDIT_ID) or the password edit (PASSWORD_ID) and sets its selection."""
        user32().SendMessageW(self.hwnd, WM_FOCUS_CONTROL, control, 0)

    def set_edit_text(self, text):
        """Replaces the edit's text (WM_SETTEXT, handled on the window's thread)."""
        buffer = ctypes.create_unicode_buffer(text)
        user32().SendMessageW(self.edit, 0x000C, 0, ctypes.addressof(buffer))

    def close_second(self):
        """Closes the second window; whether it is gone within 5 s."""
        user = user32()
        user.PostMessageW(self.second, 0x0010, 0, 0)  # WM_CLOSE
        deadline = time.monotonic() + 5
        while user.IsWindow(self.second) and time.monotonic() < deadline:
            time.sleep(0.05)
        return not user.IsWindow(self.second)

    def label(self, lines):
        """Paints lines over the first window, black on white, or its plain COLOUR again for None."""
        from ctypes import wintypes
        self.text = lines
        invalidate = ctypes.WinDLL('user32').InvalidateRect
        invalidate.argtypes = [wintypes.HWND, ctypes.c_void_p, wintypes.BOOL]
        invalidate(self.hwnd, None, True)

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


class NoiseWindow:
    """A borderless per-monitor-aware window of this process, NOISE_SIZE physical pixels of random colour: its PNG is
    too big for one answer line once base64 encoded. Shown without activation until close."""

    def __init__(self):
        self.hwnd = None
        self.ready = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()
        self.ready.wait(10)

    def _run(self):
        from ctypes import wintypes
        user32 = ctypes.WinDLL('user32', use_last_error=True)
        kernel32, gdi32 = ctypes.WinDLL('kernel32'), ctypes.WinDLL('gdi32')
        user32.SetThreadDpiAwarenessContext.argtypes = [ctypes.c_void_p]
        user32.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))  # DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
        width, height = NOISE_SIZE
        pixels = os.urandom(width * height * 4)

        class BITMAPINFOHEADER(ctypes.Structure):
            _fields_ = [('biSize', wintypes.DWORD), ('biWidth', ctypes.c_long), ('biHeight', ctypes.c_long),
                        ('biPlanes', wintypes.WORD), ('biBitCount', wintypes.WORD), ('biCompression', wintypes.DWORD),
                        ('biSizeImage', wintypes.DWORD), ('biXPelsPerMeter', ctypes.c_long),
                        ('biYPelsPerMeter', ctypes.c_long), ('biClrUsed', wintypes.DWORD),
                        ('biClrImportant', wintypes.DWORD)]

        class PAINTSTRUCT(ctypes.Structure):
            _fields_ = [('hdc', wintypes.HDC), ('fErase', wintypes.BOOL), ('rcPaint', wintypes.RECT),
                        ('fRestore', wintypes.BOOL), ('fIncUpdate', wintypes.BOOL), ('rgbReserved', ctypes.c_byte * 32)]

        class MINMAXINFO(ctypes.Structure):
            _fields_ = [('ptReserved', wintypes.POINT), ('ptMaxSize', wintypes.POINT),
                        ('ptMaxPosition', wintypes.POINT), ('ptMinTrackSize', wintypes.POINT),
                        ('ptMaxTrackSize', wintypes.POINT)]

        header = BITMAPINFOHEADER(biSize=ctypes.sizeof(BITMAPINFOHEADER), biWidth=width, biHeight=-height, biPlanes=1,
                                  biBitCount=32)  # top-down BI_RGB
        lresult = ctypes.c_ssize_t
        wndproc = ctypes.WINFUNCTYPE(lresult, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)
        user32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        user32.DefWindowProcW.restype = lresult
        user32.BeginPaint.argtypes = user32.EndPaint.argtypes = [wintypes.HWND, ctypes.POINTER(PAINTSTRUCT)]
        user32.BeginPaint.restype = wintypes.HDC
        gdi32.SetDIBitsToDevice.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int, wintypes.DWORD, wintypes.DWORD,
                                            ctypes.c_int, ctypes.c_int, wintypes.UINT, wintypes.UINT, ctypes.c_char_p,
                                            ctypes.c_void_p, wintypes.UINT]

        def proc(hwnd, msg, wparam, lparam):
            if msg == 0x0024:  # WM_GETMINMAXINFO: no clamp to the screen's size
                info = ctypes.cast(lparam, ctypes.POINTER(MINMAXINFO)).contents
                info.ptMaxSize.x = info.ptMaxTrackSize.x = width
                info.ptMaxSize.y = info.ptMaxTrackSize.y = height
                return 0
            if msg == 0x000F:  # WM_PAINT
                paint = PAINTSTRUCT()
                dc = user32.BeginPaint(hwnd, ctypes.byref(paint))
                gdi32.SetDIBitsToDevice(dc, 0, 0, width, height, 0, 0, 0, height, pixels, ctypes.byref(header), 0)
                user32.EndPaint(hwnd, ctypes.byref(paint))
                return 0
            if msg == 0x0002:  # WM_DESTROY
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
        user32.RegisterClassW(ctypes.byref(WNDCLASSW(lpfnWndProc=self._proc, hInstance=instance,
                                                     lpszClassName='C12ReplayNoise')))
        user32.CreateWindowExW.restype = wintypes.HWND
        user32.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
                                           ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.HWND,
                                           wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID]
        user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                        ctypes.c_int, wintypes.UINT]
        # WS_EX_NOACTIVATE; WS_POPUP
        self.hwnd = user32.CreateWindowExW(0x08000000, 'C12ReplayNoise', 'C12 replay noise window',
                                           0x80000000, 0, 0, width, height, None, None, instance, None)
        # SWP_SHOWWINDOW | SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOSIZE | SWP_NOMOVE, as TestWindow shows its window.
        user32.SetWindowPos(self.hwnd, None, 0, 0, 0, 0, 0x0040 | 0x0010 | 0x0004 | 0x0001 | 0x0002)
        self.ready.set()
        msg = wintypes.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))

    def close(self):
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
    elif op == 'ocr.recognize' and 'window_id' in params:
        params['window_id'] = (target or {}).get('window_id', window.hwnd)
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
    elif op == 'browser.front_tab':
        params['app_id'] = ABSENT_APP
    elif op in AX:
        if params.get('pid') is not None:
            params['pid'] = os.getpid()
        if 'window_bounds' in params:
            params['window_bounds'] = (target or {}).get('bounds', WINDOW_RECT)
        if op == 'ax.hit_chain':
            bounds = (target or {}).get('bounds')
            params['point'] = ({'x': bounds['x'] + bounds['width'] // 2, 'y': bounds['y'] + bounds['height'] // 2}
                               if bounds else {'x': -100000, 'y': -100000})
            params['exclude_pids'] = [helper.proc.pid]
    elif op == 'control.listen':
        params['endpoint'] = rf'\\.\pipe\c12-replay-{helper.proc.pid}-control'
        params['token_file'] = os.path.join(tempfile.gettempdir(), f'c12-replay-{helper.proc.pid}.token')
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


_host_ocr = []


def host_ocr_languages():
    """The tags of OcrEngine.AvailableRecognizerLanguages as Windows PowerShell reads them, apart from the helper."""
    if not _host_ocr:
        script = ('[void][Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]; '
                  '[Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag }')
        run = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
                             capture_output=True, text=True, timeout=120)
        _host_ocr.append([line.strip() for line in run.stdout.splitlines() if line.strip()])
        print(f'note: Windows has OCR recognizer languages {_host_ocr[0]}', flush=True)
    return _host_ocr[0]


def check_ocr(checks, name, request, got, target):
    """ocr.languages against PowerShell's list; ocr.recognize's shape; ocr_unavailable only without a language."""
    op, params = request['op'], request['params']
    host = host_ocr_languages()
    code = got.get('error', {}).get('code')
    if code == 'ocr_unavailable':
        checks.expect(not host, f'{name} is ocr_unavailable only without a recognizer language', f'Windows has {host}')
        return
    if not got.get('ok'):
        print(f'note: {name} answers {code} ({got.get("error", {}).get("message")})', flush=True)
        checks.expect(target is None and 'window_id' in params and code in SPEC['ops'][op]['errors'],
                      f'{name} succeeds, or by window_id without a desktop fails with a code of its op',
                      f'answer {got!a:.300}')
        return
    result = got['result']
    if op == 'ocr.languages':
        checks.expect(result['languages'] == host, f'{name} lists Windows\' recognizer languages',
                      f'helper {result["languages"]}, PowerShell {host}')
        return
    lines = result['lines']
    inside = all(0 <= b['x'] and 0 <= b['y'] and b['x'] + b['width'] <= 1.001 and b['y'] + b['height'] <= 1.001
                 for b in (line['bounds'] for line in lines))
    checks.expect(result['text'] == '\n'.join(line['text'] for line in lines) and inside
                  and set(result['languages']) <= set(host) and result['languages'],
                  f'{name} text is its lines, bounds within 0..1, languages Windows has', f'result {result!a:.300}')


def check_answer(checks, name, request, got, hello, helper, target, window):
    op, params = request['op'], request['params']
    if op in CAPTURES:
        return check_capture(checks, name, request, got, target, window)
    if op in OCRS:
        return check_ocr(checks, name, request, got, target)
    if op in AX:
        return check_ax(checks, name, request, got)
    if op == 'control.respond':
        checks.expect(got.get('error', {}).get('code') == 'conn_gone', f'{name} with no client answers conn_gone',
                      f'answer {got!r:.300}')
        return
    if op in VOICE:
        return check_voice(checks, name, request, got)
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
    elif op == 'control.listen':
        checks.expect(result == {'endpoint': params['endpoint']}, f'{name} answers its endpoint', f'result {result}')
    elif op == 'process.usage':
        pids = {u['pid'] for u in result.get('usage', [])}
        checks.expect(pids == set(params['pids']), f'{name} reads the helper and the replay', f'pids {sorted(pids)}')
    elif op == 'apps.activate' and 'pid' in params and target:
        checks.expect(result.get('pid') == os.getpid(), f'{name} finds the test window', f'result {result}')
    elif op == 'apps.activate':
        checks.expect(result == {'activated': False, 'pid': None}, f'{name} of an app that is not running',
                      f'result {result}')
    elif op == 'browser.front_tab':
        checks.expect(result == {'url_host': None, 'incognito': None}, f'{name} of an app that is no browser',
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


def check_ax(checks, name, request, got):
    """Success, or one of the op's own codes (validate.check has checked the types); and what Windows leaves out."""
    op, params = request['op'], request['params']
    code = got.get('error', {}).get('code')
    if not got.get('ok'):
        print(f'note: {name} answers {code} ({got.get("error", {}).get("message")})', flush=True)
        checks.expect(code in SPEC['ops'][op]['errors'], f'{name} succeeds or fails with a code of its op',
                      f'answer {got!r:.300}')
        return
    result = got['result']
    if op == 'ax.watch':
        pid, watch_id = params['pid'], params.get('watch_id')
        want = dict({'watching': pid is not None, 'pid': pid}, **({'watch_id': watch_id} if watch_id else {}))
        if pid is not None:
            want.update(element=result.get('element'), window=result.get('window'))
        if pid is not None and params.get('manual_accessibility'):
            want['manual_accessibility'] = False
        window = result.get('window') or {}
        checks.expect(result == want and window.get('doc', None) is None and 'doc' not in (result.get('element') or {}),
                      f'{name} answers watching, pid, watch_id, element and window, no doc, manual_accessibility false',
                      f'keys {sorted(result)}')
    elif op == 'ax.window_tree':
        lines = result['text'].split('\n') if result['text'] else []
        checks.expect(result['mode'] in ('full', 'diff', 'no_change') and re.fullmatch(r't-\d+', result['tree_id'])
                      and (result['mode'] != 'full' or len(lines) == result['lines'])
                      and (result['matched'] or (lines, result['lines']) == ([], 0)),
                      f'{name} is a tree of its line count, or no window', f'result {result!r:.300}')
    elif op == 'ax.focused':
        checks.expect('app_pid' not in result, f'{name} has no app_pid on Windows', f'result {result!r:.300}')
    elif op == 'ax.window_text' and 'cursor' in params:
        checks.expect('cursor_reset' in result['coverage']['reasons'], f'{name} of a cursor it never gave resets it',
                      f'coverage {result["coverage"]}')


def check_sample(checks, name, params, result):
    """The fields that do not depend on the desktop; validate.check has checked the types."""
    fixed = {key: result.get(key, 'absent') for key in NULL_ON_WINDOWS}
    checks.expect(set(fixed.values()) == {None} and result.get('secure_input') is False,
                  f'{name} answers the Windows constants', f'fields {fixed}, secure_input {result.get("secure_input")}')
    role, native, window, window_native, subrole = (result.get(key) for key in FOCUS_FIELDS)
    checks.expect((role is None) == (native is None) and (window is None) == (window_native is None)
                  and (role is not None or window is None) and (window is not None or subrole is None)
                  and (window is None or (window, window_native) == ('AXWindow', 'Window'))
                  and subrole in (None, 'AXDialog'),
                  f'{name} focus roles come in pairs, the window\'s of a Window',
                  f'fields {[result.get(key) for key in FOCUS_FIELDS]}')
    checks.expect(result.get('camera_active', 'absent') in (True, False, None), f'{name} camera_active',
                  f'camera_active {result.get("camera_active", "absent")!r}')
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


def hotkey_ok(combo):
    """Whether the Windows helper registers combo: Config.parseHotkey's names without the Windows key."""
    parts = combo.lower().split('+')
    keys = {'space', *'abcdefghijklmnopqrstuvwxyz', *'0123456789', *(f'f{n}' for n in range(1, 13))}
    return parts == ['right_option'] or (parts[-1] in keys and
                                         all(p in ('control', 'ctrl', 'option', 'alt', 'shift') for p in parts[:-1]))


def check_voice(checks, name, request, got):
    """A fixture's voice op: combos by the Windows rules; a microphone may be missing or denied on this machine."""
    op, params = request['op'], request['params']
    error, result = got.get('error', {}), got.get('result')
    if op == 'speech.locales':
        checks.expect(result == LOCALES, f'{name} lists SenseVoice\'s locales', f'answer {got!r:.300}')
    elif op == 'ptt.register':
        want = {'registered': True} if hotkey_ok(params['combo']) else None
        checks.expect(result == want if want else error.get('code') == 'bad_hotkey', f'{name} by the Windows rules',
                      f'answer {got!r:.300}')
    elif op == 'ptt.unregister':
        checks.expect(isinstance((result or {}).get('unregistered'), bool), f'{name} succeeds', f'answer {got!r:.300}')
    elif op == 'mic.start':
        if error:
            print(f'note: {name} answers {error.get("code")} ({error.get("message")})', flush=True)
        checks.expect((result or {}).get('session') == params['session'] and result.get('sample_rate') == 16000
                      or error.get('code') in ('no_audio_device', 'permission_denied'),
                      f'{name} records, or this machine has no usable microphone', f'answer {got!r:.300}')
    elif op == 'mic.stop':
        checks.expect(error.get('code') == 'not_recording' or (result or {}).get('session') == params['session'],
                      f'{name} stops its session, or there is none', f'answer {got!r:.300}')


def voice(exe, checks):
    """The voice ops' own answers in one session that validate.check accepts. A microphone that records must send
    mic.level for level_events, at most 20 a second."""
    helper = Helper(exe)
    ids = iter(range(2, 1000))

    def ask(op, **params):
        return helper.request({'v': 1, 'id': next(ids), 'op': op, 'params': params}) or {}

    def code(got):
        return got.get('error', {}).get('code')

    helper.request(HELLO)
    got = ask('speech.locales')
    checks.expect(got.get('result') == LOCALES, 'voice speech.locales', f'answer {got!r:.300}')
    for combo, want in (('command+space', 'bad_hotkey'), ('control+f99', 'bad_hotkey'), ('right_option', None),
                        ('right_option', None), ('control+option+space', None)):
        got = ask('ptt.register', combo=combo)
        checks.expect(code(got) == want if want else got.get('result') == {'registered': True},
                      f'voice ptt.register {combo}', f'answer {got!r:.300}')
    for had in (True, False):
        got = ask('ptt.unregister')
        checks.expect(got.get('result') == {'unregistered': had}, f'voice ptt.unregister with a hot key: {had}',
                      f'answer {got!r:.300}')
    got = ask('mic.start', session='v-fr', locale='fr-FR')
    checks.expect(code(got) == 'locale_unsupported', 'voice mic.start fr-FR is locale_unsupported', f'answer {got!r:.300}')
    got = ask('mic.stop', session='v-none')
    checks.expect(code(got) == 'not_recording', 'voice mic.stop of no session', f'answer {got!r:.300}')
    got = ask('mic.start', session='v-1', locale='en-US', transcribe=False, level_events=True)
    if not got.get('ok'):
        print(f'note: voice mic.start answers {code(got)} ({got.get("error", {}).get("message")}); not recorded',
              flush=True)
        checks.expect(code(got) in ('no_audio_device', 'permission_denied'),
                      'voice mic.start records, or this machine has no usable microphone', f'answer {got!r:.300}')
    else:
        checks.expect(got.get('result') == {'session': 'v-1', 'locale': 'en-US', 'sample_rate': 16000},
                      'voice mic.start en-US', f'answer {got!r:.300}')
        busy = ask('mic.start', session='v-2', locale='zh-CN', transcribe=False)
        checks.expect(code(busy) == 'mic_busy', 'voice a second mic.start is mic_busy', f'answer {busy!r:.300}')
        helper.wait_event(lambda e: False, 1.5)
        stop = ask('mic.stop', session='v-1')
        levels = [e['data'] for e in helper.events if e['event'] == 'mic.level']
        print(f'note: voice recorded {stop.get("result", {}).get("duration_ms")} ms with {len(levels)} mic.level, rms '
              f'{[round(d["rms"], 4) for d in levels[:5]]}...', flush=True)
        checks.expect(stop.get('result', {}).get('text') == '' and stop['result'].get('duration_ms', 0) >= 1000,
                      'voice mic.stop without transcribe answers no text and the time recorded', f'answer {stop!r:.300}')
        checks.expect(10 <= len(levels) <= 40 and all(d['session'] == 'v-1' and 0 <= d['rms'] <= 1 for d in levels),
                      'voice mic.level comes for level_events, at most 20 a second, 0..1', f'levels {levels!r:.300}')
        got = ask('mic.stop', session='v-1')
        checks.expect(code(got) == 'not_recording', 'voice a second mic.stop is not_recording', f'answer {got!r:.300}')
    checks.expect(helper.exit_code() == 0, 'voice session exit', '')
    problem = validate.check(helper.transcript, SPEC)
    checks.expect(problem is None, 'voice session validate.check', problem)


TTS = r'''
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = @($s.GetInstalledVoices() | Where-Object { $_.Enabled })
[Console]::Error.WriteLine('voices: ' + (($voices | ForEach-Object { $_.VoiceInfo.Culture.Name + ' ' + $_.VoiceInfo.Name }) -join '; '))
$voice = $voices | Where-Object { $_.VoiceInfo.Culture.Name -eq $env:C12_TTS_CULTURE } | Select-Object -First 1
if (-not $voice) { exit 3 }
$s.SelectVoice($voice.VoiceInfo.Name)
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,
    [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile($env:C12_TTS_WAV, $format)
$s.Speak($env:C12_TTS_TEXT)
$s.Dispose()
'''


def speak(checks, scratch):
    """{culture: WAV} of each SPEECH sentence spoken by a SAPI voice of its culture, 16 kHz mono; a culture without
    a voice fails and is left out."""
    wavs = {}
    for culture, sentence, _ in SPEECH:
        wav = scratch / f'{culture}.wav'
        spoken = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', TTS], timeout=120,
                                capture_output=True, text=True, encoding='utf-8', errors='replace',
                                env=dict(os.environ, C12_TTS_CULTURE=culture, C12_TTS_WAV=str(wav), C12_TTS_TEXT=sentence))
        if checks.expect(spoken.returncode == 0 and wav.is_file(), f'a SAPI voice speaks {culture}',
                         f'exit {spoken.returncode}, {spoken.stderr.strip()[:300]}'):
            wavs[culture] = wav
    return wavs


def recognizer(exe, checks, wavs):
    """Each spoken sentence through ac-helper.exe --transcribe, which decodes it as mic.stop does; the text must hold
    the sentence's words."""
    for culture, _, words in SPEECH:
        if culture not in wavs:
            continue
        started = time.monotonic()
        run = subprocess.run([str(exe), '--transcribe', str(wavs[culture])], capture_output=True, timeout=1500)
        try:
            text = json.loads(run.stdout.decode('utf-8'))['text']
        except (ValueError, KeyError):
            text = None
        print(f'note: recognizer {culture} took {time.monotonic() - started:.1f} s: {text!a} '
              f'{run.stderr.decode("utf-8", "replace").strip()[-300:]!a}', flush=True)
        checks.expect(run.returncode == 0 and text is not None and all(w.lower() in text.lower() for w in words),
                      f'recognizer: the {culture} sentence comes back with {words}', f'text {text!a}')


def spoken_session(exe, checks, wav, words, env, label, attempts=1):
    """One helper whose microphone is wav (AC_HELPER_MIC_WAV): mic.start zh-CN with level_events, up to attempts
    times while it answers asr_unavailable retryable; then mic.level and speech.partial while it plays, and mic.stop's
    text with words. Returns the helper's events."""
    helper = Helper(exe, env=dict(env, AC_HELPER_MIC_WAV=str(wav)))
    ids = iter(range(2, 1000))

    def ask(op, **params):
        return helper.request({'v': 1, 'id': next(ids), 'op': op, 'params': params}) or {}

    helper.request(HELLO)
    started, got = time.monotonic(), {}
    for n in range(attempts):
        got = ask('mic.start', session=f'{label}-{n}', locale='zh-CN', level_events=True)
        error = got.get('error', {})
        if error.get('code') != 'asr_unavailable' or not error.get('retryable'):
            break
        print(f'note: {label} mic.start {label}-{n} answers asr_unavailable ({error.get("message")})', flush=True)
    print(f'note: {label} mic.start took {time.monotonic() - started:.1f} s: {got!r:.200}', flush=True)
    session = got.get('result', {}).get('session')
    if checks.expect(got.get('result', {}).get('sample_rate') == 16000 and got['result'].get('locale') == 'zh-CN',
                     f'{label} mic.start records the WAV', f'answer {got!r:.300}'):
        helper.wait_event(lambda e: False, 4)
        stop = ask('mic.stop', session=session)
        text = stop.get('result', {}).get('text')
        mine = [e for e in helper.events if e['data'].get('session') == session]
        levels = [e['data']['rms'] for e in mine if e['event'] == 'mic.level']
        partials = [e['data']['text'] for e in mine if e['event'] == 'speech.partial']
        print(f'note: {label} heard {text!a} after {len(levels)} mic.level (loudest {max(levels, default=None)}) and '
              f'partials {partials!a:.300}', flush=True)
        checks.expect(text is not None and all(w in text for w in words), f'{label} mic.stop answers the words',
                      f'answer {stop!a:.300}')
        checks.expect(40 <= len(levels) <= 100 and all(0 <= rms <= 1 for rms in levels) and max(levels) > 0.01,
                      f'{label} mic.level while recording, at most 20 a second, 0..1', f'levels {levels!r:.300}')
        checks.expect(bool(partials) and all(a != b for a, b in zip(partials, partials[1:]))
                      and any(w in partials[-1] for w in words), f'{label} speech.partial when the text changes', f'partials {partials!a:.300}')
    checks.expect(helper.exit_code() == 0, f'{label} session exit', '')
    problem = validate.check(helper.transcript, SPEC)
    checks.expect(problem is None, f'{label} session validate.check', problem)
    return helper.events


def voice_spoken(exe, checks, wavs):
    """The Chinese sentence as the microphone: what push-to-talk sees from mic.start to mic.stop."""
    culture, _, words = SPEECH[0]
    if culture in wavs:
        spoken_session(exe, checks, wavs[culture], words, os.environ, 'spoken')


def voice_download(exe, checks, wavs):
    """From an empty models directory mic.start downloads the model: speech.download only before its answer (each
    mic.start that has to answer first is asr_unavailable, retryable, and the next joins the download), then the files
    under their names and nothing else."""
    culture, _, words = SPEECH[0]
    if culture not in wavs:
        return
    empty = REPO / '.local/cache' / f'helper-models-empty-{os.getpid()}'
    shutil.rmtree(empty, ignore_errors=True)
    empty.mkdir(parents=True)
    try:
        events = spoken_session(exe, checks, wavs[culture], words, dict(os.environ, AC_HELPER_MODELS_DIR=str(empty)),
                                'download', attempts=8)
        downloads = [e['data'] for e in events if e['event'] == 'speech.download']
        completed = [d['completed'] for d in downloads]
        print(f'note: download sent {len(downloads)} speech.download, last {downloads[-1:]}', flush=True)
        checks.expect(bool(downloads) and completed == sorted(completed) and
                      all(d['total'] == sum(MODEL_FILES.values()) and 0 <= d['fraction'] <= 1 for d in downloads),
                      'download speech.download counts the model\'s bytes', f'events {downloads[-3:]!r}')
        present = {p.relative_to(empty).name: p.stat().st_size for p in empty.rglob('*') if p.is_file()}
        checks.expect(present == MODEL_FILES, 'download leaves the model files and nothing else', f'files {present}')
    finally:
        shutil.rmtree(empty, ignore_errors=True)


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

    window.label(OCR_LINES)
    try:
        time.sleep(0.5)  # painted and composed
        by_window = ask('ocr.recognize', window_id=window.hwnd)
        shot = ask('capture.window', window_id=window.hwnd)
    finally:
        window.label(None)
    image = shot.get('result', {}).get('image')
    by_image = ask('ocr.recognize', image=image) if image else {'error': 'no capture.window image'}
    for label, got in (('window_id', by_window), ('image', by_image)):
        text = got.get('result', {}).get('text', '')
        print(f'note: desktop ocr.recognize by {label} reads {text!a:.300} with {got.get("result", {}).get("languages")}',
              flush=True)
        at = [text.find(line) for line in OCR_LINES]
        checks.expect(got.get('ok') is True and -1 not in at and at == sorted(at),
                      f'desktop ocr.recognize by {label} reads the English and the Chinese line in order',
                      f'answer {got!a:.600}')

    # After the screen readings, which it would cover.
    noise = NoiseWindow()
    try:
        time.sleep(0.5)  # painted and composed
        got = ask('capture.window', window_id=noise.hwnd)
    finally:
        noise.close()
    size = len(helper.transcript[-1].encode('utf-8'))
    print(f'note: capture.window of the noise window answers {size} bytes: {got.get("error")!r:.200}', flush=True)
    checks.expect(got.get('error', {}).get('code') == 'too_large' and size < 4096,
                  'desktop capture.window without max_bytes of an image too big for one line is a short too_large',
                  f'{size} bytes, answer {got!r:.300}')

    # While the replay still has the foreground, which the first window then takes from the second.
    desktop_ax(exe, checks, window, target)
    checks.expect(window.close_second(), 'desktop: the second test window closes', '')
    got = ask('capture.window', window_id=window.second)
    checks.expect(got.get('error', {}).get('code') == 'window_gone', 'desktop capture.window of a closed window is window_gone',
                  f'answer {got!r:.300}')
    for op in ('workspace.watch', 'presence.watch', 'input.watch'):
        ask(op, enabled=False)
    checks.expect(helper.exit_code() == 0, 'desktop session exit', '')
    problem = validate.check(helper.transcript, SPEC)
    checks.expect(problem is None, 'desktop session validate.check', problem)


def inside(rect, bounds):
    return (isinstance(rect, dict) and rect['x'] >= bounds['x'] and rect['y'] >= bounds['y']
            and rect['x'] + rect['width'] <= bounds['x'] + bounds['width']
            and rect['y'] + rect['height'] <= bounds['y'] + bounds['height'])


def desktop_ax(exe, checks, window, target):
    """UI Automation readings of the test window's edits, in one session (see the module docstring)."""
    helper = Helper(exe)
    ids = iter(range(2, 1000))
    me, bounds = os.getpid(), target['bounds']

    def ask(op, **params):
        return helper.request({'v': 1, 'id': next(ids), 'op': op, 'params': params}) or {}

    def focus_event(subrole):
        return helper.wait_event(lambda e: e['event'] == 'ax.notification' and e['data'].get('notification') == 'focus'
                                 and (e['data'].get('element') or {}).get('subrole', 'absent') == subrole, 5)

    helper.request(HELLO)
    took = window.focus_first()
    window.focus_control(EDIT_ID)
    time.sleep(0.3)
    checks.expect(took, 'desktop ax: the test window takes the foreground', '')
    started = time.monotonic()
    got = ask('ax.focused')  # the session's first UIA call
    print(f'note: the first ax.focused took {(time.monotonic() - started) * 1000:.0f} ms', flush=True)
    focus = (got.get('result') or {}).get('focus') or {}
    checks.expect(focus.get('pid') == me and focus.get('role') == 'AXTextField' and focus.get('native_role') == 'Edit'
                  and focus.get('subrole', 'absent') is None and focus.get('editable') is True,
                  'desktop ax.focused reports the edit as AXTextField', f'answer {got!r:.300}')
    checks.expect(inside(focus.get('caret'), bounds), 'desktop ax.focused has a caret inside the test window',
                  f'caret {focus.get("caret")}, bounds {bounds}')
    got = ask('attention.sample')
    roles = {key: (got.get('result') or {}).get(key, 'absent') for key in FOCUS_FIELDS}
    checks.expect(roles == {'focus_role': 'AXTextField', 'focus_native_role': 'Edit', 'focus_window_role': 'AXWindow',
                            'focus_window_native_role': 'Window', 'focus_window_subrole': None},
                  'desktop attention.sample focus roles are the edit\'s and its window\'s', f'roles {roles}')
    got = ask('ax.selected_text', pid=me)
    checks.expect(got.get('result') == {'text': SELECTED}, 'desktop ax.selected_text reads the edit\'s selection',
                  f'answer {got!r:.300}')
    got = ask('ax.window_text', pid=me, level='window', window_bounds=bounds)
    result = got.get('result', {})
    edits = [n for n in result.get('nodes', []) if n.get('role') == 'AXTextField']
    checks.expect(result.get('matched') is True and EDIT_TEXT in result.get('text', '')
                  and any(n.get('value') == EDIT_TEXT for n in edits), 'desktop ax.window_text reads the edit\'s text',
                  f'answer {got!r:.400}')
    edit = physical_rect(window.edit)
    centre = {'x': edit['x'] + edit['width'] // 2, 'y': edit['y'] + edit['height'] // 2}
    got = ask('ax.hit_chain', point=centre, exclude_pids=[helper.proc.pid])
    chain = got.get('result', {}).get('chain') or [{}]
    checks.expect(got.get('result', {}).get('pid') == me and chain[0].get('role') == 'AXTextField',
                  'desktop ax.hit_chain at the edit\'s centre starts with AXTextField', f'answer {got!r:.300}')
    got = ask('ax.dialog_buttons', pid=me)
    checks.expect(got.get('result') == {'buttons': []}, 'desktop ax.dialog_buttons of a window that is no dialog',
                  f'answer {got!r:.300}')

    got = ask('ax.watch', pid=me, notifications=['focus', 'value', 'selection'], read_selected_text=True,
              read_value=True, manual_accessibility=True, watch_id='replay')
    result = got.get('result') or {}
    element = result.get('element') or {}
    checks.expect({k: result.get(k) for k in ('watching', 'pid', 'watch_id', 'manual_accessibility', 'window')}
                  == {'watching': True, 'pid': me, 'watch_id': 'replay', 'manual_accessibility': False,
                      'window': {'title': WINDOW_TITLE, 'doc': None}}, 'desktop ax.watch starts',
                  f'answer {got!r:.300}')
    checks.expect(element.get('role') == 'AXTextField' and element.get('value') == EDIT_TEXT
                  and element.get('selected_text') == SELECTED and isinstance(element.get('element_key'), str),
                  'desktop ax.watch answers the focused edit with its value, selection and key', f'element {element}')
    window.focus_control(PASSWORD_ID)
    event = focus_event('AXSecureTextField')
    secure = (event or {}).get('data', {}).get('element') or {}
    checks.expect(event is not None and event['data'].get('pid') == me and event['data'].get('watch_id') == 'replay'
                  and isinstance(event['data'].get('source_key'), str),
                  'desktop ax.watch sends a focus ax.notification for the password edit', f'events {helper.events!r:.400}')
    checks.expect(secure.get('value', 'absent') is None and secure.get('label', 'absent') is None
                  and 'selected_text' not in secure, 'desktop ax.watch reads no value, label or selection of the password edit',
                  f'element {secure}')
    got = ask('ax.focused', pid=me)
    focus = (got.get('result') or {}).get('focus') or {}
    checks.expect(focus.get('subrole') == 'AXSecureTextField' and focus.get('caret', 'absent') is None,
                  'desktop ax.focused of the password edit has no caret', f'answer {got!r:.300}')
    got = ask('ax.selected_text', pid=me)
    checks.expect(got.get('result') == {'text': None}, 'desktop ax.selected_text of the password edit is null',
                  f'answer {got!r:.300}')
    ask('ax.window_text', pid=me, level='window', window_bounds=bounds)
    window.focus_control(EDIT_ID)
    checks.expect(focus_event(None) is not None, 'desktop ax.watch sends a focus ax.notification back on the edit',
                  f'events {helper.events!r:.400}')
    got = ask('ax.watch', pid=None, notifications=[], watch_id='replay')
    checks.expect(got.get('result') == {'watching': False, 'pid': None, 'watch_id': 'replay'}, 'desktop ax.watch stops',
                  f'answer {got!r:.300}')
    desktop_tree(ask, checks, window, me, bounds)
    for enabled in (True, False):
        got = ask('input.actions', enabled=enabled)
        checks.expect(got.get('result') == {'watching': enabled}, f'desktop input.actions turns {enabled}',
                      f'answer {got!r:.300}')
    print('note: input.action stays unverified: it needs a real click or key, and no synthetic input is sent to this '
          'host (the helper drops input without a device, which SendInput makes)', flush=True)
    checks.expect(helper.exit_code() == 0, 'desktop ax session exit', '')
    leaked = [line for line in helper.transcript if PASSWORD_TEXT in line]
    checks.expect(not leaked, 'desktop: no answer or event of the ax session holds the password edit\'s text',
                  f'{len(leaked)} lines')
    problem = validate.check(helper.transcript, SPEC)
    checks.expect(problem is None, 'desktop ax session validate.check', problem)


def desktop_tree(ask, checks, window, me, bounds):
    """ax.window_tree of the test window: the window's line first, both edits, the password edit's without its text,
    secure; against its own version no_change, and after a new text in the edit one ~ line with it."""
    got = ask('ax.window_tree', pid=me, window_bounds=bounds)
    result = got.get('result') or {}
    lines = result.get('text', '').split('\n')
    edits = [line for line in lines if re.match(r'\t*\d+ text field\b', line)]
    print(f'note: desktop ax.window_tree of the test window: {lines!a:.1200}', flush=True)
    checks.expect(result.get('matched') is True and result.get('mode') == 'full' and result.get('secure') is True
                  and result.get('lines') == len(lines) and lines[0] == f'0 window {WINDOW_TITLE}' and len(edits) == 2
                  and any(line.endswith(f', Value: {EDIT_TEXT}') for line in edits)
                  and not any(PASSWORD_TEXT in line for line in lines),
                  'desktop ax.window_tree holds the window and both edits, the password one without its text',
                  f'answer {got!a:.600}')
    got = ask('ax.window_tree', pid=me, window_bounds=bounds, previous=result.get('tree_id', 't-0'))
    again = got.get('result') or {}
    checks.expect(again.get('mode') == 'no_change' and again.get('text') == '' and again.get('lines') == len(lines),
                  'desktop ax.window_tree against its previous version is no_change', f'answer {got!a:.300}')
    changed = EDIT_TEXT + ' and tea'
    window.set_edit_text(changed)
    try:
        got = ask('ax.window_tree', pid=me, window_bounds=bounds, previous=again.get('tree_id', 't-0'))
    finally:
        window.set_edit_text(EDIT_TEXT)
    diffed = got.get('result') or {}
    changes = diffed.get('text', '').split('\n')
    checks.expect(diffed.get('mode') == 'diff' and len(changes) == 1 and changes[0].startswith('~\t')
                  and changes[0].endswith(f' text field, Value: {changed}'),
                  'desktop ax.window_tree after the edit\'s text changed is one ~ line', f'answer {got!a:.300}')


def installed(exe):
    """The path App Paths gives exe (msedge.exe, chrome.exe), or None when it is not installed."""
    import winreg
    for root in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        try:
            with winreg.OpenKey(root, rf'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exe}') as key:
                path = winreg.QueryValue(key, None).strip('"')
        except OSError:
            continue
        if os.path.isfile(path):
            return path
    return None


def own_browser(ask, checks, apps, exe, flag, url, wants):
    """exe (msedge.exe, chrome.exe) started with flag on url in a profile of its own, read with browser.front_tab and
    closed; its answer must be one of wants. Not run when exe is missing or already has a window: no request may read a
    browser window this replay did not open."""
    path = installed(exe)
    if not path or any(a.get('app_id') == exe and a.get('regular') for a in apps):
        print(f'note: {exe} {"has windows open" if path else "is not installed"} here; its {flag} check did not run',
              flush=True)
        return
    profile = Path(tempfile.mkdtemp(prefix='c12-browser-'))
    browser = subprocess.Popen([path, f'--user-data-dir={profile}', '--no-first-run', '--no-default-browser-check', flag,
                                url])
    windows = []
    try:
        deadline = time.monotonic() + 30
        while not windows and time.monotonic() < deadline:
            time.sleep(0.5)
            listed = ask('windows.list', include_titles=True).get('result', {}).get('windows', [])
            windows = [w for w in listed if w.get('app_id') == exe and w.get('title')]
        time.sleep(3)  # its toolbar built and the page's load over
        got = ask('browser.front_tab', app_id=exe)
        print(f'note: {exe} {flag} {url}, window {[w.get("title") for w in windows]!a}: browser.front_tab '
              f'{got.get("result") or got.get("error")}', flush=True)
        checks.expect(bool(windows) and got.get('result') in wants, f'browser.front_tab of a {exe} {flag} window on {url}',
                      f'answer {got!a:.300}, wanted one of {wants}')
    finally:
        for w in windows:
            user32().PostMessageW(w['window_id'], 0x0010, 0, 0)  # WM_CLOSE
        try:
            browser.wait(15)
        except subprocess.TimeoutExpired:
            subprocess.run(['taskkill', '/PID', str(browser.pid), '/T', '/F'], capture_output=True, timeout=30)
            browser.wait(15)
        time.sleep(1)
        shutil.rmtree(profile, ignore_errors=True)


def browser_tab(exe, checks, target):
    """browser.front_tab: the replay's own app id, which is no browser, has null fields; an absent chrome.exe is
    process_gone. With a desktop, Edge and Chrome windows this replay opens in profiles of their own: InPrivate and
    Incognito on about:blank are private with no host (Chrome's Incognito, whose mark is translated, may be null in
    another language than English), a normal Edge window on an address that does not resolve gives its host, a normal
    Chrome window on about:blank is not private."""
    helper = Helper(exe)
    ids = iter(range(2, 1000))

    def ask(op, **params):
        return helper.request({'v': 1, 'id': next(ids), 'op': op, 'params': params}) or {}

    helper.request(HELLO)
    apps = ask('apps.running').get('result', {}).get('apps', [])
    mine = next((a.get('app_id') for a in apps if a['pid'] == os.getpid()), None) or ABSENT_APP
    got = ask('browser.front_tab', app_id=mine)
    checks.expect(got.get('result') == {'url_host': None, 'incognito': None},
                  f'browser.front_tab of the replay\'s own app id {mine} has null fields', f'answer {got!r:.300}')
    if any(a.get('app_id') == 'chrome.exe' for a in apps):
        print('note: chrome.exe runs here; browser.front_tab of an absent chrome.exe is unchecked', flush=True)
    else:
        got = ask('browser.front_tab', app_id='chrome.exe')
        checks.expect(got.get('error', {}).get('code') == 'process_gone',
                      'browser.front_tab of an absent chrome.exe is process_gone', f'answer {got!r:.300}')
    if target:
        english = (ctypes.windll.kernel32.GetUserDefaultUILanguage() & 0x3FF) == 0x09  # LANG_ENGLISH
        hidden = {'url_host': None, 'incognito': True}
        own_browser(ask, checks, apps, 'msedge.exe', '--inprivate', 'about:blank', [hidden])
        own_browser(ask, checks, apps, 'msedge.exe', '--new-window', UNRESOLVED_URL,
                    [{'url_host': 'c12-replay.invalid', 'incognito': False}])
        own_browser(ask, checks, apps, 'chrome.exe', '--incognito', 'about:blank',
                    [hidden] if english else [hidden, {'url_host': None, 'incognito': None}])
        own_browser(ask, checks, apps, 'chrome.exe', '--new-window', 'about:blank',
                    [{'url_host': None, 'incognito': False}])
    checks.expect(helper.exit_code() == 0, 'browser session exit', '')
    problem = validate.check(helper.transcript, SPEC)
    checks.expect(problem is None, 'browser session validate.check', problem)


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


def control_client(name, data):
    """A thread that opens the pipe name, writes data and reads until the helper closes the connection; got gets
    'data', the bytes read, or 'error'."""
    got = {}

    def run():
        try:
            with open(name, 'r+b', buffering=0) as pipe:
                pipe.write(data)
                chunks = []
                while chunk := pipe.read(65536):
                    chunks.append(chunk)
            got['data'] = b''.join(chunks)
        except OSError as error:
            got['error'] = error

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread, got


def control_endpoint(exe, checks):
    """control.listen, control.request and control.respond with clients of this process (ssh's session 0 has pipes)."""
    name = rf'\\.\pipe\c12-replay-{os.getpid()}-control'
    token_file = Path(tempfile.gettempdir()) / f'c12-replay-{os.getpid()}' / 'computer-control.token'
    helper = Helper(exe)
    helper.request(HELLO)
    listen = {'v': 1, 'id': 2, 'op': 'control.listen', 'params': {'endpoint': name, 'token_file': str(token_file)}}
    got = helper.request(listen) or {}
    checks.expect(got.get('result') == {'endpoint': name}, 'control.listen answers its endpoint', f'answer {got!r:.300}')
    token = token_file.read_text(encoding='ascii') if token_file.is_file() else ''
    checks.expect(re.fullmatch('[0-9a-f]{64}', token) is not None, 'control.listen writes a token of 32 random bytes',
                  f'{len(token)} characters')
    got = helper.request(dict(listen, id=3)) or {}
    checks.expect(got.get('error', {}).get('code') == 'already_running', 'a second control.listen in one helper',
                  f'answer {got!r:.300}')
    other = Helper(exe)
    other.request(HELLO)
    other_token = str(token_file.with_name('other.token'))
    got = other.request({'v': 1, 'id': 2, 'op': 'control.listen',
                         'params': {'endpoint': r'C:\c12-replay.sock', 'token_file': other_token}}) or {}
    checks.expect(got.get('error', {}).get('code') == 'endpoint_unavailable', 'control.listen of a name that is no pipe',
                  f'answer {got!r:.300}')
    got = other.request({'v': 1, 'id': 3, 'op': 'control.listen', 'params': {'endpoint': name, 'token_file': other_token}}) or {}
    checks.expect(got.get('error', {}).get('code') == 'already_running', 'control.listen of a pipe another helper has',
                  f'answer {got!r:.300}')
    checks.expect(other.exit_code() == 0, 'second control helper exit', '')
    checks.expect(token_file.is_file() and token_file.read_text(encoding='ascii') == token,
                  'the first helper keeps its token file', '')

    def line(message):
        return json.dumps(message, separators=(',', ':')).encode('utf-8') + b'\n'

    thread, reply = control_client(name, line({'id': 'w1', 'session_id': 's1', 'method': 'desktop_status',
                                               'params': {}, 'token': '0' * 64}))
    thread.join(10)
    refusal = {'id': 'w1', 'error': {'code': 'unauthorized', 'message': 'the token is not valid'}}
    checks.expect(reply.get('data', b'').endswith(b'\n') and json.loads(reply['data']) == refusal,
                  'a wrong token is refused', f'got {reply!r:.300}')
    request = {'id': 'r1', 'session_id': 's1', 'method': 'desktop_status', 'params': {}}
    thread, reply = control_client(name, line(dict(request, token=token)))
    event = helper.wait_event(lambda e: e['event'] == 'control.request', 10) or {}
    data = event.get('data', {})
    checks.expect(data.get('request') == request, 'control.request carries the request without its token',
                  f'event {event!r:.300}')
    response = {'id': 'r1', 'result': {'enabled': True}}
    got = helper.request({'v': 1, 'id': 4, 'op': 'control.respond',
                          'params': {'conn': data.get('conn', 1), 'response': response}}) or {}
    checks.expect(got.get('result') == {'sent': True}, 'control.respond sends', f'answer {got!r:.300}')
    thread.join(10)
    checks.expect(reply.get('data', b'').endswith(b'\n') and json.loads(reply['data']) == response,
                  'the client reads the response and the end of the connection', f'got {reply!r:.300}')
    got = helper.request({'v': 1, 'id': 5, 'op': 'control.respond',
                          'params': {'conn': data.get('conn', 1), 'response': response}}) or {}
    checks.expect(got.get('error', {}).get('code') == 'conn_gone', 'control.respond again answers conn_gone',
                  f'answer {got!r:.300}')
    requests = [e['data']['request'].get('id') for e in helper.events if e['event'] == 'control.request']
    checks.expect(requests == ['r1'], 'only the request with the token reaches the main process', f'requests {requests}')
    checks.expect(helper.exit_code() == 0, 'control session exit', '')
    checks.expect(not token_file.exists(), 'the token file goes when the helper exits', '')
    problem = validate.check(helper.transcript, SPEC)
    checks.expect(problem is None, 'control session validate.check', problem)
    try:
        token_file.parent.rmdir()
    except OSError:
        pass


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


def session_rules(exe, checks):
    for label, ids in [('a repeated request id', (2, 2)), ('a request id below an earlier one', (3, 2))]:
        helper = Helper(exe)
        helper.request(HELLO)
        first = helper.request({'v': 1, 'id': ids[0], 'op': 'screens.list', 'params': {}})
        got = helper.request({'v': 1, 'id': ids[1], 'op': 'screens.list', 'params': {}}, timeout=5)
        exit_code = helper.exit_code()
        checks.expect(first and first.get('ok') is True and got is None and exit_code == 2 and helper.stderr,
                      f'{label} exits 2', f'first {first!r:.200}, then {got!r:.200}, exit {exit_code}')

    for label, tail, code in [('a final line without a newline', b'{"v":1,"id":2,"op":"screens.list","params":{}}', 2),
                              ('final blanks without a newline', b' \t\r', 0)]:
        helper = Helper(exe)
        helper.request(HELLO)
        helper.send(tail)
        got = helper.next_line(2)
        exit_code = helper.exit_code()
        checks.expect(got is None and exit_code == code and bool(helper.stderr) == (code == 2),
                      f'{label} at EOF exits {code}', f'answer {got!r:.200}, exit {exit_code}, stderr {helper.stderr}')

    helper = Helper(exe)
    helper.request(HELLO)
    got = helper.request({'v': 1, 'id': 2, 'op': 'capture.ambient', 'params': {'source': 'screen|wallpaper', 'side': 2}})
    checks.expect(got and got.get('error', {}).get('code') == 'bad_request',
                  'capture.ambient source screen|wallpaper is bad_request', f'answer {got!r:.200}')
    checks.expect(helper.exit_code() == 0, 'bad source session exit', '')

    helper = Helper(exe)
    helper.request(HELLO)
    # 2100 x 2100 RGBA is over 16 MiB once base64 encoded.
    got = helper.request({'v': 1, 'id': 3, 'op': 'capture.ambient', 'params': {'source': 'wallpaper', 'side': 2100}},
                         timeout=30)
    size = len(helper.transcript[-1].encode('utf-8')) if got else None
    checks.expect(got and got.get('error', {}).get('code') == 'internal' and size < 4096,
                  'an answer over max_line_bytes is a short internal error',
                  f'{size} bytes, error {(got or {}).get("error")!r:.200}')
    got = helper.request({'v': 1, 'id': 4, 'op': 'screens.list', 'params': {}})
    checks.expect(got and got.get('ok') is True, 'the session goes on after an answer over max_line_bytes',
                  f'answer {got!r:.200}')
    checks.expect(helper.exit_code() == 0, 'max_line_bytes session exit', '')
    problem = validate.check(helper.transcript, SPEC)
    checks.expect(problem is None, 'max_line_bytes session validate.check', problem)

    helper = Helper(exe)
    helper.request(HELLO)

    def cpu_ns(n):
        got = helper.request({'v': 1, 'id': n, 'op': 'process.usage', 'params': {'pids': [helper.proc.pid]}}) or {}
        return next((u['cpu_time_ns'] for u in got.get('result', {}).get('usage', [])), None)

    before = cpu_ns(2)
    # A wallpaper of 4000 x 4000 costs the handler far more CPU than the session layer spends on four requests.
    lines = [json.dumps(m, separators=(',', ':')) + '\n' for m in (
        {'v': 1, 'id': 3, 'op': 'capture.ambient', 'params': {'source': 'wallpaper', 'side': 4000}},
        {'v': 1, 'id': 4, 'op': 'cancel', 'params': {'target': 3}})]
    helper.transcript.extend(lines)
    helper.send(''.join(lines).encode('utf-8'))
    answers = {}
    for _ in range(2):
        got = helper.next_line(10)
        message = json.loads(got) if got else {}
        answers[message.get('id')] = message
    time.sleep(3)  # long enough for a handler that did start to finish
    after = cpu_ns(5)
    spent = (after - before) / 1e6 if before is not None and after is not None else None
    print(f'note: the helper spent {spent} ms of CPU across a request cancelled in its own write', flush=True)
    checks.expect(answers.get(3, {}).get('error', {}).get('code') == 'cancelled'
                  and answers.get(4, {}).get('result') == {'cancelled': True},
                  'a request cancelled in its own write answers cancelled', f'answers {answers!r:.300}')
    checks.expect(spent is not None and spent < 50, 'a request cancelled before it started never runs',
                  f'{spent} ms of CPU')
    checks.expect(helper.exit_code() == 0, 'cancel session exit', '')
    problem = validate.check(helper.transcript, SPEC)
    checks.expect(problem is None, 'cancel session validate.check', problem)


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
    os.environ['AC_HELPER_MODELS_DIR'] = str(MODELS)
    window = TestWindow()
    scratch = tempfile.TemporaryDirectory()
    try:
        target = find_test_window(args.exe, window, checks)
        wavs = speak(checks, Path(scratch.name))
        # Before replay_ok, whose apps.activate gives the replay the foreground.
        if target:
            desktop(args.exe, checks, window, target)
            voice_download(args.exe, checks, wavs)
        browser_tab(args.exe, checks, target)
        voice(args.exe, checks)
        # Before replay_ok and voice_spoken, which then find the model in MODELS.
        recognizer(args.exe, checks, wavs)
        voice_spoken(args.exe, checks, wavs)
        replay_ok(args.exe, checks, target, window)
        control_endpoint(args.exe, checks)
        permission_requests(args.exe, checks)
        replay_bad(args.exe, checks)
        edge_cases(args.exe, checks)
        session_rules(args.exe, checks)
        sweep(args.exe, checks)
    finally:
        window.close()
        scratch.cleanup()
    print(f'HELPER-WIN: {checks.total} checks, {checks.failed} failed')
    return 1 if checks.failed else 0


if __name__ == '__main__':
    sys.exit(main())
