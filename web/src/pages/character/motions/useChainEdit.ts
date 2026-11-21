// 链详情「编辑结构」: the structure proposal being built, the answer to its last check or apply, and applying it.
import { useState } from 'react';
import { getBridge, type ChainCheck, type ChainEdit, type ChainProblem, type ChainProposal } from '../../../bridge';
import type { Toast } from '../feedback';
import { addEdit } from './chainEdit';
import { chainFailure, reasonText } from './chainReasons';

/** The last check's verdict, or why the last check or apply failed. */
export type ChainOutcome = { check: ChainCheck } | { failed: string; problems: ChainProblem[] };

/** `sha` is the installed pack's character.json sha256 the graph was read from; `onApplied` reads the rebuilt pack again. */
export function useChainEdit(character: string, sha: string | undefined, toast: Toast, onApplied: () => void) {
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<ChainEdit[]>([]);
  const [outcome, setOutcome] = useState<ChainOutcome | null>(null);
  const [busy, setBusy] = useState<'check' | 'apply' | null>(null);
  const problems = !outcome ? [] : 'check' in outcome ? outcome.check.problems : outcome.problems;
  const change = (next: ChainEdit[]) => {
    setEdits(next);
    setOutcome(null);
  };
  const proposal = (): ChainProposal => ({ schema: 'endfield-motion-chain-proposal/v1', character, package_sha256: sha ?? '', edits });
  const failed = (e: unknown) => {
    const f = chainFailure(e);
    setOutcome({ failed: f.text, problems: f.problems });
  };

  return {
    editing,
    edits,
    outcome,
    busy,
    hasSha: !!sha,
    toggle: () => setEditing((on) => !on),
    add: (e: ChainEdit) => change(addEdit(edits, e)),
    discard: () => change([]),
    /** In Chinese, the problems of the edits that put `clip` in or set it. */
    problemsOf: (clip: string) => problems.filter((p) => p.edit != null && edits[p.edit]?.clip === clip).map((p) => reasonText(p.reason)),
    /** In Chinese, the problems not tied to one of `clips`. */
    general: (clips: string[]) =>
      problems.filter((p) => p.edit == null || !clips.includes(edits[p.edit]?.clip ?? '')).map((p) => reasonText(p.reason)),
    check: () => {
      setBusy('check');
      void getBridge()
        .avatar.motionChain.check(proposal())
        .then((check) => setOutcome({ check }), failed)
        .finally(() => setBusy(null));
    },
    apply: () => {
      setBusy('apply');
      void getBridge()
        .avatar.motionChain.apply(proposal())
        .then((r) => {
          toast(`已应用到角色包（版本 ${r.version}）`);
          change([]);
          setEditing(false);
          onApplied();
        }, failed)
        .finally(() => setBusy(null));
    },
  };
}

export type ChainEditState = ReturnType<typeof useChainEdit>;
