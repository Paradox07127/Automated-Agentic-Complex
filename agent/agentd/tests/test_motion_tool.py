"""motion_tool imports a motion into an installed character and publishes it in place, probes sources, lists, renames and removes imports
and checks or publishes motion-chain proposals, run by script path as the app does."""
import hashlib
import importlib.util
import io
import json
import math
from pathlib import Path
import shutil
import signal
import struct
import subprocess
import time
import sys
import tempfile
import unittest
import wave
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_character_library import check_progress, fixture, tool_command
from character_library import Library, Package, write_json
from infra.platform import lock_file

REPO = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(REPO / "characters/packaging"), str(REPO / "characters"),
                str(REPO / "characters/Tests/Python")]
import native_bundle

NUMPY = importlib.util.find_spec("numpy") is not None
needs_numpy = unittest.skipUnless(NUMPY, "the importer needs numpy; run with .local/venvs/pipeline/bin/python3")


def motion_fixture(root, cid="fixture", rows=1, rig=None, imported=(), motion=None):
    """test_character_library's package with a runtime the importer can extend: a rig, one idle clip and the action files.

    imported: (actions.json row, provenance report) pairs written as an earlier import would have left them.
    motion: {"clips": {name: (length, loop)}} archive clips after idle, {"animation"|"interaction": {file: document}} data files
    that replace or follow the default ones, a None document leaving that file out, {"metadata": {name: fields}} replacing
    fields of a clip's metadata. A rig with nodes gets test_vmd_import's humanoid.json of it by default."""
    motion = motion or {}
    doc = fixture(root, cid)
    shutil.rmtree(root / "runtime"); runtime = root / "runtime"
    def put(path, value, base=""):
        data = value if isinstance(value, bytes) else (json.dumps(value, ensure_ascii=False) + "\n").encode()
        target = runtime / path; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(data)
        return dict(file=path[len(base):], sha256=hashlib.sha256(data).hexdigest(), byte_count=len(data))
    source = put("render/source.json", {"schema": "endfield-native-character-manifest-v1", "draws": []})
    lengths = {"idle": (1.0, True), **motion.get("clips", {})}
    clips = [dict(put("clips/%s.json" % name, {"schema": "metal-actor-clip-v1", "name": name,
        "keys": put("clips/%s.keys" % name, b"EFKEY001"), "oracle": put("clips/%s.oracle" % name, b"EFPOSE01"),
        **motion.get("metadata", {}).get(name, {})}),
        name=name, length=length, loop=loop) for name, (length, loop) in lengths.items()]
    archive = put("actor.json", {"schema": "metal-actor-source-export-v1", "source_bundle_sha256": "0" * 64,
        "rig": put("rig.json", rig or {"schema": "metal-actor-rig-v1", "nodes": []}),
        "clips": clips})
    row = lambda i: {"id": "fixture_%d" % i, "name": "idle", "section": "idle", "clips": ["idle"] if i == 0 else []}
    actions = lambda items: {"schema": "endfield-character-actions-v1", "actions": items}
    humanoid = {}
    if rig and rig["nodes"]:
        from test_vmd_import import humanoid_map
        humanoid = {"humanoid.json": humanoid_map(rig)}
    animation = {"actions.json": actions([row(i) for i in range(rows)] + [x for x, _ in imported]),
                 "intent-motion-map.json": {"clips": {"idle": {}}}, **humanoid, **motion.get("animation", {})}
    interaction = {"actions.json": actions([]), "motion-metadata.json": {"clips": {}}, "blend-times.json": {"clips": {}},
                   **motion.get("interaction", {})}
    animation, interaction = ({k: v for k, v in data.items() if v is not None} for data in (animation, interaction))
    pack = put("pack.json", {"schema": "endfield-character-pack/v1", "id": cid, "render": {"manifest": dict(source, file="source.json")},
        "appearances": [{"id": "default"}],
        "animation": {"palette_contract": put("animation/palette.json", {"clips": [{"name": name, "loop": loop, "length": length}
                                                                                   for name, (length, loop) in lengths.items()], "meshes": []}, "animation/"),
                      "data": [put("animation/" + name, value, "animation/") for name, value in animation.items()]},
        "interaction": {"data": [put("interaction/" + name, value, "interaction/") for name, value in interaction.items()]}})
    entry = dict(id=cid, default_clip="idle", default_appearance="default", c7=pack, actor_archive=archive, source=source,
        library=put("programs.json", {"schema": "metal-program-library-v1", "programs": []}),
        graph=put("graph.json", {"schema": "metal-frame-graph-v1", "manifest_sha256": source["sha256"], "passes": []}),
        lighting=put("lighting.json", {"schema": "metal-product-lighting/v1", "sphere_source": put("sphere.json", {})}))
    entry["coverage"] = put("coverage.json", native_bundle.character_coverage(runtime, entry))
    files = [dict(put(p.relative_to(runtime).as_posix(), p.read_bytes()), roles=["runtime"]) for p in sorted(runtime.rglob("*")) if p.is_file()]
    native = put("bundle.json", {"schema": "metal-native-character-bundle/v1", "characters": [entry], "files": files})
    doc["components"]["render"]["native_bundle"] = dict(native, file="runtime/bundle.json")
    reports = []
    for action, report in imported:
        path = root / "provenance" / ("vmd-%s.json" % action["id"][len("mmd_"):]); path.parent.mkdir(exist_ok=True)
        write_json(path, report); data = path.read_bytes()
        reports.append(dict(file=path.relative_to(root).as_posix(), sha256=hashlib.sha256(data).hexdigest(), byte_count=len(data)))
    doc["inventory"] = [x for x in doc["inventory"] if not x["file"].startswith("runtime/")] + \
        [dict(x, file="runtime/" + x["file"]) for x in files + [native]] + reports
    write_json(root / "character.json", doc)


class MotionToolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.library = Library(self.root / "library")

    def install(self, **options):
        source = self.root / "source"; motion_fixture(source, **options); self.library.install(source)
        return self.library.packages()[0]

    def host(self, reject=False):
        host = self.root / "host"
        host.write_text("#!" + sys.executable + "\nimport json, pathlib, sys\n"
            "assert sys.argv[1] == '--validate-pack'\n"
            "assert json.loads(pathlib.Path(sys.argv[2]).read_text())['schema'] == 'metal-native-character-bundle/v1'\n"
            + ("print('pack_rejected: fixture', file=sys.stderr)\nsys.exit(78)\n" if reject else ""), encoding="utf-8")
        host.chmod(0o700)
        return host

    def vmd(self, seconds=1, name="dance.vmd", model=""):
        from agentic_complex_build.mmd.io import Vmd, BoneKey, write_vmd
        path = self.root / name
        write_vmd(Vmd(model=model, bones=[BoneKey("上半身", 0, (0, 0, 0), (0, 0, 0, 1)),
                             BoneKey("上半身", 30 * seconds, (0, 0, 0), (0, math.sin(.2), 0, math.cos(.2)))]), path)
        return path

    def run_import(self, vmd, host, *extra):
        return tool_command("motion_tool.py", "import", "--library", str(self.library.root), "--character", "fixture",
                            "--source", str(vmd), "--validate-with", str(host), *extra)

    def success(self, result):
        """The result line; an import's progress lines before it are checked, and the other subcommands print none."""
        self.assertEqual(result.returncode, 0, result.stderr)
        *progress, last = [json.loads(line) for line in result.stdout.splitlines()]
        if progress: check_progress(self, progress, ["read", "sample", "retarget", "write", "validate", "publish"])
        return last

    def edit(self, command, host, action, *extra):
        return tool_command("motion_tool.py", command, "--library", str(self.library.root), "--character", "fixture",
                            "--action", action, *extra, "--validate-with", str(host))

    def listed(self):
        return self.success(tool_command("motion_tool.py", "list", "--library", str(self.library.root), "--character", "fixture"))

    def files(self):
        return {p.relative_to(self.library.root): p.read_bytes() for p in self.library.root.rglob("*") if p.is_file()}

    def failure(self, result):
        self.assertNotEqual(result.returncode, 0)
        # Only progress lines, printed before the failure.
        self.assertTrue(all(json.loads(line)["event"] == "progress" for line in result.stdout.splitlines()), result.stdout)
        doc = json.loads(result.stderr.strip().splitlines()[-1])
        self.assertEqual(sorted(doc), ["detail", "ok", "reason"]); self.assertIs(doc["ok"], False)
        return doc

    def test_full_action_table_is_refused_before_any_write(self):
        self.install(rows=128)
        before = self.files()
        doc = self.failure(self.run_import(self.root / "unread.vmd", self.host()))
        self.assertEqual(doc["reason"], "too_many_actions")
        self.assertEqual(self.files(), before)

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_synthetic_vmd_is_published_in_place_and_its_sources_kept(self):
        from test_vmd_import import authored_rig
        from agentic_complex_build.motion_import.take import check_mmd_index, check_result
        old = self.install(rig=authored_rig())
        doc = self.success(self.run_import(self.vmd(), self.host(), "--title", "舞蹈"))
        check_result(doc)
        self.assertEqual((doc["ok"], doc["character"], doc["version"], doc["format"]), (True, "fixture", "1.0.1", "vmd"))
        # The id, title, duration and BGM flag the --vmd import gave for this file.
        self.assertEqual({k: doc["action"][k] for k in ("id", "title", "duration_s", "has_bgm")},
                         dict(id="mmd_24f7284c100f14e9", title="舞蹈", duration_s=1.0, has_bgm=False))
        new = Library(self.library.root).packages()[0]
        self.assertEqual(new.version, "1.0.1")
        pack = new.root / "runtime" / new.native_entry["c7"]["file"]
        rows = json.loads((pack.parent / "animation/actions.json").read_text(encoding="utf-8"))["actions"]
        self.assertEqual([x["id"] for x in rows][-1], doc["action"]["id"])
        Package(old.root)
        self.assertFalse((self.library.root / ".vmd-stage/fixture").exists())
        kept = self.library.root / "mmd-library/sources"
        index = self.mmd_index(); check_mmd_index(index)
        imports = index["entries"]
        self.assertEqual((index["schema"], len(imports)), ("endfield-mmd-library/v2", 1))
        self.assertEqual({k: imports[0][k] for k in ("id", "title", "bgm", "morph", "camera", "foot_lock", "has_face", "project", "removed_at")},
                         dict(id=doc["action"]["id"], title="舞蹈", bgm=None, morph=None, camera=None, foot_lock=True, has_face=False,
                              project=None, removed_at=None))
        self.assertEqual((imports[0]["source"]["name"], imports[0]["source"]["sha256"]), ("dance.vmd", doc["source"]["sha256"]))
        self.assertEqual((kept / imports[0]["source"]["file"]).read_bytes(), self.vmd().read_bytes())
        self.assertEqual(imports[0]["created_at"], doc["created_at"])

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_vmd_import_prints_each_stage_before_the_result(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig())
        result = self.run_import(self.vmd(), self.host())
        self.success(result)
        stages = [json.loads(line)["stage"] for line in result.stdout.splitlines()[:-1]]
        self.assertEqual(list(dict.fromkeys(stages)), ["read", "sample", "retarget", "write", "validate", "publish"])

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_the_same_vmd_twice_is_already_imported(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig())
        self.success(self.run_import(self.vmd(), self.host()))
        snapshot = self.library.snapshot()
        doc = self.failure(self.run_import(self.vmd(), self.host()))
        self.assertEqual(doc["reason"], "already_imported")
        self.assertEqual(self.library.snapshot(), snapshot)

    @needs_numpy
    def test_probe_reads_a_vmd_without_a_library(self):
        doc = self.success(tool_command("motion_tool.py", "probe", "--source", str(self.vmd())))
        self.assertEqual(doc, dict(ok=True, format="vmd", takes=[dict(index=0, name="dance.vmd", duration_s=1.0, frames=31, frame_rate=30.0)],
                                   has_face=False, has_camera=False, warnings=[]))

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_list_shows_the_imported_vmd(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig())
        imported = self.success(self.run_import(self.vmd(), self.host(), "--title", "舞蹈"))
        self.assertEqual(self.listed(), dict(ok=True, character="fixture", version="1.0.1", motions=[dict(
            id=imported["action"]["id"], clip=imported["action"]["clip"], title="舞蹈", format="vmd", duration_s=1.0,
            has_bgm=False, created_at=imported["created_at"], warnings=[])]))

    @unittest.skipIf(sys.platform == "win32", "a child tool prints non-ASCII to a pipe in the cp1252 default encoding")
    def test_list_shows_an_import_the_index_does_not_know(self):
        identity = "0123456789abcdef"
        row = dict(id="mmd_" + identity, name="旧舞", section="idle", clips=["imported_vmd_" + identity],
                   trigger="导入 VMD · 手动播放", duration=2.0)
        report = dict(schema="endfield-vmd-import/v1", character="fixture", action=row["id"], clip=row["clips"][0], frames=61,
                      duration=2.0, provenance=dict(vmd_sha256="1" * 64), bgm=dict(source_sha256="2" * 64))
        self.install(imported=[(row, report)])
        self.assertEqual(self.listed()["motions"], [dict(id=row["id"], clip=row["clips"][0], title="旧舞", format="vmd",
                                                         duration_s=2.0, has_bgm=True, created_at=None, warnings=[])])

    def test_list_of_an_unknown_character_is_internal(self):
        self.install()
        doc = self.failure(tool_command("motion_tool.py", "list", "--library", str(self.library.root), "--character", "nobody"))
        self.assertEqual((doc["reason"], doc["detail"]), ("internal", "unknown_character: nobody"))

    @needs_numpy  # format detection lives in the importer package, which imports numpy
    def test_text_file_is_an_unsupported_format(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig()); before = self.files()
        text = self.root / "notes.txt"; text.write_text("not a motion\n", encoding="utf-8")
        doc = self.failure(self.run_import(text, self.host()))
        self.assertEqual(doc["reason"], "unsupported_format")
        self.assertEqual(self.files(), before)

    @needs_numpy
    def test_obj_format_is_unsupported(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig()); before = self.files()
        doc = self.failure(self.run_import(self.vmd(), self.host(), "--format", "obj"))
        self.assertEqual(doc["reason"], "unsupported_format")
        self.assertEqual(self.files(), before)

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_host_rejection_leaves_the_library_and_removes_the_stage(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig()); snapshot = self.library.snapshot()
        doc = self.failure(self.run_import(self.vmd(), self.host(reject=True)))
        self.assertEqual(doc["reason"], "validate_failed"); self.assertIn("pack_rejected", doc["detail"])
        self.assertEqual(self.library.snapshot(), snapshot)
        self.assertEqual([p.name for p in (self.library.root / ".vmd-stage").iterdir()], [".lock"])

    def install_with_report(self, cid="fixture"):
        """A package with an earlier import's provenance report, a file no step rewrites; returns it and the report's name."""
        from test_vmd_import import authored_rig
        identity = "0123456789abcdef"
        row = dict(id="mmd_" + identity, name="旧舞", section="idle", clips=[], trigger="导入 VMD · 手动播放", duration=2.0)
        report = dict(schema="endfield-vmd-import/v1", character=cid, action=row["id"], clip="imported_vmd_" + identity, bgm=None)
        source = self.root / ("source-" + cid); motion_fixture(source, cid=cid, rig=authored_rig(), imported=[(row, report)])
        self.library.install(source)
        return next(p for p in self.library.packages() if p.id == cid), "provenance/vmd-%s.json" % identity

    def tampered(self, package, name, command):
        """command()'s result with package's file name changed in place; the file is restored after it."""
        path = package.root / name; data = path.read_bytes()
        # Same length, so only the SHA-256 tells.
        path.write_bytes(data[:-1] + b" ")
        try: return command()
        finally: path.write_bytes(data)

    def published(self):
        """The catalog and every package directory, which a failed command leaves as they were."""
        return self.library.snapshot(), sorted(p.relative_to(self.library.root) for p in (self.library.root / "packages").glob("*/*"))

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_an_installed_file_changed_after_install_fails_the_import_and_publishes_nothing(self):
        """Rewritten by the import, read and cloned, or only cloned: each changed file fails a VMD or a BVH import."""
        from test_bvh_import import cmu_bvh_text
        package, report = self.install_with_report(); before = self.published()
        bvh = self.root / "walk.bvh"; bvh.write_text(cmu_bvh_text(), encoding="utf-8")
        for source in (self.vmd(), bvh):
            for name in ("runtime/animation/actions.json", "runtime/rig.json", report):
                with self.subTest(source=source.name, name=name):
                    doc = self.failure(self.tampered(package, name, lambda: self.run_import(source, self.host())))
                    self.assertIn("mismatch", doc["detail"])
                    self.assertEqual(self.published(), before)
                    self.assertEqual([p.name for p in (self.library.root / ".vmd-stage").iterdir()], [".lock"])
        for source in (self.vmd(), bvh): self.success(self.run_import(source, self.host()))

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_an_installed_file_changed_after_install_fails_a_rename_or_remove_and_publishes_nothing(self):
        """Rewritten by the edit, read and cloned, only cloned, or taken out by a remove: each changed file fails the edit."""
        self.install_with_report()
        imported = self.success(self.run_import(self.vmd(), self.host()))["action"]
        package = self.library.packages()[0]; before = self.published(); index = self.mmd_index()
        archive = json.loads((package.root / "runtime/actor.json").read_text(encoding="utf-8"))
        [item] = [x for x in archive["clips"] if x["name"] == imported["clip"]]
        keys = "runtime/" + json.loads((package.root / "runtime" / item["file"]).read_text(encoding="utf-8"))["keys"]["file"]
        names = ("runtime/animation/actions.json", "runtime/rig.json", "provenance/vmd-0123456789abcdef.json")
        for command, extra, files in (("rename", ["--title", "新舞"], names), ("remove", [], names + (keys,))):
            for name in files:
                with self.subTest(command=command, name=name):
                    doc = self.failure(self.tampered(package, name, lambda: self.edit(command, self.host(), imported["id"], *extra)))
                    self.assertIn("mismatch", doc["detail"])
                    self.assertEqual(self.published(), before)
                    self.assertEqual([p.name for p in (self.library.root / ".vmd-stage").iterdir()], [".lock"])
                    self.assertEqual(self.mmd_index(), index)
        self.success(self.edit("rename", self.host(), imported["id"], "--title", "新舞"))
        self.success(self.edit("remove", self.host(), imported["id"]))

    @needs_numpy
    def test_an_installed_file_changed_after_install_fails_a_chain_and_publishes_nothing(self):
        """Rewritten by the chain or read and cloned: each changed file fails the chain."""
        package = self.install_chains(); before = self.published()
        edits = [dict(op="insert", chain="wave_start", index=1, clip="nod")]
        for name in ("runtime/animation/intent-motion-map.json", "runtime/interaction/motion-metadata.json", "runtime/rig.json"):
            with self.subTest(name=name):
                doc = self.failure(self.tampered(package, name, lambda: self.chain(package, self.host(), edits)))
                self.assertIn("mismatch", doc["detail"])
                self.assertEqual(self.published(), before)
                self.assertEqual([p.name for p in (self.library.root / ".vmd-stage").iterdir()], [".lock"])
        self.success(self.chain(package, self.host(), edits))

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_an_installed_file_changed_after_install_fails_an_mmd_sync_and_publishes_nothing(self):
        """A file the bake rewrites or verifies fails that entry; a file only cloned fails the whole sync."""
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig()); package, report = self.install_with_report("second")
        action = self.success(self.run_import(self.vmd(), self.host()))["action"]["id"]
        index = self.library.root / "mmd-library/index.json"; doc = self.mmd_index()
        # The library names the earlier import, so that mmd-sync keeps its row and only clones the report.
        doc["entries"].insert(0, dict(doc["entries"][0], id="mmd_0123456789abcdef", title="旧舞")); write_json(index, doc)
        before = self.published(); shared = index.read_bytes()
        for name, entry_fails in (("runtime/animation/actions.json", True), ("runtime/rig.json", True), (report, False)):
            with self.subTest(name=name):
                result = self.tampered(package, name, lambda: tool_command("motion_tool.py", *self.sync_command(self.host())))
                if entry_fails:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    last = json.loads(result.stdout.splitlines()[-1])
                    self.assertEqual((last["baked"], [x["id"] for x in last["failed"]]), ([], [action]))
                    self.assertIn("mismatch", last["failed"][0]["detail"])
                else:
                    self.assertIn("mismatch", self.failure(result)["detail"])
                    self.assertEqual(index.read_bytes(), shared)
                self.assertEqual(self.published(), before)
                self.assertEqual([p.name for p in (self.library.root / ".vmd-stage").iterdir()], [".lock"])
                index.write_bytes(shared)
        self.assertEqual(self.sync(self.host())["baked"], [action])

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_rename_shows_the_new_title_in_list(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig())
        action = self.success(self.run_import(self.vmd(), self.host(), "--title", "舞蹈"))["action"]["id"]
        doc = self.success(self.edit("rename", self.host(), action, "--title", " 新舞 "))
        self.assertEqual(doc, dict(ok=True, character="fixture", version="1.0.2", id=action, title="新舞"))
        listed = self.listed()
        self.assertEqual((listed["version"], [(x["id"], x["title"]) for x in listed["motions"]]), ("1.0.2", [(action, "新舞")]))
        self.assertEqual([(x["title"], x["removed_at"]) for x in self.mmd_index()["entries"]], [("新舞", None)])

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_remove_empties_the_list_and_marks_the_shared_entry(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig())
        action = self.success(self.run_import(self.vmd(), self.host()))["action"]["id"]
        doc = self.success(self.edit("remove", self.host(), action))
        self.assertEqual(doc, dict(ok=True, character="fixture", version="1.0.2", id=action))
        self.assertEqual(self.listed()["motions"], [])
        [entry] = self.mmd_index()["entries"]
        self.assertIsNotNone(entry["removed_at"])
        self.assertEqual(self.mmd_list()["entries"], [])
        self.assertFalse((self.library.root / ".vmd-stage/fixture").exists())

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_host_rejection_of_a_remove_leaves_the_library_and_removes_the_stage(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig())
        action = self.success(self.run_import(self.vmd(), self.host()))["action"]["id"]
        before = self.files()
        doc = self.failure(self.edit("remove", self.host(reject=True), action))
        self.assertEqual(doc["reason"], "validate_failed"); self.assertIn("pack_rejected", doc["detail"])
        self.assertEqual(self.files(), before)
        self.assertEqual([p.name for p in (self.library.root / ".vmd-stage").iterdir()], [".lock"])

    @needs_numpy  # edit.py imports the motion graph, which imports numpy
    def test_remove_of_a_native_action_is_not_imported(self):
        self.install(); before = self.files()
        doc = self.failure(self.edit("remove", self.host(), "fixture_0"))
        self.assertEqual(doc["reason"], "not_imported")
        self.assertEqual({k: v for k, v in self.files().items() if k.parts[0] != ".vmd-stage"}, before)

    WALK = "bvh_0123456789abcdef"

    def install_walk(self, name, metadata=None, intents=None, rows=()):
        """A fresh library, made self.library, with a package whose BVH import WALK added the clip walk: metadata replaces fields
        of walk's clip metadata, intents adds intent-motion-map clips, rows adds animation action rows."""
        row = dict(id=self.WALK, name="walk", section="idle", clips=["walk"], trigger="导入 BVH · 手动播放", duration=1.0)
        report = dict(schema="endfield-motion-import/v1", character="fixture", format="bvh", action=dict(id=self.WALK, clip="walk"))
        idle = dict(id="fixture_0", name="idle", section="idle", clips=["idle"])
        motion = dict(clips=dict(walk=(1.0, False), nod=(.4, False)), metadata=dict(walk=metadata or {}),
                      animation={"intent-motion-map.json": {"clips": {"idle": {}, "walk": {}, "nod": {}, **(intents or {})}},
                                 "actions.json": {"schema": "endfield-character-actions-v1", "actions": [idle, row, *rows]}},
                      interaction={"motion-metadata.json": {"clips": {"walk": {}}}, "blend-times.json": {"clips": {"walk": {}}}})
        source = self.root / ("source-" + name); motion_fixture(source, imported=[(row, report)], motion=motion)
        self.library = Library(self.root / ("library-" + name)); self.library.install(source)

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_remove_of_an_import_whose_metadata_names_a_file_outside_the_package_deletes_nothing(self):
        """A third-party package's clip metadata is package data: an absolute or .. keys or oracle path is refused before any unlink."""
        sentinel = self.root / "thesis.docx"; sentinel.write_bytes(b"the user's own file")
        up = "../" * 40 + str(sentinel).lstrip("/")
        # The last case, with the fixture's own paths, is removed.
        cases = [(field, path) for field in ("oracle", "keys") for path in (str(sentinel), up)] + [(None, None)]
        for n, (field, path) in enumerate(cases):
            with self.subTest(field=field, path=path):
                self.install_walk(str(n), metadata={field: dict(file=path)} if field else None)
                before = self.published()
                result = self.edit("remove", self.host(), self.WALK)
                if not field:
                    self.success(result); continue
                doc = self.failure(result)
                self.assertEqual(doc["reason"], "outside_package")
                self.assertEqual(sentinel.read_bytes(), b"the user's own file")
                self.assertEqual(self.published(), before)
                self.assertEqual([p.name for p in (self.library.root / ".vmd-stage").iterdir()], [".lock"])

    @needs_numpy
    def test_running_import_makes_a_second_one_busy(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig()); snapshot = self.library.snapshot()
        stages = self.library.root / ".vmd-stage"; stages.mkdir()
        with (stages / ".lock").open("a", encoding="utf-8") as lock:
            lock_file(lock)
            doc = self.failure(self.run_import(self.vmd(), self.host()))
        self.assertEqual(doc["reason"], "busy")
        self.assertEqual(self.library.snapshot(), snapshot)

    @needs_numpy
    def test_motion_over_360_seconds_is_too_long(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig()); before = self.files()
        doc = self.failure(self.run_import(self.vmd(seconds=361), self.host()))
        self.assertEqual(doc["reason"], "too_long")
        self.assertEqual(self.files(), before)

    @needs_numpy
    def test_a_motion_of_360_seconds_passes_the_precheck(self):
        import motion_tool
        from test_vmd_import import authored_rig
        from agentic_complex_build.motion_import import take
        package = self.install(rig=authored_rig())
        self.assertEqual(motion_tool.precheck(package, self.vmd(seconds=360), "vmd", 0), "vmd")
        self.assertEqual(take.MAX_SECONDS, motion_tool.MAX_SECONDS)

    @needs_numpy
    def test_a_music_offset_that_is_not_finite_is_refused_before_any_write(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig()); before = self.files()
        for value in ("nan", "inf", "-inf"):
            doc = self.failure(self.run_import(self.vmd(), self.host(), "--bgm-start=" + value))
            self.assertEqual(doc["reason"], "bad_source")
        self.assertEqual(self.files(), before)

    def wav(self, name):
        path = self.root / name
        with wave.open(str(path), "wb") as audio:
            audio.setparams((2, 2, 48000, 0, "NONE", "not compressed")); audio.writeframes(bytes(4 * 48000))
        return path

    def camera_vmd(self):
        from agentic_complex_build.mmd.io import Vmd, write_vmd
        path = self.root / "camera.vmd"
        key = lambda frame, distance: (frame, distance, (0, 10, 0), (0, 0, 0), bytes([20, 107, 20, 107] * 6), 30, 0)
        write_vmd(Vmd(cameras=[key(0, -45.), key(10, -30.), key(11, -50.)]), path)
        return path

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "Windows refuses a bgm import: test_a_bgm_import_on_windows_is_refused_before_the_package_is_copied")
    def test_zip_with_vmd_and_wav_imports_with_bgm(self):
        from test_vmd_import import authored_rig
        from agentic_complex_build.motion_import.take import check_mmd_index, check_result
        self.install(rig=authored_rig())
        archive = self.root / "set.zip"
        with zipfile.ZipFile(archive, "w") as z:
            z.write(self.vmd(), "set/dance.vmd"); z.write(self.wav("song.wav"), "set/song.wav"); z.writestr("set/readme.txt", "hi")
        doc = self.success(self.run_import(archive, self.host()))
        check_result(doc)
        self.assertIs(doc["action"]["has_bgm"], True); self.assertIsNotNone(doc["tracks"]["audio"])
        self.assertEqual((doc["source"]["name"], doc["warnings"]), ("dance.vmd", ["ignored_file: readme.txt"]))
        kept = self.library.root / "mmd-library/sources"
        [entry] = self.mmd_index()["entries"]
        check_mmd_index(self.mmd_index())
        self.assertEqual((entry["source"]["name"], entry["bgm"]["name"], entry["bgm"]["offset_s"], entry["camera"]), ("dance.vmd", "song.wav", None, None))
        self.assertEqual((kept / entry["bgm"]["file"]).read_bytes(), self.wav("song.wav").read_bytes())
        # The library keeps the files it bakes from, not the ZIP.
        self.assertEqual(sorted(p.name for p in kept.iterdir()), sorted([entry["source"]["file"], entry["bgm"]["file"]]))
        self.assertEqual([p.name for p in (self.library.root / ".vmd-stage").iterdir()], [".lock"])

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_extra_camera_vmd_is_recorded(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig())
        camera = self.camera_vmd()
        doc = self.success(self.run_import(self.vmd(), self.host(), "--extra", str(camera)))
        self.assertEqual((doc["tracks"]["camera"]["frames"], doc["tracks"]["camera"]["cuts"]), (31, [11]))
        kept = self.library.root / "mmd-library/sources"
        [entry] = self.mmd_index()["entries"]
        self.assertEqual((entry["camera"]["name"], entry["camera"]["sha256"]), ("camera.vmd", hashlib.sha256(camera.read_bytes()).hexdigest()))
        self.assertEqual((kept / entry["camera"]["file"]).read_bytes(), camera.read_bytes())
        self.assertEqual([p.name for p in (self.library.root / ".vmd-stage").iterdir()], [".lock"])

    def second_character(self, rig=None):
        source = self.root / "second"
        motion_fixture(source, cid="second", rig=rig)
        self.library.install(source)
        return next(p for p in self.library.packages() if p.id == "second")

    def mmd_index(self):
        return json.loads((self.library.root / "mmd-library/index.json").read_text(encoding="utf-8"))

    def mmd_list(self):
        return self.success(tool_command("motion_tool.py", "mmd-list", "--library", str(self.library.root)))

    def sync_command(self, host, character="second"):
        return ["mmd-sync", "--library", str(self.library.root), "--character", character, "--validate-with", str(host)]

    def sync(self, host, character="second"):
        result = tool_command("motion_tool.py", *self.sync_command(host, character))
        self.assertEqual(result.returncode, 0, result.stderr)
        *progress, last = [json.loads(line) for line in result.stdout.splitlines()]
        total = len(self.mmd_index()["entries"])
        check_progress(self, progress)
        self.assertEqual(progress[0], dict(event="progress", stage="read", fraction=0, total=total, done=0))
        self.assertEqual([line["done"] for line in progress], sorted(line["done"] for line in progress))
        self.assertEqual(progress[-1]["done"], total)
        return last

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_mmd_import_is_shared_across_characters(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig()); self.second_character(authored_rig())
        first = self.success(self.run_import(self.vmd(), self.host()))
        [entry] = self.mmd_index()["entries"]
        self.assertEqual((entry["id"], entry["duration_s"], entry["failures"]), (first["action"]["id"], 1.0, {}))
        self.assertEqual((self.library.root / "mmd-library/sources" / entry["source"]["file"]).read_bytes(), self.vmd().read_bytes())
        self.assertFalse((self.library.root / "motion-imports/fixture/imports.json").exists())
        self.success(tool_command("motion_tool.py", "import", "--library", str(self.library.root), "--character", "second",
                                  "--source", str(self.vmd()), "--validate-with", str(self.host())))
        self.assertEqual(self.mmd_index()["entries"], [entry])

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "Windows refuses a bgm import: test_a_bgm_import_on_windows_is_refused_before_the_package_is_copied")
    def test_mmd_sync_bakes_once_and_lists_both_characters(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig()); self.second_character(authored_rig())
        archive = self.root / "dance.zip"
        with zipfile.ZipFile(archive, "w") as z:
            z.write(self.vmd(), "dance.vmd"); z.write(self.camera_vmd(), "camera.vmd"); z.write(self.wav("song.wav"), "song.wav")
        first = self.success(self.run_import(archive, self.host(), "--bgm-start", "0.25", "--no-foot-lock"))
        second = self.success(self.run_import(self.vmd(seconds=2), self.host()))
        host = self.host()
        with host.open("a", encoding="utf-8") as stream: stream.write("with pathlib.Path(__file__).with_suffix('.calls').open('a') as f: f.write('validate\\n')\n")
        result = self.sync(host)
        self.assertEqual(result, dict(ok=True, character="second", version="1.0.1", baked=[first["action"]["id"], second["action"]["id"]],
                                      renamed=[], music=[], removed=[], failed=[]))
        self.assertEqual(host.with_suffix('.calls').read_text(encoding="utf-8").splitlines(), ["validate"])
        self.assertEqual([e["characters"] for e in self.mmd_list()["entries"]],
                         [[dict(id="fixture", state="baked", reason=None), dict(id="second", state="baked", reason=None)]] * 2)
        self.assertEqual(len(list((self.library.root / "packages/second").iterdir())), 2)
        package = next(p for p in self.library.packages() if p.id == "second")
        report = json.loads((package.root / "provenance" / ("vmd-" + first["action"]["id"][4:] + ".json")).read_text(encoding="utf-8"))
        self.assertIs(report["provenance"]["foot_ik"], False)
        self.assertEqual(report["bgm"]["source_start_seconds"], .25)
        self.assertIsNotNone(report["camera"])

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_imports_and_mmd_sync_record_the_version_they_derive_from(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig()); self.second_character(authored_rig())
        self.success(self.run_import(self.vmd(), self.host()))
        self.success(self.run_import(self.vmd(seconds=2), self.host()))
        self.sync(self.host())
        self.assertEqual({p.id: (p.version, p.document["base_package_version"]) for p in self.library.packages()},
                         dict(fixture=("1.0.2", "1.0.0"), second=("1.0.1", "1.0.0")))

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_mmd_sync_no_changes_keeps_version(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig())
        self.success(self.run_import(self.vmd(), self.host()))
        before = self.library.snapshot()
        result = self.sync(self.host(), "fixture")
        self.assertEqual((result["version"], result["baked"]), ("1.0.1", []))
        self.assertEqual(self.library.snapshot(), before)

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_mmd_sync_failure_retries_only_after_package_changes(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig()); package = self.second_character()
        imported = self.success(self.run_import(self.vmd(), self.host()))
        result = self.sync(self.host())
        self.assertEqual(result["failed"][0]["reason"], "missing_bones")
        failure = self.mmd_index()["entries"][0]["failures"]["second"]
        self.assertEqual((failure["reason"], failure["package_sha256"]), ("missing_bones", package.sha256))
        self.assertTrue(failure["detail"])
        self.assertEqual(self.mmd_list()["entries"][0]["characters"][1], dict(id="second", state="failed", reason="missing_bones"))
        self.assertEqual(self.sync(self.host())["failed"], [])
        replacement = self.root / "replacement"; motion_fixture(replacement, cid="second", rig=authored_rig())
        definition = json.loads((replacement / "character.json").read_text(encoding="utf-8")); definition["version"] = "1.0.1"
        write_json(replacement / "character.json", definition); self.library.upgrade(replacement, package.sha256)
        self.assertEqual(self.mmd_list()["entries"][0]["characters"][1]["state"], "pending")
        self.assertEqual(self.sync(self.host())["baked"], [imported["action"]["id"]])
        self.assertEqual(self.mmd_index()["entries"][0]["failures"], {})

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "Windows refuses a bgm import: test_a_bgm_import_on_windows_is_refused_before_the_package_is_copied")
    def test_mmd_sync_uses_shared_sources_without_an_existing_bake(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig()); self.second_character(authored_rig())
        imported = self.success(self.run_import(self.vmd(), self.host(), "--no-foot-lock", "--bgm", str(self.wav("song.wav")), "--bgm-start", "0.25"))
        package = next(p for p in self.library.packages() if p.id == "fixture")
        replacement = self.root / "replacement"; motion_fixture(replacement, rig=authored_rig())
        definition = json.loads((replacement / "character.json").read_text(encoding="utf-8")); definition["version"] = "1.0.2"
        write_json(replacement / "character.json", definition); self.library.upgrade(replacement, package.sha256)
        result = self.sync(self.host())
        self.assertEqual(result["baked"], [imported["action"]["id"]])
        self.assertEqual(self.mmd_list()["entries"][0]["characters"][1]["state"], "baked")

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_mmd_sync_keeps_a_reimported_live_id(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig()); self.second_character(authored_rig())
        action = self.success(self.run_import(self.vmd(), self.host()))["action"]["id"]
        self.success(self.edit("remove", self.host(), action))
        self.success(tool_command("motion_tool.py", "import", "--library", str(self.library.root), "--character", "second",
                                  "--source", str(self.vmd()), "--validate-with", str(self.host())))
        self.assertEqual(self.sync(self.host()), dict(ok=True, character="second", version="1.0.1", baked=[], renamed=[], music=[], removed=[], failed=[]))
        self.assertEqual(self.mmd_list()["entries"][0]["characters"][1]["state"], "baked")

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_mmd_rename_and_remove_propagate_on_sync(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig()); self.second_character(authored_rig())
        action = self.success(self.run_import(self.vmd(), self.host()))["action"]["id"]
        self.sync(self.host())
        self.success(self.edit("rename", self.host(), action, "--title", " 新舞 "))
        self.assertEqual(self.mmd_index()["entries"][0]["title"], "新舞")
        self.assertEqual(self.sync(self.host())["renamed"], [action])
        second = next(p for p in self.library.packages() if p.id == "second")
        self.assertEqual(json.loads((second.root / "runtime/animation/actions.json").read_text(encoding="utf-8"))["actions"][-1]["name"], "新舞")
        self.success(self.edit("remove", self.host(), action))
        self.assertIsNotNone(self.mmd_index()["entries"][0]["removed_at"])
        self.assertEqual(self.sync(self.host())["removed"], [action])
        self.assertEqual(self.mmd_list()["entries"], [])
        second = next(p for p in self.library.packages() if p.id == "second")
        self.assertNotIn(action, [r["id"] for r in json.loads((second.root / "runtime/animation/actions.json").read_text(encoding="utf-8"))["actions"]])

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_mmd_edit_without_a_baked_row_only_updates_index(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig()); package = self.second_character()
        action = self.success(self.run_import(self.vmd(), self.host()))["action"]["id"]
        for command, extra in (("rename", ["--title", "shared"]), ("remove", [])):
            doc = self.success(tool_command("motion_tool.py", command, "--library", str(self.library.root), "--character", "second",
                                           "--action", action, "--validate-with", str(self.host()), *extra))
            self.assertEqual(doc["version"], package.version)
            self.assertEqual(next(p for p in self.library.packages() if p.id == "second").sha256, package.sha256)
            self.assertEqual(self.mmd_index()["entries"][0]["title"], "shared")
        self.assertIsNotNone(self.mmd_index()["entries"][0]["removed_at"])

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_mmd_sync_sigterm_cleans_stage_without_publishing(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig()); self.second_character(authored_rig())
        self.success(self.run_import(self.vmd(), self.host()))
        before = self.library.snapshot()
        index = self.library.root / "mmd-library/index.json"
        original = index.read_bytes()
        host = self.host(); ready = self.root / "validating"
        with host.open("a", encoding="utf-8") as stream: stream.write("pathlib.Path(" + repr(str(ready)) + ").touch()\nimport time\ntime.sleep(2)\n")
        process = subprocess.Popen([sys.executable, "-I", "-B", str(REPO / "agent/agentd/motion_tool.py"), *self.sync_command(host)],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")
        try:
            deadline = time.monotonic() + 15
            while not ready.exists() and process.poll() is None and time.monotonic() < deadline: time.sleep(.02)
            self.assertTrue(ready.exists(), process.stderr.read() if process.poll() is not None else "sync did not reach validation")
            process.send_signal(signal.SIGTERM)
            stdout, stderr = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 143, stderr)
            self.assertFalse(any(json.loads(line).get("ok") for line in stdout.splitlines()))
        finally:
            if process.poll() is None: process.kill()
            process.communicate()
        self.assertEqual(self.library.snapshot(), before)
        self.assertEqual(index.read_bytes(), original)
        self.assertEqual([p.name for p in (self.library.root / ".vmd-stage").iterdir()], [".lock"])

    @needs_numpy
    def test_mmd_sync_is_busy_when_import_lock_is_held(self):
        self.install()
        stages = self.library.root / ".vmd-stage"; stages.mkdir()
        with (stages / ".lock").open("a", encoding="utf-8") as lock:
            lock_file(lock)
            doc = self.failure(tool_command("motion_tool.py", *self.sync_command(self.host(), "fixture")))
        self.assertEqual(doc["reason"], "busy")

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_mmd_remove_reclaims_shared_sources_no_live_entry_names(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig())
        kept = self.success(self.run_import(self.vmd(), self.host()))["action"]["id"]
        gone = self.success(self.run_import(self.vmd(seconds=2), self.host()))["action"]["id"]
        self.success(self.edit("remove", self.host(), gone))
        sources = self.library.root / "mmd-library/sources"
        live = next(e for e in self.mmd_index()["entries"] if e["id"] == kept)["source"]["file"]
        self.assertEqual([p.name for p in sources.iterdir()], [live])

    def test_mmd_list_leaves_out_text_only_characters_which_motion_commands_refuse(self):
        from test_character_library import text_fixture
        self.install(); text_fixture(self.root / "aide"); self.library.install(self.root / "aide")
        sources = self.library.root / "mmd-library/sources"; sources.mkdir(parents=True); (sources / "dance.vmd").write_bytes(b"vmd")
        write_json(self.library.root / "mmd-library/index.json", dict(schema="endfield-mmd-library/v2", entries=[dict(
            id="mmd_0123456789abcdef", title="dance", duration_s=1.0, created_at="2026-11-01T00:00:00+00:00", removed_at=None,
            source=dict(file="dance.vmd", sha256=hashlib.sha256(b"vmd").hexdigest(), name="dance.vmd"), morph=None, camera=None, bgm=None,
            foot_lock=True, has_face=True, project=dict(title="サンプルダンス", role="SampleDancerA", place_frame=-19), failures={})]))
        [entry] = self.mmd_list()["entries"]
        self.assertEqual(entry["characters"], [dict(id="fixture", state="pending", reason=None)])
        self.assertEqual((entry["has_face"], entry["project"], entry["role"]), (True, "サンプルダンス", "SampleDancerA"))
        doc = self.failure(tool_command("motion_tool.py", "list", "--library", str(self.library.root), "--character", "aide"))
        self.assertEqual(doc["reason"], "unsupported_character")

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_mmd_sync_with_a_tombstone_beside_a_failing_live_entry_publishes_the_other_bake(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig()); self.second_character(authored_rig())
        action = self.success(self.run_import(self.vmd(), self.host()))["action"]["id"]
        self.success(self.edit("remove", self.host(), action))
        self.success(self.run_import(self.vmd(), self.host()))
        other = self.success(self.run_import(self.vmd(seconds=2), self.host()))["action"]["id"]
        index = self.mmd_index(); live = [e for e in index["entries"] if e["id"] == action and e["removed_at"] is None]
        self.assertEqual(len([e for e in index["entries"] if e["id"] == action]), 2)
        # Its kept body no longer parses, so its bake fails.
        (self.library.root / "mmd-library/sources" / live[0]["source"]["file"]).write_bytes(b"not a vmd")
        result = self.sync(self.host())
        self.assertEqual((result["baked"], [f["id"] for f in result["failed"]]), ([other], [action]))
        second = next(p for p in self.library.packages() if p.id == "second")
        self.assertEqual(result["version"], second.version)
        failure = next(e for e in self.mmd_index()["entries"] if e["id"] == action and e["removed_at"] is None)["failures"]["second"]
        self.assertEqual(failure["package_sha256"], second.sha256)

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_list_dates_a_reimported_motion_by_its_live_import(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig())
        action = self.success(self.run_import(self.vmd(), self.host()))["action"]["id"]
        self.success(self.edit("remove", self.host(), action))
        again = self.success(self.run_import(self.vmd(), self.host()))
        index = self.mmd_index(); next(e for e in index["entries"] if e["removed_at"] is not None)["created_at"] = "2026-01-01T00:00:00+00:00"
        write_json(self.library.root / "mmd-library/index.json", index)
        [motion] = self.listed()["motions"]
        self.assertEqual(motion["created_at"], again["created_at"])

    @needs_numpy
    def test_the_protocol_mmd_library_fixture_is_a_v2_library(self):
        from agentic_complex_build.motion_import.take import check_mmd_index
        doc = json.loads((REPO / "protocol/character-library/fixtures/motion-import/mmd-library-v2.json").read_text(encoding="utf-8"))
        check_mmd_index(doc)
        entry = doc["entries"][0]
        for broken in (dict(doc, schema="endfield-mmd-library/v1"), dict(doc, entries=[{k: v for k, v in entry.items() if k != "has_face"}]),
                       dict(doc, entries=[dict(entry, bgm=dict(entry["bgm"], offset_s="0"))]), dict(doc, entries=[dict(entry, zip=None)])):
            with self.assertRaises(ValueError): check_mmd_index(broken)

    @needs_numpy
    def test_a_v1_library_reads_as_empty(self):
        self.install()
        sources = self.library.root / "mmd-library/sources"; sources.mkdir(parents=True)
        write_json(self.library.root / "mmd-library/index.json", dict(schema="endfield-mmd-library/v1", entries=[dict(
            id="mmd_0123456789abcdef", title="dance", duration_s=1.0, created_at="2026-11-01T00:00:00+00:00", removed_at=None,
            source=dict(file="dance.vmd", sha256="0" * 64, name="dance.vmd"), camera=None, bgm=None, zip=None, failures={})]))
        self.assertEqual(self.mmd_list()["entries"], [])

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_mmd_sync_removes_imported_rows_no_library_entry_names(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig())
        action = self.success(self.run_import(self.vmd(), self.host()))["action"]["id"]
        write_json(self.library.root / "mmd-library/index.json", dict(schema="endfield-mmd-library/v2", entries=[]))
        result = tool_command("motion_tool.py", *self.sync_command(self.host(), "fixture"))
        self.assertEqual(result.returncode, 0, result.stderr)
        doc = json.loads(result.stdout.splitlines()[-1])
        self.assertEqual((doc["removed"], doc["version"]), ([action], "1.0.2"))
        self.assertEqual(self.listed()["motions"], [])

    def in_process(self, *argv):
        """motion_tool's main in this process, so that a test can patch the importer: (exit code, result line, stderr)."""
        import contextlib, io
        from unittest import mock
        import motion_tool
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, "argv", ["motion_tool.py", *argv]), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = motion_tool.main()
        return code, json.loads(out.getvalue().splitlines()[-1]) if out.getvalue() else None, err.getvalue()

    def face_vmd(self):
        from agentic_complex_build.mmd.io import Vmd, MorphKey, write_vmd
        path = self.root / "lip.vmd"
        write_vmd(Vmd(morphs=[MorphKey("あ", 0, 0.), MorphKey("あ", 30, 1.)]), path)
        return path

    def recording_importer(self):
        """A patch of the VMD adapter's import_motion that records each call's keywords and bakes without the face VMD and
        the music offset, which another change teaches import_motion."""
        from unittest import mock
        from agentic_complex_build.motion_import import vmd as adapter
        real, calls = adapter.import_motion, []
        def recorded(*args, **options): calls.append(options); return real(*args, **dict(options, morph_vmd=None, bgm_start=None))
        return mock.patch.object(adapter, "import_motion", side_effect=recorded), calls

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "Windows refuses a bgm import: test_a_bgm_import_on_windows_is_refused_before_the_package_is_copied")
    def test_import_passes_the_face_camera_and_a_negative_offset_and_records_a_v2_entry(self):
        from test_vmd_import import authored_rig
        from agentic_complex_build.motion_import.take import check_mmd_index
        self.install(rig=authored_rig())
        body, face, camera, song = self.vmd(name="Dance_SampleDancerA[f-19].vmd"), self.face_vmd(), self.camera_vmd(), self.wav("inst.wav")
        patch, calls = self.recording_importer()
        with patch:
            code, doc, err = self.in_process("import", "--library", str(self.library.root), "--character", "fixture", "--source", str(body),
                                             "--morph", str(face), "--camera", str(camera), "--bgm", str(song), "--bgm-start", "-0.633",
                                             "--title", "サンプル · Sample", "--project", "サンプル", "--role", "SampleDancerA",
                                             "--validate-with", str(self.host()))
        self.assertEqual(code, 0, err)
        [call] = calls
        self.assertEqual((call["morph_vmd"], call["camera"], call["bgm"], call["bgm_start"], call["foot_ik"], call["title"]),
                         (face, camera, song, -0.633, True, "サンプル · Sample"))
        index = self.mmd_index(); check_mmd_index(index); [entry] = index["entries"]
        self.assertEqual((entry["id"], entry["title"], entry["morph"]["name"], entry["camera"]["name"], entry["bgm"]["name"], entry["bgm"]["offset_s"]),
                         (doc["action"]["id"], "サンプル · Sample", "lip.vmd", "camera.vmd", "inst.wav", -0.633))
        self.assertEqual(entry["project"], dict(title="サンプル", role="SampleDancerA", place_frame=-19))
        sources = self.library.root / "mmd-library/sources"
        self.assertEqual((sources / entry["morph"]["file"]).read_bytes(), face.read_bytes())

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "Windows refuses a bgm import: test_a_bgm_import_on_windows_is_refused_before_the_package_is_copied")
    def test_mmd_sync_bakes_an_entry_with_exactly_its_stored_options(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig()); self.second_character(authored_rig())
        patch, calls = self.recording_importer()
        with patch:
            code, imported, err = self.in_process("import", "--library", str(self.library.root), "--character", "fixture",
                "--source", str(self.vmd()), "--morph", str(self.face_vmd()), "--camera", str(self.camera_vmd()), "--bgm", str(self.wav("song.wav")),
                "--bgm-start", "0.25", "--no-foot-lock", "--title", "舞", "--validate-with", str(self.host()))
            self.assertEqual(code, 0, err)
            code, synced, err = self.in_process(*self.sync_command(self.host()))
        self.assertEqual(code, 0, err)
        self.assertEqual(synced["baked"], [imported["action"]["id"]])
        [entry] = self.mmd_index()["entries"]; sources = self.library.root / "mmd-library/sources"
        self.assertEqual({k: calls[1][k] for k in ("morph_vmd", "camera", "bgm", "bgm_start", "foot_ik", "title")},
                         dict(morph_vmd=sources / entry["morph"]["file"], camera=sources / entry["camera"]["file"],
                              bgm=sources / entry["bgm"]["file"], bgm_start=.25, foot_ik=False, title="舞"))

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "Windows refuses a bgm import: test_a_bgm_import_on_windows_is_refused_before_the_package_is_copied")
    def test_mmd_media_swaps_the_music_of_the_entry_and_its_row_without_a_new_bake(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig())
        action = self.success(self.run_import(self.vmd(), self.host(), "--title", "舞", "--no-foot-lock", "--bgm", str(self.wav("song.wav"))))["action"]["id"]
        created = self.mmd_index()["entries"][0]["created_at"]
        pack = lambda: next(p for p in self.library.packages() if p.id == "fixture").root / "runtime"
        wav = lambda: pack() / "animation/music" / (action[len("mmd_"):] + ".wav")
        blend = lambda: json.loads((pack() / "interaction/blend-times.json").read_text(encoding="utf-8"))["clips"]["imported_vmd_" + action[4:]]["blend_in_s"]
        before = wav().read_bytes()
        media = lambda *extra: self.in_process("mmd-media", "--library", str(self.library.root), "--character", "fixture",
                                               "--action", action, *extra, "--validate-with", str(self.host()))
        patch, calls = self.recording_importer()
        with patch: code, doc, err = media("--bgm", str(self.tone("other.wav")), "--bgm-start", "0.25")
        self.assertEqual(code, 0, err)
        self.assertEqual(doc, dict(ok=True, character="fixture", version="1.0.2", action=dict(id=action, title="舞", duration_s=1.0, has_bgm=True)))
        self.assertEqual(calls, [])
        self.assertNotEqual(wav().read_bytes(), before)
        self.assertEqual(blend(), 0)
        [entry] = self.mmd_index()["entries"]
        self.assertEqual((entry["id"], entry["created_at"], entry["removed_at"], entry["foot_lock"], entry["bgm"]["name"], entry["bgm"]["offset_s"]),
                         (action, created, None, False, "other.wav", .25))
        self.assertEqual([m["id"] for m in self.listed()["motions"]], [action])
        with patch: code, doc, err = media("--no-bgm")
        self.assertEqual(code, 0, err)
        self.assertEqual((doc["action"], doc["version"]), (dict(id=action, title="舞", duration_s=1.0, has_bgm=False), "1.0.3"))
        self.assertEqual((blend(), wav().exists(), (pack() / "animation/motion-media.json").exists()), (.25, False, False))
        [entry] = self.mmd_index()["entries"]
        self.assertEqual((entry["id"], entry["bgm"], entry["removed_at"]), (action, None, None))
        self.assertEqual(calls, [])
        self.assertEqual(self.failure(tool_command("motion_tool.py", "mmd-media", "--library", str(self.library.root), "--character", "fixture",
                                                   "--action", "mmd_nope", "--no-bgm", "--validate-with", str(self.host())))["reason"], "unknown_action")

    def unkeepable_music(self):
        """Music paths no import may keep: no file, a folder, no audio, a link to a wav."""
        notes = self.root / "notes.txt"; notes.write_text("hi", encoding="utf-8")
        folder = self.root / "folder.wav"; folder.mkdir()
        songs = [self.root / "missing.wav", folder, notes]
        if sys.platform != "win32":
            link = self.root / "linked.wav"; link.symlink_to(self.wav("outside.wav")); songs.append(link)
        return songs

    def refused_music(self, run, songs):
        """Each song refused by run(song) as bad_source, with the library untouched; also a wav over the size limit and any wav on
        Windows."""
        from unittest import mock
        import motion_tool  # imported before sys.platform changes
        from agentic_complex_build import import_vmd
        before = self.files()
        failed = lambda: json.loads(run(song)[2].strip().splitlines()[-1])["reason"]
        for song in songs: self.assertEqual(failed(), "bad_source", song)
        song = self.wav("song.wav")
        with mock.patch.object(import_vmd, "MAX_MUSIC_BYTES", song.stat().st_size - 1): self.assertEqual(failed(), "bad_source")
        with mock.patch.object(sys, "platform", "win32"): self.assertEqual(failed(), "bad_source")
        self.assertEqual({p: b for p, b in self.files().items() if p.parts[0] != ".vmd-stage"},
                         {p: b for p, b in before.items() if p.parts[0] != ".vmd-stage"})

    def test_mmd_media_refuses_music_it_cannot_keep_for_a_dance_the_character_has_not_baked(self):
        self.install(); self.shared_dance("0123456789abcdef", bgm=False)
        self.refused_music(lambda song: self.in_process("mmd-media", "--library", str(self.library.root), "--character", "fixture",
                                                        "--action", "mmd_0123456789abcdef", "--bgm", str(song), "--validate-with", str(self.host())),
                           self.unkeepable_music())

    def test_import_refuses_music_it_cannot_keep_before_reading_the_motion(self):
        self.install()
        self.refused_music(lambda song: self.in_process("import", "--library", str(self.library.root), "--character", "fixture",
                                                        "--source", str(self.root / "unread.vmd"), "--bgm", str(song),
                                                        "--validate-with", str(self.host())),
                           self.unkeepable_music())

    def tone(self, name):
        """A second of a square wave, unlike wav's silence."""
        path = self.root / name
        with wave.open(str(path), "wb") as audio:
            audio.setparams((2, 2, 48000, 0, "NONE", "not compressed")); audio.writeframes(struct.pack("<96000h", *([1000, 1000, -1000, -1000] * 24000)))
        return path

    def music_of(self, cid, action):
        return (next(p for p in self.library.packages() if p.id == cid).root / "runtime/animation/music" / (action[len("mmd_"):] + ".wav")).read_bytes()

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "Windows refuses a bgm import: test_a_bgm_import_on_windows_is_refused_before_the_package_is_copied")
    def test_mmd_sync_swaps_only_the_music_of_a_dance_another_character_gave_new_music(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig()); self.second_character(authored_rig())
        action = self.success(self.run_import(self.vmd(), self.host(), "--bgm", str(self.wav("song.wav"))))["action"]["id"]
        self.assertEqual(self.sync(self.host())["baked"], [action])
        patch, calls = self.recording_importer()
        with patch:
            code, doc, err = self.in_process("mmd-media", "--library", str(self.library.root), "--character", "fixture", "--action", action,
                                             "--bgm", str(self.tone("other.wav")), "--validate-with", str(self.host()))
            self.assertEqual(code, 0, err)
            self.assertEqual([e["characters"] for e in self.mmd_list()["entries"]],
                             [[dict(id="fixture", state="baked", reason=None), dict(id="second", state="pending", reason=None)]])
            code, synced, err = self.in_process(*self.sync_command(self.host()))
        self.assertEqual(code, 0, err)
        self.assertEqual(calls, [])
        self.assertEqual((synced["music"], synced["baked"], synced["renamed"], synced["failed"], synced["version"]), ([action], [], [], [], "1.0.2"))
        self.assertEqual(self.music_of("second", action), self.music_of("fixture", action))
        self.assertEqual(self.mmd_list()["entries"][0]["characters"][1]["state"], "baked")
        again = self.sync(self.host())
        self.assertEqual((again["music"], again["version"]), ([], "1.0.2"))

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "Windows refuses a bgm import: test_a_bgm_import_on_windows_is_refused_before_the_package_is_copied")
    def test_mmd_sync_bakes_a_dance_given_new_music_before_its_bake_under_the_same_id(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig()); self.second_character(authored_rig())
        action = self.success(self.run_import(self.vmd(), self.host(), "--bgm", str(self.wav("song.wav"))))["action"]["id"]
        song = self.tone("other.wav")
        self.success(tool_command("motion_tool.py", "mmd-media", "--library", str(self.library.root), "--character", "fixture", "--action", action,
                                  "--bgm", str(song), "--validate-with", str(self.host())))
        result = self.sync(self.host())
        self.assertEqual((result["baked"], result["failed"]), ([action], []))
        self.assertEqual(self.music_of("second", action), self.music_of("fixture", action))
        second = next(p for p in self.library.packages() if p.id == "second")
        report = json.loads((second.root / "provenance" / ("vmd-" + action[4:] + ".json")).read_text(encoding="utf-8"))
        self.assertEqual(report["bgm"]["source_sha256"], hashlib.sha256(song.read_bytes()).hexdigest())

    def baked_dance(self, cid, identity, face=None, camera=None, music=None):
        """Installs character cid with mmd_<identity> baked as an import leaves it: its row, report and, when given, the face
        clip document, camera clip document and music wav bytes."""
        clip = "imported_vmd_" + identity
        row = {"id": "mmd_" + identity, "name": "舞", "section": "idle", "clips": [clip], "trigger": "导入 VMD · 手动播放", "duration": 20.0}
        report = {"schema": "endfield-vmd-import/v1", "action": "mmd_" + identity, "clip": clip, "duration": 20.0, "bgm": None}
        animation, track = {}, {"action": "mmd_" + identity, "clip": clip, "length": 20.0}
        if face is not None:
            animation["face/%s.json" % clip] = face["document"]; track["face"] = {"facial_animation": "mmd_" + identity}
            report["face"] = {"mapped": face["mapped"], "unmapped": face["unmapped"], "file": "animation/face/%s.json" % clip}
        if camera is not None:
            animation["camera/%s.json" % clip] = camera; track["camera"] = {"file": "camera/%s.json" % clip}
            report["camera"] = {"cuts": camera["cuts"], "file": "animation/camera/%s.json" % clip}
        if music is not None:
            animation["music/%s.wav" % identity] = music; track["audio"] = {"file": "music/%s.wav" % identity}
            report["bgm"] = {"frames": 48000 * 20, "sample_rate": 48000}
        if track.keys() - {"action", "clip", "length"}:
            animation["motion-media.json"] = {"schema": "endfield-motion-media/v2", "tracks": [track]}
        source = self.root / cid
        motion_fixture(source, cid=cid, imported=[(row, report)], motion={"clips": {clip: (20.0, False)}, "animation": animation})
        self.library.install(source)

    def shared_dance(self, identity, bgm=True, removed=False):
        from agentic_complex_build.motion_import.take import MMD_SCHEMA
        index = self.library.root / "mmd-library/index.json"; index.parent.mkdir(exist_ok=True)
        doc = json.loads(index.read_text(encoding="utf-8")) if index.exists() else dict(schema=MMD_SCHEMA, entries=[])
        kept = lambda name: dict(file=hashlib.sha256(name.encode()).hexdigest() + Path(name).suffix, sha256="0" * 64, name=name)
        doc["entries"].append(dict(id="mmd_" + identity, title="舞", duration_s=20.0, created_at="2026-11-25T00:00:00+00:00",
                                   removed_at="2026-11-25T01:00:00+00:00" if removed else None, source=kept("dance.vmd"), morph=None,
                                   camera=None, bgm=dict(kept("song.wav"), offset_s=-0.5) if bgm else None, foot_lock=True,
                                   has_face=True, project=None, failures={}))
        write_json(index, doc)

    def mmd_detail(self, character, action):
        return tool_command("motion_tool.py", "mmd-detail", "--library", str(self.library.root), "--character", character, "--action", action)

    @needs_numpy
    def test_mmd_detail_gives_the_face_mapping_camera_cuts_music_and_lanes_of_a_baked_dance(self):
        identity = "0123456789abcdef"
        key = lambda t, v: {"time": t, "value": v, "in_slope": 0.0, "out_slope": 0.0, "weighted_mode": 0}
        curve = lambda control, keys: {"control": control, "curve": {"m_curve": [key(t, v) for t, v in keys]}}
        face = {"mapped": ["あ", "い"], "unmapped": ["てへぺろ"], "document": {
            "schema": "endfield-original-named-facial-animation/v1", "name": "舞", "duration": 20.0, "pause_auto_blink": True,
            "additive": False, "override": False,
            "curves": [curve("mouth_a_normal_ctrl", [(0, 0), (10, 1), (20, 0)]), curve("Mouth_O_ctrl", [(0, 0), (15, -1.5), (16, 0)]),
                       curve("brow_angry_m_L_ctrl", [(0, 1), (20, 1)])]}}
        camera = {"clip": "imported_vmd_" + identity, "frame_rate": 30, "frames": 4, "cuts": [30, 45, 100],
                  "fov_deg": [30.0, 12.5, 40.0, 30.0], "distance": [-45.0] * 4, "center": [[0, 0, 0]] * 4, "euler": [[0, 0, 0]] * 4}
        # Ten silent seconds, then ten of a square wave.
        half, music = 48000 * 10, io.BytesIO()
        with wave.open(music, "wb") as audio:
            audio.setparams((2, 2, 48000, 0, "NONE", "not compressed"))
            audio.writeframes(bytes(4 * half) + struct.pack("<%dh" % (2 * half), *([1000, 1000, -1000, -1000] * (half // 2))))
        music = music.getvalue()
        self.baked_dance("fixture", identity, face=face, camera=camera, music=music)
        self.shared_dance(identity)
        detail = self.success(self.mmd_detail("fixture", "mmd_" + identity))["detail"]
        self.assertEqual({k: detail[k] for k in ("id", "source", "face", "camera", "bgm")}, dict(
            id="mmd_" + identity, source="dance.vmd", face=dict(mapped=["あ", "い"], unmapped=["てへぺろ"], blink_from_dance=True),
            camera=dict(cuts=[1.0, 1.5, 3.333], fov_deg=[12.5, 40.0]), bgm=dict(name="song.wav", offset_s=-0.5)))
        lanes = detail["lanes"]
        self.assertEqual((lanes["bins"], len(lanes["mouth"]), len(lanes["loudness"])), (600, 600, 600))
        for lane in (lanes["mouth"], lanes["loudness"]): self.assertTrue(all(0 <= v <= 1 for v in lane))
        # Each slice is 1/30 s; the brow curve is no mouth control.
        self.assertAlmostEqual(lanes["mouth"][0], (1 / 60) / 10, places=6)
        self.assertAlmostEqual(lanes["mouth"][299], 299.5 / 30 / 10, places=6)
        self.assertEqual(lanes["mouth"][450], 1)
        self.assertEqual(lanes["loudness"][:300], [0] * 300)
        self.assertEqual(lanes["loudness"][300:], [1] * 300)

    def test_mmd_detail_reads_another_character_when_the_current_one_has_not_baked_the_dance(self):
        identity = "fedcba9876543210"
        motion_fixture(self.root / "fixture", cid="fixture"); self.library.install(self.root / "fixture")
        self.baked_dance("second", identity)
        self.shared_dance(identity, bgm=False)
        detail = self.success(self.mmd_detail("fixture", "mmd_" + identity))["detail"]
        self.assertEqual(detail, dict(id="mmd_" + identity, source="dance.vmd", face=None, camera=None, bgm=None,
                                      lanes=dict(bins=600, mouth=None, loudness=None)))

    def test_mmd_detail_of_an_unknown_or_unbaked_dance_fails(self):
        motion_fixture(self.root / "fixture", cid="fixture"); self.library.install(self.root / "fixture")
        self.shared_dance("1111111111111111")
        self.shared_dance("2222222222222222", removed=True)
        for action, reason in (("mmd_nope", "unknown_action"), ("mmd_2222222222222222", "unknown_action"),
                               ("mmd_1111111111111111", "not_baked")):
            result = self.mmd_detail("fixture", action)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertEqual(self.failure(result)["reason"], reason)

    @needs_numpy
    def test_mmd_scan_sorts_a_folder_into_bodies_cameras_and_audio(self):
        folder = self.root / "サンプルダンス"; (folder / "Camera/cam").mkdir(parents=True); (folder / "__MACOSX").mkdir()
        shutil.copyfile(self.vmd(seconds=2, model="サンプルモデルA"), folder / "Dance_Full_SampleDancerA_v1.1[f-19].vmd")
        shutil.copyfile(self.vmd(model="サンプルモデルB"), folder / "Dance_Full_SampleDancerB_v1.1[f-19].vmd")
        shutil.copyfile(self.camera_vmd(), folder / "Camera/cam/cam.vmd"); shutil.copyfile(self.wav("inst.wav"), folder / "inst.wav")
        (folder / "Readme.txt").write_text("hi", encoding="utf-8"); (folder / ".DS_Store").write_bytes(b"x")
        (folder / "__MACOSX/._inst.wav").write_bytes(b"x"); (folder / "broken.vmd").write_bytes(b"not a motion")
        unpack = self.root / "unpacked"
        doc = self.success(tool_command("motion_tool.py", "mmd-scan", "--source", str(folder), "--unpack-to", str(unpack)))
        folder = folder.resolve()
        self.assertEqual(doc, dict(ok=True, title="サンプルダンス", root=str(folder),
            bodies=[dict(path=str(folder / "Dance_Full_SampleDancerA_v1.1[f-19].vmd"), name="Dance_Full_SampleDancerA_v1.1[f-19].vmd",
                         label="SampleDancerA", model="サンプルモデルA", duration_s=2.0, place_frame=-19, has_morph=False),
                    dict(path=str(folder / "Dance_Full_SampleDancerB_v1.1[f-19].vmd"), name="Dance_Full_SampleDancerB_v1.1[f-19].vmd",
                         label="SampleDancerB", model="サンプルモデルB", duration_s=1.0, place_frame=-19, has_morph=False)],
            faces=[], cameras=[dict(path=str(folder / "Camera/cam/cam.vmd"), name="cam.vmd", duration_s=11 / 30, place_frame=None)],
            audio=[dict(path=str(folder / "inst.wav"), name="inst.wav")],
            ignored=[dict(name="Readme.txt", reason="not_motion"), dict(name="broken.vmd", reason="bad_vmd")],
            suggested=dict(body=0, face=None, camera=0, audio=0, bgm_start_s=-0.633)))

    @needs_numpy
    def test_mmd_scan_extracts_a_zip_into_the_folder_it_creates(self):
        archive = self.root / "set.zip"
        with zipfile.ZipFile(archive, "w") as z: z.write(self.vmd(), "set/dance.vmd"); z.write(self.wav("song.wav"), "set/song.wav")
        unpack = self.root / "unpacked"
        scan = lambda *paths: tool_command("motion_tool.py", "mmd-scan", "--source", str(paths[0]), *[a for p in paths[1:] for a in ("--extra", str(p))],
                                           "--unpack-to", str(unpack))
        doc = self.success(scan(archive))
        self.assertEqual((doc["title"], doc["root"], [b["name"] for b in doc["bodies"]], [a["name"] for a in doc["audio"]]),
                         ("set", str(unpack.resolve()), ["dance.vmd"], ["song.wav"]))
        self.assertTrue(Path(doc["bodies"][0]["path"]).is_relative_to(unpack.resolve()))
        self.assertEqual(self.failure(scan(archive))["reason"], "bad_source")
        shutil.rmtree(unpack)
        self.assertEqual(self.failure(scan(self.wav("song.wav"), self.camera_vmd()))["detail"], "no body motion")

    def install_chains(self):
        """test_chain_edit's wave chain with its motion graph, installed."""
        from agentic_complex_build.motion_graph import graft
        from test_chain_edit import MOTION
        source = self.root / "chains"; motion_fixture(source, motion=MOTION); graft(source, self.root / "graphed")
        self.library.install(self.root / "graphed")
        return self.library.packages()[0]

    def chain(self, package, host, edits, *extra):
        path = self.root / "proposal.json"
        path.write_text(json.dumps(dict(schema="endfield-motion-chain-proposal/v1", character="fixture", package_sha256=package.sha256, edits=edits)), encoding="utf-8")
        return tool_command("motion_tool.py", "chain", "--library", str(self.library.root), "--character", "fixture", "--proposal", str(path),
                            *extra, "--validate-with", str(host))

    @needs_numpy
    def test_chain_check_reports_problems_and_graph_changes_without_writing(self):
        package = self.install_chains(); before = self.files()
        doc = self.success(self.chain(package, self.host(), [dict(op="insert", chain="wave_start", index=1, clip="nod")], "--check"))
        self.assertEqual(doc, dict(ok=True, problems=[], graph_changes=dict(chains_added=[], chains_removed=["nod"], chains_changed=["wave_start"])))
        doc = self.success(self.chain(package, self.host(), [dict(op="set", clip="wave_end", next="wave_start"), dict(op="blend", clip="nod", seconds=3)], "--check"))
        self.assertEqual((doc["ok"], doc["problems"]), (False, [dict(edit=1, reason="bad_blend")]))
        self.assertEqual(self.files(), before)

    @needs_numpy
    def test_chain_publishes_the_rebuilt_character_and_then_its_proposal_is_stale(self):
        package = self.install_chains()
        edits = [dict(op="insert", chain="wave_start", index=1, clip="nod")]
        doc = self.success(self.chain(package, self.host(), edits))
        self.assertEqual(doc, dict(ok=True, character="fixture", version="1.0.2"))
        new = Library(self.library.root).packages()[0]
        self.assertEqual(json.loads((new.root / "runtime/animation/intent-motion-map.json").read_text(encoding="utf-8"))["clips"]["wave_start"]["next"], "nod")
        self.assertEqual([p.name for p in (self.library.root / ".vmd-stage").iterdir()], [".lock"])
        doc = self.failure(self.chain(package, self.host(), edits))
        self.assertEqual((doc["reason"], json.loads(doc["detail"])), ("stale", [dict(edit=None, reason="stale")]))
        doc = self.failure(self.chain(new, self.host(), [dict(op="set", clip="wave_end", next="wave_start")]))
        self.assertEqual(doc["reason"], "chain_refused"); self.assertIn(dict(edit=None, reason="cycle:wave_start"), json.loads(doc["detail"]))
        self.assertEqual(Library(self.library.root).packages()[0].sha256, new.sha256)

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_remove_of_an_import_a_chain_or_another_action_row_leads_to_is_refused(self):
        """A chain edit can make another clip's next or exit the import, or an action row play it: removing it would leave that edge."""
        uses = dict(next=dict(intents=dict(nod=dict(next="walk"))), exit=dict(intents=dict(nod=dict(exit="walk"))),
                    row=dict(rows=[dict(id="nod_row", name="nod", section="idle", clips=["nod"], required_clips=["walk"], duration=1.4)]))
        for name, use in uses.items():
            with self.subTest(use=name):
                self.install_walk(name, **use); before = self.published()
                doc = self.failure(self.edit("remove", self.host(), self.WALK))
                self.assertEqual(doc["reason"], "linked_motion")
                self.assertEqual(self.published(), before)
                self.assertEqual([p.name for p in (self.library.root / ".vmd-stage").iterdir()], [".lock"])

    def vrma(self):
        """A text .gltf VRMA of test_bvh_import's CMU skeleton turning its left forearm over 1 s, its buffer in anim.bin beside it."""
        import struct
        from test_bvh_import import cmu_joints
        joints = cmu_joints(); index = {name: k for k, (name, _, _) in enumerate(joints)}
        children = lambda name: [index[n] for n, parent, _ in joints if parent == name]
        nodes = [dict(name=name, translation=[c * .1 for c in offset], **({"children": children(name)} if children(name) else {}))
                 for name, _, offset in joints]
        data = struct.pack("<10f", 0, 1, 0, 0, 0, 1, 0, 0, math.sqrt(.5), math.sqrt(.5))
        (self.root / "anim.bin").write_bytes(data)
        sided = dict(Shoulder="Shoulder", UpperArm="Arm", LowerArm="ForeArm", Hand="Hand", UpperLeg="UpLeg", LowerLeg="Leg", Foot="Foot", Toes="ToeBase")
        bones = dict(hips="Hips", spine="Spine", neck="Neck", head="Head",
                     **{side.lower() + vrm: side + name for side in ("Left", "Right") for vrm, name in sided.items()})
        doc = dict(asset=dict(version="2.0"), extensionsUsed=["VRMC_vrm_animation"], nodes=nodes, scenes=[dict(nodes=[0])],
                   extensions=dict(VRMC_vrm_animation=dict(specVersion="1.0", humanoid=dict(humanBones={b: dict(node=index[n]) for b, n in bones.items()}))),
                   buffers=[dict(uri="anim.bin", byteLength=len(data))],
                   bufferViews=[dict(buffer=0, byteOffset=0, byteLength=8), dict(buffer=0, byteOffset=8, byteLength=32)],
                   accessors=[dict(bufferView=0, componentType=5126, count=2, type="SCALAR", min=[0], max=[1]),
                              dict(bufferView=1, componentType=5126, count=2, type="VEC4")],
                   animations=[dict(name="turn", samplers=[dict(input=0, output=1)],
                                    channels=[dict(sampler=0, target=dict(node=index["LeftForeArm"], path="rotation"))])])
        path = self.root / "turn.gltf"; path.write_text(json.dumps(doc), encoding="utf-8")
        return path

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_a_vrma_with_an_external_buffer_is_kept_as_one_glb(self):
        """The kept source is baked again alone, as seed replay does, and identifies the import by its buffer too."""
        from test_vmd_import import authored_rig
        from agentic_complex_build.motion_import import formats, gltf
        self.install(rig=authored_rig())
        doc = self.success(self.run_import(self.vrma(), self.host()))
        self.assertEqual(doc["format"], "vrma")
        [entry] = json.loads((self.library.root / "motion-imports/fixture/imports.json").read_text(encoding="utf-8"))["imports"]
        (self.root / "anim.bin").unlink()
        kept = self.library.root / "motion-imports/fixture" / entry["source"]["file"]
        self.assertEqual(kept.suffix, ".glb")
        self.assertEqual((formats.detect(kept), len(gltf.read(kept)["buffers"])), ("vrma", 1))

    @needs_numpy
    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_extras_import_the_suggested_body_and_warn_of_the_files_left_out(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig())
        doc = self.success(self.run_import(self.vmd(), self.host(), "--extra", str(self.vmd(seconds=2, name="long.vmd")),
                                           "--extra", str(self.camera_vmd())))
        self.assertEqual((doc["source"]["name"], doc["action"]["duration_s"], doc["warnings"]), ("long.vmd", 2.0, ["ignored_file: dance.vmd"]))
        self.assertIsNotNone(doc["tracks"]["camera"])

    @needs_numpy
    def test_an_import_its_rename_and_the_library_build_copy_the_package_without_a_child_process(self):
        """Windows has no /bin/cp: the importer, an edit and import_vmd's library build copy the package in this process."""
        import contextlib, io
        from unittest import mock
        from test_vmd_import import authored_rig
        from agentic_complex_build import import_vmd
        from agentic_complex_build.motion_import.edit import edit_package
        package = self.install(rig=authored_rig())
        argv = ["import_vmd", "--library", str(self.library.root), "--vmd", str(self.vmd()), "--output", str(self.root / "built"), "--character", "fixture"]
        with mock.patch("subprocess.run", side_effect=FileNotFoundError(2, "The system cannot find the file specified")):
            report = import_vmd.import_motion(package.root, self.vmd(), self.root / "imported", title="舞蹈")
            edit_package(self.root / "imported", self.root / "renamed", action=report["action"], title="新舞")
            with mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(io.StringIO()): import_vmd.main()
        for root in (self.root / "imported", self.root / "renamed"): Package(root)
        self.assertEqual([p.version for p in Library(self.root / "built/library").packages()], ["1.0.1"])

    @needs_numpy
    def test_a_chain_copies_the_package_without_a_child_process(self):
        from unittest import mock
        from agentic_complex_build.motion_import.chain_edit import chain_package
        package = self.install_chains()
        proposal = dict(schema="endfield-motion-chain-proposal/v1", character="fixture", package_sha256=package.sha256,
                        edits=[dict(op="insert", chain="wave_start", index=1, clip="nod")])
        with mock.patch("subprocess.run", side_effect=FileNotFoundError(2, "The system cannot find the file specified")):
            chain_package(package.root, self.root / "chained", proposal)
        Package(self.root / "chained")

    @needs_numpy
    def test_a_motion_import_builds_its_library_without_a_child_process(self):
        import contextlib, io
        from unittest import mock
        from test_bvh_import import cmu_bvh_text
        from test_vmd_import import authored_rig
        from agentic_complex_build import import_motion
        self.install(rig=authored_rig())
        bvh = self.root / "walk.bvh"; bvh.write_text(cmu_bvh_text(), encoding="utf-8")
        argv = ["import_motion", "--library", str(self.library.root), "--source", str(bvh), "--output", str(self.root / "built"), "--character", "fixture"]
        with mock.patch("subprocess.run", side_effect=FileNotFoundError(2, "The system cannot find the file specified")), \
                mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(io.StringIO()):
            import_motion.main()
        self.assertEqual([p.id for p in Library(self.root / "built/library").packages()], ["fixture"])

    @needs_numpy
    def test_a_motion_graph_and_its_library_copy_the_packages_without_a_child_process(self):
        from unittest import mock
        from agentic_complex_build.motion_graph import graft, graft_library
        package = self.install_chains()
        with mock.patch("subprocess.run", side_effect=FileNotFoundError(2, "The system cannot find the file specified")):
            graft(package.root, self.root / "regraphed")
            graft_library(self.library.root / "current.json", self.root / "graphed-library")
        Package(self.root / "regraphed")
        self.assertEqual([p.id for p in Library(self.root / "graphed-library/library").packages()], ["fixture"])

    @needs_numpy
    def test_a_bgm_import_on_windows_is_refused_before_the_package_is_copied(self):
        """Windows ships no audio decoder program as macOS ships afconvert."""
        from unittest import mock
        from character_library import PackageError
        from test_vmd_import import authored_rig
        from agentic_complex_build import import_vmd
        from agentic_complex_build.mmd import io, native_rig, reference, retarget, rig_math, skeleton  # imported before sys.platform changes
        package = self.install(rig=authored_rig()); song = self.wav("song.wav"); before = sorted(self.root.iterdir())
        with mock.patch.object(sys, "platform", "win32"), \
                mock.patch("subprocess.run", side_effect=FileNotFoundError(2, "The system cannot find the file specified")), \
                self.assertRaisesRegex(PackageError, "^bgm_unsupported_on_windows$"):
            import_vmd.import_motion(package.root, self.vmd(), self.root / "imported", bgm=song)
        self.assertEqual(sorted(self.root.iterdir()), sorted(before + [self.root / "dance.vmd"]))



class PackagedFbxToolTest(unittest.TestCase):
    def test_the_packaged_fbx_tool_is_an_exe_on_windows(self):
        import os
        from unittest import mock
        import motion_tool
        with tempfile.TemporaryDirectory() as root:
            agentd = Path(root) / "agentd"
            (Path(root) / "content").mkdir()
            (Path(root) / "content/import_vmd.py").write_text("", encoding="utf-8")
            for platform, name in (("win32", "fbx-motion.exe"), ("darwin", "fbx-motion")):
                with mock.patch.object(motion_tool, "AGENTD", agentd), mock.patch.object(sys, "platform", platform), \
                        mock.patch.dict(os.environ), mock.patch.object(sys, "path", list(sys.path)):
                    os.environ.pop("AAC_FBX_TOOL", None)
                    self.assertEqual(motion_tool.importer(), "content")
                    self.assertEqual(Path(os.environ["AAC_FBX_TOOL"]).name, name)

    @needs_numpy
    def test_the_fbx_tool_output_is_read_as_utf8_whatever_the_code_page(self):
        """fbx-motion prints UTF-8; Windows decodes a text pipe in its ANSI code page (cp1252 here) unless told otherwise."""
        import os
        from unittest import mock
        import motion_tool
        calls = []
        def run(args, **options):
            calls.append(options)
            data = output
            if options.get("text") or options.get("encoding"): data = data.decode(options.get("encoding") or "cp1252", options.get("errors") or "strict")
            return subprocess.CompletedProcess(args, 0, data, "")
        probe = dict(right_handed=True, takes=[dict(index=0, name="歩き", time_begin=0.0, time_end=1.0)])
        with mock.patch.dict(os.environ, AAC_FBX_TOOL=sys.executable), mock.patch("subprocess.run", side_effect=run):
            fbx = motion_tool.motion_import(".fbx")
            output = json.dumps(probe, ensure_ascii=False).encode("utf-8")
            self.assertEqual(fbx.probe(Path("walk.fbx"))["takes"][0]["name"], "歩き")
            self.assertEqual(calls[-1].get("encoding"), "utf-8")
            output = b"\xff\n"
            with self.assertRaisesRegex(ValueError, "^bad_source: fbx_tool$"): fbx.probe(Path("walk.fbx"))


if __name__ == "__main__": unittest.main()
