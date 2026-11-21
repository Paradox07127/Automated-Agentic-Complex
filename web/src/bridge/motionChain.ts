// `avatar.motionChain.*` types: a structure proposal for C9 `motion_tool.py chain`, re-exported through motionOverrides.ts.

/** One edit, applied in order. `index` counts segments from 0 and is ≥ 1; null in `set` removes the field; `hold` only on a loop. */
export type ChainEdit =
  | { op: 'set'; clip: string; next?: string | null; exit?: string | null; hold?: number | null }
  | { op: 'replace'; chain: string; index: number; clip: string }
  | { op: 'insert'; chain: string; index: number; clip: string }
  | { op: 'blend'; clip: string; seconds: number };

/** `package_sha256` is the sha256 of the installed pack's character.json the edits were made against. */
export interface ChainProposal {
  schema: 'endfield-motion-chain-proposal/v1';
  character: string;
  package_sha256: string;
  edits: ChainEdit[];
}

/** `edit` is the index into `edits`; null for the whole proposal or a chain. `reason` may carry `:<clip>` or `:<a>><b>`. */
export interface ChainProblem {
  edit: number | null;
  reason: string;
}

/** `avatar.motionChain.check`; `graph_changes` lists chain keys, all empty when there are problems. */
export interface ChainCheck {
  ok: boolean;
  problems: ChainProblem[];
  graph_changes: { chains_added: string[]; chains_removed: string[]; chains_changed: string[] };
}

/** `avatar.motionChain.apply`: the pack's new version. */
export interface ChainApplied {
  ok: true;
  character: string;
  version: string;
}

export interface MotionChainOps {
  /** Checks the proposal against the installed pack; writes nothing. */
  check(p: ChainProposal): Promise<ChainCheck>;
  /**
   * Rebuilds the pack with the proposal and reloads her; resolves once she is back. Rejects with `stale`, `bad_proposal` or
   * `chain_refused` (detail: the problems JSON), `busy`, `validate_failed`, `internal`, `invalid_args` or `not_implemented`.
   */
  apply(p: ChainProposal): Promise<ChainApplied>;
}
