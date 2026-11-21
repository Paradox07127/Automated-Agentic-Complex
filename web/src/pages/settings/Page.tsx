import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { getBridge } from '../../bridge';
import { gameClips } from '../../design/gameClips.generated';
import { refreshRuntime, runtimeKey } from '../../data/runtime';
import { SETTING_GROUPS } from './groups';
import { useDemo } from '../../shell/demo';
import { useDevMode } from '../../shell/devMode';
import { usePlugins } from '../../shell/plugins';
import { PageHeaderSlot } from '../../shell/headerSlot';
import { navigate as navTo } from '../../shell/nav';
import { Btn, ErrBar, Region, type RegionSource } from '../../ui';
import { playClip } from '../../ui/ToggleClip';
import { ApplyBar } from './ApplyBar';
import { runtimeView, SettingsCtx, type Reloadable, type SettingsCtxValue } from './ctx';
import type { Target } from './fields';
import { AboutGroup } from './groups/About';
import { AdvGroup } from './groups/Adv';
import { DataGroup } from './groups/Data';
import { KernelGroup } from './groups/Kernel';
import { KeysGroup } from './groups/Keys';
import { ModelGroup } from './groups/Model';
import { PermGroup } from './groups/Perm';
import { PluginsGroup } from './groups/Plugins';
import { PrivacyGroup } from './groups/Privacy';
import { SpeakGroup } from './groups/Speak';
import { useSettingsModel } from './model';
import type { Native } from './native';
import { usePerms } from './perms';
import { demoInit } from './demoInit';
import { DEFAULT_GROUP, groupOf, groupShown, isGroup, NATIVE_GROUPS, NEEDS_AGENTD, PI_ONLY_ROWS, SECTION_GROUP, searchSettings, DRAFT_SECTION, useRowShown, type GroupId, type RegEntry } from './registry';
import { SearchResults } from './SearchResults';
import { SetNav, SetSearch } from './SetNav';
import { useWidth } from '../../charts/useWidth';
import { SettingsOverlays } from './SettingsOverlays';
import { useSettingsData } from './useSettingsData';
import { DEV_ONLY_ROWS, tabOf } from '../character/sections';
import styles from './Page.module.css';

const GROUPS: Record<GroupId, ComponentType> = {
  plugins: PluginsGroup,
  speak: SpeakGroup,
  keys: KeysGroup,
  kernel: KernelGroup,
  model: ModelGroup,
  privacy: PrivacyGroup,
  perm: PermGroup,
  data: DataGroup,
  about: AboutGroup,
  adv: AdvGroup,
};

/** Page width at or below which the search leaves the tab bar for the top of the list (a window under 1100 with the sidebar folded). */
const COMPACT_W = 860;

const QUERY: Record<Reloadable, string> = { runtime: 'runtime', models: 'models', diag: 'diag', blacklist: 'blacklist', scopes: 'scopes' };

/** The read-only cause, said once in the bar above the group; the rows do not repeat it. */
const NATIVE_RO = '读取设置失败，这一组暂不能修改';
const AGENTD_RO = '后台已断开，这一组暂时只读';

/** `?state=loading` / `?state=error` stand in for the config.json read; the agentd reads stay real. */
const DEMO_NATIVE: Record<'loading' | 'error', RegionSource<Native>> = {
  loading: { status: 'pending', data: undefined },
  error: { status: 'error', data: undefined, error: new Error('config.json 读不到') },
};

/** A group of a plug-in that is off reads as the default group. */
function useSearchParams() {
  const search = useRouterState({ select: (s) => s.location.searchStr });
  const plugins = usePlugins();
  return useMemo(() => {
    const p = new URLSearchParams(search);
    const g = p.get('group');
    return { group: isGroup(g) && groupShown(g, plugins) ? g : DEFAULT_GROUP, item: p.get('item'), q: p.get('q') ?? '' };
  }, [search, plugins]);
}

// Navigating keeps the view flags so a light-theme or still session stays in that mode.
function carry(prev: Record<string, unknown>, next: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...next };
  if (prev.theme !== undefined) out.theme = prev.theme;
  if (prev.still !== undefined) out.still = prev.still;
  return out;
}

/** 设置: top icon tab bar + one list column, nine groups, search, bottom apply bar, danger confirms. */
export function SettingsPage() {
  const { demo } = useDemo();
  return <SettingsBody key={demo ?? 'none'} />;
}

