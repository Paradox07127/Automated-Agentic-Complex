"""Scoped text workspaces and independently checked artifacts for character runs.

No shell, arbitrary Python expressions, or model-selected filesystem roots. UI code
creates scopes; model tools only consume their IDs. All model-bound text uses egress.
"""
from __future__ import annotations

import csv
import hashlib
import io
import itertools
import json
import math
import os
from pathlib import Path, PurePosixPath
import secrets
import sqlite3
import threading
import time
from infra.store import open_private_db
from character_agent.services.extract import EXTRACTORS

TEXT_SUFFIXES = {
    '.md', '.txt', '.csv', '.tsv', '.json', '.jsonl',
    '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
    '.xml', '.html', '.htm', '.css', '.scss',
    '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
    '.swift', '.m', '.mm', '.c', '.h', '.cc', '.cpp', '.hpp',
    '.cs', '.rs', '.go', '.java', '.kt', '.rb', '.php', '.lua',
    '.sh', '.zsh', '.bash', '.ps1', '.sql', '.r', '.tex', '.rst', '.log',
    '.diff', '.patch',
}
READ_SUFFIXES = TEXT_SUFFIXES | set(EXTRACTORS) | {'.png', '.jpg', '.jpeg', '.gif', '.webp'}
WORKSPACE_SCHEMA = '''
    CREATE TABLE IF NOT EXISTS scopes(id TEXT PRIMARY KEY, data TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS expectations(run_id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cancelled_runs(run_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, run_id TEXT, scope_id TEXT, path TEXT,
      sha256 TEXT, version INTEGER, checks TEXT, validation TEXT, self_checked INTEGER DEFAULT 0,
      UNIQUE(run_id,path));
    CREATE TABLE IF NOT EXISTS effects(id TEXT PRIMARY KEY, run_id TEXT, digest TEXT, state TEXT, receipt TEXT);
'''
MAX_BYTES = 1024 * 1024
MAX_FILES = 256
MAX_TEXT = 32000


class WorkspaceError(ValueError):
    def __init__(self, code, message=None):
        self.code = code
        self.message = message or code
        super().__init__(self.message)


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False)


def _hash(value):
    return hashlib.sha256(value).hexdigest()


def _relative(value):
    if not isinstance(value, str) or not value or len(value) > 512 or '\\' in value or '\x00' in value:
        raise WorkspaceError('invalid_path')
    path = PurePosixPath(value)
    if path.is_absolute() or any(p in ('', '.', '..') for p in value.split('/')):
        raise WorkspaceError('invalid_path')
    if path.suffix.lower() not in TEXT_SUFFIXES:
        raise WorkspaceError('unsupported_format', 'Supported formats: UTF-8 ' + ', '.join(sorted(s[1:].upper() for s in TEXT_SUFFIXES)))
    return path.as_posix()


def _resolve(root, relative):
    """root joined with a POSIX relative path; refuses a location that resolves outside root."""
    base = Path(root).resolve()
    path = base.joinpath(*PurePosixPath(relative).parts).resolve()
    if not path.is_relative_to(base):
        raise WorkspaceError('path_not_allowed', 'The path resolves outside the selected directory')
    return path


def _create(path, data):
    """Writes data durably to a new file only the user can read; fails if path exists."""
    with open(path, 'xb', opener=lambda name, flags: os.open(name, flags, 0o600)) as stream:
        stream.write(data); stream.flush(); os.fsync(stream.fileno())


def _replace(source, target):
    # Windows refuses to replace a file another process holds open; such holds are usually brief.
    for attempt in range(10):
        try: return os.replace(source, target)
        except PermissionError:
            if attempt == 9: raise
            time.sleep(0.05)


def _read(root, relative):
    path = _resolve(root, relative)
    try:
        # Only regular files are opened: opening a FIFO would block.
        if not path.is_file():
            raise WorkspaceError('unsupported_file' if path.exists() else 'file_missing')
        with open(path, 'rb') as stream:
            data = stream.read(MAX_BYTES + 1)
    except FileNotFoundError as e:
        raise WorkspaceError('file_missing') from e
    except OSError as e:
        raise WorkspaceError('path_not_allowed') from e
    if len(data) > MAX_BYTES:
        raise WorkspaceError('file_too_large')
    try:
        text = data.decode('utf-8-sig')
    except UnicodeDecodeError as e:
        raise WorkspaceError('unsupported_encoding') from e
    if '\x00' in text:
        raise WorkspaceError('unsupported_encoding')
    return text, _hash(data), len(data)


