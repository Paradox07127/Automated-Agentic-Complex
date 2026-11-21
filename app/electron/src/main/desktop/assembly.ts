// The desktop panels this shell has (the bubble `#/bubble`, the hud `#/hud`, the ring `#/ring`,
// the command layer `#/cmd`, the console `#/console` and the status chip `#/chip`): the card source, each panel's `stack` bridge ops, `desktop.onState`, `desktop.onPresence`,
// `desktop.action` and `desktop.say`, the keyboard (`window.requestKey`, `releaseKey`), the 快速输入 hot key, the pointer
// resting on her, the mouse downs that close ring, tune and the console (`syncClickMonitors`), her
// lines' `noteLine` (`lineWatch`), and the follower that moves the panels after her.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BrowserWindow, globalShortcut, Notification, type Rectangle, type WebContents } from 'electron';
import { BridgeFailure, type Handler } from '../../common/bridge.ts';
import { desktopAction, type DesktopActionPorts } from '../../common/desktop-action.ts';
import { placementBox } from '../../common/desktop-anchor.ts';
import { type DesktopCommand, DesktopFollow } from '../../common/desktop-follow.ts';
import { AvatarHover } from '../../common/desktop-hover.ts';
import { DEFAULT_QUICK_INPUT_HOTKEY, QuickInputHotkey } from '../../common/desktop-hotkey.ts';
import type { CmdMode, PanelKind } from '../../common/desktop-layout.ts';
import { parseSay, say } from '../../common/desktop-say.ts';
import type { Cancel, EventSource, PageSession } from '../../common/page.ts';
import type { AvatarPlacement, Rect, ScreenInfo } from '../../common/placement.ts';
import { PushSource } from '../../common/push.ts';
import { type Notify, type Request, StackDecisions, StackSource, type StackSourceOptions } from '../../common/stack-source.ts';
import type { TurnMarks } from '../../common/turn-marks.ts';
import { configPathFromArgs, supportDirOf } from '../config.ts';
import { subscriptionId } from '../ops/events.ts';
import { sessionsRoute } from '../ops/open.ts';
import type { WebGuardPorts } from '../web-guard.ts';
import { OffsetFile } from './offsets.ts';
import { DesktopPanel, type Region } from './panel.ts';

export interface DesktopOptions {
  /** A panel window at `kind`'s overlay level (platform OVERLAY_LEVELS). */
  makeWindow(kind: PanelKind): BrowserWindow;
  /** The page URL for a hash route. */
  url(route: string): string;
  toDip(r: Rect): Rectangle;
  screens(): ScreenInfo[];
  /** The pointer in DIPs, and in the placement space. */
  cursorDip(): { x: number; y: number };
  mouse(): { x: number; y: number };
  register(contents: WebContents, page: PageSession, ops: ReadonlyMap<string, Handler<PageSession>>): void;
  unregister(id: number): void;
  /** The stack surface's ops every panel has (agentd, feed, avatar, …). */
  baseOps: ReadonlyMap<string, Handler<PageSession>>;
  request: Request;
  /** Gets the lines agentd took from `desktop.say`. */
  marks?: TurnMarks;
  /** The system notifications of the announcements. */
  notifier?: StackSourceOptions['notifier'];
  /** agentd's `/feed`, for the `announce`s and her `line`s. */
  feed: EventSource | null;
  /** HostLink.noteLine, at each `line` of `feed`. */
  noteLine?(): void;
  /** `listener` hears each mouse press of the user's, anywhere, until the returned function is called. */
  mouseDowns?(listener: () => void): () => void;
  notify(): Notify;
  /** Her body sample on the follower's clock (AvatarPlacer.anchorSample). */
  sample(): { now: number; body: Rect | null; bodyAt: number | null; visual: Rect | null; placement: AvatarPlacement | null; dragging: boolean };
  avatarHidden(): boolean;
  /** The front app is fullscreen in the attention sampler's last sample. */
  frontFullscreen(): boolean;
  /** Her character and appearance. */
  figure(): string | null;
  /** AvatarHover.tick's input now. */
  hover(): { present: boolean; hovered: boolean; hints: boolean };
  /** `desktop.onState`'s value now; its `avatarHovered` is `DesktopAssembly.avatarHovered`. */
  state(): Record<string, unknown>;
  /** The command layer's two, 复位浮窗, the sessions page and 去处理 are the assembly's own. */
  actions: Omit<DesktopActionPorts, 'quickInput' | 'cmdMode' | 'resetBoxes' | 'openSessions' | 'openStack'>;
  /** HostLink.sendPresent (C3 rule 39); false when it did not go out. Absent, no panel waits for her. */
  present?(token: string, side: string, phase: 'open' | 'close'): boolean;
  playSound(): void;
  confirm(text: string): Promise<boolean>;
  openMain(route: string): void;
  /** The pages' navigation, edit menu and error log guards; absent leaves them off. */
  guard?: WebGuardPorts;
  /** `window.onA11y`'s source; absent, the pages keep their defaults. */
  a11y?: EventSource;
  log(line: string): void;
}

