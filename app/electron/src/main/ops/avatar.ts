// `avatar.*` that map to one C3 message to the renderer, or read what it reported, the placement ops, and her look.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ChildState } from '../../common/agentd.ts';
import { BridgeFailure } from '../../common/bridge.ts';
import {
  type ActionPlayed, type Actions, type AvatarHello, type C3Message, type MotionOverridesReceipt, type Stats,
} from '../../common/c3.ts';
import { decodePlaylists, type Playlist } from '../../common/character.ts';
import type { ShellPlatform } from '../../common/config.ts';
import {
  type AppearanceOption, type LayerOption, modAppearance, type ModReceipt, modValues, type ModValues, type SwitchReply,
} from '../../common/looks.ts';
import { chainArgs, chainFailure, chainProposal, chainRefused, chainRejected, chainReply, playChainArg } from '../../common/motion-chain.ts';
import {
  loadOverrides, overridesArg, overridesEmpty, overridesJson, sentOverrides, storeOverrides, type StoredOverrides,
} from '../../common/motion-overrides.ts';
import type { Cancel, EventSource, StreamEvent } from '../../common/page.ts';
import { PlaylistPlayer, type PlaylistState } from '../../common/playlist.ts';
import type { HelperReply } from '../helper/client.ts';
import {
  ActionFailure, type ActionProgress, type CommandResult, LINK_TIMING, type LinkEvent, type MotionOverrides, type TransportOp,
} from '../renderer/link.ts';
import type { Ops, OpsContext } from './context.ts';
import { watch } from './events.ts';
import { holdingMotions, listed, reloadAvatar, sleep } from './holding.ts';
import { readObject, writeObject } from './settings.ts';

/** What the ops need of the host link. */
export interface AvatarHost {
  readonly hello: AvatarHello | null;
  /** What the link lists in its hello. */
  readonly companionCapabilities: string[];
  readonly hidden: boolean;
  readonly currentCharacter: string | null;
  readonly currentAppearance: string | null;
  /** The appearance and layer lists of `currentCharacter`, as she last reported them. */
  readonly appearances: AppearanceOption[];
  readonly layers: LayerOption[];
  readonly hiddenLayers: string[];
  readonly lastStats: Stats | null;
  readonly lastPipeline: C3Message | null;
  readonly lastPlacement: C3Message | null;
  setVisible(visible: boolean): boolean;
  stopSpeech(): boolean;
  actions(character: string): Promise<Actions>;
  playAction(character: string, id: string, speed: number, loop: boolean): Promise<void>;
  stopAction(): void;
  /** HostLink's own, for the motion settings, `play_chain` and the playlist; without them those ops are `not_implemented`. */
  setMotionOverrides?(character: string, overrides: MotionOverrides): Promise<MotionOverridesReceipt>;
  playChain?(playId: string, character: string, start: string, speed?: number, onResult?: (r: CommandResult) => void): boolean;
  send?(m: C3Message): boolean;
  on?(listener: (e: LinkEvent) => void): () => void;
  /** HostLink.clickThroughAll (临时全部点穿), reported by `avatar.state`. */
  readonly clickThroughAll?: boolean;
  /** HostLink.sendPhoto, for 拍照's window: false when not sent (both sides list `render_live` and `photo`). */
  sendPhoto?(active: boolean, aperture: number, focus: number | null): boolean;
  /** HostLink.capture: her `captured` file name and size; without it `photo.capture` is `not_implemented`. */
  capture?(background: string): Promise<{ file: string; width: number; height: number }>;
  /** HostLink.controlAction and actionProgress; without them `avatar.controlAction` is `not_implemented`. */
  controlAction?(op: TransportOp, at?: number): Promise<void>;
  readonly actionProgress?: ActionProgress | null;
}

/** Her appearance, layers, action switches and mod settings (src/main/renderer/looks.ts). */
export interface LooksHost {
  setAppearance(id: string): Promise<void>;
  /** Hides `hide` and shows `show` of the current character's layers; the others keep how they are. */
  setLayers(change: { hide: string[]; show: string[] }): Promise<void>;
  saveSwitches(character: string, switches: Record<string, boolean>): Promise<SwitchReply>;
  modSettings(character: string): Record<string, ModValues>;
  saveModSettings(character: string, appearance: string, values: ModValues): Promise<ModReceipt>;
}

