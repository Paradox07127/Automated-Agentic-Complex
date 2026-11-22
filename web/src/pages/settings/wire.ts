// agentd shapes the settings page reads that the shared wire layer does not carry.
import type { WireDiagBudget, WireDiagConnections, WireDiagGate, WireDiagHooks, WireDiagVoice, WireObservation } from '../../domain/wire';

export type ModelProvider = 'anthropic' | 'chatgpt' | 'openai' | 'compatible' | 'deepseek' | 'xai' | 'pi_catalog';

/** pi_config.py THINKING_LEVELS: the Pi SDK's thinking levels. */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** model_backends.py public(): one saved connection per provider; the key itself never comes back. */
export interface WireBackendConfig {
  model: string;
  base_url: string;
  has_key: boolean;
  max_output_tokens: number;
  reasoning_effort?: '' | ThinkingLevel;
  /** `compatible` only: the model Pi registers for it. */
  supports_images?: boolean;
  context_window?: number;
  reasoning?: boolean;
  /** `pi_catalog` only: the provider in Pi's catalog; `has_key` is that provider's own key. */
  pi_provider?: string;
}

/** model_auth.py ChatGPTAuth.state(). */
export interface WireChatgpt {
  active: string | null;
  pending: boolean;
  error: string | null;
  profiles: Array<{ id: string; label: string; email: string; connected: boolean; sharing: boolean }>;
}

/** GET and POST /model/settings (model_backends.py public(), server.py adds mouth_ready on GET): pi's credentials; `provider` and its `model` are pi's default connection. */
export interface WireModelSettings {
  provider: ModelProvider;
  backends: Record<ModelProvider, WireBackendConfig>;
  chatgpt: WireChatgpt;
  error: string | null;
  mouth_ready?: boolean;
}

/** POST /model/test: `provider`, `tokens` and `cost_usd` are null off Pi, and `cost_usd` also on an unpriced connection. */
export interface WireModelTest {
  ok: boolean;
  kernel: string;
  provider: string | null;
  model: string;
  elapsed_ms: number;
  tokens: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } | null;
  cost_usd: number | null;
}

/** One `/model/catalog` model; the capabilities are null in a compatible API's or ChatGPT's own list. */
export interface WireCatalogModel {
  id: string;
  name: string;
  context_window: number | null;
  max_tokens: number | null;
  input: Array<'text' | 'image'> | null;
  reasoning: boolean | null;
  thinking_levels: ThinkingLevel[] | null;
  priced: boolean | null;
}

/** POST /model/catalog: Pi's offline catalog for its services (`providers`: the ones a key reaches), else the service's own list and no providers. */
export interface WireCatalog {
  providers: Array<{ id: string; name: string }>;
  models: WireCatalogModel[];
}

export type BlacklistField = 'bundle_ids' | 'app_names' | 'domains' | 'title_patterns';
export type AllowField = 'bundle_ids' | 'app_names' | 'domains';

/** GET /blacklist (blacklist.py DEFAULTS shape); in mode allow only `allow` entries are read. */
export type WireBlacklist = Record<BlacklistField, string[]> & {
  version: number;
  incognito: boolean;
  mode: 'allow' | 'deny';
  allow: Record<AllowField, string[]>;
};

/** GET /agent/scopes rows (workspace.py create_scope / get_scope); times are epoch seconds. */
export interface WireScope {
  scope_id: string;
  revision: number;
  roots: Array<{ path: string }>;
  output: { path: string };
  created_at: number;
  expires_at: number;
  revoked: boolean;
}

/** The `/diag/state` blocks this page reads; the diag stream's `state` event carries the same object. */
export interface WireDiagSlice {
  gate?: WireDiagGate;
  budget?: WireDiagBudget;
  hooks?: WireDiagHooks;
  connections?: WireDiagConnections;
  observation?: WireObservation;
  mouth_voice?: WireDiagVoice;
}
