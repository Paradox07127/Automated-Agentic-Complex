// The desktop panels' user offsets across launches: each under `desktopPanelOffset.v3.<kind>` in one JSON file of the
// support dir.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OffsetStore } from '../../common/desktop-follow.ts';
import type { PanelKind, UserOffset } from '../../common/desktop-layout.ts';

const PREFIX = 'desktopPanelOffset.v3.';
const SIDES = new Set(['left', 'right', 'above', 'below']);

export class OffsetFile implements OffsetStore {
  private readonly path: string;
  private readonly log: (line: string) => void;

  constructor(path: string, log: (line: string) => void) {
    this.path = path;
    this.log = log;
  }

  /** An entry that is not a side beside her with finite numbers reads as none. */
  get(kind: PanelKind): UserOffset | null {
    const d = this.read()[PREFIX + kind] as Record<string, unknown> | undefined;
    if (typeof d !== 'object' || d === null || typeof d.side !== 'string' || !SIDES.has(d.side)) return null;
    const { gap, along } = d;
    if (typeof gap !== 'number' || typeof along !== 'number' || !Number.isFinite(gap) || !Number.isFinite(along)) return null;
    return { side: d.side as UserOffset['side'], gap, along };
  }

  set(kind: PanelKind, offset: UserOffset): void {
    this.write({ ...this.read(), [PREFIX + kind]: { side: offset.side, gap: offset.gap, along: offset.along } });
  }

  clear(kind: PanelKind): void {
    const all = this.read();
    if (!(PREFIX + kind in all)) return;
    delete all[PREFIX + kind];
    this.write(all);
  }

  private read(): Record<string, unknown> {
    try {
      const v: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  /** A temp file renamed over the old one; a failed write is logged and the offset lasts this launch only. */
  private write(value: Record<string, unknown>): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(value));
      renameSync(temp, this.path);
    } catch (e) {
      this.log(`DESKTOP offsets_write_failed ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
