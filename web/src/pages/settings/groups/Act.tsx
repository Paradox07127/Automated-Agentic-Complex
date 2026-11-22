import { useEffect, useState } from 'react';
import { getBridge, type PermissionKind } from '../../../bridge';
import { failure, readMotion, saveMotion, type MotionSource } from '../api';
import { Band } from '../Band';
import { useControls } from '../controls';
import { useSettings } from '../ctx';
import { groupDesc } from '../groups';
import { Cap, Field, Masked, St, type StTone } from '../kit';
import type { PermRow } from '../perms';
import { labelOf } from '../registry';
import { ScopeList } from '../ScopeList';
import { SetRow } from '../SetRow';
import { SetSection } from '../SetSection';

const STATE: Record<PermRow['state'], [StTone, string]> = {
  granted: ['ok', '已允许'],
  denied: ['bad', '没允许'],
  notDetermined: ['warn', '还没问过'],
  unsupported: ['off', '这个平台没有'],
  loading: ['off', '读取中'],
  unread: ['off', '未读到'],
};

/** Kinds whose system prompt only shows on request; 去系统设置 stays beside 允许, since a request can come back unanswered or be ignored after a refusal. */
const ASKABLE: ReadonlySet<PermissionKind> = new Set(['microphone', 'inputMonitoring', 'automation', 'notifications']);

/** 能做: whether she may ask you, the capabilities she can take on (each a band), and the system permissions they need. */
export function ActGroup() {
  const { model, item, hl } = useSettings();
  const c = useControls();
  return (
    <>
      <SetSection title="自主程度" info={groupDesc('perm')}>
        <SetRow
          id="k_ask"
          title={labelOf('k_ask')}
          desc={model.value('k_ask') === false ? '关掉后遇到要你确认的事，她只会停下' : '问题和审批出现在审批卡和每日简报'}
          info="关掉后她不会弹审批卡，要确认的步骤直接放弃。已授权文件夹里的文件操作按授权范围执行。"
          control={c.toggle('k_ask', labelOf('k_ask'))}
        />
      </SetSection>

      <SetSection title="能力">
        <Band plugin="computer_use" />
        <Band plugin="personal_agent" fold={labelOf('scope')}>
          <ScopeList />
        </Band>
        <Band plugin="external_access" />
        <Band plugin="motion_generation" fold="动作服务地址、令牌">
          <MotionRows />
        </Band>
      </SetSection>

      <PermSection open={[item, hl].some((x) => x != null && PERM_KINDS.has(x))} />
    </>
  );
}

const PERM_KINDS: ReadonlySet<string> = new Set(['screenRecording', 'accessibility', 'microphone', 'inputMonitoring', 'automation', 'notifications']);

/** 系统权限: one summary line, unfolding into a row per permission with its fix path and a re-check. */
function PermSection({ open: linked }: { open: boolean }) {
  const { model, caps, perms, recheckPerms } = useSettings();
  const bridge = getBridge();
  const [open, setOpen] = useState(linked);
  useEffect(() => {
    if (linked) setOpen(true);
  }, [linked]);
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
    <St tone="off">读取中</St>
  ) : unread ? (
    <St tone="off">未读到</St>
  ) : missing.length ? (
    <St tone="warn">{`${known.length - missing.length} 项已允许 │ ${missing.length} 项没开`}</St>
  ) : (
    <St tone="ok">全部已允许</St>
  );

  return (
    <SetSection title="系统权限" right={bridge.platform === 'windows' ? '只列系统真有的项' : undefined}>
      <SetRow
        id="perms"
        title={labelOf('perms')}
        desc={missing.length ? `没开的会让这些功能不可用：${missing.flatMap((p) => p.features).join('、')}` : '各项能力要的系统权限'}
        descTone={missing.length ? 'attention' : undefined}
        control={
          <>
            {summary}
            <Cap onClick={() => setOpen(!open)}>{open ? '收起' : missing.length ? '去开' : '展开'}</Cap>
          </>
        }
      />
      {open &&
        perms.map((p) => {
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
              info={p.purpose}
              indent
              control={
                <>
                  <St tone={tone}>{text}</St>
                  {askable && <Cap onClick={() => void ask(p)}>允许</Cap>}
                  {isKnown && !ok && p.state !== 'unsupported' && (
                    <Cap go disabled={!caps.systemSettings} disabledReason="这个平台不能从这里打开系统设置，请手动打开系统的隐私设置" onClick={() => void openSettings(p)}>
                      去系统设置
                    </Cap>
                  )}
                  {!ok && p.state !== 'loading' && p.state !== 'unsupported' && <Cap onClick={() => void recheck(p)}>重新检测</Cap>}
                </>
              }
            />
          );
        })}
    </SetSection>
  );
}

/** The self-hosted motion service (GET/PUT /motion/settings): its address, and a token sent once and never read back. */
function MotionRows() {
  const { model, agentdOff } = useSettings();
  const [src, setSrc] = useState<MotionSource | null>(null);
  const [token, setToken] = useState('');
  useEffect(() => {
    let live = true;
    readMotion().then(
      (r) => live && setSrc(r),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [agentdOff]);
  const save = (body: { service_url: string | null; token?: string }, done: string, what: string) =>
    src &&
    void saveMotion({ backend: src.backend, ...body }).then(
      (r) => {
        setSrc(r);
        if (body.token !== undefined) setToken('');
        model.notify({ message: done, severity: 'success' });
      },
      (e) => model.notify({ message: `${what}：${failure(e).text}`, severity: 'danger', persistent: true }),
    );
  const off = agentdOff || src == null;
  const url = src?.service_url ?? '';
  return (
    <>
      <SetRow
        id="motionUrl"
        title="动作服务地址"
        desc={src == null ? '还没读到后台的设置' : undefined}
        indent
        control={
          <Field
            key={url}
            aria-label="动作服务地址"
            placeholder="http://主机:端口"
            defaultValue={url}
            disabled={off}
            onBlur={(e) => {
              const v = e.currentTarget.value.trim();
              if (v !== url) save({ service_url: v || null }, '已保存动作服务地址', '没有保存动作服务地址');
            }}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
        }
      />
      <SetRow
        id="motionToken"
        title="令牌"
        indent
        control={
          <>
            {src?.token_set && !token ? <Masked>已保存</Masked> : <Field type="password" aria-label="动作服务令牌" placeholder="粘贴令牌" value={token} disabled={off} onChange={(e) => setToken(e.currentTarget.value)} />}
            {src?.token_set && !token ? (
              <Cap disabled={off} onClick={() => save({ service_url: src.service_url, token: '' }, '已删除动作服务令牌', '没能删除令牌')}>
                移除
              </Cap>
            ) : (
              <Cap disabled={off || !token.trim()} onClick={() => save({ service_url: src?.service_url ?? null, token: token.trim() }, '令牌已保存', '没能保存令牌')}>
                保存
              </Cap>
            )}
          </>
        }
      />
    </>
  );
}
