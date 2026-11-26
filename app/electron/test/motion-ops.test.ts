// `avatar.motionOverrides.*`, `avatar.playChain`, `avatar.motionChain.*` and the playlist ops against a fake link.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import routes from '../../../protocol/ui-bridge/routes.json' with { type: 'json' };
import { handle } from '../src/common/bridge.ts';
import type { Actions, AvatarHello, C3Message, MotionOverridesReceipt } from '../src/common/c3.ts';
import { silentSource } from '../src/common/feed.ts';
import { PageSession } from '../src/common/page.ts';
import { ORIGIN } from '../src/common/ui.ts';
import { type AvatarHost, avatarPlaylist, resendOverrides } from '../src/main/ops/avatar.ts';
import type { ToolResult } from '../src/main/ops/context.ts';
import { type OpsContext, registry } from '../src/main/ops/index.ts';
import { ActionFailure, type CommandResult, type LinkEvent, type MotionOverrides } from '../src/main/renderer/link.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ALL = ['actions', 'ack', 'action_loop', 'motion_overrides', 'play_chain'];

/** A handshaken renderer that lists `capabilities`; the test drives its receipts. */
class FakeLink implements AvatarHost {
  hello: AvatarHello | null;
  companionCapabilities = ['actions', 'motion_overrides', 'play_chain'];
  hidden = false;
  currentCharacter: string | null = 'si';
  currentAppearance = null;
  appearances = [];
  layers = [];
  hiddenLayers = [];
  lastStats = null;
  lastPipeline = null;
  lastPlacement = null;
  sent: C3Message[] = [];
  overrides: { character: string; overrides: MotionOverrides }[] = [];
  overridesReply: () => Promise<MotionOverridesReceipt> = async () => ({ req: 1, character: 'si', applied: { chains: 1, pools: 1, blend_in: 0 },
    adjusted: [{ kind: 'pool', key: 'session.thinking', reason: 'stance_mismatch' }], truncated: false });
  /** What playChain's `ack` says, and the `action_played` that follows an ok one. */
  chainAck: CommandResult = { ok: true };
  chainPlayed: { phase: string; reason: string | null } | null = { phase: 'started', reason: null };
  private listeners = new Set<(e: LinkEvent) => void>();

  constructor(capabilities = ALL) {
    this.hello = { v: 1, type: 'hello', role: 'avatar', pid: 1, protocol: 1, capabilities };
  }

