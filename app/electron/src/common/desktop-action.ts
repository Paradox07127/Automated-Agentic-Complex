// `desktop.action`: each name on the shell function her wheel, her hover buttons and the console run; a name whose port the
// shell does not give answers not_implemented. Also the clicks on her that claim a ritual, the gift action's pick and what
// the user plays on her.
import { BridgeFailure, type Handler } from './bridge.ts';
import type { ActionPlayed, ActionRow, C3Message } from './c3.ts';

export const DESKTOP_ACTIONS = ['look', 'hide', 'show', 'clickThroughAll', 'quiet', 'quietEnd', 'gift', 'freeRoam', 'switchCharacter',
  'placeOnScreen', 'resetPosition', 'resize', 'photo', 'restartAll', 'quit', 'resetBoxes', 'openSessions', 'openStack', 'claimRitual',
  'quickInput', 'cmdMode', 'talk', 'stopPlay', 'pose'] as const;
export type DesktopActionName = (typeof DESKTOP_ACTIONS)[number];

/** The optional ports below answer not_implemented while the shell gives none. */
export interface DesktopActionPorts {
  /** ContextCapturer.look: asks agentd to look at the front window without waiting; nothing without a capturer. */
  look(): void;
  setHidden(hidden: boolean): void;
  /** `PUT /observation/quiet`: `until` in epoch seconds, null to end it. */
  setQuiet(until: number | null): Promise<void>;
  switchCharacter(id: string): void;
  /** `id` is a `desktop.onState` screen's. */
  placeOnScreen(id: string): void;
  resetPosition(): void;
  restartAll(): void;
  quit(): void;
  /** Opens 快速输入 in the bubble, with the drop card's scope when it names one. */
  quickInput(scope: { scopeId: string; files: number } | null): void;
  /** The page asks for the command layer in `mode`. */
  cmdMode(mode: 'ring'): void;
  /** 复位浮窗: every panel drops its user offset and pin. */
  resetBoxes(): void;
  clickThroughAll?(): void;
  /** Plays her gift action; throws why it could not. */
  gift?(): Promise<void>;
  freeRoam?(): void;
  /** The main window's sessions route. */
  openSessions?(): void;
  /** 去处理: the stack to the front. */
  openStack?(): void;
  /** The ritual tag's tap: null when agentd took it, else why not. */
  claimRitual?(): Promise<string | null>;
  /** Opens 调整大小's frame on her; nothing without her frame. */
  resize?(): void;
  /** Opens 拍照's bar under her; nothing without her figure. */
  photo?(): void;
  /** 说话: `start` as a press of the push-to-talk key, `stop` as its release, on the same recording. */
  talk?(phase: 'start' | 'stop'): void;
  /** 停止: ends the user's play on her (DesktopPlay.stop); throws why it could not. */
  stopPlay?(): void;
  /** Holds her in the pose row `id` (C3 rule 47), null for 自动; throws why she did not take it. */
  pose?(id: string | null): Promise<void>;
  /** Epoch milliseconds; tests drive it. */
  now?(): number;
}

/** Half an hour of quiet. */
const QUIET_SECONDS = 30 * 60;
const MAX_ID_BYTES = 256;

/** The drop card's 问 names its scope as `{"scopeId", "files"}`. */
function scope(arg: string): { scopeId: string; files: number } {
  let v: unknown;
  try {
    v = JSON.parse(arg);
  } catch {
    v = null;
  }
  const o = v as Record<string, unknown> | null;
  if (typeof o !== 'object' || o === null || typeof o.scopeId !== 'string' || o.scopeId === '' || !Number.isInteger(o.files)) {
    throw new BridgeFailure('failed', 'quickInput 的参数应是 {scopeId, files}');
  }
  return { scopeId: o.scopeId, files: o.files as number };
}

/** The times in epoch milliseconds. */
export interface ObservationState {
  /** null when observation is not paused. */
  pausedUntil: number | null;
  meeting: boolean;
  /** The 屏幕感知 plug-in (`plugins.screen_awareness`) is off: paused with no end. */
  off: boolean;
  /** null when quiet is off; agentd turns meeting and pause on while quiet and ends all three at this time. */
  quietUntil: number | null;
}

