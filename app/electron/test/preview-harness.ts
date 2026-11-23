// Electron main process for preview-window.test.ts, bundled by it: a page with the real preload calls avatar.preview.* through the
// real bridge, previewOps, PreviewController, WindowPreview and the addon, against <host>, a child this process launches with
// `--agentic-complex-preview-rendezvous` as the shell launches the renderer.
// Writes `<out dir>/e2c-<mode>-result.json` and a screenshot, then quits (stdout to a pipe would be cut off by the exit).
// argv after the script: <addon> <preload> <out dir> <host> stub | real <catalog> <character> [<action>]
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, protocol } from 'electron';
import { boot, handle } from '../src/common/bridge.ts';
import { ORIGIN, SCHEME } from '../src/common/ui.ts';
import type { OpsContext } from '../src/main/ops/context.ts';
import { previewOps } from '../src/main/ops/preview.ts';
import { PreviewController } from '../src/main/preview/controller.ts';
import { loadMotionLibrary, type MotionLibrary } from '../src/main/preview/library.ts';
import type { PreviewSurface } from '../src/main/preview/session.ts';
import { type PreviewAddon, WindowPreview } from '../src/main/preview/window.ts';

const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('.mjs')) + 1);
const [addonPath, preloadPath, outDir, hostPath, mode, catalog, character, action] = args as
  [string, string, string, string, string, string?, string?, string?];
const real = mode === 'real';
const started = performance.now();
const events: string[] = [];
const ms = () => Math.round(performance.now() - started);
const result: Record<string, unknown> = { mode, events };
const finish = (extra: Record<string, unknown>) => {
  host.kill();
  writeFileSync(join(outDir, `e2c-${mode}-result.json`), JSON.stringify({ ...result, ...extra }, null, 2));
  app.exit(0);
};
setTimeout(() => finish({ error: 'harness timeout' }), 90_000);

const raw = createRequire(import.meta.url)(addonPath) as PreviewAddon;
const host = spawn(hostPath, ['--agentic-complex-preview-rendezvous', raw.rendezvous()], { stdio: ['ignore', 'ignore', 'inherit'] });
host.on('exit', (code, signal) => events.push(`${ms()} host exit ${code ?? signal}`));
let frames = 0;
const sizes = new Set<string>();
/** The addon, with what it delivers counted. */
const addon: PreviewAddon = {
  ...raw,
  rendezvous: () => raw.rendezvous(),
  mainBundle: () => raw.mainBundle(),
  setPreventsActivation: (h) => raw.setPreventsActivation(h),
  send: (json) => raw.send(json),
  stop: () => raw.stop(),
  start: (service, onMessage) => {
    events.push(`${ms()} start ${service}`);
    raw.start(service, (json: string, surface: PreviewSurface | null, sequence: number) => {
      const event = (JSON.parse(json) as { event?: string }).event;
      if (event === 'frame' && surface) {
        frames += 1;
        sizes.add(`${surface.width}x${surface.height} format=${surface.pixelFormat.toString(16)} bytesPerRow=${surface.bytesPerRow}`);
        if (frames === 1) events.push(`${ms()} first frame sequence=${sequence} ${json}`);
      } else if (event !== 'stats' || frames < 200) events.push(`${ms()} ${json}`);
      onMessage(json, surface, sequence);
    });
  },
};

const stub: MotionLibrary = { bundle: '/stub/bundle.json', sha256: '0'.repeat(64), character: 'stub', clips: [{ clip: 'stub_wave', actionID: 'wave' }] };
let win: BrowserWindow | null = null;
const preview = new PreviewController({
  view: new WindowPreview({ addon, window: () => win, log: (line) => events.push(`${ms()} log ${line}`) }),
  avatar: () => ({ character: real ? character! : 'stub', appearance: null }),
  library: async (id) => (real ? loadMotionLibrary(catalog!, id) : stub),
});
const ops = new Map(Object.entries(previewOps({ preview } as unknown as OpsContext)));

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const PAGE = `<!doctype html><meta charset="utf-8"><title>E2C preview</title>
<body style="margin:0;background:#20242c;font:13px system-ui;color:#ccc"><div id="stage" style="position:absolute;left:40px;top:40px;width:256px;height:${real ? 307 : 256}px;outline:1px dashed #666"></div>
<p style="position:absolute;left:40px;top:${real ? 360 : 310}px">E2C ${mode}</p></body>`;

