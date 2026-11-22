import { useRef, useState, type ReactNode } from 'react';
import { getBridge, type ActionSpeed, type AvatarAction, type CharacterEntry } from '../../bridge';
import type { CharacterProfile, CharacterState } from '../../domain';
import { ErrBar, Skel } from '../../ui';
import type { GameTab } from '../../ui/game';
import { BrandBlock } from './BrandBlock';
import { useCharEntrance, useSwitchFade } from './charMotion';
import { Commit } from './Commit';
import type { Toast } from './feedback';
import { HeadStrip } from './HeadStrip';
import { ImportPane } from './ImportPane';
import { doing } from './labels';
import { LookPane, useModTable, type LookTab } from './LookPane';
import { MotionTable } from './MotionTable';
import { useVoiceBinding } from './NameBlock';
import { Panel } from './Panel';
import { Rail, type RailItem } from './Rail';
import { GO, go, SidePanel, type Side } from './Side';
import { Stage, StageSkel, type StageMode } from './Stage';
import { blockedReason, deckLine, groupMotions, useMotions } from './useMotions';
import type { MotionImport } from './useMotionImport';
import type { MotionLibrary } from './useMotionLibrary';
import { useImportState } from './useImportState';
import { useLayers } from './useLayers';
import { useLook } from './useLook';
import { useOutfitImport } from './useOutfitImport';
import { useSectionSwitch } from './useSectionSwitch';
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
  /** `character.importPackage` on the 导入 pane and in the roster; absent without an avatar. */
  onImportPackage?: () => void;
  /** 编排; absent without an avatar. */
  chains?: ReactNode;
  /** 总览 or a detail pane; absent opens 动作. */
  pane?: Pane;
  charState: CharacterState | null;
  /** Unsaved switches a demo opens with. */
  seed?: Record<string, boolean>;
  /** Motion a demo shows as playing on the desktop. */
  playing?: string | null;
  toast: Toast;
  /** 设定 (with its tab), 拍照 or MMD in the panel in place of the panes. */
  side?: Side;
}

export type Pane = 'overview' | 'motion' | 'chain' | 'look' | 'import';

const PANES: readonly Pane[] = ['overview', 'motion', 'chain', 'look', 'import'];

export const isPane = (v: string | null): v is Pane => PANES.some((x) => x === v);

/** Detail panel width per view (BRIEF 11-22 C): wide for 外观, 动作 and 编排 (and 导入 under them), narrow for 设定 and MMD, a single column for 拍照. */
const PANEL: Record<Exclude<Pane, 'overview'> | Side['of'], 'wide' | 'narrow' | 'photo'> = {
  motion: 'wide',
  chain: 'wide',
  look: 'wide',
  import: 'wide',
  set: 'narrow',
  photo: 'photo',
  mmd: 'narrow',
};

const NO_ACTIONS: AvatarAction[] = [];
const NO_LOOKS: Readonly<Record<string, unknown>> = {};

/** First motion worth showing: not required, playable, present. */
const firstPick = (actions: AvatarAction[]) => actions.find((a) => !a.requiredReason && a.playable !== false && !a.missing)?.id ?? actions[0]?.id ?? '';

const failed = (what: string, toast: Toast) => (e: unknown) => {
  const code = (e as { code?: string } | null)?.code;
  toast(`${what}没有完成：${code === 'not_implemented' ? '这个版本还不支持' : '桌面角色没有回应'}`, { severity: 'danger' });
};

