// `/diag/state` connections.tts → the voice state every surface shows.
import type { Health } from './system';
import type { WireVoice } from './wire';

export type Voice = Health['voice'];
export type VoiceState = Voice['state'];

export function voiceState(tts: WireVoice): Voice {
  return { state: tts.state, retryAfterS: tts.retry_after_s };
}

const TEXT: Record<VoiceState, string> = {
  unknown: '未检测',
  probing: '检测中',
  ready: '在线',
  cold: '冷启动（第一句会慢）',
  unreachable: '远端不通',
  off: '已关闭',
};

const SOURCE: Partial<Record<WireVoice['provider'], string>> = { 'remote-ws': '外部服务' };

/** The label of agentd's voice `provider`; null for none. */
export function voiceSource(provider: WireVoice['provider']): string | null {
  return SOURCE[provider] ?? null;
}

/** The state's label; an unreachable voice adds the whole seconds left until a retry. */
export function voiceText(state: VoiceState, retryLeft: number | null): string {
  const text = TEXT[state];
  return state === 'unreachable' && retryLeft != null && retryLeft > 0 ? `${text} │ ${Math.ceil(retryLeft)} 秒后可重试` : text;
}
