import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Btn } from './Btn';
import { Icon, type IconName } from './Icon';
import { IconBtn } from './IconBtn';
import { placePopup, usePopupLayer } from './popup';
import styles from './Menu.module.css';

/** Modifier keys held when an item was chosen (⌥ for an item's alternate action). */
export interface MenuMods {
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

const modsOf = (e: MenuMods): MenuMods => ({ altKey: e.altKey, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey });

/** One menu entry; radio (with checked) is one choice of several and closes the menu, checked alone toggles and keeps it open; icon is drawn before the label;
 *  off marks an entry whose capability is switched off (grey, ⊗, the reason as its description) that can still be chosen. */
export type MenuItem =
  | { kind: 'item'; label: string; icon?: IconName; hint?: string; danger?: boolean; checked?: boolean; radio?: boolean; disabled?: boolean; reason?: string; off?: string; onSelect?: (mods: MenuMods) => void }
  | { kind: 'sep' }
  | { kind: 'head'; label: string };

/** 菜单（右键菜单和「管理 ▾」共用）：项可带快捷提示、危险色、勾选、禁用原因。 */
export interface MenuProps {
  /** 触发按钮文字或读屏名称 */
  label: string;
  /** 菜单项 */
  items: MenuItem[];
  /** 用图标按钮触发 */
  icon?: IconName;
  /** 强制展开（演示、截图） */
  open?: boolean;
  /** 对齐，默认 left */
  align?: 'left' | 'right';
  /** 有非默认的筛选：触发键带黄色小块 */
  narrowed?: boolean;
  /** bar：顶栏页面名的深色扁平签（只给外壳顶栏用）；默认深色胶囊 Btn */
  look?: 'bar';
}

/** 已关闭's ⊗ (PowerState's ring cut twice round a ×) and the word, grey. */
function OffMark() {
  return (
    <span className={styles.off} data-off="" aria-hidden="true">
      <svg width={12} height={12} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="9.6" fill="none" stroke="currentColor" strokeWidth="2.6" pathLength="100" strokeDasharray="38 12" transform="rotate(-80 12 12)" />
        <path d="M6.8 6.8l3.8 3.8M17.2 6.8l-3.8 3.8M6.8 17.2l3.8-3.8M17.2 17.2l-3.8-3.8" stroke="currentColor" strokeWidth="2.8" />
      </svg>
      已关闭
    </span>
  );
}

export function Menu({ label, items, icon, open: forced, align = 'left', narrowed, look }: MenuProps) {
  const [openState, setOpen] = useState(false);
  const open = !!forced || openState;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [focusOn, setFocusOn] = useState<number | null>(null);
  const id = useId();
  const actionable = items.map((it, i) => (it.kind === 'item' ? i : -1)).filter((i) => i >= 0);
  // Once any item has an icon, the rest keep its column empty so the labels line up.
  const iconCol = items.some((it) => it.kind === 'item' && it.icon);

  const place = useCallback(() => {
    const t = trigger.current;
    const m = pop.current;
    return t && m ? placePopup(t.getBoundingClientRect(), m.offsetWidth, m.scrollHeight, align) : null;
  }, [align]);
  const { inline, layer, ready, portal } = usePopupLayer(open, root, place);

  useEffect(() => {
    if (!openState || forced) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (root.current && !root.current.contains(t) && !pop.current?.contains(t)) setOpen(false);
    };
    // WebKit does not focus a clicked button, so Escape is heard on the document; capture keeps it from also closing a
    // Modal or Sheet around the menu.
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setFocusOn(null);
      trigger.current?.focus();
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc, true);
    };
  }, [openState, forced]);

  useEffect(() => {
    const el = focusOn != null && open && ready ? itemRefs.current[focusOn] : null;
    const box = pop.current;
    if (!el || !box) return;
    el.focus({ preventScroll: true });
    if (el.offsetTop < box.scrollTop) box.scrollTop = el.offsetTop;
    else if (el.offsetTop + el.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = el.offsetTop + el.offsetHeight - box.clientHeight;
  }, [focusOn, open, ready]);

  const show = (at: 'first' | 'last') => {
    setOpen(true);
    setFocusOn((at === 'first' ? actionable[0] : actionable[actionable.length - 1]) ?? null);
  };
  const close = () => {
    setOpen(false);
    setFocusOn(null);
    trigger.current?.focus();
  };

  const toggle = () => (openState ? close() : (setOpen(true), setFocusOn(null)));
  const menuAria = { 'aria-haspopup': 'menu', 'aria-controls': open ? `${id}-menu` : undefined } as const;

  const select = (i: number, mods: MenuMods) => {
    const it = items[i];
    if (!it || it.kind !== 'item' || it.disabled) return;
    it.onSelect?.(mods);
    if (it.checked === undefined || it.radio) close();
  };

  const onTriggerKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== trigger.current) return;
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      show('first');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      show('last');
    }
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = actionable.indexOf(focusOn ?? -1);
    const n = actionable.length;
    const to: Record<string, number | undefined> = {
      ArrowDown: actionable[(cur + 1) % n],
      ArrowUp: actionable[(cur - 1 + n) % n],
      Home: actionable[0],
      End: actionable[n - 1],
    };
    if (e.key in to) {
      e.preventDefault();
      setFocusOn(to[e.key] ?? null);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      // The popup sits at the end of body: Tab goes on from the trigger, Shift+Tab lands on it.
      trigger.current?.focus();
      if (e.shiftKey) e.preventDefault();
      setOpen(false);
      setFocusOn(null);
    }
  };

  return (
    <div ref={root} className={styles.wrap} data-stub="Menu" data-align={align} data-open={open || undefined} data-narrowed={narrowed || undefined} data-look={look} onKeyDown={onTriggerKey}>
      {icon ? (
        <IconBtn ref={trigger} icon={icon} label={narrowed ? `${label}（已收窄）` : label} size="sm" expanded={open} onClick={toggle} {...menuAria} />
      ) : look === 'bar' ? (
        <button ref={trigger} type="button" className={styles.trigger} aria-expanded={open} onClick={toggle} {...menuAria}>
          {label}
          {narrowed && <span className={styles.vh}>（已收窄）</span>}
          <Icon name="chevd" size={14} />
        </button>
      ) : (
        <Btn ref={trigger} variant="secondary" tail="chevd" aria-expanded={open} onClick={toggle} {...menuAria}>
          {label}
          {narrowed && <span className={styles.vh}>（已收窄）</span>}
        </Btn>
      )}
      {open && inline !== undefined && portal(
        <div
          ref={pop}
          id={`${id}-menu`}
          role="menu"
          aria-label={label}
          className={styles.menu}
          data-theme={inline ? undefined : layer?.theme}
          style={inline ? undefined : layer?.place}
          onKeyDown={onMenuKey}
        >
          {items.map((it, i) => {
            if (it.kind === 'sep') return <div key={i} role="separator" className={styles.sep} />;
            if (it.kind === 'head')
              return (
                <div key={i} role="presentation" className={styles.head}>
                  {it.label}
                </div>
              );
            return (
              <button
                key={i}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                type="button"
                role={it.radio ? 'menuitemradio' : it.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                aria-checked={it.radio ? !!it.checked : it.checked}
                aria-disabled={it.disabled || undefined}
                tabIndex={focusOn === i ? 0 : -1}
                className={styles.item}
                data-danger={it.danger || undefined}
                data-check={it.checked === undefined && !it.radio ? undefined : String(!!it.checked)}
                data-off={it.off ? '' : undefined}
                aria-description={it.off}
                title={it.disabled ? it.reason : it.off}
                onClick={(e) => select(i, modsOf(e))}
                onMouseEnter={() => setFocusOn(i)}
              >
                {(it.checked !== undefined || it.radio) && <span className={styles.box} aria-hidden="true" />}
                {iconCol && (
                  <span className={styles.icon} aria-hidden="true">
                    {it.icon && <Icon name={it.icon} size={16} />}
                  </span>
                )}
                <span className={styles.text}>
                  {it.label}
                  {it.disabled && it.reason && <span className={styles.reason}>{it.reason}</span>}
                </span>
                {it.off && <OffMark />}
                {it.hint && <kbd className={styles.hint}>{it.hint}</kbd>}
              </button>
            );
          })}
        </div>,
      )}
    </div>
  );
}

