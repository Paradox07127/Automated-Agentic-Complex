import { useEffect, useState } from 'react';
import { AgentdCallError, call } from '../../../bridge/agentd';
import { failureText } from '../../../domain/errorText';
import { UNDO_S } from '../../stack/actions';

/** thoughts.py `CATEGORY`: the gate kind 关闭此类 mutes. */
const KIND = 'thought';

/** `undo`: the muted list before this mute, put back by 撤销 until the time runs out. */
export type Mute = { phase: 'busy' } | { phase: 'undo'; before: string[] } | { phase: 'failed'; text: string };

export function why(e: unknown): string {
  if (e instanceof AgentdCallError) return failureText(e).text;
  if (e && typeof e === 'object' && 'detail' in e && typeof e.detail === 'string' && e.detail) return e.detail;
  return e instanceof Error ? e.message : String(e);
}

const muted = () => call<{ muted: string[] }>('GET', '/proactive/mutes').then((r) => r.muted);
const putMuted = (list: string[]) => call<{ muted: string[] }>('PUT', '/proactive/mutes', { muted: list });

/** 关闭此类 on a thought, as the chat window's thought line does it: mutes kind `thought`, with 撤销 for a few seconds. */
export function useThoughtMute(id: string | null) {
  const [mute, setMute] = useState<Mute | null>(null);
  /** The thought hidden for good once its kind is muted; a later one shows again. */
  const [closed, setClosed] = useState<string | null>(null);

  const undoing = mute?.phase === 'undo';
  useEffect(() => {
    if (!undoing) return;
    const t = setTimeout(() => {
      setClosed(id);
      setMute(null);
    }, UNDO_S * 1000);
    return () => clearTimeout(t);
  }, [undoing, id]);

  const off = async () => {
    setMute({ phase: 'busy' });
    try {
      const before = await muted();
      await putMuted([...new Set([...before, KIND])].sort());
      setMute({ phase: 'undo', before });
    } catch (e) {
      setMute({ phase: 'failed', text: `没能关闭：${why(e)}` });
    }
  };

  const undo = async (before: string[]) => {
    try {
      await putMuted(before);
      setMute(null);
    } catch (e) {
      setMute({ phase: 'failed', text: `没能撤销：${why(e)}` });
    }
  };

  return { mute, closed: id != null && closed === id, off, undo };
}

export type ThoughtMute = ReturnType<typeof useThoughtMute>;
