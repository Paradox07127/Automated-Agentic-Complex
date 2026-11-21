import { useEffect, useState, type ReactNode } from 'react';
import common from '../../charts/chart.module.css';
import { ChartState, type ChartStatus } from '../../charts';
import { navigate } from '../../shell/nav';
import { Icon, Pill, Plate, type PillProps } from '../../ui';
import { critOf, fmtMs, OUTCOME_LABEL, TERMINAL_LABEL, TI_SPAN, TI_SRC, type TurnRes, type TurnTrace } from './turnTrace';
import { TurnWaterfall } from './TurnWaterfall';
import styles from './TurnInspector.module.css';
import xs from './TurnInspectorMore.module.css';

export interface TurnInspectorProps {
  /** The turn; null while loading or when nothing is picked. */
  tr: TurnTrace | null;
  /** Diag page: every section open side by side, only the event table folds. */
  wide?: boolean;
  st?: ChartStatus;
  /** When the shown data stopped updating (error / disconnected). */
  stopAt?: number;
  onRetry?: () => void;
  emptyText?: string;
}

const RES_TONE: Readonly<Record<TurnRes, PillProps['tone']>> = { 成功: 'success', 失败: 'danger', 打断: 'attention', 跳过: 'neutral', 进行中: 'info', 待确认: 'attention', 仅生成文字: 'neutral', 回执不全: 'attention' };
const MOTION_PHASE: Readonly<Record<string, string>> = { accepted: '宿主已接受', running: '执行中', completed: '已完成', cancelled: '已取消', interrupted: '已中断', rejected: '宿主拒绝', blocked: '执行受阻' };
const pad2 = (n: number) => String(n).padStart(2, '0');

function Sh({ no, t, right }: { no: string; t: string; right?: ReactNode }) {
  return (
    <div className={styles.sh}>
      <span className={styles.shNo} aria-hidden="true">
        {no}
      </span>
      <h4>{t}</h4>
      {right && <span className={styles.shR}>{right}</span>}
    </div>
  );
}