const TICK_MS = 1000 / 30;
const PRESENCE_MS = 1000;
/** The web keeps its last presence through a short failure, and marks it offline once failures last this long. */
const PRESENCE_OFFLINE_MS = 3000;
/** A test run opens the command layer in this mode, or the console without a menu bar button, the given seconds (default 1)
 *  after its page is up, standing in for the hot key, the menus and the menu bar button. */
const TEST_COMMAND = /^--open-desktop-command=(ring|tune|input|console)(?:@(\d+))?$/;
/** The panels' user offsets, in the support dir. */
const OFFSETS_FILE = 'desktop-offsets.json';

export class DesktopAssembly {
  readonly source: StackSource;
  private readonly o: DesktopOptions;
  private readonly state = new PushSource('state');
  private readonly presence = new PushSource('presence', { volatile: ['sampled_at'] });
  private readonly command = new PushSource('command', { replay: false });
  /** The console page's `desktop.onCommand`; the other pages' commands never reach it, nor its theirs. */
  private readonly consoleCommand = new PushSource('command', { replay: false });
  private readonly panels: Record<PanelKind, DesktopPanel>;
  private readonly follow: DesktopFollow;
  private timer: ReturnType<typeof setInterval> | null = null;
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  private hoverTimer: ReturnType<typeof setInterval> | null = null;
  private readonly hover = new AvatarHover();
  private failingSince: number | null = null;
  /** While set, the follower's commands do not reach the pages. */
  private muted = false;
  private readonly hotkey: QuickInputHotkey;
  /** `--no-attention` (test and host runs) registers no hot key, so none is taken from the user. */
  private readonly hotkeyOn = !process.argv.includes('--no-attention');
  /** The stack went empty while its present closes: it hides at the close's end. */
  private stackCloses = false;
  /** The stack page's cards at the last push. */
  private stackCards = 0;
  private testCommand: { mode: CmdMode | 'console'; after: number } | null;
  /** The menu bar button the console last opened under (placement space). */
  private statusItem: Rect | null = null;
  private unlisten: Cancel[] = [];

