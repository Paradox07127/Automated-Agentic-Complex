// 动作池: the current character's pools as the pack fills them, agentd's proposals for each (accepted ones go out as the whole
// pool through avatar.motionOverrides), and the clips no pool takes.
import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getBridge, type MotionOverrideAdjusted, type MotionOverrides, type MotionPoolEntry } from '../../bridge';
import { motionGroups, type MotionGroupPool } from '../../bridge/motionGroups';
import { Btn, ErrBar, IconBtn, OpenSec, Pill, Skel } from '../../ui';
import { failure } from '../character/api';
import type { Toast } from '../character/feedback';
import { previewChain } from '../character/motions/chainPreview';
import { shortName } from '../character/motions/graph';
import styles from './PoolBench.module.css';

export interface PoolBenchProps {
  offline: boolean;
  toast: Toast;
}

const codeOf = (e: unknown) => (e as { code?: string } | null)?.code;
const hostText = (e: unknown) => (codeOf(e) === 'not_implemented' ? '这个版本还不支持' : '桌面角色没有回应');
/** A clip's refusal, from the avatar's `adjusted` or agentd's `rejected`; other reasons show as they come. */
const REFUSED: Record<string, string> = {
  unknown_pool: '角色包里没有这个池子',
  unknown_clip: '不在角色包里',
  excluded_family: '起始或收尾在排除的姿势族',
  no_return: '回不到站姿',
  stance_mismatch: '站姿和池子不一致',
} satisfies Partial<Record<MotionOverrideAdjusted['reason'], string>>;
const NO_LIVE = '实时预览没有打开';
const NONE: MotionOverrides = { chains: {}, pools: {}, blend_in: {} };
const samePool = (a: MotionPoolEntry[], b: MotionPoolEntry[]) => a.length === b.length && a.every((e, i) => e.clip === b[i]!.clip && e.weight === b[i]!.weight);

