"""<state-dir>/blacklist.json (C10): windows, domains and titles that never leave the collector.

Collectors drop matches before sending; agentd checks again on receive. In "allow" mode (the default) only the
windows and hosts on the allow lists are read."""
import json
import os
import re
import threading

from fsutil import atomic_write_json
from infra.paths import COMPANION_BUNDLE

HIDDEN = {"app": "<hidden>"}
FIELDS = ("bundle_ids", "app_names", "domains", "title_patterns")  # the lists POST /blacklist may add to
ALLOW_FIELDS = ("bundle_ids", "app_names", "domains")  # the lists of "allow"
MODES = ("allow", "deny")
WINDOW_KEYS = ("app", "bundle_id", "pid", "window_id", "title", "url_host", "category")
TITLE_MAX = 256
# Never observe the control panel itself, even with an old or customized blacklist.json; on Windows its app_id is the
# lower-case tools/release/package_windows.py EXECUTABLE.
# Other local.agenticcomplex.* bundles (including user test fixtures) are not implicitly hidden.
CONTROL_PANEL_BUNDLES = frozenset((COMPANION_BUNDLE, "agentic complex.exe"))
DEFAULTS = {
    "schema": 1,
    "bundle_ids": ["com.1password.1password", "com.agilebits.onepassword7", "com.bitwarden.desktop",
                   "com.apple.keychainaccess", "com.apple.Passwords", "com.tencent.xinWeChat",
                   "com.tencent.qq", "com.tinyspeck.slackmacgap", "ru.keepcoder.Telegram",
                   "net.whatsapp.WhatsApp", "com.apple.MobileSMS", "com.hnc.Discord", "jp.naver.line.mac",
                   # Windows: the helper's app_id, a lower-case exe name or a packaged app's AUMID.
                   "1password.exe", "bitwarden.exe", "keepass.exe", "keepassxc.exe", "wechat.exe", "weixin.exe",
                   "qq.exe", "slack.exe", "telegram.exe", "whatsapp.exe", "5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App",
                   "discord.exe", "line.exe", "endfield.exe"],
    "app_names": ["Endfield.exe", "Arknights: Endfield", "明日方舟：终末地"],
    "domains": ["1password.com", "bitwarden.com", "icbc.com.cn", "ccb.com", "boc.cn", "abchina.com",
                "bankcomm.com", "cmbchina.com", "paypal.com", "alipay.com", "web.whatsapp.com",
                "web.telegram.org", "discord.com", "app.slack.com", "wx.qq.com"],
    "title_patterns": [],
    "incognito": True,
    "mode": "allow",
    "allow": {"bundle_ids": [], "app_names": [], "domains": []},
}


