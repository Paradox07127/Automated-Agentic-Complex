// 设置 › 显示 › 外观: its config.json rows, and the shell putting them on the main window (theme, glass, page, zoom).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import routes from '../../../protocol/ui-bridge/routes.json' with { type: 'json' };
import {
  APPEARANCE_CHANNEL, appearanceOf, applyAppearance, applyPage, glassSupported, mainWindowGround, type PageAppearance,
} from '../src/common/appearance.ts';
import { handle } from '../src/common/bridge.ts';
import { silentSource } from '../src/common/feed.ts';
import { PageSession } from '../src/common/page.ts';
import { current, planSave, rowById, schema, snapshot } from '../src/common/settings.ts';
import { ORIGIN } from '../src/common/ui.ts';
import { type OpsContext, registry } from '../src/main/ops/index.ts';

test('外观 has one config.json key per row, in 显示, taken at once', () => {
  const rows: [string, string, [string, string][], string][] = [
    ['appTheme', 'app_theme', [['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']], 'system'],
    ['winBg', 'window_background', [['glass', '磨砂'], ['opaque', '不透明']], 'glass'],
    ['glassAlpha', 'window_glass_alpha', [['35', '轻度'], ['55', '适中'], ['75', '较强']], '55'],
    ['reduceMotion', 'reduce_motion', [['system', '跟随系统'], ['on', '开启']], 'system'],
    ['uiZoom', 'ui_zoom', [['90', '90 %'], ['100', '100 %'], ['110', '110 %'], ['125', '125 %']], '100'],
  ];
  for (const [id, key, options, value] of rows) {
    const row = rowById(id);
    assert.ok(row, id);
    assert.deepEqual([row.group, row.item.key, row.item.restart], ['display', key, 'none'], id);
    assert.deepEqual(row.item.control, { kind: 'choice', options, value }, id);
  }
});

test('磨砂强度 and 界面大小 are stored as numbers and read back as their choice', () => {
  assert.equal(current({ window_glass_alpha: 75, ui_zoom: 125 }, null).values.window_glass_alpha, '75');
  assert.equal(current({ window_glass_alpha: 75, ui_zoom: 125 }, null).values.ui_zoom, '125');
  assert.equal(current({ ui_zoom: 130 }, null).values.ui_zoom, '100', 'not a choice');
  const plan = planSave({}, null, { ui_zoom: '110', window_glass_alpha: '35' });
  assert.deepEqual(plan.write, { ui_zoom: 110, window_glass_alpha: 35 });
});

test('a save that changes an 外观 row has the appearance effect, and only then', () => {
  for (const [key, value] of [['app_theme', 'dark'], ['window_background', 'opaque'], ['window_glass_alpha', '75'],
    ['reduce_motion', 'on'], ['ui_zoom', '90']]) {
    const plan = planSave({}, null, { [key!]: value! });
    assert.deepEqual(plan.effects, [{ kind: 'appearance' }], key);
    assert.equal(plan.restart, 'none', key);
  }
  assert.deepEqual(planSave({}, null, { mute: true }).effects.filter((e) => e.kind === 'appearance'), []);
  assert.deepEqual(planSave({}, null, { app_theme: 'system' }).effects, [], 'unchanged');
});

test('glass needs macOS or Windows 11 22H2 (build 22621) and up', () => {
  assert.equal(glassSupported('mac', '25.2.0'), true);
  assert.equal(glassSupported('windows', '10.0.22621'), true);
  assert.equal(glassSupported('windows', '10.0.26100'), true);
  assert.equal(glassSupported('windows', '10.0.22000'), false, 'Windows 11 21H2');
  assert.equal(glassSupported('windows', '10.0.19045'), false, 'Windows 10');
  assert.equal(glassSupported('windows', '6.1.7601'), false);
});

