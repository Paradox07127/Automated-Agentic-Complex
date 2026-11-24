import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { gameClips } from '../design/gameClips.generated';
import type { Severity } from '../domain';
import { Btn } from './Btn';
import { fxCalm, useGameClip } from './fx';
import { animate } from './fx/motion';
import { Icon, type IconName } from './Icon';
import { IconBtn } from './IconBtn';
import styles from './Toast.module.css';

/** Toast：普通条为深色点角板，系统级为带图标列的框；停留 2.5 s，带操作的 4 s，带操作的出错类不自动消失。 */
export interface ToastProps {
  /** 文字 */
  message: string;
  /** 普通 / 系统级，默认 normal */
  kind?: 'normal' | 'system';
  /** 语义，默认 neutral */
  severity?: Severity;
  /** 系统级左侧图标 */
  icon?: IconName;
  /** 操作，例如「重新派发」 */
  action?: { label: string; onClick?: () => void };
  /** 不自动消失（出错类） */
  persistent?: boolean;
  /** 消失时（超时、关闭、点了操作）通知队列 */
  onClose?: () => void;
}

const HOLD = 2500;
const HOLD_ACTION = 4000;
/** Matches --ef-dur-g-toast-out: the toast stays mounted while its exit plays. */
const OUT = 167;
/** systemtoast_in is in, hold and out in one clip; it holds at SYS_HOLD until the toast leaves. */
const SYS_HOLD = 2783;
const SYS_OUT = gameClips.systemToastIn.duration - SYS_HOLD;
/** Its scales are relative to the prefab, which rests at scaleY 0.1; this toast rests at full size. */
const SYS_REST_Y = 0.1;

function sysValue(property: string, v: number | string): number | string {
  if (property !== 'scale') return v;
  const [x = 1, y = x] = String(v).split(' ').map(Number);
  return `${x} ${y * SYS_REST_Y}`;
}
const GLYPH: Partial<Record<Severity, string>> = {
  danger: 'M1.2 1.2h7.6v7.6H1.2z',
  warning: 'M5 .8 9.6 9.2H.4z',
  success: 'M1.2 5.2 4 8l5-5.6',
  info: 'M5 2.4a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2z',
};

const isStill = () => typeof document !== 'undefined' && document.documentElement.classList.contains('still');

/** Plays systemToastIn on root up to the hold; the returned leave() runs the rest. */
function useSystemClip(root: RefObject<HTMLDivElement | null>, on: boolean): () => void {
  const anims = useRef<Animation[]>([]);
  useEffect(() => {
    const el = root.current;
    if (!on || !el) return;
    const clip = gameClips.systemToastIn;
    const timing: KeyframeAnimationOptions = { duration: clip.duration, endDelay: SYS_HOLD - clip.duration, fill: 'both' };
    anims.current = clip.tracks.flatMap((t) =>
      [...el.querySelectorAll(`[data-g="${t.key}"]`), ...(el.matches(`[data-g="${t.key}"]`) ? [el] : [])].flatMap(
        (n) => animate(n, t.keyframes.map((k) => ({ offset: k.offset, easing: k.easing, [t.property]: sysValue(t.property, k.value) })), timing) ?? [],
      ),
    );
    if (fxCalm()) for (const a of anims.current) a.finish();
    return () => {
      for (const a of anims.current) a.cancel();
      anims.current = [];
    };
  }, [root, on]);
  return useCallback(() => {
    for (const a of anims.current) {
      a.currentTime = Math.max(Number(a.currentTime ?? 0), SYS_HOLD);
      a.effect?.updateTiming({ endDelay: 0 });
      a.play();
      if (fxCalm()) a.finish();
    }
  }, []);
}

