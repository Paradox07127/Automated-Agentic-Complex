import { useRef, useState, type KeyboardEvent } from 'react';
import { formatClock, type Conversation } from '../../domain';
import { Btn, ContextMenu, Icon, IconBtn, SearchField, type IconName, type MenuItem } from '../../ui';
import { CellsIn } from './motion';
import styles from './ConvList.module.css';

/** agentd takes a title of 1–80 characters (conversations.py title()). */
const MAX_TITLE = 80;

const BUSY_NEW = '角色执行中，结束后可新建';

export interface ConvListProps {
  /** Her name: the topics' group label. */
  who: string;
  /** Not archived, pinned first then newest. */
  conversations: Conversation[];
  archived: Conversation[];
  selected: string | null;
  /** Creating a topic waits for the role. */
  busy: boolean;
  now: number;
  folded: boolean;
  onFold: () => void;
  onSelect: (c: Conversation) => void;
  onNew: () => void;
  manageItems: (c: Conversation) => MenuItem[];
  /** The row whose title box is open. */
  renaming: string | null;
  onRenaming: (id: string | null) => void;
  onRename: (c: Conversation, title: string) => void;
  /** Delete or ⌫ on a row. */
  onDelete: (c: Conversation) => void;
}

export function whenOf(at: number, now: number): string {
  const d = new Date(at);
  if (d.toDateString() === new Date(now).toDateString()) return formatClock(at);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** The row's title box: Enter or leaving it saves, Esc keeps the title. `onDone` also gets the row as it was when the box opened: the save carries that revision. */
function TitleBox({ c, onDone }: { c: Conversation; onDone: (title: string | null, opened: Conversation) => void }) {
  const done = useRef(false);
  const opened = useRef(c);
  const finish = (title: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(title, opened.current);
  };
  const save = (v: string) => {
    const t = v.trim();
    finish(t && t !== opened.current.title ? t : null);
  };
  return (
    <input
      className={styles.ren}
      aria-label="话题名"
      defaultValue={c.title}
      maxLength={MAX_TITLE}
      ref={(el) => {
        if (el && document.activeElement !== el && !done.current) {
          el.focus();
          el.select();
        }
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          save(e.currentTarget.value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(null);
        }
      }}
      onBlur={(e) => save(e.currentTarget.value)}
    />
  );
}

/** One topic: icon, title over her last line, time (or 置顶). */
function Row({ c, on, now, icon, editing, onOpen, onMenu, onKey, onDone }: {
  c: Conversation; on: boolean; now: number; icon: IconName; editing: boolean;
  onOpen: () => void; onMenu: (at: { x: number; y: number }) => void; onKey: (e: KeyboardEvent) => void; onDone: (title: string | null, opened: Conversation) => void;
}) {
  const body = (
    <>
      <Icon name={icon} size={20} />
      <span className={styles.col}>
        {editing ? <TitleBox c={c} onDone={onDone} /> : <span className={styles.title}>{c.title}</span>}
        <span className={styles.pv}>{c.preview}</span>
      </span>
      <span className={styles.when}>{c.pinned ? <span className={styles.pin}>置顶</span> : whenOf(c.updated_at, now)}</span>
    </>
  );
  const common = { className: styles.row, 'data-g': 'cell', 'data-topic': c.id, 'data-archived': c.archived || undefined, 'aria-current': on ? ('true' as const) : undefined };
  if (editing) return <div {...common}>{body}</div>;
  return (
    <button
      type="button"
      {...common}
      onClick={onOpen}
      onKeyDown={onKey}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {body}
    </button>
  );
}

/** Her topics: head (fold, search, new), pinned first, 新话题, then 已归档 N; right click manages a row. */
export function ConvList(p: ConvListProps) {
  const { conversations, archived, selected, busy, now, folded } = p;
  const [q, setQ] = useState('');
  const [openArch, setOpenArch] = useState(false);
  const [ctx, setCtx] = useState<{ id: string; at: { x: number; y: number } } | null>(null);
  const [menuFor, setMenuFor] = useState(selected);
  if (menuFor !== selected) {
    setMenuFor(selected);
    setCtx(null);
  }
  const root = useRef<HTMLElement>(null);
  const needle = q.trim();
  const hit = (c: Conversation) => needle === '' || c.title.includes(needle) || c.preview.includes(needle);
  const live = conversations.filter(hit);
  const arch = archived.filter(hit);
  const all = [...conversations, ...archived];
  const menuRow = all.find((c) => c.id === ctx?.id);
  // The row whose title box opens must be on screen: a search that hides it is cleared.
  const editing = all.find((c) => c.id === p.renaming);
  if (editing && q !== '' && !hit(editing)) setQ('');
  const newLabel = busy ? BUSY_NEW : '新话题';
  const row = (c: Conversation) => (
    <Row
      key={c.id}
      c={c}
      on={c.id === selected}
      now={now}
      icon={c.archived ? 'g-archive' : 'g-topic'}
      editing={p.renaming === c.id}
      onOpen={() => {
        setCtx(null);
        p.onSelect(c);
      }}
      onMenu={(at) => setCtx({ id: c.id, at })}
      onKey={(e) => {
        if (e.key === 'F2' && !c.archived) {
          e.preventDefault();
          p.onRenaming(c.id);
        } else if ((e.key === 'Delete' || e.key === 'Backspace') && !busy) {
          e.preventDefault();
          p.onDelete(c);
        }
      }}
      onDone={(title, opened) => {
        p.onRenaming(null);
        if (title) p.onRename(opened, title);
      }}
    />
  );
  return (
    <nav ref={root} className={styles.root} aria-label="话题" data-fold={folded || undefined}>
      <div className={styles.head}>
        <IconBtn icon="g-fold" size="sm" label={folded ? '展开左栏' : '折叠左栏'} onClick={p.onFold} />
        {!folded && <SearchField value={q} label="搜索话题" placeholder="搜索话题" onChange={setQ} />}
        <IconBtn icon="g-plus" size="sm" label={newLabel} disabled={busy} onClick={p.onNew} />
      </div>
      {!folded && (
        <div className={styles.scroll}>
          {live.length > 0 || arch.length > 0 || needle === '' ? (
            <div className={styles.topics} role="group" aria-label={`${p.who}的话题`}>
              {live.map(row)}
              {needle === '' && (
                <span className={styles.add}>
                  <Btn variant="secondary" size="sm" icon="g-new" label={newLabel} disabled={busy} disabledReason={BUSY_NEW} onClick={p.onNew}>
                    新话题
                  </Btn>
                </span>
              )}
              {arch.length > 0 && needle !== '' && arch.map(row)}
              {arch.length > 0 && needle === '' && (
                <>
                  <span className={styles.archRow}>
                    <Btn variant="text" size="sm" icon="chev" aria-expanded={openArch} onClick={() => setOpenArch(!openArch)}>
                      {`已归档 ${arch.length}`}
                    </Btn>
                  </span>
                  {openArch && arch.map(row)}
                </>
              )}
            </div>
          ) : (
            <p className={styles.none}>{`${p.who}的话题里没有「${needle}」`}</p>
          )}
          {live.length > 0 && <CellsIn root={root} />}
        </div>
      )}
      <ContextMenu label={menuRow ? `管理「${menuRow.title}」` : ''} items={menuRow ? p.manageItems(menuRow) : []} at={menuRow ? (ctx?.at ?? null) : null} onClose={() => setCtx(null)} />
    </nav>
  );
}
