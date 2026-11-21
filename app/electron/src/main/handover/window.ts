// Option held as a drag of her ends over another app's window: 快速输入 opens with that
// window attached, or a notice says why not. Option is read through `input.modifiers`, the window through `windows.at_point`.
import type { HelperY } from '../../common/attention.ts';
import { pointWindow, type WindowCommand, windowHandover } from '../../common/handover.ts';
import type { Point } from '../../common/placement.ts';
import { allowsRequest, contextPolicy } from '../../common/screen-context.ts';
import type { HelperReply } from '../helper/client.ts';

export interface WindowPorts {
  helper: { request(op: string, params?: Record<string, unknown>): Promise<HelperReply> };
  /** config.json as saved now. */
  settings(): Record<string, unknown>;
  /** C3's y of the helper's coordinates on this platform (`helperYFor`). */
  helperY: HelperY;
  /** The main display's height. */
  mainHeight(): number;
  /** Null until the desktop layer is up. */
  desktop(): { notice(text: string): void; openQuickInput(first: WindowCommand): void } | null;
}

/** HostLink's `onDragRelease`: `at` in C3 global points, `excludedPids` her renderer's and this shell's. */
export async function dragRelease(o: WindowPorts, at: Point, excludedPids: readonly number[]): Promise<void> {
  const modifiers = await o.helper.request('input.modifiers');
  const optionDown = modifiers.ok && modifiers.result.alt === true;
  let window = null;
  if (optionDown) {
    const found = await o.helper.request('windows.at_point', { point: { x: at.x, y: o.helperY(at.y, 0, o.mainHeight()) },
      exclude_pids: [...excludedPids], layer0_only: true, include_titles: true });
    window = found.ok ? pointWindow(found.result) : null;
  }
  const decided = windowHandover(optionDown, allowsRequest(contextPolicy(o.settings()), 'text'), window);
  if (decided.kind === 'refuse') o.desktop()?.notice(decided.text);
  if (decided.kind === 'window') o.desktop()?.openQuickInput(decided);
}

/** The link's `onDragRelease` as index.ts gives it; null with `--no-attention` (test and host runs), so no window is read. */
export function shellWindowHandover(o: WindowPorts & { argv: readonly string[] }):
  ((at: Point, excludedPids: readonly number[]) => void) | null {
  if (o.argv.includes('--no-attention')) return null;
  return (at, excludedPids) => { void dragRelease(o, at, excludedPids); };
}
