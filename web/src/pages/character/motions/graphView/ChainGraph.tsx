// 动作 → 图: the chain graph in three layers (总览 › 分组 › 链); in a chain, palette clips dropped or put on a segment or a 「+」
// become the structure proposal's replace and insert edits.
import { useMemo, useState } from 'react';
import type { ChainEdit } from '../../../../bridge';
import { Btn, Toggle } from '../../../../ui';
import { ChainEditBar } from '../ChainEditBar';
import { proposedClips } from '../chainEdit';
import { REQUIRED_TEXT } from '../ChainRow';
import { BAND_TEXT, baseLabel, gapBand, type GraphIndex } from '../chainPath';
import { shortName, type ChainGroup, type MotionGraph } from '../graph';
import type { ChainEditState } from '../useChainEdit';
import { ClipPalette } from './ClipPalette';
import { cmText, layerOf, sText, type GNode, type GraphAt } from './elements';
import { GraphCanvas, type DropTarget } from './GraphCanvas';
import styles from './ChainGraph.module.css';

export interface ChainGraphProps {
  graph: MotionGraph;
  ix: GraphIndex;
  groups: ChainGroup[];
  at: GraphAt;
  onAt: (at: GraphAt) => void;
  ce: ChainEditState;
  /** Why 检查 and 应用 are greyed out; null when they work. */
  editBlock: string | null;
  lock: string | null;
  value: (key: string) => boolean;
  onToggle: (key: string, on: boolean) => void;
  onOpen: (key: string) => void;
}

const NONE: ChainEdit[] = [];

