import { useRef, useState, type ReactNode } from 'react';
import type { Fact } from '../../domain';
import { Btn, Menu, Pill, TextArea } from '../../ui';
import { useEvidence } from './data';
import { BY, catOf, CATS, factText, hm, howText, isDormant, recentText, SRC, stamp, sum, useSpark, ymd } from './model';
import { Block, DetailHead, Kv, Lnk, PANEL, Quote, SrcMark } from './parts';
import { useVersions } from './useFacts';
import styles from './Detail.module.css';

const DAY_MS = 86_400_000;

/** 她用到它: a 14-day ruler, one tick per day with uses (a count when more than one), today a yellow line. */
function UseAxis({ spark, now }: { spark: number[]; now: number }) {
  const at = (i: number) => `${((i + 0.5) / 14) * 100}%`;
  const day = (i: number) => new Date(now - (13 - i) * DAY_MS);
  const label = (d: Date) => `${d.getMonth() + 1}.${d.getDate()}`;
  return (
    <div className={styles.ax} role="img" aria-label={`近 14 天用到 ${sum(spark)} 次`}>
      <div className={styles.trk} />
      {spark.map((n, i) =>
        n > 0 ? (
          <i key={i} className={styles.tick} style={{ left: at(i) }}>
            {n > 1 && <b className="num">{n}</b>}
          </i>
        ) : null,
      )}
      <i className={styles.now} style={{ left: at(13) }} />
      <div className={styles.rl} aria-hidden="true">
        <span className="num" style={{ left: at(0) }}>
          {label(day(0))}
        </span>
        <span className="num" style={{ left: at(7) }}>
          {label(day(7))}
        </span>
        <span style={{ left: at(13) }}>今天</span>
      </div>
    </div>
  );
}

/** 出处: the chat line it was read from, or the episode she saw; nothing at all means the user added it here. */
export function Source({ fact, now, onJump }: { fact: Fact; now: number; onJump: (k: 'chat' | 'obs') => void }) {
  const { ev } = useEvidence(fact, now);
  if (!ev) return <Quote>由手动添加，或由外部工具写入（无关联对话或观察记录）</Quote>;
  if (ev.k === 'chat')
    return (
      <Quote
        meta={
          <>
            对话 │ <span className="num">{ev.when}</span>
            <Lnk onClick={() => onJump('chat')}>查看对话原文 ›</Lnk>
          </>
        }
      >
        {ev.quote ? `「${ev.quote}」` : '原文仅保留 48 小时，该片段已过期清理'}
      </Quote>
    );
  return (
    <Quote
      meta={
        <>
          <span className="num">{ev.when}</span>
          <Lnk onClick={() => onJump('obs')}>在简报中查看此段 ›</Lnk>
        </>
      }
    >
      观察摘要：{ev.title ?? '屏幕观察片段'}
      {ev.quote && <span className={styles.apps}>{ev.quote}</span>}
    </Quote>
  );
}

/** A detail panel: title bar, a scrolling body and a foot bar; the projects and review details use it as well. */
export function Frame({ head, foot, children, id }: { head: ReactNode; foot?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <div className={`${PANEL} ${styles.det}`} data-theme="dark" data-detail={id}>
      {head}
      <div className={styles.body}>{children}</div>
      {foot != null && <div className={styles.foot}>{foot}</div>}
    </div>
  );
}

/** A line of text in a detail body. */
export const Text = ({ children }: { children: ReactNode }) => <p className={styles.text}>{children}</p>;
/** A short grey note in a detail body or foot. */
export const Note = ({ children }: { children: ReactNode }) => <span className={styles.note}>{children}</span>;
/** One dated line in a detail list (a use, a session): date, what, an optional jump. */
export const Line = ({ at, children, end }: { at: string; children: ReactNode; end?: ReactNode }) => (
  <div className={styles.use}>
    <span className="num">{at}</span>
    <span>{children}</span>
    {end}
  </div>
);
export const Lines = ({ children }: { children: ReactNode }) => <div className={styles.uses}>{children}</div>;
export const Spacer = () => <span className={styles.sp} />;

export interface DetailProps {
  fact: Fact;
  now: number;
  editing: boolean;
  onEdit: (on: boolean) => void;
  /** Writes text over `from`, the version the edit started from; resolves true when agentd took it. */
  onSave: (text: string, from: Fact) => Promise<boolean>;
  onDelete: () => void;
  onMark: (mark: 'locked' | 'quiet', on: boolean) => void;
  onJump: (k: 'chat' | 'obs') => void;
  /** The drawer's close button; absent in the wide column. */
  onClose?: () => void;
}

