import type { WireDiagBudget, WireUsage } from '../../domain';
import { SecHead } from '../../ui';
import { GameFrame, MicroLabel } from '../../ui/game';
import styles from './Flow.module.css';

const TOKC = [
  { id: 'in', label: '新输入' },
  { id: 'cache', label: '缓存' },
  { id: 'out', label: '输出' },
] as const;
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

/** Grey bars, the largest one in the emphasis colour. */
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
          <span className={styles.bv}>{fmt(r.v)}</span>
        </div>
      ))}
    </div>
  );
}

export interface UsageCardProps {
  budget: WireDiagBudget | null;
  /** /diag/state is still on its first read. */
  loading: boolean;
}

/** 模型调用 (`/diag/state` budget.model): today's calls by kind and tokens by channel. */
export function UsageCard({ budget, loading }: UsageCardProps) {
  const m = budget?.model ?? null;
  const chans = m
    ? Object.entries(m.by_channel)
        .filter(([, u]) => u.calls > 0)
        .map(([k, u]) => ({ k, label: CHANNEL[k] ?? k, p: parts(u) }))
    : [];
  const cmax = Math.max(1, ...chans.map((c) => c.p.in + c.p.cache + c.p.out));
  const calls = m
    ? Object.entries(m.by_call)
        .map(([k, u]) => ({ k, label: CALL_LABEL[k] ?? k, v: u.calls }))
        .sort((a, b) => b.v - a.v)
    : [];
  return (
    <section id="diag-usage" className={styles.col} data-nav-target="diag-usage" aria-label="模型调用">
      <SecHead
        variant="diag"
        title="模型调用"
        info="按调用种类数次数；按通道数 token：实色是新输入，斜纹是缓存，灰色是输出。"
        right="今天"
      />
      <GameFrame label="今天的模型调用">
        <div className={styles.calls}>
          <MicroLabel>BY CALL</MicroLabel>
          {calls.length > 0 ? <DgBars label="按调用次数" rows={calls} /> : <p className={styles.note}>{loading ? '正在读取' : '今天还没有模型调用'}</p>}
          <MicroLabel>BY CHANNEL TOKEN</MicroLabel>
          {chans.length > 0 ? (
            <div className={styles.bars} role="list" aria-label="按通道 token">
              {chans.map((c) => {
                const sum = c.p.in + c.p.cache + c.p.out;
                return (
                  <div key={c.k} role="listitem" className={styles.bar} aria-label={`${c.label} ${TOKC.map((t) => `${t.label} ${fmtK(c.p[t.id])}`).join(' │ ')}`}>
                    <span className={styles.bl}>{c.label}</span>
                    <span className={styles.stk} style={{ width: `${(sum / cmax) * 100}%` }}>
                      {TOKC.map((t) => (
                        <i key={t.id} data-k={t.id} style={{ width: `${sum ? (c.p[t.id] / sum) * 100 : 0}%` }} />
                      ))}
                    </span>
                    <span className={styles.bv}>{fmtK(sum)}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className={styles.note}>{m ? `新输入 ${fmtK(parts(m).in)} │ 缓存 ${fmtK(parts(m).cache)} │ 输出 ${fmtK(parts(m).out)}` : '—'}</p>
          )}
        </div>
      </GameFrame>
    </section>
  );
}
