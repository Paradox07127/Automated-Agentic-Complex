import { useEffect, useState } from 'react';
import { getBridge, type AppActionName, type AppInfo, type ProcessState } from '../../../bridge';
import { setDevMode, useDevMode } from '../../../shell/devMode';
import { useControls } from '../controls';
import { useSettings } from '../ctx';
import { groupDesc } from '../groups';
import { Btn, Switch } from '../../../ui';
import { St } from '../kit';
import { labelOf, useRowShown } from '../registry';
import { SetRow } from '../SetRow';
import { SetSection } from '../SetSection';
import { Slab } from '../Slab';
import styles from '../groups.module.css';

/** 关于: the version plate, the login item, and troubleshooting (diagnostics, logs, first-run setup, licences, developer mode). */
export function AboutGroup() {
  const { model, native, agentdOff, goPage } = useSettings();
  const c = useControls();
  const devMode = useDevMode();
  const shown = useRowShown();
  const bridge = getBridge();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [agentd, setAgentd] = useState<ProcessState | null>(null);
  useEffect(() => {
    let live = true;
    void bridge.app.info().then((i) => live && setInfo(i));
    void bridge.supervisor.state().then((s) => live && setAgentd(s.agentd));
    return () => {
      live = false;
    };
  }, [bridge]);
  const running = !agentdOff && agentd?.state === 'running';
  const act = (name: AppActionName, done: string, what: string) => () =>
    void bridge.app.action(name).then(
      () => model.notify({ message: done }),
      () => model.notify({ message: `这个外壳还不能${what}`, severity: 'warning' }),
    );
  const version = info ? `Agentic Complex ${info.version} │ ${info.buildGit} │ ${info.os}` : '';
  const copyVersion = () =>
    void bridge.clipboard.writeText(version).then(
      () => model.notify({ message: '版本信息已复制' }),
      () => model.notify({ message: '没复制成', severity: 'warning' }),
    );

  return (
    <>
      <Slab id="ver" variant="plate" label={labelOf('ver')}>
        <div className={styles.kcard}>
          <span className={styles.big}>
            Agentic Complex
            <small className="num">{info ? `${info.version} │ ${info.buildGit}` : '—'}</small>
          </span>
          <span className={styles.meta}>
            <span>{info?.os ?? '—'}</span>
          </span>
          <Btn disabled={!info} onClick={copyVersion}>
            复制版本信息
          </Btn>
        </div>
      </Slab>

      <SetSection title="启动" info={groupDesc('about')}>
        <SetRow id="login" title={labelOf('login')} desc={native?.statuses.login ?? (model.value('login') === true ? '已在系统「登录项」里允许' : '关闭')} control={c.toggle('login')} />
      </SetSection>

      <SetSection title="排障">
        <SetRow id="copydiag" title={labelOf('copydiag')} desc="不含对话和记忆内容" control={<Btn onClick={act('copy_diagnostics', '诊断信息已复制', '复制诊断信息')}>复制</Btn>} />
        <SetRow id="logdir" title={labelOf('logdir')} control={<Btn go onClick={act('reveal_logs', '已打开日志目录', '打开日志目录')}>打开</Btn>} />
        <SetRow
          id="onb"
          title={labelOf('onb')}
          control={
            <Btn
              go
              onClick={() =>
                model.ask({
                  title: '重新运行首次设置？',
                  confirmLabel: '开始',
                  onConfirm: () =>
                    bridge.app.action('open_onboarding').then(
                      () => model.notify({ message: '已打开首次设置' }),
                      () => model.notify({ message: '这个外壳还不能打开首次设置', severity: 'warning' }),
                    ),
                })
              }
            >
              开始
            </Btn>
          }
        />
        <SetRow
          id="fonts"
          title={labelOf('fonts')}
          desc="Noto Sans SC、Saira │ SIL OFL 1.1；Material Symbols │ Apache 2.0"
          control={
            <Btn
              go
              onClick={() =>
                model.ask({
                  title: '字体许可',
                  note: 'Noto Sans SC 与 Saira 按 SIL Open Font License 1.1 随应用打包，许可原文在各字体包的 LICENSE；Material Symbols 按 Apache License 2.0。',
                  confirmLabel: '知道了',
                  onConfirm: () => {},
                })
              }
            >
              查看
            </Btn>
          }
        />
        <SetRow
          id="dev"
          title={labelOf('dev')}
          desc="显示诊断页和给开发者的设置项"
          info="打开后显示诊断和记忆管线页，设置里给开发者的项，角色设定 › 画面里的画质细项（2× SSAA、渲染尺寸、自阴影精度），以及轮次号、截图配额等内部数据。"
          control={<Switch variant="setting" checked={devMode} label={labelOf('dev')} onChange={setDevMode} />}
        />
        {shown('agentd') && (
          <SetRow
            id="agentd"
            title={labelOf('agentd')}
            control={
              <>
                <St tone={running ? 'ok' : 'bad'}>{running ? `运行中${agentd?.pid ? ` │ 进程 ${agentd.pid}` : ''}` : '没有运行'}</St>
                {running ? (
                  <Btn go onClick={() => goPage({ page: 'diag' })}>
                    去诊断
                  </Btn>
                ) : (
                  <Btn loading={model.restarting} onClick={() => void model.restartBackend()}>
                    重启后台服务
                  </Btn>
                )}
              </>
            }
          />
        )}
        <SetRow id="devparams" title={labelOf('devparams')} desc="只能在配置文件里改" control={<Btn go onClick={act('open_config', '已打开配置文件', '打开配置文件')}>打开配置文件</Btn>} />
      </SetSection>
    </>
  );
}
