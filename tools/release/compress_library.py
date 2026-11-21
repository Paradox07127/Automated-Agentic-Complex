#!/usr/bin/env python3
"""Write a copy of a character library whose packages store their pool files compressed (compress_pool); macOS only.

The Windows release reads such a library as its shared input, since the Windows host has no LZFSE encoder.
Usage: python3 -I tools/release/compress_library.py <library current.json> <output library directory>
Prints one JSON line: for each character, its package bytes before and after and the number of pool files compressed.
"""
import argparse
import json
from pathlib import Path
import shutil
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(ROOT / 'agent/agentd'))
from build_components import compress_pool
from character_library import Library
from character_tool import compose


def tree_bytes(root):
    return sum(path.stat().st_size for path in Path(root).rglob('*') if path.is_file())


def compress_library(catalog, output):
    """Compose output from the packages of the library whose catalog is catalog, each with its pool compressed."""
    catalog, output = Path(catalog).resolve(), Path(output).resolve()
    if output.exists() or output.is_symlink(): raise ValueError('output_already_exists: ' + str(output))
    library = Library(catalog.parent, catalog.name)
    snapshot = library.snapshot()
    output.parent.mkdir(parents=True, exist_ok=True)
    characters, staged = [], []
    with tempfile.TemporaryDirectory(prefix='.compress-', dir=output.parent) as temporary:
        for package in library.packages():
            target = Path(temporary) / package.id
            shutil.copytree(package.root, target, symlinks=True)
            files = compress_pool(target) if package.render_enabled else 0
            characters.append(dict(id=package.id, bytes_before=tree_bytes(package.root), bytes_after=tree_bytes(target),
                                   files_compressed=files))
            staged.append(target)
        compose(staged, snapshot.get('default_character'), output)
    return dict(characters=characters)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('catalog', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args(argv)
    print(json.dumps(compress_library(args.catalog, args.output), ensure_ascii=False))


if __name__ == '__main__':
    main()
