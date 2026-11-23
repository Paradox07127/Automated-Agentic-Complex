// 动作 → 编排: the current character's idle tiers and event pools from agentd's motion graph, overridden through
// avatar.motionOverrides (C3 v27 rule 51); a chain's structure goes back to the pack through avatar.motionChain.
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getBridge, type MotionOverrideAdjusted } from '../../../bridge';
import { motionGroups } from '../../../bridge/motionGroups';
import { ErrBar, Skel } from '../../../ui';
import { GameSeg, MicroLabel } from '../../../ui/game';
import { failure } from '../api';
import type { Toast } from '../feedback';
import { Candidates } from './Candidates';
import { ChainDetail, REQUIRED_TEXT } from './ChainDetail';
import { candidates, holdOf, proposedSegs, withJoints } from './chainEdit';
import { ChainEditBar } from './ChainEditBar';
import { BAND_TEXT, chainPath, indexGraph, type GapBand } from './chainPath';
import { previewChain } from './chainPreview';
import { CommitBar } from './CommitBar';
import { EventGrid } from './EventGrid';
import { chainGroups, readGraph, shortName, type ChainRow } from './graph';
import { ghosts, HARD, junctions, type Junction } from './joints';
import { LoopMap, stanceWord, tierName, type Lane } from './LoopMap';
import { MAX_ENTRIES, PoolRows } from './PoolRows';
import { asWeight, packEntries, poolsOf, type Pool } from './pools';
import { Counts, Outside, PoolProposals } from './Proposals';
import { useChainEdit } from './useChainEdit';
import { useMotionDraft } from './useMotionDraft';
import styles from './Chain.module.css';

export interface MotionSettingsProps {
  offline: boolean;
  toast: Toast;
}

type Kind = MotionOverrideAdjusted['kind'];
type Mode = 'idle' | 'event';

const codeOf = (e: unknown) => (e as { code?: string } | null)?.code;
const hostText = (e: unknown) => (codeOf(e) === 'not_implemented' ? '这个版本还不支持' : '桌面角色没有回应');
const ADJUSTED: Record<MotionOverrideAdjusted['reason'], string> = {
  unknown_chain: '角色包里没有这条链',
  required: REQUIRED_TEXT,
  unknown_pool: '角色包里没有这个池子，或者它不能改',
  unknown_clip: '有片段不在角色包里',
  excluded_family: '有片段起始或收尾在排除的姿势族，运行时不会抽到',
  no_return: '有片段的链最后回不到站姿',
  stance_mismatch: '有片段的站姿和池子不一致',
};
const BLEND_ADJUSTED = '角色包里没有这个片段';
const NO_PLAY = '这个版本还不支持在桌面上播放';
const NO_SEQUENCE = '这个版本的渲染器还不支持预览动作链';
const NO_LIVE = '实时预览没有打开';
const NO_SHA = '取不到当前角色包的版本（package_sha256），不能检查或应用';
const GROUPS_FAIL: Record<string, string> = { not_current: '不是当前角色', motion_graph_missing: '角色包还没有动作图' };
const STANDBY: Record<string, string> = { stand: '站姿待机', sit: '坐姿待机', floor: '坐地上待机', boss: 'Boss 待机' };
const POSTURE: Record<string, string> = { sit: '坐着', floor: '坐地上', lie: '躺着' };
const BANDS: GapBand[] = [1, 2, 3, 4, 0];
const NO_JOINTS: Junction[] = [];
const tierNo = (p: Pool) => Number(/\d+$/.exec(p.key)?.[0] ?? 0);

export function MotionSettings(p: MotionSettingsProps) {
  const list = useQuery({ queryKey: ['character', 'list'], queryFn: () => getBridge().character.list() });
  if (list.isError) return <ErrBar message={`读取角色目录失败：${hostText(list.error)}`} onRetry={() => void list.refetch()} />;
  const id = list.data?.find((c) => c.active)?.id ?? '';
  // Another character starts over: the draft, the open chain and the structure edits belong to the one left.
  return <Settings key={id} id={id} {...p} />;
}

