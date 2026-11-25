// 换音源：给一支舞换一个音频或去掉音源，带音乐偏移；mmd.setMedia 在选择音频时打开文件面板。
import { useState } from 'react';
import type { MmdEntry } from '../../bridge';
import { Btn, Dialog } from '../../ui';
import { GameSeg } from '../../ui/game';
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
      title="更换音频"
      onClose={onCancel}
      footer={
        <>
          <Btn variant="secondary" onClick={onCancel}>
            取消
          </Btn>
          <Btn variant="primary" disabled={bad} disabledReason="音乐偏移须为数字（秒）" onClick={() => onSave({ bgm, bgmStartS: bgm === 'pick' ? n : null })}>
            {bgm === 'pick' ? '选择音频' : '移除音频'}
          </Btn>
        </>
      }
    >
      <div className={styles.form} data-mmd-media={entry.id}>
        <GameSeg
          label="音频"
          value={bgm}
          options={[
            { value: 'pick', label: '选择新音频' },
            { value: 'none', label: '无音频', disabled: !entry.hasBgm, title: '该舞蹈未绑定音频' },
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
