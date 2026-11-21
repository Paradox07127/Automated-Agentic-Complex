import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { getBridge, type DesktopState } from '../../bridge';
import { AgentdCallError, call, seg } from '../../bridge/agentd';
import { runCancel } from '../../domain/bodies';
import { failureText } from '../../domain/errorText';
import { useSystemTheme } from '../../shell/useSystemTheme';
import { Icon } from '../../ui';
import { stackQuery } from '../stack/demos';
import { initialStack, stackReducer } from '../stack/stackReducer';
import { useStackActions } from '../stack/useStackActions';
import { useStackCards } from '../stack/useStackCards';
import { useAnchor } from './hooks/useAnchor';
import { useDesktopState } from './hooks/useDesktopState';
import { useMountedLog } from './hooks/useMountedLog';
import { usePresence } from './hooks/usePresence';
import { useRegions } from './hooks/useRegions';
import { ringDemo } from './ring/demo';
import { above, cardRoom, ICON_SIZE, iconCenters, RING_PANEL, type IconPoint } from './ring/geometry';
import { ringKeys, ringModel, ringTip, type BackgroundItem, type ResultItem, type RingKey, type RingModel } from './ring/items';
import { RingPop } from './ring/RingPop';
import styles from './RingRoot.module.css';

/** Both she and the panel unhovered this long, the ring folds back. */
const CLOSE_MS = 600;
const POP_GAP = 10;
const TIP_GAP = 8;

/** The pointer on her opens the ring, from the desktop state every panel gets; the status chip hides then. */
export const ringOpens = (state: DesktopState | null): boolean => state?.showHoverHints !== false && !!state?.avatarHovered;

/** Places a card or tip of its measured size above the row over icon `p`; hidden until measured. */
function usePlaced<T extends HTMLElement>(p: IconPoint | null, gap: number) {
  const ref = useRef<T>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !p) return;
    const next = above(p, el.offsetWidth, el.offsetHeight, gap);
    setPos((old) => (old && old.left === next.left && old.top === next.top ? old : next));
  });
  const style: CSSProperties = pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' };
  return { ref, style };
}

function Glyph({ which, model }: { which: RingKey; model: RingModel }): ReactNode {
  const badge = (n: number) => <span className={`${styles.badge} num`}>{n}</span>;
  switch (which) {
    case 'reminders':
      return (
        <>
          <svg className={styles.ico} viewBox="0 0 18 18" aria-hidden="true">
            <path d="M4.5 12.5V8a4.5 4.5 0 019 0v4.5l1.2 1.5H3.3z" />
            <path d="M7.3 15.5a1.8 1.8 0 003.4 0" />
          </svg>
          {badge(model.reminders?.count ?? 0)}
        </>
      );
    case 'results':
      return (
        <>
          <svg className={styles.ico} viewBox="0 0 18 18" aria-hidden="true">
            <path d="M2.5 10l2-6h9l2 6v4.5h-13z" />
            <path d="M2.5 10h4l1 1.8h3l1-1.8h4" />
          </svg>
          {badge(model.results?.count ?? 0)}
        </>
      );
    case 'background':
      return (
        <>
          <Icon name="sync" />
          {badge(model.background?.count ?? 0)}
        </>
      );
    case 'quiet':
      return (
        <svg className={styles.ico} viewBox="0 0 18 18" aria-hidden="true">
          <path d="M14.5 11.2A6 6 0 016.8 3.5a6 6 0 107.7 7.7z" />
        </svg>
      );
    case 'passthrough':
      return (
        <svg className={styles.ico} viewBox="0 0 18 18" aria-hidden="true">
          <path d="M5 2.5v11l3-2.6 2 4.4 1.8-.8-2-4.3h4z" />
        </svg>
      );
    case 'voice':
      return <Icon name="mic" />;
    case 'observation':
      return <Icon name="eye" />;
  }
}

/**
 * `stack.html#/ring`, the icon row under her feet: a fixed-size panel with one 30 px icon per live
 * thing in one row along its bottom, centred on her feet. It opens while she or the panel is hovered and folds 600 ms after both stop, unless an icon's card
 * is open. The icons are quick-menu cells and the card a tips card, dark in both appearances; the
 * card is the panel's only `data-glass` rect. With no icon the panel reports no region, so native hides it.
 */
