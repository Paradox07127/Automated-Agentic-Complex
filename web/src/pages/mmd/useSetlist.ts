import { useEffect, useRef, useState } from 'react';
import { getBridge, type MotionPlaylist, type PlaylistState } from '../../bridge';
import type { Toast } from '../character/feedback';
import { hostReason } from '../character/labels';

const EMPTY: MotionPlaylist = { items: [], loop: 'off', speed: 1 };
const IDLE: PlaylistState = { playing: false, index: null, id: null };

const failed = (what: string, toast: Toast) => (e: unknown) => {
  const code = (e as { code?: string } | null)?.code;
  toast(`${what}没有完成：${code === 'not_implemented' ? '这个版本还不支持' : code === 'character_changed' ? hostReason(code) : '桌面角色没有回应'}`, { severity: 'danger' });
};

export interface Setlist {
  /** The list in her order, only ids she has. */
  items: string[];
  loop: MotionPlaylist['loop'];
  speed: MotionPlaylist['speed'];
  now: PlaylistState;
  put: (items: string[]) => void;
  move: (i: number, by: -1 | 1) => void;
  setLoop: (loop: MotionPlaylist['loop']) => void;
  setSpeed: (speed: MotionPlaylist['speed']) => void;
  /** 连播 while idle, 停止 while the desktop plays it. */
  toggle: () => void;
}

/** Her MMD list (`character.getPlaylist/setPlaylist`) and the desktop's run of it (`avatar.playPlaylist/stopPlaylist/playlistState`), read only while she has `mmd_` actions (`ids`). */
export function useSetlist(character: string, ids: string[], toast: Toast): Setlist {
  const [saved, setSaved] = useState<MotionPlaylist>(EMPTY);
  // Whose list `saved` is; edits wait for it, or a save would write over the list on disk.
  const [read, setRead] = useState<string | null>(null);
  // Only the latest save rolls back on failure.
  const last = useRef(0);
  const [now, setNow] = useState<PlaylistState>(IDLE);
  const shown = ids.length > 0;

  useEffect(() => {
    if (!shown) return;
    let live = true;
    last.current++;
    setSaved(EMPTY);
    setRead(null);
    getBridge()
      .character.getPlaylist(character)
      .then((l) => {
        if (!live) return;
        setSaved(l);
        setRead(character);
      }, failed('读取 MMD 列表', toast));
    return () => {
      live = false;
    };
  }, [character, shown]);

  const poll = () =>
    void getBridge()
      .avatar.playlistState()
      .then(setNow, () => setNow(IDLE));
  // Polled only while the list is drawn.
  useEffect(() => {
    if (!shown) return;
    poll();
    const t = setInterval(poll, 1000);
    return () => clearInterval(t);
  }, [shown]);

  // Ids she no longer has drop out of the list on the next save.
  const items = saved.items.filter((id) => ids.includes(id));
  const save = (next: MotionPlaylist) => {
    if (read !== character) return;
    const before = saved;
    const n = ++last.current;
    setSaved(next);
    getBridge()
      .character.setPlaylist(character, next)
      .catch((e: unknown) => {
        if (n === last.current) setSaved(before);
        failed('改 MMD 列表', toast)(e);
      });
  };
  const put = (next: string[]) => save({ ...saved, items: next });
  return {
    items,
    loop: saved.loop,
    speed: saved.speed,
    now,
    put,
    move: (i, by) => {
      const next = [...items];
      [next[i], next[i + by]] = [next[i + by]!, next[i]!];
      put(next);
    },
    setLoop: (loop) => save({ ...saved, items, loop }),
    setSpeed: (speed) => save({ ...saved, items, speed }),
    toggle: () =>
      void (now.playing
        ? getBridge().avatar.stopPlaylist().then(poll, failed('停止连播', toast))
        : getBridge()
            .avatar.playPlaylist()
            .then((r) => {
              if (!r.ok) toast(r.reason === 'empty' ? '连播没有开始：列表里没有动作' : '连播没有开始：角色没有接受', { severity: 'danger' });
              poll();
            }, failed('连播', toast))),
  };
}
