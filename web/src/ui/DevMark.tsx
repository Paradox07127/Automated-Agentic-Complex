import styles from './DevMark.module.css';

/** 开发者标：蓝框蓝字的「DEV」，跟在开发者项的标题后面；读屏读「开发者」。 */
export type DevMarkProps = Record<string, never>;

export function DevMark() {
  return (
    <span className={styles.dev} data-stub="DevMark" role="img" aria-label="开发者">
      DEV
    </span>
  );
}

export const DevMarkDemos: Array<{ name: string; props: DevMarkProps }> = [{ name: 'default', props: {} }];
