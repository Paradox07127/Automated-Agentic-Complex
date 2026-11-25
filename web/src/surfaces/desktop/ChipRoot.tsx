import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { getBridge } from '../../bridge';
import type { VisualStateKey } from '../../domain/states';
import { useSystemTheme } from '../../shell/useSystemTheme';
import { StatusMark } from '../../ui/game/StatusMark';
import { stackQuery } from '../stack/demos';
import { isStackApproval } from '../stack/model';
import { useHover } from '../stack/useHover';
import { doingOf } from './bubble/doing';
import type { Bar } from './comm/commReducer';
import { useComm } from './comm/useComm';
import { useAnchor } from './hooks/useAnchor';
import { useDesktopState } from './hooks/useDesktopState';
import { logInfo } from './hooks/useMountedLog';
import { usePresence } from './hooks/usePresence';
import { useRegions } from './hooks/useRegions';
import { chipOf, readPresence, type ChipKind } from './tags/presence';
import styles from './ChipRoot.module.css';

/** The hit circle; the icon inside it is 28 px. */
export const CHIP_HIT = 36;
/** The tip's widest line and its gap from the circle. */
const TIP_W = 240;
const TIP_GAP = 6;
/** The circle sits at the panel's centre, with room for the tip on either side. */
export const CHIP_PANEL = { width: CHIP_HIT + 2 * (TIP_GAP + TIP_W), height: CHIP_HIT };

/** How each kind shows on the mark: its state word, the capsule's text, and the line its tip says. */
const MARK: Record<ChipKind, { state: VisualStateKey; label: string; cap?: string }> = {
  waiting: { state: 'awaiting_approval', label: '待批准', cap: '待批准' },
  error: { state: 'error', label: '出错', cap: '出错' },
  running: { state: 'running', label: '执行中' },
  done: { state: 'done', label: '已完成' },
  offline: { state: 'unreachable', label: '未接入：无法连接后台服务，点击重启', cap: '未接入' },
};

/** Her main line, as the bubble picks it; an error line counts once the bubble has put it away, and stays until it is seen. */
function useLine(still: boolean): Bar | null {
  const [comm] = useComm(null, still);
  const bar = comm.bars.find((b) => b.kind === 'main') ?? comm.bars[0] ?? null;
  const [failed, setFailed] = useState<Bar | null>(null);
  useEffect(() => {
    if (bar?.phase === 'error') setFailed(bar);
  }, [bar]);
  if (bar && bar.phase !== 'fading') return bar.phase === 'error' ? null : bar;
  return failed;
}

/**
 * `stack.html#/chip`, the status mark beside her head for what has no bubble of its own, one at a time: waiting (with
 * 待批准 n), failed, busy, done or unplugged, the panel's only region. Hovered it shows the 正在做 line; clicked, what waits
 * on the user or failed unfolds in the bubble, busy and done open 任务, unplugged restarts agentd. Hidden while she is docked
 * or her hover buttons are open.
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
  const { ref: hitRef, hovered, handlers } = useHover<HTMLSpanElement>();

  // An approval the bubble shows on its paper card is not marked again.
  const [asking, setAsking] = useState(0);
  useEffect(
    () => getBridge().stack.onCards((p) => setAsking(p.cards.filter((c) => isStackApproval(c) && !c.collapsed && !c.outcome).length), () => {}),
    [],
  );
  const shown = chip && !anchor?.docked && !state?.dock.open && !(chip.kind === 'waiting' && asking > 0) ? chip : null;
  // The tip goes away from her.
  const tipSide = (anchor?.toHead?.dx ?? 0) > 0 ? 'left' : 'right';
  const open = () => {
    if (!shown) return;
    const bridge = getBridge();
    if (shown.kind === 'error') setSeen((s) => new Set([...s, ...shown.errors]));
    if (shown.kind === 'waiting' || shown.kind === 'error') void bridge.desktop.action('openStack').catch(() => {});
    else if (shown.kind === 'offline') void bridge.supervisor.restart('agentd').catch(() => {});
    else bridge.window.openMain('/overview');
  };
  const mark = shown ? MARK[shown.kind] : null;
  const tip = shown?.kind === 'running' ? doingOf(presence).text : null;

  return (
    <div
      ref={rootRef}
      className={styles.root}
      data-surface-root="chip"
      data-tip={tipSide}
      style={{ width: CHIP_PANEL.width, height: CHIP_PANEL.height }}
    >
      {shown && mark && (
        <span ref={hitRef} key={shown.kind} className={styles.hit} data-region="" data-chip={shown.kind} {...handlers}>
          <StatusMark state={mark.state} cap={mark.cap} count={shown.kind === 'waiting' ? shown.count : undefined}
            label={shown.kind === 'waiting' ? `${mark.label} ${shown.count} 项` : mark.label} plug={shown.kind === 'offline'}
            mirror={tipSide === 'left'} onClick={open} />
        </span>
      )}
      {shown && hovered && tip && (
        <div className={styles.tip} data-chip-tip="" role="tooltip">
          {tip}
        </div>
      )}
    </div>
  );
}
