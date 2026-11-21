import type { VoiceTrial } from '../../bridge';
import { Btn, Plate } from '../../ui';
import { settingPath } from '../settings/groups';
import { GuideRing } from './Bits';
import { type Perm } from './copy';
import { PermRow } from './Perms';
import styles from './Steps.module.css';

const FLAT = 44;

export interface Profile {
  callName: string;
  birthday: string;
}

/** Step 2: the microphone row, a push-to-talk try (levels, time, transcript) and the user's call name. */
export function VoiceStep({ mic, trial, keycap, profile, onProfile, onOpen, onRequest }: {
  mic: Perm | undefined;
  trial: VoiceTrial;
  keycap: string;
  profile: Profile;
  onProfile: (p: Profile) => void;
  onOpen: (p: Perm) => void;
  onRequest: () => void;
}) {
  const tried = trial.transcript !== '' || trial.levels.length > 0;
  const levels = trial.levels.length > 0 ? trial.levels : Array.from({ length: FLAT }, () => 2);
  return (
    <div className={styles.voice}>
      {mic && <PermRow p={mic} ring={mic.state === 'denied'} onOpen={() => onOpen(mic)} />}
      {mic?.state === 'undetermined' && (
        <span className={styles.target}>
          <Btn size="sm" variant="secondary" onClick={onRequest}>
            允许麦克风
          </Btn>
          <GuideRing />
        </span>
      )}
      {mic?.state === 'denied' ? (
        <div className={styles.micNo} role="alert">
          <span className={styles.micX} aria-hidden="true">
            ⊘
          </span>
          <div>
            <b>按住说话不可用</b>
            <div className={styles.cap}>在系统设置中打开麦克风，返回后自动重新检查。</div>
          </div>
        </div>
      ) : (
        <Plate label="试用按住说话">
          <div className={styles.trial}>
            <div className={styles.trialHead}>
              {keycap ? (
                <>
                  按住 <kbd className={styles.key}>{keycap}</kbd> 说一句话，松开后发送
                </>
              ) : (
                `还没设置按住说话的热键，可在 ${settingPath('keys')} 中设置`
              )}
            </div>
            <div className={styles.rec}>
              <span className={styles.recTag} aria-hidden="true">
                [ REC ]
              </span>
              <span className={styles.wave} aria-hidden="true">
                {levels.map((v, i) => (
                  <i key={i} style={{ height: `${Math.max(2, Math.min(22, v))}px` }} />
                ))}
              </span>
              <span className={styles.num} aria-label={`时长 ${trial.elapsed}`}>
                {trial.elapsed}
              </span>
            </div>
            <div className={styles.said} aria-live="polite" data-selectable={tried || undefined}>
              {trial.transcript || <span className={styles.t3}>{keycap ? `按住 ${keycap} 试说` : '设置热键后可在这里试说'}</span>}
              <i className={styles.cursor} aria-hidden="true" />
            </div>
            <div className={styles.cap}>转写在本机完成 │ 此句不发送给任何会话{keycap && ` │ 热键可在 ${settingPath('keys')} 中更换`}</div>
          </div>
        </Plate>
      )}
      <div className={styles.subHead}>
        用户称呼<span className={styles.cap}>存为「用户确认」，可在 记忆 中修改</span>
      </div>
      <label className={styles.field}>
        <span>名字</span>
        <input className={styles.input} value={profile.callName} placeholder="例如 阿砚" maxLength={40} onChange={(e) => onProfile({ ...profile, callName: e.target.value })} />
      </label>
      <label className={styles.field}>
        <span>
          生日 <small className={styles.t3}>选填</small>
        </span>
        <input className={`${styles.input} ${styles.num}`} value={profile.birthday} placeholder="月-日" maxLength={10} onChange={(e) => onProfile({ ...profile, birthday: e.target.value })} />
      </label>
    </div>
  );
}