function SettingsBody() {
  const { state, demo, still } = useDemo();
  const { group, item, q: urlQ } = useSearchParams();
  const navigate = useNavigate();
  const bridge = getBridge();
  const qc = useQueryClient();
  const data = useSettingsData(demo);
  const nativeQ: RegionSource<Native> = state === 'loading' || state === 'error' ? DEMO_NATIVE[state] : data.native;
  const runtime = useMemo(() => (data.runtime.data ? runtimeView(data.runtime.data) : null), [data.runtime.data]);
  const reload = useCallback((what: Reloadable) => void qc.invalidateQueries({ queryKey: what === 'runtime' ? runtimeKey(demo) : ['settings', QUERY[what]] }), [qc, demo]);
  const merge = useCallback(
    (target: Target, reply: unknown) => {
      const key = target === 'runtime' ? runtimeKey(demo) : ['settings', target];
      qc.setQueryData(key, (old: object | undefined) => ({ ...old, ...(reply as object) }));
    },
    [qc, demo],
  );
  const model = useSettingsModel(useMemo(() => demoInit(demo), [demo]), {
    native: nativeQ.data ?? null,
    runtime: data.runtime.data ?? null,
    models: data.models.data ?? null,
    pauses: data.view.pauses,
    agentdStartedAt: data.view.agentdStartedAt,
    merge,
    reload: (t) => reload(t),
  });
  const [q, setQ] = useState(urlQ);
  const devMode = useDevMode();
  const shownRow = useRowShown();
  const [hl, setHl] = useState<string | null>(item);
  const main = useRef<HTMLDivElement>(null);
  const [pageRef, pageW] = useWidth<HTMLDivElement>(1072);
  const compact = pageW <= COMPACT_W;
  const agentdOff = data.connection.data === 'offline';
  const nativeErr = nativeQ.status === 'error';
  const nativeRo = nativeErr && NATIVE_GROUPS.includes(group);
  const ro = (agentdOff && NEEDS_AGENTD.includes(group)) || nativeRo;

  const { perms, recheckPerms } = usePerms(bridge);
  const [runtimeChecking, setRuntimeChecking] = useState(false);
  const recheckRuntime = useCallback(async () => {
    setRuntimeChecking(true);
    const r = await refreshRuntime(qc, demo).catch(() => null);
    setRuntimeChecking(false);
    return r ? runtimeView(r) : null;
  }, [qc, demo]);

  useEffect(() => setHl(item), [item]);
  useEffect(() => {
    if (!hl) return;
    document.getElementById(`set-${hl}`)?.scrollIntoView?.({ block: 'center' });
    if (still) return;
    const t = window.setTimeout(() => setHl(null), 1600);
    return () => window.clearTimeout(t);
  }, [hl, group, still, runtime]);
  useEffect(() => {
    if (main.current && !item) main.current.scrollTop = 0;
  }, [group, item]);

  // Confirm demos open the real flow, so confirming still writes and shows feedback.
  const opened = useRef(false);
  useEffect(() => {
    if (demo !== 'confirm-danger' || opened.current || !data.native.data) return;
    opened.current = true;
    const id = item ?? 'wintext';
    if (data.native.data.rows[id]?.destructive) model.set(id, false);
  }, [demo, item, model, data.native.data]);

  const go = useCallback(
    (next: Record<string, string>) => void navigate({ to: '/settings', search: (prev: Record<string, unknown>) => carry(prev, next), replace: true }),
    [navigate],
  );
  const goRow = useCallback(
    (id: string, g?: GroupId) => {
      const target = g ?? groupOf(id) ?? group;
      setQ('');
      setHl(id);
      go({ group: target, item: id });
    },
    [go, group],
  );
  const goPage = navTo;
  const pickResult = (r: RegEntry) => {
    if (r.group === '@character') return goPage({ page: 'character', tab: tabOf(r.id), row: r.id });
    if (r.group === '@memory') return goPage({ page: 'memory', view: 'about' });
    goRow(r.id, r.group);
  };

  const marks: Partial<Record<GroupId, string>> = {};
  const missing = perms.filter((p) => p.state === 'denied' || p.state === 'notDetermined');
  if (missing.length) marks.perm = `${missing.map((p) => p.label).join('、')}未允许`;
  if (runtime && !runtime.ready) marks.kernel = '角色内核未就绪';
  const drafts = [...new Set(Object.keys(model.draft).map((k) => SECTION_GROUP[DRAFT_SECTION[k] ?? ''] ?? null))].filter((g): g is GroupId => g != null);

  const ctx: SettingsCtxValue = {
    model,
    ro,
    roReason: nativeRo ? NATIVE_RO : AGENTD_RO,
    agentdOff,
    hl,
    demo,
    item,
    caps: bridge.capabilities,
    native: nativeQ.data ?? null,
    schema: data.schema.data ?? null,
    runtime,
    runtimeChecking,
    recheckRuntime,
    models: data.models.data ?? null,
    diag: data.view,
    blacklist: data.blacklist.data ?? null,
    scopes: data.scopes.data ?? null,
    runs: data.runs.data ?? null,
    shots: data.shots.data ?? null,
    gateEvents: data.gate.data?.events ?? null,
    gateBlocked: data.gate.data?.blocked ?? null,
    reload,
    perms,
    recheckPerms,
    goRow,
    goPage,
  };
  const pi = model.value('kernel') === 'pi';
  const results = q.trim()
    ? searchSettings(q).filter((r) => !(r.group === '@character' && DEV_ONLY_ROWS.has(r.id) && !devMode) && (pi || !PI_ONLY_ROWS.has(r.id)) && shownRow(r.id))
    : null;
  const view = results ? 'search' : group;

  // gamesetting_in on mount; gamesetting_change on the list whenever another group or the search takes it.
  const shown = useRef(view);
  useLayoutEffect(() => playClip(gameClips.settingIn, pageRef.current), [pageRef]);
  useLayoutEffect(() => {
    if (shown.current === view) return;
    shown.current = view;
    playClip(gameClips.settingChange, main.current);
  }, [view]);
  const Group = GROUPS[group];
  const openConfig = () =>
    void bridge.app.action('open_config').then(
      () => model.notify({ message: '已打开配置文件' }),
      () => model.notify({ message: '这个外壳还不能打开配置文件', severity: 'warning' }),
    );

  // Only the groups holding config.json rows wait for it; a failed read leaves them read-only under the error bar.
  let body;
  if (results) body = <SearchResults q={q} results={results} onPick={pickResult} />;
  else if (NATIVE_GROUPS.includes(group) && nativeQ.status === 'pending')
    body = (
      <Region q={nativeQ} what="设置" reserve={{ rows: 8 }} onRetry={() => void data.native.refetch()}>
        {() => null}
      </Region>
    );
  else body = <Group />;

  return (
    <SettingsCtx.Provider value={ctx}>
      <div ref={pageRef} className={styles.page} data-group={group} data-demo={demo ?? undefined} data-compact={compact || undefined}>
        <PageHeaderSlot sub={results ? '搜索' : SETTING_GROUPS.flatMap((g) => g.items).find((i) => i.id === group)?.label} tabs={<SetNav group={group} searching={!!results} marks={marks} drafts={drafts} onGroup={(g) => (setQ(''), go({ group: g }))} />} right={<SetSearch q={q} onQ={setQ} />} />
        <div className={styles.main} ref={main}>
          {/* The rise plays inside the scroller, so the shell's page scroller never overflows. */}
          <div className={styles.inner} data-g="content">
            {nativeRo && (
              <ErrBar
                message={NATIVE_RO}
                extra={
                  <Btn size="sm" variant="ghost" icon="file" onClick={openConfig}>
                    打开配置文件
                  </Btn>
                }
              />
            )}
            {agentdOff && NEEDS_AGENTD.includes(group) && (
              <div className={styles.roNote} role="status">
                <span className={styles.roDot} aria-hidden="true" />
                <span>
                  <b>后台已断开</b> │ 这一组暂时只读
                </span>
                <Btn size="sm" variant="secondary" loading={model.restarting} onClick={() => void model.restartBackend()}>
                  重启后台服务
                </Btn>
              </div>
            )}
            <div key={view} data-group={view} data-g="list">
              {body}
            </div>
            {!results && <ApplyBar />}
          </div>
        </div>
      </div>
      <SettingsOverlays />
    </SettingsCtx.Provider>
  );
}