/** 角色页：训练场上的实机舞台。总览是头像条、名字块、舞台、黄色斜块和竖栏；外观 / 动作 / 设定 / 拍照 / MMD 没有头像条和名字块，舞台在左，右边是按页取宽的面板。 */
export function Operator(p: OperatorProps) {
  const actions = p.actions ?? NO_ACTIONS;
  // `mmd_` dances belong to the shared MMD library, not to her own actions.
  const groups = groupMotions(actions.filter((a) => !a.id.startsWith('mmd_')));
  const rows = groups.flatMap((g) => g.rows);
  const [sel, setSel] = useState('');
  const [speed, setSpeed] = useState('1');
  const canLoop = getBridge().capabilities.actionLoop === true;
  const canAvatar = getBridge().capabilities.avatar;
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
    character: p.current,
    actions,
    toast: p.toast,
    ...(p.seed ? { seed: p.seed } : {}),
    playing: p.playing ?? null,
  });
  const look = useLook();
  const importState = useImportState();
  // 编排 is absent without an avatar.
  const pane = p.pane === 'chain' && !p.chains ? 'motion' : (p.pane ?? 'motion');
  const [lookTab, setLookTab] = useState<LookTab>('look');
  // 导入 sits under both 外观 (outfit mods) and 动作 (motions); the rail lights the one it was opened from, 动作 for a URL that opens it.
  const [importOf, setImportOf] = useState<'look' | 'motion'>('motion');
  const side = p.side;
  const at: RailItem = side ? side.of : pane === 'overview' ? 'overview' : pane === 'look' ? 'look' : pane === 'import' ? importOf : 'motion';
  const modTable = useModTable(p.current, at === 'look');
  /** True once she has it on. */
  const wear = (l: { id: string; name: string }) =>
    getBridge()
      .avatar.setAppearance(l.id)
      .then(
        () => {
          look.setId(l.id);
          p.toast(`已换成「${l.name}」外观`);
          return true;
        },
        (e: unknown) => {
          failed('换外观', p.toast)(e);
          return false;
        },
      );
  // A new appearance is put on at once; one with mod switches opens on them once she has it on.
  const outfit = useOutfitImport(p.toast, p.current, (a, owns) =>
    Promise.all([wear(a), modTable.reload().catch(() => NO_LOOKS)]).then(([worn, looks]) => {
      if (!worn || !Object.hasOwn(looks, a.id) || !owns()) return;
      setLookTab('mod');
      go({ pane: 'look' });
    }),
  );
  const [bare, setBare] = useState(false);
  const opRef = useRef<HTMLDivElement>(null);
  const midRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useCharEntrance(opRef, midRef, listRef);
  useSwitchFade(midRef, p.current);

  const ch = p.roster.find((c) => c.id === p.current) ?? p.roster[0];
  const pick = rows.find((r) => r.a.id === sel) ?? rows.find((r) => r.a.id === firstPick(rows.map((x) => x.a)));
  const motion = pick?.a;
  const switching = p.sw.state.phase === 'running';
  const importing = importState.running || p.motionImport?.running === true || outfit.state === 'busy';
  const why = blockedReason(motion, p.offline, switching);
  const blocked = why ?? (importing ? '导入中' : m.previewing ? '正在请求桌面预览' : null);
  // A renderer that sends `media` retimes the BGM; without it BGM plays at 1× only.
  const oneSpeed = motion != null && motion.media == null && (p.library?.byId[motion.id]?.hasBgm ?? false);
  const appearances = ch?.appearances ?? [];
  const lookRow = appearances.find((l) => l.id === look.id) ?? appearances[0];
  const lookId = lookRow?.id ?? '';
  const { layers, setLayer, showAll } = useLayers(ch, p.current, p.toast);

  const mode: StageMode = side?.of === 'photo' ? 'photo' : !side && pane === 'overview' ? 'overview' : 'detail';
  const overview = mode === 'overview';
  // Only 总览 has the head strip, so only there a key brings the UI back.
  const isBare = bare && overview;
  const panel = side ? PANEL[side.of] : pane === 'overview' ? undefined : PANEL[pane];
  const voice = useVoiceBinding(p.current, overview);
  const mods = Object.hasOwn(modTable.looks, lookId) ? modTable.looks[lookId] : undefined;
  const lt = (lookTab === 'mod' && !mods) || (lookTab === 'show' && layers.length === 0) ? 'look' : lookTab;
  const changes = rows.filter((r) => Object.hasOwn(m.changed, r.a.id)).map((r) => ({ label: r.a.label, on: m.changed[r.a.id] === true }));
  // 动作 always has its action bar; another detail page only while switches wait to be saved (总览 has no room; 编排 has its own commit bar).
  const deck = !side && mode === 'detail' && pane !== 'chain' && (pane === 'motion' || changes.length > 0);
  const play = m.play;
  const asked = previewAction?.character === p.current ? previewAction : undefined;
  // MMD previews its own dance on the same stage.
  const pv = side?.of === 'mmd' ? side.preview : { action: asked?.id, request: asked?.request, loop };

  const imp: GameTab = { id: 'import', label: '导入', icon: 'upload', micro: 'IMPORT' };
  const tabs: GameTab[] =
    at === 'look'
      ? [
          { id: 'look', label: '外观', icon: 'look', micro: 'OUTFIT' },
          ...(layers.length > 0 ? [{ id: 'show', label: '显示', icon: 'eye' as const, micro: 'LAYERS' }] : []),
          ...(mods ? [{ id: 'mod', label: '模组设置', icon: 'tune' as const, micro: 'MOD CFG', count: mods.length }] : []),
          imp,
        ]
      : [{ id: 'motion', label: '动作表', icon: 'play', micro: 'MOTIONS' }, ...(p.chains ? [{ id: 'chain', label: '编排', icon: 'hub' as const, micro: 'CHAIN' }] : []), imp];
  const tab = at === 'look' && pane === 'look' ? lt : pane;
  const onTab = (id: string) => {
    if (id === 'import') {
      setImportOf(at === 'motion' ? 'motion' : 'look');
      go({ pane: 'import' });
    } else if (at === 'look') {
      setLookTab(id as LookTab);
      if (pane !== 'look') go({ pane: 'look' });
    } else go({ pane: id as 'motion' | 'chain' });
  };

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
      hours={null}
      offline={p.offline}
      lock={switching}
      sparse={false}
      saving={m.saving}
      onUndo={m.undo}
      onSave={m.save}
      {...(p.library ? { imported: p.library.byId } : {})}
      externalCommit
    />
  );

  // What the section draws besides the stage and the rail; the sequencer keeps the leaving one until its out clip and the wait end.
  const view = useSectionSwitch(
    at,
    {
      mode,
      panel,
      deck,
      band: (side?.of === 'mmd' && side.band) || undefined,
      status: deck ? deckLine(why, blocked, play, oneSpeed) : null,
      strip: overview && (
        <HeadStrip
          roster={p.roster}
          current={p.current}
          pending={switching && p.sw.state.phase === 'running' ? p.sw.state.target.id : null}
          offline={p.offline}
          importing={importing}
          onPick={p.sw.request}
          onImport={p.onImportPackage}
          bare={bare}
          onBare={setBare}
          listRef={listRef}
        />
      ),
      right: overview ? (
        <BrandBlock />
      ) : side ? (
        <SidePanel side={side} />
      ) : (
        <Panel tabs={tabs} value={tab} onTab={onTab} tail={at === 'look' ? 'Agentic Complex / Appearance' : 'Agentic Complex / Motion'} pane={pane}>
          {pane === 'motion' ? (
            <section className={styles.motions} aria-label="动作开关">
              {table}
            </section>
          ) : pane === 'chain' ? (
            <section className={styles.chain} aria-label="编排">{p.chains}</section>
          ) : pane === 'look' || (pane === 'import' && importOf === 'look') ? (
            <LookPane
              tab={pane === 'import' ? 'import' : lt}
              character={p.current}
              appearances={appearances}
              lookId={lookId}
              look={look}
              onWear={(l) => void wear(l)}
              layers={layers}
              onLayer={setLayer}
              onShowAll={showAll}
              mods={mods}
              modsUnreadable={modTable.unreadable}
              ro={p.offline ? '角色未运行' : switching ? '切换中' : null}
              outfit={outfit}
              importing={importState}
              toast={p.toast}
            />
          ) : (
            <ImportPane
              {...(p.onImportPackage ? { onImportPackage: p.onImportPackage } : {})}
              offline={p.offline}
              lock={switching}
              {...(p.motionImport ? { motionImport: p.motionImport } : {})}
              {...(p.library ? { library: p.library } : {})}
            />
          )}
        </Panel>
      ),
      commit: deck && (
        <Commit
          offline={p.offline}
          changes={changes}
          saving={m.saving}
          onUndo={m.undo}
          onSave={m.save}
          speed={oneSpeed ? '1' : speed}
          onSpeed={setSpeed}
          oneSpeed={oneSpeed}
          blocked={blocked}
          hidden={look.visible === false}
          onPlay={() => motion && void m.preview(motion, (oneSpeed ? 1 : Number(speed)) as ActionSpeed, loop)}
          loop={loop}
          onLoop={setLoop}
          canLoop={canLoop}
          looping={m.play?.loop === true}
          onStop={() => void m.stop()}
          progress={play && !play.loop ? play.progress : null}
        />
      ),
    },
    opRef,
  );
  const s = view.scene;

  return (
    <div ref={opRef} className={styles.op} data-view="operator" data-mode={s.mode} data-panel={s.panel} data-bare={isBare || undefined} data-deck={s.deck || undefined} data-band={s.band} data-theme="light">
      {view.parts && s.strip}
      <div ref={midRef} className={styles.mid} data-character-preview="">
        <Stage
          mode={s.mode}
          status={s.status}
          deck={s.deck}
          name={s.mode === 'overview' && view.parts ? (ch?.name ?? '') : ''}
          en={ch?.en}
          active={ch?.active}
          voice={voice}
          activity={s.mode === 'overview' ? doing(p.charState?.activity ?? null) : null}
          offline={p.offline}
          backoff={p.backoff}
          onRestart={p.onRestart}
          sw={p.sw.state}
          currentName={ch?.name ?? ''}
          onRetry={p.sw.retry}
          onDismiss={p.sw.dismiss}
          characterId={p.current}
          previewAction={pv.action}
          previewRequest={pv.request}
          previewAppearance={lookId}
          loop={pv.loop}
        />
      </div>
      {view.parts && s.right}
      <Rail value={at} avatar={canAvatar} sub={!side && pane === 'import'} onGo={(item) => GO[item]()} />
      {view.parts && s.commit}
    </div>
  );
}

/** The page before the catalog arrives: the same scene, an empty stage. */
export function OperatorSkel() {
  return (
    <div className={styles.op} data-view="operator" data-mode="overview" data-theme="light">
      <div className={styles.mid} data-character-preview="">
        <StageSkel />
      </div>
    </div>
  );
}
