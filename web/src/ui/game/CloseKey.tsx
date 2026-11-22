import { Icon } from '../Icon';
import { placeAt, type Box } from './WatchKey';
import styles from './CloseKey.module.css';

/** 圆形关闭键：深底白圈里一枚白圆、深色 ✕，往右下落一道硬影；按下沉到影子上。 */
export interface CloseKeyProps {
  /** 在舞台上的位置和大小 */
  box: Box;
  /** 读屏名称和悬停提示，默认「关闭窗口」 */
  label?: string;
  /** 默认关掉当前窗口 */
  onClick?: () => void;
}

export function CloseKey({ box, label = '关闭窗口', onClick = () => window.close() }: CloseKeyProps) {
  return (
    <span className={styles.closeNode} {...placeAt(box)} data-stub="CloseKey">
      <button type="button" className={styles.close} aria-label={label} title={label} onClick={onClick}>
        <Icon name="close" size={14} />
      </button>
    </span>
  );
}

export const CloseKeyDemos: Array<{ name: string; props: CloseKeyProps }> = [
  { name: 'default', props: { box: { width: 32, height: 32 }, onClick: () => undefined } },
  { name: 'small', props: { box: { width: 26, height: 26 }, label: '关闭', onClick: () => undefined } },
];
