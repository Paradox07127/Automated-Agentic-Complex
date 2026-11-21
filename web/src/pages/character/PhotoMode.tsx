// 拍照：复刻游戏拍照面板（SnapshotCtrl.lua）。滤镜格只取 settings.schema 里 rnd.filter 的选项；光圈、对焦经 avatar.photo.set 下发。
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getBridge, type PhotoState } from '../../bridge';
import { artEnabled, Btn, ErrBar, Seg, Skel, Slider } from '../../ui';
import type { Toast } from './feedback';
import { saveSettings, useCharSettings } from './settings';
import { readFail } from './Tune';
import styles from './PhotoMode.module.css';

const FILTER = 'rnd.filter';
/** The game's camera on opening: f/32 and focus on the character. */
const OPEN: PhotoState = { active: true, aperture: 32, focus: 'auto' };
/** Manual focus starts at the far end of 0.1–10 m. */
const FOCUS_FAR = 10;

/** `(f/%.0f)`, or `(f/%.1f)` when the tenths are not zero. */
export const fNumber = (f: number) => `(f/${f.toFixed(Math.round(f * 10) % 10 === 0 ? 0 : 1)})`;

const codeOf = (e: unknown) => (e as { code?: string } | null)?.code;

export interface PhotoModeProps {
  /** The shell has an avatar host: while the panel is open she walks clear of the main window. */
  avatar: boolean;
  offline: boolean;
  toast: Toast;
}

/** 拍照面板：上半滤镜格和信息区，下半光圈、对焦和快门；左边的预览台不动。 */
export function PhotoMode(p: PhotoModeProps) {
  const { q, merge } = useCharSettings();
  const details = useQuery({ queryKey: ['character', 'avatarDetails'], queryFn: () => getBridge().avatar.details(), enabled: p.avatar });
  const photo = details.data?.photo === true;
  const canCapture = details.data?.capture === true;
  const [aperture, setAperture] = useState(OPEN.aperture);
  const [focus, setFocus] = useState(OPEN.focus);
  // The cell whose name the info area shows; the saved value is the one in use.
  const [picked, setPicked] = useState<string | null>(null);
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

  const take = () => {
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
  const sel = options.find((o) => o.value === (picked ?? using)) ?? options[0];
  const art = artEnabled();
  const pick = (id: string) => {
    setPicked(id);
    if (!n || id === using) return;
    void saveSettings({ [FILTER]: id }, { ok: '已换滤镜', fail: '没有换滤镜' }, n.rows, p.toast).then((ok) => ok && merge({ [FILTER]: id }));
  };

  let filters;
  if (q.isError) filters = <ErrBar message={`读取滤镜失败：${readFail(q.error)}`} onRetry={() => void q.refetch()} />;
  else if (!n) filters = <Skel rows={4} />;
  else
    filters = (
      <>
        <div className={styles.grid} role="radiogroup" aria-label="滤镜">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              className={styles.cell}
              aria-checked={o.value === using}
              aria-label={o.label}
              data-selected={o.value === sel?.value || undefined}
              onClick={() => pick(o.value)}
            >
              {art && o.value !== 'none' ? <img className={styles.icon} src={`art/common/photo-filter-${o.value}.png`} alt="" /> : <span className={styles.icon} aria-hidden="true" />}
              <span className={styles.name}>{o.label}</span>
              {o.value === using && <span className={styles.use}>使用中</span>}
            </button>
          ))}
        </div>
        <div className={styles.info}>
          <div className={styles.infoName}>{sel?.label}</div>
          <div className={styles.infoDesc}>调整照片色彩的滤镜</div>
        </div>
      </>
    );

  return (
    <div className={styles.photo}>
      <section className={styles.filters} aria-label="滤镜">
        {filters}
      </section>
      <section className={styles.camera} aria-label="相机">
        {!photo && (
          <div className={styles.note} role="status">
            景深还没有接上：渲染器支持拍照景深后，光圈和对焦才可以调
          </div>
        )}
        <div className={styles.ctl}>
          <span className={styles.k}>
            光圈 <span className={styles.num}>{fNumber(aperture)}</span>
          </span>
          <Slider label="光圈" min={1.4} max={32} step={0.1} value={aperture} defaultValue={OPEN.aperture} disabled={!photo} onChange={(v) => send({ aperture: v })} />
        </div>
        <div className={styles.ctl}>
          <span className={styles.k}>
            对焦 {focus !== 'auto' && <span className={styles.num}>{`(${focus.toFixed(1)}m)`}</span>}
          </span>
          <Seg
            label="对焦"
            size="sm"
            value={focus === 'auto' ? 'auto' : 'manual'}
            options={[
              { value: 'auto', label: '自动', disabled: !photo },
              { value: 'manual', label: '手动', disabled: !photo },
            ]}
            onChange={(v) => (v === 'auto' ? send({ focus: 'auto' }) : focus === 'auto' && send({ focus: FOCUS_FAR }))}
          />
          {focus !== 'auto' && (
            <Slider label="对焦距离" min={0.1} max={FOCUS_FAR} step={0.1} value={focus} defaultValue={FOCUS_FAR} unit="m" disabled={!photo} onChange={(v) => send({ focus: v })} />
          )}
        </div>
        <div className={styles.shutter}>
          <Btn
            variant="primary"
            loading={shot.busy}
            disabled={p.offline || !canCapture}
            disabledReason={p.offline ? '角色未运行' : '渲染器没有提供截图'}
            onClick={take}
          >
            拍照
          </Btn>
          {shot.text && (
            <span className={styles.saved} role="status">
              {shot.text}
            </span>
          )}
        </div>
      </section>
    </div>
  );
}
