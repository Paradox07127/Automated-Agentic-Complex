import { getBridge } from '../../bridge';
import type { RuntimeInfo } from '../../domain';
import { kernelBreak } from '../../features/kernel';
import { useSettings } from './ctx';
import { RUNTIME_ERROR, RUNTIME_ERROR_UNKNOWN } from './fields';
import { runInTerminal } from './terminal';

const STEP = ['已安装', '版本可用', '已登录'];
/** What a re-check that stops at that node still lacks. */
const STILL = ['仍没找到可执行文件', '版本仍不可用', '仍未登录'];

/** Kernel actions shared by the current-kernel card and the picker cards. */
export function useKernelActions() {
  const { model, recheckRuntime } = useSettings();
  const bridge = getBridge();
  return {
    onCopy: (cmd: string) => void bridge.clipboard.writeText(cmd).then(() => model.notify({ message: `已复制：${cmd}` })),
    onRunInTerminal: (cmd: string) =>
      void runInTerminal(bridge, cmd).then((how) =>
        model.notify(
          how === 'ran'
            ? { message: `已在终端运行：${cmd} │ 登录后点「重新检测」` }
            : { message: `已复制「${cmd}」 │ 这个外壳还不能直接打开终端，粘贴到终端运行后点「重新检测」`, persistent: true },
        ),
      ),
    /** Applies at once through PUT /character/runtime, like 改用 on the desktop kernel card; not a draft. */
    onSwitch: async (id: string, name: string) => {
      if (!(await model.save({ kernel: id }, `改用 ${name}`))) return;
      model.setDraft(({ kernel: _applied, ...rest }) => rest);
      model.notify({ message: `已改用 ${name}`, severity: 'success' });
    },
    /** Re-check; on failure the chain stays on the broken node and the toast names it. */
    recheck: async (name: string, id: string) => {
      const snap = await recheckRuntime();
      const r: RuntimeInfo | undefined = snap?.runtimes.find((x) => x.id === id);
      if (!snap || !r) return model.notify({ message: '重新检测失败：后台服务没有响应', severity: 'danger', persistent: true });
      const bi = kernelBreak(r);
      if (bi >= 0) return model.notify({ message: `重新检测：${name} ${STILL[bi]}（停在「${STEP[bi]}」这一格）`, severity: 'warning', persistent: true });
      if (snap.selected === id && !snap.ready) {
        const problem = snap.error ? (RUNTIME_ERROR[snap.error] ?? RUNTIME_ERROR_UNKNOWN).label : null;
        return model.notify({ message: `重新检测：${name} 尚未就绪${problem ? ` │ ${problem}` : ''}`, severity: 'warning', persistent: true });
      }
      model.notify({ message: `已重新检测：${name} 已就绪`, severity: 'success' });
    },
  };
}
