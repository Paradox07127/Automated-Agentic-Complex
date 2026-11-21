"""Write or check the files generated from agent/agentd/route_registry.py."""
from fnmatch import fnmatch
from pathlib import Path
import argparse
import json
import re
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "agent" / "agentd"))

from route_registry import REGISTRY  # noqa: E402

ROUTES_JSON = ROOT / "protocol" / "ui-bridge" / "routes.json"
C6_CONTRACT = ROOT / "protocol" / "C6-agentd-api" / "CONTRACT.md"
TS_ROUTES = ROOT / "web" / "src" / "bridge" / "agentd-routes.generated.ts"
FIXTURES = ROOT / "protocol" / "C6-agentd-api" / "fixtures"
C6_BEGIN = "<!-- gen:routes begin -->"
C6_END = "<!-- gen:routes end -->"
TOKENS = {(): "无", ("ui_token",): "ui", ("hook_token",): "hook", ("ui_token", "events_token"): "ui 或 events",
          ("integration_token",): "integration"}
C6_HEAD = """由 `protocol/tools/gen_routes.py` 从 `agent/agentd/route_registry.py` 生成，不要手改；改登记后在仓库根目录跑 `python3 -I protocol/tools/gen_routes.py --write`。

每个请求依次过这些关（`api/handler.py` 的 `Handler.parse_request`、`_answers_500`）：Host 不是本机或端口不符 400 `invalid_host` → 带 `Origin` 或 `Sec-Fetch-Site` 不是 `none` 403 `cross_site` → `OPTIONS` 405 `method_not_allowed` → POST/PUT/PATCH 带请求体且 `Content-Type` 不是 JSON 415 `unsupported_media_type` → 方法加路径不在本表 404 `not_found` → 令牌不在「令牌」列 401 `unauthorized` → 启动未完成 503 `starting`（`GET /health` 除外）→ 处理模块 → 回状态行前未捕获的异常 500 `internal_error`。

「路径」里 `:name` 是一段路径参数；「面板」是可以发这条请求的网页面板，「—」为没有；「规格」是写这条端点字段和错误码的文档，「—」为还没有；「回包夹具」是 `fixtures/` 下的示例回包。
"""


def render_routes_json():
    lines = []
    for r in REGISTRY:
        entry = {
            "method": r.method,
            "path": r.path if isinstance(r.path, str) else r.path.pattern,
            "class": r.ui_class,
            "surfaces": list(r.surfaces),
        }
        lines.append("  " + json.dumps(entry, ensure_ascii=False))
    return "[\n" + ",\n".join(lines) + "\n]\n"


def render_c6():
    """CONTRACT.md with the text between C6_BEGIN and C6_END regenerated."""
    rows = ["| 方法 | 路径 | 令牌 | 网页类 | 面板 | 处理模块 | 规格 | 回包夹具 |", "|---|---|---|---|---|---|---|---|"]
    for r in REGISTRY:
        paths = "、".join(f"`{p}`" for p in (r.templates or (r.path,)))
        cells = (r.method, paths, TOKENS[r.tokens], f"`{r.ui_class}`", "、".join(r.surfaces) or "—", f"`{r.owner}`",
                 f"`{r.spec}`" if r.spec else "—", f"`{r.response}`" if r.response else "—")
        rows.append("| " + " | ".join(cells) + " |")
    head, rest = C6_CONTRACT.read_text(encoding="utf-8").split(C6_BEGIN, 1)
    tail = rest.split(C6_END, 1)[1]
    return head + C6_BEGIN + "\n" + C6_HEAD + "\n" + "\n".join(rows) + "\n" + C6_END + tail


def _ts_str(text):
    return "'" + text.replace("\\", "\\\\").replace("'", "\\'") + "'"


def _ts_union(items):
    lines, line = [], ""
    for item in items:
        if line and len(line) + 3 + len(item) > 120:
            lines.append(line)
            line = ""
        line += f" | {item}" if line else f"  | {item}"
    return lines + [line]


def _ts_type(value, path, loose, indent):
    """The TS type agentd/tests/test_c6_fixtures.py `mismatches` accepts for `value` at `path`."""
    nullable = any(fnmatch(path, p) for p in loose["nullable"])
    if value is None:
        return "unknown" if nullable else "null"
    if isinstance(value, bool):
        text = "boolean"
    elif isinstance(value, (int, float)):
        text = "number"
    elif isinstance(value, str):
        text = "string"
    elif isinstance(value, list):
        item = _ts_type(value[0], path + "[]", loose, indent) if value else "unknown"
        text = item + "[]" if re.fullmatch(r"\w+", item) else f"Array<{item}>"
    elif path in loose["free_keys"]:
        key, sample = next(iter(value.items()), ("", None))
        text = f"Record<string, {_ts_type(sample, f'{path}.{key}', loose, indent) if sample is not None else 'unknown'}>"
    else:
        text = _ts_object(value, path, loose, indent)
    return text + " | null" if nullable else text


