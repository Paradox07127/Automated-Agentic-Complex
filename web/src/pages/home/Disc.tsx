import type { PendingItem, Question } from '../../domain';
import { dangerRuleText } from '../../features/approval';
import type { Go } from '../../shell/nav';
import { Btn, CharacterArt, Icon } from '../../ui';
import type { OverviewSnapshot } from '../overview/load';
import { KIND_LABEL } from '../overview/pending';
import styles from './Home.module.css';

type Approval = PendingItem & { kind: 'approval' };

export interface DiscProps {
  /** 角色's page name. */
  title: string;
  snap: OverviewSnapshot;
  /** What waits on the user now, most urgent first. */
  urgent: readonly PendingItem[];
  act: {
    onApprove: (item: Approval, decision: 'allow' | 'deny' | 'allow_session', reason?: string) => void;
    onAnswer: (item: Question, label: '允许' | '拒绝') => void;
    onReply: (item: Question, answers: Record<string, string[]>) => void;
  };
  go: Go;
}

/** Options one click can answer; a question with more, or several questions, is answered on 工业简报. */
const QUICK = 3;

/** The first waiting item, decided here: an approval by 批准 / 拒绝, a one-question choice by its options. */
function Focus({ item, act, go }: { item: PendingItem; act: DiscProps['act']; go: Go }) {
  const open = () => go({ page: 'overview', sel: item.id, focus: `item-${item.id}` });
  // A call that hit a danger rule is not approved from here in one click: its card on 工业简报 shows the whole command.
  const danger = item.kind !== 'review' && item.dangerous ? dangerRuleText(item.danger_rule ?? '') : null;
  const one = item.kind === 'question' && item.interaction_kind === 'question' && item.questions.length === 1 ? item.questions[0] : undefined;
  return (
    <div className={styles.focus} role="group" aria-label={`${KIND_LABEL[item.kind]}：${item.title}`}>
      <button type="button" className={styles.focusT} onClick={open}>
        <b>{item.title}</b>
        <span>{item.source}</span>
        {danger && <em>命中危险规则：{danger}</em>}
      </button>
      <div className={styles.focusActs}>
        {danger && item.kind !== 'review' ? (
          <>
            <Btn size="sm" variant="secondary" onClick={open}>查看</Btn>
            <Btn size="sm" variant="cancel" onClick={() => (item.kind === 'approval' ? act.onApprove(item, 'deny') : act.onAnswer(item, '拒绝'))}>拒绝</Btn>
          </>
        ) : item.kind === 'approval' ? (
          <>
            <Btn size="sm" variant="primary" onClick={() => act.onApprove(item, 'allow')}>批准</Btn>
            <Btn size="sm" variant="cancel" onClick={() => act.onApprove(item, 'deny')}>拒绝</Btn>
          </>
        ) : item.kind === 'question' && item.interaction_kind === 'approval' ? (
          <>
            <Btn size="sm" variant="primary" onClick={() => act.onAnswer(item, '允许')}>允许</Btn>
            <Btn size="sm" variant="cancel" onClick={() => act.onAnswer(item, '拒绝')}>拒绝</Btn>
          </>
        ) : item.kind === 'question' && one && one.options.length > 0 && one.options.length <= QUICK ? (
          one.options.map((o) => (
            <Btn key={o.label} size="sm" variant="secondary" onClick={() => act.onReply(item, { [one.id]: [o.label] })}>{o.label}</Btn>
          ))
        ) : (
          <Btn size="sm" variant="secondary" onClick={open}>{item.kind === 'review' ? '去复核' : '去回答'}</Btn>
        )}
      </div>
    </div>
  );
}

/** The centre disc over the map: her head, her name, what she is doing, and what waits on the user now, decided in place. */
export function Disc({ title, snap, urgent, act, go }: DiscProps) {
  const role = snap.role;
  const name = snap.character.name ?? title;
  const doing = [role?.app ? `正在看 ${role.app}` : null, role?.doing].filter(Boolean).join(' │ ');
  const [first, ...rest] = urgent;
  return (
    <section className={styles.disc} aria-label={title} data-g="map" data-busy={first ? '' : undefined}>
      <button type="button" className={styles.discHead} aria-label={`${title}：${name}`} onClick={() => go({ page: 'character' })}>
        <span className={styles.portrait} aria-hidden="true">
          <CharacterArt src={snap.character.head ?? undefined} id={snap.character.id} art="card" kind="head" w={first ? 56 : 96} h={first ? 56 : 96} fallback={<Icon name="user" size={32} />} />
        </span>
        {name}
      </button>
      {doing && (
        <p className={styles.role}>
          <span title={doing}>{doing}</span>
        </p>
      )}
      {first && <Focus item={first} act={act} go={go} />}
      {rest.length > 0 && (
        <button type="button" className={styles.row} aria-label={`另有 ${rest.length} 件待处理`} onClick={() => go({ page: 'overview', focus: 'pending' })}>
          <Icon name="hand" size={14} />
          <span className={styles.rowT}>另有 {rest.length} 件</span>
          <Icon name="chev" size={12} />
        </button>
      )}
    </section>
  );
}
