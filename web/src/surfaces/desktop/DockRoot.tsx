import { useEffect, useRef, useState } from 'react';
import { getBridge, type DesktopState } from '../../bridge';
import { formatClock } from '../../domain';
import { navRoute } from '../../shell/nav';
import { useSystemTheme } from '../../shell/useSystemTheme';
import { OptionStack, type OptionStackItem } from '../../ui/game/OptionStack';
import { stackQuery } from '../stack/demos';
import { useContentSize } from './hooks/useContentSize';
import { useDesktopState } from './hooks/useDesktopState';
import { useMountedLog } from './hooks/useMountedLog';
import { usePresence } from './hooks/usePresence';
import { useRegions } from './hooks/useRegions';
import { readPresence } from './tags/presence';
import styles from './DockRoot.module.css';

/** A press of 说话 released sooner than this starts a recording that the next click sends. */
export const TAP_MS = 200;

export type DockId = 'chat' | 'talk' | 'look' | 'hide';
/** 说话's recording: `hold` ends at the release, `tap` at the next click. */
export type Talk = 'hold' | 'tap' | null;

/** The rows in order; 对话, 说话 and 给她看 need agentd, 给她看 also 屏幕识读, and say 已关闭 / 未接入 when they cannot. While she
 *  records only 说话 is left. */
export function dockItems(s: DesktopState | null, presence: unknown, talk: Talk): OptionStackItem[] {
  const p = readPresence(presence);
  const away = p.offline ? '未接入：连不上后台' : undefined;
  const voice: OptionStackItem = {
    id: 'talk',
    label: talk === 'hold' ? '在听…松开发送' : talk === 'tap' ? '在听…再点一下发送' : s?.pips.voice === 'off' ? '说话（只出字）' : '说话',
    icon: 'mic',
    live: talk != null,
    off: talk ? undefined : (away ?? (s?.pips.voice === 'denied' ? '未接入：没有麦克风权限，点按前往设置 › 能力 › 系统权限里允许' : undefined)),
  };
  if (talk) return [voice];
  const lookOff = s?.plugins.includes('screen_reading') ? (p.observation.paused ? '观察已暂停' : undefined) : '已关闭：设置 › 感知里关着「屏幕识读」';
  return [
    { id: 'chat', label: '对话', icon: 'g-chat', off: away },
    voice,
    { id: 'look', label: '给角色看', icon: 'look', off: away ?? lookOff },
    { id: 'hide', label: '隐藏', icon: 'eye' },
  ];
}

/**
 * `stack.html#/dock`, her hover buttons beside her chest: 对话, 说话, 给她看, 隐藏.
 * Native opens and closes them (`desktop.onState` `dock`) and places the panel; a pick closes them, but 说话, which holds
 * them while it records: held down it records until the release, a short press records until the next click.
 */
export function DockRoot() {
  const [q] = useState(stackQuery);
  const still = q.get('still') === '1';
  useSystemTheme(q.get('theme'));
  useEffect(() => {
    document.documentElement.classList.toggle('still', still);
  }, [still]);

  const state = useDesktopState();
  const presence = usePresence();
  const [talk, setTalk] = useState<Talk>(null);
  const press = useRef<{ at: number; pointer: boolean } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useRegions(rootRef);
  useContentSize(rootRef);
  useMountedLog('dock');

  const bridge = getBridge();
  const act = (name: 'quickInput' | 'look' | 'hide' | 'talk', arg?: string) => void bridge.desktop.action(name, arg).catch(() => {});
  const start = (mode: Talk) => {
    setTalk(mode);
    act('talk', 'start');
  };
  const stop = () => {
    setTalk(null);
    act('talk', 'stop');
  };

  const onPressStart = (id: string) => {
    if (id !== 'talk') return;
    press.current = { at: performance.now(), pointer: true };
    if (talk === 'tap') stop();
    else if (!talk) start('hold');
  };
  const onPressEnd = (id: string, end: 'up' | 'cancel') => {
    const p = press.current;
    if (id !== 'talk' || !p?.pointer) return;
    if (end === 'cancel') {
      // No click follows a cancelled press, so pick() has nothing to swallow.
      press.current = null;
      if (talk) stop();
      return;
    }
    if (talk !== 'hold') return;
    if (performance.now() - p.at < TAP_MS) setTalk('tap');
    else stop();
  };
  const pick = (id: string) => {
    if (id === 'talk') {
      // A click the pointer made was handled at its press; Enter or Space toggles.
      if (press.current?.pointer) press.current = null;
      else if (talk) stop();
      else start('tap');
      return;
    }
    if (id === 'chat') act('quickInput');
    else if (id === 'look') act('look');
    else if (id === 'hide') act('hide');
  };
  // 说话 greyed for the microphone alone opens its permission row in 设置.
  const pickOff = (id: string) => {
    if (id === 'talk' && state?.pips.voice === 'denied' && !readPresence(presence).offline) bridge.window.openMain(navRoute({ page: 'settings', group: 'perm', item: 'microphone' }));
  };

  const dock = state?.dock;
  const shown = !!dock?.open && state?.showHoverHints !== false && !state?.hidden;
  const quietUntil = state?.quietUntil != null && state.quietUntil > Date.now() ? state.quietUntil : null;
  return (
    <div ref={rootRef} className={styles.root} data-surface-root="dock" data-side={dock?.side}>
      {(shown || talk) && (
        <div className={styles.stack} data-region="">
          <OptionStack
            items={dockItems(state, presence, talk)}
            side={dock?.side === 'left' ? 'left' : 'right'}
            compact={dock?.compact}
            note={quietUntil != null && !talk ? `免打扰到 ${formatClock(quietUntil)}` : undefined}
            label="角色的按钮"
            onPick={pick}
            onPickOff={pickOff}
            onPressStart={onPressStart}
            onPressEnd={onPressEnd}
          />
        </div>
      )}
    </div>
  );
}
