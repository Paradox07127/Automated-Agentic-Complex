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

const shotTimes: number[] = [];
for (const [h, n] of [[9, 4], [10, 6], [11, 5], [12, 3], [13, 2], [14, 17]] as const) {
  const span = h === 14 ? 30 : 60;
  for (let k = 0; k < n; k++) shotTimes.push(at(h, Math.floor(((k + 0.5) * span) / n), 20));
}
export const SHOT_TIMES = shotTimes;
export const SHOTS = [...shotTimes.map((t) => ({ t })), ...[at(10, 21), at(13, 6), at(14, 12)].map((t) => ({ t, kind: 'blocked' as const }))];
export const SAYS = [...[at(9, 31), at(10, 48), at(11, 47), at(13, 15), at(14, 3), at(14, 25)].map((t) => ({ t })), ...[at(10, 2), at(12, 40), at(14, 18)].map((t) => ({ t, kind: 'blocked' as const }))];

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
export const tokSum = (id: string) => CHANNELS.reduce((a, c) => a + (c.parts[id as keyof typeof c.parts] ?? 0), 0);

export const EPISODES = [
  { id: 'e1', t0: at(9, 2), t1: at(9, 48), label: '在 Xcode 改 HostLink' },
  { id: 'e2', t0: at(9, 55), t1: at(10, 40), label: '看 Metal 文档' },
  { id: 'e3', t0: at(11, 0), t1: at(11, 45), label: '排查 HostLink 断线' },
  { id: 'e4', t0: at(12, 45), t1: at(13, 5), label: '午休浏览' },
  { id: 'e5', t0: at(13, 10), t1: at(14, 32), label: '写周报 v2' },
];
const appName: Record<string, string> = { 1: 'Terminal', 2: 'Safari', 3: '会议', other: '其他' };
export const STRIP = ([[9, 2, 9, 48, 1], [9, 55, 10, 40, 2], [11, 0, 11, 45, 3], [12, 45, 13, 5, 2], [13, 10, 13, 40, 1], [13, 40, 13, 52, 'other'], [13, 52, 14, 32, 1]] as const).map(([a, b, c, d, k], i) => ({ id: `a${i}`, t0: at(a, b), t1: at(c, d), cat: k, label: appName[k] }));

export const play = (n: number) => Array.from({ length: 24 }, (_, h) => (h < 8 || h > 14 ? 0 : Math.round(rnd() * n)));
