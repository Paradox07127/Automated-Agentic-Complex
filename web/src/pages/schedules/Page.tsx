import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AgentdCallError, del, get, post, put, seg } from '../../bridge/agentd';
import { appNow } from '../../bridge/clock';
import type { ConversationsResponse } from '../../bridge/agentd-routes.generated';
import { failureText } from '../../domain/errorText';
import { fromSchedule, scheduleItemView, type Schedule, type WireSchedule } from '../../domain/schedules';
import { useDemo } from '../../shell/demo';
import { useToast } from '../../shell/toast';
import { Btn, OpenSec, PageIssues, Pill, Region, Switch } from '../../ui';
import { ToolBar } from '../diag/ToolBar';
import type { WireScope } from '../settings/wire';
import { draftFromSchedule, emptyDraft, ScheduleDialog, triggerFromDraft, type ScheduleDraft } from './ScheduleForm';
import styles from './Page.module.css';

function errMsg(e: unknown): string {
  if (e instanceof AgentdCallError) return scheduleError(e.code) ?? failureText(e).text;
  if (e instanceof Error && e.message) return e.message;
  return '操作未完成，请稍后重试';
}

function scheduleError(code: string | null): string | null {
  switch (code) {
    case 'scope_expired': return '资料授权已到期，请编辑任务并重新选择资料';
    case 'scope_revoked': return '资料授权已撤销，请编辑任务并重新选择资料';
    case 'unknown_scope': return '原资料范围已不可用，请编辑任务并重新选择资料';
    case 'scope_changed': return '原资料已移动或替换，请编辑任务并重新选择资料';
    case 'schedule_conversation_unavailable': return '原对话已不可用，请编辑任务并重新选择对话';
    default: return null;
  }
}