/** What the ops need of the placement (src/main/placement/controller.ts). */
export interface AvatarPlacement {
  setScale(scale: number): void;
  keepClearOfMain(on: boolean): void;
}

const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {});
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/** protocol.ts `AvatarState`; `speaking` has no source. */
export function avatarState(host: AvatarHost, renderer: ChildState, fallbackCharacter: string | null): Record<string, unknown> {
  const placement = host.lastPlacement;
  return { running: renderer.kind === 'running', visible: !host.hidden,
    scale: typeof placement?.scale === 'number' ? placement.scale : 1, clickThroughAll: host.clickThroughAll ?? false, speaking: false,
    characterId: host.currentCharacter ?? fallbackCharacter, appearanceId: host.currentAppearance };
}

/** avatarDetails.ts `AvatarDetails` from the hello's build and the last `pipeline` and `placement`. */
export function avatarDetails(host: AvatarHost): Record<string, unknown> {
  const build = obj(host.hello?.build), p = host.lastPipeline, place = host.lastPlacement;
  let pipeline: Record<string, unknown> | null = null;
  if (p !== null) {
    const render = obj(p.render), fps = obj(p.fps), fallback = obj(p.appearance_fallback);
    pipeline = { character: p.character ?? '', appearance: p.appearance ?? '', fallbackRequested: fallback.requested ?? null,
      ssaa: num(render.ssaa), shadowResolution: num(render.shadow_resolution), outline: render.outline ?? '',
      displayResolution: render.display_resolution === true, unsupported: Array.isArray(render.unsupported) ? render.unsupported : [],
      fpsRequested: num(fps.requested), fpsTarget: num(fps.target), suspended: p.suspended ?? null,
      gpuAllocatedMB: num(obj(p.gpu).allocated_mb), framesSubmitted: num(obj(p.frames).submitted), clip: p.clip ?? null,
      error: p.error ?? null };
  }
  return { renderer: typeof build.renderer === 'string' ? build.renderer : null, build: typeof build.git === 'string' ? build.git : null,
    pipeline, placement: place === null ? null : { x: num(place.x), y: num(place.y), scale: num(place.scale) } };
}

/** protocol.ts `AvatarStats` from the last C3 `stats` and the renderer's CPU as a share of one core (null when unread). */
export function avatarStats(stats: Stats | null, cpuShare: number | null = null): Record<string, unknown> | null {
  if (stats === null || typeof stats.fps !== 'number') return null;
  const out: Record<string, unknown> = { fps: stats.fps, frameMs: stats.fps > 0 ? 1000 / stats.fps : 0, cpuPercent: (cpuShare ?? 0) * 100 };
  if (typeof stats.frame_ms_p95 === 'number') out.frameMsP95 = stats.frame_ms_p95;
  if (typeof stats.gpu_ms === 'number') out.gpuMs = stats.gpu_ms;
  return out;
}

/** Its CPU since the last read as a share of one core; null on a first read. */
export class CpuSampler {
  private last: { pid: number; seconds: number; at: number } | null = null;

  /** `pid` undefined (not running) or `seconds` null (unreadable) drops the history. `at` in seconds. */
  sample(pid: number | undefined, seconds: number | null, at: number): number | null {
    if (pid === undefined || seconds === null) {
      this.last = null;
      return null;
    }
    const prev = this.last;
    this.last = { pid, seconds, at };
    return prev !== null && prev.pid === pid && at > prev.at ? Math.max(0, (seconds - prev.seconds) / (at - prev.at)) : null;
  }
}

