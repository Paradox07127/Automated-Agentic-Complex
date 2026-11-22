import { useRef, useState, type Ref } from 'react';
import { keyText } from '../../bridge/platformText';
import { gameClips } from '../../design/gameClips.generated';
import type { Fact, MemorySource } from '../../domain';
import { useDevMode } from '../../shell/devMode';
import { Btn, Icon, Menu, OpenSec, RowPlate, SearchField, Seg, type MenuItem } from '../../ui';
import { SrcGlyph } from './bits';
import { useEntrance } from './motion';
import { daysAgo, factText, GROUPS, groupOf, isDormant, matches, SORTERS, SORTS, SRC, updText, useCount, useSpark, type Sort } from './model';
import m from './Memory.module.css';
import styles from './FactList.module.css';

export interface FactListProps {
  facts: Fact[];
  now: number;
  src: MemorySource | null;
  onSrc: (s: MemorySource | null) => void;
  q: string;
  onQ: (q: string) => void;
  searchRef: Ref<HTMLInputElement>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** Rows that arrived while the page was open. */
  fresh: ReadonlySet<string>;
  onSave: (f: Fact, text: string) => Promise<boolean>;
  onDelete: (f: Fact) => void;
  onAdd: () => void;
  /** Preview of locked and quiet rows and the 不再提及 switch; absent while agentd has neither. */
  preview?: { locked: ReadonlySet<string>; quiet: ReadonlySet<string>; onQuiet: (f: Fact, on: boolean) => void };
}

