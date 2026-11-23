import { getBridge } from '../../../bridge';
import { clearAttention, failure, forgetRecent, type Range } from '../api';
import { useControls } from '../controls';
import { useSettings } from '../ctx';
import { ARCHIVE } from '../fields';
import { groupDesc } from '../groups';
import { Btn } from '../../../ui';
import type { ConfirmSpec } from '../model';
import { defaultsOf } from '../native';
import { DELETE_WHAT, labelOf } from '../registry';
import { SetRow } from '../SetRow';
import { SetSection } from '../SetSection';
import styles from '../groups.module.css';

/** Confirm texts keep the exact deletion scope. */
export function dataConfirm(id: 'delrecent' | 'delact', span?: string): Omit<ConfirmSpec, 'onConfirm'> {
  if (id === 'delrecent') {
    return { title: `删掉最近 ${span ?? ''} 看到的？`, danger: true, warning: '删除后不能恢复', note: `删除最近 ${span ?? ''} 的观察记录，连同活动摘要和由它推出的记忆。`, confirmLabel: '删除' };
  }
  return { title: '清空活动记录？', danger: true, warning: '删除后不能恢复', note: '删除全部观察记录，连同活动摘要和由它推出的记忆。', confirmLabel: '清空' };
}

/** What 删除所有本地数据 removes and keeps (main/ops/settings.ts wipeLocalData). */
export const WIPE: Omit<ConfirmSpec, 'onConfirm'> = {
  title: '删除所有本地数据？',
  danger: true,
  warning: '删除后不能恢复',
  list: ['记忆、对话', '任务记录、活动记录', 'Trace 事件和后台日志'],
  note: '设置和 API Key 保留。',
  confirmLabel: '删除所有',
};

const RANGES: Array<[Range, string]> = [
  ['15m', '15 分钟'],
  ['1h', '1 小时'],
  ['today', '今天'],
];

/** Groups 恢复默认 resets; the kernel and model rows, the login item and the character page stay. */
const RESET_GROUPS = ['speak', 'keys', 'privacy', 'perm'];

const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);

/** 数据: how long history stays and where, then every way to delete (each confirmed on the white card). */
export function DataGroup() {
  const { model, ro: groupRo, agentdOff, native } = useSettings();
  // The deletions go through agentd; 恢复默认 is config.json and works without it.
  const ro = groupRo || agentdOff;
  const c = useControls();
  const bridge = getBridge();
  /** `run` resolves to the success line; a failure toasts its reason instead. */
  const ask = (spec: Omit<ConfirmSpec, 'onConfirm'>, run: () => Promise<string>, what: string) =>
    model.ask({
      ...spec,
      onConfirm: () =>
        run().then(
          (done) => model.notify({ message: done, severity: 'success' }),
          (e) => model.notify({ message: `${what}：${failure(e).text}`, severity: 'danger', persistent: true }),
        ),
    });
  const wipe = () =>
    model.ask({
      ...WIPE,
      onConfirm: () =>
        bridge.settings.wipeLocalData().then(
          () => model.notify({ message: '已删除所有本地数据', severity: 'success' }),
          () => model.notify({ message: '没能删除所有本地数据', severity: 'danger', persistent: true }),
        ),
    });

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
    model.ask({
      title: '恢复默认设置？',
      danger: true,
      warning: gone.length ? `会删除已收集的${gone.join('、')}，不能恢复` : `会改动 ${changes.length} 项设置`,
      list: [on.length ? `会打开：${on.join('、')}` : '', off.length ? `会关掉：${off.join('、')}` : '', other ? `另有 ${other} 项选项回到默认` : ''].filter(Boolean),
      note: '不改动：内核、账号、API Key、记忆和数据。',
      confirmLabel: '恢复默认',
      onConfirm: async () => {
        if (await model.resetTo(defaultsOf(native, RESET_GROUPS))) model.notify({ message: '已恢复默认设置', severity: 'success' });
      },
    });
  };

  return (
    <>
      <SetSection title="保留" info={groupDesc('data')}>
        <SetRow id="archive" title={labelOf('archive')} desc="运行记录和状态日志；7 天趋势靠它" control={c.seg('archive', ARCHIVE)} />
        <SetRow
          id="datadir"
          title={labelOf('datadir')}
          desc="记忆、对话和活动记录都在这里"
          control={
            <Btn
              go
              onClick={() =>
                void bridge.app.action('open_data_folder').then(
                  () => model.notify({ message: '已打开数据文件夹' }),
                  () => model.notify({ message: '这个外壳还不能打开数据文件夹', severity: 'warning' }),
                )
              }
            >
              打开
            </Btn>
          }
        />
      </SetSection>

      <SetSection title="删除" right={<span className={styles.bad}>删除后不能恢复</span>}>
        <SetRow
          id="delrecent"
          title={labelOf('delrecent')}
          desc="连同活动摘要和由它推出的记忆"
          control={RANGES.map(([range, x]) => (
            <Btn key={range} disabled={ro} disabledReason="后台服务没有运行" onClick={() => ask(dataConfirm('delrecent', x), async () => `已删掉最近 ${x} 看到的 ${sum(await forgetRecent(range))} 条`, '没能删除')}>
              {x}
            </Btn>
          ))}
        />
        <SetRow
          id="delact"
          title={labelOf('delact')}
          desc="全部观察记录、活动摘要和由它推出的记忆"
          control={
            <Btn variant="danger" disabled={ro} disabledReason="后台服务没有运行" onClick={() => ask(dataConfirm('delact'), async () => `已清空活动记录 ${(await clearAttention()).deleted} 条`, '没能清空')}>
              清空…
            </Btn>
          }
        />
        <SetRow
          id="reset"
          title={labelOf('reset')}
          desc="说话、能做、观察、按键回到默认；内核、账号、记忆不动"
          control={
            <Btn disabled={groupRo || !native} disabledReason="没读到设置" onClick={reset}>
              恢复默认…
            </Btn>
          }
        />
        <SetRow
          id="delall"
          title={labelOf('delall')}
          desc="记忆、对话、任务、活动记录、Trace 和日志；设置和 API Key 保留"
          control={
            <Btn variant="danger" disabled={ro} disabledReason="后台服务没有运行" onClick={wipe}>
              删除所有…
            </Btn>
          }
        />
      </SetSection>
    </>
  );
}
