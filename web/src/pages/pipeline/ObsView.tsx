import { formatClock, formatMs } from '../../domain';
import { isoToMs, isoToMsOrNull } from '../../domain/units';
import { GameTable, LoadBar, StatusLamp, type GameTableRow } from '../../ui/game';
import type { DiagRead } from './data';
import { None, Panel, Reads } from './Detail';
import { MODE, OBS_REASON, OBS_RESULT } from './labels';
import { OBS_ID, ObsRecord } from './ObsRecord';
import styles from './Views.module.css';

/** A wait this long fills the bar. */
const WAIT_FULL_MS = 5000;

const COLS = [
  { key: 'at', label: '时间', width: '76px' },
  { key: 'mode', label: '方式', width: '84px' },
  { key: 'res', label: '结果', width: '104px' },
  { key: 'why', label: '原因 / 用时', width: 'minmax(0, 1fr)' },
];

/** What switches observation off right now, else 开着. */
function switchWord(o: DiagRead['observation']): string {
  if (o?.off) return '观察已关闭';
  const paused = isoToMsOrNull(o?.paused_until);
  if (paused != null) return `暂停至 ${formatClock(paused)}`;
  const quiet = isoToMsOrNull(o?.quiet_until);
  if (quiet != null) return `免打扰至 ${formatClock(quiet)}`;
  return o?.meeting ? '会议中' : '已开启';
}

/** 观察：额度读数和最近的请求，一行一次，展开看那一次的详情。 */
export function ObsView({ diag, readAt, now, selected, onSelect }: { diag: DiagRead; readAt: number; now: number; selected: string | null; onSelect: (id: string) => void }) {
  const shots = diag.budget?.screenshots ?? null;
  const o = diag.observation;
  const pending = o?.pending ?? [];
  const recent = o?.recent ?? [];
  const full = shots != null && shots.limit > 0 && shots.used >= shots.limit;
  const rows: GameTableRow[] = [
    ...pending.map((p): GameTableRow => {
      const ms = p.waited_ms + Math.max(0, now - readAt);
      return {
        id: `wait-${p.request_id}`,
        tone: 'run',
        cells: {
          at: '现在',
          mode: MODE[p.mode] ?? '其他方式',
          res: <StatusLamp state="running" label="等待中" />,
          why: (
            <span className={styles.wait}>
              <LoadBar variant="port" fraction={ms / WAIT_FULL_MS} label={`已等待 ${formatMs(ms)}`} />
              <span className="num">{formatMs(ms)}</span>
            </span>
          ),
        },
      };
    }),
    ...recent.map((r): GameTableRow => {
      const res = OBS_RESULT[r.state] ?? { state: 'idle' as const, label: '其他结果' };
      return {
        id: r.request_id,
        ...(r.state === 'failed' ? { tone: 'fail' as const } : {}),
        cells: {
          at: <span className="num">{formatClock(isoToMs(r.at), { seconds: true })}</span>,
          mode: MODE[r.mode] ?? '其他方式',
          res: <StatusLamp {...res} />,
          why: r.reason ? (OBS_REASON[r.reason] ?? '其他原因') : '—',
        },
        ...(OBS_ID.test(r.request_id) ? { body: <ObsRecord id={r.request_id} /> } : {}),
      };
    }),
  ];
  return (
    <>
      <Reads
        cells={[
          { value: shots ? shots.limit - shots.used : '—', label: '今日剩余截图额度', tone: full ? 'warn' : 'main' },
          { value: shots?.reserved ?? '—', label: '已预留（待完成）' },
          { value: shots?.released ?? '—', label: '已释放（未使用，已返还）', opt: true },
          { value: switchWord(o), label: '观察开关', tone: 'ink' },
        ]}
      />
      <Panel title="最近请求" count={recent.length} micro="REQUESTS" tip="后台服务仅保留最近若干条记录；详情暂存于内存，重启服务后清空">
        {rows.length > 0 ? <GameTable label="最近请求" columns={COLS} rows={rows} selected={selected} onSelect={onSelect} /> : <None title="尚无观察请求" desc="开关与排除名单配置位于底栏「观察设置」" icon="look" />}
      </Panel>
    </>
  );
}
