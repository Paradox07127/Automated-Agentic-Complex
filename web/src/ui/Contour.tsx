import styles from './Contour.module.css';

/** 等高线装饰：铺满最近的定位父元素，取当前文字色，不接收指针，读屏跳过；只作框架，不压在数据上。 */
export interface ContourProps {
  /** 不透明度，默认 0.06（引导、角色头图区的上限） */
  opacity?: number;
  /** 只铺右半边（按钮、选中块），默认 full */
  side?: 'full' | 'right';
}

export function Contour({ side = 'full' }: ContourProps) {
  return <span className={styles.contour} data-stub="Contour" data-side={side} aria-hidden="true" />;
}

export const ContourDemos: Array<{ name: string; props: ContourProps }> = [
  { name: 'full', props: { opacity: 0.12 } },
  { name: 'right', props: { opacity: 0.15, side: 'right' } },
];
