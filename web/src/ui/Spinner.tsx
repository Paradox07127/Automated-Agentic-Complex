import styles from './Spinner.module.css';

/** 加载条：48×6 的分格灰条上两格黄块循环走过；减少动效时静止。 */
export interface SpinnerProps {
  /** 读屏文字，默认「正在读取」 */
  label?: string;
}

export function Spinner({ label = '正在读取' }: SpinnerProps) {
  return <span role="progressbar" aria-label={label} aria-busy="true" className={styles.spin} data-stub="Spinner" />;
}

export const SpinnerDemos: Array<{ name: string; props: SpinnerProps }> = [
  { name: 'default', props: {} },
  { name: 'labelled', props: { label: '正在检测内核' } },
];
