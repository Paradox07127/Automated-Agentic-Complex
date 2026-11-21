import { useState } from 'react';
import { getBridge } from '../../bridge';
import { NodeChain, type ChainNode } from '../../charts';
import { Btn, Plate } from '../../ui';
import { Pip } from './Bits';
import { commandLabel, pad2, shortCommand, type Hook } from './copy';
import styles from './Steps.module.css';

/** Installed → received an event; agentd's `connected` is installed or heard from. */
function chain(h: Hook): ChainNode[] {
  if (!h.connected) return [{ label: '已安装', state: 'broken', sub: '未安装' }, { label: '已收到事件', state: 'todo' }];
  return [
    { label: '已安装', state: 'done' },
    h.lastEvent ? { label: '已收到事件', state: 'done', sub: `最后 ${h.lastEvent}` } : { label: '已收到事件', state: 'waiting', sub: '还没有' },
  ];
}

function HookPlate({ h }: { h: Hook }) {
  const [copied, setCopied] = useState<number | null>(null);
  const copy = (i: number, cmd: string) => {
    void getBridge()
      .clipboard.writeText(cmd)
      .then(() => setCopied(i), () => setCopied(null));
  };
  return (
    <div className={styles.hook} data-hook={h.id} data-off={!h.connected || undefined}>
      <Plate label={h.name}>
        <div className={styles.hookHead}>
          <b className={styles.hookName}>{h.name}</b>
          <span className={styles.hookChain}>
            <NodeChain label={`${h.name} 接入`} nodes={chain(h)} />
          </span>
          <span className={styles.sp} />
          <Pip kind={h.connected ? 'ok' : 'attention'} label={h.connected ? '已接入' : '未接入'} />
        </div>
        {h.connected ? (
          <div className={styles.cap}>
            {h.lastEvent ? (
              <>
                最后收到事件 <span className={styles.num}>{h.lastEvent}</span> │ 新会话显示在 任务 页
              </>
            ) : (
              '已安装，打开一次会话后显示收到的事件'
            )}
          </div>
        ) : (
          <>
            {h.installHint && <div className={styles.cap}>{h.installHint}</div>}
            {h.installSteps.length > 0 && (
              <ol className={styles.cmds}>
                {h.installSteps.map((cmd, i) => (
                  <li key={i}>
                    <span className={`${styles.cmdNo} ${styles.num}`}>{pad2(i + 1)}</span>
                    <span className={styles.cmdLabel}>{commandLabel(cmd)}</span>
                    <code className={styles.code} title={cmd} data-selectable="">
                      {shortCommand(cmd)}
                    </code>
                    <Btn size="sm" variant="ghost" icon={copied === i ? 'check' : 'copy'} onClick={() => copy(i, cmd)}>
                      {copied === i ? '已复制' : '复制'}
                    </Btn>
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </Plate>
    </div>
  );
}

/** Step 3: one plate per coding tool, then 重新检查 (re-reads `/diag/state` through the guide). */
export function HooksStep({ hooks, checkedAt, rechecking, onRecheck }: { hooks: Hook[]; checkedAt: string; rechecking: boolean; onRecheck: () => void }) {
  return (
    <div className={styles.hooks}>
      {hooks.map((h) => (
        <HookPlate key={h.id} h={h} />
      ))}
      <div className={styles.recheck}>
        <Btn size="sm" variant="ghost" icon="refresh" loading={rechecking} onClick={onRecheck}>
          重新检查
        </Btn>
        {checkedAt && (
          <span className={styles.cap}>
            上次检查 <span className={styles.num}>{checkedAt}</span>
          </span>
        )}
        <span className={styles.sp} />
        <span className={styles.cap}>不接入时，对话和观察照常可用</span>
      </div>
    </div>
  );
}
