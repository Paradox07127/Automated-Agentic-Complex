import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Icon, type IconName } from '../Icon';
import styles from './GameWheel.module.css';

/** 轮盘的一格。 */
export interface GameWheelItem {
  id: string;
  label: string;
  icon: IconName;
  /** 指着这一格时中心写的一行作用 */
  desc?: string;
  /** 图标右上的橙色数 */
  count?: number;
  /** 做不了的原因：图标变禁用红，中心写原因，点了不关轮盘 */
  off?: string;
  /** 开着的开关：名字下一道黄线 */
  on?: boolean;
}

/** 中心空闲时的三行。 */
export interface GameWheelCenter {
  /** 英文微标 */
  en: string;
  name: string;
  desc: string;
}

/** 游戏通用能力轮盘（generalabilitypanel_pc 按 0.5 缩）：暗盘、外环带缺口、扇区细框、刻度菱点；指着的格亮扇形光、高亮弧和黄箭头，图标在外圈带右下影子和小号编号，中心写名字和作用；指针在中心 30 px 里是取消、亮红环。一层 8 格以内，点了就执行。按住拖选（按住超过 200 ms 松开 = 选指针所在的格，在中心松开 = 取消），短按松开 = 轮盘留着、再点一格执行；1–8 直接执行，←↑ / Shift+Tab 逆时针、→↓ / Tab 顺时针，Enter 执行，Esc、点中心、再按右键关。靠边时圆心平移让整盘留在屏内，平移后指针动过 4 px 才开始选格。深浅主题都画成深色。右键轮盘和热键轮盘是这同一个。 */
export interface GameWheelProps {
  items: readonly GameWheelItem[];
  /** 中心空闲时：AGENTIC COMPLEX / 她的名字 / 待命 */
  center: GameWheelCenter;
  /** 圆心，相对外层定位框（铺满桌面的那一层）；不给时轮盘随排版放在原地 */
  origin?: { x: number; y: number };
  /** 外层定位框的大小，靠边平移用；默认窗口大小 */
  bounds?: { width: number; height: number };
  /** 由按下打开、键还按着：松开时按按住的时长决定是执行还是留着 */
  held?: boolean;
  /** 读屏名称，默认「快捷轮盘」 */
  label?: string;
  onRun: (id: string) => void;
  onClose: () => void;
}

/** Radii from generalabilitypanel_pc at half size. */
const R = { line: 99, bg: 117, shade: 95, frame: 96.5, arrow: 108, icon: 133, cancel: 30, cancelRing: 60, wedgeIn: 90, wedgeOut: 208 } as const;
/** How far the wheel reaches from its centre (icons and their names), plus the edge kept clear. */
const EXTENT = 178 + 8;
/** Room under the wheel for the key help line. */
const HELP = 32;
/** A press held longer than this, then released, picks; a shorter one leaves the wheel open. */
const TAP_MS = 200;
/** After the centre was moved off the pointer, the pointer must move this far before it selects. */
const SETTLE_PX = 4;
const HALF = 260;
const SLOTS = 8;

const ang = (i: number) => -Math.PI / 2 + (i * Math.PI) / 4;
const pt = (r: number, a: number) => `${(r * Math.cos(a)).toFixed(2)} ${(r * Math.sin(a)).toFixed(2)}`;
const arc = (r: number, a0: number, a1: number) => `M${pt(r, a0)}A${r} ${r} 0 0 1 ${pt(r, a1)}`;

type Sel = number | 'cancel' | null;

/** The slot under a point `dx`, `dy` from the centre: the centre circle cancels, anywhere else picks the nearest 45° sector. */
export function wheelPick(dx: number, dy: number, count: number): Sel {
  if (Math.hypot(dx, dy) <= R.cancel) return 'cancel';
  const i = (((Math.round((Math.atan2(dy, dx) + Math.PI / 2) / (Math.PI / 4)) % SLOTS) + SLOTS) % SLOTS);
  return i < count ? i : null;
}

/** The centre moved inward so the whole wheel and its help line stay inside `bounds`. */
export function wheelCentre(o: { x: number; y: number }, bounds: { width: number; height: number }): { x: number; y: number } {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(Math.max(lo, hi), v));
  return { x: clamp(o.x, EXTENT, bounds.width - EXTENT), y: clamp(o.y, EXTENT, bounds.height - EXTENT - HELP) };
}

