import common from '../../charts/chart.module.css';
import { critOf, fmtMs, TI_SPAN, type TiSpan, type TurnTrace } from './turnTrace';
import styles from './TurnWaterfall.module.css';

const STEPS = [10, 20, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10_000, 20_000, 30_000, 60_000];
const stTxt = (s: TiSpan) => (s.st === 'fail' ? '失败' : s.st === 'cut' ? '已打断' : '完成');

/** Waterfall: a ruler on top; thin single-colour bars, the longest top-level span in the accent; children indented; the first token is a diamond on the model row. */
export function TurnWaterfall({ tr, wide }: { tr: TurnTrace; wide?: boolean }) {
  const span = Math.max(1, tr.ms);
  const X = (t: number) => (t / span) * 100;
  const step = STEPS.find((s) => span / s <= 4) ?? span;
  const ticks: number[] = [];
  for (let t = 0; t <= span; t += step) ticks.push(t);
  const crit = critOf(tr);
  const label = `瀑布：${tr.spans.map((s) => `${TI_SPAN[s.id][0]} ${fmtMs(s.dur)}`).join('，')}${crit ? `；最长环节 ${TI_SPAN[crit.id][0]}` : ''}`;
  return (
    <div className={styles.wf} role="list" aria-label={label} data-wide={wide || undefined}>
      <div className={styles.r} data-ax="" aria-hidden="true">
        <span />
        <span className={styles.t}>
          {ticks.map((t) => (
            <i key={t} className={styles.rk} style={{ left: `${X(t)}%` }} />
          ))}
          {ticks.map((t) => (
            <span key={`l${t}`} className={styles.tl} style={{ left: `${X(t)}%` }}>
              {t === 0 ? '0' : fmtMs(t)}
            </span>
          ))}
        </span>
        <span />
      </div>
      {tr.spans.map((s) => (
        <div key={s.id} className={styles.r} role="listitem" data-kid={s.parent ? '' : undefined} data-st={s.st !== 'ok' ? s.st : undefined} data-em={s === crit || undefined}>
          <span className={styles.l}>
            {s.parent && <i className={styles.br} aria-hidden="true" />}
            {TI_SPAN[s.id][0]}
          </span>
          <span className={styles.t}>
            {ticks.map((t) => (
              <i key={t} className={styles.g} style={{ left: `${X(t)}%` }} />
            ))}
            <span
              className={`${styles.b} ${common.tip}`}
              style={{ left: `${X(s.t0)}%`, width: `max(2px, ${X(s.dur)}%)` }}
              data-tip={`${TI_SPAN[s.id][0]} │ ${stTxt(s)}${s === crit ? ' │ 最长环节' : ''}\n开始 +${fmtMs(s.t0)} │ 耗时 ${fmtMs(s.dur)}`}
            />
            {s.id === 'model' && tr.ttft != null && (
              <span className={`${styles.tt} ${common.tip}`} style={{ left: `${X(tr.ttft)}%` }} data-tip={`首字 +${fmtMs(tr.ttft)}`}>
                <b aria-hidden="true" />
              </span>
            )}
          </span>
          <span className={styles.v} data-fail={s.st === 'fail' || undefined}>
            {s.st === 'fail' ? '■ ' : ''}
            {fmtMs(s.dur)}
          </span>
        </div>
      ))}
      {tr.ttft != null && tr.spans.some((s) => s.id === 'model') && <span className={styles.ttline} style={{ ['--x' as string]: X(tr.ttft) / 100 }} aria-hidden="true" />}
    </div>
  );
}
