import { useState } from 'react';
import type { DesktopState } from '../../../bridge';
import { stackQuery } from '../../stack/demos';
import { inputPreset } from '../cmd/input/demo';
import { QuickInput } from '../cmd/input/QuickInput';
import type { Attachment } from '../cmd/input/selection';
import type { OpenInput } from './useQuickInput';
import styles from './Bubble.module.css';

export interface BubbleInputProps {
  open: OpenInput;
  state: DesktopState | null;
  attachment: Attachment | null;
  onDrop: () => void;
  onClose: (sent: boolean) => void;
}

/** 快速输入 under the bubble's text; each open starts from its prefill or the draft esc kept. */
export function BubbleInput({ open, state, attachment, onDrop, onClose }: BubbleInputProps) {
  const [q] = useState(stackQuery);
  const preset = window.agenticComplex ? undefined : inputPreset(q.get('demo'));
  return (
    <div className={styles.input} data-slot="input">
      {open.quote && <p className={styles.quote}>引用：{open.quote}</p>}
      <QuickInput
        key={open.n}
        role={state?.character?.name ?? '角色'}
        prefill={open.prefill}
        talkKey={state?.pips.voice === 'on' ? state.hotkeys.hk_ptt : undefined}
        autoFocus={q.get('still') !== '1'}
        look={state?.plugins.includes('screen_reading') ?? false}
        initial={open.n === 1 ? preset : undefined}
        attachment={attachment}
        surface={open.quote ? 'bubble_reply' : 'quick_input'}
        replyTo={open.replyTo}
        onDrop={onDrop}
        onClose={onClose}
      />
    </div>
  );
}
