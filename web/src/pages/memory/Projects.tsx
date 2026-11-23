import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, patch, seg } from '../../bridge/agentd';
import type { MemoryTaskResponse, MemoryTasksResponse } from '../../bridge/agentd-routes.generated';
import { secToMs } from '../../domain/units';
import { BottomBarSlot } from '../../shell/headerSlot';
import { toast } from '../../shell/toast';
import { keyText } from '../../bridge/platformText';
import { Btn, ErrBar, SearchField, SecHead } from '../../ui';
import { Frame, Line, Lines, Note, Spacer, Text } from './Detail';
import detail from './Detail.module.css';
import { errorText, isConflict } from './errors';
import { LeftCol } from './Index';
import { Keys } from './Keys';
import { hm, ymd } from './model';
import { Block, Cell, DetailCol, DetailHead, Empty, Kv, List, Lnk, Panel, Row, Sep, Skeleton, Glyph, useNarrow, type GlyphName } from './parts';
import styles from './Cols.module.css';

export type WorkTask = MemoryTasksResponse['tasks'][number];
type WorkSession = MemoryTaskResponse['sessions'][number];

/** worklog.py task statuses, in the order the cells are listed. */
const STATUS: ReadonlyArray<{ id: string; label: string; icon: GlyphName }> = [
  { id: 'active', label: '进行中', icon: 'arrow' },
  { id: 'parked', label: '搁置', icon: 'pause' },
  { id: 'done', label: '完成', icon: 'check' },
  { id: 'uncertain', label: '不确定', icon: 'dots' },
];
const AGENT: Readonly<Record<string, string>> = { claude: 'Claude Code', codex: 'Codex' };

/** Search over the title, goal and progress, as the fact list searches its text. */
export function projectMatches(t: WorkTask, q: string): boolean {
  const s = q.trim().toLowerCase();
  return !s || `${t.title} ${t.goal} ${t.progress}`.toLowerCase().includes(s);
}

export interface ProjectsProps {
  /** GET /memory/tasks; undefined while it loads. */
  tasks: WorkTask[] | undefined;
  error: string | null;
  onRetry: () => void;
  initialQ: string;
  /** Opens a session on 今天. */
  onSession: (id: string) => void;
}

/** 项目：左栏四种状态，中栏「00.101 名称 / 项目 日期 会话数」行，右栏目标、进展、下一步和会话；目标记错了可以改。 */
export function Projects({ tasks, error, onRetry, initialQ, onSession }: ProjectsProps) {
  const narrow = useNarrow();
  const [q, setQ] = useState(initialQ);
  const [status, setStatus] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const all = [...(tasks ?? [])].sort((a, b) => STATUS.findIndex((s) => s.id === a.status) - STATUS.findIndex((s) => s.id === b.status) || b.last_at - a.last_at);
  const cur = status ?? STATUS.find((s) => all.some((t) => t.status === s.id))?.id ?? 'active';
  const shown = all.filter((t) => t.status === cur && projectMatches(t, q));
  const open = shown.find((t) => t.id === sel) ?? (narrow ? undefined : shown[0]);
  const label = STATUS.find((s) => s.id === cur)?.label ?? '';

  let list;
  if (error != null) list = <List>{<ErrBar message={`没有读到项目：${error}`} onRetry={onRetry} />}</List>;
  else if (tasks == null) list = <Skeleton />;
  else if (tasks.length === 0) list = <List>{<Empty title="还没有项目，后台整理会话后会列在这里" />}</List>;
  else if (shown.length === 0) list = <List>{<Empty title={q.trim() ? '没有符合条件的项目' : `没有${label}的项目`} {...(q.trim() ? { action: <Lnk onClick={() => setQ('')}>清除条件</Lnk> } : {})} />}</List>;
  else
    list = (
      <List label={label}>
        <SecHead title={label} count={shown.length} micro="Work" />
        {shown.map((t, i) => (
          <div key={t.id} data-project={t.id}>
            <Row
              i={i}
              selected={open?.id === t.id}
              lead={<Glyph name="folder" size={18} />}
              title={
                <>
                  <span className={detail.code} aria-hidden="true">
                    {`00.1${String(all.indexOf(t) + 1).padStart(2, '0')}`}
                  </span>
                  {t.title}
                </>
              }
              sub={
                <>
                  <span>{t.project ?? '—'}</span>
                  <span className="num">{ymd(secToMs(t.last_at))}</span>
                  <span>
                    会话 <span className="num">{t.sessions}</span>
                  </span>
                </>
              }
              onClick={() => (setSel(t.id), setDrawer(narrow))}
            />
          </div>
        ))}
      </List>
    );

  return (
    <div className={styles.body} data-wide={!open || undefined}>
      <LeftCol label="状态">
        <Sep en="Work / Memory" />
        {STATUS.map((s, i) => (
          <Cell key={s.id} i={i} icon={s.icon} label={s.label} count={tasks ? tasks.filter((t) => t.status === s.id).length : null} selected={cur === s.id} onClick={() => (setStatus(s.id), setSel(null), setDrawer(false))} />
        ))}
      </LeftCol>
      <section className={styles.ccol} aria-label="项目">
        <div className={styles.crow}>
          <span className={styles.search}>
            <SearchField value={q} label="搜索项目" placeholder="搜索项目" shortcut={keyText('⌘F')} onChange={setQ} />
          </span>
        </div>
        <Panel>{list}</Panel>
      </section>
      {open && (
        <DetailCol narrow={narrow} open={drawer} label="这个项目" onClose={() => setDrawer(false)}>
          <ProjectDetail key={open.id} task={open} onSession={onSession} {...(narrow ? { onClose: () => setDrawer(false) } : {})} />
        </DetailCol>
      )}
      <BottomBarSlot
        lead={
          <Keys
            keys={[
              [['Q', 'E'], '切页签'],
              [['⌘F'], '搜索'],
              [['Esc'], '回主页'],
            ]}
          />
        }
      />
    </div>
  );
}

