import { useState } from 'react';
import type { AvatarAction } from '../../bridge';
import { NodeChain, type ChainNode } from '../../charts';
import { SWITCH_STAGE_LABELS, SWITCH_STAGES } from './tables';
import { Btn, CharacterArt, Spinner, StatusTag } from '../../ui';
import { Emblem, Silhouette } from './Figure';
import { useLivePreview } from './usePreview';
import type { SwitchState } from './useSwitch';
import styles from './Stage.module.css';

export interface StagePlay {
  label: string;
  speed: number;
  /** 0–1; null when the motion has no duration. */
  progress: number | null;
}

export interface StageProps {
  motion: AvatarAction | undefined;
  section: string;
  name: string;
  /** Latin name under the name. */
  en?: string | undefined;
  /** Where the stage stands: right of the name on 总览, left of the panel on a detail page, beside the 拍照 panel; absent is a detail page. */
  mode?: StageMode;
  /** Host art; the portrait wins over the head. */
  head?: string | undefined;
  portrait?: string | undefined;
  activity: string | null;
  /** Avatar scale in percent. */
  scale: number;
  offline: boolean;
  /** supervisor.state backoff seconds. */
  backoff: number | null;
  onRestart: () => void;
  sw: SwitchState;
  currentName: string;
  onRetry: () => void;
  onDismiss: () => void;
  play: StagePlay | null;
  /** Character id for the shell's live preview, which covers the art while it draws; absent keeps the art. */
  characterId?: string;
  /** Action the user picked to preview live; absent plays the idle. */
  previewAction?: string | undefined;
  previewAppearance?: string | undefined;
  previewRequest?: number | undefined;
  /** The previewed action starts over at its end (播放方式 循环); absent plays it once. */
  loop?: boolean;
}

export type StageMode = 'overview' | 'detail' | 'photo';

const secs = (d: number) => `${d.toFixed(1)} s`;

/** 目录读到之前的空舞台：同样的画框和影子。 */
export function StageSkel() {
  return (
    <div className={styles.frame} data-mode="overview">
      <div className={styles.stage} data-stage="" aria-busy="true" />
    </div>
  );
}

