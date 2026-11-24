// The attention heartbeat's pure rules (src/common/attention.ts): one test per rule, on fixed `attention.sample`
// replies written after CONTRACT §7.3's field table. Nothing here reads the system.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AttentionBeats, AttentionSleepState, type AttentionSample, attentionPayload, type BlacklistRules, browserAsks,
  browserState, CaptureTracker, chooseTitle, coarseBeat, composeSample, coversDisplay, decodeAttention, EMPTY_BLACKLIST, focusLine, frontAudioOut,
  gateLine, isBrowser, helperEdge, hides, InputActivity, type InputSnapshot, parseBlacklist, PresenceEdges, redactText, Reflex, sensedFields, appKitY,
  helperY,
} from '../src/common/attention.ts';

const OWN = [4000];

/** `attention.sample`'s result as examples/ok-attention.ndjson has it: Safari in front, TextEdit under the mouse. */
function reply(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts: 1763539200.25,
    front: {
      pid: 611, name: 'Safari', app_id: 'com.apple.Safari', category: 'public.app-category.productivity',
      window: { window_id: 812, pid: 611, bounds: { x: 0, y: 25, width: 1440, height: 875 }, layer: 0, alpha: 1, title: 'Release notes', app_name: 'Safari', app_id: 'com.apple.Safari' },
    },
    mouse_window: { window_id: 640, pid: 702, bounds: { x: 200, y: 120, width: 900, height: 600 }, title: 'notes.txt', app_name: 'TextEdit', app_id: 'com.apple.TextEdit' },
    idle_s: 1.4, locked: false, secure_input: false,
    focus_role: 'AXTextArea', focus_native_role: 'AXTextArea', focus_window_role: 'AXWindow', focus_window_native_role: 'AXWindow',
    focus_window_subrole: 'AXStandardWindow', camera_active: false, mic_active: null,
    audio_clients: [{ pid: 611, app_id: 'com.apple.Safari', name: 'Safari', running_input: false, running_output: true }],
    input_counters: { keys: 120345, left_clicks: 8812, right_clicks: 301, scrolls: 44120, moves: 991203 },
    input_idles: { key: 1.4, pointer: 0.2, scroll: 12, click: 3.5 },
    video_pids: [611], front_gpu_busy: null, capture_indicator: false,
    ...over,
  };
}

/** TextEdit in front, the default for rules that are not about browsers. */
const textEdit = (over: Record<string, unknown> = {}) => reply({
  front: {
    pid: 702, name: 'TextEdit', app_id: 'com.apple.TextEdit', category: 'public.app-category.productivity',
    window: { window_id: 640, pid: 702, bounds: { x: 200, y: 120, width: 900, height: 600 }, title: 'notes.txt', app_name: 'TextEdit', app_id: 'com.apple.TextEdit' },
  },
  ...over,
});

const ctx = (o: Partial<Parameters<typeof composeSample>[1]> = {}): Parameters<typeof composeSample>[1] => ({
  browser: { host: null, incognito: false }, displays: [{ x: 0, y: 0, width: 1440, height: 900 }], asleep: false,
  userSpeaking: null, sensed: { input: null, frontAudioOut: null }, screenCaptured: null, ...o,
});

const sample = (r: Record<string, unknown>, o: Partial<Parameters<typeof composeSample>[1]> = {}) =>
  composeSample(decodeAttention(r), ctx(o));

// Deny mode unless `json` says otherwise; `rules({})` reads every window but our own.
const rules = (json: Record<string, unknown>): BlacklistRules => parseBlacklist({ mode: 'deny', ...json });

const payload = (s: AttentionSample, bl: BlacklistRules = rules({}), redact = true) => attentionPayload(s, bl, OWN, redact);

// ---- chooseTitle, isBrowser

test('chooseTitle: the AX title when it has one, else the CG window name', () => {
  assert.equal(chooseTitle('AX', 'CG'), 'AX');
  assert.equal(chooseTitle('', 'CG'), 'CG');
  assert.equal(chooseTitle(null, 'CG'), 'CG');
});

test('composeSample: without focused_window_title (Windows) the front title is the window title the helper read', () => {
  assert.equal(sample(textEdit()).front?.title, 'notes.txt');
});

/** TextEdit in front with the AX title of its focused window (CONTRACT §7.3 `front.focused_window_title`). */
const withAxTitle = (axTitle: string | null, windowTitle = 'notes.txt', id = 'com.apple.TextEdit') => textEdit({
  front: { ...(textEdit().front as Record<string, unknown>), app_id: id, focused_window_title: axTitle,
    window: { window_id: 640, pid: 702, bounds: { x: 200, y: 120, width: 900, height: 600 }, title: windowTitle } },
});

test('composeSample: the focused window\'s AX title comes first, the window title when it is empty or null', () => {
  assert.equal(sample(withAxTitle('notes.txt — Edited')).front?.title, 'notes.txt — Edited');
  assert.equal(sample(withAxTitle('')).front?.title, 'notes.txt');
  assert.equal(sample(withAxTitle(null)).front?.title, 'notes.txt');
  const example = reply({ front: { ...(reply().front as Record<string, unknown>), focused_window_title: 'Release notes — WebKit' } });
  assert.equal(sample(example, { browser: { host: 'webkit.org', incognito: false } }).front?.title, 'Release notes — WebKit',
    'examples/ok-attention.ndjson');
});

