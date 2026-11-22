import { useEffect, useState } from 'react';
import { getBridge, type CharacterAppearance, type CharacterLayer } from '../../bridge';
import { OptionRow, SecHead, Slider } from '../../ui';
import type { Toast } from './feedback';
import { readModSettings } from './modSettingsTable';
import { ModSettings } from './ModSettings';
import type { useLook } from './useLook';
import styles from './Operator.module.css';

export type LookTab = 'look' | 'show' | 'mod';

export interface LookPaneProps {
  tab: LookTab;
  character: string;
  appearances: CharacterAppearance[];
  lookId: string;
  look: ReturnType<typeof useLook>;
  layers: CharacterLayer[];
  onLayer: (id: string, on: boolean, name: string) => void;
  /** Show the weapon switch (no host op yet: mock only). */
  weapon: boolean;
  /** Not running or switching: read only. */
  ro: boolean;
  toast: Toast;
}

const failed = (what: string, toast: Toast) => (e: unknown) => {
  const code = (e as { code?: string } | null)?.code;
  toast(`${what}没有完成：${code === 'not_implemented' ? '这个版本还不支持' : '桌面角色没有回应'}`, { severity: 'danger' });
};

/** Appearances of `character` that have a mod settings table; read only while `on`. */
export function useModLooks(character: string, on: boolean): ReadonlySet<string> {
  const [read, setRead] = useState<{ character: string; looks: Set<string> }>();
  useEffect(() => {
    if (!on || !character) return;
    let live = true;
    readModSettings(character).then(
      (t) => live && setRead({ character, looks: new Set(Object.keys(t.appearances).filter((id) => (t.appearances[id]?.settings.length ?? 0) > 0)) }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [character, on]);
  return read?.character === character ? read.looks : NONE;
}

const NONE: ReadonlySet<string> = new Set();

/** 外观的三个页签：外观（换外观、大小）、显示（服装分层）、模组设置；一按就换，亮起的是她现在的样子。 */
export function LookPane(p: LookPaneProps) {
  const [weaponOn, setWeaponOn] = useState(true);
  const setSize = (v: number) => {
    p.look.setScale(v);
    void getBridge()
      .avatar.setScale(v / 100)
      .catch(failed('改大小', p.toast));
  };
  return (
    <section className={styles.look} aria-label="角色外观与大小" data-g="bottomMenu" inert={p.ro || undefined} data-ro={p.ro || undefined}>
      {p.tab === 'look' && p.appearances.length > 0 && (
        <div>
          <SecHead no="01" title="外观" />
          <div className={styles.plates} role="listbox" aria-label="外观">
            {p.appearances.map((l) => (
              <OptionRow
                key={l.id}
                label={l.kind === 'imported' ? `${l.name}（导入）` : l.name}
                selected={l.id === p.lookId}
                onClick={() => {
                  getBridge()
                    .avatar.setAppearance(l.id)
                    .then(
                      () => {
                        p.look.setId(l.id);
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
      {p.tab === 'look' && (
        <div>
          <SecHead no="02" title="大小" right={<span className="num">{p.look.scale}%</span>} />
          <div className={styles.size}>
            <div className={styles.plates} role="listbox" aria-label="大小预设">
              {[75, 100, 125, 150].map((v) => (
                <OptionRow key={v} label={`${v}%`} selected={p.look.scale === v} onClick={() => setSize(v)} />
              ))}
            </div>
            <Slider label="大小" min={50} max={200} step={5} value={p.look.scale} defaultValue={100} unit="%" disabled={p.ro} onChange={setSize} />
          </div>
        </div>
      )}
      {p.tab === 'show' && (
        <div>
          <SecHead no="01" title="显示" />
          <div className={styles.plates} role="listbox" aria-multiselectable="true" aria-label="服装分层">
            {p.layers.map((l) => (
              <OptionRow key={l.id} label={l.name} selected={l.visible} onClick={() => p.onLayer(l.id, !l.visible, l.name)} />
            ))}
            {p.weapon && <OptionRow label="武器" selected={weaponOn} onClick={() => setWeaponOn(!weaponOn)} />}
          </div>
        </div>
      )}
      {p.tab === 'mod' && <ModSettings character={p.character} appearance={p.lookId} disabled={p.ro} toast={p.toast} />}
    </section>
  );
}
