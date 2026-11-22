import { useState, type CSSProperties, type ReactNode } from 'react';
import { GameSeg, WhiteCapsule, YellowKey } from '../../../ui/game';
import type { ChainPath } from './chainPath';
import { BLEND_MAX, ChainStrip, fixBlend, type ChainStripProps } from './ChainStrip';
import { shortName, type ChainRow } from './graph';
import type { Junction } from './joints';
import styles from './Detail.module.css';

export const NOTE_MAX = 500;
export const REQUIRED_TEXT = '基础动作，不能关';
const PLAY = [
  { value: 'on', label: '播' },
  { value: 'off', label: '跳过' },
];

export interface ChainDetailProps {
  row: ChainRow;
  path: ChainPath;
  /** The pack's default blend. */
  crossfade: number;
  /** Clip → the blend_in override shown (draft over stored); absent when the pack's applies. */
  blendIn: (clip: string) => number | undefined;
  /** Clip → why the avatar did not take its blend_in at the last save. */
  adjusted: Record<string, string>;
  /** The joints under the proposal, for their problems. */
  joints: Junction[];
  note: string;
  /** The chain's switch as shown. */
  on: boolean;
  lock: string | null;
  /** Why 舞台预览, 桌面播一次 and 从这个池去掉 are greyed out; null while they work. */
  previewBlock: string | null;
  playBlock: string | null;
  removeBlock: string | null;
  previewing: boolean;
  onBlend: (clip: string, seconds: number | null) => void;
  onNote: (text: string) => void;
  onToggle: (on: boolean) => void;
  /** The chain's segments and the blend into each after the first. */
  onPreview: (clips: string[], blend_s: number[]) => void;
  onPlay: () => void;
  onRemove: () => void;
  /** 编辑结构: the strip's edit marks, the candidate list under it, and the switch in and out. */
  edit: { on: boolean; onToggle: () => void; strip: NonNullable<ChainStripProps['edit']>; panel: ReactNode };
}

