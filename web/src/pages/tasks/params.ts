/** Old tab values other pages still send; the page has one view now and ignores them. */
export type TasksTab = 'inbox' | 'all' | 'goals';

export type SourceTab = 'all' | 'claude' | 'codex' | 'role';

/** Page-specific URL state (demo list in route.ts). */
export interface TasksParams {
  /** Source tab; `code` (old link) means all coding tools. */
  src: SourceTab;
  /** A card or task id opens its detail; a pending id flashes its decision card. */
  sel: string | null;
  /** Opens the detail of a card, task or pending item. */
  open: string | null;
  /** Gantt window. */
  range: '2h' | 'day';
  /** Highlights the Write tool in the selected task's tool chart. */
  tools: boolean;
  kind: 'role' | 'code' | 'goal' | null;
  /** Open the create dialog for this kind (cross-page 「新建」). */
  create: 'role' | 'code' | 'goal' | null;
}

const KINDS = ['role', 'code', 'goal'] as const;
const kindOf = (v: string | null) => (KINDS as readonly string[]).includes(v ?? '') ? (v as TasksParams['kind']) : null;

export function parseTasksParams(search: string): TasksParams {
  const q = new URLSearchParams(search);
  const src = q.get('src');
  return {
    src: src === 'claude' || src === 'codex' || src === 'role' ? src : 'all',
    sel: q.get('sel'),
    open: q.get('open'),
    range: q.get('range') === 'day' ? 'day' : '2h',
    tools: q.get('tools') === '1',
    kind: kindOf(q.get('kind')),
    create: kindOf(q.get('create')),
  };
}

export { navigate } from '../../shell/nav';
