import type { CharacterEntry, MmdEntry } from '../../bridge';
import { Btn } from '../../ui';
import { GameSeg, MicroLabel, StatusLamp, WhiteCapsule } from '../../ui/game';
import { motionImportReason } from '../character/labels';
import { stateOf } from './Library';
import styles from './Detail.module.css';

export interface DetailProps {
  entry: MmdEntry;
  /** She can play it: baked for her. */
  baked: boolean;
  /** Every character but her. */
  others: CharacterEntry[];
  /** The desktop avatar loops too; otherwise 一次 │ 循环 is the stage's alone. */
  canLoop: boolean;
  loop: boolean;
  onLoop: (loop: boolean) => void;
  /** The desktop loops this dance now: 停止 stands where 桌面播放 was. */
  looping: boolean;
  playOff: string | null;
  editOff: string | null;
  onPlay: () => void;
  onStop: () => void;
  onRename: () => void;
  onRemove: () => void;
}

const LOOP = [
  { value: 'once', label: '一次' },
  { value: 'loop', label: '循环' },
];

/** Hidden in the 925 × 515 layout, where only the icon stays; the name stays for screen readers and in the title. */
function Txt({ children }: { children: string }) {
  return <span className={styles.txt}>{children}</span>;
}

/** 选中行展开：桌面播放、舞台一次 / 循环、改名、删除，下面一行是这支舞在其他角色上的状态。 */
export function Detail(p: DetailProps) {
  const e = p.entry;
  return (
    <div className={styles.ex} role="group" aria-label="MMD 操作" data-mmd-detail={e.id}>
      <div className={styles.ops}>
        {p.baked && (
          <span className={styles.desk} title={p.playOff ?? (p.looping ? '停止' : '桌面播放')}>
            {p.looping ? (
              <WhiteCapsule label="停止" icon="stop" disabled={p.playOff != null} disabledReason={p.playOff ?? ''} onClick={p.onStop} />
            ) : (
              <WhiteCapsule label="桌面播放" icon="play" disabled={p.playOff != null} disabledReason={p.playOff ?? ''} onClick={p.onPlay} />
            )}
          </span>
        )}
        {p.baked && (
          <span className={styles.segw}>
            <span className={styles.lb} aria-hidden="true">
              {p.canLoop ? '播放' : '舞台'}
            </span>
            <GameSeg label={p.canLoop ? '播放方式' : '舞台播放方式'} value={p.loop ? 'loop' : 'once'} options={LOOP} onChange={(v) => p.onLoop(v === 'loop')} />
          </span>
        )}
        <span className={styles.sp} />
        <Btn variant="secondary" icon="g-rename" label="改名" disabled={p.editOff != null} disabledReason={p.editOff ?? ''} onClick={p.onRename}>
          <Txt>改名</Txt>
        </Btn>
        <Btn variant="secondary" icon="del" label="删除" disabled={p.editOff != null} disabledReason={p.editOff ?? ''} onClick={p.onRemove}>
          <Txt>删除</Txt>
        </Btn>
      </div>
      {p.others.length > 0 && (
        <div className={styles.others}>
          <MicroLabel>OTHERS</MicroLabel>
          <ul aria-label="其他角色">
            {p.others.map((c) => {
              const s = stateOf(e, c.id);
              const why = s.state === 'failed' ? motionImportReason(s.reason ?? '', undefined) : null;
              return (
                <li key={c.id} className={styles.ch} data-state={s.state} title={why ?? undefined}>
                  <span className={styles.av} aria-hidden="true">
                    {c.head && <img src={c.head} alt="" onError={(ev) => void (ev.currentTarget.hidden = true)} />}
                  </span>
                  <span className={styles.chn}>{c.name}</span>
                  {s.state === 'pending' && <StatusLamp onDark state="pending" label="待同步" />}
                  {why && <StatusLamp onDark state="failed" label={why} />}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
