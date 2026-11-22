// protocol/ui-bridge/returns/: every fixture of an implemented op, called on the main process side against a local fake
// agentd, resolves to a value of the fixture's shape (web/tests/unit/shape.ts); the rest still answer not_implemented.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import routes from '../../../protocol/ui-bridge/routes.json' with { type: 'json' };
import { mismatches } from '../../../web/tests/unit/shape.ts';
import { handle, type Reply, type Surface } from '../src/common/bridge.ts';
import { silentSource } from '../src/common/feed.ts';
import { PageSession } from '../src/common/page.ts';
import { PushSource } from '../src/common/push.ts';
import { RuntimeCoordinator, runtimeJson } from '../src/common/runtime.ts';
import { ORIGIN } from '../src/common/ui.ts';
import { AgentdClient } from '../src/main/agentd/client.ts';
import { AgentStore } from '../src/main/agentd/store.ts';
import { agentdLook } from '../src/main/context/shell.ts';
import type { AvatarHost } from '../src/main/ops/avatar.ts';
import { characterOps, type ImportPicker, mmdOps } from '../src/main/ops/character.ts';
import type { LinkEvent } from '../src/main/renderer/link.ts';
import { type OpsContext, registry } from '../src/main/ops/index.ts';

const RETURNS = new URL('../../../protocol/ui-bridge/returns/', import.meta.url);

interface ReturnCase {
  op: string; surface: Surface; args?: unknown[]; value?: unknown; kind?: 'undefined'; nullable?: string[]; free_keys?: string[];
  before?: { op: string; args?: unknown[] }[];
}
const cases: ReturnCase[] = readdirSync(RETURNS).filter((f) => f.endsWith('.json'))
  .flatMap((f) => JSON.parse(readFileSync(new URL(f, RETURNS), 'utf8')) as ReturnCase[]);

/** The implemented ops that have a fixture. */
const IMPLEMENTED = [
  'agentd.connection', 'agentd.request', 'app.info', 'app.action', 'app.look', 'app.runtime', 'supervisor.state', 'supervisor.restart', 'settings.schema',
  'settings.read', 'settings.save', 'settings.confirmDestructive', 'settings.previewDestructive', 'settings.validateHotkey',
  'settings.wipeLocalData', 'files.pickFile', 'files.pickFolder', 'files.saveAgentdExport', 'open.url', 'open.artifact',
  'open.revealInFinder', 'clipboard.writeText', 'character.list', 'character.importPackage', 'character.listImportedMotions',
  'character.renameMotion', 'character.removeMotion', 'character.importState', 'character.getPlaylist', 'character.setPlaylist',
  'mmd.list', 'mmd.syncState', 'onboarding.state', 'onboarding.advance', 'onboarding.back', 'onboarding.complete',
  'avatar.state', 'avatar.details', 'avatar.setVisible', 'avatar.stopSpeech', 'avatar.actions', 'avatar.playAction', 'avatar.stopAction',
  'avatar.setScale', 'avatar.keepClearOfMain', 'avatar.resetPosition', 'avatar.preview.show', 'avatar.preview.hide',
  'avatar.preview.sequence', 'avatar.setAppearance', 'avatar.setLayers', 'avatar.setActionSwitches', 'avatar.modSettings.get',
  'avatar.modSettings.set', 'character.switchTo', 'permissions.status', 'permissions.request', 'permissions.openSettings',
  'open.jumpToSession', 'open.runFeedCommand', 'open.runInTerminal',
  'avatar.motionOverrides.get', 'avatar.motionOverrides.set', 'avatar.playChain', 'avatar.motionChain.check', 'avatar.motionChain.apply',
  'avatar.playPlaylist', 'avatar.stopPlaylist', 'avatar.playlistState', 'avatar.toggleClickThroughAll', 'avatar.photo.set', 'avatar.capture',
  'app.openQuickInput',
  'settings.recordHotkey',
  'logs.sources', 'logs.read',
];

