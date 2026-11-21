#!/usr/bin/env python3
"""Gate receipts (schema endfield-gate-receipt/v1): what tools/qa/gate.py ran, on which sources, and the result.

The store is <checkout>/.local/gate-receipts/<profile>/: one <UTC>-<fingerprint[:12]>.json per run, the newest KEEP kept,
and gate-receipt.json, a copy of the latest receipt that validate() accepts. Stdlib only.
"""
import hashlib
import json
from pathlib import Path
import shutil

SCHEMA = 'endfield-gate-receipt/v1'
KEEP = 20
LATEST = 'gate-receipt.json'
RELEASE_PROFILES = ('commit', 'release')
# gate.py hashes private/suites.json too when it exists.
SUITES = ['tools/qa/suites.json', 'private/suites.json']
RUNNER = ['tools/qa/gate.py', 'tools/release/source_fingerprint.py', 'tools/release/gate_receipt.py']


def build(**fields):
    return dict(schema=SCHEMA, **fields)


def store_dir(checkout):
    return Path(checkout) / '.local/gate-receipts'


def write(receipt, logs=None, store=None):
    """Writes <logs>/gate-receipt.json and the store copy; returns the store path (None without a store)."""
    text = json.dumps(receipt, indent=1) + '\n'
    if logs is not None:
        Path(logs, LATEST).write_text(text)
    if store is None:
        return None
    folder = Path(store, receipt['profile'])
    folder.mkdir(parents=True, exist_ok=True)
    stem = receipt['started_at'].replace('-', '').replace(':', '') + '-' + receipt['source']['fingerprint'][:12]
    path, n = folder / f'{stem}.json', 1
    while path.exists():
        n += 1
        path = folder / f'{stem}-{n}.json'
    path.write_text(text)
    if not validate(receipt):
        shutil.copyfile(path, folder / LATEST)
    for old in runs(folder)[:-KEEP]:
        old.unlink()
    return path


def runs(folder):
    """The per-run receipts in a profile folder, oldest first (names start with the UTC time)."""
    return sorted(p for p in Path(folder).glob('*.json') if p.name != LATEST)


def find(store, profile, fingerprint=None):
    """(path, receipt) of the newest receipt of profile that validate() accepts, else None."""
    for path in reversed(runs(Path(store, profile))):
        receipt = json.loads(path.read_text())
        if not validate(receipt, fingerprint):
            return path, receipt
    return None


def validate(receipt, fingerprint=None):
    """Reasons the receipt cannot vouch for a build of these sources; empty when it can."""
    problems = []
    if receipt.get('schema') != SCHEMA:
        problems.append(f'schema is {receipt.get("schema")!r}, not {SCHEMA}')
    if receipt.get('result') != 'PASS':
        problems.append(f'result is {receipt.get("result")!r}')
    if receipt.get('partial') is not False:
        problems.append('partial run (--only)')
    source = receipt.get('source') or {}
    if source.get('changed_during_run') is not False:
        problems.append('sources changed during the run')
    if fingerprint is not None and source.get('fingerprint') != fingerprint:
        problems.append(f'fingerprint {source.get("fingerprint")} is not {fingerprint}')
    return problems


def _sha256(root, names):
    result = hashlib.sha256()
    for name in names:
        result.update(Path(root, name).read_bytes())
    return result.hexdigest()


def require(root, fingerprint, path=None):
    """(path, receipt) of a gate receipt that vouches for releasing root at fingerprint; raises ValueError otherwise.

    Without path, the newest valid commit receipt in the store is taken, else the newest release receipt.
    """
    run = f'run python3 -I tools/qa/gate.py --profile commit --checkout {root}'
    if path is None:
        found = [hit for profile in RELEASE_PROFILES if (hit := find(store_dir(root), profile, fingerprint))]
        if not found:
            raise ValueError(f'No PASS gate receipt of profile commit or release for source fingerprint {fingerprint} '
                             f'in {store_dir(root)}; {run}')
        path, receipt = found[0]
    else:
        receipt = json.loads(Path(path).read_text())
    problems = validate(receipt, fingerprint)
    if receipt.get('profile') not in RELEASE_PROFILES:
        problems.append(f'profile is {receipt.get("profile")!r}, not commit or release')
    suites = [name for name in SUITES if Path(root, name).exists()]
    if receipt.get('suites_sha256') != _sha256(root, suites):
        problems.append('the suites (' + ', '.join(suites) + ') differ from the ones the gate ran')
    if receipt.get('runner_sha256') != _sha256(root, RUNNER):
        problems.append('the gate runner (' + ', '.join(RUNNER) + ') differs from the one that ran')
    if problems:
        raise ValueError(f'gate receipt {path} cannot vouch for this release: {"; ".join(problems)}; {run}')
    return Path(path), receipt
