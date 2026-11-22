// 记忆管线的读法：四个工位的状态、传送带、顶栏一句话，全部由回包推出，不另取数据。
import type { VisualStateKey } from '../../domain/states';
import { formatClock } from '../../domain';
import { isoToMsOrNull } from '../../domain/units';

export type StationId = 'obs' | 'interp' | 'mem' | 'store';
export const STATIONS: readonly StationId[] = ['obs', 'interp', 'mem', 'store'];
export const isStation = (v: string | null): v is StationId => v != null && (STATIONS as readonly string[]).includes(v);

/** 全站状态词：在跑 / 空闲 / 堵住 / 出错了 / 已暂停 / 待确认，加上读取中和读不到。 */
export type Phase = 'run' | 'idle' | 'block' | 'fail' | 'pause' | 'wait' | 'loading' | 'unread';
export const PHASE: Readonly<Record<Phase, { key: VisualStateKey; label: string }>> = {
  run: { key: 'running', label: '在跑' },
  idle: { key: 'idle', label: '空闲' },
  block: { key: 'warning', label: '堵住' },
  fail: { key: 'failed', label: '出错了' },
  pause: { key: 'stopped', label: '已暂停' },
  wait: { key: 'waiting', label: '待确认' },
  loading: { key: 'idle', label: '读取中' },
  unread: { key: 'idle', label: '读不到' },
};

export interface StationState {
  phase: Phase;
  why: string | null;
}

const at = (phase: Phase, why: string | null = null): StationState => ({ phase, why });

/** /diag/state observation 和 budget.screenshots 里工位要的几项。 */
export interface ObsSeen {
  off?: boolean;
  paused_until?: string | null;
  quiet_until?: string | null;
  meeting?: boolean;
  pending?: ReadonlyArray<unknown>;
}

/** 观察：关 / 暂停 / 安静 / 开会 → 已暂停；额度用完 → 堵住；有等待中的请求 → 在跑。 */
export function obsState(o: ObsSeen | undefined, shots: { used: number; limit: number } | null): StationState {
  if (o?.off) return at('pause', '观察已关');
  const paused = isoToMsOrNull(o?.paused_until);
  if (paused != null) return at('pause', `到 ${formatClock(paused)}`);
  const quiet = isoToMsOrNull(o?.quiet_until);
  if (quiet != null) return at('pause', `安静到 ${formatClock(quiet)}`);
  if (o?.meeting) return at('pause', '开会中');
  if (shots && shots.limit > 0 && shots.used >= shots.limit) return at('block', '截图额度已满');
  const n = o?.pending?.length ?? 0;
  return n > 0 ? at('run', `等 ${n} 个请求`) : at('idle');
}

/** 理解：最近一次失败 → 出错了（原因只用回包的 error）；否则空闲，写上次的时间。 */
export function interpState(runs: ReadonlyArray<{ at: number; outcome: string; error: string | null }>): StationState {
  const last = runs[0];
  if (!last) return at('idle');
  if (last.outcome === 'failed') return at('fail', last.error ?? '理解失败');
  return at('idle', `上次 ${formatClock(last.at)}`);
}

/** 整理只看后台整理的批次：记忆暂停 → 已暂停；最新一批在跑 → 在跑；失败或退回 → 出错了。 */
export function memState(paused: boolean, extract: ReadonlyArray<{ at: number; end: number | null; state: string }>): StationState {
  if (paused) return at('pause', '记忆已暂停');
  const last = extract[0];
  if (!last) return at('idle');
  if (last.state === 'running') return at('run', `整理 ${formatClock(last.at)} 开始`);
  if (last.state === 'failed') return at('fail', '整理失败');
  if (last.state === 'rejected') return at('fail', '校验未通过');
  return at('idle', `上次 ${formatClock(last.end ?? last.at)}`);
}

export const storeState = (candidates: number): StationState => (candidates > 0 ? at('wait', `${candidates} 条`) : at('idle'));

export type BeltTone = 'fail' | 'block' | 'pause' | null;

/** 一条带子的样子只看它下游的工位：出错红、堵住橙、暂停灰，否则照常。 */
export const beltTone = (down: Phase, stale: boolean): BeltTone => (stale ? 'pause' : down === 'fail' || down === 'block' || down === 'pause' ? down : null);

export type States = Readonly<Record<StationId, StationState>>;

/** 三条带子：观察→理解（观察堵住时算它自己的）、合流进整理、整理→记忆库（记忆库待确认或整理出错时照常）。 */
export function belts(s: States, stale: boolean): [BeltTone, BeltTone, BeltTone] {
  const first = s.obs.phase === 'block' ? s.obs.phase : s.interp.phase;
  const last = s.store.phase === 'wait' || s.mem.phase === 'fail' ? 'idle' : s.store.phase;
  return [beltTone(first, stale), beltTone(s.mem.phase, stale), beltTone(last, stale)];
}

/** 出事的工位：先出错，再堵住。 */
export const troubled = (s: States): StationId | null => STATIONS.find((k) => s[k].phase === 'fail') ?? STATIONS.find((k) => s[k].phase === 'block') ?? null;

/** 顶栏一句话：几处出错 / 堵住 / 暂停，否则全线正常；还在读时不写。 */
export function lineWord(s: States): { phase: 'fail' | 'block' | 'pause' | 'ok'; text: string } | null {
  if (STATIONS.some((k) => s[k].phase === 'loading')) return null;
  for (const [phase, word] of [['fail', '出错了'], ['block', '堵住'], ['pause', '已暂停']] as const) {
    const n = STATIONS.filter((k) => s[k].phase === phase).length;
    if (n > 0) return { phase, text: `${n} 处${word}` };
  }
  return { phase: 'ok', text: '全线正常' };
}

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? null;
}

export const startOfDay = (t: number) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
