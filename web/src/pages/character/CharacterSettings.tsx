import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { getBridge, type SettingValue } from '../../bridge';
import { ErrBar, Skel, type IconName } from '../../ui';
import { GameTabs, MicroLabel, PowerState, WhiteCapsule, type GameTab } from '../../ui/game';
import type { Native } from '../settings/native';
import type { Toast } from './feedback';
import { Panel } from './Panel';
import { CHAR_TABS, LIGHT_PAD, type CharTab } from './sections';
import { isChanged, presentTabs, SettingRows, tabRows } from './SettingRows';
import { readFail, saveSettings, useCharSettings } from './settings';
import styles from './CharacterSettings.module.css';

export interface CharacterSettingsProps {
  tab: CharTab;
  /** Web id of the row to bring into view. */
  row?: string;
  offline: boolean;
  /** 重启角色 on the 未接入 strip while she is not running. */
  onRestart: () => void;
  /** The shell has an avatar host: while this view is open she walks clear of the main window. */
  avatar: boolean;
  onTab: (t: CharTab) => void;
  /** Its own tab bar on top; off inside SetPanel, whose bar names the pages. */
  menu?: boolean;
  toast: Toast;
}

const SET_ICON: Record<CharTab, IconName> = { behavior: 'hand', render: 'sun', scene: 'loc' };

const watchTheme = (cb: () => void) => {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => mo.disconnect();
};

/** The window's theme on `<html>`: the rows follow it like the settings page, inside the always-light training room. */
const useAppTheme = () => useSyncExternalStore(watchTheme, () => document.documentElement.dataset.theme);

/** The 设定 tab bar's cells, an orange dot on each page with a row off its default. */
function tabItems(ids: readonly CharTab[], n: Native | undefined): GameTab[] {
  return CHAR_TABS.filter((t) => ids.includes(t.id)).map((t) => ({
    id: t.id,
    label: t.title,
    icon: SET_ICON[t.id],
    micro: t.en,
    changed: n != null && tabRows(n, t.id).some((id) => isChanged(n, id)),
  }));
}

export interface SetPanelProps {
  /** The pages that have rows (presentTabs). */
  tabs: readonly CharTab[];
  tab: CharTab;
  onTab: (t: CharTab) => void;
  children: ReactNode;
}

/** 设定 in the detail panel: its pages as tabs, an orange dot on each page with a row off its default. */
export function SetPanel(p: SetPanelProps) {
  const n = useCharSettings().q.data;
  return (
    <Panel tabs={tabItems(p.tabs, n)} value={p.tab} tail="Character Settings" onTab={(id) => p.onTab(id as CharTab)}>
      {p.children}
    </Panel>
  );
}

