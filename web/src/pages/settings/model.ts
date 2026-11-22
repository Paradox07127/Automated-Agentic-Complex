import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { getBridge, type PickedHandle, type SettingValue } from '../../bridge';
import type { Severity } from '../../domain';
import type { WireRuntimePublic } from '../../domain/wire';
import { clock, failure, saveModels, saveRuntime } from './api';
import { modelsBody, modelVals, runtimeBody, runtimeVals, targetOf, type Handles, type Target, type Vals } from './fields';
import type { Native } from './native';
import { DELETE_WHAT, DRAFT_SECTION, labelOf } from './registry';
import type { WireModelSettings } from './wire';

export type { Vals };

/** One confirm dialog; danger ones open with focus on cancel. */
export interface ConfirmSpec {
  title: string;
  note?: ReactNode;
  warning?: string;
  /** What goes, one item per line, between the warning and the note. */
  list?: string[];
  danger?: boolean;
  confirmLabel: string;
  cancelLabel?: string;
  confirmWord?: string;
  onConfirm: () => void | Promise<void>;
}

export interface ToastSpec {
  message: string;
  severity?: Severity;
  action?: { label: string; onClick: () => void };
  persistent?: boolean;
}

export interface ModelInit {
  vals?: Vals;
  pending?: string[];
  draft?: Vals;
  confirm?: ConfirmSpec | null;
}

/** What the model writes against: the native schema and the last agentd reads; `merge` folds a write's reply into the read. */
export interface Sources {
  native?: Native | null;
  runtime?: WireRuntimePublic | null;
  models?: WireModelSettings | null;
  merge?: (target: Target, reply: unknown) => void;
  reload?: (target: Target) => void;
  /** When the running agentd started (epoch ms): changes saved before it already apply. */
  agentdStartedAt?: number | null;
}

/** The one danger-confirm wording for switching off a schema row marked destructive; `count` is undefined while counting, null when unknown. */
export function deleteConfirm(id: string, onConfirm: ConfirmSpec['onConfirm'], count?: number | null): ConfirmSpec {
  const what = DELETE_WHAT[id] ?? '内容';
  const gone = count === undefined ? `正在统计将删除的${what}…` : count === null ? `将删除已收集的${what}，条数未知。` : `将删除 ${count} 条已收集的${what}。`;
  return {
    title: `关闭「${labelOf(id)}」并删除已收集的内容？`,
    danger: true,
    warning: '删除后不能恢复',
    note: `${gone}停止采集要重启后台服务后才生效。`,
    confirmLabel: '关闭并删除',
    onConfirm,
  };
}

const NO_READ: Record<Target, string> = { runtime: '还没读到角色内核设置', models: '还没读到模型设置' };

/** Rows saved but waiting for a backend restart, with when each was saved; kept across pages and reloads. */
const PENDING_KEY = 'ef.settings.pendingRestart';

function loadPending(): Record<string, number> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(PENDING_KEY) ?? '{}');
    return v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter((e): e is [string, number] => typeof e[1] === 'number')) : {};
  } catch {
    return {};
  }
}

