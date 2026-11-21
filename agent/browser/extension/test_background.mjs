import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import * as helpers from "./lib.js";

const source = (await readFile(new URL("background.js", import.meta.url), "utf8")).replace(/^import .*;\n/, "");
const event = () => ({ listeners: [], addListener(f) { this.listeners.push(f); }, fire(...args) { this.listeners.forEach(f => f(...args)); } });
async function harness() {
  let now = 100000, focused = true, text = "First article", lastText = null, delayed = null, tabsDelayed = null, windowDelayed = null;
  const out = [], requests = [];
  const tab = { id: 1, windowId: 1, url: "https://example.com/private-path?secret=1", title: "Article", active: true, audible: false };
  let tabs = [tab];
  let policy = { type: "config", enabled: true, text_enabled: true, mode: "deny", domains: [], allow_domains: [], title_patterns: [] };
  const port = { onMessage: event(), onDisconnect: event(), postMessage(m) {
    if (m.type === "policy") queueMicrotask(() => port.onMessage.fire(policy)); else out.push(m);
  } };
  const chrome = {
    storage: { session: { get: async () => ({}), set: async () => {} } },
    runtime: { connectNative: () => port, onStartup: event(), onInstalled: event(), onMessage: event() },
    alarms: { create() {}, onAlarm: event() }, windows: { get: async () => windowDelayed || ({ focused, state: "normal" }), onFocusChanged: event() },
    tabs: { onActivated: event(), onUpdated: event(), onRemoved: event(), get: async () => ({ ...tab }),
      query: async q => q.active ? [{ ...tab }] : (tabsDelayed || tabs),
      sendMessage: async (_id, message) => {
        requests.push(message);
        if (!message.enabled) return null;
        if (delayed) return delayed;
        const result = { captured_at: now, scroll_percent: 25, max_scroll_percent: 50, media: null };
        if (message.text_enabled && (message.force_text || text !== lastText)) { result.text = text; lastText = text; }
        return result;
      },
    },
  };
  class Clock extends Date { static now() { return now; } }
  vm.runInNewContext(source, { ...helpers, chrome, Date: Clock, crypto: { randomUUID: () => "session" }, Map, RegExp });
  const flush = async () => { for (let i = 0; i < 20; ++i) await new Promise(setImmediate); };
  const emit = (type, extra = {}) => chrome.runtime.onMessage.fire({ type, captured_at: now, ...extra }, { tab: { ...tab }, url: tab.url, frameId: 0, documentId: "D1" });
  emit("hello"); await flush();
  return { out, requests, chrome, tab, port, flush, emit,
    tick: async (ms = 5000) => { now += ms; emit("sample"); await flush(); },
    setText: s => { text = s; }, focus: value => { focused = value; chrome.windows.onFocusChanged.fire(value ? 1 : -1); },
    setPolicy: p => { policy = { ...policy, ...p }; }, setTabs: t => { tabs = t; },
    delay: p => { delayed = p; }, delayTabs: p => { tabsDelayed = p; }, delayWindow: p => { windowDelayed = p; },
    advance: ms => { now += ms; }, now: () => now };
}

test("dynamic text revisions and empty content replace the current page without URL/title changes", async () => {
  const h = await harness();
  assert.equal(h.out.filter(m => m.type === "page").length, 0, "wait for dwell");
  await h.tick();
  const first = h.out.find(m => m.type === "page");
  assert.equal(first.text, "First article");
  h.setText("Updated article"); await h.tick();
  let pages = h.out.filter(m => m.type === "page");
  assert.equal(pages.at(-1).revision, first.revision + 1);
  assert.equal(pages.at(-1).text, "Updated article");
  h.setText(""); await h.tick();
  pages = h.out.filter(m => m.type === "page");
  assert.equal(pages.at(-1).text, "");
  assert.equal(pages.at(-1).revision, first.revision + 2);
  assert.equal(h.out.filter(m => m.type === "heartbeat").at(-1).revision, pages.at(-1).revision);
  await h.tick();
  assert.equal(h.out.filter(m => m.type === "page").length, pages.length, "unchanged content not duplicated");
  assert.equal(JSON.stringify(h.out).includes("private-path"), false);
});

