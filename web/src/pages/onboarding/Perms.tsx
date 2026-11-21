import type { OnboardingPermissionKind } from '../../bridge';
import { Btn, Icon } from '../../ui';
import { GuideRing, Pip } from './Bits';
import { PERM_ICON, PERM_STATE, type Perm } from './copy';
import styles from './Steps.module.css';

/** One permission: icon, title and purpose, state, and 前往系统设置 when only System Settings can grant it; `ring` marks it as the one to grant. */
export function PermRow({ p, ring, onOpen }: { p: Perm; ring?: boolean; onOpen: () => void }) {
  const [kind, label] = PERM_STATE[p.state];
  return (
    <div className={styles.perm} role="listitem" data-kind={p.kind} data-state={p.state}>
      <span className={styles.permIc} aria-hidden="true">
        <Icon name={PERM_ICON[p.kind]} size={20} />
      </span>
      <div className={styles.permText}>
        <div className={styles.permTitle}>{p.title}</div>
        <div className={styles.cap}>{p.purpose}</div>
      </div>
      <Pip kind={kind} label={label} />
      <span className={styles.permAct}>
        {p.needsSystemSettings && (
          <Btn size="sm" variant={p.state === 'denied' ? 'secondary' : 'ghost'} tail="ext" onClick={onOpen}>
            前往系统设置
          </Btn>
        )}
      </span>
      {ring && <GuideRing />}
    </div>
  );
}

const LEGEND = [
  ['ok', '已允许'],
  ['attention', '未决定 │ 可立即授权'],
  ['offline', '使用时询问 │ 由系统弹窗'],
] as const;

export function PermsStep({ perms, onOpen }: { perms: Perm[]; onOpen: (p: Perm) => void }) {
  const next = perms.find((p) => p.needsSystemSettings && p.state !== 'granted');
  return (
    <div className={styles.perms}>
      <div role="list" aria-label="系统权限" className={styles.permList}>
        {perms.map((p) => (
          <PermRow key={p.kind} p={p} ring={p === next} onOpen={() => onOpen(p)} />
        ))}
      </div>
      <div className={styles.legend}>
        {LEGEND.map(([k, l]) => (
          <Pip key={k} kind={k} label={l} />
        ))}
      </div>
    </div>
  );
}

/** The permission list's greyed outline while the guide cannot be read: one row per kind, no state. */
export function PermsOutline() {
  return (
    <div className={styles.permList} data-outline="" aria-hidden="true">
      {(Object.keys(PERM_ICON) as OnboardingPermissionKind[]).map((k) => (
        <div key={k} className={styles.perm} data-kind={k}>
          <span className={styles.permIc}>
            <Icon name={PERM_ICON[k]} size={20} />
          </span>
          <span className={styles.outlineBar} />
        </div>
      ))}
    </div>
  );
}
