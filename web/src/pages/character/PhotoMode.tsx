// 拍照：复刻游戏拍照面板（SnapshotCtrl.lua）。滤镜格只取 settings.schema 里 rnd.filter 的选项；光圈、对焦经 avatar.photo.set 下发。
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getBridge, type PhotoState } from '../../bridge';
import { ErrBar, Skel, Slider } from '../../ui';
import { GameSeg, MicroLabel } from '../../ui/game';
import type { Toast } from './feedback';
import { SecHead } from './SettingRows';
import { saveSettings, useCharSettings } from './settings';
import { readFail } from './Tune';
import styles from './PhotoMode.module.css';

const FILTER = 'rnd.filter';
/** The game's camera on opening: f/32 and focus on the character. */
const OPEN: PhotoState = { active: true, aperture: 32, focus: 'auto' };
/** Manual focus starts at the far end of 0.1–10 m. */
const FOCUS_FAR = 10;
const COLS = 4;
/** The game filters of which only the colour grade is copied. */
const GRADE_ONLY = new Set(['sp_filter_1', 'sp_filter_2', 'sp_filter_3']);

/** `f/%.0f`, or `f/%.1f` when the tenths are not zero. */
export const fNumber = (f: number) => `f/${f.toFixed(Math.round(f * 10) % 10 === 0 ? 0 : 1)}`;

/** The cell's number: SP·01 for the game's special filters, F·01 for the rest; none for 无. */
const code = (v: string) => {
  const m = /^(sp_)?filter_(\d+)$/.exec(v);
  return m ? `${m[1] ? 'SP' : 'F'}·${m[2]!.padStart(2, '0')}` : '';
};

const codeOf = (e: unknown) => (e as { code?: string } | null)?.code;

const NEXT: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -COLS, ArrowDown: COLS };

export interface PhotoModeProps {
  /** The shell has an avatar host: while the panel is open she walks clear of the main window. */
  avatar: boolean;
  offline: boolean;
  toast: Toast;
}

