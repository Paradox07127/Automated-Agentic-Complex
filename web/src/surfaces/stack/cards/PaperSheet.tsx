import { useContext, type HTMLAttributes, type ReactNode, type Ref } from 'react';
import { InSession } from '../../../features/approval';
import { Kbd } from '../../../ui';
import styles from './PaperSheet.module.css';

/** 白纸卡左侧的结构线：栈顶卡在这里挂 esc / ⏎ 键帽。 */
export function PaperLine({ esc, enter }: { esc?: boolean; enter?: boolean }) {
  return (
    <span className={styles.sline} aria-hidden="true">
      {esc && (
        <span className={styles.kEsc}>
          <Kbd hud>esc</Kbd>
        </span>
      )}
      {enter && (
        <span className={styles.kEnter}>
          <Kbd hud>⏎</Kbd>
        </span>
      )}
    </span>
  );
}

/** 提问、复核的白纸卡：两种主题下都是白纸；左上三色胶带（94x1.5）+ 英文眉标（装饰）。 */
export interface PaperSheetProps {
  /** 眉标英文词，后面自动接「// 编号」 */
  code: string;
  /** 0 红竖线、1 橙竖线 */
  priority: 0 | 1;
  /** 读屏名称 */
  label: string;
  children: ReactNode;
  /** 悬停计时用 */
  hoverRef?: Ref<HTMLElement>;
  hoverHandlers?: Pick<HTMLAttributes<HTMLElement>, 'onMouseEnter' | 'onMouseLeave'>;
}

export function PaperSheet({ code, priority, label, children, hoverRef, hoverHandlers }: PaperSheetProps) {
  const inSession = useContext(InSession);
  return (
    <section ref={hoverRef} data-theme="light" className={styles.paper} data-prio={priority} role="alertdialog" aria-label={label} tabIndex={0} {...hoverHandlers}>
      <header className={styles.head}>
        <span className={styles.left} aria-hidden="true">
          <span className={styles.art} data-art-slot="paper-tape" aria-hidden="true" />
          <span className={styles.tape}>
            <i />
            <i />
            <i />
          </span>
          {!inSession && (
            <span className={styles.code} lang="en">
              {code} // 0{priority + 1}
            </span>
          )}
        </span>
      </header>
      {children}
    </section>
  );
}