function Settings({ id, offline, toast }: MotionSettingsProps & { id: string }) {
  const qc = useQueryClient();
  const graph = useQuery({ queryKey: ['character', 'motion-graph', id], queryFn: () => readGraph(id), enabled: id !== '' });
  const ovKey = ['avatar', 'motion-overrides', id];
  const ov = useQuery({ queryKey: ovKey, queryFn: () => getBridge().avatar.motionOverrides.get(), enabled: id !== '' });
  const groups = useQuery({ queryKey: ['character', 'motion-groups', id], queryFn: () => motionGroups(id), enabled: id !== '' });
  // `${character}\n${pool}\n${clip}` of each proposal 不要 hid on this visit.
  const [dropped, setDropped] = useState<ReadonlySet<string>>(() => new Set());
  const d = useMotionDraft(ov.data);
  const ce = useChainEdit(id, graph.data?.package_sha256, toast, () => void qc.invalidateQueries({ queryKey: ['character', 'motion-graph', id] }));
  const [adjusted, setAdjusted] = useState<Record<Kind, Record<string, string>>>({ chain: {}, pool: {}, blend_in: {} });
  const [saving, setSaving] = useState(false);
  const [noPlay, setNoPlay] = useState(false);
  const [noSequence, setNoSequence] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [mode, setMode] = useState<Mode | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [segPick, setSegPick] = useState<number | null>(null);
  const g = graph.data;
  const ix = useMemo(() => (g ? indexGraph(g) : null), [g]);
  const rows = useMemo(() => (g ? chainGroups(g).flatMap((x) => x.rows) : []), [g]);
  const pools = useMemo(() => (g ? poolsOf(g, groups.data).filter((p) => !p.locked) : []), [g, groups.data]);
  const joints = useMemo(() => new Map(g && ix ? Object.keys(g.chains).map((k) => [k, junctions(g, ix, k, [])]) : []), [g, ix]);

  if (graph.isError) return <ErrBar message={`读取动作图失败：${failure(graph.error).text}`} onRetry={() => void graph.refetch()} />;
  if (g === null)
    return (
      <div className={styles.missing} role="status">
        这个角色包还没有动作图，需要重建角色包
      </div>
    );
  if (ov.isError) return <ErrBar message={`读取动作设置失败：${hostText(ov.error)}`} onRetry={() => void ov.refetch()} />;
  const stored = ov.data;
  if (!g || !ix || !stored) return <Skel rows={6} label="正在读取动作" />;

  const byKey = new Map(rows.map((r) => [r.key, r]));
  const savedValue = (k: string) => stored.chains[k] ?? byKey.get(k)?.def ?? true;
  const value = (k: string) => d.draft.chains[k] ?? savedValue(k);
  const note = (k: string) => d.draft.notes[k] ?? stored.notes?.[k] ?? '';
  const blendIn = (clip: string) => (clip in d.draft.blend ? d.draft.blend[clip] : stored.blend_in[clip]) ?? undefined;
  const lock = offline ? '角色未运行' : null;
  // The draft is cleared when the save lands, so it takes no edits until then.
  const draftLock = lock ?? (saving ? '正在保存' : null);
  const labelOf = (clip: string) => byKey.get(clip)?.label ?? shortName(clip);
  const groupTitle = (x: string) => g.groups.find((y) => y.id === x)?.title ?? x;
  const jointsOf = (k: string) => joints.get(k) ?? NO_JOINTS;
  const own = (p: Pool) => (p.key in d.draft.pools ? (d.draft.pools[p.key] ?? null) : (stored.pools[p.key] ?? null));
  const entriesOf = (p: Pool) => own(p) ?? packEntries(p);
  const mg = groups.data;
  const pendingOf = (p: Pool) =>
    (mg?.pools[p.key]?.proposal ?? []).filter((x) => !dropped.has(`${id}\n${p.key}\n${x.clip}`) && !entriesOf(p).some((e) => e.clip === x.clip));
  const laneOf = (p: Pool): Lane => {
    const entries = entriesOf(p);
    const hard = entries.filter((e) => jointsOf(e.clip).some((j) => j.flags.includes(HARD))).length;
    return { pool: p, n: entries.length, hard, changed: own(p) != null, bad: p.key in adjusted.pool, proposed: pendingOf(p).length };
  };
  const tiers = pools.filter((p) => p.kind === 'tier').sort((a, b) => tierNo(a) - tierNo(b));
  const events = pools.filter((p) => p.kind === 'event');
  const m: Mode = mode != null && (mode === 'event' ? events : tiers).length > 0 ? mode : tiers.length > 0 || events.length === 0 ? 'idle' : 'event';
  const shown = m === 'idle' ? tiers : events;
  const pool = shown.find((p) => p.key === pick) ?? shown[0];
  const choose = (key: string | null, next: Mode = m) => {
    setMode(next);
    setPick(key);
    setOpen(null);
    setSegPick(null);
  };

  const save = () => {
    const next = d.next(rows, value);
    setSaving(true);
    getBridge()
      .avatar.motionOverrides.set(next)
      .then(
        (reply) => {
          qc.setQueryData(ovKey, next);
          d.clear();
          const marks: Record<Kind, Record<string, string>> = { chain: {}, pool: {}, blend_in: {} };
          for (const a of reply.adjusted) marks[a.kind][a.key] = a.kind === 'blend_in' ? BLEND_ADJUSTED : ADJUSTED[a.reason];
          setAdjusted(marks);
          const n = reply.adjusted.length;
          toast(n > 0 ? `已保存 │ ${n} 项没有生效` : '已保存', n > 0 ? { severity: 'warning' } : undefined);
        },
        (e: unknown) => toast(`动作设置没有保存：${codeOf(e) === 'failed' ? '角色没有接受' : hostText(e)}`, { severity: 'danger' }),
      )
      .finally(() => setSaving(false));
  };

  const play = (r: ChainRow) =>
    void getBridge()
      .avatar.playChain({ start: r.key })
      .then(
        () => toast(`桌面上正在播放「${r.label}」`),
        (e: unknown) => {
          if (codeOf(e) === 'not_implemented') {
            setNoPlay(true);
            toast(NO_PLAY, { severity: 'warning' });
          } else toast(`没有播放：${codeOf(e) === 'unknown_action' ? '角色包里没有这条链' : '桌面角色没有回应'}`, { severity: 'danger' });
        },
      );

  const previewBlock = offline ? '角色未运行' : noSequence ? NO_SEQUENCE : null;
  const preview = (label: string, clips: string[], blend_s: number[]) => {
    if (previewBlock) {
      toast(previewBlock, { severity: 'warning' });
      return;
    }
    setPreviewing(true);
    void previewChain(clips, blend_s)
      .then(
        (on) => (on ? toast(`预览里正在播放「${label}」`) : toast(NO_LIVE, { severity: 'warning' })),
        (e: unknown) => {
          const code = codeOf(e);
          if (code === 'not_implemented') {
            setNoSequence(true);
            toast(NO_SEQUENCE, { severity: 'warning' });
          } else toast(`没有预览：${code === 'unavailable' ? NO_LIVE : '桌面角色没有回应'}`, { severity: 'danger' });
        },
      )
      .finally(() => setPreviewing(false));
  };
  /** A clip alone, as a chain of one. */
  const previewClip = (clip: string) => preview(shortName(clip), [clip], []);
  /** A row's ▶: the pack's chain with the blends shown; a member that starts no chain (a proposal taken) plays alone. */
  const previewRow = (key: string) => {
    const segs = g.chains[key];
    if (!segs) return previewClip(key);
    const path = chainPath(ix, key, segs);
    const blends = path.segs.slice(1).map((s) => blendIn(s.seg.clip) ?? s.joint?.blend ?? g.crossfade_s ?? 0.25);
    preview(labelOf(key), path.segs.map((s) => s.seg.clip), blends);
  };

  const entries = pool ? entriesOf(pool) : [];
  const openRow = open && g.chains[open] && entries.some((e) => e.clip === open) ? byKey.get(open) : undefined;
  let inspector = null;
  if (openRow && pool) {
    const key = openRow.key;
    const segs = ce.editing ? proposedSegs(g, ix, key, ce.edits) : g.chains[key]!;
    const clips = segs.map((s) => s.clip);
    const path = chainPath(ce.editing ? withJoints(g, ix, clips) : ix, key, segs);
    const shipped = new Set(g.chains[key]!.map((s) => s.clip));
    // `at` past the last segment is the slot after it: only the ghosts can go there.
    const n = path.segs.length;
    const at = segPick != null && segPick > 0 && segPick <= n ? segPick : n > 1 ? 1 : n;
    const clip = at < n ? clips[at]! : null;
    const hold = clip ? holdOf(ce.edits, clip) : undefined;
    inspector = (
      <ChainDetail
        key={key}
        row={openRow}
        path={path}
        crossfade={g.crossfade_s ?? 0.25}
        blendIn={blendIn}
        adjusted={adjusted.blend_in}
        joints={ce.editing ? junctions(g, ix, key, ce.edits) : jointsOf(key)}
        note={note(key)}
        on={value(key)}
        lock={draftLock}
        previewBlock={previewBlock}
        playBlock={offline ? '角色未运行' : noPlay ? NO_PLAY : null}
        removeBlock={draftLock ?? (entries.length <= 1 ? '池子里至少要有一条' : null)}
        previewing={previewing}
        onBlend={d.setBlend}
        onNote={(t) => d.setNote(key, t)}
        onToggle={(on) => d.toggle([[key, on]], savedValue)}
        onPreview={(c, b) => preview(openRow.label, c, b)}
        onPlay={() => play(openRow)}
        onRemove={() => {
          setOpen(null);
          d.setPool(pool.key, entries.filter((e) => e.clip !== key));
        }}
        edit={{
          on: ce.editing,
          onToggle: ce.toggle,
          strip: { changed: (c) => !shipped.has(c), pick: at, onPick: setSegPick, problemsOf: ce.problemsOf },
          panel: (
            <Candidates
              index={at}
              clip={clip}
              loop={clip ? !!ix.clips.get(clip)?.loop : false}
              hold={hold !== undefined ? hold : clip ? (ix.clips.get(clip)?.hold_s ?? segs[at]?.hold_range_s?.[1] ?? null) : null}
              options={clip ? candidates(g, ix, clips, at) : []}
              ghosts={ce.editing ? ghosts(g, ix, path.segs.map((s) => s.seg.clip)) : []}
              clipOf={(c) => ix.clips.get(c)}
              lock={lock}
              onReplace={(c) => clip && ce.add({ op: 'replace', chain: key, index: at, clip: c })}
              onInsert={(c) => clip && ce.add({ op: 'insert', chain: key, index: at, clip: c })}
              onInsertAt={(index, c) => ce.add({ op: 'insert', chain: key, index, clip: c })}
              onHold={(s) => clip && ce.add({ op: 'set', clip, hold: s })}
            />
          ),
        }}
      />
    );
  }

  const total = entries.reduce((s, e) => s + e.weight, 0);
  const detail = pool
    ? [
        ...(pool.kind === 'event' ? [groupTitle(pool.group), POSTURE[pool.posture]] : [pool.key]),
        pool.no_repeat ? `最近 ${pool.no_repeat} 条不重复` : null,
        `权重和 ${total}`,
      ]
        .filter(Boolean)
        .join(' │ ')
    : '';
  const parts = [
    Object.keys(d.draft.pools).length > 0 ? `池 ${Object.keys(d.draft.pools).join('、')}` : null,
    Object.keys(d.draft.blend).length > 0 ? `混合 ${Object.keys(d.draft.blend).map(shortName).join('、')}` : null,
    Object.keys(d.draft.chains).length > 0 ? `开关 ${Object.keys(d.draft.chains).map(labelOf).join('、')}` : null,
    Object.keys(d.draft.notes).length > 0 ? `备注 ${Object.keys(d.draft.notes).length} 条` : null,
  ].filter((x): x is string => x != null);

  return (
    <div className={styles.ms} data-motion-settings="">
      <div className={styles.mode}>
        <GameSeg
          variant="setting"
          label="池子类型"
          value={m}
          options={[
            { value: 'idle', label: `待机 ${tiers.length} 档`, disabled: tiers.length === 0 },
            { value: 'event', label: `事件反应 ${events.length}`, disabled: events.length === 0 },
          ]}
          onChange={(v) => choose(null, v as Mode)}
        />
        <ul className={styles.legend} aria-label="衔接色">
          <li className={styles.lt}>衔接</li>
          {BANDS.map((b) => (
            <li key={b} data-band={b}>
              <i aria-hidden="true" />
              {BAND_TEXT[b]}
            </li>
          ))}
        </ul>
      </div>
      {mg && <Counts counts={mg.counts} />}
      {m === 'idle' ? (
        <>
          <div className={styles.sh}>
            <i className={styles.sq} aria-hidden="true" />
            <span>待机循环</span>
            <MicroLabel>Idle Loop</MicroLabel>
            <span className={styles.orn} aria-hidden="true" />
          </div>
          <LoopMap ix={ix} lanes={tiers.map(laneOf)} sel={pool?.key ?? null} onSel={(k) => choose(k)} />
        </>
      ) : (
        <EventGrid cells={events.map(laneOf)} groupTitle={groupTitle} sel={pool?.key ?? null} onSel={(k) => choose(k)} />
      )}
      {pool ? (
        <PoolRows
          key={pool.key}
          graph={g}
          ix={ix}
          pool={pool}
          title={pool.kind === 'tier' ? `${tierName(pool.key)} ${STANDBY[pool.posture] ?? `${stanceWord(pool.posture)}待机`}` : pool.key}
          detail={detail}
          entries={entries}
          overridden={own(pool) != null}
          adjusted={adjusted.pool[pool.key] ?? null}
          adjustedChain={adjusted.chain}
          labelOf={labelOf}
          joints={jointsOf}
          value={value}
          open={openRow ? open : null}
          onOpen={(k) => {
            setOpen(k);
            setSegPick(null);
          }}
          lock={draftLock}
          onPreview={previewRow}
          onPool={(e) => d.setPool(pool.key, e)}
          inspector={inspector}
          extra={
            groups.isError ? (
              <ErrBar message={`读取动作池失败：${GROUPS_FAIL[codeOf(groups.error) ?? ''] ?? failure(groups.error).text}`} onRetry={() => void groups.refetch()} />
            ) : mg?.pools[pool.key] ? (
              <PoolProposals
                group={mg.pools[pool.key]!}
                pending={pendingOf(pool)}
                acceptBlock={draftLock ?? (entries.length >= MAX_ENTRIES ? `一个池子最多 ${MAX_ENTRIES} 条` : null)}
                onPreview={previewClip}
                onAccept={(x) => d.setPool(pool.key, [...entries, { clip: x.clip, weight: asWeight(x.weight) }])}
                onDrop={(clip) => setDropped((s) => new Set(s).add(`${id}\n${pool.key}\n${clip}`))}
              />
            ) : null
          }
        />
      ) : (
        <p className={styles.none}>角色包里没有能改的池子</p>
      )}
      {mg && <Outside groups={mg} onPreview={previewClip} />}
      {ce.editing && (
        <ChainEditBar
          n={ce.edits.length}
          block={lock ?? (ce.hasSha ? null : NO_SHA)}
          busy={ce.busy}
          outcome={ce.outcome}
          general={ce.general(openRow ? proposedSegs(g, ix, openRow.key, ce.edits).map((s) => s.clip) : [])}
          onCheck={ce.check}
          onApply={ce.apply}
          onDiscard={ce.discard}
        />
      )}
      <CommitBar offline={offline} n={d.n} parts={parts} saving={saving} onUndo={d.clear} onSave={save} />
    </div>
  );
}
