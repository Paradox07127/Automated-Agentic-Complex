#!/bin/bash
# By hand, on a Mac whose helper may have the Screen Recording and Microphone grants: captures the front window and reads
# it with OCR, then records the microphone for at most 2 s and stops with discard. Prints sizes, line counts, levels and
# timings only: never a pixel, a recognized word or a sound, and nothing is saved. Asks for no permission and activates
# nothing. Build first: swift build -c release in app/helpers/mac.
cd "$(dirname "$0")/.." || exit 1
exe=.build/release/ac-helper
[ -x "$exe" ] || { echo "no helper at $exe; run swift build -c release"; exit 1; }
exec python3 -I - "$exe" <<'EOF'
import base64, json, subprocess, sys, threading, time, queue

proc = subprocess.Popen([sys.argv[1]], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
lines, events, next_id = queue.Queue(), [], [0]


def read():
    for raw in proc.stdout:
        message = json.loads(raw)
        (events.append(message) if 'event' in message else lines.put(message))


threading.Thread(target=read, daemon=True).start()


def ask(op, params=None, timeout=15):
    next_id[0] += 1
    started = time.monotonic()
    proc.stdin.write((json.dumps({'v': 1, 'id': next_id[0], 'op': op, 'params': params or {}}) + '\n').encode())
    proc.stdin.flush()
    got = lines.get(timeout=timeout)
    return got, int((time.monotonic() - started) * 1000)


def line(op, got, ms, summary):
    head = f'{op:<26} {ms:>5} ms  '
    print(head + (f'error {got["error"]["code"]}' if not got.get('ok') else summary(got['result'])))


ask('hello', {'protocol': 1, 'client': 'manual_media'})
status, _ = ask('permissions.status')
print(f'screenRecording: {status["result"]["screenRecording"]}, microphone: {status["result"]["microphone"]}')
sample, _ = ask('attention.sample')
window = (sample['result'].get('front') or {}).get('window') or {}
print(f'front window: {"found" if window else "none"}')


def image(r):
    data = base64.b64decode(r['image']['data'])
    return f'{r["image"]["format"]} {r["image"]["width"]}x{r["image"]["height"]}, {len(data)} bytes, scale {r["scale"]}'


if window:
    wid = window['window_id']
    line('capture.window png', *ask('capture.window', {'window_id': wid}), image)
    line('capture.window jpeg 1280', *ask('capture.window', {'window_id': wid, 'format': 'jpeg', 'max_long_side': 1280}), image)
    line('ocr.recognize', *ask('ocr.recognize', {'window_id': wid}), lambda r:
         f'{len(r["lines"])} lines, {len(r["text"])} chars, languages {r["languages"]}')
line('capture.ambient screen 16', *ask('capture.ambient', {'source': 'screen', 'side': 16}),
     lambda r: f'{r["width"]}x{r["height"]}, {len(base64.b64decode(r["rgba"]))} bytes')
line('capture.ambient wallpaper', *ask('capture.ambient', {'source': 'wallpaper', 'side': 16}),
     lambda r: f'{r["width"]}x{r["height"]}, {len(base64.b64decode(r["rgba"]))} bytes')
line('speech.locales', *ask('speech.locales'), lambda r: f'{r["engine"]}, {len(r["locales"])} locales')
got, ms = ask('mic.start', {'session': 'manual', 'locale': 'zh-CN', 'level_events': True}, timeout=130)
line('mic.start zh-CN', got, ms, lambda r: f'locale {r["locale"]}, {r["sample_rate"]} Hz')
if got.get('ok'):
    time.sleep(2)
    line('mic.stop discard', *ask('mic.stop', {'session': 'manual', 'discard': True}),
         lambda r: f'{len(r["text"])} chars, {r["duration_ms"]} ms')
levels = [e['data']['rms'] for e in events if e['event'] == 'mic.level']
partials = [e for e in events if e['event'] == 'speech.partial']
print(f'mic.level: {len(levels)} in about 2 s, max rms {max(levels, default=0):.3f}; speech.partial: {len(partials)}')
proc.stdin.close()
proc.wait(5)
EOF
