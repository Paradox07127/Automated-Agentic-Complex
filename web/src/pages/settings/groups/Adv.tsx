import { useEffect, useState } from 'react';
import { getBridge, type AppActionName, type ProcessState } from '../../../bridge';
import { Btn, StatusTag } from '../../../ui';
import { useSettings } from '../ctx';
import { defaultsOf } from '../native';
import { DELETE_WHAT, labelOf, useRowShown } from '../registry';
import { SetRow } from '../SetRow';
import { SetSection } from '../SetSection';

/** Groups 恢复默认 resets; the kernel and model rows, the login item and the character page stay. */
const RESET_GROUPS = ['speak', 'keys', 'privacy', 'perm'];

/** 高级: backend status, launch keys (file only), troubleshooting. */
export function AdvGroup() {
  const { model, agentdOff, goPage, native } = useSettings();
  const bridge = getBridge();
  const shown = useRowShown();
  const [agentd, setAgentd] = useState<ProcessState | null>(null);
  useEffect(() => {
    let live = true;
    void bridge.supervisor.state().then((s) => live && setAgentd(s.agentd));
    return () => {
      live = false;
    };
  }, [bridge]);
  const running = !agentdOff && agentd?.state === 'running';
  const act = (name: AppActionName, done: string, what: string) => () =>
    void bridge.app.action(name).then(
      () => model.notify({ message: done }),
      () => model.notify({ message: `这个外壳还不能${what}`, severity: 'warning' }),
    );

  /** The confirm lists what this reset really changes: schema defaults turn some reading switches on and others off. */
  const reset = () => {
    if (!native) return model.notify({ message: '没读到设置，不能恢复默认', severity: 'danger', persistent: true });
    const changes = Object.entries(defaultsOf(native, RESET_GROUPS)).filter(([id, v]) => model.vals[id] !== v);
    if (changes.length === 0) return model.notify({ message: '已经是默认设置' });
    const names = (to: boolean) => changes.filter(([, v]) => v === to).map(([id]) => labelOf(id));
    const on = names(true);
    const off = names(false);
    const other = changes.length - on.length - off.length;
    const gone = changes.filter(([id, v]) => v === false && native.rows[id]?.destructive).map(([id]) => DELETE_WHAT[id] ?? labelOf(id));
    const parts = [on.length ? `会打开：${on.join('、')}` : '', off.length ? `会关掉：${off.join('、')}` : '', other ? `另有 ${other} 项选项回到默认` : ''].filter(Boolean);
    model.ask({
      title: '恢复默认设置？',
      danger: true,
      warning: gone.length ? `会删除已收集的${gone.join('、')}，不能恢复` : `会改动 ${changes.length} 项设置`,
      note: `${parts.join('；')}。不改动：角色内核、AI 账号；API Key；记忆和数据。`,
      confirmLabel: '恢复默认',
      onConfirm: async () => {
        if (await model.resetTo(defaultsOf(native, RESET_GROUPS))) model.notify({ message: '已恢复默认设置', severity: 'success' });
      },
    });
  };

  return (
    <>
      {shown('agentd') && <SetSection title="后台服务">
        <SetRow
          id="agentd"
          title="后台服务"
          desc={running && agentd?.pid ? `进程 ${agentd.pid}` : undefined}
          control={
            <>
              <StatusTag state={running ? 'running' : 'failed'} label={running ? '运行中' : '没有运行'} />
              {running ? (
                <Btn size="sm" variant="ghost" onClick={() => goPage({ page: 'diag' })}>
                  去诊断
                </Btn>
              ) : (
                <Btn size="sm" variant="secondary" loading={model.restarting} onClick={() => void model.restartBackend()}>
                  重启后台服务
                </Btn>
              )}
            </>
          }
        />
      </SetSection>}

      {shown('devparams') && <SetSection title="开发者参数">
        <SetRow
          id="devparams"
          title="启动参数"
          desc="只能在配置文件里改"
          control={
            <Btn size="sm" variant="ghost" icon="file" onClick={act('open_config', '已打开配置文件', '打开配置文件')}>
              打开配置文件
            </Btn>
          }
        />
      </SetSection>}

      <SetSection title="排障">
        <SetRow
          id="logdir"
          title="日志目录"
          control={
            <Btn size="sm" variant="ghost" icon="folder" onClick={act('reveal_logs', '已打开日志目录', '打开日志目录')}>
              打开日志目录
            </Btn>
          }
        />
        <SetRow
          id="copydiag"
          title="复制诊断信息"
          desc="不含对话和记忆内容"
          control={
            <Btn size="sm" variant="ghost" icon="copy" onClick={act('copy_diagnostics', '诊断信息已复制', '复制诊断信息')}>
              复制
            </Btn>
          }
        />
        <SetRow
          id="reset"
          title="恢复默认设置…"
          control={
            <Btn size="sm" variant="ghost" disabled={!native} disabledReason="没读到设置" onClick={reset}>
              恢复默认…
            </Btn>
          }
        />
      </SetSection>
    </>
  );
}
