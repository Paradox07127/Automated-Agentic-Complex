import { Breath } from '../fx/Breath';
import { Icon, type IconName } from '../Icon';
import { placeAt, type Box } from './WatchKey';
import styles from './TopIcon.module.css';

/** 表盘左上的平放图标：图标在上、名字在下，底下一道灰条，可带红点；悬停发光。 */
export interface TopIconProps {
  /** 在舞台上的位置和大小 */
  box: Box;
  icon: IconName;
  label: string;
  /** 红点：live 呼吸（窗口有焦点时），still 不动 */
  dot?: 'live' | 'still' | undefined;
  /** 手表进场动画驱动的 data-g */
  g?: string;
  /** 图标下写名字 */
  named?: boolean;
  onClick: () => void;
}

export function TopIcon({ box, icon, label, dot, g, named, onClick }: TopIconProps) {
  return (
    <span className={styles.slot} {...placeAt(box)} data-g={g} data-stub="TopIcon">
      <button type="button" className={styles.top} aria-label={label} title={label} onClick={onClick}>
        <span className={styles.topIcon} aria-hidden="true">
          <Icon name={icon} size={20} />
        </span>
        {named && (
          <span className={styles.topName} aria-hidden="true">
            {label}
          </span>
        )}
        {dot && <span className={styles.dot}>{dot === 'live' ? <Breath size={6} /> : <span className={styles.still} />}</span>}
        <span className={styles.bar} aria-hidden="true" />
      </button>
    </span>
  );
}

const BOX: Box = { width: 52, height: 48 };
const noop = () => undefined;

export const TopIconDemos: Array<{ name: string; props: TopIconProps }> = [
  { name: 'named', props: { box: BOX, icon: 'tune', label: '设置', named: true, onClick: noop } },
  { name: 'dot', props: { box: BOX, icon: 'warn', label: '待处理 3', named: true, dot: 'still', onClick: noop } },
  { name: 'icon-only', props: { box: BOX, icon: 'bell', label: '提醒', onClick: noop } },
];
