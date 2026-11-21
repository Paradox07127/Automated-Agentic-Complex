// The pieces index.ts wires between the renderer link, agentd and the system, kept apart so the tests can drive them.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HelperY } from '../common/attention.ts';
import type { Box } from '../common/c3.ts';
import type { Config } from '../common/config.ts';
import type { StreamEvent } from '../common/page.ts';
import type { Point, Rect } from '../common/placement.ts';
import type { NotifyMode } from '../common/stack-source.ts';
import { readWindows } from '../common/surfaces.ts';
import type { HelperReply } from './helper/client.ts';

/** The Companion hello's `build`: `git` is the commit build.mjs put in, `unknown` without one. */
export function helloBuild(version: string, git: string | undefined): Record<string, string> {
  return { shell: 'electron', version, git: git || 'unknown' };
}

/** HostLink's `cursor`: the pointer, a DIP point from Electron, in C3 global points. */
export function c3Cursor(space: { fromDip(r: { x: number; y: number; width: number; height: number }): Rect; pointToC3(p: Point): Point },
  dip: { x: number; y: number }): Point {
  const r = space.fromDip({ x: dip.x, y: dip.y, width: 0, height: 0 });
  return space.pointToC3({ x: r.x, y: r.y });
}

/** AttentionSampler.pauseRendering: she renders for no one while the screen is locked or the system asleep; `changed` is
 *  told each change. */
export class SystemPause {
  paused = false;
  private locked = false;
  private asleep = false;
  private readonly changed: (paused: boolean) => void;

  constructor(changed: (paused: boolean) => void) {
    this.changed = changed;
  }

  lock(locked: boolean): void {
    this.locked = locked;
    this.update();
  }

  sleep(asleep: boolean): void {
    this.asleep = asleep;
    this.update();
  }

  private update(): void {
    const paused = this.locked || this.asleep;
    if (paused === this.paused) return;
    this.paused = paused;
    this.changed(paused);
  }
}

/** A window's helper `bounds` in her window's points, `frame` being her window in C3 global points. */
export function avatarPointRect(bounds: Box, mainHeight: number, frame: Box, y: HelperY): Box {
  return { x: bounds.x - frame.x, y: y(bounds.y, bounds.h, mainHeight) - frame.y, w: bounds.w, h: bounds.h };
}

/** For a `/feed` event: an `alert` has her point at its `target` window's bounds from
 *  `windows.list`, at null without the helper, that window or her frame; every nudge is logged. */
export async function handleNudge(e: StreamEvent,
  link: { readonly avatarFrame: Box | null; sendPointAt(nudgeId: string, rect: Box | null): boolean } | null,
  helper: { request(op: string): Promise<HelperReply> } | null, place: { helperY: HelperY; mainHeight(): number },
  log: (line: string) => void): Promise<void> {
  if (e.event !== 'nudge') return;
  let n: Record<string, unknown>;
  try {
    n = JSON.parse(e.data) as Record<string, unknown>;
  } catch {
    return;
  }
  const opt = (v: unknown, type: string) => v === undefined || v === null || typeof v === type;
  // These fields or no nudge.
  if (typeof n !== 'object' || n === null || !Number.isInteger(n.seq) || typeof n.nudge_id !== 'string' || typeof n.kind !== 'string'
    || typeof n.level !== 'string' || typeof n.speak !== 'boolean' || !(opt(n.target, 'number') && (n.target == null || Number.isInteger(n.target)))
    || !opt(n.line_id, 'string') || !opt(n.gate, 'string')) return;
  let result = 'none';
  if (n.kind === 'alert') {
    let rect: Box | null = null;
    const frame = link?.avatarFrame ?? null;
    if (n.target != null && helper && frame) {
      const r = await helper.request('windows.list');
      const w = r.ok ? readWindows(r.result).find((x) => x.id === n.target) : undefined;
      if (w) rect = avatarPointRect(w.bounds, place.mainHeight(), frame, place.helperY);
    }
    const shown = rect ? [rect.x, rect.y, rect.w, rect.h].map(Math.round).join(',') : 'null';
    result = link?.sendPointAt(n.nudge_id, rect) ? `point_at rect=${shown}` : 'point_at no_avatar';
  }
  log(`NUDGE kind=${n.kind} target=${n.target ?? 'null'} speak=${n.speak} gate=${n.gate ?? 'null'} result=${result}`);
}

/** CharacterView.current, which `desktop.onState` and the preview show; null for none. */
export function currentCharacterOf(switcher: { readonly current: string | null } | null,
  link: { readonly currentCharacter: string | null } | null, launched: string): string | null {
  return switcher?.current ?? link?.currentCharacter ?? (launched === '' ? null : launched);
}

/** config.json's `notify_*` and `system_notifications` with their defaults. While `quiet` (免打扰) an approval
 *  that would sound only shows its card. */
export function notifySettings(s: Record<string, unknown>, quiet: boolean): { modes: Record<'done' | 'waiting' | 'error' | 'brief' | 'reminder', NotifyMode>;
  systemNotifications: boolean; } {
  const mode = (key: string, fallback: NotifyMode): NotifyMode => (['sound', 'card', 'silent'].includes(s[key] as string) ? s[key] as NotifyMode : fallback);
  const waiting = mode('notify_approval', 'sound');
  return { modes: { done: mode('notify_done', 'card'), waiting: quiet && waiting === 'sound' ? 'card' : waiting, error: mode('notify_error', 'sound'),
    brief: mode('notify_brief', 'card'), reminder: mode('notify_reminder', 'sound') }, systemNotifications: s.system_notifications !== false };
}

/** A character package installed: the running shell's config, which the renderer and agentd launch from, takes the roster
 *  config.json `fresh` now has. */
export function refreshRoster(config: Pick<Config, 'characters' | 'character'>, fresh: Pick<Config, 'characters' | 'character'>): void {
  config.characters = fresh.characters;
  // An empty library's is '' until a character is installed.
  config.character = fresh.character;
}

/** The directory agentic-complex-ui://app/ serves and the UI art beside it (null: inside it): the vite dev server's
 *  checkout, else `<dev_resources>/ui` once a deployment has it, else the packaged web-ui
 *  component's pages, else web/dist with the release profile's art. */
export function pagesRoot(o: { devWeb: string | null; webSrc: string; packaged: string | null; webDist: string; uiArt: string | null;
  devResources: string | null; }): { root: string; art: string | null } {
  if (o.devWeb !== null) return { root: o.webSrc, art: o.packaged === null ? o.uiArt : null };
  const dev = o.devResources === null ? null : join(o.devResources, 'ui');
  // dev_deploy.py stages the art into ui/.
  if (dev !== null && existsSync(dev)) return { root: dev, art: null };
  return { root: o.packaged ?? o.webDist, art: o.packaged === null ? o.uiArt : null };
}
