import { useEffect, useState } from 'react';
import { getBridge, type CharacterAppearance, type CharacterLayer } from '../../bridge';
import { Icon, Slider, Toggle } from '../../ui';
import type { Toast } from './feedback';
import { readModSettings, type ModSettingRow } from './modSettingsTable';
import { ModSettings } from './ModSettings';
import type { useLook } from './useLook';
import dark from './Rows.module.css';
import styles from './Operator.module.css';

export type LookTab = 'look' | 'show' | 'mod';

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
  /** The current appearance's mod switches; absent when it has no table. */
  mods: ModSettingRow[] | undefined;
  /** Not running or switching: read only. */
  ro: boolean;
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

/** The mod switches of `character`'s appearances that have any, read once per character from the first time `on`; `reload` reads them again (after an import). */
export function useModTable(character: string, on: boolean): { looks: ModLooks; reload: () => Promise<ModLooks> } {
  const [read, setRead] = useState<{ character: string; looks: ModLooks }>();
  const have = read?.character === character;
  useEffect(() => {
    if (!on || !character || have) return;
    let live = true;
    switchesOf(character).then(
      (looks) => live && setRead({ character, looks }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [character, on, have]);
  const reload = () =>
    switchesOf(character).then((looks) => {
      setRead({ character, looks });
      return looks;
    });
  return { looks: read?.character === character ? read.looks : NONE, reload };
}

const SIZES = [75, 100, 125, 150];

/** 外观的三个页签：外观（换外观、大小）、显示（服装分层）、模组设置；一按就换，亮起的是她现在的样子。 */
export function LookPane(p: LookPaneProps) {
  const setSize = (v: number) => {
    p.look.setScale(v);
    void getBridge()
      .avatar.setScale(v / 100)
      .catch(failed('改大小', p.toast));
  };
  return (
    <section className={styles.look} aria-label="角色外观与大小" data-g="bottomMenu" inert={p.ro || undefined} data-ro={p.ro || undefined}>
      {p.tab === 'look' && p.appearances.length > 0 && (
        <div className={dark.list} role="listbox" aria-label="外观">
          {p.appearances.map((l) => (
            <button key={l.id} type="button" role="option" aria-selected={l.id === p.lookId} className={dark.row} onClick={() => p.onWear(l)}>
              <span className={dark.lead}>{l.id === p.lookId && <Icon name="check" size={16} />}</span>
              <span className={dark.main}>
                <span className={dark.nm}>{l.name}</span>
                {l.kind === 'imported' && <span className={dark.tag}>导入</span>}
              </span>
            </button>
          ))}
        </div>
      )}
      {p.tab === 'look' && (
        <div className={dark.row}>
          <span className={dark.lead} />
          <span className={dark.main}>
            <span className={dark.nm}>大小</span>
            <span className={styles.presets} role="listbox" aria-label="大小预设">
              {SIZES.map((v) => (
                <button key={v} type="button" role="option" aria-selected={p.look.scale === v} className={styles.preset} onClick={() => setSize(v)}>
                  {v}%
                </button>
              ))}
            </span>
            <span className={styles.slider}>
              <Slider label="大小" min={50} max={200} step={5} value={p.look.scale} defaultValue={100} unit="%" disabled={p.ro} onChange={setSize} />
            </span>
          </span>
        </div>
      )}
      {p.tab === 'show' && (
        <div className={dark.list} role="group" aria-label="服装分层">
          {p.layers.map((l) => (
            <div key={l.id} className={dark.row} data-layer={l.id}>
              <span className={dark.lead} />
              <span className={dark.main}>
                <span className={dark.nm}>{l.name}</span>
                <span className={dark.end}>
                  <Toggle size="sm" label={l.name} on={l.visible} onChange={(on) => p.onLayer(l.id, on, l.name)} />
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
      {p.tab === 'mod' && p.mods && <ModSettings character={p.character} appearance={p.lookId} settings={p.mods} disabled={p.ro} toast={p.toast} />}
    </section>
  );
}
