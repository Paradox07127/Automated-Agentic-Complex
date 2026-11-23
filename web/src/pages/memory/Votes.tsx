import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Fact } from '../../domain';
import { toast } from '../../shell/toast';
import { Btn, Fold, InfoTip, SecHead, TextArea } from '../../ui';
import { useEvidence, type Evidence } from './data';
import { catLabel, SRC, stamp } from './model';
import { Glyph, Lnk } from './parts';
import styles from './Votes.module.css';

type How = 'keep' | 'fix' | 'no';
/** A decided card stays on screen with its result: `wait` while the write (or the undo window) runs, then `leave`. */
interface Held {
  fact: Fact;
  how: How;
  phase: 'wait' | 'leave';
}

/** The result bar shows this long before the card slides out (sns_voteresult_in, then the leave). */
const SHOW_MS = 900;
const LEAVE_MS = 260;
/** 不是这样 writes a tombstone and drops the text (memory.py reject); the toast's 撤销 holds it back this long. */
export const UNDO_MS = 4000;

export interface VotesProps {
  asks: Fact[];
  now: number;
  still: boolean;
  /** Each resolves true when agentd took it. */
  onConfirm: (f: Fact) => Promise<boolean>;
  onFix: (f: Fact, text: string) => Promise<boolean>;
  onDeny: (f: Fact) => Promise<boolean>;
  onJump: (k: 'chat' | 'obs') => void;
}

/** 待确认：SNS 投票卡（白纸），出处收在卡内折叠里，「对，记住 / 差不多，我来改 / 不是这样」，键 1 2 3 处理第一张；选完卡上是 [已选] 和结果条，然后滑出。 */
export function Votes({ asks, now, still, onConfirm, onFix, onDeny, onJump }: VotesProps) {
  const [held, setHeld] = useState<ReadonlyMap<string, Held>>(new Map());
  const [editing, setEditing] = useState<Record<string, string>>({});
  // First-seen order, so a confirmed card keeps its place after the reread drops it from `asks`.
  const order = useRef(new Map<string, number>());
  for (const a of asks) if (!order.current.has(a.id)) order.current.set(a.id, order.current.size);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const denies = useRef(new Map<string, () => void>());

  const put = (id: string, h: Held | null) =>
    setHeld((m) => {
      const n = new Map(m);
      if (h) n.set(id, h);
      else n.delete(id);
      return n;
    });
  const later = (id: string, ms: number, run: () => void) => {
    clearTimeout(timers.current.get(id));
    if (still || ms === 0) return run();
    timers.current.set(id, setTimeout(run, ms));
  };
  const leave = (f: Fact, how: How) =>
    later(f.id, SHOW_MS, () => {
      put(f.id, { fact: f, how, phase: 'leave' });
      later(f.id, LEAVE_MS, () => put(f.id, null));
    });

  const decide = (f: Fact, how: How, text?: string) => {
    if (held.has(f.id)) return;
    if (how === 'no') {
      put(f.id, { fact: f, how, phase: 'wait' });
      const commit = () => {
        denies.current.delete(f.id);
        void onDeny(f).then((ok) => (ok ? leave(f, how) : put(f.id, null)));
      };
      denies.current.set(f.id, commit);
      timers.current.set(f.id, setTimeout(commit, UNDO_MS));
      toast('划掉了，不会再记这件事', {
        action: {
          label: '撤销',
          onClick: () => {
            clearTimeout(timers.current.get(f.id));
            denies.current.delete(f.id);
            put(f.id, null);
            toast('撤销了，这条还在待确认里');
          },
        },
      });
      return;
    }
    put(f.id, { fact: f, how, phase: 'wait' });
    setEditing(({ [f.id]: _, ...rest }) => rest);
    void (how === 'fix' && text != null ? onFix(f, text) : onConfirm(f)).then((ok) => (ok ? leave(f, how) : put(f.id, null)));
  };

  // Leaving the page within the undo window still sends the 不是这样 the user chose.
  useEffect(() => {
    const ts = timers.current;
    const ds = denies.current;
    return () => {
      for (const t of ts.values()) clearTimeout(t);
      for (const run of ds.values()) run();
    };
  }, []);

  const cards = [...asks, ...[...held.values()].map((h) => h.fact).filter((f) => !asks.some((a) => a.id === f.id))].sort(
    (a, b) => (order.current.get(a.id) ?? 0) - (order.current.get(b.id) ?? 0),
  );
  const open = cards.filter((f) => !held.has(f.id) && editing[f.id] == null);

  // 1 / 2 / 3 decide the first open card.
  const first = useRef<Fact | null>(null);
  first.current = open[0] ?? null;
  const act = useRef(decide);
  act.current = decide;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || !/^[123]$/.test(e.key)) return;
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest('input, textarea, select, [contenteditable], [role="dialog"]')) return;
      const f = first.current;
      if (!f) return;
      e.preventDefault();
      if (e.key === '2') setEditing((x) => ({ ...x, [f.id]: f.text }));
      else act.current(f, e.key === '1' ? 'keep' : 'no');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <section className={styles.votes} aria-label="待确认">
      <SecHead
        title="待确认"
        right={
          <>
            <InfoTip>猜的和看到的先放在这里；你点「记住」之前不会拿来用。</InfoTip>
            <Btn
              variant="primary"
              disabled={open.length === 0}
              disabledReason="没有剩下要确认的"
              onClick={() => {
                for (const f of open) decide(f, 'keep');
              }}
            >
              剩下 {open.length} 条全部记住
            </Btn>
          </>
        }
      />
      <div className={styles.grid}>
        {cards.map((f, i) => (
          <Card
            key={f.id}
            fact={f}
            i={i}
            now={now}
            held={held.get(f.id) ?? null}
            draft={editing[f.id] ?? null}
            onDraft={(t) => setEditing((x) => (t == null ? (({ [f.id]: _, ...rest }) => rest)(x) : { ...x, [f.id]: t }))}
            onDecide={(how, text) => decide(f, how, text)}
            onJump={onJump}
          />
        ))}
      </div>
    </section>
  );
}

