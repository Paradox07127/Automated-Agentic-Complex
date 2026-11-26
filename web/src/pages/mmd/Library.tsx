import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { MmdEntry, MmdListResult } from '../../bridge';
import { gameClips } from '../../design/gameClips.generated';
import { Empty, IconBtn, SearchField, Skel, Tabs } from '../../ui';
import { useGameClip } from '../../ui/fx/useGameClip';
import { Barcode, MicroLabel, StatusLamp, WhiteCapsule } from '../../ui/game';
import { motionImportReason } from '../../features/character/labels';
import styles from './Library.module.css';

export type MmdState = MmdEntry['characters'][number];

const PENDING: MmdState = { id: '', state: 'pending', reason: null };

/** Her bake state of a dance; a character the library has not reached yet waits for the sync. */
export const stateOf = (e: MmdEntry, character: string): MmdState => e.characters.find((c) => c.id === character) ?? PENDING;

/** Why a dance does not play on her; null once it is baked. */
export const notBaked = (s: MmdState): string | null => (s.state === 'baked' ? null : s.state === 'failed' ? motionImportReason(s.reason ?? '', undefined) : '待同步');

export type MmdFilter = 'all' | 'ready';

/** How many dances she can play; the filter tabs show only when some can and some cannot. */
const counts = (entries: MmdEntry[], current: string) => {
  const ready = entries.filter((e) => stateOf(e, current).state === 'baked').length;
  return { ready, tabs: ready > 0 && ready < entries.length };
};

/** The rows a filter tab and the search keep; the tab keeps every row while the tabs are not drawn. */
export const filtered = (entries: MmdEntry[], current: string, f: MmdFilter, query = '') => {
  const q = query.trim().toLowerCase();
  const tab = f === 'all' || !counts(entries, current).tabs ? entries : entries.filter((e) => stateOf(e, current).state === 'baked');
  return q ? tab.filter((e) => [e.title, e.role, e.project].some((x) => x?.toLowerCase().includes(q))) : tab;
};

export interface LibraryProps {
  data: MmdListResult | undefined;
  /** `mmd.list` threw: its error code. */
  error: string | null | false;
  onRetry: () => void;
  current: string;
  sel: string | undefined;
  onPick: (e: MmdEntry) => void;
  filter?: MmdFilter;
  onFilter?: (f: MmdFilter) => void;
  /** The search beside the filter tabs. */
  query?: string;
  onQuery?: (q: string) => void;
  /** A row's right end: its place in her list, its ＋, or nothing. */
  slot?: (e: MmdEntry) => ReactNode;
  /** A key the selected row does not handle itself (Enter, ＋, F2, Delete). */
  onKey?: (e: MmdEntry, key: string) => boolean;
}

const two = (n: number) => String(n).padStart(2, '0');

/** The selected lead's inner frame, breathing with attributecell_selected_loop. */
function Breath() {
  const ref = useRef<HTMLElement>(null);
  useGameClip(gameClips.charMarkLoop, ref, { autoplay: true });
  return <i ref={ref} className={styles.frame} data-g="root" />;
}

function Lead({ state }: { state: MmdState['state'] }) {
  if (state === 'pending') return <i className={styles.ring} />;
  if (state === 'failed')
    return (
      <i className={styles.fail}>
        <b>!</b>
      </i>
    );
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" focusable="false">
      <path d="M7 4.5v15l12-7.5z" fill="currentColor" />
    </svg>
  );
}

/** 读取失败：失败灯和原因，下面「重试」。 */
export function LibraryError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className={styles.err} role="alert">
      <StatusLamp onDark wrap state="failed" label={message} />
      <WhiteCapsule label="重试" icon="refresh" onClick={onRetry} />
    </div>
  );
}

