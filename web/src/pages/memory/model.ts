import type { Fact, FactKind, MemorySource, WireFactVersion } from '../../domain';

/** Source words: short tag and full name; the key is `?src=`'s short form. */
export const SRC: Record<MemorySource, { short: string; full: string; key: string }> = {
  asserted_by_user: { short: '陈述', full: '用户陈述', key: 'asserted' },
  observed_context: { short: '观察', full: '观察所得', key: 'observed' },
  confirmed_by_user: { short: '确认', full: '用户确认', key: 'confirmed' },
  inferred_hypothesis: { short: '推断', full: '推断', key: 'inferred' },
};
/** Who wrote a version (`GET /memory/facts/{id}/versions` `by`). */
export const BY: Record<NonNullable<WireFactVersion['by']>, string> = { user: '你', character: '角色', pipeline: '后台整理', integration: '外部工具' };
export const SRC_ORDER: MemorySource[] = ['asserted_by_user', 'observed_context', 'confirmed_by_user', 'inferred_hypothesis'];

/** The line under 来源 in the detail; a confirmed fact read from an episode was seen before it was confirmed. */
export function howText(f: Pick<Fact, 'source' | 'evidence'>): string {
  if (f.source === 'asserted_by_user') return '你在对话里亲口说的';
  if (f.source === 'observed_context') return '从屏幕上看到的，还没问过你';
  if (f.source === 'inferred_hypothesis') return '猜的';
  return f.evidence.some((r) => r.startsWith('episode:')) ? '看到后，你点了「记住」' : '猜的，你点了「记住」';
}

/** The archive's categories over agentd's kinds (memory.py KINDS); 用户档案 is the nameplate, not a cell. */
export type Cat = 'about' | 'pref' | 'deal' | 'exp' | 'other';
export const CATS: Array<{ id: Cat; label: string; en: string }> = [
  { id: 'about', label: '用户档案', en: 'Profile' },
  { id: 'pref', label: '偏好', en: 'Preference' },
  { id: 'deal', label: '约定', en: 'Agreement' },
  { id: 'exp', label: '经历', en: 'Experience' },
  { id: 'other', label: '其他线索', en: 'Clue' },
];
const CAT_OF: Record<FactKind, Cat> = { name: 'about', birthday: 'about', fact: 'other', preference: 'pref', agreement: 'deal', experience: 'exp' };
/** A `fact` that reads as a field (时区：上海) is about the user; other facts are clues, kept with their evidence. */
export const catOf = (f: Pick<Fact, 'kind' | 'text'>): Cat => (f.kind === 'fact' && FIELD.test(f.text) ? 'about' : CAT_OF[f.kind]);
export const catLabel = (f: Pick<Fact, 'kind' | 'text'>) => CATS.find((c) => c.id === catOf(f))?.label ?? '';

/** Categories 新增 may take, with the kind each writes; name and birthday stay with onboarding. */
export const ADD_CATS: Array<{ kind: FactKind; label: string }> = [
  { kind: 'preference', label: '偏好' },
  { kind: 'agreement', label: '约定' },
  { kind: 'experience', label: '经历' },
  { kind: 'fact', label: '其他线索' },
];

/** The line a fact shows: name and birthday carry their label, everything else is the text itself. */
export const factText = (f: Pick<Fact, 'kind' | 'text'>) => (f.kind === 'name' ? `称呼：${f.text}` : f.kind === 'birthday' ? `生日：${f.text}` : f.text);

export const isCandidate = (f: Fact) => f.state === 'candidate';
/** memory.py STALE_AFTER: unused for 30 days. */
export const isDormant = (f: Fact) => f.stale === true;

const DAY_MS = 86_400_000;
const midnight = (t: number) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
/** Whole calendar days from `then` to `now` (0 = same day). */
export const daysAgo = (then: number, now: number) => Math.round((midnight(now) - midnight(then)) / DAY_MS);

export const hm = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
export const md = (t: number) => `${new Date(t).getMonth() + 1}/${new Date(t).getDate()}`;
/** 「2026.11.04」. */
export const ymd = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
};