/** A platform helper that has every grant, finds the fixtures' app and session, and activates what it is asked to. */
const HELPER: Record<string, Record<string, unknown>> = {
  'permissions.status': { accessibility: 'granted', screenRecording: 'granted', microphone: 'granted', automation: 'granted',
    inputMonitoring: 'granted' },
  'permissions.request': { state: 'granted' },
  'apps.installed': { apps: [{ path: '/Applications/Session.app', name: 'Session' }] },
  'apps.activate': { activated: true, pid: 2 },
};

/** A renderer that said hello, reported a pipeline and a placement, and lists one action; it takes motion overrides with one
 *  pool adjusted, starts each chain and play, takes the photo panel, saves each screenshot, and comes back at once after a
 *  restart. */
const linkListeners = new Set<(e: LinkEvent) => void>();
const played = (playId: string) => {
  for (const l of [...linkListeners]) l({ kind: 'message', message: { v: 1, type: 'action_played', play_id: playId, id: 'x', phase: 'started', reason: null } });
};
const avatar: AvatarHost = {
  hello: { v: 1, type: 'hello', role: 'avatar', pid: 1, protocol: 1, capabilities: ['actions', 'filters', 'ack', 'motion_overrides', 'play_chain'],
    build: { git: 'abc', renderer: 'metal' } },
  companionCapabilities: ['actions', 'motion_overrides', 'play_chain'],
  hidden: false, currentCharacter: 'si', currentAppearance: 'default', appearances: [], layers: [], hiddenLayers: [], lastStats: null,
  lastPlacement: { v: 1, type: 'placement', x: 0, y: 0, scale: 1 },
  lastPipeline: { v: 1, type: 'pipeline', renderer: 'metal', character: 'si', appearance: 'default', appearance_fallback: null,
    render: { ssaa: 2, shadow_resolution: 1024, outline: 'on', display_resolution: false, unsupported: [] }, fps: { requested: 60, target: 60 },
    suspended: null, gpu: { allocated_mb: 1 }, frames: { submitted: 1, completed: 1 }, clip: 'idle', error: null },
  setVisible: () => true, stopSpeech: () => true, stopAction: () => {}, playAction: async () => {},
  actions: async () => ({ v: 1, type: 'actions', character: 'si', switches: { talk: true },
    actions: [{ id: 'talk', name: 'Talk', section: 'talk', duration: 1, trigger: 'speech', required_reason: 'Required', missing: null }] }),
  setMotionOverrides: async (character) => ({ req: 1, character, applied: { chains: 1, pools: 1, blend_in: 1 },
    adjusted: [{ kind: 'pool', key: 'session.thinking', reason: 'stance_mismatch' }], truncated: false }),
  playChain: (playId, _character, _start, _speed, onResult) => {
    setTimeout(() => { onResult?.({ ok: true }); played(playId); }, 1);
    return true;
  },
  send: () => true,
  on: (listener) => { linkListeners.add(listener); return () => linkListeners.delete(listener); },
  clickThroughAll: false,
  setClickThroughAll: () => {},
  sendPhoto: () => true,
  capture: async () => ({ file: 'Endfield-si-20261116-120000.png', width: 1080, height: 1920 }),
};

/** The web mock answers these as agentd's 404; routes.json does not classify them, so the bridge refuses them before
 *  sending (status 0, `unclassified_route`). */
const UNCLASSIFIED = new Set(['GET /cx-b-unknown', 'GET /agent/runs/cx-b-unknown']);

/** The shell's snapshot after agentd and the renderer came up; `runtimeEvents` is fed as index.ts feeds it. */
const coordinator = new RuntimeCoordinator(Date.now);
const runtimeEvents = new PushSource('runtime');
coordinator.observe((s) => runtimeEvents.send(runtimeJson(s)));
coordinator.send({ kind: 'child', name: 'agentd', state: { kind: 'running' }, pid: 1 });
coordinator.send({ kind: 'child', name: 'avatar', state: { kind: 'running' }, pid: 2 });

