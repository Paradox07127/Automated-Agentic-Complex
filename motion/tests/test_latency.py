import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import latency  # noqa: E402


class FakeClient:
    def skeleton(self, url, token):
        return {}

    def generate(self, url, token, prompt, seconds, constraints=None, timeout=None):
        return json.dumps(constraints or {}).encode()  # FakeRetarget.heading reads the plan back from it


class FakeRetarget:
    rig_sha256 = "0" * 64

    def __init__(self, package_root, cache_dir):
        pass

    def skeleton(self, doc):
        pass

    def to_kimodo(self, value):
        return -value if isinstance(value, (int, float)) else [-value[0], *value[1:]]

    def heading(self, npz):
        """A heading on the plan's root-key yaw, which passes the performer's heading check."""
        keys = sorted(json.loads(npz)["root"], key=lambda k: k["t"])
        t = [k["t"] for k in keys]
        return np.degrees(np.interp(np.arange(round(t[-1] * 30) + 1) / 30, t, [k["yaw"] for k in keys])).tolist()

    def clip(self, npz, motion_id, kind="perform", geometry=None):
        if kind == "perform":
            quality = {"removed_travel_m": 0.0, "toe_min_cm": 0.0}
            return {"length": 1.0, "curve_provenance": {"quality": quality}}, b"k" * 10, None
        return {"length": 1.0}, b"k" * 10, {"kind": kind}


class LatencyTest(unittest.TestCase):
    def test_one_sample_per_case(self):
        with tempfile.TemporaryDirectory() as cache:
            harness = latency.Harness("http://service", "t", Path(cache), cache, client=FakeClient(),
                                      retarget=FakeRetarget)
            try:
                result = latency.run(harness, n=1, warmup=0)
            finally:
                harness.close()
        cases = [g[0] for g in latency.GEOMETRY] + [p[0] for p in latency.PERFORM] + \
            ["burst:" + c for c in latency.BURST]
        self.assertEqual([s["case"] for s in result["samples"]], cases)
        self.assertEqual(result["warmups"], [])
        summary = latency.summarize(result["samples"])
        for case in cases:
            self.assertEqual(summary[case]["n"], 1)
            self.assertEqual(summary[case]["fallbacks"], {})
            self.assertIsNotNone(summary[case]["fetch_ms"])
        self.assertEqual(summary["turn_30"]["bytes"], {"meta": 15, "keys": 10, "tracks": 16})
        self.assertEqual(summary["wave_3s"]["bytes"], {"meta": 94, "keys": 10})

    def test_percentiles_and_budget(self):
        samples = [{"case": "c", "fallback": None, "wall_ms": float(v), "total_ms": v} for v in range(1, 11)]
        samples[-1].update(fallback="timeout", wall_ms=None)
        samples[-2]["wall_ms"] = 3000.0
        summary = latency.summarize(samples)["c"]
        self.assertEqual((summary["total_ms"]["p50"], summary["total_ms"]["max"]), (5.5, 10))
        self.assertAlmostEqual(summary["total_ms"]["p95"], 9.55)
        self.assertEqual(summary["over_budget"], 2)
        self.assertEqual(summary["fallbacks"], {"timeout": 1})
        self.assertIsNone(summary["generate_ms"])


if __name__ == "__main__":
    unittest.main()
