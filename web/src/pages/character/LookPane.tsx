import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { getBridge, type CharacterAppearance, type CharacterLayer, type ImportState } from '../../bridge';
import { AgentdCallError } from '../../bridge/agentd';
import { Btn, Dialog, Icon } from '../../ui';
import { DarkRow, GameSeg, MicroLabel, TitleBar, WhiteCapsule, YellowKey } from '../../ui/game';
import { useCompact } from './compact';
import type { Toast } from './feedback';
import { outfitImportWarning } from './labels';
import { readModSettings, type ModSettingRow } from './modSettingsTable';
import { ModSettings } from './ModSettings';
import { importStageLabel } from './useImportState';
import type { useLook } from './useLook';
import type { OutfitImport } from './useOutfitImport';
import imp from './LookImport.module.css';
import styles from './LookPane.module.css';

export type LookTab = 'look' | 'show' | 'mod' | 'import';

export interface LookPaneProps {
  tab: LookTab;
  character: string;
  appearances: CharacterAppearance[];
  lookId: string;
  look: ReturnType<typeof useLook>;
  /** Puts an appearance on her. */
  onWear: (l: CharacterAppearance) => void;
  layers: CharacterLayer[];
  onLayer: (id: string, on: boolean, name: string) => void;
  /** Shows every layer again. */
  onShowAll: () => void;
  /** The current appearance's mod switches; absent when it has no table. */
  mods: ModSettingRow[] | undefined;
  /** The switch table changed on disk since install (agentd's 409): no appearance has a 模组设置 tab. */
  modsUnreadable: boolean;
  /** Why it is read only (角色未运行, 切换中); null when it is not. */
  ro: string | null;
  outfit: OutfitImport;
  importing: ImportState;
  toast: Toast;
}

type ModLooks = Readonly<Record<string, ModSettingRow[]>>;

const failed = (what: string, toast: Toast) => (e: unknown) => {
  const code = (e as { code?: string } | null)?.code;
  toast(`${what}没有完成：${code === 'not_implemented' ? '这个版本还不支持' : '桌面角色没有回应'}`, { severity: 'danger' });
};

const NONE: ModLooks = {};

const switchesOf = (character: string) =>
  readModSettings(character).then((t): ModLooks => Object.fromEntries(Object.entries(t.appearances).filter(([, a]) => a.settings.length > 0).map(([id, a]) => [id, a.settings])));

/** agentd answers 409 when an installed file changed since install. */
const changedOnDisk = (e: unknown) => e instanceof AgentdCallError && e.status === 409;

/**
 * The mod switches of `character`'s appearances that have any, read once per character from the first time `on`; `reload` reads them again (after an import).
 * `unreadable` is true while the last read met a table changed on disk.
 */
export function useModTable(character: string, on: boolean): { looks: ModLooks; unreadable: boolean; reload: () => Promise<ModLooks> } {
  const [read, setRead] = useState<{ character: string; looks: ModLooks; unreadable: boolean }>();
  // Only the latest read lands; an older one finishing later does not replace it.
  const last = useRef(0);
  const have = read?.character === character;
  useEffect(() => {
    if (!on || !character || have) return;
    let live = true;
    const n = ++last.current;
    switchesOf(character).then(
      (looks) => live && n === last.current && setRead({ character, looks, unreadable: false }),
      (e: unknown) => live && n === last.current && changedOnDisk(e) && setRead({ character, looks: NONE, unreadable: true }),
    );
    return () => {
      live = false;
    };
  }, [character, on, have]);
  const reload = () => {
    const n = ++last.current;
    return switchesOf(character).then(
      (looks) => {
        if (n === last.current) setRead({ character, looks, unreadable: false });
        return looks;
      },
      (e: unknown) => {
        if (n === last.current && changedOnDisk(e)) setRead({ character, looks: NONE, unreadable: true });
        throw e;
      },
    );
  };
  return { looks: have ? read.looks : NONE, unreadable: have && read.unreadable, reload };
}

const SIZES = [75, 100, 125, 150];
const MIN = 50;
const MAX = 200;
const TICKS = [50, 75, 100, 125, 150, 175, 200];
/** outfit_tool's stages, then the shell's reload. */
const STAGES = ['read', 'compose', 'write', 'validate', 'publish', 'reload'];
const pad = (n: number) => String(n).padStart(2, '0');
const at = (v: number) => `${((v - MIN) / (MAX - MIN)) * 100}%`;

