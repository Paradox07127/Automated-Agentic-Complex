#!/usr/bin/env python3
"""Deploy the web UI and agentd for an installed Agentic Complex.app whose config.json sets dev_resources.

Each deployment is a new directory under .local/dev-runtime written by build_components' staging code; the half
not deployed is cloned from the previous one. `current` then switches to it in one rename, and a running app reloads
on the new receipt. Shell, Metal, preview service, Info.plist and new Python dependencies still need a packaged app.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_components
import package_app
from character_library import write_json
from release import build_web, default_profile, source_state

ROOT = package_app.ROOT
BASE = ROOT / '.local/dev-runtime'
RECEIPT = 'dev-receipt.json'
SCHEMA = 'endfield-dev-runtime/v1'
KEEP = 5
NAME = re.compile(r'\d{8}T\d{6}Z-[0-9a-f]+(-dirty)?')
# Each half and the directories that hold it in a deployment.
HALVES = {'web': ['ui', 'ui-bridge'], 'agentd': ['runtime']}


def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args], text=True).strip()


def deployments(base):
    """This script's deployment directories in base, oldest first."""
    if not base.is_dir(): return []
    return sorted(p for p in base.iterdir() if p.is_dir() and not p.is_symlink() and NAME.fullmatch(p.name)
                  and (p / RECEIPT).is_file())


def switch_current(base, name):
    """Point base/current at name in one rename, so a reader sees the old deployment or the new one."""
    link = base / ('.current-' + str(os.getpid()))
    if link.is_symlink(): link.unlink()
    os.symlink(name, link)
    os.replace(link, base / 'current')


def prune(base, keep=KEEP):
    current = (base / 'current').resolve() if (base / 'current').is_symlink() else None
    for old in deployments(base)[:-keep]:
        if old.resolve() != current: shutil.rmtree(old)


def stage_web(target, web_dist, ui_art):
    if web_dist is not None:
        receipt = build_components.stage_ui(web_dist, ui_art, target)
    else:
        art = json.loads(default_profile(ROOT).read_text()).get('ui_art')
        art = ROOT / art if art else None
        if art and not (art / 'art-manifest.json').is_file(): raise ValueError('UI art missing: ' + str(art) + '. Render it with tools/release/render_ui_art.py.')
        with tempfile.TemporaryDirectory() as tmp:
            receipt = build_components.stage_ui(build_web(ROOT, Path(tmp) / 'ui'), art, target)
    return package_app.tree_sha256(target / 'ui'), receipt


def stage_agentd(runtime):
    """Stage agentd into runtime/agentd with the profile's overrides of the agentd component's agentd/ files."""
    build_components.stage_agentd(runtime / 'agentd')
    overrides = json.loads(default_profile(ROOT).read_text()).get('content_overrides', {})
    build_components.apply_content_overrides(dict(agentd=runtime), {relative: ROOT / source for relative, source in overrides.items()
                                                                    if relative.startswith('agentd/agentd/')})


def deploy(part, base=BASE, web_dist=None, ui_art=None, now=None):
    """Writes one deployment of `part` (web, agentd or all) and switches current to it; returns its receipt."""
    state = source_state(ROOT)
    dirty = not state['shipping_sources_clean']
    previous = (base / 'current').resolve() if (base / 'current').is_symlink() else None
    if part != 'all' and (previous is None or not (previous / RECEIPT).is_file()):
        raise ValueError('No previous deployment in ' + str(base) + ' to keep the other half from; deploy all first.')
    now = now or datetime.datetime.now(datetime.timezone.utc)
    name = now.strftime('%Y%m%dT%H%M%SZ') + '-' + git('rev-parse', '--short', state['head']) + ('-dirty' if dirty else '')
    out = base / name
    if out.exists(): raise ValueError('Deployment already exists: ' + str(out))
    base.mkdir(parents=True, exist_ok=True)
    staging = base / ('.staging-' + name)
    staging.mkdir()
    try:
        for half, directories in HALVES.items():
            if part not in (half, 'all'):
                for directory in directories:
                    subprocess.run(['cp', '-c', '-R', str(previous / directory), str(staging / directory)], check=True)
            elif half == 'web':
                stage_web(staging, web_dist, ui_art)
            else:
                stage_agentd(staging / 'runtime')
        receipt = dict(schema=SCHEMA, commit=state['head'], dirty=dirty, part=part, created=now.isoformat(),
                       ui_sha256=package_app.tree_sha256(staging / 'ui'),
                       agentd_sha256=package_app.tree_sha256(staging / 'runtime/agentd'))
        write_json(staging / RECEIPT, receipt)
        staging.rename(out)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    switch_current(base, name)
    prune(base)
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('part', choices=['web', 'agentd', 'all'])
    args = parser.parse_args()
    receipt = deploy(args.part)
    print(BASE / 'current', '->', os.readlink(BASE / 'current'))
    print('commit', receipt['commit'] + (' (dirty)' if receipt['dirty'] else ''))
    print('ui_sha256', receipt['ui_sha256'])
    print('agentd_sha256', receipt['agentd_sha256'])
