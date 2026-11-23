import { useCallback, useEffect, useRef, type Ref } from 'react';
import { Icon } from './Icon';
import { Kbd } from './Kbd';
import { useControlled } from './useControlled';
import styles from './SearchField.module.css';

/** 搜索框：浅一级底色加 1 px 描边、直角，聚焦时底边 2 px trace 线；放大镜和清除钮都在框内；Esc 清空。 */
export interface SearchFieldProps {
  /** 当前文字 */
  value: string;
  /** 读屏名称 */
  label: string;
  /** 占位文字 */
  placeholder?: string;
  /** 输入框引用（⌘F 聚焦用） */
  inputRef?: Ref<HTMLInputElement>;
  /** 文字变化；清除时给空串 */
  onChange?: (v: string) => void;
  /** 按 Enter（输入法选字时不算） */
  onSubmit?: (v: string) => void;
  /** 聚焦输入框的快捷键，如 '⌘F'、'Ctrl+F'；键帽只在按住 ⌘ / Ctrl 时显示 */
  shortcut?: string;
}

/** '⌘F' / 'Ctrl+F' / '⌃F': which of ⌘ and Ctrl, and the key. */
function chord(shortcut: string) {
  const ctrl = /ctrl|⌃/i.test(shortcut);
  return { meta: !ctrl && /⌘|cmd/i.test(shortcut), ctrl, key: shortcut.slice(-1).toLowerCase() };
}

export function SearchField({ value, label, placeholder, inputRef, onChange, onSubmit, shortcut }: SearchFieldProps) {
  const [q, setQ] = useControlled(value, onChange);
  const own = useRef<HTMLInputElement | null>(null);
  const attach = useCallback(
    (el: HTMLInputElement | null) => {
      own.current = el;
      if (typeof inputRef === 'function') inputRef(el);
      else if (inputRef) inputRef.current = el;
    },
    [inputRef],
  );

  useEffect(() => {
    if (!shortcut) return;
    const want = chord(shortcut);
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.shiftKey || e.metaKey !== want.meta || e.ctrlKey !== want.ctrl || e.key.toLowerCase() !== want.key) return;
      e.preventDefault();
      own.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shortcut]);

  return (
    <span className={styles.field} data-stub="SearchField">
      <Icon name="search" size={14} />
      <input
        ref={attach}
        className={styles.input}
        value={q}
        placeholder={placeholder}
        aria-label={label}
        onChange={(e) => setQ(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && q) setQ('');
          else if (e.key === 'Enter' && !e.nativeEvent.isComposing) onSubmit?.(q);
        }}
      />
      {shortcut && (
        <span className={styles.keys} aria-hidden="true">
          <Kbd>{shortcut}</Kbd>
        </span>
      )}
      {q && (
        <button type="button" className={styles.clear} aria-label="清除搜索" title="清除搜索" onClick={() => setQ('')}>
          <Icon name="close" size={12} />
        </button>
      )}
    </span>
  );
}

export const SearchFieldDemos: Array<{ name: string; props: SearchFieldProps }> = [
  { name: 'empty', props: { value: '', label: '搜索记忆', placeholder: '搜索文本、来源、种类 ⌘F' } },
  { name: 'filled', props: { value: '周报', label: '搜索记忆', placeholder: '搜索文本、来源、种类 ⌘F' } },
  { name: 'shortcut', props: { value: '', label: '搜索记忆', placeholder: '搜索文本、来源、种类', shortcut: '⌘F' } },
];
