import { useContext, useState, type FormEvent, type KeyboardEvent } from 'react';
import { CountdownLine, CountdownRing } from '../../charts';
import { formatDuration, formatRemaining, type Question, type QuestionItem } from '../../domain';
import { Btn, OptionRow } from '../../ui';
import { DecisionBar } from './DecisionBar';
import { InSession } from './inSession';
import { useCountdown } from './useCountdown';
import { WaitMeter } from './WaitMeter';
import styles from './QuestionBox.module.css';

/** 提问卡：每道题一组选项行 + 自由文本，1–3 题；每题选项或文字任一非空才能提交；没有期限时写「不限时 · 等了 N 分钟」；主窗口里提交和取消在「等你决定」条里，桌面紧凑版是一行小按钮；会话卡里（InSession）是题目、选项小按钮（只有一题时点了就发送）和一行输入加「发送」。 */
export interface QuestionBoxProps {
  /** 提问数据 */
  question: Question;
  /** 当前时间，算已等待时长 */
  now: number;
  /** 桌面紧凑版：放在白纸卡里，题目由外层卡片头显示 */
  compact?: boolean;
  /** 第一题已选选项 */
  selected?: string | null;
  /** 第一题自由文本 */
  text?: string;
  /** 第一题选择或输入 */
  onChange?: (next: { selected: string | null; text: string }) => void;
  /** 提交：每个题目 id 对应 1–2 条回答（选项、文字） */
  onAnswer?: (answers: Record<string, string[]>) => void;
  /** 取消请求 */
  onCancel?: () => void;
  /** 同屏已有别的黄色主按钮（如对话页的发送）：提交回答降为 secondary */
  secondaryEmphasis?: boolean;
}

type Draft = { selected: string | null; text: string };

const answerOf = (d: Draft | undefined): string[] => [d?.selected ?? '', d?.text.trim() ?? ''].filter((x) => x.length > 0);