/** 56 × 14 uses-per-day spark of the last 14 days. */
function Spark({ pts }: { pts: number[] }) {
  const mx = Math.max(1, ...pts);
  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${(1 + (i * 54) / 13).toFixed(1)} ${(13 - (v / mx) * 11).toFixed(1)}`).join('');
  return (
    <svg className={styles.spark} width="56" height="14" viewBox="0 0 56 14" aria-hidden="true">
      <line x1="0" x2="56" y1="13.5" y2="13.5" className={styles.sparkBase} />
      <path d={d} className={styles.sparkLine} />
    </svg>
  );
}

/** 记忆列表：搜索、排序、按来源筛选，按 基本信息 / 偏好 / 约定 / 经历 分组的记录行（共用 RowPlate）；点一行开右侧抽屉。 */
export function FactList(p: FactListProps) {
  const { facts, now, src, q, selected, preview } = p;
  const [sort, setSort] = useState<Sort>('new');
  const devMode = useDevMode();
  const [edit, setEdit] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const entrance = useEntrance(list, gameClips.wikiItemIn);
  const shown = facts.filter((f) => (!src || f.source === src) && matches(f, q));
  const jump = (g: string) => document.getElementById(`mem-g-${g}`)?.scrollIntoView({ block: 'start' });

  const save = (f: Fact) =>
    void p.onSave(f, draft.trim()).then((ok) => {
      if (ok) setEdit(null);
    });

  const row = (f: Fact) => {
    if (edit === f.id)
      return (
        <div key={f.id} className={styles.row} data-edit="">
          <span className={styles.ic}>
            <SrcGlyph src={f.source} />
          </span>
          <input
            className={styles.input}
            value={draft}
            maxLength={500}
            aria-label="修改这条记忆"
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft.trim()) save(f);
              if (e.key === 'Escape') setEdit(null);
            }}
          />
          <span className={`${m.cap} ${styles.hint}`}>回车保存，Esc 取消</span>
          <span className={styles.acts}>
            <Btn size="sm" variant="text" onClick={() => setEdit(null)}>
              取消
            </Btn>
            <Btn size="sm" variant="ghost" icon="check" disabled={!draft.trim()} disabledReason="内容不能为空" onClick={() => save(f)}>
              保存
            </Btn>
          </span>
        </div>
      );
    const on = selected === f.id;
    const dormant = isDormant(f);
    const quiet = preview?.quiet.has(f.id) ?? false;
    const more: MenuItem[] = [
      ...(preview
        ? [quiet ? { kind: 'item' as const, label: '恢复提及', onSelect: () => preview.onQuiet(f, false) } : { kind: 'item' as const, label: '不再提及', hint: '降权，不删除', onSelect: () => preview.onQuiet(f, true) }]
        : []),
      { kind: 'item', label: '查看出处', onSelect: () => p.onSelect(f.id) },
    ];
    return (
      <div key={f.id} className={styles.row} data-selected={on || undefined} data-dormant={dormant || undefined} data-quiet={quiet || undefined} data-fresh={p.fresh.has(f.id) || undefined} data-fact={f.id} data-g="item">
        <div data-g="itemBody">
          <RowPlate
            title={factText(f)}
            meta={
              <span className={styles.mt}>
                {p.fresh.has(f.id) && <span className={m.just}>新</span>}
                {preview?.locked.has(f.id) && <span className={m.lock}>已锁定</span>}
                {quiet && <span className={m.quiet}>不再提及</span>}
                <SrcGlyph src={f.source} />
                {SRC[f.source].full}
                <span className={styles.sep} aria-hidden="true">
                  │
                </span>
                {updText(daysAgo(f.recorded_at, now))}
              </span>
            }
            selected={on}
            onClick={() => p.onSelect(on ? null : f.id)}
            actions={
              <>
                <span className={styles.use}>
                  {devMode && (
                    <span className={m.cap}>
                      引用 <span className="num">{useCount(f)}</span> 次
                    </span>
                  )}
                  <Spark pts={useSpark(f, now)} />
                </span>
                <span className={styles.act} data-z={dormant || undefined}>
                  {dormant ? '休眠' : '活跃'}
                </span>
                <span className={styles.acts}>
                  <Btn
                    size="sm"
                    variant="text"
                    onClick={() => {
                      setEdit(f.id);
                      setDraft(f.text);
                    }}
                  >
                    修改
                  </Btn>
                  <Btn size="sm" variant="text" onClick={() => p.onDelete(f)}>
                    删除
                  </Btn>
                  <Menu icon="more" label="更多操作" align="right" items={more} />
                </span>
              </>
            }
          />
        </div>
      </div>
    );
  };

  let body;
  if (facts.length === 0)
    body = (
      <div className={m.none} data-size="sm">
        <span>还没有记忆，对话后后台整理出的记忆会列在这里</span>
      </div>
    );
  else if (shown.length === 0)
    body = (
      <div className={m.none} data-size="sm">
        <span>没有符合条件的记忆</span>
        <button
          type="button"
          className={m.lnk}
          onClick={() => {
            p.onQ('');
            p.onSrc(null);
          }}
        >
          清除条件
        </button>
      </div>
    );
  else
    body = GROUPS.map((g) => {
      const rows = shown.filter((f) => groupOf(f) === g.id).sort(SORTERS[sort]);
      return (
        rows.length > 0 && (
          <div key={g.id} className={styles.grp} role="group" aria-label={g.label}>
            <div className={styles.gh} id={`mem-g-${g.id}`}>
              <span className={styles.gt}>{g.label}</span>
              <span className={`${styles.gn} num`}>{rows.length}</span>
            </div>
            <div className={styles.rows}>{rows.map(row)}</div>
          </div>
        )
      );
    });

  return (
    <OpenSec
      title="记忆"
      count={shown.length}
      right={
        <Btn size="sm" variant="ghost" icon="plus" onClick={p.onAdd}>
          新增记忆
        </Btn>
      }
    >
      {facts.length > 0 && (
        <div className={styles.tools} role="toolbar" aria-label="搜索、排序、分组跳转">
          <span className={styles.search}>
            <SearchField inputRef={p.searchRef} value={q} label="搜索记忆" placeholder={keyText('搜索记忆 ⌘F')} onChange={p.onQ} />
          </span>
          <span className={m.cap}>排序</span>
          <Seg size="sm" label="排序" value={sort} options={SORTS} onChange={(v) => setSort(v as Sort)} />
          {src && (
            <button type="button" className={styles.chip} onClick={() => p.onSrc(null)}>
              <SrcGlyph src={src} />
              只看「{SRC[src].short}」
              <Icon name="close" size={12} label="清除筛选" />
            </button>
          )}
          <span className={m.sp} />
          <span className={styles.jump}>
            <span className={m.cap}>跳转</span>
            {GROUPS.map((g) => (
              <button key={g.id} type="button" className={m.lnk} disabled={!shown.some((f) => groupOf(f) === g.id)} onClick={() => jump(g.id)}>
                {g.label}
              </button>
            ))}
          </span>
        </div>
      )}
      <div ref={list} className={styles.list}>
        {entrance}
        {body}
      </div>
    </OpenSec>
  );
}