/** 轮次详情: head plate, 01 瀑布, 02 引用记忆, 03 判断, 04 模型; 观察, 动作 and the event table fold into 「更多」. The diag page passes `wide`. */
export function TurnInspector({ tr, wide, st = 'ok', stopAt, onRetry, emptyText = '选择一轮以查看详情' }: TurnInspectorProps) {
  const [more, setMore] = useState(false);
  const id = tr?.id;
  useEffect(() => setMore(false), [id]);
  if (st !== 'ok' || !tr) {
    return (
      <div className={styles.ti}>
        <ChartState state={tr ? st : st === 'ok' ? 'empty' : st} emptyText={emptyText} height={150} {...(stopAt != null ? { stoppedAt: stopAt } : {})} {...(onRetry ? { onRetry } : {})}>
          <span />
        </ChartState>
      </div>
    );
  }
  const m = tr.model;
  const fresh = m ? Math.max(0, m.in - (m.cache ?? 0)) : 0;
  const total = m ? m.in + m.out : 0;
  const picked = tr.judge.find((j) => j.k === tr.pick);
  const crit = critOf(tr);

  const head = (
    <Plate no="Turn"label={tr.no > 0 ? `第 ${tr.no} 轮` : '轮次记录'}>
      <div className={styles.head}>
        {tr.no > 0 && <span className={styles.no}>
          <span className={styles.vh}>第 {tr.no} 轮</span>
          <b aria-hidden="true">{pad2(tr.no)}</b>
        </span>}
        <span className={styles.hm}>
          <span className={styles.hl}>
            <span className={styles.ms}>{fmtMs(tr.ms)}</span>
            <Pill tone={RES_TONE[tr.res]}>{tr.res}</Pill>
            <Pill tone={tr.src === 'user' ? 'paper' : 'neutral'}>{TI_SRC[tr.src]}</Pill>
          </span>
          <span className={`${styles.cap} ${styles.num}`}>
            {tr.t} │ {tr.events.length} 条事件{tr.ttft != null ? ` │ 首字 ${fmtMs(tr.ttft)}` : ''}
          </span>
          {tr.turnState && <span className={styles.cap}>运行终态 │ {TERMINAL_LABEL[tr.turnState] ?? tr.turnState}</span>}
          {tr.turnOutcome && <span className={styles.cap}>任务结果 │ {OUTCOME_LABEL[tr.turnOutcome] ?? tr.turnOutcome}</span>}
        </span>
      </div>
    </Plate>
  );
  const wf = (
    <section className={styles.s}>
      <Sh
        no="01"
        t="瀑布"
        right={
          <>
            {crit && (
              <span>
                <i className={styles.lgEm} aria-hidden="true" />
                最长 {TI_SPAN[crit.id][0]}
              </span>
            )}
            {tr.ttft != null && (
              <span>
                <span className={styles.lgTt} aria-hidden="true">
                  ◆
                </span>
                首字 <span className={styles.num}>{fmtMs(tr.ttft)}</span>
              </span>
            )}
          </>
        }
      />
      <TurnWaterfall tr={tr} wide={wide} />
    </section>
  );
  const mem = (
    <section className={styles.s}>
      <Sh no="02" t="引用记忆" right={<span className={styles.num}>{tr.mems.length} 条</span>} />
      <div className={styles.pills}>
        {tr.mems.map((f) => (
          <button type="button" key={f.id} className={`${styles.pill} ${common.tip}`} data-tip="在记忆中打开" onClick={() => navigate({ page: 'memory', view: 'about', sel: f.id })}>
            <i aria-hidden="true" />
            <span className={styles.pt}>{f.text}</span>
          </button>
        ))}
        {tr.learned.map((f) => (
          <button type="button" key={`l${f.id}`} className={`${styles.pill} ${common.tip}`} data-new="" data-tip="本轮新增的记忆" onClick={() => navigate({ page: 'memory', view: 'about', sel: f.id })}>
            <b>+ 新增</b>
            <span className={styles.pt}>{f.text}</span>
          </button>
        ))}
        {tr.mems.length === 0 && tr.learned.length === 0 && <span className={styles.cap}>—</span>}
      </div>
    </section>
  );
  const judge = (
    <section className={styles.s}>
      <Sh no="03" t="判断" right={picked ? <span>选中「{picked.l}」</span> : undefined} />
      {tr.judge.length > 0 ? (
        <div className={styles.jg} role="list" aria-label={`判断：${tr.judge.map((j) => `${j.l} ${j.p.toFixed(2)}`).join('，')}${picked ? `，选中${picked.l}` : ''}`}>
          {tr.judge.map((j) => (
            <div key={j.k} role="listitem" className={styles.j} data-on={j === picked || undefined}>
              <span className={styles.jl}>{j.l}</span>
              <span className={styles.jt}>
                <i style={{ width: `${Math.min(1, Math.max(0, j.p)) * 100}%` }} />
              </span>
              <span className={`${styles.jv} ${styles.num}`}>{j.p.toFixed(2)}</span>
              <span className={styles.jp} aria-hidden="true">
                {j === picked ? '◀' : ''}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <span className={styles.cap}>—</span>
      )}
    </section>
  );
  const model = (
    <section className={styles.s}>
      <Sh no="04" t="模型" right={m ? <span className={styles.cost}>{m.cost == null ? '未计价' : `$${m.cost.toFixed(3)}`}</span> : undefined} />
      {m ? (
        <div className={styles.m}>
          <span className={styles.mn}>{m.name}</span>
          <span className={styles.mb} role="img" aria-label={`${m.cache != null ? `新输入 ${fresh}，缓存 ${m.cache}` : `输入 ${m.in}`}，输出 ${m.out} token`}>
            <i className={`${styles.a} ${common.tip}`} style={{ flexGrow: fresh }} data-tip={`${m.cache != null ? '新输入' : '输入'} ${fresh}`} />
            {m.cache != null && <i className={`${styles.b} ${common.tip}`} style={{ flexGrow: m.cache }} data-tip={`缓存 ${m.cache}`} />}
            <i className={`${styles.c} ${common.tip}`} style={{ flexGrow: Math.max(m.out, total * 0.02) }} data-tip={`输出 ${m.out}`} />
          </span>
          <span className={styles.ml}>
            <span>
              <i className={styles.a} />
              {m.cache != null ? '新输入' : '输入'} <span className={styles.num}>{fresh.toLocaleString()}</span>
            </span>
            {m.cache != null && (
              <span>
                <i className={styles.b} />
                缓存 <span className={styles.num}>{m.cache.toLocaleString()}</span>
              </span>
            )}
            <span>
              <i className={styles.c} />
              输出 <span className={styles.num}>{m.out}</span>
            </span>
          </span>
        </div>
      ) : (
        <span className={styles.cap}>{tr.events.some((e) => e.name === 'model.started') ? '模型已开始，尚无结束回执' : '本轮没有模型调用记录'}</span>
      )}
    </section>
  );
  const obs = (no: string) => (
    <section className={styles.s}>
      <Sh no={no} t="观察" />
      {tr.obs ? (
        <div className={xs.obs}>
          <span className={xs.shot} data-txt={!tr.obs.shot || undefined} aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className={xs.obsT}>
            <b>{tr.obs.app}</b>
            <span className={xs.mono} title={tr.obs.title}>
              {tr.obs.title}
            </span>
            <span className={`${styles.cap} ${styles.num}`}>
              {tr.obs.at} │ {tr.obs.shot ? '文字 + 截图' : '仅文字'}
            </span>
          </span>
        </div>
      ) : (
        <span className={styles.cap}>—</span>
      )}
    </section>
  );
  const motion = (no: string) => (
    <section className={styles.s}>
      <Sh no={no} t="动作" />
      {tr.motion ? (
        <button type="button" className={`${xs.mo} ${common.tip}`} data-tip="在角色页查看此动作" onClick={() => tr.motion && navigate({ page: 'character', tab: 'motion', row: tr.motion.name })}>
          <span className={xs.moI} aria-hidden="true">
            <Icon name="user" size={20} />
          </span>
          <span className={xs.moT}>
            <b title={tr.motion.name}>{tr.motion.name}</b>
            {tr.motion.ms != null && <span className={`${styles.num} ${styles.cap}`}>{fmtMs(tr.motion.ms)}</span>}
          </span>
          <span className={styles.cap}>角色 ↗</span>
        </button>
      ) : tr.behavior ? (
        <span className={styles.cap}>{tr.behavior.name} │ {tr.behavior.phase ? (MOTION_PHASE[tr.behavior.phase] ?? tr.behavior.phase) : '已请求，尚无宿主回执'}{tr.behavior.reason ? ` │ ${tr.behavior.reason}` : ''}</span>
      ) : (
        <span className={styles.cap}>—</span>
      )}
    </section>
  );
  const evt = (
    <div className={xs.eventScroll}><table className={xs.evt}>
      <thead>
        <tr>
          <th>+ms</th>
          <th>事件</th>
          <th>状态</th>
          <th>进程</th>
          <th>内容</th>
        </tr>
      </thead>
      <tbody>
        {tr.events.map((e, i) => (
          <tr key={i}>
            <td className={styles.num}>{e.t}</td>
            <td className={xs.mono}>{e.name}</td>
            <td>{e.status ?? '—'}</td>
            <td>{e.producer ?? '—'}</td>
            <td>{e.d}</td>
          </tr>
        ))}
      </tbody>
    </table></div>
  );
  const fold = (open: string, rest: ReactNode) => (
    <section className={`${styles.s} ${xs.raw}`}>
      <button type="button" className={xs.rawT} aria-expanded={more} onClick={() => setMore(!more)}>
        <span className={xs.sq} aria-hidden="true" />
        {more ? '收起' : open}
        {rest}
        <span className={xs.sp} />
        <span className={xs.dots} aria-hidden="true">
          •••
        </span>
      </button>
      {more && (wide ? evt : <div className={xs.more}>{obs('05')}{motion('06')}<section className={styles.s}><Sh no="07" t="事件" right={<span className={styles.num}>{tr.events.length} 条</span>} />{evt}</section></div>)}
    </section>
  );
  if (wide)
    return (
      <div className={`${styles.ti} ${xs.wide}`} data-wide="">
        {head}
        <div className={xs.wideG}>
          <div>{wf}</div>
          <div className={xs.facts}>
            {mem}
            {judge}
            {model}
            {obs('05')}
            {motion('06')}
          </div>
        </div>
        {fold('展开', <span className={styles.num}>{` ${tr.events.length} 条事件`}</span>)}
      </div>
    );
  return (
    <div className={styles.ti}>
      {head}
      {wf}
      {mem}
      {judge}
      {model}
      {fold('更多', <span className={styles.cap}>观察 │ 动作 │ <span className={styles.num}>{tr.events.length}</span> 条事件</span>)}
    </div>
  );
}
