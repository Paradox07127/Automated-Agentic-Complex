# Web UI

[简体中文](web-ui.md) · [Documentation index](../README.en.md)

## Overview

`web/` is the React + TypeScript UI that runs in the windows of the [Electron shell](shell.en.md). It has two entry points: the control panel `main.html` and the desktop panels `stack.html`. In the app, pages call the shell and agentd through the native bridge `window.agenticComplex` that the shell injects; opened in a browser, pages use the fake bridge and the data in `src/mock/`. The build output goes into the web-ui component. Build and test commands are in [development and releases](../development.en.md#web).

## Build constraints

- The release build uses the `node` on PATH (major version 24 or later). Without `node_modules` it first runs `npm ci --ignore-scripts --prefer-offline`, then `vite build --mode app`, which writes `main.html`, `stack.html` and `assets/` flat into the web-ui component's `payload/ui/`.
- The output must hold no `data:font`: the app's CSP allows fonts only from `agentic-complex-ui:`, so `vite.config.ts` sets `assetsInlineLimit: 0` and `tools/release/release.py` checks after the build.

## URL state

The main window uses hash routes: `main.html#/<page id>?state=loading|empty|error&still=1&demo=<name>&theme=light|dark`.

- `useDemo()` (`src/shell/demo.ts`) reads these four parameters; each page uses it to switch demo states.
- `still=1`: the page layout (`src/shell/Layout.tsx`) adds the `still` class to `<html>` to freeze animation; the fake bridge's feed sends no events.
- The theme follows the system by default: `src/shell/useSystemTheme.ts` reads `prefers-color-scheme` and the bridge's appearance events, and both the main window and the desktop panels write `<html data-theme>`. `theme=light|dark` is for screenshots and debugging only and wins over the system.
- `demo=palette` opens the ⌘K command palette.
- Each page lists its screenshot states (name and URL parameters) in `demos` in its `route.ts`; the smoke test opens and captures each one.

## Interface rules

- The theme follows the system's light or dark setting; there is no default dark theme. Each theme has only four surface levels `canvas / base / raised / overlay`, each with one `-fg`.
- Type sizes come only from role tokens (`font: var(--ef-t-…)`): H1 18/26/600 (page header, one per page), H2 15/22/600, H3 13/20/600 followed by [n], body 14/22, row title 14/20/500, table 13/20 (numbers tnum, right aligned), meta 12/18 text-2, numbers and keycaps 11/14 (digits or Latin letters only), monospace 12/18, and large numbers in the number font (`--ef-font-num`, at most two per page). Chinese text is never under 12px and no text is under 11px; text-3 is for disabled and placeholder text only.
- English labels use Title Case; only module root titles (such as `// SETTINGS`) are all caps; Chinese letter spacing is 0.
- Spacing uses only 4 / 8 / 12 / 16 / 24 / 32 / 48: page margin 24, between sections 32, inside a section 16, within a row 12, between controls 8; 2, 6, 20, 40 and 64 are only for strokes and chart internals.
- Panels have square corners and a 1px `line-subtle` stroke, and do not nest. Shadows are only for overlays (dialogs, menus, tooltips, dropdowns, desktop panels); in-page elements use strokes.
- `#FFF100` (`--ef-accent`) is only for primary buttons, the selected tab and the focus ring; each view has at most one yellow primary button. Buttons are pill shaped; other panels have square corners.
- Art: decorative images are written only under `:global(html[data-art])` and reference `url('/art/common/<key>.png')`. `src/ui/CharacterArt.tsx` adds `data-art` to `<html>` when the app carries an art directory; a build without art (the public one included) shows CSS stand-ins. Single-colour images that need tinting use `mask` with a colour token.

## Copy

- Explanatory text is at most one line per block and at most 30 characters, and only says what changes the user's decision; explanations of interface behaviour go into an InfoTip (ⓘ).
- Never on screen: issue numbers, 未核实 (unverified), 需新增 (to be added), 需要后端 (needs backend), internal field names, bilingual labels. Missing data shows 「—」 with the tooltip 后台暂不提供 (not provided by the backend yet).
- An empty state is one line of reason plus one action; an empty chart draws no axes. A fact appears only once in a view.
- Raw reports have three parts (`features/trace/RawFold`): a summary of at most three lines, then a chart or table, then the folded original (CodeBlock, preview of at most 20 lines, with 全部 N 行 (all N lines)). JSON renders as a key-value table; logs first show the count per level.

## Checks

- `check:copy` (`scripts/check-copy.mjs`) scans the on-screen strings (string literals, JSX text, CSS `content:`) in `src/pages`, `src/features`, `src/surfaces`, `src/ui` and `src/charts`; any banned content above is listed as `file:line` and the script exits 1.
- `tests/e2e/style-guard.spec.ts` opens every demo of every page and the desktop panels under both the light and dark system appearance and checks: visible Chinese text is at least 12px and all text at least 11px; in-page elements have no drop shadow (except `role=dialog/menu/tooltip`, `[data-overlay]` and panel cards; rings and inset strokes with no blur and no offset do not count); each view has at most two visible elements with an accent background and at most one visible yellow primary button. `#/ds` and `#/dv` are checked for type size and shadows only. A new overlay needs `data-overlay` to carry a shadow. Failures list `<page>-<demo>: <rule> <element>` one per line.
- `main.tsx` puts a read-only route list on `window.__EF_ROUTES__` (id, path, demos); the smoke test reads each page's demos from it.
- vitest turns off `fsModuleCache` (`vite.config.ts`): the persistent transform cache misses files newly matched by the `import.meta.glob` in `src/mock/index.ts`.

## Layout

```
main.html  stack.html        two entry points: the main window; the desktop panels (transparent background)
src/
  main.tsx  stack.tsx       mount scripts of the two entry points
  design/   tokens.json (the one token source) gen-tokens.ts  tokens.css (generated, committed, never hand-edited) base.css
  bridge/   protocol.ts (bridge interface and capability bits; every type is exported here) fake/ (fake bridge) index.ts (getBridge) agentd.ts (agentd requests)
  mock/     mock endpoints per page, one file <id>.ts each; types.ts holds the types
  shell/    layout, command bar, router, ⌘K palette, useDemo, page registry
  pages/    <id>/route.ts + Page.tsx: home overview chat tasks schedules memory character observe pipeline trace tune diag settings onboarding
  dev/      ds (design system page), dv (chart gallery)
  surfaces/ stack/ (panel card stack) desktop/ (root components of the desktop panels: bubble, hud, ring, cmd, console, chip and others)
  data/     agentd queries shared across pages
  ui/       base components
  charts/   charts
  features/ composites shared across pages: approval kernel health delivery task plan trace
  domain/   state unions, entity types, time formats and the like
  mock/fixtures/  shared mock data
tests/      unit/ (vitest)  e2e/ (Playwright)  route-contract.baseline.json
scripts/    check-size.mjs  check-copy.mjs  check-boundary.mjs  route-contract.ts
```

## Adding a page

`src/shell/registry.ts` collects `src/pages/*/route.ts` with `import.meta.glob` (and `src/dev/*/route.ts` outside the `app` build). A new page needs only its directory and an exported `route` (type `PageRoute`, see `src/shell/types.ts`): `id` equals the directory name, `path` is `/<id>`, plus `title` (the Chinese page header title), `en` (for ⌘K search only, never on screen), `order`, `group`, an optional `hotkey`, `component` and `demos`. No shared file changes.

## Mock

The fake bridge's `agentd.request(method, path)` dispatches by method and path pattern (`:name` segments allowed) to handlers. The sources are, in order, the example endpoints in `src/bridge/fake/endpoints.ts` (such as `/health` and `/presence`) and `src/mock/*.ts`; a later registration of the same pattern overrides an earlier one.

To add a mock, create `src/mock/<page id>.ts` and export `routes: MockRoute[]`. `src/mock/index.ts` collects it with no change.

```ts
import type { MockRoute } from './types';
export const routes: MockRoute[] = [
  { method: 'GET', path: '/agent/runs/:id', handler: ({ params, query }) => ({ status: 200, body: { id: params.id } }) },
];
```

Shared mock data (`src/mock/fixtures/`):

- "Now" is fixed at 2026-10-29 14:32:10 local time (`NOW`). Times are local milliseconds, written with `at(h, m, s)`.
- `tests/unit/fixtures.test.ts` checks the constraints between the data, for example approval windows of at most 55 s, at most 50 `RUNS`, valence within baseline ± 0.6, GPU in milliseconds, and no time after `NOW`.
- Each fact is written once and derived elsewhere: `PENDING` (approvals, questions and reviews) is the one source for the overview, pending tasks and the desktop card stack; `FACT_COUNTS` and `ATTENTION_SUMMARY` are computed from the source data.
- Pick single records with `pick(LIST, id)` and `activeRunOf(taskId)`, which throw when nothing matches.

## Bridge

- `getBridge()`: the native bridge when the shell injected `window.agenticComplex`, else the fake bridge.
- Native features come only through the bridge. Degrade by the capability bits in `bridge.capabilities` (such as `screenCapture` and `nativeFilePicker`), never by platform name; write no AppKit, macOS paths or WebKit-only APIs.

## Demo boundary

Demo code is `src/mock/**`, `src/dev/**`, `src/bridge/fake/**`, `*.demos.ts(x)` and `src/pages/*/demos.ts`. Modules outside the boundary may not import modules inside it (static imports, `import type`, `import()` and `import.meta.glob` all count), so the bundle from `vite build --mode app` holds no demo data. Page clocks use `appNow()` from `src/bridge/clock.ts`; the fake bridge pins it to the fixtures' `NOW` when it loads.

`npm run check:boundary` checks this rule. Fixed exceptions live in `scripts/check-boundary.mjs` with their reasons; files not yet moved are listed in `scripts/check-boundary.allow`; delete a file's line once it is fixed (an entry that no longer violates the rule also fails).

## Font licences

Noto Sans SC (`@fontsource/noto-sans-sc`) and Saira (`@fontsource-variable/saira`, a variable font with wdth and wght axes) are both under the SIL Open Font License 1.1; the licence text is in each package's `LICENSE`. Noto Sans SC is imported in the 400, 500 and 600 weights only; Saira only through `wdth.css`. Both ship with the build and never load from Google Fonts.

## Route contract

`npm --prefix web run check:routes` checks every method and path the web sends to agentd (the mock routes in `src/mock/*.ts`, and the literal paths of `agentd.request` and known wrappers in `src/`): each is in `protocol/ui-bridge/routes.json`, its class is not refused by the bridge, and the calling surface is in its `surfaces`. Any problem outside the baseline exits 1.

Known problems are listed in `tests/route-contract.baseline.json`. The baseline only shrinks: delete an entry once it is fixed (`tests/unit/route-contract.test.ts` also fails when a baseline entry is no longer a problem), and never add new entries.
