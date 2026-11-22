import type { CSSProperties, ReactNode } from 'react';
import { navigate } from '../../shell/nav';
import { fmtMs } from '../chat/turnTrace';
import { SHAPE_LABEL, type Shape } from './data';
import { MemMark, ShapeMark, StepMark } from './Glyphs';
import { RawFold } from './Raw';
import { longestOf, type Part, type Step, type Turn } from './steps';
import s from './Steps.module.css';
import t from './Trace.module.css';

export const parts = (p: Part[]) =>
  p.map((x, i) =>
    x.k === 'b' ? (
      <b key={i}>{x.t}</b>
    ) : x.k ? (
      <span key={i} data-k={x.k}>
        {x.t}
      </span>
    ) : (
      <span key={i}>{x.t}</span>
    ),
  );

const pct = (n: number, total: number) => `${Math.max(0, Math.min(100, (n / total) * 100))}%`;

function Body({ x, extra, onCopy }: { x: Step; extra: ReactNode; onCopy: (text: string) => void }) {
  return (
    <div className={s.sb}>
      {x.mems && x.mems.length > 0 && (
        <div className={s.chips}>
          {x.mems.map((m) => (
            <button key={`${m.fresh ? 'n' : 'm'}${m.id}`} type="button" className={s.chip} data-new={m.fresh || undefined} title={m.fresh ? '这一轮新记下的' : '在记忆中打开'} onClick={() => navigate({ page: 'memory', view: 'about', sel: m.id })}>
              {m.fresh ? <b>+ 新增</b> : <MemMark />}
              <span>{m.text}</span>
            </button>
          ))}
        </div>
      )}
      {x.judge && (
        <div className={s.jg} role="list" aria-label="判断">
          {x.judge.map((j) => (
            <span key={j.label} role="listitem" style={{ display: 'contents' }}>
              <span>{j.label}</span>
              <i data-on={j.on || undefined} style={{ '--p': `${Math.round(j.p * 100)}%` } as CSSProperties} />
              <span className={t.num}>{j.p.toFixed(2)}</span>
              <em>{j.on ? '◀ 选了' : ''}</em>
            </span>
          ))}
        </div>
      )}
      {x.kv.length > 0 && (
        <dl className={s.kv}>
          {x.kv.map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt>{k}</dt>
              <dd>{parts(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      {extra}
      {x.raw && <RawFold label={x.raw.label} lines={x.raw.lines} {...(x.raw.open ? { open: true } : {})} onCopy={onCopy} />}
    </div>
  );
}

export interface StepRowsProps {
  turn: Turn;
  /** Steps toggled away from their default (a failed step opens by itself). */
  toggled: ReadonlySet<string>;
  onToggle: (id: string) => void;
  /** Drawn in the first failed step's body. */
  related: ReactNode;
  onCopy: (text: string) => void;
}

export const isOpen = (x: Step, toggled: ReadonlySet<string>) => (x.st === 'fail') !== toggled.has(x.id);

/** 经过's axis and rows; the time bar of the longest step in the accent colour, 首字 a diamond on 想. */
export function StepRows({ turn, toggled, onToggle, related, onCopy }: StepRowsProps) {
  const top = longestOf(turn.steps);
  const firstFail = turn.steps.find((x) => x.st === 'fail');
  const total = turn.total;
  return (
    <div className={s.steps}>
      <div className={s.axis} aria-hidden="true">
        <span className={s.ax}>
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <span key={f} style={{ left: `${f * 100}%` }} data-mid={(f > 0 && f < 1) || undefined}>
              {f === 0 ? '0' : fmtMs(total * f)}
            </span>
          ))}
        </span>
      </div>
      {turn.steps.map((x) => {
        const body = !!(x.raw || x.kv.length || x.mems?.length || x.judge || x === firstFail);
        const open = body && isOpen(x, toggled);
        const c = x.st === 'fail' ? 'f' : x.st === 'cut' ? 'c' : x.st === 'wait' ? 'w' : x === top ? 'cr' : undefined;
        const sign: Shape | null = x.st === 'ok' ? null : x.st === 'wait' ? 'wait' : x.st;
        return (
          <div key={x.id} style={{ display: 'contents' }}>
            <button
              type="button"
              className={s.st}
              data-step={x.id}
              data-s={x.st}
              data-sub={x.sub || undefined}
              aria-expanded={body ? open : undefined}
              aria-disabled={!body || undefined}
              onClick={() => body && onToggle(x.id)}
            >
              <span className={s.t}>+{fmtMs(x.t0)}</span>
              <span className={s.ib}>
                <StepMark i={x.icon} />
              </span>
              <span className={s.nm}>{x.name}</span>
              <span className={s.sm}>{parts(x.sum)}</span>
              <span>
                {sign && (
                  <span className={t.sg} data-s={sign}>
                    <ShapeMark s={sign} />
                    {sign === 'wait' ? `待批准 ${fmtMs(x.dur)}` : SHAPE_LABEL[sign]}
                  </span>
                )}
              </span>
              <span className={s.trk} title={`${fmtMs(x.t0)} – ${fmtMs(x.t0 + x.dur)}`}>
                {(x.dur > 0 || x.id === 'in') && <i data-c={c} style={{ left: pct(x.t0, total), width: `max(2px, ${pct(x.dur, total)})` }} />}
                {x.ttft != null && <b style={{ left: pct(x.ttft, total) }} title={`首字 ${fmtMs(x.ttft)}`} />}
              </span>
              <span className={s.d}>{x.dur > 0 ? fmtMs(x.dur) : '—'}</span>
              <span className={body ? s.chev : undefined} aria-hidden="true" />
            </button>
            {open && <Body x={x} extra={x === firstFail ? related : null} onCopy={onCopy} />}
          </div>
        );
      })}
    </div>
  );
}
