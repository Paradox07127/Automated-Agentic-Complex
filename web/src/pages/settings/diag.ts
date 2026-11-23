// `/diag/state` blocks → what the settings rows show. Each block is optional: an older agentd may lack one.
import { isoToMsOrNull } from '../../domain/units';
import { voiceState, type Voice } from '../../domain/voiceState';
import type { WireVoice } from '../../domain/wire';
import type { WireDiagSlice } from './wire';

export interface Hook {
  /** null: no settings file, or it could not be read. */
  installed: boolean | null;
  last_at: number | null;
}

export interface DiagView {
  screenshots: { used: number; reserved: number; released: number; limit: number } | null;
  redactions: Array<{ label: string; count: number }> | null;
  hooks: Record<'claude' | 'codex', Hook> | null;
  voice: Voice | null;
  /** The voice's provider and reason; null when agentd sends no provider. */
  voiceSource: Pick<WireVoice, 'provider' | 'reason'> | null;
  /** agentd was started without a TTS (provider none, reason not_configured). */
  voiceNone: boolean;
  /** A TTS token is saved; false when not reported. */
  voiceTokenSet: boolean;
  /** agentd's live mute (config.json, or a spoken「静音」since it started); null when not reported. */
  muted: boolean | null;
  /** When the running agentd started, epoch ms. */
  agentdStartedAt: number | null;
}

const hook = (h: { installed: boolean | null; last_at: string | null } | undefined): Hook => ({
  installed: h?.installed ?? null,
  last_at: typeof h?.last_at === 'string' ? isoToMsOrNull(h.last_at) : null,
});

export function diagView(d: WireDiagSlice | null): DiagView {
  const budget = d?.budget;
  const red = budget?.redactions;
  const tts = d?.connections?.tts;
  const voice = tts ? voiceState(tts) : null;
  return {
    screenshots: budget?.screenshots ?? null,
    redactions: red && typeof red.key === 'number' ? [
      { label: '密钥', count: red.key },
      { label: '邮箱', count: red.email },
      { label: '电话', count: red.phone },
    ] : null,
    hooks: d?.hooks && 'claude' in d.hooks ? { claude: hook(d.hooks.claude), codex: hook(d.hooks.codex) } : null,
    voice,
    voiceSource: tts?.provider ? { provider: tts.provider, reason: tts.reason ?? null } : null,
    voiceNone: tts?.provider === 'none' && tts.reason === 'not_configured',
    voiceTokenSet: tts?.token_set === true,
    muted: typeof d?.mouth_voice?.muted === 'boolean' ? d.mouth_voice.muted : null,
    agentdStartedAt: typeof d?.connections?.agentd?.started_at === 'string' ? isoToMsOrNull(d.connections.agentd.started_at) : null,
  };
}
