import type { Ref } from 'react';
import type { CharacterProfile } from '../../domain';
import { CharacterArt, Frosted, Icon } from '../../ui';
import { HeadPick } from './charMotion';
import styles from './Operator.module.css';

export interface RosterProps {
  characters: CharacterProfile[];
  current: string;
  /** Target of a switch in progress. */
  pending: string | null;
  /** Avatar not running: only the current one stays enabled. */
  offline: boolean;
  /** A motion, appearance or MMD import is running: no switch until it ends. */
  importing?: boolean;
  onPick: (c: CharacterProfile) => void;
  /** Absent when the shell cannot import packages. */
  onImport?: () => void;
  /** The nav, for charlistnode_in. */
  listRef?: Ref<HTMLElement>;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 角色切换：一行角色卡，头像、幽灵编号和名字，当前角色底边黄条；点别的角色发起切换，最后一格导入。 */
export function Roster({ characters, current, pending, offline, importing = false, onPick, onImport, listRef }: RosterProps) {
  return (
    <nav ref={listRef} className={styles.roster} aria-label="角色名册" data-nav-target="roster" data-g="listSide">
      <span className={styles.rosterBg} aria-hidden="true">
        <Frosted blur={16} tint={0.5} />
      </span>
      {characters.map((c, i) => {
        const on = c.id === current;
        return (
          <button
            key={c.id}
            type="button"
            className={styles.rc}
            data-g="root"
            aria-current={on ? 'true' : undefined}
            data-target={pending === c.id || undefined}
            disabled={pending != null || ((offline || importing) && !on)}
            title={pending != null ? '正在切换' : on ? `${c.name} │ 当前` : importing ? '导入中' : `切换到 ${c.name}`}
            onClick={() => onPick(c)}
          >
            {on && <HeadPick />}
            <span className={styles.rcNo} aria-hidden="true">
              {pad2(i + 1)}
            </span>
            <span className={styles.rcArt} aria-hidden="true">
              <CharacterArt src={c.head} kind="head" w={60} h={83} fallback={null} />
            </span>
            <span className={styles.rcName}>{c.name}</span>
          </button>
        );
      })}
      {onImport && (
        <button type="button" className={`${styles.rc} ${styles.add}`} data-g="root" onClick={onImport}>
          <Icon name="plus" size={14} />
          <span className={styles.rcName}>导入</span>
        </button>
      )}
    </nav>
  );
}
