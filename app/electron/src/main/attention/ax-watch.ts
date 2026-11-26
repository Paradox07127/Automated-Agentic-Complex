// Shared `ax.watch` multiplexer so ActivityRecorder and ContextCapturer reuse a single helper AXObserver per PID.
import type { HelperAnswer } from '../../common/push-to-talk.ts';

export interface AxWatchSubscriber {
  pid: number | null;
  notifications: readonly string[];
  readSelectedText?: boolean;
  readValue?: boolean;
  manualAccessibility?: boolean;
  onNotification(data: Record<string, unknown>): void;
}

export interface AxWatchHelper {
  request(op: string, params?: Record<string, unknown>): Promise<HelperAnswer>;
}

const WATCH_ID = 'shared';

export class AxWatchMux {
  private readonly helperRef: AxWatchHelper;
  private readonly subscribers = new Map<string, AxWatchSubscriber>();
  private watchedKey: string | null = null;
  private watchedPid: number | null = null;
  private lastAnswer: HelperAnswer | null = null;
  private pending: Promise<HelperAnswer> | null = null;

  constructor(helper: AxWatchHelper) {
    this.helperRef = helper;
  }

  async set(id: string, sub: AxWatchSubscriber | null): Promise<HelperAnswer | null> {
    if (sub === null || sub.pid === null) this.subscribers.delete(id);
    else this.subscribers.set(id, sub);
    return this.sync();
  }

  helper(running: boolean): void {
    if (!running) {
      this.watchedKey = null;
      this.watchedPid = null;
      this.lastAnswer = null;
    }
  }

  event(name: string, data: Record<string, unknown>): void {
    if (name !== 'ax.notification') return;
    if (data.watch_id !== undefined && data.watch_id !== WATCH_ID) return;
    for (const sub of this.subscribers.values()) {
      if (sub.pid !== null && sub.pid === data.pid) sub.onNotification(data);
    }
  }

  private async sync(): Promise<HelperAnswer | null> {
    const active = [...this.subscribers.values()].filter((s) => s.pid !== null);
    if (active.length === 0) {
      if (this.watchedPid === null) return null;
      this.watchedPid = null;
      this.watchedKey = null;
      this.lastAnswer = null;
      return this.helperRef.request('ax.watch', { watch_id: WATCH_ID, pid: null, notifications: [] });
    }
    const pid = active[0]!.pid!;
    const samePid = active.filter((s) => s.pid === pid);
    const notifications = [...new Set(samePid.flatMap((s) => s.notifications))].sort();
    const readSelected = samePid.some((s) => s.readSelectedText === true);
    const readValue = samePid.some((s) => s.readValue === true);
    const manual = samePid.some((s) => s.manualAccessibility === true);
    const key = `${pid}:${notifications.join(',')}:${readSelected ? 1 : 0}:${readValue ? 1 : 0}:${manual ? 1 : 0}`;
    if (key === this.watchedKey) {
      if (this.pending !== null) return this.pending;
      return this.lastAnswer;
    }
    this.watchedPid = pid;
    this.watchedKey = key;
    const params: Record<string, unknown> = {
      watch_id: WATCH_ID,
      pid,
      notifications,
      ...(readSelected && { read_selected_text: true }),
      ...(readValue && { read_value: true }),
      ...(manual && { manual_accessibility: true }),
    };
    const req = this.helperRef.request('ax.watch', params);
    this.pending = req;
    try {
      const answer = await req;
      if (this.watchedKey === key) this.lastAnswer = answer;
      return answer;
    } finally {
      if (this.pending === req) this.pending = null;
    }
  }
}