  constructor(options: DesktopOptions) {
    this.o = options;
    this.source = new StackSource({ request: options.request, notify: options.notify, avatarHidden: options.avatarHidden,
      frontFullscreen: options.frontFullscreen, playSound: options.playSound, ...(options.notifier && { notifier: options.notifier }) });
    const panel = (kind: PanelKind, route: string, aliveOn: 'stack.onCards' | 'window.onAnchor') => {
      const p: DesktopPanel = new DesktopPanel({
        kind, route, url: options.url(route), aliveOn, makeWindow: () => options.makeWindow(kind), toDip: options.toDip,
        cursor: options.cursorDip, mouse: options.mouse, register: (contents, page) => options.register(contents, page, this.ops(p)),
        unregister: options.unregister, guard: options.guard, log: options.log,
      });
      p.onVisibility = () => {
        this.kick();
        this.source.visibilityChanged();
      };
      p.onUserMoved = (frame) => this.follow.userMoved(kind, frame);
      p.onResetOffset = () => {
        this.follow.resetOffset(kind);
        this.kick();
      };
      return p;
    };
    this.panels = { bubble: panel('bubble', '/bubble', 'window.onAnchor'), hud: panel('hud', '/hud', 'stack.onCards'),
      ring: panel('ring', '/ring', 'window.onAnchor'), cmd: panel('cmd', '/cmd', 'window.onAnchor'),
      console: panel('console', '/console', 'window.onAnchor'), chip: panel('chip', '/chip', 'window.onAnchor') };
    this.follow = new DesktopFollow(this.panels, options.log, (c) => {
      if (!this.muted) this.command.send(c);
    }, (c) => this.consoleCommand.send(c), new OffsetFile(join(supportDirOf(configPathFromArgs(process.argv)), OFFSETS_FILE), options.log));
    // Without the helper's mouse presses (no 输入监控 grant, `--no-attention`) ring, tune and the console still close when
    // their panel loses the keyboard. The console keeps open while the command layer it opened has the keyboard.
    this.panels.cmd.onBlur = () => {
      if (this.follow.cmdMode !== null && this.follow.cmdMode !== 'input') this.follow.close();
      if (!this.panels.console.isKey) this.follow.closeConsole();
      this.kick();
    };
    this.panels.console.onBlur = () => {
      if (this.follow.cmdMode === null) this.closeConsole();
    };
    this.hotkey = new QuickInputHotkey({
      register: (accelerator, pressed) => globalShortcut.register(accelerator, pressed),
      unregister: (accelerator) => globalShortcut.unregister(accelerator),
      log: options.log,
      notify: (title, body) => new Notification({ title, body }).show(),
    }, () => this.openQuickInput());
    const arg = process.argv.map((a) => TEST_COMMAND.exec(a)).find((m) => m !== null);
    this.testCommand = arg ? { mode: arg[1] as CmdMode | 'console', after: Number(arg[2] ?? 1) } : null;
    this.follow.onPresent = (token, side, open) => options.present?.(token, side, open ? 'open' : 'close') ?? false;
    this.follow.onPresentClosed = (kind) => this.presentClosed(kind);
    this.source.onPush = (ids) => this.pushed(ids);
    // The pages that show the cards.
    this.source.shown = () => this.panels.hud.isShown || this.panels.ring.isShown || this.panels.bubble.isShown;
    this.hover.onChange = () => this.state.send(this.o.state());
  }

  /** The pointer rests on her (after the dwell, through the grace). */
  get avatarHovered(): boolean { return this.hover.hovered; }

  /** The console is open in its own panel. */
  get consoleOpen(): boolean { return this.follow.consoleOpen; }

  /** 快速输入 is open in the bubble. */
  get quickInputOpen(): boolean { return this.follow.quickInputOpen; }

  /** The command layer's mode; null while it is closed. */
  get cmdMode(): CmdMode | null { return this.follow.cmdMode; }

  /** The command layer, the console or 快速输入 is open, or a shown panel has the keyboard: the user types in the hud, the
   *  console or 快速输入. */
  get typing(): boolean {
    return this.follow.cmdMode !== null || this.follow.consoleOpen || this.follow.quickInputOpen
      || Object.values(this.panels).some((p) => p.isShown && p.isKey);
  }

  /** `hotkey_quick_input`'s name when it did not register; null otherwise. */
  get quickInputFailed(): string | null { return this.hotkey.failed; }

  /** Loads the pages hidden; each shows once its page has something to show. */
  start(): void {
    for (const p of Object.values(this.panels)) p.start();
    if (this.hotkeyOn) this.hotkey.register(quickInputHotkey());
    this.presenceTimer ??= setInterval(() => void this.pollPresence(), PRESENCE_MS);
    this.hoverTimer ??= setInterval(() => this.hover.tick(this.o.hover(), performance.now() / 1000), TICK_MS);
    if (this.unlisten.length > 0) return;
    const { noteLine, mouseDowns } = this.o;
    if (noteLine && this.o.feed) this.unlisten.push(this.o.feed.subscribe(null, (e) => { if (e.event === 'line') noteLine(); }, () => {}));
    if (mouseDowns) this.unlisten.push(mouseDowns(() => this.mouseDown()));
  }

  /** `hotkey_quick_input` registers its new name; the hot keys in
   *  `desktop.onState` go out again. */
  hotkeySaved(key: string, name: string): void {
    if (key === 'hotkey_quick_input' && this.hotkeyOn) this.hotkey.update(name);
    this.state.send(this.o.state());
  }

  /** `desktop.onState` goes out now, not at the next presence poll. */
  pushState(): void {
    this.state.send(this.o.state());
  }

  /** A short line in the bubble, such as why a click on her asked nothing. */
  notice(text: string): void {
    this.command.send({ kind: 'notice', text });
  }

