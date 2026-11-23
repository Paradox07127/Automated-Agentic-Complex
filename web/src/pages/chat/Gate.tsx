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
    <PowerState state="off" mode="page" title="AI 对话" reason="设置 › AI 里关掉了「AI 对话」，角色不回消息，也不记新的对话。" action={{ label: '前往设置打开', onClick: () => navigate({ page: 'settings', group: 'model', item: 'plugins.light_ai' }) }}>
      <SlotsOff>
        <ChatPage />
      </SlotsOff>
    </PowerState>
  );
}
