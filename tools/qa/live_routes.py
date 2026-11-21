#!/usr/bin/env python3
"""Read-only check of every UI-readable agentd route against a running Endfield app; only GET is sent."""
import argparse
import http.client
import json
from pathlib import Path
import re
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
ROUTES = ROOT / 'protocol/ui-bridge/routes.json'
RUNTIME = Path.home() / 'Library/Application Support/AgenticComplex/agentd/ui-runtime.json'
TIMEOUT = 20
REGEX_CHARS = set('^$()[]{}?*+|\\.')
NO_SAMPLE = '跳过：没有样本 id'


def ui_routes(routes):
    return [r for r in routes if r['method'] == 'GET' and r['class'] == 'read'
            and {'main', 'stack'} & set(r.get('surfaces', []))]


def fetch(base, token, path):
    """(status or error text, body bytes, milliseconds)."""
    url = base.rstrip('/') + urllib.parse.quote(path, safe="/:@-._~!$&'()*+,;=")
    request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token})
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            status, body = response.status, response.read()
    except urllib.error.HTTPError as e:
        with e:
            status, body = e.code, e.read()
    except (http.client.RemoteDisconnected, ConnectionResetError, http.client.IncompleteRead):
        status, body = '连接被关', b''
    except (socket.timeout, TimeoutError):
        status, body = '超时', b''
    except urllib.error.URLError as e:
        reason = e.reason
        if isinstance(reason, (socket.timeout, TimeoutError)):
            status = '超时'
        elif isinstance(reason, (http.client.RemoteDisconnected, ConnectionResetError)):
            status = '连接被关'
        else:
            status = '错误 ' + str(reason)
        body = b''
    except OSError as e:
        status, body = '错误 ' + str(e), b''
    return status, body, (time.monotonic() - started) * 1000


def split_pattern(pattern):
    """List path and the regex text after it, e.g. ^/agent/runs/(x)/items$ -> /agent/runs, (x)/items$."""
    text = pattern.lstrip('^')
    first = next((i for i, c in enumerate(text) if c in REGEX_CHARS), len(text))
    cut = text.rfind('/', 0, first)
    return text[:cut], text[cut + 1:]


def top_segments(rest):
    """Split at '/' outside groups and character classes."""
    parts, depth, in_class, current = [], 0, False, ''
    for i, c in enumerate(rest):
        escaped = i > 0 and rest[i - 1] == '\\'
        if in_class:
            in_class = not (c == ']' and not escaped)
        elif c == '[' and not escaped:
            in_class = True
        elif c == '(' and not escaped:
            depth += 1
        elif c == ')' and not escaped:
            depth -= 1
        elif c == '/' and depth == 0:
            parts.append(current); current = ''
            continue
        current += c
    parts.append(current)
    return parts


def sample_ids(listing):
    """Id-like values of the first item of the first list of objects in a list response."""
    if not isinstance(listing, dict):
        return []
    items = next((v for v in listing.values() if isinstance(v, list) and v and isinstance(v[0], dict)), None)
    if not items:
        return []
    first = items[0]
    keys = (['id'] if 'id' in first else []) + [k for k in first if k.endswith('_id')]
    return [str(first[k]) for k in keys if isinstance(first[k], (str, int)) and not isinstance(first[k], bool)]


def concrete_path(pattern, base, token, listings):
    list_path, rest = split_pattern(pattern)
    if list_path not in listings:
        status, body, _ = fetch(base, token, list_path)
        try:
            listings[list_path] = json.loads(body) if status == 200 else None
        except ValueError:
            listings[list_path] = None
    segments = top_segments(rest)
    tail = ''.join('/' + s for s in segments[1:]).rstrip('$')
    if any(c in REGEX_CHARS for c in tail):
        return None
    for value in sample_ids(listings[list_path]):
        path = list_path + '/' + value + tail
        if re.fullmatch(pattern, path):
            return path
    return None


def main(argv=None, routes=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path, default=RUNTIME)
    args = parser.parse_args(argv)
    runtime = json.loads(args.runtime.read_text())
    base, token = runtime['base_url'], runtime['ui_token']
    if routes is None:
        routes = json.loads(ROUTES.read_text())
    passed = failed = skipped = 0
    listings = {}
    for route in ui_routes(routes):
        path = route['path']
        if path.startswith('^'):
            path = concrete_path(route['path'], base, token, listings)
            if path is None:
                skipped += 1
                print(f"SKIP  {route['path']}  {NO_SAMPLE}", flush=True)
                continue
        status, body, ms = fetch(base, token, path)
        ok = isinstance(status, int) and 200 <= status < 300
        passed += ok; failed += not ok
        print(f"{'PASS' if ok else 'FAIL'}  {path}  {status}  {len(body)} B  {ms:.0f} ms", flush=True)
    print(f'汇总：通过 {passed}，失败 {failed}，跳过 {skipped}', flush=True)
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
