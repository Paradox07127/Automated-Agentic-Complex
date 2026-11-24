import { ChartBox, useChart, type ChartCommonProps } from './ChartBox';
import { cx, EMPH, fmtN, INK, paint, pressable, sum } from './v3';
import s from './ChartBox.module.css';
import m from './Treemap.module.css';

export interface TreemapItem {
  id: string;
  label: string;
  v: number;
  color?: string;
}

interface Cell extends TreemapItem {
  a: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Squarified layout of `items` (sorted by value, descending) in the given box. */
export function squarify(items: ReadonlyArray<TreemapItem>, x: number, y: number, w: number, h: number): Cell[] {
  const out: Cell[] = [];
  const total = sum(items.map((i) => i.v));
  if (!total) return out;
  const scale = (w * h) / total;
  const rest = items.map((i) => ({ ...i, a: i.v * scale, x: 0, y: 0, w: 0, h: 0 }));
  let row: Cell[] = [];
  const worst = (r: Cell[], side: number) => {
    const t = sum(r.map((i) => i.a));
    const mx = Math.max(...r.map((i) => i.a));
    const mn = Math.min(...r.map((i) => i.a));
    return Math.max((side * side * mx) / (t * t), (t * t) / (side * side * mn));
  };
  const lay = (r: Cell[]) => {
    const t = sum(r.map((i) => i.a));
    if (w >= h) {
      const cw = t / h;
      let yy = y;
      for (const i of r) {
        const ch = i.a / cw;
        out.push({ ...i, x, y: yy, w: cw, h: ch });
        yy += ch;
      }
      x += cw;
      w -= cw;
    } else {
      const rh = t / w;
      let xx = x;
      for (const i of r) {
        const cw = i.a / rh;
        out.push({ ...i, x: xx, y, w: cw, h: rh });
        xx += cw;
      }
      y += rh;
      h -= rh;
    }
  };
  while (rest.length) {
    const it = rest[0]!;
    const side = Math.min(w, h);
    if (!row.length || worst([...row, it], side) <= worst(row, side)) {
      row.push(it);
      rest.shift();
    } else {
      lay(row);
      row = [];
    }
  }
  if (row.length) lay(row);
  return out;
}

/** 占比格：墨色深浅按大小；emph 的格子不铺 trace，只加 2 px trace 内描边和左上小角标。 */
export interface TreemapProps extends ChartCommonProps {
  items: TreemapItem[];
  w?: number;
  /** 高，默认 180 */
  h?: number;
  fmt?: (v: number) => string;
  onPick?: (id: string | null) => void;
  sel?: string | null;
  emph?: string;
}

export function Treemap({ items, w, h = 180, fmt = fmtN, onPick, sel, label = '占比格', st = 'ok', empty, stoppedAt, onRetry, emph, frame }: TreemapProps) {
  const c = useChart(w);
  if (!items.some((i) => i.v > 0) && st === 'ok') st = 'empty';
  const sorted = items.filter((i) => i.v > 0).sort((a, b) => b.v - a.v);
  const total = sum(sorted.map((i) => i.v)) || 1;
  const pct = (v: number) => `${Math.round((v / total) * 100)}%`;
  const cells = squarify(sorted, 0, 0, c.W, h);
  const aria = `${label}：${sorted.map((i) => `${i.label} ${fmt(i.v)}`).join('，')}`;
  const table = { cols: ['', '数值', '占比'], rows: sorted.map((i) => [i.label, fmt(i.v), pct(i.v)]) };
  return (
    <ChartBox name="Treemap" c={c} w={w} h={h} st={st} empty={empty} stoppedAt={stoppedAt} onRetry={onRetry} label={label} table={table} frame={frame}>
      <svg width={c.W} height={h} viewBox={`0 0 ${c.W} ${h}`} role={onPick ? 'group' : 'img'} aria-label={aria}>
        {cells.map((k, i) => {
          const big = k.w >= 56 && k.h >= 30;
          const mid = !big && k.w >= 34 && k.h >= 18;
          const em = k.id === emph;
          return (
            <g key={k.id} className={m.cell} data-cell={k.id} data-emph={em || undefined} {...(onPick && { ...pressable(`${k.label} ${fmt(k.v)} ${pct(k.v)}`, () => onPick(sel === k.id ? null : k.id)), 'aria-pressed': sel === k.id })} onMouseMove={(e) => c.show(e, `${k.label}\n${fmt(k.v)} │ ${pct(k.v)}`)}>
              <rect x={k.x + 1} y={k.y + 1} width={Math.max(0, k.w - 2)} height={Math.max(0, k.h - 2)} fill={paint(k.color) ?? INK[0]} fillOpacity={k.color ? 0.75 : Math.max(0.12, 0.42 - i * 0.05)} />
              {em && (
                <>
                  <rect x={k.x + 2} y={k.y + 2} width={Math.max(0, k.w - 4)} height={Math.max(0, k.h - 4)} fill="none" stroke={EMPH} strokeWidth="2" />
                  <path d={`M${k.x + 1} ${k.y + 1}h12L${k.x + 1} ${k.y + 13}Z`} fill={EMPH} />
                </>
              )}
              {sel === k.id && <rect x={k.x + 2} y={k.y + 2} width={Math.max(0, k.w - 4)} height={Math.max(0, k.h - 4)} className={s.selBox} />}
              {big && (
                <text x={k.x + 8} y={k.y + 18} className={cx(s.zh, m.label)}>
                  {k.label}
                </text>
              )}
              {big && k.h >= 44 && (
                <text x={k.x + 8} y={k.y + 34} className={m.value}>
                  {fmt(k.v)}
                </text>
              )}
              {mid && (
                <text x={k.x + 5} y={k.y + 14} className={m.value}>
                  {fmt(k.v)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </ChartBox>
  );
}

const APPS = (
  [
    ['Terminal', 132],
    ['Xcode', 96],
    ['Safari', 58],
    ['Zoom', 45],
    ['微信', 12],
    ['Finder', 8],
    ['备忘录', 5],
    ['预览', 3],
  ] as const
).map(([label, v]) => ({ id: label, label, v }));

export const TreemapDemos: Array<{ name: string; props: TreemapProps }> = [
  { name: 'emph', props: { label: '今日 App 占比', items: APPS, h: 112, fmt: (v) => `${v} 分`, emph: 'Terminal' } },
  { name: 'pick', props: { label: '今日 App 占比', items: APPS, h: 140, fmt: (v) => `${v} 分`, sel: 'Safari', onPick: () => undefined } },
  { name: 'empty', props: { label: '今日 App 占比', empty: '今天还没有前台记录', items: [] } },
];
