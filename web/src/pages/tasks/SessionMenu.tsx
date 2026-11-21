import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AgentdCallError, CONFLICT_CODES, del, get, put, seg } from '../../bridge/agentd';
import type { WireSession } from '../../domain';
import { useToast } from '../../shell/toast';
import { Btn, Dialog, Menu } from '../../ui';
import { failMessage } from './actions';
import form from './CreateForm.module.css';

/** own.py TITLE_MAX. */
const TITLE_MAX = 80;

/** Why a session write failed; `busy` (a turn is running) is not someone else's change. */
function whyNot(e: unknown): string {
  if (e instanceof AgentdCallError && e.code === 'busy') return '会话正在执行这一轮，先停下再归档或删除';
  if (e instanceof AgentdCallError && e.code === 'invalid_title') return `标题要 1–${TITLE_MAX} 个字`;
  return failMessage(e);
}

const conflict = (e: unknown) => e instanceof AgentdCallError && e.code !== 'busy' && (e.status === 409 || CONFLICT_CODES.has(e.code));

/** ⋯ of an own coding session: rename, archive or unarchive, delete (asks first). PUT/DELETE /sessions/{own id} carry the revision read from GET /sessions. */
export function SessionMenu({ sessionId }: { sessionId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['tasks-page', 'session', sessionId];
  const row = useQuery({
    queryKey: key,
    queryFn: async () => (await get<{ sessions: WireSession[] }>('/sessions')).sessions.find((s) => s.session_id === sessionId && s.own) ?? null,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null);
  const [title, setTitle] = useState('');
  const s = row.data ?? null;
  const name = s?.title ?? '这个会话';
  const off = s?.revision == null ? (row.isError ? '会话信息没读到' : '正在读取会话信息') : null;

  const write = async (send: (v: number) => Promise<unknown>, done: string) => {
    if (s?.revision == null) return;
    try {
      await send(s.revision);
      toast(done);
    } catch (e) {
      toast(whyNot(e));
      if (!conflict(e)) return;
    }
    void qc.invalidateQueries({ queryKey: ['tasks-page'] });
  };
  const trimmed = title.trim();

  return (
    <>
      <Menu
        label="会话操作"
        icon="more"
        align="right"
        items={[
          { kind: 'item', label: '重命名…', ...(off ? { disabled: true, reason: off } : {}), onSelect: () => (setTitle(s?.title ?? ''), setDialog('rename')) },
          {
            kind: 'item',
            label: s?.archived ? '取消归档' : '归档',
            ...(off ? { disabled: true, reason: off } : {}),
            onSelect: () => void write((v) => put(`/sessions/${seg(sessionId)}`, { expected_version: v, archived: !s?.archived }), s?.archived ? '已取消归档' : '已归档会话'),
          },
          { kind: 'sep' },
          { kind: 'item', label: '删除…', danger: true, ...(off ? { disabled: true, reason: off } : {}), onSelect: () => setDialog('delete') },
        ]}
      />
      {dialog === 'rename' && (
        <Dialog
          open
          title="重命名会话"
          onClose={() => setDialog(null)}
          footer={
            <>
              <Btn variant="secondary" onClick={() => setDialog(null)}>
                取消
              </Btn>
              <Btn
                variant="primary"
                disabled={!trimmed || trimmed.length > TITLE_MAX}
                disabledReason={`标题要 1–${TITLE_MAX} 个字`}
                onClick={() => {
                  setDialog(null);
                  void write((v) => put(`/sessions/${seg(sessionId)}`, { expected_version: v, title: trimmed }), `已改名：${trimmed}`);
                }}
              >
                保存
              </Btn>
            </>
          }
        >
          <label className={form.field}>
            会话标题
            <input className={form.input} value={title} maxLength={TITLE_MAX + 20} onChange={(e) => setTitle(e.target.value)} />
          </label>
        </Dialog>
      )}
      {dialog === 'delete' && (
        <Dialog
          open
          title={`删除会话「${name}」？`}
          onClose={() => setDialog(null)}
          footer={
            <>
              <Btn variant="secondary" onClick={() => setDialog(null)}>
                不删除
              </Btn>
              <Btn
                variant="danger"
                onClick={() => {
                  setDialog(null);
                  void write((v) => del(`/sessions/${seg(sessionId)}`, { expected_version: v }), '已删除会话');
                }}
              >
                删除
              </Btn>
            </>
          }
        >
          <p>只删除 Agentic Complex 记下的这个会话和它的输出，工作目录里的文件不动。删除后不能恢复。</p>
        </Dialog>
      )}
    </>
  );
}
