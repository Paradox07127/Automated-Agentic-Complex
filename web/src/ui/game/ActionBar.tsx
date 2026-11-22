import type { CSSProperties, ReactNode } from 'react';
import { GameSeg } from './GameSeg';
import { Barcode, MicroLabel } from './Marks';
import { WhiteCapsule } from './WhiteCapsule';
import { YellowKey } from './YellowKey';
import styles from './ActionBar.module.css';

/** 底部动作条外框：深色毛玻璃条，顶边白细线，左段顶边一条黄色进度线（白菱形头）或循环时流动的斜纹，左槽、斜双线分隔、右槽，两端细线和微型标注、右端条码。高 60，页面可用 `--ab-h` 改。 */
export interface ActionBarProps {
  /** 读屏名称 */
  label: string;
  /** 左槽（主键、分段开关） */
  left: ReactNode;
  /** 右槽（改动说明、白胶囊、保存键） */
  right?: ReactNode;
  /** 0–1：左段顶边黄线的长度（播放进度）；不给不画 */
  progress?: number;
  /** 循环播放中：左段顶边是一条流动的黄斜纹（代替进度） */
  looping?: boolean;
  /** 左端的微型英文 */
  micro?: string;
}

export function ActionBar({ label, left, right, progress, looping, micro }: ActionBarProps) {
  const p = progress == null ? null : Math.min(1, Math.max(0, progress));
  return (
    <div role="group" aria-label={label} className={styles.bar} data-stub="ActionBar">
      <span className={styles.edge} aria-hidden="true">
        <i className={styles.tick} />
        {micro && <MicroLabel>{micro}</MicroLabel>}
      </span>
      <div className={styles.slot} data-side="left">
        {looping ? (
          <i className={styles.prog} data-looping="" aria-hidden="true" />
        ) : (
          p != null && <i className={styles.prog} style={{ '--p': p } as CSSProperties} aria-hidden="true" />
        )}
        {left}
      </div>
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
  {
    name: 'looping',
    props: { label: '播放', micro: 'Play', looping: true, left: <YellowKey label="停止" icon="stop" micro="Desktop" tone="white" />, right: <WhiteCapsule label="撤销" icon="refresh" /> },
  },
  { name: 'left-only', props: { label: '拍照', micro: 'Photo', left: <WhiteCapsule label="存一张" icon="eye" /> } },
];
