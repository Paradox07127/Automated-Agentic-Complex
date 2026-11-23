import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ChartStatus } from '../../charts';
import { isoToMs } from '../../domain';
import { Menu, type MenuItem, SecHead } from '../../ui';
import { GameFrame, GameSeg } from '../../ui/game';
import { clockOf, type Shape } from './data';
import { ShapeMark } from './Glyphs';
import { causesOf, effectsOf, inWindow, labelOf, LANE_NAME, laneOf, lanesOf, type LaneEvent, type LaneId, pack, type Range, RANGES, toneOf, walkOf } from './lanes';
import l from './Lanes.module.css';
import t from './Trace.module.css';

const ROW = 18;
const PAD = 6;
const ROWS_MAX = 3;
/** Marks closer than this fraction of the width go to the next sub-row. */
const GAP = 0.012;
const TICK_MIN: Readonly<Record<Range, number>> = { 5: 1, 15: 3, 60: 10 };
const STATUS: Readonly<Record<string, [Shape, string]>> = {
  ok: ['ok', '正常'], blocked: ['skip', '挡下'], failed: ['fail', '失败'], cancelled: ['cut', '取消'], expired: ['cut', '到期'], unknown: ['unk', '不明'],
};

const valueOf = (v: unknown): string => {
  if (v == null) return '—';
  if (Array.isArray(v)) return v.map(valueOf).join(', ') || '—';
  if (typeof v === 'object') {
    const x = v as { len?: unknown; head?: unknown };
    if (typeof x.len === 'number') return `${String(x.head ?? '')}${typeof x.head === 'string' && x.head.length < x.len ? '…' : ''} │ ${x.len} 字`;
    return JSON.stringify(v);
  }
  return String(v);
};

