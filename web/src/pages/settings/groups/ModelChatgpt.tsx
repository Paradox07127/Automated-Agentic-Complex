import { chatgptCancel, chatgptLogout, chatgptSelect, chatgptStart, failure } from '../api';
import { useSettings } from '../ctx';
import { Btn } from '../../../ui';
import { StatusLamp } from '../../../ui/game';
import { SetRow } from '../SetRow';
import type { WireChatgpt } from '../wire';
import styles from '../groups.module.css';

type Profile = WireChatgpt['profiles'][number];

function stateOf(p: Profile, active: boolean) {
  if (!p.connected) return <StatusLamp size="sm" state="stopped" label="已断开" />;
  if (active) return <StatusLamp size="sm" state="ok" label={p.sharing ? '使用中 │ 已授权订阅额度' : '使用中'} />;
  return <StatusLamp size="sm" state="idle" label="已连接" />;
}

/** ChatGPT 订阅: every saved account with 使用 / 重新连接 / 退出; 添加账号 signs a new one in. */
export function ChatgptRow() {
  const { model, ro, models, reload } = useSettings();
  const gpt = models?.chatgpt;
  const profiles = gpt?.profiles ?? [];
  const active = profiles.find((p) => p.id === gpt?.active && p.connected) ?? null;
  const busy = ro || !!gpt?.pending;
  const act = (run: () => Promise<unknown>, done: string, what: string) =>
    void run().then(
      () => {
        reload('models');
        model.notify({ message: done });
      },
      (e: unknown) => model.notify({ message: `${what}：${failure(e).text}`, severity: 'danger', persistent: true }),
    );
  const name = (p: Profile) => p.email || p.label;

  return (
    <SetRow
      id="chatgpt"
      title="ChatGPT 账号"
      desc={gpt?.pending ? '在浏览器里完成登录后回来' : active ? `正在用 ${name(active)}` : profiles.length ? '选一个账号使用' : '还没有连接'}
      control={
        gpt?.pending ? (
          <Btn disabled={ro} onClick={() => act(chatgptCancel, '已取消登录', '没能取消')}>
            取消登录
          </Btn>
        ) : (
          <Btn disabled={ro} onClick={() => act(() => chatgptStart(), '已在浏览器打开 ChatGPT 登录', '没能开始登录')}>
            {profiles.length ? '添加账号' : '连接 ChatGPT'}
          </Btn>
        )
      }
    >
      {profiles.length > 0 && (
        <ul className={styles.files} aria-label="ChatGPT 账号">
          {profiles.map((p) => {
            const on = p.id === active?.id;
            return (
              <li key={p.id}>
                <span className={styles.t2}>{p.label}</span>
                {p.email && <span className={styles.t3}>{p.email}</span>}
                {stateOf(p, on)}
                {!on && p.connected && (
                  <Btn disabled={busy} onClick={() => act(() => chatgptSelect(p.id), `已改用 ${name(p)}`, '没能切换账号')}>
                    使用
                  </Btn>
                )}
                {!p.connected && (
                  <Btn disabled={busy} onClick={() => act(() => chatgptStart(p.id), '已在浏览器打开 ChatGPT 登录', '没能开始登录')}>
                    重新连接
                  </Btn>
                )}
                {p.connected && (
                  <Btn disabled={ro} onClick={() => act(() => chatgptLogout(p.id), `已退出 ${name(p)}`, '没能退出')}>
                    退出
                  </Btn>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </SetRow>
  );
}
