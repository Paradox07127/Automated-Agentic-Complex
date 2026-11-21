import { useId } from 'react';

/**
 * Accessible title and description of one chart drawing: spread `img` on the drawing and render `text` beside it.
 * Hidden HTML instead of SVG `<title>`, which browsers would show as a second tooltip over ChartTip.
 */
export function useChartLabel(title: string, desc: string) {
  const id = useId();
  const t = `${id}title`;
  const d = `${id}desc`;
  return {
    img: { role: 'img', 'aria-labelledby': t, 'aria-describedby': d } as const,
    text: (
      <span hidden>
        <span id={t} data-chart-title="">
          {title}
        </span>
        <span id={d} data-chart-desc="">
          {desc}
        </span>
      </span>
    ),
  };
}
