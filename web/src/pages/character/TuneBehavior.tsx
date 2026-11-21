import type { AvatarAction, SettingValue } from '../../bridge';
import { BracketMeter } from '../../charts';
import type { CharacterState } from '../../domain';
import type { Native } from '../settings/native';
import { EffectTag, OpenSec, Plate, Seg, SRow } from '../../ui';
import { MOCK_SCREEN, rangeOf, ScreenMap } from './ScreenMap';
import { stateWord } from './labels';
import { control } from './settings';
import styles from './Tune.module.css';

export interface TuneBehaviorProps {
  n: Native;
  set: (id: string, v: SettingValue) => void;
  /** Ids saved this visit whose change waits for the character to reappear. */
  pending: Set<string>;
  offline: boolean;
  actions: AvatarAction[];
  state: CharacterState | null;
  scales: { baseline: number; walk_scale: number; comment_scale: number } | null;
  /** Draw the screen sketch (its geometry is host_only: mock only). */
  map: boolean;
}

/** Capability chips: the setting, what it does, and the motion it needs. */
const CAPS: Array<[id: string, does: string, motion?: string]> = [
  ['beh.sit', '坐在窗口顶沿', 'sit'],
  ['beh.lean', '靠近窗沿时扶住', 'lean'],
  ['beh.mouse', '视线跟随指针'],
  ['beh.touch', '头、脸、手等部位反应不同'],
  ['beh.pat', '在头顶来回抚摸'],
  ['beh.pinch', '按住脸颊拖动'],
  ['beh.greet', '解锁或唤醒后打招呼'],
  ['beh.inertia', '松开后短距离滑行'],
  ['beh.physics', '头发、饰品和衣摆随动作摆动'],
  ['beh.mood', '精神偏低时走速降低'],
  ['beh.face', '说话时按语气换表情，改后重启角色'],
];

const signed = (v: number) => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(2)}`;

/** 01 行为：活动方式与范围、屏幕示意、能力、状态倍数、桌面浮层。 */
export function TuneBehavior({ n, set, pending, offline, actions, state, scales, map }: TuneBehaviorProps) {
  const row = (id: string) => n.rows[id];
  const opts = (id: string) => (row(id)?.options ?? []).map((o) => ({ ...o, disabled: offline }));
  const stay = String(n.saved['beh.stay'] ?? '');
  /** The shell's note when the running character cannot draw 半身固定 (C3 camera_bust). */
  const bustNote = n.statuses['beh.stay'];
  const range = String(n.saved['beh.range'] ?? 'default');
  const r = rangeOf(range);
  const k = MOCK_SCREEN.w / 320;
  const effect = (id: string) => (row(id)?.restart === 'avatar' ? <EffectTag target="character" pending={pending.has(id)} /> : null);

  const chip = ([id, does, motion]: (typeof CAPS)[number]) => {
    const s = row(id);
    if (!s) return null;
    const lack = motion ? actions.find((a) => a.id === motion && a.missing) : undefined;
    const on = n.saved[id] === true && !lack;
    return (
      <div key={id} className={styles.capc}>
        <button type="button" role="switch" aria-checked={on} data-no={lack ? '' : undefined} disabled={!!lack || offline} className={styles.chip} onClick={() => set(id, !on)}>
          <span className={styles.ic} aria-hidden="true">
            {lack ? '⊘' : on ? '✓' : '○'}
          </span>
          {s.label}
        </button>
        <span className={styles.cap}>{lack ? `不可用 │ ${lack.missingReason ?? '缺资源'}` : on ? `可用 │ ${does}` : '可用 │ 已关闭'}</span>
      </div>
    );
  };

  return (
    <div className={styles.col}>
      <OpenSec no="01" title="行为">
        <div className={styles.trow}>
          {row('beh.stay') && (
            <Seg
              label="活动方式"
              value={stay}
              options={opts('beh.stay').map((o) => (o.value === 'bust' && bustNote && stay !== 'bust' ? { ...o, disabled: true, disabledReason: bustNote } : o))}
              onChange={(v) => set('beh.stay', v)}
            />
          )}
          {row('beh.range') && <Seg size="sm" label="活动范围" value={range} options={opts('beh.range')} onChange={(v) => set('beh.range', v)} />}
          {effect('beh.range')}
        </div>
        {map && (
          <Plate no="Screen" label="屏幕示意">
            <ScreenMap range={range} stay={stay === 'stay' || stay === 'bust'} />
            <div className={styles.maprd}>
              <span className={styles.cap}>活动范围</span>
              <span className={styles.num}>
                {Math.round(r.w * k)} × {Math.round(r.h * k)}
              </span>
              <span className={styles.cap}>pt</span>
            </div>
          </Plate>
        )}
        <div className={styles.sub}>能力</div>
        <div className={styles.caps}>{CAPS.map(chip)}</div>
        {row('beh.watch') && (
          <SRow
            id="watch"
            title={row('beh.watch')!.label}
            control={control(row('beh.watch')!, n.saved['beh.watch'], offline, (v) => set('beh.watch', v))}
            effect="character"
            pending={pending.has('beh.watch')}
            {...(offline ? { disabled: true, disabledReason: '角色未运行' } : {})}
          />
        )}
        {state && state.energy != null && state.valence != null && (
          <>
            <div className={styles.sub}>
              {scales ? '状态倍数' : '当前状态'}
              {scales && <span className={styles.subNote}>│ 「状态影响行为」开启时生效</span>}
            </div>
            <div className={styles.mul}>
              <div className={styles.mulR}>
                <span className={styles.mulK}>精神</span>
                <BracketMeter value={state.energy} max={1} tone="level" size="md" marks={[0.35]} readout={state.energy.toFixed(2)} label="精神" />
                <span className={styles.mulK}>{stateWord('energy', state.labels.energy)}</span>
                {scales && <Multiplier label="行走速度" x={scales.walk_scale} />}
              </div>
              <div className={styles.mulR}>
                <span className={styles.mulK}>心情</span>
                <BracketMeter value={state.valence} max={0.6} center={scales?.baseline ?? 0} size="md" readout={signed(state.valence)} label="心情" />
                <span className={styles.mulK}>{stateWord('mood', state.labels.mood)}</span>
                {scales && <Multiplier label="主动发言间隔" x={scales.comment_scale} />}
              </div>
            </div>
          </>
        )}
        {(row('beh.rail') || row('beh.hint')) && <div className={styles.sub}>桌面浮层</div>}
        {['beh.rail', 'beh.hint'].map((id) => {
          const s = row(id);
          return (
            s && (
              <SRow
                key={id}
                id={id.slice(4)}
                title={s.label}
                control={control(s, n.saved[id], offline, (v) => set(id, v))}
                {...(offline ? { disabled: true, disabledReason: '角色未运行' } : {})}
              />
            )
          );
        })}
      </OpenSec>
    </div>
  );
}

function Multiplier({ label, x }: { label: string; x: number }) {
  return (
    <>
      <span className={styles.mulK} aria-hidden="true">
        →
      </span>
      <span className={styles.mulL}>{label}</span>
      <b className={styles.x}>
        <small>×</small>
        {x}
      </b>
    </>
  );
}
