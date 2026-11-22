import { useEffect, useRef, useState, type Ref } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { getBridge } from '../../bridge';
import { get, seg } from '../../bridge/agentd';
import { Btn, Dialog, ErrBar, Icon, Region, SearchField, Seg } from '../../ui';
import { useGo } from './api';
import { errorText } from './errors';
import styles from './ActivityReview.module.css';

type SourceKind = 'work_events' | 'raw';
type Metadata = Record<string, unknown>;
interface Activity {
  id: string;
  at: number;
  origin: string;
  metadata: Metadata;
  excerpt: string;
}
interface ActivityPage {
  items: Activity[];
  next_cursor: string | null;
}
interface SourceRead {
  text?: string;
  next_offset?: number | null;
  error?: { code: string };
}
interface Reference {
  observation_id: string;
  quote?: string;
  image?: boolean;
  part?: 'text' | 'tree';
}

const KEY = ['memory', 'activity'];
const ACCESS_SETTINGS = new Set(['wintext', 'web', 'typing', 'agent_sessions', 'pause', 'exclude']);
const SOURCE_ID = /^(?:obs|work)-[a-f0-9]{32}$/;
const DAY = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
const CLOCK = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
const SLICE_SECONDS = 600;
const ORIGIN: Record<string, string> = {
  work_event: '整理片段', native_ax: '窗口文字', native_ax_tree: '窗口控件', browser: '网页',
  input_event: '交互', selection: '选中文字', local_ocr: '屏幕识读', hook: '编码会话',
};
const STATE: Record<string, string> = {
  working: '处理中', reading: '阅读', comparing: '比较', investigating: '排查',
  blocked: '受阻', waiting: '等待', interrupted: '中断', resumed: '继续', result_observed: '看到结果',
};

const field = (m: Metadata, key: string) => typeof m[key] === 'string' ? m[key] as string : '';
const title = (item: Activity) =>
  field(item.metadata, 'title') || field(item.metadata, 'app') || field(item.metadata, 'url_host') || ORIGIN[item.origin] || '活动记录';

function eventOf(text: string): { title?: string; summary?: string; evidence?: Reference[] } | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

