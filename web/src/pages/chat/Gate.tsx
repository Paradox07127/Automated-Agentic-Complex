import { useDemo } from '../../shell/demo';
import { SlotsOff } from '../../shell/headerSlot';
import { navigate } from '../../shell/nav';
import { usePlugins } from '../../shell/plugins';
import { PowerState } from '../../ui/game';
import { ChatPage } from './Page';

/** The chat route: with AI 对话 off the page stays on screen, greyed and inert, under a board that leads to its switch. */
export function ChatGate() {
  const { demo } = useDemo();
  const on = usePlugins().light_ai && demo !== 'ai-off';
  if (on) return <ChatPage />;
  return (
    <PowerState state="off" mode="page" title="AI 对话" reason="已在「设置 › 内核」中关闭「AI 对话」，角色将停止回复消息且不记录新对话。" action={{ label: '前往开启', onClick: () => navigate({ page: 'settings', group: 'kernel', item: 'plugins.light_ai' }) }}>
      <SlotsOff>
        <ChatPage />
      </SlotsOff>
    </PowerState>
  );
}
