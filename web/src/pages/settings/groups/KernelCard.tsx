import { type RuntimeInfo } from '../../../domain';
import { codeText } from '../../../domain/errorText';
import { KernelChain, kernelBreak } from '../../../features/kernel';
import { Btn, Pill } from '../../../ui';
import { StatusLamp } from '../../../ui/game';
import { useSettings } from '../ctx';
import { RUNSRC, RUNTIME_ERROR, RUNTIME_ERROR_UNKNOWN, type RuntimeError } from '../fields';
import { labelOf } from '../registry';
import { Slab } from '../Slab';
import { useKernelActions } from '../useKernelActions';
import styles from '../groups.module.css';

export const BREAK_LABEL = ['没找到可执行文件', '入口不可用', '未登录'];

/** Codes the discovery chain below the card explains and fixes. */
const DISCOVERY_CODES: ReadonlySet<string> = new Set(['native_login_required', 'runtime_protocol_unavailable', 'runtime_version_not_verified', 'local_runtime_missing', 'runtime_missing']);

/** What the kernel can do as agentd reports it (`capabilities.features`): wired ones as chips, lit while switched on. */
const FEATURE: Array<[string, string]> = [
  ['domain_tools', '资料与产物工具'],
  ['memory_write_and_journal', '长期记忆与生成记录'],
  ['automatic_memory_observation_proactive', '自动记忆与现场理解'],
  ['goal_and_job_interaction', '目标与后台任务交互'],
  ['parallel_background_tasks', '后台任务并行'],
  ['clarification_and_approval', '澄清与操作审批'],
  ['native_shell', '内核原生执行工具'],
  ['native_resume', '内核原生会话恢复'],
  ['native_computer_use', '内核原生桌面操作'],
];

type Feature = { implemented?: boolean; enabled?: boolean };

export const usable = (r: RuntimeInfo) => r.available !== false;
export const readyOf = (r: RuntimeInfo) => kernelBreak(r) < 0;

/** The current kernel's card: name, version and source, ready or why not with its fix, 重新检测, and what she can do through it. */
export function KernelCard({ cur, altOf, onSwitch }: { cur: RuntimeInfo; altOf: (r: RuntimeInfo) => RuntimeInfo | null; onSwitch: (id: string) => void }) {
  const { model, agentdOff, runtime, runtimeChecking, goRow } = useSettings();
  const k = useKernelActions();
  const features = ((runtime!.wire.capabilities as { features?: Record<string, Feature> } | undefined)?.features ?? {}) as Record<string, Feature>;
  // `ready` and `error` describe the saved backend; a kernel just switched to is judged by its own discovery row.
  const saved = cur.id === runtime!.selected;
  const ready = saved ? runtime!.ready : readyOf(cur);
  // agentd's own code wins over the discovery row, which knows nothing of keys, Pi or the runtime settings file.
  const code = !ready && saved ? runtime!.error : null;
  const reason: RuntimeError | null = ready ? null : code ? (RUNTIME_ERROR[code] ?? RUNTIME_ERROR_UNKNOWN) : { label: BREAK_LABEL[kernelBreak(cur)] || '未知原因' };
  const chain = !readyOf(cur) && (!code || DISCOVERY_CODES.has(code));
  const source = cur.id === 'pi' && usable(cur) && !cur.path ? '随应用提供' : RUNSRC.find((o) => o.value === cur.runtime_source)?.label;
  const computerUse = model.value('plugins.computer_use') === true;
  return (
    <Slab id="kcur" variant="plate" label="当前内核">
      <div className={styles.kcard}>
        <span className={styles.big}>
          {cur.name}
          <small>{[cur.version ?? '—', source].filter(Boolean).join(' │ ')}</small>
        </span>
        <span className={styles.meta}>
          {'kernel' in model.draft ? (
            <StatusLamp size="sm" state="waiting" label="未应用 │ 点底部「应用」后切换" />
          ) : reason == null ? (
            <StatusLamp size="sm" state="ok" label={cur.authenticated ? '已就绪 │ 已登录' : '已就绪'} />
          ) : (
            <span title={(code && !RUNTIME_ERROR[code] && codeText(code)) || undefined}>
              <StatusLamp size="sm" state="broken" label={`未就绪：${reason.label}`} />
            </span>
          )}
          {reason?.fix && <Btn variant="link" onClick={() => goRow(reason.fix!.row)}>{reason.fix.action}</Btn>}
          {runtime!.wire.auto_selected && <Pill>自动选择</Pill>}
          <span>所有角色共用</span>
        </span>
        <Btn loading={runtimeChecking} disabled={agentdOff} disabledReason="后台服务没有运行" onClick={() => void k.recheck(cur.name, cur.id)}>
          重新检测
        </Btn>
        <div className={styles.can} role="list" aria-label={`用 ${cur.name} 能`}>
          <span className={styles.canLbl}>用 {cur.name} 能：</span>
          {FEATURE.filter(([key]) => features[key]?.implemented).map(([key, label]) => (
            <span key={key} role="listitem">
              <Pill dashed={features[key]?.enabled === false}>{label}</Pill>
            </span>
          ))}
          {Object.keys(features).length === 0 && <span className={styles.t3}>保存并刷新后显示这个内核接通的能力</span>}
          <span role="listitem">
            <Pill size="lg" dashed={!computerUse}>
              {labelOf('plugins.computer_use')}
              {!computerUse && <Btn variant="link" onClick={() => goRow('plugins.computer_use', 'perm')}>去打开</Btn>}
            </Pill>
          </span>
        </div>
        {chain && (
          <div className={styles.wide}>
            <KernelChain runtime={cur} alternative={altOf(cur)} onCopy={k.onCopy} onRunInTerminal={k.onRunInTerminal} onSwitch={onSwitch} />
          </div>
        )}
        {runtime!.busy && <p className={styles.wide}>正在运行；改用别的内核或改设置会取消这次运行</p>}
      </div>
    </Slab>
  );
}