export function RingRoot() {
  const [q] = useState(stackQuery);
  const still = q.get('still') === '1';
  useSystemTheme(q.get('theme'));
  useEffect(() => {
    document.documentElement.classList.toggle('still', still);
  }, [still]);

  const [demo] = useState(() => (window.agenticComplex ? null : ringDemo(q)));
  const anchor = useAnchor();
  const panel = RING_PANEL;
  // Her head top is over her feet; native slides the panel off them only at a screen edge.
  const feet = panel.width / 2 + (anchor?.toHead?.dx ?? 0);
  const pushedState = useDesktopState();
  const state = demo && pushedState ? { ...pushedState, ...demo.state } : pushedState;
  const pushed = usePresence();
  const presence = demo ? demo.presence : pushed;
  const stack = useStackCards(null);
  const data = demo ? demo.payload : stack.data;

  const [cards, dispatch] = useReducer(stackReducer, initialStack);
  const offset = useRef(0);
  const frozen = useRef<number | null>(null);
  const clock = useCallback(() => frozen.current ?? Date.now() + offset.current, []);
  const [note, setNote] = useState<string | null>(null);
  const cardsRef = useRef(cards.cards);
  useLayoutEffect(() => {
    cardsRef.current = cards.cards;
  });
  const { act } = useStackActions(dispatch, clock, still, { toast: (t) => setNote(t?.text ?? null), setPause: () => {} }, (id) => cardsRef.current.find((c) => c.id === id));
  useEffect(() => {
    if (!data) return;
    offset.current = data.now - Date.now();
    if (still) frozen.current = data.now;
    dispatch({ type: 'load', payload: data });
  }, [data, still]);

  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(() => new Set());
  const now = clock();
  const model = ringModel(presence, state, cards.cards, now, gone);
  const keys = ringKeys(model);
  const centers = iconCenters(keys.length, feet);
  // Folded, the icons sit on the row's middle.
  const fold = { x: ((centers[0]?.x ?? 0) + (centers.at(-1)?.x ?? 0)) / 2, y: centers[0]?.y ?? 0 };

  // 免打扰 updates while it is active and drops its icon when it expires.
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const counting = model.quiet != null;
  useEffect(() => {
    if (still || !counting) return;
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [still, counting]);

  // The page's own hover: the native pointer push (a non-key panel gets no mouse events), hit-tested against the icons.
  const [inside, setInside] = useState(false);
  const [pointerTip, setPointerTip] = useState<RingKey | null>(null);
  const [mouseTip, setMouseTip] = useState<RingKey | null>(null);
  const hit = useRef<{ keys: RingKey[]; centers: IconPoint[] }>({ keys: [], centers: [] });
  useLayoutEffect(() => {
    hit.current = { keys, centers };
  });
  useEffect(
    () =>
      getBridge().window.onPointer((p) => {
        setInside(p.inside);
        const { keys: ks, centers: cs } = hit.current;
        const i = p.inside ? cs.findIndex((c) => Math.hypot(c.x - p.x, c.y - p.y) <= ICON_SIZE / 2) : -1;
        setPointerTip(i < 0 ? null : (ks[i] ?? null));
      }),
    [],
  );

  const hot = ringOpens(state) || (state?.showHoverHints !== false && (inside || !!demo?.hover));
  const [pop, setPop] = useState<RingKey | null>(demo?.pop ?? null);
  const [open, setOpen] = useState(!!demo?.hover);
  useEffect(() => {
    if (hot) {
      setOpen(true);
      return;
    }
    if (pop) return;
    const t = setTimeout(() => setOpen(false), CLOSE_MS);
    return () => clearTimeout(t);
  }, [hot, pop]);

  const live = pop != null && keys.includes(pop);
  useEffect(() => {
    if (pop && !live) setPop(null);
  }, [pop, live]);
  useEffect(() => setNote(null), [pop]);

  // Escape or a click off the card and the icons closes the card.
  const showingPop = pop != null;
  useEffect(() => {
    if (!showingPop) return;
    const bridge = getBridge();
    bridge.window.requestKey();
    return () => bridge.window.releaseKey();
  }, [showingPop]);
  useEffect(() => {
    if (!pop) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPop(null);
    };
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest('[data-ring-pop], [data-ring-icon]')) return;
      setPop(null);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [pop]);

  const rootRef = useRef<HTMLDivElement>(null);
  useRegions(rootRef);
  useMountedLog('ring');
  // The panel is always this size; the card is drawn inside it and the rest passes clicks through.
  useEffect(() => getBridge().window.setContentSize({ width: panel.width, height: panel.height }), [panel.width, panel.height]);

  const shown = open && keys.length > 0;
  const popPoint = live ? (centers[keys.indexOf(pop)] ?? null) : null;
  const tipKey = shown && !live ? (mouseTip ?? pointerTip) : null;
  const tipPoint = tipKey && keys.includes(tipKey) ? (centers[keys.indexOf(tipKey)] ?? null) : null;
  const popPlace = usePlaced<HTMLElement>(popPoint, POP_GAP);
  const tipPlace = usePlaced<HTMLDivElement>(tipPoint, TIP_GAP);

  const onReminder = (id: string, how: 'complete' | 'snooze') => {
    const item = model.reminders?.items.find((r) => r.id === id);
    const settled = () => {
      if (item) setGone((g) => new Set(g).add(item.key));
      setNote(how === 'complete' ? '提醒已完成' : '10 分钟后再提醒');
    };
    const req = how === 'complete' ? call('POST', `/commitments/${seg(id)}/complete`) : call('POST', `/commitments/${seg(id)}/snooze`, { minutes: 10 });
    req.then(settled, (e: unknown) => {
      // agentd marks a one-time reminder fulfilled when it announces it, so 完成 then has nothing left to move.
      if (how === 'complete' && e instanceof AgentdCallError && e.code === 'illegal_transition') return settled();
      const f = e instanceof AgentdCallError ? { status: e.status, code: e.code, detail: e.detail ?? null } : { status: 0 };
      setNote(`${how === 'complete' ? '没能完成提醒' : '没能延后提醒'}：${failureText(f).text}`);
    });
  };
  const onResult = (item: ResultItem, how: 'open' | 'drop') => {
    const action = how === 'open' ? item.open : item.drop;
    if (action) act(action);
    else if (how === 'drop') setGone((g) => new Set(g).add(item.key));
  };
  const onEnd = (which: 'quiet' | 'passthrough') =>
    void getBridge().desktop.action(which === 'quiet' ? 'quietEnd' : 'clickThroughAll').catch(() => {
      setNote(which === 'quiet' ? '没能结束免打扰，可以重试' : '没能结束点穿，可以重试');
    });
  const onCancel = (item: BackgroundItem) => {
    setCancelling((s) => new Set(s).add(item.runId));
    call('POST', `/agent/runs/${seg(item.runId)}/cancel`, runCancel(item)).catch((e: unknown) => {
      setCancelling((s) => {
        const next = new Set(s);
        next.delete(item.runId);
        return next;
      });
      const f = e instanceof AgentdCallError ? { status: e.status, code: e.code, detail: e.detail ?? null } : { status: 0 };
      setNote(`没能取消${item.title}：${failureText(f).text}`);
    });
  };

  return (
    <div
      ref={rootRef}
      className={styles.root}
      data-surface-root="ring"
      data-theme="dark"
      data-open={shown ? 'true' : 'false'}
      style={{ width: panel.width, height: panel.height }}
    >
      {keys.map((k, i) => {
        const c = centers[i]!;
        return (
          <button
            key={k}
            type="button"
            className={styles.icon}
            data-ring-icon={k}
            data-region={shown ? '' : undefined}
            data-active={pop === k || undefined}
            tabIndex={shown ? 0 : -1}
            aria-hidden={!shown || undefined}
            aria-label={ringTip(k, model)}
            aria-expanded={pop === k}
            style={{ left: fold.x - ICON_SIZE / 2, top: fold.y - ICON_SIZE / 2, '--dx': `${c.x - fold.x}px`, '--dy': `${c.y - fold.y}px` } as CSSProperties}
            onClick={() => setPop((cur) => (cur === k ? null : k))}
            onMouseEnter={() => setMouseTip(k)}
            onMouseLeave={() => setMouseTip((cur) => (cur === k ? null : cur))}
          >
            <Glyph which={k} model={model} />
          </button>
        );
      })}
      {live && pop && popPoint && (
        <RingPop
          which={pop}
          model={model}
          now={now}
          note={note}
          boxRef={popPlace.ref}
          style={{ ...popPlace.style, width: cardRoom(POP_GAP).width, maxHeight: cardRoom(POP_GAP).maxHeight }}
          onClose={() => setPop(null)}
          onReminder={onReminder}
          onResult={onResult}
          onEnd={onEnd}
          cancelling={cancelling}
          onCancel={onCancel}
        />
      )}
      {tipKey && tipPoint && (
        <div
          ref={tipPlace.ref}
          className={styles.tip}
          data-ring-tip=""
          role="tooltip"
          style={{ ...tipPlace.style, maxWidth: cardRoom(TIP_GAP).width }}
        >
          {ringTip(tipKey, model)}
        </div>
      )}
    </div>
  );
}
