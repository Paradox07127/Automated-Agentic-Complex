import type { ReactNode } from 'react';
import { MicroLabel } from '../../ui/game';
import type { Plate as PlateData } from './model';
import styles from './Index.module.css';

/** Left column: a nameplate or a section label, then the category cells. */
export function LeftCol({ label, children }: { label: string; children: ReactNode }) {
  return (
    <nav className={styles.lcol} aria-label={label}>
      {children}
    </nav>
  );
}

/** The nameplate (operator name band): what she calls the user, the birthday and place; it is the 用户档案 category's cell. */
export function Plate({ plate, selected, onClick }: { plate: PlateData | null; selected: boolean; onClick: () => void }) {
  const none = plate != null && plate.name == null;
  const fields = plate ? [plate.birthday && `生日 ${plate.birthday}`, plate.place, `共 ${plate.about} 条`].filter(Boolean).join(' │ ') : '—';
  return (
    <button type="button" className={styles.plate} data-theme="dark" aria-pressed={selected} data-none={none || undefined} aria-label={plate?.name ? `用户档案：${plate.name}` : '用户档案'} onClick={onClick}>
      <i className={styles.bar} aria-hidden="true" />
      <span className={styles.halo} aria-hidden="true" />
      <MicroLabel>You / Profile</MicroLabel>
      <span className={styles.who}>
        <b>{plate == null ? '—' : (plate.name ?? '还不知道怎么称呼你')}</b>
        {plate?.name != null && <small>她们这样叫你</small>}
      </span>
      <span className={styles.pkv}>{none ? '对话里说一次，她会记下' : fields}</span>
    </button>
  );
}