/** 舞曲库：搜索和筛选页签（全部 / 可播放），每支舞一行 ▶ 深色行；点一行选中。 */
export function Library(p: LibraryProps) {
  const list = useRef<HTMLUListElement>(null);
  const d = p.data;
  if (p.error !== false || d?.ok === false)
    return (
      <LibraryError
        message={`读取 MMD 舞蹈库失败：${p.error === false && d?.ok === false ? motionImportReason(d.reason, d.detail) : p.error === 'not_implemented' ? '当前版本暂不支持' : '角色渲染进程无响应'}`}
        onRetry={p.onRetry}
      />
    );
  if (!d) return <Skel rows={4} />;
  if (d.entries.length === 0)
    return (
      <Empty
        icon="upload"
        title="MMD 舞蹈库尚无内容"
        desc={
          <>
            点击右上角 <b>导入 MMD</b> 选择 MMD 工程文件夹、ZIP 或 VMD 文件；导入后由所有角色共用，切换角色时将自动同步。
          </>
        }
      />
    );

  const { ready, tabs } = counts(d.entries, p.current);
  const f = tabs ? (p.filter ?? 'all') : 'all';
  const rows = filtered(d.entries, p.current, f, p.query);

  const onKeyDown = (e: MmdEntry, i: number) => (k: KeyboardEvent<HTMLButtonElement>) => {
    const by = k.key === 'ArrowDown' ? 1 : k.key === 'ArrowUp' ? -1 : 0;
    if (by) {
      const next = rows[i + by];
      k.preventDefault();
      if (!next) return;
      p.onPick(next);
      list.current?.querySelector<HTMLButtonElement>(`[data-mmd="${next.id}"] button[aria-pressed]`)?.focus();
    } else if (e.id === p.sel && p.onKey?.(e, k.key)) k.preventDefault();
  };

  return (
    <>
      {(tabs || p.onQuery) && (
        <div className={styles.find}>
          {p.onQuery && (
            <span className={styles.search} data-theme="light">
              <SearchField value={p.query ?? ''} label="搜索舞蹈" placeholder="搜索舞蹈" onChange={p.onQuery} />
            </span>
          )}
          {tabs && (
            <div className={styles.tabs}>
              <Tabs
                label="筛选"
                keys={false}
                value={f}
                onChange={(v) => p.onFilter?.(v as MmdFilter)}
                tabs={[
                  { id: 'all', label: '全部', count: d.entries.length },
                  { id: 'ready', label: '可播放', count: ready },
                ]}
              />
            </div>
          )}
        </div>
      )}
      <ul ref={list} className={styles.list} aria-label="MMD 舞蹈">
        {rows.map((e, i) => {
          const s = stateOf(e, p.current);
          const why = notBaked(s);
          const on = e.id === p.sel;
          return (
            <li key={e.id} className={styles.row} role="group" aria-label={e.title} data-mmd={e.id} data-state={s.state} data-selected={on || undefined}>
              <div className={styles.hd}>
                <button type="button" className={styles.hit} aria-pressed={on} onClick={() => p.onPick(e)} onKeyDown={onKeyDown(e, i)}>
                  <span className={styles.lead} aria-hidden="true">
                    {on && <Breath />}
                    <Lead state={s.state} />
                  </span>
                  <span className={styles.main}>
                    <span className={styles.l1}>
                      <span className={styles.nm}>{e.title}</span>
                      {e.role != null && <span className={styles.role}>{e.role}</span>}
                      {why != null && (
                        <span className={styles.why} data-tone={s.state === 'failed' ? 'danger' : undefined} title={why}>
                          {why}
                        </span>
                      )}
                    </span>
                    <span className={styles.l2}>
                      <span className={styles.dur}>{`${e.durationS.toFixed(1)} s`}</span>
                      {e.hasBgm && <span className={styles.chip}>BGM</span>}
                      {e.hasCamera && <span className={styles.chip}>CAM</span>}
                      {e.hasFace && <span className={styles.chip}>LIP</span>}
                    </span>
                  </span>
                </button>
                <span className={styles.deco} aria-hidden="true">
                  <Barcode width={74} height={12} label={e.id} />
                </span>
                <span className={styles.q}>{p.slot?.(e)}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** ＋ at a row's end: puts the dance at the end of her list. */
export function AddKey({ off, onAdd }: { off: string | null; onAdd: () => void }) {
  return (
    <span className={styles.add}>
      <IconBtn icon="plus" label="加入演出列表" shape="round" disabled={off != null} disabledReason={off ?? undefined} onClick={onAdd} />
      <MicroLabel>ADD</MicroLabel>
    </span>
  );
}

/** Her list's place of a dance in its row: yellow and not a control. */
export function InList({ n }: { n: number }) {
  return (
    <span className={styles.inq} title={`演出列表第 ${n} 项`}>
      <span className="num">{two(n)}</span>
      <MicroLabel>SET</MicroLabel>
    </span>
  );
}