// Closing the window must not quit before the closed connection is seen through.
app.on('window-all-closed', () => {});
ipcMain.on('bridge:boot', (e) => { e.returnValue = boot('main'); });
ipcMain.handle('bridge:invoke', (e, message: unknown) =>
  handle('main', { mainFrame: e.senderFrame === e.sender.mainFrame, origin: e.senderFrame?.origin ?? '' }, message, ops));

const js = <T>(code: string) => win!.webContents.executeJavaScript(code) as Promise<T>;
const pause = (t: number) => new Promise((r) => setTimeout(r, t));

void app.whenReady().then(async () => {
  protocol.handle(SCHEME, () => new Response(PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
  win = new BrowserWindow({ x: 60, y: 60, width: 360, height: real ? 420 : 360, show: false, focusable: false, resizable: false,
    webPreferences: { preload: preloadPath, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (e) => events.push(`${ms()} page ${e.message}`));
  await win.loadURL(`${ORIGIN}/main.html`);
  win.showInactive();
  result.preventsActivation = raw.setPreventsActivation(win.getNativeWindowHandle());
  const rect = await js<{ x: number; y: number; w: number; h: number }>(
    `(() => { const r = document.getElementById('stage').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  const at = { ...rect, ...(action ? { action } : {}) };
  const shown = await js<unknown>(`window.agenticComplex.avatar.preview.show(${JSON.stringify(at)}).then((v) => ({ ok: v }), (e) => ({ error: e.code + ': ' + e.detail }))`);
  events.push(`${ms()} show -> ${JSON.stringify(shown)}`);
  result.show = shown;
  await pause(real ? 2500 : 600);
  if (real) {
    const library = loadMotionLibrary(catalog!, character!)!;
    const clips = library.clips.filter((c) => c.actionID !== null).slice(0, 2).map((c) => c.clip);
    result.sequence = await js<unknown>(`window.agenticComplex.avatar.preview.sequence(${JSON.stringify({ clips, blend_s: [0.25] })}).then((v) => ({ ok: v, clips: ${JSON.stringify(clips)} }), (e) => ({ error: e.code + ': ' + e.detail }))`);
    events.push(`${ms()} sequence -> ${JSON.stringify(result.sequence)}`);
    await pause(1500);
  }
  result.dpr = await js<number>('devicePixelRatio');
  // Pixels the page drew: the canvas's own backing store, read in the page's world.
  result.canvas = await js<unknown>(`(() => {
    const c = document.getElementById('agentic-complex-preview');
    if (!c) return null;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, dpr = devicePixelRatio;
    let opaque = 0, minX = c.width, minY = c.height, maxX = -1, maxY = -1;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      if (d[(y * c.width + x) * 4 + 3] === 0) continue;
      opaque++; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    const at = (x, y) => { const i = (y * c.width + x) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };
    const points = [[0, 0], [255, 0], [0, 255], [128, 64], [200, 200]].map(([x, y]) => [x, y, ...at(Math.floor(x * dpr + dpr / 2), Math.floor(y * dpr + dpr / 2))]);
    return { width: c.width, height: c.height, hidden: c.hidden, opaque, bounds: [minX, minY, maxX, maxY], points,
      center: at(c.width >> 1, c.height >> 1) };
  })()`);
  const shot = join(outDir, `e2c-${mode}-preview.png`);
  writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
  result.screenshot = shot;
  result.frames = frames;
  result.sizes = [...sizes];
  await js('window.agenticComplex.avatar.preview.hide()');
  win.close();
  await pause(500);
  finish({});
});