const RESULT: Record<How, string> = { keep: '记住', fix: '改过后记住', no: '不是这样' };

interface CardProps {
  fact: Fact;
  i: number;
  now: number;
  held: Held | null;
  draft: string | null;
  onDraft: (t: string | null) => void;
  onDecide: (how: How, text?: string) => void;
  onJump: (k: 'chat' | 'obs') => void;
}

function Card({ fact: f, i, now, held, draft, onDraft, onDecide, onJump }: CardProps) {
  const { ev } = useEvidence(f, now);
  return (
    <section className={styles.vote} data-theme="light" data-leaving={held?.phase === 'leave' || undefined} data-ask={f.id} style={{ '--i': i } as CSSProperties} aria-label={`待确认：${f.text}`}>
      <div className={styles.vt}>
        <Glyph name="vote" />
        <b>记下了，对吗？</b>
        <span>
          {catLabel(f)} │ {SRC[f.source].full}
        </span>
        <span className={styles.sp} />
        <span className="num">{stamp(f.recorded_at, now)}</span>
      </div>
      <h3>{f.text}</h3>
      <Source ev={ev} onJump={onJump} />
      {held ? (
        <div className={styles.vres} data-no={held.how === 'no' || undefined} role="status">
          <span>[已选]&nbsp; {RESULT[held.how]}</span>
          <div className={styles.bar}>
            <i />
          </div>
        </div>
      ) : draft != null ? (
        <>
          <TextArea
            label="改成"
            value={draft}
            maxLength={500}
            rows={2}
            autoFocus
            onChange={onDraft}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                onDraft(null);
              }
            }}
          />
          <div className={styles.row2}>
            <Btn variant="secondary" onClick={() => onDraft(null)}>
              取消
            </Btn>
            <Btn icon="check" disabled={!draft.trim()} disabledReason="内容不能为空" onClick={() => onDecide('fix', draft.trim())}>
              改好并记住
            </Btn>
          </div>
        </>
      ) : (
        <div className={styles.opts} role="group" aria-label="怎么处理">
          <Btn variant="secondary" tail="check" onClick={() => onDecide('keep')}>
            对，记住
          </Btn>
          <Btn variant="secondary" onClick={() => onDraft(f.text)}>
            差不多，我来改
          </Btn>
          <Btn onClick={() => onDecide('no')}>不是这样</Btn>
        </div>
      )}
    </section>
  );
}

/** 出处, folded inside the card: closed, the kind and the time; open, the line she read or what she saw, and the jump to it. */
function Source({ ev, onJump }: { ev: Evidence | null; onJump: (k: 'chat' | 'obs') => void }) {
  if (!ev)
    return (
      <Fold label="出处" rows={1}>
        <span className={styles.src}>没有出处，是外接工具写来的</span>
      </Fold>
    );
  const chat = ev.k === 'chat';
  return (
    <Fold label="出处" summary={`${chat ? '对话' : '观察'} │ ${ev.when}`}>
      <span className={styles.src}>{chat ? (ev.quote ? `「${ev.quote}」` : '原句只保留 48 小时，这一段已经清理') : `角色看到：${ev.title ?? '一段观察'}`}</span>
      <span className={styles.srcm}>
        {chat && '对话 │ '}
        <span className="num">{ev.when}</span>
        <Lnk onClick={() => onJump(ev.k)}>{chat ? '去对话看原文 ›' : '在简报里看这一段 ›'}</Lnk>
      </span>
    </Fold>
  );
}
