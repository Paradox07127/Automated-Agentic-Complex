import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getBridge, type ActionSpeed, type AvatarAction, type CharacterEntry } from '../../bridge';
import type { CharacterProfile, CharacterState } from '../../domain';
import { CharacterArt, ErrBar, Icon, OptionRow, SecHead, Skel, Slider } from '../../ui';
import { useControlled } from '../../ui/useControlled';
import { useCharEntrance, useSwitchFade } from './charMotion';
import { Commit } from './Commit';
import type { Toast } from './feedback';
import { ImportPane } from './ImportPane';
import { doing, SECTIONS } from './labels';
import { ModSettings } from './ModSettings';
import { MotionTable } from './MotionTable';
import { Playback } from './Playback';
import { Roster } from './Roster';
import { Stage, StageSkel } from './Stage';
import { blockedReason, groupMotions, useMotions } from './useMotions';
import type { MotionImport } from './useMotionImport';
import type { MotionLibrary } from './useMotionLibrary';
import { useImportState } from './useImportState';
import { useLook } from './useLook';
import { useOutfitImport } from './useOutfitImport';
import type { SwitchState } from './useSwitch';
import styles from './Operator.module.css';

export interface OperatorProps {
  roster: CharacterEntry[];
  current: string;
  sw: {
    state: SwitchState;
    request: (c: CharacterProfile) => void;
    retry: () => void;
    dismiss: () => void;
  };
  offline: boolean;
  backoff: number | null;
  onRestart: () => void;
  /** `avatar.actions()`; null while loading or when it failed (`motionsError`). */
  actions: AvatarAction[] | null;
  motionsError: string | null;
  onRetryMotions: () => void;
  /** 「导入动作」 on the 导入 pane; absent without an avatar. */
  motionImport?: MotionImport;
  /** Imported motions: the format tag in the motion table, 改名 and 删除 on the 导入 pane; absent without an avatar. */
  library?: MotionLibrary;
  /** `character.importPackage` on the 导入 pane; absent without an avatar. */
  onImportPackage?: () => void;
  /** 衔接 under the motion table; absent without an avatar. */
  chains?: ReactNode;
  /** The right column's pane; absent opens 动作. */
  pane?: Pane;
  onPane?: (pane: Pane) => void;
  hours: Record<string, number[]> | null;
  charState: CharacterState | null;
  now: number;
  sparse: boolean;
  /** Unsaved switches a demo opens with. */
  seed?: Record<string, boolean>;
  /** Motion a demo shows as playing on the desktop. */
  playing?: string | null;
  /** Show the weapon switch (no host op yet: mock only). */
  weapon: boolean;
  toast: Toast;
  /** 「设定」 in place of the right column; the panes, 今日播放 and the commit bar are then not drawn. */
  settings?: ReactNode;
}

export type Pane = 'motion' | 'chain' | 'look' | 'import';

const PANES: Array<{ id: Pane; label: string }> = [
  { id: 'motion', label: '动作' },
  { id: 'chain', label: '编排' },
  { id: 'look', label: '外观' },
  { id: 'import', label: '导入' },
];

export const isPane = (v: string | null): v is Pane => PANES.some((x) => x.id === v);

const NO_ACTIONS: AvatarAction[] = [];

/** First motion worth showing: not required, playable, present. */
const firstPick = (actions: AvatarAction[]) => actions.find((a) => !a.requiredReason && a.playable !== false && !a.missing)?.id ?? actions[0]?.id ?? '';

const failed = (what: string, toast: Toast) => (e: unknown) => {
  const code = (e as { code?: string } | null)?.code;
  toast(`${what}没有完成：${code === 'not_implemented' ? '这个版本还不支持' : '桌面角色没有回应'}`, { severity: 'danger' });
};

