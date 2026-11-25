import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getBridge, type PermissionKind, type SettingValue } from '../../bridge';
import { useDemo } from '../../shell/demo';
import { pluginKey, setPlugins } from '../../shell/plugins';
import { toast } from '../../shell/toast';
import { failure, readDiag, readModels, testModels } from '../settings/api';
import type { SettingsCtxValue } from '../settings/ctx';
import { diagView } from '../settings/diag';
import { SVC, targetOf, type Target } from '../settings/fields';
import { useSettingsModel } from '../settings/model';
import type { Native } from '../settings/native';
import { usePerms } from '../settings/perms';
import { labelOf } from '../settings/registry';
import type { WireDiagSlice, WireModelSettings } from '../settings/wire';
import { demoAgentdOff, demoModels, demoPerms, demoSaved } from './demo';

/** 测试连接 of the account: idle until run, then testing, ok or bad with its line. */
export interface ModelTest {
  state: 'idle' | 'testing' | 'ok' | 'bad';
  text: string;
}

export interface GuideSettings {
  ctx: SettingsCtxValue;
  /** The backend restarts after 和她对话 went on; the account rows wait for it. */
  restarting: boolean;
  /** `/diag/state` did not answer. */
  agentdOff: boolean;
  talks: boolean;
  /** The account the service on screen uses is there (a ChatGPT sign-in, or a saved key). */
  connected: boolean;
  test: ModelTest;
  runTest: () => void;
  /** The service's name for the result board. */
  service: string | null;
  retryAgentd: () => void;
}

/** The kinds the guide asks for (按住说话), and what a grant unlocks. */
export const GUIDE_PERMS: readonly PermissionKind[] = ['microphone', 'inputMonitoring'];

const RESTART_POLL_MS = 1000;
const RESTART_LIMIT_MS = 60_000;
const PENDING_POLL_MS = 2000;

