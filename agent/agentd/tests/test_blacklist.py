import json
import os
from pathlib import Path
import re
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from observation.blacklist import DEFAULTS, HIDDEN, Blacklist, entry_hides  # noqa: E402


class BlacklistTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "blacklist.json"
        self.deny = {**DEFAULTS, "mode": "deny"}

    def denying(self):
        """A Blacklist on the default lists in deny mode."""
        self.path.write_text(json.dumps(self.deny), encoding="utf-8")
        return Blacklist(self.path)

    def test_defaults_are_written_when_missing(self):
        Blacklist(self.path)
        data = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(data, DEFAULTS)
        self.assertEqual(data["schema"], 1)
        self.assertIn("com.apple.keychainaccess", data["bundle_ids"])
        self.assertIn("Endfield.exe", data["app_names"])
        self.assertTrue(data["incognito"])
        self.assertEqual((data["mode"], data["allow"]), ("allow", {"bundle_ids": [], "app_names": [], "domains": []}))

    def test_defaults_hide_the_same_apps_on_windows_by_the_helpers_app_id(self):
        blacklist = self.denying()
        for app_id, name in (("1password.exe", "1Password"), ("bitwarden.exe", "Bitwarden"), ("keepassxc.exe", "KeePassXC"),
                             ("keepass.exe", "KeePass"), ("wechat.exe", "WeChat"), ("weixin.exe", "Weixin"), ("qq.exe", "QQ"),
                             ("slack.exe", "Slack"), ("telegram.exe", "Telegram Desktop"), ("whatsapp.exe", "WhatsApp"),
                             ("5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App", "WhatsApp"), ("discord.exe", "Discord"),
                             ("line.exe", "LINE"), ("endfield.exe", "Arknights: Endfield Game")):
            with self.subTest(app_id=app_id):
                self.assertTrue(blacklist.hides({"app": name, "bundle_id": app_id, "title": "chat"}))
                self.assertEqual(blacklist.scrub({"app": name, "bundle_id": app_id, "pid": 4}), HIDDEN)
        self.assertFalse(blacklist.hides({"app": "记事本", "bundle_id": "notepad.exe", "title": "x"}))

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_defaults_file_is_private_whatever_the_umask(self):
        old = os.umask(0o022)
        try:
            Blacklist(self.path)
        finally:
            os.umask(old)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_an_open_existing_file_is_tightened_at_load(self):
        self.path.write_text(json.dumps(DEFAULTS), encoding="utf-8")
        self.path.chmod(0o644)
        Blacklist(self.path)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_control_panel_is_always_excluded_even_when_the_file_lists_nothing(self):
        self.path.write_text(json.dumps({"schema": 1, "bundle_ids": [], "app_names": [], "domains": [], "incognito": False,
                                         "mode": "deny"}), encoding="utf-8")
        before = self.path.read_bytes()
        blacklist = Blacklist(self.path)
        bundle = "local.agenticcomplex.companion"
        self.assertTrue(blacklist.hides({"app": "Endfield", "bundle_id": bundle}))
        self.assertEqual(blacklist.scrub({"app": "Endfield", "bundle_id": bundle, "title": "private"}), HIDDEN)
        self.assertFalse(blacklist.hides({"app": "Fixture", "bundle_id": "local.agenticcomplex.controlfixture"}))
        # On Windows the helper's app_id of the packaged exe: its lower-case name.
        packager = (Path(__file__).resolve().parents[3] / "tools/release/package_windows.py").read_text(encoding="utf-8")
        [executable] = re.findall(r"^EXECUTABLE = '([^']+)'$", packager, re.M)
        windows = {"app": "Agentic Complex", "bundle_id": executable.lower(), "title": "private"}
        self.assertTrue(blacklist.hides(windows))
        self.assertEqual(blacklist.scrub(windows), HIDDEN)
        self.assertEqual(self.path.read_bytes(), before, "existing user blacklist is not rewritten")

    def test_existing_file_is_kept(self):
        self.path.write_text(json.dumps({**DEFAULTS, "bundle_ids": ["x.y"]}), encoding="utf-8")
        self.assertEqual(Blacklist(self.path).data["bundle_ids"], ["x.y"])

    def test_window_matches_bundle_id_and_app_name(self):
        bl = self.denying()
        self.assertTrue(bl.hides({"app": "Keychain Access", "bundle_id": "com.apple.keychainaccess"}))
        self.assertTrue(bl.hides({"app": "endfield.EXE", "bundle_id": None}))
        self.assertFalse(bl.hides({"app": "Safari", "bundle_id": "com.apple.Safari", "title": "新闻"}))

    def test_missing_or_null_app_matches_no_name(self):
        self.path.write_text(json.dumps({**self.deny, "app_names": ["None", ""]}), encoding="utf-8")
        bl = Blacklist(self.path)
        self.assertFalse(bl.hides({"app": None, "bundle_id": None}))
        self.assertFalse(bl.hides({"bundle_id": "x.y"}))
        self.assertTrue(bl.hides({"app": "none", "bundle_id": None}))

    def test_domain_matches_host_or_subdomain_only(self):
        bl = self.denying()
        self.assertTrue(bl.hides_domain("icbc.com.cn"))
        self.assertTrue(bl.hides_domain("mybank.icbc.com.cn"))
        self.assertFalse(bl.hides_domain("noticbc.com.cn"))
        self.assertFalse(bl.hides_domain("github.com"))

    def test_title_pattern_and_reload_on_change(self):
        bl = self.denying()
        window = {"app": "Notes", "bundle_id": "com.apple.Notes", "title": "工资条 2026"}
        self.assertFalse(bl.hides(window))
        self.path.write_text(json.dumps({**self.deny, "title_patterns": ["工资"]}), encoding="utf-8")
        stat = self.path.stat()
        os.utime(self.path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 10**9))
        self.assertTrue(bl.hides(window))

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_add_appends_once_writes_a_private_file_and_reloads(self):
        bl = self.denying()
        window = {"app": "Notes", "bundle_id": "com.apple.Notes", "title": "t"}
        revision = bl.revision
        self.assertTrue(bl.add("bundle_ids", "com.apple.Notes"))
        self.assertTrue(bl.hides(window))
        self.assertEqual(bl.revision, revision + 1)
        self.assertFalse(bl.add("bundle_ids", "com.apple.Notes"))
        data = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(data["bundle_ids"].count("com.apple.Notes"), 1)
        self.assertEqual({k: v for k, v in data.items() if k != "bundle_ids"},
                         {k: v for k, v in self.deny.items() if k != "bundle_ids"})
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(os.listdir(self.tmp.name), ["blacklist.json"])

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_remove_drops_an_entry_writes_a_private_file_and_reloads(self):
        bl = self.denying()
        window = {"app": "Notes", "bundle_id": "com.apple.Notes", "title": "t"}
        bl.add("bundle_ids", "com.apple.Notes")
        self.path.chmod(0o644)
        revision = bl.revision
        self.assertTrue(bl.remove("bundle_ids", "com.apple.Notes"))
        self.assertFalse(bl.hides(window))
        self.assertEqual(bl.revision, revision + 1)
        self.assertFalse(bl.remove("bundle_ids", "com.apple.Notes"))
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8")), self.deny)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(os.listdir(self.tmp.name), ["blacklist.json"])

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_restore_defaults_puts_back_only_the_missing_default_entries(self):
        bl = Blacklist(self.path)
        bl.remove("bundle_ids", "com.tencent.qq")
        bl.remove("domains", "paypal.com")
        bl.add("domains", "x.com")
        bl.add("title_patterns", "工资")
        self.path.write_text(json.dumps({**bl.data, "incognito": False}), encoding="utf-8")
        stat = self.path.stat()
        os.utime(self.path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 10**9))
        self.path.chmod(0o644)
        self.assertEqual(bl.restore_defaults(), 2)
        data = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(sorted(data["bundle_ids"]), sorted(DEFAULTS["bundle_ids"]))
        self.assertEqual(sorted(data["domains"]), sorted(DEFAULTS["domains"] + ["x.com"]))
        self.assertEqual((data["app_names"], data["title_patterns"], data["incognito"]),
                         (DEFAULTS["app_names"], ["工资"], False))
        self.assertTrue(bl.hides({"app": "QQ", "bundle_id": "com.tencent.qq"}))
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(bl.restore_defaults(), 0)
        self.assertEqual(os.listdir(self.tmp.name), ["blacklist.json"])

    def test_one_entry_hides_what_hides_would_for_it_alone(self):
        for field, value, window, expected in (
                ("bundle_ids", "a.b", {"bundle_id": "a.b"}, True), ("bundle_ids", "a.b", {"bundle_id": "a.c"}, False),
                ("app_names", "Notes", {"app": "notes"}, True), ("app_names", "Notes", {"app": None}, False),
                ("domains", "x.com", {"url_host": "m.x.com"}, True), ("domains", "x.com", {"url_host": "ax.com"}, False),
                ("title_patterns", "工资", {"title": "工资条"}, True), ("title_patterns", "工资", {"title": None}, False)):
            with self.subTest(field=field, window=window):
                self.assertEqual(entry_hides(field, value, window), expected)

    def test_scrub_keeps_known_keys_or_hides(self):
        bl = self.denying()
        self.assertEqual(bl.scrub({"app": "Keychain Access", "bundle_id": "com.apple.keychainaccess",
                                   "title": "login"}), HIDDEN)
        self.assertEqual(bl.scrub({"app": "<hidden>", "title": "leak"}), HIDDEN)
        self.assertEqual(bl.scrub({"app": "Safari", "bundle_id": "com.apple.Safari", "pid": 1,
                                   "window_id": 2, "title": "t", "extra": "dropped"}),
                         {"app": "Safari", "bundle_id": "com.apple.Safari", "pid": 1, "window_id": 2, "title": "t"})
        self.assertIsNone(bl.scrub(None))

    def test_scrub_keeps_category_only_on_a_shown_window(self):
        bl = self.denying()
        category = "public.app-category.developer-tools"
        self.assertEqual(bl.scrub({"app": "Code", "bundle_id": "com.microsoft.VSCode", "category": category}),
                         {"app": "Code", "bundle_id": "com.microsoft.VSCode", "category": category})
        self.assertEqual(bl.scrub({"app": "Keychain Access", "bundle_id": "com.apple.keychainaccess",
                                   "category": "public.app-category.utilities"}), HIDDEN)

    def test_an_empty_allow_list_hides_everything(self):
        bl = Blacklist(self.path)
        for window in ({"app": "Code", "bundle_id": "com.microsoft.VSCode"}, {"app": "Safari", "url_host": "github.com"},
                       {"app": None, "bundle_id": None}, {}):
            with self.subTest(window=window):
                self.assertTrue(bl.hides(window))
        self.assertTrue(bl.hides_domain("github.com"))
        self.assertEqual(bl.scrub({"app": "Code", "bundle_id": "com.microsoft.VSCode"}), HIDDEN)

    def test_allow_mode_shows_only_listed_apps_and_browser_hosts(self):
        allow = {"bundle_ids": ["com.microsoft.VSCode", "local.agenticcomplex.companion"], "app_names": ["Terminal"],
                 "domains": ["GitHub.com", "icbc.com.cn"]}
        self.path.write_text(json.dumps({**DEFAULTS, "title_patterns": ["工资"], "allow": allow}), encoding="utf-8")
        bl = Blacklist(self.path)
        for window, hidden in (
                ({"app": "Code", "bundle_id": "com.microsoft.VSCode", "title": "工资"}, False),
                ({"app": "terminal", "bundle_id": "com.apple.Terminal"}, False),
                ({"app": "Notes", "bundle_id": "com.apple.Notes"}, True),
                ({"app": "Safari", "bundle_id": "com.apple.Safari"}, True),
                ({"app": "Safari", "bundle_id": "com.apple.Safari", "url_host": "gist.GITHUB.com"}, False),
                ({"app": "Safari", "bundle_id": "com.apple.Safari", "url_host": "mybank.icbc.com.cn"}, False),
                ({"app": "Safari", "bundle_id": "com.apple.Safari", "url_host": "notgithub.com"}, True),
                ({"app": "Code", "bundle_id": "com.microsoft.VSCode", "url_host": "example.com"}, True),
                ({"app": "Code", "bundle_id": "com.microsoft.VSCode", "url_host": ""}, False),
                ({"app": "Endfield", "bundle_id": "local.agenticcomplex.companion"}, True)):
            with self.subTest(window=window):
                self.assertEqual(bl.hides(window), hidden)
        for host, hidden in (("github.com", False), ("API.github.com", False), ("example.com", True),
                             ("hubgithub.com", True)):
            with self.subTest(host=host):
                self.assertEqual(bl.hides_domain(host), hidden)

    def test_a_missing_or_unknown_mode_reads_as_allow(self):
        for mode in (None, "block", 1):
            with self.subTest(mode=mode):
                data = {k: v for k, v in self.deny.items() if k != "mode"}
                if mode is not None:
                    data["mode"] = mode
                self.path.write_text(json.dumps({k: v for k, v in data.items() if k != "allow"}), encoding="utf-8")
                self.assertTrue(Blacklist(self.path).hides({"app": "Safari", "bundle_id": "com.apple.Safari"}))
        self.path.write_text(json.dumps(self.deny), encoding="utf-8")
        self.assertFalse(Blacklist(self.path).hides({"app": "Safari", "bundle_id": "com.apple.Safari"}))

    @unittest.skipIf(sys.platform == "win32", "POSIX mode bits, uid or FIFO; on Windows the state directory's DACL protects these files")
    def test_allow_entries_and_mode_rewrite_a_private_file_and_reload(self):
        bl = Blacklist(self.path)
        window = {"app": "Code", "bundle_id": "com.microsoft.VSCode"}
        revision = bl.revision
        self.path.chmod(0o644)
        self.assertTrue(bl.allow_add("bundle_ids", "com.microsoft.VSCode"))
        self.assertFalse(bl.hides(window))
        self.assertEqual(bl.revision, revision + 1)
        self.assertFalse(bl.allow_add("bundle_ids", "com.microsoft.VSCode"))
        self.assertTrue(bl.allow_add("domains", "github.com"))
        data = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(data["allow"], {"bundle_ids": ["com.microsoft.VSCode"], "app_names": [], "domains": ["github.com"]})
        self.assertEqual({k: v for k, v in data.items() if k != "allow"}, {k: v for k, v in DEFAULTS.items() if k != "allow"})
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

        self.path.chmod(0o644)
        bl.set_mode("deny")
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8"))["mode"], "deny")
        self.assertFalse(bl.hides({"app": "Notes", "bundle_id": "com.apple.Notes"}))
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        bl.set_mode("allow")
        self.assertTrue(bl.hides({"app": "Notes", "bundle_id": "com.apple.Notes"}))

        self.path.chmod(0o644)
        self.assertTrue(bl.allow_remove("bundle_ids", "com.microsoft.VSCode"))
        self.assertTrue(bl.hides(window))
        self.assertFalse(bl.allow_remove("bundle_ids", "com.microsoft.VSCode"))
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8"))["allow"]["bundle_ids"], [])
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(os.listdir(self.tmp.name), ["blacklist.json"])


if __name__ == "__main__":
    unittest.main()
