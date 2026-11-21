# Browser extension

[简体中文](browser-extension.md) · [Documentation index](../README.en.md)

## Overview

The Chrome MV3 extension `agent/browser/extension` passes the tab state of regular windows to the local agentd over Native Messaging. The 浏览器与网站 (Browser and websites) panel in the control panel shows the statistics. The message format between the extension, the native host, and agentd is in [agentd](../architecture/agentd.en.md#browser-extension-messages).

## Collection scope and privacy

- The only permissions are `tabs`, `alarms`, `nativeMessaging`, and `storage`; it requests no history, cookies, downloads, debugger, or scripting. It does not run in incognito windows. The content script matches HTTP(S) pages only.
- The domain, title, whether the tab plays sound, window focus, and the document identity make up the attention heartbeat. The full URL stays in the extension's memory and `storage.session` for this run, only to detect navigation, and is never sent to agentd; identity state is deleted when the tab closes.
- The 读取网页正文 (Read page text) setting (`share_page_text`, off by default) controls both collecting page text and selections and sharing them with models. While it is off, the extension reads no page text or selections, and the native host and agentd refuse both kinds of text. Turning it off does not delete existing records; use clearing attention or forgetting recent activity for that.
- When it is on, page text is the visible text in article, main, or body, at most 2000 characters. Forms, input fields, editable regions, scripts, styles, and hidden elements are skipped, and input values are never read. Selections pass the same editable-region check.
- The numbers are the current and furthest scroll percentage, the readable audio and video state (playing, paused, buffering, ended, position, duration, speed, muted), the count of regular tabs, and the count of non-blacklisted tabs playing sound. Media URLs, subtitles, audio tracks, watch history, and the text of background tabs are not read.
- The numbers serve only the local control panel. agentd keeps only the latest set in memory, which expires after 15 seconds; it is not written to SQLite and never reaches activity judgement or model context. Site time uses the 7-day attention timeline.
- Before each sample the native host fetches agentd's live policy; nothing is collected while agentd is not running, observation is paused, a reset runs, or the screen is locked, asleep, or under secure input. If the policy cannot be fetched, collection stops. Blacklisted domains and titles are filtered in the extension, the host, and agentd.
- On lock, sleep, or secure input, agentd ends the browser's foreground span at once and refuses data in flight; the current page text and selection must be sampled again before they are used. When extension sampling pauses for more than 15 seconds or the native host reconnects, the extension waits for a new foreground dwell, refreshes the page text, and drops asynchronous results that span the long gap.

## How the statistics are counted

The foreground page is sampled once every 5 seconds, merged; switching tabs, navigating, or a change in title, sound, or window focus samples at once. A heartbeat without focus ends the foreground span, and after focus leaves the old page text and selection no longer count as the current page. With no page, the last foreground span closes too. A once-a-minute alarm is the heartbeat fallback when no content script runs.

Page text is read only after at least 5 seconds in the foreground. DOM changes only set a flag; the text is read at the next sample, and a text change on the same page increases the revision. Emptied page text invalidates the old text. Unchanged text is not sent again; during a long stay it is refreshed every 5 minutes. Asynchronous results are checked again against focus, tab, URL, title, and the sample number.

- Site time: the foreground window ∩ active time; a page playing sound adds to AFK spans only while its window has focus. Unknown gaps are not filled, and at most the top 20 sites by time are shown.
- Page switches: an estimate of today's recorded foreground document or tab switches; a page-text revision is not a switch. It is not a full visit history.
- Scroll percentage: the top-level document's scroll position, which is not the same as having read it; without a scroll range it shows as unavailable. Nested scroll containers, iframes, and closed shadow DOM are not covered.
- Media: the playing standard video or audio element comes first, else the visible one. A top-level player that references cross-origin media still gives numbers; a player inside a cross-origin iframe is neither injected nor read and reports no readable media state, which does not prove the page plays nothing. Special players, Web Audio, and protected content may also have no readable state. An infinite duration shows as unknown.

## Installation and updates

1. Build Companion: `bash app/build_app.sh`.
2. On first install, run `sh agent/browser/install.sh [state-dir]` (macOS only; the default state-dir is `~/Library/Application Support/AgenticComplex/agentd`). It writes `<state-dir>/native-host.sh` and the Chrome NativeMessagingHosts manifest `local.agenticcomplex.agentd.json`; the host uses the Python in the repository's `agent/.venv`. An existing install needs no rewrite.
3. In Chrome, open `chrome://extensions`, turn on developer mode, and load or reload `agent/browser/extension`. The extension id is fixed: `oahafcajijleoficnkbfaedkmnkhnief`.
4. Reload pages that are already open so the new content script takes effect.

Reloading the extension does not replace content scripts already injected into old pages. Once its extension context is gone, a content script stops its timers, DOM observer, and event listeners and clears its text cache. If an old script already reported `Extension context invalidated`, reload or close that page; the past errors on the extensions page can be cleared by hand.
