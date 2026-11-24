import { backoffMinutes, blocked, clearedMessage, heartbeat, hostOf, textMessage, track } from "./lib.js";

const HOST = "local.agenticcomplex.agentd";
let port = null, attempt = 0, sequence = 0, docs = {}, browserSession = null;
let policy = { enabled: false, text_enabled: false, mode: "allow", domains: [], allow_domains: [], title_patterns: [] };
let activeKey = null, focusedSince = 0, lastHeartbeat = null;
let lastSampleAt = 0;
const pages = new Map(); // Last text only, never persisted; capped below.
const ready = chrome.storage.session.get(["browser_session", "docs"]).then(async got => {
  docs = got.docs || {};
  browserSession = got.browser_session || crypto.randomUUID();
  await chrome.storage.session.set({ browser_session: browserSession });
});
const ids = state => ({ browser_session: browserSession, document_id: state.document_id, revision: state.revision });
const send = message => { if (port && message) { try { port.postMessage(message); } catch {} } };
function hidden(tab) {
  return tab.incognito || !hostOf(tab.url) || blocked(hostOf(tab.url), policy) || policy.title_patterns.some(p => {
    try { return new RegExp(p).test(tab.title || ""); } catch { return true; }
  });
}
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return null;
  const win = await chrome.windows.get(tab.windowId);
  return { tab, focused: win.focused && win.state !== "minimized" && !win.incognito && !tab.incognito };
}
function see(tab, documentId = docs[tab.id]?.document_id ?? null) {
  const allowed = policy.enabled && !hidden(tab);
  const next = track(docs[tab.id], documentId, allowed ? tab.url : null, allowed ? tab.title : null);
  if (next !== docs[tab.id]) {
    docs[tab.id] = next;
    save();
  }
  return next;
}
function save() { chrome.storage.session.set({ docs }).catch(() => {}); }
function redactDocuments() {
  let changed = false;
  for (const [id, state] of Object.entries(docs)) {
    if (state.url && (!policy.enabled || hidden(state))) {
      docs[id] = track(state, state.document_id, null, null);
      changed = true;
    }
  }
  if (changed) save();
}
function requestSample() { ++sequence; send({ type: "policy" }); }

