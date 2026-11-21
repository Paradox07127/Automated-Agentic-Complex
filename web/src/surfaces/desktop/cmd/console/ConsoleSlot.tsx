import { useId, useState } from 'react';
import { getBridge, type DesktopState } from '../../../../bridge';
import { navRoute, type NavTarget } from '../../../../shell/nav';
import { Btn, Icon } from '../../../../ui';
import { pendingCount } from '../actions';
import { consoleDemo } from './demos';
import { States } from './Tiles';
import styles from './ConsoleSlot.module.css';

interface ConsoleSlotProps {
  state: DesktopState | null;
  presence: unknown;
  close: () => void;
  maxHeight?: number | undefined;
}

/** Menu bar popover. Keep shortcuts here and the full task, session and service views in the main window. */
export function ConsoleSlot({ state, presence, close, maxHeight }: ConsoleSlotProps) {
  const bridge = getBridge();
  const [note, setNote] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const [working, setWorking] = useState<'input' | 'ring' | 'restart' | null>(null);
  const [demo] = useState(consoleDemo);
  const detailsId = useId();
  const process = state?.pips.agentd.state;
  const starting = process === 'starting' || process === 'backoff';
  const offline = demo.agentdDown || (process != null && process !== 'running' && process !== 'external');
  const total = offline ? 0 : pendingCount(presence);

  const go = (target: NavTarget) => {
    bridge.window.openMain(navRoute(target));
    close();
  };
  const openDesktop = async (target: 'input' | 'ring') => {
    setNote(null);
    setWorking(target);
    try {
      if (target === 'input') await bridge.desktop.action('quickInput');
      else await bridge.desktop.action('cmdMode', 'ring');
      close();
    } catch {
      setNote(target === 'input' ? '未能打开快速输入，请重试。' : '未能打开命令环，请重试。');
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

  return (
    <section
      className={styles.card}
      style={maxHeight === undefined ? undefined : { maxHeight }}
      data-slot="console"
      data-region=""
      role="dialog"
      aria-label="Agentic Complex 菜单"
    >
      <header className={styles.head}>
        <span className={styles.mark} aria-hidden="true"><Icon name="grid" size={16} /></span>
        <span className={styles.name}>Agentic Complex</span>
        <button type="button" className={styles.close} aria-label="关闭菜单" onClick={close}>
          <Icon name="close" size={20} />
        </button>
      </header>
      <div className={styles.body}>
        <button type="button" className={styles.primary} onClick={() => go({ page: 'overview' })}>
          <Icon name="side" size={20} />
          <span>打开主窗口</span>
          <Icon name="chev" size={20} />
        </button>
        <nav className={styles.shortcuts} aria-label="快捷操作">
          <button type="button" className={styles.shortcut} aria-busy={working === 'input'} disabled={offline || working != null}
            title={offline ? '后台服务未连接' : undefined} onClick={() => void openDesktop('input')}>
            <Icon name="send" />
            <span>快速输入</span>
            {state?.hotkeys.hk_quick && <kbd>{state.hotkeys.hk_quick}</kbd>}
          </button>
          <button type="button" className={styles.shortcut} aria-busy={working === 'ring'} disabled={working != null}
            onClick={() => void openDesktop('ring')}>
            <Icon name="grid" />
            <span>命令环</span>
            {state?.hotkeys.hk_wheel && <kbd>{state.hotkeys.hk_wheel}</kbd>}
          </button>
          <button type="button" className={styles.shortcut} onClick={() => go({ page: 'settings' })}>
            <Icon name="tune" />
            <span>设置</span>
          </button>
        </nav>
        {total > 0 && (
          <button type="button" className={styles.pending} data-sec="waiting" onClick={() => go({ page: 'overview', focus: 'pending' })}>
            <Icon name="bell" />
            <span>{total} 项待处理</span>
            <Icon name="chev" />
          </button>
        )}
        {offline && (
          <div className={styles.recovery} data-fix="后台" role="status">
            <span><Icon name="warn" />{starting ? '后台服务正在启动' : '后台服务未连接'}</span>
            <div>
              {!starting && <Btn size="sm" variant="secondary" loading={working === 'restart'} onClick={() => !working && void restart()}>重启后台</Btn>}
              <Btn size="sm" onClick={() => go({ page: 'diag', item: 'agentd' })}>查看诊断</Btn>
            </div>
          </div>
        )}
        <button type="button" className={styles.options} aria-expanded={details} aria-controls={details ? detailsId : undefined} onClick={() => setDetails((open) => !open)}>
          <Icon name="side" />
          <span>桌面选项</span>
          <Icon name={details ? 'chevd' : 'chev'} />
        </button>
        {details && <div id={detailsId}><States state={state} offline={offline} say={setNote} /></div>}
        {note && <p className={styles.note} role="status">{note}</p>}
      </div>
    </section>
  );
}
