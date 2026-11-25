// 导入 MMD 的确认单：mmd.scan 认出的身体动作、口型、镜头、音源，用户挑好后 mmd.importScan。
import { useId, useState } from 'react';
import type { MmdImportPlan, MmdScan } from '../../bridge';
import { Btn, Dialog, Fold, IconBtn, Select } from '../../ui';
import { MicroLabel } from '../../ui/game';
import { MMD_IGNORED_REASON } from '../character/labels';
import modal from '../../ui/Modal.module.css';
import styles from './ImportDialog.module.css';

/** motion_tool's longest motion. */
export const MAX_SECONDS = 360;
const NONE = 'none';

/** motion_tool's title rule: 1–64 characters once trimmed. */
const titleOk = (t: string) => {
  const n = [...t.trim()].length;
  return n >= 1 && n <= 64;
};

/** The task card's title separator ` · `: it is part of the stored title, not page copy, so check-copy's ` │ ` rule does not apply. */
const PART = ` ${String.fromCodePoint(0xb7)} `;

/** Each dance's title: the song's, and the body's label after it when the project has more than one. */
export const itemTitle = (song: string, scan: MmdScan, body: number) => (scan.bodies.length === 1 ? song.trim() : `${song.trim()}${PART}${scan.bodies[body]!.label}`);

/** The offset field: empty is none, else a finite number of seconds; undefined when it does not read. */
const offsetOf = (text: string): number | null | undefined => {
  if (text.trim() === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
};

const index = (v: string) => (v === NONE ? null : Number(v));
const choice = (i: number | null) => (i === null ? NONE : String(i));

export interface ImportDialogProps {
  token: string;
  scan: MmdScan;
  onImport: (plan: MmdImportPlan) => void;
  onCancel: () => void;
  /** Adds music from anywhere to `scan.audio`; the index of it there, null when none was added. */
  onPickAudio: () => Promise<number | null>;
}

export function ImportDialog({ token, scan, onImport, onCancel, onPickAudio }: ImportDialogProps) {
  const s = scan.suggested;
  const tooLong = (i: number) => scan.bodies[i]!.durationS > MAX_SECONDS;
  const [song, setSong] = useState(scan.title);
  const [picked, setPicked] = useState<number[]>(tooLong(s.body) ? [] : [s.body]);
  const [face, setFace] = useState(choice(s.face));
  const [camera, setCamera] = useState(choice(s.camera));
  const [audio, setAudio] = useState(choice(s.audio));
  const [offset, setOffset] = useState(s.bgmStartS === null ? '' : String(s.bgmStartS));
  const longId = useId();

  const bgmStartS = offsetOf(offset);
  const items = picked.map((body) => ({ body, title: itemTitle(song, scan, body) }));
  const why =
    picked.length === 0
      ? '至少勾一条身体动作'
      : !titleOk(song) || !items.every((i) => titleOk(i.title))
        ? '名字要 1–64 个字'
        : audio !== NONE && bgmStartS === undefined
          ? '音乐偏移要是秒数'
          : null;
  const submit = () => {
    if (why != null) return;
    onImport({ token, items, face: index(face), camera: index(camera), audio: index(audio), bgmStartS: audio === NONE ? null : (bgmStartS ?? null), project: song.trim() });
  };
  const toggle = (i: number, on: boolean) => setPicked((p) => (on ? [...p, i].sort((a, b) => a - b) : p.filter((x) => x !== i)));
  const pickAudio = () => void onPickAudio().then((i) => i !== null && setAudio(String(i)));
  const options = (list: Array<{ name: string }>) => [{ value: NONE, label: '无' }, ...list.map((f, i) => ({ value: String(i), label: f.name }))];

  return (
    <Dialog
      open
      title="导入 MMD"
      onClose={onCancel}
      keepOnScrim
      footer={
        <>
          <Btn variant="secondary" onClick={onCancel}>
            取消
          </Btn>
          <Btn variant="primary" disabled={why != null} disabledReason={why ?? ''} onClick={submit}>
            导入
          </Btn>
        </>
      }
    >
      <div className={styles.form} data-mmd-import="">
        <label className={`${modal.field} ${styles.song}`}>
          曲名
          <input className={modal.input} value={song} autoComplete="off" spellCheck={false} onChange={(e) => setSong(e.currentTarget.value)} />
        </label>
        <fieldset className={styles.group}>
          <legend className={styles.head}>
            身体动作 <MicroLabel>BODY</MicroLabel>
          </legend>
          <ul className={styles.bodies} aria-label="身体动作">
            {scan.bodies.map((b, i) => {
              const long = tooLong(i);
              return (
                <li key={b.path} className={styles.body} data-mmd-body={i} data-tone={long ? 'danger' : undefined}>
                  <label className={styles.pick} title={long ? `动作超过 ${MAX_SECONDS} 秒` : undefined}>
                    <input
                      type="checkbox"
                      className={styles.box}
                      checked={picked.includes(i)}
                      disabled={long}
                      aria-describedby={long ? longId : undefined}
                      onChange={(e) => toggle(i, e.currentTarget.checked)}
                    />
                    <span className={styles.label}>{b.label}</span>
                    <span className={styles.model}>{b.model}</span>
                    <span className={styles.dur}>{`${b.durationS.toFixed(1)} s`}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          <span id={longId} hidden>{`动作超过 ${MAX_SECONDS} 秒`}</span>
        </fieldset>
        <div className={styles.media}>
          <Select label="口型" prefix="口型" value={face} options={options(scan.faces)} onChange={setFace} />
          <Select label="镜头" prefix="镜头" value={camera} options={options(scan.cameras)} onChange={setCamera} />
          <div className={styles.audio}>
            <Select label="音源" prefix="音源" value={audio} options={options(scan.audio)} onChange={setAudio} />
            <IconBtn icon="folder" label="选择其它音频" size="sm" onClick={pickAudio} />
          </div>
          <label className={styles.offset}>
            音乐偏移
            <input
              className={modal.input}
              inputMode="decimal"
              aria-label="音乐偏移"
              value={offset}
              disabled={audio === NONE}
              aria-invalid={audio !== NONE && bgmStartS === undefined}
              onChange={(e) => setOffset(e.currentTarget.value)}
            />
            秒
          </label>
        </div>
        {scan.ignored.length > 0 && (
          <Fold label="未使用的文件" count={scan.ignored.length}>
            <ul className={styles.ignored} aria-label="未使用的文件">
              {scan.ignored.map((f) => (
                <li key={f.name}>
                  <span className={styles.file}>{f.name}</span>
                  <span className={styles.reason}>{MMD_IGNORED_REASON[f.reason] ?? f.reason}</span>
                </li>
              ))}
            </ul>
          </Fold>
        )}
      </div>
    </Dialog>
  );
}
