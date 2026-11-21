import { getBridge } from '../../bridge';
import { formatDuration, secToMs } from '../../domain';
import { Btn, Icon, Pill } from '../../ui';
import { clock, createScope, failure, revokeScope } from './api';
import { useSettings } from './ctx';
import { SetSection } from './SetSection';
import { Slab } from './Slab';
import type { WireScope } from './wire';
import styles from './groups.module.css';

const name = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path;

/** 资料范围: agentd scopes (folders the role may read, where it writes), the default one, revoke. Folders come as picked handles. */
export function ScopeList() {
  const { model, ro, caps, scopes, reload } = useSettings();
  const bridge = getBridge();
  const now = clock();
  const live = (scopes ?? []).filter((s) => !s.revoked && secToMs(s.expires_at) > now);
  const current = model.vals.scope;
  const fail = (what: string) => (e: unknown) => model.notify({ message: `${what}：${failure(e).text}`, severity: 'danger', persistent: true });

  const add = async () => {
    const root = await bridge.files.pickFolder({ purpose: 'scope_root' });
    if (!root) return model.notify({ message: '没有选择文件夹' });
    const out = await bridge.files.pickFolder({ purpose: 'scope_output' });
    if (!out) return model.notify({ message: '没有选择产物保存位置，没有授权' });
    await createScope(root, out).then((s) => {
      reload('scopes');
      model.notify({ message: `已授权「${root.displayName}」，${formatDuration(secToMs(s.expires_at - s.created_at))}后到期` });
    }, fail(`没能授权「${root.displayName}」`));
  };
  const revoke = (s: WireScope) =>
    model.ask({
      title: `撤销「${name(s.roots[0]?.path ?? '')}」的授权？`,
      danger: true,
      warning: '立即生效',
      note: '撤销后角色不能再读这些文件夹，用这个范围的任务会停下。',
      confirmLabel: '撤销授权',
      onConfirm: () =>
        revokeScope(s.scope_id).then(() => {
          reload('scopes');
          reload('runtime');
          model.notify({ message: '已撤销授权' });
        }, fail('没能撤销授权')),
    });

  return (
    <SetSection title="资料范围">
      <Slab id="scope" title="可读取的文件夹" desc="授权 24 小时后到期；撤销立即生效">
        <ul className={styles.files}>
          {scopes == null && <li className={styles.t3}>—</li>}
          {live.map((s) => (
            <li key={s.scope_id}>
              <Icon name="folder" size={14} />
              <code className={styles.grow} title={`产物保存到 ${s.output.path}`}>
                {s.roots.map((r) => r.path).join('、')} → {s.output.path}
              </code>
              <span className={styles.t2}>{formatDuration(Math.max(0, secToMs(s.expires_at) - now))}后到期</span>
              {current === s.scope_id ? (
                <Pill>默认</Pill>
              ) : (
                <Btn size="sm" variant="quiet" disabled={ro} onClick={() => void model.save({ scope: s.scope_id }, '默认资料范围')}>
                  设为默认
                </Btn>
              )}
              <Btn size="sm" variant="danger" disabled={ro} onClick={() => revoke(s)}>
                撤销授权
              </Btn>
            </li>
          ))}
          {scopes != null && live.length === 0 && <li className={styles.t3}>还没有授权文件夹；角色只能读你在对话里给的文件</li>}
        </ul>
        <Btn size="sm" variant="ghost" icon="plus" disabled={ro || !caps.nativeFilePicker} disabledReason="这个平台没有原生文件夹选择器" onClick={() => void add()}>
          添加文件夹…
        </Btn>
      </Slab>
    </SetSection>
  );
}
