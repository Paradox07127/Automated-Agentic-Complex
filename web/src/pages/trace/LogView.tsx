import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { LogLevel, LogSourceId } from '../../bridge/logs';
import { Btn, Menu, type MenuItem, MoreLines, SearchField, SecHead } from '../../ui';
import { GameFrame, GameSeg } from '../../ui/game';
import { clockOf, dayOf } from './data';
import { LevelMark } from './Glyphs';
import { LEVEL_NAME, LOG_IDS, LOG_NAME, type Logs, type Seq } from './useLogs';
import g from './Logs.module.css';
import ra from './Rail.module.css';
import t from './Trace.module.css';

export interface LogFilters {
  /** Sources shown; null until the sources are read (then every one that has lines). */
  on: LogSourceId[] | null;
  levels: Record<LogLevel, boolean>;
  q: string;
  /** 只看第 N 轮前后: the turn's time window, ms. */
  win: { no: number; t0: number; t1: number } | null;
  follow: boolean;
  /** The last line a paused view shows. */
  pausedAt: number;
}

export const DEFAULT_LEVELS: Record<LogLevel, boolean> = { err: true, warn: true, info: true, dbg: false };
const LEVELS: readonly LogLevel[] = ['err', 'warn', 'info', 'dbg'];

/** Sources that hold lines: the ones on by default. */
export const filledSources = (logs: Logs) => logs.sources.filter((s) => s.exists && s.bytes > 0).map((s) => s.id);

export function shownLines(logs: Logs, f: LogFilters): Seq[] {
  const on = new Set(f.on ?? filledSources(logs));
  const q = f.q.toLowerCase();
  return logs.lines.filter((l) => on.has(l.source) && f.levels[l.level] && (f.follow || l.seq <= f.pausedAt) && (!f.win || (l.at != null && l.at >= f.win.t0 && l.at <= f.win.t1))
    && (!q || l.text.toLowerCase().includes(q) || l.more.some((m) => m.toLowerCase().includes(q))));
}

const size = (b: number) => (b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);

