/** `GET /character/acp/agents`: two local agents (one probed), the registry's npx and uvx ones, and no npx on this Mac. */
export const ACP_AGENTS = {
  agents: [
    { id: 'claude-acp', name: 'Claude Agent', version: '0.5.0', source: 'local', command: ['/opt/homebrew/bin/claude-agent-acp'],
      probe: { ok: true, agent_info: { name: 'claude-agent-acp', version: '0.5.0' }, auth_methods: [], error: null }, native_backend: 'claude' },
    { id: 'goose', name: 'Goose', version: null, source: 'local', command: ['/opt/homebrew/bin/goose', 'acp'], probe: null, native_backend: null },
    { id: 'gemini', name: 'Gemini CLI', version: '0.9.0', source: 'npx', command: ['npx', '@google/gemini-cli', '--experimental-acp'], probe: null, native_backend: null },
    { id: 'fast-agent', name: 'fast-agent', version: '0.3.0', source: 'uvx', command: ['uvx', 'fast-agent-acp'], probe: null, native_backend: null },
  ],
  npx: false,
  uvx: true,
};

/** `POST /character/acp/install` of the npx row; the fake answers it for any registry row and lists nothing as local afterwards. */
export const ACP_INSTALL = {
  ok: true,
  agent_id: 'gemini',
  command: ['/opt/homebrew/bin/npm', 'install', '-g', '@google/gemini-cli@0.9.0'],
  exit: 0,
  output_tail: 'added 1 package in 4s\n',
};