export function ActivityReview({ searchRef }: { searchRef: Ref<HTMLInputElement> }) {
  const [kind, setKind] = useState<SourceKind>('work_events');
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Activity | null>(null);
  const client = useQueryClient();
  const go = useGo();
  const list = useInfiniteQuery({
    queryKey: [...KEY, kind, query],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ kind, limit: '18', query });
      if (pageParam) params.set('cursor', pageParam);
      return get<ActivityPage>(`/observation/sources?${params}`);
    },
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    retry: false,
  });

  useEffect(() => getBridge().feed.subscribe((e) => {
    if (e.event === 'reset') {
      setSelected(null);
      void client.resetQueries({ queryKey: KEY });
    }
    if (e.event !== 'observation') return;
    try {
      const event = JSON.parse(e.data) as { analysis_id?: string };
      if (event.analysis_id) void client.invalidateQueries({ queryKey: KEY });
    } catch {
      // An event with an unreadable body does not change the visible records.
    }
  }, () => void client.invalidateQueries({ queryKey: KEY })), [client]);

  useEffect(() => getBridge().settings.onChange(({ ids }) => {
    if (!ids.some((id) => ACCESS_SETTINGS.has(id))) return;
    setSelected(null);
    void client.resetQueries({ queryKey: KEY });
  }), [client]);

  const entries = [...new Map(list.data?.pages.flatMap((p) => p.items.map((item) => [item.id, item] as const))).values()];
  return (
    <section className={styles.review} aria-label="活动回顾">
      <div className={styles.tools}>
        <Seg label="记录类型" value={kind} onChange={(value) => setKind(value as SourceKind)} options={[
          { value: 'work_events', label: '工作片段' },
          { value: 'raw', label: '原始观察' },
        ]} />
        <form role="search" className={styles.search} onSubmit={(e) => { e.preventDefault(); setQuery(draft.trim()); }}>
          <SearchField inputRef={searchRef} label="搜索活动" placeholder="搜索活动内容" value={draft} onChange={(value) => {
            setDraft(value.slice(0, 500));
            if (!value) setQuery('');
          }} />
          <button type="submit" className={styles.searchSubmit}>搜索</button>
        </form>
        <Btn size="sm" variant="ghost" loading={list.isRefetching} onClick={() => void list.refetch()}>刷新</Btn>
      </div>
      <Region q={{ status: list.status, data: list.data && entries, error: list.error && new Error(errorText(list.error)), refetch: list.refetch }} what="活动记录" reserve={{ rows: 3 }}
        empty={{
          text: query ? '没有符合搜索的活动' : kind === 'work_events' ? '还没有整理出的工作片段' : '当前没有可读取的观察',
          ...(query ? {} : {
            action: <Btn size="sm" variant="secondary" onClick={() => go({ page: 'settings', group: 'privacy' })}>打开观察设置</Btn>,
          }),
        }}>
        {(items) => (
          <ol className={styles.list}>
            {items.map((item, i) => {
              const slice = Math.floor(item.at / SLICE_SECONDS);
              const start = slice * SLICE_SECONDS * 1000;
              const showTime = i === 0 || Math.floor(items[i - 1]!.at / SLICE_SECONDS) !== slice;
              const state = STATE[field(item.metadata, 'state')];
              const summary = field(item.metadata, 'summary') || (item.origin === 'work_event' ? eventOf(item.excerpt)?.summary : item.excerpt);
              return (
                <li key={item.id}>
                  {showTime && <h3 className={styles.day}>{DAY.format(start)} │ {CLOCK.format(start)}–{CLOCK.format(start + SLICE_SECONDS * 1000)}</h3>}
                  <button className={styles.row} type="button" onClick={() => setSelected(item)} aria-label={`查看 ${title(item)}`}>
                    <time dateTime={new Date(item.at * 1000).toISOString()}>{CLOCK.format(item.at * 1000)}</time>
                    <div className={styles.record}>
                      <strong>{title(item)}</strong>
                      {summary && <p>{summary}</p>}
                    </div>
                    <span className={styles.source}>{state || ORIGIN[item.origin] || '观察'}</span>
                    <Icon name="chev" size={16} />
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </Region>
      {list.hasNextPage && <Btn variant="secondary" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>加载更早的活动</Btn>}
      {selected && <ActivityDetail key={selected.id} item={selected} onClose={() => setSelected(null)} />}
    </section>
  );
}

function ActivityDetail({ item, onClose }: { item: Activity; onClose: () => void }) {
  const [source, setSource] = useState<Reference>({ observation_id: item.id });
  const target = source.observation_id;
  const original = target === item.id;
  const details = useRef<HTMLDivElement>(null);
  const choose = (value: Reference) => {
    setSource(value);
    details.current?.focus();
  };
  const read = useInfiniteQuery({
    queryKey: [...KEY, 'source', target, source.part ?? 'text'],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const chars = target.startsWith('work-') ? 64000 : 8000;
      const reply = await get<SourceRead>(`/observation/sources/${seg(target)}?offset=${pageParam}&max_chars=${chars}&part=${source.part === 'tree' ? 'tree' : 'text'}`);
      if (reply.error) throw new Error('这条出处已过期、被排除或没有读取权限');
      return reply;
    },
    getNextPageParam: (last) => last.next_offset ?? undefined,
    retry: false,
    gcTime: 0,
    enabled: !source.image,
  });
  const image = useQuery({
    queryKey: [...KEY, 'image', target],
    enabled: source.image === true,
    retry: false,
    gcTime: 0,
    queryFn: async () => {
      const reply = await get<{ content?: Array<{ mimeType: string; data: string }> }>(`/observation/sources/${seg(target)}/image`);
      const data = reply.content?.find((entry) => entry.mimeType === 'image/png')?.data;
      if (!data || data.length > 6 * 1024 * 1024) throw new Error('这张截图已过期或没有读取权限');
      return `data:image/png;base64,${data}`;
    },
  });
  const body = read.data?.pages.map((p) => p.text ?? '').join('') ?? '';
  const event = original && item.origin === 'work_event' ? eventOf(body) : null;
  const error = source.image ? image.error : read.error;
  const evidence = (Array.isArray(event?.evidence) ? event.evidence : [])
    .filter((entry) => typeof entry?.observation_id === 'string' && SOURCE_ID.test(entry.observation_id));
  return (
    <Dialog open title={original ? title(item) : '观察证据'} onClose={onClose} footer={
      <>
        {!original && <Btn variant="secondary" onClick={() => choose({ observation_id: item.id })}>返回片段</Btn>}
        <Btn variant="ghost" onClick={onClose}>关闭</Btn>
      </>
    }>
      <div ref={details} tabIndex={-1} className={styles.detail}>
        <p className={styles.source}>{original
          ? `${DAY.format(item.at * 1000)} │ ${CLOCK.format(item.at * 1000)} │ ${ORIGIN[item.origin] ?? '观察'}`
          : source.image ? '原始截图' : source.part === 'tree' ? '原始窗口控件' : '原始观察文字'}</p>
        {(source.image ? image.isPending : read.isPending) && <p role="status">正在读取出处…</p>}
        {error && <ErrBar message={errorText(error)} onRetry={() => void (source.image ? image.refetch() : read.refetch())} />}
        {source.image ? image.data && <img className={styles.image} src={image.data} alt="该片段引用的原始截图" /> : event ? (
          <>
            <p>{event.summary}</p>
            <h3>原始证据</h3>
            {evidence.length === 0 && <p>没有可打开的证据。</p>}
            <ul className={styles.evidence}>
              {evidence.map((entry, index) => (
                <li key={`${entry.observation_id}-${index}`}>
                  {typeof entry.quote === 'string' && <blockquote>{entry.quote}</blockquote>}
                  <Btn size="sm" variant="secondary" onClick={() => choose(entry)}>
                    查看证据 {index + 1}
                  </Btn>
                </li>
              ))}
            </ul>
          </>
        ) : body ? <pre className={styles.raw} data-selectable="">{body}</pre> : null}
        {read.hasNextPage && <Btn size="sm" variant="secondary" loading={read.isFetchingNextPage} onClick={() => void read.fetchNextPage()}>继续读取</Btn>}
      </div>
    </Dialog>
  );
}
