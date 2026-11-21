import { Donut, StackedBars, type ChartStatus } from '../../charts';
import type { WireDiagBudget, WireUsage } from '../../domain';
import styles from './Res.module.css';

const TOKC = [
  { id: 'in', label: '新输入' },
  { id: 'cache', label: '缓存' },
  { id: 'out', label: '输出' },
];
/** usage.py billing channels. */
const CHANNEL: Readonly<Record<string, string>> = {
  anthropic_api: 'Anthropic',
  openai_api: 'OpenAI',
  chatgpt_subscription: 'Codex CLI',
  compatible_api: '兼容接口',
  deepseek_api: 'DeepSeek',
  unknown: '未知渠道',
};
const CALL_LABEL: Readonly<Record<string, string>> = { mouth: '对话回复', character_agent: '角色运行', observe_summary: '观察摘要', decision: '动作决策', judge: '主动判断' };

export const fmtK = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)} M` : `${Math.round(v / 1000)} k`);
const parts = (u: WireUsage) => ({ in: u.input_tokens, cache: u.cache_read_input_tokens + u.cache_creation_input_tokens, out: u.output_tokens });

export type BarRow = { k: string; label: string; v: number };

/** Gray bars, the largest one in the emphasis colour. */
export function DgBars({ rows, label, fmt = (v) => `${v} 次` }: { rows: BarRow[]; label: string; fmt?: (v: number) => string }) {
  const mx = Math.max(1, ...rows.map((r) => r.v));
  const top = rows.reduce<(typeof rows)[number] | null>((a, b) => (!a || b.v > a.v ? b : a), null);
  return (
    <div className={styles.bars} role="list" aria-label={label}>
      {rows.map((r) => (
        <div key={r.k} role="listitem" className={styles.bar} data-em={r === top || undefined}>
          <span className={styles.bl}>{r.label}</span>
          <span className={styles.bt}>
            <i style={{ width: `${(r.v / mx) * 100}%` }} />
          </span>
          <span className={`${styles.bv} num`}>{fmt(r.v)}</span>
        </div>
      ))}
    </div>
  );
}

export interface UsageCardProps {
  budget: WireDiagBudget | null;
  st: ChartStatus;
}

/** 今日用量 (`/diag/state` budget.model): cost, token mix, tokens by channel and calls by kind. */
export function UsageCard({ budget, st }: UsageCardProps) {
  const m = budget?.model ?? null;
  const chans = m ? Object.entries(m.by_channel).filter(([, u]) => u.calls > 0).map(([k, u]) => ({ key: k, label: CHANNEL[k] ?? k, parts: parts(u) })) : [];
  const tot = m ? parts(m) : null;
  const tok = tot ? TOKC.map((c) => ({ ...c, v: tot[c.id as keyof typeof tot] })) : [];
  const tokSum = tok.reduce((a, b) => a + b.v, 0);
  const calls = m ? Object.entries(m.by_call).map(([k, u]) => ({ k, label: CALL_LABEL[k] ?? k, v: u.calls })).sort((a, b) => b.v - a.v) : [];
  const ust: ChartStatus = st !== 'ok' ? st : m ? 'ok' : 'empty';
  return (
    <div className={styles.blk} role="region" aria-label="今日用量">
      <div className={styles.bh}>
        <b>今日用量</b>
        <span className={styles.sp} />
        {m && (
          <span className={styles.cost}>
            <span className={`${styles.big} num`}>
              {m.unpriced ? '≥ ' : ''}${m.cost_usd.toFixed(2)}
            </span>
            {m.unpriced > 0 && (
              <span className={styles.t2}>
                未计价 <span className="num">{m.unpriced}</span> 次
              </span>
            )}
          </span>
        )}
      </div>
      <div className={styles.use}>
        <Donut label="今日 token 组成" st={ust} empty="今天还没有模型调用" size={92} legend={false} parts={tok} emph="in" center={{ value: fmtK(tokSum), label: 'token' }} fmt={fmtK} />
        <div className={styles.useR}>
          <span className={styles.t3}>按通道</span>
          {chans.length > 0 ? (
            <StackedBars horizontal label="今日 token 按通道" st={ust} buckets={chans} cats={TOKC} emph="in" fmt={fmtK} />
          ) : (
            <span className={styles.t3}>{tot ? `新输入 ${fmtK(tot.in)} │ 缓存 ${fmtK(tot.cache)} │ 输出 ${fmtK(tot.out)}` : '—'}</span>
          )}
        </div>
      </div>
      <span className={styles.t3}>按调用 │ 次数</span>
      {calls.length > 0 ? <DgBars label="按调用次数" rows={calls} /> : <span className={styles.t3}>今天还没有模型调用</span>}
    </div>
  );
}
