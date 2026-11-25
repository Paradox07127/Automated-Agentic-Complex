import type { ReactNode } from 'react';
import { getBridge } from '../../../bridge';
import { type RuntimeInfo } from '../../../domain';
import { KernelChain, kernelBreak } from '../../../features/kernel';
import { usePlugins } from '../../../shell/plugins';
import { Btn, Missing, RadioDot, Select, Skel, Switch, Table, TableCell, TableHead, TableRow } from '../../../ui';
import { StatusLamp } from '../../../ui/game';
import { BAND } from '../Band';
import { useControls } from '../controls';
import { useSettings } from '../ctx';
import { acctOptions, KERNEL_LABEL, providerOptions, RUNSRC, type ProviderProfile, type Vals } from '../fields';
import { labelOf, useRowShown } from '../registry';
import { SetRow } from '../SetRow';
import { SetSection } from '../SetSection';
import { Slab } from '../Slab';
import { useKernelActions } from '../useKernelActions';
import { ApiKeyControl, keyNote } from './ApiKey';
import { AcpAgentSlab, useAcpAgents, type AcpState } from './KernelAcp';
import { BREAK_LABEL, KernelCard, readyOf, usable } from './KernelCard';
import { KernelLoginRow } from './KernelLogin';
import { KernelPi, WorkspaceRow } from './KernelPi';
import { KernelRoutes } from './KernelRoutes';
import { PiSections } from './Model';
import band from '../band.module.css';
import styles from '../groups.module.css';

const LIGHT = 'plugins.light_ai';
const OTHERS = 'plugins.harness_bridge';

/**
 * 内核: 选择内核 (the 「AI 对话」 switch, the current kernel and the picker), then only what the picked kernel uses: 账号, 模型
 * and its run options. Rows of agentd's runtime settings are drafts applied with the bottom bar.
 */
export function KernelGroup() {
  const { model, agentdOff, runtime } = useSettings();
  const plugins = usePlugins();
  const shown = useRowShown();
  const acp = useAcpAgents(agentdOff);
  const selected = String(model.value('kernel') ?? runtime?.selected ?? 'pi');
  const pi = selected === 'pi';
  // Pi runs on light_ai alone; every other kernel needs harness_bridge too (agentd integration.py available_backends). A gated
  // pick drafts harness_bridge on.
  const on = plugins.light_ai && (pi || plugins.harness_bridge || model.value(OTHERS) === true);
  const routes = shown('routes') && <KernelRoutes agents={acp.list?.agents ?? []} />;
  return (
    <>
      <SetSection title="选择内核" info="执行内核负责处理对话推理与任务执行，由所有角色共用；角色设定由各自角色档案决定。Pi 随应用内置；Codex、Claude Code 与 ACP 智能体需在本机预先安装。">
        <AiRow pi={pi} />
        {!on ? (
          <div className={band.fold}>
            未开启 │ 开启后可配置执行内核、账号与模型
            <span className={band.lost}>│ 停用功能：{BAND.light_ai.does}</span>
          </div>
        ) : runtime ? (
          <KernelPick acp={acp} />
        ) : (
          <Skel rows={6} label="正在读取内核状态…" />
        )}
      </SetSection>
      {on && runtime && (pi ? <PiSections provider={<ProviderRow />} routes={routes} /> : <OtherSections acp={acp} routes={routes} />)}
      {on && runtime && <RunSection />}
    </>
  );
}

/** 「AI 对话」: light_ai for Pi, and harness_bridge with it for another kernel; off turns both off. Saved at once with undo. */
function AiRow({ pi }: { pi: boolean }) {
  const { model, native } = useSettings();
  const light = model.value(LIGHT) === true;
  const checked = light && (pi || model.value(OTHERS) === true);
  const setOn = (next: boolean) => {
    const want: Vals = next ? { [LIGHT]: true, ...(pi ? {} : { [OTHERS]: true }) } : { [LIGHT]: false, [OTHERS]: false };
    const changes = Object.fromEntries(Object.entries(want).filter(([id, v]) => model.vals[id] !== v));
    if (Object.keys(changes).length === 0) return;
    const old = Object.fromEntries(Object.keys(changes).map((id) => [id, model.vals[id] ?? null]));
    const what = labelOf(LIGHT);
    void model.save(changes, what).then((ok) => ok && model.notify({ message: `已更改「${what}」`, action: { label: '撤销', onClick: () => void model.save(old, what) } }));
  };
  return (
    <SetRow
      id={LIGHT}
      title={labelOf(LIGHT)}
      desc={checked ? '开启后，角色将正常响应对话，语音播报、记忆及主动交互也将按配置运行' : '关闭后，角色将停止回复消息且不记录新对话'}
      info="Pi 仅依赖此开关；Codex、Claude Code 及 ACP 智能体还需同时开启外部框架桥接，选择时将自动一并开启，关闭时将同时关闭。对话内容将发送至所选内核与模型。更改后需重启后台服务生效。"
      control={<Switch variant="setting" checked={checked} label={labelOf(LIGHT)} disabled={!native} disabledReason="尚未读取设置" onChange={setOn} />}
    />
  );
}

