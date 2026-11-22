import { useEffect, useState } from 'react';
import { getBridge, type MotionPlaylist, type PlaylistState } from '../../bridge';
import { Btn, Icon, Seg } from '../../ui';
import type { Toast } from './feedback';
import type { MotionRow } from './MotionTable';
import dark from './Rows.module.css';
import styles from './Playlist.module.css';

export interface PlaylistProps {
  /** Her actions' rows; only `mmd_` actions are listed. */
  rows: MotionRow[];
  character: string;
  /** Why the list cannot change or play now; null when it can. */
  blocked: string | null;
  toast: Toast;
}

const LOOPS = [
  { value: 'off', label: '不循环' },
  { value: 'one', label: '单曲' },
  { value: 'all', label: '全部' },
];
const SPEEDS = [
  { value: '0.5', label: '0.5×' },
  { value: '1', label: '1×' },
  { value: '2', label: '2×' },
];
const EMPTY: MotionPlaylist = { items: [], loop: 'off', speed: 1 };
const IDLE: PlaylistState = { playing: false, index: null, id: null };

const failed = (what: string, toast: Toast) => (e: unknown) =>
  toast(`${what}没有完成：${(e as { code?: string } | null)?.code === 'not_implemented' ? '这个版本还不支持' : '桌面角色没有回应'}`, { severity: 'danger' });

/** MMD 列表：当前角色的 MMD 动作，排进列表的在前；循环、速度、播放和停止；正在播的那行高亮。 */
export function Playlist(p: PlaylistProps) {
  const mmd = p.rows.filter((r) => r.a.id.startsWith('mmd_'));
  const [saved, setSaved] = useState<MotionPlaylist>(EMPTY);
  const [now, setNow] = useState<PlaylistState>(IDLE);
  const shown = mmd.length > 0;

  useEffect(() => {
    if (!shown) return;
    let live = true;
    setSaved(EMPTY);
    getBridge()
      .character.getPlaylist()
      .then((l) => live && setSaved(l), failed('读取 MMD 列表', p.toast));
    return () => {
      live = false;
    };
  }, [p.character, shown]);

  const poll = () =>
    void getBridge()
      .avatar.playlistState()
      .then(setNow, () => setNow(IDLE));
  // Polled only while the section is drawn.
  useEffect(() => {
    if (!shown) return;
    poll();
    const t = setInterval(poll, 1000);
    return () => clearInterval(t);
  }, [shown]);

  if (!shown) return null;

  // Ids the character no longer has drop out of the list on the next save.
  const items = saved.items.filter((id) => mmd.some((r) => r.a.id === id));
  const save = (next: MotionPlaylist) => {
    const before = saved;
    setSaved(next);
    getBridge()
      .character.setPlaylist(next)
      .catch((e: unknown) => {
        setSaved(before);
        failed('改 MMD 列表', p.toast)(e);
      });
  };
  const put = (next: string[]) => save({ ...saved, items: next });
  const move = (i: number, by: -1 | 1) => {
    const next = [...items];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    put(next);
  };
  const play = () =>
    getBridge()
      .avatar.playPlaylist()
      .then((r) => {
        if (!r.ok) p.toast(r.reason === 'empty' ? '连播没有开始：列表里没有动作' : '连播没有开始：角色没有接受', { severity: 'danger' });
        poll();
      }, failed('连播', p.toast));
  const stop = () => getBridge().avatar.stopPlaylist().then(poll, failed('停止连播', p.toast));
  const off = p.blocked;
  const ordered = [...items.map((id) => mmd.find((r) => r.a.id === id)!), ...mmd.filter((r) => !items.includes(r.a.id))];

  return (
    <section className={styles.pl} aria-label="MMD 列表" data-playlist="">
      <h3 className={dark.head}>
        MMD 列表
        <span className={`${dark.meta} num`}>
          {items.length}/{mmd.length}
        </span>
      </h3>
      <div className={styles.bar}>
        <Seg size="sm" label="循环" options={LOOPS.map((o) => ({ ...o, disabled: off != null }))} value={saved.loop} onChange={(v) => save({ ...saved, items, loop: v as MotionPlaylist['loop'] })} />
        <Seg size="sm" label="连播速度" options={SPEEDS.map((o) => ({ ...o, disabled: off != null }))} value={String(saved.speed)} onChange={(v) => save({ ...saved, items, speed: Number(v) as MotionPlaylist['speed'] })} />
        <span className={styles.sp} />
        <Btn size="sm" variant="secondary" icon="play" disabled={off != null || items.length === 0} disabledReason={off ?? '先把动作加入列表'} onClick={() => void play()}>
          播放
        </Btn>
        <Btn size="sm" variant="ghost" disabled={off != null || !now.playing} disabledReason={off ?? '列表没有在播放'} onClick={() => void stop()}>
          停止
        </Btn>
      </div>
      <div className={`${dark.list} ${styles.list}`} role="grid" aria-label="MMD 动作">
        {ordered.map(({ a, no }) => {
          const i = items.indexOf(a.id);
          const on = now.playing && now.id === a.id;
          return (
            <div key={a.id} className={dark.row} role="row" data-playlist-row={a.id} data-out={i < 0 || undefined} aria-current={on || undefined}>
              <span className={`${dark.lead} num`}>{on ? <Icon name="play" size={14} /> : no}</span>
              <span className={dark.main}>
                <span className={`${dark.nm} ${styles.nm}`}>{a.label}</span>
                <span className={`${dark.meta} num`}>{i < 0 ? '' : i + 1}</span>
                <span className={dark.end}>
                  {i >= 0 && (
                    <>
                      <Btn size="sm" variant="text" disabled={off != null || i === 0} disabledReason={off ?? '已在最前'} onClick={() => move(i, -1)}>
                        上移
                      </Btn>
                      <Btn size="sm" variant="text" disabled={off != null || i === items.length - 1} disabledReason={off ?? '已在最后'} onClick={() => move(i, 1)}>
                        下移
                      </Btn>
                    </>
                  )}
                  <Btn
                    size="sm"
                    variant="ghost"
                    disabled={off != null}
                    disabledReason={off ?? ''}
                    onClick={() => put(i < 0 ? [...items, a.id] : items.filter((x) => x !== a.id))}
                  >
                    {i < 0 ? '加入' : '移出'}
                  </Btn>
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
