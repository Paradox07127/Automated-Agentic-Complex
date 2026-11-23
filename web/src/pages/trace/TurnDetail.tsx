import type { ReactNode } from 'react';
import type { ChartStatus } from '../../charts';
import { isoToMs } from '../../domain';
import type { WireTraceTurn } from '../../domain/wire';
import { Btn, Fold, SecHead } from '../../ui';
import { GameFrame, StatusLamp } from '../../ui/game';
import { fmtMs } from '../chat/turnTrace';
import { clockOf, dayOf, fmtK, LAMP, SHAPE_LABEL, shapeOf, srcLabel } from './data';
import { StepRows } from './StepRows';
import { longestOf, type Turn } from './steps';
import type { Seq } from './useLogs';
import { LOG_NAME } from './useLogs';
import cd from './Card.module.css';
import d from './Detail.module.css';
import rw from './Raw.module.css';
import t from './Trace.module.css';

/** The head's barcode band (mailpanel title deco, redrawn); text only for the eye. */
function Band({ no, trace }: { no: number; trace: string | null }) {
  return (
    <svg viewBox="0 0 340 56" preserveAspectRatio="xMaxYMid slice" aria-hidden="true">
      <path d="M40 0h300v56H40z" fill="currentColor" />
      <path d="M40 0h14L40 56z" fill="var(--ef-surface-2)" />
      <g fill="var(--ef-surface-2)">
        <rect x="54" y="0" width="12" height="12" />
        <rect x="66" y="12" width="12" height="12" />
        <rect x="54" y="24" width="12" height="12" />
        <rect x="66" y="40" width="12" height="16" />
      </g>
      <path d="M96 14l9-9 9 9h-6v10h-6V14zM96 32h18v3H96zM96 38h18v2H96z" fill="var(--ef-on-accent)" opacity=".85" />
      <text x="126" y="20" fill="var(--ef-on-accent)" fontSize="9" fontWeight="600" letterSpacing="1.4" fontFamily="Saira, sans-serif">
        TRACE // {trace ? `${trace.slice(0, 4).toUpperCase()}-${String(no).padStart(4, '0')}` : '----'}
      </text>
      <text x="126" y="33" fill="var(--ef-on-accent)" opacity=".6" fontSize="9" letterSpacing="1.2" fontFamily="Saira, sans-serif">AIC // RUN RECORD // LOCAL ONLY</text>
      <g fill="var(--ef-on-accent)">
        {Array.from({ length: 18 }, (_, i) => (
          <rect key={i} x={126 + i * 6 + (i % 3)} y="40" width={1 + ((i * 7) % 3)} height="11" />
        ))}
      </g>
      <path d="M296 0h44v56h-44z" fill="var(--ef-surface-3)" />
      <path d="M306 8v7M302.5 11.5h7M306 41v7M302.5 44.5h7M318 14h14M320 20h10M318 26h14M320 32h10M318 38h14" stroke="var(--ef-text-2)" strokeWidth="1.5" />
      <rect x="186" y="53" width="30" height="3" fill="var(--ef-tri-a)" />
      <rect x="220" y="53" width="30" height="3" fill="var(--ef-tri-b)" />
      <rect x="254" y="53" width="24" height="3" fill="var(--ef-tri-c)" />
    </svg>
  );
}

const unit = (text: string) => {
  const m = /^(.*) (\S+)$/.exec(text);
  return m ? (
    <>
      {m[1]}
      <small>{m[2]}</small>
    </>
  ) : (
    text
  );
};

export interface TurnDetailProps {
  row: WireTraceTurn | null;
  no: number;
  turn: Turn | null;
  st: ChartStatus;
  emptyText: string;
  convTitle: string | null;
  /** Error and warning lines around the turn. */
  related: Seq[];
  onRetry: () => void;
  onOpenChat: (() => void) | null;
  onLogs: () => void;
  onCopy: (text: string, done: string) => void;
}

/** The head band: the state's bars, TURN and its number, the title, the barcode band. */
function Head({ row, no, shape, title, sub }: { row: WireTraceTurn | null; no: number; shape?: string | null; title: string; sub?: ReactNode }) {
  return (
    <div className={d.hd} data-s={shape ?? undefined}>
      <span className={d.bars} aria-hidden="true">
        <i />
        <i />
      </span>
      <span className={d.no}>
        <small aria-hidden="true">TURN</small>
        <b>{row ? String(no).padStart(3, '0') : '----'}</b>
      </span>
      <span className={d.ttl}>
        <b title={title}>{title}</b>
        {sub && <small>{sub}</small>}
      </span>
      <span className={d.band}>
        <Band no={no} trace={row?.trace_id ?? null} />
      </span>
    </div>
  );
}