/** 这条记忆：标题条、正文（修改时是文本框）、来源和记下时间、出处、她用到它、版本历史；底部修改、锁定和不再提及、危险红删除。 */
export function Detail({ fact: f, now, editing, onEdit, onSave, onDelete, onMark, onJump, onClose }: DetailProps) {
  const [draft, setDraft] = useState(f.text);
  // The version the edit started from: a newer one read meanwhile is not silently written over.
  const [base, setBase] = useState(f);
  const [saving, setSaving] = useState(false);
  // Each edit starts from the stored text, also when Enter on the list opened it.
  const [was, setWas] = useState(editing);
  if (was !== editing) {
    setWas(editing);
    if (editing) {
      setDraft(f.text);
      setBase(f);
    }
  }
  const typed = useRef(draft);
  typed.current = draft;
  const cat = CATS.find((c) => c.id === catOf(f));
  const spark = useSpark(f, now);
  const versions = useVersions(f).data;
  const save = () => {
    const sent = draft;
    const text = sent.trim();
    if (!text || saving) return;
    setSaving(true);
    void onSave(text, base).then((ok) => {
      setSaving(false);
      if (!ok) return;
      // Text typed while the save ran stays in the editor, now over the version just written.
      if (typed.current === sent) onEdit(false);
      else setBase({ ...base, text, version: base.version + 1 });
    });
  };
  const reload = () => {
    setDraft(f.text);
    setBase(f);
  };
  const foot = (
    <>
      {editing ? (
        <>
          <Btn size="md" variant="secondary" onClick={() => onEdit(false)}>
            取消
          </Btn>
          <Btn size="md" icon="check" loading={saving} disabled={!draft.trim()} disabledReason="内容不能为空" onClick={save}>
            保存
          </Btn>
          <Note>Enter 保存 │ Esc 取消</Note>
        </>
      ) : (
        <>
          <Btn size="md" onClick={() => onEdit(true)}>
            修改
          </Btn>
          <Menu
            label="更多"
            icon="more"
            items={[
              { kind: 'item', label: f.locked ? '解锁' : '锁定', onSelect: () => onMark('locked', !f.locked) },
              { kind: 'item', label: f.quiet ? '恢复提及' : '不再提及', onSelect: () => onMark('quiet', !f.quiet) },
            ]}
          />
        </>
      )}
      <Spacer />
      <Btn variant="danger" onClick={onDelete}>
        删除
      </Btn>
    </>
  );
  return (
    <Frame id={f.id} head={<DetailHead title={cat?.label ?? ''} micro={`${cat?.en ?? ''} / ${f.id.slice(0, 6)}`} {...(onClose ? { onClose } : {})} />} foot={foot}>
        {editing && base.version !== f.version && (
          <Note>
            已在其他位置更新为「{factText(f)}」 <Lnk onClick={reload}>载入最新版本</Lnk>
          </Note>
        )}
        {editing ? (
          <TextArea
            label="编辑此条记忆"
            value={draft}
            maxLength={500}
            rows={3}
            autoFocus
            onChange={setDraft}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                save();
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                onEdit(false);
              }
            }}
          />
        ) : (
          <p className={styles.big} data-selectable="">
            {factText(f)}
          </p>
        )}
        {(isDormant(f) || f.locked || f.quiet) && (
          <div className={styles.tags}>
            {f.locked && <Pill tone="mission">已锁定</Pill>}
            {f.quiet && <Pill tone="mission">不再提及</Pill>}
            {isDormant(f) && <Pill dashed>30 天未使用</Pill>}
          </div>
        )}
        <div className={styles.kv}>
          <Kv k="来源">
            <SrcMark src={f.source} />
            {SRC[f.source].full}
            <small>{howText(f)}</small>
          </Kv>
          <Kv k="记录时间">
            <span className="num">
              {ymd(f.recorded_at)} {hm(f.recorded_at)}
            </span>
          </Kv>
        </div>
        <Block title="来源出处">
          <Source fact={f} now={now} onJump={onJump} />
        </Block>
        <Block
          title="调用记录"
          note={
            <>
              近 14 日 <span className="num">{recentText(f, now) ?? 0}</span> 次
            </>
          }
        >
          <UseAxis spark={spark} now={now} />
          {f.uses.length > 0 ? (
            <Lines>
              {f.uses.slice(0, 3).map((u) => (
                <Line key={`${u.line_id}-${u.at}`} at={stamp(u.at, now)}>
                  {u.how === 'injected' ? '注入角色回复上下文' : '在回复中被提及'}
                </Line>
              ))}
            </Lines>
          ) : (
            <Note>{isDormant(f) ? '已连续 30 天未调用，将不再主动提及（被问及时仍可检索）' : '尚未被调用过'}</Note>
          )}
        </Block>
        {versions && versions.length > 1 && (
          <Block
            title="版本历史"
            note={
              <>
                <span className="num">{versions.length}</span> 版
              </>
            }
          >
            <Lines>
              {versions.toReversed().map((v) => (
                <Line
                  key={v.version}
                  at={v.by ? `${stamp(v.at * 1000, now)} │ ${BY[v.by]}` : stamp(v.at * 1000, now)}
                  end={v.version === f.version ? <Note>当前</Note> : v.text !== f.text && <Lnk onClick={() => void onSave(v.text, f)}>恢复</Lnk>}
                >
                  {v.text}
                </Line>
              ))}
            </Lines>
          </Block>
        )}
    </Frame>
  );
}
