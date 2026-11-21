import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { get } from '../../bridge/agentd';
import type { WireTurn } from '../../domain';
import { Btn, SearchField } from '../../ui';
import { FailLine, whenOf } from './ConvList';
import type { ChatDemoSource } from './demoTypes';
import styles from './AllLines.module.css';

const PAGE = 50;

/** Read the cross-conversation history when the user opens it. */
export function useHistory(enabled: boolean, src: ChatDemoSource | null) {
  const hist = useInfiniteQuery({
    queryKey: ['chat-history', src ? 'demo' : 'live', src?.history.length ?? 0],
    queryFn: ({ pageParam }) => {
      if (src) return Promise.resolve({ turns: src.history, next: null as number | null });
      const qs = pageParam == null ? `limit=${PAGE}` : `limit=${PAGE}&before=${pageParam}`;
      return get<{ turns: WireTurn[]; next: number | null }>(`/history?${qs}`);
    },
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.next ?? undefined,
    enabled,
    retry: false,
    staleTime: 15_000,
  });
  return { hist, turns: (hist.data?.pages ?? []).flatMap((p) => p.turns) };
}

export interface AllLinesProps {
  turns: WireTurn[];
  roleName: (characterId: string) => string;
  now: number;
  loading: boolean;
  error: boolean;
  more: boolean;
  fetchingMore: boolean;
  onMore: () => void;
  onRetry: () => void;
  onPick: (turn: WireTurn) => void;
}

function snippet(t: WireTurn): string {
  if (t.source === 'text' || t.source === 'voice') return t.user_text || t.reply;
  return t.reply;
}

export function AllLines({ turns, roleName, now, loading, error, more, fetchingMore, onMore, onRetry, onPick }: AllLinesProps) {
  const [search, setSearch] = useState('');
  const needle = search.trim().toLocaleLowerCase();
  const rows = turns.filter((t) => snippet(t) && (!needle || [snippet(t), t.reply].some((v) => v.toLocaleLowerCase().includes(needle))));
  return (
    <section className={styles.root} aria-label="历史记录">
      <SearchField value={search} onChange={setSearch} label="搜索已载入的记录" placeholder="搜索已载入的记录" />
      {error && <FailLine what="历史记录" onRetry={onRetry} />}
      {loading ? <p role="status">正在读取…</p> : (
        <ul className={styles.list}>
          {rows.map((t) => {
            const text = snippet(t);
            const mine = (t.source === 'text' || t.source === 'voice') && Boolean(t.user_text);
            const who = mine ? '用户' : roleName(t.character_id);
            const content = <><span className={styles.who}>{who}</span><span className={styles.text} title={text}>{text}</span><span className={styles.when}>{whenOf((t.ended_at ?? t.started_at) * 1000, now)}</span></>;
            return <li key={t.event_id} data-mine={mine || undefined}>{t.turn_id && t.conversation_id
              ? <button type="button" className={styles.line} onClick={() => onPick(t)}>{content}</button>
              : <div className={styles.line}>{content}</div>}</li>;
          })}
        </ul>
      )}
      {!loading && !error && rows.length === 0 && <p>{needle ? '已载入的记录中没有匹配项。' : '还没有历史记录。'}</p>}
      {more && !loading && <Btn size="sm" variant="text" loading={fetchingMore} onClick={onMore}>加载更早的记录</Btn>}
    </section>
  );
}