const MANAGE: MenuItem[] = [
  { kind: 'head', label: '这个任务' },
  { kind: 'item', label: '重命名', hint: 'F2' },
  { kind: 'item', label: '置顶', checked: true },
  { kind: 'item', label: '归档', disabled: true, reason: '还在进行中，先停止任务' },
  { kind: 'sep' },
  { kind: 'item', label: '删除…', danger: true, hint: '⌘⌫' },
];

export const MenuDemos: Array<{ name: string; props: MenuProps }> = [
  { name: 'closed', props: { label: '管理', items: MANAGE } },
  { name: 'open', props: { label: '管理', open: true, items: MANAGE } },
  { name: 'narrowed', props: { label: '排序', narrowed: true, open: true, items: [{ kind: 'item', label: '按时间', radio: true, checked: false }, { kind: 'item', label: '按名称', radio: true, checked: true }] } },
  { name: 'icon', props: { label: '更多操作', icon: 'more', align: 'right', open: true, items: [{ kind: 'item', label: '复制路径' }, { kind: 'item', label: '在 Finder 中显示' }] } },
  {
    name: 'item-icons',
    props: {
      label: '页面',
      open: true,
      items: [
        { kind: 'item', label: '对话', icon: 'send', hint: '⌘2' },
        { kind: 'item', label: '设置', icon: 'settings', hint: '⌘,' },
        { kind: 'sep' },
        { kind: 'item', label: '诊断', icon: 'd-overview' },
      ],
    },
  },
  { name: 'off', props: { label: '页面', open: true, items: [
    { kind: 'item', label: '每日简报', icon: 'sun', hint: '⌘1', off: '已关闭：设置里关着「每日简报」' },
    { kind: 'item', label: '对话', icon: 'send', hint: '⌘2' },
  ] } },
];

