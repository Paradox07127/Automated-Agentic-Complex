import assert from "node:assert/strict";
import test from "node:test";
import { backoffMinutes, blocked, clearedMessage, heartbeat, hostOf, textMessage, track } from "./lib.js";

const tab = { id: 7, url: "https://github.com/me/repo?x=1", title: "PR", audible: true };
const ids = { browser_session: "S1", document_id: "D1", revision: 2 };
const nulls = { browser_session: null, tab_id: 7, document_id: null, revision: null };
const deny = domains => ({ mode: "deny", domains, allow_domains: [] });

test("hostOf keeps only the host of http(s) pages", () => {
  assert.equal(hostOf("https://github.com/me/repo?x=1#y"), "github.com");
  assert.equal(hostOf("chrome://settings"), null);
  assert.equal(hostOf("not a url"), null);
});

test("blocked matches the host or a subdomain only", () => {
  assert.equal(blocked("mybank.icbc.com.cn", deny(["icbc.com.cn"])), true);
  assert.equal(blocked("noticbc.com.cn", deny(["icbc.com.cn"])), false);
  assert.equal(blocked(null, deny(["icbc.com.cn"])), false);
});

test("allow mode blocks every host but the allowed ones and their subdomains; a missing mode is allow", () => {
  const allow = { mode: "allow", domains: ["github.com"], allow_domains: ["GitHub.com"] };
  assert.equal(blocked("gist.github.COM", allow), false);
  assert.equal(blocked("github.com", allow), false);
  assert.equal(blocked("notgithub.com", allow), true);
  assert.equal(blocked("example.com", allow), true);
  assert.equal(blocked("github.com", { domains: [], allow_domains: [] }), true);
  assert.equal(blocked("github.com", { domains: [], allow_domains: ["github.com"] }), false);
  assert.equal(heartbeat(tab, true, { ...allow, allow_domains: [] }, 0).url_host, "<hidden>");
  assert.equal(textMessage("page", tab, "x", allow, 0).url_host, "github.com");
  assert.equal(textMessage("page", tab, "x", { ...allow, allow_domains: ["example.com"] }, 0), null);
  assert.equal(clearedMessage(tab, { ...allow, allow_domains: [] }, 0), null);
});

test("heartbeat carries no URL path and hides blacklisted hosts", () => {
  const beat = heartbeat(tab, true, deny([]), 1792300000000);
  assert.deepEqual(beat, { type: "heartbeat", ts: 1792300000, url_host: "github.com", title: "PR", audible: true,
                           visible: true, tab_id: 7, window_focused: true, ...nulls });
  const hidden = heartbeat({ ...tab, url: "https://mybank.icbc.com.cn/a" }, true, deny(["icbc.com.cn"]), 0);
  assert.equal(hidden.url_host, "<hidden>");
  assert.equal(hidden.title, null);
});

test("textMessage drops blacklisted, non-http and empty text and caps length", () => {
  assert.equal(textMessage("page", { ...tab, url: "https://icbc.com.cn/" }, "x", deny(["icbc.com.cn"]), 0), null);
  assert.equal(textMessage("page", { ...tab, url: "file:///a" }, "x", deny([]), 0), null);
  assert.equal(textMessage("selection", tab, "   ", deny([]), 0), null);
  assert.equal(textMessage("page", tab, "长".repeat(3000), deny([]), 0).text.length, 2000);
});

test("every message carries the browser, tab, document and revision", () => {
  const want = { browser_session: "S1", tab_id: 7, document_id: "D1", revision: 2 };
  const beat = heartbeat(tab, true, deny([]), 0, ids);
  const page = textMessage("page", tab, "x", deny([]), 0, ids);
  const cleared = clearedMessage(tab, deny([]), 1792300000000, ids);
  for (const m of [beat, page, cleared]) assert.deepEqual({ ...m, ...want }, m);
  assert.deepEqual(cleared, { type: "selection_cleared", ts: 1792300000, url_host: "github.com", title: "PR", ...want });
  assert.equal(clearedMessage({ ...tab, url: "https://icbc.com.cn/" }, deny(["icbc.com.cn"]), 0, ids), null);
  assert.equal(clearedMessage({ ...tab, url: "chrome://settings" }, deny([]), 0, ids), null);
});

test("revision starts at 1 per document and bumps when the URL or title changes on it", () => {
  const first = track(undefined, "D1", "https://a.com/x", "A");
  assert.deepEqual(first, { document_id: "D1", url: "https://a.com/x", title: "A", revision: 1 });
  assert.equal(track(first, "D1", "https://a.com/x", "A"), first);
  const spa = track(first, "D1", "https://a.com/y", "A");
  assert.equal(spa.revision, 2);
  assert.equal(track(spa, "D1", "https://a.com/y", "B").revision, 3);
  assert.deepEqual(track(spa, "D2", "https://a.com/y", "A"),
                   { document_id: "D2", url: "https://a.com/y", title: "A", revision: 1 });
});

test("reconnect backs off from 30 s to 5 min", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(backoffMinutes), [0.5, 1, 2, 4, 5, 5]);
});