/** CPU seconds (user + system) from `ps -o time=`, `[[dd-]hh:]mm:ss.cc`; null when gone or unreadable. */
export function psCpuSeconds(pid: number): number | null {
  let out: string;
  try {
    out = execFileSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
  const m = /^(?:(\d+)-)?([\d:.]+)$/.exec(out);
  if (m === null) return null;
  const seconds = m[2]!.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
  return Number.isFinite(seconds) ? Number(m[1] ?? 0) * 86400 + seconds : null;
}

/**
 * One async `process.usage` reader over `ac-helper` for both CPU seconds and resident MB.
 * Each read returns the last answered value for `pid` and refreshes in the background, avoiding synchronous `ps` spawns.
 */
export function processUsageReader(
  helper: { request(op: string, params: Record<string, unknown>): Promise<HelperReply> },
): { cpuSeconds(pid: number): number | null; residentMB(pid: number): number | null } {
  const last = new Map<number, { cpuSeconds: number | null; residentMB: number | null }>();
  const refresh = (pid: number) => {
    void helper.request('process.usage', { pids: [pid] }).then((r) => {
      const usage = r.ok && Array.isArray(r.result.usage) ? r.result.usage as Record<string, unknown>[] : [];
      const row = usage.find((u) => u.pid === pid);
      if (!row || (typeof row.cpu_time_ns !== 'number' && typeof row.resident_bytes !== 'number')) {
        last.delete(pid);
        return;
      }
      last.set(pid, {
        cpuSeconds: typeof row.cpu_time_ns === 'number' ? row.cpu_time_ns / 1e9 : null,
        residentMB: typeof row.resident_bytes === 'number' ? row.resident_bytes / (1024 * 1024) : null,
      });
    });
  };
  return {
    cpuSeconds: (pid) => { refresh(pid); return last.get(pid)?.cpuSeconds ?? null; },
    residentMB: (pid) => last.get(pid)?.residentMB ?? null,
  };
}

/**
 * OpsContext's `cpuSeconds` port: uses `ac-helper` (`process.usage`) when available on either platform,
 * falling back to synchronous `ps` only on macOS when no helper exists; null on Windows without a helper.
 */
export function cpuSecondsReader(platform: ShellPlatform,
  helper: { request(op: string, params: Record<string, unknown>): Promise<HelperReply> } | null): ((pid: number) => number | null) | null {
  if (!helper) return platform === 'mac' ? psCpuSeconds : null;
  return processUsageReader(helper).cpuSeconds;
}

/** Reads once a second while a page listens; `changesOnly` pushes only a value that differs from the last. */
export class TickSource implements EventSource {
  private readonly event: string;
  private readonly changesOnly: boolean;
  private readonly read: () => unknown;
  private readonly interval: number;

  constructor(event: string, changesOnly: boolean, read: () => unknown, interval = 1000) {
    this.event = event;
    this.changesOnly = changesOnly;
    this.read = read;
    this.interval = interval;
  }

  subscribe(_afterSeq: string | null, onEvent: (e: StreamEvent) => void): Cancel {
    let last: string | null = null;
    const tick = () => {
      const value = this.read();
      if (value === null || value === undefined) return;
      const data = JSON.stringify(value);
      if (this.changesOnly && data === last) return;
      last = data;
      onEvent({ event: this.event, id: null, data });
    };
    tick();
    const timer = setInterval(tick, this.interval);
    return () => clearInterval(timer);
  }
}

const SPEEDS = [0.5, 1, 2];
const TRANSPORT_OPS: readonly unknown[] = ['pause', 'resume', 'seek'];

/** protocol.ts `ActionProgress`. */
const progressJson = (p: ActionProgress | null) => (p === null ? null : { id: p.id, tS: p.t, durationS: p.duration, paused: p.paused });
/** Metrics.avatarScale. */
const SCALES = { min: 0.5, max: 2 };
const NO_LINK = '角色渲染进程未连接（配置异常）';
/** A renderer that does not list the capability. */
const UNLISTED = '当前版本角色不支持动作设置';
/** Said when the character a page meant is no longer the current one. */
const CHANGED = '当前角色已切换，本次修改未生效';

/** HostLink `listing`: both sides list `capability`, and she lists each of `hers` too. */
const listing = (host: AvatarHost, capability: string, ...hers: string[]): boolean =>
  host.companionCapabilities.includes(capability) && [capability, ...hers].every((c) => listed(host).includes(c));

/** A list without an error sends that character's stored set when it is not empty.
 *  Not retried. */
export function resendOverrides(link: Pick<AvatarHost, 'setMotionOverrides'>, configPath: string, e: LinkEvent,
  log: (line: string) => void): void {
  if (e.kind !== 'message' || e.message.type !== 'actions' || e.message.error !== undefined || !link.setMotionOverrides) return;
  const character = e.message.character;
  if (typeof character !== 'string') return;
  let stored: StoredOverrides | null;
  try {
    stored = loadOverrides(readObject(configPath), character);
  } catch {
    return;
  }
  if (stored === null || overridesEmpty(stored)) return;
  link.setMotionOverrides(character, sentOverrides(stored)).then(
    (r) => log(`motion_overrides ${character} applied chains=${r.applied.chains} pools=${r.applied.pools} `
      + `blend_in=${r.applied.blend_in} adjusted=${r.adjusted.length}`),
    (err: unknown) => log(`motion_overrides ${character} failed: ${err instanceof Error ? err.message : String(err)}`));
}

/** One per ops context so the menus play the list its pages see: made on first
 *  use, when it starts taking the link's `action_played`. `character` is the avatar's when the list was started. */
interface PlaylistHost { player: PlaylistPlayer; character: string | null }
const playlistHosts = new WeakMap<OpsContext, PlaylistHost>();

/** Null without a link that sends and listens. */
function playlistOf(ctx: OpsContext): PlaylistHost | null {
  const link = ctx.avatar;
  if (!link?.send || !link.on) return null;
  const known = playlistHosts.get(ctx);
  if (known) return followCharacter(ctx, known);
  const send = link.send.bind(link);
  const supportsLoop = () => listed(link).includes('action_loop');
  const made: PlaylistHost = { character: null, player: new PlaylistPlayer({
    send: (id, speed, loop) => {
      const character = link.currentCharacter;
      if (character === null || !listed(link).includes('actions')) return null;
      const playId = randomUUID();
      const m: C3Message = { v: 1, type: 'play_action', play_id: playId, character, id, speed };
      if (loop && supportsLoop()) m.loop = true;
      return send(m) ? playId : null;
    },
    stop: (playId) => { if (supportsLoop()) send({ v: 1, type: 'stop_action', play_id: playId }); },
    supportsLoop,
  }) };
  link.on((e) => {
    if (e.kind !== 'message' || e.message.type !== 'action_played') return;
    const m = e.message as ActionPlayed;
    followCharacter(ctx, made).player.received(m.play_id, m.phase, m.reason ?? null);
  });
  playlistHosts.set(ctx, made);
  return followCharacter(ctx, made);
}

/** A character other than the one the list started on ends it. */
function followCharacter(ctx: OpsContext, h: PlaylistHost): PlaylistHost {
  const current = ctx.avatar?.currentCharacter ?? null;
  if (h.character !== current) {
    h.player.characterChanged();
    h.character = current;
  }
  return h;
}

/** The character's `motion_playlists` entry; an empty list when there is none. */
function savedPlaylist(ctx: OpsContext, character: string): Playlist {
  let table: Record<string, Playlist> = {};
  try {
    table = decodePlaylists(readObject(ctx.config.path).motion_playlists);
  } catch { /* an empty list */ }
  return table[character] ?? { items: [], loop: 'off', speed: 1 };
}

/** The list as the menus drive it, on the PlaylistHost of `ctx`'s `avatar.*Playlist` ops. Without a link it
 *  stays idle and plays nothing. */
export interface AvatarPlaylist {
  readonly state: PlaylistState;
  saved(character: string): Playlist;
  /** Writes one character's entry; other characters and other keys stay. Throws when config.json cannot be read or written. */
  save(character: string, list: Playlist): void;
  /** The current character's list from `index`. */
  start(index: number): void;
  stop(): void;
  /** One action with the current list's loop and speed. */
  playSlot(id: string): void;
}

export function avatarPlaylist(ctx: OpsContext): AvatarPlaylist {
  return {
    get state() { return playlistOf(ctx)?.player.state ?? { kind: 'idle' }; },
    saved: (character) => savedPlaylist(ctx, character),
    save: (character, list) => {
      const config = readObject(ctx.config.path);
      const table = decodePlaylists(config.motion_playlists);
      table[character] = list;
      config.motion_playlists = table;
      writeObject(ctx.config.path, config);
    },
    start: (index) => {
      const h = playlistOf(ctx);
      if (h?.character != null) h.player.start(savedPlaylist(ctx, h.character), index);
    },
    stop: () => playlistOf(ctx)?.player.stop(),
    playSlot: (id) => {
      const h = playlistOf(ctx);
      if (h?.character == null) return;
      const list = savedPlaylist(ctx, h.character);
      h.player.start({ items: [id], loop: list.loop, speed: list.speed }, 0);
    },
  };
}

export function avatarOps(ctx: OpsContext): Ops {
  const host = (): AvatarHost => {
    if (!ctx.avatar) throw new BridgeFailure('failed', '角色还没连上（配置出错）');
    return ctx.avatar;
  };
  const current = (): string => {
    const id = host().currentCharacter;
    if (id === null) throw new BridgeFailure('failed', '角色还没连上');
    return id;
  };
  const bridged = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (e) {
      if (e instanceof ActionFailure) throw new BridgeFailure(e.code, e.message);
      throw e;
    }
  };
  const looks = (op: string): LooksHost => {
    if (!ctx.looks) throw new BridgeFailure('not_implemented', op);
    return ctx.looks;
  };
  const placement = (): AvatarPlacement => {
    if (!ctx.placement) throw new BridgeFailure('failed', '角色还没连上（配置出错）');
    return ctx.placement;
  };
  let switchSaving: Promise<unknown> = Promise.resolve();
  const fallback = () => (ctx.library?.launched ? ctx.library.launched : null);
  const renderer = (): ChildState => ctx.supervisor?.avatar() ?? { kind: 'stopped' };
  const stateSource = new TickSource('state', true, () => (ctx.avatar ? avatarState(ctx.avatar, renderer(), fallback()) : null));
  // A sampler per listener, since a reading kept across a gap with no listener would
  // average the whole gap into the next CPU share.
  const statsSource: EventSource = {
    subscribe: (afterSeq, onEvent) => {
      const sampler = new CpuSampler();
      return new TickSource('stats', false, () => {
        const stats = ctx.avatar?.lastStats ?? null;
        if (avatarStats(stats) === null) return null;
        const pid = ctx.supervisor?.avatarPid?.();
        const seconds = pid === undefined || !ctx.cpuSeconds ? null : ctx.cpuSeconds(pid);
        return avatarStats(stats, sampler.sample(pid, seconds, performance.now() / 1000));
      }).subscribe(afterSeq, onEvent);
    },
  };
  // The play as it stands, then each of the link's changes.
  const progressSource: EventSource = {
    subscribe: (_afterSeq, onEvent) => {
      const link = ctx.avatar;
      if (!link?.on) return () => {};
      const push = (p: ActionProgress | null) => onEvent({ event: 'actionProgress', id: null, data: JSON.stringify(progressJson(p)) });
      if (link.actionProgress) push(link.actionProgress);
      return link.on((e) => { if (e.kind === 'actionProgress') push(e.progress); });
    },
  };
  /** `AvatarState.characterId`. */
  const characterId = (): string | null => ctx.avatar?.currentCharacter ?? fallback();
  const characterOrFail = (): string => {
    const id = characterId();
    if (id === null) throw new BridgeFailure('failed', '角色还没连上');
    return id;
  };
  /** The character a page names (1–64 bytes); `invalid_args` otherwise. */
  const characterArg = (v: unknown): string => {
    if (typeof v !== 'string' || v === '' || new TextEncoder().encode(v).length > 64) throw new BridgeFailure('invalid_args', 'character id');
    return v;
  };
  /** `character_changed` unless `expected` is `id`. */
  const sameCharacter = (expected: string, id: string): string => {
    if (id !== expected) throw new BridgeFailure('character_changed', CHANGED);
    return id;
  };

  /** Waits while the renderer restarts, at most LINK_TIMING.relink. */
  const linked = async (link: AvatarHost): Promise<void> => {
    const deadline = Date.now() + LINK_TIMING.relink * 1000;
    while (link.hello === null) {
      if (Date.now() >= deadline) throw new BridgeFailure('failed', '和角色的连接断了');
      await sleep(100);
    }
  };

  /** `motion_tool.py chain` with the proposal in a temporary file. */
  const runChain = async (proposal: Record<string, unknown>, character: string, check: boolean): Promise<Record<string, unknown>> => {
    const library = ctx.library!;
    let host: string;
    try {
      host = library.validationHost();
    } catch (e) {
      throw new BridgeFailure('validate_failed', e instanceof Error ? e.message : String(e));
    }
    const file = join(tmpdir(), `endfield-motion-chain-${randomUUID()}.json`);
    writeFileSync(file, JSON.stringify(proposal));
    try {
      const { last, status, stderr } = await library.runTool('motion_tool.py', chainArgs(dirname(library.catalog!), character, file, check, host));
      if (status !== 0) throw chainFailure(stderr);
      return chainReply(last, check);
    } finally {
      rmSync(file, { force: true });
    }
  };

  const motionChain = (check: boolean) => async ([value]: unknown[]) => {
    const proposal = chainProposal(value);
    if (proposal === null) throw new BridgeFailure('invalid_args', '{schema, character, package_sha256, edits: 1+ of set, replace, insert or blend}');
    const link = ctx.avatar, sw = ctx.switcher;
    if (!ctx.library?.catalog || !link || !sw) throw new BridgeFailure('failed', NO_LINK);
    try {
      if (check) return await runChain(proposal, characterOrFail(), true);
      return await holdingMotions(link, sw, async (character) => {
        const applied = await runChain(proposal, character, false);
        await reloadAvatar(ctx, link);
        return applied;
      });
    } catch (e) {
      if (e instanceof BridgeFailure) throw e;
      throw new BridgeFailure('failed', e instanceof Error ? e.message : String(e));
    }
  };

  /** Null without a link. */
  const playlistHost = (op: string) => {
    const link = ctx.avatar;
    if (!link) return null;
    if (!link.send || !link.on) throw new BridgeFailure('not_implemented', op);
    return playlistOf(ctx);
  };
  const playlistConfig = (character: string): Playlist => savedPlaylist(ctx, character);

  return {
    'avatar.state': () => avatarState(host(), renderer(), fallback()),
    'avatar.details': () => avatarDetails(host()),
    'avatar.setVisible': ([visible]) => {
      if (typeof visible !== 'boolean') throw new BridgeFailure('invalid_args', 'visible');
      host().setVisible(visible);
      return null;
    },
    'avatar.setScale': ([scale]) => {
      if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < SCALES.min || scale > SCALES.max) {
        throw new BridgeFailure('invalid_args', 'scale 0.5...2.0');
      }
      placement().setScale(scale);
      return null;
    },
    'avatar.keepClearOfMain': ([on]) => {
      if (typeof on !== 'boolean') throw new BridgeFailure('invalid_args', 'on');
      placement().keepClearOfMain(on);
      return null;
    },
    'avatar.stopSpeech': () => {
      if (!host().stopSpeech()) throw new BridgeFailure('failed', '角色没有连上');
      return null;
    },
    'avatar.actions': () => bridged(async () => {
      const table = await host().actions(current());
      // The desktop play panel's rule: move motions and ones lacking assets do not play alone.
      return table.actions.map((a) => {
        const defaultEnabled = a.default_enabled ?? true;
        const row: Record<string, unknown> = { id: a.id, label: a.name, enabled: table.switches[a.id] ?? defaultEnabled, section: a.section,
          trigger: a.trigger === '' ? null : a.trigger, durationS: a.duration, isNew: false,
          missingReason: a.missing, playable: a.missing === null && a.section !== 'move', defaultEnabled };
        if (a.missing !== null) row.missing = true;
        if (a.required_reason !== null) row.requiredReason = a.required_reason;
        if (a.media !== undefined) row.media = a.media;
        return row;
      });
    }),
    'avatar.playAction': ([id, speed, options]) => {
      const o = (options ?? null) as Record<string, unknown> | null;
      const loop = o === null ? false : o.loop ?? false;
      if (typeof id !== 'string' || id === '' || typeof speed !== 'number' || !SPEEDS.includes(speed)
        || (o !== null && (typeof o !== 'object' || Array.isArray(o))) || typeof loop !== 'boolean') {
        throw new BridgeFailure('invalid_args', 'action id, speed 0.5, 1 or 2, and {loop?}');
      }
      return bridged(async () => {
        await host().playAction(current(), id, speed, loop);
        return null;
      });
    },
    'avatar.stopAction': () => bridged(async () => {
      host().stopAction();
      return null;
    }),
    'avatar.controlAction': ([op, at]) => {
      if (!TRANSPORT_OPS.includes(op) || (op === 'seek' ? !(typeof at === 'number' && Number.isFinite(at) && at >= 0) : at !== undefined)) {
        throw new BridgeFailure('invalid_args', 'op pause, resume or seek, and at_s ≥ 0 with seek only');
      }
      const link = host();
      if (!link.controlAction) throw new BridgeFailure('not_implemented', 'avatar.controlAction');
      return bridged(async () => {
        await link.controlAction!(op as TransportOp, at as number | undefined);
        return null;
      });
    },
    'avatar.onActionProgress': watch('avatar.onActionProgress', progressSource),
    'avatar.setAppearance': ([id]) => {
      if (typeof id !== 'string' || id === '') throw new BridgeFailure('invalid_args', 'appearance id');
      return bridged(async () => {
        await looks('avatar.setAppearance').setAppearance(id);
        return null;
      });
    },
    'avatar.setLayers': ([of, change]) => {
      const expected = characterArg(of);
      const c = (typeof change === 'object' && change !== null && !Array.isArray(change) ? change : {}) as Record<string, unknown>;
      const ids = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && x !== '');
      if (!ids(c.hide) || !ids(c.show)) throw new BridgeFailure('invalid_args', '{hide, show: layer ids}');
      const hide = c.hide, show = c.show;
      return bridged(async () => {
        sameCharacter(expected, current());
        await looks('avatar.setLayers').setLayers({ hide, show });
        return null;
      });
    },
    'avatar.setActionSwitches': ([of, raw]) => {
      const expected = characterArg(of);
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || !Object.values(raw).every((v) => typeof v === 'boolean')) {
        throw new BridgeFailure('invalid_args', 'switches');
      }
      const changes = raw as Record<string, boolean>;
      // Each save merges into the table the one before it stored.
      const task = switchSaving.then(async () => {
        try {
          // The page sends only what it changed; the avatar stores the table it gets as the user's whole table.
          const character = sameCharacter(expected, current());
          const switches = (await host().actions(character)).switches;
          if (host().currentCharacter !== character) throw new BridgeFailure('character_changed', CHANGED);
          if (!Object.keys(changes).every((id) => Object.hasOwn(switches, id))) throw new BridgeFailure('invalid_args', 'unknown action');
          const reply = await looks('avatar.setActionSwitches').saveSwitches(character, { ...switches, ...changes });
          const value: Record<string, unknown> = { switches: reply.switches, adjusted: reply.adjusted };
          if (reply.error !== undefined) value.error = reply.error;
          return value;
        } catch (e) {
          if (e instanceof BridgeFailure) throw e;
          throw new BridgeFailure('failed', e instanceof Error ? e.message : String(e));
        }
      });
      switchSaving = task.catch(() => {});
      return task;
    },
    'avatar.modSettings.get': ([o]) => {
      const store = looks('avatar.modSettings.get');
      const character = (o as Record<string, unknown> | null | undefined)?.character;
      if (typeof character !== 'string' || character === '') throw new BridgeFailure('invalid_args', '{character}');
      return { appearances: store.modSettings(character) };
    },
    'avatar.modSettings.set': ([o]) => {
      const store = looks('avatar.modSettings.set');
      const r = (typeof o === 'object' && o !== null && !Array.isArray(o) ? o : {}) as Record<string, unknown>;
      const appearance = modAppearance(r.appearance), values = modValues(r.values);
      if (typeof r.character !== 'string' || r.character === '' || appearance === null || values === null) {
        throw new BridgeFailure('invalid_args', '{character, appearance of 1–64 bytes, values: ≤64 switch ids → 0–255}');
      }
      return bridged(async () => {
        const receipt = await store.saveModSettings(r.character as string, appearance, values);
        return { values: receipt.values, adjusted: receipt.adjusted };
      });
    },
    'avatar.motionOverrides.get': ([of]) => {
      const id = sameCharacter(characterArg(of), characterOrFail());
      let stored: StoredOverrides | null = null;
      try {
        stored = loadOverrides(readObject(ctx.config.path), id);
      } catch { /* none stored */ }
      return stored ? overridesJson(stored) : { chains: {}, pools: {}, blend_in: {} };
    },
    'avatar.motionOverrides.set': ([of, value]) => {
      const expected = characterArg(of);
      const overrides = overridesArg(value);
      if (overrides === null) {
        throw new BridgeFailure('invalid_args', '{chains ≤512, pools ≤64 of 1–64 {clip, weight 1–100000}, blend_in ≤512 of 0–2}');
      }
      const link = host();
      if (!link.setMotionOverrides) throw new BridgeFailure('not_implemented', 'avatar.motionOverrides.set');
      const character = sameCharacter(expected, characterOrFail());
      // Stored first; the store stays when sending fails.
      try {
        writeObject(ctx.config.path, storeOverrides(readObject(ctx.config.path), character, overrides));
      } catch (e) {
        ctx.log(`motion_overrides ${character} not stored: ${e instanceof Error ? e.message : String(e)}`);
        throw new BridgeFailure('not_stored', `动作设置保存失败：${e instanceof Error ? e.message : String(e)}`);
      }
      if (link.hello === null || !listing(link, 'motion_overrides', 'actions', 'ack')) throw new BridgeFailure('not_implemented', UNLISTED);
      return bridged(async () => {
        const receipt = await link.setMotionOverrides!(character, sentOverrides(overrides));
        return { applied: { ...receipt.applied }, adjusted: receipt.adjusted };
      });
    },
    'avatar.playChain': async ([of, value]) => {
      const expected = characterArg(of);
      const { start, speed } = playChainArg(value);
      const link = host();
      if (!link.playChain || !link.on) throw new BridgeFailure('not_implemented', 'avatar.playChain');
      const character = sameCharacter(expected, characterOrFail());
      await linked(link);
      if (!listing(link, 'play_chain', 'actions', 'ack')) throw new BridgeFailure('not_implemented', UNLISTED);
      const playId = randomUUID();
      // Answers once she reports the play started; an `ack` error ends it at once.
      return new Promise<null>((resolve, reject) => {
        let done = false;
        const finish = (failure: BridgeFailure | null) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          off();
          if (failure) reject(failure);
          else resolve(null);
        };
        const timer = setTimeout(() => finish(new BridgeFailure('failed', '角色渲染进程无响应')), LINK_TIMING.playStart * 1000);
        const off = link.on!((e) => {
          if (e.kind === 'lost') finish(new BridgeFailure('failed', '角色连接已断开'));
          if (e.kind !== 'message' || e.message.type !== 'action_played' || e.message.play_id !== playId) return;
          const m = e.message as ActionPlayed;
          finish(m.phase === 'rejected' ? chainRejected(m.reason ?? '') : null);
        });
        if (!link.playChain!(playId, character, start, speed, (r) => { if (!r.ok) finish(chainRefused(r.reason)); })) {
          finish(new BridgeFailure('not_implemented', UNLISTED));
        }
      });
    },
    'avatar.motionChain.check': motionChain(true),
    'avatar.motionChain.apply': motionChain(false),
    'avatar.playPlaylist': ([value]) => {
      const o = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
      const start = o?.start === undefined ? 0 : o.start;
      if ((value !== undefined && value !== null && o === null) || typeof start !== 'number' || !Number.isInteger(start) || start < 0) {
        throw new BridgeFailure('invalid_args', '{start?: item index}');
      }
      const h = playlistHost('avatar.playPlaylist'), character = characterId();
      if (h === null || character === null) return { ok: false, reason: 'not_started' };
      if (start >= playlistConfig(character).items.length) return { ok: false, reason: 'empty' };
      if (h.character !== null) h.player.start(playlistConfig(h.character), start);
      return h.player.state.kind === 'playing' ? { ok: true } : { ok: false, reason: 'not_started' };
    },
    'avatar.stopPlaylist': () => {
      playlistHost('avatar.stopPlaylist')?.player.stop();
      return { ok: true };
    },
    'avatar.playlistState': () => {
      const h = playlistHost('avatar.playlistState'), character = characterId();
      const now = h === null || character === null ? null : h.player.position(playlistConfig(character).items);
      return { playing: now !== null, index: now?.index ?? null, id: now?.id ?? null };
    },
    'avatar.onState': watch('avatar.onState', stateSource),
    'avatar.onStats': watch('avatar.onStats', statsSource),
  };
}
