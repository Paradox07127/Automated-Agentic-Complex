import { useState } from 'react';
import { Btn, CharacterArt, StatusTag } from '../../ui';
import { Silhouette } from '../character/Figure';
import { useLivePreview } from '../character/usePreview';
import styles from './Stage.module.css';

export interface MmdStageProps {
  /** Character id for the shell's live preview. */
  character: string;
  head?: string | undefined;
  portrait?: string | undefined;
  /** Avatar scale in percent. */
  scale: number;
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

/** 舞台：实机模型画在这块矩形上（壳的置顶透明画布），矩形里没有能点的控件；预览没加载时左上一条不能点的签条。 */
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
      <svg className={styles.rings} viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true">
        <ellipse cx={50} cy={10} rx={49} ry={9} />
        <ellipse cx={50} cy={10} rx={29} ry={5.4} />
      </svg>
      <div className={styles.fig} style={{ transform: `translateX(-50%) scale(${0.8 + p.scale / 500})` }}>
        {p.portrait ? (
          <CharacterArt src={p.portrait} kind="portrait" w={520} h={520} fallback={<Silhouette />} />
        ) : (
          <CharacterArt src={p.head} kind="head" w={152} h={212} fallback={<Silhouette />} />
        )}
      </div>
      {preview.phase === 'failed' && (
        <span className={styles.pv} role="status">
          <i aria-hidden="true" />
          {preview.message}
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
