#!/usr/bin/env python3
"""Write C11 component manifests and composition locks; hash component payload trees."""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat

EXCLUDED = (".DS_Store", "__pycache__")
_spec = importlib.util.spec_from_file_location(
    "c11_validate", Path(__file__).resolve().parents[2] / "protocol/C11-components/validate.py")
c11 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(c11)


def _tree(root):
    root = Path(root)
    if not root.is_dir():
        raise NotADirectoryError(root)
    paths = []
    for directory, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = [name for name in dirnames if name not in EXCLUDED]
        for name in dirnames + filenames:
            path = Path(directory, name)
            relative = path.relative_to(root).as_posix()
            if name not in EXCLUDED and relative != "component.json":
                paths.append((relative, path))
    records, byte_count = [], 0
    for relative, path in sorted(paths, key=lambda item: item[0].encode("utf-8")):
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            records.append(f"L {relative} {os.readlink(path)}")
        elif stat.S_ISREG(info.st_mode):
            digest = hashlib.sha256()
            with path.open("rb") as stream:
                while chunk := stream.read(4 * 1024 * 1024):
                    digest.update(chunk)
            executable = int(bool(info.st_mode & 0o111))
            records.append(f"F {relative} {executable} {info.st_size} {digest.hexdigest()}")
            byte_count += info.st_size
        elif not stat.S_ISDIR(info.st_mode):
            raise ValueError(f"unsupported tree entry: {relative}")
    digest = hashlib.sha256("\n".join(records).encode("utf-8")).hexdigest()
    return digest, len(records), byte_count


def tree_sha256(root):
    return _tree(root)[0]


def write_component(root, id, version, entrypoints, provides, requires, placed=None, platform="macos-arm64"):
    """Write root.parent/component.json beside the payload directory, and return it."""
    root = Path(root).resolve()
    digest, files, byte_count = _tree(root)
    doc = dict(schema="endfield-component/v1", id=id, version=version, tree_sha256=digest,
               files=files, bytes=byte_count, entrypoints=entrypoints, provides=provides,
               requires=requires, platform=platform)
    if placed is not None: doc["placed"] = placed
    if error := c11.check_component(doc): raise ValueError(error)
    (root.parent / "component.json").write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return doc


def write_lock(path, edition, host, components, platform="macos-arm64"):
    doc = dict(schema="endfield-composition/v1", edition=edition, platform=platform,
               created_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
               host=host, components=components)
    Path(path).write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("hash",))
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    print(tree_sha256(args.directory))