export function QuestionBox({ question, now, compact, selected = null, text = '', onChange, onAnswer, onCancel, secondaryEmphasis }: QuestionBoxProps) {
  const items: QuestionItem[] = question.questions.length > 0 ? question.questions : [{ id: '', question: question.title, options: question.options.map((label) => ({ label })) }];
  const firstId = items[0]?.id ?? '';
  const [drafts, setDrafts] = useState<Record<string, Draft>>({ [firstId]: { selected, text } });
  const [from, setFrom] = useState({ selected, text });
  if (from.selected !== selected || from.text !== text) {
    setFrom({ selected, text });
    setDrafts((d) => ({ ...d, [firstId]: { selected, text } }));
  }
  const left = useCountdown(question.seconds_left, !question.resolved);
  const inSession = useContext(InSession);
  const canSubmit = items.every((q) => answerOf(drafts[q.id]).length > 0);

  const update = (qid: string, next: Draft) => {
    setDrafts((d) => ({ ...d, [qid]: next }));
    if (qid === firstId) onChange?.(next);
  };
  const send = (all: Record<string, Draft | undefined>) => {
    onAnswer?.(Object.fromEntries(items.map((q) => [q.id, answerOf(all[q.id])])));
  };
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (canSubmit) send(drafts);
  };
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  if (inSession) {
    const one = items.length === 1;
    const windowS = question.expires_at == null ? null : (question.expires_at - question.since) / 1000;
    return (
      <form data-stub="QuestionBox" data-session="" className={styles.session} aria-label={question.title} onSubmit={submit}>
        <div className={styles.sTop}>
          <CountdownLine secondsLeft={left} windowS={windowS} />
        </div>
        {question.resolved ? (
          <p className={styles.sDone} role="status">
            ✓ 已回答
          </p>
        ) : (
          <>
            {items.map((q, i) => {
              const d = drafts[q.id] ?? { selected: null, text: '' };
              return (
                <div key={q.id} className={styles.sItem}>
                  <p className={styles.sAsk}>
                    <span>{q.question}</span>
                    {i === 0 && <span className={`${styles.sTime} num`}>{question.seconds_left == null ? `不限时 │ 等了 ${formatDuration(Math.max(0, now - question.since))}` : formatRemaining(left)}</span>}
                  </p>
                  <div className={styles.sOpts} role="group" aria-label={one ? '选项' : `选项：${q.question}`}>
                    {q.options.map((o) => (
                      <button
                        key={o.label}
                        type="button"
                        className={styles.sOpt}
                        title={o.description}
                        aria-pressed={one ? undefined : o.label === d.selected}
                        onClick={() => {
                          const next = { selected: one || o.label !== d.selected ? o.label : null, text: one ? '' : d.text };
                          if (one) send({ [q.id]: next });
                          else update(q.id, next);
                        }}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                  {!one && <input className={styles.sInput} aria-label={`写下回答：${q.question}`} placeholder="或者直接写回答" value={d.text} onChange={(e) => update(q.id, { selected: d.selected, text: e.target.value })} />}
                </div>
              );
            })}
            <div className={styles.sFoot}>
              {one && (
                <input
                  className={styles.sInput}
                  aria-label="写下回答"
                  placeholder="或者直接写回答（⏎ 发送）"
                  value={drafts[firstId]?.text ?? ''}
                  onChange={(e) => update(firstId, { selected: null, text: e.target.value })}
                  onKeyDown={onKey}
                />
              )}
              {onCancel && (
                <Btn variant="text" size="sm" onClick={onCancel}>
                  取消
                </Btn>
              )}
              <Btn variant={secondaryEmphasis ? 'secondary' : 'primary'} size="sm" disabled={!canSubmit} disabledReason="选一个选项或写下回答" onClick={() => submit()}>
                发送
              </Btn>
            </div>
          </>
        )}
      </form>
    );
  }

  return (
    <form data-stub="QuestionBox" className={styles.root} data-compact={compact || undefined} aria-label={question.title} onSubmit={submit}>
      <div className={styles.head}>
        {!compact && <h3 className={styles.title}>{question.title}</h3>}
        <span className={styles.time}>
          {question.seconds_left == null ? <span>不限时 │</span> : <CountdownRing secondsLeft={left} windowS={null} size="mini" onPaper={compact} />}
          <WaitMeter since={question.since} now={now} onPaper={compact} />
        </span>
      </div>
      <p className={styles.source}>{question.source}</p>
      {question.resolved ? (
        <p className={styles.done} role="status">
          ✓ 已回答
        </p>
      ) : (
        <>
          {items.map((q, i) => {
            const d = drafts[q.id] ?? { selected: null, text: '' };
            return (
              <div key={q.id} className={styles.item}>
                {i > 0 && <h4 className={styles.title}>{q.question}</h4>}
                <div className={styles.options} role="listbox" aria-label={items.length > 1 ? `选项：${q.question}` : '选项'}>
                  {q.options.map((o) => (
                    <OptionRow key={o.label} label={o.description ? `${o.label} │ ${o.description}` : o.label} size={compact ? 'desk' : 'main'} selected={o.label === d.selected} onClick={() => update(q.id, { selected: o.label === d.selected ? null : o.label, text: d.text })} />
                  ))}
                </div>
                <textarea
                  className={styles.input}
                  rows={compact ? 1 : 2}
                  aria-label={items.length > 1 ? `写下回答：${q.question}` : '写下回答'}
                  placeholder="或者直接写你的回答…（⏎ 提交，⇧⏎ 换行）"
                  value={d.text}
                  onChange={(e) => update(q.id, { selected: d.selected, text: e.target.value })}
                  onKeyDown={onKey}
                />
              </div>
            );
          })}
          {compact ? (
            // On the paper desk card the outer card already says what it waits for; keep one row of small buttons.
            <div className={styles.foot}>
              <Btn variant="primary" size="sm" disabled={!canSubmit} disabledReason="选一个选项或写下回答" onClick={() => submit()}>
                提交回答
              </Btn>
              {onCancel && (
                <Btn variant="text" size="sm" onClick={onCancel}>
                  取消请求
                </Btn>
              )}
            </div>
          ) : (
            <DecisionBar
              inset
              secondaryEmphasis={secondaryEmphasis}
              kind="question"
              primary={{ label: '提交回答', disabled: !canSubmit, disabledReason: '选一个选项或写下回答', onClick: () => submit() }}
              secondary={onCancel ? [{ label: '取消请求', onClick: onCancel }] : []}
            />
          )}
        </>
      )}
    </form>
  );
}
