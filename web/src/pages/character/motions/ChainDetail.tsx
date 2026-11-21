import { Btn, Slider } from '../../../ui';
import { ChainEditBar, type ChainEditBarProps } from './ChainEditBar';
import { baseLabel, holdText, lengthText, type Base, type ChainPath, type Joint as J, type PathSeg } from './chainPath';
import { shortName, type ChainRow } from './graph';
import { Joint } from './Joint';
import { SegEdit, type SegEditProps } from './SegEdit';
import styles from './MotionDetail.module.css';

export const NOTE_MAX = 500;

/** 「编辑结构」: `path` is the proposed chain while it is on. */
export interface ChainDetailEdit {
  on: boolean;
  onToggle: () => void;
  /** The controls of segment `index`. */
  seg: (index: number, s: PathSeg) => Omit<SegEditProps, 'lock'>;
  bar: ChainEditBarProps;
}

export interface ChainDetailProps {
  row: ChainRow;
  path: ChainPath;
  /** The pack's default blend. */
  crossfade: number;
  /** Clip → the blend_in override shown (draft over stored); absent when the pack's applies. */
  blendIn: (clip: string) => number | undefined;
  /** Clip → why the avatar did not take its blend_in at the last save. */
  adjusted: Record<string, string>;
  note: string;
  lock: string | null;
  /** Why 「预览这条链」 and 「在桌面上播一次」 are greyed out; null while they work. */
  previewBlock: string | null;
  playBlock: string | null;
  onBlend: (clip: string, seconds: number | null) => void;
  onNote: (text: string) => void;
  /** The chain's segments and the blend into each after the first (draft over stored over the pack's). */
  onPreview: (clips: string[], blend_s: number[]) => void;
  onPlay: () => void;
  onBack: () => void;
  edit?: ChainDetailEdit;
}

function Act({ label, block, onClick }: { label: string; block: string | null; onClick: () => void }) {
  return (
    <>
      <Btn size="sm" variant="secondary" disabled={block != null} {...(block != null ? { disabledReason: block } : {})} onClick={onClick}>
        {label}
      </Btn>
      {block != null && (
        <span className={styles.sub} data-block="">
          {block}
        </span>
      )}
    </>
  );
}

function Stance({ items, side }: { items: Array<{ base: Base; joint: J; via?: string | null }>; side: 'entry' | 'back' }) {
  return (
    <div className={styles.stance} data-side={side}>
      <span className={styles.role}>{side === 'entry' ? '进入前' : '回到'}</span>
      {items.length === 0 && <span className={styles.sub}>{side === 'entry' ? '不从站姿进入' : '不回站姿'}</span>}
      {items.map(({ base, joint, via }) => (
        <div key={base.clip} className={styles.base} data-base={base.clip}>
          {side === 'back' && <Joint joint={joint} />}
          <b>{baseLabel(base)}</b>
          <span className={styles.clip} title={base.clip}>
            {shortName(base.clip)}
          </span>
          {via && <span className={styles.sub}>经 {shortName(via)}</span>}
          {side === 'entry' && <Joint joint={joint} />}
        </div>
      ))}
    </div>
  );
}

function Seg({ s, i, def, p }: { s: PathSeg; i: number; def: number; p: ChainDetailProps }) {
  const clip = s.seg.clip;
  const over = p.blendIn(clip);
  const hold = holdText(s.seg);
  return (
    <div className={styles.seg} data-seg={clip} data-loop={s.seg.loop || undefined}>
      <span className={styles.role}>{s.role}</span>
      <b className={styles.clip} title={clip}>
        {shortName(clip)}
      </b>
      <span className={styles.sub}>{lengthText(s.seg)}</span>
      {hold && <span className={styles.hold}>{hold}</span>}
      <div className={styles.blend}>
        <span className={styles.sub}>进入混合{over !== undefined && <b className={styles.over}> 已改</b>}</span>
        <Slider
          value={over ?? def}
          min={0}
          max={2}
          step={0.05}
          defaultValue={def}
          unit="s"
          label={`进入「${shortName(clip)}」的混合`}
          disabled={p.lock != null}
          onChange={(v) => p.onBlend(clip, v)}
        />
        {over !== undefined && p.lock == null && (
          <Btn size="sm" variant="quiet" onClick={() => p.onBlend(clip, null)}>
            用包里的
          </Btn>
        )}
      </div>
      {p.adjusted[clip] && <span className={styles.why}>{p.adjusted[clip]}</span>}
      {p.edit?.on && <SegEdit {...p.edit.seg(i, s)} lock={p.lock} />}
    </div>
  );
}

/** 链详情：进入前的站姿 → 起 → 循环 → 收 → 回到的站姿，每个衔接标 gap 色带和混合秒数，每段的进入混合可改；下面是这条链的备注。 */
export function ChainDetail(p: ChainDetailProps) {
  const { path, row } = p;
  const shown = (clip: string, j: J) => {
    const over = p.blendIn(clip);
    return over !== undefined ? over : j.blend;
  };
  return (
    <section className={styles.detail} aria-label={`链详情 ${row.label}`} data-chain-detail={row.key}>
      <div className={styles.head}>
        <Btn size="sm" variant="quiet" onClick={p.onBack}>
          返回
        </Btn>
        <b className={styles.title}>{row.label}</b>
        <span className={styles.sub}>{row.groupTitle}</span>
        <span className={styles.clip} title={row.key}>
          {row.key}
        </span>
      </div>
      <div className={styles.chain} role="group" aria-label="链条">
        <Stance side="entry" items={path.entry.map((e) => ({ ...e, joint: { ...e.joint, blend: shown(path.segs[0]!.seg.clip, e.joint) } }))} />
        {path.segs.map((s, i) => (
          <div key={s.seg.clip} className={styles.step}>
            {s.joint && <Joint joint={s.joint} blend={shown(s.seg.clip, s.joint)} />}
            <Seg s={s} i={i} def={(i === 0 ? path.entry[0]?.joint.blend : s.joint?.blend) ?? p.crossfade} p={p} />
          </div>
        ))}
        <Stance side="back" items={path.back.map((b) => ({ ...b, joint: { ...b.joint, blend: shown(b.via ?? b.base.clip, b.joint) } }))} />
      </div>
      <p className={styles.hint}>进入混合按片段生效：所有进入这个片段的地方都用这个秒数。</p>
      <div className={styles.acts}>
        <Act
          label="预览这条链"
          block={p.previewBlock}
          onClick={() => p.onPreview(path.segs.map((s) => s.seg.clip), path.segs.slice(1).map((s) => p.blendIn(s.seg.clip) ?? s.joint?.blend ?? p.crossfade))}
        />
        <Act label="在桌面上播一次" block={p.playBlock} onClick={p.onPlay} />
        {p.edit && (
          <Btn size="sm" variant="secondary" onClick={p.edit.onToggle}>
            {p.edit.on ? '结束编辑' : '编辑结构'}
          </Btn>
        )}
      </div>
      {p.edit?.on && <ChainEditBar {...p.edit.bar} />}
      <label className={styles.note}>
        <span>备注</span>
        <textarea
          value={p.note}
          maxLength={NOTE_MAX}
          rows={3}
          disabled={p.lock != null}
          placeholder="写给自己看的，不会发给角色"
          onChange={(e) => p.onNote(e.currentTarget.value.slice(0, NOTE_MAX))}
        />
        <span className={styles.count}>
          {p.note.length}/{NOTE_MAX}
        </span>
      </label>
    </section>
  );
}
