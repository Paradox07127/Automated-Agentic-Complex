import type { PageRoute } from '../../shell/types';
import { catalogDemos, chartCatalog } from '../catalog';
import { DataVizPage } from './Page';

export const route = {
  id: 'dv',
  path: '/dv',
  title: '图表画廊',
  en: 'Data Viz',
  order: 910,
  group: 'dev',
  component: DataVizPage,
  demos: [
    { name: 'default', params: {} },
    { name: 'light', params: { theme: 'light' } },
    { name: 'loading', params: { state: 'loading' } },
    { name: 'empty', params: { state: 'empty' } },
    { name: 'error', params: { state: 'error' } },
    ...catalogDemos(chartCatalog),
  ],
} satisfies PageRoute;
