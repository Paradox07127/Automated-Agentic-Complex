import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { CSP } from '../src/common/ui.ts';
import { uiServer } from '../src/main/ui-scheme.ts';

// <tmp>/dist is the served root; <tmp>/secret.txt sits beside it.
const tmp = mkdtempSync(join(tmpdir(), 'ui-scheme-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const root = join(tmp, 'dist');
mkdirSync(join(root, 'assets'), { recursive: true });
mkdirSync(join(root, 'characters/si'), { recursive: true });
writeFileSync(join(root, 'main.html'), '<!doctype html>');
writeFileSync(join(root, 'assets/app.js'), 'export {}');
writeFileSync(join(root, 'assets/notes.unknownext'), 'x');
writeFileSync(join(root, 'characters/si/head.png'), 'png');
writeFileSync(join(tmp, 'secret.txt'), 'secret');
writeFileSync(join(tmp, 'secret.js'), 'secret');
symlinkSync(join(tmp, 'secret.js'), join(root, 'assets/escape.js'));
const serve = uiServer(root);

test('serves files under the root with their type and the CSP', () => {
  const r = serve('agentic-complex-ui://app/main.html');
  assert.equal(r.status, 200);
  assert.equal(r.headers['Content-Type'], 'text/html; charset=utf-8');
  assert.equal(r.headers['Content-Security-Policy'], CSP);
  assert.equal(r.body.toString(), '<!doctype html>');
  const js = serve('agentic-complex-ui://app/./assets/app.js?v=1#x');
  assert.equal(js.status, 200);
  assert.equal(js.headers['Content-Type'], 'text/javascript; charset=utf-8');
  assert.equal(js.headers['Content-Length'], '9');
});

test('refuses paths that leave the root, odd bytes, other hosts and unknown types with a 404 that keeps the CSP', () => {
  for (const url of [
    'agentic-complex-ui://app/..%2Fsecret.txt',
    'agentic-complex-ui://app/assets%2F..%2F..%2Fsecret.js',
    'agentic-complex-ui://app/assets/..%2F..%2Fsecret.js',
    'agentic-complex-ui://app/..%5Csecret.js',
    'agentic-complex-ui://app/assets/app.js%00.html',
    'agentic-complex-ui://app/%E0%A4%A',
    'agentic-complex-ui://app/assets/escape.js',
    'agentic-complex-ui://app/assets/notes.unknownext',
    'agentic-complex-ui://app/characters/si/head.png',
    'agentic-complex-ui://app/assets',
    'agentic-complex-ui://app/',
    'agentic-complex-ui://app/missing.js',
    'agentic-complex-ui://other/main.html',
    'file:///etc/passwd',
    'not a url',
  ]) {
    const r = serve(url);
    assert.equal(r.status, 404, url);
    assert.equal(r.body.length, 0, url);
    assert.equal(r.headers['Content-Security-Policy'], CSP, url);
    assert.equal(r.headers['Content-Type'], 'text/plain; charset=utf-8', url);
  }
});

test('art/ comes from the UI art directory, as ui/art of the web-ui component; without one it is a 404', () => {
  const art = join(tmp, 'ui-art');
  mkdirSync(join(art, 'brand'), { recursive: true });
  writeFileSync(join(art, 'brand/emblem.png'), 'emblem');
  writeFileSync(join(tmp, 'outside.png'), 'outside');
  const withArt = uiServer(root, art);
  const r = withArt('agentic-complex-ui://app/art/brand/emblem.png');
  assert.equal(r.status, 200);
  assert.equal(r.headers['Content-Type'], 'image/png');
  assert.equal(r.headers['Content-Security-Policy'], CSP);
  assert.equal(r.body.toString(), 'emblem');
  assert.equal(withArt('agentic-complex-ui://app/art/..%2F..%2Foutside.png').status, 404);
  assert.equal(withArt('agentic-complex-ui://app/art/brand/missing.png').status, 404);
  assert.equal(withArt('agentic-complex-ui://app/main.html').status, 200);
  for (const s of [serve, uiServer(root, join(tmp, 'no-such-art')), uiServer(root, null)]) {
    assert.equal(s('agentic-complex-ui://app/art/brand/emblem.png').status, 404);
  }
});

test('the CSP allows scripts, styles and fonts only from the UI scheme, and no network, frames or forms', () => {
  // web/vite.config.ts builds for this policy: no inline script, no asset inlined as data:.
  assert.equal(CSP, "default-src 'none'; script-src agentic-complex-ui:; style-src agentic-complex-ui:; "
    + "img-src agentic-complex-ui: data: blob:; font-src agentic-complex-ui:; connect-src 'none'; frame-src 'none'; "
    + "object-src 'none'; base-uri 'none'; form-action 'none'");
});

test('a file that cannot be read once found answers the 404 with the CSP',
  { skip: process.platform === 'win32' ? 'POSIX file modes' : false }, () => {
    const gone = uiServer(root, null, { file: () => join(tmp, 'no-such-head.png'), image: () => { throw new Error('unused'); } });
    const head = gone('agentic-complex-ui://app/characters/cedar/head.png');
    assert.deepEqual([head.status, head.headers['Content-Security-Policy']], [404, CSP]);
    if (process.getuid?.() === 0) return;
    writeFileSync(join(root, 'assets/locked.js'), 'x');
    chmodSync(join(root, 'assets/locked.js'), 0o000);
    try {
      const locked = serve('agentic-complex-ui://app/assets/locked.js');
      assert.deepEqual([locked.status, locked.headers['Content-Security-Policy']], [404, CSP]);
    } finally {
      chmodSync(join(root, 'assets/locked.js'), 0o600);
    }
  });
