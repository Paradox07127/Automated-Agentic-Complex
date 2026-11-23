// `/model/settings` bodies for the settings mock: pi's seven providers, Anthropic saved with a key.
import type { WireCatalog, WireModelSettings } from '../../pages/settings/wire';

export const MODELS: WireModelSettings = {
  provider: 'anthropic',
  backends: {
    anthropic: { model: 'claude-haiku-5-5', base_url: 'https://api.anthropic.com', has_key: true, max_output_tokens: 4096, reasoning_effort: '' },
    deepseek: { model: 'deepseek-flash', base_url: 'https://api.deepseek.com', has_key: false, max_output_tokens: 4096, reasoning_effort: '' },
    xai: { model: '', base_url: 'https://api.x.ai/v1', has_key: false, max_output_tokens: 4096, reasoning_effort: '' },
    openai: { model: '', base_url: 'https://api.openai.com/v1', has_key: false, max_output_tokens: 4096, reasoning_effort: '' },
    compatible: { model: '', has_key: false, max_output_tokens: 4096, reasoning_effort: '', supports_images: false, context_window: 128000, reasoning: false },
    pi_catalog: { model: '', base_url: '', pi_provider: '', has_key: false, max_output_tokens: 4096, reasoning_effort: '' },
    chatgpt: { model: '', base_url: 'https://api.openai.com/v1', has_key: false, max_output_tokens: 4096, reasoning_effort: '' },
  },
  error: null,
  chatgpt: { active: null, pending: false, error: null, profiles: [] },
  mouth_ready: true,
};

/** `POST /model/catalog` for the saved Anthropic service: Pi's offline catalog rows and the providers a key reaches. */
export const CATALOG: WireCatalog = {
  providers: [
    { id: 'anthropic', name: 'Anthropic' },
    { id: 'deepseek', name: 'DeepSeek' },
    { id: 'groq', name: 'Groq' },
    { id: 'openrouter', name: 'OpenRouter' },
  ],
  models: [
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', context_window: 200000, max_tokens: 64000, input: ['text', 'image'], reasoning: true, thinking_levels: ['off', 'minimal', 'low', 'medium', 'high'], priced: true },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', context_window: 1000000, max_tokens: 128000, input: ['text', 'image'], reasoning: true, thinking_levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], priced: true },
    { id: 'claude-instant-2', name: 'Claude Instant 2', context_window: 100000, max_tokens: 4096, input: ['text'], reasoning: false, thinking_levels: ['off'], priced: false },
  ],
};

/** Saved ChatGPT accounts for `demo=chatgpt`: one in use, one more signed in, one signed out. */
export const CHATGPT: WireModelSettings['chatgpt'] = {
  active: 'c1a2',
  pending: false,
  error: null,
  profiles: [
    { id: 'c1a2', label: '连接 1', email: 'lin@example.com', connected: true, sharing: true },
    { id: 'c3b4', label: '连接 2', email: 'lin.work@example.com', connected: true, sharing: false },
    { id: 'c5d6', label: '连接 3', email: '', connected: false, sharing: false },
  ],
};
