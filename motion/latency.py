#!/usr/bin/env python3
"""End-to-end latency of generated motion through agentd's own Performer, MotionClient, MotionStore and
live_retarget: geometry requests (POST /motions/generate) and performs ([motion:...] markers), each run serially
n times after warm-ups, then a turn and a walk sent together. The host fetch is a loopback GET of the stored files.

usage: latency.py --url URL [--token-file PATH] --package <root> --out DIR [--n 10] [--steps N]
Without --token-file the token comes from MOTION_SERVICE_TOKEN. Writes DIR/latency.json and DIR/summary.md.
"""
import argparse
import http.server
import json
import math
import os
from pathlib import Path
import secrets
import sys
import threading
import time
import urllib.request
import uuid

AGENTD = Path(__file__).resolve().parents[1] / "agent/agentd"
sys.path.insert(0, str(AGENTD))
from motion import performer  # noqa: E402
from motion.client import MotionClient  # noqa: E402
from motion.store import MotionStore  # noqa: E402

WARMUP = 2
N = 10
BUDGET = 600.0  # s: slow cases are measured, not timed out
CLIENT_TIMEOUT = 300.0  # s
WAIT = 900.0  # s one sample may take before the harness gives up
# Seconds as the host computes them: turn 1.5 + (|yaw| - 45) / 135 in 1.5-2.5, walk metres / 0.5 + 1 in 2-10.
GEOMETRY = [
    ("turn_30", "turn", 1.5, {"yaw": 30.0}),
    ("turn_90", "turn", 1.5 + 45 / 135, {"yaw": 90.0}),
    ("walk_1.2m", "walk", 1.2 / 0.5 + 1, {"to": [1.2, 0.0], "end_yaw": 0.0}),
    ("walk_3m", "walk", 3.0 / 0.5 + 1, {"to": [3.0, 0.0], "end_yaw": 0.0}),
    ("window_loop_4s", "window_loop", 4.0, {"hips": [0.0, 1.10, 0.0]}),
    ("sit_enter_3s", "sit_enter", 3.0, {"seat": [0.0, 0.45, -0.25]}),
    ("lean_3s", "lean", 3.0, {"hand": "right", "grip": [0.35, 1.0, 0.1]}),
]
PERFORM = [
    ("wave_3s", "a person waves their right hand", 3.0),
    ("bow_2s", "a person bows", 2.0),
]
BURST = ("turn_30", "walk_1.2m")
FIELDS = ("generate_ms", "retarget_ms", "total_ms", "wall_ms", "fetch_ms")


class _Settings:
    """The MotionSettings surface Performer reads, with the token kept in memory only."""
    generated = True

    def __init__(self, url, token):
        self.service_url, self._token = url, token

    def token(self):
        return self._token


class _StepsClient(MotionClient):
    def __init__(self, steps, **kwargs):
        super().__init__(**kwargs)
        self.steps = steps

    def generate(self, *args, **kwargs):
        return super().generate(*args, steps=self.steps, **kwargs)


def percentile(values, q):
    """Linear interpolation between closest ranks, as numpy's default."""
    ordered = sorted(values)
    if not ordered:
        return None
    rank = (len(ordered) - 1) * q / 100
    low = math.floor(rank)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (rank - low)


def stats(values):
    values = [v for v in values if v is not None]
    if not values:
        return None
    return {"p50": percentile(values, 50), "p95": percentile(values, 95), "max": max(values)}


