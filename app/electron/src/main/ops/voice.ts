// `voice.onPushToTalk`: protocol.ts `PushToTalkState` as push-to-talk's hint changes (src/common/push-to-talk.ts). Without
// push-to-talk the op stays unimplemented.
import type { Ops, OpsContext } from './context.ts';
import { watch } from './events.ts';

export function voiceOps(ctx: OpsContext): Ops {
  return ctx.pushToTalk ? { 'voice.onPushToTalk': watch('voice.onPushToTalk', ctx.pushToTalk) } : {};
}
