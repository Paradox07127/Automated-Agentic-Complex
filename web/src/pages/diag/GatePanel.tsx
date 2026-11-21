import { useEffect, useState } from 'react';
import { BracketMeter, CountdownRing } from '../../charts';
import { formatDuration, type Cooldown, type WireDiagGate } from '../../domain';
import { secToMs } from '../../domain/units';
import { useDevMode } from '../../shell/devMode';
import { readProactiveStats, type ProactiveStats } from '../settings/api';
import styles from './State.module.css';

export interface GatePanelProps {
  cooldowns: Cooldown[];
  gate: WireDiagGate;
}

const STATS_REFRESH_MS = 60_000;

/** What currently holds proactive speech back (gate switches and the shared cooldown); empty when nothing does. */
export function gateHolds(g: WireDiagGate): string[] {
  const out: string[] = [];
  if (!g.enabled) out.push('主动发言已关');
  if (g.meeting) out.push('开会中');
  if (g.fullscreen) out.push('前台全屏');
  if (g.user_speaking) out.push('你在说话');
  if (g.cross_cooldown_s > 0) out.push(`刚说过话，${formatDuration(secToMs(g.cross_cooldown_s))} 后可再说`);
  return out;
}

const pct = (n: number, total: number): string => (total > 0 ? `${Math.round((n / total) * 100)}%` : '—');

/** What holds speech back, one cooldown ring per cooling kind (agentd lists only those), today's meter with «被拦 N». */
export function GatePanel({ cooldowns, gate }: GatePanelProps) {
  const holds = gateHolds(gate);
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

  return (
    <div className={styles.gate}>
      <span className={styles.panelHead}>主动发言闸门</span>
      <span className={styles.gateRow}>{holds.length ? <span className={styles.t2}>{holds.join(' │ ')}</span> : <span className={styles.okText}>✓ 没有拦着的条件</span>}</span>
      {/* agentd sends the configured periods, not whether one is on now. */}
      {gate.quiet_hours.length > 0 && <span className={styles.t3}>已设免打扰时段</span>}
      {cooldowns.map((c) => (
        <span key={c.key} className={styles.gateRow} title={`${c.label}冷却 │ 还剩 ${formatDuration(secToMs(c.left_s))}`}>
          <span className={styles.t3}>{c.label}</span>
          <CountdownRing secondsLeft={c.left_s} windowS={c.total_s} size="mini" label={`${c.label}冷却`} />
        </span>
      ))}
      <span className={styles.gateRow}>
        <span className={styles.t3}>今日主动发言</span>
        <BracketMeter value={gate.today} max={gate.daily_limit} size="sm" label="今日主动发言" />
        <span className={styles.t2}>
          被拦 <span className="num">{gate.blocked_today}</span>
        </span>
      </span>
      {dev && stats != null && (
        <>
          <span className={`${styles.gateLine} ${styles.t2}`}>
            近 7 天主动 <span className="num">{shown}</span> 条 │ 有回应 <span className="num">{responded}</span>（<span className="num">{pct(responded, shown)}</span>） │ 点了建议{' '}
            <span className="num">{accepted}</span>
          </span>
          {entries.length > 0 && (
            <table className={styles.statTable} aria-label="近 7 天主动发言回应">
              <thead>
                <tr>
                  <th scope="col">触发</th>
                  <th scope="col">主动</th>
                  <th scope="col">有回应</th>
                  <th scope="col">点了建议</th>
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