/** 设定：本页改了几项和整页恢复，再是各节的设置行；每行即时保存，改过的行点 ↺ 恢复默认。 */
export function CharacterSettings(p: CharacterSettingsProps) {
  const { q, merge } = useCharSettings();
  const theme = useAppTheme();
  // Restart rows saved, each true once she has left `running` since its save: the next `running` drops it.
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const up = useRef(true);
  const [failed, setFailed] = useState<Record<string, string>>({});
  // Saves still out: 恢复默认 waits for them, as it builds its payload from the merged values.
  const [saving, setSaving] = useState(0);
  // Per row, the newest save merged: an older answer does not land over a newer one.
  const sent = useRef(0);
  const merged = useRef<Record<string, number>>({});
  const n = q.data;
  const tabs = n ? presentTabs(n) : [];
  const tab = tabs.includes(p.tab) ? p.tab : tabs[0];

  const loaded = n != null;
  useEffect(() => {
    // 主光水平 and 主光俯仰 share the light pad's row.
    const id = p.row === LIGHT_PAD.pitch ? LIGHT_PAD.yaw : p.row;
    if (loaded && id) document.getElementById(`set-${id}`)?.scrollIntoView({ block: 'center' });
  }, [loaded, p.row]);

  useEffect(
    () =>
      getBridge().app.onRuntime((s) => {
        const running = s.processes.avatar.state === 'running';
        up.current = running;
        setPending((was) => {
          const ids = Object.keys(was);
          if (running) return ids.some((id) => was[id]) ? Object.fromEntries(ids.filter((id) => !was[id]).map((id) => [id, false])) : was;
          return ids.some((id) => !was[id]) ? Object.fromEntries(ids.map((id) => [id, true])) : was;
        });
      }),
    [],
  );

  useEffect(() => {
    if (!p.avatar) return;
    getBridge().avatar.keepClearOfMain(true).catch(() => {});
    return () => void getBridge().avatar.keepClearOfMain(false).catch(() => {});
  }, [p.avatar]);

  if (q.isError) return <ErrBar message={`未能读取设置：${readFail(q.error)}`} onRetry={() => void q.refetch()} />;
  if (!n) return <Skel rows={8} />;
  if (!tab) return <div className={styles.none}>当前无可用设置项</div>;

  // `quiet`: a slider value sent mid-drag; the released value is saved again with its toast, a failure stays on the row.
  const save = (changes: Record<string, SettingValue>, fail: string, quiet = false) => {
    const ids = Object.keys(changes);
    const k = ++sent.current;
    const onRow = (message: string) => setFailed((f) => ({ ...f, ...Object.fromEntries(ids.map((id) => [id, message])) }));
    setSaving((c) => c + 1);
    return saveSettings(changes, { ok: '已保存', fail }, n.rows, quiet ? (message, o) => o?.severity === 'danger' && onRow(message) : p.toast).then((ok) => {
      setSaving((c) => c - 1);
      if (!ok) return false;
      setFailed((f) => Object.fromEntries(Object.entries(f).filter(([id]) => !ids.includes(id))));
      const fresh = ids.filter((id) => k > (merged.current[id] ?? 0));
      for (const id of fresh) merged.current[id] = k;
      merge(Object.fromEntries(fresh.map((id) => [id, changes[id]!])));
      const restart = ids.filter((id) => n.rows[id]?.restart === 'avatar');
      if (restart.length) setPending((s) => ({ ...s, ...Object.fromEntries(restart.map((id) => [id, !up.current])) }));
      return true;
    });
  };
  const set = (id: string, v: SettingValue, quiet?: boolean) => save({ [id]: v }, `未能保存「${n.rows[id]?.label ?? id}」`, quiet);
  const ids = tabRows(n, tab);
  const changed = ids.filter((id) => isChanged(n, id));
  const reset = () => save(Object.fromEntries(changed.map((id) => [id, n.rows[id]!.default])), '未能恢复本页默认设置');

  return (
    <div className={styles.set}>
      {p.menu !== false && <GameTabs label="设定" tabs={tabItems(tabs, n)} value={tab} onChange={(id) => p.onTab(id as CharTab)} />}
      <Linked offline={p.offline} onRestart={p.onRestart}>
        <div className={styles.sum}>
          <span className={styles.en}>
            <MicroLabel>Diff from default</MicroLabel>
          </span>
          <span className={styles.k}>已修改</span>
          <b className={styles.n}>{changed.length}</b>
          <span className={styles.k}>/ {ids.length} 项</span>
          <span className={styles.sp} />
          <WhiteCapsule
            label="恢复本页默认"
            icon="refresh"
            disabled={p.offline || changed.length === 0 || saving > 0}
            disabledReason={p.offline ? '角色进程未运行' : changed.length === 0 ? '当前均为默认值' : '正在保存更改'}
            onClick={reset}
          />
        </div>
        <div className={styles.rows} data-theme={theme}>
          <SettingRows
            n={n}
            tab={tab}
            set={set}
            setMany={(changes) => save(changes, '未能保存「主光方向」')}
            pending={new Set(Object.keys(pending))}
            failed={failed}
            offline={p.offline}
          />
        </div>
      </Linked>
    </div>
  );
}

/** While she is not running the rows stay, read-only, under a 未接入 strip with 重启角色. */
function Linked({ offline, onRestart, children }: { offline: boolean; onRestart: () => void; children: ReactNode }) {
  if (!offline) return <>{children}</>;
  return (
    <div className={styles.linked}>
      <PowerState state="unlinked" mode="block" title="桌面角色" reason="角色进程未运行，当前设定为只读" action={{ label: '重启角色进程', onClick: onRestart }}>
        {children}
      </PowerState>
    </div>
  );
}