VERSIONS = '.versions'


def _raw(path):
    with open(path, 'rb') as stream: data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES: raise WorkspaceError('file_too_large')
    return data


def _keep_version(path, version, digest):
    """Copies path, which must still hash to digest, to .versions/<name>.v<version> beside it, durably."""
    try:
        data = _raw(path)
        if _hash(data) != digest: raise WorkspaceError('artifact_changed')
        store = path.parent / VERSIONS
        store.mkdir(mode=0o700, exist_ok=True)
        if store.is_symlink(): raise WorkspaceError('path_not_allowed', 'The version store is a symlink')
        target, temp = store / f'{path.name}.v{version}', store / ('.endfield-' + secrets.token_hex(12))
        _create(temp, data)
        try:
            # link publishes atomically and never replaces a version already kept.
            try: os.link(temp, target)
            except FileExistsError:
                if _hash(_raw(target)) != digest: raise WorkspaceError('version_store_conflict') from None
        finally: os.unlink(temp)
    except OSError as error:
        raise WorkspaceError('path_not_allowed', 'The version store is unavailable') from error


def _schema(properties, required=()):
    return {'type': 'object', 'properties': properties, 'required': list(required), 'additionalProperties': False}


def _validate_arguments(value, schema):
    if 'enum' in schema and value not in schema['enum']:
        raise WorkspaceError('invalid_arguments')
    kind = schema.get('type')
    if kind == 'object':
        if not isinstance(value, dict) or set(value) - set(schema['properties']) or set(schema.get('required', [])) - set(value):
            raise WorkspaceError('invalid_arguments')
        for key, item in value.items(): _validate_arguments(item, schema['properties'][key])
    elif kind == 'array':
        if not isinstance(value, list) or not schema.get('minItems', 0) <= len(value) <= schema.get('maxItems', MAX_FILES):
            raise WorkspaceError('invalid_arguments')
        for item in value: _validate_arguments(item, schema['items'])
    elif kind == 'string':
        if not isinstance(value, str) or not schema.get('minLength', 0) <= len(value) <= schema.get('maxLength', MAX_BYTES):
            raise WorkspaceError('invalid_arguments')
    elif kind in ('integer', 'number'):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or kind == 'integer' and type(value) is not int:
            raise WorkspaceError('invalid_arguments')
        if value < schema.get('minimum', -math.inf) or value > schema.get('maximum', math.inf):
            raise WorkspaceError('invalid_arguments')
    elif kind == 'boolean':
        if type(value) is not bool:
            raise WorkspaceError('invalid_arguments')
    else:
        raise WorkspaceError('invalid_arguments')


CHECKS_SCHEMA = _schema({
    'required_sections': {'type': 'array', 'items': {'type': 'string'}, 'maxItems': 32},
    'required_columns': {'description':'CSV artifact only. Omit for Markdown or other formats.', 'type': 'array', 'items': {'type': 'string'}, 'maxItems': 64},
    'numeric_columns': {'description':'CSV artifact only. Omit for Markdown or other formats.', 'type': 'array', 'items': {'type': 'string'}, 'maxItems': 64},
    'row_count': {'description':'CSV artifact only. Omit for Markdown or other formats.', 'type': 'integer', 'minimum': 1, 'maximum': 10000},
    'required_inline_source_ids': {'description':'Require literal IDs inside output text ONLY when the user explicitly requests inline citations. Do not use for fixed numeric CSV without citation columns.', 'type':'array', 'items':{'type':'string'}, 'maxItems':MAX_FILES},
    'calculations': {'description':'CSV artifact only. Omit for Markdown or other formats.', 'type': 'array', 'maxItems': 16, 'items': _schema({
        'column': {'type': 'string'},
        'sum': {'type': 'array', 'minItems': 1, 'maxItems': 16, 'items': _schema({
            'column': {'type': 'string'}, 'multiply': {'type': 'number'}, 'constant': {'type': 'number'}
        })}, 'tolerance': {'type': 'number', 'minimum': 0, 'maximum': 0.01}
    }, ['column', 'sum'])},
})


