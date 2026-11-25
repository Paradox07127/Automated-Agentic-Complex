// 换音源：给一支舞换一个音频或去掉音源，带音乐偏移；mmd.setMedia 在选择音频时打开文件面板。
import { useState } from 'react';
import type { MmdEntry } from '../../bridge';
import { Btn, Dialog, Seg } from '../../ui';
import modal from '../../ui/Modal.module.css';
import styles from './ImportDialog.module.css';

export interface MediaDialogProps {
  entry: MmdEntry;
  onSave: (media: { bgm: 'pick' | 'none'; bgmStartS: number | null }) => void;
  onCancel: () => void;
}

export function MediaDialog({ entry, onSave, onCancel }: MediaDialogProps) {
  const [bgm, setBgm] = useState<'pick' | 'none'>('pick');
  const [offset, setOffset] = useState('');
  const n = offset.trim() === '' ? null : Number(offset);
  const bad = bgm === 'pick' && n !== null && !Number.isFinite(n);
  return (
    <Dialog
      open
      title="换音源"
      onClose={onCancel}
      footer={
        <>
          <Btn variant="secondary" onClick={onCancel}>
            取消
          </Btn>
          <Btn variant="primary" disabled={bad} disabledReason="音乐偏移要是秒数" onClick={() => onSave({ bgm, bgmStartS: bgm === 'pick' ? n : null })}>
            {bgm === 'pick' ? '选择音频' : '去掉音源'}
          </Btn>
        </>
      }
    >
      <div className={styles.form} data-mmd-media={entry.id}>
        <Seg
          label="音源"
          value={bgm}
          options={[
            { value: 'pick', label: '换一个音频' },
            { value: 'none', label: '不要音源', disabled: !entry.hasBgm, disabledReason: '这支舞没有音源' },
          ]}
          onChange={(v) => setBgm(v as 'pick' | 'none')}
        />
        <label className={styles.offset}>
          音乐偏移
          <input className={modal.input} inputMode="decimal" aria-label="音乐偏移" value={offset} placeholder="0" disabled={bgm === 'none'} aria-invalid={bad}
            onChange={(e) => setOffset(e.currentTarget.value)} />
          秒
        </label>
      </div>
    </Dialog>
  );
}
