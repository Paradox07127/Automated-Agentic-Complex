import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getBridge, type BridgeError, type CharacterEntry, type OnboardingOps, type OnboardingState } from '../../bridge';
import { failureText } from '../../domain/errorText';
import { useDemo } from '../../shell/demo';
import { demoOps } from './demo';

export type OpName = 'advance' | 'back' | 'complete';

const OP_TEXT: Record<string, string> = {
  busy: '上一步还在处理，请稍候再试',
  invalid_state: '这一步现在不能这样操作，请重新打开首次设置',
  offline: '没有连上桌面端，请重试',
};

export function opErrorText(e: unknown): string {
  const err = (e ?? {}) as Partial<BridgeError>;
  return OP_TEXT[err.code ?? ''] ?? failureText({ status: 0, code: err.code ?? null, detail: err.detail ?? null }).text;
}

export interface Onboarding {
  s: OnboardingState | null;
  /** The roster; null until read or when the read fails. */
  characters: CharacterEntry[] | null;
  /** The active character of the roster; the guide's state names it but carries no id. */
  characterId: string | null;
  readCharacters: () => void;
  loadError: string | null;
  /** The op in flight; others wait for it. */
  busy: OpName | null;
  opError: string | null;
  run: (name: OpName, call: (ops: OnboardingOps) => Promise<OnboardingState>) => Promise<OnboardingState | null>;
  reload: () => void;
}

/** The guide's state over the bridge's `onboarding` ops. */
export function useOnboarding(): Onboarding {
  const flags = useDemo();
  const ops = useMemo(() => {
    const base = getBridge().onboarding;
    return window.agenticComplex ? base : demoOps(base, flags.demo, flags.state);
  }, [flags.demo, flags.state]);
  const [s, setS] = useState<OnboardingState | null>(null);
  const [characters, setCharacters] = useState<CharacterEntry[] | null>(null);
  const [reads, setReads] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<OpName | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const busyRef = useRef(false);

  const reload = useCallback(() => {
    setLoadError(null);
    ops.state().then(setS, (e: unknown) => setLoadError(opErrorText(e)));
  }, [ops]);

  useEffect(reload, [reload]);

  useEffect(() => {
    let live = true;
    getBridge()
      .character.list()
      .then(
        (list) => live && setCharacters(list),
        () => {},
      );
    return () => {
      live = false;
    };
  }, [reads]);
  const readCharacters = useCallback(() => setReads((n) => n + 1), []);

  const run = useCallback<Onboarding['run']>(
    async (name, call) => {
      if (busyRef.current) return null;
      busyRef.current = true;
      setBusy(name);
      setOpError(null);
      try {
        const next = await call(ops);
        setS(next);
        return next;
      } catch (e) {
        setOpError(opErrorText(e));
        return null;
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    [ops],
  );

  const characterId = characters?.find((c) => c.active)?.id ?? null;
  return { s, characters, characterId, readCharacters, loadError, busy, opError, run, reload };
}
