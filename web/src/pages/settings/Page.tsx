import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { getBridge } from '../../bridge';
import { gameClips } from '../../design/gameClips.generated';
import { refreshRuntime, runtimeKey } from '../../data/runtime';
import { useDemo } from '../../shell/demo';
import { isDevMode } from '../../shell/devMode';
import { setPlugins } from '../../shell/plugins';
import { PageHeaderSlot } from '../../shell/headerSlot';
import { navigate as navTo } from '../../shell/nav';
import { Btn, ErrBar, Region, type RegionSource } from '../../ui';
import { PowerState } from '../../ui/game';
import { playClip } from '../../ui/ToggleClip';
import { ApplyBar } from './ApplyBar';
import { runtimeView, SettingsCtx, type Reloadable, type SettingsCtxValue } from './ctx';
import type { Target } from './fields';
import { AboutGroup } from './groups/About';
import { ActGroup } from './groups/Act';
import { DataGroup } from './groups/Data';
import { DisplayGroup } from './groups/Display';
import { KernelGroup } from './groups/Kernel';
import { KeysGroup } from './groups/Keys';
import { SeeGroup } from './groups/See';
import { ServicesData } from './groups/ServicesData';
import { SpeakGroup } from './groups/Speak';
import { useSettingsModel } from './model';
import type { Native } from './native';
import { usePerms } from './perms';
import { demoInit } from './demoInit';
import { DEFAULT_GROUP, GROUP_IDS, groupOf, isGroup, NATIVE_GROUPS, NEEDS_AGENTD, NOT_PI_ROWS, PI_ONLY_ROWS, SECTION_GROUP, searchSettings, DRAFT_SECTION, useRowShown, type GroupId, type RegEntry } from './registry';
import { SearchResults } from './SearchResults';
import { SetNav, SetSearch } from './SetNav';
import { SettingsOverlays } from './SettingsOverlays';
import { LeaveGuard } from './LeaveGuard';
import { useSettingsData } from './useSettingsData';
import { DEV_ONLY_ROWS, tabOf } from '../character/sections';
import styles from './Page.module.css';

const GROUPS: Record<GroupId, ComponentType> = {
  speak: SpeakGroup,
  perm: ActGroup,
  privacy: SeeGroup,
  display: DisplayGroup,
  kernel: KernelGroup,
  services: ServicesData,
  keys: KeysGroup,
  data: DataGroup,
  about: AboutGroup,
};

const QUERY: Record<Reloadable, string> = { runtime: 'runtime', models: 'models', diag: 'diag', blacklist: 'blacklist', scopes: 'scopes' };

/** The read-only cause, said once in the bar above the group; the rows do not repeat it. */
const NATIVE_RO = '读取设置失败，这一组暂不能修改';

/** `?state=loading` / `?state=error` stand in for the config.json read; the agentd reads stay real. */
const DEMO_NATIVE: Record<'loading' | 'error', RegionSource<Native>> = {
  loading: { status: 'pending', data: undefined },
  error: { status: 'error', data: undefined, error: new Error('config.json 读不到') },
};

/** Keys typed into these do not switch the group. */
const TYPING = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"]';

function useSearchParams() {
  const search = useRouterState({ select: (s) => s.location.searchStr });
  return useMemo(() => {
    const p = new URLSearchParams(search);
    const g = p.get('group');
    const item = p.get('item');
    const group = isGroup(g) ? g : DEFAULT_GROUP;
    return { group, item, q: p.get('q') ?? '' };
  }, [search]);
}

// Navigating keeps the view flags so a light-theme or still session stays in that mode.
function carry(prev: Record<string, unknown>, next: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...next };
  if (prev.theme !== undefined) out.theme = prev.theme;
  if (prev.still !== undefined) out.still = prev.still;
  return out;
}

