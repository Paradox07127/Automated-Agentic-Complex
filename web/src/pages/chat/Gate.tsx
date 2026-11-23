import { useDemo } from '../../shell/demo';
import { navigate } from '../../shell/nav';
import { usePlugins } from '../../shell/plugins';
import { PowerState } from '../../ui/game';
import { ChatPage } from './Page';

/** The chat route: with 和她对话 off the page stays on screen, greyed and inert, under a board that leads to its switch. */
export function ChatGate() {
  const { demo } = useDemo();
  const on = usePlugins().light_ai && demo !== 'ai-off';
  if (on) return <ChatPage />;
  return (
    <PowerState state="off" mode="page" title="和她对话" reason="设置里关掉了「和她对话」，她不回消息，也不记新的对话。" action={{ label: '前往设置打开', onClick: () => navigate({ page: 'settings', group: 'model', item: 'plugins.light_ai' }) }}>
      <ChatPage />
    </PowerState>
  );
}
