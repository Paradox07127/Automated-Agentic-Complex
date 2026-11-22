import { gapBand } from './chainPath';
import type { Candidate } from './chainEdit';
import { shortName, type GraphClip } from './graph';
import type { Ghost } from './joints';
import { Stepper } from '../../../ui/game';
import styles from './Edit.module.css';

export interface CandidatesProps {
  /** The picked segment; null before one is picked. */
  index: number | null;
  clip: string | null;
  loop: boolean;
  /** The hold shown on a loop, in seconds. */
  hold: number | null | undefined;
  /** Clips that fit the picked segment, nearest first. */
  options: Candidate[];
  /** Clips of any group within 8 cm of where the chain is left. */
  ghosts: Ghost[];
  clipOf: (clip: string) => GraphClip | undefined;
  lock: string | null;
  onReplace: (clip: string) => void;
  onInsert: (clip: string) => void;
  /** Inserts `clip` at `index` of the chain (a ghost after the segment it follows). */
  onInsertAt: (index: number, clip: string) => void;
  onHold: (seconds: number) => void;
}

const cm = (gap: number | null | undefined) => (gap == null ? '未测' : String(gap));
const lenText = (c: GraphClip | undefined) => (c?.length_s == null ? '' : `${c.loop ? '一圈 ' : ''}${Math.round(c.length_s * 100) / 100} s`);

function Gap({ gap }: { gap: number | null | undefined }) {
  return <span data-band={gapBand(gap ?? null)}>{cm(gap)}</span>;
}

/** 改结构：选中段的候选（同站姿、同姿势族，按衔接排），换成或在此前插入；循环段的保持秒数；末尾是 8 cm 内能接上的任何片段。 */
export function Candidates(p: CandidatesProps) {
  const off = p.lock != null;
  if (p.index == null || p.clip == null)
    return <p className={styles.pickHint}>点链条里的一段或段间的橙色 +，选要换的位置；第一段不能换，也不能插在它前面。</p>;
  const name = shortName(p.clip);
  return (
    <div className={styles.cands} data-candidates="">
      <div className={styles.h}>
        <b>第 {p.index + 1} 段：换成或插在它前面</b>
        <span className={styles.opt}>同站姿、同姿势族 │ {p.options.length} 个 │ 按衔接排</span>
        <span className={styles.sp} />
        {p.loop && (
          <span className={styles.hold}>
            保持
            <Stepper label={`「${name}」保持秒数`} value={p.hold ?? 0} min={0} max={600} step={0.5} big={2} digits={1} disabled={off} onChange={p.onHold} />s
          </span>
        )}
      </div>
      {p.options.length === 0 && <p className={styles.pickHint}>没有同站姿、同姿势族的片段可换</p>}
      <ul className={styles.list} aria-label={`换「${name}」或插在它前面的片段`}>
        {p.options.map((o) => (
          <li key={o.clip} className={styles.cand} data-cand={o.clip}>
            <span className={styles.c} title={o.clip}>
              {shortName(o.clip)}
            </span>
            <span className={styles.g}>
              前 <Gap gap={o.before} />
              {o.after !== undefined && (
                <>
                  {' │ 后 '}
                  <Gap gap={o.after} />
                </>
              )}{' '}
              cm
            </span>
            <span className={styles.l}>{lenText(p.clipOf(o.clip))}</span>
            <span className={styles.sp} />
            <button type="button" className={styles.mini} disabled={off} onClick={() => p.onReplace(o.clip)}>
              换成
            </button>
            <button type="button" className={styles.mini} data-q="" disabled={off} onClick={() => p.onInsert(o.clip)}>
              在此前插入
            </button>
          </li>
        ))}
      </ul>
      {p.ghosts.length > 0 && (
        <>
          <div className={styles.h}>
            <b>8 cm 内能接上的（任何组）</b>
          </div>
          <ul className={styles.list} aria-label="8 cm 内能接上的片段">
            {p.ghosts.map((x) => (
              <li key={x.clip} className={styles.cand} data-ghost={x.clip}>
                <span className={styles.c} title={x.clip}>
                  {shortName(x.clip)}
                </span>
                <span className={styles.g}>
                  接在第 {x.at + 1} 段后 │ <Gap gap={x.gap} /> cm
                </span>
                <span className={styles.l}>{lenText(p.clipOf(x.clip))}</span>
                <span className={styles.sp} />
                <button type="button" className={styles.mini} data-q="" disabled={off} onClick={() => p.onInsertAt(x.at + 1, x.clip)}>
                  插在它后面
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
