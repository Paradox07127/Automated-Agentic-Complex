// Clicks on her and the desktop actions that act on her, as index.ts wires them: a single click claims a ritual and, with
// `avatar_click` `quick_input`, opens 快速输入; a double click opens the sessions page; the right button goes to the
// character menu and is recorded for the daily brief; 送礼物, 自由活动 and 临时全部点穿 from the desktop.
import { BridgeFailure } from '../../common/bridge.ts';
import { type DesktopActionPorts, giftAction, localIso, opensQuickInput, RitualTap, RITUAL, ritualFailure } from '../../common/desktop-action.ts';
import type { Actions } from '../../common/c3.ts';
import type { Request } from '../../common/stack-source.ts';
import type { ClickEvent, RightDragEvent } from '../renderer/link.ts';

export interface InteractionOptions {
  /** agentd. */
  request: Request;
  /** config.json as saved now; `{}` when it cannot be read. */
  settings(): Record<string, unknown>;
  /** `settings.save` of the main window: free roam saves `beh.stay` as the settings page does, with its effects. */
  saveSettings(changes: Record<string, string>): Promise<{ error?: string }>;
  /** The renderer link; null without one. */
  link: {
    clickThroughAll: boolean;
    readonly currentCharacter: string | null;
    actions(character: string): Promise<Actions>;
    playAction(character: string, id: string, speed: number, loop: boolean): Promise<void>;
  } | null;
  /** The desktop panels; null without them. */
  desktop(): { readonly quickInputOpen: boolean; openQuickInput(): void; notice(text: string): void; pushState(): void } | null;
  openSessions(): void;
  /** The right button on her, at `at` in global points; `held`, it is still down. */
  onContextMenu(at: { x: number; y: number }, held: boolean): void;
  /** The held right button moved or came up at `at`, global points. */
  onRingPointer(phase: 'move' | 'up', at: { x: number; y: number }): void;
  /** refreshStatusIcon after click-through-all changed. */
  clickThroughChanged(): void;
  log(line: string): void;
  /** Seconds on a monotonic clock, and a timer on it; tests drive both. */
  clock?: { now(): number; after(seconds: number, fn: () => void): void };
}

export interface Interaction {
  /** HostLink's `onClick`. */
  click(e: ClickEvent): void;
  /** HostLink's `onRightDrag`: its `down` is a right click that stays held. */
  rightDrag(e: RightDragEvent): void;
  /** `desktop.action`'s ports that act on her. */
  actions: Required<Pick<DesktopActionPorts, 'claimRitual' | 'gift' | 'freeRoam' | 'clickThroughAll'>>;
}

export function interactionShell(o: InteractionOptions): Interaction {
  const clock = o.clock ?? { now: () => performance.now() / 1000, after: (s: number, fn: () => void) => { setTimeout(fn, s * 1000); } };
  const tap = new RitualTap();

  /** The tap that claims a pending ritual, from `count` clicks on her or from the web ritual tag (null). */
  const claimRitual = async (count: number | null, region: string | null): Promise<string | null> => {
    const now = Date.now();
    const json: Record<string, unknown> = { at: localIso(now, new Date(now).getTimezoneOffset()) };
    if (count !== null) json.count = count;
    if (region !== null) json.region = region;
    let status = 0, body: unknown = null;
    try {
      const reply = await o.request('POST', '/interaction/tap', json);
      status = reply.status;
      body = JSON.parse(reply.body);
    } catch { /* agentd did not answer, or not in JSON: status and body as far as they came */ }
    o.log(`RITUAL tap status=${status}`);
    return ritualFailure(status, body, count);
  };

  const leftClicked = (region: string | null) => {
    tap.click(clock.now());
    clock.after(RITUAL.runEnd, () => {
      const settled = tap.settled(clock.now());
      if (!settled) return;
      if (settled.kind === 'ask') {
        void claimRitual(settled.count, settled.count === 1 ? region : null).then((failure) => {
          tap.answered();
          if (failure !== null) o.desktop()?.notice(failure);
        });
      }
      const desktop = o.desktop();
      if (opensQuickInput(o.settings().avatar_click) && desktop && !desktop.quickInputOpen) desktop.openQuickInput();
    });
  };

  const changed = () => new Error('当前角色已变更，请重新选择操作');

  const rightClicked = (at: { x: number; y: number }, held: boolean) => {
    // Each right click on her is one `wheel`.
    void o.request('POST', '/interaction/record', { kind: 'wheel' }).then((r) => r.status, () => 0).then((status) => {
      if (status !== 204) o.log(`RECORD kind=wheel status=${status}`);
    });
    o.onContextMenu(at, held);
  };

  return {
    click: (e) => {
      if (e.kind === 'left') leftClicked(e.region);
      else if (e.kind === 'double') {
        tap.doubleClick();
        o.openSessions();
      } else rightClicked(e.at, false);
    },
    rightDrag: (e) => (e.phase === 'down' ? rightClicked(e.at, true) : o.onRingPointer(e.phase, e.at)),
    actions: {
      claimRitual: () => claimRitual(null, null),
      gift: async () => {
        const link = o.link;
        if (!link) throw new Error('角色渲染进程未连接（配置异常）');
        // Her list, for the character she still is.
        const list = async () => {
          const character = link.currentCharacter;
          if (character === null) throw changed();
          const l = await link.actions(character);
          if (link.currentCharacter !== character || l.character !== character) throw changed();
          return l;
        };
        const first = await list();
        const gift = giftAction(first.actions);
        if (!gift || gift.missing !== null) throw new Error(gift?.missing ?? '当前角色尚未导入原作赠礼动作');
        // Played at speed 1.
        if (link.currentCharacter !== first.character) throw changed();
        const again = await list();
        if (again.character !== first.character) throw changed();
        const action = again.actions.find((a) => a.id === gift.id);
        if (!action) throw new Error('当前角色不含该动作');
        if (action.missing !== null) throw new Error(action.missing);
        if (action.section === 'move') throw new Error('该动作不支持单独播放');
        await link.playAction(first.character, gift.id, 1, false);
        // agentd queues the gift and has her react to it; 202 is its only success.
        void o.request('POST', '/interaction/gift', { action_id: gift.id }).then((r) => r.status, () => 0).then((status) => {
          if (status !== 202) o.log(`GIFT action_id=${gift.id} status=${status}`);
        });
      },
      freeRoam: async () => {
        const stay = !['stay', 'bust'].includes(o.settings().stay_mode as string);
        const r = await o.saveSettings({ 'beh.stay': stay ? 'stay' : 'roam' });
        if (r.error !== undefined) {
          o.log(`free roam not saved: ${r.error}`);
          throw new BridgeFailure('failed', r.error);
        }
        o.desktop()?.pushState();
      },
      clickThroughAll: () => {
        const link = o.link;
        if (!link) return o.log('CLICK_THROUGH source=desktop: no avatar link (config failed)');
        const on = !link.clickThroughAll;
        link.clickThroughAll = on;
        o.log(`CLICK_THROUGH ${on ? 'on' : 'off'} source=desktop`);
        o.clickThroughChanged();
      },
    },
  };
}