/** agentd's answers by `METHOD /path`: the agentd.request fixtures' own, and those the other ops send. */
const answers = new Map<string, { status: number; body: unknown }>([
  ['POST /context/privacy/sync', { status: 200, body: { counts: { episodes: 1 } } }],
  ['POST /look', { status: 202, body: { request_id: 'look-1' } }],
  ['POST /reset', { status: 200, body: { deleted: { episodes: 1 }, logs: [] } }],
  ['GET /history/export', { status: 200, body: { turns: [] } }],
  ['GET /memory', { status: 200, body: { facts: [] } }],
  ['GET /diag/state', { status: 200, body: { hooks: { claude: { installed: true, last_at: '2026-11-19T10:00:00.000Z' } } } }],
  ['GET /sessions', { status: 200, body: { sessions: [{ session_id: 'session', own: false, target: 'claude', cwd: null, state: 'idle',
    updated_at: 1, title: null, origin: { kind: 'unknown', pid: 2 } }] } }],
]);
for (const c of cases) {
  if (c.op !== 'agentd.request') continue;
  const value = c.value as { status: number; body: unknown };
  answers.set(`${c.args![0]} ${c.args![1]}`, value);
}

let dir: string, server: Server, store: AgentStore;
const mods: Record<string, Record<string, Record<string, number>>> = {};
const calls: string[] = [];
/** agentd's character; a fixture's `character.switchTo` before step stands for a switch that committed. */
let character = 'si';

/** motion_tool as the fixtures have it: `si` has one imported motion, other characters are unknown to it. */
async function motionTool(args: string[]): Promise<{ last: string; status: number; stderr: string }> {
  const arg = (name: string) => args[args.indexOf(name) + 1]!;
  if (args[0] === 'mmd-list') {
    return { last: JSON.stringify({ entries: [{ id: 'mmd_sample_1', title: '示例舞蹈', duration_s: 12.5, has_bgm: true, has_camera: false,
      created_at: '2026-11-17T10:00:00+00:00', characters: [{ id: 'si', state: 'baked' }] }] }), status: 0, stderr: '' };
  }
  if (arg('--character') !== 'si') {
    return { last: '', status: 1, stderr: `Traceback\n${JSON.stringify({ reason: 'internal', detail: `unknown_character: ${arg('--character')}` })}\n` };
  }
  if (args[0] === 'list') {
    return { last: JSON.stringify({ motions: [{ id: 'mmd_sample_1', clip: 'imported_vmd_sample_1', title: '示例舞蹈', format: 'vmd',
      duration_s: 12.5, has_bgm: true, created_at: null, warnings: [] }] }), status: 0, stderr: '' };
  }
  if (args[0] === 'chain') {
    const reply = args.includes('--check') ? { ok: false, problems: [{ edit: 1, reason: 'unknown_clip:A_clip_birch_dialog_single_nod' }],
      graph_changes: { chains_added: [], chains_removed: [], chains_changed: [] } } : { ok: true, character: 'si', version: '1.2.43' };
    return { last: JSON.stringify(reply), status: 0, stderr: '' };
  }
  if (args[0] === 'import') {
    return { last: JSON.stringify({ ok: true, action: { id: 'mmd_sample_1', title: '示例舞蹈', duration_s: 12.5, has_bgm: true }, format: 'vmd',
      warnings: [] }), status: 0, stderr: '' };
  }
  if (args[0] === 'rename') return { last: JSON.stringify({ id: arg('--action'), title: arg('--title') }), status: 0, stderr: '' };
  return { last: JSON.stringify({ id: arg('--action') }), status: 0, stderr: '' };
}

/** outfit_tool as the fixtures have it: the mod imports as `mod_1a2b3c4d`, and removing it succeeds. */
async function outfitTool(args: string[]): Promise<{ last: string; status: number; stderr: string }> {
  if (args[0] === 'import') {
    return { last: JSON.stringify({ ok: true, appearance: { id: 'mod_1a2b3c4d', name: '示例外观' }, warnings: [] }), status: 0, stderr: '' };
  }
  return { last: JSON.stringify({ ok: true, appearance: { id: 'mod_1a2b3c4d' } }), status: 0, stderr: '' };
}