def _check_spec(spec):
    """Bounded declarative assertions, deliberately no expression evaluator."""
    if not isinstance(spec, dict) or set(spec) - set(CHECKS_SCHEMA['properties']):
        raise WorkspaceError('invalid_checks')
    for key in ('required_sections', 'required_columns', 'numeric_columns', 'required_inline_source_ids'):
        if key in spec and (not isinstance(spec[key], list) or len(spec[key]) > MAX_FILES or
                            any(not isinstance(x, str) or not x or len(x) > 512 for x in spec[key])):
            raise WorkspaceError('invalid_checks')
    if 'row_count' in spec and (type(spec['row_count']) is not int or not 1 <= spec['row_count'] <= 10000):
        raise WorkspaceError('invalid_checks')
    calcs = spec.get('calculations', [])
    if not isinstance(calcs, list) or len(calcs) > 16:
        raise WorkspaceError('invalid_checks')
    for calc in calcs:
        if not isinstance(calc, dict) or set(calc) - {'column', 'sum', 'tolerance'} or not isinstance(calc.get('column'), str):
            raise WorkspaceError('invalid_checks')
        terms = calc.get('sum')
        if not isinstance(terms, list) or not 1 <= len(terms) <= 16:
            raise WorkspaceError('invalid_checks')
        tol = calc.get('tolerance', 0.000001)
        if isinstance(tol, bool) or not isinstance(tol, (int, float)) or not math.isfinite(tol) or not 0 <= tol <= 0.01:
            raise WorkspaceError('invalid_checks')
        for term in terms:
            if not isinstance(term, dict) or set(term) - {'column', 'multiply', 'constant'}:
                raise WorkspaceError('invalid_checks')
            if ('column' in term) == ('constant' in term):
                raise WorkspaceError('invalid_checks')
            if 'column' in term and (not isinstance(term['column'], str) or not term['column']):
                raise WorkspaceError('invalid_checks')
            for key in ('constant', 'multiply'):
                if key in term and (isinstance(term[key], bool) or not isinstance(term[key], (int, float)) or
                                    not math.isfinite(term[key]) or abs(term[key]) > 1e12):
                    raise WorkspaceError('invalid_checks')
    return spec


CSV_CHECKS = ('required_columns','numeric_columns','row_count','calculations')


def _requires_csv(spec):
    return any(bool(spec.get(key)) for key in CSV_CHECKS)


def _check_spec_for_path(path, spec):
    _check_spec(spec)
    if PurePosixPath(path).suffix.lower() != '.csv' and _requires_csv(spec):
        raise WorkspaceError('checks_require_csv_artifact')
    return spec


def _directories(scope):
    """Directory roots, then each dropped file's directory."""
    return [*(root['path'] for root in scope['roots']), *(f['directory'] for f in scope.get('files', []))]


