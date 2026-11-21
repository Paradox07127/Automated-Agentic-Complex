import { Btn, CharacterArt } from '../../ui';
import { KvTag } from './Bits';
import styles from './Ready.module.css';

/** Step 4: the character on its desk, a summary, and 打开主窗口 or 完成并打开隐私设置 (both mark the guide done). */
export function Ready({ id, name, title, lead, perm, callName, hooks, busy, onOpen, onPrivacy }: {
  id: string | null;
  name: string;
  title: string;
  lead: string;
  perm: string;
  callName: string;
  hooks: string;
  busy: boolean;
  onOpen: () => void;
  onPrivacy: () => void;
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
          04
        </span>
        <h1 className={styles.h1}>
          {name} {title}
        </h1>
        <p className={styles.lead}>{lead}</p>
        <div className={styles.sum} aria-hidden="true">
          <KvTag k="Perm" v={perm} />
          <KvTag k="Name" v={callName || '未填写'} />
          <KvTag k="Hooks" v={hooks} />
        </div>
        <span className={styles.vh}>
          权限 {perm}，称呼 {callName || '未填写'}，编码工具 {hooks}
        </span>
        <p className={styles.tip}>可以在隐私设置查看「窗口文字」和「读取编码会话」，再决定各自是否开启。</p>
        <div className={styles.go}>
          <Btn variant="primary" size="lg" loading={busy} onClick={onOpen}>
            开始对话
          </Btn>
          <Btn variant="secondary" size="lg" disabled={busy} onClick={onPrivacy}>
            完成并打开隐私设置
          </Btn>
        </div>
      </div>
    </div>
  );
}
