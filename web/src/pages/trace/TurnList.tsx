import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { keyText } from '../../bridge/platformText';
import type { ChartStatus } from '../../charts';
import { isoToMs, type VisualStateKey } from '../../domain';
import type { WireTraceTurn } from '../../domain/wire';
import { Btn, Menu, type MenuItem, SearchField } from '../../ui';
import { GameSeg, StatusLamp } from '../../ui/game';
import { fmtMs } from '../chat/turnTrace';
import { clockOf, groupOf, hourOf, inFilter, no4, type ResFilter, type Shape, SHAPE_LABEL, shapeOf, SRC_GROUPS, srcLabel, type SrcGroup } from './data';
import s from './List.module.css';
import t from './Trace.module.css';

const PAGE = 40;
/** The lamp for a turn's result; the words stay the list's own. */
const LAMP: Readonly<Record<Shape, VisualStateKey>> = { ok: 'done', fail: 'failed', cut: 'interrupted', run: 'running', wait: 'awaiting_approval', skip: 'skipped', text: 'idle', unk: 'warning' };
const RES: ReadonlyArray<[ResFilter, string]> = [['all', '全部'], ['fail', '出错'], ['cut', '打断'], ['live', '在跑']];

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
          <span className={s.m}>{[clockOf(at), title ? src : null, fmtMs(r.duration_ms)].filter(Boolean).join(' │ ')}</span>
          <span data-sign="" data-s={shape}>
            <StatusLamp state={LAMP[shape]} label={SHAPE_LABEL[shape]} />
          </span>
          <span className={s.no} aria-hidden="true">
            {no4(no)}
          </span>
        </button>,
      );
    }
    if (list.length > shown)
      out.push(
        <span key="more" className={s.more}>
          <Btn variant="text" size="sm" onClick={() => setShown(shown + PAGE)}>
            再往前 {Math.min(PAGE, list.length - shown)} 轮 │ 共 {list.length}
          </Btn>
        </span>,
      );
    body = out;
  }
  return (
    <section className={s.lp} aria-label="轮次列表">
      <div className={s.head}>
        <SearchField value={q} label="找一轮" placeholder="开头的字或轮次号" inputRef={searchRef} shortcut={keyText('⌘F')} onChange={onQ} onSubmit={() => list[0] && onPick(list[0].turn_id)} />
        <Menu
          label={SRC_GROUPS.find(([id]) => id === group)?.[1] ?? '全部来源'}
          align="right"
          narrowed={group !== 'all'}
          items={[{ kind: 'head', label: '按来源' }, ...SRC_GROUPS.map(([id, label]): MenuItem => ({ kind: 'item', label, radio: true, checked: id === group, onSelect: () => onGroup(id) }))]}
        />
      </div>
      <div className={s.fil} hidden={st !== 'ok' || rows.length === 0}>
        <GameSeg label="按结果筛选" value={res} options={RES.map(([f, label]) => ({ value: f, label: `${label} ${count(f)}` }))} onChange={(v) => onRes(v as ResFilter)} />
      </div>
      <div ref={scroll} className={s.scroll} role="listbox" aria-label="近 24 小时的轮次">
        {body}
      </div>
    </section>
  );
}
