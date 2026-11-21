from pathlib import Path
import re
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "protocol" / "tools"))

import gen_routes  # noqa: E402
from gen_routes import REGISTRY  # noqa: E402

REGENERATE = "python3 -I protocol/tools/gen_all.py --write"
# Routes with no prose spec anywhere; lower it when one gets a spec, never raise it.
SPEC_NONE_MAX = 28
PARAM = re.compile(r"/(?:<[^>/]+>|:[A-Za-z_]+|\{[A-Za-z_]+\})")


def _spec_text(spec):
    text = (ROOT / spec).read_text(encoding="utf-8")
    if gen_routes.C6_BEGIN in text:
        head, rest = text.split(gen_routes.C6_BEGIN, 1)
        text = head + rest.split(gen_routes.C6_END, 1)[1]
    return PARAM.sub("/<>", text)


def _mentions(text, path):
    return re.search(r"(?<![\w/-])" + re.escape(PARAM.sub("/<>", path)) + r"(?![\w/-])", text) is not None


class ContractOutputsTest(unittest.TestCase):
    def test_routes_json_is_generated(self):
        committed = (ROOT / "protocol" / "ui-bridge" / "routes.json").read_text(encoding="utf-8")
        self.assertTrue(committed == gen_routes.render_routes_json(),
                        f"protocol/ui-bridge/routes.json is stale; run `{REGENERATE}` from the repo root")

    def test_ts_routes_is_generated(self):
        path = ROOT / "web" / "src" / "bridge" / "agentd-routes.generated.ts"
        committed = path.read_text(encoding="utf-8") if path.is_file() else None
        self.assertTrue(committed == gen_routes.render_ts_routes(),
                        f"web/src/bridge/agentd-routes.generated.ts is stale; run `{REGENERATE}` from the repo root")

    def test_c6_block_is_generated(self):
        committed = (ROOT / "protocol" / "C6-agentd-api" / "CONTRACT.md").read_text(encoding="utf-8")
        self.assertTrue(committed == gen_routes.render_c6(),
                        f"protocol/C6-agentd-api/CONTRACT.md §3 is stale; run `{REGENERATE}` from the repo root")

    def test_spec_pointer_mentions_route(self):
        texts, missing = {}, 0
        for route in REGISTRY:
            if route.spec is None:
                missing += 1
                continue
            text = texts.setdefault(route.spec, _spec_text(route.spec))
            paths = route.templates or (route.path,)
            with self.subTest(method=route.method, path=paths[0], spec=route.spec):
                self.assertTrue(any(_mentions(text, path) for path in paths))
        self.assertLessEqual(missing, SPEC_NONE_MAX, "routes without a spec grew; give the new route a spec")


if __name__ == "__main__":
    unittest.main()
