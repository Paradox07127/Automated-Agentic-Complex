// `GET /character/runtime` and `/character/capabilities` in agentd's shapes; `?demo=…` picks a variant.
import type { CharacterRuntimeResponse } from '../bridge/agentd-routes.generated';
import type { WireRuntimePublic } from '../domain/wire';
import { WIRE_RUNTIME } from './fixtures';

const feature = (implemented: boolean, reason: string | null = null, enabled?: boolean) => ({ implemented, ...(enabled === undefined ? {} : { enabled }), reason });

/** character_agent/services/capabilities.py describe() for the selected Codex; GET /character/capabilities. */
export const CAPABILITIES = {
  backend: WIRE_RUNTIME.backend,
  discovered: true,
  authenticated: true,
  entry_supported: true,
  boundary_verified: false,
  tool_inventory_verified: null,
  task_verified: null,
  features: {
    domain_tools: feature(true),
    automatic_memory_observation_proactive: feature(true),
    observation_briefs: feature(true, 'evidence_bound_daily_weekly_backend'),
    goal_and_job_interaction: feature(true),
    persistent_reminder_tools: feature(true, 'explicit_user_instruction_and_versioned_receipts'),
    embodied_response: feature(true, 'request_and_actor_receipt_separate'),
    memory_write_and_journal: feature(true),
    native_shell: feature(true, 'kernel_own_tools', true),
    clarification_and_approval: feature(true, 'product_request_inbox', WIRE_RUNTIME.interactive_tools),
    native_resume: feature(false, 'product_checkpoints_only'),
    parallel_background_tasks: feature(true),
    native_computer_use: feature(false, 'computer_route_unavailable'),
    web_access: { implemented: false, enabled: false, mode: WIRE_RUNTIME.web_access, reason: 'unsupported_by_runtime' },
  },
};

const profile = (id: string, title: string, base_url: string, docs: string) => ({
  id, title, base_url, docs, harness: 'pi', credential_backend: id, auth_source: 'api_key',
  model_required: true, live_provider_verified: false,
});

/** integration.py public() for the selected Codex; provider_profiles is providers.py catalog(). */
const PUBLIC = {
  ...WIRE_RUNTIME,
  capability_flags: { product_checkpoint: true, cost_limit_supported: false, catalog_priced: false, native_images: false, custom_tools: true },
  capabilities: CAPABILITIES,
  provider_profiles: [
    profile('xai', 'Grok / xAI', 'https://api.x.ai/v1', 'https://docs.x.ai/developers/tools/function-calling'),
    profile('deepseek', 'DeepSeek', 'https://api.deepseek.com', 'https://api-docs.deepseek.com/'),
  ],
};

/** `GET /character/runtime`; `demo=logged-out` signs the selected Codex out, `demo=no-key` picks Pi on Anthropic with an API key that was never saved, `demo=acp` runs the local Claude agent. */
export function runtime(demo: string | null): WireRuntimePublic & Pick<CharacterRuntimeResponse, 'provider_profiles'> {
  if (demo === 'acp')
    return {
      ...PUBLIC,
      backend: 'acp',
      acp_agent: 'claude-acp',
      selected_runtime: null,
      available_backends: [...PUBLIC.available_backends, { id: 'acp', title: 'ACP', available: true, reason: null }],
    };
  if (demo === 'no-key') return { ...PUBLIC, backend: 'pi', provider: 'anthropic', auth_source: 'api_key', ready: false, error: 'missing_anthropic_api_key' };
  if (demo !== 'logged-out') return PUBLIC;
  const out = (r: WireRuntimePublic['installed_runtimes'][number]) => (r.backend === 'codex' ? { ...r, authenticated: false } : r);
  return {
    ...PUBLIC,
    ready: false,
    error: 'native_login_required',
    installed_runtimes: WIRE_RUNTIME.installed_runtimes.map(out),
    selected_runtime: WIRE_RUNTIME.selected_runtime && out(WIRE_RUNTIME.selected_runtime),
  };
}
