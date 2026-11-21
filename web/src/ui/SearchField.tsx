import type { Ref } from 'react';
import { Icon } from './Icon';
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
}

export function SearchField({ value, label, placeholder, inputRef, onChange }: SearchFieldProps) {
  const [q, setQ] = useControlled(value, onChange);
  return (
    <span className={styles.field} data-stub="SearchField">
      <Icon name="search" size={14} />
      <input
        ref={inputRef}
        className={styles.input}
        value={q}
        placeholder={placeholder}
        aria-label={label}
        onChange={(e) => setQ(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && q) setQ('');
        }}
      />
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
];
