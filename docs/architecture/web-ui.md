# 网页 UI

[English](web-ui.en.md) · [文档索引](../README.md)

## 概览

`web/` 是 React + TypeScript 写的界面，跑在 [Electron 外壳](shell.md)的窗口里。它有两个入口：控制面板 `main.html` 和桌面浮层 `stack.html`。在 app 里，页面经外壳注入的原生桥 `window.agenticComplex` 调外壳和 agentd；在浏览器里打开时，页面用假桥和 `src/mock/` 的数据。构建产物装进 web-ui 组件。构建和测试命令见[开发与发行](../development.md#网页)。

## 构建约束

- 发行构建用 PATH 上的 `node`（主版本 ≥ 24）。`node_modules` 不存在时先 `npm ci --ignore-scripts --prefer-offline`，再 `vite build --mode app`，平铺出 `main.html`、`stack.html` 和 `assets/`，装进 web-ui 组件的 `payload/ui/`。
- 产物里不能有 `data:font`：app 的 CSP 只许 `agentic-complex-ui:` 的字体，所以 `vite.config.ts` 设 `assetsInlineLimit: 0`，`tools/release/release.py` 构建后检查。

## URL 状态

主窗口是 hash 路由：`main.html#/<页面 id>?state=loading|empty|error&still=1&demo=<名>&theme=light|dark`。

- `useDemo()`（`src/shell/demo.ts`）读这 4 个参数，各页用它切演示状态。
- `still=1`：页面布局（`src/shell/Layout.tsx`）给 `<html>` 加 `still` 类冻结动画；假桥的 feed 不推事件。
- 主题默认跟随系统：`src/shell/useSystemTheme.ts` 读 `prefers-color-scheme` 和桥的外观事件，主窗口和桌面浮层都写 `<html data-theme>`。`theme=light|dark` 只给截图和调试用，优先于系统。
- `demo=palette` 打开 ⌘K 命令面板。
- 每页在 `route.ts` 的 `demos` 里列出可截图的状态（名字和 URL 参数），smoke 测试逐个打开并截图。

## 界面规则

- 主题跟随系统深浅，没有默认深色。两套主题各只有 4 级面色 `canvas / base / raised / overlay`，各配一个 `-fg`。
- 字号只用角色令牌（`font: var(--ef-t-…)`）：H1 18/26/600（页头，每页 1 个）、H2 15/22/600、H3 13/20/600 后接 [n]、正文 14/22、行标题 14/20/500、表格 13/20（数字 tnum 右对齐）、元信息 12/18 text-2、数字和键帽 11/14（只能是数字或拉丁字母）、等宽 12/18，大数字用数字字体（`--ef-font-num`，每页最多 2 处）。中文不小于 12px，任何文字不小于 11px；text-3 只给禁用和占位。
- 英文标签用 Title Case；只有模块根标题（如 `// SETTINGS`）全大写；中文字距 0。
- 间距只用 4 / 8 / 12 / 16 / 24 / 32 / 48：页边距 24，区块之间 32，区块内 16，行内 12，控件之间 8；2、6、20、40、64 只留给描边和图表内部。
- 面板直角、1px `line-subtle` 描边、不嵌套。阴影只给浮层（对话框、菜单、提示、下拉、桌面浮层），页内一律用描边。
- `#FFF100`（`--ef-accent`）只做主按钮、页签选中和焦点环；每个视图最多 1 个黄色主按钮。按钮是胶囊形，其余面板直角。
- 贴图：装饰贴图只写在 `:global(html[data-art])` 下，引用 `url('/art/common/<key>.png')`。`src/ui/CharacterArt.tsx` 在 app 带美术目录时给 `<html>` 加 `data-art`；没有美术的构建（包括公开版）显示 CSS 替身。要着色的单色贴图用 `mask` 加颜色令牌。

## 文字用量

- 说明句每块最多 1 行、不超过 30 字，只写会改变用户决定的信息；界面行为的说明放进 InfoTip（ⓘ）。
- 不上屏：issue 编号、「未核实」「需新增」「需要后端」、内部字段名、中英双语标签。缺数据显示「—」，悬停提示「后台暂不提供」。
- 空状态是一行原因加一个动作；空图表不画坐标轴。同一视图里同一事实只出现一次。
- 原始报告三段式（`features/trace/RawFold`）：不超过 3 行的摘要，然后是图或表，最后是折叠的原文（CodeBlock，预览不超过 20 行，带「全部 N 行」）。JSON 渲染成键值表；日志先显示各级别的条数。

## 检查

- `check:copy`（`scripts/check-copy.mjs`）扫 `src/pages`、`src/features`、`src/surfaces`、`src/ui`、`src/charts` 里能上屏的字符串（字符串字面量、JSX 文字、CSS `content:`），命中上面禁止上屏的内容就按 `文件:行` 列出并以 1 退出。
- `tests/e2e/style-guard.spec.ts` 在亮、暗两种系统外观下打开每个页面的全部 demo 和桌面浮层，检查：可见中文不小于 12px、任何文字不小于 11px；页内元素没有投影（`role=dialog/menu/tooltip`、`[data-overlay]` 和浮层卡片除外；无模糊、无偏移的描边环和内描边不算）；每个视图用 accent 作背景的可见元素不超过 2 个，可见的黄色主按钮不超过 1 个。`#/ds`、`#/dv` 只查字号和投影。新浮层加 `data-overlay` 才能带阴影。失败信息逐条列出 `<页面>-<demo>: <规则> <元素>`。
- `main.tsx` 把只读的路由清单挂在 `window.__EF_ROUTES__`（id、path、demos），smoke 测试从这里读各页的 demo。
- vitest 关掉了 `fsModuleCache`（`vite.config.ts`）：持久的转换缓存看不到新加进 `src/mock/index.ts` 的 `import.meta.glob` 的文件。

## 目录

```
main.html  stack.html        两个入口：主窗口；桌面浮层（透明底）
src/
  main.tsx  stack.tsx       两个入口的挂载脚本
  design/   tokens.json（令牌唯一来源） gen-tokens.ts  tokens.css（生成物，提交，不要手改） base.css
  bridge/   protocol.ts（桥接口和能力位，全部类型从这里导出） fake/（假桥） index.ts（getBridge） agentd.ts（agentd 请求）
  mock/     各页的 mock 端点，每页一个文件 <id>.ts；types.ts 是类型
  shell/    布局、命令栏、路由、⌘K 面板、useDemo、页面注册表
  pages/    <id>/route.ts + Page.tsx：home overview chat tasks schedules memory character observe pipeline trace tune diag settings onboarding
  dev/      ds（设计系统页）、dv（图表画廊）
  surfaces/ stack/（浮层卡片栈） desktop/（各桌面面板的根组件：bubble、hud、ring、cmd、console、chip 等）
  data/     跨页共享的 agentd 查询
  ui/       基础组件
  charts/   图表
  features/ 跨页复合件：approval kernel health delivery task plan trace
  domain/   状态联合类型、实体类型和时间格式等
  mock/fixtures/  共享的 mock 数据
tests/      unit/（vitest）  e2e/（Playwright）  route-contract.baseline.json
scripts/    check-size.mjs  check-copy.mjs  check-boundary.mjs  route-contract.ts
```

## 加页面

`src/shell/registry.ts` 用 `import.meta.glob` 收集 `src/pages/*/route.ts`（非 `app` 构建另收 `src/dev/*/route.ts`）。新页面只要建目录并导出 `route`（类型 `PageRoute`，见 `src/shell/types.ts`）：`id` 等于目录名，`path` 为 `/<id>`，另有 `title`（页头中文标题）、`en`（只给 ⌘K 搜索用，不上屏）、`order`、`group`、可选的 `hotkey`、`component` 和 `demos`。不用改任何共享文件。

## mock

假桥的 `agentd.request(method, path)` 按 method 和 path 模式（支持 `:name` 段）分发到处理函数。来源依次是 `src/bridge/fake/endpoints.ts` 的示例端点（如 `/health`、`/presence`）和 `src/mock/*.ts`；同一模式后注册的覆盖先注册的。

加 mock：新建 `src/mock/<页面 id>.ts`，导出 `routes: MockRoute[]`。`src/mock/index.ts` 自动收集，不用改。

```ts
import type { MockRoute } from './types';
export const routes: MockRoute[] = [
  { method: 'GET', path: '/agent/runs/:id', handler: ({ params, query }) => ({ status: 200, body: { id: params.id } }) },
];
```

共享的 mock 数据（`src/mock/fixtures/`）：

- 「现在」固定在 2026-10-29 14:32:10 本地时间（`NOW`）。时间都是本地时间的毫秒数，用 `at(h, m, s)` 写。
- 数据之间的约束由 `tests/unit/fixtures.test.ts` 检查，例如审批窗口不超过 55 s、`RUNS` 最多 50 条、valence 在 baseline ± 0.6 内、GPU 用毫秒、没有晚于 `NOW` 的时间。
- 同一事实只写一处，别处派生：`PENDING`（审批、提问和复核）是总览、任务待处理和桌面卡片栈的唯一来源；`FACT_COUNTS`、`ATTENTION_SUMMARY` 从源数据算出。
- 取单条用 `pick(LIST, id)` 和 `activeRunOf(taskId)`，找不到时抛错。

## 桥

- `getBridge()`：外壳注入了 `window.agenticComplex` 就用原生桥，否则用假桥。
- 原生能力只经桥拿。按 `bridge.capabilities` 的能力位降级（如 `screenCapture`、`nativeFilePicker`），不按平台名分支；不写 AppKit、macOS 路径或 WebKit 专有接口。

## 演示边界

演示代码是 `src/mock/**`、`src/dev/**`、`src/bridge/fake/**`、`*.demos.ts(x)` 和 `src/pages/*/demos.ts`。边界外的模块不许 import 边界内的模块（静态 import、`import type`、`import()` 和 `import.meta.glob` 都算），这样 `vite build --mode app` 打出的包里没有演示数据。页面时钟用 `src/bridge/clock.ts` 的 `appNow()`，假桥加载时把它钉在 fixtures 的 `NOW`。

`npm run check:boundary` 检查这条规则。固定的例外写在 `scripts/check-boundary.mjs` 里并注明理由；还没迁走的文件列在 `scripts/check-boundary.allow`，修好一个就删掉它那一行（已不再违规的条目也算失败）。

## 字体许可

Noto Sans SC（`@fontsource/noto-sans-sc`）和 Saira（`@fontsource-variable/saira`，带 wdth、wght 轴的可变字体）都是 SIL Open Font License 1.1，许可原文在各包的 `LICENSE`。Noto Sans SC 只引 400、500、600 三个字重；Saira 只引 `wdth.css`。字体都随构建打包，不走 Google Fonts。

## 路由契约

`npm --prefix web run check:routes` 检查网页发给 agentd 的每个「方法 + 路径」（`src/mock/*.ts` 的 mock 路由，以及 `src/` 里 `agentd.request` 和已知包装函数的字面路径）：都在 `protocol/ui-bridge/routes.json` 里、所属的类不被桥拒绝、发起的面板在 `surfaces` 里。有基线外的问题时以 1 退出。

已知问题记在 `tests/route-contract.baseline.json`。基线只能缩小：修好一条就从基线删掉（基线条目不再是问题时 `tests/unit/route-contract.test.ts` 也会失败），不要往里加新条目。
