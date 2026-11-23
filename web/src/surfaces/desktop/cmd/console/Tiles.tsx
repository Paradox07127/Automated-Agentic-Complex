import { useRef, useState } from 'react';
import { getBridge, type DesktopState } from '../../../../bridge';
import { formatClock } from '../../../../domain';
import { WatchKey, type Box } from '../../../../ui/game';
import { runCmdAction, type RunItem } from '../ring/run';
import styles from './ConsoleSlot.module.css';

/** The switches' actions, named as their failures say. */
const SWITCHES: RunItem[] = [
  { id: 'hide', label: '隐藏 30 分' },
  { id: 'show', label: '显示角色' },
  { id: 'quiet', label: '免打扰 30 分' },
  { id: 'quietEnd', label: '结束免打扰' },
  { id: 'pass', label: '让鼠标穿过她' },
];

interface KeysProps {
  state: DesktopState | null;
  /** agentd does not answer: 快速输入 and 免打扰 need it. */
  offline: boolean;
  /** Her renderer is not running: 隐藏她 and 全部点穿 act on it. */
  noAvatar: boolean;
  tight: boolean;
  quickInput: () => void;
  quickBusy: boolean;
  say: (s: string) => void;
}

/** 快速输入, 免打扰, 隐藏她, 全部点穿: the three switches stay findable while she is hidden or clicked through; a switch keeps
 *  the popover open so its key shows the change. */
export function Keys({ state, offline, noAvatar, tight, quickInput, quickBusy, say }: KeysProps) {
  const bridge = getBridge();
  const active = useRef<RunItem['id'] | null>(null);
  const [working, setWorking] = useState(false);
  const now = Date.now();
  const run = async (id: RunItem['id']) => {
    const item = SWITCHES.find((i) => i.id === id);
    if (!item || active.current != null) return;
    active.current = id;
    setWorking(true);
    try {
      const outcome = await runCmdAction(item, { bridge, state, now: Date.now });
      if (outcome.kind === 'receipt') say(outcome.text);
    } finally {
      active.current = null;
      setWorking(false);
    }
  };
  const quiet = state?.quietUntil != null && state.quietUntil > now ? state.quietUntil : null;
  const hidden = state?.hidden ?? false;
  const hiddenUntil = state?.hiddenUntil ?? null;
  const pass = state?.clickThroughAll ?? false;
  const box: Box = { width: 72, height: tight ? 58 : 66 };
  const off = (reason: string | null) => (reason ?? (state ? undefined : '还没连上桌面层'));
  const agentdOff = offline ? '后台未连接' : null;
  const avatarOff = noAvatar ? '角色没在运行' : null;
  return (
    <div className={styles.keys} role="group" aria-label="快捷开关">
      <WatchKey box={box} icon="send" title="快速输入" sub={agentdOff ?? state?.hotkeys.hk_quick} off={off(agentdOff) ?? (quickBusy ? '正在打开' : undefined)}
        onClick={quickInput} />
      <WatchKey box={box} icon="moonz" title="免打扰" pressed={quiet != null} sub={agentdOff ?? (quiet != null ? `到 ${formatClock(quiet)}` : '30 分钟')}
        off={off(agentdOff) ?? (working ? '正在切换' : undefined)} onClick={() => void run(quiet == null ? 'quiet' : 'quietEnd')} />
      <WatchKey box={box} icon="eye" title="隐藏她" pressed={hidden} sub={avatarOff ?? (hidden ? (hiddenUntil != null ? `到 ${formatClock(hiddenUntil)}` : '已隐藏') : '30 分钟')}
        off={off(avatarOff) ?? (working ? '正在切换' : undefined)} onClick={() => void run(hidden ? 'show' : 'hide')} />
      <WatchKey box={box} icon="hand" title="全部点穿" pressed={pass} sub={avatarOff ?? (pass ? '点穿中' : state?.hotkeys.hk_pass)}
        off={off(avatarOff) ?? (working ? '正在切换' : undefined)} onClick={() => void run('pass')} />
    </div>
  );
}