/** 设置: nine group tabs and the search in the top bar, one list column, the bottom bar, white confirm cards. */
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
    agentdStartedAt: data.view.agentdStartedAt,
    merge,
    reload: (t) => reload(t),
  });
  const [q, setQ] = useState(urlQ);
  const shownRow = useRowShown();
  const [hl, setHl] = useState<string | null>(item);
  const main = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
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

  // Pages, home keys and rows follow each saved capability switch at once; the backend takes it on its restart.
  const saved = nativeQ.data?.saved;
  useEffect(() => void (saved && setPlugins({ ...saved, ...model.vals })), [saved, model.vals]);

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
    (row: string, g?: GroupId) => {
      const target = g ?? groupOf(row) ?? group;
      setQ('');
      setHl(row);
      go({ group: target, item: row });
    },
    [go, group],
  );
  const goGroup = useCallback(
    (g: GroupId) => {
      setQ('');
      go({ group: g });
    },
    [go],
  );
  const goPage = navTo;
  const pickResult = (r: RegEntry) => {
    if (r.group === '@character') return goPage({ page: 'character', tab: tabOf(r.id), row: r.id });
    if (r.group === '@memory') return goPage({ page: 'memory', view: 'about' });
    if (r.group === '@overview') return goPage({ page: 'overview' });
    goRow(r.id, r.group);
  };

  // Q / E step through the groups, as the game's tab bar does; the caps are not drawn.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || e.repeat) return;
      const step = e.key === 'q' || e.key === 'Q' ? -1 : e.key === 'e' || e.key === 'E' ? 1 : 0;
      if (!step || (e.target instanceof Element && e.target.closest(TYPING)) || document.querySelector('[data-stub="SettingsConfirm"]')) return;
      const i = GROUP_IDS.indexOf(group);
      goGroup(GROUP_IDS[(i + step + GROUP_IDS.length) % GROUP_IDS.length]!);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [group, goGroup]);

  const marks: Partial<Record<GroupId, string>> = {};
  if (data.view.voice?.state === 'unreachable') marks.speak = '语音服务未接入';
  const missing = perms.filter((p) => p.state === 'denied' || p.state === 'notDetermined');
  if (missing.length) marks.perm = `${missing.map((p) => p.label).join('、')}没开`;
  if (runtime && !runtime.ready) marks.kernel = '内核没就绪';
  const drafts = [...new Set(Object.keys(model.draft).map((k) => SECTION_GROUP[DRAFT_SECTION[k] ?? ''] ?? null))].filter((g): g is GroupId => g != null);

  const ctx: SettingsCtxValue = {
    model,
    ro,
    roReason: nativeRo ? NATIVE_RO : '后台服务未接入，这一组暂时只读',
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
    reload,
    perms,
    recheckPerms,
    goRow,
    goPage,
  };
  const pi = model.value('kernel') === 'pi';
  const results = q.trim()
    ? searchSettings(q).filter((r) => !(r.group === '@character' && DEV_ONLY_ROWS.has(r.id) && !isDevMode()) && !(pi ? NOT_PI_ROWS : PI_ONLY_ROWS).has(r.id) && shownRow(r.id)
      && (r.section !== '系统权限' || r.id === 'perms' || perms.some((p) => p.kind === r.id)))
    : null;
  const view = results ? 'search' : group;

  // gamesetting_in on mount; gamesetting_change on the list whenever another group or the search takes it.
  const shown = useRef(view);
  useLayoutEffect(() => playClip(gameClips.settingIn, page.current), []);
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
  else if (agentdOff && NEEDS_AGENTD.includes(group))
    body = (
      <PowerState
        state="unlinked"
        mode="block"
        title="后台服务"
        reason="后台已断开，AI 这一组暂时只读"
        action={{ label: '重启后台', onClick: () => void model.restartBackend() }}
      >
        <Group />
      </PowerState>
    );
  else body = <Group />;

  return (
    <SettingsCtx.Provider value={ctx}>
      <div ref={page} className={styles.page} data-group={group} data-demo={demo ?? undefined}>
        <div className={styles.wall} data-theme="dark" aria-hidden="true" />
        <PageHeaderSlot
          sub={results ? '搜索' : undefined}
          tabs={<SetNav group={group} searching={!!results} marks={marks} drafts={drafts} onGroup={goGroup} />}
          right={<SetSearch q={q} onQ={setQ} onEnter={() => results?.[0] && pickResult(results[0])} />}
        />
        <div className={styles.main} ref={main}>
          <div className={styles.inner} data-g="content">
            {nativeRo && (
              <ErrBar
                message={NATIVE_RO}
                extra={
                  <Btn go onClick={openConfig}>
                    打开配置文件
                  </Btn>
                }
              />
            )}
            <div key={view} data-group={view} data-g="list">
              {body}
            </div>
          </div>
        </div>
        <ApplyBar />
      </div>
      <SettingsOverlays />
      <LeaveGuard />
    </SettingsCtx.Provider>
  );
}
