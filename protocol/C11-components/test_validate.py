import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import validate
from validate import check_component, check_index, check_lock

HERE = Path(__file__).resolve().parent
EXPECTED = {
    "bad-missing-key.json": "component: missing field entrypoints",
    "bad-sha.json": "component.tree_sha256 must be 64 lowercase hex",
    "bad-duplicate-id.json": "lock: duplicate id agentd",
    "bad-placement.json": "lock.components[0].placement must be support for split",
    "bad-placed-agentd.component.json": "component.placed is only allowed for host and renderer",
    "bad-placed-type.component.json": "component.placed must be an object",
    "bad-placed-path.component.json": "component.placed target must be a relative POSIX path without . or ..",
    "bad-index-dir.json": "index.components[0].dir must be a relative POSIX path without . or ..",
}


def read(name):
    return json.loads((HERE / "examples" / name).read_text(encoding="utf-8"))


class ExamplesTest(unittest.TestCase):
    def test_valid_components(self):
        for name in ("ok-agentd.component.json", "ok-characters.aster.component.json",
                     "ok-host.component.json", "ok-renderer.component.json"):
            with self.subTest(name):
                self.assertIsNone(check_component(read(name)))
        doc = read("ok-characters.aster.component.json")
        doc["id"] = "characters.custom_role"
        self.assertIsNone(check_component(doc), "character IDs may contain _")

    def test_valid_locks(self):
        for edition in ("portable", "split"):
            with self.subTest(edition):
                self.assertIsNone(check_lock(read(f"ok-{edition}.composition.lock.json")))

    def test_valid_index_lists_the_split_support_components(self):
        index = read("ok-index.json")
        self.assertIsNone(check_index(index))
        self.assertEqual(
            [{key: c[key] for key in ("id", "version", "tree_sha256")} for c in index["components"]],
            [{key: c[key] for key in ("id", "version", "tree_sha256")}
             for c in read("ok-split.composition.lock.json")["components"] if c["placement"] == "support"],
        )
        result = subprocess.run([sys.executable, "-I", str(HERE / "validate.py"), str(HERE / "examples" / "ok-index.json")],
                                capture_output=True, text=True, encoding="utf-8")
        self.assertEqual((result.returncode, result.stdout), (0, ""))

    def test_invalid_examples_report_their_error(self):
        names = sorted(path.name for path in (HERE / "examples").glob("bad-*.json"))
        self.assertEqual(names, sorted(EXPECTED))
        for name in names:
            doc = read(name)
            check = {"endfield-composition/v1": check_lock,
                     "endfield-components-index/v1": check_index}.get(doc["schema"], check_component)
            with self.subTest(name):
                self.assertEqual(check(doc), EXPECTED[name])

    def test_editions_pin_the_same_component_trees(self):
        portable = read("ok-portable.composition.lock.json")
        split = read("ok-split.composition.lock.json")
        self.assertEqual(portable["host"], split["host"])
        self.assertEqual(
            {c["id"]: (c["version"], c["tree_sha256"]) for c in portable["components"]},
            {c["id"]: (c["version"], c["tree_sha256"]) for c in split["components"]},
        )


