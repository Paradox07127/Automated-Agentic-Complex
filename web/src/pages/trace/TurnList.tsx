import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { ChartStatus } from '../../charts';
import { isoToMs } from '../../domain';
import type { WireTraceTurn } from '../../domain/wire';
import { Btn, Icon } from '../../ui';
import { fmtMs } from '../chat/turnTrace';
import { clockOf, groupOf, hourOf, inFilter, no4, type ResFilter, SHAPE_LABEL, shapeOf, SRC_GROUPS, srcLabel, type SrcGroup } from './data';
import { FilterMenu } from './FilterMenu';
import { ShapeMark } from './Glyphs';
import s from './List.module.css';
import t from './Trace.module.css';

const PAGE = 40;

export interface TurnListProps {
  rows: WireTraceTurn[];
  /** Ordinal of each turn by turn_id, oldest first. */
  noOf: ReadonlyMap<string, number>;
  sel: string | null;
  st: ChartStatus;
  /** When the list stopped updating, for the error line. */
  stoppedAt: string | null;
  q: string;
  group: SrcGroup;
  res: ResFilter;
  searchRef: RefObject<HTMLInputElement | null>;
  onQ: (q: string) => void;
  onGroup: (g: SrcGroup) => void;
  onRes: (r: ResFilter) => void;
  onPick: (turnId: string) => void;
  onRetry: () => void;
  onChat: () => void;
}

/** The turns shown with the list's filters. */
export function visibleTurns(rows: readonly WireTraceTurn[], noOf: ReadonlyMap<string, number>, q: string, group: SrcGroup, res: ResFilter): WireTraceTurn[] {
  const digits = q.replace(/\D/g, '');
  return rows.filter((r) => (group === 'all' || groupOf(r.source) === group) && inFilter(res, shapeOf(r)) && (!q || (r.head ?? '').includes(q) || (digits !== '' && String(noOf.get(r.turn_id)) === String(Number(digits)))));
}

export function TurnList({ rows, noOf, sel, st, stoppedAt, q, group, res, searchRef, onQ, onGroup, onRes, onPick, onRetry, onChat }: TurnListProps) {
  const [shown, setShown] = useState(PAGE);
  const scroll = useRef<HTMLDivElement>(null);
  const list = visibleTurns(rows, noOf, q, group, res);
  const count = (f: ResFilter) => rows.filter((r) => inFilter(f, shapeOf(r))).length;
  useEffect(() => {
    scroll.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [sel]);

  let body: ReactNode;
  if (st === 'loading') body = Array.from({ length: 8 }, (_, i) => <div key={i} className={t.skel} />);
  else if (st === 'error')
    body = (
      <div className={t.empty}>
        <b>读不到运行记录</b>
        <span>后台已断开{stoppedAt ? `，列表停在 ${stoppedAt}` : ''}。</span>
        <Btn variant="secondary" size="sm" icon="refresh" onClick={onRetry}>重试</Btn>
      </div>
    );
  else if (rows.length === 0)
    body = (
      <div className={t.empty}>
        <span className={t.bc} aria-hidden="true" />
        <b>近 24 小时她没有跑过一轮</b>
        <Btn variant="secondary" size="sm" icon="send" onClick={onChat}>去对话</Btn>
      </div>
    );
  else if (list.length === 0)
    body = (
      <div className={t.empty}>
        <b>没有符合的轮次</b>
        <Btn variant="secondary" size="sm" onClick={() => (onQ(''), onGroup('all'), onRes('all'))}>看全部</Btn>
      </div>
    );
  else {
    const out: ReactNode[] = [];
    let hour = '';
    for (const r of list.slice(0, shown)) {
      const at = isoToMs(r.started_at);
      const h = hourOf(at);
      if (h !== hour) {
        hour = h;
        const inHour = list.filter((x) => hourOf(isoToMs(x.started_at)) === h);
        const bad = inHour.filter((x) => shapeOf(x) === 'fail').length;
        out.push(
          <div key={`h${h}`} className={s.hsep} role="presentation">
            {h} │ {inHour.length} 轮{bad > 0 && <b> │ 出错 {bad}</b>}
          </div>,
        );
      }
      const shape = shapeOf(r);
      const src = srcLabel(r.source);
      const no = noOf.get(r.turn_id) ?? 0;
      const title = r.head ? `${r.head}${(r.len ?? 0) > r.head.length ? '…' : ''}` : null;
      out.push(
        <button key={r.turn_id} type="button" role="option" className={s.tr} data-s={shape} data-turn={r.turn_id} aria-selected={r.turn_id === sel} onClick={() => onPick(r.turn_id)}>
          <span className={s.h}>{title ?? <span className={s.src}>{src}</span>}</span>
          <span className={s.m}>{[clockOf(at), title ? src : null, fmtMs(r.duration_ms), r.model].filter(Boolean).join(' │ ')}</span>
          <span className={t.sg} data-sign="" data-s={shape}>
            <ShapeMark s={shape} />
            {SHAPE_LABEL[shape]}
          </span>
          <span className={s.no} aria-hidden="true">
            {no4(no)}
          </span>
        </button>,
      );
    }
    if (list.length > shown)
      out.push(
        <button key="more" type="button" className={s.more} onClick={() => setShown(shown + PAGE)}>
          再往前 {Math.min(PAGE, list.length - shown)} 轮 │ 共 {list.length}
        </button>,
      );
    body = out;
  }
  const seg = (f: ResFilter, label: string, bad?: boolean) => {
    const n = count(f);
    return (
      <button type="button" aria-pressed={res === f} onClick={() => onRes(f)}>
        {label} <span className={`${t.n} ${bad && n ? t.bad : ''}`}>{n}</span>
      </button>
    );
  };
  return (
    <section className={s.lp} aria-label="轮次列表">
      <div className={s.head}>
        <label className={t.field}>
          <Icon name="search" size={14} />
          <input ref={searchRef} value={q} placeholder="找一轮：开头的字或轮次号" aria-label="找一轮" onChange={(e) => onQ(e.target.value)} />
          <kbd aria-hidden="true">/</kbd>
        </label>
        <FilterMenu label="按来源筛选" head="按来源" items={SRC_GROUPS.map(([id, label]) => ({ id, label, on: group === id }))} narrowed={group !== 'all'} onPick={(id) => onGroup(id as SrcGroup)} />
      </div>
      <div className={s.fil} hidden={st !== 'ok' || rows.length === 0}>
        <div className={t.seg} role="group" aria-label="按结果筛选">
          {seg('all', '全部')}
          {seg('fail', '出错了', true)}
          {seg('cut', '打断')}
          {seg('live', '在跑')}
        </div>
      </div>
      <div ref={scroll} className={s.scroll} role="listbox" aria-label="近 24 小时的轮次">
        {body}
      </div>
    </section>
  );
}