/** The live preview stage on the training room floor, and the name block: her name, what she is doing, the selected motion and playback feedback. */
export function Stage(p: StageProps) {
  const m = p.motion;
  const spec: Array<[k: string, v: string]> = [];
  if (m?.trigger) spec.push(['触发', m.trigger]);
  const meta = [p.section, m?.requiredReason ? '必需' : null, m?.missing ? '⊘ 缺资源' : null].filter(Boolean).join(' │ ');
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const preview = useLivePreview(p.characterId ? el : null, {
    character: p.characterId ?? '',
    action: p.previewAction,
    appearance: p.previewAppearance,
    request: p.previewRequest,
    loop: p.loop,
    blocked: p.offline || p.sw.phase !== 'idle',
  });
  return (
    <div className={styles.frame} data-stage="" data-mode={p.mode ?? 'detail'}>
      <div ref={setEl} className={styles.stage} data-off={p.offline || undefined} data-preview-stage="" data-live={preview.phase === 'live' || undefined}>
        <svg className={styles.rings} viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true">
          <ellipse cx={50} cy={10} rx={49} ry={9} />
          <ellipse cx={50} cy={10} rx={30} ry={5.5} />
        </svg>
        <div className={styles.fig} style={{ transform: `translateX(-50%) scale(${0.8 + p.scale / 500})` }}>
          {p.portrait ? (
            <CharacterArt src={p.portrait} kind="portrait" w={520} h={520} fallback={<Silhouette />} />
          ) : (
            <CharacterArt src={p.head} kind="head" w={152} h={212} fallback={<Silhouette />} />
          )}
        </div>
        {p.offline && (
          <div className={styles.ovl} data-theme="dark" role="status">
            <StatusTag state="unreachable" label="角色未运行" />
            {p.backoff != null && <span className={styles.cap}>退避 {p.backoff} 秒后重试</span>}
            <Btn variant="secondary" onClick={p.onRestart}>重启角色</Btn>
          </div>
        )}
        {p.sw.phase !== 'idle' && <SwitchOverlay sw={p.sw} currentName={p.currentName} onRetry={p.onRetry} onDismiss={p.onDismiss} />}
      </div>
      <div className={styles.details} data-g="info">
        <div className={styles.nm} data-nameplate="" data-g="root">
          <span className={styles.plate} data-g="nameplate">
            <Emblem className={styles.emblem} />
            <span className={styles.names}>
              <b className={styles.name}>{p.name}</b>
              {p.en && <span className={styles.en}>{p.en}</span>}
            </span>
          </span>
          {!p.offline && p.activity && (
            <span className={styles.act} data-g="level">
              <span className={styles.actK}>在做</span>
              {p.activity}
            </span>
          )}
        </div>
        {m && <div className={styles.motion} data-g="tags">
          <b>{m.label}</b>
          {m.durationS != null && <span className="num">{secs(m.durationS)}</span>}
          {meta && <span className={styles.cap}>{meta}</span>}
        </div>}
        {spec.length > 0 && (
          <dl className={styles.spec} data-g="attrs">
            {spec.map(([k, v]) => (
              <div key={k}>
                <dt className={styles.specK}>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        )}
        {preview.phase === 'loading' && <span className={styles.cap} role="status"><Spinner label="正在载入预览" /> 正在载入预览</span>}
        {preview.phase === 'failed' && <div className={styles.ovlRow} role="status">
          <span className={styles.cap}>{preview.message}</span>
          <Btn size="sm" variant="quiet" onClick={preview.retry}>重试预览</Btn>
        </div>}
        {p.play && (
          <div className={styles.playing} role="status">
            <span className={styles.plT}>
              {p.play.progress != null && p.play.progress >= 1 ? '播放完成' : '桌面播放中'} │ {p.play.label} <span className="num">{p.play.speed}×</span>
            </span>
            {p.play.progress != null && (
              <span className={styles.plL}>
                <i style={{ width: `${p.play.progress * 100}%` }} />
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 切换中：「正在切换到 X · 输入暂停」；失败时节点链停在外壳报出的那一格并写原因。 */
function SwitchOverlay({ sw, currentName, onRetry, onDismiss }: { sw: Exclude<SwitchState, { phase: 'idle' }>; currentName: string; onRetry: () => void; onDismiss: () => void }) {
  // The shell reports a stage only when a switch fails, so a running switch shows no progress.
  const at = sw.phase === 'failed' ? sw.stage : null;
  const nodes: ChainNode[] =
    at == null
      ? []
      : SWITCH_STAGES.map((stage, i) => ({
          label: SWITCH_STAGE_LABELS[stage],
          state: i === at ? 'broken' : i < at ? 'done' : 'unreachable',
          sub: i === at ? '停在这里' : i < at ? '完成' : '',
        }));
  const failed = sw.phase === 'failed';
  return (
    <div className={styles.ovl} data-theme="dark" role={failed ? 'alert' : 'status'}>
      <b>{failed ? `切换到 ${sw.target.name} 没有完成` : `正在切换到 ${sw.target.name}`}</b>
      <span className={styles.cap}>{failed ? `仍是 ${currentName}` : '输入暂停'}</span>
      {nodes.length > 0 && (
        <div className={styles.chain}>
          <NodeChain label={`切换到 ${sw.target.name}`} nodes={nodes} size="compact" />
        </div>
      )}
      {failed && (
        <>
          <span className={styles.fail}>■ {sw.reason}</span>
          <div className={styles.ovlRow}>
            <Btn size="sm" variant="ghost" onClick={onDismiss}>
              关闭
            </Btn>
            <Btn size="sm" variant="secondary" icon="refresh" onClick={onRetry}>
              重试
            </Btn>
          </div>
        </>
      )}
    </div>
  );
}