/** 右键菜单：开在指针处、没有触发按钮，由父组件持有开关；按外面、Esc、改窗口大小、滚动、窗口失焦都调 onClose。 */
export interface ContextMenuProps {
  /** 菜单的读屏名称 */
  label: string;
  items: MenuItem[];
  /** 指针坐标（视口像素）；null 时不显示 */
  at: { x: number; y: number } | null;
  onClose: () => void;
}

export function ContextMenu({ label, items, at, onClose }: ContextMenuProps) {
  const pop = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const actionable = items.map((it, i) => (it.kind === 'item' ? i : -1)).filter((i) => i >= 0);
  const [focusOn, setFocusOn] = useState<number | null>(null);
  const [place, setPlace] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    if (!at) return setPlace(null);
    const m = pop.current;
    const w = m?.offsetWidth ?? 0, h = m?.scrollHeight ?? 0;
    const left = Math.max(8, Math.min(at.x, window.innerWidth - 8 - w));
    const top = at.y + h > window.innerHeight - 8 ? Math.max(8, at.y - h) : at.y;
    setPlace({ left, top, maxHeight: window.innerHeight - 16 });
    setFocusOn(actionable[0] ?? null);
  }, [at]);

  useEffect(() => {
    if (!at) return;
    const close = () => closeRef.current();
    const away = (e: PointerEvent) => {
      if (!pop.current?.contains(e.target as Node)) close();
    };
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', esc, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('blur', close);
    };
  }, [at]);

  const open = at != null;
  useLayoutEffect(() => {
    if (!open) return;
    const opener = document.activeElement;
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    const el = focusOn != null && place ? itemRefs.current[focusOn] : null;
    const box = pop.current;
    if (!el || !box) return;
    el.focus({ preventScroll: true });
    if (el.offsetTop < box.scrollTop) box.scrollTop = el.offsetTop;
    else if (el.offsetTop + el.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = el.offsetTop + el.offsetHeight - box.clientHeight;
  }, [focusOn, place]);

  if (!at) return null;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = actionable.indexOf(focusOn ?? -1);
    const n = actionable.length;
    const to: Record<string, number | undefined> = { ArrowDown: actionable[(cur + 1) % n], ArrowUp: actionable[(cur - 1 + n) % n], Home: actionable[0], End: actionable[n - 1] };
    if (e.key in to) {
      e.preventDefault();
      setFocusOn(to[e.key] ?? null);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      onClose();
    }
  };
  return createPortal(
    <div ref={pop} role="menu" aria-label={label} className={styles.menu} data-context="" style={place ?? { left: at.x, top: at.y, visibility: 'hidden' }} onKeyDown={onKey}>
      {items.map((it, i) => {
        if (it.kind === 'sep') return <div key={i} role="separator" className={styles.sep} />;
        if (it.kind === 'head') return <div key={i} role="presentation" className={styles.head}>{it.label}</div>;
        return (
          <button
            key={i}
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            type="button"
            role="menuitem"
            aria-disabled={it.disabled || undefined}
            tabIndex={focusOn === i ? 0 : -1}
            className={styles.item}
            data-danger={it.danger || undefined}
            title={it.disabled ? it.reason : undefined}
            onClick={(e) => {
              if (it.disabled) return;
              it.onSelect?.(modsOf(e));
              onClose();
            }}
            onMouseEnter={() => setFocusOn(i)}
          >
            <span className={styles.text}>
              {it.label}
              {it.disabled && it.reason && <span className={styles.reason}>{it.reason}</span>}
            </span>
            {it.hint && <kbd className={styles.hint}>{it.hint}</kbd>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
