"""C9 examples: the `--describe` line and the two discovery files have the keys and types CONTRACT.md lists."""
import json
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
# key -> JSON type, as CONTRACT.md lists them
DESCRIBE = {"component": str, "c1_contract": str, "c6_contract": str, "c8_protocol": int, "c9_contract": str}
RUNTIME = {"ui-runtime.json": {"schema": int, "base_url": str, "ui_token": str},
           "events-runtime.json": {"schema": int, "base_url": str, "events_token": str}}


def read(name):
    with open(os.path.join(HERE, "examples", name), encoding="utf-8") as f:
        return f.read()


class ExamplesTest(unittest.TestCase):
    def assertShape(self, value, shape):
        self.assertEqual(set(value), set(shape))
        for key, kind in shape.items():
            with self.subTest(key=key):
                self.assertIs(type(value[key]), kind)

    def test_describe_is_one_sorted_compact_line(self):
        text = read("describe.json")
        value = json.loads(text)
        self.assertShape(value, DESCRIBE)
        self.assertEqual(text, json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")
        self.assertEqual(value["component"], "agentd")
        self.assertEqual(value["c9_contract"], "v1")
        for key in ("c1_contract", "c6_contract", "c9_contract"):
            self.assertRegex(value[key], r"^v\d+(\.\d+)?$")

    def test_discovery_files(self):
        for name, shape in RUNTIME.items():
            with self.subTest(name):
                value = json.loads(read(name))
                self.assertShape(value, shape)
                self.assertEqual(value["schema"], 1)
                self.assertTrue(re.fullmatch(r"http://127\.0\.0\.1:\d+", value["base_url"]))
                self.assertTrue(value[name.split("-")[0] + "_token"])


if __name__ == "__main__":
    unittest.main()
