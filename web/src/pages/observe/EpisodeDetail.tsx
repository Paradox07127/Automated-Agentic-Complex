import { formatClock, formatDuration, unhidden, type Episode } from '../../domain';
import { Btn, Icon, Plate } from '../../ui';
import type { WireFactRef } from './data';
import { catOf, colorOf, type AppRank } from './model';
import s from './Timeline.module.css';

export interface EpisodeDetailProps {
  episode: Episode | null;
  /** Apps used inside the episode; minutes only with the observation events. */
  apps: Array<{ app: string; minutes: number | null }>;
  memories: WireFactRef[];
  rank: AppRank;
  now: number;
  onMemory: (factId: string) => void;
  onExclude: (app: string) => void;
  onDelete: () => void;
  onEvidence: () => void;
}

/** 02 选中片段（板）：时间段与时长、标题和摘要、使用的应用、生成的记忆（→ 记忆页）、[排除 应用] [删除片段]。 */
export function EpisodeDetail({ episode: e, apps, memories, rank, now, onMemory, onExclude, onDelete, onEvidence }: EpisodeDetailProps) {
  if (!e) {
    return (
      <div className={s.detNone}>
        <span className={s.cap}>点选时间线上的活动片段，查看摘要、使用的应用和生成的记忆</span>
      </div>
    );
  }
  const main = apps[0]?.app;
  return (
    <div className={s.detWrap}>
      <Plate no="02" label="选中片段">
        <div className={s.det}>
          <div className={s.detTime}>
            <span className="num">
              {formatClock(e.start)}–{e.end ? formatClock(e.end) : '现在'}
            </span>
            <span className={`${s.cap} num`}>{formatDuration((e.end ?? now) - e.start)}</span>
          </div>
          <div className={s.detMain}>
            <div className={s.detT} data-selectable="">
              {unhidden(e.title)}
            </div>
            {e.description && (
              <div className={s.detS} data-selectable="">
                {unhidden(e.description)}
              </div>
            )}
            <div className={s.detApps}>
              {apps.map((a) => (
                <span key={a.app} className={s.app}>
                  <i style={{ background: colorOf(catOf(rank, a.app)) }} aria-hidden="true" />
                  {unhidden(a.app)}
                  {a.minutes != null && <span className="num">{a.minutes} 分</span>}
                </span>
              ))}
            </div>
          </div>
          <div className={s.detMem}>
            <div className={s.eb}>
              生成的记忆<span className="num">{memories.length}</span>
            </div>
            {memories.length ? (
              memories.map((m) => (
                <button key={m.fact_id} type="button" className={s.mem} onClick={() => onMemory(m.fact_id)} title="在记忆页打开">
                  <span className={s.memT}>{m.text}</span>
                  <Icon name="chev" size={14} />
                </button>
              ))
            ) : (
              <span className={s.cap}>未生成记忆</span>
            )}
          </div>
          <div className={s.detAct}>
            {main && main !== '<hidden>' && (
              <Btn size="sm" variant="secondary" tail="privacy" onClick={() => onExclude(main)}>
                排除 {main}
              </Btn>
            )}
            <button type="button" className={s.del} onClick={onDelete}>
              <Icon name="del" size={14} />
              删除片段
            </button>
            <button type="button" className={s.quiet} onClick={onEvidence}>
              查看出处
            </button>
          </div>
        </div>
      </Plate>
    </div>
  );
}
