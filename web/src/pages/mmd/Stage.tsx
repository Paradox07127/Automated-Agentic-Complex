import { useState } from 'react';
import { Btn, Icon, StatusTag } from '../../ui';
import { LoadBar } from '../../ui/game';
import { useLivePreview } from '../character/usePreview';
import styles from './Stage.module.css';

export interface MmdStageProps {
  /** Character id for the shell's live preview. */
  character: string;
  /** Her name on the loading bar. */
  name?: string | undefined;
  offline: boolean;
  /** supervisor.state backoff seconds. */
  backoff: number | null;
  onRestart: () => void;
  /** The dance to preview; absent plays her idle. */
  action: string | undefined;
  request: number | undefined;
  appearance: string | undefined;
  loop: boolean;
}

/** 舞台：实机模型画在这块矩形上（壳的置顶透明画布）；整套重新载入时画载入条；预览画不出来时舞台留空，左上一条签条写原因、带重试键。 */
export function MmdStage(p: MmdStageProps) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const preview = useLivePreview(p.character ? el : null, {
    character: p.character,
    action: p.action,
    appearance: p.appearance,
    request: p.request,
    loop: p.loop,
    blocked: p.offline,
  });
  return (
    <div ref={setEl} className={styles.stage} data-stage="" data-character={p.character} data-preview-stage="" data-off={p.offline || undefined} data-live={preview.phase === 'live' || undefined}>
      {preview.progress != null && (
        <div className={styles.load}>
          <LoadBar fraction={preview.progress} name={p.name} />
        </div>
      )}
      {preview.phase === 'failed' && (
        <span className={styles.pv} role="status">
          <i aria-hidden="true" />
          {preview.message}
          <button type="button" className={styles.retry} aria-label="重试预览" title="重试预览" onClick={preview.retry}>
            <Icon name="refresh" size={14} />
          </button>
        </span>
      )}
      {p.offline && (
        <div className={styles.ovl} data-theme="dark" role="status">
          <StatusTag state="unreachable" label="角色未运行" />
          {p.backoff != null && <span className={styles.cap}>退避 {p.backoff} 秒后重试</span>}
          <Btn variant="secondary" onClick={p.onRestart}>
            重启角色
          </Btn>
        </div>
      )}
    </div>
  );
}
