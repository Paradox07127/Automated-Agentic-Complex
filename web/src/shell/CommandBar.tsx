import { useEffect, useLayoutEffect, useRef, useState, type Ref } from 'react';
import { gameClips } from '../design/gameClips.generated';
import { fxCalm, Icon, Kbd, Menu, useGameClip, type MenuItem } from '../ui';
import { useDevMode } from './devMode';
import { navigate, type PageId } from './nav';
import { useShellStatus, type Lamp } from './shellStatus';
import type { PageRoute } from './types';
import styles from './CommandBar.module.css';
import more from './CommandBar.more.module.css';

/** Narrower than this, a cut status slot shows none of its readouts. */
const FOLD_BELOW = 64;

const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

function isEditable(t: EventTarget | null): boolean {
  if (!(t instanceof Element)) return false;
  if (t.closest(EDITABLE)) return true;
  return (t as HTMLElement).isContentEditable === true;
}

/** Scrolls the plate just enough that the selected cell and its block clear the plate's faded edges. */
function reveal(on: HTMLElement | null) {
  const plate = on?.closest<HTMLElement>('[data-slot="tabs"]');
  if (!on || !plate || plate.scrollWidth <= plate.clientWidth) return;
  const pad = parseFloat(getComputedStyle(plate).paddingLeft) || 0;
  const p = plate.getBoundingClientRect();
  const t = on.getBoundingClientRect();
  if (t.left < p.left + pad) plate.scrollLeft -= p.left + pad - t.left;
  else if (t.right > p.right - pad) plate.scrollLeft += t.right - (p.right - pad);
}

/** Which light the status chip names: the worst one, the first on a tie. */
const RANK: Record<Lamp, number> = { ok: 0, off: 1, warn: 2, bad: 3 };

export interface CommandBarProps {
  routes: PageRoute[];
  activeId: string | undefined;
  /** The open page's name; the button that lists every page carries it. */
  title: string;
  sub?: string | null;
  /** Where the open page portals its own tabs (`PageHeaderSlot`'s `tabs`). */
  tabsRef: Ref<HTMLDivElement>;
  /** Where the open page portals its status readouts and its one primary action. */
  rightRef: Ref<HTMLDivElement>;
  actionRef: Ref<HTMLDivElement>;
}

