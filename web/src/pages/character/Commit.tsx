import { Fragment, useRef, type ReactNode } from 'react';
import { StatusTag } from '../../ui';
import { ActionBar, Barcode, Diamond, GameSeg, MicroLabel, WhiteCapsule, YellowKey } from '../../ui/game';
import { useCompactScene } from './compact';
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

export interface CommitProps {
  offline: boolean;
  /** The unsaved switches in table order: the name and the value it goes to. */
  changes: Array<{ label: string; on: boolean }>;
  saving: boolean;
  onUndo: () => void;
  onSave: () => void;
  speed: string;
  onSpeed: (s: string) => void;
  /** The motion has BGM: 1× only, the speed control is off. */
  oneSpeed: boolean;
  /** Why the preview cannot run; null when it can. */
  blocked: string | null;
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
  /** 0–1 of the desktop play, the yellow line on the bar's top edge; null draws none. */
  progress: number | null;
  /** The desktop play's player; while it is there it stands where 速度 and 播放方式 were. */
  transport?: ReactNode;
}

const SPEEDS = ['0.5', '1', '2'].map((s) => ({ value: s, label: `${s}×` }));
const NO_LOOP = '这个版本的角色还不支持循环';

/** 动作页底部动作条：左边桌面预览（黄键，循环时白色停止）、速度和播放方式，桌面播放时换成播放器；右边改了哪些、撤销、保存。 */
export function Commit(p: CommitProps) {
  const ref = useRef<HTMLDivElement>(null);
  const size = useCompactScene(ref) ? 'compact' : 'normal';
  const n = p.changes.length;
  const off = p.blocked != null;
  const right = p.offline ? (
    <span className={styles.ro} data-theme="dark">
      <SaveNote offline n={n} sparse={false} />
    </span>
  ) : n > 0 ? (
    <>
      <span className={styles.st}>
        <span className={styles.h}>
          <Diamond tone="yellow" size={7} />
          <span>
            已修改 <b className={styles.n}>{n}</b> 项
          </span>
          <MicroLabel>Unsaved</MicroLabel>
        </span>
        <span className={styles.l}>
          {p.changes.map((c, i) => (
            <Fragment key={c.label + i}>
              {i > 0 && ' │ '}
              <b>{c.label}</b> {c.on ? '关→开' : '开→关'}
            </Fragment>
          ))}
        </span>
      </span>
      <WhiteCapsule label="撤销" icon="refresh" onClick={p.onUndo} />
      <YellowKey label="保存" icon="check" micro="Commit" busy={p.saving} onClick={p.onSave} />
    </>
  ) : undefined;
  return (
    <div ref={ref} className={styles.deck} data-commit="" data-switch="band">
      <ActionBar
        label="桌面预览"
        {...(p.progress != null ? { progress: p.progress } : {})}
        looping={p.looping}
        left={
          <span className={styles.left}>
            <span className={styles.ttl} aria-hidden="true">
              <b>PLAY</b>
              <MicroLabel>Desktop / Ctrl</MicroLabel>
              <Barcode width={54} height={6} />
            </span>
            {p.looping ? (
              <YellowKey label="停止" icon="stop" micro="Desktop" tone="white" onClick={p.onStop} />
            ) : (
              <YellowKey label={p.hidden ? '显示角色并预览' : '桌面预览'} micro="Desktop" disabled={off} {...(p.blocked ? { disabledReason: p.blocked } : {})} onClick={p.onPlay} />
            )}
            {p.transport || (
              <>
                <GameSeg variant="setting" label="播放速度" caption="速度" micro="Speed" size={size} value={p.speed} onChange={p.onSpeed} disabled={off || p.oneSpeed} options={SPEEDS} />
                <GameSeg
                  variant="setting"
                  label="播放方式"
                  caption="播放方式"
                  micro="Mode"
                  size={size}
                  value={p.loop ? 'loop' : 'once'}
                  onChange={(v) => p.onLoop(v === 'loop')}
                  options={[
                    { value: 'once', label: '一次' },
                    { value: 'loop', label: '循环', disabled: !p.canLoop, ...(p.canLoop ? {} : { title: NO_LOOP }) },
                  ]}
                />
              </>
            )}
          </span>
        }
        {...(right ? { right: <span className={styles.right}>{right}</span> } : {})}
      />
    </div>
  );
}
