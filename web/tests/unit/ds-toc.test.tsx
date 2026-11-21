import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chartCatalog, featureCatalog, uiCatalog } from '../../src/dev/catalog';
import { CatalogToc } from '../../src/dev/CatalogToc';

afterEach(cleanup);

describe('ds table of contents', () => {
  it('groups every entry under ui, charts and features', () => {
    render(<CatalogToc ui={uiCatalog} charts={chartCatalog} features={featureCatalog} />);
    const nav = screen.getByRole('navigation', { name: '目录' });
    for (const [label, entries] of [['ui', uiCatalog], ['charts', chartCatalog], ['features', featureCatalog]] as const) {
      const list = within(nav).getByRole('list', { name: label });
      expect(within(list).getAllByRole('listitem')).toHaveLength(entries.length);
    }
  });

  it('links charts to #/dv and scrolls to an in-page entry', () => {
    render(
      <>
        <CatalogToc ui={uiCatalog} charts={chartCatalog} features={featureCatalog} />
        <section data-component="Btn" />
      </>,
    );
    expect(screen.getByRole('link', { name: 'Sparkline' }).getAttribute('href')).toBe('#/dv?c=Sparkline');
    const section = document.querySelector<HTMLElement>('[data-component="Btn"]');
    const scroll = vi.fn();
    if (section) section.scrollIntoView = scroll;
    fireEvent.click(screen.getByRole('button', { name: 'Btn' }));
    expect(scroll).toHaveBeenCalledTimes(1);
  });
});
