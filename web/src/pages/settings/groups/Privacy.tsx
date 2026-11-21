import { useEffect, useState } from 'react';
import { isoToMsOrNull } from '../../../domain';
import { Btn, Toggle } from '../../../ui';
import { failure, pauseObservation, readBriefSettings, saveBriefSettings, type BriefSettings } from '../api';
import { useControls } from '../controls';
import { useSettings } from '../ctx';
import { ExcludeList } from '../ExcludeList';
import { OutboundPlate } from '../Outbound';
import { PauseReadout } from '../PauseReadout';
import { labelOf } from '../registry';
import { SetRow } from '../SetRow';
import { SetSection } from '../SetSection';
import styles from '../groups.module.css';
import { BriefHealth, useBriefHealth } from '../../observe/BriefHealth';

/** 隐私: outbound overview plate (the group's main visual), observation, readable sources (destructive ones confirm first), redaction, exclusions. */
export function PrivacyGroup() {
  const { model, ro, agentdOff, diag } = useSettings();
  const shots = diag.screenshots;
  const c = useControls();
  const on = (id: string) => model.value(id) === true;
  const [briefs, setBriefs] = useState<BriefSettings | null>(null);
  const briefHealth = useBriefHealth(!agentdOff);

  // Read again when agentd comes back; a failed read leaves the rows at「未读到」.
  useEffect(() => {
    let live = true;
    readBriefSettings().then(
      (b) => live && setBriefs(b),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [agentdOff]);

  const pause = (minutes: number) =>
    void pauseObservation(minutes).then(
      (r) => {
        model.setPause('observe', isoToMsOrNull(r.paused_until));
        model.notify({ message: minutes ? '观察已暂停 1 小时' : '观察已恢复' });
      },
      (e) => model.notify({ message: `没能${minutes ? '暂停' : '恢复'}观察：${failure(e).text}`, severity: 'danger', persistent: true }),
    );

  const saveBrief = (key: 'daily' | 'weekly', v: boolean, id: string) =>
    void saveBriefSettings({ [key]: v }).then(
      (r) => {
        setBriefs(r);
        model.notify({ message: `已更改「${labelOf(id)}」` });
      },
      (e) => model.notify({ message: `没有保存「${labelOf(id)}」：${failure(e).text}`, severity: 'danger', persistent: true }),
    );
  const brief = (key: 'daily' | 'weekly', id: string) =>
    briefs ? (
      <Toggle on={briefs[key]} label={labelOf(id)} size="sm" disabled={ro || agentdOff} disabledReason={agentdOff ? '后台服务没有运行，这一项暂时只读' : undefined} onChange={(v) => saveBrief(key, v, id)} />
    ) : (
      <span className={styles.t3} title={`${labelOf(id)}：还没读到后台的设置`}>
        未读到
      </span>
    );
  const at = `${String(briefs?.hour ?? 9).padStart(2, '0')}:00`;

  return (
    <div className={styles.split}>
      <div className={styles.splitA}>
        <OutboundPlate />
      </div>
      <div className={styles.splitB}>
        <SetSection title="观察">
          <SetRow id="observe" title="观察屏幕活动" desc={diag.observeOff && on('observe') ? '后台仍按「关闭」运行，重启后台服务后生效' : '总开关。关闭后不再记录；已有记录保留，可在「数据」中删除'} control={c.toggle('observe')} />
          <SetRow
            id="pause"
            title="暂停观察"
            desc="暂停 1 小时，到时自动恢复"
            control={
              model.pauses.observe ? (
                <PauseReadout kind="观察暂停" until={model.pauses.observe} disabled={ro || agentdOff} onResume={() => pause(0)} />
              ) : (
                <Btn size="sm" variant="ghost" disabled={ro || agentdOff || !on('observe')} disabledReason={agentdOff ? '后台服务没有运行' : '观察已关闭'} onClick={() => pause(60)}>
                  暂停 1 小时
                </Btn>
              )
            }
          />
          <SetRow id="brief_daily" title="每日简报" desc={`每天 ${at} 后根据前一天的观察写一份，在「观察」页阅读`} control={brief('daily', 'brief_daily')} />
          <SetRow id="brief_weekly" title="每周简报" desc={`每周 ${at} 后根据上一周的观察写一份`} control={brief('weekly', 'brief_weekly')} />
        </SetSection>

        <BriefHealth attempts={briefHealth.data?.attempts} onRetry={briefHealth.generate} />
        <SetSection title="读取范围">
          <SetRow id="wintext" title="窗口文字" desc="前台窗口中的可见文字；关闭时删除已收集的内容" control={c.toggle('wintext')} />
          <SetRow id="grain" title="屏幕理解粒度" indent disabled={!on('wintext')} disabledReason="需先打开「窗口文字」" desc={on('wintext') ? undefined : '需先打开「窗口文字」'} control={c.seg('grain', undefined, !on('wintext'))} />
          <SetRow id="web" title="网页正文" desc="关闭时立即删除已收集的摘要和由其推断的记忆" control={c.toggle('web')} />
          <SetRow id="typing" title="输入的文字" desc="关闭时仍记录发送时间和字数" control={c.toggle('typing')} />
          <SetRow id="agent_sessions" title="读取编码会话" desc="Claude Code / Codex 会话里的工具输入输出和结果；本机保存 48 小时，用来理解你手头的工作。关掉会删掉已存的会话内容" control={c.toggle('agent_sessions')} />
          <SetRow id="shot" title="屏幕识读时附上截图" desc={shots ? `今日额度 ${shots.used} / ${shots.limit}` : undefined} control={c.toggle('shot', '附上截图')} />
          <SetRow id="keys" title="键鼠计数" desc="只计次数，不记录按键内容" control={c.toggle('keys')} />
          <SetRow id="micapp" title="使用麦克风的应用" desc="用于判断是否在开会" control={c.toggle('micapp')} />
        </SetSection>

        <SetSection title="遮蔽与排除">
          <SetRow
            id="mask"
            title="外发前遮蔽敏感内容"
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
                </>
              ) : (
                '密钥、邮箱和电话；截图像素不遮蔽'
              )
            }
            control={c.toggle('mask', '遮蔽敏感内容')}
          />
          <ExcludeList />
        </SetSection>

        <SetSection title="固定规则">
          <p className={styles.note}>本地始终读取前台应用和窗口状态，用于决定角色动作，不会外发。无痕窗口一律不读取。</p>
        </SetSection>
      </div>
    </div>
  );
}
