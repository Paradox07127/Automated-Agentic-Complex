import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getBridge } from '../../bridge';
import type { PhotoOverlayState, PhotoSettings } from '../../bridge/photo';
import { Btn, Slider } from '../../ui';
import { GameSeg, MicroLabel } from '../../ui/game';
import { useRegions } from './hooks/useRegions';
import styles from './PhotoRoot.module.css';

/** The game's camera on opening (SnapshotCtrl.lua): f/32 and focus on the character; native opens on it too. */
const OPEN: PhotoSettings = { aperture: 32, focus: 'auto' };
/** Manual focus starts at the far end of 0.1–10 m. */
const FOCUS_FAR = 10;
/** The bar's distance from her figure, as 调整镜头's. */
const BAR_GAP = 12;

/** `f/%.0f`, or `f/%.1f` when the tenths are not zero. */
export const fNumber = (f: number) => `f/${f.toFixed(Math.round(f * 10) % 10 === 0 ? 0 : 1)}`;

const codeOf = (e: unknown) => (e as { code?: string } | null)?.code;

/** As CameraRoot's: centred under her, above her when that leaves the page, kept inside the page. */
function barPosition(anchor: PhotoOverlayState['anchor'], w: number, h: number) {
  let top = anchor.y + anchor.height + BAR_GAP;
  if (top + h > window.innerHeight) top = anchor.y - BAR_GAP - h;
  return {
    left: Math.min(Math.max(anchor.x + anchor.width / 2 - w / 2, 0), window.innerWidth - w),
    top: Math.min(Math.max(top, 0), window.innerHeight - h),
  };
}

/** `stack.html#/photo`: 拍照, the game's photo panel in one dark bar under her: aperture and focus (desktop only), the round
 *  shutter and the last result. Native covers her screen with the page and holds her photo state while it is open; Esc,
 *  关闭 and a press outside the bar close it. */
export function PhotoRoot() {
  const ref = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLElement>(null);
  const [state, setState] = useState<PhotoOverlayState | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [aperture, setAperture] = useState(OPEN.aperture);
  const [focus, setFocus] = useState(OPEN.focus);
  const [shot, setShot] = useState<{ busy: boolean; text: string | null }>({ busy: false, text: null });
  // Each opening pushes a state and starts on f/32 again.
  useEffect(
    () =>
      getBridge().photo.onState((s) => {
        setState(s);
        setAperture(OPEN.aperture);
        setFocus(OPEN.focus);
        setShot({ busy: false, text: null });
      }),
    [],
  );
  // The shell takes Esc itself once the panel has the keyboard; this covers the page when the key reaches it.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      void getBridge().photo.close();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  useRegions(ref);
  useLayoutEffect(() => {
    const el = bar.current;
    if (el && (el.offsetWidth !== size.w || el.offsetHeight !== size.h)) setSize({ w: el.offsetWidth, h: el.offsetHeight });
  });

  if (!state) return <div ref={ref} className={styles.root} />;
  const send = (next: Partial<PhotoSettings>) => {
    if (next.aperture !== undefined) setAperture(next.aperture);
    if (next.focus !== undefined) setFocus(next.focus);
    void getBridge().photo.set({ aperture, focus, ...next }).catch(() => {});
  };
  const camOff = !state.photo;
  const off = !state.capture;
  const take = () => {
    if (off || shot.busy) return;
    setShot({ busy: true, text: null });
    getBridge()
      .photo.capture()
      .then(
        (r) => setShot({ busy: false, text: `已保存至 ${r.file}` }),
        (e: unknown) => setShot({ busy: false, text: `拍摄失败：${codeOf(e) === 'not_implemented' ? '当前版本暂不支持' : '角色渲染进程无响应'}` }),
      );
  };

  return (
    <div ref={ref} className={styles.root} data-theme="dark">
      <section ref={bar} className={styles.bar} data-region aria-label="拍照" style={barPosition(state.anchor, size.w, size.h)}>
        <div className={styles.part} aria-label="相机" role="group">
          {!state.photo && (
            <div className={styles.note} role="status">
              景深能力尚未就绪：角色渲染器支持拍照景深后即可调节光圈与对焦
            </div>
          )}
          <div className={styles.cam} data-off={camOff || undefined}>
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
          <div className={styles.cam} data-off={camOff || undefined}>
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
        </div>
        <div className={styles.shutter}>
          <div className={styles.msg}>
            <MicroLabel>Transparent Capture</MicroLabel>
            <b>拍摄桌面角色图像（透明背景）</b>
            <span role="status">{shot.text ?? (off ? '当前渲染器未提供截图能力' : '')}</span>
          </div>
          <button
            type="button"
            className={styles.shut}
            aria-label="拍照"
            aria-disabled={off || undefined}
            aria-busy={shot.busy || undefined}
            title={off ? '当前渲染器未提供截图能力' : undefined}
            onClick={take}
          >
            <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false">
              <path fill="currentColor" d="M8.5 3h7l1.8 3H22v15H2V6h4.7zM12 8.5a4.8 4.8 0 1 0 0 9.6 4.8 4.8 0 0 0 0-9.6zm0 2.3a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z" />
            </svg>
            <span className={styles.lbl} aria-hidden="true">
              拍照
            </span>
          </button>
        </div>
        <Btn size="sm" variant="secondary" kbd="esc" onClick={() => void getBridge().photo.close()}>
          关闭
        </Btn>
      </section>
    </div>
  );
}
