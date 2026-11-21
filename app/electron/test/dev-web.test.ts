// Pages from the vite dev server (src/common/dev-web.ts, src/main/dev-web.ts): only a repo launch takes `--dev-web-server`,
// only its pages get the loosened CSP, and navigation stays on the scheme either way.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { WebContents } from 'electron';
import { devCsp, devTarget, devWebServer } from '../src/common/dev-web.ts';
import { CSP, ORIGIN } from '../src/common/ui.ts';
import { navigationAllowed } from '../src/common/web-guard.ts';
import { devWebResponse } from '../src/main/dev-web.ts';
import { guardWebContents } from '../src/main/web-guard.ts';

const VITE = 'http://127.0.0.1:5190';

test('only a repo launch takes the dev server, and only a loopback http origin', () => {
  const argv = ['electron', '.', '--config', '/tmp/c.json', '--dev-web-server', VITE];
  assert.equal(devWebServer(argv, false), VITE);
  assert.equal(devWebServer(argv, true), null);
  assert.equal(devWebServer(['electron', '.', '--dev-web-server', 'http://localhost:5190/'], false), 'http://localhost:5190');
  for (const url of ['https://127.0.0.1:5190', 'http://example.com:5190', 'http://127.0.0.1', 'http://127.0.0.1:5190/main.html',
    'http://127.0.0.1:5190/?x=1', 'not a url']) {
    assert.equal(devWebServer(['electron', '.', '--dev-web-server', url], false), null, url);
  }
  assert.equal(devWebServer(['electron', '.', '--dev-web-server'], false), null);
  assert.equal(devWebServer(['electron', '.'], false), null);
});

test('page requests go to vite; art, character images and other schemes do not', () => {
  assert.equal(devTarget(VITE, `${ORIGIN}/main.html#/settings`), `${VITE}/main.html`);
  assert.equal(devTarget(VITE, `${ORIGIN}/src/main.tsx?t=1`), `${VITE}/src/main.tsx?t=1`);
  assert.equal(devTarget(VITE, `${ORIGIN}/@vite/client`), `${VITE}/@vite/client`);
  assert.equal(devTarget(VITE, `${ORIGIN}/art/logo.png`), null);
  assert.equal(devTarget(VITE, `${ORIGIN}/characters/aster/head.png`), null);
  assert.equal(devTarget(VITE, `${ORIGIN}/artwork.js`), `${VITE}/artwork.js`);
  assert.equal(devTarget(VITE, 'https://example.com/main.html'), null);
  assert.equal(devTarget(VITE, 'agentic-complex-ui://other/main.html'), null);
});

test('the dev CSP adds inline script and style and the HMR socket; the app CSP has none of them', () => {
  const dev = devCsp(VITE);
  assert.match(dev, /script-src agentic-complex-ui: 'unsafe-inline';/);
  assert.match(dev, /style-src agentic-complex-ui: 'unsafe-inline';/);
  assert.match(dev, /connect-src ws:\/\/127\.0\.0\.1:5190 http:\/\/127\.0\.0\.1:5190;/);
  assert.match(dev, /default-src 'none'/);
  assert.doesNotMatch(CSP, /unsafe-inline|ws:|http:/);
  assert.match(CSP, /connect-src 'none'/);
});

test('answers from vite carry its type and body under the dev CSP, with the page document logged', async () => {
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(req.url === '/missing.js' ? 404 : 200, { 'Content-Type': req.url === '/main.html' ? 'text/html' : 'text/javascript' });
    res.end(`served ${req.url}`);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const vite = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const lines: string[] = [];
  try {
    const page = await devWebResponse(vite, new Request(`${ORIGIN}/main.html#/home`, { headers: { Accept: 'text/html' } }), fetch,
      (l) => lines.push(l));
    assert.equal(page!.status, 200);
    assert.equal(page!.headers.get('content-type'), 'text/html');
    assert.equal(page!.headers.get('content-security-policy'), devCsp(vite));
    assert.equal(await page!.text(), 'served /main.html');
    assert.equal(seen[0]!.accept, 'text/html');
    const css = await devWebResponse(vite, new Request(`${ORIGIN}/src/a.css`, { headers: { Accept: 'text/css', Cookie: 'x' } }), fetch,
      (l) => lines.push(l));
    assert.equal(await css!.text(), 'served /src/a.css');
    assert.equal(seen[1]!.accept, 'text/css');
    assert.equal(seen[1]!.cookie, undefined);
    assert.equal((await devWebResponse(vite, new Request(`${ORIGIN}/missing.js`), fetch, (l) => lines.push(l)))!.status, 404);
    assert.equal(await devWebResponse(vite, new Request(`${ORIGIN}/art/a.png`), fetch, (l) => lines.push(l)), null);
    assert.deepEqual(lines, [`DEV_WEB /main.html <- ${vite}/main.html 200`]);
  } finally {
    await new Promise((done) => server.close(done));
  }
  const down = await devWebResponse(vite, new Request(`${ORIGIN}/main.html`), fetch, (l) => lines.push(l));
  assert.equal(down!.status, 502);
  assert.equal(down!.headers.get('content-security-policy'), devCsp(vite));
  assert.match(lines.at(-1)!, /^DEV_WEB .*\/main\.html unreachable: /);
});

test('navigation stays on the scheme with the dev server; only the vite client lines go to the dev log', () => {
  assert.equal(navigationAllowed(`${VITE}/main.html`, ORIGIN), false);
  assert.equal(navigationAllowed('ws://127.0.0.1:5190/', ORIGIN), false);
  const dir = mkdtempSync(join(tmpdir(), 'dev-web-'));
  try {
    for (const dev of [false, true]) {
      const contents = Object.assign(new EventEmitter(), { getURL: () => `${ORIGIN}/main.html`, setWindowOpenHandler() {} });
      const lines: string[] = [];
      guardWebContents(contents as unknown as WebContents, 'stack', { origin: ORIGIN, openExternal() {}, popUpMenu() {},
        logsDir: join(dir, 'logs'), ...(dev && { devLog: (l: string) => lines.push(l) }) });
      for (const message of ['[vite] connected.', 'other']) contents.emit('console-message', { level: 'debug', message, sourceId: '', lineNumber: 0 });
      let prevented = false;
      contents.emit('will-frame-navigate', { url: `${VITE}/main.html`, isMainFrame: true, preventDefault: () => { prevented = true; } });
      assert.equal(prevented, true);
      assert.deepEqual(lines, dev ? ['DEV_WEB stack [vite] connected.'] : []);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