/** 角色与动作：左边预览台（左上角的头像键换角色）、名牌和今日播放不随右边滚动 │ 右边 动作、编排、外观、导入 四个页签；改动和桌面预览在底部操作条。 */
export function Operator(p: OperatorProps) {
  const actions = p.actions ?? NO_ACTIONS;
  // `mmd_` dances belong to the shared MMD library, not to her own actions.
  const groups = groupMotions(actions.filter((a) => !a.id.startsWith('mmd_')));
  const rows = groups.flatMap((g) => g.rows);
  const [sel, setSel] = useState('');
  const [speed, setSpeed] = useState('1');
  const canLoop = getBridge().capabilities.actionLoop === true;
  const [loopPick, setLoop] = useState(false);
  const loop = canLoop && loopPick;
  // Only a click on a row plays a motion in the live preview; a new character starts on her idle.
  const [previewAction, setPreviewAction] = useState<{
    character: string;
    id: string;
    request: number;
  }>();
  const previewRequest = useRef(0);
  const m = useMotions({
    actions,
    toast: p.toast,
    ...(p.seed ? { seed: p.seed } : {}),
    playing: p.playing ?? null,
  });
  const look = useLook();
  const outfit = useOutfitImport(p.toast);
  const importState = useImportState();
  const [pane] = useControlled<Pane>(p.pane ?? 'motion', p.onPane);
  const [weaponOn, setWeaponOn] = useState(true);
  const [rosterOpen, setRosterOpen] = useState(false);
  const swRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!rosterOpen) return;
    const away = (e: MouseEvent) => !swRef.current?.contains(e.target as Node) && setRosterOpen(false);
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [rosterOpen]);
  // The hidden set the last successful `avatar.setLayers` sent; the roster only changes on a refetch.
  const [hiddenSet, setHiddenSet] = useState<{
    character: string;
    hidden: string[];
  }>();
  const opRef = useRef<HTMLDivElement>(null);
  const midRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLElement>(null);
  useCharEntrance(opRef, midRef, listRef);
  useSwitchFade(midRef, p.current);

  const ch = p.roster.find((c) => c.id === p.current) ?? p.roster[0];
  const pick = rows.find((r) => r.a.id === sel) ?? rows.find((r) => r.a.id === firstPick(actions));
  const motion = pick?.a;
  const hours = motion && p.hours ? (p.hours[motion.id] ?? Array.from({ length: 24 }, () => 0)) : null;
  const switching = p.sw.state.phase === 'running';
  const importing = importState.running || p.motionImport?.running === true || outfit.state === 'busy';
  const blocked = blockedReason(motion, p.offline, switching) ?? (importing ? '导入中' : m.previewing ? '正在请求桌面预览' : null);
  // A renderer that sends `media` retimes the BGM; without it BGM plays at 1× only.
  const oneSpeed = motion != null && motion.media == null && (p.library?.byId[motion.id]?.hasBgm ?? false);
  const hour = new Date(p.now).getHours();
  const appearances = ch?.appearances ?? [];
  const lookRow = appearances.find((l) => l.id === look.id) ?? appearances[0];
  const lookId = lookRow?.id ?? '';
  const ro = p.offline || switching;
  const layers = (ch?.layers ?? []).map((l) => (hiddenSet?.character === ch?.id ? { ...l, visible: !hiddenSet?.hidden.includes(l.id) } : l));

  const table = p.motionsError ? (
    <ErrBar message={`读取动作失败：${p.motionsError}`} onRetry={p.onRetryMotions} />
  ) : p.actions == null ? (
    <Skel rows={8} />
  ) : (
    <MotionTable
      groups={groups}
      value={m.value}
      changed={m.changed}
      sel={motion?.id ?? ''}
      onSel={(id) => {
        setSel(id);
        const a = actions.find((x) => x.id === id);
        setPreviewAction(a && a.playable !== false && !a.missing ? { character: p.current, id, request: ++previewRequest.current } : undefined);
      }}
      onToggle={m.toggle}
      hours={p.hours}
      offline={p.offline}
      lock={switching}
      sparse={p.sparse}
      saving={m.saving}
      onUndo={m.undo}
      onSave={m.save}
      {...(p.library ? { imported: p.library.byId } : {})}
      externalCommit
    />
  );

  const setLayer = (id: string, on: boolean, name: string) => {
    const hidden = layers.filter((x) => (x.id === id ? !on : !x.visible)).map((x) => x.id);
    getBridge()
      .avatar.setLayers(hidden)
      .then(
        () => {
          setHiddenSet({ character: p.current, hidden });
          p.toast(on ? `已显示「${name}」` : `已隐藏「${name}」`);
        },
        failed('服装分层', p.toast),
      );
  };
  const setSize = (v: number) => {
    look.setScale(v);
    void getBridge()
      .avatar.setScale(v / 100)
      .catch(failed('改大小', p.toast));
  };
  // Option plates: one press picks an appearance or shows / hides a layer; the lit plate is what she wears now.
  const lookPane = (
    <section className={styles.look} aria-label="角色外观与大小" data-g="bottomMenu" inert={ro || undefined} data-ro={ro || undefined}>
      {appearances.length > 0 && (
        <div>
          <SecHead no="01" title="外观" />
          <div className={styles.plates} role="listbox" aria-label="外观">
            {appearances.map((l) => (
              <OptionRow
                key={l.id}
                label={l.kind === 'imported' ? `${l.name}（导入）` : l.name}
                selected={l.id === lookId}
                onClick={() => {
                  getBridge()
                    .avatar.setAppearance(l.id)
                    .then(
                      () => {
                        look.setId(l.id);
                        p.toast(`已换成「${l.name}」外观`);
                      },
                      failed('换外观', p.toast),
                    );
                }}
              />
            ))}
          </div>
        </div>
      )}
      {(layers.length > 0 || p.weapon) && (
        <div>
          <SecHead no="02" title="显示" />
          <div className={styles.plates} role="listbox" aria-multiselectable="true" aria-label="服装分层">
            {layers.map((l) => (
              <OptionRow key={l.id} label={l.name} selected={l.visible} onClick={() => setLayer(l.id, !l.visible, l.name)} />
            ))}
            {p.weapon && <OptionRow label="武器" selected={weaponOn} onClick={() => setWeaponOn(!weaponOn)} />}
          </div>
        </div>
      )}
      <div>
        <SecHead no="03" title="大小" right={<span className="num">{look.scale}%</span>} />
        <div className={styles.size}>
          <div className={styles.plates} role="listbox" aria-label="大小预设">
            {[75, 100, 125, 150].map((v) => (
              <OptionRow key={v} label={`${v}%`} selected={look.scale === v} onClick={() => setSize(v)} />
            ))}
          </div>
          <Slider label="大小" min={50} max={200} step={5} value={look.scale} defaultValue={100} unit="%" disabled={ro} onChange={setSize} />
        </div>
      </div>
      <ModSettings character={p.current} appearance={lookId} disabled={ro} toast={p.toast} />
    </section>
  );

  return (
    <div ref={opRef} className={styles.op} data-view="operator">
      <div ref={midRef} className={styles.mid} data-character-preview="" data-g="left">
        <div ref={swRef} className={styles.switcher}>
          <button type="button" className={styles.swBtn} aria-expanded={rosterOpen} aria-label={`切换角色，当前 ${ch?.name ?? ''}`} title="切换角色" onClick={() => setRosterOpen((v) => !v)}>
            <CharacterArt src={ch?.head} kind="head" w={40} h={40} fallback={<Icon name="user" size={20} />} />
            <span className={styles.swMark} aria-hidden="true">
              <Icon name="sync" size={12} />
            </span>
          </button>
          {rosterOpen && (
            <div className={styles.swPop}>
              <Roster
                listRef={listRef}
                characters={p.roster}
                current={p.current}
                pending={switching && p.sw.state.phase === 'running' ? p.sw.state.target.id : null}
                offline={p.offline}
                importing={importing}
                onPick={(c) => (setRosterOpen(false), p.sw.request(c))}
              />
            </div>
          )}
        </div>
        <Stage
          motion={motion}
          section={motion ? (SECTIONS[motion.section ?? '']?.name ?? '') : ''}
          today={hours ? hours.reduce((a, b) => a + b, 0) : null}
          name={ch?.name ?? ''}
          head={ch?.head}
          portrait={ch?.portrait}
          activity={doing(p.charState?.activity ?? null)}
          scale={look.scale}
          offline={p.offline}
          backoff={p.backoff}
          onRestart={p.onRestart}
          sw={p.sw.state}
          currentName={ch?.name ?? ''}
          onRetry={p.sw.retry}
          onDismiss={p.sw.dismiss}
          play={m.play}
          characterId={p.current}
          previewAction={previewAction?.character === p.current ? previewAction.id : undefined}
          previewRequest={previewAction?.character === p.current ? previewAction.request : undefined}
          previewAppearance={lookId}
          loop={loop}
        />
        {!p.settings && pane === 'motion' && <Playback motion={motion} no={pick?.no ?? ''} hours={hours} hour={hour} sparse={p.sparse} />}
      </div>
      {p.settings ? (
        <div className={styles.settings} data-view="character-settings" data-g="detail">
          {p.settings}
        </div>
      ) : (
        <>
          <div className={styles.panes}>
            <div className={styles.pane} data-g="detail" role="tabpanel" aria-label={PANES.find((x) => x.id === pane)?.label} data-pane={pane}>
              {pane === 'motion' && (
                <>
                  <section className={styles.motions} aria-label="动作开关">
                    {table}
                  </section>
                </>
              )}
              {pane === 'chain' && <section aria-label="编排">{p.chains}</section>}
              {pane === 'look' && lookPane}
              {pane === 'import' && (
                <ImportPane
                  outfit={outfit}
                  looks={appearances.filter((l) => l.kind === 'imported')}
                  offline={p.offline}
                  lock={switching}
                  {...(p.onImportPackage ? { onImportPackage: p.onImportPackage } : {})}
                  {...(p.motionImport ? { motionImport: p.motionImport } : {})}
                  {...(p.library ? { library: p.library } : {})}
                />
              )}
            </div>
          </div>
          {(pane === 'motion' || Object.keys(m.changed).length > 0) && (
            <Commit
              offline={p.offline}
              n={Object.keys(m.changed).length}
              sparse={p.sparse}
              saving={m.saving}
              onUndo={m.undo}
              onSave={m.save}
              speed={oneSpeed ? '1' : speed}
              onSpeed={setSpeed}
              oneSpeed={oneSpeed}
              blocked={blocked}
              playing={m.play?.id === motion?.id}
              hidden={look.visible === false}
              onPlay={() => motion && void m.preview(motion, (oneSpeed ? 1 : Number(speed)) as ActionSpeed, loop)}
              loop={loop}
              onLoop={setLoop}
              canLoop={canLoop}
              looping={m.play?.loop === true}
              onStop={() => void m.stop()}
            />
          )}
        </>
      )}
    </div>
  );
}

/** 角色与动作 before the catalog arrives: the same columns, an empty stage, bars where the panes go. */
export function OperatorSkel() {
  return (
    <div className={styles.op} data-view="operator">
      <div className={styles.mid} data-character-preview="">
        <StageSkel />
      </div>
      <div className={styles.panes}>
        <Skel rows={8} />
      </div>
    </div>
  );
}
