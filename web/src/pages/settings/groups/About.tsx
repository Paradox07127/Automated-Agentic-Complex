import { useEffect, useState } from 'react';
import { getBridge, type AppInfo } from '../../../bridge';
import { setDevMode, useDevMode } from '../../../shell/devMode';
import { Btn, Toggle } from '../../../ui';
import { useControls } from '../controls';
import { useSettings } from '../ctx';
import { SetRow } from '../SetRow';
import { SetSection } from '../SetSection';
import styles from '../groups.module.css';

/** 启动与关于: login item, build from the bridge, onboarding and licences. */
export function AboutGroup() {
  const { model, caps, native } = useSettings();
  const c = useControls();
  const devMode = useDevMode();
  const bridge = getBridge();
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    let live = true;
    void bridge.app.info().then((i) => live && setInfo(i));
    return () => {
      live = false;
    };
  }, [bridge]);
  const action = (label: string, onClick: () => void) => (
    <Btn size="sm" variant="secondary" onClick={onClick}>
      {label}
    </Btn>
  );

  return (
    <>
      <SetSection title="启动">
        <SetRow
          id="login"
          title="登录时启动"
          desc={native?.statuses.login ?? (model.value('login') === true ? '已在系统「登录项」里允许' : '关闭')}
          control={
            <>
              <Btn
                size="sm"
                variant="ghost"
                disabled={!caps.systemSettings}
                disabledReason="这个平台不能从这里打开系统设置，请手动打开系统的登录项设置"
                onClick={() => void bridge.permissions.openSettings('loginItems').then(
                  () => model.notify({ message: '已打开系统设置 › 登录项' }),
                  () => model.notify({ message: '没能打开系统设置。请手动检查「登录项」。', severity: 'danger', persistent: true }),
                )}
              >
                去系统设置
              </Btn>
              {c.toggle('login')}
            </>
          }
        />
      </SetSection>
      <SetSection title="关于">
        <SetRow
          id="ver"
          title="版本"
          control={<span className="num">{info ? `${info.version} │ ${info.buildGit}` : '—'}</span>}
        />
        <SetRow id="sys" title="系统" control={<span className={styles.t2}>{info?.os ?? '—'}</span>} />
        <SetRow
          id="load"
          title="运行负载"
          control={<span className="num">{info ? `${info.loadAverage.toFixed(2)} / ${info.cores} 核` : '—'}</span>}
        />
        <SetRow
          id="dev"
          title="开发者模式"
          desc="显示诊断页、调参页和画面里的性能细项（2× SSAA、渲染尺寸、自阴影精度），以及轮次号、截图配额等内部数据"
          control={<Toggle on={devMode} label="开发者模式" onChange={setDevMode} />}
        />
        <SetRow
          id="onb"
          opens
          title="重新运行首次设置"
          control={action('开始', () =>
            void bridge.app.action('open_onboarding').then(
              () => model.notify({ message: '已打开首次设置' }),
              () => model.notify({ message: '这个外壳还不能打开首次设置', severity: 'warning' }),
            ),
          )}
        />
        <SetRow
          id="fonts"
          opens
          title="字体许可"
          desc="Noto Sans SC、Saira │ SIL OFL 1.1；Material Symbols │ Apache 2.0"
          control={action('查看许可', () =>
            model.ask({
              title: '字体许可',
              note: 'Noto Sans SC 与 Saira 按 SIL Open Font License 1.1 随应用打包，许可原文在各字体包的 LICENSE；Material Symbols 按 Apache License 2.0。',
              confirmLabel: '知道了',
              onConfirm: () => {},
            }),
          )}
        />
      </SetSection>
    </>
  );
}