class WorkspaceService:
    def __init__(self, state_dir, egress=None, clock=time.time):
        self.directory = Path(state_dir)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.egress, self.clock = egress, clock
        self.lock = threading.RLock()
        self.db = open_private_db(self.directory / 'character-workspace.sqlite', WORKSPACE_SCHEMA, row_factory=sqlite3.Row)

    def forget(self):
        """Remove private indexes and revoke scopes; user deliverable files remain user-owned."""
        with self.lock:
            for table in ("scopes", "expectations", "cancelled_runs", "artifacts", "effects"):
                self.db.execute("DELETE FROM " + table)
            self.db.commit()
            self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    def close(self):
        with self.lock:
            self.db.close()

    def _export(self, text):
        if self.egress is None:
            return text
        return self.egress(text) if callable(self.egress) else self.egress.observed(text)

    def create_scope(self, roots=(), output_root=None, *, files=(), ttl=86400):
        if not isinstance(roots, (list, tuple)) or len(roots) > 16 or not roots and not files:
            raise WorkspaceError('invalid_roots')
        if not isinstance(files, (list, tuple)) or len(files) > 16:
            raise WorkspaceError('invalid_files')
        if isinstance(ttl, bool) or not isinstance(ttl, (int, float)) or not 0 < ttl <= 7 * 86400:
            raise WorkspaceError('invalid_expiry')
        scope_id = secrets.token_hex(16)
        dropped, unsupported, folders = [], [], []
        for value in files:
            if not isinstance(value, str):
                raise WorkspaceError('invalid_file')
            p = Path(value)
            if not p.is_absolute():
                raise WorkspaceError('invalid_file')
            if p.is_dir():
                folders.append({'path': str(p.resolve())}); continue
            if p.suffix.lower() not in READ_SUFFIXES:
                unsupported.append({'path': value, 'reason': 'unsupported_type'}); continue
            if not p.is_file():
                raise WorkspaceError('invalid_file')
            p = p.resolve()
            # Reads open only this name in its directory, never a listing.
            dropped.append({'path': str(p), 'directory': str(p.parent)})
        if files and not dropped and not roots and not folders:
            raise WorkspaceError('no_supported_files')
        if output_root is None:
            output_root = self.directory / 'drop-outputs' / scope_id
        selected = []
        for value in roots:
            if not isinstance(value, (str, Path)):
                raise WorkspaceError('invalid_root')
            p = Path(value).expanduser()
            if not p.is_absolute() or not p.is_dir():
                raise WorkspaceError('invalid_root')
            selected.append({'path': str(p.resolve())})
        for folder in folders:
            if folder['path'] not in [root['path'] for root in selected]:
                selected.append(folder)
        if len(selected) > 16:
            raise WorkspaceError('invalid_roots')
        if not isinstance(output_root, (str, Path)):
            raise WorkspaceError('invalid_output_root')
        p = Path(output_root).expanduser()
        if not p.is_absolute():
            raise WorkspaceError('invalid_output_root')
        p.mkdir(parents=True, exist_ok=True, mode=0o700)
        output = {'path': str(p.resolve())}
        now = self.clock()
        data = {'scope_id': scope_id, 'revision': 1, 'kind': 'drop' if files else 'directory', 'roots': selected,
                'files': dropped, 'output': output, 'created_at': now, 'expires_at': now + ttl}
        with self.lock:
            self.db.execute('INSERT INTO scopes(id,data) VALUES (?,?)', (data['scope_id'], _json(data)))
            self.db.commit()
        return {**data, 'unsupported': unsupported}

    def get_scope(self, scope_id):
        with self.lock:
            row = self.db.execute('SELECT data,revoked FROM scopes WHERE id=?', (scope_id,)).fetchone()
            if not row: raise WorkspaceError('unknown_scope')
            value = json.loads(row['data']); value['revoked'] = bool(row['revoked'])
            return value

    def list_scopes(self):
        with self.lock:
            return [self.get_scope(r[0]) for r in self.db.execute('SELECT id FROM scopes ORDER BY rowid DESC LIMIT 50')]

    def revoke_scope(self, scope_id):
        with self.lock:
            self.get_scope(scope_id)
            self.db.execute('UPDATE scopes SET revoked=1 WHERE id=?', (scope_id,)); self.db.commit()
        return {'scope_id': scope_id, 'revoked': True}

    def validate_scope(self, scope_id):
        scope = self.get_scope(scope_id)
        if scope['revoked']: raise WorkspaceError('scope_revoked')
        if self.clock() >= scope['expires_at']: raise WorkspaceError('scope_expired')
        for directory in [*_directories(scope), scope['output']['path']]:
            if not Path(directory).is_dir(): raise WorkspaceError('scope_changed', 'Selected directory is unavailable')
        return scope

    def fingerprint(self, scope_id):
        scope = self.validate_scope(scope_id)
        return _hash(_json(scope).encode())

    def cancel_run(self, run_id):
        """Shares the atomic-commit lock; after this returns no new write commits."""
        with self.lock:
            self.db.execute('INSERT OR IGNORE INTO cancelled_runs VALUES (?)', (run_id,)); self.db.commit()

    def _current(self, run_id, is_current):
        if not is_current() or self.db.execute('SELECT 1 FROM cancelled_runs WHERE run_id=?', (run_id,)).fetchone():
            raise WorkspaceError('run_cancelled')

    def set_expectations(self, run_id, expected):
        """Trusted host contract; not registered as a model tool."""
        if not isinstance(expected, dict) or set(expected) != {'artifacts'} or not isinstance(expected['artifacts'], list):
            raise WorkspaceError('invalid_expectations')
        if not 1 <= len(expected['artifacts']) <= 32: raise WorkspaceError('invalid_expectations')
        for artifact in expected['artifacts']:
            if not isinstance(artifact, dict) or set(artifact) - {'path', 'checks'}: raise WorkspaceError('invalid_expectations')
            _relative(artifact.get('path')); _check_spec_for_path(artifact['path'],artifact.get('checks', {}))
        with self.lock:
            old = self.db.execute('SELECT data FROM expectations WHERE run_id=?', (run_id,)).fetchone()
            if old and old[0] != _json(expected): raise WorkspaceError('expectations_frozen')
            self.db.execute('INSERT OR IGNORE INTO expectations VALUES (?,?)', (run_id, _json(expected))); self.db.commit()

    def _expected(self, run_id, path):
        row = self.db.execute('SELECT data FROM expectations WHERE run_id=?', (run_id,)).fetchone()
        return [a.get('checks', {}) for a in json.loads(row[0])['artifacts'] if a['path'] == path] if row else []

    def _run_path(self, run_id, relative):
        return 'run-' + _hash(run_id.encode())[:24] + '/' + _relative(relative)

    def _artifact(self, run_id, path):
        return self.db.execute('SELECT * FROM artifacts WHERE run_id=? AND path=?', (run_id, path)).fetchone()

    def _public(self, row):
        if row is None: return None
        return {'artifact_id': row['id'], 'run_id': row['run_id'], 'scope_id': row['scope_id'], 'path': row['path'],
                'sha256': row['sha256'], 'version': row['version'],
                'validation': json.loads(row['validation']) if row['validation'] else None,
                'self_checked': bool(row['self_checked']),
                'absolute_path': str(Path(self.get_scope(row['scope_id'])['output']['path']) /
                                     self._run_path(row['run_id'], row['path']))}

    def write_artifact(self, scope_id, run_id, path, content, *, expected_version=None,
                       is_current=lambda: True, effect_id=None):
        path = _relative(path)
        if not isinstance(content, str) or len(content.encode()) > MAX_BYTES: raise WorkspaceError('invalid_content')
        data = content.encode(); digest = _hash(data)
        supplied_effect = effect_id
        with self.lock:
            self._current(run_id, is_current); scope = self.validate_scope(scope_id)
            operation = _hash(_json([run_id, scope_id, path, digest, expected_version]).encode())
            effect_id = _hash((run_id + ':' + supplied_effect).encode()) if supplied_effect else operation
            previous = self.db.execute('SELECT * FROM effects WHERE id=?', (effect_id,)).fetchone()
            if previous:
                if previous['digest'] != operation: raise WorkspaceError('effect_conflict')
                if previous['state'] == 'committed':
                    receipt = json.loads(previous['receipt'])
                    data_now = self.read_artifact(run_id, path, scope_id=scope_id)
                    if data_now['current_sha256'] != receipt['sha256']:
                        raise WorkspaceError('artifact_changed')
                    return receipt
                raise WorkspaceError('effect_unknown', 'Reconcile the prepared effect before retrying')
            old = self._artifact(run_id, path)
            if old and old['scope_id'] != scope_id: raise WorkspaceError('scope_conflict')
            output = scope['output']
            relative = self._run_path(run_id, path)
            target = _resolve(output['path'], relative)
            if old:
                _, current_hash, _ = _read(output['path'], relative)
                if current_hash != old['sha256']: raise WorkspaceError('artifact_changed')
                if digest == old['sha256']:
                    return {**self._public(old), 'effect_id': effect_id, 'unchanged': True}
                if type(expected_version) is not int or expected_version != old['version']:
                    raise WorkspaceError('version_conflict', 'Read the artifact and pass its current expected_version')
            elif expected_version not in (None, 0): raise WorkspaceError('version_conflict')
            version = old['version'] + 1 if old else 1
            receipt = {'artifact_id': old['id'] if old else secrets.token_hex(16), 'run_id': run_id,
                       'scope_id': scope_id, 'path': path, 'sha256': digest, 'version': version,
                       'validation': None, 'self_checked': False,
                       'effect_id': effect_id, 'absolute_path': str(Path(output['path']) / relative)}
            try: target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            except OSError as error: raise WorkspaceError('path_not_allowed', 'A path component is unavailable') from error
            temp = target.parent / ('.endfield-' + secrets.token_hex(12))
            committed = False
            try:
                if not old:
                    if os.path.lexists(target): raise WorkspaceError('output_exists', 'Refusing to overwrite an unowned file')
                else:
                    # Durable before the effect is prepared, so a crash at any later point keeps the old content.
                    _keep_version(target, old['version'], old['sha256'])
                _create(temp, data)
                self._current(run_id, is_current)
                self.validate_scope(scope_id)
                self.db.execute('INSERT INTO effects VALUES (?,?,?,?,?)',
                                (effect_id, run_id, operation, 'prepared', _json(receipt))); self.db.commit()
                if old:
                    _replace(temp, target); committed = True
                else:
                    # link is atomic and fails if an unowned target appeared after our check.
                    try:
                        os.link(temp, target)
                    except FileExistsError as error:
                        raise WorkspaceError('output_exists') from error
                    committed = True
                    os.unlink(temp)
                self._commit_receipt(receipt, old['checks'] if old else '{}')
                return receipt
            except Exception:
                if not committed:
                    try: os.unlink(temp)
                    except FileNotFoundError: pass
                raise

    def _commit_receipt(self, receipt, checks='{}'):
        self.db.execute('INSERT OR REPLACE INTO artifacts(id,run_id,scope_id,path,sha256,version,checks,validation,self_checked) '
                        'VALUES (?,?,?,?,?,?,?,?,?)',
                        (receipt['artifact_id'], receipt['run_id'], receipt['scope_id'], receipt['path'],
                         receipt['sha256'], receipt['version'], checks, None, 0))
        self.db.execute('UPDATE effects SET state=? WHERE id=?', ('committed', receipt['effect_id']))
        self.db.commit()

    def reconcile(self, run_id):
        """No automatic replay: confirm matching files or retain an unknown effect."""
        outcomes = []
        with self.lock:
            for row in self.db.execute('SELECT * FROM effects WHERE run_id=? AND state=?', (run_id, 'prepared')).fetchall():
                receipt = json.loads(row['receipt']); outcome = 'unknown'
                try:
                    out = self.validate_scope(receipt['scope_id'])['output']
                    _, digest, _ = _read(out['path'], self._run_path(run_id, receipt['path']))
                    if digest == receipt['sha256']:
                        old = self._artifact(run_id, receipt['path'])
                        self._commit_receipt(receipt, old['checks'] if old else '{}'); outcome = 'committed'
                except WorkspaceError: pass
                outcomes.append({'effect_id': row['id'], 'state': outcome})
        return outcomes

    def read_artifact(self, run_id, path, *, scope_id=None):
        path = _relative(path)
        with self.lock:
            row = self._artifact(run_id, path)
            if not row or scope_id is not None and row['scope_id'] != scope_id: raise WorkspaceError('unknown_artifact')
            out = self.validate_scope(row['scope_id'])['output']
            text, digest, _ = _read(out['path'], self._run_path(run_id, path))
            return {**self._public(row), 'text': self._export(text)[:MAX_TEXT], 'current_sha256': digest,
                    'changed': digest != row['sha256'], 'truncated': len(text) > MAX_TEXT}

    def revert_artifact(self, run_id, path, *, scope_id, expected_version):
        """Writes the kept previous version back as a new version."""
        path = _relative(path)
        with self.lock:
            row = self._artifact(run_id, path)
            if not row or row['scope_id'] != scope_id: raise WorkspaceError('unknown_artifact')
            if type(expected_version) is not int or expected_version != row['version']:
                raise WorkspaceError('version_conflict', 'Read the artifact and pass its current expected_version')
            previous = row['version'] - 1
            if previous < 1: raise WorkspaceError('no_previous_version')
            out = self.validate_scope(scope_id)['output']
            target = _resolve(out['path'], self._run_path(run_id, path))
            try: data = _raw(target.parent / VERSIONS / f'{target.name}.v{previous}')
            except FileNotFoundError as error: raise WorkspaceError('no_previous_version') from error
            except OSError as error: raise WorkspaceError('path_not_allowed') from error
            try: content = data.decode('utf-8')
            except UnicodeDecodeError as error: raise WorkspaceError('unsupported_encoding') from error
            self.write_artifact(scope_id, run_id, path, content, expected_version=expected_version)
            return self._public(self._artifact(run_id, path))

    def run_artifacts(self, run_id):
        with self.lock:
            return [self._public(row) for row in self.db.execute('SELECT * FROM artifacts WHERE run_id=? ORDER BY path', (run_id,))]

    def run_files(self, run_id):
        """Files the run wrote (artifacts, unsettled effects), by absolute path.
        added/removed: lines of a first write still as written; None where they are unknown."""
        files = {}
        with self.lock:
            scopes = {row['id']: json.loads(row['data']) for row in self.db.execute('SELECT id,data FROM scopes')}
            written = [(row['scope_id'], row['path'], row['version'], row['sha256'])
                       for row in self.db.execute('SELECT * FROM artifacts WHERE run_id=?', (run_id,))]
            for row in self.db.execute("SELECT receipt FROM effects WHERE run_id=? AND state!='committed'", (run_id,)):
                receipt = json.loads(row['receipt'])
                written.append((receipt['scope_id'], receipt['path'], receipt['version'], None))
            for scope_id, relative, version, digest in written:
                output = scopes[scope_id]['output']
                path = str(Path(output['path']) / self._run_path(run_id, relative))
                added = None
                if version == 1 and digest is not None:
                    try:
                        text, current, _ = _read(output['path'], self._run_path(run_id, relative))
                        added = len(text.splitlines()) if current == digest else None
                    except WorkspaceError:
                        pass
                files[path] = {'path': path, 'op': 'write' if version == 1 else 'modify',
                               'added': added, 'removed': None if added is None else 0}
        return sorted(files.values(), key=lambda item: item['path'])

    def verify_artifact(self, run_id, path, *, scope_id=None, checks=None, model_requested=True):
        path = _relative(path); _check_spec_for_path(path, {} if checks is None else checks)
        with self.lock:
            row = self._artifact(run_id, path)
            if not row or scope_id is not None and row['scope_id'] != scope_id: raise WorkspaceError('unknown_artifact')
            assertions = json.loads(row['checks'])
            if checks:
                # Once an assertion has been registered, later calls cannot silently weaken it.
                for key, value in checks.items():
                    if key in assertions and assertions[key] != value: raise WorkspaceError('checks_conflict')
                    assertions[key] = value
            scope_id = row['scope_id']; findings = []
            try:
                # Verify raw local bytes; egress applies only when returning text to the model.
                scope = self.validate_scope(scope_id)
                text, digest, _ = _read(scope['output']['path'], self._run_path(run_id, path))
                findings.append({'check': 'artifact_current', 'ok': digest == row['sha256']})
                findings.append({'check': 'nonempty', 'ok': bool(text.strip())})
                for spec in [assertions, *self._expected(run_id, path)]:
                    findings.extend(validate_text(path, text, spec))
            except WorkspaceError as error:
                findings.append({'check': error.code, 'ok': False})
            result = {'ok': bool(findings) and all(x['ok'] for x in findings), 'checks': findings,
                      'artifact_id': row['id'], 'version': row['version'], 'sha256': row['sha256'],
                      'semantic_review': 'not_established_by_structural_checks'}
            self.db.execute('UPDATE artifacts SET checks=?,validation=?,self_checked=? WHERE id=?',
                            (_json(assertions), _json(result), int(model_requested or row['self_checked']), row['id']))
            self.db.commit()
            return result

    def verify_run(self, run_id, scope_id=None):
        with self.lock:
            artifacts = self.run_artifacts(run_id); results = []; checks = []
            if not artifacts: checks.append({'check': 'artifacts_present', 'ok': False})
            unknown = self.db.execute('SELECT 1 FROM effects WHERE run_id=? AND state != ?', (run_id, 'committed')).fetchone()
            checks.append({'check': 'effects_reconciled', 'ok': not bool(unknown)})
            expected = self.db.execute('SELECT data FROM expectations WHERE run_id=?', (run_id,)).fetchone()
            if expected:
                actual = {a['path'] for a in artifacts}
                for a in json.loads(expected[0])['artifacts']:
                    checks.append({'check': 'required_artifact', 'path': a['path'], 'ok': a['path'] in actual})
            for artifact in artifacts:
                if scope_id is not None and artifact['scope_id'] != scope_id:
                    checks.append({'check': 'scope_matches', 'ok': False}); continue
                results.append(self.verify_artifact(run_id, artifact['path'], scope_id=scope_id, model_requested=False))
            checks.extend({'check': 'artifact_verified', 'artifact_id': r['artifact_id'], 'ok': r['ok']} for r in results)
            self_checked = bool(artifacts) and all(a['self_checked'] for a in artifacts)
            return {'ok': bool(artifacts) and bool(checks) and all(c['ok'] for c in checks),
                    'checks': checks, 'artifacts': self.run_artifacts(run_id), 'self_checked': self_checked,
                    'semantic_review': 'not_established_by_structural_checks'}

    def tool_definitions(self):
        text = {'type': 'string'}
        return [
            {'name': 'artifact_write', 'description': 'Write a UTF-8 text, data, or source-code deliverable in this run\'s output directory; it never overwrites the user\'s originals. '
                'Keep fixed CSV columns intact. '
                'Replacing an artifact needs its current version as expected_version (from artifact_read); a stale version is refused. '
                'Returns the path and version; run artifact_verify before calling it done.',
             'input_schema': _schema({'path': {**text, 'description': 'File path relative to the output directory, e.g. "summary.md".'},
                                     'content': {'type': 'string', 'maxLength': MAX_BYTES, 'description': 'The complete file content (replaces any previous version).'},
                                     'expected_version': {'type': 'integer', 'minimum': 0, 'description': 'Current version when replacing an existing artifact.'}}, ['path', 'content'])},
            {'name': 'artifact_read', 'description': 'Read back an artifact written in this run, with its content and current version, before checking or revising it; '
                'the version is what artifact_write needs as expected_version. It reads only this run\'s outputs, not the user\'s originals.',
             'input_schema': _schema({'path': text}, ['path'])},
            {'name': 'artifact_verify', 'description': 'Check a written artifact\'s actual bytes, structure and numeric assertions. '
                'checks are optional: required_sections lists headings that must exist, required_inline_source_ids checks literal inline IDs (only when the user asks for citations), '
                'and the CSV column, row and calculation checks apply only to .csv files. Returns ok with each check; fix reported failures and verify again. '
                'Structural checks do not prove semantic truth.',
             'input_schema': _schema({'path': text, 'checks': CHECKS_SCHEMA}, ['path'])},
        ]

    def call(self, name, args, *, scope_id, run_id, is_current=lambda: True, effect_id=None):
        definitions = {d['name']: d for d in self.tool_definitions()}
        if name not in definitions: raise WorkspaceError('unknown_tool')
        _validate_arguments(args, definitions[name]['input_schema'])
        with self.lock:
            self._current(run_id, is_current); self.validate_scope(scope_id)
            if name == 'artifact_write': return self.write_artifact(scope_id, run_id, is_current=is_current, effect_id=effect_id, **args)
            if name == 'artifact_read': return self.read_artifact(run_id, scope_id=scope_id, **args)
            return self.verify_artifact(run_id, scope_id=scope_id, **args)