function mark(text: string, q: string): ReactNode {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

export interface LogViewProps {
  logs: Logs;
  f: LogFilters;
  sel: ReadonlySet<string>;
  now: number;
  searchRef: RefObject<HTMLInputElement | null>;
  /** The ordinal of the turn a line names, by turn_id or trace_id. */
  turnNo: (id: string) => number | null;
  onF: (patch: Partial<LogFilters>) => void;
  onSelect: (key: string, range: boolean) => void;
  onTurn: (id: string) => void;
}

export function LogView({ logs, f, sel, now, searchRef, turnNo, onF, onSelect, onTurn }: LogViewProps) {
  const ll = useRef<HTMLDivElement>(null);
  const [folds, setFolds] = useState<ReadonlySet<string>>(new Set());
  const on = new Set(f.on ?? filledSources(logs));
  const lines = shownLines(logs, f);
  const fresh = f.follow ? 0 : logs.lines.filter((l) => l.seq > f.pausedAt && on.has(l.source)).length;
  useLayoutEffect(() => {
    if (f.follow && ll.current) ll.current.scrollTop = ll.current.scrollHeight;
  }, [f.follow, lines.length, logs.status]);
  // Scrolling up stops following, as a terminal's tail does.
  useEffect(() => {
    const el = ll.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (e.deltaY < 0 && f.follow) onF({ follow: false, pausedAt: logs.last });
    };
    el.addEventListener('wheel', wheel, { passive: true });
    return () => el.removeEventListener('wheel', wheel);
  }, [f.follow, logs.last, onF]);

  const errs = (id: LogSourceId) => logs.lines.filter((l) => l.source === id && l.level === 'err').length;
  const count = (l: LogLevel) => logs.lines.filter((x) => x.level === l && on.has(x.source)).length;
  const toggle = (id: LogSourceId, alt: boolean) => onF({ on: alt ? [id] : on.has(id) ? [...on].filter((x) => x !== id) : [...on, id] });
  const info = (id: LogSourceId) => logs.sources.find((s) => s.id === id);

  let body: ReactNode;
  if (logs.status === 'missing' || logs.status === 'error')
    body = (
      <div className={t.empty}>
        <b>读不到日志</b>
        <span>{logs.status === 'missing' ? '这个版本的外壳还没有读日志的接口。' : (logs.error ?? '外壳没有回答。')}</span>
      </div>
    );
  else if (logs.status === 'loading') body = Array.from({ length: 14 }, (_, i) => <div key={i} className={`${t.skel} ${g.skl}`} />);
  else if (lines.length === 0)
    body = (
      <div className={t.empty}>
        <b>{f.q ? `没有含「${f.q}」的行` : '这些条件下没有日志'}</b>
        <Btn variant="secondary" size="sm" onClick={() => onF({ q: '', win: null, levels: DEFAULT_LEVELS, on: null })}>清掉筛选</Btn>
      </div>
    );
  else {
    const out: ReactNode[] = [];
    let day = '';
    let prevTurn: string | null = null;
    for (let i = 0; i < lines.length; i += 1) {
      const l = lines[i]!;
      // The same words again from the same source fold into one line with ×N.
      let times = 1;
      while (i + times < lines.length && lines[i + times]!.source === l.source && lines[i + times]!.text === l.text && lines[i + times]!.level === l.level) times += 1;
      const last = lines[i + times - 1]!;
      i += times - 1;
      if (last.at != null && dayOf(last.at) !== day) {
        day = dayOf(last.at);
        out.push(<div key={`d${day}`} className={g.ld}>{day}</div>);
        prevTurn = null;
      }
      const no = last.turn ? turnNo(last.turn) : null;
      const open = folds.has(last.key);
      out.push(
        <div
          key={last.key}
          className={g.ln}
          data-l={last.level}
          data-key={last.key}
          data-sel={sel.has(last.key) || undefined}
          onMouseDown={(e) => {
            if ((e.target as Element).closest('button')) return;
            if (e.shiftKey) e.preventDefault();
            onSelect(last.key, e.shiftKey);
          }}
        >
          <span className={g.tm}>
            {last.at != null ? clockOf(last.at) : '—'}
            {last.at != null && <i>{clockOf(last.at, true).slice(8)}</i>}
          </span>
          <span className={g.so}>{LOG_NAME[last.source]}</span>
          <span className={g.lvm} title={LEVEL_NAME[last.level]}>
            <LevelMark l={last.level} />
          </span>
          <span className={g.ms}>
            {mark(last.text, f.q)}
            {times > 1 && <span className={g.x}>×{times}</span>}
            {last.more.length > 0 && (
              <>
                {open && last.more.map((m, k) => <span key={k} className={g.tb}>{mark(m, f.q)}</span>)}
                <MoreLines total={last.more.length + 1} open={open} onToggle={() => setFolds((s) => { const n = new Set(s); if (n.has(last.key)) n.delete(last.key); else n.add(last.key); return n; })} />
              </>
            )}
          </span>
          <span className={g.tn}>
            {last.turn && no != null && (last.turn === prevTurn ? <span className={g.tcont} aria-hidden="true" /> : (
              <Btn variant="text" size="sm" onClick={() => onTurn(last.turn!)}>
                第 {no} 轮 ›
              </Btn>
            ))}
          </span>
        </div>,
      );
      prevTurn = last.turn;
    }
    if (f.follow) out.push(<div key="tail" className={g.tail}><i aria-hidden="true" />跟随中 │ 新行接在这里</div>);
    body = out;
  }

  const levels = LEVELS.filter((l) => f.levels[l]).length;
  const levelItems: MenuItem[] = [
    { kind: 'head', label: '显示的级别' },
    ...LEVELS.map((l): MenuItem => ({ kind: 'item', label: l === 'err' || l === 'warn' ? `${LEVEL_NAME[l]} ${count(l)}` : LEVEL_NAME[l], checked: f.levels[l], onSelect: () => onF({ levels: { ...f.levels, [l]: !f.levels[l] } }) })),
  ];
  return (
    <div className={t.logs}>
      <aside className={ra.rail} aria-label="来源">
        <SecHead title="来源" count={on.size} right={`共 ${LOG_IDS.length}`} />
        <div className={ra.srcs}>
          {LOG_IDS.map((id) => {
            const s = info(id);
            const e = errs(id);
            const empty = !s || !s.exists || s.bytes === 0;
            const when = s?.mtime != null ? (now - s.mtime < 60_000 ? '刚刚' : clockOf(s.mtime).slice(0, 5)) : null;
            return (
              <button key={id} type="button" className={ra.sr} aria-pressed={on.has(id)} data-err={e > 0 || undefined} data-miss={empty || undefined} title={`${s?.file ?? id}（⌥ 点只看这一个）`} onClick={(ev) => toggle(id, ev.altKey)}>
                <span className={ra.bx} aria-hidden="true" />
                <b>{LOG_NAME[id]}</b>
                <span className={ra.ec} data-z={e === 0 || undefined}>
                  {e > 0 ? (
                    <>
                      <LevelMark l="err" />
                      {e}
                    </>
                  ) : empty ? '空' : '—'}
                </span>
                <small>{[s?.file ?? id, s ? size(s.bytes) : null, !empty ? when : null].filter(Boolean).join(' │ ')}</small>
              </button>
            );
          })}
        </div>
        {logs.dirs && (
          <div className={ra.where} title={`${logs.dirs.support}\n${logs.dirs.web}`}>
            <span>目录</span>…/{logs.dirs.support.split(/[\\/]/).slice(-2).join('/')}
            <span>界面</span>{logs.dirs.web.replace(/^.*?(Library|AppData)/, '~/$1')}
          </div>
        )}
      </aside>
      <GameFrame label="日志">
        <section className={g.main}>
          <div className={g.tool}>
            <span className={g.q}>
              <SearchField value={f.q} label="搜日志" placeholder="搜日志  /" inputRef={searchRef} onChange={(q) => onF({ q, follow: false, pausedAt: f.follow ? logs.last : f.pausedAt })} />
            </span>
            <span className={g.srcdd}>
              <Menu label={`来源 ${on.size}/${LOG_IDS.length}`} icon="tune" items={[{ kind: 'head', label: '来源' }, ...LOG_IDS.map((id): MenuItem => ({ kind: 'item', label: `${LOG_NAME[id]} │ ${info(id)?.file ?? id}`, checked: on.has(id), onSelect: () => toggle(id, false) }))]} />
            </span>
            <Menu label={`级别 ${levels}/${LEVELS.length}`} items={levelItems} />
            {f.win && (
              <Btn variant="secondary" size="sm" tail="close" onClick={() => onF({ win: null })}>
                只看第 {f.win.no} 轮前后
              </Btn>
            )}
            <span className={g.sp} />
            <GameSeg
              label="跟随"
              value={f.follow ? 'follow' : 'pause'}
              options={[{ value: 'follow', label: '跟随最新' }, { value: 'pause', label: '暂停' }]}
              onChange={(v) => onF(v === 'follow' ? { follow: true } : { follow: false, pausedAt: f.follow ? logs.last : f.pausedAt })}
            />
          </div>
          <div ref={ll} className={g.ll} role="log" aria-live="off" aria-label="日志行">
            {body}
          </div>
          <span className={g.cap} aria-hidden="true">
            <i />
            AIC // LOG // {on.size} SOURCES // LOCAL ONLY
          </span>
          {!f.follow && fresh > 0 && logs.status === 'ok' && (
            <span className={g.pill}>
              <Btn variant="primary" size="sm" icon="chevd" onClick={() => onF({ follow: true })}>
                已暂停 │ 新增 {fresh} 行 │ 回到最新
              </Btn>
            </span>
          )}
        </section>
      </GameFrame>
    </div>
  );
}

