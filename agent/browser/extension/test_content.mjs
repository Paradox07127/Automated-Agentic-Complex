import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
const source = await readFile(new URL("content.js", import.meta.url), "utf8");
function harness() {
  let receive, mutated, reads = 0, selected = "", media = [], selectionReads = 0;
  let tick, sendFailure = null, stoppedTimers = 0, disconnectedObservers = 0;
  const handlers = {}, sent = [];
  const runtime = { id: "test-extension", onMessage: {
    addListener: f => { receive = f; }, removeListener: () => {},
  }, sendMessage: m => {
    if (sendFailure === "sync") throw new Error("Extension context invalidated.");
    if (sendFailure === "async") return Promise.reject(new Error("Extension context invalidated."));
    if (sendFailure === "transient") return Promise.reject(new Error("Could not establish connection. Receiving end does not exist."));
    sent.push(m); return Promise.resolve();
  } };
  const element = excluded => ({ nodeType: 1, closest: () => excluded ? {} : null, checkVisibility: () => true });
  const article = element(false), input = element(true);
  const nodes = [
    { parentElement: article, get textContent() { reads++; return "Article one"; } },
    { parentElement: input, get textContent() { throw Error("must never read editor contents"); } },
  ];
  const document = {
    activeElement: article, visibilityState: "visible", documentElement: {}, body: article,
    scrollingElement: { scrollHeight: 2000, clientHeight: 1000, scrollTop: 250 },
    querySelector: () => article, querySelectorAll: selector => selector === "video, audio" ? media : [],
    createTreeWalker: (_root, _show, filter) => { let i = 0; return { nextNode() {
      while (i < nodes.length) { const node = nodes[i++]; if (filter.acceptNode(node) === 1) return node; } return null;
    } }; }, addEventListener: (event, f) => { handlers[event] = f; },
    removeEventListener: (event, f) => { if (handlers[event] === f) delete handlers[event]; },
  };
  vm.runInNewContext(source, { document, location: { href: "https://example.com" },
    NodeFilter: { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 },
    MutationObserver: class { constructor(f) { mutated = f; } observe() {} disconnect() { disconnectedObservers++; } },
    chrome: { runtime },
    setInterval(f) { tick = f; return 1; }, clearInterval() { stoppedTimers++; }, setTimeout: f => f(), getSelection: () => ({ anchorNode: article, focusNode: article,
      toString: () => { selectionReads++; return selected; }, rangeCount: 0 }),
  });
  return { document, handlers, sent, runtime, tick: () => tick(), fail: mode => { sendFailure = mode; },
    stoppedTimers: () => stoppedTimers, disconnectedObservers: () => disconnectedObservers,
    reads: () => reads, selectionReads: () => selectionReads,
    media: m => { media = m; }, selection: s => { selected = s; },
    snapshot: (enabled = true, text_enabled = false, force_text = false) => {
      let value; receive({ type: "snapshot", enabled, text_enabled, force_text }, {}, v => { value = v; }); return value;
    }, mutate: () => mutated([{ target: article }]),
  };
}

test("numeric-only sampling never reads text nodes or selection strings", () => {
  const h = harness();
  const result = h.snapshot();
  assert.equal(result.scroll_percent, 25);
  assert.equal(result.max_scroll_percent, 25);
  h.document.scrollingElement.scrollTop = 100;
  assert.equal(h.snapshot().max_scroll_percent, 25);
  h.selection("secret"); h.handlers.mouseup();
  assert.equal(h.reads(), 0);
  assert.equal(h.selectionReads(), 0);
  assert.equal(h.snapshot(false), null);
});

test("text extraction skips editors and only rereads after mutation or explicit refresh", () => {
  const h = harness();
  assert.equal(h.snapshot(true, true).text, "Article one");
  assert.equal(h.snapshot(true, true).text, undefined);
  assert.equal(h.reads(), 1);
  h.mutate(); h.snapshot(true, true);
  assert.equal(h.reads(), 2);
  assert.equal(h.snapshot(true, true, true).text, "Article one");
});

test("media sampling reads playback numbers without URLs, titles, subtitles or audio", () => {
  const h = harness();
  h.media([{ tagName: "VIDEO", paused: false, ended: false, readyState: 4, currentTime: 42.2,
    duration: 180.4, playbackRate: 1.5, muted: false,
    get src() { throw Error("private media URL"); }, get textContent() { throw Error("private captions"); } }]);
  const m = h.snapshot().media;
  assert.equal(m.state, "playing");
  assert.equal(m.position_s, 42);
  assert.equal(m.duration_s, 180);
  assert.deepEqual(Object.keys(m).sort(), ["duration_s", "kind", "muted", "playback_rate", "position_s", "state"]);
});

test("reload's synchronous context error is caught and the old script releases its observers", () => {
  const h = harness(); h.snapshot(true, true);
  const queuedMouseup = h.handlers.mouseup;
  const before = h.sent.length, reads = h.reads();
  h.fail("sync");
  assert.doesNotThrow(() => h.tick());
  assert.equal(h.stoppedTimers(), 1);
  assert.equal(h.disconnectedObservers(), 1);
  assert.deepEqual(Object.keys(h.handlers), []);
  assert.equal(h.snapshot(true, true, true), null);
  h.selection("must not read"); queuedMouseup(); h.tick();
  assert.equal(h.selectionReads(), 0);
  assert.equal(h.reads(), reads);
  assert.equal(h.sent.length, before);
});

test("missing runtime id stops the old script before reading selection or sending", () => {
  const h = harness(); h.snapshot(true, true);
  const before = h.sent.length;
  delete h.runtime.id;
  h.selection("must not read"); h.handlers.mouseup();
  assert.equal(h.selectionReads(), 0);
  assert.equal(h.sent.length, before);
  assert.equal(h.stoppedTimers(), 1);
});

test("asynchronous context invalidation also shuts down without an unhandled rejection", async () => {
  const h = harness(); h.fail("async"); h.tick();
  await new Promise(setImmediate);
  assert.equal(h.stoppedTimers(), 1);
  assert.equal(h.disconnectedObservers(), 1);
});

test("a transient receiver outage keeps the valid script available for the next sample", async () => {
  const h = harness(); h.fail("transient"); h.tick();
  await new Promise(setImmediate);
  assert.equal(h.stoppedTimers(), 0);
  h.fail(null); h.tick();
  assert.equal(h.sent.at(-1).type, "sample");
});
