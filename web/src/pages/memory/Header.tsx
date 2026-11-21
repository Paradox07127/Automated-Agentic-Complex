import { useRef } from 'react';
import { gameClips } from '../../design/gameClips.generated';
import { PageHeaderSlot } from '../../shell/headerSlot';
import { Btn, Menu, type MenuItem } from '../../ui';
import { hm } from './model';
import { useEntrance } from './motion';
import styles from './Header.module.css';

export interface HeaderProps {
  recording: boolean;
  candidateCount: number;
  activeCount: number;
  /** Finish time of the last consolidation run; null when there is none, undefined while still reading. */
  lastRun: number | null | undefined;
  onRecording: (on: boolean) => void;
  onExport: () => void;
  /** Why export is off (this window cannot save files); null when it works. */
  exportOff: string | null;
  onRecords: () => void;
  onClear: () => void;
}

// The divider is drawn in line-strong: the stylesheet's rule colour falls under 3:1 on the bar.
const Sep = () => (
  <span className={styles.sep} style={{ color: 'var(--ef-line-strong)' }} aria-hidden="true">
    │
  </span>
);

/** 页头右侧：「记录中 │ 待确认 3 │ 已记住 16 │ 上次整理 14:20」字段行、[暂停记忆] / [恢复记忆]、⋯ 导出 / 清空。 */
export function Header({ recording, candidateCount, activeCount, lastRun, onRecording, onExport, exportOff, onRecords, onClear }: HeaderProps) {
  const status = useRef<HTMLSpanElement>(null);
  const entrance = useEntrance(status, gameClips.prtsIn);
  const more: MenuItem[] = [
    { kind: 'item', label: '导出全部记忆…', hint: 'JSON', ...(exportOff ? { disabled: true, reason: exportOff } : {}), onSelect: onExport },
    { kind: 'item', label: '查看整理记录', onSelect: onRecords },
    { kind: 'sep' },
    { kind: 'item', label: '清空记忆…', danger: true, onSelect: onClear },
  ];
  return (
    <PageHeaderSlot
      right={
        <span ref={status} className={styles.status} role="status" data-off={!recording || undefined} data-g="top">
          {entrance}
          <span className={styles.state}>{recording ? '记录中' : '已暂停'}</span>
          {/* A narrow top bar folds the fields from the last. */}
          <span data-fold="1">
            <Sep />
            <span className={styles.f} role="status" aria-label="记忆数量">
              待确认 <span className="num">{candidateCount}</span>
              <Sep />
              已记住 <span className="num">{activeCount}</span>
            </span>
          </span>
          {lastRun !== undefined && (
            <span data-fold="2">
              <Sep />
              <span className={styles.f}>
                {lastRun != null ? (
                  <>
                    上次整理 <span className="num">{hm(lastRun)}</span>
                  </>
                ) : (
                  '还没有整理'
                )}
              </span>
            </span>
          )}
        </span>
      }
      action={
        <>
          {recording ? (
            <Btn size="sm" variant="ghost" onClick={() => onRecording(false)}>
              暂停记忆
            </Btn>
          ) : (
            <Btn size="sm" variant="primary" tail="play" onClick={() => onRecording(true)}>
              恢复记忆
            </Btn>
          )}
          <Menu icon="more" label="导出 / 清空" align="right" items={more} />
        </>
      }
    />
  );
}