/** The current kernel's card, the kernel table (a pick is a draft) and, for ACP, the agent table. */
function KernelPick({ acp }: { acp: AcpState }) {
  const { model, ro, runtime } = useSettings();
  const k = useKernelActions();
  const selected = String(model.value('kernel'));
  const list = runtime!.runtimes;
  const cur = list.find((r) => r.id === model.vals.kernel) ?? list.find((r) => r.id === runtime!.selected) ?? list[0];
  const altOf = (r: RuntimeInfo) => (readyOf(r) ? null : (list.find((x) => x.id !== r.id && usable(x) && readyOf(x)) ?? null));
  // The current kernel's chain is already on its card; a picked one that is not ready shows its own under the table.
  const picked = list.find((r) => r.id === selected && r.id !== cur?.id && !readyOf(r)) ?? null;
  const switchTo = (id: string) => void k.onSwitch(id, list.find((x) => x.id === id)?.name ?? id);
  const othersOn = model.value(OTHERS) === true;
  // A kernel agentd turned away for its plug-in: picking it also drafts the plug-in on, applied with the kernel; it runs after
  // the backend restart.
  const gated = (r: RuntimeInfo) => !usable(r) && r.reason === 'plugin_off' && r.id !== 'pi';
  const pick = (id: string) => {
    const r = list.find((x) => x.id === id);
    if (ro || !r || id === selected) return;
    if (!usable(r) && !gated(r)) return;
    // A picked executable belongs to the kernel it was picked for; agentd drops the saved one on a switch.
    model.setDraft(({ exe: _exe, [OTHERS]: _others, ...rest }) => (gated(r) && model.vals[OTHERS] !== true ? { ...rest, [OTHERS]: true } : rest));
    model.set('kernel', id);
  };
  return (
    <>
      {cur && <KernelCard cur={cur} altOf={altOf} onSwitch={switchTo} />}
      <Slab id="kernel" indent label={labelOf('kernel')}>
        <Table
          label="内核"
          selected={selected}
          onSelect={pick}
          head={
            <TableHead>
              <TableCell head />
              <TableCell head>内核</TableCell>
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
            const status = gated(r) ? (othersOn ? '重启后台服务后可用' : '未开启，选择此项将同步启用') : !usable(r) ? '暂不可用' : bi < 0 ? '已就绪' : (BREAK_LABEL[bi] ?? '未就绪');
            return (
              <TableRow key={r.id} id={r.id}>
                <TableCell>
                  <RadioDot size="sm" checked={on} label={r.name} disabled={ro || (!usable(r) && !gated(r))} />
                </TableCell>
                <TableCell>{r.name}</TableCell>
                <TableCell mono>{r.version ?? <Missing why={r.path ? 'unsupported' : 'na'} />}</TableCell>
                <TableCell>
                  {r.path ? (RUNSRC.find((o) => o.value === r.runtime_source)?.label ?? <Missing why="unsupported" />) : r.id === 'acp' ? <Missing why="na" /> : r.id === 'pi' && usable(r) ? '随应用内置' : '未检测到'}
                </TableCell>
                <TableCell>{r.id === 'acp' ? <Missing why="na" /> : r.authenticated == null ? '无需登录' : r.path ? (r.authenticated ? '已登录' : '未登录') : <Missing why="na" />}</TableCell>
                <TableCell>
                  <StatusLamp size="sm" state={usable(r) && bi < 0 ? 'ok' : gated(r) ? 'idle' : 'broken'} label={status} />
                  {model.draft.kernel === r.id && <span className={styles.att}> │ 未应用</span>}
                </TableCell>
              </TableRow>
            );
          })}
        </Table>
        {picked && <KernelChain runtime={picked} alternative={altOf(picked)} onCopy={k.onCopy} onRunInTerminal={k.onRunInTerminal} onSwitch={switchTo} />}
      </Slab>
      {selected === 'acp' && <AcpAgentSlab acp={acp} onSwitch={switchTo} />}
    </>
  );
}

