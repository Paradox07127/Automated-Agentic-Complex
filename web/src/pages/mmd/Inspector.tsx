import type { ReactNode } from 'react';
import type { CharacterEntry, MmdDetail, MmdEntry } from '../../bridge';
import { Btn } from '../../ui';
import { MicroLabel } from '../../ui/game';
import { motionImportReason } from '../character/labels';
import { stateOf } from './Library';
import styles from './Inspector.module.css';

/** How many unmapped morph names the inspector spells out. */
const UNMAPPED_SHOWN = 4;

const offsetText = (s: number) => `偏移 ${s < 0 ? '−' : s > 0 ? '+' : ''}${Math.abs(s).toFixed(3)} s`;

const STATE_TEXT = { baked: '已同步', pending: '待同步' } as const;

interface InspectorProps {
  entry: MmdEntry;
  /** `mmd.detail` of it; null while it is read, when no character has it baked, and when the read failed. */
  detail: MmdDetail | null;
  roster: CharacterEntry[];
  editOff: string | null;
  onMedia: () => void;
  onRename: () => void;
  onRemove: () => void;
}

/** 检查器「这支舞」：动作文件、口型、镜头、音源、每个角色的同步、没对上的表情；底下换音源、改名、删除。没有的项不画。 */
export function Inspector({ entry, detail, roster, editOff, onMedia, onRename, onRemove }: InspectorProps) {
  const face = detail?.face;
  const cam = detail?.camera;
  const bgm = detail?.bgm;
  const unmapped = face?.unmapped ?? [];
  return (
    <section className={styles.insp} data-theme="dark" aria-label="当前舞蹈" data-mmd-detail={entry.id}>
      <div className={styles.ihd}>
        <h3>当前舞蹈</h3>
        <MicroLabel>DANCE / DETAIL</MicroLabel>
      </div>
      <dl className={styles.facts}>
        {detail?.source != null && (
          <Fact k="动作" at="source">
            <span className={styles.file} title={detail.source}>
              {detail.source}
            </span>
          </Fact>
        )}
        {face && (
          <Fact k="口型" at="face">
            <span>
              <b className={styles.y}>{face.mapped.length}</b> 种表情已映射
            </span>
            <span className={styles.m}>{face.blinkFromDance ? '沿用舞蹈眨眼动作' : '自动眨眼'}</span>
          </Fact>
        )}
        {cam && (
          <Fact k="镜头" at="camera">
            <span>
              <b className={styles.y}>{cam.cuts.length}</b> 次切镜
            </span>
            <span className={styles.m}>{`视场角 ${Math.round(cam.fovDeg[0])}–${Math.round(cam.fovDeg[1])}°`}</span>
          </Fact>
        )}
        {bgm && (
          <Fact k="音频" at="bgm">
            <span className={styles.file} title={bgm.name}>
              {bgm.name}
            </span>
            {bgm.offsetS != null && <span className={styles.m}>{offsetText(bgm.offsetS)}</span>}
          </Fact>
        )}
        <Fact k="角色" at="characters">
          <ul className={styles.who} aria-label="角色同步">
            {roster.map((c) => {
              const s = stateOf(entry, c.id);
              const why = s.state === 'failed' ? motionImportReason(s.reason ?? '', undefined) : null;
              return (
                <li key={c.id} className={styles.ch} data-state={s.state} title={why ?? undefined}>
                  <span className={styles.av} aria-hidden="true">
                    {c.head && <img src={c.head} alt="" onError={(ev) => void (ev.currentTarget.hidden = true)} />}
                  </span>
                  <span className={styles.chn}>{c.name}</span>
                  <span className={styles.st}>{why ?? STATE_TEXT[s.state as 'baked' | 'pending']}</span>
                </li>
              );
            })}
          </ul>
        </Fact>
        {unmapped.length > 0 && (
          <Fact k="未映射表情" at="unmapped">
            <span className={styles.miss} title={unmapped.join('、')}>
              <span className="num">{unmapped.length}</span> 种：{unmapped.slice(0, UNMAPPED_SHOWN).join('、')}
              {unmapped.length > UNMAPPED_SHOWN ? '…' : ''}
            </span>
          </Fact>
        )}
      </dl>
      <div className={styles.ops} role="group" aria-label="MMD 操作">
        <Btn variant="secondary" icon="voice" label="更换音频" disabled={editOff != null} disabledReason={editOff ?? ''} onClick={onMedia}>
          更换音频
        </Btn>
        <Btn variant="secondary" icon="g-rename" label="重命名" disabled={editOff != null} disabledReason={editOff ?? ''} onClick={onRename}>
          重命名
        </Btn>
        <Btn variant="secondary" icon="del" label="删除" disabled={editOff != null} disabledReason={editOff ?? ''} onClick={onRemove}>
          删除
        </Btn>
      </div>
    </section>
  );
}

function Fact({ k, at, children }: { k: string; at: string; children: ReactNode }) {
  return (
    <div className={styles.fact} data-fact={at}>
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}