/** ISO 8601 with fractional seconds. */
export function parseWall(v: unknown): number | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+(?:Z|[+-]\d{2}:\d{2})$/.test(v)) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** `observation` of a `GET /state` or `/diag/state` body; null when it has none. */
export function observationState(body: unknown): ObservationState | null {
  const o = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).observation : null;
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return null;
  const s = o as Record<string, unknown>;
  return { pausedUntil: parseWall(s.paused_until), meeting: s.meeting === true, off: s.off === true, quietUntil: parseWall(s.quiet_until) };
}

/** Null when quiet is off or its end has passed. */
export function activeQuietUntil(s: ObservationState, now: number): number | null {
  return s.quietUntil !== null && s.quietUntil > now ? s.quietUntil : null;
}

export function desktopAction<P>(ports: DesktopActionPorts): Handler<P> {
  return async ([name, arg]) => {
    const id = arg ?? null;
    if (typeof name !== 'string' || !(DESKTOP_ACTIONS as readonly string[]).includes(name)
      || !(id === null || (typeof id === 'string' && id !== '' && new TextEncoder().encode(id).length <= MAX_ID_BYTES))) {
      throw new BridgeFailure('invalid_args', 'a DesktopActionName and an optional id');
    }
    const action = name as DesktopActionName;
    const required = (): string => {
      if (id === null) throw new BridgeFailure('failed', `${action} 缺少参数`);
      return id;
    };
    const given = <F>(port: F | undefined): F => {
      if (port === undefined) throw new BridgeFailure('not_implemented', `desktop.action ${action}`);
      return port;
    };
    switch (action) {
      case 'look': ports.look(); break;
      case 'hide': ports.setHidden(true); break;
      case 'show': ports.setHidden(false); break;
      case 'clickThroughAll': given(ports.clickThroughAll)(); break;
      case 'gift': await given(ports.gift)(); break;
      case 'freeRoam': given(ports.freeRoam)(); break;
      case 'openSessions': given(ports.openSessions)(); break;
      case 'openStack': given(ports.openStack)(); break;
      case 'resize': given(ports.resize)(); break;
      case 'photo': given(ports.photo)(); break;
      case 'claimRitual': {
        const failure = await given(ports.claimRitual)();
        if (failure !== null) throw new BridgeFailure('failed', failure);
        break;
      }
      case 'quiet': await ports.setQuiet(Math.floor((ports.now?.() ?? Date.now()) / 1000) + QUIET_SECONDS); break;
      case 'quietEnd': await ports.setQuiet(null); break;
      case 'switchCharacter': ports.switchCharacter(required()); break;
      case 'placeOnScreen': ports.placeOnScreen(required()); break;
      case 'resetPosition': ports.resetPosition(); break;
      case 'restartAll': ports.restartAll(); break;
      case 'quit': ports.quit(); break;
      case 'resetBoxes': ports.resetBoxes(); break;
      case 'quickInput': ports.quickInput(id === null ? null : scope(id)); break;
      case 'cmdMode': {
        const mode = required();
        if (mode !== 'ring' && mode !== 'input') throw new BridgeFailure('invalid_args', '未知的桌面操作面板');
        // A page from before 快速输入 moved to the bubble still sends `input`.
        if (mode === 'input') ports.quickInput(null);
        else ports.cmdMode(mode);
        break;
      }
      case 'talk': {
        const phase = required();
        if (phase !== 'start' && phase !== 'stop') throw new BridgeFailure('invalid_args', 'talk 的参数应是 start 或 stop');
        given(ports.talk)(phase);
        break;
      }
      case 'stopPlay': given(ports.stopPlay)(); break;
      case 'pose': await given(ports.pose)(id); break;
    }
    return null;
  };
}

/** Seconds on a monotonic clock. `settle` is longer than the plugin's double-click window (0.35 s),
 *  so a double click's first half never asks; a click within `repeatWindow` of the last is repeat clicking, which the
 *  avatar host answers with `click.repeat`; agentd takes a `count` up to `maxCount`. */
export const RITUAL = { settle: 0.40, repeatWindow: 4, minInterval: 20, maxCount: 20 } as const;

/** What a settled click does: `ask` claims a ritual or a line for `count` clicks; `quiet` is within `minInterval` of the last
 *  request. */
export type Settled = { kind: 'ask'; count: number } | { kind: 'quiet' };

/** Decides which single clicks on her ask agentd for a ritual (`POST /interaction/tap`). */
export class RitualTap {
  private lastClick: number | null = null;
  private waiting: number | null = null;
  private lastRequest: number | null = null;
  /** Single clicks since the last request, repeat and quiet ones included. */
  private clicks = 0;

