import { codeText } from '../../../domain/errorText';
import { Btn } from '../../../ui';
import { failure, loginCancel, loginLogout, loginStart } from '../api';
import { useSettings } from '../ctx';
import { RUNTIME_ERROR } from '../fields';
import { labelOf } from '../registry';
import { SetRow } from '../SetRow';

type Method = { id?: string; name?: string };

/** 登录: the saved Codex or Claude Code in the app's own profile, or the saved ACP agent's own login with one button per method. */
export function KernelLoginRow({ backend, methods = [] }: { backend: string; methods?: Method[] }) {
  const { model, ro, agentdOff, runtime, reload } = useSettings();
  const login = runtime!.wire.product_login;
  const account = login.accounts[backend];
  const off = ro || agentdOff;
  const act = (run: () => Promise<unknown>, done: string, what: string) =>
    void run().then(
      () => {
        reload('runtime');
        model.notify({ message: done });
      },
      (e: unknown) => model.notify({ message: `${what}：${failure(e).text}`, severity: 'danger', persistent: true }),
    );
  const start = (method?: Method) => act(() => loginStart(method?.id), '已打开登录页，在浏览器里完成登录', '没能开始登录');
  const failed = login.error ? (RUNTIME_ERROR[login.error]?.label ?? codeText(login.error) ?? login.error) : null;
  const desc = login.pending
    ? '在浏览器里完成登录后回来'
    : (failed ?? (account?.signed_in ? [account.email, account.plan].filter(Boolean).join(' │ ') || '已登录' : account ? '还没有登录' : undefined));
  const again = account?.signed_in ? '重新登录' : '登录';

  return (
    <SetRow
      id="kernelLogin"
      title={labelOf('kernelLogin')}
      desc={desc}
      descTone={failed && !login.pending ? 'bad' : undefined}
      indent
      control={
        login.pending ? (
          <Btn disabled={off} onClick={() => act(loginCancel, '已取消登录', '没能取消登录')}>
            取消登录
          </Btn>
        ) : (
          <>
            {methods.length > 1 ? (
              methods.map((m) => (
                <Btn key={m.id} disabled={off} onClick={() => start(m)}>
                  {`${again}：${m.name ?? m.id}`}
                </Btn>
              ))
            ) : (
              <Btn disabled={off} onClick={() => start(methods[0])}>
                {again}
              </Btn>
            )}
            {(account?.signed_in || backend === 'acp') && (
              <Btn disabled={off} onClick={() => act(loginLogout, '已登出', '没能登出')}>
                登出
              </Btn>
            )}
          </>
        )
      }
    />
  );
}
