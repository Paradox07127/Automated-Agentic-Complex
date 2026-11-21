// 行为 → 动作: the current character's chains from agentd's motion graph, overridden through avatar.motionOverrides (C3 v27 rule 51).
import { lazy, Suspense, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getBridge, type MotionOverrideAdjusted } from '../../../bridge';
import { Btn, ErrBar, Seg, Skel } from '../../../ui';
import { failure } from '../api';
import { SaveNote } from '../Commit';
import type { Toast } from '../feedback';
import { ChainDetail, type ChainDetailEdit } from './ChainDetail';
import { candidates, holdOf, proposedSegs, withJoints } from './chainEdit';
import { previewChain } from './chainPreview';
import { ChainList } from './ChainList';
import { REQUIRED_TEXT } from './ChainRow';
import { chainPath, indexGraph } from './chainPath';
import { chainGroups, readGraph, shortName, type ChainGroup, type ChainRow } from './graph';
import { Overview } from './Overview';
import { layout } from './overviewLayout';
import { PoolList } from './PoolList';
import { poolsOf } from './pools';
import { useChainEdit } from './useChainEdit';
import { useMotionDraft } from './useMotionDraft';
import type { GraphAt } from './graphView/elements';
import styles from './MotionSettings.module.css';

export interface MotionSettingsProps {
  offline: boolean;
  toast: Toast;
}

type View = 'graph' | 'list' | 'pools' | 'overview';
type Kind = MotionOverrideAdjusted['kind'];

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
const VIEWS = [
  { value: 'graph', label: '图' },
  { value: 'list', label: '清单' },
  { value: 'pools', label: '池子' },
  { value: 'overview', label: '总览' },
];
// Cytoscape stays out of the first bundle.
const ChainGraph = lazy(() => import('./graphView/ChainGraph').then((m) => ({ default: m.ChainGraph })));