  /** A left single click (`click` left/1). */
  click(now: number): void {
    const last = this.lastClick;
    this.lastClick = now;
    this.clicks += 1;
    if (last !== null && now - last < RITUAL.repeatWindow) return;
    this.waiting = now;
  }

  /** A left double click (`click` left/2): the click before it asks nothing and is not counted. */
  doubleClick(): void {
    this.waiting = null;
    this.clicks = Math.max(this.clicks - 1, 0);
  }

  /** Once per single click that settled by `now`; null before that and for a double or repeat click. */
  settled(now: number): Settled | null {
    if (this.waiting === null || now - this.waiting < RITUAL.settle) return null;
    this.waiting = null;
    if (this.lastRequest !== null && now - this.lastRequest < RITUAL.minInterval) return { kind: 'quiet' };
    this.lastRequest = now;
    const count = Math.min(this.clicks, RITUAL.maxCount);
    this.clicks = 0;
    return { kind: 'ask', count };
  }
}

/** Config.json `avatar_click` `quick_input` opens 快速输入 besides the ritual tap. */
export const opensQuickInput = (value: unknown): boolean => value === 'quick_input';

/** ISO8601DateFormatter with the current time zone: `2026-11-20T09:05:00+08:00`. `offset` is Date.getTimezoneOffset's. */
export function localIso(ms: number, offset: number): string {
  const d = new Date(ms - offset * 60_000), p = (n: number) => String(n).padStart(2, '0');
  const zone = offset === 0 ? 'Z' : `${offset > 0 ? '-' : '+'}${p(Math.floor(Math.abs(offset) / 60))}:${p(Math.abs(offset) % 60)}`;
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}${zone}`;
}

/** The answer to `POST /interaction/tap`: null when nothing needs saying. `count` is null
 *  for the ritual tag's tap; `status` 0 when agentd did not answer. */
export function ritualFailure(status: number, body: unknown, count: number | null): string | null {
  if (status === 202) return null;
  const o = typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (status === 409 && o.while === 'working') return '角色正在处理上一轮对话，请稍候';
  // A direct character click already cut the voice off.
  if (status === 409 && o.while === 'speaking') return count === null ? '角色正在语音播报，请稍后再试' : null;
  if (status === 409 && o.error === 'switching') return '正在切换角色，请稍后再试';
  if (status === 503 && o.error === 'no_llm') return '执行内核尚未就绪';
  if (status === 200) return count === null ? '本次没有可播放的回应' : null;
  return '未能收到角色回应，请稍后再试';
}

/** In order of preference. */
export const GIFT_IDS = ['receive_gift', 'library_interact_receive_gift', 'interact_receive_gift'];

/** The first of `GIFT_IDS` her list has. */
export function giftAction(actions: ActionRow[]): ActionRow | null {
  for (const id of GIFT_IDS) {
    const a = actions.find((x) => x.id === id);
    if (a) return a;
  }
  return null;
}

/** The user's play on her, whichever page or panel sent it (C3 rule 29): from its `started` until a final `action_played` of
 *  the same `play_id`, or until the link is lost. */
export class DesktopPlay {
  private play: { playId: string; id: string } | null = null;

  /** The playing action's id; null while none plays. */
  get id(): string | null {
    return this.play?.id ?? null;
  }

  /** One `action_played` she sent; true when what plays changed. */
  played(m: ActionPlayed): boolean {
    if (m.phase === 'started') {
      this.play = { playId: m.play_id, id: m.id };
      return true;
    }
    if (this.play?.playId !== m.play_id) return false;
    this.play = null;
    return true;
  }

  /** The link went down; true when something was playing. */
  lost(): boolean {
    const was = this.play !== null;
    this.play = null;
    return was;
  }

  /** Rule 29 `stop_action` for the play through `send`; nothing while none plays. Throws when her renderer, by its listed
   *  `capabilities`, cannot stop it or the link did not take it. */
  stop(send: (m: C3Message) => boolean, capabilities: readonly string[]): void {
    if (this.play === null) return;
    if (!capabilities.includes('action_loop') || !send({ v: 1, type: 'stop_action', play_id: this.play.playId })) {
      throw new Error('当前版本角色暂不支持停止动作');
    }
  }
}