test('privacy: the AX title goes through the same rules: incognito, title patterns, redaction, 256 code points', () => {
  for (const incognito of [null, true]) {
    assert.equal(sample(withAxTitle('Secret tab', 'x', 'com.apple.Safari'), { browser: { host: null, incognito } }).front?.title, null);
  }
  assert.deepEqual(payload(sample(withAxTitle('Payroll 2026', 'notes.txt')), rules({ title_patterns: ['Payroll'] })).front, { app: '<hidden>' });
  const mail = sample(withAxTitle('From a.b@example.com', 'Inbox'));
  assert.equal((payload(mail).front as Record<string, unknown>).title, 'From [邮箱已遮蔽]');
  assert.equal([...((payload(sample(withAxTitle('𝄞'.repeat(300)))).front as Record<string, unknown>).title as string)].length, 256);
  assert.equal('title' in (payload(sample({ ...withAxTitle('AX'), secure_input: true })).front as Record<string, unknown>), false);
});

// ---- Privacy: blacklist

test('blacklist: our own process and the Companion bundle id are always hidden', () => {
  const w = { app: 'x', bundleId: 'a.b', pid: 4000, windowId: 1, title: null, urlHost: null };
  assert.equal(hides(rules({}), w, OWN), true);
  assert.equal(hides(rules({}), { ...w, pid: 1, bundleId: 'local.agenticcomplex.companion' }, OWN), true);
  assert.equal(hides(rules({}), { ...w, pid: 1 }, OWN), false);
});

test('blacklist: bundle ids match exactly, app names case-insensitively', () => {
  const bl = rules({ bundle_ids: ['com.tinyspeck.slackmacgap'], app_names: ['WeChat'] });
  const w = { app: 'Slack', bundleId: 'com.tinyspeck.slackmacgap', pid: 1, windowId: 1, title: null, urlHost: null };
  assert.equal(hides(bl, w, OWN), true);
  assert.equal(hides(bl, { ...w, bundleId: 'COM.tinyspeck.slackmacgap' }, OWN), false);
  assert.equal(hides(bl, { ...w, bundleId: 'x', app: 'wechat' }, OWN), true);
});

test('blacklist: a domain hides its host and every subdomain, not a suffix of another name', () => {
  const bl = rules({ domains: ['Bank.com'] });
  const w = { app: 'Safari', bundleId: 'com.apple.Safari', pid: 1, windowId: 1, title: null, urlHost: 'bank.com' };
  assert.equal(hides(bl, w, OWN), true);
  assert.equal(hides(bl, { ...w, urlHost: 'login.BANK.com' }, OWN), true);
  assert.equal(hides(bl, { ...w, urlHost: 'mybank.com' }, OWN), false);
  assert.equal(hides(bl, { ...w, urlHost: '' }, OWN), false);
});

test('blacklist: a title pattern is a regular expression searched in the title; a bad one is skipped', () => {
  const bl = rules({ title_patterns: ['(unclosed', '工资\\d+'] });
  const w = { app: 'Numbers', bundleId: 'com.apple.iWork.Numbers', pid: 1, windowId: 1, title: '2026 工资12 表', urlHost: null };
  assert.equal(hides(bl, w, OWN), true);
  assert.equal(hides(bl, { ...w, title: '预算' }, OWN), false);
  assert.equal(hides(bl, { ...w, title: null }, OWN), false);
});

test('blacklist: a list with a non-string entry counts as empty', () => {
  const bl = rules({ bundle_ids: ['a', 3], incognito: 'yes' });
  assert.equal(bl.incognito, false);
  assert.equal(hides(bl, { app: null, bundleId: 'a', pid: 1, windowId: null, title: null, urlHost: null }, OWN), false);
});

// ---- Privacy: allow list

test('allow list: no file and a file without mode are the empty allow list, which hides every window', () => {
  for (const bl of [EMPTY_BLACKLIST, parseBlacklist({}), parseBlacklist({ mode: 'other', bundle_ids: ['com.secret'] })]) {
    assert.equal(bl.mode, 'allow');
    assert.equal(bl.incognito, true);
    assert.equal(hides(bl, { app: 'TextEdit', bundleId: 'com.apple.TextEdit', pid: 1, windowId: 1, title: null, urlHost: null }, OWN), true);
    assert.equal(hides(bl, { app: 'Safari', bundleId: 'com.apple.Safari', pid: 1, windowId: 1, title: null, urlHost: 'github.com' }, OWN), true);
  }
  assert.deepEqual(parseBlacklist({}), EMPTY_BLACKLIST);
});

test('allow list: an app is read by its exact bundle id or its name case-insensitively', () => {
  const bl = rules({ mode: 'allow', allow: { bundle_ids: ['com.apple.TextEdit'], app_names: ['Terminal'] } });
  const w = { app: 'TextEdit', bundleId: 'com.apple.TextEdit', pid: 1, windowId: 1, title: 'notes.txt', urlHost: null };
  assert.equal(hides(bl, w, OWN), false);
  assert.equal(hides(bl, { ...w, bundleId: 'COM.apple.TextEdit' }, OWN), true);
  assert.equal(hides(bl, { ...w, app: 'terminal', bundleId: 'com.apple.Terminal' }, OWN), false);
  assert.equal(hides(bl, { ...w, app: 'Notes', bundleId: 'com.apple.Notes' }, OWN), true);
});