class CompositionTest(unittest.TestCase):
    def setUp(self):
        self.lock = read("ok-portable.composition.lock.json")
        self.manifests = {}
        for entry in [self.lock["host"], *self.lock["components"]]:
            name = "ok-agentd.component.json" if entry["id"] == "agentd" else "ok-characters.aster.component.json"
            manifest = read(name)
            if entry["id"] not in ("agentd", "characters.aster"):
                manifest["requires"] = {}
            manifest.update({key: entry[key] for key in ("id", "version", "tree_sha256")})
            if entry["id"].startswith("harness."):
                manifest["provides"] = {"C8": "1"}
            self.manifests[entry["id"]] = manifest
        self.manifests["host"]["requires"] = {"agentd": "1.0.0", "C6": "1"}
        self.manifests["host"]["provides"] = {"Host": "1"}
        self.manifests["renderer"]["requires"] = {"host": "1.0.0", "Host": "1"}
        self.assertIsNone(check_lock(self.lock))
        for manifest in self.manifests.values():
            self.assertIsNone(check_component(manifest))

    def test_valid_compositions_with_shared_interface_providers(self):
        manifests = list(self.manifests.values())
        for edition in ("portable", "split"):
            for documents in (manifests, manifests[::-1]):
                with self.subTest(edition=edition, first=documents[0]["id"]):
                    self.assertIsNone(validate.check_composition(
                        read(f"ok-{edition}.composition.lock.json"), documents))

    def test_windows_composition_and_mixed_platforms(self):
        lock = dict(self.lock, platform="windows-x64")
        manifests = [dict(m, platform="windows-x64") for m in self.manifests.values()]
        self.assertIsNone(check_lock(lock))
        for manifest in manifests:
            self.assertIsNone(check_component(manifest))
        self.assertIsNone(validate.check_composition(lock, manifests))
        self.assertEqual(validate.check_composition(lock, list(self.manifests.values())),
                         "component host.platform must be windows-x64 from lock")
        self.assertEqual(validate.check_composition(self.lock, manifests),
                         "component host.platform must be macos-arm64 from lock")

    def test_missing_manifest(self):
        for component_id in ("host", "agentd"):
            manifests = [doc for name, doc in self.manifests.items() if name != component_id]
            with self.subTest(id=component_id):
                self.assertEqual(validate.check_composition(self.lock, manifests),
                                 f"component {component_id}: missing manifest")

    def test_duplicate_manifest(self):
        for component_id in ("host", "agentd"):
            manifests = [*self.manifests.values(), self.manifests[component_id]]
            with self.subTest(id=component_id):
                self.assertEqual(validate.check_composition(self.lock, manifests),
                                 f"component {component_id}: duplicate manifest")

    def test_manifest_without_lock_entry(self):
        manifests = [*self.manifests.values(), dict(self.manifests["host"], id="extra")]
        self.assertEqual(validate.check_composition(self.lock, manifests),
                         "component extra: missing lock entry")

    def test_manifest_version_and_tree_must_match_lock(self):
        for component_id in ("host", "agentd"):
            for key, value in (("version", "1.0"), ("tree_sha256", "0" * 64)):
                manifests = copy.deepcopy(self.manifests)
                manifests[component_id][key] = value
                with self.subTest(id=component_id, key=key):
                    self.assertEqual(
                        validate.check_composition(self.lock, list(manifests.values())),
                        f"component {component_id}.{key} must be {self.manifests[component_id][key]} from lock",
                    )

    def test_unmet_component_requires(self):
        cases = (("missing", "1", "missing component"),
                 ("host", "1.0", "expected version 1.0, got 1.0.0"),
                 ("runtime.python", "3.13.09", "expected version 3.13.09, got 3.13.9"))
        for component_id in ("host", "agentd"):
            for name, version, error in cases:
                manifests = copy.deepcopy(self.manifests)
                manifests[component_id]["requires"] = {name: version}
                with self.subTest(id=component_id, requires=name):
                    self.assertEqual(
                        validate.check_composition(self.lock, list(manifests.values())),
                        f"component {component_id}.requires.{name}: {error}",
                    )

    def test_unmet_interface_requires(self):
        for component_id in ("host", "agentd"):
            for name, version in (("Missing", "1"), ("C8", "1.0")):
                manifests = copy.deepcopy(self.manifests)
                manifests[component_id]["requires"] = {name: version}
                with self.subTest(id=component_id, requires=name):
                    self.assertEqual(
                        validate.check_composition(self.lock, list(manifests.values())),
                        f"component {component_id}.requires.{name}: missing provider for version {version}",
                    )

    def test_cli_checks_lock_manifests_and_composition(self):
        manifests = list(self.manifests.values())
        cases = (([self.lock, *manifests], 0, ""),
                 ([self.lock, *manifests[1:]], 1, "component host: missing manifest\n"),
                 ([read("bad-placement.json"), *manifests], 1, EXPECTED["bad-placement.json"] + "\n"),
                 ([self.lock, *manifests[:-1], read("bad-missing-key.json")],
                  1, EXPECTED["bad-missing-key.json"] + "\n"),
                 ([self.lock, dict(manifests[0], platform="macos-x86_64"), *manifests[1:]],
                  1, "component.platform must be macos-arm64 or windows-x64\n"),
                 (manifests, 1, "lock: missing field edition\n"))
        with tempfile.TemporaryDirectory() as directory:
            for documents, code, output in cases:
                paths = []
                for index, doc in enumerate(documents):
                    path = Path(directory) / f"{index}.json"
                    path.write_text(json.dumps(doc), encoding="utf-8")
                    paths.append(str(path))
                with self.subTest(output=output):
                    result = subprocess.run([sys.executable, "-I", str(HERE / "validate.py"), *paths],
                                            capture_output=True, text=True, encoding="utf-8")
                    self.assertEqual(result.returncode, code)
                    self.assertEqual(result.stdout, output)
                    self.assertEqual(result.stderr, "")


