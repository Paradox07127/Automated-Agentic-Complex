import { useState } from 'react';
import { getBridge, type SayResult } from '../../../bridge';
import { Btn } from '../../../ui/Btn';
import type { PresenceThought } from '../tags/presence';
import type { Ritual } from '../tags/useRitual';
import { RadioIcon } from './HeadCard';
import { why, type ThoughtMute } from './useThoughtMute';
import styles from './Bubble.module.css';

type Offer = 'idle' | 'busy' | 'sent' | { failed: string };

const RITUAL: Readonly<Record<string, string>> = { break: '久坐提醒', water: '喝水提醒', birthday: '生日', morning: '早安', report: '今日汇报' };

function sayFailure(r: Extract<SayResult, { ok: false }>): string {
  if (r.reason === 'agentd') return '后台服务没有运行';
  if (r.reason === 'kernel') return '角色内核未就绪';
  return r.detail ?? '后台不接受这条';
}

/**
 * 想法: her latest thought beside the radio icon at half strength, with her offer (sent as the user's 好 through `desktop.say`) and a ritual she may
 * claim as its suggested action. Muted, it shows 撤销 for a few seconds, then nothing.
 */
export function Thought({ thought, ritual, mute, composing }: { thought: PresenceThought | null; ritual: Ritual | null; mute: ThoughtMute; composing: boolean }) {
  const [offer, setOffer] = useState<{ id: string; state: Offer } | null>(null);
  const [claim, setClaim] = useState<{ ritual: Ritual; state: Offer } | null>(null);
  const m = mute.mute;
  if (m?.phase === 'undo')
    return (
      <div className={styles.main} data-kind="thought">
        <p className={styles.note}>
          已关闭想法，以后不再显示
          <Btn variant="text" size="sm" onClick={() => void mute.undo(m.before)}>
            撤销
          </Btn>
        </p>
      </div>
    );

  const shown = thought && !mute.closed ? thought : null;
  if (!shown && !ritual) return null;
  const sent = shown && offer?.id === shown.id ? offer.state : 'idle';
  const claimed = claim && claim.ritual.kind === ritual?.kind && claim.ritual.since === ritual.since ? claim.state : 'idle';

  const send = async (at: string, text: string) => {
    setOffer({ id: at, state: 'busy' });
    let r: SayResult;
    try {
      r = await getBridge().desktop.say({
        text,
        attachWindow: false,
        noMemory: false,
        surface: 'thought_offer',
        replyTo: { kind: 'thought', id: at },
      });
    } catch (e) {
      r = { ok: false, reason: 'rejected', detail: why(e) };
    }
    setOffer({ id: at, state: r.ok ? 'sent' : { failed: sayFailure(r) } });
  };

  const offered = shown?.offer && shown.reply ? shown : null;
  const claimRitual = async (pending: Ritual) => {
    setClaim({ ritual: pending, state: 'busy' });
    try {
      await getBridge().desktop.action('claimRitual');
      setClaim({ ritual: pending, state: 'sent' });
    } catch (e) {
      setClaim({ ritual: pending, state: { failed: why(e) } });
    }
  };
  return (
    <div className={styles.main} data-kind="thought">
      {shown && (
        <div className={styles.row}>
          <RadioIcon className={styles.radio} />
          <p key={shown.id} className={`${styles.text} ${styles.fade}`}>
            {shown.text}
          </p>
        </div>
      )}
      {!composing && (offered || ritual) && (
        <div className={styles.btns}>
          {offered &&
            (sent === 'sent' ? (
              <span className={styles.note}>已发给她</span>
            ) : (
              <Btn variant="primary" size="sm" loading={sent === 'busy'} onClick={() => void send(offered.id, offered.reply ?? '')}>
                {offered.offer}
              </Btn>
            ))}
          {ritual && claimed === 'sent' && <span role="status" className={styles.note}>已请角色回应</span>}
          {ritual && claimed !== 'sent' && (
            <Btn variant="secondary" size="sm" icon="redeem" loading={claimed === 'busy'} onClick={() => void claimRitual(ritual)}>
              {RITUAL[ritual.kind] ?? '仪式'}
            </Btn>
          )}
        </div>
      )}
      {typeof sent === 'object' && <p className={styles.err}>没能发给她：{sent.failed}</p>}
      {typeof claimed === 'object' && <p className={styles.err} role="alert">{claimed.failed}</p>}
      {m?.phase === 'failed' && <p className={styles.err}>{m.text}</p>}
    </div>
  );
}
