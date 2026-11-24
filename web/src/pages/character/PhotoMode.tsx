// 拍照：复刻游戏拍照面板（SnapshotCtrl.lua）。光圈、对焦经 avatar.photo.set 下发。
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getBridge, type PhotoState } from '../../bridge';
import { Slider } from '../../ui';
import { GameSeg, MicroLabel } from '../../ui/game';
import { SecHead } from './SettingRows';
import styles from './PhotoMode.module.css';
import shutter from './PhotoShutter.module.css';

/** The game's camera on opening: f/32 and focus on the character. */
const OPEN: PhotoState = { active: true, aperture: 32, focus: 'auto' };
/** Manual focus starts at the far end of 0.1–10 m. */
const FOCUS_FAR = 10;

/** `f/%.0f`, or `f/%.1f` when the tenths are not zero. */
export const fNumber = (f: number) => `f/${f.toFixed(Math.round(f * 10) % 10 === 0 ? 0 : 1)}`;

const codeOf = (e: unknown) => (e as { code?: string } | null)?.code;

export interface PhotoModeProps {
  /** The shell has an avatar host: while the panel is open she walks clear of the main window. */
  avatar: boolean;
  offline: boolean;
}

/** 拍照列：相机（光圈、对焦，只作用在桌面），右下圆形快门和上次结果；左边的舞台不动。 */
export function PhotoMode(p: PhotoModeProps) {
  const details = useQuery({ queryKey: ['character', 'avatarDetails'], queryFn: () => getBridge().avatar.details(), enabled: p.avatar });
  const photo = details.data?.photo === true;
  const canCapture = details.data?.capture === true;
  const [aperture, setAperture] = useState(OPEN.aperture);
  const [focus, setFocus] = useState(OPEN.focus);
  const [shot, setShot] = useState<{ busy: boolean; text: string | null }>({ busy: false, text: null });
  const photoOn = useRef(false);

  useEffect(() => {
    if (!p.avatar) return;
    void getBridge().avatar.keepClearOfMain(true).catch(() => {});
    return () => {
      if (photoOn.current) {
        photoOn.current = false;
        void getBridge().avatar.photo.set({ ...OPEN, active: false }).catch(() => {});
      }
      void getBridge().avatar.keepClearOfMain(false).catch(() => {});
    };
  }, [p.avatar]);

  // A stopped avatar loses the photo state; it opens again on f/32 when she is back.
  useEffect(() => {
    if (p.offline) photoOn.current = false;
    if (!photo || p.offline || photoOn.current) return;
    photoOn.current = true;
    setAperture(OPEN.aperture);
    setFocus(OPEN.focus);
    void getBridge().avatar.photo.set(OPEN).catch(() => {});
  }, [photo, p.offline]);

  const send = (next: Partial<PhotoState>) => {
    if (next.aperture !== undefined) setAperture(next.aperture);
    if (next.focus !== undefined) setFocus(next.focus);
    void getBridge().avatar.photo.set({ active: true, aperture, focus, ...next }).catch(() => {});
  };

  const off = p.offline || !canCapture;
  const camOff = !photo || p.offline;
  const take = () => {
    if (off || shot.busy) return;
    setShot({ busy: true, text: null });
    getBridge()
      .avatar.capture({ background: 'transparent' })
      .then(
        (r) => setShot({ busy: false, text: `已保存 ${r.file}` }),
        (e: unknown) => setShot({ busy: false, text: `没有拍成：${codeOf(e) === 'not_implemented' ? '这个版本还不支持' : '桌面角色没有回应'}` }),
      );
  };

  return (
    <section className={styles.photo} data-g="detail" data-switch="panel" aria-label="拍照">
      <section className={styles.part} aria-label="相机">
        <SecHead title="相机" en="Camera" desktopOnly />
        {!photo && (
          <div className={styles.note} role="status">
            景深还没有接上：渲染器支持拍照景深后，光圈和对焦才可以调
          </div>
        )}
        <div className={styles.cam} data-theme="dark" data-off={camOff || undefined}>
          <span className={styles.lead} aria-hidden="true">
            <i />
          </span>
          <div className={styles.body}>
            <div className={styles.hd}>
              <span className={styles.t}>光圈</span>
              <b className={styles.ro} data-readout="aperture">
                {fNumber(aperture)}
              </b>
            </div>
            <Slider label="光圈" min={1.4} max={32} step={0.1} value={aperture} defaultValue={OPEN.aperture} disabled={camOff} onChange={(v) => send({ aperture: v })} />
          </div>
        </div>
        <div className={styles.cam} data-theme="dark" data-off={camOff || undefined}>
          <span className={styles.lead} aria-hidden="true">
            <i />
          </span>
          <div className={styles.body}>
            <div className={styles.hd}>
              <span className={styles.t}>对焦</span>
              <GameSeg
                variant="setting"
                size="compact"
                label="对焦"
                value={focus === 'auto' ? 'auto' : 'manual'}
                options={[
                  { value: 'auto', label: '自动' },
                  { value: 'manual', label: '手动' },
                ]}
                disabled={camOff}
                onChange={(v) => (v === 'auto' ? send({ focus: 'auto' }) : focus === 'auto' && send({ focus: FOCUS_FAR }))}
              />
              {focus !== 'auto' && (
                <b className={styles.ro} data-readout="focus">
                  {focus.toFixed(1)}
                  <small>m</small>
                </b>
              )}
            </div>
            {focus !== 'auto' && (
              <Slider label="对焦距离" min={0.1} max={FOCUS_FAR} step={0.1} value={focus} defaultValue={FOCUS_FAR} unit="m" disabled={camOff} onChange={(v) => send({ focus: v })} />
            )}
          </div>
        </div>
      </section>
      <div className={shutter.shutter}>
        <div className={shutter.msg}>
          <MicroLabel>Transparent Capture</MicroLabel>
          <b>拍下桌面上的角色，透明背景</b>
          <span role="status">{shot.text ?? (p.offline ? '角色未运行' : !canCapture ? '渲染器没有提供截图' : '')}</span>
        </div>
        <button
          type="button"
          className={shutter.shut}
          aria-label="拍照"
          aria-disabled={off || undefined}
          aria-busy={shot.busy || undefined}
          title={off ? (p.offline ? '角色未运行' : '渲染器没有提供截图') : undefined}
          onClick={take}
        >
          <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false">
            <path fill="currentColor" d="M8.5 3h7l1.8 3H22v15H2V6h4.7zM12 8.5a4.8 4.8 0 1 0 0 9.6 4.8 4.8 0 0 0 0-9.6zm0 2.3a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z" />
          </svg>
          <span className={shutter.lbl} aria-hidden="true">
            拍照
          </span>
        </button>
      </div>
    </section>
  );
}
