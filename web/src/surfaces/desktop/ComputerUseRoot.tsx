import { useEffect, useRef, useState } from 'react';
import { getBridge, type ComputerUseGrant, type ComputerUsePanel, type ComputerUsePhase, type ComputerUseScope } from '../../bridge';
import { navRoute } from '../../shell/nav';
import { Btn, IconBtn } from '../../ui';
import { PowerState } from '../../ui/game';
import { useContentSize } from './hooks/useContentSize';
import styles from './ComputerUseRoot.module.css';

/** ComputerUsePhase.title. */
export const PHASE_TITLE: Record<ComputerUsePhase, string> = {
  disabled: '电脑操作已关闭',
  ready: '等待你的任务',
  waitingPermission: '等待你的选择',
  observing: '正在查看',
  executing: '正在操作',
  verifying: '正在检查结果',
  paused: '已暂停',
  completed: '已完成',
  failed: '操作未完成',
};

const SCOPES: ComputerUseScope[] = ['observation', 'text', 'image', 'control'];
const SCOPE_TITLE: Record<ComputerUseScope, string> = { observation: '观察控件', text: '读取文字', image: '查看截图', control: '执行操作' };
const GRANT_TITLE: Record<ComputerUseGrant, string> = { off: '未启用', allowed: '已允许', systemPermissionRequired: '需系统授权', unavailable: '不可用' };

const grantOf = (p: ComputerUsePanel, s: ComputerUseScope): ComputerUseGrant => p.permissions[s] ?? 'off';
const canRequest = (p: ComputerUsePanel, s: ComputerUseScope) =>
  !p.pendingGrants.includes(s) && ['off', 'allowed', 'systemPermissionRequired'].includes(grantOf(p, s));

function Choice({ panel, scope }: { panel: ComputerUsePanel; scope: ComputerUseScope }) {
  const grant = grantOf(panel, scope);
  const allowed = grant === 'allowed';
  if (!canRequest(panel, scope)) {
    return (
      <span className={styles.choiceState} data-allowed={allowed || undefined}>
        <span>{SCOPE_TITLE[scope]}</span>
        <span>{panel.pendingGrants.includes(scope) ? '正在确认' : GRANT_TITLE[grant]}</span>
      </span>
    );
  }
  const cu = getBridge().computerUse;
  return (
    <span data-testid={`computer-use-grant-${scope}`}>
      <Btn size="sm" {...(allowed ? { icon: 'check' as const } : {})} onClick={() => void (allowed ? cu.revoke([scope], panel.challenge) : cu.grant([scope], panel.challenge))}>
        {allowed ? SCOPE_TITLE[scope] : `允许${SCOPE_TITLE[scope]}`}
        <span className={styles.hidden}>{allowed ? '已勾选，点击取消授权' : '未勾选'}</span>
      </Btn>
    </span>
  );
}

/** `stack.html#/computer`: the 电脑操作 panel. The shell places and shows it; the page only shows the
 *  host's state and asks through the buttons. */
export function ComputerUseRoot() {
  const ref = useRef<HTMLElement>(null);
  const [panel, setPanel] = useState<ComputerUsePanel | null>(null);
  useEffect(() => getBridge().computerUse.onPanel(setPanel), []);
  useContentSize(ref);
  const cu = getBridge().computerUse;
  const body = panel && (
    <>
      <div className={styles.head}>
        <i className={styles.dot} data-phase={panel.phase} aria-hidden="true" />
        <h2 className={styles.title}>{PHASE_TITLE[panel.phase]}</h2>
        <IconBtn icon="chevd" size="sm" label="收起电脑操作状态" onClick={() => void cu.dismiss()} />
      </div>
      {panel.targetApp && <p className={styles.app}>{panel.targetApp}</p>}
      <p className={styles.action}>{panel.action}</p>
      {panel.scopeChips.length > 0 && (
        <ul className={styles.chips}>
          {panel.scopeChips.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      )}
      {panel.showsPermissionChoices && (
        <>
          <div className={styles.grid}>
            {SCOPES.map((s) => (
              <Choice key={s} panel={panel} scope={s} />
            ))}
          </div>
          <p className={styles.note}>
            <span>均可选</span>
            <span>不会因打开此面板自动授权</span>
          </p>
        </>
      )}
      <div className={styles.foot}>
        {panel.canResume ? (
          <span data-testid="computer-use-resume">
            <Btn size="md" onClick={() => void cu.resume()}>
              继续
            </Btn>
          </span>
        ) : (
          <span className={styles.note}>你可以随时停止</span>
        )}
        <span data-testid="computer-use-stop" title="立即取消当前电脑操作">
          <Btn variant="danger" size="md" icon="stop" onClick={() => void cu.stop()}>
            停止
          </Btn>
        </span>
      </div>
    </>
  );
  return (
    <section ref={ref} className={styles.root} data-theme="dark" aria-label="电脑操作状态">
      {panel?.phase === 'disabled' ? (
        <PowerState hud state="off" mode="block" title="电脑操作" reason="设置 › 能力里关着「操作电脑」，角色不能查看或操作你的窗口"
          action={{ label: '前往设置打开', onClick: () => getBridge().window.openMain(navRoute({ page: 'settings', group: 'perm', item: 'plugins.computer_use' })) }}>
          {body}
        </PowerState>
      ) : (
        body
      )}
    </section>
  );
}
