import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { getBridge } from '../../bridge';
import { approvalView, InSession } from '../../features/approval';
import { useSystemTheme } from '../../shell/useSystemTheme';
import { Toast } from '../../ui';
import { PowerState } from '../../ui/game';
import { stackQuery } from '../stack/demos';
import { ELSEWHERE_RECEIPT_MS, isStackApproval } from '../stack/model';
import { StackCardView } from '../stack/StackCardView';
import { initialStack, stackReducer } from '../stack/stackReducer';
import { useHover } from '../stack/useHover';
import { useStackActions, type StackToast } from '../stack/useStackActions';
import { useStackCards } from '../stack/useStackCards';
import { useAnchor } from './hooks/useAnchor';
import { useContentSize } from './hooks/useContentSize';
import { useDesktopState } from './hooks/useDesktopState';
import { useMountedLog } from './hooks/useMountedLog';
import { usePresence } from './hooks/usePresence';
import { useRegions } from './hooks/useRegions';
import { hudDemo } from './hud/demo';
import { HudLine } from './hud/HudLine';
import { HUD_DONE_MS, hudRows, type HudRow } from './hud/rows';
import { readPresence } from './tags/presence';
import styles from './HudRoot.module.css';

/** Folded, the edges of at most this many lines show behind the top one. */
const EDGES = 2;
/** Expanded, the list scrolls past this share of the room native gives the panel. */
const ROOM_SHARE = 0.6;

/**
 * `stack.html#/hud`, the session status bar under her: one line per live session and per standalone card
 * that waits on you. Folded it shows the top line with the others' edges behind it; expanded every line, the waiting ones
 * with their approval or question inside. With no line it reports no region, so native hides the panel.
 */