class Harness:
    def __init__(self, url, token, package_root, cache_dir, client=None, retarget=performer.live_retarget):
        self.store = MotionStore()
        self._lock = threading.Lock()
        self._waiting = {}  # trace_id -> sample being filled
        self.performer = performer.Performer(_Settings(url, token), self._publish, lambda: package_root, cache_dir,
                                             offer=self._offer, trace=self._trace, client=client, store=self.store, retarget=retarget,
                                             perform_budget=BUDGET, request_budget=BUDGET)
        self._server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        threading.Thread(target=self._server.serve_forever, daemon=True).start()
        self.files_url = f"http://127.0.0.1:{self._server.server_address[1]}/motions/"

    def close(self):
        self._server.shutdown()
        self._server.server_close()

    def _handler(self):
        store = self.store

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                parts = self.path.strip("/").split("/")
                found = store.get(parts[1]) if len(parts) == 3 else None
                data = found and dict(zip(("meta", "keys", "tracks"), found[:3])).get(parts[2])
                if data is None:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        return Handler

    def _sample(self, trace_id, case):
        sample = {"case": case, "trace_id": trace_id, "done": threading.Event(), "began": time.perf_counter()}
        with self._lock:
            self._waiting[trace_id] = sample
        return sample

    def _offer(self, spec):
        """Performer's offer: every perform is admitted and published as it comes."""
        self._publish("behavior", spec)
        return True, None

    def _publish(self, event, data):
        now = time.perf_counter()
        trace_id = performer.request_trace(data["request_id"]) if event == "motion" else data["trace_id"]
        with self._lock:
            sample = self._waiting.get(trace_id)
        if sample is not None:
            sample["wall_ms"] = (now - sample["began"]) * 1000
            sample["motion_id"] = data["motion"]["id"] if data.get("motion") else None
            sample["event_reason"] = data.get("reason")

    def _trace(self, kind, trace_id, attrs=None, **_):
        with self._lock:
            sample = self._waiting.pop(trace_id, None)
        if sample is None:
            return
        attrs = attrs or {}
        sample.update({k: attrs.get(k) for k in ("generate_ms", "retarget_ms", "total_ms")})
        sample["fallback"] = attrs.get("reason") if kind == "motion.fallback" else None
        sample["done"].set()

    def _finish(self, sample):
        if not sample["done"].wait(WAIT):
            raise TimeoutError(f"{sample['case']}: no trace within {WAIT} s")
        found = self.store.get(sample.get("motion_id")) if sample.get("motion_id") else None
        sample["bytes"] = None
        sample["fetch_ms"] = None
        if found is not None:
            names = [n for n, d in zip(("meta", "keys", "tracks"), found[:3]) if d is not None]
            sample["bytes"] = {n: len(d) for n, d in zip(("meta", "keys", "tracks"), found[:3]) if d is not None}
            start = time.perf_counter()
            for name in names:
                with urllib.request.urlopen(self.files_url + f"{sample['motion_id']}/{name}", timeout=10) as r:
                    r.read()
            sample["fetch_ms"] = (time.perf_counter() - start) * 1000
        sample.setdefault("wall_ms", None)
        return {k: v for k, v in sample.items() if k not in ("done", "began")}

    def _geometry(self, case):
        name, kind, seconds, geometry = next(g for g in GEOMETRY if g[0] == case)
        request_id = "mr-" + secrets.token_hex(8)
        sample = self._sample(performer.request_trace(request_id), name)
        self.performer.request({"request_id": request_id, "behavior_id": f"lat-{name}", "kind": kind,
                                "seconds": seconds, "geometry": geometry})
        return sample

    def _perform(self, case):
        name, prompt, seconds = next(p for p in PERFORM if p[0] == case)
        sample = self._sample(str(uuid.uuid4()), name)
        self.performer.start(prompt, seconds, 1, sample["trace_id"])
        return sample

    def one(self, case):
        """One serial sample of a case."""
        start = self._perform if any(p[0] == case for p in PERFORM) else self._geometry
        return self._finish(start(case))

    def burst(self):
        """A turn and a walk sent together to the single geometry worker."""
        sent = [self._geometry(case) for case in BURST]
        return [dict(self._finish(s), case="burst:" + s["case"]) for s in sent]


def run(harness, n=N, warmup=WARMUP):
    """{samples, warmups}: every case serially, then the burst, each n times after warmup runs."""
    samples, warmups = [], []
    cases = [g[0] for g in GEOMETRY] + [p[0] for p in PERFORM]
    for case in cases:
        warmups += [harness.one(case) for _ in range(warmup)]
        samples += [harness.one(case) for _ in range(n)]
    for i in range(warmup + n):
        (warmups if i < warmup else samples).extend(harness.burst())
    return {"samples": samples, "warmups": warmups}


