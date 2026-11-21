// 框选给她看…: the AX text in a dragged region opens 快速输入 as a 框选 attachment, or a notice says why
// nothing was read. The selection window (region-window.ts) and the region read (context/capturer.ts readRegion) are ports.
import type { HelperY, Rect as HelperRect } from '../../common/attention.ts';
import type { SelectionCommand } from '../../common/desktop-hotkey.ts';
import type { RegionRead } from '../../common/handover.ts';
import type { Rect } from '../../common/placement.ts';

export interface RegionPorts {
  /** The dragged rect in C3 global points, or null for a cancel. */
  select(): Promise<Rect | null>;
  /** ContextCapturer.readRegion: `rect` in the helper's coordinates; null without a context capturer. */
  read: ((rect: HelperRect, excluding: readonly number[]) => Promise<RegionRead>) | null;
  /** This shell's and her renderer's pids, whose windows are never read. */
  excluded(): readonly number[];
  /** C3's y of the helper's coordinates on this platform (`helperYFor`). */
  helperY: HelperY;
  mainHeight(): number;
  /** Null until the desktop layer is up. */
  desktop(): { notice(text: string): void; openQuickInput(first: SelectionCommand): void } | null;
  /** The menus' log. */
  log(line: string): void;
}

export async function selectRegion(o: RegionPorts): Promise<void> {
  const read = o.read;
  if (read === null) return o.log('region handover: no context capturer (config failed)');
  const rect = await o.select();
  if (rect === null) return;
  const r = await read({ x: rect.x, y: o.helperY(rect.y, rect.h, o.mainHeight()), width: rect.w, height: rect.h }, o.excluded());
  const desktop = o.desktop();
  if (r.kind === 'read') {
    if (desktop) desktop.openQuickInput({ kind: 'selection', source: 'region', text: r.text, app: r.app, truncated: r.truncated });
    else o.log('region handover: desktop layer not ready');
  } else if (desktop) {
    desktop.notice(r.text);
  } else {
    o.log(`region handover: ${r.text} (desktop layer not ready)`);
  }
}
