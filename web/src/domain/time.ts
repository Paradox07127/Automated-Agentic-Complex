// Time formatting shared by every readout. Inputs are epoch ms or durations in ms.

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Local wall clock: `14:32`, or `14:32:04` with seconds. */
export function formatClock(at: number, opts: { seconds?: boolean } = {}): string {
  const d = new Date(at);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return opts.seconds ? `${hm}:${pad2(d.getSeconds())}` : hm;
}

/** Live running counter: `00:42`, `09:55`, `1:02:03`. Floors, so a longer span never prints smaller. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = pad2(Math.floor((s % 3600) / 60));
  const ss = pad2(s % 60);
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Static duration: `42 秒`, `6 分`, `1 小时 12 分`; with `seconds`: `6 分 05 秒`. Floors like `formatElapsed`. */
export function formatDuration(ms: number, opts: { seconds?: boolean } = {}): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return opts.seconds ? `${m} 分 ${pad2(s % 60)} 秒` : `${m} 分`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/** Running span in its largest whole unit: `42 秒`, `7 分`, `2 小时`, `3 天`. Floors. */
export function formatSpan(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} 小时` : `${Math.floor(h / 24)} 天`;
}

/** Time ago in its largest whole unit: `刚刚`, `6 分前`, `3 小时前`, `22 天前`. Floors. */
export function formatAgo(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分前`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} 小时前` : `${Math.floor(h / 24)} 天前`;
}

/** Sub-second precision readout: `880 ms`, `1.2 s`, `42 s`. */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s`;
}

/** Countdown text: `剩余 41 秒`, `剩余 2 分 05 秒`, `已超时`; null means no deadline. A part second left still counts as one. */
export function formatRemaining(secondsLeft: number | null | undefined): string {
  if (secondsLeft == null) return '不限时';
  if (secondsLeft <= 0) return '已超时';
  const s = Math.ceil(secondsLeft);
  if (s < 60) return `剩余 ${s} 秒`;
  return `剩余 ${Math.floor(s / 60)} 分 ${pad2(s % 60)} 秒`;
}

/** Remaining time is short enough to switch to danger (≤ 10 s). */
export function isUrgent(secondsLeft: number | null | undefined): boolean {
  return secondsLeft != null && secondsLeft <= 10;
}

/**
 * Elapsed time of a run and stall time of its current step, from the same clock.
 * A step cannot start before its run, so `stall_ms <= elapsed_ms` always holds.
 */
export function runTiming(
  runStartedAt: number,
  stepSince: number | null,
  now: number,
): { elapsed_ms: number; stall_ms: number | null } {
  const elapsed = Math.max(0, now - runStartedAt);
  if (stepSince == null) return { elapsed_ms: elapsed, stall_ms: null };
  return { elapsed_ms: elapsed, stall_ms: Math.max(0, now - Math.max(stepSince, runStartedAt)) };
}