export function useSettingsModel(init: ModelInit = {}, src: Sources = {}) {
  const bridge = getBridge();
  const [vals, setVals] = useState<Vals>(() => ({ ...init.vals }));
  const [draft, setDraft] = useState<Vals>(() => ({ ...init.draft }));
  // A demo's own pending rows are not stored.
  const stored = useRef(init.pending === undefined);
  const [pending, setPending] = useState<Record<string, number>>(() => (init.pending ? Object.fromEntries(init.pending.map((id) => [id, clock()])) : loadPending()));
  const [ok, setOk] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(init.confirm ?? null);
  const [toast, setToast] = useState<ToastSpec | null>(null);
  const [restarting, setRestarting] = useState(false);
  /** How many saves deleted the stored TTS token (`ttsTokenCleared`). */
  const [ttsTokenClears, setTtsTokenClears] = useState(0);
  const timers = useRef<number[]>([]);
  const handles = useRef<Handles>({});
  const s = useRef(src);
  s.current = src;

  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  useEffect(() => void (src.native && setVals((v) => ({ ...v, ...src.native?.saved }))), [src.native]);
  useEffect(() => void (src.runtime && setVals((v) => ({ ...v, ...runtimeVals(src.runtime as WireRuntimePublic) }))), [src.runtime]);
  useEffect(() => void (src.models && setVals((v) => ({ ...v, ...modelVals(src.models as WireModelSettings) }))), [src.models]);
  useEffect(() => {
    const started = src.agentdStartedAt;
    if (started == null) return;
    setPending((p) => (Object.values(p).some((at) => at < started) ? Object.fromEntries(Object.entries(p).filter(([, at]) => at >= started)) : p));
  }, [src.agentdStartedAt]);
  useEffect(() => {
    if (!stored.current) return;
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    } catch {
      // Storage off: the notice lasts while the page is open.
    }
  }, [pending]);

  const value = useCallback((id: string): SettingValue | undefined => (id in draft ? draft[id] : vals[id]), [draft, vals]);

  const flash = useCallback((id: string) => {
    setOk(id);
    timers.current.push(window.setTimeout(() => setOk((o) => (o === id ? null : o)), 1200));
  }, []);

  /** config.json through the shell. Only a row whose own schema says `restart: backend` waits for a backend restart. */
  const saveNative = useCallback(
    async (changes: Vals, what: string): Promise<boolean> => {
      let res;
      try {
        res = await bridge.settings.save(changes);
      } catch {
        setToast({ message: `没有保存「${what}」：原生设置服务没有响应`, severity: 'danger', persistent: true });
        return false;
      }
      if (res.error) {
        // The shell's text may carry an option key or a system message: logged, not shown.
        console.warn('settings.save refused', res.error);
        setToast({ message: `没有保存「${what}」：桌面端没有接受这次修改`, severity: 'danger', persistent: true });
        return false;
      }
      setVals((v) => ({ ...v, ...changes }));
      if (res.ttsTokenCleared) setTtsTokenClears((n) => n + 1);
      const rows = s.current.native?.rows ?? {};
      const restart = Object.keys(changes).filter((id) => rows[id]?.restart === 'backend');
      if (restart.length) setPending((p) => ({ ...p, ...Object.fromEntries(restart.map((id) => [id, clock()])) }));
      if (res.notApplied.length) setToast({ message: `已保存，${res.notApplied.map(labelOf).join('、')}要重启 Agentic Complex 后生效`, severity: 'warning', persistent: true });
      return true;
    },
    [bridge],
  );

  /** agentd: one request per target, the reply folded back into the read. */
  const saveAgentd = useCallback(async (changes: Vals, what: string): Promise<boolean> => {
    const by: Partial<Record<Target, Vals>> = {};
    for (const [id, v] of Object.entries(changes)) {
      const t = targetOf(id);
      if (t) by[t] = { ...by[t], [id]: v };
    }
    const cur = s.current;
    try {
      if (by.runtime) {
        if (!cur.runtime) throw new Error(NO_READ.runtime);
        const reply = await saveRuntime(runtimeBody(cur.runtime, by.runtime, handles.current));
        cur.merge?.('runtime', reply);
      }
      if (by.models) {
        if (!cur.models) throw new Error(NO_READ.models);
        const reply = await saveModels(modelsBody(cur.models, by.models));
        cur.merge?.('models', reply);
      }
    } catch (e) {
      const f = e instanceof Error && Object.values(NO_READ).includes(e.message) ? { text: e.message, conflict: false } : failure(e);
      if (f.conflict) (Object.keys(by) as Target[]).forEach((t) => cur.reload?.(t));
      setToast({ message: `没有保存「${what}」：${f.text}`, severity: 'danger', persistent: true });
      return false;
    }
    setVals((v) => ({ ...v, ...changes }));
    return true;
  }, []);

  const save = useCallback(
    (changes: Vals, what: string) => (Object.keys(changes).every((id) => targetOf(id)) ? saveAgentd(changes, what) : saveNative(changes, what)),
    [saveAgentd, saveNative],
  );

  const write = useCallback(
    async (id: string, v: SettingValue, old: SettingValue | undefined) => {
      if (!(await save({ [id]: v }, labelOf(id)))) return;
      flash(id);
      setToast({ message: `已更改「${labelOf(id)}」`, action: { label: '撤销', onClick: () => void save({ [id]: old ?? null }, labelOf(id)) } });
    },
    [save, flash],
  );

  /** Writes one setting: drafts stay local, a destructive switch going off asks first. */
  const set = useCallback(
    (id: string, v: SettingValue) => {
      if (DRAFT_SECTION[id]) {
        setDraft((d) => {
          const next = { ...d };
          if (v === vals[id]) delete next[id];
          else next[id] = v;
          return next;
        });
        return;
      }
      const old = vals[id];
      // Picking the option already chosen still fires onChange.
      if (v === old) return;
      if (s.current.native?.rows[id]?.destructive && old === true && v === false) {
        const onConfirm = async () => {
          if (await bridge.settings.confirmDestructive(id)) await write(id, v, old);
        };
        const asking = deleteConfirm(id, onConfirm);
        setConfirm(asking);
        // The count fills in when it arrives; a failed preview never blocks the switch.
        void bridge.settings.previewDestructive(id).then(
          (p) => p.total,
          () => null,
        ).then((count) => setConfirm((c) => (c === asking ? deleteConfirm(id, onConfirm, count) : c)));
        return;
      }
      void write(id, v, old);
    },
    [bridge, vals, write],
  );

  /** A picked file for a draft row: the handle goes into the request, its name onto the screen. */
  const setHandle = useCallback(
    (id: string, h: PickedHandle) => {
      handles.current[id] = h;
      set(id, h.displayName);
    },
    [set],
  );

  /** Saves every draft at once (the bottom「未应用 N 项」bar); a failed target keeps its drafts. */
  const applyAll = useCallback(async () => {
    const n = Object.keys(draft).length;
    if (n === 0) return;
    if (!(await saveAgentd({ ...draft }, `${n} 项改动`))) return;
    handles.current = {};
    setDraft({});
    setToast({ message: `已应用 ${n} 项`, severity: 'success' });
  }, [saveAgentd, draft]);

  const revertAll = useCallback(() => {
    handles.current = {};
    setDraft({});
  }, []);

  const restartBackend = useCallback(async () => {
    setRestarting(true);
    try {
      await bridge.supervisor.restart('agentd');
    } catch {
      setToast({ message: '没能重启后台服务：桌面端没有响应', severity: 'danger', persistent: true });
      return;
    } finally {
      setRestarting(false);
    }
    setPending({});
    setToast({ message: '后台服务正在重启，完成后改动生效', severity: 'success' });
  }, [bridge]);

  /** 恢复默认: the schema defaults of these rows, consent logged for each destructive one that goes off. */
  const resetTo = useCallback(
    async (defaults: Vals): Promise<boolean> => {
      const changes = Object.fromEntries(Object.entries(defaults).filter(([id, v]) => vals[id] !== v));
      for (const id of Object.keys(changes)) {
        if (s.current.native?.rows[id]?.destructive && vals[id] === true && !(await bridge.settings.confirmDestructive(id))) return false;
      }
      return Object.keys(changes).length === 0 || saveNative(changes, '默认设置');
    },
    [bridge, vals, saveNative],
  );

  return {
    vals,
    draft,
    pending,
    ok,
    confirm,
    toast,
    restarting,
    ttsTokenClears,
    value,
    set,
    setHandle,
    save,
    applyAll,
    revertAll,
    restartBackend,
    resetTo,
    setVals,
    setDraft,
    ask: setConfirm,
    notify: setToast,
  };
}

export type SettingsModel = ReturnType<typeof useSettingsModel>;
