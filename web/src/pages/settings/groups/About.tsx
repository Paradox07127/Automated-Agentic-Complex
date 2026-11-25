import { useEffect, useState } from 'react';
import { getBridge, type AppActionName, type AppInfo, type ProcessState } from '../../../bridge';
import { setDevMode, useDevMode } from '../../../shell/devMode';
import { useControls } from '../controls';
import { useSettings } from '../ctx';
import { Btn, Switch } from '../../../ui';
import { StatusLamp } from '../../../ui/game';
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
      () => model.notify({ message: `当前环境暂不支持${what}`, severity: 'warning' }),
    );
  const version = info ? `Agentic Complex ${info.version} │ ${info.buildGit} │ ${info.os}` : '';
  const copyVersion = () =>
    void bridge.clipboard.writeText(version).then(
      () => model.notify({ message: '版本信息已复制' }),
      () => model.notify({ message: '复制失败', severity: 'warning' }),
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

      <SetSection title="启动">
        <SetRow
          id="login"
          title={labelOf('login')}
          desc={
            native?.statuses.login ??
            (model.value('login') === true
              ? bridge.platform === 'windows'
                ? '已在系统「启动应用」中启用开机自启'
                : '已在系统「登录项」中允许自启'
              : '已关闭')
          }
          control={c.toggle('login')}
        />
      </SetSection>

      <SetSection title="排障">
        <SetRow id="copydiag" title={labelOf('copydiag')} desc="不含对话正文与记忆内容" control={<Btn onClick={act('copy_diagnostics', '诊断信息已复制', '复制诊断信息')}>复制</Btn>} />
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
                      () => model.notify({ message: '当前环境暂不支持打开首次设置', severity: 'warning' }),
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
          desc="HarmonyOS Sans SC │ HarmonyOS Sans 字体许可协议；Material Symbols │ Apache 2.0"
          control={
            <Btn
              go
              onClick={() =>
                model.ask({
                  title: '字体许可',
                  note: '本应用使用 HarmonyOS Sans SC 字体（Copyright 2021 Huawei Device Co., Ltd.），按 HarmonyOS Sans Fonts License Agreement 原样随应用打包，许可原文随应用附在 licenses/HarmonyOS-Sans-LICENSE.txt；Material Symbols 按 Apache License 2.0。',
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
          desc="显示诊断页与开发者设置项"
          info="开启后将显示「诊断」页面、开发者专属设置项、角色页渲染高级画质选项（2× SSAA、渲染尺寸、自阴影精度），以及轮次编号与截图配额等内部运行指标。"
          control={<Switch variant="setting" checked={devMode} label={labelOf('dev')} onChange={setDevMode} />}
        />
        {shown('agentd') && (
          <SetRow
            id="agentd"
            title={labelOf('agentd')}
            control={
              <>
                <StatusLamp size="sm" state={running ? 'ok' : 'broken'} label={running ? `运行中${agentd?.pid ? ` │ PID ${agentd.pid}` : ''}` : '未运行'} />
                {running ? (
                  <Btn go onClick={() => goPage({ page: 'diag' })}>
                    前往诊断
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
        <SetRow id="devparams" title={labelOf('devparams')} desc="仅支持在配置文件中修改" control={<Btn go onClick={act('open_config', '已打开配置文件', '打开配置文件')}>打开配置文件</Btn>} />
      </SetSection>
    </>
  );
}
