#!/usr/bin/env python3
"""Find the local absolute paths a character library still holds; a released library holds none.

A JSON string value is a local absolute path when it starts with /Users/, /private/, /var/, /tmp/ or /Volumes/, or
contains /Users/; each one is listed with its file and key. Every file, JSON or not, is also searched byte for byte
for /Users/. Exit status 1 when anything is found.
Stdlib only.
"""
import argparse
import json
from pathlib import Path
import sys

PREFIXES = ('/Users/', '/private/', '/var/', '/tmp/', '/Volumes/')
USERS = '/Users/'
IN_BYTES = USERS + ' in the bytes'


def local(value):
    return isinstance(value, str) and (value.startswith(PREFIXES) or USERS in value)


def values(value, pointer=()):
    """(key path, string) of every local absolute path in a JSON value."""
    if isinstance(value, dict):
        for k, v in value.items():yield from values(v, pointer+(str(k),))
    elif isinstance(value, list):
        for i, v in enumerate(value):yield from values(v, pointer+(str(i),))
    elif local(value):
        yield '/'.join(pointer), value


def find(root):
    """[{file, key, value}] over every file under root in path order; key is None for a byte hit."""
    root = Path(root); hits = []
    for path in sorted(p for p in root.rglob('*') if p.is_file()):
        name = path.relative_to(root).as_posix(); data = path.read_bytes()
        if path.suffix == '.json':
            try:document = json.loads(data)
            except ValueError:document = None
            hits += [dict(file=name, key=key, value=value) for key, value in values(document)]
        if USERS.encode() in data:hits.append(dict(file=name, key=None, value=IN_BYTES))
    return hits


def require_none(root):
    hits = find(root)
    if hits:
        raise ValueError('release library holds %d local absolute paths: %s' % (
            len(hits), ', '.join(h['file']+(' '+h['key'] if h['key'] else '') for h in hits[:12])))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('library', help='character library directory')
    root = parser.parse_args(argv).library; hits = find(root)
    for h in hits:print('%s\t%s\t%s' % (h['file'], h['key'] or '-', h['value']))
    print('%d local absolute paths in %s' % (len(hits), root))
    return 1 if hits else 0


if __name__ == '__main__':
    sys.exit(main())