def _ts_object(value, path, loose, indent):
    fields = []
    for key, item in value.items():
        name = key if re.fullmatch(r"[A-Za-z_$][\w$]*", key) else _ts_str(key)
        fields.append(f"{name}: {_ts_type(item, f'{path}.{key}' if path else key, loose, indent + '  ')}")
    inline = "{ " + "; ".join(fields) + " }"
    if len(indent) + len(inline) <= 110 and "\n" not in inline:
        return inline
    return "{\n" + "".join(f"{indent}  {f};\n" for f in fields) + indent + "}"


def _ts_responses():
    """One interface per response fixture, and the route key to interface map."""
    out, names, entries = [], {}, []
    fields = json.loads((FIXTURES / "loose-fields.json").read_text(encoding="utf-8"))
    for r in REGISTRY:
        if r.response is None:
            continue
        if r.response not in names:
            names[r.response] = "".join(w.capitalize() for w in re.split(r"[^A-Za-z0-9]+", r.response[:-5])) + "Response"
            loose = {k: fields[k].get(r.response, []) for k in ("nullable", "free_keys")}
            body = _ts_type(json.loads((FIXTURES / r.response).read_text(encoding="utf-8")), "", loose, "")
            out += ["", f"/** protocol/C6-agentd-api/fixtures/{r.response} */",
                    f"export interface {names[r.response]} {body}" if body.startswith("{") else
                    f"export type {names[r.response]} = {body};"]
        for t in r.templates or (r.path,):
            entries.append(f"  {_ts_str(f'{r.method} {t}')}: {names[r.response]};")
    return out + ["", "/** The response interface of each fixture-backed route. */", "export interface AgentdResponses {"] + entries + ["}"]


def render_ts_routes():
    classes = dict.fromkeys(r.ui_class for r in REGISTRY)
    methods = dict.fromkeys(r.method for r in REGISTRY)
    keys = {}
    out = [
        "// Generated by protocol/tools/gen_routes.py from agent/agentd/route_registry.py; do not edit.",
        "import type { Surface } from './protocol';",
        "",
        "/** routes.json `class`. */",
        "export type AgentdRouteClass = " + " | ".join(_ts_str(c) for c in classes) + ";",
        "",
        "export interface AgentdRoute {",
        "  readonly method: " + " | ".join(_ts_str(m) for m in methods) + ";",
        "  /** A literal path, or a `^…$` pattern the whole path must match. */",
        "  readonly path: string;",
        "  /** The path with `:name` segments; one per alternation of a pattern. */",
        "  readonly templates: readonly string[];",
        "  readonly class: AgentdRouteClass;",
        "  readonly surfaces: readonly Surface[];",
        "  /** A response fixture under protocol/C6-agentd-api/fixtures. */",
        "  readonly response?: string;",
        "}",
        "",
        "export const AGENTD_ROUTES: readonly AgentdRoute[] = [",
    ]
    for r in REGISTRY:
        path = r.path if isinstance(r.path, str) else r.path.pattern
        templates = r.templates or (path,)
        out.append(f"  {{ method: {_ts_str(r.method)}, path: {_ts_str(path)}, templates: [{', '.join(map(_ts_str, templates))}],"
                   f" class: {_ts_str(r.ui_class)}, surfaces: [{', '.join(map(_ts_str, r.surfaces))}]"
                   + (f", response: {_ts_str(r.response)}" if r.response else "") + " },")
        for t in templates:
            if ":" in t:
                keys["`" + r.method + " " + re.sub(r":[A-Za-z_]\w*", "${string}", t) + "`"] = None
            else:
                keys[_ts_str(f"{r.method} {t}")] = None
    out += ["];", "", "/** `METHOD /path`, with each `:name` segment any string. */", "export type AgentdRouteKey ="]
    union = _ts_union(keys)
    return "\n".join(out + union[:-1] + [union[-1] + ";"] + _ts_responses() + [""])


OUTPUTS = ((ROUTES_JSON, render_routes_json), (C6_CONTRACT, render_c6), (TS_ROUTES, render_ts_routes))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true")
    mode.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    stale = []
    for path, render in OUTPUTS:
        text = render()
        if args.write:
            path.write_text(text, encoding="utf-8")
        elif path.read_text(encoding="utf-8") != text:
            stale.append(path.relative_to(ROOT))
    for path in stale:
        print(f"stale: {path}; run python3 -I protocol/tools/gen_routes.py --write", file=sys.stderr)
    return 1 if stale else 0


if __name__ == "__main__":
    sys.exit(main())