class Blacklist:
    def __init__(self, path):
        self.path = path
        if not path.exists():
            with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w", encoding="utf-8") as stream:
                stream.write(json.dumps(DEFAULTS, ensure_ascii=False, indent=2) + "\n")
        self._mtime = None
        self.revision = 0  # +1 each time the file is read
        self._lock = threading.Lock()  # one add() reads and rewrites the file at a time
        self._load()

    def _load(self):
        stat = self.path.stat()
        mtime = stat.st_mtime_ns
        if mtime == self._mtime:
            return
        if stat.st_mode & 0o077:  # it lists what the user hides: private like the other state files
            self.path.chmod(0o600)
        self.data = json.loads(self.path.read_text(encoding="utf-8"))
        self._bundles = set(self.data.get("bundle_ids", []))
        self._names = {n.casefold() for n in self.data.get("app_names", [])}
        self._domains = [d.casefold() for d in self.data.get("domains", [])]
        self._titles = [re.compile(p) for p in self.data.get("title_patterns", [])]
        self.mode = self.data.get("mode") if self.data.get("mode") in MODES else "allow"
        allow = self.data.get("allow", {})
        self._allow_bundles = set(allow.get("bundle_ids", []))
        self._allow_names = {n.casefold() for n in allow.get("app_names", [])}
        self._allow_domains = [d.casefold() for d in allow.get("domains", [])]
        self._mtime = mtime
        self.revision += 1

    def add(self, field, value):
        """Appends value to field's list once, rewrites the file atomically (0600) and reloads; True when added."""
        with self._lock:
            self._load()
            values = self.data.get(field, [])
            if value in values:
                return False
            self._write({**self.data, field: values + [value]})
            return True

    def restore_defaults(self):
        """Puts back the DEFAULTS entries of bundle_ids, app_names and domains the file lacks, as add() does; how
        many."""
        with self._lock:
            self._load()
            missing = {field: [v for v in DEFAULTS[field] if v not in self.data.get(field, [])]
                       for field in ("bundle_ids", "app_names", "domains")}
            added = sum(len(values) for values in missing.values())
            if added:
                self._write({**self.data, **{field: self.data.get(field, []) + values
                                             for field, values in missing.items()}})
            return added

    def remove(self, field, value):
        """Drops value from field's list, rewrites the file atomically (0600) and reloads; True when it was there."""
        with self._lock:
            self._load()
            values = self.data.get(field, [])
            if value not in values:
                return False
            self._write({**self.data, field: [v for v in values if v != value]})
            return True

    def allow_add(self, field, value):
        """Appends value to the allow list `field` once, as add() does; True when added."""
        with self._lock:
            self._load()
            allow = self.data.get("allow", {})
            values = allow.get(field, [])
            if value in values:
                return False
            self._write({**self.data, "allow": {**allow, field: values + [value]}})
            return True

    def allow_remove(self, field, value):
        """Drops value from the allow list `field`, as remove() does; True when it was there."""
        with self._lock:
            self._load()
            allow = self.data.get("allow", {})
            values = allow.get(field, [])
            if value not in values:
                return False
            self._write({**self.data, "allow": {**allow, field: [v for v in values if v != value]}})
            return True

    def set_mode(self, mode):
        """Writes "allow" or "deny" as the file's mode, rewriting it atomically (0600)."""
        with self._lock:
            self._load()
            self._write({**self.data, "mode": mode})

    def _write(self, data):
        atomic_write_json(self.path, {**data, "schema": DEFAULTS["schema"]}, 0o600, newline=True, ensure_ascii=False,
                          indent=2)
        self._mtime = None  # reload even when the new file's mtime equals the old one's
        self._load()

    def hides(self, window):
        self._load()
        app = window.get("app")
        if window.get("bundle_id") in CONTROL_PANEL_BUNDLES:
            return True
        if self.mode == "allow":
            host = window.get("url_host")
            if host:
                return self.hides_domain(host)
            return window.get("bundle_id") not in self._allow_bundles \
                and not (isinstance(app, str) and app and app.casefold() in self._allow_names)
        if window.get("bundle_id") in self._bundles \
                or isinstance(app, str) and app and app.casefold() in self._names:
            return True
        host = window.get("url_host")
        if host and self.hides_domain(host):
            return True
        title = window.get("title") or ""
        return any(p.search(title) for p in self._titles)

    def hides_domain(self, host):
        self._load()
        host = host.casefold()
        if self.mode == "allow":
            return not any(host == d or host.endswith("." + d) for d in self._allow_domains)
        return any(host == d or host.endswith("." + d) for d in self._domains)

    def scrub(self, window):
        """The window with only known keys, or HIDDEN when it is blacklisted; None stays None."""
        if window is None:
            return None
        if window.get("app") == HIDDEN["app"] or self.hides(window):
            return dict(HIDDEN)
        kept = {k: window[k] for k in WINDOW_KEYS if k in window}
        if isinstance(kept.get("title"), str):
            kept["title"] = kept["title"][:TITLE_MAX]
        if "url_host" in kept and not (isinstance(kept["url_host"], str) and bare_host(kept["url_host"])):
            kept["url_host"] = None  # a host only, never a URL
        return kept


def entry_hides(field, value, window):
    """Whether the one entry `value` of `field` hides window, by the rule hides() applies to that field."""
    if field == "bundle_ids":
        return window.get("bundle_id") == value
    if field == "app_names":
        app = window.get("app")
        return isinstance(app, str) and bool(app) and app.casefold() == value.casefold()
    if field == "domains":
        host, domain = (window.get("url_host") or "").casefold(), value.casefold()
        return bool(host) and (host == domain or host.endswith("." + domain))
    return re.search(value, window.get("title") or "") is not None


def bare_host(value):
    return value and not any(c in value for c in "/?#@ ")
