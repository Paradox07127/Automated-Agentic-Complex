import { useEffect, useState } from 'react';
import { Fold } from '../../../ui/Fold';
import { Btn, Missing, RadioDot, Skel, Table, TableCell, TableHead, TableRow } from '../../../ui';
import { StatusLamp } from '../../../ui/game';
import { useSettings } from '../ctx';
import { failure, installAcpAgent, readAcpAgents, type AcpAgent, type AcpAgents, type AcpInstall } from '../api';
import { RUNSRC } from '../fields';
import { labelOf } from '../registry';
import { Slab } from '../Slab';
import { usable } from './KernelCard';
import styles from '../groups.module.css';

export const acpKey = (a: AcpAgent) => `${a.source}:${a.id}`;
const authNames = (a: AcpAgent | undefined) => (a?.probe?.auth_methods ?? []).map((m) => m.name ?? m.id ?? '').filter(Boolean).join('、');

/** `/character/acp/agents` for the ACP picker and the route table; `refresh` re-runs the local agents' initialize probe. */
export function useAcpAgents(agentdOff: boolean) {
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

export type AcpState = ReturnType<typeof useAcpAgents>;

/** ACP 智能体: the installed agents, then those npx or uvx would download in a fold; picking one is a draft. */
export function AcpAgentSlab({ acp, onSwitch }: { acp: AcpState; onSwitch: (id: string) => void }) {
  const { model, ro, agentdOff, runtime } = useSettings();
  const [installing, setInstalling] = useState<string | null>(null);
  const list = runtime!.runtimes;
  const agents = acp.list ? [...acp.list.agents.filter((a) => a.source === 'local'), ...acp.list.agents.filter((a) => a.source !== 'local')] : [];
  const runnable = (a: AcpAgent) => a.source === 'local' || (a.source === 'npx' ? acp.list?.npx : acp.list?.uvx) === true;
  const saved = `${String(runtime!.wire.acp_launcher)}:${String(runtime!.wire.acp_agent)}`;
  // A bridge of a harness with its own kernel stays pickable only while it is the saved agent.
  const pickable = (a: AcpAgent) => runnable(a) && (!a.native_backend || acpKey(a) === saved);
  // Agents that only run through npx or uvx wait in a fold; the saved one stays in view.
  const installed = agents.filter((a) => a.source === 'local' || acpKey(a) === saved);
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
              <RadioDot size="sm" checked={on} label={a.name} disabled={off} />
            </TableCell>
            <TableCell>{a.name}</TableCell>
            <TableCell mono>{a.version ?? <Missing why="na" />}</TableCell>
            <TableCell>{a.source === 'local' ? RUNSRC.find((o) => o.value === 'local')?.label : a.source}</TableCell>
            <TableCell>
              {a.native_backend ? (
                <span className={styles.cellActs} onClick={(e) => e.stopPropagation()}>
                  <StatusLamp size="sm" state="idle" label="用直连" />
                  <Btn disabled={ro || !native || !usable(native)} disabledReason={`本机没有 ${nativeName}`} onClick={() => onSwitch(a.native_backend!)}>{`改用 ${nativeName}`}</Btn>
                </span>
              ) : a.source !== 'local' ? (
                <span className={styles.cellActs} onClick={(e) => e.stopPropagation()}>
                  <Btn disabled={off} disabledReason={runnable(a) ? undefined : `本机没有 ${a.source}`} onClick={() => pickAcp(key)}>
                    下载并运行
                  </Btn>
                  <Btn loading={installing === a.id} disabled={ro || agentdOff || installing != null} disabledReason={agentdOff ? '后台服务没有运行' : '正在安装'} onClick={() => void installAcp(a)}>
                    安装
                  </Btn>
                </span>
              ) : !a.probe ? (
                <StatusLamp size="sm" state="idle" label="未检测" />
              ) : a.probe.ok ? (
                <StatusLamp size="sm" state="ok" label="可用" />
              ) : (
                <StatusLamp size="sm" state="broken" label={names ? `要登录：${names}` : '检测失败'} />
              )}
              {on && ('acpAgent' in model.draft || 'acpLauncher' in model.draft) && <span className={styles.att}> │ 未应用</span>}
            </TableCell>
          </TableRow>
        );
      })}
    </Table>
  );

  return (
    <Slab
      id="acpAgent"
      indent
      title={labelOf('acpAgent')}
      right={
        <Btn loading={acp.probing} disabled={agentdOff} disabledReason="后台服务没有运行" onClick={() => void acp.refresh()}>
          重新检测
        </Btn>
      }
    >
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
    </Slab>
  );
}
