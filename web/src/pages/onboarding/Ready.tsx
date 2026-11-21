import { Btn, CharacterArt } from '../../ui';
import styles from './Ready.module.css';

/** Step 3: the character on its desk, one line, and 打开插件设置 (which completes the guide too). */
export function Ready({ id, name, title, lead, busy, onPlugins }: {
  id: string | null;
  name: string;
  title: string;
  lead: string;
  busy: boolean;
  onPlugins: () => void;
}) {
  return (
    <div className={styles.done}>
      <div className={styles.stage} aria-hidden="true">
        <span className={styles.ctr} />
        <span className={styles.stWm}>{name}</span>
        <span className={styles.fig}>
          <CharacterArt id={id} art="portrait" kind="portrait" w={132} h={180} fallback={null} />
        </span>
        <span className={styles.desk} />
      </div>
      <div className={styles.side}>
        <span className={styles.ghost} aria-hidden="true">
          03
        </span>
        <h1 className={styles.h1}>
          {name} {title}
        </h1>
        <p className={styles.lead}>{lead}</p>
        <div className={styles.go}>
          <Btn variant="secondary" size="lg" disabled={busy} onClick={onPlugins}>
            打开插件设置
          </Btn>
        </div>
      </div>
    </div>
  );
}
