"""The validator keeps its own constants; this test fails when they drift from the shared contract file."""
import ast
import json
from pathlib import Path
import sys
import unittest

AGENTD = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AGENTD))
import character_library

CONTRACT = AGENTD.parents[1] / "protocol" / "character-library" / "constants.json"


class CharacterLibraryContractTest(unittest.TestCase):
    def setUp(self):
        self.contract = json.loads(CONTRACT.read_text(encoding="utf-8"))

    def test_constants_equal_contract(self):
        c = self.contract
        self.assertEqual(character_library.ID.pattern, c["id_pattern"], "id_pattern")
        self.assertEqual(character_library.VERSION.pattern, c["version_pattern"], "version_pattern")
        self.assertEqual(character_library.SHA.pattern, c["sha256_pattern"], "sha256_pattern")
        self.assertEqual(sorted(character_library.BASE), c["base_capabilities"], "base_capabilities")
        self.assertEqual(sorted(character_library.TEXT_ONLY_BASE), c["text_only_base_capabilities"], "text_only_base_capabilities")
        self.assertEqual(sorted(x.removeprefix(".") for x in character_library.EXECUTABLES), c["executable_suffixes"],
                         "executable_suffixes")
        native = c["native_fields"]
        self.assertEqual(character_library.NATIVE_FIELDS, tuple(native["required"] + native["optional"]), "native_fields")
        self.assertEqual(character_library.NEUTRAL_FIELDS, tuple(c["neutral_fields"]["optional"]), "neutral_fields")
        self.assertEqual(character_library.D3D11_FIELDS, tuple(c["d3d11_fields"]["optional"]), "d3d11_fields")

    def test_schema_strings_used_by_library(self):
        schemas = self.contract["schemas"]
        tree = ast.parse(Path(character_library.__file__).read_text(encoding="utf-8"))
        strings = {node.value for node in ast.walk(tree) if isinstance(node, ast.Constant) and isinstance(node.value, str)}
        for key, value in [("catalog", schemas["catalog"]), ("definition", schemas["definition"]["schema"]),
                           ("native_bundle", schemas["native_bundle"]), ("stage", schemas["stage"])]:
            self.assertIn(value, strings, "schemas." + key)
        versions = [node.comparators[0].value for node in ast.walk(tree) if isinstance(node, ast.Compare) and
                    isinstance(node.left, ast.Subscript) and isinstance(node.left.slice, ast.Constant) and
                    node.left.slice.value == "schema_version"]
        self.assertEqual(versions, [schemas["definition"]["schema_version"]], "schemas.definition.schema_version")


if __name__ == "__main__":
    unittest.main()
