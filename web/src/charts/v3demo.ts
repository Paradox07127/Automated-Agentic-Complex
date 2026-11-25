// Fixture day for the chart demos (prototype pages/desktop.js V3D): 2026-10-29, now 14:32.
export const at = (h: number, m: number, s = 0) => new Date(2026, 9, 29, h, m, s).getTime();
export const NOW = at(14, 32);
export const DAY0 = NOW - 86_400_000;

let seed = 7;
const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const half = Array.from({ length: 49 }, (_, i) => DAY0 + i * 1_800_000);
const hr = (t: number) => new Date(t).getHours() + new Date(t).getMinutes() / 60;

export const ENERGY: Array<[number, number | null]> = half.map((t) => [t, +clamp(0.5 + 0.32 * Math.sin(((hr(t) - 10) / 12) * Math.PI) + (rnd() - 0.5) * 0.08, 0, 1).toFixed(2)]);
export const MOOD: Array<[number, number | null]> = half.map((t, i) => [t, i >= 18 && i <= 21 ? null : +clamp(0.12 + 0.3 * Math.sin(i / 6) + (rnd() - 0.5) * 0.12, -1, 1).toFixed(2)]);

export const APPS = [
  { id: 'term', label: 'Terminal', color: 'var(--ef-cat-1)' },
  { id: 'web', label: 'Safari', color: 'var(--ef-cat-2)' },
  { id: 'meet', label: '会议', color: 'var(--ef-cat-3)' },
  { id: 'other', label: '其他', color: 'var(--ef-cat-other)' },
];
const byHour: Record<number, number[]> = { 8: [0, 6, 0, 2], 9: [38, 12, 0, 4], 10: [20, 32, 0, 3], 11: [8, 4, 45, 1], 12: [2, 18, 0, 9], 13: [44, 9, 0, 2], 14: [30, 2, 0, 0] };
export const HOURS = Array.from({ length: 13 }, (_, i) => i + 8).map((h) => ({ key: `h${h}`, label: String(h).padStart(2, '0'), parts: Object.fromEntries(APPS.map((a, k) => [a.id, byHour[h]?.[k] ?? 0])) }));
export const HOUR_TOTAL = HOURS.map((b) => ({ key: b.key, label: b.label, parts: { min: Object.values(b.parts).reduce((a, v) => a + v, 0) } }));

export const TOK = [
  { id: 'new', label: '新输入' },
  { id: 'cache', label: '缓存' },
  { id: 'out', label: '输出' },
];
export const CHANNELS = [
  { key: 'mouth', label: '对话回复', parts: { new: 96_000, cache: 300_000, out: 56_000 } },
  { key: 'agent', label: '角色运行', parts: { new: 48_000, cache: 105_000, out: 7_000 } },
  { key: 'obs', label: '观察摘要', parts: { new: 26_000, cache: 61_000, out: 1_000 } },
  { key: 'dec', label: '动作决策', parts: { new: 12_000, cache: 32_000, out: 1_000 } },
];
