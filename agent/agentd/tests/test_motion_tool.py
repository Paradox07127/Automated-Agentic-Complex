"""motion_tool imports a motion into an installed character and publishes it in place, probes sources, lists, renames and removes imports
and checks or publishes motion-chain proposals, run by script path as the app does."""
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import shutil
import signal
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
# install_chains grafts the chains with characters/agentic_complex_build/interaction_motion.py, which imports scipy.
needs_scipy = unittest.skipUnless(NUMPY and importlib.util.find_spec("scipy") is not None, "the chain fixture needs numpy and scipy")


def motion_fixture(root, cid="fixture", rows=1, rig=None, imported=(), motion=None):
    """test_character_library's package with a runtime the importer can extend: a rig, one idle clip and the action files.

    imported: (actions.json row, provenance report) pairs written as an earlier import would have left them.
    motion: {"clips": {name: (length, loop)}} archive clips after idle, {"animation"|"interaction": {file: document}} data files
    that replace or follow the default ones, a None document leaving that file out. A rig with nodes gets test_vmd_import's
    humanoid.json of it by default."""
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
        "keys": put("clips/%s.keys" % name, b"EFKEY001"), "oracle": put("clips/%s.oracle" % name, b"EFPOSE01")}),
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

    def vmd(self, seconds=1):
        from agentic_complex_build.mmd.io import Vmd, BoneKey, write_vmd
        path = self.root / "dance.vmd"
        write_vmd(Vmd(bones=[BoneKey("上半身", 0, (0, 0, 0), (0, 0, 0, 1)),
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
        self.assertEqual((index["schema"], len(imports)), ("endfield-mmd-library/v1", 1))
        self.assertEqual({k: imports[0][k] for k in ("id", "title", "bgm", "camera", "zip", "removed_at")},
                         dict(id=doc["action"]["id"], title="舞蹈", bgm=None, camera=None, zip=None, removed_at=None))
        self.assertEqual((imports[0]["source"]["name"], imports[0]["source"]["sha256"]), ("dance.vmd", doc["source"]["sha256"]))
        self.assertEqual((kept / imports[0]["source"]["file"]).read_bytes(), self.vmd().read_bytes())
        self.assertEqual(imports[0]["created_at"], doc["created_at"])

    @needs_numpy
    def test_vmd_import_prints_each_stage_before_the_result(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig())
        result = self.run_import(self.vmd(), self.host())
        self.success(result)
        stages = [json.loads(line)["stage"] for line in result.stdout.splitlines()[:-1]]
        self.assertEqual(list(dict.fromkeys(stages)), ["read", "sample", "retarget", "write", "validate", "publish"])

    @needs_numpy
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
        report = dict(schema="endfield-vmd-import/v1", character=cid, action=row["id"], clip="imported_vmd_" + identity)
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

    @needs_scipy
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
    def test_an_installed_file_changed_after_install_fails_an_mmd_sync_and_publishes_nothing(self):
        """A file the bake rewrites or verifies fails that entry; a file only cloned fails the whole sync."""
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig()); package, report = self.install_with_report("second")
        action = self.success(self.run_import(self.vmd(), self.host()))["action"]["id"]
        before = self.published(); index = self.library.root / "mmd-library/index.json"; shared = index.read_bytes()
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
    def test_motion_over_180_seconds_is_too_long(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig()); before = self.files()
        doc = self.failure(self.run_import(self.vmd(seconds=181), self.host()))
        self.assertEqual(doc["reason"], "too_long")
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
        self.assertEqual((entry["source"]["name"], entry["zip"]["name"], entry["camera"]), ("dance.vmd", "set.zip", None))
        self.assertEqual((kept / entry["zip"]["file"]).read_bytes(), archive.read_bytes())
        self.assertEqual(entry["zip"]["sha256"], hashlib.sha256(archive.read_bytes()).hexdigest())
        self.assertEqual((kept / entry["bgm"]["file"]).read_bytes(), self.wav("song.wav").read_bytes())
        self.assertEqual([p.name for p in (self.library.root / ".vmd-stage").iterdir()], [".lock"])

    @needs_numpy
    def test_remove_keeps_the_zip_of_another_import(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig())
        archive = self.root / "set.zip"
        with zipfile.ZipFile(archive, "w") as z: z.write(self.vmd(), "set/dance.vmd")
        self.success(self.run_import(archive, self.host()))
        other = self.success(self.run_import(self.vmd(seconds=2), self.host()))["action"]["id"]
        self.success(self.edit("remove", self.host(), other))
        kept = self.library.root / "mmd-library/sources"
        entry = next(x for x in self.mmd_index()["entries"] if x["zip"] is not None)
        self.assertEqual((kept / entry["zip"]["file"]).read_bytes(), archive.read_bytes())

    @needs_numpy
    def test_extra_camera_vmd_is_recorded(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig())
        camera = self.camera_vmd()
        doc = self.success(self.run_import(self.vmd(), self.host(), "--extra", str(camera)))
        self.assertEqual((doc["tracks"]["camera"]["frames"], doc["tracks"]["camera"]["cuts"]), (31, [11]))
        kept = self.library.root / "mmd-library/sources"
        [entry] = self.mmd_index()["entries"]
        self.assertEqual((entry["camera"]["name"], entry["camera"]["sha256"], entry["zip"]),
                         ("camera.vmd", hashlib.sha256(camera.read_bytes()).hexdigest(), None))
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
                                      renamed=[], removed=[], failed=[]))
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
    def test_imports_and_mmd_sync_record_the_version_they_derive_from(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig()); self.second_character(authored_rig())
        self.success(self.run_import(self.vmd(), self.host()))
        self.success(self.run_import(self.vmd(seconds=2), self.host()))
        self.sync(self.host())
        self.assertEqual({p.id: (p.version, p.document["base_package_version"]) for p in self.library.packages()},
                         dict(fixture=("1.0.2", "1.0.0"), second=("1.0.1", "1.0.0")))

    @needs_numpy
    def test_mmd_sync_no_changes_keeps_version(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig())
        self.success(self.run_import(self.vmd(), self.host()))
        before = self.library.snapshot()
        result = self.sync(self.host(), "fixture")
        self.assertEqual((result["version"], result["baked"]), ("1.0.1", []))
        self.assertEqual(self.library.snapshot(), before)

    @needs_numpy
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
    def test_mmd_sync_keeps_a_reimported_live_id(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig()); self.second_character(authored_rig())
        action = self.success(self.run_import(self.vmd(), self.host()))["action"]["id"]
        self.success(self.edit("remove", self.host(), action))
        self.success(tool_command("motion_tool.py", "import", "--library", str(self.library.root), "--character", "second",
                                  "--source", str(self.vmd()), "--validate-with", str(self.host())))
        self.assertEqual(self.sync(self.host()), dict(ok=True, character="second", version="1.0.1", baked=[], renamed=[], removed=[], failed=[]))
        self.assertEqual(self.mmd_list()["entries"][0]["characters"][1]["state"], "baked")

    @needs_numpy
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
    def test_mmd_sync_records_an_entry_whose_bake_options_it_cannot_recover(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig()); self.second_character(authored_rig())
        self.success(self.run_import(self.vmd(), self.host()))
        index = self.mmd_index(); index["entries"][0]["duration_s"] = 9.0
        write_json(self.library.root / "mmd-library/index.json", index)
        result = self.sync(self.host())
        self.assertEqual((result["ok"], result["baked"], [f["reason"] for f in result["failed"]]), (True, [], ["internal"]))
        self.assertEqual(self.mmd_index()["entries"][0]["failures"]["second"]["reason"], "internal")

    @needs_numpy
    def test_mmd_remove_reclaims_shared_sources_no_live_entry_names(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig())
        kept = self.success(self.run_import(self.vmd(), self.host()))["action"]["id"]
        gone = self.success(self.run_import(self.vmd(seconds=2), self.host()))["action"]["id"]
        self.success(self.edit("remove", self.host(), gone))
        sources = self.library.root / "mmd-library/sources"
        live = next(e for e in self.mmd_index()["entries"] if e["id"] == kept)["source"]["file"]
        self.assertEqual([p.name for p in sources.iterdir()], [live])

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

    @needs_scipy
    def test_chain_check_reports_problems_and_graph_changes_without_writing(self):
        package = self.install_chains(); before = self.files()
        doc = self.success(self.chain(package, self.host(), [dict(op="insert", chain="wave_start", index=1, clip="nod")], "--check"))
        self.assertEqual(doc, dict(ok=True, problems=[], graph_changes=dict(chains_added=[], chains_removed=["nod"], chains_changed=["wave_start"])))
        doc = self.success(self.chain(package, self.host(), [dict(op="set", clip="wave_end", next="wave_start"), dict(op="blend", clip="nod", seconds=3)], "--check"))
        self.assertEqual((doc["ok"], doc["problems"]), (False, [dict(edit=1, reason="bad_blend")]))
        self.assertEqual(self.files(), before)

    @needs_scipy
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
    def test_two_audio_extras_is_ambiguous(self):
        from test_vmd_import import authored_rig
        self.install(rig=authored_rig()); before = self.files()
        doc = self.failure(self.run_import(self.vmd(), self.host(), "--extra", str(self.wav("a.wav")), "--extra", str(self.wav("b.wav"))))
        self.assertEqual((doc["reason"], doc["detail"]), ("ambiguous_motion", "a.wav,b.wav"))
        self.assertEqual(self.files(), before)



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


if __name__ == "__main__": unittest.main()
