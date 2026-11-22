import { useState } from 'react';
import rw from './Raw.module.css';

/** Lines shown before 全部. */
const FIRST = 20;

/** A folded raw text: label with line and character counts; open, it wraps (toggle), copies, and shows 20 lines until 全部. */
export function RawFold({ label, lines, open: initial = false, onCopy }: { label: string; lines: string[]; open?: boolean; onCopy: (text: string) => void }) {
  const [open, setOpen] = useState(initial);
  const [wrap, setWrap] = useState(true);
  const [all, setAll] = useState(false);
  const chars = lines.reduce((n, l) => n + l.length, 0);
  return (
    <div className={rw.raw}>
      <div className={rw.rawH}>
        <button type="button" className={rw.tg} aria-expanded={open} onClick={() => setOpen(!open)}>
          <i aria-hidden="true" />
          {label}
          <small>
            {lines.length} 行 │ {chars.toLocaleString('en-US')} 字
          </small>
        </button>
        {open && (
          <>
            <button type="button" className={rw.tl} aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
              自动换行
            </button>
            <button type="button" className={rw.tl} onClick={() => onCopy(lines.join('\n'))}>
              复制
            </button>
          </>
        )}
      </div>
      {open && (
        <>
          <pre className={rw.code} data-wrap={wrap || undefined}>
            {(all ? lines : lines.slice(0, FIRST)).map((l, i) => (
              <span key={i}>{l || ' '}</span>
            ))}
          </pre>
          {lines.length > FIRST && (
            <button type="button" className={rw.all} onClick={() => setAll(!all)}>
              {all ? '收起' : `全部 ${lines.length} 行`}
            </button>
          )}
        </>
      )}
    </div>
  );
}
