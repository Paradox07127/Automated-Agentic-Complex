import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { getBridge, type DesktopAnchor, type DockReason, type SayReplyTo } from '../../bridge';
import { formatClock } from '../../domain';
import { useSystemTheme } from '../../shell/useSystemTheme';
import { navRoute, type NavTarget } from '../../shell/nav';
import { Btn } from '../../ui/Btn';
import { AvatarLoadingStackCard } from '../stack/cards/AvatarLoadingStackCard';
import { VoiceHintStackCard } from '../stack/cards/VoiceHintStackCard';
import { stackQuery } from '../stack/stackQuery';
import { useHover } from '../stack/useHover';
import { useSeenReceipt } from '../stack/useSeenReceipt';
import { useStackActions } from '../stack/useStackActions';
import { Acts, type ActsProps, StopAct, type Vote } from './bubble/Acts';
import { BubbleInput } from './bubble/BubbleInput';
import { ConfirmCard } from './bubble/ConfirmCard';
import { bubbleCards, bubbleLine, bubblePresence } from './bubble/demo';
import { HeadBubble, type BubbleKind } from './bubble/HeadBubble';
import { Reminder } from './bubble/Reminder';
import { Speech } from './bubble/Speech';
import { Thought } from './bubble/Thought';
import { useBubbleCards } from './bubble/useBubbleCards';
import { useCollapse, type CollapseTarget } from './bubble/useCollapse';
import { useQuickInput } from './bubble/useQuickInput';
import { useSpeech } from './bubble/useSpeech';
import { useThoughtMute } from './bubble/useThoughtMute';
import { asksFeedback, canMute, ERROR_MS, failOf, lingerMs, type Bar } from './comm/commReducer';
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
/** How long native's `notice` line and a 屏幕识读 receipt stay. */
const NOTICE_MS = 4000;
/** How long the last card stays, then fades (`.leaving`), once there is nothing left to say. */
const LEAVE_MS = 500;

/** The text of native's last `notice` command, for `NOTICE_MS`; `expandStack` unfolds a folded approval. */
function useCommands(): { notice: { n: number; text: string } | null; unfold: number } {
  const [notice, setNotice] = useState<{ n: number; text: string } | null>(null);
  const [unfold, setUnfold] = useState(0);
  const sent = useRef(0);
  useEffect(
    () =>
      getBridge().desktop.onCommand((c) => {
        if (c.kind === 'notice') setNotice({ n: (sent.current += 1), text: c.text });
        else if (c.kind === 'expandStack') setUnfold((n) => n + 1);
      }),
    [],
  );
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);
  return { notice, unfold };
}

/** The bottom corner the tail leaves from, toward her head: the side her head is on, else the middle when she is below. */
function tailOf(a: DesktopAnchor | null): 'left' | 'right' | 'bottom' | null {
  const to = a?.toHead;
  if (!to || (to.dx === 0 && to.dy === 0)) return null;
  if (Math.abs(to.dx) >= 40) return to.dx > 0 ? 'right' : 'left';
  return to.dy > 0 ? 'bottom' : null;
}

