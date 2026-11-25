import { getBridge, type PermissionKind } from '../../../bridge';
import type { VisualStateKey } from '../../../domain/states';
import { Band } from '../Band';
import { useControls } from '../controls';
import { useSettings } from '../ctx';
import { Btn, Fold } from '../../../ui';
import { StatusLamp } from '../../../ui/game';
import { PERM_TIP, type PermRow } from '../perms';
import { labelOf } from '../registry';
import { ScopeList } from '../ScopeList';
import { SetRow } from '../SetRow';
import { SetSection } from '../SetSection';
import styles from '../groups.module.css';

const STATE: Record<PermRow['state'], [VisualStateKey, string]> = {
  granted: ['ok', '已授予'],
  denied: ['broken', '未授予'],
  notDetermined: ['waiting', '尚未请求系统授权'],
  unsupported: ['stopped', '当前平台不支持'],
  loading: ['idle', '读取中'],
  unread: ['idle', '未读取'],
};

/** Kinds whose system prompt only shows on request; 去系统设置 stays beside 允许, since a request can come back unanswered or be ignored after a refusal. */
const ASKABLE: ReadonlySet<PermissionKind> = new Set(['microphone', 'inputMonitoring', 'automation', 'notifications']);

/** 能力: whether she may ask you, the capabilities she can take on (each a band), and the system permissions they need. */
export function ActGroup() {
  const { model, item, hl, goRow } = useSettings();
  const c = useControls();
  return (
    <>
      <SetSection title="提问">
        <SetRow
          id="k_ask"
          title={labelOf('k_ask')}
          desc={model.value('k_ask') === false ? '关闭后，角色将不再弹出提问卡片' : '当缺少关键信息时，角色可弹出提问卡片向您确认'}
          info="仅控制角色的提问卡片；关闭时将取消未完成的后台提问任务。工具审批与编码会话审批卡片不受此开关影响，已授权工作区内的文件操作按授权范围正常执行。"
          control={c.toggle('k_ask', labelOf('k_ask'))}
        />
      </SetSection>

      <SetSection title="功能">
        <Band plugin="computer_use" />
        <Band plugin="personal_agent" fold={labelOf('scope')}>
          <ScopeList />
        </Band>
        <Band plugin="external_access" />
        <Band plugin="motion_generation" fold="动作服务">
          <SetRow
            id="motionJump"
            title="动作服务"
            desc="服务地址与令牌配置位于「设置 › 服务 › 动作服务」"
            indent
            control={
              <Btn go onClick={() => goRow('motionToken', 'services')}>
                前往配置
              </Btn>
            }
          />
        </Band>
      </SetSection>

      <PermSection open={[item, hl].some((x) => x != null && PERM_KINDS.has(x))} />
    </>
  );
}

const PERM_KINDS: ReadonlySet<string> = new Set(['screenRecording', 'accessibility', 'microphone', 'inputMonitoring', 'automation', 'notifications']);

/** 系统权限: one summary line, then a fold with a row per permission, its fix path and a re-check; open while one is missing. */
function PermSection({ open: linked }: { open: boolean }) {
  const { model, caps, perms, recheckPerms } = useSettings();
  const bridge = getBridge();
  const known = perms.filter((p) => p.state !== 'loading' && p.state !== 'unread' && p.state !== 'unsupported');
  const missing = known.filter((p) => p.state !== 'granted');
  const reading = perms.some((p) => p.state === 'loading');
  const unread = perms.some((p) => p.state === 'unread');

  const openSettings = async (p: PermRow) => {
    try {
      await bridge.permissions.openSettings(p.kind);
      model.notify({ message: `已打开系统设置 › ${p.label} │ 完成授权后请返回点击「重新检测」`, persistent: true });
    } catch {
      model.notify({ message: `未能打开系统设置，请手动前往系统隐私设置检查「${p.label}」。`, severity: 'danger', persistent: true });
    }
  };
  const recheck = async (p: PermRow) => {
    const s = await recheckPerms(p.kind);
    if (s === 'granted') model.notify({ message: `${p.label}：已授予，${p.features.join('、')} 现已可用`, severity: 'success' });
    else model.notify({ message: `${p.label}：${s ? `当前状态为${STATE[s][1]}` : '未能读取权限状态'}`, severity: 'warning', persistent: true });
  };
  const ask = async (p: PermRow) => {
    let s;
    try {
      s = await bridge.permissions.request(p.kind);
    } catch {
      return model.notify({ message: `${p.label}：当前环境无法直接拉起系统授权弹窗，请前往系统设置手动开启`, severity: 'warning', persistent: true });
    }
    await recheckPerms(p.kind);
    if (s === 'granted') model.notify({ message: `${p.label}：已授予，${p.features.join('、')} 现已可用`, severity: 'success' });
    // Terminal answers only while it runs, and the system lists it under the app only after that.
    else if (s === 'notDetermined' && p.kind === 'automation') model.notify({ message: '未检测到「终端」自动化授权。请先启动「终端」，然后重新点击「请求授权」。', severity: 'warning', persistent: true });
    // No prompt came up, or it was refused: the switch is in system settings.
    else await openSettings(p);
  };

  const summary = reading ? (
    <StatusLamp size="sm" state="idle" label="读取中" />
  ) : unread ? (
    <StatusLamp size="sm" state="idle" label="未读取" />
  ) : missing.length ? (
    <StatusLamp size="sm" state="waiting" label={`${known.length - missing.length} 项已授予 │ ${missing.length} 项未授权`} />
  ) : (
    <StatusLamp size="sm" state="ok" label="全部已授予" />
  );

  return (
    <SetSection title="系统权限" right={bridge.platform === 'windows' ? '仅显示当前平台适用项' : undefined}>
      <SetRow
        id="perms"
        title={labelOf('perms')}
        desc={missing.length ? `未授予以下权限将导致对应功能不可用：${missing.flatMap((p) => p.features).join('、')}` : '各项能力所需的系统权限'}
        descTone={missing.length ? 'attention' : undefined}
        control={summary}
      />
      <div className={styles.sub}>
        <Fold id="perm.list" label="各项权限" count={perms.length} rows={perms.length} autoOpen={linked || missing.length > 0}>
          {perms.map((p) => {
            const ok = p.state === 'granted';
            const isKnown = p.state !== 'loading' && p.state !== 'unread';
            const askable = p.state === 'notDetermined' && ASKABLE.has(p.kind);
            const [tone, text] = p.kind === 'automation' && p.state === 'notDetermined' ? (['waiting', '尚未确认'] as const) : STATE[p.state];
            return (
              <SetRow
                key={p.kind}
                id={p.kind}
                title={p.label}
                desc={`用于 ${p.features.join('、')}`}
                info={PERM_TIP[p.kind] ?? p.purpose}
                control={
                  <>
                    <StatusLamp size="sm" state={tone} label={text} />
                    {askable && <Btn onClick={() => void ask(p)}>请求授权</Btn>}
                    {isKnown && !ok && p.state !== 'unsupported' && (
                      <Btn go disabled={!caps.systemSettings} disabledReason="当前平台不支持直接跳转，请手动打开系统隐私与安全设置" onClick={() => void openSettings(p)}>
                        打开系统设置
                      </Btn>
                    )}
                    {!ok && p.state !== 'loading' && p.state !== 'unsupported' && <Btn onClick={() => void recheck(p)}>重新检测</Btn>}
                  </>
                }
              />
            );
          })}
        </Fold>
      </div>
    </SetSection>
  );
}