/** The one top bar of every page but 主页: back to 主页 (esc), the page's name (it lists every page), the page's own tabs between Q and E, its readouts and action, the status chip. */
export function CommandBar({ routes, activeId, title, sub, tabsRef, rightRef, actionRef }: CommandBarProps) {
  const status = useShellStatus();
  const devMode = useDevMode();
  const pages = routes.filter((r) => r.id !== 'home' && r.id !== 'onboarding' && (r.nav !== false || r.id === 'schedules'));
  const toItem = (r: PageRoute): MenuItem => ({
    kind: 'item',
    label: r.title,
    ...(r.hotkey ? { hint: r.hotkey } : {}),
    onSelect: () => navigate({ page: r.id as PageId }),
  });
  const user = pages.filter((r) => r.group !== 'dev' && !r.devOnly);
  const dev = devMode ? pages.filter((r) => r.group === 'dev' || r.devOnly) : [];
  const menuItems: MenuItem[] = [...user.map(toItem), ...(dev.length > 0 ? [{ kind: 'sep' as const }] : []), ...dev.map(toItem)];
  // 后台, 内核 and 角色 in one chip: all fine it reads 后台's state, else the worst light; it opens the three.
  const worst = status.lights.reduce((w, l) => (RANK[l.lamp] > RANK[w.lamp] ? l : w));
  const statusItems: MenuItem[] = [
    ...status.lights.map((l): MenuItem => ({ kind: 'item', label: `${l.label}：${l.state}` })),
    ...(devMode ? [{ kind: 'sep' as const }, { kind: 'item' as const, label: '查看诊断', onSelect: () => navigate({ page: 'diag' }) }] : []),
  ];
  const home = () => navigate({ page: 'home' as PageId });
  // The bar drops in once when the window opens (sns_basic_in's tabs track), not on page switches.
  const bar = useRef<HTMLDivElement>(null);
  useGameClip(gameClips.snsBasicIn, bar, { autoplay: true });

  // The selected tab is an icon; its name is written after the page's name.
  const [tabName, setTabName] = useState<string | null>(null);
  // Tabs hidden past either end of the plate: that end shows an arrow that scrolls a plate's width.
  const [hidden, setHidden] = useState({ prev: false, next: false });
  // Tabs that do not fit fold the status chip to its dot (1), then the page menu to the page's name (2); a resize or new
  // tabs start again from 0, all before paint.
  const [squeeze, setSqueeze] = useState(0);
  const [refits, setRefits] = useState(0);
  useLayoutEffect(() => {
    const plate = bar.current?.querySelector<HTMLElement>('[data-slot="tabs"]');
    if (squeeze < 2 && plate && plate.scrollWidth > plate.clientWidth + 1) setSqueeze(squeeze + 1);
  }, [squeeze, refits]);
  useEffect(() => {
    const host = bar.current;
    if (!host) return;
    const plate = host.querySelector<HTMLElement>('[data-slot="tabs"]');
    const refit = () => {
      setSqueeze(0);
      setRefits((n) => n + 1);
    };
    const ends = () => {
      if (!plate) return;
      const prev = plate.scrollLeft > 1;
      const next = plate.scrollLeft + plate.clientWidth < plate.scrollWidth - 1;
      setHidden((h) => (h.prev === prev && h.next === next ? h : { prev, next }));
    };
    const read = () => {
      const on = host.querySelector<HTMLElement>('[role="tab"][aria-selected="true"], [data-tab][data-on]');
      setTabName(on?.title || null);
      refit();
      reveal(on);
      ends();
    };
    read();
    const mo = new MutationObserver(read);
    mo.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-selected', 'data-on'] });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    ro?.observe(host);
    // A wider window may leave the tabs as they are and still have room to unfold the chip and the menu.
    if (host.parentElement) ro?.observe(host.parentElement);
    // A mouse wheel scrolls tabs that do not fit sideways; a native listener, as the tabs are portalled in from the page.
    const onWheel = (e: WheelEvent) => {
      if (plate && e.deltaX === 0 && plate.scrollWidth > plate.clientWidth) plate.scrollLeft += e.deltaY;
    };
    plate?.addEventListener('wheel', onWheel, { passive: true });
    plate?.addEventListener('scroll', ends, { passive: true });
    return () => {
      mo.disconnect();
      ro?.disconnect();
      plate?.removeEventListener('wheel', onWheel);
      plate?.removeEventListener('scroll', ends);
    };
  }, []);
  const page = (dir: 1 | -1) => {
    const plate = bar.current?.querySelector<HTMLElement>('[data-slot="tabs"]');
    if (!plate) return;
    const pad = parseFloat(getComputedStyle(plate).paddingLeft) || 0;
    plate.scrollBy({ left: dir * (plate.clientWidth - 2 * pad), behavior: fxCalm() ? 'auto' : 'smooth' });
  };

  // Status readouts that do not fit drop their data-fold fields, highest first; still too wide, they end in …, or with no
  // room for a first field fold away. A cut slot carries the full text as its tooltip.
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    const slot = nav.current?.querySelector<HTMLElement>('[data-slot="status"]');
    if (!slot) return;
    const over = () => slot.scrollWidth > slot.clientWidth + 1;
    const fit = () => {
      const fields = [...slot.querySelectorAll<HTMLElement>('[data-fold]')].sort((a, b) => Number(b.dataset.fold) - Number(a.dataset.fold));
      for (const f of fields) delete f.dataset.folded;
      delete slot.dataset.cut;
      if (!over()) {
        slot.removeAttribute('title');
        return;
      }
      slot.title = slot.innerText.replace(/\s+/g, ' ').trim();
      for (const f of fields) {
        f.dataset.folded = '';
        if (!over()) return;
      }
      slot.dataset.cut = slot.clientWidth < FOLD_BELOW ? 'fold' : 'end';
    };
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    const watch = () => {
      ro?.observe(slot);
      for (const c of slot.children) ro?.observe(c);
      fit();
    };
    watch();
    const mo = new MutationObserver(watch);
    mo.observe(slot, { subtree: true, childList: true, characterData: true });
    return () => {
      mo.disconnect();
      ro?.disconnect();
    };
  }, []);

  // Q / E step through the open page's own tabs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.defaultPrevented) return;
      const k = e.key.toLowerCase();
      if (k !== 'q' && k !== 'e' && k !== 'escape') return;
      if (isEditable(e.target) || isEditable(document.activeElement)) return;
      if (document.querySelector('[role="dialog"], [aria-modal="true"], [role="menu"], [role="listbox"][data-overlay]')) return;
      if (k === 'escape') {
        e.preventDefault();
        home();
        return;
      }
      // 设置's group cells are buttons with data-tab, selected by data-on.
      const tabs = [...(bar.current?.querySelectorAll<HTMLElement>('[role="tab"], [data-tab]') ?? [])];
      const idx = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true' || t.hasAttribute('data-on'));
      const next = tabs[(idx + (k === 'q' ? -1 : 1) + tabs.length) % tabs.length];
      if (idx < 0 || !next) return;
      e.preventDefault();
      next.click();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeId]);

  return (
    <nav ref={nav} className={`${styles.cmdbar} ${more.squeeze}`} aria-label="主导航" data-theme="dark" data-squeeze={squeeze || undefined}>
      <div className={styles.lead}>
        <button type="button" className={styles.back} onClick={home} aria-label="回主页" title="回主页">
          <Icon name="chevl" size={16} />
          <span>主页</span>
          <Kbd>esc</Kbd>
        </button>
        <div className={styles.tools} data-nav-target="page">
          <Menu label={squeeze >= 2 ? title : [title, tabName ?? sub].filter(Boolean).join(' / ')} items={menuItems} />
        </div>
      </div>
      <div ref={bar} className={styles.tabs} data-g="tabs">
        <span className={`${styles.key} ${styles.keyQ}`} aria-hidden="true">
          <Kbd>Q</Kbd>
        </span>
        <button type="button" className={more.more} data-dir="prev" hidden={!hidden.prev} tabIndex={-1} aria-label="向左滚动页签" title="向左滚动页签" onClick={() => page(-1)}>
          <Icon name="chevl" size={16} />
        </button>
        <div className={styles.plate} ref={tabsRef} data-slot="tabs" />
        <button type="button" className={more.more} data-dir="next" hidden={!hidden.next} tabIndex={-1} aria-label="向右滚动页签" title="向右滚动页签" onClick={() => page(1)}>
          <Icon name="chev" size={16} />
        </button>
        <span className={`${styles.key} ${styles.keyE}`} aria-hidden="true">
          <Kbd>E</Kbd>
        </span>
      </div>
      <div className={styles.right}>
        <div className={styles.slot} ref={rightRef} data-slot="status" />
        <div className={styles.slot} ref={actionRef} data-slot="action" />
        <div className={styles.status} data-lamp={worst.lamp} title={status.lights.map((l) => `${l.label}：${l.state}`).join('，')}>
          <Menu label={worst.lamp === 'ok' ? worst.state : `${worst.label}${worst.state}`} items={statusItems} align="right" />
        </div>
      </div>
    </nav>
  );
}
