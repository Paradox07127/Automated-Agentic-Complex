import { useEffect, useState, type ReactNode } from 'react';
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
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [failed, setFailed] = useState<Record<string, string>>({});
  const n = q.data;
  const tabs = n ? presentTabs(n) : [];
  const tab = tabs.includes(p.tab) ? p.tab : tabs[0];

  const loaded = n != null;
  useEffect(() => {
    // 主光水平 and 主光俯仰 share the light pad's row.
    const id = p.row === LIGHT_PAD.pitch ? LIGHT_PAD.yaw : p.row;
    if (loaded && id) document.getElementById(`set-${id}`)?.scrollIntoView({ block: 'center' });
  }, [loaded, p.row]);

  useEffect(() => {
    if (!p.avatar) return;
    getBridge().avatar.keepClearOfMain(true).catch(() => {});
    return () => void getBridge().avatar.keepClearOfMain(false).catch(() => {});
  }, [p.avatar]);

  if (q.isError) return <ErrBar message={`读取设置失败：${readFail(q.error)}`} onRetry={() => void q.refetch()} />;
  if (!n) return <Skel rows={8} />;
  if (!tab) return <div className={styles.none}>没有可调的设置</div>;

  // `quiet`: a slider value sent mid-drag; the released value is saved again with its toast, a failure stays on the row.
  const save = (changes: Record<string, SettingValue>, fail: string, quiet = false) => {
    const ids = Object.keys(changes);
    const onRow = (message: string) => setFailed((f) => ({ ...f, ...Object.fromEntries(ids.map((id) => [id, message])) }));
    void saveSettings(changes, { ok: '已保存', fail }, n.rows, quiet ? (message, o) => o?.severity === 'danger' && onRow(message) : p.toast).then((ok) => {
      if (!ok) return;
      setFailed((f) => Object.fromEntries(Object.entries(f).filter(([id]) => !ids.includes(id))));
      merge(changes);
      const restart = ids.filter((id) => n.rows[id]?.restart === 'avatar');
      if (restart.length) setPending((s) => new Set([...s, ...restart]));
    });
  };
  const set = (id: string, v: SettingValue, quiet?: boolean) => save({ [id]: v }, `没有保存「${n.rows[id]?.label ?? id}」`, quiet);
  const ids = tabRows(n, tab);
  const changed = ids.filter((id) => isChanged(n, id));
  const reset = () => save(Object.fromEntries(changed.map((id) => [id, n.rows[id]!.default])), '没有恢复默认');
  const look = tab === 'render';

  return (
    <div className={styles.set}>
      {p.menu !== false && <GameTabs label="设定" tabs={tabItems(tabs, n)} value={tab} onChange={(id) => p.onTab(id as CharTab)} />}
      <Linked offline={p.offline} onRestart={p.onRestart}>
        <div className={styles.sum}>
          <span className={styles.en}>
            <MicroLabel>{look ? 'Diff from original' : 'Diff from default'}</MicroLabel>
          </span>
          <span className={styles.k}>已改</span>
          <b className={styles.n}>{changed.length}</b>
          <span className={styles.k}>/ {ids.length} 项</span>
          <span className={styles.sp} />
          <WhiteCapsule
            label={look ? '恢复原作' : '恢复默认'}
            icon="refresh"
            disabled={p.offline || changed.length === 0}
            disabledReason={p.offline ? '角色未运行' : '没有改动'}
            onClick={reset}
          />
        </div>
        <div className={styles.rows} data-theme="dark">
          <SettingRows
            n={n}
            tab={tab}
            set={set}
            setMany={(changes) => save(changes, '没有保存「主光方向」')}
            pending={pending}
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
      <PowerState state="unlinked" mode="block" title="桌面角色" reason="角色未运行，设定暂为只读" action={{ label: '重启角色', onClick: onRestart }}>
        {children}
      </PowerState>
    </div>
  );
}