test('allow list: a browser window is read by its host alone, a listed domain or its subdomain, case-insensitively', () => {
  const bl = rules({ mode: 'allow', allow: { bundle_ids: ['com.apple.Safari'], domains: ['GitHub.com'] } });
  const w = { app: 'Safari', bundleId: 'com.apple.Safari', pid: 1, windowId: 1, title: null, urlHost: 'github.com' };
  assert.equal(hides(bl, w, OWN), false);
  assert.equal(hides(bl, { ...w, urlHost: 'Gist.GITHUB.com' }, OWN), false);
  assert.equal(hides(bl, { ...w, urlHost: 'notgithub.com' }, OWN), true);
  assert.equal(hides(bl, { ...w, urlHost: 'example.com' }, OWN), true, 'the allowed browser app does not read other hosts');
  const byDomain = rules({ mode: 'allow', allow: { domains: ['github.com'] } });
  assert.equal(hides(byDomain, w, OWN), false, 'the browser app need not be listed');
});

test('allow list: a deny entry wins over an allow entry, as agentd\'s blacklist.py hides', () => {
  const w = { app: 'TextEdit', bundleId: 'com.apple.TextEdit', pid: 1, windowId: 1, title: 'my bank.txt', urlHost: null };
  const titled = rules({ mode: 'allow', title_patterns: ['bank'], allow: { bundle_ids: ['com.apple.TextEdit'] } });
  assert.equal(hides(titled, w, OWN), true, 'a title deny on an allowed app');
  assert.equal(hides(titled, { ...w, title: 'notes.txt' }, OWN), false);
  const domains = rules({ mode: 'allow', domains: ['secret.github.com'], allow: { domains: ['github.com'] } });
  const tab = { app: 'Safari', bundleId: 'com.apple.Safari', pid: 1, windowId: 1, title: null, urlHost: 'Login.Secret.github.com' };
  assert.equal(hides(domains, tab, OWN), true, 'a denied subdomain under an allowed domain');
  assert.equal(hides(domains, { ...tab, urlHost: 'gist.github.com' }, OWN), false);
  for (const both of [rules({ mode: 'allow', bundle_ids: ['com.apple.TextEdit'], allow: { bundle_ids: ['com.apple.TextEdit'] } }),
    rules({ mode: 'allow', app_names: ['textedit'], allow: { app_names: ['TextEdit'] } })]) {
    assert.equal(hides(both, { ...w, title: null }, OWN), true, 'an app both allowed and denied');
  }
});

test('allow list: our own process and the Companion bundle id are hidden even when listed; incognito is always on', () => {
  const bl = rules({ mode: 'allow', incognito: false, allow: { bundle_ids: ['a.b', 'local.agenticcomplex.companion'] } });
  const w = { app: 'x', bundleId: 'a.b', pid: 4000, windowId: 1, title: null, urlHost: null };
  assert.equal(bl.incognito, true);
  assert.equal(hides(bl, w, OWN), true);
  assert.equal(hides(bl, { ...w, pid: 1, bundleId: 'local.agenticcomplex.companion' }, OWN), true);
  assert.equal(hides(bl, { ...w, pid: 1 }, OWN), false);
});

test('deny mode: the blacklist keys apply, the allow list is not used, and incognito is the file\'s', () => {
  const bl = rules({ mode: 'deny', bundle_ids: ['com.secret'], allow: { bundle_ids: ['com.apple.TextEdit'] } });
  assert.equal(bl.mode, 'deny');
  assert.equal(bl.incognito, false);
  const w = { app: 'Notes', bundleId: 'com.apple.Notes', pid: 1, windowId: 1, title: null, urlHost: null };
  assert.equal(hides(bl, w, OWN), false);
  assert.equal(hides(bl, { ...w, bundleId: 'com.secret' }, OWN), true);
});

test('payload: a blacklisted front window is sent as app <hidden> only, and focus_window is null', () => {
  const s = sample(textEdit());
  const p = payload(s, rules({ bundle_ids: ['com.apple.TextEdit'] }));
  assert.deepEqual(p.front, { app: '<hidden>' });
  assert.equal(p.focus_window, null);
});

test('payload: the mouse window is hidden when blacklisted or when it is the hidden front window', () => {
  const s = sample(reply({
    mouse_window: { window_id: 640, pid: 702, bounds: { x: 0, y: 0, width: 1, height: 1 }, title: 't', app_name: 'TextEdit', app_id: 'com.apple.TextEdit' },
  }), { browser: { host: null, incognito: false } });
  assert.deepEqual(payload(s, rules({ bundle_ids: ['com.apple.TextEdit'] })).mouse, { app: '<hidden>' });
  const same = sample(textEdit());
  assert.deepEqual(payload(same, rules({ title_patterns: ['notes'] })).mouse, { app: '<hidden>' });
  assert.deepEqual(payload(same).mouse, { app: 'TextEdit', bundle_id: 'com.apple.TextEdit', pid: 702, window_id: 640 });
});

test('payload: no mouse window is null', () => {
  assert.equal(payload(sample(textEdit({ mouse_window: null }))).mouse, null);
});

// ---- Privacy: incognito and browsers

test('browserAsks: Safari and Chrome on macOS, Chrome and Edge on Windows are asked for their tab', () => {
  assert.equal(browserAsks('com.apple.Safari'), true);
  assert.equal(browserAsks('com.google.Chrome'), true);
  assert.equal(browserAsks('chrome.exe'), true);
  assert.equal(browserAsks('msedge.exe'), true);
  assert.equal(browserAsks('com.microsoft.edgemac'), false);
  assert.equal(browserAsks('com.apple.TextEdit'), false);
  assert.equal(browserAsks(null), false);
});

