import { useEffect, useState } from 'react';
import { usePlugins } from '../../../shell/plugins';
import { failure, readBriefSettings, saveBriefSettings, type BriefSettings } from '../api';
import { Band } from '../Band';
import { useControls } from '../controls';
import { useSettings } from '../ctx';
import { ExcludeList } from '../ExcludeList';
import { Select, Switch } from '../../../ui';
import { Dis } from '../kit';
import { OutboundPlate } from '../Outbound';
import { labelOf, useRowShown } from '../registry';
import { SetRow } from '../SetRow';
import { SetSection } from '../SetSection';
import { HookRows } from './Hooks';
import { HOURS, hourText } from './SpeakCompanion';
import styles from '../groups.module.css';

/** 观察: what leaves the machine, then each sensing capability as a band over the readings it takes, then redaction and exclusions. */
export function SeeGroup() {
  const { model, agentdOff, diag, goRow } = useSettings();
  const c = useControls();
  const shown = useRowShown();
  const briefsOn = shown('brief_daily');
  const [briefs, setBriefs] = useState<BriefSettings | null>(null);
  const shots = diag.screenshots;
  // 键鼠计数 belongs to no plug-in: the coarse beat reads it with 屏幕感知 off too, so it stays out of the folded band then.
  const awareness = usePlugins().screen_awareness;
  const keysRow = <SetRow id="keys" title={labelOf('keys')} desc="只计次数，不记按了什么" indent={awareness} control={c.toggle('keys')} />;

  // Read again when agentd comes back; a failed read leaves the rows at「未读到」.
  useEffect(() => {
    if (!briefsOn) return;
    let live = true;
    readBriefSettings().then(
      (b) => live && setBriefs(b),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [agentdOff, briefsOn]);

  const saveBrief = (body: Partial<BriefSettings>, id: string) =>
    void saveBriefSettings(body).then(
      (r) => {
        setBriefs(r);
        model.notify({ message: `已更改「${labelOf(id)}」` });
      },
      (e) => model.notify({ message: `没有保存「${labelOf(id)}」：${failure(e).text}`, severity: 'danger', persistent: true }),
    );
  const unread = (id: string) => (
    <span className={styles.t3} title={`${labelOf(id)}：还没读到后台的设置`}>
      未读到
    </span>
  );
  const brief = (key: 'daily' | 'weekly', id: string) =>
    briefs ? (
      <Switch variant="setting" checked={briefs[key]} label={labelOf(id)} disabled={agentdOff} disabledReason="后台服务没有运行，这一项暂时只读" onChange={(v) => saveBrief({ [key]: v }, id)} />
    ) : (
      unread(id)
    );
  const at = hourText(briefs?.hour ?? 9);

  return (
    <>
      <OutboundPlate />

      <Band plugin="screen_awareness" fold="窗口文字、看多细、网页正文、你输入的文字、操作时间线">
        <SetRow id="wintext" title={labelOf('wintext')} desc="前台窗口里看得见的字" indent control={c.toggle('wintext')} />
        <SetRow
          id="grain"
          title={labelOf('grain')}
          desc="越细越懂你手头的事，发出的字越多"
          indent
          control={model.value('wintext') === false ? <Dis link={{ label: '去打开', onClick: () => goRow('wintext') }}>要先打开「窗口文字」</Dis> : c.seg('grain')}
        />
        <SetRow id="web" title={labelOf('web')} desc="关掉时删掉已收集的摘要和由它推出的记忆" indent control={c.toggle('web')} />
        <SetRow id="typing" title={labelOf('typing')} desc="关着时只记发送时间和字数" indent control={c.toggle('typing')} />
        <SetRow id="actions" title={labelOf('actions')} desc="每 10 分钟一段，回看手头的工作" indent control={c.toggle('actions')} />
        {keysRow}
      </Band>
      {!awareness && keysRow}

      <Band plugin="screen_reading" fold={labelOf('shot')}>
        <SetRow
          id="shot"
          title={labelOf('shot')}
          desc={shots ? `今天已发 ${shots.used} / ${shots.limit} 张，超出后只发文字` : '超出每天的额度后只发文字'}
          indent
          control={c.toggle('shot', labelOf('shot'))}
        />
      </Band>

      <Band plugin="coding_sessions" fold="读会话内容、Claude Code、Codex">
        <SetRow id="agent_sessions" title={labelOf('agent_sessions')} desc="用来理解你手头的工作；关掉会删已存的会话内容" indent control={c.toggle('agent_sessions')} />
        <HookRows />
      </Band>

      <Band plugin="daily_brief" fold="每日简报、每周简报、简报时间">
        <SetRow id="brief_daily" title={labelOf('brief_daily')} desc={`每天 ${at} 后写前一天的，在「每日简报」页读`} indent control={brief('daily', 'brief_daily')} />
        <SetRow id="brief_weekly" title={labelOf('brief_weekly')} desc={`每周 ${at} 后写上一周的`} indent control={brief('weekly', 'brief_weekly')} />
        <SetRow
          id="briefHour"
          title={labelOf('briefHour')}
          desc="两种简报都等到这个钟点再写"
          info="按系统时区算。挑一个你通常已经开着电脑的钟点：那时电脑没开，就在当天之后开机时写；简报要用模型，会算进模型用量。"
          indent
          control={
            briefs ? (
              <Select label={labelOf('briefHour')} value={String(briefs.hour)} options={HOURS.map((h) => ({ value: String(h), label: hourText(h) }))} disabled={agentdOff} onChange={(v) => saveBrief({ hour: Number(v) }, 'briefHour')} />
            ) : (
              unread('briefHour')
            )
          }
        />
      </Band>

      <SetSection title="遮蔽与排除" info="前台应用名和窗口状态始终在本机读取，用来决定角色的动作，不外发；无痕窗口一律不读。">
        <SetRow
          id="mask"
          title={labelOf('mask')}
          desc={
            diag.redactions ? (
              <>
                本次启动已遮蔽{' '}
                {diag.redactions.map((r, i) => (
                  <span key={r.label}>
                    {i > 0 && ' │ '}
                    {r.label} <span className="num">{r.count}</span>
                  </span>
                ))}
                ；截图像素不遮蔽
              </>
            ) : (
              '密钥、邮箱和电话；截图像素不遮蔽'
            )
          }
          control={c.toggle('mask', labelOf('mask'))}
        />
        {shown('exclude') && <ExcludeList />}
      </SetSection>
    </>
  );
}
