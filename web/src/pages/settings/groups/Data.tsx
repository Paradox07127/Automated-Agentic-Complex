import { getBridge } from '../../../bridge';
import { Btn } from '../../../ui';
import { clearAttention, failure, forgetRecent, type Range } from '../api';
import { useControls } from '../controls';
import { useSettings } from '../ctx';
import { ARCHIVE } from '../fields';
import type { ConfirmSpec } from '../model';
import { SetRow } from '../SetRow';
import { SetSection } from '../SetSection';

/** Confirm texts keep the exact deletion scope. */
export function dataConfirm(id: 'delrecent' | 'delact', span?: string): Omit<ConfirmSpec, 'onConfirm'> {
  if (id === 'delrecent') {
    return { title: `删掉最近 ${span ?? ''} 看到的？`, danger: true, warning: '不能恢复', note: `删除最近 ${span ?? ''} 的观察记录，连同活动摘要和由它推出的记忆。`, confirmLabel: '删除' };
  }
  return { title: '清空活动记录？', danger: true, warning: '不能恢复', note: '删除全部观察记录，连同活动摘要和由它推出的记忆。', confirmLabel: '清空' };
}

const RANGES: Array<[Range, string]> = [
  ['15m', '15 分钟'],
  ['1h', '1 小时'],
  ['today', '今天'],
];

const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0);

/** 数据: delete actions (all danger-confirmed), history retention, data folder. */
export function DataGroup() {
  const { model, ro } = useSettings();
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
    bridge.settings.wipeLocalData().then(
      () => model.notify({ message: '已删除所有本地数据', severity: 'success' }),
      (e: { code?: string }) => {
        // declined: the user cancelled the shell's own confirm.
        if (e?.code !== 'declined') model.notify({ message: '没能删除所有本地数据', severity: 'danger', persistent: true });
      },
    );

  return (
    <SetSection title="数据">
      <SetRow
        id="delrecent"
        opens
        title="删除最近观察记录"
        desc="删除所选时段的观察、摘要和由其推断的记忆"
        control={RANGES.map(([range, x]) => (
          <Btn
            key={range}
            size="sm"
            variant="ghost"
            disabled={ro}
            onClick={() => ask(dataConfirm('delrecent', x), async () => `已删掉最近 ${x} 看到的 ${sum(await forgetRecent(range))} 条`, '没能删除')}
          >
            {x}
          </Btn>
        ))}
      />
      <SetRow
        id="delact"
        opens
        title="清空活动记录…"
        desc="连同活动摘要和由它推出的记忆"
        control={
          <Btn size="sm" variant="danger" disabled={ro} onClick={() => ask(dataConfirm('delact'), async () => `已清空活动记录 ${(await clearAttention()).deleted} 条`, '没能清空')}>
            清空…
          </Btn>
        }
      />
      <SetRow
        id="archive"
        title="历史归档"
        desc="默认全部保留；7 天趋势靠这些历史"
        control={c.seg('archive', ARCHIVE)}
      />
      <SetRow
        id="datadir"
        title="打开数据文件夹"
        desc="记忆、对话和活动记录都在这里"
        control={
          <Btn
            size="sm"
            variant="secondary"
            onClick={() =>
              void bridge.app.action('open_data_folder').then(
                () => model.notify({ message: '已打开数据文件夹' }),
                () => model.notify({ message: '这个外壳还不能打开数据文件夹', severity: 'warning' }),
              )
            }
          >
            打开文件夹
          </Btn>
        }
      />
      <SetRow
        id="delall"
        opens
        title="删除所有本地数据…"
        desc="记忆、对话、任务记录、活动记录，连同 Trace 事件"
        control={
          // The shell asks for confirmation itself.
          <Btn size="sm" variant="danger" disabled={ro} onClick={() => void wipe()}>
            删除所有…
          </Btn>
        }
      />
    </SetSection>
  );
}
