import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getBridge, type DesktopState } from '../../../../bridge';
import { keyText } from '../../../../bridge/platformText';
import { Pip } from '../../../../pages/overview/Pip';
import { navRoute, type NavTarget } from '../../../../shell/nav';
import { ErrBar, Icon } from '../../../../ui';
import { CharCard, CloseKey, DarkRow, MicroLabel, NewsBanner, StatusRow, TopIcon, WhiteCapsule, YellowKey } from '../../../../ui/game';
import { consoleDemo } from './demos';
import { doingOf, statusCells, useRecent, useRuntime, waitingOf } from './model';
import { Foot, Plate } from './Parts';
import { Keys } from './Tiles';
import styles from './ConsoleSlot.module.css';

interface ConsoleSlotProps {
  state: DesktopState | null;
  presence: unknown;
  close: () => void;
  maxHeight?: number | undefined;
}

/** The card's content width: 344 less its 1.5 px rims and the body's 12 px sides. */
const INNER = 317;
/** Below this much room under the menu bar the card takes its short form before its middle scrolls. */
const TIGHT_BELOW = 540;

/** Menu bar popover: whether all is well and what waits, the main window, and the switches that must work while she
 *  cannot be clicked. Decisions stay in the main window. */
export function ConsoleSlot({ state, presence, close, maxHeight }: ConsoleSlotProps) {
  const bridge = getBridge();
  const [note, setNote] = useState<string | null>(null);
  const [working, setWorking] = useState<'input' | 'restart' | null>(null);
  const [demo] = useState(consoleDemo);
  const runtime = useRuntime();
  const recent = useRecent();
  const roster = useQuery({ queryKey: ['character', 'list'], queryFn: () => bridge.character.list(), enabled: bridge.capabilities.avatar, retry: false });
  const cardRef = useRef<HTMLElement>(null);
  const process = state?.pips.agentd.state;
  const starting = process === 'starting' || process?.startsWith('backoff');
  const offline = demo.agentdDown || (process != null && process !== 'running' && process !== 'external');
  const configError = demo.configError ?? runtime?.config_error ?? null;
  const noAvatar = runtime != null && !['running', 'external'].includes(runtime.processes.avatar.state);
  const tight = maxHeight !== undefined && maxHeight < TIGHT_BELOW;
  const waiting = offline ? null : waitingOf(presence);
  const unread = recent.filter((r) => r.unread);
  const character = state?.character ?? null;
  const head = roster.data?.find((c) => c.active)?.head ?? null;

  // Opened, the keyboard is on 打开主窗口: Return goes to the main window.
  useEffect(() => {
    cardRef.current?.querySelector<HTMLButtonElement>('[data-stub="YellowKey"]')?.focus({ preventScroll: true });
  }, []);

  const go = (target: NavTarget) => {
    bridge.window.openMain(navRoute(target));
    close();
  };
  const quickInput = async () => {
    setNote(null);
    setWorking('input');
    try {
      await bridge.desktop.action('quickInput');
      close();
    } catch {
      setNote('未能打开快速输入，请重试。');
    } finally {
      setWorking(null);
    }
  };
  const restart = async () => {
    setNote(null);
    setWorking('restart');
    try {
      await bridge.supervisor.restart('agentd');
      setNote('已请求重启后台');
    } catch {
      setNote('未能重启后台，请在诊断中查看详情。');
    } finally {
      setWorking(null);
    }
  };
  const openAnnouncement = (id: string) => {
    void bridge.desktop.openAnnouncement(id).then(close, () => setNote('未能打开这条播报，请重试。'));
  };
  const markAllRead = () => {
    void bridge.desktop.markAllRead().catch(() => setNote('未能标为已读，请重试。'));
  };

  const cells = statusCells(runtime, state?.pips.helper, offline);
  return (
    <section ref={cardRef} className={styles.card} style={maxHeight === undefined ? undefined : { maxHeight }} data-slot="console" data-region="" data-tight={tight || undefined}
      role="dialog" aria-label="Agentic Complex 菜单">
      <Plate />
      <header className={styles.head}>
        <span className={styles.slash} aria-hidden="true" />
        <span className={styles.ttl}>
          <MicroLabel>Menu Bar</MicroLabel>
          <b>Agentic Complex</b>
        </span>
        <TopIcon box={{ width: 44, height: 44 }} icon="tune" label="设置" named onClick={() => go({ page: 'settings' })} />
        <CloseKey box={{ width: 26, height: 26 }} label="关闭菜单" onClick={close} />
      </header>
      <div className={styles.body}>
        {cells.length > 0 && (
          <div className={styles.status}>
            <StatusRow items={cells.map((c) => ({ name: c.name, failed: c.tone === 'failed', state: <Pip tone={c.tone} label={c.label} /> }))} />
          </div>
        )}
        {configError != null ? (
          <div className={styles.err} data-fix="配置" role="group" aria-label="配置出错">
            <ErrBar message={`配置读不了：${configError}`} />
            <div className={styles.acts}>
              <WhiteCapsule label="打开设置" icon="tune" tone="accent" onClick={() => go({ page: 'settings' })} />
              <WhiteCapsule label="查看诊断" icon="radio" onClick={() => go({ page: 'diag', item: 'agentd' })} />
            </div>
          </div>
        ) : (
          <>
            {offline && (
              <div className={styles.err} data-fix="后台" role="group" aria-label="后台出错">
                <ErrBar tone={starting ? 'warning' : 'danger'} message={starting ? '后台正在启动，好了会自动接上' : '后台没有响应，她听不到你'} />
                {!starting && (
                  <div className={styles.acts}>
                    <WhiteCapsule label="重启后台" icon="refresh" tone="accent" disabled={working === 'restart'} disabledReason="正在重启"
                      onClick={() => void restart()} />
                    <WhiteCapsule label="查看诊断" icon="radio" onClick={() => go({ page: 'diag', item: 'agentd' })} />
                  </div>
                )}
              </div>
            )}
            <CharCard box={{ width: INNER, height: tight ? 52 : 66 }} compact name={character?.name ?? '她'} head={head} id={character?.id ?? null}
              doing={offline ? '—' : (doingOf(presence) ?? '—')} onClick={() => go({ page: 'character' })} />
            <YellowKey label="打开主窗口" icon="side" micro="Home" block hint={keyText('⌘0')} onClick={() => go({ page: 'home' })} />
            {waiting && (
              <div data-sec="waiting">
                <DarkRow title={waiting.title} sub={waiting.kind} mark="new" compact onPress={() => go({ page: 'overview', focus: 'pending' })}
                  end={<span className={styles.more}>{waiting.total > 1 && `还有 ${waiting.total - 1} 项`}<Icon name="chev" size={16} /></span>} />
              </div>
            )}
            {unread.length > 0 && (
              <NewsBanner box={{ width: INNER, height: tight ? 62 : 70 }} still={document.documentElement.classList.contains('still')}
                items={unread.map((r) => ({ kind: '播报', title: r.text, at: r.time, go: () => openAnnouncement(r.id) }))}
                count={unread.length} onReadAll={markAllRead} />
            )}
            <Keys state={state} offline={offline} noAvatar={noAvatar} tight={tight} quickInput={() => void quickInput()} quickBusy={working === 'input'}
              say={setNote} />
          </>
        )}
        {note && <p className={styles.note} role="status">{note}</p>}
      </div>
      <Foot quit={() => void bridge.desktop.action('quit')} />
    </section>
  );
}
