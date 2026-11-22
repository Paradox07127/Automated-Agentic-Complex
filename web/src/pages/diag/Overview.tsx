import type { ReactNode } from 'react';
import type { AppInfo } from '../../bridge/protocol';
import { formatClock, formatDuration, type Health, type VisualStateKey, type WireDiagState, type WireRuntimePublic } from '../../domain';
import { secToMs } from '../../domain/units';
import { voiceSource, voiceText } from '../../domain/voiceState';
import { Btn, ErrBar, SecHead, Skel } from '../../ui';
import { Barcode, DeviceRow, ReadTick, type DeviceRowProps } from '../../ui/game';
import type { NavTarget } from '../overview/nav';
import { gateHolds } from './GatePanel';
import { cpuParts, memParts } from './procText';
import { CAP_REASON, LIMITS, lampOf, levelOf, ttsText, type DiagIssue, type DiagProcess } from './status';
import styles from './Diag.module.css';

export type DiagTab = 'overview' | 'proc' | 'render' | 'flow' | 'state';

/** /capabilities items that land on the 角色内核 row; `voice` lands on the 语音 row, the rest go to the bar above. */
const KERNEL_CAPS = new Set(['generation', 'mouth', 'personal_agent']);

/** The last hour of the turn pipeline, for its run row. */
export interface FlowBrief {
  turns: number;
  fails: number;
  /** 「语音」失败 2 次: the node with most failures. */
  worst: { label: string; n: number } | null;
  approvals: number;
}

export interface OverviewProps {
  loading: boolean;
  health: Health | null;
  /** agentd is gone: the time of the last data (0 when nothing was read). */
  staleAt: number | null;
  now: number;
  procs: DiagProcess[] | null;
  runtime: WireRuntimePublic | null;
  d: WireDiagState | null;
  issues: DiagIssue[];
  screenOff: boolean;
  textOnly: boolean;
  fps: number | null;
  p95: number | null;
  /** Seconds of the last minute whose P95 frame time went over budget. */
  over: number;
  renderWhy: string;
  flow: FlowBrief;
  source: AppInfo | null;
  highlight: string | null;
  go: (to: NavTarget) => void;
  onTab: (tab: DiagTab) => void;
  onRestart: (target: 'agentd' | 'avatar') => void;
  onVoiceReset: () => void;
}

interface Row extends DeviceRowProps {
  key: string;
}

/** 总览：one row per part (lamp, word, reason, fix, where to look next), dependencies as a tree, then the pipeline and proactive speech in one line each. */
export function Overview(p: OverviewProps) {
  if (p.loading)
    return (
      <div className={styles.view}>
        <SecHead title="链路" micro="SERVICE DEVICE LINK" />
        <Skel rows={5} shape="cards" />
      </div>
    );
  const { link, run } = rowsOf(p);
  const gone = p.staleAt != null;
  const others = p.issues.filter((i) => !KERNEL_CAPS.has(i.id) && i.id !== 'voice');
  return (
    <div className={styles.view}>
      {gone && <ErrBar message="后台服务没有响应" staleAt={p.staleAt || undefined} extra={<RestartAgentd onClick={() => p.onRestart('agentd')} />} />}
      {p.screenOff && (
        <ErrBar
          tone="warning"
          message={p.textOnly ? '屏幕录制没有授权 │ 观察只读取窗口文字，不截图' : '屏幕录制没有授权'}
          extra={
            <Btn size="sm" onClick={() => p.go({ page: 'settings', group: 'perm', item: 'screenRecording' })}>
              前往设置
            </Btn>
          }
        />
      )}
      {others.map((i) => (
        <ErrBar
          key={i.id}
          tone="warning"
          message={`${i.title} │ ${i.detail}`}
          extra={
            i.to ? (
              <Btn size="sm" onClick={() => i.to && p.go(i.to)}>
                前往设置
              </Btn>
            ) : undefined
          }
        />
      ))}
      <SecHead title="链路" count={link.length} micro="SERVICE DEVICE LINK" />
      <div className={styles.board}>{link.map((r) => rowEl(r, p.highlight))}</div>
      <SecHead title="运行" count={run.length} micro="RUNTIME 1H" />
      <div className={styles.board}>{run.map((r) => rowEl(r, p.highlight))}</div>
      {p.source && <Source info={p.source} />}
    </div>
  );
}

