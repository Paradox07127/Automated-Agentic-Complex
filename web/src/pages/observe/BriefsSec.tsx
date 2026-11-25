import { useState, type ReactNode } from 'react';
import { toast } from '../../shell/toast';
import { Btn, ErrBar, Fold, Region, Sheet, Skel } from '../../ui';
import { briefError, useBrief, useBriefs, type Brief, type BriefStatus } from './useBriefs';
import s from './Briefs.module.css';
import { BriefHealth } from './BriefHealth';

const PERIOD: Readonly<Record<string, string>> = { daily: '日报', weekly: '周报' };
const STATE: Readonly<Record<string, string>> = {
  completed: '已生成',
  queued: '排队中',
  running: '生成中',
  scheduled: '已排队',
  empty: '该时段无可用内容',
  interrupted: '生成中断',
  cancelled: '已取消',
  dismissed: '已隐藏',
};
const SOURCE: Readonly<Record<string, string>> = { segment: '任务片段', episode: '活动片段', work_event: '工作记录' };

/** `2026-10-28` as 10月28日; a weekly's date is its Monday. */
function dateLabel(period: string, date: string): string {
  const [, m = 0, d = 0] = date.split('-').map(Number);
  return period === 'weekly' ? `${m}月${d}日起一周` : `${m}月${d}日`;
}

type Ev = Brief['observed_details'][number]['evidence'];

function Evidence({ refs }: { refs: Ev }) {
  return (
    <ul className={s.ev}>
      {refs.map((r, i) => (
        <li key={i}>
          <span className={s.cap}>{SOURCE[r.source_id.split(':')[0] ?? ''] ?? '来源'}</span>
          <span className={s.quote} data-selectable="">
            「{r.quote}」
          </span>
        </li>
      ))}
    </ul>
  );
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className={s.eb}>{title}</div>
      <ul className={s.items}>{children}</ul>
    </div>
  );
}

/** The report as agentd returned it: plain text and its quoted evidence, no links. */
function BriefBody({ b }: { b: BriefStatus }) {
  if (b.state !== 'completed') return <p className={s.cap}>{STATE[b.state] ?? '此简报暂不可读'}</p>;
  const details = b.observed_details ?? [];
  const problems = b.recurring_problems ?? [];
  const steps = b.next_steps ?? [];
  const unknowns = b.unknowns ?? [];
  return (
    <div className={s.body}>
      <p className={s.cap}>
        {PERIOD[b.period ?? ''] ?? '简报'} │ {dateLabel(b.period ?? '', b.date ?? '')} │ 抽样 <span className="num">{b.coverage?.source_count ?? 0}</span> 条记录（非完整使用记录）
      </p>
      {details.length > 0 && (
        <Part title="观察细节">
          {details.map((x, i) => (
            <li key={i} className={s.item}>
              <span className={s.text} data-selectable="">
                {x.detail}
              </span>
              <Evidence refs={x.evidence} />
            </li>
          ))}
        </Part>
      )}
      {problems.length > 0 && (
        <Part title="反复出现的问题">
          {problems.map((x, i) => (
            <li key={i} className={s.item}>
              <span className={s.text} data-selectable="">
                {x.problem}
              </span>
              <span className={s.sub} data-selectable="">
                改进：{x.optimization}
              </span>
              <Evidence refs={x.evidence} />
            </li>
          ))}
        </Part>
      )}
      {steps.length > 0 && (
        <Part title="下一步建议">
          {steps.map((x, i) => (
            <li key={i} className={s.item}>
              <span className={s.text} data-selectable="">
                {x.action}
              </span>
              <span className={s.sub} data-selectable="">
                依据：{x.reason}
              </span>
              <Evidence refs={x.evidence} />
            </li>
          ))}
        </Part>
      )}
      {unknowns.length > 0 && (
        <Part title="信息存疑部分">
          {unknowns.map((x, i) => (
            <li key={i} className={s.item}>
              <span className={s.text} data-selectable="">
                {x}
              </span>
            </li>
          ))}
        </Part>
      )}
      <p className={s.cap}>建议仅供参考，不会自动执行，亦不会写入记忆。</p>
    </div>
  );
}

function BriefSheet({ id, onClose, onDismiss }: { id: string | null; onClose: () => void; onDismiss: (id: string) => Promise<void> }) {
  const q = useBrief(id);
  const [busy, setBusy] = useState(false);
  const dismiss = async () => {
    if (!id) return;
    setBusy(true);
    try {
      await onDismiss(id);
      toast('已隐藏此简报');
      onClose();
    } catch (e) {
      toast(`操作未完成：${briefError(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={id != null} title="简报" width={480} onClose={onClose}>
      <div className={s.sheet}>
        {q.isError ? <ErrBar message={briefError(q.error)} onRetry={() => void q.refetch()} /> : q.data ? <BriefBody b={q.data} /> : <Skel rows={5} />}
        <div>
          <Btn size="sm" variant="ghost" loading={busy} onClick={() => void dismiss()}>
            不再显示
          </Btn>
        </div>
      </div>
    </Sheet>
  );
}

/** 简报（/observation/briefs）：角色根据观察写的日报和周报，新的在前。 */
export function BriefsSec({ no }: { no: string }) {
  const b = useBriefs();
  const [open, setOpen] = useState<string | null>(null);
  // A report agentd no longer lists closes its sheet.
  const shown = open != null && b.reports.some((r) => r.id === open) ? open : null;
  const [busy, setBusy] = useState(false);
  const hour = `${String(b.settings?.hour ?? 9).padStart(2, '0')}:00`;
  const generate = async () => {
    setBusy(true);
    try {
      await b.generate();
      toast('已开始生成前一日的日报，完成后将在此显示');
    } catch (e) {
      toast(`生成失败：${briefError(e)}`);
    } finally {
      setBusy(false);
    }
  };
  // BriefHealth shows the latest daily and weekly attempt when it failed.
  const failed = ['daily', 'weekly'].some((period) => ['failed', 'interrupted'].includes(b.list.data?.attempts?.find((a) => a.period === period)?.state ?? ''));
  return (
    <Fold
      id="briefs"
      variant="head"
      label="简报"
      head={{ no }}
      defaultOpen
      autoOpen={b.list.status === 'error' || failed}
      right={
        <>
          {b.list.data !== undefined && <span className={`${s.cap} num`}>{b.reports.length} 份</span>}
          <Btn size="sm" variant="text" loading={busy} onClick={() => void generate()}>
            立即生成
          </Btn>
        </>
      }
    >
      <Region q={b.list} what="简报" reserve={{ rows: 2 }} isEmpty={() => b.reports.length === 0} empty={{ text: `尚无简报。开启观察后，每日 ${hour} 起将基于前一日的观察记录自动生成` }}>
        {() => (
          <ul className={s.rows}>
            {b.reports.map((r) => (
              <li key={r.id}>
                <button type="button" className={s.row} onClick={() => setOpen(r.id)}>
                  <span className={s.rowT}>
                    {PERIOD[r.period] ?? '简报'} │ {dateLabel(r.period, r.date)}
                  </span>
                  <span className={s.cap}>{STATE[r.state] ?? '其他状态'}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Region>
      <BriefHealth attempts={b.list.data?.attempts} onRetry={b.generate} />
      <BriefSheet id={shown} onClose={() => setOpen(null)} onDismiss={b.dismiss} />
    </Fold>
  );
}
