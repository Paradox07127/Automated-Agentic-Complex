import type { WireRoutePurpose } from '../../../domain/wire';
import { Table, TableCell, TableHead, TableRow } from '../../../ui';
import type { AcpAgent } from '../api';
import { useControls } from '../controls';
import { useSettings } from '../ctx';
import { KERNEL_LABEL, ROUTES, routeIds, RUNTIME_EFFORT, type Opt } from '../fields';
import { SetSection } from '../SetSection';
import styles from '../groups.module.css';

const PURPOSE: Record<WireRoutePurpose, string> = {
  chat: '对话',
  background: '后台任务',
  judge: '主动判断',
  understand: '屏幕理解',
  memory: '记忆与日志',
  computer: '电脑操控',
};

/** 按用途指定: each purpose's kernel, model and effort; a row on 跟随主内核 runs on the kernel picked above, with its model and effort, so it shows no controls for them. */
export function KernelRoutes({ agents }: { agents: AcpAgent[] }) {
  const { model, runtime } = useSettings();
  const c = useControls();
  if (!runtime) return null;
  // ACP agents with their own kernel are offered as that kernel.
  const kernels: Opt[] = [
    { value: '', label: '跟随主内核' },
    ...runtime.runtimes.filter((r) => r.id !== 'acp' && r.available !== false).map((r) => ({ value: r.id, label: KERNEL_LABEL[r.id] ?? r.name })),
    ...agents.filter((a) => a.source === 'local' && !a.native_backend).map((a) => ({ value: `acp:${a.id}`, label: a.name })),
  ];
  // A saved kernel that is no longer offered still shows as itself.
  const optionsFor = (v: string): Opt[] => (kernels.some((o) => o.value === v) ? kernels : [...kernels, { value: v, label: v.startsWith('acp:') ? v.slice(4) : (KERNEL_LABEL[v] ?? v) }]);
  return (
    <SetSection title="按用途指定">
      <div id="set-routes" data-row="routes" data-nav-target="set-routes">
        <Table
          label="按用途指定"
          head={
            <TableHead>
              <TableCell head>用途</TableCell>
              <TableCell head>内核</TableCell>
              <TableCell head>模型</TableCell>
              <TableCell head>强度</TableCell>
            </TableHead>
          }
        >
          {ROUTES.map((p) => {
            const id = routeIds(p);
            const kernel = String(model.value(id.kernel) ?? '');
            const follow = <span className={styles.t3}>同主内核</span>;
            return (
              <TableRow key={p} id={p}>
                <TableCell>{PURPOSE[p]}</TableCell>
                <TableCell>{c.select(id.kernel, optionsFor(kernel), [], false, `${PURPOSE[p]}的内核`)}</TableCell>
                <TableCell>{kernel ? c.text(id.model, `${PURPOSE[p]}的模型`, '默认模型') : follow}</TableCell>
                <TableCell>{kernel ? c.select(id.effort, RUNTIME_EFFORT, [], false, `${PURPOSE[p]}的强度`) : follow}</TableCell>
              </TableRow>
            );
          })}
        </Table>
      </div>
    </SetSection>
  );
}