export function Toast({ message, kind = 'normal', severity = 'neutral', icon, action, persistent, onClose }: ToastProps) {
  const [hover, setHover] = useState(false);
  const [gone, setGone] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const sys = kind === 'system';
  useGameClip(gameClips.toastIn, root, { autoplay: !sys });
  const out = useGameClip(gameClips.toastOut, root);
  const sysLeave = useSystemClip(root, sys);
  const sticky = persistent || (severity === 'danger' && action != null);
  const hold = action ? HOLD_ACTION : HOLD;
  const latest = useRef(onClose);
  latest.current = onClose;
  const left = useRef(false);
  const close = useCallback(() => {
    if (left.current) return;
    left.current = true;
    setLeaving(true);
    if (sys) sysLeave();
    else void out.play();
    setTimeout(
      () => {
        setGone(true);
        latest.current?.();
      },
      sys ? SYS_OUT : OUT,
    );
  }, [sys, sysLeave, out]);

  // No mouseleave arrives when the pointer exits the window from the toast or the app loses focus, so hover would stick.
  useEffect(() => {
    if (!hover) return;
    const off = () => setHover(false);
    window.addEventListener('blur', off);
    document.documentElement.addEventListener('mouseleave', off);
    return () => {
      window.removeEventListener('blur', off);
      document.documentElement.removeEventListener('mouseleave', off);
    };
  }, [hover]);

  // Hover pauses the timer; sticky toasts and still screenshots never time out.
  useEffect(() => {
    if (sticky || hover || leaving || isStill()) return;
    const t = setTimeout(close, hold);
    return () => clearTimeout(t);
  }, [sticky, hover, leaving, close, hold]);

  if (gone) return null;

  const d = GLYPH[severity];
  return (
    // The toast surface is dark in both themes, so its content reads dark-theme tokens.
    <div
      ref={root}
      data-theme="dark"
      role={severity === 'danger' ? 'alert' : 'status'}
      className={styles.toast}
      data-stub="Toast"
      data-kind={kind}
      data-severity={severity}
      data-icon={icon}
      data-persistent={sticky || undefined}
      data-leaving={leaving || undefined}
      inert={leaving}
      data-g={sys ? 'sysToast' : 'toast'}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {kind === 'system' ? (
        <>
          <span className={styles.sysBg} data-g="sysBg" aria-hidden="true" />
          <span className={styles.sysIcon} data-g="sysIcon">
            {icon ? <Icon name={icon} size={20} /> : null}
          </span>
          <span className={styles.sysRule} aria-hidden="true" />
        </>
      ) : (
        d && (
          <svg className={styles.glyph} data-g="label" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d={d} fill={severity === 'success' ? 'none' : 'currentColor'} stroke={severity === 'success' ? 'currentColor' : 'none'} strokeWidth="1.9" />
          </svg>
        )
      )}
      <span className={styles.msg} data-g={sys ? 'sysText' : 'text'}>
        {message}
      </span>
      {action && (
        <span className={styles.action} data-g={sys ? undefined : 'label'}>
          <Btn
            variant="quiet"
            size="sm"
            onClick={() => {
              // One shot: a second press during the exit finds the toast already leaving.
              if (left.current) return;
              close();
              action.onClick?.();
            }}
          >
            {action.label}
          </Btn>
        </span>
      )}
      {sticky && <IconBtn icon="close" label="关闭" size="sm" onClick={close} />}
    </div>
  );
}

export const ToastDemos: Array<{ name: string; props: ToastProps }> = [
  { name: 'normal', props: { message: '已停止「汇总 10 月开销表」', action: { label: '重新派发' } } },
  { name: 'success', props: { message: '已批准 2 张 │ 同一会话', severity: 'success' } },
  { name: 'warning', props: { message: '只能用鼠标点击危险批准', severity: 'warning' } },
  { name: 'error', props: { message: '重新派发失败：内核未就绪', severity: 'danger', persistent: true, action: { label: '看出错' } } },
  { name: 'system', props: { message: '已恢复连接', kind: 'system', severity: 'success', icon: 'ok' } },
];
