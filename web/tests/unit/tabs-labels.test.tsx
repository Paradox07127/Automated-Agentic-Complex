import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SetNav } from '../../src/pages/settings/SetNav';
import { SETTING_GROUPS } from '../../src/pages/settings/groups';
import { isGroup, type GroupId } from '../../src/pages/settings/registry';
import { Tabs } from '../../src/ui';
import { pluginsOn, pluginsReset } from './plugins';

// Every plug-in on, so every group has its tab.
beforeEach(() => pluginsOn());
afterEach(() => {
  cleanup();
  pluginsReset();
});

const src = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');
const css = readFileSync(resolve(src, 'ui/Tabs.module.css'), 'utf8');
const tokens = readFileSync(resolve(src, 'design/tokens.css'), 'utf8');
const LABELS = SETTING_GROUPS.filter((g) => isGroup(g.id)).map((g) => g.label);

function Nav({ marks = {} }: { marks?: Partial<Record<GroupId, string>> }) {
  const [group, setGroup] = useState<GroupId>('privacy');
  return <SetNav group={group} searching={false} marks={marks} drafts={[]} onGroup={setGroup} />;
}

/** Declarations of every rule whose selector list contains `sel` exactly. */
function rules(sel: string): string[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1]!.split(',').some((s) => s.trim() === sel))
    .map((m) => m[2]!);
}

describe('icon tabs show their names', () => {
  it('writes each name as visible text in its cell, not only in a tooltip', () => {
    render(<Nav />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('data-tab'))).toHaveLength(LABELS.length);
    tabs.forEach((tab, i) => {
      const name = within(tab).getByText(LABELS[i]!);
      expect(name.closest('[aria-hidden="true"]')).toBeNull();
      expect(tab.getAttribute('aria-label')).toBeNull();
    });
    // The name is not clipped away for icon cells, and it is set at 11 px or more.
    const icon = rules('.tab[data-icon] .name').join('');
    expect(icon).not.toMatch(/clip-path|width:\s*1px|font-size:\s*0/);
    const size = /font(?:-size)?:[^;]*var\((--ef-fs-[\w-]+)\)/.exec(icon)?.[1];
    expect(size).toBeDefined();
    const px = Number(new RegExp(`${size}:\\s*(\\d+(?:\\.\\d+)?)px`).exec(tokens)?.[1]);
    expect(px).toBeGreaterThanOrEqual(11);
  });

  it('moves aria-selected with the pick, by click and by Q / E', () => {
    render(<Nav />);
    const selected = () => screen.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.getAttribute('data-tab'));
    expect(selected()).toEqual(['privacy']);
    fireEvent.click(screen.getByRole('tab', { name: /能做/ }));
    expect(selected()).toEqual(['perm']);
    cleanup();

    render(<Tabs label="页签" value="a" tabs={[{ id: 'a', label: '甲', icon: 'play' }, { id: 'b', label: '乙', icon: 'look' }]} />);
    const on = () => screen.getAllByRole('tab').map((t) => t.getAttribute('aria-selected'));
    expect(on()).toEqual(['true', 'false']);
    fireEvent.keyDown(window, { key: 'e' });
    expect(on()).toEqual(['false', 'true']);
    fireEvent.keyDown(window, { key: 'q' });
    expect(on()).toEqual(['true', 'false']);
  });

  it('explains the ◆ mark when the cell is hovered, and keeps the bare name as the tab title', () => {
    render(<Nav marks={{ perm: '辅助功能、屏幕录制未允许' }} />);
    const perm = screen.getByRole('tab', { name: /能做/ });
    expect(perm.getAttribute('title')).toBe('能做');
    expect(within(perm).getByText('能做').closest('[title]')?.getAttribute('title')).toBe('能做：辅助功能、屏幕录制未允许');
    expect(perm.querySelector('svg')?.closest('[title]')?.getAttribute('title')).toBe('能做：辅助功能、屏幕录制未允许');
    const data = screen.getByRole('tab', { name: /^数据/ });
    expect(within(data).getByText('数据').closest('[title]')).toBe(data);
  });
});
