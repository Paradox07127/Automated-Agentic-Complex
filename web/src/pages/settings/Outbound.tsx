import { usePlugins } from '../../shell/plugins';
import { useSettings } from './ctx';
import { KERNEL_LABEL, SVC } from './fields';
import { Btn, Pill } from '../../ui';
import { REGISTRY } from './registry';
import { Slab } from './Slab';
import styles from './groups.module.css';

/** One data type that can leave the machine: on (null: an agentd switch it depends on was not read), and the row its switch lives on. */
export interface OutRow {
  key: string;
  label: string;
  row: string;
  /** What of the type leaves, when a setting narrows it. */
  detail?: string;
  on: boolean | null;
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

/** Each observation type the role kernel interprets, and whether it goes to the cloud under the switches on this page. */
export function useOutboundRows(): OutRow[] {
  const { model, perms } = useSettings();
  const plugins = usePlugins();
  const on = (id: string) => {
    const value = model.value(id);
    return typeof value === 'boolean' ? value : null;
  };
  const shot = perms.find((p) => p.kind === 'screenRecording')?.state;
  const cloud = kernelCloud(model.value('kernel'), model.value('acct'));
  const grain = model.value('grain');
  const windowText = typeof grain === 'string' ? grain !== 'status' : null;
  // A row's data is collected only while the plug-in owning the row is on.
  const active = (id: string) => {
    const p = REGISTRY.find((r) => r.id === id)?.plugin;
    return !p || plugins[p];
  };
  const toCloud = (id: string, permitted: boolean | null = true) => allowed(active(id), on(id), permitted, cloud);
  return [
    { key: 'shot', label: '截图', row: 'shot', on: toCloud('shot', shot ? shot === 'granted' : null) },
    // At `status` saved_consent turns window text off whatever its own switch says.
    { key: 'wintext', label: '窗口文字', row: 'wintext', ...(typeof grain === 'string' && { detail: GRAIN_DETAIL[grain] }), on: toCloud('wintext', windowText) },
    { key: 'web', label: '网页正文', row: 'web', on: toCloud('web') },
    { key: 'typing', label: '输入的文字', row: 'typing', on: toCloud('typing') },
    { key: 'agent_sessions', label: '编码会话', row: 'agent_sessions', on: toCloud('agent_sessions') },
  ];
}

/** 会离开这台电脑的: the types sent out now and where to (kernel and service), whether redaction is on, and the way to today's screenshots on 每日简报. */
export function OutboundPlate() {
  const { diag, model, goPage, goRow } = useSettings();
  const rows = useOutboundRows();
  const out = rows.filter((r) => r.on === true);
  const unread = rows.some((r) => r.on == null);
  const kernel = String(model.value('kernel') ?? '');
  const svc = String(model.value('svc') ?? '');
  const dest = kernel === 'pi' ? `Pi │ ${SVC.find((o) => o.value === svc)?.label ?? '模型服务'}` : (KERNEL_LABEL[kernel] ?? '角色内核');
  const mask = model.value('mask');
  return (
    <Slab id="out" variant="plate" label="外发总览">
      <div className={styles.out}>
        <span className={styles.outLbl}>{REGISTRY.find((r) => r.id === 'out')?.label}</span>
        <span className={styles.flow}>
          {out.map((r) => (
            <button key={r.key} type="button" className={styles.chipBtn} title="跳到这一项的开关" onClick={() => goRow(r.row)}>
              <Pill>{r.detail ? `${r.label}（${r.detail}）` : r.label}</Pill>
            </button>
          ))}
          {out.length === 0 && <Pill dashed>{unread ? '未读到' : '没有'}</Pill>}
          <span className={styles.to}>
            → <b>{dest}</b> │ 发出前遮蔽 {mask === true ? '开' : mask === false ? '关' : '—'}
          </span>
        </span>
        {diag.screenshots && <Btn variant="link" onClick={() => goPage({ page: 'overview', tab: 'tm' })}>在每日简报看今天的截图 ›</Btn>}
      </div>
    </Slab>
  );
}
