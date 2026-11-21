"""The same package feeds the app roster, persona and native runtime catalog."""
import hashlib
import json
import subprocess
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from character_library import Library, Package, PackageError, write_json, export_package


def fixture(root, cid="fixture", voice=False, weapon=False, portrait=False, neutral=False, d3d11=False, pool=()):
    """pool: the bytes of each file of the source manifest's Files/ pool."""
    root.mkdir(parents=True)
    inventory = []
    def blob(path, value):
        data = value if isinstance(value, bytes) else (json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n").encode()
        p = root / path; p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(data)
        ref = dict(file=path, sha256=hashlib.sha256(data).hexdigest(), byte_count=len(data))
        inventory.append(ref); return ref
    card = blob("persona/card.json", {"name": cid, "identity": "a real fixture", "personality": "calm",
        "relationship": "colleague", "knowledge": {"knows": "the supplied facts", "does_not_know": "unsupplied facts"},
        "tone_rules": [], "catchphrases": [], "do_dont": [], "canon": "fixture", "markers": "",
        "examples": [], "post_history_instructions": "stay grounded"})
    lore = blob("persona/lore.json", {"budget_tokens": 500, "entries": []})
    game = blob("game-data/profile.json", {"id": cid, "source_character_id": "chr_9999_" + cid,
        "name": cid, "fields": [{"key": "faction", "label": "阵营", "value": None,
                                   "source": "fixture-table/row"}]})
    head = blob("ui/head.png", {"fixture": "image bytes are opaque to inventory"})
    art = blob("ui/portrait.png", {"fixture": "portrait bytes are opaque to inventory"}) if portrait else None
    runtime_files = []
    def component(path, value):
        ref = blob("runtime/" + path, value); runtime_files.append(dict(ref, file=path)); return dict(ref, file=path)
    source = component("source.json", {"schema": "endfield-native-character-manifest-v1", "draws": []})
    graph = component("graph.json", {"schema": "metal-frame-graph-v1", "manifest_sha256": source["sha256"]})
    appearances=[{"id":"default"}]+([{"id":"armed"}] if weapon else [])
    animation={}
    if weapon:
        palette=component("animation/palette.json",{"meshes":[{"mesh":"body"},{"mesh":"weapon","appearances":["armed"]}]})
        animation={"palette_contract":dict(palette,file="palette.json")}
    pack = component("pack.json", {"schema": "endfield-character-pack/v1", "id": cid,
                                  "render": {"manifest": source}, "appearances": appearances,"animation":animation})
    archive = component("actor.json", {"schema": "metal-actor-source-export-v1", "clips": [{"name": "idle"}]})
    library = component("programs.json", {"schema": "metal-program-library-v1", "programs": []})
    lighting = component("lighting.json", {"schema": "metal-product-lighting/v1"})
    coverage = component("coverage.json", {"appearances": [x['id'] for x in appearances], "blocked": {}})
    # The installer only checks the neutral package's digests; native_bundle.verify checks that it emits the graph.
    neutral = {field: component(path, {"schema": field}) for field, path in (("neutral_scene", "neutral/scene.json"),
               ("neutral_build_record", "neutral/build-record.json"), ("metal_product", "metal/product.json"))} if neutral else {}
    if d3d11: neutral["d3d11_frame"] = component("d3d11/frame.bin", {"schema": "d3d11_frame"})
    for data in pool: component("Files/" + hashlib.sha256(data).hexdigest() + ".bytes", data)
    native = blob("runtime/bundle.json", {"schema": "metal-native-character-bundle/v1", "characters": [dict(
        id=cid, default_clip="idle", default_appearance="default", c7=pack, actor_archive=archive,
        source=source, library=library, graph=graph, lighting=lighting, coverage=coverage, **neutral)], "files": runtime_files})
    doc = dict(schema="endfield-character-definition", schema_version=1, game="arknights_endfield",
        id=cid, version="1.0.0", source_identity=dict(character_id="chr_9999_" + cid, snapshot="fixture-v1"),
        display=dict(name={"zh-Hans": cid}), aliases=[], components=dict(
            render=dict(native_bundle=native), persona=dict(card=card, lore=lore), game_data=game, ui=dict(head=head)),
        capabilities=["render.default", "motion.idle", "motion.preview", "persona.dialogue", "game_data.basic", "ui.assets"],
        inventory=inventory)
    if voice: doc["components"]["voice"] = dict(character=cid, language="zh")
    if portrait:
        doc['components']['ui']['portrait']=art
        doc['capabilities'].append('ui.portrait')
    if weapon:
        doc['components']['render']['weapon_visibility']=dict(shown_appearance='armed',hidden_appearance='default',meshes=['weapon'])
        doc['capabilities'].append('render.weapon_toggle')
    write_json(root / "character.json", doc)
    return doc


def text_fixture(root, cid="aide"):
    """A package with only a persona: no render, game_data or ui components."""
    root.mkdir(parents=True)
    inventory = []
    def blob(path, value):
        data = (json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n").encode()
        p = root / path; p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(data)
        ref = dict(file=path, sha256=hashlib.sha256(data).hexdigest(), byte_count=len(data))
        inventory.append(ref); return ref
    card = blob("persona/card.json", {"name": cid, "identity": "a desktop helper", "personality": "brief",
        "relationship": "assistant", "knowledge": {"knows": "the supplied facts", "does_not_know": "unsupplied facts"},
        "tone_rules": [], "catchphrases": [], "do_dont": [], "canon": "fixture", "markers": "",
        "examples": [], "post_history_instructions": "stay brief"})
    lore = blob("persona/lore.json", {"budget_tokens": 500, "entries": []})
    doc = dict(schema="endfield-character-definition", schema_version=1, id=cid, version="1.0.0",
        source_identity=dict(character_id=cid, snapshot="handwritten-1"), display=dict(name={"zh-Hans": cid}),
        aliases=[], components=dict(persona=dict(card=card, lore=lore)), capabilities=["persona.dialogue"],
        inventory=inventory)
    write_json(root / "character.json", doc)
    return doc


def check_progress(test, lines, order=None):
    """A tool's progress lines (MOTION-IMPORT §9): fractions from 0 to 1, never decreasing; stages in order when order is given."""
    test.assertTrue(lines and all(line["event"] == "progress" for line in lines), lines)
    fractions = [line["fraction"] for line in lines]
    test.assertEqual((fractions[0], fractions[-1]), (0, 1)); test.assertEqual(fractions, sorted(fractions))
    if order: positions = [order.index(line["stage"]) for line in lines]; test.assertEqual(positions, sorted(positions))


def tool_command(script, *args):
    # The app's argv and cwd for an agentd tool; the release agentic-complex-python adds -I -B.
    agentd = Path(__file__).resolve().parents[1]
    argv = [sys.executable, "-I", "-B", str(agentd / script), *args]
    return subprocess.run(argv, cwd=agentd, capture_output=True, text=True, encoding="utf-8")


class CharacterLibraryTests(unittest.TestCase):
    def host(self, reject=False):
        host = self.root / "host"
        host.write_text("#!" + sys.executable + "\nimport json, pathlib, sys\n"
            "assert sys.argv[1] == '--validate-pack'\n"
            "manifest = pathlib.Path(sys.argv[2])\n"
            "assert json.loads(manifest.read_text())['schema'] == 'metal-native-character-bundle/v1'\n"
            + ("print('pack_rejected: fixture pack SHA mismatch', file=sys.stderr)\nsys.exit(78)\n" if reject else ""), encoding="utf-8")
        host.chmod(0o700)
        return host

    def install_command(self, source, library, host=None):
        args = ["install", str(source), "--library", str(library.root)]
        if host is not None: args += ["--validate-with", str(host)]
        return tool_command("character_tool.py", *args)

    def test_tool_runs_under_isolated_mode_as_the_installer_launches_it(self):
        result = tool_command("character_tool.py", "--help")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("install", result.stdout)

    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_host_rejected_import_leaves_revision_entries_and_files_unchanged(self):
        library = Library(self.root / "library")
        first = self.root / "first"; fixture(first, "one"); library.install(first)
        snapshot, entries = library.snapshot(), library.entries()
        files = {p.relative_to(library.root): p.read_bytes() for p in library.root.rglob("*") if p.is_file()}
        source = self.root / "source"; fixture(source)
        archive = self.root / "fixture.endfield-character"; export_package(source, archive)
        for path in (source, archive):
            with self.subTest(path=path):
                result = self.install_command(path, library, self.host(reject=True))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("pack_rejected: fixture pack SHA mismatch", result.stderr)
                self.assertEqual(library.snapshot(), snapshot)
                self.assertEqual(library.entries(), entries)
                self.assertEqual({p.relative_to(library.root): p.read_bytes() for p in library.root.rglob("*") if p.is_file()}, files)

    def test_import_without_host_fails_without_installing(self):
        source = self.root / "source"; fixture(source)
        for host in (None, self.root / "missing-host"):
            with self.subTest(host=host):
                library = Library(self.root / "library")
                result = self.install_command(source, library, host)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("host executable", result.stderr)
                self.assertEqual(library.entries(), [])
                self.assertFalse(library.root.exists())

    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_host_accepted_import_installs_from_private_stage(self):
        source = self.root / "source"; fixture(source)
        host = self.host()
        with host.open("a", encoding="utf-8") as stream:
            stream.write("assert manifest.parent != pathlib.Path(" + repr(str(source / "runtime")) + ")\n")
        library = Library(self.root / "library")
        result = self.install_command(source, library, host)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([x['id'] for x in library.entries()], ['fixture'])

    def test_optional_portrait_is_verified_and_capability_must_match(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'role';doc=fixture(root,portrait=True)
            self.assertIn('portrait',Package(root).components['ui'])
            doc['capabilities'].remove('ui.portrait');write_json(root/'character.json',doc)
            with self.assertRaisesRegex(PackageError,'portrait_capability_mismatch'):Package(root)
            doc['capabilities'].append('ui.portrait');write_json(root/'character.json',doc)
            (root/'ui/portrait.png').write_bytes(b'changed')
            with self.assertRaises(PackageError):Package(root)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_silent_character_installs_without_tts_and_native_roster_matches(self):
        src = self.root / "source"; fixture(src)
        library = Library(self.root / "library"); result = library.install(src)
        entry = library.entries()[0]
        self.assertEqual(entry["id"], "fixture")
        self.assertFalse(entry["voice_enabled"])
        self.assertEqual(result["revision"], library.snapshot()["revision"])
        self.assertEqual(Package(entry["root"]).card()["name"], entry["name"])
        native = json.loads((library.root / library.snapshot()["native_bundle"]["file"]).read_text(encoding="utf-8"))
        self.assertEqual([x["id"] for x in native["characters"]], [entry["id"]])
        for ref in native["files"]:
            self.assertEqual(hashlib.sha256((library.root / ref["file"]).read_bytes()).hexdigest(), ref["sha256"])

    @unittest.skipIf(sys.platform == "win32", "the test runs a script through its shebang, which Windows cannot execute")
    def test_archive_roundtrip_and_bad_archive_leave_catalog_unchanged(self):
        src = self.root / "source"; fixture(src)
        archive = self.root / "fixture.endfield-character"; export_package(src, archive)
        library = Library(self.root / "library"); host = self.host(); snapshot = library.import_path(archive, validate_with=host)
        self.assertEqual(library.entries()[0]["id"], "fixture")
        for filename in ("../escape.json", "/absolute.json", "plugin.py", "character.json"):
            bad = self.root / "bad.endfield-character"
            with zipfile.ZipFile(bad, "w") as zip:
                zip.writestr("character.json", "{}")
                zip.writestr(filename, "{}")
            with self.assertRaises((PackageError, ValueError)): library.import_path(bad, validate_with=host)
            self.assertEqual(library.snapshot(), snapshot)

    def test_immutable_snapshot_and_append_during_repository_lifetime(self):
        from brain.characters import Repository
        from brain.parser import parse_command
        library = Library(self.root / "library")
        src = self.root / "first"; fixture(src, "one", voice=True); first = library.install(src)
        repository = Repository(library.root / "current.json")
        frozen = Repository(library.root / ("catalog-" + first["revision"] + ".json"))
        self.assertEqual(repository.voice("one"), ("one", "zh"))
        src = self.root / "third"; fixture(src, "three"); library.install(src)
        self.assertEqual(repository.ids(), ["one", "three"])
        self.assertEqual(frozen.ids(), ["one"])
        self.assertIsNone(repository.voice("three"))
        self.assertEqual(parse_command("three，停下", names=repository.names()), {"action": "stop"})

    def test_an_unchanged_catalog_is_not_hashed_or_parsed_again(self):
        from unittest.mock import patch
        from brain.characters import Repository
        library = Library(self.root / "library")
        for cid in ("one", "two"):
            src = self.root / cid; fixture(src, cid); library.install(src)
        repository = Repository(library.root / "current.json")
        self.assertEqual(repository.names(), ["one", "two"])
        with patch("hashlib.sha256", wraps=hashlib.sha256) as sha, patch("json.loads", wraps=json.loads) as loads:
            self.assertEqual(repository.names(), ["one", "two"])
            self.assertEqual(repository.load_card("one")["name"], "one")
        self.assertEqual((sha.call_count, loads.call_count), (0, 0))
        card = repository.load_card("one"); card["name"] = "changed by a caller"
        self.assertEqual(repository.load_card("one")["name"], "one")
        definition = next(p for p in library.packages() if p.id == "two").root / "character.json"
        definition.write_bytes(definition.read_bytes() + b" ")
        with self.assertRaisesRegex(PackageError, "definition_sha_mismatch"):
            repository.names()

    def test_live_import_cannot_change_an_existing_character_generation(self):
        library = Library(self.root / "library")
        src = self.root / "one"; fixture(src, "one"); first = library.install(src)
        src2 = self.root / "update"; d = fixture(src2, "one"); d["version"] = "2.0.0"; write_json(src2 / "character.json", d)
        with self.assertRaisesRegex(PackageError, "offline_migration"): library.install(src2)
        self.assertEqual(library.snapshot(), first)

    def upgrade_source(self, name, version, snapshot="fixture-v2"):
        source = self.root / name; doc = fixture(source, "one")
        doc["version"] = version; doc["source_identity"]["snapshot"] = snapshot
        write_json(source / "character.json", doc)
        return source

    def test_upgrade_publishes_a_newer_generation_under_the_same_catalog_and_keeps_the_old_package(self):
        library = Library(self.root / "library")
        for cid in ["one", "two"]:
            src = self.root / cid; fixture(src, cid); library.install(src)
        old = {p.id: p for p in library.packages()}
        source = self.upgrade_source("update", "1.0.1")
        with self.assertRaisesRegex(PackageError, "offline_migration"): library.install(source)
        result = library.upgrade(source, old["one"].sha256)
        reread = Library(self.root / "library")
        self.assertEqual(reread.snapshot(), result)
        now = {p.id: p for p in reread.packages()}
        self.assertEqual(now["one"].version, "1.0.1")
        self.assertEqual(now["one"].sha256, Package(source).sha256)
        self.assertEqual(now["one"].root, library.root / "packages/one" / now["one"].sha256)
        self.assertEqual(now["two"].root, old["two"].root)
        Package(old["one"].root)

    def test_upgrade_refuses_a_changed_base_and_a_version_that_is_not_higher(self):
        library = Library(self.root / "library")
        src = self.root / "one"; fixture(src, "one"); first = library.install(src)
        base = library.packages()[0].sha256
        cases = [("changed", self.upgrade_source("next", "1.0.1"), "0" * 64, "upgrade_base_changed"),
                 ("equal", self.upgrade_source("equal", "1.0.0"), base, "upgrade_requires_higher_version"),
                 ("lower", self.upgrade_source("lower", "0.9.9"), base, "upgrade_requires_higher_version")]
        for name, source, sha, reason in cases:
            with self.subTest(name):
                with self.assertRaisesRegex(PackageError, reason): library.upgrade(source, sha)
                self.assertEqual(library.snapshot(), first)
                self.assertEqual(sorted(p.name for p in (library.root / "packages/one").iterdir()), [base])

    def test_upgrade_waits_for_the_install_lock(self):
        import threading
        from infra.platform import lock_file
        library = Library(self.root / "library")
        src = self.root / "one"; fixture(src, "one"); first = library.install(src)
        source = self.upgrade_source("update", "1.0.1"); base = library.packages()[0].sha256
        results = []
        with (library.root / ".lock").open("a", encoding="utf-8") as lock:
            lock_file(lock)
            worker = threading.Thread(target=lambda: results.append(library.upgrade(source, base)))
            worker.start(); worker.join(0.5)
            self.assertTrue(worker.is_alive())
            self.assertEqual(library.snapshot(), first)
        worker.join(30)
        self.assertEqual(results, [library.snapshot()])
        self.assertEqual(library.packages()[0].version, "1.0.1")

    def test_upgrade_of_a_source_with_a_changed_file_publishes_nothing(self):
        library = Library(self.root / "library")
        src = self.root / "one"; fixture(src, "one"); first = library.install(src)
        base = library.packages()[0].sha256
        source = self.upgrade_source("update", "1.0.1")
        lighting = source / "runtime/lighting.json"; lighting.write_bytes(lighting.read_bytes()[:-1] + b" ")
        # A new Library, as each tool process has.
        with self.assertRaisesRegex(PackageError, "file_sha_mismatch"): Library(library.root).upgrade(source, base)
        self.assertEqual(library.snapshot(), first)
        self.assertEqual(sorted(p.name for p in (library.root / "packages/one").iterdir()), [base])
        self.assertEqual([p.name for p in library.root.iterdir() if p.name.startswith(".install-")], [])

    def test_upgrade_publishes_only_the_inventory_as_copies_of_the_source_bytes(self):
        library = Library(self.root / "library")
        src = self.root / "one"; fixture(src, "one"); library.install(src)
        source = self.upgrade_source("update", "1.0.1"); (source / "runtime/unlisted.json").write_text("{}", encoding="utf-8")
        library.upgrade(source, library.packages()[0].sha256)
        package = library.package("one")
        files = {p.relative_to(package.root).as_posix(): p for p in package.root.rglob("*") if p.is_file()}
        self.assertEqual(set(files), set(package.inventory) | {"character.json"})
        for name, path in files.items():
            self.assertEqual(path.read_bytes(), (source / name).read_bytes())
            self.assertEqual(path.stat().st_nlink, 1)

    def test_package_rereads_the_catalog_on_every_call(self):
        library = Library(self.root / "library")
        for cid in ["one", "two"]:
            src = self.root / cid; fixture(src, cid); library.install(src)
        before = library.package("one")
        self.assertEqual((before.id, library.package("missing")), ("one", None))
        Library(library.root).upgrade(self.upgrade_source("update", "1.0.1"), before.sha256)
        self.assertEqual(library.package("one").version, "1.0.1")
        with self.assertRaisesRegex(PackageError, "upgrade_base_changed"):
            library.upgrade(self.upgrade_source("again", "1.0.2"), before.sha256)

    def test_bad_game_identity_and_tampered_persona_are_not_published(self):
        src = self.root / "source"; fixture(src)
        (src / "persona/card.json").write_text("{}", encoding="utf-8")
        library = Library(self.root / "library")
        with self.assertRaises(PackageError): library.install(src)
        self.assertEqual(library.entries(), [])
        self.assertFalse((library.root / "current.json").exists())

    def test_distinct_characters_accumulate_without_changing_code_or_existing_package(self):
        library = Library(self.root / "library")
        for cid in ["one", "two", "three"]:
            src = self.root / cid; fixture(src, cid); library.install(src)
        self.assertEqual([e["id"] for e in library.entries()], ["one", "three", "two"])
        original = library.snapshot()["revision"]
        library.install(self.root / "one")
        self.assertEqual(library.snapshot()["revision"], original)

    def test_same_version_with_different_content_and_alias_collision_are_rejected(self):
        library = Library(self.root / "library")
        src = self.root / "source"; fixture(src, "one"); library.install(src)
        other = self.root / "other"; doc = fixture(other, "one")
        doc["display"]["name"]["zh-Hans"] = "different"; write_json(other / "character.json", doc)
        with self.assertRaises(PackageError): library.install(other)
        third = self.root / "third"; doc = fixture(third, "three")
        doc["aliases"] = ["one"]; write_json(third / "character.json", doc)
        with self.assertRaises(PackageError): library.install(third)
        self.assertEqual([e["id"] for e in library.entries()], ["one"])

    def test_escaping_paths_symlinks_and_duplicate_inventory_rejected(self):
        for mode in ["traversal", "symlink", "duplicate", "executable"]:
            with self.subTest(mode=mode):
                src = self.root / mode; doc = fixture(src)
                if mode == "traversal": doc["inventory"][0]["file"] = "../outside"
                if mode == "symlink":
                    target = src / "ui/head.png"; target.unlink(); target.symlink_to(src / "persona/card.json")
                if mode == "duplicate": doc["inventory"].append(doc["inventory"][0])
                if mode == "executable": doc["inventory"][0]["file"] = "payload.py"
                write_json(src / "character.json", doc)
                with self.assertRaises(PackageError): Package(src)

    def test_symlinked_directory_is_rejected_whether_it_points_inside_or_outside(self):
        for place in ["inside", "outside"]:
            with self.subTest(place=place):
                src = self.root / place; fixture(src)
                real = src / "persona-real" if place == "inside" else self.root / (place + "-persona")
                (src / "persona").rename(real); (src / "persona").symlink_to(real, target_is_directory=True)
                with self.assertRaisesRegex(PackageError, "runtime_symlink"): Package(src)

    def test_inventory_file_length_and_digest_are_checked(self):
        src = self.root / "role"; fixture(src)
        lighting = src / "runtime/lighting.json"; data = lighting.read_bytes()
        lighting.write_bytes(data[:-1] + b" ")
        Package(src, deep=False)
        with self.assertRaisesRegex(PackageError, "file_sha_mismatch"): Package(src)
        lighting.write_bytes(data + b" ")
        for deep in [True, False]:
            with self.subTest(deep=deep), self.assertRaisesRegex(PackageError, "file_length_mismatch"): Package(src, deep=deep)

    def test_the_neutral_package_is_optional_and_its_digests_are_checked(self):
        old = self.root / "old"; fixture(old)
        self.assertFalse({"neutral_scene", "neutral_build_record", "metal_product"} & set(Package(old).native_entry))
        Library(self.root / "old-library").install(old)
        src = self.root / "role"; fixture(src, neutral=True)
        self.assertEqual(Package(src).native_entry["neutral_scene"]["file"], "neutral/scene.json")
        Library(self.root / "library").install(src)
        scene = src / "runtime/neutral/scene.json"; data = scene.read_bytes()
        scene.write_bytes(data[:-2] + b" \n")
        with self.assertRaisesRegex(PackageError, "component_sha_mismatch"): Package(src, deep=False)
        scene.write_bytes(data)
        def edit(change):
            path = src / "runtime/bundle.json"; native = json.loads(path.read_text(encoding="utf-8")); change(native)
            data = (json.dumps(native, ensure_ascii=False, sort_keys=True) + "\n").encode(); path.write_bytes(data)
            doc = json.loads((src / "character.json").read_text(encoding="utf-8"))
            ref = dict(file="runtime/bundle.json", sha256=hashlib.sha256(data).hexdigest(), byte_count=len(data))
            doc["components"]["render"]["native_bundle"] = ref
            doc["inventory"] = [r for r in doc["inventory"] if r["file"] != ref["file"]] + [ref]; write_json(src / "character.json", doc)
        edit(lambda n: n["files"].remove(n["characters"][0]["metal_product"]))
        with self.assertRaisesRegex(PackageError, "native_reference_not_indexed"): Package(src)
        edit(lambda n: n["characters"][0].pop("metal_product"))
        with self.assertRaisesRegex(PackageError, "incomplete_neutral_package"): Package(src)

    def test_the_d3d11_frame_is_optional_needs_the_neutral_package_and_its_digest_is_checked(self):
        src = self.root / "role"; fixture(src, neutral=True, d3d11=True)
        self.assertEqual(Package(src).native_entry["d3d11_frame"]["file"], "d3d11/frame.bin")
        Library(self.root / "library").install(src)
        frame = src / "runtime/d3d11/frame.bin"; data = frame.read_bytes()
        frame.write_bytes(data[:-2] + b" \n")
        with self.assertRaisesRegex(PackageError, "component_sha_mismatch"): Package(src, deep=False)
        frame.write_bytes(data)
        bare = self.root / "bare"; fixture(bare, d3d11=True)
        with self.assertRaisesRegex(PackageError, "d3d11_frame_without_neutral_package"): Package(bare)
        old = self.root / "old"; fixture(old, neutral=True)
        self.assertNotIn("d3d11_frame", Package(old).native_entry); Library(self.root / "old-library").install(old)

    def test_the_library_bundle_resolves_the_neutral_package_and_the_d3d11_frame(self):
        src = self.root / "role"; fixture(src, neutral=True, d3d11=True)
        library = Library(self.root / "library"); library.install(src)
        native = json.loads((library.root / library.snapshot()["native_bundle"]["file"]).read_text(encoding="utf-8"))
        entry = native["characters"][0]
        for field in ("neutral_scene", "neutral_build_record", "metal_product", "d3d11_frame"):
            with self.subTest(field=field):
                path = library.root / entry[field]["file"]
                self.assertTrue(path.is_file(), entry[field]["file"])
                self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), entry[field]["sha256"])

    def test_catalog_hash_detects_changed_definition_and_native_manifest(self):
        src = self.root / "source"; fixture(src)
        library = Library(self.root / "library"); library.install(src)
        entry = library.entries()[0]
        (Path(entry["root"]) / "character.json").write_text("{}", encoding="utf-8")
        with self.assertRaises(PackageError): library.entries()

    def test_weapon_metadata_cannot_hide_body_or_advertise_missing_appearance(self):
        source=self.root/'weapon';doc=fixture(source,weapon=True)
        package=Package(source)
        self.assertEqual(package.components['render']['weapon_visibility']['meshes'],['weapon'])
        for mode in ['body','appearance','capability']:
            changed=json.loads(json.dumps(doc))
            option=changed['components']['render']['weapon_visibility']
            if mode=='body':option['meshes']=['body']
            if mode=='appearance':option['shown_appearance']='missing'
            if mode=='capability':changed['capabilities'].remove('render.weapon_toggle')
            write_json(source/'character.json',changed)
            with self.assertRaises(PackageError):Package(source)

    def test_text_only_package_installs_and_adds_nothing_to_the_native_bundle(self):
        source = self.root / "aide"; text_fixture(source)
        package = Package(source)
        self.assertFalse(package.render_enabled)
        library = Library(self.root / "library"); library.install(source)
        entry = library.entries()[0]
        self.assertEqual((entry["id"], entry["head"], entry["game_data"]), ("aide", None, None))
        self.assertEqual(library.snapshot()["default_character"], "aide")
        native = json.loads((library.root / library.snapshot()["native_bundle"]["file"]).read_text(encoding="utf-8"))
        self.assertEqual((native["characters"], native["files"]), ([], []))
        one = self.root / "one"; fixture(one, "one"); library.install(one)
        native = json.loads((library.root / library.snapshot()["native_bundle"]["file"]).read_text(encoding="utf-8"))
        self.assertEqual([x["id"] for x in native["characters"]], ["one"])
        self.assertTrue(all(ref["file"].startswith("packages/one/") for ref in native["files"]))

    def test_text_only_import_never_runs_the_renderer(self):
        host = self.root / "host"
        host.write_text("#!" + sys.executable + "\nimport sys\nsys.exit('host_called')\n", encoding="utf-8"); host.chmod(0o700)
        source = self.root / "aide"; text_fixture(source)
        archive = self.root / "aide.endfield-character"; export_package(source, archive)
        for path in (source, archive):
            with self.subTest(path=path):
                library = Library(self.root / ("library-" + path.name))
                result = self.install_command(path, library, host)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual([x["id"] for x in library.entries()], ["aide"])

    def test_text_only_package_still_needs_persona_and_dialogue(self):
        for mode, reason in [("lore", "missing_base_component"), ("card", "missing_base_component"),
                             ("capability", "missing_base_capability"), ("game_data", "unindexed_component")]:
            with self.subTest(mode=mode):
                source = self.root / mode; doc = text_fixture(source)
                if mode in ("lore", "card"): del doc["components"]["persona"][mode]
                if mode == "capability": doc["capabilities"] = []
                if mode == "game_data": doc["components"]["game_data"] = dict(file="game-data/profile.json", sha256="0" * 64, byte_count=1)
                write_json(source / "character.json", doc)
                with self.assertRaisesRegex(PackageError, reason): Package(source)

    def test_render_package_needs_a_game_but_not_a_head_or_ui_assets(self):
        for mode, reason in [("head", None), ("game", "invalid_character_id"), ("capability", None)]:
            with self.subTest(mode=mode):
                source = self.root / mode; doc = fixture(source)
                if mode == "head": del doc["components"]["ui"]["head"]
                if mode == "game": del doc["game"]
                if mode == "capability": doc["capabilities"].remove("ui.assets")
                write_json(source / "character.json", doc)
                if reason is None: Package(source); continue
                with self.assertRaisesRegex(PackageError, reason): Package(source)

    def test_render_package_from_another_game_needs_no_game_data_or_head(self):
        source = self.root / "imported"; doc = fixture(source)
        doc["game"] = "other_game"
        del doc["components"]["game_data"], doc["components"]["ui"]
        doc["capabilities"] = [x for x in doc["capabilities"] if x not in ("game_data.basic", "ui.assets")]
        write_json(source / "character.json", doc)
        package = Package(source)
        self.assertTrue(package.render_enabled)
        view = package.view()
        self.assertEqual((view["head"], view["game_data"]), (None, None))

    def test_committed_sample_library_is_consistent(self):
        sample = Path(__file__).resolve().parents[3] / "characters/sample-library"
        library = Library(sample)
        self.assertEqual(library.snapshot()["default_character"], "aide")
        packages = library.packages()
        self.assertEqual([p.id for p in packages], ["aide"])
        package = Package(packages[0].root)
        self.assertFalse(package.render_enabled)
        self.assertEqual(package.document["display"]["name"], {"zh-Hans": "助手", "en": "Aide"})
        native = json.loads((sample / library.snapshot()["native_bundle"]["file"]).read_text(encoding="utf-8"))
        self.assertEqual(native["characters"], [])


if __name__ == "__main__": unittest.main()
