// avatar.details as text: the render card's summary lines and the folded key-value list.
import type { AvatarDetails } from '../../bridge/protocol';

const SUSPENDED: Readonly<Record<string, string>> = {
  system_sleep: '系统睡眠',
  screen_sleep: '屏幕睡眠',
  session_inactive: '会话不活跃',
  switching: '切换角色',
};

/** 画面暂停中 with its reason when the host gave a known one. */
export const suspendedText = (code: string): string => (SUSPENDED[code] ? `画面暂停中 │ ${SUSPENDED[code]}` : '画面暂停中');

const UNSUPPORTED: Readonly<Record<string, string>> = { ssaa: 'SSAA 关', display_resolution: '按显示器分辨率' };

const rendererName = (r: string | null): string => (r == null ? '未知' : r === 'metal' ? 'Metal' : r);

/** Up to three lines: renderer and build, character and quality, frame rate and video memory. */
export function detailSummary(d: AvatarDetails): string[] {
  const lines = [`渲染器 ${rendererName(d.renderer)} │ 构建 ${d.build ? d.build.slice(0, 8) : '—'}`];
  const p = d.pipeline;
  if (!p) return lines;
  lines.push(`${p.character} │ ${p.appearance} │ SSAA ${p.ssaa}× │ 阴影 ${p.shadowResolution} │ 描边 ${p.outline}`);
  const fps = p.suspended != null ? suspendedText(p.suspended) : p.fpsRequested === 0 ? '画面暂停中' : `目标 ${p.fpsTarget} / 请求 ${p.fpsRequested} fps`;
  lines.push(`${fps} │ 显存 ${Math.round(p.gpuAllocatedMB)} MB`);
  return lines;
}

/** Every reported value, one `名称  值` line each; long ones (build, errors) live only here. */
export function detailRaw(d: AvatarDetails): string {
  const rows: Array<[string, string]> = [
    ['渲染器', rendererName(d.renderer)],
    ['构建', d.build ?? '—'],
  ];
  const p = d.pipeline;
  if (p) {
    rows.push(['角色', `${p.character} │ ${p.appearance}${p.fallbackRequested ? `（${p.fallbackRequested} 不可用）` : ''}`]);
    rows.push(['画质', `SSAA ${p.ssaa}× │ 阴影 ${p.shadowResolution} │ 描边 ${p.outline}${p.displayResolution ? ' │ 显示器分辨率' : ''}`]);
    if (p.unsupported.length) rows.push(['未生效设置', p.unsupported.map((k) => UNSUPPORTED[k] ?? k).join('、')]);
    rows.push(['帧率', p.suspended != null ? suspendedText(p.suspended) : `目标 ${p.fpsTarget} / 请求 ${p.fpsRequested}`]);
    rows.push(['显存', `${Math.round(p.gpuAllocatedMB)} MB`]);
    rows.push(['已提交帧', String(p.framesSubmitted)]);
    rows.push(['动作', p.clip ?? '—']);
    if (p.error) rows.push(['上次错误', p.error]);
  }
  const at = d.placement;
  rows.push(['位置', at ? `${Math.round(at.x)}, ${Math.round(at.y)}` : '—']);
  rows.push(['大小', at ? `${at.scale.toFixed(2)}×` : '—']);
  return rows.map(([k, v]) => `${k.padEnd(6, '　')}${v}`).join('\n');
}

/** Whether the host reported anything worth a card. */
export const hasDetails = (d: AvatarDetails | null | undefined): d is AvatarDetails => d != null && (d.renderer != null || d.pipeline != null);
