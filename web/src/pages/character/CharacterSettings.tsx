import { useEffect, useState } from 'react';
import { getBridge, type SettingValue } from '../../bridge';
import { useDevMode } from '../../shell/devMode';
import { Btn, ErrBar, Skel, StatusTag } from '../../ui';
import { defaultsOf } from '../settings/native';
import type { Toast } from './feedback';
import { CHAR_TABS, DEV_ONLY_ROWS, tabOf, type CharTab } from './sections';
import { presentTabs, SettingRows } from './SettingRows';
import { saveSettings, useCharSettings } from './settings';
import { readFail } from './Tune';
import tune from './Tune.module.css';
import styles from './CharacterSettings.module.css';

export interface CharacterSettingsProps {
  tab: CharTab;
  /** Web id of the row to bring into view. */
  row?: string;
  offline: boolean;
  /** The shell has an avatar host: while this view is open she walks clear of the main window. */
  avatar: boolean;
  onTab: (t: CharTab) => void;
  toast: Toast;
}

/** 设定：左边是当前页的设置行，右边贴边的竖排菜单；每行即时保存。 */
export function CharacterSettings(p: CharacterSettingsProps) {
  const { q, merge } = useCharSettings();
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const dev = useDevMode();
  const n = q.data;
  const tabs = n ? presentTabs(n, dev) : [];
  const tab = tabs.includes(p.tab) ? p.tab : tabs[0];

  useEffect(() => {
    if (n && p.row) document.getElementById(`set-${p.row}`)?.scrollIntoView({ block: 'center' });
  }, [n, p.row]);

  useEffect(() => {
    if (!p.avatar) return;
    getBridge().avatar.keepClearOfMain(true).catch(() => {});
    return () => void getBridge().avatar.keepClearOfMain(false).catch(() => {});
  }, [p.avatar]);

  if (q.isError) return <ErrBar message={`读取设置失败：${readFail(q.error)}`} onRetry={() => void q.refetch()} />;
  if (!n) return <Skel rows={8} />;
  if (!tab) return <div className={styles.none}>没有可调的设置</div>;

  // `quiet`: a slider value sent mid-drag; the released value is saved again with its toast.
  const save = (changes: Record<string, SettingValue>, fail: string, quiet = false) =>
    void saveSettings(changes, { ok: '已保存', fail }, n.rows, quiet ? () => {} : p.toast).then((ok) => {
      if (!ok) return;
      merge(changes);
      const restart = Object.keys(changes).filter((id) => n.rows[id]?.restart === 'avatar');
      if (restart.length) setPending((s) => new Set([...s, ...restart]));
    });
  const set = (id: string, v: SettingValue, quiet?: boolean) => save({ [id]: v }, `没有保存「${n.rows[id]?.label ?? id}」`, quiet);
  // The rows SettingRows draws on this page: tabOf places a row by its section, else by its id prefix.
  const reset = () => {
    const changes = Object.fromEntries(
      Object.entries(defaultsOf(n, ['@character'])).filter(([id, v]) => tabOf(id) === tab && (dev || !DEV_ONLY_ROWS.has(id)) && n.saved[id] !== v),
    );
    if (Object.keys(changes).length) save(changes, '没有恢复默认');
  };

  return (
    <div className={styles.set}>
      <div className={styles.board}>
        {p.offline && (
          <div className={tune.ro} role="status">
            <StatusTag state="unreachable" label="角色未运行" />
            <span>设定暂为只读</span>
          </div>
        )}
        <div className={styles.rows}>
          {tab === 'render' && <div className={styles.note}>画面设置作用在桌面上的她；左边的预览台暂不跟随</div>}
          <SettingRows n={n} tab={tab} dev={dev} set={set} pending={pending} offline={p.offline} />
        </div>
        <div className={styles.foot}>
          <span className={styles.tip}>改动即时生效；标「角色重新出现」的行保存后她会重新出现</span>
          <Btn variant="ghost" disabled={p.offline} disabledReason="角色未运行" onClick={reset}>
            恢复默认
          </Btn>
        </div>
      </div>
      <div className={styles.menu} role="tablist" aria-orientation="vertical" aria-label="设定">
        {tabs.map((id) => (
          <button key={id} type="button" role="tab" className={styles.tab} aria-selected={id === tab} onClick={() => p.onTab(id)}>
            {CHAR_TABS.find((t) => t.id === id)?.title}
          </button>
        ))}
      </div>
    </div>
  );
}
