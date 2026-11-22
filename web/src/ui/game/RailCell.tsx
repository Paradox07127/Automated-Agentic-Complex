import { useLayoutEffect, useRef } from 'react';
import { gameClips } from '../../design/gameClips.generated';
import { Icon, type IconName } from '../Icon';
import { playClip } from '../ToggleClip';
import styles from './RailCell.module.css';

/** 最右竖栏格（游戏 CharInfo 菜单格）：深灰半透明毛玻璃方格，顶部一条细斜纹带和微型标注，白图标和名字；当前格白底、左缘黄条。高度取 `--rail-cell`（默认 64 px）。 */
export interface RailCellProps {
  /** 名字 */
  label: string;
  icon: IconName;
  /** 顶带下右侧的微型英文（画在伪元素里，不进按钮的文字） */
  micro?: string;
  /** 当前分区：aria-current=page */
  current?: boolean;
  onClick?: () => void;
}

export function RailCell({ label, icon, micro, current = false, onClick }: RailCellProps) {
  const ref = useRef<HTMLButtonElement>(null);
  // charinfo_menucell_selectbtn_in when the cell becomes current: the white plate slides out, then icon and deco fade in.
  const was = useRef(current);
  useLayoutEffect(() => {
    if (was.current === current) return;
    was.current = current;
    if (current) playClip(gameClips.charMenuSelectIn, ref.current);
  }, [current]);

  return (
    <button ref={ref} type="button" className={styles.cell} data-stub="RailCell" aria-current={current ? 'page' : undefined} onClick={onClick}>
      <span className={styles.plate} data-g={current ? 'plate' : undefined} aria-hidden="true" />
      <span className={styles.light} aria-hidden="true" />
      <span className={styles.band} data-micro={micro} data-g={current ? 'deco' : undefined} aria-hidden="true" />
      <span className={styles.ic} data-g={current ? 'icon' : undefined}>
        <Icon name={icon} size={20} />
      </span>
      <span className={styles.label}>{label}</span>
    </button>
  );
}

export const RailCellDemos: Array<{ name: string; props: RailCellProps }> = [
  { name: 'normal', props: { label: '外观', icon: 'look', micro: 'Look' } },
  { name: 'current', props: { label: '动作', icon: 'play', micro: 'Mot', current: true } },
  { name: 'mmd', props: { label: 'MMD', icon: 'file', micro: 'Mmd' } },
];
