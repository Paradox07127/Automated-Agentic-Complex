import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { getBridge, type DesktopAnchor, type DockReason, type SayReplyTo } from '../../bridge';
import { useSystemTheme } from '../../shell/useSystemTheme';
import { AvatarLoadingStackCard } from '../stack/cards/AvatarLoadingStackCard';
import { NoticeStackCard } from '../stack/cards/NoticeStackCard';
import { VoiceHintStackCard } from '../stack/cards/VoiceHintStackCard';
import { stackQuery } from '../stack/demos';
import { useHover } from '../stack/useHover';
import { useSeenReceipt } from '../stack/useSeenReceipt';
import { useStackActions } from '../stack/useStackActions';
import { Acts, type ActsProps, type Vote } from './bubble/Acts';
import { BubbleInput } from './bubble/BubbleInput';
import { bubbleCards, bubbleLine, bubblePresence } from './bubble/demo';
import { DoingRow } from './bubble/DoingRow';
import { HeadCard, RadioIcon } from './bubble/HeadCard';
import { Reminder } from './bubble/Reminder';
import { Speech } from './bubble/Speech';
import { Thought } from './bubble/Thought';
import { useBubbleCards } from './bubble/useBubbleCards';
import { useCollapse, type CollapseTarget } from './bubble/useCollapse';
import { useQuickInput } from './bubble/useQuickInput';
import { useSpeech } from './bubble/useSpeech';
import { useThoughtMute } from './bubble/useThoughtMute';
import { asksFeedback, canMute } from './comm/commReducer';
import { Subtitle } from './comm/Subtitle';
import { useAnchor } from './hooks/useAnchor';
import { useContentSize } from './hooks/useContentSize';
import { useDesktopState } from './hooks/useDesktopState';
import { useMountedLog } from './hooks/useMountedLog';
import { usePresence } from './hooks/usePresence';
import { useRegions } from './hooks/useRegions';
import { fakeDemo, readPresence } from './tags/presence';
import { useRitual } from './tags/useRitual';
import bubble from './bubble/Bubble.module.css';
import styles from './BubbleRoot.module.css';

/** Docked for these, she is not on screen to point at: her line shows as a subtitle under the menu bar. */
const SUBTITLE: DockReason[] = ['hidden', 'fullscreen', 'offscreen', 'stale'];
/** How long native's `notice` line stays. */
const NOTICE_MS = 4000;

/** The text of native's last `notice` command, for `NOTICE_MS`. */
function useNotice(): { n: number; text: string } | null {
  const [notice, setNotice] = useState<{ n: number; text: string } | null>(null);
  const sent = useRef(0);
  useEffect(
    () =>
      getBridge().desktop.onCommand((c) => {
        if (c.kind === 'notice') setNotice({ n: (sent.current += 1), text: c.text });
      }),
    [],
  );
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);
  return notice;
}

/** The card edge the tail leaves from, toward her head. */
function tailOf(a: DesktopAnchor | null): { side: 'left' | 'right' | 'top' | 'bottom'; style: CSSProperties } | null {
  const to = a?.toHead;
  if (!to || (to.dx === 0 && to.dy === 0)) return null;
  const side = Math.abs(to.dx) >= Math.abs(to.dy) ? (to.dx > 0 ? 'right' : 'left') : to.dy > 0 ? 'bottom' : 'top';
  return { side, style: { '--to-x': `${to.dx}px`, '--to-y': `${to.dy}px` } as CSSProperties };
}

function headText(text: string): string {
  const chars = [...text.trim()];
  return chars.length > 36 ? `${chars.slice(0, 36).join('')}…` : chars.join('');
}

/**
 * `stack.html#/bubble`, the thought bubble beside her head: a due reminder, else native's push-to-talk hint,
 * else its avatar loading card, else its 屏幕识读 receipt, else her line, else her thought,
 * under the 正在做 row, and 快速输入 under them while it is open. With only a thinking bar or the 正在做 row to show it
 * draws no card, so it reports no region and the status chip shows that instead. Native sizes and places the panel.
 */
