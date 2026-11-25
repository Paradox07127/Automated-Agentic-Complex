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

/** What each capability does, needs and costs (the 做 / 要 / 花 line, hidden in a narrow window); `tip`, the ⓘ, says what switching it changes, what leaves the computer and that it waits for a restart. */
export const BAND: Record<PluginId, { does: string; needs: string; cost: string; tip: string; perms?: PermissionKind[] }> = {
  light_ai: { does: '日常对话、长期记忆与主动交互', needs: '已配置模型账号', cost: '按模型实际用量计费',
    tip: '日常对话、语音播报、记忆与主动交互均依赖此开关（不限所选执行内核）。对话内容将发送至当前所选内核与模型；关闭后角色无法对话。修改后需重启后台服务生效。' },
  screen_awareness: { does: '持续识别前台窗口与活动状态，用于主动交互及简报生成', needs: '辅助功能、屏幕录制', cost: '少量本机 CPU 资源；仅上传下方已启用的数据项', perms: ['accessibility', 'screenRecording'],
    tip: '开启后将在本机持续读取前台窗口与活动摘要，仅下方开启的项会发送至模型。关闭后将减少主动交互触发时机，且每日简报无活动素材可用。修改后需重启后台服务生效。' },
  screen_reading: { does: '按快捷键触发单次屏幕、选中文本或剪贴板识读', needs: '屏幕录制', cost: '开启附图时每次消耗 1 张截图配额', perms: ['screenRecording'],
    tip: '仅在主动触发识读快捷键时读取屏幕画面、选中文本或剪贴板内容，日常不持续采集。若开启「屏幕识读时附带截图」将受每日张数配额限制。修改后需重启后台服务生效。' },
  coding_sessions: { does: '接入 Claude Code 与 Codex，同步进度并弹出审批卡', needs: '在终端完成一次 hooks 安装', cost: '本机保留最近 48 小时记录',
    tip: '通过终端 hooks 接入 Claude Code 与 Codex 会话以同步运行进度并托管审批弹窗。会话详情在本机保留 48 小时；关闭「读取编码会话」时将清除已存内容。修改后需重启后台服务生效。' },
  daily_brief: { does: '依据前一日观察摘要自动生成日报与周报', needs: '屏幕感知', cost: '每次生成调用 1 次模型',
    tip: '每日/每周到达设定时间后，汇总屏幕感知记录并在「每日简报」页生成总结。未开启屏幕感知时无法生成内容。修改后需重启后台服务生效。' },
  computer_use: { does: '在单次授权窗口内执行点击与输入操作', needs: '辅助功能、屏幕录制', cost: '每步向模型发送窗口截图', perms: ['accessibility', 'screenRecording'],
    tip: '允许角色在明确授权的窗口中执行点击与文本输入操作。因每步均需提交截图，模型 token 消耗高于普通对话。修改后需重启后台服务生效。' },
  personal_agent: { does: '在后台执行派发任务与定时任务', needs: '至少授权一个可访问文件夹', cost: '按每次任务执行用量计费',
    tip: '将复杂任务交给后台执行或配置周期性定时任务。角色仅能读取下方授权目录中的文件，执行消耗按模型实际用量计费。修改后需重启后台服务生效。' },
  external_access: { does: '允许外部智能体通过 MCP 或命令行与角色通信', needs: '无额外系统权限', cost: '外部调用计入当前模型用量',
    tip: '允许本机其他智能体通过 MCP 或 CLI 接入并与角色交互，每次外部调用均使用当前已配置的模型额度。修改后需重启后台服务生效。' },
  motion_generation: { does: '根据文本描述生成新角色动作', needs: '已配置自建 Kimodo 动作服务', cost: '仅调用自建动作服务',
    tip: '根据文本描述生成角色动画，调用已配置的自建 Kimodo 动作生成服务（通常部署于配备 GPU 的环境）。服务地址与令牌可在「设置 › 服务」中配置。修改后需重启后台服务生效。' },
  harness_bridge: { does: '切换使用本地安装的 Claude Code、Codex 或 ACP 智能体作为执行内核', needs: '本地已安装并登录对应 CLI 工具', cost: '使用对应工具自身的账号与额度',
    tip: '开启后可将执行内核切换为本机 Codex、Claude Code 或 ACP 智能体；关闭时仅使用内置 Pi 内核。修改后需重启后台服务生效。' },
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
            <InfoTip>{b.tip}</InfoTip>
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