/**
 * `stack.html#/bubble`, the bubble beside her head, only while there is something to say: an approval on the white paper
 * card, else a due reminder, native's push-to-talk hint or a failed avatar, a failed task or a failed line, a result, a
 * receipt, her line, or a new thought, each once. One shape for them all; it goes after its time (an approval stays), and
 * 快速输入 opens in it. Native sizes and places the panel.
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
  const input = useQuickInput();
  const { notice, unfold } = useCommands();
  // Feedback stays attached to the originating line as the bubble content changes.
  const [voted, setVoted] = useState<{ id: string; value: Vote } | null>(null);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const { ref: hoverRef, hovered, handlers } = useHover<HTMLDivElement>();
  const hint = cards.voice ?? (cards.loading?.phase === 'failed' ? cards.loading : null);
  const { bar, side, dispatch } = useSpeech(demoLine, still, hovered);
  const all = cards.all;
  // A decision that did not go out (a declined native confirm, busy, offline) shows on the approval card for NOTICE_MS.
  const [decideNote, setDecideNote] = useState<{ text: string } | null>(null);
  useEffect(() => {
    if (!decideNote) return;
    const t = setTimeout(() => setDecideNote(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [decideNote]);
  const { act } = useStackActions(() => {}, Date.now, still, { toast: (t) => setDecideNote(t && { text: t.text }), setPause: () => {} }, (id) => all.find((c) => c.id === id));

  // 去处理 from the status mark unfolds the approval ✕ put away, until the next one is folded.
  const [unfolded, setUnfolded] = useState(0);
  useEffect(() => {
    if (unfold > 0) setUnfolded(unfold);
  }, [unfold]);
  const confirm = cards.approvals[0] ?? (unfolded > 0 ? (cards.folded[0] ?? null) : null);
  const waiting = cards.approvals.length + cards.folded.length - (confirm ? 1 : 0);

  const rootRef = useRef<HTMLDivElement>(null);
  useRegions(rootRef);
  useContentSize(rootRef);
  useMountedLog('bubble');

  const bridge = getBridge();
  const openChat = (id: string) => bridge.window.openMain(`/chat?turn=${encodeURIComponent(id)}`);
  const go = (to: NavTarget) => bridge.window.openMain(navRoute(to));
  // 停止 ends the foreground turn in agentd; ✕ only hides the line.
  const stopOf = (b: Bar) =>
    b.kind === 'main' && (b.phase === 'thinking' || b.phase === 'streaming')
      ? () => void bridge.agentd.request('POST', '/turn/cancel', { reason: 'client_cancel', line_id: b.id })
      : null;
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

  // A thought pops up once: a thought already shown, or put away, does not come back.
  const [goneThoughts, setGoneThoughts] = useState<ReadonlySet<string>>(new Set());
  const thought = view.thought && !mute.closed && !goneThoughts.has(view.thought.id) ? view.thought : null;

  let kind: BubbleKind = 'speech';
  let main: ReactNode = null;
  let text = '';
  let time: string | undefined;
  let one: ReactNode = null;
  let stop: (() => void) | null = null;
  let away: CollapseTarget | null = null;
  let replyTo: SayReplyTo | undefined;
  let onMute: (() => void) | null = null;
  let onClose: (() => void) | null = null;
  let vote: ActsProps['vote'] = null;
  /** Her line from the reducer is what the bubble shows. */
  let line = false;
  /** A stack card the bubble shows: once put away it moves to native's history. */
  let card: string | null = null;
  if (due) {
    kind = 'remind';
    main = <Reminder card={due} />;
    text = due.title;
    time = formatClock(due.at);
    card = due.id;
    away = { key: `card:${due.id}`, text, ms: lingerMs(text) };
  } else if (hint) {
    kind = hint.variant === 'loading' ? 'error' : 'notice';
    main = hint.variant === 'voice'
      ? <VoiceHintStackCard card={hint} top={false} act={act} />
      : <AvatarLoadingStackCard card={hint} top={false} now={Date.now()} act={act} />;
    text = hint.title;
  } else if (cards.failed) {
    const f = cards.failed;
    kind = 'error';
    main = <p className={bubble.text}>{f.title}：{f.reason}</p>;
    text = `${f.title}：${f.reason}`;
    card = f.id;
    one = <Btn variant="text" size="sm" onClick={() => bridge.window.openMain(navRoute({ page: 'overview', sel: f.task_id }))}>看详情</Btn>;
    away = { key: `card:${f.id}`, text, ms: ERROR_MS };
  } else if (bar?.phase === 'error') {
    const { reason, next } = failOf(bar);
    kind = 'error';
    main = <p className={bubble.text}>{reason}</p>;
    text = bar.text;
    one = (
      <span className={bubble.acts}>
        {next && <Btn variant="ghost" size="sm" onClick={() => go(next.to)}>{next.label}</Btn>}
        <Btn variant="text" size="sm" onClick={() => openChat(bar.id)}>查看详情</Btn>
      </span>
    );
    onClose = () => dispatch({ type: 'close', id: bar.id });
    line = true;
  } else if (cards.done) {
    const d = cards.done;
    kind = 'done';
    main = <p className={bubble.text}>{d.title}</p>;
    text = d.title;
    time = '刚刚';
    card = d.id;
    one = <Btn variant="text" size="sm" onClick={() => bridge.window.openMain(navRoute(d.task_id ? { page: 'overview', sel: d.task_id } : { page: 'overview' }))}>打开</Btn>;
    away = { key: `card:${d.id}`, text, ms: lingerMs(text) };
  } else if (cards.look) {
    kind = 'notice';
    main = <p className={bubble.text} role="status" aria-label={cards.look.title}>{cards.look.title}</p>;
    text = cards.look.title;
    card = cards.look.id;
    away = { key: `card:${cards.look.id}`, text, ms: NOTICE_MS };
  } else if (bar?.phase === 'thinking') {
    main = <Speech bar={bar} name="" onOpen={() => openChat(bar.id)} />;
    stop = stopOf(bar);
    line = true;
  } else if (bar) {
    main = <Speech bar={bar} name="" onOpen={() => openChat(bar.id)} />;
    stop = stopOf(bar);
    line = true;
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
    if (bar.phase === 'linger') away = { key: `line:${bar.id}`, text: bar.text, ms: lingerMs(bar.text) };
  } else if (!bar && (thought || ritual || mute.mute?.phase === 'undo')) {
    main = <Thought thought={thought} ritual={ritual} mute={mute} composing={input.open != null} />;
    if (thought) {
      text = thought.text;
      replyTo = { kind: 'thought', id: thought.id };
      onMute = () => void mute.off();
      vote = voteOn(thought.id);
      onClose = () => {
        void feedback(thought.id, 'dismissed');
        setGoneThoughts((s) => new Set(s).add(thought.id));
      };
      away = { key: `thought:${thought.id}`, text: thought.text, ms: lingerMs(thought.text) };
    }
  }
  // A side session's answer shows under her line.
  if (line && side) {
    main = (
      <div className={bubble.main}>
        {main}
        <Speech bar={side} name="" onOpen={() => openChat(side.id)} go={go} />
      </div>
    );
  }

  const { collapsed: gone, timer } = useCollapse(docked || confirm ? null : away, still, hovered || input.open != null);
  // What went away stays away: a thought by its id, her line out of the reducer, a stack card in native's history.
  const awayKey = away?.key ?? null;
  useEffect(() => {
    if (!gone || awayKey == null) return;
    if (awayKey.startsWith('line:')) dispatch({ type: 'close', id: awayKey.slice('line:'.length) });
    if (card && !demoCards) void getBridge().stack.collapse(card).catch(() => {});
  }, [gone, awayKey, card, demoCards, dispatch]);

  const said = main != null && !gone;
  // The reminder is seen only where a body below draws `main`: in the input, or when no approval covers it and she is on screen.
  useSeenReceipt(dueIds, !demoCards && due != null && said && (input.open != null || (!confirm && !docked)));
  // A thought shown once, then replaced or put away, does not come back.
  const showingThought = said && !docked && !confirm && awayKey?.startsWith('thought:') ? awayKey.slice('thought:'.length) : null;
  const lastThought = useRef<string | null>(null);
  useEffect(() => {
    const was = lastThought.current;
    lastThought.current = showingThought;
    if (was != null && was !== showingThought) setGoneThoughts((g) => new Set(g).add(was));
  }, [showingThought]);
  const extra = notice != null || cards.dropError != null || input.error != null || (replyTo?.id != null && feedbackError === replyTo.id);
  const tail = docked ? null : tailOf(anchor);
  const room = anchor?.room.width ?? 0;
  const sizing = room > 0 ? ({ '--bubble-w': `${Math.max(160, Math.min(300, Math.floor(room) - 40))}px` } as CSSProperties) : undefined;
  const acts = replyTo || onClose ? (
    <Acts key={replyTo?.id ?? 'idle'} text={text} replyLabel="回复" onReply={() => input.reply(text, replyTo)} onMute={onMute} onClose={onClose} vote={vote} onStop={stop} />
  ) : stop ? <StopAct onStop={stop} /> : null;

  let body: ReactNode = null;
  if (input.open) {
    body = (
      <HeadBubble kind="speech" tail={tail}>
        {said && main}
        {input.error && <p className={bubble.err} role="alert">{input.error}</p>}
        <BubbleInput open={input.open} state={state} attachment={input.attachment} onDrop={input.drop} onClose={input.close} />
      </HeadBubble>
    );
  } else if (confirm) {
    // Docked, it shows under the subtitle bar.
    body = (
      <ConfirmCard key={confirm.id} card={confirm} more={waiting} tail={tail} note={decideNote?.text ?? null} act={(a) => {
        if (a.type === 'collapse') setUnfolded(0);
        act(a);
      }} onDetails={() => bridge.window.openMain(navRoute({ page: 'overview', sel: confirm.id, focus: `item-${confirm.id}` }))} />
    );
  } else if (!docked && (said || extra)) {
    body = (
      <HeadBubble kind={said ? kind : 'notice'} time={said ? time : undefined} tail={tail} acts={said ? acts : null} one={said ? one : null} timer={said ? timer : null}>
        {said && main}
        {notice && (
          <p key={notice.n} className={`${bubble.note} ${bubble.fade}`} role="status">
            {notice.text}
          </p>
        )}
        {replyTo?.id != null && feedbackError === replyTo.id && <p className={bubble.err} role="status">反馈发送失败，可以重试</p>}
        {cards.dropError && <p className={bubble.err} role="alert">{cards.dropError}</p>}
        {input.error && <p className={bubble.err} role="alert">{input.error}</p>}
      </HeadBubble>
    );
  }

  // A gap between two things to say (a line closed, the next not yet in) keeps the last card instead of unmounting it.
  const last = useRef<ReactNode>(null);
  const [, setLeft] = useState(0);
  if (body) last.current = body;
  const leaving = !body && last.current != null;
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => {
      last.current = null;
      setLeft((n) => n + 1);
    }, LEAVE_MS);
    return () => clearTimeout(t);
  }, [leaving]);
  const shown = body ?? last.current;

  return (
    <div ref={rootRef} className={styles.root} style={sizing} data-surface-root="bubble" data-side={anchor?.side} data-docked={anchor?.docked ?? undefined}>
      {docked && bar && (
        <div className={styles.sub} data-glass="">
          <Subtitle bar={bar} name={state?.character?.name ?? ''} onOpen={() => openChat(bar.id)} go={go} onStop={stopOf(bar)} />
          {side && <Subtitle bar={side} name="" onOpen={() => openChat(side.id)} go={go} />}
        </div>
      )}
      {shown && (
        <div ref={hoverRef} {...handlers} className={leaving ? styles.leaving : undefined} inert={leaving} aria-hidden={leaving || undefined}>
          {shown}
        </div>
      )}
    </div>
  );
}