export function GameWheel({ items, center, origin, bounds, held = false, label = '快捷轮盘', onRun, onClose }: GameWheelProps) {
  const root = useRef<HTMLDivElement>(null);
  const uid = useId().replace(/[^\w-]/g, '');
  const [sel, setSel] = useState<Sel>(null);
  const n = Math.min(items.length, SLOTS);
  const box = bounds ?? (typeof window === 'undefined' ? { width: 0, height: 0 } : { width: window.innerWidth, height: window.innerHeight });
  const c = origin ? wheelCentre(origin, box) : null;
  const moved = !!(origin && c && (c.x !== origin.x || c.y !== origin.y));
  // Live values the window listeners read.
  const live = useRef({ sel, held, opened: 0, settled: !moved, origin, items, onRun, onClose });
  live.current = { ...live.current, sel, items, onRun, onClose, origin };

  const run = (i: number) => {
    const it = live.current.items[i];
    if (!it) return;
    if (it.off) setSel(i);
    else live.current.onRun(it.id);
  };
  const runRef = useRef(run);
  runRef.current = run;

  useLayoutEffect(() => {
    live.current.opened = performance.now();
    root.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const centreOf = () => {
      const r = root.current?.getBoundingClientRect();
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 0, y: 0 };
    };
    const pick = (e: PointerEvent) => {
      const m = centreOf();
      return wheelPick(e.clientX - m.x, e.clientY - m.y, live.current.items.length);
    };
    const onMove = (e: PointerEvent) => {
      const l = live.current;
      if (!l.settled) {
        const m = centreOf();
        const o = l.origin && c ? { x: m.x + (l.origin.x - c.x), y: m.y + (l.origin.y - c.y) } : m;
        if (Math.hypot(e.clientX - o.x, e.clientY - o.y) < SETTLE_PX) return;
        l.settled = true;
      }
      setSel(pick(e));
    };
    const onUp = (e: PointerEvent) => {
      const l = live.current;
      if (!l.held) return;
      l.held = false;
      // A short press leaves the wheel open for a second, separate pick.
      if (performance.now() - l.opened <= TAP_MS) return;
      const s = pick(e);
      if (s === 'cancel') l.onClose();
      else if (typeof s === 'number') runRef.current(s);
    };
    const onDown = (e: PointerEvent) => {
      if (live.current.held) return;
      if (e.button === 2) {
        live.current.onClose();
        return;
      }
      if (e.button !== 0) return;
      const s = pick(e);
      if (s === 'cancel') live.current.onClose();
      else if (typeof s === 'number') runRef.current(s);
    };
    const noMenu = (e: Event) => e.preventDefault();
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('contextmenu', noMenu);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('contextmenu', noMenu);
    };
    // The listeners read everything else through `live`; the centre only moves with a new origin.
  }, [c?.x, c?.y]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const k = Number(e.key);
    if (e.key === 'Escape') onClose();
    else if (k >= 1 && k <= n) run(k - 1);
    else if ((e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'Tab') && !e.shiftKey) setSel((s) => (typeof s === 'number' ? (s + 1) % n : 0));
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) setSel((s) => (typeof s === 'number' ? (s + n - 1) % n : n - 1));
    else if (e.key === 'Enter' && typeof sel === 'number') run(sel);
    else return;
    e.preventDefault();
  };

  const cur = typeof sel === 'number' ? items[sel] : undefined;
  const place: CSSProperties | undefined = c ? { position: 'absolute', left: c.x - HALF, top: c.y - HALF } : undefined;
  return (
    <div ref={root} className={styles.wheel} style={place} data-stub="GameWheel" role="menu" aria-label={label} tabIndex={-1} onKeyDown={onKey}>
      <div className={styles.vignette} aria-hidden="true" />
      <div className={styles.content}>
        <svg className={styles.svg} viewBox="0 0 520 520" width="520" height="520" aria-hidden="true">
          <defs>
            <radialGradient id={`${uid}w`} cx="0" cy="0" r={R.wedgeOut} gradientUnits="userSpaceOnUse">
              <stop offset=".43" stopColor="#fff" stopOpacity=".55" />
              <stop offset=".7" stopColor="#fff" stopOpacity=".16" />
              <stop offset="1" stopColor="#fff" stopOpacity="0" />
            </radialGradient>
            <filter id={`${uid}g`} x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="1.6" />
              <feMerge>
                <feMergeNode />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter id={`${uid}b`} x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="10" />
            </filter>
          </defs>
          <g transform={`translate(${HALF} ${HALF})`}>
            {/* The shade disc and the dark disc sit low and right of the centre: the game lights from above left. */}
            <circle cx="4" cy="30" r={R.shade} className={styles.shade} filter={`url(#${uid}b)`} />
            <circle cy="9.5" r={R.bg} className={styles.disc} />
            {typeof sel === 'number' && (
              <g data-sel-slot={sel}>
                <path
                  d={`M${pt(R.wedgeIn, ang(sel) - 0.371)}A${R.wedgeIn} ${R.wedgeIn} 0 0 1 ${pt(R.wedgeIn, ang(sel) + 0.371)}L${pt(R.wedgeOut, ang(sel) + 0.371)}L${pt(R.wedgeOut, ang(sel) - 0.371)}Z`}
                  fill={`url(#${uid}w)`}
                />
                <path d={arc(R.line + 1, ang(sel) - 0.351, ang(sel) + 0.351)} className={styles.lit} filter={`url(#${uid}g)`} />
                <path d={`M${pt(R.arrow + 8, ang(sel))}L${pt(R.arrow, ang(sel) - 0.065)}L${pt(R.arrow, ang(sel) + 0.065)}Z`} className={styles.arrow} />
              </g>
            )}
            {/* The outer line with its gap at the top right, and a short second line beside the gap. */}
            <path d={arc(R.line, -Math.PI / 2 + 0.52, (3 * Math.PI) / 2 + 0.12)} className={styles.line} />
            <path d={arc(R.line + 6, -1.05, -0.62)} className={styles.lineThin} />
            {items.slice(0, n).map((it, i) => (
              <g key={it.id}>
                <path d={arc(R.frame - 3, ang(i) - 0.332, ang(i) + 0.332)} className={styles.frame} data-on={sel === i || undefined} />
                <path d={arc(R.frame - 8, ang(i) - 0.282, ang(i) + 0.282)} className={styles.frameGlow} filter={`url(#${uid}g)`} />
                <rect x="-3" y="-3" width="6" height="6" className={styles.tick} transform={`translate(${pt(R.bg - 8, ang(i) + Math.PI / 8)}) rotate(45)`} />
              </g>
            ))}
            <circle r={R.cancel} className={styles.cancel} data-on={sel === 'cancel' || undefined} />
            {sel === 'cancel' && <circle r={R.cancelRing} className={styles.cancelRing} />}
          </g>
        </svg>
        {items.slice(0, n).map((it, i) => (
          <span
            key={it.id}
            className={styles.slot}
            role="menuitem"
            aria-disabled={it.off ? true : undefined}
            aria-label={`${i + 1} ${it.label}${it.count ? ` ${it.count}` : ''}`}
            data-sel={sel === i || undefined}
            data-off={it.off ? '' : undefined}
            data-on={it.on || undefined}
            style={{ left: HALF + R.icon * Math.cos(ang(i)), top: HALF + R.icon * Math.sin(ang(i)) - 16 }}
          >
            <span className={styles.icon} aria-hidden="true">
              <Icon name={it.icon} size={32} />
            </span>
            <span className={styles.name} aria-hidden="true">
              {it.label}
            </span>
            <span className={styles.no} aria-hidden="true">{`0${i + 1}`}</span>
            {it.count ? <span className={styles.badge} aria-hidden="true">{it.count}</span> : null}
          </span>
        ))}
        <div className={styles.center} aria-live="polite">
          <div className={styles.en} aria-hidden="true">
            {sel === 'cancel' ? 'CANCEL' : cur ? `0${(sel as number) + 1}` : center.en}
          </div>
          <div className={styles.title}>{sel === 'cancel' ? '取消' : cur ? cur.label : center.name}</div>
          <div className={styles.rule} aria-hidden="true" />
          <div className={styles.desc} data-bad={cur?.off ? '' : undefined}>
            {sel === 'cancel' ? '松开或点一下就关' : cur ? (cur.off ?? cur.desc ?? '') : center.desc}
          </div>
        </div>
      </div>
      <div className={styles.help} aria-hidden="true">
        <kbd>1</kbd>–<kbd>{n}</kbd> 直接执行 │ <kbd>←</kbd>
        <kbd>→</kbd> 选 │ <kbd>Esc</kbd> 关闭
      </div>
    </div>
  );
}

