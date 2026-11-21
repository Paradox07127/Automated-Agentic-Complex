import { useState } from 'react';
import type { Fact } from '../../domain';
import { Btn, SecHead, SRow } from '../../ui';
import { EvidenceView, SrcTag } from './bits';
import { groupLabel } from './model';
import m from './Memory.module.css';
import styles from './Asks.module.css';

export interface AsksProps {
  asks: Fact[];
  now: number;
  /** Each resolves true when agentd took it. */
  onConfirm: (f: Fact) => Promise<boolean>;
  onFix: (f: Fact, text: string) => Promise<boolean>;
  onDeny: (f: Fact) => Promise<boolean>;
  /** 停止此类推断; absent while agentd has no such switch. */
  onNever?: (f: Fact) => void;
  onJump: (k: 'chat' | 'obs') => void;
  still: boolean;
}

/** 待确认：有推断时默认展开，每条推断一行只读行（推断、来源、出处，右边 确认 / 修改 / 否认）；可收起成一行计数。 */
export function Asks({ asks, now, onConfirm, onFix, onDeny, onNever, onJump, still }: AsksProps) {
  const [edit, setEdit] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(asks.length <= 8);
  const leave = (f: Fact, write: () => Promise<boolean>) => {
    setLeaving((s) => new Set(s).add(f.id));
    void write().then((ok) => {
      if (ok) setEdit(null);
      // The row waits for its slide-out before the reread drops it; a refusal brings it back.
      setTimeout(() => setLeaving((s) => (s.delete(f.id) ? new Set(s) : s)), ok && !still ? 190 : 0);
    });
  };
  if (asks.length === 0) {
    return (
      <section className={styles.none} aria-label="待确认">
        <span className={styles.title}>待确认</span>
        <span>没有待确认的推断</span>
        <span className={m.cap}>角色推断出影响行为的事项时，先放在这里等待确认</span>
      </section>
    );
  }
  return (
    <section aria-label="待确认">
      <SecHead title="待确认" count={asks.length} tone="waiting" collapsed={!open} onToggle={() => setOpen(!open)} />
      {open && (
        <div className={styles.rows}>
          {asks.map((a) => (
            <section key={a.id} className={styles.card} data-leaving={leaving.has(a.id) || undefined} aria-label={`待确认：${a.text}`} data-selectable="">
              <SRow
                id={`ask-${a.id}`}
                title={a.text}
                desc={
                  <span className={styles.head}>
                    <SrcTag src={a.source} />
                    <span className={styles.kind}>{groupLabel(a)}</span>
                  </span>
                }
                control={
                  edit === a.id ? (
                    <>
                      <Btn size="sm" variant="ring" tail="check" disabled={!draft.trim()} disabledReason="内容不能为空" onClick={() => leave(a, () => onFix(a, draft.trim()))}>
                        保存
                      </Btn>
                      <Btn size="sm" variant="text" onClick={() => setEdit(null)}>
                        取消
                      </Btn>
                    </>
                  ) : (
                    <>
                      <Btn size="sm" variant="ring" tail="check" onClick={() => leave(a, () => onConfirm(a))}>
                        记住
                      </Btn>
                      <Btn
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEdit(a.id);
                          setDraft(a.text);
                        }}
                      >
                        修改
                      </Btn>
                      <Btn size="sm" variant="ghost" onClick={() => leave(a, () => onDeny(a))}>
                        不是这样
                      </Btn>
                    </>
                  )
                }
              >
                {edit === a.id && <textarea className={styles.textarea} rows={2} maxLength={500} value={draft} aria-label="修改为" autoFocus onChange={(e) => setDraft(e.target.value)} />}
                <div className={styles.foot}>
                  <EvidenceView fact={a} now={now} onJump={onJump} />
                  {onNever && edit !== a.id && (
                    <button type="button" className={m.lnk} onClick={() => onNever(a)}>
                      停止此类推断
                    </button>
                  )}
                </div>
              </SRow>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
