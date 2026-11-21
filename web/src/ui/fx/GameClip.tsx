import { useRef, type ReactNode } from 'react';
import { gameClips, type GameClipId } from '../../design/gameClips.generated';
import { KeySample, WatchSample, WheelSample } from './samples';
import { useGameClip } from './useGameClip';

/**
 * 播放一段游戏动画（gameClips.generated.ts，由本机工具 `gen_web_clips.py` 生成）：
 * 驱动内部 `data-g` 对应的元素。mount 挂载时播一次（入场），hover 指针或焦点进来正放、离开倒放。
 */
export interface GameClipProps {
  /** 动画 id，例如 watchIn、quickmenuIn、keyboardBtnHover */
  clip: GameClipId;
  /** 什么时候播，默认 mount */
  trigger?: 'mount' | 'hover';
  /** 带 data-g 的内容 */
  children: ReactNode;
}

export function GameClip({ clip, trigger = 'mount', children }: GameClipProps) {
  const ref = useRef<HTMLDivElement>(null);
  const c = useGameClip(gameClips[clip], ref, { autoplay: trigger === 'mount' });
  const hover = trigger === 'hover';
  const enter = hover ? () => void c.play() : undefined;
  const leave = hover ? () => void c.reverse() : undefined;
  return (
    <div ref={ref} data-stub="GameClip" data-clip={clip} onPointerEnter={enter} onPointerLeave={leave} onFocus={enter} onBlur={leave}>
      {children}
    </div>
  );
}

export const GameClipDemos: Array<{ name: string; props: GameClipProps }> = [
  { name: 'watch-in', props: { clip: 'watchIn', children: <WatchSample /> } },
  { name: 'quickmenu-in', props: { clip: 'quickmenuIn', children: <WheelSample /> } },
  { name: 'key-hover', props: { clip: 'keyboardBtnHover', trigger: 'hover', children: <KeySample /> } },
];