test('browserState: not a browser is known not incognito; another browser, a refusal or an error is unknown', () => {
  assert.deepEqual(browserState('com.apple.TextEdit', null), { host: null, incognito: false });
  assert.deepEqual(browserState('org.mozilla.firefox', null), { host: null, incognito: null });
  assert.deepEqual(browserState('com.google.Chrome', { ok: false, error: { code: 'automation_denied' } }), { host: null, incognito: null });
  assert.deepEqual(browserState('com.google.Chrome', { ok: false, error: { code: 'helper_timeout' } }), { host: null, incognito: null });
});

test('browserState: the helper\'s url_host and incognito are taken as they come', () => {
  assert.deepEqual(browserState('com.google.Chrome', { ok: true, result: { url_host: 'github.com', incognito: false } }),
    { host: 'github.com', incognito: false });
  assert.deepEqual(browserState('com.google.Chrome', { ok: true, result: { url_host: null, incognito: true } }), { host: null, incognito: true });
  assert.deepEqual(browserState('com.apple.Safari', { ok: true, result: { url_host: 'apple.com', incognito: null } }),
    { host: 'apple.com', incognito: null });
});

test('browserState: the url_host is put in agentd\'s normal form, the lower-case A-label without the root dot', () => {
  const host = (url_host: unknown) => browserState('chrome.exe', { ok: true, result: { url_host, incognito: false } }).host;
  // The Windows helper reads the address bar, which shows an IDN in Unicode.
  assert.equal(host('München.de'), 'xn--mnchen-3ya.de');
  assert.equal(host('Example.COM.'), 'example.com');
  assert.equal(host('a b'), null);
  const rules = parseBlacklist({ mode: 'deny', domains: ['xn--mnchen-3ya.de', 'example.com'] });
  for (const h of ['münchen.de', 'www.example.com.']) {
    const w = { app: 'Chrome', bundleId: 'chrome.exe', pid: 1, windowId: 1, title: null, urlHost: host(h) };
    assert.equal(hides(rules, w, OWN), true, h);
  }
});

test('composeSample: a browser window whose incognito state is not false gets no title', () => {
  assert.equal(sample(reply(), { browser: { host: 'apple.com', incognito: null } }).front?.title, null);
  assert.equal(sample(reply(), { browser: { host: null, incognito: true } }).front?.title, null);
  const normal = sample(reply(), { browser: { host: 'apple.com', incognito: false } });
  assert.equal(normal.front?.title, 'Release notes');
  assert.equal(normal.front?.urlHost, 'apple.com');
  assert.equal(normal.frontIncognito, false);
});

test('payload: an incognito window is hidden only while blacklist.json says incognito', () => {
  const s = sample(reply({ front: { pid: 9, name: 'Google Chrome', app_id: 'com.google.Chrome', window: null } }), { browser: { host: null, incognito: true } });
  assert.deepEqual(payload(s, rules({ incognito: true })).front, { app: '<hidden>' });
  assert.equal((payload(s).front as Record<string, unknown>).app, 'Google Chrome');
});

test('payload: a browser of unknown incognito state sends only app and bundle_id', () => {
  const s = sample(reply(), { browser: { host: 'apple.com', incognito: null } });
  assert.deepEqual(payload(s).front, { app: 'Safari', bundle_id: 'com.apple.Safari' });
});

test('Windows: a browser by its executable name is a browser of unknown incognito state, so it sends no title (C12 §2.9 app_id)', () => {
  for (const id of ['chrome.exe', 'msedge.exe', 'brave.exe', 'firefox.exe', 'arc.exe']) {
    assert.equal(isBrowser(id), true, id);
    assert.equal(browserAsks(id), id === 'chrome.exe' || id === 'msedge.exe', id);
    assert.deepEqual(browserState(id, null), { host: null, incognito: null }, id);
  }
  assert.equal(isBrowser('notepad.exe'), false);
  assert.deepEqual(browserState('notepad.exe', null), { host: null, incognito: false });
});

test('the other Chromium, Firefox and WebKit browsers in common use are browsers of unknown incognito state too', () => {
  for (const id of ['com.vivaldi.Vivaldi', 'com.operasoftware.Opera', 'org.chromium.Chromium', 'com.google.Chrome.canary',
    'com.microsoft.edgemac.Dev', 'org.mozilla.firefoxdeveloperedition', 'org.torproject.torbrowser', 'app.zen-browser.zen',
    'com.kagi.kagimacOS', 'com.apple.SafariTechnologyPreview', 'vivaldi.exe', 'opera.exe', 'librewolf.exe', 'waterfox.exe']) {
    assert.equal(isBrowser(id), true, id);
    assert.deepEqual(browserState(id, null), { host: null, incognito: null }, id);
  }
});

test('Windows: a packaged app is known only by its AUMID and may be a browser, so its private state is unknown and it sends no title', () => {
  const aumid = 'Contoso.Browser_8abcdefgh1234!App';
  assert.deepEqual(browserState(aumid, null), { host: null, incognito: null });
  const s = sample(reply({ front: { pid: 9, name: 'Contoso Browser', app_id: aumid,
    window: { window_id: 3, pid: 9, bounds: { x: 0, y: 25, width: 800, height: 600 }, title: 'Private tab' } } }), { browser: browserState(aumid, null) });
  assert.equal(s.front?.title, null);
  assert.deepEqual(payload(s).front, { app: 'Contoso Browser', bundle_id: aumid });
});

