import { Icon, type IconName } from '../../ui';
import styles from './Rail.module.css';

export type RailItem = 'overview' | 'look' | 'motion' | 'set' | 'photo' | 'mmd';

const ITEMS: ReadonlyArray<{ id: RailItem; label: string; icon: IconName }> = [
  { id: 'overview', label: '总览', icon: 'grid' },
  { id: 'look', label: '外观', icon: 'look' },
  { id: 'motion', label: '动作', icon: 'play' },
  { id: 'set', label: '设定', icon: 'tune' },
  { id: 'photo', label: '拍照', icon: 'eye' },
  { id: 'mmd', label: 'MMD', icon: 'file' },
];

export interface RailProps {
  value: RailItem;
  /** Without an avatar there is no 拍照 or MMD. */
  avatar: boolean;
  onGo: (item: RailItem) => void;
}

/** 最右的竖栏：总览、外观、动作、设定、拍照，隔开一点是 MMD；当前项黄底。 */
export function Rail({ value, avatar, onGo }: RailProps) {
  const items = ITEMS.filter((x) => avatar || (x.id !== 'photo' && x.id !== 'mmd'));
  return (
    <nav className={styles.rail} data-g="menu" aria-label="角色分区">
      {items.map((x) => (
        <button
          key={x.id}
          type="button"
          className={styles.item}
          data-sep={x.id === 'mmd' || undefined}
          aria-current={x.id === value ? 'page' : undefined}
          onClick={() => x.id !== value && onGo(x.id)}
        >
          <Icon name={x.icon} size={20} />
          <span className={styles.label}>{x.label}</span>
        </button>
      ))}
    </nav>
  );
}
