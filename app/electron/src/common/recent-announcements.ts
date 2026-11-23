// 最近播报: the last 20 feed `announce`s, newest first. Read state lives only here and is gone after a restart; a
// `terminal` takes back the entries its slot posted since the last one.
import type { MenuAnnouncement } from './menus.ts';
import type { StreamEvent } from './page.ts';

export const RECENT_LIMIT = 20;

interface Entry { id: string; text: string; at: number; sessionId: string | null; unread: boolean }

const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const pad = (n: number) => String(n).padStart(2, '0');

export class RecentAnnouncements {
  private entries: Entry[] = [];
  /** Entry ids per agentd slot since its last `terminal`, oldest first. */
  private progress = new Map<string, string[]>();
  /** Called after each change of the rows. */
  onChange: (() => void) | null = null;

  /** A `/feed` event, `at` epoch ms; only an `announce` that decodes counts. */
  receive(e: StreamEvent, at: number): void {
    if (e.event !== 'announce') return;
    let a: Record<string, unknown>;
    try {
      a = JSON.parse(e.data) as Record<string, unknown>;
    } catch {
      // feedAnnounce's `try?`: what does not decode is no announce.
      return;
    }
    if (typeof a !== 'object' || a === null || !Number.isInteger(a.seq) || typeof a.level !== 'string' || typeof a.kind !== 'string'
      || typeof a.headline !== 'string' || typeof a.speak !== 'boolean') return;
    const id = `announce-${a.seq as number}`, sessionId = text(a.session_id);
    // agentd's slot: the session, else the project, else the kind.
    const slot = sessionId ?? text(a.project) ?? a.kind;
    if (a.state === 'terminal') {
      const gone = this.progress.get(slot) ?? [];
      this.progress.delete(slot);
      this.entries = this.entries.filter((x) => !gone.includes(x.id));
    } else {
      this.progress.set(slot, [...(this.progress.get(slot) ?? []), id]);
    }
    this.entries = [{ id, text: a.headline, at, sessionId, unread: true }, ...this.entries.filter((x) => x.id !== id)]
      .slice(0, RECENT_LIMIT);
    this.onChange?.();
  }

  /** The submenu's rows, newest first, at the local `HH:mm` each came. */
  rows(): MenuAnnouncement[] {
    return this.entries.map((x) => {
      const d = new Date(x.at);
      return { id: x.id, text: x.text, time: `${pad(d.getHours())}:${pad(d.getMinutes())}`, unread: x.unread };
    });
  }

  /** Marks it read; the session it selects, null without one or when it is gone. */
  open(id: string): string | null {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return null;
    e.unread = false;
    this.onChange?.();
    return e.sessionId;
  }

  markAllRead(): void {
    for (const e of this.entries) e.unread = false;
    this.onChange?.();
  }
}
