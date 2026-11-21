import { CountdownRing } from '../../charts';
import { formatDuration, type Health } from '../../domain';
import { voiceText } from '../../domain/voiceState';
import { useCountdown } from '../approval/useCountdown';
import styles from './HealthChain.module.css';

type NodeKey = 'agentd' | 'runtime' | 'avatar' | 'voice';
/** idle: voice off, or not known to work yet (unknown / probing / cold); not a problem. */
type NodeSt = 'done' | 'broken' | 'unreachable' | 'idle';

/** 链路健康：agentd → 内核 / 宿主（角色）/ 语音三条支路；内核断开只把内核支路画成不可达；节点下写读数。 */
export interface HealthChainProps {
  /** 健康数据 */
  health: Health;
  /** 当前时间，算 agentd 在线时长 */
  now: number;
  /** 总览右栏 / 诊断通栏 / 菜单栏，默认 card */
  layout?: 'card' | 'wide' | 'desk';
  /** 点节点跳到修复处 */
  onNode?: (node: 'agentd' | 'runtime' | 'avatar' | 'voice') => void;
  /** The voice's「重新连接」; without it that button goes to the node like the others. */
  onVoiceReset?: () => void;
}

interface ChainNode {
  key: NodeKey;
  label: string;
  st: NodeSt;
  sub: string;
  fix: string;
  backoff?: number;
}

const ST_TEXT: Record<NodeSt, string> = { done: '在线', broken: '断开', unreachable: '不可达', idle: '待定' };
const VOICE_ST: Record<Health['voice']['state'], NodeSt> = { ready: 'done', unreachable: 'broken', off: 'idle', unknown: 'idle', probing: 'idle', cold: 'idle' };
const KERNEL_ERR: Record<string, string> = { not_authenticated: '未登录', not_installed: '未安装', unsupported: '版本不可用' };

function nodesOf(h: Health, now: number, wide: boolean, retryLeft: number | null): [ChainNode, ChainNode[]] {
  const up = h.agentd.up;
  const child = h.avatar.child;
  const root: ChainNode = { key: 'agentd', label: wide ? '后台服务' : '后台', st: up ? 'done' : 'broken', sub: up ? formatDuration(now - h.agentd.started_at) : '没有响应', fix: '重启后台服务' };
  const branches: ChainNode[] = [
    { key: 'runtime', label: wide ? '角色内核' : '内核', st: h.runtime.ready ? 'done' : 'broken', sub: h.runtime.ready ? h.runtime.name : (KERNEL_ERR[h.runtime.error ?? ''] ?? h.runtime.error ?? '不可用'), fix: '前往设置重新检测' },
    typeof child === 'object'
      ? { key: 'avatar', label: wide ? '桌面角色' : '角色', st: 'broken', sub: `${child.backoff} s 后重启`, fix: '查看进程', backoff: child.backoff }
      : { key: 'avatar', label: wide ? '桌面角色' : '角色', st: child === 'running' ? 'done' : 'broken', sub: child === 'running' ? (h.avatar.fps != null ? `${h.avatar.fps} fps` : '运行中') : '已停止', fix: '重启角色' },
    { key: 'voice', label: '语音', st: VOICE_ST[h.voice.state], sub: voiceText(h.voice.state, retryLeft), fix: '重新连接' },
  ];
  // agentd down: every branch is unreachable, not broken on its own.
  return [root, up ? branches : branches.map((b) => ({ ...b, st: 'unreachable' as const, sub: '不可达', backoff: undefined }))];
}

export function HealthChain({ health, now, layout = 'card', onNode, onVoiceReset }: HealthChainProps) {
  const wide = layout === 'wide';
  const retryLeft = useCountdown(health.voice.retryAfterS);
  const [root, branches] = nodesOf(health, now, wide, retryLeft);
  const bad = [root, ...branches].filter((n) => n.st === 'broken');
  const node = (n: ChainNode) => {
    const inner = (
      <>
        <span className={styles.dot} data-st={n.st} aria-hidden="true">
          {n.st === 'broken' ? '✕' : ''}
        </span>
        <span className={styles.label}>{n.label}</span>
        {n.backoff ? <CountdownRing secondsLeft={n.backoff} windowS={n.backoff} size="mini" label="后重启" /> : <span className={styles.sub}>{n.sub}</span>}
      </>
    );
    const aria = `${n.label}：${ST_TEXT[n.st]}，${n.sub}`;
    return onNode ? (
      <button type="button" className={styles.node} data-st={n.st} aria-label={aria} title={`${n.label} │ ${n.sub}\n点击去处理`} onClick={() => onNode(n.key)}>
        {inner}
      </button>
    ) : (
      <span className={styles.node} data-st={n.st} aria-label={aria}>
        {inner}
      </span>
    );
  };
  return (
    <div data-stub="HealthChain" data-layout={layout} className={styles.root}>
      <div className={styles.chain} role="list" aria-label="运行链路：后台服务分三条支路">
        <span className={styles.root0} role="listitem">
          {node(root)}
        </span>
        <span className={styles.stem} data-st={root.st} aria-hidden="true" />
        <span className={styles.branches}>
          {branches.map((b) => (
            <span key={b.key} role="listitem" className={styles.branch} data-st={b.st}>
              <i className={styles.line} aria-hidden="true" />
              {node(b)}
            </span>
          ))}
        </span>
      </div>
      {layout !== 'desk' && (
        <div className={styles.foot}>
          {bad.length === 0 ? (
            <span className={styles.ok}>✓ 全部在线</span>
          ) : (
            bad.slice(0, 2).map((n) => (
              <span key={n.key} className={styles.issue}>
                <span className={styles.bad}>
                  ✕ {n.label}
                  {n.sub}
                </span>
                <span className={styles.t3}>{n === root ? '三条支路都不可达' : '只影响这一支'}</span>
                {onNode && (
                  <button type="button" className={styles.fix} onClick={() => (n.key === 'voice' && onVoiceReset ? onVoiceReset() : onNode(n.key))}>
                    {n.fix}
                  </button>
                )}
              </span>
            ))
          )}
          <span className={styles.tunnel}>隧道 │ 未配置</span>
        </div>
      )}
    </div>
  );
}
