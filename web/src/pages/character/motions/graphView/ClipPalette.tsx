import { useState, type KeyboardEvent } from 'react';
import { SearchField, Select, Toggle } from '../../../../ui';
import { shortName, type GraphClip, type MotionGraph } from '../graph';
import styles from './ChainGraph.module.css';

export interface ClipPaletteProps {
  graph: MotionGraph;
  groupTitle: (id: string) => string;
  picked: string | null;
  onPick: (clip: string | null) => void;
}

const SIT = new Set(['sit', 'floor', 'lie']);
const posture = (s: string | undefined) => (s == null ? '' : SIT.has(s) ? 'sit' : 'stand');
const ALL = { value: '', label: '全部' };

/** Clips to drag onto the chain, or to pick and then put with a tap: search, then family, posture, loop, group and 新. */
export function ClipPalette({ graph, groupTitle, picked, onPick }: ClipPaletteProps) {
  const [q, setQ] = useState('');
  const [fam, setFam] = useState('');
  const [stance, setStance] = useState('');
  const [loop, setLoop] = useState('');
  const [group, setGroup] = useState('');
  const [fresh, setFresh] = useState(false);
  const fams = [...new Set(graph.clips.flatMap((c) => [c.family?.start, c.family?.end]).filter((f): f is string => !!f))].sort();
  const groups = [...new Set(graph.clips.map((c) => c.group))];
  const qq = q.trim().toLowerCase();
  const shows = (c: GraphClip) =>
    (!qq || c.name.toLowerCase().includes(qq)) &&
    (!fam || c.family?.start === fam || c.family?.end === fam) &&
    (!stance || posture(c.stance?.start) === stance || posture(c.stance?.end) === stance) &&
    (!loop || (loop === 'loop') === !!c.loop) &&
    (!group || c.group === group) &&
    (!fresh || (c.origin != null && c.origin !== 'game'));
  const hits = graph.clips.filter(shows);
  const pick = (clip: string) => onPick(picked === clip ? null : clip);
  const key = (e: KeyboardEvent, clip: string) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    pick(clip);
  };

  return (
    <aside className={styles.palette} aria-label="片段">
      <SearchField value={q} label="搜索片段" placeholder="搜片段名" onChange={setQ} />
      <div className={styles.filters}>
        <Select label="姿势族" value={fam} options={[ALL, ...fams.map((f) => ({ value: f, label: f }))]} onChange={setFam} />
        <Select
          label="站坐"
          value={stance}
          options={[ALL, { value: 'stand', label: '站' }, { value: 'sit', label: '坐' }]}
          onChange={setStance}
        />
        <Select label="循环或单次" value={loop} options={[ALL, { value: 'loop', label: '循环' }, { value: 'once', label: '单次' }]} onChange={setLoop} />
        <Select label="分组" value={group} options={[ALL, ...groups.map((g) => ({ value: g, label: groupTitle(g) }))]} onChange={setGroup} />
        <span className={styles.only}>
          只看新
          <Toggle size="sm" on={fresh} label="只看新" onChange={setFresh} />
        </span>
      </div>
      <ul className={styles.clips}>
        {hits.map((c) => (
          <li
            key={c.name}
            role="button"
            tabIndex={0}
            draggable
            className={styles.clip}
            data-clip={c.name}
            aria-pressed={picked === c.name}
            aria-label={`片段 ${shortName(c.name)}`}
            title={c.name}
            onDragStart={(e) => {
              e.dataTransfer.setData('text/plain', c.name);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={() => pick(c.name)}
            onKeyDown={(e) => key(e, c.name)}
          >
            <span className={styles.nm}>{shortName(c.name)}</span>
            <span className={styles.sub}>
              {[c.loop ? '循环' : '单次', c.family?.start && c.family.end ? `${c.family.start} → ${c.family.end}` : null, groupTitle(c.group)]
                .filter(Boolean)
                .join(' │ ')}
            </span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
