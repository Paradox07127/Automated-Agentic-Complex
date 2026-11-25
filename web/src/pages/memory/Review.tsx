import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { getBridge } from '../../bridge';
import { keyText } from '../../bridge/platformText';
import { get, seg } from '../../bridge/agentd';
import { BottomBarSlot } from '../../shell/headerSlot';
import { Btn, Empty, ErrBar, InfoTip, Pill, SearchField, SecHead, Skel } from '../../ui';
import { IndexCell } from '../../ui/game';
import { useGo } from './api';
import { Frame, Note, Spacer, Text } from './Detail';
import detail from './Detail.module.css';
import { errorText } from './errors';
import { LeftCol } from './Index';
import { Keys } from './Keys';
import { Block, DetailCol, DetailHead, Glyph, Kv, List, Lnk, Panel, Quote, Row, Sep, useNarrow } from './parts';
import styles from './Cols.module.css';

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
const KINDS: ReadonlyArray<{ id: SourceKind; label: string; icon: 'history' | 'eye' }> = [
  { id: 'work_events', label: '工作片段', icon: 'history' },
  { id: 'raw', label: '原始观察', icon: 'eye' },
];
const ORIGIN: Record<string, string> = {
  work_event: '整理片段', native_ax: '窗口文字', native_ax_tree: '窗口控件', browser: '网页',
  input_event: '交互', selection: '选中文字', local_ocr: '屏幕识读', hook: '编码会话',
};
const STATE: Record<string, string> = {
  working: '处理中', reading: '阅读', comparing: '比较', investigating: '排查',
  blocked: '受阻', waiting: '等待', interrupted: '中断', resumed: '继续', result_observed: '看到结果',
};

const field = (m: Metadata, key: string) => (typeof m[key] === 'string' ? (m[key] as string) : '');
const title = (item: Activity) => field(item.metadata, 'title') || field(item.metadata, 'app') || field(item.metadata, 'url_host') || ORIGIN[item.origin] || '活动记录';
const kindOf = (item: Activity) => STATE[field(item.metadata, 'state')] || ORIGIN[item.origin] || '观察';