const editable = (el: Element | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

interface Mark {
  e: LaneEvent;
  x: number;
  row: number;
}

export interface LaneViewProps {
  /** The stretch's events; null when agentd cannot read events by time. */
  events: LaneEvent[] | null;
  st: ChartStatus;
  now: number;
}

export function LaneView({ events, st, now }: LaneViewProps) {
  const [range, setRange] = useState<Range>(5);
  const [hidden, setHidden] = useState<ReadonlySet<LaneId>>(new Set());
  const [sel, setSel] = useState<string | null>(null);
  const board = useRef<HTMLDivElement>(null);
  const t1 = now;
  const t0 = now - range * 60_000;
  const all = useMemo(() => inWindow(events ?? [], t0, t1).sort((a, b) => isoToMs(a.t_wall) - isoToMs(b.t_wall)), [events, t0, t1]);
  const walk = useMemo(() => walkOf(all), [all]);
  const lanes = useMemo(() => lanesOf(all), [all]);
  const shown = lanes.filter((id) => !hidden.has(id));
  const marks = useMemo(() => {
    const by = new Map<LaneId, Mark[]>();
    for (const id of lanes) {
      const list = all.filter((e) => laneOf(e) === id);
      const xs = list.map((e) => Math.min(1, Math.max(0, (isoToMs(e.t_wall) - t0) / (t1 - t0))));
      const rows = pack(xs, GAP, ROWS_MAX);
      by.set(id, list.map((e, i) => ({ e, x: xs[i]!, row: rows[i]! })));
    }
    return by;
  }, [all, lanes, t0, t1]);
  const picked = sel ? (walk.byId.get(sel) ?? null) : null;
  const causes = useMemo(() => (picked ? causesOf(walk, picked.event_id) : []), [walk, picked]);
  const effects = useMemo(() => (picked ? effectsOf(walk, picked.event_id) : []), [walk, picked]);
  const rel = new Map<string, 'cause' | 'effect' | 'sel'>([...causes.map((e) => [e.event_id, 'cause'] as const), ...effects.map((e) => [e.event_id, 'effect'] as const)]);
  if (picked) rel.set(picked.event_id, 'sel');

  // Where each drawn mark sits, for the lines between the picked event and its causes and effects.
  const tops = new Map<LaneId, number>();
  let y = 0;
  const heights = shown.map((id) => {
    const h = PAD * 2 + ROW * (Math.max(0, ...(marks.get(id) ?? []).map((m) => m.row)) + 1);
    tops.set(id, y);
    y += h;
    return h;
  });
  const at = new Map<string, [number, number]>();
  for (const id of shown) for (const m of marks.get(id) ?? []) at.set(m.e.event_id, [m.x, tops.get(id)! + PAD + m.row * ROW + ROW / 2]);
  const edges = picked ? [...rel.keys()].flatMap((id) => {
    const c = walk.byId.get(id)?.causation_id;
    const a = c != null && rel.has(c) ? at.get(c) : undefined;
    const b = at.get(id);
    return a && b ? [[a, b] as const] : [];
  }) : [];

  useEffect(() => {
    if (!sel) return;
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || editable(document.activeElement) || document.querySelector('[role="menu"], [role="dialog"]')) return;
      e.preventDefault();
      setSel(null);
    };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [sel]);

  const drawn = all.filter((e) => {
    const id = laneOf(e);
    return id != null && !hidden.has(id);
  });
  const pick = (id: string) => {
    setSel(id);
    board.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const i = drawn.findIndex((x) => x.event_id === sel);
    const next = drawn[i < 0 ? (e.key === 'ArrowRight' ? 0 : drawn.length - 1) : Math.max(0, Math.min(drawn.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)))];
    if (!next) return;
    e.preventDefault();
    pick(next.event_id);
  };
  const toggle = (id: string) => setHidden((h) => {
    const n = new Set(h);
    if (n.has(id as LaneId)) n.delete(id as LaneId);
    else n.add(id as LaneId);
    return n;
  });

  const step = TICK_MIN[range] * 60_000;
  const ticks = Array.from({ length: Math.floor(range / TICK_MIN[range]) + 1 }, (_, i) => t1 - i * step).reverse();
  const laneName = (e: LaneEvent) => {
    const id = laneOf(e);
    return id ? LANE_NAME[id] : e.kind;
  };
  const item = (e: LaneEvent) => (
    <li key={e.event_id}>
      <button type="button" className={l.ref} data-tone={toneOf(e)} onClick={() => pick(e.event_id)}>
        <span className={t.num}>{clockOf(isoToMs(e.t_wall), true)}</span>
        <span>{laneOf(e) ? laneName(e) : '—'}</span>
        <span title={labelOf(e)}>{labelOf(e)}</span>
      </button>
    </li>
  );
  const msg = st === 'error' ? '读不到这段时间的事件' : st === 'loading' ? '正在读…' : events == null ? '后台暂不提供一段时间的事件' : all.length === 0 ? `近 ${range} 分钟没有动作事件` : null;
  const status = picked ? (STATUS[picked.status] ?? (['unk', picked.status] as [Shape, string])) : null;

  return (
    <div className={l.view}>
      <section className={l.board} aria-label="动作线">
        <div className={l.head}>
          <GameSeg label="时间范围" value={String(range)} options={RANGES.map((m) => ({ value: String(m), label: `近 ${m} 分钟` }))} onChange={(v) => setRange(Number(v) as Range)} />
          <span className={l.count}>
            <b className={t.num}>{drawn.length}</b>条
          </span>
          <span className={l.sp} />
          {hidden.size > 0 && <span className={l.count}>隐藏了 {hidden.size} 条线</span>}
          <Menu label="显示哪些线" icon="tune" align="right" items={[{ kind: 'head', label: '显示的线' }, ...lanes.map((id): MenuItem => ({ kind: 'item', label: LANE_NAME[id], checked: !hidden.has(id), onSelect: () => toggle(id) }))]} />
        </div>
        {msg != null ? (
          <div className={t.empty}>
            <span className={t.bc} aria-hidden="true" />
            <b>{msg}</b>
          </div>
        ) : (
          <div className={l.scroll}>
            <div className={l.axis} aria-hidden="true">
              {ticks.map((tk) => (
                <span key={tk} style={{ left: `${((tk - t0) / (t1 - t0)) * 100}%` }}>{clockOf(tk)}</span>
              ))}
            </div>
            <div ref={board} className={l.lanes} data-picked={picked ? '' : undefined} onKeyDown={onKey}>
              <div className={l.rules} aria-hidden="true">
                {ticks.map((tk) => <i key={tk} style={{ left: `${((tk - t0) / (t1 - t0)) * 100}%` }} />)}
                <svg width="100%" height={y}>
                  {edges.map(([a, b], i) => <line key={i} x1={`${a[0] * 100}%`} y1={a[1]} x2={`${b[0] * 100}%`} y2={b[1]} />)}
                </svg>
              </div>
              {shown.map((id, i) => (
                <div key={id} className={l.lane} role="group" aria-label={LANE_NAME[id]} data-g={id.startsWith('in.') ? 'in' : id} style={{ height: heights[i] }}>
                  <span className={l.name}>{LANE_NAME[id]}</span>
                  <div className={l.track}>
                    {(marks.get(id) ?? []).map((m) => (
                      <button
                        key={m.e.event_id}
                        type="button"
                        className={l.mark}
                        data-id={m.e.event_id}
                        data-tone={toneOf(m.e)}
                        data-rel={rel.get(m.e.event_id)}
                        aria-pressed={sel === m.e.event_id}
                        aria-label={`${clockOf(isoToMs(m.e.t_wall))} ${labelOf(m.e)}`}
                        title={labelOf(m.e)}
                        style={{ left: `${m.x * 100}%`, top: PAD + m.row * ROW }}
                        onClick={() => setSel(sel === m.e.event_id ? null : m.e.event_id)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
      <GameFrame label="所选事件">
        {!picked ? (
          <div className={t.empty}>
            <span className={t.bc} aria-hidden="true" />
            <b>选一个事件看前因后果</b>
          </div>
        ) : (
          <div className={l.dscroll} key={picked.event_id}>
            <div className={l.dh}>
              <span className={l.tag}>{laneName(picked)}</span>
              <span className={`${t.num} ${l.when}`}>{clockOf(isoToMs(picked.t_wall), true)}</span>
              {status && (
                <span className={t.sg} data-s={status[0]}>
                  <ShapeMark s={status[0]} />
                  {status[1]}
                </span>
              )}
            </div>
            <b className={l.title} data-tone={toneOf(picked)}>{labelOf(picked)}</b>
            <span className={l.meta}>
              <span className={t.mono}>{picked.kind}</span> │ {picked.producer} │ trace {picked.trace_id.slice(0, 8)}
            </span>
            <dl className={l.attrs} aria-label="字段">
              {Object.entries(picked.attrs).map(([k, v]) => (
                <div key={k}>
                  <dt className={t.mono}>{k}</dt>
                  <dd title={valueOf(v)}>{valueOf(v)}</dd>
                </div>
              ))}
            </dl>
            <SecHead title="起因" count={causes.length} right={<i className={l.sw} data-rel="cause" aria-hidden="true" />} />
            {causes.length ? <ol className={l.refs} aria-label="起因">{causes.map(item)}</ol> : <span className={l.none}>无</span>}
            <SecHead title="引起" count={effects.length} right={<i className={l.sw} data-rel="effect" aria-hidden="true" />} />
            {effects.length ? <ol className={l.refs} aria-label="引起">{effects.map(item)}</ol> : <span className={l.none}>无</span>}
          </div>
        )}
      </GameFrame>
    </div>
  );
}
