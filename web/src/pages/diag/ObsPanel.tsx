import { useState } from 'react';
import { formatClock, formatMs, type WireDiagObservation } from '../../domain';
import { isoToMsOrNull } from '../../domain/units';
import { ObsDetail, OBS_ID } from './ObsDetail';
import styles from './State.module.css';

export interface ObsPanelProps {
  observation: WireDiagObservation;
  /** When this block arrived; waited_ms only moves with the clock, so the wait grows from here. */
  readAt: number;
  now: number;
  /** Request whose detail starts open. */
  open?: string | null;
}

const MODE: Readonly<Record<string, string>> = { text: '窗口文字', ocr: '识字', image: '截图' };
/** Observation states: declined and unavailable are policy outcomes, not faults (server.py OBSERVED). */
const RESULT: Readonly<Record<string, ['ok' | 'fail' | 'skip', string]>> = {
  ready: ['ok', '成功'],
  failed: ['fail', '失败'],
  declined: ['skip', '拒绝'],
  unavailable: ['skip', '不可用'],
  expired: ['skip', '过期'],
  cancelled: ['skip', '取消'],
};

const REASON: Readonly<Record<string, string>> = { timeout: '超时', blacklisted: '在黑名单里' };
const withReason = (text: string, reason: string | null) => (reason ? `${text} │ ${REASON[reason] ?? reason}` : text);

/** What switches observation off right now (paused / quiet until, meeting, off). */
function offText(o: WireDiagObservation): string | null {
  if (o.off) return '观察已关';
  const paused = isoToMsOrNull(o.paused_until);
  if (paused != null) return `暂停到 ${formatClock(paused)}`;
  const quiet = isoToMsOrNull(o.quiet_until);
  if (quiet != null) return `安静到 ${formatClock(quiet)}`;
  return o.meeting ? '开会中' : null;
}

/** Each pending request as a growing wait bar, then the last five results as shapes; a shape opens that request. */
export function ObsPanel({ observation: o, readAt, now, open: initial }: ObsPanelProps) {
  const off = offText(o);
  const [open, setOpen] = useState<string | null>(initial ?? null);
  return (
    <div className={styles.obs}>
      <span className={styles.panelHead}>观察请求</span>
      {off && <span className={styles.t2}>{off}</span>}
      {o.pending.length === 0 && <span className={styles.t3}>现在没有等待中的请求</span>}
      {o.pending.map((p) => {
        const ms = p.waited_ms + Math.max(0, now - readAt);
        return (
          <span key={p.request_id} className={styles.gateRow} title={withReason(`等待中 │ ${MODE[p.mode] ?? p.mode}`, p.reason)}>
            <span className={`${styles.obsBar} meter-frame`} data-level={ms < 2500 ? 'low' : ms < 4000 ? 'mid' : 'high'} role="meter" aria-valuenow={ms} aria-valuemin={0} aria-valuemax={5000} aria-label={`已等待 ${formatMs(ms)}`}>
              <i style={{ width: `${Math.min(100, Math.max(2, (ms / 5000) * 100))}%` }} />
            </span>
            <span className="num">{formatMs(ms)}</span>
            <span className={styles.t3}>│ {MODE[p.mode] ?? p.mode}</span>
          </span>
        );
      })}
      <span className={styles.gateRow}>
        <span className={styles.t3}>最近 {o.recent.length} 条</span>
        <span className={styles.obsDots} role="group" aria-label={o.recent.map((r) => RESULT[r.state]?.[1] ?? r.state).join('，') || '没有'}>
          {o.recent.map((r) => {
            const [kind, text] = RESULT[r.state] ?? ['skip', r.state];
            const title = withReason(`${text} │ ${MODE[r.mode] ?? r.mode}`, r.reason);
            const mark = kind === 'fail' ? '■' : kind === 'ok' ? '✓' : '·';
            return OBS_ID.test(r.request_id) ? (
              <button
                key={r.request_id}
                type="button"
                data-r={kind}
                title={title}
                aria-label={`看这条观察：${title}`}
                aria-pressed={open === r.request_id}
                onClick={() => setOpen((x) => (x === r.request_id ? null : r.request_id))}
              >
                {mark}
              </button>
            ) : (
              <i key={r.request_id} data-r={kind} title={title}>
                {mark}
              </i>
            );
          })}
        </span>
      </span>
      {open && <ObsDetail key={open} id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