// ---- Privacy: secure input, redaction, title length

test('payload: secure input leaves the title key out', () => {
  const p = payload(sample(textEdit({ secure_input: true })));
  assert.equal('title' in (p.front as Record<string, unknown>), false);
  assert.equal(p.secure_input, true);
});

test('payload: the title is redacted while redact_sensitive is on, and sent as read when off', () => {
  const s = sample(textEdit({ front: { pid: 702, name: 'Mail', app_id: 'com.apple.mail', window: { window_id: 5, pid: 702, bounds: { x: 0, y: 0, width: 1, height: 1 }, title: 'From a.b@example.com' } } }));
  assert.equal((payload(s).front as Record<string, unknown>).title, 'From [邮箱已遮蔽]');
  assert.equal((payload(s, rules({}), false).front as Record<string, unknown>).title, 'From a.b@example.com');
});

test('payload: the title is cut to 256 code points after redaction', () => {
  const long = '𝄞'.repeat(300);
  const s = sample(textEdit({ front: { pid: 702, name: 'X', app_id: 'x', window: { window_id: 5, pid: 702, bounds: { x: 0, y: 0, width: 1, height: 1 }, title: long } } }));
  assert.equal([...((payload(s).front as Record<string, unknown>).title as string)].length, 256);
});

test('redactText: bearer and basic credentials', () => {
  assert.equal(redactText('header Bearer abc.def-123 sent'), 'header [凭据已遮蔽] sent');
  assert.equal(redactText('basic dXNlcjpwYXNz'), '[凭据已遮蔽]');
});

test('redactText: basic and bearer in prose stay', () => {
  assert.equal(redactText('Explain basic arithmetic to me'), 'Explain basic arithmetic to me');
  assert.equal(redactText('Basic concepts first'), 'Basic concepts first');
  assert.equal(redactText('the bearer bonds were sold'), 'the bearer bonds were sold');
});

test('redactText: an Authorization header value is redacted whatever its shape', () => {
  assert.ok(!redactText('Authorization: Bearer abcdefgh').includes('abcdefgh'));
  assert.ok(!redactText('Authorization: Basic dXNlcjpwYXNz').includes('dXNlcjpwYXNz'));
  assert.ok(!redactText('Authorization: Basic concepts').includes('concepts'));
});

test('redactText: client_secret and passwd values', () => {
  assert.equal(redactText('client_secret=s3cr3tvalue'), 'client_secret=[已遮蔽]');
  assert.equal(redactText('passwd=hunter2'), 'passwd=[已遮蔽]');
});

test('redactText: quoted secret values, through the end of an unterminated quote', () => {
  assert.equal(redactText('{"api_key": "abc\\"def"}'), '{"api_key": [已遮蔽]}');
  assert.equal(redactText("password='open"), 'password=[已遮蔽]');
});

test('redactText: bare secret values', () => {
  assert.equal(redactText('token=abc123, next'), 'token=[已遮蔽], next');
  assert.equal(redactText('SECRET: hunter2'), 'SECRET: [已遮蔽]');
});

test('redactText: API keys and GitHub tokens', () => {
  assert.equal(redactText('use sk-abcdefgh1234 now'), 'use [密钥已遮蔽] now');
  assert.equal(redactText('ghp_ABCDEFGH12345678'), '[密钥已遮蔽]');
  assert.equal(redactText('xsk-abcdefgh1234'), 'xsk-abcdefgh1234');
});

test('redactText: email addresses and phone numbers, not ISO dates', () => {
  assert.equal(redactText('mail me: x.y@mail.example.org'), 'mail me: [邮箱已遮蔽]');
  assert.equal(redactText('call +1 (415) 555-0100 today'), 'call [电话已遮蔽] today');
  assert.equal(redactText('2026-11-20T10:00 report'), '2026-11-20T10:00 report');
  assert.equal(redactText('No secrets here'), 'No secrets here');
});

// ---- Payload shape

test('payload: no front app is sent as a front object with every field null', () => {
  const p = payload(sample(textEdit({ front: null })));
  assert.deepEqual(p.front, { app: null, bundle_id: null, pid: null, window_id: null, title: null, url_host: null });
});

test('payload: the fields, with the optional flags left out while unknown', () => {
  const s = sample(textEdit({ camera_active: null, mic_active: true, front_gpu_busy: 0.5, video_pids: [] }),
    { userSpeaking: null, sensed: { input: null, frontAudioOut: false }, screenCaptured: false });
  s.edge = 'unlock';
  const p = payload(s);
  assert.deepEqual(p, {
    ts: 1763539200.25,
    front: { app: 'TextEdit', bundle_id: 'com.apple.TextEdit', pid: 702, window_id: 640, title: 'notes.txt', url_host: null, category: 'public.app-category.productivity' },
    mouse: { app: 'TextEdit', bundle_id: 'com.apple.TextEdit', pid: 702, window_id: 640 },
    idle_s: 1.4, locked: false, asleep: false, focus_role: 'AXTextArea', secure_input: false, fullscreen: false,
    mic_active: true, front_audio_out: false, front_video: false, front_gpu: 0.5,
    screen_captured: false, edge: 'unlock', focus_window: { role: 'AXWindow', subrole: 'AXStandardWindow' },
  });
});

