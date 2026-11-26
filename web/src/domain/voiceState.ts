// `/diag/state` connections.tts → the voice state every surface shows.
import type { Health } from './system';
import type { WireVoice } from './wire';

export type Voice = Health['voice'];
export type VoiceState = Voice['state'];

export function voiceState(tts: WireVoice): Voice {
  return { state: tts.state, retryAfterS: tts.retry_after_s, reason: tts.reason };
}

const TEXT: Record<VoiceState, string> = {
  unknown: '未检测',
  probing: '检测中',
  ready: '就绪',
  cold: '冷启动（第一句会慢）',
  unreachable: '无法连接',
  off: '未配置',
};

/** tts last result codes (server.py `_tts_last`) and why agentd runs text only (voice_provider.py NoVoice, main.py). */
const TTS_RESULT: Readonly<Record<string, string>> = {
  connection_lost: '连接断开',
  unreachable: '无法连接',
  tts_unavailable: '服务不可用',
  timeout: '响应超时',
  bad_stream: '音频流损坏',
  empty_stream: '未返回音频',
  http_401: '令牌无效',
  http_503: '服务暂不可用或模型未就绪',
  start_failed: '语音模块启动出错',
  secret_store_unavailable: '系统凭据存储无法访问',
};
/** speech.py also reports `http_<status>` when the TTS answers with an error; the startup probe's reason is `probe:<code>`. */
export const ttsText = (code: string): string => {
  const c = code.startsWith('probe:') ? code.slice(6) : code;
  return TTS_RESULT[c] ?? (/^http_\d+$/.test(c) ? `服务返回错误 ${c.slice(5)}` : '其他原因');
};

const SOURCE: Partial<Record<WireVoice['provider'], string>> = { 'remote-ws': '外部服务' };

/** The label of agentd's voice `provider`; null for none. */
export function voiceSource(provider: WireVoice['provider']): string | null {
  return SOURCE[provider] ?? null;
}

/** The state's label with agentd's reason: an off voice that was configured failed to start, an unreachable one says what
 *  failed and the whole seconds left until a retry. */
export function voiceText(state: VoiceState, retryLeft: number | null, reason?: string | null): string {
  if (state === 'off') return reason && reason !== 'not_configured' ? `启动失败：${ttsText(reason)}` : TEXT.off;
  if (state !== 'unreachable') return TEXT[state];
  const text = reason ? `${TEXT.unreachable}：${ttsText(reason)}` : TEXT.unreachable;
  return retryLeft != null && retryLeft > 0 ? `${text} │ ${Math.ceil(retryLeft)} 秒后可重试` : text;
}

const SHORT: Record<VoiceState, string> = { unknown: '检测中', probing: '检测中', ready: '就绪', cold: '待唤醒', unreachable: '无法连接', off: '未配置' };

/** The state in a word or two for a one-line status cell; an off voice that was configured is 启动失败. */
export function voiceShort(state: VoiceState, reason?: string | null): string {
  return state === 'off' && reason && reason !== 'not_configured' ? '启动失败' : SHORT[state];
}