export function HudRoot() {
  const [q] = useState(stackQuery);
  const still = q.get('still') === '1';
  useSystemTheme(q.get('theme'));
  useEffect(() => {
    document.documentElement.classList.toggle('still', still);
  }, [still]);

  const [demo] = useState(() => (window.agenticComplex ? null : hudDemo(q)));
  const pushed = usePresence();
  const settings = useDesktopState();
  const presence = demo ? demo.presence : pushed;
  const stack = useStackCards(null);
  const data = demo ? demo.payload : stack.data;
  const offline = readPresence(presence).offline || data?.offline === true;
  const anchor = useAnchor();

  const [state, dispatch] = useReducer(stackReducer, initialStack);
  const offset = useRef(0);
  const frozen = useRef<number | null>(null);
  const clock = useCallback(() => frozen.current ?? Date.now() + offset.current, []);
  const [toast, setToast] = useState<StackToast | null>(null);
  const cardsRef = useRef(state.cards);
  useLayoutEffect(() => {
    cardsRef.current = state.cards;
  });
  const { act, schedule } = useStackActions(dispatch, clock, still, { toast: setToast, setPause: () => {} }, (id) => cardsRef.current.find((c) => c.id === id));

  useEffect(() => {
    if (!data) return;
    offset.current = data.now - Date.now();
    if (still) frozen.current = data.now;
    dispatch({ type: 'load', payload: data });
  }, [data, still]);

  useEffect(() => {
    if (!toast || still || toast.action) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast, still]);

  // As on the stack: an approval answered elsewhere leaves after its receipt, one past its deadline after its expiry receipt.
  useEffect(() => {
    if (still) return;
    const timers = state.cards.flatMap((c) => {
      const outcome = isStackApproval(c) ? approvalView(c).outcome : null;
      if (outcome?.kind !== 'elsewhere') return [];
      return [setTimeout(() => dispatch({ type: 'archive', id: c.id, at: clock() }), Math.max(0, outcome.at + ELSEWHERE_RECEIPT_MS - clock()))];
    });
    return () => timers.forEach(clearTimeout);
  }, [state.cards, clock, still]);
  const expiring = useRef(new Set<string>());
  useEffect(() => {
    for (const c of state.cards) {
      if (c.kind !== 'approval' || c.outcome || expiring.current.has(c.id)) continue;
      expiring.current.add(c.id);
      const expire = () => dispatch({ type: 'patch', id: c.id, patch: { outcome: { kind: 'expired', at: c.item.since + c.item.window_s * 1000 } } });
      if (c.item.seconds_left <= 0) expire();
      else schedule(expire, c.item.seconds_left * 1000);
      schedule(() => dispatch({ type: 'archive', id: c.id, at: clock() }), (Math.max(0, c.item.seconds_left) + 8) * 1000);
    }
  }, [state.cards, schedule, clock]);

  const now = clock();
  const all = hudRows(state.cards, settings?.showPresence === false ? null : presence, now);
  // 关闭 hides the bar until a line with a new id, or a new status on a line it hid, arrives.
  const [closed, setClosed] = useState<Set<string> | null>(null);
  const hidden = closed != null && all.every((r) => closed.has(`${r.id}\n${r.status}`));
  const rows = hidden ? [] : all;
  useEffect(() => {
    if (closed && !hidden) setClosed(null);
  }, [closed, hidden]);

  // A done line leaves HUD_DONE_MS after it finished, without waiting for another push.
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const doneAt = rows.flatMap((r) => (r.status === 'done' && r.session ? [r.session.updatedAt] : [])).join(',');
  useEffect(() => {
    if (still || !doneAt) return;
    const timers = doneAt.split(',').map((at) => setTimeout(tick, Math.max(0, Number(at) + HUD_DONE_MS - clock())));
    return () => timers.forEach(clearTimeout);
  }, [doneAt, still, clock]);

  const [expanded, setExpanded] = useState(demo?.expanded ?? false);
  const [focusAsk, setFocusAsk] = useState(0);
  const focusTop = useCallback(() => {
    setExpanded(true);
    setFocusAsk((n) => n + 1);
  }, []);
  useEffect(
    () =>
      getBridge().desktop.onCommand((c) => {
        if (c.kind === 'expandStack') setExpanded(true);
        if (c.kind === 'focusTop') focusTop();
      }),
    [focusTop],
  );

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusAsk) return;
    const row = listRef.current?.querySelector('[data-status="waiting"]');
    (row?.querySelector<HTMLElement>('[data-card-id] [tabindex="0"]') ?? row?.querySelector<HTMLElement>('[data-card-id] button'))?.focus();
  }, [focusAsk]);

  useEffect(() => {
    if (rows.length === 0) setExpanded(false);
  }, [rows.length]);

  // Escape or a click off the lines folds it; Escape inside an approval or question is that card's own (拒绝, 取消).
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || (e.target instanceof Element && e.target.closest('[data-card-id]'))) return;
      setExpanded(false);
    };
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest('[data-hud-row], [data-hud-fold], [data-hud-toast], [role="menu"], [role="dialog"]')) return;
      setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [expanded]);

  const { ref: rootRef, hovered, handlers } = useHover<HTMLDivElement>();
  useRegions(rootRef);
  useContentSize(rootRef);
  useMountedLog('hud');

  const top = rows[0];
  const line = (r: HudRow, folded: boolean) => <HudLine row={r} folded={folded} total={rows.length} act={act} onHandle={focusTop} />;
  let body = null;
  if (top && !expanded) {
    const edges = Math.min(EDGES, rows.length - 1);
    const open = () => setExpanded(true);
    body = (
      <div
        className={`${styles.band} ${styles.bar}`}
        data-hud-bar=""
        data-region=""
        data-glass=""
        role="button"
        tabIndex={0}
        aria-expanded={false}
        aria-label={`展开全部 ${rows.length} 条`}
        style={{ paddingBottom: edges * 4 } as CSSProperties}
        onClick={open}
        onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
          if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
          e.preventDefault();
          open();
        }}
      >
        {Array.from({ length: edges }, (_, i) => (
          <i key={i} className={styles.edge} data-edge="" aria-hidden="true" style={{ '--i': edges - i } as CSSProperties} />
        ))}
        <div className={styles.row} data-hud-row={top.id} data-status={top.status}>
          {line(top, true)}
        </div>
      </div>
    );
  } else if (top) {
    // One yellow button on the whole bar: cards count from 1 across the lines, and only the first keeps its primary action.
    const total = rows.reduce((n, r) => n + r.cards.length, 0);
    const before = rows.map((_, i) => rows.slice(0, i).reduce((n, r) => n + r.cards.length, 0));
    body = (
      <>
        <div className={`${styles.band} ${styles.block}`} data-glass="">
          <div ref={listRef} className={styles.list} data-region="" style={anchor ? { maxHeight: Math.floor(anchor.room.height * ROOM_SHARE) } : undefined}>
            {rows.map((r, i) => (
              <div key={r.id} className={styles.row} data-hud-row={r.id} data-status={r.status}>
                {line(r, false)}
                {r.cards.length > 0 && (
                  <div className={styles.attached} inert={offline || undefined}>
                    <InSession.Provider value>
                      {r.cards.map((c, k) => (
                        <StackCardView key={c.id} card={c} index={before[i]! + k + 1} total={total} top={false} now={now} act={act} />
                      ))}
                    </InSession.Provider>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
        <div className={styles.foot}>
          <button type="button" className={styles.fold} data-hud-fold="" data-region="" onClick={() => setExpanded(false)}>
            收起
          </button>
        </div>
      </>
    );
  }

  // agentd gone: the last lines stay greyed under 未接入, whose button restarts it.
  if (offline && body)
    body = (
      <div className={styles.power} data-region="">
        <PowerState hud state="unlinked" mode="block" title="后台没有响应" reason="下面是断开前的状态"
          action={{ label: '重启后台', onClick: () => void getBridge().supervisor.restart('agentd').catch(() => {}) }}>
          {body}
        </PowerState>
      </div>
    );

  return (
    <div ref={rootRef} className={styles.root} data-surface-root="hud" data-offline={offline || undefined} data-expanded={expanded && !!top} data-docked={anchor?.docked ?? undefined} {...handlers}>
      {body}
      {top && hovered && (
        <button
          type="button"
          className={styles.close}
          data-hud-close=""
          data-region=""
          title="关闭"
          aria-label="关闭"
          onClick={() => {
            setClosed(new Set(all.map((r) => `${r.id}\n${r.status}`)));
            setExpanded(false);
          }}
        >
          ×
        </button>
      )}
      {toast && (
        <div className={styles.toast} data-hud-toast="" data-region="">
          <Toast message={toast.text} severity={toast.tone} action={toast.action && { label: toast.action.label, onClick: () => { setToast(null); toast.action?.onClick(); } }} persistent={!!toast.action} />
        </div>
      )}
    </div>
  );
}
