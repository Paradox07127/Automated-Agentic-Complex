// `clipboard.writeText`.
import { BridgeFailure } from '../../common/bridge.ts';
import type { Ops, OpsContext } from './context.ts';

export function clipboardOps(ctx: OpsContext): Ops {
  return {
    'clipboard.writeText': ([text]) => {
      if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 1_000_000) throw new BridgeFailure('invalid_args', 'text up to 1 MB');
      ctx.clipboard.writeText(text);
      return null;
    },
  };
}
