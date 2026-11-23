import { Fragment, useState, type KeyboardEvent } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { post, put, seg } from '../bridge/agentd';
import { appNow } from '../bridge/clock';
import { refreshRuntime } from '../data/runtime';
import { fromRuntimePublic, quiet as quietBody, runCancel, splitCanonical, type Task } from '../domain';
import { useHotkeyLabels } from '../domain/hotkeys';
import { notStopped, resumeOf, StopConfirm } from '../features/task';
import { errText } from '../pages/overview/errors';
import { Icon, Kbd } from '../ui';
import { paletteItems, usePaletteIndex, type PaletteItem } from './CmdPalette.data';
import { look, openQuickInput, stopSpeech, useDesktopOff } from './desktopOps';
import { navigate } from './nav';
import { usePlugins } from './plugins';
import { toast } from './toast';
import type { PageRoute } from './types';
import styles from './CmdPalette.module.css';

async function quiet() {
  try {
    await put('/observation/quiet', quietBody(appNow() + 30 * 60_000));
    toast('已进入免打扰 30 分钟，提醒暂停');
  } catch (e) {
    toast(`免打扰失败：${errText(e)}`, { severity: 'danger' });
  }
}

/** Same read as settings › 内核 「重新检测」, then land on that row. */
async function recheck(qc: QueryClient) {
  try {
    const view = fromRuntimePublic(await refreshRuntime(qc));
    const rt = view.runtimes.find((x) => x.id === view.selected);
    if (!rt) toast('重新检测失败：没有选中的内核', { severity: 'danger' });
    else if (rt.authenticated === false) toast(`已重新检测：${rt.name} 未登录`, { severity: 'warning' });
    else toast(`已重新检测：${rt.name} 已就绪`, { severity: 'success' });
  } catch (e) {
    toast(`重新检测失败：${errText(e)}`, { severity: 'danger' });
  }
  navigate({ page: 'settings', group: 'kernel', item: 'kcur' });
}

/** By id prefix: a role job cancels its job, a character ledger row its task, any other row its run. External sessions are never offered. */
export async function stopTask(task: Task) {
  const { kind, raw } = splitCanonical(task.id);
  try {
    if (kind === 'job') {
      const { cancelled } = await post<{ cancelled: boolean }>(`/agent/jobs/${seg(raw)}/cancel`, {});
      if (!cancelled) {
        toast(notStopped(task), { severity: 'warning' });
        return;
      }
    } else if (task.target === 'character') await post(`/tasks/${seg(raw)}/cancel`, {});
    else if (task.run_id) await post(`/agent/runs/${seg(task.run_id)}/cancel`, runCancel(task));
    else return;
    toast(`已停止「${task.title}」`);
  } catch (e) {
    toast(`停止失败：${errText(e)}`, { severity: 'danger' });
  }
}

/** ⌘K: jump to a page, search tasks / memory / deliveries (Enter lands on `sel=`), or run an action. */
export function CmdPalette({ routes, onClose }: { routes: PageRoute[]; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [stopping, setStopping] = useState<Task | null>(null);
  const data = usePaletteIndex();
  const off = useDesktopOff();
  const keys = useHotkeyLabels();
  const plugins = usePlugins();
  const qc = useQueryClient();
  const hits = paletteItems(query, routes, data.data, off, keys, plugins);
  const sel = Math.min(index, Math.max(0, hits.length - 1));
  const searching = query.trim() !== '';

  const run = (item: PaletteItem) => {
    const r = item.run;
    if (r.kind === 'off') return;
    if (r.kind === 'stop') {
      setStopping(r.task);
      return;
    }
    onClose();
    if (r.kind === 'nav') navigate(r.target);
    else if (r.kind === 'desktop') void (r.op === 'look' ? look() : r.op === 'stopSpeech' ? stopSpeech() : openQuickInput());
    else if (r.kind === 'quiet') void quiet();
    else void recheck(qc);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setIndex(Math.min(Math.max(sel + step, 0), Math.max(0, hits.length - 1)));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = hits[sel];
      if (hit) run(hit);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (stopping) {
    return (
      <StopConfirm
        open
        target={stopping.title}
        resume={resumeOf([stopping])}
        onCancel={onClose}
        onConfirm={() => {
          onClose();
          void stopTask(stopping);
        }}
      />
    );
  }

  return (
    <div
      className={styles.scrim}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles.panel} role="dialog" aria-label="命令面板">
        <input
          className={styles.input}
          autoFocus
          value={query}
          placeholder="搜索任务、记忆、交付，或输入动作…"
          aria-label="命令"
          role="combobox"
          aria-expanded="true"
          aria-controls="ef-cmd-list"
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={onKey}
        />
        <div className={styles.list} role="listbox" id="ef-cmd-list">
          {hits.length === 0 && <p className={styles.empty}>{searching && data.isPending ? '正在读取任务、记忆和交付…' : '没有匹配的结果'}</p>}
          {hits.map((h, i) => (
            <Fragment key={h.key}>
              {h.group !== hits[i - 1]?.group && (
                <div className={styles.group} data-group={h.group}>
                  {h.group}
                  <span className={styles.count}>[{hits.filter((x) => x.group === h.group).length}]</span>
                </div>
              )}
              <button
                type="button"
                role="option"
                aria-selected={i === sel}
                aria-disabled={h.run.kind === 'off' || undefined}
                className={i === sel ? `${styles.option} ${styles.on}` : styles.option}
                onMouseEnter={() => setIndex(i)}
                onClick={() => run(h)}
              >
                {h.group === '跳页' && (
                  <span className={styles.icon} aria-hidden="true">
                    {h.icon && <Icon name={h.icon} size={16} />}
                  </span>
                )}
                <span className={styles.grow}>{h.label}</span>
                {h.hint && <span className={styles.hint}>{h.hint}</span>}
                <span className={styles.keys}>{h.shortcut && <Kbd>{h.shortcut}</Kbd>}</span>
              </button>
            </Fragment>
          ))}
          {searching && data.data && data.data.missing.length > 0 && <p className={styles.empty}>没读到：{data.data.missing.join('、')}，这部分没有搜</p>}
        </div>
        <div className={styles.foot}>↑ ↓ 选择 │ ⏎ 执行 │ esc 关闭</div>
      </div>
    </div>
  );
}
