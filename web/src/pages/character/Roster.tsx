import type { Ref } from 'react';
import type { CharacterProfile } from '../../domain';
import { CharacterArt, Icon } from '../../ui';
import { HeadPick } from './charMotion';
import styles from './Roster.module.css';

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

export const pad2 = (n: number) => String(n).padStart(2, '0');

/** 全部角色：三列角色卡，头像、幽灵编号和底部名字条，当前角色底边黄条、名字变黄；点别的角色发起切换，最后一格斜纹「导入角色」。 */
export function Roster({ characters, current, pending, offline, importing = false, onPick, onImport, listRef }: RosterProps) {
  return (
    <nav ref={listRef} className={styles.roster} aria-label="角色名册" data-nav-target="roster" data-g="listSide">
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
            <span className={styles.no} aria-hidden="true">
              {pad2(i + 1)}
            </span>
            <span className={styles.art} aria-hidden="true">
              <CharacterArt src={c.head} kind="head" w={84} h={84} fallback={<Icon name="user" size={32} />} />
            </span>
            <span className={styles.name}>{c.name}</span>
          </button>
        );
      })}
      {onImport && (
        <button type="button" className={`${styles.rc} ${styles.add}`} data-g="root" onClick={onImport}>
          <Icon name="plus" size={24} />
          <span>导入角色</span>
        </button>
      )}
    </nav>
  );
}