/** GET /memory/tasks/{id}: the goal, progress and next step, and the sessions that worked on it; 改目标 is PATCH with the revision. */
function ProjectDetail({ task, onSession, onClose }: { task: WorkTask; onSession: (id: string) => void; onClose?: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['memory', 'task', task.id], queryFn: () => get<MemoryTaskResponse>(`/memory/tasks/${seg(task.id)}`), retry: false });
  const t = q.data?.task ?? task;
  const [goal, setGoal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const session = (s: WorkSession) => `${AGENT[s.agent ?? ''] ?? '角色'} │ ${hm(secToMs(s.start))}`;
  const save = () => {
    const text = goal?.trim();
    if (!text || busy) return;
    setBusy(true);
    patch(`/memory/tasks/${seg(t.id)}`, { expected_revision: t.revision, goal: text })
      .then(
        () => {
          setGoal(null);
          toast('已改目标，下次接着这份做');
        },
        (e: unknown) => toast(isConflict(e) ? '没有改：已在别处更新，已重新读取' : `没有改：${errorText(e)}`),
      )
      .finally(() => {
        setBusy(false);
        void qc.invalidateQueries({ queryKey: ['memory', 'tasks'] });
        void qc.invalidateQueries({ queryKey: ['memory', 'task', t.id] });
      });
  };
  const foot =
    goal != null ? (
      <>
        <Btn variant="secondary" onClick={() => setGoal(null)}>
          取消
        </Btn>
        <Btn icon="check" loading={busy} disabled={!goal.trim()} disabledReason="目标不能为空" onClick={save}>
          保存
        </Btn>
      </>
    ) : (
      <>
        <Btn onClick={() => setGoal(t.goal)}>改目标</Btn>
        <Note>她记错了就改，下次接着这份做</Note>
        <Spacer />
      </>
    );
  return (
    <Frame id={t.id} head={<DetailHead title={t.title} micro={`Task / ${t.status}`} {...(onClose ? { onClose } : {})} />} foot={foot}>
      <div className={detail.kv}>
        <Kv k="目标">
          {goal != null ? (
            <textarea
              className={detail.edit}
              value={goal}
              maxLength={500}
              rows={2}
              aria-label="目标"
              autoFocus
              onChange={(e) => setGoal(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setGoal(null);
                }
              }}
            />
          ) : (
            t.goal
          )}
        </Kv>
        <Kv k="进展">{t.progress}</Kv>
        <Kv k="下一步">{t.next_step ?? '—'}</Kv>
        <Kv k="项目">{t.project ?? '—'}</Kv>
      </div>
      <Block
        title="会话"
        note={
          q.data && (
            <>
              <span className="num">{q.data.sessions.length}</span> 次
            </>
          )
        }
      >
        {q.isError ? (
          <ErrBar message={`没有读到会话：${errorText(q.error)}`} onRetry={() => void q.refetch()} />
        ) : !q.data ? (
          <Text>读取中…</Text>
        ) : q.data.sessions.length === 0 ? (
          <Note>还没有会话</Note>
        ) : (
          <Lines>
            {q.data.sessions.map((s) => (
              <Line key={s.id} at={session(s)} end={<Lnk onClick={() => onSession(s.id)}>在简报里看 ›</Lnk>}>
                {s.title}
              </Line>
            ))}
          </Lines>
        )}
      </Block>
    </Frame>
  );
}
