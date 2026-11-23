import type { ReactNode } from 'react';
import { getBridge } from '../../bridge';
import type { PluginId } from '../../bridge/plugins.generated';
import { navigate } from '../../shell/nav';
import { toast } from '../../shell/toast';
import { PowerState } from '../../ui/game';

/** A tab whose plug-in is off in 隐私: the tab's content stays, greyed and inert, under a board that leads to its switch. */
export function Off({ plugin, title, reason, children }: { plugin: PluginId; title: string; reason: string; children: ReactNode }) {
  return (
    <PowerState state="off" mode="page" title={title} reason={reason} action={{ label: '前往设置打开', onClick: () => navigate({ page: 'settings', group: 'privacy', item: `plugins.${plugin}` }) }}>
      {children}
    </PowerState>
  );
}

const restart = () =>
  void getBridge().supervisor.restart('agentd').then(
    () => toast('已请求重启后台'),
    () => toast('没有重启后台：请在诊断里查看'),
  );

/** agentd gone, or without the route a tab reads: no settings row fixes it, so the button restarts the backend. */
export function Unlinked({ title, reason, children }: { title: string; reason: string; children: ReactNode }) {
  return (
    <PowerState state="unlinked" mode="page" title={title} reason={reason} action={{ label: '重启后台', onClick: restart }}>
      {children}
    </PowerState>
  );
}
