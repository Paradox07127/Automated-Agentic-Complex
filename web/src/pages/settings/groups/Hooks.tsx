import { useEffect, useState } from 'react';
import { getBridge, type AppInfo } from '../../../bridge';
import { NodeChain } from '../../../charts';
import { formatAgo } from '../../../domain/time';
import { clock, disconnectHooks, failure } from '../api';
import { useSettings } from '../ctx';
import type { Hook } from '../diag';
import { Btn } from '../../../ui';
import { StatusLamp } from '../../../ui/game';
import { SetRow } from '../SetRow';
import { runInTerminal } from '../terminal';
import styles from '../groups.module.css';

const TOOLS: Array<{ id: 'claude' | 'codex'; row: string; name: string }> = [
  { id: 'claude', row: 'hooks', name: 'Claude Code' },
  { id: 'codex', row: 'hooks2', name: 'Codex' },
];

type Step = AppInfo['hookInstallSteps'][number];

/** Stand-ins for the dry run and install when the app gives no installer; their buttons stay disabled. */
const NO_INSTALLER: Step[] = [
  { label: '先看会改什么', command: '', terminal: true },
  { label: '确认改动后执行', command: '', terminal: true },
];

/** The app's installer steps aimed at one tool, and for Codex the in-app
 * trust step (it skips hooks it has not trusted). */
function installSteps(installer: Step[], id: 'claude' | 'codex'): Step[] {
  const steps = installer.length ? installer.map((s) => (s.terminal ? { ...s, command: `${s.command} --target ${id}` } : s)) : NO_INSTALLER;
  return id === 'codex' ? [...steps, { label: '在 Codex 里输入 /hooks 信任', command: '/hooks', terminal: false }] : steps;
}

/** Two-node chain: 已安装 → 已收到事件. */
function HookChain({ name, h }: { name: string; h: Hook }) {
  return (
    <NodeChain
      label={`${name} 接入`}
      size="compact"
      nodes={[
        { label: '已安装', state: h.installed ? 'done' : 'broken', sub: h.installed == null ? '无法检查' : h.installed ? undefined : '没装' },
        { label: '已收到事件', state: h.last_at ? 'done' : 'todo', sub: h.last_at ? formatAgo(clock() - h.last_at) : '还没有' },
      ]}
    />
  );
}

function tag(h: Hook) {
  if (h.installed == null) return <StatusLamp size="sm" state="idle" label="无法检查" />;
  if (!h.installed) return <StatusLamp size="sm" state="idle" label="未接入" />;
  return h.last_at ? <StatusLamp size="sm" state="ok" label={`已接入 │ ${formatAgo(clock() - h.last_at)}收到事件`} /> : <StatusLamp size="sm" state="waiting" label="已安装，没收到事件" />;
}

/** Claude Code and Codex hooks under 编码会话: state from `/diag/state`, the install steps while one is not hooked up, unbinding through agentd. */
export function HookRows() {
  const { model, ro, diag, reload } = useSettings();
  const bridge = getBridge();
  const [installer, setInstaller] = useState<Step[] | null>(null);
  useEffect(() => {
    let live = true;
    void bridge.app.info().then((i) => live && setInstaller(i.hookInstallSteps));
    return () => {
      live = false;
    };
  }, [bridge]);
  const missing = installer?.length === 0;
  const run = (s: Step) =>
    void runInTerminal(bridge, s.command).then(
      (how) => model.notify({ message: how === 'ran' ? `已在终端运行：${s.label}` : '命令已复制，粘到终端运行' }),
      () => model.notify({ message: '这个外壳还不能打开终端，命令也没复制成', severity: 'warning' }),
    );
  const copy = (s: Step) =>
    void bridge.clipboard.writeText(s.command).then(
      () => model.notify({ message: `已复制 ${s.command}` }),
      () => model.notify({ message: '没复制成', severity: 'warning' }),
    );
  const unbind = (id: 'claude' | 'codex', name: string) =>
    model.ask({
      title: `解绑 ${name}？`,
      note: '只移除 Agentic Complex 的 hooks，不留副本；会话记录保留。',
      confirmLabel: '解绑',
      onConfirm: () =>
        disconnectHooks(id).then(
          () => {
            reload('diag');
            model.notify({ message: `已解绑 ${name}` });
          },
          (e) => model.notify({ message: `没能解绑 ${name}：${failure(e).text}`, severity: 'danger', persistent: true }),
        ),
    });

  return (
    <>
      {TOOLS.map(({ id, row, name }) => {
        const h = diag.hooks?.[id] ?? null;
        const waiting = id === 'codex' && h?.installed && !h.last_at;
        return (
          <SetRow
            key={id}
            id={row}
            title={name}
            desc={h == null ? '—' : waiting ? '在 Codex 里跑一次任务后再检测' : '新会话会出现在 任务 › 编码会话'}
            descTone={waiting ? 'attention' : undefined}
            indent
            control={
              <>
                {h && tag(h)}
                {h?.installed && <Btn onClick={() => unbind(id, name)}>解绑</Btn>}
                <Btn onClick={() => reload('diag')}>重新检测</Btn>
              </>
            }
          >
            {h && !(h.installed && h.last_at) && <HookChain name={name} h={h} />}
            {h && (h.installed === false || (h.installed == null && !h.last_at)) && (
              <ol className={styles.files} aria-label={`${name} 接入步骤`}>
                {installSteps(installer ?? [], id).map((s, i) => (
                  <li key={s.label}>
                    <span className={styles.t2} title={s.command || undefined}>
                      {i + 1}. {s.label}
                    </span>
                    {s.terminal ? (
                      <Btn go disabled={ro || !s.command} onClick={() => run(s)}>
                        在终端运行
                      </Btn>
                    ) : (
                      <Btn onClick={() => copy(s)}>复制</Btn>
                    )}
                  </li>
                ))}
                {missing && <li className={styles.t2}>这个版本没有提供安装命令</li>}
              </ol>
            )}
          </SetRow>
        );
      })}
    </>
  );
}
