import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Btn, IconBtn, Tabs, useOverlayFocus } from '../../ui';
import styles from './Chat.module.css';

export type RightTab = 'turn' | 'task';

export interface RightPanelProps {
  tab: RightTab;
  /** The conversation has a role task: the 任务 tab shows. */
  hasTask: boolean;
  /** The turn shown in the drawer. */
  turn: string | null;
  onTab: (tab: RightTab) => void;
  onClose: () => void;
  children: ReactNode;
}

/** View flags the jump keeps, as the sidebar links do. */
function carry(prev: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  if (prev.theme !== undefined) next.theme = prev.theme;
  if (prev.still !== undefined) next.still = prev.still;
  return next;
}

function OverlayPanel({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLElement>(null);
  const trap = useOverlayFocus(panel, onClose);
  return (
    <>
      <button type="button" className={styles.scrim} tabIndex={-1} aria-hidden="true" onClick={onClose} />
      <aside ref={panel} className={styles.rp} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={trap}>{children}</aside>
    </>
  );
}

/** The detail column becomes a keyboard-contained overlay at small widths. */
export function RightPanel({ tab, hasTask, turn, onTab, onClose, children }: RightPanelProps) {
  const navigate = useNavigate();
  const label = tab === 'turn' ? '轮次详情' : '任务';
  const [narrow, setNarrow] = useState(() => window.matchMedia?.('(max-width: 1099px)').matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.('(max-width: 1099px)');
    if (!mq) return;
    const changed = () => setNarrow(mq.matches);
    mq.addEventListener('change', changed);
    return () => mq.removeEventListener('change', changed);
  }, []);
  const body = (
    <>
        <div className={styles.rpH}>
          <Tabs
            label="右栏"
            keys={false}
            value={tab}
            tabs={
              hasTask
                ? [
                    { id: 'turn', label: '轮次详情' },
                    { id: 'task', label: '任务' },
                  ]
                : [{ id: 'turn', label: '轮次详情' }]
            }
            onChange={(v) => onTab(v as RightTab)}
          />
          <span className={styles.sp} />
          {tab === 'turn' && turn && (
            <Btn variant="text" size="sm" onClick={() => void navigate({ to: '/trace', search: (prev: Record<string, unknown>) => ({ ...carry(prev), turn }) })}>
              完整运行记录 ↗
            </Btn>
          )}
          <IconBtn icon="close" label="收起右栏" onClick={onClose} />
        </div>
        <div className={styles.rpB}>{children}</div>
    </>
  );
  return narrow ? <OverlayPanel label={label} onClose={onClose}>{body}</OverlayPanel> : <aside className={styles.rp} aria-label={label}>{body}</aside>;
}

/** Demos that open the task tab on load. */
const TASK_DEMOS = ['plan-snapshot', 'reject'];
export type Rp = { tab: RightTab; turn: string | null; taskId?: string } | null;
export const initialRp = (demo: string | null, turn: string | null): Rp => (TASK_DEMOS.includes(demo ?? '') ? { tab: 'task', turn: null } : turn ? { tab: 'turn', turn } : null);