test('without glass, 窗口背景 defaults to and reads 不透明, with the reason as its status', () => {
  const winBg = (rows: Record<string, unknown>[]) => rows.find((r) => r.id === 'winBg');
  assert.equal(winBg(schema('windows'))?.default, 'glass');
  assert.equal(winBg(schema('windows', false))?.default, 'opaque');
  const snap = snapshot({ window_background: 'glass' }, null, true, 'windows', {}, false) as { saved: Record<string, unknown>; statuses: Record<string, string> };
  assert.equal(snap.saved.winBg, 'opaque');
  assert.match(snap.statuses.winBg!, /Windows 11 22H2/);
  const mac = snapshot({}, null, true, 'mac') as { saved: Record<string, unknown>; statuses: Record<string, string> };
  assert.equal(mac.saved.winBg, 'glass');
  assert.equal(mac.statuses.winBg, undefined);
});

test('the appearance of the saved rows: no glass where the system allows none (降低透明度, old Windows)', () => {
  const values = current({ app_theme: 'dark', window_glass_alpha: 35, reduce_motion: 'on', ui_zoom: 125 }, null).values;
  assert.deepEqual(appearanceOf(values, true), { theme: 'dark', glass: true, glassAlpha: 35, reduceMotion: true, zoom: 1.25 });
  assert.equal(appearanceOf(values, false).glass, false);
  assert.equal(appearanceOf(current({ window_background: 'opaque' }, null).values, true).glass, false);
  assert.deepEqual(appearanceOf(current({}, null).values, true), { theme: 'system', glass: true, glassAlpha: 55, reduceMotion: false, zoom: 1 });
});

test('the main window starts with under-window vibrancy on macOS and acrylic on Windows when glass, else neither', () => {
  assert.deepEqual(mainWindowGround('mac', true), { vibrancy: 'under-window', visualEffectState: 'followWindow', backgroundColor: '#00000000' });
  assert.deepEqual(mainWindowGround('mac', false), { backgroundColor: '#00000000' });
  assert.deepEqual(mainWindowGround('windows', true), { backgroundMaterial: 'acrylic' });
  assert.deepEqual(mainWindowGround('windows', false), {});
});

function targets() {
  const calls: string[] = [];
  const theme = { themeSource: 'system' as 'system' | 'light' | 'dark' };
  const window = {
    setVibrancy: (v: 'under-window' | null) => calls.push(`vibrancy ${v}`),
    setBackgroundMaterial: (m: 'acrylic' | 'none') => calls.push(`material ${m}`),
    webContents: {
      setZoomMode: (m: 'isolated') => calls.push(`zoomMode ${m}`),
      setZoomFactor: (f: number) => calls.push(`zoom ${f}`),
      send: (channel: string, page: PageAppearance) => calls.push(`send ${channel} ${JSON.stringify(page)}`),
    },
  };
  return { calls, theme, window };
}

test('the shell sets the native theme, the window ground, the page and its own zoom on macOS', () => {
  const t = targets();
  applyAppearance({ theme: 'light', glass: true, glassAlpha: 75, reduceMotion: true, zoom: 1.1 }, 'mac', t);
  assert.equal(t.theme.themeSource, 'light');
  assert.deepEqual(t.calls, ['vibrancy under-window', 'zoomMode isolated', 'zoom 1.1',
    `send ${APPEARANCE_CHANNEL} {"glass":true,"glassAlpha":75,"reduceMotion":true}`]);
  t.calls.length = 0;
  applyAppearance({ theme: 'system', glass: false, glassAlpha: 55, reduceMotion: false, zoom: 1 }, 'mac', t);
  assert.equal(t.theme.themeSource, 'system');
  assert.deepEqual(t.calls.slice(0, 1), ['vibrancy null']);
  assert.match(t.calls.at(-1)!, /"glass":false/);
});

