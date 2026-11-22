import { useRef, useState, type ReactNode } from 'react';
import { getBridge, type ActionSpeed, type AvatarAction, type CharacterEntry } from '../../bridge';
import type { CharacterProfile, CharacterState } from '../../domain';
import { navigate } from '../../shell/nav';
import { ErrBar, Skel, type IconName } from '../../ui';
import { useCharEntrance, useSwitchFade } from './charMotion';
import { Commit } from './Commit';
import type { Toast } from './feedback';
import { HeadStrip } from './HeadStrip';
import { ImportPane } from './ImportPane';
import { doing, SECTIONS } from './labels';
import { LookPane, useModTable, type LookTab } from './LookPane';
import { MotionTable } from './MotionTable';
import { Panel, type PanelTab } from './Panel';
import { Rail, type RailItem } from './Rail';
import { CHAR_TABS, type CharTab } from './sections';
import { Stage, StageSkel, type StageMode } from './Stage';
import { blockedReason, groupMotions, useMotions } from './useMotions';
import type { MotionImport } from './useMotionImport';
import type { MotionLibrary } from './useMotionLibrary';
import { useImportState } from './useImportState';
import { useLook } from './useLook';
import { useOutfitImport } from './useOutfitImport';
import { previewLookChanged } from './usePreview';
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
  /** 设定 (with its tab) or 拍照 in the panel in place of the panes. */
  side?: Side;
  /** The rail's MMD item: opens the MMD page; absent without an avatar. */
  onMmd?: () => void;
}

export type Pane = 'overview' | 'motion' | 'chain' | 'look' | 'import';

export type Side = { of: 'set'; tab: CharTab; node: ReactNode } | { of: 'photo'; node: ReactNode };

const PANES: readonly Pane[] = ['overview', 'motion', 'chain', 'look', 'import'];

export const isPane = (v: string | null): v is Pane => PANES.some((x) => x === v);

const NO_ACTIONS: AvatarAction[] = [];
const SET_ICON: Record<CharTab, IconName> = { behavior: 'hand', render: 'sun', scene: 'loc' };

/** First motion worth showing: not required, playable, present. */
const firstPick = (actions: AvatarAction[]) => actions.find((a) => !a.requiredReason && a.playable !== false && !a.missing)?.id ?? actions[0]?.id ?? '';

const failed = (what: string, toast: Toast) => (e: unknown) => {
  const code = (e as { code?: string } | null)?.code;
  toast(`${what}没有完成：${code === 'not_implemented' ? '这个版本还不支持' : '桌面角色没有回应'}`, { severity: 'danger' });
};

const go = (to: Omit<Extract<Parameters<typeof navigate>[0], { page: 'character' }>, 'page'>) => navigate({ page: 'character', ...to });

const GO: Record<Exclude<RailItem, 'mmd'>, () => void> = {
  overview: () => go({}),
  look: () => go({ pane: 'look' }),
  motion: () => go({ pane: 'motion' }),
  set: () => go({ tab: 'behavior' }),
  photo: () => go({ view: 'photo' }),
};

