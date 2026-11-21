// CharacterArt: the host's head / portrait when it has a URL, the page's placeholder without one or once the image fails.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { artSrc, CharacterArt, markArt } from '../../src/ui';

afterEach(cleanup);

const placeholder = <svg data-testid="placeholder" />;

describe('CharacterArt', () => {
  it('shows the host image, top-aligned for a head', () => {
    const { container } = render(<CharacterArt src="agentic-complex-ui://app/characters/cedar/head.png" kind="head" w={44} h={44} fallback={placeholder} />);
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe('agentic-complex-ui://app/characters/cedar/head.png');
    expect(img?.dataset.kind).toBe('head');
    expect([img?.getAttribute('width'), img?.getAttribute('height')]).toEqual(['44', '44']);
    expect(img?.getAttribute('alt')).toBe('');
    expect(screen.queryByTestId('placeholder')).toBeNull();
  });

  it('shows the placeholder without a URL', () => {
    const { container } = render(<CharacterArt kind="portrait" w={520} h={520} fallback={placeholder} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByTestId('placeholder')).toBeTruthy();
  });

  it('falls back to the placeholder when the image fails, and tries a new URL again', () => {
    const { container, rerender } = render(<CharacterArt src="agentic-complex-ui://app/characters/cedar/portrait.png" kind="portrait" w={520} h={520} fallback={placeholder} />);
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByTestId('placeholder')).toBeTruthy();
    rerender(<CharacterArt src="agentic-complex-ui://app/characters/dahlia/portrait.png" kind="portrait" w={520} h={520} fallback={placeholder} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('agentic-complex-ui://app/characters/dahlia/portrait.png');
  });
});

describe('CharacterArt with bundled art', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('loads no bundled art in a plain browser', () => {
    expect(artSrc('cedar', 'round')).toBeUndefined();
    const { container } = render(<CharacterArt kind="head" w={40} h={40} id="cedar" art="round" fallback={placeholder} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByTestId('placeholder')).toBeTruthy();
  });

  it('uses the host image first, then the bundled art, then the placeholder', () => {
    vi.stubEnv('VITE_EF_ART', '1');
    expect(artSrc('cedar', 'card')).toBe('art/characters/cedar/card.png');
    expect(artSrc(null, 'card')).toBeUndefined();
    const { container } = render(<CharacterArt src="agentic-complex-ui://app/characters/cedar/head.png" kind="head" w={44} h={44} id="cedar" art="card" fallback={placeholder} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('agentic-complex-ui://app/characters/cedar/head.png');
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('art/characters/cedar/card.png');
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByTestId('placeholder')).toBeTruthy();
  });
});

describe('markArt', () => {
  const probes: { src: string; onload: (() => void) | null; onerror: (() => void) | null }[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    probes.length = 0;
    delete document.documentElement.dataset.art;
  });
  const stubImage = () =>
    vi.stubGlobal(
      'Image',
      class {
        src = '';
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor() {
          probes.push(this);
        }
      },
    );

  it('marks the page only once the bundled emblem loads', () => {
    vi.stubEnv('VITE_EF_ART', '1');
    stubImage();
    markArt();
    expect(probes.map((p) => p.src)).toEqual(['art/brand/emblem.png']);
    expect(document.documentElement.dataset.art).toBeUndefined();
    probes[0]?.onload?.();
    expect(document.documentElement.dataset.art).toBe('');
  });

  it('leaves the page unmarked in an app built without art', () => {
    vi.stubEnv('VITE_EF_ART', '1');
    stubImage();
    markArt();
    probes[0]?.onerror?.();
    expect(document.documentElement.dataset.art).toBeUndefined();
  });
});