export function ChainGraph(p: ChainGraphProps) {
  const { graph: g, ix, groups, at, ce } = p;
  const [picked, setPicked] = useState<string | null>(null);
  const [withGhosts, setGhosts] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const edits = ce.editing ? ce.edits : NONE;
  const layer = useMemo(() => layerOf(g, ix, groups, at, edits, withGhosts), [g, ix, groups, at, edits, withGhosts]);
  const rows = new Map(groups.flatMap((x) => x.rows).map((r) => [r.key, r]));
  const groupTitle = (id: string) => g.groups.find((x) => x.id === id)?.title ?? groups.find((x) => x.id === id)?.title ?? id;
  const focus = at.type === 'focus' && g.chains[at.key] ? at.key : null;
  const groupId = at.type === 'group' ? at.id : focus ? (rows.get(focus)?.group ?? null) : null;
  const go = (next: GraphAt) => {
    setSel(null);
    p.onAt(next);
  };
  const nameOf = (clip: string) => (ix.bases.has(clip) ? baseLabel(ix.bases.get(clip)!) : shortName(clip));

  const put = (t: DropTarget, clip: string | null) => {
    const c = clip ?? picked;
    if (!c || !focus || !ix.clips.has(c)) return;
    if (!ce.editing) ce.toggle();
    ce.add('replace' in t ? { op: 'replace', chain: focus, index: t.replace, clip: c } : { op: 'insert', chain: focus, index: t.insert, clip: c });
    setPicked(null);
  };
  const tap = (n: GNode) => {
    if (n.kind === 'group' && n.group) go({ type: 'group', id: n.group });
    else if (n.kind === 'seg' && at.type === 'group' && n.chain) go({ type: 'focus', key: n.chain });
    else if (n.kind === 'seg' && focus && picked && n.index) put({ replace: n.index }, picked);
    else setSel(sel === n.id ? null : n.id);
  };

  const card = (n: GNode) => (
    <>
      <span className={styles.ct} title={n.clip || undefined}>
        {n.title}
      </span>
      {n.sub && <span className={styles.cs}>{n.sub}</span>}
    </>
  );
  const dim = (n: GNode) => n.kind === 'seg' && !!n.chain && !p.value(n.chain);

  const chosen = layer.nodes.find((n) => n.id === sel) ?? null;
  const chainOf = (n: GNode) => n.chain ?? (g.chains[n.clip] ? n.clip : undefined);
  const detail = chosen && (
    <div className={styles.detail} data-graph-detail={chosen.id}>
      {chosen.names ? (
        <ul className={styles.names} aria-label={chosen.title}>
          {chosen.names.map((c) => (
            <li key={c} title={c}>
              {nameOf(c)}
            </li>
          ))}
        </ul>
      ) : (
        <>
          <b className={styles.full}>{chosen.clip}</b>
          <span className={styles.cs}>{[chosen.title, chosen.sub].filter(Boolean).join(' │ ')}</span>
        </>
      )}
      {(() => {
        const key = chainOf(chosen);
        const row = key ? rows.get(key) : undefined;
        if (!key || !row) return null;
        const why = row.required ? REQUIRED_TEXT : p.lock;
        return (
          <span className={styles.acts}>
            <Toggle size="sm" on={p.value(key)} label={row.label} disabled={why != null} disabledReason={why ?? ''} onChange={(on) => p.onToggle(key, on)} />
            <Btn size="sm" variant="secondary" onClick={() => p.onOpen(key)}>
              打开链详情
            </Btn>
          </span>
        );
      })()}
    </div>
  );

  const clips = focus ? proposedClips(focus, g.chains[focus]!.map((s) => s.clip), ce.edits) : [];

  return (
    <div className={styles.graph} data-chain-graph={at.type}>
      <nav className={styles.crumbs} aria-label="动作图位置">
        {at.type === 'overview' ? (
          <span aria-current="page">图</span>
        ) : (
          <button type="button" onClick={() => go({ type: 'overview' })}>
            图
          </button>
        )}
        {groupId && (
          <>
            <i aria-hidden="true">›</i>
            {focus ? (
              <button type="button" onClick={() => go({ type: 'group', id: groupId })}>
                {groupTitle(groupId)}
              </button>
            ) : (
              <span aria-current="page">{groupTitle(groupId)}</span>
            )}
          </>
        )}
        {focus && (
          <>
            <i aria-hidden="true">›</i>
            <span aria-current="page" title={focus}>
              {rows.get(focus)?.label ?? shortName(focus)}
            </span>
            <span className={styles.ghostSw}>
              能接上的
              <Toggle size="sm" on={withGhosts} label="能接上的" onChange={setGhosts} />
            </span>
          </>
        )}
      </nav>
      {focus && ce.editing && (
        <ChainEditBar
          n={ce.edits.length}
          block={p.editBlock}
          busy={ce.busy}
          outcome={ce.outcome}
          general={ce.general(clips)}
          onCheck={ce.check}
          onApply={ce.apply}
          onDiscard={ce.discard}
        />
      )}
      <div className={styles.body} data-palette={focus ? '' : undefined}>
        <div className={styles.main}>
          <GraphCanvas
            label="动作衔接图"
            nodes={layer.nodes}
            edges={layer.edges}
            preset={layer.preset}
            card={card}
            dim={dim}
            picked={picked != null}
            onTap={tap}
            {...(focus ? { onDrop: put } : {})}
          />
          {detail}
          {focus && layer.junctions && (
            <ol className={styles.joints} aria-label="衔接">
              {layer.junctions.map((j) => (
                <li key={`${j.where}:${j.from}>${j.to}`} data-junction={j.where} data-flags={j.flags.join(' ') || undefined}>
                  <span className={styles.who}>
                    <span title={j.from}>{nameOf(j.from)}</span>
                    <i aria-hidden="true">→</i>
                    <span title={j.to}>{nameOf(j.to)}</span>
                  </span>
                  <span className={styles.cm} data-band={gapBand(j.gap)} title={BAND_TEXT[gapBand(j.gap)]}>
                    <i aria-hidden="true" />
                    {cmText(j.gap)}
                  </span>
                  <span className={styles.s}>{sText(j.blend)}</span>
                  <span className={styles.flags}>
                    {j.flags.map((f) => (
                      <b key={f}>{f}</b>
                    ))}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
        {focus && <ClipPalette graph={g} groupTitle={groupTitle} picked={picked} onPick={setPicked} />}
      </div>
    </div>
  );
}