def validate_text(path, text, spec):
    """Pure, bounded structural/data checks. No LLM, subprocess or eval."""
    _check_spec(spec); out = []; suffix = PurePosixPath(path).suffix.lower()
    for section in spec.get('required_sections', []):
        out.append({'check': 'required_section', 'section': section, 'ok': section in text})
    # Only an explicit content requirement demands inline IDs.
    for ref in dict.fromkeys(spec.get('required_inline_source_ids', [])):
        out.append({'check': 'source_reference', 'source_id': ref, 'ok': ref in text})
    if suffix == '.json':
        try: json.loads(text, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value))); valid = True
        except (ValueError, TypeError, RecursionError): valid = False
        out.append({'check': 'json_parse', 'ok': valid})
    if suffix != '.csv':
        if _requires_csv(spec):
            out.append({'check': 'csv_required', 'ok': False})
        return out
    try:
        rows = list(itertools.islice(csv.reader(io.StringIO(text), strict=True), 10002))
        header = rows[0] if rows else []; body = rows[1:]
        valid = bool(header) and bool(body) and len(body) <= 10000 and len(set(header)) == len(header) and all(header) and all(len(row) == len(header) for row in body)
    except csv.Error:
        valid = False; header = []; body = []
    out.append({'check': 'csv_shape', 'ok': valid})
    if not valid: return out
    records = [dict(zip(header, row)) for row in body]
    for column in spec.get('required_columns', []):
        out.append({'check': 'required_column', 'column': column, 'ok': column in header})
    if 'row_count' in spec: out.append({'check': 'row_count', 'expected': spec['row_count'], 'actual': len(body), 'ok': len(body) == spec['row_count']})
    def number(value):
        n = float(value)
        if not math.isfinite(n) or abs(n) > 1e15: raise ValueError('invalid number')
        return n
    for index, row in enumerate(records, 1):
        for column in spec.get('numeric_columns', []):
            try: number(row[column]); valid = True
            except (ValueError, KeyError): valid = False
            out.append({'check': 'numeric_column', 'row': index, 'column': column, 'ok': valid})
        for calc in spec.get('calculations', []):
            try:
                expected = sum((number(row[t['column']]) if 'column' in t else t['constant']) * t.get('multiply', 1) for t in calc['sum'])
                actual = number(row[calc['column']]); valid = math.isfinite(expected) and abs(actual - expected) <= calc.get('tolerance', 0.000001)
            except (KeyError, ValueError, TypeError): expected = None; actual = None; valid = False
            out.append({'check': 'calculation', 'row': index, 'column': calc['column'], 'expected': expected, 'actual': actual, 'ok': valid})
    return out
