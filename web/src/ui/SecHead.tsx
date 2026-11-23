import type { KeyboardEvent, ReactNode } from 'react';
import { MicroLabel } from './game/Marks';
import { InfoTip } from './InfoTip';
import styles from './SecHead.module.css';

/** 分组标题：黄竖条、标题、[n] 计数，有语义时一个方形状态点，其后一条通栏细线，右端操作和微型英文。要折叠时用 Fold 的 head 变体。 */
export interface SecHeadProps {
  /** 标题 */
  title: string;
  /** 编号，例如 01（装饰，读屏跳过） */
  no?: string;
  /** 计数 */
  count?: number | string;
  /** 标题后紧跟的 ⓘ 说明（InfoTip 只收文字） */
  info?: string;
  /** 开发者项：标题旁一个 DEV 标 */
  dev?: boolean;
  /** 状态点的语义色，默认 none（不画点） */
  tone?: 'waiting' | 'running' | 'failed' | 'ok' | 'none';
  /** 右侧操作 */
  right?: ReactNode;
  /** 右端的微型英文（装饰，读屏跳过） */
  micro?: string;
  /** 诊断页分组头，默认 band；两者外观相同 */
  variant?: 'band' | 'diag';
  /** 标题右侧的通栏细线，默认 true；Fold 的 rule 传到这里 */
  rule?: boolean;
  /** Fold 的 head 变体填它：标题成了开合键 */
  fold?: SecHeadFold | undefined;
}

export interface SecHeadFold {
  open: boolean;
  bodyId: string;
  /** Fold 的旋转箭头 */
  chev: ReactNode;
  /** 收起时标题后的一行摘要 */
  summary?: ReactNode;
  onToggle: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
}

export function SecHead({ title, no, count, info, dev, tone = 'none', right, micro, variant = 'band', rule = true, fold }: SecHeadProps) {
  const lead = (
    <>
      <i className={styles.bar} aria-hidden="true" />
      {no && (
        <span className={styles.no} aria-hidden="true">
          {no}
        </span>
      )}
      {tone !== 'none' && <span className={styles.dot} data-dot={tone} />}
    </>
  );
  const counter = count != null && (
    <span className={styles.count}>
      <span aria-hidden="true">[</span>
      {count}
      <span aria-hidden="true">]</span>
    </span>
  );
  const tip = info != null && <InfoTip>{info}</InfoTip>;
  const devMark = dev && <span className={styles.dev}>DEV</span>;
  return (
    <div className={styles.head} data-stub="SecHead" data-tone={tone} data-variant={variant} data-fold={fold ? '' : undefined} data-rule={rule ? undefined : 'off'}>
      {fold ? (
        <h3 className={styles.title}>
          <button type="button" className={styles.toggle} aria-expanded={fold.open} aria-controls={fold.open ? fold.bodyId : undefined} onClick={fold.onToggle} onKeyDown={fold.onKeyDown}>
            {fold.chev}
            {lead}
            <span>{title}</span>
            {devMark}
            {counter}
            {fold.summary != null && <span className={styles.summary}>{fold.summary}</span>}
          </button>
          {/* A button cannot sit inside the toggle, so the ⓘ follows it. */}
          {tip}
        </h3>
      ) : (
        <>
          {lead}
          <h3 className={styles.title}>{title}</h3>
          {tip}
          {devMark}
          {counter}
        </>
      )}
      <span className={styles.right}>{right}</span>
      {micro && <MicroLabel>{micro}</MicroLabel>}
    </div>
  );
}

export const SecHeadDemos: Array<{ name: string; props: SecHeadProps }> = [
  { name: 'numbered', props: { no: '01', title: '今日简报', right: '09:00–15:30', micro: 'Daily Brief' } },
  { name: 'waiting', props: { title: '待处理', count: 3, tone: 'waiting' } },
  { name: 'running', props: { title: '进行中', count: 2, tone: 'running', micro: 'Running' } },
  { name: 'failed', props: { title: '出错', count: 1, tone: 'failed' } },
  { name: 'info-dev', props: { title: '画质', info: '三项开发者画质参数，点了即时保存。', dev: true, micro: 'Render' } },
  { name: 'plain', props: { title: '其他', right: '按时间排序' } },
  { name: 'diag', props: { variant: 'diag', title: '进程', tone: 'ok', right: '4 个 │ 0 个不正常' } },
  { name: 'diag-failed', props: { variant: 'diag', title: '进程', tone: 'failed', right: '4 个 │ 1 个不正常' } },
];
