import type { BridgeError, HttpMethod } from '../bridge/protocol';

export interface MockRequest {
  method: HttpMethod;
  /** Path without the query string. */
  path: string;
  /** Values of `:name` segments in the matched route pattern. */
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export interface MockResponse {
  status: number;
  body: unknown;
  /** Only for a status-0 bridge refusal; an agentd error goes in `body.error`, and the fake bridge derives `error` from it. */
  error?: BridgeError;
}

export type MockHandler = (req: MockRequest) => MockResponse | Promise<MockResponse>;

export interface MockRoute {
  method: HttpMethod;
  /** agentd path pattern, e.g. `/agent/runs/:id`. */
  path: string;
  handler: MockHandler;
}

/** Shape every `src/mock/<id>.ts` module exports. */
export interface MockModule {
  routes: MockRoute[];
}
