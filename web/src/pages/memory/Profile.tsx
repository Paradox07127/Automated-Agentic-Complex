import { useRef, useState, type ReactNode } from 'react';
import { gameClips } from '../../design/gameClips.generated';
import type { Fact } from '../../domain';
import { Icon, KV, type IconName } from '../../ui';
import { SrcTag } from './bits';
import type { Profile as ProfileData } from './model';
import { Run, useEntrance, useExit, type LeaveSlot } from './motion';
import m from './Memory.module.css';
import styles from './Profile.module.css';

export interface ProfileProps {
  profile: ProfileData;
  /** Open a fact in the detail sheet (出处, 修改). */
  onOpen: (id: string) => void;
  onChat: () => void;
  /** The fact open in the detail sheet; its group cell and row show as selected. */
  selected?: string | null;
  /** Takes the wiki's out clip while it is shown. */
  leave?: LeaveSlot;
}

/** 用户档案：左边分组格（基本资料、偏好与约定），右边键值行，每行后面是来源字段；称呼和最常引用的偏好、约定可点，开右侧抽屉看出处、修改。 */
export function Profile({ profile, onOpen, onChat, selected, leave }: ProfileProps) {
  const root = useRef<HTMLElement>(null);
  const entrance = useEntrance(root, gameClips.wikiGroupIn, gameClips.wikiCellIn, true);
  useExit(root, gameClips.wikiGroupOut, leave);
  const { name, fields, cells } = profile;
  if (!name && cells.length === 0) {
    return (
      <section className={styles.line} aria-label="用户档案">
        <span className={styles.lab}>用户档案</span>
        <span className={styles.none}>还没有称呼和基本信息，对话中提到的称呼、时区会整理到这里</span>
        <button type="button" className={m.lnk} onClick={onChat}>
          去对话
        </button>
      </section>
    );
  }
  const open = (key: string, f: Fact) => (
    <div key={f.id} className={styles.block} data-selected={selected === f.id || undefined}>
      <KV
        items={[
          {
            key,
            value: (
              <button type="button" className={styles.v} aria-label={`${key}：${f.text}，查看出处`} onClick={() => onOpen(f.id)}>
                <span title={f.text}>{f.text}</span>
              </button>
            ),
          },
        ]}
      />
      <SrcTag src={f.source} full />
    </div>
  );
  const groups: Array<{ id: string; label: string; icon: IconName; ids: string[]; rows: ReactNode[] }> = [
    {
      id: 'base',
      label: '基本资料',
      icon: 'user',
      ids: [...(name ? [name.id] : []), ...fields.map((x) => x.fact.id)],
      rows: [
        name ? (
          open('称呼', name)
        ) : (
          <div key="name" className={styles.block}>
            <KV items={[{ key: '称呼', value: '未设置' }]} />
          </div>
        ),
        ...fields.map((x) => (
          <div key={x.key} className={styles.block}>
            <KV items={[{ key: x.key, value: <span className="num">{x.value}</span> }]} />
            <SrcTag src={x.fact.source} full />
          </div>
        )),
      ],
    },
    { id: 'habit', label: '偏好与约定', icon: 'tune', ids: cells.map((c) => c.fact.id), rows: cells.map(({ label, fact: f }) => open(label, f)) },
  ];
  return (
    <section ref={root} className={styles.wiki} aria-label="用户档案">
      {entrance}
      <span className={styles.groupsLine} data-g="groupsLine" aria-hidden="true" />
      {groups
        .filter((g) => g.rows.length > 0)
        .map((g) => (
          <div key={g.id} className={styles.grp}>
            <div data-g="groups">
              <Cell icon={g.icon} label={g.label} on={selected != null && g.ids.includes(selected)} />
            </div>
            <div className={styles.rows} data-g="grid">
              {g.rows}
            </div>
          </div>
        ))}
    </section>
  );
}

/** A group cell (TabCell); selecting it plays wiki_group_leftcellselect, deselecting its _out clip. */
function Cell({ icon, label, on }: { icon: IconName; label: string; on: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(on);
  const [turn, setTurn] = useState(0);
  const [ended, setEnded] = useState(0);
  if (seen !== on) {
    setSeen(on);
    setTurn(turn + 1);
  }
  return (
    <div ref={ref} className={`${styles.cell} ${styles.cellSelected}`} data-selected={on || undefined} data-g="cell">
      {turn > ended && <Run key={turn} root={ref} clip={on ? gameClips.wikiCellSelect : gameClips.wikiCellDeselect} onEnd={() => setEnded(turn)} />}
      <span className={styles.deco} aria-hidden="true">
        <span className={styles.normalPlate} data-g="normalPlate" />
        <span className={styles.tick} data-g="cellTick" />
        <span className={styles.selPlate} data-g="selPlate" />
        <span className={styles.selFill} data-g="selFill" />
        <span className={styles.selBar} data-g="selBar" />
        <span className={styles.selTick} data-g="selTick" />
      </span>
      <span className={styles.cellIc} data-g={on ? 'selIcon' : undefined}>
        <Icon name={icon} size={24} />
      </span>
      <span className={styles.cellT} data-g={on ? 'selTitle' : undefined}>
        {label}
      </span>
    </div>
  );
}
