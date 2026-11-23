import { getBridge } from '../../../bridge';
import { Btn, Missing, Table, TableCell, TableHead, TableRow } from '../../../ui';
import { useControls } from '../controls';
import { useSettings } from '../ctx';
import { RUNSRC } from '../fields';
import { groupDesc } from '../groups';
import { St } from '../kit';
import { labelOf, useRowShown } from '../registry';
import { SetRow } from '../SetRow';
import { SetSection } from '../SetSection';
import { Slab } from '../Slab';
import styles from '../groups.module.css';

/** pi_runner.mjs APPROVED: Pi's own tools that wait for an approval card while 工具审批 is on. */
const PI_APPROVED: ReadonlySet<string> = new Set(['bash', 'powershell', 'write', 'edit']);
/** pi_runner.mjs builtinTools: why Pi leaves one of its tools out on this machine. */
const PI_TOOL_MISSING: Record<string, string> = {
  bash_not_found: '没找到 bash',
  powershell_not_found: '没找到 PowerShell',
  rg_not_found: '本机没有 rg',
  fd_not_found: '本机没有 fd',
};

/** 工作区: where her files go; a picked folder is a draft. */
export function WorkspaceRow({ indent }: { indent?: boolean }) {
  const { model, ro, caps } = useSettings();
  const bridge = getBridge();
  const workspace = model.value('workspace');
  const pick = async () => {
    const h = await bridge.files.pickFolder({ purpose: 'session_cwd' });
    if (h) model.setHandle('workspace', h);
    else model.notify({ message: '没有选择文件夹，工作区保持不变' });
  };
  return (
    <SetRow
      id="workspace"
      title={labelOf('workspace')}
      desc="她写的文件放在这里"
      indent={indent}
      control={
        <>
          <code className={styles.path}>{workspace ? String(workspace) : '~/AgenticComplex'}</code>
          <Btn disabled={ro || !caps.nativeFilePicker} disabledReason="这个平台没有原生文件选择器" onClick={() => void pick()}>
            选择…
          </Btn>
        </>
      }
    />
  );
}

/** Pi's own rows: tool approval, the cost cap, the workspace; for a developer the run source and the tools its last session found. */
export function KernelPi() {
  const { model, runtime } = useSettings();
  const c = useControls();
  const shown = useRowShown();
  const piSession = runtime!.wire.pi_session;
  const piTools: Array<[string, string | null]> = piSession
    ? [...piSession.builtin_tools.map((t): [string, null] => [t, null]), ...Object.entries(piSession.builtin_tools_unavailable)]
    : [];
  const piApproval = model.value('piApproval') === true;
  // Only a saved, ready Pi knows its model has no catalog price; the cap then never stops a run.
  const unpriced = runtime!.selected === 'pi' && runtime!.ready && runtime!.wire.capability_flags?.catalog_priced === false;
  return (
    <SetSection title="Pi" info={groupDesc('kernel')}>
      <SetRow
        id="piApproval"
        title={labelOf('piApproval')}
        desc={piApproval ? 'bash、PowerShell、write、edit 出审批卡' : '这四种工具直接运行，不出审批卡'}
        descTone={piApproval ? undefined : 'attention'}
        info="read、grep、find、ls 不问。"
        control={c.toggle('piApproval', labelOf('piApproval'))}
      />
      <SetRow
        id="maxCost"
        title={labelOf('maxCost')}
        desc={unpriced ? '这个模型没有目录价格，上限不起作用' : '超过就停下这次运行；模型没有目录价格时不起作用'}
        control={c.stepper('maxCost', 0.5, 20, 0.5, (n) => `$${n.toFixed(2)}`, unpriced, '这个模型没有目录价格')}
      />
      <WorkspaceRow />
      <SetRow id="runsrc" title={labelOf('runsrc')} control={c.seg('runsrc', RUNSRC)} />
      {shown('piTools') &&
        (piSession ? (
          <Slab id="piTools" title={labelOf('piTools')}>
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
                    <TableCell>{why ? <St tone="bad">{PI_TOOL_MISSING[why] ?? why}</St> : <St tone="ok">可用</St>}</TableCell>
                    <TableCell mono>{shell ?? <Missing why="na" />}</TableCell>
                    <TableCell>{!why && piApproval && PI_APPROVED.has(name) ? '要批准' : <Missing why="na" />}</TableCell>
                  </TableRow>
                );
              })}
            </Table>
          </Slab>
        ) : (
          <SetRow id="piTools" title={labelOf('piTools')} control={<Missing why="na" reason="未启动" />} />
        ))}
    </SetSection>
  );
}
