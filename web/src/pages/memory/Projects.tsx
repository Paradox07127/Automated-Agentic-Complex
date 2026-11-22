import { useState, type Ref } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get, seg } from '../../bridge/agentd';
import { keyText } from '../../bridge/platformText';
import type { MemoryTaskResponse, MemoryTasksResponse } from '../../bridge/agentd-routes.generated';
import { secToMs } from '../../domain/units';
import { Empty, ErrBar, KV, OpenSec, Region, Row, RowPlate, SearchField, Sheet, Skel, type RegionSource } from '../../ui';
import { errorText } from './errors';
import { hm, ymd } from './model';
import m from './Memory.module.css';
import styles from './Projects.module.css';

export type WorkTask = MemoryTasksResponse['tasks'][number];
type WorkSession = MemoryTaskResponse['sessions'][number];

/** worklog.py task statuses, in the order the groups are listed. */
const GROUPS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'active', label: '进行中' },
  { id: 'parked', label: '搁置' },
  { id: 'done', label: '完成' },
  { id: 'uncertain', label: '不确定' },
];
const AGENT: Readonly<Record<string, string>> = { claude: 'Claude Code', codex: 'Codex' };

/** Search over the title, goal and progress, as the fact list searches its text. */
export function projectMatches(t: WorkTask, q: string): boolean {
  const s = q.trim().toLowerCase();
  return !s || `${t.title} ${t.goal} ${t.progress}`.toLowerCase().includes(s);
}

export interface ProjectsProps {
  source: RegionSource<WorkTask[]>;
  now: number;
  q: string;
  onQ: (q: string) => void;
  searchRef: Ref<HTMLInputElement>;
  /** Opens a session on 今天. */
  onSession: (id: string) => void;
}

/** 项目：工作记忆的任务，按状态分组的记录行「00.101 名称 / 项目 … 日期 │ 会话数」；只有一个项目时下面一句说明；点一行开右侧抽屉。 */
export function Projects({ source, q, onQ, searchRef, onSession }: ProjectsProps) {
  const [open, setOpen] = useState<WorkTask | null>(null);
  return (
    <OpenSec title="项目" count={source.data?.filter((t) => projectMatches(t, q)).length}>
      <div className={styles.tools}>
        <SearchField inputRef={searchRef} value={q} label="搜索记忆" placeholder={keyText('搜索项目和记忆 ⌘F')} onChange={onQ} />
      </div>
      <Region q={source} what="项目" reserve={{ rows: 4 }} empty={{ text: '还没有项目，后台整理会话后会列在这里' }}>
        {(tasks) => {
          const shown = tasks.filter((t) => projectMatches(t, q));
          if (shown.length === 0)
            return (
              <div className={m.none} data-size="sm">
                <span>没有符合条件的项目</span>
                <button type="button" className={m.lnk} onClick={() => onQ('')}>
                  清除条件
                </button>
              </div>
            );
          const groups = GROUPS.map((g) => ({ ...g, rows: shown.filter((t) => t.status === g.id).sort((a, b) => b.last_at - a.last_at) }));
          const order = groups.flatMap((g) => g.rows);
          return (
            <>
              {groups.map(
                (g) =>
                  g.rows.length > 0 && (
                    <div key={g.id} className={styles.grp} role="group" aria-label={g.label}>
                      <div className={styles.gh}>
                        <span className={styles.gt} data-status={g.id}>
                          {g.label}
                        </span>
                        <span className={`${styles.gn} num`}>{g.rows.length}</span>
                      </div>
                      {g.rows.map((t) => (
                        <div key={t.id} data-project={t.id}>
                          <Row
                            title={
                              <>
                                <span className={`${styles.no} num`} aria-hidden="true">
                                  {`00.1${String(order.indexOf(t) + 1).padStart(2, '0')}`}
                                </span>
                                {t.title}
                              </>
                            }
                            sub={t.project ?? undefined}
                            right={
                              <>
                                <span className="num">{ymd(secToMs(t.last_at))}</span>
                                <span className={styles.sep} aria-hidden="true">
                                  │
                                </span>
                                会话 <span className="num">{t.sessions}</span>
                              </>
                            }
                            selected={open?.id === t.id}
                            onClick={() => setOpen(open?.id === t.id ? null : t)}
                          />
                        </div>
                      ))}
                    </div>
                  ),
              )}
              {tasks.length === 1 && <Empty icon="history" title="后台整理新的编码会话后，其他项目会按状态列在这里" />}
            </>
          );
        }}
      </Region>
      {open && <ProjectSheet task={open} onClose={() => setOpen(null)} onSession={onSession} />}
    </OpenSec>
  );
}

/** GET /memory/tasks/{id}: the goal, progress and next step, and the sessions that worked on it. */
function ProjectSheet({ task, onClose, onSession }: { task: WorkTask; onClose: () => void; onSession: (id: string) => void }) {
  const q = useQuery({
    queryKey: ['memory', 'task', task.id],
    queryFn: () => get<MemoryTaskResponse>(`/memory/tasks/${seg(task.id)}`),
    retry: false,
  });
  const t = q.data?.task ?? task;
  const session = (s: WorkSession) => [AGENT[s.agent ?? ''] ?? '角色', hm(secToMs(s.start))].join(' │ ');
  return (
    <Sheet open title={t.title} width={480} onClose={onClose}>
      <div className={styles.sheet}>
        <KV
          items={[
            { key: '目标', value: t.goal },
            { key: '进展', value: t.progress },
            { key: '下一步', value: t.next_step ?? '—' },
          ]}
        />
        <section className={styles.part} aria-label="会话">
          <h3 className={styles.head}>会话</h3>
          {q.isError ? (
            <ErrBar message={`没有读到会话：${errorText(q.error)}`} onRetry={() => void q.refetch()} />
          ) : !q.data ? (
            <Skel rows={2} />
          ) : q.data.sessions.length === 0 ? (
            <p className={m.cap}>还没有会话</p>
          ) : (
            <ul className={styles.sessions}>
              {q.data.sessions.map((s) => (
                <li key={s.id}>
                  <RowPlate title={s.title} meta={session(s)} onClick={() => onSession(s.id)} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Sheet>
  );
}
