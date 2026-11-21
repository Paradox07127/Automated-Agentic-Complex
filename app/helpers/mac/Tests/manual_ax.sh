#!/bin/bash
# By hand, on a Mac whose helper may have the Accessibility grant: runs every ax.* op of ac-helper against the front
# window and prints a summary of each answer (error codes, counts, roles, lengths), never a title or any text read.
# Asks for no permission and activates nothing. Build first: swift build -c release in app/helpers/mac.
cd "$(dirname "$0")/.." || exit 1
exe=.build/release/ac-helper
[ -x "$exe" ] || { echo "no helper at $exe; run swift build -c release"; exit 1; }
exec python3 -I - "$exe" <<'EOF'
import json, subprocess, sys, threading, time, queue

proc = subprocess.Popen([sys.argv[1]], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
lines, events, next_id = queue.Queue(), [], [0]


def read():
    for raw in proc.stdout:
        message = json.loads(raw)
        (events.append(message) if 'event' in message else lines.put(message))


threading.Thread(target=read, daemon=True).start()


def ask(op, params=None):
    next_id[0] += 1
    started = time.monotonic()
    proc.stdin.write((json.dumps({'v': 1, 'id': next_id[0], 'op': op, 'params': params or {}}) + '\n').encode())
    proc.stdin.flush()
    got = lines.get(timeout=10)
    return got, int((time.monotonic() - started) * 1000)


def line(op, got, ms, summary):
    head = f'{op:<18} {ms:>4} ms  '
    print(head + (f'error {got["error"]["code"]}' if not got.get('ok') else summary(got['result'])))


ask('hello', {'protocol': 1, 'client': 'manual_ax'})
status, _ = ask('permissions.status')
print(f'accessibility: {status["result"]["accessibility"]}')
sample, _ = ask('attention.sample')
front = sample['result'].get('front') or {}
pid, window = front.get('pid'), front.get('window') or {}
print(f'front window: pid {"found" if pid else "none"}, window {"found" if window else "none"}')
if not pid:
    sys.exit(0)
bounds = window.get('bounds')


def rect(r):
    return 'null' if r is None else f'{round(r["width"])}x{round(r["height"])}'


line('ax.focused', *ask('ax.focused', {'pid': pid}), lambda r: 'focus null' if r['focus'] is None else
     f'role {r["focus"]["role"]}, subrole {r["focus"]["subrole"]}, frame {rect(r["focus"]["frame"])}, '
     f'caret {rect(r["focus"]["caret"])}, editable {r["focus"]["editable"]}')
line('ax.focused (system)', *ask('ax.focused'), lambda r: 'focus null' if r['focus'] is None else
     f'same pid {r["focus"]["pid"] == pid}, role {r["focus"]["role"]}')
line('ax.dialog_buttons', *ask('ax.dialog_buttons', {'pid': pid}), lambda r: f'{len(r["buttons"])} buttons')
line('ax.overlays', *ask('ax.overlays'), lambda r: f'{len(r["banners"])} banners, {len(r["ime"])} ime windows')
if bounds:
    center = {'x': bounds['x'] + bounds['width'] / 2, 'y': bounds['y'] + bounds['height'] / 2}
    line('ax.hit_chain', *ask('ax.hit_chain', {'point': center}), lambda r:
         f'same pid {r["pid"] == pid}, chain {[h["role"] for h in r["chain"]]}')
for level in ('focused', 'window'):
    params = {'pid': pid, 'level': level}
    if bounds and level == 'window':
        params['window_bounds'] = bounds
    got, ms = ask('ax.window_text', params)
    line(f'ax.window_text {level}', got, ms, lambda r: f'matched {r["matched"]}, {len(r["nodes"])} nodes, '
         f'{len(r["text"])} chars, coverage {r["coverage"]["status"]} {r["coverage"]["reasons"]}')
    pages = 1
    while got.get('ok') and got['result']['coverage'].get('next_cursor') and pages < 5:
        got, ms = ask('ax.window_text', dict(params, cursor=got['result']['coverage']['next_cursor']))
        pages += 1
        line(f'  page {pages}', got, ms, lambda r: f'{len(r["nodes"])} nodes, {len(r["text"])} chars, '
             f'coverage {r["coverage"]["status"]} {r["coverage"]["reasons"]}')
line('ax.selected_text', *ask('ax.selected_text', {'pid': pid}), lambda r: 'null' if r['text'] is None else f'{len(r["text"])} chars')
line('ax.video_rect', *ask('ax.video_rect', {'pid': pid}), lambda r: f'rect {rect(r["rect"])}')
line('ax.watch', *ask('ax.watch', {'pid': pid, 'notifications': ['focus', 'window', 'title', 'value', 'selection']}),
     lambda r: f'watching {r["watching"]}')
time.sleep(3)
line('ax.watch stop', *ask('ax.watch', {'pid': None, 'notifications': []}), lambda r: f'watching {r["watching"]}')
kinds = [e['data']['notification'] for e in events if e['event'] == 'ax.notification']
print(f'ax.notification in 3 s: {len(kinds)} {sorted(set(kinds))}')
proc.stdin.close()
proc.wait(5)
EOF
