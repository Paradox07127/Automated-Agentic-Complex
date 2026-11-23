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
    if (v !== '' && !PROXY_URL.test(v)) return setBad('要以 http:// 或 https:// 开头，只写主机和端口');
    setBad(null);
    if (v !== saved) model.set('proxy', v);
  };
  return (
    <SetSection title="网络">
      <SetRow
        id="proxy"
        title={labelOf('proxy')}
        desc={bad ?? (saved ? '后台服务和内核经这里连外网' : '留空时不另设代理')}
        descTone={bad ? 'bad' : undefined}
        info="后台服务和它启动的 Pi、Codex、Claude Code 连模型服务时走这个 HTTP 代理；本机地址和上面各项服务的主机直连。地址里可以带用户名和密码，会以明文存进配置文件。"
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
