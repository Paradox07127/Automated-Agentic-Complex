import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getBridge, type BridgeError, type CharacterEntry, type DesktopState, type OnboardingOps, type OnboardingState } from '../../bridge';
import { failureText } from '../../domain/errorText';
import { useDemo } from '../../shell/demo';
import { toast } from '../../shell/toast';
import { hostReason } from '../character/labels';
import { demoOps, demoRoster } from './demo';

export type OpName = 'advance' | 'back' | 'goto' | 'skip' | 'complete';

const OP_TEXT: Record<string, string> = {
  busy: '上一步还在处理，请稍候再试',
  invalid_state: '这一步现在不能这样操作，请重新打开首次设置',
  offline: '没有连上桌面端，请重试',
};

export function opErrorText(e: unknown): string {
  const err = (e ?? {}) as Partial<BridgeError>;
  return OP_TEXT[err.code ?? ''] ?? failureText({ status: 0, code: err.code ?? null, detail: err.detail ?? null }).text;
}

/** Whether she is on the desktop: unread until the desktop reports, appearing while a switch loads her. */
export type Desk = 'unread' | 'appearing' | 'here' | 'hidden';

export interface Onboarding {
  s: OnboardingState | null;
  /** The roster; null until read or when the read fails. */
  characters: CharacterEntry[] | null;
  /** The active character of the roster. */
  current: CharacterEntry | null;
  readCharacters: () => void;
  /** `character.switchTo`; the roster marks her at once and the desk row says 正在出现… until the switch is done. */
  pick: (id: string) => void;
  importPackage: () => void;
  desk: Desk;
  /** The desktop's hot keys by settings id (`hk_quick`); empty until the desktop reports. */
  hotkeys: Record<string, string>;
  loadError: string | null;
  /** The op in flight; others wait for it. */
  busy: OpName | null;
  opError: string | null;
  run: (name: OpName, call: (ops: OnboardingOps) => Promise<OnboardingState>) => Promise<OnboardingState | null>;
  reload: () => void;
}

/** The guide's state over the bridge's `onboarding` ops, the roster and what the desktop shows. */
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
  const [state, setState] = useState<DesktopState | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
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
        (list) => live && setCharacters(window.agenticComplex ? list : demoRoster(flags.demo, list)),
        () => {},
      );
    return () => {
      live = false;
    };
  }, [reads, flags.demo]);
  const readCharacters = useCallback(() => setReads((n) => n + 1), []);

  useEffect(() => getBridge().desktop.onState(setState), []);

  const pick = useCallback(
    (id: string) => {
      if (switching) return;
      setSwitching(id);
      setCharacters((list) => list?.map((c) => ({ ...c, active: c.id === id })) ?? list);
      getBridge()
        .character.switchTo(id)
        .then(
          (r) => {
            if (!r.ok) toast(`没能换成她：${hostReason(r.reason)}`, { severity: 'danger', persistent: true });
          },
          () => toast('没能换角色：桌面角色没有回应', { severity: 'danger' }),
        )
        .finally(() => {
          setSwitching(null);
          readCharacters();
        });
    },
    [switching, readCharacters],
  );

  const importPackage = useCallback(
    () =>
      void getBridge()
        .character.importPackage()
        .then(
          (r) => {
            if (r.ok) {
              toast('已导入角色');
              readCharacters();
            } else if (r.reason === 'cancelled') toast('已取消导入');
            else toast(`导入没有完成：${hostReason(r.reason)}`, { severity: 'danger', persistent: true });
          },
          (e: unknown) =>
            toast(`导入没有完成：${(e as { code?: string } | null)?.code === 'not_implemented' ? '这个版本还不支持' : '桌面角色没有回应'}`, { severity: 'danger' }),
        ),
    [readCharacters],
  );

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

  const current = characters?.find((c) => c.active) ?? null;
  const desk: Desk = switching ? 'appearing' : state === null ? 'unread' : state.hidden ? 'hidden' : 'here';
  return { s, characters, current, readCharacters, pick, importPackage, desk, hotkeys: state?.hotkeys ?? {}, loadError, busy, opError, run, reload };
}