const noop = () => undefined;
const ITEMS: GameWheelItem[] = [
  { id: 'chat', label: '对话页', icon: 'file', desc: '主窗口打开对话' },
  { id: 'pending', label: '待处理', icon: 'bell', desc: '2 项待处理', count: 2 },
  { id: 'quiet', label: '免打扰', icon: 'moon', desc: '30 分钟里她不主动说话' },
  { id: 'pass', label: '点穿', icon: 'hand', desc: '点击穿过她；⌃⌥P 恢复' },
  { id: 'home', label: '放回原位', icon: 'loc', desc: '她和浮窗回到默认位置' },
  { id: 'roam', label: '自由活动', icon: 'sync', desc: '开着：她会在屏幕上走动', on: true },
  { id: 'gift', label: '送礼物', icon: 'redeem', desc: '看她收礼的动作', off: '这个角色没有收礼的动作' },
  { id: 'char', label: '角色页', icon: 'user', desc: '换角色、外观、姿态、镜头' },
];
const CENTER: GameWheelCenter = { en: 'AGENTIC COMPLEX', name: '示例乙', desc: '待命' };

export const GameWheelDemos: Array<{ name: string; props: GameWheelProps }> = [
  { name: 'idle', props: { items: ITEMS, center: CENTER, onRun: noop, onClose: noop } },
];
