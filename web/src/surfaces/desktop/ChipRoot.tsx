import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { getBridge } from '../../bridge';
import { useSystemTheme } from '../../shell/useSystemTheme';
import { stackQuery } from '../stack/demos';
import { useHover } from '../stack/useHover';
import { DoingRow } from './bubble/DoingRow';
import type { Bar } from './comm/commReducer';
import { useComm } from './comm/useComm';
import { useAnchor } from './hooks/useAnchor';
import { useDesktopState } from './hooks/useDesktopState';
import { logInfo } from './hooks/useMountedLog';
import { usePresence } from './hooks/usePresence';
import { useRegions } from './hooks/useRegions';
import { ringOpens } from './RingRoot';
import { chipOf, readPresence, type ChipKind } from './tags/presence';
import styles from './ChipRoot.module.css';

/** The hit circle; the icon inside it is 28 px. */
export const CHIP_HIT = 36;
/** The tip's widest line and its gap from the circle. */
const TIP_W = 240;
const TIP_GAP = 6;
/** The circle sits at the panel's centre, with room for the tip on either side. */
export const CHIP_PANEL = { width: CHIP_HIT + 2 * (TIP_GAP + TIP_W), height: CHIP_HIT };

const LABEL: Record<ChipKind, string> = {
  running: '在忙',
  thinking: '在想',
  offline: '连不上后台',
  waiting: '待处理',
  done: '完成',
  error: '出错了',
  interrupted: '已打断',
};

function Glyph({ kind }: { kind: ChipKind }): ReactNode {
  switch (kind) {
    case 'running':
      return (
        <svg viewBox="0 0 28 28" aria-hidden="true">
          <circle className={styles.track} cx="14" cy="14" r="9" />
          <circle className={styles.arc} cx="14" cy="14" r="9" pathLength="100" />
        </svg>
      );
    case 'thinking':
      return (
        <svg viewBox="0 0 28 28" aria-hidden="true">
          {[8, 14, 20].map((x, i) => (
            <circle key={x} className={styles.dot} cx={x} cy="14" r="2.2" style={{ animationDelay: `${i * 160}ms` }} />
          ))}
        </svg>
      );
    case 'offline':
      return (
        <svg viewBox="0 0 28 28" aria-hidden="true">
          <path d="M6 14h4M18 14h4M10 10v8M18 10v8M12.5 12l3 4" />
        </svg>
      );
    case 'waiting':
      return (
        <svg viewBox="0 0 28 28" aria-hidden="true">
          <circle cx="14" cy="14" r="8" />
          <path className={styles.fill} d="M14 9.5l4.5 4.5-4.5 4.5-4.5-4.5z" />
        </svg>
      );
    case 'done':
      return (
        <svg viewBox="0 0 28 28" aria-hidden="true">
          <circle cx="14" cy="14" r="8.5" />
          <path d="M10 14.3l2.8 2.8 5.4-5.8" />
        </svg>
      );
    case 'error':
      return (
        <svg viewBox="0 0 28 28" aria-hidden="true">
          <path d="M9.5 9.5l9 9M18.5 9.5l-9 9" />
        </svg>
      );
    case 'interrupted':
      return (
        <svg viewBox="0 0 28 28" aria-hidden="true">
          <rect className={styles.fill} x="10" y="10" width="8" height="8" />
        </svg>
      );
  }
}

/** Her main line, as the bubble picks it; an error line stays after its bar until it is seen. */
function useLine(still: boolean): Bar | null {
  const [comm] = useComm(null, still);
  const bar = comm.bars.find((b) => b.kind === 'main') ?? comm.bars[0] ?? null;
  const [failed, setFailed] = useState<Bar | null>(null);
  useEffect(() => {
    if (bar?.phase === 'error') setFailed(bar);
  }, [bar]);
  return bar && bar.phase !== 'fading' ? bar : failed;
}

/**
 * `stack.html#/chip`, the status chip beside her head for what has no bubble of its own: a 28 px icon in a
 * 36 px circle, the panel's only region. Hovered it shows the 正在做 line; clicked it unfolds the HUD for what waits on
 * the user or failed, else opens the bubble. Hidden while she is docked or the ring is open.
 */
export function ChipRoot() {
  const [q] = useState(stackQuery);
  const still = q.get('still') === '1';
  useSystemTheme(q.get('theme'));
  useEffect(() => {
    document.documentElement.classList.toggle('still', still);
  }, [still]);

  const anchor = useAnchor();
  const state = useDesktopState();
  const presence = usePresence();
  const bar = useLine(still);
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());
  // agentd's clock: its time at the snapshot, plus the local time since it arrived.
  const received = useMemo(() => Date.now(), [presence]);
  const sampledAt = readPresence(presence).sampledAt;
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const now = sampledAt != null ? sampledAt * 1000 + Date.now() - received : Date.now();
  const chip = chipOf(presence, bar, now, seen);
  const until = chip?.until ?? null;
  useEffect(() => {
    if (until == null || still) return;
    const t = setTimeout(tick, Math.max(0, until - now));
    return () => clearTimeout(t);
  }, [until, now, still]);

  const rootRef = useRef<HTMLDivElement>(null);
  useRegions(rootRef);
  useEffect(() => logInfo(`mounted chip ${window.location.hash || '#/'}`), []);
  useEffect(() => getBridge().window.setContentSize(CHIP_PANEL), []);
  const { ref: hitRef, hovered, handlers } = useHover<HTMLButtonElement>();

  const shown = chip && !anchor?.docked && !ringOpens(state) ? chip : null;
  // The tip goes away from her.
  const tipSide = (anchor?.toHead?.dx ?? 0) > 0 ? 'left' : 'right';
  const open = () => {
    if (!shown) return;
    const bridge = getBridge();
    if (shown.kind === 'error') setSeen((s) => new Set([...s, ...shown.errors]));
    const go = shown.kind === 'waiting' || shown.kind === 'error' ? bridge.desktop.action('openStack') : bridge.desktop.action('quickInput');
    void go.catch(() => {});
  };
  const label = shown?.kind === 'waiting' ? `${LABEL.waiting} ${shown.count} 项` : shown ? LABEL[shown.kind] : '';

  return (
    <div
      ref={rootRef}
      className={styles.root}
      data-surface-root="chip"
      data-tip={tipSide}
      style={{ width: CHIP_PANEL.width, height: CHIP_PANEL.height }}
    >
      {shown && (
        <button
          ref={hitRef}
          key={shown.kind}
          type="button"
          className={styles.hit}
          data-region=""
          data-chip={shown.kind}
          aria-label={label}
          onClick={open}
          {...handlers}
        >
          <span className={styles.icon}>
            <Glyph kind={shown.kind} />
          </span>
          {shown.kind === 'waiting' && <span className={`${styles.count} num`}>{shown.count}</span>}
        </button>
      )}
      {shown && hovered && (
        <div className={styles.tip} data-chip-tip="" role="tooltip">
          <DoingRow presence={presence} />
        </div>
      )}
    </div>
  );
}
