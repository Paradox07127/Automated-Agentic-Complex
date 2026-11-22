import { useState, type ReactNode } from 'react';
import { NodeChain, type ChainNode } from '../../charts';
import { SWITCH_STAGE_LABELS, SWITCH_STAGES } from './tables';
import { Btn, CharacterArt, Spinner, StatusTag } from '../../ui';
import { Diamond } from '../../ui/game';
import { Silhouette } from './Figure';
import { NameBlock, OfflineRow, SwitchRow, type VoiceBinding } from './NameBlock';
import { useLivePreview } from './usePreview';
import type { SwitchState } from './useSwitch';
import styles from './Stage.module.css';

/** One line for the slot under a detail stage; `warn` is a reason the desktop preview cannot run. */
export interface StageStatus {
  text: ReactNode;
  tone?: 'warn';
}

export interface StageProps {
  /** Empty draws no name block. */
  name: string;
  /** Latin name under the name. */
  en?: string | undefined;
  /** She is the one on the desktop: the 在桌面 mark on the name block. */
  active?: boolean | undefined;
  /** Her voice binding under the name; absent or null draws no voice line. */
  voice?: VoiceBinding | null | undefined;
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
  /** Detail pages: the page's line for the slot under the stage; a `warn` line goes before the live preview's loading or failure, any other after its failure. */
  status?: StageStatus | null | undefined;
  /** Detail pages: the page's action bar stands under the slot, so the stage ends above both. */
  deck?: boolean;
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

/** 目录读到之前的空舞台：同样的画框和影子。 */
export function StageSkel() {
  return (
    <div className={styles.frame} data-mode="overview">
      <div className={styles.stage} data-stage="" aria-busy="true" />
    </div>
  );
}

/** The live preview stage on the training room floor. On 总览 the name block and the state rows (not running, a switch) stand beside it; on a detail page one status line stands in the slot under it, outside the rect the live preview covers. */
export function Stage(p: StageProps) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const preview = useLivePreview(p.characterId ? el : null, {
    character: p.characterId ?? '',
    action: p.previewAction,
    appearance: p.previewAppearance,
    request: p.previewRequest,
    loop: p.loop,
    blocked: p.offline || p.sw.phase !== 'idle',
  });
  const mode = p.mode ?? 'detail';
  const overview = mode === 'overview';
  const previewNote = (
    <>
      {preview.phase === 'loading' && <span className={styles.cap} role="status"><Spinner label="正在载入预览" /> 正在载入预览</span>}
      {preview.phase === 'failed' && <div className={styles.ovlRow} role="status">
        <span className={styles.cap}>{preview.message}</span>
        <Btn size="sm" variant="quiet" onClick={preview.retry}>重试预览</Btn>
      </div>}
    </>
  );
  const warn = p.status?.tone === 'warn' ? p.status : null;
  const line: StageStatus | null =
    warn ??
    (preview.phase === 'failed'
      ? {
          text: (
            <>
              {preview.message}
              <button type="button" className={styles.retry} onClick={preview.retry}>
                重试预览
              </button>
            </>
          ),
          tone: 'warn',
        }
      : (p.status ?? (preview.phase === 'loading' ? { text: '正在载入预览' } : null)));
  return (
    <div className={styles.frame} data-stage="" data-mode={mode} data-deck={(mode === 'detail' && p.deck) || undefined}>
      <div ref={setEl} className={styles.stage} data-off={p.offline || undefined} data-preview-stage="" data-live={preview.phase === 'live' || undefined}>
        {overview && <span className={styles.ticks} aria-hidden="true"><i /><i /><i /><i /></span>}
        <div className={styles.fig} style={{ transform: `translateX(-50%) scale(${0.8 + p.scale / 500})` }}>
          {p.portrait ? (
            <CharacterArt src={p.portrait} kind="portrait" w={520} h={520} fallback={<Silhouette />} />
          ) : (
            <CharacterArt src={p.head} kind="head" w={152} h={212} fallback={<Silhouette />} />
          )}
        </div>
        {!overview && p.offline && (
          <div className={styles.ovl} data-theme="dark" role="status">
            <StatusTag state="unreachable" label="角色未运行" />
            {p.backoff != null && <span className={styles.cap}>退避 {p.backoff} 秒后重试</span>}
            <Btn variant="secondary" onClick={p.onRestart}>重启角色</Btn>
          </div>
        )}
        {!overview && p.sw.phase !== 'idle' && <SwitchOverlay sw={p.sw} currentName={p.currentName} onRetry={p.onRetry} onDismiss={p.onDismiss} />}
      </div>
      {mode === 'detail' ? (
        <div className={styles.slot} data-g="info">
          {line && (
            <span className={styles.tag} role="status" data-tone={line.tone}>
              <Diamond tone={line.tone === 'warn' ? 'orange' : 'yellow'} size={6} />
              <span className={styles.tagT}>{line.text}</span>
            </span>
          )}
        </div>
      ) : (
        <div className={styles.details} data-g="info">
          {/* The state row takes the place of 在做 while she is not running or a switch is on. */}
          {p.name && <NameBlock name={p.name} en={p.en} active={p.active} voice={p.voice} activity={overview && p.sw.phase !== 'idle' ? null : p.activity} offline={p.offline} />}
          {overview && p.offline && <OfflineRow backoff={p.backoff} onRestart={p.onRestart} />}
          {overview && p.sw.phase !== 'idle' && <SwitchRow sw={p.sw} currentName={p.currentName} onRetry={p.onRetry} onDismiss={p.onDismiss} />}
          {!overview && previewNote}
        </div>
      )}
      {overview && <div className={styles.pv}>{previewNote}</div>}
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