async function sample() {
  const seq = ++sequence;
  const started = Date.now();
  if (lastSampleAt && started - lastSampleAt > 15000) { activeKey = null; pages.clear(); }
  lastSampleAt = started;
  await ready;
  const active = await activeTab().catch(() => null);
  if (seq !== sequence || Date.now() - started > 15000) return;
  if (!active) {
    activeKey = null;
    if (policy.enabled && lastHeartbeat) send({ ...lastHeartbeat, ts: Date.now() / 1000, visible: false, window_focused: false });
    return;
  }
  const { tab, focused } = active;
  let state = see(tab);
  const key = `${tab.id}:${state.document_id}:${state.revision}`;
  const allowed = policy.enabled && focused && !hidden(tab);
  if (!allowed || activeKey !== key) { activeKey = allowed ? key : null; focusedSince = Date.now(); }
  // A nonfocused heartbeat closes the previous foreground interval immediately.
  const hb = heartbeat(tab, focused, policy, Date.now(), ids(state));
  if (hidden(tab)) { hb.url_host = "<hidden>"; hb.title = null; hb.audible = false; }
  lastHeartbeat = hb;
  if (policy.enabled) send(hb);
  const prior = pages.get(tab.id);
  const collectText = allowed && policy.text_enabled && Date.now() - focusedSince >= 5000;
  const force = !prior || prior.key !== key || Date.now() - prior.at >= 300000;
  const result = await chrome.tabs.sendMessage(tab.id, { type: "snapshot", enabled: allowed,
    text_enabled: collectText, force_text: force }, state.document_id ? { documentId: state.document_id } : {}).catch(() => null);
  const now = await activeTab().catch(() => null);
  if (seq !== sequence || Date.now() - started > 15000 || !allowed || !result || !now?.focused || now.tab.id !== tab.id || now.tab.url !== tab.url ||
      now.tab.title !== tab.title || state !== docs[tab.id]) return;
  // Preserve the actual read time across sleep/IPC delays so agentd can reject pre-wake data.
  const captured = result.captured_at;
  if (!Number.isFinite(captured) || captured < started || captured > Date.now()) return;
  if (collectText && typeof result.text === "string") {
    if (prior && prior.key === key && prior.text !== result.text) {
      state = docs[tab.id] = { ...state, revision: state.revision + 1 };
      save();
    }
    const nextKey = `${tab.id}:${state.document_id}:${state.revision}`;
    activeKey = nextKey;
    // Revision heartbeat must precede its text; empty revisions invalidate previous text too.
    send(heartbeat(tab, true, policy, captured, ids(state)));
    send({ type: "page", ts: captured / 1000, url_host: hostOf(tab.url), title: tab.title || null,
      text: result.text.slice(0, 2000), tab_id: tab.id, ...ids(state) });
    if (pages.size >= 100) pages.clear();
    pages.set(tab.id, { key: nextKey, text: result.text, at: Date.now() });
  }
  if (!policy.text_enabled) pages.clear();
  const tabs = await chrome.tabs.query({}).catch(() => []);
  if (seq !== sequence || Date.now() - started > 15000) return;
  send({ type: "metrics", ts: captured / 1000, url_host: hostOf(tab.url), title: tab.title || null,
    tab_id: tab.id, ...ids(state), metrics: {
      scroll_percent: result.scroll_percent, max_scroll_percent: result.max_scroll_percent, media: result.media,
      tab_count: tabs.filter(t => !t.incognito).length,
      audible_tab_count: tabs.filter(t => !t.incognito && t.audible && !hidden(t)).length,
    } });
}
function connect() {
  if (port) return;
  try { port = chrome.runtime.connectNative(HOST); } catch { port = null; schedule(); return; }
  port.onMessage.addListener(m => {
    if (m?.type !== "config") return;
    policy = { enabled: m.enabled === true, text_enabled: m.text_enabled === true, mode: m.mode === "deny" ? "deny" : "allow",
      domains: Array.isArray(m.domains) ? m.domains : [], allow_domains: Array.isArray(m.allow_domains) ? m.allow_domains : [],
      title_patterns: Array.isArray(m.title_patterns) ? m.title_patterns : [] };
    if (!policy.enabled || !policy.text_enabled) pages.clear();
    ready.then(redactDocuments);
    attempt = 0;
    sample().catch(() => {});
  });
  port.onDisconnect.addListener(() => { port = null; policy.enabled = false; activeKey = null; pages.clear(); ++sequence; schedule(); });
}
function schedule() {
  ready.then(redactDocuments);
  chrome.alarms.create("reconnect", { delayInMinutes: backoffMinutes(attempt++) });
}
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === "beat") requestSample(); if (alarm.name === "reconnect") connect(); });
chrome.tabs.onActivated.addListener(requestSample);
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (tab.active && (change.url || change.title || "audible" in change || change.status === "complete")) requestSample();
});
chrome.tabs.onRemoved.addListener(id => { delete docs[id]; pages.delete(id); save(); });
chrome.windows.onFocusChanged.addListener(requestSample);
chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || !sender.tab || sender.frameId !== 0) return;
  const received = Date.now();
  (async () => {
    await ready;
    if (message.type === "hello") {
      const tab = await chrome.tabs.get(sender.tab.id);
      if (tab.url === sender.url && !tab.incognito) { see(tab, sender.documentId); requestSample(); }
      return;
    }
    const active = await activeTab();
    if (!active || active.tab.id !== sender.tab.id || active.tab.url !== sender.tab.url) return;
    if (message.type === "sample") { requestSample(); return; }
    if (Date.now() - received > 15000 || !active.focused || !policy.enabled || !policy.text_enabled || hidden(active.tab) ||
        sender.documentId !== docs[sender.tab.id]?.document_id) return;
    const captured = message.captured_at;
    if (!Number.isFinite(captured) || captured > received || received - captured > 15000) return;
    const state = docs[sender.tab.id];
    if (message.type === "selection") send(textMessage("selection", active.tab, message.text, policy, captured, ids(state)));
    if (message.type === "selection_cleared") send(clearedMessage(active.tab, policy, captured, ids(state)));
  })().catch(() => {});
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.create("beat", { periodInMinutes: 1 });
connect();
