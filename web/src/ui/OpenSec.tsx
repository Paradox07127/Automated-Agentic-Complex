import type { ReactNode } from 'react';
import { SecHead } from './SecHead';
import styles from './OpenSec.module.css';

/** 开放区（面板第 1 级）：只有编号节头、细分隔线和留白，不画边框；页面大部分内容属于这一级。 */
export interface OpenSecProps {
  /** 节标题 */
  title: string;
  /** 编号，例如 01 */
  no?: string;
  /** 计数 */
  count?: number;
  /** 节头右侧 */
  right?: ReactNode;
  /** 内容 */
  children?: ReactNode;
}

export function OpenSec({ title, no, count, right, children }: OpenSecProps) {
  return (
    <section className={styles.sec} data-stub="OpenSec" aria-label={title}>
      <SecHead title={title} no={no} count={count} right={right} />
      <div className={styles.body}>{children}</div>
    </section>
  );
}

export const OpenSecDemos: Array<{ name: string; props: OpenSecProps }> = [
  { name: 'default', props: { no: '02', title: '进行中', count: 2, children: '整理本周提交周报 │ 修 HostLink 断线' } },
  { name: 'plain', props: { title: '今日简报', children: '上午集中在 Xcode，午后排查 HostLink 断线。' } },
];
