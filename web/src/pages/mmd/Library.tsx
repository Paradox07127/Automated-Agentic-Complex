import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { MmdEntry, MmdListResult } from '../../bridge';
import { gameClips } from '../../design/gameClips.generated';
import { Empty, IconBtn, Skel, Tabs } from '../../ui';
import { useGameClip } from '../../ui/fx/useGameClip';
import { Barcode, MicroLabel, StatusLamp, WhiteCapsule } from '../../ui/game';
import { motionImportReason } from '../character/labels';
import styles from './Library.module.css';

export type MmdState = MmdEntry['characters'][number];

const PENDING: MmdState = { id: '', state: 'pending', reason: null };

/** Her bake state of a dance; a character the library has not reached yet waits for the sync. */
export const stateOf = (e: MmdEntry, character: string): MmdState => e.characters.find((c) => c.id === character) ?? PENDING;

/** Why a dance does not play on her; null once it is baked. */
export const notBaked = (s: MmdState): string | null => (s.state === 'baked' ? null : s.state === 'failed' ? motionImportReason(s.reason ?? '', undefined) : '待同步');

export type MmdFilter = 'all' | 'ready' | 'pending';

/** How many dances she can play and how many wait; the filter tabs show only when both are some. */
const counts = (entries: MmdEntry[], current: string) => {
  const ready = entries.filter((e) => stateOf(e, current).state === 'baked').length;
  return { ready, waiting: entries.length - ready, tabs: ready > 0 && ready < entries.length };
};

/** The rows a filter tab keeps; every row while the tabs are not drawn. */
export const filtered = (entries: MmdEntry[], current: string, f: MmdFilter) =>
  f === 'all' || !counts(entries, current).tabs ? entries : entries.filter((e) => (stateOf(e, current).state === 'baked') === (f === 'ready'));

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
  /** A row's right end: its place in her list, its ＋, or nothing. */
  slot?: (e: MmdEntry) => ReactNode;
  /** Under the selected row. */
  detail?: ReactNode;
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
      <StatusLamp onDark state="failed" label={message} />
      <WhiteCapsule label="重试" icon="refresh" onClick={onRetry} />
    </div>
  );
}

/** 舞曲库：筛选页签（全部 / 可播放 / 未就绪），每支舞一行 ▶ 深色行；点一行选中，选中行展开它的操作。 */
export function Library(p: LibraryProps) {
  const list = useRef<HTMLUListElement>(null);
  const d = p.data;
  if (p.error !== false || d?.ok === false)
    return (
      <LibraryError
        message={`读取 MMD 库失败：${p.error === false && d?.ok === false ? motionImportReason(d.reason, d.detail) : p.error === 'not_implemented' ? '这个版本还不支持' : '桌面角色没有回应'}`}
        onRetry={p.onRetry}
      />
    );
  if (!d) return <Skel rows={4} />;
  if (d.entries.length === 0)
    return (
      <Empty
        icon="upload"
        title="曲库里还没有舞"
        desc={
          <>
            点右上 <b>导入 VMD</b> 选一个 VMD 动作（可附带音乐）；导入后每个角色共用，切到别的角色时会自动同步给她。
          </>
        }
      />
    );

  const { ready, waiting, tabs } = counts(d.entries, p.current);
  const f = tabs ? (p.filter ?? 'all') : 'all';
  const rows = filtered(d.entries, p.current, f);

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
              { id: 'pending', label: '未就绪', count: waiting },
            ]}
          />
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
                    <span className={styles.nm}>{e.title}</span>
                    <span className={styles.dur}>{`${e.durationS.toFixed(1)} s`}</span>
                    {e.hasBgm && <span className={styles.chip}>BGM</span>}
                    {e.hasCamera && <span className={styles.chip}>CAM</span>}
                    {why != null && (
                      <span className={styles.why} data-tone={s.state === 'failed' ? 'danger' : undefined} title={why}>
                        {why}
                      </span>
                    )}
                  </span>
                </button>
                <span className={styles.deco} aria-hidden="true">
                  <Barcode width={74} height={12} label={e.id} />
                </span>
                <span className={styles.q}>{p.slot?.(e)}</span>
              </div>
              {on && p.detail}
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
    <span className={styles.inq} title={`演出列表第 ${n} 首`}>
      <span className="num">{two(n)}</span>
      <MicroLabel>SET</MicroLabel>
    </span>
  );
}