/** 拍照列：滤镜格和所选滤镜一行，相机（光圈、对焦，只作用在桌面），右下圆形快门和上次结果；左边的舞台不动。 */
export function PhotoMode(p: PhotoModeProps) {
  const { q, merge } = useCharSettings();
  const details = useQuery({ queryKey: ['character', 'avatarDetails'], queryFn: () => getBridge().avatar.details(), enabled: p.avatar });
  const photo = details.data?.photo === true;
  const canCapture = details.data?.capture === true;
  const [aperture, setAperture] = useState(OPEN.aperture);
  const [focus, setFocus] = useState(OPEN.focus);
  const [shot, setShot] = useState<{ busy: boolean; text: string | null }>({ busy: false, text: null });
  const photoOn = useRef(false);
  const cells = useRef<Array<HTMLButtonElement | null>>([]);

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

  useEffect(() => {
    if (!photo || photoOn.current) return;
    photoOn.current = true;
    void getBridge().avatar.photo.set(OPEN).catch(() => {});
  }, [photo]);

  const send = (next: Partial<PhotoState>) => {
    if (next.aperture !== undefined) setAperture(next.aperture);
    if (next.focus !== undefined) setFocus(next.focus);
    void getBridge().avatar.photo.set({ active: true, aperture, focus, ...next }).catch(() => {});
  };

  const off = p.offline || !canCapture;
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

  const n = q.data;
  const row = n?.rows[FILTER];
  const options = row?.options ?? [];
  const using = String(n?.saved[FILTER] ?? row?.default ?? 'none');
  const sel = options.find((o) => o.value === using) ?? options[0];
  const at = Math.max(0, options.findIndex((o) => o.value === using));
  const pick = (id: string) => {
    if (!n || id === using) return;
    void saveSettings({ [FILTER]: id }, { ok: '已换滤镜', fail: '没有换滤镜' }, n.rows, p.toast).then((ok) => ok && merge({ [FILTER]: id }));
  };
  const move = (e: KeyboardEvent, i: number) => {
    const d = NEXT[e.key];
    if (d === undefined) return;
    e.preventDefault();
    cells.current[Math.min(options.length - 1, Math.max(0, i + d))]?.focus();
  };

  let filters;
  if (q.isError) filters = <ErrBar message={`读取滤镜失败：${readFail(q.error)}`} onRetry={() => void q.refetch()} />;
  else if (!n) filters = <Skel rows={4} />;
  else
    filters = (
      <>
        <div className={styles.grid} role="radiogroup" aria-label="滤镜">
          {options.map((o, i) => (
            <button
              key={o.value}
              ref={(el) => {
                cells.current[i] = el;
              }}
              type="button"
              role="radio"
              className={styles.cell}
              aria-checked={o.value === using}
              aria-label={o.label}
              tabIndex={i === at ? 0 : -1}
              onKeyDown={(e) => move(e, i)}
              onClick={() => pick(o.value)}
            >
              <span className={styles.th} data-none={code(o.value) === '' || undefined} aria-hidden="true">
                {code(o.value)}
              </span>
              {o.value.startsWith('sp_') && <span className={styles.sp}>SP</span>}
              <span className={styles.name}>{o.label}</span>
              {o.value === using && <i className={styles.ck} aria-hidden="true" />}
            </button>
          ))}
        </div>
        {sel && (
          <div className={styles.info}>
            <b>{sel.label}</b>
            {GRADE_ONLY.has(sel.value) && <span>只复刻调色部分</span>}
            <span className={styles.infoEn}>
              <MicroLabel>{sel.value}</MicroLabel>
            </span>
          </div>
        )}
      </>
    );

  return (
    <section className={styles.photo} data-g="detail" aria-label="拍照">
      <section className={styles.part} aria-label="滤镜">
        <SecHead title="滤镜" en="Filter" />
        {filters}
      </section>
      <section className={styles.part} aria-label="相机">
        <SecHead title="相机" en="Camera" desktopOnly />
        {!photo && (
          <div className={styles.note} role="status">
            景深还没有接上：渲染器支持拍照景深后，光圈和对焦才可以调
          </div>
        )}
        <div className={styles.cam} data-theme="dark" data-off={!photo || undefined}>
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
            <Slider label="光圈" min={1.4} max={32} step={0.1} value={aperture} defaultValue={OPEN.aperture} disabled={!photo} onChange={(v) => send({ aperture: v })} />
          </div>
        </div>
        <div className={styles.cam} data-theme="dark" data-off={!photo || undefined}>
          <span className={styles.lead} aria-hidden="true">
            <i />
          </span>
          <div className={styles.body}>
            <div className={styles.hd}>
              <span className={styles.t}>对焦</span>
              <GameSeg
                label="对焦"
                value={focus === 'auto' ? 'auto' : 'manual'}
                options={[
                  { value: 'auto', label: '自动' },
                  { value: 'manual', label: '手动' },
                ]}
                disabled={!photo}
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
              <Slider label="对焦距离" min={0.1} max={FOCUS_FAR} step={0.1} value={focus} defaultValue={FOCUS_FAR} unit="m" disabled={!photo} onChange={(v) => send({ focus: v })} />
            )}
          </div>
        </div>
      </section>
      <div className={styles.shutter}>
        <div className={styles.msg}>
          <MicroLabel>Capture // Transparent PNG</MicroLabel>
          <b>拍下桌面上的她，透明背景</b>
          <span role="status">{shot.text ?? (p.offline ? '角色未运行' : !canCapture ? '渲染器没有提供截图' : '')}</span>
        </div>
        <button
          type="button"
          className={styles.shut}
          aria-label="拍照"
          aria-disabled={off || undefined}
          aria-busy={shot.busy || undefined}
          title={off ? (p.offline ? '角色未运行' : '渲染器没有提供截图') : undefined}
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
    </section>
  );
}