/** 链检视（行内展开，半透明深色板）：链条带、选中衔接的混合滑条、动作条（舞台预览、桌面播一次、编辑结构、备注、从这个池去掉、所有池抽到时 播｜跳过）、备注。 */
export function ChainDetail(p: ChainDetailProps) {
  const { path, row } = p;
  const [sel, setSel] = useState<number | null>(() => {
    const i = path.segs.findIndex((s) => p.blendIn(s.seg.clip) !== undefined);
    return i < 0 ? null : i;
  });
  const [noting, setNoting] = useState(p.note !== '');
  const pack = (i: number) => (i === 0 ? path.entry[0]?.joint.blend : path.segs[i]?.joint?.blend) ?? p.crossfade;
  const blendOf = (i: number) => p.blendIn(path.segs[i]!.seg.clip) ?? pack(i);
  const onBlend = (i: number, s: number | null) => p.onBlend(path.segs[i]!.seg.clip, s);
  const at = sel != null && sel < path.segs.length ? sel : null;
  const clip = at != null ? path.segs[at]!.seg.clip : null;
  const flagged = p.joints.filter((j) => j.flags.length > 0);
  const off = p.lock != null;
  return (
    <section className={styles.insp} aria-label={`链详情 ${row.label}`} data-chain-detail={row.key}>
      <ChainStrip
        path={path}
        blendOf={blendOf}
        changedAt={(i) => p.blendIn(path.segs[i]!.seg.clip) !== undefined}
        adjusted={p.adjusted}
        sel={at}
        onSel={setSel}
        onBlend={onBlend}
        lock={p.lock}
        {...(p.edit.on ? { edit: p.edit.strip } : {})}
      />
      {flagged.length > 0 && (
        <ul className={styles.flags} aria-label="衔接问题">
          {flagged.map((j) => (
            <li key={`${j.from}>${j.to}`}>
              {shortName(j.from)} → {shortName(j.to)}：{j.flags.join('，')}
            </li>
          ))}
        </ul>
      )}
      {!p.edit.on &&
        (at != null && clip ? (
          <div className={styles.blend}>
            <span className={styles.k} title="进入混合按片段生效：所有进入这个片段的地方都用这个秒数">
              进入 <b>{shortName(clip)}</b> 的混合
            </span>
            <span className={styles.sl}>
              <input
                type="range"
                min={0}
                max={BLEND_MAX}
                step={0.05}
                value={blendOf(at)}
                aria-label={`进入「${shortName(clip)}」的混合`}
                aria-valuetext={`${blendOf(at).toFixed(2)} s`}
                disabled={off}
                style={{ '--f': `${(blendOf(at) / BLEND_MAX) * 100}%` } as CSSProperties}
                onChange={(e) => onBlend(at, fixBlend(Number(e.currentTarget.value)))}
              />
              <i className={styles.pk} style={{ left: `${(pack(at) / BLEND_MAX) * 100}%` }} aria-hidden="true" />
            </span>
            <span className={styles.val}>{blendOf(at).toFixed(2)} s</span>
            <span className={styles.pack}>包里 {pack(at).toFixed(2)} s</span>
            {p.blendIn(clip) !== undefined && <WhiteCapsule label="用包里的" icon="refresh" disabled={off} {...(off ? { disabledReason: p.lock! } : {})} onClick={() => onBlend(at, null)} />}
          </div>
        ) : (
          <p className={styles.hint}>点一个衔接改混合秒数；也可以左右拖它，或用 ← → 键。</p>
        ))}
      {p.edit.on && p.edit.panel}
      <div className={styles.acts}>
        <YellowKey
          label={p.previewing ? '预览中' : '舞台预览'}
          icon={p.previewing ? 'stop' : 'play'}
          micro="Preview"
          disabled={p.previewBlock != null || p.previewing}
          {...(p.previewBlock != null ? { disabledReason: p.previewBlock } : {})}
          onClick={() => p.onPreview(path.segs.map((s) => s.seg.clip), path.segs.slice(1).map((_, i) => blendOf(i + 1)))}
        />
        <WhiteCapsule label="桌面播一次" icon="play" disabled={p.playBlock != null} {...(p.playBlock != null ? { disabledReason: p.playBlock } : {})} onClick={p.onPlay} />
        <WhiteCapsule label={p.edit.on ? '结束编辑' : '编辑结构'} icon="tool" onClick={p.edit.onToggle} />
        <WhiteCapsule label="备注" icon="file" onClick={() => setNoting(!noting)} />
        <WhiteCapsule label="从这个池去掉" icon="del" disabled={p.removeBlock != null} {...(p.removeBlock != null ? { disabledReason: p.removeBlock } : {})} onClick={p.onRemove} />
        <span className={styles.sp} />
        <span className={styles.oo}>
          <span className={styles.lbl}>所有池抽到时</span>
          {row.required ? (
            <span className={styles.req}>{REQUIRED_TEXT}</span>
          ) : (
            <GameSeg label={`所有池抽到「${row.label}」时`} variant="onoff" value={p.on ? 'on' : 'off'} options={PLAY} disabled={off} onChange={(v) => p.onToggle(v === 'on')} />
          )}
        </span>
      </div>
      {[p.previewBlock, p.playBlock].some((b) => b != null) && (
        <p className={styles.blocks}>
          {[...new Set([p.previewBlock, p.playBlock].filter((b): b is string => b != null))].map((b) => (
            <span key={b} data-block="">
              {b}
            </span>
          ))}
        </p>
      )}
      {noting && (
        <label className={styles.note}>
          <span>备注</span>
          <textarea
            value={p.note}
            maxLength={NOTE_MAX}
            rows={2}
            disabled={off}
            placeholder="写给自己看的，不会发给角色"
            onChange={(e) => p.onNote(e.currentTarget.value.slice(0, NOTE_MAX))}
          />
          <span className={styles.count}>
            {p.note.length}/{NOTE_MAX}
          </span>
        </label>
      )}
    </section>
  );
}
