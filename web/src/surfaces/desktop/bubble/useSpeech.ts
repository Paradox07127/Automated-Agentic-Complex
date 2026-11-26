import { useEffect, useState, type Dispatch } from 'react';
import type { DesktopState } from '../../../bridge';
import type { Bar, CommAction } from '../comm/commReducer';
import { useComm } from '../comm/useComm';

/** A voiced line stays this long after her voice ended. */
export const AFTER_VOICE_MS = 1000;
/** A voiced line without an ended this long after it finished, or after her voice last started, goes by its words alone. */
export const VOICE_MAX_MS = 60_000;

type Playback = NonNullable<DesktopState['playback']>;

/** The reducer's own linger clock is held so the line stays until the user closes it or a new line replaces it. */
function useHold(bar: Bar | null, paused: boolean, dispatch: Dispatch<CommAction>) {
  const id = bar?.id ?? null;
  const held = bar?.phase === 'linger' || paused;
  useEffect(() => {
    if (id) dispatch({ type: 'hold', id, held });
  }, [id, held, dispatch]);
}

/**
 * Her voice for a main line agentd voices while `voiceOn`: `preparing` while it has text and no clause of it started;
 * `heldForVoice` while it is finished and her voice has neither stopped nor ended `AFTER_VOICE_MS` ago, for `VOICE_MAX_MS` at most.
 */
function useVoice(bar: Bar | null, playback: Playback, voiceOn: boolean) {
  const utterance = bar?.utterance ?? null;
  const voiced = bar?.kind === 'main' && bar.speak === true && voiceOn && (bar.phase === 'streaming' || (bar.phase === 'linger' && utterance != null));
  const heard = utterance != null ? playback[utterance] : undefined;
  const token = voiced && bar.phase === 'linger' && heard !== 'stopped' ? `${bar.id}|${heard ?? ''}` : null;
  const [released, setReleased] = useState<string | null>(null);
  useEffect(() => {
    if (token == null) return;
    const t = setTimeout(() => setReleased(token), token.endsWith('|ended') ? AFTER_VOICE_MS : VOICE_MAX_MS);
    return () => clearTimeout(t);
  }, [token]);
  return { preparing: voiced && bar.text.trim() !== '' && heard === undefined, heldForVoice: token != null && released !== token };
}

/**
 * Her line for the bubble, from `/feed` `line` events through the comm reducer, and a side session's answer under it.
 * A finished line stays held in the reducer so the collapsed icon can reopen it; other phases keep their clocks unless `paused`.
 * `playback` and `voiceOn` give her voice for the main line (`useVoice`).
 */
export function useSpeech(demo: Parameters<typeof useComm>[0], still: boolean, paused: boolean, playback: Playback, voiceOn: boolean) {
  const [comm, dispatch] = useComm(demo, still);
  const bar = comm.bars.find((b) => b.kind === 'main') ?? comm.bars[0] ?? null;
  const side = comm.bars.find((b) => b !== bar && b.kind === 'side') ?? null;
  useHold(bar, paused, dispatch);
  useHold(side, paused, dispatch);
  const voice = useVoice(bar, playback, voiceOn);
  return { bar, side, dispatch, ...voice };
}
