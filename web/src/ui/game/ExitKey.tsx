import styles from './ExitKey.module.css';

/** 退出键（游戏 quit_icon 在 quit_icon_bg 上）：24 高的小胶囊，电源标加字，带按钮阴影；悬停出 45° 细斜纹，按下沉到影子上。菜单栏弹窗底栏用。 */
export interface ExitKeyProps {
  /** 字和读屏名称，默认「退出」 */
  label?: string;
  onClick: () => void;
}

export function ExitKey({ label = '退出', onClick }: ExitKeyProps) {
  return (
    <button type="button" className={styles.key} data-stub="ExitKey" aria-label={label} onClick={onClick}>
      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M12 3v8M7.2 6.2a7.5 7.5 0 1 0 9.6 0" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="square" />
      </svg>
      {label}
    </button>
  );
}

const noop = () => undefined;

export const ExitKeyDemos: Array<{ name: string; props: ExitKeyProps }> = [
  { name: 'default', props: { onClick: noop } },
  { name: 'named', props: { label: '退出 Agentic Complex', onClick: noop } },
];