  setVisible() { return true; }
  stopSpeech() { return true; }
  async actions(): Promise<Actions> { return { v: 1, type: 'actions', character: 'si', switches: {}, actions: [] }; }
  async playAction() {}
  stopAction() {}
  setMotionOverrides(character: string, overrides: MotionOverrides): Promise<MotionOverridesReceipt> {
    this.overrides.push({ character, overrides });
    return this.overridesReply();
  }
  playChain(playId: string, character: string, start: string, speed?: number, onResult?: (r: CommandResult) => void): boolean {
    if (this.hello === null) return false;
    this.sent.push({ v: 1, type: 'play_chain', play_id: playId, character, start, speed });
    setTimeout(() => {
      onResult?.(this.chainAck);
      if (this.chainAck.ok && this.chainPlayed) this.played(playId, this.chainPlayed.phase, this.chainPlayed.reason);
    }, 5);
    return true;
  }
  send(m: C3Message): boolean {
    if (this.hello === null) return false;
    this.sent.push(m);
    return true;
  }
  on(listener: (e: LinkEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(e: LinkEvent): void {
    for (const l of [...this.listeners]) l(e);
  }
  played(playId: string, phase: string, reason: string | null = null): void {
    this.emit({ kind: 'message', message: { v: 1, type: 'action_played', play_id: playId, id: 'x', phase, reason } });
  }
  /** The `play_id` of the last `play_action` sent. */
  get lastPlay(): string { return [...this.sent].reverse().find((m) => m.type === 'play_action')!.play_id as string; }
}

interface Fixture {
  dir: string; link: FakeLink | null; tool: string[][]; calls: string[]; ctx: OpsContext;
  switcher: { busy: boolean; held: boolean; current: string | null; switchOutcome(): Promise<never> };
  call(op: string, ...args: unknown[]): Promise<unknown>;
  config(): Record<string, unknown>;
  done(): void;
}

function fixture(o: { link?: FakeLink | null; config?: Record<string, unknown>; tool?: (args: string[]) => ToolResult } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'motion-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify(o.config ?? { mute: false }));
  const link = o.link === undefined ? new FakeLink() : o.link;
  const tool: string[][] = [], calls: string[] = [];
  const switcher = { busy: false, held: false, current: null, switchOutcome: async (): Promise<never> => { throw new Error('unused'); } };
  const ctx: OpsContext = {
    surface: 'main', routes, config: { path: join(dir, 'config.json'), supportDir: dir, devResources: null }, agentd: null, store: null,
    diag: null, avatar: link, switcher,
    supervisor: { state: () => ({ kind: 'running' }), pid: () => 1, restart: () => {}, avatar: () => ({ kind: 'running' }),
      restartAvatar: () => {
        calls.push(`restartAvatar held=${switcher.held}`);
        if (!link) return;
        const hello = link.hello;
        link.hello = null;
        setTimeout(() => { link.hello = hello; }, 150);
      } },
    library: { catalog: join(dir, 'library', 'current.json'), launched: '', characterName: 'Si', hookCommand: '',
      validationHost: () => '/bin/host', rosterChanged: () => {},
      runTool: async (script, args) => {
        const proposal = args[args.indexOf('--proposal') + 1]!;
        tool.push([script, ...args, readFileSync(proposal, 'utf8')]);
        calls.push(`tool held=${switcher.held}`);
        return o.tool ? o.tool(args) : { last: '', status: 1, stderr: 'no tool' };
      } },
    confirm: async () => true,
    shell: { openExternal: async () => {}, openPath: async () => '', showItemInFolder: () => {} }, clipboard: { writeText: () => {} },
    dialog: { pickFile: async () => null, pickFolder: async () => null, pickPackage: async () => null, saveFile: async () => true },
    app: { version: '0', os: 'test' }, loginItem: { enabled: () => null, set: () => {} }, settingsChanges: silentSource,
    log: (line) => calls.push(`log ${line}`),
  };
  const ops = registry(ctx), page = new PageSession(() => {});
  return {
    dir, link, tool, calls, switcher, ctx,
    call: async (op, ...args) => {
      const reply = await handle('main', { mainFrame: true, origin: ORIGIN }, { op, args }, ops, page);
      return reply.ok ? reply.value : { error: reply.error };
    },
    config: () => JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as Record<string, unknown>,
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const OVERRIDES = {
  chains: { A_chain_start: false }, pools: { 'session.thinking': [{ clip: 'A_think_start', weight: 2 }] },
  blend_in: { A_think_start: 0.3 }, notes: { A_chain_start: '应该放在日常' },
};
const err = (code: string, detail: string) => ({ error: { code, detail } });
const NOT_LISTED = '当前版本角色不支持动作设置';
const OVERRIDES_ARGS = '{chains ≤512, pools ≤64 of 1–64 {clip, weight 1–100000}, blend_in ≤512 of 0–2}';

test('avatar.motionOverrides.set stores the whole set with its notes, sends it without them and answers her receipt; get reads it back', async () => {
  const f = fixture({ config: { mute: false, motion_overrides: { cedar: { chains: {}, pools: {}, blend_in: {} } } } });
  try {
    assert.deepEqual(await f.call('avatar.motionOverrides.get', 'si'), { chains: {}, pools: {}, blend_in: {} });
    assert.deepEqual(await f.call('avatar.motionOverrides.set', 'si', OVERRIDES), { applied: { chains: 1, pools: 1, blend_in: 0 },
      adjusted: [{ kind: 'pool', key: 'session.thinking', reason: 'stance_mismatch' }] });
    const { notes: _, ...sent } = OVERRIDES;
    assert.deepEqual(f.link!.overrides, [{ character: 'si', overrides: sent }]);
    const config = f.config();
    assert.equal(config.mute, false);
    assert.deepEqual(config.motion_overrides, { cedar: { chains: {}, pools: {}, blend_in: {} }, si: OVERRIDES });
    assert.deepEqual(await f.call('avatar.motionOverrides.get', 'si'), OVERRIDES);
  } finally {
    f.done();
  }
});

test('avatar.motionOverrides.set refuses an oversized override set and stores nothing', async () => {
  const f = fixture();
  try {
    const bad = [undefined, { chains: {}, pools: {} }, { ...OVERRIDES, extra: 1 },
      { ...OVERRIDES, pools: { p: [{ clip: 'a', weight: 0 }] } }, { ...OVERRIDES, pools: { p: [{ clip: 'a', weight: 1.5 }] } },
      { ...OVERRIDES, pools: { p: [{ clip: 'a', weight: 1 }, { clip: 'a', weight: 2 }] } }, { ...OVERRIDES, pools: { p: [] } },
      { ...OVERRIDES, blend_in: { a: 2.5 } }, { ...OVERRIDES, chains: { a: 1 } }, { ...OVERRIDES, chains: { ['x'.repeat(129)]: true } },
      { ...OVERRIDES, notes: { a: '字'.repeat(501) } }];
    for (const value of bad) assert.deepEqual(await f.call('avatar.motionOverrides.set', 'si', value), err('invalid_args', OVERRIDES_ARGS));
    assert.equal(f.config().motion_overrides, undefined);
    assert.deepEqual(f.link!.overrides, []);
  } finally {
    f.done();
  }
});

test('avatar.motionOverrides.set: a renderer that does not list motion_overrides, or none connected, is not_implemented; the store stays', async () => {
  for (const link of [new FakeLink(['actions', 'ack', 'play_chain']), (() => { const l = new FakeLink(); l.hello = null; return l; })()]) {
    const f = fixture({ link });
    try {
      assert.deepEqual(await f.call('avatar.motionOverrides.set', 'si', OVERRIDES), err('not_implemented', NOT_LISTED));
      assert.deepEqual((f.config().motion_overrides as Record<string, unknown>).si, OVERRIDES);
      assert.deepEqual(link.overrides, []);
    } finally {
      f.done();
    }
  }
  const f = fixture({ link: null });
  try {
    assert.deepEqual(await f.call('avatar.motionOverrides.set', 'si', OVERRIDES), err('failed', '角色还没连上（配置出错）'));
    assert.deepEqual(await f.call('avatar.motionOverrides.get', 'si'), err('failed', '角色还没连上'), 'no character is current');
  } finally {
    f.done();
  }
});

test('avatar.motionOverrides and playChain meant for a character no longer current are refused; the current one\'s set stays', async () => {
  const f = fixture({ config: { mute: false, motion_overrides: { si: OVERRIDES } } });
  try {
    const changed = err('character_changed', '当前角色已切换，本次修改未生效');
    assert.deepEqual(await f.call('avatar.motionOverrides.set', 'cedar', { chains: {}, pools: {}, blend_in: {} }), changed);
    assert.deepEqual((f.config().motion_overrides as Record<string, unknown>), { si: OVERRIDES });
    assert.deepEqual(f.link!.overrides, []);
    assert.deepEqual(await f.call('avatar.motionOverrides.get', 'cedar'), changed);
    assert.deepEqual(await f.call('avatar.playChain', 'cedar', { start: 'a' }), changed);
    assert.deepEqual(f.link!.sent, []);
    assert.deepEqual(await f.call('avatar.motionOverrides.get', ''), err('invalid_args', 'character id'));
  } finally {
    f.done();
  }
});

test('avatar.motionOverrides.set rejects when config.json cannot be written, and sends nothing', async () => {
  const f = fixture();
  try {
    // writeObject writes this temporary file first.
    mkdirSync(join(f.dir, `config.json.tmp-${process.pid}`));
    const reply = await f.call('avatar.motionOverrides.set', 'si', OVERRIDES) as { error?: { code: string } };
    assert.equal(reply.error?.code, 'not_stored');
    assert.deepEqual(f.link!.overrides, []);
  } finally {
    f.done();
  }
});

test('avatar.motionOverrides.set passes her refusal on as failed', async () => {
  const f = fixture();
  try {
    f.link!.overridesReply = async () => { throw new ActionFailure('failed', '角色正在切换或动作还没加载好，过一会儿再试'); };
    assert.deepEqual(await f.call('avatar.motionOverrides.set', 'si', OVERRIDES), err('failed', '角色正在切换或动作还没加载好，过一会儿再试'));
  } finally {
    f.done();
  }
});

test('the stored set goes to her once with each list without an error, when it is not empty', async () => {
  const f = fixture({ config: { motion_overrides: { si: OVERRIDES, cedar: { chains: {}, pools: {}, blend_in: {}, notes: { a: 'b' } } } } });
  try {
    const list = (character: string, error?: string): LinkEvent => ({ kind: 'message',
      message: { v: 1, type: 'actions', character, actions: [], switches: {}, ...(error ? { error } : {}) } });
    const log: string[] = [];
    for (const e of [list('si'), list('si', 'too_large'), list('cedar'), list('aster'), { kind: 'lost', reason: 'eof' } as LinkEvent]) {
      resendOverrides(f.link!, join(f.dir, 'config.json'), e, (line) => log.push(line));
    }
    await sleep(10);
    const { notes: _, ...sent } = OVERRIDES;
    assert.deepEqual(f.link!.overrides, [{ character: 'si', overrides: sent }]);
    assert.deepEqual(log, ['motion_overrides si applied chains=1 pools=1 blend_in=0 adjusted=1']);
  } finally {
    f.done();
  }
});

test('avatar.playChain sends play_chain and answers once she reports it started', async () => {
  const f = fixture();
  try {
    assert.equal(await f.call('avatar.playChain', 'si', { start: 'A_chain_start', speed: 2 }), null);
    assert.equal(await f.call('avatar.playChain', 'si', { start: 'A_chain_start' }), null);
    assert.deepEqual(f.link!.sent.map(({ play_id: _, ...m }) => m), [
      { v: 1, type: 'play_chain', character: 'si', start: 'A_chain_start', speed: 2 },
      { v: 1, type: 'play_chain', character: 'si', start: 'A_chain_start', speed: 1 }]);
    assert.notEqual(f.link!.sent[0]!.play_id, f.link!.sent[1]!.play_id);
  } finally {
    f.done();
  }
});

test('avatar.playChain: a rejected play takes its reason as the code, an ack error fails, a dropped link fails', async () => {
  const f = fixture();
  try {
    f.link!.chainPlayed = { phase: 'rejected', reason: 'busy' };
    assert.deepEqual(await f.call('avatar.playChain', 'si', { start: 'a' }), err('busy', '角色正在执行其他动作'));
    f.link!.chainAck = { ok: false, reason: 'invalid' };
    assert.deepEqual(await f.call('avatar.playChain', 'si', { start: 'a' }), err('failed', '角色不含该动作编排链'));
    f.link!.chainAck = { ok: false, reason: 'unsupported' };
    assert.deepEqual(await f.call('avatar.playChain', 'si', { start: 'a' }), err('not_implemented', NOT_LISTED));
    f.link!.chainAck = { ok: true };
    f.link!.chainPlayed = null;
    const pending = f.call('avatar.playChain', 'si', { start: 'a' });
    await sleep(20);
    f.link!.emit({ kind: 'lost', reason: 'eof' });
    assert.deepEqual(await pending, err('failed', '角色连接已断开'));
  } finally {
    f.done();
  }
});

test('avatar.playChain: not listed is not_implemented; a renderer coming back is waited for; bad arguments are refused', async () => {
  const f = fixture({ link: new FakeLink(['actions', 'ack', 'motion_overrides']) });
  try {
    assert.deepEqual(await f.call('avatar.playChain', 'si', { start: 'a' }), err('not_implemented', NOT_LISTED));
    for (const value of [undefined, {}, { start: '' }, { start: 'x'.repeat(129) }, { start: 'a', speed: 3 }, { start: 'a', speed: null }]) {
      assert.deepEqual(await f.call('avatar.playChain', 'si', value), err('invalid_args', '{start, speed? 0.5, 1 or 2}'));
    }
  } finally {
    f.done();
  }
  const g = fixture();
  try {
    const hello = g.link!.hello;
    g.link!.hello = null;
    setTimeout(() => { g.link!.hello = hello; }, 250);
    assert.equal(await g.call('avatar.playChain', 'si', { start: 'a' }), null);
  } finally {
    g.done();
  }
  const h = fixture({ link: null });
  try {
    assert.deepEqual(await h.call('avatar.playChain', 'si', { start: 'a' }), err('failed', '角色还没连上（配置出错）'));
  } finally {
    h.done();
  }
});

const PROPOSAL = { schema: 'endfield-motion-chain-proposal/v1', character: 'si', package_sha256: '0123456789abcdef'.repeat(4),
  edits: [{ op: 'set', clip: 'A_think_loop', hold: 3 }, { op: 'insert', chain: 'A_think_start', index: 1, clip: 'A_nod' }] };
const CHECKED = { ok: false, problems: [{ edit: 1, reason: 'unknown_clip:A_nod' }],
  graph_changes: { chains_added: [], chains_removed: [], chains_changed: [] } };

test('avatar.motionChain.check runs motion_tool chain --check on the proposal and answers its JSON', async () => {
  const f = fixture({ tool: () => ({ last: JSON.stringify(CHECKED), status: 0, stderr: '' }) });
  try {
    assert.deepEqual(await f.call('avatar.motionChain.check', PROPOSAL), CHECKED);
    const [script, ...rest] = f.tool[0]!;
    const proposal = rest[rest.indexOf('--proposal') + 1]!;
    assert.equal(script, 'motion_tool.py');
    assert.deepEqual(rest.slice(0, -1), ['chain', '--library', join(f.dir, 'library'), '--character', 'si', '--proposal', proposal, '--check',
      '--validate-with', '/bin/host']);
    assert.deepEqual(JSON.parse(rest.at(-1)!), PROPOSAL);
    assert.equal(existsSync(proposal), false);
    assert.deepEqual(f.calls.filter((c) => c.startsWith('restartAvatar')), []);
  } finally {
    f.done();
  }
});

test('avatar.motionChain.apply holds the switch while the tool runs and the renderer restarts, then answers the tool JSON', async () => {
  const applied = { ok: true, character: 'si', version: '1.2.43' };
  const f = fixture({ tool: () => ({ last: JSON.stringify(applied), status: 0, stderr: '' }) });
  try {
    assert.deepEqual(await f.call('avatar.motionChain.apply', PROPOSAL), applied);
    assert.equal(f.tool[0]!.includes('--check'), false);
    assert.deepEqual(f.calls, ['tool held=true', 'restartAvatar held=true']);
    assert.equal(f.switcher.held, false);
    assert.notEqual(f.link!.hello, null);
    f.switcher.busy = true;
    assert.deepEqual(await f.call('avatar.motionChain.apply', PROPOSAL), err('busy', '角色正在切换，或另一个导入还没完成'));
  } finally {
    f.done();
  }
});

test('avatar.motionChain.*: the tool failure line is the code, a bad proposal is invalid_args, an unreadable reply is internal', async () => {
  let reply: ToolResult = { last: '', status: 1, stderr: `Traceback\n${JSON.stringify({ reason: 'stale', detail: 'package changed' })}\n` };
  const f = fixture({ tool: () => reply });
  try {
    assert.deepEqual(await f.call('avatar.motionChain.check', PROPOSAL), err('stale', 'package changed'));
    reply = { last: '', status: 2, stderr: 'usage: motion_tool.py\n' };
    assert.deepEqual(await f.call('avatar.motionChain.apply', PROPOSAL), err('internal', 'usage: motion_tool.py'));
    reply = { last: '{"ok": true}', status: 0, stderr: '' };
    assert.deepEqual(await f.call('avatar.motionChain.apply', PROPOSAL), err('internal', 'motion_tool printed no result: {"ok": true}'));
    const detail = '{schema, character, package_sha256, edits: 1+ of set, replace, insert or blend}';
    for (const value of [undefined, { ...PROPOSAL, edits: [] }, { ...PROPOSAL, package_sha256: 'ABC' },
      { ...PROPOSAL, edits: [{ op: 'set', clip: 'a' }] }, { ...PROPOSAL, edits: [{ op: 'insert', chain: 'a', index: 0, clip: 'b' }] },
      { ...PROPOSAL, edits: [{ op: 'blend', clip: 'a', seconds: 3 }] }, { ...PROPOSAL, extra: true }]) {
      assert.deepEqual(await f.call('avatar.motionChain.check', value), err('invalid_args', detail));
    }
  } finally {
    f.done();
  }
});

const LIST = { items: ['mmd_a', 'mmd_b'], loop: 'off', speed: 2 };

test('avatar.playPlaylist plays the stored list item by item as she completes each; playlistState follows it', async () => {
  const f = fixture({ config: { motion_playlists: { si: LIST } } });
  try {
    assert.deepEqual(await f.call('avatar.playlistState'), { playing: false, index: null, id: null });
    assert.deepEqual(await f.call('avatar.playPlaylist'), { ok: true });
    const plays = () => f.link!.sent.map(({ play_id: _, ...m }) => m);
    assert.deepEqual(plays(), [{ v: 1, type: 'play_action', character: 'si', id: 'mmd_a', speed: 2 }]);
    assert.deepEqual(await f.call('avatar.playlistState'), { playing: true, index: 0, id: 'mmd_a' });
    f.link!.played('another', 'completed');
    f.link!.played(f.link!.lastPlay, 'started');
    f.link!.played(f.link!.lastPlay, 'completed');
    assert.deepEqual(await f.call('avatar.playlistState'), { playing: true, index: 1, id: 'mmd_b' });
    f.link!.played(f.link!.lastPlay, 'completed');
    assert.deepEqual(await f.call('avatar.playlistState'), { playing: false, index: null, id: null });
    assert.equal(f.link!.sent.length, 2);
    assert.deepEqual(await f.call('avatar.playPlaylist', { start: 1 }), { ok: true });
    assert.deepEqual(await f.call('avatar.playlistState'), { playing: true, index: 1, id: 'mmd_b' });
  } finally {
    f.done();
  }
});

test('avatar.stopPlaylist stops the playing item; a loop of one plays it with loop; a character change ends the list', async () => {
  const f = fixture({ config: { motion_playlists: { si: { ...LIST, loop: 'one' } } } });
  try {
    assert.deepEqual(await f.call('avatar.stopPlaylist'), { ok: true });
    assert.deepEqual(await f.call('avatar.playPlaylist', { start: 1 }), { ok: true });
    assert.equal(f.link!.sent[0]!.loop, true);
    const playId = f.link!.lastPlay;
    assert.deepEqual(await f.call('avatar.stopPlaylist'), { ok: true });
    assert.deepEqual(f.link!.sent[1], { v: 1, type: 'stop_action', play_id: playId });
    assert.deepEqual(await f.call('avatar.playlistState'), { playing: false, index: null, id: null });
    assert.deepEqual(await f.call('avatar.playPlaylist'), { ok: true });
    f.link!.currentCharacter = 'cedar';
    assert.deepEqual(await f.call('avatar.playlistState'), { playing: false, index: null, id: null });
    f.link!.currentCharacter = 'si';
    f.link!.played(f.link!.lastPlay, 'completed');
    assert.equal(f.link!.sent.length, 3);
  } finally {
    f.done();
  }
});

test('avatar.playPlaylist: no item there is empty, no renderer to play on is not_started, a bad start is invalid_args', async () => {
  const f = fixture({ config: { motion_playlists: { si: LIST } } });
  try {
    assert.deepEqual(await f.call('avatar.playPlaylist', { start: 2 }), { ok: false, reason: 'empty' });
    for (const value of [{ start: -1 }, { start: 0.5 }, { start: '0' }, { start: null }, 'x', []]) {
      assert.deepEqual(await f.call('avatar.playPlaylist', value), err('invalid_args', '{start?: item index}'));
    }
    f.link!.hello = null;
    assert.deepEqual(await f.call('avatar.playPlaylist'), { ok: false, reason: 'not_started' });
  } finally {
    f.done();
  }
  for (const link of [new FakeLink(['ack']), null]) {
    const g = fixture({ link, config: { motion_playlists: { si: LIST } } });
    try {
      assert.deepEqual(await g.call('avatar.playPlaylist'), { ok: false, reason: 'not_started' });
      assert.deepEqual(await g.call('avatar.playlistState'), { playing: false, index: null, id: null });
      assert.deepEqual(await g.call('avatar.stopPlaylist'), { ok: true });
    } finally {
      g.done();
    }
  }
});

test('avatarPlaylist: the menus drive the same PlaylistHost as the avatar.*Playlist ops of its context', async () => {
  const f = fixture({ config: { motion_playlists: { si: LIST, cedar: { items: ['mmd_z'], loop: 'all', speed: 1 } }, mute: false } });
  try {
    const menu = avatarPlaylist(f.ctx);
    assert.deepEqual(menu.state, { kind: 'idle' });
    menu.start(1);
    assert.deepEqual(await f.call('avatar.playlistState'), { playing: true, index: 1, id: 'mmd_b' });
    f.link!.played(f.link!.lastPlay, 'completed');
    assert.deepEqual(menu.state, { kind: 'idle' });
    assert.deepEqual(await f.call('avatar.playPlaylist'), { ok: true });
    assert.equal(menu.state.kind, 'playing');
    const playId = f.link!.lastPlay;
    menu.stop();
    assert.deepEqual(await f.call('avatar.playlistState'), { playing: false, index: null, id: null });
    assert.deepEqual(f.link!.sent.at(-1), { v: 1, type: 'stop_action', play_id: playId });
    // A slot plays as one action with the list's loop and speed.
    menu.playSlot('mmd_x');
    const { play_id: _, ...sent } = f.link!.sent.at(-1)!;
    assert.deepEqual(sent, { v: 1, type: 'play_action', character: 'si', id: 'mmd_x', speed: 2 });
    assert.deepEqual(await f.call('avatar.playlistState'), { playing: true, index: null, id: 'mmd_x' });
    assert.deepEqual(menu.saved('si'), LIST);
    assert.deepEqual(menu.saved('nobody'), { items: [], loop: 'off', speed: 1 });
    menu.save('si', { ...LIST, loop: 'one' });
    assert.deepEqual(f.config(), { motion_playlists: { si: { ...LIST, loop: 'one' }, cedar: { items: ['mmd_z'], loop: 'all', speed: 1 } }, mute: false });
  } finally {
    f.done();
  }
  const g = fixture({ link: null });
  try {
    const menu = avatarPlaylist(g.ctx);
    menu.start(0);
    menu.playSlot('mmd_a');
    menu.stop();
    assert.deepEqual(menu.state, { kind: 'idle' });
  } finally {
    g.done();
  }
});
