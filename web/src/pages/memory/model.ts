import type { Fact, FactKind, MemorySource } from '../../domain';

/** Source words: short tag and full name; the page draws every source with the same grey square (inferred hatched). */
export const SRC: Record<MemorySource, { short: string; full: string; key: string }> = {
  asserted_by_user: { short: '陈述', full: '用户陈述', key: 'asserted' },
  observed_context: { short: '观察', full: '观察所得', key: 'observed' },
  confirmed_by_user: { short: '确认', full: '用户确认', key: 'confirmed' },
  inferred_hypothesis: { short: '推断', full: '推断', key: 'inferred' },
};
export const SRC_ORDER: MemorySource[] = ['asserted_by_user', 'observed_context', 'confirmed_by_user', 'inferred_hypothesis'];

/** List groups over agentd's kinds (memory.py KINDS). */
export type Group = 'about' | 'pref' | 'deal' | 'exp' | 'knowledge';
export const GROUPS: Array<{ id: Group; label: string }> = [
  { id: 'about', label: '基本信息' },
  { id: 'pref', label: '偏好' },
  { id: 'deal', label: '约定' },
  { id: 'exp', label: '经历' },
  { id: 'knowledge', label: '其他事实与线索' },
];
const GROUP_OF: Record<FactKind, Group> = { name: 'about', birthday: 'about', fact: 'knowledge', preference: 'pref', agreement: 'deal', experience: 'exp' };
/** Unclassified facts retain their evidence; they are not silently promoted to personal profile fields. */
export const isProfileFact = (f: Pick<Fact, 'kind' | 'text'>) => f.kind === 'fact' ? FIELD.test(f.text) : f.kind !== 'experience';
export const groupOf = (f: Pick<Fact, 'kind'> & Partial<Pick<Fact, 'text'>>) => f.kind === 'fact' && FIELD.test(f.text ?? '') ? 'about' : GROUP_OF[f.kind];
export const groupLabel = (f: Pick<Fact, 'kind'> & Partial<Pick<Fact, 'text'>>) => GROUPS.find((g) => g.id === groupOf(f))?.label ?? '';

/** Kinds 新增记忆 may take; name and birthday stay with onboarding. */
export const ADD_KINDS: Array<{ kind: FactKind; label: string }> = [
  { kind: 'fact', label: '其他事实' },
  { kind: 'preference', label: '偏好' },
  { kind: 'agreement', label: '约定' },
  { kind: 'experience', label: '经历' },
];

/** The line a fact shows: name and birthday carry their label, everything else is the text itself. */
export const factText = (f: Pick<Fact, 'kind' | 'text'>) => (f.kind === 'name' ? `称呼：${f.text}` : f.kind === 'birthday' ? `生日 ${f.text}` : f.text);

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

/** 「今天」「昨天」「3 天前」. */
export const agoText = (d: number) => (d <= 0 ? '今天' : d === 1 ? '昨天' : `${d} 天前`);
/** 「今天更新」…「3 周前更新」. */
export const updText = (d: number) => (d <= 0 ? '今天更新' : d === 1 ? '昨天更新' : d < 14 ? `${d} 天前更新` : `${Math.floor(d / 7)} 周前更新`);
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
  { value: 'new', label: '最新' },
  { value: 'used', label: '最常用' },
  { value: 'idle', label: '最久未用' },
];
const lastUse = (f: Fact) => f.last_used_at ?? f.recorded_at;
export const SORTERS: Record<Sort, (a: Fact, b: Fact) => number> = {
  new: (a, b) => b.recorded_at - a.recorded_at,
  used: (a, b) => b.uses.length - a.uses.length || lastUse(b) - lastUse(a),
  idle: (a, b) => lastUse(a) - lastUse(b),
};

/** Search over the shown text, the source words and the group name. */
export function matches(f: Fact, q: string): boolean {
  const s = q.trim().toLowerCase();
  return !s || `${factText(f)} ${SRC[f.source].short}${SRC[f.source].full} ${groupLabel(f)}`.toLowerCase().includes(s);
}

/** A short `标签：值` fact of the about group (时区：上海) reads as a field of the nameplate. */
export const FIELD = /^(时区|城市|所在城市|所在地|职业|语言|timezone|city|language)[：:]\s*(.{1,40})$/i;

export interface Profile {
  name: Fact | null;
  fields: Array<{ key: string; value: string; fact: Fact }>;
  /** 当前工作 / 偏好 / 约定: the most used active fact of each. */
  cells: Array<{ label: string; fact: Fact }>;
}

const mostUsed = (xs: Fact[]) => [...xs].sort(SORTERS.used)[0];

export function profileOf(facts: readonly Fact[]): Profile {
  const active = facts.filter((f) => !isCandidate(f));
  const birthday = active.find((f) => f.kind === 'birthday');
  const fieldFacts = active.filter((f) => f.kind === 'fact' && FIELD.test(f.text)).slice(0, 1);
  const fields = [
    ...(birthday ? [{ key: '生日', value: birthday.text, fact: birthday }] : []),
    ...fieldFacts.map((f) => {
      const m = FIELD.exec(f.text);
      return { key: m?.[1] ?? '', value: m?.[2] ?? '', fact: f };
    }),
  ];
  const pref = mostUsed(active.filter((f) => f.kind === 'preference'));
  const deal = mostUsed(active.filter((f) => f.kind === 'agreement'));
  return {
    name: active.find((f) => f.kind === 'name') ?? null,
    fields,
    cells: [
      ...(pref ? [{ label: '偏好', fact: pref }] : []),
      ...(deal ? [{ label: '约定', fact: deal }] : []),
    ],
  };
}

/** One change in a batch: 新增 / 更新 / 删除, the fact it touched (when still there) and the earlier text. */
export interface Change {
  op: 'add' | 'upd' | 'del';
  id: string | null;
  text: string;
  was?: string;
}

export interface Batch {
  id: string;
  at: number;
  items: Change[];
}

export const OPS: Record<Change['op'], { sym: string; label: string }> = {
  add: { sym: '+', label: '新增' },
  upd: { sym: '~', label: '更新' },
  del: { sym: '−', label: '删除' },
};

export const countOps = (items: readonly Change[]) => ({
  add: items.filter((x) => x.op === 'add').length,
  upd: items.filter((x) => x.op === 'upd').length,
  del: items.filter((x) => x.op === 'del').length,
});
