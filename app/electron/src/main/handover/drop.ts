// 交给她 by a drop on her: a motion among the dropped
// files is imported straight into the current character, the rest is a drop card on the desktop layer, or waits for it.
import { randomUUID } from 'node:crypto';
import { DropBacklog, type DropSplit, dropEventItems, splitMotion } from '../../common/handover.ts';
import { PageSession } from '../../common/page.ts';
import type { DropItem, HandedItem } from '../../common/stack-cards.ts';
import { characterOps, type ImportPicker } from '../ops/character.ts';
import type { OpsContext } from '../ops/context.ts';
import type { DropEvent } from '../renderer/link.ts';

/** What a drop needs of the desktop layer: `source.addDrop` and `notice`. */
export interface DropDesktop { addDrop(items: HandedItem[], truncated: boolean): void; notice(text: string): void }

export type DroppedMotion = Pick<DropSplit, 'extras' | 'bgm'> & { source: string };

export interface DropPorts {
  /** Null until the desktop layer is up. */
  desktop(): DropDesktop | null;
  /** `character.importMotion`'s reply for these files (`opsMotionImport`). */
  importMotion(files: DroppedMotion): Promise<Record<string, unknown>>;
  /** The hostlink log. */
  log(line: string): void;
}

export class DropHandover {
  /** The path of each file handed to her this session, by the handle on its card; `POST /agent/scopes` reads only these
   *  and picked ones (swapHandles). */
  readonly dropped = new Map<string, string>();
  private readonly o: DropPorts;
  private readonly backlog = new DropBacklog();

  constructor(o: DropPorts) {
    this.o = o;
  }

  /** HostLink's `onDrop`. */
  drop(e: DropEvent): void {
    const split = splitMotion(dropEventItems(e.items));
    if (split.source !== null) void this.importMotion({ source: split.source, extras: split.extras, bgm: split.bgm });
    if (split.rest.length > 0) this.add(split.rest, e.truncated, this.o.log);
  }

  /** A drop on her or the handed-over clipboard. */
  add(items: DropItem[], truncated: boolean, log: (line: string) => void): void {
    const desktop = this.o.desktop();
    if (desktop) {
      desktop.addDrop(this.handed(items), truncated);
    } else {
      this.backlog.add(items, truncated);
      log(`drop queued: desktop layer not ready count=${this.backlog.count}`);
    }
  }

  /** The desktop layer is up (webStackOverlays): the waiting drops go to it. */
  desktopReady(): void {
    const desktop = this.o.desktop();
    if (!desktop) return;
    for (const d of this.backlog.drain()) desktop.addDrop(this.handed(d.items), d.truncated);
  }

  /** `items` with a handle recorded for each file. */
  private handed(items: DropItem[]): HandedItem[] {
    return items.map((i) => {
      if (i.kind !== 'file') return i;
      const handle = randomUUID().toUpperCase();
      this.dropped.set(handle, i.path);
      return { ...i, handle };
    });
  }

  private async importMotion(files: DroppedMotion): Promise<void> {
    const reply = await this.o.importMotion(files);
    if (reply.ok === true) this.o.desktop()?.notice(`已导入动作：${(reply.action as { title?: unknown }).title}`);
    else if (reply.reason !== 'cancelled') this.o.desktop()?.notice(`导入失败：${reply.detail}`);
  }
}

/** `character.importMotion` answered with the dropped files instead of its panels; without her character library, link or
 *  switch it is 角色还没连上. */
export function opsMotionImport(ctx: OpsContext): DropPorts['importMotion'] {
  return async (files) => {
    if (!ctx.library?.catalog || !ctx.avatar || !ctx.switcher) return { ok: false, reason: 'internal', detail: '角色还没连上' };
    let asked = 0;
    // The first ask is the motion panel, the second the BGM panel.
    const picker: ImportPicker = {
      files: async () => (asked++ === 0 ? [files.source, ...files.extras] : files.bgm === null ? [] : [files.bgm]),
      folder: async () => null,
    };
    // The op reads no page.
    return await characterOps(ctx, picker)['character.importMotion']!([], new PageSession(() => {})) as Record<string, unknown>;
  };
}
