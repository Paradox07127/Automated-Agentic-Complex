import { formatClock } from '../../domain';
import { isoToMsOrNull } from '../../domain/units';
import { navigate } from '../../shell/nav';
import { Btn, KV } from '../../ui';
import type { WireDiagState } from '../../domain/wire';
import { stateWord } from '../../features/character/labels';
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
  idle: '静止待机',
  observe: '观察周围',
  short_walk: '短距移动',
  sit: '坐姿',
  hold_window_edge: '倚靠窗口边缘',
  climb_window_top: '停靠窗口顶部',
};

/** behavior.py CATEGORY_NAMES; proactive.focus.category is the wire identifier. */
const CATEGORY: Readonly<Record<string, string>> = {
  coding: '编程', terminal: '终端', browsing: '浏览网页', assistant: '使用 AI 助手', files: '文件管理',
  reading: '阅读文档', writing: '文本编辑', media: '影音播放', meeting: '会议', game: '游戏',
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
    <div className={styles.rows}>
      <KV
        items={[
          {
            key: '语音与输出',
            value: `${mv.mouth === 'busy' ? '输出中' : '空闲'} │ ${mv.voice ? (VOICE[mv.voice] ?? mv.voice) : '未配置语音'}${mv.muted ? ' │ 已静音' : ''}${mv.avatar_visible ? '' : ' │ 角色已隐藏'}`,
          },
          ...(mv.speech_failed
            ? [
                {
                  key: '上次输出失败',
                  value: (
                    <>
                      {speechFailed(mv.speech_failed)}{' '}
                      <Btn size="sm" variant="text" go onClick={() => navigate({ page: 'settings', group: 'speak', item: 'tts' })}>
                        前往设置
                      </Btn>
                    </>
                  ),
                },
              ]
            : []),
          { key: '状态与动作', value: [d.body.activity && (BEHAVIOR[d.body.activity] ?? '其他动作'), mood, running && `执行中：${running}`].filter(Boolean).join(' │ ') || null },
          {
            key: '主动判断',
            value: [
              p.focus ? `当前焦点：${CATEGORY[p.focus.category] ?? '其他'}` : '无当前焦点',
              next != null ? `下次 ${formatClock(next, { seconds: true })}` : null,
              p.last_judge ? `上次 ${JUDGE_BACKEND[p.last_judge.backend] ?? '其他后端'}` : null,
              p.misses ? `未命中 ${p.misses} 次` : null,
            ]
              .filter(Boolean)
              .join(' │ '),
          },
          {
            key: '会话',
            value: sessions.length ? `${sessions.length} 个${stale ? ` │ 已过期 ${stale}` : ''}` : '无',
          },
          { key: '仪式', value: `待触发 ${d.rituals.pending.length} │ 今日已触发 ${d.rituals.today.length}` },
        ]}
      />
    </div>
  );
}
