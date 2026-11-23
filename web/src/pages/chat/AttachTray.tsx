import { Icon, IconBtn, type IconName } from '../../ui';
import styles from './Composer.module.css';

/** One chip above the input: a file goes with a thumbnail slot; a flag (看一眼屏幕, 这句不记) is framed instead. */
export interface TrayItem {
  key: string;
  name: string;
  icon: IconName;
  flag?: boolean;
  removeLabel: string;
  onRemove: () => void;
}

/** The composer's tray: what goes out with the next line, each with its own ×. */
export function AttachTray({ items }: { items: TrayItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className={styles.tray}>
      {items.map((it) => (
        <div key={it.key} className={styles.att} data-flag={it.flag || undefined}>
          {it.flag ? (
            <Icon name={it.icon} size={16} />
          ) : (
            <span className={styles.th} aria-hidden="true">
              <Icon name={it.icon} size={20} />
            </span>
          )}
          <b title={it.name}>{it.name}</b>
          <IconBtn icon="close" size="sm" label={it.removeLabel} onClick={it.onRemove} />
        </div>
      ))}
    </div>
  );
}
