import type { PageRoute } from '../../shell/types';
import { catalogDemos, featureCatalog, uiCatalog } from '../catalog';
import { DesignSystemPage } from './Page';

export const route = {
  id: 'ds',
  path: '/ds',
  title: '设计系统',
  en: 'Design System',
  order: 900,
  group: 'dev',
  component: DesignSystemPage,
  demos: [
    { name: 'default', params: {} },
    { name: 'light', params: { theme: 'light' } },
    { name: 'material', params: { sec: 'material' } },
    { name: 'material-light', params: { sec: 'material', theme: 'light' } },
    ...catalogDemos([...uiCatalog, ...featureCatalog]),
  ],
} satisfies PageRoute;
