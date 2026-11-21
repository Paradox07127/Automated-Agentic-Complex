import { describe, expect, it } from 'vitest';
import { composeHealth } from '../../src/domain/adapt';
import { voiceSource, voiceState, voiceText } from '../../src/domain/voiceState';
import type { WireDiagConnections, WireVoice } from '../../src/domain/wire';
import { WIRE_TTS } from '../../src/mock/fixtures';
import { diagView } from '../../src/pages/settings/diag';

type Tts = WireDiagConnections['tts'];

const tts = (state: WireVoice['state'], retry_after_s: number | null = null): Tts =>
  ({ configured: true, result: null, at: null, provider: 'remote-ws', state, reason: null, retry_after_s });

const connections = (t: Tts): WireDiagConnections => ({
  agentd: { started_at: '2026-10-31T00:00:00Z', epoch: null },
  tts: t,
  browser: { last_message_at: null },
  avatar: { speech_readers: 0, heartbeat_at: null },
});

const wire = (state: WireVoice['state'], retry_after_s: number | null = null): WireVoice => ({ provider: 'remote-ws', state, reason: null, retry_after_s });

describe('voiceState', () => {
  it.each(['unknown', 'probing', 'ready', 'cold', 'unreachable', 'off'] as const)('composeHealth and diagView read state %s', (state) => {
    expect(voiceState(tts(state)).state).toBe(state);
    expect(composeHealth('connected', null, null, { connections: connections(tts(state)) }).voice.state).toBe(state);
    expect(diagView({ connections: connections(tts(state)) }).voice?.state).toBe(state);
  });

  it('reads the POST /voice/reset reply', () => {
    expect(voiceState(wire('cold'))).toEqual({ state: 'cold', retryAfterS: null });
  });

  it('passes retry_after_s through as retryAfterS', () => {
    expect(voiceState(tts('unreachable', 42.5))).toEqual({ state: 'unreachable', retryAfterS: 42.5 });
    expect(composeHealth('connected', null, null, { connections: connections(tts('unreachable', 7)) }).voice.retryAfterS).toBe(7);
    expect(diagView({ connections: connections(tts('unreachable', 7)) }).voice?.retryAfterS).toBe(7);
  });

  it('has a fixture for every state', () => {
    expect(Object.fromEntries(Object.entries(WIRE_TTS).map(([k, t]) => [k, voiceState(t).state]))).toEqual({
      unknown: 'unknown',
      probing: 'probing',
      ready: 'ready',
      cold: 'cold',
      unreachable: 'unreachable',
      off: 'off',
    });
  });

  it('a missing tts block is off in health and not reported in settings', () => {
    expect(composeHealth('connected', null, null, null).voice.state).toBe('off');
    expect(diagView(null).voice).toBeNull();
    expect(diagView({}).voice).toBeNull();
  });

  it('notes a build without a voice only for provider none and not_configured', () => {
    expect(diagView({ connections: connections(WIRE_TTS.off) }).voiceNone).toBe(true);
    expect(diagView({ connections: connections({ ...WIRE_TTS.off, reason: 'start_failed' }) }).voiceNone).toBe(false);
    expect(diagView({ connections: connections(WIRE_TTS.ready) }).voiceNone).toBe(false);
  });
});

describe('voiceText', () => {
  it.each([
    ['unknown', '未检测'],
    ['probing', '检测中'],
    ['ready', '在线'],
    ['cold', '冷启动（第一句会慢）'],
    ['unreachable', '远端不通'],
    ['off', '已关闭'],
  ] as const)('%s -> %s', (state, text) => {
    expect(voiceText(state, null)).toBe(text);
  });

  it('adds the seconds until a retry to an unreachable voice, rounded up', () => {
    expect(voiceText('unreachable', 41.2)).toBe('远端不通 │ 42 秒后可重试');
    expect(voiceText('unreachable', 0)).toBe('远端不通');
    expect(voiceText('cold', 12)).toBe('冷启动（第一句会慢）');
  });
});

describe('voiceSource', () => {
  it.each([
    ['remote-ws', '外部服务'],
    ['none', null],
  ] as const)('%s -> %s', (provider, label) => {
    expect(voiceSource(provider)).toBe(label);
  });
});