test('payload: input carries only counts and idle seconds; near_clicks_10s only when known', () => {
  const input = { idles: { key: 1, pointer: 2, scroll: 3, click: 4 }, keys10s: 5, keys60s: 6, clicks10s: 7, scrolls30s: 8, moves10s: 9, switches60s: 1, nearClicks10s: null };
  const p = payload(sample(textEdit(), { sensed: { input, frontAudioOut: null } }));
  assert.deepEqual(p.input, { key_idle_s: 1, pointer_idle_s: 2, scroll_idle_s: 3, click_idle_s: 4, keys_10s: 5, keys_60s: 6, clicks_10s: 7, scrolls_30s: 8, moves_10s: 9, switches_60s: 1 });
  const q = payload(sample(textEdit(), { sensed: { input: { ...input, nearClicks10s: 2 }, frontAudioOut: null } }));
  assert.equal((q.input as Record<string, unknown>).near_clicks_10s, 2);
});

test('payload: the category is left out when the helper has none', () => {
  const s = sample(textEdit({ front: { pid: 702, name: 'X', app_id: 'x', window: null } }));
  assert.equal('category' in (payload(s).front as Record<string, unknown>), false);
});

test('focus window: the window role and subrole; none when the helper found no window', () => {
  assert.deepEqual(sample(textEdit()).focusWindow, { role: 'AXWindow', subrole: 'AXStandardWindow' });
  assert.equal(sample(textEdit({ focus_window_role: null, focus_window_subrole: null })).focusWindow, null);
  assert.equal(payload(sample(textEdit({ focus_window_role: null, focus_window_subrole: null }))).focus_window, null);
});

// ---- Scene: fullscreen, video, GPU

test('coversDisplay: a window covering a whole display is fullscreen; a zoomed one is not', () => {
  const displays = [{ x: 0, y: 0, width: 1440, height: 900 }, { x: 1440, y: 0, width: 1920, height: 1080 }];
  assert.equal(coversDisplay({ x: 1440, y: 0, width: 1920, height: 1080 }, displays), true);
  assert.equal(coversDisplay({ x: 0, y: 25, width: 1440, height: 875 }, displays), false);
  assert.equal(coversDisplay({ x: 0, y: 0, width: 1440, height: 900 }, []), false);
});

test('composeSample: fullscreen from the front window bounds and the displays; false without a front window', () => {
  const full = textEdit({ front: { pid: 702, name: 'X', app_id: 'x', window: { window_id: 5, pid: 702, bounds: { x: 0, y: 0, width: 1440, height: 900 } } } });
  assert.equal(sample(full).fullscreen, true);
  assert.equal(sample(textEdit()).fullscreen, false);
  assert.equal(sample(textEdit({ front: null })).fullscreen, false);
});

test('composeSample: front_video is whether the front pid holds a display assertion; nil without a front app', () => {
  assert.equal(sample(textEdit({ video_pids: [702] })).frontVideo, true);
  assert.equal(sample(textEdit({ video_pids: [1] })).frontVideo, false);
  assert.equal(sample(textEdit({ front: null, video_pids: [702] })).frontVideo, null);
});

test('composeSample: front_gpu is the helper\'s front_gpu_busy, nil without a front app', () => {
  assert.equal(sample(textEdit({ front_gpu_busy: 0.3 })).frontGpu, 0.3);
  assert.equal(sample(textEdit({ front: null, front_gpu_busy: 0.3 })).frontGpu, null);
});

test('Reflex: video when the front app plays one, at its AX video rect or else the window frame, in AppKit points', () => {
  const r = new Reflex();
  const s = sample(textEdit({ video_pids: [702] }));
  assert.deepEqual(r.update(s, 900, { x: 10, y: 20, width: 300, height: 200 }), { kind: 'video', rect: { x: 10, y: 680, width: 300, height: 200 } });
  assert.deepEqual(r.update(s, 900, null), { kind: 'video', rect: { x: 200, y: 180, width: 900, height: 600 } });
});

test('Reflex: Windows keeps the helper\'s y (C3 in physical pixels, y down)', () => {
  const s = sample(textEdit({ video_pids: [702] }));
  assert.deepEqual(new Reflex(helperY).update(s, 900, { x: 10, y: 20, width: 300, height: 200 }), { kind: 'video', rect: { x: 10, y: 20, width: 300, height: 200 } });
  assert.equal(appKitY(20, 200, 900), 680);
});

test('Reflex: game for a games-category app', () => {
  const s = sample(textEdit({ front: { pid: 7, name: 'G', app_id: 'g', category: 'public.app-category.action-games', window: { window_id: 5, pid: 7, bounds: { x: 0, y: 0, width: 100, height: 100 } } } }));
  assert.deepEqual(new Reflex().update(s, 900, null), { kind: 'game', rect: { x: 0, y: 800, width: 100, height: 100 } });
});

test('Reflex: game after 3 beats in a row fullscreen at a GPU share of at least 0.2', () => {
  const r = new Reflex();
  const full = (gpu: number) => sample(textEdit({ front_gpu_busy: gpu, front: { pid: 7, name: 'G', app_id: 'g', window: { window_id: 5, pid: 7, bounds: { x: 0, y: 0, width: 1440, height: 900 } } } }));
  assert.equal(r.update(full(0.2), 900, null), null);
  assert.equal(r.update(full(0.5), 900, null), null);
  assert.equal(r.update(full(0.1), 900, null), null);
  assert.equal(r.update(full(0.3), 900, null), null);
  assert.equal(r.update(full(0.3), 900, null), null);
  assert.deepEqual(r.update(full(0.3), 900, null), { kind: 'game', rect: { x: 0, y: 0, width: 1440, height: 900 } });
});

