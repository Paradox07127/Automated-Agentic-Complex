import { pathParts, type RuntimeInfo } from '../../domain';
import { NodeChain, type ChainNode } from '../../charts';
import { Btn } from '../../ui';
import styles from './KernelChain.module.css';

/** 内核就绪链：已安装 → 入口可用 → 已登录；版本仅供诊断，工具边界在实际执行时核验。 */
export interface KernelChainProps {
  /** 当前内核 */
  runtime: RuntimeInfo;
  /** 可改用的已登录内核 */
  alternative?: RuntimeInfo | null;
  /** 设置页 / 桌面内核卡 / 横幅与新建弹窗里的小链，默认 main */
  surface?: 'main' | 'desk' | 'inline';
  /** 复制恢复命令 */
  onCopy?: (command: string) => void;
  /** 在终端运行（经原生桥） */
  onRunInTerminal?: (command: string) => void;
  /** 改用另一个内核 */
  onSwitch?: (id: string) => void;
  /** 重新检测 */
  onRecheck?: () => void;
}

const STEPS = ['已安装', '入口可用', '已登录'] as const;

/** Index of the first missing step, or -1 when the kernel is ready. A backend without login (authenticated null) never breaks there. */
export function kernelBreak(r: RuntimeInfo): number {
  // Pi ships with the app and ACP is available when agentd finds an agent or a launcher; neither has a CLI path.
  const installed = r.id === 'pi' || r.id === 'acp' ? r.available === true : !!r.path;
  return [installed, r.entry_supported && r.available !== false, r.authenticated !== false].indexOf(false);
}

/** Nodes up to the break are done, the break is ✕, everything after it is unreachable. */
export function kernelNodes(r: RuntimeInfo): ChainNode[] {
  const bi = kernelBreak(r);
  const subs = [r.path ? pathParts(r.path).slice(-2).join('/') : r.id === 'pi' && r.available ? '随应用的 SDK' : '没找到', r.version ?? '—', r.authenticated == null ? '不适用' : r.authenticated ? '已登录' : '未登录'];
  return STEPS.map((label, i) => {
    const state = bi < 0 || i < bi ? 'done' : i === bi ? 'broken' : 'unreachable';
    return { label, state, sub: state === 'unreachable' ? '不可达' : subs[i], tip: `${label} │ ${subs[i]}` };
  });
}

const REASON = ['本机没有发现可执行文件，安装后重新检测', '角色入口不可用，请更新 CLI 后重新检测'];

export function KernelChain({ runtime, alternative = null, surface = 'main', onCopy, onRunInTerminal, onSwitch, onRecheck }: KernelChainProps) {
  const bi = kernelBreak(runtime);
  const cmd = bi === 2 ? (runtime.login_command ?? null) : null;
  const size = surface === 'desk' ? 'desk' : surface === 'inline' ? 'compact' : 'main';
  return (
    <div data-stub="KernelChain" data-surface={surface} className={styles.root} aria-label={`${runtime.name} 就绪链`}>
      <NodeChain nodes={kernelNodes(runtime)} label={`${runtime.name} 就绪状态`} size={size} />
      {bi >= 0 && (
        <div className={styles.fix}>
          {cmd ? (
            <>
              <span className={styles.lead}>在终端执行</span>
              <code className={styles.cmd}>{cmd}</code>
              <Btn size="sm" variant="ghost" icon="copy" onClick={() => onCopy?.(cmd)}>
                复制
              </Btn>
              <Btn size="sm" variant="ghost" icon="ext" onClick={() => onRunInTerminal?.(cmd)}>
                在终端运行
              </Btn>
            </>
          ) : (
            <span className={styles.reason}>{bi === 2 ? '没有登录命令，请按内核文档登录后重新检测' : REASON[bi]}</span>
          )}
          {onRecheck && (
            <Btn size="sm" variant="ghost" icon="refresh" onClick={onRecheck}>
              重新检测
            </Btn>
          )}
          {alternative && (
            <Btn size="sm" variant="quiet" onClick={() => onSwitch?.(alternative.id)}>
              改用 {alternative.name}
            </Btn>
          )}
        </div>
      )}
    </div>
  );
}