export function TurnDetail({ row, no, turn, st, emptyText, convTitle, related, onRetry, onOpenChat, onLogs, onCopy }: TurnDetailProps) {
  const shape = row ? shapeOf(row) : null;
  if (!row || !turn || st !== 'ok') {
    const msg = st === 'error' ? '读不到这一轮' : st === 'loading' ? '正在读…' : emptyText;
    return (
      <GameFrame label="这一轮">
        <div className={d.dt}>
          <Head row={row} no={no} title={row?.head ?? ''} />
          <div className={d.scroll}>
            <div className={t.empty}>
              <span className={t.bc} aria-hidden="true" />
              <b>{msg}</b>
              {st === 'error' && <Btn variant="secondary" size="sm" icon="refresh" onClick={onRetry}>重试</Btn>}
              {st !== 'error' && st !== 'loading' && row && onOpenChat && <Btn variant="secondary" size="sm" icon="ext" onClick={onOpenChat}>在对话中打开</Btn>}
            </div>
          </div>
        </div>
      </GameFrame>
    );
  }
  const start = isoToMs(row.started_at);
  const title = turn.input ? turn.input.split('\n')[0]! : row.head ? `${row.head}${(row.len ?? 0) > row.head.length ? '…' : ''}` : srcLabel(row.source);
  const top = longestOf(turn.steps);
  const tok = turn.tokens;
  const relatedBlock: ReactNode =
    related.length > 0 ? (
      <div className={cd.related}>
        <span>这一轮前后的日志 │ {related.length} 行</span>
        {related.map((l) => (
          <div key={l.key} className={cd.rl} data-l={l.level}>
            <span>{l.at != null ? clockOf(l.at, true) : '—'}</span>
            <span>{LOG_NAME[l.source]}</span>
            <span title={l.text}>{l.text}</span>
          </div>
        ))}
        <span>
          <Btn variant="text" size="sm" onClick={onLogs}>在日志里看这一轮前后 ›</Btn>
        </span>
      </div>
    ) : null;
  const failed = turn.steps.some((x) => x.st === 'fail');
  return (
    <GameFrame label="这一轮">
      <div className={d.dt}>
        <Head row={row} no={no} shape={shape} title={title} sub={<>{convTitle ? `对话「${convTitle}」 │ ` : ''}trace {row.trace_id.slice(0, 8)}…</>} />
        <div className={d.scroll} key={row.turn_id}>
          <div className={d.metar}>
            <span className={d.ctag}>{srcLabel(row.source)}</span>
            <span className={d.when}>
              &lt; {dayOf(start)} {clockOf(start)} &gt;
            </span>
            {shape && <StatusLamp state={LAMP[shape]} label={SHAPE_LABEL[shape]} />}
            {turn.code && <span className={`${t.mono} ${d.code}`}>{turn.code}</span>}
            <span className={d.sp} />
            {onOpenChat && (
              <Btn variant="secondary" size="sm" icon="ext" onClick={onOpenChat}>
                在对话中打开
              </Btn>
            )}
          </div>
          <div className={d.rband}>
            <div className={d.ro} data-k={shape === 'fail' ? 'bad' : undefined}>
              <b>{shape === 'run' ? `${fmtMs(row.duration_ms)}…` : unit(fmtMs(row.duration_ms))}</b>
              <span>用时</span>
            </div>
            <div className={d.ro}>
              <b>{turn.ttft != null ? unit(fmtMs(turn.ttft)) : '—'}</b>
              <span>首字</span>
            </div>
            <div className={d.ro}>
              <b>{tok ? fmtK(tok.in + tok.out) : '—'}</b>
              <span>{tok && tok.cache != null && tok.in > 0 ? `token │ 缓存 ${Math.round((tok.cache / tok.in) * 100)}%` : 'token'}</span>
            </div>
            <div className={d.ro}>
              <b>{turn.cost != null ? <><small>$</small>{turn.cost.toFixed(3)}</> : '—'}</b>
              <span>花费</span>
            </div>
            <div className={d.ro} data-k="txt">
              <b>{turn.model ?? '没调模型'}</b>
              <span>{[row.provider, row.account_label].filter(Boolean).join(' │ ') || '—'}</span>
            </div>
          </div>
          <section className={cd.pn} aria-label="经过">
            <SecHead
              title="经过"
              count={turn.steps.length}
              right={
                <span className={cd.sub}>
                  {top && top.dur > 0 && (
                    <span className={cd.lg}>
                      <i aria-hidden="true" />
                      最长：{top.name} {fmtMs(top.dur)}
                    </span>
                  )}
                  {turn.ttft != null && (
                    <span className={cd.lg}>
                      <i data-d="" aria-hidden="true" />
                      首字
                    </span>
                  )}
                </span>
              }
            />
            <StepRows turn={turn} related={relatedBlock} onCopy={(text) => onCopy(text, '已复制')} />
          </section>
          {!failed && relatedBlock}
          <Fold
            id="raw-events"
            label="原始事件"
            count={turn.events.length}
            summary="含各进程回执"
            right={
              <Btn variant="text" size="sm" icon="copy" onClick={() => onCopy(JSON.stringify(turn.events.map(({ text: _text, ...e }) => e), null, 2), '已复制这一轮的事件 JSON（不含原文）')}>
                复制 JSON
              </Btn>
            }
          >
            <div className={rw.evt}>
              <table>
                <thead>
                  <tr>
                    <th>+ms</th>
                    <th>事件</th>
                    <th>状态</th>
                    <th>进程</th>
                  </tr>
                </thead>
                <tbody>
                  {turn.events.map((e, i) => (
                    <tr key={i} data-f={e.status === 'failed' || undefined}>
                      <td className={t.num}>{Math.round(isoToMs(e.t_wall) - start)}</td>
                      <td className={t.mono}>{e.kind}</td>
                      <td>{e.status}</td>
                      <td>{e.producer ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Fold>
        </div>
      </div>
    </GameFrame>
  );
}
