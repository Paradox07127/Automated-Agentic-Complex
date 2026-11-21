import datetime
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sessions.ledger import parse  # noqa: E402

def line(name, severity="INFO", ts="2026-10-18T05:27:54.953Z", **attributes):
    return json.dumps({"timestamp": ts, "event_name": name, "severity_text": severity,
                       "attributes": {"session.id": "S1", **attributes}}) + "\n"


class ParseTest(unittest.TestCase):
    def test_timestamp_becomes_epoch_seconds(self):
        entry = parse(line("gate.result", ts="2026-10-18T00:00:01.500Z", outcome="fail"))
        expected = datetime.datetime(2026, 10, 18, 0, 0, 1, 500000,
                                     tzinfo=datetime.timezone.utc).timestamp()
        self.assertAlmostEqual(entry["ts"], expected)
        self.assertEqual(entry["severity"], "INFO")
        self.assertIsNone(parse("not json\n"))
        self.assertIsNone(parse("[1, 2]\n"))


if __name__ == "__main__":
    unittest.main()
