import type { IconName } from '../../ui';
import { MicroLabel, RailCell } from '../../ui/game';
import { pad2 } from './Roster';
import styles from './Rail.module.css';

export type RailItem = 'overview' | 'look' | 'motion' | 'set' | 'photo' | 'mmd';

const ITEMS: ReadonlyArray<{ id: RailItem; label: string; icon: IconName; micro: string }> = [
  { id: 'overview', label: '总览', icon: 'grid', micro: 'Ovw' },
  { id: 'look', label: '外观', icon: 'look', micro: 'Look' },
  { id: 'motion', label: '动作', icon: 'play', micro: 'Mot' },
  { id: 'set', label: '设定', icon: 'tune', micro: 'Set' },
  { id: 'photo', label: '拍照', icon: 'eye', micro: 'Cam' },
  { id: 'mmd', label: 'MMD', icon: 'file', micro: 'Mmd' },
];

export interface RailProps {
  value: RailItem;
  /** Without an avatar there is no 拍照 or MMD. */
  avatar: boolean;
  /** The current item's 导入 page is open: its cell still goes back to the item's first page. */
  sub?: boolean;
  onGo: (item: RailItem) => void;
}

/** 最右的竖栏：顶上白板写当前项的序号，下面总览、外观、动作、设定、拍照，隔一条线是 MMD；当前项白底黄边。 */
export function Rail({ value, avatar, sub, onGo }: RailProps) {
  const items = ITEMS.filter((x) => avatar || (x.id !== 'photo' && x.id !== 'mmd'));
  return (
    <nav className={styles.rail} data-g="menu" aria-label="角色分区">
      <div className={styles.top} aria-hidden="true">
        <MicroLabel>Charinfo</MicroLabel>
        <b className={styles.no}>{pad2(items.findIndex((x) => x.id === value) + 1)}</b>
      </div>
      {items.map((x) => (
        <RailCell key={x.id} label={x.label} icon={x.icon} micro={x.micro} current={x.id === value} onClick={() => (x.id !== value || sub) && onGo(x.id)} />
      ))}
    </nav>
  );
}
