// The main process side of `window.agenticComplex`: op names and surfaces from protocol/ui-bridge/ops.json.
import ops from '../../../../protocol/ui-bridge/ops.json' with { type: 'json' };
import onboarding from '../../../../protocol/ui-bridge/onboarding-ops.json' with { type: 'json' };
import { ORIGIN } from './ui.ts';

export type Surface = 'main' | 'stack' | 'onboarding';

/** protocol.ts `BridgeError`. */
export interface BridgeError { code: string; detail: string }

export type Reply = { ok: true; value: unknown } | { ok: false; error: BridgeError };

export interface Kinds { watch: string[]; sync: string[]; stream: string[] }

/** What the preload hands the shim: the page's surface, its capability bits and every bridge member. */
export interface Boot {
  surface: Surface;
  capabilities: Record<string, boolean>;
  ops: string[];
  kinds: Kinds;
}

/** The frame that sent a message. */
export interface Sender { mainFrame: boolean; origin: string }

export function boot(surface: Surface): Boot {
  const bits = Object.fromEntries(Object.entries(ops.capabilities[surface]).map(([name, v]) => [name, v === true]));
  return { surface, capabilities: bits, ops: [...ops.ops, ...onboarding.ops], kinds: ops.kinds };
}

const allowed: Record<Surface, ReadonlySet<string>> = {
  main: new Set(ops.surfaces.main), stack: new Set(ops.surfaces.stack), onboarding: new Set(ops.surfaces.onboarding),
};

const fail = (code: string, detail: string): Reply => ({ ok: false, error: { code, detail } });

/** Thrown by a handler: the page's promise rejects with this `BridgeError`. */
export class BridgeFailure extends Error {
  readonly code: string;
  readonly detail: string;
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
  }
}

/** One op's main-process side: `args` has null for each argument the page left out; resolves to the JSON value. */
export type Handler<P = unknown> = (args: unknown[], page: P) => unknown;

/** `message` is the page's `{op, args}`. An op without a handler is
 *  `not_implemented`; a handler's thrown error other than `BridgeFailure` is `failed`. */
export function handle<P>(surface: Surface, sender: Sender, message: unknown, handlers: ReadonlyMap<string, Handler<P>> = new Map(),
  page?: P): Reply | Promise<Reply> {
  if (!sender.mainFrame) return fail('forbidden_frame', 'not the main frame');
  if (sender.origin !== ORIGIN) return fail('forbidden_origin', sender.origin);
  const { op, args } = (message ?? {}) as { op?: unknown; args?: unknown };
  if (typeof op !== 'string' || !Array.isArray(args)) return fail('invalid_args', 'expected {op, args}');
  if (!allowed[surface].has(op)) return fail('op_not_allowed', op);
  const handler = handlers.get(op);
  if (!handler) return fail('not_implemented', op);
  return (async (): Promise<Reply> => {
    try {
      const value = await handler(args.map((a) => a ?? null), page as P);
      return { ok: true, value: value === undefined ? null : value };
    } catch (e) {
      if (e instanceof BridgeFailure) return fail(e.code, e.detail);
      return fail('failed', e instanceof Error ? e.message : String(e));
    }
  })();
}
