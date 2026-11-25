import { useEffect, useState } from 'react';
import { BracketMeter, CountdownRing } from '../../charts';
import { formatDuration, type Cooldown, type WireDiagGate } from '../../domain';
import { secToMs } from '../../domain/units';
import { useDevMode } from '../../shell/devMode';
import { navigate, type NavTarget } from '../../shell/nav';
import { Btn } from '../../ui';
import { MicroLabel, StatusLamp } from '../../ui/game';
import { readProactiveStats, type ProactiveStats } from '../settings/api';
import styles from './State.module.css';

export interface GatePanelProps {
  cooldowns: Cooldown[];
  gate: WireDiagGate;
}

const STATS_REFRESH_MS = 60_000;
/** The row that turns proactive speech back on. */
export const SPEAK_WHEN: NavTarget = { page: 'settings', group: 'speak', item: 'speakWhen' };

/** What currently holds proactive speech back (gate switches and the shared cooldown); empty when nothing does. */
export function gateHolds(g: WireDiagGate): string[] {
  const out: string[] = [];
  if (!g.enabled) out.push('主动发言已关闭');
  if (g.meeting) out.push('会议中');
  if (g.fullscreen) out.push('前台全屏');
  if (g.user_speaking) out.push('用户正在语音输入');
  if (g.cross_cooldown_s > 0) out.push(`处于发言冷却中，${formatDuration(secToMs(g.cross_cooldown_s))} 后可再次发言`);
  return out;
}

const pct = (n: number, total: number): string => (total > 0 ? `${Math.round((n / total) * 100)}%` : '—');

/** One lamp per gate condition, one ring per cooling kind (agentd lists only those), today's meter with «被拦 N». */
export function GatePanel({ cooldowns, gate }: GatePanelProps) {
  const dev = useDevMode();
  const [stats, setStats] = useState<ProactiveStats | null>(null);

  useEffect(() => {
    if (!dev) {
      setStats(null);
      return;
    }
    let live = true;
    const load = () => {
      readProactiveStats(7).then(
        (r) => live && setStats(r ?? {}),
        () => {},
      );
    };
    load();
    const id = window.setInterval(load, STATS_REFRESH_MS);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [dev]);

  const entries = stats ? Object.entries(stats) : [];
  const shown = entries.reduce((s, [, v]) => s + v.shown, 0);
  const replied = entries.reduce((s, [, v]) => s + v.replied, 0);
  const accepted = entries.reduce((s, [, v]) => s + v.accepted, 0);
  const responded = replied + accepted;
  const conds: Array<[string, boolean, string, string]> = [
    ['主动发言开关', gate.enabled, '已开启', '已关闭'],
    ['会议状态', !gate.meeting, '无', '会议中'],
    ['前台全屏', !gate.fullscreen, '否', '全屏中'],
    ['语音输入状态', !gate.user_speaking, '无', '语音输入中'],
  ];

  return (
    <div className={styles.rows}>
      {conds.map(([k, ok, yes, no]) => (
        <div key={k} className={styles.gr}>
          <span className={styles.k}>{k}</span>
          <StatusLamp state={ok ? 'ok' : 'warning'} label={ok ? yes : no} />
          {k === '主动发言开关' && !ok && (
            <Btn size="sm" go onClick={() => navigate(SPEAK_WHEN)}>
              前往设置
            </Btn>
          )}
        </div>
      ))}
      {cooldowns.map((c) => (
        <div key={c.key} className={styles.gr} title={`${c.label}冷却 │ 还剩 ${formatDuration(secToMs(c.left_s))}`}>
          <span className={styles.k}>{c.label}冷却</span>
          <span className={styles.v}>
            <CountdownRing secondsLeft={c.left_s} windowS={c.total_s} size="mini" label={`${c.label}冷却`} />
          </span>
        </div>
      ))}
      <div className={styles.gr}>
        <span className={styles.k}>今天主动发言</span>
        <span className={styles.v}>
          <BracketMeter value={gate.today} max={gate.daily_limit} size="sm" label="今日主动发言" />
          <span className={styles.dim}>
            被拦 <b className="num">{gate.blocked_today}</b>
          </span>
        </span>
      </div>
      {/* agentd sends the configured periods, not whether one is on now. */}
      <div className={styles.gr}>
        <span className={styles.k}>免打扰时段</span>
        <span className={styles.v}>{gate.quiet_hours.length > 0 ? '已设置' : '未设置'}</span>
      </div>
      {dev && stats != null && (
        <>
          <MicroLabel>LAST 7 DAYS</MicroLabel>
          <span className={styles.dim}>
            近 7 天主动 <span className="num">{shown}</span> 条 │ 有回应 <span className="num">{responded}</span>（<span className="num">{pct(responded, shown)}</span>） │ 采纳建议{' '}
            <span className="num">{accepted}</span>
          </span>
          {entries.length > 0 && (
            <table className={styles.st7} aria-label="近 7 天主动发言回应">
              <thead>
                <tr>
                  <th scope="col">触发</th>
                  <th scope="col">主动</th>
                  <th scope="col">有回应</th>
                  <th scope="col">采纳建议</th>
                  <th scope="col">回应率</th>
                </tr>
              </thead>
              <tbody>
                {entries.map(([trigger, v]) => (
                  <tr key={trigger}>
                    <td>{trigger}</td>
                    <td className="num">{v.shown}</td>
                    <td className="num">{v.replied + v.accepted}</td>
                    <td className="num">{v.accepted}</td>
                    <td className="num">{pct(v.replied + v.accepted, v.shown)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
