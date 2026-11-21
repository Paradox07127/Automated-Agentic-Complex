import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LineChart, type Pt } from '../../src/charts';

afterEach(cleanup);

const t0 = 1_000_000;
const t1 = t0 + 3_600_000;
const pts: Pt[] = Array.from({ length: 7 }, (_, i) => [t0 + i * 600_000, (i * 3) % 5]);

describe('LineChart event marks', () => {
  it('draws only the marks inside [t0, t1]', () => {
    const marks = [
      { t: t0 - 3_600_000, label: '任务出错' },
      { t: t0 + 1_800_000, label: '起床' },
      { t: t1 + 60_000, label: '之后' },
    ];
    const { container } = render(<LineChart label="状态" series={[{ id: 'e', label: '精神', pts }]} t0={t0} t1={t1} w={400} marks={marks} />);
    const texts = [...container.querySelectorAll('svg text')].map((t) => t.textContent);
    expect(texts).toContain('起床');
    expect(texts).not.toContain('任务出错');
    expect(texts).not.toContain('之后');
  });

  it('turns a label near the right edge inward', () => {
    const { container } = render(<LineChart label="状态" series={[{ id: 'e', label: '精神', pts }]} t0={t0} t1={t1} w={400} marks={[{ t: t1 - 30_000, label: '任务出错' }]} />);
    const t = [...container.querySelectorAll('svg text')].find((x) => x.textContent === '任务出错')!;
    expect(t.getAttribute('text-anchor')).toBe('end');
  });
});
