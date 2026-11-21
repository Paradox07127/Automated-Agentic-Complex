import { useCallback, useEffect, useState } from 'react';
import { getBridge, type BridgeError } from '../../bridge';
import { get, put } from '../../bridge/agentd';
import { NodeChain } from '../../charts';
import { fromRuntimePublic } from '../../domain';
import type { WireInstalledRuntime, WireRuntimePublic } from '../../domain/wire';
import { kernelBreak, kernelNodes } from '../../features/kernel';
import { Btn, Plate } from '../../ui';
import { runtimeBody } from '../settings/fields';
import { Loading, Pip } from './Bits';
import styles from './Steps.module.css';

const NAME: Record<WireRuntimePublic['backend'], string> = { codex: 'Codex', pi: 'Pi', acp: 'ACP', claude: 'Claude Code' };

/** A local CLI agentd's `_auto_select` would take: protocol entry and logged in. */
const usable = (r: WireInstalledRuntime) => r.entry_supported && r.authenticated;

/**
 * Step 3's 角色内核 block over `GET /character/runtime?refresh=1`. agentd connects a logged-in local CLI by itself, so
 * keeping its pick sends nothing; with none logged in, the CLI's own login runs in Terminal after a click and the native confirm.
 */
export function KernelBlock({ onUseApiKey }: { onUseApiKey?: () => void } = {}) {
  const [wire, setWire] = useState<WireRuntimePublic | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const read = useCallback(() => {
    setBusy(true);
    return get<WireRuntimePublic>('/character/runtime?refresh=1')
      .then(
        (w) => {
          setWire(w);
          setFailed(false);
        },
        () => setFailed(true),
      )
      .finally(() => setBusy(false));
  }, []);

  useEffect(() => {
    void read();
    // Back from Terminal after the login.
    const again = () => void read();
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [read]);

  const login = (cmd: string) =>
    void getBridge()
      .open.runInTerminal(cmd)
      .then(
        () => setNote('登录完成后点「重新检测」'),
        (e: Partial<BridgeError>) => setNote(e.code === 'declined' ? null : (e.detail ?? '没能打开终端')),
      );
  const use = (w: WireRuntimePublic, id: WireInstalledRuntime['backend']) => {
    setNote(null);
    void put('/character/runtime', runtimeBody(w, { kernel: id })).then(read, (e: Error) => setNote(e.message));
  };

  const rows = wire ? wire.installed_runtimes.filter((r) => r.runtime_source !== 'bundled') : [];
  const current = wire && (rows.find((r) => r.backend === wire.backend) ?? rows[0]);
  const info = wire && current ? fromRuntimePublic(wire).runtimes.find((r) => r.id === current.backend) : undefined;
  const other = wire?.ready ? rows.find((r) => r.backend !== wire.backend && usable(r)) : undefined;
  const cmd = info && kernelBreak(info) === 2 && typeof current?.login_command === 'string' ? current.login_command : null;
  const none = wire && !wire.ready && !rows.some(usable);

  let body;
  if (!wire) body = failed ? <div className={styles.cap}>读不到角色内核的状态</div> : <Loading tip="正在查找本机的 Claude Code 和 Codex…" />;
  else if (wire.ready)
    body = (
      <div className={styles.cap}>
        已连接 {NAME[wire.backend]}
        {wire.auth_source === 'existing_login' ? '（沿用本机登录）' : ''}
      </div>
    );
  else if (!current) body = <div className={styles.cap}>本机没有找到 Claude Code 或 Codex。安装并登录其中一个后点「重新检测」，或在 设置 › pi 账号与凭据 填 API key</div>;

  return (
    <div className={`${styles.hook} ${styles.kernel}`} data-kernel="" data-off={(wire && !wire.ready) || undefined}>
      <Plate label="角色内核">
        <div className={styles.hookHead}>
          <b className={styles.hookName}>角色内核</b>
          {info && (
            <span className={styles.hookChain}>
              <NodeChain label={`${NAME[info.id]} 就绪状态`} nodes={kernelNodes(info)} size="compact" />
            </span>
          )}
          <span className={styles.sp} />
          {wire && <Pip kind={wire.ready ? 'ok' : 'attention'} label={wire.ready ? '已连接' : '未连接'} />}
        </div>
        {body}
        {cmd && <code className={styles.code} title={cmd} data-selectable="">{cmd}</code>}
        <div className={styles.recheck}>
          {cmd && (
            <Btn size="sm" variant="secondary" icon="ext" onClick={() => login(cmd)}>
              在终端登录
            </Btn>
          )}
          {none && onUseApiKey && (
            <Btn size="sm" variant="secondary" onClick={onUseApiKey}>
              改填 API Key（DeepSeek / OpenAI 兼容）
            </Btn>
          )}
          {(wire ? !wire.ready : failed) && (
            <Btn size="sm" variant="ghost" icon="refresh" loading={busy} onClick={() => void read()}>
              重新检测
            </Btn>
          )}
          {wire && other && (
            <Btn size="sm" variant="quiet" onClick={() => use(wire, other.backend)}>
              改用 {NAME[other.backend]}
            </Btn>
          )}
          {note && <span className={styles.cap}>{note}</span>}
        </div>
      </Plate>
    </div>
  );
}
