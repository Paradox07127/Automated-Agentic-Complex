// ui/game ExitKey: the menu bar popover's 退出, a small capsule key with the power mark.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExitKey } from '../../src/ui/game';

afterEach(cleanup);

const css = readFileSync(resolve(__dirname, '../../src/ui/game/ExitKey.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (sel: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => (m[1] ?? '').trim() === sel)?.[2] ?? null;

describe('ExitKey', () => {
  it('is a button named by its label, with the power mark hidden from screen readers', () => {
    const onClick = vi.fn();
    render(<ExitKey onClick={onClick} />);
    const key = screen.getByRole('button', { name: '退出' });
    expect(key.closest('[data-stub="ExitKey"]')).not.toBeNull();
    expect(key.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(key);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('takes another label for screen readers and its text', () => {
    render(<ExitKey label="退出 Agentic Complex" onClick={() => {}} />);
    expect(screen.getByRole('button', { name: '退出 Agentic Complex' }).textContent).toBe('退出 Agentic Complex');
  });

  it('is a capsule whose only shadow is --ef-shadow-btn, and sinks onto it when pressed', () => {
    expect(rule('.key')).toMatch(/border-radius:\s*999px/);
    expect(rule('.key')).toMatch(/height:\s*24px/);
    const shadows = [...css.matchAll(/box-shadow:\s*([^;]+);/g)].map((m) => m[1]!.trim());
    expect(shadows.filter((s) => s !== 'none')).toEqual(['var(--ef-shadow-btn)']);
    const down = rule('.key:active') ?? '';
    expect(down).toMatch(/translate:\s*1px 1px/);
    expect(down).toMatch(/box-shadow:\s*none/);
  });

  it('draws with tokens only, so both themes follow', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
});
