"""Remove idle runner actors and disposable native-history indexes.

Never open the user's native profile. Product Memory/History/RunStore databases,
credentials, config, goals and task checkpoints are outside the accepted paths.
"""
import os
from pathlib import Path
import re
import shutil
import sqlite3
import time

from infra.platform import lock_file

SQLITE_NAME = re.compile(r'state_[0-9]+\.sqlite')
RUNNER_BACKENDS = ('codex',)


def _inside(path, root):
    if not path.is_relative_to(root): return False
    current = path
    while current != root.parent:
        if current.is_symlink(): return False
        if current == root: break
        current = current.parent
    return path.resolve().is_relative_to(root.resolve())


def lock_runner_actor(actor):
    """Return jobs, actor and lock descriptors, or None outside managed actors."""
    actor = Path(actor).absolute()
    if '..' in actor.parts or actor.parent.name != 'jobs': return None
    runner = actor.parents[2]
    if runner.parts[-2:] != ('character-agent', 'runner') or actor.parent.parent.name not in RUNNER_BACKENDS:
        return None
    if not _inside(actor / '.session.lock', runner): return None
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    descriptors = []
    try:
        descriptors.append(os.open(runner, flags))
        for name in (actor.parent.parent.name, 'jobs', actor.name):
            descriptors.append(os.open(name, flags, dir_fd=descriptors[-1]))
        lock = os.open('.session.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600, dir_fd=descriptors[-1])
        descriptors.append(lock)
        lock_file(lock, blocking=False)
        os.close(descriptors.pop(0))
        os.close(descriptors.pop(0))
        return tuple(descriptors)
    except OSError:
        for descriptor in descriptors: os.close(descriptor)
        raise


def release_runner_actor(lease):
    # Closing, rather than LOCK_UN, preserves an inherited runner's lock.
    if lease is not None:
        for descriptor in lease: os.close(descriptor)


def remove_runner_actor(actor, lease):
    if lease is None: return
    parent, directory, _ = lease
    try:
        current = os.stat(Path(actor).name, dir_fd=parent, follow_symlinks=False)
        if os.path.samestat(current, os.fstat(directory)):
            shutil.rmtree(Path(actor).name, dir_fd=parent)
    except FileNotFoundError:
        pass


def runner_indexes(runner):
    runner = Path(runner).absolute()
    if runner.is_symlink() or not runner.is_dir(): return []
    directories = [runner / 'codex' / 'sqlite', *runner.glob('codex/jobs/*/sqlite')]
    result = []
    for directory in directories:
        if not _inside(directory, runner) or not directory.is_dir(): continue
        lease = None
        try:
            if directory.parent.parent.name == 'jobs' and (directory.parent / '.session.lock').exists():
                try: lease = lock_runner_actor(directory.parent)
                except (BlockingIOError, FileNotFoundError): continue
                if lease is None: continue
            for path in directory.glob('state_*.sqlite'):
                if not SQLITE_NAME.fullmatch(path.name) or not _inside(path, runner): continue
                if path.stat().st_nlink != 1: raise ValueError('native_cache_hardlink_refused')
                for suffix in ('-wal', '-shm'):
                    sidecar = path.with_name(path.name + suffix)
                    if sidecar.is_symlink() or sidecar.exists() and sidecar.stat().st_nlink != 1:
                        raise ValueError('native_cache_sidecar_refused')
                db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=1)
                try:
                    fields = {row[1] for row in db.execute('PRAGMA table_info(threads)')}
                    if not {'id', 'rollout_path', 'cwd', 'source'} <= fields: continue
                    count = db.execute('SELECT COUNT(*) FROM threads').fetchone()[0]
                    result.append({'path': str(path), 'thread_rows': count, 'bytes': path.stat().st_size})
                finally: db.close()
        finally: release_runner_actor(lease)
    return result


def purge_idle_runner_actors(runner, *, stopped=lambda: False):
    """Disposable tree removal may be slow; keep it outside readiness checks."""
    runner = Path(runner).absolute()
    if runner.parts[-2:] != ('character-agent', 'runner'):
        raise ValueError('unowned_native_cache_root')
    for backend in RUNNER_BACKENDS:
        for actor in (runner / backend / 'jobs').glob('*'):
            if stopped(): return
            if not _inside(actor, runner) or not actor.is_dir(): continue
            try:
                # Creating the lock changes mtime; preserve the original age.
                original = actor.stat()
                if time.time() - original.st_mtime <= 10 * 60: continue
                lease = lock_runner_actor(actor)
            except (BlockingIOError, FileNotFoundError): continue
            try:
                if lease is not None and os.path.samestat(original, os.fstat(lease[1])):
                    remove_runner_actor(actor, lease)
            finally: release_runner_actor(lease)


def purge_runner_indexes(runner, *, apply=False, remove_idle=True):
    runner = Path(runner).absolute()
    # Accept only the product's runner location, never an arbitrary native home.
    if runner.parts[-2:] != ('character-agent', 'runner'):
        raise ValueError('unowned_native_cache_root')
    if apply and remove_idle: purge_idle_runner_actors(runner)
    items = runner_indexes(runner)
    if apply:
        for item in items:
            path = Path(item['path'])
            lease = None
            try:
                if path.parent.parent.parent.name == 'jobs':
                    try: lease = lock_runner_actor(path.parent.parent)
                    except (BlockingIOError, FileNotFoundError): continue
                    if lease is None: continue
                if not _inside(path, runner) or path.stat().st_nlink != 1: raise ValueError('native_cache_changed')
                # Unlink the disposable vendor index, including WAL; no export.
                for suffix in ('', '-wal', '-shm'):
                    candidate = path.with_name(path.name + suffix)
                    if candidate.is_symlink(): raise ValueError('native_cache_changed')
                    if candidate.exists():
                        if candidate.stat().st_nlink != 1: raise ValueError('native_cache_changed')
                        candidate.unlink()
            finally: release_runner_actor(lease)
    return {'applied': apply, 'databases': len(items), 'thread_rows': sum(i['thread_rows'] for i in items), 'items': items}


def main():
    import argparse
    import json
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runner', type=Path, action='append', required=True,
                        help='An owned character-agent/runner directory; stop its runtime before applying')
    parser.add_argument('--apply', action='store_true', help='Delete disposable indexes; default is inventory only')
    args = parser.parse_args()
    print(json.dumps([purge_runner_indexes(root, apply=args.apply) for root in args.runner], indent=2))


if __name__ == '__main__':
    main()
