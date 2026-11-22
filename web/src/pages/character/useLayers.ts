import { useContext, useRef, useState } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { getBridge, type CharacterEntry } from '../../bridge';
import type { Toast } from './feedback';
import { previewLookChanged } from './usePreview';

type Layers = CharacterEntry['layers'];

/** The outfit layers with the hidden set this page last sent applied, and the calls that change it. */
export function useLayers(ch: CharacterEntry | undefined, current: string, toast: Toast) {
  // Read from the context, not useQueryClient: the operator view also renders without a query client.
  const qc = useContext(QueryClientContext);
  // The hidden set the last successful `avatar.setLayers` sent, over the roster layers it was sent against; a roster read since (the menu bar may have changed them) wins.
  const [hiddenSet, setHiddenSet] = useState<{ character: string; hidden: string[]; of: Layers }>();
  const seen = useRef<Layers>(undefined);
  seen.current = ch?.layers;
  // The host refuses a `setLayers` while one is open: one goes at a time, and the newest set asked meanwhile goes when it answers.
  // `hidden` is the newest set asked, so a click builds on it and not on the page.
  const req = useRef<{ busy: boolean; next?: { character: string; hidden: string[]; done: string }; hidden?: { character: string; hidden: string[] } }>({ busy: false }).current;
  const layers = (ch?.layers ?? []).map((l) => (hiddenSet?.character === ch?.id && hiddenSet?.of === ch?.layers ? { ...l, visible: !hiddenSet?.hidden.includes(l.id) } : l));

  const run = (character: string, hidden: string[], done: string) => {
    req.busy = true;
    const settle = () => {
      req.busy = false;
      const next = req.next;
      req.next = undefined;
      if (next) run(next.character, next.hidden, next.done);
      else req.hidden = undefined;
    };
    getBridge()
      .avatar.setLayers(hidden)
      .then(
        () => {
          setHiddenSet({ character, hidden, of: seen.current });
          void qc?.invalidateQueries({ queryKey: ['character', 'list'] });
          previewLookChanged();
          toast(done);
          settle();
        },
        (e: unknown) => {
          const code = (e as { code?: string } | null)?.code;
          toast(`服装分层没有完成：${code === 'not_implemented' ? '这个版本还不支持' : '桌面角色没有回应'}`, { severity: 'danger' });
          settle();
        },
      );
  };
  const send = (hidden: string[], done: string) => {
    req.hidden = { character: current, hidden };
    if (req.busy) req.next = { character: current, hidden, done };
    else run(current, hidden, done);
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
