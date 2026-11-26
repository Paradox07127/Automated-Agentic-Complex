import { useContext, useRef, useState } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { getBridge, type CharacterEntry } from '../../bridge';
import type { Toast } from '../../features/character/feedback';
import { hostReason } from './labels';
import { previewLookChanged } from '../../features/character/usePreview';

type Layers = CharacterEntry['layers'];
/** Layer id → whether it shows. */
type Shown = Record<string, boolean>;

const change = (shown: Shown) => ({
  hide: Object.keys(shown).filter((id) => !shown[id]),
  show: Object.keys(shown).filter((id) => shown[id]),
});

/** The outfit layers with what this page asked and what the host took applied, and the calls that change them. Each call names only
 *  the layers it changes, so layers of her other appearances keep how they are. */
export function useLayers(ch: CharacterEntry | undefined, current: string, toast: Toast) {
  // Read from the context, not useQueryClient: the operator view also renders without a query client.
  const qc = useContext(QueryClientContext);
  // What the host took since the roster layers it was taken over; a roster read since (the menu bar may have changed them) wins.
  const [took, setTook] = useState<{ character: string; shown: Shown; of: Layers }>();
  // What was asked and not answered yet, shown in the switches meanwhile.
  const [asked, setAsked] = useState<{ character: string; shown: Shown }>();
  const seen = useRef<Layers>(undefined);
  seen.current = ch?.layers;
  // The host refuses a `setLayers` while one is open: one goes at a time, and the clicks meanwhile go together when it answers.
  const req = useRef<{ busy: boolean; next?: { character: string; shown: Shown; done: string } }>({ busy: false }).current;
  const tookNow = took && took.character === ch?.id && took.of === ch?.layers ? took.shown : undefined;
  const askedNow = asked && asked.character === ch?.id ? asked.shown : undefined;
  const layers = (ch?.layers ?? []).map((l) => ({ ...l, visible: askedNow?.[l.id] ?? tookNow?.[l.id] ?? l.visible }));

  /** Drops the asked entries `shown` answered, unless a later click asked otherwise. */
  const answered = (character: string, shown: Shown) =>
    setAsked((a) => (a?.character !== character ? a : { character, shown: Object.fromEntries(Object.entries(a.shown).filter(([id, v]) => shown[id] !== v)) }));
  const run = (character: string, shown: Shown, done: string) => {
    req.busy = true;
    const settle = () => {
      req.busy = false;
      const next = req.next;
      req.next = undefined;
      if (next) run(next.character, next.shown, next.done);
    };
    getBridge()
      .avatar.setLayers(character, change(shown))
      .then(
        () => {
          setTook((t) => ({ character, shown: { ...(t?.character === character && t.of === seen.current ? t.shown : {}), ...shown }, of: seen.current }));
          answered(character, shown);
          void qc?.invalidateQueries({ queryKey: ['character', 'list'] });
          previewLookChanged();
          toast(done);
          settle();
        },
        (e: unknown) => {
          const code = (e as { code?: string } | null)?.code;
          answered(character, shown);
          toast(`服装分层未完成：${code === 'not_implemented' ? '当前版本暂不支持' : code === 'character_changed' ? hostReason(code) : '角色渲染进程无响应'}`, { severity: 'danger' });
          settle();
        },
      );
  };
  const send = (shown: Shown, done: string) => {
    setAsked((a) => ({ character: current, shown: { ...(a?.character === current ? a.shown : {}), ...shown } }));
    if (!req.busy) return run(current, shown, done);
    const next = req.next?.character === current ? req.next.shown : {};
    req.next = { character: current, shown: { ...next, ...shown }, done };
  };
  return {
    layers,
    setLayer: (id: string, on: boolean, name: string) => send({ [id]: on }, on ? `已显示「${name}」` : `已隐藏「${name}」`),
    showAll: () => send(Object.fromEntries(layers.map((l) => [l.id, true])), '已全部显示'),
  };
}