export function SchedulesPage() {
  const { state } = useDemo();
  const toast = useToast();
  const client = useQueryClient();
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const [saving, setSaving] = useState(false);

  const q = useQuery<Schedule[], Error>({
    queryKey: ['schedules', state],
    enabled: state !== 'loading',
    retry: false,
    queryFn: async () => {
      if (state === 'empty') return [];
      const res = await get<{ schedules: WireSchedule[] }>(`/schedules${!window.agenticComplex && state === 'error' ? '?fail=1' : ''}`).catch(
        (e: unknown) => {
          throw new Error(errMsg(e), { cause: e });
        },
      );
      return res.schedules.map(fromSchedule);
    },
  });
  const options = useQuery({
    queryKey: ['schedule-context-options'],
    queryFn: async () => {
      const [scopes, conversations] = await Promise.all([
        get<{ scopes: Array<WireScope & { files?: Array<{ path: string }> }> }>('/agent/scopes'),
        get<ConversationsResponse>('/conversations'),
      ]);
      return {
        scopes: scopes.scopes.filter((s) => !s.revoked && s.expires_at * 1000 > appNow()).map((s) => {
          const paths = [...s.roots, ...(s.files ?? [])].map((entry) => entry.path);
          return { id: s.scope_id, label: paths.join('、') || s.output.path };
        }),
        conversations: conversations.conversations.filter((c) => !c.archived).map((c) => ({ id: c.id, label: c.title || '未命名对话' })),
      };
    },
    enabled: q.isSuccess || draft !== null,
    retry: false,
  });

  const list = q.data ?? [];
  const enabledCount = list.filter((s) => s.enabled).length;
  const firstDisabledId =
    (list.find((s) => !s.enabled && s.created_from === 'agent_proposal') ?? list.find((s) => !s.enabled))?.schedule_id ?? null;

  const refresh = () => void client.invalidateQueries({ queryKey: ['schedules'] });

  const handleToggle = async (s: Schedule, next: boolean) => {
    try {
      await put<{ schedule: WireSchedule }>(`/schedules/${seg(s.schedule_id)}`, { enabled: next });
      refresh();
      toast(next ? `已启用「${s.title}」` : `已停用「${s.title}」`);
    } catch (e) {
      toast(errMsg(e));
    }
  };

  const handleRunNow = async (s: Schedule) => {
    try {
      await post<{ job_id: string }>(`/schedules/${seg(s.schedule_id)}/run`, {});
      refresh();
      toast(`已开始运行「${s.title}」`);
    } catch (e) {
      toast(errMsg(e));
    }
  };

  const handleDelete = async (s: Schedule) => {
    try {
      await del<{ deleted: boolean }>(`/schedules/${seg(s.schedule_id)}`);
      refresh();
      toast(`已删除「${s.title}」`);
    } catch (e) {
      toast(errMsg(e));
    }
  };

  const handleSave = async () => {
    if (!draft) return;
    const trigger = triggerFromDraft(draft);
    if (!trigger) return;
    const title = draft.title.trim();
    const instruction = draft.instruction.trim();
    if (!title || !instruction) return;
    setSaving(true);
    try {
      const payload = { title, instruction, trigger, scope_id: draft.scopeId, conversation_id: draft.conversationId };
      if (draft.scheduleId) {
        await put<{ schedule: WireSchedule }>(`/schedules/${seg(draft.scheduleId)}`, payload);
        toast(`已更新「${title}」`);
      } else {
        await post<{ schedule: WireSchedule }>('/schedules', {
          ...payload,
          enabled: true,
        });
        toast(`已新建「${title}」`);
      }
      setDraft(null);
      refresh();
    } catch (e) {
      toast(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.page} data-page="schedules" data-nav-target="page">
      <ToolBar
        action={
          <Btn variant="secondary" size="sm" icon="plus" onClick={() => setDraft(emptyDraft())}>
            新建定时任务
          </Btn>
        }
      />
      <div className={styles.body}>
        <PageIssues>
          <OpenSec
            no="01"
            title="定时任务"
            count={q.data !== undefined ? list.length : undefined}
            right={
              q.data !== undefined && (
                <span className={styles.cap}>
                  {enabledCount > 0 ? (
                    <>
                      <span className="num">{enabledCount}</span> 个开着
                    </>
                  ) : (
                    '全部未启用'
                  )}
                </span>
              )
            }
          >
            <Region
              q={q}
              what="定时任务"
              reserve={{ rows: 3 }}
              skel="rows"
              empty={{
                text: '还没有定时任务',
                action: (
                  <Btn size="sm" variant="secondary" onClick={() => setDraft(emptyDraft())}>
                    新建定时任务
                  </Btn>
                ),
              }}
            >
              {(items) => (
                <ul className={styles.list} aria-label="定时任务列表">
                  {items.map((s) => {
                    const v = scheduleItemView(s);
                    const isPrimaryEnable = !s.enabled && s.schedule_id === firstDisabledId;
                    return (
                      <li key={s.schedule_id} className={styles.row} data-schedule-id={s.schedule_id}>
                        <div className={styles.main}>
                          <div className={styles.titleRow}>
                            <span className={styles.title}>{s.title}</span>
                            {v.proposalTag && <Pill tone="attention">{v.proposalTag}</Pill>}
                            <span className={styles.trigger}>{v.triggerText}</span>
                          </div>
                          <p className={styles.instruction}>{s.instruction}</p>
                          <div className={styles.meta}>
                            <span>
                              下次运行：<span className="num">{v.nextRunText ?? '未排期'}</span>
                            </span>
                            {v.lastRunText && (
                              <span>
                                上次运行：<span className="num">{v.lastRunText}</span>
                              </span>
                            )}
                            <span title={options.data?.scopes.find((scope) => scope.id === s.scope_id)?.label}>
                              {s.scope_id ? '已绑定资料' : '无资料'}
                            </span>
                            <span>{s.conversation_id ? options.data?.conversations.find((c) => c.id === s.conversation_id)?.label ?? '已绑定对话' : '独立任务'}</span>
                          </div>
                          {s.last_error && <p className={styles.instruction} role="status">{scheduleError(s.last_error) ?? '上次运行未能提交，请重试或查看诊断'}</p>}
                        </div>
                        <div className={styles.actions}>
                          {v.actionKind === 'enable_button' ? (
                            <Btn
                              variant={isPrimaryEnable ? 'primary' : 'secondary'}
                              size="sm"
                              onClick={() => void handleToggle(s, true)}
                            >
                              {v.actionLabel}
                            </Btn>
                          ) : (
                            <Switch
                              checked={s.enabled}
                              label={`启用「${s.title}」`}
                              onChange={(next) => void handleToggle(s, next)}
                            />
                          )}
                          <Btn variant="secondary" size="sm" onClick={() => void handleRunNow(s)}>
                            立即运行<span className={styles.vh}>「{s.title}」</span>
                          </Btn>
                          <Btn variant="secondary" size="sm" onClick={() => setDraft(draftFromSchedule(s))}>
                            编辑<span className={styles.vh}>「{s.title}」</span>
                          </Btn>
                          <Btn variant="danger" size="sm" onClick={() => void handleDelete(s)}>
                            删除<span className={styles.vh}>「{s.title}」</span>
                          </Btn>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Region>
          </OpenSec>
        </PageIssues>
      </div>
      <ScheduleDialog
        draft={draft}
        saving={saving}
        onChange={setDraft}
        onClose={() => setDraft(null)}
        onSave={() => void handleSave()}
        scopes={options.data?.scopes ?? []}
        conversations={options.data?.conversations ?? []}
        optionsState={options.status}
        onRetry={() => void options.refetch()}
      />
    </div>
  );
}
