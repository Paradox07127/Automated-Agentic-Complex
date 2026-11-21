import { useContext, type HTMLAttributes, type ReactNode, type Ref } from 'react';
import { stateVisual, type VisualStateKey } from '../../domain';
import { IconBtn, Kbd, StatusTag } from '../../ui';
import { CompactCard } from './compact';
import type { Priority } from './model';
import styles from './HudCard.module.css';

/** 栈卡 `stk` 壳：左结构线挂键帽、左竖线按优先级配色、暗玻璃卡头（眉标 + 标题 + 关闭）、正文、按钮行、寿命线；紧凑版不画整条带和正文。look / alarm 换成提示外观。 */
export interface HudCardProps {
  /** 标题，一行；不给时不画头行（正文自带标题） */
  title?: string;
  /** 状态：形状和颜色从 stateVisual 取；失败、注意类的 P2 卡左竖线用橙色；没有眉标时画在标题前 */
  state?: VisualStateKey;
  /** 读屏名称，默认用标题 */
  label?: string;
  /** 头行右侧元信息，例如剩余时间 */
  meta?: ReactNode;
  /** 手动关闭 */
  onClose?: () => void;
  /** 栈顶卡：结构线上画 esc 键帽 */
  escKey?: boolean;
  /** 按钮行 */
  footer?: ReactNode;
  /** 寿命线 */
  life?: ReactNode;
  children?: ReactNode;
  /** 悬停计时用 */
  hoverRef?: Ref<HTMLElement>;
  hoverHandlers?: Pick<HTMLAttributes<HTMLElement>, 'onMouseEnter' | 'onMouseLeave'>;
  /** P0/P1 用 alertdialog，其余 status */
  urgent?: boolean;
  /** 英文眉标（装饰，读屏跳过），后面自动接「// 优先级编号」 */
  eyebrow?: string;
  /** 优先级：左竖线配色和眉标编号，默认 2 */
  priority?: Priority;
  /** 栈顶卡：结构线上画 ⏎ 键帽 */
  enterKey?: boolean;
  /** 栈顶卡：右侧画括线 */
  top?: boolean;
  /** 出错卡：卡头换成红底斜纹，标题居中 */
  alarm?: boolean;
  /** 卡头和正文之间的整条带（交付卡的产物条） */
  band?: ReactNode;
  /** 提示外观（两种主题都是深色 HUD）：mission 任务完成黄条 + 奖励暗带，toast PC 提示条，finish 完成提示（toast + 黄色点缀），tips 提示卡；alarm 另画失败提示 */
  look?: 'mission' | 'toast' | 'finish' | 'tips';
}

export function HudCard({ title, state, label, meta, onClose, escKey, footer, life, children, hoverRef, hoverHandlers, urgent, eyebrow, priority = 2, enterKey, top, alarm, band, look }: HudCardProps) {
  const body = useContext(CompactCard) ? null : children;
  const shownLook = alarm ? 'fail' : look;
  return (
    <section
      ref={hoverRef}
      className={styles.card}
      data-tone={state && stateVisual(state).tone}
      data-prio={priority}
      data-alarm={alarm || undefined}
      data-look={shownLook}
      data-theme={shownLook && 'dark'}
      role={urgent ? 'alertdialog' : 'status'}
      aria-label={label ?? title}
      tabIndex={0}
      {...hoverHandlers}
    >
      <span className={styles.sline} aria-hidden="true">
        {onClose && escKey && (
          <span className={styles.kEsc}>
            <Kbd hud>esc</Kbd>
          </span>
        )}
        {enterKey && (
          <span className={styles.kEnter}>
            <Kbd hud>⏎</Kbd>
          </span>
        )}
      </span>
      <span className={styles.pbar} aria-hidden="true" />
      {title != null && (
        <header className={styles.hd}>
          <span className={styles.art} data-art-slot="card-head" aria-hidden="true" />
          {alarm && (
            <span className={styles.tri} aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          )}
          {!alarm && eyebrow && (
            <span className={styles.eyebrow} lang="en" aria-hidden="true">
              {eyebrow} // 0{priority + 1}
            </span>
          )}
          {!alarm && !eyebrow && state && <StatusTag state={state} iconOnly />}
          <h3 className={styles.tt} title={title}>
            {title}
          </h3>
          {meta != null && <span className={styles.meta}>{meta}</span>}
          {onClose && (
            <span className={styles.x}>
              <IconBtn icon="close" size="sm" label="关闭" onClick={onClose} />
            </span>
          )}
        </header>
      )}
      {body != null && band}
      {(body != null || footer || life) && (
        <div className={styles.bd}>
          {body}
          {footer && <div className={styles.ft}>{footer}</div>}
          {life}
        </div>
      )}
      {top && <span className={styles.rbr} aria-hidden="true" />}
    </section>
  );
}
