import { useState } from 'react';
import type { SayRequest } from '../../../../bridge';
import { Btn, FilterChips, IconBtn } from '../../../../ui';
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
    const unreadable = types.length > 0 ? `无法读取 ${types.join('、')} 内容，将仅发送文件路径` : null;
    const words = (a.items ?? []).filter((i) => i.kind !== 'file').map((i) => (i.kind === 'url' ? i.url : i.text));
    return (
      <div className={styles.att}>
        <div className={styles.meta}>
          <span>{a.files > 0 ? `可读取 ${a.files} 个文件` : (unreadable ?? `已附带 ${words.length} 项内容`)}</span>
          <IconBtn icon="close" size="sm" label="移除附件" onClick={onDrop} />
        </div>
        {a.files > 0 && unreadable && <p className={styles.line}>{unreadable}</p>}
        {dropOverflows(typed ?? '', a) && <p className={styles.line}>附带内容超出长度限制，发送时将仅截取前段</p>}
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
  const meta = [SOURCE[a.source], a.app, `${[...a.text].length} 字`, a.truncated && '内容过长，已截取前 2000 字'].filter(Boolean).join(' │ ');
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
            <FilterChips
              label="什么时候提醒"
              options={REMIND_AT.map(([shown, spoken]) => ({ value: spoken, label: shown }))}
              value={when ? [when] : []}
              onChange={(v) => !sending && setWhen(v[0] ?? null)}
            />
            <Btn variant="text" size="sm" disabled={sending} disabledReason="正在发送" onClick={() => setAction(null)}>
              返回
            </Btn>
          </>
        ) : (
          <FilterChips
            label="对这段文字"
            options={ACTIONS.map(([value, label]) => ({ value, label }))}
            value={action ? [action] : []}
            onChange={(v) => {
              if (sending || !v[0]) return;
              setAction(v[0] as SelectionAction);
              setWhen(null);
            }}
          />
        )}
      </div>
      {request && (
        <div className={styles.preview}>
          <span className={styles.label}>{request.noMemory ? '发送至角色 │ 无痕对话（本轮不记入记忆）' : action === 'remember' ? '发送至角色 │ 写入记忆' : '发送至角色'}</span>
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
