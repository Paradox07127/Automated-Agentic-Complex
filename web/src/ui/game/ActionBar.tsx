import type { CSSProperties, ReactNode } from 'react';
import { GameSeg } from './GameSeg';
import { Barcode, MicroLabel } from './Marks';
import { WhiteCapsule } from './WhiteCapsule';
import { YellowKey } from './YellowKey';
import styles from './ActionBar.module.css';

/** 底部动作条外框：深色毛玻璃条，顶边白细线上一条黄色进度线（白菱形头），左槽、斜双线分隔、右槽，两端细线和微型标注、右端条码。 */
export interface ActionBarProps {
  /** 读屏名称 */
  label: string;
  /** 左槽（主键、分段开关） */
  left: ReactNode;
  /** 右槽（改动说明、白胶囊、保存键） */
  right?: ReactNode;
  /** 0–1：顶边黄线的长度（播放进度）；不给不画 */
  progress?: number;
  /** 左端的微型英文 */
  micro?: string;
}

export function ActionBar({ label, left, right, progress, micro }: ActionBarProps) {
  const p = progress == null ? null : Math.min(1, Math.max(0, progress));
  return (
    <div role="group" aria-label={label} className={styles.bar} data-stub="ActionBar">
      {p != null && <i className={styles.prog} style={{ '--p': p } as CSSProperties} aria-hidden="true" />}
      <span className={styles.edge} aria-hidden="true">
        <i className={styles.tick} />
        {micro && <MicroLabel>{micro}</MicroLabel>}
      </span>
      <div className={styles.slot}>{left}</div>
      {right != null && (
        <>
          <i className={styles.split} aria-hidden="true" />
          <div className={styles.slot} data-side="right">
            {right}
          </div>
        </>
      )}
      <span className={styles.end} aria-hidden="true">
        <Barcode width={30} height={18} />
      </span>
    </div>
  );
}

const SPEED = [
  { value: '0.5', label: '0.5×' },
  { value: '1', label: '1×' },
  { value: '2', label: '2×' },
];

export const ActionBarDemos: Array<{ name: string; props: ActionBarProps }> = [
  {
    name: 'play',
    props: {
      label: '播放',
      micro: 'Play',
      progress: 0.42,
      left: (
        <>
          <YellowKey label="桌面预览" micro="Desktop" />
          <GameSeg label="速度" caption="速度" micro="Speed" value="1" options={SPEED} />
        </>
      ),
      right: (
        <>
          <WhiteCapsule label="撤销" icon="refresh" />
          <YellowKey label="保存" icon="check" micro="Commit" />
        </>
      ),
    },
  },
  { name: 'left-only', props: { label: '拍照', micro: 'Photo', left: <WhiteCapsule label="存一张" icon="eye" /> } },
];
