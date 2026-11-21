import type { CSSProperties, ReactNode, Ref } from 'react';
import { formatClock } from '../../../domain';
import { Icon } from '../../../ui';
import { minutesLeft, ringTip, type BackgroundItem, type ResultItem, type RingKey, type RingModel } from './items';
import styles from './RingPop.module.css';

const TITLE: Record<RingKey, string> = { reminders: '提醒', results: '结果', background: '后台', quiet: '免打扰', passthrough: '全局点穿', voice: '语音', observation: '观察' };

/** The small card outside a clicked icon, a tips card; the ring's one `data-glass` card rect. */
export interface RingPopProps {
  which: RingKey;
  model: RingModel;
  now: number;
  /** A line under the rows: what the last button did, or why it failed. */
  note: string | null;
  boxRef: Ref<HTMLElement>;
  style: CSSProperties;
  onClose: () => void;
  onReminder: (id: string, how: 'complete' | 'snooze') => void;
  onResult: (item: ResultItem, how: 'open' | 'drop') => void;
  onEnd: (which: 'quiet' | 'passthrough') => void;
  /** Run ids whose 取消 was sent; their rows stay until presence drops them. */
  cancelling: ReadonlySet<string>;
  onCancel: (item: BackgroundItem) => void;
}

function Row({ title, sub, item = false, children }: { title: string; sub: string; item?: boolean; children?: ReactNode }) {
  return (
    <div className={styles.row} data-ring-row="" role={item ? 'listitem' : undefined}>
      <p className={styles.ttl}>{title}</p>
      {sub && <p className={styles.sub}>{sub}</p>}
      {children && <div className={styles.acts}>{children}</div>}
    </div>
  );
}

function Btn({ primary = false, disabled, label, onClick, children }: { primary?: boolean; disabled?: boolean; label?: string; onClick: () => void; children: string }) {
  return (
    <button type="button" className={primary ? `${styles.btn} ${styles.pri}` : styles.btn} disabled={disabled} aria-label={label} onClick={onClick}>
      {children}
    </button>
  );
}

export function RingPop({ which, model, now, note, boxRef, style, onClose, onReminder, onResult, onEnd, cancelling, onCancel }: RingPopProps) {
  let count: number | null = null;
  let rows: ReactNode = null;
  if (which === 'reminders' && model.reminders) {
    count = model.reminders.count;
    rows = model.reminders.items.map((r) => (
      <Row key={r.id} title={r.text} sub={[r.dueAt > 0 ? formatClock(r.dueAt) : '', r.due ? '已到点' : ''].filter(Boolean).join(' │ ')}>
        <Btn primary onClick={() => onReminder(r.id, 'complete')}>
          完成
        </Btn>
        <Btn onClick={() => onReminder(r.id, 'snooze')}>稍后 10 分</Btn>
      </Row>
    ));
  } else if (which === 'results' && model.results) {
    count = model.results.count;
    rows = model.results.items.map((r) => (
      <Row key={r.id} title={r.title} sub={r.sub}>
        {r.open && (
          <Btn primary onClick={() => onResult(r, 'open')}>
            打开
          </Btn>
        )}
        <Btn onClick={() => onResult(r, 'drop')}>不用了</Btn>
      </Row>
    ));
  } else if (which === 'quiet' && model.quiet) {
    rows = (
      <Row title={`还剩 ${minutesLeft(model.quiet.until - now)} 分钟`} sub={`到 ${formatClock(model.quiet.until)} 结束`}>
        <Btn onClick={() => onEnd('quiet')}>结束</Btn>
      </Row>
    );
  } else if (which === 'passthrough' && model.passthrough) {
    rows = (
      <Row title="点击会穿过所有浮窗" sub="落到下面的应用上">
        <Btn onClick={() => onEnd('passthrough')}>结束</Btn>
      </Row>
    );
  } else if (which === 'background' && model.background && model.background.items.length > 0) {
    count = model.background.count;
    rows = (
      <div role="list" aria-label="后台运行">
        {model.background.items.map((r) => (
          <Row key={r.runId} item title={r.title} sub="">
            <Btn disabled={cancelling.has(r.runId)} label={`取消${r.title}`} onClick={() => onCancel(r)}>
              {cancelling.has(r.runId) ? '正在取消' : '取消'}
            </Btn>
          </Row>
        ))}
      </div>
    );
  } else if ((which === 'background' && model.background) || (which === 'voice' && model.voice) || (which === 'observation' && model.observationPaused)) {
    rows = <Row title={ringTip(which, model)} sub="" />;
  }
  return (
    <section ref={boxRef} className={styles.pop} data-ring-pop={which} data-glass="" data-region="" style={style} aria-label={TITLE[which]}>
      <header className={styles.head}>
        <h2>
          {TITLE[which]}
          {count != null && <span className={`${styles.n} num`}>{count}</span>}
        </h2>
        <button type="button" className={styles.close} onClick={onClose} aria-label={`关闭${TITLE[which]}详情`}>
          <Icon name="close" size={16} />
        </button>
      </header>
      <div className={styles.body}>{rows}</div>
      {note && (
        <p className={styles.note} role="status">
          {note}
        </p>
      )}
    </section>
  );
}
