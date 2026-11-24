import { useEffect, useRef, useState, type ReactNode } from 'react';
import { keyText } from '../../bridge/platformText';
import type { Fact, FactKind } from '../../domain';
import { BottomBarSlot } from '../../shell/headerSlot';
import { toast } from '../../shell/toast';
import { Btn, Empty, ErrBar, Pill, SearchField, SecHead, Select, Skel } from '../../ui';
import { IndexCell } from '../../ui/game';
import { Detail } from './Detail';
import { Keys } from './Keys';
import { LeftCol, Plate } from './Index';
import { catOf, CATS, factText, isCandidate, isDormant, matches, plateOf, recentText, SORTERS, SORTS, SRC, ymd, type Cat, type Sort } from './model';
import { AddPop, DeleteCard } from './Papers';
import { DetailCol, Glyph, List, Lnk, Panel, Row, Sep, SrcMark, useNarrow, type GlyphName } from './parts';
import { errorText } from './errors';
import { readCascade } from './useFacts';
import { Votes } from './Votes';
import styles from './Cols.module.css';

type Pick = 'pending' | 'all' | Cat;
const ICON: Record<Exclude<Cat, 'about'>, GlyphName> = { pref: 'pref', deal: 'deal', exp: 'flag', other: 'dots' };

export interface ArchiveProps {
  /** Every row of GET /memory, candidates included; undefined while it loads. */
  facts: Fact[] | undefined;
  /** Why GET /memory failed; null when it did not. */
  error: string | null;
  onRetry: () => void;
  now: number;
  still: boolean;
  fresh: ReadonlySet<string>;
  /** `?sel=` and `?q=` on arrival. */
  initial: { sel: string | null; q: string };
  /** Writes; each resolves true when agentd took it, after saying so. */
  write: {
    confirm: (f: Fact) => Promise<boolean>;
    correct: (f: Fact, text: string) => Promise<boolean>;
    reject: (f: Fact) => Promise<boolean>;
    forget: (f: Fact, gone: string[]) => Promise<boolean>;
    mark: (f: Fact, mark: 'locked' | 'quiet', on: boolean) => Promise<boolean>;
    add: (text: string, kind: FactKind) => Promise<boolean>;
  };
  onJump: (k: 'chat' | 'obs') => void;
  onChat: () => void;
  /** The page has view tabs, so the key legend names Q / E. */
  tabbed?: boolean;
  /** 整理记录 › 导出 清空记忆… at the right of the bottom bar. */
  actions: ReactNode;
}