/** 「今天 14:22」「昨天 21:30」「10月8日 20:14」. */
export function stamp(t: number, now: number): string {
  const d = daysAgo(t, now);
  const x = new Date(t);
  return `${d === 0 ? '今天' : d === 1 ? '昨天' : `${x.getMonth() + 1}月${x.getDate()}日`} ${hm(t)}`;
}

/** Uses per day over the last 14 days (index 13 = today) from `recent_uses`. */
export function useSpark(f: Fact, now: number): number[] {
  const out = Array<number>(14).fill(0);
  for (const u of f.uses) {
    const d = daysAgo(u.at, now);
    if (d >= 0 && d < 14) out[13 - d] = (out[13 - d] ?? 0) + 1;
  }
  return out;
}

/** agentd keeps the latest RECENT_USES (5) uses per fact; a full list means 5 or more. */
export const RECENT_CAP = 5;
export const useCount = (f: Fact) => (f.uses.length >= RECENT_CAP ? `${RECENT_CAP}+` : String(f.uses.length));
/** 「近 14 天用到 N 次」's N: uses of the last 14 days, 5+ once the kept list is full; null when there are none. */
export function recentText(f: Fact, now: number): string | null {
  const n = sum(useSpark(f, now));
  return n === 0 ? null : f.uses.length >= RECENT_CAP && n === f.uses.length ? `${RECENT_CAP}+` : String(n);
}

/** Facts recorded per day over the last 14 days (candidates are not memory yet). */
export function added14(facts: readonly Fact[], now: number): number[] {
  const out = Array<number>(14).fill(0);
  for (const f of facts) {
    if (isCandidate(f)) continue;
    const d = daysAgo(f.recorded_at, now);
    if (d >= 0 && d < 14) out[13 - d] = (out[13 - d] ?? 0) + 1;
  }
  return out;
}

export const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

export type Sort = 'new' | 'used' | 'idle';
export const SORTS: Array<{ value: Sort; label: string }> = [
  { value: 'new', label: '最新记下' },
  { value: 'used', label: '最常用到' },
  { value: 'idle', label: '最久没用' },
];
const lastUse = (f: Fact) => f.last_used_at ?? f.recorded_at;
export const SORTERS: Record<Sort, (a: Fact, b: Fact) => number> = {
  new: (a, b) => b.recorded_at - a.recorded_at,
  used: (a, b) => b.uses.length - a.uses.length || lastUse(b) - lastUse(a),
  idle: (a, b) => lastUse(a) - lastUse(b),
};

/** Search over the shown text, the source words and the category name. */
export function matches(f: Fact, q: string): boolean {
  const s = q.trim().toLowerCase();
  return !s || `${factText(f)} ${SRC[f.source].short}${SRC[f.source].full} ${catLabel(f)}`.toLowerCase().includes(s);
}

/** A short `标签：值` fact of the about group (时区：上海) reads as a field of the nameplate. */
export const FIELD = /^(时区|城市|所在城市|所在地|职业|语言|timezone|city|language)[：:]\s*(.{1,40})$/i;
const PLACE = /^(城市|所在城市|所在地|时区|city|timezone)$/i;

/** The nameplate: what she calls the user, the birthday, where they are, and how many facts are about them. */
export interface Plate {
  name: string | null;
  birthday: string | null;
  place: string | null;
  about: number;
}

export function plateOf(facts: readonly Fact[]): Plate {
  const active = facts.filter((f) => !isCandidate(f));
  const place = active.map((f) => (f.kind === 'fact' ? FIELD.exec(f.text) : null)).find((m) => m != null && PLACE.test(m[1] ?? ''));
  return {
    name: active.find((f) => f.kind === 'name')?.text ?? null,
    birthday: active.find((f) => f.kind === 'birthday')?.text ?? null,
    place: place?.[2] ?? null,
    about: active.filter((f) => catOf(f) === 'about').length,
  };
}
