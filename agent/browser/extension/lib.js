// Pure helpers for background.js; tested with node (test_lib.mjs).
export const HEARTBEAT_MINUTES = 1;
export const PAGE_AFTER_MS = 5000;
export const TEXT_MAX = 2000;
export const HIDDEN = "<hidden>";

export function hostOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname : null;
  } catch {
    return null;
  }
}

function listed(host, domains) {
  const h = host.toLowerCase();
  return domains.some((d) => {
    const x = d.toLowerCase();
    return h === x || h.endsWith("." + x);
  });
}

// policy: { mode, domains, allow_domains }; any mode but "deny" shows only the allowed hosts.
export function blocked(host, policy) {
  if (!host) return false;
  return policy.mode === "deny" ? listed(host, policy.domains) : !listed(host, policy.allow_domains);
}

// ids: { browser_session, document_id, revision }; a missing one is sent as null.
function identity(tab, ids) {
  return {
    browser_session: ids.browser_session ?? null, tab_id: tab.id ?? null, document_id: ids.document_id ?? null,
    revision: ids.revision ?? null,
  };
}

export function heartbeat(tab, windowFocused, policy, nowMs, ids = {}) {
  const host = hostOf(tab.url);
  const hide = blocked(host, policy);
  return {
    type: "heartbeat", ts: nowMs / 1000, url_host: hide ? HIDDEN : host, title: hide ? null : tab.title || null,
    audible: Boolean(tab.audible), visible: windowFocused, window_focused: windowFocused, ...identity(tab, ids),
  };
}

// null when the page is not http(s), blacklisted, or the text is empty.
export function textMessage(kind, tab, text, policy, nowMs, ids = {}) {
  const host = hostOf(tab.url);
  if (!host || blocked(host, policy) || typeof text !== "string" || !text.trim()) return null;
  return {
    type: kind, ts: nowMs / 1000, url_host: host, title: tab.title || null, text: text.trim().slice(0, TEXT_MAX),
    ...identity(tab, ids),
  };
}

// null when the page is not http(s) or blacklisted.
export function clearedMessage(tab, policy, nowMs, ids = {}) {
  const host = hostOf(tab.url);
  if (!host || blocked(host, policy)) return null;
  return { type: "selection_cleared", ts: nowMs / 1000, url_host: host, title: tab.title || null, ...identity(tab, ids) };
}

// What background.js knows of a tab's document; a new URL or title on the same document is the next revision.
export function track(previous, documentId, url, title) {
  if (!previous || previous.document_id !== documentId) return { document_id: documentId, url, title, revision: 1 };
  if (previous.url === url && previous.title === title) return previous;
  return { ...previous, url, title, revision: previous.revision + 1 };
}

// Minutes before reconnect attempt n (0-based); chrome.alarms will not fire sooner than 30 s.
export function backoffMinutes(attempt) {
  return Math.min(0.5 * 2 ** attempt, 5);
}