/** Codex, Claude Code or ACP: 账号 (its account source, key or sign-in), then 模型, its main model. */
function OtherSections({ acp, routes }: { acp: AcpState; routes: ReactNode }) {
  const { model, runtime, models } = useSettings();
  const c = useControls();
  const selected = String(model.value('kernel'));
  const isAcp = selected === 'acp';
  // An ACP agent and Claude Code use only their own login.
  const ownLogin = isAcp || selected === 'claude';
  const savedAgent = runtime!.wire.acp_agent;
  // DeepSeek Harness has no ACP sign-in: its own choice of the DeepSeek account or the app's DeepSeek key.
  const dsh = isAcp && model.value('acpAgent') === 'deepseek-harness';
  // A method that takes an API key or a gateway needs input this page does not collect.
  const savedMethods = (acp.list?.agents.find((a) => a.id === savedAgent && a.source === runtime!.wire.acp_launcher)?.probe?.auth_methods ?? []).filter(
    (m) => !m._meta || !('api-key' in m._meta || 'gateway' in m._meta),
  );
  // Sign-in acts on the saved kernel: a picked but unapplied one waits for 应用.
  const loginShown = runtime!.selected === selected && !('acct' in model.draft) && !('acpAgent' in model.draft) &&
    (dsh ? runtime!.wire.auth_source === 'existing_login' : isAcp ? !!savedAgent : (selected === 'codex' || selected === 'claude') && runtime!.wire.auth_source === 'product_login');
  const acctShown = !isAcp || dsh;
  const keyed = acctShown && model.value('acct') === 'api_key';
  const keyProvider = dsh ? 'deepseek' : 'openai';
  const label = KERNEL_LABEL[selected] ?? selected;
  return (
    <>
      <SetSection title={`账号 │ ${label}`}>
        {acctShown && (
          <SetRow
            id="acct"
            title={labelOf('acct')}
            desc={
              dsh
                ? model.value('acct') === 'api_key'
                  ? '使用下方保存的 DeepSeek API Key'
                  : '使用 DeepSeek 客户端中的已登录账号'
                : ({ api_key: '使用下方保存的 API Key（按用量计费）', product_login: '在应用内单独登录，与终端 CLI 登录相互独立' }[String(model.value('acct'))] ?? '使用执行内核自身登录状态')
            }
            info="「复用本机 CLI 登录」将直接使用终端内已登录的账号；「在应用内登录」则在应用内独立登录，不影响终端配置；「使用 API 凭据」使用下方保存的 API Key（按用量计费）。修改后须点击底部「应用」生效。"
            control={c.select('acct', acctOptions(dsh ? 'deepseek-harness' : selected, model.value('acct')))}
          />
        )}
        {keyed && (
          <SetRow
            id="apikey"
            title={labelOf('apikey')}
            desc={keyNote(models?.backends[keyProvider]?.has_key === true)}
            control={<ApiKeyControl key={keyProvider} provider={keyProvider} />}
          />
        )}
        {loginShown && <KernelLoginRow backend={dsh ? 'deepseek' : selected} methods={dsh ? [] : savedMethods} />}
        {!ownLogin && <ProviderRow />}
        {!acctShown && !loginShown && <p className={styles.note}>使用 ACP 智能体自身登录方式；选定智能体并应用后，可在此完成登录</p>}
      </SetSection>
      <SetSection title="模型">
        <SetRow id="mainModel" title={labelOf('mainModel')} desc="留空时使用执行内核默认模型" control={c.text('mainModel', labelOf('mainModel'), '模型 ID')} />
        {routes}
      </SetSection>
    </>
  );
}

/** 服务提供方 of the picked kernel's runtime settings; a catalog profile names the account source it runs with. */
function ProviderRow() {
  const { model, ro, agentdOff, runtime } = useSettings();
  const profiles = (runtime!.wire as { provider_profiles?: ProviderProfile[] }).provider_profiles ?? [];
  const pick = (x: string) => {
    model.set('provider', x);
    const need = profiles.find((p) => p.id === x)?.auth_source;
    if (need && model.value('acct') !== need) model.set('acct', need);
  };
  return (
    <SetRow
      id="provider"
      title={labelOf('provider')}
      control={<Select label={labelOf('provider')} value={String(model.value('provider') ?? '')} options={providerOptions(String(model.value('kernel')), profiles)} disabled={ro || agentdOff} onChange={pick} />}
    />
  );
}

/** 「Pi 运行」 for Pi; for another kernel its executable and workspace. */
function RunSection() {
  const { model, caps, ro } = useSettings();
  const bridge = getBridge();
  const selected = String(model.value('kernel'));
  // Codex and Claude Code run only the installed CLI; the source choice is Pi's.
  const local = selected === 'codex' || selected === 'claude' || (selected === 'pi' && model.value('runsrc') === 'local');
  const exe = 'exe' in model.draft || selected === model.vals.kernel ? model.value('exe') : null;
  const pickExe = async () => {
    const h = await bridge.files.pickFile({ purpose: 'runtime_executable' });
    if (h) model.setHandle('exe', h);
    else model.notify({ message: '未选择文件，可执行文件路径保持不变' });
  };
  const exeRow = local && (
    <SetRow
      id="exe"
      title={labelOf('exe')}
      desc={caps.nativeFilePicker ? '留空时由后台服务自动检测' : '当前平台不支持原生文件选择器，请在配置文件中手动填写'}
      control={
        <>
          <code className={styles.path}>{exe ? String(exe) : '自动检测'}</code>
          <Btn disabled={ro || !caps.nativeFilePicker} disabledReason="当前平台不支持原生文件选择器" onClick={() => void pickExe()}>
            选择…
          </Btn>
        </>
      }
    />
  );
  if (selected === 'pi') return <KernelPi>{exeRow}</KernelPi>;
  return (
    <SetSection title={`${KERNEL_LABEL[selected] ?? selected} 运行`} info="修改后须点击底部「应用」生效。">
      {exeRow}
      <WorkspaceRow />
    </SetSection>
  );
}