test("blur closes the foreground interval and a delayed snapshot cannot leak into the new focus", async () => {
  const h = await harness(); await h.tick();
  let release;
  h.delay(new Promise(resolve => { release = resolve; }));
  h.emit("sample"); await h.flush();
  const before = h.out.filter(m => m.type === "metrics" || m.type === "page").length;
  h.focus(false); await h.flush();
  assert.equal(h.out.filter(m => m.type === "heartbeat").at(-1).window_focused, false);
  release({ text: "late stale text", scroll_percent: 90, max_scroll_percent: 90, media: null }); await h.flush();
  assert.equal(h.out.filter(m => m.type === "metrics" || m.type === "page").length, before);
  h.emit("selection", { text: "background selection" }); await h.flush();
  assert.equal(h.out.some(m => m.text === "background selection"), false);
});

test("sharing off keeps numeric telemetry but never asks the DOM for text", async () => {
  const h = await harness(); h.setPolicy({ text_enabled: false }); await h.tick();
  assert.equal(h.requests.at(-1).text_enabled, false);
  assert.equal(h.out.some(m => m.type === "page"), false);
  assert.ok(h.out.some(m => m.type === "metrics"));
  h.emit("selection", { text: "secret" }); await h.flush();
  assert.equal(h.out.some(m => m.type === "selection"), false);
});

test("blacklisted pages and paused policy disable DOM sampling, incognito tabs excluded from counts", async () => {
  const h = await harness();
  h.setTabs([h.tab, { ...h.tab, id: 2, incognito: true }, { ...h.tab, id: 3, url: "https://bank.test", audible: true }]);
  h.setPolicy({ domains: ["bank.test"] }); await h.tick();
  const metrics = h.out.filter(m => m.type === "metrics").at(-1).metrics;
  assert.equal(metrics.tab_count, 2);
  assert.equal(metrics.audible_tab_count, 0);
  h.setPolicy({ domains: ["example.com"] }); await h.tick();
  assert.equal(h.requests.at(-1).enabled, false);
  const count = h.out.filter(m => m.type === "metrics").length;
  h.setPolicy({ enabled: false }); await h.tick();
  assert.equal(h.requests.at(-1).enabled, false);
  assert.equal(h.out.filter(m => m.type === "metrics").length, count);
});

test("allow mode samples only allowed hosts, ignores the blacklist and still leaves incognito tabs out", async () => {
  const h = await harness();
  h.setTabs([h.tab, { ...h.tab, id: 2, incognito: true, audible: true }, { ...h.tab, id: 3, url: "https://bank.test", audible: true },
    { ...h.tab, id: 4, url: "https://m.example.com", audible: true }]);
  const sampled = () => h.out.filter(m => m.type === "page" || m.type === "metrics").length;
  const before = sampled();
  h.setPolicy({ mode: "allow", allow_domains: [] }); await h.tick(); await h.tick();
  assert.equal(h.requests.at(-1).enabled, false);
  assert.equal(h.out.filter(m => m.type === "heartbeat").at(-1).url_host, "<hidden>");
  assert.equal(sampled(), before);
  h.setPolicy({ mode: undefined, allow_domains: ["EXAMPLE.com"], domains: ["example.com"], title_patterns: ["Article"] });
  await h.tick(); await h.tick();
  assert.equal(h.requests.at(-1).enabled, true);
  assert.equal(h.out.filter(m => m.type === "page").at(-1).url_host, "example.com");
  assert.equal(h.out.filter(m => m.type === "metrics").at(-1).metrics.audible_tab_count, 1);
  h.emit("selection", { text: "allowed selection" }); await h.flush();
  assert.ok(h.out.some(m => m.type === "selection" && m.text === "allowed selection"));
});

