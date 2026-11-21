import { useEffect } from 'react';
import type { PermissionKind } from '../../../bridge';
import { PLUGINS } from '../../../bridge/plugins.generated';
import { pluginKey, setPlugins, type PluginId } from '../../../shell/plugins';
import { useControls } from '../controls';
import { useSettings } from '../ctx';
import { labelOf } from '../registry';
import { SetRow } from '../SetRow';
import { SetSection } from '../SetSection';
import { PermTag } from './Perm';

/** What each plug-in does, in the row's ⓘ. */
const ABOUT: Record<Exclude<PluginId, 'light_ai'>, string> = {
  screen_awareness: '持续看前台窗口和活动，用来主动搭话和写日报',
  screen_reading: '按热键时识读一次屏幕、选中的文字或剪贴板',
  daily_brief: '今天页、每日和每周简报、工作记录',
  coding_sessions: '接入 Claude Code 和 Codex，播报会话进度、显示审批卡',
  personal_agent: '派发任务、定时任务和交付',
  harness_bridge: '用 Claude Code、Codex 或 ACP 智能体当角色内核',
  computer_use: '角色在你授权的窗口里操作电脑',
  external_access: '让外部智能体通过 MCP 或命令行和角色对话',
  motion_generation: '用本地 GPU 服务生成新动作',
};

/** System permissions a plug-in needs to work. */
const NEEDS: Partial<Record<PluginId, PermissionKind[]>> = {
  screen_awareness: ['accessibility', 'screenRecording'],
  screen_reading: ['screenRecording'],
  computer_use: ['accessibility', 'screenRecording'],
};

/** 插件: one switch per plug-in, written to config.json; 轻量 AI is always on and has none. */
export function PluginsGroup() {
  const { model, native, perms } = useSettings();
  const c = useControls();
  // Pages, home keys and rows follow each saved switch at once; the backend takes it on its restart.
  const saved = native?.saved;
  useEffect(() => void (saved && setPlugins({ ...saved, ...model.vals })), [saved, model.vals]);
  return (
    <SetSection title="插件">
      {PLUGINS.filter((p) => p.tier === 'plugin').map((p) => {
        const id = p.id as Exclude<PluginId, 'light_ai'>;
        const key = pluginKey(id);
        const need = perms.filter((r) => NEEDS[id]?.includes(r.kind));
        return (
          <SetRow
            key={id}
            id={key}
            title={labelOf(key)}
            desc={ABOUT[id]}
            control={
              <>
                {need.map((r) => (
                  <PermTag key={r.kind} p={r} named />
                ))}
                {c.toggle(key)}
              </>
            }
          />
        );
      })}
    </SetSection>
  );
}
