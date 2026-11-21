import { useState } from 'react';
import { getBridge, type ActionSpeed } from '../../../../bridge';
import type { MotionSource } from '../../../../pages/settings/api';
import { navRoute } from '../../../../shell/nav';
import { Btn, IconBtn, Seg, Select, Slider } from '../../../../ui';
import { Fold } from '../../../../ui/Fold';
import type { CommandSlotProps } from '../../types';
import { CmdCard } from './CmdCard';
import { CAMERAS, lacking, listedActions, useTune } from './useTune';
import styles from './TuneSlot.module.css';

const SPEEDS = [
  { value: '0.5', label: '0.5×' },
  { value: '1', label: '1×' },
  { value: '2', label: '2×' },
];

const SOURCES = [
  { value: 'game', label: '游戏动作' },
  { value: 'generated', label: '模型生成' },
];

const sourceName = (s: MotionSource | null, failed: boolean) =>
  s == null ? (failed ? '读取失败' : '正在读取') : s.backend === 'game' ? '游戏动作' : s.service_url ? '模型生成' : '模型生成 │ 未连接服务';

/** 镜头与动作 over her head: camera, action, size and appearance, each folded with its current value. */
export function TuneSlot({ state, close }: CommandSlotProps) {
  const name = state?.character?.name ?? '角色';
  const t = useTune(state?.character?.id ?? null);
  const bridge = getBridge();
  const listed = t.actions ? listedActions(t.actions) : [];
  const sel = listed.find((a) => a.id === t.selected);
  const selLack = sel ? lacking(sel) : '没有可播放的动作';
  const cameras = CAMERAS.map((c) => ({ ...c, why: t.actions ? lacking(t.actions.find((a) => a.id === c.id)) : '正在读取角色动作' }));
  const noCamera = t.actions != null && cameras.every((c) => c.why);
  const turned = CAMERAS.find((c) => c.id === t.camera);
  const lookName = t.looks.find((l) => l.id === t.look)?.name ?? (t.look === 'default' || t.look == null ? '默认' : t.look);
  // Unsaved edits over the saved source; a field left undefined shows the saved value.
  const [draft, setDraft] = useState<{ backend?: MotionSource['backend']; url?: string }>({});
  const [token, setToken] = useState('');
  const backend = draft.backend ?? t.source?.backend ?? 'game';
  const url = draft.url ?? t.source?.service_url ?? '';
  const saveWhy = t.source == null ? (t.sourceFailed ? '动作来源没读到，先重新读取' : '正在读取动作来源') : backend === 'generated' && !url.trim() ? '先填动作服务地址' : null;
  const saveSource = () =>
    void t.saveSource({ backend, service_url: url.trim() || null, ...(token ? { token } : {}) }).then((ok) => {
      if (!ok) return;
      setDraft({});
      setToken('');
    });
  const clearToken = () => t.source && void t.saveSource({ backend: t.source.backend, service_url: t.source.service_url, token: '' });

  return (
    <CmdCard
      slot="tune"
      code="TUNING"
      tag={(t.en ?? state?.character?.id ?? '').toUpperCase()}
      title="镜头与动作"
      label={`${name} │ 镜头与动作`}
      art="tune-head"
      onClose={close}
      tools={<IconBtn icon="close" size="sm" label="关闭" onClick={close} />}
    >
      {t.loadError && (
        <div className={styles.err} role="alert">
          <span>{t.loadError}</span>
          <Btn size="sm" variant="text" onClick={t.reload}>
            重新读取
          </Btn>
        </div>
      )}

      <Fold id="tune-camera" label="镜头" summary={noCamera ? '缺资源' : turned ? `已转向${turned.name}` : '原作镜头'}>
        <div className={styles.row}>
          {cameras.map((c) => (
            <Btn key={c.id} size="sm" variant="ghost" disabled={!!c.why || t.busy} disabledReason={c.why ?? '正在播放动作'} onClick={() => t.playCamera(c.id)}>
              {c.label}
            </Btn>
          ))}
        </div>
        {noCamera && <p className={styles.note}>当前角色包没有镜头动作</p>}
      </Fold>

      <Fold id="tune-motion" label="动作" summary={sel ? `${sel.label} │ ${t.speed}×${selLack ? ` │ ${selLack}` : ''}` : '没有可播放的动作'}>
        {t.actions == null && !t.loadError && <p className={styles.note}>正在读取角色动作</p>}
        {listed.length > 0 && (
          <ul className={styles.list} role="listbox" aria-label="动作">
            {listed.map((a) => (
              <li
                key={a.id}
                role="option"
                className={styles.opt}
                aria-selected={a.id === t.selected}
                data-missing={a.missing || undefined}
                onClick={() => t.setSelected(a.id)}
              >
                <span className={styles.optName}>{a.label}</span>
                {a.missing && <span className={styles.lack}>{lacking(a)}</span>}
              </li>
            ))}
          </ul>
        )}
        <div className={styles.row}>
          <Seg size="sm" label="速度" options={SPEEDS} value={String(t.speed)} onChange={(v) => t.setSpeed(Number(v) as ActionSpeed)} />
          <span className={styles.sp} />
          <Btn size="sm" variant="secondary" icon="play" disabled={!!selLack || t.busy} disabledReason={selLack ?? '正在播放动作'} onClick={t.playSelected}>
            播放
          </Btn>
        </div>
      </Fold>

      <Fold id="tune-source" label="动作来源" summary={sourceName(t.source, t.sourceFailed)}>
        {t.sourceFailed && t.source == null && (
          <div className={styles.err} role="alert">
            <span>没能读取动作来源</span>
            <Btn size="sm" variant="text" onClick={t.reload}>
              重新读取
            </Btn>
          </div>
        )}
        <Seg size="sm" label="动作来源" options={SOURCES} value={backend} onChange={(v) => setDraft({ ...draft, backend: v as MotionSource['backend'] })} />
        <input
          className={styles.input}
          aria-label="动作服务地址"
          placeholder="http://主机:48830"
          value={url}
          onChange={(e) => setDraft({ ...draft, url: e.currentTarget.value })}
        />
        <div className={styles.row}>
          <input
            className={styles.input}
            type="password"
            autoComplete="new-password"
            aria-label="口令"
            placeholder={t.source?.token_set ? '已保存口令' : '口令（可不填）'}
            value={token}
            onChange={(e) => setToken(e.currentTarget.value)}
          />
          <Btn size="sm" variant="text" disabled={!t.source?.token_set} disabledReason="没有保存的口令" onClick={clearToken}>
            清除
          </Btn>
          <span className={styles.sp} />
          <Btn size="sm" variant="secondary" disabled={!!saveWhy} disabledReason={saveWhy ?? undefined} onClick={saveSource}>
            保存
          </Btn>
        </div>
        <p className={styles.note}>模型生成：她按自己说的话生成动作，连不上服务时自动用游戏动作。</p>
      </Fold>

      <Fold id="tune-size" label="大小" summary={t.scale == null ? '正在读取' : `${t.scale}%`}>
        <Slider min={50} max={200} step={5} label="大小" unit="%" defaultValue={100} value={t.scale ?? 100} disabled={t.scale == null} onChange={t.setScale} />
        <div className={styles.row}>
          <Btn size="sm" variant="text" disabled={t.scale == null || t.scale === 100} disabledReason="已是默认大小" onClick={() => t.setScale(100)}>
            恢复默认
          </Btn>
          <span className={styles.sp} />
          <Btn size="sm" variant="ghost" onClick={() => void bridge.desktop.action('resize')}>
            拖手柄…
          </Btn>
        </div>
      </Fold>

      <Fold id="tune-look" label="外观" summary={lookName}>
        {t.looks.length <= 1 && <p className={styles.note}>当前角色包只有一套外观</p>}
        {t.looks.length > 1 && t.looks.length <= 4 && (
          <Seg size="sm" label="外观" options={t.looks.map((l) => ({ value: l.id, label: l.name }))} value={t.look ?? ''} onChange={t.setAppearance} />
        )}
        {t.looks.length > 4 && <Select label="外观" options={t.looks.map((l) => ({ value: l.id, label: l.name }))} value={t.look ?? ''} onChange={t.setAppearance} />}
      </Fold>

      {t.status && (
        <p className={styles.status} role="status">
          {t.status}
        </p>
      )}
      <div className={styles.more}>
        <button type="button" className={styles.lnk} onClick={() => bridge.window.openMain(navRoute({ page: 'character', tab: 'render' }))}>
          更多 → 角色 / 画面
        </button>
      </div>
    </CmdCard>
  );
}