/** 角色页：训练场上的实机舞台。总览是头像条、名字栏、舞台和竖栏；外观 / 动作 / 设定把舞台移到左边，右边是带页签的面板。 */
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
    actions,
    toast: p.toast,
    ...(p.seed ? { seed: p.seed } : {}),
    playing: p.playing ?? null,
  });
  const look = useLook();
  const importState = useImportState();
  const pane = p.pane ?? 'motion';
  const [lookTab, setLookTab] = useState<LookTab>('look');
  // 导入 sits under both 外观 and 动作; the rail lights the one it was opened from.
  const [importOf, setImportOf] = useState<'look' | 'motion'>('look');
  const side = p.side;
  const at: RailItem = side ? side.of : pane === 'overview' ? 'overview' : pane === 'look' ? 'look' : pane === 'import' ? importOf : 'motion';
  const modTable = useModTable(p.current, at === 'look');
  const wear = (l: { id: string; name: string }) =>
    getBridge()
      .avatar.setAppearance(l.id)
      .then(() => {
        look.setId(l.id);
        p.toast(`已换成「${l.name}」外观`);
      }, failed('换外观', p.toast));
  // A new appearance is put on at once; one with mod switches opens on them.
  const outfit = useOutfitImport(p.toast, (a) => {
    void wear(a);
    modTable.reload().then((looks) => {
      if (!looks[a.id]) return;
      setLookTab('mod');
      go({ pane: 'look' });
    }, () => {});
  });
  const [bare, setBare] = useState(false);
  // The hidden set the last successful `avatar.setLayers` sent; the roster only changes on a refetch.
  const [hiddenSet, setHiddenSet] = useState<{
    character: string;
    hidden: string[];
  }>();
  const opRef = useRef<HTMLDivElement>(null);
  const midRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useCharEntrance(opRef, midRef, listRef);
  useSwitchFade(midRef, p.current);

  const ch = p.roster.find((c) => c.id === p.current) ?? p.roster[0];
  const pick = rows.find((r) => r.a.id === sel) ?? rows.find((r) => r.a.id === firstPick(actions));
  const motion = pick?.a;
  const switching = p.sw.state.phase === 'running';
  const importing = importState.running || p.motionImport?.running === true || outfit.state === 'busy';
  const blocked = blockedReason(motion, p.offline, switching) ?? (importing ? '导入中' : m.previewing ? '正在请求桌面预览' : null);
  // A renderer that sends `media` retimes the BGM; without it BGM plays at 1× only.
  const oneSpeed = motion != null && motion.media == null && (p.library?.byId[motion.id]?.hasBgm ?? false);
  const appearances = ch?.appearances ?? [];
  const lookRow = appearances.find((l) => l.id === look.id) ?? appearances[0];
  const lookId = lookRow?.id ?? '';
  const ro = p.offline || switching;
  const layers = (ch?.layers ?? []).map((l) => (hiddenSet?.character === ch?.id ? { ...l, visible: !hiddenSet?.hidden.includes(l.id) } : l));

  const mode: StageMode = side?.of === 'photo' ? 'photo' : !side && pane === 'overview' ? 'overview' : 'detail';
  const mods = modTable.looks[lookId];
  const lt = (lookTab === 'mod' && !mods) || (lookTab === 'show' && layers.length === 0) ? 'look' : lookTab;

  const tabs: PanelTab[] =
    at === 'look'
      ? [
          { id: 'look', label: '外观', icon: 'look' },
          ...(layers.length > 0 ? [{ id: 'show', label: '显示', icon: 'eye' as const }] : []),
          ...(mods ? [{ id: 'mod', label: '模组设置', icon: 'tune' as const, count: mods.length }] : []),
          { id: 'import', label: '导入', icon: 'plus' },
        ]
      : at === 'motion'
        ? [{ id: 'motion', label: '动作表', icon: 'play' }, ...(p.chains ? [{ id: 'chain', label: '编排', icon: 'hub' as const }] : []), { id: 'import', label: '导入', icon: 'plus' }]
        : side?.of === 'set'
          ? CHAR_TABS.map((t) => ({ id: t.id, label: t.title, icon: SET_ICON[t.id] }))
          : [];
  const tab = side?.of === 'set' ? side.tab : at === 'look' && pane === 'look' ? lt : pane;
  const onTab = (id: string) => {
    if (side?.of === 'set') go({ tab: id as CharTab });
    else if (id === 'import') {
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

  const setLayer = (id: string, on: boolean, name: string) => {
    const hidden = layers.filter((x) => (x.id === id ? !on : !x.visible)).map((x) => x.id);
    getBridge()
      .avatar.setLayers(hidden)
      .then(
        () => {
          setHiddenSet({ character: p.current, hidden });
          previewLookChanged();
          p.toast(on ? `已显示「${name}」` : `已隐藏「${name}」`);
        },
        (e: unknown) => {
          const code = (e as { code?: string } | null)?.code;
          p.toast(`服装分层没有完成：${code === 'not_implemented' ? '这个版本还不支持' : '桌面角色没有回应'}`, { severity: 'danger' });
        },
      );
  };

  return (
    <div ref={opRef} className={styles.op} data-view="operator" data-mode={mode} data-bare={bare || undefined} data-theme="light">
      {mode !== 'photo' && (
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
      )}
      <div ref={midRef} className={styles.mid} data-character-preview="">
        <Stage
          mode={mode}
          motion={mode === 'detail' && !side && (pane === 'motion' || pane === 'chain') ? motion : undefined}
          section={motion ? (SECTIONS[motion.section ?? '']?.name ?? '') : ''}
          name={ch?.name ?? ''}
          en={ch?.en}
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
      </div>
      {mode !== 'overview' && (
        <Panel
          tabs={tabs}
          value={tab}
          onTab={onTab}
          label={side?.of === 'photo' ? '拍照' : ''}
          view={side ? 'character-settings' : undefined}
          pane={side ? undefined : pane}
          photo={side?.of === 'photo'}
        >
          {side ? (
            side.node
          ) : pane === 'motion' ? (
            <section className={styles.motions} aria-label="动作开关">
              {table}
            </section>
          ) : pane === 'chain' ? (
            <section aria-label="编排">{p.chains}</section>
          ) : pane === 'look' ? (
            <LookPane
              tab={lt}
              character={p.current}
              appearances={appearances}
              lookId={lookId}
              look={look}
              onWear={(l) => void wear(l)}
              layers={layers}
              onLayer={setLayer}
              mods={mods}
              ro={ro}
              toast={p.toast}
            />
          ) : (
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
        </Panel>
      )}
      <Rail value={at} avatar={canAvatar} onGo={(item) => (item === 'mmd' ? p.onMmd?.() : GO[item]())} />
      {!side && (pane === 'motion' || Object.keys(m.changed).length > 0) && (
        <Commit
          offline={p.offline}
          n={Object.keys(m.changed).length}
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
