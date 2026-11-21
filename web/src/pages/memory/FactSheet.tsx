import { Fragment, useId, useRef, useState } from 'react';
import type { Fact } from '../../domain';
import { Btn, IconBtn, OverlayPortal, useOverlayFocus } from '../../ui';
import { EvidenceView, SrcTag } from './bits';
import { agoText, daysAgo, factText, groupLabel, hm, isDormant, md, sum, updText, useSpark } from './model';
import m from './Memory.module.css';
import styles from './FactSheet.module.css';

export interface Version {
  text: string;
  when: string;
  by: string;
}

export interface FactSheetProps {
  fact: Fact;
  now: number;
  onClose: () => void;
  onSave: (f: Fact, text: string) => Promise<boolean>;
  onDelete: (f: Fact) => void;
  onJump: (k: 'chat' | 'obs') => void;
  /** Preview (versions, lock, 不再提及); absent while agentd has neither. */
  preview?: { versions: Version[] | undefined; locked: boolean; quiet: boolean; onQuiet: (on: boolean) => void; onRestore: (v: Version) => void };
}

/** 引用记录：14 天刻度尺，每次引用一根竖刻度，同一天多次合并成计数签；今天是强调色细竖线。 */
function UseAxis({ spark, now }: { spark: number[]; now: number }) {
  const P = (i: number) => ((i + 0.5) / 14) * 100;
  const day = (i: number) => now - (13 - i) * 86_400_000;
  return (
    <div className={styles.axis} role="img" aria-label={`近 14 天引用 ${sum(spark)} 次`}>
      <div className={styles.track}>
        {spark.map(
          (n, i) =>
            n > 0 && (
              <Fragment key={i}>
                <i className={styles.ev} style={{ left: `${P(i)}%` }} />
                {n > 1 && (
                  <b className="num" style={{ left: `${P(i)}%` }}>
                    {n}
                  </b>
                )}
              </Fragment>
            ),
        )}
        <span className={styles.nowLine} style={{ left: `${P(13)}%` }} />
      </div>
      <div className={styles.ruler} aria-hidden="true">
        {spark.map((_, i) => (
          <i key={i} data-long={i % 7 === 0 || i === 13 || undefined} style={{ left: `${P(i)}%` }} />
        ))}
        <span className="num" style={{ left: `${P(0)}%` }}>
          {md(day(0))}
        </span>
        <span className="num" style={{ left: `${P(7)}%` }}>
          {md(day(7))}
        </span>
        <span data-end="" style={{ left: `${P(13)}%` }}>
          今天
        </span>
      </div>
    </div>
  );
}

/** 记忆详情（右侧抽屉）：出处、引用记录、版本历史；底部 修改 / 删除。 */
export function FactSheet({ fact: f, now, onClose, onSave, onDelete, onJump, preview }: FactSheetProps) {
  const panel = useRef<HTMLElement>(null);
  const titleId = useId();
  const trap = useOverlayFocus(panel, onClose);
  const [draft, setDraft] = useState<string | null>(null);
  const spark = useSpark(f, now);
  const idle = daysAgo(f.last_used_at ?? f.recorded_at, now);
  const versions = preview?.versions ?? null;
  return (
    <OverlayPortal>
      <div
        className={styles.scrim}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <aside ref={panel} role="dialog" aria-modal="true" aria-label="记忆详情" aria-describedby={titleId} tabIndex={-1} className={styles.panel} onKeyDown={trap}>
          <header className={styles.head} data-part="head">
            <div className={styles.headText}>
              <h2 id={titleId} data-selectable="">
                {factText(f)}
              </h2>
              <div className={styles.sub}>
                <SrcTag src={f.source} full />
                <span className={m.cap}>
                  {groupLabel(f)} │ {updText(daysAgo(f.recorded_at, now))}
                </span>
                {preview?.locked && <span className={m.lock}>已锁定</span>}
                {preview?.quiet && <span className={m.quiet}>不再提及</span>}
              </div>
            </div>
            <IconBtn icon="close" label="关闭" onClick={onClose} />
          </header>
          <div className={styles.body}>
            {draft != null && (
              <section className={styles.sec}>
                <div className={styles.eb}>修改为</div>
                <textarea className={styles.textarea} rows={3} maxLength={500} value={draft} aria-label="修改这条记忆" onChange={(e) => setDraft(e.target.value)} />
              </section>
            )}
            <section className={styles.sec}>
              <div className={styles.eb}>出处</div>
              <EvidenceView fact={f} now={now} onJump={onJump} />
            </section>
            <section className={styles.sec}>
              <div className={styles.eb}>
                引用记录
                <span className={m.cap}>
                  近 14 天 <span className={`${m.t1} num`}>{sum(spark)}</span> 次
                </span>
              </div>
              <UseAxis spark={spark} now={now} />
              {isDormant(f) ? (
                <p className={m.cap}>
                  已 <span className="num">{idle}</span> 天未引用，处于休眠
                </p>
              ) : f.uses.length === 0 ? (
                <p className={m.cap}>尚未引用</p>
              ) : (
                <div className={styles.uses}>
                  {f.uses.slice(0, 3).map((u) => (
                    <div key={`${u.line_id}-${u.at}`}>
                      <span className={`${m.cap} num`}>
                        {agoText(u.days_ago)}
                        {u.days_ago === 0 ? ` ${hm(u.at)}` : ''}
                      </span>
                      <span>对话 │ {u.how === 'injected' ? '带入' : '提及'}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
            {versions && (
              <section className={styles.sec}>
                <div className={styles.eb}>版本历史</div>
                {versions
                  .map((v, i) => ({ v, i, cur: i === versions.length - 1 }))
                  .reverse()
                  .map(({ v, i, cur }) => (
                    <div key={i} className={styles.ver} data-cur={cur || undefined}>
                      <span className={`${styles.vn} num`}>v{i + 1}</span>
                      <div>
                        <div className={styles.vt}>{v.text}</div>
                        <div className={m.cap}>
                          <span className="num">{v.when}</span> │ {v.by}
                        </div>
                      </div>
                      {cur ? (
                        <span className={m.cap}>当前</span>
                      ) : (
                        <button type="button" className={m.lnk} onClick={() => preview?.onRestore(v)}>
                          恢复
                        </button>
                      )}
                    </div>
                  ))}
              </section>
            )}
          </div>
          <footer className={styles.foot}>
            {draft != null ? (
              <>
                <Btn
                  size="sm"
                  variant="ghost"
                  icon="check"
                  disabled={!draft.trim()}
                  disabledReason="内容不能为空"
                  onClick={() =>
                    void onSave(f, draft.trim()).then((ok) => {
                      if (ok) setDraft(null);
                    })
                  }
                >
                  保存
                </Btn>
                <Btn size="sm" variant="text" onClick={() => setDraft(null)}>
                  取消
                </Btn>
              </>
            ) : (
              <>
                <Btn size="sm" variant="ghost" onClick={() => setDraft(f.text)}>
                  修改
                </Btn>
                {preview && (
                  <Btn size="sm" variant="ghost" onClick={() => preview.onQuiet(!preview.quiet)}>
                    {preview.quiet ? '恢复提及' : '不再提及'}
                  </Btn>
                )}
              </>
            )}
            <span className={m.sp} />
            <button type="button" className={styles.danger} onClick={() => onDelete(f)}>
              删除
            </button>
          </footer>
        </aside>
      </div>
    </OverlayPortal>
  );
}
