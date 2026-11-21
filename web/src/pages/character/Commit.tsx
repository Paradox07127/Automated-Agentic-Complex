import { BottomBarSlot } from '../../shell/headerSlot';
import { Btn, Seg, StatusTag } from '../../ui';
import styles from './Commit.module.css';

export interface SaveNoteProps {
  offline: boolean;
  /** Unsaved switches. */
  n: number;
  sparse: boolean;
}

/** Where the switch drafts stand: read-only, n changed, or none. */
export function SaveNote({ offline, n, sparse }: SaveNoteProps) {
  if (offline)
    return (
      <>
        <StatusTag state="unreachable" label="角色未运行" />
        <span className={styles.cap}>只读</span>
      </>
    );
  if (n > 0)
    return (
      <>
        <span>
          已修改 <span className={styles.num}>{n}</span> 项
        </span>
      </>
    );
  return sparse ? <span className={styles.cap}>今日播放较少</span> : null;
}

export interface CommitProps extends SaveNoteProps {
  saving: boolean;
  onUndo: () => void;
  onSave: () => void;
  speed: string;
  onSpeed: (s: string) => void;
  /** The motion has BGM: 1× only, the speed control is off. */
  oneSpeed: boolean;
  /** Why the preview cannot run; null when it can. */
  blocked: string | null;
  playing: boolean;
  hidden?: boolean;
  onPlay: () => void;
  /** 播放方式: true loops the desktop preview and the stage's live preview. */
  loop: boolean;
  onLoop: (loop: boolean) => void;
  /** `capabilities.actionLoop`. */
  canLoop: boolean;
  /** The desktop loops a motion now: 停止 takes the place of 桌面预览. */
  looping: boolean;
  onStop: () => void;
}

const SPEEDS = ['0.5', '1', '2'];

/** 底部操作条：改动状态 │ 为什么、桌面预览、速度和播放方式 │ 撤销、保存。 */
export function Commit(p: CommitProps) {
  const why = p.blocked ?? (p.playing ? '桌面正在播放此动作' : p.oneSpeed ? '带背景音乐 │ 只能 1× 播放' : null);
  return (
    <BottomBarSlot>
      <div className={styles.bar} data-commit="">
        <span className={styles.note}>
          <SaveNote offline={p.offline} n={p.n} sparse={p.sparse} />
        </span>
        <span className={styles.why}>{why}</span>
        {p.looping ? (
          <Btn variant="secondary" tail="stop" onClick={p.onStop}>
            停止
          </Btn>
        ) : (
          <Btn variant="secondary" tail="play" disabled={p.blocked != null} disabledReason={p.blocked ?? undefined} onClick={p.onPlay}>
            {p.hidden ? '显示角色并预览' : '桌面预览'}
          </Btn>
        )}
        <Seg size="sm" label="播放速度" value={p.speed} onChange={p.onSpeed} options={SPEEDS.map((s) => ({ value: s, label: `${s}×`, disabled: p.blocked != null || p.oneSpeed }))} />
        <Seg
          size="sm"
          label="播放方式"
          value={p.loop ? 'loop' : 'once'}
          onChange={(v) => p.onLoop(v === 'loop')}
          options={[
            { value: 'once', label: '播放一次' },
            { value: 'loop', label: '循环', disabled: !p.canLoop, disabledReason: p.canLoop ? undefined : '这个版本的角色还不支持循环' },
          ]}
        />
        {!p.offline && p.n > 0 && (
          <>
            <i className={styles.sep} aria-hidden="true" />
            <Btn variant="quiet" onClick={p.onUndo}>
              撤销
            </Btn>
            <Btn variant="primary" loading={p.saving} onClick={p.onSave}>
              保存
            </Btn>
          </>
        )}
      </div>
    </BottomBarSlot>
  );
}
