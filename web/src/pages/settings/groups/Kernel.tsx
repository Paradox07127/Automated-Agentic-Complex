import { useEffect, useState } from 'react';
import { getBridge } from '../../../bridge';
import { type RuntimeInfo } from '../../../domain';
import { codeText } from '../../../domain/errorText';
import { KernelChain, kernelBreak } from '../../../features/kernel';
import { Fold } from '../../../ui/Fold';
import { Btn, Icon, Missing, Pill, Select, Skel, StatusTag, Table, TableCell, TableHead, TableRow } from '../../../ui';
import { useControls } from '../controls';
import { useSettings } from '../ctx';
import { failure, installAcpAgent, readAcpAgents, type AcpAgent, type AcpAgents, type AcpInstall } from '../api';
import { acctOptions, providerOptions, RUNSRC, RUNTIME_ERROR, RUNTIME_ERROR_UNKNOWN, type ProviderProfile, type RuntimeError } from '../fields';
import { SetRow } from '../SetRow';
import { SetSection } from '../SetSection';
import { Slab } from '../Slab';
import { useKernelActions } from '../useKernelActions';
import { KernelPi } from './KernelPi';
import { KernelRoutes } from './KernelRoutes';
import styles from '../groups.module.css';

const BREAK_LABEL = ['没找到可执行文件', '入口不可用', '未登录'];

/** Codes the discovery chain below the card explains and fixes. */
const DISCOVERY_CODES: ReadonlySet<string> = new Set(['native_login_required', 'runtime_protocol_unavailable', 'runtime_version_not_verified', 'local_runtime_missing', 'runtime_missing']);

/** Old CharacterRuntimeSettings feature titles; agentd reports which are wired and which are switched on. */
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

const usable = (r: RuntimeInfo) => r.available !== false;
const readyOf = (r: RuntimeInfo) => kernelBreak(r) < 0;

const acpKey = (a: AcpAgent) => `${a.source}:${a.id}`;
const authNames = (a: AcpAgent | undefined) => (a?.probe?.auth_methods ?? []).map((m) => m.name ?? m.id ?? '').filter(Boolean).join('、');

/** `/character/acp/agents` for the ACP picker and the route table; `refresh` re-runs the local agents' initialize probe. */
function useAcpAgents(agentdOff: boolean) {
  const [list, setList] = useState<AcpAgents | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  useEffect(() => {
    let live = true;
    readAcpAgents().then(
      (a) => live && (setList(a), setError(null)),
      (e) => live && setError(failure(e).text),
    );
    return () => {
      live = false;
    };
  }, [agentdOff]);
  const refresh = () => {
    setProbing(true);
    return readAcpAgents(true)
      .then(
        (a) => (setList(a), setError(null)),
        (e) => setError(failure(e).text),
      )
      .finally(() => setProbing(false));
  };
  const reload = () => readAcpAgents().then((a) => (setList(a), setError(null)), (e) => setError(failure(e).text));
  return { list, error, probing, refresh, reload };
}