  /** Her `motion.stroke` (C3 rule 39). */
  stroke(token: string): void {
    this.follow.stroke(token);
    this.kick();
  }

  /** 去处理: the stack expands and leaves 历史 for the cards. */
  bringToFront(): void {
    this.command.send({ kind: 'expandStack' });
    this.source.focusNow();
    this.kick();
  }

  agentd(running: boolean): void {
    if (running) this.source.start(this.o.feed);
    else this.source.stop();
  }

  /** `app.action`'s `test_approval_card` and `test_announcement`; the sample goes through the 简短播报 mode like any brief. */
  testCard(kind: 'approval' | 'announcement'): boolean {
    if (kind === 'approval') return this.source.showTestApproval();
    return this.source.announce(JSON.stringify({ seq: -Date.now(), level: 'P2', kind: 'settings_test', headline: '这是一条测试播报' }));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    if (this.hoverTimer) clearInterval(this.hoverTimer);
    this.timer = this.presenceTimer = this.hoverTimer = null;
    for (const cancel of this.unlisten) cancel();
    this.unlisten = [];
    this.hotkey.stop();
    this.source.stop();
    for (const p of Object.values(this.panels)) p.stop();
  }

  /** 复位浮窗: every panel back to its default offset. */
  resetOffsets(): void {
    this.follow.resetOffsets();
    this.kick();
  }

  /** Opens the command layer. A layer the page closed itself left its last open command standing, so a close goes first and
   *  the page starts the mode afresh; `first` goes out just before the open. */
  open(mode: CmdMode, prefill?: string, first?: DesktopCommand): void {
    if (this.follow.cmdMode === null) this.command.send({ kind: 'close' });
    if (first) this.command.send(first);
    this.follow.open(mode, prefill);
    this.kick();
  }

  close(): void {
    this.follow.close();
    this.kick();
  }

  /** Opens the console under the menu bar button `statusItem` (placement space), leaving the command layer as it is; a close
   *  goes first for a console its page closed itself. */
  openConsole(statusItem: Rect | null): void {
    if (!this.follow.consoleOpen) this.consoleCommand.send({ kind: 'close' });
    this.statusItem = statusItem;
    this.follow.openConsole(statusItem);
    this.kick();
  }

  closeConsole(): void {
    this.follow.closeConsole();
    this.kick();
  }

  /** Opens 快速输入 in the bubble, closing the command layer and the console; `first` goes out just before the open. */
  openQuickInput(first?: DesktopCommand, prefill?: string): void {
    this.follow.openQuickInput(prefill, first);
    this.kick();
  }

  /** The bubble page put 快速输入 away (`window.releaseKey`). */
  closeQuickInput(): void {
    this.follow.closeQuickInput();
    this.kick();
  }

  /** The cmd page switched its open layer in place: the panel is placed by `mode`'s rules, and the page gets no command back. */
  switchMode(mode: CmdMode): void {
    if (this.follow.cmdMode === null) return;
    this.muted = true;
    this.follow.open(mode);
    this.muted = false;
    this.kick();
  }

  /** A press at the pointer closes the open console and the open ring or tune it is outside of.
   *  With the console open a press on the menu bar button is left to the button's click (`trayClick`), which closes it. */
  private mouseDown(): void {
    if (!this.follow.closesOnOutsideClick) return;
    const at = this.o.mouse(), s = this.statusItem;
    if (this.follow.consoleOpen && s && at.x >= s.x && at.x < s.x + s.w && at.y >= s.y && at.y < s.y + s.h) return;
    if (this.follow.consoleOpen && !this.panels.console.contains(at)) this.follow.closeConsole();
    const mode = this.follow.cmdMode;
    if (mode !== null && mode !== 'input' && !this.panels.cmd.contains(at)) this.follow.close();
    this.kick();
  }

  /** C3 rule 39: a hidden stack that gets an approval shows with her snap; once none waits the snap ends, and a stack left
   *  with no cards goes at its stroke. */
  private pushed(ids: string[]): void {
    this.stackCards = ids.length;
    const stack = this.panels.hud;
    const presenting = ids.some((id) => this.source.presents(id));
    if (presenting && !stack.isShown) this.follow.present('hud', randomUUID());
    else if (!presenting && this.follow.dismissPresent('hud') && ids.length === 0) this.stackCloses = true;
    if (this.stackCloses && ids.length === 0) return;
    this.stackCloses = false;
    stack.setCards(ids);
  }

