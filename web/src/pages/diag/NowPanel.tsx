import { formatClock } from '../../domain';
import { isoToMsOrNull } from '../../domain/units';
import { KV } from '../../ui';
import type { WireDiagState } from '../../domain/wire';
import { stateWord } from '../character/labels';
import { BEHAVIOR, JUDGE_BACKEND } from './model';
import { ttsText } from './status';
import styles from './State.module.css';

/** server.py `_diag_voice` voice values. */
const VOICE: Readonly<Record<string, string>> = {
  idle: '空闲',
  synthesizing: '合成中',
  playing: '播放中',
  playing_estimated: '播放中（估计）',
  buffering: '缓冲中',
  interrupted: '被打断',
  unknown: '不确定',
};

/** spatial.py TICK_TYPES, the body behaviors /diag/state behavior.running lists. */
const SPATIAL: Readonly<Record<string, string>> = {
  idle: '待着',
  observe: '张望',
  short_walk: '走动',
  sit: '坐着',
  hold_window_edge: '扒着窗口边',
  climb_window_top: '爬上窗口顶',
};

/** behavior.py CATEGORY_NAMES; proactive.focus.category is the wire identifier. */
const CATEGORY: Readonly<Record<string, string>> = {
  coding: '写代码', terminal: '终端', browsing: '浏览网页', assistant: '用 AI 助手', files: '整理文件',
  reading: '看文档', writing: '写东西', media: '听音乐或看视频', meeting: '开会', game: '玩游戏',
  other: '其他', canvas: '使用画布', remote_desktop: '使用远程桌面',
};

export interface NowPanelProps {
  d: WireDiagState;
}

function speechFailed(f: NonNullable<WireDiagState['mouth_voice']['speech_failed']>): string {
  const at = isoToMsOrNull(f.at);
  return `${at != null ? `${formatClock(at, { seconds: true })}，` : ''}语音合成失败${f.reason ? `：${ttsText(f.reason)}` : ''}`;
}

/** 嘴和声音、身体、主动判断、会话和仪式 from their /diag/state blocks, one line each. */
export function NowPanel({ d }: NowPanelProps) {
  const mv = d.mouth_voice;
  const p = d.proactive;
  const next = isoToMsOrNull(p.next_judge_at);
  const sessions = d.sessions.sessions;
  const stale = sessions.filter((s) => s.stale).length;
  const running = d.behavior.running.map((r) => SPATIAL[r.type] ?? '其他动作').join('、');
  const labels = d.character_state.labels;
  const mood = (labels?.mood && stateWord('mood', labels.mood)) || d.body.mood;
  return (
    <div className={styles.obs}>
      <span className={styles.panelHead}>现在</span>
      <KV
        items={[
          {
            key: '嘴和声音',
            value: `${mv.mouth === 'busy' ? '在说' : '闲着'} │ ${mv.voice ? (VOICE[mv.voice] ?? mv.voice) : '没有语音'}${mv.muted ? ' │ 已静音' : ''}${mv.avatar_visible ? '' : ' │ 角色隐藏'}`,
          },
          ...(mv.speech_failed ? [{ key: '上次没说出口', value: speechFailed(mv.speech_failed) }] : []),
          { key: '身体', value: [d.body.activity && (BEHAVIOR[d.body.activity] ?? '其他动作'), mood, running && `在做 ${running}`].filter(Boolean).join(' │ ') || null },
          {
            key: '主动判断',
            value: [
              p.focus ? `关注 ${CATEGORY[p.focus.category] ?? '其他'}` : '没有关注',
              next != null ? `下次 ${formatClock(next, { seconds: true })}` : null,
              p.last_judge ? `上次 ${JUDGE_BACKEND[p.last_judge.backend] ?? '其他后端'}` : null,
              p.misses ? `落空 ${p.misses} 次` : null,
            ]
              .filter(Boolean)
              .join(' │ '),
          },
          {
            key: '会话',
            value: sessions.length ? `${sessions.length} 个${stale ? ` │ 过期 ${stale}` : ''}` : '没有',
          },
          { key: '仪式', value: `待说 ${d.rituals.pending.length} │ 今天说过 ${d.rituals.today.length}` },
        ]}
      />
    </div>
  );
}
