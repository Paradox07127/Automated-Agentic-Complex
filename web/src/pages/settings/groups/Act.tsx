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
  granted: ['ok', '已允许'],
  denied: ['broken', '没允许'],
  notDetermined: ['waiting', '还没问过'],
  unsupported: ['stopped', '这个平台没有'],
  loading: ['idle', '读取中'],
  unread: ['idle', '未读到'],
};

/** Kinds whose system prompt only shows on request; 去系统设置 stays beside 允许, since a request can come back unanswered or be ignored after a refusal. */
const ASKABLE: ReadonlySet<PermissionKind> = new Set(['microphone', 'inputMonitoring', 'automation', 'notifications']);

/** 能做: whether she may ask you, the capabilities she can take on (each a band), and the system permissions they need. */
export function ActGroup() {
  const { model, item, hl, goRow } = useSettings();
  const c = useControls();
  return (
    <>
      <SetSection title="自主程度">
        <SetRow
          id="k_ask"
          title={labelOf('k_ask')}
          desc={model.value('k_ask') === false ? '关掉后她不再用提问卡问你' : '缺你才知道的信息时，她出一张提问卡问你'}
          info="只管她的提问卡。关掉时没做完的后台任务会取消。工具和编码会话的审批卡不受这里影响，照常弹出；已授权文件夹里的文件操作按授权范围执行。"
          control={c.toggle('k_ask', labelOf('k_ask'))}
        />
      </SetSection>

      <SetSection title="能力">
        <Band plugin="computer_use" />
        <Band plugin="personal_agent" fold={labelOf('scope')}>
          <ScopeList />
        </Band>
        <Band plugin="external_access" />
        <Band plugin="motion_generation" fold="动作服务">
          <SetRow
            id="motionJump"
            title="动作服务"
            desc="地址和令牌在「服务 › 动作服务」里"
            indent
            control={
              <Btn go onClick={() => goRow('motionToken', 'services')}>
                去服务
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
      model.notify({ message: `已打开系统设置 › ${p.label} │ 允许 Agentic Complex 后回来点「重新检测」`, persistent: true });
    } catch {
      model.notify({ message: `没能打开系统设置。请手动检查「${p.label}」。`, severity: 'danger', persistent: true });
    }
  };
  const recheck = async (p: PermRow) => {
    const s = await recheckPerms(p.kind);
    if (s === 'granted') model.notify({ message: `${p.label}：已允许，${p.features.join('、')} 可以用了`, severity: 'success' });
    else model.notify({ message: `${p.label}：${s ? `仍${STATE[s][1]}` : '没读到权限状态'}`, severity: 'warning', persistent: true });
  };
  const ask = async (p: PermRow) => {
    let s;
    try {
      s = await bridge.permissions.request(p.kind);
    } catch {
      return model.notify({ message: `${p.label}：这个外壳还不能弹出系统询问，请去系统设置里打开`, severity: 'warning', persistent: true });
    }
    await recheckPerms(p.kind);
    if (s === 'granted') model.notify({ message: `${p.label}：已允许，${p.features.join('、')} 可以用了`, severity: 'success' });
    else if (s === 'notDetermined') model.notify({ message: p.kind === 'automation' ? '系统没有返回授权结果。请先打开「终端」，再试一次。' : `${p.label}：系统没有给出结果，可以去系统设置里打开`, severity: 'warning', persistent: true });
    else model.notify({ message: `${p.label}：没有允许，可以去系统设置里打开`, severity: 'warning', persistent: true });
  };

  const summary = reading ? (
    <StatusLamp size="sm" state="idle" label="读取中" />
  ) : unread ? (
    <StatusLamp size="sm" state="idle" label="未读到" />
  ) : missing.length ? (
    <StatusLamp size="sm" state="waiting" label={`${known.length - missing.length} 项已允许 │ ${missing.length} 项没开`} />
  ) : (
    <StatusLamp size="sm" state="ok" label="全部已允许" />
  );

  return (
    <SetSection title="系统权限" right={bridge.platform === 'windows' ? '只列系统真有的项' : undefined}>
      <SetRow
        id="perms"
        title={labelOf('perms')}
        desc={missing.length ? `没开的会让这些功能不可用：${missing.flatMap((p) => p.features).join('、')}` : '各项能力要的系统权限'}
        descTone={missing.length ? 'attention' : undefined}
        control={summary}
      />
      <div className={styles.sub}>
        <Fold id="perm.list" label="各项权限" count={perms.length} rows={perms.length} autoOpen={linked || missing.length > 0}>
          {perms.map((p) => {
            const ok = p.state === 'granted';
            const isKnown = p.state !== 'loading' && p.state !== 'unread';
            const askable = p.state === 'notDetermined' && ASKABLE.has(p.kind);
            const [tone, text] = STATE[p.state];
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
                    {askable && <Btn onClick={() => void ask(p)}>允许</Btn>}
                    {isKnown && !ok && p.state !== 'unsupported' && (
                      <Btn go disabled={!caps.systemSettings} disabledReason="这个平台不能从这里打开系统设置，请手动打开系统的隐私设置" onClick={() => void openSettings(p)}>
                        去系统设置
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
