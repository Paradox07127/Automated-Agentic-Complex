import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "tools/platform/sign_bundle.sh"
SIGN = ["--force", "--timestamp=none", "--sign", "Test Identity"]
ENTITLEMENTS = ROOT / "app/packaging/entitlements"
DEVELOPER_ID = "Developer ID Application: Test Identity"
HELPERS = {"": "helper", " (GPU)": "helper-gpu", " (Renderer)": "helper-renderer", " (Plugin)": "helper-plugin"}
# The calls sign_bundle.sh made for electron_payloads() before Developer ID support: {root} is the test
# directory, {identity} the signing identity.
BEFORE = [
    "{root}/runtime.python/payload/lib/python3.12/lib-dynload/_ssl.cpython-312-darwin.so",
    "{root}/runtime.python/payload/bin/python3.12",
    "{root}/harness.pi/payload/node/bin/node",
    "{root}/Agentic Complex.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler",
    "{root}/Agentic Complex.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib",
    "{root}/Agentic Complex.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
    "{root}/Agentic Complex.app/Contents/Resources/app/dist/native/preview.node",
    "{root}/Agentic Complex.app/Contents/Frameworks/Agentic Complex Helper (GPU).app",
    "{root}/Agentic Complex.app/Contents/Frameworks/Agentic Complex Helper (Plugin).app",
    "{root}/Agentic Complex.app/Contents/Frameworks/Agentic Complex Helper (Renderer).app",
    "{root}/Agentic Complex.app/Contents/Frameworks/Agentic Complex Helper.app",
    "{root}/Agentic Complex.app/Contents/Frameworks/Electron Framework.framework",
    "{root}/Agentic Complex.app/Contents/MacOS/AgenticComplexMetalAvatar",
    "{root}/Agentic Complex.app/Contents/MacOS/ac-helper",
    "{root}/Agentic Complex.app/Contents/XPCServices/local.example.preview.xpc",
    "{root}/Agentic Complex.app",
]


class SignBundleTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir=ROOT, prefix=".test-sign-bundle-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.log = self.root / "codesign.jsonl"
        self.log.write_text("")
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        codesign = bin_dir / "codesign"
        codesign.write_text(f"#!{sys.executable}\n" + """
import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
with open(os.environ["CODESIGN_LOG"], "a") as log:
    log.write(json.dumps(args) + "\\n")
# Make accidental file signing observable without calling real codesign.
if args[0] == "--force" and Path(args[-1]).is_file():
    with open(args[-1], "ab") as target:
        target.write(b"\\nfake signature\\n")
if args[0] == "-d":
    print("designated => fake requirement")
""")
        codesign.chmod(0o755)
        self.env = dict(os.environ, PATH=str(bin_dir) + os.pathsep + os.environ["PATH"],
                        CODESIGN_LOG=str(self.log), AAC_SIGN_IDENTITY=SIGN[-1], LC_ALL="C")

    def macho(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy("/usr/bin/true", path)
        return path

    def bundle(self, path, exe="main"):
        self.macho(path / "Contents/MacOS" / exe)
        (path / "Contents/Info.plist").write_bytes(plistlib.dumps({"CFBundleExecutable": exe}))
        return path

    def electron_app(self):
        app = self.bundle(self.root / "Agentic Complex.app", "AgenticComplex")
        contents = app / "Contents"
        self.macho(contents / "MacOS/AgenticComplexMetalAvatar")
        self.macho(contents / "MacOS/ac-helper")
        framework = contents / "Frameworks/Electron Framework.framework"
        version = framework / "Versions/A"
        self.macho(version / "Electron Framework")
        self.macho(version / "Libraries/libffmpeg.dylib")
        self.macho(version / "Helpers/chrome_crashpad_handler")
        (version / "Resources").mkdir()
        (version / "Resources/Info.plist").write_bytes(plistlib.dumps({
            "CFBundleExecutable": "Electron Framework", "CFBundlePackageType": "FMWK"}))
        (framework / "Versions/Current").symlink_to("A")
        for name in ("Electron Framework", "Libraries", "Helpers", "Resources"):
            (framework / name).symlink_to("Versions/Current/" + name)
        for suffix in HELPERS:
            self.bundle(contents / f"Frameworks/Agentic Complex Helper{suffix}.app", f"Agentic Complex Helper{suffix}")
        self.bundle(contents / "XPCServices/local.example.preview.xpc", "AgenticComplexMetalPreview")
        self.macho(contents / "Resources/app/dist/native/preview.node")
        (contents / "Resources/app/dist/main.mjs").write_text("")
        self.macho(contents / "Resources/components/harness.pi/payload/node/bin/node")
        return app

    def electron_payloads(self):
        python = self.root / "runtime.python/payload"
        self.macho(python / "bin/python3.12")
        (python / "bin/python3").symlink_to("python3.12")
        (python / "bin/python3.12-config").write_text("#!/bin/sh\n")
        self.macho(python / "lib/python3.12/lib-dynload/_ssl.cpython-312-darwin.so")
        node = self.macho(self.root / "harness.pi/payload/node/bin/node").parents[2]
        return python, node, self.electron_app()

    def sign(self, *args, identity=SIGN[-1]):
        result = subprocess.run(["bash", str(SCRIPT), *map(str, args)], cwd=self.root,
                                env=dict(self.env, AAC_SIGN_IDENTITY=identity), capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = [json.loads(line) for line in self.log.read_text().splitlines()]
        return result, calls

    def test_payload_signs_only_its_contents_inside_out(self):
        payload = self.root / "component payload"
        outer = self.bundle(payload / "Outer.app")
        inner = self.bundle(outer / "Contents/PlugIns/Inner.bundle")
        bundles = [outer, inner]
        for suffix in ("framework", "plugin", "appex", "xpc"):
            bundles.append(self.bundle(payload / f"nested/Helper.{suffix}"))
        worker = self.macho(inner / "Contents/MacOS/worker")
        tool = self.macho(payload / "bin/tool")
        library = self.macho(payload / "lib/extension.so")
        (payload / "README").write_text("not Mach-O")
        outside = self.macho(self.root / "outside")
        outside_hash = hashlib.sha256(outside.read_bytes()).hexdigest()
        self.bundle(self.root / "Outside.app")

        result, calls = self.sign("--payload", str(payload) + "/")

        expected = sorted(bundles + [worker, tool, library], key=lambda path: (-len(path.parts), str(path)))
        self.assertEqual(calls, [SIGN + [str(path)] for path in expected])
        self.assertEqual(result.stdout, f"signed {len(expected)} items in {payload}\n")
        self.assertEqual(hashlib.sha256(outside.read_bytes()).hexdigest(), outside_hash)

    def test_app_skips_components_and_signs_other_targets_before_app(self):
        app = self.bundle(self.root / "Example.app")
        components = app / "Contents/Resources/components"
        component = self.bundle(components / "runtime/payload/Embedded.app")
        self.bundle(component / "Contents/PlugIns/Nested.bundle")
        self.macho(components / "runtime/payload/bin/python")
        helper = self.macho(app / "Contents/MacOS/helper")
        runtime = self.macho(app / "Contents/Resources/runtime/x")
        sibling = self.macho(app / "Contents/Resources/components-extra/x")
        nested = self.bundle(app / "Contents/PlugIns/Helper.bundle")
        worker = self.macho(nested / "Contents/MacOS/worker")

        result, calls = self.sign(str(app) + "/")

        self.assertFalse(any(str(components) + "/" in arg for call in calls for arg in call),
                         "codesign was called on a component")
        expected = sorted([helper, runtime, sibling, nested, worker], key=lambda path: (-len(path.parts), str(path)))
        self.assertEqual(calls, [SIGN + [str(path)] for path in expected + [app]] + [
            ["--verify", "--strict", "--deep", str(app)], ["-d", "-r-", str(app)],
        ])
        self.assertIn(f"signed {len(expected)} nested items and {app}\n", result.stdout)

    def test_app_preserves_component_sha256(self):
        app = self.bundle(self.root / "Example.app")
        component = self.macho(app / "Contents/Resources/components/runtime/payload/bin/python")
        helper = self.macho(app / "Contents/MacOS/helper")
        before = hashlib.sha256(component.read_bytes()).hexdigest()
        helper_before = hashlib.sha256(helper.read_bytes()).hexdigest()

        self.sign(app)

        self.assertEqual(hashlib.sha256(component.read_bytes()).hexdigest(), before,
                         "app signing changed component bytes")
        self.assertNotEqual(hashlib.sha256(helper.read_bytes()).hexdigest(), helper_before)

    def test_other_identities_keep_todays_commands(self):
        python, node, app = self.electron_payloads()
        for identity in ("Apple Development: Test Identity", "-"):
            with self.subTest(identity=identity):
                self.log.write_text("")

                self.sign("--payload", python, identity=identity)
                self.sign("--payload", node, identity=identity)
                _, calls = self.sign(app, identity=identity)

                self.assertEqual(calls, [["--force", "--timestamp=none", "--sign", identity, path.format(root=self.root)]
                                         for path in BEFORE] + [["--verify", "--strict", "--deep", str(app)], ["-d", "-r-", str(app)]])

    def test_developer_id_adds_runtime_timestamp_and_entitlements_per_executable(self):
        python, node, app = self.electron_payloads()
        contents = app / "Contents"
        frameworks = contents / "Frameworks"
        helpers = [frameworks / f"Agentic Complex Helper{suffix}.app" for suffix in HELPERS]
        framework = frameworks / "Electron Framework.framework"

        self.sign("--payload", python, identity=DEVELOPER_ID)
        self.sign("--payload", node, identity=DEVELOPER_ID)
        _, calls = self.sign(app, identity=DEVELOPER_ID)

        granted = {python / "bin/python3.12": "python", node / "node/bin/node": "node",
                   contents / "MacOS/ac-helper": "ac-helper", contents / "MacOS/AgenticComplexMetalAvatar": "renderer",
                   app: "main", **{helper: name for helper, name in zip(helpers, HELPERS.values())}}
        signed = [Path(path.format(root=self.root)) for path in BEFORE]
        self.assertEqual(calls, [["--force", "--options", "runtime", "--timestamp",
                                  *(["--entitlements", str(ENTITLEMENTS / (granted[path] + ".plist"))] if path in granted else []),
                                  "--sign", DEVELOPER_ID, str(path)] for path in signed]
                         + [["--verify", "--strict", "--deep", str(app)], ["-d", "-r-", str(app)]])
        order = [Path(call[-1]) for call in calls[:-2]]
        self.assertLess(order.index(framework / "Versions/A/Electron Framework"), order.index(framework))
        self.assertTrue(all(order.index(helper) < order.index(app) for helper in helpers))
        self.assertEqual(order[-1], app)
        for path in granted.values():
            self.assertTrue((ENTITLEMENTS / (path + ".plist")).is_file(), path)

    @unittest.skipUnless(shutil.which("codesign"), "needs codesign")
    def test_ad_hoc_signs_an_electron_shaped_app_that_verifies_strictly(self):
        app = self.electron_app()
        env = dict(self.env, PATH=os.environ["PATH"], AAC_SIGN_IDENTITY="-")

        result = subprocess.run(["bash", str(SCRIPT), str(app)], env=env, capture_output=True, text=True)

        self.assertEqual(result.returncode, 0, result.stderr)
        verify = subprocess.run(["codesign", "--verify", "--strict", "--deep", str(app)], capture_output=True, text=True)
        self.assertEqual(verify.returncode, 0, verify.stderr)

    def test_entitlements_lint_and_never_request_get_task_allow(self):
        files = sorted(ENTITLEMENTS.glob("*.plist"))
        self.assertEqual({path.stem for path in files}, {"main", "helper", "helper-gpu", "helper-renderer", "helper-plugin",
                                                         "node", "python", "ac-helper", "renderer"})
        for path in files:
            with self.subTest(path=path.name):
                lint = subprocess.run(["plutil", "-lint", str(path)], capture_output=True, text=True)
                self.assertEqual(lint.returncode, 0, lint.stdout + lint.stderr)
                self.assertNotIn("com.apple.security.get-task-allow", plistlib.loads(path.read_bytes()))
        self.assertEqual(plistlib.loads((ENTITLEMENTS / "helper.plist").read_bytes()), {"com.apple.security.cs.allow-jit": True})


if __name__ == "__main__":
    unittest.main()