/** The import ops ask with open panels, which the registry's ops would open for real; these tests pick with a fake. */
const IMPORTS = ['character.importMotion', 'character.importOutfit', 'character.removeOutfit', 'mmd.import'];
const picker: ImportPicker = { files: async (o) => (o.multiple ? [join(dir, 'dance.vmd')] : []), folder: async () => join(dir, 'Mod') };

function context(surface: Surface): OpsContext {
  const runtime = join(dir, 'agentd', 'ui-runtime.json');
  return {
    surface, routes, config: { path: join(dir, 'config.json'), supportDir: dir, devResources: null },
    agentd: new AgentdClient(runtime), store, diag: silentSource,
    supervisor: { state: () => ({ kind: 'running' }), pid: () => process.pid, restart: () => { calls.push('restart'); },
      avatar: () => ({ kind: 'stopped' }),
      restartAvatar: () => {
        const hello = avatar.hello;
        (avatar as { hello: AvatarHost['hello'] }).hello = null;
        setTimeout(() => { (avatar as { hello: AvatarHost['hello'] }).hello = hello; }, 150);
      } },
    avatar,
    placement: { setScale: () => {}, resetPosition: () => {}, keepClearOfMain: () => {} },
    // Like the web mock: no main window draws a preview, so show answers false.
    preview: { show: async () => false, hide: () => {}, sequence: async () => {}, progress: new PushSource('progress') },
    // The renderer answers each request; one setting it does not take falls back to its default.
    looks: {
      setAppearance: async () => {}, setLayers: async () => {},
      saveSwitches: async (c, switches) => ({ character: c, switches, adjusted: [] }),
      modSettings: (c) => mods[c] ?? {},
      saveModSettings: async (c, appearance, values) => {
        const drawn = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v > 3 ? 0 : v]));
        (mods[c] ??= {})[appearance] = drawn;
        return { req: 1, character: c, appearance, values: drawn,
          adjusted: Object.keys(values).filter((k) => drawn[k] !== values[k]).map((id) => ({ id, reason: 'defaulted' })) };
      },
    },
    switcher: { busy: false, held: false, current: 'si',
      switchOutcome: async (id) => (id === 'cedar' ? { kind: 'failed', stage: 'avatar', reason: 'Missing resource' } : { kind: 'switched' }) },
    library: {
      catalog: join(dir, 'library', 'current.json'), launched: 'si', characterName: 'Si', hookCommand: "'python3' install_hooks.py",
      validationHost: () => '/bin/test', runTool: (script, args) => (script === 'outfit_tool.py' ? outfitTool(args) : motionTool(args)),
      rosterChanged: () => {},
    },
    helper: { request: async (op) => (HELPER[op] ? { ok: true, result: HELPER[op] } : { ok: false, error: { code: 'unsupported', message: op } }) },
    // No terminal runs: osascript stands answered.
    commands: { executable: () => null, run: async (file, args) => { calls.push(`run ${file} ${args.length}`); return { ok: true, stdout: '' }; } },
    confirm: async () => true,
    shell: {
      openExternal: async (url) => { calls.push(`openExternal ${url}`); },
      openPath: async (path) => { calls.push(`openPath ${path}`); return ''; },
      showItemInFolder: (path) => { calls.push(`showItemInFolder ${path}`); },
    },
    clipboard: { writeText: (text) => { calls.push(`clipboard ${text}`); } },
    dialog: { pickFile: async () => null, pickFolder: async () => null, pickPackage: async () => null, saveFile: async () => false },
    app: { version: '0.0.0', os: 'test' },
    loginItem: { enabled: () => null, set: () => {} },
    settingsChanges: silentSource,
    runtime: { snapshot: () => runtimeJson(coordinator.snapshot), events: runtimeEvents },
    look: agentdLook(new AgentdClient(runtime), () => {}),
    openQuickInput: () => { calls.push('openQuickInput'); },
    log: () => {},
    // A recording ended by Esc.
    recordHotkey: async () => null,
  };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'returns-'));
  server = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer token') {
      res.writeHead(401).end();
      return;
    }
    if (req.url === '/feed') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': open\n\n');
      return;
    }
    const answer = req.url === '/state' ? { status: 200, body: { character } }
      : answers.get(`${req.method} ${req.url}`) ?? { status: 404, body: { error: 'not_found' } };
    res.writeHead(answer.status, { 'Content-Type': 'application/json' });
    res.end(answer.body === null ? '' : JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  mkdirSync(join(dir, 'agentd'));
  writeFileSync(join(dir, 'agentd', 'ui-runtime.json'), JSON.stringify({ base_url: `http://127.0.0.1:${port}`, ui_token: 'token' }));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ mute: false }));
  writeFileSync(join(dir, 'artifact.md'), '# done\n');
  mkdirSync(join(dir, 'library', 'si'), { recursive: true });
  writeFileSync(join(dir, 'library', 'current.json'), JSON.stringify({ schema: 'endfield-character-library/v1',
    characters: [{ id: 'si', definition: { file: 'si/character.json' } }] }));
  writeFileSync(join(dir, 'library', 'si', 'character.json'), JSON.stringify({ id: 'si', display: { name: { 'zh-Hans': 'Si', en: 'SI' } } }));
  store = new AgentStore(join(dir, 'agentd', 'ui-runtime.json'));
  store.start();
  const deadline = Date.now() + 5000;
  while (store.connection !== 'connected' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
});

