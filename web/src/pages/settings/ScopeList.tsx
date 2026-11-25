import { getBridge } from '../../bridge';
import { formatDuration, secToMs } from '../../domain';
import { clock, createScope, failure, revokeScope } from './api';
import { useSettings } from './ctx';
import { Btn, Pill } from '../../ui';
import { labelOf } from './registry';
import { Slab } from './Slab';
import type { WireScope } from './wire';
import styles from './groups.module.css';

const name = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** 她能读的文件夹: agentd scopes (folders the role may read, where it writes), the default one, revoke. Folders come as picked handles. */
export function ScopeList() {
  const { model, ro: groupRo, agentdOff, caps, scopes, reload } = useSettings();
  const ro = groupRo || agentdOff;
  const bridge = getBridge();
  const now = clock();
  const live = (scopes ?? []).filter((s) => !s.revoked && secToMs(s.expires_at) > now);
  const current = model.vals.scope;
  const fail = (what: string) => (e: unknown) => model.notify({ message: `${what}：${failure(e).text}`, severity: 'danger', persistent: true });

  const add = async () => {
    const root = await bridge.files.pickFolder({ purpose: 'scope_root' });
    if (!root) return model.notify({ message: '未选择文件夹' });
    const out = await bridge.files.pickFolder({ purpose: 'scope_output' });
    if (!out) return model.notify({ message: '未选择产物保存目录，已取消授权' });
    await createScope(root, out).then((s) => {
      reload('scopes');
      model.notify({ message: `已授权「${root.displayName}」，将于 ${formatDuration(secToMs(s.expires_at - s.created_at))}后到期` });
    }, fail(`未能授权「${root.displayName}」`));
  };
  const revoke = (s: WireScope) =>
    model.ask({
      title: `确认撤销「${name(s.roots[0]?.path ?? '')}」的访问授权？`,
      danger: true,
      warning: '立即生效',
      // agentd's revoke cancels every run and clears these stores, whichever scope fed them.
      list: ['所有运行中的任务与对话都将中止（不仅限于此目录）', '持续观察记录的分析上下文与摘要将被清空', '每日简报中的观察摘要将被清空', '记忆整理记录中的原文引用将被清除'],
      note: '撤销后角色将无法继续读取这些文件夹。',
      confirmLabel: '撤销授权',
      onConfirm: () =>
        revokeScope(s.scope_id).then(() => {
          reload('scopes');
          reload('runtime');
          model.notify({ message: '已撤销授权' });
        }, fail('未能撤销授权')),
    });

  return (
    <Slab
      id="scope"
      indent
      title={labelOf('scope')}
      right={
        <Btn disabled={ro || !caps.nativeFilePicker} disabledReason="当前平台不支持原生文件夹选择器" onClick={() => void add()}>
          添加文件夹…
        </Btn>
      }
      desc="授权有效期 24 小时；撤销后立即生效"
    >
      <ul className={styles.files}>
        {scopes == null && <li className={styles.t3}>—</li>}
        {live.map((s) => (
          <li key={s.scope_id}>
            <Pill>目录</Pill>
            <code className={styles.grow} title={`产物输出至 ${s.output.path}`}>
              {s.roots.map((r) => r.path).join('、')} → {s.output.path}
            </code>
            <span className={styles.t2}>剩余 {formatDuration(Math.max(0, secToMs(s.expires_at) - now))}</span>
            {current === s.scope_id ? (
              <b className={styles.t2}>默认</b>
            ) : (
              !ro && <Btn variant="link" onClick={() => void model.save({ scope: s.scope_id }, '默认资料范围')}>设为默认</Btn>
            )}
            {!ro && (
              <Btn variant="danger" size="sm" onClick={() => revoke(s)}>
                撤销授权
              </Btn>
            )}
          </li>
        ))}
        {scopes != null && live.length === 0 && <li className={styles.t3}>尚未授权任何文件夹；角色仅能读取您在对话中主动提供的文件</li>}
      </ul>
    </Slab>
  );
}