// ---- Microphone, audio apps, screen capture

test('frontAudioOut: the front pid\'s clients, unknown when one cannot be read, nil without a front pid', () => {
  const c = (output: boolean | null) => ({ pid: 5, bundleId: 'p', app: 'p', runningInput: false, runningOutput: output });
  assert.equal(frontAudioOut([c(false), c(null)], 5), null);
  assert.equal(frontAudioOut([c(true), c(null)], 5), true);
  assert.equal(frontAudioOut([c(true)], null), null);
});

test('sensedFields: an off input switch leaves input out and the input reader is not called', () => {
  let called = 0;
  const input = () => { called += 1; return null; };
  assert.deepEqual(sensedFields(false, true, input), { input: null, frontAudioOut: true });
  assert.equal(called, 0);
  sensedFields(true, null, input);
  assert.equal(called, 1);
});

test('CaptureTracker: screen capture is the indicator with no mic or camera in use, unknown within 3 s of their use', () => {
  const t = new CaptureTracker();
  assert.equal(t.update(100, null, false, false, false), null);
  assert.equal(t.update(101, false, false, false, false), false);
  assert.equal(t.update(102, true, false, false, false), true);
  assert.equal(t.update(103, true, true, false, false), null);
  assert.equal(t.update(105, true, false, false, false), null);
  assert.equal(t.update(106, true, false, false, false), true);
  assert.equal(t.update(107, true, false, null, false), null);
});

test('CaptureTracker: our own capture keeps the value from before it', () => {
  const t = new CaptureTracker();
  assert.equal(t.update(100, false, false, false, false), false);
  assert.equal(t.update(101, true, false, false, true), false);
  assert.equal(t.update(102, true, false, false, false), true);
});

// ---- InputActivity

test('InputActivity: counts are counter deltas summed over 10, 30 and 60 s; the first sample counts nothing', () => {
  const a = new InputActivity();
  const idles = { key: 0, pointer: 0, scroll: 0, click: 0 };
  const at = (keys: number, left: number, right: number, scrolls: number, moves: number) => ({ keys, leftClicks: left, rightClicks: right, scrolls, moves });
  assert.equal(a.record(0, at(100, 10, 10, 10, 10), 'a', idles).keys10s, 0);
  a.record(1, at(105, 11, 12, 13, 14), 'a', idles);
  const s = a.record(20, at(110, 11, 12, 15, 14), 'a', idles);
  assert.deepEqual([s.keys10s, s.keys60s, s.clicks10s, s.scrolls30s, s.moves10s], [5, 10, 0, 5, 0]);
  assert.equal(a.record(61, at(110, 11, 12, 15, 14), 'a', idles).keys60s, 5);
});

test('InputActivity: a counter that wraps at 2^32 still counts the step', () => {
  const a = new InputActivity();
  const idles = { key: 0, pointer: 0, scroll: 0, click: 0 };
  a.record(0, { keys: 4294967295, leftClicks: 0, rightClicks: 0, scrolls: 0, moves: 0 }, 'a', idles);
  assert.equal(a.record(1, { keys: 2, leftClicks: 0, rightClicks: 0, scrolls: 0, moves: 0 }, 'a', idles).keys10s, 3);
});

test('InputActivity: a front app change is a switch; no front app in between is skipped', () => {
  const a = new InputActivity();
  const idles = { key: 0, pointer: 0, scroll: 0, click: 0 };
  const zero = { keys: 0, leftClicks: 0, rightClicks: 0, scrolls: 0, moves: 0 };
  a.record(0, zero, 'a', idles);
  a.record(1, zero, null, idles);
  assert.equal(a.record(2, zero, 'a', idles).switches60s, 0);
  assert.equal(a.record(3, zero, 'b', idles).switches60s, 1);
});

// ---- Presence edges, sleep, beats

test('helperEdge: lock and unlock pass; sleep, wake and the display edges go through the sleep state (CONTRACT §7.3)', () => {
  assert.deepEqual(helperEdge('lock'), { lock: true });
  assert.deepEqual(helperEdge('unlock'), { lock: false });
  assert.deepEqual(helperEdge('sleep'), { system: true });
  assert.deepEqual(helperEdge('wake'), { system: false });
  assert.deepEqual(helperEdge('display_sleep'), { display: true });
  assert.deepEqual(helperEdge('display_wake'), { display: false });
  assert.equal(helperEdge('nap'), null);
});

test('AttentionSleepState: asleep while the system or the display sleeps; wake only once both woke', () => {
  const s = new AttentionSleepState();
  assert.equal(s.update({ display: true }), 'sleep');
  assert.equal(s.update({ system: true }), null);
  assert.equal(s.update({ system: false }), null);
  assert.equal(s.asleep, true);
  assert.equal(s.update({ display: false }), 'wake');
  assert.equal(s.asleep, false);
});

test('PresenceEdges: the same edge on its pair within 2 s goes through once; the other pair is separate', () => {
  const e = new PresenceEdges();
  assert.equal(e.observe('lock', 0), 'lock');
  assert.equal(e.observe('lock', 1.9), null);
  assert.equal(e.observe('sleep', 1.9), 'sleep');
  assert.equal(e.observe('unlock', 2), 'unlock');
  assert.equal(e.observe('lock', 2.1), 'lock');
  assert.equal(e.observe('lock', 4.25), 'lock');
});

