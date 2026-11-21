// The overview's columns: stances a chain is entered from │ every chain under its group's head │ stances it comes back to.
import { chainPath, type Base, type GraphIndex } from './chainPath';
import type { ChainGroup, ChainRow, MotionGraph } from './graph';

export const W = 760;
export const COL = { left: 0, baseW: 150, mid: 270, midW: 220, right: 610 };
export const TOP = 30;
export const ROW = 22;
export const HEAD = 26;

/** Group colours by group order, from the app's tokens. */
const COLORS = ['--ef-tri-cyan', '--ef-tri-magenta', '--ef-accent', '--ef-mission-accent', '--ef-tri-c', '--ef-danger', '--ef-ink-s1', '--ef-tri-a'];
export const colorOf = (i: number) => `var(${COLORS[i % COLORS.length]})`;

export interface OvBase {
  base: Base;
  y: number;
}

export interface OvChain {
  row: ChainRow;
  color: string;
  y: number;
  from: string[];
  to: string[];
}

export interface OvLayout {
  heads: Array<{ id: string; title: string; color: string; y: number; n: number }>;
  chains: OvChain[];
  left: Map<string, OvBase>;
  right: Map<string, OvBase>;
  height: number;
}

function column(bases: Base[], height: number): Map<string, OvBase> {
  const sorted = [...new Map(bases.map((b) => [b.clip, b])).values()].sort((a, b) => Number(b.hub) - Number(a.hub) || a.family.localeCompare(b.family));
  const span = height - TOP;
  return new Map(sorted.map((base, i) => [base.clip, { base, y: TOP + ((i + 0.5) * span) / sorted.length }]));
}

export function layout(g: MotionGraph, ix: GraphIndex, groups: ChainGroup[]): OvLayout {
  const heads: OvLayout['heads'] = [];
  const chains: OvChain[] = [];
  const entry: Base[] = [];
  const back: Base[] = [];
  let y = TOP;
  groups.forEach((grp, i) => {
    const color = colorOf(i);
    heads.push({ id: grp.id, title: grp.title, color, y, n: grp.rows.length });
    y += HEAD;
    for (const row of grp.rows) {
      const path = chainPath(ix, row.key, g.chains[row.key]!);
      entry.push(...path.entry.map((e) => e.base));
      back.push(...path.back.map((b) => b.base));
      chains.push({ row, color, y, from: path.entry.map((e) => e.base.clip), to: path.back.map((b) => b.base.clip) });
      y += ROW;
    }
  });
  const height = y + 8;
  return { heads, chains, left: column(entry, height), right: column(back, height), height };
}