/** 档案：左栏名牌和分类格，中栏搜索、排序、新增和记录行，右栏这条记忆（窄窗是抽屉）；有待确认时先停在「待确认」的投票卡。 */
export function Archive({ facts, error, onRetry, now, still, fresh, initial, write, onJump, onChat, tabbed = false, actions }: ArchiveProps) {
  const narrow = useNarrow();
  const all = facts ?? [];
  const asks = all.filter(isCandidate);
  const active = all.filter((f) => !isCandidate(f));
  const initialFact = initial.sel ? all.find((f) => f.id === initial.sel) : undefined;
  const [picked, setPicked] = useState<Pick | null>(null);
  const [q, setQ] = useState(initial.q);
  const [sort, setSort] = useState<Sort>('new');
  const [sel, setSel] = useState<string | null>(initial.sel);
  const [drawer, setDrawer] = useState(initial.sel != null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState<{ fact: Fact; gone: string[] } | null>(null);
  // The card lists what agentd retires with f (memory.py `_tombstone`), and the delete names the same ids.
  const askDelete = (f: Fact) =>
    void readCascade(f).then(
      (gone) => setDeleting({ fact: f, gone }),
      (e: unknown) => toast(`没有删除：${errorText(e)}`),
    );
  const [adding, setAdding] = useState(false);

  // A selected candidate opens 待确认; any other selection opens 全部.
  const auto: Pick = initialFact ? (isCandidate(initialFact) ? 'pending' : 'all') : asks.length > 0 ? 'pending' : 'all';
  const cat: Pick = picked === 'pending' && asks.length === 0 ? 'all' : (picked ?? auto);
  const loaded = facts != null && error == null;
  const count = (c: Pick) => (!loaded ? null : c === 'all' ? active.length : c === 'pending' ? asks.length : active.filter((f) => catOf(f) === c).length);
  const shown = active.filter((f) => (cat === 'all' || catOf(f) === cat) && matches(f, q)).sort(SORTERS[sort]);
  const grouped = cat === 'all' && sort === 'new' && !q.trim();
  const order = grouped ? CATS.flatMap((c) => shown.filter((f) => catOf(f) === c.id)) : shown;
  const open = active.find((f) => f.id === sel) ?? (narrow ? undefined : order[0]);
  const listing = cat !== 'pending' && loaded && all.length > 0;

  const pick = (c: Pick) => {
    setPicked(c);
    setEditing(false);
    setDrawer(false);
    setSel(null);
  };
  const select = (f: Fact) => {
    setSel(f.id);
    setEditing(false);
    setDrawer(narrow);
  };

  // ↑ ↓ move the selection, Enter edits it, Delete asks to delete it; not while typing or over a dialog.
  const keys = useRef({ order, open, listing, narrow });
  keys.current = { order, open, listing, narrow };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest('input, textarea, select, [contenteditable], [role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      const { order: rows, open: cur, listing: on, narrow: drawn } = keys.current;
      if (!on) return;
      // Enter and Delete belong to a focused control, unless it is a row of the list.
      const onRow = !el?.closest('button, a, [role="radio"]') || el.closest('[data-fact]') != null;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const i = rows.findIndex((f) => f.id === cur?.id);
        const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (!next) return;
        setSel(next.id);
        setEditing(false);
        document.querySelector<HTMLElement>(`[data-fact="${next.id}"] button`)?.focus({ preventScroll: false });
      } else if (e.key === 'Enter' && cur && onRow) {
        e.preventDefault();
        setSel(cur.id);
        setEditing(true);
        setDrawer(drawn);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && cur && onRow) {
        e.preventDefault();
        askDelete(cur);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const row = (f: Fact, i: number) => {
    const uses = recentText(f, now);
    return (
      <div key={f.id} data-fact={f.id}>
        <Row
          i={i}
          selected={open?.id === f.id}
          fresh={fresh.has(f.id)}
          lead={<SrcMark src={f.source} />}
          title={factText(f)}
          sub={
            <>
              <span>{SRC[f.source].full}</span>
              <span className="num">{ymd(f.recorded_at)}</span>
              {uses && (
                <span>
                  近 14 天用到 <span className="num">{uses}</span> 次
                </span>
              )}
            </>
          }
          end={
            <>
              {f.locked && <Pill tone="mission">已锁定</Pill>}
              {f.quiet && <Pill tone="mission">不再提及</Pill>}
              {isDormant(f) && <Pill dashed>30 天没用到</Pill>}
            </>
          }
          onClick={() => select(f)}
        />
      </div>
    );
  };

  let list: ReactNode;
  if (error != null) list = <List>{<ErrBar message={`没有读到记忆：${error}`} onRetry={onRetry} />}</List>;
  else if (facts == null)
    list = (
      <List>
        <Skel rows={6} height={58} />
      </List>
    );
  else if (all.length === 0)
    list = (
      <List>
        <Empty
          icon="data"
          title="还没记住你的事"
          desc="你在对话里说过的偏好、约定和经历，会记在这里；你说「记住……」就马上记下。"
          action={
            <Btn icon="send" onClick={onChat}>
              去对话
            </Btn>
          }
        />
      </List>
    );
  else if (shown.length === 0)
    list = (
      <List>
        <Empty inline title="没有符合条件的记忆" action={<Lnk onClick={() => setQ('')}>清除条件</Lnk>} />
      </List>
    );
  else if (grouped) {
    let i = 0;
    list = (
      <List label="记住的事">
        {CATS.map((c) => {
          const rows = shown.filter((f) => catOf(f) === c.id);
          return rows.length === 0 ? null : (
            <div key={c.id} role="group" aria-label={c.label} className={styles.grp}>
              <SecHead title={c.label} count={rows.length} micro={c.en} />
              {rows.map((f) => row(f, i++))}
            </div>
          );
        })}
      </List>
    );
  } else {
    const c = CATS.find((x) => x.id === cat);
    list = (
      <List label="记住的事">
        <SecHead title={c?.label ?? '全部'} count={shown.length} {...(c ? { micro: c.en } : {})} />
        {shown.map(row)}
      </List>
    );
  }

  const cells: Array<{ id: Pick; label: string; icon: GlyphName }> = [
    ...(asks.length > 0 ? [{ id: 'pending' as const, label: '待确认', icon: 'vote' as const }] : []),
    { id: 'all', label: '全部', icon: 'grid' },
    ...CATS.filter((c) => c.id !== 'about').map((c) => ({ id: c.id, label: c.label, icon: ICON[c.id as Exclude<Cat, 'about'>] })),
  ];
  const wide = cat === 'pending' || !listing;
  const legend: Array<[string[], string]> =
    cat === 'pending'
      ? [[['1', '2', '3'], '记住 / 改 / 不是这样']]
      : [
          [['↑', '↓'], '选择'],
          [['Enter'], '修改'],
          [['Del'], '删除'],
        ];
  if (tabbed) legend.push([['Q', 'E'], '切页签']);
  legend.push([['Esc'], '回主页']);

  return (
    <div className={styles.body} data-wide={wide || undefined}>
      <LeftCol label="分类">
        <Plate plate={loaded ? plateOf(all) : null} selected={cat === 'about'} onClick={() => pick('about')} />
        <Sep en="Index" />
        {cells.map((c, i) => (
          <IndexCell key={c.id} i={i} icon={<Glyph name={c.icon} />} label={c.label} count={count(c.id) ?? '—'} pressed={cat === c.id} pending={c.id === 'pending'} onClick={() => pick(c.id)} />
        ))}
      </LeftCol>
      {cat === 'pending' ? (
        <Votes asks={asks} now={now} still={still} onConfirm={write.confirm} onFix={write.correct} onDeny={write.reject} onJump={onJump} />
      ) : (
        <section className={styles.ccol} aria-label="记忆">
          <div className={styles.crow}>
            <span className={styles.search}>
              <SearchField value={q} label="搜索记忆" placeholder="搜索记住的事" shortcut={keyText('⌘F')} maxLength={500} onChange={setQ} />
            </span>
            <span className={styles.sp} />
            <Select label="排序" prefix="排序" value={sort} options={SORTS} width={124} onChange={(v) => setSort(v as Sort)} />
            <Btn icon="plus" onClick={() => setAdding(true)}>
              新增
            </Btn>
          </div>
          <Panel>{list}</Panel>
        </section>
      )}
      {!wide && open && (
        <DetailCol narrow={narrow} open={drawer} label="这条记忆" onClose={() => (setDrawer(false), setEditing(false))}>
          <Detail
            key={open.id}
            fact={open}
            now={now}
            editing={editing}
            onEdit={setEditing}
            onSave={(text, from) => write.correct(from, text)}
            onDelete={() => askDelete(open)}
            onMark={(mark, on) => void write.mark(open, mark, on)}
            onJump={onJump}
            {...(narrow ? { onClose: () => (setDrawer(false), setEditing(false)) } : {})}
          />
        </DetailCol>
      )}
      {deleting && (
        <DeleteCard
          fact={deleting.fact}
          gone={deleting.gone.map((id) => all.find((f) => f.id === id) ?? null)}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const { fact: f, gone } = deleting;
            setDeleting(null);
            void write.forget(f, gone).then((ok) => {
              if (ok && sel === f.id) setSel(null);
              if (ok) setDrawer(false);
            });
          }}
        />
      )}
      {adding && (
        <AddPop
          onCancel={() => setAdding(false)}
          onSave={async (text, kind) => {
            const ok = await write.add(text, kind);
            if (ok) setAdding(false);
            return ok;
          }}
        />
      )}
      <BottomBarSlot lead={<Keys keys={legend} />} actions={actions} />
    </div>
  );
}