function eventOf(text: string): { title?: string; summary?: string; evidence?: Reference[] } | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/** 回顾：她看到过的原始记录，左栏工作片段 / 原始观察，中栏按 10 分钟分段的行（回车搜索），右栏原文或证据；`reads` 为假时（屏幕感知关着）不读。 */
export function Review({ reads = true }: { reads?: boolean }) {
  const narrow = useNarrow();
  const [kind, setKind] = useState<SourceKind>('work_events');
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
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
    enabled: reads,
    retry: false,
  });

  useEffect(
    () =>
      getBridge().feed.subscribe(
        (e) => {
          if (e.event === 'reset') {
            setSel(null);
            void client.resetQueries({ queryKey: KEY });
          }
          if (e.event !== 'observation') return;
          try {
            const event = JSON.parse(e.data) as { analysis_id?: string };
            if (event.analysis_id) void client.invalidateQueries({ queryKey: KEY });
          } catch {
            // An event with an unreadable body does not change the visible records.
          }
        },
        () => void client.invalidateQueries({ queryKey: KEY }),
      ),
    [client],
  );

  useEffect(
    () =>
      getBridge().settings.onChange(({ ids }) => {
        if (!ids.some((id) => ACCESS_SETTINGS.has(id))) return;
        setSel(null);
        void client.resetQueries({ queryKey: KEY });
      }),
    [client],
  );

  const items = [...new Map(list.data?.pages.flatMap((p) => p.items.map((item) => [item.id, item] as const))).values()];
  const open = items.find((x) => x.id === sel) ?? (narrow ? undefined : items[0]);
  const label = KINDS.find((k) => k.id === kind)?.label ?? '';

  let body;
  if (list.isError) body = <List>{<ErrBar message={`未能读取记录：${errorText(list.error)}`} onRetry={() => void list.refetch()} />}</List>;
  else if (!list.data)
    body = (
      <List>
        <Skel rows={6} height={58} />
      </List>
    );
  else if (items.length === 0)
    body = (
      <List>
        <Empty
          size="compact"
          title={query ? '未找到匹配的屏幕活动' : kind === 'work_events' ? '尚未整理出工作片段' : '当前无可读的屏幕观察记录'}
          {...(query ? {} : { action: <Btn onClick={() => go({ page: 'settings', group: 'privacy' })}>打开感知设置</Btn> })}
        />
      </List>
    );
  else
    body = (
      <List label={label}>
        <SecHead title={label} count={items.length} right={<InfoTip>原始观察过期后仅保留整理后的工作片段</InfoTip>} />
        {items.map((item, i) => {
          const slice = Math.floor(item.at / SLICE_SECONDS);
          const start = slice * SLICE_SECONDS * 1000;
          const head = i === 0 || Math.floor(items[i - 1]!.at / SLICE_SECONDS) !== slice;
          const summary = field(item.metadata, 'summary') || (item.origin === 'work_event' ? eventOf(item.excerpt)?.summary : item.excerpt);
          return (
            <div key={item.id} data-activity={item.id}>
              {head && (
                <h3 className={styles.slot}>
                  {DAY.format(start)} │ {CLOCK.format(start)}–{CLOCK.format(start + SLICE_SECONDS * 1000)}
                </h3>
              )}
              <Row
                i={i}
                label={`查看 ${title(item)}`}
                selected={open?.id === item.id}
                lead={<time dateTime={new Date(item.at * 1000).toISOString()}>{CLOCK.format(item.at * 1000)}</time>}
                title={title(item)}
                sub={summary ? <span className={styles.sum}>{summary}</span> : undefined}
                end={<Pill tone="mission">{kindOf(item)}</Pill>}
                onClick={() => (setSel(item.id), setDrawer(narrow))}
              />
            </div>
          );
        })}
        {list.hasNextPage && (
          <span className={styles.more}>
            <Btn variant="secondary" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              加载更早记录
            </Btn>
          </span>
        )}
      </List>
    );

  return (
    <div className={styles.body} data-wide={!open || undefined}>
      <LeftCol label="记录类型">
        <Sep en="Seen / Records" />
        {KINDS.map((k, i) => (
          <IndexCell key={k.id} i={i} icon={<Glyph name={k.icon} />} label={k.label} pressed={kind === k.id} onClick={() => (setKind(k.id), setSel(null), setDrawer(false))} />
        ))}
      </LeftCol>
      <section className={styles.ccol} aria-label="回顾">
        <div className={styles.crow}>
          <span className={styles.search}>
            <SearchField
              value={draft}
              label="搜索活动"
              placeholder="搜索屏幕观察内容（按 Enter 提交）"
              shortcut={keyText('⌘F')}
              maxLength={500}
              onChange={(v) => {
                setDraft(v);
                if (!v) setQuery('');
              }}
              onSubmit={(v) => setQuery(v.trim())}
            />
          </span>
          <span className={styles.sp} />
          <Btn loading={list.isRefetching} onClick={() => void list.refetch()}>
            刷新
          </Btn>
        </div>
        <Panel>{body}</Panel>
      </section>
      {open && (
        <DetailCol narrow={narrow} open={drawer} label="这段记录" onClose={() => setDrawer(false)}>
          <ActivityDetail key={open.id} item={open} onBrief={() => go({ page: 'overview', focus: 'timeline' })} {...(narrow ? { onClose: () => setDrawer(false) } : {})} />
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

/** A record's text, or a work event's summary and its evidence; each piece of evidence opens in place, 返回片段 goes back. */
function ActivityDetail({ item, onBrief, onClose }: { item: Activity; onBrief: () => void; onClose?: () => void }) {
  const [source, setSource] = useState<Reference>({ observation_id: item.id });
  const target = source.observation_id;
  const original = target === item.id;
  const top = useRef<HTMLDivElement>(null);
  const choose = (value: Reference) => {
    setSource(value);
    top.current?.focus();
  };
  const read = useInfiniteQuery({
    queryKey: [...KEY, 'source', target, source.part ?? 'text'],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const chars = target.startsWith('work-') ? 64000 : 8000;
      const reply = await get<SourceRead>(`/observation/sources/${seg(target)}?offset=${pageParam}&max_chars=${chars}&part=${source.part === 'tree' ? 'tree' : 'text'}`);
      if (reply.error) throw new Error('该来源已过期、已被排除或无读取权限');
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
      if (!data || data.length > 6 * 1024 * 1024) throw new Error('该截图已过期或无读取权限');
      return `data:image/png;base64,${data}`;
    },
  });
  const text = read.data?.pages.map((p) => p.text ?? '').join('') ?? '';
  const event = original && item.origin === 'work_event' ? eventOf(text) : null;
  const error = source.image ? image.error : read.error;
  const evidence = (Array.isArray(event?.evidence) ? event.evidence : []).filter((entry) => typeof entry?.observation_id === 'string' && SOURCE_ID.test(entry.observation_id));
  const at = item.at * 1000;
  const foot = (
    <>
      {!original && (
        <Btn variant="secondary" onClick={() => choose({ observation_id: item.id })}>
          返回片段
        </Btn>
      )}
      <Note>每日完整经过可在「每日简报」中查看</Note>
      <Spacer />
      <Lnk onClick={onBrief}>前往简报 ›</Lnk>
    </>
  );
  return (
    <Frame id={item.id} head={<DetailHead title={original ? title(item) : '观察证据'} micro={`${item.origin === 'work_event' ? 'Event' : 'Raw'} / ${CLOCK.format(at)}`} {...(onClose ? { onClose } : {})} />} foot={foot}>
      <div ref={top} tabIndex={-1} className={detail.kv}>
        <Kv k="时间">
          <span className="num">
            {DAY.format(at)} │ {CLOCK.format(at)}
          </span>
        </Kv>
        <Kv k="类型">{original ? kindOf(item) : source.image ? '原始截图' : source.part === 'tree' ? '原始窗口控件' : '原始观察文字'}</Kv>
      </div>
      {(source.image ? image.isPending : read.isPending) && <Text>正在读取出处…</Text>}
      {error && <ErrBar message={errorText(error)} onRetry={() => void (source.image ? image.refetch() : read.refetch())} />}
      {source.image ? (
        image.data && <img className={detail.image} src={image.data} alt="该片段引用的原始截图" />
      ) : event ? (
        <>
          {event.summary && <Text>{event.summary}</Text>}
          <Block title="原始证据">
            {evidence.length === 0 && <Note>没有可打开的证据。</Note>}
            {evidence.map((entry, index) => (
              <Quote key={`${entry.observation_id}-${index}`} meta={<Lnk onClick={() => choose(entry)}>{`查看证据 ${index + 1} ›`}</Lnk>}>
                {typeof entry.quote === 'string' ? `「${entry.quote}」` : '没有摘录'}
              </Quote>
            ))}
          </Block>
        </>
      ) : (
        text && (
          <Block title="原文">
            <pre className={detail.raw} data-selectable="">
              {text}
            </pre>
          </Block>
        )
      )}
      {read.hasNextPage && (
        <span>
          <Btn variant="secondary" loading={read.isFetchingNextPage} onClick={() => void read.fetchNextPage()}>
            继续读取
          </Btn>
        </span>
      )}
    </Frame>
  );
}
