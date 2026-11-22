import { useEffect, useRef, useState } from 'react';
import { FunnelMark } from './Glyphs';
import s from './List.module.css';
import t from './Trace.module.css';

export interface FilterItem {
  id: string;
  label: string;
  on: boolean;
}

/** The funnel orb and its menu: `multi` keeps the menu open and toggles; otherwise a pick closes it. `narrowed` fills the orb. */
export function FilterMenu({ label, head, items, multi, narrowed, onPick }: { label: string; head: string; items: FilterItem[]; multi?: boolean; narrowed: boolean; onPick: (id: string, alt: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    // Capture: Escape closes the menu before the page or the command bar hears it.
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc, true);
    };
  }, [open]);
  return (
    <div ref={root} className={s.pop}>
      <button type="button" className={t.orb} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} data-on={narrowed || undefined} onClick={() => setOpen(!open)}>
        <FunnelMark />
      </button>
      {open && (
        <div className={s.menu} role="menu" aria-label={label}>
          <b>{head}</b>
          {items.map((i) => (
            <button
              key={i.id}
              type="button"
              role={multi ? 'menuitemcheckbox' : 'menuitemradio'}
              aria-checked={i.on}
              onClick={(e) => {
                onPick(i.id, e.altKey);
                if (!multi) setOpen(false);
              }}
            >
              {i.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
