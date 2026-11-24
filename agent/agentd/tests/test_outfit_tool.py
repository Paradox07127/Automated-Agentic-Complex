"""outfit_tool imports an EFMI mod as an appearance of an installed character and removes it, run by script path as the app does;
character_tool export strips imported appearances. Synthetic mods and a fake importer only: no byte of a user mod."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_character_library import check_progress, tool_command
from character_library import Library, Package, read_json
from infra.platform import lock_file

REPO = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(REPO / "characters"), str(REPO / "characters/Tests/Python")]
from test_import_outfit import CLOTH, geometry_mod, package_fixture, si_mod, write_map
# protocol/C3-host-ipc has a test_mod_settings module of its own.
spec = importlib.util.spec_from_file_location("pipeline_test_mod_settings", REPO / "characters/Tests/Python/test_mod_settings.py")
pipeline_mod_settings = importlib.util.module_from_spec(spec); spec.loader.exec_module(pipeline_mod_settings)
switch_mod = pipeline_mod_settings.switch_mod


class OutfitToolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        package_fixture(self.root / "source")
        self.library = Library(self.root / "library"); self.library.install(self.root / "source")
        self.mod = si_mod(self.root / "si")
        # The synthetic mod's second texture fits two slots; the mapping picks one.
        self.map = write_map(self.root / "outfit-map.json", textures={"1": "_ClearCoatMask"})

    def host(self, reject=False):
        host = self.root / "host"
        host.write_text("#!" + sys.executable + "\nimport json, pathlib, sys\n"
            "assert sys.argv[1] == '--validate-pack'\n"
            "assert json.loads(pathlib.Path(sys.argv[2]).read_text())['schema'] == 'metal-native-character-bundle/v1'\n"
            + ("print('pack_rejected: fixture', file=sys.stderr)\nsys.exit(78)\n" if reject else ""), encoding="utf-8")
        host.chmod(0o700)
        return host

    def import_args(self, host, *extra):
        return ["import", "--library", str(self.library.root), "--character", "fixture", "--source", str(self.mod),
                "--map", str(self.map), "--validate-with", str(host), *extra]

    def remove_args(self, host, appearance):
        return ["remove", "--library", str(self.library.root), "--character", "fixture", "--appearance", appearance,
                "--validate-with", str(host)]

    def success(self, result):
        """The result line; an import's progress lines before it are checked, and remove prints none."""
        self.assertEqual(result.returncode, 0, result.stderr)
        *progress, last = [json.loads(line) for line in result.stdout.splitlines()]
        if progress: check_progress(self, progress, ["read", "compose", "write", "validate", "publish"])
        return last

    def failure(self, result):
        self.assertNotEqual(result.returncode, 0)
        # Only progress lines, printed before the failure.
        self.assertTrue(all(json.loads(line)["event"] == "progress" for line in result.stdout.splitlines()), result.stdout)
        doc = json.loads(result.stderr.strip().splitlines()[-1])
        self.assertEqual(sorted(doc), ["detail", "ok", "reason"]); self.assertIs(doc["ok"], False)
        return doc

    def in_process(self, argv, importer):
        """main() with the importer module replaced, as (returncode, stdout, stderr)."""
        import outfit_tool
        real = outfit_tool.outfit_module
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, "argv", ["outfit_tool.py", *argv]), \
                mock.patch.object(outfit_tool, "outfit_module", lambda name: importer if name == "import_outfit" else real(name)), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = outfit_tool.main()
        return SimpleNamespace(returncode=code, stdout=out.getvalue(), stderr=err.getvalue())

    def pack(self, package):
        return read_json(package.root / "runtime" / package.native_entry["c7"]["file"])

    def stage_names(self):
        return [p.name for p in (self.library.root / ".outfit-stage").iterdir()]

    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_import_publishes_the_appearance_in_place_and_records_it(self):
        doc = self.success(tool_command("outfit_tool.py", *self.import_args(self.host(), "--name", "水墨")))
        aid = doc["appearance"]["id"]
        self.assertRegex(aid, r"^mod_[0-9a-f]{8}$")
        self.assertEqual(doc, dict(ok=True, character="fixture", version="1.0.1", appearance=dict(id=aid, name="水墨"),
                                   warnings=doc["warnings"]))
        [package] = Library(self.library.root).packages()
        self.assertEqual(package.version, "1.0.1")
        appearance = self.pack(package)["appearances"][-1]
        self.assertEqual((appearance["id"], appearance["name"], appearance["kind"]), (aid, "水墨", "imported"))
        index = read_json(self.library.root / "outfit-imports/fixture/imports.json")
        self.assertEqual(index["schema"], "endfield-outfit-imports/v1")
        [entry] = index["imports"]
        self.assertEqual(entry, dict(appearance=aid, name="水墨", fingerprint=appearance["source"]["fingerprint"],
                                     created_at=appearance["source"]["imported_at"], removed_at=None))
        self.assertEqual(self.stage_names(), [".lock"])

    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_import_prints_each_stage_before_the_result(self):
        result = tool_command("outfit_tool.py", *self.import_args(self.host()))
        self.success(result)
        stages = [json.loads(line)["stage"] for line in result.stdout.splitlines()[:-1]]
        self.assertEqual(list(dict.fromkeys(stages)), ["read", "compose", "write", "validate", "publish"])

    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_import_line_carries_the_report_warnings(self):
        doc = self.success(tool_command("outfit_tool.py", *self.import_args(self.host())))
        [package] = Library(self.library.root).packages()
        report = read_json(package.root / "provenance" / ("outfit-" + doc["appearance"]["id"] + ".json"))
        self.assertIn("needs_mips:Textures/D.dds", report["warnings"])
        self.assertEqual(doc["warnings"], report["warnings"])

    @unittest.skipIf(sys.platform == "win32", "a child tool prints non-ASCII to a pipe in the cp1252 default encoding")
    def test_import_line_carries_the_switch_warnings(self):
        package_fixture(self.root / "atlas", atlas=True)
        library = Library(self.root / "switch-library"); library.install(self.root / "atlas")
        args = ["import", "--library", str(library.root), "--character", "fixture", "--source", str(switch_mod(self.root / "switch", panties=True)),
                "--validate-with", str(self.host())]
        self.assertIn("setting_fixed:panties", self.success(tool_command("outfit_tool.py", *args))["warnings"])

    def test_running_import_makes_a_second_one_busy(self):
        snapshot = self.library.snapshot()
        stages = self.library.root / ".outfit-stage"; stages.mkdir()
        with (stages / ".lock").open("a", encoding="utf-8") as lock:
            lock_file(lock)
            doc = self.failure(tool_command("outfit_tool.py", *self.import_args(self.host())))
        self.assertEqual(doc["reason"], "busy")
        self.assertEqual(self.library.snapshot(), snapshot)

    def test_importer_errors_are_reported_by_their_reason(self):
        snapshot = self.library.snapshot()
        def raising(error):
            def import_outfit(package_root, mod_dir, stage, name=None, mapping=None, progress=None):
                Path(stage).mkdir(); raise error
            return SimpleNamespace(import_outfit=import_outfit)
        for error, reason in [(ValueError("texture_mismatch:1:Textures/L.Dds"), "texture_mismatch"),
                              (ValueError("nothing_to_import:只隐藏了组件 S_actor_test_body_01_lod0，贴图都没套上"), "nothing_to_import"),
                              (ValueError("unmapped_component:TextureOverride_X"), "unmapped_component"),
                              (ValueError("not_this_character:no component hash or vertex position is this character's"), "not_this_character"),
                              (ValueError("unsupported_texture_format"), "unsupported_texture_format"),
                              (ValueError("missing_channel:6"), "missing_channel"),
                              (ValueError("unsafe_path"), "unsafe_path"),
                              (ValueError("ambiguous_ini"), "ambiguous_ini"),
                              (ValueError("unsupported_geometry:bone_unresolved:3:486"), "unsupported_geometry"),
                              (ValueError("geometry_invalid:index_range:TextureOverride_X"), "geometry_invalid"),
                              (ValueError("channel_unresolved:S_actor_test_cloth_01_lod0:5"), "channel_unresolved"),
                              (ValueError("graph_store_missing"), "graph_store_missing"),
                              (ValueError("invalid_mod_settings:segment_overlap"), "invalid_mod_settings"),
                              (ValueError("some_new_failure"), "unsupported_mod"),
                              (KeyError("draws"), "internal")]:
            doc = self.failure(self.in_process(self.import_args(self.host()), raising(error)))
            self.assertEqual(doc["reason"], reason, doc)
            self.assertIn(str(error).strip("'"), doc["detail"])
            self.assertEqual(self.stage_names(), [".lock"])
        self.assertEqual(self.library.snapshot(), snapshot)
        self.assertFalse((self.library.root / "outfit-imports").exists())

    @unittest.skipIf(sys.platform == "win32", "cause on Windows not yet found")
    def test_host_rejection_leaves_the_library_and_removes_the_stage(self):
        snapshot = self.library.snapshot()
        doc = self.failure(tool_command("outfit_tool.py", *self.import_args(self.host(reject=True))))
        self.assertEqual(doc["reason"], "validate_failed"); self.assertIn("pack_rejected", doc["detail"])
        self.assertEqual(self.library.snapshot(), snapshot)
        self.assertEqual(self.stage_names(), [".lock"])

    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_an_installed_file_changed_after_install_fails_the_import_and_publishes_nothing(self):
        """Rewritten by the import or read and cloned: each changed file fails the import."""
        [package] = self.library.packages(); snapshot = self.library.snapshot()
        for name in ("runtime/source/source.json", "runtime/rig.json"):
            with self.subTest(name=name):
                path = package.root / name; data = path.read_bytes()
                # Same length, so only the SHA-256 tells.
                path.write_bytes(data[:-1] + b" ")
                doc = self.failure(tool_command("outfit_tool.py", *self.import_args(self.host())))
                path.write_bytes(data)
                self.assertIn("mismatch", doc["detail"])
                self.assertEqual(self.library.snapshot(), snapshot)
                self.assertEqual([p.name for p in (self.library.root / "packages/fixture").iterdir()], [package.root.name])
                self.assertEqual(self.stage_names(), [".lock"])
        self.success(tool_command("outfit_tool.py", *self.import_args(self.host())))

    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_remove_takes_the_appearance_its_draws_and_its_textures_out(self):
        [original] = self.library.packages()
        before = {p.relative_to(original.root).as_posix() for p in original.root.rglob("*") if p.is_file()}
        aid = self.success(tool_command("outfit_tool.py", *self.import_args(self.host())))["appearance"]["id"]
        doc = self.success(tool_command("outfit_tool.py", *self.remove_args(self.host(), aid)))
        self.assertEqual(doc, dict(ok=True, character="fixture", version="1.0.2", appearance=dict(id=aid)))
        [package] = Library(self.library.root).packages()
        Package(package.root)
        self.assertEqual(package.version, "1.0.2")
        self.assertEqual([a["id"] for a in self.pack(package)["appearances"]], ["default", "top"])
        source = read_json(package.root / "runtime" / package.native_entry["source"]["file"])
        self.assertEqual([d["mesh"] for d in source["draws"]].count(CLOTH), 1)
        self.assertFalse([d for d in source["draws"] if d["mesh"].startswith("outfit:")])
        after = {p.relative_to(package.root).as_posix() for p in package.root.rglob("*") if p.is_file()}
        self.assertEqual({p for p in after if "/Files/" in p}, {p for p in before if "/Files/" in p})
        self.assertFalse([p for p in after if p.startswith("provenance/outfit-")])
        [entry] = read_json(self.library.root / "outfit-imports/fixture/imports.json")["imports"]
        self.assertEqual(entry["appearance"], aid); self.assertIsNotNone(entry["removed_at"])
        self.assertEqual(self.stage_names(), [".lock"])

    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_remove_and_export_of_a_geometry_import_leave_none_of_its_blobs(self):
        # The clone's self-shadow atlas entry keeps its blobs beside the frame graph, not beside the source manifest.
        package_fixture(self.root / "atlas", atlas=True)
        library = Library(self.root / "atlas-library"); library.install(self.root / "atlas")
        [original] = library.packages()
        def files(root): return {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()}
        before = files(original.root)
        plain = self.root / "plain.endfield-character"
        self.success(tool_command("character_tool.py", "export", str(original.root), "--output", str(plain)))
        args = ["import", "--library", str(library.root), "--character", "fixture", "--source", str(geometry_mod(self.root / "geo")),
                "--validate-with", str(self.host())]
        aid = self.success(tool_command("outfit_tool.py", *args))["appearance"]["id"]
        [package] = Library(library.root).packages()
        self.assertGreater(len(files(package.root) - before), 1)
        exported = self.root / "out.endfield-character"
        self.success(tool_command("character_tool.py", "export", str(package.root), "--output", str(exported)))
        with zipfile.ZipFile(plain) as a, zipfile.ZipFile(exported) as b:
            self.assertEqual({n for n in b.namelist() if "/Files/" in n}, {n for n in a.namelist() if "/Files/" in n})
        self.success(tool_command("outfit_tool.py", "remove", "--library", str(library.root), "--character", "fixture", "--appearance", aid,
                                  "--validate-with", str(self.host())))
        [package] = Library(library.root).packages()
        self.assertEqual(files(package.root), before)

    @unittest.skipIf(sys.platform == "win32", "a child tool prints non-ASCII to a pipe in the cp1252 default encoding")
    def test_remove_and_export_of_an_import_with_switches_restore_the_package(self):
        package_fixture(self.root / "atlas", atlas=True)
        library = Library(self.root / "switch-library"); library.install(self.root / "atlas")
        [original] = library.packages()
        def files(root): return {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()}
        before, data = files(original.root), self.pack(original)["interaction"]["data"]
        plain = self.root / "plain.endfield-character"
        self.success(tool_command("character_tool.py", "export", str(original.root), "--output", str(plain)))
        args = ["import", "--library", str(library.root), "--character", "fixture", "--source", str(switch_mod(self.root / "switch")),
                "--validate-with", str(self.host())]
        aid = self.success(tool_command("outfit_tool.py", *args))["appearance"]["id"]
        [package] = Library(library.root).packages()
        self.assertIn("runtime/interaction/mod-settings.json", files(package.root))
        self.assertTrue(read_json(package.root / "runtime" / package.native_entry["source"]["file"])["texture_variants"])
        exported = self.root / "out.endfield-character"
        self.success(tool_command("character_tool.py", "export", str(package.root), "--output", str(exported)))
        with zipfile.ZipFile(plain) as a, zipfile.ZipFile(exported) as b:
            self.assertEqual(set(b.namelist()) - {"character.json"}, set(a.namelist()) - {"character.json"})
        self.success(tool_command("outfit_tool.py", "remove", "--library", str(library.root), "--character", "fixture", "--appearance", aid,
                                  "--validate-with", str(self.host())))
        [package] = Library(library.root).packages()
        self.assertEqual(files(package.root), before)
        self.assertEqual(self.pack(package)["interaction"]["data"], data)

    @unittest.skipIf(sys.platform == "win32", "a child tool prints non-ASCII to a pipe in the cp1252 default encoding")
    def test_graft_onto_the_original_base_rebuilds_the_import(self):
        import outfit_tool
        for name, mod in (("switch", switch_mod), ("geo", geometry_mod)):
            with self.subTest(mod=name):
                package_fixture(self.root / (name + "-base"), atlas=True)
                library = Library(self.root / (name + "-library")); library.install(self.root / (name + "-base"))
                [original] = library.packages()
                args = ["import", "--library", str(library.root), "--character", "fixture", "--source", str(mod(self.root / name)),
                        "--validate-with", str(self.host())]
                aid = self.success(tool_command("outfit_tool.py", *args))["appearance"]["id"]
                [imported] = Library(library.root).packages()
                grafted = outfit_tool.graft(original.root, imported.root, self.root / (name + "-grafted"), [aid], "1.0.1")
                def files(root): return {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()}
                self.assertEqual(files(grafted.root), files(imported.root))
                self.assertEqual(grafted.sha256, imported.sha256)

    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_remove_rewrites_the_neutral_package_of_the_graph(self):
        import native_bundle
        def draws(package):
            runtime, entry = package.root / "runtime", package.native_entry
            scene, record, metal = (read_json(runtime / entry[field]["file"]) for field, _ in native_bundle.NEUTRAL)
            self.assertEqual(native_bundle.emitted(scene, record, metal), (runtime / entry["graph"]["file"]).read_bytes())
            return scene["passes"][0]["draws"]
        aid = self.success(tool_command("outfit_tool.py", *self.import_args(self.host())))["appearance"]["id"]
        [package] = Library(self.library.root).packages()
        self.assertEqual(draws(package), [0, 1, 2, 3, 4])
        self.success(tool_command("outfit_tool.py", *self.remove_args(self.host(), aid)))
        [package] = Library(self.library.root).packages()
        self.assertEqual(draws(package), [0, 1, 2, 3])

    def test_clone_copies_the_package_without_a_shell_copy(self):
        import outfit_tool
        [package] = self.library.packages()
        def files(root): return {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()}
        with mock.patch("subprocess.run", side_effect=FileNotFoundError("/bin/cp")):
            outfit_tool.clone(package.root, self.root / "clone")
        self.assertEqual(files(self.root / "clone"), files(package.root))

    def test_the_importer_copies_the_package_without_a_shell_copy(self):
        from agentic_complex_build import import_outfit
        [package] = self.library.packages()
        with mock.patch("subprocess.run", side_effect=FileNotFoundError("/bin/cp")):
            import_outfit.import_outfit(package.root, self.mod, self.root / "out", mapping=self.map)
        Package(self.root / "out")

    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_strip_and_graft_refuse_a_file_name_that_leaves_the_package(self):
        import outfit_tool
        from motion.zip_import import Failure
        [original] = self.library.packages()
        aid = self.success(tool_command("outfit_tool.py", *self.import_args(self.host())))["appearance"]["id"]
        [imported] = Library(self.library.root).packages()
        # The imported package rebuilt with one of the appearance's draws naming a file three folders above the copy.
        evil = self.root / "evil" / "package"; evil.parent.mkdir(); d, reference = outfit_tool.clone(imported.root, evil)
        next(x for x in d.source["draws"] if x["mesh"].startswith("outfit:" + aid + "/"))["file"] = "../../../sentinel.txt"
        outfit_tool.finish(evil, d, read_json(evil / "character.json"), reference)
        for name, call in (("strip", lambda out: outfit_tool.strip(evil, out, [aid], bump=True)),
                           ("graft", lambda out: outfit_tool.graft(original.root, evil, out, [aid], "1.0.1"))):
            with self.subTest(name=name):
                output = self.root / name / "package"; output.parent.mkdir()
                sentinel = output.parent / "sentinel.txt"; sentinel.write_text("keep", encoding="utf-8")
                with self.assertRaises(Failure) as caught: call(output)
                self.assertEqual(caught.exception.reason, "unsupported_mod")
                self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep")

    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_graft_rebuilds_the_windows_frame_table_and_strip_refuses_one(self):
        import outfit_tool
        from motion.zip_import import Failure
        package_fixture(self.root / "windows", skinned=True, vulkan=True)
        library = Library(self.root / "windows-library"); library.install(self.root / "windows")
        [original] = library.packages()
        args = ["import", "--library", str(library.root), "--character", "fixture", "--source", str(self.mod),
                "--map", str(write_map(self.root / "windows-map.json", textures={"1": "_MetallicGlossMap"})), "--validate-with", str(self.host())]
        aid = self.success(tool_command("outfit_tool.py", *args))["appearance"]["id"]
        [imported] = Library(library.root).packages()
        self.assertIn("vulkan_frame", imported.native_entry)
        grafted = outfit_tool.graft(original.root, imported.root, self.root / "grafted", [aid], "1.0.1")
        def files(root): return {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()}
        self.assertEqual(files(grafted.root), files(imported.root))
        with self.assertRaises(Failure) as caught: outfit_tool.strip(imported.root, self.root / "stripped", [aid], bump=True)
        self.assertEqual(caught.exception.reason, "unsupported_character")

    def test_remove_of_an_original_appearance_is_not_imported(self):
        snapshot = self.library.snapshot()
        doc = self.failure(tool_command("outfit_tool.py", *self.remove_args(self.host(), "top")))
        self.assertEqual(doc["reason"], "not_imported")
        self.assertEqual(self.library.snapshot(), snapshot)

    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_export_strips_imported_appearances(self):
        [original] = self.library.packages()
        plain = self.root / "plain.endfield-character"
        doc = self.success(tool_command("character_tool.py", "export", str(original.root), "--output", str(plain)))
        self.assertEqual(doc, dict(file=str(plain), stripped_appearances=[]))
        aid = self.success(tool_command("outfit_tool.py", *self.import_args(self.host())))["appearance"]["id"]
        [package] = Library(self.library.root).packages()
        exported = self.root / "out.endfield-character"
        doc = self.success(tool_command("character_tool.py", "export", str(package.root), "--output", str(exported)))
        self.assertEqual(doc, dict(file=str(exported), stripped_appearances=[aid]))
        with zipfile.ZipFile(plain) as a, zipfile.ZipFile(exported) as b:
            # No byte of the mod leaves the machine: the export holds only the original blobs.
            self.assertEqual({n for n in b.namelist() if "/Files/" in n}, {n for n in a.namelist() if "/Files/" in n})
            self.assertFalse([n for n in b.namelist() if n.startswith("provenance/outfit-")])
        other = Library(self.root / "other")
        other.import_path(exported, validate_with=self.host())
        [copy] = other.packages()
        self.assertEqual([a["id"] for a in self.pack(copy)["appearances"]], ["default", "top"])
        # The installed package keeps its appearance.
        self.assertEqual(self.pack(Library(self.library.root).packages()[0])["appearances"][-1]["id"], aid)


if __name__ == "__main__": unittest.main()
