// The shape of the chat demos' prototype data (src/mock/fixtures/chatDemo.ts) and of the `/memory` facts a turn reads.
import type { WireFact, WireTraceTurn, WireTurn } from '../../domain/wire';

export interface DemoEvent {
  kind: string;
  status: string;
  t_wall: string;
  duration_ms?: number;
  attrs: Record<string, unknown>;
}

export type DemoFact = Pick<WireFact, 'fact_id' | 'text' | 'recent_uses'>;

export interface ChatDemoSource {
  rows: WireTraceTurn[];
  events: Record<string, DemoEvent[]>;
  facts: DemoFact[];
  /** turn_id → facts that turn's memory run added. */
  learned: Record<string, string[]>;
  history: WireTurn[];
  /** Side-session answers of the last 10 minutes, epoch ms. */
  side: Array<{ t0: number; t1: number }>;
}
