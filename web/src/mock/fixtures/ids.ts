// Fixture ids in agentd's formats, under the prototype's short names. Demos and tests import these; never write the ids out.

/** Role tasks (`job:<32hex>`). */
export const T1 = 'job:1a7e0c9d2b3f4a5e8c6d7b0a9f1e2d31';
export const T3 = 'job:3c9e2a1f0b8d4c7e6a5f4e3d2c1b0a93';
export const T4 = 'job:4d0f3b2a1c9e5d8f7b6a5f4e3d2c1b04';
export const T6 = 'job:6f2b5d4c3e1a7f0b9d8c7b6a5f4e3d26';

/** Coding tasks dispatched from a card: `task:<ledger id>`, the ledger id being the card's request_id. */
export const T2_LEDGER = '2b8f1d0c7e6a5f42';
export const T7_LEDGER = '7e3a9c1b5d2f8a47';
export const T8_LEDGER = '8f4b0d2c6e3a9b58';
export const T2 = `task:${T2_LEDGER}` as const;
export const T7 = `task:${T7_LEDGER}` as const;
export const T8 = `task:${T8_LEDGER}` as const;

/** External sessions (display_session `<source>:<session id>`) and their web-only task rows. */
export const S_5E10 = 'claude:5e10c3a2-7b9d-4f1e-8a6c-2d4e6f8a0b1c';
export const S_9A41 = 'codex:9a41b7e2-3c5d-4e6f-9a0b-1c2d3e4f5a6b';
export const S_D0C2 = 'claude:d0c24f6a-8b1c-4d3e-9f5a-7b9c1d3e5f70';
export const S_41B0 = 'codex:41b0e8d6-2f4a-4c6e-8a0b-3d5f7a9c1e2b';
export const S_3C77 = 'claude:3c77a9b1-4d6f-4a8c-9e0b-5f7a9c1e3d4b';
export const T5 = `ext:${S_5E10}` as const;
export const T9 = `ext:${S_9A41}` as const;
export const T10 = `ext:${S_D0C2}` as const;

/** Own coding session of T2 (`own:<12hex>`); its approval cards carry this id as session_id and display_session (own.py:618-621). */
export const S_C07A = 'own:c07a1b2c3d4e';

/** `/approvals` request ids (16 hex). */
export const A1 = 'a1e5c7b9d0f2a4c6';
export const A2 = 'a2f6d8c0e1b3a5d7';
export const A3 = 'a3a7e9d1f2c4b6e8';

/** `/agent/interactions` request ids (32 hex). */
export const Q1 = 'b1c2d3e4f5a60718293a4b5c6d7e8f90';
export const Q_APPROVAL = 'b2d3e4f5a60718293a4b5c6d7e8f9012';
export const Q_APPROVAL_DANGER = 'b3e4f5a60718293a4b5c6d7e8f901234';

/** Deliveries (`delivery-<32hex>`). */
export const DLV_T1_V1 = 'delivery-d1e1a0b9c8d7e6f5a4b3c2d1e0f9a8b1';
export const DLV_T1_V2 = 'delivery-d1e2b1c0d9e8f7a6b5c4d3e2f1a0b9c2';
export const DLV_T4_V1 = 'delivery-d4e1c2d3e4f5a6b7c8d9e0f1a2b3c4d5';

/** Conversations (32 hex). */
export const C1 = 'c1f0e9d8c7b6a5f4e3d2c1b0a9f8e7d1';
export const C2 = 'c2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c2';
export const C3 = 'c3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d3';
export const C4 = 'c4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e4';
export const C5 = 'c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f5';
/** Archived conversations. */
export const C6 = 'c6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a6';
export const C7 = 'c7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b7';
export const C8 = 'c8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c8';

/** Goals (32 hex). */
export const G1 = 'a9e1b2c3d4e5f60718293a4b5c6d7e01';
export const G2 = 'a9e2c3d4e5f6071829304a5b6c7d8e02';

/** Memory facts (`fact_id`). */
export const F1 = 'f1a0c2e4b6d84f1a9c3e5b7d9f1a3c51';
export const F2 = 'f2b1d3f5c7e94a2b8d4f6c8e0a2b4d62';
export const F3 = 'f3c2e4a6d8f05b3c9e5a7d9f1b3c5e73';
export const F4 = 'f4d3f5b7e9a16c4d0f6b8e0a2c4d6f84';
export const F5 = 'f5e4a6c8f0b27d5e1a7c9f1b3d5e7a95';
export const F6 = 'f6f5b7d9a1c38e6f2b8d0a2c4e6f8ba6';
export const F7 = 'f7a6c8e0b2d49f7a3c9e1b3d5f7a9cb7';
export const F8 = 'f8b7d9f1c3e5a08b4d0f2c4e6a8b0dc8';

/** Today's episodes (int ids; the domain keeps `String(id)`). */
export const E1 = 1201;
export const E2 = 1202;
export const E3 = 1203;
export const E4 = 1204;
export const E5 = 1205;

/** `?demo=code-review`: coding tasks only the ledger knows, one waiting for 验收 with no check command, one whose check failed. */
export const CODE_REVIEW = 'task:1b2c3d4e5f6a7b81';
export const CODE_FAILED = 'task:2c3d4e5f6a7b8c92';

/** Fact id in agentd's 32-hex form for a prototype key (`a3` → `f31a3…`). */
export const v31Id = (key: string) => `f31${key}`.padEnd(32, '0');

/** Character the fixtures run as. */
export const CHARACTER = 'si';
