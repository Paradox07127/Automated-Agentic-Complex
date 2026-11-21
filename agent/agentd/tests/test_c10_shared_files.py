"""C10: agentd writes blacklist.json with the example's keys and JSON types, and reads the example privacy config and
TTS token."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

AGENTD = Path(__file__).resolve().parents[1]
ROOT = AGENTD.parents[1]
EXAMPLES = ROOT / "protocol/C10-shared-files/examples"
sys.path.insert(0, str(AGENTD))

from daemon.main import parse_args, tts_token  # noqa: E402
from infra.tokens import write_secret  # noqa: E402
from observation.blacklist import Blacklist  # noqa: E402
from observation.privacy import saved_consent, saved_switch  # noqa: E402


def shape(value):
    return {key: type(item) for key, item in value.items()}


class BlacklistWriterTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "blacklist.json"
        self.example = json.loads((EXAMPLES / "blacklist.json").read_text(encoding="utf-8"))

    def test_new_file_matches_the_example(self):
        Blacklist(self.path)
        written = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(shape(written), shape(self.example))
        self.assertEqual(shape(written["allow"]), shape(self.example["allow"]))
        self.assertEqual(written["schema"], 1)
        self.assertEqual(written["mode"], "allow")

    def test_a_rewrite_adds_schema_to_a_file_without_it(self):
        self.path.write_text(json.dumps({k: v for k, v in self.example.items() if k != "schema"}), encoding="utf-8")
        Blacklist(self.path).add("domains", "x.com")
        written = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(shape(written), shape(self.example))
        self.assertEqual(written["schema"], 1)


class PrivacyReaderTest(unittest.TestCase):
    def test_reads_the_example(self):
        path = EXAMPLES / "privacy-config.json"
        capabilities = dict.fromkeys(("window_text", "page_text", "screenshots", "typed_text", "agent_sessions"), True)
        self.assertEqual(saved_consent(path, capabilities),
                         ({"window_text": True, "page_text": True, "screenshots": False, "typed_text": False,
                           "agent_sessions": True}, "window"))
        self.assertIs(saved_switch(path, "share_page_text"), True)
        self.assertIs(saved_switch(path, "observe_activity"), True)


class TtsTokenReaderTest(unittest.TestCase):
    def test_flag_reads_the_example_token(self):
        text = (EXAMPLES / "tts-token").read_text(encoding="utf-8")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "tts-token"
            write_secret(path, text)  # git keeps no 0600 mode, and agentd refuses a wider one
            self.assertEqual(tts_token(parse_args(["--tts-token-file", str(path)]).tts_token_file), text.strip())


if __name__ == "__main__":
    unittest.main()
