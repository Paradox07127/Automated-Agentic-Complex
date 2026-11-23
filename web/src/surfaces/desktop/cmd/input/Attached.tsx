import { useState, type ReactNode } from 'react';
import type { SayRequest } from '../../../../bridge';
import { Btn, IconBtn } from '../../../../ui';
import { ACTIONS, dropOverflows, REMIND_AT, selectionSay, type Attachment, type SelectionAction } from './selection';
import styles from './Attached.module.css';

export interface AttachedProps {
  attachment: Attachment;
  /** What is typed in the box, which the drop goes after. */
  typed?: string;
  sending: boolean;
  /** ✕: 快速输入 goes on without it. */
  onDrop: () => void;
  /** A picked action's request, exactly as previewed. */
  onSend: (r: SayRequest) => void;
}

const SOURCE = { selection: '选中文字', clipboard: '剪贴板' } as const;

function Chip({ pressed, disabled, onClick, children }: { pressed?: boolean; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={styles.chip} aria-pressed={pressed} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

/** What 快速输入 opened with: a selection with its six actions, a drop scope, a window, or why nothing was read. */
export function Attached({ attachment: a, typed, sending, onDrop, onSend }: AttachedProps) {
  const [action, setAction] = useState<SelectionAction | null>(null);
  const [when, setWhen] = useState<string | null>(null);

  if (a.kind === 'selectionRefused') return <p className={styles.line}>{a.message}</p>;
  if (a.kind === 'scope') {
    const types = [
      ...new Set(
        (a.items ?? [])
          .filter((i) => i.kind === 'file' && (!a.scopeId || (a.unsupported ?? []).includes(i.path)))
          .map((i) => {
            const name = i.kind === 'file' ? i.name : '';
            const dot = name.lastIndexOf('.');
            return dot >= 0 ? name.slice(dot).toLowerCase() : name;
          }),
      ),
    ];
    const unreadable = types.length > 0 ? `读不了 ${types.join('、')}，只把路径发给角色` : null;
    const words = (a.items ?? []).filter((i) => i.kind !== 'file').map((i) => (i.kind === 'url' ? i.url : i.text));
    return (
      <div className={styles.att}>
        <div className={styles.meta}>
          <span>{a.files > 0 ? `可读 ${a.files} 个文件` : (unreadable ?? `拖入 ${words.length} 项`)}</span>
          <IconBtn icon="close" size="sm" label="不带这些文件" onClick={onDrop} />
        </div>
        {a.files > 0 && unreadable && <p className={styles.line}>{unreadable}</p>}
        {dropOverflows(typed ?? '', a) && <p className={styles.line}>拖入的内容太长，发送时只带前面一部分</p>}
        {words.length > 0 && (
          <pre className={styles.text} data-attachment-text="">
            {words.join('\n')}
          </pre>
        )}
      </div>
    );
  }
  if (a.kind === 'window') {
    const chars = [...(a.title ?? '')];
    const title = chars.length > 40 ? `${chars.slice(0, 40).join('')}…` : chars.join('');
    const shown = [a.app, title].filter(Boolean).join(' — ');
    return (
      <div className={styles.att}>
        <div className={styles.meta}>
          <span>{shown ? `读这个窗口：${shown}` : '读这个窗口'}</span>
          <IconBtn icon="close" size="sm" label="不读这个窗口" onClick={onDrop} />
        </div>
      </div>
    );
  }

  const request = action && (action !== 'remind' || when) ? selectionSay(action, a.text, when ?? '') : null;
  const meta = [SOURCE[a.source], a.app, `${[...a.text].length} 字`, a.truncated && '太长，只取了前 2000 字'].filter(Boolean).join(' │ ');
  return (
    <div className={styles.att}>
      <div className={styles.meta}>
        <span>{meta}</span>
        <IconBtn icon="close" size="sm" label="不带这段文字" onClick={onDrop} />
      </div>
      <pre className={styles.text} data-attachment-text="">
        {a.text}
      </pre>
      <div className={styles.chips}>
        {action === 'remind' ? (
          <>
            {REMIND_AT.map(([shown, spoken]) => (
              <Chip key={shown} pressed={when === spoken} disabled={sending} onClick={() => setWhen(spoken)}>
                {shown}
              </Chip>
            ))}
            <Chip disabled={sending} onClick={() => setAction(null)}>
              返回
            </Chip>
          </>
        ) : (
          ACTIONS.map(([key, label]) => (
            <Chip
              key={key}
              pressed={action === key}
              disabled={sending}
              onClick={() => {
                setAction(key);
                setWhen(null);
              }}
            >
              {label}
            </Chip>
          ))
        )}
      </div>
      {request && (
        <div className={styles.preview}>
          <span className={styles.label}>{request.noMemory ? '将发给角色 │ 这一轮不记' : action === 'remember' ? '将发给角色 │ 会记住这段文字' : '将发给角色'}</span>
          <pre className={styles.text} data-say-preview="">
            {request.text}
          </pre>
          <Btn variant="secondary" size="sm" loading={sending} onClick={() => onSend(request)}>
            发送
          </Btn>
        </div>
      )}
    </div>
  );
}
