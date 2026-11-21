import { Missing, StatusTag, Table, TableCell, TableHead, TableRow } from '../../../ui';
import { useControls } from '../controls';
import { useSettings } from '../ctx';
import { RUNSRC } from '../fields';
import { SetRow } from '../SetRow';
import { SetSection } from '../SetSection';

/** pi_runner.mjs APPROVED: Pi's own tools that wait for an approval card while 工具审批 is on. */
const PI_APPROVED: ReadonlySet<string> = new Set(['bash', 'powershell', 'write', 'edit']);
/** pi_runner.mjs builtinTools: why Pi leaves one of its tools out on this machine. */
const PI_TOOL_MISSING: Record<string, string> = {
  bash_not_found: '没找到 bash',
  powershell_not_found: '没找到 PowerShell',
  rg_not_found: '本机没有 rg',
  fd_not_found: '本机没有 fd',
};

/** Pi's own rows: run source, tool approval, the tools its last session found, the cost cap. */
export function KernelPi() {
  const { model, runtime } = useSettings();
  const c = useControls();
  const piSession = runtime!.wire.pi_session;
  const piTools: Array<[string, string | null]> = piSession
    ? [...piSession.builtin_tools.map((t): [string, null] => [t, null]), ...Object.entries(piSession.builtin_tools_unavailable)]
    : [];
  const piApproval = model.value('piApproval') === true;
  // Only a saved, ready Pi knows its model has no catalog price; the cap then never stops a run.
  const unpriced = runtime!.selected === 'pi' && runtime!.ready && runtime!.wire.capability_flags?.catalog_priced === false;
  return (
    <SetSection title="Pi">
      <SetRow id="runsrc" title="运行来源" control={c.seg('runsrc', RUNSRC)} />
      <SetRow id="piApproval" title="工具审批" control={c.toggle('piApproval', '工具审批')} />
      {piSession ? (
        <div id="set-piTools" data-row="piTools" data-nav-target="set-piTools">
          <Table
            label="Pi 的工具"
            head={
              <TableHead>
                <TableCell head>工具</TableCell>
                <TableCell head>状态</TableCell>
                <TableCell head>路径</TableCell>
                <TableCell head>审批</TableCell>
              </TableHead>
            }
          >
            {piTools.map(([name, why]) => {
              const shell = name === 'bash' ? piSession.shell.bash : name === 'powershell' ? piSession.shell.powershell : null;
              return (
                <TableRow key={name} id={name}>
                  <TableCell mono>{name}</TableCell>
                  <TableCell>{why ? <StatusTag state="broken" label={PI_TOOL_MISSING[why] ?? why} /> : <StatusTag state="ok" label="可用" />}</TableCell>
                  <TableCell mono>{shell ?? <Missing why="na" />}</TableCell>
                  <TableCell>{!why && piApproval && PI_APPROVED.has(name) ? '要批准' : <Missing why="na" />}</TableCell>
                </TableRow>
              );
            })}
          </Table>
        </div>
      ) : (
        <SetRow id="piTools" title="Pi 的工具" control={<Missing why="na" reason="未启动" />} />
      )}
      <SetRow id="maxCost" title="单次费用上限" control={c.stepper('maxCost', 0.5, 20, 0.5, (n) => `$${n.toFixed(2)}`, unpriced, '这个模型没有目录价格')} />
    </SetSection>
  );
}