/** The last import, right under the tabs: what it was, how many switches it has, and each warning in words until 收起提示. */
function Landed({ outfit, switches }: { outfit: OutfitImport; switches: number | undefined }) {
  const l = outfit.landed;
  if (!l) return null;
  return (
    <>
      <div className={imp.landed} role="status">
        <span className={imp.landedTag}>
          刚导入
          <MicroLabel>New mod</MicroLabel>
        </span>
        <span className={imp.landedTx}>
          已导入<b>「{l.name}」</b>
          {switches != null && <span className={imp.wide}>，{switches} 个开关按类别排好</span>}
          {l.warnings.length > 0 && (
            <>
              {' │ '}
              <b className={imp.amber}>{l.warnings.length} 处导入提示</b>
            </>
          )}
        </span>
        <WhiteCapsule label="收起提示" icon="chev" tone="dark" onClick={outfit.dismiss} />
      </div>
      {l.warnings.length > 0 && (
        <ul className={imp.warns} aria-label={`「${l.name}」导入提示`}>
          {l.warnings.map((w, i) => (
            <li key={i}>
              <span className={imp.wix} aria-hidden="true">
                {pad(i + 1)}
              </span>
              <span>{outfitImportWarning(w)}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** 外观的四个页签：外观（换外观、删除导入的、大小）、显示（服装分层）、模组设置、导入（外观模组）；一按就换，亮起的是她现在的样子。 */
export function LookPane(p: LookPaneProps) {
  const { outfit, importing } = p;
  const compact = useCompact();
  const [removeLook, setRemoveLook] = useState<CharacterAppearance | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const setSize = (v: number) => {
    const was = p.look.scale;
    p.look.setScale(v);
    void getBridge()
      .avatar.setScale(v / 100)
      .catch((e: unknown) => {
        p.look.setScale(was);
        failed('改大小', p.toast)(e);
      });
  };
  const outfitBusy = outfit.state === 'busy' || outfit.removing;
  // The landed banner goes on 模组设置 when she wears the new appearance and it has switches, else on 外观.
  const landedOnMod = p.mods != null && outfit.landed?.id === p.lookId;
  const hidden = p.layers.filter((l) => !l.visible).length;
  const scale = p.look.scale;
  const keyOff = p.ro ?? (outfit.state === 'busy' ? null : outfitBusy ? '删除外观还没完成' : importing.running ? '另一个导入还没完成' : null);
  const stage = STAGES.indexOf(importing.stage ?? '');
  const pct = Math.round(importing.fraction * 100);

  return (
    <section className={styles.look} aria-label="角色外观与大小" data-g="bottomMenu" inert={p.ro != null || undefined} data-ro={p.ro != null || undefined}>
      {p.tab === 'look' && (
        <>
          {!landedOnMod && <Landed outfit={outfit} switches={undefined} />}
          {p.appearances.length > 0 && (
            <>
              <TitleBar title="外观" micro="Outfits" />
              <div className={styles.list} role="group" aria-label="外观">
                {p.appearances.map((l) => {
                  const worn = l.id === p.lookId;
                  const imported = l.kind === 'imported';
                  const sub = imported && p.modsUnreadable ? '设置表读不了：安装后文件被改过' : l.desc;
                  const removing = outfit.removing && removingId === l.id;
                  return (
                    <div key={l.id} className={styles.item} data-look={l.id} data-imported={imported || undefined}>
                      <DarkRow
                        compact={compact}
                        title={
                          <>
                            {l.name}
                            {imported && (
                              <span className={styles.modTag} data-on={worn || undefined}>
                                MOD
                              </span>
                            )}
                          </>
                        }
                        {...(sub ? { sub } : {})}
                        selected={worn}
                        onPress={() => p.onWear(l)}
                        end={
                          (worn || imported) && (
                            <>
                              {imported && (
                                <button
                                  type="button"
                                  className={styles.del}
                                  disabled={outfitBusy || importing.running}
                                  onClick={() => setRemoveLook(l)}
                                >
                                  {removing ? '删除中…' : '删除…'}
                                </button>
                              )}
                              {worn && (
                                <span className={styles.wearing}>
                                  <MicroLabel>Wearing</MicroLabel>
                                </span>
                              )}
                            </>
                          )
                        }
                      />
                    </div>
                  );
                })}
              </div>
            </>
          )}
          <TitleBar title="大小" micro="Scale" />
          <div className={styles.size} data-size-row="">
            <span className={styles.sizeLead} aria-hidden="true">
              SZ
            </span>
            <span className={styles.sizeMain}>
              <span className={styles.presets}>
                <GameSeg label="大小预设" options={SIZES.map((v) => ({ value: String(v), label: `${v}%` }))} value={String(scale)} onChange={(v) => setSize(Number(v))} />
              </span>
              <span className={styles.track} style={{ '--at': at(scale) } as CSSProperties}>
                <i className={styles.line} aria-hidden="true" />
                <i className={styles.fill} aria-hidden="true" />
                {TICKS.map((v) => (
                  <i key={v} className={styles.tick} data-major={v % 50 === 0 || undefined} style={{ left: at(v) }} aria-hidden="true" />
                ))}
                {TICKS.filter((v) => v % 50 === 0).map((v) => (
                  <button key={v} type="button" tabIndex={-1} className={styles.tl} style={{ left: at(v) }} aria-label={`大小 ${v}%`} onClick={() => setSize(v)}>
                    {v}
                  </button>
                ))}
                <input type="range" className={styles.range} aria-label="大小" min={MIN} max={MAX} step={5} value={scale} onChange={(e) => setSize(Number(e.target.value))} />
              </span>
              <output className={styles.yval}>
                <b>{scale}</b>%
              </output>
            </span>
          </div>
        </>
      )}
      {p.tab === 'show' && (
        <>
          <TitleBar
            title="服装分层"
            micro="Layers"
            count={p.layers.length}
            changed={hidden}
            changedLabel="隐藏"
            actions={<WhiteCapsule label="全部显示" icon="eye" disabled={hidden === 0} disabledReason="都已显示" onClick={p.onShowAll} />}
          />
          <div className={styles.list} role="group" aria-label="服装分层">
            {p.layers.map((l, i) => (
              <div key={l.id} data-layer={l.id}>
                <DarkRow
                  title={l.name}
                  lead={<span className={styles.idx}>{pad(i + 1)}</span>}
                  compact={compact}
                  end={
                    <GameSeg
                      label={l.name}
                      size={compact ? 'compact' : 'normal'}
                      options={[
                        { value: 'on', label: '显示' },
                        { value: 'off', label: '隐藏' },
                      ]}
                      value={l.visible ? 'on' : 'off'}
                      onChange={(v) => p.onLayer(l.id, v === 'on', l.name)}
                    />
                  }
                />
              </div>
            ))}
          </div>
        </>
      )}
      {p.tab === 'mod' && p.mods && (
        <>
          {landedOnMod && <Landed outfit={outfit} switches={p.mods.length} />}
          <ModSettings character={p.character} appearance={p.appearances.find((l) => l.id === p.lookId) ?? { id: p.lookId, name: p.lookId }} settings={p.mods} ro={p.ro} toast={p.toast} />
        </>
      )}
      {p.tab === 'import' && (
        <>
          <TitleBar title="导入外观模组" micro="Import / EFMI" />
          {getBridge().capabilities.nativeFilePicker && (
            <div className={imp.drop}>
              <YellowKey label={outfit.state === 'busy' || importing.kind === 'outfit' ? '导入中…' : '选择 mod 目录…'} icon="folder" micro="Select mod folder" disabled={outfit.state === 'busy' || keyOff != null} disabledReason={keyOff ?? '导入中'} onClick={outfit.run} />
              <span className={imp.dropTx}>
                <b>选择包含 mod.ini 的 mod 目录；只导入到本机</b>
                <span>导入完会自动穿上，有开关的直接打开「模组设置」</span>
              </span>
            </div>
          )}
          {importing.running && importing.kind === 'outfit' && (
            <div className={imp.prog} data-import-progress="">
              <div className={imp.progHd}>
                <Icon name="folder" size={16} />
                <span className={imp.fd}>{importing.title}</span>
                <MicroLabel>{`Stage ${stage + 1} / ${STAGES.length}`}</MicroLabel>
                <span className={imp.pct} aria-hidden="true">
                  {pct}
                  <small>%</small>
                </span>
              </div>
              <ol className={imp.chain} aria-hidden="true">
                {STAGES.map((s, i) => (
                  <li key={s} data-state={i < stage ? 'done' : i === stage ? 'cur' : undefined}>
                    <i />
                    {importStageLabel(s)}
                  </li>
                ))}
              </ol>
              <div className={imp.pbar} role="progressbar" aria-label={importStageLabel(importing.stage)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                <b style={{ width: `${pct}%` }} />
              </div>
              <div className={imp.ft}>
                <span>导入期间动作预览暂停</span>
                <span>完成后角色会重新载入一次</span>
              </div>
            </div>
          )}
        </>
      )}
      {removeLook && (
        <Dialog
          open
          title={`删除「${removeLook.name}」`}
          onClose={() => setRemoveLook(null)}
          footer={
            <>
              <Btn variant="secondary" onClick={() => setRemoveLook(null)}>
                取消
              </Btn>
              <Btn
                variant="danger"
                onClick={() => {
                  setRemoveLook(null);
                  setRemovingId(removeLook.id);
                  outfit.remove(removeLook.id, removeLook.name);
                }}
              >
                删除
              </Btn>
            </>
          }
        >
          <p>这个外观和它的模组设置都会删掉，角色包恢复成导入前的样子；角色会重新载入一次</p>
        </Dialog>
      )}
    </section>
  );
}
