// Compile-time only: each fixture-backed response in the generated routes must fit the wire type the app reads it as.
// Nothing imports this file; tsc checks it through the tsconfig include.
import type { AgentdResponses } from '../../bridge/agentd-routes.generated';
import type { WireConversation, WireTurn } from './context';

type AssertAssignable<T, U extends T> = U extends T ? true : never;
type Row<K extends keyof AgentdResponses, F extends keyof AgentdResponses[K]> = AgentdResponses[K][F] extends Array<infer R> ? R : never;

export type ContextContract = [
  AssertAssignable<WireConversation, Row<'GET /conversations', 'conversations'>>,
  AssertAssignable<WireTurn, Row<'GET /conversations/:conversation_id/turns', 'turns'>>,
  AssertAssignable<WireTurn, Row<'GET /history', 'turns'>>,
];
