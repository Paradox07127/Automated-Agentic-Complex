import { useEffect, useRef, type ReactNode } from 'react';
import styles from './CmdCard.module.css';

/** 命令层卡片壳（`stk`，正文跟随系统深浅）：左侧 1px 结构线、交互菜单式深色卡头（任务头饰 + 英文眉标 + 标题 + 右侧按钮）、正文。esc 请原生关掉面板。 */
export interface CmdCardProps {
  slot: 'tune' | 'console';
  /** 英文眉标「词 // 后缀」（装饰，读屏跳过） */
  code: string;
  tag: string;
  /** 卡头标题；不给时只有眉标 */
  title?: string;
  /** 读屏名称 */
  label: string;
  /** 美术槽名 */
  art: 'tune-head' | 'console-head';
  onClose: () => void;
  /** 卡头右侧 */
  tools?: ReactNode;
  children: ReactNode;
}

export function CmdCard({ slot, code, tag, title, label, art, onClose, tools, children }: CmdCardProps) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => panel.current?.focus({ preventScroll: true }), []);

  return (
    <section
      ref={panel}
      className={styles.card}
      data-slot={slot}
      data-region=""
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        e.preventDefault();
        onClose();
      }}
    >
      <span className={styles.pbar} aria-hidden="true" />
      <header className={styles.hd} data-theme="dark">
        <span className={styles.art} data-art-slot={art} aria-hidden="true" />
        <span className={styles.deco} aria-hidden="true" />
        <span className={styles.eyebrow} lang="en" aria-hidden="true">
          {code} // {tag}
        </span>
        {title && <h2 className={styles.tt}>{title}</h2>}
        <span className={styles.sp} />
        {tools}
      </header>
      <div className={styles.bd}>{children}</div>
    </section>
  );
}
