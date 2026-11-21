import { getBridge, type PermissionKind } from '../../../bridge';
import { Btn, StatusTag } from '../../../ui';
import { useControls } from '../controls';
import { useSettings } from '../ctx';
import { useRowShown } from '../registry';
import { SetRow } from '../SetRow';
import { SetSection } from '../SetSection';
import type { PermRow } from '../perms';
import { ScopeList } from '../ScopeList';
import styles from '../groups.module.css';

const STATE_LABEL: Record<PermRow['state'], string> = { granted: '已允许', denied: '未允许', notDetermined: '还没问过', unsupported: '这个平台没有', loading: '读取中', unread: '未读到' };

/** Kinds whose system prompt only shows on request; 去系统设置 stays beside 允许, since a request can come back unanswered or be ignored after a refusal. */
const ASKABLE: ReadonlySet<PermissionKind> = new Set(['microphone', 'inputMonitoring', 'automation', 'notifications']);

/** A permission's state tag; `named` puts the permission's name in front, for a row about something else. */
export function PermTag({ p, named }: { p: PermRow; named?: boolean }) {
  const known = p.state !== 'loading' && p.state !== 'unread';
  const label = STATE_LABEL[p.state];
  return <StatusTag state={p.state === 'granted' ? 'ok' : known ? 'warning' : 'todo'} label={named ? `${p.label} │ ${label}` : label} />;
}

/** 权限与授权: permission rows with the features each unlocks; fix path through the bridge plus re-check. */
export function PermGroup() {
  const { model, caps, perms, recheckPerms } = useSettings();
  const c = useControls();
  const shown = useRowShown();
  const bridge = getBridge();

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
    else model.notify({ message: `${p.label}：${s ? `仍${STATE_LABEL[s]}` : '没读到权限状态'}`, severity: 'warning', persistent: true });
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
  return (
    <>
      <SetSection title="系统权限">
        {perms.map((p) => {
          const ok = p.state === 'granted';
          const known = p.state !== 'loading' && p.state !== 'unread';
          const askable = p.state === 'notDetermined' && ASKABLE.has(p.kind);
          return (
            <SetRow
              key={p.kind}
              id={p.kind}
              title={p.label}
              desc={p.purpose}
              control={
                <>
                  <PermTag p={p} />
                  {askable && (
                    <Btn size="sm" variant="secondary" onClick={() => void ask(p)}>
                      允许
                    </Btn>
                  )}
                  {known && !ok && p.state !== 'unsupported' && (
                    <Btn
                      size="sm"
                      variant="secondary"
                      disabled={!caps.systemSettings}
                      disabledReason="这个平台不能从这里打开系统设置，请手动打开系统的隐私设置"
                      onClick={() => void openSettings(p)}
                    >
                      去系统设置
                    </Btn>
                  )}
                  {!ok && p.state !== 'loading' && p.state !== 'unsupported' && (
                    <Btn size="sm" variant="ghost" icon="refresh" onClick={() => void recheck(p)}>
                      重新检测
                    </Btn>
                  )}
                </>
              }
            >
              <span className={styles.fchips} role="list" aria-label={`依赖${p.label}的功能`}>
                {p.features.map((f) => (
                  <span key={f} role="listitem" className={ok || !known ? styles.fchip : styles.fchipOff} title={ok ? '可用' : `${known ? '不可用' : '状态未知'}：${p.label}${STATE_LABEL[p.state]}`}>
                    {ok || !known ? f : `✕ ${f}`}
                  </span>
                ))}
              </span>
            </SetRow>
          );
        })}
      </SetSection>

      <SetSection title="角色能力">
        <SetRow id="k_ask" title="提问与审批" desc="允许角色提出问题和需确认的操作。已授权资料范围内的文件操作按该范围执行。" control={c.toggle('k_ask', '提问与审批')} />
      </SetSection>

      {shown('scope') && <ScopeList />}
    </>
  );
}