  private presentClosed(kind: PanelKind): void {
    if (kind !== 'hud' || !this.stackCloses) return;
    this.stackCloses = false;
    this.panels.hud.setCards([]);
    this.panels.hud.close();
  }

  private async pollPresence(): Promise<void> {
    this.state.send(this.o.state());
    try {
      const reply = await this.o.request('GET', '/desktop/presence');
      if (reply.status !== 200) throw new Error(`HTTP ${reply.status}`);
      this.presence.send(JSON.parse(reply.body));
      this.failingSince = null;
    } catch {
      const now = Date.now();
      this.failingSince ??= now;
      if (now - this.failingSince >= PRESENCE_OFFLINE_MS) this.presence.send({ offline: true });
    }
  }

  /** One tick now, and the 30 Hz timer running while a panel shows. */
  private kick(): void {
    this.tick();
    if (!this.follow.wantsTicks || this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  /** The panels' pointer polls first, so the follower sees this tick's freeze. */
  private tick(): void {
    for (const p of Object.values(this.panels)) p.tick();
    const s = this.o.sample();
    this.follow.tick({
      body: s.body, bodyAt: s.bodyAt, hidden: this.o.avatarHidden(), frontFullscreen: this.o.frontFullscreen(), dragging: s.dragging, now: s.now,
      screens: this.o.screens(), placement: s.placement && placementBox(s.placement.x, s.placement.y, s.placement.scale),
      figure: this.o.figure(), visual: s.visual,
    }, this.o.mouse());
    if (!this.follow.wantsTicks && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One panel's `stack` and `desktop` ops over its own window, besides `baseOps`. */
  private ops(p: DesktopPanel): ReadonlyMap<string, Handler<PageSession>> {
    const decisions = new StackDecisions(this.source, this.o.request, this.o.confirm, () => p.lastRegionClick);
    const watch = (op: string, source: EventSource): Handler<PageSession> => ([id], page) => {
      page.subscribe(page.generation, op, subscriptionId(id), source, null);
      p.markAlive(op);
      const test = this.testCommand;
      const mode = test?.mode;
      if (test && mode && op === 'window.onAnchor' && p === this.panels[mode === 'input' ? 'bubble' : mode === 'console' ? 'console' : 'cmd']) {
        this.testCommand = null;
        setTimeout(() => (mode === 'input' ? this.openQuickInput() : mode === 'console' ? this.openConsole(null) : this.open(mode)), test.after * 1000);
      }
      return null;
    };
    const kind = (Object.keys(this.panels) as PanelKind[]).find((k) => this.panels[k] === p);
    const cardId = (id: unknown): string => {
      if (typeof id !== 'string' || id === '' || new TextEncoder().encode(id).length > 256) throw new BridgeFailure('invalid_args', 'card id');
      return id;
    };
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const own: [string, Handler<PageSession>][] = [
      ['window.onAnchor', watch('window.onAnchor', p.anchor)],
      ['window.onAnchorState', watch('window.onAnchorState', p.anchorState)],
      ['window.onVisibility', watch('window.onVisibility', p.visibility)],
      ['window.onPointer', watch('window.onPointer', p.pointer)],
      ...(this.o.a11y ? [['window.onA11y', watch('window.onA11y', this.o.a11y)] as [string, Handler<PageSession>]] : []),
      ['stack.onCards', watch('stack.onCards', this.source)],
      ['desktop.onState', watch('desktop.onState', this.state)],
      ['desktop.onPresence', watch('desktop.onPresence', this.presence)],
      ['desktop.onCommand', watch('desktop.onCommand', kind === 'console' ? this.consoleCommand : this.command)],
      ['window.setInteractiveRegions', ([list, glass]) => {
        if (!Array.isArray(list) || list.length > 32) throw new BridgeFailure('invalid_args', 'Region[] of up to 32');
        const regions: Region[] = list.map((r: Record<string, unknown>) => {
          const x = num(r?.x), y = num(r?.y), width = num(r?.width), height = num(r?.height);
          if (x === null || y === null || width === null || height === null || (r.drag != null && typeof r.drag !== 'boolean')) {
            throw new BridgeFailure('invalid_args', 'Region[] of up to 32');
          }
          return { x, y, width, height, drag: r.drag === true };
        });
        if (glass != null && !Array.isArray(glass)) throw new BridgeFailure('invalid_args', 'GlassRect[]');
        const rects: Rect[] = (glass ?? []).map((g: Record<string, unknown>) => {
          const x = num(g?.x), y = num(g?.y), w = num(g?.w), h = num(g?.h);
          if (x === null || y === null || w === null || h === null) throw new BridgeFailure('invalid_args', 'GlassRect[]');
          return { x, y, w, h };
        });
        p.setInteractiveRegions(regions, rects);
        this.kick();
        return null;
      }],
      ['window.setContentSize', ([s]) => {
        const o = s as Record<string, unknown> | null;
        const width = num(o?.width), height = num(o?.height);
        if (width === null || height === null || width <= 0 || height <= 0) {
          throw new BridgeFailure('invalid_args', '{width, height}, finite and positive');
        }
        p.setContentSize({ w: width, h: height });
        this.kick();
        return null;
      }],
      ['window.contentRect', () => p.contentRect()],
      ['window.close', () => {
        if (kind === 'cmd') this.close();
        else if (kind === 'console') this.closeConsole();
        else p.close();
        return null;
      }],
      ['window.requestKey', () => {
        p.requestKey();
        return null;
      }],
      // The command panel's release is its layer closed, the console's the console closed, the bubble's its 快速输入 put away.
      ['window.releaseKey', () => {
        if (kind === 'cmd') this.close();
        else if (kind === 'console') this.closeConsole();
        else if (kind === 'bubble') this.closeQuickInput();
        else p.releaseKey();
        return null;
      }],
      ['desktop.say', ([request]) => say(parseSay(request), this.o.request, this.o.log, this.o.marks)],
      ['window.openMain', ([route]) => {
        if (typeof route !== 'string') throw new BridgeFailure('invalid_args', 'a route');
        this.o.openMain(route);
        return null;
      }],
      ['window.logInfo', ([message]) => {
        if (typeof message !== 'string') throw new BridgeFailure('invalid_args', 'a message');
        this.o.log(`ui: ${message}`);
        return null;
      }],
      ['desktop.action', desktopAction({
        ...this.o.actions,
        quickInput: (scope) => this.openQuickInput(scope ? { kind: 'scope', ...scope } : undefined),
        cmdMode: (mode) => {
          // The console's switch to 行为与画面 opens it in the command panel and leaves the console open.
          if (mode === 'tune') return kind === 'console' ? this.open(mode) : this.switchMode(mode);
          // The ring first gets her screen, which `desktop.onState` does not follow as she walks.
          this.state.send(this.o.state());
          this.closeConsole();
          this.open(mode);
        },
        resetBoxes: () => {
          this.follow.resetOffsets();
          this.kick();
        },
        openSessions: () => this.o.openMain(sessionsRoute()),
        openStack: () => (this.stackCards === 0 ? this.notice('现在没有要处理的') : this.bringToFront()),
      })],
      ['stack.decide', ([id, decision, opts]) => {
        let d = decision;
        if (opts != null) {
          const o = opts as Record<string, unknown>;
          if (typeof o !== 'object' || (o.confirmed != null && typeof o.confirmed !== 'boolean')) throw new BridgeFailure('invalid_args', 'DecideOptions');
          if (o.confirmed === true && d && typeof d === 'object') d = { ...d, confirmed: true };
        }
        return decisions.decide(cardId(id), d);
      }],
      ['stack.later', ([id, minutes]) => decisions.later(cardId(id), minutes)],
      ['stack.collapse', ([id]) => { decisions.collapse(cardId(id)); return null; }],
      ['stack.complete', ([id]) => decisions.complete(cardId(id))],
    ];
    return new Map([...this.o.baseOps, ...own]);
  }
}

/** config.json's `hotkey_quick_input`, read once at start. */
function quickInputHotkey(): string {
  try {
    const v = (JSON.parse(readFileSync(configPathFromArgs(process.argv), 'utf8')) as Record<string, unknown>).hotkey_quick_input;
    return typeof v === 'string' ? v : DEFAULT_QUICK_INPUT_HOTKEY;
  } catch {
    return DEFAULT_QUICK_INPUT_HOTKEY;
  }
}
