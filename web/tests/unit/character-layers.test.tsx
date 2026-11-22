// skins-09w: 角色页「服装分层」每层一行开关，调 avatar.setLayers；导入的外观在外观行里标「导入」。
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../../src/bridge/fake';
import type { CharacterEntry, AgenticComplexBridge } from '../../src/bridge/protocol';
import { CHARACTER_LAYERS, CHARACTER_LOOKS, NOW } from '../../src/mock/fixtures';
import { MOTIONS, STATE_WITH_CAUSES } from '../../src/mock/character';
import { Operator, type OperatorProps } from '../../src/pages/character/Operator';

const lookChanged = vi.hoisted(() => vi.fn());
vi.mock('../../src/pages/character/usePreview', async (actual) => ({
  ...(await actual<typeof import('../../src/pages/character/usePreview')>()),
  previewLookChanged: lookChanged,
}));

const noop = () => {};
let bridge: AgenticComplexBridge;

beforeEach(() => {
  bridge = createFakeBridge({ surface: 'main', still: true });
  window.agenticComplex = bridge;
});
afterEach(() => {
  cleanup();
  delete window.agenticComplex;
  window.location.hash = '';
});

const si = (layers?: CharacterEntry['layers']): CharacterEntry => ({
  id: 'si', name: '示例乙', en: 'SI', active: true, appearances: CHARACTER_LOOKS.si ?? [], ...(layers ? { layers } : {}),
});

function Op(over: Partial<OperatorProps> = {}) {
  return (
    <Operator
      roster={[si(CHARACTER_LAYERS.map((l) => ({ ...l, visible: true })))]}
      current="si"
      sw={{ state: { phase: 'idle' }, request: noop, retry: noop, dismiss: noop }}
      offline={false}
      backoff={null}
      onRestart={noop}
      actions={MOTIONS}
      motionsError={null}
      onRetryMotions={noop}
      charState={STATE_WITH_CAUSES}
      toast={noop}
      pane="look"
      {...over}
    />
  );
}

describe('角色页 · 服装分层', () => {
  it('draws one switch row per layer and hides coat through avatar.setLayers', async () => {
    const set = vi.spyOn(bridge.avatar, 'setLayers');
    const toast = vi.fn();
    render(<Op toast={toast} />);
    fireEvent.click(screen.getByRole('tab', { name: '显示' }));
    const layer = (name: string) => within(screen.getByRole('group', { name: '服装分层' })).getByRole('switch', { name });
    expect(layer('披风').getAttribute('aria-checked')).toBe('true');
    expect(layer('外套').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(layer('外套'));
    await waitFor(() => expect(set).toHaveBeenCalledWith(['coat']));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('已隐藏「外套」'));
    expect(layer('外套').getAttribute('aria-checked')).toBe('false');
    // The stage preview shows again, so it draws her without the coat.
    expect(lookChanged).toHaveBeenCalledTimes(1);
  });

  it('has no layer options without layers', () => {
    render(<Op roster={[si()]} />);
    expect(screen.queryByRole('tab', { name: '显示' })).toBeNull();
    expect(screen.queryByRole('group', { name: '服装分层' })).toBeNull();
    expect(screen.queryByRole('switch', { name: '外套' })).toBeNull();
  });

  it('marks an imported appearance 导入 in the appearance rows', () => {
    render(<Op />);
    const opts = within(screen.getByRole('listbox', { name: '外观' })).getAllByRole('option').map((o) => o.textContent);
    expect(opts).toContain('夏装导入');
    expect(opts).toContain('日常');
    expect(opts).toContain('制服');
  });
});
