import sys
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

BROWSER = Path(__file__).resolve().parents[2] / "browser"
EXTENSION = BROWSER / "extension"


def extension_id(key):
    digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


class ExtensionTest(unittest.TestCase):
    def test_manifest_never_runs_in_incognito_and_asks_only_what_it_uses(self):
        manifest = json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["incognito"], "not_allowed")
        self.assertTrue(all(not script.get("all_frames", False) for script in manifest["content_scripts"]))
        self.assertEqual(sorted(manifest["permissions"]), ["alarms", "nativeMessaging", "storage", "tabs"])
        self.assertEqual(manifest["background"], {"service_worker": "background.js", "type": "module"})

    @unittest.skipUnless(shutil.which("node"), "node not installed")
    def test_lib_helpers(self):
        result = subprocess.run(["node", "--test", *map(str, sorted(EXTENSION.glob("test_*.mjs")))], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_install_writes_a_host_manifest_for_the_fixed_extension_id(self):
        with tempfile.TemporaryDirectory() as home:
            state = Path(home) / "state dir"
            env = {**os.environ, "HOME": home}
            out = subprocess.run(["sh", str(BROWSER / "install.sh"), str(state)], env=env,
                                 capture_output=True, text=True, check=True, encoding="utf-8").stdout
            host = Path(home) / "Library/Application Support/Google/Chrome/NativeMessagingHosts/local.agenticcomplex.agentd.json"
            self.assertIn(str(host), out)
            data = json.loads(host.read_text(encoding="utf-8"))
            key = json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))["key"]
            self.assertEqual(data["allowed_origins"], [f"chrome-extension://{extension_id(key)}/"])
            self.assertEqual((data["name"], data["type"], data["path"]),
                             ("local.agenticcomplex.agentd", "stdio", str(state / "native-host.sh")))
            wrapper = (state / "native-host.sh").read_text(encoding="utf-8")
            self.assertIn(str(BROWSER / "native_host.py"), wrapper)
            self.assertIn(f'--state-dir "{state}"', wrapper)
            self.assertEqual((state / "native-host.sh").stat().st_mode & 0o777, 0o700)


if __name__ == "__main__":
    unittest.main()
