import { useRef, useState } from 'react';
import { getBridge, type CharacterEntry } from '../../bridge';
import type { Toast } from './feedback';
import { previewLookChanged } from './usePreview';

/** The outfit layers with the hidden set this page last sent applied, and the calls that change it. */
export function useLayers(ch: CharacterEntry | undefined, current: string, toast: Toast) {
  // The hidden set the last successful `avatar.setLayers` sent; the roster only changes on a refetch.
  const [hiddenSet, setHiddenSet] = useState<{ character: string; hidden: string[] }>();
  // The newest requested hidden set while a request is open, so a click builds on it and not on the page; `done` is the newest request that succeeded.
  const req = useRef<{ seq: number; done: number; hidden?: { character: string; hidden: string[] } }>({ seq: 0, done: 0 }).current;
  const layers = (ch?.layers ?? []).map((l) => (hiddenSet?.character === ch?.id ? { ...l, visible: !hiddenSet?.hidden.includes(l.id) } : l));

  const send = (hidden: string[], done: string) => {
    const n = ++req.seq;
    req.hidden = { character: current, hidden };
    getBridge()
      .avatar.setLayers(hidden)
      .then(
        () => {
          if (n > req.done) {
            req.done = n;
            setHiddenSet({ character: current, hidden });
          }
          if (n === req.seq) req.hidden = undefined;
          previewLookChanged();
          toast(done);
        },
        (e: unknown) => {
          if (n === req.seq) req.hidden = undefined;
          const code = (e as { code?: string } | null)?.code;
          toast(`服装分层没有完成：${code === 'not_implemented' ? '这个版本还不支持' : '桌面角色没有回应'}`, { severity: 'danger' });
        },
      );
  };
  const setLayer = (id: string, on: boolean, name: string) => {
    const open = req.hidden;
    const hidden = open?.character === current ? open.hidden : layers.filter((x) => !x.visible).map((x) => x.id);
    send(
      layers.map((x) => x.id).filter((x) => (x === id ? !on : hidden.includes(x))),
      on ? `已显示「${name}」` : `已隐藏「${name}」`,
    );
  };
  return { layers, setLayer, showAll: () => send([], '已全部显示') };
}
