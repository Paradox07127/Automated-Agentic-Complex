import { Fragment, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { IconBtn } from '../../../ui';
import { Diamond } from '../../../ui/game';
import { baseLabel, gapBand, lengthText, type ChainPath, type Joint } from './chainPath';
import { shortName } from './graph';
import { secText, segTime } from './timing';
import styles from './Strip.module.css';

export const BLEND_MAX = 2;
const STEP = 0.05;
const PX_PER_S = 100;

// Dividing the step count lands on the literal's double (0.3); multiplying by STEP drifts off it, and a draft stays dirty.
export const fixBlend = (s: number) => Math.round(Math.min(BLEND_MAX, Math.max(0, s)) / STEP) / (1 / STEP);
const num = (x: number, d: number) => String(Math.round(x * 10 ** d) / 10 ** d);
const cmText = (gap: number | null) => (gap == null ? '未测' : `${num(gap, 1)} cm`);
const sText = (s: number | null) => (s == null ? '—' : `${s.toFixed(2)} s`);

export interface ChainStripProps {
  path: ChainPath;
  /** The blend shown into segment `i` (draft over stored over the pack's). */
  blendOf: (i: number) => number;
  /** The blend into segment `i` was changed. */
  changedAt: (i: number) => boolean;
  /** Clip → why the avatar did not take its blend at the last save. */
  adjusted: Record<string, string>;
  /** The selected joint: the one into segment `i`. */
  sel: number | null;
  onSel: (i: number) => void;
  /** Sets the blend into segment `i`; null gives it back to the pack. */
  onBlend: (i: number, s: number | null) => void;
  lock: string | null;
  /** 编辑结构: segments put in by the proposal, the picked one, and its problems. */
  edit?: { changed: (clip: string) => boolean; pick: number | null; onPick: (i: number) => void; problemsOf: (clip: string) => string[] };
}

/** A segment's name in the strip: its last two words (three when the second last is a number), cough_start, attack_04_start. */
function segName(clip: string): string {
  const words = shortName(clip).split('_');
  let n = Math.min(2, words.length);
  while (n < words.length && /^\d+$/.test(words[words.length - n]!)) n += 1;
  return words.slice(-n).join('_');
}

/** A joint into segment `i`: blend above, an arrow wedge coloured by the gap, the gap below; ←→ ±0.05 s, Shift ±0.25, Delete back to the pack, drag sideways. */
function Wedge({ p, i, joint, into }: { p: ChainStripProps; i: number; joint: Joint; into: string }) {
  const drag = useRef<{ x: number; s: number; moved: boolean } | null>(null);
  const s = p.blendOf(i);
  const off = p.lock != null;
  const label = `进入「${shortName(into)}」的衔接：${cmText(joint.gap)}，混合 ${sText(s)}`;
  const onKey = (e: KeyboardEvent) => {
    if (off) return;
    const by = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (by) {
      e.preventDefault();
      p.onBlend(i, fixBlend(s + by * (e.shiftKey ? 0.25 : STEP)));
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      p.onBlend(i, null);
    }
  };
  const down = (e: PointerEvent<HTMLButtonElement>) => {
    if (off) return;
    drag.current = { x: e.clientX, s, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    const d = drag.current;
    // The 3 px dead zone only guards the start, so the drag can come back to where it began.
    if (!d || (!d.moved && Math.abs(e.clientX - d.x) < 3)) return;
    d.moved = true;
    const next = fixBlend(d.s + (e.clientX - d.x) / PX_PER_S);
    if (next !== s) p.onBlend(i, next);
  };
  return (
    <button
      type="button"
      className={styles.jt}
      data-joint=""
      data-band={gapBand(joint.gap)}
      aria-pressed={p.sel === i}
      aria-label={label}
      title={label}
      onClick={() => p.onSel(i)}
      onKeyDown={onKey}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={() => (drag.current = null)}
    >
      <span className={styles.s}>{sText(s)}</span>
      <span className={styles.w} aria-hidden="true" />
      <span className={styles.g}>{cmText(joint.gap)}</span>
      {p.changedAt(i) && (
        <span className={styles.chg}>
          <Diamond tone="yellow" size={5} />
        </span>
      )}
    </button>
  );
}

/** 链条带：入口站姿 → 每个衔接一个楔块 → 段（宽按时长，起 / 循环 ⟲ 保持 / 收）→ 回到的站姿；改结构时段间和末尾出橙色 +，点段选要换的段。 */
export function ChainStrip(p: ChainStripProps) {
  const { path } = p;
  const entry = path.entry[0];
  const back = path.back[0];
  let t = 0;
  const starts = path.segs.map((s) => {
    const at = t;
    t += segTime(s.seg);
    return at;
  });
  return (
    <div className={styles.strip} role="group" aria-label="链条" data-hscroll="">
      <div className={styles.bn} data-side="entry">
        <span className={styles.d}>
          <i aria-hidden="true" />
          {entry ? baseLabel(entry.base) : '不从站姿进入'}
        </span>
        {entry && (
          <small title={entry.base.clip} data-base={entry.base.clip}>
            {shortName(entry.base.clip)}
          </small>
        )}
        {path.entry.slice(1).map((x) => (
          <span key={x.base.clip} className={styles.alt} data-base={x.base.clip}>
            + {baseLabel(x.base)}
          </span>
        ))}
      </div>
      {path.segs.map((s, i) => {
        const clip = s.seg.clip;
        const joint = i === 0 ? entry?.joint : s.joint;
        const pickable = p.edit && i > 0;
        const problems = p.edit?.problemsOf(clip) ?? [];
        const body = (
          <>
            <span className={styles.rl}>{s.role}</span>
            <b title={clip}>{segName(clip)}</b>
            <span className={styles.len}>{lengthText(s.seg)}</span>
            {s.seg.loop && s.seg.hold_range_s && <span className={styles.hold}>保持 {secText(segTime(s.seg))}</span>}
            {s.seg.loop && (
              <svg className={styles.lpi} viewBox="0 0 18 18" aria-hidden="true">
                <path d="M14 9a5 5 0 1 1-2-4M12 1.5v4h4" />
              </svg>
            )}
            <span className={styles.at}>{secText(starts[i]!)}</span>
            {p.adjusted[clip] && (
              <span className={styles.problem} data-adjusted="">
                {p.adjusted[clip]}
              </span>
            )}
            {problems.map((x) => (
              <span key={x} className={styles.problem} data-problem="">
                {x}
              </span>
            ))}
          </>
        );
        const attrs = {
          className: styles.sg,
          'data-seg': clip,
          'data-loop': s.seg.loop || undefined,
          'data-new': p.edit?.changed(clip) || undefined,
          'data-pick': p.edit?.pick === i || undefined,
          style: { flexGrow: Math.sqrt(Math.max(0.4, segTime(s.seg))) },
        };
        return (
          <Fragment key={`${clip}:${i}`}>
            {pickable && (
              <span className={styles.plus}>
                <IconBtn icon="plus" label={`在「${shortName(clip)}」前插入`} shape="round" onClick={() => p.edit!.onPick(i)} />
              </span>
            )}
            {joint ? <Wedge p={p} i={i} joint={joint} into={clip} /> : <span className={styles.jt} aria-hidden="true" />}
            {pickable ? (
              <button type="button" {...attrs} aria-pressed={p.edit!.pick === i} aria-label={`第 ${i + 1} 段 ${shortName(clip)}`} onClick={() => p.edit!.onPick(i)}>
                {body}
              </button>
            ) : (
              <div {...attrs}>{body}</div>
            )}
          </Fragment>
        );
      })}
      {p.edit && (
        <span className={styles.plus}>
          <IconBtn
            icon="plus"
            label={`在「${shortName(path.segs[path.segs.length - 1]!.seg.clip)}」后插入`}
            shape="round"
            pressed={p.edit.pick === path.segs.length}
            onClick={() => p.edit!.onPick(path.segs.length)}
          />
        </span>
      )}
      {back && (
        <span className={styles.jt} data-joint="" data-band={gapBand(back.joint.gap)} title={`回到站姿：${cmText(back.joint.gap)}`}>
          <span className={styles.s}>{sText(back.joint.blend)}</span>
          <span className={styles.w} aria-hidden="true" />
          <span className={styles.g}>{cmText(back.joint.gap)}</span>
        </span>
      )}
      <div className={styles.bn} data-side="back">
        <span className={styles.d}>
          <i aria-hidden="true" />
          {back ? baseLabel(back.base) : '不回站姿'}
        </span>
        <small data-base={back?.base.clip}>
          回到 │ {secText(t)}
          {back?.via ? ` │ 经 ${shortName(back.via)}` : ''}
        </small>
        {path.back.slice(1).map((x) => (
          <span key={`${x.base.clip}:${x.via ?? ''}`} className={styles.alt} data-base={x.base.clip}>
            {x.via ? `或经桥接 ${baseLabel(x.base)}` : `或 ${baseLabel(x.base)}`}
          </span>
        ))}
      </div>
    </div>
  );
}
