// Only numeric state is sampled by default. Text is requested explicitly by the local policy.
let enabled = false, textEnabled = false, dirty = true, lastText = null, lastSelection = "";
let lastURL = location.href, maxScroll = 0;
let stopped = false, timer = null, observer = null;
const listeners = [];
const excluded = 'input, textarea, select, option, form, [contenteditable]:not([contenteditable="false"]), [role="textbox"], script, style, noscript, [hidden], [aria-hidden="true"]';
function stop() {
  if (stopped) return;
  stopped = true;
  enabled = textEnabled = false;
  lastText = null; lastSelection = "";
  clearInterval(timer);
  observer?.disconnect();
  for (const [target, name, listener] of listeners) target.removeEventListener(name, listener);
  listeners.length = 0;
  try { chrome.runtime.onMessage.removeListener(receiveSnapshot); } catch {}
}
function alive() {
  if (stopped) return false;
  try { if (chrome.runtime?.id) return true; } catch {}
  stop();
  return false;
}
function send(message) {
  if (!alive()) return;
  try {
    // A reload can throw synchronously, before sendMessage returns its Promise.
    chrome.runtime.sendMessage(message).catch(error => {
      if (!alive() || /extension context invalidated/i.test(String(error?.message || error))) stop();
    });
  } catch { stop(); }
}
function listen(name, listener, target = document) {
  target.addEventListener(name, listener);
  listeners.push([target, name, listener]);
}
const editable = (node) => (node?.nodeType === 1 ? node : node?.parentElement)?.closest(excluded);

function pageText() {
  const root = document.querySelector("article") || document.querySelector("main") || document.body;
  if (!root || editable(root)) return "";
  // Walk rendered text only, never form values or contenteditable contents. Stop at the existing cap.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (editable(node) || !node.parentElement?.checkVisibility?.({ checkVisibilityCSS: true })) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let text = "", node;
  while (text.length < 2000 && (node = walker.nextNode())) text += " " + node.textContent.replace(/\s+/g, " ");
  return text.trim().slice(0, 2000);
}

function snapshot(collectText, forceText) {
  if (location.href !== lastURL) { lastURL = location.href; maxScroll = 0; dirty = true; lastText = null; }
  const el = document.scrollingElement;
  const range = el ? el.scrollHeight - el.clientHeight : 0;
  const scroll = range > 0 ? Math.round(Math.max(0, Math.min(1, el.scrollTop / range)) * 100) : null;
  if (scroll !== null) maxScroll = Math.max(maxScroll, scroll);
  const elements = [...document.querySelectorAll("video, audio")];
  const media = elements.find(e => !e.paused && !e.ended) || elements.find(e => e.checkVisibility?.()) || null;
  const result = { captured_at: Date.now(), scroll_percent: scroll, max_scroll_percent: scroll === null ? null : maxScroll, media: media ? {
    kind: media.tagName === "VIDEO" ? "video" : "audio",
    state: media.ended ? "ended" : media.paused ? "paused" : media.readyState < 3 ? "buffering" : "playing",
    position_s: Number.isFinite(media.currentTime) ? Math.round(media.currentTime) : null,
    duration_s: Number.isFinite(media.duration) ? Math.round(media.duration) : null,
    playback_rate: media.playbackRate, muted: media.muted,
  } : null };
  if (collectText && (dirty || forceText)) {
    const text = pageText();
    if (text !== lastText || forceText) result.text = text;
    lastText = text;
    dirty = false;
  }
  return result;
}

function receiveSnapshot(message, _sender, respond) {
  if (message?.type !== "snapshot") return;
  if (!alive()) { respond(null); return; }
  enabled = message.enabled === true;
  textEnabled = enabled && message.text_enabled === true;
  if (!textEnabled) { lastText = null; lastSelection = ""; dirty = true; }
  if (!enabled || document.visibilityState !== "visible") { respond(null); return; }
  respond(snapshot(textEnabled, message.force_text === true));
}
chrome.runtime.onMessage.addListener(receiveSnapshot);
observer = new MutationObserver((changes) => {
  if (alive() && changes.some(c => !editable(c.target))) dirty = true;
});
observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });

function reportSelection() {
  if (!alive() || !enabled || !textEnabled || document.visibilityState !== "visible" || editable(document.activeElement)) return;
  const selection = getSelection();
  if (editable(selection?.anchorNode) || editable(selection?.focusNode)) return;
  if (selection?.rangeCount && [...document.querySelectorAll(excluded)].some(el => selection.getRangeAt(0).intersectsNode(el))) return;
  const text = String(selection || "").trim().slice(0, 2000);
  if (text === lastSelection) return;
  lastSelection = text;
  send(text ? { type: "selection", text, captured_at: Date.now() } : { type: "selection_cleared", captured_at: Date.now() });
}
listen("mouseup", () => setTimeout(reportSelection, 0));
listen("keyup", (e) => { if (e.shiftKey) reportSelection(); });
listen("selectionchange", () => { if (alive() && lastSelection && !String(getSelection() || "").trim()) reportSelection(); });
listen("visibilitychange", () => { enabled = false; textEnabled = false; send({ type: "sample" }); });
// A back-forward cache restore runs no script again: background still holds the document shown before it.
listen("pageshow", (e) => { if (e.persisted) send({ type: "hello" }); }, window);
// Coalesce mutations, scrolling and media events; background verifies window focus and policy before reading.
timer = setInterval(() => { if (alive() && document.visibilityState === "visible") send({ type: "sample" }); }, 5000);
send({ type: "hello" });
