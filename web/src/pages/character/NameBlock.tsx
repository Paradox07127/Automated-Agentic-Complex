import { useEffect, useState, type ReactNode } from 'react';
import { readVoiceBinding } from '../../bridge/agentd';
import { Barcode, Diamond, WhiteCapsule } from '../../ui/game';
import { Emblem } from './Figure';
import { SWITCH_STAGE_LABELS, SWITCH_STAGES } from './tables';
import type { SwitchState } from './useSwitch';
import styles from './NameBlock.module.css';
import rows from './StateRows.module.css';

export interface VoiceBinding {
  voiceId: string;
  /** Language code as agentd sends it (`zh`). */
  language: string;
}

/** `character`'s voice from agentd's binding, read once per character while `on`; null without one or when the read fails, which the next `on` reads again. */
export function useVoiceBinding(character: string, on: boolean): VoiceBinding | null {
  const [read, setRead] = useState<{ character: string; voice: VoiceBinding | null }>();
  const have = read?.character === character;
  useEffect(() => {
    if (!on || !character || have) return;
    let live = true;
    readVoiceBinding(character).then(
      (voice) => live && setRead({ character, voice }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [character, on, have]);
  return have ? read.voice : null;
}

/** The desktop monitor on the 在桌面 marks. */
export function DeskGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true" focusable="false">
      <path d="M3 4h18v12H3zM8 21h8M12 16v5" />
    </svg>
  );
}

export interface NameBlockProps {
  name: string;
  en?: string | undefined;
  /** She is the one on the desktop. */
  active?: boolean | undefined;
  voice?: VoiceBinding | null | undefined;
  /** What she is doing in words; hidden while she is not running. */
  activity: string | null;
  offline: boolean;
}

/** A name wider than about three CJK characters takes the smaller size, as the game's auto-size does. */
const isLong = (name: string) => [...name].reduce((w, c) => w + (/[㐀-鿿]/.test(c) ? 1 : 0.55), 0) > 3.2;

/** 名字块（游戏 CharInfo 名字栏）：白方徽记、白色大名字、「在桌面」蓝标和拉丁名；下面是语音绑定和「在做」标签板。 */
export function NameBlock(p: NameBlockProps) {
  return (
    <div className={styles.block} data-nameplate="" data-g="root" data-long={isLong(p.name) || undefined}>
      <span className={styles.band} aria-hidden="true" />
      <div className={styles.plate} data-g="nameplate">
        <span className={styles.emb} aria-hidden="true">
          <span className={styles.frame} />
          <span className={styles.shadow} />
          <span className={styles.box} />
          <Emblem className={styles.mark} />
          <span className={styles.tick}>
            <Diamond tone="yellow" size={8} />
          </span>
        </span>
        <span className={styles.names}>
          <b className={styles.name}>{p.name}</b>
          {(p.active || p.en) && (
            <span className={styles.row}>
              {p.active && (
                <span className={styles.desk} title="桌面上的是这个角色">
                  <DeskGlyph />
                  在桌面
                </span>
              )}
              {p.active && p.en && <i className={styles.rule} aria-hidden="true" />}
              {p.en && <span className={styles.en}>{p.en}</span>}
            </span>
          )}
        </span>
      </div>
      {p.voice && (
        <div className={styles.voice} title="语音绑定">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true" focusable="false">
            <path d="M9 3h6v10H9zM5 11c0 4 3 7 7 7s7-3 7-7M12 18v3" />
          </svg>
          <span className={styles.vid}>{p.voice.voiceId}</span>
          <span className={styles.lang}>{p.voice.language.toUpperCase()}</span>
        </div>
      )}
      {!p.offline && p.activity && (
        <div className={styles.tags} data-g="tags">
          <span className={styles.tag}>
            <span className={styles.tagK}>在做</span>
            {p.activity}
          </span>
        </div>
      )}
    </div>
  );
}

/** 深色状态行：左格橙边和警示图标，右端条码；名字块下，只在出错或切换时出现。 */
function StateRow({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className={rows.srow}>
      <span className={rows.lead} aria-hidden="true">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.2" focusable="false">
          <path d="M12 3l10 18H2zM12 10v5M12 17v2" />
        </svg>
      </span>
      <span className={rows.main}>
        <b className={rows.t}>{title}</b>
        {sub != null && <span className={rows.s}>{sub}</span>}
        {children}
      </span>
      <span className={rows.bc} aria-hidden="true">
        <Barcode width={34} height={12} label="AGENTIC" />
      </span>
    </div>
  );
}

/** 角色未运行：退避秒数和「重启角色」。 */
export function OfflineRow({ backoff, onRestart }: { backoff: number | null; onRestart: () => void }) {
  return (
    <div className={rows.state} role="status">
      <StateRow title="角色未运行" {...(backoff != null ? { sub: `退避 ${backoff} 秒后重试` } : {})} />
      <div className={rows.acts}>
        <WhiteCapsule label="重启角色" icon="refresh" tone="accent" onClick={onRestart} />
      </div>
    </div>
  );
}

/** 切换中：「正在切换到 X · 输入暂停」；失败：原因、停在哪一格（卸载 / 加载资源 / 待机就绪）、重试和关闭。 */
export function SwitchRow({ sw, currentName, onRetry, onDismiss }: { sw: Exclude<SwitchState, { phase: 'idle' }>; currentName: string; onRetry: () => void; onDismiss: () => void }) {
  if (sw.phase === 'running')
    return (
      <div className={rows.state} role="status">
        <StateRow title={`正在切换到 ${sw.target.name}`} sub="输入暂停" />
      </div>
    );
  const at = sw.stage;
  return (
    <div className={rows.state} role="alert">
      <StateRow title={`切换到 ${sw.target.name} 没有完成`} sub={`仍是 ${currentName} │ ■ ${sw.reason}`}>
        {at != null && (
          <span className={rows.chain}>
            {SWITCH_STAGES.map((stage, i) => (
              <span key={stage} className={rows.node} data-state={i === at ? 'broken' : i < at ? 'done' : 'unreachable'}>
                <Diamond tone={i === at ? 'orange' : i < at ? 'white' : 'hollow'} size={8} />
                {SWITCH_STAGE_LABELS[stage]}
                {i <= at && <span className={rows.vh}>{i === at ? '，停在这里' : '，完成'}</span>}
              </span>
            ))}
          </span>
        )}
      </StateRow>
      <div className={rows.acts}>
        <WhiteCapsule label="重试" icon="refresh" tone="accent" onClick={onRetry} />
        <WhiteCapsule label="关闭" icon="close" onClick={onDismiss} />
      </div>
    </div>
  );
}