test('AttentionBeats: a beat each second while running, a poll while paused, a beat at once when the pause ends', () => {
  const calls: string[] = [];
  let fire: (() => void) | null = null;
  let interval = 0;
  const beats = new AttentionBeats(() => calls.push('beat'), () => calls.push('poll'),
    (ms, fn) => { interval = ms; fire = fn; return () => { fire = null; }; });
  assert.equal(beats.running, false);
  beats.start();
  beats.start();
  assert.equal(interval, 1000);
  fire!();
  beats.setPaused(true);
  fire!();
  beats.setPaused(false);
  assert.deepEqual(calls, ['beat', 'poll', 'beat']);
  beats.stop();
  assert.equal(fire, null);
  beats.setPaused(true);
  beats.setPaused(false);
  assert.deepEqual(calls, ['beat', 'poll', 'beat']);
});

// ---- The coarse beat

const COARSE_KEYS = ['ts', 'idle_s', 'locked', 'asleep', 'edge', 'fullscreen', 'front_video', 'front_audio_out', 'front_gpu', 'camera_active',
  'mic_active', 'screen_captured', 'user_speaking', 'input'];
const SNAPSHOT: InputSnapshot = { idles: { key: 1.4, pointer: 0.2, scroll: 12, click: 3.5 }, keys10s: 3, keys60s: 9, clicks10s: 2, scrolls30s: 1,
  moves10s: 5, switches60s: 1, nearClicks10s: 4 };

const coarse = (r: Record<string, unknown>, o: Partial<Parameters<typeof coarseBeat>[1]> = {}, input = true) => coarseBeat(decodeAttention(r), {
  displays: [{ x: 0, y: 0, width: 1440, height: 900 }], asleep: false, edge: null, userSpeaking: null, screenCaptured: null, ownPids: OWN,
  input: null, ...o,
}, { input });

test('coarseBeat: only the coarse keys whatever the reading holds; input only while sense_input_counts is on', () => {
  const r = reply({
    front: { pid: 611, name: 'Safari', app_id: 'com.apple.Safari', category: 'public.app-category.productivity', focused_window_title: 'Bank — Statement',
      window: { window_id: 812, pid: 611, bounds: { x: 0, y: 0, width: 1440, height: 900 }, title: 'Release notes', app_name: 'Safari', app_id: 'com.apple.Safari' } },
    mic_active: true, front_gpu_busy: 0.3,
    audio_clients: [{ pid: 611, app_id: 'com.apple.Safari', name: 'Safari', running_input: false, running_output: true },
      { pid: 9, app_id: 'us.zoom.xos', name: 'zoom.us', running_input: true, running_output: null }],
  });
  const on = coarse(r, { input: SNAPSHOT, edge: 'lock', asleep: true, userSpeaking: true, screenCaptured: false });
  assert.ok(Object.keys(on).every((k) => COARSE_KEYS.includes(k)), Object.keys(on).join(' '));
  assert.deepEqual(on, {
    ts: 1763539200.25, idle_s: 1.4, locked: false, asleep: true, edge: 'lock', fullscreen: true, front_video: true, front_audio_out: true,
    front_gpu: 0.3, camera_active: false, mic_active: true, screen_captured: false, user_speaking: true,
    input: { key_idle_s: 1.4, pointer_idle_s: 0.2, keys_10s: 3, keys_60s: 9, switches_60s: 1 },
  });
  for (const s of ['Safari', 'Release notes', 'Bank', 'zoom', '812', '611', 'productivity']) assert.ok(!JSON.stringify(on).includes(s), s);
  const off = coarse(r, { input: SNAPSHOT }, false);
  assert.equal('input' in off, false);
  assert.ok(Object.keys(off).every((k) => COARSE_KEYS.includes(k)));
});

test('coarseBeat: unknown fields are null; no front app has no video, GPU or audio out, and is not fullscreen', () => {
  assert.deepEqual(coarse(reply({ front: null, camera_active: null, mic_active: null, audio_clients: null, video_pids: null })), {
    ts: 1763539200.25, idle_s: 1.4, locked: false, asleep: false, edge: null, fullscreen: false, front_video: null, front_audio_out: null,
    front_gpu: null, camera_active: null, mic_active: null, screen_captured: null, user_speaking: null,
  });
});

test('coarseBeat: the mic is not in use when only this shell records with it', () => {
  const client = (pid: number, input: boolean) => ({ pid, app_id: `app${pid}`, name: `app${pid}`, running_input: input, running_output: false });
  assert.equal(coarse(textEdit({ mic_active: true, audio_clients: [client(4000, true), client(9, false)] })).mic_active, false);
  assert.equal(coarse(textEdit({ mic_active: true, audio_clients: [client(4000, true), client(9, true)] })).mic_active, true);
  assert.equal(coarse(textEdit({ mic_active: true, audio_clients: [] })).mic_active, true);
  assert.equal(coarse(textEdit({ mic_active: false, audio_clients: [client(9, false)] })).mic_active, false);
});

// ---- Log lines

test('gateLine and focusLine: the ATTENTION log lines, nil written as nil', () => {
  const s = sample(textEdit({ camera_active: null, mic_active: true }), { userSpeaking: false });
  assert.equal(gateLine(s), 'ATTENTION gate fullscreen=false camera=nil mic=true speaking=false');
  assert.equal(focusLine(s), 'ATTENTION focus_window role=AXWindow subrole=AXStandardWindow');
  assert.equal(focusLine(sample(textEdit({ focus_window_role: null, focus_window_subrole: null }))), 'ATTENTION focus_window nil');
});