export function BubbleRoot() {
  const [q] = useState(stackQuery);
  const still = q.get('still') === '1';
  useSystemTheme(q.get('theme'));
  useEffect(() => {
    document.documentElement.classList.toggle('still', still);
  }, [still]);

  const anchor = useAnchor();
  const state = useDesktopState();
  const [demo] = useState(fakeDemo);
  const [demoCards] = useState(() => bubbleCards(demo));
  const [demoLine] = useState(() => bubbleLine(demo));
  const pushed = usePresence();
  const presence = useMemo(() => bubblePresence(pushed, demo), [pushed, demo]);
  const view = useMemo(() => readPresence(presence), [presence]);
  const cards = useBubbleCards(demoCards);
  const ritual = useRitual(null, view.ritual);
  const mute = useThoughtMute(view.thought?.id ?? null);
  // 关闭 on a thought hides it until one with another id or text arrives.
  const [closedThought, setClosedThought] = useState<string | null>(null);
  const thoughtKey = view.thought ? `${view.thought.id}\n${view.thought.text}` : null;
  const pushedThought = thoughtKey != null && thoughtKey === closedThought ? null : view.thought;
  const input = useQuickInput();
  const notice = useNotice();
  // Feedback stays attached to the originating line as the bubble content changes.
  const [voted, setVoted] = useState<{ id: string; value: Vote } | null>(null);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const { ref: hoverRef, hovered, handlers } = useHover<HTMLDivElement>();
  // Native's push-to-talk hint, else its avatar loading card, else its 屏幕识读 receipt, under a due reminder.
  const hint = cards.reminder ? null : (cards.voice ?? cards.loading ?? cards.look);
  const { bar, dispatch } = useSpeech(demoLine, still, hovered || cards.reminder != null || hint != null);
  // The bubble keeps no stack of its own: a closed card leaves with native's next push.
  const { act } = useStackActions(() => {}, Date.now, still, { toast: () => {}, setPause: () => {} }, (id) => (hint?.id === id ? hint : undefined));

  const rootRef = useRef<HTMLDivElement>(null);
  useRegions(rootRef);
  useContentSize(rootRef);
  useMountedLog('bubble');

  const bridge = getBridge();
  const openChat = (id: string) => bridge.window.openMain(`/chat?turn=${encodeURIComponent(id)}`);
  const feedback = (id: string, value: Vote | 'dismissed') => bridge.agentd.request('POST', '/feedback', { line_id: id, value });
  const voteOn = (id: string): ActsProps['vote'] => ({
    sent: voted?.id === id ? voted.value : null,
    send: (value) => {
      setFeedbackError(null);
      void feedback(id, value).then((res) => {
        if (res.status === 200) setVoted({ id, value });
        else setFeedbackError(id);
      }, () => setFeedbackError(id));
    },
  });
  const docked = anchor?.docked && SUBTITLE.includes(anchor.docked) ? anchor.docked : null;
  const due = cards.reminder;
  // A `reminder_due` announce card may merge several commitments.
  const dueIds = due?.commitment_ids ?? (due?.commitment_id ? [due.commitment_id] : []);
  useSeenReceipt(dueIds, !demoCards && due != null && !docked);
  // Before her first word there is nothing to copy, answer or rate: only 关闭.
  const thinking = !cards.reminder && bar?.phase === 'thinking' ? bar : null;

  let main: ReactNode;
  let text: string;
  let replyTo: SayReplyTo | undefined;
  let onMute: (() => void) | null = null;
  let onClose: (() => void) | null = null;
  let vote: ActsProps['vote'] = null;
  if (cards.reminder) {
    const card = cards.reminder;
    main = <Reminder card={card} busy={cards.busy} error={cards.error} onAck={() => void cards.ack(card)} onLater={() => void cards.later(card)} />;
    text = card.title;
  } else if (hint) {
    if (hint.variant === 'voice') main = <VoiceHintStackCard card={hint} top={false} act={act} />;
    else if (hint.variant === 'loading') main = <AvatarLoadingStackCard card={hint} top={false} now={Date.now()} act={act} />;
    else main = <NoticeStackCard card={hint} index={0} top={false} act={act} />;
    text = hint.title;
  } else if (bar) {
    main = <Speech bar={bar} name={state?.character?.name ?? ''} onOpen={() => openChat(bar.id)} />;
    text = bar.text;
    replyTo = { kind: 'line', id: bar.id };
    if (canMute(bar.reason))
      onMute = () => {
        setFeedbackError(null);
        void bridge.agentd.request('POST', '/feedback', { line_id: bar.id, value: 'dont_disturb', mute: true }).then((result) => {
          if (result.status >= 200 && result.status < 300) dispatch({ type: 'close', id: bar.id });
          else setFeedbackError(bar.id);
        }, () => setFeedbackError(bar.id));
      };
    if (asksFeedback(bar.reason)) vote = voteOn(bar.id);
    onClose = () => {
      if (asksFeedback(bar.reason)) void feedback(bar.id, 'dismissed');
      dispatch({ type: 'close', id: bar.id });
    };
  } else {
    main = <Thought thought={pushedThought} ritual={ritual} mute={mute} composing={input.open != null} />;
    const thought = pushedThought && !mute.closed && mute.mute?.phase !== 'undo' ? pushedThought : null;
    text = thought?.text ?? '';
    if (thought) {
      replyTo = { kind: 'thought', id: thought.id };
      onMute = () => void mute.off();
      vote = voteOn(thought.id);
      onClose = () => {
        void feedback(thought.id, 'dismissed');
        setClosedThought(thoughtKey);
      };
    }
  }

  const thoughtShown = (pushedThought != null && !mute.closed) || ritual != null || mute.mute?.phase === 'undo';
  const said = cards.reminder != null || hint != null || (bar ? bar.phase !== 'thinking' : thoughtShown);
  const shown = said || notice != null || cards.dropError != null || input.error != null || (replyTo?.id != null && feedbackError === replyTo.id);
  const activeThought = !cards.reminder && !hint && !bar && pushedThought && !mute.closed && mute.mute?.phase !== 'undo' ? pushedThought : null;
  const collapseTarget: CollapseTarget | null =
    docked || cards.reminder || hint
      ? null
      : bar
        ? bar.phase === 'linger'
          ? { kind: 'line', key: `line:${bar.id}`, text: bar.text }
          : null
        : activeThought
          ? { kind: 'thought', key: `thought:${thoughtKey}`, text: activeThought.text }
          : null;
  const { collapsed, timer, expand } = useCollapse(collapseTarget, still, hovered || input.open != null || notice != null);
  const collapsedKind = !docked && !input.open && !notice && !cards.dropError && !input.error && collapsed ? (collapseTarget?.kind ?? null) : null;
  const tail = docked ? null : tailOf(anchor);
  const room = anchor?.room.width ?? 0;
  const sizing = room > 0 ? { '--bubble-w': `${Math.max(160, Math.min(364, Math.floor(room) - 40))}px` } as CSSProperties : undefined;
  return (
    <div
      ref={rootRef}
      className={styles.root}
      style={sizing}
      data-surface-root="bubble"
      data-side={anchor?.side}
      data-docked={anchor?.docked ?? undefined}
      data-collapsed={collapsedKind ? '' : undefined}
    >
      {docked && bar && (
        <div className={styles.sub} data-glass="">
          <Subtitle bar={bar} name={state?.character?.name ?? ''} onOpen={() => openChat(bar.id)} />
        </div>
      )}
      {collapsedKind ? (
        <button type="button" className={styles.collapsed} data-region="" aria-label="展开消息" title={headText(text)} onClick={expand}>
          {collapsedKind === 'thought' ? (
            <RadioIcon className={styles.collapsedRadio} />
          ) : (
            <svg className={styles.collapsedGlyph} viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2.5 3h11v8H7l-3 2.5V11H2.5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      ) : (
        (input.open || (!docked && shown)) && (
          <div ref={hoverRef} {...handlers}>
            <div
              className={styles.card}
              data-region=""
              data-glass=""
              data-bubble=""
              data-tail={tail?.side}
              data-input={input.open ? '' : undefined}
              style={tail?.style}
            >
              {!docked && !cards.reminder && !hint && bar && <HeadCard id={state?.character?.id} />}
              <div className={styles.band}>
                {!docked && <>
                  <header className={styles.head} data-drag="">
                    <span className={styles.grip} role="img" title="拖动气泡；双击回到默认位置" aria-label="拖动气泡；双击回到默认位置">
                      <svg viewBox="0 0 10 14" aria-hidden="true">
                        <path d="M2 3h6M2 7h6M2 11h6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    </span>
                    {state?.showPresence !== false && <DoingRow presence={presence} />}
                  </header>
                  {main}
                </>}
                {!docked && notice && (
                  <p key={notice.n} className={`${bubble.note} ${bubble.fade}`} role="status">
                    {notice.text}
                  </p>
                )}
                {!docked && !input.open && !due && !hint && (thinking ? (
                  <div className={bubble.acts} data-bubble-acts="">
                    <button type="button" className={bubble.act} data-region="" aria-label="关闭" onClick={() => dispatch({ type: 'close', id: thinking.id })}>
                      关闭
                    </button>
                  </div>
                ) : (
                  <Acts key={replyTo?.id ?? 'idle'} text={text} replyLabel={replyTo ? '回复' : '输入消息'} onReply={() => input.reply(text, replyTo)} onMute={onMute} onClose={onClose} vote={vote} />
                ))}
                {replyTo?.id != null && feedbackError === replyTo.id && <p className={bubble.err} role="status">反馈发送失败，可以重试</p>}
                {!docked && cards.dropError && <p className={bubble.err} role="alert">{cards.dropError}</p>}
                {input.error && <p className={bubble.err} role="alert">{input.error}</p>}
                {input.open && <BubbleInput open={input.open} state={state} attachment={input.attachment} onDrop={input.drop} onClose={input.close} />}
                {timer && (
                  <span
                    key={timer.key}
                    className={styles.timer}
                    data-bubble-timer=""
                    data-paused={timer.paused ? '' : undefined}
                    aria-hidden="true"
                    style={{ '--timer-ms': `${timer.ms}ms`, '--timer-from': String(timer.total > 0 ? timer.ms / timer.total : 1) } as CSSProperties}
                  />
                )}
              </div>
              {tail && <span className={styles.tail} aria-hidden="true" />}
            </div>
          </div>
        )
      )}
    </div>
  );
}