/** 角色内核 (draft group): current kernel with its chain when broken, picker table, workspace, account, Pi's own rows, connected capabilities. */
export function KernelGroup() {
  const { model, ro, agentdOff, runtime, runtimeChecking, goRow, caps } = useSettings();
  const c = useControls();
  const k = useKernelActions();
  const bridge = getBridge();
  const selected = String(model.value('kernel'));
  const isAcp = selected === 'acp';
  // An ACP agent and Claude Code use only their own login.
  const ownLogin = isAcp || selected === 'claude';
  const acp = useAcpAgents(agentdOff);
  const [installing, setInstalling] = useState<string | null>(null);
  if (!runtime) return <Skel rows={6} label="正在读取内核状态…" />;

  const list = runtime.runtimes;
  const cur = list.find((r) => r.id === model.vals.kernel) ?? list.find((r) => r.id === runtime.selected) ?? list[0];
  const altOf = (r: RuntimeInfo) => (readyOf(r) ? null : (list.find((x) => x.id !== r.id && usable(x) && readyOf(x)) ?? null));
  // The current kernel's chain is already shown above; a picked one that is not ready shows its own under the table.
  const picked = list.find((r) => r.id === selected && r.id !== cur?.id && !readyOf(r)) ?? null;
  const switchTo = (id: string) => void k.onSwitch(id, list.find((x) => x.id === id)?.name ?? id);
  // Codex and Claude Code run only the installed CLI; the source choice is Pi's.
  const local = !isAcp && (selected === 'codex' || selected === 'claude' || model.value('runsrc') === 'local');
  const agents = acp.list ? [...acp.list.agents.filter((a) => a.source === 'local'), ...acp.list.agents.filter((a) => a.source !== 'local')] : [];
  const runnable = (a: AcpAgent) => a.source === 'local' || (a.source === 'npx' ? acp.list?.npx : acp.list?.uvx) === true;
  const savedAgent = runtime.wire.acp_agent;
  // A bridge of a harness with its own kernel stays pickable only while it is the saved agent.
  const pickable = (a: AcpAgent) => runnable(a) && (!a.native_backend || acpKey(a) === `${String(runtime.wire.acp_launcher)}:${String(savedAgent)}`);
  // Agents that only run through npx or uvx wait in a fold; the saved one stays in view.
  const installed = agents.filter((a) => a.source === 'local' || acpKey(a) === `${String(runtime.wire.acp_launcher)}:${String(savedAgent)}`);
  const more = agents.filter((a) => !installed.includes(a));
  const pickAcp = (key: string) => {
    const a = agents.find((x) => acpKey(x) === key);
    if (ro || !a || !pickable(a)) return;
    model.set('acpAgent', a.id);
    model.set('acpLauncher', a.source);
  };
  const acpSel = `${String(model.value('acpLauncher'))}:${String(model.value('acpAgent'))}`;
  const installAcp = (a: AcpAgent) => {
    setInstalling(a.id);
    const fail = (why: string) => model.notify({ message: `安装 ${a.name} 失败：${why}`, severity: 'danger', persistent: true });
    const exitWhy = (r: AcpInstall) => [r.exit == null ? '超时' : `退出码 ${r.exit}`, r.output_tail.trim().split('\n').pop()].filter(Boolean).join(' │ ');
    return installAcpAgent(a.id)
      .then((r) => (r.ok ? model.notify({ message: `已安装 ${a.name}`, severity: 'success' }) : fail(exitWhy(r))), (e) => fail(failure(e).text))
      .finally(() => (setInstalling(null), void acp.reload()));
  };
  const savedAuth = authNames(acp.list?.agents.find((a) => a.id === savedAgent && a.source === 'local'));
  const profiles = (runtime.wire as { provider_profiles?: ProviderProfile[] }).provider_profiles ?? [];
  const provOpts = providerOptions(selected, profiles);
  // A catalog profile names the account source it runs with.
  const pickProvider = (x: string) => {
    model.set('provider', x);
    const need = profiles.find((p) => p.id === x)?.auth_source;
    if (need && model.value('acct') !== need) model.set('acct', need);
  };
  const exe = 'exe' in model.draft || selected === model.vals.kernel ? model.value('exe') : null;
  const pickExe = async () => {
    const h = await bridge.files.pickFile({ purpose: 'runtime_executable' });
    if (h) model.setHandle('exe', h);
    else model.notify({ message: '没有选择文件，可执行文件保持不变' });
  };
  const workspace = model.value('workspace');
  const pickWorkspace = async () => {
    const h = await bridge.files.pickFolder({ purpose: 'session_cwd' });
    if (h) model.setHandle('workspace', h);
    else model.notify({ message: '没有选择文件夹，工作区保持不变' });
  };
  const features = ((runtime.wire.capabilities as { features?: Record<string, Feature> } | undefined)?.features ?? {}) as Record<string, Feature>;
  // `ready` and `error` describe the saved backend; a kernel just switched to is judged by its own discovery row.
  const saved = cur?.id === runtime.selected;
  const ready = saved ? runtime.ready : !!cur && readyOf(cur);
  // agentd's own code wins over the discovery row, which knows nothing of keys, Pi or the runtime settings file.
  const code = !ready && saved ? runtime.error : null;
  const reason: RuntimeError | null = ready ? null : code ? (RUNTIME_ERROR[code] ?? RUNTIME_ERROR_UNKNOWN) : { label: (cur && BREAK_LABEL[kernelBreak(cur)]) || '未知原因' };
  const chain = !!cur && !readyOf(cur) && (!code || DISCOVERY_CODES.has(code));
  const acpTable = (label: string, rows: AcpAgent[]) => (
    <Table
      label={label}
      selected={acpSel}
      onSelect={pickAcp}
      head={
        <TableHead>
          <TableCell head />
          <TableCell head>名称</TableCell>
          <TableCell head>版本</TableCell>
          <TableCell head>来源</TableCell>
          <TableCell head>状态</TableCell>
        </TableHead>
      }
    >
      {rows.map((a) => {
        const key = acpKey(a);
        const on = acpSel === key;
        const off = ro || !pickable(a);
        const names = authNames(a);
        const native = a.native_backend ? list.find((x) => x.id === a.native_backend) : undefined;
        const nativeName = native?.name ?? a.native_backend;
        return (
          <TableRow key={key} id={key}>
            <TableCell>
              <span role="radio" aria-checked={on} aria-label={a.name} aria-disabled={off || undefined} className={styles.radio} data-on={on || undefined} />
            </TableCell>
            <TableCell>{a.name}</TableCell>
            <TableCell mono>{a.version ?? <Missing why="na" />}</TableCell>
            <TableCell>{a.source === 'local' ? RUNSRC.find((o) => o.value === 'local')?.label : a.source}</TableCell>
            <TableCell>
              {a.native_backend ? (
                <span onClick={(e) => e.stopPropagation()}>
                  <StatusTag state="idle" label="用直连" />{' '}
                  <Btn size="sm" variant="ghost" disabled={ro || !native || !usable(native)} disabledReason={`本机没有 ${nativeName}`} onClick={() => switchTo(a.native_backend!)}>{`改用 ${nativeName}`}</Btn>
                </span>
              ) : a.source !== 'local' ? (
                <>
                  <Btn size="sm" variant="ghost" disabled={off} disabledReason={runnable(a) ? undefined : `本机没有 ${a.source}`} onClick={() => pickAcp(key)}>
                    下载并运行
                  </Btn>{' '}
                  <span onClick={(e) => e.stopPropagation()}>
                    <Btn size="sm" variant="ghost" loading={installing === a.id} disabled={ro || agentdOff || installing != null} disabledReason={agentdOff ? '后台服务没有运行' : '正在安装'} onClick={() => void installAcp(a)}>安装</Btn>
                  </span>
                </>
              ) : !a.probe ? (
                <StatusTag state="todo" label="未检测" />
              ) : a.probe.ok ? (
                <StatusTag state="ok" label="可用" />
              ) : (
                <StatusTag state="broken" label={names ? `要登录：${names}` : '检测失败'} />
              )}
              {on && ('acpAgent' in model.draft || 'acpLauncher' in model.draft) && <span className={styles.att}> │ 未应用</span>}
            </TableCell>
          </TableRow>
        );
      })}
    </Table>
  );

  return (
    <>
      <SetSection title="当前内核">
        {cur && (
          <Slab id="kcur" variant="plate">
            <div className={styles.kernCard}>
              <span className={styles.kava} aria-hidden="true">
                <Icon name="kernel" size={20} />
              </span>
              <div className={styles.kernBody}>
                <div className={styles.kernName}>
                  <b>{cur.name}</b>
                  <span className="num">{cur.version ?? <Missing why="unsupported" />}</span>
                  {runtime.wire.auto_selected && <Pill>自动选择</Pill>}
                  {reason == null ? (
                    <StatusTag state="ok" label={cur.authenticated ? '已就绪 │ 已登录' : '已就绪'} />
                  ) : (
                    <span title={(code && !RUNTIME_ERROR[code] && codeText(code)) || undefined}>
                      <StatusTag state="broken" label={`未就绪：${reason.label}`} />
                    </span>
                  )}
                  {reason?.fix && (
                    <button type="button" className={styles.lnk} onClick={() => goRow(reason.fix!.row)}>
                      {reason.fix.action}
                    </button>
                  )}
                </div>
                {chain && <KernelChain runtime={cur} alternative={altOf(cur)} onCopy={k.onCopy} onRunInTerminal={k.onRunInTerminal} onSwitch={switchTo} />}
                {code === 'acp_auth_required' &&
                  (savedAgent === 'claude-acp' ? (
                    <p className={styles.cap}>
                      <span>在终端运行 claude 并输入 /login</span>
                      <Btn size="sm" variant="ghost" onClick={() => k.onRunInTerminal('claude')}>
                        在终端运行
                      </Btn>
                    </p>
                  ) : (
                    savedAuth && <p className={styles.cap}>{`要登录：${savedAuth}`}</p>
                  ))}
                {runtime.busy && <p className={styles.cap}>正在运行；改用别的内核或改设置会取消这次运行</p>}
              </div>
              <Btn size="sm" variant="ghost" icon="refresh" loading={runtimeChecking} disabled={agentdOff} disabledReason="后台服务没有运行" onClick={() => void k.recheck(cur.name, cur.id)}>
                重新检测
              </Btn>
            </div>
          </Slab>
        )}
      </SetSection>

      <SetSection title="选择内核">
        <div id="set-kernel" data-row="kernel" data-nav-target="set-kernel">
          <Table
            label="内核"
            selected={selected}
            onSelect={(id) => {
              const r = list.find((x) => x.id === id);
              if (!ro && r && usable(r) && id !== selected) {
                // A picked executable belongs to the kernel it was picked for; agentd drops the saved one on a switch.
                model.setDraft(({ exe: _exe, ...rest }) => rest);
                model.set('kernel', id);
              }
            }}
            head={
              <TableHead>
                <TableCell head />
                <TableCell head>名称</TableCell>
                <TableCell head>版本</TableCell>
                <TableCell head>来源</TableCell>
                <TableCell head>登录</TableCell>
                <TableCell head>状态</TableCell>
              </TableHead>
            }
          >
            {list.map((r) => {
              const on = selected === r.id;
              const bi = kernelBreak(r);
              const status = !usable(r) ? '暂不可用' : bi < 0 ? '已就绪' : (BREAK_LABEL[bi] ?? '未就绪');
              return (
                <TableRow key={r.id} id={r.id}>
                  <TableCell>
                    <span role="radio" aria-checked={on} aria-label={r.name} aria-disabled={ro || !usable(r) || undefined} className={styles.radio} data-on={on || undefined} />
                  </TableCell>
                  <TableCell>{r.name}</TableCell>
                  <TableCell mono>{r.version ?? <Missing why={r.path ? 'unsupported' : 'na'} />}</TableCell>
                  <TableCell>
                    {r.path ? (RUNSRC.find((o) => o.value === r.runtime_source)?.label ?? <Missing why="unsupported" />) : r.id === 'acp' ? <Missing why="na" /> : r.id === 'pi' && usable(r) ? '随应用提供' : '没找到'}
                  </TableCell>
                  <TableCell>{r.id === 'acp' ? <Missing why="na" /> : r.authenticated == null ? '不需要' : r.path ? (r.authenticated ? '已登录' : '未登录') : <Missing why="na" />}</TableCell>
                  <TableCell>
                    <StatusTag state={usable(r) && bi < 0 ? 'ok' : 'broken'} label={status} />
                    {model.draft.kernel === r.id && <span className={styles.att}> │ 未应用</span>}
                  </TableCell>
                </TableRow>
              );
            })}
          </Table>
          {picked && <KernelChain runtime={picked} alternative={altOf(picked)} onCopy={k.onCopy} onRunInTerminal={k.onRunInTerminal} onSwitch={switchTo} />}
        </div>
        {local && (
          <SetRow
            id="exe"
            title="可执行文件"
            desc={caps.nativeFilePicker ? '留空时由后台检测' : '这个平台不能打开文件选择器，请在配置文件里填写'}
            control={
              <>
                <code className={styles.path}>{exe ? String(exe) : '自动检测'}</code>
                <Btn size="sm" variant="ghost" disabled={ro || !caps.nativeFilePicker} disabledReason="这个平台没有原生文件选择器" onClick={() => void pickExe()}>
                  选择…
                </Btn>
              </>
            }
          />
        )}
        <SetRow
          id="workspace"
          title="工作区"
          control={
            <>
              <code className={styles.path}>{workspace ? String(workspace) : '~/AgenticComplex'}</code>
              <Btn size="sm" variant="ghost" disabled={ro || !caps.nativeFilePicker} disabledReason="这个平台没有原生文件选择器" onClick={() => void pickWorkspace()}>
                选择
              </Btn>
            </>
          }
        />
      </SetSection>

      {isAcp && (
        <SetSection
          title="ACP 智能体"
          right={
            <Btn size="sm" variant="ghost" icon="refresh" loading={acp.probing} disabled={agentdOff} disabledReason="后台服务没有运行" onClick={() => void acp.refresh()}>
              重新检测
            </Btn>
          }
        >
          <div id="set-acpAgent" data-row="acpAgent" data-nav-target="set-acpAgent">
            {acp.error && !acp.list ? (
              <p className={styles.note}>{`读不到 ACP 智能体：${acp.error}`}</p>
            ) : !acp.list ? (
              <Skel rows={2} label="正在读取 ACP 智能体…" />
            ) : agents.length === 0 ? (
              <p className={styles.note}>本机没有 ACP 智能体，也没有 npx 或 uvx</p>
            ) : (
              <>
                {installed.length > 0 && acpTable('ACP 智能体', installed)}
                {more.length > 0 && <Fold label="更多（需下载）">{acpTable('更多（需下载）', more)}</Fold>}
              </>
            )}
          </div>
        </SetSection>
      )}

      <SetSection title="账号">
        {!ownLogin && (
          <>
            <SetRow
              id="acct"
              title="账号来源"
              desc={selected === 'pi' ? undefined : model.value('acct') === 'api_key' ? '用 pi 账号与凭据 里保存的 API 凭据' : '用内核自己的登录'}
              control={c.select('acct', acctOptions(selected, model.value('acct')))}
            />
            <SetRow
              id="provider"
              title="服务提供方"
              control={<Select label="服务提供方" value={String(model.value('provider') ?? '')} options={provOpts} disabled={ro || agentdOff} onChange={pickProvider} />}
            />
          </>
        )}
        <SetRow id="mainModel" title="主会话模型" desc="留空用内核默认模型" control={c.text('mainModel', '主会话模型', '模型 ID')} />
      </SetSection>

      <KernelRoutes agents={acp.list?.agents ?? []} />

      {selected === 'pi' && <KernelPi />}

      <SetSection title="已接通能力">
        {FEATURE.filter(([key]) => features[key]?.implemented).map(([key, label]) => {
          const f = features[key] ?? {};
          const state = f.enabled === false ? '已接入 │ 未启用' : '已接通';
          return <SetRow key={key} id={`cap-${key}`} title={label} control={<StatusTag state={state === '已接通' ? 'ok' : 'todo'} label={state} />} />;
        })}
        {Object.keys(features).length === 0 && <p className={styles.note}>保存并刷新后显示这个内核接通的能力</p>}
      </SetSection>
    </>
  );
}
