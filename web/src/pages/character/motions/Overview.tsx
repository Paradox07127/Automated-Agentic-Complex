import type { CSSProperties, KeyboardEvent } from 'react';
import { baseLabel } from './chainPath';
import { shortName } from './graph';
import { COL, ROW, W, type OvBase, type OvChain, type OvLayout } from './overviewLayout';
import styles from './MotionOverview.module.css';

export interface OverviewProps {
  layout: OvLayout;
  /** Chain key → on, as shown. */
  value: (key: string) => boolean;
  onOpen: (key: string) => void;
}

const H = ROW - 4;
const tint = (color: string) => ({ '--g': color }) as CSSProperties;
const link = (x1: number, y1: number, x2: number, y2: number) => {
  const mx = (x1 + x2) / 2;
  return `M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
};

function BaseNode({ b, x, side }: { b: OvBase; x: number; side: 'entry' | 'back' }) {
  return (
    <g className={styles.base} data-ov-base={b.base.clip} data-side={side} transform={`translate(${x} ${b.y - 18})`}>
      <rect width={COL.baseW} height={36} />
      <text x={8} y={15} className={styles.bl}>
        {baseLabel(b.base)}
      </text>
      <text x={8} y={29} className={styles.bc}>
        {shortName(b.base.clip)}
      </text>
    </g>
  );
}

function ChainNode({ c, on, onOpen }: { c: OvChain; on: boolean; onOpen: () => void }) {
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen();
    }
  };
  return (
    <g
      className={styles.chain}
      role="button"
      tabIndex={0}
      aria-label={`${c.row.label}（${c.row.groupTitle}）`}
      data-ov-chain={c.row.key}
      data-group={c.row.group}
      data-color={c.color}
      data-off={!on || undefined}
      style={tint(c.color)}
      transform={`translate(${COL.mid} ${c.y + 2})`}
      onClick={onOpen}
      onKeyDown={key}
    >
      <title>{c.row.clips.join(' → ')}</title>
      <rect width={COL.midW} height={H} className={styles.cbg} />
      <rect width={4} height={H} className={styles.stripe} />
      <text x={10} y={H - 5} className={styles.cl}>
        {c.row.label}
      </text>
    </g>
  );
}

/** 总览：左列进入前的站姿，中列按组排的每条链（按组上色），右列回到的站姿；点一条链打开它的详情。 */
export function Overview({ layout: l, value, onOpen }: OverviewProps) {
  const right = COL.right;
  return (
    <div className={styles.ov}>
      <ul className={styles.legend} aria-label="分组颜色">
        {l.heads.map((h) => (
          <li key={h.id} style={tint(h.color)} data-legend={h.id}>
            <i aria-hidden="true" />
            {h.title} {h.n}
          </li>
        ))}
      </ul>
      <div className={styles.scroll}>
        <svg className={styles.svg} viewBox={`0 0 ${W} ${l.height}`} width={W} height={l.height} role="group" aria-label="动作总览">
          <g className={styles.cols} aria-hidden="true">
            <text x={COL.left} y={14}>
              进入前的站姿
            </text>
            <text x={COL.mid} y={14}>
              链
            </text>
            <text x={right} y={14}>
              回到的站姿
            </text>
          </g>
          <g className={styles.links} aria-hidden="true">
            {l.chains.flatMap((c) => {
              const y = c.y + ROW / 2;
              return [
                ...c.from.map((b) => (
                  <path key={`in:${c.row.key}:${b}`} d={link(COL.baseW, l.left.get(b)!.y, COL.mid, y)} style={tint(c.color)} />
                )),
                ...c.to.map((b) => (
                  <path key={`out:${c.row.key}:${b}`} d={link(COL.mid + COL.midW, y, right, l.right.get(b)!.y)} style={tint(c.color)} />
                )),
              ];
            })}
          </g>
          {l.heads.map((h) => (
            <text key={h.id} x={COL.mid} y={h.y + 18} className={styles.gh} style={tint(h.color)} data-ov-group={h.id}>
              {h.title}
            </text>
          ))}
          {l.chains.map((c) => (
            <ChainNode key={c.row.key} c={c} on={value(c.row.key)} onOpen={() => onOpen(c.row.key)} />
          ))}
          {[...l.left.values()].map((b) => (
            <BaseNode key={b.base.clip} b={b} x={COL.left} side="entry" />
          ))}
          {[...l.right.values()].map((b) => (
            <BaseNode key={b.base.clip} b={b} x={right} side="back" />
          ))}
        </svg>
      </div>
    </div>
  );
}