/** The only yellow button of a view: agentd is gone. */
export function RestartAgentd({ onClick }: { onClick: () => void }) {
  return (
    <Btn size="sm" variant="primary" icon="refresh" onClick={onClick}>
      重启后台服务
    </Btn>
  );
}

// DeviceRow takes no attributes of its own, so the landing target sits on a wrapper.
function rowEl({ key, ...r }: Row, highlight: string | null) {
  return (
    <div key={key} className={styles.slot} data-nav-target={`proc-${key}`} data-row={key}>
      <DeviceRow {...r} highlight={highlight === key} />
    </div>
  );
}

const tick = (value: string, unit: string | undefined, label: string, tone: 'main' | 'ink' | 'warn' | 'bad' = 'main', opt = false): ReactNode =>
  opt ? (
    <span className={styles.opt} key={label}>
      <ReadTick value={value} unit={unit} label={label} tone={tone} />
    </span>
  ) : (
    <ReadTick key={label} value={value} unit={unit} label={label} tone={tone} />
  );

/** The rows' content from the health, process and /diag/state reads. */
export function rowsOf(p: OverviewProps): { link: Row[]; run: Row[] } {
  const gone = p.staleAt != null;
  const at = p.staleAt ? formatClock(p.staleAt) : null;
  const proc = (k: string) => p.procs?.find((x) => x.key === k) ?? null;
  const agentd = proc('agentd');
  const avatar = proc('avatar');
  const tunnel = proc('tunnel');
  const h = p.health;
  const caps = (ids: (id: string) => boolean) => p.issues.filter((i) => ids(i.id));

  const [cpuV, cpuU] = gone ? ['—', undefined] : cpuParts(agentd?.cpu_percent ?? null);
  const [memV, memU] = gone ? ['—', undefined] : memParts(agentd?.memory_mb ?? null);
  const agentdRow: Row = {
    key: 'agentd',
    icon: 'data',
    name: '后台服务',
    sub: agentd?.pid != null ? `agentd │ pid ${agentd.pid}` : 'agentd',
    state: gone ? 'failed' : agentd ? lampOf(agentd) : 'idle',
    stateLabel: gone ? '没有响应' : (agentd?.status_text ?? '未知'),
    why: gone ? (at ? `${at} 之后没有回应` : '读不到后台') : h?.agentd.up && h.agentd.started_at ? `运行 ${formatDuration(p.now - h.agentd.started_at)} │ 连接正常` : '连接正常',
    reads: [tick(cpuV, cpuU, 'CPU', levelOf(gone ? null : (agentd?.cpu_percent ?? null), LIMITS.agentd.cpu) ?? 'main'), tick(memV, memU, '内存', levelOf(gone ? null : (agentd?.memory_mb ?? null), LIMITS.agentd.mem) ?? 'ink', true)],
    go: { label: '去进程', onClick: () => p.onTab('proc') },
  };

  const kernelIssue = caps((id) => KERNEL_CAPS.has(id))[0];
  const rt = p.runtime;
  const runtimeRow: Row = {
    key: 'runtime',
    icon: 'kernel',
    name: '角色内核',
    sub: [h?.runtime.name || null, rt?.model || null].filter(Boolean).join(' │ ') || '—',
    child: 'mid',
    ...(gone
      ? { state: 'idle' as const, stateLabel: '未知', why: '后台断开，读不到内核状态', dim: true }
      : h?.runtime.ready
        ? kernelIssue
          ? { state: 'warning' as const, stateLabel: kernelIssue.title, why: kernelIssue.detail }
          : { state: 'ok' as const, stateLabel: '就绪', why: '内核检测通过' }
        : { state: 'failed' as const, stateLabel: '不可用', why: kernelIssue?.detail ?? (h?.runtime.error ? (CAP_REASON[h.runtime.error] ?? '其他原因') : '读不到内核状态') }),
    micro: 'RUNTIME',
    go: { label: '设置 › 内核', external: true, onClick: () => p.go({ page: 'settings', group: 'kernel', item: 'kernel' }) },
  };

  const p95 = (v: number | null) => (v == null ? ['—', undefined] : [v.toFixed(1), 'ms']) as [string, string | undefined];
  const backoff = avatar?.backoff_s;
  const avatarRow: Row = {
    key: 'avatar',
    icon: 'user',
    name: '桌面角色',
    sub: avatar?.pid != null ? `渲染宿主 │ pid ${avatar.pid}` : '渲染宿主',
    child: 'mid',
    state: avatar ? lampOf(avatar) : 'idle',
    stateLabel: avatar?.status_text ?? '未知',
    why:
      backoff != null
        ? `${backoff} 秒后自动重启`
        : avatar && avatar.tone === 'running'
          ? p.fps != null
            ? p.over > 0
              ? `近 60 秒 P95 超出预算 ${p.over} 秒`
              : '帧率稳定'
            : p.renderWhy
          : '桌面上看不到她',
    actions:
      avatar && avatar.tone !== 'running' && backoff == null ? (
        <Btn size="sm" variant="secondary" icon="refresh" onClick={() => p.onRestart('avatar')}>
          重启角色
        </Btn>
      ) : undefined,
    reads:
      p.fps != null
        ? [tick(String(Math.round(p.fps)), 'fps', '帧率'), tick(...p95(p.p95), 'P95', p.over > 0 ? 'warn' : 'ink', true)]
        : undefined,
    micro: 'AVATAR',
    go: { label: '去渲染', onClick: () => p.onTab('render') },
  };

  const tts = p.d?.connections.tts;
  const v = h?.voice.state ?? 'unknown';
  const voiceIssue = caps((id) => id === 'voice')[0];
  const retry = h?.voice.retryAfterS;
  const voiceRow: Row = {
    key: 'voice',
    icon: 'voice',
    name: '语音',
    sub: [tts ? (voiceSource(tts.provider) ?? 'TTS') : 'TTS', p.d?.mouth_voice.muted ? '已静音' : null].filter(Boolean).join(' │ '),
    child: tunnel ? 'mid' : 'last',
    micro: 'TTS',
    go: { label: '设置 › 说话', external: true, onClick: () => p.go({ page: 'settings', group: 'speak', item: 'tts' }) },
    ...(gone
      ? { state: 'idle' as const, stateLabel: '未知', why: '后台断开，读不到语音状态', dim: true }
      : v === 'unreachable'
        ? {
            state: 'failed' as const,
            stateLabel: '连不上',
            why: [tts?.result && tts.result !== 'complete' && tts.result !== 'cancelled' ? ttsText(tts.result) : voiceIssue?.detail, retry ? `${Math.ceil(retry)} 秒后自动再试，这段时间台词只出文字` : '台词只出文字'].filter(Boolean).join(' │ '),
            actions: (
              <Btn size="sm" variant="secondary" icon="refresh" onClick={p.onVoiceReset}>
                重新连接
              </Btn>
            ),
          }
        : { state: (v === 'ready' ? 'ok' : v === 'probing' ? 'waiting' : 'idle') as VisualStateKey, stateLabel: v === 'ready' ? '就绪' : voiceText(v, null), why: v === 'off' ? CAP_REASON.no_tts : tts?.at ? `上一句 ${formatClock(Date.parse(tts.at))}` : voiceText(v, null) }),
  };

  const tunnelRow: Row | null = tunnel
    ? {
        key: 'tunnel',
        icon: 'sync',
        name: '语音隧道',
        sub: tunnel.pid != null ? `ssh │ pid ${tunnel.pid}` : 'ssh',
        child: 'last',
        state: lampOf(tunnel),
        stateLabel: tunnel.status_text,
        why: tunnel.backoff_s != null ? `${tunnel.backoff_s} 秒后自动重启` : '转发到远端语音服务',
        micro: 'TUNNEL',
        go: { label: '去进程', onClick: () => p.onTab('proc') },
      }
    : null;

  const f = p.flow;
  const flowRow: Row = {
    key: 'flow',
    icon: 'hub',
    name: '轮次管道',
    sub: '近 1 小时',
    go: { label: '去管道', onClick: () => p.onTab('flow') },
    reads: [tick(String(f.turns), undefined, '轮'), tick(String(f.fails), undefined, '失败', f.fails ? 'bad' : 'ink', true)],
    ...(gone
      ? { state: 'idle' as const, stateLabel: at ? `停在 ${at}` : '未知', why: '后台断开，下面是最后读到的数据', dim: true }
      : f.fails > 0
        ? { state: 'warning' as const, stateLabel: '有失败', why: [f.worst ? `「${f.worst.label}」失败 ${f.worst.n} 次` : null, f.approvals ? `「审批」有 ${f.approvals} 个待处理` : null].filter(Boolean).join(' │ ') }
        : f.approvals
          ? { state: 'waiting' as const, stateLabel: '需要注意', why: `「审批」有 ${f.approvals} 个待处理` }
          : f.turns === 0
            ? { state: 'idle' as const, stateLabel: '空闲', why: '近 1 小时她没有跑过一轮' }
            : { state: 'ok' as const, stateLabel: '正常', why: '近 1 小时没有失败' }),
  };

  const g = p.d?.gate;
  const holds = g ? gateHolds(g) : [];
  const cool = g ? Object.values(g.cooldown_s).filter((s) => s > 0) : [];
  const gateRow: Row = {
    key: 'gate',
    icon: 'radio',
    name: '主动发言',
    sub: '今天',
    go: { label: '去状态', onClick: () => p.onTab('state') },
    ...(gone || !g
      ? { state: 'idle' as const, stateLabel: '未知', why: gone ? '后台断开' : '读不到闸门状态', dim: gone, micro: 'GATE' }
      : {
          state: (holds.length ? 'warning' : 'ok') as VisualStateKey,
          stateLabel: holds.length ? '暂时不说' : '可以说',
          why: holds.length ? holds.join(' │ ') : cool.length ? `没有拦着的条件 │ 冷却还剩 ${formatDuration(secToMs(Math.min(...cool)))}` : '没有拦着的条件',
          reads: [tick(String(g.today), `/${g.daily_limit}`, '今天'), tick(String(g.blocked_today), undefined, '被拦', 'ink', true)],
        }),
  };

  return { link: [agentdRow, runtimeRow, avatarRow, voiceRow, ...(tunnelRow ? [tunnelRow] : [])], run: [flowRow, gateRow] };
}

/** 运行来源: the packaged app, or a dev deployment marked in the warning colour so a test does not run the wrong build. */
function Source({ info }: { info: AppInfo }) {
  const dev = info.source === 'dev';
  return (
    <p className={styles.source} data-dev={dev || undefined}>
      <Barcode width={28} height={12} />
      {dev && (
        <span className={styles.warnMark} aria-hidden="true">
          ▲
        </span>
      )}
      <span>运行来源</span>
      {dev ? (
        <>
          <b>开发目录</b>
          <span className="num" data-selectable title={info.devCommit}>
            {info.devCommit.slice(0, 9) || '没有收据'}
          </span>
          {info.devDirty && <span>含未提交改动</span>}
        </>
      ) : (
        <>
          <b>正式打包</b>
          {info.buildGit && (
            <span className="num" data-selectable>
              {info.buildGit.slice(0, 9)}
            </span>
          )}
        </>
      )}
    </p>
  );
}
