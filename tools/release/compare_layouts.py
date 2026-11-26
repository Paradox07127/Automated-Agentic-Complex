#!/usr/bin/env python3
"""Compare component payloads in portable and split release output directories."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

MACHO_MAGIC = {b'\xfe\xed\xfa\xce', b'\xce\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xcf\xfa\xed\xfe',
               b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca', b'\xca\xfe\xba\xbf', b'\xbf\xba\xfe\xca'}


def read_json(path):
    try:
        document = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(document, dict): raise ValueError('expected a JSON object')
        return document
    except ValueError as exc:
        raise ValueError(f'{path}: {exc}') from exc


def components(output, layout):
    path = output / 'staging-manifest.json'
    stage = read_json(path)
    if stage.get('layout') != layout: raise ValueError(f'{path}: expected {layout} layout')
    contents = output / stage['app'] / 'Contents'
    roots = [contents / 'Resources/components']
    if layout == 'split': roots.append(output / 'components')
    return contents, {path.name: path for root in roots
                      for path in root.iterdir() if stat.S_ISDIR(path.stat().st_mode)}


def files_under(path, relative):
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return
    if stat.S_ISDIR(mode):
        for child in path.iterdir(): yield from files_under(child, relative / child.name)
    else:
        yield relative.as_posix(), path


def payload_files(directory, contents, manifest):
    sources = {relative: contents / placed for relative, placed in manifest['placed'].items()} \
        if 'placed' in manifest else {'': directory / 'payload'}
    return {relative: path for name, source in sources.items() for relative, path in files_under(source, Path(name))}


def file_value(path, code_pages=False):
    if path.is_symlink(): return 'symlink target', os.readlink(path)
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        if stream.read(4) in MACHO_MAGIC:
            kind = 'code-page hashes' if code_pages else 'CDHash'
            archs = subprocess.run(['lipo', '-archs', str(path)], capture_output=True, text=True)
            if archs.returncode: raise ValueError(f'{path}: lipo failed: {archs.stderr.strip()}')
            value = {}
            # codesign -d shows only the native slice of a fat file unless --arch names another.
            for arch in archs.stdout.split():
                result = subprocess.run(['codesign', '-d', '--arch', arch, '-vvvvvv' if code_pages else '-vvv', str(path)],
                                        capture_output=True, text=True)
                output = result.stdout + result.stderr
                if result.returncode: raise ValueError(f'{path}: codesign failed: {output.strip()}')
                if code_pages:
                    value[arch] = {int(slot): page_hash.lower() for slot, page_hash in
                                   re.findall(r'^\s*(\d+)=([0-9a-fA-F]+)\s*$', output, re.MULTILINE)}
                else:
                    value[arch] = re.findall(r'^CDHash=([0-9a-fA-F]+)$', output, re.MULTILINE)
                if not value[arch]: raise ValueError(f'{path}: codesign returned no {kind} for {arch}')
            return kind, value
        stream.seek(0)
        while chunk := stream.read(4 * 1024 * 1024): digest.update(chunk)
    return 'sha256', digest.hexdigest()


def component_difference(left, right, left_contents, right_contents):
    left_manifest, right_manifest = (read_json(path / 'component.json') for path in (left, right))
    for manifest in (left_manifest, right_manifest): manifest.pop('tree_sha256', None)
    for key in sorted(left_manifest.keys() | right_manifest.keys()):
        if key not in left_manifest or key not in right_manifest or left_manifest[key] != right_manifest[key]:
            return f'component.json: {key} differs'
    left_files = payload_files(left, left_contents, left_manifest)
    right_files = payload_files(right, right_contents, right_manifest)
    host_executable = left_manifest['entrypoints'].get('executable') if left_manifest['id'] == 'host' else None
    for relative in sorted(left_files.keys() | right_files.keys()):
        if relative not in left_files: return f'{relative}: missing in portable'
        if relative not in right_files: return f'{relative}: missing in split'
        # A signed bundle's CMS blob differs only in its signing time; the CodeDirectory beside it is the CDHash input.
        if Path(relative).parent.name == '_CodeSignature' and Path(relative).name == 'CodeSignature': continue
        # The host's resource seal changes with the layout; its code pages must not.
        left_kind, left_value = file_value(left_files[relative], relative == host_executable)
        right_kind, right_value = file_value(right_files[relative], relative == host_executable)
        if left_kind != right_kind: return f'{relative}: file type differs'
        if left_value != right_value: return f'{relative}: {left_kind} differs'
        left_x, right_x = (files[relative].lstat().st_mode & 0o111 != 0 for files in (left_files, right_files))
        if left_kind != 'symlink target' and left_x != right_x: return f'{relative}: executable bit differs'
    return None


def compare_layouts(portable, split):
    left_contents, left = components(portable, 'portable')
    right_contents, right = components(split, 'split')
    # Only the layout key of the release configuration differs by design.
    left_config, right_config = (read_json(contents / 'Resources/distribution.json')
                                 for contents in (left_contents, right_contents))
    config = [key for key in sorted(left_config.keys() | right_config.keys())
              if key != 'layout' and left_config.get(key, left_config) != right_config.get(key, right_config)]
    print('distribution.json: ' + (f'{config[0]} differs' if config else 'same'))
    different = bool(config)
    for id in sorted(left.keys() | right.keys()):
        if id not in left: difference = 'component missing in portable'
        elif id not in right: difference = 'component missing in split'
        else: difference = component_difference(left[id], right[id], left_contents, right_contents)
        print(f'{id}: {difference or "same"}')
        different |= difference is not None
    print('LAYOUTS DIFFER' if different else 'LAYOUTS SAME')
    return int(different)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--portable', type=Path, required=True)
    parser.add_argument('--split', type=Path, required=True)
    args = parser.parse_args()
    try:
        raise SystemExit(compare_layouts(args.portable, args.split))
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f'error: {exc}', file=sys.stderr)
        raise SystemExit(2)
