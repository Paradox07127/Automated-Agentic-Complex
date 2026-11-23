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

/** White danger card: red-black hatch along the top, a red triangle, the quoted fact and what deleting it does. */
export function DeleteCard({ fact, onCancel, onConfirm }: { fact: Fact; onCancel: () => void; onConfirm: () => void }) {
  const id = useId();
  const seen = fact.evidence.some((r) => r.startsWith('episode:'));
  return (
    <Overlay labelledBy={id} alert onClose={onCancel}>
      <h4 id={id}>
        <span className={styles.wi} aria-hidden="true">
          !
        </span>
        删除这条记忆？
      </h4>
      <q>{factText(fact)}</q>
      <ul>
        <li>她以后不会再引用它，也不会从同一出处再记一次。</li>
        {seen && <li>这条来自一段观察；那段观察整理出的其他记忆会一起删除。</li>}
        <li>删除后找不回。</li>
      </ul>
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

/** 清空记忆: the same danger card, armed by typing 删除. */
export function ClearCard({ count, onCancel, onConfirm }: { count: number; onCancel: () => void; onConfirm: () => void }) {
  const id = useId();
  const [word, setWord] = useState('');
  const armed = word.trim() === '删除';
  return (
    <Overlay labelledBy={id} alert onClose={onCancel}>
      <h4 id={id}>
        <span className={styles.wi} aria-hidden="true">
          !
        </span>
        清空全部记忆？
      </h4>
      <p>
        删掉 <b className="num">{count}</b> 条记忆，称呼和生日保留。所有角色都会忘掉这些事，找不回。输入「删除」确认。
      </p>
      <Field label="输入删除确认" value={word} placeholder="删除" onChange={setWord} />
      <div className={styles.btns}>
        <Btn variant="secondary" onClick={onCancel}>
          取消
        </Btn>
        <Btn variant="danger" disabled={!armed} disabledReason="先输入「删除」" onClick={onConfirm}>
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
        <TextArea label="内容" value={text} maxLength={500} rows={3} placeholder="要她记住的事，比如：周五下午不开会" onChange={setText} />
        <GameSeg label="分类" caption="分类" micro="Kind" value={kind} options={ADD_CATS.map((c) => ({ value: c.kind, label: c.label }))} onChange={(v) => setKind(v as FactKind)} />
        <p>来源记为「用户陈述」，所有角色下一句起就会用。</p>
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
