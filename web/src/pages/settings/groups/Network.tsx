import { useState } from 'react';
import { Field } from '../../../ui';
import { useSettings } from '../ctx';
import { labelOf } from '../registry';
import { SetRow } from '../SetRow';
import { SetSection } from '../SetSection';

/** What the shell takes for config.json `proxy_url` (app/electron settings.ts validProxyUrl). */
const PROXY_URL = /^https?:\/\/[^/?#\s]+\/?$/;

/** 网络: the HTTP(S) proxy agentd and the kernels it starts go out through; written on blur, applied with a backend restart. */
export function NetworkSection() {
  const { model, ro } = useSettings();
  const saved = String(model.value('proxy') ?? '');
  const [bad, setBad] = useState<string | null>(null);
  const commit = (raw: string) => {
    const v = raw.trim();
    if (v !== '' && !PROXY_URL.test(v)) return setBad('须以 http:// 或 https:// 开头，仅包含主机与端口，不可携带用户名或密码');
    setBad(null);
    if (v !== saved) model.set('proxy', v);
  };
  return (
    <SetSection title="网络">
      <SetRow
        id="proxy"
        title={labelOf('proxy')}
        desc={bad ?? (saved ? '后台服务及 Pi、Codex、Claude Code 内核通过此代理连接外网' : '留空时不配置额外代理')}
        descTone={bad ? 'bad' : undefined}
        info="后台服务及其启动的 Pi、Codex、Claude Code 连接模型服务时将使用此 HTTP(S) 代理；本机回环地址与上方自建服务主机保持直连。仅支持填写主机与端口（不支持携带用户名或密码）。"
        control={
          <Field
            key={saved}
            label={labelOf('proxy')}
            placeholder="http://127.0.0.1:7890"
            defaultValue={saved}
            invalid={bad != null}
            disabled={ro}
            spellCheck={false}
            onBlur={(e) => commit(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
        }
      />
    </SetSection>
  );
}
