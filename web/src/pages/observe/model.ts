// 观察页的派生计算：应用排名和分类色、应用占比、按小时柱、片段内各应用分钟、时间线范围。
import type { StackBucket } from '../../charts';
import type { AppTime, Episode } from '../../domain';

export interface ObsSegment {
  id: string;
  app: string;
  t0: number;
  t1: number;
}

export interface ObsShot {
  t: number;
  app: string;
}

const HOUR = 3_600_000;
const HALF = HOUR / 2;
const MIN = 60_000;
/** The server's own rest bucket in `/attention/summary`. */
const REST_KEY = '其他';

export type Cat = 1 | 2 | 3 | 'other';

/** Apps by today's foreground time: the first three get category colours 1–3, the rest are 其他. */
export interface AppRank {
  order: string[];
  minutes: Record<string, number>;
  /** Minutes the server already lumped into 其他. */
  rest: number;
}

export function rankFromSummary(apps: ReadonlyArray<AppTime>): AppRank {
  const named = apps.filter((a) => a.app !== REST_KEY);
  const minutes = Object.fromEntries(named.map((a) => [a.app, Math.round(a.seconds / 60)]));
  const rest = Math.round(apps.filter((a) => a.app === REST_KEY).reduce((n, a) => n + a.seconds, 0) / 60);
  return {
    order: [...named].sort((a, b) => b.seconds - a.seconds).map((a) => a.app),
    minutes,
    rest,
  };
}

/** Minutes of `s` inside [a, b]. */
export const overlapMin = (s: { t0: number; t1: number }, a: number, b: number) => Math.max(0, (Math.min(b, s.t1) - Math.max(a, s.t0)) / MIN);

export function rankFromSegments(segs: ReadonlyArray<ObsSegment>): AppRank {
  const minutes: Record<string, number> = {};
  for (const s of segs) minutes[s.app] = (minutes[s.app] ?? 0) + (s.t1 - s.t0) / MIN;
  for (const k of Object.keys(minutes)) minutes[k] = Math.round(minutes[k] ?? 0);
  return {
    order: Object.keys(minutes).sort((a, b) => (minutes[b] ?? 0) - (minutes[a] ?? 0)),
    minutes,
    rest: 0,
  };
}

export const catOf = (rank: AppRank, app: string): Cat => {
  const i = rank.order.indexOf(app);
  return i >= 0 && i < 3 ? ((i + 1) as Cat) : 'other';
};
export const colorOf = (c: Cat) => `var(--ef-cat-${c})`;

export interface ShareItem {
  id: string;
  label: string;
  sub?: string;
  minutes: number;
  color: string;
}

/** Top three apps plus 其他 (the rest by name, and the server's own rest bucket). */
export function shareOf(rank: AppRank): ShareItem[] {
  const top = rank.order.slice(0, 3);
  const rest = rank.order.slice(3);
  const other = rest.reduce((n, k) => n + (rank.minutes[k] ?? 0), rank.rest);
  return [
    ...top.map((k, i) => ({
      id: k,
      label: k,
      minutes: rank.minutes[k] ?? 0,
      color: colorOf((i + 1) as Cat),
    })),
    ...(other > 0
      ? [
          {
            id: 'other',
            label: '其他',
            ...(rest.length ? { sub: rest.join('、') } : {}),
            minutes: other,
            color: colorOf('other'),
          },
        ]
      : []),
  ];
}

/** Foreground minutes per hour from `from` to `to` (exclusive), split into the top three apps and 其他. */
export function hoursOf(segs: ReadonlyArray<ObsSegment>, rank: AppRank, from: number, to: number): StackBucket[] {
  const top = rank.order.slice(0, 3);
  const out: StackBucket[] = [];
  for (let h = from; h < to; h += HOUR) {
    const parts: Record<string, number> = Object.fromEntries([...top, 'other'].map((k) => [k, 0]));
    for (const s of segs) {
      const k = top.includes(s.app) ? s.app : 'other';
      parts[k] = (parts[k] ?? 0) + overlapMin(s, h, h + HOUR);
    }
    for (const k of Object.keys(parts)) parts[k] = Math.round(parts[k] ?? 0);
    out.push({
      key: `h${h}`,
      label: String(new Date(h).getHours()).padStart(2, '0'),
      parts,
    });
  }
  return out;
}

/** Apps used inside an episode, most first; minutes only when the per-span events exist. */
export function episodeApps(e: Episode, segs: ReadonlyArray<ObsSegment> | null, end: number): Array<{ app: string; minutes: number | null }> {
  if (!segs) return e.apps.map((app) => ({ app, minutes: null }));
  const m: Record<string, number> = {};
  for (const s of segs) m[s.app] = (m[s.app] ?? 0) + overlapMin(s, e.start, e.end ?? end);
  return Object.entries(m)
    .map(([app, v]) => ({ app, minutes: Math.round(v) }))
    .filter((x) => x.minutes > 0)
    .sort((a, b) => b.minutes - a.minutes);
}

/** Visible range: from the half hour before the first episode (six hours back when there is none) to the hour after now. */
export function rangeOf(episodes: ReadonlyArray<Episode>, start: number, end: number, today: boolean): [number, number] {
  const first = episodes.length ? Math.min(...episodes.map((e) => e.start)) : end - 6 * HOUR;
  const t0 = Math.max(start, Math.floor((first - 15 * MIN) / HALF) * HALF);
  const last = today ? end + 15 * MIN : Math.max(...episodes.map((e) => e.end ?? e.start), t0 + 6 * HOUR);
  return [t0, Math.min(start + 24 * HOUR, Math.ceil(last / HOUR) * HOUR)];
}
