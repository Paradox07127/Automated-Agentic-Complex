import { useEffect, useRef, useState } from 'react';
import { secToMs, type WireTurn } from '../../domain';
import type { Failed } from './actions';
import type { Quote } from './Composer';
import type { QuoteFrom } from './MessageList';
import type { LiveReply } from './useChatFeed';

/** What the page keeps for its input: the failed line, the receipt notice, the quote, and the text and files put into the input of one topic (the input reports them used). */
export function useSendState(q: URLSearchParams, demo: string | null, conv: string | null, character: string | null, wire: WireTurn[], replies: LiveReply[]) {
  const [failed, setFailed] = useState<Failed | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState<{ text: string; topic: string | null } | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [dropped, setDropped] = useState<{ files: File[]; topic: string | null } | null>(null);
  const seeded = useRef(false);
  useEffect(() => {
    setFailed(null);
    seeded.current = false;
  }, [q, demo]);
  // The sendfail demo starts with a failed line in the topic that opens.
  useEffect(() => {
    if (demo !== 'sendfail' || conv == null || seeded.current) return;
    seeded.current = true;
    setFailed({ text: 'HostLink 断线那次提交，能把 diff 发我看看吗？', reason: '后台服务无响应', conv, character });
  }, [q, demo, conv]);
  // The notice, the quote and what was put into the input belong to the conversation they were made in; null → id is the first line opening one.
  const shownConv = useRef(conv);
  useEffect(() => {
    if (shownConv.current != null && shownConv.current !== conv) {
      setNotice(null);
      setQuote(null);
      setDraft(null);
      setDropped(null);
    }
    shownConv.current = conv;
  }, [conv]);
  /** 引用回复 on a line in the stream: it goes by its turn, so a line with none cannot be quoted. */
  const quoteLine = (text: string, from: QuoteFrom) => {
    const turn_id = from.kind === 'ai' ? from.turn_id : wire.find((t) => (t.source === 'text' || t.source === 'voice') && t.user_text === text && secToMs(t.started_at) === from.at)?.turn_id;
    if (turn_id) setQuote({ text, turn_id, part: from.kind === 'ai' ? 'reply' : 'user' });
  };
  /** The same on the live tail: a reply's line_id is its turn_id once agentd answered the send. */
  const quoteLive = (text: string) => {
    const r = replies.find((x) => x.said === text || (x.text || x.items) === text);
    if (r && !r.line_id.startsWith('local-')) setQuote({ text, turn_id: r.line_id, part: r.said === text ? 'user' : 'reply' });
  };
  return { failed, setFailed, notice, setNotice, sending, setSending, draft, setDraft, quote, setQuote, dropped, setDropped, quoteLine, quoteLive };
}