def summarize(samples):
    """Per case: percentiles of FIELDS, the fallbacks, and how many samples would have missed agentd's budget for
    that kind (a perform's, else a host request's)."""
    out = {}
    for case in dict.fromkeys(s["case"] for s in samples):
        mine = [s for s in samples if s["case"] == case]
        perform = any(p[0] == case.split(":")[-1] for p in PERFORM)
        budget_ms = (performer.PERFORM_BUDGET if perform else performer.REQUEST_BUDGET) * 1000
        fallbacks = [s["fallback"] for s in mine if s["fallback"]]
        out[case] = {"n": len(mine), **{f: stats([s.get(f) for s in mine]) for f in FIELDS},
                     "over_budget": sum(1 for s in mine if s["fallback"] or (s.get("wall_ms") or 0) > budget_ms),
                     "fallbacks": {r: fallbacks.count(r) for r in dict.fromkeys(fallbacks)},
                     "bytes": next((s["bytes"] for s in mine if s.get("bytes")), None)}
    return out


def markdown(summary, header):
    def cell(st):
        return "-" if st is None else f"{st['p50']:.0f} / {st['p95']:.0f} / {st['max']:.0f}"
    lines = [header, "", "p50 / p95 / max in ms; over budget counts wall time over agentd's budget (perform 4 s, host request 2.5 s) or a fallback.", "",
             "| case | n | generate | retarget | total | wall (publish) | fetch | over budget | fallbacks | bytes meta/keys/tracks |",
             "|---|---|---|---|---|---|---|---|---|---|"]
    for case, s in summary.items():
        b = s["bytes"] or {}
        sizes = "/".join(str(b.get(k, "-")) for k in ("meta", "keys", "tracks"))
        fallbacks = ", ".join(f"{r} x{c}" for r, c in s["fallbacks"].items()) or "-"
        lines.append(f"| {case} | {s['n']} | " + " | ".join(cell(s[f]) for f in FIELDS)
                     + f" | {s['over_budget']} | {fallbacks} | {sizes} |")
    return "\n".join(lines) + "\n"


def health(url, token):
    request = urllib.request.Request(url.rstrip("/") + "/v1/health", headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(request, timeout=10) as r:
            return json.loads(r.read())
    except Exception as error:
        return {"error": type(error).__name__}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--url", required=True)
    p.add_argument("--token-file")
    p.add_argument("--package", required=True, type=Path)
    p.add_argument("--out", required=True, type=Path)
    p.add_argument("--n", type=int, default=N)
    p.add_argument("--steps", type=int)
    a = p.parse_args()
    token = (Path(a.token_file).read_text() if a.token_file else os.environ["MOTION_SERVICE_TOKEN"]).strip()
    a.out.mkdir(parents=True, exist_ok=True)
    cache = a.out / "motion-cache"
    cache.mkdir(exist_ok=True)
    kwargs = {"timeout": CLIENT_TIMEOUT, "skeleton_timeout": CLIENT_TIMEOUT}
    client = _StepsClient(a.steps, **kwargs) if a.steps else MotionClient(**kwargs)
    before = health(a.url, token)
    harness = Harness(a.url, token, a.package.resolve(), cache, client=client)
    try:
        result = run(harness, a.n)
    finally:
        harness.close()
    summary = summarize(result["samples"])
    doc = {"url": a.url, "package": str(a.package.resolve()), "n": a.n, "warmup": WARMUP, "steps": a.steps,
           "budget_s": {"perform": performer.PERFORM_BUDGET, "request": performer.REQUEST_BUDGET}, "health_before": before, "health_after": health(a.url, token),
           "summary": summary, **result}
    (a.out / "latency.json").write_text(json.dumps(doc, indent=1))
    header = (f"# Motion latency: {a.url}\n\npackage `{a.package.resolve().name}`, n={a.n} after {WARMUP} warm-ups, "
              f"steps={a.steps or 'service default'}, busy before: {before.get('busy')}")
    (a.out / "summary.md").write_text(markdown(summary, header))
    print(markdown(summary, header))


if __name__ == "__main__":
    main()