class ValidationTest(unittest.TestCase):
    def test_placed_only_on_fixed_components(self):
        for component_id in ("host", "renderer", "agentd"):
            for placed in ({}, {"bin/Endfield": "MacOS/AgenticComplex"}):
                doc = read("ok-agentd.component.json")
                doc.update(id=component_id, placed=placed)
                expected = None if component_id in ("host", "renderer") else (
                    "component.placed is only allowed for host and renderer")
                with self.subTest(id=component_id, placed=placed):
                    self.assertEqual(check_component(doc), expected)

    def test_placed_must_be_an_object(self):
        for component_id in ("host", "renderer"):
            for placed in (None, [], "MacOS/AgenticComplex", 1, True):
                doc = read("ok-agentd.component.json")
                doc.update(id=component_id, placed=placed)
                with self.subTest(id=component_id, placed=placed):
                    self.assertEqual(check_component(doc), "component.placed must be an object")

    def test_placed_paths_use_entrypoint_rules(self):
        paths = (None, 1, "", "/Endfield", "bin//Endfield", "bin/", ".", "./Endfield",
                 "bin/./Endfield", "..", "../Endfield", "bin/../Endfield", "bin\\Endfield",
                 "bin/\0Endfield")
        for component_id in ("host", "renderer"):
            for side in ("source", "target"):
                for path in paths:
                    doc = read("ok-agentd.component.json")
                    placed = {path: "MacOS/AgenticComplex"} if side == "source" else {"bin/Endfield": path}
                    doc.update(id=component_id, placed=placed)
                    with self.subTest(id=component_id, side=side, path=path):
                        self.assertEqual(check_component(doc),
                                         f"component.placed {side} must be a relative POSIX path without . or ..")

    def test_required_fields(self):
        for name, check in (("ok-agentd.component.json", check_component),
                            ("ok-portable.composition.lock.json", check_lock)):
            doc = read(name)
            for key in doc:
                value = copy.deepcopy(doc)
                del value[key]
                with self.subTest(name=name, key=key):
                    self.assertIsNotNone(check(value))

    def test_component_types_and_values(self):
        cases = {
            "schema": [None, "endfield-component/v2"],
            "id": [1, "", "Agentd", "../agentd", "a" * 65, "agentd\n"],
            "version": [1, "", "v1.0", ">=1.0", "1..0"],
            "tree_sha256": [None, "A" * 64, "a" * 63, "g" * 64],
            "files": [True, -1, 1.5, "1"],
            "bytes": [False, -1, 1.5, "1"],
            "entrypoints": [[], {"launcher": 1}, {"": "server.py"},
                            {"launcher": "/server.py"}, {"launcher": "../server.py"},
                            {"launcher": "bin/../server.py"}, {"launcher": "./server.py"},
                            {"launcher": "bin//server.py"}, {"launcher": "bin\\server.py"}],
            "provides": [[], {"C8": 1}, {"C8": ""}, {"agentd": "1"}],
            "requires": [[], {"C8": 1}, {"runtime.python": ">=3.13"}, {"../agentd": "1"}],
            "platform": [None, "macos-x86_64"],
        }
        for key, values in cases.items():
            for value in values:
                doc = read("ok-agentd.component.json")
                doc[key] = value
                with self.subTest(key=key, value=value):
                    self.assertIsNotNone(check_component(doc))
        for doc in (None, [], 1, "component"):
            with self.subTest(doc=doc):
                self.assertIsNotNone(check_component(doc))

    def test_lock_types_and_references(self):
        cases = {
            "schema": [None, "endfield-composition/v2"],
            "edition": [[], "development"],
            "platform": [None, "linux-arm64"],
            "created_at": [1, "", "2026-11-06", "2026-02-30T00:00:00Z"],
            "host": [None, [], {}],
            "components": [None, {}, [1], [{}]],
        }
        for key, values in cases.items():
            for value in values:
                doc = read("ok-portable.composition.lock.json")
                doc[key] = value
                with self.subTest(key=key, value=value):
                    self.assertIsNotNone(check_lock(doc))
        for target in ("host", "component"):
            for key, value in (("id", "Agentd"), ("version", 1), ("tree_sha256", "bad")):
                doc = read("ok-portable.composition.lock.json")
                ref = doc["host"] if target == "host" else doc["components"][0]
                ref[key] = value
                with self.subTest(target=target, key=key):
                    self.assertIsNotNone(check_lock(doc))
                del ref[key]
                with self.subTest(target=target, missing=key):
                    self.assertIsNotNone(check_lock(doc))
        for doc in (None, [], 1, "lock"):
            with self.subTest(doc=doc):
                self.assertIsNotNone(check_lock(doc))

    def test_index_fields_ids_and_dirs(self):
        cases = (
            ({"schema": "endfield-components-index/v2"}, "index.schema must be endfield-components-index/v1"),
            ({"components": {}}, "index.components must be an array"),
            ({"components": [1]}, "index.components[0] must be an object"),
            ({"components": [{"id": "agentd"}]}, "index.components[0]: missing field version"),
            ({"components": [{"id": "agentd", "version": "1.0.0", "tree_sha256": "a" * 64}]},
             "index.components[0]: missing field dir"),
            ({"components": [dict(id="agentd", version="1.0.0", tree_sha256="a" * 64, dir="agentd")] * 2},
             "index: duplicate id agentd"),
        )
        for edit, error in cases:
            doc = dict(read("ok-index.json"), **edit)
            with self.subTest(edit=edit):
                self.assertEqual(check_index(doc), error)
        for key in ("schema", "components"):
            doc = read("ok-index.json")
            del doc[key]
            with self.subTest(missing=key):
                self.assertEqual(check_index(doc), f"index: missing field {key}")
        for component_id in ("host", "renderer", "web-ui"):
            doc = read("ok-index.json")
            doc["components"][0]["id"] = component_id
            with self.subTest(id=component_id):
                self.assertEqual(check_index(doc), f"index.components[0].id {component_id} stays in the app")
        for path in (None, "", "/agentd", "agentd/", ".", "..", "a/../agentd", "agentd\\x", "agentd\0"):
            doc = read("ok-index.json")
            doc["components"][0]["dir"] = path
            with self.subTest(dir=path):
                self.assertEqual(check_index(doc), "index.components[0].dir must be a relative POSIX path without . or ..")
        for doc in (None, [], "index"):
            with self.subTest(doc=doc):
                self.assertEqual(check_index(doc), "index must be an object")

    def test_edition_placements_and_host_id_uniqueness(self):
        for edition in ("portable", "split"):
            original = read(f"ok-{edition}.composition.lock.json")
            for index in range(len(original["components"])):
                doc = copy.deepcopy(original)
                component = doc["components"][index]
                component["placement"] = "support" if component["placement"] == "bundle" else "bundle"
                with self.subTest(edition=edition, id=component["id"]):
                    self.assertIsNotNone(check_lock(doc))
                del component["placement"]
                with self.subTest(edition=edition, missing_placement=component["id"]):
                    self.assertIsNotNone(check_lock(doc))
            original["components"].append(dict(original["host"], placement="bundle"))
            self.assertEqual(check_lock(original), "lock: duplicate id host")


if __name__ == "__main__":
    unittest.main()
