"""C10 examples: blacklist.json, the privacy keys of config.json and tts-token have the listed keys and types."""
import json
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
# key -> JSON type
BLACKLIST = {"schema": int, "bundle_ids": list, "app_names": list, "domains": list,
             "title_patterns": list, "incognito": bool, "mode": str, "allow": dict}
PRIVACY = {"share_window_text": bool, "screen_context_level": str, "share_page_text": bool, "share_typed_text": bool,
           "share_actions": bool, "share_agent_sessions": bool, "share_screenshots": bool, "render_facing_mode": str}


def read(name):
    with open(os.path.join(HERE, "examples", name), encoding="utf-8") as f:
        return f.read()


class ExamplesTest(unittest.TestCase):
    def assertShape(self, value, shape):
        self.assertEqual(set(value), set(shape))
        for key, kind in shape.items():
            with self.subTest(key=key):
                self.assertIs(type(value[key]), kind)

    def test_blacklist(self):
        value = json.loads(read("blacklist.json"))
        self.assertShape(value, BLACKLIST)
        self.assertEqual(value["schema"], 1)
        for key in ("bundle_ids", "app_names", "domains", "title_patterns"):
            self.assertTrue(all(type(item) is str for item in value[key]), key)

    def test_privacy_config(self):
        value = json.loads(read("privacy-config.json"))
        self.assertShape(value, PRIVACY)
        self.assertIn(value["screen_context_level"], ("status", "focused", "window"))
        self.assertIn(value["render_facing_mode"], ("auto", "front", "side", "back"))

    def test_tts_token_is_one_line(self):
        text = read("tts-token")
        self.assertTrue(text.endswith("\n"))
        self.assertEqual(text.strip().splitlines(), [text.strip()])
        self.assertNotRegex(text.strip(), r"\s")


if __name__ == "__main__":
    unittest.main()
