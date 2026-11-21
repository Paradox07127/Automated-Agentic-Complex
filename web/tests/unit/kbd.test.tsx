import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { Kbd } from '../../src/ui';

afterEach(cleanup);

// Keycaps are 11px only for Latin and digits; a Chinese key name takes the 12px meta size.
it('marks keycaps that carry Chinese text', () => {
  const { container } = render(
    <>
      <Kbd>右⌥</Kbd>
      <Kbd>⌃⌥A</Kbd>
    </>,
  );
  const [cjk, latin] = [...container.querySelectorAll('kbd')];
  expect(cjk?.hasAttribute('data-cjk')).toBe(true);
  expect(latin?.hasAttribute('data-cjk')).toBe(false);
});
