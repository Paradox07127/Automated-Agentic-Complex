// The motion settings, play_chain and the playlist wired as index.ts wires them (src/main/renderer/avatar-host.ts): a fake
// host link under the ops, and a HostLink that is never started for its hello's capabilities.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import routes from '../../../protocol/ui-bridge/routes.json' with { type: 'json' };
import { handle } from '../src/common/bridge.ts';
import type { Actions, AvatarHello, C3Message, MotionOverridesReceipt } from '../src/common/c3.ts';
import { silentSource } from '../src/common/feed.ts';
import { PageSession } from '../src/common/page.ts';
import { ORIGIN } from '../src/common/ui.ts';
import { type OpsContext, registry } from '../src/main/ops/index.ts';
import { type AvatarLink, linkAvatarHost, MOTION_OFFERS, resendStoredOverrides } from '../src/main/renderer/avatar-host.ts';
import { type CommandResult, HostLink, type LinkEvent, type MotionOverrides } from '../src/main/renderer/link.ts';

const ALL = ['actions', 'ack', 'action_loop', 'motion_overrides', 'play_chain'];

/** A handshaken renderer listing ALL on character `si`; it acks each play_chain and reports it started. */
class FakeLink implements AvatarLink {
  hello: AvatarHello | null = { v: 1, type: 'hello', role: 'avatar', pid: 1, protocol: 1, capabilities: ALL };
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
  private listeners = new Set<(e: LinkEvent) => void>();

  stopSpeech() { return true; }
  async actions(): Promise<Actions> { return { v: 1, type: 'actions', character: 'si', switches: {}, actions: [] }; }
  async playAction() {}
  stopAction() {}
  async setMotionOverrides(character: string, overrides: MotionOverrides): Promise<MotionOverridesReceipt> {
    this.overrides.push({ character, overrides });
    return { req: 1, character, applied: { chains: 1, pools: 0, blend_in: 0 }, adjusted: [], truncated: false };
  }
  playChain(playId: string, character: string, start: string, speed?: number, onResult?: (r: CommandResult) => void): boolean {
    this.sent.push({ v: 1, type: 'play_chain', play_id: playId, character, start, speed });
    setTimeout(() => {
      onResult?.({ ok: true });
      this.emit({ kind: 'message', message: { v: 1, type: 'action_played', play_id: playId, id: start, phase: 'started', chain: start } });
    }, 5);
    return true;
  }
  send(m: C3Message): boolean {
    this.sent.push(m);
    return true;
  }
  on(listener: (e: LinkEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  clickThroughAll = false;
  sendPhoto() { return false; }
  capture(): Promise<{ file: string; width: number; height: number }> { return Promise.reject(new Error('unsupported')); }
  emit(e: LinkEvent): void {
    for (const l of [...this.listeners]) l(e);
  }
}

function fixture(config: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'motion-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));
  const link = new FakeLink(), hides: boolean[] = [];
  const ctx: OpsContext = {
    surface: 'main', routes, config: { path: configPath, supportDir: dir, devResources: null }, agentd: null, store: null, diag: null,
    avatar: linkAvatarHost(link, (hidden) => { hides.push(hidden); return true; }),
    supervisor: { state: () => ({ kind: 'running' }), pid: () => 1, restart: () => {}, avatar: () => ({ kind: 'running' }) },
    library: null, permission: () => 'undetermined', confirm: async () => true,
    shell: { openExternal: async () => {}, openPath: async () => '', showItemInFolder: () => {} }, clipboard: { writeText: () => {} },
    dialog: { pickFile: async () => null, pickFolder: async () => null, pickPackage: async () => null, saveFile: async () => true },
    app: { version: '0', os: 'test' }, loginItem: { enabled: () => null, set: () => {} }, settingsChanges: silentSource, log: () => {},
  };
  const ops = registry(ctx), page = new PageSession(() => {});
  return {
    dir, configPath, link, hides,
    call: async (op: string, ...args: unknown[]) => {
      const reply = await handle('main', { mainFrame: true, origin: ORIGIN }, { op, args }, ops, page);
      return reply.ok ? reply.value : { error: reply.error };
    },
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const OVERRIDES = { chains: { A_chain_start: false }, pools: {}, blend_in: {} };

test('with the link given to the ops, motionOverrides.set, playChain and the playlist ops answer instead of not_implemented', async () => {
  const f = fixture({ motion_playlists: { si: { items: ['mmd_a', 'mmd_b'], loop: 'off', speed: 1 } } });
  try {
    assert.deepEqual(await f.call('avatar.motionOverrides.set', OVERRIDES),
      { applied: { chains: 1, pools: 0, blend_in: 0 }, adjusted: [] });
    assert.deepEqual(f.link.overrides, [{ character: 'si', overrides: OVERRIDES }]);
    assert.equal(await f.call('avatar.playChain', { start: 'A_chain_start' }), null);
    assert.deepEqual(await f.call('avatar.playPlaylist'), { ok: true });
    assert.deepEqual(await f.call('avatar.playlistState'), { playing: true, index: 0, id: 'mmd_a' });
    assert.deepEqual(await f.call('avatar.stopPlaylist'), { ok: true });
    assert.deepEqual(f.link.sent.map((m) => m.type), ['play_chain', 'play_action', 'stop_action']);
    // avatar.setVisible still goes through the shell's own hiding.
    assert.equal(await f.call('avatar.setVisible', false), null);
    assert.deepEqual(f.hides, [true]);
  } finally {
    f.done();
  }
});

test('the hello lists motion_overrides and play_chain with the offers index.ts gives the link', () => {
  const link = new HostLink({ path: join(tmpdir(), 'never-started.sock'), transport: 'unix', pid: 1, build: {},
    fps: () => ({ idleLowFps: true, userFps: 60, batteryLow: true }), log: () => {}, offers: [...MOTION_OFFERS] });
  const listed = link.companionCapabilities;
  assert.ok(listed.includes('motion_overrides') && listed.includes('play_chain'), listed.join(','));
});

test('a list without an error sends the stored overrides of its character again; one with an error or none stored does not', async () => {
  const f = fixture({ motion_overrides: { si: { ...OVERRIDES, notes: { A_chain_start: '留着' } } } });
  try {
    const log: string[] = [];
    const off = resendStoredOverrides(f.link, f.configPath, (line) => log.push(line));
    const list = (character: string, error?: string): LinkEvent => ({ kind: 'message',
      message: { v: 1, type: 'actions', character, actions: [], switches: {}, ...(error ? { error } : {}) } });
    f.link.emit(list('si'));
    f.link.emit(list('si', 'too_large'));
    f.link.emit(list('cedar'));
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(f.link.overrides, [{ character: 'si', overrides: OVERRIDES }]);
    assert.deepEqual(log, ['motion_overrides si applied chains=1 pools=0 blend_in=0 adjusted=0']);
    off();
    f.link.emit(list('si'));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(f.link.overrides.length, 1);
  } finally {
    f.done();
  }
});
