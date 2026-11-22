import type { MmdEntry, MmdListResult } from '../../bridge';
import { ErrBar, Icon, Skel } from '../../ui';
import { motionImportReason } from '../character/labels';
import dark from '../character/Rows.module.css';
import styles from './Page.module.css';

export type MmdState = MmdEntry['characters'][number];

const PENDING: MmdState = { id: '', state: 'pending', reason: null };

/** Her bake state of a dance; a character the library has not reached yet waits for the sync. */
export const stateOf = (e: MmdEntry, character: string): MmdState => e.characters.find((c) => c.id === character) ?? PENDING;

/** Why a dance does not play on her; null once it is baked. */
export const notBaked = (s: MmdState): string | null => (s.state === 'baked' ? null : s.state === 'failed' ? motionImportReason(s.reason ?? '', undefined) : '待同步');

export interface LibraryProps {
  data: MmdListResult | undefined;
  /** `mmd.list` threw: its error code. */
  error: string | null | false;
  onRetry: () => void;
  current: string;
  sel: string | undefined;
  onPick: (e: MmdEntry) => void;
}

/** 舞曲库：每支舞一行，曲名、时长、BGM / 相机、在她身上的状态；点一行选中，已同步的在舞台上预览。 */
export function Library(p: LibraryProps) {
  const d = p.data;
  if (p.error !== false || d?.ok === false)
    return (
      <ErrBar
        message={`读取 MMD 库失败：${p.error === false && d?.ok === false ? motionImportReason(d.reason, d.detail) : p.error === 'not_implemented' ? '这个版本还不支持' : '桌面角色没有回应'}`}
        onRetry={p.onRetry}
      />
    );
  if (!d) return <Skel rows={4} />;
  if (d.entries.length === 0) return null;
  return (
    <ul className={dark.list} aria-label="MMD 舞蹈">
      {d.entries.map((e) => {
        const s = stateOf(e, p.current);
        const why = notBaked(s);
        return (
          <li key={e.id} role="group" aria-label={e.title} data-mmd={e.id} data-state={s.state}>
            <button type="button" className={dark.row} aria-pressed={e.id === p.sel} onClick={() => p.onPick(e)}>
              <span className={dark.lead}>{why == null && <Icon name="play" size={16} />}</span>
              <span className={`${dark.main} ${styles.entry}`}>
                <span className={dark.nm}>{e.title}</span>
                <span className={`${dark.meta} ${styles.meta}`}>
                  <span className="num">{`${e.durationS.toFixed(1)} s`}</span>
                  {e.hasBgm && <span className={styles.tag}>BGM</span>}
                  {e.hasCamera && <span className={styles.tag}>相机</span>}
                </span>
                {why != null && (
                  <span className={styles.why} data-tone={s.state === 'failed' ? 'danger' : undefined}>
                    {why}
                  </span>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
