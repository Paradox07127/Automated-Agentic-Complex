import type { ReactNode } from 'react';
import type { PermissionKind } from '../../bridge';
import { InfoTip } from '../../ui';
import type { PluginId } from '../../shell/plugins';
import { pluginKey, usePlugins } from '../../shell/plugins';
import { useControls } from './controls';
import { useSettings } from './ctx';
import { labelOf } from './registry';
import band from './band.module.css';
import styles from './rows.module.css';

/** What each capability does, needs and costs; the band says all three, the ⓘ repeats them for the smallest window. */
export const BAND: Record<PluginId, { does: string; needs: string; cost: string; perms?: PermissionKind[] }> = {
  light_ai: { does: '聊天、记得聊过的事、主动搭话', needs: '一个模型账号', cost: '按模型用量计' },
  screen_awareness: { does: '一直看前台窗口和活动，用来主动搭话和写简报', needs: '辅助功能、屏幕录制', cost: '本机少量 CPU；只把下面打开的项发给模型', perms: ['accessibility', 'screenRecording'] },
  screen_reading: { does: '按热键时读一次屏幕、选中的字或剪贴板', needs: '屏幕录制', cost: '每次一张截图（打开附图时）', perms: ['screenRecording'] },
  coding_sessions: { does: '接上 Claude Code 和 Codex，播报进度、弹审批卡', needs: '在终端里装一次 hooks', cost: '本机保存 48 小时' },
  daily_brief: { does: '根据前一天的观察写一份简报', needs: '屏幕感知', cost: '每天一次模型调用' },
  computer_use: { does: '在你允许的窗口里点和打字', needs: '辅助功能、屏幕录制', cost: '每一步发一张截图给模型', perms: ['accessibility', 'screenRecording'] },
  personal_agent: { does: '你交代的事放到后台做，按时间重复做', needs: '授权她能读的文件夹', cost: '每次运行按模型用量计' },
  external_access: { does: '让别的智能体通过 MCP 或命令行和她对话', needs: '无', cost: '对方每次调用用你的模型额度' },
  motion_generation: { does: '按你的描述生成新的动作', needs: '自己部署的动作服务（本机 GPU）', cost: '只用你自己的服务' },
  harness_bridge: { does: '改用本机的 Claude Code、Codex 或 ACP 智能体当内核', needs: '本机已经安装并登录对应工具', cost: '用那个工具自己的账号和额度' },
};

export interface BandProps {
  plugin: PluginId;
  /** The child rows' names, for the folded line while the capability is off. */
  fold?: string;
  children?: ReactNode;
}

/** A capability's parent switch band (TitleNode): name, ⓘ, 做 / 要 / 花, the permissions it needs (✕ when not granted) and the switch; its rows below while on, one folded line while off. */
export function Band({ plugin, fold, children }: BandProps) {
  const { perms, hl, goRow, native } = useSettings();
  const c = useControls();
  const id = pluginKey(plugin);
  const b = BAND[plugin];
  // Rows follow the effective plug-in state, the same one the rest of the app gates on.
  const on = usePlugins()[plugin];
  const need = perms.filter((p) => b.perms?.includes(p.kind));
  return (
    <>
      <div
        id={`set-${id}`}
        role="group"
        aria-labelledby={`set-${id}-title`}
        className={[styles.band, band.band, hl === id && styles.hl].filter(Boolean).join(' ')}
        data-row={id}
        data-nav-target={`set-${id}`}
      >
        <div>
          <h4 className={band.bt}>
            <span id={`set-${id}-title`}>{labelOf(id)}</span>
            <InfoTip>{`做什么：${b.does}。要什么：${b.needs}。花多少：${b.cost}。`}</InfoTip>
          </h4>
          <div className={band.bw} aria-hidden="true">
            <span>
              <b>做</b>
              {b.does}
            </span>
            <span>
              <b>要</b>
              {b.needs}
            </span>
            <span>
              <b>花</b>
              {b.cost}
            </span>
          </div>
        </div>
        <div className={band.bctl}>
          {need.map((p) =>
            p.state === 'granted' || p.state === 'loading' || p.state === 'unread' ? (
              <span key={p.kind} className={band.need}>
                {p.label}
              </span>
            ) : (
              <button key={p.kind} type="button" className={band.need} data-miss="" title={`${p.label}没开，去系统权限`} onClick={() => goRow(p.kind, 'perm')}>
                ✕ {p.label}
              </button>
            ),
          )}
          {c.toggle(id, labelOf(id), !native, '还没读到设置')}
        </div>
      </div>
      {on
        ? children
        : fold && (
            <div className={band.fold}>
              关着 │ 打开后可以设：{fold}
              <span className={band.lost}>│ 少了：{b.does}</span>
            </div>
          )}
    </>
  );
}