after(() => {
  store.stop();
  server.closeAllConnections();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Runs the case's `before` steps first; one this shell does not implement stands for nothing, except a switch. */
async function call(c: ReturnCase, ops = registry(context(c.surface))): Promise<Reply> {
  const page = new PageSession(() => {});
  const sender = { mainFrame: true, origin: ORIGIN };
  character = 'si';
  // The playPlaylist fixture without steps stands for a character with no list.
  if (c.op === 'avatar.playPlaylist' && c.before === undefined) writeFileSync(join(dir, 'config.json'), JSON.stringify({ mute: false }));
  for (const step of c.before ?? []) {
    if (step.op === 'character.switchTo') character = step.args![0] as string;
    else await handle(c.surface, sender, { op: step.op, args: step.args ?? [] }, ops, page);
  }
  // The fixture's /tmp/artifact has no text suffix and does not exist; open.artifact opens only an existing text file.
  // The fixture's /tmp is not a Windows path.
  const args = c.op === 'open.artifact' ? [realpathSync(join(dir, 'artifact.md'))]
    : c.op === 'open.revealInFinder' && process.platform === 'win32' ? [dir] : c.args ?? [];
  return handle(c.surface, sender, { op: c.op, args }, ops, page);
}

test('every fixture of an implemented op resolves to the fixture shape', async () => {
  const failures: string[] = [];
  let checked = 0;
  for (const c of cases.filter((x) => IMPLEMENTED.includes(x.op))) {
    const reply = await call(c);
    checked += 1;
    const label = `${c.op} ${JSON.stringify(c.args ?? [])}`;
    if (!reply.ok) {
      failures.push(`${label}: ${reply.error.code} ${reply.error.detail}`);
      continue;
    }
    if (c.op === 'agentd.request' && UNCLASSIFIED.has(`${c.args![0]} ${c.args![1]}`)) {
      const value = reply.value as { status: number; body: unknown; error: { code: string } };
      if (value.status !== 0 || value.body !== null || value.error.code !== 'unclassified_route') {
        failures.push(`${label}: expected unclassified_route, got ${JSON.stringify(value)}`);
      }
      continue;
    }
    if (c.kind === 'undefined') {
      if (reply.value !== null) failures.push(`${label}: expected no value, got ${JSON.stringify(reply.value)}`);
      continue;
    }
    // protocol.ts `CharacterEntry.layers` is optional: the renderer reports outfit layers, so this shell sends none yet.
    const value = c.op === 'character.list' ? (c.value as Record<string, unknown>[]).map(({ layers: _, ...entry }) => entry) : c.value;
    for (const m of mismatches(value, reply.value, c.nullable ?? [], c.free_keys ?? [])) failures.push(`${label}: ${m}`);
  }
  assert.ok(checked >= 40, `checked ${checked}`);
  assert.deepEqual(failures, []);
});

test('app.onRuntime pushes the app.runtime fixture shape at once and on every change', async () => {
  const fixture = cases.find((c) => c.op === 'app.runtime')!;
  const pushed: unknown[] = [];
  const page = new PageSession((_id, stream, kind, payload) => {
    if (stream === 'app.onRuntime' && kind === 'event') pushed.push(JSON.parse(payload!.data));
  });
  const reply = await handle('main', { mainFrame: true, origin: ORIGIN }, { op: 'app.onRuntime', args: [1] }, registry(context('main')), page);
  assert.deepEqual(reply, { ok: true, value: null });
  coordinator.send({ kind: 'agentdReady' });
  coordinator.send({ kind: 'agentdReady' });
  assert.equal(pushed.length, 2);
  assert.deepEqual(pushed.map((p) => (p as { revision: number }).revision), [coordinator.snapshot.revision - 1, coordinator.snapshot.revision]);
  for (const p of pushed) assert.deepEqual(mismatches(fixture.value, p, fixture.nullable ?? [], fixture.free_keys ?? []), []);
  page.end();
});

test('every fixture of an import op resolves to the fixture shape when the picker picks', async () => {
  const checked = cases.filter((x) => IMPORTS.includes(x.op));
  for (const c of checked) {
    const ctx = context(c.surface);
    const reply = await call(c, new Map([...registry(ctx), ...Object.entries({ ...characterOps(ctx, picker), ...mmdOps(ctx, picker) })]));
    assert.ok(reply.ok, `${c.op}: ${JSON.stringify(reply)}`);
    assert.deepEqual(mismatches(c.value, reply.value, c.nullable ?? [], c.free_keys ?? []), [], c.op);
  }
  assert.deepEqual(checked.map((c) => c.op).sort(), [...IMPORTS].sort());
});

test('character.onImport pushes the character.importState fixture shape through an import', async () => {
  const fixture = cases.find((c) => c.op === 'character.importState')!;
  const ctx = context('main');
  ctx.library!.runTool = async (script, args, progress) => {
    progress?.({ stage: 'read', fraction: 0.5 });
    return script === 'outfit_tool.py' ? outfitTool(args) : motionTool(args);
  };
  const ops = new Map([...registry(ctx), ...Object.entries({ ...characterOps(ctx, picker), ...mmdOps(ctx, picker) })]);
  const pushed: unknown[] = [];
  const page = new PageSession((_id, stream, kind, payload) => {
    if (stream === 'character.onImport' && kind === 'event') pushed.push(JSON.parse(payload!.data));
  });
  const sender = { mainFrame: true, origin: ORIGIN };
  assert.deepEqual(await handle('main', sender, { op: 'character.onImport', args: [1] }, ops, page), { ok: true, value: null });
  for (const op of ['character.importMotion', 'character.importOutfit', 'mmd.import']) {
    assert.ok((await handle('main', sender, { op, args: [] }, ops, page)).ok, op);
  }
  assert.deepEqual(pushed.map((p) => (p as { kind: string | null }).kind),
    ['motion', 'motion', 'motion', null, 'outfit', 'outfit', 'outfit', null, 'mmd', 'mmd', 'mmd', null]);
  for (const p of pushed) assert.deepEqual(mismatches(fixture.value, p, fixture.nullable ?? [], fixture.free_keys ?? []), []);
  page.end();
});

test('the fixtures of the ops left for the renderer, the platform helper and the desktop overlays answer not_implemented', async () => {
  for (const c of cases.filter((x) => !IMPLEMENTED.includes(x.op) && !IMPORTS.includes(x.op))) {
    const reply = await call(c);
    assert.deepEqual(reply, { ok: false, error: { code: 'not_implemented', detail: c.op } }, c.op);
  }
});
