import { formatClock } from '../../domain';
import { Btn } from '../../ui';
import { GameTable, StatusLamp, type GameTableRow } from '../../ui/game';
import { PURPOSE_LABEL, type Change, type Digest, type Run } from './data';
import { None, Panel, Reads } from './Detail';
import { isBad, RUN_STATE, runLamp } from './labels';
import { median } from './model';
import styles from './Views.module.css';

const COLS = [
  { key: 'at', label: '时间', width: '52px' },
  { key: 'use', label: '用途', width: '68px' },
  { key: 'res', label: '结果', width: '108px' },
  { key: 'what', label: '写了什么', width: 'minmax(0, 1fr)' },
  { key: 'ms', label: '用时', width: '56px', opt: true },
  { key: 'model', label: '模型', width: 'minmax(80px, 0.5fr)', opt: true },
];

const SYM: Readonly<Record<Change['op'], [string, string]>> = { add: ['+', '新增'], upd: ['~', '更新'], del: ['−', '删除'] };

export const countOps = (xs: readonly Change[]) => ({
  add: xs.filter((x) => x.op === 'add').length,
  upd: xs.filter((x) => x.op === 'upd').length,
  del: xs.filter((x) => x.op === 'del').length,
});

/** 「+4 ~2 −1」, the zero counts left out. */
const opsText = (n: ReturnType<typeof countOps>) =>
  (['add', 'upd', 'del'] as const)
    .filter((op) => n[op] > 0)
    .map((op) => `${SYM[op][0]}${n[op]}`)
    .join(' ');

function Ops({ changes }: { changes: readonly Change[] }) {
  const n = countOps(changes);
  return (
    <span className={styles.ops}>
      {(['add', 'upd', 'del'] as const)
        .filter((op) => n[op] > 0)
        .map((op) => (
          <span key={op}>
            <b className="num">
              {SYM[op][0]}
              {n[op]}
            </b>
            {SYM[op][1]}
          </span>
        ))}
    </span>
  );
}

/** 一批写进了什么：+ 新增 / ~ 更新 / − 删除，内容，原来的写法，等你确认的标出来。 */
function Changes({ changes }: { changes: readonly Change[] }) {
  return (
    <div className={styles.changes}>
      {changes.map((c, i) => (
        <div key={i} className={styles.change} data-op={c.op}>
          <span className={styles.op}>
            <b aria-hidden="true">{SYM[c.op][0]}</b>
            {SYM[c.op][1]}
          </span>
          <span className={styles.tx}>{c.text}</span>
          {c.cand && <span className={styles.cand}>待确认</span>}
          {c.was && <span className={styles.was}>原：{c.was}</span>}
        </div>
      ))}
    </div>
  );
}

export interface MemViewProps {
  runs: Run[];
  digest: ReadonlyMap<string, Digest>;
  /** Runs started today: the readouts sum these. */
  today: Run[];
  /** The batch the URL asked for: selected and open. */
  picked: string | null;
  selected: string | null;
  onSelect: (id: string) => void;
  onRecord: (id: string) => void;
  onChat: () => void;
}

/** 整理：今天写了多少、多快、几次没成；整理记录一行一批，展开看增删改，行尾开生成记录。 */
export function MemView({ runs, digest, today, picked, selected, onSelect, onRecord, onChat }: MemViewProps) {
  const done = today.filter((r) => r.state !== 'running');
  const all = countOps(today.flatMap((r) => digest.get(r.id)?.changes ?? []));
  const fails = today.filter((r) => isBad(r.state)).length;
  const p50 = median(done.flatMap((r) => (r.end != null ? [r.end - r.at] : [])));
  const last = runs.find((r) => r.state !== 'running');
  const rows: GameTableRow[] = runs.map((r) => {
    const d = digest.get(r.id);
    const changes = d?.changes ?? [];
    const bad = isBad(r.state);
    return {
      id: r.id,
      ...(bad ? { tone: 'fail' as const } : r.state === 'running' ? { tone: 'run' as const } : {}),
      defaultOpen: r.id === picked && changes.length > 0,
      cells: {
        at: <span className="num">{formatClock(r.at)}</span>,
        use: PURPOSE_LABEL[r.purpose],
        res: <StatusLamp {...runLamp(r.state)} />,
        what: bad ? (
          <span className={styles.bad}>
            {RUN_STATE[r.state]}
            {d?.code ? `（${d.code}）` : ''}
          </span>
        ) : changes.length > 0 ? (
          <Ops changes={changes} />
        ) : (
          '—'
        ),
        ms: <span className="num">{r.end != null ? `${Math.round((r.end - r.at) / 1000)} s` : '—'}</span>,
        model: <span className={styles.mono}>{r.model}</span>,
      },
      ...(changes.length > 0 ? { body: <Changes changes={changes} /> } : {}),
      ...(r.state !== 'running'
        ? {
            end: (
              <Btn size="sm" variant="ghost" onClick={() => onRecord(r.id)}>
                生成记录
              </Btn>
            ),
          }
        : {}),
    };
  });
  if (runs.length === 0)
    return (
      <Panel title="整理记录" count={0} micro="CONSOLIDATE LOG">
        <None
          title="还没有整理记录"
          desc="和她聊几句，后台约 2 分钟后开始第一次整理"
          icon="data"
          action={
            <Btn size="sm" variant="secondary" onClick={onChat}>
              去对话
            </Btn>
          }
        />
      </Panel>
    );
  return (
    <>
      <Reads
        cells={[
          { value: all.add + all.upd + all.del, unit: opsText(all) || undefined, label: '今天写入（新增、更新、删除）' },
          { value: p50 == null ? '—' : Math.round(p50 / 1000), unit: p50 == null ? undefined : 's', label: '用时中位数', opt: true },
          { value: fails, label: '失败 / 校验未通过', tone: fails > 0 ? 'bad' : 'ink' },
          { value: last ? formatClock(last.end ?? last.at) : '—', label: '上次整理', tone: 'ink' },
        ]}
      />
      <Panel title="整理记录" count={runs.length} micro="CONSOLIDATE LOG" tip="生成记录只保留 48 小时，过后只剩操作回执">
        {/* GameTable reads defaultOpen once: it mounts again when the asked-for batch's changes arrive. */}
        <GameTable key={picked == null || digest.has(picked) ? 'open' : 'wait'} label="整理记录" columns={COLS} endWidth="auto" rows={rows} selected={selected} onSelect={onSelect} />
      </Panel>
    </>
  );
}