test('on Windows the ground is a background material, and no vibrancy is set', () => {
  const t = targets();
  applyAppearance({ theme: 'dark', glass: true, glassAlpha: 55, reduceMotion: false, zoom: 0.9 }, 'windows', t);
  assert.deepEqual(t.calls.slice(0, 3), ['material acrylic', 'zoomMode isolated', 'zoom 0.9']);
  t.calls.length = 0;
  applyAppearance({ theme: 'dark', glass: false, glassAlpha: 55, reduceMotion: false, zoom: 1 }, 'windows', t);
  assert.equal(t.calls[0], 'material none');
  assert.ok(!t.calls.some((c) => c.startsWith('vibrancy')));
});

test('the theme is set only when it changes (setting it fires nativeTheme updated, which applies again)', () => {
  let sets = 0;
  let source: 'system' | 'light' | 'dark' = 'dark';
  const theme = { get themeSource() { return source; }, set themeSource(v) { sets += 1; source = v; } };
  applyAppearance({ theme: 'dark', glass: false, glassAlpha: 55, reduceMotion: false, zoom: 1 }, 'mac', { theme, window: null });
  assert.equal(sets, 0);
  applyAppearance({ theme: 'light', glass: false, glassAlpha: 55, reduceMotion: false, zoom: 1 }, 'mac', { theme, window: null });
  assert.equal(sets, 1);
});

test('the page root carries data-window-glass and --ef-glass-alpha only over glass, and data-reduce-motion when it is on', () => {
  const attrs = new Set<string>(), style = new Map<string, string>();
  const root = {
    toggleAttribute: (name: string, force: boolean) => (force ? attrs.add(name) : attrs.delete(name), force),
    style: { setProperty: (n: string, v: string) => void style.set(n, v), removeProperty: (n: string) => (style.delete(n), '') },
  };
  applyPage(root, { glass: true, glassAlpha: 35, reduceMotion: true });
  assert.deepEqual([...attrs].sort(), ['data-reduce-motion', 'data-window-glass']);
  assert.equal(style.get('--ef-glass-alpha'), '35%');
  applyPage(root, { glass: false, glassAlpha: 35, reduceMotion: false });
  assert.deepEqual([...attrs], []);
  assert.equal(style.has('--ef-glass-alpha'), false);
});

test('settings.save of an 外观 row asks the shell to apply the appearance; the read reports a system without glass', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'appearance-'));
  try {
    writeFileSync(join(dir, 'config.json'), '{}');
    let applied = 0;
    const ctx: OpsContext = {
      surface: 'main', routes, config: { path: join(dir, 'config.json'), supportDir: dir, devResources: null }, agentd: null,
      store: null, diag: null, supervisor: null, library: null, confirm: async () => true, platform: 'windows', glassSupported: false,
      shell: { openExternal: async () => {}, openPath: async () => '', showItemInFolder: () => {} },
      clipboard: { writeText: () => {} },
      dialog: { pickFile: async () => null, pickFolder: async () => null, pickPackage: async () => null, saveFile: async () => true },
      app: { version: '0', os: 'test' }, loginItem: { enabled: () => null, set: () => {} }, settingsChanges: silentSource, log: () => {},
      saved: { fps: () => {}, hotkey: () => {}, appearance: () => { applied += 1; } },
    };
    const ops = registry(ctx), page = new PageSession(() => {});
    const call = (op: string, ...args: unknown[]) => handle('main', { mainFrame: true, origin: ORIGIN }, { op, args }, ops, page);
    assert.deepEqual(await call('settings.save', { appTheme: 'dark', uiZoom: '125' }), { ok: true, value: { restart: 'none', notApplied: [] } });
    assert.equal(applied, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')), { app_theme: 'dark', ui_zoom: 125 });
    const read = await call('settings.read');
    assert.ok(read.ok);
    assert.equal((read.value as { saved: Record<string, unknown> }).saved.winBg, 'opaque');
    const rows = await call('settings.schema');
    assert.ok(rows.ok);
    assert.equal((rows.value as { id: string; default: unknown }[]).find((r) => r.id === 'winBg')?.default, 'opaque');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
