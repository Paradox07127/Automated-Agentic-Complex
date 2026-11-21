import type { MouseEvent } from 'react';
import { CAT, cx, dur, EMPH, hm, hms, paint, SEL } from './v3';
import l from './Timeline.module.css';

export type TimelineKind = 'blocks' | 'spans' | 'strip' | 'ticks' | 'dots' | 'markers';

/** blocks / spans / strip use t0–t1; ticks / dots / markers use t. Extra fields reach `renderTip`. */
export interface TimelineItem {
  id?: string;
  t?: number;
  t0?: number;
  t1?: number;
  label?: string;
  color?: string;
  tip?: string;
  /** strip：分类色 1–3 或「其他」 */
  cat?: 1 | 2 | 3 | 'other';
  /** dots：fail 画失败小方块；markers：diamond / tri */
  kind?: 'fail' | 'diamond' | 'tri';
  [extra: string]: unknown;
}

export interface TimelineLaneSpec {
  id: string;
  label: string;
  kind: TimelineKind;
  items: TimelineItem[];
  color?: string;
}

/** Lane rows' heights by kind. */
export const LANE_H: Record<TimelineKind, number> = { blocks: 24, spans: 28, strip: 8, ticks: 14, dots: 14, markers: 18 };

export const isPoint = (k: TimelineKind) => k === 'ticks' || k === 'dots' || k === 'markers';

/** Default readout of one item. */
export function itemTip(it: TimelineItem, lane: { label?: string }): string {
  if (it.tip) return it.tip;
  const when = it.t0 != null && it.t1 != null ? `${hm(it.t0)}–${hm(it.t1)} │ ${dur(it.t1 - it.t0)}` : it.t != null ? hms(it.t) : '';
  return [lane.label, it.label, when].filter(Boolean).join('\n');
}

export interface Cluster {
  items: TimelineItem[];
  x0: number;
  x1: number;
}

/** Point items merged while closer than 4 px (12 px for markers) on screen. */
export function clusters(kind: TimelineKind, items: ReadonlyArray<TimelineItem>, px: (t: number) => number): Cluster[] {
  const gap = kind === 'markers' ? 12 : 4;
  const out: Cluster[] = [];
  for (const it of [...items].sort((a, b) => (a.t ?? 0) - (b.t ?? 0))) {
    const x = px(it.t ?? 0);
    const g = out[out.length - 1];
    if (g && x - g.x1 < gap) {
      g.items.push(it);
      g.x1 = x;
    } else out.push({ items: [it], x0: x, x1: x });
  }
  return out;
}

export interface LaneCtx {
  v0: number;
  v1: number;
  /** Percent across the visible window. */
  P: (t: number) => number;
  /** Pixels across the track. */
  PX: (t: number) => number;
  TW: number;
  sel?: string | null;
  emph?: string;
  zoom?: boolean;
  /** Hovered item for the readout card. */
  enter: (it: TimelineItem, lane: TimelineLaneSpec) => void;
  leave: () => void;
  pick: (it: TimelineItem, lane: TimelineLaneSpec) => (e: MouseEvent) => void;
  zoomTo: (c: Cluster) => void;
}

function Item({ lane, it, i, ctx, withLabel }: { lane: TimelineLaneSpec; it: TimelineItem; i: number; ctx: LaneCtx; withLabel?: boolean }) {
  const { P, v0, v1 } = ctx;
  const on = ctx.sel != null && it.id === ctx.sel;
  const em = ctx.emph != null && (it.id === ctx.emph || lane.id === ctx.emph);
  const col = on ? SEL : em ? EMPH : (paint(it.color) ?? paint(lane.color));
  const common = { type: 'button' as const, 'data-item': it.id ?? String(i), onClick: ctx.pick(it, lane), onMouseEnter: () => ctx.enter(it, lane), onMouseLeave: ctx.leave, 'aria-label': itemTip(it, lane).replace(/\n/g, ' ') };
  if (lane.kind === 'blocks' || lane.kind === 'spans' || lane.kind === 'strip') {
    const a = Math.max(it.t0 ?? 0, v0);
    const wp = P(Math.min(it.t1 ?? 0, v1)) - P(a);
    if (lane.kind === 'strip') {
      const bg = on ? SEL : em ? EMPH : it.cat != null ? (CAT[String(it.cat)] ?? CAT.other) : (paint(it.color) ?? CAT.other);
      return <button {...common} className={cx(l.tsr, on && l.on)} style={{ left: `${P(a)}%`, width: `max(1px, ${wp}%)`, background: bg }} />;
    }
    const lab = it.label && (wp * ctx.TW) / 100 > 40;
    return (
      <button {...common} className={cx(lane.kind === 'blocks' ? l.tb : l.tsp, on && l.on, em && l.em)} style={{ left: `${P(a)}%`, width: `max(2px, ${wp}%)`, ['--c' as string]: col }}>
        {lab && <span>{it.label}</span>}
      </button>
    );
  }
  const left = `${P(it.t ?? 0)}%`;
  if (lane.kind === 'ticks') return <button {...common} className={cx(l.tt, on && l.on)} style={{ left, background: col }} />;
  if (lane.kind === 'dots') return <button {...common} className={cx(l.td, it.kind === 'fail' && l.fail, on && l.on)} style={{ left, background: it.kind === 'fail' ? undefined : col }} />;
  return (
    <button {...common} className={cx(l.tm, on && l.on)} style={{ left, color: col }}>
      <b>{it.kind === 'tri' ? '▲' : '◆'}</b>
      {it.label && withLabel && <span>{it.label}</span>}
    </button>
  );
}

/** Items of one lane inside the window; dense points become count chips. */
export function LaneItems({ lane, ctx }: { lane: TimelineLaneSpec; ctx: LaneCtx }) {
  const vis = (it: TimelineItem) => (it.t1 != null ? it.t1 >= ctx.v0 && (it.t0 ?? 0) <= ctx.v1 : (it.t ?? 0) >= ctx.v0 && (it.t ?? 0) <= ctx.v1);
  const items = lane.items.filter(vis);
  if (!isPoint(lane.kind)) return items.map((it, i) => <Item key={`${it.id ?? ''}:${i}`} lane={lane} it={it} i={i} ctx={ctx} />);
  const gs = clusters(lane.kind, items, ctx.PX);
  return gs.map((g, gi) => {
    const first = g.items[0]!;
    if (g.items.length === 1) {
      const nx = gs[gi + 1];
      return <Item key={`${first.id ?? ''}:${gi}`} lane={lane} it={first} i={gi} ctx={ctx} withLabel={!nx || nx.x0 - g.x0 > 72} />;
    }
    const a = first.t ?? 0;
    const b = g.items[g.items.length - 1]!.t ?? 0;
    const span = `${hm(a)}–${hm(b)}`;
    const summary: TimelineItem = { label: `${g.items.length} 项`, t0: a, t1: b, tip: `${lane.label} │ ${g.items.length} 项\n${span}${ctx.zoom ? '\n点击放大' : ''}` };
    return (
      <button
        type="button"
        key={`c${gi}`}
        className={cx(l.cnt, g.items.some((it) => it.id === ctx.sel) && l.on)}
        style={{ left: `${ctx.P((a + b) / 2)}%` }}
        aria-label={`${lane.label} ${g.items.length} 项 │ ${span}`}
        data-count={g.items.length}
        onMouseEnter={() => ctx.enter(summary, lane)}
        onMouseLeave={ctx.leave}
        onClick={(e) => {
          e.stopPropagation();
          if (ctx.zoom) ctx.zoomTo(g);
        }}
      >
        <span>{g.items.length}</span>
      </button>
    );
  });
}
