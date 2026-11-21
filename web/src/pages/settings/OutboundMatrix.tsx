import { Missing, Table, TableCell, TableHead, TableRow } from '../../ui';
import { useSettings } from './ctx';
import { KERNEL_LABEL } from './fields';
import styles from './OutboundMatrix.module.css';

export type Dest = 'local' | 'cloud';
export const DESTS: Dest[] = ['local', 'cloud'];

/** One outbound route: on (null: an agentd switch it depends on was not read), and the setting row a click jumps to. A data type that never goes to a destination reads「无」. */
export type Route = { on: boolean | null; row: string };

export interface MatrixRow {
  key: string;
  label: string;
  /** Row the data type's own switch lives on. */
  row: string;
  /** What of the type leaves, when a setting narrows it. */
  detail?: string;
  to: Partial<Record<Dest, Route>>;
}

/** privacy.py `saved_consent`: the window text `screen_context_level` (setting `grain`) lets out. */
const GRAIN_DETAIL: Record<string, string> = { status: '仅读状态', focused: '仅焦点元素', window: '整个窗口' };

/** Whether the selected role kernel is a cloud model; null when the kernel was not read. Pi on a keyless local service is held to loopback by agentd. */
function kernelCloud(kernel: unknown, acct: unknown): boolean | null {
  if (typeof kernel !== 'string' || !(kernel in KERNEL_LABEL)) return null;
  if (kernel !== 'pi') return true;
  return typeof acct === 'string' ? acct !== 'local_no_auth' : null;
}

function allowed(...states: Array<boolean | null>): boolean | null {
  if (states.includes(false)) return false;
  return states.includes(null) ? null : true;
}

/** Data type × destination with on/off, from the switches on this page. Every type here is observation evidence the role kernel interprets. */
export function useOutboundRows(): MatrixRow[] {
  const { model, perms } = useSettings();
  const on = (id: string) => {
    const value = model.value(id);
    return typeof value === 'boolean' ? value : null;
  };
  const shot = perms.find((p) => p.kind === 'screenRecording')?.state;
  const cloud = kernelCloud(model.value('kernel'), model.value('acct'));
  const grain = model.value('grain');
  const windowText = typeof grain === 'string' ? grain !== 'status' : null;
  const active = on('observe');
  const local = (id: string, permitted: boolean | null = true): Route => ({ on: allowed(active, on(id), permitted), row: id });
  const toCloud = (id: string, permitted: boolean | null = true): Route => ({ on: allowed(active, on(id), permitted, cloud), row: id });
  return [
    { key: 'shot', label: '截图', row: 'shot', to: { cloud: toCloud('shot', shot ? shot === 'granted' : null) } },
    // At `status` saved_consent turns window text off whatever its own switch says.
    { key: 'wintext', label: '窗口文字', row: 'wintext', ...(typeof grain === 'string' && { detail: GRAIN_DETAIL[grain] }), to: { local: local('wintext', windowText), cloud: toCloud('wintext', windowText) } },
    { key: 'web', label: '网页正文', row: 'web', to: { local: local('web'), cloud: toCloud('web') } },
    { key: 'typing', label: '输入的文字', row: 'typing', to: { local: local('typing'), cloud: toCloud('typing') } },
    { key: 'agent_sessions', label: '编码会话', row: 'agent_sessions', to: {
      local: local('agent_sessions'), cloud: toCloud('agent_sessions'),
    } },
  ];
}

/** 外发明细: the flow map's routes as a table, one row per data type; a row opens its setting. */
export function OutboundMatrix({ rows }: { rows: MatrixRow[] }) {
  const { model, goRow } = useSettings();
  return (
    <Table
      label="外发"
      head={
        <TableHead>
          <TableCell head>数据类型</TableCell>
          <TableCell head>本机</TableCell>
          <TableCell head>云端</TableCell>
        </TableHead>
      }
      onOpen={(key) => {
        const r = rows.find((x) => x.key === key);
        if (r) goRow(r.row);
      }}
    >
      {rows.map((r) => (
        <TableRow key={r.key} id={r.key}>
          <TableCell>
            <button type="button" className={styles.link} tabIndex={-1} onClick={() => goRow(r.row)}>
              {r.label}
            </button>
            {r.detail && <span className={styles.off}> │ {r.detail}</span>}
          </TableCell>
          {DESTS.map((d) => {
            const route = r.to[d];
            if (!route)
              return (
                <TableCell key={d}>
                  <Missing why="na" />
                </TableCell>
              );
            return (
              <TableCell key={d}>
                <span className={route.on ? styles.on : styles.off}>{route.on == null ? '未读到' : route.on ? '开' : '关'}</span>
                {model.pending[route.row] && <span className={styles.att}> │ 需重启</span>}
              </TableCell>
            );
          })}
        </TableRow>
      ))}
    </Table>
  );
}