/** The rows of the guide over the same values the settings page writes: config.json through the shell, the account through agentd. */
export function useGuideSettings(): GuideSettings {
  const bridge = getBridge();
  const { demo } = useDemo();
  const preview = !window.agenticComplex;
  const [native, setNative] = useState<Native | null>(null);
  const [models, setModels] = useState<WireModelSettings | null>(null);
  const [diag, setDiag] = useState<WireDiagSlice | null>(null);
  const [agentdOff, setAgentdOff] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [test, setTest] = useState<ModelTest>({ state: 'idle', text: '' });

  const loadModels = useCallback(
    () =>
      (preview && demoAgentdOff(demo) ? Promise.reject(new Error('demo')) : readModels()).then(
        (m) => setModels(preview ? demoModels(demo, m) : m),
        () => {},
      ),
    [preview, demo],
  );
  const loadDiag = useCallback(
    () =>
      (preview && demoAgentdOff(demo) ? Promise.reject(new Error('demo')) : readDiag()).then(
        (d) => {
          setDiag(d);
          setAgentdOff(false);
          return d;
        },
        () => {
          setAgentdOff(true);
          return null;
        },
      ),
    [preview, demo],
  );

  useEffect(() => {
    let live = true;
    bridge.settings.read().then(
      (snap) => {
        if (!live) return;
        const saved = preview ? demoSaved(demo, snap.saved) : snap.saved;
        setPlugins(saved);
        setNative({ rows: {}, saved, statuses: snap.statuses });
      },
      () => {},
    );
    void loadModels();
    void loadDiag();
    return () => {
      live = false;
    };
  }, [bridge, preview, demo, loadModels, loadDiag]);

  const permBridge = useMemo(
    () => (preview ? { ...bridge, permissions: { ...bridge.permissions, status: () => bridge.permissions.status().then((s) => demoPerms(demo, s)) } } : bridge),
    [bridge, preview, demo],
  );
  const { perms, recheckPerms } = usePerms(permBridge);

  const merge = useCallback((target: Target, reply: unknown) => target === 'models' && setModels(reply as WireModelSettings), []);
  const reloadTarget = useCallback((target: Target) => void (target === 'models' && loadModels()), [loadModels]);
  const view = useMemo(() => diagView(diag), [diag]);
  const model = useSettingsModel({ pending: [] }, { native, models, merge, reload: reloadTarget, agentdStartedAt: view.agentdStartedAt });

  // The shell restarts the backend itself after a guide save that needs it; poll until a new one answers.
  const waitBackend = useCallback(
    (before: number | null) => {
      setRestarting(true);
      const until = Date.now() + RESTART_LIMIT_MS;
      const poll = () =>
        void readDiag().then(
          (d) => {
            const started = diagView(d).agentdStartedAt;
            if (started != null && started !== before) {
              setDiag(d);
              setAgentdOff(false);
              setRestarting(false);
              void loadModels();
            } else again();
          },
          () => again(),
        );
      const again = () => {
        if (Date.now() < until) window.setTimeout(poll, RESTART_POLL_MS);
        else {
          setRestarting(false);
          void loadDiag();
          toast('后台服务尚未重启完成，账号配置暂为只读，可稍后点击「重新连接」', { severity: 'warning', persistent: true });
        }
      };
      window.setTimeout(poll, RESTART_POLL_MS);
    },
    [loadModels, loadDiag],
  );

  const { setVals, notify, save } = model;
  const startedAt = useRef(view.agentdStartedAt);
  startedAt.current = view.agentdStartedAt;
  // Every guide row saves at once: config.json rows through the shell (which allows only the guide's five), the account through agentd.
  const set = useCallback(
    (id: string, v: SettingValue) => {
      if (targetOf(id)) {
        void save({ [id]: v }, labelOf(id)).then((ok) => ok && id === 'svc' && setTest({ state: 'idle', text: '' }));
        return;
      }
      void bridge.settings.save({ [id]: v }).then(
        (res) => {
          if (res.error) {
            console.warn('settings.save refused', res.error);
            notify({ message: `未能保存「${labelOf(id)}」：配置校验未通过`, severity: 'danger', persistent: true });
            return;
          }
          setVals((vals) => {
            const next = { ...vals, [id]: v };
            if (id.startsWith('plugins.')) setPlugins(next);
            return next;
          });
          if (res.restart === 'backend') waitBackend(startedAt.current);
          if (res.notApplied.length) notify({ message: `已保存，${res.notApplied.map(labelOf).join('、')}需重启 Agentic Complex 后生效`, severity: 'warning', persistent: true });
        },
        () => notify({ message: `未能保存「${labelOf(id)}」：配置服务无响应`, severity: 'danger', persistent: true }),
      );
    },
    [bridge, save, setVals, notify, waitBackend],
  );
  const guideModel = useMemo(() => ({ ...model, set }), [model, set]);

  const talks = model.value(pluginKey('light_ai')) === true;
  const svc = String(model.value('svc') ?? models?.provider ?? '');
  const gpt = models?.chatgpt;
  const connected = svc === 'chatgpt' ? !!gpt?.profiles.some((p) => p.id === gpt.active && p.connected) : !!models?.backends[svc as keyof WireModelSettings['backends']]?.has_key;

  const runTest = useCallback(() => {
    setTest({ state: 'testing', text: '' });
    testModels().then(
      (r) => setTest(r.ok ? { state: 'ok', text: `已连接 │ 耗时 ${(r.elapsed_ms / 1000).toFixed(1)} s` } : { state: 'bad', text: '连接失败：模型未响应' }),
      (e: unknown) => setTest({ state: 'bad', text: `连接失败：${failure(e).text}` }),
    );
  }, []);

  // A usable account is tested once by itself, so 下一步 opens as soon as she can answer.
  const tested = useRef<string | null>(null);
  const account = connected ? `${svc}:${gpt?.active ?? ''}` : null;
  useEffect(() => {
    if (!talks || !account || agentdOff || restarting || tested.current === account) return;
    tested.current = account;
    runTest();
  }, [talks, account, agentdOff, restarting, runTest]);

  // While the browser sign-in is open, read the account until it comes back.
  useEffect(() => {
    if (!gpt?.pending) return;
    const t = window.setInterval(() => void loadModels(), PENDING_POLL_MS);
    return () => window.clearInterval(t);
  }, [gpt?.pending, loadModels]);

  // Back from the system settings: read the permissions again and say which one now works.
  const permsNow = useRef(perms);
  permsNow.current = perms;
  useEffect(() => {
    const onFocus = () => {
      const before = new Map(permsNow.current.map((p) => [p.kind, p.state]));
      void recheckPerms().then(() => {
        for (const p of permsNow.current) {
          if (GUIDE_PERMS.includes(p.kind) && p.state === 'granted' && before.get(p.kind) !== 'granted') toast(`${p.label}：已授予，${p.features.join('、')}现已可用`, { severity: 'success' });
        }
      });
      if (!restarting) void loadDiag();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [recheckPerms, loadDiag, restarting]);

  const reload = useCallback<SettingsCtxValue['reload']>((what) => {
    if (what === 'models') void loadModels();
    if (what === 'diag') void loadDiag();
  }, [loadModels, loadDiag]);
  const retryAgentd = useCallback(() => {
    void loadDiag().then((d) => d && void loadModels());
  }, [loadDiag, loadModels]);

  const ctx = useMemo<SettingsCtxValue>(
    () => ({
      model: guideModel,
      ro: false,
      agentdOff,
      hl: null,
      demo,
      item: null,
      caps: bridge.capabilities,
      native,
      runtime: null,
      runtimeChecking: false,
      recheckRuntime: async () => null,
      models,
      diag: view,
      blacklist: null,
      scopes: null,
      reload,
      perms,
      recheckPerms,
      goRow: () => {},
      goPage: () => {},
    }),
    [guideModel, agentdOff, demo, bridge, native, models, view, reload, perms, recheckPerms],
  );

  const service = SVC.find((o) => o.value === svc)?.label ?? (svc || null);
  return { ctx, restarting, agentdOff, talks, connected, test, runTest, service, retryAgentd };
}