export function MotionSettings({ offline, toast }: MotionSettingsProps) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['character', 'list'], queryFn: () => getBridge().character.list() });
  const id = list.data?.find((c) => c.active)?.id ?? '';
  const graph = useQuery({ queryKey: ['character', 'motion-graph', id], queryFn: () => readGraph(id), enabled: id !== '' });
  const ovKey = ['avatar', 'motion-overrides', id];
  const ov = useQuery({ queryKey: ovKey, queryFn: () => getBridge().avatar.motionOverrides.get(), enabled: id !== '' });
  const d = useMotionDraft(ov.data);
  const ce = useChainEdit(id, graph.data?.package_sha256, toast, () => void qc.invalidateQueries({ queryKey: ['character', 'motion-graph', id] }));
  const [adjusted, setAdjusted] = useState<Record<Kind, Record<string, string>>>({ chain: {}, pool: {}, blend_in: {} });
  const [saving, setSaving] = useState(false);
  const [noPlay, setNoPlay] = useState(false);
  const [noSequence, setNoSequence] = useState(false);
  const [view, setView] = useState<View>('graph');
  const [graphAt, setGraphAt] = useState<GraphAt>({ type: 'overview' });
  const [open, setOpen] = useState<string | null>(null);
  const g = graph.data;
  const groups = useMemo(() => (g ? chainGroups(g) : []), [g]);
  const ix = useMemo(() => (g ? indexGraph(g) : null), [g]);
  const pools = useMemo(() => (g ? poolsOf(g) : []), [g]);
  const map = useMemo(() => (g && ix ? layout(g, ix, groups) : null), [g, ix, groups]);

  if (list.isError) return <ErrBar message={`读取角色目录失败：${hostText(list.error)}`} onRetry={() => void list.refetch()} />;
  if (graph.isError) return <ErrBar message={`读取动作图失败：${failure(graph.error).text}`} onRetry={() => void graph.refetch()} />;
  if (g === null)
    return (
      <div className={styles.missing} role="status">
        这个角色包还没有动作图，需要重建角色包
      </div>
    );
  if (ov.isError) return <ErrBar message={`读取动作设置失败：${hostText(ov.error)}`} onRetry={() => void ov.refetch()} />;
  const stored = ov.data;
  if (!g || !ix || !map || !stored) return <Skel rows={6} label="正在读取动作" />;

  const rows = groups.flatMap((x) => x.rows);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const savedValue = (k: string) => stored.chains[k] ?? byKey.get(k)?.def ?? true;
  const value = (k: string) => d.draft.chains[k] ?? savedValue(k);
  const note = (k: string) => d.draft.notes[k] ?? stored.notes?.[k] ?? '';
  const blendIn = (clip: string) => {
    const v = clip in d.draft.blend ? d.draft.blend[clip] : stored.blend_in[clip];
    return v ?? undefined;
  };
  const onGroup = (x: ChainGroup, on: boolean) => d.toggle(x.rows.filter((r) => !r.required).map((r) => [r.key, on]), savedValue);
  const lock = offline ? '角色未运行' : null;
  const labelOf = (clip: string) => byKey.get(clip)?.label ?? shortName(clip);
  const title = new Map(g.groups.map((x) => [x.id, x.title]));

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

  const preview = (r: ChainRow, clips: string[], blend_s: number[]) =>
    void previewChain(clips, blend_s).then(
      (on) => (on ? toast(`预览里正在播放「${r.label}」`) : toast(NO_LIVE, { severity: 'warning' })),
      (e: unknown) => {
        const code = codeOf(e);
        if (code === 'not_implemented') {
          setNoSequence(true);
          toast(NO_SEQUENCE, { severity: 'warning' });
        } else toast(`没有预览：${code === 'unavailable' ? NO_LIVE : '桌面角色没有回应'}`, { severity: 'danger' });
      },
    );
  const playBlock = offline ? '角色未运行' : noPlay ? NO_PLAY : null;

  const openRow = open ? byKey.get(open) : undefined;
  let body;
  if (openRow) {
    const key = openRow.key;
    // While editing, the chain as the proposal leaves it, its new joints measured from the poses.
    const segs = ce.editing ? proposedSegs(g, ix, key, ce.edits) : g.chains[key]!;
    const clips = segs.map((s) => s.clip);
    const edit: ChainDetailEdit = {
      on: ce.editing,
      onToggle: ce.toggle,
      seg: (index, s) => {
        const clip = s.seg.clip;
        const hold = holdOf(ce.edits, clip);
        return {
          clip,
          options: index === 0 ? null : candidates(g, ix, clips, index),
          loop: !!s.seg.loop,
          hold: hold !== undefined ? hold : (ix.clips.get(clip)?.hold_s ?? null),
          problems: ce.problemsOf(clip),
          onReplace: (c) => ce.add({ op: 'replace', chain: key, index, clip: c }),
          onInsert: (c) => ce.add({ op: 'insert', chain: key, index, clip: c }),
          onHold: (seconds) => ce.add({ op: 'set', clip, hold: seconds }),
        };
      },
      bar: {
        n: ce.edits.length,
        block: lock ?? (ce.hasSha ? null : NO_SHA),
        busy: ce.busy,
        outcome: ce.outcome,
        general: ce.general(clips),
        onCheck: ce.check,
        onApply: ce.apply,
        onDiscard: ce.discard,
      },
    };
    body = (
      <ChainDetail
        row={openRow}
        path={chainPath(ce.editing ? withJoints(g, ix, clips) : ix, key, segs)}
        crossfade={g.crossfade_s ?? 0.25}
        blendIn={blendIn}
        adjusted={adjusted.blend_in}
        note={note(openRow.key)}
        lock={lock}
        previewBlock={offline ? '角色未运行' : noSequence ? NO_SEQUENCE : null}
        playBlock={playBlock}
        onBlend={d.setBlend}
        onNote={(t) => d.setNote(openRow.key, t)}
        onPreview={(clips, blend_s) => preview(openRow, clips, blend_s)}
        onPlay={() => play(openRow)}
        onBack={() => setOpen(null)}
        edit={edit}
      />
    );
  } else if (view === 'pools')
    body = (
      <PoolList
        graph={g}
        pools={pools}
        stored={stored.pools}
        draft={d.draft.pools}
        adjusted={adjusted.pool}
        labelOf={labelOf}
        groupTitle={(x) => title.get(x) ?? x}
        lock={lock}
        onPool={d.setPool}
      />
    );
  else if (view === 'overview') body = <Overview layout={map} value={value} onOpen={setOpen} />;
  else if (view === 'graph')
    body = (
      <Suspense fallback={<Skel rows={6} label="正在读取动作图" />}>
        <ChainGraph
          graph={g}
          ix={ix}
          groups={groups}
          at={graphAt}
          onAt={setGraphAt}
          ce={ce}
          editBlock={lock ?? (ce.hasSha ? null : NO_SHA)}
          lock={lock}
          value={value}
          onToggle={(k, on) => d.toggle([[k, on]], savedValue)}
          onOpen={setOpen}
        />
      </Suspense>
    );
  else
    body = (
      <ChainList
        groups={groups}
        value={value}
        unsaved={(k) => k in d.draft.chains}
        adjusted={adjusted.chain}
        note={note}
        lock={lock}
        playBlock={playBlock}
        onToggle={(k, on) => d.toggle([[k, on]], savedValue)}
        onGroup={onGroup}
        onPlay={play}
        onOpen={setOpen}
      />
    );

  return (
    <div className={styles.ms} data-motion-settings="">
      {!openRow && <Seg size="sm" label="动作视图" options={VIEWS} value={view} onChange={(v) => setView(v as View)} />}
      {body}
      <div className={styles.save}>
        <SaveNote offline={offline} n={d.n} sparse={false} />
        {!offline && d.n > 0 && (
          <>
            <span className={styles.sp} />
            <Btn variant="quiet" onClick={d.clear}>
              撤销
            </Btn>
            <Btn variant="primary" loading={saving} onClick={save}>
              保存
            </Btn>
          </>
        )}
      </div>
    </div>
  );
}