test("a resumed timer requires dwell and fresh text; an asynchronous pre-sleep result is discarded", async () => {
  const h = await harness(); await h.tick();
  let release;
  h.delay(new Promise(resolve => { release = resolve; }));
  h.emit("sample"); await h.flush();
  const count = h.out.filter(m => m.type === "page" || m.type === "metrics").length;
  h.advance(90000);
  release({ text: "stale before sleep", scroll_percent: 90, max_scroll_percent: 90, media: null }); await h.flush();
  assert.equal(h.out.filter(m => m.type === "page" || m.type === "metrics").length, count);
  h.delay(null); await h.tick();
  assert.equal(h.requests.at(-1).text_enabled, false);
  await h.tick();
  assert.equal(h.out.filter(m => m.type === "page").length, 2, "unchanged text is refreshed after resume");
  assert.equal(h.out.some(m => m.text === "stale before sleep"), false);
});

test("policy pause and native reconnect cannot reuse a pre-pause dwell or text cache", async () => {
  const h = await harness(); await h.tick();
  h.setPolicy({ enabled: false, text_enabled: false }); await h.tick();
  h.setPolicy({ enabled: true, text_enabled: true }); await h.tick();
  assert.equal(h.requests.at(-1).text_enabled, false);
  await h.tick();
  assert.equal(h.out.filter(m => m.type === "page").length, 2);
  h.port.onDisconnect.fire(); await h.flush();
  h.chrome.alarms.onAlarm.fire({ name: "reconnect" }); await h.flush();
  await h.tick();
  assert.equal(h.requests.at(-1).text_enabled, false);
  await h.tick();
  assert.equal(h.out.filter(m => m.type === "page").length, 3);
});

test("incognito focus and subframe messages never produce text or numeric samples", async () => {
  const h = await harness(); await h.tick();
  const before = h.out.filter(m => m.type === "page" || m.type === "selection" || m.type === "metrics").length;
  const sender = { tab: h.tab, url: "https://embedded.example", frameId: 8, documentId: "CHILD" };
  for (const type of ["hello", "selection", "sample"]) h.chrome.runtime.onMessage.fire({ type, text: "FRAME_SECRET" }, sender);
  await h.flush();
  h.tab.incognito = true; await h.tick(); h.emit("selection", { text: "PRIVATE_SECRET" }); await h.flush();
  assert.equal(h.out.filter(m => m.type === "page" || m.type === "selection" || m.type === "metrics").length, before);
  assert.equal(h.out.filter(m => m.type === "heartbeat").at(-1).window_focused, false);
  assert.equal(h.out.some(m => /SECRET/.test(m.text || "")), false);
});

test("sleep during the final tab count or selection focus check cannot publish stale data", async () => {
  const h = await harness(); await h.tick();
  let release;
  h.delayTabs(new Promise(resolve => { release = resolve; }));
  h.emit("sample"); await h.flush();
  const count = h.out.filter(m => m.type === "metrics").length;
  h.advance(90000); release([h.tab]); await h.flush();
  assert.equal(h.out.filter(m => m.type === "metrics").length, count);
  h.delayTabs(null);
  h.delayWindow(new Promise(resolve => { release = resolve; }));
  h.emit("selection", { text: "pre-sleep selection" }); await h.flush();
  h.advance(90000); release({ focused: true, state: "normal" }); await h.flush();
  assert.equal(h.out.some(m => m.text === "pre-sleep selection"), false);
});

test("short IPC delays preserve the capture timestamp instead of relabeling old data as new", async () => {
  const h = await harness(); await h.tick();
  let release;
  h.delay(new Promise(resolve => { release = resolve; }));
  h.emit("sample"); await h.flush();
  const captured = h.now(); h.advance(4000);
  release({ captured_at: captured, text: "captured before a short sleep", scroll_percent: 50, max_scroll_percent: 50, media: null });
  await h.flush();
  assert.equal(h.out.filter(m => m.type === "page").at(-1).ts, captured / 1000);
  assert.equal(h.out.filter(m => m.type === "metrics").at(-1).ts, captured / 1000);
  h.emit("selection", { text: "captured selection", captured_at: captured }); await h.flush();
  assert.equal(h.out.filter(m => m.type === "selection").at(-1).ts, captured / 1000);
});
