import { getBridge } from '../../../bridge';
import { clearAttention, failure, forgetRecent, type Range } from '../api';
import { useControls } from '../controls';
import { useSettings } from '../ctx';
import { ARCHIVE } from '../fields';
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
    return { title: `删除最近 ${span ?? ''} 的屏幕观察记录？`, danger: true, warning: '删除后无法恢复', note: `将删除最近 ${span ?? ''} 的屏幕观察记录，连同关联的活动摘要与衍生记忆。`, confirmLabel: '删除' };
  }
  return { title: '清空所有活动与观察记录？', danger: true, warning: '删除后无法恢复', note: '将删除全部屏幕观察记录、操作时间线、活动摘要与衍生记忆，以及全部 Trace 事件。', confirmLabel: '清空' };
}

/** What 删除所有本地数据 removes and keeps (main/ops/settings.ts wipeLocalData). */
export const WIPE: Omit<ConfirmSpec, 'onConfirm'> = {
  title: '确认删除所有本地数据？',
  danger: true,
  warning: '删除后无法恢复',
  list: ['记忆、对话记录', '任务记录、活动与观察记录', 'Trace 事件与后台日志'],
  note: '设置项与 API Key 将予保留。',
  confirmLabel: '删除全部',
};

const RANGES: Array<[Range, string]> = [
  ['15m', '15 分钟'],
  ['1h', '1 小时'],
  ['today', '今日'],
];

/** Groups 恢复默认 resets; the kernel and model rows, the login item and the character page stay. */
const RESET_GROUPS = ['speak', 'keys', 'privacy', 'plugins', 'display'];

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
          () => model.notify({ message: '未能删除所有本地数据', severity: 'danger', persistent: true }),
        ),
    });

  /** The confirm lists what this reset really changes: schema defaults turn some reading switches on and others off. */
  const reset = () => {
    if (!native) return model.notify({ message: '未能读取设置，无法恢复默认', severity: 'danger', persistent: true });
    const changes = Object.entries(defaultsOf(native, RESET_GROUPS)).filter(([id, v]) => model.vals[id] !== v);
    if (changes.length === 0) return model.notify({ message: '已经是默认设置' });
    const names = (to: boolean) => changes.filter(([, v]) => v === to).map(([id]) => labelOf(id));
    const on = names(true);
    const off = names(false);
    const other = changes.length - on.length - off.length;
    const gone = changes.filter(([id, v]) => v === false && native.rows[id]?.destructive).map(([id]) => DELETE_WHAT[id] ?? labelOf(id));
    model.ask({
      title: '恢复默认设置？',
      danger: gone.length > 0,
      warning: gone.length ? `将同步清除已收集的${gone.join('、')}，且不可恢复` : `将重置 ${changes.length} 项设置至默认值`,
      list: [on.length ? `将开启：${on.join('、')}` : '', off.length ? `将关闭：${off.join('、')}` : '', other ? `另有 ${other} 项选项将恢复默认值` : ''].filter(Boolean),
      note: '保持不变：模型账号、API Key、角色页面设置、登录项及现有对话与记忆记录（除上述关联清除项外）。',
      confirmLabel: '恢复默认',
      onConfirm: async () => {
        if (await model.resetTo(defaultsOf(native, RESET_GROUPS))) model.notify({ message: '已恢复默认设置', severity: 'success' });
      },
    });
  };

  return (
    <>
      <SetSection title="数据保留">
        <SetRow id="archive" title={labelOf('archive')} desc="控制运行记录与状态日志的保留期限（7 天趋势图依赖此数据）" control={c.seg('archive', ARCHIVE)} />
        <SetRow
          id="datadir"
          title={labelOf('datadir')}
          desc="记忆、对话与活动记录的本地存储位置"
          control={
            <Btn
              go
              onClick={() =>
                void bridge.app.action('open_data_folder').then(
                  () => model.notify({ message: '已打开数据文件夹' }),
                  () => model.notify({ message: '当前环境暂不支持打开数据文件夹', severity: 'warning' }),
                )
              }
            >
              打开
            </Btn>
          }
        />
      </SetSection>

      <SetSection title="数据清理" right={<span className={styles.bad}>删除后无法恢复</span>}>
        <SetRow
          id="delrecent"
          title={labelOf('delrecent')}
          desc="同时删除关联的活动摘要与衍生记忆"
          control={RANGES.map(([range, x]) => (
            <Btn key={range} disabled={ro} disabledReason="后台服务未运行" onClick={() => ask(dataConfirm('delrecent', x), async () => `已删除最近 ${x} 的屏幕观察记录（共 ${sum(await forgetRecent(range))} 条）`, '未能删除')}>
              {x}
            </Btn>
          ))}
        />
        <SetRow
          id="delact"
          title={labelOf('delact')}
          desc="删除全部屏幕观察记录、操作时间线、活动摘要、衍生记忆与 Trace 事件"
          control={
            <Btn variant="danger" disabled={ro} disabledReason="后台服务未运行" onClick={() => ask(dataConfirm('delact'), () => clearAttention().then((r) => `已清空活动记录 ${r.deleted} 条、Trace 事件 ${r.trace_deleted} 条`), '未能清空')}>
              清空…
            </Btn>
          }
        />
        <SetRow
          id="reset"
          title={labelOf('reset')}
          desc="交流、能力开关、感知、快捷键与外观设置恢复默认；模型账号、角色设定与既有记忆不受影响"
          control={
            <Btn disabled={groupRo || !native} disabledReason="未能读取当前设置" onClick={reset}>
              恢复默认…
            </Btn>
          }
        />
        <SetRow
          id="delall"
          title={labelOf('delall')}
          desc="删除记忆、对话、任务、活动记录、Trace 与日志；设置项与 API Key 保留"
          control={
            <Btn variant="danger" disabled={ro} disabledReason="后台服务未运行" onClick={wipe}>
              删除全部…
            </Btn>
          }
        />
      </SetSection>
    </>
  );
}
