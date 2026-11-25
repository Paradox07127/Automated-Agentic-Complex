import { useId, useRef, useState, type ReactNode } from 'react';
import type { Fact, FactKind } from '../../domain';
import { Btn, Field, OverlayPortal, TextArea, useOverlayFocus } from '../../ui';
import { GameSeg } from '../../ui/game';
import { ADD_CATS, factText } from './model';
import { DetailHead } from './parts';
import styles from './Papers.module.css';

/** Blurred scrim with one centred card; Esc, a click outside or 取消 closes it, focus goes back where it was. */
function Overlay({ labelledBy, alert, onClose, children, pop }: { labelledBy: string; alert?: boolean; onClose: () => void; children: ReactNode; pop?: boolean }) {
  const panel = useRef<HTMLDivElement>(null);
  const trap = useOverlayFocus(panel, onClose);
  return (
    <OverlayPortal>
      <div
        className={styles.scrim}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div
          ref={panel}
          role={alert ? 'alertdialog' : 'dialog'}
          aria-modal="true"
          aria-labelledby={labelledBy}
          tabIndex={-1}
          className={pop ? styles.pop : `${styles.paper} ${styles.warn}`}
          data-theme={pop ? 'dark' : 'light'}
          onKeyDown={trap}
        >
          {children}
        </div>
      </div>
    </OverlayPortal>
  );
}

/** White danger card: red-black hatch along the top, a red triangle, the quoted fact and what deleting it does;
 * `gone`: the other memories that go with it, null for one this view did not read. */
export function DeleteCard({ fact, gone, onCancel, onConfirm }: { fact: Fact; gone: Array<Fact | null>; onCancel: () => void; onConfirm: () => void }) {
  const id = useId();
  return (
    <Overlay labelledBy={id} alert onClose={onCancel}>
      <h4 id={id}>
        <span className={styles.wi} aria-hidden="true">
          !
        </span>
        删除该条记忆？
      </h4>
      <q>{factText(fact)}</q>
      <ul>
        <li>删除后将不再被引用，也不会从同一来源再次自动记录。</li>
        <li>删除后无法恢复。</li>
      </ul>
      {gone.length > 0 && <Gone gone={gone} what="删除该条后" />}
      <div className={styles.btns}>
        <Btn variant="secondary" onClick={onCancel}>
          取消
        </Btn>
        <Btn variant="danger" onClick={onConfirm}>
          删除
        </Btn>
      </div>
    </Overlay>
  );
}

/** The other memories a correction or deletion takes with it; null for one this view did not read. */
function Gone({ gone, what }: { gone: Array<Fact | null>; what: string }) {
  const shown = gone.filter((f): f is Fact => f != null);
  return (
    <>
      <p>该条目与以下内容出自同一段屏幕观察总结；{what}，该总结及关联记忆将一并删除且无法恢复。</p>
      <ul>
        {shown.map((f) => (
          <li key={f.id}>{factText(f)}</li>
        ))}
        {shown.length < gone.length && (
          <li>
            另有 <span className="num">{gone.length - shown.length}</span> 条不在当前列表中
          </li>
        )}
      </ul>
    </>
  );
}

/** The danger card before a correction that also deletes other memories; `gone` holds null for one this view did not read. */
export function CorrectCard({ fact, gone, onCancel, onConfirm }: { fact: Fact; gone: Array<Fact | null>; onCancel: () => void; onConfirm: () => void }) {
  const id = useId();
  return (
    <Overlay labelledBy={id} alert onClose={onCancel}>
      <h4 id={id}>
        <span className={styles.wi} aria-hidden="true">
          !
        </span>
        修改该条目将同步删除另外 {gone.length} 条记忆
      </h4>
      <q>{factText(fact)}</q>
      <Gone gone={gone} what="修改该条后" />
      <div className={styles.btns}>
        <Btn variant="secondary" onClick={onCancel}>
          取消
        </Btn>
        <Btn variant="danger" onClick={onConfirm}>
          仍然修改
        </Btn>
      </div>
    </Overlay>
  );
}

/** 清空记忆: the same danger card, armed by typing 删除. `who`: the character whose own facts alone are cleared; null clears every character's. */
export function ClearCard({ who, count, onCancel, onConfirm }: { who: string | null; count: number; onCancel: () => void; onConfirm: () => void }) {
  const id = useId();
  const [word, setWord] = useState('');
  const armed = word.trim() === '删除';
  return (
    <Overlay labelledBy={id} alert onClose={onCancel}>
      <h4 id={id}>
        <span className={styles.wi} aria-hidden="true">
          !
        </span>
        {who ? `清空「${who}」的专属记忆？` : '清空全部记忆？'}
      </h4>
      <p>
        {who ? (
          <>
            将删除仅属于 {who} 的 <b className="num">{count}</b> 条记忆（共享记忆与其他角色的记忆保留），删除后无法恢复。请输入「删除」确认。
          </>
        ) : (
          <>
            将删除 <b className="num">{count}</b> 条记忆（称呼与生日保留），删除后所有角色均不再保留这些记忆且无法恢复。请输入「删除」确认。
          </>
        )}
      </p>
      <Field label="输入删除确认" value={word} placeholder="删除" onChange={setWord} />
      <div className={styles.btns}>
        <Btn variant="secondary" onClick={onCancel}>
          取消
        </Btn>
        <Btn variant="danger" disabled={!armed} disabledReason="请先输入「删除」" onClick={onConfirm}>
          清空
        </Btn>
      </div>
    </Overlay>
  );
}

/** 新增一条记忆: the game pop panel; the text and its category; 保存 is the panel's one yellow button. */
export function AddPop({ onCancel, onSave }: { onCancel: () => void; onSave: (text: string, kind: FactKind) => Promise<boolean> }) {
  const id = useId();
  const [text, setText] = useState('');
  const [kind, setKind] = useState<FactKind>('preference');
  const [busy, setBusy] = useState(false);
  const save = () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    void onSave(text.trim(), kind).then(() => setBusy(false));
  };
  return (
    <Overlay labelledBy={id} pop onClose={onCancel}>
      <DetailHead title={<span id={id}>新增一条记忆</span>} micro="New / Memory" />
      <div className={styles.pb}>
        <TextArea label="内容" value={text} maxLength={500} rows={3} placeholder="输入需记住的内容，例如：周五下午不安排会议" onChange={setText} />
        <GameSeg label="分类" caption="分类" micro="Kind" value={kind} options={ADD_CATS.map((c) => ({ value: c.kind, label: c.label }))} onChange={(v) => setKind(v as FactKind)} />
        <p>来源将记为「用户陈述」，后续对话将直接生效。</p>
      </div>
      <div className={styles.pf}>
        <Btn variant="secondary" onClick={onCancel}>
          取消
        </Btn>
        <Btn variant="primary" icon="check" loading={busy} disabled={!text.trim()} disabledReason="内容不能为空" onClick={save}>
          保存
        </Btn>
      </div>
    </Overlay>
  );
}