export function PoolBench({ offline, toast }: PoolBenchProps) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['character', 'list'], queryFn: () => getBridge().character.list() });
  const id = list.data?.find((c) => c.active)?.id ?? '';
  const groups = useQuery({ queryKey: ['character', 'motion-groups', id], queryFn: () => motionGroups(id), enabled: id !== '' });
  const ovKey = ['avatar', 'motion-overrides', id];
  const ov = useQuery({ queryKey: ovKey, queryFn: () => getBridge().avatar.motionOverrides.get(), enabled: id !== '' });
  const [pick, setPick] = useState<string | null>(null);
  // `${character}\n${pool}\n${clip}` of each proposal dropped here.
  const [dropped, setDropped] = useState<ReadonlySet<string>>(() => new Set());
  // Pool key → the clip last accepted into it and why the avatar did not take the pool.
  const [refused, setRefused] = useState<Record<string, { clip: string; reason: string }>>({});
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  const body = () => {
    if (list.isError) return <ErrBar message={`读取角色目录失败：${hostText(list.error)}`} onRetry={() => void list.refetch()} />;
    if (groups.isError) return <ErrBar message={`读取动作池失败：${failure(groups.error).text}`} onRetry={() => void groups.refetch()} />;
    if (ov.isError) return <ErrBar message={`读取动作设置失败：${hostText(ov.error)}`} onRetry={() => void ov.refetch()} />;
    const g = groups.data;
    const stored = ov.data;
    if (!g || !stored) return <Skel rows={6} label="正在读取动作池" />;

    const keys = Object.keys(g.pools);
    const sel = keys.find((k) => k === pick) ?? keys[0];
    const isDropped = (key: string, clip: string) => dropped.has(`${id}\n${key}\n${clip}`);
    const accepted = (key: string, clip: string) => !!stored.pools[key]?.some((e) => e.clip === clip);
    const pending = (key: string, p: MotionGroupPool) => p.proposal.filter((x) => !isDropped(key, x.clip) && !accepted(key, x.clip)).length;
    const lock = offline ? '角色未运行' : null;

    const play = (clip: string) => {
      setPreviewing(true);
      void previewChain([clip], [])
        .then(
          (on) => (on ? toast(`预览里正在播放「${shortName(clip)}」`) : toast(NO_LIVE, { severity: 'warning' })),
          (e: unknown) => toast(`没有预览：${codeOf(e) === 'unavailable' ? NO_LIVE : hostText(e)}`, { severity: 'danger' }),
        )
        .finally(() => setPreviewing(false));
    };
    const playBtn = (clip: string) => <IconBtn icon="play" size="sm" label={`播放 ${shortName(clip)}`} disabled={!!lock || previewing} onClick={() => play(clip)} />;

    /** Sends the whole set with `key`'s pool as `entries`; the pack's own pool goes back to the pack. */
    const write = (key: string, p: MotionGroupPool, entries: MotionPoolEntry[], clip: string) => {
      const pools = { ...stored.pools };
      if (entries.length === 0 || samePool(entries, p.pack)) delete pools[key];
      else pools[key] = entries;
      const next: MotionOverrides = { ...NONE, ...stored, pools };
      setSaving(true);
      getBridge()
        .avatar.motionOverrides.set(next)
        .then(
          (reply) => {
            qc.setQueryData(ovKey, next);
            const a = reply.adjusted.find((x) => x.kind === 'pool' && x.key === key);
            setRefused((r) => {
              const out = { ...r };
              if (a) out[key] = { clip, reason: a.reason };
              else delete out[key];
              return out;
            });
            const n = reply.adjusted.length;
            toast(n > 0 ? `已保存 │ ${n} 项没有生效` : '已保存', n > 0 ? { severity: 'warning' } : undefined);
          },
          (e: unknown) => toast(`动作设置没有保存：${codeOf(e) === 'failed' ? '角色没有接受' : hostText(e)}`, { severity: 'danger' }),
        )
        .finally(() => setSaving(false));
    };

    const pool = sel ? g.pools[sel] : undefined;
    let detail = null;
    if (sel && pool) {
      const base = stored.pools[sel] ?? pool.pack;
      const proposals = pool.proposal.filter((x) => !isDropped(sel, x.clip));
      const block = lock ?? (saving ? '正在保存' : null);
      const bad = refused[sel];
      detail = (
        <div className={styles.pool} role="region" aria-label={`池子 ${sel}`}>
          <Group title="角色包" n={pool.pack.length}>
            {pool.pack.map((e) => (
              <li key={e.clip} className={styles.row} data-clip={e.clip}>
                {playBtn(e.clip)}
                <span className={styles.clip}>{shortName(e.clip)}</span>
                <span className={styles.num}>{e.weight}</span>
              </li>
            ))}
          </Group>
          {proposals.length > 0 && (
            <Group title="建议" n={proposals.length}>
              {proposals.map((x) => {
                const on = accepted(sel, x.clip);
                const name = shortName(x.clip);
                return (
                  <li key={x.clip} className={styles.row} data-clip={x.clip} data-on={on || undefined}>
                    {playBtn(x.clip)}
                    <span className={styles.clip}>{name}</span>
                    <span className={styles.why}>{x.why}</span>
                    {on && bad?.clip === x.clip && <span className={styles.bad}>{REFUSED[bad.reason] ?? bad.reason}</span>}
                    <span className={styles.acts}>
                      {on ? (
                        <>
                          <Pill tone="success">已收下</Pill>
                          <Btn size="sm" variant="text" disabled={!!block} disabledReason={block ?? undefined} onClick={() => write(sel, pool, base.filter((e) => e.clip !== x.clip), x.clip)}>
                            <span aria-hidden="true">撤回</span><span className={styles.sr}>{`撤回 ${name}`}</span>
                          </Btn>
                        </>
                      ) : (
                        <>
                          <Btn size="sm" variant="secondary" disabled={!!block} disabledReason={block ?? undefined} onClick={() => write(sel, pool, [...base, { clip: x.clip, weight: x.weight }], x.clip)}>
                            <span aria-hidden="true">收下</span><span className={styles.sr}>{`收下 ${name}`}</span>
                          </Btn>
                          <Btn size="sm" variant="text" onClick={() => setDropped((d) => new Set(d).add(`${id}\n${sel}\n${x.clip}`))}>
                            <span aria-hidden="true">不要</span><span className={styles.sr}>{`不要 ${name}`}</span>
                          </Btn>
                        </>
                      )}
                    </span>
                  </li>
                );
              })}
            </Group>
          )}
          {pool.rejected.length > 0 && (
            <Group title="不收" n={pool.rejected.length}>
              {pool.rejected.map((r) => (
                <li key={r.clip} className={styles.row} data-clip={r.clip}>
                  <span className={styles.clip}>{shortName(r.clip)}</span>
                  <span className={styles.bad}>{REFUSED[r.reason] ?? r.reason}</span>
                </li>
              ))}
            </Group>
          )}
        </div>
      );
    }

    const reasons = [...new Set(g.excluded.map((x) => x.reason))];
    const strip = (label: string, clips: string[]) => (
      <div key={label} className={styles.band}>
        <span className={styles.bandName}>{label}</span>
        <ul className={styles.chips} aria-label={label}>
          {clips.map((c) => (
            <li key={c} className={styles.chip} data-clip={c}>
              {playBtn(c)}
              <span className={styles.clip}>{shortName(c)}</span>
            </li>
          ))}
        </ul>
      </div>
    );

    return (
      <>
        <div className={styles.bench}>
          <ul className={styles.keys} aria-label="池子">
            {keys.map((k) => {
              const p = g.pools[k]!;
              const n = pending(k, p);
              return (
                <li key={k}>
                  <button type="button" className={styles.key} aria-pressed={k === sel} aria-label={`${k}，角色包 ${p.pack.length} 条，建议 ${n} 条`} onClick={() => setPick(k)}>
                    <span className={styles.keyName}>{k}</span>
                    <span className={styles.num}>{p.pack.length}</span>
                    <span className={styles.plus} data-zero={n === 0 || undefined}>+{n}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {detail}
        </div>
        {(g.excluded.length > 0 || g.unclassified.length > 0) && (
          <div className={styles.cover} role="region" aria-label="池外">
            {reasons.map((r) => strip(`排除 ${r}`, g.excluded.filter((x) => x.reason === r).map((x) => x.clip)))}
            {g.unclassified.length > 0 && strip('未分类', g.unclassified)}
          </div>
        )}
      </>
    );
  };

  const c = groups.data?.counts;
  return (
    <div className={styles.wrap} data-pool-bench="">
      <OpenSec
        title="动作池"
        {...(groups.data ? { count: Object.keys(groups.data.pools).length } : {})}
        right={c && <span className={styles.counts}>{`片段 ${c.clips} │ 池内 ${c.pooled} │ 建议 ${c.proposals} │ 不收 ${c.rejected} │ 排除 ${c.excluded} │ 未分类 ${c.unclassified}`}</span>}
      >
        {body()}
      </OpenSec>
    </div>
  );
}

function Group({ title, n, children }: { title: string; n: number; children: ReactNode }) {
  return (
    <div className={styles.group}>
      <h4 className={styles.gh}>
        {title}
        <span className={styles.num}>{n}</span>
      </h4>
      <ul className={styles.rows} aria-label={title}>
        {children}
      </ul>
    </div>
  );
}
