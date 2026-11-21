// Cytoscape draws the edges; each node is an HTML card in an overlay that follows the canvas's pan, zoom and dragged nodes.
import cytoscape, { type Core, type ElementDefinition, type LayoutOptions, type NodeSingular, type StylesheetJson } from 'cytoscape';
import dagre from 'cytoscape-dagre';
import { useLayoutEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import type { GEdge, GNode, NodeKind } from './elements';
import styles from './ChainGraph.module.css';

cytoscape.use(dagre);

/** Card sizes in graph units; the cards are drawn to these so the layout needs no measuring. */
export const SIZE: Record<NodeKind, { w: number; h: number }> = {
  base: { w: 150, h: 52 },
  group: { w: 150, h: 52 },
  seg: { w: 184, h: 60 },
  side: { w: 168, h: 46 },
  ghost: { w: 168, h: 46 },
  more: { w: 120, h: 36 },
};

export type DropTarget = { replace: number } | { insert: number };

export interface GraphCanvasProps {
  label: string;
  nodes: GNode[];
  edges: GEdge[];
  preset: boolean;
  card: (n: GNode) => ReactNode;
  dim: (n: GNode) => boolean;
  /** A clip is picked in the palette: 「+」 and segment cards take it. */
  picked: boolean;
  onTap: (n: GNode) => void;
  /** Present in the focus layer, where segments take drops; clip null is the picked one. */
  onDrop?: (t: DropTarget, clip: string | null) => void;
}

const narrow = () => window.matchMedia?.('(max-width: 760px)').matches ?? false;

function sheet(el: Element, dir: 'LR' | 'TB'): StylesheetJson {
  const css = getComputedStyle(el);
  const tok = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const band = [tok('--ef-text-3', 'gray'), tok('--ef-line-strong', 'silver'), tok('--ef-accent', 'gold'), tok('--ef-danger', 'tomato'), tok('--ef-danger-vivid', 'red')];
  const fg = tok('--ef-text-1', 'black');
  const bg = tok('--ef-surface-1', 'white');
  return [
    { selector: 'node', style: { shape: 'round-rectangle', width: 'data(w)', height: 'data(h)', 'background-opacity': 0, 'border-width': 0, label: '' } },
    ...band.map((c, i) => ({ selector: `edge[band = ${i}]`, style: { 'line-color': c, 'target-arrow-color': c } })),
    {
      selector: 'edge',
      style: {
        width: 2,
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.9,
        'curve-style': 'bezier',
        label: 'data(label)',
        'font-size': 10.5,
        'font-family': tok('--ef-font-mono', 'monospace'),
        color: fg,
        'text-background-color': bg,
        'text-background-opacity': 0.92,
        'text-background-padding': '2px',
        'text-background-shape': 'roundrectangle',
        'text-wrap': 'wrap',
      },
    },
    { selector: 'edge.spine', style: { width: 3 } },
    { selector: 'edge.thin', style: { width: 1, 'line-style': 'dotted', 'font-size': 9 } },
    { selector: 'edge.ghost', style: { width: 1.5, 'line-style': 'dashed', 'line-dash-pattern': [6, 4] } },
    {
      selector: 'edge.self',
      style: {
        'loop-direction': dir === 'TB' ? '90deg' : '0deg',
        'loop-sweep': '-40deg',
        'control-point-step-size': dir === 'TB' ? 150 : 70,
        'line-color': band[2]!,
        'target-arrow-color': band[2]!,
      },
    },
    { selector: 'edge.agg', style: { width: 'data(width)' } },
    // Where many edges meet one node, each label sits near its other end.
    { selector: 'edge.ls', style: { label: '', 'source-label': 'data(label)', 'source-text-offset': 58 } },
    { selector: 'edge.lt', style: { label: '', 'target-label': 'data(label)', 'target-text-offset': 58 } },
    { selector: 'edge.agg', style: { 'target-text-offset': 130 } },
    { selector: 'edge.bb', style: { 'curve-style': 'unbundled-bezier', 'control-point-distances': -60, 'control-point-weights': 0.5 } },
    { selector: 'edge.bridge.bb', style: { 'control-point-distances': -110 } },
  ] as StylesheetJson;
}

/** The canvas and its card overlay: a tap on a node, or Enter on its card, calls onTap; drops land on a segment or a 「+」. */
export function GraphCanvas(p: GraphCanvasProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const over = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const byId = useRef(new Map<string, GNode>());
  const tap = useRef(p.onTap);
  tap.current = p.onTap;
  const [hot, setHot] = useState<string | null>(null);

  const place = (node: NodeSingular) => {
    const el = over.current?.querySelector<HTMLElement>(`[data-node="${CSS.escape(node.id())}"]`);
    if (!el) return;
    const { x, y } = node.position();
    const { w, h } = node.data() as { w: number; h: number };
    el.style.left = `${x - w / 2}px`;
    el.style.top = `${y - h / 2}px`;
    const plus = el.nextElementSibling as HTMLElement | null;
    if (plus?.dataset.plus != null) {
      plus.style.left = `${x + w / 2 - 4}px`;
      plus.style.top = `${y + h / 2 - 16}px`;
    }
  };
  const sync = () => {
    const cy = cyRef.current;
    if (!cy || !over.current) return;
    const { x, y } = cy.pan();
    over.current.style.transform = `translate(${x}px, ${y}px) scale(${cy.zoom()})`;
  };

  // A layout effect so the canvas exists before the layout pass below, which runs before plain effects.
  useLayoutEffect(() => {
    const cy = cytoscape({ container: box.current, minZoom: 0.15, maxZoom: 2.5, boxSelectionEnabled: false, autounselectify: true });
    cyRef.current = cy;
    cy.on('pan zoom', sync);
    cy.on('position', 'node', (e) => place(e.target as NodeSingular));
    cy.on('tap', 'node', (e) => {
      const n = byId.current.get((e.target as NodeSingular).id());
      if (n) tap.current(n);
    });
    // The canvas resolves the theme's colours once; restyle when the theme flips.
    const watch = new MutationObserver(() => wrap.current && cy.style(sheet(wrap.current, narrow() ? 'TB' : 'LR')));
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      watch.disconnect();
      // destroy() keeps its layer and buffer canvases, and Chromium frees a detached canvas only at GC; at 2× each is tens
      // of MB, so a few visits to 角色 would pass the window's memory limit. An empty box resizes them all to 0×0.
      if (box.current) Object.assign(box.current.style, { width: '0', height: '0' });
      cy.resize();
      cy.destroy();
      cyRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const cy = cyRef.current;
    const w = wrap.current;
    if (!cy || !w) return;
    byId.current = new Map(p.nodes.map((n) => [n.id, n]));
    const dir = narrow() ? 'TB' : 'LR';
    const els: ElementDefinition[] = [
      ...p.nodes.map((n): ElementDefinition => ({ group: 'nodes', data: { id: n.id, ...SIZE[n.kind] }, ...(n.pos ? { position: { ...n.pos } } : {}) })),
      ...p.edges.map((e): ElementDefinition => ({ group: 'edges', data: { id: e.id, source: e.source, target: e.target, label: e.label, band: e.band, width: e.width ?? 2 }, classes: e.cls })),
    ];
    cy.elements().remove();
    cy.style(sheet(w, dir));
    cy.add(els);
    const layout = p.preset
      ? { name: 'preset', fit: false }
      : { name: 'dagre', rankDir: dir, nodeSep: 16, rankSep: 120, edgeSep: 12, animate: false, fit: false };
    cy.layout(layout as LayoutOptions).run();
    const bb = cy.elements().boundingBox();
    const pad = 24;
    const zmin = dir === 'TB' ? 0.6 : 0.5;
    const fit = Math.min(1.05, (w.clientWidth - 2 * pad) / bb.w, 2400 / bb.h);
    const z = fit >= zmin ? fit : zmin;
    w.style.height = `${Math.round(Math.max(dir === 'TB' ? 360 : 440, bb.h * z + 2 * pad))}px`;
    cy.resize();
    cy.zoom(z);
    cy.center();
    cy.nodes().forEach(place);
    sync();
  }, [p.nodes, p.edges, p.preset]);

  const hit = (x: number, y: number): DropTarget | null => {
    const inside = (el: Element, pad: number) => {
      const r = el.getBoundingClientRect();
      return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
    };
    const root = over.current;
    if (!root) return null;
    for (const b of root.querySelectorAll<HTMLElement>('[data-plus]')) if (inside(b, 6)) return { insert: Number(b.dataset.plus) };
    for (const c of root.querySelectorAll<HTMLElement>('[data-replace]')) if (inside(c, 0)) return { replace: Number(c.dataset.replace) };
    return null;
  };
  const hotKey = (t: DropTarget | null) => (!t ? null : 'insert' in t ? `insert:${t.insert}` : `replace:${t.replace}`);
  const drag = p.onDrop
    ? {
        onDragOver: (e: DragEvent) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setHot(hotKey(hit(e.clientX, e.clientY)));
        },
        onDragLeave: () => setHot(null),
        onDrop: (e: DragEvent) => {
          e.preventDefault();
          setHot(null);
          const t = hit(e.clientX, e.clientY);
          const clip = e.dataTransfer.getData('text/plain');
          if (t && clip) p.onDrop!(t, clip);
        },
      }
    : {};

  return (
    <div ref={wrap} className={styles.canvas} {...drag}>
      <div ref={box} className={styles.cy} role="img" aria-label={p.label} />
      <div ref={over} className={styles.overlay}>
        {p.nodes.map((n) => {
          const { w, h } = SIZE[n.kind];
          const seg = p.onDrop && n.kind === 'seg' ? n.index : undefined;
          return [
            <button
              key={n.id}
              type="button"
              className={styles.card}
              style={{ width: w, height: h }}
              data-node={n.id}
              data-kind={n.kind}
              data-changed={n.changed || undefined}
              data-off={p.dim(n) || undefined}
              // The backend refuses a replace of a chain's first segment (bad_index).
              data-replace={seg || undefined}
              data-hot={(!!seg && hot === `replace:${seg}`) || undefined}
              onClick={() => p.onTap(n)}
            >
              {p.card(n)}
            </button>,
            seg != null && (
              <button
                key={`${n.id}+`}
                type="button"
                className={styles.plus}
                data-plus={seg + 1}
                data-hot={hot === `insert:${seg + 1}` || undefined}
                aria-label={`在「${n.title}」后面插入片段`}
                aria-disabled={!p.picked || undefined}
                onClick={() => p.picked && p.onDrop!({ insert: seg + 1 }, null)}
              >
                +
              </button>
            ),
          ];
        })}
      </div>
    </div>
  );
}
